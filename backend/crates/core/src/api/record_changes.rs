use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;
#[derive(Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct AttachmentLink {
    pub attachment_id: Uuid,
    pub expected_revision: i64,
}

#[derive(Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct Correction {
    pub expected_revision: i64,
    pub category: String,
    pub explanation: String,
    pub evidence_attachment: Option<Uuid>,
}
