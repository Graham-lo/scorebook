use crate::{
    domain::criteria::{Bar, dec},
    error::{Error, Result},
};
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
#[derive(Clone)]
pub struct Binance {
    client: reqwest::Client,
    budget: super::provider_budget::ProviderBudget,
}
impl crate::application::ports::MarketDataProvider for Binance {
    fn klines<'a>(
        &'a self,
        market: &'a str,
        symbol: &'a str,
        interval: &'a str,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    ) -> crate::application::ports::ProviderFuture<'a> {
        Box::pin(async move {
            self.klines(market, symbol, interval, start, end)
                .await
                .map_err(Into::into)
        })
    }
    fn trades<'a>(
        &'a self,
        market: &'a str,
        symbol: &'a str,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    ) -> crate::application::ports::ProviderFuture<'a> {
        Box::pin(async move {
            self.trades(market, symbol, start, end)
                .await
                .map_err(Into::into)
        })
    }
    fn exchange_info<'a>(
        &'a self,
        market: &'a str,
    ) -> crate::application::ports::ProviderFuture<'a> {
        Box::pin(async move { self.exchange_info(market).await.map_err(Into::into) })
    }
}
impl Binance {
    pub fn new(pool: sqlx::PgPool) -> anyhow::Result<Self> {
        Ok(Self {
            budget: super::provider_budget::ProviderBudget::new(pool)?,
            client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(20))
                .build()?,
        })
    }
    pub async fn klines(
        &self,
        market: &str,
        symbol: &str,
        interval: &str,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    ) -> Result<Value> {
        if symbol.is_empty()
            || symbol.len() > 40
            || !symbol
                .chars()
                .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
        {
            return Err(Error::bad("invalid_symbol"));
        }
        let duration = match interval {
            "1m" => 60,
            "5m" => 300,
            "15m" => 900,
            "1h" => 3600,
            "4h" => 14400,
            "1d" => 86400,
            _ => return Err(Error::bad("unsupported_interval")),
        };
        if start >= end || (end - start).num_seconds() / duration > 50_000 {
            return Err(Error::bad("market_range_too_large"));
        }
        let url = match market {
            "usd_m" => "https://fapi.binance.com/fapi/v1/klines",
            "coin_m" => "https://dapi.binance.com/dapi/v1/klines",
            _ => return Err(Error::bad("market_not_supported")),
        };
        let mut cursor = start.timestamp_millis();
        let mut raw = Vec::<Value>::new();
        let mut bars = Vec::<Bar>::new();
        let mut current = Vec::<Value>::new();
        let mut gap = false;
        let mut expected = None;
        loop {
            self.budget.reserve(market, 5).await?;
            let response = self
                .client
                .get(url)
                .query(&[
                    ("symbol", symbol.to_string()),
                    ("interval", interval.to_string()),
                    ("startTime", cursor.to_string()),
                    ("endTime", (end.timestamp_millis() - 1).to_string()),
                    ("limit", "1000".into()),
                ])
                .send()
                .await
                .map_err(anyhow::Error::from)?;
            let page: Vec<Value> = self.decode(market, response).await?;
            if page.is_empty() {
                break;
            }
            let received = Utc::now();
            let mut next = cursor;
            for row in &page {
                let r = row
                    .as_array()
                    .ok_or_else(|| Error::bad("invalid_provider_payload"))?;
                if r.len() < 7 {
                    return Err(Error::bad("invalid_provider_payload"));
                }
                let at = r[0]
                    .as_i64()
                    .ok_or_else(|| Error::bad("invalid_provider_timestamp"))?;
                let to = r[6]
                    .as_i64()
                    .ok_or_else(|| Error::bad("invalid_provider_timestamp"))?
                    + 1;
                if at < cursor || to <= at {
                    return Err(Error::bad("provider_pagination_overlap"));
                }
                next = to;
                let a = DateTime::from_timestamp_millis(at)
                    .ok_or_else(|| Error::bad("invalid_provider_timestamp"))?;
                let b = DateTime::from_timestamp_millis(to)
                    .ok_or_else(|| Error::bad("invalid_provider_timestamp"))?;
                let string = |j: usize| -> Result<String> {
                    let s = r[j]
                        .as_str()
                        .ok_or_else(|| Error::bad("invalid_provider_price"))?;
                    dec(s).map_err(Error::bad)?;
                    Ok(s.into())
                };
                if b > received || a < start || b > end {
                    current.push(row.clone());
                    continue;
                }
                if expected.is_some_and(|x| x != a) {
                    gap = true
                }
                expected = Some(b);
                bars.push(Bar {
                    start: a,
                    end: b,
                    open: string(1)?,
                    high: string(2)?,
                    low: string(3)?,
                    close: string(4)?,
                });
            }
            raw.extend(page.iter().cloned());
            if next <= cursor {
                return Err(Error::bad("provider_pagination_stalled"));
            }
            cursor = next;
            if page.len() < 1000 || cursor >= end.timestamp_millis() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }
        let complete = !gap
            && bars.first().is_some_and(|b| b.start == start)
            && bars.last().is_some_and(|b| b.end == end);
        Ok(
            json!({"provider":"binance","market":market,"instrument":symbol,"price_type":"trade","interval":interval,"requested_start":start,"requested_end":end,"received_at":Utc::now(),"asof_at":bars.last().map(|b|b.end),"bars":bars,"incomplete_or_boundary_bars":current,"raw":raw,"coverage_complete":complete,"endpoint_policy":"completed_bar_close_only","asof_last_trade_proven":false,"identity":"historical_reconstruction_not_user_seen"}),
        )
    }
}

impl Binance {
    /// Fetch every aggregate trade in a bounded interval, retaining endpoint coverage evidence.
    pub async fn trades(
        &self,
        market: &str,
        symbol: &str,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    ) -> Result<Value> {
        if start >= end
            || (end - start).num_minutes() > 5
            || symbol.is_empty()
            || !symbol
                .chars()
                .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
        {
            return Err(Error::bad("invalid_trade_range"));
        }
        let url = match market {
            "usd_m" => "https://fapi.binance.com/fapi/v1/aggTrades",
            "coin_m" => "https://dapi.binance.com/dapi/v1/aggTrades",
            _ => return Err(Error::bad("market_not_supported")),
        };
        let mut all = vec![];
        let mut from = None;
        let mut complete = false;
        for _ in 0..100 {
            let mut params = vec![("symbol", symbol.to_string()), ("limit", "1000".into())];
            if let Some(id) = from {
                params.push(("fromId", format!("{id}")));
            } else {
                params.push(("startTime", start.timestamp_millis().to_string()));
                params.push(("endTime", end.timestamp_millis().to_string()));
            }
            self.budget.reserve(market, 20).await?;
            let response = self
                .client
                .get(url)
                .query(&params)
                .send()
                .await
                .map_err(anyhow::Error::from)?;
            let page: Vec<Value> = self.decode(market, response).await?;
            if page.is_empty() {
                complete = true;
                break;
            }
            let mut beyond = false;
            for tr in &page {
                let at = tr["T"]
                    .as_i64()
                    .ok_or_else(|| Error::bad("invalid_trade_payload"))?;
                let id = tr["a"]
                    .as_i64()
                    .ok_or_else(|| Error::bad("invalid_trade_payload"))?;
                if from.is_some_and(|expected| id != expected) {
                    return Err(Error::bad("trade_id_gap"));
                }
                from = Some(id + 1);
                if at > end.timestamp_millis() {
                    beyond = true;
                    break;
                }
                if at >= start.timestamp_millis() {
                    all.push(tr.clone());
                }
            }
            if beyond || page.len() < 1000 {
                complete = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        Ok(
            json!({"provider":"binance","market":market,"instrument":symbol,"requested_start":start,"requested_end":end,"received_at":Utc::now(),"coverage_complete":complete,"raw":all,"price_type":"trade","identity":"historical_reconstruction"}),
        )
    }
}
impl Binance {
    pub async fn exchange_info(&self, market: &str) -> Result<Value> {
        let url = match market {
            "usd_m" => "https://fapi.binance.com/fapi/v1/exchangeInfo",
            "coin_m" => "https://dapi.binance.com/dapi/v1/exchangeInfo",
            _ => return Err(Error::bad("contract_market_required")),
        };
        self.budget.reserve(market, 1).await?;
        let response = self
            .client
            .get(url)
            .send()
            .await
            .map_err(anyhow::Error::from)?;
        self.decode(market, response).await
    }
    async fn decode<T: serde::de::DeserializeOwned>(
        &self,
        market: &str,
        response: reqwest::Response,
    ) -> Result<T> {
        let used = response
            .headers()
            .get("x-mbx-used-weight-1m")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<i32>().ok());
        let status = response.status().as_u16();
        if matches!(status, 418 | 429) {
            let seconds = response
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse::<u32>().ok())
                .unwrap_or(if status == 418 { 3600 } else { 30 })
                .clamp(1, 259200);
            self.budget.observe(market, used, Some(seconds)).await?;
            return Err(Error::deferred(
                "provider_rate_limited",
                crate::error::RetryDirective::After(seconds),
            ));
        }
        self.budget.observe(market, used, None).await?;
        if status >= 500 {
            return Err(Error::transient("provider_unavailable"));
        }
        if status >= 400 {
            return Err(Error::deferred(
                "provider_request_rejected",
                crate::error::RetryDirective::AwaitInput,
            ));
        }
        response
            .json()
            .await
            .map_err(|_| Error::transient("invalid_provider_response"))
    }
}
