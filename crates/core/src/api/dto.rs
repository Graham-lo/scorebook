use crate::domain::criteria::Criteria;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct CreateCall {
    pub original_text: String,
    pub instrument: Option<String>,
    #[serde(default = "default_market")]
    pub market: Option<String>,
    pub timeframe: Option<String>,
    #[serde(default = "unknown")]
    pub path: String,
    #[serde(default = "unknown")]
    pub stance: String,
    pub confidence: Option<u8>,
    #[serde(default)]
    pub criteria: Vec<Criteria>,
    #[serde(default)]
    pub attachments: Vec<Uuid>,
    #[serde(default)]
    pub tags: Vec<Uuid>,
    pub related_call: Option<Uuid>,
    pub playbook_id: Option<Uuid>,
    pub original_claimed_at: Option<DateTime<Utc>>,
    #[serde(default = "entry")]
    pub source_entry: String,
}
fn unknown() -> String {
    "unknown".into()
}
fn entry() -> String {
    "api".into()
}
#[derive(Deserialize, Serialize, ToSchema, Default)]
pub struct CallFilter {
    pub q: Option<String>,
    pub instrument: Option<String>,
    pub market: Option<String>,
    pub timeframe: Option<String>,
    pub tag: Option<String>,
    pub before: Option<DateTime<Utc>>,
    pub cursor: Option<String>,
    pub limit: Option<i64>,
}
#[derive(Deserialize, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct Review {
    #[serde(default)]
    pub trades: Vec<super::review_trades::ReviewTrade>,
    #[serde(default)]
    pub attachment_ids: Vec<Uuid>,
    pub expected_outcome_ids: Vec<Uuid>,
    pub call_id: Uuid,
    pub note: String,
    pub better_play: Option<String>,
    pub vs_last: String,
    pub expected_revision: i64,
}
#[derive(Deserialize, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct Change {
    pub expected_revision: i64,
    pub reason: String,
}
#[derive(Deserialize, Serialize, ToSchema)]
pub struct TextInput {
    pub text: String,
}
#[derive(Deserialize, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct TagInput {
    pub name: String,
    pub definition: String,
    #[serde(default)]
    pub aliases: Vec<String>,
}
#[derive(Deserialize, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct TagLink {
    pub call_id: Uuid,
    pub tag_id: Uuid,
    pub expected_revision: i64,
}
#[derive(Deserialize, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct PlaybookInput {
    pub parent_id: Option<Uuid>,
    pub name: String,
    pub applies_to: String,
    pub excludes: String,
    pub old_play: String,
    pub change: String,
    pub evidence_call_ids: Vec<Uuid>,
    pub expected_improvement: String,
    pub cost: String,
}
#[derive(Deserialize, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct EpisodeLink {
    pub call_id: Uuid,
    pub episode_id: Uuid,
    pub status: String,
    pub expected_revision: i64,
}
#[derive(Clone, Deserialize, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct Region {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}
#[derive(Clone, Deserialize, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct SimilarityQuery {
    pub attachment_id: Uuid,
    pub region: Option<Region>,
    #[serde(default = "model")]
    pub model_id: String,
    pub instrument: Option<String>,
    pub market: Option<String>,
    /// Required selected screenshot interval.
    #[schema(required = true, nullable = false)]
    pub timeframe: Option<String>,
    pub cutoff_at: Option<DateTime<Utc>>,
    pub limit: Option<i64>,
}
fn model() -> String {
    "candle-geometry-v2".into()
}
#[derive(Deserialize, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct SimilarityFeedback {
    pub session_id: Uuid,
    pub attachment_id: Uuid,
    pub relevant: bool,
    pub reason: Option<String>,
}
#[derive(Deserialize, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct MarketRequest {
    pub call_id: Uuid,
    pub interval: String,
    pub start_at: DateTime<Utc>,
    pub end_at: DateTime<Utc>,
}
#[derive(Deserialize, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ToolCall {
    pub tool_call_id: Uuid,
    pub name: String,
    pub arguments: serde_json::Value,
}

fn default_market() -> Option<String> {
    Some("usd_m".into())
}
