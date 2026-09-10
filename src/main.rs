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
            let mut workers = tokio::task::JoinSet::new();
            for queue in ["interactive", "interactive", "batch", "maintenance"] {
                let services = s.clone();
                let mut rx = rx.clone();
                workers.spawn(async move {
                    let mut next_gc=tokio::time::Instant::now();
                    let mut next_replay_sweep=tokio::time::Instant::now();
                    loop {
                        // Hourly fallback for replay bars the frontend never deleted on exit.
                        if queue=="maintenance" && tokio::time::Instant::now()>=next_replay_sweep {
                            match scorebook::application::replay::sweep(&services).await {
                                Ok(n)=>{if n>0 {tracing::info!(removed=n,"expired replay bars swept");}},
                                Err(e)=>tracing::warn!(code=%e.code,"replay sweep failed"),
                            }
                            next_replay_sweep=tokio::time::Instant::now()+std::time::Duration::from_secs(3600);
                        }
                        if queue=="maintenance" && tokio::time::Instant::now()>=next_gc {
                            if let Err(e)=scorebook::application::backups::schedule(&services).await {tracing::warn!(code=%e.code,"backup scheduling failed");}
                            if let Err(e)=scorebook::application::gc::schedule(&services).await {tracing::warn!(code=%e.code,"cleanup scheduling failed");}
                            if let Err(e)=scorebook::application::knowledge_index::index::schedule(&services).await {tracing::warn!(code=%e.code,"knowledge index scheduling failed");}
                            if let Err(e)=scorebook::application::history_catalog::schedule(&services).await {tracing::warn!(code=%e.code,"history subscription scheduling failed");}
                            next_gc=tokio::time::Instant::now()+std::time::Duration::from_secs(60);
                        }
                        if *rx.borrow(){break;}
                        match jobs::run_filtered(&services,None,Some(queue)).await {
                            Ok(true)=>{},
                            result=>{
                                if let Err(e)=result{tracing::warn!(code=%e.code,queue,"worker iteration failed");}
                                tokio::select!{_=rx.changed()=>{},_=tokio::time::sleep(std::time::Duration::from_secs(2))=>{}}
                            }
                        }
                    }
                });
            }
            shutdown_signal().await;
            let _ = stop.send(true);
            let grace = async { while workers.join_next().await.is_some() {} };
            if tokio::time::timeout(std::time::Duration::from_secs(120), grace)
                .await
                .is_err()
            {
                workers.abort_all();
            }
        }
        _ => {}
    }
    Ok(())
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
