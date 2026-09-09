//! Rank fusion keeps visual and structure embedding spaces separate.
use super::{Services, dto::SimilarityQuery, similarity};
use crate::{
    adapters::db::Database,
    error::{Error, Result},
};
use serde_json::{Value, json};
use std::collections::HashMap;
use uuid::Uuid;
pub async fn search(s: &Services, owner: Uuid, key: &str, input: SimilarityQuery) -> Result<Value> {
    let body = json!(input);
    let (tx, cached) = s.db.write(owner, "similarity.hybrid", key, &body).await?;
    if let Some(v) = cached {
        return Ok(v);
    }
    tx.commit().await?;
    let first_key = crate::adapters::db::digest(&(key, "candle-profile-v1"));
    let second_key = crate::adapters::db::digest(&(key, "dinov2-small-v1"));
    let prior:Option<Value>=sqlx::query_scalar("SELECT response FROM requests WHERE owner_id=$1 AND operation='similarity.search' AND key=ANY($2) ORDER BY created_at LIMIT 1").bind(owner).bind(vec![first_key,second_key]).fetch_optional(&s.db.pool).await?;
    let cutoff = input
        .cutoff_at
        .or_else(|| {
            prior
                .as_ref()
                .and_then(|v| v["cutoff_at"].as_str())
                .and_then(|v| v.parse().ok())
        })
        .unwrap_or_else(chrono::Utc::now);
    let limit = input.limit.unwrap_or(10).clamp(1, 50) as usize;
    let mut fused = HashMap::<String, (f64, Value)>::new();
    let mut components = vec![];
    let mut failures = vec![];
    for model in ["candle-profile-v1", "dinov2-small-v1"] {
        if model == "dinov2-small-v1" && s.vision.url.is_none() {
            failures.push(json!({"model_id":model,"reason":"not_configured"}));
            continue;
        }
        let query = SimilarityQuery {
            model_id: model.into(),
            cutoff_at: Some(cutoff),
            limit: Some(50),
            ..input.clone()
        };
        match similarity::search_single(
            s,
            owner,
            &crate::adapters::db::digest(&(key, model)),
            query,
        )
        .await
        {
            Ok(result) => {
                for (rank, item) in result["items"].as_array().unwrap().iter().enumerate() {
                    let k = item["group_id"]
                        .as_str()
                        .ok_or_else(|| Error::bad("invalid_search_result"))?
                        .to_string();
                    let v = fused.entry(k).or_insert((0.0, item.clone()));
                    v.0 += 1.0 / (60.0 + rank as f64 + 1.0);
                    v.1.as_object_mut().unwrap().remove("cosine_distance");
                }
                components.push(json!({"model_id":model,"session_id":result["session_id"]}));
            }
            Err(e) => failures.push(json!({"model_id":model,"reason":e.code})),
        }
    }
    if components.is_empty() {
        return Err(Error::bad("no_available_image_descriptor"));
    }
    let mut ranked: Vec<_> = fused.into_values().collect();
    ranked.sort_by(|a, b| {
        b.0.total_cmp(&a.0)
            .then_with(|| a.1["call_id"].as_str().cmp(&b.1["call_id"].as_str()))
    });
    let items: Vec<_> = ranked
        .into_iter()
        .take(limit)
        .map(|(score, mut item)| {
            item["rank_fusion_score"] = json!(score);
            item
        })
        .collect();
    let (mut tx, cached) = s.db.write(owner, "similarity.hybrid", key, &body).await?;
    if let Some(v) = cached {
        return Ok(v);
    }
    let id = Uuid::new_v4();
    let v = json!({"session_id":id,"model_id":"hybrid-v1","cutoff_at":cutoff,"items":items,"components":components,"unavailable_components":failures,"retrieval":"reciprocal_rank_fusion_k60_v1","quality_validated":false,"score_meaning":"ranking_only_not_probability"});
    sqlx::query("INSERT INTO similarity_sessions(id,owner_id,body,results) VALUES($1,$2,$3,$4)")
        .bind(id)
        .bind(owner)
        .bind(&body)
        .bind(&v)
        .execute(&mut *tx)
        .await?;
    Database::finish(&mut tx, owner, "similarity.hybrid", key, &body, &v).await?;
    tx.commit().await?;
    Ok(v)
}
