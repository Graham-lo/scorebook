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
    for r in refs {
        let body: Option<Value> = sqlx::query_scalar(
            "SELECT body FROM knowledge_sources WHERE owner_id=$1 AND kind=$2 AND id=$3",
        )
        .bind(owner)
        .bind(&r.source_kind)
        .bind(r.source_id)
        .fetch_optional(&mut **tx)
        .await?;
        let Some(body) = body else {
            return Err(Error::conflict("citation_source_removed"));
        };
        if digest(&body) != r.source_version {
            return Err(Error::conflict("citation_source_changed"));
        }
        if require_seen {
            let seen:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM chat_source_refs WHERE owner_id=$1 AND run_id=$2 AND source_kind=$3 AND source_id=$4 AND source_version=$5)").bind(owner).bind(run).bind(&r.source_kind).bind(r.source_id).bind(&r.source_version).fetch_one(&mut **tx).await?;
            if !seen {
                return Err(Error::bad("citation_not_observed_by_tool"));
            }
        } else {
            sqlx::query(
                "INSERT INTO chat_source_refs VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
            )
            .bind(owner)
            .bind(run)
            .bind(&r.source_kind)
            .bind(r.source_id)
            .bind(&r.source_version)
            .execute(&mut **tx)
            .await?;
        }
    }
    Ok(())
}
