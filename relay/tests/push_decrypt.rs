//! End-to-end Web Push *crypto* test. The existing push test proves a POST
//! lands with the right content-encoding header; it never checks that the
//! body is a correctly encrypted message. A real browser rejects (silently
//! drops) a malformed aes128gcm payload — so a broken encryption would look
//! "delivered" to a mock yet produce no notification in practice.
//!
//! Here we play the browser's receiver role: reconstruct the content
//! encryption key from the subscription's ECDH keypair + auth secret
//! (RFC 8291) and decrypt the record (RFC 8188), asserting the relay's push
//! payload decrypts to the exact JSON the send path emits.

use aes_gcm::aead::Aead;
use aes_gcm::{Aes128Gcm, KeyInit, Nonce};
use base64::engine::general_purpose::{STANDARD as B64, URL_SAFE_NO_PAD};
use base64::Engine;
use crypto_core::ChatClient;
use futures_util::{SinkExt, StreamExt};
use hkdf::Hkdf;
use p256::elliptic_curve::sec1::ToEncodedPoint;
use rand::RngCore;
use relay::blobs::BlobStore;
use relay::push::PushService;
use relay::server::App;
use relay::store::MemoryStore;
use serde_json::{json, Value};
use sha2::Sha256;
use std::net::SocketAddr;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

/// RFC 8291 receiver-side decryption of an aes128gcm Web Push body.
fn decrypt_push(
    body: &[u8],
    ua_secret: &p256::SecretKey,
    ua_public_uncompressed: &[u8],
    auth: &[u8],
) -> Vec<u8> {
    // RFC 8188 header: salt(16) || rs(4) || idlen(1) || keyid(idlen).
    let salt = &body[0..16];
    let idlen = body[20] as usize;
    let keyid = &body[21..21 + idlen]; // the app-server's ephemeral public key
    let ciphertext = &body[21 + idlen..];
    assert_eq!(idlen, 65, "keyid must be the uncompressed P-256 sender key");

    let as_public = p256::PublicKey::from_sec1_bytes(keyid).expect("valid sender public key");
    let shared = p256::ecdh::diffie_hellman(ua_secret.to_nonzero_scalar(), as_public.as_affine());

    // PRK_combine = HKDF(salt=auth, ikm=ecdh, info="WebPush: info"||0||ua||as, 32)
    let mut key_info = Vec::new();
    key_info.extend_from_slice(b"WebPush: info\0");
    key_info.extend_from_slice(ua_public_uncompressed);
    key_info.extend_from_slice(keyid);
    let hk = Hkdf::<Sha256>::new(Some(auth), shared.raw_secret_bytes());
    let mut ikm = [0u8; 32];
    hk.expand(&key_info, &mut ikm).unwrap();

    // Then RFC 8188 with the message salt.
    let hk2 = Hkdf::<Sha256>::new(Some(salt), &ikm);
    let mut cek = [0u8; 16];
    hk2.expand(b"Content-Encoding: aes128gcm\0", &mut cek).unwrap();
    let mut nonce = [0u8; 12];
    hk2.expand(b"Content-Encoding: nonce\0", &mut nonce).unwrap();

    let cipher = Aes128Gcm::new_from_slice(&cek).unwrap();
    let mut plaintext = cipher
        .decrypt(Nonce::from_slice(&nonce), ciphertext)
        .expect("push body must decrypt — a failure here means broken notifications");

    // Strip RFC 8188 record padding: data || 0x02 (last record) || 0x00*.
    while plaintext.last() == Some(&0) {
        plaintext.pop();
    }
    assert_eq!(plaintext.pop(), Some(2), "last-record delimiter must be 0x02");
    plaintext
}

async fn relay_addr() -> (SocketAddr, std::sync::Arc<App>) {
    let blobs = BlobStore::new(tempfile::tempdir().unwrap().keep()).unwrap();
    let app = App::with_parts(Box::new(MemoryStore::default()), blobs, PushService::from_env(), true);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    {
        let app = app.clone();
        tokio::spawn(async move { axum::serve(listener, relay::router(app)).await.unwrap() });
    }
    (addr, app)
}

struct Ws {
    ws: tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    mls: ChatClient,
    rid: u64,
}

impl Ws {
    async fn connect(addr: SocketAddr, name: &str, mls: ChatClient) -> Ws {
        let (mut ws, _) =
            tokio_tungstenite::connect_async(format!("ws://{addr}/ws")).await.unwrap();
        ws.send(Message::Text(
            json!({"t":"hello","user":name,"pubkey":B64.encode(mls.signature_public_key())})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
        let challenge: Value =
            serde_json::from_str(ws.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        let nonce = B64.decode(challenge["nonce"].as_str().unwrap()).unwrap();
        let mut signed = b"relay-auth-v1".to_vec();
        signed.extend_from_slice(&nonce);
        let sig = mls.sign(&signed).unwrap();
        ws.send(Message::Text(json!({"t":"auth","sig":B64.encode(sig)}).to_string().into()))
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
        self.ws.send(Message::Text(v.to_string().into())).await.unwrap();
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
async fn offline_push_body_decrypts_to_the_group_nudge() {
    // Mock push service: capture the POST body verbatim.
    let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let mock = axum::Router::new().route(
        "/push",
        axum::routing::post(move |body: axum::body::Bytes| {
            let tx = tx.clone();
            async move {
                tx.send(body.to_vec()).unwrap();
                axum::http::StatusCode::CREATED
            }
        }),
    );
    let mock_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mock_addr = mock_listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(mock_listener, mock).await.unwrap() });

    let (addr, _app) = relay_addr().await;

    // Browser subscription keypair (what PushManager exposes).
    let ua_secret = p256::SecretKey::random(&mut rand::rngs::OsRng);
    let ua_public = ua_secret.public_key().to_encoded_point(false).as_bytes().to_vec();
    let mut auth = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut auth);
    let subscription = json!({
        "endpoint": format!("http://{mock_addr}/push"),
        "keys": { "p256dh": URL_SAFE_NO_PAD.encode(&ua_public), "auth": URL_SAFE_NO_PAD.encode(auth) },
    })
    .to_string();

    // alice owns a group; bob subscribes to push, is allowed in, goes offline.
    let mut alice = Ws::connect(addr, "alice", ChatClient::new("alice").unwrap()).await;
    alice.mls.create_group("g1").unwrap();
    alice.request(json!({"t":"create_group","group":"g1"})).await;
    let mut bob = Ws::connect(addr, "bob", ChatClient::new("bob").unwrap()).await;
    assert_eq!(
        bob.request(json!({"t":"push_subscribe","subscription":subscription})).await["t"],
        "ok"
    );
    alice.request(json!({"t":"allow","group":"g1","user":"bob"})).await;
    drop(bob.ws);
    tokio::time::sleep(Duration::from_millis(100)).await;

    // alice sends -> offline bob gets a push whose body we now decrypt.
    let blob = alice.mls.send_message("g1", "wake up").unwrap();
    alice
        .request(json!({"t":"send","group":"g1","epoch":1,"payload":B64.encode(blob)}))
        .await;

    let body = tokio::time::timeout(Duration::from_secs(5), rx.recv())
        .await
        .expect("push never arrived")
        .unwrap();

    let plaintext = decrypt_push(&body, &ua_secret, &ua_public, &auth);
    // The send path emits exactly {"group":"g1"} — content never leaves the
    // client, so the nudge carries only the group id the relay already knows.
    assert_eq!(
        String::from_utf8(plaintext).unwrap(),
        r#"{"group":"g1"}"#,
        "decrypted push must be the group nudge the send path emits"
    );
}
