use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
#[derive(Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct RetryRequest {
    pub expected_generation: i64,
}

#[derive(Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct AssessmentSourcePlan {
    pub expected_generation: i64,
    pub source_plan: String,
    pub reason: String,
}
