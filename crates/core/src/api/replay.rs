//! Relive/replay inputs: a confirmed screenshot location and the chart setup.
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;

/// One screenshot pinned to a real Binance window. Confirmed once, kept for good.
#[derive(Clone, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct AttachmentLocation {
    pub symbol: String,
    #[serde(default = "usd_m")]
    pub market: String,
    pub interval: String,
    pub start_at: DateTime<Utc>,
    pub end_at: DateTime<Utc>,
    pub bars_count: Option<i32>,
    pub source: crate::market::HistorySource,
    pub score: Option<String>,
    pub search_run_id: Option<Uuid>,
}
fn usd_m() -> String {
    "usd_m".into()
}

/// Which overlays the replay stage draws. The backend stores the shape only and
/// never computes an indicator.
#[derive(Clone, Serialize, Deserialize, ToSchema, Default)]
#[serde(deny_unknown_fields)]
pub struct ChartSetup {
    #[serde(default)]
    pub ma: Vec<u32>,
    #[serde(default)]
    pub ema: Vec<u32>,
    #[serde(default)]
    pub boll: Option<BollSetup>,
    #[serde(default)]
    pub atr: Option<AtrSetup>,
}
#[derive(Clone, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct BollSetup {
    pub n: u32,
    pub k: String,
}
#[derive(Clone, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct AtrSetup {
    pub n: u32,
}
