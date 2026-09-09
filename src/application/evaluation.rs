use super::Services;
use crate::{
    adapters::db::{Database, digest},
    domain::criteria::{EvaluationInput, evaluate},
    error::{Error, Result},
};
use serde_json::{Value, json};
use uuid::Uuid;
/// User supplied market input is exploratory replay, never silently an official original score.
pub async fn replay(
    s: &Services,
    owner: Uuid,
    id: Uuid,
    key: &str,
    input: EvaluationInput,
) -> Result<Value> {
    if input.bars.len() > 100_000 || input.trades.len() > 100_000 {
        return Err(Error::bad("evaluation_input_too_large"));
    }
    let body = json!({"criteria":input.criteria,"start":input.start,"evaluated_at":input.evaluated_at,"market_input_sha256":digest(&input),"market_input_storage":"not_persisted","replay_verification":"requires_provider_refetch"});
    let op = format!("replay.{id}");
    let (mut tx, cached) = s.db.write(owner, &op, key, &body).await?;
    if let Some(v) = cached {
        return Ok(v);
    }
    super::calls::require_call(&mut tx, owner, id).await?;
    let result = evaluate(&input);
    let mid = Uuid::new_v4();
    let oid = Uuid::new_v4();
    sqlx::query("INSERT INTO manifests(id,owner_id,call_id,digest,body) VALUES($1,$2,$3,$4,$5)")
        .bind(mid)
        .bind(owner)
        .bind(id)
        .bind(digest(&body))
        .bind(&body)
        .execute(&mut *tx)
        .await?;
    let business_digest = digest(&json!({"input":body,"result":result}));
    let _inserted:Uuid=sqlx::query_scalar("INSERT INTO outcomes(id,owner_id,call_id,claim_no,manifest_id,kind,result,digest) VALUES($1,$2,$3,0,$4,'rule_replay',$5,$6) ON CONFLICT(owner_id,call_id,claim_no,kind,digest) DO NOTHING RETURNING id").bind(oid).bind(owner).bind(id).bind(mid).bind(json!(result)).bind(&business_digest).fetch_optional(&mut *tx).await? .unwrap_or(oid);
    let stored=sqlx::query("SELECT id,manifest_id FROM outcomes WHERE owner_id=$1 AND call_id=$2 AND claim_no=0 AND kind='rule_replay' AND digest=$3").bind(owner).bind(id).bind(&business_digest).fetch_one(&mut *tx).await?;
    use sqlx::Row;
    let actual: Uuid = stored.get("id");
    let mid: Uuid = stored.get("manifest_id");
    let v = json!({"id":actual,"result":result,"kind":"rule_replay","formal_statistics_eligible":false,"manifest_id":mid});
    Database::finish(&mut tx, owner, &op, key, &body, &v).await?;
    tx.commit().await?;
    Ok(v)
}
