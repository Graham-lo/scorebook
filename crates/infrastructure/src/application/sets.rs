//! Frozen exploratory collection snapshots. Never call mixed rules a formal win rate.
use crate::{
    adapters::db::Database,
    application::Services,
    error::{Error, Result},
};
pub use scorebook_core::api::sets::*;
use serde_json::{Value, json};
use uuid::Uuid;

pub async fn resolve(s: &Services, owner: Uuid, key: &str, input: SetInput) -> Result<Value> {
    if input.call_ids.len() > 10000 {
        return Err(Error::bad("set_too_large"));
    }
    let body = json!(input);
    let (mut tx, cached) = s.db.write(owner, "sets.resolve", key, &body).await?;
    if let Some(v) = cached {
        return Ok(v);
    }
    let ids: std::collections::BTreeSet<Uuid> = input.call_ids.iter().copied().collect();
    let rows:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',c.id,'submitted_at',c.submitted_at,'criteria',c.body->'criteria','instrument',c.instrument,'market',c.market,'voided',st.voided,'historical',c.body->'original_claimed_at','episode_link',(SELECT to_jsonb(el)-'owner_id' FROM episode_links el WHERE el.owner_id=c.owner_id AND el.call_id=c.id ORDER BY created_at DESC,id DESC LIMIT 1),'outcomes',COALESCE((SELECT jsonb_agg(to_jsonb(o)-'owner_id') FROM outcome_heads h JOIN outcomes o ON o.owner_id=h.owner_id AND o.id=h.outcome_id WHERE h.owner_id=c.owner_id AND h.call_id=c.id),'[]')) FROM calls c JOIN call_state st ON st.owner_id=c.owner_id AND st.call_id=c.id WHERE c.owner_id=$1 AND c.id=ANY($2) ORDER BY c.submitted_at,c.id").bind(owner).bind(ids.iter().copied().collect::<Vec<_>>()).fetch_all(&mut *tx).await?;
    if rows.len() != ids.len() {
        return Err(Error::bad("invalid_set_member"));
    }
    let mut samples = vec![];
    for row in &rows {
        let id: Uuid =
            serde_json::from_value(row["id"].clone()).map_err(|_| Error::bad("invalid_member"))?;
        let at = serde_json::from_value(row["submitted_at"].clone())
            .map_err(|_| Error::bad("invalid_member"))?;
        let raw = row["criteria"].as_array().cloned().unwrap_or_default();
        let claims = if raw.is_empty() {
            vec![json!(crate::domain::criteria::Criteria::default())]
        } else {
            raw
        };
        for (n, claim) in claims.iter().enumerate() {
            let c: crate::domain::criteria::Criteria =
                serde_json::from_value(claim.clone()).map_err(|_| Error::bad("invalid_claim"))?;
            let valid = crate::domain::criteria::validate(&c).is_ok()
                && c.template != crate::domain::criteria::Template::T0;
            let state = row["outcomes"]
                .as_array()
                .and_then(|xs| {
                    xs.iter()
                        .filter(|o| o["claim_no"].as_u64() == Some(n as u64))
                        .max_by_key(|o| o["created_at"].as_str().unwrap_or(""))
                })
                .and_then(|o| o["result"]["state"].as_str())
                .unwrap_or("pending");
            let confirmed = matches!(
                row["episode_link"]["status"].as_str(),
                Some("confirmed" | "explicit")
            );
            let ep = if confirmed {
                serde_json::from_value(row["episode_link"]["episode_id"].clone()).ok()
            } else {
                None
            };
            let mut signature = claim.clone();
            signature.as_object_mut().unwrap().remove("selected_by");
            samples.push(crate::domain::statistics::Sample {
                call_id: id,
                claim_no: n,
                submitted_at: at,
                episode_id: ep,
                group_pending: row["episode_link"]["status"] == "suggested",
                signature: crate::adapters::db::digest(&json!({"criteria":signature,"instrument":row["instrument"],"market":row["market"],"price_policy":"asof_last_eligible_trade"})),
                state: state.into(),
                eligible: valid && row["historical"].is_null(),
                voided: row["voided"] == true,
            });
        }
    }
    let mut stats = crate::domain::statistics::summarize(&samples, 0);
    stats["call_count"] = json!(rows.len());
    stats["identity"] = json!("exploratory_fixed_members");
    stats["members_complete"] = json!(true);
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO set_snapshots(id,owner_id,definition,members,stats) VALUES($1,$2,$3,$4,$5)",
    )
    .bind(id)
    .bind(owner)
    .bind(&body)
    .bind(json!(rows))
    .bind(&stats)
    .execute(&mut *tx)
    .await?;
    sqlx::query("INSERT INTO set_members SELECT $1,$2,unnest($3::uuid[]) ON CONFLICT DO NOTHING")
        .bind(owner)
        .bind(id)
        .bind(ids.into_iter().collect::<Vec<_>>())
        .execute(&mut *tx)
        .await?;
    let v = json!({"set_snapshot_id":id,"stats":stats});
    Database::finish(&mut tx, owner, "sets.resolve", key, &body, &v).await?;
    tx.commit().await?;
    Ok(v)
}
pub async fn get(s: &Services, owner: Uuid, id: Uuid) -> Result<Value> {
    sqlx::query_scalar(
        "SELECT to_jsonb(s)-'owner_id' FROM set_snapshots s WHERE owner_id=$1 AND id=$2",
    )
    .bind(owner)
    .bind(id)
    .fetch_optional(&s.db.pool)
    .await?
    .ok_or_else(Error::not_found)
}
