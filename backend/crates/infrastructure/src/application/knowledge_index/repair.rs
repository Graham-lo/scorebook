//! Bounded anti-entropy scan supplements transactional outbox, including missing vectors.
use super::*;
use sqlx::Row;
pub async fn step(s: &Services) -> Result<()> {
    step_for(s, None).await
}
pub async fn step_for(s: &Services, owner: Option<Uuid>) -> Result<()> {
    let mut tx = s.db.pool.begin().await?;
    sqlx::query("INSERT INTO knowledge_repair_cursors(owner_id) SELECT id FROM users ON CONFLICT DO NOTHING").execute(&mut *tx).await?;
    let row=sqlx::query("SELECT owner_id,source_kind,source_id FROM knowledge_repair_cursors WHERE next_run_at<=now() AND ($1::uuid IS NULL OR owner_id=$1) ORDER BY next_run_at,owner_id LIMIT 1 FOR UPDATE SKIP LOCKED").bind(owner).fetch_optional(&mut *tx).await?;
    let Some(row) = row else {
        return Ok(());
    };
    let owner: Uuid = row.get("owner_id");
    let rows:Vec<(String,Uuid,Value,Option<String>,bool)>=sqlx::query_as("SELECT s.kind,s.id,s.body,d.source_version,EXISTS(SELECT 1 FROM knowledge_chunks c LEFT JOIN knowledge_embeddings e ON e.owner_id=c.owner_id AND e.chunk_id=c.id WHERE c.owner_id=s.owner_id AND c.document_id=d.id AND e.chunk_id IS NULL) OR NOT EXISTS(SELECT 1 FROM knowledge_chunks c WHERE c.owner_id=s.owner_id AND c.document_id=d.id) FROM knowledge_sources s LEFT JOIN knowledge_documents d ON d.owner_id=s.owner_id AND d.source_kind=s.kind AND d.source_id=s.id WHERE s.owner_id=$1 AND (s.kind,s.id)>($2,$3) ORDER BY s.kind,s.id LIMIT 100").bind(owner).bind(row.get::<String,_>("source_kind")).bind(row.get::<Uuid,_>("source_id")).fetch_all(&mut *tx).await?;
    let dirty: Vec<Value> = rows
        .iter()
        .filter(|(_, _, body, version, incomplete)| {
            *incomplete || version.as_ref() != Some(&digest(body))
        })
        .map(|(kind, id, _, _, _)| json!({"kind":kind,"id":id}))
        .collect();
    if !dirty.is_empty() {
        // Rebuild broken clean documents; preserve an in-progress newer outbox revision.
        sqlx::query("DELETE FROM knowledge_documents d USING jsonb_to_recordset($2) r(kind text,id uuid) WHERE d.owner_id=$1 AND d.source_kind=r.kind AND d.source_id=r.id AND NOT EXISTS(SELECT 1 FROM knowledge_dirty q WHERE q.owner_id=d.owner_id AND q.source_kind=d.source_kind AND q.source_id=d.source_id)").bind(owner).bind(json!(dirty)).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO knowledge_dirty(owner_id,source_kind,source_id) SELECT $1,r.kind,r.id FROM jsonb_to_recordset($2) r(kind text,id uuid) ON CONFLICT DO NOTHING").bind(owner).bind(json!(dirty)).execute(&mut *tx).await?;
    }
    sqlx::query("DELETE FROM knowledge_documents WHERE id IN(SELECT d.id FROM knowledge_documents d WHERE d.owner_id=$1 AND NOT EXISTS(SELECT 1 FROM knowledge_sources s WHERE s.owner_id=d.owner_id AND s.kind=d.source_kind AND s.id=d.source_id) LIMIT 100)").bind(owner).execute(&mut *tx).await?;
    if let Some((kind, id, _, _, _)) = rows.last() {
        sqlx::query("UPDATE knowledge_repair_cursors SET source_kind=$2,source_id=$3,next_run_at=now()+interval '1 minute' WHERE owner_id=$1").bind(owner).bind(kind).bind(id).execute(&mut *tx).await?;
    } else {
        sqlx::query("UPDATE knowledge_repair_cursors SET source_kind='',source_id='00000000-0000-0000-0000-000000000000',last_completed_at=now(),next_run_at=now()+interval '24 hours' WHERE owner_id=$1").bind(owner).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(())
}
