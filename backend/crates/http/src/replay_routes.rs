use super::*;
use axum::http::StatusCode;
use scorebook_core::api::replay::*;
pub fn routes() -> Router<Services> {
    Router::new()
        .route(
            "/v1/attachments/{id}/location-preview",
            post(location_preview),
        )
        .route(
            "/v1/attachments/{id}/location",
            put(location_put).delete(location_delete),
        )
        .route(
            "/v1/attachments/{id}/locate",
            get(locate_get).post(locate_request),
        )
        .route("/v1/calls/{id}/chart-setup", put(chart_setup_put))
        .route("/v1/attachments/{id}", patch(attachment_kind_put))
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
async fn location_preview(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Path(id): Path<Uuid>,
    Json(v): Json<AttachmentLocation>,
) -> Result<Json<Value>> {
    invoke(
        &s,
        o,
        Action::AttachmentLocationPreview,
        Some(id),
        None,
        json!(v),
    )
    .await
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
/// 按图指定品种：body 可以整个省掉，省掉就沿用记录的 instrument。
async fn locate_request(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
    body: Option<Json<LocateOverride>>,
) -> Result<Json<Value>> {
    invoke(
        &s,
        o,
        Action::AttachmentLocateRequest,
        Some(id),
        optional_key(&h),
        json!(body.map(|Json(v)| v).unwrap_or_default()),
    )
    .await
}
async fn attachment_kind_put(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
    Json(v): Json<AttachmentKindUpdate>,
) -> Result<Json<Value>> {
    invoke(
        &s,
        o,
        Action::AttachmentKindPut,
        Some(id),
        optional_key(&h),
        json!(v),
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
    Query(q): Query<ReplayQuery>,
) -> Result<Json<Value>> {
    invoke(&s, o, Action::ReplayGet, Some(id), None, json!(q)).await
}
async fn replay_clear(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Path(id): Path<Uuid>,
) -> Result<StatusCode> {
    let _ = invoke(&s, o, Action::ReplayClear, Some(id), None, json!({})).await?;
    Ok(StatusCode::NO_CONTENT)
}
