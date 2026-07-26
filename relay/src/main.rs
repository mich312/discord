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
    let bind = std::env::var("RELAY_BIND").unwrap_or_else(|_| "0.0.0.0".into());
    let app = App::new(store);

    // Retention sweeper. Expired history entries were only ever deleted
    // inside history_after, i.e. when someone opened the room — so an
    // abandoned channel kept its expired ciphertext indefinitely and the
    // auto-delete setting was a promise the relay only sometimes kept.
    // Hourly is well inside the shortest retention (1 hour) being useful,
    // and the query is a single indexed DELETE.
    {
        let app = app.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(std::time::Duration::from_secs(3600));
            loop {
                tick.tick().await;
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                match app.store.sweep_expired_history(now).await {
                    Ok(0) => {}
                    Ok(n) => {
                        app.metrics.history_swept.add(n);
                        tracing::info!("retention sweep removed {n} expired history entries");
                    }
                    Err(e) => tracing::warn!("retention sweep failed: {e}"),
                }
            }
        });
    }

    let listener = tokio::net::TcpListener::bind(format!("{bind}:{port}")).await?;
    tracing::info!("relay listening on {bind}:{port} (ws at /ws)");
    // with_connect_info: peer addresses feed the per-client rate limits.
    axum::serve(
        listener,
        relay::router(app).into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .await?;
    Ok(())
}
