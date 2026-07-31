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
    spawn_relay_configured(true, &[]).await
}

async fn spawn_relay_with(open_registration: bool) -> SocketAddr {
    spawn_relay_configured(open_registration, &[]).await
}

async fn spawn_relay_with_admins(admins: &[&str]) -> SocketAddr {
    spawn_relay_configured(true, admins).await
}

/// Like `spawn_relay`, but hands back the `App` too so a test can read the
/// metrics the request path actually incremented. Asserting on
/// `Metrics::render()` alone proves the formatter works, not that anything is
/// wired to it.
async fn spawn_relay_with_app() -> (SocketAddr, std::sync::Arc<App>) {
    let (addr, app) = spawn_relay_parts(true, &[]).await;
    (addr, app)
}

async fn spawn_relay_configured(open_registration: bool, admins: &[&str]) -> SocketAddr {
    spawn_relay_parts(open_registration, admins).await.0
}

async fn spawn_relay_parts(
    open_registration: bool,
    admins: &[&str],
) -> (SocketAddr, std::sync::Arc<App>) {
    let blobs = relay::blobs::BlobStore::new(
        tempfile::tempdir().map(|d| d.keep()).unwrap(),
    )
    .unwrap();
    let app = App::with_parts_and_admins(
        Box::new(MemoryStore::default()),
        blobs,
        relay::push::PushService::from_env(),
        open_registration,
        admins.iter().map(|s| s.to_string()).collect(),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let served = app.clone();
    tokio::spawn(async move {
        axum::serve(listener, relay::router(served)).await.unwrap();
    });
    (addr, app)
}

struct TestClient {
    ws: WebSocketStream<MaybeTlsStream<TcpStream>>,
    buffered: VecDeque<Value>,
    mls: ChatClient,
    name: String,
    next_rid: u64,
    global_admin: bool,
}

impl TestClient {
    /// Connect and authenticate; the MLS identity key answers the challenge.
    async fn connect(addr: SocketAddr, mls: ChatClient, name: &str) -> Result<Self, String> {
        Self::connect_with_invite(addr, mls, name, None).await
    }

    /// Like `connect`, but the hello carries an invite id — required for
    /// first-time registration on an invite-only relay.
    async fn connect_with_invite(
        addr: SocketAddr,
        mls: ChatClient,
        name: &str,
        invite: Option<&str>,
    ) -> Result<Self, String> {
        let (ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/ws"))
            .await
            .map_err(|e| e.to_string())?;
        let mut client = Self {
            ws,
            buffered: VecDeque::new(),
            mls,
            name: name.to_string(),
            next_rid: 1,
            global_admin: false,
        };
        client
            .send_raw(json!({
                "t": "hello",
                "user": name,
                "pubkey": B64.encode(client.mls.signature_public_key()),
                "invite": invite,
            }))
            .await;
        let challenge = client.recv().await;
        assert_eq!(challenge["t"], "challenge");
        let nonce = B64.decode(challenge["nonce"].as_str().unwrap()).unwrap();
        let mut signed = b"relay-auth-v2".to_vec();
        signed.extend_from_slice(&nonce);
        signed.extend_from_slice(&(name.len() as u32).to_be_bytes());
        signed.extend_from_slice(name.as_bytes());
        let sig = client.mls.sign(&signed).unwrap();
        client.send_raw(json!({"t": "auth", "sig": B64.encode(sig)})).await;
        let reply = client.recv().await;
        if reply["t"] == "ready" {
            client.global_admin = reply["global_admin"] == json!(true);
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
        let blob = self.mls.send_message(group, text).unwrap();
        let epoch = self.mls.epoch(group).unwrap();
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
    alice.mls.create_group("g1").unwrap();
    let reply = alice.request(json!({"t": "create_group", "group": "g1"})).await;
    assert_eq!(reply["t"], "ok");

    let kp = alice.request(json!({"t": "fetch_kp", "user": "bob"})).await;
    let kp_bytes = B64.decode(kp["payload"].as_str().unwrap()).unwrap();
    // The relay serves the pinned identity key alongside the KeyPackage;
    // the adder binds one to the other.
    let kp_pubkey = B64.decode(kp["pubkey"].as_str().unwrap()).unwrap();
    let add = alice.mls.add_member("g1", &kp_bytes, "bob", &kp_pubkey).unwrap();
    alice.mls.merge_staged_commit("g1").unwrap();

    // Commit goes on the log first so the Welcome can point past it.
    let epoch = alice.mls.epoch("g1").unwrap();
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
    assert_eq!(bob.mls.members("g1").unwrap(), vec!["alice", "bob"]);

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
    alice.mls.create_group("g1").unwrap();
    alice.request(json!({"t": "create_group", "group": "g1"})).await;
    let kp = alice.request(json!({"t": "fetch_kp", "user": "bob"})).await;
    let kp_bytes = B64.decode(kp["payload"].as_str().unwrap()).unwrap();
    // The relay serves the pinned identity key alongside the KeyPackage;
    // the adder binds one to the other.
    let kp_pubkey = B64.decode(kp["pubkey"].as_str().unwrap()).unwrap();
    let add = alice.mls.add_member("g1", &kp_bytes, "bob", &kp_pubkey).unwrap();
    alice.mls.merge_staged_commit("g1").unwrap();
    let epoch = alice.mls.epoch("g1").unwrap();
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
    // Where the backlog ends. The client needs this to tell replayed history
    // — which cannot decrypt, because the group re-keyed past it — apart from
    // live traffic that fails to decrypt, which is what a fork looks like.
    // Without it, a device resuming from the start of the log convicts every
    // member of forking.
    let catch_up_to = reply["seq"].as_u64().expect("subscribe reports its backlog end");

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
    assert_eq!(
        catch_up_to,
        *seqs.last().unwrap(),
        "the boundary is the last backlogged seq, so nothing live is mistaken for a replay"
    );
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

#[tokio::test]
async fn invite_link_flow_external_commit_join() {
    let addr = spawn_relay().await;

    // alice sets up a group and parks an (opaque) invite blob on the relay.
    let mut alice =
        TestClient::connect(addr, ChatClient::new("alice").unwrap(), "alice").await.unwrap();
    alice.mls.create_group("g1").unwrap();
    alice.request(json!({"t": "create_group", "group": "g1"})).await;
    let group_info = alice.mls.export_group_info("g1").unwrap();
    let reply = alice
        .request(json!({
            "t": "create_invite", "invite": "inv-1", "group": "g1",
            "payload": B64.encode(&group_info), "expires_at": null, "max_uses": null,
        }))
        .await;
    assert_eq!(reply["t"], "ok");

    // charlie redeems: gets the blob, relay-level membership, and joins by
    // external commit with no existing member online.
    let mut charlie =
        TestClient::connect(addr, ChatClient::new("charlie").unwrap(), "charlie").await.unwrap();
    let reply = charlie.request(json!({"t": "redeem_invite", "invite": "inv-1"})).await;
    assert_eq!(reply["t"], "invite");
    assert_eq!(reply["group"], "g1");
    let blob = B64.decode(reply["payload"].as_str().unwrap()).unwrap();
    let (group, commit) = charlie.mls.join_by_external_commit(&blob).unwrap();
    assert_eq!(group, "g1");
    let epoch = charlie.mls.epoch("g1").unwrap();
    let reply = charlie
        .request(json!({"t": "send", "group": "g1", "epoch": epoch, "payload": B64.encode(&commit)}))
        .await;
    let commit_seq = reply["seq"].as_u64().unwrap();
    charlie.request(json!({"t": "subscribe", "group": "g1", "after": commit_seq})).await;

    // alice (subscribed via create_group) sees the external commit as a
    // membership change signed by the joiner.
    match alice.recv_group_event().await {
        Event::MembershipChange { sender, members, .. } => {
            assert_eq!(sender, "charlie");
            assert_eq!(members, vec!["alice", "charlie"]);
        }
        other => panic!("expected membership change, got {other:?}"),
    }

    // Chat flows both ways.
    alice.send_group("g1", "hello stranger").await;
    TestClient::assert_message(charlie.recv_group_event().await, "alice", "hello stranger");
    charlie.send_group("g1", "hi, followed the link").await;
    TestClient::assert_message(alice.recv_group_event().await, "charlie", "hi, followed the link");
}

#[tokio::test]
async fn invite_weak_controls_enforced_server_side() {
    let addr = spawn_relay().await;
    let mut alice =
        TestClient::connect(addr, ChatClient::new("alice").unwrap(), "alice").await.unwrap();
    alice.mls.create_group("g1").unwrap();
    alice.request(json!({"t": "create_group", "group": "g1"})).await;
    let blob = B64.encode(alice.mls.export_group_info("g1").unwrap());

    // Expired invite refuses to redeem.
    alice
        .request(json!({
            "t": "create_invite", "invite": "expired", "group": "g1",
            "payload": blob, "expires_at": 1, "max_uses": null,
        }))
        .await;
    // max_uses=1 invite works once, then refuses.
    alice
        .request(json!({
            "t": "create_invite", "invite": "once", "group": "g1",
            "payload": blob, "expires_at": null, "max_uses": 1,
        }))
        .await;
    // Revoked invite disappears.
    alice
        .request(json!({
            "t": "create_invite", "invite": "revoked", "group": "g1",
            "payload": blob, "expires_at": null, "max_uses": null,
        }))
        .await;
    let reply = alice.request(json!({"t": "revoke_invite", "invite": "revoked"})).await;
    assert_eq!(reply["t"], "ok");

    let mut dave = TestClient::connect(addr, ChatClient::new("dave").unwrap(), "dave").await.unwrap();
    let reply = dave.request(json!({"t": "redeem_invite", "invite": "expired"})).await;
    assert_eq!(reply["t"], "error");
    let reply = dave.request(json!({"t": "redeem_invite", "invite": "revoked"})).await;
    assert_eq!(reply["t"], "error");
    let reply = dave.request(json!({"t": "redeem_invite", "invite": "once"})).await;
    assert_eq!(reply["t"], "invite");
    let mut erin = TestClient::connect(addr, ChatClient::new("erin").unwrap(), "erin").await.unwrap();
    let reply = erin.request(json!({"t": "redeem_invite", "invite": "once"})).await;
    assert_eq!(reply["t"], "error", "second use of max_uses=1 must fail");

    // Non-members cannot create or update invites.
    let reply = erin
        .request(json!({
            "t": "create_invite", "invite": "evil", "group": "g1",
            "payload": "AA==", "expires_at": null, "max_uses": null,
        }))
        .await;
    assert_eq!(reply["t"], "error");
    let reply = erin.request(json!({"t": "update_invite", "invite": "once", "payload": "AA=="})).await;
    assert_eq!(reply["t"], "error");
}

#[tokio::test]
async fn ephemeral_messages_fan_out_but_never_touch_the_log() {
    let addr = spawn_relay().await;

    let mut bob = TestClient::connect(addr, ChatClient::new("bob").unwrap(), "bob").await.unwrap();
    bob.publish_kps(1).await;
    let mut alice =
        TestClient::connect(addr, ChatClient::new("alice").unwrap(), "alice").await.unwrap();
    alice.mls.create_group("g1").unwrap();
    alice.request(json!({"t": "create_group", "group": "g1"})).await;
    let kp = alice.request(json!({"t": "fetch_kp", "user": "bob"})).await;
    let kp_bytes = B64.decode(kp["payload"].as_str().unwrap()).unwrap();
    // The relay serves the pinned identity key alongside the KeyPackage;
    // the adder binds one to the other.
    let kp_pubkey = B64.decode(kp["pubkey"].as_str().unwrap()).unwrap();
    let add = alice.mls.add_member("g1", &kp_bytes, "bob", &kp_pubkey).unwrap();
    alice.mls.merge_staged_commit("g1").unwrap();
    let epoch = alice.mls.epoch("g1").unwrap();
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
    let welcome = bob.recv_until(|m| m["t"] == "welcome").await;
    let payload = B64.decode(welcome["payload"].as_str().unwrap()).unwrap();
    bob.mls.join_from_welcome(&payload).unwrap();
    bob.request(json!({"t": "subscribe", "group": "g1", "after": commit_seq})).await;

    // MLS-encrypted signaling flows via ephemeral fan-out…
    let blob = alice.mls.send_message("g1", r#"{"k":"voice","ch":"lounge","action":"join"}"#).unwrap();
    let reply = alice
        .request(json!({"t": "ephemeral", "group": "g1", "payload": B64.encode(&blob)}))
        .await;
    assert_eq!(reply["t"], "ok");
    let eph = bob.recv_until(|m| m["t"] == "eph").await;
    assert_eq!(eph["sender"], "alice");
    let bytes = B64.decode(eph["payload"].as_str().unwrap()).unwrap();
    match bob.mls.process_incoming(&bytes).unwrap() {
        Event::Message { text, .. } => assert!(text.contains("\"voice\"")),
        other => panic!("expected message, got {other:?}"),
    }

    // …and the ordered log is untouched: reconnecting from the commit seq
    // yields nothing (signaling must never replay).
    let bob_mls = bob.mls;
    drop(bob.ws);
    let mut bob = TestClient::connect(addr, bob_mls, "bob").await.unwrap();
    bob.request(json!({"t": "subscribe", "group": "g1", "after": commit_seq})).await;
    // A real logged message still arrives — proving the subscription works
    // and only the ephemeral was skipped.
    alice.send_group("g1", "logged").await;
    let msg = bob.recv_until(|m| m["t"] == "msg").await;
    assert_eq!(msg["seq"].as_u64().unwrap(), commit_seq + 1, "no seqs were consumed by ephemerals");

    // Non-members can't inject signaling.
    let mut eve = TestClient::connect(addr, ChatClient::new("eve").unwrap(), "eve").await.unwrap();
    let reply = eve.request(json!({"t": "ephemeral", "group": "g1", "payload": "AA=="})).await;
    assert_eq!(reply["t"], "error");
}

#[tokio::test]
async fn invite_only_registration_gate() {
    let addr = spawn_relay_with(false).await;

    // Bootstrap: the very first user registers with no invite at all.
    let mut alice = TestClient::connect(addr, ChatClient::new("alice").unwrap(), "alice")
        .await
        .expect("first user must bootstrap without an invite");

    // A second fresh handle without an invite is refused.
    let err = match TestClient::connect(addr, ChatClient::new("bob").unwrap(), "bob").await {
        Ok(_) => panic!("unknown handle without invite must be refused"),
        Err(e) => e,
    };
    assert!(err.contains("invite-only"), "unexpected error: {err}");

    // A garbage invite id doesn't help.
    assert!(
        TestClient::connect_with_invite(addr, ChatClient::new("bob").unwrap(), "bob", Some("nope"))
            .await
            .is_err(),
        "nonexistent invite must not admit anyone"
    );

    // alice parks a real invite; presenting its id in the hello admits bob.
    alice.mls.create_group("g1").unwrap();
    alice.request(json!({"t": "create_group", "group": "g1"})).await;
    let blob = B64.encode(alice.mls.export_group_info("g1").unwrap());
    let reply = alice
        .request(json!({
            "t": "create_invite", "invite": "inv-reg", "group": "g1",
            "payload": blob, "expires_at": null, "max_uses": null,
        }))
        .await;
    assert_eq!(reply["t"], "ok");

    let bob =
        TestClient::connect_with_invite(addr, ChatClient::new("bob").unwrap(), "bob", Some("inv-reg"))
            .await
            .expect("a usable invite id must admit a new user");

    // Once pinned, bob reconnects without any invite (the gate only guards
    // first-time registration).
    let bob_mls = bob.mls;
    drop(bob.ws);
    TestClient::connect(addr, bob_mls, "bob")
        .await
        .expect("registered users must reconnect without an invite");

    // Expired invites don't admit anyone — the gate applies redeemability.
    alice
        .request(json!({
            "t": "create_invite", "invite": "inv-old", "group": "g1",
            "payload": "AA==", "expires_at": 1, "max_uses": null,
        }))
        .await;
    assert!(
        TestClient::connect_with_invite(addr, ChatClient::new("carol").unwrap(), "carol", Some("inv-old"))
            .await
            .is_err(),
        "expired invite must not admit anyone"
    );
}

#[tokio::test]
async fn group_admins_gate_membership_invites_and_roles() {
    let addr = spawn_relay().await;

    // alice creates the group and is its first admin.
    let mut alice =
        TestClient::connect(addr, ChatClient::new("alice").unwrap(), "alice").await.unwrap();
    alice.request(json!({"t": "create_group", "group": "g1"})).await;
    let reply = alice.request(json!({"t": "allow", "group": "g1", "user": "bob"})).await;
    assert_eq!(reply["t"], "ok", "creator can allow members");

    // bob is a plain member: no allow, no invites, no role changes.
    let mut bob = TestClient::connect(addr, ChatClient::new("bob").unwrap(), "bob").await.unwrap();
    let reply = bob.request(json!({"t": "allow", "group": "g1", "user": "carol"})).await;
    assert_eq!(reply["t"], "error", "plain members must not extend the ACL");
    let reply = bob
        .request(json!({
            "t": "create_invite", "invite": "inv-x", "group": "g1",
            "payload": "AA==", "expires_at": null, "max_uses": null,
        }))
        .await;
    assert_eq!(reply["t"], "error", "plain members must not create invites");
    let reply = bob
        .request(json!({"t": "set_role", "group": "g1", "user": "bob", "role": "admin"}))
        .await;
    assert_eq!(reply["t"], "error", "plain members must not self-promote");

    // The roster (with roles) is visible to any member.
    let reply = bob.request(json!({"t": "members", "group": "g1"})).await;
    assert_eq!(reply["t"], "members");
    assert_eq!(
        reply["members"],
        json!([
            {"user": "alice", "role": "admin"},
            {"user": "bob", "role": "member"},
        ])
    );

    // Promotion unlocks the management surface.
    let reply = alice
        .request(json!({"t": "set_role", "group": "g1", "user": "bob", "role": "admin"}))
        .await;
    assert_eq!(reply["t"], "ok");
    let reply = bob.request(json!({"t": "allow", "group": "g1", "user": "carol"})).await;
    assert_eq!(reply["t"], "ok", "promoted admin can allow members");

    // Bad role values are rejected.
    let reply = alice
        .request(json!({"t": "set_role", "group": "g1", "user": "bob", "role": "owner"}))
        .await;
    assert_eq!(reply["t"], "error");

    // Demotion works, and the last admin cannot be demoted.
    let reply = alice
        .request(json!({"t": "set_role", "group": "g1", "user": "bob", "role": "member"}))
        .await;
    assert_eq!(reply["t"], "ok");
    let reply = alice
        .request(json!({"t": "set_role", "group": "g1", "user": "alice", "role": "member"}))
        .await;
    assert_eq!(reply["t"], "error", "a group must keep at least one admin");
}

#[tokio::test]
async fn global_admin_manages_any_group_and_lists_everything() {
    let addr = spawn_relay_with_admins(&["root"]).await;

    let root = TestClient::connect(addr, ChatClient::new("root").unwrap(), "root").await.unwrap();
    assert!(root.global_admin, "ready must carry the global_admin flag");
    let mut root = root;

    let mut alice =
        TestClient::connect(addr, ChatClient::new("alice").unwrap(), "alice").await.unwrap();
    assert!(!alice.global_admin);
    alice.request(json!({"t": "create_group", "group": "g1"})).await;

    // root is not a member of g1 but can inspect and manage its ACL.
    let reply = root.request(json!({"t": "members", "group": "g1"})).await;
    assert_eq!(reply["t"], "members");
    let reply = root.request(json!({"t": "allow", "group": "g1", "user": "bob"})).await;
    assert_eq!(reply["t"], "ok");
    let reply = root
        .request(json!({"t": "set_role", "group": "g1", "user": "bob", "role": "admin"}))
        .await;
    assert_eq!(reply["t"], "ok");

    // The overview lists every registered user and every group.
    let reply = root.request(json!({"t": "admin_list"})).await;
    assert_eq!(reply["t"], "admin_list");
    assert_eq!(reply["users"], json!(["alice", "root"]));
    assert_eq!(reply["groups"], json!([{"group": "g1", "created_by": "alice"}]));

    // …and it is global-admin only.
    let reply = alice.request(json!({"t": "admin_list"})).await;
    assert_eq!(reply["t"], "error");
    // Non-members (even non-admin members elsewhere) can't read rosters.
    let reply = alice.request(json!({"t": "members", "group": "does-not-exist"})).await;
    assert_eq!(reply["t"], "error");
}

#[tokio::test]
async fn history_log_gates_on_membership_and_prune_on_admin() {
    let addr = spawn_relay().await;
    let mut alice =
        TestClient::connect(addr, ChatClient::new("alice").unwrap(), "alice").await.unwrap();
    let mut bob = TestClient::connect(addr, ChatClient::new("bob").unwrap(), "bob").await.unwrap();
    let mut mallory =
        TestClient::connect(addr, ChatClient::new("mallory").unwrap(), "mallory").await.unwrap();

    alice.request(json!({"t": "create_group", "group": "g1"})).await;
    let reply = alice.request(json!({"t": "allow", "group": "g1", "user": "bob"})).await;
    assert_eq!(reply["t"], "ok");

    // Members append and fetch; the relay never interprets the payload.
    let reply = alice
        .request(json!({
            "t": "history_append", "group": "g1", "hid": "h-opaque",
            "ts": 100, "expires_at": null, "payload": B64.encode(b"ciphertext-1"),
        }))
        .await;
    assert_eq!(reply["t"], "ok", "member append: {reply}");
    assert_eq!(reply["seq"], 1);

    let reply = bob
        .request(json!({"t": "history_fetch", "group": "g1", "hid": "h-opaque", "after": 0}))
        .await;
    assert_eq!(reply["t"], "history");
    assert_eq!(reply["entries"].as_array().unwrap().len(), 1);
    assert_eq!(reply["entries"][0]["payload"], B64.encode(b"ciphertext-1"));

    // Non-members get nothing, in either direction.
    let reply = mallory
        .request(json!({
            "t": "history_append", "group": "g1", "hid": "h-opaque",
            "ts": 100, "expires_at": null, "payload": B64.encode(b"evil"),
        }))
        .await;
    assert_eq!(reply["t"], "error", "non-member append must fail");
    let reply = mallory
        .request(json!({"t": "history_fetch", "group": "g1", "hid": "h-opaque", "after": 0}))
        .await;
    assert_eq!(reply["t"], "error", "non-member fetch must fail");

    // Prune is the admin's (retention) lever — plain members are refused.
    let reply = bob
        .request(json!({"t": "history_prune", "group": "g1", "hid": "h-opaque", "before_ts": 200}))
        .await;
    assert_eq!(reply["t"], "error", "plain member prune must fail");
    let reply = alice
        .request(json!({"t": "history_prune", "group": "g1", "hid": "h-opaque", "before_ts": 200}))
        .await;
    assert_eq!(reply["t"], "ok");
    let reply = alice
        .request(json!({"t": "history_fetch", "group": "g1", "hid": "h-opaque", "after": 0}))
        .await;
    assert_eq!(reply["entries"].as_array().unwrap().len(), 0, "pruned");
}

/// The log is the conversation now, so three things have to hold over the
/// wire: a client can page it without pulling all of it, a member can
/// remove what they wrote (and only that), and a device can learn what it
/// missed without decrypting every channel.
#[tokio::test]
async fn history_pages_redacts_and_counts_over_the_wire() {
    let addr = spawn_relay().await;
    let mut alice =
        TestClient::connect(addr, ChatClient::new("alice").unwrap(), "alice").await.unwrap();
    let mut bob = TestClient::connect(addr, ChatClient::new("bob").unwrap(), "bob").await.unwrap();

    alice.request(json!({"t": "create_group", "group": "g1"})).await;
    alice.request(json!({"t": "allow", "group": "g1", "user": "bob"})).await;

    for i in 1..=4u64 {
        let who = if i % 2 == 0 { &mut bob } else { &mut alice };
        let reply = who
            .request(json!({
                "t": "history_append", "group": "g1", "hid": "h1",
                "ts": i * 10, "expires_at": null, "payload": B64.encode(format!("e{i}").as_bytes()),
            }))
            .await;
        assert_eq!(reply["seq"], i);
    }

    // Opening the room: the newest page, ascending, with "there is older".
    let reply = bob
        .request(json!({
            "t": "history_fetch", "group": "g1", "hid": "h1",
            "after": 0, "before": u64::MAX, "limit": 2,
        }))
        .await;
    let entries = reply["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0]["seq"], 3);
    assert_eq!(entries[1]["seq"], 4);
    assert_eq!(reply["complete"], false);

    // Paging back reaches the start and says so.
    let reply = bob
        .request(json!({
            "t": "history_fetch", "group": "g1", "hid": "h1",
            "after": 0, "before": 3, "limit": 50,
        }))
        .await;
    assert_eq!(reply["entries"].as_array().unwrap().len(), 2);
    assert_eq!(reply["complete"], true);

    // A limit past the cap is clamped rather than honored.
    let reply = bob
        .request(json!({
            "t": "history_fetch", "group": "g1", "hid": "h1",
            "after": 0, "limit": 100_000,
        }))
        .await;
    assert_eq!(reply["entries"].as_array().unwrap().len(), 4);

    // Unread without decrypting: the caller's own entries never count.
    let reply = bob
        .request(json!({
            "t": "history_counts", "group": "g1",
            "logs": [{"hid": "h1", "after_ts": 0}, {"hid": "ghost", "after_ts": 0}],
        }))
        .await;
    assert_eq!(reply["t"], "history_count");
    assert_eq!(reply["counts"][0]["n"], 2, "alice wrote two of the four");
    assert_eq!(reply["counts"][1]["n"], 0, "an unknown log is empty, not an error");

    // Redaction removes the ciphertext, so a later joiner cannot read it
    // with the room key — unlike the in-log tombstone, which only asks
    // readers to fold it away. Someone else's entry does not go.
    let reply = bob
        .request(json!({"t": "history_redact", "group": "g1", "hid": "h1", "seq": 1}))
        .await;
    assert_eq!(reply["t"], "ok", "answered the same as a successful redaction");
    let reply = bob
        .request(json!({"t": "history_redact", "group": "g1", "hid": "h1", "seq": 2}))
        .await;
    assert_eq!(reply["t"], "ok");
    let reply = alice
        .request(json!({"t": "history_fetch", "group": "g1", "hid": "h1", "after": 0}))
        .await;
    let left: Vec<u64> = reply["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["seq"].as_u64().unwrap())
        .collect();
    assert_eq!(left, vec![1, 3, 4], "bob's own entry went; alice's stayed");

    // An admin may redact anyone's.
    let reply = alice
        .request(json!({"t": "history_redact", "group": "g1", "hid": "h1", "seq": 3}))
        .await;
    assert_eq!(reply["t"], "ok");
    let reply = alice
        .request(json!({"t": "history_fetch", "group": "g1", "hid": "h1", "after": 0}))
        .await;
    assert_eq!(reply["entries"].as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn backup_blob_roundtrips_per_user() {
    let addr = spawn_relay().await;
    let mut alice =
        TestClient::connect(addr, ChatClient::new("alice").unwrap(), "alice").await.unwrap();
    let mut bob = TestClient::connect(addr, ChatClient::new("bob").unwrap(), "bob").await.unwrap();

    // Empty until set; then each user sees only their own blob.
    let reply = alice.request(json!({"t": "backup_get"})).await;
    assert_eq!(reply["t"], "backup");
    assert!(reply.get("payload").is_none() || reply["payload"].is_null());

    assert_eq!(reply["version"], 0, "nothing parked reads as version 0");

    let reply = alice
        .request(json!({"t": "backup_set", "payload": B64.encode(b"alice-circles")}))
        .await;
    assert_eq!(reply["t"], "backup_ok");
    assert_eq!(reply["version"], 1);
    let reply = alice.request(json!({"t": "backup_get"})).await;
    assert_eq!(reply["payload"], B64.encode(b"alice-circles"));
    assert_eq!(reply["version"], 1);
    let reply = bob.request(json!({"t": "backup_get"})).await;
    assert!(reply.get("payload").is_none() || reply["payload"].is_null(), "backups are per-user");

    // A second device of alice's, still holding version 0, must not be able
    // to overwrite what the first one parked.
    let reply = alice
        .request(json!({"t": "backup_set", "payload": B64.encode(b"clobber"), "version": 0}))
        .await;
    assert_eq!(reply["t"], "error", "a stale write is refused");
    let reply = alice.request(json!({"t": "backup_get"})).await;
    assert_eq!(reply["payload"], B64.encode(b"alice-circles"), "and changed nothing");

    // Re-read, then write against what is actually there.
    let reply = alice
        .request(json!({"t": "backup_set", "payload": B64.encode(b"merged"), "version": 1}))
        .await;
    assert_eq!(reply["t"], "backup_ok");
    assert_eq!(reply["version"], 2);
}

/// The metrics unit tests cover `render()` — that the formatter emits valid
/// exposition. They cannot catch instrumentation attached to the wrong branch,
/// which is the actual risk: a counter that never moves reads as "healthy" and
/// the alert rules in `deploy/alerts.yml` are built on these exact names.
/// So this drives the real request path and asserts the real counters moved.
#[tokio::test]
async fn the_request_path_actually_moves_the_counters() {
    let (addr, app) = spawn_relay_with_app().await;
    let m = &app.metrics;

    assert_eq!(m.ws_connections.get(), 0);
    assert_eq!(m.messages_appended.get(), 0);
    assert_eq!(m.registrations.get(), 0);

    let mut alice =
        TestClient::connect(addr, ChatClient::new("alice").unwrap(), "alice").await.unwrap();
    assert_eq!(m.ws_connections.get(), 1, "a completed handshake counts a connection");
    assert_eq!(m.registrations.get(), 1, "a first-time handle counts a registration");

    alice.mls.create_group("g1").unwrap();
    alice.request(json!({"t": "create_group", "group": "g1"})).await;
    alice.send_group("g1", "one").await;
    alice.send_group("g1", "two").await;
    assert_eq!(m.messages_appended.get(), 2, "each accepted append is counted once");

    // Latency is observed on the success path only — a rejected send must not
    // land in the histogram, or the p95 alert reports on failures.
    let rendered = m.render(relay::metrics::Snapshot::default());
    assert!(
        rendered.contains("quorum_append_duration_seconds_count 2"),
        "one latency sample per accepted append:\n{rendered}"
    );

    // A reconnect with the same identity is a connection but NOT a new
    // registration — the handle is already pinned.
    let _alice2 =
        TestClient::connect(addr, ChatClient::new("alice2").unwrap(), "alice2").await.unwrap();
    assert_eq!(m.ws_connections.get(), 2);
    assert_eq!(m.registrations.get(), 2);
}

/// Sending to a group you are not in must be counted as a rejection, not
/// silently dropped — `not_a_member` is the label an operator watches when
/// someone reports "my messages vanish".
#[tokio::test]
async fn a_refused_send_is_counted_and_never_reaches_the_histogram() {
    let (addr, app) = spawn_relay_with_app().await;
    let m = &app.metrics;

    let mut alice =
        TestClient::connect(addr, ChatClient::new("alice").unwrap(), "alice").await.unwrap();
    alice.mls.create_group("g1").unwrap();
    alice.request(json!({"t": "create_group", "group": "g1"})).await;

    let mut mallory =
        TestClient::connect(addr, ChatClient::new("mallory").unwrap(), "mallory").await.unwrap();
    let reply = mallory
        .request(json!({"t": "send", "group": "g1", "epoch": 0, "payload": B64.encode("nope")}))
        .await;
    assert_eq!(reply["t"], "error", "a non-member send must be refused");

    assert_eq!(m.send_rejections.not_a_member.get(), 1);
    assert_eq!(m.messages_appended.get(), 0, "nothing was appended");
    let rendered = m.render(relay::metrics::Snapshot::default());
    assert!(
        rendered.contains("quorum_append_duration_seconds_count 0"),
        "a refused send must not be timed:\n{rendered}"
    );
}

/// The outbound queue's depth is decremented by the writer task as each
/// message leaves. The unit test in `server.rs` mirrors that by hand, which
/// proves the mirror — not the writer. If the real writer stopped
/// decrementing, every connection would strand at MAX_QUEUE and this is the
/// only test that would notice.
#[tokio::test]
async fn a_connection_keeps_receiving_past_the_queue_bound() {
    let (addr, app) = spawn_relay_with_app().await;

    let mut bob = TestClient::connect(addr, ChatClient::new("bob").unwrap(), "bob").await.unwrap();
    bob.publish_kps(1).await;
    let mut alice =
        TestClient::connect(addr, ChatClient::new("alice").unwrap(), "alice").await.unwrap();
    alice.mls.create_group("g1").unwrap();
    alice.request(json!({"t": "create_group", "group": "g1"})).await;
    let kp = alice.request(json!({"t": "fetch_kp", "user": "bob"})).await;
    let kp_bytes = B64.decode(kp["payload"].as_str().unwrap()).unwrap();
    let kp_pubkey = B64.decode(kp["pubkey"].as_str().unwrap()).unwrap();
    let add = alice.mls.add_member("g1", &kp_bytes, "bob", &kp_pubkey).unwrap();
    alice.mls.merge_staged_commit("g1").unwrap();
    let epoch = alice.mls.epoch("g1").unwrap();
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
    let welcome = bob.recv_until(|m| m["t"] == "welcome").await;
    let payload = B64.decode(welcome["payload"].as_str().unwrap()).unwrap();
    bob.mls.join_from_welcome(&payload).unwrap();
    let after = welcome["after"].as_u64().unwrap();
    bob.request(json!({"t": "subscribe", "group": "g1", "after": after})).await;

    // Comfortably more than MAX_QUEUE, drained as they arrive.
    let total = relay::server::MAX_QUEUE + 50;
    for i in 0..total {
        alice.send_group("g1", &format!("m{i}")).await;
        let msg = bob.recv_until(|m| m["t"] == "msg").await;
        let payload = B64.decode(msg["payload"].as_str().unwrap()).unwrap();
        bob.mls.process_incoming(&payload).unwrap();
    }

    assert_eq!(
        app.metrics.subscribers_dropped.get(),
        0,
        "a subscriber that keeps up must never be cut — if this fires, the writer \
         stopped decrementing the queue depth"
    );
    assert_eq!(app.metrics.messages_appended.get() as usize, total + 1, "commit + {total} messages");
}

/// Two admins committing against the same epoch is the exact race that used to
/// fork a group irrecoverably — both sides advancing to a different epoch N+1,
/// after which neither can read the other. §1.1 made commits stage until the
/// relay's compare-and-swap accepts them; `memory_store.rs` covers the CAS
/// itself, but nothing covered what a *real MLS client* does when it loses.
///
/// The recovery loop is the part that matters: the loser must discard its
/// staged commit, process the winner's, and be able to commit again. Without
/// that last step the fork is merely deferred.
#[tokio::test]
async fn a_losing_commit_is_refused_and_the_loser_recovers() {
    let addr = spawn_relay().await;

    let mut carol =
        TestClient::connect(addr, ChatClient::new("carol").unwrap(), "carol").await.unwrap();
    carol.publish_kps(2).await;
    let mut dave =
        TestClient::connect(addr, ChatClient::new("dave").unwrap(), "dave").await.unwrap();
    dave.publish_kps(2).await;

    // alice creates the circle and brings bob in, so both can commit.
    let mut alice =
        TestClient::connect(addr, ChatClient::new("alice").unwrap(), "alice").await.unwrap();
    alice.mls.create_group("g1").unwrap();
    alice.request(json!({"t": "create_group", "group": "g1"})).await;
    let mut bob = TestClient::connect(addr, ChatClient::new("bob").unwrap(), "bob").await.unwrap();
    bob.publish_kps(1).await;

    let kp = alice.request(json!({"t": "fetch_kp", "user": "bob"})).await;
    let add_bob = alice
        .mls
        .add_member(
            "g1",
            &B64.decode(kp["payload"].as_str().unwrap()).unwrap(),
            "bob",
            &B64.decode(kp["pubkey"].as_str().unwrap()).unwrap(),
        )
        .unwrap();
    alice.mls.merge_staged_commit("g1").unwrap();
    let reply = alice
        .request(json!({
            "t": "send", "group": "g1", "epoch": alice.mls.epoch("g1").unwrap(),
            "payload": B64.encode(&add_bob.commit), "commit": true,
        }))
        .await;
    assert_eq!(reply["t"], "ok", "the establishing commit: {reply}");
    let commit_seq = reply["seq"].as_u64().unwrap();
    alice.request(json!({"t": "allow", "group": "g1", "user": "bob"})).await;
    alice
        .request(json!({
            "t": "welcome", "to": "bob", "group": "g1",
            "after": commit_seq, "payload": B64.encode(&add_bob.welcome),
        }))
        .await;
    let welcome = bob.recv_until(|m| m["t"] == "welcome").await;
    bob.mls
        .join_from_welcome(&B64.decode(welcome["payload"].as_str().unwrap()).unwrap())
        .unwrap();

    let shared_epoch = alice.mls.epoch("g1").unwrap();
    assert_eq!(bob.mls.epoch("g1").unwrap(), shared_epoch, "both start level");

    // --- the race -----------------------------------------------------------
    // Both stage a commit against the same epoch, neither merged yet. This is
    // the state §1.1 introduced: staged, not applied, until the log says so.
    let kp_c = alice.request(json!({"t": "fetch_kp", "user": "carol"})).await;
    let alice_add = alice
        .mls
        .add_member(
            "g1",
            &B64.decode(kp_c["payload"].as_str().unwrap()).unwrap(),
            "carol",
            &B64.decode(kp_c["pubkey"].as_str().unwrap()).unwrap(),
        )
        .unwrap();
    let kp_d = bob.request(json!({"t": "fetch_kp", "user": "dave"})).await;
    let bob_add = bob
        .mls
        .add_member(
            "g1",
            &B64.decode(kp_d["payload"].as_str().unwrap()).unwrap(),
            "dave",
            &B64.decode(kp_d["pubkey"].as_str().unwrap()).unwrap(),
        )
        .unwrap();

    let next = shared_epoch + 1;
    let winner = alice
        .request(json!({
            "t": "send", "group": "g1", "epoch": next,
            "payload": B64.encode(&alice_add.commit), "commit": true,
        }))
        .await;
    assert_eq!(winner["t"], "ok", "the first commit for an epoch wins: {winner}");
    alice.mls.merge_staged_commit("g1").unwrap();

    let loser = bob
        .request(json!({
            "t": "send", "group": "g1", "epoch": next,
            "payload": B64.encode(&bob_add.commit), "commit": true,
        }))
        .await;
    assert_eq!(loser["t"], "error", "the second commit for the same epoch must be refused");
    assert!(
        loser["message"].as_str().unwrap_or_default().contains("epoch"),
        "the refusal must say why, so the client knows to retry rather than give up: {loser}"
    );

    // --- recovery -----------------------------------------------------------
    // Discard the commit that lost, apply the one that won, and try again.
    bob.mls.discard_staged_commit("g1").unwrap();
    bob.request(json!({"t": "subscribe", "group": "g1", "after": commit_seq})).await;
    let msg = bob.recv_until(|m| m["t"] == "msg").await;
    bob.mls
        .process_incoming(&B64.decode(msg["payload"].as_str().unwrap()).unwrap())
        .unwrap();

    assert_eq!(
        bob.mls.epoch("g1").unwrap(),
        alice.mls.epoch("g1").unwrap(),
        "after processing the winner both sides are on the same epoch — no fork"
    );
    let mut both = bob.mls.members("g1").unwrap();
    both.sort();
    assert_eq!(both, vec!["alice", "bob", "carol"], "the loser adopted the winner's membership");

    // And the retry now succeeds against the epoch that actually exists.
    let kp_d2 = bob.request(json!({"t": "fetch_kp", "user": "dave"})).await;
    let retry = bob
        .mls
        .add_member(
            "g1",
            &B64.decode(kp_d2["payload"].as_str().unwrap()).unwrap(),
            "dave",
            &B64.decode(kp_d2["pubkey"].as_str().unwrap()).unwrap(),
        )
        .unwrap();
    let accepted = bob
        .request(json!({
            "t": "send", "group": "g1", "epoch": bob.mls.epoch("g1").unwrap() + 1,
            "payload": B64.encode(&retry.commit), "commit": true,
        }))
        .await;
    assert_eq!(accepted["t"], "ok", "the retry lands: {accepted}");
}

/// A commit that skips an epoch must be refused for the same reason a
/// duplicate one is: applying it would leave every other member unable to
/// derive the keys for the epochs in between.
#[tokio::test]
async fn a_commit_that_skips_an_epoch_is_refused() {
    let addr = spawn_relay().await;
    let mut alice =
        TestClient::connect(addr, ChatClient::new("alice").unwrap(), "alice").await.unwrap();
    alice.mls.create_group("g1").unwrap();
    alice.request(json!({"t": "create_group", "group": "g1"})).await;

    let reply = alice
        .request(json!({
            "t": "send", "group": "g1", "epoch": 99,
            "payload": B64.encode("not-a-real-commit"), "commit": true,
        }))
        .await;
    assert_eq!(reply["t"], "error", "a commit from the future is refused: {reply}");

    // An ordinary message is NOT epoch-checked, so the same epoch number on a
    // non-commit send still goes through — the gate is on commits alone.
    let ordinary = alice
        .request(json!({
            "t": "send", "group": "g1", "epoch": 99, "payload": B64.encode("chatter"),
        }))
        .await;
    assert_eq!(ordinary["t"], "ok", "non-commits are not epoch-gated: {ordinary}");
}

/// Reconnect resync losslessness. `reconnect_race.rs` proves a subscription
/// survives an overlapping socket teardown; it does not prove that a client
/// which was *gone* for a while gets back everything it missed. That is the
/// property the whole ordered-log design exists to provide, and the one a
/// user notices immediately when it breaks.
#[tokio::test]
async fn nothing_is_lost_across_a_disconnect() {
    let addr = spawn_relay().await;

    let mut bob = TestClient::connect(addr, ChatClient::new("bob").unwrap(), "bob").await.unwrap();
    bob.publish_kps(1).await;
    let mut alice =
        TestClient::connect(addr, ChatClient::new("alice").unwrap(), "alice").await.unwrap();
    alice.mls.create_group("g1").unwrap();
    alice.request(json!({"t": "create_group", "group": "g1"})).await;
    let kp = alice.request(json!({"t": "fetch_kp", "user": "bob"})).await;
    let add = alice
        .mls
        .add_member(
            "g1",
            &B64.decode(kp["payload"].as_str().unwrap()).unwrap(),
            "bob",
            &B64.decode(kp["pubkey"].as_str().unwrap()).unwrap(),
        )
        .unwrap();
    alice.mls.merge_staged_commit("g1").unwrap();
    let reply = alice
        .request(json!({
            "t": "send", "group": "g1", "epoch": alice.mls.epoch("g1").unwrap(),
            "payload": B64.encode(&add.commit), "commit": true,
        }))
        .await;
    let commit_seq = reply["seq"].as_u64().unwrap();
    alice.request(json!({"t": "allow", "group": "g1", "user": "bob"})).await;
    alice
        .request(json!({
            "t": "welcome", "to": "bob", "group": "g1",
            "after": commit_seq, "payload": B64.encode(&add.welcome),
        }))
        .await;
    let welcome = bob.recv_until(|m| m["t"] == "welcome").await;
    bob.mls
        .join_from_welcome(&B64.decode(welcome["payload"].as_str().unwrap()).unwrap())
        .unwrap();

    // Bob subscribes, reads two, then vanishes mid-conversation.
    bob.request(json!({"t": "subscribe", "group": "g1", "after": commit_seq})).await;
    for text in ["one", "two"] {
        alice.send_group("g1", text).await;
        let msg = bob.recv_until(|m| m["t"] == "msg").await;
        TestClient::assert_message(
            bob.mls.process_incoming(&B64.decode(msg["payload"].as_str().unwrap()).unwrap()).unwrap(),
            "alice",
            text,
        );
    }
    let mut cursor = 0;
    let bob_mls = bob.mls;
    drop(bob.ws);

    // Twenty messages arrive while he is away — comfortably more than a single
    // frame's worth, so a truncated catch-up would show up here.
    let missed: Vec<String> = (0..20).map(|i| format!("missed-{i}")).collect();
    for text in &missed {
        cursor = alice.send_group("g1", text).await;
    }

    // He comes back with the last seq he actually processed.
    let mut bob = TestClient::connect(addr, bob_mls, "bob").await.unwrap();
    bob.request(json!({"t": "subscribe", "group": "g1", "after": commit_seq + 2})).await;

    let mut seen = Vec::new();
    let mut seqs = Vec::new();
    for _ in 0..missed.len() {
        let msg = bob.recv_until(|m| m["t"] == "msg").await;
        seqs.push(msg["seq"].as_u64().unwrap());
        match bob
            .mls
            .process_incoming(&B64.decode(msg["payload"].as_str().unwrap()).unwrap())
            .unwrap()
        {
            Event::Message { text, .. } => seen.push(text),
            other => panic!("expected a message, got {other:?}"),
        }
    }

    assert_eq!(seen, missed, "every message sent while away arrives, in order");
    assert!(seqs.windows(2).all(|w| w[0] < w[1]), "and seqs ascend: {seqs:?}");
    assert_eq!(*seqs.last().unwrap(), cursor, "up to and including the newest");

    // Re-subscribing from the new cursor yields nothing: catch-up is not
    // replay-everything, or every reconnect would duplicate the whole log.
    bob.request(json!({"t": "subscribe", "group": "g1", "after": cursor})).await;
    alice.send_group("g1", "after").await;
    let msg = bob.recv_until(|m| m["t"] == "msg").await;
    assert_eq!(msg["seq"].as_u64().unwrap(), cursor + 1, "only the new one");
}
