use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::collections::HashSet;
use std::fs;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::thread;
use tauri::{AppHandle, Manager};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

// ─── Константы ───────────────────────────────────────────────────────────────

const MAX_LOG_SIZE: u64 = 10 * 1024 * 1024;
const LOG_TAIL_BYTES: u64 = 64 * 1024;
const MAX_LOG_ENTRIES: usize = 200;
const LOG_SIZE_CHECK_INTERVAL: u64 = 2000;
const MIHOMO_READY_TIMEOUT_SECS: u64 = 10;
const LOG_DIAG_LINES: usize = 10;

// ─── Глобальное состояние ────────────────────────────────────────────────────

static MIHOMO_PROCESS: Mutex<Option<Child>> = Mutex::new(None);

static CONTROLLER_CONFIG: LazyLock<Mutex<ControllerConfig>> = LazyLock::new(|| {
    Mutex::new(ControllerConfig {
        host: String::from("127.0.0.1"),
        port: 9090,
        secret: None,
    })
});

static HTTP_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
});

static START_TIME: Mutex<Option<std::time::Instant>> = Mutex::new(None);

// ─── Внутренние типы ─────────────────────────────────────────────────────────

#[derive(Clone)]
struct ControllerConfig {
    host: String,
    port: u16,
    secret: Option<String>,
}

// ─── Публичные типы ──────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct MihomoTraffic {
    pub up: u64,
    pub down: u64,
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

#[derive(Debug, Serialize, Deserialize)]
pub struct HealthStatus {
    pub mihomo_running: bool,
    pub mihomo_responsive: bool,
    pub pid: Option<u32>,
    pub uptime_secs: Option<u64>,
    pub log_size_bytes: u64,
    pub config_loaded: bool,
}

// ─── Конфигурация контроллера ────────────────────────────────────────────────

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

// ─── Платформо-зависимый код ─────────────────────────────────────────────────

#[cfg(target_os = "windows")]
#[allow(dead_code)]
fn has_admin_privileges() -> bool {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::Security::{
        GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

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

#[cfg(target_os = "windows")]
fn kill_existing_mihomo() {
    let _ = Command::new("taskkill")
        .args(["/F", "/IM", get_binary_name()])
        .creation_flags(0x08000000)
        .output();
}

#[cfg(target_os = "linux")]
fn kill_existing_mihomo() {
    let _ = Command::new("pkill")
        .arg("-9")
        .arg(get_binary_name())
        .output();
}

#[cfg(target_os = "macos")]
fn kill_existing_mihomo() {
    let _ = Command::new("pkill")
        .arg("-9")
        .arg(get_binary_name())
        .output();
}

#[cfg(target_os = "windows")]
fn get_binary_name() -> &'static str {
    "mihomo-windows.exe"
}

#[cfg(target_os = "macos")]
fn get_binary_name() -> &'static str {
    "mihomo-darwin-amd64"
}

#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
fn get_binary_name() -> &'static str {
    "mihomo-linux-amd64"
}

// ─── Утилиты путей ──────────────────────────────────────────────────────────

fn get_mihomo_path(app: &AppHandle) -> PathBuf {
    let locations = vec![
        app.path()
            .resource_dir()
            .ok()
            .map(|p| p.join("bin").join(get_binary_name())),
        app.path()
            .app_local_data_dir()
            .ok()
            .map(|p| p.join(get_binary_name())),
        app.path()
            .app_config_dir()
            .ok()
            .map(|p| p.join(get_binary_name())),
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|p| p.join(get_binary_name()))),
    ];

    for loc in locations.into_iter().flatten() {
        if loc.exists() {
            return loc;
        }
    }

    app.path()
        .resource_dir()
        .unwrap_or_default()
        .join("bin")
        .join(get_binary_name())
}

fn primary_config_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .app_config_dir()
        .or_else(|_| app.path().app_local_data_dir())
        .unwrap_or_else(|_| std::env::temp_dir().join("Rododendron"))
}

fn all_config_dirs(app: &AppHandle) -> Vec<PathBuf> {
    let primary = primary_config_dir(app);
    let mut dirs: Vec<PathBuf> = vec![primary.clone()];

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
    all_config_dirs(app)
        .iter()
        .map(|dir| dir.join(filename))
        .find(|p| p.exists())
}

// ─── Бэкап конфигов ─────────────────────────────────────────────────────────

fn backup_config(path: &PathBuf) -> Result<(), String> {
    if path.exists() {
        let backup = path.with_extension("yml.bak");
        fs::copy(path, &backup)
            .map_err(|e| format!("Failed to backup config: {}", e))?;
    }
    Ok(())
}

// ─── HTTP API (единый базовый метод) ─────────────────────────────────────────

async fn mihomo_request(
    method: reqwest::Method,
    paths: &[&str],
    body: Option<&serde_json::Value>,
) -> Result<reqwest::Response, String> {
    let cfg = CONTROLLER_CONFIG
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    let mut last_err: Option<String> = None;

    for path in paths {
        let url = format!("http://{}:{}{}", cfg.host, cfg.port, path);
        let mut req = HTTP_CLIENT.request(method.clone(), &url);

        if let Some(secret) = &cfg.secret {
            req = req.header(
                reqwest::header::AUTHORIZATION,
                format!("Bearer {}", secret),
            );
        }

        if let Some(b) = body {
            req = req.json(b);
        }

        match req.send().await {
            Ok(resp) if resp.status().is_success() => return Ok(resp),
            Ok(resp) => {
                last_err = Some(format!("HTTP {} for {}", resp.status(), path));
            }
            Err(e) => {
                last_err = Some(e.to_string());
            }
        }
    }

    Err(last_err.unwrap_or_else(|| "All API endpoints failed".to_string()))
}

async fn mihomo_get_json<T: for<'de> Deserialize<'de>>(paths: &[&str]) -> Result<T, String> {
    let resp = mihomo_request(reqwest::Method::GET, paths, None).await?;
    resp.json::<T>().await.map_err(|e| e.to_string())
}

async fn mihomo_get_json_value(paths: &[&str]) -> Result<serde_json::Value, String> {
    let resp = mihomo_request(reqwest::Method::GET, paths, None).await?;
    let body = resp.text().await.map_err(|e| e.to_string())?;

    if body.trim().is_empty() {
        return Ok(serde_json::json!({}));
    }

    serde_json::from_str(&body).map_err(|e| {
        let snippet: String = body.chars().take(300).collect();
        format!("JSON parse error: {}. Body: {}", e, snippet)
    })
}

#[inline]
fn value_to_u64(v: Option<&serde_json::Value>) -> u64 {
    match v {
        Some(serde_json::Value::Number(n)) => n
            .as_u64()
            .or_else(|| n.as_i64().map(|i| i.max(0) as u64))
            .or_else(|| {
                n.as_f64().and_then(|f| {
                    if f.is_finite() && f > 0.0 {
                        Some(f.floor() as u64)
                    } else {
                        None
                    }
                })
            })
            .unwrap_or(0),
        Some(serde_json::Value::String(s)) => s
            .parse::<f64>()
            .ok()
            .filter(|f| f.is_finite() && *f > 0.0)
            .map(|f| f.floor() as u64)
            .unwrap_or(0),
        _ => 0,
    }
}

// ─── Диагностика: чтение хвоста лога ─────────────────────────────────────────

fn read_last_log_lines(app: &AppHandle, max_lines: usize) -> String {
    let log_path = primary_config_dir(app).join("mihomo.log");
    if !log_path.exists() {
        return String::new();
    }

    match fs::read_to_string(&log_path) {
        Ok(content) => {
            let lines: Vec<&str> = content
                .lines()
                .filter(|l| !l.trim().is_empty())
                .collect();
            let start = lines.len().saturating_sub(max_lines);
            lines[start..].join("\n")
        }
        Err(_) => String::new(),
    }
}

fn format_error_with_log(base_msg: &str, app: &AppHandle) -> String {
    let log_tail = read_last_log_lines(app, LOG_DIAG_LINES);
    if log_tail.is_empty() {
        base_msg.to_string()
    } else {
        format!("{}\n\nMihomo log:\n{}", base_msg, log_tail)
    }
}

/// Ожидание готовности mihomo после запуска
async fn wait_for_mihomo_ready(app: &AppHandle) -> Result<(), String> {
    let start = std::time::Instant::now();
    let timeout = std::time::Duration::from_secs(MIHOMO_READY_TIMEOUT_SECS);
    let delay = std::time::Duration::from_millis(300);

    loop {
        // Проверяем, не умер ли процесс раньше времени
        {
            if let Ok(mut guard) = MIHOMO_PROCESS.lock() {
                if let Some(ref mut child) = *guard {
                    if let Ok(Some(status)) = child.try_wait() {
                        let _ = guard.take();
                        // Даём логу записаться
                        std::thread::sleep(std::time::Duration::from_millis(200));
                        let msg = format!("Mihomo exited with status: {}", status);
                        return Err(format_error_with_log(&msg, app));
                    }
                }
            }
        }

        // Проверяем готовность API
        if mihomo_get_json_value(&["/configs"]).await.is_ok() {
            return Ok(());
        }

        // Проверяем таймаут
        if start.elapsed() >= timeout {
            return Err(format_error_with_log(
                "Mihomo did not become ready in time",
                app,
            ));
        }

        std::thread::sleep(delay);
    }
}

// ─── Ping ────────────────────────────────────────────────────────────────────

#[inline]
fn parse_ping_ms(output: &str) -> Option<u32> {
    let lower = output.to_lowercase();
    const MARKERS: &[&str] = &["time=", "time<", "время=", "время<"];

    for marker in MARKERS {
        if let Some(idx) = lower.find(marker) {
            let rest = &lower[idx + marker.len()..];
            let digits: String = rest
                .chars()
                .skip_while(|c| !c.is_ascii_digit())
                .take_while(|c| c.is_ascii_digit())
                .collect();
            if let Ok(v) = digits.parse::<u32>() {
                return Some(v.max(1));
            }
        }
    }
    None
}

// ─── Управление логами ──────────────────────────────────────────────────────

fn rotate_log_file(log_path: &PathBuf) {
    if let Ok(meta) = fs::metadata(log_path) {
        if meta.len() > MAX_LOG_SIZE {
            let backup = log_path.with_extension("log.old");
            let _ = fs::remove_file(&backup);
            let _ = fs::rename(log_path, &backup);
        }
    }
}

fn write_log_line(
    file: &Mutex<fs::File>,
    counter: &AtomicU64,
    log_path: &PathBuf,
    line: &str,
) {
    if let Ok(mut f) = file.lock() {
        let _ = writeln!(f, "{}", line);
        let _ = f.flush();

        let count = counter.fetch_add(1, Ordering::Relaxed) + 1;
        if count % LOG_SIZE_CHECK_INTERVAL == 0 {
            if let Ok(meta) = fs::metadata(log_path) {
                if meta.len() > MAX_LOG_SIZE {
                    let _ = f.set_len(0);
                    counter.store(0, Ordering::Relaxed);
                    let _ = writeln!(
                        f,
                        "[Log auto-rotated at {}]",
                        chrono::Local::now().format("%Y-%m-%d %H:%M:%S")
                    );
                }
            }
        }
    }
}

fn spawn_log_reader(
    stdout: Option<std::process::ChildStdout>,
    stderr: Option<std::process::ChildStderr>,
    log_path: PathBuf,
) {
    rotate_log_file(&log_path);

    let log_file = match fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
    {
        Ok(v) => Arc::new(Mutex::new(v)),
        Err(e) => {
            eprintln!("Failed to open log file: {}", e);
            return;
        }
    };

    let line_counter = Arc::new(AtomicU64::new(0));
    let log_path = Arc::new(log_path);

    if let Some(stdout) = stdout {
        let file = Arc::clone(&log_file);
        let counter = Arc::clone(&line_counter);
        let path = Arc::clone(&log_path);
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().flatten() {
                write_log_line(&file, &counter, &path, &line);
            }
        });
    }

    if let Some(stderr) = stderr {
        let file = Arc::clone(&log_file);
        let counter = Arc::clone(&line_counter);
        let path = Arc::clone(&log_path);
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().flatten() {
                write_log_line(&file, &counter, &path, &line);
            }
        });
    }
}

fn parse_log_line(line: &str) -> LogEntry {
    let parts: Vec<&str> = line.splitn(3, ' ').collect();
    if parts.len() >= 3 {
        LogEntry {
            time: parts[0].to_string(),
            level: parts[1]
                .trim_matches(|c| c == '[' || c == ']')
                .to_uppercase(),
            message: parts[2..].join(" "),
        }
    } else {
        LogEntry {
            time: chrono::Local::now().format("%H:%M:%S").to_string(),
            level: "INFO".to_string(),
            message: line.to_string(),
        }
    }
}

// ─── Парсинг конфигов ────────────────────────────────────────────────────────

fn parse_rule_string(rule_str: &str) -> Option<ParsedRule> {
    let parts: Vec<&str> = rule_str.split(',').collect();
    if parts.len() < 3 {
        return None;
    }

    let rule_type_str = parts[0].trim();
    if rule_type_str == "MATCH" {
        return None;
    }

    let target = parts[1].trim().to_string();
    let action = parts[2].trim().to_string();

    let rule_type = match rule_type_str {
        "PROCESS-NAME" => "process",
        "DOMAIN" | "DOMAIN-SUFFIX" => "domain",
        "DOMAIN-KEYWORD" => "domain_keyword",
        "IP-CIDR" | "IP-CIDR6" | "GEOIP" => "ip",
        _ => "other",
    }
    .to_string();

    Some(ParsedRule {
        rule_type,
        target,
        action,
        raw: rule_str.to_string(),
    })
}

fn build_rules_from_user_rules(user_rules: &[UserRule]) -> Vec<serde_yaml::Value> {
    let mut rules = Vec::with_capacity(user_rules.len() + 1);
    let mut any_active = false;

    for rule in user_rules.iter().filter(|r| r.active) {
        any_active = true;
        let target = if rule.rule == "Via VPN" {
            "PROXY"
        } else {
            "DIRECT"
        };
        let rule_str = match rule.rule_type.as_str() {
            "process" => format!("PROCESS-NAME,{},{}", rule.app, target),
            "domain" => format!("DOMAIN,{},{}", rule.app, target),
            "domain_keyword" => format!("DOMAIN-KEYWORD,{},{}", rule.app, target),
            "ip" => format!("IP-CIDR,{}/32,{}", rule.app, target),
            _ => format!("PROCESS-NAME,{},{}", rule.app, target),
        };
        rules.push(serde_yaml::Value::String(rule_str));
    }

    rules.push(serde_yaml::Value::String(
        if any_active {
            "MATCH,DIRECT"
        } else {
            "MATCH,PROXY"
        }
        .to_string(),
    ));
    rules
}

// ─── Валидация конфига ───────────────────────────────────────────────────────

fn validate_config(content: &str) -> Result<(), String> {
    let yaml: serde_yaml::Value =
        serde_yaml::from_str(content).map_err(|e| format!("Invalid YAML syntax: {}", e))?;

    let has_proxies = yaml
        .get("proxies")
        .and_then(|p| p.as_sequence())
        .map(|s| !s.is_empty())
        .unwrap_or(false);

    let has_proxy_providers = yaml
        .get("proxy-providers")
        .and_then(|p| p.as_mapping())
        .map(|m| !m.is_empty())
        .unwrap_or(false);

    if !has_proxies && !has_proxy_providers {
        return Err("Config has no proxies or proxy-providers defined".to_string());
    }

    if let Some(port) = yaml.get("mixed-port").and_then(|v| v.as_u64()) {
        if port == 0 || port > 65535 {
            return Err(format!("Invalid mixed-port: {}", port));
        }
    }

    // Проверяем что proxy-groups ссылаются на существующие прокси
    if has_proxies {
        let proxy_names: HashSet<String> = yaml
            .get("proxies")
            .and_then(|p| p.as_sequence())
            .map(|seq| {
                seq.iter()
                    .filter_map(|p| p.get("name").and_then(|n| n.as_str()))
                    .map(|s| s.to_string())
                    .collect()
            })
            .unwrap_or_default();

        let builtins: HashSet<&str> = ["DIRECT", "REJECT", "REJECT-DROP", "PASS", "COMPATIBLE"]
            .iter()
            .copied()
            .collect();

        if let Some(groups) = yaml.get("proxy-groups").and_then(|g| g.as_sequence()) {
            let group_names: HashSet<String> = groups
                .iter()
                .filter_map(|g| g.get("name").and_then(|n| n.as_str()))
                .map(|s| s.to_string())
                .collect();

            for group in groups {
                let group_name = group
                    .get("name")
                    .and_then(|n| n.as_str())
                    .unwrap_or("unknown");

                if let Some(proxies_list) = group.get("proxies").and_then(|p| p.as_sequence()) {
                    for proxy_ref in proxies_list {
                        if let Some(name) = proxy_ref.as_str() {
                            if !proxy_names.contains(name)
                                && !group_names.contains(name)
                                && !builtins.contains(name)
                            {
                                return Err(format!(
                                    "proxy-group '{}' references unknown proxy '{}'. Check that proxy names in 'proxies' and 'proxy-groups' match exactly.",
                                    group_name, name
                                ));
                            }
                        }
                    }
                }
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        if let Some(tun) = yaml.get("tun").and_then(|t| t.as_mapping()) {
            if let Some(enabled) = tun.get(&serde_yaml::Value::String("enable".into())) {
                if enabled.as_bool() == Some(true) && !has_admin_privileges() {
                    return Err(
                        "TUN is enabled but app lacks root privileges".to_string(),
                    );
                }
            }
        }
    }

    Ok(())
}

// ─── Очистка при завершении ──────────────────────────────────────────────────

pub fn cleanup_mihomo() {
    if let Ok(mut guard) = MIHOMO_PROCESS.lock() {
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    kill_existing_mihomo();
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── AmneziaWG / WireGuard .conf support ─────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

/// Парсит AmneziaWG / WireGuard .conf файл и возвращает YAML для proxy entry в Mihomo формате.
/// Добавляет persistent-keepalive: 25 по умолчанию (решает проблему обрыва соединения).
#[allow(dead_code)]
fn parse_amnezia_wg_conf(content: &str) -> Result<serde_yaml::Value, String> {
    let mut interface: HashMap<String, String> = HashMap::new();
    let mut peer: HashMap<String, String> = HashMap::new();
    let mut current_section = String::new();

    for raw_line in content.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
            continue;
        }
        if line.starts_with('[') && line.ends_with(']') {
            current_section = line[1..line.len() - 1].to_lowercase();
            continue;
        }
        if let Some((key, value)) = line.split_once('=') {
            let key = key.trim().to_lowercase();
            let value = value.trim().to_string();
            if current_section == "interface" {
                interface.insert(key, value);
            } else if current_section == "peer" {
                peer.insert(key, value);
            }
        }
    }

    let mut proxy = serde_yaml::Mapping::new();

    // Обязательные поля
    proxy.insert(
        "name".into(),
        serde_yaml::Value::String("amnezia-wg".to_string()),
    );
    proxy.insert(
        "type".into(),
        serde_yaml::Value::String("wireguard".to_string()),
    );

    if let Some(pk) = interface.get("privatekey") {
        proxy.insert(
            "private-key".into(),
            serde_yaml::Value::String(pk.clone()),
        );
    } else {
        return Err("Missing PrivateKey in [Interface] section".to_string());
    }

    if let Some(endpoint) = peer.get("endpoint") {
        if let Some((srv, prt_str)) = endpoint.rsplit_once(':') {
            proxy.insert("server".into(), serde_yaml::Value::String(srv.to_string()));
            if let Ok(p) = prt_str.trim().parse::<u16>() {
                proxy.insert("port".into(), serde_yaml::Value::Number(serde_yaml::Number::from(p)));
            } else {
                return Err(format!("Invalid port in Endpoint: {}", endpoint));
            }
        } else {
            proxy.insert("server".into(), serde_yaml::Value::String(endpoint.clone()));
            // port обязателен, если нет - ошибка
            return Err("Endpoint must be in host:port format".to_string());
        }
    } else {
        return Err("Missing Endpoint in [Peer] section".to_string());
    }

    // Address (может содержать IPv4 и/или IPv6)
    if let Some(addr) = interface.get("address") {
        for part in addr.split(',') {
            let part = part.trim();
            if part.is_empty() {
                continue;
            }
            let ip_part = part.split('/').next().unwrap_or(part).trim();
            if ip_part.contains(':') {
                // IPv6
                proxy.insert("ipv6".into(), serde_yaml::Value::String(ip_part.to_string()));
            } else if ip_part.contains('.') {
                proxy.insert("ip".into(), serde_yaml::Value::String(ip_part.to_string()));
            }
        }
    }

    if let Some(pubk) = peer.get("publickey") {
        proxy.insert(
            "public-key".into(),
            serde_yaml::Value::String(pubk.clone()),
        );
    } else {
        return Err("Missing PublicKey in [Peer] section".to_string());
    }

    if let Some(psk) = peer.get("presharedkey") {
        proxy.insert(
            "pre-shared-key".into(),
            serde_yaml::Value::String(psk.clone()),
        );
    }

    if let Some(allowed) = peer.get("allowedips") {
        let ips: Vec<serde_yaml::Value> = allowed
            .split(',')
            .map(|s| serde_yaml::Value::String(s.trim().to_string()))
            .collect();
        proxy.insert("allowed-ips".into(), serde_yaml::Value::Sequence(ips));
    } else {
        // дефолт для full-tunnel
        proxy.insert(
            "allowed-ips".into(),
            serde_yaml::Value::Sequence(vec![
                serde_yaml::Value::String("0.0.0.0/0".to_string()),
                serde_yaml::Value::String("::/0".to_string()),
            ]),
        );
    }

    // === AmneziaWG опции (если есть в [Interface]) ===
    let mut amnezia = serde_yaml::Mapping::new();
    let mut has_amnezia = false;

    let amnezia_keys = ["jc", "jmin", "jmax", "s1", "s2", "s3", "s4", "h1", "h2", "h3", "h4"];
    for key in amnezia_keys {
        if let Some(v) = interface.get(key) {
            if key.starts_with('h') {
                // H-параметры всегда строка (могут быть диапазонами "123-456")
                amnezia.insert(key.into(), serde_yaml::Value::String(v.clone()));
                has_amnezia = true;
            } else if let Ok(num) = v.parse::<i64>() {
                amnezia.insert(key.into(), serde_yaml::Value::Number(serde_yaml::Number::from(num)));
                has_amnezia = true;
            }
        }
    }

    if has_amnezia {
        proxy.insert(
            "amnezia-wg-option".into(),
            serde_yaml::Value::Mapping(amnezia),
        );

        if proxy.get("mtu").is_none() {
            proxy.insert(
                "mtu".into(),
                serde_yaml::Value::Number(serde_yaml::Number::from(1280u64)),
            );
        }

        if proxy.get("remote-dns-resolve").is_none() {
            proxy.insert("remote-dns-resolve".into(), serde_yaml::Value::Bool(true));
        }
    }

    // === Важно для стабильности: persistent-keepalive ===
    // Решает проблему "соединение теряется" на многих сетях (NAT timeout)
    if proxy.get("persistent-keepalive").is_none() {
        proxy.insert(
            "persistent-keepalive".into(),
            serde_yaml::Value::Number(serde_yaml::Number::from(25u64)),
        );
    }

    // udp: true по умолчанию
    if proxy.get("udp").is_none() {
        proxy.insert("udp".into(), serde_yaml::Value::Bool(true));
    }

    Ok(serde_yaml::Value::Mapping(proxy))
}

#[allow(dead_code)]
#[tauri::command(rename_all = "camelCase")]
pub fn convert_amnezia_wg_conf(config_content: String) -> Result<String, String> {
    let proxy_value = parse_amnezia_wg_conf(&config_content)?;
    let yaml_str = serde_yaml::to_string(&proxy_value)
        .map_err(|e| format!("Failed to serialize proxy to YAML: {}", e))?;
    Ok(yaml_str)
}

/// Дополнительно: создаёт минимальный готовый Mihomo config из .conf AmneziaWG
#[allow(dead_code)]
#[tauri::command(rename_all = "camelCase")]
pub fn import_amnezia_wg_as_config(
    config_content: String,
    proxy_name: Option<String>,
) -> Result<String, String> {
    let mut proxy = parse_amnezia_wg_conf(&config_content)?
        .as_mapping()
        .ok_or("Internal error: proxy is not a mapping")?
        .clone();

    if let Some(name) = proxy_name {
        if !name.trim().is_empty() {
            proxy.insert("name".into(), serde_yaml::Value::String(name));
        }
    }

    // Получаем финальное имя прокси (нужно для proxy-groups)
    let proxy_name_final = proxy
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("amnezia-wg")
        .to_string();

    let mut root = serde_yaml::Mapping::new();
    root.insert(
        "proxies".into(),
        serde_yaml::Value::Sequence(vec![serde_yaml::Value::Mapping(proxy)]),
    );

    // Создаём proxy-groups (без этого MATCH,PROXY не сработает)
    let proxy_group = serde_yaml::Mapping::from_iter([
        ("name".into(), serde_yaml::Value::String("PROXY".to_string())),
        ("type".into(), serde_yaml::Value::String("select".to_string())),
        (
            "proxies".into(),
            serde_yaml::Value::Sequence(vec![
                serde_yaml::Value::String(proxy_name_final),
                serde_yaml::Value::String("DIRECT".to_string()),
            ]),
        ),
    ]);
    root.insert(
        "proxy-groups".into(),
        serde_yaml::Value::Sequence(vec![serde_yaml::Value::Mapping(proxy_group)]),
    );

    // Базовые настройки как в generate_config
    root.insert(
        "mode".into(),
        serde_yaml::Value::String("rule".to_string()),
    );
    root.insert(
        "log-level".into(),
        serde_yaml::Value::String("info".to_string()),
    );
    root.insert(
        "mixed-port".into(),
        serde_yaml::Value::Number(serde_yaml::Number::from(7890u64)),
    );
    root.insert(
        "external-controller".into(),
        serde_yaml::Value::String("127.0.0.1:9090".to_string()),
    );

    // Простые правила по умолчанию (всё через VPN)
    root.insert(
        "rules".into(),
        serde_yaml::Value::Sequence(vec![serde_yaml::Value::String(
            "MATCH,PROXY".to_string(),
        )]),
    );

    // Минимальный DNS (можно потом перегенерировать через generate_config)
    let mut dns = serde_yaml::Mapping::new();
    dns.insert("enable".into(), serde_yaml::Value::Bool(true));
    dns.insert("ipv6".into(), serde_yaml::Value::Bool(true));
    dns.insert(
        "enhanced-mode".into(),
        serde_yaml::Value::String("fake-ip".to_string()),
    );
    dns.insert(
        "fake-ip-range".into(),
        serde_yaml::Value::String("198.18.0.1/16".to_string()),
    );
    dns.insert(
        "default-nameserver".into(),
        serde_yaml::Value::Sequence(vec![
            serde_yaml::Value::String("1.1.1.1".to_string()),
            serde_yaml::Value::String("8.8.8.8".to_string()),
        ]),
    );
    dns.insert(
        "nameserver".into(),
        serde_yaml::Value::Sequence(vec![
            serde_yaml::Value::String("https://1.1.1.1/dns-query".to_string()),
            serde_yaml::Value::String("https://8.8.8.8/dns-query".to_string()),
        ]),
    );
    root.insert("dns".into(), serde_yaml::Value::Mapping(dns));

    // TUN выключен по умолчанию (включай вручную если нужно)
    let mut tun = serde_yaml::Mapping::new();
    tun.insert("enable".into(), serde_yaml::Value::Bool(false));
    tun.insert(
        "stack".into(),
        serde_yaml::Value::String("gvisor".to_string()),
    );
    root.insert("tun".into(), serde_yaml::Value::Mapping(tun));

    serde_yaml::to_string(&root)
        .map_err(|e| format!("Failed to serialize full config: {}", e))
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── Tauri Commands ──────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

#[tauri::command]
pub async fn mihomo_get_traffic() -> Result<MihomoTraffic, String> {
    let v = mihomo_get_json_value(&["/v1/traffic", "/traffic"]).await?;
    Ok(MihomoTraffic {
        up: value_to_u64(v.get("up")),
        down: value_to_u64(v.get("down")),
    })
}

#[tauri::command]
pub async fn mihomo_get_proxies() -> Result<serde_json::Value, String> {
    mihomo_get_json_value(&["/v1/proxies", "/proxies"]).await
}

#[tauri::command]
pub async fn mihomo_get_connections() -> Result<serde_json::Value, String> {
    mihomo_get_json_value(&["/v1/connections", "/connections"]).await
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

#[tauri::command(rename_all = "camelCase")]
pub async fn ping_host(host: String) -> Result<Option<u32>, String> {
    let host = host.trim();

    if host.is_empty()
        || host.len() > 253
        || host.starts_with('-')
        || host.contains(|c: char| {
            c.is_whitespace()
                || c == ';'
                || c == '|'
                || c == '&'
                || c == '$'
                || c == '`'
                || c == '\''
                || c == '"'
                || c == '('
                || c == ')'
                || c == '>'
                || c == '<'
        })
    {
        return Err("Invalid host".to_string());
    }

    let valid = host
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == ':' || c == '_');
    if !valid {
        return Err("Invalid host characters".to_string());
    }

    let mut cmd = if cfg!(target_os = "windows") {
        let mut c = Command::new("ping");
        c.args(["-n", "1", "-w", "1000", host]);
        c
    } else {
        let mut c = Command::new("ping");
        c.args(["-c", "1", "-W", "1", host]);
        c
    };

    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(0x08000000);
    }

    let out = cmd
        .output()
        .map_err(|e| format!("Failed to run ping: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    let combined = format!("{}\n{}", stdout, stderr);

    Ok(parse_ping_ms(&combined))
}

#[tauri::command]
pub fn get_mihomo_binary_name() -> String {
    get_binary_name().to_string()
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
            let name = proxy.get("name").and_then(|v| v.as_str());
            let server = proxy.get("server").and_then(|v| v.as_str());
            let port = proxy.get("port").and_then(|v| {
                v.as_u64().or_else(|| {
                    v.as_str().and_then(|s| s.parse::<u64>().ok())
                })
            });
            let ptype = proxy.get("type").and_then(|v| v.as_str());

            if let (Some(name), Some(server), Some(port), Some(ptype)) = (name, server, port, ptype) {
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

    let mode = yaml
        .get("mode")
        .and_then(|v| v.as_str())
        .unwrap_or("rule")
        .to_string();

    let log_level = yaml
        .get("log-level")
        .and_then(|v| v.as_str())
        .unwrap_or("info")
        .to_string();

    let mixed_port = yaml
        .get("mixed-port")
        .and_then(|v| v.as_u64())
        .unwrap_or(7890) as u16;

    let mut rules = Vec::new();
    if let Some(rule_list) = yaml.get("rules").and_then(|r| r.as_sequence()) {
        rules.reserve(rule_list.len());
        for rule in rule_list {
            if let Some(rule_str) = rule.as_str() {
                if let Some(parsed) = parse_rule_string(rule_str) {
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

    if yaml.get("external-controller").is_none() {
        yaml["external-controller"] = serde_yaml::Value::String("127.0.0.1:9090".to_string());
    }

    let mut profile = serde_yaml::Mapping::new();
    profile.insert("store-fake-ip".into(), serde_yaml::Value::Bool(true));
    profile.insert("store-selected".into(), serde_yaml::Value::Bool(true));
    yaml["profile"] = serde_yaml::Value::Mapping(profile);

    if !user_rules.is_empty() {
        yaml["rules"] = serde_yaml::Value::Sequence(build_rules_from_user_rules(&user_rules));
    }

    // TUN
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
    tun.insert(
        "stack".into(),
        serde_yaml::Value::String("gvisor".to_string()),
    );
    tun.insert("auto-route".into(), serde_yaml::Value::Bool(true));
    tun.insert(
        "device".into(),
        serde_yaml::Value::String("Mihomo".to_string()),
    );
    tun.insert(
        "dns-hijack".into(),
        serde_yaml::Value::Sequence(vec![serde_yaml::Value::String("any:53".to_string())]),
    );
    yaml["tun"] = serde_yaml::Value::Mapping(tun);

    // DNS
    let mut dns = serde_yaml::Mapping::new();
    dns.insert("enable".into(), serde_yaml::Value::Bool(true));
    dns.insert("ipv6".into(), serde_yaml::Value::Bool(true));
    dns.insert(
        "enhanced-mode".into(),
        serde_yaml::Value::String("fake-ip".to_string()),
    );
    dns.insert(
        "fake-ip-range".into(),
        serde_yaml::Value::String("198.18.0.1/16".to_string()),
    );
    dns.insert(
        "default-nameserver".into(),
        serde_yaml::Value::Sequence(vec![
            serde_yaml::Value::String("1.1.1.1".to_string()),
            serde_yaml::Value::String("8.8.8.8".to_string()),
        ]),
    );
    dns.insert(
        "nameserver".into(),
        serde_yaml::Value::Sequence(vec![
            serde_yaml::Value::String("https://1.1.1.1/dns-query".to_string()),
            serde_yaml::Value::String("https://8.8.8.8/dns-query".to_string()),
        ]),
    );
    dns.insert(
        "proxy-server-nameserver".into(),
        serde_yaml::Value::Sequence(vec![
            serde_yaml::Value::String("https://1.1.1.1/dns-query".to_string()),
            serde_yaml::Value::String("https://8.8.8.8/dns-query".to_string()),
        ]),
    );
    dns.insert(
        "fallback".into(),
        serde_yaml::Value::Sequence(vec![serde_yaml::Value::String(
            "https://dns.google/dns-query".to_string(),
        )]),
    );

    let mut fallback_filter = serde_yaml::Mapping::new();
    fallback_filter.insert("geoip".into(), serde_yaml::Value::Bool(true));
    fallback_filter.insert(
        "geoip-code".into(),
        serde_yaml::Value::String("RU".to_string()),
    );
    dns.insert(
        "fallback-filter".into(),
        serde_yaml::Value::Mapping(fallback_filter),
    );

    let mut cache = serde_yaml::Mapping::new();
    cache.insert(
        "size".into(),
        serde_yaml::Value::Number(serde_yaml::Number::from(4096)),
    );
    cache.insert(
        "min-ttl".into(),
        serde_yaml::Value::Number(serde_yaml::Number::from(600)),
    );
    dns.insert("cache".into(), serde_yaml::Value::Mapping(cache));

    dns.insert(
        "fake-ip-filter".into(),
        serde_yaml::Value::Sequence(vec![
            serde_yaml::Value::String("*.lan".to_string()),
            serde_yaml::Value::String("*.local".to_string()),
        ]),
    );

    yaml["dns"] = serde_yaml::Value::Mapping(dns);
    yaml["tcp-concurrent"] = serde_yaml::Value::Bool(true);
    yaml["unified-delay"] = serde_yaml::Value::Bool(true);
    yaml["keep-alive-interval"] = serde_yaml::Value::Number(serde_yaml::Number::from(30));

    serde_yaml::to_string(&yaml).map_err(|e| format!("Failed to serialize YAML: {}", e))
}

#[tauri::command(rename_all = "camelCase")]
pub async fn import_config(
    app: AppHandle,
    config_content: String,
    filename: String,
) -> Result<String, String> {
    let config_dir = primary_config_dir(&app);
    fs::create_dir_all(&config_dir)
        .map_err(|e| format!("Failed to create config dir: {}", e))?;
    let config_path = config_dir.join(&filename);

    let content_to_write = match serde_yaml::from_str::<serde_yaml::Value>(&config_content) {
        Ok(mut yaml) => {
            let mut did_rewrite = false;
            if let Some(seq) = yaml.get_mut("rules").and_then(|r| r.as_sequence_mut()) {
                if seq.len() == 1 {
                    if let Some(only) = seq.first_mut() {
                        if let Some(s) = only.as_str() {
                            if s.trim() == "MATCH,DIRECT" {
                                *only = serde_yaml::Value::String("MATCH,PROXY".to_string());
                                did_rewrite = true;
                            }
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
pub async fn save_rules_to_config(
    app: AppHandle,
    filename: String,
    user_rules: Vec<UserRule>,
) -> Result<(), String> {
    if user_rules.is_empty() {
        return Ok(());
    }

    let config_path = find_existing_config_path(&app, &filename)
        .unwrap_or_else(|| primary_config_dir(&app).join(&filename));

    backup_config(&config_path)?;

    let content =
        fs::read_to_string(&config_path).map_err(|e| format!("Failed to read config: {}", e))?;
    let mut yaml: serde_yaml::Value =
        serde_yaml::from_str(&content).map_err(|e| format!("Failed to parse YAML: {}", e))?;

    yaml["rules"] = serde_yaml::Value::Sequence(build_rules_from_user_rules(&user_rules));

    let new_content =
        serde_yaml::to_string(&yaml).map_err(|e| format!("Failed to serialize YAML: {}", e))?;

    fs::write(&config_path, new_content)
        .map_err(|e| format!("Failed to write config: {}", e))?;
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn save_rules_to_path(path: String, user_rules: Vec<UserRule>) -> Result<(), String> {
    if user_rules.is_empty() {
        return Ok(());
    }

    let config_path = PathBuf::from(&path);

    backup_config(&config_path)?;

    let content =
        fs::read_to_string(&config_path).map_err(|e| format!("Failed to read config: {}", e))?;
    let mut yaml: serde_yaml::Value =
        serde_yaml::from_str(&content).map_err(|e| format!("Failed to parse YAML: {}", e))?;

    yaml["rules"] = serde_yaml::Value::Sequence(build_rules_from_user_rules(&user_rules));

    let new_content =
        serde_yaml::to_string(&yaml).map_err(|e| format!("Failed to serialize YAML: {}", e))?;
    fs::write(&config_path, new_content)
        .map_err(|e| format!("Failed to write config: {}", e))?;
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub fn export_config_to_path(
    app: AppHandle,
    filename: String,
    path: String,
) -> Result<(), String> {
    let src_path = find_existing_config_path(&app, &filename)
        .ok_or_else(|| format!("Config file not found: {}", filename))?;

    let content = fs::read_to_string(&src_path)
        .map_err(|e| format!("Failed to read config {}: {}", filename, e))?;

    fs::write(PathBuf::from(path), content)
        .map_err(|e| format!("Failed to export config: {}", e))
}

#[tauri::command(rename_all = "camelCase")]
pub fn restore_config_backup(app: AppHandle, filename: String) -> Result<String, String> {
    let config_path = find_existing_config_path(&app, &filename)
        .ok_or_else(|| format!("Config not found: {}", filename))?;

    let backup = config_path.with_extension("yml.bak");
    if !backup.exists() {
        return Err("No backup found".to_string());
    }

    fs::copy(&backup, &config_path)
        .map_err(|e| format!("Failed to restore backup: {}", e))?;

    fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read restored config: {}", e))
}

#[tauri::command(rename_all = "camelCase")]
pub async fn start_vpn(
    app: AppHandle,
    config_content: String,
    config_filename: String,
    enable_tun: bool,
) -> Result<VpnStatus, String> {
    #[cfg(target_os = "windows")]
    {
        let _ = enable_tun;
    }

    #[cfg(not(target_os = "windows"))]
    {
        if enable_tun && !has_admin_privileges() {
            return Err(
                "TUN requires elevated privileges. Disable TUN or run with sudo/root.".to_string(),
            );
        }
    }

    validate_config(&config_content)?;

    let config_dir = primary_config_dir(&app);
    fs::create_dir_all(&config_dir)
        .map_err(|e| format!("Failed to create config dir: {}", e))?;

    let config_path = config_dir.join(&config_filename);
    fs::write(&config_path, &config_content)
        .map_err(|e| format!("Failed to write config: {}", e))?;

    let log_path = config_dir.join("mihomo.log");

    rotate_log_file(&log_path);

    // Один lock — без TOCTOU
    {
        let mut process_guard = MIHOMO_PROCESS.lock().map_err(|e| e.to_string())?;
        if let Some(mut child) = process_guard.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    kill_existing_mihomo();

    let mihomo_path = get_mihomo_path(&app);

    let mut cmd = Command::new(mihomo_path);
    cmd.arg("-f")
        .arg(&config_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(0x08000000);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start mihomo: {}", e))?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    spawn_log_reader(stdout, stderr, log_path);

    {
        let mut process_guard = MIHOMO_PROCESS.lock().map_err(|e| e.to_string())?;
        *process_guard = Some(child);
    }

    // Запоминаем время старта
    if let Ok(mut guard) = START_TIME.lock() {
        *guard = Some(std::time::Instant::now());
    }

    update_controller_config(&config_content);

    wait_for_mihomo_ready(&app).await?;

    let parsed = parse_config(config_content)?;
    Ok(VpnStatus {
        running: true,
        server: parsed.server_address,
        proxy_name: parsed.proxy_name,
        mode: parsed.mode,
        port: parsed.mixed_port,
    })
}

#[tauri::command(rename_all = "camelCase")]
pub async fn reload_mihomo_config(
    app: AppHandle,
    config_content: String,
    config_filename: String,
) -> Result<(), String> {
    {
        let guard = MIHOMO_PROCESS.lock().map_err(|e| e.to_string())?;
        if guard.is_none() {
            return Err("Mihomo is not running".to_string());
        }
    }

    let config_dir = primary_config_dir(&app);
    fs::create_dir_all(&config_dir)
        .map_err(|e| format!("Failed to create config dir: {}", e))?;

    let config_path = config_dir.join(&config_filename);
    fs::write(&config_path, &config_content)
        .map_err(|e| format!("Failed to write config: {}", e))?;

    let config_path_str = config_path.to_string_lossy().to_string();

    mihomo_request(
        reqwest::Method::PUT,
        &["/configs?force=true", "/v1/configs?force=true"],
        Some(&serde_json::json!({ "path": config_path_str })),
    )
    .await?;

    update_controller_config(&config_content);
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn switch_mihomo_mode(mode: String) -> Result<(), String> {
    mihomo_request(
        reqwest::Method::PATCH,
        &["/configs", "/v1/configs"],
        Some(&serde_json::json!({ "mode": mode })),
    )
    .await?;
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn switch_proxy_group(group_name: String, proxy_name: String) -> Result<(), String> {
    let encoded = urlencoding::encode(&group_name);
    let p1 = format!("/proxies/{}", encoded);
    let p2 = format!("/v1/proxies/{}", encoded);

    mihomo_request(
        reqwest::Method::PUT,
        &[&p1, &p2],
        Some(&serde_json::json!({ "name": proxy_name })),
    )
    .await?;
    Ok(())
}

#[tauri::command]
pub async fn stop_vpn() -> Result<VpnStatus, String> {
    {
        let mut process_guard = MIHOMO_PROCESS.lock().map_err(|e| e.to_string())?;
        if let Some(mut child) = process_guard.take() {
            child
                .kill()
                .map_err(|e| format!("Failed to kill mihomo: {}", e))?;
            let _ = child.wait();
        }
    }

    // Сбрасываем время старта
    if let Ok(mut guard) = START_TIME.lock() {
        *guard = None;
    }

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
    let mut process_guard = MIHOMO_PROCESS.lock().map_err(|e| e.to_string())?;

    // Проверяем, жив ли процесс
    let running = if let Some(ref mut child) = *process_guard {
        match child.try_wait() {
            Ok(Some(_)) => {
                process_guard.take();
                false
            }
            _ => true,
        }
    } else {
        false
    };

    Ok(VpnStatus {
        running,
        server: None,
        proxy_name: None,
        mode: "rule".to_string(),
        port: 7890,
    })
}

#[tauri::command]
pub async fn health_check(app: AppHandle) -> Result<HealthStatus, String> {
    let (mihomo_running, pid) = {
        let mut guard = MIHOMO_PROCESS.lock().map_err(|e| e.to_string())?;
        if let Some(ref mut child) = *guard {
            match child.try_wait() {
                Ok(Some(_)) => {
                    guard.take();
                    (false, None)
                }
                Ok(None) => (true, Some(child.id())),
                Err(_) => {
                    guard.take();
                    (false, None)
                }
            }
        } else {
            (false, None)
        }
    };

    let mihomo_responsive = if mihomo_running {
        mihomo_get_json_value(&["/configs"]).await.is_ok()
    } else {
        false
    };

    let uptime_secs = START_TIME
        .lock()
        .ok()
        .and_then(|g| g.map(|t| t.elapsed().as_secs()));

    let log_path = primary_config_dir(&app).join("mihomo.log");
    let log_size_bytes = fs::metadata(&log_path).map(|m| m.len()).unwrap_or(0);

    Ok(HealthStatus {
        mihomo_running,
        mihomo_responsive,
        pid,
        uptime_secs,
        log_size_bytes,
        config_loaded: mihomo_responsive,
    })
}

#[tauri::command]
pub fn get_mihomo_logs(app: AppHandle) -> Result<Vec<LogEntry>, String> {
    let log_path = primary_config_dir(&app).join("mihomo.log");

    if !log_path.exists() {
        return Ok(vec![]);
    }

    let mut file =
        fs::File::open(&log_path).map_err(|e| format!("Failed to open logs: {}", e))?;

    let file_len = file
        .metadata()
        .map_err(|e| format!("Failed to get metadata: {}", e))?
        .len();

    let start = file_len.saturating_sub(LOG_TAIL_BYTES);

    file.seek(SeekFrom::Start(start))
        .map_err(|e| format!("Failed to seek: {}", e))?;

    let mut buf = String::new();
    file.read_to_string(&mut buf)
        .map_err(|e| format!("Failed to read logs: {}", e))?;

    let content = if start > 0 {
        buf.splitn(2, '\n').nth(1).unwrap_or("")
    } else {
        &buf
    };

    let logs: Vec<LogEntry> = content
        .lines()
        .rev()
        .take(MAX_LOG_ENTRIES)
        .filter(|l| !l.trim().is_empty())
        .map(parse_log_line)
        .collect();

    Ok(logs)
}

#[tauri::command]
pub fn clear_mihomo_logs(app: AppHandle) -> Result<(), String> {
    let config_dir = primary_config_dir(&app);
    let log_path = config_dir.join("mihomo.log");

    if log_path.exists() {
        fs::write(&log_path, "").map_err(|e| format!("Failed to clear logs: {}", e))?;
    }

    let backup = log_path.with_extension("log.old");
    if backup.exists() {
        let _ = fs::remove_file(&backup);
    }

    Ok(())
}

#[tauri::command]
pub fn list_configs(app: AppHandle) -> Result<Vec<String>, String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();

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
        // Удаляем и бэкап если есть
        let backup = config_path.with_extension("yml.bak");
        if backup.exists() {
            let _ = fs::remove_file(&backup);
        }

        return fs::remove_file(&config_path)
            .map_err(|e| format!("Failed to delete config {}: {}", filename, e));
    }
    Ok(())
}
