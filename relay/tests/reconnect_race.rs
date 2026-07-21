//! Regression: overlapping connections for one user must not destroy each
//! other's subscriptions. A half-open socket's teardown used to remove the
//! user's subscriber entries unconditionally — deleting the entry now owned
//! by the *reconnected* socket and leaving the user online-but-unsubscribed:
//! no live delivery, and no push either (push skips live-looking members).
//! This was the root cause of "messages sometimes never appear".

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use crypto_core::ChatClient;
use futures_util::{SinkExt, StreamExt};
use relay::server::App;
use relay::store::MemoryStore;
use serde_json::{json, Value};
use std::net::SocketAddr;
use std::time::Duration;
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

async fn spawn_relay() -> SocketAddr {
    let blobs =
        relay::blobs::BlobStore::new(tempfile::tempdir().map(|d| d.keep()).unwrap()).unwrap();
    let app = App::with_parts_and_admins(
        Box::new(MemoryStore::default()),
        blobs,
        relay::push::PushService::from_env(),
        true,
        Default::default(),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, relay::router(app)).await.unwrap();
    });
    addr
}

/// Raw authenticated socket: hello -> challenge -> auth -> ready.
async fn connect(addr: SocketAddr, mls: &ChatClient, name: &str) -> Ws {
    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/ws")).await.unwrap();
    ws.send(Message::Text(
        json!({
            "t": "hello",
            "user": name,
            "pubkey": B64.encode(mls.signature_public_key()),
            "invite": null,
        })
        .to_string(),
    ))
    .await
    .unwrap();
    let challenge = recv(&mut ws).await;
    assert_eq!(challenge["t"], "challenge");
    let nonce = B64.decode(challenge["nonce"].as_str().unwrap()).unwrap();
    let mut signed = b"relay-auth-v1".to_vec();
    signed.extend_from_slice(&nonce);
    let sig = mls.sign(&signed).unwrap();
    ws.send(Message::Text(json!({"t": "auth", "sig": B64.encode(sig)}).to_string()))
        .await
        .unwrap();
    let ready = recv(&mut ws).await;
    assert_eq!(ready["t"], "ready", "auth failed: {ready}");
    ws
}

async fn recv(ws: &mut Ws) -> Value {
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

async fn request(ws: &mut Ws, rid: u64, mut v: Value) -> Value {
    v["rid"] = json!(rid);
    ws.send(Message::Text(v.to_string())).await.unwrap();
    loop {
        let m = recv(ws).await;
        if m["rid"] == json!(rid) {
            return m;
        }
    }
}

#[tokio::test]
async fn stale_socket_teardown_must_not_wipe_the_reconnected_subscription() {
    let addr = spawn_relay().await;
    let alice = ChatClient::new("alice").unwrap();
    let bob = ChatClient::new("bob").unwrap();

    // Alice connects (conn 1), creates the group, subscribes.
    let mut a1 = connect(addr, &alice, "alice").await;
    assert_eq!(request(&mut a1, 1, json!({"t": "create_group", "group": "g1"})).await["t"], "ok");
    assert_eq!(
        request(&mut a1, 2, json!({"t": "subscribe", "group": "g1", "after": 0})).await["t"],
        "ok"
    );

    // Bob registers and is allowed in (ACL only — payloads are opaque).
    let mut b = connect(addr, &bob, "bob").await;
    assert_eq!(
        request(&mut a1, 3, json!({"t": "allow", "group": "g1", "user": "bob"})).await["t"],
        "ok"
    );

    // Alice "reconnects" while conn 1 is still open (the half-open-socket
    // scenario: the server hasn't noticed conn 1 is dead yet) and
    // re-subscribes on conn 2.
    let alice2 = ChatClient::import_identity(&alice.export_identity().unwrap()).unwrap();
    let mut a2 = connect(addr, &alice2, "alice").await;
    assert_eq!(
        request(&mut a2, 1, json!({"t": "subscribe", "group": "g1", "after": 0})).await["t"],
        "ok"
    );

    // The old socket finally tears down.
    drop(a1);
    tokio::time::sleep(Duration::from_millis(200)).await;

    // A message sent now must still reach conn 2 live.
    let payload = B64.encode(b"opaque-mls-blob");
    assert_eq!(
        request(&mut b, 1, json!({"t": "send", "group": "g1", "epoch": 0, "payload": payload}))
            .await["t"],
        "ok"
    );
    let msg = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let m = recv(&mut a2).await;
            if m["t"] == "msg" {
                return m;
            }
        }
    })
    .await
    .expect("conn 2 never received the message: its subscription was wiped by conn 1's teardown");
    assert_eq!(msg["group"], "g1");
    assert_eq!(msg["sender"], "bob");
}

#[tokio::test]
async fn ping_answers_ok() {
    let addr = spawn_relay().await;
    let alice = ChatClient::new("alice").unwrap();
    let mut ws = connect(addr, &alice, "alice").await;
    let reply = request(&mut ws, 1, json!({"t": "ping"})).await;
    assert_eq!(reply["t"], "ok");
}

#[tokio::test]
async fn ephemeral_notify_is_accepted_and_fans_out() {
    let addr = spawn_relay().await;
    let alice = ChatClient::new("alice").unwrap();
    let bob = ChatClient::new("bob").unwrap();

    let mut a = connect(addr, &alice, "alice").await;
    assert_eq!(request(&mut a, 1, json!({"t": "create_group", "group": "g1"})).await["t"], "ok");
    assert_eq!(
        request(&mut a, 2, json!({"t": "allow", "group": "g1", "user": "bob"})).await["t"],
        "ok"
    );
    let mut b = connect(addr, &bob, "bob").await;
    assert_eq!(
        request(&mut b, 1, json!({"t": "subscribe", "group": "g1", "after": 0})).await["t"],
        "ok"
    );

    // A ring-style ephemeral naming an offline member (carol is not even
    // registered — must be ignored) and a live one (bob — gets it live, no
    // push needed). The request must succeed and still fan out.
    let payload = B64.encode(b"sealed-ring");
    assert_eq!(
        request(
            &mut a,
            3,
            json!({"t": "ephemeral", "group": "g1", "payload": payload, "notify": ["bob", "carol"]})
        )
        .await["t"],
        "ok"
    );
    let eph = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let m = recv(&mut b).await;
            if m["t"] == "eph" {
                return m;
            }
        }
    })
    .await
    .expect("ephemeral did not fan out to the live subscriber");
    assert_eq!(eph["sender"], "alice");
}
