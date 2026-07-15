//! Connection handling: challenge-response auth against the user's pinned
//! Ed25519 key, then request routing. The hub serializes append+fan-out per
//! send so subscribers observe the log in seq order, and tracks online
//! users for direct Welcome delivery.

use crate::proto::{ClientMsg, ServerMsg, AUTH_CONTEXT};
use crate::store::{RegisterOutcome, Store, StoreError, StoredWelcome};
use axum::extract::ws::{Message, WebSocket};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use futures_util::{SinkExt, StreamExt};
use rand::RngCore;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};

pub struct App {
    pub store: Box<dyn Store>,
    pub hub: Mutex<Hub>,
}

#[derive(Default)]
pub struct Hub {
    /// group -> (user -> outbound channel)
    subscribers: HashMap<String, HashMap<String, mpsc::UnboundedSender<ServerMsg>>>,
    /// user -> outbound channel (for Welcome delivery)
    online: HashMap<String, mpsc::UnboundedSender<ServerMsg>>,
}

impl App {
    pub fn new(store: Box<dyn Store>) -> Arc<Self> {
        Arc::new(Self { store, hub: Mutex::new(Hub::default()) })
    }
}

fn decode_b64(s: &str) -> Result<Vec<u8>, String> {
    B64.decode(s).map_err(|_| "invalid base64".to_string())
}

async fn send_json(socket: &mut WebSocket, msg: &ServerMsg) -> Result<(), axum::Error> {
    socket
        .send(Message::Text(serde_json::to_string(msg).unwrap().into()))
        .await
}

/// Read the next text frame, ignoring pings; None on close.
async fn next_text(socket: &mut WebSocket) -> Option<String> {
    while let Some(Ok(frame)) = socket.recv().await {
        if let Message::Text(t) = frame {
            return Some(t.to_string());
        }
    }
    None
}

/// hello -> challenge -> auth. Returns the authenticated user name.
async fn authenticate(socket: &mut WebSocket, app: &App) -> Option<String> {
    let hello = next_text(socket).await?;
    let (user, claimed_key) = match serde_json::from_str::<ClientMsg>(&hello) {
        Ok(ClientMsg::Hello { user, pubkey }) => (user, pubkey),
        _ => {
            let _ = send_json(socket, &ServerMsg::Error { rid: None, message: "expected hello".into() }).await;
            return None;
        }
    };
    let claimed_key = match decode_b64(&claimed_key) {
        Ok(k) => k,
        Err(e) => {
            let _ = send_json(socket, &ServerMsg::Error { rid: None, message: e }).await;
            return None;
        }
    };

    let mut nonce = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut nonce);
    send_json(socket, &ServerMsg::Challenge { nonce: B64.encode(nonce) }).await.ok()?;

    let auth = next_text(socket).await?;
    let sig = match serde_json::from_str::<ClientMsg>(&auth) {
        Ok(ClientMsg::Auth { sig }) => decode_b64(&sig).ok()?,
        _ => {
            let _ = send_json(socket, &ServerMsg::Error { rid: None, message: "expected auth".into() }).await;
            return None;
        }
    };

    // Verify against the pinned key if the user exists, else against the
    // claimed key — and only pin (register) after the signature checks out.
    let pinned = match app.store.get_user_pubkey(&user).await {
        Ok(k) => k,
        Err(e) => {
            let _ = send_json(socket, &ServerMsg::Error { rid: None, message: e.to_string() }).await;
            return None;
        }
    };
    let expected_key = pinned.clone().unwrap_or_else(|| claimed_key.clone());

    let mut signed = AUTH_CONTEXT.to_vec();
    signed.extend_from_slice(&nonce);
    if !verify_sig(&expected_key, &signed, &sig) {
        let _ = send_json(socket, &ServerMsg::Error { rid: None, message: "auth failed".into() }).await;
        return None;
    }

    if pinned.is_none() {
        match app.store.register_user(&user, &claimed_key).await {
            Ok(RegisterOutcome::Registered) => {}
            // Raced with another connection registering a different key:
            // re-verify against whatever actually got pinned.
            Ok(RegisterOutcome::Existing(k)) if k == claimed_key => {}
            _ => {
                let _ = send_json(socket, &ServerMsg::Error { rid: None, message: "auth failed".into() }).await;
                return None;
            }
        }
    }

    send_json(socket, &ServerMsg::Ready { user: user.clone() }).await.ok()?;
    Some(user)
}

fn verify_sig(pubkey: &[u8], message: &[u8], sig: &[u8]) -> bool {
    let Ok(key_bytes) = <[u8; 32]>::try_from(pubkey) else { return false };
    let Ok(key) = VerifyingKey::from_bytes(&key_bytes) else { return false };
    let Ok(signature) = Signature::from_slice(sig) else { return false };
    key.verify(message, &signature).is_ok()
}

pub async fn handle_socket(mut socket: WebSocket, app: Arc<App>) {
    let Some(user) = authenticate(&mut socket, &app).await else { return };

    let (tx, mut rx) = mpsc::unbounded_channel::<ServerMsg>();
    {
        let mut hub = app.hub.lock().await;
        hub.online.insert(user.clone(), tx.clone());
    }

    // Flush Welcomes queued while this user was offline.
    if let Ok(welcomes) = app.store.take_welcomes(&user).await {
        for w in welcomes {
            let _ = tx.send(ServerMsg::Welcome {
                from: w.from,
                group: w.group,
                after: w.after,
                payload: B64.encode(&w.payload),
            });
        }
    }

    // One task drains the outbound channel; requests are handled inline.
    let (mut ws_tx, mut ws_rx) = socket.split();
    let writer = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            let text = serde_json::to_string(&msg).unwrap();
            if ws_tx.send(Message::Text(text.into())).await.is_err() {
                break;
            }
        }
    });

    while let Some(Ok(frame)) = ws_rx.next().await {
        let Message::Text(text) = frame else { continue };
        let msg = match serde_json::from_str::<ClientMsg>(&text) {
            Ok(m) => m,
            Err(e) => {
                let _ = tx.send(ServerMsg::Error { rid: None, message: format!("bad message: {e}") });
                continue;
            }
        };
        let reply = handle_request(&app, &user, &tx, msg).await;
        if let Some(reply) = reply {
            if tx.send(reply).is_err() {
                break;
            }
        }
    }

    let mut hub = app.hub.lock().await;
    for subs in hub.subscribers.values_mut() {
        subs.remove(&user);
    }
    if hub.online.get(&user).is_some_and(|t| t.same_channel(&tx)) {
        hub.online.remove(&user);
    }
    drop(hub);
    writer.abort();
}

fn err(rid: u64, e: impl std::fmt::Display) -> Option<ServerMsg> {
    Some(ServerMsg::Error { rid: Some(rid), message: e.to_string() })
}

async fn handle_request(
    app: &App,
    user: &str,
    tx: &mpsc::UnboundedSender<ServerMsg>,
    msg: ClientMsg,
) -> Option<ServerMsg> {
    match msg {
        ClientMsg::Hello { .. } | ClientMsg::Auth { .. } => {
            Some(ServerMsg::Error { rid: None, message: "already authenticated".into() })
        }

        ClientMsg::PublishKp { rid, payloads } => {
            let mut decoded = Vec::with_capacity(payloads.len());
            for p in &payloads {
                match decode_b64(p) {
                    Ok(b) => decoded.push(b),
                    Err(e) => return err(rid, e),
                }
            }
            match app.store.publish_key_packages(user, decoded).await {
                Ok(()) => Some(ServerMsg::Ok { rid, seq: None }),
                Err(e) => err(rid, e),
            }
        }

        ClientMsg::FetchKp { rid, user: target } => {
            match app.store.take_key_package(&target).await {
                Ok(kp) => Some(ServerMsg::Kp { rid, user: target, payload: kp.map(|b| B64.encode(b)) }),
                Err(e) => err(rid, e),
            }
        }

        ClientMsg::CreateGroup { rid, group } => {
            match app.store.create_group(&group, user).await {
                Ok(()) => {
                    let mut hub = app.hub.lock().await;
                    hub.subscribers.entry(group).or_default().insert(user.to_string(), tx.clone());
                    Some(ServerMsg::Ok { rid, seq: None })
                }
                Err(e) => err(rid, e),
            }
        }

        ClientMsg::Allow { rid, group, user: target } => {
            match require_member(app, &group, user).await {
                Ok(()) => match app.store.allow_member(&group, &target).await {
                    Ok(()) => Some(ServerMsg::Ok { rid, seq: None }),
                    Err(e) => err(rid, e),
                },
                Err(e) => err(rid, e),
            }
        }

        ClientMsg::Subscribe { rid, group, after } => {
            if let Err(e) = require_member(app, &group, user).await {
                return err(rid, e);
            }
            // Register and backfill under the hub lock so no live message
            // can interleave with (or go missing from) the catch-up read.
            let mut hub = app.hub.lock().await;
            let backlog = match app.store.messages_after(&group, after).await {
                Ok(b) => b,
                Err(e) => return err(rid, e),
            };
            hub.subscribers.entry(group).or_default().insert(user.to_string(), tx.clone());
            let _ = tx.send(ServerMsg::Ok { rid, seq: None });
            for m in backlog {
                let _ = tx.send(ServerMsg::Msg {
                    group: m.group,
                    seq: m.seq,
                    epoch: m.epoch,
                    sender: m.sender,
                    payload: B64.encode(&m.payload),
                });
            }
            None
        }

        ClientMsg::Send { rid, group, epoch, payload } => {
            if let Err(e) = require_member(app, &group, user).await {
                return err(rid, e);
            }
            let payload = match decode_b64(&payload) {
                Ok(b) => b,
                Err(e) => return err(rid, e),
            };
            // Append and fan out under the hub lock: seq order == delivery
            // order for every subscriber.
            let mut hub = app.hub.lock().await;
            let seq = match app.store.append_message(&group, epoch, user, payload.clone()).await {
                Ok(s) => s,
                Err(e) => return err(rid, e),
            };
            if let Some(subs) = hub.subscribers.get_mut(&group) {
                let out = ServerMsg::Msg {
                    group: group.clone(),
                    seq,
                    epoch,
                    sender: user.to_string(),
                    payload: B64.encode(&payload),
                };
                subs.retain(|peer, ch| {
                    if peer == user {
                        return true;
                    }
                    ch.send(out.clone()).is_ok()
                });
            }
            Some(ServerMsg::Ok { rid, seq: Some(seq) })
        }

        ClientMsg::Welcome { rid, to, group, after, payload } => {
            if let Err(e) = require_member(app, &group, user).await {
                return err(rid, e);
            }
            let payload = match decode_b64(&payload) {
                Ok(b) => b,
                Err(e) => return err(rid, e),
            };
            let out = ServerMsg::Welcome {
                from: user.to_string(),
                group: group.clone(),
                after,
                payload: B64.encode(&payload),
            };
            let hub = app.hub.lock().await;
            let delivered = hub.online.get(&to).is_some_and(|ch| ch.send(out.clone()).is_ok());
            drop(hub);
            if !delivered {
                let stored = StoredWelcome { from: user.to_string(), group, after, payload };
                if let Err(e) = app.store.store_welcome(&to, stored).await {
                    return err(rid, e);
                }
            }
            Some(ServerMsg::Ok { rid, seq: None })
        }
    }
}

async fn require_member(app: &App, group: &str, user: &str) -> Result<(), StoreError> {
    match app.store.is_member(group, user).await {
        Ok(true) => Ok(()),
        Ok(false) => Err(StoreError::Backend(format!("not a member of {group}"))),
        Err(e) => Err(e),
    }
}

