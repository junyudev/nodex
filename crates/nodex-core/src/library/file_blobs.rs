use std::fs;
use std::path::PathBuf;

use nodex_core_contracts::library::{LibraryFileReadSource, PreparedBlobReceipt};
use nodex_core_contracts::{AdapterKind, BoundModuleContext};
use rusqlite::{Connection, OptionalExtension, params};

use crate::infrastructure::sqlite::{StoreError, StoreErrorCode, with_immediate_transaction};

use super::LibraryModule;

const MAX_ID_BYTES: usize = 512;
const SHA256_HEX_BYTES: usize = 64;
const MAX_PREPARED_BLOB_LIFETIME_MS: u64 = 24 * 60 * 60 * 1_000;

#[derive(Debug)]
pub struct FileBlobDescriptor {
    pub file_id: String,
    pub version: i64,
    pub default_name: String,
    pub mime_type: String,
    pub byte_length: u64,
    pub blob_etag: String,
    pub physical_path: PathBuf,
    pub file: fs::File,
}

impl LibraryModule {
    pub fn resolve_file_blob(
        &self,
        context: &BoundModuleContext,
        file_id: &str,
        source: &LibraryFileReadSource,
        version: Option<i64>,
    ) -> Result<FileBlobDescriptor, nodex_core_contracts::CoreError> {
        self.validate_context(context)?;
        let readers = self
            .readers
            .as_ref()
            .ok_or_else(|| super::invalid_input("The Library tracer has no File bytes"))?;
        let root = self.file_blob_root()?;
        let _lease = crate::infrastructure::managed_asset_snapshot::acquire_snapshot_lease()
            .map_err(super::core_error)?;
        let context = context.clone();
        let file_id = file_id.to_owned();
        let source = source.clone();
        let descriptor = readers.read_default(move |connection| {
            let transaction = connection.unchecked_transaction()?;
            let presentation = super::file_queries::presentation(&transaction, &context, &file_id, &source, version)?;
            let physical_name = transaction.query_row(
                "SELECT physical_asset_name FROM managed_blobs WHERE content_hash = ?1 AND byte_length = ?2",
                params![presentation.blob_etag, presentation.byte_length as i64], |row| row.get::<_, String>(0),
            )?;
            validate_physical_name(&physical_name)?;
            let descriptor = FileBlobDescriptor {
                file_id, version: presentation.version, default_name: presentation.default_name,
                mime_type: presentation.mime_type, byte_length: presentation.byte_length, blob_etag: presentation.blob_etag,
                file: crate::infrastructure::managed_blobs::open(&root, &physical_name, presentation.byte_length)?,
                physical_path: root.join(physical_name),
            };
            transaction.commit()?;
            Ok(descriptor)
        }).map_err(super::core_error)?;
        Ok(descriptor)
    }

    pub fn file_blob_root(&self) -> Result<PathBuf, nodex_core_contracts::CoreError> {
        self.assets_root
            .clone()
            .ok_or_else(|| super::invalid_input("the Library tracer has no Blob storage"))
    }

    #[allow(clippy::too_many_arguments)]
    pub fn register_prepared_file_blob(
        &self,
        context: &BoundModuleContext,
        expected_store_epoch: &str,
        operation_id: &str,
        receipt_id: &str,
        content_hash: &str,
        physical_asset_name: &str,
        byte_length: u64,
        expires_at_unix_ms: u64,
    ) -> Result<PreparedBlobReceipt, nodex_core_contracts::CoreError> {
        self.validate_context(context)?;
        validate_id(operation_id, "Operation").map_err(super::core_error)?;
        validate_id(receipt_id, "Prepared Blob receipt").map_err(super::core_error)?;
        validate_content_hash(content_hash).map_err(super::core_error)?;
        validate_physical_name(physical_asset_name).map_err(super::core_error)?;
        let byte_length = i64::try_from(byte_length)
            .map_err(|_| super::invalid_input("File Blob exceeds the Store length bound"))?;
        let expires_at_unix_ms = i64::try_from(expires_at_unix_ms).map_err(|_| {
            super::invalid_input("Prepared File Blob expiry exceeds the Store bound")
        })?;
        let writer = self
            .writer
            .as_ref()
            .ok_or_else(|| super::invalid_input("the Library tracer cannot prepare File Blobs"))?;
        let library_id = self.library_id.clone();
        let context = context.clone();
        let blob_root = self.file_blob_root()?;
        let _lease = crate::infrastructure::managed_asset_snapshot::acquire_snapshot_lease()
            .map_err(super::core_error)?;
        crate::infrastructure::managed_blobs::verify(
            &blob_root,
            physical_asset_name,
            content_hash,
            byte_length as u64,
        )
        .map_err(super::core_error)?;
        let expected_store_epoch = expected_store_epoch.to_owned();
        let operation_id = operation_id.to_owned();
        let receipt_id = receipt_id.to_owned();
        let content_hash = content_hash.to_owned();
        let physical_asset_name = physical_asset_name.to_owned();
        writer
            .call(move |connection| {
                with_immediate_transaction(connection, |transaction| {
                    let store_epoch = crate::document::read_store_epoch(transaction)?;
                    if store_epoch != expected_store_epoch {
                        return Err(StoreError::new(
                            StoreErrorCode::StaleStoreEpoch,
                            "Prepared File Blob targets a stale Store epoch",
                            true,
                        ));
                    }
                    let project_id = match context.project_id.as_ref() {
                        Some(project_id) => {
                            require_project_in_library(transaction, &library_id, &project_id.0)?;
                            project_id.0.clone()
                        }
                        None if matches!(
                            context.adapter,
                            AdapterKind::ElectronHost | AdapterKind::NativeCli | AdapterKind::Test
                        ) =>
                        {
                            super::mutation::resolve_library_actor_project_id(
                                transaction,
                                &library_id,
                            )?
                        }
                        None => {
                            return Err(StoreError::new(
                                StoreErrorCode::Unauthorized,
                                "Prepared File Blobs require trusted local Library authority",
                                false,
                            ));
                        }
                    };
                    let published_path = blob_root.join(&physical_asset_name);
                    let published = fs::symlink_metadata(&published_path).map_err(|_| {
                        StoreError::new(
                            StoreErrorCode::StoreCorrupt,
                            "Prepared File Blob bytes are unavailable",
                            false,
                        )
                    })?;
                    if published.file_type().is_symlink()
                        || !published.is_file()
                        || published.len() != u64::try_from(byte_length).unwrap_or(u64::MAX)
                    {
                        return Err(StoreError::new(
                            StoreErrorCode::StoreCorrupt,
                            "Prepared File Blob bytes do not match their receipt",
                            false,
                        ));
                    }
                    let now = super::mutation::sqlite_now(transaction)?;
                    let now_ms = sqlite_now_ms(transaction)?;
                    if expires_at_unix_ms <= now_ms
                        || expires_at_unix_ms - now_ms
                            > i64::try_from(MAX_PREPARED_BLOB_LIFETIME_MS)
                                .expect("Blob lifetime bound")
                    {
                        return Err(invalid("Prepared File Blob expiry is invalid"));
                    }
                    transaction.execute(
                        "DELETE FROM prepared_blob_receipts \
                         WHERE state = 'prepared' AND expires_at_unix_ms < ?1",
                        [now_ms],
                    )?;
                    transaction.execute(
                        "INSERT INTO managed_blobs( \
                           content_hash, physical_asset_name, byte_length, created_at \
                         ) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(content_hash) DO NOTHING",
                        params![content_hash, physical_asset_name, byte_length, now],
                    )?;
                    let registered = transaction
                        .query_row(
                            "SELECT 1 FROM managed_blobs WHERE content_hash = ?1 \
                               AND physical_asset_name = ?2 AND byte_length = ?3",
                            params![content_hash, physical_asset_name, byte_length],
                            |_| Ok(()),
                        )
                        .optional()?;
                    if registered.is_none() {
                        return Err(StoreError::new(
                            StoreErrorCode::StoreCorrupt,
                            "Managed Blob identity collides with different bytes",
                            false,
                        ));
                    }
                    let inserted = transaction.execute(
                        "INSERT OR IGNORE INTO prepared_blob_receipts( \
                           receipt_id, project_id, library_id, store_epoch, content_hash, \
                           byte_length, state, operation_id, expires_at_unix_ms, \
                           consumed_commit_seq, created_at, updated_at \
                         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'prepared', ?7, ?8, NULL, ?9, ?9)",
                        params![
                            receipt_id,
                            project_id,
                            library_id,
                            store_epoch,
                            content_hash,
                            byte_length,
                            operation_id,
                            expires_at_unix_ms,
                            now,
                        ],
                    )?;
                    if inserted == 0 {
                        let existing = transaction
                            .query_row(
                                "SELECT project_id, library_id, store_epoch, content_hash, \
                                        byte_length, operation_id, expires_at_unix_ms \
                                 FROM prepared_blob_receipts WHERE receipt_id = ?1",
                                [&receipt_id],
                                |row| {
                                    Ok((
                                        row.get::<_, String>(0)?,
                                        row.get::<_, String>(1)?,
                                        row.get::<_, String>(2)?,
                                        row.get::<_, String>(3)?,
                                        row.get::<_, i64>(4)?,
                                        row.get::<_, String>(5)?,
                                        row.get::<_, i64>(6)?,
                                    ))
                                },
                            )
                            .optional()?;
                        let expected = (
                            project_id.as_str(),
                            library_id.as_str(),
                            store_epoch.as_str(),
                            content_hash.as_str(),
                            byte_length,
                            operation_id.as_str(),
                        );
                        let Some((
                            existing_project_id,
                            existing_library_id,
                            existing_store_epoch,
                            existing_content_hash,
                            existing_byte_length,
                            existing_operation_id,
                            existing_expires_at_unix_ms,
                        )) = existing
                        else {
                            return Err(StoreError::new(
                                StoreErrorCode::StoreCorrupt,
                                "Prepared Blob receipt conflict could not be resolved",
                                false,
                            ));
                        };
                        let observed = (
                            existing_project_id.as_str(),
                            existing_library_id.as_str(),
                            existing_store_epoch.as_str(),
                            existing_content_hash.as_str(),
                            existing_byte_length,
                            existing_operation_id.as_str(),
                        );
                        if observed != expected {
                            return Err(StoreError::new(
                                StoreErrorCode::IdempotencyKeyReused,
                                "Prepared Blob idempotency slot is already bound to different bytes",
                                false,
                            ));
                        }
                        return Ok(PreparedBlobReceipt {
                            receipt_id,
                            blob_etag: content_hash,
                            byte_length: u64::try_from(byte_length).map_err(|_| {
                                StoreError::new(
                                    StoreErrorCode::StoreCorrupt,
                                    "Managed Blob length is invalid",
                                    false,
                                )
                            })?,
                            expires_at_unix_ms: u64::try_from(existing_expires_at_unix_ms)
                                .map_err(|_| {
                                    StoreError::new(
                                        StoreErrorCode::StoreCorrupt,
                                        "Prepared Blob expiry is invalid",
                                        false,
                                    )
                                })?,
                        });
                    }
                    Ok(PreparedBlobReceipt {
                        receipt_id,
                        blob_etag: content_hash,
                        byte_length: u64::try_from(byte_length).map_err(|_| {
                            StoreError::new(
                                StoreErrorCode::StoreCorrupt,
                                "Managed Blob length is invalid",
                                false,
                            )
                        })?,
                        expires_at_unix_ms: u64::try_from(expires_at_unix_ms).map_err(|_| {
                            StoreError::new(
                                StoreErrorCode::StoreCorrupt,
                                "Prepared Blob expiry is invalid",
                                false,
                            )
                        })?,
                    })
                })
            })
            .map_err(super::core_error)
    }

    /// Opportunistically removes a bounded batch of immutable Blobs that are
    /// absent from every retained File version and unexpired prepared receipt.
    /// Database reachability is removed before bytes, so interruption can only
    /// leave a harmless physical orphan.
    pub fn collect_unreachable_file_blobs(
        &self,
        limit: u32,
    ) -> Result<u64, nodex_core_contracts::CoreError> {
        let writer = self
            .writer
            .as_ref()
            .ok_or_else(|| super::invalid_input("The Library tracer has no Blob storage"))?;
        let root = self.file_blob_root()?;
        writer
            .call(move |connection| {
                crate::infrastructure::managed_blob_gc::collect(connection, &root, limit)
            })
            .map_err(super::core_error)
    }
}

fn require_project_in_library(
    connection: &Connection,
    library_id: &str,
    project_id: &str,
) -> Result<(), StoreError> {
    let exists = connection
        .query_row(
            "SELECT 1 FROM projects WHERE id = ?1 AND library_id = ?2 AND lifecycle = 'active'",
            params![project_id, library_id],
            |_| Ok(()),
        )
        .optional()?;
    exists.ok_or_else(|| {
        StoreError::new(
            StoreErrorCode::Unauthorized,
            "Prepared File Blob Project is unavailable",
            false,
        )
    })
}

fn sqlite_now_ms(connection: &Connection) -> Result<i64, StoreError> {
    connection
        .query_row(
            "SELECT CAST(strftime('%s', 'now') AS INTEGER) * 1000",
            [],
            |row| row.get(0),
        )
        .map_err(Into::into)
}

fn validate_id(value: &str, label: &str) -> Result<(), StoreError> {
    if value.is_empty()
        || value.len() > MAX_ID_BYTES
        || value.trim() != value
        || value.chars().any(char::is_control)
    {
        return Err(invalid(format!("{label} identity is invalid")));
    }
    Ok(())
}

fn validate_content_hash(value: &str) -> Result<(), StoreError> {
    if value.len() != SHA256_HEX_BYTES
        || !value
            .as_bytes()
            .iter()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(invalid("Managed Blob hash is invalid"));
    }
    Ok(())
}

fn validate_physical_name(value: &str) -> Result<(), StoreError> {
    if value.is_empty()
        || value.len() > 255
        || matches!(value, "." | "..")
        || value.contains(['/', '\\'])
        || value.chars().any(char::is_control)
    {
        return Err(invalid("Managed Blob physical name is invalid"));
    }
    Ok(())
}

fn invalid(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message, false)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::tempdir;

    use crate::infrastructure::store::SqliteStoreKernel;
    use crate::library::LibraryModule;

    #[test]
    fn blob_gc_respects_snapshot_lease_and_removes_only_unreachable_bytes() {
        let directory = tempdir().expect("Profile");
        let home = directory.path().canonicalize().expect("absolute Profile");
        let kernel = SqliteStoreKernel::open_test(&home).expect("fresh Store");
        let module = LibraryModule::new("profile-1", "library-1", &kernel);
        let root = module.file_blob_root().expect("Blob root");
        fs::create_dir_all(&root).expect("assets root");
        let hash = "d".repeat(64);
        fs::write(root.join(&hash), b"orphan").expect("orphan bytes");
        kernel
            .writer()
            .call({
                let hash = hash.clone();
                move |connection| {
                    connection.execute(
                        "INSERT INTO managed_blobs( \
                           content_hash, physical_asset_name, byte_length, created_at \
                         ) VALUES (?1, ?1, 6, '2026-08-28T00:00:00.000Z')",
                        [hash],
                    )?;
                    Ok(())
                }
            })
            .expect("orphan metadata");

        let snapshot = crate::infrastructure::managed_asset_snapshot::acquire_snapshot_lease()
            .expect("snapshot lease");
        assert_eq!(
            module.collect_unreachable_file_blobs(10).expect("yield GC"),
            0
        );
        assert!(root.join(&hash).is_file());
        drop(snapshot);

        assert_eq!(
            module
                .collect_unreachable_file_blobs(10)
                .expect("collect GC"),
            1
        );
        assert!(!root.join(&hash).exists());
    }
}
