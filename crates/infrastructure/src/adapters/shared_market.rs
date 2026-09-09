//! Bounded RAM-only request coalescing plus the declared live-stream/REST repair
//! protocol. The same price source and interval coverage policy apply to both.
use chrono::{DateTime, Utc};
use futures_util::FutureExt;
use scorebook_core::{
    error::{Error, RetryDirective},
    market::{MarketDataProvider, ProviderFuture},
};
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};
type Flight =
    futures_util::future::Shared<futures_util::future::BoxFuture<'static, Result<Value, Error>>>;
struct Entry {
    completed: Arc<std::sync::Mutex<Option<Instant>>>,
    id: uuid::Uuid,
    future: Flight,
}
#[derive(Clone)]
pub struct SharedMarket {
    provider: Arc<dyn MarketDataProvider>,
    flights: Arc<tokio::sync::Mutex<HashMap<String, Entry>>>,
    permits: Arc<tokio::sync::Semaphore>,
    streams: super::market_stream::MarketStreams,
}
impl SharedMarket {
    pub fn new(provider: Arc<dyn MarketDataProvider>) -> Self {
        Self {
            provider,
            flights: Default::default(),
            permits: Arc::new(tokio::sync::Semaphore::new(4)),
            streams: Default::default(),
        }
    }
    async fn get(
        &self,
        key: String,
        f: impl std::future::Future<Output = Result<Value, Error>> + Send + 'static,
    ) -> Result<Value, Error> {
        let (flight, id) = {
            let mut entries = self.flights.lock().await;
            entries.retain(|_, e| {
                e.completed
                    .lock()
                    .unwrap()
                    .is_none_or(|at| at.elapsed() < Duration::from_secs(15))
            });
            if entries.len() >= 8 && !entries.contains_key(&key) {
                return Err(Error::deferred(
                    "market_request_capacity",
                    RetryDirective::After(2),
                ));
            }
            let e = entries.entry(key.clone()).or_insert_with(|| {
                let permits = self.permits.clone();
                let id = uuid::Uuid::new_v4();
                let completed = Arc::new(std::sync::Mutex::new(None));
                let done = completed.clone();
                let registry = Arc::downgrade(&self.flights);
                let request_key = key.clone();
                // A detached, timed task keeps polling after a caller disconnects.
                // Active requests are never evicted by the completed-result TTL.
                let task = tokio::spawn(async move {
                    let result = tokio::time::timeout(Duration::from_secs(120), async {
                        let _p = permits
                            .acquire_owned()
                            .await
                            .map_err(|_| Error::transient("market_pool_closed"))?;
                        f.await
                    })
                    .await
                    .unwrap_or_else(|_| Err(Error::transient("market_request_timeout")));
                    *done.lock().unwrap() = Some(Instant::now());
                    if (result.is_err()
                        || result
                            .as_ref()
                            .is_ok_and(|v| estimated_size(v) > 4 * 1024 * 1024))
                        && let Some(registry) = registry.upgrade()
                    {
                        let mut entries = registry.lock().await;
                        if entries.get(&request_key).is_some_and(|e| e.id == id) {
                            entries.remove(&request_key);
                        }
                    }
                    result
                });
                Entry {
                    completed,
                    id,
                    future: async move {
                        task.await
                            .map_err(|_| Error::transient("market_request_task_failed"))?
                    }
                    .boxed()
                    .shared(),
                }
            });
            (e.future.clone(), e.id)
        };
        let result = flight.await;
        if result.as_ref().is_err()
            || result
                .as_ref()
                .is_ok_and(|v| estimated_size(v) > 4 * 1024 * 1024)
        {
            let mut entries = self.flights.lock().await;
            if entries.get(&key).is_some_and(|e| e.id == id) {
                entries.remove(&key);
            }
        }
        result
    }
}
fn estimated_size(v: &Value) -> usize {
    match v {
        Value::String(s) => s.len() + 32,
        Value::Array(a) => 32 + a.iter().map(estimated_size).sum::<usize>(),
        Value::Object(m) => {
            64 + m
                .iter()
                .map(|(k, v)| k.len() + 64 + estimated_size(v))
                .sum::<usize>()
        }
        _ => 32,
    }
}
impl MarketDataProvider for SharedMarket {
    fn klines<'a>(
        &'a self,
        m: &'a str,
        s: &'a str,
        i: &'a str,
        a: DateTime<Utc>,
        b: DateTime<Utc>,
    ) -> ProviderFuture<'a> {
        Box::pin(async move {
            let key = format!("k:{m}:{s}:{i}:{a}:{b}");
            let (p, m, s, i) = (
                self.provider.clone(),
                m.to_string(),
                s.to_string(),
                i.to_string(),
            );
            self.get(key, async move { p.klines(&m, &s, &i, a, b).await })
                .await
        })
    }
    fn trades<'a>(
        &'a self,
        m: &'a str,
        s: &'a str,
        a: DateTime<Utc>,
        b: DateTime<Utc>,
    ) -> ProviderFuture<'a> {
        Box::pin(async move {
            if let Some(v) = self.streams.trades(m, s, a, b) {
                return Ok(v);
            }
            let key = format!("t:{m}:{s}:{a}:{b}");
            let (p, m, s) = (self.provider.clone(), m.to_string(), s.to_string());
            self.get(key, async move { p.trades(&m, &s, a, b).await })
                .await
        })
    }
    fn exchange_info<'a>(&'a self, m: &'a str) -> ProviderFuture<'a> {
        Box::pin(async move {
            let key = format!("i:{m}");
            let (p, m) = (self.provider.clone(), m.to_string());
            self.get(key, async move { p.exchange_info(&m).await })
                .await
        })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    struct Count(std::sync::atomic::AtomicUsize);
    impl MarketDataProvider for Count {
        fn klines<'a>(
            &'a self,
            _: &'a str,
            _: &'a str,
            _: &'a str,
            _: DateTime<Utc>,
            _: DateTime<Utc>,
        ) -> ProviderFuture<'a> {
            Box::pin(async move {
                self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(30)).await;
                Ok(serde_json::json!({"bars":[],"coverage_complete":true}))
            })
        }
        fn trades<'a>(
            &'a self,
            _: &'a str,
            _: &'a str,
            _: DateTime<Utc>,
            _: DateTime<Utc>,
        ) -> ProviderFuture<'a> {
            Box::pin(async { unreachable!() })
        }
        fn exchange_info<'a>(&'a self, _: &'a str) -> ProviderFuture<'a> {
            Box::pin(async { unreachable!() })
        }
    }
    #[tokio::test]
    async fn concurrent_identical_ranges_have_one_provider_call() {
        let p = Arc::new(Count(std::sync::atomic::AtomicUsize::new(0)));
        let s = SharedMarket::new(p.clone());
        let now = Utc::now();
        let values = futures_util::future::join_all((0..12).map(|_| {
            s.klines(
                "usd_m",
                "BTCUSDT",
                "1h",
                now - chrono::Duration::days(2),
                now - chrono::Duration::days(1),
            )
        }))
        .await;
        assert!(values.into_iter().all(|v| v.is_ok()));
        assert_eq!(p.0.load(std::sync::atomic::Ordering::SeqCst), 1);
    }
}
