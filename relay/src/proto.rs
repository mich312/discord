//! Wire protocol: JSON over WebSocket text frames. All MLS payloads are
//! opaque base64 — the relay parses envelopes, never contents. `rid` is a
//! client-chosen correlation id echoed back on the ack.

use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum ClientMsg {
    /// First message on the socket. New users are registered on first
    /// successful challenge signature (trust-on-first-use); returning
    /// users must sign with their pinned key. Unless the relay runs with
    /// OPEN_REGISTRATION, first-time registration requires `invite` to be
    /// a currently-usable invite id (the platform is invite-only; the
    /// very first user bootstraps without one).
    Hello {
        user: String,
        pubkey: String,
        #[serde(default)]
        invite: Option<String>,
    },
    /// Signature over `b"relay-auth-v1" || nonce`.
    Auth { sig: String },
    /// Pre-publish KeyPackages so members can be added while offline.
    PublishKp { rid: u64, payloads: Vec<String> },
    /// Consume one of `user`'s KeyPackages.
    FetchKp { rid: u64, user: String },
    CreateGroup { rid: u64, group: String },
    /// Allow `user` to subscribe/send on `group` (server-side ACL only —
    /// the cryptographic boundary is MLS membership, not this list).
    /// Group admins only.
    Allow { rid: u64, group: String, user: String },
    /// Promote/demote a member ("admin" | "member"). Group admins only;
    /// the last admin of a group cannot be demoted.
    SetRole { rid: u64, group: String, user: String, role: String },
    /// The group's roster with roles. Members (or a global admin).
    Members { rid: u64, group: String },
    /// Global admins only: every registered user and every group the relay
    /// knows about. Metadata only — the relay has nothing else to show.
    AdminList { rid: u64 },
    /// Join the live fan-out and receive the log after seq `after`.
    Subscribe { rid: u64, group: String, after: u64 },
    /// Append an opaque blob to the group log. `epoch` is client-declared
    /// metadata (the server cannot verify it) used for keying and later
    /// retention policies.
    Send { rid: u64, group: String, epoch: u64, payload: String },
    /// Deliver a Welcome directly to `to` (stored if offline). `group` and
    /// `after` tell the joiner where their log begins.
    Welcome { rid: u64, to: String, group: String, after: u64, payload: String },
    /// Park an encrypted GroupInfo blob under an opaque invite id. Members
    /// only. `expires_at` (unix secs) / `max_uses` are server-enforced —
    /// weak controls; MLS membership stays the real boundary.
    CreateInvite {
        rid: u64,
        invite: String,
        group: String,
        payload: String,
        expires_at: Option<u64>,
        max_uses: Option<u64>,
    },
    /// Swap in a fresh epoch's blob (same invite id, same fragment key).
    UpdateInvite { rid: u64, invite: String, payload: String },
    RevokeInvite { rid: u64, invite: String },
    /// Redeem: returns the blob and grants the caller ACL membership so
    /// they can publish their external commit and subscribe.
    RedeemInvite { rid: u64, invite: String },
    /// Fan an opaque blob to the group's current subscribers WITHOUT
    /// appending it to the log. Carries WebRTC signaling and voice
    /// presence (MLS-encrypted like everything else) — transient by
    /// nature, so replaying it on catch-up would only confuse clients.
    /// `notify` (optional) names group members to push-wake if they are
    /// not live-subscribed — how a call ring reaches a closed app. It
    /// reveals to the relay only that these members should look now; the
    /// blob itself stays opaque.
    Ephemeral {
        rid: u64,
        group: String,
        payload: String,
        #[serde(default)]
        notify: Option<Vec<String>>,
    },
    /// Append an opaque blob to a channel history log. `hid` is a
    /// client-chosen opaque id (the relay never learns which channel it
    /// is); the payload is AES-GCM ciphertext under a key that travels
    /// only inside the group's MLS messages. `ts` orders entries and
    /// anchors retention; `expires_at` (unix secs) is honored server-side.
    /// Members only.
    HistoryAppend {
        rid: u64,
        group: String,
        hid: String,
        ts: u64,
        expires_at: Option<u64>,
        payload: String,
    },
    /// The history log for `hid` after seq `after`, expired entries
    /// excluded. Members only.
    HistoryFetch { rid: u64, group: String, hid: String, after: u64 },
    /// Delete history entries with ts < `before_ts` (retention shrank, or
    /// history was turned off). Group admins only. Server-enforced — i.e.
    /// weak: a malicious relay can keep the ciphertext, it just can't
    /// read it.
    HistoryPrune { rid: u64, group: String, hid: String, before_ts: u64 },
    /// Store/replace this user's client-side-encrypted circles backup
    /// (group records + channel history keys, sealed under a key derived
    /// from the identity key — the relay stores a blob it cannot read).
    BackupSet { rid: u64, payload: String },
    /// Retrieve the backup blob, if any.
    BackupGet { rid: u64 },
    /// Store/replace this user's account vault (client-side-encrypted
    /// identity bundle + retrieval gate). Authenticated users only.
    VaultSet {
        rid: u64,
        kind: String,
        salt: String,
        verifier: String,
        wrapped: String,
        credential: Option<String>,
    },
    /// Is this account secured, and how?
    VaultStatus { rid: u64 },
    /// WebAuthn registration ceremony (authenticated side).
    PasskeyRegisterStart { rid: u64 },
    PasskeyRegisterFinish { rid: u64, credential: String },
    /// The server's VAPID public key (browser `applicationServerKey`).
    PushInfo { rid: u64 },
    /// Store a PushSubscription (its JSON serialization) for this user.
    PushSubscribe { rid: u64, subscription: String },
    /// The ICE servers (STUN/TURN) to use for voice — operator-configured on
    /// the relay so a self-hoster can point every client at their own TURN
    /// without a client rebuild. Not secret; media itself stays P2P/E2EE.
    IceInfo { rid: u64 },
    /// Liveness probe. Browsers can't send WebSocket protocol pings, so the
    /// client heartbeats with this to detect a half-open socket (a send that
    /// never acks) and reconnect instead of staying silently deaf.
    Ping { rid: u64 },
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum ServerMsg {
    Challenge { nonce: String },
    Ready { user: String, global_admin: bool },
    Members { rid: u64, group: String, members: Vec<MemberEntry> },
    AdminList { rid: u64, users: Vec<String>, groups: Vec<GroupEntry> },
    Ok { rid: u64, #[serde(skip_serializing_if = "Option::is_none")] seq: Option<u64> },
    Error { #[serde(skip_serializing_if = "Option::is_none")] rid: Option<u64>, message: String },
    Kp { rid: u64, user: String, #[serde(skip_serializing_if = "Option::is_none")] payload: Option<String> },
    Msg { group: String, seq: u64, epoch: u64, sender: String, payload: String },
    Welcome { from: String, group: String, after: u64, payload: String },
    Invite { rid: u64, group: String, payload: String },
    PushInfo { rid: u64, pubkey: String },
    /// JSON passthrough: an array of RTCIceServer objects for the client to
    /// feed straight into `RTCPeerConnection({ iceServers })`.
    IceInfo { rid: u64, servers: String },
    Eph { group: String, sender: String, payload: String },
    History { rid: u64, hid: String, entries: Vec<HistoryEntryOut> },
    Backup { rid: u64, #[serde(skip_serializing_if = "Option::is_none")] payload: Option<String> },
    VaultStatus { rid: u64, kind: Option<String> },
    /// WebAuthn ceremony payloads (JSON passthrough).
    Passkey { rid: u64, payload: String },
}

#[derive(Debug, Clone, Serialize)]
pub struct MemberEntry {
    pub user: String,
    pub role: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct GroupEntry {
    pub group: String,
    pub created_by: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct HistoryEntryOut {
    pub seq: u64,
    pub ts: u64,
    pub payload: String,
}

pub const AUTH_CONTEXT: &[u8] = b"relay-auth-v1";
