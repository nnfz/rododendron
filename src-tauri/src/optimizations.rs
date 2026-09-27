use std::process::Command;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

/// Определяет оптимальный MTU для сети
pub fn detect_optimal_mtu() -> u16 {
    #[cfg(target_os = "windows")]
    {
        if let Ok(output) = Command::new("netsh")
            .args(&["interface", "ipv4", "show", "subinterfaces"])
            .creation_flags(0x08000000)
            .output()
        {
            if let Ok(stdout) = String::from_utf8(output.stdout) {
                // Парсим вывод и находим минимальный MTU активных интерфейсов
                let mut min_mtu: Option<u16> = None;

                for line in stdout.lines().skip(2) {
                    let parts: Vec<&str> = line.split_whitespace().collect();
                    if parts.len() >= 2 {
                        if let Ok(mtu) = parts[0].parse::<u16>() {
                            // Игнорируем loopback (обычно MTU > 60000)
                            if mtu < 10000 {
                                min_mtu = Some(min_mtu.map_or(mtu, |current| current.min(mtu)));
                            }
                        }
                    }
                }

                if let Some(mtu) = min_mtu {
                    // Вычитаем 80 байт для WireGuard заголовков
                    return mtu.saturating_sub(80).max(1280);
                }
            }
        }
    }

    #[cfg(target_os = "linux")]
    {
        use std::fs;
        if let Ok(entries) = fs::read_dir("/sys/class/net") {
            let mut min_mtu: Option<u16> = None;

            for entry in entries.flatten() {
                let iface = entry.path();
                let mtu_path = iface.join("mtu");

                if let Ok(mtu_str) = fs::read_to_string(&mtu_path) {
                    if let Ok(mtu) = mtu_str.trim().parse::<u16>() {
                        // Игнорируем loopback
                        if mtu < 10000 {
                            min_mtu = Some(min_mtu.map_or(mtu, |current| current.min(mtu)));
                        }
                    }
                }
            }

            if let Some(mtu) = min_mtu {
                return mtu.saturating_sub(80).max(1280);
            }
        }
    }

    // Безопасное дефолтное значение для большинства сетей
    1420
}

/// Оптимизирует TCP стек для VPN
pub fn optimize_tcp_stack() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use tracing::debug;

        // Включаем TCP Fast Open если доступно
        let _ = Command::new("netsh")
            .args(&["int", "tcp", "set", "global", "fastopen=enabled"])
            .creation_flags(0x08000000)
            .output();

        // Автонастройка receive window
        let _ = Command::new("netsh")
            .args(&["int", "tcp", "set", "global", "autotuninglevel=normal"])
            .creation_flags(0x08000000)
            .output();

        // RSS (Receive Side Scaling)
        let _ = Command::new("netsh")
            .args(&["int", "tcp", "set", "global", "rss=enabled"])
            .creation_flags(0x08000000)
            .output();

        debug!("TCP stack optimizations applied (Windows)");
    }

    #[cfg(target_os = "linux")]
    {
        use std::fs;
        use tracing::{debug, warn};

        // TCP BBR congestion control (если доступен)
        if let Err(e) = fs::write("/proc/sys/net/ipv4/tcp_congestion_control", "bbr") {
            warn!("Failed to enable BBR: {}. Trying cubic...", e);
            let _ = fs::write("/proc/sys/net/ipv4/tcp_congestion_control", "cubic");
        }

        // Увеличиваем буферы TCP
        let _ = fs::write("/proc/sys/net/core/rmem_max", "16777216");
        let _ = fs::write("/proc/sys/net/core/wmem_max", "16777216");
        let _ = fs::write("/proc/sys/net/ipv4/tcp_rmem", "4096 87380 16777216");
        let _ = fs::write("/proc/sys/net/ipv4/tcp_wmem", "4096 65536 16777216");

        // TCP Fast Open
        let _ = fs::write("/proc/sys/net/ipv4/tcp_fastopen", "3");

        debug!("TCP stack optimizations applied (Linux)");
    }

    #[cfg(target_os = "macos")]
    {
        use tracing::debug;
        // macOS обычно уже хорошо настроен, но можно улучшить буферы
        let _ = Command::new("sysctl")
            .args(&["-w", "net.inet.tcp.recvspace=1048576"])
            .output();

        let _ = Command::new("sysctl")
            .args(&["-w", "net.inet.tcp.sendspace=1048576"])
            .output();

        debug!("TCP stack optimizations applied (macOS)");
    }

    Ok(())
}

/// Строит оптимизированную DNS конфигурацию для mihomo
pub fn build_optimized_dns_config() -> serde_yaml::Mapping {
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

    // Используем более быстрые DNS резолверы с HTTP/3
    dns.insert(
        "nameserver".into(),
        serde_yaml::Value::Sequence(vec![
            // Cloudflare DNS с HTTP/3 для минимальной задержки
            serde_yaml::Value::String("https://1.1.1.1/dns-query#h3=true".to_string()),
            // TLS fallback
            serde_yaml::Value::String("tls://1.1.1.1".to_string()),
            // Google DNS fallback
            serde_yaml::Value::String("https://8.8.8.8/dns-query".to_string()),
        ]),
    );

    // DNS кеширование
    dns.insert("cache".into(), serde_yaml::Value::Bool(true));

    // Обычный DNS fallback для случаев когда DoH недоступен
    dns.insert(
        "fallback".into(),
        serde_yaml::Value::Sequence(vec![
            serde_yaml::Value::String("1.1.1.1".to_string()),
            serde_yaml::Value::String("8.8.8.8".to_string()),
        ]),
    );

    // Правила fallback - использовать его для CN доменов
    let mut fallback_filter = serde_yaml::Mapping::new();
    fallback_filter.insert("geoip".into(), serde_yaml::Value::Bool(true));
    fallback_filter.insert(
        "geoip-code".into(),
        serde_yaml::Value::String("CN".to_string()),
    );
    fallback_filter.insert("ipcidr".into(), serde_yaml::Value::Sequence(vec![
        serde_yaml::Value::String("240.0.0.0/4".to_string()),
    ]));
    dns.insert(
        "fallback-filter".into(),
        serde_yaml::Value::Mapping(fallback_filter),
    );

    dns.insert(
        "default-nameserver".into(),
        serde_yaml::Value::Sequence(vec![
            serde_yaml::Value::String("1.1.1.1".to_string()),
            serde_yaml::Value::String("8.8.8.8".to_string()),
        ]),
    );

    dns
}

/// Добавляет оптимизации dialer в конфиг mihomo
pub fn add_dialer_optimizations(root: &mut serde_yaml::Mapping) {
    // Global client fingerprint для обхода DPI
    root.insert(
        "global-client-fingerprint".into(),
        serde_yaml::Value::String("chrome".to_string()),
    );

    // TCP настройки
    root.insert(
        "tcp-concurrent".into(),
        serde_yaml::Value::Bool(true),
    );

    // Отключаем Nagle для уменьшения задержки
    root.insert(
        "tcp-no-delay".into(),
        serde_yaml::Value::Bool(true),
    );

    // Keep-alive интервал
    root.insert(
        "keep-alive-interval".into(),
        serde_yaml::Value::Number(serde_yaml::Number::from(30u64)),
    );
}
