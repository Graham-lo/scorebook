use super::*;
pub(super) async fn tool_list() -> Json<Value> {
    envelope(contract::tools())
}
pub(super) async fn tool_call(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Json(v): Json<ToolCall>,
) -> Result<Json<Value>> {
    Ok(envelope(knowledge::tool(&s, o, v).await?))
}
