//! Short-lived delegated sessions. Tokens are never written to request caches or exports.
use super::Services;
use crate::{
    adapters::db::hash_bytes,
    error::{Error, Result},
};
use scorebook_core::access::{Principal, SessionInput};
use serde_json::{Value, json};
use uuid::Uuid;
pub async fn create(s: &Services, principal: Principal, input: SessionInput) -> Result<Value> {
    if input.permissions.is_empty() || !(60..=86400).contains(&input.ttl_seconds) {
        return Err(Error::bad("invalid_session_request"));
    }
    for permission in &input.permissions {
        principal.require(permission)?;
    }
    let mut permissions = input.permissions;
    permissions.sort();
    permissions.dedup();
    let mut tx = s.db.pool.begin().await?;
    let depth:i64=sqlx::query_scalar("WITH RECURSIVE chain AS (SELECT id,parent_id,0 AS depth FROM api_keys WHERE id=$1 UNION ALL SELECT p.id,p.parent_id,c.depth+1 FROM api_keys p JOIN chain c ON p.id=c.parent_id WHERE c.depth<8) SELECT max(depth)::bigint FROM chain").bind(principal.credential_id).fetch_one(&mut *tx).await?;
    if depth >= 7 {
        return Err(Error::bad("session_delegation_limit"));
    }
    let token = format!(
        "sb_session_{}{}",
        Uuid::new_v4().simple(),
        Uuid::new_v4().simple()
    );
    let id = Uuid::new_v4();
    let expires:Option<chrono::DateTime<chrono::Utc>>=sqlx::query_scalar("INSERT INTO api_keys(id,token_hash,owner_id,permissions,parent_id,expires_at) SELECT $1,$2,owner_id,$3,id,least(expires_at,now()+make_interval(secs=>$4)) FROM api_keys WHERE owner_id=$5 AND id=$6 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now()) RETURNING expires_at").bind(id).bind(hash_bytes(token.as_bytes())).bind(&permissions).bind(input.ttl_seconds as i32).bind(principal.owner).bind(principal.credential_id).fetch_optional(&mut *tx).await?;
    let expires = expires.ok_or_else(Error::unauthorized)?;
    tx.commit().await?;
    Ok(
        json!({"session_id":id,"access_token":token,"expires_at":expires,"permissions":permissions,"token_type":"Bearer"}),
    )
}
pub async fn revoke(s: &Services, principal: Principal, id: Uuid) -> Result<Value> {
    let admin = principal.permissions.iter().any(|v| v == "maintenance");
    let changed=sqlx::query("UPDATE api_keys SET revoked_at=COALESCE(revoked_at,now()) WHERE owner_id=$1 AND id=$2 AND ($3 OR id=$4 OR parent_id=$4)").bind(principal.owner).bind(id).bind(admin).bind(principal.credential_id).execute(&s.db.pool).await?;
    if changed.rows_affected() != 1 {
        return Err(Error::not_found());
    }
    Ok(json!({"session_id":id,"revoked":true,"descendants_revoked":true}))
}
