use super::*;
use axum::response::sse::{Event, KeepAlive, Sse};
use scorebook_core::{access::Principal, api::chat::*};
pub fn routes() -> Router<Services> {
    Router::new()
        .route("/v1/chat/runs", post(create))
        .route("/v1/chat/runs/{id}", get(run))
        .route("/v1/chat/runs/{id}/cancel", post(cancel))
        .route("/v1/chat/runs/{id}/events", get(events))
        .route("/v1/chat/runs/{id}/events/page", get(page))
}
async fn create(
    State(s): State<Services>,
    Extension(p): Extension<Principal>,
    h: HeaderMap,
    Json(v): Json<ChatInput>,
) -> Result<Json<Value>> {
    let mut c = Command::new(p.owner, Action::ChatCreate, json!(v));
    c.key = Some(key(&h)?.into());
    c.principal = Some(p);
    Ok(envelope(s.execute(c).await?))
}
async fn run(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    invoke(&s, o, Action::ChatGet, Some(id), None, json!({})).await
}
async fn cancel(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
    Json(v): Json<ChatCancel>,
) -> Result<Json<Value>> {
    invoke(
        &s,
        o,
        Action::ChatCancel,
        Some(id),
        Some(key(&h)?),
        json!(v),
    )
    .await
}
async fn page(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Path(id): Path<Uuid>,
    Query(v): Query<ChatEventFilter>,
) -> Result<Json<Value>> {
    invoke(&s, o, Action::ChatEvents, Some(id), None, json!(v)).await
}
struct StreamState {
    backend: Services,
    owner: Uuid,
    id: Uuid,
    after: i64,
    pending: std::collections::VecDeque<Value>,
    done: bool,
}
async fn events(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
    Query(v): Query<ChatEventFilter>,
) -> Result<impl IntoResponse> {
    let mut check = Command::new(o, Action::ChatGet, json!({}));
    check.subject = Some(id);
    s.execute(check).await?;
    let after = if let Some(value) = h.get("Last-Event-ID") {
        value
            .to_str()
            .ok()
            .and_then(|v| v.parse::<i64>().ok())
            .filter(|v| *v >= 0)
            .ok_or_else(|| Error::bad("invalid_event_cursor"))?
    } else {
        v.after.unwrap_or(0)
    };
    let state = StreamState {
        backend: s,
        owner: o,
        id,
        after,
        pending: Default::default(),
        done: false,
    };
    let stream = futures_util::stream::unfold(state, |mut st| async move {
        loop {
            if let Some(v) = st.pending.pop_front() {
                st.after = v["sequence"].as_i64().unwrap_or(st.after);
                let event = Event::default()
                    .id(st.after.to_string())
                    .event(v["type"].as_str().unwrap_or("message"))
                    .data(v["data"].to_string());
                return Some((Ok::<_, std::convert::Infallible>(event), st));
            }
            if st.done {
                return None;
            }
            let mut c = Command::new(st.owner, Action::ChatEvents, json!({"after":st.after}));
            c.subject = Some(st.id);
            match st.backend.execute(c).await {
                Ok(v) => {
                    let items = v["items"].as_array().cloned().unwrap_or_default();
                    let job = v["state"]["job_status"].as_str().unwrap_or("");
                    let status = v["state"]["status"].as_str().unwrap_or("");
                    st.done = items.len() < 101
                        && (matches!(
                            status,
                            "completed" | "cancelled" | "source_removed" | "budget_exhausted"
                        ) || matches!(
                            job,
                            "failed" | "needs_attention" | "blocked_capability" | "awaiting_input"
                        ));
                    st.pending.extend(items);
                    if st.done && st.pending.is_empty() {
                        return Some((
                            Ok(Event::default()
                                .event("run_state")
                                .data(v["state"].to_string())),
                            st,
                        ));
                    }
                }
                Err(e) => {
                    st.done = true;
                    return Some((
                        Ok(Event::default()
                            .event("error")
                            .data(json!({"code":e.code}).to_string())),
                        st,
                    ));
                }
            }
            if st.pending.is_empty() {
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            }
        }
    });
    Ok(Sse::new(stream).keep_alive(KeepAlive::new().interval(std::time::Duration::from_secs(15))))
}
