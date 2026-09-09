use scorebook::{
    adapters::{db::Database, storage::Storage, vision::Vision},
    application::{Services, chart_search, history_catalog, jobs},
};
use serde_json::{Value, json};
use uuid::Uuid;
async fn setup() -> (Services, Uuid, tempfile::TempDir) {
    let db = Database::connect(&std::env::var("DATABASE_URL").expect("isolated test DB"))
        .await
        .unwrap();
    db.migrate().await.unwrap();
    let (owner, _) = db.create_user("v4-test").await.unwrap();
    let tmp = tempfile::tempdir().unwrap();
    (
        Services::new(db, Storage::new(tmp.path()), Vision::new(None)).unwrap(),
        owner,
        tmp,
    )
}
#[tokio::test]
async fn chart_search_cancel_is_idempotent_and_fences_old_worker() {
    let (s, owner, _tmp) = setup().await;
    let attachment = Uuid::new_v4();
    sqlx::query("INSERT INTO attachments(id,owner_id,sha256,mime,size,width,height,kind) VALUES($1,$2,'test','image/png',1,640,320,'query')").bind(attachment).bind(owner).execute(&s.db.pool).await.unwrap();
    let input = json!({"attachment_id":attachment,"scope":"binance_history"});
    let a = chart_search::create(
        &s,
        owner,
        "search",
        serde_json::from_value(input.clone()).unwrap(),
    )
    .await
    .unwrap();
    let b = chart_search::create(&s, owner, "search", serde_json::from_value(input).unwrap())
        .await
        .unwrap();
    assert_eq!(a, b);
    let id = serde_json::from_value(a["search_run_id"].clone()).unwrap();
    let j = jobs::claim_for(&s, Some(owner)).await.unwrap().unwrap();
    let control = json!({"expected_generation":j.generation});
    let cancelled = chart_search::cancel(
        &s,
        owner,
        id,
        "cancel",
        serde_json::from_value(control.clone()).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(
        cancelled,
        chart_search::cancel(
            &s,
            owner,
            id,
            "cancel",
            serde_json::from_value(control).unwrap()
        )
        .await
        .unwrap()
    );
    assert!(jobs::fence(&s, &j).await.is_err());
    let (other, _) = s.db.create_user("other-v4").await.unwrap();
    assert!(chart_search::get(&s, other, id).await.is_err());
    assert_eq!(
        chart_search::get(&s, owner, id).await.unwrap()["status"],
        "cancelled"
    );
}
async fn catalog_fixture(s: &Services) -> String {
    let symbol = format!("TEST{}", Uuid::new_v4().simple()).to_uppercase();
    let version = Uuid::new_v4();
    sqlx::query("INSERT INTO public_market.catalog_versions(id,source,source_hash) VALUES($1,'test','test')").bind(version).execute(&s.db.pool).await.unwrap();
    sqlx::query("INSERT INTO public_market.instrument_lifecycles(market,symbol,status,catalog_version) VALUES('usd_m',$1,'TRADING',$2)").bind(&symbol).bind(version).execute(&s.db.pool).await.unwrap();
    symbol
}
#[tokio::test]
async fn subscription_budget_cancellation_and_batch_children() {
    let (s, owner, _tmp) = setup().await;
    let symbol = catalog_fixture(&s).await;
    let end = chrono::Utc::now();
    let start = end - chrono::Duration::days(90);
    let input = json!({"market":"usd_m","symbols":[symbol],"intervals":["1h"],"start_at":start,"source":"rest","max_vectors":1});
    assert!(
        history_catalog::subscriptions::create(
            &s,
            owner,
            "budget",
            serde_json::from_value(input.clone()).unwrap()
        )
        .await
        .is_err()
    );
    let mut input = input;
    input["max_vectors"] = json!(100000);
    let a = history_catalog::subscriptions::create(
        &s,
        owner,
        "subscribe",
        serde_json::from_value(input).unwrap(),
    )
    .await
    .unwrap();
    let id: Uuid = serde_json::from_value(a["subscription_id"].clone()).unwrap();
    let j = jobs::claim_for(&s, Some(owner)).await.unwrap().unwrap();
    let error = history_catalog::subscriptions::step(&s, &j)
        .await
        .unwrap_err();
    assert_eq!(error.code, "subscription_plan_scheduled");
    let state = history_catalog::subscriptions::get(&s, owner, id)
        .await
        .unwrap();
    let child: Uuid = serde_json::from_value(state["child_plan"].clone()).unwrap();
    let plan: Value = sqlx::query_scalar("SELECT body FROM history_plans WHERE id=$1")
        .bind(child)
        .fetch_one(&s.db.pool)
        .await
        .unwrap();
    assert_eq!(plan["models"], json!(["candle-geometry-v2"]));
    assert_eq!(plan["window_bars"], 64);
    history_catalog::subscriptions::control(
        &s,
        owner,
        id,
        "cancel",
        serde_json::from_value(json!({"expected_revision":0,"action":"cancel"})).unwrap(),
    )
    .await
    .unwrap();
    assert!(jobs::fence(&s, &j).await.is_err());
    assert_eq!(
        jobs::get(&s, owner, child).await.unwrap()["status"],
        "cancelled"
    );
}
#[tokio::test]
async fn oversized_provider_cost_is_configuration_state_not_infinite_retry() {
    let (s, _, _tmp) = setup().await;
    let budget =
        scorebook::adapters::provider_budget::ProviderBudget::new(s.db.pool.clone()).unwrap();
    let error = budget.reserve("usd_m", 10000).await.unwrap_err();
    assert_eq!(error.code, "capability_configuration_required");
    assert_eq!(
        error.retry,
        scorebook::error::RetryDirective::AwaitCapability
    );
}

#[tokio::test]
#[ignore = "explicit live Binance archive verification; no raw market persistence"]
async fn live_archive_checksum_and_ram_only_decode() {
    let archive = scorebook::adapters::binance_archive::BinanceArchive::new().unwrap();
    let start = "2024-01-01T00:00:00Z".parse().unwrap();
    let end = "2024-02-01T00:00:00Z".parse().unwrap();
    let result = archive
        .klines(
            "data/futures/um/monthly/klines/BTCUSDT/1h/BTCUSDT-1h-2024-01.zip",
            start,
            end,
        )
        .await
        .unwrap();
    assert_eq!(result.bars.len(), 744);
    assert_eq!(result.bars[0].start, start);
    assert_eq!(result.bars.last().unwrap().end, end);
    assert_eq!(result.sha256.len(), 64);
    assert!(result.bars.windows(2).all(|b| b[0].end == b[1].start));
}

#[tokio::test]
async fn trade_import_repeats_reversal_projection_and_currency_reconciliation() {
    use scorebook::application::trades;
    let (s, owner, _tmp) = setup().await;
    let connection = trades::connection(
        &s,
        owner,
        "connect",
        serde_json::from_value(json!({"name":"test","account_label":"test","market":"usd_m"}))
            .unwrap(),
    )
    .await
    .unwrap();
    let connection_id: Uuid = serde_json::from_value(connection["connection_id"].clone()).unwrap();
    trades::seed(&s,owner,"seed",serde_json::from_value(json!({"connection_id":connection_id,"symbol":"BTCUSDT","position_side":"BOTH","effective_at":"2024-01-01T00:00:00Z","quantity":"0","contract_multiplier":"1","settlement_asset":"USDT","evidence":"verified zero-position statement"})).unwrap()).await.unwrap();
    let make = |id, side, q, p, pnl, fee| json!({"trade_id":format!("{id}"),"symbol":"BTCUSDT","side":side,"position_side":"BOTH","price":p,"quantity":q,"realized_pnl":pnl,"settlement_asset":"USDT","commission":fee,"commission_asset":"USDT","traded_at":format!("2024-01-01T00:00:0{id}Z")});
    let input = json!({"connection_id":connection_id,"source":"csv","dataset":"both","start_at":"2024-01-01T00:00:00Z","end_at":"2024-01-02T00:00:00Z","symbols":["BTCUSDT"],"declared_complete":true,"fills":[make(3,"BUY","1","105","5","0.1"),make(1,"BUY","2","100","0","0.2"),make(2,"SELL","3","110","20","0.3")],"ledger_entries":[{"transaction_id":"funding1","kind":"FUNDING_FEE","symbol":"BTCUSDT","asset":"USDT","amount":"-1","occurred_at":"2024-01-01T00:00:05Z"},{"transaction_id":"pnl1","kind":"REALIZED_PNL","asset":"USDT","amount":"25","occurred_at":"2024-01-01T00:00:05Z"}]});
    for n in 0..3 {
        let result = trades::import::import(
            &s,
            owner,
            &format!("import{n}"),
            serde_json::from_value(input.clone()).unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(result["inserted_fills"], if n == 0 { 3 } else { 0 });
    }
    let mut conflicting = input.clone();
    conflicting["fills"][0]["price"] = json!("106");
    assert_eq!(
        trades::import::import(
            &s,
            owner,
            "conflict",
            serde_json::from_value(conflicting).unwrap()
        )
        .await
        .unwrap_err()
        .code,
        "trade_source_conflict"
    );
    for _ in 0..4 {
        if !jobs::run_filtered(&s, Some(owner), None).await.unwrap() {
            break;
        }
    }
    let cycles = trades::projection::list(
        &s,
        owner,
        serde_json::from_value(json!({"connection_id":connection_id})).unwrap(),
    )
    .await
    .unwrap();
    let items = cycles["items"].as_array().unwrap();
    assert_eq!(items.len(), 2);
    assert!(items.iter().all(|v| v["cycle"]["status"] == "closed"));
    let result=trades::reconciliation::reconcile(&s,owner,"reconcile",serde_json::from_value(json!({"connection_id":connection_id,"start_at":"2024-01-01T00:00:00Z","end_at":"2024-01-02T00:00:00Z","statement":[{"asset":"USDT","realized_pnl":"25","commission":"0.6","funding":"-1","tolerance":"0"}],"evidence":"exact test statement"})).unwrap()).await.unwrap();
    assert_eq!(result["status"], "matched_declared_range");
}

#[tokio::test]
async fn exchange_sync_pages_1000_same_millisecond_fills_with_atomic_cursor() {
    use scorebook::application::trades;
    use scorebook_core::exchange::{AccountHistoryProvider, AccountRead};
    struct AccountMock {
        at: chrono::DateTime<chrono::Utc>,
        requests: std::sync::Mutex<Vec<String>>,
    }
    impl AccountHistoryProvider for AccountMock {
        fn read<'a>(
            &'a self,
            _service: &'a str,
            _market: &'a str,
            request: AccountRead,
        ) -> scorebook_core::ports::AppFuture<'a, Value> {
            Box::pin(async move {
                match request {
                    AccountRead::Trades {
                        symbol, from_id, ..
                    } => {
                        self.requests
                            .lock()
                            .unwrap()
                            .push(format!("trades:{}", from_id.as_deref().unwrap_or("time")));
                        let (first, last) = if from_id.is_none() {
                            (1, 1000)
                        } else {
                            assert_eq!(from_id.as_deref(), Some("1001"));
                            (1001, 1001)
                        };
                        Ok(json!((first..=last).map(|id|json!({"id":id,"orderId":id,"symbol":symbol,"side":"BUY","positionSide":"BOTH","price":"100","qty":"1","realizedPnl":"0","marginAsset":"USDT","commission":"0.01","commissionAsset":"USDT","time":self.at.timestamp_millis()})).collect::<Vec<_>>()))
                    }
                    AccountRead::Income { .. } => {
                        self.requests.lock().unwrap().push("income".into());
                        Ok(json!([]))
                    }
                    _ => panic!("unexpected endpoint"),
                }
            })
        }
    }
    let (mut s, owner, _tmp) = setup().await;
    let start = chrono::Utc::now() - chrono::Duration::days(2);
    let end = start + chrono::Duration::days(1);
    let provider = std::sync::Arc::new(AccountMock {
        at: start + chrono::Duration::hours(1),
        requests: std::sync::Mutex::new(vec![]),
    });
    s.accounts = provider.clone();
    let connection=trades::connection(&s,owner,"connect",serde_json::from_value(json!({"name":"fake provider","account_label":"fake","market":"usd_m","keychain_service":format!("scorebook.exchange.{owner}.fake")})).unwrap()).await.unwrap();
    let connection_id: Uuid = serde_json::from_value(connection["connection_id"].clone()).unwrap();
    let run=trades::sync::create(&s,owner,"sync",serde_json::from_value(json!({"connection_id":connection_id,"start_at":start,"end_at":end,"symbols":["BTCUSDT"]})).unwrap()).await.unwrap();
    let id: Uuid = serde_json::from_value(run["sync_run_id"].clone()).unwrap();
    for _ in 0..5 {
        sqlx::query("UPDATE jobs SET run_after=now() WHERE owner_id=$1 AND status='retry_wait'")
            .bind(owner)
            .execute(&s.db.pool)
            .await
            .unwrap();
        if !jobs::run_filtered(&s, Some(owner), None).await.unwrap() {
            break;
        }
    }
    assert_eq!(
        trades::sync::get(&s, owner, id).await.unwrap()["status"],
        "complete"
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM trade_fills WHERE owner_id=$1")
        .bind(owner)
        .fetch_one(&s.db.pool)
        .await
        .unwrap();
    assert_eq!(count, 1001);
    assert_eq!(
        *provider.requests.lock().unwrap(),
        vec!["trades:time", "trades:1001", "income"]
    );
    let projections: i64 =
        sqlx::query_scalar("SELECT count(*) FROM jobs WHERE owner_id=$1 AND kind='trade.project'")
            .bind(owner)
            .fetch_one(&s.db.pool)
            .await
            .unwrap();
    assert_eq!(projections, 1);
}

#[tokio::test]
async fn formal_snapshot_freezes_heads_members_and_verdict_thresholds() {
    use scorebook::application::{calls, statistics};
    let (s, o, _tmp) = setup().await;
    let criterion = json!({"template":"T1","selected_by":"explicit","horizon_hours":1,"threshold_ratio":"0.01","direction":"L"});
    for i in 0..21 {
        let v=calls::create(&s,o,&format!("sample-{i}"),serde_json::from_value(json!({"original_text":format!("判断{i}"),"instrument":"BTCUSDT","market":"usd_m","criteria":[criterion]})).unwrap()).await.unwrap();
        let call: Uuid = serde_json::from_value(v["id"].clone()).unwrap();
        let outcome = Uuid::new_v4();
        sqlx::query("INSERT INTO manifests(id,owner_id,call_id,digest,body) VALUES($1,$2,$3,'fixture','{}')").bind(outcome).bind(o).bind(call).execute(&s.db.pool).await.unwrap();
        sqlx::query("INSERT INTO outcomes(id,owner_id,call_id,claim_no,manifest_id,kind,result,digest) VALUES($1,$2,$3,0,$1,'original',$4,'fixture')").bind(outcome).bind(o).bind(call).bind(json!({"state":if i<12{"realized"}else{"unrealized"},"mfe":format!("0.{i:02}"),"mae":"-0.02"})).execute(&s.db.pool).await.unwrap();
        sqlx::query(
            "INSERT INTO outcome_heads(owner_id,call_id,claim_no,outcome_id) VALUES($1,$2,0,$3)",
        )
        .bind(o)
        .bind(call)
        .bind(outcome)
        .execute(&s.db.pool)
        .await
        .unwrap();
    }
    sqlx::query("UPDATE jobs SET status='cancelled' WHERE owner_id=$1")
        .bind(o)
        .execute(&s.db.pool)
        .await
        .unwrap();
    let input = json!({"name":"固定样本","filters":{},"comparison_policy":"exact_frozen_rule","grouping":"call_rule","calendar":"natural_hours","outcome_policy":"current_formal_head"});
    let a = statistics::create(
        &s,
        o,
        "stats",
        serde_json::from_value(input.clone()).unwrap(),
    )
    .await
    .unwrap();
    let id: Uuid = serde_json::from_value(a["statistics_run_id"].clone()).unwrap();
    let job = jobs::claim_for(&s, Some(o)).await.unwrap().unwrap();
    let result = statistics::snapshot::build(&s, &job).await.unwrap();
    jobs::complete(&s, &job, Ok(result)).await.unwrap();
    let fixed = statistics::get(&s, o, id).await.unwrap();
    assert_eq!(fixed["stats"]["counts"]["call_count"], 21);
    assert_eq!(fixed["stats"]["groups"][0]["numerator"], 12);
    assert_eq!(fixed["stats"]["groups"][0]["denominator"], 21);
    assert!(
        fixed["stats"]["groups"][0]["mfe_median"]
            .as_str()
            .unwrap()
            .starts_with("0.10")
    );
    let members = statistics::members(&s, o, id, Default::default())
        .await
        .unwrap();
    assert_eq!(members["items"].as_array().unwrap().len(), 21);
    let requests = statistics::verdicts::list(&s, o, Default::default())
        .await
        .unwrap();
    assert_eq!(requests["items"].as_array().unwrap().len(), 1);
    let second = statistics::create(&s, o, "stats-2", serde_json::from_value(input).unwrap())
        .await
        .unwrap();
    let job = jobs::claim_for(&s, Some(o)).await.unwrap().unwrap();
    assert_eq!(second["statistics_run_id"], json!(job.id));
    let result = statistics::snapshot::build(&s, &job).await.unwrap();
    jobs::complete(&s, &job, Ok(result)).await.unwrap();
    assert_eq!(
        statistics::verdicts::list(&s, o, Default::default())
            .await
            .unwrap()["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let request = &requests["items"][0];
    let verdict = json!({"request_id":request["id"],"expected_revision":0,"decision":"observe","evidence":"继续按同一规则观察"});
    let decided = statistics::verdicts::decide(
        &s,
        o,
        "decision",
        serde_json::from_value(verdict.clone()).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(decided["decision"], "observe");
    assert!(
        statistics::verdicts::decide(&s, o, "stale", serde_json::from_value(verdict).unwrap())
            .await
            .is_err()
    );
    // A data revision changes the head while immutable evidence stays intact.
    let call: Uuid = serde_json::from_value(members["items"][0]["call_id"].clone()).unwrap();
    let old: Uuid =
        serde_json::from_value(members["items"][0]["body"]["outcome_id"].clone()).unwrap();
    let revision = Uuid::new_v4();
    sqlx::query("INSERT INTO manifests(id,owner_id,call_id,digest,body) VALUES($1,$2,$3,'fixture-revision','{}')").bind(revision).bind(o).bind(call).execute(&s.db.pool).await.unwrap();
    sqlx::query("INSERT INTO outcomes(id,owner_id,call_id,claim_no,manifest_id,kind,result,digest,supersedes) VALUES($1,$2,$3,0,$1,'data_revision','{\"state\":\"unrealized\"}','revision',$4)").bind(revision).bind(o).bind(call).bind(old).execute(&s.db.pool).await.unwrap();
    sqlx::query("UPDATE outcome_heads SET outcome_id=$3,revision=revision+1 WHERE owner_id=$1 AND call_id=$2").bind(o).bind(call).bind(revision).execute(&s.db.pool).await.unwrap();
    assert_eq!(
        statistics::get(&s, o, id).await.unwrap()["stats"],
        fixed["stats"]
    );
}

struct FixtureChat {
    source: Uuid,
    calls: std::sync::atomic::AtomicUsize,
}
impl scorebook_core::chat::ChatModelProvider for FixtureChat {
    fn model_id(&self) -> &str {
        "fixture-script-v1"
    }
    fn reply(
        &self,
        input: scorebook_core::chat::ModelRequest,
    ) -> scorebook_core::ports::AppFuture<'_, scorebook_core::chat::ModelReply> {
        self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Box::pin(async move {
            if input.turn == 0 {
                Ok(serde_json::from_value(json!({"tool_calls":[{"id":"source-1","name":"read_source","arguments":{"source_kind":"call","source_id":self.source}}]})).unwrap())
            } else {
                let source = &input
                    .messages
                    .iter()
                    .find(|m| m.role == "tool")
                    .unwrap()
                    .content["result"]["content"];
                Ok(serde_json::from_value(json!({"answer":[{"text":"原始记录建议等待突破后的回踩确认。","inference":false,"citations":[{"source_kind":"call","source_id":self.source,"source_version":source["source_version"]}]}]})).unwrap())
            }
        })
    }
}
#[tokio::test]
async fn chat_resumes_confirmed_tools_and_invalidates_deleted_source() {
    use scorebook::application::{calls, chat};
    let (mut s, o, _tmp) = setup().await;
    let saved = calls::create(
        &s,
        o,
        "source",
        serde_json::from_value(json!({"original_text":"等待突破后的回踩确认"})).unwrap(),
    )
    .await
    .unwrap();
    let source: Uuid = serde_json::from_value(saved["id"].clone()).unwrap();
    sqlx::query("UPDATE jobs SET status='cancelled' WHERE owner_id=$1")
        .bind(o)
        .execute(&s.db.pool)
        .await
        .unwrap();
    let token = s.db.create_key(o, false).await.unwrap();
    let principal = s.db.principal(&token).await.unwrap();
    let model = std::sync::Arc::new(FixtureChat {
        source,
        calls: std::sync::atomic::AtomicUsize::new(0),
    });
    s.chat = model.clone();
    let input = json!({"message":"帮我解释这条原始判断"});
    let created = chat::create(
        &s,
        principal.clone(),
        "chat",
        serde_json::from_value(input.clone()).unwrap(),
    )
    .await
    .unwrap();
    let id: Uuid = serde_json::from_value(created["chat_run_id"].clone()).unwrap();
    assert_eq!(
        created,
        chat::create(
            &s,
            principal,
            "chat",
            serde_json::from_value(input).unwrap()
        )
        .await
        .unwrap()
    );
    let job = jobs::claim_for(&s, Some(o)).await.unwrap().unwrap();
    let result = chat::runtime::run(&s, &job).await;
    assert_eq!(result.as_ref().unwrap_err().code, "chat_next_turn");
    jobs::complete(&s, &job, result).await.unwrap();
    let job = jobs::claim_for(&s, Some(o)).await.unwrap().unwrap();
    let result = chat::runtime::run(&s, &job).await.unwrap();
    jobs::complete(&s, &job, Ok(result)).await.unwrap();
    assert_eq!(model.calls.load(std::sync::atomic::Ordering::SeqCst), 2);
    let done = chat::get(&s, o, id).await.unwrap();
    assert_eq!(done["status"], "completed");
    assert_eq!(
        done["answer"][0]["citations"][0]["source_id"],
        json!(source)
    );
    let first = chat::events(&s, o, id, Default::default()).await.unwrap();
    let after = first["items"].as_array().unwrap().last().unwrap()["sequence"]
        .as_i64()
        .unwrap();
    let next = chat::events(
        &s,
        o,
        id,
        scorebook_core::api::chat::ChatEventFilter { after: Some(after) },
    )
    .await
    .unwrap();
    assert!(next["items"].as_array().unwrap().is_empty());
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM chat_tool_calls WHERE owner_id=$1 AND run_id=$2"
        )
        .bind(o)
        .bind(id)
        .fetch_one(&s.db.pool)
        .await
        .unwrap(),
        1
    );
    sqlx::query("DELETE FROM calls WHERE owner_id=$1 AND id=$2")
        .bind(o)
        .bind(source)
        .execute(&s.db.pool)
        .await
        .unwrap();
    let deleted = chat::get(&s, o, id).await.unwrap();
    assert_eq!(deleted["status"], "source_removed");
    assert!(deleted["answer"].is_null());
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM chat_tool_calls WHERE owner_id=$1 AND run_id=$2"
        )
        .bind(o)
        .bind(id)
        .fetch_one(&s.db.pool)
        .await
        .unwrap(),
        0
    );
}
#[tokio::test]
#[ignore = "explicit local BGE-M3 acceptance; requires pinned loopback encoder"]
async fn live_text_index_has_semantic_recall_and_synchronous_deletion() {
    use scorebook::application::{calls, knowledge_index};
    let (s, o, _tmp) = setup().await;
    let mut sources = Vec::new();
    for (i, text) in [
        "假突破追多后价格迅速跌回区间，以后等待回踩确认。",
        "资金费用和交易手续费需要分币种核对，禁止重复计算已实现盈亏。",
        "开仓先看止损位置，避免情绪化加仓。",
    ]
    .iter()
    .enumerate()
    {
        let row = calls::create(
            &s,
            o,
            &format!("doc-{i}"),
            serde_json::from_value(json!({"original_text":text})).unwrap(),
        )
        .await
        .unwrap();
        sources.push(serde_json::from_value::<Uuid>(row["id"].clone()).unwrap());
    }
    sqlx::query("UPDATE jobs SET status='cancelled' WHERE owner_id=$1")
        .bind(o)
        .execute(&s.db.pool)
        .await
        .unwrap();
    knowledge_index::request(&s, o, "index").await.unwrap();
    for _ in 0..10 {
        sqlx::query("UPDATE jobs SET run_after=now() WHERE owner_id=$1")
            .bind(o)
            .execute(&s.db.pool)
            .await
            .unwrap();
        let Some(job) = jobs::claim_for(&s, Some(o)).await.unwrap() else {
            break;
        };
        let result = knowledge_index::index::build(&s, &job).await;
        assert!(result.is_ok() || result.as_ref().unwrap_err().code == "knowledge_index_progress");
        jobs::complete(&s, &job, result).await.unwrap();
    }
    assert_eq!(
        knowledge_index::status(&s, o).await.unwrap()["pending_sources"],
        0
    );
    let result = knowledge_index::search(
        &s,
        o,
        serde_json::from_value(json!({"query":"哪些追涨后又跌回箱体的失败经验？"})).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(result["items"][0]["source_id"], json!(sources[0]));
    sqlx::query("DELETE FROM calls WHERE owner_id=$1 AND id=$2")
        .bind(o)
        .bind(sources[0])
        .execute(&s.db.pool)
        .await
        .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM knowledge_documents WHERE owner_id=$1 AND source_id=$2"
        )
        .bind(o)
        .bind(sources[0])
        .fetch_one(&s.db.pool)
        .await
        .unwrap(),
        0
    );
}

struct MemoryBackupSecret(std::sync::Mutex<Vec<u8>>);
impl scorebook_core::secrets::SecretStore for MemoryBackupSecret {
    fn load(
        &self,
        _: String,
    ) -> scorebook_core::ports::AppFuture<'_, scorebook_core::secrets::SecretBytes> {
        Box::pin(async move {
            Ok(scorebook_core::secrets::SecretBytes(
                zeroize::Zeroizing::new(self.0.lock().unwrap().clone()),
            ))
        })
    }
    fn store(
        &self,
        _: String,
        v: scorebook_core::secrets::SecretBytes,
    ) -> scorebook_core::ports::AppFuture<'_, ()> {
        Box::pin(async move {
            *self.0.lock().unwrap() = v.0.to_vec();
            Ok(())
        })
    }
}
#[tokio::test]
#[ignore = "requires pinned local restic; no external repository or real credentials"]
async fn encrypted_backup_roundtrip_isolated_restore_and_wrong_password() {
    use scorebook::application::{backups, calls, exports};
    let (mut s, o, _tmp) = setup().await;
    let target = tempfile::tempdir().unwrap();
    let secret = std::sync::Arc::new(MemoryBackupSecret(std::sync::Mutex::new(
        serde_json::to_vec(&json!({"password":format!("{}{}",Uuid::new_v4(),Uuid::new_v4())}))
            .unwrap(),
    )));
    s.secrets = secret.clone();
    s.restic =
        scorebook::adapters::restic::Restic::at(std::fs::canonicalize("ops/bin/restic").unwrap())
            .unwrap();
    let call = calls::create(
        &s,
        o,
        "record",
        serde_json::from_value(json!({"original_text":"只有经过仓库读回验证，才算一次成功备份"}))
            .unwrap(),
    )
    .await
    .unwrap();
    sqlx::query("UPDATE jobs SET status='cancelled' WHERE owner_id=$1")
        .bind(o)
        .execute(&s.db.pool)
        .await
        .unwrap();
    let conf=backups::create(&s,o,"configuration",serde_json::from_value(json!({"repository":target.path().join("encrypted-repository"),"storage_kind":"local","keychain_service":format!("scorebook.backup.{o}.fixture"),"enabled":true})).unwrap()).await.unwrap();
    let id = serde_json::from_value(conf["configuration_id"].clone()).unwrap();
    backups::initialize(
        &s,
        o,
        id,
        scorebook_core::api::backups::BackupInitialize {
            mode: "create".into(),
        },
    )
    .await
    .unwrap();
    let requested = backups::request(&s, o, id, "backup").await.unwrap();
    for _ in 0..8 {
        sqlx::query("UPDATE jobs SET run_after=now() WHERE owner_id=$1")
            .bind(o)
            .execute(&s.db.pool)
            .await
            .unwrap();
        if !jobs::run_filtered(&s, Some(o), Some("maintenance"))
            .await
            .unwrap()
        {
            break;
        }
    }
    let state = backups::status(&s, o).await.unwrap();
    let run = &state["recent_runs"][0];
    assert_eq!(run["status"], "verified", "{state}");
    let snapshot = run["snapshot_id"].as_str().unwrap();
    let destination = target.path().join("recovered");
    backups::restore_snapshot(&s, o, id, snapshot, &destination)
        .await
        .unwrap();
    let manifest: Value =
        serde_json::from_slice(&std::fs::read(destination.join("manifest.json")).unwrap()).unwrap();
    assert_eq!(manifest["tables"]["calls"]["rows"], 1);
    assert!(
        !manifest["tables"]
            .as_object()
            .unwrap()
            .contains_key("backup_configurations")
    );
    assert!(
        !manifest["tables"]
            .as_object()
            .unwrap()
            .contains_key("credentials")
    );
    assert!(
        !manifest["tables"]
            .as_object()
            .unwrap()
            .contains_key("public_market.features")
    );
    let dbname = format!("scorebook_backup_restore_{}", Uuid::new_v4().simple());
    sqlx::query(&format!("CREATE DATABASE {dbname}"))
        .execute(&s.db.pool)
        .await
        .unwrap();
    let mut url = reqwest::Url::parse(&std::env::var("DATABASE_URL").unwrap()).unwrap();
    url.set_path(&format!("/{dbname}"));
    let db = Database::connect(url.as_str()).await.unwrap();
    db.migrate().await.unwrap();
    let restore_root = tempfile::tempdir().unwrap();
    let restored = Services::new(
        db.clone(),
        Storage::new(restore_root.path()),
        Vision::new(None),
    )
    .unwrap();
    let result = exports::restore(&restored, &destination).await;
    if result.is_ok() {
        let call_id = serde_json::from_value(call["id"].clone()).unwrap();
        assert_eq!(
            calls::get(&restored, o, call_id).await.unwrap()["body"]["original_text"],
            "只有经过仓库读回验证，才算一次成功备份"
        );
    }
    db.pool.close().await;
    sqlx::query(&format!("DROP DATABASE {dbname}"))
        .execute(&s.db.pool)
        .await
        .unwrap();
    assert!(result.is_ok(), "{result:?}");
    let previous = secret.0.lock().unwrap().clone();
    *secret.0.lock().unwrap() = serde_json::to_vec(
        &json!({"password":"deliberately-wrong-password-over-twenty-characters"}),
    )
    .unwrap();
    let failed = backups::restore_snapshot(
        &s,
        o,
        id,
        snapshot,
        &target.path().join("wrong-key-recovery"),
    )
    .await;
    *secret.0.lock().unwrap() = previous;
    assert!(failed.is_err());
    assert_eq!(
        backups::request(&s, o, id, "backup").await.unwrap(),
        requested
    );
}

#[tokio::test]
async fn projection_append_reuses_closed_cycles_and_rebuilds_only_out_of_order_book() {
    use scorebook::application::trades;
    let (s, o, _tmp) = setup().await;
    let c = trades::connection(
        &s,
        o,
        "c",
        serde_json::from_value(
            json!({"name":"incremental","account_label":"incremental","market":"usd_m"}),
        )
        .unwrap(),
    )
    .await
    .unwrap();
    let connection: Uuid = serde_json::from_value(c["connection_id"].clone()).unwrap();
    trades::seed(&s,o,"seed",serde_json::from_value(json!({"connection_id":connection,"symbol":"BTCUSDT","position_side":"BOTH","effective_at":"2024-01-01T00:00:00Z","quantity":"0","contract_multiplier":"1","settlement_asset":"USDT","evidence":"zero statement"})).unwrap()).await.unwrap();
    let fill = |id: i32, symbol: &str, side: &str, at: i32| json!({"trade_id":id.to_string(),"symbol":symbol,"side":side,"position_side":"BOTH","price":"100","quantity":"1","realized_pnl":"0","settlement_asset":"USDT","commission":"0.1","commission_asset":"USDT","traded_at":format!("2024-01-01T00:00:{at:02}Z")});
    let mut results = Vec::new();
    let first = vec![
        fill(1, "BTCUSDT", "BUY", 1),
        fill(2, "BTCUSDT", "SELL", 2),
        fill(3, "BTCUSDT", "BUY", 3),
        fill(1, "ETHUSDT", "BUY", 1),
    ];
    for (n, fs) in [
        first,
        vec![fill(4, "BTCUSDT", "SELL", 4)],
        vec![fill(5, "BTCUSDT", "BUY", 2)],
    ]
    .into_iter()
    .enumerate()
    {
        trades::import::import(&s,o,&format!("import-{n}"),serde_json::from_value(json!({"dataset":"trades","connection_id":connection,"source":"csv","start_at":"2024-01-01T00:00:00Z","end_at":"2024-01-02T00:00:00Z","symbols":["BTCUSDT","ETHUSDT"],"fills":fs,"declared_complete":true})).unwrap()).await.unwrap();
        for _ in 0..5 {
            if !jobs::run_filtered(&s, Some(o), Some("batch"))
                .await
                .unwrap()
            {
                break;
            }
        }
        let rows = trades::projection::list(
            &s,
            o,
            serde_json::from_value(json!({"connection_id":connection})).unwrap(),
        )
        .await
        .unwrap();
        results.push(rows);
    }
    let old = results[0]["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["cycle"]["symbol"] == "BTCUSDT" && v["cycle"]["ordinal"] == 0)
        .unwrap();
    let second = results[1]["items"].as_array().unwrap();
    assert_eq!(
        second
            .iter()
            .find(|v| v["cycle"]["symbol"] == "BTCUSDT" && v["cycle"]["ordinal"] == 0)
            .unwrap()["id"],
        old["id"]
    );
    assert_eq!(
        second
            .iter()
            .filter(|v| v["cycle"]["symbol"] == "BTCUSDT" && v["cycle"]["status"] == "closed")
            .count(),
        2
    );
    let completed:Vec<Value>=sqlx::query_scalar("SELECT result FROM jobs WHERE owner_id=$1 AND kind='trade.project' AND result->>'status'='ready' ORDER BY created_at").bind(o).fetch_all(&s.db.pool).await.unwrap();
    assert_eq!(completed.len(), 3);
    assert_eq!(completed[1]["processed_fills"], 1);
    assert_eq!(completed[1]["book_modes"]["unchanged_book"], 1);
    assert_eq!(completed[2]["processed_fills"], 5);
    assert_eq!(completed[2]["book_modes"]["historical_insert_rebuild"], 1);
    // Four initial references plus one new reference; the open-cycle ancestry is shared.
    let refs:i64=sqlx::query_scalar("SELECT count(*) FROM trade_cycle_allocations a JOIN trade_cycles c ON c.id=a.cycle_id WHERE c.owner_id=$1 AND c.run_id=ANY($2)").bind(o).bind(vec![serde_json::from_value::<Uuid>(completed[0]["projection_run_id"].clone()).unwrap(),serde_json::from_value::<Uuid>(completed[1]["projection_run_id"].clone()).unwrap()]).fetch_one(&s.db.pool).await.unwrap();
    assert_eq!(refs, 5);
}

#[tokio::test]
async fn historical_export_unknown_submission_never_resubmits_and_batches_once() {
    use scorebook::application::trades;
    use scorebook_core::exchange::{AccountHistoryProvider, AccountRead};
    struct ExportMock {
        calls: std::sync::atomic::AtomicUsize,
    }
    impl AccountHistoryProvider for ExportMock {
        fn read<'a>(
            &'a self,
            _: &'a str,
            _: &'a str,
            r: AccountRead,
        ) -> scorebook_core::ports::AppFuture<'a, Value> {
            Box::pin(async move {
                match r {
                    AccountRead::HistoryExport { .. } => {
                        self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        Err(scorebook_core::error::Error::transient(
                            "exchange_account_request_failed",
                        ))
                    }
                    AccountRead::HistoryDownload { download_id } => Ok(
                        json!({"downloadId":download_id,"status":"completed","url":"fixture-private-link","expirationTimestamp":chrono::Utc::now().timestamp_millis()+60000}),
                    ),
                    _ => panic!("unexpected endpoint"),
                }
            })
        }
        fn download<'a>(&'a self, _: String) -> scorebook_core::ports::AppFuture<'a, Vec<u8>> {
            Box::pin(async {
                let mut csv = "ID,Symbol,Side,Price,Quantity,Fee,Time\n".to_string();
                for id in 1..=1001 {
                    csv.push_str(&format!(
                        "{id},BTCUSDT,BUY,100,1,0.1,2024-01-01T01:00:00Z\n"
                    ));
                }
                Ok(csv.into_bytes())
            })
        }
    }
    let (mut s, o, _tmp) = setup().await;
    let provider = std::sync::Arc::new(ExportMock {
        calls: std::sync::atomic::AtomicUsize::new(0),
    });
    s.accounts = provider.clone();
    // Release only old synthetic-test minute reservations; no production DB is used.
    sqlx::query("UPDATE exchange_export_reservations SET created_at=now()-interval '2 minutes' WHERE owner_id IN(SELECT id FROM users WHERE name='v4-test')").execute(&s.db.pool).await.unwrap();
    let c=trades::connection(&s,o,"c",serde_json::from_value(json!({"name":"export","account_label":"export","market":"usd_m","keychain_service":format!("scorebook.exchange.{o}.fixture")})).unwrap()).await.unwrap();
    let connection = serde_json::from_value::<Uuid>(c["connection_id"].clone()).unwrap();
    let input = json!({"connection_id":connection,"start_at":"2024-01-01T00:00:00Z","end_at":"2024-01-02T00:00:00Z","dataset":"trades","format":"csv","mapping":{"columns":{"trade_id":"ID","symbol":"Symbol","side":"Side","price":"Price","quantity":"Quantity","commission":"Fee","traded_at":"Time"},"constants":{"position_side":"BOTH","settlement_asset":"USDT","commission_asset":"USDT"},"timestamp_format":"iso8601"}});
    let run =
        trades::historical_export::create(&s, o, "export", serde_json::from_value(input).unwrap())
            .await
            .unwrap();
    let id = serde_json::from_value::<Uuid>(run["export_run_id"].clone()).unwrap();
    assert!(
        jobs::run_filtered(&s, Some(o), Some("batch"))
            .await
            .unwrap()
    );
    let state = trades::historical_export::get(&s, o, id).await.unwrap();
    assert_eq!(state["status"], "submission_unknown");
    jobs::retry(
        &s,
        o,
        id,
        "retry",
        serde_json::from_value(json!({"expected_generation":state["generation"]})).unwrap(),
    )
    .await
    .unwrap();
    jobs::run_filtered(&s, Some(o), Some("batch"))
        .await
        .unwrap();
    assert_eq!(provider.calls.load(std::sync::atomic::Ordering::SeqCst), 1);
    let state = trades::historical_export::get(&s, o, id).await.unwrap();
    trades::historical_export::resolve(&s,o,id,"resolve",serde_json::from_value(json!({"expected_generation":state["generation"],"download_id":"12345","evidence":"verified task ID from exchange receipt"})).unwrap()).await.unwrap();
    jobs::run_filtered(&s, Some(o), Some("batch"))
        .await
        .unwrap();
    let state = trades::historical_export::get(&s, o, id).await.unwrap();
    assert_eq!(state["status"], "complete", "{state}");
    assert_eq!(state["imported_rows"], 1001);
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM trade_fills WHERE owner_id=$1")
        .bind(o)
        .fetch_one(&s.db.pool)
        .await
        .unwrap();
    assert_eq!(count, 1001);
    let projects: i64 =
        sqlx::query_scalar("SELECT count(*) FROM jobs WHERE owner_id=$1 AND kind='trade.project'")
            .bind(o)
            .fetch_one(&s.db.pool)
            .await
            .unwrap();
    assert_eq!(projects, 1);
    let persisted: String =
        sqlx::query_scalar("SELECT body::text||COALESCE(result::text,'') FROM jobs WHERE id=$1")
            .bind(id)
            .fetch_one(&s.db.pool)
            .await
            .unwrap();
    assert!(!persisted.contains("fixture-private-link"));
}
