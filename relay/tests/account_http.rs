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
async fn passkey_wrap_round_trips_by_credential_id() {
    let app = make_app();
    app.store
        .add_passkey_wrap(
            "cred-abc",
            wrap("alice", "sealed-identity", "phone", 100),
        )
        .await
        .unwrap();
    let got = app.store.get_passkey_wrap("cred-abc").await.unwrap().unwrap();
    assert_eq!(got.user, "alice");
    assert_eq!(got.wrapped, b"sealed-identity");
    assert!(app.store.get_passkey_wrap("missing").await.unwrap().is_none());
}

/// A device passkey wrap, with the fields these tests care about.
fn wrap(user: &str, sealed: &str, label: &str, created_at: i64) -> relay::store::PasskeyWrap {
    relay::store::PasskeyWrap {
        user: user.into(),
        credential: "{\"stub\":true}".into(),
        salt: b"salt".to_vec(),
        wrapped: sealed.as_bytes().to_vec(),
        label: label.into(),
        created_at,
    }
}

/* --- device revocation (forward-only) ---------------------------------- */

#[tokio::test]
async fn listing_devices_never_returns_the_sealed_identity() {
    // The point of revoking a device is to stop it obtaining the wrapped
    // identity. A list endpoint that returned the wrap alongside the label
    // would hand it to anyone who asks, so `PasskeyDevice` has no field for
    // it — this test exists so that stays true if someone "helpfully" widens
    // the struct later.
    let app = make_app();
    app.store
        .add_passkey_wrap("c1", wrap("alice", "sealed-identity", "laptop", 100))
        .await
        .unwrap();

    let devices = app.store.list_passkey_wraps("alice").await.unwrap();
    assert_eq!(devices.len(), 1);
    assert_eq!(devices[0].cred_id, "c1");
    assert_eq!(devices[0].label, "laptop");
    let rendered = format!("{:?}", devices[0]);
    assert!(!rendered.contains("sealed-identity"), "the wrap must not be reachable: {rendered}");
}

#[tokio::test]
async fn devices_are_listed_newest_first_and_only_your_own() {
    let app = make_app();
    app.store.add_passkey_wrap("c-old", wrap("alice", "s", "old", 100)).await.unwrap();
    app.store.add_passkey_wrap("c-new", wrap("alice", "s", "new", 300)).await.unwrap();
    app.store.add_passkey_wrap("c-bob", wrap("bob", "s", "bob's", 200)).await.unwrap();

    let ids: Vec<String> =
        app.store.list_passkey_wraps("alice").await.unwrap().into_iter().map(|d| d.cred_id).collect();
    assert_eq!(ids, vec!["c-new", "c-old"], "newest first, and bob's is not alice's business");
    assert!(app.store.list_passkey_wraps("nobody").await.unwrap().is_empty());
}

#[tokio::test]
async fn a_revoked_device_can_no_longer_unlock_the_identity() {
    let app = make_app();
    app.store.add_passkey_wrap("c1", wrap("alice", "sealed-identity", "laptop", 100)).await.unwrap();

    assert!(app.store.delete_passkey_wrap("c1", "alice").await.unwrap());
    assert!(
        app.store.get_passkey_wrap("c1").await.unwrap().is_none(),
        "revocation has to remove the wrap itself, not just hide it from the list"
    );
    assert!(app.store.list_passkey_wraps("alice").await.unwrap().is_empty());
}

#[tokio::test]
async fn you_cannot_revoke_somebody_else_s_device() {
    // The authorization the whole feature rests on. A credential id is
    // disclosed by the passkey challenge, so without the ownership scope
    // anyone who has seen one could unenroll its owner's device.
    let app = make_app();
    app.store.add_passkey_wrap("c-bob", wrap("bob", "s", "bob's laptop", 100)).await.unwrap();

    assert!(!app.store.delete_passkey_wrap("c-bob", "mallory").await.unwrap());
    assert!(
        app.store.get_passkey_wrap("c-bob").await.unwrap().is_some(),
        "bob still has his device"
    );
}

#[tokio::test]
async fn revoking_an_unknown_device_is_indistinguishable_from_revoking_another_s() {
    // Both answer false rather than distinct errors: telling them apart
    // would answer "is this credential id enrolled by somebody?" for anyone
    // who asks.
    let app = make_app();
    app.store.add_passkey_wrap("c-bob", wrap("bob", "s", "bob's", 100)).await.unwrap();
    assert!(!app.store.delete_passkey_wrap("nope", "mallory").await.unwrap());
    assert!(!app.store.delete_passkey_wrap("c-bob", "mallory").await.unwrap());
}

#[tokio::test]
async fn re_enrolling_the_same_credential_replaces_rather_than_duplicates() {
    let app = make_app();
    app.store.add_passkey_wrap("c1", wrap("alice", "first", "phone", 100)).await.unwrap();
    app.store.add_passkey_wrap("c1", wrap("alice", "second", "phone renamed", 400)).await.unwrap();

    let devices = app.store.list_passkey_wraps("alice").await.unwrap();
    assert_eq!(devices.len(), 1, "one credential is one device");
    assert_eq!(devices[0].label, "phone renamed");
    assert_eq!(app.store.get_passkey_wrap("c1").await.unwrap().unwrap().wrapped, b"second");
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
