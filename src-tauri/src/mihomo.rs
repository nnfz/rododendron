use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::io::{BufRead, BufReader, Write};
use std::collections::HashSet;
use std::sync::LazyLock;
use std::thread;
use tauri::{AppHandle, Manager};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

static MIHOMO_PROCESS: Mutex<Option<Child>> = Mutex::new(None);

#[derive(Clone)]
struct ControllerConfig {
    host: String,
    port: u16,
    secret: Option<String>,
}

static CONTROLLER_CONFIG: LazyLock<Mutex<ControllerConfig>> = LazyLock::new(|| {
    Mutex::new(ControllerConfig {
        host: String::from("127.0.0.1"),
        port: 9090,
        secret: None,
    })
});

fn update_controller_config(config_content: &str) {
    let yaml: serde_yaml::Value = match serde_yaml::from_str(config_content) {
        Ok(v) => v,
        Err(_) => return,
    };

    let ext = yaml
        .get("external-controller")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();

    let secret = yaml
        .get("secret")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let mut next = ControllerConfig {
        host: "127.0.0.1".to_string(),
        port: 9090,
        secret,
    };

    if !ext.is_empty() {
        // Typical values:
        // - 127.0.0.1:9090
        // - 0.0.0.0:9090
        // - :9090
        // - http://127.0.0.1:9090 (rare)
        let ext = ext.strip_prefix("http://").unwrap_or(ext);
        let ext = ext.strip_prefix("https://").unwrap_or(ext);

        if let Some((h, p)) = ext.rsplit_once(':') {
            if !h.trim().is_empty() {
                next.host = h.trim().to_string();
            }
            if let Ok(port) = p.trim().parse::<u16>() {
                next.port = port;
            }
        } else if let Ok(port) = ext.parse::<u16>() {
            next.port = port;
        }
    }

    if next.host == "0.0.0.0" || next.host == "::" {
        next.host = "127.0.0.1".to_string();
    }

    if let Ok(mut guard) = CONTROLLER_CONFIG.lock() {
        *guard = next;
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct MihomoTraffic {
    pub up: u64,
    pub down: u64,
}

#[cfg(target_os = "windows")]
fn has_admin_privileges() -> bool {
    use windows_sys::Win32::Security::{
        GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY,
    };
    use windows_sys::Win32::System::Threading::GetCurrentProcess;
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::OpenProcessToken;

    unsafe {
        let mut token_handle = 0;
        let current_process = GetCurrentProcess();

        if OpenProcessToken(current_process, TOKEN_QUERY, &mut token_handle) == 0 {
            return false;
        }

        let mut elevation: TOKEN_ELEVATION = std::mem::zeroed();
        let mut size: u32 = 0;

        let success = GetTokenInformation(
            token_handle,
            TokenElevation,
            &mut elevation as *mut _ as *mut _,
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut size,
        );

        let is_elevated = success != 0 && elevation.TokenIsElevated != 0;
        CloseHandle(token_handle);
        is_elevated
    }
}

#[cfg(not(target_os = "windows"))]
fn has_admin_privileges() -> bool {
    nix::unistd::geteuid().is_root()
}

// pub fn is_elevated() -> bool {
//     has_admin_privileges()
// }

// Проверка существующих процессов mihomo
#[cfg(target_os = "windows")]
fn kill_existing_mihomo() {
    use std::process::Command;

    use std::os::windows::process::CommandExt;

    let _ = Command::new("taskkill")
        .args(["/F", "/IM", get_binary_name()])
        .creation_flags(0x08000000)
        .output();
}

#[cfg(target_os = "linux")]
fn kill_existing_mihomo() {
    use std::process::Command;
    let _ = Command::new("pkill")
        .arg("-9")
        .arg(get_binary_name())
        .output();
}

#[cfg(target_os = "macos")]
fn kill_existing_mihomo() {
    use std::process::Command;
    let _ = Command::new("pkill")
        .arg("-9")
        .arg(get_binary_name())
        .output();
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ProxyConfig {
    pub name: String,
    pub server: String,
    pub port: u16,
    #[serde(rename = "type")]
    pub proxy_type: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ParsedRule {
    pub rule_type: String,
    pub target: String,
    pub action: String,
    pub raw: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ParsedConfig {
    pub proxies: Vec<ProxyConfig>,
    pub proxy_name: Option<String>,
    pub server_address: Option<String>,
    pub mode: String,
    pub log_level: String,
    pub mixed_port: u16,
    pub rules: Vec<ParsedRule>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct UserRule {
    pub id: i64,
    pub app: String,
    pub rule: String,
    pub active: bool,
    #[serde(default = "default_rule_type")]
    pub rule_type: String,
}

fn default_rule_type() -> String {
    "process".to_string()
}

#[derive(Debug, Serialize, Deserialize)]
pub struct VpnStatus {
    pub running: bool,
    pub server: Option<String>,
    pub proxy_name: Option<String>,
    pub mode: String,
    pub port: u16,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LogEntry {
    pub time: String,
    pub level: String,
    pub message: String,
}

async fn mihomo_get_json<T: for<'de> Deserialize<'de>>(paths: &[&str]) -> Result<T, String> {
    let client = reqwest::Client::new();
    let cfg = CONTROLLER_CONFIG.lock().map_err(|e| e.to_string())?.clone();
    let mut last_err: Option<String> = None;

    for path in paths {
        let url = format!("http://{}:{}{}", cfg.host, cfg.port, path);
        let mut req = client.get(url);
        if let Some(secret) = &cfg.secret {
            req = req.header(reqwest::header::AUTHORIZATION, format!("Bearer {}", secret));
        }

        match req.send().await {
            Ok(resp) => {
                if !resp.status().is_success() {
                    last_err = Some(format!("HTTP {} for {}", resp.status(), path));
                    continue;
                }
                return resp.json::<T>().await.map_err(|e| e.to_string());
            }
            Err(e) => {
                last_err = Some(e.to_string());
            }
        }
    }

    Err(last_err.unwrap_or_else(|| "Failed to fetch mihomo controller".to_string()))
}

async fn mihomo_get_json_value(paths: &[&str]) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::new();
    let cfg = CONTROLLER_CONFIG.lock().map_err(|e| e.to_string())?.clone();
    let mut last_err: Option<String> = None;

    for path in paths {
        let url = format!("http://{}:{}{}", cfg.host, cfg.port, path);
        let mut req = client.get(url);
        if let Some(secret) = &cfg.secret {
            req = req.header(reqwest::header::AUTHORIZATION, format!("Bearer {}", secret));
        }

        match req.send().await {
            Ok(resp) => {
                if !resp.status().is_success() {
                    last_err = Some(format!("HTTP {} for {}", resp.status(), path));
                    continue;
                }

                let status = resp.status();
                let body = resp.text().await.map_err(|e| e.to_string())?;
                if body.trim().is_empty() {
                    return Ok(serde_json::json!({}));
                }
                match serde_json::from_str::<serde_json::Value>(&body) {
                    Ok(v) => return Ok(v),
                    Err(e) => {
                        let snippet: String = body.chars().take(300).collect();
                        last_err = Some(format!(
                            "Failed to decode JSON from {} (HTTP {}): {}. Body: {}",
                            path, status, e, snippet
                        ));
                    }
                }
            }
            Err(e) => {
                last_err = Some(e.to_string());
            }
        }
    }

    Err(last_err.unwrap_or_else(|| "Failed to fetch mihomo controller".to_string()))
}

fn value_to_u64(v: Option<&serde_json::Value>) -> u64 {
    match v {
        Some(serde_json::Value::Number(n)) => {
            if let Some(u) = n.as_u64() {
                u
            } else if let Some(i) = n.as_i64() {
                i.max(0) as u64
            } else if let Some(f) = n.as_f64() {
                if f.is_finite() && f > 0.0 { f.floor() as u64 } else { 0 }
            } else {
                0
            }
        }
        Some(serde_json::Value::String(s)) => s
            .parse::<f64>()
            .ok()
            .filter(|f| f.is_finite() && *f > 0.0)
            .map(|f| f.floor() as u64)
            .unwrap_or(0),
        _ => 0,
    }
}

#[tauri::command]
pub async fn mihomo_get_traffic() -> Result<MihomoTraffic, String> {
    let v = mihomo_get_json_value(&[
        "/v1/traffic",
        "/traffic",
    ])
    .await?;

    // Controllers differ across builds; accept numbers/strings/floats.
    let up = value_to_u64(v.get("up"));
    let down = value_to_u64(v.get("down"));

    Ok(MihomoTraffic { up, down })
}

#[tauri::command]
pub async fn mihomo_get_proxies() -> Result<serde_json::Value, String> {
    mihomo_get_json_value(&[
        "/v1/proxies",
        "/proxies",
    ])
    .await
}

#[tauri::command]
pub async fn mihomo_get_connections() -> Result<serde_json::Value, String> {
    mihomo_get_json_value(&[
        "/v1/connections",
        "/connections",
    ])
    .await
}

#[tauri::command]
pub async fn mihomo_get_delay(proxy_name: String) -> Result<serde_json::Value, String> {
    let encoded = urlencoding::encode(&proxy_name);
    let p1 = format!(
        "/v1/proxies/{}/delay?timeout=5000&url=https%3A%2F%2F1.1.1.1",
        encoded
    );
    let p2 = format!(
        "/proxies/{}/delay?timeout=5000&url=https%3A%2F%2F1.1.1.1",
        encoded
    );

    mihomo_get_json(&[p1.as_str(), p2.as_str()]).await
}

fn parse_ping_ms(output: &str) -> Option<u32> {
    let lower = output.to_lowercase();
    for marker in ["time=", "time<", "время=", "время<"] {
        if let Some(idx) = lower.find(marker) {
            let rest = &lower[idx + marker.len()..];
            let digits: String = rest.chars().skip_while(|c| !c.is_ascii_digit()).take_while(|c| c.is_ascii_digit()).collect();
            if let Ok(v) = digits.parse::<u32>() {
                return Some(v.max(1));
            }
        }
    }
    None
}

#[tauri::command(rename_all = "camelCase")]
pub async fn ping_host(host: String) -> Result<Option<u32>, String> {
    let host = host.trim().to_string();
    if host.is_empty() {
        return Ok(None);
    }
    if host.chars().any(|c| c.is_whitespace()) {
        return Err("Invalid host".to_string());
    }

    let mut cmd = if cfg!(target_os = "windows") {
        let mut c = Command::new("ping");
        c.args(["-n", "1", "-w", "1000", &host]);
        c
    } else {
        let mut c = Command::new("ping");
        c.args(["-c", "1", "-W", "1", &host]);
        c
    };

    #[cfg(target_os = "windows")]
    {
        // CREATE_NO_WINDOW
        cmd.creation_flags(0x08000000);
    }

    let out = cmd.output().map_err(|e| format!("Failed to run ping: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    let combined = format!("{}\n{}", stdout, stderr);

    Ok(parse_ping_ms(&combined))
}

fn get_mihomo_path(app: &AppHandle) -> PathBuf {
    let locations = vec![
        app.path().resource_dir().ok().map(|p| p.join("bin").join(get_binary_name())),
        app.path().app_local_data_dir().ok().map(|p| p.join(get_binary_name())),
        app.path().app_config_dir().ok().map(|p| p.join(get_binary_name())),
        std::env::current_exe().ok().and_then(|p| p.parent().map(|p| p.join(get_binary_name()))),
    ];

    for loc in locations.into_iter().flatten() {
        if loc.exists() {
            return loc;
        }
    }
    app.path().resource_dir().unwrap_or_default().join("bin").join(get_binary_name())
}

#[cfg(target_os = "windows")]
fn get_binary_name() -> &'static str { "mihomo-windows.exe" }

#[cfg(target_os = "macos")]
fn get_binary_name() -> &'static str { "mihomo-darwin-amd64" }

#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
fn get_binary_name() -> &'static str { "mihomo-linux-amd64" }

#[tauri::command]
pub fn get_mihomo_binary_name() -> String {
    get_binary_name().to_string()
}

fn primary_config_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .app_config_dir()
        .or_else(|_| app.path().app_local_data_dir())
        .unwrap_or_else(|_| std::env::temp_dir().join("Rododendron"))
}

fn all_config_dirs(app: &AppHandle) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();

    let primary = primary_config_dir(app);
    dirs.push(primary.clone());

    if let Ok(local) = app.path().app_local_data_dir() {
        if local != primary {
            dirs.push(local);
        }
    }

    if let Ok(cur) = std::env::current_dir() {
        if cur != primary {
            dirs.push(cur);
        }
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let p = parent.to_path_buf();
            if p != primary {
                dirs.push(p);
            }
        }
    }

    dirs
}

fn find_existing_config_path(app: &AppHandle, filename: &str) -> Option<PathBuf> {
    for dir in all_config_dirs(app) {
        let p = dir.join(filename);
        if p.exists() {
            return Some(p);
        }
    }
    None
}

#[tauri::command(rename_all = "camelCase")]
pub fn resolve_config_path(app: AppHandle, filename: String) -> Result<Option<String>, String> {
    Ok(find_existing_config_path(&app, &filename).map(|p| p.to_string_lossy().to_string()))
}

#[tauri::command(rename_all = "camelCase")]
pub fn parse_config(config_content: String) -> Result<ParsedConfig, String> {
    let yaml: serde_yaml::Value = serde_yaml::from_str(&config_content)
        .map_err(|e| format!("Failed to parse YAML: {}", e))?;

    let mut proxies = Vec::new();
    let mut proxy_name = None;
    let mut server_address = None;

    if let Some(proxy_list) = yaml.get("proxies").and_then(|p| p.as_sequence()) {
        for proxy in proxy_list {
            if let (Some(name), Some(server), Some(port), Some(ptype)) = (
                proxy.get("name").and_then(|v| v.as_str()),
                proxy.get("server").and_then(|v| v.as_str()),
                proxy.get("port").and_then(|v| v.as_u64()),
                proxy.get("type").and_then(|v| v.as_str()),
            ) {
                if proxy_name.is_none() {
                    proxy_name = Some(name.to_string());
                    server_address = Some(server.to_string());
                }
                proxies.push(ProxyConfig {
                    name: name.to_string(),
                    server: server.to_string(),
                    port: port as u16,
                    proxy_type: ptype.to_string(),
                });
            }
        }
    }

    let mode = yaml.get("mode")
        .and_then(|v| v.as_str())
        .unwrap_or("rule")
        .to_string();

    let log_level = yaml.get("log-level")
        .and_then(|v| v.as_str())
        .unwrap_or("info")
        .to_string();

    let mixed_port = yaml.get("mixed-port")
        .and_then(|v| v.as_u64())
        .unwrap_or(7890) as u16;

    let mut rules = Vec::new();
    if let Some(rule_list) = yaml.get("rules").and_then(|r| r.as_sequence()) {
        for (idx, rule) in rule_list.iter().enumerate() {
            if let Some(rule_str) = rule.as_str() {
                if let Some(parsed) = parse_rule_string(rule_str, idx) {
                    rules.push(parsed);
                }
            }
        }
    }

    Ok(ParsedConfig {
        proxies,
        proxy_name,
        server_address,
        mode,
        log_level,
        mixed_port,
        rules,
    })
}

fn parse_rule_string(rule_str: &str, _idx: usize) -> Option<ParsedRule> {
    let parts: Vec<&str> = rule_str.split(',').collect();
    if parts.len() < 3 {
        return None;
    }

    let rule_type_str = parts[0].trim();
    let target = parts[1].trim().to_string();
    let action = parts[2].trim().to_string();

    if rule_type_str == "MATCH" {
        return None;
    }
    

    let rule_type = match rule_type_str {
        "PROCESS-NAME" => "process",
        "DOMAIN" => "domain",
        "DOMAIN-SUFFIX" => "domain",
        "DOMAIN-KEYWORD" => "domain_keyword",
        "IP-CIDR" | "IP-CIDR6" => "ip",
        "GEOIP" => "ip",
        _ => "other",
    }.to_string();

    Some(ParsedRule {
        rule_type,
        target,
        action,
    })
}

#[tauri::command(rename_all = "camelCase")]
pub fn generate_config(
    base_config: String,
    user_rules: Vec<UserRule>,
    log_level: String,
    enable_tun: bool,
    mtu: Option<u32>,
    kill_switch: bool,
) -> Result<String, String> {
    let _ = kill_switch;
    let mut yaml: serde_yaml::Value = serde_yaml::from_str(&base_config)
        .map_err(|e| format!("Failed to parse YAML: {}", e))?;

    yaml["log-level"] = serde_yaml::Value::String(log_level.to_lowercase());
    // ... (rest of the code remains the same)

    let mut profile = serde_yaml::Mapping::new();
    profile.insert("store-selected".into(), serde_yaml::Value::Bool(true));
    yaml["profile"] = serde_yaml::Value::Mapping(profile);
    
    if !user_rules.is_empty() {
        let mut rules = Vec::new();
        for rule in user_rules.iter().filter(|r| r.active) {
            let target = if rule.rule == "Via VPN" { "PROXY" } else { "DIRECT" };
            let rule_str = match rule.rule_type.as_str() {
                "process" => format!("PROCESS-NAME,{},{}", rule.app, target),
                "domain" => format!("DOMAIN,{},{}", rule.app, target),
                "domain_keyword" => format!("DOMAIN-KEYWORD,{},{}", rule.app, target),
                "ip" => format!("IP-CIDR,{}/32,{}", rule.app, target),
                _ => format!("PROCESS-NAME,{},{}", rule.app, target),
            };
            rules.push(serde_yaml::Value::String(rule_str));
        }

        rules.push(serde_yaml::Value::String("MATCH,PROXY".to_string()));

        yaml["rules"] = serde_yaml::Value::Sequence(rules);
    }

    // Keep existing tun config if present, only toggle enable + optional MTU.
    let mut tun = serde_yaml::Mapping::new();
    tun.insert("enable".into(), serde_yaml::Value::Bool(enable_tun));
    if let Some(mtu) = mtu {
        tun.insert(
            "mtu".into(),
            serde_yaml::Value::Number(serde_yaml::Number::from(mtu)),
        );
    }

    tun.insert(
        "auto-detect-interface".into(),
        serde_yaml::Value::Bool(true),
    );
    tun.insert("stack".into(), serde_yaml::Value::String("gvisor".to_string()));
    tun.insert("auto-route".into(), serde_yaml::Value::Bool(true));
    tun.insert("device".into(), serde_yaml::Value::String("Mihomo".to_string()));
    tun.insert(
        "dns-hijack".into(),
        serde_yaml::Value::Sequence(vec![serde_yaml::Value::String("any:53".to_string())]),
    );
    yaml["tun"] = serde_yaml::Value::Mapping(tun);

    serde_yaml::to_string(&yaml).map_err(|e| format!("Failed to serialize YAML: {}", e))
}

#[tauri::command(rename_all = "camelCase")]
pub async fn import_config(app: AppHandle, config_content: String, filename: String) -> Result<String, String> {
    let config_dir = primary_config_dir(&app);
    fs::create_dir_all(&config_dir)
        .map_err(|e| format!("Failed to create config dir: {}", e))?;
    let config_path = config_dir.join(&filename);

    let content_to_write = match serde_yaml::from_str::<serde_yaml::Value>(&config_content) {
        Ok(mut yaml) => {
            let mut did_rewrite = false;
            if let Some(seq) = yaml.get_mut("rules").and_then(|r| r.as_sequence_mut()) {
                if let Some(last) = seq.last_mut() {
                    if let Some(s) = last.as_str() {
                        if s.trim() == "MATCH,DIRECT" {
                            *last = serde_yaml::Value::String("MATCH,PROXY".to_string());
                            did_rewrite = true;
                        }
                    }
                }
            }

            if did_rewrite {
                serde_yaml::to_string(&yaml).unwrap_or(config_content)
            } else {
                config_content
            }
        }
        Err(_) => config_content,
    };

    fs::write(&config_path, &content_to_write)
        .map_err(|e| format!("Failed to save config: {}", e))?;
    Ok(config_path.to_string_lossy().to_string())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn save_rules_to_config(app: AppHandle, filename: String, user_rules: Vec<UserRule>) -> Result<(), String> {
    if user_rules.is_empty() {
        return Ok(());
    }

    let config_path = find_existing_config_path(&app, &filename)
        .unwrap_or_else(|| primary_config_dir(&app).join(&filename));

    let content = fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read config: {}", e))?;
    let mut yaml: serde_yaml::Value = serde_yaml::from_str(&content)
        .map_err(|e| format!("Failed to parse YAML: {}", e))?;

    let mut rules = Vec::new();
    for rule in user_rules.iter().filter(|r| r.active) {
        let target = if rule.rule == "Via VPN" { "PROXY" } else { "DIRECT" };
        let rule_str = match rule.rule_type.as_str() {
            "process" => format!("PROCESS-NAME,{},{}", rule.app, target),
            "domain" => format!("DOMAIN,{},{}", rule.app, target),
            "domain_keyword" => format!("DOMAIN-KEYWORD,{},{}", rule.app, target),
            "ip" => format!("IP-CIDR,{}/32,{}", rule.app, target),
            _ => format!("PROCESS-NAME,{},{}", rule.app, target),
        };
        rules.push(serde_yaml::Value::String(rule_str));
    }

    rules.push(serde_yaml::Value::String("MATCH,PROXY".to_string()));

    yaml["rules"] = serde_yaml::Value::Sequence(rules);

    let new_content = serde_yaml::to_string(&yaml)
        .map_err(|e| format!("Failed to serialize YAML: {}", e))?;
    fs::write(&config_path, new_content)
        .map_err(|e| format!("Failed to write config: {}", e))?;
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn save_rules_to_path(path: String, user_rules: Vec<UserRule>) -> Result<(), String> {
    if user_rules.is_empty() {
        return Ok(());
    }

    let config_path = PathBuf::from(path);

    let content = fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read config: {}", e))?;
    // ... (rest of the code remains the same)
    let mut yaml: serde_yaml::Value = serde_yaml::from_str(&content)
        .map_err(|e| format!("Failed to parse YAML: {}", e))?;

    let mut rules = Vec::new();
    for rule in user_rules.iter().filter(|r| r.active) {
        let target = if rule.rule == "Via VPN" { "PROXY" } else { "DIRECT" };
        let rule_str = match rule.rule_type.as_str() {
            "process" => format!("PROCESS-NAME,{},{}", rule.app, target),
            "domain" => format!("DOMAIN,{},{}", rule.app, target),
            "domain_keyword" => format!("DOMAIN-KEYWORD,{},{}", rule.app, target),
            "ip" => format!("IP-CIDR,{}/32,{}", rule.app, target),
            _ => format!("PROCESS-NAME,{},{}", rule.app, target),
        };
        rules.push(serde_yaml::Value::String(rule_str));
    }

    rules.push(serde_yaml::Value::String("MATCH,PROXY".to_string()));

    yaml["rules"] = serde_yaml::Value::Sequence(rules);

    let new_content = serde_yaml::to_string(&yaml)
        .map_err(|e| format!("Failed to serialize YAML: {}", e))?;
    fs::write(&config_path, new_content)
        .map_err(|e| format!("Failed to write config: {}", e))?;
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub fn export_config_to_path(app: AppHandle, filename: String, path: String) -> Result<(), String> {
    let src_path = find_existing_config_path(&app, &filename)
        .ok_or_else(|| format!("Config file not found: {}", filename))?;

    let content = fs::read_to_string(&src_path)
        .map_err(|e| format!("Failed to read config {}: {}", filename, e))?;

    let dst_path = PathBuf::from(path);
    fs::write(&dst_path, content)
        .map_err(|e| format!("Failed to export config to {:?}: {}", dst_path, e))?;
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn start_vpn(
    app: AppHandle,
    config_content: String,
    config_filename: String,
    enable_tun: bool,
) -> Result<VpnStatus, String> {
    #[cfg(not(target_os = "windows"))]
    {
        if enable_tun && !has_admin_privileges() {
            return Err("TUN requires elevated privileges on this OS. Please disable TUN in settings or run the app with sudo/root.".to_string());
        }
    }

    let _ = enable_tun;
    // Убиваем все существующие процессы mihomo
    kill_existing_mihomo();
    
    // Небольшая задержка для завершения процессов
    thread::sleep(std::time::Duration::from_millis(500));
    
    let mut process_guard = MIHOMO_PROCESS.lock().map_err(|e| e.to_string())?;

    if let Some(mut child) = process_guard.take() {
        let _ = child.kill();
        let _ = child.wait();
    }

    let mihomo_path = get_mihomo_path(&app);
    if !mihomo_path.exists() {
        return Err(format!("Mihomo binary not found at: {:?}", mihomo_path));
    }

    let config_dir = primary_config_dir(&app);
    fs::create_dir_all(&config_dir).map_err(|e| format!("Failed to create config dir: {}", e))?;

    let config_path = config_dir.join(&config_filename);
    fs::write(&config_path, &config_content)
        .map_err(|e| format!("Failed to write config: {}", e))?;

    let log_path = config_dir.join("mihomo.log");
    let _ = fs::remove_file(&log_path);

    #[cfg(target_os = "windows")]
    {
        if !has_admin_privileges() {
            return Err("This application needs to run with administrator privileges to function properly as a VPN. Please run the application as administrator.".to_string());
        }
    }

    let mut cmd = Command::new(&mihomo_path);
    cmd.arg("-d")
        .arg(&config_dir)
        .arg("-f")
        .arg(&config_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        // CREATE_NO_WINDOW
        cmd.creation_flags(0x08000000);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start mihomo: {}", e))?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    spawn_log_reader(stdout, stderr, log_path);

    *process_guard = Some(child);

    update_controller_config(&config_content);

    let parsed = parse_config(config_content)?;
    Ok(VpnStatus {
        running: true,
        server: parsed.server_address,
        proxy_name: parsed.proxy_name,
        mode: parsed.mode,
        port: parsed.mixed_port,
    })
}

fn spawn_log_reader(
    stdout: Option<std::process::ChildStdout>,
    stderr: Option<std::process::ChildStderr>,
    log_path: PathBuf,
) {
    thread::spawn(move || {
        let log_file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path);

        if log_file.is_err() {
            eprintln!("Failed to open log file");
            return;
        }

        let mut log_file = log_file.unwrap();

        if let Some(stdout) = stdout {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                if let Ok(line) = line {
                    let _ = writeln!(log_file, "{}", line);
                    let _ = log_file.flush();
                }
            }
        }

        if let Some(stderr) = stderr {
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                if let Ok(line) = line {
                    let _ = writeln!(log_file, "{}", line);
                    let _ = log_file.flush();
                }
            }
        }
    });
}

#[tauri::command]
pub async fn stop_vpn() -> Result<VpnStatus, String> {
    let mut process_guard = MIHOMO_PROCESS.lock().map_err(|e| e.to_string())?;

    if let Some(mut child) = process_guard.take() {
        child.kill().map_err(|e| format!("Failed to kill mihomo: {}", e))?;
        let _ = child.wait();
    }
    
    // Дополнительная проверка на случай зависших процессов
    kill_existing_mihomo();

    Ok(VpnStatus {
        running: false,
        server: None,
        proxy_name: None,
        mode: "rule".to_string(),
        port: 7890,
    })
}

#[tauri::command]
pub fn get_vpn_status() -> Result<VpnStatus, String> {
    let process_guard = MIHOMO_PROCESS.lock().map_err(|e| e.to_string())?;
    let running = process_guard.is_some();
    Ok(VpnStatus {
        running,
        server: None,
        proxy_name: None,
        mode: "rule".to_string(),
        port: 7890,
    })
}

#[tauri::command]
pub fn get_mihomo_logs(app: AppHandle) -> Result<Vec<LogEntry>, String> {
    let config_dir = primary_config_dir(&app);
    let log_path = config_dir.join("mihomo.log");
    
    if !log_path.exists() {
        return Ok(vec![]);
    }

    let content = fs::read_to_string(&log_path)
        .map_err(|e| format!("Failed to read logs: {}", e))?;

    let mut logs = Vec::new();
    for line in content.lines().rev().take(200) {
        if line.trim().is_empty() {
            continue;
        }
        
        let parts: Vec<&str> = line.splitn(3, ' ').collect();
        if parts.len() >= 3 {
            let level = parts[1].trim_matches(|c| c == '[' || c == ']').to_uppercase();
            logs.push(LogEntry {
                time: parts[0].to_string(),
                level,
                message: parts[2..].join(" "),
            });
        } else {
            logs.push(LogEntry {
                time: chrono::Local::now().format("%H:%M:%S").to_string(),
                level: "INFO".to_string(),
                message: line.to_string(),
            });
        }
    }
    Ok(logs)
}

#[tauri::command]
pub fn clear_mihomo_logs(app: AppHandle) -> Result<(), String> {
    let config_dir = primary_config_dir(&app);
    let log_path = config_dir.join("mihomo.log");

    if !log_path.exists() {
        return Ok(());
    }

    fs::write(&log_path, "").map_err(|e| format!("Failed to clear logs: {}", e))?;
    Ok(())
}

#[tauri::command]
pub fn list_configs(app: AppHandle) -> Result<Vec<String>, String> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut out: Vec<String> = Vec::new();

    for config_dir in all_config_dirs(&app) {
        if !config_dir.exists() {
            continue;
        }

        let iter = match fs::read_dir(&config_dir) {
            Ok(v) => v,
            Err(_) => continue,
        };

        for entry in iter.flatten() {
            let path = entry.path();
            let ext = match path.extension().and_then(|e| e.to_str()) {
                Some(v) => v,
                None => continue,
            };

            if !ext.eq_ignore_ascii_case("yaml") && !ext.eq_ignore_ascii_case("yml") {
                continue;
            }

            let name = match path.file_name() {
                Some(v) => v.to_string_lossy().to_string(),
                None => continue,
            };

            if seen.insert(name.clone()) {
                out.push(name);
            }
        }
    }

    out.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
    Ok(out)
}

#[tauri::command]
pub fn read_config(app: AppHandle, filename: String) -> Result<String, String> {
    if let Some(config_path) = find_existing_config_path(&app, &filename) {
        return fs::read_to_string(&config_path)
            .map_err(|e| format!("Failed to read config {}: {}", filename, e));
    }

    let attempted: Vec<String> = all_config_dirs(&app)
        .into_iter()
        .map(|d| d.join(&filename).to_string_lossy().to_string())
        .collect();

    Err(format!(
        "Config file not found: {}. Attempted: {}",
        filename,
        attempted.join("; ")
    ))
}

#[tauri::command]
pub fn delete_config(app: AppHandle, filename: String) -> Result<(), String> {
    if let Some(config_path) = find_existing_config_path(&app, &filename) {
        return fs::remove_file(&config_path)
            .map_err(|e| format!("Failed to delete config {}: {}", filename, e));
    }
    Ok(())
}