use crate::{
    adapters::db::{Database, digest},
    application::Services,
    application::dto::*,
    error::{Error, Result},
};
use pgvector::Vector;
use serde_json::{Value, json};
use sqlx::Row;
use uuid::Uuid;
pub async fn embed(
    s: &Services,
    owner: Uuid,
    id: Uuid,
    region: Option<Region>,
    model: &str,
) -> Result<(Vector, Value, String)> {
    let rh = digest(&region);
    let region_json = json!(region);
    let existing=sqlx::query("SELECT embedding,quality FROM image_embeddings WHERE owner_id=$1 AND attachment_id=$2 AND model_id=$3 AND region_hash=$4").bind(owner).bind(id).bind(model).bind(&rh).fetch_optional(&s.db.pool).await?;
    if let Some(r) = existing {
        return Ok((r.get("embedding"), r.get("quality"), rh));
    }
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM attachments WHERE owner_id=$1 AND id=$2)")
            .bind(owner)
            .bind(id)
            .fetch_one(&s.db.pool)
            .await?;
    if !exists {
        return Err(Error::not_found());
    }
    let bytes = tokio::fs::read(s.storage.path(owner, id)).await?;
    let f = s.vision.extract(bytes, region, model).await?;
    let vector = Vector::from(f.vector);
    let mut tx = s.db.pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))")
        .bind(owner.to_string())
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO embedding_models(id,dimension,metadata) VALUES($1,$2,$3) ON CONFLICT DO NOTHING").bind(&f.model_id).bind(vector.as_slice().len()as i32).bind(&f.quality).execute(&mut *tx).await?;
    // A model ID has immutable weights/preprocessing; adapter verifies identity.
    sqlx::query("INSERT INTO image_embeddings(id,owner_id,attachment_id,model_id,region,region_hash,embedding,quality) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING").bind(Uuid::new_v4()).bind(owner).bind(id).bind(model).bind(region_json).bind(&rh).bind(&vector).bind(&f.quality).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok((vector, f.quality, rh))
}
pub async fn search_single(
    s: &Services,
    owner: Uuid,
    key: &str,
    input: SimilarityQuery,
) -> Result<Value> {
    let body = json!(input);
    // Query encoder work is outside the idempotency DB transaction.
    let (vector, quality, _) = embed(
        s,
        owner,
        input.attachment_id,
        input.region.clone(),
        &input.model_id,
    )
    .await?;
    let (mut tx, cached) = s.db.write(owner, "similarity.search", key, &body).await?;
    if let Some(v) = cached {
        return Ok(v);
    }
    let cutoff = input.cutoff_at.unwrap_or_else(chrono::Utc::now);
    let limit = input.limit.unwrap_or(10).clamp(1, 50);
    // Exact filtered search is the correctness baseline. MATERIALIZED avoids global ANN underfill.
    // ANN index is provisioned, but enabling it awaits measured filtered recall on the real corpus.
    let rows=sqlx::query("WITH eligible AS MATERIALIZED (SELECT e.embedding,e.attachment_id,e.quality,a.sha256,c.id AS call_id,c.submitted_at,c.original_text,c.instrument,c.market,c.timeframe,COALESCE((SELECT latest.episode_id::text FROM (SELECT el.episode_id,el.status FROM episode_links el WHERE el.owner_id=c.owner_id AND el.call_id=c.id ORDER BY el.created_at DESC,el.id DESC LIMIT 1) latest WHERE latest.status IN ('confirmed','explicit')),c.id::text) AS episode_key FROM image_embeddings e JOIN attachments a ON a.owner_id=e.owner_id AND a.id=e.attachment_id JOIN call_attachments l ON l.owner_id=e.owner_id AND l.attachment_id=e.attachment_id JOIN calls c ON c.owner_id=l.owner_id AND c.id=l.call_id WHERE e.owner_id=$1 AND e.model_id=$2 AND e.attachment_id<>$3 AND a.kind='scene' AND a.uploaded_at<=c.submitted_at AND (a.captured_at IS NULL OR a.captured_at<=c.submitted_at) AND c.submitted_at<=$4 AND a.uploaded_at<=$4 AND ($5::text IS NULL OR c.instrument=$5) AND ($6::text IS NULL OR c.market=$6) AND ($7::text IS NULL OR c.timeframe=$7)), scored AS (SELECT *,embedding <=> $8 AS distance FROM eligible), unique_files AS (SELECT DISTINCT ON(sha256) * FROM scored ORDER BY sha256,distance,submitted_at), grouped AS (SELECT DISTINCT ON(episode_key) * FROM unique_files ORDER BY episode_key,distance,submitted_at) SELECT attachment_id,call_id,submitted_at,original_text,instrument,market,timeframe,distance,episode_key,quality FROM grouped ORDER BY distance,call_id LIMIT $9")
 .bind(owner).bind(&input.model_id).bind(input.attachment_id).bind(cutoff).bind(&input.instrument).bind(&input.market).bind(&input.timeframe).bind(vector).bind(limit).fetch_all(&mut *tx).await?;
    let results:Vec<Value>=rows.iter().map(|r|json!({"attachment_id":r.get::<Uuid,_>("attachment_id"),"call_id":r.get::<Uuid,_>("call_id"),"submitted_at":r.get::<chrono::DateTime<chrono::Utc>,_>("submitted_at"),"original_text":r.get::<String,_>("original_text"),"instrument":r.get::<Option<String>,_>("instrument"),"market":r.get::<Option<String>,_>("market"),"timeframe":r.get::<Option<String>,_>("timeframe"),"cosine_distance":r.get::<f64,_>("distance"),"group_id":r.get::<String,_>("episode_key"),"source_uri":format!("scorebook://calls/{}",r.get::<Uuid,_>("call_id"))})).collect();
    let id = Uuid::new_v4();
    let v = json!({"session_id":id,"model_id":input.model_id,"cutoff_at":cutoff,"items":results,"retrieval":"exact_filtered_cosine_v1","grouping":"exact_image_then_confirmed_episode","query_quality":quality,"score_meaning":"similarity_not_probability","quality_validated":false});
    sqlx::query("INSERT INTO similarity_sessions(id,owner_id,body,results) VALUES($1,$2,$3,$4)")
        .bind(id)
        .bind(owner)
        .bind(&body)
        .bind(&v)
        .execute(&mut *tx)
        .await?;
    Database::finish(&mut tx, owner, "similarity.search", key, &body, &v).await?;
    tx.commit().await?;
    Ok(v)
}
pub async fn feedback(
    s: &Services,
    owner: Uuid,
    key: &str,
    input: SimilarityFeedback,
) -> Result<Value> {
    let body = json!(input);
    let (mut tx, cached) = s.db.write(owner, "similarity.feedback", key, &body).await?;
    if let Some(v) = cached {
        return Ok(v);
    }
    let results: Value =
        sqlx::query_scalar("SELECT results FROM similarity_sessions WHERE owner_id=$1 AND id=$2")
            .bind(owner)
            .bind(input.session_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(Error::not_found)?;
    if !results["items"].as_array().is_some_and(|a| {
        a.iter()
            .any(|r| r["attachment_id"] == input.attachment_id.to_string())
    }) {
        return Err(Error::bad("not_a_search_result"));
    }
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO similarity_feedback(id,owner_id,session_id,attachment_id,relevant,reason) VALUES($1,$2,$3,$4,$5,$6)").bind(id).bind(owner).bind(input.session_id).bind(input.attachment_id).bind(input.relevant).bind(input.reason).execute(&mut *tx).await?;
    let v = json!({"id":id});
    Database::finish(&mut tx, owner, "similarity.feedback", key, &body, &v).await?;
    tx.commit().await?;
    Ok(v)
}

pub async fn search(s: &Services, owner: Uuid, key: &str, input: SimilarityQuery) -> Result<Value> {
    if input.model_id == "hybrid-v1" {
        super::hybrid_search::search(s, owner, key, input).await
    } else {
        search_single(s, owner, key, input).await
    }
}
