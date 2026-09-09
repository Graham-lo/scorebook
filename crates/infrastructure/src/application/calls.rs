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
        vec![json!({"claim_no":0,"state":"queued","reason":"no_explicit_criteria"})]
    } else {
        input
            .criteria
            .iter()
            .enumerate()
            .map(|(n, c)| match criteria::validate(c) {
                Err(e) => json!({"claim_no":n,"state":"awaiting_input","reason":e}),
                Ok(()) if c.template == criteria::Template::T0 => {
                    json!({"claim_no":n,"state":"queued"})
                }
                _ => json!({"claim_no":n,"state":"queued","reason":"monitor_initializing"}),
            })
            .collect()
    };
    // A fixed episode anchor; suggestions are never treated as confirmation.
    if let (Some(inst), Some(market)) = (&input.instrument, &input.market) {
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
        sqlx::query("SELECT id FROM episodes WHERE owner_id=$1 AND id=$2 FOR UPDATE")
            .bind(owner)
            .bind(episode)
            .fetch_one(&mut *tx)
            .await?;
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
            let (state, reason, due) = if criteria::validate(c).is_err() {
                (
                    "awaiting_input",
                    Some("criteria_need_confirmation"),
                    submitted,
                )
            } else {
                ("queued", None, submitted)
            };
            sqlx::query("UPDATE jobs SET status=$2,error_code=$3,run_after=$4 WHERE id=$1")
                .bind(jid)
                .bind(state)
                .bind(reason)
                .bind(due)
                .execute(&mut *tx)
                .await?;
            sqlx::query("UPDATE assessments SET state=$2,reason=$3,due_at=$4 WHERE job_id=$1")
                .bind(jid)
                .bind(if due > submitted {
                    "waiting_due"
                } else {
                    state
                })
                .bind(reason)
                .bind(due)
                .execute(&mut *tx)
                .await?;
        }
    }
    event(&mut tx,owner,Some(id),"instrument.frozen",json!({"contract":instrument_snapshot,"status":if instrument_snapshot.is_some(){"registered_contract"}else{"unverified_symbol"}})).await?;
    super::knowledge_workflow::submission(&mut tx, owner, id, input.playbook_id).await?;
    super::review_projection::refresh(&mut tx, owner, id).await?;
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
    let mut v:Value=sqlx::query_scalar(r#"SELECT (to_jsonb(c)-'owner_id') || jsonb_build_object(
        'revision',st.revision,'voided',st.voided,
        'attachments',(SELECT COALESCE(jsonb_agg(to_jsonb(a)-'owner_id' ORDER BY a.uploaded_at,a.id),'[]') FROM attachments a JOIN call_attachments l ON l.owner_id=a.owner_id AND l.attachment_id=a.id WHERE l.owner_id=c.owner_id AND l.call_id=c.id),
        'events',(SELECT COALESCE(jsonb_agg(to_jsonb(e)-'owner_id' ORDER BY sequence),'[]') FROM (SELECT * FROM events WHERE owner_id=c.owner_id AND call_id=c.id ORDER BY sequence DESC LIMIT 21) e),
        'reviews',(SELECT COALESCE(jsonb_agg((to_jsonb(r)-'owner_id')||jsonb_build_object('outcome_ids',(SELECT COALESCE(jsonb_agg(outcome_id ORDER BY outcome_id),'[]') FROM review_outcome_refs rr WHERE rr.owner_id=r.owner_id AND rr.review_id=r.id)) ORDER BY created_at,id),'[]') FROM (SELECT * FROM reviews WHERE owner_id=c.owner_id AND call_id=c.id ORDER BY created_at DESC,id DESC LIMIT 21) r),
        'outcomes',(SELECT COALESCE(jsonb_agg(to_jsonb(o)-'owner_id' ORDER BY created_at,id),'[]') FROM (SELECT * FROM outcomes WHERE owner_id=c.owner_id AND call_id=c.id ORDER BY created_at DESC,id DESC LIMIT 21) o),
        'current_outcomes',(SELECT COALESCE(jsonb_agg((to_jsonb(o)-'owner_id')||jsonb_build_object('revision',h.revision) ORDER BY h.claim_no),'[]') FROM outcome_heads h JOIN outcomes o ON o.owner_id=h.owner_id AND o.id=h.outcome_id WHERE h.owner_id=c.owner_id AND h.call_id=c.id),
        'assessments',(SELECT COALESCE(jsonb_agg(to_jsonb(a)-'owner_id' ORDER BY claim_no),'[]') FROM assessments a WHERE a.owner_id=c.owner_id AND a.call_id=c.id),
        'episode_links',(SELECT COALESCE(jsonb_agg(to_jsonb(e)-'owner_id' ORDER BY created_at,id),'[]') FROM episode_links e WHERE e.owner_id=c.owner_id AND e.call_id=c.id),
        'tags',(SELECT COALESCE(jsonb_agg(to_jsonb(t)-'owner_id' ORDER BY t.name,t.id),'[]') FROM tags t JOIN call_tags l ON t.id=l.tag_id AND t.owner_id=l.owner_id WHERE l.owner_id=c.owner_id AND l.call_id=c.id),
        'submission_feedback',(SELECT body FROM submission_feedback WHERE owner_id=c.owner_id AND call_id=c.id),
        'adoptions',(SELECT COALESCE(jsonb_agg(to_jsonb(a)-'owner_id'),'[]') FROM adoptions a WHERE a.owner_id=c.owner_id AND a.call_id=c.id)
    ) FROM calls c JOIN call_state st ON st.owner_id=c.owner_id AND st.call_id=c.id WHERE c.owner_id=$1 AND c.id=$2"#).bind(owner).bind(id).fetch_optional(&s.db.pool).await?.ok_or_else(Error::not_found)?;
    let mut pages = json!({});
    for kind in ["events", "reviews", "outcomes"] {
        let items = v[kind].as_array_mut().expect("SQL arrays");
        let more = items.len() > 20;
        if more {
            items.remove(0);
        }
        let next = if more {
            items.first().map(|x| history_cursor(kind, x))
        } else {
            None
        };
        pages[kind] = json!({"next_cursor":next,"order":"oldest_to_newest_within_latest_page","url":format!("/v1/calls/{id}/history?kind={kind}")});
    }
    v["history_pages"] = pages;
    v["source_uri"] = json!(format!("scorebook://calls/{id}"));
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
    // Literal substring search supports single Chinese characters and escapes SQL wildcards.
    let short_query =
        f.q.as_ref()
            .filter(|v| v.chars().count() <= 2 && !v.is_empty())
            .cloned();
    let query = f.q.map(|v| {
        format!(
            "%{}%",
            v.replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_")
        )
    });
    let rows=sqlx::query("SELECT c.id,c.submitted_at,c.body,st.revision,st.voided FROM calls c JOIN call_state st ON st.owner_id=c.owner_id AND st.call_id=c.id WHERE c.owner_id=$1 AND ($11::text IS NULL OR literal_characters(c.original_text) @> literal_characters($11)) AND ($2::text IS NULL OR c.original_text ILIKE $2) AND ($3::text IS NULL OR c.instrument=$3) AND ($4::text IS NULL OR c.market=$4) AND ($5::text IS NULL OR c.timeframe=$5) AND ($6::timestamptz IS NULL OR (c.submitted_at,c.id)<($6,$7)) AND ($8::timestamptz IS NULL OR c.submitted_at<=$8) AND ($9::text IS NULL OR EXISTS(SELECT 1 FROM call_tags ct JOIN tags t ON ct.owner_id=t.owner_id AND ct.tag_id=t.id WHERE ct.owner_id=c.owner_id AND ct.call_id=c.id AND (t.name=$9 OR $9=ANY(t.aliases)))) ORDER BY c.submitted_at DESC,c.id DESC LIMIT $10")
 .bind(owner).bind(query).bind(f.instrument).bind(f.market).bind(f.timeframe).bind(cursor_at).bind(cursor_id).bind(f.before).bind(f.tag).bind(limit+1).bind(short_query).fetch_all(&s.db.pool).await?;
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
    super::review_projection::refresh(&mut tx, owner, id).await?;
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
    let size = bytes.len();
    sqlx::query("INSERT INTO storage_objects(owner_id,id,state) VALUES($1,$2,'pending')")
        .bind(owner)
        .bind(id)
        .execute(&s.db.pool)
        .await?;
    let meta = s.images.publish(owner, id, bytes).await?;
    let (mut tx, cached) = s.db.write(owner, "attachments.upload", key, &body).await?;
    if let Some(v) = cached {
        let _ = s.images.remove(owner, id).await;
        return Ok(v);
    }
    let object=sqlx::query("UPDATE storage_objects SET state='ready',updated_at=now() WHERE owner_id=$1 AND id=$2 AND state='pending'").bind(owner).bind(id).execute(&mut *tx).await?;
    if object.rows_affected() != 1 {
        let _ = s.images.remove(owner, id).await;
        return Err(Error::conflict("upload_expired"));
    }
    sqlx::query("INSERT INTO attachments(id,owner_id,sha256,mime,size,width,height,kind,captured_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)").bind(id).bind(owner).bind(&meta.digest).bind(&meta.mime).bind(size as i64).bind(meta.width as i32).bind(meta.height as i32).bind(&kind).bind(captured_at).execute(&mut *tx).await?;
    if kind != "query" {
        crate::application::jobs::enqueue_tx(
            &mut tx,
            owner,
            "embed",
            &format!("{id}:candle-geometry-v2"),
            json!({"attachment_id":id,"model_id":"candle-geometry-v2"}),
        )
        .await?;
    }
    if kind != "query" {
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

fn history_cursor(kind: &str, row: &Value) -> String {
    if kind == "events" {
        row["sequence"]
            .as_i64()
            .expect("event sequence")
            .to_string()
    } else {
        format!(
            "{}|{}",
            row["created_at"].as_str().expect("timestamp"),
            row["id"].as_str().expect("uuid")
        )
    }
}
/// Stable keyset pagination of immutable history. SQL identifiers come only from this allowlist.
pub async fn history(
    s: &Services,
    owner: Uuid,
    id: Uuid,
    filter: scorebook_core::api::review_workflow::HistoryFilter,
) -> Result<Value> {
    let kind = filter.kind.as_deref().unwrap_or("reviews");
    if !matches!(kind, "events" | "reviews" | "outcomes") {
        return Err(Error::bad("invalid_history_kind"));
    }
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM calls WHERE owner_id=$1 AND id=$2)")
            .bind(owner)
            .bind(id)
            .fetch_one(&s.db.pool)
            .await?;
    if !exists {
        return Err(Error::not_found());
    }
    let limit = filter.limit.unwrap_or(20).clamp(1, 100);
    let rows: Vec<Value> = if kind == "events" {
        let cursor = filter
            .cursor
            .map(|c| c.parse::<i64>().map_err(|_| Error::bad("invalid_cursor")))
            .transpose()?;
        sqlx::query_scalar("SELECT to_jsonb(e)-'owner_id' FROM events e WHERE owner_id=$1 AND call_id=$2 AND ($3::bigint IS NULL OR sequence<$3) ORDER BY sequence DESC LIMIT $4").bind(owner).bind(id).bind(cursor).bind(limit+1).fetch_all(&s.db.pool).await?
    } else {
        let (mut at, mut uuid) = (None, None);
        if let Some(cursor) = filter.cursor {
            let (date, key) = cursor
                .split_once('|')
                .ok_or_else(|| Error::bad("invalid_cursor"))?;
            at = Some(
                DateTime::parse_from_rfc3339(date)
                    .map_err(|_| Error::bad("invalid_cursor"))?
                    .with_timezone(&Utc),
            );
            uuid = Some(Uuid::parse_str(key).map_err(|_| Error::bad("invalid_cursor"))?);
        }
        let projection = if kind == "reviews" {
            "(to_jsonb(r)-'owner_id')||jsonb_build_object('outcome_ids',(SELECT COALESCE(jsonb_agg(outcome_id ORDER BY outcome_id),'[]') FROM review_outcome_refs rr WHERE rr.owner_id=r.owner_id AND rr.review_id=r.id))"
        } else {
            "to_jsonb(r)-'owner_id'"
        };
        sqlx::query_scalar(&format!("SELECT {projection} FROM {kind} r WHERE owner_id=$1 AND call_id=$2 AND ($3::timestamptz IS NULL OR (created_at,id)<($3,$4)) ORDER BY created_at DESC,id DESC LIMIT $5")).bind(owner).bind(id).bind(at).bind(uuid).bind(limit+1).fetch_all(&s.db.pool).await?
    };
    let more = rows.len() > limit as usize;
    let items: Vec<_> = rows.into_iter().take(limit as usize).collect();
    let cursor = if more {
        items.last().map(|r| history_cursor(kind, r))
    } else {
        None
    };
    Ok(
        json!({"items":items,"next_cursor":cursor,"kind":kind,"order":"newest_to_oldest","source_uri":format!("scorebook://calls/{id}/history/{kind}")}),
    )
}
