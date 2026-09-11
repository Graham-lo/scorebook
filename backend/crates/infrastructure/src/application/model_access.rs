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
            super::knowledge_index::search(
                s,
                owner,
                serde_json::from_value(input.arguments)
                    .map_err(|_| Error::bad("invalid_tool_arguments"))?,
            )
            .await?
        }
        "read_source" => {
            super::knowledge_index::source(
                s,
                owner,
                serde_json::from_value(input.arguments)
                    .map_err(|_| Error::bad("invalid_tool_arguments"))?,
            )
            .await?
        }
        "read_source_slice" => {
            super::knowledge_index::source_slice(
                s,
                owner,
                serde_json::from_value(input.arguments)
                    .map_err(|_| Error::bad("invalid_tool_arguments"))?,
            )
            .await?
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
            let events:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(e)-'owner_id' FROM playbook_events e WHERE owner_id=$1 AND playbook_id=$2 ORDER BY created_at,id LIMIT 100").bind(owner).bind(id).fetch_all(&s.db.pool).await?;
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
            json!({"access":"read_only","scope":"authenticated_user","trades":"available","image_search":"available","model_provider":"not_configured"})
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
