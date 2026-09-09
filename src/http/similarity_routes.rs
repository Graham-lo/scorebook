use super::*;
pub(super) async fn similar_search(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    h: HeaderMap,
    Json(v): Json<SimilarityQuery>,
) -> Result<Json<Value>> {
    Ok(envelope(similarity::search(&s, o, key(&h)?, v).await?))
}
pub(super) async fn similar_feedback(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    h: HeaderMap,
    Json(v): Json<SimilarityFeedback>,
) -> Result<Json<Value>> {
    Ok(envelope(similarity::feedback(&s, o, key(&h)?, v).await?))
}
