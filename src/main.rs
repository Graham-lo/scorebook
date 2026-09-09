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
        Command::Openapi => {
            println!(
                "{}",
                serde_json::to_string_pretty(&scorebook::http::openapi())?
            );
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
    let s = Services {
        db,
        storage: Storage::new(std::env::var("SCOREBOOK_STORAGE").unwrap_or_else(|_| "data".into())),
        vision: Vision::new(std::env::var("SCOREBOOK_VISION_URL").ok()),
    };
    let issuing_read_only = matches!(&cli.command, Command::CreateReadKey { .. });
    match cli.command {
        Command::Migrate => println!("Migrations applied."),
        Command::RefreshInstruments => println!(
            "{}",
            scorebook::application::instruments::refresh(&s)
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
                .with_graceful_shutdown(async {
                    let _ = tokio::signal::ctrl_c().await;
                })
                .await?;
        }
        Command::Worker => {
            tracing::info!("Scorebook worker running");
            loop {
                tokio::select! {_ = tokio::signal::ctrl_c()=>break,r=jobs::run_one(&s)=>{match r{Ok(true)=>{},Ok(false)=>tokio::time::sleep(std::time::Duration::from_secs(2)).await,Err(e)=>{tracing::warn!(code=%e.code,"worker iteration failed");tokio::time::sleep(std::time::Duration::from_secs(2)).await;}}}}
            }
        }
        _ => {}
    }
    Ok(())
}
