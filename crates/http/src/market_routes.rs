use super::*;
pub(super) async fn history_index(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    h: HeaderMap,
    Json(v): Json<api::history::HistoryIndexRequest>,
) -> Result<Json<Value>> {
    invoke(&s, o, Action::HistoryIndex, None, Some(key(&h)?), json!(v)).await
}
pub(super) async fn history_search(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    h: HeaderMap,
    Json(v): Json<api::history::HistorySearch>,
) -> Result<Json<Value>> {
    invoke(&s, o, Action::HistorySearch, None, Some(key(&h)?), json!(v)).await
}
pub(super) async fn history_plan_create(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    h: HeaderMap,
    Json(v): Json<api::history_plans::HistoryPlanRequest>,
) -> Result<Json<Value>> {
    invoke(
        &s,
        o,
        Action::HistoryPlanCreate,
        None,
        Some(key(&h)?),
        json!(v),
    )
    .await
}
pub(super) async fn history_plan_control(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
    Json(v): Json<api::history_plans::PlanControl>,
) -> Result<Json<Value>> {
    invoke(
        &s,
        o,
        Action::HistoryPlanControl,
        Some(id),
        Some(key(&h)?),
        json!(v),
    )
    .await
}
pub(super) async fn history_plan_get(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    invoke(&s, o, Action::HistoryPlanGet, Some(id), None, json!({})).await
}
pub(super) async fn history_indexes(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Query(v): Query<Page>,
) -> Result<Json<Value>> {
    invoke(&s, o, Action::HistoryIndexes, None, None, json!(v)).await
}
pub(super) async fn instruments(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Query(v): Query<api::instruments::InstrumentFilter>,
) -> Result<Json<Value>> {
    invoke(&s, o, Action::Instruments, None, None, json!(v)).await
}

pub(super) async fn market_data(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Json(v): Json<scorebook_core::domain::chart::ChartRequest>,
) -> Result<Json<Value>> {
    invoke(&s, o, Action::MarketData, None, None, json!(v)).await
}
pub(super) async fn market_chart(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Json(v): Json<scorebook_core::domain::chart::ChartRequest>,
) -> Result<Response> {
    let value = s
        .execute(Command::new(o, Action::MarketChart, json!(v)))
        .await?;
    let svg = value["svg"]
        .as_str()
        .ok_or_else(|| Error::bad("invalid_chart_response"))?
        .to_string();
    Ok((
        [
            (header::CONTENT_TYPE, "image/svg+xml"),
            (
                header::CONTENT_SECURITY_POLICY,
                "default-src 'none'; style-src 'unsafe-inline'; sandbox",
            ),
        ],
        svg,
    )
        .into_response())
}

pub(super) async fn history_coverage(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Query(v): Query<api::history::CoverageFilter>,
) -> Result<Json<Value>> {
    invoke(&s, o, Action::HistoryCoverage, None, None, json!(v)).await
}

pub(super) async fn history_revalidate(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
) -> Result<Json<Value>> {
    invoke(
        &s,
        o,
        Action::HistoryRevalidate,
        Some(id),
        Some(key(&h)?),
        json!({}),
    )
    .await
}
