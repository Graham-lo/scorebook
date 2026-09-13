//! Isolated PostgreSQL and deterministic provider observations; no exchange calls.
mod common;
use axum::{body::Body, http::Request};
use chrono::{DateTime, Duration, Utc};
use http_body_util::BodyExt;
use scorebook::{
    adapters::{db::Database, storage::Storage, vision::Vision},
    application::{Services, calls, market, replay},
};
use scorebook_core::{
    api::market::MarketBoundsQuery,
    domain::{chart::ChartRequest, criteria::Bar},
    market::{MarketDataProvider, ProviderFuture},
};
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use tower::ServiceExt;
use uuid::Uuid;

struct Fixture {
    value: Value,
    calls: AtomicUsize,
}
impl MarketDataProvider for Fixture {
    fn klines<'a>(
        &'a self,
        _: &'a str,
        _: &'a str,
        _: &'a str,
        _: DateTime<Utc>,
        _: DateTime<Utc>,
    ) -> ProviderFuture<'a> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Ok(self.value.clone()) })
    }
    fn trades<'a>(
        &'a self,
        _: &'a str,
        _: &'a str,
        _: DateTime<Utc>,
        _: DateTime<Utc>,
    ) -> ProviderFuture<'a> {
        panic!("bounds must never request trades")
    }
    fn exchange_info<'a>(&'a self, _: &'a str) -> ProviderFuture<'a> {
        panic!("bounds must use the local catalog")
    }
    fn tickers_24h<'a>(&'a self, _: &'a str) -> ProviderFuture<'a> {
        panic!("bounds must never request tickers")
    }
}
async fn setup() -> (Services, Uuid, String, tempfile::TempDir, ChartRequest) {
    let db = Database::connect(&common::test_db_url()).await.unwrap();
    db.migrate().await.unwrap();
    let (owner, token) = db.create_user("bounds-test").await.unwrap();
    let dir = tempfile::tempdir().unwrap();
    let s = Services::new(db, Storage::new(dir.path()), Vision::new(None)).unwrap();
    let request: ChartRequest = serde_json::from_value(json!({
        "market":"usd_m", "symbol":format!("BOUNDS{}USDT",Uuid::new_v4().simple()).to_uppercase(),
        "interval":"1h", "start_at":at(0),"end_at":at(48)
    }))
    .unwrap();
    let version = Uuid::new_v4();
    sqlx::query("INSERT INTO public_market.catalog_versions(id,source,source_hash) VALUES($1,'bounds-test','test')")
        .bind(version).execute(&s.db.pool).await.unwrap();
    sqlx::query("INSERT INTO public_market.instrument_lifecycles(market,symbol,status,onboard_at,catalog_version) VALUES('usd_m',$1,'active',$2,$3)")
        .bind(&request.symbol).bind(at(5)).bind(version).execute(&s.db.pool).await.unwrap();
    (s, owner, token, dir, request)
}
fn at(hour: i64) -> DateTime<Utc> {
    "2024-01-01T00:00:00Z".parse::<DateTime<Utc>>().unwrap() + Duration::hours(hour)
}
fn bar(start: DateTime<Utc>) -> Bar {
    Bar {
        start,
        end: start + Duration::hours(1),
        open: "100".into(),
        high: "101".into(),
        low: "99".into(),
        close: "100".into(),
        volume: None,
    }
}
fn query(request: &ChartRequest) -> MarketBoundsQuery {
    MarketBoundsQuery {
        market: request.market.clone(),
        symbol: request.symbol.clone(),
        interval: request.interval.clone(),
    }
}
async fn observe(s: &Services, request: &ChartRequest, bars: Vec<Bar>, complete: bool) -> Value {
    let fixture = Arc::new(Fixture {
        value: json!({"bars":bars,"coverage_complete":complete}),
        calls: AtomicUsize::new(0),
    });
    let result = market::data(&s.clone().with_market(fixture.clone()), request)
        .await
        .unwrap();
    assert_eq!(
        fixture.calls.load(Ordering::SeqCst),
        1,
        "no extra provider request"
    );
    assert_eq!(result["storage_policy"], "ephemeral;not_persisted");
    market::bounds(s, &query(request)).await.unwrap()
}
fn timestamp(v: &Value) -> DateTime<Utc> {
    serde_json::from_value(v.clone()).unwrap()
}

#[tokio::test]
async fn first_only_moves_earlier_and_last_only_later() {
    let (s, _, _, _dir, request) = setup().await;
    observe(&s, &request, vec![bar(at(5)), bar(at(10))], false).await;
    let v = observe(&s, &request, vec![bar(at(7)), bar(at(8))], false).await;
    assert_eq!(timestamp(&v["first_bar_at"]), at(5));
    assert_eq!(timestamp(&v["last_bar_at"]), at(10));
    let v = observe(&s, &request, vec![bar(at(3)), bar(at(12))], false).await;
    assert_eq!(timestamp(&v["first_bar_at"]), at(3));
    assert_eq!(timestamp(&v["last_bar_at"]), at(12));
    let v = observe(&s, &request, vec![], false).await;
    assert_eq!(timestamp(&v["first_bar_at"]), at(3));
    assert_eq!(timestamp(&v["last_bar_at"]), at(12));
}

#[tokio::test]
async fn first_requires_incomplete_coverage_and_a_request_before_onboarding() {
    let (s, _, _, _dir, mut request) = setup().await;
    let v = observe(&s, &request, vec![bar(at(5))], true).await;
    assert!(v["first_bar_at"].is_null());
    request.start_at = at(5);
    let v = observe(&s, &request, vec![bar(at(7))], false).await;
    assert!(v["first_bar_at"].is_null());
    request.start_at = at(6);
    let v = observe(&s, &request, vec![bar(at(7))], false).await;
    assert!(v["first_bar_at"].is_null());
    sqlx::query("UPDATE public_market.instrument_lifecycles SET onboard_at=NULL WHERE symbol=$1")
        .bind(&request.symbol)
        .execute(&s.db.pool)
        .await
        .unwrap();
    let v = observe(&s, &request, vec![bar(at(6))], false).await;
    assert!(
        v["first_bar_at"].is_null(),
        "first must be strictly after requested start"
    );
    let v = observe(&s, &request, vec![bar(at(7))], false).await;
    assert_eq!(timestamp(&v["first_bar_at"]), at(7));
}

#[tokio::test]
async fn empty_response_does_not_establish_either_boundary() {
    let (s, _, _, _dir, request) = setup().await;
    let v = observe(&s, &request, vec![], false).await;
    assert!(v["first_bar_at"].is_null());
    assert!(v["last_bar_at"].is_null());
    assert_eq!(v["gaps"], json!([]));
}

#[tokio::test]
async fn last_excludes_all_unclosed_bars() {
    let (s, _, _, _dir, mut request) = setup().await;
    let now = Utc::now();
    request.start_at = now - Duration::hours(3);
    request.end_at = now + Duration::hours(3);
    let v = observe(&s, &request, vec![bar(now)], false).await;
    assert!(v["last_bar_at"].is_null());
    let v = observe(
        &s,
        &request,
        vec![
            bar(now - Duration::hours(2)),
            bar(now),
            bar(now + Duration::hours(1)),
        ],
        false,
    )
    .await;
    assert_eq!(timestamp(&v["last_bar_at"]), now - Duration::hours(2));
}

#[tokio::test]
async fn gaps_merge_adjacent_overlapping_nested_and_duplicate_observations() {
    let (s, _, _, _dir, request) = setup().await;
    observe(
        &s,
        &request,
        vec![bar(at(1)), bar(at(4)), bar(at(10)), bar(at(12))],
        false,
    )
    .await;
    // Duplicate observations refresh seen_at, without duplicating the gap.
    sqlx::query("UPDATE public_market.instrument_bounds SET gaps=(SELECT jsonb_agg(g || jsonb_build_object('seen_at','2000-01-01T00:00:00Z')) FROM jsonb_array_elements(gaps) g) WHERE symbol=$1")
        .bind(&request.symbol).execute(&s.db.pool).await.unwrap();
    let v = observe(&s, &request, vec![bar(at(1)), bar(at(4))], false).await;
    assert_eq!(v["gaps"].as_array().unwrap().len(), 3);
    assert!(timestamp(&v["gaps"][0]["seen_at"]) > at(0));
    // [4,6) touches [2,4), then overlaps [5,10); nested gap stays inside.
    observe(&s, &request, vec![bar(at(3)), bar(at(6))], false).await;
    let v = observe(&s, &request, vec![bar(at(2)), bar(at(5))], false).await;
    assert_eq!(v["gaps"].as_array().unwrap().len(), 2);
    assert_eq!(timestamp(&v["gaps"][0]["start"]), at(2));
    assert_eq!(timestamp(&v["gaps"][0]["end"]), at(10));
    assert_eq!(timestamp(&v["gaps"][1]["start"]), at(11));
    // coverage_complete=true never adds a gap, even if the fixture is inconsistent.
    let before = v["gaps"].clone();
    let v = observe(&s, &request, vec![bar(at(0)), bar(at(20))], true).await;
    assert_eq!(v["gaps"], before);
}

#[tokio::test]
async fn concurrent_observations_do_not_lose_boundaries_or_gaps() {
    let (s, _, _, _dir, request) = setup().await;
    let work = (0..8).map(|i| {
        let s = s.clone();
        let request = request.clone();
        async move {
            observe(
                &s,
                &request,
                vec![bar(at(i * 3 + 1)), bar(at(i * 3 + 3))],
                false,
            )
            .await
        }
    });
    futures_util::future::join_all(work).await;
    let v = market::bounds(&s, &query(&request)).await.unwrap();
    assert_eq!(timestamp(&v["first_bar_at"]), at(1));
    assert_eq!(timestamp(&v["last_bar_at"]), at(24));
    assert_eq!(v["gaps"].as_array().unwrap().len(), 8);
    for (i, g) in v["gaps"].as_array().unwrap().iter().enumerate() {
        assert_eq!(timestamp(&g["start"]), at(i as i64 * 3 + 2));
        assert_eq!(timestamp(&g["end"]), at(i as i64 * 3 + 3));
    }
}

#[tokio::test]
async fn failed_metadata_write_does_not_fail_market_data() {
    let (s, _, _, _dir, request) = setup().await;
    let fixture = Arc::new(Fixture {
        value: json!({"bars":[bar(at(5))],"coverage_complete":false}),
        calls: AtomicUsize::new(0),
    });
    let s = s.with_market(fixture);
    s.db.pool.close().await;
    let v = market::data(&s, &request).await.unwrap();
    assert_eq!(v["bars"].as_array().unwrap().len(), 1);
    assert_eq!(v["storage_policy"], "ephemeral;not_persisted");
}

async fn get(s: &Services, token: &str, path: &str) -> (u16, Value, String) {
    let response = scorebook::http::router(s.clone())
        .oneshot(
            Request::builder()
                .uri(path)
                .header("Authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status().as_u16();
    let cache = response.headers()["cache-control"]
        .to_str()
        .unwrap()
        .to_owned();
    let value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    (status, value, cache)
}

#[tokio::test]
async fn http_catalog_defaults_unknown_and_three_validation_codes() {
    let (s, _, token, _dir, request) = setup().await;
    let path = format!(
        "/v1/market/bounds?market=usd_m&symbol={}&interval=1h",
        request.symbol
    );
    let (status, v, cache) = get(&s, &token, &path).await;
    assert_eq!(status, 200);
    assert_eq!(cache, "private, max-age=60");
    let data = &v["data"];
    assert_eq!(data["status"], "active");
    assert_eq!(timestamp(&data["onboard_at"]), at(5));
    for key in ["delivery_at", "first_bar_at", "last_bar_at", "verified_at"] {
        assert!(data[key].is_null(), "{key}");
    }
    assert_eq!(data["gaps"], json!([]));
    assert!(
        (timestamp(&data["server_now"]) - Utc::now())
            .num_seconds()
            .abs()
            < 5
    );
    for (query, status, code) in [
        (
            "market=usd_m&symbol=UNKNOWNBOUNDS&interval=1h",
            404,
            "instrument_unknown",
        ),
        (
            "market=spot&symbol=BTCUSDT&interval=1h",
            422,
            "contract_market_required",
        ),
        (
            "symbol=BTCUSDT&interval=1h",
            422,
            "contract_market_required",
        ),
        (
            "market=usd_m&symbol=BTCUSDT&interval=2h-invalid",
            422,
            "unsupported_interval",
        ),
        ("market=usd_m&symbol=BTCUSDT", 422, "unsupported_interval"),
        ("market=usd_m&symbol=&interval=1h", 422, "symbol_required"),
        ("market=usd_m&interval=1h", 422, "symbol_required"),
        (
            "market=usd_m&symbol=%20%20&interval=1h",
            422,
            "symbol_required",
        ),
    ] {
        let (actual, v, cache) = get(&s, &token, &format!("/v1/market/bounds?{query}")).await;
        assert_eq!(actual, status, "{query}: {v}");
        assert_eq!(v["error"]["code"], code);
        assert_eq!(cache, "private, no-store");
    }
    // Monthly spelling is case-sensitive; every canonical interval is accepted.
    for iv in scorebook_core::domain::interval::Interval::ALL {
        let (status, _, _) = get(
            &s,
            &token,
            &path.replace("interval=1h", &format!("interval={}", iv.as_str())),
        )
        .await;
        assert_eq!(status, 200);
    }
}

#[tokio::test]
async fn bounds_requires_compute_permission_even_for_get() {
    let (s, owner, token, _dir, request) = setup().await;
    let path = format!(
        "/v1/market/bounds?market=usd_m&symbol={}&interval=1h",
        request.symbol
    );
    sqlx::query("UPDATE api_keys SET permissions=ARRAY['knowledge.read'] WHERE owner_id=$1")
        .bind(owner)
        .execute(&s.db.pool)
        .await
        .unwrap();
    let (status, v, _) = get(&s, &token, &path).await;
    assert_eq!(status, 403);
    assert_eq!(v["error"]["code"], "permission_required:search.compute");
    sqlx::query("UPDATE api_keys SET permissions=ARRAY['search.compute'] WHERE owner_id=$1")
        .bind(owner)
        .execute(&s.db.pool)
        .await
        .unwrap();
    assert_eq!(get(&s, &token, &path).await.0, 200);
    assert_eq!(get(&s, "invalid-token", &path).await.0, 401);
}

// Validate the types, required fields and formats of this route's actual responses.
fn validate(shape: &Value, value: &Value) {
    let kind = if value.is_null() {
        "null"
    } else if value.is_object() {
        "object"
    } else if value.is_array() {
        "array"
    } else if value.is_string() {
        "string"
    } else {
        panic!("unexpected value {value}")
    };
    if let Some(t) = shape.get("type") {
        assert!(
            t == kind || t.as_array().is_some_and(|a| a.contains(&json!(kind))),
            "{shape} does not match {value}"
        );
    }
    if let Some(required) = shape["required"].as_array() {
        for key in required {
            assert!(value.get(key.as_str().unwrap()).is_some());
        }
    }
    if let Some(props) = shape["properties"].as_object() {
        for (key, prop) in props {
            if let Some(v) = value.get(key) {
                validate(prop, v);
            }
        }
    }
    if let Some(items) = value.as_array() {
        for item in items {
            validate(&shape["items"], item);
        }
    }
    if shape["format"] == "date-time" && !value.is_null() {
        timestamp(value);
    }
    if let Some(choices) = shape["enum"].as_array() {
        assert!(choices.contains(value));
    }
}
#[tokio::test]
async fn bounds_request_and_live_shaped_responses_match_the_registered_contract() {
    let spec = scorebook_http::openapi();
    let op = &spec["paths"]["/v1/market/bounds"]["get"];
    assert_eq!(op["x-required-permission"], "search.compute");
    assert!(op.get("requestBody").is_none());
    let params = op["parameters"].as_array().unwrap();
    assert_eq!(params.len(), 3);
    for key in ["market", "symbol", "interval"] {
        let param = params.iter().find(|p| p["name"] == key).unwrap();
        assert_eq!(param["required"], true);
        assert_eq!(param["in"], "query");
        assert!(
            spec["components"]["schemas"]["MarketBoundsQuery"]["properties"]
                .get(key)
                .is_some()
        );
    }
    let shape = &op["responses"]["200"]["content"]["application/json"]["schema"];
    for key in [
        "onboard_at",
        "delivery_at",
        "first_bar_at",
        "last_bar_at",
        "verified_at",
    ] {
        assert_eq!(
            shape["properties"]["data"]["properties"][key]["type"],
            json!(["string", "null"])
        );
    }
    let (s, _, token, _dir, request) = setup().await;
    let path = format!(
        "/v1/market/bounds?market=usd_m&symbol={}&interval=1h",
        request.symbol
    );
    validate(shape, &get(&s, &token, &path).await.1);
    observe(&s, &request, vec![bar(at(5)), bar(at(10))], false).await;
    validate(shape, &get(&s, &token, &path).await.1);
    assert_eq!(
        spec["components"]["schemas"]["ChartRequest"]["additionalProperties"],
        false
    );
}

#[tokio::test]
async fn replay_stores_bounds_and_clearing_replay_preserves_them() {
    let (s, owner, _, _dir, mut request) = setup().await;
    // valid_symbol caps symbol length; this fixture is only used by this test.
    request.symbol = format!("B{}USDT", &Uuid::new_v4().simple().to_string()[..10]).to_uppercase();
    let now = Utc::now();
    let start =
        DateTime::from_timestamp(now.timestamp().div_euclid(3600) * 3600 - 7200, 0).unwrap();
    let fixture = Arc::new(Fixture {
        value: json!({"bars":[bar(start)],"coverage_complete":false}),
        calls: AtomicUsize::new(0),
    });
    let s = s.with_market(fixture.clone());
    let call=calls::create(&s,owner,"bounds-replay",serde_json::from_value(json!({"original_text":"bounds replay test","instrument":request.symbol,"market":"usd_m","timeframe":"1h","criteria":[]})).unwrap()).await.unwrap();
    let id = serde_json::from_value(call["id"].clone()).unwrap();
    replay::get(&s, owner, id, Default::default())
        .await
        .unwrap();
    assert_eq!(fixture.calls.load(Ordering::SeqCst), 1);
    let last: DateTime<Utc> = sqlx::query_scalar(
        "SELECT last_bar_at FROM public_market.instrument_bounds WHERE symbol=$1",
    )
    .bind(&request.symbol)
    .fetch_one(&s.db.pool)
    .await
    .unwrap();
    assert_eq!(last, start);
    let cached: i64 = sqlx::query_scalar("SELECT count(*) FROM replay_bars WHERE symbol=$1")
        .bind(&request.symbol)
        .fetch_one(&s.db.pool)
        .await
        .unwrap();
    assert_eq!(cached, 1);
    replay::clear(&s, owner, id).await.unwrap();
    let last_after: DateTime<Utc> = sqlx::query_scalar(
        "SELECT last_bar_at FROM public_market.instrument_bounds WHERE symbol=$1",
    )
    .bind(&request.symbol)
    .fetch_one(&s.db.pool)
    .await
    .unwrap();
    assert_eq!(last_after, last);
}
