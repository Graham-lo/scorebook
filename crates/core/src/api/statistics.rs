use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;
#[derive(Clone, Serialize, Deserialize, ToSchema, Default)]
#[serde(deny_unknown_fields)]
pub struct SampleFilter {
    pub start_at: Option<DateTime<Utc>>,
    pub end_at: Option<DateTime<Utc>>,
    pub instrument: Option<String>,
    pub market: Option<String>,
    pub timeframe: Option<String>,
    pub path: Option<String>,
    pub stance: Option<String>,
    pub source_entry: Option<String>,
    pub tag_id: Option<Uuid>,
    pub tag_phase: Option<String>,
    pub playbook_id: Option<Uuid>,
    pub adoption: Option<String>,
    #[serde(default)]
    pub result_states: Vec<String>,
}
#[derive(Clone, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct StatisticsInput {
    pub name: String,
    pub filters: SampleFilter,
    /// exact_frozen_rule: absolute levels remain distinct. No inferred equivalence.
    pub comparison_policy: String,
    /// episode_rule or call_rule; fixed before reading outcomes.
    pub grouping: String,
    /// natural_hours, matching stored horizon_hours.
    pub calendar: String,
    /// current_formal_head, excluding exploratory replays.
    pub outcome_policy: String,
}
#[derive(Clone, Serialize, Deserialize, ToSchema, Default)]
#[serde(deny_unknown_fields)]
pub struct MemberFilter {
    pub cursor: Option<i64>,
    pub group_signature: Option<String>,
    pub state: Option<String>,
    pub representative: Option<bool>,
}
#[derive(Clone, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct VerdictInput {
    pub request_id: Uuid,
    pub expected_revision: i64,
    pub decision: String,
    pub evidence: String,
}
#[derive(Clone, Serialize, Deserialize, ToSchema, Default)]
#[serde(deny_unknown_fields)]
pub struct VerdictFilter {
    pub cursor: Option<Uuid>,
    pub status: Option<String>,
}
#[derive(Clone, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct BaselineInput {
    pub statistics_run_id: Uuid,
    pub source_plan: String,
    pub calendar: String,
}
