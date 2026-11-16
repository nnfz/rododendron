use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_yaml::{Mapping, Value};
use sha2::{Digest, Sha256};

pub const USER_GROUP: &str = "PROXY";
const RESERVED_NAMES: &[&str] = &[
    "DIRECT",
    "REJECT",
    "REJECT-DROP",
    "PASS",
    "COMPATIBLE",
    "GLOBAL",
    "PROXY",
];
const MAX_BODY_BYTES: usize = 2_000_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SelectionDecision {
    /// The stored server, or the single remaining candidate, can be restored.
    Restore { server_id: String, name: String },
    /// The previous server is gone and more than one candidate matches, or none do.
    LeaveUnchanged,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NodeHint {
    pub server: String,
    pub port: u16,
    pub proxy_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionNode {
    pub id: String,
    pub name: String,
    pub server: String,
    pub port: u16,
    pub proxy_type: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NormalizedSubscription {
    pub nodes: Vec<SubscriptionNode>,
    pub proxies: Vec<Value>,
    pub groups: Vec<Value>,
    pub base_rules: Vec<String>,
    pub decision: SelectionDecision,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionMeta {
    pub id: String,
    pub filename: String,
    pub title: String,
    pub url_protected: String,
    pub interval_hours: Option<u64>,
    /// User override of the update interval. Wins over the provider header.
    #[serde(default)]
    pub custom_interval_hours: Option<u64>,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub updated_at: String,
    pub userinfo: Option<String>,
    pub selected_server_id: Option<String>,
    pub selected_hint: Option<NodeHint>,
    pub base_rules: Vec<String>,
    pub user_rule_lines: Vec<String>,
    pub nodes: Vec<SubscriptionNode>,
    pub body_sha256: String,
    pub yaml_sha256: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CrashAfter {
    Tmp,
    JournalPrepared,
    ReplaceBody,
    ReplaceYaml,
    ReplaceJson,
    JournalCommitted,
    BaksDeleted,
}

#[derive(Debug, Clone)]
pub struct ProfileFiles {
    pub body: String,
    pub yaml: String,
    pub json: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct Journal {
    state: String,
    id: String,
    filename: String,
    body_existed: bool,
    yaml_existed: bool,
    json_existed: bool,
}

pub struct ParsedBody {
    pub document: Value,
    pub proxies: Vec<Value>,
    pub groups: Vec<Value>,
    pub rules: Vec<String>,
}

pub struct FetchedBody {
    pub text: String,
    pub userinfo: Option<String>,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub interval_hours: Option<u64>,
    pub title: Option<String>,
}

/// Mihomo 1.19 `sub-rules` key for provider rules that must apply only to
/// processes the user sent through the subscription. The engine wraps a
/// SUB-RULE payload in one extra pair of parentheses, so the rule text is
/// `SUB-RULE,(PROCESS-NAME,name),rododendron-subscription`.
pub const SUB_RULE_NAME: &str = "rododendron-subscription";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComposedRules {
    pub rules: Vec<String>,
    pub sub_rules: Option<(String, Vec<String>)>,
}

enum ClassifiedLine {
    Ignored,
    Global(String),
    ProcessDirect(String),
    ProcessProxy { line: String, safe_name: Option<String> },
}

/// No active user rule keeps the provider list, including its terminal MATCH.
/// Any other user rule ends the main list with MATCH,DIRECT. Provider rules
/// that are not themselves a terminal MATCH stay available through `sub-rules`
/// for PROCESS-NAME rules aimed at the subscription. Domain rules stay on the
/// main list, ahead of process rules, so they match for every application.
pub fn compose_subscription_rules(user_lines: &[String], base_rules: &[String]) -> ComposedRules {
    let mut globals = Vec::new();
    let mut direct = Vec::new();
    let mut proxy = Vec::new();
    for line in user_lines {
        match classify_user_line(line) {
            ClassifiedLine::Ignored => {}
            ClassifiedLine::Global(text) => globals.push(text),
            ClassifiedLine::ProcessDirect(text) => direct.push(text),
            ClassifiedLine::ProcessProxy { line, safe_name } => proxy.push((line, safe_name)),
        }
    }
    if globals.is_empty() && direct.is_empty() && proxy.is_empty() {
        return ComposedRules {
            rules: base_rules.to_vec(),
            sub_rules: None,
        };
    }

    let (body, terminal) = split_provider_terminal(base_rules);
    let use_sub = !body.is_empty() && proxy.iter().any(|(_, name)| name.is_some());
    let mut rules = Vec::with_capacity(globals.len() + direct.len() + proxy.len() + 1);
    rules.extend(globals);
    rules.extend(direct);
    for (line, safe_name) in &proxy {
        if use_sub {
            if let Some(name) = safe_name {
                rules.push(format!("SUB-RULE,(PROCESS-NAME,{name}),{SUB_RULE_NAME}"));
                continue;
            }
        }
        rules.push(line.clone());
    }
    rules.push("MATCH,DIRECT".to_string());

    let sub_rules = if use_sub {
        let mut lines = body;
        lines.push(terminal.unwrap_or_else(|| "MATCH,PROXY".to_string()));
        Some((SUB_RULE_NAME.to_string(), lines))
    } else {
        None
    };
    ComposedRules { rules, sub_rules }
}

pub fn write_composed_rules(root: &mut Value, composed: &ComposedRules) {
    let Some(map) = root.as_mapping_mut() else {
        return;
    };
    map.insert(
        key("rules"),
        Value::Sequence(composed.rules.iter().cloned().map(Value::String).collect()),
    );
    if let Some((name, lines)) = &composed.sub_rules {
        let sequence = Value::Sequence(lines.iter().cloned().map(Value::String).collect());
        if !matches!(map.get(&key("sub-rules")), Some(Value::Mapping(_))) {
            map.insert(key("sub-rules"), Value::Mapping(Mapping::new()));
        }
        if let Some(Value::Mapping(sub)) = map.get_mut(&key("sub-rules")) {
            sub.insert(key(name), sequence);
        }
        return;
    }

    let empty = if let Some(Value::Mapping(sub)) = map.get_mut(&key("sub-rules")) {
        sub.remove(&key(SUB_RULE_NAME));
        sub.is_empty()
    } else {
        false
    };
    if empty {
        map.remove(&key("sub-rules"));
    }
}

fn classify_user_line(line: &str) -> ClassifiedLine {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return ClassifiedLine::Ignored;
    }
    let parts: Vec<&str> = trimmed.split(',').map(str::trim).collect();
    if parts.is_empty() || parts[0].is_empty() {
        return ClassifiedLine::Global(trimmed.to_string());
    }
    let kind = parts[0].to_ascii_uppercase();
    if kind == "MATCH" {
        return ClassifiedLine::Ignored;
    }
    if kind != "PROCESS-NAME" {
        return ClassifiedLine::Global(trimmed.to_string());
    }
    let mut policy_at = parts.len() - 1;
    while policy_at > 0 && is_rule_flag(parts[policy_at]) {
        policy_at -= 1;
    }
    if policy_at < 2 {
        return ClassifiedLine::Global(trimmed.to_string());
    }
    if parts[policy_at].eq_ignore_ascii_case("DIRECT") {
        return ClassifiedLine::ProcessDirect(trimmed.to_string());
    }
    let safe_name = if policy_at == 2 && sub_rule_name_is_safe(parts[1]) {
        Some(parts[1].to_string())
    } else {
        None
    };
    ClassifiedLine::ProcessProxy {
        line: trimmed.to_string(),
        safe_name,
    }
}

fn sub_rule_name_is_safe(name: &str) -> bool {
    !name.is_empty() && !name.contains(',') && !name.contains('(') && !name.contains(')')
}

fn split_provider_terminal(base_rules: &[String]) -> (Vec<String>, Option<String>) {
    let Some(last) = base_rules.last() else {
        return (Vec::new(), None);
    };
    let kind = last.split(',').next().unwrap_or("").trim();
    if kind.eq_ignore_ascii_case("MATCH") {
        let mut body = base_rules.to_vec();
        let terminal = body.pop().unwrap();
        return (body, Some(terminal));
    }
    (base_rules.to_vec(), None)
}

pub fn decide_selection(
    selected_id: Option<&str>,
    hint: Option<&NodeHint>,
    nodes: &[SubscriptionNode],
) -> SelectionDecision {
    let selected_id = selected_id.map(str::trim).filter(|id| !id.is_empty());
    if let Some(id) = selected_id {
        let matches: Vec<&SubscriptionNode> = nodes.iter().filter(|node| node.id == id).collect();
        if matches.len() == 1 {
            return SelectionDecision::Restore {
                server_id: matches[0].id.clone(),
                name: matches[0].name.clone(),
            };
        }
        if matches.len() > 1 {
            return SelectionDecision::LeaveUnchanged;
        }
    }

    let Some(hint) = hint else {
        return SelectionDecision::LeaveUnchanged;
    };
    let candidates: Vec<&SubscriptionNode> = nodes
        .iter()
        .filter(|node| {
            node.server.eq_ignore_ascii_case(&hint.server)
                && node.port == hint.port
                && node.proxy_type.eq_ignore_ascii_case(&hint.proxy_type)
        })
        .collect();
    if candidates.len() == 1 {
        return SelectionDecision::Restore {
            server_id: candidates[0].id.clone(),
            name: candidates[0].name.clone(),
        };
    }
    SelectionDecision::LeaveUnchanged
}

pub fn server_id_of(proxy: &Mapping) -> String {
    let mut lines = Vec::new();
    for key in [
        "type",
        "server",
        "port",
        "uuid",
        "password",
        "private-key",
        "cipher",
        "username",
        "network",
        "sni",
        "servername",
        "flow",
        "encryption",
    ] {
        if let Some(value) = scalar(proxy, key) {
            let value = if key == "server" || key == "type" {
                value.trim().to_ascii_lowercase()
            } else if key == "port" {
                value.trim().to_string()
            } else {
                value
            };
            if !value.is_empty() {
                lines.push(format!("{key}={value}"));
            }
        }
    }
    if let Some(public_key) = proxy
        .get(&key("reality-opts"))
        .and_then(|value| value.as_mapping())
        .and_then(|map| scalar(map, "public-key"))
    {
        lines.push(format!("public-key={public_key}"));
    }
    if let Some(path) = proxy
        .get(&key("ws-opts"))
        .and_then(|value| value.as_mapping())
        .and_then(|map| scalar(map, "path"))
    {
        lines.push(format!("ws-path={path}"));
    }
    if let Some(service) = proxy
        .get(&key("grpc-opts"))
        .and_then(|value| value.as_mapping())
        .and_then(|map| scalar(map, "grpc-service-name"))
    {
        lines.push(format!("grpc-service={service}"));
    }
    sha256_hex(&lines.join("\n"))
}

pub fn normalize_subscription(
    proxies: Vec<Value>,
    groups: Vec<Value>,
    rules: Vec<String>,
    selected_id: Option<&str>,
    hint: Option<&NodeHint>,
) -> Result<NormalizedSubscription, String> {
    if proxies.is_empty() {
        return Err("Subscription has no proxies".to_string());
    }

    let mut used = HashSet::new();
    for reserved in RESERVED_NAMES {
        used.insert((*reserved).to_string());
    }

    let mut proxy_origins: Vec<(String, String)> = Vec::new();
    let mut new_proxies = Vec::with_capacity(proxies.len());
    let mut nodes = Vec::with_capacity(proxies.len());

    for proxy in proxies {
        let Value::Mapping(mut map) = proxy else {
            return Err("Subscription proxy must be a mapping".to_string());
        };
        let old_name = scalar(&map, "name").unwrap_or_else(|| "node".to_string());
        let new_name = allocate_name(&old_name, &mut used);
        map.insert(key("name"), Value::String(new_name.clone()));
        let id = server_id_of(&map);
        let server = scalar(&map, "server").unwrap_or_default();
        let port = map
            .get(&key("port"))
            .and_then(value_port)
            .unwrap_or(0);
        let proxy_type = scalar(&map, "type").unwrap_or_default();
        nodes.push(SubscriptionNode {
            id,
            name: new_name.clone(),
            server,
            port,
            proxy_type,
        });
        proxy_origins.push((old_name, new_name));
        new_proxies.push(Value::Mapping(map));
    }

    let decision = decide_selection(selected_id, hint, &nodes);

    let mut group_origins: Vec<(String, String)> = Vec::new();
    let mut new_groups = Vec::with_capacity(groups.len() + 1);
    for group in groups {
        let Value::Mapping(mut map) = group else {
            continue;
        };
        let old_name = scalar(&map, "name").unwrap_or_else(|| "group".to_string());
        let new_name = if old_name == USER_GROUP {
            allocate_name("Subscription", &mut used)
        } else {
            allocate_name(&old_name, &mut used)
        };
        map.insert(key("name"), Value::String(new_name.clone()));
        group_origins.push((old_name, new_name));
        new_groups.push(Value::Mapping(map));
    }

    let ref_map = reference_map(&proxy_origins, &group_origins);
    for group in &mut new_groups {
        let Some(map) = group.as_mapping_mut() else {
            continue;
        };
        if let Some(Value::Sequence(items)) = map.get_mut(&key("proxies")) {
            rewrite_name_sequence(items, &ref_map);
        }
    }
    let base_rules = rules
        .iter()
        .map(|rule| rewrite_rule(rule, &ref_map))
        .collect::<Vec<_>>();

    let mut leaf_names: Vec<String> = nodes.iter().map(|node| node.name.clone()).collect();
    if let SelectionDecision::Restore { name, .. } = &decision {
        if let Some(position) = leaf_names.iter().position(|item| item == name) {
            let chosen = leaf_names.remove(position);
            leaf_names.insert(0, chosen);
        }
    }
    leaf_names.push("DIRECT".to_string());

    let mut user_group = Mapping::new();
    user_group.insert(key("name"), Value::String(USER_GROUP.to_string()));
    user_group.insert(key("type"), Value::String("select".to_string()));
    user_group.insert(
        key("proxies"),
        Value::Sequence(leaf_names.into_iter().map(Value::String).collect()),
    );
    new_groups.push(Value::Mapping(user_group));

    Ok(NormalizedSubscription {
        nodes,
        proxies: new_proxies,
        groups: new_groups,
        base_rules,
        decision,
    })
}

pub fn build_profile_yaml(
    normalized: &NormalizedSubscription,
    previous: Option<&Value>,
    fresh: &Value,
    user_lines: &[String],
) -> Value {
    let mut root = if let Some(Value::Mapping(map)) = previous {
        let mut kept = map.clone();
        let auto = kept
            .get(&key("rododendron-auto-interface"))
            .and_then(|value| value.as_bool())
            .unwrap_or(false);
        kept.remove(&key("rododendron-auto-interface"));
        if auto {
            kept.remove(&key("interface-name"));
        }
        kept
    } else {
        let mut skeleton = Mapping::new();
        skeleton.insert(key("mixed-port"), Value::Number(7890.into()));
        skeleton.insert(key("allow-lan"), Value::Bool(false));
        skeleton.insert(key("mode"), Value::String("rule".to_string()));
        skeleton.insert(key("log-level"), Value::String("info".to_string()));
        if let Value::Mapping(source) = fresh {
            for name in [
                "tun",
                "dns",
                "hosts",
                "mixed-port",
                "allow-lan",
                "mode",
                "log-level",
                "ipv6",
                "external-controller",
                "secret",
            ] {
                if let Some(value) = source.get(&key(name)) {
                    skeleton.insert(key(name), value.clone());
                }
            }
        }
        skeleton
    };

    root.insert(key("proxies"), Value::Sequence(normalized.proxies.clone()));
    root.insert(
        key("proxy-groups"),
        Value::Sequence(normalized.groups.clone()),
    );
    root.remove(&key("proxy-providers"));
    let mut value = Value::Mapping(root);
    let composed = compose_subscription_rules(user_lines, &normalized.base_rules);
    write_composed_rules(&mut value, &composed);
    value
}

pub fn move_selected_first(yaml: &str, proxy_name: &str) -> Result<String, String> {
    let mut value: Value = serde_yaml::from_str(yaml).map_err(|err| err.to_string())?;
    let Some(groups) = value
        .get_mut("proxy-groups")
        .and_then(|item| item.as_sequence_mut())
    else {
        return Ok(yaml.to_string());
    };
    for group in groups {
        let Some(map) = group.as_mapping_mut() else {
            continue;
        };
        if scalar(map, "name").as_deref() != Some(USER_GROUP) {
            continue;
        }
        let Some(Value::Sequence(items)) = map.get_mut(&key("proxies")) else {
            break;
        };
        if let Some(position) = items.iter().position(|item| item.as_str() == Some(proxy_name)) {
            let chosen = items.remove(position);
            items.insert(0, chosen);
        }
        break;
    }
    serde_yaml::to_string(&value).map_err(|err| err.to_string())
}

/// Short, secret-free description of a body for logs.
pub fn describe_body(text: &str) -> &'static str {
    let text = text.trim_start_matches('\u{feff}').trim_start();
    match text.chars().next() {
        None => "empty",
        Some('[') => "json array",
        Some('{') => "json object",
        _ if text.contains("://") => "link list",
        _ if text.contains("proxies:") => "clash yaml",
        _ => "text",
    }
}

pub fn parse_subscription_text(text: &str) -> Result<ParsedBody, String> {
    let text = text.trim_start_matches('\u{feff}').trim();
    if text.is_empty() {
        return Err("Subscription is empty".to_string());
    }
    if let Some(parsed) = parse_clash_document(text) {
        tracing::info!("Subscription format: clash yaml, {} proxies", parsed.proxies.len());
        return Ok(parsed);
    }
    if let Some(result) = parse_xray_json(text) {
        match &result {
            Ok(parsed) => tracing::info!("Subscription format: xray json, {} proxies", parsed.proxies.len()),
            Err(err) => tracing::warn!("Subscription format: xray json, no usable proxies: {err}"),
        }
        return result;
    }
    if let Some(decoded) = decode_base64_text(text) {
        if let Some(parsed) = parse_clash_document(&decoded) {
            tracing::info!("Subscription format: base64 clash yaml, {} proxies", parsed.proxies.len());
            return Ok(parsed);
        }
        if let Some(result) = parse_xray_json(&decoded) {
            return result;
        }
        if looks_like_links(&decoded) {
            tracing::info!("Subscription format: base64 link list");
            return proxies_from_links(&decoded);
        }
    }
    if looks_like_links(text) {
        tracing::info!("Subscription format: link list");
        return proxies_from_links(text);
    }
    tracing::warn!("Subscription format not recognised: {}", describe_body(text));
    Err("Subscription did not contain any proxies".to_string())
}

fn json_str<'a>(value: &'a serde_json::Value, name: &str) -> Option<&'a str> {
    value
        .get(name)?
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
}

/// Xray/V2Ray client JSON: one config per array item, each with its own
/// `outbounds` and a `remarks` title. Every config becomes one proxy, built
/// from its first outbound that mihomo can dial. Balancers, routing and
/// fragment helper outbounds are not carried over.
fn parse_xray_json(text: &str) -> Option<Result<ParsedBody, String>> {
    let json: serde_json::Value = serde_json::from_str(text).ok()?;
    let configs: Vec<&serde_json::Value> = match &json {
        serde_json::Value::Array(items) => items.iter().collect(),
        serde_json::Value::Object(_) => vec![&json],
        _ => return None,
    };
    if !configs.iter().any(|config| config.get("outbounds").is_some()) {
        return None;
    }

    let mut proxies = Vec::new();
    let mut skipped = Vec::new();
    for (index, config) in configs.iter().enumerate() {
        let Some(outbounds) = config.get("outbounds").and_then(|value| value.as_array()) else {
            continue;
        };
        let name = json_str(config, "remarks")
            .map(str::to_string)
            .unwrap_or_else(|| format!("Server {}", index + 1));
        let mut reason = None;
        let mut found = None;
        for outbound in outbounds {
            match xray_outbound_to_proxy(outbound, &name) {
                Ok(Some(map)) => {
                    found = Some(map);
                    break;
                }
                Ok(None) => {}
                Err(why) => {
                    reason.get_or_insert(why);
                }
            }
        }
        match found {
            Some(map) => proxies.push(Value::Mapping(map)),
            None => {
                let why = reason.unwrap_or_else(|| "no proxy outbound".to_string());
                tracing::warn!("Xray config {name:?} skipped: {why}");
                skipped.push(format!("{name}: {why}"));
            }
        }
    }

    if proxies.is_empty() {
        return Some(Err(format!(
            "Subscription did not contain any supported proxies ({})",
            skipped.join("; ")
        )));
    }
    let mut document = Mapping::new();
    document.insert(key("proxies"), Value::Sequence(proxies.clone()));
    Some(Ok(ParsedBody {
        document: Value::Mapping(document),
        proxies,
        groups: Vec::new(),
        rules: vec!["MATCH,PROXY".to_string()],
    }))
}

/// `Ok(None)` for outbounds that are not a dialable proxy (freedom, blackhole,
/// or an outbound chained through a dialerProxy). `Err` names what is unsupported.
fn xray_outbound_to_proxy(
    outbound: &serde_json::Value,
    name: &str,
) -> Result<Option<Mapping>, String> {
    let protocol = json_str(outbound, "protocol").unwrap_or("");
    let vless = match protocol {
        "vless" => true,
        "trojan" => false,
        "freedom" | "blackhole" | "dns" | "loopback" | "" => return Ok(None),
        other => return Err(format!("unsupported protocol {other}")),
    };
    let stream = outbound.get("streamSettings");
    let dialer_proxy = stream
        .and_then(|value| value.get("sockopt"))
        .and_then(|value| json_str(value, "dialerProxy"));
    if dialer_proxy.is_some() {
        return Ok(None);
    }
    let stream_str = |field: &str| stream.and_then(|value| json_str(value, field));
    let network = stream_str("network").unwrap_or("tcp").to_ascii_lowercase();
    if !matches!(network.as_str(), "tcp" | "grpc" | "ws") {
        return Err(format!("unsupported transport {network}"));
    }
    let security = stream_str("security").unwrap_or("none").to_ascii_lowercase();
    if !matches!(security.as_str(), "none" | "tls" | "reality") {
        return Err(format!("unsupported security {security}"));
    }

    let settings = outbound.get("settings");
    let (target, user) = if vless {
        let target = settings.and_then(|value| value.get("vnext")).and_then(|value| value.get(0));
        (target, target.and_then(|value| value.get("users")).and_then(|value| value.get(0)))
    } else {
        let target = settings.and_then(|value| value.get("servers")).and_then(|value| value.get(0));
        (target, target)
    };
    let target = target.ok_or_else(|| "outbound has no server".to_string())?;
    let server = json_str(target, "address").ok_or_else(|| "outbound has no address".to_string())?;
    let port = target
        .get("port")
        .and_then(|value| value.as_u64())
        .and_then(|port| u16::try_from(port).ok())
        .ok_or_else(|| "outbound has no valid port".to_string())?;

    let mut map = Mapping::new();
    insert_str(&mut map, "name", name);
    insert_str(&mut map, "type", if vless { "vless" } else { "trojan" });
    insert_str(&mut map, "server", server);
    map.insert(key("port"), Value::Number(port.into()));
    let sni_key = if vless { "servername" } else { "sni" };
    if vless {
        let id = user
            .and_then(|value| json_str(value, "id"))
            .ok_or_else(|| "outbound has no user id".to_string())?;
        insert_str(&mut map, "uuid", id);
    } else {
        let password = json_str(target, "password").ok_or_else(|| "outbound has no password".to_string())?;
        insert_str(&mut map, "password", password);
    }
    map.insert(key("udp"), Value::Bool(true));
    insert_str(&mut map, "network", &network);
    map.insert(key("tls"), Value::Bool(security != "none"));
    if vless {
        if let Some(flow) = user.and_then(|value| json_str(value, "flow")) {
            insert_str(&mut map, "flow", flow);
        }
        if let Some(encryption) = user
            .and_then(|value| json_str(value, "encryption"))
            .filter(|value| !value.eq_ignore_ascii_case("none"))
        {
            insert_str(&mut map, "encryption", encryption);
        }
    }

    let security_block = stream.and_then(|value| value.get(match security.as_str() {
        "reality" => "realitySettings",
        _ => "tlsSettings",
    }));
    if let Some(block) = security_block {
        if let Some(sni) = json_str(block, "serverName") {
            insert_str(&mut map, sni_key, sni);
        }
        if let Some(fingerprint) = json_str(block, "fingerprint") {
            insert_str(&mut map, "client-fingerprint", fingerprint);
        }
        if security == "tls" {
            if let Some(alpn) = block.get("alpn").and_then(|value| value.as_array()) {
                let items: Vec<Value> = alpn
                    .iter()
                    .filter_map(|item| item.as_str())
                    .map(|item| Value::String(item.to_string()))
                    .collect();
                if !items.is_empty() {
                    map.insert(key("alpn"), Value::Sequence(items));
                }
            }
        }
        if security == "reality" {
            let mut reality = Mapping::new();
            if let Some(public_key) = json_str(block, "publicKey") {
                insert_str(&mut reality, "public-key", public_key);
            }
            if let Some(short_id) = json_str(block, "shortId") {
                insert_str(&mut reality, "short-id", short_id);
            }
            if let Some(spider_x) = json_str(block, "spiderX") {
                insert_str(&mut reality, "spider-x", spider_x);
            }
            map.insert(key("reality-opts"), Value::Mapping(reality));
        }
    }

    if network == "ws" {
        if let Some(ws) = stream.and_then(|value| value.get("wsSettings")) {
            let mut opts = Mapping::new();
            if let Some(path) = json_str(ws, "path") {
                insert_str(&mut opts, "path", path);
            }
            let host = ws
                .get("headers")
                .and_then(|headers| json_str(headers, "Host"))
                .or_else(|| json_str(ws, "host"));
            if let Some(host) = host {
                let mut headers = Mapping::new();
                insert_str(&mut headers, "Host", host);
                opts.insert(key("headers"), Value::Mapping(headers));
            }
            if !opts.is_empty() {
                map.insert(key("ws-opts"), Value::Mapping(opts));
            }
        }
    }
    if network == "grpc" {
        if let Some(service) = stream
            .and_then(|value| value.get("grpcSettings"))
            .and_then(|value| json_str(value, "serviceName"))
        {
            let mut opts = Mapping::new();
            insert_str(&mut opts, "grpc-service-name", service);
            map.insert(key("grpc-opts"), Value::Mapping(opts));
        }
    }
    Ok(Some(map))
}

pub fn mask_url(url: &str) -> String {
    let Ok(parsed) = reqwest::Url::parse(url) else {
        return "subscription".to_string();
    };
    let host = parsed.host_str().unwrap_or("subscription");
    let path = parsed.path();
    let suffix = if path.is_empty() || path == "/" {
        ""
    } else {
        "/…"
    };
    format!("{}://{host}{suffix}", parsed.scheme())
}

pub fn sha256_hex(data: &str) -> String {
    let digest = Sha256::digest(data.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn subscriptions_dir(root: &Path) -> PathBuf {
    root.join("subscriptions")
}

pub fn body_path(root: &Path, id: &str) -> PathBuf {
    subscriptions_dir(root).join(format!("{id}.body"))
}

pub fn json_path(root: &Path, id: &str) -> PathBuf {
    subscriptions_dir(root).join(format!("{id}.json"))
}

pub fn runtime_path(root: &Path, id: &str) -> PathBuf {
    subscriptions_dir(root).join(format!("{id}.runtime.yaml"))
}

pub fn journal_path(root: &Path, id: &str) -> PathBuf {
    subscriptions_dir(root).join(format!("{id}.txn"))
}

pub fn load_meta(root: &Path, id: &str) -> Result<SubscriptionMeta, String> {
    let text = fs::read_to_string(json_path(root, id))
        .map_err(|err| format!("Failed to read subscription: {err}"))?;
    serde_json::from_str(&text).map_err(|err| format!("Failed to parse subscription: {err}"))
}

pub fn load_meta_by_filename(root: &Path, filename: &str) -> Option<SubscriptionMeta> {
    let dir = subscriptions_dir(root);
    let entries = fs::read_dir(&dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(meta) = serde_json::from_str::<SubscriptionMeta>(&text) else {
            continue;
        };
        if meta.filename == filename {
            return Some(meta);
        }
    }
    None
}

pub fn save_meta(root: &Path, meta: &SubscriptionMeta) -> Result<(), String> {
    let text = serde_json::to_string_pretty(meta).map_err(|err| err.to_string())?;
    write_sync(&json_path(root, &meta.id), &text)
}

/// Provider `profile-title` replaces the stored name. A missing or invalid
/// header keeps the current name, including a title the user typed locally.
pub fn title_after_update(current: &str, fetched: Option<&str>) -> String {
    let Some(fetched) = fetched.map(str::trim).filter(|title| !title.is_empty()) else {
        return current.to_string();
    };
    crate::mihomo::normalize_display_title(fetched).unwrap_or_else(|_| current.to_string())
}

pub fn rename_subscription_title(root: &Path, filename: &str, title: &str) -> Result<String, String> {
    let title = crate::mihomo::normalize_display_title(title)?;
    let mut meta = load_meta_by_filename(root, filename)
        .ok_or_else(|| "Config is not a subscription".to_string())?;
    let previous_filename = meta.filename.clone();
    meta.title = title.clone();
    save_meta(root, &meta)?;
    if meta.filename != previous_filename {
        return Err("Subscription filename changed".to_string());
    }
    Ok(title)
}

pub fn remove_subscription_files(root: &Path, filename: &str) {
    let Some(meta) = load_meta_by_filename(root, filename) else {
        return;
    };
    let _ = fs::remove_file(body_path(root, &meta.id));
    let _ = fs::remove_file(json_path(root, &meta.id));
    let _ = fs::remove_file(runtime_path(root, &meta.id));
    let _ = fs::remove_file(journal_path(root, &meta.id));
    for path in [body_path(root, &meta.id), json_path(root, &meta.id), runtime_path(root, &meta.id)] {
        let _ = fs::remove_file(tmp_of(&path));
        let _ = fs::remove_file(bak_of(&path));
    }
}

pub fn commit_profile(
    root: &Path,
    id: &str,
    filename: &str,
    files: &ProfileFiles,
    crash_after: Option<CrashAfter>,
) -> Result<(), String> {
    if filename.contains(['/', '\\']) || filename.trim().is_empty() {
        return Err("Invalid profile filename".to_string());
    }
    let body = body_path(root, id);
    let yaml = root.join(filename);
    let json = json_path(root, id);
    let journal = journal_path(root, id);

    write_sync(&tmp_of(&body), &files.body)?;
    write_sync(&tmp_of(&yaml), &files.yaml)?;
    write_sync(&tmp_of(&json), &files.json)?;
    stop(crash_after, CrashAfter::Tmp)?;

    let mut record = Journal {
        state: "prepared".to_string(),
        id: id.to_string(),
        filename: filename.to_string(),
        body_existed: body.exists(),
        yaml_existed: yaml.exists(),
        json_existed: json.exists(),
    };
    write_sync(
        &journal,
        &serde_json::to_string(&record).map_err(|err| err.to_string())?,
    )?;
    stop(crash_after, CrashAfter::JournalPrepared)?;

    replace_file(&body)?;
    stop(crash_after, CrashAfter::ReplaceBody)?;
    replace_file(&yaml)?;
    stop(crash_after, CrashAfter::ReplaceYaml)?;
    replace_file(&json)?;
    stop(crash_after, CrashAfter::ReplaceJson)?;

    record.state = "committed".to_string();
    write_sync(
        &journal,
        &serde_json::to_string(&record).map_err(|err| err.to_string())?,
    )?;
    stop(crash_after, CrashAfter::JournalCommitted)?;

    let _ = fs::remove_file(bak_of(&body));
    let _ = fs::remove_file(bak_of(&yaml));
    let _ = fs::remove_file(bak_of(&json));
    stop(crash_after, CrashAfter::BaksDeleted)?;

    let _ = fs::remove_file(&journal);
    Ok(())
}

pub fn recover_subscription_transactions(root: &Path) -> Result<(), String> {
    let dir = subscriptions_dir(root);
    if dir.exists() {
        let entries = fs::read_dir(&dir).map_err(|err| err.to_string())?;
        for entry in entries {
            let path = entry.map_err(|err| err.to_string())?.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("txn") {
                continue;
            }
            recover_journal(root, &path)?;
        }
    }
    remove_orphan_tmps(root)
}

pub async fn fetch_subscription(url: &str) -> Result<FetchedBody, String> {
    let url = url.trim();
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("Subscription URL must use http or https".to_string());
    }
    let started = std::time::Instant::now();
    let host = reqwest::Url::parse(url)
        .ok()
        .and_then(|parsed| parsed.host_str().map(str::to_string))
        .unwrap_or_default();
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::limited(5))
        .no_proxy()
        .build()
        .map_err(|_| "Could not start the subscription client".to_string())?;
    let response = client
        .get(url)
        .header(reqwest::header::ACCEPT, "text/plain, application/yaml, */*")
        .header(reqwest::header::USER_AGENT, "rododendron")
        .send()
        .await
        .map_err(|err| {
            let message = map_fetch_error(&err, FetchStage::Request);
            tracing::warn!(
                "Subscription fetch failed at request stage for {host} after {:?}: {message} (connect={}, timeout={})",
                started.elapsed(),
                err.is_connect(),
                err.is_timeout()
            );
            message
        })?;
    let status = response.status();
    if !status.is_success() {
        tracing::warn!("Subscription server {host} returned {}", status.as_u16());
        return Err(format!("Subscription server returned {}", status.as_u16()));
    }
    let userinfo = header_string(response.headers(), "subscription-userinfo");
    let etag = header_string(response.headers(), "etag");
    let last_modified = header_string(response.headers(), "last-modified");
    let interval_hours = header_string(response.headers(), "profile-update-interval")
        .and_then(|value| value.trim().parse::<u64>().ok());
    let title = header_string(response.headers(), "profile-title")
        .as_deref()
        .and_then(decode_profile_title)
        .or_else(|| {
            header_string(response.headers(), "content-disposition")
                .as_deref()
                .and_then(filename_from_disposition)
        });
    let bytes = response.bytes().await.map_err(|err| {
        let message = map_fetch_error(&err, FetchStage::Body);
        tracing::warn!(
            "Subscription fetch failed while reading the body from {host} after {:?}: {message}",
            started.elapsed()
        );
        message
    })?;
    tracing::info!("Subscription fetched from {host} in {:?}", started.elapsed());
    if bytes.len() > MAX_BODY_BYTES {
        return Err("Subscription response is too large".to_string());
    }
    let text = String::from_utf8(bytes.to_vec())
        .map_err(|_| "Subscription response is not UTF-8 text".to_string())?;
    Ok(FetchedBody {
        text,
        userinfo,
        etag,
        last_modified,
        interval_hours,
        title,
    })
}

#[cfg(target_os = "windows")]
pub fn protect_secret(plain: &str) -> Result<String, String> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CRYPT_INTEGER_BLOB};

    let mut input_bytes = plain.as_bytes().to_vec();
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    let ok = unsafe {
        let input = CRYPT_INTEGER_BLOB {
            cbData: input_bytes.len() as u32,
            pbData: input_bytes.as_mut_ptr(),
        };
        CryptProtectData(
            &input,
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null_mut(),
            std::ptr::null(),
            0x1,
            &mut output,
        )
    };
    if ok == 0 || output.pbData.is_null() {
        return Err("Could not protect the subscription URL".to_string());
    }
    let encoded = unsafe {
        let bytes = std::slice::from_raw_parts(output.pbData, output.cbData as usize);
        let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
        LocalFree(output.pbData as _);
        encoded
    };
    Ok(encoded)
}

#[cfg(target_os = "windows")]
pub fn unprotect_secret(stored: &str) -> Result<String, String> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptUnprotectData, CRYPT_INTEGER_BLOB};

    let mut input_bytes = base64::engine::general_purpose::STANDARD
        .decode(stored.trim())
        .map_err(|_| "Could not read the protected subscription URL".to_string())?;
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    let ok = unsafe {
        let input = CRYPT_INTEGER_BLOB {
            cbData: input_bytes.len() as u32,
            pbData: input_bytes.as_mut_ptr(),
        };
        CryptUnprotectData(
            &input,
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null_mut(),
            std::ptr::null(),
            0x1,
            &mut output,
        )
    };
    if ok == 0 || output.pbData.is_null() {
        return Err("Could not read the protected subscription URL".to_string());
    }
    let text = unsafe {
        let bytes = std::slice::from_raw_parts(output.pbData, output.cbData as usize);
        let text = String::from_utf8(bytes.to_vec())
            .map_err(|_| "Could not read the protected subscription URL".to_string());
        LocalFree(output.pbData as _);
        text
    }?;
    Ok(text)
}

#[cfg(not(target_os = "windows"))]
pub fn protect_secret(_plain: &str) -> Result<String, String> {
    Err("Subscription URL protection is available on Windows".to_string())
}

#[cfg(not(target_os = "windows"))]
pub fn unprotect_secret(_stored: &str) -> Result<String, String> {
    Err("Subscription URL protection is available on Windows".to_string())
}

fn reference_map(
    proxies: &[(String, String)],
    groups: &[(String, String)],
) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let mut group_hits: HashMap<&str, Vec<&str>> = HashMap::new();
    for (old, new) in groups {
        group_hits.entry(old.as_str()).or_default().push(new.as_str());
    }
    let mut proxy_hits: HashMap<&str, Vec<&str>> = HashMap::new();
    for (old, new) in proxies {
        proxy_hits.entry(old.as_str()).or_default().push(new.as_str());
    }
    let mut names = HashSet::new();
    names.extend(group_hits.keys().copied());
    names.extend(proxy_hits.keys().copied());
    for name in names {
        if let Some(renamed) = group_hits.get(name).filter(|items| items.len() == 1) {
            if renamed[0] != name {
                map.insert(name.to_string(), renamed[0].to_string());
            }
            continue;
        }
        if let Some(renamed) = proxy_hits.get(name).filter(|items| items.len() == 1) {
            if renamed[0] != name {
                map.insert(name.to_string(), renamed[0].to_string());
            }
        }
    }
    map
}

fn rewrite_name_sequence(items: &mut [Value], map: &HashMap<String, String>) {
    for item in items {
        if let Some(name) = item.as_str() {
            if let Some(renamed) = map.get(name) {
                *item = Value::String(renamed.clone());
            }
        }
    }
}

fn rewrite_rule(rule: &str, map: &HashMap<String, String>) -> String {
    let mut parts: Vec<String> = rule.split(',').map(|part| part.trim().to_string()).collect();
    if parts.is_empty() {
        return rule.to_string();
    }
    let kind = parts[0].to_ascii_uppercase();
    let policy_at = if kind == "MATCH" {
        if parts.len() >= 2 { Some(1) } else { None }
    } else {
        let mut index = parts.len() - 1;
        while index > 0 && is_rule_flag(&parts[index]) {
            index -= 1;
        }
        if index > 0 { Some(index) } else { None }
    };
    if let Some(index) = policy_at {
        if let Some(renamed) = map.get(&parts[index]) {
            parts[index] = renamed.clone();
        }
    }
    parts.join(",")
}

fn is_rule_flag(value: &str) -> bool {
    let flag = value.to_ascii_lowercase();
    flag == "no-resolve" || flag == "src"
}

fn allocate_name(base: &str, used: &mut HashSet<String>) -> String {
    let base = if base.trim().is_empty() { "node" } else { base.trim() };
    if !used.contains(base) {
        used.insert(base.to_string());
        return base.to_string();
    }
    let mut suffix = 2u32;
    loop {
        let candidate = format!("{base} ({suffix})");
        if !used.contains(&candidate) {
            used.insert(candidate.clone());
            return candidate;
        }
        suffix += 1;
    }
}

fn parse_clash_document(text: &str) -> Option<ParsedBody> {
    let document: Value = serde_yaml::from_str(text).ok()?;
    let proxies = document
        .get("proxies")
        .and_then(|value| value.as_sequence())
        .cloned()
        .unwrap_or_default();
    if proxies.is_empty() {
        return None;
    }
    let groups = document
        .get("proxy-groups")
        .and_then(|value| value.as_sequence())
        .cloned()
        .unwrap_or_default();
    let rules = document
        .get("rules")
        .and_then(|value| value.as_sequence())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(|rule| rule.to_string()))
                .collect()
        })
        .unwrap_or_default();
    Some(ParsedBody {
        document,
        proxies,
        groups,
        rules,
    })
}

fn proxies_from_links(text: &str) -> Result<ParsedBody, String> {
    let mut proxies = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some(proxy) = link_to_proxy(line) {
            proxies.push(proxy);
        }
    }
    if proxies.is_empty() {
        return Err("Subscription did not contain any proxies".to_string());
    }
    let mut document = Mapping::new();
    document.insert(key("proxies"), Value::Sequence(proxies.clone()));
    Ok(ParsedBody {
        document: Value::Mapping(document),
        proxies,
        groups: Vec::new(),
        rules: vec!["MATCH,PROXY".to_string()],
    })
}

fn looks_like_links(text: &str) -> bool {
    text.lines().any(|line| {
        let line = line.trim();
        line.starts_with("vless://")
            || line.starts_with("trojan://")
            || line.starts_with("ss://")
            || line.starts_with("hysteria2://")
            || line.starts_with("hy2://")
    })
}

fn link_to_proxy(line: &str) -> Option<Value> {
    if line.starts_with("vless://") {
        return vless_proxy(line);
    }
    if line.starts_with("trojan://") {
        return trojan_proxy(line);
    }
    if line.starts_with("ss://") {
        return shadowsocks_proxy(line);
    }
    if line.starts_with("hysteria2://") || line.starts_with("hy2://") {
        return hysteria2_proxy(line);
    }
    None
}

fn vless_proxy(line: &str) -> Option<Value> {
    let url = reqwest::Url::parse(line).ok()?;
    let uuid = urlencoding::decode(url.username()).ok()?.to_string();
    if uuid.is_empty() {
        return None;
    }
    let server = url.host_str()?.to_string();
    let port = url.port().unwrap_or(443);
    let name = fragment_name(&url, "VLESS");
    let params = query_map(url.query().unwrap_or(""));
    let network = params.get("type").map(|value| value.to_ascii_lowercase()).unwrap_or_else(|| "tcp".to_string());
    let security = params.get("security").map(|value| value.to_ascii_lowercase()).unwrap_or_default();
    let mut map = Mapping::new();
    insert_str(&mut map, "name", &name);
    insert_str(&mut map, "type", "vless");
    insert_str(&mut map, "server", &server);
    map.insert(key("port"), Value::Number(port.into()));
    insert_str(&mut map, "uuid", &uuid);
    map.insert(key("udp"), Value::Bool(true));
    insert_str(&mut map, "network", &network);
    map.insert(
        key("tls"),
        Value::Bool(security == "tls" || security == "reality"),
    );
    apply_transport(&mut map, &params, &network, &security, true);
    Some(Value::Mapping(map))
}

fn trojan_proxy(line: &str) -> Option<Value> {
    let url = reqwest::Url::parse(line).ok()?;
    let password = urlencoding::decode(url.username()).ok()?.to_string();
    if password.is_empty() {
        return None;
    }
    let server = url.host_str()?.to_string();
    let port = url.port().unwrap_or(443);
    let name = fragment_name(&url, "Trojan");
    let params = query_map(url.query().unwrap_or(""));
    let network = params.get("type").map(|value| value.to_ascii_lowercase()).unwrap_or_else(|| "tcp".to_string());
    let security = params.get("security").map(|value| value.to_ascii_lowercase()).unwrap_or_else(|| "tls".to_string());
    let mut map = Mapping::new();
    insert_str(&mut map, "name", &name);
    insert_str(&mut map, "type", "trojan");
    insert_str(&mut map, "server", &server);
    map.insert(key("port"), Value::Number(port.into()));
    insert_str(&mut map, "password", &password);
    map.insert(key("udp"), Value::Bool(true));
    insert_str(&mut map, "network", &network);
    map.insert(key("tls"), Value::Bool(security != "none"));
    apply_transport(&mut map, &params, &network, &security, false);
    Some(Value::Mapping(map))
}

fn shadowsocks_proxy(line: &str) -> Option<Value> {
    let url = reqwest::Url::parse(line).ok()?;
    let name = fragment_name(&url, "Shadowsocks");
    let (method, password, server, port) = if !url.username().is_empty() && url.port().is_some() {
        let decoded = decode_base64_text(url.username())?;
        let (method, password) = decoded.split_once(':')?;
        (method.to_string(), password.to_string(), url.host_str()?.to_string(), url.port()?)
    } else {
        let raw = line.trim_start_matches("ss://");
        let raw = raw.split('#').next().unwrap_or(raw);
        let decoded = decode_base64_text(raw)?;
        let (user, hostport) = decoded.rsplit_once('@')?;
        let (method, password) = user.split_once(':')?;
        let (server, port) = hostport.rsplit_once(':')?;
        (method.to_string(), password.to_string(), server.to_string(), port.parse().ok()?)
    };
    let mut map = Mapping::new();
    insert_str(&mut map, "name", &name);
    insert_str(&mut map, "type", "ss");
    insert_str(&mut map, "server", &server);
    map.insert(key("port"), Value::Number(port.into()));
    insert_str(&mut map, "cipher", &method);
    insert_str(&mut map, "password", &password);
    map.insert(key("udp"), Value::Bool(true));
    Some(Value::Mapping(map))
}

fn hysteria2_proxy(line: &str) -> Option<Value> {
    let stripped = line
        .trim_start_matches("hysteria2://")
        .trim_start_matches("hy2://");
    let (without_name, name) = match stripped.split_once('#') {
        Some((body, name)) => (
            body,
            urlencoding::decode(name).ok()?.trim().to_string(),
        ),
        None => (stripped, "Hysteria2".to_string()),
    };
    let name = if name.is_empty() { "Hysteria2".to_string() } else { name };
    let (before_query, query) = match without_name.split_once('?') {
        Some((body, query)) => (body, query),
        None => (without_name, ""),
    };
    let (password, hostport) = before_query.rsplit_once('@')?;
    let password = urlencoding::decode(password).ok()?.to_string();
    let hostport = hostport.split('/').next().unwrap_or(hostport);
    let (server, port) = split_host_port(hostport)?;
    let params = query_map(query);
    let mut map = Mapping::new();
    insert_str(&mut map, "name", &name);
    insert_str(&mut map, "type", "hysteria2");
    insert_str(&mut map, "server", &server);
    map.insert(key("port"), Value::Number(port.into()));
    insert_str(&mut map, "password", &password);
    if let Some(sni) = params.get("sni") {
        insert_str(&mut map, "sni", sni);
    }
    if params.get("insecure").map(String::as_str) == Some("1") {
        map.insert(key("skip-cert-verify"), Value::Bool(true));
    }
    if params.get("obfs").map(String::as_str) == Some("salamander") {
        if let Some(obfs_password) = params.get("obfs-password") {
            insert_str(&mut map, "obfs", "salamander");
            insert_str(&mut map, "obfs-password", obfs_password);
        }
    }
    Some(Value::Mapping(map))
}

fn apply_transport(
    map: &mut Mapping,
    params: &HashMap<String, String>,
    network: &str,
    security: &str,
    vless: bool,
) {
    let sni_key = if vless { "servername" } else { "sni" };
    if let Some(sni) = params.get("sni").filter(|value| !value.is_empty()) {
        insert_str(map, sni_key, sni);
    }
    if let Some(fp) = params.get("fp").filter(|value| !value.is_empty()) {
        insert_str(map, "client-fingerprint", fp);
    }
    if let Some(flow) = params.get("flow").filter(|value| !value.is_empty()) {
        if network == "tcp" {
            insert_str(map, "flow", flow);
        }
    }
    if vless {
        if let Some(encryption) = params.get("encryption").filter(|value| {
            let value = value.trim();
            !value.is_empty() && !value.eq_ignore_ascii_case("none")
        }) {
            insert_str(map, "encryption", encryption);
        }
    }
    if security == "reality" {
        let mut reality = Mapping::new();
        if let Some(pbk) = params.get("pbk") {
            insert_str(&mut reality, "public-key", pbk);
        }
        if let Some(sid) = params.get("sid").filter(|value| !value.is_empty()) {
            insert_str(&mut reality, "short-id", sid);
        }
        if let Some(spx) = params.get("spx").filter(|value| !value.is_empty()) {
            insert_str(&mut reality, "spider-x", spx);
        }
        if params
            .get("support-x25519mlkem768")
            .is_some_and(|value| mlkem_enabled(value))
        {
            reality.insert(key("support-x25519mlkem768"), Value::Bool(true));
        }
        map.insert(key("reality-opts"), Value::Mapping(reality));
    }
    if network == "ws" {
        let mut ws = Mapping::new();
        if let Some(path) = params.get("path").filter(|value| !value.is_empty()) {
            insert_str(&mut ws, "path", path);
        }
        if let Some(host) = params.get("host").filter(|value| !value.is_empty()) {
            let mut headers = Mapping::new();
            insert_str(&mut headers, "Host", host);
            ws.insert(key("headers"), Value::Mapping(headers));
        }
        if !ws.is_empty() {
            map.insert(key("ws-opts"), Value::Mapping(ws));
        }
    }
    if network == "grpc" {
        let service = params.get("serviceName").filter(|value| !value.is_empty());
        let mode = params.get("mode").filter(|value| !value.is_empty());
        if service.is_some() || mode.is_some() {
            let mut grpc = Mapping::new();
            if let Some(service) = service {
                insert_str(&mut grpc, "grpc-service-name", service);
            }
            if let Some(mode) = mode {
                insert_str(&mut grpc, "grpc-mode", mode);
            }
            map.insert(key("grpc-opts"), Value::Mapping(grpc));
        }
    }
}

fn mlkem_enabled(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes"
    )
}

fn fragment_name(url: &reqwest::Url, fallback: &str) -> String {
    let name = url
        .fragment()
        .and_then(|value| urlencoding::decode(value).ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| fallback.to_string());
    name
}

fn query_map(query: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for part in query.split('&') {
        if part.is_empty() {
            continue;
        }
        let (raw_key, raw_value) = part.split_once('=').unwrap_or((part, ""));
        let decode = |value: &str| {
            urlencoding::decode(&value.replace('+', "%2B"))
                .map(|decoded| decoded.into_owned())
                .unwrap_or_else(|_| value.to_string())
        };
        map.insert(decode(raw_key), decode(raw_value));
    }
    map
}

fn split_host_port(hostport: &str) -> Option<(String, u16)> {
    if let Some(rest) = hostport.strip_prefix('[') {
        let (host, port) = rest.split_once("]:")?;
        return Some((host.to_string(), port.parse().ok()?));
    }
    let (host, port) = hostport.rsplit_once(':')?;
    Some((host.to_string(), port.parse().ok()?))
}

fn decode_base64_text(text: &str) -> Option<String> {
    let compact: String = text.chars().filter(|ch| !ch.is_whitespace()).collect();
    if compact.len() < 8 {
        return None;
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&compact)
        .or_else(|_| base64::engine::general_purpose::URL_SAFE.decode(&compact))
        .or_else(|_| base64::engine::general_purpose::STANDARD_NO_PAD.decode(&compact))
        .ok()?;
    String::from_utf8(bytes).ok()
}

fn header_string(headers: &reqwest::header::HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn strip_profile_extension(name: &str) -> String {
    let trimmed = name.trim();
    let lower = trimmed.to_ascii_lowercase();
    for ext in [".yaml", ".yml", ".txt"] {
        if lower.ends_with(ext) {
            return trimmed[..trimmed.len() - ext.len()].trim().to_string();
        }
    }
    trimmed.to_string()
}

fn decode_profile_title(value: &str) -> Option<String> {
    let value = value.trim();
    let text = match value.strip_prefix("base64:") {
        Some(encoded) => decode_base64_text(encoded)?,
        None => value.to_string(),
    };
    let text = text.trim();
    if text.is_empty() { None } else { Some(text.to_string()) }
}

fn filename_from_disposition(value: &str) -> Option<String> {
    for part in value.split(';') {
        let part = part.trim();
        if let Some(raw) = part.strip_prefix("filename*=") {
            let encoded = raw.rsplit("''").next().unwrap_or(raw).trim_matches('"');
            if let Ok(decoded) = urlencoding::decode(encoded) {
                let name = strip_profile_extension(&decoded);
                if !name.is_empty() {
                    return Some(name);
                }
            }
        }
    }
    let part = value.split(';').find(|part| part.trim().starts_with("filename="))?;
    let raw = part.split_once('=')?.1.trim().trim_matches('"').trim();
    let name = strip_profile_extension(raw);
    if name.is_empty() { None } else { Some(name) }
}

#[derive(Clone, Copy)]
enum FetchStage {
    Request,
    Body,
}

fn map_fetch_error(err: &reqwest::Error, stage: FetchStage) -> String {
    if let Some(status) = err.status() {
        return format!("Subscription server returned {}", status.as_u16());
    }
    match stage {
        FetchStage::Request => {
            if err.is_connect() && err.is_timeout() {
                "Subscription request timed out: the server did not accept the connection".to_string()
            } else if err.is_connect() {
                "Could not connect to the subscription server".to_string()
            } else if err.is_timeout() {
                "Subscription request timed out: the server accepted the connection but sent no response".to_string()
            } else {
                "Subscription request failed".to_string()
            }
        }
        FetchStage::Body => {
            if err.is_timeout() {
                "Subscription request timed out while downloading the response".to_string()
            } else {
                "Subscription download was interrupted".to_string()
            }
        }
    }
}

fn recover_journal(root: &Path, path: &Path) -> Result<(), String> {
    let text = fs::read_to_string(path).map_err(|err| err.to_string())?;
    let journal: Journal = serde_json::from_str(&text).map_err(|err| err.to_string())?;
    let body = body_path(root, &journal.id);
    let yaml = root.join(&journal.filename);
    let json = json_path(root, &journal.id);
    if journal.state == "committed" {
        for item in [&body, &yaml, &json] {
            let _ = fs::remove_file(bak_of(item));
            let _ = fs::remove_file(tmp_of(item));
        }
        let _ = fs::remove_file(path);
        return Ok(());
    }
    restore_dest(&body, journal.body_existed)?;
    restore_dest(&yaml, journal.yaml_existed)?;
    restore_dest(&json, journal.json_existed)?;
    for item in [&body, &yaml, &json] {
        let _ = fs::remove_file(tmp_of(item));
    }
    let _ = fs::remove_file(path);
    Ok(())
}

fn restore_dest(dest: &Path, existed: bool) -> Result<(), String> {
    let backup = bak_of(dest);
    if existed {
        if backup.exists() {
            move_file(&backup, dest)?;
        }
        return Ok(());
    }
    if dest.exists() {
        fs::remove_file(dest).map_err(|err| err.to_string())?;
    }
    if backup.exists() {
        let _ = fs::remove_file(backup);
    }
    Ok(())
}

fn replace_file(dest: &Path) -> Result<(), String> {
    let tmp = tmp_of(dest);
    if dest.exists() {
        move_file(dest, &bak_of(dest))?;
    }
    move_file(&tmp, dest)
}

fn move_file(from: &Path, to: &Path) -> Result<(), String> {
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    if to.exists() {
        fs::remove_file(to).map_err(|err| err.to_string())?;
    }
    fs::rename(from, to).map_err(|err| format!("Failed to move {}: {err}", to.display()))
}

fn write_sync(path: &Path, data: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let mut file = File::create(path).map_err(|err| err.to_string())?;
    file.write_all(data.as_bytes()).map_err(|err| err.to_string())?;
    file.sync_all().map_err(|err| err.to_string())?;
    Ok(())
}

fn tmp_of(path: &Path) -> PathBuf {
    let name = path.file_name().and_then(|value| value.to_str()).unwrap_or("file");
    path.with_file_name(format!("{name}.txn.tmp"))
}

fn bak_of(path: &Path) -> PathBuf {
    let name = path.file_name().and_then(|value| value.to_str()).unwrap_or("file");
    path.with_file_name(format!("{name}.txn.bak"))
}

fn stop(crash_after: Option<CrashAfter>, here: CrashAfter) -> Result<(), String> {
    if crash_after == Some(here) {
        Err(format!("crashed:{}", crash_label(here)))
    } else {
        Ok(())
    }
}

fn crash_label(point: CrashAfter) -> &'static str {
    match point {
        CrashAfter::Tmp => "tmp",
        CrashAfter::JournalPrepared => "journal-prepared",
        CrashAfter::ReplaceBody => "replace-body",
        CrashAfter::ReplaceYaml => "replace-yaml",
        CrashAfter::ReplaceJson => "replace-json",
        CrashAfter::JournalCommitted => "journal-committed",
        CrashAfter::BaksDeleted => "baks-deleted",
    }
}

fn remove_orphan_tmps(root: &Path) -> Result<(), String> {
    remove_tmps_in(root)?;
    let nested = subscriptions_dir(root);
    if nested.exists() {
        remove_tmps_in(&nested)?;
    }
    Ok(())
}

fn remove_tmps_in(dir: &Path) -> Result<(), String> {
    let entries = fs::read_dir(dir).map_err(|err| err.to_string())?;
    for entry in entries {
        let path = entry.map_err(|err| err.to_string())?.path();
        let name = path.file_name().and_then(|value| value.to_str()).unwrap_or("");
        if name.ends_with(".txn.tmp") {
            let _ = fs::remove_file(path);
        }
    }
    Ok(())
}

fn key(name: &str) -> Value {
    Value::String(name.to_string())
}

fn insert_str(map: &mut Mapping, name: &str, value: &str) {
    map.insert(key(name), Value::String(value.to_string()));
}

fn scalar(map: &Mapping, name: &str) -> Option<String> {
    map.get(&key(name)).and_then(value_string)
}

fn value_string(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        Value::Bool(flag) => Some(flag.to_string()),
        _ => None,
    }
}

fn value_port(value: &Value) -> Option<u16> {
    match value {
        Value::Number(number) => number.as_u64().and_then(|port| u16::try_from(port).ok()),
        Value::String(text) => text.trim().parse().ok(),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(id: &str, name: &str, server: &str, port: u16, proxy_type: &str) -> SubscriptionNode {
        SubscriptionNode {
            id: id.to_string(),
            name: name.to_string(),
            server: server.to_string(),
            port,
            proxy_type: proxy_type.to_string(),
        }
    }

    fn hint(server: &str, port: u16, proxy_type: &str) -> NodeHint {
        NodeHint {
            server: server.to_string(),
            port,
            proxy_type: proxy_type.to_string(),
        }
    }

    fn proxy(name: &str, server: &str, password: &str) -> Value {
        let mut map = Mapping::new();
        insert_str(&mut map, "name", name);
        insert_str(&mut map, "type", "ss");
        insert_str(&mut map, "server", server);
        map.insert(key("port"), Value::Number(443.into()));
        insert_str(&mut map, "cipher", "aes-128-gcm");
        insert_str(&mut map, "password", password);
        Value::Mapping(map)
    }

    fn group(name: &str, proxies: &[&str]) -> Value {
        let mut map = Mapping::new();
        insert_str(&mut map, "name", name);
        insert_str(&mut map, "type", "url-test");
        map.insert(
            key("proxies"),
            Value::Sequence(proxies.iter().copied().map(|item| Value::String(item.to_string())).collect()),
        );
        Value::Mapping(map)
    }

    #[test]
    fn server_id_ignores_display_name_and_changes_with_password() {
        let mut first = Mapping::new();
        insert_str(&mut first, "name", "Alpha");
        insert_str(&mut first, "type", "ss");
        insert_str(&mut first, "server", "Example.COM");
        first.insert(key("port"), Value::Number(443.into()));
        insert_str(&mut first, "password", "one");
        let mut renamed = first.clone();
        insert_str(&mut renamed, "name", "Beta");
        let mut other = first.clone();
        insert_str(&mut other, "password", "two");
        assert_eq!(server_id_of(&first), server_id_of(&renamed));
        assert_ne!(server_id_of(&first), server_id_of(&other));
    }

    #[test]
    fn exact_server_id_restores_the_current_name() {
        let nodes = vec![node("id-a", "New name", "a.example", 443, "ss")];
        let decision = decide_selection(Some("id-a"), Some(&hint("old.example", 1, "ss")), &nodes);
        assert_eq!(
            decision,
            SelectionDecision::Restore {
                server_id: "id-a".to_string(),
                name: "New name".to_string(),
            }
        );
    }

    #[test]
    fn missing_server_id_restores_only_a_single_candidate() {
        let nodes = vec![
            node("id-b", "Kept", "a.example", 443, "ss"),
            node("id-c", "Other", "b.example", 443, "ss"),
        ];
        let decision = decide_selection(Some("gone"), Some(&hint("a.example", 443, "ss")), &nodes);
        assert_eq!(
            decision,
            SelectionDecision::Restore {
                server_id: "id-b".to_string(),
                name: "Kept".to_string(),
            }
        );
    }

    #[test]
    fn missing_server_id_does_not_choose_among_several_candidates() {
        let nodes = vec![
            node("id-b", "One", "a.example", 443, "ss"),
            node("id-c", "Two", "a.example", 443, "ss"),
        ];
        let decision = decide_selection(Some("gone"), Some(&hint("a.example", 443, "ss")), &nodes);
        assert_eq!(decision, SelectionDecision::LeaveUnchanged);
    }

    #[test]
    fn missing_server_id_without_a_candidate_stays_unchanged() {
        let nodes = vec![node("id-b", "One", "b.example", 443, "ss")];
        let decision = decide_selection(Some("gone"), Some(&hint("a.example", 443, "ss")), &nodes);
        assert_eq!(decision, SelectionDecision::LeaveUnchanged);
    }

    #[test]
    fn duplicate_server_id_is_not_a_unique_restore() {
        let nodes = vec![
            node("id-a", "One", "a.example", 443, "ss"),
            node("id-a", "Two", "b.example", 443, "ss"),
        ];
        let decision = decide_selection(Some("id-a"), None, &nodes);
        assert_eq!(decision, SelectionDecision::LeaveUnchanged);
    }

    #[test]
    fn provider_proxy_group_keeps_its_routing_under_a_new_name() {
        let normalized = normalize_subscription(
            vec![proxy("Node", "a.example", "secret")],
            vec![
                group("PROXY", &["Node"]),
                group("Europe", &["PROXY", "Node"]),
            ],
            vec![
                "MATCH,PROXY".to_string(),
                "DOMAIN,example.com,PROXY,no-resolve".to_string(),
                "DOMAIN,other.com,Europe".to_string(),
            ],
            None,
            None,
        )
        .unwrap();

        let names: Vec<String> = normalized
            .groups
            .iter()
            .filter_map(|group| group.as_mapping())
            .filter_map(|map| scalar(map, "name"))
            .collect();
        assert!(names.contains(&"Subscription".to_string()));
        assert!(names.contains(&"Europe".to_string()));
        assert_eq!(names.last().map(String::as_str), Some(USER_GROUP));

        let provider = normalized
            .groups
            .iter()
            .find(|group| {
                group
                    .as_mapping()
                    .and_then(|map| scalar(map, "name"))
                    .as_deref()
                    == Some("Subscription")
            })
            .unwrap();
        assert_eq!(
            provider.get("type").and_then(|value| value.as_str()),
            Some("url-test")
        );
        let europe = normalized
            .groups
            .iter()
            .find(|group| {
                group.as_mapping().and_then(|map| scalar(map, "name")).as_deref() == Some("Europe")
            })
            .unwrap();
        let members = europe
            .get("proxies")
            .and_then(|value| value.as_sequence())
            .unwrap();
        assert_eq!(members[0].as_str(), Some("Subscription"));
        assert_eq!(normalized.base_rules[0], "MATCH,Subscription");
        assert_eq!(normalized.base_rules[1], "DOMAIN,example.com,Subscription,no-resolve");
        assert_eq!(normalized.base_rules[2], "DOMAIN,other.com,Europe");
        assert_eq!(normalized.decision, SelectionDecision::LeaveUnchanged);
        let user = normalized.groups.last().unwrap();
        assert_eq!(user.get("type").and_then(|value| value.as_str()), Some("select"));
        let user_members = user.get("proxies").and_then(|value| value.as_sequence()).unwrap();
        assert_eq!(user_members[0].as_str(), Some("Node"));
        assert_eq!(user_members[1].as_str(), Some("DIRECT"));
    }

    #[test]
    fn duplicate_proxy_names_stay_distinct_and_are_not_auto_selected() {
        let normalized = normalize_subscription(
            vec![
                proxy("Node", "a.example", "one"),
                proxy("Node", "b.example", "two"),
            ],
            vec![group("Main", &["Node"])],
            vec!["MATCH,Main".to_string()],
            None,
            None,
        )
        .unwrap();
        assert_eq!(normalized.nodes[0].name, "Node");
        assert_eq!(normalized.nodes[1].name, "Node (2)");
        assert_ne!(normalized.nodes[0].id, normalized.nodes[1].id);
        assert_eq!(normalized.base_rules[0], "MATCH,Main");
        assert_eq!(normalized.decision, SelectionDecision::LeaveUnchanged);
        let user = normalized.groups.last().unwrap();
        let members = user.get("proxies").and_then(|value| value.as_sequence()).unwrap();
        assert_eq!(members[0].as_str(), Some("Node"));
        assert_eq!(members[1].as_str(), Some("Node (2)"));
    }

    fn rule_list(value: &Value, field: &str) -> Vec<String> {
        value[field]
            .as_sequence()
            .unwrap()
            .iter()
            .map(|item| item.as_str().unwrap().to_string())
            .collect()
    }

    #[test]
    fn no_user_rules_keep_the_provider_terminal() {
        let composed = compose_subscription_rules(
            &[],
            &[
                "GEOSITE,category-ads,REJECT".to_string(),
                "MATCH,PROXY".to_string(),
            ],
        );
        assert_eq!(
            composed.rules,
            vec![
                "GEOSITE,category-ads,REJECT".to_string(),
                "MATCH,PROXY".to_string(),
            ]
        );
        assert!(composed.sub_rules.is_none());
    }

    #[test]
    fn chrome_process_rule_on_a_link_list_ends_direct_without_sub_rules() {
        let composed = compose_subscription_rules(
            &["PROCESS-NAME,chrome.exe,PROXY".to_string()],
            &["MATCH,PROXY".to_string()],
        );
        assert_eq!(
            composed.rules,
            vec![
                "PROCESS-NAME,chrome.exe,PROXY".to_string(),
                "MATCH,DIRECT".to_string(),
            ]
        );
        assert!(composed.sub_rules.is_none());
    }

    #[test]
    fn chrome_and_an_explicit_match_direct_still_have_one_terminal() {
        let composed = compose_subscription_rules(
            &[
                "PROCESS-NAME,chrome.exe,PROXY".to_string(),
                "MATCH,DIRECT".to_string(),
            ],
            &["MATCH,PROXY".to_string()],
        );
        assert_eq!(
            composed.rules,
            vec![
                "PROCESS-NAME,chrome.exe,PROXY".to_string(),
                "MATCH,DIRECT".to_string(),
            ]
        );
        assert!(composed.sub_rules.is_none());
    }

    #[test]
    fn user_rules_keep_domains_global_and_provider_rules_inside_sub_rules() {
        let composed = compose_subscription_rules(
            &[
                "PROCESS-NAME,chrome.exe,PROXY".to_string(),
                "DOMAIN,example.com,PROXY".to_string(),
                "DOMAIN-KEYWORD,example,DIRECT".to_string(),
                "PROCESS-NAME,msedge.exe,DIRECT".to_string(),
                "IP-CIDR,1.2.3.4/32,DIRECT,no-resolve".to_string(),
            ],
            &[
                "GEOSITE,category-ads,REJECT".to_string(),
                "DOMAIN,cdn.example,Subscription,no-resolve".to_string(),
                "MATCH,Subscription".to_string(),
            ],
        );
        assert_eq!(
            composed.rules,
            vec![
                "DOMAIN,example.com,PROXY".to_string(),
                "DOMAIN-KEYWORD,example,DIRECT".to_string(),
                "IP-CIDR,1.2.3.4/32,DIRECT,no-resolve".to_string(),
                "PROCESS-NAME,msedge.exe,DIRECT".to_string(),
                format!("SUB-RULE,(PROCESS-NAME,chrome.exe),{SUB_RULE_NAME}"),
                "MATCH,DIRECT".to_string(),
            ]
        );
        assert_eq!(
            composed.sub_rules,
            Some((
                SUB_RULE_NAME.to_string(),
                vec![
                    "GEOSITE,category-ads,REJECT".to_string(),
                    "DOMAIN,cdn.example,Subscription,no-resolve".to_string(),
                    "MATCH,Subscription".to_string(),
                ]
            ))
        );
    }

    #[test]
    fn domain_rules_do_not_publish_provider_rules_on_the_main_list() {
        let composed = compose_subscription_rules(
            &[
                "DOMAIN,example.com,PROXY".to_string(),
                "DOMAIN-KEYWORD,example,DIRECT".to_string(),
            ],
            &[
                "GEOSITE,category-ads,REJECT".to_string(),
                "MATCH,Subscription".to_string(),
            ],
        );
        assert_eq!(
            composed.rules,
            vec![
                "DOMAIN,example.com,PROXY".to_string(),
                "DOMAIN-KEYWORD,example,DIRECT".to_string(),
                "MATCH,DIRECT".to_string(),
            ]
        );
        assert!(composed.sub_rules.is_none());
    }

    #[test]
    fn provider_rules_without_a_terminal_match_still_end_the_sub_rule() {
        let composed = compose_subscription_rules(
            &["PROCESS-NAME,chrome.exe,PROXY".to_string()],
            &["GEOSITE,category-ads,REJECT".to_string()],
        );
        assert_eq!(
            composed.sub_rules,
            Some((
                SUB_RULE_NAME.to_string(),
                vec![
                    "GEOSITE,category-ads,REJECT".to_string(),
                    "MATCH,PROXY".to_string(),
                ]
            ))
        );
    }

    #[test]
    fn process_names_with_parentheses_stay_literal_rules() {
        let composed = compose_subscription_rules(
            &["PROCESS-NAME,app(1).exe,PROXY".to_string()],
            &[
                "GEOSITE,category-ads,REJECT".to_string(),
                "MATCH,PROXY".to_string(),
            ],
        );
        assert_eq!(composed.rules[0], "PROCESS-NAME,app(1).exe,PROXY");
        assert_eq!(composed.rules[1], "MATCH,DIRECT");
        assert!(composed.sub_rules.is_none());
    }

    #[test]
    fn profile_update_keeps_user_tun_dns_hosts_and_interface() {
        let normalized = normalize_subscription(
            vec![proxy("Node", "a.example", "secret")],
            Vec::new(),
            vec!["MATCH,PROXY".to_string()],
            None,
            None,
        )
        .unwrap();
        let previous: Value = serde_yaml::from_str(
            r#"
tun:
  enable: true
  stack: gvisor
dns:
  enhanced-mode: fake-ip
hosts:
  example.com: 9.9.9.9
interface-name: Ethernet
proxies:
  - name: Old
    type: ss
    server: old.example
    port: 1
"#,
        )
        .unwrap();
        let fresh: Value = serde_yaml::from_str(
            r#"
tun:
  enable: false
dns:
  enhanced-mode: redir-host
hosts:
  example.com: 1.1.1.1
"#,
        )
        .unwrap();
        let built = build_profile_yaml(
            &normalized,
            Some(&previous),
            &fresh,
            &["PROCESS-NAME,chrome.exe,PROXY".to_string()],
        );
        assert_eq!(built["tun"]["stack"].as_str(), Some("gvisor"));
        assert_eq!(built["dns"]["enhanced-mode"].as_str(), Some("fake-ip"));
        assert_eq!(built["hosts"]["example.com"].as_str(), Some("9.9.9.9"));
        assert_eq!(built["interface-name"].as_str(), Some("Ethernet"));
        assert_eq!(built["rules"][0].as_str(), Some("PROCESS-NAME,chrome.exe,PROXY"));
        assert_eq!(built["rules"][1].as_str(), Some("MATCH,DIRECT"));
        assert!(built.get("sub-rules").is_none());
        assert!(built.get("find-process-mode").is_none());
        assert!(built.get("proxy-providers").is_none());
    }

    #[test]
    fn subscription_update_keeps_the_process_rule_and_replaces_provider_sub_rules() {
        let previous_norm = normalize_subscription(
            vec![proxy("Node", "a.example", "secret")],
            Vec::new(),
            vec![
                "GEOSITE,category-ads,REJECT".to_string(),
                "MATCH,PROXY".to_string(),
            ],
            None,
            None,
        )
        .unwrap();
        let fresh: Value = serde_yaml::from_str("mode: rule\n").unwrap();
        let previous = build_profile_yaml(
            &previous_norm,
            None,
            &fresh,
            &["PROCESS-NAME,chrome.exe,PROXY".to_string()],
        );
        assert_eq!(
            previous["sub-rules"][SUB_RULE_NAME][0].as_str(),
            Some("GEOSITE,category-ads,REJECT")
        );

        let updated_norm = normalize_subscription(
            vec![proxy("Node", "a.example", "secret")],
            Vec::new(),
            vec![
                "GEOSITE,category-games,REJECT".to_string(),
                "DOMAIN,new.example,PROXY".to_string(),
                "MATCH,PROXY".to_string(),
            ],
            None,
            None,
        )
        .unwrap();
        let built = build_profile_yaml(
            &updated_norm,
            Some(&previous),
            &fresh,
            &["PROCESS-NAME,chrome.exe,PROXY".to_string()],
        );
        assert_eq!(
            rule_list(&built, "rules"),
            vec![
                format!("SUB-RULE,(PROCESS-NAME,chrome.exe),{SUB_RULE_NAME}"),
                "MATCH,DIRECT".to_string(),
            ]
        );
        assert_eq!(
            rule_list(&built["sub-rules"], SUB_RULE_NAME),
            vec![
                "GEOSITE,category-games,REJECT".to_string(),
                "DOMAIN,new.example,PROXY".to_string(),
                "MATCH,PROXY".to_string(),
            ]
        );
        assert!(built.get("find-process-mode").is_none());
    }

    #[test]
    fn clearing_user_rules_restores_the_provider_list_and_drops_only_our_sub_rule() {
        let normalized = normalize_subscription(
            vec![proxy("Node", "a.example", "secret")],
            Vec::new(),
            vec![
                "GEOSITE,category-ads,REJECT".to_string(),
                "MATCH,PROXY".to_string(),
            ],
            None,
            None,
        )
        .unwrap();
        let fresh: Value = serde_yaml::from_str("mode: rule\n").unwrap();
        let mut previous = build_profile_yaml(
            &normalized,
            None,
            &fresh,
            &["PROCESS-NAME,chrome.exe,PROXY".to_string()],
        );
        previous["sub-rules"]["provider-extra"] = Value::Sequence(vec![Value::String("MATCH,DIRECT".to_string())]);

        let cleared = build_profile_yaml(&normalized, Some(&previous), &fresh, &[]);
        assert_eq!(
            rule_list(&cleared, "rules"),
            vec![
                "GEOSITE,category-ads,REJECT".to_string(),
                "MATCH,PROXY".to_string(),
            ]
        );
        assert!(cleared["sub-rules"].get(SUB_RULE_NAME).is_none());
        assert_eq!(
            cleared["sub-rules"]["provider-extra"][0].as_str(),
            Some("MATCH,DIRECT")
        );
        assert!(cleared.get("find-process-mode").is_none());
    }

    #[test]
    fn link_list_and_clash_yaml_both_yield_proxies() {
        let yaml = parse_subscription_text(
            "proxies:\n  - name: A\n    type: ss\n    server: a.example\n    port: 443\n    cipher: aes-128-gcm\n    password: secret\nrules:\n  - MATCH,PROXY\n",
        )
        .unwrap();
        assert_eq!(yaml.proxies.len(), 1);
        let link = "vless://11111111-1111-1111-1111-111111111111@node.example:443?security=reality&pbk=pub&sni=www.example&type=tcp#Node";
        let encoded = base64::engine::general_purpose::STANDARD.encode(link);
        let parsed = parse_subscription_text(&encoded).unwrap();
        assert_eq!(parsed.proxies.len(), 1);
        assert_eq!(parsed.proxies[0]["type"].as_str(), Some("vless"));
        assert_eq!(parsed.proxies[0]["server"].as_str(), Some("node.example"));
    }

    fn reality_link(flag: Option<&str>) -> String {
        let mut query = "security=reality&pbk=pub-key&sid=ceaa&spx=%2Fspider&type=tcp".to_string();
        if let Some(flag) = flag {
            query.push_str("&support-x25519mlkem768=");
            query.push_str(flag);
        }
        format!(
            "vless://11111111-1111-1111-1111-111111111111@node.example:443?{query}#Node"
        )
    }

    #[test]
    fn vless_reality_keeps_mlkem_and_the_link_identity() {
        let parsed = parse_subscription_text(&reality_link(Some("true"))).unwrap();
        let reality = &parsed.proxies[0]["reality-opts"];
        assert_eq!(reality["support-x25519mlkem768"].as_bool(), Some(true));
        assert_eq!(reality["short-id"].as_str(), Some("ceaa"));
        assert_eq!(reality["public-key"].as_str(), Some("pub-key"));
        assert_eq!(reality["spider-x"].as_str(), Some("/spider"));
    }

    #[test]
    fn vless_reality_accepts_numeric_and_yes_mlkem() {
        for flag in ["1", "yes", "YES", "True"] {
            let parsed = parse_subscription_text(&reality_link(Some(flag))).unwrap();
            assert_eq!(
                parsed.proxies[0]["reality-opts"]["support-x25519mlkem768"].as_bool(),
                Some(true),
                "{flag}"
            );
            assert_eq!(
                parsed.proxies[0]["reality-opts"]["short-id"].as_str(),
                Some("ceaa"),
                "{flag}"
            );
        }
    }

    #[test]
    fn vless_reality_omits_disabled_or_missing_mlkem() {
        for flag in [None, Some("false"), Some("0"), Some("no"), Some("NO")] {
            let parsed = parse_subscription_text(&reality_link(flag)).unwrap();
            let reality = &parsed.proxies[0]["reality-opts"];
            assert!(
                reality.get("support-x25519mlkem768").is_none(),
                "{flag:?}"
            );
            assert_eq!(reality["short-id"].as_str(), Some("ceaa"));
            assert_eq!(reality["public-key"].as_str(), Some("pub-key"));
            assert_eq!(reality["spider-x"].as_str(), Some("/spider"));
        }
    }

    #[test]
    fn vless_grpc_keeps_multi_mode() {
        let link = "vless://11111111-1111-1111-1111-111111111111@node.example:443?type=grpc&security=tls&serviceName=kek&mode=multi";
        let parsed = parse_subscription_text(link).unwrap();
        let grpc = &parsed.proxies[0]["grpc-opts"];
        assert_eq!(grpc["grpc-service-name"].as_str(), Some("kek"));
        assert_eq!(grpc["grpc-mode"].as_str(), Some("multi"));
    }

    #[test]
    fn clash_yaml_keeps_an_existing_reality_mlkem_flag() {
        let text = r#"
proxies:
  - name: Node
    type: vless
    server: node.example
    port: 443
    uuid: 11111111-1111-1111-1111-111111111111
    reality-opts:
      public-key: pub-key
      short-id: ceaa
      spider-x: /spider
      support-x25519mlkem768: true
rules:
  - MATCH,PROXY
"#;
        let parsed = parse_clash_document(text).unwrap();
        let reality = &parsed.proxies[0]["reality-opts"];
        assert_eq!(reality["support-x25519mlkem768"].as_bool(), Some(true));
        assert_eq!(reality["short-id"].as_str(), Some("ceaa"));
        assert_eq!(reality["public-key"].as_str(), Some("pub-key"));
        assert_eq!(reality["spider-x"].as_str(), Some("/spider"));
        let via_text = parse_subscription_text(text).unwrap();
        assert_eq!(
            via_text.proxies[0]["reality-opts"]["support-x25519mlkem768"].as_bool(),
            Some(true)
        );
    }

    fn temp_root() -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "rododendron-txn-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(subscriptions_dir(&root)).unwrap();
        root
    }

    fn seed(root: &Path) {
        fs::write(body_path(root, "sub"), "old-body").unwrap();
        fs::write(root.join("Profile.yaml"), "old-yaml").unwrap();
        fs::write(json_path(root, "sub"), "old-json").unwrap();
    }

    fn files() -> ProfileFiles {
        ProfileFiles {
            body: "new-body".to_string(),
            yaml: "new-yaml".to_string(),
            json: "new-json".to_string(),
        }
    }

    fn read_three(root: &Path) -> (String, String, String) {
        (
            fs::read_to_string(body_path(root, "sub")).unwrap_or_default(),
            fs::read_to_string(root.join("Profile.yaml")).unwrap_or_default(),
            fs::read_to_string(json_path(root, "sub")).unwrap_or_default(),
        )
    }

    fn crash_and_recover(point: CrashAfter) -> (String, String, String) {
        let root = temp_root();
        seed(&root);
        let err = commit_profile(&root, "sub", "Profile.yaml", &files(), Some(point)).unwrap_err();
        assert!(err.starts_with("crashed:"));
        recover_subscription_transactions(&root).unwrap();
        let contents = read_three(&root);
        assert!(!journal_path(&root, "sub").exists());
        assert!(!tmp_of(&body_path(&root, "sub")).exists());
        assert!(!bak_of(&root.join("Profile.yaml")).exists());
        let _ = fs::remove_dir_all(&root);
        contents
    }

    #[test]
    fn recovery_after_tmp_keeps_the_old_files() {
        assert_eq!(
            crash_and_recover(CrashAfter::Tmp),
            ("old-body".to_string(), "old-yaml".to_string(), "old-json".to_string())
        );
    }

    #[test]
    fn recovery_after_prepared_journal_keeps_the_old_files() {
        assert_eq!(
            crash_and_recover(CrashAfter::JournalPrepared),
            ("old-body".to_string(), "old-yaml".to_string(), "old-json".to_string())
        );
    }

    #[test]
    fn recovery_after_body_replace_restores_the_old_body() {
        assert_eq!(
            crash_and_recover(CrashAfter::ReplaceBody),
            ("old-body".to_string(), "old-yaml".to_string(), "old-json".to_string())
        );
    }

    #[test]
    fn recovery_after_yaml_replace_restores_body_and_yaml() {
        assert_eq!(
            crash_and_recover(CrashAfter::ReplaceYaml),
            ("old-body".to_string(), "old-yaml".to_string(), "old-json".to_string())
        );
    }

    #[test]
    fn recovery_after_json_replace_restores_all_three_files() {
        assert_eq!(
            crash_and_recover(CrashAfter::ReplaceJson),
            ("old-body".to_string(), "old-yaml".to_string(), "old-json".to_string())
        );
    }

    #[test]
    fn recovery_after_committed_journal_keeps_the_new_files() {
        assert_eq!(
            crash_and_recover(CrashAfter::JournalCommitted),
            ("new-body".to_string(), "new-yaml".to_string(), "new-json".to_string())
        );
    }

    #[test]
    fn recovery_after_bak_deletion_keeps_the_new_files() {
        assert_eq!(
            crash_and_recover(CrashAfter::BaksDeleted),
            ("new-body".to_string(), "new-yaml".to_string(), "new-json".to_string())
        );
    }

    #[test]
    fn successful_commit_leaves_no_journal() {
        let root = temp_root();
        seed(&root);
        commit_profile(&root, "sub", "Profile.yaml", &files(), None).unwrap();
        assert_eq!(
            read_three(&root),
            ("new-body".to_string(), "new-yaml".to_string(), "new-json".to_string())
        );
        assert!(!journal_path(&root, "sub").exists());
        assert!(!bak_of(&body_path(&root, "sub")).exists());
        let _ = fs::remove_dir_all(&root);
    }

    const XRAY_SAMPLE: &str = r#"[
  {"remarks": "DE one", "outbounds": [
    {"tag": "proxy-tcp-reality-direct-1", "protocol": "vless",
     "settings": {"vnext": [{"address": "de.example.test", "port": 443,
       "users": [{"id": "11111111-1111-1111-1111-111111111111", "encryption": "none", "flow": "xtls-rprx-vision"}]}]},
     "streamSettings": {"network": "tcp", "security": "reality",
       "realitySettings": {"serverName": "sni.example.test", "fingerprint": "firefox", "publicKey": "pub-key", "shortId": "ab12"}}},
    {"tag": "fragment", "protocol": "freedom", "settings": {"fragment": {"packets": "tlshello"}}},
    {"tag": "direct", "protocol": "freedom"}
  ]},
  {"remarks": "LTE grpc", "outbounds": [
    {"tag": "proxy-1", "protocol": "vless",
     "settings": {"vnext": [{"address": "1.2.3.4", "port": 445,
       "users": [{"id": "22222222-2222-2222-2222-222222222222", "encryption": "none", "flow": ""}]}]},
     "streamSettings": {"network": "grpc", "security": "reality",
       "realitySettings": {"serverName": "sni.example.test", "fingerprint": "firefox", "publicKey": "pub-key", "shortId": ""},
       "grpcSettings": {"serviceName": "grpc", "multiMode": false}}}
  ]},
  {"remarks": "xhttp only", "outbounds": [
    {"tag": "proxy-2", "protocol": "vless",
     "settings": {"vnext": [{"address": "x.example.test", "port": 443,
       "users": [{"id": "33333333-3333-3333-3333-333333333333", "encryption": "none", "flow": ""}]}]},
     "streamSettings": {"network": "xhttp", "security": "tls", "tlsSettings": {"serverName": "x.example.test"}}}
  ]}
]"#;

    #[test]
    fn xray_json_array_yields_one_proxy_per_supported_config() {
        let parsed = parse_subscription_text(XRAY_SAMPLE).unwrap();
        assert_eq!(parsed.proxies.len(), 2);
        let first = &parsed.proxies[0];
        assert_eq!(first["name"].as_str(), Some("DE one"));
        assert_eq!(first["type"].as_str(), Some("vless"));
        assert_eq!(first["server"].as_str(), Some("de.example.test"));
        assert_eq!(first["port"].as_u64(), Some(443));
        assert_eq!(first["uuid"].as_str(), Some("11111111-1111-1111-1111-111111111111"));
        assert_eq!(first["flow"].as_str(), Some("xtls-rprx-vision"));
        assert_eq!(first["tls"].as_bool(), Some(true));
        assert_eq!(first["servername"].as_str(), Some("sni.example.test"));
        assert_eq!(first["client-fingerprint"].as_str(), Some("firefox"));
        assert_eq!(first["reality-opts"]["public-key"].as_str(), Some("pub-key"));
        assert_eq!(first["reality-opts"]["short-id"].as_str(), Some("ab12"));
        let second = &parsed.proxies[1];
        assert_eq!(second["name"].as_str(), Some("LTE grpc"));
        assert_eq!(second["network"].as_str(), Some("grpc"));
        assert_eq!(second["grpc-opts"]["grpc-service-name"].as_str(), Some("grpc"));
        assert!(second.get("flow").is_none());
        assert!(second["reality-opts"].get("short-id").is_none());
        assert_eq!(parsed.rules, vec!["MATCH,PROXY".to_string()]);
    }

    #[test]
    fn xray_json_with_no_supported_outbound_reports_why() {
        let only_xhttp = r#"[{"remarks": "x", "outbounds": [
            {"tag": "proxy-2", "protocol": "vless",
             "settings": {"vnext": [{"address": "x.example.test", "port": 443,
               "users": [{"id": "33333333-3333-3333-3333-333333333333"}]}]},
             "streamSettings": {"network": "xhttp", "security": "tls"}}]}]"#;
        let err = parse_subscription_text(only_xhttp).err().unwrap();
        assert!(err.contains("xhttp"), "{err}");
    }

    #[test]
    fn subscription_update_adopts_a_new_profile_title() {
        assert_eq!(title_after_update("Old", Some("  New name  ")), "New name");
        assert_eq!(title_after_update("Old", None), "Old");
        assert_eq!(title_after_update("Old", Some("   ")), "Old");
        assert_eq!(title_after_update("Old", Some("bad\nname")), "Old");
    }

    #[test]
    fn profile_title_is_read_from_plain_and_base64_headers() {
        assert_eq!(decode_profile_title("My VPN").as_deref(), Some("My VPN"));
        assert_eq!(decode_profile_title("base64:TXkgVlBO").as_deref(), Some("My VPN"));
        assert_eq!(decode_profile_title("   "), None);
    }

    #[test]
    fn disposition_filename_becomes_a_clean_title() {
        assert_eq!(
            filename_from_disposition("attachment; filename=\"Work.yaml\"").as_deref(),
            Some("Work")
        );
        assert_eq!(
            filename_from_disposition("attachment; filename*=UTF-8''My%20Sub.yml").as_deref(),
            Some("My Sub")
        );
        assert_eq!(filename_from_disposition("inline"), None);
    }

    #[test]
    fn masked_url_hides_the_query_token() {
        assert_eq!(
            mask_url("https://provider.example/sub/path?token=secret"),
            "https://provider.example/…"
        );
    }

    #[test]
    fn rename_subscription_title_keeps_filename_and_yaml() {
        let root = temp_root();
        let meta = SubscriptionMeta {
            id: "sub".to_string(),
            filename: "Profile.yaml".to_string(),
            title: "Old".to_string(),
            url_protected: "blob".to_string(),
            interval_hours: None,
            custom_interval_hours: None,
            etag: None,
            last_modified: None,
            updated_at: "2026-01-01 00:00:00".to_string(),
            userinfo: Some("upload=1".to_string()),
            selected_server_id: Some("server-1".to_string()),
            selected_hint: None,
            base_rules: vec!["MATCH,PROXY".to_string()],
            user_rule_lines: vec!["PROCESS-NAME,chrome.exe,PROXY".to_string()],
            nodes: Vec::new(),
            body_sha256: "b".to_string(),
            yaml_sha256: "y".to_string(),
        };
        fs::write(root.join("Profile.yaml"), "original-yaml").unwrap();
        save_meta(&root, &meta).unwrap();
        let title = rename_subscription_title(&root, "Profile.yaml", "  New name  ").unwrap();
        assert_eq!(title, "New name");
        let loaded = load_meta_by_filename(&root, "Profile.yaml").unwrap();
        assert_eq!(loaded.title, "New name");
        assert_eq!(loaded.filename, "Profile.yaml");
        assert_eq!(loaded.selected_server_id.as_deref(), Some("server-1"));
        assert_eq!(loaded.user_rule_lines, meta.user_rule_lines);
        assert_eq!(fs::read_to_string(root.join("Profile.yaml")).unwrap(), "original-yaml");
        assert!(rename_subscription_title(&root, "Profile.yaml", " ").is_err());
        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn protected_url_roundtrips_and_is_not_stored_as_plaintext() {
        let protected = protect_secret("https://provider.example/sub?token=secret").unwrap();
        assert!(!protected.contains("token=secret"));
        assert_eq!(
            unprotect_secret(&protected).unwrap(),
            "https://provider.example/sub?token=secret"
        );
    }
}
