use super::*;
use scorebook_core::api::knowledge_workflow::*;
pub fn routes() -> Router<Services> {
    Router::new()
        .route("/v1/playbooks/{id}/transitions", post(transition))
        .route("/v1/tags/{id}/revisions", post(revise_tag))
        .route("/v1/episodes/{id}/review-context", get(context))
        .route("/v1/episodes/{id}/reviews", post(review))
}
macro_rules! write {
    ($name:ident,$input:ty,$action:ident) => {
        async fn $name(
            State(s): State<Services>,
            Extension(o): Extension<Uuid>,
            Path(id): Path<Uuid>,
            h: HeaderMap,
            Json(v): Json<$input>,
        ) -> Result<Json<Value>> {
            invoke(&s, o, Action::$action, Some(id), Some(key(&h)?), json!(v)).await
        }
    };
}
write!(transition, PlaybookTransition, PlaybookTransition);
write!(revise_tag, TagRevision, TagRevision);
write!(review, EpisodeReview, EpisodeReview);
async fn context(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    invoke(
        &s,
        o,
        Action::EpisodeReviewContext,
        Some(id),
        None,
        json!({}),
    )
    .await
}
