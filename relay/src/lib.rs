pub mod pg;
pub mod proto;
pub mod server;
pub mod store;

use axum::extract::{State, WebSocketUpgrade};
use axum::response::IntoResponse;
use axum::routing::any;
use axum::Router;
use server::App;
use std::sync::Arc;

pub fn router(app: Arc<App>) -> Router {
    Router::new().route("/ws", any(ws_handler)).with_state(app)
}

async fn ws_handler(ws: WebSocketUpgrade, State(app): State<Arc<App>>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| server::handle_socket(socket, app))
}
