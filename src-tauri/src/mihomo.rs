use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::collections::HashSet;
use std::fs;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::net::{IpAddr, Ipv4Addr, ToSocketAddrs};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, LazyLock, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use tokio::sync::Notify;
use tracing::{debug, error, info, warn};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

// ─── Константы ───────────────────────────────────────────────────────────────

const MAX_LOG_SIZE: u64 = 10 * 1024 * 1024;
const LOG_TAIL_BYTES: u64 = 64 * 1024;
const MAX_LOG_ENTRIES: usize = 200;
const LOG_SIZE_CHECK_INTERVAL: u64 = 2000;
const MIHOMO_READY_TIMEOUT_SECS: u64 = 10;
/// Written next to an interface-name this app chose. A name the user set has no marker and is left alone.
const AUTO_INTERFACE_KEY: &str = "rododendron-auto-interface";
const LOG_DIAG_LINES: usize = 10;

// ─── Глобальное состояние ────────────────────────────────────────────────────

static MIHOMO_PROCESS: Mutex<Option<Child>> = Mutex::new(None);
static MIHOMO_PID: Mutex<Option<u32>> = Mutex::new(None);

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
        .tcp_keepalive(Some(std::time::Duration::from_secs(30)))
        .pool_idle_timeout(Some(std::time::Duration::from_secs(90)))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
});

static START_TIME: Mutex<Option<std::time::Instant>> = Mutex::new(None);

static MIHOMO_READY: LazyLock<Arc<(Mutex<bool>, Notify)>> =
    LazyLock::new(|| Arc::new((Mutex::new(false), Notify::new())));

/// One start or stop at a time. Overlapping restarts used to leave a live
/// mihomo holding the TUN adapter, and the next start waited on it.
static VPN_LIFECYCLE: LazyLock<tokio::sync::Mutex<()>> =
    LazyLock::new(|| tokio::sync::Mutex::new(()));

/// Bumped by stop so a start that is still in flight does not bring the process back.
static VPN_EPOCH: AtomicU64 = AtomicU64::new(0);

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
        GetTokenInformation, TOKEN_ELEVATION, TOKEN_QUERY, TokenElevation,
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

fn wait_child_timeout(child: &mut Child, timeout: Duration) -> bool {
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return true,
            Ok(None) => {
                if started.elapsed() >= timeout {
                    return false;
                }
                thread::sleep(Duration::from_millis(50));
            }
            Err(_) => return true,
        }
    }
}

fn command_with_timeout(mut cmd: Command, timeout: Duration) {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    match cmd.spawn() {
        Ok(mut child) => {
            if !wait_child_timeout(&mut child, timeout) {
                let _ = child.kill();
                let _ = wait_child_timeout(&mut child, Duration::from_millis(400));
            }
        }
        Err(e) => {
            warn!("Failed to spawn process: {}", e);
        }
    }
}

fn stop_tracked_child(child: &mut Child) {
    let pid = child.id();
    let _ = child.kill();
    if !wait_child_timeout(child, Duration::from_secs(2)) {
        let _ = kill_process_by_pid(pid);
        let _ = wait_child_timeout(child, Duration::from_secs(1));
    }
}

#[cfg(target_os = "windows")]
fn kill_existing_mihomo() {
    let mut cmd = Command::new("taskkill");
    cmd.args(["/F", "/T", "/IM", get_binary_name()])
        .creation_flags(0x08000000);
    command_with_timeout(cmd, Duration::from_secs(2));
}

#[cfg(target_os = "linux")]
fn kill_existing_mihomo() {
    let mut cmd = Command::new("pkill");
    cmd.arg("-9").arg(get_binary_name());
    command_with_timeout(cmd, Duration::from_secs(2));
}

#[cfg(target_os = "macos")]
fn kill_existing_mihomo() {
    let mut cmd = Command::new("pkill");
    cmd.arg("-9").arg(get_binary_name());
    command_with_timeout(cmd, Duration::from_secs(2));
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

fn get_pid_file_path(app: &AppHandle) -> PathBuf {
    primary_config_dir(app).join("mihomo.pid")
}

fn save_pid(app: &AppHandle, pid: u32) {
    let pid_file = get_pid_file_path(app);
    let _ = fs::write(&pid_file, pid.to_string());
}

fn load_pid(app: &AppHandle) -> Option<u32> {
    let pid_file = get_pid_file_path(app);
    fs::read_to_string(&pid_file)
        .ok()
        .and_then(|s| s.trim().parse::<u32>().ok())
}

fn clear_pid(app: &AppHandle) {
    let pid_file = get_pid_file_path(app);
    let _ = fs::remove_file(&pid_file);
}

#[cfg(target_os = "windows")]
fn is_process_running(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle == 0 {
            return false;
        }
        CloseHandle(handle);
        true
    }
}

#[cfg(not(target_os = "windows"))]
fn is_process_running(pid: u32) -> bool {
    use nix::sys::signal::{Signal, kill};
    use nix::unistd::Pid;

    kill(Pid::from_raw(pid as i32), Signal::SIGCONT).is_ok()
}

#[cfg(target_os = "windows")]
fn kill_process_by_pid(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_TERMINATE, TerminateProcess};

    unsafe {
        let handle = OpenProcess(PROCESS_TERMINATE, 0, pid);
        if handle == 0 {
            return false;
        }
        let result = TerminateProcess(handle, 1);
        CloseHandle(handle);
        result != 0
    }
}

#[cfg(not(target_os = "windows"))]
fn kill_process_by_pid(pid: u32) -> bool {
    use nix::sys::signal::{Signal, kill};
    use nix::unistd::Pid;

    kill(Pid::from_raw(pid as i32), Signal::SIGKILL).is_ok()
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
        fs::copy(path, &backup).map_err(|e| format!("Failed to backup config: {}", e))?;
    }
    Ok(())
}

// ─── HTTP API (единый базовый метод) ─────────────────────────────────────────

async fn mihomo_request(
    method: reqwest::Method,
    paths: &[&str],
    body: Option<&serde_json::Value>,
) -> Result<reqwest::Response, String> {
    let cfg = CONTROLLER_CONFIG.lock().map_err(|e| e.to_string())?.clone();
    let mut last_err: Option<String> = None;

    for path in paths {
        let url = format!("http://{}:{}{}", cfg.host, cfg.port, path);
        let mut req = HTTP_CLIENT.request(method.clone(), &url);

        if let Some(secret) = &cfg.secret {
            req = req.header(reqwest::header::AUTHORIZATION, format!("Bearer {}", secret));
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

pub(crate) async fn mihomo_get_json_value(paths: &[&str]) -> Result<serde_json::Value, String> {
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
    let mut file = match fs::File::open(&log_path) {
        Ok(file) => file,
        Err(_) => return String::new(),
    };

    let file_len = file.metadata().map(|meta| meta.len()).unwrap_or(0);
    let start = file_len.saturating_sub(16 * 1024);
    if file.seek(SeekFrom::Start(start)).is_err() {
        return String::new();
    }

    let mut buf = String::new();
    if file.read_to_string(&mut buf).is_err() {
        return String::new();
    }

    let content = if start > 0 {
        buf.split_once('\n').map(|(_, rest)| rest).unwrap_or("")
    } else {
        buf.as_str()
    };

    let lines: Vec<&str> = content.lines().filter(|l| !l.trim().is_empty()).collect();
    let from = lines.len().saturating_sub(max_lines);
    lines[from..].join("\n")
}

fn format_error_with_log(base_msg: &str, app: &AppHandle) -> String {
    let log_tail = read_last_log_lines(app, LOG_DIAG_LINES);
    if log_tail.is_empty() {
        base_msg.to_string()
    } else {
        format!("{}\n\nMihomo log:\n{}", base_msg, log_tail)
    }
}

/// Ожидание готовности mihomo после запуска (с уведомлением вместо polling)
async fn wait_for_mihomo_ready(app: &AppHandle) -> Result<(), String> {
    let ready_pair = Arc::clone(&MIHOMO_READY);
    let (lock, notify) = &*ready_pair;

    // Сбрасываем состояние готовности
    {
        let mut ready = lock.lock().map_err(|e| e.to_string())?;
        *ready = false;
    }

    // Запускаем проверку в отдельном потоке
    let _app_clone = app.clone();
    let ready_pair_clone = Arc::clone(&ready_pair);

    tokio::spawn(async move {
        let delay = Duration::from_millis(200);
        let max_attempts = (MIHOMO_READY_TIMEOUT_SECS * 1000 / 200) as usize;

        for attempt in 0..max_attempts {
            // Проверяем, не умер ли процесс
            {
                if let Ok(mut guard) = MIHOMO_PROCESS.lock() {
                    if let Some(ref mut child) = *guard {
                        if let Ok(Some(status)) = child.try_wait() {
                            error!("Mihomo exited prematurely with status: {}", status);
                            return;
                        }
                    }
                }
            }

            // Проверяем готовность API
            if mihomo_get_json_value(&["/configs"]).await.is_ok() {
                debug!("Mihomo ready after {} attempts", attempt + 1);
                let (lock, notify) = &*ready_pair_clone;
                if let Ok(mut ready) = lock.lock() {
                    *ready = true;
                    notify.notify_waiters();
                }
                return;
            }

            tokio::time::sleep(delay).await;
        }

        warn!("Mihomo readiness check timed out");
    });

    // Ждём с таймаутом
    let timeout = tokio::time::sleep(Duration::from_secs(MIHOMO_READY_TIMEOUT_SECS));
    tokio::pin!(timeout);

    loop {
        // Проверяем состояние
        {
            let ready = lock.lock().map_err(|e| e.to_string())?;
            if *ready {
                info!("Mihomo is ready and responsive");
                return Ok(());
            }
        }

        // Ждём уведомления или таймаута
        tokio::select! {
            _ = notify.notified() => {
                // Получили уведомление, проверим снова на следующей итерации
                continue;
            }
            _ = &mut timeout => {
                // Таймаут истёк
                break;
            }
        }
    }

    // Проверяем процесс один последний раз
    if let Ok(mut guard) = MIHOMO_PROCESS.lock() {
        if let Some(ref mut child) = *guard {
            if let Ok(Some(status)) = child.try_wait() {
                let _ = guard.take();
                std::thread::sleep(Duration::from_millis(200));
                let msg = format!("Mihomo exited with status: {}", status);
                return Err(format_error_with_log(&msg, app));
            }
        }
    }
    Err(format_error_with_log(
        "Mihomo did not become ready in time",
        app,
    ))
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

fn write_log_line(file: &Mutex<fs::File>, counter: &AtomicU64, log_path: &PathBuf, line: &str) {
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

    // Валидация VLESS-специфичных полей
    if let Some(proxy_list) = yaml.get("proxies").and_then(|p| p.as_sequence()) {
        for proxy in proxy_list {
            let ptype = proxy.get("type").and_then(|v| v.as_str()).unwrap_or("");
            let pname = proxy
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("<unnamed>");
            if ptype == "vless" {
                let uuid = proxy.get("uuid").and_then(|v| v.as_str()).unwrap_or("");
                if uuid.trim().is_empty() {
                    return Err(format!(
                        "VLESS proxy '{}' is missing required field 'uuid'",
                        pname
                    ));
                }
                if let Some(reality_opts) = proxy.get("reality-opts") {
                    let pubkey = reality_opts
                        .get("public-key")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    if pubkey.trim().is_empty() {
                        return Err(format!(
                            "VLESS proxy '{}' has reality-opts but is missing 'public-key'",
                            pname
                        ));
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
                    return Err("TUN is enabled but app lacks root privileges".to_string());
                }
            }
        }
    }

    Ok(())
}

// ─── Очистка при завершении ──────────────────────────────────────────────────

pub fn cleanup_mihomo() {
    let child = MIHOMO_PROCESS
        .lock()
        .ok()
        .and_then(|mut guard| guard.take());
    if let Some(mut child) = child {
        stop_tracked_child(&mut child);
    }

    if let Ok(guard) = MIHOMO_PID.lock() {
        if let Some(pid) = *guard {
            let _ = kill_process_by_pid(pid);
        }
    }

    kill_existing_mihomo();
}

/// Находит и убивает осиротевшие процессы mihomo
fn find_and_kill_orphaned_mihomo(app: &AppHandle) {
    // Проверяем сохраненный PID
    if let Some(pid) = load_pid(app) {
        if is_process_running(pid) {
            let _ = kill_process_by_pid(pid);
        }
    }

    // На всякий случай убиваем все процессы mihomo
    kill_existing_mihomo();

    clear_pid(app);
}

fn tcp_port_open(port: u16) -> bool {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
        let open = std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(150)).is_ok();
        let _ = tx.send(open);
    });
    rx.recv_timeout(Duration::from_millis(300)).unwrap_or(false)
}

fn force_stop_mihomo(app: &AppHandle) {
    let child = MIHOMO_PROCESS
        .lock()
        .ok()
        .and_then(|mut guard| guard.take());
    if let Some(mut child) = child {
        stop_tracked_child(&mut child);
    }
    if let Ok(mut guard) = MIHOMO_PID.lock() {
        if let Some(pid) = guard.take() {
            let _ = kill_process_by_pid(pid);
        }
    }
    kill_existing_mihomo();
    clear_pid(app);
    if let Ok(mut guard) = START_TIME.lock() {
        *guard = None;
    }
}

fn tun_is_enabled(root: &serde_yaml::Value) -> bool {
    let Some(tun) = root.get("tun").filter(|value| value.is_mapping()) else {
        return false;
    };
    tun.get("enable")
        .and_then(|value| value.as_bool())
        .unwrap_or(true)
}

fn sequence_nonempty(map: &serde_yaml::Mapping, key: &str) -> bool {
    map.get(&ykey(key))
        .and_then(|value| value.as_sequence())
        .is_some_and(|items| !items.is_empty())
}

/// TUN swallows port 53, and a direct DoH dial to 1.1.1.1/8.8.8.8 is what
/// shows up as "context canceled" when that path is blocked. Fill only the
/// keys the config left out, on every start, so an already imported file
/// starts answering DNS without a re-paste.
fn ensure_tun_dns(root: &mut serde_yaml::Value) {
    if !tun_is_enabled(root) {
        return;
    }

    let auto_route = root
        .get("tun")
        .and_then(|tun| tun.get("auto-route"))
        .and_then(|value| value.as_bool())
        .unwrap_or(true);

    if let Some(tun) = root.get_mut("tun").and_then(|value| value.as_mapping_mut()) {
        let _ = insert_if_absent(
            tun,
            "dns-hijack",
            yaml_string_seq(&["any:53", "tcp://any:53"]),
        );
        if auto_route {
            let _ = insert_if_absent(
                tun,
                "dns-mode",
                serde_yaml::Value::String("hijack".to_string()),
            );
            let _ = insert_if_absent(tun, "strict-route", serde_yaml::Value::Bool(true));
        }
    }

    let Some(root_map) = root.as_mapping_mut() else {
        return;
    };
    let _ = insert_if_absent(root_map, "ipv6", serde_yaml::Value::Bool(false));

    let mut created = false;
    let Some(dns) = ensure_mapping(root_map, "dns", &mut created) else {
        return;
    };
    let _ = insert_if_absent(dns, "ipv6", serde_yaml::Value::Bool(false));
    let _ = insert_if_absent(
        dns,
        "enhanced-mode",
        serde_yaml::Value::String("fake-ip".to_string()),
    );
    let _ = insert_if_absent(
        dns,
        "fake-ip-range",
        serde_yaml::Value::String("198.18.0.1/16".to_string()),
    );
    if !dns.contains_key(&ykey("default-nameserver")) {
        let _ = insert_if_absent(
            dns,
            "default-nameserver",
            yaml_string_seq(&["1.1.1.1", "8.8.8.8"]),
        );
    }
    if !dns.contains_key(&ykey("nameserver")) {
        let _ = insert_if_absent(
            dns,
            "nameserver",
            yaml_string_seq(&["https://1.1.1.1/dns-query", "https://8.8.8.8/dns-query"]),
        );
    }
    if !dns.contains_key(&ykey("proxy-server-nameserver")) {
        let _ = insert_if_absent(
            dns,
            "proxy-server-nameserver",
            yaml_string_seq(&["1.1.1.1", "8.8.8.8"]),
        );
    }
    if sequence_nonempty(dns, "nameserver") {
        let _ = insert_if_absent(dns, "enable", serde_yaml::Value::Bool(true));
    }
    // respect-rules sends the main resolver through the matched proxy.
    // Mihomo refuses to start if it is on while proxy-server-nameserver is empty.
    if sequence_nonempty(dns, "proxy-server-nameserver") {
        let _ = insert_if_absent(dns, "respect-rules", serde_yaml::Value::Bool(true));
    }
}

fn set_tun_enabled(root: &mut serde_yaml::Value, enable: bool) {
    let Some(map) = root.as_mapping_mut() else {
        return;
    };
    let mut created = false;
    if let Some(tun) = ensure_mapping(map, "tun", &mut created) {
        tun.insert(ykey("enable"), serde_yaml::Value::Bool(enable));
    }
}

/// 3x-ui sometimes writes the VLESS ML-KEM client string into packet-encoding.
/// Mihomo reads that handshake from `encryption` and ignores the other field.
/// Для VLESS+REALITY: проставляет `client-fingerprint: chrome` если не задан.
/// Для VLESS+XHTTP: добавляет пустой `xhttp-opts` если не задан (mihomo требует маппинг).
fn normalize_vless_proxies(root: &mut serde_yaml::Value) {
    let Some(proxies) = root.get_mut("proxies").and_then(|v| v.as_sequence_mut()) else {
        return;
    };
    for proxy in proxies {
        let Some(map) = proxy.as_mapping_mut() else {
            continue;
        };
        if map.get(&ykey("type")).and_then(|v| v.as_str()) != Some("vless") {
            continue;
        }

        // REALITY: нужен client-fingerprint для TLS imitation
        let has_reality = map.contains_key(&ykey("reality-opts"));
        if has_reality {
            let fp_key = ykey("client-fingerprint");
            if !map.contains_key(&fp_key) {
                map.insert(fp_key, serde_yaml::Value::String("chrome".to_string()));
            }
        }

        // XHTTP: mihomo ожидает xhttp-opts как маппинг, даже пустой
        let network = map
            .get(&ykey("network"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if network == "xhttp" {
            let opts_key = ykey("xhttp-opts");
            if !map.contains_key(&opts_key) {
                map.insert(
                    opts_key,
                    serde_yaml::Value::Mapping(serde_yaml::Mapping::new()),
                );
            }
        }
    }
}

fn repair_vless_encryption(root: &mut serde_yaml::Value) {
    let Some(proxies) = root
        .get_mut("proxies")
        .and_then(|value| value.as_sequence_mut())
    else {
        return;
    };
    for proxy in proxies {
        let Some(map) = proxy.as_mapping_mut() else {
            continue;
        };
        if map.get(&ykey("type")).and_then(|value| value.as_str()) != Some("vless") {
            continue;
        }
        let encryption_key = ykey("encryption");
        let already = map
            .get(&encryption_key)
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty() && !value.eq_ignore_ascii_case("none"));
        if already.is_some() {
            continue;
        }
        let packet_key = ykey("packet-encoding");
        let Some(packet) = map
            .get(&packet_key)
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| value.to_ascii_lowercase().starts_with("mlkem768x25519plus"))
            .map(str::to_string)
        else {
            continue;
        };
        map.insert(encryption_key, serde_yaml::Value::String(packet));
        map.remove(&packet_key);
    }
}

fn wait_ports_free(ports: &[u16], timeout: Duration) -> bool {
    let started = Instant::now();
    loop {
        if ports.iter().copied().all(|port| !tcp_port_open(port)) {
            return true;
        }
        if started.elapsed() >= timeout {
            return false;
        }
        thread::sleep(Duration::from_millis(100));
    }
}

fn config_listen_ports(content: &str) -> Vec<u16> {
    let mut mixed = 7890u16;
    let mut controller = 9090u16;

    if let Ok(yaml) = serde_yaml::from_str::<serde_yaml::Value>(content) {
        if let Some(port) = yaml.get("mixed-port").and_then(|v| v.as_u64()) {
            if (1..=65535).contains(&port) {
                mixed = port as u16;
            }
        }
        if let Some(addr) = yaml.get("external-controller").and_then(|v| v.as_str()) {
            if let Some(port_str) = addr.rsplit(':').next() {
                if let Ok(port) = port_str.parse::<u16>() {
                    if port > 0 {
                        controller = port;
                    }
                }
            }
        }
    }

    let mut ports = vec![mixed, controller];
    ports.sort_unstable();
    ports.dedup();
    ports
}

fn ensure_previous_mihomo_stopped(app: &AppHandle, ports: &[u16]) -> Result<(), String> {
    let child = {
        let mut guard = MIHOMO_PROCESS.lock().map_err(|e| e.to_string())?;
        guard.take()
    };
    if let Some(mut child) = child {
        stop_tracked_child(&mut child);
    }

    if let Ok(mut guard) = MIHOMO_PID.lock() {
        if let Some(pid) = guard.take() {
            let _ = kill_process_by_pid(pid);
        }
    }

    find_and_kill_orphaned_mihomo(app);

    if wait_ports_free(ports, Duration::from_secs(2)) {
        return Ok(());
    }

    kill_existing_mihomo();
    if wait_ports_free(ports, Duration::from_secs(2)) {
        return Ok(());
    }

    Err("Previous Mihomo is still shutting down. Wait a moment and try again.".to_string())
}

fn ykey(key: &str) -> serde_yaml::Value {
    serde_yaml::Value::String(key.to_string())
}

fn yaml_string_seq(values: &[&str]) -> serde_yaml::Value {
    serde_yaml::Value::Sequence(
        values
            .iter()
            .copied()
            .map(|value| serde_yaml::Value::String(value.to_string()))
            .collect(),
    )
}

fn insert_if_absent(map: &mut serde_yaml::Mapping, key: &str, value: serde_yaml::Value) -> bool {
    let yaml_key = ykey(key);
    if map.contains_key(&yaml_key) {
        return false;
    }
    map.insert(yaml_key, value);
    true
}

fn ensure_mapping<'a>(
    map: &'a mut serde_yaml::Mapping,
    key: &str,
    changed: &mut bool,
) -> Option<&'a mut serde_yaml::Mapping> {
    let yaml_key = ykey(key);
    if !map.contains_key(&yaml_key) {
        map.insert(
            yaml_key.clone(),
            serde_yaml::Value::Mapping(serde_yaml::Mapping::new()),
        );
        *changed = true;
    }
    map.get_mut(&yaml_key)
        .and_then(|value| value.as_mapping_mut())
}

fn is_domain_name(host: &str) -> bool {
    let host = host.trim().trim_matches(|c| c == '[' || c == ']');
    if host.is_empty() || host.parse::<std::net::IpAddr>().is_ok() {
        return false;
    }
    host.contains('.') && host.chars().any(|c| c.is_ascii_alphabetic())
}

fn usable_proxy_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, _, _] = v4.octets();
            let fake_ip = a == 198 && (b == 18 || b == 19);
            !v4.is_loopback()
                && !v4.is_unspecified()
                && !v4.is_link_local()
                && !v4.is_broadcast()
                && !fake_ip
        }
        IpAddr::V6(v6) => !v6.is_loopback() && !v6.is_unspecified(),
    }
}

fn lookup_proxy_ip(host: &str) -> Option<IpAddr> {
    let host = host.to_string();
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let found = (host.as_str(), 443)
            .to_socket_addrs()
            .ok()
            .and_then(|addrs| {
                let usable: Vec<IpAddr> = addrs
                    .map(|addr| addr.ip())
                    .filter(|ip| usable_proxy_ip(*ip))
                    .collect();
                usable
                    .iter()
                    .copied()
                    .find(IpAddr::is_ipv4)
                    .or_else(|| usable.into_iter().next())
            });
        let _ = tx.send(found);
    });
    rx.recv_timeout(Duration::from_secs(2)).ok().flatten()
}

/// Resolve proxy hostnames before TUN starts and pin them in `hosts`.
/// The dial still has to leave through the physical NIC. See `bind_outbound_interface`.
fn pin_resolved_hosts(root: &mut serde_yaml::Value, pins: &[(String, IpAddr)]) {
    if pins.is_empty() {
        return;
    }
    let tun_on = tun_is_enabled(root);
    let Some(map) = root.as_mapping_mut() else {
        return;
    };
    let mut created = false;
    let mut pinned_ips = Vec::new();
    if let Some(hosts) = ensure_mapping(map, "hosts", &mut created) {
        for (domain, ip) in pins {
            let key = ykey(domain);
            let pinned = if let Some(existing) = hosts.get(&key).and_then(|value| value.as_str()) {
                existing.to_string()
            } else {
                let text = ip.to_string();
                hosts.insert(key, serde_yaml::Value::String(text.clone()));
                text
            };
            pinned_ips.push(pinned);
        }
    }

    if !tun_on {
        return;
    }
    let Some(map) = root.as_mapping_mut() else {
        return;
    };
    let mut created = false;
    let Some(tun) = ensure_mapping(map, "tun", &mut created) else {
        return;
    };
    let exclude_key = ykey("route-exclude-address");
    if !tun.contains_key(&exclude_key) {
        tun.insert(exclude_key.clone(), serde_yaml::Value::Sequence(Vec::new()));
    }
    let Some(seq) = tun
        .get_mut(&exclude_key)
        .and_then(|value| value.as_sequence_mut())
    else {
        return;
    };
    for ip in pinned_ips {
        let cidr = if ip.contains(':') {
            format!("{ip}/128")
        } else {
            format!("{ip}/32")
        };
        if seq.iter().any(|item| item.as_str() == Some(cidr.as_str())) {
            continue;
        }
        seq.push(serde_yaml::Value::String(cidr));
    }
}

fn pin_proxy_server_addresses(content: &str) -> String {
    let Ok(mut yaml) = serde_yaml::from_str::<serde_yaml::Value>(content) else {
        return content.to_string();
    };
    let Some(map) = yaml.as_mapping() else {
        return content.to_string();
    };
    let domains = proxy_server_domains(map);
    if domains.is_empty() {
        return content.to_string();
    }

    let mut pins = Vec::new();
    for domain in domains {
        match lookup_proxy_ip(&domain) {
            Some(ip) => {
                info!("Pinned proxy server {} to {}", domain, ip);
                pins.push((domain, ip));
            }
            None => warn!("Could not resolve proxy server {} before TUN start", domain),
        }
    }
    if pins.is_empty() {
        return content.to_string();
    }
    pin_resolved_hosts(&mut yaml, &pins);
    serde_yaml::to_string(&yaml).unwrap_or_else(|_| content.to_string())
}

struct OutboundNic {
    name: String,
    if_index: u32,
    metric: u32,
    has_gateway: bool,
}

/// Windows auto-route installs 0.0.0.0/1. The per-destination interface finder then
/// binds the core's own proxy dial to the TUN adapter, and the handshake dies at 5s.
/// An explicit interface-name is applied before that finder.
fn bind_outbound_interface(content: &str, nic: Option<&str>) -> String {
    let Ok(mut yaml) = serde_yaml::from_str::<serde_yaml::Value>(content) else {
        return content.to_string();
    };
    if !tun_is_enabled(&yaml) || interface_name_is_explicit(&yaml) {
        return content.to_string();
    }
    let Some(nic) = nic.map(str::trim).filter(|name| !name.is_empty()) else {
        return content.to_string();
    };
    let Some(map) = yaml.as_mapping_mut() else {
        return content.to_string();
    };
    map.insert(
        ykey("interface-name"),
        serde_yaml::Value::String(nic.to_string()),
    );
    map.insert(ykey(AUTO_INTERFACE_KEY), serde_yaml::Value::Bool(true));
    serde_yaml::to_string(&yaml).unwrap_or_else(|_| content.to_string())
}

fn interface_name_is_explicit(root: &serde_yaml::Value) -> bool {
    let name = root
        .get("interface-name")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim();
    if name.is_empty() || name.eq_ignore_ascii_case("auto") {
        return false;
    }
    !root
        .get(AUTO_INTERFACE_KEY)
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
}

fn is_virtual_adapter(name: &str, description: &str) -> bool {
    let hay = format!("{name} {description}").to_ascii_lowercase();
    const MARKERS: &[&str] = &[
        "mihomo",
        "wintun",
        "radmin",
        "vmware",
        "vmnet",
        "virtualbox",
        "vethernet",
        "hyper-v",
        "wsl",
        "loopback",
        "bluetooth",
        "wireguard",
        "nordlynx",
        "tailscale",
        "zerotier",
        "hamachi",
        "clash",
        "sing-box",
        "singbox",
        "teredo",
        "isatap",
        "miniport",
        "pseudo",
        "tunnel",
        "virtual",
        "npcap",
    ];
    if MARKERS.iter().any(|marker| hay.contains(marker)) {
        return true;
    }
    hay.split(|ch: char| !ch.is_ascii_alphanumeric())
        .any(|token| token == "tun" || token == "tap" || token == "vpn" || token.contains("wintun"))
}

fn if_type_is_virtual(if_type: u32) -> bool {
    // Loopback, PPP, proprietary virtual, tunnel.
    matches!(if_type, 24 | 23 | 53 | 131)
}

fn pick_outbound_interface(nics: &[OutboundNic], default_if_index: Option<u32>) -> Option<String> {
    if let Some(index) = default_if_index {
        if let Some(nic) = nics.iter().find(|nic| nic.if_index == index) {
            return Some(nic.name.clone());
        }
    }
    nics.iter()
        .filter(|nic| nic.has_gateway)
        .min_by_key(|nic| (nic.metric, nic.if_index))
        .map(|nic| nic.name.clone())
}

fn physical_outbound_interface() -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        let nics = list_outbound_nics();
        return pick_outbound_interface(&nics, default_ipv4_if_index());
    }
    #[cfg(not(target_os = "windows"))]
    {
        None
    }
}

#[cfg(target_os = "windows")]
fn wide_zstring(ptr: *const u16) -> String {
    use std::os::windows::ffi::OsStringExt;

    if ptr.is_null() {
        return String::new();
    }
    let mut len = 0usize;
    unsafe {
        while *ptr.add(len) != 0 {
            len += 1;
            if len >= 2048 {
                break;
            }
        }
        let slice = std::slice::from_raw_parts(ptr, len);
        std::ffi::OsString::from_wide(slice)
            .to_string_lossy()
            .into_owned()
    }
}

#[cfg(target_os = "windows")]
fn sockaddr_ipv4(
    address: windows_sys::Win32::Networking::WinSock::SOCKET_ADDRESS,
) -> Option<Ipv4Addr> {
    use windows_sys::Win32::Networking::WinSock::{AF_INET, SOCKADDR_IN};

    if address.lpSockaddr.is_null() {
        return None;
    }
    unsafe {
        if (*address.lpSockaddr).sa_family != AF_INET as u16 {
            return None;
        }
        if (address.iSockaddrLength as usize) < std::mem::size_of::<SOCKADDR_IN>() {
            return None;
        }
        let sin = &*(address.lpSockaddr as *const SOCKADDR_IN);
        let raw = sin.sin_addr.S_un.S_addr;
        Some(Ipv4Addr::from(u32::from_be(raw)))
    }
}

#[cfg(target_os = "windows")]
fn default_ipv4_if_index() -> Option<u32> {
    use windows_sys::Win32::NetworkManagement::IpHelper::{GetBestRoute, MIB_IPFORWARDROW};

    let dest = u32::from(Ipv4Addr::new(1, 1, 1, 1)).to_be();
    let mut row = unsafe { std::mem::zeroed::<MIB_IPFORWARDROW>() };
    let rc = unsafe { GetBestRoute(dest, 0, &mut row) };
    if rc == 0 && row.dwForwardIfIndex != 0 {
        Some(row.dwForwardIfIndex)
    } else {
        None
    }
}

#[cfg(target_os = "windows")]
fn list_outbound_nics() -> Vec<OutboundNic> {
    use std::ptr::null_mut;
    use windows_sys::Win32::NetworkManagement::IpHelper::{
        GAA_FLAG_INCLUDE_GATEWAYS, GAA_FLAG_INCLUDE_PREFIX, GetAdaptersAddresses,
        IP_ADAPTER_ADDRESSES_LH,
    };
    use windows_sys::Win32::NetworkManagement::Ndis::IfOperStatusUp;
    use windows_sys::Win32::Networking::WinSock::AF_INET;

    const ERROR_BUFFER_OVERFLOW: u32 = 111;

    unsafe {
        let mut size: u32 = 0;
        GetAdaptersAddresses(
            AF_INET as u32,
            GAA_FLAG_INCLUDE_PREFIX | GAA_FLAG_INCLUDE_GATEWAYS,
            null_mut(),
            null_mut(),
            &mut size,
        );
        if size == 0 {
            return Vec::new();
        }

        let mut buffer = vec![0u8; size as usize];
        let mut result = ERROR_BUFFER_OVERFLOW;
        for _ in 0..3 {
            result = GetAdaptersAddresses(
                AF_INET as u32,
                GAA_FLAG_INCLUDE_PREFIX | GAA_FLAG_INCLUDE_GATEWAYS,
                null_mut(),
                buffer.as_mut_ptr() as *mut IP_ADAPTER_ADDRESSES_LH,
                &mut size,
            );
            if result == 0 {
                break;
            }
            if result != ERROR_BUFFER_OVERFLOW {
                warn!("GetAdaptersAddresses failed with code {result}");
                return Vec::new();
            }
            buffer.resize(size as usize, 0);
        }
        if result != 0 {
            warn!("GetAdaptersAddresses failed with code {result}");
            return Vec::new();
        }

        let mut nics = Vec::new();
        let mut current = buffer.as_ptr() as *const IP_ADAPTER_ADDRESSES_LH;
        while !current.is_null() {
            let adapter = &*current;
            let name = wide_zstring(adapter.FriendlyName);
            let description = wide_zstring(adapter.Description);
            let if_index = adapter.Anonymous1.Anonymous.IfIndex;
            let up = adapter.OperStatus == IfOperStatusUp;
            let virtual_adapter =
                if_type_is_virtual(adapter.IfType) || is_virtual_adapter(&name, &description);

            let mut has_ipv4 = false;
            let mut addr_ptr = adapter.FirstUnicastAddress;
            while !addr_ptr.is_null() {
                let addr = &*addr_ptr;
                if sockaddr_ipv4(addr.Address).is_some_and(|ip| usable_proxy_ip(IpAddr::V4(ip))) {
                    has_ipv4 = true;
                    break;
                }
                addr_ptr = addr.Next;
            }

            let mut has_gateway = false;
            let mut gateway = adapter.FirstGatewayAddress;
            while !gateway.is_null() {
                let hop = &*gateway;
                if sockaddr_ipv4(hop.Address).is_some_and(|ip| usable_proxy_ip(IpAddr::V4(ip))) {
                    has_gateway = true;
                    break;
                }
                gateway = hop.Next;
            }

            if up && has_ipv4 && !virtual_adapter && !name.is_empty() {
                nics.push(OutboundNic {
                    name,
                    if_index,
                    metric: adapter.Ipv4Metric,
                    has_gateway,
                });
            }
            current = adapter.Next;
        }
        nics
    }
}

fn proxy_server_domains(root: &serde_yaml::Mapping) -> Vec<String> {
    let mut domains = Vec::new();
    let Some(seq) = root
        .get(&ykey("proxies"))
        .and_then(|value| value.as_sequence())
    else {
        return domains;
    };

    for proxy in seq {
        let Some(server) = proxy.get("server").and_then(|value| value.as_str()) else {
            continue;
        };
        let server = server.trim();
        if !is_domain_name(server) || domains.iter().any(|domain| domain == server) {
            continue;
        }
        domains.push(server.to_string());
    }

    domains
}

fn merge_fake_ip_filter(dns: &mut serde_yaml::Mapping, domains: &[String]) -> bool {
    if domains.is_empty() {
        return false;
    }

    let key = ykey("fake-ip-filter");
    if !dns.contains_key(&key) {
        dns.insert(
            key,
            serde_yaml::Value::Sequence(
                domains
                    .iter()
                    .map(|domain| serde_yaml::Value::String(domain.clone()))
                    .collect(),
            ),
        );
        return true;
    }

    let Some(seq) = dns.get_mut(&key).and_then(|value| value.as_sequence_mut()) else {
        return false;
    };

    let mut changed = false;
    for domain in domains {
        let exists = seq
            .iter()
            .any(|item| item.as_str() == Some(domain.as_str()));
        if !exists {
            seq.push(serde_yaml::Value::String(domain.clone()));
            changed = true;
        }
    }
    changed
}

/// Fills TUN, DNS and dialer keys that the pasted config did not set.
/// Existing values are left alone so a later edit is not overwritten.
fn apply_missing_defaults(root: &mut serde_yaml::Mapping) -> bool {
    let domains = proxy_server_domains(root);
    let mut changed = false;

    changed |= insert_if_absent(root, "tcp-concurrent", serde_yaml::Value::Bool(true));
    changed |= insert_if_absent(root, "unified-delay", serde_yaml::Value::Bool(true));
    changed |= insert_if_absent(root, "ipv6", serde_yaml::Value::Bool(false));

    if let Some(tun) = ensure_mapping(root, "tun", &mut changed) {
        changed |= insert_if_absent(tun, "enable", serde_yaml::Value::Bool(true));
        changed |= insert_if_absent(tun, "stack", serde_yaml::Value::String("mixed".to_string()));
        changed |= insert_if_absent(
            tun,
            "mtu",
            serde_yaml::Value::Number(serde_yaml::Number::from(1480u64)),
        );
        changed |= insert_if_absent(
            tun,
            "device",
            serde_yaml::Value::String("Mihomo".to_string()),
        );
        changed |= insert_if_absent(tun, "auto-route", serde_yaml::Value::Bool(true));
        changed |= insert_if_absent(tun, "auto-detect-interface", serde_yaml::Value::Bool(true));
        changed |= insert_if_absent(
            tun,
            "endpoint-independent-nat",
            serde_yaml::Value::Bool(true),
        );
        changed |= insert_if_absent(
            tun,
            "dns-hijack",
            yaml_string_seq(&["any:53", "tcp://any:53"]),
        );
        let auto_route = tun
            .get(&ykey("auto-route"))
            .and_then(|value| value.as_bool())
            .unwrap_or(true);
        if auto_route {
            changed |= insert_if_absent(
                tun,
                "dns-mode",
                serde_yaml::Value::String("hijack".to_string()),
            );
            changed |= insert_if_absent(tun, "strict-route", serde_yaml::Value::Bool(true));
        }
    }

    if let Some(dns) = ensure_mapping(root, "dns", &mut changed) {
        changed |= insert_if_absent(dns, "enable", serde_yaml::Value::Bool(true));
        changed |= insert_if_absent(
            dns,
            "enhanced-mode",
            serde_yaml::Value::String("fake-ip".to_string()),
        );
        changed |= insert_if_absent(
            dns,
            "fake-ip-range",
            serde_yaml::Value::String("198.18.0.1/16".to_string()),
        );
        changed |= insert_if_absent(
            dns,
            "default-nameserver",
            yaml_string_seq(&["1.1.1.1", "8.8.8.8"]),
        );
        changed |= insert_if_absent(
            dns,
            "nameserver",
            yaml_string_seq(&["https://1.1.1.1/dns-query", "https://8.8.8.8/dns-query"]),
        );
        changed |= insert_if_absent(
            dns,
            "proxy-server-nameserver",
            yaml_string_seq(&["1.1.1.1", "8.8.8.8"]),
        );
        changed |= insert_if_absent(dns, "ipv6", serde_yaml::Value::Bool(false));
        if sequence_nonempty(dns, "proxy-server-nameserver") {
            changed |= insert_if_absent(dns, "respect-rules", serde_yaml::Value::Bool(true));
        }
        changed |= merge_fake_ip_filter(dns, &domains);
    }

    changed
}

// ─── Получение списка сетевых интерфейсов ────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkInterface {
    pub name: String,
    pub display_name: String,
    pub is_up: bool,
}

#[tauri::command]
pub fn get_network_interfaces() -> Result<Vec<NetworkInterface>, String> {
    #[cfg(target_os = "windows")]
    {
        use std::ffi::OsString;
        use std::os::windows::ffi::OsStringExt;
        use std::ptr::null_mut;
        use windows_sys::Win32::NetworkManagement::IpHelper::{
            GAA_FLAG_INCLUDE_PREFIX, GetAdaptersAddresses, IP_ADAPTER_ADDRESSES_LH,
        };
        use windows_sys::Win32::Networking::WinSock::{AF_INET, AF_INET6, AF_UNSPEC};

        unsafe {
            let mut size: u32 = 0;
            // Первый вызов для получения размера буфера
            GetAdaptersAddresses(
                AF_UNSPEC as u32,
                GAA_FLAG_INCLUDE_PREFIX,
                null_mut(),
                null_mut(),
                &mut size,
            );

            if size == 0 {
                return Ok(Vec::new());
            }

            let mut buffer = vec![0u8; size as usize];
            let result = GetAdaptersAddresses(
                AF_UNSPEC as u32,
                GAA_FLAG_INCLUDE_PREFIX,
                null_mut(),
                buffer.as_mut_ptr() as *mut IP_ADAPTER_ADDRESSES_LH,
                &mut size,
            );

            if result != 0 {
                return Err(format!("GetAdaptersAddresses failed with code: {}", result));
            }

            let mut interfaces = Vec::new();
            let mut current = buffer.as_ptr() as *const IP_ADAPTER_ADDRESSES_LH;

            while !current.is_null() {
                let adapter = &*current;

                // Получаем friendly name (display name)
                let mut friendly_len = 0;
                let mut friendly_ptr = adapter.FriendlyName;
                while !friendly_ptr.is_null() && *friendly_ptr != 0 {
                    friendly_len += 1;
                    friendly_ptr = friendly_ptr.add(1);
                }

                let friendly_name = if friendly_len > 0 {
                    let slice = std::slice::from_raw_parts(adapter.FriendlyName, friendly_len);
                    OsString::from_wide(slice).to_string_lossy().to_string()
                } else {
                    // Fallback на AdapterName если FriendlyName пустой
                    std::ffi::CStr::from_ptr(adapter.AdapterName as *const i8)
                        .to_string_lossy()
                        .to_string()
                };

                // Проверяем, активен ли интерфейс (есть ли у него IP-адреса)
                let mut is_up = false;
                let mut addr_ptr = adapter.FirstUnicastAddress;
                while !addr_ptr.is_null() {
                    let addr = &*addr_ptr;
                    let sockaddr = &*addr.Address.lpSockaddr;
                    if sockaddr.sa_family == AF_INET || sockaddr.sa_family == AF_INET6 {
                        is_up = true;
                        break;
                    }
                    addr_ptr = addr.Next;
                }

                // Пропускаем loopback
                if !friendly_name.to_lowercase().contains("loopback") {
                    interfaces.push(NetworkInterface {
                        name: friendly_name.clone(),
                        display_name: friendly_name,
                        is_up,
                    });
                }

                current = adapter.Next;
            }

            // Сортируем: активные первыми, затем по имени
            interfaces.sort_by(|a, b| {
                b.is_up.cmp(&a.is_up).then_with(|| {
                    a.display_name
                        .to_lowercase()
                        .cmp(&b.display_name.to_lowercase())
                })
            });

            Ok(interfaces)
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        // Для Linux/macOS можно добавить реализацию позже
        Ok(Vec::new())
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── AmneziaWG / WireGuard .conf support ─────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

/// Парсит AmneziaWG / WireGuard .conf файл и возвращает YAML для proxy entry в Mihomo формате.
/// Добавляет persistent-keepalive: 25 по умолчанию (решает проблему обрыва соединения).
/// Использует оптимальный MTU из сети.
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
        proxy.insert("private-key".into(), serde_yaml::Value::String(pk.clone()));
    } else {
        return Err("Missing PrivateKey in [Interface] section".to_string());
    }

    if let Some(endpoint) = peer.get("endpoint") {
        if let Some((srv, prt_str)) = endpoint.rsplit_once(':') {
            proxy.insert("server".into(), serde_yaml::Value::String(srv.to_string()));
            if let Ok(p) = prt_str.trim().parse::<u16>() {
                proxy.insert(
                    "port".into(),
                    serde_yaml::Value::Number(serde_yaml::Number::from(p)),
                );
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
                proxy.insert(
                    "ipv6".into(),
                    serde_yaml::Value::String(ip_part.to_string()),
                );
            } else if ip_part.contains('.') {
                proxy.insert("ip".into(), serde_yaml::Value::String(ip_part.to_string()));
            }
        }
    }

    if let Some(pubk) = peer.get("publickey") {
        proxy.insert("public-key".into(), serde_yaml::Value::String(pubk.clone()));
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

    let amnezia_keys = [
        "jc", "jmin", "jmax", "s1", "s2", "s3", "s4", "h1", "h2", "h3", "h4",
    ];
    for key in amnezia_keys {
        if let Some(v) = interface.get(key) {
            if key.starts_with('h') {
                // H-параметры всегда строка (могут быть диапазонами "123-456")
                amnezia.insert(key.into(), serde_yaml::Value::String(v.clone()));
                has_amnezia = true;
            } else if let Ok(num) = v.parse::<i64>() {
                amnezia.insert(
                    key.into(),
                    serde_yaml::Value::Number(serde_yaml::Number::from(num)),
                );
                has_amnezia = true;
            }
        }
    }

    if has_amnezia {
        proxy.insert(
            "amnezia-wg-option".into(),
            serde_yaml::Value::Mapping(amnezia),
        );

        // Оптимальный MTU для AmneziaWG
        if proxy.get("mtu").is_none() {
            let optimal_mtu = crate::optimizations::detect_optimal_mtu();
            // AmneziaWG может требовать ещё меньший MTU
            let amnezia_mtu = optimal_mtu.min(1280);
            proxy.insert(
                "mtu".into(),
                serde_yaml::Value::Number(serde_yaml::Number::from(amnezia_mtu as u64)),
            );
        }

        if proxy.get("remote-dns-resolve").is_none() {
            proxy.insert("remote-dns-resolve".into(), serde_yaml::Value::Bool(true));
        }
    } else {
        // Обычный WireGuard - используем оптимальный MTU
        if proxy.get("mtu").is_none() {
            let optimal_mtu = crate::optimizations::detect_optimal_mtu();
            proxy.insert(
                "mtu".into(),
                serde_yaml::Value::Number(serde_yaml::Number::from(optimal_mtu as u64)),
            );
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
        (
            "name".into(),
            serde_yaml::Value::String("PROXY".to_string()),
        ),
        (
            "type".into(),
            serde_yaml::Value::String("select".to_string()),
        ),
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
    root.insert("mode".into(), serde_yaml::Value::String("rule".to_string()));
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
        serde_yaml::Value::Sequence(vec![serde_yaml::Value::String("MATCH,PROXY".to_string())]),
    );

    apply_missing_defaults(&mut root);

    serde_yaml::to_string(&root).map_err(|e| format!("Failed to serialize full config: {}", e))
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
    crate::api_cache::get_proxies_cached(mihomo_get_json_value(&["/v1/proxies", "/proxies"])).await
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

fn parse_mihomo_version(text: &str) -> Option<String> {
    for token in text.split_whitespace() {
        let rest = token.strip_prefix('v').unwrap_or(token);
        let mut parts = rest.split('.');
        let (Some(major), Some(minor), Some(patch)) = (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        if parts.next().is_some() {
            continue;
        }
        if major.chars().all(|c| c.is_ascii_digit())
            && minor.chars().all(|c| c.is_ascii_digit())
            && patch.chars().all(|c| c.is_ascii_digit())
        {
            return Some(format!("{major}.{minor}.{patch}"));
        }
    }
    None
}

#[tauri::command]
pub fn get_mihomo_core_version(app: AppHandle) -> Result<String, String> {
    let path = get_mihomo_path(&app);
    let mut cmd = Command::new(&path);
    cmd.arg("-v");
    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(0x08000000);
    }
    let out = cmd
        .output()
        .map_err(|e| format!("Failed to read Mihomo version: {e}"))?;
    let text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    parse_mihomo_version(&text).ok_or_else(|| format!("Unrecognized Mihomo version: {text}"))
}

#[tauri::command(rename_all = "camelCase")]
pub fn resolve_config_path(app: AppHandle, filename: String) -> Result<Option<String>, String> {
    Ok(find_existing_config_path(&app, &filename).map(|p| p.to_string_lossy().to_string()))
}

#[tauri::command(rename_all = "camelCase")]
pub fn open_config_file(app: AppHandle, filename: String) -> Result<String, String> {
    use tauri_plugin_opener::OpenerExt;

    let config_path = find_existing_config_path(&app, &filename)
        .unwrap_or_else(|| primary_config_dir(&app).join(&filename));

    if !config_path.exists() {
        return Err(format!(
            "Config file not found: {}",
            config_path.to_string_lossy()
        ));
    }

    let path_str = config_path.to_string_lossy().to_string();
    let opener = app.opener();

    if let Err(open_err) = opener.open_path(&path_str, None::<&str>) {
        opener.reveal_item_in_dir(&path_str).map_err(|reveal_err| {
            format!(
                "Failed to open config file: {}. Explorer fallback: {}",
                open_err, reveal_err
            )
        })?;
    }

    Ok(path_str)
}

#[tauri::command(rename_all = "camelCase")]
pub fn parse_config_yaml(content: String) -> Result<serde_json::Value, String> {
    let yaml: serde_yaml::Value =
        serde_yaml::from_str(&content).map_err(|e| format!("Failed to parse YAML: {}", e))?;
    serde_json::to_value(yaml).map_err(|e| format!("Failed to convert YAML: {}", e))
}

#[tauri::command(rename_all = "camelCase")]
pub fn stringify_config_yaml(value: serde_json::Value) -> Result<String, String> {
    let yaml: serde_yaml::Value =
        serde_json::from_value(value).map_err(|e| format!("Failed to convert JSON: {}", e))?;
    serde_yaml::to_string(&yaml).map_err(|e| format!("Failed to serialize YAML: {}", e))
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
                v.as_u64()
                    .or_else(|| v.as_str().and_then(|s| s.parse::<u64>().ok()))
            });
            let ptype = proxy.get("type").and_then(|v| v.as_str());

            if let (Some(name), Some(server), Some(port), Some(ptype)) = (name, server, port, ptype)
            {
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

#[cfg(not(target_os = "windows"))]
fn config_tun_enabled(config_content: &str) -> bool {
    serde_yaml::from_str::<serde_yaml::Value>(config_content)
        .ok()
        .and_then(|yaml| {
            yaml.get("tun")
                .and_then(|tun| tun.get("enable"))
                .and_then(|v| v.as_bool())
        })
        .unwrap_or(true)
}

#[tauri::command(rename_all = "camelCase")]
pub fn generate_config(
    base_config: String,
    user_rules: Vec<UserRule>,
    network_interface: Option<String>,
    tun_mode: Option<bool>,
) -> Result<String, String> {
    let mut yaml: serde_yaml::Value =
        serde_yaml::from_str(&base_config).map_err(|e| format!("Failed to parse YAML: {}", e))?;

    if yaml.get("external-controller").is_none() {
        yaml["external-controller"] = serde_yaml::Value::String("127.0.0.1:9090".to_string());
    }

    if let Some(iface) = network_interface {
        let iface = iface.trim();
        if !iface.is_empty() && !iface.eq_ignore_ascii_case("auto") {
            yaml["interface-name"] = serde_yaml::Value::String(iface.to_string());
            if let Some(map) = yaml.as_mapping_mut() {
                map.remove(&ykey(AUTO_INTERFACE_KEY));
            }
        }
    }

    if !user_rules.is_empty() {
        yaml["rules"] = serde_yaml::Value::Sequence(build_rules_from_user_rules(&user_rules));
    }

    if let Some(enable) = tun_mode {
        set_tun_enabled(&mut yaml, enable);
    }

    repair_vless_encryption(&mut yaml);
    normalize_vless_proxies(&mut yaml);
    ensure_tun_dns(&mut yaml);

    serde_yaml::to_string(&yaml).map_err(|e| format!("Failed to serialize YAML: {}", e))
}

#[tauri::command(rename_all = "camelCase")]
pub async fn import_config(
    app: AppHandle,
    config_content: String,
    filename: String,
    apply_defaults: Option<bool>,
) -> Result<String, String> {
    let config_path = find_existing_config_path(&app, &filename)
        .unwrap_or_else(|| primary_config_dir(&app).join(&filename));
    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create config dir: {}", e))?;
    }

    let apply_defaults = apply_defaults.unwrap_or(true);

    let content_to_write = match serde_yaml::from_str::<serde_yaml::Value>(&config_content) {
        Ok(mut yaml) => {
            let mut changed = false;
            if let Some(seq) = yaml.get_mut("rules").and_then(|r| r.as_sequence_mut()) {
                if seq.len() == 1 {
                    if let Some(only) = seq.first_mut() {
                        if let Some(s) = only.as_str() {
                            if s.trim() == "MATCH,DIRECT" {
                                *only = serde_yaml::Value::String("MATCH,PROXY".to_string());
                                changed = true;
                            }
                        }
                    }
                }
            }

            if apply_defaults {
                if let Some(map) = yaml.as_mapping_mut() {
                    if apply_missing_defaults(map) {
                        changed = true;
                    }
                }
            }

            if changed {
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

    fs::write(&config_path, new_content).map_err(|e| format!("Failed to write config: {}", e))?;
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
    fs::write(&config_path, new_content).map_err(|e| format!("Failed to write config: {}", e))?;
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub fn export_config_to_path(app: AppHandle, filename: String, path: String) -> Result<(), String> {
    let src_path = find_existing_config_path(&app, &filename)
        .ok_or_else(|| format!("Config file not found: {}", filename))?;

    let content = fs::read_to_string(&src_path)
        .map_err(|e| format!("Failed to read config {}: {}", filename, e))?;

    fs::write(PathBuf::from(path), content).map_err(|e| format!("Failed to export config: {}", e))
}

#[tauri::command(rename_all = "camelCase")]
pub fn restore_config_backup(app: AppHandle, filename: String) -> Result<String, String> {
    let config_path = find_existing_config_path(&app, &filename)
        .ok_or_else(|| format!("Config not found: {}", filename))?;

    let backup = config_path.with_extension("yml.bak");
    if !backup.exists() {
        return Err("No backup found".to_string());
    }

    fs::copy(&backup, &config_path).map_err(|e| format!("Failed to restore backup: {}", e))?;

    fs::read_to_string(&config_path).map_err(|e| format!("Failed to read restored config: {}", e))
}

#[tauri::command(rename_all = "camelCase")]
pub async fn start_vpn(
    app: AppHandle,
    config_content: String,
    config_filename: String,
) -> Result<VpnStatus, String> {
    let _lifecycle = VPN_LIFECYCLE.lock().await;
    let epoch = VPN_EPOCH.load(Ordering::SeqCst);
    #[cfg(not(target_os = "windows"))]
    {
        if config_tun_enabled(&config_content) && !has_admin_privileges() {
            return Err(
                "TUN requires elevated privileges. Disable TUN or run with sudo/root.".to_string(),
            );
        }
    }

    validate_config(&config_content)?;

    let config_dir = primary_config_dir(&app);
    fs::create_dir_all(&config_dir).map_err(|e| format!("Failed to create config dir: {}", e))?;

    let config_path = config_dir.join(&config_filename);
    let log_path = config_dir.join("mihomo.log");

    rotate_log_file(&log_path);

    let ports = config_listen_ports(&config_content);
    let app_for_stop = app.clone();
    tokio::task::spawn_blocking(move || ensure_previous_mihomo_stopped(&app_for_stop, &ports))
        .await
        .map_err(|err| format!("Failed to stop previous Mihomo: {err}"))??;

    if VPN_EPOCH.load(Ordering::SeqCst) != epoch {
        return Err("VPN stop requested".to_string());
    }

    let config_content = tokio::task::spawn_blocking(move || {
        let pinned = pin_proxy_server_addresses(&config_content);
        let nic = physical_outbound_interface();
        match nic.as_deref() {
            Some(name) => info!("Binding proxy dials to {name}"),
            None => warn!("No physical NIC found; proxy dials may re-enter TUN"),
        }
        bind_outbound_interface(&pinned, nic.as_deref())
    })
    .await
    .map_err(|err| format!("Failed to resolve proxy server: {err}"))?;
    fs::write(&config_path, &config_content)
        .map_err(|e| format!("Failed to write config: {}", e))?;

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

    let pid = child.id();

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    spawn_log_reader(stdout, stderr, log_path);

    {
        let mut process_guard = MIHOMO_PROCESS.lock().map_err(|e| e.to_string())?;
        *process_guard = Some(child);
    }

    // Сохраняем PID
    {
        let mut pid_guard = MIHOMO_PID.lock().map_err(|e| e.to_string())?;
        *pid_guard = Some(pid);
    }
    save_pid(&app, pid);

    // Запоминаем время старта
    {
        let mut guard = START_TIME.lock().map_err(|e| e.to_string())?;
        *guard = Some(std::time::Instant::now());
    }

    // Отмечаем старт в metrics
    crate::metrics::mark_vpn_started();

    update_controller_config(&config_content);

    if VPN_EPOCH.load(Ordering::SeqCst) != epoch {
        let app_for_stop = app.clone();
        let _ = tokio::task::spawn_blocking(move || force_stop_mihomo(&app_for_stop)).await;
        return Err("VPN stop requested".to_string());
    }

    if let Err(err) = wait_for_mihomo_ready(&app).await {
        let app_for_stop = app.clone();
        let _ = tokio::task::spawn_blocking(move || {
            let child = MIHOMO_PROCESS
                .lock()
                .ok()
                .and_then(|mut guard| guard.take());
            if let Some(mut child) = child {
                stop_tracked_child(&mut child);
            }
            if let Ok(mut guard) = MIHOMO_PID.lock() {
                if let Some(pid) = guard.take() {
                    let _ = kill_process_by_pid(pid);
                }
            }
            kill_existing_mihomo();
            clear_pid(&app_for_stop);
        })
        .await;
        return Err(err);
    }

    if VPN_EPOCH.load(Ordering::SeqCst) != epoch {
        let app_for_stop = app.clone();
        let _ = tokio::task::spawn_blocking(move || force_stop_mihomo(&app_for_stop)).await;
        return Err("VPN stop requested".to_string());
    }

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
    fs::create_dir_all(&config_dir).map_err(|e| format!("Failed to create config dir: {}", e))?;

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
pub async fn stop_vpn(app: AppHandle) -> Result<VpnStatus, String> {
    VPN_EPOCH.fetch_add(1, Ordering::SeqCst);
    let _lifecycle = tokio::time::timeout(Duration::from_millis(300), VPN_LIFECYCLE.lock())
        .await
        .ok();

    let app_for_stop = app.clone();
    tokio::task::spawn_blocking(move || force_stop_mihomo(&app_for_stop))
        .await
        .map_err(|err| format!("Failed to stop Mihomo: {err}"))?;

    // Сбрасываем время старта
    {
        let mut guard = START_TIME.lock().map_err(|e| e.to_string())?;
        *guard = None;
    }

    // Отмечаем остановку в metrics
    crate::metrics::mark_vpn_stopped();

    // Очищаем кеш API
    crate::api_cache::clear_cache();

    info!("VPN stopped successfully");

    Ok(VpnStatus {
        running: false,
        server: None,
        proxy_name: None,
        mode: "rule".to_string(),
        port: 7890,
    })
}

#[tauri::command]
pub fn get_vpn_status(app: AppHandle) -> Result<VpnStatus, String> {
    let mut process_guard = MIHOMO_PROCESS.lock().map_err(|e| e.to_string())?;

    // Проверяем, жив ли процесс
    let running = if let Some(ref mut child) = *process_guard {
        match child.try_wait() {
            Ok(Some(_)) => {
                process_guard.take();
                if let Ok(mut guard) = MIHOMO_PID.lock() {
                    *guard = None;
                }
                clear_pid(&app);
                false
            }
            _ => true,
        }
    } else {
        // Проверяем, может процесс осиротел
        if let Some(pid) = load_pid(&app) {
            if is_process_running(pid) {
                // Процесс жив, но не отслеживается - это осиротевший процесс
                if let Ok(mut guard) = MIHOMO_PID.lock() {
                    *guard = Some(pid);
                }
                true
            } else {
                clear_pid(&app);
                false
            }
        } else {
            false
        }
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

    let mut file = fs::File::open(&log_path).map_err(|e| format!("Failed to open logs: {}", e))?;

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

#[cfg(test)]
mod tests {
    use super::apply_missing_defaults;

    fn mapping_from(yaml: &str) -> serde_yaml::Mapping {
        let value: serde_yaml::Value = serde_yaml::from_str(yaml).unwrap();
        value.as_mapping().unwrap().clone()
    }

    fn child<'a>(value: &'a serde_yaml::Value, key: &str) -> &'a serde_yaml::Value {
        value.get(key).unwrap_or_else(|| panic!("missing {key}"))
    }

    #[test]
    fn defaults_fill_a_bare_proxy_config() {
        let mut root = mapping_from(
            r#"
proxies:
  - name: a
    type: vless
    server: example.com
    port: 443
"#,
        );
        assert!(apply_missing_defaults(&mut root));

        let yaml = serde_yaml::Value::Mapping(root);
        assert_eq!(child(&yaml, "tcp-concurrent").as_bool(), Some(true));
        assert_eq!(child(&yaml, "unified-delay").as_bool(), Some(true));

        let tun = child(&yaml, "tun");
        assert_eq!(child(tun, "enable").as_bool(), Some(true));
        assert_eq!(child(tun, "stack").as_str(), Some("mixed"));
        assert_eq!(child(tun, "mtu").as_u64(), Some(1480));
        assert_eq!(child(tun, "device").as_str(), Some("Mihomo"));
        assert_eq!(child(tun, "auto-route").as_bool(), Some(true));
        assert_eq!(child(tun, "auto-detect-interface").as_bool(), Some(true));
        assert_eq!(child(tun, "endpoint-independent-nat").as_bool(), Some(true));
        assert_eq!(child(tun, "dns-mode").as_str(), Some("hijack"));
        assert_eq!(child(tun, "strict-route").as_bool(), Some(true));
        let hijack = child(tun, "dns-hijack").as_sequence().unwrap();
        assert!(hijack.iter().any(|item| item.as_str() == Some("any:53")));
        assert!(
            hijack
                .iter()
                .any(|item| item.as_str() == Some("tcp://any:53"))
        );

        let dns = child(&yaml, "dns");
        assert_eq!(child(dns, "enable").as_bool(), Some(true));
        assert_eq!(child(dns, "enhanced-mode").as_str(), Some("fake-ip"));
        assert_eq!(child(dns, "fake-ip-range").as_str(), Some("198.18.0.1/16"));
        assert_eq!(child(dns, "ipv6").as_bool(), Some(false));
        assert_eq!(child(dns, "respect-rules").as_bool(), Some(true));
        assert_eq!(child(&yaml, "ipv6").as_bool(), Some(false));

        let nameserver = child(dns, "nameserver").as_sequence().unwrap();
        assert!(
            nameserver
                .iter()
                .any(|item| item.as_str() == Some("https://1.1.1.1/dns-query"))
        );
        assert!(
            child(dns, "default-nameserver")
                .as_sequence()
                .unwrap()
                .iter()
                .any(|item| item.as_str() == Some("1.1.1.1"))
        );
        assert!(
            child(dns, "proxy-server-nameserver")
                .as_sequence()
                .unwrap()
                .iter()
                .any(|item| item.as_str() == Some("8.8.8.8"))
        );
        assert!(
            child(dns, "fake-ip-filter")
                .as_sequence()
                .unwrap()
                .iter()
                .any(|item| item.as_str() == Some("example.com"))
        );
    }

    #[test]
    fn defaults_do_not_overwrite_nameserver_or_disabled_tun() {
        let mut root = mapping_from(
            r#"
tun:
  enable: false
dns:
  nameserver:
    - 9.9.9.9
proxies:
  - name: a
    type: ss
    server: 1.2.3.4
    port: 443
"#,
        );
        assert!(apply_missing_defaults(&mut root));

        let yaml = serde_yaml::Value::Mapping(root);
        assert_eq!(child(child(&yaml, "tun"), "enable").as_bool(), Some(false));
        assert_eq!(child(child(&yaml, "tun"), "mtu").as_u64(), Some(1480));

        let nameserver = child(child(&yaml, "dns"), "nameserver")
            .as_sequence()
            .unwrap();
        assert_eq!(nameserver.len(), 1);
        assert_eq!(nameserver[0].as_str(), Some("9.9.9.9"));
        assert!(child(&yaml, "dns").get("fake-ip-filter").is_none());
    }

    #[test]
    fn generate_config_fills_dns_hijack_for_an_existing_tun_config() {
        let yaml = r#"
ipv6: true
tun:
  enable: true
  auto-route: true
dns:
  enable: true
  enhanced-mode: fake-ip
  nameserver:
    - https://1.1.1.1/dns-query
  proxy-server-nameserver:
    - 1.1.1.1
proxies:
  - name: a
    type: vless
    server: example.com
    port: 443
"#;
        let out = super::generate_config(yaml.to_string(), Vec::new(), None, None).unwrap();
        let parsed: serde_yaml::Value = serde_yaml::from_str(&out).unwrap();
        assert_eq!(parsed["ipv6"].as_bool(), Some(true));
        assert_eq!(parsed["tun"]["dns-mode"].as_str(), Some("hijack"));
        assert_eq!(parsed["tun"]["strict-route"].as_bool(), Some(true));
        let hijack = parsed["tun"]["dns-hijack"].as_sequence().unwrap();
        assert!(
            hijack
                .iter()
                .any(|item| item.as_str() == Some("tcp://any:53"))
        );
        assert_eq!(parsed["dns"]["respect-rules"].as_bool(), Some(true));
        assert_eq!(parsed["dns"]["ipv6"].as_bool(), Some(false));
        assert_eq!(
            parsed["dns"]["nameserver"][0].as_str(),
            Some("https://1.1.1.1/dns-query")
        );
    }

    #[test]
    fn generate_config_keeps_explicit_dns_and_skips_disabled_tun() {
        let yaml = r#"
tun:
  enable: false
  dns-hijack:
    - 9.9.9.9:53
  dns-mode: disabled
  strict-route: false
dns:
  ipv6: true
  respect-rules: false
  nameserver:
    - 9.9.9.9
  proxy-server-nameserver: []
"#;
        let out = super::generate_config(yaml.to_string(), Vec::new(), None, None).unwrap();
        let parsed: serde_yaml::Value = serde_yaml::from_str(&out).unwrap();
        assert_eq!(parsed["tun"]["enable"].as_bool(), Some(false));
        assert_eq!(parsed["tun"]["dns-mode"].as_str(), Some("disabled"));
        assert_eq!(parsed["tun"]["strict-route"].as_bool(), Some(false));
        assert_eq!(parsed["tun"]["dns-hijack"][0].as_str(), Some("9.9.9.9:53"));
        assert_eq!(parsed["dns"]["ipv6"].as_bool(), Some(true));
        assert_eq!(parsed["dns"]["respect-rules"].as_bool(), Some(false));
        assert_eq!(parsed["dns"]["nameserver"][0].as_str(), Some("9.9.9.9"));
        assert!(parsed.get("ipv6").is_none());
    }

    #[test]
    fn generate_config_tun_mode_off_disables_tun() {
        let yaml = r#"
tun:
  enable: true
  stack: mixed
dns:
  nameserver:
    - https://1.1.1.1/dns-query
"#;
        let out = super::generate_config(yaml.to_string(), Vec::new(), None, Some(false)).unwrap();
        let parsed: serde_yaml::Value = serde_yaml::from_str(&out).unwrap();
        assert_eq!(parsed["tun"]["enable"].as_bool(), Some(false));
        assert_eq!(parsed["tun"]["stack"].as_str(), Some("mixed"));
        assert!(parsed["tun"].get("dns-hijack").is_none());
    }

    #[test]
    fn generate_config_tun_mode_on_enables_tun() {
        let yaml = r#"
tun:
  enable: false
dns:
  nameserver:
    - https://1.1.1.1/dns-query
  proxy-server-nameserver:
    - 1.1.1.1
"#;
        let out = super::generate_config(yaml.to_string(), Vec::new(), None, Some(true)).unwrap();
        let parsed: serde_yaml::Value = serde_yaml::from_str(&out).unwrap();
        assert_eq!(parsed["tun"]["enable"].as_bool(), Some(true));
        assert_eq!(parsed["tun"]["dns-mode"].as_str(), Some("hijack"));
        assert_eq!(parsed["dns"]["respect-rules"].as_bool(), Some(true));
    }

    #[test]
    fn pins_proxy_host_and_keeps_it_out_of_tun() {
        let mut yaml: serde_yaml::Value = serde_yaml::from_str(
            r#"
tun:
  enable: true
proxies:
  - name: a
    type: vless
    server: ge.nnfz.ru
"#,
        )
        .unwrap();
        super::pin_resolved_hosts(
            &mut yaml,
            &[("ge.nnfz.ru".to_string(), "48.102.186.130".parse().unwrap())],
        );
        assert_eq!(yaml["hosts"]["ge.nnfz.ru"].as_str(), Some("48.102.186.130"));
        assert_eq!(
            yaml["tun"]["route-exclude-address"][0].as_str(),
            Some("48.102.186.130/32")
        );

        super::pin_resolved_hosts(
            &mut yaml,
            &[("ge.nnfz.ru".to_string(), "9.9.9.9".parse().unwrap())],
        );
        assert_eq!(yaml["hosts"]["ge.nnfz.ru"].as_str(), Some("48.102.186.130"));
        assert_eq!(
            yaml["tun"]["route-exclude-address"]
                .as_sequence()
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn pin_skips_route_exclude_when_tun_is_off() {
        let mut yaml: serde_yaml::Value = serde_yaml::from_str(
            r#"
tun:
  enable: false
proxies:
  - name: a
    server: ge.nnfz.ru
"#,
        )
        .unwrap();
        super::pin_resolved_hosts(
            &mut yaml,
            &[("ge.nnfz.ru".to_string(), "48.102.186.130".parse().unwrap())],
        );
        assert_eq!(yaml["hosts"]["ge.nnfz.ru"].as_str(), Some("48.102.186.130"));
        assert!(yaml["tun"].get("route-exclude-address").is_none());
    }

    #[test]
    fn binds_dialer_to_the_physical_nic_when_tun_is_on() {
        let yaml = r#"
tun:
  enable: true
  route-exclude-address:
    - 48.102.186.130/32
dns:
  nameserver:
    - 1.1.1.1
    - 8.8.8.8
"#;
        let out = super::bind_outbound_interface(yaml, Some("Ethernet"));
        let parsed: serde_yaml::Value = serde_yaml::from_str(&out).unwrap();
        assert_eq!(parsed["interface-name"].as_str(), Some("Ethernet"));
        assert_eq!(parsed[super::AUTO_INTERFACE_KEY].as_bool(), Some(true));
        assert_eq!(
            parsed["tun"]["route-exclude-address"][0].as_str(),
            Some("48.102.186.130/32")
        );
        assert_eq!(parsed["dns"]["nameserver"][0].as_str(), Some("1.1.1.1"));
        assert_eq!(parsed["dns"]["nameserver"][1].as_str(), Some("8.8.8.8"));

        let again = super::bind_outbound_interface(&out, Some("Wi-Fi"));
        let parsed: serde_yaml::Value = serde_yaml::from_str(&again).unwrap();
        assert_eq!(parsed["interface-name"].as_str(), Some("Wi-Fi"));
    }

    #[test]
    fn keeps_a_user_chosen_interface_name() {
        let yaml = "interface-name: Wi-Fi\ntun:\n  enable: true\n";
        let out = super::bind_outbound_interface(yaml, Some("Ethernet"));
        assert_eq!(out, yaml);
    }

    #[test]
    fn skips_interface_bind_when_tun_is_off() {
        let yaml = "tun:\n  enable: false\n";
        let out = super::bind_outbound_interface(yaml, Some("Ethernet"));
        assert_eq!(out, yaml);
    }

    #[test]
    fn replaces_auto_interface_name() {
        let yaml = "interface-name: auto\ntun:\n  enable: true\n";
        let out = super::bind_outbound_interface(yaml, Some("Ethernet"));
        let parsed: serde_yaml::Value = serde_yaml::from_str(&out).unwrap();
        assert_eq!(parsed["interface-name"].as_str(), Some("Ethernet"));
    }

    #[test]
    fn generate_config_keeps_a_chosen_interface_and_drops_the_auto_marker() {
        let yaml = r#"
interface-name: Wi-Fi
rododendron-auto-interface: true
tun:
  enable: true
"#;
        let out = super::generate_config(
            yaml.to_string(),
            Vec::new(),
            Some("Ethernet".to_string()),
            None,
        )
        .unwrap();
        let parsed: serde_yaml::Value = serde_yaml::from_str(&out).unwrap();
        assert_eq!(parsed["interface-name"].as_str(), Some("Ethernet"));
        assert!(parsed.get(super::AUTO_INTERFACE_KEY).is_none());
    }

    #[test]
    fn pick_outbound_interface_prefers_the_default_route() {
        let nics = vec![
            super::OutboundNic {
                name: "Ethernet".to_string(),
                if_index: 12,
                metric: 25,
                has_gateway: true,
            },
            super::OutboundNic {
                name: "Wi-Fi".to_string(),
                if_index: 7,
                metric: 50,
                has_gateway: true,
            },
        ];
        assert_eq!(
            super::pick_outbound_interface(&nics, Some(7)).as_deref(),
            Some("Wi-Fi")
        );
        assert_eq!(
            super::pick_outbound_interface(&nics, Some(99)).as_deref(),
            Some("Ethernet")
        );
        assert_eq!(
            super::pick_outbound_interface(&nics, None).as_deref(),
            Some("Ethernet")
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_default_nic_is_not_virtual() {
        let Some(name) = super::physical_outbound_interface() else {
            return;
        };
        assert!(
            !super::is_virtual_adapter(&name, ""),
            "detected virtual adapter {name}"
        );
        eprintln!("outbound nic: {name}");
    }

    #[test]
    fn virtual_adapter_names_are_rejected() {
        assert!(super::is_virtual_adapter(
            "Mihomo",
            "Wintun Userspace Tunnel"
        ));
        assert!(super::is_virtual_adapter(
            "Radmin VPN",
            "Radmin VPN Ethernet Adapter"
        ));
        assert!(super::is_virtual_adapter(
            "VMware Network Adapter VMnet8",
            "VMware Virtual Ethernet Adapter for VMnet8"
        ));
        assert!(super::is_virtual_adapter(
            "vEthernet (Default Switch)",
            "Hyper-V Virtual Ethernet Adapter"
        ));
        assert!(super::is_virtual_adapter(
            "Loopback Pseudo-Interface 1",
            "Software Loopback Interface"
        ));
        assert!(!super::is_virtual_adapter(
            "Ethernet",
            "Realtek Gaming 2.5GbE Family Controller"
        ));
        assert!(!super::is_virtual_adapter(
            "Wi-Fi",
            "Intel(R) Wi-Fi 6 AX200 160MHz"
        ));
        assert!(super::if_type_is_virtual(131));
        assert!(!super::if_type_is_virtual(6));
        assert!(!super::if_type_is_virtual(71));
    }

    #[test]
    fn rejects_tun_fake_ip_as_proxy_address() {
        assert!(!super::usable_proxy_ip("198.18.0.5".parse().unwrap()));
        assert!(!super::usable_proxy_ip("127.0.0.1".parse().unwrap()));
        assert!(super::usable_proxy_ip("48.102.186.130".parse().unwrap()));
    }

    #[test]
    fn generate_config_moves_mlkem_packet_encoding_to_encryption() {
        let yaml = r#"
proxies:
  - name: moved
    type: vless
    packet-encoding: mlkem768x25519plus.native.0rtt.abc
  - name: kept
    type: vless
    encryption: already
    packet-encoding: mlkem768x25519plus.native.0rtt.other
  - name: xudp
    type: vless
    packet-encoding: xudp
"#;
        let out = super::generate_config(yaml.to_string(), Vec::new(), None, None).unwrap();
        let parsed: serde_yaml::Value = serde_yaml::from_str(&out).unwrap();
        assert_eq!(
            parsed["proxies"][0]["encryption"].as_str(),
            Some("mlkem768x25519plus.native.0rtt.abc")
        );
        assert!(parsed["proxies"][0].get("packet-encoding").is_none());
        assert_eq!(parsed["proxies"][1]["encryption"].as_str(), Some("already"));
        assert_eq!(
            parsed["proxies"][1]["packet-encoding"].as_str(),
            Some("mlkem768x25519plus.native.0rtt.other")
        );
        assert_eq!(
            parsed["proxies"][2]["packet-encoding"].as_str(),
            Some("xudp")
        );
        assert!(parsed["proxies"][2].get("encryption").is_none());
    }

    #[test]
    fn generate_config_does_not_inject_reality_mlkem() {
        let yaml = r#"
proxies:
  - name: a
    type: vless
    server: example.com
    port: 443
    reality-opts:
      public-key: abc+def/gw=
      short-id: "00"
      spider-x: "/from-the-link"
  - name: b
    type: vless
    reality-opts:
      public-key: kept
      spider-x: "/other"
      support-x25519mlkem768: true
"#;
        let out = super::generate_config(yaml.to_string(), Vec::new(), None, None).unwrap();
        let parsed: serde_yaml::Value = serde_yaml::from_str(&out).unwrap();
        let first = &parsed["proxies"][0]["reality-opts"];
        assert!(first.get("support-x25519mlkem768").is_none());
        assert_eq!(first["spider-x"].as_str(), Some("/from-the-link"));
        assert_eq!(first["public-key"].as_str(), Some("abc+def/gw="));
        let second = &parsed["proxies"][1]["reality-opts"];
        assert_eq!(second["support-x25519mlkem768"].as_bool(), Some(true));
        assert_eq!(second["spider-x"].as_str(), Some("/other"));
    }

    #[test]
    fn parses_mihomo_version_banner() {
        let banner = "Mihomo Meta v1.19.34 windows amd64 with go1.26.11 Wed Nov 11 06:51:15 UTC 2026\nUse tags: with_gvisor\n";
        assert_eq!(
            super::parse_mihomo_version(banner).as_deref(),
            Some("1.19.34")
        );
    }

    #[test]
    fn second_apply_changes_nothing() {
        let mut root = mapping_from("proxies: []\n");
        assert!(apply_missing_defaults(&mut root));
        assert!(!apply_missing_defaults(&mut root));
    }

    #[test]
    fn normalize_vless_reality_adds_client_fingerprint() {
        let yaml = r#"
proxies:
  - name: a
    type: vless
    server: 1.2.3.4
    port: 443
    reality-opts:
      public-key: abc
  - name: b
    type: vless
    server: 1.2.3.4
    port: 443
    reality-opts:
      public-key: abc
    client-fingerprint: firefox
  - name: c
    type: vmess
    server: 1.2.3.4
    port: 443
"#;
        let out = super::generate_config(yaml.to_string(), Vec::new(), None, None).unwrap();
        let parsed: serde_yaml::Value = serde_yaml::from_str(&out).unwrap();
        // REALITY без fingerprint — должен получить chrome
        assert_eq!(
            parsed["proxies"][0]["client-fingerprint"].as_str(),
            Some("chrome")
        );
        // REALITY с уже заданным fingerprint — не трогаем
        assert_eq!(
            parsed["proxies"][1]["client-fingerprint"].as_str(),
            Some("firefox")
        );
        // vmess — не трогаем
        assert!(parsed["proxies"][2].get("client-fingerprint").is_none());
    }

    #[test]
    fn normalize_vless_xhttp_adds_empty_opts() {
        let yaml = r#"
proxies:
  - name: a
    type: vless
    server: 1.2.3.4
    port: 443
    network: xhttp
  - name: b
    type: vless
    server: 1.2.3.4
    port: 443
    network: xhttp
    xhttp-opts:
      path: /data
  - name: c
    type: vless
    server: 1.2.3.4
    port: 443
    network: ws
"#;
        let out = super::generate_config(yaml.to_string(), Vec::new(), None, None).unwrap();
        let parsed: serde_yaml::Value = serde_yaml::from_str(&out).unwrap();
        // xhttp без opts — должен получить пустой маппинг
        assert!(parsed["proxies"][0].get("xhttp-opts").is_some());
        // xhttp с opts — не трогаем
        assert_eq!(
            parsed["proxies"][1]["xhttp-opts"]["path"].as_str(),
            Some("/data")
        );
        // ws — не трогаем
        assert!(parsed["proxies"][2].get("xhttp-opts").is_none());
    }

    #[test]
    fn validate_vless_requires_uuid() {
        let yaml = r#"
proxies:
  - name: bad
    type: vless
    server: 1.2.3.4
    port: 443
"#;
        assert!(super::validate_config(yaml).is_err());
    }

    #[test]
    fn validate_vless_reality_requires_public_key() {
        let yaml = r#"
proxies:
  - name: bad
    type: vless
    server: 1.2.3.4
    port: 443
    uuid: 11111111-1111-1111-1111-111111111111
    reality-opts:
      short-id: "00"
"#;
        let err = super::validate_config(yaml).unwrap_err();
        assert!(err.contains("public-key"), "error was: {err}");
    }

    #[test]
    fn validate_vless_reality_ok_with_public_key() {
        let yaml = r#"
proxies:
  - name: ok
    type: vless
    server: 1.2.3.4
    port: 443
    uuid: 11111111-1111-1111-1111-111111111111
    reality-opts:
      public-key: abc
      short-id: "00"
"#;
        assert!(super::validate_config(yaml).is_ok());
    }
}
