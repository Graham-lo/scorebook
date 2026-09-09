pub use crate::application::dto as types;
pub use crate::error;
mod contract;
use crate::{
    application::{Services, calls, exports, jobs, knowledge, similarity},
    domain::{criteria, parser},
};
use axum::{
    Extension, Json, Router,
    extract::{DefaultBodyLimit, Multipart, Path, Query, Request, State},
    http::{HeaderMap, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
pub use contract::openapi;
use error::{Error, Result};
use serde::Deserialize;
use serde_json::{Value, json};
use types::*;
use uuid::Uuid;

pub fn router(s: Services) -> Router {
    let api = Router::new()
        .route("/v1/capabilities", get(capabilities))
        .route("/v1/market/data", post(market_data))
        .route("/v1/market/chart", post(market_chart))
        .route(
            "/v1/history/indexes",
            get(history_indexes).post(history_index),
        )
        .route("/v1/history/search", post(history_search))
        .route("/v1/criteria", get(criteria_list))
        .route("/v1/instruments", get(instruments))
        .route("/v1/calls/preview", post(preview))
        .route("/v1/calls", get(call_list).post(call_create))
        .route("/v1/search", get(call_list))
        .route("/v1/calls/{id}", get(call_get))
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
        .route("/v1/exports", post(export_create))
        .route("/v1/exports/{id}/manifest", get(export_manifest))
        .route("/v1/evaluations/preview", post(evaluation_preview))
        .route("/v1/calls/{id}/replays", post(replay_create))
        .route("/v1/sets/resolve", post(set_create))
        .route("/v1/sets/{id}", get(set_get))
        .route("/v1/deletions/preview", post(delete_preview))
        .route("/v1/deletions", post(delete_confirm))
        .route("/v1/knowledge/tools", get(tool_list))
        .route("/v1/knowledge/tools/call", post(tool_call))
        .layer(middleware::from_fn_with_state(s.clone(), authenticate));
    Router::new()
        .route("/v1/health", get(health))
        .route("/openapi.json", get(|| async { Json(openapi()) }))
        .merge(api)
        .layer(DefaultBodyLimit::max(2 * 1024 * 1024))
        .layer(tower_http::trace::TraceLayer::new_for_http())
        .layer(middleware::from_fn(normalize_response))
        .with_state(s)
}
async fn authenticate(State(s): State<Services>, mut r: Request, next: Next) -> Result<Response> {
    if let Some(origin) = r.headers().get(header::ORIGIN) {
        let configured = std::env::var("SCOREBOOK_ALLOWED_ORIGIN").ok();
        if configured.as_deref() != origin.to_str().ok() {
            return Err(Error {
                status: axum::http::StatusCode::FORBIDDEN,
                code: "origin_not_allowed".into(),
            });
        }
    }
    let token = r
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or_else(Error::unauthorized)?;
    let owner = s.db.authenticate(token).await?;
    let scope = s.db.token_scope(token).await?;
    if scope == "read_only"
        && r.method() != axum::http::Method::GET
        && !matches!(
            r.uri().path(),
            "/v1/knowledge/tools/call"
                | "/v1/calls/preview"
                | "/v1/evaluations/preview"
                | "/v1/market/data"
                | "/v1/market/chart"
        )
    {
        return Err(Error {
            status: axum::http::StatusCode::FORBIDDEN,
            code: "read_only_token".into(),
        });
    }
    r.extensions_mut().insert(owner);
    Ok(next.run(r).await)
}
fn key(h: &HeaderMap) -> Result<&str> {
    h.get("Idempotency-Key")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| Error::bad("idempotency_key_required"))
}
fn envelope(v: Value) -> Json<Value> {
    Json(json!({"data":v,"meta":{"api_version":"v1"}}))
}

mod system;
use system::*;

mod records;
use records::*;

mod knowledge_routes;
use knowledge_routes::*;

mod similarity_routes;
use similarity_routes::*;

mod operations;
use operations::*;

mod evaluation_routes;
use evaluation_routes::*;

mod model;
use model::*;

mod market_routes;
use market_routes::*;

async fn normalize_response(r: Request, next: Next) -> Response {
    let mut response = next.run(r).await;
    if response.status().is_client_error()
        && response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|h| h.to_str().ok())
            .is_none_or(|h| !h.starts_with("application/json"))
    {
        response = Error {
            status: response.status(),
            code: "invalid_request".into(),
        }
        .into_response();
    }
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("private, no-store"),
    );
    response
}
