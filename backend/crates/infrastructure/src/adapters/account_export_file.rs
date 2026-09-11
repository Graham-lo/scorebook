//! Signed account-export URLs are ephemeral secrets. Neither URLs nor response
//! errors may leave this adapter. Hosts require an explicit operator allowlist.
use crate::error::{Error, Result, RetryDirective};
pub async fn download(url: String) -> Result<Vec<u8>> {
    let url = reqwest::Url::parse(&url).map_err(|_| Error::bad("invalid_account_export_url"))?;
    let allowed = std::env::var("SCOREBOOK_ACCOUNT_EXPORT_HOSTS").unwrap_or_default();
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port_or_known_default() != Some(443)
        || url
            .host_str()
            .is_none_or(|h| !allowed.split(',').any(|v| v.trim() == h))
    {
        return Err(Error::deferred(
            "account_export_host_requires_configuration",
            RetryDirective::AwaitCapability,
        ));
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(180))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| Error::bad("export_http_configuration"))?;
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|_| Error::transient("account_export_download_interrupted"))?;
    if !response.status().is_success() {
        return Err(Error::deferred(
            "account_export_link_unavailable_repoll_id",
            RetryDirective::After(30),
        ));
    }
    if response
        .content_length()
        .is_some_and(|v| v > 64 * 1024 * 1024)
    {
        return Err(Error::bad("account_export_download_budget_exceeded"));
    }
    let mut bytes = Vec::new();
    let started = std::time::Instant::now();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| Error::transient("account_export_download_interrupted"))?
    {
        if bytes.len() + chunk.len() > 64 * 1024 * 1024 {
            return Err(Error::bad("account_export_download_budget_exceeded"));
        }
        bytes.extend_from_slice(&chunk);
        if let Some(wait) = super::throttle(bytes.len(), 2. * 1024. * 1024., started.elapsed()) {
            tokio::time::sleep(wait).await;
        }
    }
    Ok(bytes)
}
