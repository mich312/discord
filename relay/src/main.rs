use relay::pg::PgStore;
use relay::server::App;
use relay::store::MemoryStore;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt::init();

    let store: Box<dyn relay::store::Store> = match std::env::var("DATABASE_URL") {
        Ok(url) => {
            tracing::info!("using postgres store");
            Box::new(PgStore::connect(&url).await.map_err(|e| anyhow::anyhow!("{e}"))?)
        }
        Err(_) => {
            tracing::warn!("DATABASE_URL not set — using in-memory store (nothing survives restart)");
            Box::new(MemoryStore::default())
        }
    };

    let port: u16 = std::env::var("RELAY_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(9601);
    let app = App::new(store);
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await?;
    tracing::info!("relay listening on ws://127.0.0.1:{port}/ws");
    axum::serve(listener, relay::router(app)).await?;
    Ok(())
}
