use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::json;
#[derive(Debug)]
pub struct Error {
    pub status: StatusCode,
    pub code: String,
}
impl Error {
    pub fn bad(s: impl Into<String>) -> Self {
        Self {
            status: StatusCode::UNPROCESSABLE_ENTITY,
            code: s.into(),
        }
    }
    pub fn not_found() -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            code: "not_found".into(),
        }
    }
    pub fn conflict(s: &str) -> Self {
        Self {
            status: StatusCode::CONFLICT,
            code: s.into(),
        }
    }
    pub fn unauthorized() -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            code: "unauthorized".into(),
        }
    }
}
impl IntoResponse for Error {
    fn into_response(self) -> Response {
        (self.status,Json(json!({"error":{"code":self.code,"message":self.code,"field":null,"retryable":self.status.is_server_error(),"request_id":uuid::Uuid::new_v4()}}))).into_response()
    }
}
impl From<sqlx::Error> for Error {
    fn from(e: sqlx::Error) -> Self {
        if let sqlx::Error::Database(d) = &e {
            if d.is_foreign_key_violation() {
                return Self::bad("invalid_reference");
            }
            if d.is_unique_violation() {
                return Self::conflict("already_exists");
            }
        }
        tracing::error!(error=%e,"database operation failed");
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "database_error".into(),
        }
    }
}
impl From<std::io::Error> for Error {
    fn from(_: std::io::Error) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "storage_error".into(),
        }
    }
}
impl From<anyhow::Error> for Error {
    fn from(e: anyhow::Error) -> Self {
        tracing::warn!(error=%e,"adapter operation failed");
        Self {
            status: StatusCode::BAD_GATEWAY,
            code: "adapter_unavailable".into(),
        }
    }
}
pub type Result<T> = std::result::Result<T, Error>;
