//! Explicit capabilities; a model's compute permission never implies saving evidence.
use crate::error::{Error, Result};
use uuid::Uuid;
pub const READ_PERMISSIONS: &[&str] = &["knowledge.read", "search.compute"];
pub const FULL_PERMISSIONS: &[&str] = &[
    "knowledge.read",
    "search.compute",
    "search.save",
    "history.build",
    "records.write",
    "maintenance",
];
#[derive(Clone)]
pub struct Principal {
    pub owner: Uuid,
    pub credential_id: Uuid,
    pub permissions: Vec<String>,
}
impl Principal {
    pub fn require(&self, permission: &str) -> Result<()> {
        if self.permissions.iter().any(|p| p == permission) {
            Ok(())
        } else {
            Err(Error::forbidden(format!(
                "permission_required:{permission}"
            )))
        }
    }
}
pub fn route_permission(method: &str, path: &str) -> &'static str {
    if matches!(
        path,
        "/v1/knowledge/search" | "/v1/knowledge/source" | "/v1/knowledge/source/slice"
    ) || path.starts_with("/v1/sessions")
    {
        "knowledge.read"
    } else if path.starts_with("/v1/backups")
        || path.starts_with("/v1/exports")
        || path.starts_with("/v1/deletions")
        || path.ends_with("/retry")
        || path.ends_with("/assessment-source")
    {
        "maintenance"
    } else if path.starts_with("/v1/chat/")
        || path.starts_with("/v1/chart-search/")
        || path == "/v1/chart-analyses"
    {
        if method == "GET" {
            "knowledge.read"
        } else {
            "search.save"
        }
    } else if path == "/v1/market/bounds" {
        "search.compute"
    } else if method == "GET" || path == "/v1/knowledge/tools/call" {
        "knowledge.read"
    } else if path.starts_with("/v1/history/plans")
        || path.starts_with("/v1/history/subscriptions")
        || path == "/v1/history/catalog/refresh"
        || path.starts_with("/v1/history/indexes")
        || path == "/v1/history/archive-catalog"
    {
        "history.build"
    } else if path.starts_with("/v1/similarity/") || path == "/v1/history/search" {
        "search.save"
    } else if path.starts_with("/v1/market/")
        || path.ends_with("/preview")
        || path == "/v1/chart-analyses/outline"
    {
        "search.compute"
    } else {
        "records.write"
    }
}

#[derive(serde::Serialize, serde::Deserialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct SessionInput {
    pub permissions: Vec<String>,
    pub ttl_seconds: u32,
}
