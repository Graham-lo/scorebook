//! Provider boundary. External requests are injected, including deterministic fault fixtures.
use crate::error::Result;
use chrono::{DateTime, Utc};
use serde_json::Value;
use std::{future::Future, pin::Pin};
pub type ProviderFuture<'a> = Pin<Box<dyn Future<Output = Result<Value>> + Send + 'a>>;
pub trait MarketDataProvider: Send + Sync {
    fn klines<'a>(
        &'a self,
        market: &'a str,
        symbol: &'a str,
        interval: &'a str,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    ) -> ProviderFuture<'a>;
    fn trades<'a>(
        &'a self,
        market: &'a str,
        symbol: &'a str,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    ) -> ProviderFuture<'a>;
    fn exchange_info<'a>(&'a self, market: &'a str) -> ProviderFuture<'a>;
    fn tickers_24h<'a>(&'a self, market: &'a str) -> ProviderFuture<'a>;
}

#[derive(Clone, Default, serde::Serialize, serde::Deserialize, utoipa::ToSchema, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum HistorySource {
    #[default]
    Rest,
    MonthlyArchive,
}
