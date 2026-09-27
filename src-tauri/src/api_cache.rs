use serde_json::Value as JsonValue;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

#[derive(Clone)]
struct CachedResponse {
    data: JsonValue,
    cached_at: Instant,
}

struct ApiCache {
    proxies: Option<CachedResponse>,
    ttl_proxies: Duration,
}

impl ApiCache {
    fn new() -> Self {
        Self {
            proxies: None,
            ttl_proxies: Duration::from_secs(2),
        }
    }

    fn get_proxies(&self) -> Option<JsonValue> {
        self.proxies.as_ref().and_then(|cached| {
            if cached.cached_at.elapsed() < self.ttl_proxies {
                Some(cached.data.clone())
            } else {
                None
            }
        })
    }

    fn set_proxies(&mut self, data: JsonValue) {
        self.proxies = Some(CachedResponse {
            data,
            cached_at: Instant::now(),
        });
    }

    fn clear(&mut self) {
        self.proxies = None;
    }
}

static API_CACHE: LazyLock<Arc<Mutex<ApiCache>>> =
    LazyLock::new(|| Arc::new(Mutex::new(ApiCache::new())));

pub async fn get_proxies_cached(
    fetcher: impl std::future::Future<Output = Result<JsonValue, String>>,
) -> Result<JsonValue, String> {
    // Проверяем кеш
    {
        let cache = API_CACHE.lock().unwrap();
        if let Some(data) = cache.get_proxies() {
            return Ok(data);
        }
    }

    // Запрашиваем свежие данные
    let data = fetcher.await?;

    // Сохраняем в кеш
    {
        let mut cache = API_CACHE.lock().unwrap();
        cache.set_proxies(data.clone());
    }

    Ok(data)
}

pub fn clear_cache() {
    let mut cache = API_CACHE.lock().unwrap();
    cache.clear();
}
