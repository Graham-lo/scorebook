use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
#[derive(Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct HistoryPlanRequest {
    #[serde(default)]
    pub source: super::history::HistorySource,
    pub symbols: Vec<String>,
    pub market: String,
    pub intervals: Vec<String>,
    pub start_at: DateTime<Utc>,
    /// Explicit per-contract continuation; each value is bounded by start_at/end_at.
    #[serde(default)]
    pub symbol_start_at: std::collections::BTreeMap<String, DateTime<Utc>>,
    pub end_at: DateTime<Utc>,
    pub window_bars: usize,
    pub stride_bars: usize,
    pub models: Vec<String>,
}

#[derive(Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct PlanControl {
    pub expected_revision: i64,
    pub action: String,
}
