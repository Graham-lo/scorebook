mod common;
use scorebook::{
    adapters::{db::Database, storage::Storage, vision::Vision},
    application::{Services, chart_search::calibration::Calibration},
};

#[tokio::test]
async fn calibration_uses_only_complete_current_pipeline_buckets() {
    let db = Database::connect(&common::test_db_url()).await.unwrap();
    db.migrate().await.unwrap();
    let dir = tempfile::tempdir().unwrap();
    let s = Services::new(db, Storage::new(dir.path()), Vision::new(None)).unwrap();
    sqlx::query("INSERT INTO chart_match_calibration(interval,bars_bucket,sample_score) SELECT '2h',192,0.1 FROM generate_series(1,500)")
        .execute(&s.db.pool).await.unwrap();
    sqlx::query("INSERT INTO chart_match_calibration(interval,bars_bucket,sample_score,pipeline,sample_id) SELECT '2h',192,0.6,'public-search-300-v1',gen_random_uuid() FROM generate_series(1,499)")
        .execute(&s.db.pool).await.unwrap();
    assert_eq!(
        Calibration::load(&s, Some("2h"))
            .await
            .unwrap()
            .rarity(192, 0.5),
        None
    );
    sqlx::query("INSERT INTO chart_match_calibration(interval,bars_bucket,sample_score,pipeline,sample_id) VALUES('2h',192,0.6,'public-search-300-v1',gen_random_uuid())")
        .execute(&s.db.pool).await.unwrap();
    let distribution = Calibration::load(&s, Some("2h")).await.unwrap();
    assert_eq!(distribution.rarity(192, 0.5), Some(0.));
    assert_eq!(distribution.rarity(192, 0.7), Some(1.));
    assert_eq!(distribution.rarity(128, 0.7), None);
    sqlx::query("DELETE FROM chart_match_calibration WHERE interval='2h'")
        .execute(&s.db.pool)
        .await
        .unwrap();
}
