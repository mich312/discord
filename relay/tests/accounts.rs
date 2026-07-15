//! Account vault: set over authenticated ws, retrieve via the pre-auth
//! HTTP endpoints. The relay stores an encrypted blob plus a verifier —
//! never the password, never the wrap key.

use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use crypto_core::{derive_login_keys, ChatClient};
use futures_util::{SinkExt, StreamExt};
use relay::blobs::BlobStore;
use relay::push::PushService;
use relay::server::App;
use relay::store::MemoryStore;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio_tungstenite::tungstenite::Message;
use tower::ServiceExt;

async fn http(app: &std::sync::Arc<App>, request: Request<Body>) -> (StatusCode, Value) {
    let response = relay::router(app.clone()).oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1 << 20).await.unwrap();
    let body = serde_json::from_slice(&bytes).unwrap_or(Value::String(
        String::from_utf8_lossy(&bytes).into_owned(),
    ));
    (status, body)
}

#[tokio::test]
async fn password_vault_roundtrip() {
    let app = App::with_parts(
        Box::new(MemoryStore::default()),
        BlobStore::new(tempfile::tempdir().unwrap().keep()).unwrap(),
        PushService::from_env(),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    {
        let app = app.clone();
        tokio::spawn(async move { axum::serve(listener, relay::router(app)).await.unwrap() });
    }

    // alice authenticates and parks her wrapped identity.
    let mls = ChatClient::new("alice").unwrap();
    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/ws")).await.unwrap();
    ws.send(Message::Text(
        json!({"t":"hello","user":"alice","pubkey":B64.encode(mls.signature_public_key())}).to_string(),
    ))
    .await
    .unwrap();
    let challenge: Value =
        serde_json::from_str(ws.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
    let nonce = B64.decode(challenge["nonce"].as_str().unwrap()).unwrap();
    let mut signed = b"relay-auth-v1".to_vec();
    signed.extend_from_slice(&nonce);
    ws.send(Message::Text(json!({"t":"auth","sig":B64.encode(mls.sign(&signed).unwrap())}).to_string()))
        .await
        .unwrap();
    let ready: Value =
        serde_json::from_str(ws.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
    assert_eq!(ready["t"], "ready");

    // Before securing: vault_status says unsecured.
    ws.send(Message::Text(json!({"t":"vault_status","rid":1}).to_string())).await.unwrap();
    let status: Value =
        serde_json::from_str(ws.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
    assert_eq!(status["t"], "vault_status");
    assert!(status["kind"].is_null());

    // Derive keys client-side; the "wrapped" blob here is stand-in bytes
    // (the client AES-GCMs the identity — the relay can't tell).
    let salt = b"e2e-salt-16bytes";
    let keys = derive_login_keys("hunter2 but longer", salt).unwrap();
    let (auth_key, _wrap_key) = keys.split_at(32);
    let verifier = Sha256::digest(auth_key).to_vec();
    ws.send(Message::Text(
        json!({
            "t":"vault_set","rid":2,"kind":"password",
            "salt":B64.encode(salt),"verifier":B64.encode(&verifier),
            "wrapped":B64.encode(b"opaque-encrypted-identity"),"credential":null,
        })
        .to_string(),
    ))
    .await
    .unwrap();
    let reply: Value =
        serde_json::from_str(ws.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
    assert_eq!(reply["t"], "ok", "vault_set failed: {reply}");

    // New device flow, no identity yet: params -> derive -> login.
    let (status, body) = http(
        &app,
        Request::get("/account/alice/params").body(Body::empty()).unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["kind"], "password");
    assert_eq!(B64.decode(body["salt"].as_str().unwrap()).unwrap(), salt);

    let (status, body) = http(
        &app,
        Request::post("/account/alice/login")
            .header("content-type", "application/json")
            .body(Body::from(json!({"auth_key": B64.encode(auth_key)}).to_string()))
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        B64.decode(body["wrapped"].as_str().unwrap()).unwrap(),
        b"opaque-encrypted-identity"
    );

    // Wrong password -> wrong auth key -> refused, blob withheld.
    let bad = derive_login_keys("wrong password!!", salt).unwrap();
    let (status, _) = http(
        &app,
        Request::post("/account/alice/login")
            .header("content-type", "application/json")
            .body(Body::from(json!({"auth_key": B64.encode(&bad[..32])}).to_string()))
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // Unknown users 404 (existence probing is accepted and documented).
    let (status, _) = http(
        &app,
        Request::get("/account/nobody/params").body(Body::empty()).unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}
