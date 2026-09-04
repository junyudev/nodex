//! Transaction-bound publication receipts shared by durable content owners.
use super::sqlite::{StoreError, StoreErrorCode};
use rusqlite::{Connection, OptionalExtension, params};

pub(crate) struct PreparedBlob {
    pub(crate) receipt_id: String,
    pub(crate) content_hash: String,
    pub(crate) byte_length: u64,
}

pub(crate) fn read_receipt(
    connection: &Connection,
    store_epoch: &str,
    library_id: &str,
    project_id: &str,
    operation_id: &str,
    receipt_id: &str,
) -> Result<PreparedBlob, StoreError> {
    if receipt_id.is_empty()
        || receipt_id.len() > 512
        || receipt_id.trim() != receipt_id
        || receipt_id.chars().any(char::is_control)
    {
        return Err(StoreError::new(
            StoreErrorCode::InvalidInput,
            "Prepared Blob receipt identity is invalid",
            false,
        ));
    }
    connection
        .query_row(
            "SELECT receipt.receipt_id, receipt.content_hash, receipt.byte_length \
             FROM prepared_blob_receipts receipt \
             JOIN managed_blobs blob ON blob.content_hash = receipt.content_hash \
               AND blob.byte_length = receipt.byte_length \
             WHERE receipt.receipt_id = ?1 AND receipt.project_id = ?2 \
               AND receipt.library_id = ?3 AND receipt.store_epoch = ?4 \
               AND receipt.operation_id = ?5 AND receipt.state = 'prepared' \
               AND receipt.expires_at_unix_ms >= \
                 CAST(strftime('%s', 'now') AS INTEGER) * 1000",
            params![
                receipt_id,
                project_id,
                library_id,
                store_epoch,
                operation_id
            ],
            |row| {
                let byte_length = row.get::<_, i64>(2)?;
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    byte_length,
                ))
            },
        )
        .optional()?
        .map(|(receipt_id, content_hash, byte_length)| {
            Ok::<PreparedBlob, StoreError>(PreparedBlob {
                receipt_id,
                content_hash,
                byte_length: u64::try_from(byte_length).map_err(|_| {
                    StoreError::new(
                        StoreErrorCode::StoreCorrupt,
                        "Prepared Blob length is invalid",
                        false,
                    )
                })?,
            })
        })
        .transpose()?
        .ok_or_else(|| {
            StoreError::new(
                StoreErrorCode::NotFound,
                "Prepared Blob receipt is unavailable",
                false,
            )
        })
}

pub(crate) fn consume(
    connection: &Connection,
    receipt_id: &str,
    commit_seq: i64,
    now: &str,
) -> Result<(), StoreError> {
    let consumed = connection.execute(
        "UPDATE prepared_blob_receipts SET state = 'consumed', consumed_commit_seq = ?1, updated_at = ?2 WHERE receipt_id = ?3 AND state = 'prepared'",
        params![commit_seq, now, receipt_id],
    )?;
    if consumed != 1 {
        return Err(StoreError::new(
            StoreErrorCode::Conflict,
            "Prepared Blob receipt is no longer available",
            false,
        ));
    }
    Ok(())
}
