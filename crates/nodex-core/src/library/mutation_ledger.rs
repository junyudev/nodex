//! Operation identity survives independently of redundant historical bodies.

use rusqlite::{Connection, OptionalExtension, params};

use crate::infrastructure::sqlite::StoreError;

fn compact_artifact(connection: &Connection, id: &str, now_ms: i64) -> Result<usize, StoreError> {
    // No current read/recovery/preview Interface consumes these two columns.
    // Nonetheless, retain old copies until receipt and live-capability owners
    // end. Page History fields and Property exact-comparison bodies never move.
    let bytes: Option<i64> = connection.query_row(
        "SELECT octet_length(request_json) + octet_length(result_json) - 4 \
         FROM block_mutations WHERE mutation_id = ?1 \
           AND mutation_kind IN ('structural_edit', 'block_transfer') AND result_json <> '{}' \
           AND CAST(unixepoch(recorded_at, 'subsec') * 1000 AS INTEGER) <= ?2 \
           AND NOT EXISTS(SELECT 1 FROM core_module_receipts WHERE module_name = 'library' AND operation_id = ?1) \
           AND NOT EXISTS(SELECT 1 FROM detached_module_receipts WHERE module_name = 'library' AND operation_id = ?1) \
           AND NOT EXISTS(SELECT 1 FROM structural_history_recipes WHERE recipe_operation_id = ?1 AND state = 'available') \
           AND NOT EXISTS(SELECT 1 FROM editor_history_recipes WHERE recipe_operation_id = ?1) \
           AND NOT EXISTS(SELECT 1 FROM structural_retention_members WHERE authority_kind = 'history_recipe' AND authority_id = ?1) \
           AND NOT EXISTS(SELECT 1 FROM block_transfer_undo_recipes WHERE transfer_operation_id = ?1 AND consumed_at IS NULL) \
           AND NOT EXISTS(SELECT 1 FROM structural_clipboard_bundles WHERE capture_operation_id = ?1) \
           AND NOT EXISTS(SELECT 1 FROM structural_cut_claims WHERE delete_recipe_operation_id = ?1 AND state = 'available')",
        params![id, now_ms.saturating_sub(crate::infrastructure::module_receipts::RECEIPT_RETENTION_MS)],
        |row| row.get(0),
    ).optional()?;
    let Some(bytes) = bytes else { return Ok(0) };
    crate::infrastructure::request_execution::check_request_interruption()?;
    connection.execute(
        "UPDATE block_mutations SET request_json = '{}', result_json = '{}' WHERE mutation_id = ?1",
        [id],
    )?;
    Ok(bytes.max(0) as usize)
}

/// Historical discovery visits each ledger identity once. Its cursor and queue
/// publication commit together, independently of potentially large row rewrites.
pub(super) fn backfill_one(connection: &Connection) -> Result<bool, StoreError> {
    let (after, complete): (String, bool) = connection.query_row(
        "SELECT after_mutation_id, complete FROM block_mutation_body_backfill WHERE id = 1",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    if complete {
        return Ok(false);
    }
    let next = connection.query_row(
        "SELECT mutation_id, mutation_kind IN ('structural_edit', 'block_transfer') AND result_json <> '{}' \
         FROM block_mutations WHERE mutation_id > ?1 ORDER BY mutation_id LIMIT 1",
        [&after], |row| Ok((row.get::<_, String>(0)?, row.get::<_, bool>(1)?)),
    ).optional()?;
    let Some((id, redundant)) = next else {
        connection.execute(
            "UPDATE block_mutation_body_backfill SET complete = 1 WHERE id = 1",
            [],
        )?;
        return Ok(false);
    };
    if redundant {
        connection.execute(
            "INSERT OR IGNORE INTO block_mutation_body_gc(mutation_id) VALUES (?1)",
            [&id],
        )?;
    }
    connection.execute(
        "UPDATE block_mutation_body_backfill SET after_mutation_id = ?1 WHERE id = 1",
        [&id],
    )?;
    Ok(true)
}

#[derive(Debug, Default)]
pub(super) struct Cleanup {
    pub bytes: usize,
    pub pending: bool,
}

/// Rewriting one old inline artifact is a cold conversion cost, not a short
/// chunk slice. New writes have no redundant bodies and never enter this queue.
pub(super) fn collect_one(connection: &Connection, now_ms: i64) -> Result<Cleanup, StoreError> {
    let next = connection
        .query_row(
            "SELECT mutation_id FROM block_mutation_body_gc WHERE check_after_ms <= ?1 \
         ORDER BY check_after_ms, mutation_id LIMIT 1",
            [now_ms],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    let Some(id) = next else {
        return Ok(Cleanup::default());
    };
    let bytes = compact_artifact(connection, &id, now_ms)?;
    connection.execute(
        "DELETE FROM block_mutation_body_gc WHERE mutation_id = ?1 AND NOT EXISTS \
         (SELECT 1 FROM block_mutations WHERE mutation_id = ?1 AND result_json <> '{}')",
        [&id],
    )?;
    // A retained prefix cannot hide eligible candidates. Receipt retirement or
    // owner release needs no broad queue rescan or exact-time coupling.
    connection.execute(
        "UPDATE block_mutation_body_gc SET check_after_ms = ?1 WHERE mutation_id = ?2",
        params![now_ms.saturating_add(30_000), id],
    )?;
    Ok(Cleanup {
        bytes,
        pending: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const CREATED: &str = "2026-01-01T00:00:00Z";
    const HASH: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn fixture_at(path: &std::path::Path) -> Connection {
        let mut connection = Connection::open(path).unwrap();
        crate::infrastructure::schema::install_current_schema(&mut connection).unwrap();
        connection
            .pragma_update(None, "foreign_keys", false)
            .unwrap();
        connection
            .execute(
                "INSERT INTO block_store_metadata VALUES (1, 'epoch', ?1, ?1)",
                [CREATED],
            )
            .unwrap();
        let request =
            serde_json::json!({ "kind": "replace_selection", "body": "正文".repeat(100_000) })
                .to_string();
        for (id, kind) in [
            ("a-retained", "structural_edit"),
            ("structural", "structural_edit"),
            ("property", "property_batch"),
            ("transfer", "block_transfer"),
        ] {
            connection.execute(
                "INSERT INTO change_log(project_id, store_epoch, kind, operation_id, payload_json, committed_at, projection_impact_json) \
                 VALUES ('project', 'epoch', 'block_mutation', ?1, '{\"requestHash\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}', ?2, '{}')",
                params![id, CREATED],
            ).unwrap();
            let seq = connection.last_insert_rowid();
            connection.execute(
                "INSERT INTO block_mutations(mutation_id, project_id, store_epoch, mutation_kind, actor_json, request_hash, request_json, \
                 field_intents_json, outcome, result_json, change_log_seq, recorded_at) \
                 VALUES (?1, 'project', 'epoch', ?2, '{\"kind\":\"editor\"}', ?3, ?4, \
                 '[{\"path\":\"title\",\"operation\":\"set\"}]', 'committed', ?4, ?5, ?6)",
                params![id, kind, HASH, request, seq, CREATED],
            ).unwrap();
        }
        connection
    }

    fn evidence(connection: &Connection) -> String {
        connection.query_row(
            "SELECT json_group_array(json_array(mutation_id, project_id, store_epoch, mutation_kind, actor_json, \
             client_session_id, request_hash, target_block_ids_json, affected_document_ids_json, \
             affected_database_block_ids_json, field_intents_json, expected_revisions_json, outcome, \
             committed_revisions_json, document_heads_json, change_log_seq, recorded_at)) \
             FROM (SELECT * FROM block_mutations ORDER BY mutation_id)",
            [], |row| row.get(0),
        ).unwrap()
    }

    #[test]
    fn ledger_collection_preserves_receipts_active_capabilities_and_durable_evidence() {
        let connection = fixture_at(std::path::Path::new(":memory:"));
        let original_evidence = evidence(&connection);
        let property: String = connection
            .query_row(
                "SELECT request_json FROM block_mutations WHERE mutation_id = 'property'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let created_ms: i64 = connection
            .query_row(
                "SELECT CAST(unixepoch(?1, 'subsec') * 1000 AS INTEGER)",
                [CREATED],
                |row| row.get(0),
            )
            .unwrap();
        let now = created_ms + crate::infrastructure::module_receipts::RECEIPT_RETENTION_MS;
        assert_eq!(
            compact_artifact(&connection, "structural", now - 1).unwrap(),
            0
        );
        connection.execute("INSERT INTO core_module_receipts(module_name, operation_id, profile_id, adapter_kind, operation_kind, store_epoch, request_hash, result_json, committed_at) VALUES ('library', 'structural', 'profile', 'test', 'structural_edit', 'epoch', ?1, '{}', ?2)", params![HASH, CREATED]).unwrap();
        assert_eq!(compact_artifact(&connection, "structural", now).unwrap(), 0);
        connection
            .execute("DELETE FROM core_module_receipts", [])
            .unwrap();
        connection.execute("INSERT INTO detached_module_receipts(module_name, operation_id, profile_id, adapter_kind, operation_kind, store_epoch, request_hash, result_json, committed_at, local_commit_seq, commit_manifest_hash, detached_at_ms) VALUES ('library', 'structural', 'profile', 'test', 'structural_edit', 'epoch', ?1, '{}', ?2, 1, ?1, 1)", params![HASH, CREATED]).unwrap();
        assert_eq!(compact_artifact(&connection, "structural", now).unwrap(), 0);
        connection
            .execute("DELETE FROM detached_module_receipts", [])
            .unwrap();
        connection.execute("INSERT INTO structural_history_recipes(recipe_operation_id, library_id, project_id, store_epoch, recipe_hash, payload_ref_json, state, created_at) VALUES ('structural', 'library', 'project', 'epoch', ?1, '{\"kind\":\"detached\"}', 'available', ?2)", params![HASH, CREATED]).unwrap();
        assert_eq!(compact_artifact(&connection, "structural", now).unwrap(), 0);
        connection.execute("UPDATE structural_history_recipes SET state = 'consumed', consumed_at = ?1 WHERE recipe_operation_id = 'structural'", [CREATED]).unwrap();
        connection.execute("INSERT INTO structural_clipboard_bundles(bundle_id, capture_operation_id, library_id, store_epoch, capability_hash, manifest_hash, snapshot_json, created_at) VALUES ('bundle', 'structural', 'library', 'epoch', ?1, ?1, '{}', ?2)", params![HASH, CREATED]).unwrap();
        assert_eq!(compact_artifact(&connection, "structural", now).unwrap(), 0);
        connection
            .execute("DELETE FROM structural_clipboard_bundles", [])
            .unwrap();
        assert!(compact_artifact(&connection, "structural", now).unwrap() > 1_000_000);
        assert_eq!(compact_artifact(&connection, "structural", now).unwrap(), 0);
        assert_eq!(compact_artifact(&connection, "property", now).unwrap(), 0);
        connection.execute("INSERT INTO block_transfer_undo_recipes(transfer_operation_id, project_id, library_id, store_epoch, recipe_hash, recipe_json, created_at) VALUES ('transfer', 'project', 'library', 'epoch', ?1, '{}', ?2)", params![HASH, CREATED]).unwrap();
        assert_eq!(compact_artifact(&connection, "transfer", now).unwrap(), 0);
        connection.execute("UPDATE block_transfer_undo_recipes SET consumed_at = ?1 WHERE transfer_operation_id = 'transfer'", [CREATED]).unwrap();
        assert!(compact_artifact(&connection, "transfer", now).unwrap() > 1_000_000);
        for assignment in [
            "client_session_id = 'different'",
            "actor_json = '{}'",
            "request_hash = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'",
        ] {
            assert!(connection.execute(&format!("UPDATE block_mutations SET request_json = '{{}}', result_json = '{{}}', {assignment} WHERE mutation_id = 'structural'"), []).is_err());
        }
        assert!(connection.execute("UPDATE block_mutations SET request_json = '{}', result_json = '{}' WHERE mutation_id = 'property'", []).is_err());
        assert_eq!(evidence(&connection), original_evidence);
        assert_eq!(
            connection
                .query_row(
                    "SELECT request_json FROM block_mutations WHERE mutation_id = 'property'",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            property
        );
    }

    #[test]
    fn ledger_collection_resumes_committed_discovery_and_rotates_past_retained_entries() {
        use crate::infrastructure::sqlite::with_immediate_transaction;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("ledger.db");
        let mut connection = fixture_at(&path);
        connection
            .execute("UPDATE block_mutation_body_backfill SET complete = 0", [])
            .unwrap();
        connection.execute_batch("BEGIN IMMEDIATE").unwrap();
        assert!(backfill_one(&connection).unwrap());
        connection.execute_batch("ROLLBACK").unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT after_mutation_id FROM block_mutation_body_backfill",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            ""
        );
        assert_eq!(
            connection
                .query_row("SELECT count(*) FROM block_mutation_body_gc", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert!(
            with_immediate_transaction(&mut connection, |transaction| backfill_one(transaction))
                .unwrap()
        );
        drop(connection);
        let mut connection = Connection::open(&path).unwrap();
        connection
            .pragma_update(None, "foreign_keys", false)
            .unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT after_mutation_id FROM block_mutation_body_backfill",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "a-retained"
        );
        while with_immediate_transaction(&mut connection, |transaction| backfill_one(transaction))
            .unwrap()
        {}
        let queued = connection
            .prepare("SELECT mutation_id FROM block_mutation_body_gc ORDER BY mutation_id")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(queued, ["a-retained", "structural", "transfer"]);
        connection.execute("INSERT INTO core_module_receipts(module_name, operation_id, profile_id, adapter_kind, operation_kind, store_epoch, request_hash, result_json, committed_at) VALUES ('library', 'a-retained', 'profile', 'test', 'structural_edit', 'epoch', ?1, '{}', ?2)", params![HASH, CREATED]).unwrap();
        let now = 1_800_000_000_000;
        let before_freelist: i64 = connection
            .query_row("PRAGMA freelist_count", [], |row| row.get(0))
            .unwrap();
        assert_eq!(
            with_immediate_transaction(&mut connection, |transaction| collect_one(
                transaction,
                now
            ))
            .unwrap()
            .bytes,
            0
        );
        connection.execute_batch("BEGIN IMMEDIATE").unwrap();
        assert!(collect_one(&connection, now).unwrap().bytes > 1_000_000);
        connection.execute_batch("ROLLBACK").unwrap();
        for _ in 0..2 {
            assert!(
                with_immediate_transaction(&mut connection, |transaction| collect_one(
                    transaction,
                    now
                ))
                .unwrap()
                .bytes
                    > 1_000_000
            );
        }
        assert!(!collect_one(&connection, now).unwrap().pending);
        assert_eq!(
            connection
                .query_row("SELECT count(*) FROM block_mutation_body_gc", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        let after_freelist: i64 = connection
            .query_row("PRAGMA freelist_count", [], |row| row.get(0))
            .unwrap();
        assert!(
            after_freelist > before_freelist,
            "inline body pages become reusable without VACUUM"
        );
        assert!(connection.query_row("SELECT octet_length(result_json) FROM block_mutations WHERE mutation_id = 'a-retained'", [], |row| row.get::<_, i64>(0)).unwrap() > 500_000);
        assert!(!backfill_one(&connection).unwrap());
    }
}
