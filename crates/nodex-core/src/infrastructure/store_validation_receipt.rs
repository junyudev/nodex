use nodex_platform::private_fs::OpenOptions;
use std::fs;
use std::io::{self, Write};

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use super::sqlite::{StoreError, StoreErrorCode};

const RECEIPT_FILE_NAME: &str = "store-validation-receipt-v1.json";
const RECEIPT_VERSION: u32 = 1;
const PRIVATE_FILE_MODE: u32 = 0o600;
const MAX_RECEIPT_BYTES: u64 = 4 * 1024;

/// Evidence that the prior Core generation closed cleanly after an exact Store validation.
///
/// The receipt is consumed before every new Core generation opens the Store. A crash, an
/// interrupted startup, or a stale receipt therefore falls back to the complete validation path.
/// An unsafe filesystem entry is rejected rather than trusted.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct StoreValidationReceipt {
    version: u32,
    schema_version: i64,
    store_epoch: String,
    commit_head: i64,
}

impl StoreValidationReceipt {
    fn matches(&self, current: &Self) -> bool {
        self.version == RECEIPT_VERSION
            && self.schema_version == current.schema_version
            && self.store_epoch == current.store_epoch
            && self.commit_head == current.commit_head
    }
}

pub(crate) enum ConsumedStoreValidationReceipt {
    Absent,
    Rejected { reason: &'static str },
    Trusted(StoreValidationReceipt),
}

pub(crate) fn consume(profile_home: &Path) -> Result<ConsumedStoreValidationReceipt, StoreError> {
    let path = receipt_path(profile_home);
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(ConsumedStoreValidationReceipt::Absent);
        }
        Err(error) => {
            return Err(io_error(
                "Store validation receipt metadata is unavailable",
                error,
            ));
        }
    };
    validate_private_regular_file(&path, &metadata)?;
    if metadata.len() > MAX_RECEIPT_BYTES {
        remove_receipt(&path)?;
        return Ok(ConsumedStoreValidationReceipt::Rejected {
            reason: "oversized",
        });
    }
    let bytes = fs::read(&path)
        .map_err(|error| io_error("Store validation receipt could not be read", error))?;
    remove_receipt(&path)?;
    let receipt = match serde_json::from_slice::<StoreValidationReceipt>(&bytes) {
        Ok(receipt) if valid_receipt(&receipt) => receipt,
        _ => {
            return Ok(ConsumedStoreValidationReceipt::Rejected { reason: "invalid" });
        }
    };
    Ok(ConsumedStoreValidationReceipt::Trusted(receipt))
}

pub(crate) fn current(connection: &Connection) -> Result<StoreValidationReceipt, StoreError> {
    let store_epoch = connection
        .query_row(
            "SELECT store_epoch FROM block_store_metadata WHERE id = 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .map_err(StoreError::from)?;
    let commit_head = super::local_commit::head(connection)?;
    let receipt = StoreValidationReceipt {
        version: RECEIPT_VERSION,
        schema_version: connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(StoreError::from)?,
        store_epoch,
        commit_head,
    };
    if valid_receipt(&receipt) {
        return Ok(receipt);
    }
    Err(StoreError::new(
        StoreErrorCode::StoreCorrupt,
        "Store validation identity is invalid",
        false,
    ))
}

pub(crate) fn matches(
    receipt: &StoreValidationReceipt,
    connection: &Connection,
) -> Result<bool, StoreError> {
    Ok(receipt.matches(&current(connection)?))
}

pub(crate) fn persist(
    profile_home: &Path,
    receipt: &StoreValidationReceipt,
) -> Result<(), StoreError> {
    if !valid_receipt(receipt) {
        return Err(StoreError::new(
            StoreErrorCode::Internal,
            "Refusing to persist an invalid Store validation receipt",
            false,
        ));
    }
    let path = receipt_path(profile_home);
    match fs::symlink_metadata(&path) {
        Ok(_) => {
            return Err(StoreError::new(
                StoreErrorCode::InvalidProfile,
                "Store validation receipt unexpectedly exists during clean shutdown",
                false,
            ));
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(io_error(
                "Store validation receipt metadata is unavailable during clean shutdown",
                error,
            ));
        }
    }
    let directory = path.parent().ok_or_else(|| {
        StoreError::new(
            StoreErrorCode::InvalidProfile,
            "Store validation receipt directory is unavailable",
            false,
        )
    })?;
    let bytes = serde_json::to_vec(receipt).map_err(|error| {
        StoreError::new(
            StoreErrorCode::Internal,
            format!("Store validation receipt could not be encoded: {error}"),
            false,
        )
    })?;
    let temporary = temporary_path(&path)?;
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(PRIVATE_FILE_MODE)
        .open(&temporary)
        .map_err(|error| io_error("Store validation receipt could not be created", error))?;
    let result = (|| {
        file.write_all(&bytes)
            .map_err(|error| io_error("Store validation receipt could not be written", error))?;
        file.sync_all()
            .map_err(|error| io_error("Store validation receipt could not be synced", error))?;
        drop(file);
        nodex_platform::private_fs::atomic_replace(&temporary, &path)
            .map_err(|error| io_error("Store validation receipt could not be published", error))?;
        nodex_platform::private_fs::sync_directory(directory).map_err(|error| {
            io_error(
                "Store validation receipt directory could not be synced",
                error,
            )
        })
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn receipt_path(profile_home: &Path) -> PathBuf {
    profile_home.join("run/core").join(RECEIPT_FILE_NAME)
}

fn remove_receipt(path: &Path) -> Result<(), StoreError> {
    fs::remove_file(path)
        .map_err(|error| io_error("Store validation receipt could not be consumed", error))?;
    let directory = path.parent().ok_or_else(|| {
        StoreError::new(
            StoreErrorCode::InvalidProfile,
            "Store validation receipt directory is unavailable",
            false,
        )
    })?;
    nodex_platform::private_fs::sync_directory(directory).map_err(|error| {
        io_error(
            "Store validation receipt removal could not be synced",
            error,
        )
    })
}

fn validate_private_regular_file(path: &Path, _metadata: &fs::Metadata) -> Result<(), StoreError> {
    nodex_platform::private_fs::checked_metadata(
        path,
        nodex_platform::private_fs::EntryKind::File,
        Some(PRIVATE_FILE_MODE),
    )
    .map(|_| ())
    .map_err(|error| io_error("Store validation receipt is unsafe", error))
}

fn valid_receipt(receipt: &StoreValidationReceipt) -> bool {
    receipt.version == RECEIPT_VERSION
        && receipt.schema_version > 0
        && !receipt.store_epoch.is_empty()
        && receipt.store_epoch.len() <= 512
        && receipt.commit_head >= 0
}

fn temporary_path(path: &Path) -> Result<PathBuf, StoreError> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| {
            StoreError::new(
                StoreErrorCode::Internal,
                format!("Store validation receipt clock is unavailable: {error}"),
                false,
            )
        })?
        .as_nanos();
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| {
            StoreError::new(
                StoreErrorCode::InvalidProfile,
                "Store validation receipt filename is invalid",
                false,
            )
        })?;
    Ok(path.with_file_name(format!(".{name}.{}.{}.tmp", std::process::id(), timestamp)))
}

fn io_error(context: &str, error: io::Error) -> StoreError {
    StoreError::new(
        StoreErrorCode::InvalidProfile,
        format!("{context}: {error}"),
        false,
    )
}
