use super::*;
pub async fn build(s: &Services, j: &Job) -> Result<Value> {
    let next:Option<(String,Uuid,i64)>=sqlx::query_as("SELECT source_kind,source_id,revision FROM knowledge_dirty WHERE owner_id=$1 ORDER BY changed_at,source_kind,source_id LIMIT 1").bind(j.owner).fetch_optional(&s.db.pool).await?;
    let Some((kind, id, revision)) = next else {
        return Ok(json!({"status":"caught_up","coverage":status(s,j.owner).await?}));
    };
    let row: Option<(DateTime<Utc>, Value)> = sqlx::query_as(
        "SELECT occurred_at,body FROM knowledge_sources WHERE owner_id=$1 AND kind=$2 AND id=$3",
    )
    .bind(j.owner)
    .bind(&kind)
    .bind(id)
    .fetch_optional(&s.db.pool)
    .await?;
    let Some((occurred_at, body)) = row else {
        let mut tx = jobs::fence(s, j).await?;
        sqlx::query(
            "DELETE FROM knowledge_documents WHERE owner_id=$1 AND source_kind=$2 AND source_id=$3",
        )
        .bind(j.owner)
        .bind(&kind)
        .bind(id)
        .execute(&mut *tx)
        .await?;
        sqlx::query("DELETE FROM knowledge_dirty WHERE owner_id=$1 AND source_kind=$2 AND source_id=$3 AND revision=$4").bind(j.owner).bind(kind).bind(id).bind(revision).execute(&mut *tx).await?;
        tx.commit().await?;
        return progress();
    };
    let version = digest(&body);
    let text = format!("{kind}\n{}", serde_json::to_string_pretty(&body).unwrap());
    let chunks = scorebook_core::knowledge_index::chunks(&text)?;
    let mut tx = jobs::fence(s, j).await?;
    let current:Option<i64>=sqlx::query_scalar("SELECT revision FROM knowledge_dirty WHERE owner_id=$1 AND source_kind=$2 AND source_id=$3 FOR UPDATE").bind(j.owner).bind(&kind).bind(id).fetch_optional(&mut *tx).await?;
    if current != Some(revision) {
        tx.rollback().await?;
        return progress();
    }
    let doc = Uuid::parse_str(&digest(&json!([j.owner, kind, id]))[..32]).unwrap();
    let existing:Option<(String,i64)>=sqlx::query_as("SELECT source_version,indexed_revision FROM knowledge_documents WHERE owner_id=$1 AND id=$2").bind(j.owner).bind(doc).fetch_optional(&mut *tx).await?;
    if existing.as_ref().is_some_and(|(v, _)| v != &version) {
        sqlx::query("DELETE FROM knowledge_documents WHERE owner_id=$1 AND id=$2")
            .bind(j.owner)
            .bind(doc)
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query("INSERT INTO knowledge_documents(id,owner_id,source_kind,source_id,source_version,occurred_at,content,source_uri,indexed_revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO NOTHING").bind(doc).bind(j.owner).bind(&kind).bind(id).bind(&version).bind(occurred_at).bind(&text).bind(format!("scorebook://knowledge/{kind}/{id}?version={version}")).bind(revision).execute(&mut *tx).await?;
    let next:i64=sqlx::query_scalar("SELECT COALESCE(max(ordinal)+1,0)::bigint FROM knowledge_chunks WHERE owner_id=$1 AND document_id=$2").bind(j.owner).bind(doc).fetch_one(&mut *tx).await?;
    tx.commit().await?;
    let offset = usize::try_from(next).map_err(|_| Error::bad("invalid_knowledge_cursor"))?;
    if offset > chunks.len() {
        return Err(Error::bad("invalid_knowledge_cursor"));
    }
    // A crash loses at most 16 chunks. Partial documents remain hidden behind dirty.
    let end = (offset + 16).min(chunks.len());
    let mut embeddings = Vec::new();
    for batch in chunks[offset..end].chunks(4) {
        let output = s
            .text
            .encode(batch.iter().map(|v| v.2.clone()).collect())
            .await?;
        if output.model_id != MODEL
            || output.weights_sha256 != WEIGHTS
            || output.vectors.len() != batch.len()
            || output
                .vectors
                .iter()
                .any(|v| v.len() != 1024 || v.iter().any(|x| !x.is_finite()))
        {
            return Err(Error::bad("text_encoder_identity_or_shape_mismatch"));
        }
        embeddings.extend(output.vectors);
    }
    let mut tx = jobs::fence(s, j).await?;
    let current:Option<i64>=sqlx::query_scalar("SELECT revision FROM knowledge_dirty WHERE owner_id=$1 AND source_kind=$2 AND source_id=$3 FOR UPDATE").bind(j.owner).bind(&kind).bind(id).fetch_optional(&mut *tx).await?;
    if current != Some(revision) {
        tx.rollback().await?;
        return progress();
    }
    let rows:Vec<Value>=chunks[offset..end].iter().zip(embeddings).enumerate().map(|(n,((start,end,text),embedding))|json!({"id":Uuid::new_v4(),"ordinal":offset+n,"start_byte":start,"end_byte":end,"content":text,"content_sha256":hash_bytes(text.as_bytes()),"embedding":format!("[{}]",embedding.iter().map(f32::to_string).collect::<Vec<_>>().join(","))})).collect();
    // Concurrent owner index requests must agree on the exact continuation.
    let stored:i64=sqlx::query_scalar("SELECT COALESCE(max(ordinal)+1,0)::bigint FROM knowledge_chunks WHERE owner_id=$1 AND document_id=$2").bind(j.owner).bind(doc).fetch_one(&mut *tx).await?;
    if stored != next {
        tx.rollback().await?;
        return progress();
    }
    if !rows.is_empty() {
        sqlx::query("INSERT INTO knowledge_chunks(id,owner_id,document_id,ordinal,start_byte,end_byte,content,content_sha256) SELECT r.id,$1,$2,r.ordinal,r.start_byte,r.end_byte,r.content,r.content_sha256 FROM jsonb_to_recordset($3) r(id uuid,ordinal int,start_byte int,end_byte int,content text,content_sha256 text)").bind(j.owner).bind(doc).bind(json!(rows)).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO knowledge_embeddings(owner_id,chunk_id,model_id,weights_sha256,embedding) SELECT $1,r.id,$3,$4,r.embedding::vector FROM jsonb_to_recordset($2) r(id uuid,embedding text)").bind(j.owner).bind(json!(rows)).bind(MODEL).bind(WEIGHTS).execute(&mut *tx).await?;
    }
    if end < chunks.len() {
        tx.commit().await?;
        return progress();
    }
    sqlx::query("UPDATE knowledge_documents SET indexed_revision=$3,indexed_at=now() WHERE owner_id=$1 AND id=$2").bind(j.owner).bind(doc).bind(revision).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM knowledge_dirty WHERE owner_id=$1 AND source_kind=$2 AND source_id=$3 AND revision=$4").bind(j.owner).bind(kind).bind(id).bind(revision).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO knowledge_index_watermarks(owner_id,model_id,indexed_documents,last_success_at,last_indexed_revision) VALUES($1,$2,1,now(),$3) ON CONFLICT(owner_id) DO UPDATE SET indexed_documents=knowledge_index_watermarks.indexed_documents+1,last_success_at=now(),last_indexed_revision=greatest(knowledge_index_watermarks.last_indexed_revision,EXCLUDED.last_indexed_revision),updated_at=now()").bind(j.owner).bind(MODEL).bind(revision).execute(&mut *tx).await?;
    tx.commit().await?;
    progress()
}
fn progress() -> Result<Value> {
    Err(Error::deferred(
        "knowledge_index_progress",
        RetryDirective::At(Utc::now() + Duration::milliseconds(100)),
    ))
}
pub async fn schedule(s: &Services) -> Result<()> {
    super::repair::step(s).await?;
    let owners:Vec<Uuid>=sqlx::query_scalar("SELECT DISTINCT d.owner_id FROM knowledge_dirty d WHERE NOT EXISTS(SELECT 1 FROM jobs j WHERE j.owner_id=d.owner_id AND j.kind='knowledge.index' AND j.status IN ('queued','running','retry_wait','blocked_capability','awaiting_input')) LIMIT 10").fetch_all(&s.db.pool).await?;
    for owner in owners {
        super::request(
            s,
            owner,
            &format!("knowledge:{}", Utc::now().timestamp().div_euclid(300)),
        )
        .await?;
    }
    Ok(())
}
