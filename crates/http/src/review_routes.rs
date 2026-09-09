use super::*;
pub(super) async fn draft_save(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
    Json(v): Json<api::review_workflow::DraftInput>,
) -> Result<Json<Value>> {
    invoke(&s, o, Action::DraftSave, Some(id), Some(key(&h)?), json!(v)).await
}
pub(super) async fn draft_publish(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
    Json(v): Json<api::review_workflow::PublishDraft>,
) -> Result<Json<Value>> {
    invoke(
        &s,
        o,
        Action::DraftPublish,
        Some(id),
        Some(key(&h)?),
        json!(v),
    )
    .await
}
pub(super) async fn review_snooze(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
    Json(v): Json<api::review_workflow::SnoozeInput>,
) -> Result<Json<Value>> {
    invoke(
        &s,
        o,
        Action::ReviewSnooze,
        Some(id),
        Some(key(&h)?),
        json!(v),
    )
    .await
}
pub(super) async fn draft_get(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    invoke(&s, o, Action::DraftGet, Some(id), None, json!({})).await
}

pub(super) async fn search_save(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
) -> Result<Json<Value>> {
    invoke(
        &s,
        o,
        Action::SearchSave,
        Some(id),
        Some(key(&h)?),
        json!({}),
    )
    .await
}
