//! Disposable Profiles use the same owner and ACL creation path as production.
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// Dropping removes the tree best-effort and ignores failure; owners that must prove
/// removal call [`TempDir::close`].
#[derive(Debug)]
pub struct TempDir {
    _container: tempfile::TempDir,
    path: PathBuf,
}
impl TempDir {
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Removes the whole disposable tree and reports failure. Call it only after every
    /// process that used the tree has exited; on failure the tree is kept for inspection.
    pub fn close(self) -> io::Result<()> {
        remove_released_tree(&self._container.keep())
    }
}
pub fn tempdir() -> io::Result<TempDir> {
    let container = tempfile::tempdir()?;
    let path = container.path().join("data");
    crate::private_fs::create_dir(&path)?;
    Ok(TempDir {
        _container: container,
        path,
    })
}

/// Removes a tree whose processes have already exited. Windows can still refuse the
/// delete for a moment while antivirus, an indexer or process teardown holds a file
/// those processes just closed, so only those refusals back off. A tree that remains in
/// use stays refused and fails with the operating-system error.
pub fn remove_released_tree(path: &Path) -> io::Result<()> {
    const RELEASE_GRACE: Duration = Duration::from_secs(5);
    let deadline = Instant::now() + RELEASE_GRACE;
    loop {
        let error = match std::fs::remove_dir_all(path) {
            Ok(()) => return Ok(()),
            Err(error) => error,
        };
        if !release_pending(&error) || Instant::now() >= deadline {
            return Err(io::Error::new(
                error.kind(),
                format!("could not remove {}: {error}", path.display()),
            ));
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[cfg(windows)]
fn release_pending(error: &io::Error) -> bool {
    // A held file that was marked for deletion keeps its directory non-empty.
    crate::private_fs::delete_sharing_withheld(error)
        || error.kind() == io::ErrorKind::DirectoryNotEmpty
}
#[cfg(unix)]
fn release_pending(_error: &io::Error) -> bool {
    false
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{FILE_SHARE_READ, FILE_SHARE_WRITE};

    #[test]
    fn closing_waits_for_a_reader_without_delete_sharing_to_release_its_file() {
        let directory = tempdir().unwrap();
        let root = directory.path().to_owned();
        let held = root.join("closed-by-its-writer");
        crate::private_fs::write(&held, b"scanned").unwrap();
        // A scanner reads a just-closed file without granting delete sharing.
        let scanner = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .open(&held)
            .unwrap();
        let refused = std::fs::remove_dir_all(&root).unwrap_err();
        assert!(crate::private_fs::delete_sharing_withheld(&refused));

        let release = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(200));
            drop(scanner);
        });
        directory.close().unwrap();
        release.join().unwrap();
        assert!(!root.exists());
    }
}

/// A host-absolute lexical fixture path, without requiring an existing drive entry.
#[macro_export]
macro_rules! fixture_path {
    ($path:literal) => {{
        if cfg!(windows) {
            concat!("C:", $path)
        } else {
            $path
        }
    }};
}
