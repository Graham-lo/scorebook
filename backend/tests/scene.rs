//! 换场景图：账本护的是证据本身，「此刻哪一张在生效」是个判断，判断可以改正。
//! 真 PostgreSQL，本地几何识别，市场数据用替身。这里的每一条都在盯同一件事：
//! 换图只动链接上的 `superseded_at`，一行附件、一个字节都不删；证据池的那道
//! 「图必须先于记录成立」的闸门一个字都没松。
mod common;
use chrono::{DateTime, Duration, Utc};
use scorebook::{
    adapters::{db::Database, storage::Storage, vision::Vision},
    application::{
        Services, calls, chart_search, dto::*, knowledge, ports::MarketDataProvider,
        record_changes, replay, similarity,
    },
};
use serde_json::{Value, json};
use std::sync::Arc;
use tokio::io::AsyncReadExt;
use uuid::Uuid;

/// 平的合成 K 线：舞台要得到窗口，谁也不必去碰交易所。
struct Flat;
impl MarketDataProvider for Flat {
    fn tickers_24h<'a>(&'a self, _: &'a str) -> scorebook_core::market::ProviderFuture<'a> {
        Box::pin(async { unreachable!("换图不排品种") })
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
            let iv = scorebook_core::domain::interval::Interval::exact(tf).unwrap();
            let mut at = start;
            let mut bars = vec![];
            while iv.add_bars(at, 1) <= end {
                let to = iv.add_bars(at, 1);
                bars.push(
                    json!({"start":at,"end":to,"open":"100","high":"101","low":"99","close":"100"}),
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
        Box::pin(async { unreachable!("换图不读目录") })
    }
}

async fn setup() -> (Services, Uuid, tempfile::TempDir) {
    let db = Database::connect(&common::test_db_url()).await.unwrap();
    db.migrate().await.unwrap();
    let (o, _) = db.create_user("scene-test").await.unwrap();
    let dir = tempfile::tempdir().unwrap();
    let s = Services::new(db, Storage::new(dir.path()), Vision::new(None))
        .unwrap()
        .with_market(Arc::new(Flat));
    (s, o, dir)
}

fn full() -> scorebook_core::api::replay::ReplayQuery {
    Default::default()
}

/// 灰度不同的两张纯色图：sha256 不同，才是两张附件。
fn png(shade: u8) -> Vec<u8> {
    let mut b = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
        64,
        64,
        image::Rgb([shade, shade, shade]),
    ))
    .write_to(&mut b, image::ImageFormat::Png)
    .unwrap();
    b.into_inner()
}

/// 能被本地几何识别认出来的 K 线图，深浅两种主题，形状一样。
fn chart(dark: bool) -> Vec<u8> {
    let mut im = image::RgbImage::from_pixel(
        640,
        320,
        if dark {
            image::Rgb([18, 20, 24])
        } else {
            image::Rgb([245, 245, 245])
        },
    );
    for j in 0..64u32 {
        let center = 230 - j * 2;
        for x in j * 10 + 2..j * 10 + 8 {
            for y in center - 8..center + 8 {
                im.put_pixel(
                    x,
                    y,
                    if j % 3 == 0 {
                        image::Rgb([225, 65, 78])
                    } else {
                        image::Rgb([20, 180, 100])
                    },
                );
            }
        }
    }
    let mut b = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgb8(im)
        .write_to(&mut b, image::ImageFormat::Png)
        .unwrap();
    b.into_inner()
}

fn call_body() -> CreateCall {
    serde_json::from_value(
        json!({"original_text":"换图测试记录","instrument":"BTCUSDT","market":"usd_m","timeframe":"1h","criteria":[]}),
    )
    .unwrap()
}

async fn upload(s: &Services, o: Uuid, tag: &str, bytes: Vec<u8>, kind: &str) -> Uuid {
    let v = calls::upload(s, o, tag, bytes, kind.into(), None)
        .await
        .unwrap();
    serde_json::from_value(v["id"].clone()).unwrap()
}

async fn record(s: &Services, o: Uuid, tag: &str, attachments: Vec<Uuid>) -> Uuid {
    let mut body = call_body();
    body.attachments = attachments;
    let saved = calls::create(s, o, tag, body).await.unwrap();
    serde_json::from_value(saved["id"].clone()).unwrap()
}

async fn revision(s: &Services, o: Uuid, call: Uuid) -> i64 {
    calls::get(s, o, call).await.unwrap()["revision"]
        .as_i64()
        .unwrap()
}

/// 换图：把这张附件指成此刻生效的场景图。
async fn set_scene(s: &Services, o: Uuid, call: Uuid, attachment: Uuid, key: &str) -> Value {
    let rev = revision(s, o, call).await;
    record_changes::set_scene(
        s,
        o,
        call,
        Some(key),
        serde_json::from_value(json!({"attachment_id":attachment,"expected_revision":rev}))
            .unwrap(),
    )
    .await
    .unwrap()
}

fn location(start: DateTime<Utc>, end: DateTime<Utc>) -> Value {
    json!({"symbol":"BTCUSDT","market":"usd_m","interval":"1h","start_at":start,"end_at":end,"source":"rest","score":"0.94"})
}

fn review_of(call: Uuid, expected_revision: i64) -> Review {
    Review {
        trades: vec![],
        attachment_ids: vec![],
        expected_outcome_ids: vec![],
        call_id: call,
        note: "复盘写完了".into(),
        better_play: None,
        vs_last: "keep".into(),
        expected_revision,
    }
}

/// `digest(&None)` 的哈希：整图向量只认它。视觉向量在这里是直接写进去的，
/// 本地不跑 dinov2——这几条用例问的是闸门，不是模型。
const WHOLE: &str = "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b";
async fn visual(s: &Services, o: Uuid, attachment: Uuid) {
    let vector = format!("[{}]", vec!["0.1"; 384].join(","));
    sqlx::query("INSERT INTO embedding_models(id,dimension,metadata) VALUES('dinov2-small-v1',384,'{}') ON CONFLICT DO NOTHING")
        .execute(&s.db.pool).await.unwrap();
    sqlx::query("INSERT INTO image_embeddings(id,owner_id,attachment_id,model_id,region,region_hash,embedding,quality) VALUES($1,$2,$3,'dinov2-small-v1','null',$4,$5::vector,'{}') ON CONFLICT DO NOTHING")
        .bind(Uuid::new_v4()).bind(o).bind(attachment).bind(WHOLE).bind(&vector)
        .execute(&s.db.pool).await.unwrap();
}

/// 跑完一次私有按图检索，返回最终结果。
async fn private_search(s: &Services, o: Uuid, query: Uuid, key: &str) -> Value {
    chart_search::create(
        s,
        o,
        key,
        serde_json::from_value(
            json!({"attachment_id":query,"scope":"private","interval":"1h","market":"usd_m"}),
        )
        .unwrap(),
    )
    .await
    .unwrap();
    // 上传时每张图都排了两个向量作业，交互队列同时只许跑两个——占着不放就永远
    // 轮不到检索。这里的向量是直接写进库的，那几个作业销掉即可。
    let j = loop {
        let j = scorebook::application::jobs::claim_for(s, Some(o))
            .await
            .unwrap()
            .unwrap();
        if j.kind == "chart.search" {
            break j;
        }
        scorebook::application::jobs::complete(s, &j, Ok(json!({})))
            .await
            .unwrap();
    };
    chart_search::run(s, &j).await.unwrap()
}

fn similar(query: Uuid) -> SimilarityQuery {
    SimilarityQuery {
        attachment_id: query,
        region: None,
        model_id: "candle-geometry-v2".into(),
        instrument: Some("BTCUSDT".into()),
        market: Some("usd_m".into()),
        timeframe: Some("1h".into()),
        cutoff_at: None,
        limit: Some(10),
    }
}

/// 0050 不许悄悄改变既有记录挑的是哪一张。老规矩是「按 `attachments.uploaded_at,
/// id` 升序取第一条」，迁移把 `attached_at` 回填成了 uploaded_at，两个排序键逐行
/// 相等——所以这里把老规矩逐字跑一遍，答案必须和新读法一模一样，而且是最早那一
/// 张，不是最新那一张。
#[tokio::test]
async fn the_migration_keeps_the_image_existing_records_already_picked() {
    let (s, o, _tmp) = setup().await;
    let old = upload(&s, o, "old", png(10), "scene").await;
    let new = upload(&s, o, "new", png(200), "scene").await;
    let id = record(&s, o, "two-scenes", vec![old, new]).await;

    // 迁移的回填再跑一遍也不换人：这条语句就是 0050 里那一条。
    sqlx::query("UPDATE call_attachments l SET attached_at=a.uploaded_at FROM attachments a WHERE a.owner_id=l.owner_id AND a.id=l.attachment_id")
        .execute(&s.db.pool).await.unwrap();

    // 0050 之前 replay/locate 用的读法，逐字照抄。
    let before: Uuid = sqlx::query_scalar("SELECT a.id FROM attachments a JOIN call_attachments l ON l.owner_id=a.owner_id AND l.attachment_id=a.id WHERE l.owner_id=$1 AND l.call_id=$2 AND a.kind='scene' ORDER BY a.uploaded_at,a.id LIMIT 1")
        .bind(o).bind(id).fetch_one(&s.db.pool).await.unwrap();
    assert_eq!(before, old);

    let v = replay::get(&s, o, id, full()).await.unwrap();
    assert_eq!(v["scene"]["attachment_id"], json!(old));
    assert_eq!(v["scene_replaced_after_submission"], false);

    let rec = calls::get(&s, o, id).await.unwrap();
    assert_eq!(rec["scene_in_effect"]["attachment_id"], json!(old));
    assert_eq!(rec["scene_replaced_after_submission"], false);
    assert_eq!(rec["superseded_scenes"], json!([]));
    // 两张图都还挂在记录上，迁移没有替谁做主。
    assert_eq!(rec["attachments"].as_array().unwrap().len(), 2);
}

/// 换过图之后，重温和自动定位都跟着走新的那一张：旧图钉在哪儿都不再作数。
#[tokio::test]
async fn a_swap_moves_replay_and_the_automatic_match_to_the_new_image() {
    let (s, o, _tmp) = setup().await;
    let old = upload(&s, o, "old", png(10), "scene").await;
    let id = record(&s, o, "swap", vec![old]).await;

    let v = replay::get(&s, o, id, full()).await.unwrap();
    let judgment: DateTime<Utc> = serde_json::from_value(v["judgment"]["at"].clone()).unwrap();
    replay::put_location(
        &s,
        o,
        old,
        Some("pin-old"),
        serde_json::from_value(location(judgment - Duration::hours(300), judgment)).unwrap(),
    )
    .await
    .unwrap();
    let v = replay::get(&s, o, id, full()).await.unwrap();
    assert_eq!(v["window"]["bars_before"], 300);
    assert!(v["locating"].is_null());

    // 自动定位那条规矩不放宽：只有已经写过复盘的记录才补。
    knowledge::review(&s, o, "review", review_of(id, revision(&s, o, id).await))
        .await
        .unwrap();

    let new = upload(&s, o, "new", png(200), "scene").await;
    let swapped = set_scene(&s, o, id, new, "swap-1").await;
    assert_eq!(swapped["superseded"], json!([old]));
    assert_eq!(swapped["original_evidence_unchanged"], true);

    let v = replay::get(&s, o, id, full()).await.unwrap();
    assert_eq!(v["scene"]["attachment_id"], json!(new));
    // 旧图的那颗钉子不再决定舞台从哪儿开。
    assert_eq!(v["window"]["bars_before"], 120);
    assert_eq!(v["locating"]["status"], "queued");

    let body: Value = sqlx::query_scalar("SELECT body FROM jobs WHERE owner_id=$1 AND kind='attachment.locate' ORDER BY created_at DESC,id DESC LIMIT 1")
        .bind(o).fetch_one(&s.db.pool).await.unwrap();
    assert_eq!(body["attachment_id"], json!(new));
    assert_eq!(body["call_id"], json!(id));
    assert_eq!(body["trigger"], "scene_replaced");
}

/// 被接替的那一张一行没删、一个字节没改，而且随时指得回来。
#[tokio::test]
async fn the_superseded_image_stays_whole_and_can_be_pointed_back() {
    let (s, o, _tmp) = setup().await;
    let old = upload(&s, o, "old", png(10), "scene").await;
    let id = record(&s, o, "keep", vec![old]).await;
    let before: (String, i64, DateTime<Utc>) = sqlx::query_as(
        "SELECT sha256,size,uploaded_at FROM attachments WHERE owner_id=$1 AND id=$2",
    )
    .bind(o)
    .bind(old)
    .fetch_one(&s.db.pool)
    .await
    .unwrap();

    let new = upload(&s, o, "new", png(200), "scene").await;
    set_scene(&s, o, id, new, "swap-1").await;

    let after: (String, i64, DateTime<Utc>) = sqlx::query_as(
        "SELECT sha256,size,uploaded_at FROM attachments WHERE owner_id=$1 AND id=$2",
    )
    .bind(o)
    .bind(old)
    .fetch_one(&s.db.pool)
    .await
    .unwrap();
    assert_eq!(before, after);

    // 字节也还在。
    let mut bytes = Vec::new();
    s.images
        .open(o, old)
        .await
        .unwrap()
        .read_to_end(&mut bytes)
        .await
        .unwrap();
    assert_eq!(bytes, png(10));

    let rec = calls::get(&s, o, id).await.unwrap();
    assert_eq!(rec["scene_in_effect"]["attachment_id"], json!(new));
    assert_eq!(rec["superseded_scenes"][0]["attachment_id"], json!(old));
    assert_eq!(rec["superseded_scenes"][0]["sha256"], json!(before.0));
    assert_eq!(rec["superseded_scenes"][0]["superseded_by"], json!(new));

    // 指回来：改正的退路，同样不删任何行。
    set_scene(&s, o, id, old, "swap-back").await;
    let rec = calls::get(&s, o, id).await.unwrap();
    assert_eq!(rec["scene_in_effect"]["attachment_id"], json!(old));
    assert_eq!(rec["superseded_scenes"][0]["attachment_id"], json!(new));
    assert_eq!(rec["attachments"].as_array().unwrap().len(), 2);
    assert_eq!(
        replay::get(&s, o, id, full()).await.unwrap()["scene"]["attachment_id"],
        json!(old)
    );
}

/// 提交之后才上传的替换图：重温认它，证据池不认它，结果里带着看得见的标记。
#[tokio::test]
async fn a_replacement_uploaded_after_submission_is_marked_and_never_becomes_evidence() {
    let (s, o, _tmp) = setup().await;
    let old = upload(&s, o, "old", chart(false), "scene").await;
    let id = record(&s, o, "late", vec![old]).await;

    // 记录成立之后才有的这一张。
    let new = upload(&s, o, "new", chart(true), "scene").await;
    for a in [old, new] {
        similarity::embed(&s, o, a, None, "candle-geometry-v2")
            .await
            .unwrap();
        visual(&s, o, a).await;
    }
    let swapped = set_scene(&s, o, id, new, "swap-1").await;
    assert_eq!(swapped["scene_replaced_after_submission"], true);

    // 重温和记录本身都用新的那一张，并且都说得出它是事后换的。
    let v = replay::get(&s, o, id, full()).await.unwrap();
    assert_eq!(v["scene"]["attachment_id"], json!(new));
    assert_eq!(v["scene_replaced_after_submission"], true);
    let rec = calls::get(&s, o, id).await.unwrap();
    assert_eq!(rec["scene_replaced_after_submission"], true);
    assert_eq!(rec["scene_in_effect"]["replaced_after_submission"], true);
    // 原来那一张仍然取得回来。
    assert_eq!(rec["superseded_scenes"][0]["attachment_id"], json!(old));

    // 证据池两边都不收：新的那一张记录成立时还不存在，旧的那一张已经不生效了。
    let query = upload(&s, o, "q", chart(true), "query").await;
    visual(&s, o, query).await;
    assert_eq!(
        similarity::search(&s, o, "after", similar(query))
            .await
            .unwrap()["items"],
        json!([])
    );
    assert_eq!(
        private_search(&s, o, query, "after").await["items"],
        json!([])
    );
}

/// 提交之前就上传的替换图：换图照常，没有标记，证据池照收不误。闸门看的是
/// `uploaded_at`，不是什么时候挂上去的。
#[tokio::test]
async fn a_replacement_uploaded_before_submission_carries_no_marker() {
    let (s, o, _tmp) = setup().await;
    let old = upload(&s, o, "old", chart(false), "scene").await;
    // 两张都先传好，再提交记录。
    let new = upload(&s, o, "new", chart(true), "scene").await;
    let id = record(&s, o, "early", vec![old]).await;
    for a in [old, new] {
        similarity::embed(&s, o, a, None, "candle-geometry-v2")
            .await
            .unwrap();
        visual(&s, o, a).await;
    }
    let swapped = set_scene(&s, o, id, new, "swap-1").await;
    assert_eq!(swapped["scene_replaced_after_submission"], false);

    let v = replay::get(&s, o, id, full()).await.unwrap();
    assert_eq!(v["scene"]["attachment_id"], json!(new));
    assert_eq!(v["scene_replaced_after_submission"], false);
    let rec = calls::get(&s, o, id).await.unwrap();
    assert_eq!(rec["scene_replaced_after_submission"], false);

    let query = upload(&s, o, "q", chart(true), "query").await;
    visual(&s, o, query).await;
    let found = similarity::search(&s, o, "before", similar(query))
        .await
        .unwrap();
    assert_eq!(found["items"][0]["attachment_id"], json!(new));
    let searched = private_search(&s, o, query, "before").await;
    assert_eq!(searched["items"][0]["attachment_id"], json!(new));
}
