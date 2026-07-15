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
    pub fn from_env() -> Self {
        let private_b64 = match std::env::var("VAPID_PRIVATE_KEY") {
            Ok(v) => v,
            Err(_) => {
                let key = p256::SecretKey::random(&mut rand::rngs::OsRng);
                let b64 = URL_SAFE_NO_PAD.encode(key.to_bytes());
                tracing::warn!(
                    "VAPID_PRIVATE_KEY not set — generated ephemeral key (push \
                     subscriptions will not survive restarts)"
                );
                b64
            }
        };
        let secret = p256::SecretKey::from_slice(
            &URL_SAFE_NO_PAD.decode(&private_b64).expect("VAPID key: bad base64url"),
        )
        .expect("VAPID key: not a valid P-256 scalar");
        let public_b64 =
            URL_SAFE_NO_PAD.encode(secret.public_key().to_encoded_point(false).as_bytes());
        Self { private_b64, public_b64, client: HyperWebPushClient::new() }
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
