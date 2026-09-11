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
    // unsupported 是 reindex 看过图之后才下得了的判断，缺一条状态行推不出来，所以仍只认状态表；
    // ready 不一样——整图向量本身就是算过的凭据，哪怕这条状态行是在本次改动之前漏掉的也照样算数，
    // 老数据因此不必重建一遍就能说真话。裁剪区域的向量代表不了整图，只认 region 为空时的 region_hash。
    let whole = digest(&None::<crate::application::dto::Region>);
    let models = sqlx::query(
        "WITH originals AS(SELECT id FROM attachments WHERE owner_id=$1 AND kind='scene'),
 recorded AS(SELECT i.attachment_id,i.model_id,i.status FROM image_index_status i JOIN originals o ON o.id=i.attachment_id WHERE i.owner_id=$1),
 inferred AS(SELECT e.attachment_id,e.model_id FROM image_embeddings e JOIN originals o ON o.id=e.attachment_id
   WHERE e.owner_id=$1 AND e.region_hash=$2 AND e.model_id IN($3,$4)
   AND NOT EXISTS(SELECT 1 FROM recorded r WHERE r.attachment_id=e.attachment_id AND r.model_id=e.model_id))
 SELECT model_id,status,count(*) AS count FROM(
   SELECT model_id,status FROM recorded UNION ALL SELECT model_id,'ready' AS status FROM inferred) x
 GROUP BY model_id,status",
    )
    .bind(owner)
    .bind(&whole)
    .bind(chart_match::MODEL)
    .bind("dinov2-small-v1")
    .fetch_all(&s.db.pool)
    .await?;
    let total: i64 =
        sqlx::query_scalar("SELECT count(*) FROM attachments WHERE owner_id=$1 AND kind='scene'")
            .bind(owner)
            .fetch_one(&s.db.pool)
            .await?;
    Ok(
        json!({"originals":total,"items":models.iter().map(|r|json!({"model_id":r.get::<String,_>("model_id"),"status":r.get::<String,_>("status"),"count":r.get::<i64,_>("count")})).collect::<Vec<_>>(),"protocol":chart_match::PROTOCOL}),
    )
}
