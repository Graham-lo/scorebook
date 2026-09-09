use super::*;
pub async fn build(s: &Services, j: &Job) -> Result<Value> {
    let row=sqlx::query("SELECT r.status,r.definition_id,d.body FROM set_runs r JOIN set_definitions d ON d.owner_id=r.owner_id AND d.id=r.definition_id WHERE r.owner_id=$1 AND r.id=$2").bind(j.owner).bind(j.id).fetch_one(&s.db.pool).await?;
    let status: String = row.get("status");
    if status == "ready" {
        return super::get(s, j.owner, j.id).await;
    }
    let input: StatisticsInput = serde_json::from_value(row.get("body"))
        .map_err(|_| Error::bad("invalid_statistics_definition"))?;
    if status == "queued" {
        let mut tx = jobs::fence(s, j).await?;
        // Single MVCC statement freezes all sources and heads together. PostgreSQL
        // streams the set-wise insert; no per-record write or Rust-wide data vector.
        sqlx::query(include_str!("snapshot.sql"))
            .bind(j.owner)
            .bind(j.id)
            .bind(json!(input.filters))
            .bind(&input.grouping)
            .execute(&mut *tx)
            .await?;
        sqlx::query("WITH ranked AS(SELECT ordinal,row_number() OVER(PARTITION BY COALESCE(episode_id,call_id),signature ORDER BY submitted_at,call_id,claim_no) AS n FROM set_sample_members WHERE owner_id=$1 AND run_id=$2 AND eligible) UPDATE set_sample_members m SET representative=true FROM ranked r WHERE m.owner_id=$1 AND m.run_id=$2 AND m.ordinal=r.ordinal AND r.n=1").bind(j.owner).bind(j.id).execute(&mut *tx).await?;
        sqlx::query("UPDATE set_runs SET status='frozen',source_snapshot_at=statement_timestamp() WHERE owner_id=$1 AND id=$2").bind(j.owner).bind(j.id).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO job_targets SELECT DISTINCT owner_id,run_id,'call',call_id FROM set_sample_members WHERE owner_id=$1 AND run_id=$2 ON CONFLICT DO NOTHING").bind(j.owner).bind(j.id).execute(&mut *tx).await?;
        tx.commit().await?;
    }
    let mut tx = jobs::fence(s, j).await?;
    let counts:Value=sqlx::query_scalar("SELECT jsonb_build_object('call_count',count(DISTINCT call_id),'claim_count',count(*),'episode_count',count(DISTINCT COALESCE(episode_id,call_id)),'representative_count',count(*) FILTER(WHERE representative),'excluded_count',count(*) FILTER(WHERE NOT eligible),'result_filter_excluded_count',count(*) FILTER(WHERE NOT selected),'voided_count',count(*) FILTER(WHERE exclusion_reason='voided'),'deleted_count',0) FROM set_sample_members WHERE owner_id=$1 AND run_id=$2").bind(j.owner).bind(j.id).fetch_one(&mut *tx).await?;
    let states:Value=sqlx::query_scalar("WITH names(state) AS(VALUES('realized'),('unrealized'),('not_triggered'),('pending'),('no_criteria'),('insufficient_data')) SELECT jsonb_object_agg(n.state,(SELECT count(*) FROM set_sample_members m WHERE m.owner_id=$1 AND m.run_id=$2 AND m.state=n.state)) FROM names n").bind(j.owner).bind(j.id).fetch_one(&mut *tx).await?;
    let processing:Value=sqlx::query_scalar("SELECT COALESCE(jsonb_object_agg(state,n),'{}') FROM(SELECT COALESCE(processing_state,'absent') AS state,count(*) AS n FROM set_sample_members WHERE owner_id=$1 AND run_id=$2 GROUP BY processing_state) p").bind(j.owner).bind(j.id).fetch_one(&mut *tx).await?;
    let groups: Vec<Value> = sqlx::query_scalar(include_str!("groups.sql"))
        .bind(j.owner)
        .bind(j.id)
        .fetch_all(&mut *tx)
        .await?;
    let stats = json!({"set_snapshot_id":j.id,"counts":counts,"states":states,"processing_states":processing,"groups":groups,"result_policy":"current_formal_head","comparison_policy":input.comparison_policy,"calendar":input.calendar,"selection":if input.filters.result_states.is_empty(){"unconditioned"}else{"result_conditioned"},"members_url":format!("/v1/statistics/runs/{}/members",j.id),"wilson_interval":null,"wilson_reason":"independence_not_established"});
    sqlx::query("UPDATE set_runs SET status='ready',stats=$3,completed_at=now() WHERE owner_id=$1 AND id=$2").bind(j.owner).bind(j.id).bind(&stats).execute(&mut *tx).await?;
    if input.filters.result_states.is_empty() {
        super::verdicts::schedule(&mut tx, j.owner, j.id, row.get("definition_id"), &groups)
            .await?;
    }
    tx.commit().await?;
    Ok(json!({"set_snapshot_id":j.id,"status":"ready","stats":stats}))
}
