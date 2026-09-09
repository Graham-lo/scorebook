use super::*;
pub(super) async fn review_create(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    h: HeaderMap,
    Json(v): Json<Review>,
) -> Result<Json<Value>> {
    invoke(&s, o, Action::ReviewCreate, None, Some(key(&h)?), json!(v)).await
}
pub(super) async fn tag_create(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    h: HeaderMap,
    Json(v): Json<TagInput>,
) -> Result<Json<Value>> {
    invoke(&s, o, Action::TagCreate, None, Some(key(&h)?), json!(v)).await
}
pub(super) async fn tag_add(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    h: HeaderMap,
    Json(v): Json<TagLink>,
) -> Result<Json<Value>> {
    invoke(&s, o, Action::TagLink, None, Some(key(&h)?), json!(v)).await
}
pub(super) async fn playbook_create(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    h: HeaderMap,
    Json(v): Json<PlaybookInput>,
) -> Result<Json<Value>> {
    invoke(
        &s,
        o,
        Action::PlaybookCreate,
        None,
        Some(key(&h)?),
        json!(v),
    )
    .await
}
pub(super) async fn episode_link(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    h: HeaderMap,
    Json(v): Json<EpisodeLink>,
) -> Result<Json<Value>> {
    invoke(&s, o, Action::EpisodeLink, None, Some(key(&h)?), json!(v)).await
}
pub(super) async fn episode_get(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    invoke(&s, o, Action::EpisodeGet, Some(id), None, json!({})).await
}
pub(super) async fn review_queue(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Query(v): Query<api::review_workflow::QueueFilter>,
) -> Result<Json<Value>> {
    invoke(&s, o, Action::ReviewQueue, None, None, json!(v)).await
}
pub(super) async fn tag_list(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Query(v): Query<Page>,
) -> Result<Json<Value>> {
    invoke(&s, o, Action::TagList, None, None, json!(v)).await
}
pub(super) async fn playbook_list(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Query(v): Query<Page>,
) -> Result<Json<Value>> {
    invoke(&s, o, Action::PlaybookList, None, None, json!(v)).await
}
pub(super) async fn episode_list(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Query(v): Query<Page>,
) -> Result<Json<Value>> {
    invoke(&s, o, Action::EpisodeList, None, None, json!(v)).await
}
pub(super) async fn event_list(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Query(v): Query<EventCursor>,
) -> Result<Json<Value>> {
    invoke(&s, o, Action::Events, None, None, json!(v)).await
}

pub(super) async fn draft_discard(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
    Json(v): Json<api::review_workflow::DiscardDraft>,
) -> Result<Json<Value>> {
    invoke(
        &s,
        o,
        Action::DraftDiscard,
        Some(id),
        Some(key(&h)?),
        json!(v),
    )
    .await
}
