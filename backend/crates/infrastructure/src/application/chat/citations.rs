use super::*;
pub fn collect(value: &Value) -> Vec<Citation> {
    fn walk(v: &Value, out: &mut Vec<Citation>) {
        match v {
            Value::Object(m) => {
                if let (Some(k), Some(id), Some(version)) = (
                    m.get("source_kind").and_then(Value::as_str),
                    m.get("source_id").and_then(Value::as_str),
                    m.get("source_version").and_then(Value::as_str),
                ) && let Ok(id) = Uuid::parse_str(id)
                {
                    out.push(Citation {
                        source_kind: k.into(),
                        source_id: id,
                        source_version: version.into(),
                    });
                }
                for child in m.values() {
                    walk(child, out);
                }
            }
            Value::Array(a) => {
                for child in a {
                    walk(child, out);
                }
            }
            _ => {}
        }
    }
    let mut out = Vec::new();
    walk(value, &mut out);
    out.sort_by(|a, b| {
        (&a.source_kind, a.source_id, &a.source_version).cmp(&(
            &b.source_kind,
            b.source_id,
            &b.source_version,
        ))
    });
    out.dedup_by(|a, b| {
        a.source_kind == b.source_kind
            && a.source_id == b.source_id
            && a.source_version == b.source_version
    });
    out
}
pub async fn register(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    owner: Uuid,
    run: Uuid,
    refs: &[Citation],
    require_seen: bool,
) -> Result<()> {
    if refs.len() > 60 {
        return Err(Error::bad("citation_budget_exceeded"));
    }
    if refs.is_empty() {
        return Ok(());
    }
    let input = json!(refs);
    let rows:Vec<(String,Option<Value>,bool)>=sqlx::query_as("SELECT r.source_version,s.body,EXISTS(SELECT 1 FROM chat_source_refs seen WHERE seen.owner_id=$1 AND seen.run_id=$2 AND seen.source_kind=r.source_kind AND seen.source_id=r.source_id AND seen.source_version=r.source_version) FROM jsonb_to_recordset($3) AS r(source_kind text,source_id uuid,source_version text) LEFT JOIN (SELECT owner_id,kind,id,body FROM knowledge_sources UNION ALL SELECT owner_id,'tool_result',id,body FROM chat_tool_evidence WHERE run_id=$2) s ON s.owner_id=$1 AND s.kind=r.source_kind AND s.id=r.source_id").bind(owner).bind(run).bind(&input).fetch_all(&mut **tx).await?;
    if rows.len() != refs.len() {
        return Err(Error::bad("invalid_citation_identity"));
    }
    for (version, body, seen) in rows {
        let body = body.ok_or_else(|| Error::conflict("citation_source_removed"))?;
        if digest(&body) != version {
            return Err(Error::conflict("citation_source_changed"));
        }
        if require_seen && !seen {
            return Err(Error::bad("citation_not_observed_by_tool"));
        }
    }
    if !require_seen {
        sqlx::query("INSERT INTO chat_source_refs SELECT $1,$2,r.source_kind,r.source_id,r.source_version FROM jsonb_to_recordset($3) r(source_kind text,source_id uuid,source_version text) ON CONFLICT DO NOTHING").bind(owner).bind(run).bind(input).execute(&mut **tx).await?;
    }
    Ok(())
}
