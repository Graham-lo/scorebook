//! One production ANN path. Model literals are allowlisted to match partial expression indexes.
use crate::error::{Error, Result, RetryDirective};
use sqlx::{Postgres, Transaction};
pub fn space(model: &str) -> Result<(&'static str, usize)> {
    match model {
        "candle-profile-v1" => Ok(("candle-profile-v1", 192)),
        "dinov2-small-v1" => Ok(("dinov2-small-v1", 384)),
        _ => Err(Error::bad("unknown_embedding_model")),
    }
}
pub async fn configure(tx: &mut Transaction<'_, Postgres>) -> Result<()> {
    // Shared across API/worker processes. Transaction locks also release on cancellation/crash.
    // Two-int advisory keys occupy a different namespace from the tenant's bigint keys.
    let slot: Option<i32> = sqlx::query_scalar(
        "SELECT slot FROM generate_series(0,7) AS slot WHERE pg_try_advisory_xact_lock(1396851022,slot) LIMIT 1",
    )
    .fetch_optional(&mut **tx)
    .await?;
    if slot.is_none() {
        return Err(Error::deferred(
            "search_capacity_reached",
            RetryDirective::After(1),
        ));
    }
    // Iterative strict ordering can discard better filtered neighbors discovered later.
    // Every caller must materialize candidates and explicitly sort the resulting distances.
    sqlx::query("SET LOCAL hnsw.iterative_scan='relaxed_order'")
        .execute(&mut **tx)
        .await?;
    sqlx::query("SET LOCAL hnsw.ef_search=1000")
        .execute(&mut **tx)
        .await?;
    sqlx::query("SET LOCAL hnsw.scan_mem_multiplier=4")
        .execute(&mut **tx)
        .await?;
    sqlx::query("SET LOCAL work_mem='32MB'")
        .execute(&mut **tx)
        .await?;
    sqlx::query("SET LOCAL hnsw.max_scan_tuples=1000000")
        .execute(&mut **tx)
        .await?;
    Ok(())
}
