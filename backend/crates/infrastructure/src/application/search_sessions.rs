//! Saved search metadata and exact evidence references share one lifecycle.
use crate::{
    adapters::db::Database,
    application::Services,
    error::{Error, Result},
};
use serde_json::{Value, json};
use sqlx::{Postgres, Transaction};
use uuid::Uuid;
pub async fn references(
    tx: &mut Transaction<'_, Postgres>,
    owner: Uuid,
    id: Uuid,
    body: &Value,
    result: &Value,
) -> Result<()> {
    sqlx::query("INSERT INTO search_result_refs SELECT $1,$2,r.* FROM (SELECT * FROM reference_ids($3) UNION SELECT * FROM reference_ids($4)) r WHERE entity_type IN ('call','attachment') ON CONFLICT DO NOTHING").bind(owner).bind(id).bind(body).bind(result).execute(&mut **tx).await?;
    Ok(())
}
pub async fn save(s: &Services, owner: Uuid, id: Uuid, key: &str) -> Result<Value> {
    let body = json!({"session_id":id});
    let (mut tx, cached) = s.db.write(owner, "search.save", key, &body).await?;
    if let Some(v) = cached {
        return Ok(v);
    }
    let changed=sqlx::query("UPDATE similarity_sessions SET saved=true,expires_at=NULL WHERE owner_id=$1 AND id=$2 AND (saved OR expires_at>now())").bind(owner).bind(id).execute(&mut *tx).await?;
    if changed.rows_affected() != 1 {
        return Err(Error::not_found());
    }
    let v = json!({"session_id":id,"saved":true,"snapshot":"fixed_results","raw_market_storage":"none"});
    Database::finish(&mut tx, owner, "search.save", key, &body, &v).await?;
    tx.commit().await?;
    Ok(v)
}

pub async fn get(s: &Services, owner: Uuid, id: Uuid) -> Result<Value> {
    sqlx::query_scalar("SELECT to_jsonb(s)-'owner_id' FROM similarity_sessions s WHERE owner_id=$1 AND id=$2 AND (saved OR expires_at>now())").bind(owner).bind(id).fetch_optional(&s.db.pool).await?.ok_or_else(Error::not_found)
}
