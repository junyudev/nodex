use std::fs;
use std::path::PathBuf;

use nodex_core_contracts::library::LibraryPreparedPageFileBlob;
use nodex_core_contracts::{AdapterKind, BoundModuleContext};
use rusqlite::{Connection, OptionalExtension, params};

use crate::infrastructure::sqlite::{StoreError, StoreErrorCode, with_immediate_transaction};

use super::{LibraryModule, require_page_read_access};

const MAX_ID_BYTES: usize = 512;
const SHA256_HEX_BYTES: usize = 64;
const MAX_PREPARED_BLOB_LIFETIME_MS: u64 = 24 * 60 * 60 * 1_000;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PageFileBlobDescriptor {
    pub page_id: String,
    pub file_id: String,
    pub version: i64,
    pub logical_path: String,
    pub mime_type: String,
    pub byte_length: u64,
    pub blob_etag: String,
    pub physical_path: PathBuf,
}

impl LibraryModule {
    pub fn page_file_blob_root(&self) -> Result<PathBuf, nodex_core_contracts::CoreError> {
        self.assets_root
            .clone()
            .ok_or_else(|| super::invalid_input("the Library tracer has no Blob storage"))
    }

    #[allow(clippy::too_many_arguments)]
    pub fn register_prepared_page_file_blob(
        &self,
        context: &BoundModuleContext,
        expected_store_epoch: &str,
        operation_id: &str,
        receipt_id: &str,
        content_hash: &str,
        physical_asset_name: &str,
        byte_length: u64,
        expires_at_unix_ms: u64,
    ) -> Result<LibraryPreparedPageFileBlob, nodex_core_contracts::CoreError> {
        self.validate_context(context)?;
        validate_id(operation_id, "Operation").map_err(super::core_error)?;
        validate_id(receipt_id, "Prepared Blob receipt").map_err(super::core_error)?;
        validate_content_hash(content_hash).map_err(super::core_error)?;
        validate_physical_name(physical_asset_name).map_err(super::core_error)?;
        let byte_length = i64::try_from(byte_length)
            .map_err(|_| super::invalid_input("Page File Blob exceeds the Store length bound"))?;
        let expires_at_unix_ms = i64::try_from(expires_at_unix_ms).map_err(|_| {
            super::invalid_input("Prepared Page File Blob expiry exceeds the Store bound")
        })?;
        let writer = self.writer.as_ref().ok_or_else(|| {
            super::invalid_input("the Library tracer cannot prepare Page File Blobs")
        })?;
        let library_id = self.library_id.clone();
        let context = context.clone();
        let blob_root = self.page_file_blob_root()?;
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
                            "Prepared Page File Blob targets a stale Store epoch",
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
                                "Prepared Page File Blobs require trusted local Library authority",
                                false,
                            ));
                        }
                    };
                    let published_path = blob_root.join(&physical_asset_name);
                    let published = fs::symlink_metadata(&published_path).map_err(|_| {
                        StoreError::new(
                            StoreErrorCode::StoreCorrupt,
                            "Prepared Page File Blob bytes are unavailable",
                            false,
                        )
                    })?;
                    if published.file_type().is_symlink()
                        || !published.is_file()
                        || published.len() != u64::try_from(byte_length).unwrap_or(u64::MAX)
                    {
                        return Err(StoreError::new(
                            StoreErrorCode::StoreCorrupt,
                            "Prepared Page File Blob bytes do not match their receipt",
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
                        return Err(invalid("Prepared Page File Blob expiry is invalid"));
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
                        return Ok(LibraryPreparedPageFileBlob {
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
                    Ok(LibraryPreparedPageFileBlob {
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
    pub fn collect_unreachable_page_file_blobs(
        &self,
        limit: u32,
    ) -> Result<u64, nodex_core_contracts::CoreError> {
        if limit == 0 || limit > 1_000 {
            return Err(super::invalid_input(
                "Page File Blob GC limit must be between 1 and 1000",
            ));
        }
        let writer = self.writer.as_ref().ok_or_else(|| {
            super::invalid_input("the Library tracer cannot collect Page File Blobs")
        })?;
        let root = self.page_file_blob_root()?;
        writer
            .call(move |connection| {
                let Some(_lease) =
                    crate::infrastructure::managed_asset_snapshot::try_acquire_gc_lease()?
                else {
                    return Ok(0_u64);
                };
                let candidates = with_immediate_transaction(connection, |transaction| {
                    let now_ms = sqlite_now_ms(transaction)?;
                    transaction.execute(
                        "DELETE FROM prepared_blob_receipts \
                         WHERE state = 'prepared' AND expires_at_unix_ms < ?1",
                        [now_ms],
                    )?;
                    let mut statement = transaction.prepare(
                        "SELECT blob.content_hash, blob.physical_asset_name \
                         FROM managed_blobs blob \
                         WHERE NOT EXISTS ( \
                           SELECT 1 FROM page_file_versions version \
                           WHERE version.blob_hash = blob.content_hash \
                         ) AND NOT EXISTS ( \
                           SELECT 1 FROM document_recovery_asset_roots recovery \
                           WHERE recovery.asset_hash = blob.content_hash \
                         ) AND NOT EXISTS ( \
                           SELECT 1 FROM prepared_blob_receipts receipt \
                           WHERE receipt.content_hash = blob.content_hash \
                             AND receipt.state = 'prepared' \
                             AND receipt.expires_at_unix_ms >= ?1 \
                         ) ORDER BY blob.created_at, blob.content_hash LIMIT ?2",
                    )?;
                    let candidates = statement
                        .query_map(params![now_ms, limit], |row| {
                            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                        })?
                        .collect::<rusqlite::Result<Vec<_>>>()?;
                    drop(statement);
                    for (content_hash, _) in &candidates {
                        transaction.execute(
                            "DELETE FROM managed_blobs WHERE content_hash = ?1",
                            [content_hash],
                        )?;
                    }
                    Ok(candidates)
                })?;
                for (_, physical_name) in &candidates {
                    validate_physical_name(physical_name)?;
                    let path = root.join(physical_name);
                    match fs::remove_file(&path) {
                        Ok(()) => {}
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                        Err(error) => {
                            return Err(StoreError::new(
                                StoreErrorCode::Internal,
                                format!("Page File Blob GC failed: {error}"),
                                true,
                            ));
                        }
                    }
                }
                if !candidates.is_empty() {
                    fs::File::open(&root)
                        .and_then(|directory| directory.sync_all())
                        .map_err(|error| {
                            StoreError::new(
                                StoreErrorCode::Internal,
                                format!("Page File Blob directory sync failed: {error}"),
                                true,
                            )
                        })?;
                }
                u64::try_from(candidates.len())
                    .map_err(|_| invalid("Page File Blob GC count overflowed"))
            })
            .map_err(super::core_error)
    }

    pub fn resolve_page_file_blob(
        &self,
        context: &BoundModuleContext,
        page_id: &str,
        file_id: &str,
        version: Option<i64>,
    ) -> Result<PageFileBlobDescriptor, nodex_core_contracts::CoreError> {
        self.validate_context(context)?;
        validate_id(page_id, "Page").map_err(super::core_error)?;
        validate_id(file_id, "Page File").map_err(super::core_error)?;
        if version.is_some_and(|version| version < 1) {
            return Err(super::invalid_input(
                "Page File Blob version must be positive",
            ));
        }
        let readers = self.readers.as_ref().ok_or_else(|| {
            super::invalid_input("the Library tracer cannot resolve Page File Blobs")
        })?;
        let library_id = self.library_id.clone();
        let context = context.clone();
        let page_id = page_id.to_owned();
        let file_id = file_id.to_owned();
        let queried_page_id = page_id.clone();
        let queried_file_id = file_id.clone();
        let root = self.page_file_blob_root()?;
        let descriptor = readers
            .read_default(move |connection| {
                authorize_page_read(connection, &context, &library_id, &queried_page_id)?;
                let row = if let Some(version) = version {
                    super::page_files::require_owned_file_access(
                        connection,
                        &library_id,
                        &queried_page_id,
                        &queried_file_id,
                    )?;
                    connection
                        .query_row(
                            "SELECT version.version, version.logical_path, version.mime_type, \
                                    version.byte_length, version.blob_hash, blob.physical_asset_name \
                             FROM page_file_versions version \
                             JOIN managed_blobs blob ON blob.content_hash = version.blob_hash \
                               AND blob.byte_length = version.byte_length \
                             WHERE version.library_id = ?1 AND version.owner_page_id = ?2 \
                               AND version.file_id = ?3 AND version.version = ?4 \
                               AND version.blob_hash IS NOT NULL",
                            params![library_id, queried_page_id, queried_file_id, version],
                            blob_row,
                        )
                        .optional()?
                } else {
                    super::page_files::require_current_file_access(
                        connection,
                        &library_id,
                        &queried_page_id,
                        &queried_file_id,
                    )?;
                    connection
                        .query_row(
                            "SELECT version.version, version.logical_path, version.mime_type, \
                                    version.byte_length, version.blob_hash, blob.physical_asset_name \
                             FROM page_files file \
                             JOIN page_file_versions version ON version.file_id = file.file_id \
                               AND version.version = file.current_version \
                             JOIN managed_blobs blob ON blob.content_hash = version.blob_hash \
                               AND blob.byte_length = version.byte_length \
                             WHERE file.library_id = ?1 AND file.file_id = ?2 \
                               AND file.state = 'live'",
                            params![library_id, queried_file_id],
                            blob_row,
                        )
                        .optional()?
                };
                row.ok_or_else(|| {
                    StoreError::new(
                        StoreErrorCode::NotFound,
                        "Page File Blob is unavailable",
                        false,
                    )
                })
            })
            .map_err(super::core_error)?;
        let physical_path = root.join(&descriptor.physical_asset_name);
        let metadata = fs::symlink_metadata(&physical_path).map_err(|_| {
            super::core_error(StoreError::new(
                StoreErrorCode::StoreCorrupt,
                "Managed Blob bytes are missing",
                false,
            ))
        })?;
        if !metadata.is_file()
            || metadata.file_type().is_symlink()
            || metadata.len() != descriptor.byte_length
        {
            return Err(super::core_error(StoreError::new(
                StoreErrorCode::StoreCorrupt,
                "Managed Blob physical state is invalid",
                false,
            )));
        }
        Ok(PageFileBlobDescriptor {
            page_id,
            file_id,
            version: descriptor.version,
            logical_path: descriptor.logical_path,
            mime_type: descriptor.mime_type,
            byte_length: descriptor.byte_length,
            blob_etag: descriptor.blob_etag,
            physical_path,
        })
    }
}

struct BlobRow {
    version: i64,
    logical_path: String,
    mime_type: String,
    byte_length: u64,
    blob_etag: String,
    physical_asset_name: String,
}

fn blob_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<BlobRow> {
    let byte_length = row.get::<_, i64>(3)?;
    Ok(BlobRow {
        version: row.get(0)?,
        logical_path: row.get(1)?,
        mime_type: row.get(2)?,
        byte_length: u64::try_from(byte_length)
            .map_err(|_| rusqlite::Error::IntegralValueOutOfRange(3, byte_length))?,
        blob_etag: row.get(4)?,
        physical_asset_name: row.get(5)?,
    })
}

fn authorize_page_read(
    connection: &Connection,
    context: &BoundModuleContext,
    library_id: &str,
    page_id: &str,
) -> Result<(), StoreError> {
    if let Some(project_id) = context.project_id.as_ref() {
        return require_page_read_access(connection, library_id, &project_id.0, page_id);
    }
    if matches!(
        context.adapter,
        AdapterKind::ElectronHost | AdapterKind::NativeCli | AdapterKind::Test
    ) {
        let exists = connection
            .query_row(
                "SELECT 1 FROM pages page \
                 JOIN blocks block ON block.id = page.block_id \
                   AND block.library_id = page.library_id \
                 WHERE page.block_id = ?1 AND page.library_id = ?2 \
                   AND block.type = 'page' AND block.lifecycle = 'active'",
                params![page_id, library_id],
                |_| Ok(()),
            )
            .optional()?;
        return exists.ok_or_else(|| {
            StoreError::new(StoreErrorCode::NotFound, "Page is unavailable", false)
        });
    }
    Err(StoreError::new(
        StoreErrorCode::Unauthorized,
        "Page File Blob requires Page read access",
        false,
    ))
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
            "Prepared Page File Blob Project is unavailable",
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
        let root = module.page_file_blob_root().expect("Blob root");
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
            module
                .collect_unreachable_page_file_blobs(10)
                .expect("yield GC"),
            0
        );
        assert!(root.join(&hash).is_file());
        drop(snapshot);

        assert_eq!(
            module
                .collect_unreachable_page_file_blobs(10)
                .expect("collect GC"),
            1
        );
        assert!(!root.join(&hash).exists());
    }
}
