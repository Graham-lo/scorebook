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
            let seconds = match tf {
                "1d" => 86400,
                "4h" => 14400,
                "1h" => 3600,
                "15m" => 900,
                _ => 60,
            };
            let mut at = start;
            let mut bars = vec![];
            while at + Duration::seconds(seconds) <= end {
                bars.push(
                    json!({"start":at,"end":at+Duration::seconds(seconds),"open":"100","high":"101","low":"99","close":"100"}),
                );
                at += Duration::seconds(seconds);
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
    let good = json!({"ma":[20,50,200],"ema":[],"boll":{"n":20,"k":"2"},"atr":{"n":14}});
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

    let too_many = json!({"ma":[5,10,20,30,40],"ema":[60,120],"boll":null,"atr":null});
    assert_eq!(
        replay::put_chart_setup(
            &s,
            o,
            id,
            Some("setup-2"),
            serde_json::from_value(too_many).unwrap()
        )
        .await
        .unwrap_err()
        .code,
        "chart_setup_too_many_lines"
    );
    let out_of_range = json!({"ma":[0],"ema":[],"boll":null,"atr":null});
    assert_eq!(
        replay::put_chart_setup(
            &s,
            o,
            id,
            Some("setup-3"),
            serde_json::from_value(out_of_range).unwrap()
        )
        .await
        .unwrap_err()
        .code,
        "invalid_chart_setup_period"
    );
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

    let v = replay::get(&s, o, id).await.unwrap();
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
    let v = replay::get(&s, o, id).await.unwrap();
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
    let v = replay::get(&s, o, id).await.unwrap();
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

    let first = replay::get(&s, o, id).await.unwrap();
    assert_eq!(market.klines.load(Ordering::SeqCst), 1);
    assert!(bar_rows(&s).await > 0);
    let second = replay::get(&s, o, id).await.unwrap();
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
    replay::get(&s, o, id).await.unwrap();
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

    let v = replay::get(&s, o, id).await.unwrap();
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
        replay::get(&s, o, id).await.unwrap_err().code,
        "replay_interval_unsupported"
    );
    let mut bare = call_body(json!([]));
    bare.instrument = None;
    let saved = calls::create(&s, o, "bare", bare).await.unwrap();
    let id: Uuid = serde_json::from_value(saved["id"].clone()).unwrap();
    assert_eq!(
        replay::get(&s, o, id).await.unwrap_err().code,
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
