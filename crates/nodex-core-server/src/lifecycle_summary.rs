use std::io;
use std::sync::{Arc, Mutex};

use chrono::{SecondsFormat, Utc};
use nodex_core_protocol::RuntimeDescriptor;
use serde::{Deserialize, Serialize};

use crate::lifecycle::DrainReason;
use crate::runtime_files::RuntimePaths;

const SUMMARY_VERSION: u32 = 1;
const MAX_SUMMARY_BYTES: u64 = 16 * 1024;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct LifecycleGeneration {
    pid: u32,
    start_nonce: String,
    profile_id: String,
    store_epoch: String,
    readiness_generation: u64,
}

impl From<&RuntimeDescriptor> for LifecycleGeneration {
    fn from(descriptor: &RuntimeDescriptor) -> Self {
        Self {
            pid: descriptor.pid,
            start_nonce: descriptor.start_nonce.clone(),
            profile_id: descriptor.profile_id.clone(),
            store_epoch: descriptor.store_epoch.clone(),
            readiness_generation: descriptor.readiness_generation,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum LifecyclePhase {
    Draining,
    Running,
    Stopped,
    UncleanObserved,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum StopOutcome {
    ServerError,
    Success,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct LifecycleEntry {
    generation: LifecycleGeneration,
    phase: LifecyclePhase,
    started_at: String,
    updated_at: String,
    drain_reason: Option<DrainReason>,
    stop_outcome: Option<StopOutcome>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct LifecycleSummary {
    version: u32,
    current: LifecycleEntry,
    previous: Option<LifecycleEntry>,
}

struct WriterState {
    summary: Option<LifecycleSummary>,
    warned: bool,
}

#[derive(Clone)]
pub(crate) struct LifecycleSummaryWriter {
    paths: RuntimePaths,
    state: Arc<Mutex<WriterState>>,
}

impl LifecycleSummaryWriter {
    pub(crate) fn start(paths: RuntimePaths, descriptor: &RuntimeDescriptor) -> Self {
        let now = now();
        let previous = read_existing(&paths).map(|summary| {
            let mut entry = summary.current;
            if entry.phase != LifecyclePhase::Stopped {
                entry.phase = LifecyclePhase::UncleanObserved;
                entry.updated_at = now.clone();
                entry.drain_reason = None;
                entry.stop_outcome = None;
            }
            entry
        });
        let summary = LifecycleSummary {
            version: SUMMARY_VERSION,
            current: LifecycleEntry {
                generation: descriptor.into(),
                phase: LifecyclePhase::Running,
                started_at: now.clone(),
                updated_at: now,
                drain_reason: None,
                stop_outcome: None,
            },
            previous,
        };
        let writer = Self {
            paths,
            state: Arc::new(Mutex::new(WriterState {
                summary: Some(summary),
                warned: false,
            })),
        };
        writer.persist();
        writer
    }

    pub(crate) fn mark_draining(&self, reason: DrainReason) {
        self.update(|entry| {
            entry.phase = LifecyclePhase::Draining;
            entry.drain_reason = Some(reason);
            entry.stop_outcome = None;
        });
    }

    pub(crate) fn replace_generation(&self, descriptor: &RuntimeDescriptor) {
        self.update(|entry| {
            entry.generation = descriptor.into();
        });
    }

    pub(crate) fn mark_stopped(&self, success: bool) {
        self.update(|entry| {
            entry.phase = LifecyclePhase::Stopped;
            entry.stop_outcome = Some(if success {
                StopOutcome::Success
            } else {
                StopOutcome::ServerError
            });
        });
    }

    fn update(&self, update: impl FnOnce(&mut LifecycleEntry)) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        let Some(summary) = state.summary.as_mut() else {
            return;
        };
        update(&mut summary.current);
        summary.current.updated_at = now();
        drop(state);
        self.persist();
    }

    fn persist(&self) {
        let encoded = {
            let Ok(state) = self.state.lock() else {
                return;
            };
            let Some(summary) = state.summary.as_ref() else {
                return;
            };
            serde_json::to_vec(summary).map(|mut bytes| {
                bytes.push(b'\n');
                bytes
            })
        };
        let result = encoded.map_err(io::Error::other).and_then(|bytes| {
            if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > MAX_SUMMARY_BYTES {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "Core lifecycle summary is oversized",
                ));
            }
            self.paths
                .atomic_write_private(&self.paths.lifecycle, &bytes)
        });
        if let Err(error) = result {
            self.disable(error);
        }
    }

    fn disable(&self, error: io::Error) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        state.summary = None;
        if state.warned {
            return;
        }
        state.warned = true;
        tracing::warn!(
            subsystem = "lifecycle",
            error = %error,
            "Core lifecycle summary disabled"
        );
    }
}

fn read_existing(paths: &RuntimePaths) -> Option<LifecycleSummary> {
    let bytes = match paths.read_private_bounded(
        &paths.lifecycle,
        MAX_SUMMARY_BYTES,
        "Core lifecycle summary",
    ) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return None,
        Err(error) => {
            tracing::warn!(
                subsystem = "lifecycle",
                error = %error,
                "Previous Core lifecycle summary ignored"
            );
            return None;
        }
    };
    match serde_json::from_slice::<LifecycleSummary>(&bytes) {
        Ok(summary) if summary.version == SUMMARY_VERSION => Some(summary),
        Ok(_) => {
            tracing::warn!(
                subsystem = "lifecycle",
                "Previous Core lifecycle summary version is unsupported"
            );
            None
        }
        Err(error) => {
            tracing::warn!(
                subsystem = "lifecycle",
                error = %error,
                "Previous Core lifecycle summary is invalid"
            );
            None
        }
    }
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use nodex_platform::private_fs::symlink;
    use std::fs;

    use nodex_core_protocol::{CoreArtifactIdentity, canonical_manifest_digest, store_format};
    use tempfile::tempdir;

    use super::*;

    fn descriptor(paths: &RuntimePaths, nonce: char) -> RuntimeDescriptor {
        let manifest = nodex_core_protocol::core_compatibility_manifest();
        RuntimeDescriptor {
            manifest_digest: canonical_manifest_digest(&manifest).expect("manifest digest"),
            artifact: CoreArtifactIdentity {
                sha256: "a".repeat(64),
                build_id: "lifecycle-summary-test".to_owned(),
            },
            actual_store_format: store_format(nodex_core_protocol::CURRENT_STORE_VERSION)
                .expect("Store format"),
            manifest,
            pid: std::process::id(),
            start_nonce: nonce.to_string().repeat(32),
            endpoint: nodex_platform::local_endpoint::new_core_endpoint(&paths.socket).unwrap(),
            profile_id: "profile:test".to_owned(),
            store_epoch: "epoch:test".to_owned(),
            readiness_generation: 1,
        }
    }

    fn read_summary(paths: &RuntimePaths) -> LifecycleSummary {
        serde_json::from_slice(&fs::read(&paths.lifecycle).expect("summary bytes"))
            .expect("summary JSON")
    }

    #[test]
    fn records_graceful_and_unclean_generation_outcomes() {
        let directory = tempdir().expect("Profile");
        let home = directory.path().canonicalize().expect("absolute Profile");
        let paths = RuntimePaths::prepare(&home).expect("runtime paths");
        let first = LifecycleSummaryWriter::start(paths.clone(), &descriptor(&paths, 'a'));
        first.mark_draining(DrainReason::ExplicitShutdown);
        first.mark_stopped(true);

        let first_summary = read_summary(&paths);
        assert_eq!(first_summary.current.phase, LifecyclePhase::Stopped);
        assert_eq!(
            first_summary.current.drain_reason,
            Some(DrainReason::ExplicitShutdown)
        );
        assert_eq!(
            first_summary.current.stop_outcome,
            Some(StopOutcome::Success)
        );

        let second = LifecycleSummaryWriter::start(paths.clone(), &descriptor(&paths, 'b'));
        let second_summary = read_summary(&paths);
        assert_eq!(
            second_summary.previous.expect("previous").phase,
            LifecyclePhase::Stopped
        );
        drop(second);

        let _third = LifecycleSummaryWriter::start(paths.clone(), &descriptor(&paths, 'c'));
        let third_summary = read_summary(&paths);
        assert_eq!(
            third_summary.previous.expect("previous").phase,
            LifecyclePhase::UncleanObserved
        );
    }

    #[test]
    fn unsafe_summary_disables_only_the_breadcrumb() {
        let directory = tempdir().expect("Profile");
        let home = directory.path().canonicalize().expect("absolute Profile");
        let paths = RuntimePaths::prepare(&home).expect("runtime paths");
        let outside = home.join("outside.json");
        nodex_platform::private_fs::write(&outside, b"{}\n").expect("outside file");
        nodex_platform::private_fs::set_mode(&outside, 0o600).expect("outside mode");
        symlink(&outside, &paths.lifecycle).expect("summary symlink");

        let writer = LifecycleSummaryWriter::start(paths.clone(), &descriptor(&paths, 'a'));
        writer.mark_draining(DrainReason::IdleTimeout);
        assert!(
            fs::symlink_metadata(&paths.lifecycle)
                .expect("summary entry")
                .file_type()
                .is_symlink()
        );
        assert_eq!(fs::read(outside).expect("outside bytes"), b"{}\n");
    }
}
