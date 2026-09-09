//! Immutable projection snapshots share closed cycle ranges. Only the open tail
//! is copied when an append changes it; historical inserts rebuild the affected book.
use super::*;
use scorebook_core::domain::trade_ledger::Projector;
pub struct Resume {
    pub projector: Projector,
    pub start_ordinal: u64,
    pub mode: &'static str,
}
pub async fn prepare(
    s: &Services,
    j: &Job,
    run: Uuid,
    connection: Uuid,
    seed: &PositionSeedInput,
    inverse: bool,
) -> Result<Resume> {
    let row=sqlx::query("SELECT p.run_id,p.seed_hash,p.last_at,p.last_sequence::text,p.body,r.ledger_revision FROM trade_projection_heads h JOIN trade_projection_runs r ON r.id=h.run_id JOIN trade_projection_checkpoints p ON p.owner_id=h.owner_id AND p.run_id=h.run_id WHERE h.owner_id=$1 AND h.connection_id=$2 AND p.symbol=$3 AND p.position_side=$4").bind(j.owner).bind(connection).bind(&seed.symbol).bind(side(&seed.position_side)).fetch_optional(&s.db.pool).await?;
    let mut mode = "initial_book";
    if let Some(row) = row {
        let old: Uuid = row.get("run_id");
        let last: DateTime<Utc> = row.get("last_at");
        let sequence: String = row.get("last_sequence");
        let historical:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM trade_fills WHERE owner_id=$1 AND connection_id=$2 AND symbol=$3 AND position_side=$4 AND ingested_revision>$5 AND (traded_at,trade_sequence)<=($6,$7::text::numeric))").bind(j.owner).bind(connection).bind(&seed.symbol).bind(side(&seed.position_side)).bind(row.get::<i64,_>("ledger_revision")).bind(last).bind(&sequence).fetch_one(&s.db.pool).await?;
        if row.get::<String, _>("seed_hash") == digest(&json!(seed)) && !historical {
            let changed:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM trade_fills WHERE owner_id=$1 AND connection_id=$2 AND symbol=$3 AND position_side=$4 AND ingested_revision>$5)").bind(j.owner).bind(connection).bind(&seed.symbol).bind(side(&seed.position_side)).bind(row.get::<i64,_>("ledger_revision")).fetch_one(&s.db.pool).await?;
            if !changed {
                let mut tx = jobs::fence(s, j).await?;
                sqlx::query("INSERT INTO trade_projection_segments SELECT owner_id,$3,symbol,position_side,source_run_id,first_ordinal,last_ordinal FROM trade_projection_segments WHERE owner_id=$1 AND run_id=$2 AND symbol=$4 AND position_side=$5").bind(j.owner).bind(old).bind(run).bind(&seed.symbol).bind(side(&seed.position_side)).execute(&mut *tx).await?;
                sqlx::query("INSERT INTO trade_projection_checkpoints SELECT owner_id,$3,symbol,position_side,seed_hash,last_at,last_sequence,body FROM trade_projection_checkpoints WHERE owner_id=$1 AND run_id=$2 AND symbol=$4 AND position_side=$5").bind(j.owner).bind(old).bind(run).bind(&seed.symbol).bind(side(&seed.position_side)).execute(&mut *tx).await?;
                tx.commit().await?;
                return Ok(Resume {
                    projector: Projector::resume(row.get("body"))?,
                    start_ordinal: 0,
                    mode: "unchanged_book",
                });
            }
            let projector = Projector::resume(row.get("body"))?;
            let start = projector.current(None).ordinal;
            let mut tx = jobs::fence(s, j).await?;
            sqlx::query("INSERT INTO trade_projection_segments SELECT owner_id,$3,symbol,position_side,source_run_id,first_ordinal,LEAST(last_ordinal,$6-1) FROM trade_projection_segments WHERE owner_id=$1 AND run_id=$2 AND symbol=$4 AND position_side=$5 AND first_ordinal<$6").bind(j.owner).bind(old).bind(run).bind(&seed.symbol).bind(side(&seed.position_side)).bind(start as i64).execute(&mut *tx).await?;
            // One open cycle may span arbitrarily many imports. Share its immutable
            // allocation ancestry; never copy an ever-growing open ledger tail.
            if projector.current(None).fills > 0 {
                let old_cycle:Option<Uuid>=sqlx::query_scalar("SELECT c.id FROM trade_projection_segments p JOIN trade_cycles c ON c.owner_id=p.owner_id AND c.run_id=p.source_run_id AND c.symbol=p.symbol AND c.position_side=p.position_side AND c.ordinal BETWEEN p.first_ordinal AND p.last_ordinal WHERE p.owner_id=$1 AND p.run_id=$2 AND p.symbol=$3 AND p.position_side=$4 AND c.ordinal=$5").bind(j.owner).bind(old).bind(&seed.symbol).bind(side(&seed.position_side)).bind(start as i64).fetch_optional(&mut *tx).await?;
                let old_cycle =
                    old_cycle.ok_or_else(|| Error::bad("projection_open_cycle_missing"))?;
                let next = super::projection::cycle_id(
                    run,
                    &seed.symbol,
                    side(&seed.position_side),
                    start,
                );
                sqlx::query("INSERT INTO trade_cycles SELECT $3,owner_id,$4,connection_id,symbol,position_side,ordinal,body,id FROM trade_cycles WHERE owner_id=$1 AND id=$2").bind(j.owner).bind(old_cycle).bind(next).bind(run).execute(&mut *tx).await?;
            }
            tx.commit().await?;
            return Ok(Resume {
                projector,
                start_ordinal: start,
                mode: "append_checkpoint",
            });
        }
        mode = if historical {
            "historical_insert_rebuild"
        } else {
            "seed_revision_rebuild"
        };
    }
    Ok(Resume {
        projector: Projector::new(seed, inverse)?,
        start_ordinal: 0,
        mode,
    })
}
pub async fn finish(
    s: &Services,
    j: &Job,
    run: Uuid,
    seed: &PositionSeedInput,
    state: &Resume,
) -> Result<()> {
    let Some((at, sequence)) = state.projector.last_order() else {
        return Ok(());
    };
    let mut tx = jobs::fence(s, j).await?;
    sqlx::query("INSERT INTO trade_projection_checkpoints(owner_id,run_id,symbol,position_side,seed_hash,last_at,last_sequence,body) VALUES($1,$2,$3,$4,$5,$6,$7::text::numeric,$8)").bind(j.owner).bind(run).bind(&seed.symbol).bind(side(&seed.position_side)).bind(digest(&json!(seed))).bind(at).bind(sequence.to_string()).bind(state.projector.checkpoint()?).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO trade_projection_segments SELECT $1,$2,$3,$4,$2,$5,max(ordinal) FROM trade_cycles WHERE owner_id=$1 AND run_id=$2 AND symbol=$3 AND position_side=$4 HAVING max(ordinal)>=$5").bind(j.owner).bind(run).bind(&seed.symbol).bind(side(&seed.position_side)).bind(state.start_ordinal as i64).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}
