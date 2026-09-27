use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex, LazyLock};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VpnMetrics {
    pub latency_ms: Option<u32>,
    pub packet_loss_percent: f32,
    pub bandwidth_up_mbps: f32,
    pub bandwidth_down_mbps: f32,
    pub uptime_secs: u64,
    pub total_up_bytes: u64,
    pub total_down_bytes: u64,
}

#[derive(Debug, Clone)]
struct TrafficSnapshot {
    up: u64,
    down: u64,
    timestamp: Instant,
}

static TRAFFIC_HISTORY: LazyLock<Arc<Mutex<Vec<TrafficSnapshot>>>> =
    LazyLock::new(|| Arc::new(Mutex::new(Vec::new())));

static START_TIME: LazyLock<Arc<Mutex<Option<Instant>>>> =
    LazyLock::new(|| Arc::new(Mutex::new(None)));

pub fn mark_vpn_started() {
    if let Ok(mut guard) = START_TIME.lock() {
        *guard = Some(Instant::now());
    }
}

pub fn mark_vpn_stopped() {
    if let Ok(mut guard) = START_TIME.lock() {
        *guard = None;
    }
    if let Ok(mut history) = TRAFFIC_HISTORY.lock() {
        history.clear();
    }
}

pub fn record_traffic_snapshot(up: u64, down: u64) {
    if let Ok(mut history) = TRAFFIC_HISTORY.lock() {
        let snapshot = TrafficSnapshot {
            up,
            down,
            timestamp: Instant::now(),
        };

        history.push(snapshot);

        // Храним только последние 60 секунд
        let cutoff = Instant::now() - Duration::from_secs(60);
        history.retain(|s| s.timestamp > cutoff);
    }
}

pub fn calculate_bandwidth() -> (f32, f32) {
    if let Ok(history) = TRAFFIC_HISTORY.lock() {
        if history.len() < 2 {
            return (0.0, 0.0);
        }

        // Берём последние 5 секунд для более точного расчёта
        let cutoff = Instant::now() - Duration::from_secs(5);
        let recent: Vec<_> = history.iter().filter(|s| s.timestamp > cutoff).collect();

        if recent.len() < 2 {
            return (0.0, 0.0);
        }

        let first = recent.first().unwrap();
        let last = recent.last().unwrap();

        let duration_secs = last.timestamp.duration_since(first.timestamp).as_secs_f32();
        if duration_secs < 0.1 {
            return (0.0, 0.0);
        }

        let up_bytes = last.up.saturating_sub(first.up);
        let down_bytes = last.down.saturating_sub(first.down);

        let up_mbps = (up_bytes as f32 * 8.0) / (duration_secs * 1_000_000.0);
        let down_mbps = (down_bytes as f32 * 8.0) / (duration_secs * 1_000_000.0);

        (up_mbps, down_mbps)
    } else {
        (0.0, 0.0)
    }
}

pub fn get_uptime_secs() -> u64 {
    if let Ok(guard) = START_TIME.lock() {
        guard.as_ref().map(|t| t.elapsed().as_secs()).unwrap_or(0)
    } else {
        0
    }
}

#[tauri::command]
pub async fn get_vpn_metrics() -> Result<VpnMetrics, String> {
    use crate::mihomo::mihomo_get_traffic;

    // Получаем текущий трафик
    let traffic = mihomo_get_traffic().await.ok();

    let (total_up, total_down) = if let Some(t) = &traffic {
        (t.up, t.down)
    } else {
        (0, 0)
    };

    // Записываем snapshot для расчёта bandwidth
    if let Some(t) = traffic {
        record_traffic_snapshot(t.up, t.down);
    }

    // Измеряем латентность через простой API запрос
    let start = Instant::now();
    let latency = if crate::mihomo::mihomo_get_json_value(&["/configs"]).await.is_ok() {
        Some(start.elapsed().as_millis() as u32)
    } else {
        None
    };

    let (bandwidth_up_mbps, bandwidth_down_mbps) = calculate_bandwidth();

    Ok(VpnMetrics {
        latency_ms: latency,
        packet_loss_percent: 0.0, // TODO: implement via ping series
        bandwidth_up_mbps,
        bandwidth_down_mbps,
        uptime_secs: get_uptime_secs(),
        total_up_bytes: total_up,
        total_down_bytes: total_down,
    })
}
