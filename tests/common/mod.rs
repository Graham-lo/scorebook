//! Shared guard for integration tests: they may only ever run against an isolated
//! `scorebook_test_*` database (created per run by `ops/run_tests.py`). Running a test
//! binary directly with `.env` loaded would otherwise point at the main database.

/// Returns `DATABASE_URL` after asserting that it names a `scorebook_test*` database.
/// Only the database name is echoed on failure, never the URL itself.
#[allow(dead_code)]
pub fn test_db_url() -> String {
    let url = std::env::var("DATABASE_URL")
        .expect("DATABASE_URL must point to an isolated test DB (run ops/test.sh)");
    let name = url
        .rsplit('/')
        .next()
        .unwrap_or("")
        .split('?')
        .next()
        .unwrap_or("");
    assert!(
        name.starts_with("scorebook_test"),
        "refusing to run tests against database `{name}`: use ops/test.sh, which creates scorebook_test_<hex>"
    );
    url
}
