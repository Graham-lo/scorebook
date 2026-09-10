use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
#[derive(Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct DraftInput {
    #[serde(default)]
    pub trades: Vec<super::review_trades::ReviewTrade>,
    #[serde(default)]
    pub attachment_ids: Vec<uuid::Uuid>,
    pub expected_draft_revision: i64,
    pub note: String,
    pub better_play: Option<String>,
    pub vs_last: Option<String>,
}

#[derive(Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct PublishDraft {
    pub expected_draft_revision: i64,
    pub expected_call_revision: i64,
    pub expected_outcome_ids: Vec<uuid::Uuid>,
}

#[derive(Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct SnoozeInput {
    pub expected_revision: i64,
    pub until: Option<DateTime<Utc>>,
}

#[derive(Serialize, Deserialize, ToSchema, Default)]
#[serde(deny_unknown_fields)]
pub struct QueueFilter {
    pub bucket: Option<String>,
    pub cursor: Option<String>,
    pub limit: Option<i64>,
}

#[derive(Serialize, Deserialize, ToSchema, Default)]
#[serde(deny_unknown_fields)]
pub struct HistoryFilter {
    pub kind: Option<String>,
    pub cursor: Option<String>,
    pub limit: Option<i64>,
}

#[derive(Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct DiscardDraft {
    pub expected_draft_revision: i64,
}
