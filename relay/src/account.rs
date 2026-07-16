//! Account vaults: sign-in from a new device without moving key files.
//!
//! The vault is the user's identity bundle encrypted CLIENT-SIDE — under
//! the wrap half of Argon2id(password) or a passkey's PRF output. The
//! relay gates *retrieval* (password verifier hash, or a verified
//! WebAuthn assertion) but can never decrypt what it hands out. Honest
//! caveat, stated in the docs too: for the password kind, the relay
//! could brute-force weak passwords offline against the blob; the
//! passkey kind has no such surface.

use crate::server::App;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use webauthn_rs::prelude::*;

pub struct AccountService {
    pub webauthn: Webauthn,
    reg_states: Mutex<HashMap<String, (PasskeyRegistration, Instant)>>,
    auth_states: Mutex<HashMap<String, (PasskeyAuthentication, Instant)>>,
}

const STATE_TTL: Duration = Duration::from_secs(300);

impl AccountService {
    /// RP_ID must be the domain the CLIENT is served from (not the relay's,
    /// if they differ); RP_ORIGIN its full origin.
    pub fn from_env() -> Self {
        let rp_id = std::env::var("RP_ID").unwrap_or_else(|_| "localhost".into());
        let rp_origin = std::env::var("RP_ORIGIN")
            .unwrap_or_else(|_| format!("http://{rp_id}:9601"));
        let origin = Url::parse(&rp_origin).expect("RP_ORIGIN must be a valid URL");
        let webauthn = WebauthnBuilder::new(&rp_id, &origin)
            .expect("invalid RP configuration")
            .rp_name("quorum")
            .build()
            .expect("webauthn build");
        Self {
            webauthn,
            reg_states: Mutex::new(HashMap::new()),
            auth_states: Mutex::new(HashMap::new()),
        }
    }

    fn user_uuid(user: &str) -> Uuid {
        let hash = Sha256::digest(user.as_bytes());
        Uuid::from_slice(&hash[..16]).unwrap()
    }

    pub fn start_registration(&self, user: &str) -> Result<String, String> {
        let (ccr, state) = self
            .webauthn
            .start_passkey_registration(Self::user_uuid(user), user, user, None)
            .map_err(|e| e.to_string())?;
        let mut states = self.reg_states.lock().unwrap();
        states.retain(|_, (_, t)| t.elapsed() < STATE_TTL);
        states.insert(user.to_string(), (state, Instant::now()));
        serde_json::to_string(&ccr).map_err(|e| e.to_string())
    }

    pub fn finish_registration(&self, user: &str, credential_json: &str) -> Result<String, String> {
        let (state, _) = self
            .reg_states
            .lock()
            .unwrap()
            .remove(user)
            .ok_or("no registration in progress (expired?)")?;
        let credential: RegisterPublicKeyCredential =
            serde_json::from_str(credential_json).map_err(|e| e.to_string())?;
        let passkey = self
            .webauthn
            .finish_passkey_registration(&credential, &state)
            .map_err(|e| e.to_string())?;
        serde_json::to_string(&passkey).map_err(|e| e.to_string())
    }

    pub fn start_authentication(&self, user: &str, passkey_json: &str) -> Result<String, String> {
        let passkey: Passkey = serde_json::from_str(passkey_json).map_err(|e| e.to_string())?;
        let (rcr, state) = self
            .webauthn
            .start_passkey_authentication(&[passkey])
            .map_err(|e| e.to_string())?;
        let mut states = self.auth_states.lock().unwrap();
        states.retain(|_, (_, t)| t.elapsed() < STATE_TTL);
        states.insert(user.to_string(), (state, Instant::now()));
        serde_json::to_string(&rcr).map_err(|e| e.to_string())
    }

    pub fn finish_authentication(&self, user: &str, assertion_json: &str) -> Result<(), String> {
        let (state, _) = self
            .auth_states
            .lock()
            .unwrap()
            .remove(user)
            .ok_or("no authentication in progress (expired?)")?;
        let assertion: PublicKeyCredential =
            serde_json::from_str(assertion_json).map_err(|e| e.to_string())?;
        self.webauthn
            .finish_passkey_authentication(&assertion, &state)
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
}

pub fn verifier_of(auth_key: &[u8]) -> Vec<u8> {
    Sha256::digest(auth_key).to_vec()
}

// === HTTP handlers (pre-auth: a new device has no identity key yet) ======

fn err(status: StatusCode, message: impl Into<String>) -> Response {
    (status, message.into()).into_response()
}

/// Public probe: which sign-in kind (and salt) a username uses. Leaks
/// username existence — acceptable for this product; documented.
pub async fn params(Path(user): Path<String>, State(app): State<Arc<App>>) -> Response {
    match app.store.get_vault(&user).await {
        Ok(Some(vault)) => Json(json!({
            "kind": vault.kind,
            "salt": B64.encode(&vault.salt),
        }))
        .into_response(),
        Ok(None) => err(StatusCode::NOT_FOUND, "no vault for that user"),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[derive(serde::Deserialize)]
pub struct PasswordLogin {
    pub auth_key: String,
}

pub async fn password_login(
    Path(user): Path<String>,
    State(app): State<Arc<App>>,
    Json(body): Json<PasswordLogin>,
) -> Response {
    let Ok(auth_key) = B64.decode(&body.auth_key) else {
        return err(StatusCode::BAD_REQUEST, "bad base64");
    };
    match app.store.get_vault(&user).await {
        Ok(Some(vault)) if vault.kind == "password" => {
            // Constant-time: both sides are SHA-256 digests, so a timing
            // oracle would leak little — but ct_eq costs nothing.
            if bool::from(subtle::ConstantTimeEq::ct_eq(
                verifier_of(&auth_key).as_slice(),
                vault.verifier.as_slice(),
            )) {
                Json(json!({ "wrapped": B64.encode(&vault.wrapped) })).into_response()
            } else {
                err(StatusCode::FORBIDDEN, "wrong password")
            }
        }
        Ok(Some(_)) => err(StatusCode::BAD_REQUEST, "vault is not password-based"),
        Ok(None) => err(StatusCode::NOT_FOUND, "no vault for that user"),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

pub async fn passkey_challenge(Path(user): Path<String>, State(app): State<Arc<App>>) -> Response {
    match app.store.get_vault(&user).await {
        Ok(Some(vault)) if vault.kind == "passkey" => {
            let Some(credential) = vault.credential else {
                return err(StatusCode::INTERNAL_SERVER_ERROR, "vault missing credential");
            };
            match app.accounts.start_authentication(&user, &credential) {
                Ok(rcr) => (
                    StatusCode::OK,
                    [(axum::http::header::CONTENT_TYPE, "application/json")],
                    rcr,
                )
                    .into_response(),
                Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e),
            }
        }
        Ok(Some(_)) => err(StatusCode::BAD_REQUEST, "vault is not passkey-based"),
        Ok(None) => err(StatusCode::NOT_FOUND, "no vault for that user"),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[derive(serde::Deserialize)]
pub struct PasskeyLogin {
    /// The PublicKeyCredential assertion, JSON-serialized by the client.
    pub assertion: serde_json::Value,
}

pub async fn passkey_login(
    Path(user): Path<String>,
    State(app): State<Arc<App>>,
    Json(body): Json<PasskeyLogin>,
) -> Response {
    match app.accounts.finish_authentication(&user, &body.assertion.to_string()) {
        Ok(()) => match app.store.get_vault(&user).await {
            Ok(Some(vault)) => Json(json!({ "wrapped": B64.encode(&vault.wrapped) })).into_response(),
            Ok(None) => err(StatusCode::NOT_FOUND, "no vault for that user"),
            Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
        },
        Err(e) => err(StatusCode::FORBIDDEN, e),
    }
}
