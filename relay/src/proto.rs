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
        /// Client wire-protocol version. Optional so an older client still
        /// parses. Not enforced — it is here so that a skew between a cached
        /// client and an upgraded relay is diagnosable rather than showing up
        /// as arbitrary downstream failures. The handshake previously carried
        /// no version at all.
        #[serde(default)]
        v: Option<u32>,
    },
    /// Signature over `AUTH_CONTEXT || nonce || u32be(len(user)) || user`.
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
    /// Remove `user` from `group`'s server-side ACL (the roster the relay
    /// serves). Group admins may remove anyone; any member may remove
    /// themselves (leaving). The last admin cannot be removed. The
    /// cryptographic removal is the MLS commit the client sends alongside —
    /// this just stops the relay listing/serving them.
    Disallow { rid: u64, group: String, user: String },
    /// Tear a group down: purge its log, roster, history, and invites. Group
    /// admins only. The MLS side (removing every member) is the client's job;
    /// this reclaims the relay's storage.
    DeleteGroup { rid: u64, group: String },
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
    /// `commit` marks a payload that advances the MLS epoch. The relay
    /// compare-and-swaps on it so exactly one commit per epoch is accepted;
    /// see `Store::append_message`. It leaks nothing new — every Send
    /// already carries `epoch`, so a commit was always the message that
    /// bumped it.
    Send {
        rid: u64,
        group: String,
        epoch: u64,
        payload: String,
        #[serde(default)] commit: bool,
    },
    /// Mint a single-use, short-lived ticket authorizing ONE upload to
    /// `/blobs/{id}`. Blob writes have no other authentication — the id is
    /// a capability for *reading*, which says nothing about who may write —
    /// so without this any stranger could fill the relay's disk.
    BlobTicket { rid: u64, id: String },
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
    /// blob itself stays opaque. `notify_kind` (optional) picks the label
    /// of that push — "call" (default) or "rally" — so a closed app shows
    /// the right text; it says nothing more about the opaque blob.
    Ephemeral {
        rid: u64,
        group: String,
        payload: String,
        #[serde(default)]
        notify: Option<Vec<String>>,
        #[serde(default)]
        notify_kind: Option<String>,
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
    /// A page of the channel log for `hid`, expired entries excluded.
    /// Members only.
    ///
    /// Two directions, because the log is now the whole conversation
    /// rather than a backfill of one:
    ///   - `before: None`  — the oldest `limit` entries with seq > `after`.
    ///     Forward catch-up from a cursor.
    ///   - `before: Some(b)` — the newest `limit` entries with seq < `b`.
    ///     Opening a channel (`b` = u64::MAX) and paging back through it.
    /// `limit` is clamped server-side; see `HISTORY_PAGE_MAX`.
    HistoryFetch {
        rid: u64,
        group: String,
        hid: String,
        after: u64,
        #[serde(default)]
        before: Option<u64>,
        #[serde(default)]
        limit: Option<u32>,
    },
    /// Delete one entry the caller wrote. Unlike `del` inside the log —
    /// which is a tombstone every reader folds away — this removes the
    /// ciphertext, so a member who joins later cannot read the original
    /// with the room key. The relay authorizes it against the author it
    /// recorded at append time: the entry's writer, or a group admin.
    HistoryRedact { rid: u64, group: String, hid: String, seq: u64 },
    /// How many entries each log has gained since a timestamp, excluding
    /// the caller's own. Members only.
    ///
    /// This is what makes unread counts possible without a local copy of
    /// every message: the relay already knows how many entries a log holds
    /// and when they landed, so counting them leaks nothing it cannot
    /// already see — and the alternative is every client downloading and
    /// decrypting every channel on every boot just to render a badge.
    HistoryCounts { rid: u64, group: String, logs: Vec<HistoryCursor> },
    /// Delete history entries with ts < `before_ts` (retention shrank, or
    /// history was turned off). Group admins only. Server-enforced — i.e.
    /// weak: a malicious relay can keep the ciphertext, it just can't
    /// read it.
    HistoryPrune { rid: u64, group: String, hid: String, before_ts: u64 },
    /// Store/replace this user's client-side-encrypted circles backup
    /// (group records + channel room keys, sealed under a key derived
    /// from the identity key — the relay stores a blob it cannot read).
    ///
    /// `version` is the one the writer last read; the store swaps on it and
    /// refuses a stale write, so a second signed-in device cannot silently
    /// overwrite a circle this one just joined. Absent means "I believe
    /// nothing is parked" — an older client that never reads a version
    /// therefore only succeeds against an empty slot, which is the safe
    /// direction for it to fail.
    BackupSet { rid: u64, payload: String, #[serde(default)] version: Option<i64> },
    /// Retrieve the backup blob and its version, if any.
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
    /// Enroll an ADDITIONAL passkey (this device) that can unlock the same
    /// identity, without disturbing the primary vault or other devices.
    /// `wrapped` is the identity sealed under this passkey's PRF secret; the
    /// relay stores it keyed by credential id. Authenticated users only.
    PasskeyWrapAdd {
        rid: u64,
        cred_id: String,
        credential: String,
        salt: String,
        wrapped: String,
        /// Human name for the device. Optional so an older client still
        /// enrolls; absent becomes "" and the UI falls back to the date.
        #[serde(default)]
        label: Option<String>,
    },
    /// This account's enrolled devices. Metadata only — never the wraps.
    PasskeyWrapList { rid: u64 },
    /// Revoke one enrolled device, by credential id.
    ///
    /// Forward-only, and the client says so in as many words: it stops that
    /// passkey unlocking the identity from here on. It cannot reach into a
    /// device that already holds the identity locally. What it does defeat is
    /// the case that matters for a *synced* passkey — iCloud Keychain, Google
    /// Password Manager — where the credential outlives the hardware and
    /// would otherwise keep pulling the identity down forever.
    PasskeyWrapDel { rid: u64, cred_id: String },
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
    /// A consumed KeyPackage for `user`, plus the signature key this relay
    /// has pinned for that handle. The adder checks the KeyPackage's
    /// credential and signature key against `user`/`pubkey` before adding —
    /// otherwise a relay could answer with a KeyPackage it minted itself and
    /// join the group. Optional only so an older relay stays parseable; a
    /// client that gets no `pubkey` refuses the add.
    Kp {
        rid: u64,
        user: String,
        #[serde(skip_serializing_if = "Option::is_none")] payload: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")] pubkey: Option<String>,
    },
    Msg { group: String, seq: u64, epoch: u64, sender: String, payload: String },
    Welcome { from: String, group: String, after: u64, payload: String },
    Invite { rid: u64, group: String, payload: String },
    PushInfo { rid: u64, pubkey: String },
    /// Bearer token for one PUT to the id it was minted for.
    BlobTicket { rid: u64, ticket: String },
    /// JSON passthrough: an array of RTCIceServer objects for the client to
    /// feed straight into `RTCPeerConnection({ iceServers })`.
    IceInfo { rid: u64, servers: String },
    Eph { group: String, sender: String, payload: String },
    /// `complete` is true when this page reached the start of the log, so
    /// the client can stop offering "load older" instead of guessing from
    /// a short page.
    History { rid: u64, hid: String, entries: Vec<HistoryEntryOut>, complete: bool },
    HistoryCount { rid: u64, counts: Vec<HistoryCountOut> },
    /// The parked blob and the version it is at. `version` is 0 when
    /// nothing is parked, which is exactly what the client should then send
    /// back on its first `BackupSet`.
    Backup {
        rid: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        payload: Option<String>,
        version: i64,
    },
    /// A backup write landed; `version` is what the next one must carry.
    BackupOk { rid: u64, version: i64 },
    VaultStatus { rid: u64, kind: Option<String> },
    /// WebAuthn ceremony payloads (JSON passthrough).
    Passkey { rid: u64, payload: String },
    /// The caller's enrolled devices, newest first.
    PasskeyDevices { rid: u64, devices: Vec<PasskeyDeviceOut> },
}

/// One enrolled device as it goes over the wire. `wrapped` and `credential`
/// are absent by construction, not by omission — see `store::PasskeyDevice`.
#[derive(Debug, Clone, Serialize)]
pub struct PasskeyDeviceOut {
    pub cred_id: String,
    pub label: String,
    /// Unix seconds.
    pub created_at: i64,
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

/// One log's "what have I missed" cursor, in a `HistoryCounts` request.
#[derive(Debug, Clone, Deserialize)]
pub struct HistoryCursor {
    pub hid: String,
    pub after_ts: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct HistoryCountOut {
    pub hid: String,
    pub n: u64,
}

/// Largest page `HistoryFetch` will return, however much is asked for.
/// A channel's log is unbounded; a client that opens a two-year-old room
/// must not pull all of it into memory to render the last screen.
pub const HISTORY_PAGE_MAX: u32 = 200;
/// Page size when a client asks for none.
pub const HISTORY_PAGE_DEFAULT: u32 = 50;

/// Domain separator for the connection challenge. v2 binds the handle into
/// the signed bytes: v1 signed only `context || nonce`, so a signature
/// captured for one identity was a valid proof for any other, and a hostile
/// relay could forward the real relay's nonce and replay the answer.
pub const AUTH_CONTEXT: &[u8] = b"relay-auth-v2";

/// Wire protocol version this relay speaks. See `ClientMsg::Hello::v`.
pub const PROTOCOL_VERSION: u32 = 1;
