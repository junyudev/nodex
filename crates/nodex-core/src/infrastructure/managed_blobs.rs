//! Immutable byte publication shared by File, Canvas and Workspace owners.
//! Paths come from the Profile runtime, never a transport request. Owners keep
//! the returned publication alive until their durable roots have committed.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use super::managed_asset_snapshot::{ManagedAssetSnapshotLease, acquire_snapshot_lease};
use super::sqlite::{StoreError, StoreErrorCode};

#[derive(Debug)]
pub struct PublishedBlob {
    pub content_hash: String,
    pub physical_asset_name: String,
    pub byte_length: u64,
    _lease: ManagedAssetSnapshotLease,
}

pub struct BlobWriter {
    root: PathBuf,
    temporary_path: PathBuf,
    file: File,
    hasher: Sha256,
    byte_length: u64,
    limit: u64,
    lease: Option<ManagedAssetSnapshotLease>,
}

impl BlobWriter {
    pub fn new(root: &Path, limit: u64) -> Result<Self, StoreError> {
        let lease = acquire_snapshot_lease()?;
        let mut staging = root.as_os_str().to_os_string();
        staging.push(".staging");
        let staging = PathBuf::from(staging);
        for directory in [root, staging.as_path()] {
            fs::create_dir_all(directory).map_err(io_error)?;
            fs::set_permissions(directory, fs::Permissions::from_mode(0o700)).map_err(io_error)?;
        }
        let mut random = [0_u8; 24];
        getrandom::fill(&mut random).map_err(|error| {
            StoreError::new(
                StoreErrorCode::Internal,
                format!("Blob staging identity failed: {error}"),
                true,
            )
        })?;
        let temporary_path = staging.join(format!("blob-{}.tmp", hex::encode(random)));
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temporary_path)
            .map_err(io_error)?;
        Ok(Self {
            root: root.to_owned(),
            temporary_path,
            file,
            hasher: Sha256::new(),
            byte_length: 0,
            limit,
            lease: Some(lease),
        })
    }

    pub fn write_chunk(&mut self, bytes: &[u8]) -> Result<(), StoreError> {
        let next = self
            .byte_length
            .checked_add(bytes.len() as u64)
            .filter(|length| *length <= self.limit)
            .ok_or_else(|| {
                StoreError::new(
                    StoreErrorCode::ResourceExhausted,
                    "Blob exceeds its byte bound",
                    false,
                )
            })?;
        self.file.write_all(bytes).map_err(io_error)?;
        self.hasher.update(bytes);
        self.byte_length = next;
        Ok(())
    }

    pub fn finish(mut self) -> Result<PublishedBlob, StoreError> {
        self.file.sync_all().map_err(io_error)?;
        let content_hash = hex::encode(self.hasher.clone().finalize());
        let physical_asset_name = format!("{content_hash}.blob");
        let target = self.root.join(&physical_asset_name);
        match fs::hard_link(&self.temporary_path, &target) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(io_error(error)),
        }
        verify(
            &self.root,
            &physical_asset_name,
            &content_hash,
            self.byte_length,
        )?;
        File::open(&self.root)
            .and_then(|directory| directory.sync_all())
            .map_err(io_error)?;
        fs::remove_file(&self.temporary_path).map_err(io_error)?;
        Ok(PublishedBlob {
            content_hash,
            physical_asset_name,
            byte_length: self.byte_length,
            _lease: self
                .lease
                .take()
                .expect("publication retains its namespace lease"),
        })
    }
}

impl Drop for BlobWriter {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.temporary_path);
    }
}

/// Opens under the caller's namespace lease. The owned handle remains readable
/// after a later authorized purge unlinks its directory entry.
pub(crate) fn open(
    root: &Path,
    physical_name: &str,
    expected_length: u64,
) -> Result<File, StoreError> {
    validate_physical_name(physical_name)?;
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(rustix::fs::OFlags::NOFOLLOW.bits() as i32)
        .open(root.join(physical_name))
        .map_err(|_| corrupt("Managed Blob bytes are unavailable"))?;
    let metadata = file.metadata().map_err(io_error)?;
    if !metadata.is_file() || metadata.len() != expected_length {
        return Err(corrupt("Managed Blob physical state is invalid"));
    }
    Ok(file)
}

pub(crate) fn verify(
    root: &Path,
    physical_name: &str,
    expected_hash: &str,
    expected_length: u64,
) -> Result<(), StoreError> {
    let mut file = open(root, physical_name, expected_length)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(io_error)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    if hex::encode(hasher.finalize()) != expected_hash {
        return Err(corrupt("Managed Blob content does not match its digest"));
    }
    Ok(())
}

pub(crate) fn validate_physical_name(value: &str) -> Result<(), StoreError> {
    if value.is_empty()
        || value.len() > 255
        || matches!(value, "." | "..")
        || value.contains(['/', '\\'])
        || value.chars().any(char::is_control)
    {
        return Err(corrupt("Managed Blob physical name is invalid"));
    }
    Ok(())
}

fn corrupt(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message, false)
}

fn io_error(error: std::io::Error) -> StoreError {
    StoreError::new(
        StoreErrorCode::Internal,
        format!("Managed Blob storage failed: {error}"),
        true,
    )
}

#[cfg(test)]
mod tests {
    use super::super::managed_asset_snapshot::try_acquire_gc_lease;
    use super::*;

    #[test]
    fn publication_pins_bytes_until_durable_roots_commit_and_open_handles_survive_unlink() {
        let home = tempfile::tempdir().unwrap();
        let root = home.path().join("assets");
        let mut writer = BlobWriter::new(&root, 16).unwrap();
        writer.write_chunk(b"alpha").unwrap();
        assert!(try_acquire_gc_lease().unwrap().is_none());
        let published = writer.finish().unwrap();
        assert!(try_acquire_gc_lease().unwrap().is_none());
        let mut reader = open(&root, &published.physical_asset_name, 5).unwrap();
        let mut duplicate = BlobWriter::new(&root, 16).unwrap();
        duplicate.write_chunk(b"alpha").unwrap();
        let duplicate = duplicate.finish().unwrap();
        assert_eq!(published.content_hash, duplicate.content_hash);
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        fs::remove_file(root.join(&published.physical_asset_name)).unwrap();
        let mut bytes = Vec::new();
        reader.read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes, b"alpha");
    }

    #[test]
    fn failed_publication_keeps_existing_bytes_and_cleans_staging() {
        let home = tempfile::tempdir().unwrap();
        let root = home.path().join("assets");
        let mut writer = BlobWriter::new(&root, 5).unwrap();
        assert!(writer.write_chunk(b"too big").is_err());
        drop(writer);
        let mut writer = BlobWriter::new(&root, 5).unwrap();
        writer.write_chunk(b"alpha").unwrap();
        let name = format!("{}.blob", hex::encode(Sha256::digest(b"alpha")));
        fs::write(root.join(&name), b"wrong").unwrap();
        assert!(writer.finish().is_err());
        assert_eq!(fs::read(root.join(&name)).unwrap(), b"wrong");
        assert_eq!(
            fs::read_dir(home.path().join("assets.staging"))
                .unwrap()
                .count(),
            0
        );
        let outside = home.path().join("outside");
        fs::write(&outside, b"alpha").unwrap();
        std::os::unix::fs::symlink(outside, root.join("symlink")).unwrap();
        assert!(open(&root, "symlink", 5).is_err());
        assert!(open(&root, "../outside", 5).is_err());
    }
}
