use super::*;
pub(super) async fn health(State(s): State<Services>) -> Result<Json<Value>> {
    sqlx::query("SELECT 1").execute(&s.db.pool).await?;
    Ok(envelope(
        json!({"status":"ok","version":env!("CARGO_PKG_VERSION")}),
    ))
}
pub(super) async fn capabilities(State(s): State<Services>) -> Json<Value> {
    envelope(
        json!({"records":"available","reviews":"available","market_binance":"contracts_only","default_market":"usd_m","image_structure_search":"available_baseline","image_visual_search":if s.vision.url.is_some(){"configured"}else{"not_configured"},"vector_database":"pgvector","model_knowledge_tools":"available_read_only","chat_generation":"planned","exchange_accounts":"planned","desktop":"not_in_backend_scope","telegram":"not_configured","formal_statistics":"implementation_in_progress","provider_asof_trade_proof":"bounded_aggregate_trade_coverage;live_acceptance_pending"}),
    )
}
pub(super) async fn criteria_list() -> Json<Value> {
    envelope(
        json!({"version":"criteria-v1","templates":["T0","T1","T2","T3","T4","T5"],"default":"T0","path":"unknown","confidence":null,"numeric":"decimal34-half-even","crypto_default_hours":72,"threshold_atr_multiple":"1","volatility_atr_multiple":"1.5","trigger_default":"1m_bar_close"}),
    )
}
pub(super) async fn instruments(
    State(s): State<Services>,
    Query(f): Query<crate::application::instruments::InstrumentFilter>,
) -> Result<Json<Value>> {
    Ok(envelope(
        crate::application::instruments::list(&s, f).await?,
    ))
}
