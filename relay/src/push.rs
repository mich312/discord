//! Web Push: nudge offline members' devices when something lands for them.
//! Payloads are minimal metadata the relay already knows (the group id) —
//! message content never appears here; the push service additionally only
//! sees the standard aes128gcm-encrypted envelope.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use p256::elliptic_curve::sec1::ToEncodedPoint;
use web_push::{
    ContentEncoding, HyperWebPushClient, SubscriptionInfo, VapidSignatureBuilder,
    WebPushClient, WebPushMessageBuilder,
};

pub struct PushService {
    private_b64: String,
    /// Uncompressed P-256 point, base64url — what the browser passes as
    /// `applicationServerKey`.
    pub public_b64: String,
    client: HyperWebPushClient,
}

impl PushService {
    /// Resolve the VAPID key in priority order:
    ///   1. `VAPID_PRIVATE_KEY` (base64url raw scalar) — an explicit,
    ///      host-portable operator override.
    ///   2. An auto-managed key persisted at `VAPID_KEY_FILE` (set in the
    ///      container image to a path on the data volume). Generated once and
    ///      reused on every restart, so push subscriptions survive redeploys
    ///      even when the operator never sets `VAPID_PRIVATE_KEY`.
    ///   3. A freshly generated ephemeral key — only when neither is available
    ///      (dev, tests, in-memory runs). Dies with the process.
    ///
    /// The key never rotating across restarts is what keeps push working:
    /// browsers bind a subscription to the advertised `applicationServerKey`
    /// (this key's public half), and the push service rejects everything —
    /// registrations included — once that key changes underneath them.
    ///
    /// A malformed `VAPID_PRIVATE_KEY` never aborts startup: push is an
    /// auxiliary "nudge offline devices" feature, so we log a loud error and
    /// fall back to the persisted/ephemeral key rather than crash-looping the
    /// whole relay (messaging, groups, blobs) over a misconfigured push key.
    pub fn from_env() -> Self {
        let (private_b64, secret) = Self::load_key();
        let public_b64 =
            URL_SAFE_NO_PAD.encode(secret.public_key().to_encoded_point(false).as_bytes());
        Self { private_b64, public_b64, client: HyperWebPushClient::new() }
    }

    fn load_key() -> (String, p256::SecretKey) {
        // 1. Operator-supplied key wins — explicit and portable across hosts.
        match std::env::var("VAPID_PRIVATE_KEY") {
            Ok(v) if !v.trim().is_empty() => match Self::parse_key(&v) {
                // Store the trimmed key so `send`'s `from_base64` sees exactly
                // what `parse_key` validated (no stray whitespace/newline).
                Ok(secret) => return (v.trim().to_string(), secret),
                Err(e) => tracing::error!(
                    "VAPID_PRIVATE_KEY is set but invalid ({e}); ignoring it. Expected \
                     base64url (no padding) of a 32-byte raw P-256 scalar. Falling back \
                     to the on-disk key (or an ephemeral one)."
                ),
            },
            _ => {}
        }

        // 2. Auto-managed, persisted key — durable across restarts without any
        //    operator action. Only active when VAPID_KEY_FILE points somewhere
        //    (the container image sets it to the data volume); dev and tests
        //    leave it unset and stay ephemeral, exactly as before.
        if let Some(path) = Self::key_file_path() {
            if let Some(secret) = Self::read_key_file(&path) {
                return (URL_SAFE_NO_PAD.encode(secret.to_bytes()), secret);
            }
            let key = p256::SecretKey::random(&mut rand::rngs::OsRng);
            let b64 = URL_SAFE_NO_PAD.encode(key.to_bytes());
            match Self::write_key_file(&path, &b64) {
                Ok(()) => tracing::info!(
                    "Generated a new VAPID key and persisted it to {} — push \
                     subscriptions will now survive restarts.",
                    path.display()
                ),
                Err(e) => tracing::error!(
                    "Generated a VAPID key but could not persist it to {} ({e}); it will \
                     rotate on the next restart. Set VAPID_PRIVATE_KEY to a durable key.",
                    path.display()
                ),
            }
            return (b64, key);
        }

        // 3. Nothing to persist to: ephemeral (unchanged dev/test behavior).
        tracing::warn!(
            "VAPID_PRIVATE_KEY not set and no VAPID_KEY_FILE — generated an ephemeral \
             key (push subscriptions will not survive restarts)"
        );
        let key = p256::SecretKey::random(&mut rand::rngs::OsRng);
        let b64 = URL_SAFE_NO_PAD.encode(key.to_bytes());
        (b64, key)
    }

    fn parse_key(private_b64: &str) -> Result<p256::SecretKey, String> {
        let bytes = URL_SAFE_NO_PAD
            .decode(private_b64.trim())
            .map_err(|e| format!("bad base64url: {e}"))?;
        p256::SecretKey::from_slice(&bytes).map_err(|e| format!("not a valid P-256 scalar: {e}"))
    }

    /// Where the auto-managed key lives, or `None` to stay ephemeral. Blank is
    /// treated as unset so `VAPID_KEY_FILE=` doesn't point at "".
    fn key_file_path() -> Option<std::path::PathBuf> {
        match std::env::var("VAPID_KEY_FILE") {
            Ok(v) if !v.trim().is_empty() => Some(std::path::PathBuf::from(v.trim())),
            _ => None,
        }
    }

    /// Read and validate a persisted key. `None` (regenerate) when the file is
    /// absent — the first-run case — or holds something that isn't a key.
    fn read_key_file(path: &std::path::Path) -> Option<p256::SecretKey> {
        let contents = std::fs::read_to_string(path).ok()?;
        match Self::parse_key(&contents) {
            Ok(secret) => Some(secret),
            Err(e) => {
                tracing::error!(
                    "VAPID key file {} is not a usable key ({e}); regenerating it.",
                    path.display()
                );
                None
            }
        }
    }

    /// Persist the base64url scalar, creating parent dirs and tightening perms
    /// — the private scalar is a server secret sitting on the data volume.
    fn write_key_file(path: &std::path::Path, private_b64: &str) -> std::io::Result<()> {
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)?;
            }
        }
        std::fs::write(path, private_b64)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
        }
        Ok(())
    }

    /// Send `payload` to one subscription. Returns Ok(false) when the
    /// subscription is dead (endpoint gone) and should be dropped.
    pub async fn send(&self, subscription_json: &str, payload: &[u8]) -> Result<bool, String> {
        let subscription: SubscriptionInfo =
            serde_json::from_str(subscription_json).map_err(|e| e.to_string())?;
        let signature = VapidSignatureBuilder::from_base64(&self.private_b64, &subscription)
            .map_err(|e| e.to_string())?
            .build()
            .map_err(|e| e.to_string())?;
        let mut builder = WebPushMessageBuilder::new(&subscription);
        builder.set_payload(ContentEncoding::Aes128Gcm, payload);
        builder.set_vapid_signature(signature);
        let message = builder.build().map_err(|e| e.to_string())?;
        match self.client.send(message).await {
            Ok(()) => Ok(true),
            Err(web_push::WebPushError::EndpointNotFound(_))
            | Err(web_push::WebPushError::EndpointNotValid(_)) => Ok(false),
            Err(e) => Err(e.to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_key_rejects_bad_base64() {
        assert!(PushService::parse_key("not base64!!!").is_err());
    }

    #[test]
    fn parse_key_rejects_non_scalar() {
        // Valid base64url, but the wrong length for a raw P-256 scalar
        // (e.g. a PEM/DER key or public key pasted by mistake).
        let too_short = URL_SAFE_NO_PAD.encode([0u8; 16]);
        assert!(PushService::parse_key(&too_short).is_err());
    }

    #[test]
    fn parse_key_round_trips_generated_key() {
        let key = p256::SecretKey::random(&mut rand::rngs::OsRng);
        let b64 = URL_SAFE_NO_PAD.encode(key.to_bytes());
        // Trailing whitespace (a stray newline from `$(cat key)`) is tolerated.
        let parsed = PushService::parse_key(&format!("{b64}\n")).expect("valid key");
        assert_eq!(parsed.to_bytes(), key.to_bytes());
    }

    #[test]
    fn key_file_round_trips_and_survives_reload() {
        let mut path = std::env::temp_dir();
        path.push(format!("quorum-vapid-roundtrip-{}.key", std::process::id()));
        let _ = std::fs::remove_file(&path);

        let key = p256::SecretKey::random(&mut rand::rngs::OsRng);
        let b64 = URL_SAFE_NO_PAD.encode(key.to_bytes());
        PushService::write_key_file(&path, &b64).expect("persist key");

        // A "restart" reads the same scalar back — the whole point: the
        // advertised applicationServerKey must not change across boots.
        let reloaded = PushService::read_key_file(&path).expect("reload a valid key");
        assert_eq!(reloaded.to_bytes(), key.to_bytes());

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "private key file must be 0600");
        }
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn read_key_file_regenerates_on_absent_or_garbage() {
        let mut missing = std::env::temp_dir();
        missing.push(format!("quorum-vapid-absent-{}.key", std::process::id()));
        let _ = std::fs::remove_file(&missing);
        assert!(PushService::read_key_file(&missing).is_none(), "absent -> regenerate");

        let mut garbage = std::env::temp_dir();
        garbage.push(format!("quorum-vapid-garbage-{}.key", std::process::id()));
        std::fs::write(&garbage, "not a key!!!").unwrap();
        assert!(PushService::read_key_file(&garbage).is_none(), "garbage -> regenerate");
        let _ = std::fs::remove_file(&garbage);
    }
}
