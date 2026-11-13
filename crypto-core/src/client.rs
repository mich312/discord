//! Pure-Rust MLS client core. No wasm types here — this module is exercised
//! by native integration tests; `crate::wasm` wraps it for the browser.
//!
//! One `ChatClient` holds one identity and any number of groups ("servers"
//! in the product). Groups are keyed by the relay's group id, which is also
//! used verbatim as the MLS GroupId so incoming messages route themselves.

use openmls::prelude::*;
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::OpenMlsRustCrypto;
use openmls_traits::crypto::OpenMlsCrypto;
use openmls_traits::signatures::Signer;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use ::tls_codec::{Deserialize as TlsDeserialize, Serialize as TlsSerialize};

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
    /// A KeyPackage's credential named someone other than the person the
    /// caller meant to add — i.e. whoever served it substituted an identity.
    #[error("key package identity mismatch: asked for {expected}, got {got}")]
    IdentityMismatch { expected: String, got: String },
    /// The credential named the right person but carried a signature key
    /// other than the one pinned for that handle.
    #[error("key package for {0} carries an unexpected signature key")]
    KeyMismatch(String),
    /// A commit would put a leaf in the group under a name an existing
    /// member already holds with a different key. The commit is refused
    /// before it is merged; see `check_commit_identities`.
    #[error("identity conflict: {0} is not who this circle knows by that name")]
    IdentityConflict(String),
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
    ///
    /// `active` is whether THIS device is still in the group afterwards. It
    /// is not the same question as "is my name in `members`": an identity
    /// holds one leaf, so when the same account joins again from another
    /// device (an invite link opened there), that join replaces this
    /// device's leaf. The name stays in the roster and this device is out —
    /// every later call on the group fails. Without this flag the client
    /// could not tell, and the device sat there looking like a member.
    #[serde(rename_all = "camelCase")]
    MembershipChange {
        group: String,
        epoch: u64,
        sender: String,
        members: Vec<String>,
        active: bool,
    },
    /// A proposal was queued; nothing user-visible yet.
    #[serde(rename_all = "camelCase")]
    ProposalStored { group: String, epoch: u64 },
}

/// Result of adding a member: both blobs must reach the relay —
/// `commit` fans out to existing members, `welcome` goes to the joiner.
#[derive(Debug)]
pub struct AddResult {
    pub commit: Vec<u8>,
    pub welcome: Vec<u8>,
}

/// Header of the versioned state bundle (followed by the raw storage map).
#[derive(Serialize, Deserialize)]
struct StateHeader {
    v: u32,
    name: String,
    /// This DEVICE's MLS signing key — the one on its leaf.
    signer: SignatureKeyPair,
    /// The ACCOUNT's identity key. Absent in snapshots written before the
    /// two were separate, where `signer` is both (see `ChatClient`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    identity: Option<SignatureKeyPair>,
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

/// One device of one account.
///
/// Two keys, which used to be one:
///
/// * `identity` — the ACCOUNT's key. The relay pins it to the handle and
///   challenges it on every connection, safety numbers are computed over it,
///   and it signs the entries a member writes to a channel's log. It is what
///   the recovery file, the vault and device linking carry: every device of
///   an account holds the same one.
/// * `signer` — this DEVICE's key, generated here and never exported. It is
///   the signature key on this device's MLS leaf.
///
/// They were the same key, so an account could hold exactly one leaf: MLS
/// requires leaf signature keys to be unique, and a second device presenting
/// the same one is treated as the first device resyncing and *replaces* it.
/// A phone joining a circle evicted the laptop.
///
/// What ties the two together is the credential (see `device_credential`):
/// the handle, the identity public key, and the identity key's signature
/// over this device's key. Any member can check that a leaf claiming to be
/// "bob" was authorized by bob's identity key, and `check_commit_identities`
/// refuses a leaf that was not.
///
/// A snapshot from before the split has one key doing both jobs and a bare
/// handle for a credential. That is still a valid device — its leaf key IS
/// its identity key — and it keeps working unchanged beside the new kind.
pub struct ChatClient {
    provider: OpenMlsRustCrypto,
    identity: SignatureKeyPair,
    signer: SignatureKeyPair,
    credential_with_key: CredentialWithKey,
    groups: HashMap<String, MlsGroup>,
    name: String,
}

/// Domain separator for the identity key's signature over a device key.
const DEVICE_CERT_CONTEXT: &[u8] = b"quorum-device-cert-v1";
/// Version byte of the credential layout after the handle.
const DEVICE_CREDENTIAL_V1: u8 = 1;
const ED25519_PUBLIC_LEN: usize = 32;
const ED25519_SIGNATURE_LEN: usize = 64;

/// The exact bytes an identity key signs to authorize a device key. The
/// handle is length-prefixed and bound in, so a certificate issued for one
/// account's device cannot be presented under another handle.
fn device_cert_message(name: &[u8], device_key: &[u8]) -> Vec<u8> {
    let mut m = DEVICE_CERT_CONTEXT.to_vec();
    m.extend_from_slice(&(name.len() as u32).to_be_bytes());
    m.extend_from_slice(name);
    m.extend_from_slice(device_key);
    m
}

/// The bytes of a device's MLS credential:
/// `handle ‖ 0x00 ‖ version ‖ identity public key ‖ certificate`.
///
/// A handle cannot contain NUL, so the first NUL is unambiguous — and a
/// credential with none is the older, bare-handle kind.
fn device_credential(
    name: &str,
    identity: &SignatureKeyPair,
    device_key: &[u8],
) -> Result<Vec<u8>, CoreError> {
    let cert = identity
        .sign(&device_cert_message(name.as_bytes(), device_key))
        .map_err(|e| CoreError::Mls(format!("{e:?}")))?;
    let mut out = name.as_bytes().to_vec();
    out.push(0);
    out.push(DEVICE_CREDENTIAL_V1);
    out.extend_from_slice(identity.public());
    out.extend_from_slice(&cert);
    Ok(out)
}

/// What a leaf says about who it belongs to, once checked.
struct Claim {
    name: String,
    /// The account identity key this leaf answers to.
    identity_key: Vec<u8>,
}

/// Read and VERIFY a leaf's credential against its own signature key.
///
/// `None` means the credential is malformed or its certificate does not
/// verify — a leaf nobody should attribute anything to. A bare-handle
/// credential needs no certificate: its leaf key is its identity key.
fn claim_of(
    crypto: &impl OpenMlsCrypto,
    credential: &Credential,
    leaf_key: &[u8],
) -> Option<Claim> {
    let bytes = BasicCredential::try_from(credential.clone()).ok()?;
    let bytes = bytes.identity();
    let Some(split) = bytes.iter().position(|b| *b == 0) else {
        if bytes.is_empty() {
            return None;
        }
        return Some(Claim {
            name: String::from_utf8_lossy(bytes).into_owned(),
            identity_key: leaf_key.to_vec(),
        });
    };
    let (name, rest) = (&bytes[..split], &bytes[split + 1..]);
    if name.is_empty()
        || rest.len() != 1 + ED25519_PUBLIC_LEN + ED25519_SIGNATURE_LEN
        || rest[0] != DEVICE_CREDENTIAL_V1
    {
        return None;
    }
    let identity_key = &rest[1..1 + ED25519_PUBLIC_LEN];
    let cert = &rest[1 + ED25519_PUBLIC_LEN..];
    crypto
        .verify_signature(
            CIPHERSUITE.signature_algorithm(),
            &device_cert_message(name, leaf_key),
            identity_key,
            cert,
        )
        .ok()?;
    Some(Claim {
        name: String::from_utf8_lossy(name).into_owned(),
        identity_key: identity_key.to_vec(),
    })
}

impl ChatClient {
    /// A brand-new account, on its first device.
    pub fn new(name: &str) -> Result<Self, CoreError> {
        let identity = SignatureKeyPair::new(CIPHERSUITE.signature_algorithm())
            .map_err(|e| CoreError::Mls(format!("{e:?}")))?;
        Self::with_identity(name.to_string(), identity)
    }

    /// A new DEVICE for the account `identity` belongs to: a fresh device
    /// key, certified by the identity key.
    fn with_identity(name: String, identity: SignatureKeyPair) -> Result<Self, CoreError> {
        if name.is_empty() || name.as_bytes().contains(&0) {
            return Err(CoreError::Mls("a handle cannot be empty or contain NUL".into()));
        }
        let signer = SignatureKeyPair::new(CIPHERSUITE.signature_algorithm())
            .map_err(|e| CoreError::Mls(format!("{e:?}")))?;
        let provider = OpenMlsRustCrypto::default();
        signer.store(provider.storage()).map_err(CoreError::mls)?;
        let credential_with_key = Self::credential_for(&name, &identity, &signer)?;
        Ok(Self { provider, identity, signer, credential_with_key, groups: HashMap::new(), name })
    }

    /// The credential a device presents: certified when it has a key of its
    /// own, the bare handle when its leaf key is the identity key itself.
    fn credential_for(
        name: &str,
        identity: &SignatureKeyPair,
        signer: &SignatureKeyPair,
    ) -> Result<CredentialWithKey, CoreError> {
        let bytes = if identity.public() == signer.public() {
            name.as_bytes().to_vec()
        } else {
            device_credential(name, identity, signer.public())?
        };
        Ok(CredentialWithKey {
            credential: BasicCredential::new(bytes).into(),
            signature_key: signer.public().into(),
        })
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn group_ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = self.groups.keys().cloned().collect();
        ids.sort();
        ids
    }

    /// Raw Ed25519 public key of the ACCOUNT's identity. The relay pins it
    /// on first contact and challenges it on every connection; it is the
    /// same on every device of the account.
    pub fn signature_public_key(&self) -> Vec<u8> {
        self.identity.public().to_vec()
    }

    /// Raw Ed25519 public key of THIS DEVICE — the key on its MLS leaf, and
    /// what names the device to the relay and to the account's other
    /// devices. Equal to the identity key on a device from before the two
    /// were separate.
    pub fn device_public_key(&self) -> Vec<u8> {
        self.signer.public().to_vec()
    }

    /// Sign arbitrary bytes with the account identity key: the relay's auth
    /// challenge, and authorship of server-log entries. The identity key
    /// rather than the device's, so an entry verifies no matter which of
    /// its author's devices wrote it.
    pub fn sign(&self, message: &[u8]) -> Result<Vec<u8>, CoreError> {
        self.identity
            .sign(message)
            .map_err(|e| CoreError::Mls(format!("{e:?}")))
    }

    /// Check an Ed25519 signature made by `public_key` over `message`.
    ///
    /// The counterpart to `sign`, used to authenticate entries read back
    /// from the relay's channel log. Those entries are encrypted under a
    /// key the whole roster holds, so the room key proves only that *a*
    /// member wrote it; the signature is what names which one.
    pub fn verify(&self, public_key: &[u8], message: &[u8], signature: &[u8]) -> bool {
        self.provider
            .crypto()
            .verify_signature(
                CIPHERSUITE.signature_algorithm(),
                message,
                public_key,
                signature,
            )
            .is_ok()
    }

    /// The group's roster as (handle, identity public key) pairs — one per
    /// member, however many devices they have in the group.
    ///
    /// This is the *cryptographic* answer to "which key speaks for whom",
    /// taken from the ratchet tree rather than from anything the relay
    /// says. The client keeps a directory built from this so it can check
    /// the signature on a server-log entry written by someone who is not
    /// online — and, after a restore, by someone whose key it can no longer
    /// re-derive. A key learned here is only as good as the roster it came
    /// from; a safety-number check is still what rules out substitution.
    pub fn member_keys(&self, id: &str) -> Result<Vec<(String, Vec<u8>)>, CoreError> {
        let mut out: Vec<(String, Vec<u8>)> = Vec::new();
        for m in self.group_ref(id)?.members() {
            // A leaf whose certificate does not verify speaks for nobody.
            let Some(claim) = claim_of(self.provider.crypto(), &m.credential, &m.signature_key)
            else {
                continue;
            };
            if !out.iter().any(|(name, _)| *name == claim.name) {
                out.push((claim.name, claim.identity_key));
            }
        }
        Ok(out)
    }

    /// Every device in the group as (handle, device public key) pairs. How
    /// a client tells whether one of an account's devices is already in.
    pub fn member_devices(&self, id: &str) -> Result<Vec<(String, Vec<u8>)>, CoreError> {
        Ok(self
            .group_ref(id)?
            .members()
            .filter_map(|m| {
                let name = identity_of(&m.credential)?;
                Some((name, m.signature_key))
            })
            .collect())
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
            identity: if self.identity.public() == self.signer.public() {
                None
            } else {
                Some(clone_signer(&self.identity)?)
            },
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

        // No separate identity key: a snapshot from before devices had their
        // own. Its one key is both, and its credential is the bare handle.
        let identity = match header.identity {
            Some(identity) => identity,
            None => clone_signer(&header.signer)?,
        };
        let credential_with_key = Self::credential_for(&header.name, &identity, &header.signer)?;
        let mut groups = HashMap::new();
        for id in header.groups {
            let group = MlsGroup::load(provider.storage(), &GroupId::from_slice(id.as_bytes()))
                .map_err(|e| CoreError::Mls(format!("{e:?}")))?
                .ok_or_else(|| bad(&format!("group {id} missing from storage")))?;
            groups.insert(id, group);
        }
        Ok(Self {
            provider,
            identity,
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
            // The field is called `signer` because the bundle's format
            // predates the split; what it carries is the identity key.
            signer: clone_signer(&self.identity)?,
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
    ///
    /// `expected_identity` and `expected_key` bind the KeyPackage to the
    /// person the caller actually meant to add. This is load-bearing: the
    /// relay is what hands out KeyPackages, and `validate` below only checks
    /// a KeyPackage against *itself*. Without these two checks a relay can
    /// answer a `fetch_kp` for "bob" with one it minted, bearing
    /// `BasicCredential("bob")` — it becomes a real MLS member decrypting
    /// everything from this epoch forward while the roster still reads "bob".
    ///
    /// `expected_key` is the signature key the relay has pinned for that
    /// handle: the same key that authenticates their WebSocket and the one
    /// the safety number is computed over. That still means trusting the
    /// relay on first contact — this is TOFU, not proof. What it buys is
    /// that the relay must now lie *consistently*, and that the lie changes
    /// the safety number, so an out-of-band check can catch it. Paired with
    /// key-bound verification on the client, a substitution can no longer
    /// hide behind a ✓ that was granted for a different key.
    pub fn add_member(
        &mut self,
        id: &str,
        key_package_bytes: &[u8],
        expected_identity: &str,
        expected_key: &[u8],
    ) -> Result<AddResult, CoreError> {
        self.add_members(id, &[key_package_bytes], expected_identity, expected_key)
    }

    /// Add one account's devices in a single commit — every KeyPackage must
    /// belong to `expected_identity` under `expected_key`.
    ///
    /// One commit rather than one per device: a member with a laptop and a
    /// phone is one decision, and each commit re-keys the whole group. The
    /// single Welcome it produces opens on each of the added devices.
    ///
    /// `expected_key` is the account's IDENTITY key. Each KeyPackage has to
    /// carry a credential that names the handle and is certified by that
    /// key (or, for a device from before devices had keys of their own, be
    /// signed by it directly).
    pub fn add_members(
        &mut self,
        id: &str,
        key_packages: &[&[u8]],
        expected_identity: &str,
        expected_key: &[u8],
    ) -> Result<AddResult, CoreError> {
        if key_packages.is_empty() {
            return Err(CoreError::Mls("no key packages to add".into()));
        }
        let mut validated = Vec::with_capacity(key_packages.len());
        for bytes in key_packages {
            let kp_in = KeyPackageIn::tls_deserialize_exact(*bytes).map_err(CoreError::mls)?;
            let key_package = kp_in
                .validate(self.provider.crypto(), ProtocolVersion::Mls10)
                .map_err(CoreError::mls)?;
            let leaf = key_package.leaf_node();
            let claim =
                claim_of(self.provider.crypto(), leaf.credential(), leaf.signature_key().as_slice());
            let got = claim.as_ref().map(|c| c.name.clone());
            if got.as_deref() != Some(expected_identity) {
                return Err(CoreError::IdentityMismatch {
                    expected: expected_identity.to_string(),
                    got: got.unwrap_or_else(|| "<unverifiable credential>".to_string()),
                });
            }
            if claim.map(|c| c.identity_key).as_deref() != Some(expected_key) {
                return Err(CoreError::KeyMismatch(expected_identity.to_string()));
            }
            validated.push(key_package);
        }

        let group = self
            .groups
            .get_mut(id)
            .ok_or_else(|| CoreError::UnknownGroup(id.to_string()))?;
        // The caller's `expected_key` came from the relay. If this handle is
        // already in the group, the roster's answer outranks the relay's.
        for (name, key) in roster_identities(self.provider.crypto(), group) {
            if name == expected_identity && key != expected_key {
                return Err(CoreError::IdentityConflict(name));
            }
        }
        let (commit, welcome, _group_info) = group
            .add_members(&self.provider, &self.signer, &validated)
            .map_err(CoreError::mls)?;
        // Staged, NOT merged: see `merge_staged_commit`.
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
        // Every leaf under that name, not the first: a member is all of
        // their devices, and removing a person has to mean each one. A leaf
        // left behind keeps decrypting, under a name the roster no longer
        // shows.
        let targets: Vec<LeafNodeIndex> = group
            .members()
            .filter(|m| identity_of(&m.credential).as_deref() == Some(name))
            .map(|m| m.index)
            .collect();
        if targets.is_empty() {
            return Err(CoreError::Mls(format!("no member named {name}")));
        }
        let (commit, _welcome, _group_info) = group
            .remove_members(&self.provider, &self.signer, &targets)
            .map_err(CoreError::mls)?;
        // Staged, NOT merged: see `merge_staged_commit`.
        commit.tls_serialize_detached().map_err(CoreError::mls)
    }

    /// Merge the commit staged by `add_member`/`remove_member`, moving the
    /// group to its next epoch.
    ///
    /// Commits used to be merged the instant they were created, before the
    /// relay had accepted them. Two admins acting in the same second both
    /// merged locally and both published, so each held a *different* epoch
    /// N+1 and could never decrypt the other again — an unrecoverable fork
    /// with no detection. Staging makes the relay's ordered log the
    /// serializer: exactly one commit per epoch is accepted, and only the
    /// winner merges. The loser calls `discard_staged_commit`, processes the
    /// winning commit like any other member, and retries.
    pub fn merge_staged_commit(&mut self, id: &str) -> Result<u64, CoreError> {
        let group = self
            .groups
            .get_mut(id)
            .ok_or_else(|| CoreError::UnknownGroup(id.to_string()))?;
        group.merge_pending_commit(&self.provider).map_err(CoreError::mls)?;
        Ok(group.epoch().as_u64())
    }

    /// Drop a staged commit the relay refused. The group stays exactly where
    /// it was, so the commit that won the epoch can be processed normally.
    pub fn discard_staged_commit(&mut self, id: &str) -> Result<(), CoreError> {
        let group = self
            .groups
            .get_mut(id)
            .ok_or_else(|| CoreError::UnknownGroup(id.to_string()))?;
        group
            .clear_pending_commit(self.provider.storage())
            .map_err(|e| CoreError::Mls(format!("{e:?}")))
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
        // Over the two ACCOUNT identity keys, not device keys: the number a
        // pair compared on their laptops has to be the number their phones
        // show, and must not change when either of them adds a device.
        let peer_key = roster_identities(self.provider.crypto(), group)
            .into_iter()
            .find(|(name, _)| name == peer)
            .map(|(_, key)| key)
            .ok_or_else(|| CoreError::Mls(format!("no member named {peer}")))?;
        let mut parties = [
            (self.name.as_bytes().to_vec(), self.identity.public().to_vec()),
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
                // Before the merge, never after: once merged, the leaf is in
                // the roster and every reader has already taken its word.
                check_commit_identities(provider.crypto(), group, &staged)?;
                group
                    .merge_staged_commit(provider, *staged)
                    .map_err(CoreError::mls)?;
                let epoch = group.epoch().as_u64();
                let members = members_of(group);
                let active = group.is_active();
                Ok(Event::MembershipChange { group: id, epoch, sender, members, active })
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
            // OpenMLS 0.9 reports our own messages fanned back by the relay
            // as successes; 0.7 rejected them. Both stay errors here, because
            // the controller reads a successful decrypt as proof that the
            // ratchet is still shared with the sender (it clears fork
            // suspicion), and neither of these proves that. Merging our own
            // staged commit remains `merge_staged_commit`'s job, driven by the
            // relay's ack — never by an echo.
            ProcessedMessageContent::OwnPendingCommit => {
                Err(CoreError::Mls("own pending commit echoed back".into()))
            }
            ProcessedMessageContent::OwnPrivateMessage => {
                Err(CoreError::Mls("cannot decrypt own message".into()))
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

/// The verified (handle, identity key) of every leaf in the group, in tree
/// order — one entry per device. Leaves whose credential does not verify
/// are left out.
fn roster_identities(crypto: &impl OpenMlsCrypto, group: &MlsGroup) -> Vec<(String, Vec<u8>)> {
    group
        .members()
        .filter_map(|m| {
            let claim = claim_of(crypto, &m.credential, &m.signature_key)?;
            Some((claim.name, claim.identity_key))
        })
        .collect()
}

/// Refuse a commit that would let one name mean two accounts.
///
/// A credential is a self-asserted string: MLS proves that a leaf's messages
/// were signed by that leaf's key, and nothing about whether the name on it
/// is true. `add_members` checks the people it adds against what the relay
/// has pinned — but that runs on one device, for one path. Everyone else
/// merged whatever commit arrived, and an invite-link join (an external
/// commit, built by the joiner) was checked by nobody. So a link holder
/// could join as "alice", sit in the roster beside the real one, and have
/// their messages attributed to her.
///
/// The rule, applied to every leaf a commit introduces or rewrites — added
/// members, the committer's own path leaf (which for an external commit *is*
/// the joiner), and updates:
///
/// 1. Its credential must verify: either a bare handle (the leaf key is the
///    identity key) or a handle plus an identity key that has signed this
///    leaf's key.
/// 2. If that handle is already in the group, the identity key must be the
///    one the group already knows it by.
///
/// Together those mean a handle maps to one identity key for as long as it
/// is in the group, and that a second leaf under a handle is a device its
/// owner's identity key authorized — which is what lets any member, not
/// just the account's own devices, safely add it.
///
/// A leaf being removed in the same commit is deliberately not exempt:
/// exempting removals would turn "join beside alice" into "replace alice".
fn check_commit_identities(
    crypto: &impl OpenMlsCrypto,
    group: &MlsGroup,
    staged: &StagedCommit,
) -> Result<(), CoreError> {
    // Owned claims: the proposal iterators hand out short-lived wrappers,
    // so nothing borrowed from them outlives the closure.
    let claim = |leaf: &LeafNode| {
        (
            identity_of(leaf.credential()),
            claim_of(crypto, leaf.credential(), leaf.signature_key().as_slice()),
        )
    };
    let mut incoming: Vec<(Option<String>, Option<Claim>)> = staged
        .add_proposals()
        .map(|p| claim(p.add_proposal().key_package().leaf_node()))
        .collect();
    incoming.extend(staged.update_proposals().map(|p| claim(p.update_proposal().leaf_node())));
    incoming.extend(staged.update_path_leaf_node().map(claim));

    let mut known = roster_identities(crypto, group);
    for (name, claim) in incoming {
        let Some(claim) = claim else {
            // Named, but not certified by the key it names: somebody put a
            // handle on a device its owner never authorized.
            return Err(match name.filter(|n| !n.is_empty()) {
                Some(name) => CoreError::IdentityConflict(name),
                None => CoreError::Mls("a commit carried a leaf with no identity".into()),
            });
        };
        if known.iter().any(|(n, k)| *n == claim.name && *k != claim.identity_key) {
            return Err(CoreError::IdentityConflict(claim.name));
        }
        // Later leaves in the same commit are held to this one too.
        known.push((claim.name, claim.identity_key));
    }
    Ok(())
}

/// The group's members by handle, each once, in the order they first
/// appear in the tree. A member with three devices is one member.
fn members_of(group: &MlsGroup) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    for name in group.members().filter_map(|m| identity_of(&m.credential)) {
        if !names.contains(&name) {
            names.push(name);
        }
    }
    names
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

/// The handle a credential names — the part before the first NUL, or all
/// of it for a bare-handle credential. Unverified: this says what the leaf
/// *claims*, which is enough to display or to match a name against, and not
/// enough to trust a key by. `claim_of` is the one that checks.
fn identity_of(credential: &Credential) -> Option<String> {
    let basic = BasicCredential::try_from(credential.clone()).ok()?;
    let bytes = basic.identity();
    let name = bytes.split(|b| *b == 0).next().unwrap_or(bytes);
    Some(String::from_utf8_lossy(name).into_owned())
}

// SignatureKeyPair is serde-serializable but not Clone (without a feature
// flag); round-trip through serde where a owned copy is needed.
fn clone_signer(signer: &SignatureKeyPair) -> Result<SignatureKeyPair, CoreError> {
    serde_json::from_slice(&serde_json::to_vec(signer).map_err(CoreError::mls)?)
        .map_err(CoreError::mls)
}
