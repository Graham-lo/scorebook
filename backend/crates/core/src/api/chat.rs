use serde::{Deserialize, Serialize};
use serde_json::Value;
use utoipa::ToSchema;
use uuid::Uuid;
#[derive(Clone, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ApprovedAction {
    pub tool: String,
    pub arguments_sha256: String,
    pub user_intent: String,
}
#[derive(Clone, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ChatInput {
    pub message: String,
    #[serde(default)]
    pub attachment_ids: Vec<Uuid>,
    #[serde(default)]
    pub approved_actions: Vec<ApprovedAction>,
}
#[derive(Clone, Serialize, Deserialize, ToSchema, Default)]
#[serde(deny_unknown_fields)]
pub struct ChatEventFilter {
    pub after: Option<i64>,
}
#[derive(Clone, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ChatCancel {
    pub expected_generation: i64,
}
#[derive(Clone, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ToolProposal {
    pub tool: String,
    pub arguments: Value,
    pub arguments_sha256: String,
    pub confirmation_required: bool,
}
