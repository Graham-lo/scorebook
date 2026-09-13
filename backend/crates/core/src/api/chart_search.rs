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
    /// Optional private-record text retrieval, combined with the screenshot.
    /// Trimmed; blank means image-only. At most 4096 UTF-8 bytes.
    /// Nonempty text is unsupported for public market history.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub query_text: Option<String>,
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
    /// 已经给人看过、人说了「不是」的那些候选，这一次不必再算一遍。
    ///
    /// 公开历史里是 `public_market.features` 的窗口 id，私有记录里是附件 id：
    /// 结果条目自己带的那个 id 就是这里要写的东西。排除在取 top-N **之前**生效，
    /// 否则排掉三条就只剩不足三条了。空的时候整个字段不出现在请求体里，行为、
    /// 指纹和契约都与从前一样。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub exclude: Vec<Uuid>,
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
