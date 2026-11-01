use std::fs::{self, File, Metadata};
use std::io;
use std::path::Path;

#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;
#[cfg(unix)]
pub use unix::*;
#[cfg(windows)]
pub use windows::*;

#[derive(Clone, Copy)]
pub enum EntryKind {
    Directory,
    File,
    Socket,
}

/// Reject aliases before checking ownership or privacy. Windows includes every reparse tag.
pub fn entry_metadata(path: &Path, kind: EntryKind) -> io::Result<Metadata> {
    let metadata = fs::symlink_metadata(path)?;
    let valid = match kind {
        EntryKind::Directory => metadata.is_dir(),
        EntryKind::File => metadata.is_file(),
        EntryKind::Socket => is_socket(&metadata),
    };
    if is_reparse_point(&metadata) || !valid {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{} has an unsafe filesystem type", path.display()),
        ));
    }
    Ok(metadata)
}

pub fn checked_metadata(path: &Path, kind: EntryKind, mode: Option<u32>) -> io::Result<Metadata> {
    let metadata = entry_metadata(path, kind)?;
    require_owned(path, &metadata)?;
    if let Some(mode) = mode {
        require_mode(path, &metadata, mode)?;
    }
    Ok(metadata)
}

pub fn require_mode(path: &Path, metadata: &Metadata, mode: u32) -> io::Result<()> {
    if has_mode(path, metadata, mode)? {
        return Ok(());
    }
    Err(io::Error::new(
        io::ErrorKind::PermissionDenied,
        format!("{} has unsafe permissions", path.display()),
    ))
}

pub fn create_dir_all(path: impl AsRef<Path>) -> io::Result<()> {
    let path = path.as_ref();
    match fs::symlink_metadata(path) {
        Ok(_) => {
            let metadata = fs::symlink_metadata(path)?;
            if !metadata.is_dir() || is_reparse_point(&metadata) {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "unsafe directory",
                ));
            }
            return Ok(());
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        create_dir_all(parent)?;
    }
    match create_dir(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            checked_metadata(path, EntryKind::Directory, None).map(|_| ())
        }
        Err(error) => Err(error),
    }
}

pub fn open_read(path: &Path) -> io::Result<File> {
    OpenOptions::new().read(true).open(path)
}

/// Never blocks on a FIFO or follows a final alias; validates the opened handle.
pub fn open_regular(path: &Path, write: bool) -> io::Result<File> {
    let file = OpenOptions::new()
        .read(!write)
        .write(write)
        .create(write)
        .mode(0o600)
        .open(path)?;
    if file.metadata()?.is_file() {
        return Ok(file);
    }
    Err(io::Error::new(
        io::ErrorKind::InvalidInput,
        "expected a regular file",
    ))
}
/// Publish mutable private bytes through a no-follow handle.
pub fn write(path: impl AsRef<Path>, contents: impl AsRef<[u8]>) -> io::Result<()> {
    use std::io::Write;
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(contents.as_ref())
}
pub fn copy(source: impl AsRef<Path>, target: impl AsRef<Path>) -> io::Result<u64> {
    let mut input = open_read(source.as_ref())?;
    let mut output = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(target)?;
    io::copy(&mut input, &mut output)
}
