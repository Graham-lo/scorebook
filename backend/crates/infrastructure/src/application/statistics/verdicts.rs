use super::*;
pub async fn schedule(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    owner: Uuid,
    run: Uuid,
    definition: Uuid,
) -> Result<()> {
    // One definition lock and one set-wise insert, independent of group count.
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,5))")
        .bind(format!("{owner}:{definition}"))
        .execute(&mut **tx)
        .await?;
    sqlx::query("WITH candidates AS(SELECT signature,(body->>'denominator')::bigint AS n FROM set_group_metrics WHERE owner_id=$1 AND run_id=$2),prior AS(SELECT signature,max(explicit_count) AS last_count FROM verdict_requests WHERE owner_id=$1 AND definition_id=$3 AND status='decided' GROUP BY signature) INSERT INTO verdict_requests(id,owner_id,definition_id,run_id,signature,threshold,explicit_count) SELECT gen_random_uuid(),$1,$3,$2,c.signature,COALESCE(p.last_count,0)+20,c.n FROM candidates c LEFT JOIN prior p USING(signature) WHERE c.n>=COALESCE(p.last_count,0)+20 AND NOT EXISTS(SELECT 1 FROM verdict_requests r WHERE r.owner_id=$1 AND r.definition_id=$3 AND r.signature=c.signature AND r.status='pending') ON CONFLICT DO NOTHING").bind(owner).bind(run).bind(definition).execute(&mut **tx).await?;
    Ok(())
}
pub async fn list(s: &Services, owner: Uuid, f: VerdictFilter) -> Result<Value> {
    let rows:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(r)-'owner_id' FROM verdict_requests r WHERE owner_id=$1 AND ($2::uuid IS NULL OR id>$2) AND ($3::text IS NULL OR status=$3) ORDER BY id LIMIT 101").bind(owner).bind(f.cursor).bind(f.status).fetch_all(&s.db.pool).await?;
    let more = rows.len() > 100;
    let items: Vec<_> = rows.into_iter().take(100).collect();
    Ok(json!({"next_cursor":if more{items.last().map(|v|v["id"].clone())}else{None},"items":items}))
}
pub async fn decide(s: &Services, owner: Uuid, key: &str, input: VerdictInput) -> Result<Value> {
    if !matches!(input.decision.as_str(), "evidence" | "observe" | "drop")
        || input.evidence.trim().is_empty()
        || input.evidence.len() > 100000
    {
        return Err(Error::bad("invalid_verdict"));
    }
    let body = json!(input);
    let (mut tx, cached) = s.db.write(owner, "verdicts.decide", key, &body).await?;
    if let Some(v) = cached {
        return Ok(v);
    }
    let n=sqlx::query("UPDATE verdict_requests SET status='decided',revision=revision+1 WHERE owner_id=$1 AND id=$2 AND revision=$3 AND status='pending'").bind(owner).bind(input.request_id).bind(input.expected_revision).execute(&mut *tx).await?.rows_affected();
    if n != 1 {
        return Err(Error::conflict("verdict_request_changed"));
    }
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO verdict_events(id,owner_id,request_id,decision,body) VALUES($1,$2,$3,$4,$5)",
    )
    .bind(id)
    .bind(owner)
    .bind(input.request_id)
    .bind(&input.decision)
    .bind(&body)
    .execute(&mut *tx)
    .await?;
    let v = json!({"verdict_event_id":id,"request_id":input.request_id,"decision":input.decision,"revision":input.expected_revision+1,"authority":"explicit_user_decision"});
    Database::finish(&mut tx, owner, "verdicts.decide", key, &body, &v).await?;
    tx.commit().await?;
    Ok(v)
}
