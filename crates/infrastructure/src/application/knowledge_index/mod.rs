//! Transactional dirty identities feed a replaceable derived text index. A
//! source change invalidates its search visibility until the same revision lands.
use super::{
    Services,
    jobs::{self, Job},
};
use crate::{
    adapters::db::{digest, hash_bytes},
    error::{Error, Result, RetryDirective},
};
use chrono::{DateTime, Duration, Utc};
use scorebook_core::{
    api::knowledge_index::*,
    knowledge_index::{MODEL, WEIGHTS},
};
use serde_json::{Value, json};
use uuid::Uuid;
pub mod index;
pub mod repair;
pub async fn source(s: &Services, owner: Uuid, input: SourceRequest) -> Result<Value> {
    let row: Option<(DateTime<Utc>, Value)> = sqlx::query_as(
        "SELECT occurred_at,body FROM knowledge_sources WHERE owner_id=$1 AND kind=$2 AND id=$3 UNION ALL SELECT occurred_at,body FROM chat_tool_evidence WHERE owner_id=$1 AND $2='tool_result' AND id=$3",
    )
    .bind(owner)
    .bind(&input.source_kind)
    .bind(input.source_id)
    .fetch_optional(&s.db.pool)
    .await?;
    let Some((at, body)) = row else {
        return Err(Error::not_found());
    };
    let version = digest(&body);
    if input.source_version.as_ref().is_some_and(|v| v != &version) {
        return Err(Error::conflict("source_version_changed"));
    }
    Ok(
        json!({"source_kind":input.source_kind,"source_id":input.source_id,"source_version":version,"occurred_at":at,"body":body,"source_uri":format!("scorebook://knowledge/{}/{}?version={}",input.source_kind,input.source_id,version)}),
    )
}
pub async fn status(s: &Services, owner: Uuid) -> Result<Value> {
    let row:Value=sqlx::query_scalar("SELECT jsonb_build_object('pending_sources',(SELECT count(*) FROM knowledge_dirty WHERE owner_id=$1),'oldest_pending_at',(SELECT min(changed_at) FROM knowledge_dirty WHERE owner_id=$1),'indexed_sources',(SELECT count(*) FROM knowledge_documents d WHERE owner_id=$1 AND NOT EXISTS(SELECT 1 FROM knowledge_dirty q WHERE q.owner_id=d.owner_id AND q.source_kind=d.source_kind AND q.source_id=d.source_id)),'watermark',(SELECT to_jsonb(w)-'owner_id' FROM knowledge_index_watermarks w WHERE owner_id=$1))").bind(owner).fetch_one(&s.db.pool).await?;
    Ok(row)
}
pub async fn request(s: &Services, owner: Uuid, key: &str) -> Result<Value> {
    let mut tx = s.db.pool.begin().await?;
    let id = jobs::enqueue_tx(
        &mut tx,
        owner,
        "knowledge.index",
        key,
        json!({"protocol":"knowledge-v1"}),
    )
    .await?;
    tx.commit().await?;
    Ok(json!({"job_id":id,"status":"queued"}))
}
pub async fn search(s: &Services, owner: Uuid, input: KnowledgeSearch) -> Result<Value> {
    if input.query.trim().is_empty() || input.query.len() > 4096 {
        return Err(Error::bad("invalid_knowledge_query"));
    }
    let encoded = s.text.encode(vec![input.query.clone()]).await?;
    let vector = pgvector::Vector::from(encoded.vectors[0].clone());
    let limit = input.limit.unwrap_or(10).clamp(1, 30) as i64;
    let mut tx = s.db.pool.begin().await?;
    crate::adapters::ann::configure(&mut tx).await?;
    let semantic:Vec<(Uuid,f64)>=sqlx::query_as("WITH candidates AS MATERIALIZED(SELECT e.chunk_id,(e.embedding<=>$2)::float8 AS distance FROM knowledge_embeddings e JOIN knowledge_chunks c ON c.owner_id=e.owner_id AND c.id=e.chunk_id JOIN knowledge_documents d ON d.owner_id=c.owner_id AND d.id=c.document_id WHERE e.owner_id=$1 AND ($3::text IS NULL OR d.source_kind=$3) AND ($4::timestamptz IS NULL OR d.occurred_at<=$4) AND NOT EXISTS(SELECT 1 FROM knowledge_dirty q WHERE q.owner_id=d.owner_id AND q.source_kind=d.source_kind AND q.source_id=d.source_id) ORDER BY e.embedding<=>$2 LIMIT 60) SELECT chunk_id,distance FROM candidates ORDER BY distance+0,chunk_id").bind(owner).bind(vector).bind(&input.source_kind).bind(input.before).fetch_all(&mut *tx).await?;
    let literal = format!(
        "%{}%",
        input
            .query
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_")
    );
    let lexical:Vec<Uuid>=sqlx::query_scalar("SELECT c.id FROM knowledge_chunks c JOIN knowledge_documents d ON d.owner_id=c.owner_id AND d.id=c.document_id WHERE c.owner_id=$1 AND c.content ILIKE $2 AND ($3::text IS NULL OR d.source_kind=$3) AND ($4::timestamptz IS NULL OR d.occurred_at<=$4) AND NOT EXISTS(SELECT 1 FROM knowledge_dirty q WHERE q.owner_id=d.owner_id AND q.source_kind=d.source_kind AND q.source_id=d.source_id) ORDER BY d.occurred_at DESC,c.id LIMIT 60").bind(owner).bind(literal).bind(input.source_kind).bind(input.before).fetch_all(&mut *tx).await?;
    let mut ranks = std::collections::HashMap::<Uuid, f64>::new();
    for (i, (id, _)) in semantic.iter().enumerate() {
        *ranks.entry(*id).or_default() += 1. / (61 + i) as f64;
    }
    for (i, id) in lexical.iter().enumerate() {
        *ranks.entry(*id).or_default() += 1. / (61 + i) as f64;
    }
    let mut ranked: Vec<_> = ranks.into_iter().collect();
    ranked.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
    let ids: Vec<_> = ranked.iter().map(|v| v.0).collect();
    let rows:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('chunk_id',c.id,'document_id',d.id,'source_kind',d.source_kind,'source_id',d.source_id,'source_version',d.source_version,'source_uri',d.source_uri,'occurred_at',d.occurred_at,'excerpt',c.content,'start_byte',c.start_byte,'end_byte',c.end_byte) FROM knowledge_chunks c JOIN knowledge_documents d ON d.owner_id=c.owner_id AND d.id=c.document_id WHERE c.owner_id=$1 AND c.id=ANY($2) ORDER BY array_position($2,c.id)").bind(owner).bind(&ids).fetch_all(&mut *tx).await?;
    let mut seen = std::collections::HashSet::new();
    let mut items = Vec::new();
    for mut row in rows {
        if !seen.insert(row["document_id"].to_string()) {
            continue;
        }
        let id: Uuid = serde_json::from_value(row["chunk_id"].clone()).unwrap();
        row["rrf_score"] = json!(ranked.iter().find(|v| v.0 == id).unwrap().1);
        items.push(row);
        if items.len() >= limit as usize {
            break;
        }
    }
    tx.commit().await?;
    Ok(
        json!({"items":items,"protocol":"lexical-dense-rrf-v1","model_id":MODEL,"coverage":status(s,owner).await?,"score_interpretation":"retrieval_order_not_probability"}),
    )
}

pub async fn source_slice(s: &Services, owner: Uuid, i: SourceSliceRequest) -> Result<Value> {
    let mut value = source(
        s,
        owner,
        SourceRequest {
            source_kind: i.source_kind,
            source_id: i.source_id,
            source_version: i.source_version,
        },
    )
    .await?;
    let text = serde_json::to_string_pretty(&value["body"])
        .map_err(|_| Error::bad("source_encoding_failed"))?;
    let offset = i.offset_byte.unwrap_or(0);
    let limit = i.limit_bytes.unwrap_or(8000);
    if !(256..=16000).contains(&limit) || offset > text.len() || !text.is_char_boundary(offset) {
        return Err(Error::bad("invalid_source_slice"));
    }
    let mut end = (offset + limit).min(text.len());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    value.as_object_mut().unwrap().remove("body");
    value["text"] = json!(&text[offset..end]);
    value["offset_byte"] = json!(offset);
    value["next_offset_byte"] = if end < text.len() {
        json!(end)
    } else {
        Value::Null
    };
    value["total_bytes"] = json!(text.len());
    value["serialization"] = json!("utf8-json-pretty-v1");
    Ok(value)
}
