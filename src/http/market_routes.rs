use super::*;
pub(super) async fn market_data(
    State(_s): State<Services>,
    Json(v): Json<crate::domain::chart::ChartRequest>,
) -> Result<Json<Value>> {
    Ok(envelope(crate::application::market::data(&v).await?))
}
pub(super) async fn market_chart(
    Json(v): Json<crate::domain::chart::ChartRequest>,
) -> Result<Response> {
    let svg = crate::application::market::svg(&v).await?;
    Ok((
        [
            (header::CONTENT_TYPE, "image/svg+xml"),
            (header::CACHE_CONTROL, "no-store"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        ],
        svg,
    )
        .into_response())
}
pub(super) async fn history_index(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    h: HeaderMap,
    Json(v): Json<crate::application::history::HistoryIndexRequest>,
) -> Result<Json<Value>> {
    Ok(envelope(
        crate::application::history::request(&s, o, key(&h)?, v).await?,
    ))
}
pub(super) async fn history_search(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    h: HeaderMap,
    Json(v): Json<crate::application::history::HistorySearch>,
) -> Result<Json<Value>> {
    Ok(envelope(
        crate::application::history::search(&s, o, key(&h)?, v).await?,
    ))
}
#[derive(Deserialize)]
pub(super) struct IndexPage {
    cursor: Option<Uuid>,
}
pub(super) async fn history_indexes(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Query(p): Query<IndexPage>,
) -> Result<Json<Value>> {
    Ok(envelope(
        crate::application::history::indexes(&s, o, p.cursor).await?,
    ))
}
