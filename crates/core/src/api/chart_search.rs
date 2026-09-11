use super::dto::Region;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;
#[derive(Clone, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ChartAnalysisInput {
    pub attachment_id: Uuid,
    pub region: Option<Region>,
    #[serde(default)]
    pub red_up: bool,
}
#[derive(Clone, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ChartSearchInput {
    pub attachment_id: Uuid,
    pub region: Option<Region>,
    pub scope: ChartScope,
    pub symbol: Option<String>,
    pub market: Option<String>,
    /// The screenshot interval: required under `same_interval`, and must be null
    /// under `any_interval`, where shape alone decides and the period is free.
    pub interval: Option<String>,
    pub cutoff_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub reverse: bool,
    #[serde(default)]
    pub red_up: bool,
    pub limit: Option<usize>,
    #[serde(default)]
    pub interval_policy: IntervalPolicy,
}
#[derive(Clone, Serialize, Deserialize, ToSchema, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ChartScope {
    Private,
    BinanceHistory,
}

/// Whether the search stays inside the selected interval or compares shape only.
#[derive(Clone, Copy, Serialize, Deserialize, ToSchema, PartialEq, Default)]
#[serde(rename_all = "snake_case")]
pub enum IntervalPolicy {
    #[default]
    SameInterval,
    AnyInterval,
}
#[derive(Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct SearchRunControl {
    pub expected_generation: i64,
}
