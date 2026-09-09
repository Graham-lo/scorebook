use super::*;
use crate::error::RetryDirective;
use sqlx::Row;
pub async fn request(s: &Services, owner: Uuid, key: &str) -> Result<Value> {
    let mut tx = s.db.pool.begin().await?;
    let id = jobs::enqueue_tx(
        &mut tx,
        owner,
        "images.reindex",
        key,
        json!({"protocol":"chart-match-v2"}),
    )
    .await?;
    sqlx::query("INSERT INTO image_reindex_runs(id,owner_id) VALUES($1,$2) ON CONFLICT DO NOTHING")
        .bind(id)
        .bind(owner)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(json!({"job_id":id,"status":"queued"}))
}
pub async fn step(s: &Services, j: &Job) -> Result<Value> {
    let after: Option<Uuid> =
        sqlx::query_scalar("SELECT after_id FROM image_reindex_runs WHERE owner_id=$1 AND id=$2")
            .bind(j.owner)
            .bind(j.id)
            .fetch_one(&s.db.pool)
            .await?;
    let ids:Vec<Uuid>=sqlx::query_scalar("SELECT id FROM attachments WHERE owner_id=$1 AND kind='scene' AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT 8").bind(j.owner).bind(after).fetch_all(&s.db.pool).await?;
    for id in &ids {
        for model in [chart_match::MODEL, "dinov2-small-v1"] {
            let result = super::super::similarity::embed(s, j.owner, *id, None, model).await;
            let reason = match &result {
                Ok(_) => None,
                Err(e)
                    if model == chart_match::MODEL
                        && matches!(
                            e.code.as_str(),
                            "chart_too_complex_select_region"
                                | "ordinary_candles_not_resolved"
                                | "chart_obstructed_or_unsupported"
                                | "flat_chart_geometry"
                        ) =>
                {
                    Some(e.code.clone())
                }
                Err(e) => return Err(e.clone()),
            };
            let mut tx = jobs::fence(s, j).await?;
            sqlx::query("INSERT INTO image_index_status(owner_id,attachment_id,model_id,status,reason) VALUES($1,$2,$3,$4,$5) ON CONFLICT(owner_id,attachment_id,model_id) DO UPDATE SET status=EXCLUDED.status,reason=EXCLUDED.reason,checked_at=now()").bind(j.owner).bind(id).bind(model).bind(if reason.is_some(){"unsupported"}else{"ready"}).bind(reason).execute(&mut *tx).await?;
            tx.commit().await?;
        }
        let mut tx = jobs::fence(s, j).await?;
        sqlx::query("UPDATE image_reindex_runs SET after_id=$3,processed=processed+1 WHERE owner_id=$1 AND id=$2").bind(j.owner).bind(j.id).bind(id).execute(&mut *tx).await?;
        tx.commit().await?;
    }
    if !ids.is_empty() {
        return Err(Error::deferred(
            "image_reindex_progress",
            RetryDirective::At(Utc::now() + chrono::Duration::seconds(1)),
        ));
    }
    // Obsolete private derived vectors are removed only after every original was visited.
    let mut tx = jobs::fence(s, j).await?;
    sqlx::query("DELETE FROM image_embeddings WHERE owner_id=$1 AND model_id='candle-profile-v1'")
        .bind(j.owner)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(
        json!({"status":"complete","protocol":chart_match::PROTOCOL,"coverage":status(s,j.owner).await?}),
    )
}
pub async fn status(s: &Services, owner: Uuid) -> Result<Value> {
    let models=sqlx::query("SELECT model_id,status,count(*) AS count FROM image_index_status WHERE owner_id=$1 GROUP BY model_id,status").bind(owner).fetch_all(&s.db.pool).await?;
    let total: i64 =
        sqlx::query_scalar("SELECT count(*) FROM attachments WHERE owner_id=$1 AND kind='scene'")
            .bind(owner)
            .fetch_one(&s.db.pool)
            .await?;
    Ok(
        json!({"originals":total,"items":models.iter().map(|r|json!({"model_id":r.get::<String,_>("model_id"),"status":r.get::<String,_>("status"),"count":r.get::<i64,_>("count")})).collect::<Vec<_>>(),"protocol":chart_match::PROTOCOL}),
    )
}
