//! Wire protocol: JSON over WebSocket text frames. All MLS payloads are
//! opaque base64 — the relay parses envelopes, never contents. `rid` is a
//! client-chosen correlation id echoed back on the ack.

use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum ClientMsg {
    /// First message on the socket. New users are registered on first
    /// successful challenge signature (trust-on-first-use); returning
    /// users must sign with their pinned key.
    Hello { user: String, pubkey: String },
    /// Signature over `b"relay-auth-v1" || nonce`.
    Auth { sig: String },
    /// Pre-publish KeyPackages so members can be added while offline.
    PublishKp { rid: u64, payloads: Vec<String> },
    /// Consume one of `user`'s KeyPackages.
    FetchKp { rid: u64, user: String },
    CreateGroup { rid: u64, group: String },
    /// Allow `user` to subscribe/send on `group` (server-side ACL only —
    /// the cryptographic boundary is MLS membership, not this list).
    Allow { rid: u64, group: String, user: String },
    /// Join the live fan-out and receive the log after seq `after`.
    Subscribe { rid: u64, group: String, after: u64 },
    /// Append an opaque blob to the group log. `epoch` is client-declared
    /// metadata (the server cannot verify it) used for keying and later
    /// retention policies.
    Send { rid: u64, group: String, epoch: u64, payload: String },
    /// Deliver a Welcome directly to `to` (stored if offline). `group` and
    /// `after` tell the joiner where their log begins.
    Welcome { rid: u64, to: String, group: String, after: u64, payload: String },
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum ServerMsg {
    Challenge { nonce: String },
    Ready { user: String },
    Ok { rid: u64, #[serde(skip_serializing_if = "Option::is_none")] seq: Option<u64> },
    Error { #[serde(skip_serializing_if = "Option::is_none")] rid: Option<u64>, message: String },
    Kp { rid: u64, user: String, #[serde(skip_serializing_if = "Option::is_none")] payload: Option<String> },
    Msg { group: String, seq: u64, epoch: u64, sender: String, payload: String },
    Welcome { from: String, group: String, after: u64, payload: String },
}

pub const AUTH_CONTEXT: &[u8] = b"relay-auth-v1";
