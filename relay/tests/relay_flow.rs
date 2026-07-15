//! Integration tests: real WebSocket clients running real MLS (crypto-core
//! natively) against an in-process relay with the in-memory store.

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use crypto_core::{ChatClient, Event};
use futures_util::{SinkExt, StreamExt};
use relay::server::App;
use relay::store::MemoryStore;
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::net::SocketAddr;
use std::time::Duration;
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

async fn spawn_relay() -> SocketAddr {
    let app = App::new(Box::new(MemoryStore::default()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, relay::router(app)).await.unwrap();
    });
    addr
}

struct TestClient {
    ws: WebSocketStream<MaybeTlsStream<TcpStream>>,
    buffered: VecDeque<Value>,
    mls: ChatClient,
    name: String,
    next_rid: u64,
}

impl TestClient {
    /// Connect and authenticate; the MLS identity key answers the challenge.
    async fn connect(addr: SocketAddr, mls: ChatClient, name: &str) -> Result<Self, String> {
        let (ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/ws"))
            .await
            .map_err(|e| e.to_string())?;
        let mut client = Self {
            ws,
            buffered: VecDeque::new(),
            mls,
            name: name.to_string(),
            next_rid: 1,
        };
        client
            .send_raw(json!({
                "t": "hello",
                "user": name,
                "pubkey": B64.encode(client.mls.signature_public_key()),
            }))
            .await;
        let challenge = client.recv().await;
        assert_eq!(challenge["t"], "challenge");
        let nonce = B64.decode(challenge["nonce"].as_str().unwrap()).unwrap();
        let mut signed = b"relay-auth-v1".to_vec();
        signed.extend_from_slice(&nonce);
        let sig = client.mls.sign(&signed).unwrap();
        client.send_raw(json!({"t": "auth", "sig": B64.encode(sig)})).await;
        let reply = client.recv().await;
        if reply["t"] == "ready" {
            Ok(client)
        } else {
            Err(reply["message"].as_str().unwrap_or("?").to_string())
        }
    }

    async fn send_raw(&mut self, v: Value) {
        self.ws.send(Message::Text(v.to_string())).await.unwrap();
    }

    /// Next server message (buffered ones first).
    async fn recv(&mut self) -> Value {
        if let Some(v) = self.buffered.pop_front() {
            return v;
        }
        loop {
            let frame = tokio::time::timeout(Duration::from_secs(5), self.ws.next())
                .await
                .expect("timeout waiting for server message")
                .expect("connection closed")
                .expect("ws error");
            if let Message::Text(t) = frame {
                return serde_json::from_str(&t).unwrap();
            }
        }
    }

    /// Next message matching `pred`; non-matching ones stay buffered in order.
    async fn recv_until(&mut self, pred: impl Fn(&Value) -> bool) -> Value {
        let mut stash = VecDeque::new();
        // Check already-buffered messages first.
        while let Some(v) = self.buffered.pop_front() {
            if pred(&v) {
                stash.into_iter().for_each(|s| self.buffered.push_back(s));
                return v;
            }
            stash.push_back(v);
        }
        self.buffered = stash;
        loop {
            let v = {
                if let Some(v) = self.buffered.pop_front() {
                    v
                } else {
                    let frame = tokio::time::timeout(Duration::from_secs(5), self.ws.next())
                        .await
                        .expect("timeout waiting for matching message")
                        .expect("connection closed")
                        .expect("ws error");
                    match frame {
                        Message::Text(t) => serde_json::from_str(&t).unwrap(),
                        _ => continue,
                    }
                }
            };
            if pred(&v) {
                return v;
            }
            self.buffered.push_back(v);
        }
    }

    /// Fire a request and await its rid-matched reply.
    async fn request(&mut self, mut v: Value) -> Value {
        let rid = self.next_rid;
        self.next_rid += 1;
        v["rid"] = json!(rid);
        self.send_raw(v).await;
        self.recv_until(|m| m["rid"] == json!(rid)).await
    }

    async fn publish_kps(&mut self, count: usize) {
        let payloads: Vec<String> = (0..count)
            .map(|_| B64.encode(self.mls.key_package().unwrap()))
            .collect();
        let reply = self.request(json!({"t": "publish_kp", "payloads": payloads})).await;
        assert_eq!(reply["t"], "ok", "publish_kp failed: {reply}");
    }

    async fn send_group(&mut self, group: &str, text: &str) -> u64 {
        let blob = self.mls.send_message(text).unwrap();
        let epoch = self.mls.epoch().unwrap();
        let reply = self
            .request(json!({"t": "send", "group": group, "epoch": epoch, "payload": B64.encode(blob)}))
            .await;
        assert_eq!(reply["t"], "ok", "send failed: {reply}");
        reply["seq"].as_u64().unwrap()
    }

    /// Receive the next group message and run it through MLS.
    async fn recv_group_event(&mut self) -> Event {
        let msg = self.recv_until(|m| m["t"] == "msg").await;
        let payload = B64.decode(msg["payload"].as_str().unwrap()).unwrap();
        self.mls.process_incoming(&payload).unwrap()
    }

    fn assert_message(event: Event, sender: &str, text: &str) {
        match event {
            Event::Message { sender: s, text: t, .. } => {
                assert_eq!(s, sender);
                assert_eq!(t, text);
            }
            other => panic!("expected message, got {other:?}"),
        }
    }
}

#[tokio::test]
async fn auth_pins_key_on_first_use_and_rejects_impostors() {
    let addr = spawn_relay().await;

    // First connection registers alice's key.
    let alice = TestClient::connect(addr, ChatClient::new("alice").unwrap(), "alice")
        .await
        .expect("first connect should register");
    drop(alice);

    // Same name but a different (freshly generated) key: rejected.
    assert!(
        TestClient::connect(addr, ChatClient::new("alice").unwrap(), "alice").await.is_err(),
        "fresh ChatClient has a different key — must be rejected"
    );

    // Signature must actually verify: a garbage signature is rejected even
    // for a brand-new user.
    let (ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/ws")).await.unwrap();
    let mut ws = ws;
    let mallory = ChatClient::new("mallory").unwrap();
    ws.send(Message::Text(
        json!({"t": "hello", "user": "mallory", "pubkey": B64.encode(mallory.signature_public_key())})
            .to_string(),
    ))
    .await
    .unwrap();
    let _challenge = ws.next().await.unwrap().unwrap();
    ws.send(Message::Text(json!({"t": "auth", "sig": B64.encode([0u8; 64])}).to_string()))
        .await
        .unwrap();
    let reply: Value =
        serde_json::from_str(ws.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
    assert_eq!(reply["t"], "error");
}

#[tokio::test]
async fn reconnect_with_same_identity_works() {
    let addr = spawn_relay().await;
    let alice_mls = ChatClient::new("alice").unwrap();

    let client = TestClient::connect(addr, alice_mls, "alice").await.unwrap();
    let mls = client.mls; // keep the identity, drop the socket
    drop(client.ws);

    TestClient::connect(addr, mls, "alice")
        .await
        .expect("same key must reauthenticate");
}

#[tokio::test]
async fn key_packages_are_consumed_once() {
    let addr = spawn_relay().await;
    let mut bob = TestClient::connect(addr, ChatClient::new("bob").unwrap(), "bob").await.unwrap();
    bob.publish_kps(2).await;

    let mut alice =
        TestClient::connect(addr, ChatClient::new("alice").unwrap(), "alice").await.unwrap();
    let kp1 = alice.request(json!({"t": "fetch_kp", "user": "bob"})).await;
    let kp2 = alice.request(json!({"t": "fetch_kp", "user": "bob"})).await;
    let kp3 = alice.request(json!({"t": "fetch_kp", "user": "bob"})).await;
    assert!(kp1["payload"].is_string());
    assert!(kp2["payload"].is_string());
    assert_ne!(kp1["payload"], kp2["payload"], "each fetch must consume a distinct KeyPackage");
    assert!(kp3["payload"].is_null(), "exhausted store must return null");
}

#[tokio::test]
async fn full_flow_with_offline_welcome() {
    let addr = spawn_relay().await;

    // bob pre-publishes KeyPackages and goes offline.
    let mut bob = TestClient::connect(addr, ChatClient::new("bob").unwrap(), "bob").await.unwrap();
    bob.publish_kps(1).await;
    let bob_mls = bob.mls;
    drop(bob.ws);

    // alice assembles the group while bob is away.
    let mut alice =
        TestClient::connect(addr, ChatClient::new("alice").unwrap(), "alice").await.unwrap();
    alice.mls.create_group().unwrap();
    let reply = alice.request(json!({"t": "create_group", "group": "g1"})).await;
    assert_eq!(reply["t"], "ok");

    let kp = alice.request(json!({"t": "fetch_kp", "user": "bob"})).await;
    let kp_bytes = B64.decode(kp["payload"].as_str().unwrap()).unwrap();
    let add = alice.mls.add_member(&kp_bytes).unwrap();

    // Commit goes on the log first so the Welcome can point past it.
    let epoch = alice.mls.epoch().unwrap();
    let reply = alice
        .request(json!({"t": "send", "group": "g1", "epoch": epoch, "payload": B64.encode(&add.commit)}))
        .await;
    let commit_seq = reply["seq"].as_u64().unwrap();
    assert_eq!(commit_seq, 1);

    let reply = alice.request(json!({"t": "allow", "group": "g1", "user": "bob"})).await;
    assert_eq!(reply["t"], "ok");
    let reply = alice
        .request(json!({
            "t": "welcome", "to": "bob", "group": "g1",
            "after": commit_seq, "payload": B64.encode(&add.welcome),
        }))
        .await;
    assert_eq!(reply["t"], "ok");

    // bob comes back online: the stored Welcome is waiting.
    let mut bob = TestClient::connect(addr, bob_mls, "bob").await.unwrap();
    let welcome = bob.recv_until(|m| m["t"] == "welcome").await;
    assert_eq!(welcome["from"], "alice");
    assert_eq!(welcome["group"], "g1");
    let payload = B64.decode(welcome["payload"].as_str().unwrap()).unwrap();
    bob.mls.join_from_welcome(&payload).unwrap();
    assert_eq!(bob.mls.members().unwrap(), vec!["alice", "bob"]);

    let after = welcome["after"].as_u64().unwrap();
    let reply = bob.request(json!({"t": "subscribe", "group": "g1", "after": after})).await;
    assert_eq!(reply["t"], "ok");

    // Both directions decrypt.
    alice.send_group("g1", "hello bob").await;
    TestClient::assert_message(bob.recv_group_event().await, "alice", "hello bob");
    bob.send_group("g1", "hi alice").await;
    TestClient::assert_message(alice.recv_group_event().await, "bob", "hi alice");
}

#[tokio::test]
async fn catch_up_replays_missed_messages_in_order() {
    let addr = spawn_relay().await;

    let mut bob = TestClient::connect(addr, ChatClient::new("bob").unwrap(), "bob").await.unwrap();
    bob.publish_kps(1).await;

    let mut alice =
        TestClient::connect(addr, ChatClient::new("alice").unwrap(), "alice").await.unwrap();
    alice.mls.create_group().unwrap();
    alice.request(json!({"t": "create_group", "group": "g1"})).await;
    let kp = alice.request(json!({"t": "fetch_kp", "user": "bob"})).await;
    let kp_bytes = B64.decode(kp["payload"].as_str().unwrap()).unwrap();
    let add = alice.mls.add_member(&kp_bytes).unwrap();
    let epoch = alice.mls.epoch().unwrap();
    let reply = alice
        .request(json!({"t": "send", "group": "g1", "epoch": epoch, "payload": B64.encode(&add.commit)}))
        .await;
    let commit_seq = reply["seq"].as_u64().unwrap();
    alice.request(json!({"t": "allow", "group": "g1", "user": "bob"})).await;
    alice
        .request(json!({
            "t": "welcome", "to": "bob", "group": "g1",
            "after": commit_seq, "payload": B64.encode(&add.welcome),
        }))
        .await;

    // bob joins crypto-wise, then drops before subscribing.
    let welcome = bob.recv_until(|m| m["t"] == "welcome").await;
    let payload = B64.decode(welcome["payload"].as_str().unwrap()).unwrap();
    bob.mls.join_from_welcome(&payload).unwrap();
    let after = welcome["after"].as_u64().unwrap();
    let bob_mls = bob.mls;
    drop(bob.ws);

    // Messages pile up while bob is gone.
    for text in ["one", "two", "three"] {
        alice.send_group("g1", text).await;
    }

    // Reconnect + subscribe with the last seen seq: backlog arrives in order.
    let mut bob = TestClient::connect(addr, bob_mls, "bob").await.unwrap();
    let reply = bob.request(json!({"t": "subscribe", "group": "g1", "after": after})).await;
    assert_eq!(reply["t"], "ok");

    let mut seqs = Vec::new();
    for expected in ["one", "two", "three"] {
        let msg = bob.recv_until(|m| m["t"] == "msg").await;
        seqs.push(msg["seq"].as_u64().unwrap());
        let payload = B64.decode(msg["payload"].as_str().unwrap()).unwrap();
        match bob.mls.process_incoming(&payload).unwrap() {
            Event::Message { sender, text, .. } => {
                assert_eq!(sender, "alice");
                assert_eq!(text, expected);
            }
            other => panic!("expected message, got {other:?}"),
        }
    }
    assert!(seqs.windows(2).all(|w| w[0] < w[1]), "seqs must ascend: {seqs:?}");
}

#[tokio::test]
async fn non_members_cannot_subscribe_or_send() {
    let addr = spawn_relay().await;

    let mut alice =
        TestClient::connect(addr, ChatClient::new("alice").unwrap(), "alice").await.unwrap();
    alice.request(json!({"t": "create_group", "group": "g1"})).await;

    let mut charlie =
        TestClient::connect(addr, ChatClient::new("charlie").unwrap(), "charlie").await.unwrap();
    let reply = charlie.request(json!({"t": "subscribe", "group": "g1", "after": 0})).await;
    assert_eq!(reply["t"], "error");
    let reply = charlie
        .request(json!({"t": "send", "group": "g1", "epoch": 0, "payload": B64.encode(b"x")}))
        .await;
    assert_eq!(reply["t"], "error");
    // And `allow` itself requires membership.
    let reply = charlie.request(json!({"t": "allow", "group": "g1", "user": "charlie"})).await;
    assert_eq!(reply["t"], "error");
}
