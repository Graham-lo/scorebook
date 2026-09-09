use super::*;
pub(super) async fn job_retry(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
    Json(v): Json<api::jobs::RetryRequest>,
) -> Result<Json<Value>> {
    invoke(&s, o, Action::JobRetry, Some(id), Some(key(&h)?), json!(v)).await
}
pub(super) async fn outcome_revision(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
    Json(v): Json<api::settlement::RevisionRequest>,
) -> Result<Json<Value>> {
    invoke(
        &s,
        o,
        Action::OutcomeRevision,
        Some(id),
        Some(key(&h)?),
        json!(v),
    )
    .await
}
pub(super) async fn delete_preview(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    h: HeaderMap,
    Json(v): Json<api::lifecycle::DeletePreview>,
) -> Result<Json<Value>> {
    invoke(&s, o, Action::DeletePreview, None, Some(key(&h)?), json!(v)).await
}
pub(super) async fn delete_confirm(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    h: HeaderMap,
    Json(v): Json<api::lifecycle::DeleteConfirm>,
) -> Result<Json<Value>> {
    invoke(&s, o, Action::DeleteConfirm, None, Some(key(&h)?), json!(v)).await
}
pub(super) async fn job_get(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    invoke(&s, o, Action::JobGet, Some(id), None, json!({})).await
}

pub(super) async fn export_create(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    h: HeaderMap,
) -> Result<Json<Value>> {
    invoke(&s, o, Action::ExportCreate, None, Some(key(&h)?), json!({})).await
}
pub(super) async fn export_manifest(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Path(id): Path<Uuid>,
) -> Result<Response> {
    resource_response(
        &s,
        o,
        id,
        Action::ExportDownload,
        json!({"name":"manifest.json"}),
    )
    .await
}
pub(super) async fn export_file(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Path((id, name)): Path<(Uuid, String)>,
) -> Result<Response> {
    resource_response(&s, o, id, Action::ExportDownload, json!({"name":name})).await
}
pub(super) async fn resource_response(
    s: &Services,
    owner: Uuid,
    id: Uuid,
    action: Action,
    payload: Value,
) -> Result<Response> {
    let mut command = Command::new(owner, action, payload);
    command.subject = Some(id);
    let resource = s.resource(command).await?;
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        resource
            .content_type
            .parse()
            .map_err(|_| Error::bad("invalid_resource_type"))?,
    );
    if resource.attachment {
        headers.insert(
            header::CONTENT_DISPOSITION,
            axum::http::HeaderValue::from_static("attachment"),
        );
    }
    Ok((
        headers,
        axum::body::Body::from_stream(tokio_util::io::ReaderStream::new(resource.reader)),
    )
        .into_response())
}

pub(super) async fn assessment_source(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
    Json(v): Json<api::jobs::AssessmentSourcePlan>,
) -> Result<Json<Value>> {
    invoke(
        &s,
        o,
        Action::AssessmentSourcePlan,
        Some(id),
        Some(key(&h)?),
        json!(v),
    )
    .await
}
