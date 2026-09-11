use clap::{Parser, Subcommand};
use scorebook::{
    adapters::{db::Database, storage::Storage, vision::Vision},
    application::{Services, exports, jobs},
};
#[derive(Parser)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}
#[derive(Subcommand)]
enum Command {
    Serve,
    Worker,
    Migrate,
    RefreshInstruments,
    CreateUser {
        name: String,
        #[arg(long)]
        token_file: std::path::PathBuf,
    },
    Openapi,
    Restore {
        path: std::path::PathBuf,
    },
    CreateReadKey {
        owner: uuid::Uuid,
        #[arg(long)]
        token_file: std::path::PathBuf,
    },
    /// Issue a new full-access key for an existing or restored user (local admin only).
    CreateKey {
        owner: uuid::Uuid,
        #[arg(long)]
        token_file: std::path::PathBuf,
    },
    UpgradeExport {
        source: std::path::PathBuf,
        destination: std::path::PathBuf,
    },
    /// Read a bounded secret from redirected stdin into macOS Keychain; never accept it in argv.
    StoreSecret {
        reference: String,
    },
    RecoverBackup {
        owner: uuid::Uuid,
        configuration: uuid::Uuid,
        snapshot: String,
        destination: std::path::PathBuf,
    },
    VerifyExport {
        path: std::path::PathBuf,
    },
    Replay {
        input: std::path::PathBuf,
    },
}
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "scorebook=info,tower_http=info".into()),
        )
        .init();
    let cli = Cli::parse();
    match &cli.command {
        Command::StoreSecret { reference } => {
            use scorebook_core::secrets::{SecretBytes, SecretStore};
            use std::io::IsTerminal;
            use tokio::io::AsyncReadExt;
            anyhow::ensure!(
                !std::io::stdin().is_terminal(),
                "redirect protected stdin; interactive echo is forbidden"
            );
            let mut bytes = zeroize::Zeroizing::new(Vec::new());
            tokio::io::stdin()
                .take(16 * 1024 + 1)
                .read_to_end(&mut bytes)
                .await?;
            anyhow::ensure!(bytes.len() <= 16 * 1024, "secret too large");
            scorebook::adapters::keychain::Keychain
                .store(reference.clone(), SecretBytes(bytes))
                .await
                .map_err(|e| anyhow::anyhow!(e.code))?;
            println!("Secret stored in Keychain.");
            return Ok(());
        }
        Command::Openapi => {
            println!(
                "{}",
                serde_json::to_string_pretty(&scorebook::http::openapi())?
            );
            return Ok(());
        }
        Command::UpgradeExport {
            source,
            destination,
        } => {
            println!("{}", exports::upgrade::v19(source, destination).await?);
            return Ok(());
        }
        Command::VerifyExport { path } => {
            println!("{}", exports::verify(path).await?);
            return Ok(());
        }
        Command::Replay { input } => {
            let i = serde_json::from_slice(&tokio::fs::read(input).await?)?;
            println!(
                "{}",
                serde_json::to_string_pretty(&scorebook::domain::criteria::evaluate(&i))?
            );
            return Ok(());
        }
        _ => {}
    }
    let db = Database::connect(&std::env::var("DATABASE_URL")?).await?;
    db.migrate().await?;
    let s = Services::new(
        db,
        Storage::new(std::env::var("SCOREBOOK_STORAGE").unwrap_or_else(|_| "data".into())),
        Vision::new(std::env::var("SCOREBOOK_VISION_URL").ok()),
    )?;
    let issuing_read_only = matches!(&cli.command, Command::CreateReadKey { .. });
    match cli.command {
        Command::Migrate => println!("Migrations applied."),
        Command::RefreshInstruments => println!(
            "{}",
            scorebook::application::instruments::refresh(&s)
                .await
                .map_err(|e| anyhow::anyhow!(e.code))?
        ),
        Command::RecoverBackup {
            owner,
            configuration,
            snapshot,
            destination,
        } => println!(
            "{}",
            scorebook::application::backups::restore_snapshot(
                &s,
                owner,
                configuration,
                &snapshot,
                &destination
            )
            .await
            .map_err(|e| anyhow::anyhow!(e.code))?
        ),
        Command::Restore { path } => println!("{}", exports::restore(&s, &path).await?),
        Command::CreateReadKey { owner, token_file } | Command::CreateKey { owner, token_file } => {
            use std::io::Write;
            use std::os::unix::fs::OpenOptionsExt;
            let mut f = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(token_file)?;
            let token = s.db.create_key(owner, issuing_read_only).await?;
            f.write_all(token.as_bytes())?;
            f.sync_all()?;
            println!("Token written to protected file.");
        }
        Command::CreateUser { name, token_file } => {
            // Refuse to overwrite an existing credential file.
            use std::io::Write;
            use std::os::unix::fs::OpenOptionsExt;
            let mut f = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(token_file)?;
            let (id, token) = s.db.create_user(&name).await?;
            f.write_all(token.as_bytes())?;
            f.sync_all()?;
            println!("Created user {id}; token written to protected file.");
        }
        Command::Serve => {
            let addr = std::env::var("SCOREBOOK_BIND").unwrap_or_else(|_| "127.0.0.1:8787".into());
            let listener = tokio::net::TcpListener::bind(&addr).await?;
            tracing::info!(address=%addr,"Scorebook API listening");
            axum::serve(listener, scorebook::http::router(s))
                .with_graceful_shutdown(shutdown_signal())
                .await?;
        }
        Command::Worker => {
            tracing::info!("Scorebook worker running; interactive=2 batch=1 maintenance=1");
            let (stop, rx) = tokio::sync::watch::channel(false);
            supervise(
                &["interactive", "interactive", "batch", "maintenance"],
                move |queue| worker_loop(s.clone(), rx.clone(), queue),
                RESTART_BACKOFF,
                stop,
                shutdown_signal(),
            )
            .await;
        }
        _ => {}
    }
    Ok(())
}

/// 一条循环死掉之后、重新拉起来之前的退避。
const RESTART_BACKOFF: std::time::Duration = std::time::Duration::from_secs(2);

/// 一条队列的工作循环。内容和它以前作为 `JoinSet` 里的 inline async block 时
/// 一模一样；抽成独立函数只是为了它死掉之后还能被重新 spawn 一次。
async fn worker_loop(
    services: Services,
    mut rx: tokio::sync::watch::Receiver<bool>,
    queue: &'static str,
) {
    let mut next_gc = tokio::time::Instant::now();
    let mut next_replay_sweep = tokio::time::Instant::now();
    let mut next_instruments = tokio::time::Instant::now();
    loop {
        // 品种目录六小时刷一次，启动先刷一次：这样交易所那边挂了，
        // /v1/instruments 还能拿库里最后一次成功的结果顶着。
        if queue == "maintenance" && tokio::time::Instant::now() >= next_instruments {
            match scorebook::application::instruments::refresh(&services).await {
                Ok(v) => {
                    tracing::info!(contracts=%v["contracts_refreshed"],"instrument catalogue refreshed")
                }
                Err(e) => {
                    tracing::warn!(code=%e.code,"instrument refresh failed; catalogue left as it was")
                }
            }
            next_instruments =
                tokio::time::Instant::now() + std::time::Duration::from_secs(6 * 3600);
        }
        // Hourly fallback for replay bars the frontend never deleted on exit.
        if queue == "maintenance" && tokio::time::Instant::now() >= next_replay_sweep {
            match scorebook::application::replay::sweep(&services).await {
                Ok(n) => {
                    if n > 0 {
                        tracing::info!(removed = n, "expired replay bars swept");
                    }
                }
                Err(e) => tracing::warn!(code=%e.code,"replay sweep failed"),
            }
            next_replay_sweep = tokio::time::Instant::now() + std::time::Duration::from_secs(3600);
        }
        if queue == "maintenance" && tokio::time::Instant::now() >= next_gc {
            if let Err(e) = scorebook::application::backups::schedule(&services).await {
                tracing::warn!(code=%e.code,"backup scheduling failed");
            }
            if let Err(e) = scorebook::application::gc::schedule(&services).await {
                tracing::warn!(code=%e.code,"cleanup scheduling failed");
            }
            if let Err(e) =
                scorebook::application::knowledge_index::index::schedule(&services).await
            {
                tracing::warn!(code=%e.code,"knowledge index scheduling failed");
            }
            if let Err(e) = scorebook::application::history_catalog::schedule(&services).await {
                tracing::warn!(code=%e.code,"history subscription scheduling failed");
            }
            next_gc = tokio::time::Instant::now() + std::time::Duration::from_secs(60);
        }
        if *rx.borrow() {
            break;
        }
        match jobs::run_filtered(&services, None, Some(queue)).await {
            Ok(true) => {}
            result => {
                if let Err(e) = result {
                    tracing::warn!(code=%e.code,queue,"worker iteration failed");
                }
                tokio::select! {_=rx.changed()=>{},_=tokio::time::sleep(std::time::Duration::from_secs(2))=>{}}
            }
        }
    }
}

/// 看着每条队列的循环，运行期间就看，而不是等到关机之后。
///
/// 这是在补一个会让线上静默停摆的缺口：以前四个循环 spawn 完就没人再碰
/// `JoinSet`，`join_next` 只在收到关机信号之后的宽限块里出现过一次。于是任何
/// 一条循环在运行期间 panic，进程照活、`/v1/health` 照绿，只有那条队列永远
/// 不动 —— 两个 interactive 都死掉就是交互队列永久停摆，而外面看不出任何异常。
///
/// 死掉的循环在这里被重新拉起来，而不是让整个进程退出：launchd 的
/// `KeepAlive` 确实能把进程拉回来，但那会把另外三条队列手上正在跑的活一起
/// 打断（batch 上一个扇出作业能跑两小时），一条下载器的 panic 不该连坐。
async fn supervise<F, Fut>(
    queues: &'static [&'static str],
    make: F,
    backoff: std::time::Duration,
    stop: tokio::sync::watch::Sender<bool>,
    shutdown: impl std::future::Future<Output = ()>,
) where
    F: Fn(&'static str) -> Fut,
    Fut: std::future::Future<Output = ()> + Send + 'static,
{
    let mut workers: tokio::task::JoinSet<&'static str> = tokio::task::JoinSet::new();
    // panic 的时候 `JoinError` 只给得出 task id，认队列名要靠这张表。
    let mut owners: std::collections::HashMap<tokio::task::Id, &'static str> =
        std::collections::HashMap::new();
    let mut restarts: std::collections::HashMap<&'static str, u64> =
        std::collections::HashMap::new();
    let spawn_one = |workers: &mut tokio::task::JoinSet<&'static str>,
                     owners: &mut std::collections::HashMap<tokio::task::Id, &'static str>,
                     queue: &'static str| {
        let task = make(queue);
        let handle = workers.spawn(async move {
            task.await;
            queue
        });
        owners.insert(handle.id(), queue);
    };
    for queue in queues {
        spawn_one(&mut workers, &mut owners, queue);
    }
    let mut shutdown = std::pin::pin!(shutdown);
    loop {
        let joined = tokio::select! {
            _ = &mut shutdown => break,
            joined = workers.join_next_with_id(), if !workers.is_empty() => joined,
        };
        let queue = match joined {
            // 循环 panic 了（或者被 cancel 了）。
            Some(Err(e)) => {
                let queue = owners.remove(&e.id()).unwrap_or("unknown");
                let restarts = restarts.entry(queue).or_default();
                *restarts += 1;
                tracing::error!(
                    queue,
                    restarts = *restarts,
                    error = %e,
                    "worker loop died; restarting it so the other queues keep their work"
                );
                queue
            }
            // 关机之前循环自己返回了，这本来就不该发生。
            Some(Ok((id, queue))) => {
                owners.remove(&id);
                let restarts = restarts.entry(queue).or_default();
                *restarts += 1;
                tracing::error!(
                    queue,
                    restarts = *restarts,
                    "worker loop returned before shutdown; restarting it"
                );
                queue
            }
            // 一条都不剩了。上面的 `if !workers.is_empty()` 会让这条分支下一轮
            // 直接失效，select 就只等关机信号，不会在空 JoinSet 上忙转。
            None => continue,
        };
        tokio::time::sleep(backoff).await;
        spawn_one(&mut workers, &mut owners, queue);
    }
    // 关机语义保持原样：宽限期内自己收尾的任务不再重新拉起来。
    let _ = stop.send(true);
    let grace = async { while workers.join_next().await.is_some() {} };
    if tokio::time::timeout(std::time::Duration::from_secs(120), grace)
        .await
        .is_err()
    {
        workers.abort_all();
    }
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .expect("install SIGTERM handler");
        tokio::select! {_=tokio::signal::ctrl_c()=>{},_=terminate.recv()=>{}};
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    /// 这条测试盯的是那个「线上静默停摆」的缺口：一条循环 panic 掉之后，监督
    /// 者必须把它重新拉起来，而不是让它悄悄消失（以前）或者把整个进程拖走。
    ///
    /// 假循环：头两次进来直接 panic，第三次开始老实待着等停止信号。
    #[tokio::test]
    async fn a_loop_that_panics_gets_spawned_again() {
        let attempts = Arc::new(AtomicUsize::new(0));
        let (stop, rx) = tokio::sync::watch::channel(false);
        let (shutdown, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
        let make = {
            let attempts = attempts.clone();
            move |queue: &'static str| {
                let attempts = attempts.clone();
                let mut rx = rx.clone();
                async move {
                    let attempt = attempts.fetch_add(1, Ordering::SeqCst);
                    assert!(attempt >= 2, "假循环第 {attempt} 次故意死在 {queue} 上");
                    loop {
                        if *rx.borrow_and_update() {
                            break;
                        }
                        if rx.changed().await.is_err() {
                            break;
                        }
                    }
                }
            }
        };
        let supervisor = tokio::spawn(super::supervise(
            &["fake"],
            make,
            Duration::from_millis(10),
            stop,
            async move {
                let _ = shutdown_rx.await;
            },
        ));

        // 两次 panic 之后还能有第三次，说明它真的被重新 spawn 了。
        tokio::time::timeout(Duration::from_secs(5), async {
            while attempts.load(Ordering::SeqCst) < 3 {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("panic 掉的循环应该被重新拉起来");
        assert!(
            !supervisor.is_finished(),
            "一条循环 panic 不该把监督者（进而整个进程）带走"
        );

        // 停止信号之后正常收尾，并且不再有新的循环被拉起来。
        shutdown.send(()).expect("监督者应当还在等关机信号");
        tokio::time::timeout(Duration::from_secs(5), supervisor)
            .await
            .expect("监督者应当在关机信号之后及时收尾")
            .expect("监督者自己不该 panic");
        assert_eq!(
            attempts.load(Ordering::SeqCst),
            3,
            "宽限期内收尾的循环不该被重新拉起来"
        );
    }
}
