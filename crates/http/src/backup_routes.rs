use super::*;
use scorebook_core::api::backups::*;
pub fn routes() -> Router<Services> {
    Router::new()
        .route("/v1/backups", get(status))
        .route("/v1/backups/configurations", post(configure))
        .route(
            "/v1/backups/configurations/{id}/initialize",
            post(initialize),
        )
        .route("/v1/backups/configurations/{id}/runs", post(request))
}
async fn status(State(s): State<Services>, Extension(o): Extension<Uuid>) -> Result<Json<Value>> {
    invoke(&s, o, Action::BackupStatus, None, None, json!({})).await
}
async fn configure(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    h: HeaderMap,
    Json(v): Json<BackupConfiguration>,
) -> Result<Json<Value>> {
    invoke(
        &s,
        o,
        Action::BackupConfigure,
        None,
        Some(key(&h)?),
        json!(v),
    )
    .await
}
async fn initialize(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Path(id): Path<Uuid>,
    Json(v): Json<BackupInitialize>,
) -> Result<Json<Value>> {
    invoke(&s, o, Action::BackupInitialize, Some(id), None, json!(v)).await
}
async fn request(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
) -> Result<Json<Value>> {
    invoke(
        &s,
        o,
        Action::BackupRequest,
        Some(id),
        Some(key(&h)?),
        json!({}),
    )
    .await
}
