use scorebook_core::{
    error::{Error, RetryDirective},
    ports::AppFuture,
    secrets::*,
};
pub struct Keychain;
fn validate(reference: &str) -> Result<(), Error> {
    if reference.len() > 200
        || !reference.starts_with("scorebook.")
        || !matches!(reference.split('.').nth(1), Some("exchange" | "backup"))
        || !reference
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
    {
        return Err(Error::bad("invalid_keychain_reference"));
    }
    Ok(())
}
impl SecretStore for Keychain {
    fn load(&self, reference: String) -> AppFuture<'_, SecretBytes> {
        Box::pin(async move {
            validate(&reference)?;
            #[cfg(target_os = "macos")]
            {
                let value = tokio::task::spawn_blocking(move || {
                    security_framework::passwords::get_generic_password(&reference, "scorebook")
                })
                .await
                .map_err(|_| Error::transient("keychain_task_failed"))?
                .map_err(|_| {
                    Error::deferred("keychain_item_unavailable", RetryDirective::AwaitInput)
                })?;
                if value.len() > 16384 {
                    return Err(Error::bad("credential_too_large"));
                }
                Ok(SecretBytes(zeroize::Zeroizing::new(value)))
            }
            #[cfg(not(target_os = "macos"))]
            {
                Err(Error::deferred(
                    "keychain_adapter_unavailable",
                    RetryDirective::AwaitCapability,
                ))
            }
        })
    }
    fn store(&self, reference: String, value: SecretBytes) -> AppFuture<'_, ()> {
        Box::pin(async move {
            validate(&reference)?;
            if value.0.is_empty() || value.0.len() > 16384 {
                return Err(Error::bad("credential_size_invalid"));
            }
            #[cfg(target_os = "macos")]
            {
                tokio::task::spawn_blocking(move || {
                    security_framework::passwords::set_generic_password(
                        &reference,
                        "scorebook",
                        &value.0,
                    )
                })
                .await
                .map_err(|_| Error::transient("keychain_task_failed"))?
                .map_err(|_| {
                    Error::deferred("keychain_write_failed", RetryDirective::AwaitInput)
                })?;
                Ok(())
            }
            #[cfg(not(target_os = "macos"))]
            {
                Err(Error::deferred(
                    "keychain_adapter_unavailable",
                    RetryDirective::AwaitCapability,
                ))
            }
        })
    }
}
