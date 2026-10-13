//! Captures the execution owner's durable identity, database and immutable attachments.
use std::fs;
use std::io::Read;
use std::os::unix::fs::{DirBuilderExt, MetadataExt};
use std::path::{Path, PathBuf};

use nodex_core::administration::{ProfileCloneExecution, ProfileCloneThread};
use nodex_core::infrastructure::store_lock::ProfileStoreLock;
use serde::{Deserialize, Serialize};

use crate::control::ExecutionSnapshot;
use crate::files::{self, invalid};
use crate::{Result, codex};

#[derive(Clone, Debug, Deserialize, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionSnapshotReceipt {
    pub version: u32,
    pub runtime_id: String,
    pub runtime_generation: Option<String>,
    pub sequence: u64,
    pub required_session_count: usize,
    pub content_sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
struct Owner {
    pid: i32,
    token: String,
}

/// The offline guard also excludes a new Desktop from opening the source Profile.
pub(crate) struct OfflineLease {
    _core: ProfileStoreLock,
    _writer: RuntimeWriterLease,
}
pub(crate) struct RuntimeWriterLease {
    directory: PathBuf,
    owner: Owner,
}

fn owner(directory: &Path) -> Result<Owner> {
    files::require_directory(directory)?;
    let meta = fs::symlink_metadata(directory)?;
    if meta.uid() != rustix::process::geteuid().as_raw() || meta.mode() & 0o077 != 0 {
        return Err(invalid(
            "Execution writer ownership must be private and user-owned",
        ));
    }
    let mut data = String::new();
    files::read_file(&directory.join("owner.json"))?
        .take(1025)
        .read_to_string(&mut data)?;
    let owner: Owner = serde_json::from_str(&data)?;
    if data.len() > 1024 || owner.pid <= 0 || owner.token.is_empty() || owner.token.len() > 256 {
        return Err(invalid("Execution writer ownership is malformed"));
    }
    Ok(owner)
}

fn dead(pid: i32) -> bool {
    rustix::process::Pid::from_raw(pid)
        .is_some_and(|pid| rustix::process::test_kill_process(pid) == Err(rustix::io::Errno::SRCH))
}

fn claim(directory: &Path, owner: &Owner) -> Result<()> {
    fs::DirBuilder::new().mode(0o700).create(directory)?;
    use std::io::Write;
    files::create_file(&directory.join("owner.json"))?.write_all(&serde_json::to_vec(owner)?)?;
    Ok(())
}

impl OfflineLease {
    pub(crate) fn acquire(profile: &Path) -> Result<Self> {
        let core = ProfileStoreLock::acquire(profile)?;
        Ok(Self {
            _core: core,
            _writer: RuntimeWriterLease::acquire(profile)?,
        })
    }
}

impl RuntimeWriterLease {
    pub(crate) fn acquire(profile: &Path) -> Result<Self> {
        let home = profile.join("agent-runtime");
        files::private_directory(&home)?;
        let directory = home.join(".writer.lock");
        let mine = Owner {
            pid: std::process::id() as i32,
            token: format!(
                "profile:{}:{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_err(|_| invalid("System clock cannot identify snapshot ownership"))?
                    .as_nanos()
            ),
        };
        if files::exists(&directory)? {
            let stale = owner(&directory)?;
            if !dead(stale.pid) {
                return Err(invalid("An execution writer still owns the source Profile"));
            }
            let recovery = directory.join(".recovering");
            claim(&recovery, &mine)?;
            if owner(&directory)? != stale || !dead(stale.pid) {
                if owner(&recovery).is_ok_and(|current| current == mine) {
                    let _ = fs::remove_dir_all(&recovery);
                }
                return Err(invalid(
                    "Execution writer ownership changed during recovery",
                ));
            }
            fs::remove_dir_all(&directory)?;
        }
        claim(&directory, &mine)?;
        Ok(Self {
            directory,
            owner: mine,
        })
    }
}

impl Drop for RuntimeWriterLease {
    fn drop(&mut self) {
        if owner(&self.directory).is_ok_and(|current| current == self.owner) {
            let _ = fs::remove_dir_all(&self.directory);
        }
    }
}

pub(crate) fn capture(
    source_profile: &Path,
    staging_profile: &Path,
    target_profile: &Path,
    required: &[ProfileCloneExecution],
    live: Option<&ExecutionSnapshot>,
) -> Result<(Option<ExecutionSnapshotReceipt>, Vec<ProfileCloneThread>)> {
    let home = source_profile.join("agent-runtime");
    let database = live.map_or_else(
        || home.join("agent-runtime.sqlite"),
        |snapshot| snapshot.database_path.clone(),
    );
    if !files::exists(&database)? {
        if !required.is_empty() {
            return Err(invalid(
                "Source Profile has bound Sessions without their execution database",
            ));
        }
        return Ok((None, Vec::new()));
    }
    files::require_directory(&home)?;
    if !fs::canonicalize(&database)?.starts_with(fs::canonicalize(source_profile)?) {
        return Err(invalid(
            "Execution snapshot database is outside its Profile owner",
        ));
    }
    files::require_directory(&home.join("userdata"))?;
    let identity = live.map_or_else(
        || home.join("userdata/environment-id"),
        |snapshot| snapshot.environment_id_path.clone(),
    );
    let attachments = live.map_or_else(
        || home.join("userdata/attachments"),
        |snapshot| snapshot.attachments_path.clone(),
    );
    if identity != home.join("userdata/environment-id")
        || attachments != home.join("userdata/attachments")
    {
        return Err(invalid(
            "Execution snapshot closure is outside its Profile owner",
        ));
    }
    let mut id = String::new();
    files::read_file(&identity)?
        .take(4097)
        .read_to_string(&mut id)?;
    let runtime_id = id.trim().to_owned();
    if runtime_id.is_empty()
        || id.len() > 4096
        || live.is_some_and(|snapshot| snapshot.runtime_id != runtime_id)
        || required
            .iter()
            .any(|binding| binding.runtime_id != runtime_id)
    {
        return Err(invalid(
            "Execution identity does not match the retained Session bindings",
        ));
    }
    let destination = staging_profile.join("agent-runtime");
    files::private_directory(&destination)?;
    let source = codex::DatabaseSource::open(database)?;
    let target_db = destination.join("agent-runtime.sqlite");
    source.snapshot(&target_db)?;
    let connection = rusqlite::Connection::open(&target_db)?;
    for binding in required {
        let exists: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_threads WHERE thread_id = ?1 AND deleted_at IS NULL)", [&binding.thread_id], |row| row.get(0))?;
        if !exists {
            return Err(invalid(format!(
                "Session {} has no recoverable execution Thread",
                binding.session_id
            )));
        }
    }
    let busy: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_runs WHERE status NOT IN ('completed','interrupted','failed','cancelled','rolled_back')) OR EXISTS(SELECT 1 FROM orchestration_v2_effect_outbox WHERE status NOT IN ('succeeded','failed','cancelled'))", [], |row| row.get(0))?;
    if busy {
        return Err(invalid("Execution must be idle before cloning the Profile"));
    }
    let has_active_events: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('orchestration_events') WHERE name='application_event_version')", [], |row| row.get(0))?;
    let sequence_query = if has_active_events {
        "SELECT COALESCE(MAX(sequence),0) FROM orchestration_events WHERE aggregate_kind='project' OR (application_event_version=2 AND aggregate_kind='thread')"
    } else {
        "SELECT COALESCE(MAX(sequence),0) FROM orchestration_events"
    };
    let sequence =
        u64::try_from(connection.query_row(sequence_query, [], |row| row.get::<_, i64>(0))?)
            .map_err(|_| invalid("Execution sequence is invalid"))?;
    if live.is_some_and(|snapshot| snapshot.sequence != sequence) {
        return Err(invalid(
            "Execution snapshot watermark does not match its database",
        ));
    }
    let native = native_codex_requirements(&connection)?;
    super::execution_relocation::relocate(&connection, source_profile, target_profile)?;
    drop(connection);
    files::copy_file(&identity, &destination.join("userdata/environment-id"))?;
    let inventory = files::inventory(&home.join("userdata"), &["attachments"], &[])?;
    for relative in inventory.keys() {
        files::copy_file(
            &home.join("userdata").join(relative),
            &destination.join("userdata").join(relative),
        )?;
    }
    source.verify_unchanged()?;
    if inventory != files::inventory(&home.join("userdata"), &["attachments"], &[])? {
        return Err(invalid("Execution attachments changed during capture"));
    }
    Ok((
        Some(ExecutionSnapshotReceipt {
            version: 1,
            runtime_id,
            runtime_generation: live.map(|snapshot| snapshot.runtime_generation.clone()),
            sequence,
            required_session_count: required.len(),
            content_sha256: files::digest_tree(&destination)?,
        }),
        native,
    ))
}

fn native_codex_requirements(connection: &rusqlite::Connection) -> Result<Vec<ProfileCloneThread>> {
    let mut statement = connection.prepare("SELECT DISTINCT json_extract(payload_json,'$.nativeThreadRef.nativeId') FROM orchestration_v2_projection_provider_threads WHERE json_extract(payload_json,'$.driver') = 'codex' AND json_type(payload_json,'$.nativeThreadRef.nativeId')='text' LIMIT 100001")?;
    let mut rows = statement.query([])?;
    let mut threads = Vec::new();
    let mut bytes = 0usize;
    while let Some(row) = rows.next()? {
        let value = row.get_ref(0)?;
        let rusqlite::types::ValueRef::Text(value) = value else {
            return Err(invalid("Native execution reference is malformed"));
        };
        bytes = bytes.saturating_add(value.len());
        if threads.len() >= 100000 || bytes > 16 * 1024 * 1024 {
            return Err(invalid(
                "Native execution references exceed snapshot bounds",
            ));
        }
        threads.push(ProfileCloneThread {
            thread_id: row.get(0)?,
            backend_kind: "codex".into(),
            execution_host_id: "local".into(),
        });
    }
    Ok(threads)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn fixture(profile: &Path) -> PathBuf {
        let home = profile.join("agent-runtime");
        files::private_directory(&home.join("userdata/attachments")).unwrap();
        files::create_file(&home.join("userdata/environment-id"))
            .unwrap()
            .write_all(b"engine\n")
            .unwrap();
        files::create_file(&home.join("userdata/attachments/image.png"))
            .unwrap()
            .write_all(b"image")
            .unwrap();
        let path = home.join("agent-runtime.sqlite");
        let database = rusqlite::Connection::open(&path).unwrap();
        database.execute_batch("CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT PRIMARY KEY,deleted_at TEXT,payload_json TEXT); CREATE TABLE orchestration_v2_projection_runs(status TEXT); CREATE TABLE orchestration_v2_effect_outbox(status TEXT); CREATE TABLE orchestration_v2_projection_provider_threads(payload_json TEXT); CREATE TABLE orchestration_events(sequence INTEGER,event_type TEXT,payload_json TEXT); INSERT INTO orchestration_v2_projection_threads VALUES ('root',NULL,'{}'); INSERT INTO orchestration_events VALUES (7,'thread.created','{}'); INSERT INTO orchestration_v2_projection_provider_threads VALUES ('{\"driver\":\"codex\",\"nativeThreadRef\":{\"driver\":\"codex\",\"nativeId\":\"native-root\",\"strength\":\"strong\"}}')").unwrap();
        path
    }

    fn required() -> Vec<ProfileCloneExecution> {
        vec![ProfileCloneExecution {
            session_id: "session".into(),
            runtime_id: "engine".into(),
            thread_id: "root".into(),
        }]
    }

    #[test]
    fn captures_identity_database_attachments_and_native_requirements_as_an_independent_closure() {
        let source = tempfile::tempdir().unwrap();
        let staging = tempfile::tempdir().unwrap();
        let path = fixture(source.path());
        let (receipt, native) = capture(
            source.path(),
            staging.path(),
            staging.path(),
            &required(),
            None,
        )
        .unwrap();
        let receipt = receipt.unwrap();
        assert_eq!(receipt.runtime_id, "engine");
        assert_eq!(receipt.sequence, 7);
        assert_eq!(receipt.required_session_count, 1);
        assert_eq!(native[0].thread_id, "native-root");
        fs::remove_file(path).unwrap();
        fs::remove_file(
            source
                .path()
                .join("agent-runtime/userdata/attachments/image.png"),
        )
        .unwrap();
        assert_eq!(
            fs::read(
                staging
                    .path()
                    .join("agent-runtime/userdata/attachments/image.png")
            )
            .unwrap(),
            b"image"
        );
        let cloned =
            rusqlite::Connection::open(staging.path().join("agent-runtime/agent-runtime.sqlite"))
                .unwrap();
        assert_eq!(
            cloned
                .query_row(
                    "SELECT thread_id FROM orchestration_v2_projection_threads",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "root"
        );
    }

    #[test]
    fn rejects_wrong_identity_missing_threads_busy_work_and_mismatched_watermarks() {
        for variant in ["identity", "thread", "busy", "watermark"] {
            let source = tempfile::tempdir().unwrap();
            let staging = tempfile::tempdir().unwrap();
            let path = fixture(source.path());
            let mut bindings = required();
            if variant == "identity" {
                bindings[0].runtime_id = "other-engine".into();
            }
            if variant == "thread" {
                bindings[0].thread_id = "missing".into();
            }
            if variant == "busy" {
                rusqlite::Connection::open(&path)
                    .unwrap()
                    .execute(
                        "INSERT INTO orchestration_v2_projection_runs VALUES ('running')",
                        [],
                    )
                    .unwrap();
            }
            let snapshot = ExecutionSnapshot {
                runtime_id: "engine".into(),
                runtime_generation: "generation".into(),
                native_histories: vec![],
                sequence: 8,
                database_path: path,
                attachments_path: source.path().join("agent-runtime/userdata/attachments"),
                environment_id_path: source.path().join("agent-runtime/userdata/environment-id"),
            };
            assert!(
                capture(
                    source.path(),
                    staging.path(),
                    staging.path(),
                    &bindings,
                    (variant == "watermark").then_some(&snapshot)
                )
                .is_err(),
                "{variant}"
            );
        }
    }

    #[test]
    fn missing_execution_storage_cannot_satisfy_a_bound_session() {
        let source = tempfile::tempdir().unwrap();
        let staging = tempfile::tempdir().unwrap();
        assert!(
            capture(
                source.path(),
                staging.path(),
                staging.path(),
                &required(),
                None
            )
            .is_err()
        );
        assert!(
            capture(source.path(), staging.path(), staging.path(), &[], None)
                .unwrap()
                .0
                .is_none()
        );
    }

    #[test]
    fn offline_capture_excludes_existing_and_replacement_writers_and_releases_ownership() {
        let source = tempfile::tempdir().unwrap();
        let lease = OfflineLease::acquire(source.path()).unwrap();
        let directory = source.path().join("agent-runtime/.writer.lock");
        assert_eq!(owner(&directory).unwrap().pid, std::process::id() as i32);
        assert!(OfflineLease::acquire(source.path()).is_err());
        drop(lease);
        assert!(!directory.exists());
        let home = source.path().join("agent-runtime");
        claim(
            &home.join(".writer.lock"),
            &Owner {
                pid: std::process::id() as i32,
                token: "live".into(),
            },
        )
        .unwrap();
        assert!(OfflineLease::acquire(source.path()).is_err());
        assert_eq!(owner(&directory).unwrap().token, "live");
    }
}
