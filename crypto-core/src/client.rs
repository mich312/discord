//! Pure-Rust MLS client core. No wasm types here — this module is exercised
//! by native integration tests; `crate::wasm` wraps it for the browser.
//!
//! One `ChatClient` holds one identity and any number of groups ("servers"
//! in the product). Groups are keyed by the relay's group id, which is also
//! used verbatim as the MLS GroupId so incoming messages route themselves.

use openmls::prelude::*;
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::OpenMlsRustCrypto;
use openmls_traits::signatures::Signer;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tls_codec::{Deserialize as TlsDeserialize, Serialize as TlsSerialize};

const CIPHERSUITE: Ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;

/// How many past epochs' decryption secrets each member retains. Relay
/// delivery is ordered per group but a commit can still overtake a message
/// encrypted just before it (sender hadn't merged yet). 0 would drop such
/// messages; a small window trades a sliver of forward secrecy for not
/// losing mail. Keep it small.
const MAX_PAST_EPOCHS: usize = 2;

#[derive(Debug, thiserror::Error)]
pub enum CoreError {
    #[error("unknown group {0}")]
    UnknownGroup(String),
    #[error("already in group {0}")]
    AlreadyInGroup(String),
    #[error("bad state bundle: {0}")]
    BadState(String),
    #[error("{0}")]
    Mls(String),
}

impl CoreError {
    fn mls(e: impl std::fmt::Display) -> Self {
        CoreError::Mls(e.to_string())
    }
}

/// What `process_incoming` yields back to the caller.
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Event {
    /// A decrypted application message.
    #[serde(rename_all = "camelCase")]
    Message { group: String, sender: String, text: String, epoch: u64 },
    /// A commit was merged; the group moved to a new epoch. `sender` is the
    /// commit's signer: for an external (invite-link) join that is the new
    /// member itself — the UI uses this to mark link-joins as unverified.
    #[serde(rename_all = "camelCase")]
    MembershipChange { group: String, epoch: u64, sender: String, members: Vec<String> },
    /// A proposal was queued; nothing user-visible yet.
    #[serde(rename_all = "camelCase")]
    ProposalStored { group: String, epoch: u64 },
}

/// Result of adding a member: both blobs must reach the relay —
/// `commit` fans out to existing members, `welcome` goes to the joiner.
pub struct AddResult {
    pub commit: Vec<u8>,
    pub welcome: Vec<u8>,
}

/// Header of the versioned state bundle (followed by the raw storage map).
#[derive(Serialize, Deserialize)]
struct StateHeader {
    v: u32,
    name: String,
    signer: SignatureKeyPair,
    groups: Vec<String>,
}

/// Identity-only bundle for the recovery key. Deliberately excludes group
/// ratchet state: a restored snapshot of ratchets would be stale and
/// unusable anyway. What recovery must preserve is the identity key the
/// relay has pinned — with it, the user keeps their account and can be
/// re-added to groups.
#[derive(Serialize, Deserialize)]
struct IdentityBundle {
    v: u32,
    name: String,
    signer: SignatureKeyPair,
}

pub struct ChatClient {
    provider: OpenMlsRustCrypto,
    signer: SignatureKeyPair,
    credential_with_key: CredentialWithKey,
    groups: HashMap<String, MlsGroup>,
    name: String,
}

impl ChatClient {
    pub fn new(name: &str) -> Result<Self, CoreError> {
        let signer = SignatureKeyPair::new(CIPHERSUITE.signature_algorithm())
            .map_err(|e| CoreError::Mls(format!("{e:?}")))?;
        Self::with_identity(name.to_string(), signer)
    }

    fn with_identity(name: String, signer: SignatureKeyPair) -> Result<Self, CoreError> {
        let provider = OpenMlsRustCrypto::default();
        signer.store(provider.storage()).map_err(CoreError::mls)?;
        let credential = BasicCredential::new(name.as_bytes().to_vec());
        let credential_with_key = CredentialWithKey {
            credential: credential.into(),
            signature_key: signer.public().into(),
        };
        Ok(Self { provider, signer, credential_with_key, groups: HashMap::new(), name })
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn group_ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = self.groups.keys().cloned().collect();
        ids.sort();
        ids
    }

    /// Raw Ed25519 public key of this client's MLS identity. The relay
    /// pins it on first contact and challenges it on every connection.
    pub fn signature_public_key(&self) -> Vec<u8> {
        self.signer.public().to_vec()
    }

    /// Sign arbitrary bytes with the MLS identity key (used for the
    /// relay's auth challenge — same key that signs MLS messages).
    pub fn sign(&self, message: &[u8]) -> Result<Vec<u8>, CoreError> {
        self.signer
            .sign(message)
            .map_err(|e| CoreError::Mls(format!("{e:?}")))
    }

    // === persistence ======================================================

    /// Full state snapshot: identity + every group's MLS state. Written to
    /// IndexedDB after each mutating operation so a reload resumes exactly
    /// where the ratchets left off. Device-local; never leaves the device.
    pub fn export_state(&self) -> Result<Vec<u8>, CoreError> {
        let header = StateHeader {
            v: 1,
            name: self.name.clone(),
            signer: clone_signer(&self.signer)?,
            groups: self.group_ids(),
        };
        let header = serde_json::to_vec(&header).map_err(CoreError::mls)?;
        let mut out = (header.len() as u32).to_be_bytes().to_vec();
        out.extend_from_slice(&header);

        let values = self.provider.storage().values.read().unwrap();
        out.extend_from_slice(&(values.len() as u64).to_be_bytes());
        for (k, v) in values.iter() {
            out.extend_from_slice(&(k.len() as u64).to_be_bytes());
            out.extend_from_slice(&(v.len() as u64).to_be_bytes());
            out.extend_from_slice(k);
            out.extend_from_slice(v);
        }
        Ok(out)
    }

    pub fn import_state(bytes: &[u8]) -> Result<Self, CoreError> {
        let bad = |m: &str| CoreError::BadState(m.to_string());
        let mut rest = bytes;
        let mut take = |n: usize| -> Result<&[u8], CoreError> {
            if rest.len() < n {
                return Err(bad("truncated"));
            }
            let (head, tail) = rest.split_at(n);
            rest = tail;
            Ok(head)
        };

        let header_len = u32::from_be_bytes(take(4)?.try_into().unwrap()) as usize;
        let header: StateHeader =
            serde_json::from_slice(take(header_len)?).map_err(|e| bad(&e.to_string()))?;
        if header.v != 1 {
            return Err(bad("unsupported version"));
        }

        let count = u64::from_be_bytes(take(8)?.try_into().unwrap());
        let mut map = HashMap::new();
        for _ in 0..count {
            let k_len = u64::from_be_bytes(take(8)?.try_into().unwrap()) as usize;
            let v_len = u64::from_be_bytes(take(8)?.try_into().unwrap()) as usize;
            let k = take(k_len)?.to_vec();
            let v = take(v_len)?.to_vec();
            map.insert(k, v);
        }

        let provider = OpenMlsRustCrypto::default();
        *provider.storage().values.write().unwrap() = map;

        let credential = BasicCredential::new(header.name.as_bytes().to_vec());
        let credential_with_key = CredentialWithKey {
            credential: credential.into(),
            signature_key: header.signer.public().into(),
        };
        let mut groups = HashMap::new();
        for id in header.groups {
            let group = MlsGroup::load(provider.storage(), &GroupId::from_slice(id.as_bytes()))
                .map_err(|e| CoreError::Mls(format!("{e:?}")))?
                .ok_or_else(|| bad(&format!("group {id} missing from storage")))?;
            groups.insert(id, group);
        }
        Ok(Self {
            provider,
            signer: header.signer,
            credential_with_key,
            groups,
            name: header.name,
        })
    }

    /// Identity-only export for the recovery key (no group state — see
    /// `IdentityBundle`). The caller passphrase-encrypts this.
    pub fn export_identity(&self) -> Result<Vec<u8>, CoreError> {
        let bundle = IdentityBundle {
            v: 1,
            name: self.name.clone(),
            signer: clone_signer(&self.signer)?,
        };
        serde_json::to_vec(&bundle).map_err(CoreError::mls)
    }

    pub fn import_identity(bytes: &[u8]) -> Result<Self, CoreError> {
        let bundle: IdentityBundle =
            serde_json::from_slice(bytes).map_err(|e| CoreError::BadState(e.to_string()))?;
        if bundle.v != 1 {
            return Err(CoreError::BadState("unsupported version".into()));
        }
        Self::with_identity(bundle.name, bundle.signer)
    }

    // === key packages =====================================================

    /// Generate a fresh KeyPackage and return it TLS-serialized. The private
    /// parts are kept in the provider's storage for the later Welcome.
    pub fn key_package(&self) -> Result<Vec<u8>, CoreError> {
        let bundle = KeyPackage::builder()
            .build(
                CIPHERSUITE,
                &self.provider,
                &self.signer,
                self.credential_with_key.clone(),
            )
            .map_err(CoreError::mls)?;
        bundle
            .key_package()
            .tls_serialize_detached()
            .map_err(CoreError::mls)
    }

    // === groups ===========================================================

    /// Create a new group with this client as the only member. `id` is the
    /// relay-visible group id and doubles as the MLS GroupId.
    pub fn create_group(&mut self, id: &str) -> Result<(), CoreError> {
        if self.groups.contains_key(id) {
            return Err(CoreError::AlreadyInGroup(id.to_string()));
        }
        // The ratchet-tree extension keeps Welcomes self-contained, so the
        // relay never needs to serve the tree out of band.
        let config = MlsGroupCreateConfig::builder()
            .ciphersuite(CIPHERSUITE)
            .use_ratchet_tree_extension(true)
            .max_past_epochs(MAX_PAST_EPOCHS)
            .build();
        let group = MlsGroup::new_with_group_id(
            &self.provider,
            &self.signer,
            &config,
            GroupId::from_slice(id.as_bytes()),
            self.credential_with_key.clone(),
        )
        .map_err(CoreError::mls)?;
        self.groups.insert(id.to_string(), group);
        Ok(())
    }

    fn group_ref(&self, id: &str) -> Result<&MlsGroup, CoreError> {
        self.groups
            .get(id)
            .ok_or_else(|| CoreError::UnknownGroup(id.to_string()))
    }

    /// Add a member from their serialized KeyPackage. Returns the commit
    /// (for the group) and the Welcome (for the joiner), both serialized.
    pub fn add_member(&mut self, id: &str, key_package_bytes: &[u8]) -> Result<AddResult, CoreError> {
        let kp_in = KeyPackageIn::tls_deserialize_exact(key_package_bytes)
            .map_err(CoreError::mls)?;
        let key_package = kp_in
            .validate(self.provider.crypto(), ProtocolVersion::Mls10)
            .map_err(CoreError::mls)?;
        let group = self
            .groups
            .get_mut(id)
            .ok_or_else(|| CoreError::UnknownGroup(id.to_string()))?;
        let (commit, welcome, _group_info) = group
            .add_members(&self.provider, &self.signer, &[key_package])
            .map_err(CoreError::mls)?;
        group.merge_pending_commit(&self.provider).map_err(CoreError::mls)?;
        Ok(AddResult {
            commit: commit.tls_serialize_detached().map_err(CoreError::mls)?,
            welcome: welcome.tls_serialize_detached().map_err(CoreError::mls)?,
        })
    }

    /// Remove a member by name. Returns the serialized commit for fan-out.
    pub fn remove_member(&mut self, id: &str, name: &str) -> Result<Vec<u8>, CoreError> {
        let group = self
            .groups
            .get_mut(id)
            .ok_or_else(|| CoreError::UnknownGroup(id.to_string()))?;
        let target = group
            .members()
            .find(|m| identity_of(&m.credential).as_deref() == Some(name))
            .ok_or_else(|| CoreError::Mls(format!("no member named {name}")))?;
        let (commit, _welcome, _group_info) = group
            .remove_members(&self.provider, &self.signer, &[target.index])
            .map_err(CoreError::mls)?;
        group.merge_pending_commit(&self.provider).map_err(CoreError::mls)?;
        commit.tls_serialize_detached().map_err(CoreError::mls)
    }

    /// Join a group from a serialized Welcome message. Returns the group id.
    pub fn join_from_welcome(&mut self, welcome_bytes: &[u8]) -> Result<String, CoreError> {
        let message = MlsMessageIn::tls_deserialize_exact(welcome_bytes)
            .map_err(CoreError::mls)?;
        let welcome = match message.extract() {
            MlsMessageBodyIn::Welcome(w) => w,
            other => {
                return Err(CoreError::Mls(format!(
                    "expected a Welcome message, got {other:?}"
                )))
            }
        };
        let config = MlsGroupJoinConfig::builder()
            .use_ratchet_tree_extension(true)
            .max_past_epochs(MAX_PAST_EPOCHS)
            .build();
        let staged = StagedWelcome::new_from_welcome(&self.provider, &config, welcome, None)
            .map_err(CoreError::mls)?;
        let group = staged.into_group(&self.provider).map_err(CoreError::mls)?;
        let id = String::from_utf8_lossy(group.group_id().as_slice()).into_owned();
        if self.groups.contains_key(&id) {
            return Err(CoreError::AlreadyInGroup(id));
        }
        self.groups.insert(id.clone(), group);
        Ok(id)
    }

    /// Leave-side cleanup when kicked, or when abandoning a group locally.
    pub fn forget_group(&mut self, id: &str) {
        self.groups.remove(id);
    }

    // === safety numbers ====================================================

    /// A short authentication string for me + `peer` in group `id`,
    /// computed from both MLS identity keys (which sign every message the
    /// member sends). Symmetric — both sides derive the same 60 digits —
    /// and meant to be compared out of band. Verifying it rules out the
    /// relay having substituted a different key for either party.
    pub fn safety_number(&self, id: &str, peer: &str) -> Result<String, CoreError> {
        use sha2::{Digest, Sha256};
        let group = self.group_ref(id)?;
        let peer_key = group
            .members()
            .find(|m| identity_of(&m.credential).as_deref() == Some(peer))
            .map(|m| m.signature_key)
            .ok_or_else(|| CoreError::Mls(format!("no member named {peer}")))?;
        let mut parties = [
            (self.name.as_bytes().to_vec(), self.signer.public().to_vec()),
            (peer.as_bytes().to_vec(), peer_key),
        ];
        parties.sort();
        let mut hasher = Sha256::new();
        hasher.update(b"e2ee-safety-number-v1");
        for (name, key) in &parties {
            hasher.update((name.len() as u64).to_be_bytes());
            hasher.update(name);
            hasher.update((key.len() as u64).to_be_bytes());
            hasher.update(key);
        }
        let hash = hasher.finalize();
        // 12 groups of 5 digits from 24 bytes (2 bytes + 1 shared per pair).
        let groups: Vec<String> = (0..12)
            .map(|i| {
                let n = u32::from_be_bytes([0, hash[i * 2], hash[i * 2 + 1], hash[24 + i / 2]]);
                format!("{:05}", n % 100_000)
            })
            .collect();
        Ok(groups.join(" "))
    }

    // === invite links (external commits) ==================================

    /// Export a signed GroupInfo (ratchet tree included) for the current
    /// epoch. Encrypted under the invite link's fragment key and parked on
    /// the relay, this is what lets a stranger join with nobody online.
    /// MUST be re-exported after every epoch change — external commits
    /// against a stale epoch are rejected by the group.
    pub fn export_group_info(&self, id: &str) -> Result<Vec<u8>, CoreError> {
        let group = self.group_ref(id)?;
        let message = group
            .export_group_info(self.provider.crypto(), &self.signer, true)
            .map_err(CoreError::mls)?;
        message.tls_serialize_detached().map_err(CoreError::mls)
    }

    /// Join a group via External Commit (RFC 9420 §12.4) from a serialized
    /// GroupInfo. Returns the group id and the commit that must be published
    /// to the group's log so existing members learn about the join.
    pub fn join_by_external_commit(
        &mut self,
        group_info_bytes: &[u8],
    ) -> Result<(String, Vec<u8>), CoreError> {
        let message = MlsMessageIn::tls_deserialize_exact(group_info_bytes)
            .map_err(CoreError::mls)?;
        let verifiable = match message.extract() {
            MlsMessageBodyIn::GroupInfo(gi) => gi,
            other => {
                return Err(CoreError::Mls(format!(
                    "expected a GroupInfo message, got {other:?}"
                )))
            }
        };
        let config = MlsGroupJoinConfig::builder()
            .use_ratchet_tree_extension(true)
            .max_past_epochs(MAX_PAST_EPOCHS)
            .build();
        let (group, bundle) = ExternalCommitBuilder::new()
            .with_config(config)
            .build_group(&self.provider, verifiable, self.credential_with_key.clone())
            .map_err(|e| CoreError::Mls(format!("{e:?}")))?
            .load_psks(self.provider.storage())
            .map_err(|e| CoreError::Mls(format!("{e:?}")))?
            .build(
                self.provider.rand(),
                self.provider.crypto(),
                &self.signer,
                |_| true,
            )
            .map_err(|e| CoreError::Mls(format!("{e:?}")))?
            .finalize(&self.provider)
            .map_err(|e| CoreError::Mls(format!("{e:?}")))?;
        let (commit, _welcome, _group_info) = bundle.into_contents();
        let id = String::from_utf8_lossy(group.group_id().as_slice()).into_owned();
        if self.groups.contains_key(&id) {
            return Err(CoreError::AlreadyInGroup(id));
        }
        let commit_bytes = commit.tls_serialize_detached().map_err(CoreError::mls)?;
        self.groups.insert(id.clone(), group);
        Ok((id, commit_bytes))
    }

    // === messaging ========================================================

    /// Encrypt an application message for the group's current epoch.
    pub fn send_message(&mut self, id: &str, text: &str) -> Result<Vec<u8>, CoreError> {
        let group = self
            .groups
            .get_mut(id)
            .ok_or_else(|| CoreError::UnknownGroup(id.to_string()))?;
        let message = group
            .create_message(&self.provider, &self.signer, text.as_bytes())
            .map_err(CoreError::mls)?;
        message.tls_serialize_detached().map_err(CoreError::mls)
    }

    /// Process an incoming MLS message from the relay. The target group is
    /// read from the message itself.
    pub fn process_incoming(&mut self, bytes: &[u8]) -> Result<Event, CoreError> {
        let message = MlsMessageIn::tls_deserialize_exact(bytes).map_err(CoreError::mls)?;
        let protocol_message: ProtocolMessage = message
            .try_into_protocol_message()
            .map_err(CoreError::mls)?;
        let id = String::from_utf8_lossy(protocol_message.group_id().as_slice()).into_owned();
        let provider = &self.provider;
        let group = self
            .groups
            .get_mut(&id)
            .ok_or_else(|| CoreError::UnknownGroup(id.clone()))?;
        let processed = group
            .process_message(provider, protocol_message)
            .map_err(CoreError::mls)?;
        let sender = identity_of(processed.credential()).unwrap_or_default();

        match processed.into_content() {
            ProcessedMessageContent::ApplicationMessage(app) => {
                let text = String::from_utf8_lossy(&app.into_bytes()).into_owned();
                let epoch = group.epoch().as_u64();
                Ok(Event::Message { group: id, sender, text, epoch })
            }
            ProcessedMessageContent::StagedCommitMessage(staged) => {
                group
                    .merge_staged_commit(provider, *staged)
                    .map_err(CoreError::mls)?;
                let epoch = group.epoch().as_u64();
                let members = members_of(group);
                Ok(Event::MembershipChange { group: id, epoch, sender, members })
            }
            ProcessedMessageContent::ProposalMessage(proposal) => {
                group
                    .store_pending_proposal(provider.storage(), *proposal)
                    .map_err(CoreError::mls)?;
                let epoch = group.epoch().as_u64();
                Ok(Event::ProposalStored { group: id, epoch })
            }
            ProcessedMessageContent::ExternalJoinProposalMessage(proposal) => {
                group
                    .store_pending_proposal(provider.storage(), *proposal)
                    .map_err(CoreError::mls)?;
                let epoch = group.epoch().as_u64();
                Ok(Event::ProposalStored { group: id, epoch })
            }
        }
    }

    pub fn epoch(&self, id: &str) -> Result<u64, CoreError> {
        Ok(self.group_ref(id)?.epoch().as_u64())
    }

    pub fn members(&self, id: &str) -> Result<Vec<String>, CoreError> {
        Ok(members_of(self.group_ref(id)?))
    }
}

fn members_of(group: &MlsGroup) -> Vec<String> {
    group
        .members()
        .filter_map(|m| identity_of(&m.credential))
        .collect()
}

/// Derive the two halves of a password login from Argon2id: the first 32
/// bytes are the *auth key* (sent to the relay, which stores only a hash
/// of it), the last 32 the *wrap key* (encrypts the identity bundle and
/// never leaves the client). The password itself is never transmitted.
/// The honest caveat stands: a malicious relay holding the wrapped bundle
/// can brute-force weak passwords offline — Argon2id (19 MiB, t=2) makes
/// that expensive, not impossible.
pub fn derive_login_keys(password: &str, salt: &[u8]) -> Result<Vec<u8>, CoreError> {
    use argon2::{Algorithm, Argon2, Params, Version};
    let params = Params::new(19_456, 2, 1, Some(64))
        .map_err(|e| CoreError::Mls(e.to_string()))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut out = vec![0u8; 64];
    argon
        .hash_password_into(password.as_bytes(), salt, &mut out)
        .map_err(|e| CoreError::Mls(e.to_string()))?;
    Ok(out)
}

fn identity_of(credential: &Credential) -> Option<String> {
    BasicCredential::try_from(credential.clone())
        .ok()
        .map(|c| String::from_utf8_lossy(c.identity()).into_owned())
}

// SignatureKeyPair is serde-serializable but not Clone (without a feature
// flag); round-trip through serde where a owned copy is needed.
fn clone_signer(signer: &SignatureKeyPair) -> Result<SignatureKeyPair, CoreError> {
    serde_json::from_slice(&serde_json::to_vec(signer).map_err(CoreError::mls)?)
        .map_err(CoreError::mls)
}
