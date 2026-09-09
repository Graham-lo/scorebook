use super::*;
pub(super) async fn evaluation_preview(Json(v): Json<criteria::EvaluationInput>) -> Json<Value> {
    envelope(json!({"result":criteria::evaluate(&v),"identity":"sandbox_not_official_outcome"}))
}
pub(super) async fn replay_create(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
    Json(v): Json<criteria::EvaluationInput>,
) -> Result<Json<Value>> {
    Ok(envelope(
        crate::application::evaluation::replay(&s, o, id, key(&h)?, v).await?,
    ))
}
pub(super) async fn set_create(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    h: HeaderMap,
    Json(v): Json<crate::application::sets::SetInput>,
) -> Result<Json<Value>> {
    Ok(envelope(
        crate::application::sets::resolve(&s, o, key(&h)?, v).await?,
    ))
}
pub(super) async fn set_get(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    Ok(envelope(crate::application::sets::get(&s, o, id).await?))
}
