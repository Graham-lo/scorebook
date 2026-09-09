use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use scorebook_core::error::{Error as CoreError, ErrorKind};
use serde_json::json;
pub struct Error(CoreError);
impl Error {
    pub fn bad(code: impl Into<String>) -> Self {
        Self(CoreError::bad(code))
    }
}
impl From<CoreError> for Error {
    fn from(e: CoreError) -> Self {
        Self(e)
    }
}
impl IntoResponse for Error {
    fn into_response(self) -> Response {
        let error = self.0;
        let status = match error.kind {
            ErrorKind::Invalid => StatusCode::UNPROCESSABLE_ENTITY,
            ErrorKind::Unauthorized => StatusCode::UNAUTHORIZED,
            ErrorKind::Forbidden => StatusCode::FORBIDDEN,
            ErrorKind::NotFound => StatusCode::NOT_FOUND,
            ErrorKind::Conflict => StatusCode::CONFLICT,
            ErrorKind::Unavailable => StatusCode::SERVICE_UNAVAILABLE,
            ErrorKind::Internal => StatusCode::INTERNAL_SERVER_ERROR,
        };
        (status,Json(json!({"error":{"code":error.code,"message":error.code,"field":null,"retryable":error.retry.retryable(),"retry":error.retry,"request_id":uuid::Uuid::new_v4()}}))).into_response()
    }
}
pub type Result<T> = std::result::Result<T, Error>;
