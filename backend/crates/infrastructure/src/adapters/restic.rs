//! Pinned subprocess protocol. Only bounded JSON status crosses this adapter;
//! passwords stay in Keychain/zeroizing memory and a short-lived child environment.
use crate::error::{Error, Result, RetryDirective};
use scorebook_core::{api::backups::BackupConfiguration, secrets::SecretBytes};
use serde::Deserialize;
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    process::Stdio,
};
use tokio::io::AsyncReadExt;
use zeroize::Zeroize;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Credential {
    password: String,
    #[serde(default)]
    environment: std::collections::BTreeMap<String, String>,
}
impl Drop for Credential {
    fn drop(&mut self) {
        self.password.zeroize();
        self.environment.values_mut().for_each(Zeroize::zeroize);
    }
}
#[derive(Clone)]
pub struct Restic {
    executable: Option<PathBuf>,
}
impl Restic {
    pub fn configured(&self) -> bool {
        self.executable.is_some()
    }
    pub fn at(executable: PathBuf) -> anyhow::Result<Self> {
        anyhow::ensure!(
            executable.is_absolute(),
            "absolute restic executable required"
        );
        Ok(Self {
            executable: Some(executable),
        })
    }
    pub fn new() -> anyhow::Result<Self> {
        let executable = std::env::var_os("SCOREBOOK_RESTIC_EXECUTABLE").map(PathBuf::from);
        if executable.as_ref().is_some_and(|p| !p.is_absolute()) {
            anyhow::bail!("restic executable must be absolute");
        }
        Ok(Self { executable })
    }
    pub async fn execute(
        &self,
        config: &BackupConfiguration,
        secret: SecretBytes,
        args: &[String],
        cwd: Option<&Path>,
    ) -> Result<Vec<Value>> {
        tokio::time::timeout(
            std::time::Duration::from_secs(1800),
            self.execute_inner(config, secret, args, cwd),
        )
        .await
        .map_err(|_| Error::transient("backup_operation_timeout"))?
    }
    async fn execute_inner(
        &self,
        config: &BackupConfiguration,
        secret: SecretBytes,
        args: &[String],
        cwd: Option<&Path>,
    ) -> Result<Vec<Value>> {
        let exe = self.executable.as_ref().ok_or_else(|| {
            Error::deferred("restic_not_configured", RetryDirective::AwaitCapability)
        })?;
        let credential: Credential = serde_json::from_slice(&secret.0)
            .map_err(|_| Error::bad("invalid_backup_credential"))?;
        if credential.password.len() < 20
            || credential.environment.keys().any(|k| {
                !matches!(
                    k.as_str(),
                    "AWS_ACCESS_KEY_ID"
                        | "AWS_SECRET_ACCESS_KEY"
                        | "AWS_SESSION_TOKEN"
                        | "AWS_DEFAULT_REGION"
                        | "RESTIC_REST_USERNAME"
                        | "RESTIC_REST_PASSWORD"
                )
            })
        {
            return Err(Error::bad("invalid_backup_credential_fields"));
        }
        let mut command = tokio::process::Command::new(exe);
        command
            .env_clear()
            .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
            .env("RESTIC_REPOSITORY", &config.repository)
            .env("RESTIC_PASSWORD", &credential.password)
            .env("GOMAXPROCS", "2")
            .env("GOMEMLIMIT", "512MiB");
        for (k, v) in &credential.environment {
            command.env(k, v);
        }
        command
            .args([
                "--json",
                "--no-cache",
                "--limit-upload",
                "2048",
                "--limit-download",
                "4096",
            ])
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        if let Some(dir) = cwd {
            command.current_dir(dir);
        }
        let mut child = command.spawn().map_err(|_| {
            Error::deferred(
                "restic_executable_unavailable",
                RetryDirective::AwaitCapability,
            )
        })?;
        let stdout = child.stdout.take().unwrap();
        let mut output = Vec::new();
        stdout
            .take(8 * 1024 * 1024 + 1)
            .read_to_end(&mut output)
            .await
            .map_err(|_| Error::transient("backup_output_read_failed"))?;
        if output.len() > 8 * 1024 * 1024 {
            let _ = child.kill().await;
            return Err(Error::bad("backup_output_budget_exceeded"));
        }
        let status = child
            .wait()
            .await
            .map_err(|_| Error::transient("backup_process_failed"))?;
        if !status.success() {
            return Err(Error::transient("restic_operation_failed"));
        }
        if let Ok(v) = serde_json::from_slice::<Value>(&output) {
            return Ok(if let Value::Array(items) = v {
                items
            } else {
                vec![v]
            });
        }
        let mut values = Vec::new();
        for line in output.split(|b| *b == b'\n').filter(|v| !v.is_empty()) {
            let v: Value =
                serde_json::from_slice(line).map_err(|_| Error::bad("invalid_restic_json"))?;
            if let Some(items) = v.as_array() {
                values.extend(items.clone());
            } else {
                values.push(v);
            }
        }
        Ok(values)
    }
    pub async fn version(&self) -> Result<()> {
        let exe = self.executable.as_ref().ok_or_else(|| {
            Error::deferred("restic_not_configured", RetryDirective::AwaitCapability)
        })?;
        let result = tokio::process::Command::new(exe)
            .args(["version", "--json"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .output()
            .await
            .map_err(|_| Error::transient("restic_version_unavailable"))?;
        let v: Value = serde_json::from_slice(&result.stdout)
            .map_err(|_| Error::bad("restic_version_invalid"))?;
        if !result.status.success() || v["version"] != "0.19.1" {
            return Err(Error::deferred(
                "restic_version_mismatch",
                RetryDirective::AwaitCapability,
            ));
        }
        Ok(())
    }
}
