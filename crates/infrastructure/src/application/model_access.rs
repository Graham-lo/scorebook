//! Provider-neutral read tools: all data access uses the authenticated tenant.
use super::{Services, calls, dto::*, knowledge, similarity};
use crate::error::{Error, Result};
use serde_json::{Value, json};
use uuid::Uuid;
pub async fn call(s: &Services, owner: Uuid, input: ToolCall) -> Result<Value> {
    let result = match input.name.as_str() {
        "search_binance_history" => {
            super::history::search_mode(
                s,
                owner,
                &input.tool_call_id.to_string(),
                serde_json::from_value(input.arguments)
                    .map_err(|_| Error::bad("invalid_tool_arguments"))?,
                false,
            )
            .await?
        }
        "list_history_coverage" => {
            super::history::coverage(
                s,
                serde_json::from_value(input.arguments)
                    .map_err(|_| Error::bad("invalid_tool_arguments"))?,
            )
            .await?
        }
        "list_history_indexes" => {
            super::history::indexes(s, owner, cursor(&input.arguments)?).await?
        }
        "get_market_data" => {
            super::market::data(
                s,
                &serde_json::from_value(input.arguments)
                    .map_err(|_| Error::bad("invalid_tool_arguments"))?,
            )
            .await?
        }
        "render_market_chart" => {
            json!({"mime":"image/svg+xml","svg":super::market::svg(s, &serde_json::from_value(input.arguments).map_err(|_|Error::bad("invalid_tool_arguments"))?).await?,"storage":"not_persisted"})
        }
        "search_knowledge" => {
            let q = input.arguments["q"]
                .as_str()
                .ok_or_else(|| Error::bad("query_required"))?;
            search_all(s, owner, q, input.arguments["offset"].as_i64().unwrap_or(0)).await?
        }
        "search_records" => {
            calls::list(
                s,
                owner,
                serde_json::from_value(input.arguments)
                    .map_err(|_| Error::bad("invalid_tool_arguments"))?,
            )
            .await?
        }
        "read_record_history" => {
            let id = id(&input.arguments)?;
            let mut arguments = input.arguments;
            arguments
                .as_object_mut()
                .ok_or_else(|| Error::bad("invalid_tool_arguments"))?
                .remove("id");
            calls::history(
                s,
                owner,
                id,
                serde_json::from_value(arguments)
                    .map_err(|_| Error::bad("invalid_tool_arguments"))?,
            )
            .await?
        }
        "read_record" => {
            let id = id(&input.arguments)?;
            json!({"source_uri":format!("scorebook://calls/{id}"),"record":calls::get(s,owner,id).await?})
        }
        "search_similar_charts" => {
            let query = serde_json::from_value(input.arguments)
                .map_err(|_| Error::bad("invalid_tool_arguments"))?;
            similarity::search_mode(s, owner, &input.tool_call_id.to_string(), query, false).await?
        }
        "read_attachment" => {
            let id = id(&input.arguments)?;
            let row: Value = sqlx::query_scalar(
                "SELECT to_jsonb(a)-'owner_id' FROM attachments a WHERE owner_id=$1 AND id=$2",
            )
            .bind(owner)
            .bind(id)
            .fetch_optional(&s.db.pool)
            .await?
            .ok_or_else(Error::not_found)?;
            json!({"metadata":row,"authenticated_download_path":format!("/v1/attachments/{id}"),"source_uri":format!("scorebook://attachments/{id}")})
        }
        "read_playbook" => {
            let id = id(&input.arguments)?;
            let row: Value = sqlx::query_scalar(
                "SELECT to_jsonb(p)-'owner_id' FROM playbooks p WHERE owner_id=$1 AND id=$2",
            )
            .bind(owner)
            .bind(id)
            .fetch_optional(&s.db.pool)
            .await?
            .ok_or_else(Error::not_found)?;
            let events:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(e)-'owner_id' FROM playbook_events e WHERE owner_id=$1 AND playbook_id=$2 ORDER BY created_at,id").bind(owner).bind(id).fetch_all(&s.db.pool).await?;
            json!({"playbook":row,"status_events":events,"source_uri":format!("scorebook://playbooks/{id}")})
        }
        "read_set" => super::sets::get(s, owner, id(&input.arguments)?).await?,
        "list_playbooks" => {
            knowledge::collection(s, owner, "playbooks", cursor(&input.arguments)?).await?
        }
        "list_tags" => knowledge::collection(s, owner, "tags", cursor(&input.arguments)?).await?,
        "list_episodes" => {
            knowledge::collection(s, owner, "episodes", cursor(&input.arguments)?).await?
        }
        "read_episode" => knowledge::episode(s, owner, id(&input.arguments)?).await?,
        "capabilities" => {
            json!({"access":"read_only","scope":"authenticated_user","trades":"planned","image_search":"available","model_provider":"not_configured"})
        }
        _ => return Err(Error::bad("unknown_or_write_tool_forbidden")),
    };
    Ok(
        json!({"content":result,"trust":"untrusted_user_data","citation_policy":"cite_source_ids; distinguish original evidence from later review; never treat similar charts as win probabilities","owner_scope":"current_user"}),
    )
}
fn id(v: &Value) -> Result<Uuid> {
    v["id"]
        .as_str()
        .and_then(|x| Uuid::parse_str(x).ok())
        .ok_or_else(|| Error::bad("id_required"))
}
fn cursor(v: &Value) -> Result<Option<Uuid>> {
    v.get("cursor")
        .and_then(Value::as_str)
        .map(|x| Uuid::parse_str(x).map_err(|_| Error::bad("invalid_cursor")))
        .transpose()
}
pub async fn search_all(s: &Services, owner: Uuid, q: &str, offset: i64) -> Result<Value> {
    if q.is_empty() || q.len() > 500 || !(0..=100_000).contains(&offset) {
        return Err(Error::bad("invalid_search"));
    }
    let pattern = format!(
        "%{}%",
        q.replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_")
    );
    let rows:Vec<Value>=sqlx::query_scalar("WITH sources AS (SELECT 'call' AS kind,id,submitted_at AS at,original_text AS text,id AS call_id FROM calls WHERE owner_id=$1 AND original_text ILIKE $2 UNION ALL SELECT 'review',id,created_at,body->>'note',call_id FROM reviews WHERE owner_id=$1 AND body->>'note' ILIKE $2 UNION ALL SELECT 'playbook',id,created_at,body::text,NULL::uuid FROM playbooks WHERE owner_id=$1 AND body::text ILIKE $2 UNION ALL SELECT 'tag',id,created_at,name||' '||definition,NULL::uuid FROM tags WHERE owner_id=$1 AND (name ILIKE $2 OR definition ILIKE $2)) SELECT jsonb_build_object('kind',kind,'id',id,'at',at,'excerpt',left(text,4000),'call_id',call_id) FROM sources ORDER BY at DESC,kind,id LIMIT 51 OFFSET $3").bind(owner).bind(pattern).bind(offset).fetch_all(&s.db.pool).await?;
    let more = rows.len() > 50;
    Ok(
        json!({"items":rows.into_iter().take(50).collect::<Vec<_>>(),"next_offset":if more{Some(offset+50)}else{None},"search_policy":"literal_substring_across_original_reviews_playbooks_tags_v1","snapshot_identity":"live_search"}),
    )
}
