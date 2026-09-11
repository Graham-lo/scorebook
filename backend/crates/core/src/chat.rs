//! Provider-neutral conversation protocol. Model output is never authorization.
use crate::ports::AppFuture;
use serde::{Deserialize, Serialize};
use serde_json::Value;
#[derive(Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub parameters: Value,
    pub effect: String,
}
#[derive(Clone, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ModelToolCall {
    pub id: String,
    pub name: String,
    pub arguments: Value,
}
#[derive(Clone, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct Citation {
    pub source_kind: String,
    pub source_id: uuid::Uuid,
    pub source_version: String,
}
#[derive(Clone, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct AnswerBlock {
    pub text: String,
    #[serde(default)]
    pub citations: Vec<Citation>,
    pub inference: bool,
}
#[derive(Clone, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ModelReply {
    #[serde(default)]
    pub tool_calls: Vec<ModelToolCall>,
    #[serde(default)]
    pub answer: Vec<AnswerBlock>,
}
#[derive(Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct ModelMessage {
    pub role: String,
    pub content: Value,
}
/// Only user-owned original bytes cross this RAM-only boundary. It deliberately
/// has no Debug/Serialize implementation and cannot become a Chat event payload.
#[derive(Clone)]
pub struct OriginalImage {
    pub attachment_id: uuid::Uuid,
    pub mime: String,
    pub sha256: String,
    pub source_version: String,
    pub bytes: Vec<u8>,
}
#[derive(Clone)]
pub struct ModelRequest {
    pub run_id: uuid::Uuid,
    pub turn: u32,
    pub instructions: String,
    pub messages: Vec<ModelMessage>,
    pub tools: Vec<ToolDefinition>,
    pub attachment_ids: Vec<uuid::Uuid>,
    pub original_images: Vec<OriginalImage>,
}
/// A configured adapter must pin one model and retention policy. The default
/// implementation reports unavailable; no provider or model fallback exists.
pub trait ChatModelProvider: Send + Sync {
    fn model_id(&self) -> &str;
    fn reply(&self, input: ModelRequest) -> AppFuture<'_, ModelReply>;
}
