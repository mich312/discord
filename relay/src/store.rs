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

#[async_trait]
pub trait Store: Send + Sync {
    /// Pin `pubkey` for `user` if unknown, else return the pinned key.
    async fn register_user(&self, user: &str, pubkey: &[u8]) -> Result<RegisterOutcome, StoreError>;
    /// The pinned pubkey for `user`, if registered.
    async fn get_user_pubkey(&self, user: &str) -> Result<Option<Vec<u8>>, StoreError>;
    async fn publish_key_packages(&self, user: &str, payloads: Vec<Vec<u8>>) -> Result<(), StoreError>;
    /// Consume (remove and return) one KeyPackage for `user`.
    async fn take_key_package(&self, user: &str) -> Result<Option<Vec<u8>>, StoreError>;
    async fn create_group(&self, group: &str, creator: &str) -> Result<(), StoreError>;
    async fn allow_member(&self, group: &str, user: &str) -> Result<(), StoreError>;
    async fn is_member(&self, group: &str, user: &str) -> Result<bool, StoreError>;
    async fn group_members(&self, group: &str) -> Result<Vec<String>, StoreError>;
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
}

#[derive(Default)]
struct GroupData {
    members: Vec<String>,
    log: Vec<StoredMessage>,
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
            GroupData { members: vec![creator.to_string()], log: Vec::new() },
        );
        Ok(())
    }

    async fn allow_member(&self, group: &str, user: &str) -> Result<(), StoreError> {
        let mut inner = self.inner.lock().unwrap();
        let data = inner.groups.get_mut(group).ok_or(StoreError::NoSuchGroup)?;
        if !data.members.iter().any(|m| m == user) {
            data.members.push(user.to_string());
        }
        Ok(())
    }

    async fn is_member(&self, group: &str, user: &str) -> Result<bool, StoreError> {
        let inner = self.inner.lock().unwrap();
        Ok(inner
            .groups
            .get(group)
            .is_some_and(|d| d.members.iter().any(|m| m == user)))
    }

    async fn group_members(&self, group: &str) -> Result<Vec<String>, StoreError> {
        let inner = self.inner.lock().unwrap();
        let data = inner.groups.get(group).ok_or(StoreError::NoSuchGroup)?;
        Ok(data.members.clone())
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
}
