use crate::{
    application::Services,
    error::{Error, Result},
};
use serde_json::{Value, json};
use sqlx::{Postgres, Row, Transaction};
use uuid::Uuid;
pub async fn enqueue_tx(
    tx: &mut Transaction<'_, Postgres>,
    owner: Uuid,
    kind: &str,
    key: &str,
    body: Value,
) -> Result<Uuid> {
    let id:Uuid=sqlx::query_scalar("INSERT INTO jobs(id,owner_id,kind,dedupe_key,body) VALUES($1,$2,$3,$4,$5) ON CONFLICT(owner_id,kind,dedupe_key) DO UPDATE SET dedupe_key=EXCLUDED.dedupe_key RETURNING id").bind(Uuid::new_v4()).bind(owner).bind(kind).bind(key).bind(body).fetch_one(&mut **tx).await?;
    Ok(id)
}
pub async fn get(s: &Services, owner: Uuid, id: Uuid) -> Result<Value> {
    sqlx::query_scalar(
        "SELECT to_jsonb(j)-'owner_id'-'lease_owner' FROM jobs j WHERE owner_id=$1 AND id=$2",
    )
    .bind(owner)
    .bind(id)
    .fetch_optional(&s.db.pool)
    .await?
    .ok_or_else(Error::not_found)
}
pub struct Job {
    pub id: Uuid,
    pub owner: Uuid,
    pub kind: String,
    pub body: Value,
    pub lease: Uuid,
    pub attempt: i32,
}
pub async fn claim(s: &Services) -> Result<Option<Job>> {
    claim_for(s, None).await
}
pub async fn claim_for(s: &Services, owner: Option<Uuid>) -> Result<Option<Job>> {
    let lease = Uuid::new_v4();
    let row=sqlx::query("WITH candidate AS (SELECT id FROM jobs WHERE ($2::uuid IS NULL OR owner_id=$2) AND ((status='queued' AND run_after<=now()) OR (status='running' AND lease_until<now())) ORDER BY run_after,created_at FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE jobs j SET status='running',attempt=attempt+1,lease_owner=$1,lease_until=now()+interval '120 seconds' FROM candidate c WHERE j.id=c.id RETURNING j.*").bind(lease).bind(owner).fetch_optional(&s.db.pool).await?;
    Ok(row.map(|r| Job {
        id: r.get("id"),
        owner: r.get("owner_id"),
        kind: r.get("kind"),
        body: r.get("body"),
        lease,
        attempt: r.get("attempt"),
    }))
}
pub async fn run_one(s: &Services) -> Result<bool> {
    let Some(job) = claim(s).await? else {
        return Ok(false);
    };
    let pool = s.db.pool.clone();
    let (id, lease) = (job.id, job.lease);
    let heartbeat = tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
            let _=sqlx::query("UPDATE jobs SET lease_until=now()+interval '120 seconds' WHERE id=$1 AND lease_owner=$2 AND status='running'").bind(id).bind(lease).execute(&pool).await;
        }
    });
    let result = execute(s, &job).await;
    heartbeat.abort();
    let mut tx = s.db.pool.begin().await?;
    let owned:Option<Uuid>=sqlx::query_scalar("SELECT id FROM jobs WHERE id=$1 AND lease_owner=$2 AND status='running' AND lease_until>now() FOR UPDATE").bind(job.id).bind(job.lease).fetch_optional(&mut *tx).await?;
    if owned.is_none() {
        return Ok(true);
    }
    match result {
        Ok(output) => {
            sqlx::query("UPDATE jobs SET status='succeeded',result=$3,error_code=NULL,lease_until=NULL WHERE id=$1 AND lease_owner=$2").bind(job.id).bind(job.lease).bind(output).execute(&mut *tx).await?;
        }
        Err(e) => {
            let terminal = job.attempt >= 4 || e.status.is_client_error();
            sqlx::query("UPDATE jobs SET status=$3,error_code=$4,run_after=now()+interval '30 seconds',lease_until=NULL WHERE id=$1 AND lease_owner=$2").bind(job.id).bind(job.lease).bind(if terminal{"failed"}else{"queued"}).bind(e.code).execute(&mut *tx).await?;
        }
    }
    tx.commit().await?;
    Ok(true)
}
async fn execute(s: &Services, j: &Job) -> Result<Value> {
    match j.kind.as_str() {
        "embed" => {
            let id: Uuid = serde_json::from_value(j.body["attachment_id"].clone())
                .map_err(|_| Error::bad("invalid_job"))?;
            let m = j.body["model_id"]
                .as_str()
                .ok_or_else(|| Error::bad("invalid_job"))?;
            let (_, quality, _) = super::similarity::embed(s, j.owner, id, None, m).await?;
            Ok(json!({"attachment_id":id,"model_id":m,"quality":quality}))
        }
        "history.index" => super::history::build(s, j).await,
        "assess" => super::settlement::settle(s, j).await,
        "market" => Err(Error::bad("retired_use_ephemeral_market_api")),
        "export" => super::exports::export(s, j.owner, j.id).await,
        "purge_files" => {
            let ids: Vec<Uuid> = serde_json::from_value(j.body["attachment_ids"].clone())
                .map_err(|_| Error::bad("invalid_job"))?;
            for id in &ids {
                let path = s.storage.path(j.owner, *id);
                match tokio::fs::remove_file(path).await {
                    Ok(()) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => return Err(e.into()),
                }
            }
            let export_ids: Vec<Uuid> = serde_json::from_value(j.body["export_ids"].clone())
                .map_err(|_| Error::bad("invalid_job"))?;
            for id in export_ids {
                let path = s
                    .storage
                    .root
                    .join("exports")
                    .join(j.owner.to_string())
                    .join(id.to_string());
                match tokio::fs::remove_dir_all(path).await {
                    Ok(()) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => return Err(e.into()),
                }
            }
            Ok(json!({"files_removed":ids.len(),"physical_cleanup":"complete"}))
        }
        _ => Err(Error::bad("unknown_job_kind")),
    }
}
