//! Additions never rewrite the original record or silently rescore it.
//!
//! **生效的场景图**（全仓库唯一一处定义，读的那一侧每一处都照这句话写）：
//! 这条记录上 `call_attachments.superseded_at IS NULL` 的链接里，按
//! `(attached_at, attachment_id)` 升序、附件 `kind='scene'` 的第一条。
//!
//! 顺序语义与 0050 之前逐字相同——从前是 `(attachments.uploaded_at, attachments.id)`
//! 升序取第一条，迁移把 `attached_at` 回填成了 `uploaded_at`，两个排序键逐行相等，
//! 所以既有记录挑的还是原来那一张。只有显式换图（[`set_scene`]）才会换人。
//! `LIMIT 1` 一律保留作兜底：不变量由 [`set_scene`] 的事务保证，读的那一侧不该
//! 因为多出一行生效链接就炸。
use super::{Services, calls};
use crate::{
    adapters::db::{Database, event},
    error::{Error, Result},
};
pub use scorebook_core::api::record_changes::*;
use serde_json::{Value, json};
use uuid::Uuid;

/// 换图：把这条记录上任意一张 `kind='scene'` 的附件指成此刻生效的场景图。
///
/// 这一条账本护的是证据本身——字节、sha256、size、uploaded_at 永远不许改，附件
/// 行永远不许硬删。「此刻哪一张在生效」不在被护的范围里：那是个判断，判断可以
/// 改正。所以这里一行都不删，只动链接上的 `superseded_at` / `superseded_by`，
/// 被接替的那一张连同它的 blob 原样留着，随时可以再指回来。
///
/// 还没挂到这条记录上的附件会顺手挂上（`attached_at` 取此刻，不取 uploaded_at：
/// 把一张旧图重新指回来时，按 uploaded_at 排它永远翻不了身）。这条记录上其它在
/// 生效的场景图链接一律置成已接替——`replay` 和 `locate` 都是 `LIMIT 1`，一条记录
/// 的场景图本来就是单数的。`supplement` / `reference` 一个字都不动，那两类天然是
/// 复数。
///
/// 提交之后才上传的替换图是**事后改正**：重温、自动钉图、界面显示都用新的那一
/// 张，但 `similarity` 和 `chart_search` 的证据池闸门一个字都不放松（见
/// `similarity::search_single_mode`）。记录成立那一刻还不存在的图，不算「你当时
/// 看到的」。这种情形在结果里带一个看得见的标记
/// （`scene_replaced_after_submission`），原来那一张仍然取得回来。
pub async fn set_scene(
    s: &Services,
    owner: Uuid,
    id: Uuid,
    key: Option<&str>,
    input: SceneSelection,
) -> Result<Value> {
    let body = json!(input);
    let op = format!("calls.scene.{id}");
    let (mut tx, cached) = super::replay::begin(s, owner, &op, key, &body).await?;
    if let Some(v) = cached {
        return Ok(v);
    }
    calls::require_call(&mut tx, owner, id).await?;
    calls::bump(&mut tx, owner, id, input.expected_revision).await?;
    // 与 settlement 发布结论用的是同一把锁：同一条记录上的换图互相串行，
    // 「至多一张生效场景图」这个不变量就在这个事务里成立，不必拿唯一索引去保
    // （索引看不见 attachments.kind，而 0046 之后 kind 本身是可以改正的）。
    sqlx::query("SELECT id FROM calls WHERE owner_id=$1 AND id=$2 FOR UPDATE")
        .bind(owner)
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
    let kind: Option<String> =
        sqlx::query_scalar("SELECT kind FROM attachments WHERE owner_id=$1 AND id=$2")
            .bind(owner)
            .bind(input.attachment_id)
            .fetch_optional(&mut *tx)
            .await?;
    if kind.as_deref() != Some("scene") {
        return Err(Error::bad("scene_attachment_required"));
    }
    sqlx::query("INSERT INTO call_attachments(owner_id,call_id,attachment_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING")
        .bind(owner)
        .bind(id)
        .bind(input.attachment_id)
        .execute(&mut *tx)
        .await?;
    let superseded:Vec<Uuid>=sqlx::query_scalar("UPDATE call_attachments l SET superseded_at=now(),superseded_by=$3 WHERE l.owner_id=$1 AND l.call_id=$2 AND l.attachment_id<>$3 AND l.superseded_at IS NULL AND EXISTS(SELECT 1 FROM attachments a WHERE a.owner_id=l.owner_id AND a.id=l.attachment_id AND a.kind='scene') RETURNING l.attachment_id")
        .bind(owner)
        .bind(id)
        .bind(input.attachment_id)
        .fetch_all(&mut *tx)
        .await?;
    // 指回一张已经被接替的图就是改正的退路：清掉它自己的接替标记即可，不删任何行。
    sqlx::query("UPDATE call_attachments SET superseded_at=NULL,superseded_by=NULL WHERE owner_id=$1 AND call_id=$2 AND attachment_id=$3")
        .bind(owner)
        .bind(id)
        .bind(input.attachment_id)
        .execute(&mut *tx)
        .await?;
    let after:bool=sqlx::query_scalar("SELECT a.uploaded_at>c.submitted_at FROM attachments a,calls c WHERE a.owner_id=$1 AND a.id=$3 AND c.owner_id=$1 AND c.id=$2")
        .bind(owner)
        .bind(id)
        .bind(input.attachment_id)
        .fetch_one(&mut *tx)
        .await?;
    // 新的那一张还没钉到真实 K 线上时，重温就没有锚点可用了。复盘已经发布的
    // 记录补一次自动定位，规矩照旧：一张图至多一次，作业键就是附件 id。
    super::locate::enqueue_after_scene_change(&mut tx, owner, id).await?;
    event(
        &mut tx,
        owner,
        Some(id),
        "scene.replaced",
        json!({"attachment_id":input.attachment_id,"superseded":superseded,"replaced_after_submission":after}),
    )
    .await?;
    let v = json!({"call_id":id,"attachment_id":input.attachment_id,"revision":input.expected_revision+1,"superseded":superseded,"scene_replaced_after_submission":after,"original_evidence_unchanged":true});
    super::replay::end(&mut tx, owner, &op, key, &body, &v).await?;
    tx.commit().await?;
    Ok(v)
}

pub async fn supplement(
    s: &Services,
    owner: Uuid,
    id: Uuid,
    key: &str,
    input: AttachmentLink,
) -> Result<Value> {
    let body = json!(input);
    let op = format!("calls.supplement.{id}");
    let (mut tx, cached) = s.db.write(owner, &op, key, &body).await?;
    if let Some(v) = cached {
        return Ok(v);
    }
    calls::require_call(&mut tx, owner, id).await?;
    calls::bump(&mut tx, owner, id, input.expected_revision).await?;
    let kind: Option<String> =
        sqlx::query_scalar("SELECT kind FROM attachments WHERE owner_id=$1 AND id=$2")
            .bind(owner)
            .bind(input.attachment_id)
            .fetch_optional(&mut *tx)
            .await?;
    if !matches!(kind.as_deref(), Some("supplement" | "reference")) {
        return Err(Error::bad("supplement_or_reference_required"));
    }
    sqlx::query("INSERT INTO call_attachments VALUES($1,$2,$3) ON CONFLICT DO NOTHING")
        .bind(owner)
        .bind(id)
        .bind(input.attachment_id)
        .execute(&mut *tx)
        .await?;
    event(&mut tx, owner, Some(id), "attachment.added", body.clone()).await?;
    let v = json!({"revision":input.expected_revision+1,"identity":"later_supplement","original_evidence_unchanged":true});
    Database::finish(&mut tx, owner, &op, key, &body, &v).await?;
    tx.commit().await?;
    Ok(v)
}
pub async fn correction(
    s: &Services,
    owner: Uuid,
    id: Uuid,
    key: &str,
    input: Correction,
) -> Result<Value> {
    if !matches!(
        input.category.as_str(),
        "metadata_evidence" | "parser_error" | "annotation"
    ) || input.explanation.trim().is_empty()
    {
        return Err(Error::bad(
            "invalid_correction; changed_prediction_requires_new_record",
        ));
    }
    let body = json!(input);
    let op = format!("calls.correction.{id}");
    let (mut tx, cached) = s.db.write(owner, &op, key, &body).await?;
    if let Some(v) = cached {
        return Ok(v);
    }
    calls::require_call(&mut tx, owner, id).await?;
    calls::bump(&mut tx, owner, id, input.expected_revision).await?;
    if let Some(a) = input.evidence_attachment {
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM attachments WHERE owner_id=$1 AND id=$2)",
        )
        .bind(owner)
        .bind(a)
        .fetch_one(&mut *tx)
        .await?;
        if !exists {
            return Err(Error::bad("invalid_evidence_reference"));
        }
    }
    event(
        &mut tx,
        owner,
        Some(id),
        "correction.requested",
        body.clone(),
    )
    .await?;
    let v = json!({"revision":input.expected_revision+1,"status":"recorded_for_review","automatic_rescore":false});
    Database::finish(&mut tx, owner, &op, key, &body, &v).await?;
    tx.commit().await?;
    Ok(v)
}
