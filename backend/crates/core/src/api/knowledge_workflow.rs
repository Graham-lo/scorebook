use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;
#[derive(Clone, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct PlaybookTransition {
    pub expected_event_id: Uuid,
    pub status: String,
    pub reason: String,
}
#[derive(Clone, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct EpisodeReview {
    pub expected_evidence_sha256: String,
    pub note: String,
    pub better_play: Option<String>,
}
#[derive(Clone, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct TagRevision {
    pub name: String,
    pub definition: String,
    pub aliases: Vec<String>,
    pub reason: String,
}
