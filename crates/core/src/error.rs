use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorKind {
    Invalid,
    Unauthorized,
    Forbidden,
    NotFound,
    Conflict,
    Unavailable,
    Internal,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum RetryDirective {
    Never,
    Backoff,
    After(u32),
    At(DateTime<Utc>),
    AwaitCapability,
    AwaitInput,
}
impl RetryDirective {
    pub fn retryable(&self) -> bool {
        matches!(self, Self::Backoff | Self::After(_) | Self::At(_))
    }
}
#[derive(Debug, Clone)]
pub struct Error {
    pub kind: ErrorKind,
    pub code: String,
    pub retry: RetryDirective,
}
impl Error {
    pub fn new(kind: ErrorKind, code: impl Into<String>, retry: RetryDirective) -> Self {
        Self {
            kind,
            code: code.into(),
            retry,
        }
    }
    pub fn bad(code: impl Into<String>) -> Self {
        Self::new(ErrorKind::Invalid, code, RetryDirective::Never)
    }
    pub fn not_found() -> Self {
        Self::new(ErrorKind::NotFound, "not_found", RetryDirective::Never)
    }
    pub fn conflict(code: &str) -> Self {
        Self::new(ErrorKind::Conflict, code, RetryDirective::Never)
    }
    pub fn unauthorized() -> Self {
        Self::new(
            ErrorKind::Unauthorized,
            "unauthorized",
            RetryDirective::Never,
        )
    }
    pub fn forbidden(code: impl Into<String>) -> Self {
        Self::new(ErrorKind::Forbidden, code, RetryDirective::Never)
    }
    pub fn transient(code: &str) -> Self {
        Self::new(ErrorKind::Unavailable, code, RetryDirective::Backoff)
    }
    pub fn deferred(code: &str, retry: RetryDirective) -> Self {
        Self::new(ErrorKind::Unavailable, code, retry)
    }
}
pub type Result<T> = std::result::Result<T, Error>;
