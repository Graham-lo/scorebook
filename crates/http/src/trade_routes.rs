use super::*;
use scorebook_core::api::trades::*;
pub fn routes() -> Router<Services> {
    Router::new()
        .route("/v1/exchange-exports/{id}/mapping", post(export_mapping))
        .route("/v1/exchange-exports", post(export_create))
        .route("/v1/exchange-exports/{id}", get(export_get))
        .route("/v1/exchange-exports/{id}/resolve", post(export_resolve))
        .route("/v1/exchange-connections/{id}/control", post(control))
        .route(
            "/v1/exchange-connections",
            get(connections).post(connection),
        )
        .route("/v1/imports", get(imports).post(import))
        .route("/v1/imports/{id}", get(import_get))
        .route("/v1/imports/csv", post(csv_import))
        .route("/v1/trades", get(fills))
        .route("/v1/trade-cycles", get(cycles))
        .route("/v1/position-seeds", post(seed))
        .route("/v1/reconciliations", post(reconcile))
        .route("/v1/execution-links", post(link))
        .route("/v1/exchange-syncs", post(sync))
        .route("/v1/exchange-syncs/{id}", get(sync_get))
}
macro_rules! write_route {
    ($name:ident,$input:ty,$action:ident) => {
        async fn $name(
            State(s): State<Services>,
            Extension(o): Extension<Uuid>,
            h: HeaderMap,
            Json(v): Json<$input>,
        ) -> Result<Json<Value>> {
            invoke(&s, o, Action::$action, None, Some(key(&h)?), json!(v)).await
        }
    };
}
write_route!(connection, ExchangeConnectionInput, ExchangeConnect);
write_route!(import, TradeImportInput, TradeImport);
write_route!(csv_import, CsvImportInput, TradeCsvImport);
write_route!(seed, PositionSeedInput, TradeSeed);
write_route!(reconcile, ReconciliationInput, TradeReconcile);
write_route!(link, ExecutionLinkInput, ExecutionLink);
write_route!(sync, ExchangeSyncInput, ExchangeSync);
async fn connections(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Query(v): Query<ImportFilter>,
) -> Result<Json<Value>> {
    invoke(&s, o, Action::ExchangeConnections, None, None, json!(v)).await
}
async fn imports(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Query(v): Query<ImportFilter>,
) -> Result<Json<Value>> {
    invoke(&s, o, Action::TradeImports, None, None, json!(v)).await
}
async fn import_get(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    invoke(&s, o, Action::TradeImportGet, Some(id), None, json!({})).await
}
async fn sync_get(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    invoke(&s, o, Action::ExchangeSyncGet, Some(id), None, json!({})).await
}
async fn fills(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Query(v): Query<TradeFilter>,
) -> Result<Json<Value>> {
    invoke(&s, o, Action::TradeFills, None, None, json!(v)).await
}
async fn cycles(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Query(v): Query<TradeFilter>,
) -> Result<Json<Value>> {
    invoke(&s, o, Action::TradeCycles, None, None, json!(v)).await
}

async fn control(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
    Json(v): Json<ConnectionControl>,
) -> Result<Json<Value>> {
    invoke(
        &s,
        o,
        Action::ConnectionControl,
        Some(id),
        Some(key(&h)?),
        json!(v),
    )
    .await
}

async fn export_create(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    h: HeaderMap,
    Json(v): Json<ExchangeExportInput>,
) -> Result<Json<Value>> {
    invoke(
        &s,
        o,
        Action::ExchangeExportCreate,
        None,
        Some(key(&h)?),
        json!(v),
    )
    .await
}
async fn export_get(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    invoke(&s, o, Action::ExchangeExportGet, Some(id), None, json!({})).await
}
async fn export_resolve(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
    Json(v): Json<ExportResolve>,
) -> Result<Json<Value>> {
    invoke(
        &s,
        o,
        Action::ExchangeExportResolve,
        Some(id),
        Some(key(&h)?),
        json!(v),
    )
    .await
}

async fn export_mapping(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
    Json(v): Json<ExportMappingUpdate>,
) -> Result<Json<Value>> {
    invoke(
        &s,
        o,
        Action::ExchangeExportMapping,
        Some(id),
        Some(key(&h)?),
        json!(v),
    )
    .await
}
