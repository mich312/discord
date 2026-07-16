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
    /// Key from `VAPID_PRIVATE_KEY` (base64url raw scalar), or an ephemeral
    /// one — fine for dev; subscriptions die with the key, so set the env
    /// var in production.
    ///
    /// A malformed `VAPID_PRIVATE_KEY` never aborts startup: push is an
    /// auxiliary "nudge offline devices" feature, so we log a loud error and
    /// fall back to an ephemeral key rather than crash-looping the whole
    /// relay (messaging, groups, blobs) over a misconfigured push key.
    pub fn from_env() -> Self {
        let (private_b64, secret) = Self::load_key();
        let public_b64 =
            URL_SAFE_NO_PAD.encode(secret.public_key().to_encoded_point(false).as_bytes());
        Self { private_b64, public_b64, client: HyperWebPushClient::new() }
    }

    /// Resolve the VAPID key, falling back to a freshly generated ephemeral
    /// key when the env var is unset or invalid.
    fn load_key() -> (String, p256::SecretKey) {
        match std::env::var("VAPID_PRIVATE_KEY") {
            Ok(v) => match Self::parse_key(&v) {
                // Store the trimmed key so `send`'s `from_base64` sees exactly
                // what `parse_key` validated (no stray whitespace/newline).
                Ok(secret) => return (v.trim().to_string(), secret),
                Err(e) => tracing::error!(
                    "VAPID_PRIVATE_KEY is set but invalid ({e}); falling back to an \
                     ephemeral key. Expected base64url (no padding) of a 32-byte raw \
                     P-256 scalar. Existing push subscriptions will not work until \
                     this is fixed."
                ),
            },
            Err(_) => tracing::warn!(
                "VAPID_PRIVATE_KEY not set — generated ephemeral key (push \
                 subscriptions will not survive restarts)"
            ),
        }
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
}
