use super::*;
use axum::http::StatusCode;
use scorebook_core::api::replay::*;
pub fn routes() -> Router<Services> {
    Router::new()
        .route(
            "/v1/attachments/{id}/location",
            put(location_put).delete(location_delete),
        )
        .route(
            "/v1/attachments/{id}/locate",
            get(locate_get).post(locate_request),
        )
        .route("/v1/calls/{id}/chart-setup", put(chart_setup_put))
        .route(
            "/v1/calls/{id}/replay",
            get(replay_get).delete(replay_clear),
        )
}
/// An Idempotency-Key is honoured when sent; these writes are upserts, so it is
/// not demanded the way it is on POST.
fn optional_key(h: &HeaderMap) -> Option<&str> {
    h.get("Idempotency-Key").and_then(|v| v.to_str().ok())
}
async fn location_put(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
    Json(v): Json<AttachmentLocation>,
) -> Result<Json<Value>> {
    invoke(
        &s,
        o,
        Action::AttachmentLocationPut,
        Some(id),
        optional_key(&h),
        json!(v),
    )
    .await
}
async fn location_delete(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
) -> Result<StatusCode> {
    let _ = invoke(
        &s,
        o,
        Action::AttachmentLocationDelete,
        Some(id),
        optional_key(&h),
        json!({}),
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}
async fn locate_get(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    invoke(
        &s,
        o,
        Action::AttachmentLocateGet,
        Some(id),
        None,
        json!({}),
    )
    .await
}
async fn locate_request(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
) -> Result<Json<Value>> {
    invoke(
        &s,
        o,
        Action::AttachmentLocateRequest,
        Some(id),
        optional_key(&h),
        json!({}),
    )
    .await
}
async fn chart_setup_put(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
    Json(v): Json<ChartSetup>,
) -> Result<Json<Value>> {
    invoke(
        &s,
        o,
        Action::ChartSetupPut,
        Some(id),
        optional_key(&h),
        json!(v),
    )
    .await
}
async fn replay_get(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    invoke(&s, o, Action::ReplayGet, Some(id), None, json!({})).await
}
async fn replay_clear(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Path(id): Path<Uuid>,
) -> Result<StatusCode> {
    let _ = invoke(&s, o, Action::ReplayClear, Some(id), None, json!({})).await?;
    Ok(StatusCode::NO_CONTENT)
}
