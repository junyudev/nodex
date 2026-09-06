use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::infrastructure::sqlite::{
    StoreError, StoreErrorCode, open_writer, with_immediate_transaction,
};
use crate::infrastructure::store::STORE_FILE_NAME;

use super::{backup, restore};

const PROFILE_SNAPSHOT_FILE_NAME: &str = "profile-snapshot.json";
const PROFILE_SNAPSHOT_VERSION: u32 = 4;
const PRIVATE_DIRECTORY_MODE: u32 = 0o700;
const PRIVATE_FILE_MODE: u32 = 0o600;

#[derive(Clone, Debug, Deserialize, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProfileCloneBackupSelection {
    Latest,
    Id(String),
}

#[derive(Clone, Debug)]
pub struct ProfileCloneRequest {
    pub source_profile_home: PathBuf,
    pub target_profile_home: PathBuf,
    pub backup: ProfileCloneBackupSelection,
}

#[derive(Clone, Debug, Deserialize, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProfileCloneReceipt {
    pub version: u32,
    pub source_profile_fingerprint: String,
    pub backup_integrity_evidence_version: u32,
    pub missing_managed_asset_count: usize,
    pub backup_id: String,
    pub backup_created_at: String,
    pub cloned_at: String,
    pub store_schema_version: u32,
    pub source_store_epoch: String,
    pub store_epoch: String,
    pub profile_id: String,
    pub library_id: String,
}

pub fn materialize_profile_clone(
    request: ProfileCloneRequest,
) -> Result<ProfileCloneReceipt, StoreError> {
    let source = require_real_directory(&request.source_profile_home, "Source Profile")?;
    let target = resolve_new_target(&request.target_profile_home)?;
    if target.starts_with(&source) || source.starts_with(&target) {
        return Err(invalid_profile(
            "Source and target Profile homes must not contain one another",
        ));
    }

    let backup_id = match &request.backup {
        ProfileCloneBackupSelection::Latest => None,
        ProfileCloneBackupSelection::Id(backup_id) => Some(backup_id.as_str()),
    };
    let backup = backup::resolve_backup_for_profile_clone(&source, backup_id)?;
    let staging = create_staging_directory(&target)?;
    let source_profile_fingerprint = hex::encode(Sha256::digest(source.as_os_str().as_bytes()));
    let result =
        materialize_staging_profile(&target, &staging, &backup, source_profile_fingerprint);
    match result {
        Ok(receipt) => Ok(receipt),
        Err(error) => {
            remove_owned_staging_directory(&target, &staging)?;
            Err(error)
        }
    }
}

fn materialize_staging_profile(
    target: &Path,
    staging: &Path,
    backup: &backup::EvidenceBackedProfileClone,
    source_profile_fingerprint: String,
) -> Result<ProfileCloneReceipt, StoreError> {
    backup::copy_backup_to_profile(backup, staging)?;
    let database_path = staging.join(STORE_FILE_NAME);
    let (profile_id, library_id) = read_identity(&database_path)?;
    let source_store_epoch = backup.store_epoch().to_owned();
    remint_profile_secrets(&database_path)?;
    let validation = restore::validate_profile_snapshot_candidate(
        &database_path,
        &staging.join("assets"),
        &profile_id,
        &library_id,
    )?;
    if validation.store_epoch != source_store_epoch {
        return Err(corrupt(
            "Profile clone Store epoch diverges from its backup manifest",
        ));
    }
    if validation.store_schema_version != backup.store_schema_version() {
        return Err(corrupt(
            "Profile clone Store schema diverges from its backup manifest",
        ));
    }

    let receipt = ProfileCloneReceipt {
        version: PROFILE_SNAPSHOT_VERSION,
        source_profile_fingerprint,
        backup_integrity_evidence_version: backup.integrity_evidence_version(),
        missing_managed_asset_count: validation.missing_managed_asset_count,
        backup_id: backup.backup_id().to_owned(),
        backup_created_at: backup.created_at().to_owned(),
        cloned_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        store_schema_version: backup.store_schema_version(),
        store_epoch: source_store_epoch.clone(),
        source_store_epoch,
        profile_id,
        library_id,
    };
    write_receipt(staging, &receipt)?;
    sync_directory(staging)?;
    fs::rename(staging, target).map_err(io_error)?;
    sync_directory(
        target
            .parent()
            .ok_or_else(|| invalid_profile("Target Profile has no parent directory"))?,
    )?;
    Ok(receipt)
}

fn read_identity(database_path: &Path) -> Result<(String, String), StoreError> {
    let connection = crate::infrastructure::sqlite::open_immutable_reader(database_path)?;
    let identities = connection
        .prepare("SELECT profile_id, id FROM libraries ORDER BY id")?
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let [identity] = identities.as_slice() else {
        return Err(corrupt(
            "Profile clone requires exactly one Profile and Library identity",
        ));
    };
    if identity.0.is_empty() || identity.1.is_empty() {
        return Err(corrupt("Profile clone identity is invalid"));
    }
    Ok(identity.clone())
}

fn remint_profile_secrets(database_path: &Path) -> Result<(), StoreError> {
    let mut connection = open_writer(database_path)?;
    with_immediate_transaction(&mut connection, |transaction| {
        let token_changed = transaction.execute(
            "UPDATE nodex_agent_token_keys SET key_material = randomblob(32) WHERE id = 1",
            [],
        )?;
        let runtime_changed = transaction.execute(
            "UPDATE core_automation_runtime_metadata \
             SET jitter_salt = lower(hex(randomblob(16))), \
                 created_at_unix_ms = CAST(unixepoch('subsec') * 1000 AS INTEGER) \
             WHERE id = 1",
            [],
        )?;
        if token_changed != 1 || runtime_changed != 1 {
            return Err(corrupt("Profile clone could not remint instance secrets"));
        }
        Ok(())
    })?;
    connection.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")?;
    Ok(())
}

fn write_receipt(profile_home: &Path, receipt: &ProfileCloneReceipt) -> Result<(), StoreError> {
    let mut bytes = serde_json::to_vec_pretty(receipt)
        .map_err(|_| internal("Profile snapshot receipt could not be encoded"))?;
    bytes.push(b'\n');
    let path = profile_home.join(PROFILE_SNAPSHOT_FILE_NAME);
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(PRIVATE_FILE_MODE)
        .open(path)
        .map_err(io_error)?;
    file.write_all(&bytes).map_err(io_error)?;
    file.sync_all().map_err(io_error)
}

fn require_real_directory(path: &Path, label: &str) -> Result<PathBuf, StoreError> {
    let absolute = absolute_path(path)?;
    let metadata = fs::symlink_metadata(&absolute).map_err(io_error)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(invalid_profile(format!("{label} must be a real directory")));
    }
    absolute.canonicalize().map_err(io_error)
}

fn resolve_new_target(path: &Path) -> Result<PathBuf, StoreError> {
    let absolute = absolute_path(path)?;
    match fs::symlink_metadata(&absolute) {
        Ok(_) => {
            return Err(StoreError::new(
                StoreErrorCode::AlreadyOwned,
                "Target Profile home already exists",
                false,
            ));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(io_error(error)),
    }
    let parent = absolute
        .parent()
        .ok_or_else(|| invalid_profile("Target Profile has no parent directory"))?;
    let parent = require_real_directory(parent, "Target Profile parent")?;
    let file_name = absolute
        .file_name()
        .ok_or_else(|| invalid_profile("Target Profile name is invalid"))?;
    Ok(parent.join(file_name))
}

fn absolute_path(path: &Path) -> Result<PathBuf, StoreError> {
    if path.is_absolute() {
        return Ok(path.to_path_buf());
    }
    std::env::current_dir()
        .map(|current| current.join(path))
        .map_err(io_error)
}

fn create_staging_directory(target: &Path) -> Result<PathBuf, StoreError> {
    let parent = target
        .parent()
        .ok_or_else(|| invalid_profile("Target Profile has no parent directory"))?;
    let mut random = [0_u8; 16];
    getrandom::fill(&mut random)
        .map_err(|_| internal("Profile clone identity entropy is unavailable"))?;
    let staging = parent.join(format!(".profile-clone-{}.tmp", hex::encode(random)));
    fs::DirBuilder::new()
        .mode(PRIVATE_DIRECTORY_MODE)
        .create(&staging)
        .map_err(io_error)?;
    Ok(staging)
}

fn remove_owned_staging_directory(target: &Path, staging: &Path) -> Result<(), StoreError> {
    let parent = target
        .parent()
        .ok_or_else(|| invalid_profile("Target Profile has no parent directory"))?;
    let owned = staging.parent() == Some(parent)
        && staging
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with(".profile-clone-") && name.ends_with(".tmp"));
    if !owned {
        return Err(invalid_profile(
            "Profile clone staging path is outside its owner directory",
        ));
    }
    let metadata = match fs::symlink_metadata(staging) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(io_error(error)),
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(invalid_profile(
            "Profile clone staging path is not an owned directory",
        ));
    }
    fs::remove_dir_all(staging).map_err(io_error)?;
    sync_directory(parent)
}

fn sync_directory(path: &Path) -> Result<(), StoreError> {
    File::open(path)
        .map_err(io_error)?
        .sync_all()
        .map_err(io_error)
}

fn corrupt(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message, false)
}

fn invalid_profile(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidProfile, message, false)
}

fn internal(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::Internal, message, false)
}

fn io_error(error: std::io::Error) -> StoreError {
    StoreError::new(
        StoreErrorCode::Internal,
        format!("Profile clone filesystem operation failed: {error}"),
        false,
    )
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Seek, SeekFrom, Write};

    use tempfile::tempdir;

    use crate::infrastructure::store::SqliteStoreKernel;

    use super::*;

    #[test]
    fn clones_a_published_backup_as_an_isolated_local_fork() {
        let directory = tempdir().expect("clone fixture");
        let source = directory.path().join("source");
        let target = directory.path().join("target");
        fs::create_dir(&source).expect("source Profile");
        let kernel = SqliteStoreKernel::open_test(&source).expect("source Store");
        kernel
            .writer()
            .call(|connection| {
                with_immediate_transaction(connection, |transaction| {
                    transaction.execute(
                        "INSERT INTO block_store_metadata( \
                           id, store_epoch, created_at, updated_at \
                         ) VALUES ( \
                           1, 'epoch:profile-clone-source', \
                           '2026-08-21T00:00:00.000Z', '2026-08-21T00:00:00.000Z' \
                         )",
                        [],
                    )?;
                    transaction.execute(
                        "INSERT INTO profiles(id, created_at, updated_at) \
                         VALUES ( \
                           'profile:clone-test', \
                           '2026-08-21T00:00:00.000Z', '2026-08-21T00:00:00.000Z' \
                         )",
                        [],
                    )?;
                    transaction.execute(
                        "INSERT INTO libraries(id, profile_id, created_at, updated_at) \
                         VALUES ( \
                           'library:clone-test', 'profile:clone-test', \
                           '2026-08-21T00:00:00.000Z', '2026-08-21T00:00:00.000Z' \
                         )",
                        [],
                    )?;
                    // A diagnostic fork preserves source anomalies. Restore and
                    // ordinary Document reads still require an owning Block.
                    transaction.execute_batch(
                        "INSERT INTO documents(id, library_id, generation, head_seq, schema_key,
                           schema_version, state_vector, state_hash, readiness, authority,
                           created_at, updated_at, sync_engine)
                         VALUES ('unowned-source', 'library:clone-test', 1, 0, 'nodex.page', 3,
                           X'', '', 'ready', 'ydoc_primary', '2026-08-21T00:00:00.000Z',
                           '2026-08-21T00:00:00.000Z', 'yjs');",
                    )?;
                    let document = crate::document::prepare_page_yjs_genesis("unowned-source", "Retained", "retained-root")?;
                    transaction.execute("UPDATE documents SET state_vector = ?1 WHERE id = 'unowned-source'", [&document.state_vector_v1])?;
                    transaction.execute(
                        "INSERT INTO document_snapshots(document_id, generation, snapshot_seq, state_vector,
                           snapshot_update, snapshot_hash, schema_version, created_at)
                         VALUES ('unowned-source', 1, 0, ?1, ?2, ?3, 3, '2026-08-21T00:00:00.000Z')",
                        rusqlite::params![document.state_vector_v1, document.update_v1, crate::document::sha256(&document.update_v1)],
                    )?;
                    let materialization = &document.materialization;
                    let title = serde_json::to_string(&materialization.rich_title).unwrap();
                    transaction.execute(
                        "INSERT INTO document_materializations(document_id, generation, projected_seq,
                           schema_version, title, title_rich_json, title_rich_hash, nfm, plain_text, preview,
                           block_tree_json, updated_at)
                         VALUES ('unowned-source', 1, 0, 3, ?1, ?2, ?3, ?4, ?5, ?6, ?7, '2026-08-21T00:00:00.000Z')",
                        rusqlite::params![materialization.title, title, crate::document::sha256(title.as_bytes()),
                            materialization.nfm, materialization.plain_text, materialization.preview,
                            serde_json::to_string(&materialization.block_tree).unwrap()],
                    )?;
                    Ok(())
                })
            })
            .expect("source identity");
        let ((profile_id, _library_id), source_secrets) = kernel
            .readers()
            .read_default(|connection| {
                let identity =
                    connection.query_row("SELECT profile_id, id FROM libraries", [], |row| {
                        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                    })?;
                let secrets = connection.query_row(
                    "SELECT token.key_material, runtime.jitter_salt \
                     FROM nodex_agent_token_keys token \
                     CROSS JOIN core_automation_runtime_metadata runtime \
                     WHERE token.id = 1 AND runtime.id = 1",
                    [],
                    |row| Ok((row.get::<_, Vec<u8>>(0)?, row.get::<_, String>(1)?)),
                )?;
                Ok((identity, secrets))
            })
            .expect("source identity and secrets");
        let request_hash = "a".repeat(64);
        let backup = kernel
            .readers()
            .read_default(|connection| {
                backup::create_backup(
                    connection,
                    &source,
                    &profile_id,
                    "profile-clone-test",
                    &request_hash,
                    Some("profile clone test"),
                    true,
                    nodex_core_contracts::administration::BackupTrigger::Manual,
                    &|_| Ok(()),
                    &|| Ok(false),
                )
            })
            .expect("stage backup");
        let backup_record = backup.record().clone();
        backup::publish_verified_backup(backup).expect("publish backup");
        drop(kernel);

        let receipt = materialize_profile_clone(ProfileCloneRequest {
            source_profile_home: source.clone(),
            target_profile_home: target.clone(),
            backup: ProfileCloneBackupSelection::Latest,
        })
        .expect("clone Profile");

        assert_eq!(receipt.backup_id, backup_record.backup_id);
        assert_eq!(receipt.version, PROFILE_SNAPSHOT_VERSION);
        assert_eq!(receipt.backup_integrity_evidence_version, 1);
        assert_eq!(receipt.missing_managed_asset_count, 0);
        assert_eq!(receipt.source_store_epoch, "epoch:profile-clone-source");
        assert_eq!(receipt.store_epoch, receipt.source_store_epoch);
        let clone = open_writer(&target.join(STORE_FILE_NAME)).expect("cloned Store");
        assert!(crate::document::read_document_authority(&clone, "unowned-source").is_err());
        assert_eq!(
            clone
                .query_row(
                    "SELECT count(*) FROM documents WHERE id = 'unowned-source'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            1,
        );
        let clone_secrets = clone
            .query_row(
                "SELECT token.key_material, runtime.jitter_salt \
                 FROM nodex_agent_token_keys token \
                 CROSS JOIN core_automation_runtime_metadata runtime \
                 WHERE token.id = 1 AND runtime.id = 1",
                [],
                |row| Ok((row.get::<_, Vec<u8>>(0)?, row.get::<_, String>(1)?)),
            )
            .expect("clone secrets");
        assert_ne!(source_secrets.0, clone_secrets.0);
        assert_ne!(source_secrets.1, clone_secrets.1);
        assert_eq!(
            serde_json::from_slice::<ProfileCloneReceipt>(
                &fs::read(target.join(PROFILE_SNAPSHOT_FILE_NAME)).expect("snapshot receipt")
            )
            .expect("valid snapshot receipt")
            .store_epoch,
            receipt.store_epoch
        );
        assert!(!source.join(PROFILE_SNAPSHOT_FILE_NAME).exists());

        let published = source.join("backups").join(&backup_record.backup_id);
        fs::write(published.join("assets/unexpected.bin"), b"").expect("tampered asset tree");
        let asset_target = directory.path().join("asset-tamper-target");
        let asset_error = materialize_profile_clone(ProfileCloneRequest {
            source_profile_home: source.clone(),
            target_profile_home: asset_target.clone(),
            backup: ProfileCloneBackupSelection::Latest,
        })
        .expect_err("asset digest mismatch");
        assert_eq!(asset_error.code, StoreErrorCode::StoreCorrupt);
        assert!(asset_error.message.contains("integrity evidence"));
        assert!(!asset_target.exists());
        fs::remove_file(published.join("assets/unexpected.bin")).expect("restore asset tree");

        let mut database = OpenOptions::new()
            .read(true)
            .write(true)
            .open(published.join(STORE_FILE_NAME))
            .expect("published Store");
        database
            .seek(SeekFrom::Start(4_096))
            .expect("tamper offset");
        let mut byte = [0_u8; 1];
        database.read_exact(&mut byte).expect("tamper source byte");
        database
            .seek(SeekFrom::Start(4_096))
            .expect("tamper offset");
        byte[0] ^= 0xff;
        database.write_all(&byte).expect("tamper Store byte");
        let database_target = directory.path().join("database-tamper-target");
        let database_error = materialize_profile_clone(ProfileCloneRequest {
            source_profile_home: source,
            target_profile_home: database_target.clone(),
            backup: ProfileCloneBackupSelection::Latest,
        })
        .expect_err("database digest mismatch");
        assert_eq!(database_error.code, StoreErrorCode::StoreCorrupt);
        assert!(database_error.message.contains("integrity evidence"));
        assert!(!database_target.exists());
    }

    #[test]
    fn refuses_to_replace_an_existing_target_profile() {
        let directory = tempdir().expect("clone fixture");
        let source = directory.path().join("source");
        let target = directory.path().join("target");
        fs::create_dir(&source).expect("source Profile");
        fs::create_dir(&target).expect("target Profile");
        fs::write(target.join("sentinel"), b"keep").expect("target sentinel");

        let error = materialize_profile_clone(ProfileCloneRequest {
            source_profile_home: source,
            target_profile_home: target.clone(),
            backup: ProfileCloneBackupSelection::Latest,
        })
        .expect_err("existing target must be rejected");

        assert_eq!(error.code, StoreErrorCode::AlreadyOwned);
        assert_eq!(
            fs::read(target.join("sentinel")).expect("sentinel"),
            b"keep"
        );
    }
}
