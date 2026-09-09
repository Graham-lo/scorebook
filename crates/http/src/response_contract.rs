//! Response shapes are maintained separately from routing and use-case implementation.
use serde_json::{Value, json};
fn object(properties: Value, required: &[&str]) -> Value {
    json!({"type":"object","properties":properties,"required":required,"additionalProperties":true})
}
fn uuid() -> Value {
    json!({"type":"string","format":"uuid"})
}
fn text() -> Value {
    json!({"type":"string"})
}
fn any_object() -> Value {
    json!({"type":"object","additionalProperties":true})
}
fn page(item: Value) -> Value {
    object(
        json!({"items":{"type":"array","items":item},"next_cursor":{"type":["string","integer","null"]}}),
        &["items"],
    )
}
fn job(id: &str) -> Value {
    let mut fields = json!({"job_id":uuid(),"status":text(),"revision":{"type":"integer"},"generation":{"type":"integer"}});
    fields[id] = uuid();
    object(fields, &[id, "status"])
}
fn entity() -> Value {
    object(
        json!({"id":uuid(),"status":text(),"body":any_object(),"result":{"type":["object","null"]},"error_code":{"type":["string","null"]},"revision":{"type":"integer"},"generation":{"type":"integer"},"created_at":{"type":"string","format":"date-time"}}),
        &["id"],
    )
}
pub fn data(path: &str, method: &str) -> Value {
    let source = || {
        object(
            json!({"source_kind":text(),"source_id":uuid(),"source_version":text(),"source_uri":text(),"occurred_at":{"type":"string","format":"date-time"},"body":any_object()}),
            &["source_kind", "source_id", "source_version", "source_uri"],
        )
    };
    let schema = match (path, method) {
        ("/v1/chart-analyses", _) => object(
            json!({"id":uuid(),"attachment_id":uuid(),"geometry":{"$ref":"#/components/schemas/GeometryQuality"},"recognized":any_object(),"ocr":{"type":["object","array"]},"ocr_status":text(),"chart_type":text(),"quality_validated":{"const":false}}),
            &[
                "id",
                "attachment_id",
                "geometry",
                "recognized",
                "quality_validated",
            ],
        ),
        ("/v1/chart-search/runs", "post") => job("search_run_id"),
        ("/v1/chart-search/runs/{id}", "get") => entity(),
        ("/v1/chart-search/runs/{id}/cancel", _) => job("search_run_id"),
        ("/v1/history/plans", "post") => job("plan_id"),
        ("/v1/history/plans/{id}/control", _) => job("plan_id"),
        ("/v1/history/subscriptions", "post") | ("/v1/history/subscriptions/{id}/control", _) => {
            job("subscription_id")
        }
        ("/v1/history/subscriptions/{id}/budget", _) => object(
            json!({"subscription_id":uuid(),"revision":{"type":"integer"},"max_vectors":{"type":"integer","minimum":1},"next_action":{"const":"resume"}}),
            &["subscription_id", "revision", "max_vectors", "next_action"],
        ),
        ("/v1/history/plans/{id}", _) | ("/v1/history/subscriptions/{id}", _) => entity(),
        ("/v1/history/catalog", _) => page(any_object()),
        ("/v1/history/plans/estimate", _) => object(
            json!({"symbols":{"type":"integer"},"items":{"type":"array","items":any_object()},"upper_bound_vectors":{"type":"integer"},"vector_payload_bytes":{"type":"integer"},"estimate_kind":text(),"observed_feature_table_bytes":{"type":"integer"},"approximate_observed_rows":{"type":"integer"},"duration_estimate":{"type":["number","null"]}}),
            &["symbols", "upper_bound_vectors", "estimate_kind"],
        ),
        ("/v1/exchange-connections", "post") => {
            object(json!({"connection_id":uuid()}), &["connection_id"])
        }
        ("/v1/exchange-connections", "get")
        | ("/v1/imports", "get")
        | ("/v1/trades", _)
        | ("/v1/trade-cycles", _)
        | ("/v1/account-ledger", _) => page(any_object()),
        ("/v1/trade-cycles/{id}", _) => object(
            json!({"cycle":any_object(),"items":{"type":"array","items":object(json!({"fill_id":uuid(),"allocation_quantity":text(),"allocation_commission":text(),"portion":text(),"actual_fill":any_object()}),&["fill_id","allocation_quantity","allocation_commission","actual_fill"])},"next_cursor":{"type":["string","null"]},"allocation_scope":text()}),
            &["cycle", "items", "next_cursor"],
        ),
        ("/v1/exchange-exports", "post") => job("export_run_id"),
        ("/v1/exchange-exports/{id}", _) => entity(),
        ("/v1/exchange-syncs", "post") => job("sync_run_id"),
        ("/v1/exchange-syncs/{id}", _) => entity(),
        ("/v1/statistics/runs", "post") => job("statistics_run_id"),
        ("/v1/statistics/runs/{id}", _) | ("/v1/baseline-runs/{id}", _) => entity(),
        ("/v1/statistics/runs/{id}/members", _)
        | ("/v1/statistics/runs/{id}/groups", _)
        | ("/v1/baseline-runs/{id}/samples", _)
        | ("/v1/verdict-requests", _) => page(any_object()),
        ("/v1/baseline-runs", "post") => job("baseline_run_id"),
        ("/v1/knowledge/source", _) => source(),
        ("/v1/knowledge/source/slice", _) => {
            let mut v = source();
            v["properties"]["text"] = text();
            v["properties"]["offset_byte"] = json!({"type":"integer","minimum":0});
            v["properties"]["next_offset_byte"] = json!({"type":["integer","null"]});
            v["properties"]["total_bytes"] = json!({"type":"integer"});
            v
        }
        ("/v1/knowledge/search", _) => object(
            json!({"items":{"type":"array","items":source()},"protocol":text(),"model_id":text(),"coverage":any_object(),"score_interpretation":text()}),
            &["items", "protocol", "model_id", "coverage"],
        ),
        ("/v1/knowledge/index", "get") => object(
            json!({"pending_sources":{"type":"integer"},"oldest_pending_at":{"type":["string","null"],"format":"date-time"},"indexed_sources":{"type":"integer"},"watermark":{"type":["object","null"]}}),
            &["pending_sources", "indexed_sources", "watermark"],
        ),
        ("/v1/chat/runs", "post") => job("chat_run_id"),
        ("/v1/chat/runs/{id}", "get") => object(
            json!({"chat_run_id":uuid(),"status":text(),"turn_no":{"type":"integer"},"model_id":text(),"answer":{"type":["array","null"],"items":{"$ref":"#/components/schemas/AnswerBlock"}},"error_code":{"type":["string","null"]},"generation":{"type":"integer"},"job_status":text()}),
            &[
                "chat_run_id",
                "status",
                "turn_no",
                "model_id",
                "answer",
                "generation",
                "job_status",
            ],
        ),
        ("/v1/chat/runs/{id}/cancel", _) => job("chat_run_id"),
        ("/v1/chat/runs/{id}/events/page", _) => object(
            json!({"items":{"type":"array","items":object(json!({"sequence":{"type":"integer"},"type":text(),"data":any_object()}),&["sequence","type","data"])},"state":any_object()}),
            &["items", "state"],
        ),
        ("/v1/capabilities", _) => object(
            json!({"backend_version":text(),"raw_market_storage":{"const":"none"},"chat_generation":any_object(),"knowledge_index":any_object(),"encrypted_backup":any_object(),"configuration_status_is_not_live_acceptance":{"const":true}}),
            &[
                "backend_version",
                "raw_market_storage",
                "chat_generation",
                "knowledge_index",
                "encrypted_backup",
            ],
        ),
        _ => {
            json!({"type":["object","array"],"description":"Resource-specific evidence fields are extensible JSON. Business numbers are decimal strings; UTC timestamps use RFC3339."})
        }
    };
    // A retained idempotency receipt can become a tombstone after explicit deletion/expiry.
    json!({"anyOf":[schema,{"type":"object","required":["deleted"],"properties":{"deleted":{"const":true}}},{"type":"object","required":["expired"],"properties":{"expired":{"const":true}}}]})
}
