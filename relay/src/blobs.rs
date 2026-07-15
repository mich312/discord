//! Attachment blob store: plain files on the relay's disk. Every blob is
//! AES-GCM ciphertext — the file key travels inside the MLS message and
//! never reaches this process. Ids are client-generated random tokens and
//! act as capabilities: unguessable, no listing endpoint.

use std::path::PathBuf;

/// Uploads larger than this are refused (also enforced client-side).
pub const MAX_BLOB_BYTES: usize = 25 * 1024 * 1024;

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
