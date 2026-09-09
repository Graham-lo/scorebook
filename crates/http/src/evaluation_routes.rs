use super::*;
pub(super) async fn replay_create(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
    Json(v): Json<criteria::EvaluationInput>,
) -> Result<Json<Value>> {
    invoke(&s, o, Action::Replay, Some(id), Some(key(&h)?), json!(v)).await
}
pub(super) async fn set_create(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    h: HeaderMap,
    Json(v): Json<api::sets::SetInput>,
) -> Result<Json<Value>> {
    invoke(&s, o, Action::SetCreate, None, Some(key(&h)?), json!(v)).await
}
pub(super) async fn set_get(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    invoke(&s, o, Action::SetGet, Some(id), None, json!({})).await
}

pub(super) async fn evaluation_preview(Json(v): Json<criteria::EvaluationInput>) -> Json<Value> {
    envelope(json!({"result":criteria::evaluate(&v),"identity":"sandbox_not_official_outcome"}))
}
