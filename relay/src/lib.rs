pub mod account;
pub mod blobs;
pub mod pg;
pub mod proto;
pub mod push;
pub mod server;
pub mod store;

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path, State, WebSocketUpgrade};
use axum::http::{header, StatusCode};
use axum::response::IntoResponse;
use axum::routing::any;
use axum::Router;
use server::App;
use std::sync::Arc;
use tower_http::cors::CorsLayer;
use tower_http::services::ServeDir;

pub fn router(app: Arc<App>) -> Router {
    let mut router = Router::new()
        .route("/ws", any(ws_handler))
        // Attachment blobs: opaque AES-GCM ciphertext on disk. The id is a
        // client-generated random capability; the file key travels inside
        // the MLS message. CORS is open — content is ciphertext and ids are
        // unguessable.
        .route("/blobs/{id}", axum::routing::put(put_blob).get(get_blob))
        // Can a fresh identity register without an invite right now? Lets
        // the onboarding UI say "invite-only" up front instead of failing
        // after key generation. The WS handshake enforces it regardless.
        .route("/register/policy", axum::routing::get(register_policy))
        // Account sign-in (pre-auth: a new device has no identity key yet).
        .route("/account/{user}/params", axum::routing::get(account::params))
        .route("/account/{user}/login", axum::routing::post(account::password_login))
        .route("/account/{user}/passkey/challenge", axum::routing::post(account::passkey_challenge))
        .route("/account/{user}/passkey/login", axum::routing::post(account::passkey_login));
    // Single-container mode: the relay serves the built client too, so one
    // process on one port is the whole deployment.
    if let Ok(dir) = std::env::var("CLIENT_DIR") {
        router = router.fallback_service(ServeDir::new(dir));
    }
    router
        .layer(DefaultBodyLimit::max(blobs::MAX_BLOB_BYTES + 1024))
        .layer(CorsLayer::permissive())
        .with_state(app)
}

async fn ws_handler(ws: WebSocketUpgrade, State(app): State<Arc<App>>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| server::handle_socket(socket, app))
}

async fn register_policy(State(app): State<Arc<App>>) -> impl IntoResponse {
    let open = server::registration_allowed(&app, None).await;
    axum::Json(serde_json::json!({ "invite_required": !open }))
}

async fn put_blob(
    Path(id): Path<String>,
    State(app): State<Arc<App>>,
    body: Bytes,
) -> impl IntoResponse {
    match app.blobs.put(&id, &body).await {
        Ok(()) => (StatusCode::CREATED, String::new()),
        Err(e) => (StatusCode::BAD_REQUEST, e),
    }
}

async fn get_blob(Path(id): Path<String>, State(app): State<Arc<App>>) -> impl IntoResponse {
    match app.blobs.get(&id).await {
        Ok(Some(data)) => {
            ([(header::CONTENT_TYPE, "application/octet-stream")], data).into_response()
        }
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}
