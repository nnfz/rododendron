use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

static MIHOMO_PROCESS: Mutex<Option<Child>> = Mutex::new(None);

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
    pub rule_type: String,  // "process", "domain", "domain_keyword", "ip", "other"
    pub target: String,
    pub action: String,     // "PROXY" or "DIRECT"
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

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct UserRule {
    pub id: i64,
    pub app: String,
    pub rule: String,       // "Via VPN" or "Direct"
    pub active: bool,
    pub rule_type: String,  // "process", "domain", "domain_keyword", "ip"
}

#[derive(Debug, Serialize, Deserialize)]
pub struct VpnStatus {
    pub running: bool,
    pub server: Option<String>,
    pub proxy_name: Option<String>,
    pub mode: String,
    pub port: u16,
}

fn get_mihomo_path(app: &AppHandle) -> PathBuf {
    // Try multiple locations
    let locations = vec![
        // Resource dir (bundled)
        app.path().resource_dir().ok().map(|p| p.join("bin").join(get_binary_name())),
        // App local data dir
        app.path().app_local_data_dir().ok().map(|p| p.join(get_binary_name())),
        // Config dir
        app.path().app_config_dir().ok().map(|p| p.join(get_binary_name())),
        // Current exe dir
        std::env::current_exe().ok().and_then(|p| p.parent().map(|p| p.join(get_binary_name()))),
    ];
    
    for loc in locations.into_iter().flatten() {
        if loc.exists() {
            return loc;
        }
    }
    
    // Default fallback
    app.path().resource_dir().unwrap_or_default().join("bin").join(get_binary_name())
}

#[cfg(target_os = "windows")]
fn get_binary_name() -> &'static str {
    "mihomo.exe"
}

#[cfg(not(target_os = "windows"))]
fn get_binary_name() -> &'static str {
    "mihomo"
}

fn get_config_dir(app: &AppHandle) -> PathBuf {
    app.path().app_config_dir().unwrap_or_else(|_| PathBuf::from("."))
}

/// Parse a YAML config file and extract relevant info
#[tauri::command]
pub fn parse_config(config_content: String) -> Result<ParsedConfig, String> {
    let yaml: serde_yaml::Value = serde_yaml::from_str(&config_content)
        .map_err(|e| format!("Failed to parse YAML: {}", e))?;
    
    let mut proxies = Vec::new();
    let mut proxy_name = None;
    let mut server_address = None;
    
    // Extract proxies
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
    
    // Parse rules
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
    
    // Skip MATCH rule (it's the default fallback)
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
        raw: rule_str.to_string(),
    })
}

/// Generate final config with user rules merged
#[tauri::command]
pub fn generate_config(
    base_config: String,
    user_rules: Vec<UserRule>,
    log_level: String,
) -> Result<String, String> {
    let mut yaml: serde_yaml::Value = serde_yaml::from_str(&base_config)
        .map_err(|e| format!("Failed to parse YAML: {}", e))?;
    
    // Update log level
    yaml["log-level"] = serde_yaml::Value::String(log_level.to_lowercase());
    
    // Build rules array from user rules only
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
    
    // Add MATCH,DIRECT at the end
    rules.push(serde_yaml::Value::String("MATCH,DIRECT".to_string()));
    
    yaml["rules"] = serde_yaml::Value::Sequence(rules);
    
    // Enable external controller for API
    yaml["external-controller"] = serde_yaml::Value::String("127.0.0.1:9090".to_string());
    
    serde_yaml::to_string(&yaml)
        .map_err(|e| format!("Failed to serialize YAML: {}", e))
}

/// Save rules to config file (overwrites rules section)
#[tauri::command]
pub async fn save_rules_to_config(
    app: AppHandle,
    filename: String,
    user_rules: Vec<UserRule>,
) -> Result<(), String> {
    let config_dir = get_config_dir(&app);
    let config_path = config_dir.join(&filename);
    
    // Read existing config
    let content = fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read config: {}", e))?;
    
    let mut yaml: serde_yaml::Value = serde_yaml::from_str(&content)
        .map_err(|e| format!("Failed to parse YAML: {}", e))?;
    
    // Build new rules array
    let mut rules = Vec::new();
    
    for rule in user_rules.iter() {
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
    
    // Add MATCH,DIRECT at the end
    rules.push(serde_yaml::Value::String("MATCH,DIRECT".to_string()));
    
    yaml["rules"] = serde_yaml::Value::Sequence(rules);
    
    // Write back
    let new_content = serde_yaml::to_string(&yaml)
        .map_err(|e| format!("Failed to serialize YAML: {}", e))?;
    
    fs::write(&config_path, new_content)
        .map_err(|e| format!("Failed to write config: {}", e))?;
    
    Ok(())
}

/// Import config file and save to app directory
#[tauri::command]
pub async fn import_config(app: AppHandle, config_content: String, filename: String) -> Result<String, String> {
    let config_dir = get_config_dir(&app);
    fs::create_dir_all(&config_dir)
        .map_err(|e| format!("Failed to create config dir: {}", e))?;
    
    let config_path = config_dir.join(&filename);
    fs::write(&config_path, &config_content)
        .map_err(|e| format!("Failed to save config: {}", e))?;
    
    Ok(config_path.to_string_lossy().to_string())
}

/// Start mihomo with the active config
#[tauri::command]
pub async fn start_vpn(app: AppHandle, config_content: String) -> Result<VpnStatus, String> {
    let mut process_guard = MIHOMO_PROCESS.lock().map_err(|e| e.to_string())?;
    
    // Stop existing process if running
    if let Some(mut child) = process_guard.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    
    let mihomo_path = get_mihomo_path(&app);
    if !mihomo_path.exists() {
        // List where we looked
        let search_paths = vec![
            app.path().resource_dir().ok().map(|p| p.join("bin").join(get_binary_name())),
            app.path().app_local_data_dir().ok().map(|p| p.join(get_binary_name())),
            app.path().app_config_dir().ok().map(|p| p.join(get_binary_name())),
        ];
        let searched: Vec<String> = search_paths.into_iter()
            .flatten()
            .map(|p| p.to_string_lossy().to_string())
            .collect();
        
        return Err(format!(
            "Mihomo not found. Place {} in one of:\n{}",
            get_binary_name(),
            searched.join("\n")
        ));
    }
    
    // Save active config
    let config_dir = get_config_dir(&app);
    let config_path = config_dir.join("active-config.yaml");
    
    fs::create_dir_all(&config_dir)
        .map_err(|e| format!("Failed to create config dir: {}", e))?;
    fs::write(&config_path, &config_content)
        .map_err(|e| format!("Failed to write config: {}", e))?;
    
    // Start mihomo
    let child = Command::new(&mihomo_path)
        .arg("-d")
        .arg(&config_dir)
        .arg("-f")
        .arg(&config_path)
        .spawn()
        .map_err(|e| format!("Failed to start mihomo: {}. Path: {:?}", e, mihomo_path))?;
    
    *process_guard = Some(child);
    
    // Parse config for status
    let parsed = parse_config(config_content)?;
    
    Ok(VpnStatus {
        running: true,
        server: parsed.server_address,
        proxy_name: parsed.proxy_name,
        mode: parsed.mode,
        port: parsed.mixed_port,
    })
}

/// Stop mihomo
#[tauri::command]
pub async fn stop_vpn() -> Result<VpnStatus, String> {
    let mut process_guard = MIHOMO_PROCESS.lock().map_err(|e| e.to_string())?;
    
    if let Some(mut child) = process_guard.take() {
        child.kill().map_err(|e| format!("Failed to stop mihomo: {}", e))?;
        let _ = child.wait();
    }
    
    Ok(VpnStatus {
        running: false,
        server: None,
        proxy_name: None,
        mode: "rule".to_string(),
        port: 7890,
    })
}

/// Get current VPN status
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

/// List saved configs
#[tauri::command]
pub fn list_configs(app: AppHandle) -> Result<Vec<String>, String> {
    let config_dir = get_config_dir(&app);
    
    if !config_dir.exists() {
        return Ok(vec![]);
    }
    
    let configs: Vec<String> = fs::read_dir(&config_dir)
        .map_err(|e| e.to_string())?
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let path = entry.path();
            let ext = path.extension()?.to_str()?;
            if ext == "yaml" || ext == "yml" {
                Some(path.file_name()?.to_string_lossy().to_string())
            } else {
                None
            }
        })
        .collect();
    
    Ok(configs)
}

/// Read a saved config
#[tauri::command]
pub fn read_config(app: AppHandle, filename: String) -> Result<String, String> {
    let config_path = get_config_dir(&app).join(&filename);
    fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read config: {}", e))
}

/// Delete a saved config
#[tauri::command]
pub fn delete_config(app: AppHandle, filename: String) -> Result<(), String> {
    let config_path = get_config_dir(&app).join(&filename);
    fs::remove_file(&config_path)
        .map_err(|e| format!("Failed to delete config: {}", e))
}