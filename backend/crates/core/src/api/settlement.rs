use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;
#[derive(Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct RevisionRequest {
    pub claim_no: i32,
    pub expected_outcome_id: Uuid,
    pub reason: String,
}
