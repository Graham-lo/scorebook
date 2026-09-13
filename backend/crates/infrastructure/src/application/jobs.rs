use crate::{
    application::Services,
    error::{Error, ErrorKind, Result, RetryDirective},
};
use chrono::{Duration, Utc};
pub use scorebook_core::api::jobs::*;
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
    let queue = match kind {
        "history.index"
        | "history.plan"
        | "history.subscription"
        | "history.universe"
        | "chart.calibrate"
        | "trade.project"
        | "trade.sync"
        | "trade.export"
        | "baseline.build"
        | "statistics.build" => "batch",
        "export" | "purge_files" | "purge_staging" | "maintenance.gc" | "history.catalog"
        | "knowledge.index" | "backup.run" | "backup.retention" | "images.reindex" => "maintenance",
        _ => "interactive",
    };
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,8))")
        .bind(format!("{owner}:{queue}"))
        .execute(&mut **tx)
        .await?;
    let prior: Option<Uuid> =
        sqlx::query_scalar("SELECT id FROM jobs WHERE owner_id=$1 AND kind=$2 AND dedupe_key=$3")
            .bind(owner)
            .bind(kind)
            .bind(key)
            .fetch_optional(&mut **tx)
            .await?;
    if prior.is_none() {
        let cap = if queue == "interactive" {
            200i64
        } else {
            50i64
        };
        let pending:i64=sqlx::query_scalar("SELECT count(*) FROM (SELECT id FROM jobs WHERE owner_id=$1 AND queue=$2 AND status IN ('queued','retry_wait','running') LIMIT $3) x").bind(owner).bind(queue).bind(cap).fetch_one(&mut **tx).await?;
        if pending >= cap {
            return Err(Error::deferred(
                "queue_capacity_reached",
                RetryDirective::After(5),
            ));
        }
    }
    let inserted:Option<Uuid>=sqlx::query_scalar("INSERT INTO jobs(id,owner_id,kind,dedupe_key,body,queue) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(owner_id,kind,dedupe_key) DO NOTHING RETURNING id")
      .bind(Uuid::new_v4()).bind(owner).bind(kind).bind(key).bind(&body).bind(queue).fetch_optional(&mut **tx).await?;
    let id = if let Some(id) = inserted {
        id
    } else {
        let row =
            sqlx::query("SELECT id,body FROM jobs WHERE owner_id=$1 AND kind=$2 AND dedupe_key=$3")
                .bind(owner)
                .bind(kind)
                .bind(key)
                .fetch_one(&mut **tx)
                .await?;
        if row.get::<Value, _>("body") != body {
            return Err(Error::conflict("job_identity_conflict"));
        }
        row.get("id")
    };
    sqlx::query(
        "INSERT INTO job_targets SELECT $1,$2,r.* FROM reference_ids($3) r ON CONFLICT DO NOTHING",
    )
    .bind(owner)
    .bind(id)
    .bind(&body)
    .execute(&mut **tx)
    .await?;
    if matches!(kind, "assess" | "assess_revision") {
        let call: Uuid = serde_json::from_value(body["call_id"].clone())
            .map_err(|_| Error::bad("invalid_job_target"))?;
        let claim = body["claim_no"]
            .as_i64()
            .ok_or_else(|| Error::bad("invalid_claim"))?;
        sqlx::query("INSERT INTO assessments(owner_id,call_id,claim_no,job_id,state) VALUES($1,$2,$3,$4,'queued') ON CONFLICT(owner_id,call_id,claim_no) DO UPDATE SET job_id=EXCLUDED.job_id,state='queued',reason=NULL,updated_at=now() WHERE assessments.job_id IS DISTINCT FROM EXCLUDED.job_id")
          .bind(owner).bind(call).bind(claim as i32).bind(id).execute(&mut **tx).await?;
    }
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
#[derive(Clone, Debug)]
pub struct Job {
    pub id: Uuid,
    pub owner: Uuid,
    pub kind: String,
    pub body: Value,
    pub lease: Uuid,
    pub attempt: i32,
    pub cycle_attempt: i32,
    pub generation: i64,
}
pub async fn claim(s: &Services) -> Result<Option<Job>> {
    claim_filtered(s, None, None).await
}
pub async fn claim_for(s: &Services, owner: Option<Uuid>) -> Result<Option<Job>> {
    claim_filtered(s, owner, None).await
}
pub async fn claim_filtered(
    s: &Services,
    owner: Option<Uuid>,
    queue: Option<&str>,
) -> Result<Option<Job>> {
    let lease = Uuid::new_v4();
    let mut tx = s.db.pool.begin().await?;
    let lock: bool = sqlx::query_scalar("SELECT pg_try_advisory_xact_lock(hashtextextended($1,9))")
        .bind(format!(
            "claim:{}:{}",
            owner.map(|v| v.to_string()).unwrap_or_default(),
            queue.unwrap_or("all")
        ))
        .fetch_one(&mut *tx)
        .await?;
    if !lock {
        return Ok(None);
    }
    let row=sqlx::query(r#"WITH candidate AS (
        SELECT candidate.id FROM jobs candidate WHERE ($2::uuid IS NULL OR candidate.owner_id=$2) AND ($3::text IS NULL OR candidate.queue=$3)
        AND ((candidate.status IN ('queued','retry_wait') AND candidate.run_after<=now()) OR (candidate.status='running' AND candidate.lease_until<now()))
        AND (SELECT count(*) FROM jobs active WHERE active.queue=candidate.queue AND active.status='running' AND active.lease_until>now() AND ($2::uuid IS NULL OR active.owner_id=$2)) < CASE WHEN candidate.queue='interactive' THEN 2 ELSE 1 END
        ORDER BY COALESCE((SELECT last_claim FROM owner_queue_turns turns WHERE turns.owner_id=candidate.owner_id AND turns.queue=candidate.queue),'1970-01-01'),candidate.run_after,candidate.created_at,candidate.id FOR UPDATE SKIP LOCKED LIMIT 1)
        UPDATE jobs j SET status='running',attempt=attempt+1,cycle_attempt=cycle_attempt+1,lease_owner=$1,lease_until=now()+interval '120 seconds'
        FROM candidate c WHERE j.id=c.id RETURNING j.*"#).bind(lease).bind(owner).bind(queue).fetch_optional(&mut *tx).await?;
    let Some(r) = row else { return Ok(None) };
    let j = Job {
        id: r.get("id"),
        owner: r.get("owner_id"),
        kind: r.get("kind"),
        body: r.get("body"),
        lease,
        attempt: r.get("attempt"),
        cycle_attempt: r.get("cycle_attempt"),
        generation: r.get("generation"),
    };
    sqlx::query("UPDATE job_attempts SET status='lease_expired',finished_at=now() WHERE job_id=$1 AND finished_at IS NULL").bind(j.id).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO job_attempts(owner_id,job_id,attempt,generation,lease_owner) VALUES($1,$2,$3,$4,$5)").bind(j.owner).bind(j.id).bind(j.attempt).bind(j.generation).bind(j.lease).execute(&mut *tx).await?;
    sqlx::query(
        "UPDATE assessments SET state='running',updated_at=now() WHERE owner_id=$1 AND job_id=$2",
    )
    .bind(j.owner)
    .bind(j.id)
    .execute(&mut *tx)
    .await?;
    sqlx::query("INSERT INTO owner_queue_turns(owner_id,queue) SELECT owner_id,queue FROM jobs WHERE id=$1 ON CONFLICT(owner_id,queue) DO UPDATE SET last_claim=now()").bind(j.id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(Some(j))
}
/// 租约看起来不在手上了。真丢了只意味着这份活被别人接走了，不是这份活本身办不成；
/// 何况真丢了的话连 `complete` 那一关都过不去——它要求这一行还在我名下才肯写状态，
/// 所以**能被记下来的 `lease_lost` 恰恰是没真丢的那种**。按 `Never` 判死刑，等于让
/// 一次误读弄死一个已经跑了一小时的批作业（`history.universe` 今早就是这么死的）。
/// 改成 `Backoff`：有退避、有上界（`cycle_attempt` 满 8 次自己转 `needs_attention`），
/// 别人真接走了这份活，重排的那一次也会在 `claim` 那里让位。错误种类仍是 `Conflict`，
/// HTTP 语义一格不动。
pub fn lease_lost() -> Error {
    Error::new(ErrorKind::Conflict, "lease_lost", RetryDirective::Backoff)
}
/// 心跳的节拍，和续租的 120 秒是一对：一拍 30 秒，容得下连丢三拍。
const HEARTBEAT_SECONDS: u64 = 30;
/// 连着够不着数据库多少拍才放手。3 拍 = 90 秒，仍在 120 秒租约之内，放手时还剩 30 秒
/// 够 `complete` 把状态写回去。
const HEARTBEAT_TOLERANCE: u32 = 3;
/// 一次心跳该怎么判。分清两件本来就不是一回事的事：
/// * `Some(1)` —— 续上了。
/// * `Some(0)` —— 这一行已经不在我名下了，租约是真丢了。
/// * `None` —— 这一拍没够着数据库。连接抖一下、连接池等超时、锁卡了一瞬，说的都是
///   「我没问到」，不是「租约没了」。原来的 `_ =>` 把这两件事压成同一件，一次抖动就
///   能把作业打成 `failed`。租约还有 120 秒余量，容得下连丢几拍再说。
fn heartbeat_verdict(rows: Option<u64>, missed: &mut u32) -> Option<Error> {
    match rows {
        Some(1) => {
            *missed = 0;
            None
        }
        Some(_) => Some(lease_lost()),
        None => {
            *missed += 1;
            (*missed >= HEARTBEAT_TOLERANCE)
                .then(|| Error::transient("lease_heartbeat_unreachable"))
        }
    }
}
pub async fn run_one(s: &Services) -> Result<bool> {
    run_filtered(s, None, None).await
}
pub async fn run_filtered(s: &Services, owner: Option<Uuid>, queue: Option<&str>) -> Result<bool> {
    let Some(job) = claim_filtered(s, owner, queue).await? else {
        return Ok(false);
    };
    let result = {
        let work = execute(s, &job);
        tokio::pin!(work);
        let mut heartbeat =
            tokio::time::interval(std::time::Duration::from_secs(HEARTBEAT_SECONDS));
        heartbeat.tick().await;
        let mut missed = 0u32;
        loop {
            tokio::select! {
              result=&mut work=>break result,
              _=heartbeat.tick()=>{
                let alive=sqlx::query("UPDATE jobs SET lease_until=now()+interval '120 seconds' WHERE id=$1 AND lease_owner=$2 AND generation=$3 AND status='running' AND lease_until>now()")
                  .bind(job.id).bind(job.lease).bind(job.generation).execute(&s.db.pool).await;
                if let Err(e)=&alive {
                    tracing::warn!(job=%job.id,kind=%job.kind,missed=missed+1,error=%e,"job lease heartbeat could not reach the database");
                }
                if let Some(e)=heartbeat_verdict(alive.map(|r|r.rows_affected()).ok(),&mut missed){
                    break Err(e);
                }
              }
            }
        }
    };
    complete(s, &job, result).await?;
    Ok(true)
}
pub async fn complete(s: &Services, job: &Job, result: Result<Value>) -> Result<()> {
    let mut tx = s.db.pool.begin().await?;
    let owned:Option<Uuid>=sqlx::query_scalar("SELECT id FROM jobs WHERE id=$1 AND lease_owner=$2 AND generation=$3 AND status='running' AND lease_until>now() FOR UPDATE")
      .bind(job.id).bind(job.lease).bind(job.generation).fetch_optional(&mut *tx).await?;
    if owned.is_none() {
        return Err(lease_lost());
    }
    let (status, assessment, code, retry, run_after, output) = match result {
        Ok(v) => ("succeeded", "completed", None, None, Utc::now(), Some(v)),
        Err(e) => {
            let (state, assessment, at) = match &e.retry {
                RetryDirective::AwaitCapability => {
                    ("blocked_capability", "blocked_capability", Utc::now())
                }
                RetryDirective::AwaitInput => ("awaiting_input", "awaiting_input", Utc::now()),
                RetryDirective::At(at) => ("retry_wait", "waiting_due", *at),
                RetryDirective::After(seconds) if job.cycle_attempt < 8 => (
                    "retry_wait",
                    "retry_wait",
                    Utc::now() + Duration::seconds(i64::from(*seconds)),
                ),
                RetryDirective::Backoff if job.cycle_attempt < 8 => {
                    let secs = (5_i64 * 2_i64.pow(job.cycle_attempt.clamp(0, 8) as u32)).min(1800)
                        + (Uuid::new_v4().as_u128() % 10) as i64;
                    (
                        "retry_wait",
                        "retry_wait",
                        Utc::now() + Duration::seconds(secs),
                    )
                }
                RetryDirective::Never => ("failed", "needs_attention", Utc::now()),
                _ => ("needs_attention", "needs_attention", Utc::now()),
            };
            (
                state,
                assessment,
                Some(e.code),
                Some(json!(e.retry)),
                at,
                None,
            )
        }
    };
    sqlx::query("UPDATE jobs SET status=$2,error_code=$3,result=$4,run_after=$5,lease_until=NULL,lease_owner=NULL WHERE id=$1")
      .bind(job.id).bind(status).bind(&code).bind(output).bind(run_after).execute(&mut *tx).await?;
    sqlx::query("UPDATE job_attempts SET status=$3,error_code=$4,retry=$5,finished_at=now() WHERE job_id=$1 AND attempt=$2")
      .bind(job.id).bind(job.attempt).bind(status).bind(&code).bind(retry).execute(&mut *tx).await?;
    sqlx::query("UPDATE assessments SET state=$3,reason=$4,due_at=$5,updated_at=now() WHERE owner_id=$1 AND job_id=$2")
      .bind(job.owner).bind(job.id).bind(assessment).bind(&code).bind(run_after).execute(&mut *tx).await?;
    if job.kind == "history.index" {
        sqlx::query(
            "UPDATE history_indexes SET status=$3 WHERE owner_id=$1 AND id=$2 AND status<>'ready'",
        )
        .bind(job.owner)
        .bind(job.id)
        .bind(status)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

pub async fn retry(
    s: &Services,
    owner: Uuid,
    id: Uuid,
    key: &str,
    input: RetryRequest,
) -> Result<Value> {
    let body = json!({"job_id":id,"expected_generation":input.expected_generation});
    let (mut tx, cached) = s.db.write(owner, "jobs.retry", key, &body).await?;
    if let Some(v) = cached {
        return Ok(v);
    }
    let row =
        sqlx::query("SELECT status,generation FROM jobs WHERE owner_id=$1 AND id=$2 FOR UPDATE")
            .bind(owner)
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(Error::not_found)?;
    if row.get::<i64, _>("generation") != input.expected_generation {
        return Err(Error::conflict("job_generation_conflict"));
    }
    if !matches!(
        row.get::<String, _>("status").as_str(),
        "failed" | "needs_attention" | "blocked_capability" | "awaiting_input"
    ) {
        return Err(Error::conflict("job_not_retryable_in_current_state"));
    }
    sqlx::query("UPDATE jobs SET status='queued',generation=generation+1,cycle_attempt=0,error_code=NULL,result=NULL,lease_owner=NULL,lease_until=NULL,run_after=now() WHERE id=$1").bind(id).execute(&mut *tx).await?;
    sqlx::query("UPDATE assessments SET state='queued',reason=NULL,updated_at=now() WHERE owner_id=$1 AND job_id=$2").bind(owner).bind(id).execute(&mut *tx).await?;
    sqlx::query("UPDATE history_indexes SET status='queued' WHERE owner_id=$1 AND id=$2 AND status<>'ready'").bind(owner).bind(id).execute(&mut *tx).await?;
    let v = json!({"job_id":id,"status":"queued","generation":input.expected_generation+1});
    crate::adapters::db::Database::finish(&mut tx, owner, "jobs.retry", key, &body, &v).await?;
    tx.commit().await?;
    Ok(v)
}
async fn execute(s: &Services, j: &Job) -> Result<Value> {
    match j.kind.as_str() {
        "embed" => {
            let id: Uuid = serde_json::from_value(j.body["attachment_id"].clone())
                .map_err(|_| Error::bad("invalid_job"))?;
            let m = j.body["model_id"]
                .as_str()
                .ok_or_else(|| Error::bad("invalid_job"))?;
            let (_, quality, _) = if m == "dinov2-small-v1" {
                super::similarity::embed_chart_visual(s, j.owner, id).await?
            } else {
                super::similarity::embed(s, j.owner, id, None, m).await?
            };
            Ok(json!({"attachment_id":id,"model_id":m,"quality":quality}))
        }
        "trade.export" => super::trades::historical_export::step(s, j).await,
        "trade.sync" => super::trades::sync::step(s, j).await,
        "trade.project" => super::trades::projection::build(s, j).await,
        "images.reindex" => super::chart_search::reindex::step(s, j).await,
        "chart.search" => super::chart_search::run(s, j).await,
        "chart.calibrate" => super::chart_search::calibration::run(s, j).await,
        "attachment.locate" => super::locate::run(s, j).await,
        "history.index" => super::history::build(s, j).await,
        "history.plan" => super::history_plans::step(s, j).await,
        "history.subscription" => super::history_catalog::subscriptions::step(s, j).await,
        "history.universe" => super::history_catalog::universe::step(s, j).await,
        "history.catalog" => super::history_catalog::refresh(s).await,
        "statistics.build" => super::statistics::snapshot::build(s, j).await,
        "baseline.build" => super::statistics::baseline::build(s, j).await,
        "assess" | "assess_revision" => super::settlement::settle(s, j).await,
        "export" => super::exports::export_job(s, j).await,
        "backup.run" => super::backups::step(s, j).await,
        "backup.retention" => super::backups::retention(s, j).await,
        "chat.run" => super::chat::runtime::run(s, j).await,
        "knowledge.index" => super::knowledge_index::index::build(s, j).await,
        "maintenance.gc" => super::gc::owner(s, j.owner).await,
        "purge_staging" => {
            let runs: Vec<serde_json::Value> = serde_json::from_value(j.body["runs"].clone())
                .map_err(|_| Error::bad("invalid_job"))?;
            for run in &runs {
                let id: Uuid = serde_json::from_value(run["export_id"].clone())
                    .map_err(|_| Error::bad("invalid_job"))?;
                let token: Uuid = serde_json::from_value(run["token"].clone())
                    .map_err(|_| Error::bad("invalid_job"))?;
                let path = s
                    .storage
                    .root
                    .join("exports")
                    .join(j.owner.to_string())
                    .join(format!(".{id}.{token}.staging"));
                match tokio::fs::remove_dir_all(path).await {
                    Ok(()) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => return Err(e.into()),
                }
                sqlx::query(
                    "DELETE FROM export_runs WHERE owner_id=$1 AND export_id=$2 AND token=$3",
                )
                .bind(j.owner)
                .bind(id)
                .bind(token)
                .execute(&s.db.pool)
                .await?;
            }
            Ok(json!({"staging_removed":runs.len()}))
        }
        "purge_files" => {
            let ids: Vec<Uuid> = serde_json::from_value(j.body["attachment_ids"].clone())
                .map_err(|_| Error::bad("invalid_job"))?;
            for id in &ids {
                s.images.remove(j.owner, *id).await?;
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
            sqlx::query("UPDATE storage_objects SET state='purged',updated_at=now() WHERE owner_id=$1 AND id=ANY($2)").bind(j.owner).bind(&ids).execute(&s.db.pool).await?;
            Ok(json!({"files_removed":ids.len(),"physical_cleanup":"complete"}))
        }
        _ => Err(Error::bad("unknown_job_kind")),
    }
}

/// Shared owner maintenance lock plus a live row-locked job lease.
pub async fn fence<'a>(s: &'a Services, j: &Job) -> Result<Transaction<'a, Postgres>> {
    let mut tx = s.db.pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))")
        .bind(j.owner.to_string())
        .execute(&mut *tx)
        .await?;
    let active:Option<Uuid>=sqlx::query_scalar("SELECT id FROM jobs WHERE id=$1 AND owner_id=$2 AND lease_owner=$3 AND generation=$4 AND status='running' AND lease_until>now() FOR UPDATE").bind(j.id).bind(j.owner).bind(j.lease).bind(j.generation).fetch_optional(&mut *tx).await?;
    if active.is_none() {
        return Err(lease_lost());
    }
    Ok(tx)
}

#[cfg(test)]
mod lease_tests {
    use super::*;
    #[test]
    fn a_database_blip_is_not_a_lost_lease() {
        let mut missed = 0;
        // 够不着数据库：容忍到上限之前一声不吭，中间续上一次就重新归零。
        for _ in 1..HEARTBEAT_TOLERANCE {
            assert!(heartbeat_verdict(None, &mut missed).is_none());
        }
        assert!(heartbeat_verdict(Some(1), &mut missed).is_none());
        assert_eq!(missed, 0);
        for _ in 1..HEARTBEAT_TOLERANCE {
            assert!(heartbeat_verdict(None, &mut missed).is_none());
        }
        // 连丢满 HEARTBEAT_TOLERANCE 拍（90 秒，仍在 120 秒租约内）才放手，而且放手
        // 的理由是「够不着」，不是「租约没了」——它必须是可重试的。
        let e = heartbeat_verdict(None, &mut missed).unwrap();
        assert_eq!(e.code, "lease_heartbeat_unreachable");
        assert!(e.retry.retryable());
    }
    #[test]
    fn a_row_owned_by_someone_else_is_a_lost_lease_but_not_a_dead_job() {
        let mut missed = 0;
        let e = heartbeat_verdict(Some(0), &mut missed).unwrap();
        assert_eq!(e.code, "lease_lost");
        // 别人接走了这份活不是这份活办不成：有退避地重排，不是判死刑。
        assert!(e.retry.retryable());
        assert!(matches!(lease_lost().retry, RetryDirective::Backoff));
    }
}
