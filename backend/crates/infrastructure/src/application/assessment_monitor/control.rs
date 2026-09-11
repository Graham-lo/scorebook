use super::*;
use crate::adapters::db::Database;
use scorebook_core::api::jobs::AssessmentSourcePlan;
pub async fn select(
    s: &Services,
    owner: Uuid,
    id: Uuid,
    key: &str,
    input: AssessmentSourcePlan,
) -> Result<Value> {
    if !matches!(
        input.source_plan.as_str(),
        "rest_continuous_v1" | "daily_archive_v1"
    ) || input.reason.trim().is_empty()
        || input.reason.len() > 2000
    {
        return Err(Error::bad("invalid_assessment_source_plan"));
    }
    let body = json!({"job_id":id,"input":input});
    let (mut tx, cached) =
        s.db.write(owner, "assessment.source_plan", key, &body)
            .await?;
    if let Some(v) = cached {
        return Ok(v);
    }
    let row: Option<(i64, String, String)> = sqlx::query_as(
        "SELECT generation,status,kind FROM jobs WHERE owner_id=$1 AND id=$2 FOR UPDATE",
    )
    .bind(owner)
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?;
    let (generation, status, kind) = row.ok_or_else(Error::not_found)?;
    if generation != input.expected_generation {
        return Err(Error::conflict("job_generation_conflict"));
    }
    if !matches!(kind.as_str(), "assess" | "assess_revision")
        || !matches!(
            status.as_str(),
            "queued" | "retry_wait" | "awaiting_input" | "blocked_capability" | "failed"
        )
    {
        return Err(Error::conflict("assessment_source_not_changeable"));
    }
    let terminal:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM trigger_watches WHERE owner_id=$1 AND id=$2 AND result IS NOT NULL)").bind(owner).bind(id).fetch_one(&mut *tx).await?;
    if terminal {
        return Err(Error::conflict("completed_assessment_requires_revision"));
    }
    let digest: Option<String> = sqlx::query_scalar(
        "SELECT source_sha256 FROM trigger_checkpoints WHERE owner_id=$1 AND watch_id=$2",
    )
    .bind(owner)
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?;
    sqlx::query("INSERT INTO assessment_source_plans(owner_id,job_id,source_plan,generation,reason) VALUES($1,$2,$3,$4,$5) ON CONFLICT(owner_id,job_id) DO UPDATE SET source_plan=EXCLUDED.source_plan,generation=EXCLUDED.generation,reason=EXCLUDED.reason,updated_at=now()").bind(owner).bind(id).bind(&input.source_plan).bind(generation+1).bind(&input.reason).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO assessment_source_decisions(id,owner_id,job_id,generation,source_plan,reason,checkpoint_sha256) VALUES($1,$2,$3,$4,$5,$6,$7)").bind(Uuid::new_v4()).bind(owner).bind(id).bind(generation+1).bind(&input.source_plan).bind(&input.reason).bind(digest).execute(&mut *tx).await?;
    sqlx::query(
        "UPDATE trigger_watches SET source_plan=$3,updated_at=now() WHERE owner_id=$1 AND id=$2",
    )
    .bind(owner)
    .bind(id)
    .bind(&input.source_plan)
    .execute(&mut *tx)
    .await?;
    sqlx::query("UPDATE jobs SET status='queued',generation=generation+1,cycle_attempt=0,run_after=now(),error_code=NULL,lease_owner=NULL,lease_until=NULL WHERE owner_id=$1 AND id=$2").bind(owner).bind(id).execute(&mut *tx).await?;
    let v = json!({"job_id":id,"generation":generation+1,"source_plan":input.source_plan,"status":"queued","archive_policy":{"trades":"official_daily_checksum_verified","atr_and_closed_bars":"declared_binance_rest","reference_days":2,"incomplete_day":"wait_for_publication"}});
    Database::finish(&mut tx, owner, "assessment.source_plan", key, &body, &v).await?;
    tx.commit().await?;
    Ok(v)
}
