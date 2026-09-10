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
    /// Required selected screenshot interval; cross-interval search is not supported.
    #[schema(required = true, nullable = false)]
    pub interval: Option<String>,
    pub cutoff_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub reverse: bool,
    #[serde(default)]
    pub red_up: bool,
    pub limit: Option<usize>,
}
#[derive(Clone, Serialize, Deserialize, ToSchema, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ChartScope {
    Private,
    BinanceHistory,
}
#[derive(Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct SearchRunControl {
    pub expected_generation: i64,
}
