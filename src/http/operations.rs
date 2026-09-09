use super::*;
pub(super) async fn job_get(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    Ok(envelope(jobs::get(&s, o, id).await?))
}
pub(super) async fn export_create(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    h: HeaderMap,
) -> Result<Json<Value>> {
    Ok(envelope(exports::request(&s, o, key(&h)?).await?))
}
pub(super) async fn export_manifest(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Path(id): Path<Uuid>,
) -> Result<Response> {
    let j = jobs::get(&s, o, id).await?;
    if j["kind"] != "export" || j["status"] != "succeeded" {
        return Err(Error::conflict("export_not_ready"));
    }
    let bytes = tokio::fs::read(
        s.storage
            .root
            .join("exports")
            .join(o.to_string())
            .join(id.to_string())
            .join("manifest.json"),
    )
    .await?;
    Ok((
        [
            (header::CONTENT_TYPE, "application/json"),
            (header::CACHE_CONTROL, "private, no-store"),
        ],
        bytes,
    )
        .into_response())
}

pub(super) async fn delete_preview(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    h: HeaderMap,
    Json(v): Json<crate::application::lifecycle::DeletePreview>,
) -> Result<Json<Value>> {
    Ok(envelope(
        crate::application::lifecycle::preview(&s, o, key(&h)?, v).await?,
    ))
}
pub(super) async fn delete_confirm(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    h: HeaderMap,
    Json(v): Json<crate::application::lifecycle::DeleteConfirm>,
) -> Result<Json<Value>> {
    Ok(envelope(
        crate::application::lifecycle::confirm(&s, o, key(&h)?, v).await?,
    ))
}
