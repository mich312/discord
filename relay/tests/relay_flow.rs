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
    spawn_relay_with_admins(&[]).await
}

async fn spawn_relay_with_admins(admins: &[&str]) -> SocketAddr {
    let blobs = relay::blobs::BlobStore::new(
        tempfile::tempdir().map(|d| d.keep()).unwrap(),
    )
    .unwrap();
    let app = App::with_parts_and_admins(
        Box::new(MemoryStore::default()),
        blobs,
        relay::push::PushService::from_env(),
        admins.iter().map(|s| s.to_string()).collect(),
    );
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
    global_admin: bool,
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
            global_admin: false,
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
    let add = alice.mls.add_member("g1", &kp_bytes).unwrap();

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
    let add = alice.mls.add_member("g1", &kp_bytes).unwrap();
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
    let add = alice.mls.add_member("g1", &kp_bytes).unwrap();
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
