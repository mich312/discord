//! Protocol edge cases at the server boundary: the request/response paths in
//! server.rs that the happy-path flow tests don't hit — vault kinds, push
//! info/subscribe validation, re-auth rejection, malformed frames, invite
//! revoke/update, live Welcome delivery, and the blob HTTP surface.

use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use crypto_core::ChatClient;
use futures_util::{SinkExt, StreamExt};
use relay::blobs::BlobStore;
use relay::push::PushService;
use relay::server::App;
use relay::store::MemoryStore;
use serde_json::{json, Value};
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};
use tower::ServiceExt;

fn make_app() -> Arc<App> {
    App::with_parts(
        Box::new(MemoryStore::default()),
        BlobStore::new(tempfile::tempdir().unwrap().keep()).unwrap(),
        PushService::from_env(),
    )
}

async fn spawn(app: Arc<App>) -> SocketAddr {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, relay::router(app)).await.unwrap() });
    addr
}

struct Conn {
    ws: WebSocketStream<MaybeTlsStream<TcpStream>>,
    mls: ChatClient,
    rid: u64,
}

impl Conn {
    async fn connect(addr: SocketAddr, name: &str) -> Conn {
        Self::connect_with(addr, name, ChatClient::new(name).unwrap()).await
    }

    async fn connect_with(addr: SocketAddr, name: &str, mls: ChatClient) -> Conn {
        let (mut ws, _) =
            tokio_tungstenite::connect_async(format!("ws://{addr}/ws")).await.unwrap();
        ws.send(Message::Text(
            json!({"t":"hello","user":name,"pubkey":B64.encode(mls.signature_public_key())})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
        let challenge = recv(&mut ws).await;
        assert_eq!(challenge["t"], "challenge");
        let nonce = B64.decode(challenge["nonce"].as_str().unwrap()).unwrap();
        let mut signed = b"relay-auth-v1".to_vec();
        signed.extend_from_slice(&nonce);
        let sig = mls.sign(&signed).unwrap();
        ws.send(Message::Text(json!({"t":"auth","sig":B64.encode(sig)}).to_string().into()))
            .await
            .unwrap();
        let ready = recv(&mut ws).await;
        assert_eq!(ready["t"], "ready", "auth failed: {ready}");
        Conn { ws, mls, rid: 1 }
    }

    async fn send_raw(&mut self, v: Value) {
        self.ws.send(Message::Text(v.to_string().into())).await.unwrap();
    }

    async fn request(&mut self, mut v: Value) -> Value {
        let rid = self.rid;
        self.rid += 1;
        v["rid"] = json!(rid);
        self.send_raw(v).await;
        loop {
            let m = recv(&mut self.ws).await;
            if m["rid"] == json!(rid) {
                return m;
            }
        }
    }

    async fn recv_until(&mut self, pred: impl Fn(&Value) -> bool) -> Value {
        loop {
            let m = recv(&mut self.ws).await;
            if pred(&m) {
                return m;
            }
        }
    }
}

async fn recv(ws: &mut WebSocketStream<MaybeTlsStream<TcpStream>>) -> Value {
    loop {
        let frame = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("timeout waiting for server message")
            .expect("connection closed")
            .expect("ws error");
        if let Message::Text(t) = frame {
            return serde_json::from_str(&t).unwrap();
        }
    }
}

#[tokio::test]
async fn passkey_vault_roundtrips_and_bad_kind_is_rejected() {
    let addr = spawn(make_app()).await;
    let mut alice = Conn::connect(addr, "alice").await;

    // Fresh account: status has no kind.
    let status = alice.request(json!({"t":"vault_status"})).await;
    assert_eq!(status["t"], "vault_status");
    assert!(status["kind"].is_null());

    // A bogus kind is refused.
    let reply = alice
        .request(json!({
            "t":"vault_set","kind":"fingerprint",
            "salt":B64.encode(b"s"),"verifier":B64.encode(b"v"),
            "wrapped":B64.encode(b"w"),"credential":null,
        }))
        .await;
    assert_eq!(reply["t"], "error", "kind must be password or passkey");

    // A passkey vault sets and is reported back by status.
    let reply = alice
        .request(json!({
            "t":"vault_set","kind":"passkey",
            "salt":B64.encode(b"salt"),"verifier":B64.encode(b""),
            "wrapped":B64.encode(b"opaque"),"credential":"{\"cred\":true}",
        }))
        .await;
    assert_eq!(reply["t"], "ok", "vault_set passkey failed: {reply}");
    let status = alice.request(json!({"t":"vault_status"})).await;
    assert_eq!(status["kind"], "passkey");

    // Invalid base64 in a vault field is rejected.
    let reply = alice
        .request(json!({
            "t":"vault_set","kind":"password",
            "salt":"!!!not-base64","verifier":B64.encode(b"v"),
            "wrapped":B64.encode(b"w"),"credential":null,
        }))
        .await;
    assert_eq!(reply["t"], "error");
}

#[tokio::test]
async fn push_info_returns_a_key_and_bad_subscription_is_rejected() {
    let addr = spawn(make_app()).await;
    let mut alice = Conn::connect(addr, "alice").await;

    let info = alice.request(json!({"t":"push_info"})).await;
    assert_eq!(info["t"], "push_info");
    assert!(info["pubkey"].as_str().is_some_and(|k| !k.is_empty()), "must expose a VAPID pubkey");

    // A subscription JSON with no endpoint is rejected.
    let reply = alice.request(json!({"t":"push_subscribe","subscription":"{}"})).await;
    assert_eq!(reply["t"], "error");
    // Not even JSON.
    let reply = alice.request(json!({"t":"push_subscribe","subscription":"garbage"})).await;
    assert_eq!(reply["t"], "error");
    // A well-formed subscription with an endpoint is accepted.
    let sub = json!({"endpoint":"https://push.example/x","keys":{"p256dh":"a","auth":"b"}}).to_string();
    let reply = alice.request(json!({"t":"push_subscribe","subscription":sub})).await;
    assert_eq!(reply["t"], "ok");
}

#[tokio::test]
async fn ice_info_returns_a_usable_iceservers_array() {
    let addr = spawn(make_app()).await;
    let mut alice = Conn::connect(addr, "alice").await;

    let reply = alice.request(json!({"t":"ice_info"})).await;
    assert_eq!(reply["t"], "ice_info");
    // The client feeds `servers` straight into RTCPeerConnection, so it must
    // parse as a JSON array of objects with a `urls` field.
    let servers: Value = serde_json::from_str(reply["servers"].as_str().unwrap())
        .expect("ice servers must be valid JSON");
    let arr = servers.as_array().expect("ice servers must be a JSON array");
    assert!(!arr.is_empty(), "must advertise at least one ICE server");
    assert!(arr.iter().all(|s| s.get("urls").is_some()), "each entry needs a urls field");
}

#[tokio::test]
async fn re_authentication_and_malformed_frames_are_refused() {
    let addr = spawn(make_app()).await;
    let mut alice = Conn::connect(addr, "alice").await;

    // A second hello on an authenticated socket is an error, not a re-auth.
    alice.send_raw(json!({"t":"hello","user":"alice","pubkey":"AA=="})).await;
    let reply = alice.recv_until(|m| m["t"] == "error").await;
    assert_eq!(reply["message"], "already authenticated");

    // Non-JSON text frame yields a "bad message" error and keeps the socket up.
    alice.ws.send(Message::Text("this is not json".into())).await.unwrap();
    let reply = alice.recv_until(|m| m["t"] == "error").await;
    assert!(reply["message"].as_str().unwrap().starts_with("bad message"));

    // The connection still works afterwards.
    let info = alice.request(json!({"t":"push_info"})).await;
    assert_eq!(info["t"], "push_info");
}

#[tokio::test]
async fn revoking_a_missing_invite_succeeds_and_update_swaps_the_blob() {
    let addr = spawn(make_app()).await;
    let mut alice = Conn::connect(addr, "alice").await;
    alice.mls.create_group("g1").unwrap();
    alice.request(json!({"t":"create_group","group":"g1"})).await;

    // Revoking an invite that never existed is a no-op success (idempotent).
    let reply = alice.request(json!({"t":"revoke_invite","invite":"never"})).await;
    assert_eq!(reply["t"], "ok");

    // Create, then swap the blob via update_invite; a redeemer sees the new blob.
    let v1 = B64.encode(b"group-info-epoch-0");
    alice
        .request(json!({
            "t":"create_invite","invite":"inv","group":"g1",
            "payload":v1,"expires_at":null,"max_uses":null,
        }))
        .await;
    let v2 = B64.encode(b"group-info-epoch-1");
    let reply = alice.request(json!({"t":"update_invite","invite":"inv","payload":v2.clone()})).await;
    assert_eq!(reply["t"], "ok", "member may update the blob: {reply}");

    let mut bob = Conn::connect(addr, "bob").await;
    let reply = bob.request(json!({"t":"redeem_invite","invite":"inv"})).await;
    assert_eq!(reply["t"], "invite");
    assert_eq!(reply["payload"], v2, "redeem must return the updated blob");

    // Updating a nonexistent invite errors.
    let reply = alice.request(json!({"t":"update_invite","invite":"ghost","payload":v2})).await;
    assert_eq!(reply["t"], "error");
}

#[tokio::test]
async fn welcome_is_delivered_live_to_an_online_recipient() {
    let addr = spawn(make_app()).await;
    let mut alice = Conn::connect(addr, "alice").await;
    alice.mls.create_group("g1").unwrap();
    alice.request(json!({"t":"create_group","group":"g1"})).await;

    // bob is online (connected) but has not subscribed to g1 — the Welcome
    // still reaches him directly via the online map, not the group log.
    let mut bob = Conn::connect(addr, "bob").await;

    let payload = B64.encode(b"opaque-welcome-blob");
    let reply = alice
        .request(json!({"t":"welcome","to":"bob","group":"g1","after":0,"payload":payload.clone()}))
        .await;
    assert_eq!(reply["t"], "ok");

    let welcome = bob.recv_until(|m| m["t"] == "welcome").await;
    assert_eq!(welcome["from"], "alice");
    assert_eq!(welcome["group"], "g1");
    assert_eq!(welcome["payload"], payload);

    // A non-member cannot send a Welcome into someone else's group.
    let mut mallory = Conn::connect(addr, "mallory").await;
    let reply = mallory
        .request(json!({"t":"welcome","to":"bob","group":"g1","after":0,"payload":payload}))
        .await;
    assert_eq!(reply["t"], "error");
}

// === blob HTTP surface (put/get through the real router) ===================

async fn http(app: &Arc<App>, req: Request<Body>) -> (StatusCode, Vec<u8>) {
    let resp = relay::router(app.clone()).oneshot(req).await.unwrap();
    let status = resp.status();
    let body = to_bytes(resp.into_body(), 1 << 26).await.unwrap().to_vec();
    (status, body)
}

#[tokio::test]
async fn blob_http_put_get_and_error_paths() {
    let app = make_app();

    // GET before PUT -> 404.
    let (status, _) = http(&app, Request::get("/blobs/cap123").body(Body::empty()).unwrap()).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // PUT stores; GET returns the exact bytes.
    let (status, _) = http(
        &app,
        Request::put("/blobs/cap123").body(Body::from(&b"ciphertext"[..])).unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let (status, body) = http(&app, Request::get("/blobs/cap123").body(Body::empty()).unwrap()).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, b"ciphertext");

    // A blob id is a write-once capability: re-PUT is rejected.
    let (status, _) = http(
        &app,
        Request::put("/blobs/cap123").body(Body::from(&b"overwrite"[..])).unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // An id with characters outside the token alphabet is refused (no path tricks).
    let (status, _) = http(
        &app,
        Request::put("/blobs/bad.id").body(Body::from(&b"x"[..])).unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}
