pub mod account;
pub mod blobs;
pub mod pg;
pub mod proto;
pub mod push;
pub mod ratelimit;
pub mod server;
pub mod store;

use axum::body::Bytes;
use axum::extract::{ConnectInfo, DefaultBodyLimit, Path, Request, State, WebSocketUpgrade};
use axum::http::{header, HeaderName, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use axum::Router;
use server::App;
use std::net::SocketAddr;
use std::sync::Arc;
use tower_http::cors::CorsLayer;
use tower_http::services::ServeDir;
use tower_http::set_header::SetResponseHeaderLayer;

/// Plan §5.1: the browser bundle carries the crypto, so code delivery is
/// the weak point. A strict CSP narrows what a slipped-in script can do.
/// Notes on the exceptions:
/// - `wasm-unsafe-eval`: the crypto core IS WebAssembly (compiled in the
///   worker; no JS eval of any kind is allowed).
/// - `blob:`/`data:` images + `blob:` media: decrypted attachments render
///   from object URLs; the favicon is a data: SVG.
/// - `style-src 'unsafe-inline'`: React style attributes. CSS injection
///   is not in the threat model script injection is.
/// The same header rides on every response (worker.js and sw.js get their
/// own CSP from their response headers, so the worker is covered too).
const CSP: &str = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; \
    worker-src 'self'; connect-src 'self'; img-src 'self' blob: data:; \
    media-src blob:; style-src 'self' 'unsafe-inline'; object-src 'none'; \
    base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

pub fn router(app: Arc<App>) -> Router {
    let mut router = Router::new()
        .merge(
            Router::new()
                .route("/ws", any(ws_handler))
                .route_layer(middleware::from_fn_with_state(app.clone(), limit_ws)),
        )
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
        // Rate-limited per client: these are the online-guessing and
        // username-enumeration surfaces.
        .merge(
            Router::new()
                .route("/account/{user}/params", axum::routing::get(account::params))
                .route("/account/{user}/login", axum::routing::post(account::password_login))
                .route("/account/{user}/passkey/challenge", axum::routing::post(account::passkey_challenge))
                .route("/account/{user}/passkey/login", axum::routing::post(account::passkey_login))
                .route_layer(middleware::from_fn_with_state(app.clone(), limit_account)),
        );
    // Single-container mode: the relay serves the built client too, so one
    // process on one port is the whole deployment.
    if let Ok(dir) = std::env::var("CLIENT_DIR") {
        router = router.fallback_service(ServeDir::new(dir));
    }
    router
        .layer(DefaultBodyLimit::max(blobs::MAX_BLOB_BYTES + 1024))
        .layer(CorsLayer::permissive())
        // Security headers on everything the relay serves — including the
        // client, the worker, and the service worker in single-container
        // mode. Caddy proxies these through untouched, so every deploy
        // shape gets them. Harmless on JSON/blob responses.
        .layer(SetResponseHeaderLayer::if_not_present(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static(CSP),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::REFERRER_POLICY,
            HeaderValue::from_static("no-referrer"),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::X_FRAME_OPTIONS,
            HeaderValue::from_static("DENY"),
        ))
        // Voice channels need the microphone; nothing needs the rest.
        .layer(SetResponseHeaderLayer::if_not_present(
            HeaderName::from_static("permissions-policy"),
            HeaderValue::from_static("camera=(), geolocation=(), microphone=(self), payment=(), usb=()"),
        ))
        .with_state(app)
}

async fn ws_handler(ws: WebSocketUpgrade, State(app): State<Arc<App>>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| server::handle_socket(socket, app))
}

async fn register_policy(State(app): State<Arc<App>>) -> impl IntoResponse {
    let open = server::registration_allowed(&app, None).await;
    axum::Json(serde_json::json!({ "invite_required": !open }))
}

/// The client key for rate limiting. `ConnectInfo` is only present when
/// served with `into_make_service_with_connect_info` (main.rs does);
/// in-process test routers fall back to a single shared bucket.
fn limit_key(app: &App, req: &Request) -> std::net::IpAddr {
    let peer = req.extensions().get::<ConnectInfo<SocketAddr>>().map(|c| c.0);
    ratelimit::client_ip(app.trust_proxy, req.headers(), peer)
}

async fn limit_account(State(app): State<Arc<App>>, req: Request, next: Next) -> Response {
    // The GET params probe gets a higher allowance than credential attempts.
    let limiter = if req.method() == Method::GET { &app.limits.params } else { &app.limits.account };
    if !limiter.allow(limit_key(&app, &req)) {
        return (StatusCode::TOO_MANY_REQUESTS, "rate limited — try again shortly").into_response();
    }
    next.run(req).await
}

async fn limit_ws(State(app): State<Arc<App>>, req: Request, next: Next) -> Response {
    if !app.limits.ws.allow(limit_key(&app, &req)) {
        return (StatusCode::TOO_MANY_REQUESTS, "rate limited — try again shortly").into_response();
    }
    next.run(req).await
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
