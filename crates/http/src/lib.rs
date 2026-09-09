use axum::{
    Extension, Json, Router,
    extract::{DefaultBodyLimit, Multipart, Path, Query, Request, State},
    http::{HeaderMap, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use scorebook_core::{
    api,
    api::dto::*,
    domain::{criteria, parser},
    ports::{Action, Backend, Command},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::sync::Arc;
use uuid::Uuid;
type Services = Arc<dyn Backend>;
mod error;
use error::{Error, Result};
mod contract;
mod response_contract;
pub use contract::openapi;
pub use scorebook_core::api::dto as types;
pub fn router(s: Services) -> Router {
    let api = Router::new()
        .merge(chart_routes::routes())
        .merge(chat_routes::routes())
        .merge(backup_routes::routes())
        .merge(trade_routes::routes())
        .merge(statistics_routes::routes())
        .merge(knowledge_index_routes::routes())
        .merge(knowledge_workflow_routes::routes())
        .merge(history_catalog_routes::routes())
        .route("/v1/sessions", post(session_create))
        .route("/v1/sessions/{id}/revoke", post(session_revoke))
        .route("/v1/capabilities", get(capabilities))
        .route("/v1/market/data", post(market_data))
        .route("/v1/market/chart", post(market_chart))
        .route(
            "/v1/history/indexes",
            get(history_indexes).post(history_index),
        )
        .route(
            "/v1/history/indexes/{id}/revalidate",
            post(history_revalidate),
        )
        .route("/v1/history/plans", post(history_plan_create))
        .route("/v1/history/plans/{id}", get(history_plan_get))
        .route("/v1/history/plans/{id}/control", post(history_plan_control))
        .route("/v1/history/search", post(history_search))
        .route("/v1/history/coverage", get(history_coverage))
        .route("/v1/criteria", get(criteria_list))
        .route("/v1/instruments", get(instruments))
        .route("/v1/calls/preview", post(preview))
        .route("/v1/calls", get(call_list).post(call_create))
        .route("/v1/search", get(call_list))
        .route("/v1/calls/{id}", get(call_get))
        .route("/v1/calls/{id}/history", get(call_history))
        .route("/v1/calls/{id}/void", post(call_void))
        .route("/v1/calls/{id}/attachments", post(attachment_link))
        .route("/v1/calls/{id}/corrections", post(correction_create))
        .route("/v1/calls/{id}/revisions", post(revision_create))
        .route(
            "/v1/attachments",
            post(attachment_upload).layer(DefaultBodyLimit::max(21 * 1024 * 1024)),
        )
        .route("/v1/attachments/{id}", get(attachment_download))
        .route("/v1/attachments/{id}/index", post(attachment_index))
        .route(
            "/v1/calls/{id}/review-draft",
            get(draft_get).post(draft_save),
        )
        .route("/v1/calls/{id}/review-draft/publish", post(draft_publish))
        .route("/v1/calls/{id}/review-draft/discard", post(draft_discard))
        .route("/v1/calls/{id}/review-reminder", post(review_snooze))
        .route("/v1/similarity/sessions/{id}/save", post(search_save))
        .route("/v1/similarity/sessions/{id}", get(search_get))
        .route("/v1/reviews", post(review_create))
        .route("/v1/review-queue", get(review_queue))
        .route("/v1/tags", get(tag_list).post(tag_create))
        .route("/v1/tags/links", post(tag_add))
        .route("/v1/playbooks", get(playbook_list).post(playbook_create))
        .route("/v1/episodes", get(episode_list))
        .route("/v1/episodes/{id}", get(episode_get))
        .route("/v1/episode-links", post(episode_link))
        .route("/v1/events", get(event_list))
        .route("/v1/similarity/search", post(similar_search))
        .route("/v1/similarity/feedback", post(similar_feedback))
        .route("/v1/jobs/{id}", get(job_get))
        .route("/v1/jobs/{id}/retry", post(job_retry))
        .route("/v1/jobs/{id}/assessment-source", post(assessment_source))
        .route("/v1/calls/{id}/outcome-revisions", post(outcome_revision))
        .route("/v1/exports", post(export_create))
        .route("/v1/exports/{id}/manifest", get(export_manifest))
        .route("/v1/exports/{id}/files/{*name}", get(export_file))
        .route("/v1/evaluations/preview", post(evaluation_preview))
        .route("/v1/calls/{id}/replays", post(replay_create))
        .route("/v1/sets/resolve", post(set_create))
        .route("/v1/sets/{id}", get(set_get))
        .route("/v1/deletions/preview", post(delete_preview))
        .route("/v1/deletions", post(delete_confirm))
        .route("/v1/knowledge/tools", get(tool_list))
        .route("/v1/knowledge/tools/call", post(tool_call))
        .layer(middleware::from_fn_with_state(s.clone(), authenticate));
    let router=Router::new()
        .route("/v1/health", get(health))
        .route("/v1/ready",get(ready))
        .route("/openapi.json", get(|| async { Json(openapi()) }))
        .merge(api)
        .layer(DefaultBodyLimit::max(2 * 1024 * 1024))
        .layer(tower_http::trace::TraceLayer::new_for_http().make_span_with(|r:&Request|tracing::info_span!("http_request",method=%r.method(),path=%r.uri().path())))
        .layer(middleware::from_fn(normalize_response))
        .with_state(s);
    let router = router.layer(
        tower::ServiceBuilder::new()
            .layer(axum::error_handling::HandleErrorLayer::new(
                |_: axum::BoxError| async {
                    Error::from(scorebook_core::error::Error::deferred(
                        "server_busy",
                        scorebook_core::error::RetryDirective::After(2),
                    ))
                    .into_response()
                },
            ))
            .load_shed()
            .concurrency_limit(64),
    );
    if let Ok(origin) = std::env::var("SCOREBOOK_ALLOWED_ORIGIN") {
        let origin: axum::http::HeaderValue =
            origin.parse().expect("valid SCOREBOOK_ALLOWED_ORIGIN");
        router.layer(
            tower_http::cors::CorsLayer::new()
                .allow_origin(origin)
                .allow_methods([
                    axum::http::Method::GET,
                    axum::http::Method::POST,
                    axum::http::Method::OPTIONS,
                ])
                .allow_headers([
                    header::AUTHORIZATION,
                    header::CONTENT_TYPE,
                    axum::http::HeaderName::from_static("idempotency-key"),
                ]),
        )
    } else {
        router
    }
}

async fn authenticate(
    State(s): State<Services>,
    mut request: Request,
    next: Next,
) -> Result<Response> {
    if let Some(origin) = request.headers().get(header::ORIGIN)
        && std::env::var("SCOREBOOK_ALLOWED_ORIGIN").ok().as_deref() != origin.to_str().ok()
    {
        return Err(scorebook_core::error::Error::forbidden("origin_not_allowed").into());
    }
    let token = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or_else(|| Error::from(scorebook_core::error::Error::unauthorized()))?
        .to_string();
    let principal = s.authenticate(token).await?;
    principal.require(scorebook_core::access::route_permission(
        request.method().as_str(),
        request.uri().path(),
    ))?;
    request.extensions_mut().insert(principal.owner);
    request.extensions_mut().insert(principal);
    Ok(next.run(request).await)
}
fn key(headers: &HeaderMap) -> Result<&str> {
    headers
        .get("Idempotency-Key")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| Error::bad("idempotency_key_required"))
}
fn envelope(value: Value) -> Json<Value> {
    Json(json!({"data":value,"meta":{"api_version":"v1"}}))
}
async fn invoke(
    s: &Services,
    owner: Uuid,
    action: Action,
    subject: Option<Uuid>,
    key: Option<&str>,
    payload: Value,
) -> Result<Json<Value>> {
    let mut command = Command::new(owner, action, payload);
    command.subject = subject;
    command.key = key.map(str::to_string);
    Ok(envelope(s.execute(command).await?))
}
async fn normalize_response(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    if response.status().is_client_error()
        && response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_none_or(|v| !v.starts_with("application/json"))
    {
        let status = response.status();
        response = Error::bad("invalid_request").into_response();
        *response.status_mut() = status;
    }
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("private, no-store"),
    );
    response.headers_mut().insert(
        header::X_CONTENT_TYPE_OPTIONS,
        axum::http::HeaderValue::from_static("nosniff"),
    );
    response
}

mod records;
use records::*;

mod knowledge_routes;
use knowledge_routes::*;

mod similarity_routes;
use similarity_routes::*;

mod market_routes;
use market_routes::*;

mod evaluation_routes;
use evaluation_routes::*;

mod operations;
use operations::*;

mod review_routes;
use review_routes::*;

#[derive(Serialize, Deserialize)]
struct Page {
    cursor: Option<Uuid>,
}
#[derive(Serialize, Deserialize)]
struct EventCursor {
    #[serde(default)]
    after: i64,
}
async fn health() -> Json<Value> {
    envelope(json!({"status":"ok","version":env!("CARGO_PKG_VERSION")}))
}
async fn ready(State(s): State<Services>) -> Result<Json<Value>> {
    Ok(envelope(s.readiness().await?))
}
async fn capabilities(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
) -> Result<Json<Value>> {
    invoke(&s, o, Action::Capabilities, None, None, json!({})).await
}
async fn tool_list() -> Json<Value> {
    envelope(contract::tools())
}
async fn tool_call(
    State(s): State<Services>,
    Extension(principal): Extension<scorebook_core::access::Principal>,
    Json(v): Json<ToolCall>,
) -> Result<Json<Value>> {
    if matches!(
        v.name.as_str(),
        "search_binance_history"
            | "search_similar_charts"
            | "get_market_data"
            | "render_market_chart"
    ) {
        principal.require("search.compute")?;
    }
    invoke(&s, principal.owner, Action::ToolCall, None, None, json!(v)).await
}
async fn criteria_list() -> Json<Value> {
    envelope(
        json!({"version":"criteria-v1","templates":["T0","T1","T2","T3","T4","T5"],"automatic_templates":["T0","T1","T2","T4","T5"],"T3_automatic":"explicit_trigger_rule_required","default":"T0","path":"unknown","confidence":null,"numeric":"decimal34-half-even","crypto_default_hours":72}),
    )
}

mod sessions;
use sessions::*;

mod chart_routes;

mod history_catalog_routes;

mod trade_routes;

mod statistics_routes;

mod knowledge_workflow_routes;

mod knowledge_index_routes;

mod backup_routes;
mod chat_routes;
