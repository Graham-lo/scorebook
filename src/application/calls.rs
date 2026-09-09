use crate::{
    adapters::db::{Database, digest, event},
    application::Services,
    application::dto::*,
    domain::criteria,
    error::{Error, Result},
};
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use sqlx::{Postgres, Row, Transaction};
use uuid::Uuid;

pub async fn create(s: &Services, owner: Uuid, key: &str, input: CreateCall) -> Result<Value> {
    if input.original_text.trim().is_empty() && input.attachments.is_empty() {
        return Err(Error::bad("empty_call"));
    }
    if input.original_text.len() > 1_000_000
        || input.attachments.len() > 20
        || input.criteria.len() > 20
    {
        return Err(Error::bad("input_too_large"));
    }
    if !matches!(
        input.path.as_str(),
        "unknown" | "chart_first" | "thought_first" | "interwoven"
    ) || !matches!(input.stance.as_str(), "unknown" | "L" | "S" | "?" | "C")
    {
        return Err(Error::bad("invalid_path_or_stance"));
    }
    if input.confidence.is_some_and(|x| x > 100) {
        return Err(Error::bad("invalid_confidence"));
    }
    if input
        .market
        .as_ref()
        .is_some_and(|x| !matches!(x.as_str(), "usd_m" | "coin_m"))
    {
        return Err(Error::bad("invalid_market"));
    }
    let body = serde_json::to_value(&input).unwrap();
    let (mut tx, cached) = s.db.write(owner, "calls.create", key, &body).await?;
    if let Some(v) = cached {
        return Ok(v);
    }
    let id = Uuid::new_v4();
    let instrument_snapshot: Option<Value> = if let (Some(market), Some(symbol)) =
        (&input.market, &input.instrument)
    {
        sqlx::query_scalar("SELECT to_jsonb(i) FROM instrument_catalog i WHERE venue='binance' AND market=$1 AND symbol=$2").bind(market).bind(symbol).fetch_optional(&mut *tx).await?
    } else {
        None
    };
    // Unknown rule version is a contract mismatch; missing criteria remains saveable.
    if input.criteria.iter().any(|c| c.version != "criteria-v1") {
        return Err(Error::bad("unknown_rule_version"));
    }
    if let Some(related) = input.related_call {
        require_call(&mut tx, owner, related).await?;
    }
    for attachment in &input.attachments {
        let exists:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM attachments WHERE owner_id=$1 AND id=$2 AND kind<>'query')").bind(owner).bind(attachment).fetch_one(&mut *tx).await?;
        if !exists {
            return Err(Error::bad("invalid_attachment_reference"));
        }
    }
    let submitted:DateTime<Utc>=sqlx::query_scalar("INSERT INTO calls(id,owner_id,body,digest,original_text,instrument,market,timeframe) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING submitted_at").bind(id).bind(owner).bind(&body).bind(digest(&body)).bind(&input.original_text).bind(&input.instrument).bind(&input.market).bind(&input.timeframe).fetch_one(&mut *tx).await?;
    sqlx::query("INSERT INTO call_state(owner_id,call_id) VALUES($1,$2)")
        .bind(owner)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    for a in &input.attachments {
        sqlx::query("INSERT INTO call_attachments VALUES($1,$2,$3) ON CONFLICT DO NOTHING")
            .bind(owner)
            .bind(id)
            .bind(a)
            .execute(&mut *tx)
            .await?;
    }
    for tag in &input.tags {
        sqlx::query("INSERT INTO call_tags VALUES($1,$2,$3,'hot') ON CONFLICT DO NOTHING")
            .bind(owner)
            .bind(id)
            .bind(tag)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(version) = input.playbook_id {
        sqlx::query("INSERT INTO adoptions(owner_id,call_id,playbook_id) VALUES($1,$2,$3)")
            .bind(owner)
            .bind(id)
            .bind(version)
            .execute(&mut *tx)
            .await?;
    }
    let parsed: Vec<Value> = if input.criteria.is_empty() {
        vec![json!({"claim_no":0,"state":"no_criteria","reason":"no_explicit_criteria"})]
    } else {
        input.criteria.iter().enumerate().map(|(n,c)|match criteria::validate(c){Err(e)=>json!({"claim_no":n,"state":"no_criteria","reason":e}),Ok(()) if c.template==criteria::Template::T0=>json!({"claim_no":n,"state":"no_criteria"}),_=>json!({"claim_no":n,"state":"insufficient_data","reason":"market_evidence_not_acquired"})}).collect()
    };
    // A fixed episode anchor; suggestions are never treated as confirmation.
    if let (Some(inst), Some(market)) = (&input.instrument, &input.market)
        && market != "us_equity"
    {
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,2))")
            .bind(format!("{owner}:{market}:{inst}"))
            .execute(&mut *tx)
            .await?;
        let previous:Option<Uuid>=sqlx::query_scalar("SELECT id FROM episodes WHERE owner_id=$1 AND instrument=$2 AND market=$3 AND anchor_at<=$4 AND end_at>=$4 ORDER BY anchor_at DESC,id DESC LIMIT 1").bind(owner).bind(inst).bind(market).bind(submitted).fetch_optional(&mut *tx).await?;
        let episode = previous.unwrap_or_else(Uuid::new_v4);
        if previous.is_none() {
            sqlx::query("INSERT INTO episodes VALUES($1,$2,$3,$4,$5,$6)")
                .bind(episode)
                .bind(owner)
                .bind(inst)
                .bind(market)
                .bind(submitted)
                .bind(submitted + chrono::Duration::hours(120))
                .execute(&mut *tx)
                .await?;
        }
        sqlx::query("INSERT INTO episode_links(id,owner_id,episode_id,call_id,status) VALUES($1,$2,$3,$4,$5)").bind(Uuid::new_v4()).bind(owner).bind(episode).bind(id).bind(if previous.is_none(){"explicit"}else{"suggested"}).execute(&mut *tx).await?;
    }
    event(
        &mut tx,
        owner,
        Some(id),
        "call.created",
        json!({"criteria_status":parsed}),
    )
    .await?;
    if input.criteria.is_empty() {
        crate::application::jobs::enqueue_tx(
            &mut tx,
            owner,
            "assess",
            &format!("{id}:0"),
            json!({"call_id":id,"claim_no":0}),
        )
        .await?;
    } else {
        for (n, c) in input.criteria.iter().enumerate() {
            let jid = crate::application::jobs::enqueue_tx(
                &mut tx,
                owner,
                "assess",
                &format!("{id}:{n}"),
                json!({"call_id":id,"claim_no":n}),
            )
            .await?;
            if criteria::validate(c).is_ok() && c.template != criteria::Template::T0 {
                let hours = if c.template == criteria::Template::T3 {
                    c.trigger.as_ref().map(|t| t.window_hours).unwrap_or(0)
                        + c.horizon_hours.unwrap_or(72)
                } else {
                    c.horizon_hours.unwrap_or(72)
                };
                sqlx::query("UPDATE jobs SET run_after=$2 WHERE id=$1")
                    .bind(jid)
                    .bind(submitted + chrono::Duration::hours(hours.into()))
                    .execute(&mut *tx)
                    .await?;
            }
        }
    }
    event(&mut tx,owner,Some(id),"instrument.frozen",json!({"contract":instrument_snapshot,"status":if instrument_snapshot.is_some(){"registered_contract"}else{"unverified_symbol"}})).await?;
    let response = json!({"id":id,"display_id":format!("C-{}-{}",submitted.format("%Y%m%d"),&id.simple().to_string()[..8]),"submitted_at":submitted,"revision":0,"criteria_status":parsed,"evidence_identity":if input.original_claimed_at.is_some(){"historical_unverified"}else{"submitted_now"}});
    Database::finish(&mut tx, owner, "calls.create", key, &body, &response).await?;
    tx.commit().await?;
    Ok(response)
}
pub async fn require_call(tx: &mut Transaction<'_, Postgres>, owner: Uuid, id: Uuid) -> Result<()> {
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM calls WHERE owner_id=$1 AND id=$2)")
            .bind(owner)
            .bind(id)
            .fetch_one(&mut **tx)
            .await?;
    if !exists {
        return Err(Error::not_found());
    }
    Ok(())
}
pub async fn bump(
    tx: &mut Transaction<'_, Postgres>,
    owner: Uuid,
    id: Uuid,
    expected: i64,
) -> Result<()> {
    let n=sqlx::query("UPDATE call_state SET revision=revision+1 WHERE owner_id=$1 AND call_id=$2 AND revision=$3").bind(owner).bind(id).bind(expected).execute(&mut **tx).await?.rows_affected();
    if n == 0 {
        return Err(Error::conflict("revision_conflict"));
    }
    Ok(())
}
pub async fn get(s: &Services, owner: Uuid, id: Uuid) -> Result<Value> {
    let mut tx = s.db.pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        .execute(&mut *tx)
        .await?;
    let row=sqlx::query("SELECT to_jsonb(c)-'owner_id' AS call, st.revision,st.voided FROM calls c JOIN call_state st ON st.owner_id=c.owner_id AND st.call_id=c.id WHERE c.owner_id=$1 AND c.id=$2").bind(owner).bind(id).fetch_optional(&mut *tx).await?.ok_or_else(Error::not_found)?;
    let mut v: Value = row.get("call");
    v["revision"] = json!(row.get::<i64, _>("revision"));
    v["voided"] = json!(row.get::<bool, _>("voided"));
    for (key, sql) in [
        (
            "attachments",
            "SELECT COALESCE(jsonb_agg(to_jsonb(a)-'owner_id'),'[]') FROM attachments a JOIN call_attachments l ON l.owner_id=a.owner_id AND l.attachment_id=a.id WHERE l.owner_id=$1 AND l.call_id=$2",
        ),
        (
            "events",
            "SELECT COALESCE(jsonb_agg(to_jsonb(e)-'owner_id' ORDER BY sequence),'[]') FROM events e WHERE owner_id=$1 AND call_id=$2",
        ),
        (
            "reviews",
            "SELECT COALESCE(jsonb_agg(to_jsonb(r)-'owner_id' ORDER BY created_at),'[]') FROM reviews r WHERE owner_id=$1 AND call_id=$2",
        ),
        (
            "outcomes",
            "SELECT COALESCE(jsonb_agg(to_jsonb(o)-'owner_id' ORDER BY created_at),'[]') FROM outcomes o WHERE owner_id=$1 AND call_id=$2",
        ),
        (
            "episode_links",
            "SELECT COALESCE(jsonb_agg(to_jsonb(e)-'owner_id' ORDER BY created_at),'[]') FROM episode_links e WHERE owner_id=$1 AND call_id=$2",
        ),
        (
            "tags",
            "SELECT COALESCE(jsonb_agg(to_jsonb(t)-'owner_id'),'[]') FROM tags t JOIN call_tags l ON t.id=l.tag_id AND t.owner_id=l.owner_id WHERE l.owner_id=$1 AND l.call_id=$2",
        ),
        (
            "adoptions",
            "SELECT COALESCE(jsonb_agg(to_jsonb(a)-'owner_id'),'[]') FROM adoptions a WHERE owner_id=$1 AND call_id=$2",
        ),
    ] {
        v[key] = sqlx::query_scalar(sql)
            .bind(owner)
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(v)
}
pub async fn list(s: &Services, owner: Uuid, f: CallFilter) -> Result<Value> {
    let limit = f.limit.unwrap_or(5).clamp(1, 100);
    let mut cursor_at = None;
    let mut cursor_id = None;
    if let Some(cursor) = &f.cursor {
        let (at, id) = cursor
            .split_once('|')
            .ok_or_else(|| Error::bad("invalid_cursor"))?;
        cursor_at = Some(
            DateTime::parse_from_rfc3339(at)
                .map_err(|_| Error::bad("invalid_cursor"))?
                .with_timezone(&Utc),
        );
        cursor_id = Some(Uuid::parse_str(id).map_err(|_| Error::bad("invalid_cursor"))?);
    }
    // Literal substring fallback intentionally supports single Chinese characters and escapes SQL wildcards.
    let query = f.q.map(|v| {
        format!(
            "%{}%",
            v.replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_")
        )
    });
    let rows=sqlx::query("SELECT c.id,c.submitted_at,c.body,st.revision,st.voided FROM calls c JOIN call_state st ON st.owner_id=c.owner_id AND st.call_id=c.id WHERE c.owner_id=$1 AND ($2::text IS NULL OR c.original_text ILIKE $2) AND ($3::text IS NULL OR c.instrument=$3) AND ($4::text IS NULL OR c.market=$4) AND ($5::text IS NULL OR c.timeframe=$5) AND ($6::timestamptz IS NULL OR (c.submitted_at,c.id)<($6,$7)) AND ($8::timestamptz IS NULL OR c.submitted_at<=$8) AND ($9::text IS NULL OR EXISTS(SELECT 1 FROM call_tags ct JOIN tags t ON ct.owner_id=t.owner_id AND ct.tag_id=t.id WHERE ct.owner_id=c.owner_id AND ct.call_id=c.id AND (t.name=$9 OR $9=ANY(t.aliases)))) ORDER BY c.submitted_at DESC,c.id DESC LIMIT $10")
 .bind(owner).bind(query).bind(f.instrument).bind(f.market).bind(f.timeframe).bind(cursor_at).bind(cursor_id).bind(f.before).bind(f.tag).bind(limit+1).fetch_all(&s.db.pool).await?;
    let more = rows.len() > limit as usize;
    let items:Vec<Value>=rows.iter().take(limit as usize).map(|r|json!({"id":r.get::<Uuid,_>("id"),"submitted_at":r.get::<DateTime<Utc>,_>("submitted_at"),"body":r.get::<Value,_>("body"),"revision":r.get::<i64,_>("revision"),"voided":r.get::<bool,_>("voided")})).collect();
    let next = if more {
        let r = &rows[limit as usize - 1];
        Some(format!(
            "{}|{}",
            r.get::<DateTime<Utc>, _>("submitted_at").to_rfc3339(),
            r.get::<Uuid, _>("id")
        ))
    } else {
        None
    };
    Ok(
        json!({"items":items,"next_cursor":next,"sort":"submitted_at_desc,id_desc","search_policy":"literal_substring_v1"}),
    )
}
pub async fn void(s: &Services, owner: Uuid, id: Uuid, key: &str, input: Change) -> Result<Value> {
    if input.reason.trim().is_empty() {
        return Err(Error::bad("reason_required"));
    }
    let body = json!(input);
    let op = format!("calls.void.{id}");
    let (mut tx, cached) = s.db.write(owner, &op, key, &body).await?;
    if let Some(v) = cached {
        return Ok(v);
    }
    require_call(&mut tx, owner, id).await?;
    bump(&mut tx, owner, id, input.expected_revision).await?;
    sqlx::query("UPDATE call_state SET voided=true WHERE owner_id=$1 AND call_id=$2")
        .bind(owner)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    event(&mut tx, owner, Some(id), "call.voided", body.clone()).await?;
    let v = json!({"id":id,"revision":input.expected_revision+1,"voided":true,"outcomes_retained":true});
    Database::finish(&mut tx, owner, &op, key, &body, &v).await?;
    tx.commit().await?;
    Ok(v)
}
pub async fn upload(
    s: &Services,
    owner: Uuid,
    key: &str,
    bytes: Vec<u8>,
    kind: String,
    captured_at: Option<DateTime<Utc>>,
) -> Result<Value> {
    if !matches!(
        kind.as_str(),
        "scene" | "supplement" | "reference" | "query"
    ) {
        return Err(Error::bad("invalid_attachment_kind"));
    }
    if captured_at.is_some_and(|x| x > Utc::now()) {
        return Err(Error::bad("future_capture_time"));
    }
    let body = json!({"digest":crate::adapters::db::hash_bytes(&bytes),"kind":kind,"captured_at":captured_at});
    let id = Uuid::new_v4();
    let storage = s.storage.clone();
    let size = bytes.len();
    let meta = tokio::task::spawn_blocking(move || storage.publish(owner, id, &bytes))
        .await
        .map_err(|_| Error::bad("image_decode_failed"))??;
    let (mut tx, cached) = s.db.write(owner, "attachments.upload", key, &body).await?;
    if let Some(v) = cached {
        let _ = tokio::fs::remove_file(s.storage.path(owner, id)).await;
        return Ok(v);
    }
    sqlx::query("INSERT INTO attachments(id,owner_id,sha256,mime,size,width,height,kind,captured_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)").bind(id).bind(owner).bind(&meta.digest).bind(&meta.mime).bind(size as i64).bind(meta.width as i32).bind(meta.height as i32).bind(&kind).bind(captured_at).execute(&mut *tx).await?;
    if kind != "query" {
        crate::application::jobs::enqueue_tx(
            &mut tx,
            owner,
            "embed",
            &id.to_string(),
            json!({"attachment_id":id,"model_id":"candle-profile-v1"}),
        )
        .await?;
    }
    if kind != "query" && s.vision.url.is_some() {
        crate::application::jobs::enqueue_tx(
            &mut tx,
            owner,
            "embed",
            &format!("{id}:dinov2-small-v1"),
            json!({"attachment_id":id,"model_id":"dinov2-small-v1"}),
        )
        .await?;
    }
    let v = json!({"id":id,"sha256":meta.digest,"mime":meta.mime,"width":meta.width,"height":meta.height,"kind":kind,"captured_at":captured_at,"capture_time_proven":false});
    Database::finish(&mut tx, owner, "attachments.upload", key, &body, &v).await?;
    tx.commit().await?;
    Ok(v)
}
