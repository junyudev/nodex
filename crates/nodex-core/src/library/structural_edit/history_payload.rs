//! Immutable inverse bodies live separately from the small capability marker.
//! Existing inline bodies move one artifact per independently committed call.

use super::*;

pub(super) const DETACHED: &str = r#"{"kind":"detached"}"#;
const CHUNK_BYTES: usize = 256 * 1024;
const CLEANUP_CHUNKS: usize = 4;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::library) struct DormantSource {
    pub(in crate::library) page_id: String,
    pub(in crate::library) document_id: String,
    pub(in crate::library) placeholder_block_id: String,
}

pub(in crate::library) struct EncodedPayload {
    json: String,
    sources: Vec<DormantSource>,
}

impl EncodedPayload {
    pub(in crate::library) fn with_dormant_sources(mut self, sources: Vec<DormantSource>) -> Self {
        self.sources = sources;
        self
    }
}

/// Transfer owns the exact encoded bytes, including on import, and supplies
/// independent dormant-source evidence when its inverse retires a Page capability.
pub(in crate::library) fn prepare_transfer(json: String) -> EncodedPayload {
    EncodedPayload {
        json,
        sources: Vec::new(),
    }
}

pub(super) fn prepare(recipe: &StructuralHistoryRecipe, json: String) -> EncodedPayload {
    let sources = dormant_pages(&recipe.action)
        .iter()
        .map(|page| DormantSource {
            page_id: page.page_id.clone(),
            document_id: page.document_id.clone(),
            placeholder_block_id: page.placeholder_block_id.clone(),
        })
        .collect();
    EncodedPayload { json, sources }
}

fn dormant_pages(action: &StructuralRecipeAction) -> &[DormantPageState] {
    match action {
        StructuralRecipeAction::RestoreTurnedSelection { state } => &state.dormant_pages,
        StructuralRecipeAction::WithInlineContent { action, .. } => dormant_pages(action),
        StructuralRecipeAction::RestoreEditorHistory { .. }
        | StructuralRecipeAction::RestoreDeleted { .. }
        | StructuralRecipeAction::DeleteActive { .. }
        | StructuralRecipeAction::MoveActive { .. }
        | StructuralRecipeAction::SwapActiveWithDeleted { .. }
        | StructuralRecipeAction::UndoMovedReplacement { .. }
        | StructuralRecipeAction::RedoMovedReplacement { .. }
        | StructuralRecipeAction::TurnActiveSelection { .. }
        | StructuralRecipeAction::RestoreBackwardMerge { .. }
        | StructuralRecipeAction::ApplyBackwardMerge { .. } => &[],
    }
}

fn decode_inline(json: String) -> Result<EncodedPayload, StoreError> {
    let sources = decode_dormant_sources(&json)?;
    Ok(EncodedPayload { json, sources })
}

pub(super) fn read(connection: &Connection, operation_id: &str) -> Result<String, StoreError> {
    let reference: String = connection.query_row(
        "SELECT payload_ref_json FROM structural_history_recipes WHERE recipe_operation_id = ?1",
        [operation_id],
        |row| row.get(0),
    )?;
    if reference != DETACHED {
        return Ok(reference);
    }
    let mut payload = String::new();
    let mut statement = connection.prepare(
        "SELECT part, payload_chunk FROM structural_history_payloads WHERE recipe_operation_id = ?1 ORDER BY part",
    )?;
    let chunks = statement.query_map([operation_id], |row| {
        Ok((row.get::<_, u32>(0)?, row.get::<_, String>(1)?))
    })?;
    for (expected, chunk) in chunks.enumerate() {
        let (part, chunk) = chunk?;
        if expected != part as usize || payload.len() + chunk.len() > MAX_STRUCTURAL_PAYLOAD_BYTES {
            return Err(corrupt("Structural history payload chunks are invalid"));
        }
        payload.push_str(&chunk);
    }
    if payload.is_empty() {
        return Err(corrupt("Available structural history payload is missing"));
    }
    Ok(payload)
}

pub(super) fn insert(
    connection: &Connection,
    operation_id: &str,
    payload: &EncodedPayload,
) -> Result<(), StoreError> {
    let payload_json = &payload.json;
    if !(2..=MAX_STRUCTURAL_PAYLOAD_BYTES).contains(&payload_json.len()) {
        return Err(corrupt(
            "Structural history payload exceeds its storage bound",
        ));
    }
    let mut remaining = payload_json.as_str();
    let mut part = 0u32;
    while !remaining.is_empty() {
        let (chunk, rest) = payload_chunk(remaining);
        connection.execute(
            "INSERT INTO structural_history_payloads(recipe_operation_id, part, payload_chunk) VALUES (?1, ?2, ?3)",
            params![operation_id, part, chunk],
        )?;
        remaining = rest;
        part += 1;
    }
    if payload.sources.is_empty() {
        return Ok(());
    }
    let library_id: String = connection.query_row(
        "SELECT library_id FROM structural_history_recipes WHERE recipe_operation_id = ?1",
        [operation_id],
        |row| row.get(0),
    )?;
    record_dormant_sources(connection, &library_id, &payload.sources)?;
    Ok(())
}

fn payload_chunk(value: &str) -> (&str, &str) {
    let mut end = value.len().min(CHUNK_BYTES);
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value.split_at(end)
}

/// Provenance is not a retention root or an access grant. The collector must
/// still prove current canonical ownership and all live retention evidence.
fn decode_dormant_sources(payload_json: &str) -> Result<Vec<DormantSource>, StoreError> {
    let body: serde_json::Value = serde_json::from_str(payload_json)
        .map_err(|_| corrupt("Structural history payload is invalid"))?;
    let mut action = body
        .get("action")
        .ok_or_else(|| corrupt("Structural history action is missing"))?;
    while action.get("kind").and_then(serde_json::Value::as_str) == Some("with_inline_content") {
        action = action
            .get("action")
            .ok_or_else(|| corrupt("Composed history action is missing"))?;
    }
    match action.get("kind").and_then(serde_json::Value::as_str) {
        Some("restore_turned_selection") => {}
        Some(
            "restore_editor_history"
            | "restore_deleted"
            | "delete_active"
            | "move_active"
            | "swap_active_with_deleted"
            | "undo_moved_replacement"
            | "redo_moved_replacement"
            | "turn_active_selection"
            | "restore_backward_merge"
            | "apply_backward_merge",
        ) => return Ok(Vec::new()),
        _ => {
            return Err(unsupported(
                "Structural history provenance action is unsupported",
            ));
        }
    }
    let sources = action
        .get("state")
        .and_then(|state| state.get("dormantPages"))
        .ok_or_else(|| corrupt("Dormant Page provenance is missing"))?;
    serde_json::from_value(sources.clone())
        .map_err(|_| corrupt("Dormant Page provenance is invalid"))
}

fn record_dormant_sources(
    connection: &Connection,
    library_id: &str,
    sources: &[DormantSource],
) -> Result<(), StoreError> {
    if sources.is_empty() {
        return Ok(());
    }
    for source in sources {
        connection.execute(
            "INSERT INTO structural_dormant_document_sources(library_id, document_id, page_id, placeholder_block_id) \
             VALUES (?1, ?2, ?3, ?4) ON CONFLICT(library_id, document_id, page_id, placeholder_block_id) \
             DO UPDATE SET check_after_ms = 0",
            params![library_id, source.document_id, source.page_id, source.placeholder_block_id],
        )?;
    }
    crate::document::advance_block_retention_work(connection)?;
    Ok(())
}

fn queue_terminal(connection: &Connection, operation_id: &str) -> Result<(), StoreError> {
    connection.execute(
        "INSERT OR IGNORE INTO structural_history_payload_gc(recipe_operation_id, terminal_at_ms) \
         SELECT recipe_operation_id, CAST(unixepoch(consumed_at, 'subsec') * 1000 AS INTEGER) \
         FROM structural_history_recipes WHERE recipe_operation_id = ?1 AND state <> 'available'",
        [operation_id],
    )?;
    Ok(())
}

#[derive(Debug, Default)]
pub(crate) struct PayloadCleanup {
    pub bytes: usize,
    pub pending: bool,
}

/// Receipt replay is self-contained, but conservatively keep the inverse body
/// until its producer receipt is physically retired and a complete receipt
/// window has elapsed since terminalization. Never read a large body to prune it.
pub(crate) fn collect_one(
    connection: &Connection,
    now_ms: i64,
) -> Result<PayloadCleanup, StoreError> {
    let complete: bool = connection.query_row(
        "SELECT complete FROM structural_history_payload_backfill WHERE id = 1",
        [],
        |row| row.get(0),
    )?;
    if !complete {
        return Ok(PayloadCleanup::default());
    }
    let next = connection
        .query_row(
            "SELECT recipe_operation_id, terminal_at_ms FROM structural_history_payload_gc \
         WHERE check_after_ms <= ?1 ORDER BY check_after_ms, recipe_operation_id LIMIT 1",
            [now_ms],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()?;
    let Some((id, terminal_at_ms)) = next else {
        return Ok(PayloadCleanup::default());
    };
    let eligible_at_ms = terminal_at_ms
        .checked_add(crate::infrastructure::module_receipts::RECEIPT_RETENTION_MS)
        .ok_or_else(|| corrupt("History payload retention time overflowed"))?;
    let retained: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM structural_history_recipes WHERE recipe_operation_id = ?1 AND state = 'available') \
         OR EXISTS(SELECT 1 FROM editor_history_recipes WHERE recipe_operation_id = ?1) \
         OR EXISTS(SELECT 1 FROM structural_retention_members WHERE authority_kind = 'history_recipe' AND authority_id = ?1) \
         OR EXISTS(SELECT 1 FROM structural_cut_claims WHERE delete_recipe_operation_id = ?1 AND state = 'available') \
         OR EXISTS(SELECT 1 FROM core_module_receipts WHERE module_name = 'library' AND operation_id = ?1) \
         OR EXISTS(SELECT 1 FROM detached_module_receipts WHERE module_name = 'library' AND operation_id = ?1)",
        [&id], |row| row.get(0),
    )?;
    if eligible_at_ms > now_ms || retained {
        let next_check = eligible_at_ms.max(now_ms.saturating_add(30_000));
        connection.execute("UPDATE structural_history_payload_gc SET check_after_ms = ?1 WHERE recipe_operation_id = ?2", params![next_check, id])?;
        return Ok(PayloadCleanup {
            bytes: 0,
            pending: true,
        });
    }
    let chunks = connection.prepare("SELECT part, octet_length(payload_chunk) FROM structural_history_payloads WHERE recipe_operation_id = ?1 ORDER BY part LIMIT ?2")?
        .query_map(params![id, CLEANUP_CHUNKS as i64], |row| Ok((row.get::<_, u32>(0)?, row.get::<_, u32>(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut bytes = 0;
    let started = std::time::Instant::now();
    for (part, length) in chunks {
        crate::infrastructure::request_execution::check_request_interruption()?;
        if bytes != 0 && started.elapsed() >= std::time::Duration::from_millis(20) {
            break;
        }
        connection.execute(
            "DELETE FROM structural_history_payloads WHERE recipe_operation_id = ?1 AND part = ?2",
            params![id, part],
        )?;
        bytes += length as usize;
    }
    connection.execute("DELETE FROM structural_history_payload_gc WHERE recipe_operation_id = ?1 AND NOT EXISTS (SELECT 1 FROM structural_history_payloads WHERE recipe_operation_id = ?1)", [&id])?;
    Ok(PayloadCleanup {
        bytes,
        pending: true,
    })
}

/// The cursor and body replacement commit together. No schema migration walks
/// payloads, and a cancelled copy never advances past the uncommitted artifact.
pub(crate) fn backfill_one(connection: &Connection) -> Result<bool, StoreError> {
    let (after, complete): (String, bool) = connection.query_row(
        "SELECT after_recipe_operation_id, complete FROM structural_history_payload_backfill WHERE id = 1",
        [], |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    if complete {
        return Ok(false);
    }
    let next = connection.query_row(
        "SELECT recipe_operation_id, payload_ref_json, recipe_hash FROM structural_history_recipes \
         WHERE recipe_operation_id > ?1 ORDER BY recipe_operation_id LIMIT 1",
        [&after],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)),
    ).optional()?;
    let Some((id, body, hash)) = next else {
        connection.execute(
            "UPDATE structural_history_payload_backfill SET complete = 1 WHERE id = 1",
            [],
        )?;
        return Ok(false);
    };
    if body != DETACHED {
        if !constant_time_equal(sha256(body.as_bytes()).as_bytes(), hash.as_bytes()) {
            return Err(corrupt("Structural history payload hash is invalid"));
        }
        insert(connection, &id, &decode_inline(body)?)?;
        connection.execute(
            "UPDATE structural_history_recipes SET payload_ref_json = ?1 WHERE recipe_operation_id = ?2",
            params![DETACHED, id],
        )?;
        queue_terminal(connection, &id)?;
    }
    crate::infrastructure::request_execution::check_request_interruption()?;
    connection.execute(
        "UPDATE structural_history_payload_backfill SET after_recipe_operation_id = ?1 WHERE id = 1",
        [&id],
    )?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infrastructure::sqlite::with_immediate_transaction;

    #[test]
    fn collection_preserves_live_dependencies_and_provenance_while_releasing_bounded_chunks() {
        let mut connection = Connection::open_in_memory().expect("Store");
        crate::infrastructure::schema::install_current_schema(&mut connection).expect("schema");
        connection
            .pragma_update(None, "foreign_keys", false)
            .expect("storage boundary fixture");
        connection
            .execute("INSERT INTO block_retention_state VALUES (1, 0, 0)", [])
            .expect("maintenance state");
        let body = serde_json::json!({
            "version": 1,
            "padding": "字".repeat(CHUNK_BYTES),
            "more": "文".repeat(CHUNK_BYTES),
            "action": { "kind": "with_inline_content", "action": {
                "kind": "with_inline_content", "action": { "kind": "restore_turned_selection", "state": {
                    "dormantPages": [{ "pageId": "page", "documentId": "document", "placeholderBlockId": "placeholder" }]
                }}
            }}
        }).to_string();
        // Cross multiple chunk boundaries, including a multibyte UTF-8 edge.
        let hash = sha256(body.as_bytes());
        connection.execute(
            "INSERT INTO structural_history_recipes(recipe_operation_id, library_id, project_id, store_epoch, recipe_hash, payload_ref_json, state, created_at) \
             VALUES ('recipe', 'library', 'project', 'epoch', ?1, ?2, 'available', '2026-01-01T00:00:00Z')",
            params![hash, DETACHED],
        ).expect("capability");
        with_immediate_transaction(&mut connection, |transaction| {
            insert(transaction, "recipe", &decode_inline(body.clone())?)
        })
        .expect("body and provenance");
        assert_eq!(read(&connection, "recipe").unwrap(), body);
        assert!(
            connection
                .execute(
                    "DELETE FROM structural_history_payloads WHERE recipe_operation_id = 'recipe'",
                    []
                )
                .is_err(),
            "active inverse cannot lose bytes"
        );
        connection.execute("UPDATE structural_history_recipes SET state = 'consumed', consumed_at = '2026-01-01T00:00:00Z' WHERE recipe_operation_id = 'recipe'", []).expect("terminal");
        let terminal: i64 = connection
            .query_row(
                "SELECT terminal_at_ms FROM structural_history_payload_gc",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let window = crate::infrastructure::module_receipts::RECEIPT_RETENTION_MS;
        assert_eq!(
            collect_one(&connection, terminal + window - 1)
                .unwrap()
                .bytes,
            0
        );
        let mut now = terminal + window + 30_001;
        connection.execute("INSERT INTO structural_retention_members VALUES ('history_recipe', 'recipe', 'library', 'document', 'document')", []).expect("pending root cleanup");
        assert_eq!(collect_one(&connection, now).unwrap().bytes, 0);
        connection
            .execute("DELETE FROM structural_retention_members", [])
            .unwrap();
        connection.execute("INSERT INTO core_module_receipts(module_name, operation_id, profile_id, adapter_kind, operation_kind, store_epoch, request_hash, result_json, committed_at) VALUES ('library', 'recipe', 'profile', 'test', 'structural_edit', 'epoch', ?1, '{}', '2026-01-01T00:00:00Z')", [&hash]).expect("retained receipt");
        now += 30_001;
        assert_eq!(collect_one(&connection, now).unwrap().bytes, 0);
        connection
            .execute(
                "DELETE FROM core_module_receipts WHERE operation_id = 'recipe'",
                [],
            )
            .unwrap();
        connection
            .execute(
                "UPDATE structural_history_payload_backfill SET complete = 0",
                [],
            )
            .unwrap();
        now += 30_001;
        assert_eq!(
            collect_one(&connection, now).unwrap().bytes,
            0,
            "provenance watermark fences collection"
        );
        connection
            .execute(
                "UPDATE structural_history_payload_backfill SET complete = 1",
                [],
            )
            .unwrap();
        let first = with_immediate_transaction(&mut connection, |transaction| {
            collect_one(transaction, now)
        })
        .expect("first byte slice");
        assert!(
            first.bytes > 0
                && first.bytes <= CHUNK_BYTES * CLEANUP_CHUNKS
                && first.bytes < body.len()
        );
        let mut released = first.bytes;
        for _ in 0..10 {
            let slice = with_immediate_transaction(&mut connection, |transaction| {
                collect_one(transaction, now)
            })
            .expect("remaining byte slice");
            assert!(slice.bytes <= CHUNK_BYTES * CLEANUP_CHUNKS);
            released += slice.bytes;
            if !slice.pending {
                break;
            }
        }
        assert_eq!(released, body.len());
        assert_eq!(
            connection
                .query_row(
                    "SELECT count(*) FROM structural_history_payloads",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        let source: (String, String, String) = connection.query_row("SELECT document_id, page_id, placeholder_block_id FROM structural_dormant_document_sources", [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).expect("independent provenance");
        assert_eq!(
            source,
            ("document".into(), "page".into(), "placeholder".into())
        );
        let token = LibraryStructuralHistoryToken {
            recipe_operation_id: "recipe".into(),
            store_epoch: "epoch".into(),
            recipe_hash: hash,
        };
        let error =
            read_history_payload(&connection, "library", None, "epoch", &token).unwrap_err();
        assert_eq!(error.code, StoreErrorCode::RevisionConflict);
    }

    #[test]
    fn detached_payload_preserves_tokens_and_resumes_only_committed_copies() {
        let profile = tempfile::tempdir().expect("Profile");
        let path = profile.path().join("nodex.db");
        let mut connection = Connection::open(&path).expect("Store");
        crate::infrastructure::schema::install_current_schema(&mut connection).expect("schema");
        connection
            .pragma_update(None, "foreign_keys", false)
            .expect("storage fixture");
        let body = r#"{"version":1,"action":{"kind":"restore_deleted"}}"#;
        for id in ["a", "b"] {
            connection.execute(
                "INSERT INTO structural_history_recipes(recipe_operation_id, library_id, project_id, store_epoch, recipe_hash, payload_ref_json, state, created_at) \
                 VALUES (?1, 'library', 'project', 'epoch', ?2, ?3, 'available', 'now')",
                params![id, sha256(body.as_bytes()), body],
            ).expect("inline predecessor");
        }
        connection
            .execute(
                "UPDATE structural_history_payload_backfill SET complete = 0",
                [],
            )
            .expect("pending");
        with_immediate_transaction(&mut connection, |transaction| backfill_one(transaction))
            .expect("first copy");
        let failed: Result<(), StoreError> =
            with_immediate_transaction(&mut connection, |transaction| {
                backfill_one(transaction)?;
                Err(internal("interrupted after copy"))
            });
        assert!(failed.is_err());
        drop(connection);
        let mut connection = Connection::open(&path).expect("resume after restart");
        assert_eq!(
            connection
                .query_row(
                    "SELECT count(*) FROM structural_history_payloads",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
        for id in ["a", "b"] {
            assert_eq!(read(&connection, id).unwrap(), body);
        }
        assert!(connection.execute("UPDATE structural_history_recipes SET payload_ref_json = ?1 WHERE recipe_operation_id = 'b'", [DETACHED]).is_err(), "cannot detach without matching bytes");
        with_immediate_transaction(&mut connection, |transaction| backfill_one(transaction))
            .expect("resume");
        assert!(
            !with_immediate_transaction(&mut connection, |transaction| backfill_one(transaction))
                .expect("complete")
        );
        assert!(
            !with_immediate_transaction(&mut connection, |transaction| backfill_one(transaction))
                .expect("repeat")
        );
        connection.execute("UPDATE structural_history_recipes SET state = 'consumed', consumed_at = '2026-01-01T00:00:00Z' WHERE recipe_operation_id = 'a'", []).expect("terminal transition");
        assert!(connection.execute("UPDATE structural_history_recipes SET state = 'available', consumed_at = NULL WHERE recipe_operation_id = 'a'", []).is_err());
        assert!(
            connection
                .execute(
                    "UPDATE structural_history_payloads SET payload_chunk = '{}'",
                    []
                )
                .is_err()
        );
        assert_eq!(read(&connection, "a").unwrap(), body);
    }
}
