//! Relive/replay: the stage window, its expiring bar cache and the permanent
//! screenshot locations. Real PostgreSQL, a recording market double, and no
//! outcome/attachment/record row is ever written or removed by these paths.
mod common;
use axum::{body::Body, http::Request};
use chrono::{DateTime, Duration, Utc};
use http_body_util::BodyExt;
use scorebook::{
    adapters::{db::Database, storage::Storage, vision::Vision},
    application::{Services, calls, dto::*, ports::MarketDataProvider, replay},
};
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use tower::ServiceExt;
use uuid::Uuid;

async fn setup() -> (Services, Uuid, String, tempfile::TempDir) {
    let db = Database::connect(&common::test_db_url()).await.unwrap();
    db.migrate().await.unwrap();
    let (o, t) = db.create_user("replay-test").await.unwrap();
    let dir = tempfile::tempdir().unwrap();
    (
        Services::new(db.clone(), Storage::new(dir.path()), Vision::new(None)).unwrap(),
        o,
        t,
        dir,
    )
}

/// Contiguous synthetic bars, counted, so a second replay proves it never asked
/// the exchange again.
struct Recorder {
    klines: AtomicUsize,
    trades: AtomicUsize,
    price: String,
}
impl Recorder {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            klines: AtomicUsize::new(0),
            trades: AtomicUsize::new(0),
            price: "100".into(),
        })
    }
}
impl MarketDataProvider for Recorder {
    fn tickers_24h<'a>(&'a self, _: &'a str) -> scorebook_core::market::ProviderFuture<'a> {
        Box::pin(async { unreachable!("replay never ranks instruments") })
    }
    fn klines<'a>(
        &'a self,
        _: &'a str,
        _: &'a str,
        tf: &'a str,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    ) -> scorebook::application::ports::ProviderFuture<'a> {
        self.klines.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move {
            // 周期表只有 domain::interval 一份，测试替身也走它，月线才会按日历走。
            let iv = scorebook_core::domain::interval::Interval::exact(tf).unwrap();
            let mut at = start;
            let mut bars = vec![];
            while iv.add_bars(at, 1) <= end {
                let to = iv.add_bars(at, 1);
                bars.push(
                    json!({"start":at,"end":to,"open":"100","high":"101","low":"99","close":"100","volume":"12.5"}),
                );
                at = to;
            }
            Ok(json!({"bars":bars,"coverage_complete":true}))
        })
    }
    fn trades<'a>(
        &'a self,
        _: &'a str,
        _: &'a str,
        _: DateTime<Utc>,
        end: DateTime<Utc>,
    ) -> scorebook::application::ports::ProviderFuture<'a> {
        self.trades.fetch_add(1, Ordering::SeqCst);
        let price = self.price.clone();
        Box::pin(async move {
            Ok(
                json!({"raw":[{"a":1,"T":end.timestamp_millis()-1000,"p":price}],"coverage_complete":true}),
            )
        })
    }
    fn exchange_info<'a>(
        &'a self,
        _: &'a str,
    ) -> scorebook::application::ports::ProviderFuture<'a> {
        Box::pin(async { unreachable!("replay never reads the catalog") })
    }
}

fn call_body(criteria: Value) -> CreateCall {
    serde_json::from_value(
        json!({"original_text":"重温测试记录","instrument":"BTCUSDT","market":"usd_m","timeframe":"1h","criteria":criteria}),
    )
    .unwrap()
}
fn png() -> Vec<u8> {
    let mut b = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
        64,
        64,
        image::Rgb([240, 240, 240]),
    ))
    .write_to(&mut b, image::ImageFormat::Png)
    .unwrap();
    b.into_inner()
}
fn location(start: DateTime<Utc>, end: DateTime<Utc>) -> Value {
    json!({"symbol":"BTCUSDT","market":"usd_m","interval":"1h","start_at":start,"end_at":end,"source":"rest","score":"0.94"})
}
/// 默认就是 full 模式：契约里 bars 不给就等于给 full。
fn full() -> scorebook_core::api::replay::ReplayQuery {
    Default::default()
}
fn mode(v: &str) -> scorebook_core::api::replay::ReplayQuery {
    serde_json::from_value(json!({ "bars": v })).unwrap()
}
async fn bar_rows(s: &Services) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM replay_bars")
        .fetch_one(&s.db.pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn location_is_permanent_owner_scoped_and_visible_on_the_record() {
    let (s, o, _, _tmp) = setup().await;
    let a = calls::upload(&s, o, "img", png(), "scene".into(), None)
        .await
        .unwrap();
    let aid: Uuid = serde_json::from_value(a["id"].clone()).unwrap();
    let mut c = call_body(json!([]));
    c.attachments = vec![aid];
    let saved = calls::create(&s, o, "call", c).await.unwrap();
    let id: Uuid = serde_json::from_value(saved["id"].clone()).unwrap();

    let now = Utc::now();
    let row = replay::put_location(
        &s,
        o,
        aid,
        Some("loc-1"),
        serde_json::from_value(location(now - Duration::hours(200), now)).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(row["symbol"], "BTCUSDT");
    assert_eq!(row["score"], "0.94");
    assert!(row.get("owner_id").is_none());

    let record = calls::get(&s, o, id).await.unwrap();
    assert_eq!(record["attachments"][0]["location"]["interval"], "1h");

    // A second owner cannot read, overwrite or delete another owner's location.
    let (other, _) = s.db.create_user("replay-other").await.unwrap();
    assert!(
        replay::put_location(
            &s,
            other,
            aid,
            Some("loc-1"),
            serde_json::from_value(location(now - Duration::hours(10), now)).unwrap(),
        )
        .await
        .is_err()
    );
    assert_eq!(
        replay::delete_location(&s, other, aid, Some("del-1"))
            .await
            .unwrap()["deleted"],
        0
    );
    assert_eq!(
        calls::get(&s, o, id).await.unwrap()["attachments"][0]["location"]["symbol"],
        "BTCUSDT"
    );

    assert_eq!(
        replay::delete_location(&s, o, aid, Some("del-2"))
            .await
            .unwrap()["deleted"],
        1
    );
    assert!(calls::get(&s, o, id).await.unwrap()["attachments"][0]["location"].is_null());
}

#[tokio::test]
async fn chart_setup_is_shape_checked_and_returned_with_the_record() {
    let (s, o, _, _tmp) = setup().await;
    let saved = calls::create(&s, o, "call", call_body(json!([])))
        .await
        .unwrap();
    let id: Uuid = serde_json::from_value(saved["id"].clone()).unwrap();
    // 截图上真正画着的那一套：MA30/120/256、VOL+MAVOL、MACD(10,30,9)。
    let good = json!({"ma":[30,120,256],"ema":[],"boll":{"n":20,"k":"2"},"atr":{"n":14},
        "volume":{"ma":[5,10,30,60,120]},"macd":{"fast":10,"slow":30,"signal":9},"rsi":{"n":14}});
    let v = replay::put_chart_setup(
        &s,
        o,
        id,
        Some("setup-1"),
        serde_json::from_value(good.clone()).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(v["body"], good);
    assert_eq!(calls::get(&s, o, id).await.unwrap()["chart_setup"], good);

    // 老的四字段 body 还得能解出来，解出来的新字段是 null/空。
    let old: scorebook_core::api::replay::ChartSetup =
        serde_json::from_value(json!({"ma":[20],"ema":[],"boll":null,"atr":null})).unwrap();
    assert!(old.volume.is_none() && old.macd.is_none() && old.rsi.is_none());
    let stored = replay::put_chart_setup(&s, o, id, Some("setup-old"), old)
        .await
        .unwrap();
    assert_eq!(stored["body"]["ma"], json!([20]));
    assert_eq!(stored["body"]["volume"], Value::Null);

    // 主图均线上限从 6 抬到 8：7 条现在是允许的，9 条还是太多。
    let seven = json!({"ma":[5,10,20,30,40],"ema":[60,120]});
    assert!(
        replay::put_chart_setup(
            &s,
            o,
            id,
            Some("setup-7"),
            serde_json::from_value(seven).unwrap()
        )
        .await
        .is_ok()
    );
    for (key, body, code) in [
        (
            "setup-9",
            json!({"ma":[5,10,20,30,40,50],"ema":[60,120,240]}),
            "chart_setup_too_many_lines",
        ),
        (
            "setup-vol",
            json!({"volume":{"ma":[5,10,20,30,60,120,240]}}),
            "chart_setup_too_many_lines",
        ),
        (
            "setup-range",
            json!({"ma":[0],"ema":[],"boll":null,"atr":null}),
            "invalid_chart_setup_period",
        ),
        (
            "setup-volrange",
            json!({"volume":{"ma":[501]}}),
            "invalid_chart_setup_period",
        ),
        (
            "setup-macd",
            json!({"macd":{"fast":30,"slow":10,"signal":9}}),
            "invalid_chart_setup_macd",
        ),
        (
            "setup-macd-eq",
            json!({"macd":{"fast":12,"slow":12,"signal":9}}),
            "invalid_chart_setup_macd",
        ),
        (
            "setup-rsi",
            json!({"rsi":{"n":0}}),
            "invalid_chart_setup_period",
        ),
    ] {
        assert_eq!(
            replay::put_chart_setup(&s, o, id, Some(key), serde_json::from_value(body).unwrap())
                .await
                .unwrap_err()
                .code,
            code
        );
    }
    // A shape the backend does not know is refused before it can reach the page.
    assert!(
        serde_json::from_value::<scorebook_core::api::replay::ChartSetup>(
            json!({"ma":[20],"ema":[],"boll":null,"atr":null,"vwap":true})
        )
        .is_err()
    );
}

#[tokio::test]
async fn window_opens_at_the_location_and_otherwise_120_bars_before_the_judgment() {
    let (s, o, _, _tmp) = setup().await;
    let s = s.with_market(Recorder::new());
    let a = calls::upload(&s, o, "img", png(), "scene".into(), None)
        .await
        .unwrap();
    let aid: Uuid = serde_json::from_value(a["id"].clone()).unwrap();
    let mut c = call_body(json!([]));
    c.attachments = vec![aid];
    let saved = calls::create(&s, o, "call", c).await.unwrap();
    let id: Uuid = serde_json::from_value(saved["id"].clone()).unwrap();

    let v = replay::get(&s, o, id, full()).await.unwrap();
    assert_eq!(v["window"]["bars_before"], 120);
    assert_eq!(v["window"]["truncated"], false);
    assert_eq!(v["source"], "rest");
    assert_eq!(
        v["storage_policy"].as_str().unwrap().split(';').next(),
        Some("temporary")
    );
    let judgment: DateTime<Utc> = serde_json::from_value(v["judgment"]["at"].clone()).unwrap();
    let start: DateTime<Utc> = serde_json::from_value(v["window"]["start_at"].clone()).unwrap();
    assert!((judgment - start).num_hours() >= 120);
    assert!(!v["bars"].as_array().unwrap().is_empty());

    // A pinned screenshot decides where the stage opens instead.
    let pinned = judgment - Duration::hours(300);
    replay::put_location(
        &s,
        o,
        aid,
        Some("loc-1"),
        serde_json::from_value(location(pinned, judgment)).unwrap(),
    )
    .await
    .unwrap();
    let v = replay::get(&s, o, id, full()).await.unwrap();
    let start: DateTime<Utc> = serde_json::from_value(v["window"]["start_at"].clone()).unwrap();
    assert_eq!(
        start.timestamp(),
        pinned.timestamp() - pinned.timestamp().rem_euclid(3600)
    );
    assert_eq!(v["window"]["bars_before"], 300);
    assert_eq!(v["window"]["truncated"], false);
}

#[tokio::test]
async fn a_window_wider_than_2000_bars_is_truncated_at_the_end() {
    let (s, o, _, _tmp) = setup().await;
    let s = s.with_market(Recorder::new());
    let a = calls::upload(&s, o, "img", png(), "scene".into(), None)
        .await
        .unwrap();
    let aid: Uuid = serde_json::from_value(a["id"].clone()).unwrap();
    let mut c = call_body(json!([]));
    c.attachments = vec![aid];
    let saved = calls::create(&s, o, "call", c).await.unwrap();
    let id: Uuid = serde_json::from_value(saved["id"].clone()).unwrap();
    let now = Utc::now();
    replay::put_location(
        &s,
        o,
        aid,
        Some("loc-1"),
        serde_json::from_value(location(now - Duration::hours(5000), now)).unwrap(),
    )
    .await
    .unwrap();
    let v = replay::get(&s, o, id, full()).await.unwrap();
    assert_eq!(v["window"]["truncated"], true);
    let start: DateTime<Utc> = serde_json::from_value(v["window"]["start_at"].clone()).unwrap();
    let end: DateTime<Utc> = serde_json::from_value(v["window"]["end_at"].clone()).unwrap();
    assert_eq!((end - start).num_hours(), 2000);
    assert_eq!(v["bars"].as_array().unwrap().len(), 2000);
    assert_eq!(v["window"]["coverage_complete"], true);
}

#[tokio::test]
async fn a_second_replay_is_served_from_the_cache_and_delete_empties_it() {
    let (s, o, _, _tmp) = setup().await;
    let market = Recorder::new();
    let s = s.with_market(market.clone());
    let saved = calls::create(&s, o, "call", call_body(json!([])))
        .await
        .unwrap();
    let id: Uuid = serde_json::from_value(saved["id"].clone()).unwrap();

    let first = replay::get(&s, o, id, full()).await.unwrap();
    assert_eq!(market.klines.load(Ordering::SeqCst), 1);
    assert!(bar_rows(&s).await > 0);
    let second = replay::get(&s, o, id, full()).await.unwrap();
    assert_eq!(
        market.klines.load(Ordering::SeqCst),
        1,
        "cached window refetched"
    );
    assert_eq!(first["bars"], second["bars"]);

    assert!(
        replay::clear(&s, o, id).await.unwrap()["deleted"]
            .as_u64()
            .unwrap()
            > 0
    );
    assert_eq!(bar_rows(&s).await, 0);
    // Nothing the user wrote was touched.
    assert_eq!(
        calls::get(&s, o, id).await.unwrap()["body"]["original_text"],
        "重温测试记录"
    );
}

#[tokio::test]
async fn expired_display_cache_is_swept() {
    let (s, o, _, _tmp) = setup().await;
    let s = s.with_market(Recorder::new());
    let saved = calls::create(&s, o, "call", call_body(json!([])))
        .await
        .unwrap();
    let id: Uuid = serde_json::from_value(saved["id"].clone()).unwrap();
    replay::get(&s, o, id, full()).await.unwrap();
    let live = bar_rows(&s).await;
    assert!(live > 0);
    assert_eq!(replay::sweep(&s).await.unwrap(), 0);
    sqlx::query("UPDATE replay_bars SET expires_at=now()-interval '1 hour'")
        .execute(&s.db.pool)
        .await
        .unwrap();
    assert_eq!(replay::sweep(&s).await.unwrap(), live as u64);
    assert_eq!(bar_rows(&s).await, 0);
}

#[tokio::test]
async fn levels_are_the_numbers_settlement_judges_against() {
    use scorebook_core::domain::criteria::{Bar, EvaluationInput, evaluate};
    let (s, o, _, _tmp) = setup().await;
    let s = s.with_market(Recorder::new());
    let criteria = json!([{"template":"T1","selected_by":"explicit","direction":"L","horizon_hours":4,"threshold_ratio":"0.02"}]);
    let saved = calls::create(&s, o, "call", call_body(criteria.clone()))
        .await
        .unwrap();
    let id: Uuid = serde_json::from_value(saved["id"].clone()).unwrap();
    // The settlement job freezes submission_base; it then waits for closed bars.
    let j = scorebook::application::jobs::claim_for(&s, Some(o))
        .await
        .unwrap()
        .unwrap();
    let _ = scorebook::application::settlement::settle(&s, &j).await;

    let v = replay::get(&s, o, id, full()).await.unwrap();
    assert_eq!(v["judgment"]["base_price"], "100");
    assert_eq!(v["levels"]["template"], "T1");
    assert_eq!(v["levels"]["threshold_abs"], "2");
    assert_eq!(v["levels"]["target_price"], "102");
    let judgment: DateTime<Utc> = serde_json::from_value(v["judgment"]["at"].clone()).unwrap();
    let horizon: DateTime<Utc> =
        serde_json::from_value(v["levels"]["horizon_end_at"].clone()).unwrap();
    assert_eq!((horizon - judgment).num_hours(), 4);

    // The drawn line is exactly where evaluate starts calling it reached.
    let c = serde_json::from_value(criteria[0].clone()).unwrap();
    let touch = |high: &str| {
        evaluate(&EvaluationInput {
            criteria: serde_json::from_value(criteria[0].clone()).unwrap(),
            start: judgment,
            evaluated_at: judgment + Duration::hours(4),
            base: Some("100".into()),
            atr0: None,
            bars: vec![Bar {
                start: judgment,
                end: judgment + Duration::hours(1),
                open: "100".into(),
                high: high.into(),
                low: "100".into(),
                close: "100".into(),
                volume: None,
            }],
            trades: vec![],
            coverage_complete: true,
            endpoint_proven: true,
            end_price: Some("100".into()),
        })
        .first_threshold_interval
        .is_some()
    };
    let _: scorebook_core::domain::criteria::Criteria = c;
    assert!(touch("102"));
    assert!(!touch("101.999"));
}

/// 判断时刻前 120 根 / 2000 根封顶的窗口算术，对新周期同样成立：30m 是用户的真实
/// 场景，1w 必须开在周一，1M 必须按日历月。
#[tokio::test]
async fn the_stage_window_is_counted_in_bars_for_every_interval() {
    let (s, o, _, _tmp) = setup().await;
    let s = s.with_market(Recorder::new());
    for iv in scorebook_core::domain::interval::ALL {
        let mut body = call_body(json!([]));
        body.timeframe = Some(iv.as_str().into());
        let saved = calls::create(&s, o, &format!("tf-{}", iv.as_str()), body)
            .await
            .unwrap();
        let id: Uuid = serde_json::from_value(saved["id"].clone()).unwrap();
        let v = replay::get(&s, o, id, full()).await.unwrap();
        assert_eq!(v["interval"], iv.as_str());
        let start: DateTime<Utc> = serde_json::from_value(v["window"]["start_at"].clone()).unwrap();
        let end: DateTime<Utc> = serde_json::from_value(v["window"]["end_at"].clone()).unwrap();
        // 起点终点都落在本周期的开盘时刻上。
        assert_eq!(iv.floor(start), start, "{} start", iv.as_str());
        assert_eq!(iv.floor(end), end, "{} end", iv.as_str());
        if iv == scorebook_core::domain::interval::Interval::W1 {
            assert_eq!(start.format("%u").to_string(), "1", "周线必须开在周一 UTC");
        }
        if iv == scorebook_core::domain::interval::Interval::Mo1 {
            assert_eq!(start.format("%d %H:%M").to_string(), "01 00:00");
        }
        // 判断时刻前 120 根，未来的部分按 min(now, ...) 截断，所以只断言不超过。
        let before = v["window"]["bars_before"].as_i64().unwrap();
        assert_eq!(before, 120, "{} bars_before", iv.as_str());
        assert!(iv.bars_between(start, end) <= 2000, "{}", iv.as_str());
    }
}

#[tokio::test]
async fn replay_refuses_what_it_cannot_draw() {
    let (s, o, _, _tmp) = setup().await;
    let s = s.with_market(Recorder::new());
    let before = bar_rows(&s).await;
    let mut odd = call_body(json!([]));
    odd.timeframe = Some("3h".into());
    let saved = calls::create(&s, o, "odd", odd).await.unwrap();
    let id: Uuid = serde_json::from_value(saved["id"].clone()).unwrap();
    assert_eq!(
        replay::get(&s, o, id, full()).await.unwrap_err().code,
        "replay_interval_unsupported"
    );
    let mut bare = call_body(json!([]));
    bare.instrument = None;
    let saved = calls::create(&s, o, "bare", bare).await.unwrap();
    let id: Uuid = serde_json::from_value(saved["id"].clone()).unwrap();
    assert_eq!(
        replay::get(&s, o, id, full()).await.unwrap_err().code,
        "replay_needs_instrument"
    );
    // A refused replay writes nothing at all.
    assert_eq!(bar_rows(&s).await, before);
}

#[tokio::test]
async fn the_four_routes_are_wired_and_owner_isolated() {
    let (s, o, token, _tmp) = setup().await;
    let s = s.with_market(Recorder::new());
    let a = calls::upload(&s, o, "img", png(), "scene".into(), None)
        .await
        .unwrap();
    let aid: Uuid = serde_json::from_value(a["id"].clone()).unwrap();
    let mut c = call_body(json!([]));
    c.attachments = vec![aid];
    let saved = calls::create(&s, o, "call", c).await.unwrap();
    let id: Uuid = serde_json::from_value(saved["id"].clone()).unwrap();
    let (_, intruder) = s.db.create_user("replay-intruder").await.unwrap();
    let app = scorebook::http::router(s.clone());

    let send = |method: &str, uri: String, token: String, body: Option<Value>| {
        let app = app.clone();
        let method = method.to_string();
        async move {
            let mut b = Request::builder()
                .uri(uri)
                .method(method.as_str())
                .header("Authorization", format!("Bearer {token}"));
            if body.is_some() {
                b = b.header("Content-Type", "application/json");
            }
            let request = match &body {
                Some(v) => b.body(Body::from(v.to_string())).unwrap(),
                None => b.body(Body::empty()).unwrap(),
            };
            let r = app.oneshot(request).await.unwrap();
            let status = r.status().as_u16();
            let bytes = r.into_body().collect().await.unwrap().to_bytes();
            let v: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
            (status, v)
        }
    };
    let now = Utc::now();
    let (status, _) = send(
        "PUT",
        format!("/v1/attachments/{aid}/location"),
        token.clone(),
        Some(location(now - Duration::hours(150), now)),
    )
    .await;
    assert_eq!(status, 200);
    let (status, _) = send(
        "PUT",
        format!("/v1/calls/{id}/chart-setup"),
        token.clone(),
        Some(json!({"ma":[20],"ema":[],"boll":null,"atr":null})),
    )
    .await;
    assert_eq!(status, 200);
    let (status, v) = send("GET", format!("/v1/calls/{id}/replay"), token.clone(), None).await;
    assert_eq!(status, 200);
    assert_eq!(v["data"]["call_id"], json!(id));
    assert!(bar_rows(&s).await > 0);

    // Another owner sees neither the record nor its cached window.
    let (status, _) = send(
        "GET",
        format!("/v1/calls/{id}/replay"),
        intruder.clone(),
        None,
    )
    .await;
    assert_eq!(status, 404);
    let (status, _) = send("DELETE", format!("/v1/calls/{id}/replay"), intruder, None).await;
    assert_eq!(status, 404);
    assert!(bar_rows(&s).await > 0);

    let (status, _) = send(
        "DELETE",
        format!("/v1/calls/{id}/replay"),
        token.clone(),
        None,
    )
    .await;
    assert_eq!(status, 204);
    assert_eq!(bar_rows(&s).await, 0);
    let (status, _) = send(
        "DELETE",
        format!("/v1/attachments/{aid}/location"),
        token,
        None,
    )
    .await;
    assert_eq!(status, 204);
}

/// 前端能自己直连币安拉 K 线时，后端只交代舞台的坐标：不取数、不落缓存、
/// 也不给已有缓存续命。拉不到再回来要 full。
#[tokio::test]
async fn bars_none_returns_the_stage_without_touching_the_exchange() {
    let (s, o, _, _tmp) = setup().await;
    let market = Recorder::new();
    let s = s.with_market(market.clone());
    let saved = calls::create(&s, o, "call", call_body(json!([])))
        .await
        .unwrap();
    let id: Uuid = serde_json::from_value(saved["id"].clone()).unwrap();
    // K 线缓存是按合约存的公共数据，不分账户：别的用例留下的窗口不该算在这里。
    sqlx::query("DELETE FROM replay_bars")
        .execute(&s.db.pool)
        .await
        .unwrap();

    let meta = replay::get(&s, o, id, mode("none")).await.unwrap();
    assert_eq!(market.klines.load(Ordering::SeqCst), 0);
    assert_eq!(bar_rows(&s).await, 0);
    assert_eq!(meta["bars_included"], false);
    assert_eq!(meta["bars"], json!([]));
    // 前端要靠这四样自己去拉：品种、市场、周期、窗口。
    assert_eq!(meta["symbol"], "BTCUSDT");
    assert_eq!(meta["market"], "usd_m");
    assert_eq!(meta["interval"], "1h");
    assert!(meta["window"]["start_at"].is_string());
    assert!(meta["window"]["end_at"].is_string());
    // 一根都没缓存，所以覆盖度只能是不完整。
    assert_eq!(meta["window"]["coverage_complete"], false);
    assert!(meta["levels"].is_object());
    assert!(meta["judgment"]["at"].is_string());
    assert!(
        meta["storage_policy"]
            .as_str()
            .unwrap()
            .contains("expires_at")
    );

    // 无法理解的取值当场拒绝，不去猜前端想要什么。
    assert_eq!(
        replay::get(&s, o, id, mode("1h")).await.unwrap_err().code,
        "invalid_bars_mode"
    );

    let full_view = replay::get(&s, o, id, full()).await.unwrap();
    assert_eq!(full_view["bars_included"], true);
    assert!(!full_view["bars"].as_array().unwrap().is_empty());
    assert_eq!(full_view["window"]["coverage_complete"], true);
    assert_eq!(market.klines.load(Ordering::SeqCst), 1);
    let cached = bar_rows(&s).await;
    assert!(cached > 0);

    // 缓存已经在了，none 模式照样不续命也不重取。
    sqlx::query("UPDATE replay_bars SET expires_at=now()+interval '1 hour'")
        .execute(&s.db.pool)
        .await
        .unwrap();
    let again = replay::get(&s, o, id, mode("none")).await.unwrap();
    assert_eq!(again["bars"], json!([]));
    assert_eq!(again["bars_included"], false);
    // 缓存齐了，窗口覆盖度就按缓存算出来是完整的。
    assert_eq!(again["window"]["coverage_complete"], true);
    assert_eq!(market.klines.load(Ordering::SeqCst), 1);
    let hours: f64 = sqlx::query_scalar(
        "SELECT (EXTRACT(EPOCH FROM max(expires_at)-now())/3600)::float8 FROM replay_bars",
    )
    .fetch_one(&s.db.pool)
    .await
    .unwrap();
    assert!(hours < 2.0, "metadata-only read renewed the cache: {hours}");
    // full 模式才续命。
    replay::get(&s, o, id, full()).await.unwrap();
    let hours: f64 = sqlx::query_scalar(
        "SELECT (EXTRACT(EPOCH FROM max(expires_at)-now())/3600)::float8 FROM replay_bars",
    )
    .fetch_one(&s.db.pool)
    .await
    .unwrap();
    assert!(hours > 23.0);
    assert_eq!(bar_rows(&s).await, cached);
    replay::clear(&s, o, id).await.unwrap();
}

/// VOL 副图要的成交量：来源填上、缓存存下、再取出来还在。判决从不读它。
#[tokio::test]
async fn replay_bars_carry_volume_through_the_cache() {
    let (s, o, _, _tmp) = setup().await;
    let s = s.with_market(Recorder::new());
    let saved = calls::create(&s, o, "call", call_body(json!([])))
        .await
        .unwrap();
    let id: Uuid = serde_json::from_value(saved["id"].clone()).unwrap();

    sqlx::query("DELETE FROM replay_bars")
        .execute(&s.db.pool)
        .await
        .unwrap();
    let first = replay::get(&s, o, id, full()).await.unwrap();
    assert_eq!(first["bars"][0]["volume"], "12.5");
    let stored: Option<String> =
        sqlx::query_scalar("SELECT volume FROM replay_bars ORDER BY bar_start LIMIT 1")
            .fetch_one(&s.db.pool)
            .await
            .unwrap();
    assert_eq!(stored.as_deref(), Some("12.5"));
    // 第二次完全走缓存，量还在。
    let second = replay::get(&s, o, id, full()).await.unwrap();
    assert_eq!(second["bars"], first["bars"]);

    // 旧缓存行没有量：读出来是 null，不是报错。
    sqlx::query("UPDATE replay_bars SET volume=NULL")
        .execute(&s.db.pool)
        .await
        .unwrap();
    let legacy = replay::get(&s, o, id, full()).await.unwrap();
    assert_eq!(legacy["bars"][0]["volume"], Value::Null);
    replay::clear(&s, o, id).await.unwrap();
}

/// 归档 CSV 的第六列就是成交量，解析时一并带出来。
#[test]
fn monthly_archive_rows_carry_volume() {
    use std::io::Write;
    let csv = "1704067200000,100,101,99,100,7.5,1704070799999,750,10,4,400,0\n";
    let mut zipped = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    zipped
        .start_file::<_, ()>(
            "BTCUSDT-1h-2024-01.csv",
            zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
    zipped.write_all(csv.as_bytes()).unwrap();
    let bytes = zipped.finish().unwrap().into_inner();
    let start = DateTime::from_timestamp(1704067200, 0).unwrap();
    let bars = scorebook::adapters::binance_archive::parse_klines(
        bytes,
        start,
        start + Duration::hours(1),
    )
    .unwrap();
    assert_eq!(bars.len(), 1);
    assert_eq!(bars[0].volume.as_deref(), Some("7.5"));
    assert_eq!(bars[0].close, "100");
}

/// 同板块对比图上传时按 scene 传了，事后改成 reference：只动 kind 这一列，
/// 已经钉住的位置原样留着，也不会因此引出一次自动定位。
#[tokio::test]
async fn attachment_kind_can_be_corrected_after_upload() {
    use scorebook::application::attachments;
    let (s, o, _, _tmp) = setup().await;
    let a = calls::upload(&s, o, "img", png(), "scene".into(), None)
        .await
        .unwrap();
    let aid: Uuid = serde_json::from_value(a["id"].clone()).unwrap();
    let mut c = call_body(json!([]));
    c.attachments = vec![aid];
    let saved = calls::create(&s, o, "call", c).await.unwrap();
    let id: Uuid = serde_json::from_value(saved["id"].clone()).unwrap();
    let now = Utc::now();
    replay::put_location(
        &s,
        o,
        aid,
        Some("loc-1"),
        serde_json::from_value(location(now - Duration::hours(64), now)).unwrap(),
    )
    .await
    .unwrap();

    let jobs_before: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM jobs WHERE owner_id=$1 AND kind='attachment.locate'",
    )
    .bind(o)
    .fetch_one(&s.db.pool)
    .await
    .unwrap();
    let row = attachments::set_kind(
        &s,
        o,
        aid,
        Some("kind-1"),
        serde_json::from_value(json!({"kind":"reference"})).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(row["kind"], "reference");
    assert_eq!(row["id"], json!(aid));
    assert!(row.get("owner_id").is_none());
    // 位置是图自己的事实，跟它派什么用场无关。
    assert_eq!(row["location"]["symbol"], "BTCUSDT");
    let record = calls::get(&s, o, id).await.unwrap();
    assert_eq!(record["attachments"][0]["kind"], "reference");
    assert_eq!(record["attachments"][0]["location"]["symbol"], "BTCUSDT");

    // 改回 scene 也不会引出一次自动定位。
    attachments::set_kind(
        &s,
        o,
        aid,
        Some("kind-2"),
        serde_json::from_value(json!({"kind":"scene"})).unwrap(),
    )
    .await
    .unwrap();
    let jobs_after: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM jobs WHERE owner_id=$1 AND kind='attachment.locate'",
    )
    .bind(o)
    .fetch_one(&s.db.pool)
    .await
    .unwrap();
    assert_eq!(jobs_before, jobs_after);

    // 能改的只有用途：字节、哈希、尺寸这些证据照旧一格都动不得。
    for statement in [
        "UPDATE attachments SET sha256='0' WHERE id=$1",
        "UPDATE attachments SET size=1 WHERE id=$1",
        "UPDATE attachments SET kind='query' WHERE id=$1",
    ] {
        assert!(
            sqlx::query(statement)
                .bind(aid)
                .execute(&s.db.pool)
                .await
                .is_err(),
            "{statement}"
        );
    }

    // 认不得的用途拒收；别人的图看不见。
    assert_eq!(
        attachments::set_kind(
            &s,
            o,
            aid,
            Some("kind-3"),
            serde_json::from_value(json!({"kind":"chart"})).unwrap()
        )
        .await
        .unwrap_err()
        .code,
        "invalid_kind"
    );
    let (other, _) = s.db.create_user("kind-other").await.unwrap();
    assert!(
        attachments::set_kind(
            &s,
            other,
            aid,
            Some("kind-4"),
            serde_json::from_value(json!({"kind":"reference"})).unwrap()
        )
        .await
        .is_err()
    );
    assert!(
        attachments::set_kind(
            &s,
            o,
            Uuid::new_v4(),
            Some("kind-5"),
            serde_json::from_value(json!({"kind":"reference"})).unwrap()
        )
        .await
        .is_err()
    );
}

#[tokio::test]
async fn location_preview_is_owner_scoped_and_does_not_pin_or_change_preferences() {
    let (s, owner, _, _tmp) = setup().await;
    let s = s.with_market(Recorder::new());
    let uploaded = calls::upload(&s, owner, "preview-image", png(), "scene".into(), None)
        .await
        .unwrap();
    let attachment: Uuid = serde_json::from_value(uploaded["id"].clone()).unwrap();
    let input = json!({"symbol":"BTCUSDT","market":"usd_m","interval":"1h",
        "end_at":"2026-09-09T13:00:00Z","bars_count":109});
    let result = replay::preview_location(
        &s,
        owner,
        attachment,
        serde_json::from_value(input.clone()).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(result["start_at"], "2026-09-05T00:00:00Z");
    assert_eq!(result["preview"]["bars"].as_array().unwrap().len(), 109);
    assert!(result.get("confirmed_at").is_none());
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM attachment_locations WHERE owner_id=$1")
            .bind(owner)
            .fetch_one(&s.db.pool)
            .await
            .unwrap();
    assert_eq!(count, 0);
    let prefs: i64 = sqlx::query_scalar("SELECT count(*) FROM user_preferences WHERE owner_id=$1")
        .bind(owner)
        .fetch_one(&s.db.pool)
        .await
        .unwrap();
    assert_eq!(prefs, 0);
    let (other, _) = s.db.create_user("preview-other").await.unwrap();
    assert!(
        replay::preview_location(
            &s,
            other,
            attachment,
            serde_json::from_value(input).unwrap()
        )
        .await
        .is_err()
    );
}
