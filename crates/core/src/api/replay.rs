//! Relive/replay inputs: a confirmed screenshot location, the chart setup, the
//! per-screenshot locating override and the attachment kind correction.
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
///
/// 每个字段都有默认值，所以旧的 `{"ma":[],"ema":[]}` 依然能解出来；未知字段仍然拒收。
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
    /// 非 null 即表示要画 VOL 副图；`ma` 是 MAVOL 的周期。
    #[serde(default)]
    pub volume: Option<VolumeSetup>,
    #[serde(default)]
    pub macd: Option<MacdSetup>,
    #[serde(default)]
    pub rsi: Option<RsiSetup>,
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
#[derive(Clone, Serialize, Deserialize, ToSchema, Default)]
#[serde(deny_unknown_fields)]
pub struct VolumeSetup {
    #[serde(default)]
    pub ma: Vec<u32>,
}
#[derive(Clone, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct MacdSetup {
    pub fast: u32,
    pub slow: u32,
    pub signal: u32,
}
#[derive(Clone, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct RsiSetup {
    pub n: u32,
}

/// `GET /v1/calls/{id}/replay` 的查询串。`bars=none` 只要元数据：前端自己直连
/// 币安拉 K 线，后端这一次既不取数也不写缓存。
#[derive(Clone, Default, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ReplayQuery {
    #[serde(default)]
    pub bars: Option<String>,
}

/// 手动定位时按这张图指定品种：三张同板块对比图各归各的标的。
/// 三项都可省，省掉的沿用记录本身的 instrument/market/timeframe。
#[derive(Clone, Default, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct LocateOverride {
    #[serde(default)]
    pub symbol: Option<String>,
    #[serde(default)]
    pub market: Option<String>,
    #[serde(default)]
    pub interval: Option<String>,
}

/// 改附件用途：把同板块对比图从 scene 降成 reference。
#[derive(Clone, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct AttachmentKindUpdate {
    pub kind: String,
}
