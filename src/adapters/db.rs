use crate::error::{Error, Result};
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Postgres, Row, Transaction, postgres::PgPoolOptions};
use uuid::Uuid;
#[derive(Clone)]
pub struct Database {
    pub pool: PgPool,
}
pub fn digest(v: &impl serde::Serialize) -> String {
    hex::encode(Sha256::digest(
        serde_json::to_vec(v).expect("serializable value"),
    ))
}
pub fn hash_bytes(v: &[u8]) -> String {
    hex::encode(Sha256::digest(v))
}
impl Database {
    pub async fn connect(url: &str) -> anyhow::Result<Self> {
        Ok(Self {
            pool: PgPoolOptions::new()
                .max_connections(12)
                .acquire_timeout(std::time::Duration::from_secs(5))
                .after_connect(|c, _| {
                    Box::pin(async move {
                        sqlx::query("SET statement_timeout='15s'")
                            .execute(&mut *c)
                            .await?;
                        Ok(())
                    })
                })
                .connect(url)
                .await?,
        })
    }
    pub async fn migrate(&self) -> anyhow::Result<()> {
        sqlx::migrate!().run(&self.pool).await?;
        Ok(())
    }
    pub async fn authenticate(&self, token: &str) -> Result<Uuid> {
        sqlx::query_scalar(
            "SELECT owner_id FROM api_keys WHERE token_hash=$1 AND revoked_at IS NULL",
        )
        .bind(hash_bytes(token.as_bytes()))
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(Error::unauthorized)
    }
    pub async fn token_scope(&self, token: &str) -> Result<String> {
        sqlx::query_scalar("SELECT scope FROM api_keys WHERE token_hash=$1 AND revoked_at IS NULL")
            .bind(hash_bytes(token.as_bytes()))
            .fetch_optional(&self.pool)
            .await?
            .ok_or_else(Error::unauthorized)
    }
    pub async fn create_read_key(&self, owner: Uuid) -> anyhow::Result<String> {
        self.create_key(owner, true).await
    }
    pub async fn create_key(&self, owner: Uuid, read_only: bool) -> anyhow::Result<String> {
        let scope = if read_only { "read_only" } else { "full" };
        let token = format!(
            "sb_{scope}_{}{}",
            Uuid::new_v4().simple(),
            Uuid::new_v4().simple()
        );
        sqlx::query("INSERT INTO api_keys(token_hash,owner_id,scope) VALUES($1,$2,$3)")
            .bind(hash_bytes(token.as_bytes()))
            .bind(owner)
            .bind(scope)
            .execute(&self.pool)
            .await?;
        Ok(token)
    }
    pub async fn create_user(&self, name: &str) -> anyhow::Result<(Uuid, String)> {
        let owner = Uuid::new_v4();
        let token = format!("sb_{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        let mut tx = self.pool.begin().await?;
        sqlx::query("INSERT INTO users(id,name) VALUES($1,$2)")
            .bind(owner)
            .bind(name)
            .execute(&mut *tx)
            .await?;
        sqlx::query("INSERT INTO api_keys(token_hash,owner_id) VALUES($1,$2)")
            .bind(hash_bytes(token.as_bytes()))
            .bind(owner)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok((owner, token))
    }
    pub async fn write<'a>(
        &'a self,
        owner: Uuid,
        op: &str,
        key: &str,
        body: &Value,
    ) -> Result<(Transaction<'a, Postgres>, Option<Value>)> {
        if key.is_empty() || key.len() > 128 {
            return Err(Error::bad("invalid_idempotency_key"));
        }
        let mut tx = self.pool.begin().await?;
        // Tenant shared lock coordinates snapshot/export/deletion, not ordinary writes.
        sqlx::query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))")
            .bind(owner.to_string())
            .execute(&mut *tx)
            .await?;
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,1))")
            .bind(format!("{owner}:{op}:{key}"))
            .execute(&mut *tx)
            .await?;
        let saved = sqlx::query(
            "SELECT digest,response FROM requests WHERE owner_id=$1 AND operation=$2 AND key=$3",
        )
        .bind(owner)
        .bind(op)
        .bind(key)
        .fetch_optional(&mut *tx)
        .await?;
        let cached = if let Some(r) = saved {
            if r.get::<String, _>("digest") != digest(body) {
                return Err(Error::conflict("idempotency_content_conflict"));
            }
            Some(r.get("response"))
        } else {
            None
        };
        Ok((tx, cached))
    }
    pub async fn finish(
        tx: &mut Transaction<'_, Postgres>,
        owner: Uuid,
        op: &str,
        key: &str,
        body: &Value,
        response: &Value,
    ) -> Result<()> {
        sqlx::query(
            "INSERT INTO requests(owner_id,operation,key,digest,response) VALUES($1,$2,$3,$4,$5)",
        )
        .bind(owner)
        .bind(op)
        .bind(key)
        .bind(digest(body))
        .bind(response)
        .execute(&mut **tx)
        .await?;
        Ok(())
    }
}
pub async fn event(
    tx: &mut Transaction<'_, Postgres>,
    owner: Uuid,
    call: Option<Uuid>,
    kind: &str,
    body: Value,
) -> Result<()> {
    sqlx::query("INSERT INTO events(id,owner_id,call_id,kind,body) VALUES($1,$2,$3,$4,$5)")
        .bind(Uuid::new_v4())
        .bind(owner)
        .bind(call)
        .bind(kind)
        .bind(body)
        .execute(&mut **tx)
        .await?;
    Ok(())
}
