mod common;
use scorebook::{
    adapters::{db::Database, storage::Storage, vision::Vision},
    application::{Services, calls, dto::*, similarity},
};
use serde_json::json;
#[tokio::test]
async fn real_local_dino_embedding_and_pgvector_roundtrip() {
    let db = Database::connect(&common::test_db_url()).await.unwrap();
    db.migrate().await.unwrap();
    let (o, _) = db.create_user("vision-test").await.unwrap();
    let temp = tempfile::tempdir().unwrap();
    let s = Services::new(
        db.clone(),
        Storage::new(temp.path()),
        Vision::new(Some("http://127.0.0.1:8790".into())),
    )
    .unwrap();
    let mut im = image::RgbImage::from_pixel(640, 320, image::Rgb([20, 22, 24]));
    for j in 0..60u32 {
        for x in j * 10 + 8..j * 10 + 14 {
            for y in 230 - j * 2..250 - j * 2 {
                im.put_pixel(x, y, image::Rgb([20, 190, 120]));
            }
        }
    }
    let encode = |im: image::RgbImage| {
        let mut p = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(im)
            .write_to(&mut p, image::ImageFormat::Png)
            .unwrap();
        p.into_inner()
    };
    let a = calls::upload(
        &s,
        o,
        "case-image",
        encode(im.clone()),
        "scene".into(),
        None,
    )
    .await
    .unwrap();
    let aid = serde_json::from_value(a["id"].clone()).unwrap();
    let c = serde_json::from_value(json!({
        "original_text": "视觉模型测试案例",
        "instrument": "BTCUSDT",
        "market": "usd_m",
        "timeframe": "4h",
        "attachments": [aid]
    }))
    .unwrap();
    calls::create(&s, o, "case", c).await.unwrap();
    let (v, provenance, _) = similarity::embed(&s, o, aid, None, "dinov2-small-v1")
        .await
        .unwrap();
    assert_eq!(v.as_slice().len(), 384);
    assert_eq!(provenance["local"], true);
    im.put_pixel(0, 0, image::Rgb([100, 100, 100]));
    let q = calls::upload(&s, o, "query-image", encode(im), "query".into(), None)
        .await
        .unwrap();
    let qid = serde_json::from_value(q["id"].clone()).unwrap();
    let r = similarity::search(
        &s,
        o,
        "query",
        SimilarityQuery {
            attachment_id: qid,
            region: None,
            model_id: "dinov2-small-v1".into(),
            instrument: None,
            market: None,
            timeframe: Some("4h".into()),
            cutoff_at: None,
            limit: Some(5),
        },
    )
    .await
    .unwrap();
    assert_eq!(r["items"].as_array().unwrap().len(), 1);
    assert!(r["items"][0]["cosine_distance"].as_f64().unwrap() < 0.01);
}
