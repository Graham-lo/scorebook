use super::*;
pub(super) async fn review_create(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    h: HeaderMap,
    Json(v): Json<Review>,
) -> Result<Json<Value>> {
    Ok(envelope(knowledge::review(&s, o, key(&h)?, v).await?))
}
pub(super) async fn review_queue(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
) -> Result<Json<Value>> {
    Ok(envelope(knowledge::queue(&s, o).await?))
}
#[derive(Deserialize)]
pub(super) struct Page {
    cursor: Option<Uuid>,
}
pub(super) async fn tag_list(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Query(p): Query<Page>,
) -> Result<Json<Value>> {
    Ok(envelope(
        knowledge::collection(&s, o, "tags", p.cursor).await?,
    ))
}
pub(super) async fn tag_create(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    h: HeaderMap,
    Json(v): Json<TagInput>,
) -> Result<Json<Value>> {
    Ok(envelope(knowledge::tag(&s, o, key(&h)?, v).await?))
}
pub(super) async fn tag_add(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    h: HeaderMap,
    Json(v): Json<TagLink>,
) -> Result<Json<Value>> {
    Ok(envelope(knowledge::tag_link(&s, o, key(&h)?, v).await?))
}
pub(super) async fn playbook_list(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Query(p): Query<Page>,
) -> Result<Json<Value>> {
    Ok(envelope(
        knowledge::collection(&s, o, "playbooks", p.cursor).await?,
    ))
}
pub(super) async fn playbook_create(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    h: HeaderMap,
    Json(v): Json<PlaybookInput>,
) -> Result<Json<Value>> {
    Ok(envelope(knowledge::playbook(&s, o, key(&h)?, v).await?))
}
pub(super) async fn episode_list(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Query(p): Query<Page>,
) -> Result<Json<Value>> {
    Ok(envelope(
        knowledge::collection(&s, o, "episodes", p.cursor).await?,
    ))
}
pub(super) async fn episode_get(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    Ok(envelope(knowledge::episode(&s, o, id).await?))
}
pub(super) async fn episode_link(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    h: HeaderMap,
    Json(v): Json<EpisodeLink>,
) -> Result<Json<Value>> {
    Ok(envelope(knowledge::link(&s, o, key(&h)?, v).await?))
}
#[derive(Deserialize)]
pub(super) struct EventCursor {
    #[serde(default)]
    after: i64,
}
pub(super) async fn event_list(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Query(p): Query<EventCursor>,
) -> Result<Json<Value>> {
    Ok(envelope(knowledge::events(&s, o, p.after).await?))
}
