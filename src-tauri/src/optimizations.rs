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

/// OS-wide TCP tweaks. Not called on VPN start: netsh/sysctl can stall for
/// seconds when the machine is low on memory.
#[allow(dead_code)]
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
