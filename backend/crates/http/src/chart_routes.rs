use super::*;
use scorebook_core::api::chart_search::*;
pub fn routes() -> Router<Services> {
    Router::new()
        .route("/v1/chart-analyses", post(analyze))
        .route("/v1/chart-search/runs", post(create))
        .route("/v1/chart-search/runs/{id}", get(read))
        .route("/v1/chart-search/runs/{id}/cancel", post(cancel))
}
async fn analyze(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    h: HeaderMap,
    Json(v): Json<ChartAnalysisInput>,
) -> Result<Json<Value>> {
    invoke(&s, o, Action::ChartAnalyze, None, Some(key(&h)?), json!(v)).await
}
async fn create(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    h: HeaderMap,
    Json(v): Json<ChartSearchInput>,
) -> Result<Json<Value>> {
    invoke(
        &s,
        o,
        Action::ChartSearchCreate,
        None,
        Some(key(&h)?),
        json!(v),
    )
    .await
}
async fn read(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    invoke(&s, o, Action::ChartSearchGet, Some(id), None, json!({})).await
}
async fn cancel(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
    Json(v): Json<SearchRunControl>,
) -> Result<Json<Value>> {
    invoke(
        &s,
        o,
        Action::ChartSearchCancel,
        Some(id),
        Some(key(&h)?),
        json!(v),
    )
    .await
}
