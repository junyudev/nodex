use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::time::Duration;
use std::time::Instant;

use nodex_core_contracts::administration::{
    BackupCapacity, BackupJobPhase, BackupJobProgress, BackupJobRecord, BackupJobState,
    BackupRecord, BackupTrigger, ProfileSnapshotSource,
};
use rusqlite::backup::{Backup, StepResult};
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::document::integrity::validate_restore_documents;
use crate::infrastructure::schema::CURRENT_STORE_REVISION;
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode, open_immutable_reader};
use crate::infrastructure::store_validation::validate_current_store;

const BACKUP_MANIFEST_VERSION: u32 = 4;
const BACKUP_INTEGRITY_EVIDENCE_VERSION: u32 = 1;
const BACKUP_DATABASE_FILE_NAME: &str = "nodex.db";
const BACKUP_ASSETS_DIRECTORY_NAME: &str = "assets";
const BACKUP_MANIFEST_FILE_NAME: &str = "manifest.json";
const BACKUP_CONTROL_DIRECTORY_NAME: &str = ".control";
const BACKUP_JOB_DIRECTORY_NAME: &str = "jobs";
const BACKUP_JOB_VERSION: u32 = 1;
const MAX_MANIFEST_BYTES: u64 = 64 * 1024;
const MAX_BACKUP_JOB_BYTES: u64 = 64 * 1024;
const MAX_BACKUP_JOBS: usize = 32;
const MAX_BACKUP_ENTRIES: usize = 10_000;
const MAX_BACKUP_TREE_ENTRIES: usize = 100_000;
const DIGEST_BUFFER_BYTES: usize = 1024 * 1024;
const ASSET_TREE_DIGEST_DOMAIN: &[u8] = b"nodex-backup-asset-tree-v1\0";
const MIN_BACKUP_SAFETY_MARGIN_BYTES: u64 = 512 * 1024 * 1024;
const ONLINE_BACKUP_PAGES_PER_STEP: i32 = 512;
const ONLINE_BACKUP_STEP_PAUSE: Duration = Duration::from_millis(1);

pub(super) struct BackupInventoryItem {
    pub record: BackupRecord,
    pub trigger: String,
}

#[derive(Clone, Copy)]
pub(super) enum BackupCapacityMode {
    /// Cheap projection for Settings. The next job performs an authoritative
    /// live preflight before writing staging bytes.
    InventoryEstimate,
    LivePreflight,
}

/// Process-local proof that this exact staging directory passed the expensive
/// database and asset validation in the current operation. Publication may
/// consume it without repeating those reads; crash recovery deliberately does
/// not persist this capability and therefore revalidates from bytes.
pub(super) struct VerifiedStagedBackup {
    record: BackupRecord,
    root: PathBuf,
    staging_directory: PathBuf,
    final_directory: PathBuf,
    staging_device: u64,
    staging_inode: u64,
}

impl VerifiedStagedBackup {
    pub(super) fn record(&self) -> &BackupRecord {
        &self.record
    }
}

pub(super) struct ValidatedRestoreBackup {
    directory: PathBuf,
    manifest: BackupManifest,
}

pub(super) struct EvidenceBackedProfileClone {
    directory: PathBuf,
    manifest: BackupManifest,
}

impl EvidenceBackedProfileClone {
    pub(super) fn backup_id(&self) -> &str {
        &self.manifest.id
    }

    pub(super) fn created_at(&self) -> &str {
        &self.manifest.created_at
    }

    pub(super) fn store_schema_version(&self) -> u32 {
        self.manifest
            .store_schema_version
            .expect("evidence-backed backups have a schema version")
    }

    pub(super) fn store_epoch(&self) -> &str {
        self.manifest
            .store_epoch
            .as_deref()
            .expect("evidence-backed backups have a Store epoch")
    }

    pub(super) fn integrity_evidence_version(&self) -> u32 {
        self.manifest
            .integrity_evidence
            .as_ref()
            .expect("evidence-backed Profile clone has integrity evidence")
            .version
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackupIntegrityEvidence {
    version: u32,
    database_sha256: String,
    asset_tree_sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    execution_tree_sha256: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackupManifest {
    #[serde(default = "manifest_version")]
    version: u32,
    id: String,
    created_at: String,
    trigger: String,
    label: Option<String>,
    #[serde(default)]
    includes_assets: bool,
    #[serde(default)]
    db_bytes: u64,
    #[serde(default)]
    assets_bytes: u64,
    #[serde(default)]
    execution_bytes: u64,
    #[serde(default)]
    total_bytes: u64,
    store_schema_version: Option<u32>,
    store_epoch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    integrity_evidence: Option<BackupIntegrityEvidence>,
    #[serde(skip_serializing_if = "Option::is_none")]
    core_operation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    core_request_hash: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackupJobJournal {
    version: u32,
    job_id: String,
    operation_id: String,
    request_hash: String,
    profile_id: String,
    state: BackupJobState,
    phase: BackupJobPhase,
    started_at_ms: i64,
    updated_at_ms: i64,
    label: Option<String>,
    include_assets: bool,
    trigger: String,
    backup_id: String,
    error: Option<String>,
    #[serde(default)]
    progress: BackupJobProgress,
}

pub(super) fn list_backup_inventory(
    profile_home: &Path,
) -> Result<Vec<BackupInventoryItem>, StoreError> {
    let root = profile_home.join("backups");
    let Some(entries) = read_backup_root(&root)? else {
        return Ok(Vec::new());
    };
    if entries.len() > MAX_BACKUP_ENTRIES {
        return Err(corrupt("Backup inventory exceeds its entry bound"));
    }
    let mut backups = Vec::new();
    for entry in entries {
        let file_type = entry.file_type().map_err(io_error)?;
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if !file_type.is_dir() || name.starts_with('.') || !is_safe_backup_id(&name) {
            continue;
        }
        let directory = entry.path();
        let Ok(manifest) = read_manifest(&directory) else {
            continue;
        };
        if manifest.id != name || validate_manifest(&manifest).is_err() {
            continue;
        }
        backups.push(BackupInventoryItem {
            record: to_record(&manifest),
            trigger: manifest.trigger,
        });
    }
    backups.sort_by(|left, right| {
        right
            .record
            .created_at
            .cmp(&left.record.created_at)
            .then_with(|| right.record.backup_id.cmp(&left.record.backup_id))
    });
    Ok(backups)
}

pub(super) fn backup_capacity(
    profile_home: &Path,
    inventory: &[BackupInventoryItem],
    include_assets: bool,
    mode: BackupCapacityMode,
) -> Result<BackupCapacity, StoreError> {
    let database_path = profile_home.join(BACKUP_DATABASE_FILE_NAME);
    let database_bytes = regular_file_length(&database_path)?;
    let asset_bytes = if !include_assets {
        0
    } else if matches!(mode, BackupCapacityMode::LivePreflight) {
        inspect_optional_assets(&profile_home.join(BACKUP_ASSETS_DIRECTORY_NAME))?
    } else {
        inventory
            .iter()
            .map(|item| item.record.assets_bytes)
            .max()
            .unwrap_or(0)
    };
    let estimated_next_backup_bytes = database_bytes
        .checked_add(asset_bytes)
        .and_then(|bytes| {
            bytes.checked_add(
                inventory
                    .iter()
                    .map(|item| item.record.execution_bytes)
                    .max()
                    .unwrap_or(0),
            )
        })
        .ok_or_else(|| internal("Estimated Backup byte length exceeds its bound"))?;
    let safety_margin_bytes = MIN_BACKUP_SAFETY_MARGIN_BYTES.max(estimated_next_backup_bytes / 10);
    let filesystem = rustix::fs::statvfs(profile_home)
        .map_err(|error| io_error(std::io::Error::from_raw_os_error(error.raw_os_error())))?;
    let available_bytes = filesystem.f_bavail.saturating_mul(filesystem.f_frsize);
    let mut total_ready_bytes = 0_u64;
    let mut manual_ready_bytes = 0_u64;
    let mut automatic_ready_bytes = 0_u64;
    for item in inventory {
        total_ready_bytes = total_ready_bytes.saturating_add(item.record.total_bytes);
        if item.trigger == "auto" {
            automatic_ready_bytes = automatic_ready_bytes.saturating_add(item.record.total_bytes);
        } else {
            manual_ready_bytes = manual_ready_bytes.saturating_add(item.record.total_bytes);
        }
    }
    let required_bytes = estimated_next_backup_bytes.saturating_add(safety_margin_bytes);
    Ok(BackupCapacity {
        available_bytes,
        estimated_next_backup_bytes,
        safety_margin_bytes,
        total_ready_bytes,
        manual_ready_bytes,
        automatic_ready_bytes,
        can_create: available_bytes >= required_bytes,
    })
}

pub(super) fn list_backup_jobs(profile_home: &Path) -> Result<Vec<BackupJobRecord>, StoreError> {
    let root = profile_home.join("backups");
    let jobs_directory = root
        .join(BACKUP_CONTROL_DIRECTORY_NAME)
        .join(BACKUP_JOB_DIRECTORY_NAME);
    let metadata = match fs::symlink_metadata(&jobs_directory) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(io_error(error)),
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(invalid_profile(
            "Backup job control root must be a real directory",
        ));
    }
    let mut journals = fs::read_dir(&jobs_directory)
        .map_err(io_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(io_error)?
        .into_iter()
        .filter(|entry| {
            entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.ends_with(".json") && !name.starts_with('.'))
        })
        .collect::<Vec<_>>();
    if journals.len() > MAX_BACKUP_JOBS {
        return Err(corrupt("Backup job journal exceeds its entry bound"));
    }
    journals.sort_by_key(fs::DirEntry::file_name);
    let mut jobs = Vec::with_capacity(journals.len());
    for entry in journals {
        let metadata = fs::symlink_metadata(entry.path()).map_err(io_error)?;
        if metadata.file_type().is_symlink()
            || !metadata.is_file()
            || metadata.len() > MAX_BACKUP_JOB_BYTES
        {
            return Err(corrupt("Backup job journal contains an invalid entry"));
        }
        let journal: BackupJobJournal =
            serde_json::from_slice(&fs::read(entry.path()).map_err(io_error)?)
                .map_err(|_| corrupt("Backup job journal JSON is invalid"))?;
        validate_backup_job(&journal)?;
        jobs.push(to_job_record(journal)?);
    }
    jobs.sort_by(|left, right| {
        right
            .updated_at_ms
            .cmp(&left.updated_at_ms)
            .then_with(|| right.job_id.cmp(&left.job_id))
    });
    Ok(jobs)
}

pub(super) fn validate_backup_for_deletion(
    profile_home: &Path,
    backup_id: &str,
) -> Result<(), StoreError> {
    if !is_safe_backup_id(backup_id) {
        return Err(StoreError::new(
            StoreErrorCode::InvalidInput,
            "Backup identity is invalid",
            false,
        ));
    }
    let root = profile_home.join("backups");
    require_directory(&root, "Backup root")?;
    let directory = root.join(backup_id);
    let metadata = match fs::symlink_metadata(&directory) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(StoreError::new(
                StoreErrorCode::NotFound,
                "Backup was not found",
                false,
            ));
        }
        Err(error) => return Err(io_error(error)),
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(invalid_profile(
            "Backup deletion target must be a real owned directory",
        ));
    }
    let mut inspected = 0usize;
    inspect_removable_tree(&directory, &mut inspected)
}

pub(super) fn publish_backup_deletions(
    profile_home: &Path,
    operation_id: &str,
    backup_ids: &[String],
) -> Result<(), StoreError> {
    if backup_ids.is_empty() {
        return Ok(());
    }
    let cleanup = stage_backup_deletions(profile_home, operation_id, backup_ids)?;
    let root = profile_home.join("backups");
    let mut inspected = 0usize;
    inspect_removable_tree(&cleanup, &mut inspected)?;
    fs::remove_dir_all(&cleanup).map_err(io_error)?;
    sync_directory(&root)
}

pub(super) fn stage_backup_deletions(
    profile_home: &Path,
    operation_id: &str,
    backup_ids: &[String],
) -> Result<PathBuf, StoreError> {
    if backup_ids.is_empty() {
        return Err(internal("Empty backup cleanup has no staging phase"));
    }
    let root = profile_home.join("backups");
    require_directory(&root, "Backup root")?;
    let cleanup_digest = Sha256::digest(format!("backup-cleanup\0{operation_id}"));
    let cleanup = root.join(format!(".cleanup-{}", hex(&cleanup_digest)));
    match fs::symlink_metadata(&cleanup) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err(invalid_profile(
                "Backup cleanup staging path must be a real owned directory",
            ));
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(&cleanup).map_err(io_error)?;
            sync_directory(&root)?;
        }
        Err(error) => return Err(io_error(error)),
    }
    for backup_id in backup_ids {
        if !is_safe_backup_id(backup_id) {
            return Err(corrupt("Durable backup deletion identity is invalid"));
        }
        let directory = root.join(backup_id);
        let staged = cleanup.join(backup_id);
        let metadata = match fs::symlink_metadata(&directory) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                match fs::symlink_metadata(&staged) {
                    Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
                        return Err(invalid_profile(
                            "Backup cleanup target must remain a real owned directory",
                        ));
                    }
                    Ok(_) => continue,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(error) => return Err(io_error(error)),
                }
            }
            Err(error) => return Err(io_error(error)),
        };
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(invalid_profile(
                "Backup deletion target must remain a real owned directory",
            ));
        }
        let mut inspected = 0usize;
        inspect_removable_tree(&directory, &mut inspected)?;
        if staged.exists() {
            return Err(corrupt(
                "Backup cleanup found duplicate published and staged directories",
            ));
        }
        fs::rename(&directory, &staged).map_err(io_error)?;
        sync_directory(&root)?;
    }
    Ok(cleanup)
}

#[allow(clippy::too_many_arguments)]
#[cfg(test)]
pub(super) fn create_backup(
    connection: &Connection,
    profile_home: &Path,
    profile_id: &str,
    operation_id: &str,
    request_hash: &str,
    label: Option<&str>,
    include_assets: bool,
    trigger: BackupTrigger,
    progress: &dyn Fn(BackupJobPhase) -> Result<(), StoreError>,
    cancellation_requested: &dyn Fn() -> Result<bool, StoreError>,
) -> Result<VerifiedStagedBackup, StoreError> {
    struct StoreOnly;
    impl super::ProfileSnapshotParticipant for StoreOnly {
        fn capture(&self, _: super::ProfileSnapshotCapture<'_>) -> Result<bool, StoreError> {
            Ok(false)
        }
    }
    create_profile_backup(
        connection,
        profile_home,
        profile_id,
        operation_id,
        request_hash,
        label,
        include_assets,
        trigger,
        progress,
        cancellation_requested,
        &StoreOnly,
        None,
    )
}

#[allow(clippy::too_many_arguments)]
pub(super) fn create_profile_backup(
    connection: &Connection,
    profile_home: &Path,
    profile_id: &str,
    operation_id: &str,
    request_hash: &str,
    label: Option<&str>,
    include_assets: bool,
    trigger: BackupTrigger,
    progress: &dyn Fn(BackupJobPhase) -> Result<(), StoreError>,
    cancellation_requested: &dyn Fn() -> Result<bool, StoreError>,
    participant: &dyn super::ProfileSnapshotParticipant,
    profile_snapshot: Option<&ProfileSnapshotSource>,
) -> Result<VerifiedStagedBackup, StoreError> {
    let trigger = trigger_name(trigger);
    stage_backup_with_trigger(
        connection,
        profile_home,
        profile_id,
        operation_id,
        request_hash,
        label,
        include_assets,
        trigger,
        progress,
        cancellation_requested,
        participant,
        profile_snapshot,
    )
}

pub(super) fn update_backup_job_phase(
    profile_home: &Path,
    operation_id: &str,
    state: BackupJobState,
    phase: BackupJobPhase,
    error: Option<&str>,
) -> Result<(), StoreError> {
    let Some(mut journal) = read_backup_job(profile_home, operation_id)? else {
        return Ok(());
    };
    journal.state = state;
    journal.phase = phase;
    journal.updated_at_ms = current_time_millis()?;
    journal.error = error.map(str::to_owned);
    write_backup_job(profile_home, &journal)
}

pub(super) fn update_backup_job_progress(
    profile_home: &Path,
    operation_id: &str,
    update: impl FnOnce(&mut BackupJobProgress),
) -> Result<(), StoreError> {
    let Some(mut journal) = read_backup_job(profile_home, operation_id)? else {
        return Ok(());
    };
    update(&mut journal.progress);
    journal.updated_at_ms = current_time_millis()?;
    write_backup_job(profile_home, &journal)
}

/// Durably records cancellation before publication. An active worker observes
/// the process-local flag between bounded database-copy steps; an adopted job
/// has no worker and can be cleaned immediately from its journal identity.
pub(super) fn request_backup_job_cancel(
    profile_home: &Path,
    operation_id: &str,
    has_active_worker: bool,
) -> Result<bool, StoreError> {
    let Some(mut journal) = read_backup_job(profile_home, operation_id)? else {
        return Err(StoreError::new(
            StoreErrorCode::NotFound,
            "Snapshot job was not found",
            false,
        ));
    };
    if journal.state == BackupJobState::Cancelled
        || (journal.state == BackupJobState::Cancelling && has_active_worker)
    {
        return Ok(false);
    }
    if matches!(
        journal.state,
        BackupJobState::Ready | BackupJobState::Failed
    ) || matches!(
        journal.phase,
        BackupJobPhase::Commit | BackupJobPhase::Publishing | BackupJobPhase::Ready
    ) {
        return Err(StoreError::new(
            StoreErrorCode::Conflict,
            "Snapshot can no longer be cancelled after publication has begun",
            false,
        ));
    }
    journal.updated_at_ms = current_time_millis()?;
    journal.error = None;
    if has_active_worker {
        journal.state = BackupJobState::Cancelling;
        journal.phase = BackupJobPhase::CancellationRequested;
        write_backup_job(profile_home, &journal)?;
        return Ok(true);
    }

    let root = prepare_backup_root(profile_home)?;
    let staging_directory = root.join(format!(".{}.tmp", journal.backup_id));
    if staging_directory.exists() {
        remove_owned_staging_directory(&root, &staging_directory)?;
    }
    journal.state = BackupJobState::Cancelled;
    journal.phase = BackupJobPhase::Cancelled;
    write_backup_job(profile_home, &journal)?;
    Ok(true)
}

pub(super) fn create_safety_backup(
    connection: &Connection,
    profile_home: &Path,
    profile_id: &str,
    restore_operation_id: &str,
    request_hash: &str,
    restored_backup_id: &str,
    participant: &dyn super::ProfileSnapshotParticipant,
    profile_snapshot: Option<&ProfileSnapshotSource>,
) -> Result<BackupRecord, StoreError> {
    let role_digest = Sha256::digest(format!("pre-restore\0{restore_operation_id}"));
    let operation_id = format!("pre-restore-{}", hex(&role_digest));
    let label = format!("Before restoring {restored_backup_id}");
    let staged = stage_backup_with_trigger(
        connection,
        profile_home,
        profile_id,
        &operation_id,
        request_hash,
        Some(&label),
        true,
        "pre-restore",
        &|_| Ok(()),
        &|| Ok(false),
        participant,
        profile_snapshot,
    )?;
    let record = staged.record().clone();
    publish_verified_backup(staged)?;
    update_backup_job_phase(
        profile_home,
        &operation_id,
        BackupJobState::Ready,
        BackupJobPhase::Ready,
        None,
    )?;
    Ok(record)
}

#[allow(clippy::too_many_arguments)]
fn stage_backup_with_trigger(
    connection: &Connection,
    profile_home: &Path,
    profile_id: &str,
    operation_id: &str,
    request_hash: &str,
    label: Option<&str>,
    include_assets: bool,
    trigger: &str,
    progress: &dyn Fn(BackupJobPhase) -> Result<(), StoreError>,
    cancellation_requested: &dyn Fn() -> Result<bool, StoreError>,
    participant: &dyn super::ProfileSnapshotParticipant,
    profile_snapshot: Option<&ProfileSnapshotSource>,
) -> Result<VerifiedStagedBackup, StoreError> {
    let participant_bytes = participant.estimated_bytes(profile_home, profile_snapshot)?;
    let filesystem = rustix::fs::statvfs(profile_home)
        .map_err(|error| io_error(std::io::Error::from_raw_os_error(error.raw_os_error())))?;
    let available = filesystem.f_bavail.saturating_mul(filesystem.f_frsize);
    if available < participant_bytes.saturating_add(MIN_BACKUP_SAFETY_MARGIN_BYTES) {
        return Err(StoreError::new(
            StoreErrorCode::ResourceExhausted,
            "Execution history requires more backup disk space and safety headroom",
            false,
        ));
    }
    let root = prepare_backup_root(profile_home)?;
    let backup_id = backup_id(profile_id, operation_id);
    begin_backup_job(
        profile_home,
        profile_id,
        operation_id,
        request_hash,
        label,
        include_assets,
        trigger,
        &backup_id,
    )?;
    let final_directory = root.join(&backup_id);
    let staging_directory = root.join(format!(".{backup_id}.tmp"));

    if final_directory.exists() {
        let record =
            adopt_published_backup(&final_directory, operation_id, request_hash, &backup_id)?;
        let metadata = fs::symlink_metadata(&final_directory).map_err(io_error)?;
        return Ok(VerifiedStagedBackup {
            record,
            root,
            staging_directory: final_directory.clone(),
            final_directory,
            staging_device: metadata.dev(),
            staging_inode: metadata.ino(),
        });
    }
    if let Some(record) = recover_staging_backup(
        &root,
        &staging_directory,
        operation_id,
        request_hash,
        &backup_id,
    )? {
        let metadata = fs::symlink_metadata(&staging_directory).map_err(io_error)?;
        return Ok(VerifiedStagedBackup {
            record,
            root,
            staging_directory,
            final_directory,
            staging_device: metadata.dev(),
            staging_inode: metadata.ino(),
        });
    }

    fs::create_dir(&staging_directory).map_err(io_error)?;
    let result = stage_backup(
        connection,
        profile_home,
        &staging_directory,
        &backup_id,
        operation_id,
        request_hash,
        label,
        include_assets,
        trigger,
        progress,
        cancellation_requested,
        participant,
        profile_snapshot,
    );
    let record = match result {
        Ok(record) => record,
        Err(error) => {
            remove_owned_staging_directory(&root, &staging_directory)?;
            if error.code == StoreErrorCode::QueryCancelled {
                update_backup_job_phase(
                    profile_home,
                    operation_id,
                    BackupJobState::Cancelled,
                    BackupJobPhase::Cancelled,
                    None,
                )?;
            } else {
                update_backup_job_phase(
                    profile_home,
                    operation_id,
                    BackupJobState::Failed,
                    BackupJobPhase::Failed,
                    Some("Snapshot creation failed."),
                )?;
            }
            return Err(error);
        }
    };
    let metadata = fs::symlink_metadata(&staging_directory).map_err(io_error)?;
    Ok(VerifiedStagedBackup {
        record,
        root,
        staging_directory,
        final_directory,
        staging_device: metadata.dev(),
        staging_inode: metadata.ino(),
    })
}

pub(super) fn publish_verified_backup(
    staged: VerifiedStagedBackup,
) -> Result<BackupRecord, StoreError> {
    if staged.staging_directory == staged.final_directory {
        return Ok(staged.record);
    }
    let metadata = fs::symlink_metadata(&staged.staging_directory).map_err(io_error)?;
    if metadata.file_type().is_symlink()
        || !metadata.is_dir()
        || metadata.dev() != staged.staging_device
        || metadata.ino() != staged.staging_inode
    {
        return Err(corrupt(
            "Verified backup staging identity changed before publication",
        ));
    }
    if staged.final_directory.exists() {
        return Err(corrupt(
            "Verified backup publication found an unexpected destination",
        ));
    }
    fs::rename(&staged.staging_directory, &staged.final_directory).map_err(io_error)?;
    sync_directory(&staged.root)?;
    Ok(staged.record)
}

pub(super) fn discard_verified_backup(staged: VerifiedStagedBackup) -> Result<(), StoreError> {
    if staged.staging_directory == staged.final_directory {
        return Ok(());
    }
    let metadata = fs::symlink_metadata(&staged.staging_directory).map_err(io_error)?;
    if metadata.file_type().is_symlink()
        || !metadata.is_dir()
        || metadata.dev() != staged.staging_device
        || metadata.ino() != staged.staging_inode
    {
        return Err(corrupt(
            "Verified backup staging identity changed before cleanup",
        ));
    }
    remove_owned_staging_directory(&staged.root, &staged.staging_directory)
}

pub(super) fn publish_backup(
    profile_home: &Path,
    operation_id: &str,
    request_hash: &str,
    backup_id: &str,
) -> Result<BackupRecord, StoreError> {
    if !is_safe_backup_id(backup_id) {
        return Err(corrupt("Backup publication identity is invalid"));
    }
    let root = prepare_backup_root(profile_home)?;
    let final_directory = root.join(backup_id);
    let staging_directory = root.join(format!(".{backup_id}.tmp"));
    if final_directory.exists() {
        let record =
            adopt_published_backup(&final_directory, operation_id, request_hash, backup_id)?;
        if staging_directory.exists() {
            adopt_published_backup(&staging_directory, operation_id, request_hash, backup_id)?;
            remove_owned_staging_directory(&root, &staging_directory)?;
        }
        return Ok(record);
    }
    let record = adopt_published_backup(&staging_directory, operation_id, request_hash, backup_id)?;
    fs::rename(&staging_directory, &final_directory).map_err(io_error)?;
    sync_directory(&root)?;
    Ok(record)
}

#[allow(clippy::too_many_arguments)]
fn stage_backup(
    connection: &Connection,
    profile_home: &Path,
    staging_directory: &Path,
    backup_id: &str,
    operation_id: &str,
    request_hash: &str,
    label: Option<&str>,
    include_assets: bool,
    trigger: &str,
    progress: &dyn Fn(BackupJobPhase) -> Result<(), StoreError>,
    cancellation_requested: &dyn Fn() -> Result<bool, StoreError>,
    participant: &dyn super::ProfileSnapshotParticipant,
    profile_snapshot: Option<&ProfileSnapshotSource>,
) -> Result<BackupRecord, StoreError> {
    let asset_snapshot_lease =
        crate::infrastructure::managed_asset_snapshot::acquire_snapshot_lease()?;
    progress(BackupJobPhase::DatabaseSnapshot)?;
    let database_path = staging_directory.join(BACKUP_DATABASE_FILE_NAME);
    let database_started_at = Instant::now();
    let mut database_busy_retries = 0u64;
    {
        let mut destination = Connection::open(&database_path)?;
        let backup = Backup::new(connection, &mut destination)?;
        let mut last_reported_at = Instant::now();
        loop {
            if cancellation_requested()? {
                return Err(backup_cancelled());
            }
            let step = backup.step(ONLINE_BACKUP_PAGES_PER_STEP)?;
            if matches!(step, StepResult::Busy | StepResult::Locked) {
                database_busy_retries = database_busy_retries.saturating_add(1);
            }
            let copy_finished = matches!(step, StepResult::Done);
            if copy_finished || last_reported_at.elapsed() >= Duration::from_millis(250) {
                let snapshot = backup.progress();
                let total_pages = u64::try_from(snapshot.pagecount.max(0)).unwrap_or_default();
                let remaining_pages = u64::try_from(snapshot.remaining.max(0)).unwrap_or_default();
                update_backup_job_progress(profile_home, operation_id, |progress| {
                    progress.database_total_pages = total_pages;
                    progress.database_copied_pages = total_pages.saturating_sub(remaining_pages);
                    progress.database_busy_retries = database_busy_retries;
                })?;
                last_reported_at = Instant::now();
            }
            match step {
                StepResult::Done => break,
                StepResult::More => std::thread::sleep(ONLINE_BACKUP_STEP_PAUSE),
                StepResult::Busy | StepResult::Locked => {
                    std::thread::sleep(Duration::from_millis(5));
                }
                _ => return Err(internal("SQLite Backup returned an unknown step state")),
            }
        }
    }
    sync_file(&database_path)?;
    update_backup_job_progress(profile_home, operation_id, |progress| {
        progress.database_copy_ms = duration_millis(database_started_at.elapsed());
        progress.database_busy_retries = database_busy_retries;
    })?;

    progress(BackupJobPhase::AssetCopy)?;
    if cancellation_requested()? {
        return Err(backup_cancelled());
    }
    let assets_started_at = Instant::now();
    let assets_directory = staging_directory.join(BACKUP_ASSETS_DIRECTORY_NAME);
    let (assets_bytes, asset_tree_sha256) = if include_assets {
        copy_assets_with_integrity(
            &profile_home.join(BACKUP_ASSETS_DIRECTORY_NAME),
            &assets_directory,
        )?
    } else {
        fs::create_dir(&assets_directory).map_err(io_error)?;
        sync_directory(&assets_directory)?;
        (0, empty_asset_tree_sha256())
    };
    update_backup_job_progress(profile_home, operation_id, |progress| {
        progress.asset_bytes_copied = assets_bytes;
        progress.asset_copy_ms = duration_millis(assets_started_at.elapsed());
    })?;
    drop(asset_snapshot_lease);
    if cancellation_requested()? {
        return Err(backup_cancelled());
    }
    progress(BackupJobPhase::Validation)?;
    let validation_started_at = Instant::now();
    let (store_schema_version, store_epoch) = validate_backup_database(&database_path)?;
    update_backup_job_progress(profile_home, operation_id, |progress| {
        progress.validation_ms = duration_millis(validation_started_at.elapsed());
    })?;
    let staged_store = open_immutable_reader(&database_path)?;
    let required = super::profile_clone::read_clone_executions(&staged_store)?;
    let has_execution = participant.capture(super::ProfileSnapshotCapture {
        source_profile: profile_home,
        staging_profile: staging_directory,
        target_profile: profile_home,
        source: profile_snapshot,
        required: &required,
    })?;
    let execution = staging_directory.join("agent-runtime");
    if has_execution != execution.exists() {
        return Err(corrupt(
            "Profile snapshot participant returned an inconsistent execution closure",
        ));
    }
    let (execution_bytes, execution_tree_sha256) = if has_execution {
        sync_tree(&execution)?;
        let (bytes, digest) = digest_asset_tree(&execution)?;
        (bytes, Some(digest))
    } else {
        (0, None)
    };
    let db_bytes = regular_file_length(&database_path)?;
    if cancellation_requested()? {
        return Err(backup_cancelled());
    }
    progress(BackupJobPhase::Digest)?;
    let digest_started_at = Instant::now();
    let database_sha256 = sha256_regular_file(&database_path)?;
    update_backup_job_progress(profile_home, operation_id, |progress| {
        progress.digest_ms = duration_millis(digest_started_at.elapsed());
    })?;
    let created_at =
        connection.query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", [], |row| {
            row.get::<_, String>(0)
        })?;
    let manifest = BackupManifest {
        version: BACKUP_MANIFEST_VERSION,
        id: backup_id.to_owned(),
        created_at,
        trigger: trigger.to_owned(),
        label: label.map(str::to_owned),
        includes_assets: include_assets,
        db_bytes,
        assets_bytes,
        execution_bytes,
        total_bytes: db_bytes
            .checked_add(assets_bytes)
            .and_then(|bytes| bytes.checked_add(execution_bytes))
            .ok_or_else(|| internal("Backup byte length exceeds the supported range"))?,
        store_schema_version: Some(store_schema_version),
        store_epoch: Some(store_epoch),
        integrity_evidence: Some(BackupIntegrityEvidence {
            version: BACKUP_INTEGRITY_EVIDENCE_VERSION,
            database_sha256,
            asset_tree_sha256,
            execution_tree_sha256,
        }),
        core_operation_id: Some(operation_id.to_owned()),
        core_request_hash: Some(request_hash.to_owned()),
    };
    validate_manifest(&manifest)?;
    if cancellation_requested()? {
        return Err(backup_cancelled());
    }
    progress(BackupJobPhase::Commit)?;
    write_manifest(staging_directory, &manifest)?;
    // The database, manifest, asset files, and nested asset directories were
    // already synced by their writers; persist only the staging entries here.
    sync_directory(staging_directory)?;
    Ok(to_record(&manifest))
}

fn adopt_published_backup(
    directory: &Path,
    operation_id: &str,
    request_hash: &str,
    expected_backup_id: &str,
) -> Result<BackupRecord, StoreError> {
    let manifest = validate_published_backup(directory, expected_backup_id)?;
    if manifest.id != expected_backup_id
        || manifest.core_operation_id.as_deref() != Some(operation_id)
        || manifest.core_request_hash.as_deref() != Some(request_hash)
    {
        return Err(StoreError::new(
            StoreErrorCode::IdempotencyKeyReused,
            "Backup identity is already bound to another Store Administration request",
            false,
        ));
    }
    Ok(to_record(&manifest))
}

pub(super) fn resolve_backup_for_restore(
    profile_home: &Path,
    backup_id: &str,
) -> Result<ValidatedRestoreBackup, StoreError> {
    if !is_safe_backup_id(backup_id) {
        return Err(StoreError::new(
            StoreErrorCode::InvalidInput,
            "Restore backup identity is invalid",
            false,
        ));
    }
    let root = profile_home.join("backups");
    require_directory(&root, "Backup root")?;
    let directory = root.join(backup_id);
    if !directory.exists() {
        return Err(StoreError::new(
            StoreErrorCode::NotFound,
            "Restore backup was not found",
            false,
        ));
    }
    let manifest = validate_published_backup(&directory, backup_id)?;
    Ok(ValidatedRestoreBackup {
        directory,
        manifest,
    })
}

pub(super) fn resolve_backup_for_profile_clone(
    profile_home: &Path,
    backup_id: Option<&str>,
) -> Result<EvidenceBackedProfileClone, StoreError> {
    let selected = match backup_id {
        Some(backup_id) => backup_id.to_owned(),
        None => list_backup_inventory(profile_home)?
            .into_iter()
            .find(|item| {
                item.record.includes_assets && item.record.version == BACKUP_MANIFEST_VERSION
            })
            .map(|item| item.record.backup_id)
            .ok_or_else(|| {
                StoreError::new(
                    StoreErrorCode::NotFound,
                    "Profile has no current evidence-backed backup to clone; create a new backup",
                    false,
                )
            })?,
    };
    validate_evidence_backed_profile_clone(profile_home, &selected)
}

fn validate_evidence_backed_profile_clone(
    profile_home: &Path,
    backup_id: &str,
) -> Result<EvidenceBackedProfileClone, StoreError> {
    if !is_safe_backup_id(backup_id) {
        return Err(StoreError::new(
            StoreErrorCode::InvalidInput,
            "Profile clone backup identity is invalid",
            false,
        ));
    }
    let root = profile_home.join("backups");
    require_directory(&root, "Backup root")?;
    let directory = root.join(backup_id);
    if !directory.exists() {
        return Err(StoreError::new(
            StoreErrorCode::NotFound,
            "Profile clone backup was not found",
            false,
        ));
    }
    require_directory(&directory, "Published backup")?;
    let manifest = read_manifest(&directory)?;
    validate_manifest(&manifest)?;
    if manifest.id != backup_id {
        return Err(corrupt(
            "Published backup manifest identity does not match its directory",
        ));
    }
    if manifest.version != BACKUP_MANIFEST_VERSION || manifest.integrity_evidence.is_none() {
        return Err(StoreError::new(
            StoreErrorCode::UnsupportedSchema,
            "Profile clone requires a current evidence-backed backup; create a new backup",
            false,
        ));
    }
    let database_path = directory.join(BACKUP_DATABASE_FILE_NAME);
    if manifest.db_bytes != regular_file_length(&database_path)? {
        return Err(corrupt(
            "Published backup manifest does not match its database length",
        ));
    }
    let assets_directory = directory.join(BACKUP_ASSETS_DIRECTORY_NAME);
    let asset_bytes = if manifest.includes_assets {
        inspect_assets(&assets_directory)?
    } else {
        0
    };
    if manifest.assets_bytes != asset_bytes
        || manifest.total_bytes
            != manifest
                .db_bytes
                .saturating_add(asset_bytes)
                .saturating_add(manifest.execution_bytes)
    {
        return Err(corrupt("Published backup manifest byte counts are invalid"));
    }
    validate_execution_integrity(&directory, &manifest)?;
    Ok(EvidenceBackedProfileClone {
        directory,
        manifest,
    })
}

pub(super) fn copy_backup_to_profile(
    backup: &EvidenceBackedProfileClone,
    profile_home: &Path,
) -> Result<(), StoreError> {
    require_directory(profile_home, "Profile clone staging root")?;
    let database = profile_home.join(BACKUP_DATABASE_FILE_NAME);
    let database_bytes = clone_or_copy_file(
        &backup.directory.join(BACKUP_DATABASE_FILE_NAME),
        &database,
        CopyDurability::Rebuildable,
    )?;

    let assets = profile_home.join(BACKUP_ASSETS_DIRECTORY_NAME);
    let asset_bytes = if backup.manifest.includes_assets {
        copy_assets(
            &backup.directory.join(BACKUP_ASSETS_DIRECTORY_NAME),
            &assets,
            CopyDurability::Rebuildable,
        )?
    } else {
        fs::create_dir(&assets).map_err(io_error)?;
        0
    };
    let evidence = backup
        .manifest
        .integrity_evidence
        .as_ref()
        .expect("evidence-backed Profile clone has integrity evidence");
    let database_sha256 = sha256_regular_file(&database)?;
    let (digested_asset_bytes, asset_tree_sha256) = digest_asset_tree(&assets)?;
    if backup.manifest.db_bytes != database_bytes
        || backup.manifest.assets_bytes != asset_bytes
        || asset_bytes != digested_asset_bytes
        || evidence.database_sha256 != database_sha256
        || evidence.asset_tree_sha256 != asset_tree_sha256
    {
        return Err(corrupt(
            "Profile clone staging files diverge from published integrity evidence",
        ));
    }
    Ok(())
}

pub(super) fn stage_restore_candidate(
    profile_home: &Path,
    backup: &ValidatedRestoreBackup,
    staging_directory_name: &str,
) -> Result<String, StoreError> {
    validate_restore_staging_name(staging_directory_name)?;
    let root = profile_home.join("backups");
    require_directory(&root, "Backup root")?;
    let staging = root.join(staging_directory_name);
    remove_owned_restore_staging(&root, &staging)?;
    fs::create_dir(&staging).map_err(io_error)?;
    let result = (|| {
        let database = staging.join(BACKUP_DATABASE_FILE_NAME);
        clone_or_copy_file(
            &backup.directory.join(BACKUP_DATABASE_FILE_NAME),
            &database,
            CopyDurability::Durable,
        )?;
        let assets = staging.join(BACKUP_ASSETS_DIRECTORY_NAME);
        if backup.manifest.includes_assets {
            copy_assets(
                &backup.directory.join(BACKUP_ASSETS_DIRECTORY_NAME),
                &assets,
                CopyDurability::Durable,
            )?;
        } else {
            fs::create_dir(&assets).map_err(io_error)?;
            sync_directory(&assets)?;
        }
        if backup
            .manifest
            .integrity_evidence
            .as_ref()
            .is_some_and(|e| e.execution_tree_sha256.is_some())
        {
            copy_assets(
                &backup.directory.join("agent-runtime"),
                &staging.join("agent-runtime"),
                CopyDurability::Durable,
            )?;
            validate_execution_integrity(&staging, &backup.manifest)?;
        }
        let (schema_version, store_epoch) = validate_backup_database(&database)?;
        if backup.manifest.store_schema_version != Some(schema_version)
            || backup.manifest.store_epoch.as_deref() != Some(store_epoch.as_str())
        {
            return Err(corrupt(
                "Restore staging Store diverges from its backup manifest",
            ));
        }
        sync_tree(&staging)?;
        Ok(store_epoch)
    })();
    match result {
        Ok(store_epoch) => {
            sync_directory(&root)?;
            Ok(store_epoch)
        }
        Err(error) => {
            remove_owned_restore_staging(&root, &staging)?;
            Err(error)
        }
    }
}

fn validate_published_backup(
    directory: &Path,
    expected_backup_id: &str,
) -> Result<BackupManifest, StoreError> {
    require_directory(directory, "Published backup")?;
    let manifest = read_manifest(directory)?;
    validate_manifest(&manifest)?;
    if manifest.id != expected_backup_id {
        return Err(corrupt(
            "Published backup manifest identity does not match its directory",
        ));
    }
    let database_path = directory.join(BACKUP_DATABASE_FILE_NAME);
    let (schema_version, store_epoch) = if manifest.integrity_evidence.is_some() {
        (
            manifest
                .store_schema_version
                .expect("evidence-backed backup has a schema version"),
            manifest
                .store_epoch
                .clone()
                .expect("evidence-backed backup has a Store epoch"),
        )
    } else {
        validate_backup_database(&database_path)?
    };
    if manifest.store_schema_version != Some(schema_version)
        || manifest.store_epoch.as_deref() != Some(store_epoch.as_str())
        || manifest.db_bytes != regular_file_length(&database_path)?
    {
        return Err(corrupt(
            "Published backup manifest does not match its database",
        ));
    }
    let assets_directory = directory.join(BACKUP_ASSETS_DIRECTORY_NAME);
    let asset_bytes = if manifest.includes_assets {
        inspect_assets(&assets_directory)?
    } else {
        0
    };
    if manifest.assets_bytes != asset_bytes
        || manifest.total_bytes
            != manifest
                .db_bytes
                .saturating_add(asset_bytes)
                .saturating_add(manifest.execution_bytes)
    {
        return Err(corrupt("Published backup manifest byte counts are invalid"));
    }
    validate_execution_integrity(directory, &manifest)?;
    if let Some(evidence) = &manifest.integrity_evidence {
        let database_sha256 = sha256_regular_file(&database_path)?;
        let (digested_asset_bytes, asset_tree_sha256) = if manifest.includes_assets {
            digest_asset_tree(&assets_directory)?
        } else {
            (0, empty_asset_tree_sha256())
        };
        if digested_asset_bytes != manifest.assets_bytes
            || database_sha256 != evidence.database_sha256
            || asset_tree_sha256 != evidence.asset_tree_sha256
        {
            return Err(corrupt(
                "Published backup diverges from its integrity evidence",
            ));
        }
    }
    Ok(manifest)
}

#[allow(clippy::too_many_arguments)]
fn recover_staging_backup(
    root: &Path,
    staging_directory: &Path,
    operation_id: &str,
    request_hash: &str,
    expected_backup_id: &str,
) -> Result<Option<BackupRecord>, StoreError> {
    if !staging_directory.exists() {
        return Ok(None);
    }
    require_directory(staging_directory, "Staged backup")?;
    let manifest_path = staging_directory.join(BACKUP_MANIFEST_FILE_NAME);
    if !manifest_path.exists() {
        remove_owned_staging_directory(root, staging_directory)?;
        return Ok(None);
    }
    let record = adopt_published_backup(
        staging_directory,
        operation_id,
        request_hash,
        expected_backup_id,
    )?;
    Ok(Some(record))
}

fn read_backup_root(root: &Path) -> Result<Option<Vec<fs::DirEntry>>, StoreError> {
    let metadata = match fs::symlink_metadata(root) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(io_error(error)),
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(invalid_profile(
            "Backup root must be a real directory owned by the Profile",
        ));
    }
    let entries = fs::read_dir(root)
        .map_err(io_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(io_error)?;
    Ok(Some(entries))
}

fn prepare_backup_root(profile_home: &Path) -> Result<PathBuf, StoreError> {
    let root = profile_home.join("backups");
    if read_backup_root(&root)?.is_none() {
        fs::create_dir(&root).map_err(io_error)?;
        sync_directory(profile_home)?;
    }
    require_directory(&root, "Backup root")?;
    Ok(root)
}

#[derive(Clone, Copy)]
enum CopyDurability {
    Durable,
    Rebuildable,
}

fn clone_or_copy_file(
    source: &Path,
    destination: &Path,
    durability: CopyDurability,
) -> Result<u64, StoreError> {
    // With the pinned Rust toolchain, std::fs::copy tries fclonefileat first on
    // macOS and falls back to fcopyfile when CoW is unavailable or cross-volume.
    let bytes = fs::copy(source, destination).map_err(io_error)?;
    if matches!(durability, CopyDurability::Durable) {
        sync_file(destination)?;
    }
    Ok(bytes)
}

fn copy_assets(
    source: &Path,
    destination: &Path,
    durability: CopyDurability,
) -> Result<u64, StoreError> {
    let metadata = match fs::symlink_metadata(source) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(destination).map_err(io_error)?;
            if matches!(durability, CopyDurability::Durable) {
                sync_directory(destination)?;
            }
            return Ok(0);
        }
        Err(error) => return Err(io_error(error)),
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(invalid_profile(
            "Managed assets root must be a real directory",
        ));
    }
    fs::create_dir(destination).map_err(io_error)?;
    let bytes = copy_directory(source, destination, durability)?;
    if matches!(durability, CopyDurability::Durable) {
        sync_directory(destination)?;
    }
    Ok(bytes)
}

/// Copies the managed asset tree and derives its integrity evidence from the
/// same source reads. Backup creation therefore never walks and rereads every
/// copied asset merely to publish its manifest.
fn copy_assets_with_integrity(
    source: &Path,
    destination: &Path,
) -> Result<(u64, String), StoreError> {
    let metadata = match fs::symlink_metadata(source) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(destination).map_err(io_error)?;
            sync_directory(destination)?;
            return Ok((0, empty_asset_tree_sha256()));
        }
        Err(error) => return Err(io_error(error)),
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(invalid_profile(
            "Managed assets root must be a real directory",
        ));
    }
    fs::create_dir(destination).map_err(io_error)?;
    let mut hasher = Sha256::new();
    hasher.update(ASSET_TREE_DIGEST_DOMAIN);
    let mut inspected = 0usize;
    let mut buffer = vec![0u8; DIGEST_BUFFER_BYTES];
    let bytes = copy_and_digest_asset_directory(
        source,
        source,
        destination,
        &mut hasher,
        &mut inspected,
        &mut buffer,
    )?;
    sync_directory(destination)?;
    Ok((bytes, hex(&hasher.finalize())))
}

fn copy_and_digest_asset_directory(
    root: &Path,
    source: &Path,
    destination: &Path,
    hasher: &mut Sha256,
    inspected: &mut usize,
    buffer: &mut [u8],
) -> Result<u64, StoreError> {
    let mut entries = fs::read_dir(source)
        .map_err(io_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(io_error)?;
    entries.sort_by_key(fs::DirEntry::file_name);
    let mut total = 0u64;
    for entry in entries {
        *inspected = inspected
            .checked_add(1)
            .ok_or_else(|| corrupt("Managed asset tree exceeds its entry bound"))?;
        if *inspected > MAX_BACKUP_TREE_ENTRIES {
            return Err(corrupt("Managed asset tree exceeds its entry bound"));
        }
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        let metadata = fs::symlink_metadata(&source_path).map_err(io_error)?;
        if metadata.file_type().is_symlink() {
            return Err(invalid_profile(
                "Managed assets must not contain symbolic links",
            ));
        }
        let relative = source_path
            .strip_prefix(root)
            .map_err(|_| internal("Managed asset escaped its copy root"))?;
        let relative_bytes = relative.as_os_str().as_bytes();
        let relative_length = u64::try_from(relative_bytes.len())
            .map_err(|_| internal("Managed asset path exceeds its digest bound"))?;
        if metadata.is_dir() {
            hasher.update(b"d");
            hasher.update(relative_length.to_be_bytes());
            hasher.update(relative_bytes);
            fs::create_dir(&destination_path).map_err(io_error)?;
            total = total
                .checked_add(copy_and_digest_asset_directory(
                    root,
                    &source_path,
                    &destination_path,
                    hasher,
                    inspected,
                    buffer,
                )?)
                .ok_or_else(|| corrupt("Managed asset byte length exceeds its bound"))?;
            sync_directory(&destination_path)?;
            continue;
        }
        if !metadata.is_file() {
            return Err(invalid_profile(
                "Managed assets may contain only regular files and directories",
            ));
        }
        hasher.update(b"f");
        hasher.update(relative_length.to_be_bytes());
        hasher.update(relative_bytes);
        hasher.update(metadata.len().to_be_bytes());
        let mut input = File::open(&source_path).map_err(io_error)?;
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&destination_path)
            .map_err(io_error)?;
        let mut file_bytes = 0u64;
        loop {
            let count = input.read(buffer).map_err(io_error)?;
            if count == 0 {
                break;
            }
            output.write_all(&buffer[..count]).map_err(io_error)?;
            hasher.update(&buffer[..count]);
            file_bytes = file_bytes
                .checked_add(u64::try_from(count).map_err(|_| internal("Asset read is too large"))?)
                .ok_or_else(|| corrupt("Managed asset byte length exceeds its bound"))?;
        }
        if file_bytes != metadata.len()
            || fs::symlink_metadata(&source_path).map_err(io_error)?.len() != metadata.len()
        {
            return Err(corrupt("Managed asset changed while it was copied"));
        }
        output.sync_all().map_err(io_error)?;
        total = total
            .checked_add(file_bytes)
            .ok_or_else(|| corrupt("Managed asset byte length exceeds its bound"))?;
    }
    Ok(total)
}

fn copy_directory(
    source: &Path,
    destination: &Path,
    durability: CopyDurability,
) -> Result<u64, StoreError> {
    let mut entries = fs::read_dir(source)
        .map_err(io_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(io_error)?;
    entries.sort_by_key(fs::DirEntry::file_name);
    let mut total = 0u64;
    for entry in entries {
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        let metadata = fs::symlink_metadata(&source_path).map_err(io_error)?;
        if metadata.file_type().is_symlink() {
            return Err(invalid_profile(
                "Managed assets must not contain symbolic links",
            ));
        }
        if metadata.is_dir() {
            fs::create_dir(&destination_path).map_err(io_error)?;
            total = total
                .checked_add(copy_directory(&source_path, &destination_path, durability)?)
                .ok_or_else(|| internal("Managed asset byte length exceeds its bound"))?;
            if matches!(durability, CopyDurability::Durable) {
                sync_directory(&destination_path)?;
            }
            continue;
        }
        if !metadata.is_file() {
            return Err(invalid_profile(
                "Managed assets may contain only regular files and directories",
            ));
        }
        clone_or_copy_file(&source_path, &destination_path, durability)?;
        total = total
            .checked_add(metadata.len())
            .ok_or_else(|| internal("Managed asset byte length exceeds its bound"))?;
    }
    Ok(total)
}

fn inspect_assets(root: &Path) -> Result<u64, StoreError> {
    require_directory(root, "Backup assets")?;
    inspect_directory(root)
}

fn inspect_source_directory(root: &Path) -> Result<u64, StoreError> {
    let mut total = 0_u64;
    for entry in fs::read_dir(root).map_err(io_error)? {
        let entry = entry.map_err(io_error)?;
        let metadata = fs::symlink_metadata(entry.path()).map_err(io_error)?;
        if metadata.file_type().is_symlink() {
            return Err(invalid_profile(
                "Managed assets must not contain symbolic links",
            ));
        }
        let length = if metadata.is_dir() {
            inspect_source_directory(&entry.path())?
        } else if metadata.is_file() {
            metadata.len()
        } else {
            return Err(invalid_profile(
                "Managed assets may contain only regular files and directories",
            ));
        };
        total = total
            .checked_add(length)
            .ok_or_else(|| invalid_profile("Managed asset byte length exceeds its bound"))?;
    }
    Ok(total)
}

fn inspect_optional_assets(root: &Path) -> Result<u64, StoreError> {
    let metadata = match fs::symlink_metadata(root) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(io_error(error)),
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(invalid_profile(
            "Managed assets root must be a real directory",
        ));
    }
    inspect_source_directory(root)
}

fn sha256_regular_file(path: &Path) -> Result<String, StoreError> {
    let metadata = fs::symlink_metadata(path).map_err(io_error)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(corrupt("Backup integrity evidence requires a regular file"));
    }
    let mut file = File::open(path).map_err(io_error)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; DIGEST_BUFFER_BYTES];
    let mut bytes_read = 0_u64;
    loop {
        let count = file.read(&mut buffer).map_err(io_error)?;
        if count == 0 {
            break;
        }
        bytes_read = bytes_read
            .checked_add(u64::try_from(count).map_err(|_| internal("Digest read is too large"))?)
            .ok_or_else(|| internal("Digest byte length exceeds its bound"))?;
        hasher.update(&buffer[..count]);
    }
    if bytes_read != metadata.len() {
        return Err(corrupt(
            "Backup file changed while integrity evidence was computed",
        ));
    }
    Ok(hex(&hasher.finalize()))
}

fn empty_asset_tree_sha256() -> String {
    hex(&Sha256::digest(ASSET_TREE_DIGEST_DOMAIN))
}

fn digest_asset_tree(root: &Path) -> Result<(u64, String), StoreError> {
    require_directory(root, "Backup assets")?;
    let mut hasher = Sha256::new();
    hasher.update(ASSET_TREE_DIGEST_DOMAIN);
    let mut inspected = 0_usize;
    let mut buffer = vec![0_u8; DIGEST_BUFFER_BYTES];
    let bytes = digest_asset_directory(root, root, &mut hasher, &mut inspected, &mut buffer)?;
    Ok((bytes, hex(&hasher.finalize())))
}

fn digest_asset_directory(
    root: &Path,
    directory: &Path,
    hasher: &mut Sha256,
    inspected: &mut usize,
    buffer: &mut [u8],
) -> Result<u64, StoreError> {
    let mut entries = fs::read_dir(directory)
        .map_err(io_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(io_error)?;
    entries.sort_by_key(fs::DirEntry::file_name);
    let mut total = 0_u64;
    for entry in entries {
        *inspected = inspected
            .checked_add(1)
            .ok_or_else(|| corrupt("Backup asset tree exceeds its entry bound"))?;
        if *inspected > MAX_BACKUP_TREE_ENTRIES {
            return Err(corrupt("Backup asset tree exceeds its entry bound"));
        }
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path).map_err(io_error)?;
        if metadata.file_type().is_symlink() {
            return Err(corrupt("Backup assets contain a symbolic link"));
        }
        let relative = path
            .strip_prefix(root)
            .map_err(|_| internal("Backup asset escaped its digest root"))?;
        let relative_bytes = relative.as_os_str().as_bytes();
        let relative_length = u64::try_from(relative_bytes.len())
            .map_err(|_| internal("Backup asset path exceeds its digest bound"))?;
        if metadata.is_dir() {
            hasher.update(b"d");
            hasher.update(relative_length.to_be_bytes());
            hasher.update(relative_bytes);
            total = total
                .checked_add(digest_asset_directory(
                    root, &path, hasher, inspected, buffer,
                )?)
                .ok_or_else(|| corrupt("Backup asset byte length exceeds its bound"))?;
            continue;
        }
        if !metadata.is_file() {
            return Err(corrupt("Backup assets contain a non-file filesystem entry"));
        }
        hasher.update(b"f");
        hasher.update(relative_length.to_be_bytes());
        hasher.update(relative_bytes);
        hasher.update(metadata.len().to_be_bytes());
        let mut file = File::open(&path).map_err(io_error)?;
        let mut file_bytes = 0_u64;
        loop {
            let count = file.read(buffer).map_err(io_error)?;
            if count == 0 {
                break;
            }
            file_bytes = file_bytes
                .checked_add(
                    u64::try_from(count).map_err(|_| internal("Digest read is too large"))?,
                )
                .ok_or_else(|| corrupt("Backup asset byte length exceeds its bound"))?;
            hasher.update(&buffer[..count]);
        }
        if file_bytes != metadata.len() {
            return Err(corrupt(
                "Backup asset changed while integrity evidence was computed",
            ));
        }
        total = total
            .checked_add(file_bytes)
            .ok_or_else(|| corrupt("Backup asset byte length exceeds its bound"))?;
    }
    Ok(total)
}

fn inspect_directory(root: &Path) -> Result<u64, StoreError> {
    let mut total = 0u64;
    for entry in fs::read_dir(root).map_err(io_error)? {
        let entry = entry.map_err(io_error)?;
        let metadata = fs::symlink_metadata(entry.path()).map_err(io_error)?;
        if metadata.file_type().is_symlink() {
            return Err(corrupt("Backup assets contain a symbolic link"));
        }
        let length = if metadata.is_dir() {
            inspect_directory(&entry.path())?
        } else if metadata.is_file() {
            metadata.len()
        } else {
            return Err(corrupt("Backup assets contain a non-file filesystem entry"));
        };
        total = total
            .checked_add(length)
            .ok_or_else(|| corrupt("Backup asset byte length exceeds its bound"))?;
    }
    Ok(total)
}

fn inspect_removable_tree(root: &Path, inspected: &mut usize) -> Result<(), StoreError> {
    for entry in fs::read_dir(root).map_err(io_error)? {
        let entry = entry.map_err(io_error)?;
        *inspected = inspected
            .checked_add(1)
            .ok_or_else(|| corrupt("Backup deletion tree exceeds its entry bound"))?;
        if *inspected > MAX_BACKUP_TREE_ENTRIES {
            return Err(corrupt("Backup deletion tree exceeds its entry bound"));
        }
        let metadata = fs::symlink_metadata(entry.path()).map_err(io_error)?;
        if metadata.file_type().is_symlink() {
            return Err(invalid_profile(
                "Backup deletion tree must not contain symbolic links",
            ));
        }
        if metadata.is_dir() {
            inspect_removable_tree(&entry.path(), inspected)?;
            continue;
        }
        if !metadata.is_file() {
            return Err(invalid_profile(
                "Backup deletion tree contains an unsupported entry",
            ));
        }
    }
    Ok(())
}

fn validate_backup_database(path: &Path) -> Result<(u32, String), StoreError> {
    let result = (|| {
        let connection = open_immutable_reader(path)?;
        validate_current_store(&connection)?;
        validate_restore_documents(&connection)?;
        let schema_version =
            connection.query_row("PRAGMA user_version", [], |row| row.get::<_, u32>(0))?;
        if schema_version != u32::try_from(CURRENT_STORE_REVISION).expect("schema version fits u32")
        {
            return Err(StoreError::new(
                StoreErrorCode::UnsupportedSchema,
                format!("Backup uses unsupported store schema v{schema_version}"),
                false,
            ));
        }
        let metadata = connection
            .query_row(
                "SELECT metadata.schema_owner, block.store_epoch \
                 FROM core_store_metadata metadata \
                 JOIN block_store_metadata block ON block.id = metadata.id \
                 WHERE metadata.id = 1",
                [],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;
        let Some((owner, store_epoch)) = metadata else {
            return Err(corrupt("Backup is missing Rust Core store metadata"));
        };
        if owner != "rust_core" || store_epoch.is_empty() {
            return Err(corrupt("Backup Rust Core metadata is invalid"));
        }
        Ok((schema_version, store_epoch))
    })();
    result.map_err(|error| match error.code {
        StoreErrorCode::InvalidProfile | StoreErrorCode::SqliteFailure => corrupt(format!(
            "Backup SQLite validation failed: {}",
            error.message
        )),
        _ => error,
    })
}

fn trigger_name(trigger: BackupTrigger) -> &'static str {
    match trigger {
        BackupTrigger::Manual => "manual",
        BackupTrigger::Auto => "auto",
        BackupTrigger::PreRestore => "pre-restore",
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) fn begin_backup_job(
    profile_home: &Path,
    profile_id: &str,
    operation_id: &str,
    request_hash: &str,
    label: Option<&str>,
    include_assets: bool,
    trigger: &str,
    backup_id: &str,
) -> Result<(), StoreError> {
    if let Some(mut existing) = read_backup_job(profile_home, operation_id)? {
        if existing.request_hash != request_hash
            || existing.profile_id != profile_id
            || existing.label.as_deref() != label
            || existing.include_assets != include_assets
            || existing.trigger != trigger
            || existing.backup_id != backup_id
        {
            return Err(StoreError::new(
                StoreErrorCode::IdempotencyKeyReused,
                "Backup job identity is already bound to another request",
                false,
            ));
        }
        if matches!(
            existing.state,
            BackupJobState::Cancelling | BackupJobState::Cancelled
        ) {
            return Err(backup_cancelled());
        }
        if existing.state != BackupJobState::Ready {
            existing.state = BackupJobState::Running;
            existing.phase = BackupJobPhase::Preparing;
            existing.updated_at_ms = current_time_millis()?;
            existing.error = None;
            write_backup_job(profile_home, &existing)?;
        }
        return Ok(());
    }
    let now = current_time_millis()?;
    write_backup_job(
        profile_home,
        &BackupJobJournal {
            version: BACKUP_JOB_VERSION,
            job_id: operation_id.to_owned(),
            operation_id: operation_id.to_owned(),
            request_hash: request_hash.to_owned(),
            profile_id: profile_id.to_owned(),
            state: BackupJobState::Running,
            phase: BackupJobPhase::Preparing,
            started_at_ms: now,
            updated_at_ms: now,
            label: label.map(str::to_owned),
            include_assets,
            trigger: trigger.to_owned(),
            backup_id: backup_id.to_owned(),
            error: None,
            progress: BackupJobProgress::default(),
        },
    )
}

fn current_time_millis() -> Result<i64, StoreError> {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| internal("System clock is before the Unix epoch"))?
        .as_millis();
    i64::try_from(millis).map_err(|_| internal("System clock exceeds the supported range"))
}

fn backup_job_path(profile_home: &Path, operation_id: &str) -> PathBuf {
    let digest = Sha256::digest(operation_id.as_bytes());
    profile_home
        .join("backups")
        .join(BACKUP_CONTROL_DIRECTORY_NAME)
        .join(BACKUP_JOB_DIRECTORY_NAME)
        .join(format!("{}.json", hex(&digest)))
}

fn prepare_backup_job_directory(profile_home: &Path) -> Result<PathBuf, StoreError> {
    let root = prepare_backup_root(profile_home)?;
    let control = root.join(BACKUP_CONTROL_DIRECTORY_NAME);
    if !control.exists() {
        fs::create_dir(&control).map_err(io_error)?;
        sync_directory(&root)?;
    }
    require_directory(&control, "Backup control root")?;
    let jobs = control.join(BACKUP_JOB_DIRECTORY_NAME);
    if !jobs.exists() {
        fs::create_dir(&jobs).map_err(io_error)?;
        sync_directory(&control)?;
    }
    require_directory(&jobs, "Backup job control root")?;
    Ok(jobs)
}

fn read_backup_job(
    profile_home: &Path,
    operation_id: &str,
) -> Result<Option<BackupJobJournal>, StoreError> {
    let path = backup_job_path(profile_home, operation_id);
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(io_error(error)),
    };
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() > MAX_BACKUP_JOB_BYTES
    {
        return Err(corrupt("Backup job journal is not a bounded regular file"));
    }
    let journal: BackupJobJournal = serde_json::from_slice(&fs::read(path).map_err(io_error)?)
        .map_err(|_| corrupt("Backup job journal JSON is invalid"))?;
    validate_backup_job(&journal)?;
    if journal.operation_id != operation_id {
        return Err(corrupt("Backup job journal identity is invalid"));
    }
    Ok(Some(journal))
}

fn write_backup_job(profile_home: &Path, journal: &BackupJobJournal) -> Result<(), StoreError> {
    validate_backup_job(journal)?;
    let jobs = prepare_backup_job_directory(profile_home)?;
    prune_terminal_backup_jobs(&jobs, Some(&journal.operation_id))?;
    let mut bytes = serde_json::to_vec_pretty(journal)
        .map_err(|_| internal("Backup job journal could not be encoded"))?;
    bytes.push(b'\n');
    if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > MAX_BACKUP_JOB_BYTES {
        return Err(internal("Backup job journal exceeds its size bound"));
    }
    let digest = hex(&Sha256::digest(journal.operation_id.as_bytes()));
    let path = jobs.join(format!("{digest}.json"));
    let temporary = jobs.join(format!(".{digest}.tmp"));
    if let Ok(metadata) = fs::symlink_metadata(&temporary) {
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(invalid_profile(
                "Backup job temporary journal is not an owned regular file",
            ));
        }
        fs::remove_file(&temporary).map_err(io_error)?;
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(io_error)?;
    file.write_all(&bytes).map_err(io_error)?;
    file.sync_all().map_err(io_error)?;
    fs::rename(&temporary, &path).map_err(io_error)?;
    sync_directory(&jobs)
}

fn prune_terminal_backup_jobs(
    jobs: &Path,
    replacing_operation_id: Option<&str>,
) -> Result<(), StoreError> {
    let replacing_path = replacing_operation_id.map(|operation_id| {
        let digest = hex(&Sha256::digest(operation_id.as_bytes()));
        jobs.join(format!("{digest}.json"))
    });
    let mut entries = fs::read_dir(jobs)
        .map_err(io_error)?
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.ends_with(".json") && !name.starts_with('.'))
        })
        .collect::<Vec<_>>();
    if replacing_path
        .as_ref()
        .is_some_and(|path| entries.iter().any(|entry| entry.path() == *path))
        || entries.len() < MAX_BACKUP_JOBS
    {
        return Ok(());
    }
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let bytes = fs::read(entry.path()).map_err(io_error)?;
        let journal: BackupJobJournal = serde_json::from_slice(&bytes)
            .map_err(|_| corrupt("Backup job journal JSON is invalid"))?;
        validate_backup_job(&journal)?;
        if matches!(
            journal.state,
            BackupJobState::Cancelled | BackupJobState::Ready | BackupJobState::Failed
        ) {
            fs::remove_file(entry.path()).map_err(io_error)?;
            sync_directory(jobs)?;
            return Ok(());
        }
    }
    Err(StoreError::new(
        StoreErrorCode::ResourceExhausted,
        "Backup job journal has too many active operations",
        false,
    ))
}

fn validate_backup_job(journal: &BackupJobJournal) -> Result<(), StoreError> {
    if journal.version != BACKUP_JOB_VERSION
        || journal.job_id != journal.operation_id
        || journal.operation_id.is_empty()
        || journal.operation_id.len() > 512
        || !is_sha256(&journal.request_hash)
        || journal.profile_id.is_empty()
        || journal.started_at_ms < 0
        || journal.updated_at_ms < journal.started_at_ms
        || !matches!(journal.trigger.as_str(), "manual" | "auto" | "pre-restore")
        || !is_safe_backup_id(&journal.backup_id)
        || journal
            .label
            .as_ref()
            .is_some_and(|label| label.chars().count() > 512)
        || (journal.state == BackupJobState::Failed && journal.error.is_none())
        || (journal.state != BackupJobState::Failed && journal.error.is_some())
    {
        return Err(corrupt("Backup job journal fields are invalid"));
    }
    Ok(())
}

fn to_job_record(journal: BackupJobJournal) -> Result<BackupJobRecord, StoreError> {
    let trigger = match journal.trigger.as_str() {
        "manual" => BackupTrigger::Manual,
        "auto" => BackupTrigger::Auto,
        "pre-restore" => BackupTrigger::PreRestore,
        _ => return Err(corrupt("Backup job trigger is invalid")),
    };
    let (completed_units, total_units) = backup_phase_units(journal.phase);
    Ok(BackupJobRecord {
        job_id: journal.job_id,
        operation_id: journal.operation_id,
        state: journal.state,
        phase: journal.phase,
        completed_units,
        total_units,
        started_at_ms: journal.started_at_ms,
        updated_at_ms: journal.updated_at_ms,
        label: journal.label,
        include_assets: journal.include_assets,
        trigger,
        backup_id: journal.backup_id,
        error: journal.error,
        progress: journal.progress,
    })
}

fn backup_phase_units(phase: BackupJobPhase) -> (u64, u64) {
    let completed = match phase {
        BackupJobPhase::Queued
        | BackupJobPhase::Preparing
        | BackupJobPhase::CancellationRequested
        | BackupJobPhase::Cancelled
        | BackupJobPhase::Failed => 0,
        BackupJobPhase::DatabaseSnapshot => 1,
        BackupJobPhase::AssetCopy => 2,
        BackupJobPhase::Validation => 3,
        BackupJobPhase::Digest => 4,
        BackupJobPhase::Commit => 5,
        BackupJobPhase::Publishing => 6,
        BackupJobPhase::Ready => 7,
    };
    (completed, 7)
}

fn duration_millis(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

fn write_manifest(directory: &Path, manifest: &BackupManifest) -> Result<(), StoreError> {
    let mut bytes = serde_json::to_vec_pretty(manifest)
        .map_err(|_| internal("Backup manifest could not be encoded"))?;
    bytes.push(b'\n');
    if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > MAX_MANIFEST_BYTES {
        return Err(internal("Backup manifest exceeds its size bound"));
    }
    let path = directory.join(BACKUP_MANIFEST_FILE_NAME);
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(io_error)?;
    file.write_all(&bytes).map_err(io_error)?;
    file.sync_all().map_err(io_error)
}

fn read_manifest(directory: &Path) -> Result<BackupManifest, StoreError> {
    let path = directory.join(BACKUP_MANIFEST_FILE_NAME);
    let metadata = fs::symlink_metadata(&path).map_err(io_error)?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() > MAX_MANIFEST_BYTES
    {
        return Err(corrupt("Backup manifest is not a bounded regular file"));
    }
    let bytes = fs::read(path).map_err(io_error)?;
    serde_json::from_slice(&bytes).map_err(|_| corrupt("Backup manifest JSON is invalid"))
}

fn validate_execution_integrity(
    directory: &Path,
    manifest: &BackupManifest,
) -> Result<(), StoreError> {
    let execution = directory.join("agent-runtime");
    let expected = manifest
        .integrity_evidence
        .as_ref()
        .and_then(|e| e.execution_tree_sha256.as_ref());
    let Some(expected) = expected else {
        if execution.exists() || manifest.execution_bytes != 0 {
            return Err(corrupt(
                "Backup has execution files outside its integrity evidence",
            ));
        }
        return Ok(());
    };
    let (bytes, digest) = digest_asset_tree(&execution)?;
    if bytes != manifest.execution_bytes || digest != *expected {
        return Err(corrupt(
            "Backup execution history diverges from its integrity evidence",
        ));
    }
    Ok(())
}

fn validate_manifest(manifest: &BackupManifest) -> Result<(), StoreError> {
    let valid_integrity_evidence = match (&manifest.integrity_evidence, manifest.version) {
        (None, 1 | 2) => true,
        (Some(evidence), 3 | BACKUP_MANIFEST_VERSION) => {
            evidence.version == BACKUP_INTEGRITY_EVIDENCE_VERSION
                && is_sha256(&evidence.database_sha256)
                && is_sha256(&evidence.asset_tree_sha256)
                && evidence
                    .execution_tree_sha256
                    .as_ref()
                    .is_none_or(|value| is_sha256(value))
                && (manifest.execution_bytes == 0 || evidence.execution_tree_sha256.is_some())
                && (manifest.includes_assets
                    || evidence.asset_tree_sha256 == empty_asset_tree_sha256())
        }
        _ => false,
    };
    if manifest.version == 0
        || manifest.version > BACKUP_MANIFEST_VERSION
        || !valid_integrity_evidence
        || !is_safe_backup_id(&manifest.id)
        || chrono::DateTime::parse_from_rfc3339(&manifest.created_at).is_err()
        || !matches!(manifest.trigger.as_str(), "manual" | "auto" | "pre-restore")
        || manifest
            .label
            .as_ref()
            .is_some_and(|label| label.len() > 4_096)
        || manifest
            .core_operation_id
            .as_ref()
            .is_some_and(|operation_id| operation_id.is_empty() || operation_id.len() > 512)
        || manifest
            .core_request_hash
            .as_ref()
            .is_some_and(|request_hash| !is_sha256(request_hash))
        || (manifest.version == BACKUP_MANIFEST_VERSION
            && (manifest.store_schema_version.is_none()
                || manifest.store_epoch.as_ref().is_none_or(String::is_empty)))
    {
        return Err(corrupt("Backup manifest fields are invalid"));
    }
    Ok(())
}

fn to_record(manifest: &BackupManifest) -> BackupRecord {
    let trigger = match manifest.trigger.as_str() {
        "auto" => BackupTrigger::Auto,
        "pre-restore" => BackupTrigger::PreRestore,
        _ => BackupTrigger::Manual,
    };
    BackupRecord {
        version: manifest.version,
        backup_id: manifest.id.clone(),
        trigger,
        label: manifest.label.clone(),
        created_at: manifest.created_at.clone(),
        includes_assets: manifest.includes_assets,
        db_bytes: manifest.db_bytes,
        assets_bytes: manifest.assets_bytes,
        execution_bytes: manifest.execution_bytes,
        total_bytes: manifest.total_bytes,
        byte_length: manifest.total_bytes,
    }
}

pub(super) fn backup_id(profile_id: &str, operation_id: &str) -> String {
    let digest = Sha256::digest(format!(
        "store-administration\0{profile_id}\0{operation_id}"
    ));
    format!("core-{}", hex(&digest))
}

fn manifest_version() -> u32 {
    BACKUP_MANIFEST_VERSION
}

pub(super) fn is_safe_backup_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn regular_file_length(path: &Path) -> Result<u64, StoreError> {
    let metadata = fs::symlink_metadata(path).map_err(io_error)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(corrupt("Backup database is not a regular file"));
    }
    Ok(metadata.len())
}

fn require_directory(path: &Path, label: &str) -> Result<(), StoreError> {
    let metadata = fs::symlink_metadata(path).map_err(io_error)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(invalid_profile(format!("{label} must be a real directory")));
    }
    Ok(())
}

fn remove_owned_staging_directory(root: &Path, staging: &Path) -> Result<(), StoreError> {
    if staging.parent() != Some(root)
        || !staging
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with(".core-") && name.ends_with(".tmp"))
    {
        return Err(invalid_profile(
            "Backup staging path is outside its owner root",
        ));
    }
    let metadata = match fs::symlink_metadata(staging) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(io_error(error)),
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(invalid_profile(
            "Backup staging path is not an owned directory",
        ));
    }
    fs::remove_dir_all(staging).map_err(io_error)?;
    sync_directory(root)
}

fn validate_restore_staging_name(name: &str) -> Result<(), StoreError> {
    if name.starts_with(".restore-")
        && name.len() > ".restore-".len()
        && name.len() <= 160
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'.')
    {
        return Ok(());
    }
    Err(invalid_profile(
        "Restore staging directory identity is invalid",
    ))
}

fn remove_owned_restore_staging(root: &Path, staging: &Path) -> Result<(), StoreError> {
    if staging.parent() != Some(root) {
        return Err(invalid_profile(
            "Restore staging path is outside its owner root",
        ));
    }
    let name = staging
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| invalid_profile("Restore staging identity is invalid"))?;
    validate_restore_staging_name(name)?;
    let metadata = match fs::symlink_metadata(staging) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(io_error(error)),
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(invalid_profile(
            "Restore staging path is not an owned directory",
        ));
    }
    fs::remove_dir_all(staging).map_err(io_error)?;
    sync_directory(root)
}

fn sync_tree(root: &Path) -> Result<(), StoreError> {
    for entry in fs::read_dir(root).map_err(io_error)? {
        let entry = entry.map_err(io_error)?;
        let metadata = fs::symlink_metadata(entry.path()).map_err(io_error)?;
        if metadata.file_type().is_symlink() {
            return Err(invalid_profile(
                "Backup staging tree must not contain symbolic links",
            ));
        }
        if metadata.is_dir() {
            sync_tree(&entry.path())?;
        } else if metadata.is_file() {
            sync_file(&entry.path())?;
        } else {
            return Err(invalid_profile(
                "Backup staging tree contains an unsupported entry",
            ));
        }
    }
    sync_directory(root)
}

fn sync_file(path: &Path) -> Result<(), StoreError> {
    File::open(path)
        .map_err(io_error)?
        .sync_all()
        .map_err(io_error)
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

fn backup_cancelled() -> StoreError {
    StoreError::new(
        StoreErrorCode::QueryCancelled,
        "Snapshot creation was cancelled before publication",
        false,
    )
}

fn io_error(error: std::io::Error) -> StoreError {
    StoreError::new(
        StoreErrorCode::Internal,
        format!("Backup filesystem operation failed: {error}"),
        false,
    )
}
