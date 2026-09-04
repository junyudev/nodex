//! Profile-wide physical collection. Domain owners release their concrete roots;
//! no Page inventory or generic reference counter decides byte lifetime.
use super::sqlite::{StoreError, StoreErrorCode, with_immediate_transaction};
use rusqlite::params;
use std::{fs, path::Path};

pub(crate) fn collect(
    connection: &mut rusqlite::Connection,
    root: &Path,
    limit: u32,
) -> Result<u64, StoreError> {
    if !(1..=1000).contains(&limit) {
        return Err(StoreError::new(
            StoreErrorCode::InvalidInput,
            "Blob GC limit must be between 1 and 1000",
            false,
        ));
    }
    let Some(_lease) = crate::infrastructure::managed_asset_snapshot::try_acquire_gc_lease()?
    else {
        return Ok(0_u64);
    };
    let candidates = with_immediate_transaction(connection, |transaction| {
        let now_ms = transaction.query_row(
            "SELECT CAST(strftime('%s', 'now') AS INTEGER) * 1000",
            [],
            |row| row.get::<_, i64>(0),
        )?;
        transaction.execute(
            "DELETE FROM prepared_blob_receipts \
                         WHERE state = 'prepared' AND expires_at_unix_ms < ?1",
            [now_ms],
        )?;
        let mut statement = transaction.prepare(
                        "SELECT blob.content_hash, blob.physical_asset_name \
                         FROM managed_blobs blob \
                         WHERE NOT EXISTS ( \
                           SELECT 1 FROM file_versions version \
                           WHERE version.blob_hash = blob.content_hash \
                         ) AND NOT EXISTS ( \
                           SELECT 1 FROM document_recovery_asset_roots recovery \
                           WHERE recovery.asset_hash = blob.content_hash \
                         ) AND NOT EXISTS ( \
                           SELECT 1 FROM block_asset_refs reference WHERE reference.asset_hash = blob.content_hash \
                         ) AND NOT EXISTS ( \
                           SELECT 1 FROM canvas_scene_file_refs reference WHERE reference.asset_hash = blob.content_hash \
                         ) AND NOT EXISTS ( \
                           SELECT 1 FROM structural_retention_members reference WHERE reference.member_kind = 'asset' AND reference.member_id = blob.content_hash \
                         ) AND NOT EXISTS ( \
                           SELECT 1 FROM codex_queued_follow_up_payload_manifests payload WHERE payload.payload_sha256 = blob.content_hash \
                         ) AND NOT EXISTS ( \
                           SELECT 1 FROM codex_queued_follow_up_payload_asset_refs reference WHERE reference.sha256 = blob.content_hash \
                         ) AND NOT EXISTS ( \
                           SELECT 1 FROM codex_thread_asset_refs reference WHERE reference.blob_hash = blob.content_hash \
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
            // Durable operation receipts already own replay. A consumed
            // upload receipt must not keep an otherwise unowned Blob alive.
            transaction.execute(
                "DELETE FROM prepared_blob_receipts WHERE content_hash = ?1 AND state = 'consumed'",
                [content_hash],
            )?;
            transaction.execute(
                "DELETE FROM managed_blobs WHERE content_hash = ?1",
                [content_hash],
            )?;
        }
        Ok(candidates)
    })?;
    for (_, physical_name) in &candidates {
        super::managed_blobs::validate_physical_name(physical_name)?;
        let path = root.join(physical_name);
        match fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(StoreError::new(
                    StoreErrorCode::Internal,
                    format!("Blob GC failed: {error}"),
                    true,
                ));
            }
        }
    }
    if !candidates.is_empty() {
        fs::File::open(root)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| {
                StoreError::new(
                    StoreErrorCode::Internal,
                    format!("Blob directory sync failed: {error}"),
                    true,
                )
            })?;
    }
    u64::try_from(candidates.len())
        .map_err(|_| StoreError::new(StoreErrorCode::Internal, "Blob GC count overflowed", false))
}
