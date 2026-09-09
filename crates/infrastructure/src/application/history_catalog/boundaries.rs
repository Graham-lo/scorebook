//! Freeze proven per-contract bounds once per plan; listing time is never listing date.
use super::*;
use scorebook_core::api::history_plans::HistoryPlanRequest;
#[derive(serde::Serialize, serde::Deserialize)]
pub struct Scope {
    pub start_at: DateTime<Utc>,
    pub end_at: DateTime<Utc>,
    pub proof: Value,
}
pub async fn resolve(
    s: &Services,
    j: &Job,
    input: &HistoryPlanRequest,
    symbol: &str,
    tf: &str,
) -> Result<Scope> {
    if let Some(v)=sqlx::query_scalar::<_,Value>("SELECT jsonb_build_object('start_at',start_at,'end_at',end_at,'proof',proof) FROM history_plan_scopes WHERE owner_id=$1 AND plan_id=$2 AND symbol=$3 AND timeframe=$4").bind(j.owner).bind(j.id).bind(symbol).bind(tf).fetch_optional(&s.db.pool).await? {
        return serde_json::from_value(v).map_err(|_|Error::bad("invalid_history_scope"));
    }
    let mut start = input
        .symbol_start_at
        .get(symbol)
        .copied()
        .unwrap_or(input.start_at);
    let mut end = input.end_at;
    let proof = if input.source == HistorySource::MonthlyArchive {
        let prefix = format!(
            "{}{symbol}/{tf}/",
            archives::archive_prefix(&input.market, "monthly")?
        );
        let listing = s.archives.list(&prefix, None).await?;
        if listing.is_truncated {
            return Err(Error::deferred(
                "archive_boundary_listing_budget_exceeded",
                RetryDirective::AwaitInput,
            ));
        }
        let mut keys: Vec<_> = listing
            .contents
            .iter()
            .filter(|r| r.key.ends_with(".zip"))
            .map(|r| r.key.clone())
            .collect();
        keys.sort();
        if keys.is_empty() {
            end = start;
            json!({"identity":"verified_empty_archive_listing","prefix":prefix,"checked_at":Utc::now()})
        } else {
            let first = bound(s, &input.market, symbol, tf, &keys[0]).await?;
            let last = if keys.len() == 1 {
                first.clone()
            } else {
                bound(s, &input.market, symbol, tf, keys.last().unwrap()).await?
            };
            let first_at: DateTime<Utc> = serde_json::from_value(first["actual_start"].clone())
                .map_err(|_| {
                    Error::deferred(
                        "archive_first_boundary_unproven",
                        RetryDirective::AwaitInput,
                    )
                })?;
            let last_at: DateTime<Utc> = serde_json::from_value(last["actual_end"].clone())
                .map_err(|_| {
                    Error::deferred("archive_last_boundary_unproven", RetryDirective::AwaitInput)
                })?;
            start = start.max(first_at);
            end = end.min(last_at);
            json!({"identity":"checksum_verified_archive_boundaries","first":first,"last":last,"listed_months":keys.len(),"listing_sha256":digest(&keys),"interior_gaps":"must_be_verified_by_each_range"})
        }
    } else {
        type Lifecycle = (Option<DateTime<Utc>>, Option<DateTime<Utc>>, String, Uuid);
        let life:Option<Lifecycle>=sqlx::query_as("SELECT onboard_at,delivery_at,status,catalog_version FROM public_market.instrument_lifecycles WHERE market=$1 AND symbol=$2").bind(&input.market).bind(symbol).fetch_optional(&s.db.pool).await?;
        if let Some((onboard, delivery, status, version)) = life {
            if matches!(
                status.as_str(),
                "archive_only" | "absent_from_current_catalog"
            ) {
                return Err(Error::deferred(
                    "delisted_contract_requires_explicit_archive_plan",
                    RetryDirective::AwaitInput,
                ));
            }
            if let Some(t) = onboard {
                start = start.max(t);
            }
            if let Some(t) = delivery.filter(|t| *t <= Utc::now()) {
                end = end.min(t);
            }
            json!({"identity":"exchange_contract_lifecycle","catalog_version":version,"onboard_at":onboard,"delivery_at":delivery,"closed_bar_coverage":"verified_by_each_range"})
        } else {
            json!({"identity":"declared_range_without_catalog_boundaries","closed_bar_coverage":"verified_by_each_range"})
        }
    };
    let seconds = super::super::history::interval_seconds(tf)?;
    start = DateTime::from_timestamp(
        (start.timestamp() + seconds - 1).div_euclid(seconds) * seconds,
        0,
    )
    .unwrap();
    end = DateTime::from_timestamp(end.timestamp().div_euclid(seconds) * seconds, 0).unwrap();
    let scope = Scope {
        start_at: start,
        end_at: end,
        proof,
    };
    let mut tx = jobs::fence(s, j).await?;
    sqlx::query("INSERT INTO history_plan_scopes(owner_id,plan_id,symbol,timeframe,start_at,end_at,status,proof) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING").bind(j.owner).bind(j.id).bind(symbol).bind(tf).bind(start).bind(end).bind(if start>=end{"outside_available_range"}else{"bounded"}).bind(&scope.proof).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(scope)
}
async fn bound(s: &Services, market: &str, symbol: &str, tf: &str, key: &str) -> Result<Value> {
    let known:Option<Value>=sqlx::query_scalar("SELECT jsonb_build_object('source_key',source_key,'actual_start',actual_start,'actual_end',actual_end,'sha256',sha256,'checked_at',checked_at) FROM public_market.history_availability WHERE market=$1 AND symbol=$2 AND timeframe=$3 AND source_key=$4 AND status='verified' AND actual_start IS NOT NULL AND checked_at>now()-interval '24 hours'").bind(market).bind(symbol).bind(tf).bind(key).fetch_optional(&s.db.pool).await?;
    if let Some(v) = known {
        return Ok(v);
    }
    let r = s
        .archives
        .klines(key, DateTime::UNIX_EPOCH, Utc::now())
        .await?;
    let (a, b) = (
        r.bars.first().map(|b| b.start),
        r.bars.last().map(|b| b.end),
    );
    sqlx::query("INSERT INTO public_market.history_availability(market,symbol,timeframe,source_key,size_bytes,status,actual_start,actual_end,sha256) VALUES($1,$2,$3,$4,$5,'verified',$6,$7,$8) ON CONFLICT(market,symbol,timeframe,source_key) DO UPDATE SET size_bytes=EXCLUDED.size_bytes,status='verified',actual_start=EXCLUDED.actual_start,actual_end=EXCLUDED.actual_end,sha256=EXCLUDED.sha256,checked_at=now()").bind(market).bind(symbol).bind(tf).bind(key).bind(r.size_bytes as i64).bind(a).bind(b).bind(&r.sha256).execute(&s.db.pool).await?;
    Ok(
        json!({"source_key":key,"actual_start":a,"actual_end":b,"sha256":r.sha256,"checked_at":Utc::now()}),
    )
}
