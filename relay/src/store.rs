//! Storage behind the relay: everything it persists is either public key
//! material (KeyPackages are meant to be handed out) or ciphertext.
//! `MemoryStore` backs tests and zero-config runs; `PgStore` (pg.rs) is
//! the real deployment target.

use async_trait::async_trait;
use std::collections::HashMap;
use std::sync::Mutex;

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("group already exists")]
    GroupExists,
    #[error("no such group")]
    NoSuchGroup,
    #[error("invite not valid (missing, expired, or used up)")]
    InviteInvalid,
    #[error("storage error: {0}")]
    Backend(String),
}

/// Server-side invite record: an opaque encrypted GroupInfo blob plus the
/// weak (server-enforced) controls. The server cannot read the blob — the
/// decryption key lives in the invite URL's fragment and never arrives here.
#[derive(Debug, Clone)]
pub struct InviteRecord {
    pub group: String,
    pub payload: Vec<u8>,
    /// Unix seconds; None = no expiry.
    pub expires_at: Option<u64>,
    pub max_uses: Option<u64>,
    pub uses: u64,
}

/// Account vault: the user's identity bundle, encrypted client-side under
/// a key the server never sees (Argon2id wrap half, or a passkey's PRF
/// output). `verifier` gates blob retrieval for the password kind; the
/// passkey kind gates on a WebAuthn assertion against `credential`.
#[derive(Debug, Clone)]
pub struct VaultRecord {
    /// "password" | "passkey"
    pub kind: String,
    pub salt: Vec<u8>,
    /// SHA-256 of the client's auth key (password kind; empty otherwise).
    pub verifier: Vec<u8>,
    /// The encrypted identity bundle. Opaque.
    pub wrapped: Vec<u8>,
    /// Serialized webauthn credential (passkey kind).
    pub credential: Option<String>,
}

/// The two membership roles. Admins manage the (weak, server-side) ACL:
/// allowing members, invites, and role changes. The group's creator starts
/// as its admin.
pub const ROLE_ADMIN: &str = "admin";
pub const ROLE_MEMBER: &str = "member";

#[derive(Debug, Clone, PartialEq)]
pub enum RegisterOutcome {
    /// User was unknown; this pubkey is now pinned.
    Registered,
    /// User exists; caller must verify against this pinned pubkey.
    Existing(Vec<u8>),
}

#[derive(Debug, Clone)]
pub struct StoredMessage {
    pub group: String,
    pub seq: u64,
    pub epoch: u64,
    pub sender: String,
    pub payload: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct StoredWelcome {
    pub from: String,
    pub group: String,
    pub after: u64,
    pub payload: Vec<u8>,
}

/// One entry in a channel history log. The relay sees an opaque log id
/// (`hid` — it cannot tell which channel it is) and AES-GCM ciphertext
/// under a key that only ever travels inside the group's MLS messages.
/// `ts`/`expires_at` are client-declared: they order entries and drive
/// server-side retention, nothing more.
#[derive(Debug, Clone)]
pub struct HistoryEntry {
    pub seq: u64,
    pub ts: u64,
    pub expires_at: Option<u64>,
    pub payload: Vec<u8>,
}

#[async_trait]
pub trait Store: Send + Sync {
    /// Pin `pubkey` for `user` if unknown, else return the pinned key.
    async fn register_user(&self, user: &str, pubkey: &[u8]) -> Result<RegisterOutcome, StoreError>;
    /// The pinned pubkey for `user`, if registered.
    async fn get_user_pubkey(&self, user: &str) -> Result<Option<Vec<u8>>, StoreError>;
    /// How many users are registered (0 = fresh relay: the next
    /// registration is the bootstrap user and bypasses the invite gate).
    async fn user_count(&self) -> Result<u64, StoreError>;
    async fn publish_key_packages(&self, user: &str, payloads: Vec<Vec<u8>>) -> Result<(), StoreError>;
    /// Consume (remove and return) one KeyPackage for `user`.
    async fn take_key_package(&self, user: &str) -> Result<Option<Vec<u8>>, StoreError>;
    /// Create the group; the creator becomes its first admin.
    async fn create_group(&self, group: &str, creator: &str) -> Result<(), StoreError>;
    /// Add `user` as a plain member; keeps the existing role if already in.
    async fn allow_member(&self, group: &str, user: &str) -> Result<(), StoreError>;
    /// Remove `user` from the group's ACL. No-op if they were not a member.
    async fn disallow_member(&self, group: &str, user: &str) -> Result<(), StoreError>;
    /// Purge a group entirely: roster, log, history, invites, welcomes.
    async fn delete_group(&self, group: &str) -> Result<(), StoreError>;
    async fn is_member(&self, group: &str, user: &str) -> Result<bool, StoreError>;
    /// `user`'s role in `group`, or None if not a member.
    async fn member_role(&self, group: &str, user: &str) -> Result<Option<String>, StoreError>;
    async fn set_member_role(&self, group: &str, user: &str, role: &str) -> Result<(), StoreError>;
    /// All members as (user, role) pairs.
    async fn group_members(&self, group: &str) -> Result<Vec<(String, String)>, StoreError>;
    async fn list_users(&self) -> Result<Vec<String>, StoreError>;
    /// All groups as (group_id, created_by) pairs.
    async fn list_groups(&self) -> Result<Vec<(String, String)>, StoreError>;
    /// Append to the group's ordered log; returns the assigned seq (1-based).
    async fn append_message(
        &self,
        group: &str,
        epoch: u64,
        sender: &str,
        payload: Vec<u8>,
    ) -> Result<u64, StoreError>;
    async fn messages_after(&self, group: &str, after: u64) -> Result<Vec<StoredMessage>, StoreError>;
    async fn store_welcome(&self, to: &str, welcome: StoredWelcome) -> Result<(), StoreError>;
    /// Remove and return all Welcomes queued for `to`.
    async fn take_welcomes(&self, to: &str) -> Result<Vec<StoredWelcome>, StoreError>;

    // --- channel history logs ---
    /// Append to the history log `hid` of `group`; returns the assigned
    /// seq (1-based, per (group, hid)).
    async fn append_history(
        &self,
        group: &str,
        hid: &str,
        ts: u64,
        expires_at: Option<u64>,
        payload: Vec<u8>,
    ) -> Result<u64, StoreError>;
    /// Entries after `after`, excluding ones expired at `now`.
    async fn history_after(
        &self,
        group: &str,
        hid: &str,
        after: u64,
        now: u64,
    ) -> Result<Vec<HistoryEntry>, StoreError>;
    /// Drop entries with ts < `before_ts` (retention shrank / history off).
    async fn prune_history(&self, group: &str, hid: &str, before_ts: u64) -> Result<(), StoreError>;

    // --- encrypted circles backups ---
    async fn set_backup(&self, user: &str, payload: Vec<u8>) -> Result<(), StoreError>;
    async fn get_backup(&self, user: &str) -> Result<Option<Vec<u8>>, StoreError>;

    // --- account vaults ---
    async fn set_vault(&self, user: &str, vault: VaultRecord) -> Result<(), StoreError>;
    async fn get_vault(&self, user: &str) -> Result<Option<VaultRecord>, StoreError>;
    /// Every passkey-kind vault as (user, record). Usernameless sign-in scans
    /// these to match an assertion's credential id to an account. Groups here
    /// are tiny (invite-only), so a scan is cheaper than a second index.
    async fn list_passkey_vaults(&self) -> Result<Vec<(String, VaultRecord)>, StoreError>;

    // --- push subscriptions ---
    async fn put_push_subscription(
        &self,
        user: &str,
        endpoint: &str,
        subscription_json: &str,
    ) -> Result<(), StoreError>;
    async fn push_subscriptions_for(&self, user: &str) -> Result<Vec<(String, String)>, StoreError>;
    async fn delete_push_subscription(&self, user: &str, endpoint: &str) -> Result<(), StoreError>;

    // --- invites ---
    async fn create_invite(&self, invite: &str, record: InviteRecord) -> Result<(), StoreError>;
    /// Which group an invite belongs to (for authorization), if it exists.
    async fn invite_group(&self, invite: &str) -> Result<Option<String>, StoreError>;
    /// Replace the blob (fresh epoch's GroupInfo under the same link key).
    async fn update_invite(&self, invite: &str, payload: Vec<u8>) -> Result<(), StoreError>;
    async fn revoke_invite(&self, invite: &str) -> Result<(), StoreError>;
    /// Validate expiry/uses at `now`, count a use, return (group, payload).
    async fn redeem_invite(&self, invite: &str, now: u64) -> Result<(String, Vec<u8>), StoreError>;
    /// Would `invite` be redeemable at `now`? Does NOT count a use — the
    /// registration gate checks this; the use is only spent on redeem.
    async fn invite_usable(&self, invite: &str, now: u64) -> Result<bool, StoreError>;
}

#[derive(Default)]
struct MemoryInner {
    users: HashMap<String, Vec<u8>>,
    key_packages: HashMap<String, Vec<Vec<u8>>>,
    groups: HashMap<String, GroupData>,
    welcomes: HashMap<String, Vec<StoredWelcome>>,
    invites: HashMap<String, InviteRecord>,
    /// user -> endpoint -> subscription json
    push_subs: HashMap<String, HashMap<String, String>>,
    vaults: HashMap<String, VaultRecord>,
    backups: HashMap<String, Vec<u8>>,
}

#[derive(Default)]
struct GroupData {
    created_by: String,
    /// (user, role)
    members: Vec<(String, String)>,
    log: Vec<StoredMessage>,
    /// hid -> history log
    history: HashMap<String, HistoryLog>,
}

/// Seqs come from a counter that survives expiry/prune deletions: deriving
/// them from the surviving max would re-issue numbers and make client
/// cursors silently skip entries.
#[derive(Default)]
struct HistoryLog {
    last_seq: u64,
    entries: Vec<HistoryEntry>,
}

#[derive(Default)]
pub struct MemoryStore {
    inner: Mutex<MemoryInner>,
}

#[async_trait]
impl Store for MemoryStore {
    async fn register_user(&self, user: &str, pubkey: &[u8]) -> Result<RegisterOutcome, StoreError> {
        let mut inner = self.inner.lock().unwrap();
        match inner.users.get(user) {
            Some(existing) => Ok(RegisterOutcome::Existing(existing.clone())),
            None => {
                inner.users.insert(user.to_string(), pubkey.to_vec());
                Ok(RegisterOutcome::Registered)
            }
        }
    }

    async fn get_user_pubkey(&self, user: &str) -> Result<Option<Vec<u8>>, StoreError> {
        let inner = self.inner.lock().unwrap();
        Ok(inner.users.get(user).cloned())
    }

    async fn user_count(&self) -> Result<u64, StoreError> {
        let inner = self.inner.lock().unwrap();
        Ok(inner.users.len() as u64)
    }

    async fn publish_key_packages(&self, user: &str, payloads: Vec<Vec<u8>>) -> Result<(), StoreError> {
        let mut inner = self.inner.lock().unwrap();
        inner.key_packages.entry(user.to_string()).or_default().extend(payloads);
        Ok(())
    }

    async fn take_key_package(&self, user: &str) -> Result<Option<Vec<u8>>, StoreError> {
        let mut inner = self.inner.lock().unwrap();
        Ok(inner.key_packages.get_mut(user).and_then(|v| {
            if v.is_empty() { None } else { Some(v.remove(0)) }
        }))
    }

    async fn create_group(&self, group: &str, creator: &str) -> Result<(), StoreError> {
        let mut inner = self.inner.lock().unwrap();
        if inner.groups.contains_key(group) {
            return Err(StoreError::GroupExists);
        }
        inner.groups.insert(
            group.to_string(),
            GroupData {
                created_by: creator.to_string(),
                members: vec![(creator.to_string(), ROLE_ADMIN.to_string())],
                log: Vec::new(),
                history: HashMap::new(),
            },
        );
        Ok(())
    }

    async fn allow_member(&self, group: &str, user: &str) -> Result<(), StoreError> {
        let mut inner = self.inner.lock().unwrap();
        let data = inner.groups.get_mut(group).ok_or(StoreError::NoSuchGroup)?;
        if !data.members.iter().any(|(m, _)| m == user) {
            data.members.push((user.to_string(), ROLE_MEMBER.to_string()));
        }
        Ok(())
    }

    async fn disallow_member(&self, group: &str, user: &str) -> Result<(), StoreError> {
        let mut inner = self.inner.lock().unwrap();
        let data = inner.groups.get_mut(group).ok_or(StoreError::NoSuchGroup)?;
        data.members.retain(|(m, _)| m != user);
        Ok(())
    }

    async fn delete_group(&self, group: &str) -> Result<(), StoreError> {
        let mut inner = self.inner.lock().unwrap();
        inner.groups.remove(group);
        // Welcomes are keyed by recipient, not group; drop any that pointed
        // at this group so a queued invite can't resurrect a dead record.
        for queue in inner.welcomes.values_mut() {
            queue.retain(|w| w.group != group);
        }
        inner.invites.retain(|_, rec| rec.group != group);
        Ok(())
    }

    async fn is_member(&self, group: &str, user: &str) -> Result<bool, StoreError> {
        let inner = self.inner.lock().unwrap();
        Ok(inner
            .groups
            .get(group)
            .is_some_and(|d| d.members.iter().any(|(m, _)| m == user)))
    }

    async fn member_role(&self, group: &str, user: &str) -> Result<Option<String>, StoreError> {
        let inner = self.inner.lock().unwrap();
        Ok(inner
            .groups
            .get(group)
            .and_then(|d| d.members.iter().find(|(m, _)| m == user).map(|(_, r)| r.clone())))
    }

    async fn set_member_role(&self, group: &str, user: &str, role: &str) -> Result<(), StoreError> {
        let mut inner = self.inner.lock().unwrap();
        let data = inner.groups.get_mut(group).ok_or(StoreError::NoSuchGroup)?;
        match data.members.iter_mut().find(|(m, _)| m == user) {
            Some((_, r)) => {
                *r = role.to_string();
                Ok(())
            }
            None => Err(StoreError::Backend(format!("{user} is not a member of {group}"))),
        }
    }

    async fn group_members(&self, group: &str) -> Result<Vec<(String, String)>, StoreError> {
        let inner = self.inner.lock().unwrap();
        let data = inner.groups.get(group).ok_or(StoreError::NoSuchGroup)?;
        Ok(data.members.clone())
    }

    async fn list_users(&self) -> Result<Vec<String>, StoreError> {
        let inner = self.inner.lock().unwrap();
        let mut users: Vec<String> = inner.users.keys().cloned().collect();
        users.sort();
        Ok(users)
    }

    async fn list_groups(&self) -> Result<Vec<(String, String)>, StoreError> {
        let inner = self.inner.lock().unwrap();
        let mut groups: Vec<(String, String)> =
            inner.groups.iter().map(|(g, d)| (g.clone(), d.created_by.clone())).collect();
        groups.sort();
        Ok(groups)
    }

    async fn append_history(
        &self,
        group: &str,
        hid: &str,
        ts: u64,
        expires_at: Option<u64>,
        payload: Vec<u8>,
    ) -> Result<u64, StoreError> {
        let mut inner = self.inner.lock().unwrap();
        let data = inner.groups.get_mut(group).ok_or(StoreError::NoSuchGroup)?;
        let log = data.history.entry(hid.to_string()).or_default();
        log.last_seq += 1;
        let seq = log.last_seq;
        log.entries.push(HistoryEntry { seq, ts, expires_at, payload });
        Ok(seq)
    }

    async fn history_after(
        &self,
        group: &str,
        hid: &str,
        after: u64,
        now: u64,
    ) -> Result<Vec<HistoryEntry>, StoreError> {
        let mut inner = self.inner.lock().unwrap();
        let data = inner.groups.get_mut(group).ok_or(StoreError::NoSuchGroup)?;
        let Some(log) = data.history.get_mut(hid) else { return Ok(Vec::new()) };
        // Expired ciphertext has no readers left to serve — drop it now.
        log.entries.retain(|e| !e.expires_at.is_some_and(|t| now > t));
        Ok(log.entries.iter().filter(|e| e.seq > after).cloned().collect())
    }

    async fn prune_history(&self, group: &str, hid: &str, before_ts: u64) -> Result<(), StoreError> {
        let mut inner = self.inner.lock().unwrap();
        let data = inner.groups.get_mut(group).ok_or(StoreError::NoSuchGroup)?;
        if let Some(log) = data.history.get_mut(hid) {
            log.entries.retain(|e| e.ts >= before_ts);
        }
        Ok(())
    }

    async fn set_backup(&self, user: &str, payload: Vec<u8>) -> Result<(), StoreError> {
        let mut inner = self.inner.lock().unwrap();
        inner.backups.insert(user.to_string(), payload);
        Ok(())
    }

    async fn get_backup(&self, user: &str) -> Result<Option<Vec<u8>>, StoreError> {
        let inner = self.inner.lock().unwrap();
        Ok(inner.backups.get(user).cloned())
    }

    async fn set_vault(&self, user: &str, vault: VaultRecord) -> Result<(), StoreError> {
        let mut inner = self.inner.lock().unwrap();
        inner.vaults.insert(user.to_string(), vault);
        Ok(())
    }

    async fn get_vault(&self, user: &str) -> Result<Option<VaultRecord>, StoreError> {
        let inner = self.inner.lock().unwrap();
        Ok(inner.vaults.get(user).cloned())
    }

    async fn list_passkey_vaults(&self) -> Result<Vec<(String, VaultRecord)>, StoreError> {
        let inner = self.inner.lock().unwrap();
        Ok(inner
            .vaults
            .iter()
            .filter(|(_, v)| v.kind == "passkey")
            .map(|(u, v)| (u.clone(), v.clone()))
            .collect())
    }

    async fn put_push_subscription(
        &self,
        user: &str,
        endpoint: &str,
        subscription_json: &str,
    ) -> Result<(), StoreError> {
        let mut inner = self.inner.lock().unwrap();
        inner
            .push_subs
            .entry(user.to_string())
            .or_default()
            .insert(endpoint.to_string(), subscription_json.to_string());
        Ok(())
    }

    async fn push_subscriptions_for(&self, user: &str) -> Result<Vec<(String, String)>, StoreError> {
        let inner = self.inner.lock().unwrap();
        Ok(inner
            .push_subs
            .get(user)
            .map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
            .unwrap_or_default())
    }

    async fn delete_push_subscription(&self, user: &str, endpoint: &str) -> Result<(), StoreError> {
        let mut inner = self.inner.lock().unwrap();
        if let Some(m) = inner.push_subs.get_mut(user) {
            m.remove(endpoint);
        }
        Ok(())
    }

    async fn append_message(
        &self,
        group: &str,
        epoch: u64,
        sender: &str,
        payload: Vec<u8>,
    ) -> Result<u64, StoreError> {
        let mut inner = self.inner.lock().unwrap();
        let data = inner.groups.get_mut(group).ok_or(StoreError::NoSuchGroup)?;
        let seq = data.log.len() as u64 + 1;
        data.log.push(StoredMessage {
            group: group.to_string(),
            seq,
            epoch,
            sender: sender.to_string(),
            payload,
        });
        Ok(seq)
    }

    async fn messages_after(&self, group: &str, after: u64) -> Result<Vec<StoredMessage>, StoreError> {
        let inner = self.inner.lock().unwrap();
        let data = inner.groups.get(group).ok_or(StoreError::NoSuchGroup)?;
        Ok(data.log.iter().filter(|m| m.seq > after).cloned().collect())
    }

    async fn store_welcome(&self, to: &str, welcome: StoredWelcome) -> Result<(), StoreError> {
        let mut inner = self.inner.lock().unwrap();
        inner.welcomes.entry(to.to_string()).or_default().push(welcome);
        Ok(())
    }

    async fn take_welcomes(&self, to: &str) -> Result<Vec<StoredWelcome>, StoreError> {
        let mut inner = self.inner.lock().unwrap();
        Ok(inner.welcomes.remove(to).unwrap_or_default())
    }

    async fn create_invite(&self, invite: &str, record: InviteRecord) -> Result<(), StoreError> {
        let mut inner = self.inner.lock().unwrap();
        if !inner.groups.contains_key(&record.group) {
            return Err(StoreError::NoSuchGroup);
        }
        inner.invites.insert(invite.to_string(), record);
        Ok(())
    }

    async fn invite_group(&self, invite: &str) -> Result<Option<String>, StoreError> {
        let inner = self.inner.lock().unwrap();
        Ok(inner.invites.get(invite).map(|r| r.group.clone()))
    }

    async fn update_invite(&self, invite: &str, payload: Vec<u8>) -> Result<(), StoreError> {
        let mut inner = self.inner.lock().unwrap();
        let record = inner.invites.get_mut(invite).ok_or(StoreError::InviteInvalid)?;
        record.payload = payload;
        Ok(())
    }

    async fn revoke_invite(&self, invite: &str) -> Result<(), StoreError> {
        let mut inner = self.inner.lock().unwrap();
        inner.invites.remove(invite);
        Ok(())
    }

    async fn redeem_invite(&self, invite: &str, now: u64) -> Result<(String, Vec<u8>), StoreError> {
        let mut inner = self.inner.lock().unwrap();
        let record = inner.invites.get_mut(invite).ok_or(StoreError::InviteInvalid)?;
        if record.expires_at.is_some_and(|t| now > t)
            || record.max_uses.is_some_and(|m| record.uses >= m)
        {
            return Err(StoreError::InviteInvalid);
        }
        record.uses += 1;
        Ok((record.group.clone(), record.payload.clone()))
    }

    async fn invite_usable(&self, invite: &str, now: u64) -> Result<bool, StoreError> {
        let inner = self.inner.lock().unwrap();
        Ok(inner.invites.get(invite).is_some_and(|record| {
            !record.expires_at.is_some_and(|t| now > t)
                && !record.max_uses.is_some_and(|m| record.uses >= m)
        }))
    }
}
