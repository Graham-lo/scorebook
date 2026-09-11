use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
#[derive(Clone, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct BackupConfiguration {
    pub repository: String,
    pub storage_kind: String,
    pub keychain_service: String,
    pub enabled: bool,
    pub external_mount: Option<String>,
}
#[derive(Clone, Serialize, Deserialize, ToSchema, Default)]
#[serde(deny_unknown_fields)]
pub struct BackupFilter {
    pub cursor: Option<uuid::Uuid>,
}
#[derive(Clone, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct BackupInitialize {
    /// Explicit create or open; a failed create never silently opens another repository.
    pub mode: String,
}
