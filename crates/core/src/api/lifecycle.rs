use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;
#[derive(Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct DeletePreview {
    pub call_id: Uuid,
    pub expected_revision: i64,
}

#[derive(Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct DeleteConfirm {
    pub request_id: Uuid,
    pub confirmation_token: String,
}
