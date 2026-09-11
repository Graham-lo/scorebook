pub use scorebook_core::error::{ErrorKind, RetryDirective};
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
        scorebook_core::error::Error::bad(code).into()
    }
    pub fn not_found() -> Self {
        scorebook_core::error::Error::not_found().into()
    }
    pub fn conflict(code: &str) -> Self {
        scorebook_core::error::Error::conflict(code).into()
    }
    pub fn unauthorized() -> Self {
        scorebook_core::error::Error::unauthorized().into()
    }
    pub fn transient(code: &str) -> Self {
        scorebook_core::error::Error::transient(code).into()
    }
    pub fn deferred(code: &str, retry: RetryDirective) -> Self {
        scorebook_core::error::Error::deferred(code, retry).into()
    }
}
impl From<scorebook_core::error::Error> for Error {
    fn from(e: scorebook_core::error::Error) -> Self {
        Self {
            kind: e.kind,
            code: e.code,
            retry: e.retry,
        }
    }
}
impl From<Error> for scorebook_core::error::Error {
    fn from(e: Error) -> Self {
        Self {
            kind: e.kind,
            code: e.code,
            retry: e.retry,
        }
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
            tracing::error!(sqlstate=?d.code(),"database operation failed");
        }
        Self::new(
            ErrorKind::Internal,
            "database_error",
            RetryDirective::Backoff,
        )
    }
}
impl From<std::io::Error> for Error {
    fn from(_: std::io::Error) -> Self {
        Self::new(
            ErrorKind::Internal,
            "storage_error",
            RetryDirective::Backoff,
        )
    }
}
impl From<anyhow::Error> for Error {
    fn from(_: anyhow::Error) -> Self {
        Self::transient("adapter_unavailable")
    }
}
pub type Result<T> = std::result::Result<T, Error>;
