//! Filesystem boundary for Profile-managed execution artifacts.
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::Path;

use crate::{ProfileCloneError, Result};

const MAX_ENTRIES: usize = 100_000;
const MAX_DEPTH: usize = 64;

pub(crate) fn invalid(message: impl Into<String>) -> ProfileCloneError {
    ProfileCloneError::Invalid(message.into())
}

pub(crate) fn exists(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

pub(crate) fn require_directory(path: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(invalid(format!(
            "Execution directory must be a real directory: {}",
            path.display()
        )));
    }
    Ok(())
}

pub(crate) fn require_file(path: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(invalid(format!(
            "Execution artifact must be a regular file: {}",
            path.display()
        )));
    }
    Ok(())
}

pub(crate) fn private_directory(path: &Path) -> Result<()> {
    fs::DirBuilder::new().mode(0o700).create(path)?;
    Ok(())
}

pub(crate) fn copy_file(source: &Path, target: &Path) -> Result<u64> {
    require_file(source)?;
    // The pinned Rust toolchain uses fclonefileat on macOS, then fcopyfile
    // when APFS CoW is unavailable, as for Core's managed assets.
    Ok(fs::copy(source, target)?)
}

pub(crate) fn copy_attachments(source: &Path, target: &Path) -> Result<(u64, u64)> {
    private_directory(target)?;
    if !exists(source)? {
        return Ok((0, 0));
    }
    let mut pending = vec![(source.to_path_buf(), target.to_path_buf(), 0)];
    let mut entries = 0;
    let mut files = 0;
    let mut bytes = 0_u64;
    while let Some((source, target, depth)) = pending.pop() {
        require_directory(&source)?;
        if depth > MAX_DEPTH {
            return Err(invalid(
                "Execution attachments exceed their directory depth bound",
            ));
        }
        for entry in fs::read_dir(source)? {
            let entry = entry?;
            entries += 1;
            if entries > MAX_ENTRIES {
                return Err(invalid("Execution attachments exceed their entry bound"));
            }
            let source = entry.path();
            let target = target.join(entry.file_name());
            let metadata = fs::symlink_metadata(&source)?;
            if metadata.file_type().is_symlink() {
                return Err(invalid(
                    "Execution attachments must not contain symbolic links",
                ));
            }
            if metadata.is_dir() {
                private_directory(&target)?;
                pending.push((source, target, depth + 1));
                continue;
            }
            bytes = bytes
                .checked_add(copy_file(&source, &target)?)
                .ok_or_else(|| invalid("Execution attachment byte count exceeds its bound"))?;
            files += 1;
        }
    }
    Ok((files, bytes))
}

pub(crate) fn write_synced(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}

pub(crate) fn sync_directory(path: &Path) -> Result<()> {
    File::open(path)?.sync_all()?;
    Ok(())
}
