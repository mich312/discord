//! Connection handling: challenge-response auth against the user's pinned
//! Ed25519 key, then request routing. The hub serializes append+fan-out per
//! send so subscribers observe the log in seq order, and tracks online
//! users for direct Welcome delivery.

use crate::account::AccountService;
use crate::blobs::BlobStore;
use crate::proto::{ClientMsg, GroupEntry, MemberEntry, ServerMsg, AUTH_CONTEXT};
use crate::push::PushService;
use crate::store::{
    InviteRecord, RegisterOutcome, Store, StoreError, StoredWelcome, ROLE_ADMIN, ROLE_MEMBER,
};
use axum::extract::ws::{Message, WebSocket};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use futures_util::{SinkExt, StreamExt};
use rand::RngCore;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};

pub struct App {
    pub store: Box<dyn Store>,
    pub hub: Mutex<Hub>,
    pub blobs: BlobStore,
    pub push: PushService,
    pub accounts: AccountService,
    /// Global admins (RELAY_ADMINS, comma-separated user ids): treated as
    /// admin of every group and allowed to list all users/groups. Metadata
    /// power only — message content stays end-to-end encrypted.
    pub admins: HashSet<String>,
    /// Voice ICE configuration, rendered per client (TURN credentials are
    /// minted fresh and short-lived on each `ice_info`).
    pub ice: IceConfig,
}

/// Default ICE config when nothing is configured: one public STUN server.
/// Enough for cone NATs; self-hosters behind symmetric NATs need TURN.
pub const DEFAULT_ICE_SERVERS: &str = r#"[{"urls":"stun:stun.l.google.com:19302"}]"#;

/// How the relay answers `ice_info`. Three modes, in precedence order:
///   1. `ICE_SERVERS` — a verbatim JSON array, served as-is (static creds).
///   2. `TURN_URLS` + `TURN_SECRET` — the relay mints a short-lived credential
///      per request (coturn's TURN REST API / `use-auth-secret`), so no shared
///      password is ever shipped to clients.
///   3. neither — the default public STUN.
pub struct IceConfig {
    /// Verbatim `ICE_SERVERS` passthrough; wins if present.
    static_json: Option<String>,
    stun_urls: Vec<String>,
    turn_urls: Vec<String>,
    turn_secret: Option<String>,
    /// Credential lifetime in seconds.
    turn_ttl: u64,
}

type HmacSha1 = hmac::Hmac<sha1::Sha1>;

/// TURN REST API credential: base64(HMAC-SHA1(secret, username)), where
/// `username` is `<expiry-unix>:<user>`. coturn recomputes and compares this.
fn turn_credential(secret: &str, username: &str) -> String {
    use hmac::Mac;
    let mut mac = HmacSha1::new_from_slice(secret.as_bytes()).expect("HMAC accepts any key length");
    mac.update(username.as_bytes());
    B64.encode(mac.finalize().into_bytes())
}

impl IceConfig {
    pub fn from_env() -> Self {
        let split = |v: String| {
            v.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect::<Vec<_>>()
        };
        let static_json = std::env::var("ICE_SERVERS")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .and_then(|s| match serde_json::from_str::<serde_json::Value>(&s) {
                Ok(v) if v.is_array() => Some(s),
                _ => {
                    tracing::error!(
                        "ICE_SERVERS is set but is not a JSON array of RTCIceServer objects; \
                         ignoring it."
                    );
                    None
                }
            });
        let turn_urls = std::env::var("TURN_URLS").ok().map(split).unwrap_or_default();
        let turn_secret = std::env::var("TURN_SECRET").ok().filter(|s| !s.is_empty());
        let turn_ttl =
            std::env::var("TURN_TTL").ok().and_then(|s| s.parse().ok()).unwrap_or(3600);
        let stun_urls = std::env::var("STUN_URLS").ok().map(split).unwrap_or_default();
        if turn_urls.is_empty() != turn_secret.is_none() {
            tracing::warn!(
                "TURN needs both TURN_URLS and TURN_SECRET; ignoring the partial configuration"
            );
        }
        Self { static_json, stun_urls, turn_urls, turn_secret, turn_ttl }
    }

    /// Render the ICE server list this `user` should use `now`. Pure, so it is
    /// unit-testable and the per-request credential is deterministic per second.
    pub fn render(&self, user: &str, now: u64) -> String {
        if let Some(s) = &self.static_json {
            return s.clone();
        }
        let mut servers: Vec<serde_json::Value> =
            self.stun_urls.iter().map(|u| serde_json::json!({ "urls": u })).collect();
        if let (Some(secret), false) = (&self.turn_secret, self.turn_urls.is_empty()) {
            let username = format!("{}:{}", now + self.turn_ttl, user);
            let credential = turn_credential(secret, &username);
            servers.push(serde_json::json!({
                "urls": self.turn_urls,
                "username": username,
                "credential": credential,
            }));
        }
        if servers.is_empty() {
            return DEFAULT_ICE_SERVERS.to_string();
        }
        serde_json::to_string(&servers).unwrap_or_else(|_| DEFAULT_ICE_SERVERS.to_string())
    }
}

#[derive(Default)]
pub struct Hub {
    /// group -> (user -> outbound channel)
    subscribers: HashMap<String, HashMap<String, mpsc::UnboundedSender<ServerMsg>>>,
    /// user -> outbound channel (for Welcome delivery)
    online: HashMap<String, mpsc::UnboundedSender<ServerMsg>>,
}

impl App {
    /// Env-configured construction: BLOB_DIR (default ./blobs) and
    /// VAPID_PRIVATE_KEY (ephemeral if unset).
    pub fn new(store: Box<dyn Store>) -> Arc<Self> {
        let dir = std::env::var("BLOB_DIR").unwrap_or_else(|_| "./blobs".into());
        let blobs = BlobStore::new(dir).expect("blob dir must be creatable");
        Self::with_parts(store, blobs, PushService::from_env())
    }

    pub fn with_parts(store: Box<dyn Store>, blobs: BlobStore, push: PushService) -> Arc<Self> {
        let admins = std::env::var("RELAY_ADMINS")
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(String::from)
            .collect();
        Self::with_parts_and_admins(store, blobs, push, admins)
    }

    pub fn with_parts_and_admins(
        store: Box<dyn Store>,
        blobs: BlobStore,
        push: PushService,
        admins: HashSet<String>,
    ) -> Arc<Self> {
        Arc::new(Self {
            store,
            hub: Mutex::new(Hub::default()),
            blobs,
            push,
            accounts: AccountService::from_env(),
            admins,
            ice: IceConfig::from_env(),
        })
    }

    /// Fire-and-forget web push to every subscription of `user`; dead
    /// subscriptions are dropped.
    async fn push_notify(&self, user: &str, payload: serde_json::Value) {
        let subs = match self.store.push_subscriptions_for(user).await {
            Ok(s) => s,
            Err(_) => return,
        };
        let body = payload.to_string().into_bytes();
        for (endpoint, subscription) in subs {
            match self.push.send(&subscription, &body).await {
                Ok(true) => {}
                Ok(false) => {
                    let _ = self.store.delete_push_subscription(user, &endpoint).await;
                }
                Err(e) => tracing::debug!("push to {user} failed: {e}"),
            }
        }
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

    let ready = ServerMsg::Ready { user: user.clone(), global_admin: app.admins.contains(&user) };
    send_json(socket, &ready).await.ok()?;
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
        // Register as online AND drain Welcomes queued while offline under a
        // single hold of the hub lock. This serializes against the Welcome
        // handler's "check online, else store" critical section: otherwise a
        // Welcome that saw us offline could store *just after* we drained,
        // stranding it until our next reconnect.
        let mut hub = app.hub.lock().await;
        hub.online.insert(user.clone(), tx.clone());
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
    app: &Arc<App>,
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
            match require_admin(app, &group, user).await {
                Ok(()) => match app.store.allow_member(&group, &target).await {
                    Ok(()) => Some(ServerMsg::Ok { rid, seq: None }),
                    Err(e) => err(rid, e),
                },
                Err(e) => err(rid, e),
            }
        }

        ClientMsg::SetRole { rid, group, user: target, role } => {
            if role != ROLE_ADMIN && role != ROLE_MEMBER {
                return err(rid, "role must be admin or member");
            }
            if let Err(e) = require_admin(app, &group, user).await {
                return err(rid, e);
            }
            // A group must always keep at least one admin, or it becomes
            // unmanageable (global admins aside).
            if role == ROLE_MEMBER {
                let members = match app.store.group_members(&group).await {
                    Ok(m) => m,
                    Err(e) => return err(rid, e),
                };
                let target_is_admin =
                    members.iter().any(|(m, r)| m == &target && r == ROLE_ADMIN);
                let admins = members.iter().filter(|(_, r)| r == ROLE_ADMIN).count();
                if target_is_admin && admins <= 1 {
                    return err(rid, "cannot demote the last admin");
                }
            }
            match app.store.set_member_role(&group, &target, &role).await {
                Ok(()) => Some(ServerMsg::Ok { rid, seq: None }),
                Err(e) => err(rid, e),
            }
        }

        ClientMsg::Members { rid, group } => {
            if !app.admins.contains(user) {
                if let Err(e) = require_member(app, &group, user).await {
                    return err(rid, e);
                }
            }
            match app.store.group_members(&group).await {
                Ok(members) => Some(ServerMsg::Members {
                    rid,
                    group,
                    members: members
                        .into_iter()
                        .map(|(user, role)| MemberEntry { user, role })
                        .collect(),
                }),
                Err(e) => err(rid, e),
            }
        }

        ClientMsg::AdminList { rid } => {
            if !app.admins.contains(user) {
                return err(rid, "global admin required");
            }
            let users = match app.store.list_users().await {
                Ok(u) => u,
                Err(e) => return err(rid, e),
            };
            let groups = match app.store.list_groups().await {
                Ok(g) => g,
                Err(e) => return err(rid, e),
            };
            Some(ServerMsg::AdminList {
                rid,
                users,
                groups: groups
                    .into_iter()
                    .map(|(group, created_by)| GroupEntry { group, created_by })
                    .collect(),
            })
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
            let seq = {
                let mut hub = app.hub.lock().await;
                let seq = match app.store.append_message(&group, epoch, user, payload.clone()).await
                {
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
                seq
            };
            // Nudge members with no live connection. The membership read is a
            // DB round-trip, so keep it off the hub lock — only the in-memory
            // liveness check needs the lock. Push is a best-effort nudge, so a
            // small liveness race here is harmless. Payload carries only what
            // the relay knows anyway (the group id).
            let offline: Vec<String> = match app.store.group_members(&group).await {
                Ok(members) => {
                    let hub = app.hub.lock().await;
                    members
                        .into_iter()
                        .map(|(m, _)| m)
                        .filter(|m| m != user && !hub.online.contains_key(m))
                        .collect()
                }
                Err(_) => Vec::new(),
            };
            if !offline.is_empty() {
                let app = app.clone();
                let group = group.clone();
                tokio::spawn(async move {
                    for member in offline {
                        app.push_notify(&member, serde_json::json!({"group": group})).await;
                    }
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
            // Deliver live if the recipient is connected, else persist for
            // their next connect. The online check and the store both happen
            // under the hub lock so they can't interleave with a recipient's
            // connect+drain (see handle_socket) — which would otherwise let a
            // Welcome be neither delivered nor drained.
            let hub = app.hub.lock().await;
            let delivered = hub.online.get(&to).is_some_and(|ch| ch.send(out.clone()).is_ok());
            if !delivered {
                let stored =
                    StoredWelcome { from: user.to_string(), group: group.clone(), after, payload };
                if let Err(e) = app.store.store_welcome(&to, stored).await {
                    drop(hub);
                    return err(rid, e);
                }
            }
            drop(hub);
            if !delivered {
                let app = app.clone();
                let to = to.clone();
                tokio::spawn(async move {
                    app.push_notify(&to, serde_json::json!({"welcome": group})).await;
                });
            }
            Some(ServerMsg::Ok { rid, seq: None })
        }

        ClientMsg::CreateInvite { rid, invite, group, payload, expires_at, max_uses } => {
            if let Err(e) = require_admin(app, &group, user).await {
                return err(rid, e);
            }
            let payload = match decode_b64(&payload) {
                Ok(b) => b,
                Err(e) => return err(rid, e),
            };
            let record = InviteRecord { group, payload, expires_at, max_uses, uses: 0 };
            match app.store.create_invite(&invite, record).await {
                Ok(()) => Some(ServerMsg::Ok { rid, seq: None }),
                Err(e) => err(rid, e),
            }
        }

        ClientMsg::UpdateInvite { rid, invite, payload } => {
            let group = match app.store.invite_group(&invite).await {
                Ok(Some(g)) => g,
                Ok(None) => return err(rid, StoreError::InviteInvalid),
                Err(e) => return err(rid, e),
            };
            if let Err(e) = require_admin(app, &group, user).await {
                return err(rid, e);
            }
            let payload = match decode_b64(&payload) {
                Ok(b) => b,
                Err(e) => return err(rid, e),
            };
            match app.store.update_invite(&invite, payload).await {
                Ok(()) => Some(ServerMsg::Ok { rid, seq: None }),
                Err(e) => err(rid, e),
            }
        }

        ClientMsg::RevokeInvite { rid, invite } => {
            let group = match app.store.invite_group(&invite).await {
                Ok(Some(g)) => g,
                Ok(None) => return Some(ServerMsg::Ok { rid, seq: None }), // already gone
                Err(e) => return err(rid, e),
            };
            if let Err(e) = require_admin(app, &group, user).await {
                return err(rid, e);
            }
            match app.store.revoke_invite(&invite).await {
                Ok(()) => Some(ServerMsg::Ok { rid, seq: None }),
                Err(e) => err(rid, e),
            }
        }

        ClientMsg::RedeemInvite { rid, invite } => {
            match app.store.redeem_invite(&invite, now_unix()).await {
                Ok((group, payload)) => {
                    // The link is a bearer token: holding it grants relay-level
                    // membership. Whether the joiner can READ anything is
                    // still up to MLS (they need the fragment key).
                    if let Err(e) = app.store.allow_member(&group, user).await {
                        return err(rid, e);
                    }
                    Some(ServerMsg::Invite { rid, group, payload: B64.encode(&payload) })
                }
                Err(e) => err(rid, e),
            }
        }

        ClientMsg::Ephemeral { rid, group, payload } => {
            if let Err(e) = require_member(app, &group, user).await {
                return err(rid, e);
            }
            if decode_b64(&payload).is_err() {
                return err(rid, "invalid base64");
            }
            let mut hub = app.hub.lock().await;
            if let Some(subs) = hub.subscribers.get_mut(&group) {
                let out = ServerMsg::Eph {
                    group: group.clone(),
                    sender: user.to_string(),
                    payload,
                };
                subs.retain(|peer, ch| {
                    if peer == user {
                        return true;
                    }
                    ch.send(out.clone()).is_ok()
                });
            }
            Some(ServerMsg::Ok { rid, seq: None })
        }

        ClientMsg::VaultSet { rid, kind, salt, verifier, wrapped, credential } => {
            if kind != "password" && kind != "passkey" {
                return err(rid, "kind must be password or passkey");
            }
            let (Ok(salt), Ok(verifier), Ok(wrapped)) =
                (decode_b64(&salt), decode_b64(&verifier), decode_b64(&wrapped))
            else {
                return err(rid, "invalid base64");
            };
            let vault = crate::store::VaultRecord { kind, salt, verifier, wrapped, credential };
            match app.store.set_vault(user, vault).await {
                Ok(()) => Some(ServerMsg::Ok { rid, seq: None }),
                Err(e) => err(rid, e),
            }
        }

        ClientMsg::VaultStatus { rid } => {
            match app.store.get_vault(user).await {
                Ok(vault) => Some(ServerMsg::VaultStatus {
                    rid,
                    kind: vault.map(|v| v.kind),
                }),
                Err(e) => err(rid, e),
            }
        }

        ClientMsg::PasskeyRegisterStart { rid } => {
            match app.accounts.start_registration(user) {
                Ok(options) => Some(ServerMsg::Passkey { rid, payload: options }),
                Err(e) => err(rid, e),
            }
        }

        ClientMsg::PasskeyRegisterFinish { rid, credential } => {
            match app.accounts.finish_registration(user, &credential) {
                Ok(passkey_json) => Some(ServerMsg::Passkey { rid, payload: passkey_json }),
                Err(e) => err(rid, e),
            }
        }

        ClientMsg::PushInfo { rid } => {
            Some(ServerMsg::PushInfo { rid, pubkey: app.push.public_b64.clone() })
        }

        ClientMsg::IceInfo { rid } => {
            Some(ServerMsg::IceInfo { rid, servers: app.ice.render(user, now_unix()) })
        }

        ClientMsg::PushSubscribe { rid, subscription } => {
            let endpoint = serde_json::from_str::<serde_json::Value>(&subscription)
                .ok()
                .and_then(|v| v["endpoint"].as_str().map(String::from));
            let Some(endpoint) = endpoint else {
                return Some(ServerMsg::Error {
                    rid: Some(rid),
                    message: "subscription must be JSON with an endpoint".into(),
                });
            };
            match app.store.put_push_subscription(user, &endpoint, &subscription).await {
                Ok(()) => Some(ServerMsg::Ok { rid, seq: None }),
                Err(e) => err(rid, e),
            }
        }
    }
}

fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

async fn require_member(app: &App, group: &str, user: &str) -> Result<(), StoreError> {
    match app.store.is_member(group, user).await {
        Ok(true) => Ok(()),
        Ok(false) => Err(StoreError::Backend(format!("not a member of {group}"))),
        Err(e) => Err(e),
    }
}

/// Group admin or global admin. Gates the management surface: allowing
/// members, invites, role changes.
async fn require_admin(app: &App, group: &str, user: &str) -> Result<(), StoreError> {
    if app.admins.contains(user) {
        return Ok(());
    }
    match app.store.member_role(group, user).await? {
        Some(role) if role == ROLE_ADMIN => Ok(()),
        Some(_) => Err(StoreError::Backend(format!("admin of {group} required"))),
        None => Err(StoreError::Backend(format!("not a member of {group}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::{turn_credential, IceConfig, DEFAULT_ICE_SERVERS};
    use serde_json::Value;

    fn cfg(
        static_json: Option<&str>,
        stun: &[&str],
        turn: &[&str],
        secret: Option<&str>,
        ttl: u64,
    ) -> IceConfig {
        IceConfig {
            static_json: static_json.map(String::from),
            stun_urls: stun.iter().map(|s| s.to_string()).collect(),
            turn_urls: turn.iter().map(|s| s.to_string()).collect(),
            turn_secret: secret.map(String::from),
            turn_ttl: ttl,
        }
    }

    #[test]
    fn defaults_to_public_stun_when_nothing_is_configured() {
        assert_eq!(cfg(None, &[], &[], None, 3600).render("alice", 1000), DEFAULT_ICE_SERVERS);
    }

    #[test]
    fn static_ice_servers_win_and_are_served_verbatim() {
        let custom = r#"[{"urls":"turn:t.example:3478","username":"u","credential":"p"}]"#;
        // Even with TURN also configured, an explicit ICE_SERVERS passthrough wins.
        let c = cfg(Some(custom), &[], &["turn:other:3478"], Some("s"), 3600);
        assert_eq!(c.render("alice", 1000), custom);
    }

    #[test]
    fn turn_credentials_are_short_lived_per_user_and_hmac_signed() {
        let c = cfg(
            None,
            &["stun:turn.example.org:3478"],
            &["turn:turn.example.org:3478?transport=udp"],
            Some("north-star"),
            600,
        );
        let rendered = c.render("alice", 1_000_000);
        let arr: Vec<Value> = serde_json::from_str(&rendered).unwrap();
        // STUN entry first, then the credentialed TURN entry.
        assert_eq!(arr[0]["urls"], "stun:turn.example.org:3478");
        let turn = &arr[1];
        // username = <expiry>:<user>, expiry = now + ttl.
        assert_eq!(turn["username"], "1000600:alice");
        // credential is exactly the coturn REST digest over that username.
        assert_eq!(
            turn["credential"],
            turn_credential("north-star", "1000600:alice")
        );
        // Different users and different times get different credentials.
        let other: Vec<Value> = serde_json::from_str(&c.render("bob", 1_000_000)).unwrap();
        assert_ne!(other[1]["username"], turn["username"]);
        let later: Vec<Value> = serde_json::from_str(&c.render("alice", 1_000_001)).unwrap();
        assert_ne!(later[1]["credential"], turn["credential"]);
    }

    #[test]
    fn turn_urls_without_a_secret_are_ignored() {
        // A half-configured TURN (no secret) must not emit a credential-less,
        // useless TURN entry — fall back to STUN/default instead.
        assert_eq!(
            cfg(None, &[], &["turn:turn.example.org:3478"], None, 3600).render("alice", 1000),
            DEFAULT_ICE_SERVERS
        );
    }

    #[test]
    fn turn_credential_matches_a_known_answer() {
        // HMAC-SHA1("north-star", "1000600:alice") in base64 — pin the exact
        // wire value coturn will verify against, so a lib/format change trips.
        assert_eq!(turn_credential("north-star", "1000600:alice"), "qLDdP+u9y+AQ13RnJhTEkH1A5uI=");
    }
}

