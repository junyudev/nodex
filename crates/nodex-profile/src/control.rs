//! A live Desktop lends an idle Agent snapshot window for exactly this socket lifetime.
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::fs::{FileTypeExt, MetadataExt};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::time::Duration;

use serde::Deserialize;

use crate::Result;
use crate::files::invalid;

pub(crate) struct SnapshotLease(UnixStream);

#[derive(Deserialize)]
struct Response {
    version: u32,
    status: String,
    message: Option<String>,
}

impl SnapshotLease {
    /// An absent/stale endpoint selects offline capture, whose native writer check still applies.
    pub(crate) fn acquire(profile: &Path) -> Result<Option<Self>> {
        let directory = profile.join("ipc");
        let socket = directory.join("clone.sock");
        for (path, is_socket) in [(&directory, false), (&socket, true)] {
            let metadata = match fs::symlink_metadata(path) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                Err(error) => return Err(error.into()),
            };
            let expected_kind = if is_socket {
                metadata.file_type().is_socket()
            } else {
                metadata.is_dir()
            };
            if !expected_kind
                || metadata.uid() != rustix::process::geteuid().as_raw()
                || metadata.mode() & 0o077 != 0
            {
                return Err(invalid(
                    "Source Profile snapshot endpoint is not private and owned by this user",
                ));
            }
        }
        let mut stream = match UnixStream::connect(socket) {
            Ok(stream) => stream,
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::ConnectionRefused | std::io::ErrorKind::NotFound
                ) =>
            {
                return Ok(None);
            }
            Err(error) => return Err(error.into()),
        };
        stream.set_read_timeout(Some(Duration::from_secs(75)))?;
        stream.set_write_timeout(Some(Duration::from_secs(5)))?;
        stream.write_all(b"{\"version\":1}\n")?;
        let mut lease = Self(stream);
        lease.expect("ready")?;
        Ok(Some(lease))
    }

    /// Release after native locks, and require acknowledgement before publishing the target.
    pub(crate) fn finish(mut self) -> Result<()> {
        self.0.write_all(b"{\"version\":1,\"release\":true}\n")?;
        self.expect("resumed")
    }

    fn expect(&mut self, status: &str) -> Result<()> {
        let mut line = Vec::new();
        BufReader::new(&mut self.0)
            .take(4097)
            .read_until(b'\n', &mut line)?;
        if line.len() > 4096 || line.last() != Some(&b'\n') {
            return Err(invalid(
                "Source Desktop closed or returned an invalid snapshot response",
            ));
        }
        let response: Response = serde_json::from_slice(&line)?;
        if response.version != 1 || response.status != status {
            return Err(invalid(response.message.unwrap_or_else(|| {
                "Source Desktop could not coordinate a Profile snapshot".to_owned()
            })));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::UnixListener;

    fn serve(profile: &Path, fail: bool) -> std::thread::JoinHandle<()> {
        let directory = profile.join("ipc");
        fs::create_dir(&directory).unwrap();
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
        let path = directory.join("clone.sock");
        let server = UnixListener::bind(&path).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
        std::thread::spawn(move || {
            let (mut socket, _) = server.accept().unwrap();
            let mut reader = BufReader::new(socket.try_clone().unwrap());
            let mut message = String::new();
            reader.read_line(&mut message).unwrap();
            assert_eq!(message, "{\"version\":1}\n");
            if fail {
                socket
                    .write_all(
                        b"{\"version\":1,\"status\":\"error\",\"message\":\"Agent is busy\"}\n",
                    )
                    .unwrap();
                return;
            }
            socket
                .write_all(b"{\"version\":1,\"status\":\"ready\"}\n")
                .unwrap();
            message.clear();
            if reader.read_line(&mut message).unwrap() == 0 {
                return;
            }
            assert_eq!(message, "{\"version\":1,\"release\":true}\n");
            socket
                .write_all(b"{\"version\":1,\"status\":\"resumed\"}\n")
                .unwrap();
        })
    }

    #[test]
    fn lends_and_releases_a_live_snapshot_window() {
        let profile = tempfile::tempdir().unwrap();
        let server = serve(profile.path(), false);
        SnapshotLease::acquire(profile.path())
            .unwrap()
            .unwrap()
            .finish()
            .unwrap();
        server.join().unwrap();
    }

    #[test]
    fn dropping_a_failed_capture_disconnects_the_source() {
        let profile = tempfile::tempdir().unwrap();
        let server = serve(profile.path(), false);
        drop(SnapshotLease::acquire(profile.path()).unwrap());
        server.join().unwrap();
    }

    #[test]
    fn preserves_source_refusal_instead_of_falling_back_to_live_copying() {
        let profile = tempfile::tempdir().unwrap();
        let server = serve(profile.path(), true);
        let error = SnapshotLease::acquire(profile.path()).err().unwrap();
        assert!(error.to_string().contains("Agent is busy"));
        server.join().unwrap();
    }

    #[test]
    fn rejects_public_endpoints_and_preserves_offline_capture() {
        let profile = tempfile::tempdir().unwrap();
        assert!(SnapshotLease::acquire(profile.path()).unwrap().is_none());
        let directory = profile.path().join("ipc");
        fs::create_dir(&directory).unwrap();
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(SnapshotLease::acquire(profile.path()).is_err());
    }
}
