use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
#[derive(Clone, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct KnowledgeSearch {
    pub query: String,
    pub source_kind: Option<String>,
    pub before: Option<DateTime<Utc>>,
    pub limit: Option<usize>,
}
#[derive(Clone, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct SourceRequest {
    pub source_kind: String,
    pub source_id: uuid::Uuid,
    pub source_version: Option<String>,
}

#[derive(Clone, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct SourceSliceRequest {
    pub source_kind: String,
    pub source_id: uuid::Uuid,
    pub source_version: Option<String>,
    pub offset_byte: Option<usize>,
    pub limit_bytes: Option<usize>,
}
