//! One automatic match per finished record: publishing a review queues it, the
//! jobs table's own unique key is the only thing preventing a second, and a
//! window the trader confirmed by hand is never overwritten. Real PostgreSQL;
//! the screenshot search is stood in for by known candidate windows so the
//! decision is tested, not the OCR toolchain.
mod common;
use chrono::{DateTime, Duration, Utc};
use scorebook::{
    adapters::{db::Database, storage::Storage, vision::Vision},
    application::{
        Services, calls, dto::*, jobs, knowledge, locate, ports::MarketDataProvider, replay,
    },
};
use serde_json::{Value, json};
use std::sync::Arc;
use uuid::Uuid;

/// Flat synthetic bars, so the replay stage can be asked for its window without
/// anyone touching an exchange.
struct Flat;
impl MarketDataProvider for Flat {
    fn tickers_24h<'a>(&'a self, _: &'a str) -> scorebook_core::market::ProviderFuture<'a> {
        Box::pin(async { unreachable!("the stage never ranks instruments") })
    }
    fn klines<'a>(
        &'a self,
        _: &'a str,
        _: &'a str,
        tf: &'a str,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    ) -> scorebook::application::ports::ProviderFuture<'a> {
        Box::pin(async move {
            let seconds = if tf == "1h" { 3600 } else { 60 };
            let mut at = start;
            let mut bars = vec![];
            while at + Duration::seconds(seconds) <= end {
                bars.push(json!({"start":at,"end":at+Duration::seconds(seconds),"open":"100","high":"101","low":"99","close":"100"}));
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
        Box::pin(async move {
            Ok(
                json!({"raw":[{"a":1,"T":end.timestamp_millis()-1000,"p":"100"}],"coverage_complete":true}),
            )
        })
    }
    fn exchange_info<'a>(
        &'a self,
        _: &'a str,
    ) -> scorebook::application::ports::ProviderFuture<'a> {
        Box::pin(async { unreachable!("the stage never reads the catalog") })
    }
}

async fn setup() -> (Services, Uuid, tempfile::TempDir) {
    let db = Database::connect(&common::test_db_url()).await.unwrap();
    db.migrate().await.unwrap();
    let (o, _) = db.create_user("auto-locate-test").await.unwrap();
    let dir = tempfile::tempdir().unwrap();
    let s = Services::new(db, Storage::new(dir.path()), Vision::new(None))
        .unwrap()
        .with_market(Arc::new(Flat));
    (s, o, dir)
}

/// 契约里 bars 不给就等于 full；这些用例只关心舞台本身。
fn full() -> scorebook_core::api::replay::ReplayQuery {
    Default::default()
}

/// 这张图上要找的品种，按图单独指定。
fn over(v: Value) -> scorebook_core::api::replay::LocateOverride {
    serde_json::from_value(v).unwrap()
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

/// A record with one never-pinned scene screenshot, ready to be reviewed.
async fn record(s: &Services, o: Uuid, tag: &str) -> (Uuid, Uuid) {
    let a = calls::upload(s, o, &format!("{tag}-img"), png(), "scene".into(), None)
        .await
        .unwrap();
    let attachment: Uuid = serde_json::from_value(a["id"].clone()).unwrap();
    let mut body: CreateCall = serde_json::from_value(
        json!({"original_text":"自动匹配测试","instrument":"ETHUSDT","market":"usd_m","timeframe":"1h","criteria":[]}),
    )
    .unwrap();
    body.attachments = vec![attachment];
    let saved = calls::create(s, o, tag, body).await.unwrap();
    (
        serde_json::from_value(saved["id"].clone()).unwrap(),
        attachment,
    )
}

fn review_of(call: Uuid) -> Review {
    Review {
        trades: vec![],
        attachment_ids: vec![],
        expected_outcome_ids: vec![],
        call_id: call,
        note: "复盘写完了".into(),
        better_play: None,
        vs_last: "keep".into(),
        expected_revision: 0,
    }
}

/// The queue also holds the review's own indexing work; this takes the match.
async fn claim_locate(s: &Services, o: Uuid) -> jobs::Job {
    sqlx::query("UPDATE jobs SET status='cancelled' WHERE owner_id=$1 AND kind<>'attachment.locate' AND status='queued'")
        .bind(o)
        .execute(&s.db.pool)
        .await
        .unwrap();
    let j = jobs::claim_for(s, Some(o)).await.unwrap().unwrap();
    assert_eq!(j.kind, "attachment.locate");
    j
}

async fn locate_jobs(s: &Services, o: Uuid) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM jobs WHERE owner_id=$1 AND kind='attachment.locate'")
        .bind(o)
        .fetch_one(&s.db.pool)
        .await
        .unwrap()
}

/// A window the screenshot search would have returned.
fn candidate(score: f64, hours_ago: i64) -> Value {
    let end = Utc::now() - Duration::hours(hours_ago);
    json!({
        "symbol":"ETHUSDT","market":"usd_m","interval":"1h",
        "start_at": end - Duration::hours(64), "end_at": end, "bars_count": 64,
        "chart_request":{"source":"rest"},
        "match":{"score":score}
    })
}

#[tokio::test]
async fn publishing_a_review_queues_exactly_one_automatic_match() {
    let (s, o, _tmp) = setup().await;
    let (call, attachment) = record(&s, o, "one").await;
    assert_eq!(locate_jobs(&s, o).await, 0);

    knowledge::review(&s, o, "review-1", review_of(call))
        .await
        .unwrap();
    assert_eq!(locate_jobs(&s, o).await, 1);
    let body: Value =
        sqlx::query_scalar("SELECT body FROM jobs WHERE owner_id=$1 AND kind='attachment.locate'")
            .bind(o)
            .fetch_one(&s.db.pool)
            .await
            .unwrap();
    assert_eq!(body["attachment_id"], json!(attachment));
    assert_eq!(body["call_id"], json!(call));
    assert_eq!(body["trigger"], "review_published");

    // The same submission again is the cached idempotent write, and a genuinely
    // second review of the same record still cannot add a second attempt: the
    // automatic key is the screenshot id, once and for all.
    knowledge::review(&s, o, "review-1", review_of(call))
        .await
        .unwrap();
    let mut again = review_of(call);
    again.expected_revision = 1;
    again.note = "又复盘了一次".into();
    knowledge::review(&s, o, "review-2", again).await.unwrap();
    assert_eq!(locate_jobs(&s, o).await, 1);
}

#[tokio::test]
async fn a_running_match_is_joined_not_duplicated() {
    let (s, o, _tmp) = setup().await;
    let (call, attachment) = record(&s, o, "join").await;
    knowledge::review(&s, o, "review", review_of(call))
        .await
        .unwrap();
    let j = claim_locate(&s, o).await;

    // While it runs the stage says so, and asking to look again joins it.
    let stage = replay::get(&s, o, call, full()).await.unwrap();
    assert_eq!(stage["locating"]["job_id"], json!(j.id));
    assert_eq!(stage["locating"]["status"], "running");
    assert!(stage["window"]["start_at"].is_string());
    assert_eq!(locate_jobs(&s, o).await, 1);
    // The stage's bar cache is shared public market data, keyed by contract and
    // not by owner; this test's window must not linger for the next one.
    sqlx::query("DELETE FROM replay_bars")
        .execute(&s.db.pool)
        .await
        .unwrap();

    let asked = locate::request(&s, o, attachment, "manual-1", Default::default())
        .await
        .unwrap();
    assert_eq!(asked["deduplicated"], true);
    assert_eq!(asked["job"]["id"], json!(j.id));
    assert!(asked["location"].is_null());
    assert_eq!(locate_jobs(&s, o).await, 1);

    let seen = locate::get(&s, o, attachment).await.unwrap();
    assert_eq!(seen["job"]["id"], json!(j.id));
    assert!(seen["location"].is_null());
}

#[tokio::test]
async fn only_an_unmistakable_window_becomes_an_automatic_location() {
    let (s, o, _tmp) = setup().await;

    // Two windows the screenshot fits about equally well: nothing is written,
    // and the shortlist goes back for the trader to choose from.
    let (call, attachment) = record(&s, o, "close").await;
    knowledge::review(&s, o, "review", review_of(call))
        .await
        .unwrap();
    let j = jobs::claim_for(&s, Some(o)).await.unwrap().unwrap();
    let out = locate::decide(
        &s,
        &j,
        attachment,
        &[candidate(0.93, 10), candidate(0.91, 900)],
    )
    .await
    .unwrap();
    assert_eq!(out["outcome"], "ambiguous");
    assert_eq!(out["candidates"].as_array().unwrap().len(), 2);
    assert!(locate::get(&s, o, attachment).await.unwrap()["location"].is_null());

    // One clear window: written down, and marked as the machine's own.
    let (call2, attachment2) = record(&s, o, "clear").await;
    knowledge::review(&s, o, "review-2", review_of(call2))
        .await
        .unwrap();
    let j2 = claim_locate(&s, o).await;
    let out = locate::decide(&s, &j2, attachment2, &[candidate(0.93, 10)])
        .await
        .unwrap();
    assert_eq!(out["outcome"], "located");
    assert_eq!(out["location"]["matched_by"], "auto");
    assert_eq!(out["location"]["source"], "rest");
    assert_eq!(out["location"]["search_run_id"], json!(j2.id));
    let shown = calls::get(&s, o, call2).await.unwrap();
    assert_eq!(shown["attachments"][0]["location"]["matched_by"], "auto");
    // A pinned record is no longer waiting on anything.
    assert!(replay::get(&s, o, call2, full()).await.unwrap()["locating"].is_null());
    // The stage's bar cache is shared public market data, keyed by contract and
    // not by owner; this test's window must not linger for the next one.
    sqlx::query("DELETE FROM replay_bars")
        .execute(&s.db.pool)
        .await
        .unwrap();
}

#[tokio::test]
async fn a_window_the_trader_confirmed_is_never_overwritten() {
    let (s, o, _tmp) = setup().await;
    let (call, attachment) = record(&s, o, "mine").await;
    knowledge::review(&s, o, "review", review_of(call))
        .await
        .unwrap();
    let j = claim_locate(&s, o).await;

    let now = Utc::now();
    let mine = replay::put_location(
        &s,
        o,
        attachment,
        Some("mine-1"),
        serde_json::from_value(
            json!({"symbol":"ETHUSDT","market":"usd_m","interval":"1h","start_at":now-Duration::hours(64),"end_at":now,"source":"rest","score":"0.5"}),
        )
        .unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(mine["matched_by"], "user");

    let out = locate::decide(&s, &j, attachment, &[candidate(0.99, 500)])
        .await
        .unwrap();
    assert_eq!(out["outcome"], "already_located");
    let kept = locate::get(&s, o, attachment).await.unwrap();
    assert_eq!(kept["location"]["matched_by"], "user");
    assert_eq!(kept["location"]["score"], "0.5");
}

/// What the bounded index left behind for exactly this range: other tests share
/// the database, so nothing here counts rows outside the window just built.
async fn index_rows(s: &Services, start: DateTime<Utc>, end: DateTime<Utc>) -> (i64, i64) {
    let features:i64=sqlx::query_scalar("SELECT count(*) FROM public_market.features WHERE symbol='ETHUSDT' AND market='usd_m' AND timeframe='1h' AND published AND start_at>=$1 AND end_at<=$2")
        .bind(start).bind(end).fetch_one(&s.db.pool).await.unwrap();
    let segments:i64=sqlx::query_scalar("SELECT count(*) FROM public_market.coverage_segments WHERE symbol='ETHUSDT' AND market='usd_m' AND timeframe='1h' AND status='complete' AND start_at=$1 AND end_at=$2")
        .bind(start).bind(end).fetch_one(&s.db.pool).await.unwrap();
    (features, segments)
}

/// Without an index there is nothing for a screenshot to be recognised against,
/// and this machine deliberately runs no history sync — so the match builds the
/// little bit of index it needs, around the judgment moment and nowhere else.
/// The next match over the same range finds it already there and builds nothing.
#[tokio::test]
async fn a_match_builds_the_window_index_around_the_judgment_moment_once() {
    let (s, o, _tmp) = setup().await;
    let (call, _attachment) = record(&s, o, "index").await;
    knowledge::review(&s, o, "review", review_of(call))
        .await
        .unwrap();
    let j = claim_locate(&s, o).await;

    // 3×256 bars back from the judgment moment, floored to the interval.
    let judgment = Utc::now() - Duration::days(4);
    let end = DateTime::from_timestamp(judgment.timestamp() / 3600 * 3600, 0).unwrap();
    let start = end - Duration::hours(768);
    assert_eq!(index_rows(&s, start, end).await, (0, 0));

    let built = locate::ensure_index(&s, &j, "usd_m", "ETHUSDT", "1h", judgment)
        .await
        .unwrap();
    assert_eq!(built["built"], true);
    assert_eq!(built["stride_bars"], 1);
    assert_eq!(built["windows"], json!([64, 128, 256]));
    assert_eq!(built["raw_market_storage"], "none");
    assert_eq!(built["range"]["start_at"], json!(start));
    assert_eq!(built["range"]["end_at"], json!(end));
    assert_eq!(built["range"]["bars"], 768);

    // One stride-1 pass per window size: 705 + 641 + 513 windows.
    let (features, segments) = index_rows(&s, start, end).await;
    assert_eq!(built["feature_rows"], json!(1859));
    assert_eq!(features, 1859);
    assert_eq!(segments, 3);
    let sizes:Vec<i32>=sqlx::query_scalar("SELECT DISTINCT bars_count FROM public_market.features WHERE symbol='ETHUSDT' AND timeframe='1h' AND start_at>=$1 AND end_at<=$2 ORDER BY 1")
        .bind(start).bind(end).fetch_all(&s.db.pool).await.unwrap();
    assert_eq!(sizes, vec![64, 128, 256]);

    // Asked for again: already covered, so nothing is fetched and nothing is
    // written a second time.
    let again = locate::ensure_index(&s, &j, "usd_m", "ETHUSDT", "1h", judgment)
        .await
        .unwrap();
    assert_eq!(again["built"], false);
    assert_eq!(again["reason"], "already_indexed");
    assert_eq!(again["range"], built["range"]);
    assert_eq!(index_rows(&s, start, end).await, (features, segments));
}

/// 同板块对比图：记录写的是 ETHUSDT，这张截图画的却是别的合约。按图指定的
/// 三元组要一路走到 job 体里，worker 读的就是它，回显也照它说。
#[tokio::test]
async fn a_screenshot_can_name_its_own_instrument_for_the_match() {
    let (s, o, _tmp) = setup().await;
    let (call, attachment) = record(&s, o, "over").await;

    // 不指定就还是记录自己的三元组，一个字节都没变。
    let plain = locate::request(&s, o, attachment, "plain-1", Default::default())
        .await
        .unwrap();
    assert_eq!(plain["symbol"], "ETHUSDT");
    assert_eq!(plain["market"], "usd_m");
    assert_eq!(plain["interval"], "1h");
    let body: Value = sqlx::query_scalar(
        "SELECT body FROM jobs WHERE owner_id=$1 AND kind='attachment.locate' ORDER BY created_at DESC LIMIT 1",
    )
    .bind(o)
    .fetch_one(&s.db.pool)
    .await
    .unwrap();
    assert_eq!(body["symbol"], "ETHUSDT");
    assert_eq!(body["market"], "usd_m");
    assert_eq!(body["interval"], "1h");
    assert_eq!(body["call_id"], json!(call));

    // 同一把钥匙换了品种就是另一次请求，不该把上一次的结果照抄回去。
    assert_eq!(
        locate::request(
            &s,
            o,
            attachment,
            "plain-1",
            over(json!({"symbol":"SKHYUSDT"}))
        )
        .await
        .unwrap_err()
        .code,
        "idempotency_content_conflict"
    );

    // 上一次得先结束，手动键才让下一次进来。
    sqlx::query(
        "UPDATE jobs SET status='succeeded' WHERE owner_id=$1 AND kind='attachment.locate'",
    )
    .bind(o)
    .execute(&s.db.pool)
    .await
    .unwrap();
    let asked = locate::request(
        &s,
        o,
        attachment,
        "over-1",
        over(json!({"symbol":"SKHYUSDT","market":"coin_m","interval":"4h"})),
    )
    .await
    .unwrap();
    assert_eq!(asked["deduplicated"], false);
    assert_eq!(asked["symbol"], "SKHYUSDT");
    assert_eq!(asked["market"], "coin_m");
    assert_eq!(asked["interval"], "4h");
    let body: Value = sqlx::query_scalar(
        "SELECT body FROM jobs WHERE owner_id=$1 AND kind='attachment.locate' ORDER BY created_at DESC LIMIT 1",
    )
    .bind(o)
    .fetch_one(&s.db.pool)
    .await
    .unwrap();
    assert_eq!(body["symbol"], "SKHYUSDT");
    assert_eq!(body["market"], "coin_m");
    assert_eq!(body["interval"], "4h");
    assert_eq!(body["trigger"], "manual");
    // 记录本身没被改动：改的是这张图怎么找，不是这条记录说了什么。
    let shown = calls::get(&s, o, call).await.unwrap();
    assert_eq!(shown["instrument"], "ETHUSDT");
    // 看一眼也说的是这次实际在用的三元组。
    let seen = locate::get(&s, o, attachment).await.unwrap();
    assert_eq!(seen["symbol"], "SKHYUSDT");
    assert_eq!(seen["market"], "coin_m");
    assert_eq!(seen["interval"], "4h");

    // 只覆盖一格，其余照记录。
    sqlx::query(
        "UPDATE jobs SET status='succeeded' WHERE owner_id=$1 AND kind='attachment.locate'",
    )
    .bind(o)
    .execute(&s.db.pool)
    .await
    .unwrap();
    let one = locate::request(&s, o, attachment, "over-2", over(json!({"interval":"15m"})))
        .await
        .unwrap();
    assert_eq!(one["symbol"], "ETHUSDT");
    assert_eq!(one["market"], "usd_m");
    assert_eq!(one["interval"], "15m");
}

/// 认不得的品种/市场/周期当场拒绝，不让它们混进 job 体去给 worker 找麻烦。
#[tokio::test]
async fn an_unusable_override_is_refused_before_anything_is_queued() {
    let (s, o, _tmp) = setup().await;
    let (_call, attachment) = record(&s, o, "bad").await;
    for (n, (input, code)) in [
        (json!({"symbol":"BTC/USDT"}), "invalid_contract"),
        (json!({"market":"spot"}), "invalid_market"),
        (json!({"interval":"7h"}), "replay_interval_unsupported"),
    ]
    .into_iter()
    .enumerate()
    {
        assert_eq!(
            locate::request(&s, o, attachment, &format!("bad-{n}"), over(input))
                .await
                .unwrap_err()
                .code,
            code
        );
    }
    assert_eq!(locate_jobs(&s, o).await, 0);
    // 空的一格等于没给，照旧走记录本身。
    let blank = locate::request(
        &s,
        o,
        attachment,
        "blank-1",
        over(json!({"symbol":"  ","market":null})),
    )
    .await
    .unwrap();
    assert_eq!(blank["symbol"], "ETHUSDT");
}

/// worker 按 job 体里写着的品种去建索引、去找图，而不是回头读记录。
#[tokio::test]
async fn the_worker_searches_the_instrument_the_screenshot_named() {
    let (s, o, _tmp) = setup().await;
    let (call, attachment) = record(&s, o, "worker").await;
    locate::request(
        &s,
        o,
        attachment,
        "worker-1",
        over(json!({"symbol":"SOLUSDT","interval":"1h"})),
    )
    .await
    .unwrap();
    let j = claim_locate(&s, o).await;
    assert_eq!(j.body["symbol"], "SOLUSDT");

    // 索引只建在这张图说的品种上；记录写的 ETHUSDT 一行都不该多出来。
    let judgment = Utc::now() - Duration::days(4);
    let built = locate::ensure_index(
        &s,
        &j,
        j.body["market"].as_str().unwrap(),
        j.body["symbol"].as_str().unwrap(),
        j.body["interval"].as_str().unwrap(),
        judgment,
    )
    .await
    .unwrap();
    assert_eq!(built["built"], true);
    let mine: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM public_market.features WHERE symbol='SOLUSDT' AND market='usd_m' AND timeframe='1h'",
    )
    .fetch_one(&s.db.pool)
    .await
    .unwrap();
    assert_eq!(mine, 1859);

    // 已经钉住的图直接回显钉住的那份，顺带说清这次用的是哪三样。
    let now = Utc::now();
    replay::put_location(
        &s,
        o,
        attachment,
        Some("pin-1"),
        serde_json::from_value(
            json!({"symbol":"SOLUSDT","market":"usd_m","interval":"1h","start_at":now-Duration::hours(64),"end_at":now,"source":"rest","score":"0.9"}),
        )
        .unwrap(),
    )
    .await
    .unwrap();
    let out = locate::run(&s, &j).await.unwrap();
    assert_eq!(out["outcome"], "already_located");
    assert_eq!(out["symbol"], "SOLUSDT");
    assert_eq!(out["market"], "usd_m");
    assert_eq!(out["interval"], "1h");
    assert_eq!(out["location"]["symbol"], "SOLUSDT");
    let _ = call;
}

/// 复盘发布后的那一次自动定位仍然只认记录本身写的品种：按图指定是手动的事。
#[tokio::test]
async fn the_automatic_match_still_follows_the_record() {
    let (s, o, _tmp) = setup().await;
    let (call, attachment) = record(&s, o, "auto").await;
    knowledge::review(&s, o, "review", review_of(call))
        .await
        .unwrap();
    let body: Value =
        sqlx::query_scalar("SELECT body FROM jobs WHERE owner_id=$1 AND kind='attachment.locate'")
            .bind(o)
            .fetch_one(&s.db.pool)
            .await
            .unwrap();
    assert_eq!(body["trigger"], "review_published");
    assert!(body["symbol"].is_null());
    let seen = locate::get(&s, o, attachment).await.unwrap();
    assert_eq!(seen["symbol"], "ETHUSDT");
    assert_eq!(seen["interval"], "1h");
}
