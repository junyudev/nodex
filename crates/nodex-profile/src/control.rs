//! A live Desktop lends an idle Agent snapshot window for exactly this socket lifetime.
use nodex_platform::{
    local_endpoint::{self, Stream},
    private_fs::{self, EntryKind},
};
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};

use std::path::Path;
use std::time::Duration;

use serde::Deserialize;

use crate::Result;
use crate::files::invalid;
const MAX_RESPONSE_BYTES: u64 = 1024 * 1024;

pub(crate) struct SnapshotLease {
    stream: Stream,
    execution: Option<ExecutionSnapshot>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExecutionSnapshot {
    pub runtime_id: String,
    pub runtime_generation: String,
    pub sequence: u64,
    pub database_path: std::path::PathBuf,
    pub attachments_path: std::path::PathBuf,
    pub environment_id_path: std::path::PathBuf,
    #[serde(default)]
    pub native_histories: Vec<NativeHistorySource>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeHistorySource {
    pub provider_instance_id: String,
    pub driver: String,
    pub home_path: Option<String>,
}

#[derive(Deserialize)]
struct Response {
    version: u32,
    status: String,
    message: Option<String>,
    #[serde(default, rename = "executionSnapshot")]
    execution: Option<ExecutionSnapshot>,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Rendezvous {
    version: u32,
    endpoint: String,
    capability: String,
    pid: u32,
}
fn snapshot_endpoint_valid(endpoint: &str, directory: &Path) -> bool {
    if cfg!(windows) {
        return local_endpoint::valid_pipe_name(endpoint, "nodex-clone");
    }
    Path::new(endpoint) == directory.join("clone.sock")
}

impl SnapshotLease {
    /// An absent/stale endpoint selects offline capture, whose native writer check still applies.
    pub(crate) fn acquire(profile: &Path) -> Result<Option<Self>> {
        let directory = profile.join("ipc");
        let rendezvous_path = directory.join("clone.json");
        match fs::symlink_metadata(&directory) {
            Ok(_) => {
                private_fs::checked_metadata(&directory, EntryKind::Directory, Some(0o700))?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        }
        let metadata = match fs::symlink_metadata(&rendezvous_path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        private_fs::checked_metadata(&rendezvous_path, EntryKind::File, Some(0o600))?;
        if metadata.len() > 4096 {
            return Err(invalid("Profile snapshot rendezvous exceeds its bound"));
        }
        let rendezvous: Rendezvous =
            serde_json::from_reader(private_fs::open_read(&rendezvous_path)?.take(4097))?;
        if rendezvous.version != 1
            || rendezvous.pid == 0
            || rendezvous.capability.len() != 64
            || !rendezvous
                .capability
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
            || !snapshot_endpoint_valid(&rendezvous.endpoint, &directory)
        {
            return Err(invalid("Profile snapshot rendezvous is invalid"));
        }
        if cfg!(unix) {
            private_fs::checked_metadata(
                Path::new(&rendezvous.endpoint),
                EntryKind::Socket,
                Some(0o600),
            )?;
        }
        let mut stream =
            match local_endpoint::connect(Path::new(&rendezvous.endpoint), Some(rendezvous.pid)) {
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
        stream.write_all(
            format!(
                "{}\n",
                serde_json::json!({"version":1,"capability":rendezvous.capability})
            )
            .as_bytes(),
        )?;
        let mut lease = Self {
            stream,
            execution: None,
        };
        lease.execution = lease.expect("ready")?.execution;
        Ok(Some(lease))
    }

    /// Release after native locks, and require acknowledgement before publishing the target.
    pub(crate) fn finish(mut self) -> Result<()> {
        self.stream
            .write_all(b"{\"version\":1,\"release\":true}\n")?;
        self.expect("resumed").map(|_| ())
    }

    pub(crate) fn execution(&self) -> Option<&ExecutionSnapshot> {
        self.execution.as_ref()
    }

    fn expect(&mut self, status: &str) -> Result<Response> {
        let mut line = Vec::new();
        BufReader::new(&mut self.stream)
            .take(MAX_RESPONSE_BYTES + 1)
            .read_until(b'\n', &mut line)?;
        if line.len() as u64 > MAX_RESPONSE_BYTES || line.last() != Some(&b'\n') {
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
        Ok(response)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use nodex_platform::local_endpoint::BlockingListener;

    fn serve(profile: &Path, fail: bool) -> std::thread::JoinHandle<()> {
        serve_snapshot(profile, fail, None)
    }

    fn serve_snapshot(
        profile: &Path,
        fail: bool,
        execution: Option<serde_json::Value>,
    ) -> std::thread::JoinHandle<()> {
        let directory = profile.join("ipc");
        nodex_platform::private_fs::create_dir(&directory).unwrap();
        nodex_platform::private_fs::set_mode(&directory, 0o700).unwrap();
        let path = directory.join("clone.sock");
        let endpoint = if cfg!(windows) {
            local_endpoint::random_endpoint("nodex-clone").unwrap()
        } else {
            path.to_string_lossy().into_owned()
        };
        let server = BlockingListener::bind(&endpoint).unwrap();
        if cfg!(unix) {
            private_fs::set_mode(&path, 0o600).unwrap();
        }
        let mut file = private_fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(directory.join("clone.json"))
            .unwrap();
        file.write_all(serde_json::json!({"version":1,"endpoint":endpoint,"capability":"a".repeat(64),"pid":std::process::id()}).to_string().as_bytes()).unwrap();
        std::thread::spawn(move || {
            let (mut socket, _) = server.accept().unwrap();
            let mut reader = BufReader::new(socket.try_clone().unwrap());
            let mut message = String::new();
            reader.read_line(&mut message).unwrap();
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(&message).unwrap(),
                serde_json::json!({"version":1,"capability":"a".repeat(64)})
            );
            if fail {
                socket
                    .write_all(
                        b"{\"version\":1,\"status\":\"error\",\"message\":\"Agent is busy\"}\n",
                    )
                    .unwrap();
                return;
            }
            socket
                .write_all(format!("{}\n", serde_json::json!({ "version": 1, "status": "ready", "executionSnapshot": execution })).as_bytes())
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
    fn admits_bounded_provider_metadata_larger_than_a_small_control_frame() {
        let profile = nodex_platform::test_support::tempdir().unwrap();
        let providers = (0..256)
            .map(|index| {
                serde_json::json!({
                    "providerInstanceId": format!("claude:{index}"), "driver": "claudeAgent",
                    "homePath": format!("/private/accounts/{}/claude", "directory".repeat(40)),
                })
            })
            .collect::<Vec<_>>();
        let execution = serde_json::json!({
            "runtimeId": "runtime", "runtimeGeneration": "generation", "sequence": 7,
            "databasePath": "/profile/runtime/snapshots/execution.sqlite",
            "attachmentsPath": "/profile/agent-runtime/userdata/attachments",
            "environmentIdPath": "/profile/agent-runtime/userdata/environment-id",
            "nativeHistories": providers,
        });
        assert!(execution.to_string().len() > 16384);
        let server = serve_snapshot(profile.path(), false, Some(execution));
        let lease = SnapshotLease::acquire(profile.path()).unwrap().unwrap();
        assert_eq!(lease.execution().unwrap().native_histories.len(), 256);
        lease.finish().unwrap();
        server.join().unwrap();
    }

    #[test]
    fn lends_and_releases_a_live_snapshot_window() {
        let profile = nodex_platform::test_support::tempdir().unwrap();
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
        let profile = nodex_platform::test_support::tempdir().unwrap();
        let server = serve(profile.path(), false);
        drop(SnapshotLease::acquire(profile.path()).unwrap());
        server.join().unwrap();
    }

    #[test]
    fn preserves_source_refusal_instead_of_falling_back_to_live_copying() {
        let profile = nodex_platform::test_support::tempdir().unwrap();
        let server = serve(profile.path(), true);
        let error = SnapshotLease::acquire(profile.path()).err().unwrap();
        assert!(error.to_string().contains("Agent is busy"));
        server.join().unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn rejects_public_endpoints_and_preserves_offline_capture() {
        let profile = nodex_platform::test_support::tempdir().unwrap();
        assert!(SnapshotLease::acquire(profile.path()).unwrap().is_none());
        let directory = profile.path().join("ipc");
        nodex_platform::private_fs::create_dir(&directory).unwrap();
        nodex_platform::private_fs::set_mode(&directory, 0o755).unwrap();
        assert!(SnapshotLease::acquire(profile.path()).is_err());
    }
}
