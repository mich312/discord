//! Pure-Rust MLS client core. No wasm types here — this module is exercised
//! by native integration tests; `crate::wasm` wraps it for the browser.

use openmls::prelude::*;
use openmls_basic_credential::SignatureKeyPair;
use openmls_traits::signatures::Signer;
use openmls_rust_crypto::OpenMlsRustCrypto;
use serde::{Deserialize, Serialize};
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
    #[error("not in a group")]
    NoGroup,
    #[error("already in a group")]
    AlreadyInGroup,
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
    Message { sender: String, text: String, epoch: u64 },
    /// A commit was merged; the group moved to a new epoch.
    #[serde(rename_all = "camelCase")]
    MembershipChange { epoch: u64, members: Vec<String> },
    /// A proposal was queued; nothing user-visible yet.
    #[serde(rename_all = "camelCase")]
    ProposalStored { epoch: u64 },
}

/// Result of adding a member: both blobs must reach the relay —
/// `commit` fans out to existing members, `welcome` goes to the joiner.
pub struct AddResult {
    pub commit: Vec<u8>,
    pub welcome: Vec<u8>,
}

pub struct ChatClient {
    provider: OpenMlsRustCrypto,
    signer: SignatureKeyPair,
    credential_with_key: CredentialWithKey,
    group: Option<MlsGroup>,
    name: String,
}

impl ChatClient {
    pub fn new(name: &str) -> Result<Self, CoreError> {
        let provider = OpenMlsRustCrypto::default();
        let credential = BasicCredential::new(name.as_bytes().to_vec());
        let signer = SignatureKeyPair::new(CIPHERSUITE.signature_algorithm())
            .map_err(CoreError::mls)?;
        signer.store(provider.storage()).map_err(CoreError::mls)?;
        let credential_with_key = CredentialWithKey {
            credential: credential.into(),
            signature_key: signer.public().into(),
        };
        Ok(Self {
            provider,
            signer,
            credential_with_key,
            group: None,
            name: name.to_string(),
        })
    }

    pub fn name(&self) -> &str {
        &self.name
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

    /// Create a new group with this client as the only member.
    pub fn create_group(&mut self) -> Result<(), CoreError> {
        if self.group.is_some() {
            return Err(CoreError::AlreadyInGroup);
        }
        // The ratchet-tree extension keeps Welcomes self-contained, so the
        // relay never needs to serve the tree out of band.
        let config = MlsGroupCreateConfig::builder()
            .ciphersuite(CIPHERSUITE)
            .use_ratchet_tree_extension(true)
            .max_past_epochs(MAX_PAST_EPOCHS)
            .build();
        let group = MlsGroup::new(
            &self.provider,
            &self.signer,
            &config,
            self.credential_with_key.clone(),
        )
        .map_err(CoreError::mls)?;
        self.group = Some(group);
        Ok(())
    }

    /// Add a member from their serialized KeyPackage. Returns the commit
    /// (for the group) and the Welcome (for the joiner), both serialized.
    pub fn add_member(&mut self, key_package_bytes: &[u8]) -> Result<AddResult, CoreError> {
        let group = self.group.as_mut().ok_or(CoreError::NoGroup)?;
        let kp_in = KeyPackageIn::tls_deserialize_exact(key_package_bytes)
            .map_err(CoreError::mls)?;
        let key_package = kp_in
            .validate(self.provider.crypto(), ProtocolVersion::Mls10)
            .map_err(CoreError::mls)?;
        let (commit, welcome, _group_info) = group
            .add_members(&self.provider, &self.signer, &[key_package])
            .map_err(CoreError::mls)?;
        group
            .merge_pending_commit(&self.provider)
            .map_err(CoreError::mls)?;
        Ok(AddResult {
            commit: commit.tls_serialize_detached().map_err(CoreError::mls)?,
            welcome: welcome.tls_serialize_detached().map_err(CoreError::mls)?,
        })
    }

    /// Remove a member by name. Returns the serialized commit for fan-out.
    pub fn remove_member(&mut self, name: &str) -> Result<Vec<u8>, CoreError> {
        let group = self.group.as_mut().ok_or(CoreError::NoGroup)?;
        let target = group
            .members()
            .find(|m| identity_of(&m.credential).as_deref() == Some(name))
            .ok_or_else(|| CoreError::Mls(format!("no member named {name}")))?;
        let (commit, _welcome, _group_info) = group
            .remove_members(&self.provider, &self.signer, &[target.index])
            .map_err(CoreError::mls)?;
        group
            .merge_pending_commit(&self.provider)
            .map_err(CoreError::mls)?;
        commit.tls_serialize_detached().map_err(CoreError::mls)
    }

    /// Join a group from a serialized Welcome message.
    pub fn join_from_welcome(&mut self, welcome_bytes: &[u8]) -> Result<(), CoreError> {
        if self.group.is_some() {
            return Err(CoreError::AlreadyInGroup);
        }
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
        self.group = Some(group);
        Ok(())
    }

    /// Encrypt an application message for the group's current epoch.
    pub fn send_message(&mut self, text: &str) -> Result<Vec<u8>, CoreError> {
        let group = self.group.as_mut().ok_or(CoreError::NoGroup)?;
        let message = group
            .create_message(&self.provider, &self.signer, text.as_bytes())
            .map_err(CoreError::mls)?;
        message.tls_serialize_detached().map_err(CoreError::mls)
    }

    /// Process an incoming MLS message from the relay: decrypts application
    /// messages, merges commits, stores proposals.
    pub fn process_incoming(&mut self, bytes: &[u8]) -> Result<Event, CoreError> {
        let group = self.group.as_mut().ok_or(CoreError::NoGroup)?;
        let message = MlsMessageIn::tls_deserialize_exact(bytes).map_err(CoreError::mls)?;
        let protocol_message: ProtocolMessage = message
            .try_into_protocol_message()
            .map_err(CoreError::mls)?;
        let processed = group
            .process_message(&self.provider, protocol_message)
            .map_err(CoreError::mls)?;
        let sender = identity_of(processed.credential()).unwrap_or_default();

        match processed.into_content() {
            ProcessedMessageContent::ApplicationMessage(app) => {
                let text = String::from_utf8_lossy(&app.into_bytes()).into_owned();
                Ok(Event::Message {
                    sender,
                    text,
                    epoch: group.epoch().as_u64(),
                })
            }
            ProcessedMessageContent::StagedCommitMessage(staged) => {
                group
                    .merge_staged_commit(&self.provider, *staged)
                    .map_err(CoreError::mls)?;
                Ok(Event::MembershipChange {
                    epoch: group.epoch().as_u64(),
                    members: self.members()?,
                })
            }
            ProcessedMessageContent::ProposalMessage(proposal) => {
                group
                    .store_pending_proposal(self.provider.storage(), *proposal)
                    .map_err(CoreError::mls)?;
                Ok(Event::ProposalStored {
                    epoch: group.epoch().as_u64(),
                })
            }
            ProcessedMessageContent::ExternalJoinProposalMessage(proposal) => {
                group
                    .store_pending_proposal(self.provider.storage(), *proposal)
                    .map_err(CoreError::mls)?;
                Ok(Event::ProposalStored {
                    epoch: group.epoch().as_u64(),
                })
            }
        }
    }

    pub fn epoch(&self) -> Result<u64, CoreError> {
        Ok(self
            .group
            .as_ref()
            .ok_or(CoreError::NoGroup)?
            .epoch()
            .as_u64())
    }

    pub fn members(&self) -> Result<Vec<String>, CoreError> {
        let group = self.group.as_ref().ok_or(CoreError::NoGroup)?;
        Ok(group
            .members()
            .filter_map(|m| identity_of(&m.credential))
            .collect())
    }
}

fn identity_of(credential: &Credential) -> Option<String> {
    BasicCredential::try_from(credential.clone())
        .ok()
        .map(|c| String::from_utf8_lossy(c.identity()).into_owned())
}
