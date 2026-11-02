//! Copies current execution content online. Runtime owns schema interpretation and import.
use std::fs;
use std::path::Path;
use std::time::Duration;

use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};

use crate::{Result, files};

#[derive(Clone, Debug, Deserialize, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionSnapshotReceipt {
    pub captured_at: String,
    pub database_bytes: u64,
    pub attachment_files: u64,
    pub attachment_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportedExecution<'a> {
    version: u32,
    source_profile_home: &'a Path,
    imported_at: &'a str,
}

pub(crate) fn capture(
    source_profile: &Path,
    staging_profile: &Path,
) -> Result<Option<ExecutionSnapshotReceipt>> {
    let source = source_profile.join("agent-runtime");
    if !files::exists(&source)? {
        return Ok(None);
    }
    files::require_directory(&source)?;
    let database = source.join("agent-runtime.sqlite");
    if !files::exists(&database)? {
        return Ok(None);
    }
    files::require_file(&database)?;
    files::require_directory(&source.join("userdata"))?;
    let target = staging_profile.join("agent-runtime");
    files::private_directory(&target)?;
    let target_database = target.join("agent-runtime.sqlite");
    // A live WAL database must be opened normally, never immutable. VACUUM INTO
    // owns one read snapshot and does not require the Runtime's writer lease.
    let connection = Connection::open_with_flags(
        &database,
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )?;
    connection.busy_timeout(Duration::from_secs(5))?;
    let captured_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    files::write_synced(&target_database, &[])?;
    connection.execute(
        "VACUUM INTO ?1",
        [target_database
            .to_str()
            .ok_or_else(|| files::invalid("Execution snapshot path must be UTF-8"))?],
    )?;
    drop(connection);
    nodex_platform::private_fs::sync_file(&target_database)?;
    let database_bytes = fs::metadata(&target_database)?.len();
    let userdata = target.join("userdata");
    files::private_directory(&userdata)?;
    let (attachment_files, attachment_bytes) = files::copy_attachments(
        &source.join("userdata/attachments"),
        &userdata.join("attachments"),
    )?;
    files::copy_file(
        &source.join("userdata/environment-id"),
        &userdata.join("environment-id"),
    )?;
    let imported_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let marker = ImportedExecution {
        version: 1,
        source_profile_home: source_profile,
        imported_at: &imported_at,
    };
    files::write_synced(
        &target.join("imported-execution.json"),
        &serde_json::to_vec_pretty(&marker)?,
    )?;
    files::sync_directory(&userdata)?;
    files::sync_directory(&target)?;
    Ok(Some(ExecutionSnapshotReceipt {
        captured_at,
        database_bytes,
        attachment_files,
        attachment_bytes,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use nodex_platform::private_fs::symlink;
    use std::sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    };

    fn fixture(profile: &Path) -> Connection {
        let home = profile.join("agent-runtime");
        nodex_platform::private_fs::create_dir_all(home.join("userdata/attachments/images"))
            .unwrap();
        nodex_platform::private_fs::write(home.join("userdata/environment-id"), b"engine:test\n")
            .unwrap();
        nodex_platform::private_fs::write(
            home.join("userdata/attachments/images/a.png"),
            b"immutable attachment",
        )
        .unwrap();
        // A live lease and an unusable provider catalog must not participate in capture.
        nodex_platform::private_fs::create_dir(home.join(".writer.lock")).unwrap();
        nodex_platform::private_fs::write(home.join("provider-catalog.json"), b"not a catalog")
            .unwrap();
        let provider = profile.join("missing-provider");
        nodex_platform::private_fs::create_dir(&provider).unwrap();
        nodex_platform::private_fs::directory_link(&provider, &profile.join("agent")).unwrap();
        fs::remove_dir(&provider).unwrap();
        let connection = Connection::open(home.join("agent-runtime.sqlite")).unwrap();
        connection.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE history(id INTEGER PRIMARY KEY, value INTEGER, body BLOB); CREATE TABLE watermark(value INTEGER); INSERT INTO watermark VALUES(0); INSERT INTO history VALUES(1,0,zeroblob(4096));").unwrap();
        connection
            .execute(
                "INSERT INTO history SELECT id + 1, value, body FROM history",
                [],
            )
            .unwrap();
        for _ in 0..11 {
            connection.execute("INSERT INTO history SELECT id + (SELECT max(id) FROM history), value, body FROM history", []).unwrap();
        }
        connection
    }

    fn publish_content_backup(
        profile: &Path,
    ) -> nodex_core::infrastructure::store::SqliteStoreKernel {
        use nodex_core_contracts::administration::{BackupTrigger, StoreAdministrationIntent};
        use nodex_core_contracts::{
            AdapterKind, BoundModuleContext, LibraryId, ModuleApplyRequest, ProfileId,
            STORE_ADMINISTRATION_CONTRACT_VERSION, StoreEpoch,
        };
        let kernel = nodex_core::infrastructure::store::SqliteStoreKernel::open(profile).unwrap();
        kernel.writer().call(|connection| {
            connection.execute_batch("INSERT INTO profiles(id,created_at,updated_at) VALUES('profile:clone','2026-11-01T00:00:00.000Z','2026-11-01T00:00:00.000Z'); INSERT INTO libraries(id,profile_id,created_at,updated_at) VALUES('library:clone','profile:clone','2026-11-01T00:00:00.000Z','2026-11-01T00:00:00.000Z'); INSERT INTO block_store_metadata(id,store_epoch,created_at,updated_at) VALUES(1,'epoch:clone','2026-11-01T00:00:00.000Z','2026-11-01T00:00:00.000Z');")?;
            Ok(())
        }).unwrap();
        let (profile_id, library_id, epoch): (String, String, String) = kernel.readers().read_default(|connection| Ok(connection.query_row(
            "SELECT profile_id,id,(SELECT store_epoch FROM block_store_metadata WHERE id=1) FROM libraries",
            [], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)))?)).unwrap();
        let context = BoundModuleContext {
            profile_id: ProfileId(profile_id.clone()),
            library_id: LibraryId(library_id.clone()),
            project_id: None,
            connection_id: "profile-clone-test".into(),
            adapter: AdapterKind::Test,
            editor_history_owner: None,
            agent_attribution: None,
        };
        nodex_core::administration::StoreAdministrationModule::new(profile_id, library_id, &kernel)
            .apply(
                &context,
                ModuleApplyRequest {
                    contract_version: STORE_ADMINISTRATION_CONTRACT_VERSION,
                    operation_id: "clone:content-backup".into(),
                    store_epoch: StoreEpoch(epoch),
                    intent: StoreAdministrationIntent::CreateBackup {
                        label: None,
                        include_assets: true,
                        trigger: BackupTrigger::Manual,
                    },
                },
            )
            .unwrap();
        kernel
    }

    #[test]
    fn clone_publishes_a_consistent_snapshot_while_core_and_execution_are_open() {
        let source = nodex_platform::test_support::tempdir().unwrap();
        let target = nodex_platform::test_support::tempdir().unwrap();
        let mut writer = fixture(source.path());
        let _core = publish_content_backup(source.path());
        let clone_home = target.path().join("clone");
        let running = Arc::new(AtomicBool::new(true));
        let commits = Arc::new(AtomicU64::new(0));
        std::thread::scope(|scope| {
            let running_writer = Arc::clone(&running);
            let writer_commits = Arc::clone(&commits);
            let handle = scope.spawn(move || {
                while running_writer.load(Ordering::SeqCst) {
                    let transaction = writer.transaction().unwrap();
                    transaction
                        .execute("UPDATE watermark SET value=value+1", [])
                        .unwrap();
                    transaction
                        .execute(
                            "UPDATE history SET value=(SELECT value FROM watermark) WHERE id <= 2",
                            [],
                        )
                        .unwrap();
                    transaction.commit().unwrap();
                    writer_commits.fetch_add(1, Ordering::SeqCst);
                    std::thread::yield_now();
                }
            });
            while commits.load(Ordering::SeqCst) == 0 {
                std::thread::yield_now();
            }
            let before = commits.load(Ordering::SeqCst);
            let outcome = crate::materialize_profile_clone(crate::ProfileCloneRequest {
                source_profile_home: source.path().to_path_buf(),
                target_profile_home: clone_home.clone(),
                backup: crate::ProfileCloneBackupSelection::Latest,
            });
            let after = commits.load(Ordering::SeqCst);
            running.store(false, Ordering::SeqCst);
            handle.join().unwrap();
            let clone_receipt = outcome.unwrap();
            let published_receipt: serde_json::Value = serde_json::from_slice(
                &fs::read(clone_home.join("profile-snapshot.json")).unwrap(),
            )
            .unwrap();
            assert_eq!(
                published_receipt,
                serde_json::to_value(&clone_receipt).unwrap()
            );
            assert!(published_receipt.get("conversations").is_none());
            let receipt = clone_receipt.execution.unwrap();
            assert!(after > before, "source commits continue during capture");
            let database = clone_home.join("agent-runtime/agent-runtime.sqlite");
            for relative in [
                "agent-runtime/agent-runtime.sqlite",
                "agent-runtime/userdata/environment-id",
                "agent-runtime/userdata/attachments/images/a.png",
                "agent-runtime/imported-execution.json",
            ] {
                nodex_platform::private_fs::checked_metadata(
                    &clone_home.join(relative),
                    nodex_platform::private_fs::EntryKind::File,
                    Some(0o600),
                )
                .unwrap();
            }
            let snapshot =
                Connection::open_with_flags(&database, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
            assert_eq!(
                snapshot
                    .query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
                    .unwrap(),
                "ok"
            );
            let (watermark, first, second): (i64, i64, i64) = snapshot.query_row("SELECT value, (SELECT value FROM history WHERE id=1), (SELECT value FROM history WHERE id=2) FROM watermark", [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap();
            assert_eq!(first, watermark);
            assert_eq!(second, watermark);
            assert_eq!(
                receipt.database_bytes,
                fs::metadata(database).unwrap().len()
            );
            assert_eq!(receipt.attachment_files, 1);
            assert_eq!(
                receipt.attachment_bytes,
                b"immutable attachment".len() as u64
            );
            assert_eq!(
                fs::read(clone_home.join("agent-runtime/userdata/attachments/images/a.png"))
                    .unwrap(),
                b"immutable attachment"
            );
            assert_eq!(
                fs::read(clone_home.join("agent-runtime/userdata/environment-id")).unwrap(),
                b"engine:test\n"
            );
            let marker: serde_json::Value = serde_json::from_slice(
                &fs::read(clone_home.join("agent-runtime/imported-execution.json")).unwrap(),
            )
            .unwrap();
            assert_eq!(marker.as_object().unwrap().len(), 3);
            assert_eq!(marker["version"], 1);
            assert_eq!(
                marker["sourceProfileHome"],
                source.path().canonicalize().unwrap().to_str().unwrap()
            );
            chrono::DateTime::parse_from_rfc3339(marker["importedAt"].as_str().unwrap()).unwrap();
            assert!(!clone_home.join("agent").exists());
            assert!(
                !clone_home
                    .join("agent-runtime/provider-catalog.json")
                    .exists()
            );
        });
    }

    #[test]
    fn rejects_attachment_file_directory_and_root_symlinks() {
        for relative in ["images/a.png", "images", ""] {
            let source = nodex_platform::test_support::tempdir().unwrap();
            let target = nodex_platform::test_support::tempdir().unwrap();
            let _connection = fixture(source.path());
            let attachments = source.path().join("agent-runtime/userdata/attachments");
            let path = if relative.is_empty() {
                attachments
            } else {
                attachments.join(relative)
            };
            if path.is_dir() {
                fs::remove_dir_all(&path).unwrap();
            } else {
                fs::remove_file(&path).unwrap();
            }
            let outside = source.path().join("outside");
            if relative == "images/a.png" {
                nodex_platform::private_fs::write(&outside, b"outside").unwrap();
                symlink(&outside, &path).unwrap();
            } else {
                nodex_platform::private_fs::create_dir(&outside).unwrap();
                nodex_platform::private_fs::directory_link(&outside, &path).unwrap();
            }
            let error = capture(
                &source.path().canonicalize().unwrap(),
                &target.path().canonicalize().unwrap(),
            )
            .unwrap_err();
            assert!(
                error.to_string().contains("symbolic links")
                    || error.to_string().contains("real directory"),
                "{error}"
            );
            assert!(
                !target
                    .path()
                    .join("agent-runtime/imported-execution.json")
                    .exists()
            );
        }
    }

    #[test]
    fn absent_execution_database_needs_no_runtime_or_provider_data() {
        let source = nodex_platform::test_support::tempdir().unwrap();
        let target = nodex_platform::test_support::tempdir().unwrap();
        assert!(capture(source.path(), target.path()).unwrap().is_none());
        nodex_platform::private_fs::create_dir(source.path().join("agent-runtime")).unwrap();
        assert!(capture(source.path(), target.path()).unwrap().is_none());
        assert!(!target.path().join("agent-runtime").exists());
    }
}
