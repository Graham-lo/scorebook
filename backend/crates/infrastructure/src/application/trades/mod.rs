//! User trading assets: normalized imports, immutable ledger, derived cycles and links.
use super::{
    Services,
    jobs::{self, Job},
};
use crate::{
    adapters::db::{Database, digest},
    error::{Error, Result},
};
use chrono::{DateTime, Utc};
use scorebook_core::api::trades::*;
use serde_json::{Value, json};
use sqlx::Row;
use uuid::Uuid;
pub mod import;
pub mod projection;
mod projection_incremental;
pub mod reconciliation;
pub async fn connection(
    s: &Services,
    owner: Uuid,
    key: &str,
    input: ExchangeConnectionInput,
) -> Result<Value> {
    if input.name.trim().is_empty()
        || input.name.len() > 120
        || input.account_label.trim().is_empty()
        || input.account_label.len() > 120
        || !matches!(input.market.as_str(), "usd_m" | "coin_m")
        || input.keychain_service.as_ref().is_some_and(|v| {
            !v.starts_with(&format!("scorebook.exchange.{owner}."))
                || v.len() > 200
                || v.chars().any(char::is_control)
        })
    {
        return Err(Error::bad("invalid_exchange_connection"));
    }
    let body = json!(input);
    let (mut tx, cached) = s.db.write(owner, "exchange.connect", key, &body).await?;
    if let Some(v) = cached {
        return Ok(v);
    }
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO exchange_connections(id,owner_id,venue,market,name,account_label) VALUES($1,$2,'binance',$3,$4,$5)").bind(id).bind(owner).bind(input.market).bind(input.name).bind(input.account_label).execute(&mut *tx).await?;
    if let Some(service) = &input.keychain_service {
        sqlx::query("INSERT INTO exchange_credentials(owner_id,connection_id,keychain_service) VALUES($1,$2,$3)").bind(owner).bind(id).bind(service).execute(&mut *tx).await?;
    }
    let v = json!({"connection_id":id,"status":"created","api_credentials":if input.keychain_service.is_some(){"referenced_not_yet_verified"}else{"not_configured"},"read_only_adapter":true});
    Database::finish(&mut tx, owner, "exchange.connect", key, &body, &v).await?;
    tx.commit().await?;
    Ok(v)
}
pub async fn connections(s: &Services, owner: Uuid, filter: ImportFilter) -> Result<Value> {
    page(s, owner, filter, "exchange_connections").await
}
pub async fn imports(
    s: &Services,
    owner: Uuid,
    id: Option<Uuid>,
    filter: ImportFilter,
) -> Result<Value> {
    if let Some(id) = id {
        return sqlx::query_scalar(
            "SELECT to_jsonb(i)-'owner_id' FROM trade_imports i WHERE owner_id=$1 AND id=$2",
        )
        .bind(owner)
        .bind(id)
        .fetch_optional(&s.db.pool)
        .await?
        .ok_or_else(Error::not_found);
    }
    page(s, owner, filter, "trade_imports").await
}
async fn page(s: &Services, owner: Uuid, filter: ImportFilter, table: &str) -> Result<Value> {
    let cursor: Option<(DateTime<Utc>, Uuid)> = filter
        .cursor
        .as_ref()
        .map(|v| serde_json::from_str(v))
        .transpose()
        .map_err(|_| Error::bad("invalid_page_cursor"))?;
    let column = if table == "exchange_connections" {
        "id"
    } else {
        "connection_id"
    };
    let rows:Vec<Value>=sqlx::query_scalar(&format!("SELECT to_jsonb(r)-'owner_id' FROM {table} r WHERE owner_id=$1 AND ($2::uuid IS NULL OR {column}=$2) AND ($3::timestamptz IS NULL OR (created_at,id)<($3,$4)) ORDER BY created_at DESC,id DESC LIMIT 101")).bind(owner).bind(filter.connection_id).bind(cursor.map(|v|v.0)).bind(cursor.map(|v|v.1)).fetch_all(&s.db.pool).await?;
    let more = rows.len() > 100;
    let items: Vec<_> = rows.into_iter().take(100).collect();
    Ok(
        json!({"next_cursor":if more{items.last().map(|v|json!([v["created_at"],v["id"]]).to_string())}else{None},"items":items}),
    )
}
pub async fn fills(s: &Services, owner: Uuid, input: TradeFilter) -> Result<Value> {
    let cursor: Option<(DateTime<Utc>, Uuid)> = input
        .cursor
        .as_ref()
        .map(|v| serde_json::from_str(v))
        .transpose()
        .map_err(|_| Error::bad("invalid_trade_cursor"))?;
    let rows:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',id,'connection_id',connection_id,'import_id',import_id,'fill',body,'execution_venue','binance') FROM trade_fills WHERE owner_id=$1 AND ($2::uuid IS NULL OR connection_id=$2) AND ($3::text IS NULL OR symbol=$3) AND ($4::timestamptz IS NULL OR traded_at>=$4) AND ($5::timestamptz IS NULL OR traded_at<$5) AND ($6::timestamptz IS NULL OR (traded_at,id)>($6,$7)) ORDER BY traded_at,id LIMIT 101").bind(owner).bind(input.connection_id).bind(input.symbol).bind(input.start_at).bind(input.end_at).bind(cursor.map(|v|v.0)).bind(cursor.map(|v|v.1)).fetch_all(&s.db.pool).await?;
    let more = rows.len() > 100;
    let items: Vec<_> = rows.into_iter().take(100).collect();
    let next = if more {
        items
            .last()
            .map(|v| json!([v["fill"]["traded_at"], v["id"]]).to_string())
    } else {
        None
    };
    Ok(json!({"items":items,"next_cursor":next,"price_provenance":"actual_execution_prices"}))
}
pub async fn seed(s: &Services, owner: Uuid, key: &str, input: PositionSeedInput) -> Result<Value> {
    let body = json!(input);
    let (mut tx, cached) = s.db.write(owner, "trade.seed", key, &body).await?;
    if let Some(v) = cached {
        return Ok(v);
    }
    let market: String = sqlx::query_scalar(
        "SELECT market FROM exchange_connections WHERE owner_id=$1 AND id=$2 FOR UPDATE",
    )
    .bind(owner)
    .bind(input.connection_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(Error::not_found)?;
    scorebook_core::domain::trade_ledger::Projector::new(&input, market == "coin_m")?;
    if input.evidence.trim().is_empty() || input.evidence.len() > 20000 {
        return Err(Error::bad("opening_position_evidence_required"));
    }
    let first:Option<DateTime<Utc>>=sqlx::query_scalar("SELECT min(traded_at) FROM trade_fills WHERE owner_id=$1 AND connection_id=$2 AND symbol=$3 AND position_side=$4").bind(owner).bind(input.connection_id).bind(&input.symbol).bind(side(&input.position_side)).fetch_one(&mut *tx).await?;
    if first.is_some_and(|v| input.effective_at > v) {
        return Err(Error::bad("opening_seed_must_cover_first_imported_fill"));
    }
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO position_seeds(id,owner_id,connection_id,symbol,position_side,effective_at,body) VALUES($1,$2,$3,$4,$5,$6,$7)").bind(id).bind(owner).bind(input.connection_id).bind(&input.symbol).bind(side(&input.position_side)).bind(input.effective_at).bind(&body).execute(&mut *tx).await?;
    let revision:i64=sqlx::query_scalar("UPDATE exchange_connections SET ledger_revision=ledger_revision+1 WHERE owner_id=$1 AND id=$2 RETURNING ledger_revision").bind(owner).bind(input.connection_id).fetch_one(&mut *tx).await?;
    let job = jobs::enqueue_tx(
        &mut tx,
        owner,
        "trade.project",
        &format!("{}:{revision}", input.connection_id),
        json!({"connection_id":input.connection_id,"ledger_revision":revision}),
    )
    .await?;
    let v = json!({"seed_id":id,"connection_id":input.connection_id,"ledger_revision":revision,"projection_job_id":job});
    Database::finish(&mut tx, owner, "trade.seed", key, &body, &v).await?;
    tx.commit().await?;
    Ok(v)
}
pub fn side(v: &PositionSide) -> &'static str {
    match v {
        PositionSide::Both => "BOTH",
        PositionSide::Long => "LONG",
        PositionSide::Short => "SHORT",
    }
}
pub async fn link(
    s: &Services,
    owner: Uuid,
    key: &str,
    input: ExecutionLinkInput,
) -> Result<Value> {
    if input.trade_ids.is_empty()
        || input.trade_ids.len() > 1000
        || input.call_id.is_none() && input.episode_id.is_none() && input.playbook_id.is_none()
        || !matches!(input.relation.as_str(), "executed" | "rejected" | "related")
        || input.evidence.trim().is_empty()
        || input.evidence.len() > 20000
    {
        return Err(Error::bad("invalid_execution_link"));
    }
    let body = json!(input);
    let (mut tx, cached) = s.db.write(owner, "trade.link", key, &body).await?;
    if let Some(v) = cached {
        return Ok(v);
    }
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM trade_fills WHERE owner_id=$1 AND connection_id=$2 AND id=ANY($3)",
    )
    .bind(owner)
    .bind(input.connection_id)
    .bind(&input.trade_ids)
    .fetch_one(&mut *tx)
    .await?;
    let unique: std::collections::HashSet<_> = input.trade_ids.iter().collect();
    if count as usize != unique.len() {
        return Err(Error::bad("fill_not_in_connection"));
    }
    if let Some(previous) = input.supersedes {
        let found:Option<Uuid>=sqlx::query_scalar("SELECT id FROM execution_links WHERE owner_id=$1 AND connection_id=$2 AND id=$3 FOR UPDATE").bind(owner).bind(input.connection_id).bind(previous).fetch_optional(&mut *tx).await?;
        if found.is_none() {
            return Err(Error::bad("execution_link_not_in_connection"));
        }
        let replaced: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM execution_links WHERE owner_id=$1 AND supersedes=$2)",
        )
        .bind(owner)
        .bind(previous)
        .fetch_one(&mut *tx)
        .await?;
        if replaced {
            return Err(Error::conflict("execution_link_head_conflict"));
        }
    }
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO execution_links(id,owner_id,connection_id,call_id,episode_id,playbook_id,relation,body,supersedes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)").bind(id).bind(owner).bind(input.connection_id).bind(input.call_id).bind(input.episode_id).bind(input.playbook_id).bind(&input.relation).bind(&body).bind(input.supersedes).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO execution_link_fills SELECT $1,$2,x FROM unnest($3::uuid[]) x ON CONFLICT DO NOTHING").bind(owner).bind(id).bind(input.trade_ids).execute(&mut *tx).await?;
    let v = json!({"execution_link_id":id,"call_id":input.call_id,"episode_id":input.episode_id,"playbook_id":input.playbook_id,"relation":input.relation,"timing":"retrospective_link_not_prior_adoption"});
    Database::finish(&mut tx, owner, "trade.link", key, &body, &v).await?;
    tx.commit().await?;
    Ok(v)
}

pub mod sync;

pub async fn control(
    s: &Services,
    owner: Uuid,
    id: Uuid,
    key: &str,
    input: ConnectionControl,
) -> Result<Value> {
    if !matches!(
        input.action.as_str(),
        "disconnect" | "reconnect" | "rotate_credentials"
    ) {
        return Err(Error::bad("invalid_connection_action"));
    }
    if input.action != "disconnect"
        && input.keychain_service.as_ref().is_none_or(|v| {
            !v.starts_with(&format!("scorebook.exchange.{owner}."))
                || v.len() > 200
                || !v
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'-' | b'_'))
        })
    {
        return Err(Error::bad(
            "owner_scoped_exchange_keychain_reference_required",
        ));
    }
    let body = json!({"connection_id":id,"input":input});
    let (mut tx, cached) = s.db.write(owner, "exchange.control", key, &body).await?;
    if let Some(v) = cached {
        return Ok(v);
    }
    let revision:Option<i64>=sqlx::query_scalar("SELECT configuration_revision FROM exchange_connections WHERE owner_id=$1 AND id=$2 FOR UPDATE").bind(owner).bind(id).fetch_optional(&mut *tx).await?;
    if revision != Some(input.expected_revision) {
        return Err(Error::conflict("connection_revision_conflict"));
    }
    sqlx::query("UPDATE exchange_connections SET configuration_revision=configuration_revision+1,disabled_at=CASE WHEN $3 THEN now() ELSE NULL END WHERE owner_id=$1 AND id=$2").bind(owner).bind(id).bind(input.action=="disconnect").execute(&mut *tx).await?;
    if input.action == "disconnect" {
        sqlx::query("DELETE FROM exchange_credentials WHERE owner_id=$1 AND connection_id=$2")
            .bind(owner)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    } else {
        sqlx::query("INSERT INTO exchange_credentials(owner_id,connection_id,keychain_service) VALUES($1,$2,$3) ON CONFLICT(owner_id,connection_id) DO UPDATE SET keychain_service=EXCLUDED.keychain_service").bind(owner).bind(id).bind(input.keychain_service).execute(&mut *tx).await?;
    }
    // Fence any in-flight credential use. Reconnect never silently resumes an old request.
    sqlx::query("UPDATE jobs SET status='cancelled',generation=generation+1,lease_owner=NULL,lease_until=NULL,error_code='connection_configuration_changed' WHERE owner_id=$1 AND kind IN ('trade.sync','trade.export') AND body->>'connection_id'=$2 AND status IN ('queued','running','retry_wait','awaiting_input','blocked_capability')").bind(owner).bind(id.to_string()).execute(&mut *tx).await?;
    let v = json!({"connection_id":id,"revision":input.expected_revision+1,"status":if input.action=="disconnect"{"disconnected"}else{"configured"},"resume_policy":"create_new_sync","ledger_retained":true});
    Database::finish(&mut tx, owner, "exchange.control", key, &body, &v).await?;
    tx.commit().await?;
    Ok(v)
}

mod csv_mapping;
pub mod historical_export;

pub mod cycle_detail;
