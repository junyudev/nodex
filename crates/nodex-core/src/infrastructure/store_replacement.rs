use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};

use super::schema::CURRENT_STORE_REVISION;
use super::sqlite::{StoreError, StoreErrorCode, open_writer, validate_store};
use super::store::STORE_FILE_NAME;
use super::store_validation::{
    validate_codex_thread_timestamp_invariants, validate_database_priority_invariants,
};

const JOURNAL_FILE_NAME: &str = ".core-store-restore-journal.json";
const JOURNAL_VERSION: u32 = 1;
const MAX_JOURNAL_BYTES: u64 = 64 * 1024;
const PRIVATE_FILE_MODE: u32 = 0o600;
const MAX_STAGED_ASSET_ENTRIES: usize = 100_000;
const ASSETS_DIRECTORY_NAME: &str = "assets";
const WAL_SUFFIX: &str = "-wal";
const SHM_SUFFIX: &str = "-shm";

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StoreReplacementPhase {
    Prepared,
    RollbackStarted,
    InstallStarted,
    EpochRotating,
    Committed,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreReplacementJournal {
    pub version: u32,
    pub operation_id: String,
    pub request_hash: String,
    pub backup_id: String,
    pub safety_backup_id: Option<String>,
    pub staging_directory_name: String,
    pub rollback_directory_name: String,
    pub phase: StoreReplacementPhase,
    pub had_assets: bool,
    pub had_wal: bool,
    pub had_shm: bool,
    pub source_store_epoch: String,
    pub installed_store_epoch: Option<String>,
    pub updated_at: String,
}

pub struct NewStoreReplacementJournal<'a> {
    pub operation_id: &'a str,
    pub request_hash: &'a str,
    pub backup_id: &'a str,
    pub staging_directory_name: &'a str,
    pub rollback_directory_name: &'a str,
    pub source_store_epoch: &'a str,
    pub updated_at: &'a str,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StoreReplacementStartupRecovery {
    None,
    Prepared,
    RolledBack,
    CommittedPendingReceipt,
    CommittedCleaned,
}

pub fn read_store_replacement_journal(
    profile_home: &Path,
) -> Result<Option<StoreReplacementJournal>, StoreError> {
    let path = journal_path(profile_home);
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(io_error(error)),
    };
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() > MAX_JOURNAL_BYTES
        || metadata.permissions().mode() & 0o077 != 0
    {
        return Err(invalid_profile(
            "Store replacement journal must be a bounded regular file",
        ));
    }
    let bytes = fs::read(path).map_err(io_error)?;
    let journal = serde_json::from_slice::<StoreReplacementJournal>(&bytes)
        .map_err(|_| corrupt("Store replacement journal JSON is invalid"))?;
    validate_journal(profile_home, &journal)?;
    Ok(Some(journal))
}

pub fn create_store_replacement_journal(
    profile_home: &Path,
    input: NewStoreReplacementJournal<'_>,
) -> Result<StoreReplacementJournal, StoreError> {
    if read_store_replacement_journal(profile_home)?.is_some() {
        return Err(StoreError::new(
            StoreErrorCode::MaintenanceInProgress,
            "An interrupted Store replacement must be reconciled first",
            true,
        ));
    }
    validate_owned_directory_name(input.staging_directory_name, ".restore-")?;
    validate_owned_directory_name(input.rollback_directory_name, ".rollback-")?;
    validate_live_store(profile_home, Some(input.source_store_epoch))?;
    validate_staged_candidate(profile_home, input.staging_directory_name)?;
    let database_path = live_database_path(profile_home);
    let journal = StoreReplacementJournal {
        version: JOURNAL_VERSION,
        operation_id: input.operation_id.to_owned(),
        request_hash: input.request_hash.to_owned(),
        backup_id: input.backup_id.to_owned(),
        safety_backup_id: None,
        staging_directory_name: input.staging_directory_name.to_owned(),
        rollback_directory_name: input.rollback_directory_name.to_owned(),
        phase: StoreReplacementPhase::Prepared,
        had_assets: directory_exists(&profile_home.join(ASSETS_DIRECTORY_NAME))?,
        had_wal: regular_file_exists(&append_suffix(&database_path, WAL_SUFFIX))?,
        had_shm: regular_file_exists(&append_suffix(&database_path, SHM_SUFFIX))?,
        source_store_epoch: input.source_store_epoch.to_owned(),
        installed_store_epoch: None,
        updated_at: input.updated_at.to_owned(),
    };
    validate_journal(profile_home, &journal)?;
    write_journal(profile_home, &journal)?;
    Ok(journal)
}

pub fn advance_store_replacement_journal(
    profile_home: &Path,
    journal: &StoreReplacementJournal,
    phase: StoreReplacementPhase,
    updated_at: &str,
    safety_backup_id: Option<&str>,
    installed_store_epoch: Option<&str>,
) -> Result<StoreReplacementJournal, StoreError> {
    let mut next = journal.clone();
    next.phase = phase;
    next.updated_at = updated_at.to_owned();
    if let Some(safety_backup_id) = safety_backup_id {
        next.safety_backup_id = Some(safety_backup_id.to_owned());
    }
    if let Some(store_epoch) = installed_store_epoch {
        next.installed_store_epoch = Some(store_epoch.to_owned());
    }
    validate_phase_transition(journal.phase, next.phase)?;
    validate_journal(profile_home, &next)?;
    write_journal(profile_home, &next)?;
    Ok(next)
}

pub fn install_staged_store_files(
    profile_home: &Path,
    journal: &StoreReplacementJournal,
) -> Result<(), StoreError> {
    if journal.phase != StoreReplacementPhase::InstallStarted {
        return Err(internal(
            "Store files may be installed only in the install_started phase",
        ));
    }
    let backup_root = backups_root(profile_home);
    let staging = validate_staged_candidate(profile_home, &journal.staging_directory_name)?;
    let rollback =
        prepare_owned_directory(&backup_root, &journal.rollback_directory_name, ".rollback-")?;
    let database = live_database_path(profile_home);
    move_if_present(&database, &rollback.join(STORE_FILE_NAME))?;
    move_if_present(
        &append_suffix(&database, WAL_SUFFIX),
        &rollback.join(format!("{STORE_FILE_NAME}{WAL_SUFFIX}")),
    )?;
    move_if_present(
        &append_suffix(&database, SHM_SUFFIX),
        &rollback.join(format!("{STORE_FILE_NAME}{SHM_SUFFIX}")),
    )?;
    move_if_present(
        &profile_home.join(ASSETS_DIRECTORY_NAME),
        &rollback.join(ASSETS_DIRECTORY_NAME),
    )?;
    move_required(&staging.join(STORE_FILE_NAME), &database)?;
    move_required(
        &staging.join(ASSETS_DIRECTORY_NAME),
        &profile_home.join(ASSETS_DIRECTORY_NAME),
    )?;
    sync_directory(profile_home)
}

pub fn recover_interrupted_store_replacement(
    profile_home: &Path,
) -> Result<StoreReplacementStartupRecovery, StoreError> {
    let Some(journal) = read_store_replacement_journal(profile_home)? else {
        return Ok(StoreReplacementStartupRecovery::None);
    };
    match journal.phase {
        StoreReplacementPhase::Prepared => {
            validate_live_store(profile_home, Some(&journal.source_store_epoch))?;
            validate_staged_candidate(profile_home, &journal.staging_directory_name)?;
            Ok(StoreReplacementStartupRecovery::Prepared)
        }
        StoreReplacementPhase::Committed => {
            let installed_epoch = journal.installed_store_epoch.as_deref().ok_or_else(|| {
                corrupt("Committed Store replacement journal has no installed epoch")
            })?;
            validate_live_store(profile_home, Some(installed_epoch))?;
            if committed_receipt_exists(profile_home, &journal)? {
                cleanup_store_replacement(profile_home, &journal)?;
                return Ok(StoreReplacementStartupRecovery::CommittedCleaned);
            }
            Ok(StoreReplacementStartupRecovery::CommittedPendingReceipt)
        }
        StoreReplacementPhase::RollbackStarted
        | StoreReplacementPhase::InstallStarted
        | StoreReplacementPhase::EpochRotating => {
            rollback_store_replacement(profile_home, &journal)?;
            Ok(StoreReplacementStartupRecovery::RolledBack)
        }
    }
}

pub fn rollback_store_replacement(
    profile_home: &Path,
    journal: &StoreReplacementJournal,
) -> Result<StoreReplacementJournal, StoreError> {
    let backup_root = backups_root(profile_home);
    let staging =
        require_owned_directory(&backup_root, &journal.staging_directory_name, ".restore-")?;
    validate_owned_directory_name(&journal.rollback_directory_name, ".rollback-")?;
    let rollback = backup_root.join(&journal.rollback_directory_name);
    let rollback_metadata = match fs::symlink_metadata(&rollback) {
        Ok(metadata) => Some(metadata),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(io_error(error)),
    };
    if rollback_metadata.is_none() {
        validate_live_store(profile_home, Some(&journal.source_store_epoch))?;
        validate_staged_candidate(profile_home, &journal.staging_directory_name)?;
        return reset_journal_to_prepared(profile_home, journal);
    }
    if rollback_metadata
        .is_some_and(|metadata| metadata.file_type().is_symlink() || !metadata.is_dir())
    {
        return Err(invalid_profile(
            "Store replacement rollback directory is unsafe",
        ));
    }
    let database = live_database_path(profile_home);
    let rollback_database = rollback.join(STORE_FILE_NAME);
    if rollback_database.exists() {
        if database.exists() && !staging.join(STORE_FILE_NAME).exists() {
            move_required(&database, &staging.join(STORE_FILE_NAME))?;
        } else if database.exists() {
            return Err(corrupt(
                "Store rollback found both live and staged candidate databases",
            ));
        }
        move_required(&rollback_database, &database)?;
        restore_companion(
            &rollback.join(format!("{STORE_FILE_NAME}{WAL_SUFFIX}")),
            &append_suffix(&database, WAL_SUFFIX),
            journal.had_wal,
        )?;
        restore_companion(
            &rollback.join(format!("{STORE_FILE_NAME}{SHM_SUFFIX}")),
            &append_suffix(&database, SHM_SUFFIX),
            journal.had_shm,
        )?;
        let live_assets = profile_home.join(ASSETS_DIRECTORY_NAME);
        let rollback_assets = rollback.join(ASSETS_DIRECTORY_NAME);
        if journal.had_assets {
            if live_assets.exists() && !staging.join(ASSETS_DIRECTORY_NAME).exists() {
                move_required(&live_assets, &staging.join(ASSETS_DIRECTORY_NAME))?;
            } else if live_assets.exists() {
                return Err(corrupt(
                    "Store rollback found both live and staged candidate assets",
                ));
            }
            move_required(&rollback_assets, &live_assets)?;
        } else if live_assets.exists() {
            if staging.join(ASSETS_DIRECTORY_NAME).exists() {
                return Err(corrupt(
                    "Store rollback cannot preserve duplicate candidate assets",
                ));
            }
            move_required(&live_assets, &staging.join(ASSETS_DIRECTORY_NAME))?;
        }
        sync_directory(profile_home)?;
    }
    validate_live_store(profile_home, Some(&journal.source_store_epoch))?;
    validate_staged_candidate(profile_home, &journal.staging_directory_name)?;
    reset_journal_to_prepared(profile_home, journal)
}

fn reset_journal_to_prepared(
    profile_home: &Path,
    journal: &StoreReplacementJournal,
) -> Result<StoreReplacementJournal, StoreError> {
    let now = sqlite_now(profile_home)?;
    let mut prepared = journal.clone();
    prepared.phase = StoreReplacementPhase::Prepared;
    prepared.installed_store_epoch = None;
    prepared.updated_at = now;
    write_journal(profile_home, &prepared)?;
    Ok(prepared)
}

pub fn cleanup_store_replacement(
    profile_home: &Path,
    journal: &StoreReplacementJournal,
) -> Result<(), StoreError> {
    if journal.phase != StoreReplacementPhase::Committed {
        return Err(internal(
            "Only a committed Store replacement can be cleaned up",
        ));
    }
    let backup_root = backups_root(profile_home);
    remove_owned_directory(&backup_root, &journal.staging_directory_name, ".restore-")?;
    remove_owned_directory(&backup_root, &journal.rollback_directory_name, ".rollback-")?;
    let path = journal_path(profile_home);
    let metadata = fs::symlink_metadata(&path).map_err(io_error)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(invalid_profile(
            "Store replacement journal cleanup target is unsafe",
        ));
    }
    fs::remove_file(path).map_err(io_error)?;
    sync_directory(profile_home)
}

pub fn validate_live_store(
    profile_home: &Path,
    expected_store_epoch: Option<&str>,
) -> Result<String, StoreError> {
    let connection = open_writer(&live_database_path(profile_home))?;
    validate_store(&connection)?;
    validate_core_metadata(&connection)?;
    validate_codex_thread_timestamp_invariants(&connection)?;
    validate_database_priority_invariants(&connection)?;
    let store_epoch = connection
        .query_row(
            "SELECT store_epoch FROM block_store_metadata WHERE id = 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .ok_or_else(|| corrupt("Store replacement target has no store epoch"))?;
    if expected_store_epoch.is_some_and(|expected| expected != store_epoch) {
        return Err(corrupt(
            "Store replacement target epoch does not match its journal",
        ));
    }
    connection.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")?;
    drop(connection);
    sync_file(&live_database_path(profile_home))?;
    Ok(store_epoch)
}

pub fn validate_store_path(path: &Path) -> Result<String, StoreError> {
    let metadata = fs::symlink_metadata(path).map_err(io_error)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(invalid_profile(
            "Staged Store database must be a regular file",
        ));
    }
    let connection = super::sqlite::open_immutable_reader(path)?;
    validate_store(&connection)?;
    validate_core_metadata(&connection)?;
    validate_codex_thread_timestamp_invariants(&connection)?;
    validate_database_priority_invariants(&connection)?;
    connection
        .query_row(
            "SELECT store_epoch FROM block_store_metadata WHERE id = 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .ok_or_else(|| corrupt("Staged Store database has no store epoch"))
}

fn validate_core_metadata(connection: &rusqlite::Connection) -> Result<(), StoreError> {
    let schema_version =
        connection.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))?;
    if schema_version != CURRENT_STORE_REVISION {
        return Err(StoreError::new(
            StoreErrorCode::UnsupportedSchema,
            format!("Store replacement requires schema v{CURRENT_STORE_REVISION}"),
            false,
        ));
    }
    let owner = connection
        .query_row(
            "SELECT schema_owner FROM core_store_metadata WHERE id = 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .ok_or_else(|| corrupt("Store replacement target has no Core metadata"))?;
    if owner != "rust_core" {
        return Err(corrupt(
            "Store replacement target is not owned by Rust Core",
        ));
    }
    Ok(())
}

fn validate_staged_candidate(
    profile_home: &Path,
    staging_directory_name: &str,
) -> Result<PathBuf, StoreError> {
    let staging = require_owned_directory(
        &backups_root(profile_home),
        staging_directory_name,
        ".restore-",
    )?;
    validate_store_path(&staging_database_path(profile_home, staging_directory_name))?;
    validate_regular_tree(&staging.join(ASSETS_DIRECTORY_NAME))?;
    Ok(staging)
}

fn validate_regular_tree(root: &Path) -> Result<(), StoreError> {
    let mut pending = vec![root.to_path_buf()];
    let mut entry_count = 0usize;
    while let Some(directory) = pending.pop() {
        let metadata = fs::symlink_metadata(&directory).map_err(io_error)?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(invalid_profile(
                "Staged Store assets root must be a real directory",
            ));
        }
        for entry in fs::read_dir(directory).map_err(io_error)? {
            let entry = entry.map_err(io_error)?;
            entry_count = entry_count
                .checked_add(1)
                .ok_or_else(|| invalid_profile("Staged Store asset count exceeds its bound"))?;
            if entry_count > MAX_STAGED_ASSET_ENTRIES {
                return Err(invalid_profile(
                    "Staged Store asset count exceeds its bound",
                ));
            }
            let metadata = fs::symlink_metadata(entry.path()).map_err(io_error)?;
            if metadata.file_type().is_symlink() {
                return Err(invalid_profile(
                    "Staged Store assets must not contain symbolic links",
                ));
            }
            if metadata.is_dir() {
                pending.push(entry.path());
                continue;
            }
            if !metadata.is_file() {
                return Err(invalid_profile(
                    "Staged Store assets may contain only regular files and directories",
                ));
            }
        }
    }
    Ok(())
}

fn committed_receipt_exists(
    profile_home: &Path,
    journal: &StoreReplacementJournal,
) -> Result<bool, StoreError> {
    let connection = open_writer(&live_database_path(profile_home))?;
    let receipt = connection
        .query_row(
            "SELECT request_hash, operation_kind, store_epoch FROM core_module_receipts \
             WHERE module_name = 'store_administration' AND operation_id = ?1",
            [&journal.operation_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .optional()?;
    match receipt {
        Some((request_hash, operation_kind, store_epoch))
            if request_hash == journal.request_hash
                && operation_kind == "restore_backup"
                && journal.installed_store_epoch.as_deref() == Some(store_epoch.as_str()) =>
        {
            Ok(true)
        }
        Some((request_hash, _, _)) if request_hash != journal.request_hash => Err(StoreError::new(
            StoreErrorCode::IdempotencyKeyReused,
            "Committed Store replacement receipt conflicts with its journal",
            false,
        )),
        Some(_) => Err(corrupt(
            "Committed Store replacement receipt does not describe the installed restore",
        )),
        None => Ok(false),
    }
}

fn validate_journal(
    profile_home: &Path,
    journal: &StoreReplacementJournal,
) -> Result<(), StoreError> {
    validate_owned_directory_name(&journal.staging_directory_name, ".restore-")?;
    validate_owned_directory_name(&journal.rollback_directory_name, ".rollback-")?;
    if journal.version != JOURNAL_VERSION
        || journal.operation_id.is_empty()
        || journal.operation_id.len() > 512
        || !is_sha256(&journal.request_hash)
        || !is_safe_backup_id(&journal.backup_id)
        || journal
            .safety_backup_id
            .as_ref()
            .is_some_and(|backup_id| !is_safe_backup_id(backup_id))
        || journal.source_store_epoch.is_empty()
        || journal.source_store_epoch.len() > 512
        || journal
            .installed_store_epoch
            .as_ref()
            .is_some_and(|epoch| epoch.is_empty() || epoch.len() > 512)
        || chrono::DateTime::parse_from_rfc3339(&journal.updated_at).is_err()
        || (journal.phase == StoreReplacementPhase::Committed
            && journal.installed_store_epoch.is_none())
    {
        return Err(corrupt("Store replacement journal fields are invalid"));
    }
    let root = backups_root(profile_home);
    let metadata = fs::symlink_metadata(&root).map_err(io_error)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(invalid_profile(
            "Store replacement backup root is not a real directory",
        ));
    }
    Ok(())
}

fn validate_phase_transition(
    current: StoreReplacementPhase,
    next: StoreReplacementPhase,
) -> Result<(), StoreError> {
    let valid = matches!(
        (current, next),
        (
            StoreReplacementPhase::Prepared,
            StoreReplacementPhase::Prepared
        ) | (
            StoreReplacementPhase::Prepared,
            StoreReplacementPhase::RollbackStarted
        ) | (
            StoreReplacementPhase::RollbackStarted,
            StoreReplacementPhase::InstallStarted
        ) | (
            StoreReplacementPhase::InstallStarted,
            StoreReplacementPhase::EpochRotating
        ) | (
            StoreReplacementPhase::EpochRotating,
            StoreReplacementPhase::Committed
        ) | (
            StoreReplacementPhase::Committed,
            StoreReplacementPhase::Committed
        )
    );
    if valid {
        return Ok(());
    }
    Err(internal(
        "Store replacement journal phase transition is invalid",
    ))
}

fn write_journal(profile_home: &Path, journal: &StoreReplacementJournal) -> Result<(), StoreError> {
    let mut bytes = serde_json::to_vec_pretty(journal)
        .map_err(|_| internal("Store replacement journal could not be encoded"))?;
    bytes.push(b'\n');
    if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > MAX_JOURNAL_BYTES {
        return Err(internal("Store replacement journal exceeds its size bound"));
    }
    let path = journal_path(profile_home);
    let temporary = profile_home.join(format!(".{JOURNAL_FILE_NAME}.tmp"));
    if temporary.exists() {
        let metadata = fs::symlink_metadata(&temporary).map_err(io_error)?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(invalid_profile(
                "Store replacement journal temporary path is unsafe",
            ));
        }
        fs::remove_file(&temporary).map_err(io_error)?;
    }
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(PRIVATE_FILE_MODE)
        .open(&temporary)
        .map_err(io_error)?;
    file.write_all(&bytes).map_err(io_error)?;
    file.sync_all().map_err(io_error)?;
    drop(file);
    fs::rename(temporary, path).map_err(io_error)?;
    sync_directory(profile_home)
}

fn restore_companion(source: &Path, destination: &Path, expected: bool) -> Result<(), StoreError> {
    if destination.exists() {
        let metadata = fs::symlink_metadata(destination).map_err(io_error)?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(invalid_profile("Store companion cleanup target is unsafe"));
        }
        fs::remove_file(destination).map_err(io_error)?;
    }
    if expected {
        move_required(source, destination)?;
    } else if source.exists() {
        return Err(corrupt(
            "Store replacement rollback contains an unexpected companion file",
        ));
    }
    Ok(())
}

fn move_if_present(source: &Path, destination: &Path) -> Result<(), StoreError> {
    match fs::symlink_metadata(source) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(invalid_profile(
            "Store replacement source must not be a symbolic link",
        )),
        Ok(_) => move_required(source, destination),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(io_error(error)),
    }
}

fn move_required(source: &Path, destination: &Path) -> Result<(), StoreError> {
    if destination.exists() {
        return Err(corrupt("Store replacement destination already exists"));
    }
    let metadata = fs::symlink_metadata(source).map_err(io_error)?;
    if metadata.file_type().is_symlink() {
        return Err(invalid_profile(
            "Store replacement source must not be a symbolic link",
        ));
    }
    fs::rename(source, destination).map_err(io_error)?;
    if let Some(parent) = source.parent() {
        sync_directory(parent)?;
    }
    if source.parent() != destination.parent()
        && let Some(parent) = destination.parent()
    {
        sync_directory(parent)?;
    }
    Ok(())
}

fn prepare_owned_directory(root: &Path, name: &str, prefix: &str) -> Result<PathBuf, StoreError> {
    validate_owned_directory_name(name, prefix)?;
    let path = root.join(name);
    match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err(invalid_profile(
                "Store replacement owned directory is unsafe",
            ));
        }
        Ok(_) => return Ok(path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(io_error(error)),
    }
    fs::create_dir(&path).map_err(io_error)?;
    sync_directory(root)?;
    Ok(path)
}

fn require_owned_directory(root: &Path, name: &str, prefix: &str) -> Result<PathBuf, StoreError> {
    validate_owned_directory_name(name, prefix)?;
    let path = root.join(name);
    let metadata = fs::symlink_metadata(&path).map_err(io_error)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(invalid_profile(
            "Store replacement owned directory is unsafe",
        ));
    }
    Ok(path)
}

fn remove_owned_directory(root: &Path, name: &str, prefix: &str) -> Result<(), StoreError> {
    validate_owned_directory_name(name, prefix)?;
    let path = root.join(name);
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(io_error(error)),
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(invalid_profile(
            "Store replacement cleanup directory is unsafe",
        ));
    }
    fs::remove_dir_all(path).map_err(io_error)?;
    sync_directory(root)
}

fn validate_owned_directory_name(name: &str, prefix: &str) -> Result<(), StoreError> {
    if !name.starts_with(prefix)
        || name.len() > 160
        || name.len() == prefix.len()
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'.')
    {
        return Err(invalid_profile(
            "Store replacement journal contains an unsafe directory name",
        ));
    }
    Ok(())
}

fn regular_file_exists(path: &Path) -> Result<bool, StoreError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => Err(
            invalid_profile("Store replacement companion must be a regular file"),
        ),
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(io_error(error)),
    }
}

fn directory_exists(path: &Path) -> Result<bool, StoreError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => Err(
            invalid_profile("Store replacement assets must be a real directory"),
        ),
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(io_error(error)),
    }
}

fn sqlite_now(profile_home: &Path) -> Result<String, StoreError> {
    let connection = open_writer(&live_database_path(profile_home))?;
    connection
        .query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", [], |row| {
            row.get::<_, String>(0)
        })
        .map_err(Into::into)
}

fn journal_path(profile_home: &Path) -> PathBuf {
    profile_home.join(JOURNAL_FILE_NAME)
}

fn backups_root(profile_home: &Path) -> PathBuf {
    profile_home.join("backups")
}

fn live_database_path(profile_home: &Path) -> PathBuf {
    profile_home.join(STORE_FILE_NAME)
}

fn staging_database_path(profile_home: &Path, staging_name: &str) -> PathBuf {
    backups_root(profile_home)
        .join(staging_name)
        .join(STORE_FILE_NAME)
}

fn append_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut suffixed = path.as_os_str().to_os_string();
    suffixed.push(suffix);
    PathBuf::from(suffixed)
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn is_safe_backup_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
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

fn invalid_profile(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidProfile, message, false)
}

fn corrupt(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message, false)
}

fn internal(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::Internal, message, false)
}

fn io_error(error: std::io::Error) -> StoreError {
    StoreError::new(
        StoreErrorCode::Internal,
        format!("Store replacement filesystem operation failed: {error}"),
        false,
    )
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::{PermissionsExt, symlink};

    use nodex_core_contracts::{AdapterKind, BoundModuleContext, LibraryId, ProfileId};
    use rusqlite::params;
    use serde_json::json;
    use tempfile::TempDir;

    use super::*;
    use crate::infrastructure::module_receipts::{NewModuleReceipt, insert_module_receipt};
    use crate::infrastructure::sqlite::with_immediate_transaction;
    use crate::infrastructure::store::SqliteStoreKernel;

    const SOURCE_EPOCH: &str = "epoch:store-replacement-source";
    const CANDIDATE_EPOCH: &str = "epoch:store-replacement-candidate";
    const INSTALLED_EPOCH: &str = "epoch:store-replacement-installed";
    const OPERATION_ID: &str = "operation:store-replacement-test";
    const REQUEST_HASH: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const BACKUP_ID: &str = "backup-store-replacement-test";
    const STAGING_NAME: &str = ".restore-core-replacement-test";
    const ROLLBACK_NAME: &str = ".rollback-core-replacement-test";
    const NOW: &str = "2026-07-19T00:00:00.000Z";

    struct ReplacementFixture {
        home: TempDir,
    }

    impl ReplacementFixture {
        fn new() -> Self {
            let home = tempfile::tempdir().expect("Profile home");
            let kernel = SqliteStoreKernel::open(home.path()).expect("fresh Store");
            kernel
                .writer()
                .call(|connection| {
                    connection.execute(
                        "INSERT INTO block_store_metadata(id, store_epoch, created_at, updated_at) \
                         VALUES (1, ?1, ?2, ?2)",
                        params![SOURCE_EPOCH, NOW],
                    )?;
                    connection.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")?;
                    Ok(())
                })
                .expect("source fixture");
            drop(kernel);

            fs::create_dir(home.path().join(ASSETS_DIRECTORY_NAME)).expect("source assets");
            fs::write(
                home.path().join(ASSETS_DIRECTORY_NAME).join("asset.bin"),
                b"source asset",
            )
            .expect("source asset");

            let staging = home.path().join("backups").join(STAGING_NAME);
            fs::create_dir_all(staging.join(ASSETS_DIRECTORY_NAME)).expect("staging assets");
            fs::copy(
                live_database_path(home.path()),
                staging.join(STORE_FILE_NAME),
            )
            .expect("candidate database");
            fs::write(
                staging.join(ASSETS_DIRECTORY_NAME).join("asset.bin"),
                b"candidate asset",
            )
            .expect("candidate asset");
            let candidate = open_writer(&staging.join(STORE_FILE_NAME)).expect("candidate Store");
            candidate
                .execute(
                    "UPDATE block_store_metadata SET store_epoch = ?1, updated_at = ?2 WHERE id = 1",
                    params![CANDIDATE_EPOCH, NOW],
                )
                .expect("candidate epoch");
            candidate
                .execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
                .expect("candidate checkpoint");
            drop(candidate);

            Self { home }
        }

        fn home(&self) -> &Path {
            self.home.path()
        }

        fn create_journal(&self) -> StoreReplacementJournal {
            create_store_replacement_journal(
                self.home(),
                NewStoreReplacementJournal {
                    operation_id: OPERATION_ID,
                    request_hash: REQUEST_HASH,
                    backup_id: BACKUP_ID,
                    staging_directory_name: STAGING_NAME,
                    rollback_directory_name: ROLLBACK_NAME,
                    source_store_epoch: SOURCE_EPOCH,
                    updated_at: NOW,
                },
            )
            .expect("replacement journal")
        }

        fn epoch_at(&self, database: &Path) -> String {
            let connection = open_writer(database).expect("Store epoch");
            connection
                .query_row(
                    "SELECT store_epoch FROM block_store_metadata WHERE id = 1",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .expect("Store epoch")
        }

        fn live_epoch(&self) -> String {
            self.epoch_at(&live_database_path(self.home()))
        }

        fn staged_epoch(&self) -> String {
            self.epoch_at(&staging_database_path(self.home(), STAGING_NAME))
        }
    }

    #[test]
    fn prepared_replacement_remains_adoptable_on_startup() {
        let fixture = ReplacementFixture::new();
        fixture.create_journal();

        let kernel = SqliteStoreKernel::open(fixture.home()).expect("recovered Store");
        assert_eq!(fixture.live_epoch(), SOURCE_EPOCH);
        assert_eq!(fixture.staged_epoch(), CANDIDATE_EPOCH);
        assert_eq!(
            read_store_replacement_journal(fixture.home())
                .expect("journal")
                .expect("prepared journal")
                .phase,
            StoreReplacementPhase::Prepared
        );
        drop(kernel);
    }

    #[test]
    fn candidate_asset_symlinks_are_rejected_before_journaling() {
        let fixture = ReplacementFixture::new();
        let candidate_asset = fixture
            .home()
            .join("backups")
            .join(STAGING_NAME)
            .join(ASSETS_DIRECTORY_NAME)
            .join("asset.bin");
        fs::remove_file(&candidate_asset).expect("remove candidate asset");
        let outside = fixture.home().join("outside.bin");
        fs::write(&outside, b"outside").expect("outside file");
        symlink(&outside, candidate_asset).expect("candidate symlink");

        let error = create_store_replacement_journal(
            fixture.home(),
            NewStoreReplacementJournal {
                operation_id: OPERATION_ID,
                request_hash: REQUEST_HASH,
                backup_id: BACKUP_ID,
                staging_directory_name: STAGING_NAME,
                rollback_directory_name: ROLLBACK_NAME,
                source_store_epoch: SOURCE_EPOCH,
                updated_at: NOW,
            },
        )
        .expect_err("unsafe candidate must fail");
        assert_eq!(error.code, StoreErrorCode::InvalidProfile);
        assert!(!journal_path(fixture.home()).exists());
    }

    #[test]
    fn startup_rejects_a_group_readable_replacement_journal() {
        let fixture = ReplacementFixture::new();
        fixture.create_journal();
        fs::set_permissions(
            journal_path(fixture.home()),
            fs::Permissions::from_mode(0o640),
        )
        .expect("journal permissions");

        let error = match SqliteStoreKernel::open(fixture.home()) {
            Ok(_) => panic!("public journal must fail"),
            Err(error) => error,
        };
        assert_eq!(error.code, StoreErrorCode::InvalidProfile);
    }

    #[test]
    fn install_phase_without_filesystem_changes_returns_to_prepared() {
        let fixture = ReplacementFixture::new();
        let prepared = fixture.create_journal();
        let rollback_started = advance_store_replacement_journal(
            fixture.home(),
            &prepared,
            StoreReplacementPhase::RollbackStarted,
            NOW,
            None,
            None,
        )
        .expect("rollback phase");
        advance_store_replacement_journal(
            fixture.home(),
            &rollback_started,
            StoreReplacementPhase::InstallStarted,
            NOW,
            None,
            None,
        )
        .expect("install phase");

        let kernel = SqliteStoreKernel::open(fixture.home()).expect("recovered Store");
        assert_eq!(fixture.live_epoch(), SOURCE_EPOCH);
        assert_eq!(fixture.staged_epoch(), CANDIDATE_EPOCH);
        assert_eq!(
            read_store_replacement_journal(fixture.home())
                .expect("journal")
                .expect("prepared journal")
                .phase,
            StoreReplacementPhase::Prepared
        );
        drop(kernel);
    }

    #[test]
    fn interrupted_install_rolls_back_and_preserves_the_candidate() {
        let fixture = ReplacementFixture::new();
        let prepared = fixture.create_journal();
        let rollback_started = advance_store_replacement_journal(
            fixture.home(),
            &prepared,
            StoreReplacementPhase::RollbackStarted,
            NOW,
            None,
            None,
        )
        .expect("rollback phase");
        let install_started = advance_store_replacement_journal(
            fixture.home(),
            &rollback_started,
            StoreReplacementPhase::InstallStarted,
            NOW,
            None,
            None,
        )
        .expect("install phase");
        install_staged_store_files(fixture.home(), &install_started).expect("install candidate");

        let kernel = SqliteStoreKernel::open(fixture.home()).expect("rolled back Store");
        assert_eq!(fixture.live_epoch(), SOURCE_EPOCH);
        assert_eq!(fixture.staged_epoch(), CANDIDATE_EPOCH);
        assert_eq!(
            fs::read(
                fixture
                    .home()
                    .join("backups")
                    .join(STAGING_NAME)
                    .join(ASSETS_DIRECTORY_NAME)
                    .join("asset.bin")
            )
            .expect("preserved candidate asset"),
            b"candidate asset"
        );
        assert_eq!(
            fs::read(fixture.home().join(ASSETS_DIRECTORY_NAME).join("asset.bin"))
                .expect("restored source asset"),
            b"source asset"
        );
        assert_eq!(
            read_store_replacement_journal(fixture.home())
                .expect("journal")
                .expect("prepared journal")
                .phase,
            StoreReplacementPhase::Prepared
        );
        drop(kernel);
    }

    #[test]
    fn committed_replacement_waits_for_its_receipt_before_cleanup() {
        let fixture = ReplacementFixture::new();
        let prepared = fixture.create_journal();
        let rollback_started = advance_store_replacement_journal(
            fixture.home(),
            &prepared,
            StoreReplacementPhase::RollbackStarted,
            NOW,
            None,
            None,
        )
        .expect("rollback phase");
        let install_started = advance_store_replacement_journal(
            fixture.home(),
            &rollback_started,
            StoreReplacementPhase::InstallStarted,
            NOW,
            None,
            None,
        )
        .expect("install phase");
        install_staged_store_files(fixture.home(), &install_started).expect("install candidate");
        let epoch_rotating = advance_store_replacement_journal(
            fixture.home(),
            &install_started,
            StoreReplacementPhase::EpochRotating,
            NOW,
            None,
            None,
        )
        .expect("epoch phase");
        let installed = open_writer(&live_database_path(fixture.home())).expect("installed Store");
        installed
            .execute(
                "UPDATE block_store_metadata SET store_epoch = ?1, updated_at = ?2 WHERE id = 1",
                params![INSTALLED_EPOCH, NOW],
            )
            .expect("installed epoch");
        installed
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
            .expect("installed checkpoint");
        drop(installed);
        advance_store_replacement_journal(
            fixture.home(),
            &epoch_rotating,
            StoreReplacementPhase::Committed,
            NOW,
            None,
            Some(INSTALLED_EPOCH),
        )
        .expect("committed phase");

        let kernel = SqliteStoreKernel::open(fixture.home()).expect("pending receipt Store");
        assert_eq!(fixture.live_epoch(), INSTALLED_EPOCH);
        assert!(journal_path(fixture.home()).exists());
        kernel
            .writer()
            .call(|connection| {
                with_immediate_transaction(connection, |transaction| {
                    let context = BoundModuleContext {
                        editor_history_owner: None,
                        profile_id: ProfileId("profile:test".to_owned()),
                        library_id: LibraryId("library:test".to_owned()),
                        project_id: None,
                        connection_id: "connection:test".to_owned(),
                        adapter: AdapterKind::Test,
                    };
                    let result = json!({});
                    insert_module_receipt(
                        transaction,
                        NewModuleReceipt {
                            module_name: "store_administration",
                            operation_id: OPERATION_ID,
                            context: &context,
                            operation_kind: "create_backup",
                            store_epoch: INSTALLED_EPOCH,
                            request_hash: REQUEST_HASH,
                            result: &result,
                            event_sequence: None,
                            local_commit: None,
                            committed_at: NOW,
                        },
                    )
                })
            })
            .expect("restore receipt");
        drop(kernel);

        let error = match SqliteStoreKernel::open(fixture.home()) {
            Ok(_) => panic!("wrong receipt kind must not clean the restore"),
            Err(error) => error,
        };
        assert_eq!(error.code, StoreErrorCode::StoreCorrupt);
        assert!(journal_path(fixture.home()).exists());
        let connection = open_writer(&live_database_path(fixture.home())).expect("installed Store");
        connection
            .execute(
                "UPDATE core_module_receipts SET operation_kind = 'restore_backup' \
                 WHERE module_name = 'store_administration' AND operation_id = ?1",
                [OPERATION_ID],
            )
            .expect("correct receipt kind");
        drop(connection);

        let kernel = SqliteStoreKernel::open(fixture.home()).expect("cleaned Store");
        assert_eq!(fixture.live_epoch(), INSTALLED_EPOCH);
        assert!(!journal_path(fixture.home()).exists());
        assert!(!fixture.home().join("backups").join(STAGING_NAME).exists());
        assert!(!fixture.home().join("backups").join(ROLLBACK_NAME).exists());
        drop(kernel);
    }
}
