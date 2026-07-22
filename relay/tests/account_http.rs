//! Account HTTP endpoints — the branches accounts.rs's happy-path roundtrip
//! doesn't reach: wrong-kind mismatches, malformed input, and unknown users.
//! Vaults are seeded directly through the store so these stay focused on the
//! pre-auth HTTP surface (no WebSocket ceremony needed).

use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use relay::blobs::BlobStore;
use relay::push::PushService;
use relay::server::App;
use relay::store::{MemoryStore, Store, VaultRecord};
use serde_json::{json, Value};
use std::sync::Arc;

fn make_app() -> Arc<App> {
    App::with_parts(
        Box::new(MemoryStore::default()),
        BlobStore::new(tempfile::tempdir().unwrap().keep()).unwrap(),
        PushService::from_env(),
        true,
    )
}

async fn http(app: &Arc<App>, req: Request<Body>) -> (StatusCode, Value) {
    use tower::ServiceExt;
    let resp = relay::router(app.clone()).oneshot(req).await.unwrap();
    let status = resp.status();
    let bytes = to_bytes(resp.into_body(), 1 << 20).await.unwrap();
    let body = serde_json::from_slice(&bytes)
        .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into_owned()));
    (status, body)
}

async fn seed_password_vault(app: &Arc<App>, user: &str, auth_key: &[u8]) {
    app.store
        .set_vault(
            user,
            VaultRecord {
                kind: "password".into(),
                salt: b"salt-16-bytes---".to_vec(),
                verifier: relay::account::verifier_of(auth_key),
                wrapped: b"opaque-identity".to_vec(),
                credential: None,
            },
        )
        .await
        .unwrap();
}

async fn seed_passkey_vault(app: &Arc<App>, user: &str) {
    app.store
        .set_vault(
            user,
            VaultRecord {
                kind: "passkey".into(),
                salt: b"passkey-salt----".to_vec(),
                verifier: Vec::new(),
                wrapped: b"opaque-identity".to_vec(),
                credential: Some("{\"stub\":true}".into()),
            },
        )
        .await
        .unwrap();
}

fn post_login(user: &str, auth_key_b64: &str) -> Request<Body> {
    Request::post(format!("/account/{user}/login"))
        .header("content-type", "application/json")
        .body(Body::from(json!({ "auth_key": auth_key_b64 }).to_string()))
        .unwrap()
}

#[tokio::test]
async fn params_reports_kind_and_salt_for_passkey() {
    let app = make_app();
    seed_passkey_vault(&app, "alice").await;
    let (status, body) = http(&app, Request::get("/account/alice/params").body(Body::empty()).unwrap()).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["kind"], "passkey");
    assert_eq!(B64.decode(body["salt"].as_str().unwrap()).unwrap(), b"passkey-salt----");
}

#[tokio::test]
async fn params_404s_for_unknown_user() {
    let app = make_app();
    let (status, _) = http(&app, Request::get("/account/ghost/params").body(Body::empty()).unwrap()).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn password_login_correct_and_wrong_and_unknown() {
    let app = make_app();
    seed_password_vault(&app, "alice", b"the-real-auth-key").await;

    // Correct auth key -> the wrapped blob is handed back.
    let (status, body) = http(&app, post_login("alice", &B64.encode(b"the-real-auth-key"))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(B64.decode(body["wrapped"].as_str().unwrap()).unwrap(), b"opaque-identity");

    // Wrong auth key -> 403 and no blob.
    let (status, _) = http(&app, post_login("alice", &B64.encode(b"wrong-auth-key---"))).await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // Unknown user -> 404.
    let (status, _) = http(&app, post_login("ghost", &B64.encode(b"whatever"))).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn password_login_rejects_bad_base64() {
    let app = make_app();
    seed_password_vault(&app, "alice", b"key").await;
    let (status, _) = http(&app, post_login("alice", "!!!not-base64!!!")).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn password_login_against_a_passkey_vault_is_a_bad_request() {
    let app = make_app();
    seed_passkey_vault(&app, "alice").await;
    let (status, body) = http(&app, post_login("alice", &B64.encode(b"anything"))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(body.as_str().unwrap_or("").contains("not password-based"));
}

#[tokio::test]
async fn passkey_challenge_against_a_password_vault_is_a_bad_request() {
    let app = make_app();
    seed_password_vault(&app, "alice", b"key").await;
    let (status, body) = http(
        &app,
        Request::post("/account/alice/passkey/challenge").body(Body::empty()).unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(body.as_str().unwrap_or("").contains("not passkey-based"));
}

#[tokio::test]
async fn passkey_challenge_404s_for_unknown_user() {
    let app = make_app();
    let (status, _) = http(
        &app,
        Request::post("/account/ghost/passkey/challenge").body(Body::empty()).unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn discover_challenge_is_usernameless_and_empty_allow_credentials() {
    let app = make_app();
    let (status, body) = http(
        &app,
        Request::post("/passkey/discover/challenge").body(Body::empty()).unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    // A session token to echo back, and a challenge the authenticator answers.
    assert!(body["session"].as_str().is_some());
    // Usernameless: the authenticator — not the server — chooses the credential.
    let allow = &body["options"]["publicKey"]["allowCredentials"];
    assert!(allow.is_null() || allow.as_array().unwrap().is_empty());
}

#[tokio::test]
async fn discover_login_rejects_an_assertion_without_a_raw_id() {
    let app = make_app();
    let (status, _) = http(
        &app,
        Request::post("/passkey/discover/login")
            .header("content-type", "application/json")
            .body(Body::from(
                json!({ "session": "nope", "assertion": { "not": "a credential" } }).to_string(),
            ))
            .unwrap(),
    )
    .await;
    // Malformed: no credential id to match on.
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn discover_login_rejects_an_unknown_credential() {
    let app = make_app();
    seed_passkey_vault(&app, "alice").await; // a passkey vault exists, but not this id
    let (status, body) = http(
        &app,
        Request::post("/passkey/discover/login")
            .header("content-type", "application/json")
            .body(Body::from(
                json!({ "session": "nope", "assertion": { "rawId": "b3RoZXItY3JlZGVudGlhbA" } })
                    .to_string(),
            ))
            .unwrap(),
    )
    .await;
    // Well-formed but matches no stored passkey -> refused, nothing leaked.
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(body.as_str().unwrap_or("").contains("unrecognized passkey"));
}

#[tokio::test]
async fn list_passkey_vaults_filters_out_password_vaults() {
    let app = make_app();
    seed_password_vault(&app, "pw", b"k").await;
    seed_passkey_vault(&app, "pk").await;
    let vaults = app.store.list_passkey_vaults().await.unwrap();
    assert_eq!(vaults.len(), 1);
    assert_eq!(vaults[0].0, "pk");
    assert_eq!(vaults[0].1.kind, "passkey");
}
