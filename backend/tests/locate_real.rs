//! Opt-in acceptance against private screenshots and live public market data.
//! Run only through ops/test.sh; all attachments live in an isolated test DB/storage.
mod common;
use chrono::{DateTime, Utc};
use scorebook::{
    adapters::{db::Database, storage::Storage, vision::Vision},
    application::{
        Services, calls,
        jobs::Job,
        locate_anchored::{self, Context},
    },
};
use serde_json::json;
use uuid::Uuid;

#[tokio::test]
#[ignore = "requires SCOREBOOK_REAL_FIXTURES, local OCR and live Binance"]
async fn real_screenshots_are_located_from_scratch_without_saved_locations() {
    let root = std::path::PathBuf::from(
        std::env::var("SCOREBOOK_REAL_FIXTURES").expect("private fixture directory"),
    );
    let db = Database::connect(&common::test_db_url()).await.unwrap();
    db.migrate().await.unwrap();
    let (owner, _) = db.create_user("real-location-acceptance").await.unwrap();
    let storage = tempfile::tempdir().unwrap();
    let s = Services::new(
        db,
        Storage::new(storage.path()),
        Vision::new(std::env::var("SCOREBOOK_VISION_URL").ok()),
    )
    .unwrap();
    // OCR resolves symbols against the exchange catalogue, as the installed app does.
    let catalog: serde_json::Value =
        serde_json::from_slice(&std::fs::read(root.join("catalog.json")).unwrap()).unwrap();
    sqlx::query("INSERT INTO instrument_catalog(venue,market,symbol,body,refreshed_at) SELECT x->>'venue',x->>'market',x->>'symbol',x->'body',now() FROM jsonb_array_elements($1) x")
        .bind(catalog).execute(&s.db.pool).await.unwrap();
    let mut results = vec![];
    for (name, symbol, expected, slack) in [
        ("mu", "MUUSDT", "2026-09-08T23:00:00Z", 4 * 3600),
        ("skhy", "SKHYUSDT", "2026-09-09T13:00:00Z", 3 * 3600),
    ] {
        let bytes = std::fs::read(root.join(format!("{name}.image"))).unwrap();
        let uploaded = calls::upload(&s, owner, name, bytes, "query".into(), None)
            .await
            .unwrap();
        let attachment = serde_json::from_value(uploaded["id"].clone()).unwrap();
        let job = Job {
            id: Uuid::new_v4(),
            owner,
            kind: "attachment.locate".into(),
            body: json!({}),
            lease: Uuid::new_v4(),
            attempt: 1,
            cycle_attempt: 1,
            generation: 1,
        };
        let ctx = Context {
            attachment,
            judgment: "2026-09-10T17:00:00Z".parse().unwrap(),
            record: ("SKHYUSDT".into(), Some("usd_m".into()), Some("1h".into())),
            chosen_symbol: None,
            chosen_market: None,
            chosen_interval: None,
            preferred_offset: Some(480),
        };
        let result = locate_anchored::run(&s, &job, &ctx).await.unwrap();
        println!("{name}: {}", result.value);
        let top = &result.value["candidates"][0];
        assert_eq!(top["symbol"], symbol);
        assert_eq!(top["interval"], "1h");
        let end: DateTime<Utc> = top["end_at"].as_str().unwrap().parse().unwrap();
        let expected: DateTime<Utc> = expected.parse().unwrap();
        assert!((end - expected).num_seconds().abs() <= slack);
        if name == "mu" {
            assert_eq!(result.value["outcome"], "located");
            assert!(matches!(
                result.value["method"].as_str(),
                Some("extremes" | "time_axis")
            ));
        } else {
            assert!(matches!(
                result.value["outcome"].as_str(),
                Some("located" | "candidates")
            ));
        }
        results.push(result.value);
    }
    let locations: i64 =
        sqlx::query_scalar("SELECT count(*) FROM attachment_locations WHERE owner_id=$1")
            .bind(owner)
            .fetch_one(&s.db.pool)
            .await
            .unwrap();
    assert_eq!(
        locations, 0,
        "preview pipeline must not save test locations"
    );
    std::fs::write(
        root.join("fresh-locate-results.json"),
        serde_json::to_vec_pretty(&results).unwrap(),
    )
    .unwrap();
}

#[tokio::test]
async fn random_noise_is_unreadable_and_never_becomes_a_location() {
    let db = Database::connect(&common::test_db_url()).await.unwrap();
    db.migrate().await.unwrap();
    let (owner, _) = db.create_user("noise-acceptance").await.unwrap();
    let storage = tempfile::tempdir().unwrap();
    let s = Services::new(db, Storage::new(storage.path()), Vision::new(None)).unwrap();
    let mut seed = 17u32;
    let mut next = || {
        seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
        (seed >> 24) as u8
    };
    let image = image::RgbImage::from_fn(320, 240, |_, _| image::Rgb([next(), next(), next()]));
    let mut bytes = std::io::Cursor::new(vec![]);
    image::DynamicImage::ImageRgb8(image)
        .write_to(&mut bytes, image::ImageFormat::Png)
        .unwrap();
    let uploaded = calls::upload(&s, owner, "noise", bytes.into_inner(), "query".into(), None)
        .await
        .unwrap();
    let job = Job {
        id: Uuid::new_v4(),
        owner,
        kind: "attachment.locate".into(),
        body: json!({}),
        lease: Uuid::new_v4(),
        attempt: 1,
        cycle_attempt: 1,
        generation: 1,
    };
    let ctx = Context {
        attachment: serde_json::from_value(uploaded["id"].clone()).unwrap(),
        judgment: Utc::now(),
        record: ("BTCUSDT".into(), Some("usd_m".into()), Some("1h".into())),
        chosen_symbol: None,
        chosen_market: None,
        chosen_interval: None,
        preferred_offset: Some(480),
    };
    let result = locate_anchored::run(&s, &job, &ctx).await.unwrap();
    assert_eq!(result.value["outcome"], "unreadable");
    assert_eq!(result.value["candidates"], json!([]));
    assert!(result.write.is_none());
}
