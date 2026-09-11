mod common;
use scorebook::{
    adapters::{db::Database, storage::Storage, vision::Vision},
    application::{Services, chart_search, history_catalog, jobs},
};
use serde_json::{Value, json};
use uuid::Uuid;
async fn setup() -> (Services, Uuid, tempfile::TempDir) {
    let db = Database::connect(&common::test_db_url()).await.unwrap();
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
    let input = json!({"attachment_id":attachment,"scope":"binance_history","interval":"1h"});
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
                let evidence = input
                    .messages
                    .iter()
                    .find(|m| m.role == "tool")
                    .unwrap()
                    .content["source"]
                    .clone();
                Ok(serde_json::from_value(json!({"answer":[{"text":"原始记录建议等待突破后的回踩确认。","inference":false,"citations":[{"source_kind":"call","source_id":self.source,"source_version":source["source_version"]},evidence]}]})).unwrap())
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
    // Host and PostgreSQL clocks can differ slightly; wait within a bounded test budget.
    let mut next = None;
    for _ in 0..50 {
        next = jobs::claim_for(&s, Some(o)).await.unwrap();
        if next.is_some() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    let job = next.expect("next Chat turn did not become due");
    let result = chat::runtime::run(&s, &job).await.unwrap();
    jobs::complete(&s, &job, Ok(result)).await.unwrap();
    assert_eq!(model.calls.load(std::sync::atomic::Ordering::SeqCst), 2);
    let done = chat::get(&s, o, id).await.unwrap();
    assert_eq!(done["status"], "completed");
    assert_eq!(
        done["answer"][0]["citations"][1]["source_kind"],
        "tool_result"
    );
    let evidence = scorebook::application::knowledge_index::source(
        &s,
        o,
        serde_json::from_value(done["answer"][0]["citations"][1].clone()).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(evidence["body"]["tool"], "read_source");
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
    let mut png = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
        64,
        32,
        image::Rgb([20, 80, 120]),
    ))
    .write_to(&mut png, image::ImageFormat::Png)
    .unwrap();
    let image = calls::upload(
        &s,
        o,
        "backup-image",
        png.into_inner(),
        "scene".into(),
        None,
    )
    .await
    .unwrap();
    let image_id: Uuid = serde_json::from_value(image["id"].clone()).unwrap();
    let call = calls::create(
        &s,
        o,
        "record",
        serde_json::from_value(json!({"original_text":"只有经过仓库读回验证，才算一次成功备份","attachments":[image_id]}))
            .unwrap(),
    )
    .await
    .unwrap();
    use scorebook::application::trades;
    let conn = trades::connection(
        &s,
        o,
        "backup-account",
        serde_json::from_value(
            json!({"name":"backup ledger","account_label":"backup-ledger","market":"usd_m"}),
        )
        .unwrap(),
    )
    .await
    .unwrap();
    let connection: Uuid = serde_json::from_value(conn["connection_id"].clone()).unwrap();
    trades::seed(&s,o,"backup-seed",serde_json::from_value(json!({"connection_id":connection,"symbol":"BTCUSDT","position_side":"BOTH","effective_at":"2024-01-01T00:00:00Z","quantity":"0","contract_multiplier":"1","settlement_asset":"USDT","evidence":"verified empty opening"})).unwrap()).await.unwrap();
    let fills:Vec<_>=(1..=2).map(|n|json!({"trade_id":n.to_string(),"symbol":"BTCUSDT","side":if n==1{"BUY"}else{"SELL"},"position_side":"BOTH","price":if n==1{"100"}else{"101"},"quantity":"1","realized_pnl":if n==1{"0"}else{"1"},"settlement_asset":"USDT","commission":"0.1","commission_asset":"USDT","traded_at":format!("2024-01-01T00:00:0{n}Z")})).collect();
    trades::import::import(&s,o,"backup-fills",serde_json::from_value(json!({"connection_id":connection,"dataset":"both","source":"csv","start_at":"2024-01-01T00:00:00Z","end_at":"2024-01-02T00:00:00Z","symbols":["BTCUSDT"],"fills":fills,"ledger_entries":[{"transaction_id":"funding-1","kind":"FUNDING_FEE","symbol":"BTCUSDT","asset":"USDT","amount":"-0.05","occurred_at":"2024-01-01T00:00:01Z"}],"declared_complete":true})).unwrap()).await.unwrap();
    while jobs::run_filtered(&s, Some(o), Some("batch"))
        .await
        .unwrap()
    {}
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
    assert_eq!(manifest["tables"]["trade_fills"]["rows"], 2);
    assert_eq!(manifest["tables"]["trade_book_snapshots"]["rows"], 1);
    assert_eq!(manifest["tables"]["attachments"]["rows"], 1);
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
    let mut url = reqwest::Url::parse(&common::test_db_url()).unwrap();
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
    if result.is_ok() {
        let totals: Vec<(String, String)> = sqlx::query_as(
            "SELECT kind,amount::text FROM account_asset_totals WHERE owner_id=$1 ORDER BY kind",
        )
        .bind(o)
        .fetch_all(&restored.db.pool)
        .await
        .unwrap();
        assert_eq!(
            totals,
            vec![
                ("fill_commission".into(), "0.2".into()),
                ("fill_realized_pnl".into(), "1".into()),
                ("income:FUNDING_FEE".into(), "-0.05".into())
            ]
        );
        let cycles = trades::projection::list(
            &restored,
            o,
            serde_json::from_value(json!({"connection_id":connection})).unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(cycles["items"].as_array().unwrap().len(), 1);
        assert!(restored.images.open(o, image_id).await.is_ok());
    }
    db.pool.close().await;
    sqlx::query(&format!("DROP DATABASE {dbname} WITH (FORCE)"))
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

#[tokio::test]
async fn archive_source_selection_is_explicit_idempotent_and_generation_fenced() {
    use scorebook::application::assessment_monitor::control;
    let (s, owner, _tmp) = setup().await;
    scorebook::application::calls::create(&s,owner,"archive-source-call",serde_json::from_value(json!({"original_text":"归档复盘测试","instrument":"BTCUSDT","market":"usd_m","criteria":[{"template":"T1","selected_by":"explicit","horizon_hours":1,"threshold_ratio":"0.01","direction":"L"}]})).unwrap()).await.unwrap();
    let id: Uuid =
        sqlx::query_scalar("SELECT id FROM jobs WHERE owner_id=$1 AND kind='assess' LIMIT 1")
            .bind(owner)
            .fetch_one(&s.db.pool)
            .await
            .unwrap();
    let j = jobs::claim_for(&s, Some(owner)).await.unwrap().unwrap();
    let input = json!({"expected_generation":j.generation,"source_plan":"daily_archive_v1","reason":"Recover a historical interval from official daily archives"});
    assert!(
        control::select(
            &s,
            owner,
            id,
            "select",
            serde_json::from_value(input.clone()).unwrap()
        )
        .await
        .is_err()
    );
    sqlx::query(
        "UPDATE jobs SET status='awaiting_input',lease_owner=NULL,lease_until=NULL WHERE id=$1",
    )
    .bind(id)
    .execute(&s.db.pool)
    .await
    .unwrap();
    let selected = control::select(
        &s,
        owner,
        id,
        "select",
        serde_json::from_value(input.clone()).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(
        selected,
        control::select(
            &s,
            owner,
            id,
            "select",
            serde_json::from_value(input.clone()).unwrap()
        )
        .await
        .unwrap()
    );
    assert!(
        control::select(
            &s,
            owner,
            id,
            "stale",
            serde_json::from_value(input).unwrap()
        )
        .await
        .is_err()
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM assessment_source_decisions WHERE owner_id=$1 AND job_id=$2"
        )
        .bind(owner)
        .bind(id)
        .fetch_one(&s.db.pool)
        .await
        .unwrap(),
        1
    );
    assert!(jobs::fence(&s, &j).await.is_err());
}

#[test]
fn v4_contract_includes_routes_sources_and_resumable_stream() {
    let spec = scorebook_http::openapi();
    for path in [
        "/v1/chat/runs",
        "/v1/chat/runs/{id}/events",
        "/v1/statistics/runs/{id}/groups",
        "/v1/knowledge/source/slice",
        "/v1/exchange-exports/{id}/mapping",
        "/v1/jobs/{id}/assessment-source",
        "/v1/history/indexes/{id}/revalidate",
        "/v1/backups/configurations",
    ] {
        assert!(spec["paths"].get(path).is_some(), "missing route {path}");
    }
    assert!(
        spec["paths"]["/v1/chat/runs/{id}/events"]["get"]["responses"]["200"]["content"]
            .get("text/event-stream")
            .is_some()
    );
    assert!(
        spec["components"]["schemas"]["ChartRequest"]["properties"]
            .get("source")
            .is_some()
    );
    let catalog = scorebook::application::chat::tools::catalog();
    let summary = catalog
        .iter()
        .find(|t| t.name == "get_market_summary")
        .unwrap();
    assert!(summary.parameters["properties"].get("symbol").is_some());
    assert!(summary.parameters["properties"].get("call_id").is_none());
}

#[tokio::test]
#[ignore = "50,000 synthetic fills, 100 independent imports; isolated PostgreSQL performance acceptance"]
async fn ledger_small_batches_grow_linearly() {
    use scorebook::application::trades;
    let (s, o, _tmp) = setup().await;
    let c = trades::connection(
        &s,
        o,
        "bench-account",
        serde_json::from_value(
            json!({"name":"batch-benchmark","account_label":"synthetic","market":"usd_m"}),
        )
        .unwrap(),
    )
    .await
    .unwrap();
    let connection: Uuid = serde_json::from_value(c["connection_id"].clone()).unwrap();
    trades::seed(&s,o,"bench-seed",serde_json::from_value(json!({"connection_id":connection,"symbol":"BTCUSDT","position_side":"BOTH","effective_at":"2024-01-01T00:00:00Z","quantity":"0","contract_multiplier":"1","settlement_asset":"USDT","evidence":"synthetic zero opening"})).unwrap()).await.unwrap();
    let start = std::time::Instant::now();
    for batch in 0..100 {
        let fills:Vec<Value>=(batch*500+1..=(batch+1)*500).map(|id|json!({"trade_id":id.to_string(),"symbol":"BTCUSDT","side":if id%2==1{"BUY"}else{"SELL"},"position_side":"BOTH","price":"100","quantity":"1","realized_pnl":"0","settlement_asset":"USDT","commission":"0.1","commission_asset":"USDT","traded_at":"2024-01-01T01:00:00Z"})).collect();
        trades::import::import(&s,o,&format!("batch-{batch}"),serde_json::from_value(json!({"dataset":"trades","connection_id":connection,"source":"csv","start_at":"2024-01-01T00:00:00Z","end_at":"2024-01-02T00:00:00Z","symbols":["BTCUSDT"],"fills":fills,"declared_complete":false})).unwrap()).await.unwrap();
        for _ in 0..4 {
            if !jobs::run_filtered(&s, Some(o), Some("batch"))
                .await
                .unwrap()
            {
                break;
            }
        }
        let processed:i64=sqlx::query_scalar("SELECT (result->>'processed_fills')::bigint FROM jobs WHERE owner_id=$1 AND kind='trade.project' AND result->>'status'='ready' ORDER BY created_at DESC LIMIT 1").bind(o).fetch_one(&s.db.pool).await.unwrap();
        assert_eq!(processed, 500, "batch {batch}");
    }
    let counts:(i64,i64,i64)=sqlx::query_as("SELECT (SELECT count(*) FROM trade_book_snapshots WHERE owner_id=$1),(SELECT count(*) FROM trade_epoch_cycles WHERE owner_id=$1),(SELECT count(*) FROM trade_cycle_allocations WHERE owner_id=$1)").bind(o).fetch_one(&s.db.pool).await.unwrap();
    assert_eq!(counts, (100, 25000, 50000));
    let import_ms = start.elapsed().as_millis();
    let mut pages = 0;
    let mut count = 0;
    let mut cursor = Value::Null;
    let mut latencies = Vec::new();
    loop {
        let at = std::time::Instant::now();
        let page = trades::projection::list(
            &s,
            o,
            serde_json::from_value(json!({"connection_id":connection,"cursor":cursor})).unwrap(),
        )
        .await
        .unwrap();
        latencies.push(at.elapsed().as_secs_f64() * 1000.);
        count += page["items"].as_array().unwrap().len();
        pages += 1;
        cursor = page["next_cursor"].clone();
        if cursor.is_null() {
            break;
        }
        assert!(pages < 300);
    }
    assert_eq!(count, 25000);
    latencies.sort_by(f64::total_cmp);
    let report = json!({"synthetic":true,"fills":50000,"imports":100,"processed_fills_per_import":500,"book_snapshots":counts.0,"epoch_cycles":counts.1,"allocations":counts.2,"import_and_projection_ms":import_ms,"cycle_pages":pages,"list_p95_ms":latencies[(latencies.len()*95/100).min(latencies.len()-1)],"duplicate_scope":"separate repetition test"});
    if let Ok(path) = std::env::var("SCOREBOOK_LEDGER_BENCH_REPORT") {
        std::fs::write(path, serde_json::to_vec_pretty(&report).unwrap()).unwrap();
    }
    eprintln!("{report}");
}

#[tokio::test]
async fn subscription_incremental_cursors_skip_unready_scales_and_admit_new_catalog() {
    let (s, o, _tmp) = setup().await;
    let symbol = catalog_fixture(&s).await;
    let now = chrono::Utc::now();
    let created=history_catalog::subscriptions::create(&s,o,"growth",serde_json::from_value(json!({"market":"usd_m","symbols":[symbol],"intervals":["1d"],"start_at":now-chrono::Duration::days(300),"source":"rest","max_vectors":100000})).unwrap()).await.unwrap();
    let id: Uuid = serde_json::from_value(created["subscription_id"].clone()).unwrap();
    // All scales have already consumed their last full window; the next one is not closed.
    sqlx::query("INSERT INTO history_subscription_cursors(owner_id,subscription_id,symbol,timeframe,window_bars,next_start) SELECT $1,$2,$3,'1d',w,now()-(w-1)*interval '1 day' FROM unnest(ARRAY[64,128,256]) w").bind(o).bind(id).bind(&symbol).execute(&s.db.pool).await.unwrap();
    let j = jobs::claim_for(&s, Some(o)).await.unwrap().unwrap();
    for _ in 0..3 {
        let e = history_catalog::subscriptions::step(&s, &j)
            .await
            .unwrap_err();
        assert_eq!(e.code, "subscription_no_new_closed_window");
    }
    let finished = history_catalog::subscriptions::step(&s, &j).await.unwrap();
    assert_eq!(finished["status"], "cycle_complete");
    // All-catalog subscriptions discover a newly listed contract on the next cycle.
    let added = catalog_fixture(&s).await;
    sqlx::query("UPDATE history_subscriptions SET body=jsonb_set(body,'{definition,symbols}','[]'),next_run_at=now(),watermark=now()-interval '2 days' WHERE id=$1").bind(id).execute(&s.db.pool).await.unwrap();
    history_catalog::subscriptions::schedule(&s).await.unwrap();
    let state = history_catalog::subscriptions::get(&s, o, id)
        .await
        .unwrap();
    assert!(
        state["body"]["resolved_symbols"]
            .as_array()
            .unwrap()
            .contains(&json!(added))
    );
    // Growth never increases an accepted resource budget silently.
    sqlx::query("UPDATE history_subscriptions SET body=jsonb_set(body,'{definition,max_vectors}','1'),cycle_end=NULL,next_run_at=now(),watermark=now()-interval '2 days' WHERE id=$1").bind(id).execute(&s.db.pool).await.unwrap();
    history_catalog::subscriptions::schedule(&s).await.unwrap();
    let state = history_catalog::subscriptions::get(&s, o, id)
        .await
        .unwrap();
    assert_eq!(state["status"], "needs_attention");
    assert_eq!(state["last_error"], "history_capacity_budget_exceeded");
}

#[tokio::test]
async fn knowledge_long_document_resumes_and_repairs_missing_vectors() {
    use scorebook::application::{calls, knowledge_index};
    use scorebook_core::knowledge_index::{MODEL, TextEncoder, TextEncoding, WEIGHTS};
    struct Encoder {
        calls: std::sync::atomic::AtomicUsize,
        fail: std::sync::atomic::AtomicBool,
    }
    impl TextEncoder for Encoder {
        fn configured(&self) -> bool {
            true
        }
        fn encode(&self, texts: Vec<String>) -> scorebook_core::ports::AppFuture<'_, TextEncoding> {
            self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Box::pin(async move {
                if self.fail.load(std::sync::atomic::Ordering::SeqCst) {
                    return Err(scorebook_core::error::Error::transient(
                        "fixture_encoder_interrupted",
                    ));
                }
                let mut v = vec![0.; 1024];
                v[0] = 1.;
                Ok(TextEncoding {
                    model_id: MODEL.into(),
                    weights_sha256: WEIGHTS.into(),
                    vectors: vec![v; texts.len()],
                })
            })
        }
    }
    let (mut s, o, _tmp) = setup().await;
    let model = std::sync::Arc::new(Encoder {
        calls: 0.into(),
        fail: false.into(),
    });
    s.text = model.clone();
    let record = calls::create(
        &s,
        o,
        "long",
        serde_json::from_value(
            json!({"original_text":"等待突破后的回踩确认，再看成交量与假突破。".repeat(220)}),
        )
        .unwrap(),
    )
    .await
    .unwrap();
    let source: Uuid = serde_json::from_value(record["id"].clone()).unwrap();
    sqlx::query("UPDATE jobs SET status='cancelled' WHERE owner_id=$1")
        .bind(o)
        .execute(&s.db.pool)
        .await
        .unwrap();
    knowledge_index::request(&s, o, "index-long").await.unwrap();
    let j = jobs::claim_for(&s, Some(o)).await.unwrap().unwrap();
    assert_eq!(
        knowledge_index::index::build(&s, &j)
            .await
            .unwrap_err()
            .code,
        "knowledge_index_progress"
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM knowledge_chunks WHERE owner_id=$1")
        .bind(o)
        .fetch_one(&s.db.pool)
        .await
        .unwrap();
    assert_eq!(count, 16);
    assert_eq!(
        knowledge_index::status(&s, o).await.unwrap()["indexed_sources"],
        0
    );
    model.fail.store(true, std::sync::atomic::Ordering::SeqCst);
    assert_eq!(
        knowledge_index::index::build(&s, &j)
            .await
            .unwrap_err()
            .code,
        "fixture_encoder_interrupted"
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM knowledge_chunks WHERE owner_id=$1")
        .bind(o)
        .fetch_one(&s.db.pool)
        .await
        .unwrap();
    assert_eq!(count, 16);
    model.fail.store(false, std::sync::atomic::Ordering::SeqCst);
    for _ in 0..12 {
        if knowledge_index::index::build(&s, &j).await.is_ok() {
            break;
        }
    }
    assert_eq!(
        knowledge_index::status(&s, o).await.unwrap()["pending_sources"],
        0
    );
    let (total, unique): (i64, i64) = sqlx::query_as(
        "SELECT count(*),count(DISTINCT ordinal) FROM knowledge_chunks c JOIN knowledge_documents d ON d.id=c.document_id WHERE c.owner_id=$1 AND d.source_kind='call'",
    )
    .bind(o)
    .fetch_one(&s.db.pool)
    .await
    .unwrap();
    assert_eq!(total, unique);
    assert!(total > 16);
    sqlx::query("DELETE FROM knowledge_embeddings WHERE chunk_id=(SELECT min(c.id::text)::uuid FROM knowledge_chunks c JOIN knowledge_documents d ON d.id=c.document_id WHERE c.owner_id=$1 AND d.source_kind='call')").bind(o).execute(&s.db.pool).await.unwrap();
    knowledge_index::repair::step_for(&s, Some(o))
        .await
        .unwrap();
    let pending:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM knowledge_dirty WHERE owner_id=$1 AND source_kind='call' AND source_id=$2)").bind(o).bind(source).fetch_one(&s.db.pool).await.unwrap();
    assert!(pending);
    for _ in 0..12 {
        if knowledge_index::index::build(&s, &j).await.is_ok() {
            break;
        }
    }
    let missing:i64=sqlx::query_scalar("SELECT count(*) FROM knowledge_chunks c LEFT JOIN knowledge_embeddings e ON e.chunk_id=c.id WHERE c.owner_id=$1 AND e.chunk_id IS NULL").bind(o).fetch_one(&s.db.pool).await.unwrap();
    assert_eq!(missing, 0);
}

async fn baseline_fixture(
    s: &Services,
    o: Uuid,
    horizon: u32,
) -> scorebook::application::jobs::Job {
    use scorebook::application::{calls, statistics};
    calls::create(s,o,"baseline-call",serde_json::from_value(json!({"original_text":"背景参照测试","instrument":"BTCUSDT","market":"usd_m","criteria":[{"template":"T1","selected_by":"explicit","horizon_hours":horizon,"threshold_ratio":"0.01","direction":"L"}]})).unwrap()).await.unwrap();
    sqlx::query("UPDATE jobs SET status='cancelled' WHERE owner_id=$1")
        .bind(o)
        .execute(&s.db.pool)
        .await
        .unwrap();
    let stat=statistics::create(s,o,"baseline-stats",serde_json::from_value(json!({"name":"B1 test","filters":{},"comparison_policy":"exact_frozen_rule","grouping":"call_rule","calendar":"natural_hours","outcome_policy":"current_formal_head"})).unwrap()).await.unwrap();
    let j = jobs::claim_for(s, Some(o)).await.unwrap().unwrap();
    let v = statistics::snapshot::build(s, &j).await.unwrap();
    jobs::complete(s, &j, Ok(v)).await.unwrap();
    statistics::baseline::create(s,o,"baseline",serde_json::from_value(json!({"statistics_run_id":stat["statistics_run_id"],"source_plan":"rest_closed_minute_endpoints_v1","calendar":"natural_hours"})).unwrap()).await.unwrap();
    jobs::claim_for(s, Some(o)).await.unwrap().unwrap()
}
#[tokio::test]
async fn baseline_250_days_excludes_future_observations_and_resumes_exactly() {
    struct Market {
        cutoff: chrono::DateTime<chrono::Utc>,
    }
    impl scorebook::application::ports::MarketDataProvider for Market {
        fn tickers_24h<'a>(&'a self, _: &'a str) -> scorebook_core::market::ProviderFuture<'a> {
            Box::pin(async { unreachable!("this fixture does not request instrument popularity") })
        }

        fn klines<'a>(
            &'a self,
            _: &'a str,
            _: &'a str,
            tf: &'a str,
            start: chrono::DateTime<chrono::Utc>,
            end: chrono::DateTime<chrono::Utc>,
        ) -> scorebook::application::ports::ProviderFuture<'a> {
            Box::pin(async move {
                assert!(end < self.cutoff, "future observation requested");
                let seconds = match tf {
                    "1d" => 86400,
                    "1h" => 3600,
                    _ => 60,
                };
                let mut at = start;
                let mut bars = vec![];
                while at + chrono::Duration::seconds(seconds) <= end {
                    bars.push(json!({"start":at,"end":at+chrono::Duration::seconds(seconds),"open":"100","high":"102","low":"99","close":"100"}));
                    at += chrono::Duration::seconds(seconds);
                }
                Ok(
                    json!({"bars":bars,"raw":[[0,"100","102","99","100",0,0,0,10]],"coverage_complete":true}),
                )
            })
        }
        fn trades<'a>(
            &'a self,
            _: &'a str,
            _: &'a str,
            _: chrono::DateTime<chrono::Utc>,
            _: chrono::DateTime<chrono::Utc>,
        ) -> scorebook::application::ports::ProviderFuture<'a> {
            Box::pin(async { panic!("B1 must use its declared closed-minute source") })
        }
        fn exchange_info<'a>(
            &'a self,
            _: &'a str,
        ) -> scorebook::application::ports::ProviderFuture<'a> {
            Box::pin(async { panic!("unexpected catalog") })
        }
    }
    let (s, o, _tmp) = setup().await;
    let cutoff = chrono::Utc::now();
    let s = s.with_market(std::sync::Arc::new(Market { cutoff }));
    let j = baseline_fixture(&s, o, 48).await;
    let mut completed = false;
    for _ in 0..251 {
        match scorebook::application::statistics::baseline::build(&s, &j).await {
            Ok(_) => {
                completed = true;
                break;
            }
            Err(e) => assert_eq!(e.code, "baseline_progress"),
        }
    }
    assert!(completed);
    let (total,valid,excluded):(i64,i64,i64)=sqlx::query_as("SELECT count(*),count(*) FILTER(WHERE result->>'state' IN ('realized','unrealized')),count(*) FILTER(WHERE result->>'reason'='observation_not_entirely_before_submission') FROM baseline_samples WHERE owner_id=$1 AND run_id=$2").bind(o).bind(j.id).fetch_one(&s.db.pool).await.unwrap();
    assert_eq!((total, valid, excluded), (250, 248, 2));
    let before = scorebook::application::statistics::baseline::get(&s, o, j.id)
        .await
        .unwrap();
    scorebook::application::statistics::baseline::build(&s, &j)
        .await
        .unwrap();
    assert_eq!(
        before,
        scorebook::application::statistics::baseline::get(&s, o, j.id)
            .await
            .unwrap()
    );
}

#[tokio::test]
#[ignore = "one live Binance B1 sample; full 250-day semantics covered independently"]
async fn live_baseline_sample_uses_real_closed_trade_endpoints() {
    let (s, o, _tmp) = setup().await;
    let j = baseline_fixture(&s, o, 1).await;
    let result = scorebook::application::statistics::baseline::build(&s, &j)
        .await
        .unwrap_err();
    assert_eq!(result.code, "baseline_progress");
    let sample: Value =
        sqlx::query_scalar("SELECT result FROM baseline_samples WHERE owner_id=$1 AND run_id=$2")
            .bind(o)
            .bind(j.id)
            .fetch_one(&s.db.pool)
            .await
            .unwrap();
    assert!(
        matches!(sample["state"].as_str(), Some("realized" | "unrealized")),
        "{sample}"
    );
}

#[tokio::test]
async fn explicit_v19_archive_upgrade_restores_evidence_and_declares_missing_history() {
    use scorebook::adapters::db::hash_bytes;
    use scorebook::application::{calls, exports};
    let (s, o, tmp) = setup().await;
    let call = calls::create(
        &s,
        o,
        "v19",
        serde_json::from_value(json!({"original_text":"旧归档原话不能改变"})).unwrap(),
    )
    .await
    .unwrap();
    let e = Uuid::new_v4();
    exports::export(&s, o, e).await.unwrap();
    let source = tmp
        .path()
        .join("exports")
        .join(o.to_string())
        .join(e.to_string());
    // A strict v19-format fixture: retain only the published v19 table catalog.
    let old: Vec<String> =
        serde_json::from_str(include_str!("../docs/archive-schema-v19.json")).unwrap();
    let mut manifest: Value =
        serde_json::from_slice(&std::fs::read(source.join("manifest.json")).unwrap()).unwrap();
    let extra: Vec<String> = manifest["tables"]
        .as_object()
        .unwrap()
        .keys()
        .filter(|t| !old.contains(t))
        .cloned()
        .collect();
    for table in extra {
        for c in manifest["tables"][&table]["chunks"].as_array().unwrap() {
            std::fs::remove_file(source.join(c["file"].as_str().unwrap())).unwrap();
        }
        manifest["tables"].as_object_mut().unwrap().remove(&table);
    }
    manifest["schema_version"] = json!(19);
    let bytes = serde_json::to_vec_pretty(&manifest).unwrap();
    std::fs::write(source.join("manifest.json"), &bytes).unwrap();
    std::fs::write(source.join("manifest.sha256"), hash_bytes(&bytes)).unwrap();
    assert!(exports::verify(&source).await.is_err());
    let upgraded = tmp.path().join("explicit-upgrade");
    exports::upgrade::v19(&source, &upgraded).await.unwrap();
    assert_eq!(std::fs::read(source.join("manifest.json")).unwrap(), bytes);
    let name = format!("scorebook_v19_restore_{}", Uuid::new_v4().simple());
    sqlx::query(&format!("CREATE DATABASE {name}"))
        .execute(&s.db.pool)
        .await
        .unwrap();
    let mut url = reqwest::Url::parse(&common::test_db_url()).unwrap();
    url.set_path(&format!("/{name}"));
    let db = Database::connect(url.as_str()).await.unwrap();
    db.migrate().await.unwrap();
    let storage = tempfile::tempdir().unwrap();
    let restored = Services::new(db, Storage::new(storage.path()), Vision::new(None)).unwrap();
    let result = exports::restore(&restored, &upgraded).await;
    if result.is_ok() {
        let id: Uuid = serde_json::from_value(call["id"].clone()).unwrap();
        assert_eq!(
            calls::get(&restored, o, id).await.unwrap()["body"]["original_text"],
            "旧归档原话不能改变"
        );
        let status: String = sqlx::query_scalar(
            "SELECT body->>'status' FROM submission_feedback WHERE owner_id=$1 AND call_id=$2",
        )
        .bind(o)
        .bind(id)
        .fetch_one(&restored.db.pool)
        .await
        .unwrap();
        assert_eq!(status, "not_captured_at_submission");
        let n: i64 =
            sqlx::query_scalar("SELECT count(*) FROM image_reindex_runs WHERE owner_id=$1")
                .bind(o)
                .fetch_one(&restored.db.pool)
                .await
                .unwrap();
        assert_eq!(n, 1);
    }
    restored.db.pool.close().await;
    sqlx::query(&format!("DROP DATABASE {name} WITH (FORCE)"))
        .execute(&s.db.pool)
        .await
        .unwrap();
    assert!(result.is_ok(), "{result:?}");
}

#[tokio::test]
async fn capability_status_distinguishes_implementation_from_configuration() {
    let (s, o, _tmp) = setup().await;
    let value = scorebook::application::capabilities::get(&s, o)
        .await
        .unwrap();
    assert_eq!(value["chat_generation"]["configured"], false);
    assert_eq!(value["exchange_accounts"]["configured"], false);
    assert_eq!(value["encrypted_backup"]["repository_configured"], false);
    assert_eq!(
        value["image_structure_search"]["real_image_quality_validated"],
        false
    );
    assert_eq!(value["raw_market_storage"], "none");
}

#[tokio::test]
#[ignore = "native OCR required; synthetic market verifies new search pipeline, not real screenshot quality"]
async fn chart_v2_runs_ocr_public_candidate_refetch_and_source_change_exclusion() {
    use scorebook::application::{calls, history, ports};
    struct Market {
        bars: Vec<scorebook::domain::criteria::Bar>,
        changed: std::sync::atomic::AtomicBool,
    }
    impl ports::MarketDataProvider for Market {
        fn tickers_24h<'a>(&'a self, _: &'a str) -> scorebook_core::market::ProviderFuture<'a> {
            Box::pin(async { unreachable!("this fixture does not request instrument popularity") })
        }

        fn klines<'a>(
            &'a self,
            _: &'a str,
            _: &'a str,
            _: &'a str,
            start: chrono::DateTime<chrono::Utc>,
            end: chrono::DateTime<chrono::Utc>,
        ) -> ports::ProviderFuture<'a> {
            Box::pin(async move {
                let mut bars: Vec<_> = self
                    .bars
                    .iter()
                    .filter(|b| b.start >= start && b.end <= end)
                    .cloned()
                    .collect();
                if self.changed.load(std::sync::atomic::Ordering::SeqCst) {
                    bars[0].high = "200".into();
                }
                Ok(json!({"bars":bars,"coverage_complete":true}))
            })
        }
        fn trades<'a>(
            &'a self,
            _: &'a str,
            _: &'a str,
            _: chrono::DateTime<chrono::Utc>,
            _: chrono::DateTime<chrono::Utc>,
        ) -> ports::ProviderFuture<'a> {
            Box::pin(async { panic!("not used") })
        }
        fn exchange_info<'a>(&'a self, _: &'a str) -> ports::ProviderFuture<'a> {
            Box::pin(async { panic!("not used") })
        }
    }
    let (s, o, _tmp) = setup().await;
    let symbol = catalog_fixture(&s).await;
    let start: chrono::DateTime<chrono::Utc> = "2024-01-01T00:00:00Z".parse().unwrap();
    let end = start + chrono::Duration::hours(64);
    let bars: Vec<_> = (0..64)
        .map(|i| {
            let p = 100. + (i as f64) * 0.8 + ((i as f64) * 0.4).sin() * 5.;
            scorebook::domain::criteria::Bar {
                start: start + chrono::Duration::hours(i),
                end: start + chrono::Duration::hours(i + 1),
                open: p.to_string(),
                high: (p + 2.).to_string(),
                low: (p - 1.).to_string(),
                close: (p + 0.5).to_string(),
            }
        })
        .collect();
    let mut png = std::io::Cursor::new(Vec::new());
    scorebook::domain::chart::raster(&bars)
        .unwrap()
        .write_to(&mut png, image::ImageFormat::Png)
        .unwrap();
    let market = std::sync::Arc::new(Market {
        bars,
        changed: false.into(),
    });
    let s = s.with_market(market.clone());
    let attachment = calls::upload(&s, o, "query", png.into_inner(), "query".into(), None)
        .await
        .unwrap();
    sqlx::query("UPDATE jobs SET status='cancelled' WHERE owner_id=$1")
        .bind(o)
        .execute(&s.db.pool)
        .await
        .unwrap();
    history::request(&s,o,"index",serde_json::from_value(json!({"symbol":symbol,"market":"usd_m","interval":"1h","start_at":start,"end_at":end,"window_bars":64,"stride_bars":16})).unwrap()).await.unwrap();
    let j = jobs::claim_for(&s, Some(o)).await.unwrap().unwrap();
    let result = history::build(&s, &j).await;
    jobs::complete(&s, &j, result).await.unwrap();
    for changed in [false, true] {
        market
            .changed
            .store(changed, std::sync::atomic::Ordering::SeqCst);
        let r=chart_search::create(&s,o,&format!("query-{changed}"),serde_json::from_value(json!({"attachment_id":attachment["id"],"scope":"binance_history","symbol":symbol,"market":"usd_m","interval":"1h","cutoff_at":end})).unwrap()).await.unwrap();
        let j = jobs::claim_for(&s, Some(o)).await.unwrap().unwrap();
        let result = chart_search::run(&s, &j).await.unwrap();
        if !changed {
            assert_eq!(result["items"].as_array().unwrap().len(), 1);
            assert!(result["items"][0]["match"]["score"].as_f64().unwrap() > 0.85);
            assert_eq!(result["items"][0]["chart_request"]["source"], "rest");
        } else {
            assert_eq!(result["items"], json!([]));
            assert_eq!(
                result["excluded_candidates"][0]["reason"],
                "source_changed_or_incomplete"
            );
        }
        jobs::complete(&s, &j, Ok(result)).await.unwrap();
        let persisted: String =
            sqlx::query_scalar("SELECT result::text FROM chart_search_runs WHERE id=$1")
                .bind(serde_json::from_value::<Uuid>(r["search_run_id"].clone()).unwrap())
                .fetch_one(&s.db.pool)
                .await
                .unwrap();
        assert!(!persisted.contains("\"bars\""));
        assert!(!persisted.contains("\"open\""));
    }
}

#[tokio::test]
async fn screenshot_search_requires_period_before_creating_any_job() {
    let (s, owner, _tmp) = setup().await;
    let attachment = Uuid::new_v4();
    let before: i64 = sqlx::query_scalar("SELECT count(*) FROM jobs WHERE owner_id=$1")
        .bind(owner)
        .fetch_one(&s.db.pool)
        .await
        .unwrap();
    for scope in ["private", "binance_history"] {
        for period in [
            None,
            Some(json!(null)),
            Some(json!("")),
            Some(json!(" ")),
            // 2h 现在是受支持的周期了；这里要的是一个币安根本没有的周期。
            Some(json!("3h")),
        ] {
            let mut body = json!({"attachment_id":attachment,"scope":scope});
            if let Some(value) = period {
                body["interval"] = value;
            }
            let error = chart_search::create(
                &s,
                owner,
                "invalid-period",
                serde_json::from_value(body.clone()).unwrap(),
            )
            .await
            .unwrap_err();
            assert_eq!(
                error.code,
                if body["interval"] == "3h" {
                    "unsupported_interval"
                } else {
                    "chart_interval_required"
                }
            );
        }
    }
    for (input, public) in [
        (
            json!({"attachment_id":attachment,"model_id":"candle-geometry-v2"}),
            true,
        ),
        (
            json!({"attachment_id":attachment,"model_id":"hybrid-v2"}),
            false,
        ),
    ] {
        let error = if public {
            scorebook::application::history::search(
                &s,
                owner,
                "missing",
                serde_json::from_value(input).unwrap(),
            )
            .await
            .unwrap_err()
        } else {
            scorebook::application::similarity::search(
                &s,
                owner,
                "missing",
                serde_json::from_value(input).unwrap(),
            )
            .await
            .unwrap_err()
        };
        assert_eq!(error.code, "chart_interval_required");
    }
    let after: i64 = sqlx::query_scalar("SELECT count(*) FROM jobs WHERE owner_id=$1")
        .bind(owner)
        .fetch_one(&s.db.pool)
        .await
        .unwrap();
    assert_eq!(before, after);
}
