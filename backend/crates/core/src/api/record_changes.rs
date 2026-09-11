use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;
#[derive(Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct AttachmentLink {
    pub attachment_id: Uuid,
    pub expected_revision: i64,
}

/// 换一张场景图，或把先前那一张重新指回来生效。
///
/// `attachment_id` 必须是 `kind='scene'` 的附件：还没挂到这条记录上的会顺手挂上，
/// 已经挂着的（包括已经被接替的那一张）直接重新生效。这条记录上其它在生效的
/// 场景图链接一律置成已接替——一条记录的场景图本来就是单数的。
#[derive(Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct SceneSelection {
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
