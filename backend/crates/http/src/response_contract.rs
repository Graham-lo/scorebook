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
        ("/v1/market/bounds", "get") => {
            let nullable_time = json!({"type":["string","null"],"format":"date-time"});
            let time = json!({"type":"string","format":"date-time"});
            return object(
                json!({
                    "market":{"type":"string","enum":["usd_m","coin_m"]},"symbol":text(),"interval":text(),"status":text(),
                    "onboard_at":nullable_time,"delivery_at":nullable_time,"first_bar_at":nullable_time,
                    "last_bar_at":nullable_time,"verified_at":nullable_time,"server_now":time,
                    "gaps":{"type":"array","items":object(json!({"start":time,"end":time,"seen_at":time}), &["start","end","seen_at"])}
                }),
                &[
                    "market",
                    "symbol",
                    "interval",
                    "status",
                    "onboard_at",
                    "delivery_at",
                    "first_bar_at",
                    "last_bar_at",
                    "gaps",
                    "verified_at",
                    "server_now",
                ],
            );
        }
        ("/v1/chart-analyses/outline", "post") => object(
            json!({"attachment_id":uuid(),"source":{"const":"screenshot_contour"},"symbol":{"type":["string","null"]},"interval":{"type":["string","null"]},"values":{"type":"array","minItems":16,"maxItems":2000,"items":{"type":"number","minimum":0,"maximum":1}},"storage_policy":{"const":"ephemeral"}}),
            &[
                "attachment_id",
                "source",
                "symbol",
                "interval",
                "values",
                "storage_policy",
            ],
        ),
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
        ("/v1/chart-search/runs/{id}", "get") => {
            // §5.5-3/4：结果里每条都带 `match.level` 和 `match.rarity`（这一档校准样本
            // 里低于此分的比例，没校准过就是 null），整轮的结论是 `verdict`。词在前端，
            // 这里只给枚举值。
            let mut shape = entity();
            shape["properties"]["result"] = json!({"type":["object","null"],"additionalProperties":true,"properties":{
                "verdict":{"type":"string","enum":["found","weak","none"]},
                "status":text(),
                "items":{"type":"array","items":object(json!({"symbol":text(),"market":text(),"interval":text(),"start_at":{"type":"string","format":"date-time"},"end_at":{"type":"string","format":"date-time"},"bars_count":{"type":"integer"},
                    "match":{"type":"object","properties":{"score":{"type":"number"},"rarity":{"type":["number","null"]},"level":{"type":["string","null"],"enum":["sure","likely","weak",null]},"reverse":{"type":"boolean"},"direction_consistent":{"type":"boolean"}}}}),&["match"])}}});
            shape
        }
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
        ("/v1/attachments/{id}/location" | "/v1/attachments/{id}/location-preview", _) => object(
            // 手填只给 `{symbol, market, interval, end_at, bars_count?}` 就够：起点按
            // 周期倒推，回的 `preview` 是那一段真实行情加一句「像不像」，前端拿它直接
            // 画对照图，不必再往 /v1/market/data 跑一趟（§5.2 第 6 步）。
            json!({"attachment_id":uuid(),"symbol":text(),"market":text(),"interval":text(),"start_at":{"type":"string","format":"date-time"},"end_at":{"type":"string","format":"date-time"},"bars_count":{"type":["integer","null"]},"source":text(),"score":{"type":["string","null"]},"search_run_id":{"type":["string","null"],"format":"uuid"},"matched_by":{"type":["string","null"],"description":"auto | user"},"anchor":{"type":["object","null"],"additionalProperties":true},"confirmed_at":{"type":"string","format":"date-time"},
                "preview":object(json!({"bars":{"type":"array","items":any_object()},"bars_count":{"type":"integer"},"start_at":{"type":["string","null"],"format":"date-time"},"end_at":{"type":["string","null"],"format":"date-time"},"match":{"type":["object","null"],"properties":{"score":{"type":"number"},"level":{"type":"string","enum":["sure","likely","weak"]},"reverse":{"type":"boolean"}}}}),&["bars","bars_count"])}),
            &[
                "attachment_id",
                "symbol",
                "market",
                "interval",
                "start_at",
                "end_at",
                "source",
            ],
        ),
        ("/v1/attachments/{id}/locate", method) => {
            let location = json!({"type":["object","null"],"additionalProperties":true});
            // §5.2：定位作业的结果结构。`outcome` 是这一轮的结论，`anchors` 是图上读到
            // 的证据（品种、周期、时区、价轴、极值），`method` 是最后靠哪一步对上的，
            // `candidates` 里每条都自带窗口和 `match.level`——前端按这几个字段画，
            // 词自己映。
            let candidate = object(
                json!({"symbol":text(),"market":text(),"interval":text(),"start_at":{"type":"string","format":"date-time"},"end_at":{"type":"string","format":"date-time"},"bars_count":{"type":"integer"},"match":{"type":"object","properties":{"score":{"type":"number"},"level":{"type":"string","enum":["sure","likely","weak"]},"reverse":{"type":"boolean"},"z":{"type":["number","null"]}}}}),
                &[
                    "symbol", "market", "interval", "start_at", "end_at", "match",
                ],
            );
            let outcome = object(
                json!({"outcome":{"type":"string","enum":["located","candidates","needs_manual","already_located","unreadable"]},"attachment_id":uuid(),"search_run_id":{"type":["string","null"],"format":"uuid"},"method":{"type":["string","null"],"enum":["extremes","time_axis","shape_sweep",null]},"anchors":{"type":["object","null"],"additionalProperties":true},"candidates":{"type":"array","items":candidate},"reason":{"type":["string","null"]},"min_score":{"type":["number","null"]},"min_margin":{"type":["number","null"]}}),
                &["outcome", "attachment_id", "candidates"],
            );
            let job = json!({"type":["object","null"],"properties":{"id":uuid(),"status":text(),"result":{"oneOf":[{"type":"null"},outcome]},"created_at":{"type":"string","format":"date-time"}}});
            // symbol/market/interval 是这张图实际按哪个品种去找的回显。
            let used = json!({"type":["string","null"]});
            if method == "post" {
                object(
                    json!({"location":location,"job":job,"deduplicated":{"type":"boolean"},"symbol":used,"market":used,"interval":used}),
                    &["location", "job", "deduplicated"],
                )
            } else {
                object(
                    json!({"location":location,"job":job,"symbol":used,"market":used,"interval":used}),
                    &["location", "job"],
                )
            }
        }
        ("/v1/attachments/{id}", "patch") => object(
            json!({"id":uuid(),"kind":text(),"digest":text(),"uploaded_at":{"type":"string","format":"date-time"},"location":{"type":["object","null"],"additionalProperties":true}}),
            &["id", "kind"],
        ),
        ("/v1/calls/{id}/scene", _) => object(
            json!({"call_id":uuid(),"attachment_id":uuid(),"revision":{"type":"integer"},"superseded":{"type":"array","items":uuid()},"scene_replaced_after_submission":{"type":"boolean"},"original_evidence_unchanged":{"const":true}}),
            &[
                "call_id",
                "attachment_id",
                "revision",
                "superseded",
                "scene_replaced_after_submission",
                "original_evidence_unchanged",
            ],
        ),
        ("/v1/calls/{id}/chart-setup", _) => object(
            json!({"call_id":uuid(),"body":any_object(),"updated_at":{"type":"string","format":"date-time"}}),
            &["call_id", "body", "updated_at"],
        ),
        ("/v1/calls/{id}/replay", "get") => object(
            json!({"call_id":uuid(),"symbol":text(),"market":text(),"interval":text(),"source":text(),
                "window":object(json!({"start_at":{"type":"string","format":"date-time"},"end_at":{"type":"string","format":"date-time"},"bars_before":{"type":"integer"},"truncated":{"type":"boolean"},"coverage_complete":{"type":"boolean"}}),&["start_at","end_at","truncated"]),
                "judgment":object(json!({"at":{"type":"string","format":"date-time"},"base_price":{"type":["string","null"]},"atr0":{"type":["string","null"]}}),&["at"]),
                "levels":{"$ref":"#/components/schemas/Levels"},
                "marks":{"type":["object","null"],"additionalProperties":true},
                "scene":{"type":["object","null"],"properties":{"attachment_id":uuid(),"replaced_after_submission":{"type":"boolean"}}},
                "scene_replaced_after_submission":{"type":"boolean","description":"true when the scene in effect was uploaded after the record was submitted; the superseded originals stay retrievable from GET /v1/calls/{id}"},
                "locating":{"type":["object","null"],"properties":{"job_id":uuid(),"status":text()}},
                // §5.3：舞台上的每一条轨。第一条（`primary`）是记录自己的品种，其余是
                // 这条记录里每一张已经对上行情的附件，品种可以不同；所有轨都开到主轨
                // 的同一个终点，进度按时间戳对齐。顶层 `symbol`/`window`/`bars` 仍旧是
                // 主轨的那一份，没有变。
                "tracks":{"type":"array","items":object(json!({"attachment_id":{"type":["string","null"],"format":"uuid"},"kind":{"type":["string","null"]},"matched_by":{"type":["string","null"],"description":"auto | user"},"primary":{"type":"boolean"},"symbol":text(),"market":text(),"interval":text(),"source":text(),
                    "window":object(json!({"start_at":{"type":"string","format":"date-time"},"end_at":{"type":"string","format":"date-time"},"bars_before":{"type":"integer"},"truncated":{"type":"boolean"},"coverage_complete":{"type":"boolean"}}),&["start_at","end_at"]),
                    "bars":{"type":"array","items":any_object()},"bars_included":{"type":"boolean"}}),&["primary","symbol","market","interval","window","bars_included"])},
                "bars":{"type":"array","items":object(json!({"start":{"type":"string","format":"date-time"},"end":{"type":"string","format":"date-time"},"open":text(),"high":text(),"low":text(),"close":text(),"volume":{"type":["string","null"]}}),&["start","end","open","high","low","close"])},
                "bars_included":{"type":"boolean","description":"false when bars=none: metadata only, the caller fetches the klines itself"},
                "storage_policy":text()}),
            &[
                "call_id",
                "symbol",
                "market",
                "interval",
                "window",
                "judgment",
                "levels",
                "tracks",
                "bars",
                "bars_included",
                "storage_policy",
            ],
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
