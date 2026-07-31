//! Connection handling: challenge-response auth against the user's pinned
//! Ed25519 key, then request routing. The hub serializes append+fan-out per
//! send so subscribers observe the log in seq order, and tracks online
//! users for direct Welcome delivery.

use crate::account::AccountService;
use crate::blobs::{BlobStore, UploadTickets};
use crate::metrics::{Metrics, Snapshot};
use crate::proto::{
    ClientMsg, GroupEntry, MemberEntry, PasskeyDeviceOut, ServerMsg, AUTH_CONTEXT,
    PROTOCOL_VERSION,
};
use crate::push::PushService;
use crate::ratelimit::RateLimiter;
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
    /// Single-use authorizations for the otherwise-unauthenticated blob PUT.
    pub blob_tickets: UploadTickets,
    pub push: PushService,
    pub accounts: AccountService,
    /// When false (the production default), an unknown handle can only be
    /// registered by presenting a usable invite id in the Hello — except
    /// for the very first user, who bootstraps the deployment. Existing
    /// (pinned) users are never affected.
    pub open_registration: bool,
    /// Per-client limits on the unauthenticated surface.
    pub limits: Limits,
    /// TRUST_PROXY=1: key rate limits on X-Forwarded-For (the last hop —
    /// the one our own proxy appended) instead of the socket peer. Only
    /// sane behind a proxy; without one the header is client-controlled.
    pub trust_proxy: bool,
    /// Global admins (RELAY_ADMINS, comma-separated user ids): treated as
    /// admin of every group and allowed to list all users/groups. Metadata
    /// power only — message content stays end-to-end encrypted.
    pub admins: HashSet<String>,
    /// Voice ICE configuration, rendered per client (TURN credentials are
    /// minted fresh and short-lived on each `ice_info`).
    pub ice: IceConfig,
    /// Scrape counters. Always collected; only *served* when METRICS_TOKEN
    /// is set (see `lib.rs`), because every number here is metadata.
    pub metrics: Metrics,
}

pub struct Limits {
    /// Credential attempts: password login, passkey challenge/login.
    pub account: RateLimiter,
    /// The sign-in params probe (username enumeration surface).
    pub params: RateLimiter,
    /// New WebSocket connections (auth handshake spam).
    pub ws: RateLimiter,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            account: RateLimiter::per_minute(10),
            params: RateLimiter::per_minute(30),
            ws: RateLimiter::per_minute(60),
        }
    }
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

/// How many messages may be waiting for one connection before the relay
/// stops queueing for it. A client that is merely on a slow link drains far
/// below this; one sitting at the cap is not reading at all.
///
/// The number is a memory bound, not a latency one: a stalled subscriber
/// used to grow its queue without limit, so a single suspended laptop in a
/// busy circle was an unbounded allocation on the server.
pub const MAX_QUEUE: usize = 512;

/// Characters (not bytes) kept from a device label. Counted in `chars` so a
/// truncation cannot split a UTF-8 sequence, and bounded because the value is
/// client-supplied, stored per account, and rendered back into the screen the
/// user revokes devices from.
pub const MAX_DEVICE_LABEL: usize = 64;

/// A connection's outbound queue, plus how much is sitting in it.
///
/// The channel itself stays **unbounded on purpose**. The two callers are
/// not alike: catch-up backfill pushes a whole backlog while the hub lock is
/// held, where a bounded channel would either truncate the backlog silently
/// or block every other circle behind one slow socket. So the bound is
/// applied where it is safe — `offer`, used only for fan-out — and the depth
/// is tracked explicitly rather than inferred.
#[derive(Clone, Debug)]
pub struct Outbound {
    tx: mpsc::UnboundedSender<ServerMsg>,
    depth: Arc<std::sync::atomic::AtomicUsize>,
}

impl Outbound {
    fn new() -> (Self, mpsc::UnboundedReceiver<ServerMsg>, Arc<std::sync::atomic::AtomicUsize>) {
        let (tx, rx) = mpsc::unbounded_channel();
        let depth = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        (Self { tx, depth: depth.clone() }, rx, depth)
    }

    /// Queue unconditionally. For this connection's own replies and its
    /// catch-up backfill — dropping either loses data the client asked for
    /// and has no way to notice.
    fn send(&self, msg: ServerMsg) -> bool {
        if self.tx.send(msg).is_ok() {
            self.depth.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            true
        } else {
            false
        }
    }

    /// Queue if there is room. Returns false when the connection is gone or
    /// too far behind, and the caller drops it.
    ///
    /// Dropping a slow subscriber is **lossless**: the relay is an ordered
    /// log, so the client reconnects and resubscribes from its last seq and
    /// receives everything it missed. That is the whole reason a bound is
    /// safe here and nowhere else.
    fn offer(&self, msg: ServerMsg) -> bool {
        if self.depth.load(std::sync::atomic::Ordering::Relaxed) >= MAX_QUEUE {
            return false;
        }
        self.send(msg)
    }

    fn same_channel(&self, other: &Self) -> bool {
        self.tx.same_channel(&other.tx)
    }
}

#[derive(Default)]
pub struct Hub {
    /// group -> (user -> outbound channel)
    subscribers: HashMap<String, HashMap<String, Outbound>>,
    /// user -> outbound channel (for Welcome delivery)
    online: HashMap<String, Outbound>,
    /// group -> send lock. Ordering only has to hold WITHIN a group, so
    /// serializing per group rather than globally lets unrelated circles
    /// append concurrently. See the Send arm.
    send_locks: HashMap<String, Arc<Mutex<()>>>,
}

impl Hub {
    /// The send lock for `group`, created on first use. Held only long
    /// enough to hand the Arc back — the caller awaits the lock itself
    /// after releasing the hub.
    fn send_lock(&mut self, group: &str) -> Arc<Mutex<()>> {
        self.send_locks.entry(group.to_string()).or_default().clone()
    }

    /// Live counts for a scrape. Read from the hub rather than tracked
    /// alongside it: a gauge kept in step by hand drifts on every early
    /// return, and these are cheap.
    pub fn snapshot(&self) -> Snapshot {
        Snapshot {
            clients_online: self.online.len() as u64,
            // Only circles someone is actually listening to — an entry that
            // has emptied out is not a subscribed group.
            groups_subscribed: self.subscribers.values().filter(|s| !s.is_empty()).count() as u64,
        }
    }
}

impl App {
    /// Env-configured construction: BLOB_DIR (default ./blobs),
    /// VAPID_PRIVATE_KEY (ephemeral if unset), and OPEN_REGISTRATION
    /// (unset/0 = invite-only registration, the default).
    pub fn new(store: Box<dyn Store>) -> Arc<Self> {
        let dir = std::env::var("BLOB_DIR").unwrap_or_else(|_| "./blobs".into());
        let blobs = BlobStore::new(dir).expect("blob dir must be creatable");
        let open = std::env::var("OPEN_REGISTRATION")
            .is_ok_and(|v| v == "1" || v.eq_ignore_ascii_case("true"));
        Self::with_parts(store, blobs, PushService::from_env(), open)
    }

    pub fn with_parts(
        store: Box<dyn Store>,
        blobs: BlobStore,
        push: PushService,
        open_registration: bool,
    ) -> Arc<Self> {
        let admins = std::env::var("RELAY_ADMINS")
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(String::from)
            .collect();
        Self::with_parts_and_admins(store, blobs, push, open_registration, admins)
    }

    pub fn with_parts_and_admins(
        store: Box<dyn Store>,
        blobs: BlobStore,
        push: PushService,
        open_registration: bool,
        admins: HashSet<String>,
    ) -> Arc<Self> {
        Arc::new(Self {
            store,
            hub: Mutex::new(Hub::default()),
            blobs,
            blob_tickets: UploadTickets::default(),
            push,
            accounts: AccountService::from_env(),
            open_registration,
            limits: Limits::default(),
            trust_proxy: std::env::var("TRUST_PROXY")
                .is_ok_and(|v| v == "1" || v.eq_ignore_ascii_case("true")),
            admins,
            ice: IceConfig::from_env(),
            metrics: Metrics::default(),
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
                Ok(true) => self.metrics.push_sent.inc(),
                Ok(false) => {
                    // Gone: the subscription is dead, not the push system.
                    // Counting it as a failure would page on ordinary churn.
                    let _ = self.store.delete_push_subscription(user, &endpoint).await;
                }
                Err(e) => {
                    self.metrics.push_failed.inc();
                    tracing::warn!("push to {user} failed: {e}");
                }
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
    let (user, claimed_key, invite) = match serde_json::from_str::<ClientMsg>(&hello) {
        Ok(ClientMsg::Hello { user, pubkey, invite, v }) => {
            if let Some(v) = v {
                if v != PROTOCOL_VERSION {
                    tracing::debug!(client_version = v, "protocol version skew");
                }
            }
            (user, pubkey, invite)
        }
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

    // Bind the signature to the handle it authenticates, so an answer
    // captured for one identity cannot be replayed as another.
    let mut signed = AUTH_CONTEXT.to_vec();
    signed.extend_from_slice(&nonce);
    signed.extend_from_slice(&(user.len() as u32).to_be_bytes());
    signed.extend_from_slice(user.as_bytes());
    if !verify_sig(&expected_key, &signed, &sig) {
        app.metrics.auth_failures.bad_signature.inc();
        let _ = send_json(socket, &ServerMsg::Error { rid: None, message: "auth failed".into() }).await;
        return None;
    }

    if pinned.is_none() {
        if !registration_allowed(app, &user, invite.as_deref()).await {
            app.metrics.auth_failures.unregistered.inc();
            let _ = send_json(
                socket,
                &ServerMsg::Error {
                    rid: None,
                    message: "registration is invite-only: open an invite link to join".into(),
                },
            )
            .await;
            return None;
        }
        match app.store.register_user(&user, &claimed_key).await {
            Ok(RegisterOutcome::Registered) => app.metrics.registrations.inc(),
            // Raced with another connection registering a different key:
            // re-verify against whatever actually got pinned.
            Ok(RegisterOutcome::Existing(k)) if k == claimed_key => {}
            _ => {
                app.metrics.auth_failures.credential_taken.inc();
                let _ = send_json(socket, &ServerMsg::Error { rid: None, message: "auth failed".into() }).await;
                return None;
            }
        }
    }

    let ready = ServerMsg::Ready { user: user.clone(), global_admin: app.admins.contains(&user) };
    send_json(socket, &ready).await.ok()?;
    Some(user)
}

/// The invite gate for first-time registration. Open registration and the
/// bootstrap user (empty relay) pass; everyone else needs an invite id
/// that would currently redeem. The use itself is only spent when the
/// joiner actually redeems after authenticating.
/// May `user` register right now? For an invite-gated relay this CLAIMS the
/// invite — it used to be a pure read, so one never-redeemed `max_uses: 1`
/// link could register unlimited accounts. Claiming is idempotent per
/// (invite, user), so the same joiner presenting the link again in
/// `RedeemInvite` does not burn a second use.
/// Can a fresh handle register with NO invite at all? A pure query, used by
/// the onboarding UI to say "invite-only" up front. Deliberately separate
/// from the gate below, which spends a use — asking must never consume.
pub async fn registration_open_without_invite(app: &App) -> bool {
    app.open_registration
        || app.store.user_count().await.map(|n| n == 0).unwrap_or(false)
}

pub async fn registration_allowed(app: &App, user: &str, invite: Option<&str>) -> bool {
    if app.open_registration {
        return true;
    }
    if app.store.user_count().await.map(|n| n == 0).unwrap_or(false) {
        return true;
    }
    match invite {
        Some(id) => app
            .store
            .claim_invite_for_registration(id, user, now_unix())
            .await
            .unwrap_or(false),
        None => false,
    }
}

fn verify_sig(pubkey: &[u8], message: &[u8], sig: &[u8]) -> bool {
    let Ok(key_bytes) = <[u8; 32]>::try_from(pubkey) else { return false };
    let Ok(key) = VerifyingKey::from_bytes(&key_bytes) else { return false };
    let Ok(signature) = Signature::from_slice(sig) else { return false };
    // verify_strict rejects small-order / non-canonical keys, which the
    // permissive verify accepts.
    key.verify_strict(message, &signature).is_ok()
}

pub async fn handle_socket(mut socket: WebSocket, app: Arc<App>) {
    let Some(user) = authenticate(&mut socket, &app).await else { return };

    let (tx, mut rx, depth) = Outbound::new();
    {
        // Register as online AND drain Welcomes queued while offline under a
        // single hold of the hub lock. This serializes against the Welcome
        // handler's "check online, else store" critical section: otherwise a
        // Welcome that saw us offline could store *just after* we drained,
        // stranding it until our next reconnect.
        let mut hub = app.hub.lock().await;
        hub.online.insert(user.clone(), tx.clone());
        // Connect/disconnect is the single most useful line an operator has
        // when someone reports "messages aren't arriving": it answers
        // whether the client is even here. The handle is metadata the relay
        // already holds, but it is still metadata, so this is INFO on a
        // deployment's own logs rather than anything exported.
        tracing::info!(user = %user, online = hub.online.len(), "client connected");
        app.metrics.ws_connections.inc();
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
    // A periodic protocol-level ping bounds half-open sockets: browsers
    // auto-pong, and a dead link makes the ping write fail once TCP gives
    // up — ending the writer, which ends the read loop below, which runs
    // teardown. Without it a silently-dead socket keeps its subscription
    // entries (and an unbounded outbound queue) until the OS notices.
    let (mut ws_tx, mut ws_rx) = socket.split();
    let mut writer = tokio::spawn(async move {
        let mut ping = tokio::time::interval(std::time::Duration::from_secs(30));
        ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        ping.tick().await; // the first tick fires immediately — skip it
        loop {
            tokio::select! {
                msg = rx.recv() => {
                    let Some(msg) = msg else { break };
                    // Decrement as it leaves the queue, whether or not it
                    // serializes: a message we drop here still freed its slot,
                    // and leaking depth would strand the connection at the cap.
                    depth.fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
                    let Ok(text) = serde_json::to_string(&msg) else { continue };
                    if ws_tx.send(Message::Text(text.into())).await.is_err() {
                        break;
                    }
                }
                _ = ping.tick() => {
                    if ws_tx.send(Message::Ping(Vec::new().into())).await.is_err() {
                        break;
                    }
                }
            }
        }
    });

    loop {
        let frame = tokio::select! {
            frame = ws_rx.next() => frame,
            // Writer died (dead socket detected via ping/write failure):
            // stop reading so teardown runs now, not at TCP timeout.
            _ = &mut writer => break,
        };
        let Some(Ok(frame)) = frame else { break };
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
            if !tx.send(reply) {
                break;
            }
        }
    }

    let mut hub = app.hub.lock().await;
    // Same guard as `online` below: only remove entries this connection
    // owns. A half-open socket can outlive its replacement by minutes —
    // an unguarded removal here would delete the *reconnected* socket's
    // live subscriptions, leaving the user online-but-subscribed-to-nothing
    // (no live delivery, and no push either since push skips online users).
    for subs in hub.subscribers.values_mut() {
        if subs.get(&user).is_some_and(|t| t.same_channel(&tx)) {
            subs.remove(&user);
        }
    }
    if hub.online.get(&user).is_some_and(|t| t.same_channel(&tx)) {
        hub.online.remove(&user);
    }
    tracing::info!(user = %user, online = hub.online.len(), "client disconnected");
    drop(hub);
    writer.abort();
}

fn err(rid: u64, e: impl std::fmt::Display) -> Option<ServerMsg> {
    Some(ServerMsg::Error { rid: Some(rid), message: e.to_string() })
}

async fn handle_request(
    app: &Arc<App>,
    user: &str,
    tx: &Outbound,
    msg: ClientMsg,
) -> Option<ServerMsg> {
    match msg {
        ClientMsg::Hello { .. } | ClientMsg::Auth { .. } => {
            Some(ServerMsg::Error { rid: None, message: "already authenticated".into() })
        }

        ClientMsg::Ping { rid } => Some(ServerMsg::Ok { rid, seq: None }),

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
            // Taking a KeyPackage CONSUMES it, so an unauthenticated caller
            // could drain a user's supply and make them unaddable while
            // offline. Only a registered user may fetch, and never their own.
            if target == user {
                return err(rid, "cannot fetch your own key package");
            }
            if app.store.get_user_pubkey(&target).await.unwrap_or(None).is_none() {
                return err(rid, "no such user");
            }
            // Serve the pinned identity key with the KeyPackage so the adder
            // can check that the two agree before admitting anyone.
            let pinned = match app.store.get_user_pubkey(&target).await {
                Ok(p) => p,
                Err(e) => return err(rid, e),
            };
            match app.store.take_key_package(&target).await {
                Ok(kp) => Some(ServerMsg::Kp {
                    rid,
                    user: target,
                    payload: kp.map(|b| B64.encode(b)),
                    pubkey: pinned.map(|b| B64.encode(b)),
                }),
                Err(e) => err(rid, e),
            }
        }

        ClientMsg::CreateGroup { rid, group } => {
            match app.store.create_group(&group, user).await {
                Ok(()) => {
                    let mut hub = app.hub.lock().await;
                    hub.subscribers.entry(group.clone()).or_default().insert(user.to_string(), tx.clone());
            tracing::debug!(user = %user, %group, "subscribed");
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

        ClientMsg::Disallow { rid, group, user: target } => {
            // Admins may remove anyone; anyone may remove themselves (leave).
            let is_self = target == user;
            if !is_self {
                if let Err(e) = require_admin(app, &group, user).await {
                    return err(rid, e);
                }
            }
            // A group must always keep at least one admin — the same guard
            // SetRole applies to demotion, here applied to removal.
            let members = match app.store.group_members(&group).await {
                Ok(m) => m,
                Err(e) => return err(rid, e),
            };
            let target_is_admin =
                members.iter().any(|(m, r)| m == &target && r == ROLE_ADMIN);
            let admins = members.iter().filter(|(_, r)| r == ROLE_ADMIN).count();
            if target_is_admin && admins <= 1 {
                return err(rid, "cannot remove the last admin — delete the group instead");
            }
            match app.store.disallow_member(&group, &target).await {
                Ok(()) => {
                    // Drop their live subscription so the fan-out stops at once.
                    let mut hub = app.hub.lock().await;
                    if let Some(subs) = hub.subscribers.get_mut(&group) {
                        subs.remove(&target);
                    }
                    Some(ServerMsg::Ok { rid, seq: None })
                }
                Err(e) => err(rid, e),
            }
        }

        ClientMsg::DeleteGroup { rid, group } => {
            if let Err(e) = require_admin(app, &group, user).await {
                return err(rid, e);
            }
            match app.store.delete_group(&group).await {
                Ok(()) => {
                    // Tear down the live fan-out for the now-gone group.
                    let mut hub = app.hub.lock().await;
                    hub.subscribers.remove(&group);
                    Some(ServerMsg::Ok { rid, seq: None })
                }
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
            hub.subscribers.entry(group.clone()).or_default().insert(user.to_string(), tx.clone());
            tracing::debug!(user = %user, %group, "subscribed");
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

        ClientMsg::Send { rid, group, epoch, payload, commit } => {
            if let Err(e) = require_member(app, &group, user).await {
                app.metrics.send_rejections.not_a_member.inc();
                return err(rid, e);
            }
            let payload = match decode_b64(&payload) {
                Ok(b) => b,
                Err(e) => {
                    app.metrics.send_rejections.malformed.inc();
                    return err(rid, e);
                }
            };
            // Append and fan out under this GROUP's send lock, so seq order
            // still equals delivery order for its subscribers.
            //
            // This used to hold the single global hub mutex across the
            // database round-trip, which serialized every message in every
            // circle behind one lock plus one write — the hard ceiling on
            // throughput. Ordering only ever had to hold within a group.
            //
            // Lock order is always send-lock then hub, never the reverse, so
            // the two cannot deadlock.
            let send_lock = { app.hub.lock().await.send_lock(&group) };
            // Started before the lock is awaited, on purpose: waiting behind
            // a busy circle is latency the sender feels, and excluding it
            // would hide exactly the contention this metric exists to find.
            let started = std::time::Instant::now();
            let _ordered = send_lock.lock().await;
            let seq = {
                let seq = match app
                    .store
                    .append_message(&group, epoch, user, payload.clone(), commit)
                    .await
                {
                    Ok(s) => {
                        app.metrics.messages_appended.inc();
                        app.metrics.append_latency.observe_ms(started.elapsed().as_millis() as u64);
                        s
                    }
                    Err(e) => {
                        app.metrics.note_send_rejection(&e);
                        return err(rid, e);
                    }
                };
                let mut hub = app.hub.lock().await;
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
                        let kept = ch.offer(out.clone());
                        if !kept {
                            app.metrics.subscribers_dropped.inc();
                        }
                        kept
                    });
                }
                seq
            };
            // Nudge members who did NOT just get the message live — i.e.
            // anyone without a subscription to this group, not merely anyone
            // offline: an online-but-unsubscribed member (reconnect race,
            // pre-subscribe window) would otherwise get neither delivery nor
            // nudge. The membership read is a DB round-trip, so keep it off
            // the hub lock. Push is a best-effort nudge, so a small liveness
            // race here is harmless. Payload carries only what the relay
            // knows anyway (the group id).
            let offline: Vec<String> = match app.store.group_members(&group).await {
                Ok(members) => {
                    let hub = app.hub.lock().await;
                    members
                        .into_iter()
                        .map(|(m, _)| m)
                        .filter(|m| {
                            m != user
                                && !hub
                                    .subscribers
                                    .get(&group)
                                    .is_some_and(|subs| subs.contains_key(m))
                        })
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

        ClientMsg::BlobTicket { rid, id } => {
            Some(ServerMsg::BlobTicket { rid, ticket: app.blob_tickets.mint(&id) })
        }

        ClientMsg::Welcome { rid, to, group, after, payload } => {
            if let Err(e) = require_member(app, &group, user).await {
                return err(rid, e);
            }
            // `to` was unconstrained, so a member could park stored Welcomes
            // on — and push-spam — any handle at all. A Welcome is only
            // meaningful for someone being admitted, i.e. already on the
            // group's ACL via the add that precedes it.
            if let Err(e) = require_member(app, &group, &to).await {
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
            let delivered = hub.online.get(&to).is_some_and(|ch| ch.offer(out.clone()));
            if delivered {
                app.metrics.welcomes_delivered.inc();
            } else {
                app.metrics.welcomes_queued.inc();
            }
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
            match app.store.redeem_invite(&invite, user, now_unix()).await {
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

        ClientMsg::Ephemeral { rid, group, payload, notify, notify_kind } => {
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
                    let kept = ch.offer(out.clone());
                    if !kept {
                        app.metrics.subscribers_dropped.inc();
                    }
                    kept
                });
            }
            // Call nudge: an ephemeral reaches only live subscribers, so a
            // ring to a closed app would otherwise vanish. The sender may
            // name members to push-wake; only actual group members that did
            // not get the blob live are pushed. The payload stays opaque —
            // the push carries the group id (which the relay knows anyway)
            // and the fact that *something* wants attention now.
            let targets: Vec<String> = match notify {
                Some(names) if !names.is_empty() => {
                    let subscribed: HashSet<String> = hub
                        .subscribers
                        .get(&group)
                        .map(|s| s.keys().cloned().collect())
                        .unwrap_or_default();
                    drop(hub);
                    match app.store.group_members(&group).await {
                        Ok(members) => {
                            let roster: HashSet<String> =
                                members.into_iter().map(|(m, _)| m).collect();
                            names
                                .into_iter()
                                .filter(|n| {
                                    n != user && roster.contains(n) && !subscribed.contains(n)
                                })
                                .take(64)
                                .collect()
                        }
                        Err(_) => Vec::new(),
                    }
                }
                _ => Vec::new(),
            };
            if !targets.is_empty() {
                // The push's JSON key is its kind, which the service worker
                // turns into the right text. Allowlisted so a client can't
                // inject arbitrary keys; unknown/absent falls back to "call".
                let kind: &str = match notify_kind.as_deref() {
                    Some("rally") => "rally",
                    _ => "call",
                };
                let app = app.clone();
                let group = group.clone();
                tokio::spawn(async move {
                    for member in targets {
                        let mut payload = serde_json::Map::new();
                        payload.insert(kind.to_string(), serde_json::Value::String(group.clone()));
                        app.push_notify(&member, serde_json::Value::Object(payload)).await;
                    }
                });
            }
            Some(ServerMsg::Ok { rid, seq: None })
        }

        ClientMsg::HistoryAppend { rid, group, hid, ts, expires_at, payload } => {
            if let Err(e) = require_member(app, &group, user).await {
                return err(rid, e);
            }
            let payload = match decode_b64(&payload) {
                Ok(b) => b,
                Err(e) => return err(rid, e),
            };
            match app.store.append_history(&group, &hid, user, ts, expires_at, payload).await {
                Ok(seq) => Some(ServerMsg::Ok { rid, seq: Some(seq) }),
                Err(e) => err(rid, e),
            }
        }

        ClientMsg::HistoryFetch { rid, group, hid, after, before, limit } => {
            if let Err(e) = require_member(app, &group, user).await {
                return err(rid, e);
            }
            // Clamped, not trusted: the log is unbounded and a client asking
            // for all of it would pin a page of memory per request.
            let limit = limit
                .unwrap_or(crate::proto::HISTORY_PAGE_DEFAULT)
                .clamp(1, crate::proto::HISTORY_PAGE_MAX);
            let page = match before {
                // Clamped to what a signed 64-bit column can hold: a client
                // saying "before the end of the log" naturally sends a very
                // large number, and Postgres compares against a bigint.
                Some(before) => crate::store::HistoryPage::Before {
                    before: before.min(i64::MAX as u64),
                    limit,
                },
                None => crate::store::HistoryPage::After {
                    after: after.min(i64::MAX as u64),
                    limit,
                },
            };
            match app.store.history_page(&group, &hid, page, now_unix()).await {
                Ok((entries, complete)) => Some(ServerMsg::History {
                    rid,
                    hid,
                    entries: entries
                        .into_iter()
                        .map(|e| crate::proto::HistoryEntryOut {
                            seq: e.seq,
                            ts: e.ts,
                            payload: B64.encode(&e.payload),
                        })
                        .collect(),
                    complete,
                }),
                Err(e) => err(rid, e),
            }
        }

        ClientMsg::HistoryRedact { rid, group, hid, seq } => {
            if let Err(e) = require_member(app, &group, user).await {
                return err(rid, e);
            }
            // An admin may redact anything in their circle; anyone else only
            // what they wrote. `redact_history` decides both inside one
            // predicate, and answers "not yours" exactly like "not there".
            let admin = require_admin(app, &group, user).await.is_ok();
            match app.store.redact_history(&group, &hid, seq, user, admin).await {
                Ok(_) => Some(ServerMsg::Ok { rid, seq: None }),
                Err(e) => err(rid, e),
            }
        }

        ClientMsg::HistoryCounts { rid, group, logs } => {
            if let Err(e) = require_member(app, &group, user).await {
                return err(rid, e);
            }
            let now = now_unix();
            let mut counts = Vec::with_capacity(logs.len());
            for cursor in logs.into_iter().take(crate::proto::HISTORY_PAGE_MAX as usize) {
                match app
                    .store
                    .history_count(&group, &cursor.hid, cursor.after_ts, user, now)
                    .await
                {
                    Ok(n) => counts.push(crate::proto::HistoryCountOut { hid: cursor.hid, n }),
                    Err(e) => return err(rid, e),
                }
            }
            Some(ServerMsg::HistoryCount { rid, counts })
        }

        ClientMsg::HistoryPrune { rid, group, hid, before_ts } => {
            if let Err(e) = require_admin(app, &group, user).await {
                return err(rid, e);
            }
            match app.store.prune_history(&group, &hid, before_ts).await {
                Ok(()) => Some(ServerMsg::Ok { rid, seq: None }),
                Err(e) => err(rid, e),
            }
        }

        ClientMsg::BackupSet { rid, payload, version } => {
            let payload = match decode_b64(&payload) {
                Ok(b) => b,
                Err(e) => return err(rid, e),
            };
            // Version 0 and "absent" mean the same thing on the wire — no
            // blob parked — so both map to `None`, and the store's insert
            // branch is the one that has to fire.
            let expected = version.filter(|v| *v > 0);
            match app.store.set_backup(user, payload, expected).await {
                Ok(version) => Some(ServerMsg::BackupOk { rid, version }),
                Err(e) => err(rid, e),
            }
        }

        ClientMsg::BackupGet { rid } => match app.store.get_backup(user).await {
            Ok(parked) => Some(ServerMsg::Backup {
                rid,
                payload: parked.as_ref().map(|(b, _)| B64.encode(b)),
                version: parked.map(|(_, v)| v).unwrap_or(0),
            }),
            Err(e) => err(rid, e),
        },

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

        ClientMsg::PasskeyWrapAdd { rid, cred_id, credential, salt, wrapped, label } => {
            let (Ok(salt), Ok(wrapped)) = (decode_b64(&salt), decode_b64(&wrapped)) else {
                return err(rid, "invalid base64");
            };
            let wrap = crate::store::PasskeyWrap {
                user: user.to_string(),
                credential,
                salt,
                wrapped,
                // Bounded here rather than trusted: it is stored per account
                // and rendered back into a security screen.
                label: label.unwrap_or_default().chars().take(MAX_DEVICE_LABEL).collect(),
                // Server clock, not the client's. This timestamp is what a
                // user reads when choosing which device to revoke, so a
                // device must not get to claim it is the older one.
                created_at: now_unix() as i64,
            };
            match app.store.add_passkey_wrap(&cred_id, wrap).await {
                Ok(()) => Some(ServerMsg::Ok { rid, seq: None }),
                Err(e) => err(rid, e),
            }
        }

        ClientMsg::PasskeyWrapList { rid } => match app.store.list_passkey_wraps(user).await {
            Ok(devices) => Some(ServerMsg::PasskeyDevices {
                rid,
                devices: devices
                    .into_iter()
                    .map(|d| PasskeyDeviceOut {
                        cred_id: d.cred_id,
                        label: d.label,
                        created_at: d.created_at,
                    })
                    .collect(),
            }),
            Err(e) => err(rid, e),
        },

        ClientMsg::PasskeyWrapDel { rid, cred_id } => {
            // `user` here is the authenticated session, so the delete is
            // scoped to the caller's own account by construction. A missing
            // row and someone else's row are answered identically on
            // purpose: distinguishing them would turn this into an oracle
            // for whether a given credential id is enrolled elsewhere.
            match app.store.delete_passkey_wrap(&cred_id, user).await {
                Ok(true) => {
                    tracing::info!(%user, %cred_id, "revoked a device passkey");
                    Some(ServerMsg::Ok { rid, seq: None })
                }
                Ok(false) => err(rid, "no such device"),
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
mod outbound_tests {
    use super::{Outbound, MAX_QUEUE};
    use crate::proto::ServerMsg;

    fn msg(seq: u64) -> ServerMsg {
        ServerMsg::Ok { rid: seq, seq: Some(seq) }
    }

    #[test]
    fn fan_out_stops_at_the_cap() {
        // The bug this closes: a suspended laptop in a busy circle grew its
        // outbound queue without limit, on the server's heap.
        let (tx, _rx, _depth) = Outbound::new();
        for i in 0..MAX_QUEUE {
            assert!(tx.offer(msg(i as u64)), "queue should accept up to the cap");
        }
        assert!(!tx.offer(msg(9999)), "past the cap the subscriber is refused, not queued");
    }

    #[test]
    fn backfill_is_never_refused() {
        // Catch-up must not be truncated: the client asked for it, it has no
        // way to notice a gap, and dropping it is silent data loss.
        let (tx, _rx, _depth) = Outbound::new();
        for i in 0..(MAX_QUEUE * 2) {
            assert!(tx.send(msg(i as u64)), "send() has no cap by design");
        }
    }

    #[tokio::test]
    async fn draining_makes_room_again() {
        // The depth has to fall as the writer consumes, or one burst strands
        // a healthy connection at the cap forever.
        let (tx, mut rx, depth) = Outbound::new();
        for i in 0..MAX_QUEUE {
            assert!(tx.offer(msg(i as u64)));
        }
        assert!(!tx.offer(msg(1)));

        // Mirror what the writer task does on each recv.
        rx.recv().await.unwrap();
        depth.fetch_sub(1, std::sync::atomic::Ordering::Relaxed);

        assert!(tx.offer(msg(2)), "one slot freed is one slot available");
    }

    #[test]
    fn a_closed_connection_is_refused_by_both_paths() {
        let (tx, rx, _depth) = Outbound::new();
        drop(rx);
        assert!(!tx.send(msg(1)));
        assert!(!tx.offer(msg(2)));
    }

    #[test]
    fn clones_share_one_queue() {
        // The hub holds a clone per subscription; two subscriptions of the
        // same connection must not each get their own budget.
        let (tx, _rx, _depth) = Outbound::new();
        let clone = tx.clone();
        for i in 0..MAX_QUEUE {
            assert!(tx.offer(msg(i as u64)));
        }
        assert!(!clone.offer(msg(1)), "the cap is per connection, not per subscription");
        assert!(tx.same_channel(&clone));
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

