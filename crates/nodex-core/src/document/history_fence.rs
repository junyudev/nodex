use std::collections::BTreeSet;

use nodex_core_contracts::document::DocumentHistoryFence;
use rusqlite::{Connection, params};

use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

const MAX_BARRIERS: usize = 512;
const MAX_IDS: usize = 512;
const MAX_ID_BYTES: usize = 16 * 1024;

/// Uses the same durable fences that reject stale writes. Bounds both the query
/// and wire evidence; overflow requires guarded semantic replay, never a reset.
pub(crate) fn read(
    connection: &Connection,
    document_id: &str,
    generation: i64,
    after_head_seq: i64,
    through_head_seq: i64,
) -> Result<DocumentHistoryFence, StoreError> {
    if after_head_seq < 0 || after_head_seq > through_head_seq {
        return Err(StoreError::new(
            StoreErrorCode::InvalidInput,
            "History fence head is invalid",
            false,
        ));
    }
    let rows = connection
        .prepare(
            "SELECT block_ids_json, document_wide_fence FROM document_structural_barriers \
         WHERE document_id = ?1 AND generation = ?2 AND head_seq > ?3 AND head_seq <= ?4 \
         ORDER BY head_seq LIMIT ?5",
        )?
        .query_map(
            params![
                document_id,
                generation,
                after_head_seq,
                through_head_seq,
                (MAX_BARRIERS + 1) as i64
            ],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, bool>(1)?)),
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut block_ids = BTreeSet::new();
    let mut bytes = 2;
    let mut document_wide = rows.len() > MAX_BARRIERS;
    for (encoded, wide) in rows {
        if document_wide || wide || encoded.len() > MAX_ID_BYTES {
            document_wide = true;
            break;
        }
        let ids: Vec<String> = serde_json::from_str(&encoded).map_err(|_| {
            StoreError::new(
                StoreErrorCode::StoreCorrupt,
                "History fence identities are invalid",
                false,
            )
        })?;
        for id in ids {
            if block_ids.insert(id.clone()) {
                bytes += serde_json::to_string(&id)
                    .map_err(|_| {
                        StoreError::new(
                            StoreErrorCode::Internal,
                            "History identity encoding failed",
                            false,
                        )
                    })?
                    .len()
                    + 1;
            }
        }
        if block_ids.len() > MAX_IDS || bytes > MAX_ID_BYTES {
            document_wide = true;
            break;
        }
    }
    Ok(DocumentHistoryFence {
        head_seq: through_head_seq,
        block_ids: if document_wide {
            Vec::new()
        } else {
            block_ids.into_iter().collect()
        },
        document_wide,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE document_structural_barriers (
          document_id TEXT, generation INTEGER, head_seq INTEGER,
          block_ids_json TEXT, document_wide_fence INTEGER
        );",
            )
            .unwrap();
        connection
    }

    fn add(connection: &Connection, document: &str, generation: i64, head: i64, ids: &[String]) {
        connection
            .execute(
                "INSERT INTO document_structural_barriers VALUES (?1, ?2, ?3, ?4, 0)",
                params![
                    document,
                    generation,
                    head,
                    serde_json::to_string(ids).unwrap()
                ],
            )
            .unwrap();
    }

    #[test]
    fn exact_interval_deduplicates_identities_without_crossing_document_or_generation() {
        let connection = store();
        add(&connection, "document", 1, 1, &["old".into()]);
        add(&connection, "document", 1, 2, &["moved".into()]);
        add(
            &connection,
            "document",
            1,
            3,
            &["moved".into(), "restored".into()],
        );
        add(&connection, "document", 1, 4, &["future".into()]);
        add(&connection, "other", 1, 2, &["foreign".into()]);
        add(&connection, "document", 2, 2, &["generation".into()]);
        assert_eq!(
            read(&connection, "document", 1, 1, 3).unwrap(),
            DocumentHistoryFence {
                head_seq: 3,
                block_ids: vec!["moved".into(), "restored".into()],
                document_wide: false,
            }
        );
        assert!(
            read(&connection, "document", 1, 3, 3)
                .unwrap()
                .block_ids
                .is_empty()
        );
        assert!(read(&connection, "document", 1, 4, 3).is_err());
    }

    #[test]
    fn bounds_evidence_by_identity_count_bytes_and_barrier_count() {
        for ids in [
            (0..513).map(|i| format!("block:{i}")).collect::<Vec<_>>(),
            (0..40)
                .map(|i| format!("{i}:{}", "x".repeat(500)))
                .collect(),
        ] {
            let connection = store();
            add(&connection, "document", 1, 1, &ids);
            let fence = read(&connection, "document", 1, 0, 1).unwrap();
            assert!(fence.document_wide);
            assert!(fence.block_ids.is_empty());
        }
        let connection = store();
        for head in 1..=513 {
            add(&connection, "document", 1, head, &["block".into()]);
        }
        assert!(
            read(&connection, "document", 1, 0, 513)
                .unwrap()
                .document_wide
        );
        assert!(
            !read(&connection, "document", 1, 1, 513)
                .unwrap()
                .document_wide
        );
    }
}
