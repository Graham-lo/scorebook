use super::*;
pub async fn schedule(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    owner: Uuid,
    run: Uuid,
    definition: Uuid,
    groups: &[Value],
) -> Result<()> {
    for group in groups {
        let n = group["denominator"].as_i64().unwrap_or(0);
        if n < 20 {
            continue;
        }
        let sig = group["signature"].as_str().unwrap();
        // Never create another outstanding request for this stable definition/group.
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,5))")
            .bind(format!("{owner}:{definition}:{sig}"))
            .execute(&mut **tx)
            .await?;
        let pending:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM verdict_requests WHERE owner_id=$1 AND definition_id=$2 AND signature=$3 AND status='pending')").bind(owner).bind(definition).bind(sig).fetch_one(&mut **tx).await?;
        let last:i64=sqlx::query_scalar("SELECT COALESCE(max(explicit_count),0)::bigint FROM verdict_requests WHERE owner_id=$1 AND definition_id=$2 AND signature=$3 AND status='decided'").bind(owner).bind(definition).bind(sig).fetch_one(&mut **tx).await?;
        if pending || n < last + 20 {
            continue;
        }
        sqlx::query("INSERT INTO verdict_requests(id,owner_id,definition_id,run_id,signature,threshold,explicit_count) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING").bind(Uuid::new_v4()).bind(owner).bind(definition).bind(run).bind(sig).bind((last+20) as i32).bind(n as i32).execute(&mut **tx).await?;
    }
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
