//! Attachment blob store: plain files on the relay's disk. Every blob is
//! AES-GCM ciphertext — the file key travels inside the MLS message and
//! never reaches this process. Ids are client-generated random tokens and
//! act as capabilities: unguessable, no listing endpoint.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::RngCore;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Uploads larger than this are refused (also enforced client-side).
pub const MAX_BLOB_BYTES: usize = 25 * 1024 * 1024;

/// How long a minted upload ticket stays usable.
const TICKET_TTL: Duration = Duration::from_secs(300);
/// Ceiling on outstanding tickets, so minting cannot itself become the
/// memory-exhaustion path this is meant to close.
const MAX_OUTSTANDING_TICKETS: usize = 10_000;

/// Single-use upload authorizations, minted over the authenticated
/// WebSocket and spent on the unauthenticated PUT route.
#[derive(Default)]
pub struct UploadTickets {
    issued: Mutex<HashMap<String, (String, Instant)>>,
}

impl UploadTickets {
    /// Mint a ticket for `id`. Returns the opaque token.
    pub fn mint(&self, id: &str) -> String {
        let mut token = [0u8; 24];
        rand::rngs::OsRng.fill_bytes(&mut token);
        let token = URL_SAFE_NO_PAD.encode(token);
        let now = Instant::now();
        let mut issued = self.issued.lock().unwrap();
        issued.retain(|_, (_, at)| now.duration_since(*at) < TICKET_TTL);
        if issued.len() < MAX_OUTSTANDING_TICKETS {
            issued.insert(token.clone(), (id.to_string(), now));
        }
        token
    }

    /// Spend a ticket for `id`. False if it is unknown, expired, already
    /// spent, or was minted for a different id.
    pub fn redeem(&self, token: &str, id: &str) -> bool {
        let mut issued = self.issued.lock().unwrap();
        match issued.get(token) {
            Some((want, at))
                if want == id && Instant::now().duration_since(*at) < TICKET_TTL =>
            {
                issued.remove(token);
                true
            }
            _ => false,
        }
    }
}

pub struct BlobStore {
    dir: PathBuf,
}

impl BlobStore {
    pub fn new(dir: impl Into<PathBuf>) -> std::io::Result<Self> {
        let dir = dir.into();
        std::fs::create_dir_all(&dir)?;
        Ok(Self { dir })
    }

    fn path_for(&self, id: &str) -> Option<PathBuf> {
        // Ids are path components; anything but the token alphabet is out.
        let valid = !id.is_empty()
            && id.len() <= 64
            && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
        valid.then(|| self.dir.join(id))
    }

    pub async fn put(&self, id: &str, data: &[u8]) -> Result<(), String> {
        let path = self.path_for(id).ok_or("invalid blob id")?;
        if data.len() > MAX_BLOB_BYTES {
            return Err("blob too large".into());
        }
        if tokio::fs::try_exists(&path).await.unwrap_or(false) {
            return Err("blob already exists".into());
        }
        tokio::fs::write(path, data).await.map_err(|e| e.to_string())
    }

    pub async fn get(&self, id: &str) -> Result<Option<Vec<u8>>, String> {
        let path = self.path_for(id).ok_or("invalid blob id")?;
        match tokio::fs::read(path).await {
            Ok(data) => Ok(Some(data)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }
}

#[cfg(test)]
mod ticket_tests {
    use super::*;

    #[test]
    fn a_ticket_authorizes_exactly_one_upload_of_one_id() {
        let tickets = UploadTickets::default();
        let t = tickets.mint("abc");

        assert!(!tickets.redeem(&t, "other"), "a ticket must not authorize a different id");
        assert!(tickets.redeem(&t, "abc"), "the id it was minted for works");
        assert!(!tickets.redeem(&t, "abc"), "and it is single-use");
    }

    #[test]
    fn an_unminted_ticket_is_refused() {
        let tickets = UploadTickets::default();
        assert!(!tickets.redeem("", "abc"), "the empty string is not a ticket");
        assert!(!tickets.redeem("made-up", "abc"));
    }

    #[test]
    fn minting_is_bounded_so_it_cannot_itself_exhaust_memory() {
        let tickets = UploadTickets::default();
        for i in 0..(MAX_OUTSTANDING_TICKETS + 50) {
            tickets.mint(&format!("id{i}"));
        }
        assert!(tickets.issued.lock().unwrap().len() <= MAX_OUTSTANDING_TICKETS);
    }
}
