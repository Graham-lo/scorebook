use super::*;
pub(super) async fn similar_search(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    h: HeaderMap,
    Json(v): Json<SimilarityQuery>,
) -> Result<Json<Value>> {
    invoke(
        &s,
        o,
        Action::SimilaritySearch,
        None,
        Some(key(&h)?),
        json!(v),
    )
    .await
}
pub(super) async fn similar_feedback(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    h: HeaderMap,
    Json(v): Json<SimilarityFeedback>,
) -> Result<Json<Value>> {
    invoke(
        &s,
        o,
        Action::SimilarityFeedback,
        None,
        Some(key(&h)?),
        json!(v),
    )
    .await
}
pub(super) async fn search_get(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    invoke(&s, o, Action::SearchGet, Some(id), None, json!({})).await
}
