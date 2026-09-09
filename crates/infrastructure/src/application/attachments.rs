//! Index requests share the same task identity used by automatic capture.
use super::{Services, jobs};
use crate::{
    adapters::db::Database,
    error::{Error, Result},
};
use serde_json::{Value, json};
use uuid::Uuid;
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
