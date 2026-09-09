use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
#[derive(Clone, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct HistoryEstimateInput {
    pub market: String,
    pub symbols: Vec<String>,
    pub intervals: Vec<String>,
    pub start_at: DateTime<Utc>,
    pub end_at: DateTime<Utc>,
}
#[derive(Clone, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct HistorySubscriptionInput {
    pub market: String,
    pub symbols: Vec<String>,
    pub intervals: Vec<String>,
    pub start_at: DateTime<Utc>,
    pub source: super::history::HistorySource,
    /// A hard admission limit over a cycle. Increase explicitly after sizing.
    pub max_vectors: u64,
}
#[derive(Serialize, Deserialize, ToSchema, Default)]
#[serde(deny_unknown_fields)]
pub struct HistoryCatalogFilter {
    pub market: Option<String>,
    pub cursor: Option<String>,
    pub symbol: Option<String>,
}
#[derive(Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ArchiveCatalogInput {
    pub market: String,
    pub symbol: String,
    pub interval: String,
    pub cursor: Option<String>,
}
