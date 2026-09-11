use super::*;
pub(super) async fn session_create(
    State(s): State<Services>,
    Extension(p): Extension<scorebook_core::access::Principal>,
    Json(v): Json<scorebook_core::access::SessionInput>,
) -> Result<Json<Value>> {
    let mut command = Command::new(p.owner, Action::SessionCreate, json!(v));
    command.principal = Some(p);
    Ok(envelope(s.execute(command).await?))
}
pub(super) async fn session_revoke(
    State(s): State<Services>,
    Extension(p): Extension<scorebook_core::access::Principal>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    let mut command = Command::new(p.owner, Action::SessionRevoke, json!({}));
    command.subject = Some(id);
    command.principal = Some(p);
    Ok(envelope(s.execute(command).await?))
}
