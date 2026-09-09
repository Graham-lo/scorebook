use super::*;
use scorebook_core::api::knowledge_index::*;
pub fn routes() -> Router<Services> {
    Router::new()
        .route("/v1/knowledge/source/slice", post(slice))
        .route("/v1/images/index", get(images_status).post(images_index))
        .route("/v1/knowledge/search", post(search))
        .route("/v1/knowledge/source", post(source))
        .route("/v1/knowledge/index", get(status).post(index))
}
async fn search(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Json(v): Json<KnowledgeSearch>,
) -> Result<Json<Value>> {
    invoke(&s, o, Action::KnowledgeSemanticSearch, None, None, json!(v)).await
}
async fn source(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Json(v): Json<SourceRequest>,
) -> Result<Json<Value>> {
    invoke(&s, o, Action::KnowledgeSource, None, None, json!(v)).await
}
async fn status(State(s): State<Services>, Extension(o): Extension<Uuid>) -> Result<Json<Value>> {
    invoke(&s, o, Action::KnowledgeIndexStatus, None, None, json!({})).await
}
async fn index(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    h: HeaderMap,
) -> Result<Json<Value>> {
    invoke(
        &s,
        o,
        Action::KnowledgeIndexRequest,
        None,
        Some(key(&h)?),
        json!({}),
    )
    .await
}

async fn slice(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Json(v): Json<SourceSliceRequest>,
) -> Result<Json<Value>> {
    invoke(&s, o, Action::KnowledgeSourceSlice, None, None, json!(v)).await
}
async fn images_status(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
) -> Result<Json<Value>> {
    invoke(&s, o, Action::ImageIndexStatus, None, None, json!({})).await
}
async fn images_index(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    h: HeaderMap,
) -> Result<Json<Value>> {
    invoke(&s, o, Action::ImageReindex, None, Some(key(&h)?), json!({})).await
}
