//! wasm-bindgen boundary. Thin conversion layer only — all MLS logic lives
//! in `crate::client`. This runs inside a Web Worker; the UI thread never
//! sees key material, only serialized ciphertext blobs and decrypted events.

use crate::client::ChatClient;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct AddResult {
    commit: Vec<u8>,
    welcome: Vec<u8>,
}

#[wasm_bindgen]
impl AddResult {
    #[wasm_bindgen(getter)]
    pub fn commit(&self) -> Vec<u8> {
        self.commit.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn welcome(&self) -> Vec<u8> {
        self.welcome.clone()
    }
}

#[wasm_bindgen]
pub struct Client {
    inner: ChatClient,
}

#[wasm_bindgen]
impl Client {
    #[wasm_bindgen(constructor)]
    pub fn new(name: &str) -> Result<Client, JsError> {
        Ok(Client { inner: ChatClient::new(name)? })
    }

    /// Rebuild from a full state snapshot (IndexedDB, same device).
    #[wasm_bindgen(js_name = fromState)]
    pub fn from_state(bytes: &[u8]) -> Result<Client, JsError> {
        Ok(Client { inner: ChatClient::import_state(bytes)? })
    }

    /// Rebuild from an identity-only recovery bundle (no group state).
    #[wasm_bindgen(js_name = fromIdentity)]
    pub fn from_identity(bytes: &[u8]) -> Result<Client, JsError> {
        Ok(Client { inner: ChatClient::import_identity(bytes)? })
    }

    #[wasm_bindgen(getter)]
    pub fn name(&self) -> String {
        self.inner.name().to_string()
    }

    #[wasm_bindgen(js_name = exportState)]
    pub fn export_state(&self) -> Result<Vec<u8>, JsError> {
        Ok(self.inner.export_state()?)
    }

    #[wasm_bindgen(js_name = exportIdentity)]
    pub fn export_identity(&self) -> Result<Vec<u8>, JsError> {
        Ok(self.inner.export_identity()?)
    }

    #[wasm_bindgen(js_name = groupIds)]
    pub fn group_ids(&self) -> Vec<String> {
        self.inner.group_ids()
    }

    #[wasm_bindgen(js_name = keyPackage)]
    pub fn key_package(&self) -> Result<Vec<u8>, JsError> {
        Ok(self.inner.key_package()?)
    }

    #[wasm_bindgen(js_name = signaturePublicKey)]
    pub fn signature_public_key(&self) -> Vec<u8> {
        self.inner.signature_public_key()
    }

    pub fn sign(&self, message: &[u8]) -> Result<Vec<u8>, JsError> {
        Ok(self.inner.sign(message)?)
    }

    #[wasm_bindgen(js_name = createGroup)]
    pub fn create_group(&mut self, id: &str) -> Result<(), JsError> {
        Ok(self.inner.create_group(id)?)
    }

    #[wasm_bindgen(js_name = addMember)]
    pub fn add_member(&mut self, id: &str, key_package: &[u8]) -> Result<AddResult, JsError> {
        let r = self.inner.add_member(id, key_package)?;
        Ok(AddResult { commit: r.commit, welcome: r.welcome })
    }

    #[wasm_bindgen(js_name = removeMember)]
    pub fn remove_member(&mut self, id: &str, name: &str) -> Result<Vec<u8>, JsError> {
        Ok(self.inner.remove_member(id, name)?)
    }

    /// Join from a Welcome; returns the joined group's id.
    #[wasm_bindgen(js_name = joinFromWelcome)]
    pub fn join_from_welcome(&mut self, welcome: &[u8]) -> Result<String, JsError> {
        Ok(self.inner.join_from_welcome(welcome)?)
    }

    #[wasm_bindgen(js_name = forgetGroup)]
    pub fn forget_group(&mut self, id: &str) {
        self.inner.forget_group(id);
    }

    /// Encrypt `text`; returns the serialized MLS message for the relay.
    pub fn send(&mut self, id: &str, text: &str) -> Result<Vec<u8>, JsError> {
        Ok(self.inner.send_message(id, text)?)
    }

    /// Process an incoming MLS blob; returns an event object:
    /// {kind: "message", group, sender, text, epoch} |
    /// {kind: "membershipChange", group, epoch, members} |
    /// {kind: "proposalStored", group, epoch}
    pub fn receive(&mut self, bytes: &[u8]) -> Result<JsValue, JsError> {
        let event = self.inner.process_incoming(bytes)?;
        Ok(serde_wasm_bindgen::to_value(&event)?)
    }

    pub fn epoch(&self, id: &str) -> Result<u64, JsError> {
        Ok(self.inner.epoch(id)?)
    }

    pub fn members(&self, id: &str) -> Result<Vec<String>, JsError> {
        Ok(self.inner.members(id)?)
    }
}
