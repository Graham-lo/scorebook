use super::*;
pub(super) async fn call_create(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    h: HeaderMap,
    Json(v): Json<CreateCall>,
) -> Result<Json<Value>> {
    invoke(&s, o, Action::CallCreate, None, Some(key(&h)?), json!(v)).await
}
pub(super) async fn call_void(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
    Json(v): Json<Change>,
) -> Result<Json<Value>> {
    invoke(&s, o, Action::CallVoid, Some(id), Some(key(&h)?), json!(v)).await
}
pub(super) async fn attachment_index(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
    Json(v): Json<IndexRequest>,
) -> Result<Json<Value>> {
    invoke(
        &s,
        o,
        Action::AttachmentIndex,
        Some(id),
        Some(key(&h)?),
        json!(v),
    )
    .await
}
pub(super) async fn attachment_link(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
    Json(v): Json<api::record_changes::AttachmentLink>,
) -> Result<Json<Value>> {
    invoke(
        &s,
        o,
        Action::AttachmentLink,
        Some(id),
        Some(key(&h)?),
        json!(v),
    )
    .await
}
pub(super) async fn correction_create(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
    Json(v): Json<api::record_changes::Correction>,
) -> Result<Json<Value>> {
    invoke(
        &s,
        o,
        Action::Correction,
        Some(id),
        Some(key(&h)?),
        json!(v),
    )
    .await
}
pub(super) async fn revision_create(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
    Json(v): Json<CreateCall>,
) -> Result<Json<Value>> {
    invoke(
        &s,
        o,
        Action::CallRevision,
        Some(id),
        Some(key(&h)?),
        json!(v),
    )
    .await
}
pub(super) async fn call_get(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    invoke(&s, o, Action::CallGet, Some(id), None, json!({})).await
}
pub(super) async fn call_list(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Query(v): Query<CallFilter>,
) -> Result<Json<Value>> {
    invoke(&s, o, Action::CallList, None, None, json!(v)).await
}

#[derive(Serialize, Deserialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct IndexRequest {
    model_id: String,
}
pub(super) async fn preview(Json(v): Json<TextInput>) -> Json<Value> {
    envelope(json!(parser::preview(&v.text)))
}
pub(super) async fn attachment_upload(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    h: HeaderMap,
    mut upload: Multipart,
) -> Result<Json<Value>> {
    let _budget = s.upload_permit().await?;
    let mut bytes = None;
    let mut kind = "scene".to_string();
    let mut captured: Option<chrono::DateTime<chrono::Utc>> = None;
    let mut seen = std::collections::HashSet::new();
    while let Some(field) = upload
        .next_field()
        .await
        .map_err(|_| Error::bad("invalid_multipart"))?
    {
        let name = field.name().unwrap_or("").to_string();
        if !seen.insert(name.clone()) {
            return Err(Error::bad("duplicate_upload_field"));
        }
        match name.as_str() {
            "file" => {
                bytes = Some(
                    field
                        .bytes()
                        .await
                        .map_err(|_| Error::bad("invalid_upload"))?
                        .to_vec(),
                )
            }
            "kind" => kind = field.text().await.map_err(|_| Error::bad("invalid_kind"))?,
            "captured_at" => {
                captured = Some(
                    field
                        .text()
                        .await
                        .map_err(|_| Error::bad("invalid_capture_time"))?
                        .parse()
                        .map_err(|_| Error::bad("invalid_capture_time"))?,
                )
            }
            _ => return Err(Error::bad("unknown_upload_field")),
        }
    }
    let mut command = Command::new(
        o,
        Action::AttachmentUpload,
        json!({"kind":kind,"captured_at":captured}),
    );
    command.bytes = bytes;
    command.key = Some(key(&h)?.into());
    Ok(envelope(s.execute(command).await?))
}
pub(super) async fn attachment_download(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Path(id): Path<Uuid>,
) -> Result<Response> {
    resource_response(&s, o, id, Action::AttachmentDownload, json!({})).await
}

pub(super) async fn call_history(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Path(id): Path<Uuid>,
    Query(v): Query<api::review_workflow::HistoryFilter>,
) -> Result<Json<Value>> {
    invoke(&s, o, Action::CallHistory, Some(id), None, json!(v)).await
}
