//! One rebuildable read projection, updated in the same transaction as each review-state change.
use crate::error::Result;
use sqlx::{Postgres, Transaction};
use uuid::Uuid;
pub async fn refresh(tx: &mut Transaction<'_, Postgres>, owner: Uuid, id: Uuid) -> Result<()> {
    // Acquire the existing projection before reading source state, so waiting publishers see the prior writer's commit.
    sqlx::query(
        "SELECT call_id FROM review_queue_projection WHERE owner_id=$1 AND call_id=$2 FOR UPDATE",
    )
    .bind(owner)
    .bind(id)
    .fetch_optional(&mut **tx)
    .await?;
    sqlx::query("INSERT INTO review_queue_projection SELECT * FROM review_queue_source WHERE owner_id=$1 AND call_id=$2 ON CONFLICT(owner_id,call_id) DO UPDATE SET voided=EXCLUDED.voided,base_bucket=EXCLUDED.base_bucket,latest_review_id=EXCLUDED.latest_review_id,reviewed_at=EXCLUDED.reviewed_at,draft_revision=EXCLUDED.draft_revision,draft_saved_at=EXCLUDED.draft_saved_at,snoozed_until=EXCLUDED.snoozed_until,preference_revision=EXCLUDED.preference_revision").bind(owner).bind(id).execute(&mut **tx).await?;
    Ok(())
}
