use super::*;
pub(super) async fn preview(Json(v): Json<TextInput>) -> Json<Value> {
    envelope(json!(parser::preview(&v.text)))
}
pub(super) async fn call_create(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    h: HeaderMap,
    Json(v): Json<CreateCall>,
) -> Result<Json<Value>> {
    Ok(envelope(calls::create(&s, o, key(&h)?, v).await?))
}
pub(super) async fn call_list(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Query(v): Query<CallFilter>,
) -> Result<Json<Value>> {
    Ok(envelope(calls::list(&s, o, v).await?))
}
pub(super) async fn call_get(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    Ok(envelope(calls::get(&s, o, id).await?))
}
pub(super) async fn call_void(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
    Json(v): Json<Change>,
) -> Result<Json<Value>> {
    Ok(envelope(calls::void(&s, o, id, key(&h)?, v).await?))
}
pub(super) async fn attachment_upload(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    h: HeaderMap,
    mut upload: Multipart,
) -> Result<Json<Value>> {
    let mut bytes = None;
    let mut kind = "scene".to_string();
    let mut captured = None;
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
                let t = field
                    .text()
                    .await
                    .map_err(|_| Error::bad("invalid_capture_time"))?;
                captured = Some(t.parse().map_err(|_| Error::bad("invalid_capture_time"))?);
            }
            _ => return Err(Error::bad("unknown_upload_field")),
        }
    }
    Ok(envelope(
        calls::upload(
            &s,
            o,
            key(&h)?,
            bytes.ok_or_else(|| Error::bad("file_required"))?,
            kind,
            captured,
        )
        .await?,
    ))
}
pub(super) async fn attachment_download(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Path(id): Path<Uuid>,
) -> Result<Response> {
    let mime: String =
        sqlx::query_scalar("SELECT mime FROM attachments WHERE owner_id=$1 AND id=$2")
            .bind(o)
            .bind(id)
            .fetch_optional(&s.db.pool)
            .await?
            .ok_or_else(Error::not_found)?;
    let bytes = tokio::fs::read(s.storage.path(o, id)).await?;
    Ok((
        [
            (header::CONTENT_TYPE, mime),
            (header::CACHE_CONTROL, "private, no-store".into()),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff".into()),
        ],
        bytes,
    )
        .into_response())
}
#[derive(Deserialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct IndexRequest {
    model_id: String,
}
pub(super) async fn attachment_index(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
    Json(v): Json<IndexRequest>,
) -> Result<Json<Value>> {
    if !matches!(v.model_id.as_str(), "candle-profile-v1" | "dinov2-small-v1") {
        return Err(Error::bad("unknown_model"));
    }
    let body = json!({"attachment_id":id,"model_id":v.model_id});
    let (mut tx, cached) = s.db.write(o, "attachments.index", key(&h)?, &body).await?;
    if let Some(v) = cached {
        return Ok(envelope(v));
    }
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM attachments WHERE owner_id=$1 AND id=$2)")
            .bind(o)
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
    if !exists {
        return Err(Error::not_found());
    }
    let job = jobs::enqueue_tx(
        &mut tx,
        o,
        "embed",
        &format!("{id}:{}", v.model_id),
        body.clone(),
    )
    .await?;
    let result = json!({"job_id":job,"status":"queued"});
    crate::adapters::db::Database::finish(
        &mut tx,
        o,
        "attachments.index",
        key(&h)?,
        &body,
        &result,
    )
    .await?;
    tx.commit().await?;
    Ok(envelope(result))
}
pub(super) async fn attachment_link(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
    Json(v): Json<crate::application::record_changes::AttachmentLink>,
) -> Result<Json<Value>> {
    Ok(envelope(
        crate::application::record_changes::supplement(&s, o, id, key(&h)?, v).await?,
    ))
}
pub(super) async fn correction_create(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
    Json(v): Json<crate::application::record_changes::Correction>,
) -> Result<Json<Value>> {
    Ok(envelope(
        crate::application::record_changes::correction(&s, o, id, key(&h)?, v).await?,
    ))
}
pub(super) async fn revision_create(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
    Json(mut v): Json<CreateCall>,
) -> Result<Json<Value>> {
    if v.related_call.is_some_and(|x| x != id) {
        return Err(Error::bad("conflicting_related_call"));
    }
    v.related_call = Some(id);
    Ok(envelope(calls::create(&s, o, key(&h)?, v).await?))
}
