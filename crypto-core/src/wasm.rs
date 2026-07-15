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
        Ok(Client {
            inner: ChatClient::new(name)?,
        })
    }

    #[wasm_bindgen(js_name = keyPackage)]
    pub fn key_package(&self) -> Result<Vec<u8>, JsError> {
        Ok(self.inner.key_package()?)
    }

    #[wasm_bindgen(js_name = createGroup)]
    pub fn create_group(&mut self) -> Result<(), JsError> {
        Ok(self.inner.create_group()?)
    }

    #[wasm_bindgen(js_name = addMember)]
    pub fn add_member(&mut self, key_package: &[u8]) -> Result<AddResult, JsError> {
        let r = self.inner.add_member(key_package)?;
        Ok(AddResult {
            commit: r.commit,
            welcome: r.welcome,
        })
    }

    #[wasm_bindgen(js_name = removeMember)]
    pub fn remove_member(&mut self, name: &str) -> Result<Vec<u8>, JsError> {
        Ok(self.inner.remove_member(name)?)
    }

    #[wasm_bindgen(js_name = joinFromWelcome)]
    pub fn join_from_welcome(&mut self, welcome: &[u8]) -> Result<(), JsError> {
        Ok(self.inner.join_from_welcome(welcome)?)
    }

    /// Encrypt `text`; returns the serialized MLS message for the relay.
    pub fn send(&mut self, text: &str) -> Result<Vec<u8>, JsError> {
        Ok(self.inner.send_message(text)?)
    }

    /// Process an incoming MLS blob; returns an event object:
    /// {kind: "message", sender, text, epoch} |
    /// {kind: "membershipChange", epoch, members} |
    /// {kind: "proposalStored", epoch}
    pub fn receive(&mut self, bytes: &[u8]) -> Result<JsValue, JsError> {
        let event = self.inner.process_incoming(bytes)?;
        Ok(serde_wasm_bindgen::to_value(&event)?)
    }

    pub fn epoch(&self) -> Result<u64, JsError> {
        Ok(self.inner.epoch()?)
    }

    pub fn members(&self) -> Result<Vec<String>, JsError> {
        Ok(self.inner.members()?)
    }
}
