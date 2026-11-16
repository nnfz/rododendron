use std::fs;
use std::path::Path;

use serde::Serialize;
use tauri::AppHandle;

use crate::mihomo::{
    apply_missing_defaults, lock_vpn_lifecycle, primary_config_dir, proxy_group_now,
    reload_mihomo_config, render_config, running_config_filename, switch_proxy_group,
    validate_config,
};
use crate::subscription::{
    self, NodeHint, SelectionDecision, SubscriptionMeta, SubscriptionNode, USER_GROUP,
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionInfo {
    pub filename: String,
    pub title: String,
    pub masked_url: String,
    pub updated_at: String,
    /// Effective interval: the user override, else the provider value.
    pub interval_hours: Option<u64>,
    pub custom_interval_hours: Option<u64>,
    pub userinfo: Option<String>,
    pub selected_server_id: Option<String>,
    pub nodes: Vec<SubscriptionNode>,
    pub user_rule_lines: Vec<String>,
    /// Full URL, returned only to fill the settings form.
    pub url: String,
}

#[tauri::command(rename_all = "camelCase")]
pub async fn add_subscription(
    app: AppHandle,
    url: String,
) -> Result<SubscriptionInfo, String> {
    let masked = subscription::mask_url(&url);
    tracing::info!("add_subscription: start {masked}");
    let fetched = subscription::fetch_subscription(&url).await?;
    tracing::info!(
        "add_subscription: fetched {} bytes ({}), title={:?}, interval_hours={:?}, userinfo={}",
        fetched.text.len(),
        subscription::describe_body(&fetched.text),
        fetched.title,
        fetched.interval_hours,
        fetched.userinfo.is_some()
    );
    let parsed = subscription::parse_subscription_text(&fetched.text).map_err(|err| {
        tracing::warn!("add_subscription: parse failed for {masked}: {err}");
        err
    })?;
    tracing::info!(
        "add_subscription: parsed {} proxies, {} groups, {} rules",
        parsed.proxies.len(),
        parsed.groups.len(),
        parsed.rules.len()
    );
    let dir = primary_config_dir(&app);
    let title = fetched
        .title
        .clone()
        .or_else(|| {
            reqwest::Url::parse(url.trim())
                .ok()
                .and_then(|parsed| parsed.host_str().map(str::to_string))
        })
        .unwrap_or_else(|| "Subscription".to_string());
    let protected = subscription::protect_secret(url.trim())?;
    let normalized = subscription::normalize_subscription(
        parsed.proxies.clone(),
        parsed.groups.clone(),
        parsed.rules.clone(),
        None,
        None,
    )?;
    let mut document = subscription::build_profile_yaml(&normalized, None, &parsed.document, &[]);
    if let Some(map) = document.as_mapping_mut() {
        apply_missing_defaults(map);
    }
    let yaml = serde_yaml::to_string(&document).map_err(|err| err.to_string())?;
    validate_config(&yaml).map_err(|err| {
        tracing::warn!("add_subscription: generated config failed validation: {err}");
        err
    })?;
    tracing::info!(
        "add_subscription: normalized {} nodes, generated {} bytes of yaml",
        normalized.nodes.len(),
        yaml.len()
    );
    let _guard = lock_vpn_lifecycle().await;
    let filename = profile_filename(&dir, &title);
    let meta = SubscriptionMeta {
        id: new_id(),
        filename: filename.clone(),
        title,
        url_protected: protected,
        interval_hours: fetched.interval_hours,
        custom_interval_hours: None,
        etag: fetched.etag.clone(),
        last_modified: fetched.last_modified.clone(),
        updated_at: now_stamp(),
        userinfo: fetched.userinfo.clone(),
        selected_server_id: None,
        selected_hint: None,
        base_rules: normalized.base_rules,
        user_rule_lines: Vec::new(),
        nodes: normalized.nodes,
        body_sha256: subscription::sha256_hex(&fetched.text),
        yaml_sha256: subscription::sha256_hex(&yaml),
    };
    subscription::commit_profile(
        &dir,
        &meta.id,
        &meta.filename,
        &subscription::ProfileFiles {
            body: fetched.text,
            yaml,
            json: serde_json::to_string_pretty(&meta).map_err(|err| err.to_string())?,
        },
        None,
    )
    .map_err(|err| {
        tracing::warn!("add_subscription: could not write profile {}: {err}", meta.filename);
        err
    })?;
    tracing::info!("add_subscription: saved {} with {} nodes", meta.filename, meta.nodes.len());
    info_from_meta(&meta, url.trim())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn update_subscription(
    app: AppHandle,
    filename: String,
) -> Result<SubscriptionInfo, String> {
    let dir = primary_config_dir(&app);
    let current = subscription::load_meta_by_filename(&dir, &filename)
        .ok_or_else(|| "Config is not a subscription".to_string())?;
    let url = subscription::unprotect_secret(&current.url_protected)?;
    tracing::info!("update_subscription: start {filename} from {}", subscription::mask_url(&url));
    let fetched = subscription::fetch_subscription(&url).await?;
    tracing::info!(
        "update_subscription: fetched {} bytes ({})",
        fetched.text.len(),
        subscription::describe_body(&fetched.text)
    );
    let parsed = subscription::parse_subscription_text(&fetched.text).map_err(|err| {
        tracing::warn!("update_subscription: parse failed for {filename}: {err}");
        err
    })?;
    let _guard = lock_vpn_lifecycle().await;
    let mut meta = subscription::load_meta_by_filename(&dir, &filename).unwrap_or(current);
    let previous_text = fs::read_to_string(dir.join(&meta.filename)).ok();
    let previous = previous_text
        .as_deref()
        .and_then(|text| serde_yaml::from_str(text).ok());
    let normalized = subscription::normalize_subscription(
        parsed.proxies,
        parsed.groups,
        parsed.rules,
        meta.selected_server_id.as_deref(),
        meta.selected_hint.as_ref(),
    )?;
    apply_selection(&mut meta, &normalized.decision, &normalized.nodes);
    let mut document = subscription::build_profile_yaml(
        &normalized,
        previous.as_ref(),
        &parsed.document,
        &meta.user_rule_lines,
    );
    if let Some(map) = document.as_mapping_mut() {
        apply_missing_defaults(map);
    }
    let yaml = serde_yaml::to_string(&document).map_err(|err| err.to_string())?;
    validate_config(&yaml)?;
    meta.base_rules = normalized.base_rules;
    meta.nodes = normalized.nodes;
    meta.updated_at = now_stamp();
    meta.userinfo = fetched.userinfo.clone();
    meta.etag = fetched.etag;
    meta.last_modified = fetched.last_modified;
    if fetched.interval_hours.is_some() {
        meta.interval_hours = fetched.interval_hours;
    }
    meta.body_sha256 = subscription::sha256_hex(&fetched.text);
    meta.yaml_sha256 = subscription::sha256_hex(&yaml);
    let running = running_config_filename();
    subscription::commit_profile(
        &dir,
        &meta.id,
        &meta.filename,
        &subscription::ProfileFiles {
            body: fetched.text,
            yaml: yaml.clone(),
            json: serde_json::to_string_pretty(&meta).map_err(|err| err.to_string())?,
        },
        None,
    )?;
    if running.as_deref() == Some(meta.filename.as_str()) {
        let rendered = render_config(yaml, Vec::new(), None, None, None)?;
        reload_mihomo_config(app.clone(), rendered, meta.filename.clone()).await?;
        match normalized.decision {
            SelectionDecision::Restore { name, .. } => {
                switch_proxy_group(USER_GROUP.to_string(), name).await?;
            }
            SelectionDecision::LeaveUnchanged => {
                if let Some(now) = proxy_group_now(USER_GROUP).await {
                    if meta.nodes.iter().any(|node| node.name == now) {
                        let _ = switch_proxy_group(USER_GROUP.to_string(), now).await;
                    }
                }
            }
        }
    }
    info_from_meta(&meta, &url)
}

#[tauri::command(rename_all = "camelCase")]
pub fn subscription_meta(
    app: AppHandle,
    filename: String,
) -> Result<Option<SubscriptionInfo>, String> {
    let dir = primary_config_dir(&app);
    let Some(meta) = subscription::load_meta_by_filename(&dir, &filename) else {
        return Ok(None);
    };
    let url = subscription::unprotect_secret(&meta.url_protected).unwrap_or_default();
    Ok(Some(info_from_meta(&meta, &url)?))
}

#[tauri::command(rename_all = "camelCase")]
pub async fn set_selected_server(
    app: AppHandle,
    filename: String,
    server_id: String,
) -> Result<SubscriptionInfo, String> {
    let dir = primary_config_dir(&app);
    let _guard = lock_vpn_lifecycle().await;
    let mut meta = subscription::load_meta_by_filename(&dir, &filename)
        .ok_or_else(|| "Config is not a subscription".to_string())?;
    let matches: Vec<SubscriptionNode> = meta
        .nodes
        .iter()
        .filter(|node| node.id == server_id)
        .cloned()
        .collect();
    if matches.len() != 1 {
        return Err("Server is no longer available".to_string());
    }
    let chosen = matches[0].clone();
    meta.selected_server_id = Some(chosen.id.clone());
    meta.selected_hint = Some(NodeHint {
        server: chosen.server.clone(),
        port: chosen.port,
        proxy_type: chosen.proxy_type.clone(),
    });
    let current = fs::read_to_string(dir.join(&meta.filename))
        .map_err(|err| format!("Failed to read config: {err}"))?;
    let yaml = subscription::move_selected_first(&current, &chosen.name)?;
    let body = fs::read_to_string(subscription::body_path(&dir, &meta.id)).unwrap_or_default();
    meta.yaml_sha256 = subscription::sha256_hex(&yaml);
    subscription::commit_profile(
        &dir,
        &meta.id,
        &meta.filename,
        &subscription::ProfileFiles {
            body,
            yaml,
            json: serde_json::to_string_pretty(&meta).map_err(|err| err.to_string())?,
        },
        None,
    )?;
    if running_config_filename().as_deref() == Some(meta.filename.as_str()) {
        switch_proxy_group(USER_GROUP.to_string(), chosen.name).await?;
    }
    let url = subscription::unprotect_secret(&meta.url_protected).unwrap_or_default();
    info_from_meta(&meta, &url)
}

fn apply_selection(
    meta: &mut SubscriptionMeta,
    decision: &SelectionDecision,
    nodes: &[SubscriptionNode],
) {
    if let SelectionDecision::Restore { server_id, .. } = decision {
        if let Some(node) = nodes.iter().find(|node| node.id == *server_id) {
            meta.selected_server_id = Some(node.id.clone());
            meta.selected_hint = Some(NodeHint {
                server: node.server.clone(),
                port: node.port,
                proxy_type: node.proxy_type.clone(),
            });
        }
    }
}

fn info_from_meta(meta: &SubscriptionMeta, url: &str) -> Result<SubscriptionInfo, String> {
    Ok(SubscriptionInfo {
        filename: meta.filename.clone(),
        title: meta.title.clone(),
        masked_url: if url.is_empty() {
            "subscription".to_string()
        } else {
            subscription::mask_url(url)
        },
        updated_at: meta.updated_at.clone(),
        interval_hours: meta.custom_interval_hours.or(meta.interval_hours),
        custom_interval_hours: meta.custom_interval_hours,
        userinfo: meta.userinfo.clone(),
        selected_server_id: meta.selected_server_id.clone(),
        nodes: meta.nodes.clone(),
        user_rule_lines: meta.user_rule_lines.clone(),
        url: url.to_string(),
    })
}

/// Surface settings only: the link and the update interval. The title goes
/// through `rename_config`. A changed link takes effect on the next update.
#[tauri::command(rename_all = "camelCase")]
pub async fn save_subscription_settings(
    app: AppHandle,
    filename: String,
    url: String,
    custom_interval_hours: Option<u64>,
) -> Result<SubscriptionInfo, String> {
    let url = url.trim().to_string();
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("Subscription URL must use http or https".to_string());
    }
    if custom_interval_hours.is_some_and(|hours| hours == 0 || hours > 24 * 90) {
        return Err("Update interval must be between 1 and 2160 hours".to_string());
    }
    let dir = primary_config_dir(&app);
    let _guard = lock_vpn_lifecycle().await;
    let mut meta = subscription::load_meta_by_filename(&dir, &filename)
        .ok_or_else(|| "Config is not a subscription".to_string())?;
    let current = subscription::unprotect_secret(&meta.url_protected).unwrap_or_default();
    if current != url {
        meta.url_protected = subscription::protect_secret(&url)?;
        tracing::info!("save_subscription_settings: link changed for {filename}");
    }
    meta.custom_interval_hours = custom_interval_hours;
    subscription::save_meta(&dir, &meta)?;
    info_from_meta(&meta, &url)
}

fn profile_filename(dir: &Path, title: &str) -> String {
    let cleaned: String = title
        .chars()
        .map(|ch| {
            if "\\/:*?\"<>|".contains(ch) {
                '-'
            } else {
                ch
            }
        })
        .take(60)
        .collect();
    let base = cleaned.trim().trim_matches('.').trim();
    let base = if base.is_empty() { "subscription" } else { base };
    let mut filename = format!("{base}.yaml");
    let mut suffix = 2u32;
    while dir.join(&filename).exists() || subscription::load_meta_by_filename(dir, &filename).is_some()
    {
        filename = format!("{base}-{suffix}.yaml");
        suffix += 1;
    }
    filename
}

fn new_id() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    format!("{nanos:x}")
}

fn now_stamp() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

#[cfg(test)]
mod tests {
    use super::{apply_selection, profile_filename};
    use crate::subscription::{NodeHint, SelectionDecision, SubscriptionMeta, SubscriptionNode};
    use std::fs;

    fn sample_meta() -> SubscriptionMeta {
        SubscriptionMeta {
            id: "id".to_string(),
            filename: "Subscription.yaml".to_string(),
            title: "Subscription".to_string(),
            url_protected: "blob".to_string(),
            interval_hours: None,
            custom_interval_hours: None,
            etag: None,
            last_modified: None,
            updated_at: "2026-01-01 00:00:00".to_string(),
            userinfo: None,
            selected_server_id: Some("old".to_string()),
            selected_hint: Some(NodeHint {
                server: "a.example".to_string(),
                port: 443,
                proxy_type: "vless".to_string(),
            }),
            base_rules: vec!["MATCH,PROXY".to_string()],
            user_rule_lines: Vec::new(),
            nodes: Vec::new(),
            body_sha256: "b".to_string(),
            yaml_sha256: "y".to_string(),
        }
    }

    #[test]
    fn leave_unchanged_keeps_the_previous_server() {
        let mut meta = sample_meta();
        apply_selection(&mut meta, &SelectionDecision::LeaveUnchanged, &[]);
        assert_eq!(meta.selected_server_id.as_deref(), Some("old"));
        assert_eq!(
            meta.selected_hint.as_ref().map(|hint| hint.server.as_str()),
            Some("a.example")
        );
    }

    #[test]
    fn restore_adopts_only_the_matching_candidate() {
        let mut meta = sample_meta();
        let nodes = vec![SubscriptionNode {
            id: "new".to_string(),
            name: "Node".to_string(),
            server: "b.example".to_string(),
            port: 8443,
            proxy_type: "trojan".to_string(),
        }];
        apply_selection(
            &mut meta,
            &SelectionDecision::Restore {
                server_id: "missing".to_string(),
                name: "Other".to_string(),
            },
            &nodes,
        );
        assert_eq!(meta.selected_server_id.as_deref(), Some("old"));

        apply_selection(
            &mut meta,
            &SelectionDecision::Restore {
                server_id: "new".to_string(),
                name: "Node".to_string(),
            },
            &nodes,
        );
        assert_eq!(meta.selected_server_id.as_deref(), Some("new"));
        assert_eq!(meta.selected_hint.as_ref().map(|hint| hint.port), Some(8443));
    }

    #[test]
    fn profile_filename_avoids_an_existing_file() {
        let dir = std::env::temp_dir().join(format!(
            "rododendron-profile-name-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or(0)
        ));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("Sub-s.yaml"), "x").unwrap();
        let name = profile_filename(&dir, "Sub/s");
        assert_eq!(name, "Sub-s-2.yaml");
        let _ = fs::remove_dir_all(&dir);
    }
}
