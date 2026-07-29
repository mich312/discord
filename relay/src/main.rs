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

    // Retention sweeper. Expired log entries were only ever deleted on
    // read, i.e. when someone opened the room — so an
    // abandoned channel kept its expired ciphertext indefinitely and the
    // auto-delete setting was a promise the relay only sometimes kept.
    // Hourly is well inside the shortest retention (1 hour) being useful,
    // and the query is a single indexed DELETE.
    {
        let app = app.clone();
        // Parsed once, at startup, so a typo is a warning in the boot log
        // rather than an hourly one nobody reads. 0 or unparseable means off,
        // which keeps a mistyped value from being read as "delete everything".
        let raw_ttl = std::env::var("BLOB_TTL_DAYS").ok();
        let blob_ttl = relay::blobs::blob_ttl_from(raw_ttl.as_deref());
        match (&raw_ttl, blob_ttl) {
            (Some(_), Some(d)) => {
                tracing::info!("attachments will be deleted after {} days", d.as_secs() / 86_400);
            }
            (Some(v), None) => tracing::warn!(
                "BLOB_TTL_DAYS={v:?} is not a positive whole number of days; \
                 attachments will be kept forever"
            ),
            _ => {}
        }
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

                // Attachment blobs, if the operator opted in. Off by default:
                // deleting someone's attachments is not a behaviour anyone
                // should acquire by upgrading. Age-based, because the relay
                // cannot know which blobs are still referenced — the id lives
                // inside the encrypted message that points at it.
                if let Some(ttl) = blob_ttl {
                    match app.blobs.sweep_older_than(ttl, std::time::SystemTime::now()).await {
                        Ok(0) => {}
                        Ok(n) => {
                            app.metrics.blobs_swept.add(n);
                            tracing::info!("blob sweep removed {n} attachments past BLOB_TTL_DAYS");
                        }
                        Err(e) => tracing::warn!("blob sweep failed: {e}"),
                    }
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
