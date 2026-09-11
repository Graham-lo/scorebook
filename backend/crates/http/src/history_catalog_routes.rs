use super::*;
use scorebook_core::api::history_catalog::*;
pub fn routes() -> Router<Services> {
    Router::new()
        .route("/v1/history/catalog", get(catalog))
        .route("/v1/history/catalog/refresh", post(refresh))
        .route("/v1/history/plans/estimate", post(estimate))
        .route("/v1/history/subscriptions", post(subscribe))
        .route("/v1/history/subscriptions/{id}", get(subscription))
        .route("/v1/history/subscriptions/{id}/control", post(control))
        .route("/v1/history/subscriptions/{id}/budget", post(budget))
        .route("/v1/history/archive-catalog", post(archives))
}
async fn catalog(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Query(v): Query<HistoryCatalogFilter>,
) -> Result<Json<Value>> {
    invoke(&s, o, Action::HistoryCatalog, None, None, json!(v)).await
}
async fn refresh(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    h: HeaderMap,
) -> Result<Json<Value>> {
    invoke(
        &s,
        o,
        Action::HistoryCatalogRefresh,
        None,
        Some(key(&h)?),
        json!({}),
    )
    .await
}
async fn estimate(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Json(v): Json<HistoryEstimateInput>,
) -> Result<Json<Value>> {
    invoke(&s, o, Action::HistoryEstimate, None, None, json!(v)).await
}
async fn subscribe(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    h: HeaderMap,
    Json(v): Json<HistorySubscriptionInput>,
) -> Result<Json<Value>> {
    invoke(
        &s,
        o,
        Action::HistorySubscribe,
        None,
        Some(key(&h)?),
        json!(v),
    )
    .await
}
async fn subscription(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    invoke(
        &s,
        o,
        Action::HistorySubscriptionGet,
        Some(id),
        None,
        json!({}),
    )
    .await
}
async fn control(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
    Json(v): Json<api::history_plans::PlanControl>,
) -> Result<Json<Value>> {
    invoke(
        &s,
        o,
        Action::HistorySubscriptionControl,
        Some(id),
        Some(key(&h)?),
        json!(v),
    )
    .await
}
async fn archives(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Json(v): Json<ArchiveCatalogInput>,
) -> Result<Json<Value>> {
    invoke(&s, o, Action::ArchiveCatalog, None, None, json!(v)).await
}

pub async fn budget(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
    Json(v): Json<SubscriptionBudget>,
) -> Result<Json<Value>> {
    invoke(
        &s,
        o,
        Action::HistorySubscriptionBudget,
        Some(id),
        Some(key(&h)?),
        json!(v),
    )
    .await
}
