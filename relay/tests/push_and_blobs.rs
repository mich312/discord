//! Blob store semantics + the Web Push pipeline against a mock push
//! service: an offline member with a subscription gets an aes128gcm-
//! encrypted POST when traffic lands for them.

use base64::engine::general_purpose::{STANDARD as B64, URL_SAFE_NO_PAD};
use base64::Engine;
use crypto_core::ChatClient;
use futures_util::{SinkExt, StreamExt};
use p256::elliptic_curve::sec1::ToEncodedPoint;
use relay::blobs::BlobStore;
use relay::push::PushService;
use relay::server::App;
use relay::store::MemoryStore;
use serde_json::{json, Value};
use std::net::SocketAddr;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

#[tokio::test]
async fn blob_store_put_get_and_limits() {
    let dir = tempfile::tempdir().unwrap();
    let blobs = BlobStore::new(dir.path()).unwrap();

    blobs.put("abc-DEF_123", b"ciphertext").await.unwrap();
    assert_eq!(blobs.get("abc-DEF_123").await.unwrap(), Some(b"ciphertext".to_vec()));
    assert_eq!(blobs.get("missing").await.unwrap(), None);

    // Ids are strict tokens — no path tricks.
    assert!(blobs.put("../evil", b"x").await.is_err());
    assert!(blobs.put("a/b", b"x").await.is_err());
    assert!(blobs.get("..").await.is_err());
    // No overwriting an existing capability.
    assert!(blobs.put("abc-DEF_123", b"other").await.is_err());
    // Size cap.
    let big = vec![0u8; relay::blobs::MAX_BLOB_BYTES + 1];
    assert!(blobs.put("big", &big).await.is_err());
}

/// Minimal ws client speaking the relay protocol (auth + requests).
struct Ws {
    ws: tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    mls: ChatClient,
    rid: u64,
}

impl Ws {
    async fn connect(addr: SocketAddr, name: &str) -> Ws {
        Self::connect_with(addr, name, ChatClient::new(name).unwrap()).await
    }

    async fn connect_with(addr: SocketAddr, name: &str, mls: ChatClient) -> Ws {
        let (mut ws, _) =
            tokio_tungstenite::connect_async(format!("ws://{addr}/ws")).await.unwrap();
        ws.send(Message::Text(
            json!({"t":"hello","user":name,"pubkey":B64.encode(mls.signature_public_key())})
                .to_string(),
        ))
        .await
        .unwrap();
        let challenge: Value =
            serde_json::from_str(ws.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        let nonce = B64.decode(challenge["nonce"].as_str().unwrap()).unwrap();
        let mut signed = b"relay-auth-v1".to_vec();
        signed.extend_from_slice(&nonce);
        let sig = mls.sign(&signed).unwrap();
        ws.send(Message::Text(json!({"t":"auth","sig":B64.encode(sig)}).to_string()))
            .await
            .unwrap();
        let ready: Value =
            serde_json::from_str(ws.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(ready["t"], "ready");
        Ws { ws, mls, rid: 1 }
    }

    async fn request(&mut self, mut v: Value) -> Value {
        let rid = self.rid;
        self.rid += 1;
        v["rid"] = json!(rid);
        self.ws.send(Message::Text(v.to_string())).await.unwrap();
        loop {
            let frame = tokio::time::timeout(Duration::from_secs(5), self.ws.next())
                .await
                .expect("timeout")
                .unwrap()
                .unwrap();
            if let Message::Text(t) = frame {
                let v: Value = serde_json::from_str(&t).unwrap();
                if v["rid"] == json!(rid) {
                    return v;
                }
            }
        }
    }
}

#[tokio::test]
async fn offline_members_receive_web_push() {
    // Mock push service: capture POSTs.
    let (posts_tx, mut posts_rx) = mpsc::unbounded_channel::<(String, Vec<u8>)>();
    let mock = axum::Router::new().route(
        "/push/{who}",
        axum::routing::post(
            move |axum::extract::Path(who): axum::extract::Path<String>,
                  headers: axum::http::HeaderMap,
                  body: axum::body::Bytes| {
                let posts_tx = posts_tx.clone();
                async move {
                    let encoding = headers
                        .get("content-encoding")
                        .map(|v| v.to_str().unwrap_or("").to_string())
                        .unwrap_or_default();
                    posts_tx.send((format!("{who}:{encoding}"), body.to_vec())).unwrap();
                    axum::http::StatusCode::CREATED
                }
            },
        ),
    );
    let mock_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mock_addr = mock_listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(mock_listener, mock).await.unwrap() });

    // Relay.
    let blobs = BlobStore::new(tempfile::tempdir().unwrap().keep()).unwrap();
    let app = App::with_parts(Box::new(MemoryStore::default()), blobs, PushService::from_env());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, relay::router(app)).await.unwrap() });

    // Browser-side subscription keys (what PushManager would generate).
    let ua_secret = p256::SecretKey::random(&mut rand::rngs::OsRng);
    let p256dh =
        URL_SAFE_NO_PAD.encode(ua_secret.public_key().to_encoded_point(false).as_bytes());
    let mut auth = [0u8; 16];
    use rand::RngCore;
    rand::thread_rng().fill_bytes(&mut auth);
    let subscription = json!({
        "endpoint": format!("http://{mock_addr}/push/bob"),
        "keys": { "p256dh": p256dh, "auth": URL_SAFE_NO_PAD.encode(auth) },
    })
    .to_string();

    // alice owns a group; bob subscribes to push, is allowed in, goes offline.
    let mut alice = Ws::connect(addr, "alice").await;
    alice.mls.create_group("g1").unwrap();
    alice.request(json!({"t":"create_group","group":"g1"})).await;
    let mut bob = Ws::connect(addr, "bob").await;
    let reply = bob.request(json!({"t":"push_subscribe","subscription":subscription})).await;
    assert_eq!(reply["t"], "ok");
    alice.request(json!({"t":"allow","group":"g1","user":"bob"})).await;
    let bob_mls = bob.mls;
    drop(bob.ws);
    tokio::time::sleep(Duration::from_millis(100)).await; // let the hub notice

    // alice sends -> offline bob gets pushed.
    let blob = alice.mls.send_message("g1", "wake up").unwrap();
    let reply = alice
        .request(json!({"t":"send","group":"g1","epoch":1,"payload":B64.encode(blob)}))
        .await;
    assert_eq!(reply["t"], "ok");

    let (meta, body) = tokio::time::timeout(Duration::from_secs(5), posts_rx.recv())
        .await
        .expect("push never arrived")
        .unwrap();
    assert_eq!(meta, "bob:aes128gcm", "push must be aes128gcm-encrypted for bob");
    assert!(!body.is_empty(), "push body must carry the encrypted payload");

    // Online members are NOT pushed: bob reconnects, alice sends again.
    let mut bob = Ws::connect_with(addr, "bob", bob_mls).await;
    let reply = bob.request(json!({"t":"subscribe","group":"g1","after":0})).await;
    assert_eq!(reply["t"], "ok");
    let blob = alice.mls.send_message("g1", "you're here").unwrap();
    alice
        .request(json!({"t":"send","group":"g1","epoch":1,"payload":B64.encode(blob)}))
        .await;
    assert!(
        tokio::time::timeout(Duration::from_millis(600), posts_rx.recv()).await.is_err(),
        "no push may be sent while the member is online"
    );
}
