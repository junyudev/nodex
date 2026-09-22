use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use std::path::{Component, Path, PathBuf};

use crate::{ProfileCloneError, Result};
use sha2::{Digest, Sha256};

const MAX_FILES: usize = 100_000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Fingerprint {
    device: u64,
    inode: u64,
    length: u64,
    modified: (i64, i64),
    changed: (i64, i64),
}

pub(crate) fn invalid(message: impl Into<String>) -> ProfileCloneError {
    ProfileCloneError::Invalid(message.into())
}

pub(crate) fn fingerprint(path: &Path) -> Result<Fingerprint> {
    let meta = fs::symlink_metadata(path)?;
    if !meta.is_file() || meta.file_type().is_symlink() {
        return Err(invalid(format!(
            "Conversation artifact must be a regular file: {}",
            path.display()
        )));
    }
    Ok(Fingerprint {
        device: meta.dev(),
        inode: meta.ino(),
        length: meta.len(),
        modified: (meta.mtime(), meta.mtime_nsec()),
        changed: (meta.ctime(), meta.ctime_nsec()),
    })
}

pub(crate) fn require_directory(path: &Path) -> Result<()> {
    let meta = fs::symlink_metadata(path)?;
    if !meta.is_dir() || meta.file_type().is_symlink() {
        return Err(invalid(format!(
            "Conversation directory must be a real directory: {}",
            path.display()
        )));
    }
    Ok(())
}

pub(crate) fn exists(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e.into()),
    }
}

pub(crate) fn private_directory(path: &Path) -> Result<()> {
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path)?;
    require_directory(path)
}

pub(crate) fn create_file(path: &Path) -> Result<File> {
    private_directory(
        path.parent()
            .ok_or_else(|| invalid("Artifact has no parent"))?,
    )?;
    Ok(OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?)
}

pub(crate) fn read_file(path: &Path) -> Result<File> {
    fingerprint(path)?;
    Ok(OpenOptions::new()
        .read(true)
        .custom_flags(rustix::fs::OFlags::NOFOLLOW.bits() as i32)
        .open(path)?)
}

pub(crate) fn relative_path(root: &Path, path: &Path) -> Result<PathBuf> {
    let relative = path.strip_prefix(root).map_err(|_| {
        invalid(format!(
            "Native conversation path is outside its Profile: {}",
            path.display()
        ))
    })?;
    if relative.as_os_str().is_empty()
        || relative
            .components()
            .any(|p| !matches!(p, Component::Normal(_)))
    {
        return Err(invalid(
            "Native conversation path is not a contained artifact",
        ));
    }
    Ok(relative.to_owned())
}

pub(crate) fn inventory(
    root: &Path,
    directories: &[&str],
    files: &[&str],
) -> Result<BTreeMap<PathBuf, Fingerprint>> {
    let mut result = BTreeMap::new();
    for directory in directories {
        let path = root.join(directory);
        if exists(&path)? {
            collect(root, &path, &mut result, 0)?;
        }
    }
    for file in files {
        let path = root.join(file);
        if exists(&path)? {
            result.insert(PathBuf::from(file), fingerprint(&path)?);
        }
    }
    Ok(result)
}

fn collect(
    root: &Path,
    directory: &Path,
    result: &mut BTreeMap<PathBuf, Fingerprint>,
    depth: usize,
) -> Result<()> {
    if depth > 32 || result.len() >= MAX_FILES {
        return Err(invalid(
            "Conversation snapshot exceeds its filesystem bounds",
        ));
    }
    require_directory(directory)?;
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let path = entry.path();
        let kind = entry.file_type()?;
        if kind.is_dir() {
            collect(root, &path, result, depth + 1)?;
            continue;
        }
        if entry.file_name() == ".DS_Store" {
            continue;
        }
        result.insert(relative_path(root, &path)?, fingerprint(&path)?);
        if result.len() > MAX_FILES {
            return Err(invalid("Conversation snapshot has too many files"));
        }
    }
    Ok(())
}

pub(crate) fn copy_file(source: &Path, destination: &Path) -> Result<()> {
    let mut input = read_file(source)?;
    let mut output = create_file(destination)?;
    std::io::copy(&mut input, &mut output)?;
    output.flush()?;
    Ok(())
}

pub(crate) fn digest_tree(root: &Path) -> Result<String> {
    let mut files = BTreeMap::new();
    collect(root, root, &mut files, 0)?;
    let mut hash = Sha256::new();
    hash.update(b"nodex-conversation-snapshot-v1\0");
    for relative in files.keys() {
        let name = relative.to_string_lossy();
        hash.update((name.len() as u64).to_le_bytes());
        hash.update(name.as_bytes());
        let mut file = read_file(&root.join(relative))?;
        hash.update(file.metadata()?.len().to_le_bytes());
        let mut buffer = vec![0; 1024 * 1024];
        loop {
            let read = file.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            hash.update(&buffer[..read]);
        }
    }
    Ok(hex::encode(hash.finalize()))
}
