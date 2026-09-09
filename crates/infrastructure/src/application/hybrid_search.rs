//! Both explicitly selected descriptors must succeed. No automatic model substitution.
use super::{Services, dto::SimilarityQuery, similarity};
use crate::{
    adapters::db::Database,
    error::{Error, Result},
};
use serde_json::{Value, json};
use std::collections::HashMap;
use uuid::Uuid;
pub async fn search(
    s: &Services,
    owner: Uuid,
    key: &str,
    input: SimilarityQuery,
    persist: bool,
) -> Result<Value> {
    let body = json!(input);
    if persist {
        let (tx, cached) = s.db.write(owner, "similarity.hybrid", key, &body).await?;
        if let Some(v) = cached {
            return Ok(v);
        }
        tx.commit().await?;
    }
    if s.vision.url.is_none() {
        return Err(Error::bad("hybrid_requires_both_models"));
    }
    let cutoff = input.cutoff_at.unwrap_or_else(chrono::Utc::now);
    let limit = input.limit.unwrap_or(10).clamp(1, 50) as usize;
    let mut fused = HashMap::<String, (f64, Value)>::new();
    let mut components = vec![];
    for model in ["candle-profile-v1", "dinov2-small-v1"] {
        let query = SimilarityQuery {
            model_id: model.into(),
            cutoff_at: Some(cutoff),
            limit: Some(50),
            ..input.clone()
        };
        let result = similarity::search_single_mode(s, owner, key, query, false).await?;
        for (rank, item) in result["items"]
            .as_array()
            .ok_or_else(|| Error::bad("invalid_search_result"))?
            .iter()
            .enumerate()
        {
            let group = item["group_id"]
                .as_str()
                .ok_or_else(|| Error::bad("invalid_search_result"))?
                .to_string();
            let v = fused.entry(group).or_insert((0.0, item.clone()));
            v.0 += 1.0 / (61.0 + rank as f64);
            v.1.as_object_mut().unwrap().remove("cosine_distance");
        }
        components.push(json!({"model_id":model,"corpus_version":result["corpus_version"]}));
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
    let mut v = json!({"model_id":"hybrid-v1","cutoff_at":cutoff,"items":items,"components":components,"retrieval":"reciprocal_rank_fusion_k60_v2","quality_validated":false,"score_meaning":"ranking_only_not_probability"});
    if !persist {
        v["storage"] = json!("ephemeral");
        return Ok(v);
    }
    let (mut tx, cached) = s.db.write(owner, "similarity.hybrid", key, &body).await?;
    if let Some(v) = cached {
        return Ok(v);
    }
    let id = Uuid::new_v4();
    v["session_id"] = json!(id);
    sqlx::query("INSERT INTO similarity_sessions(id,owner_id,body,results) VALUES($1,$2,$3,$4)")
        .bind(id)
        .bind(owner)
        .bind(&body)
        .bind(&v)
        .execute(&mut *tx)
        .await?;
    super::search_sessions::references(&mut tx, owner, id, &body, &v).await?;
    Database::finish(&mut tx, owner, "similarity.hybrid", key, &body, &v).await?;
    tx.commit().await?;
    Ok(v)
}
