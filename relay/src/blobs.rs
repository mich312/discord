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

/// Parse `BLOB_TTL_DAYS` into a retention window. `None` means keep
/// everything, which is the default and the behaviour every existing
/// deployment already has.
///
/// Anything that is not a positive whole number of days — empty, zero,
/// negative, `"forever"`, a typo — yields `None`. This direction is not
/// arbitrary: the failure mode of guessing wrong here is deleting
/// attachments nobody asked to delete, so an unparseable value must mean
/// *off*, never *sweep*.
pub fn blob_ttl_from(value: Option<&str>) -> Option<Duration> {
    let days: u64 = value?.trim().parse().ok()?;
    (days > 0).then(|| Duration::from_secs(days * 86_400))
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

    /// Delete blobs last modified more than `max_age` ago. Returns how many
    /// went. Only called when `BLOB_TTL_DAYS` is set — the default is still
    /// to keep everything, because silently deleting a user's attachments is
    /// not a default anyone should get by upgrading.
    ///
    /// **Age, not reference counting.** The relay cannot do better: a blob id
    /// lives inside the encrypted message that refers to it, so the server
    /// genuinely does not know which blobs are still wanted. Reference-based
    /// GC would require reading plaintext, which is the one thing this design
    /// forbids. Age is the only honest policy available, and its cost — an
    /// old attachment 404s while its message is still readable — is real and
    /// documented rather than hidden.
    ///
    /// The filter is `path_for`: only names that are *valid blob ids* are
    /// considered. That is what keeps `vapid.key` — which shares this
    /// directory and whose loss silently kills every push subscription on the
    /// deployment — out of the sweep, since a dot is not in the id alphabet.
    ///
    /// `now` is injected so the age rule can be tested without backdating
    /// file timestamps.
    pub async fn sweep_older_than(
        &self,
        max_age: Duration,
        now: std::time::SystemTime,
    ) -> std::io::Result<u64> {
        let mut removed = 0;
        let mut entries = tokio::fs::read_dir(&self.dir).await?;
        while let Some(entry) = entries.next_entry().await? {
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            // Anything that is not a well-formed blob id is not ours to delete.
            if self.path_for(name).is_none() {
                continue;
            }
            let Ok(meta) = entry.metadata().await else { continue };
            if !meta.is_file() {
                continue;
            }
            // A clock that moved backwards yields an Err here; treat that as
            // "not old enough" rather than deleting on a bad timestamp.
            let old = meta
                .modified()
                .ok()
                .and_then(|m| now.duration_since(m).ok())
                .is_some_and(|age| age > max_age);
            if old && tokio::fs::remove_file(entry.path()).await.is_ok() {
                removed += 1;
            }
        }
        Ok(removed)
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

#[cfg(test)]
mod sweep_tests {
    use super::*;
    use std::time::SystemTime;

    const WEEK: Duration = Duration::from_secs(60 * 60 * 24 * 7);

    fn later(days: u64) -> SystemTime {
        SystemTime::now() + Duration::from_secs(60 * 60 * 24 * days)
    }

    #[tokio::test]
    async fn a_blob_past_its_age_is_deleted() {
        let dir = tempfile::tempdir().unwrap();
        let store = BlobStore::new(dir.path()).unwrap();
        store.put("old-blob", b"stale").await.unwrap();

        assert_eq!(store.sweep_older_than(WEEK, later(30)).await.unwrap(), 1);
        assert!(store.get("old-blob").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn a_blob_inside_its_age_is_kept() {
        let dir = tempfile::tempdir().unwrap();
        let store = BlobStore::new(dir.path()).unwrap();
        store.put("new-blob", b"fresh").await.unwrap();

        assert_eq!(store.sweep_older_than(WEEK, SystemTime::now()).await.unwrap(), 0);
        assert_eq!(store.get("new-blob").await.unwrap().unwrap(), b"fresh");
    }

    #[tokio::test]
    async fn the_vapid_key_is_never_swept() {
        // It shares this directory, and losing it silently kills every push
        // subscription on the deployment - the loudest failure in the runbook.
        // A dot is not in the blob-id alphabet, which is what protects it.
        let dir = tempfile::tempdir().unwrap();
        let store = BlobStore::new(dir.path()).unwrap();
        let key = dir.path().join("vapid.key");
        std::fs::write(&key, b"secret").unwrap();

        let removed = store.sweep_older_than(Duration::from_secs(1), later(365)).await.unwrap();
        assert_eq!(removed, 0, "nothing that is not a valid blob id may be deleted");
        assert!(key.exists(), "the VAPID key must survive any sweep");
    }

    #[tokio::test]
    async fn subdirectories_are_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        let store = BlobStore::new(dir.path()).unwrap();
        let nested = dir.path().join("nested");
        std::fs::create_dir(&nested).unwrap();

        assert_eq!(store.sweep_older_than(Duration::from_secs(1), later(365)).await.unwrap(), 0);
        assert!(nested.is_dir());
    }

    #[test]
    fn a_ttl_is_off_unless_it_is_a_positive_whole_number_of_days() {
        // This decides whether a deletion job runs at all. Guessing wrong
        // deletes attachments nobody asked to delete, so everything that is
        // not clearly a positive count of days must mean OFF.
        assert_eq!(blob_ttl_from(None), None, "unset keeps everything");
        assert_eq!(blob_ttl_from(Some("")), None);
        assert_eq!(blob_ttl_from(Some("   ")), None);
        assert_eq!(blob_ttl_from(Some("0")), None, "zero is off, not delete-everything");
        assert_eq!(blob_ttl_from(Some("-5")), None);
        assert_eq!(blob_ttl_from(Some("forever")), None);
        assert_eq!(blob_ttl_from(Some("30d")), None, "a unit suffix is a typo, not 30");
        assert_eq!(blob_ttl_from(Some("7.5")), None, "fractional days are a typo too");
    }

    #[test]
    fn a_valid_ttl_parses_to_that_many_days() {
        assert_eq!(blob_ttl_from(Some("1")), Some(Duration::from_secs(86_400)));
        assert_eq!(blob_ttl_from(Some("180")), Some(Duration::from_secs(180 * 86_400)));
        // Surrounding whitespace is ordinary in a .env file.
        assert_eq!(blob_ttl_from(Some(" 30 ")), Some(Duration::from_secs(30 * 86_400)));
    }

    #[tokio::test]
    async fn an_empty_store_sweeps_cleanly() {
        let dir = tempfile::tempdir().unwrap();
        let store = BlobStore::new(dir.path()).unwrap();
        assert_eq!(store.sweep_older_than(WEEK, later(365)).await.unwrap(), 0);
    }
}
