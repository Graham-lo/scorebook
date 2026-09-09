//! Composition facade. Runtime implementations live in the workspace packages.
pub use scorebook_core::domain;
pub use scorebook_infrastructure::{adapters, application, error};
pub mod http {
    pub use scorebook_http::openapi;
    pub fn router(services: crate::application::Services) -> axum::Router {
        scorebook_http::router(std::sync::Arc::new(
            scorebook_infrastructure::facade::Facade::new(services),
        ))
    }
}
