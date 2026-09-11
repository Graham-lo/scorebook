//! Index requests share the same task identity used by automatic capture.
use super::{Services, jobs};
use crate::{
    adapters::db::Database,
    error::{Error, Result},
};
use scorebook_core::api::replay::AttachmentKindUpdate;
use serde_json::{Value, json};
use uuid::Uuid;

/// 改附件用途。上传时定错了不必重传：同板块对比图本来就该是 reference，
/// 只是上传的那一刻还没人知道。
///
/// 这里只改 `attachments.kind` 一列：已经钉住的位置不动（那是图自己的事实，
/// 与它派什么用场无关），改成 scene 也不会引出一次自动定位（自动定位只发生在
/// 复盘发布那一刻，且只发生一次）。
pub async fn set_kind(
    s: &Services,
    owner: Uuid,
    id: Uuid,
    key: Option<&str>,
    input: AttachmentKindUpdate,
) -> Result<Value> {
    if !matches!(input.kind.as_str(), "scene" | "supplement" | "reference") {
        return Err(Error::bad("invalid_kind"));
    }
    let body = json!({"attachment_id":id,"kind":input.kind});
    let (mut tx, cached) =
        super::replay::begin(s, owner, "attachments.kind.put", key, &body).await?;
    if let Some(v) = cached {
        return Ok(v);
    }
    let row: Option<Value> = sqlx::query_scalar(
        r#"UPDATE attachments SET kind=$3 WHERE owner_id=$1 AND id=$2
        RETURNING (to_jsonb(attachments)-'owner_id')||jsonb_build_object('location',(SELECT (to_jsonb(al)-'owner_id'-'score')||jsonb_build_object('score',al.score::text) FROM attachment_locations al WHERE al.owner_id=attachments.owner_id AND al.attachment_id=attachments.id))"#,
    )
    .bind(owner)
    .bind(id)
    .bind(&input.kind)
    .fetch_optional(&mut *tx)
    .await?;
    let row = row.ok_or_else(Error::not_found)?;
    super::replay::end(&mut tx, owner, "attachments.kind.put", key, &body, &row).await?;
    tx.commit().await?;
    Ok(row)
}
pub async fn index(s: &Services, owner: Uuid, id: Uuid, key: &str, model: &str) -> Result<Value> {
    crate::adapters::ann::space(model)?;
    let body = json!({"attachment_id":id,"model_id":model});
    let (mut tx, cached) = s.db.write(owner, "attachments.index", key, &body).await?;
    if let Some(v) = cached {
        return Ok(v);
    }
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM attachments WHERE owner_id=$1 AND id=$2)")
            .bind(owner)
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
    if !exists {
        return Err(Error::not_found());
    }
    let job = jobs::enqueue_tx(
        &mut tx,
        owner,
        "embed",
        &format!("{id}:{model}"),
        body.clone(),
    )
    .await?;
    let status: String = sqlx::query_scalar("SELECT status FROM jobs WHERE id=$1")
        .bind(job)
        .fetch_one(&mut *tx)
        .await?;
    let result = json!({"job_id":job,"status":status});
    Database::finish(&mut tx, owner, "attachments.index", key, &body, &result).await?;
    tx.commit().await?;
    Ok(result)
}
