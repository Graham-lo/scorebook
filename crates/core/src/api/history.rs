use super::dto::Region;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;
#[derive(Clone, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct HistoryIndexRequest {
    #[serde(default)]
    pub source: HistorySource,
    pub symbol: String,
    #[serde(default = "market")]
    pub market: String,
    pub interval: String,
    pub start_at: DateTime<Utc>,
    pub end_at: DateTime<Utc>,
    #[serde(default = "window")]
    pub window_bars: usize,
    #[serde(default = "stride")]
    pub stride_bars: usize,
    #[serde(default = "models")]
    pub models: Vec<String>,
}

pub use crate::market::HistorySource;

#[derive(Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct HistorySearch {
    pub attachment_id: Uuid,
    pub region: Option<Region>,
    #[serde(default = "model")]
    pub model_id: String,
    pub symbol: Option<String>,
    pub market: Option<String>,
    pub interval: Option<String>,
    pub cutoff_at: Option<DateTime<Utc>>,
    pub limit: Option<i64>,
}

fn market() -> String {
    "usd_m".into()
}

fn window() -> usize {
    64
}

fn stride() -> usize {
    16
}

fn models() -> Vec<String> {
    vec!["candle-geometry-v2".into()]
}

fn model() -> String {
    "candle-geometry-v2".into()
}

#[derive(Serialize, Deserialize, ToSchema, Default)]
#[serde(deny_unknown_fields)]
pub struct CoverageFilter {
    pub symbol: Option<String>,
    pub market: Option<String>,
    pub interval: Option<String>,
    pub model_id: Option<String>,
    pub cutoff_at: Option<DateTime<Utc>>,
    pub cursor: Option<Uuid>,
}
