use rusqlite::{Connection, TransactionBehavior, params};

use nodex_core_contracts::{BoundModuleContext, ProjectId};

use crate::infrastructure::document_repository::{DocumentReadiness, DocumentSyncEngine};
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

use super::compaction::compact_yjs_document;
use super::history::{
    NewDocumentCheckpoint, insert_canvas_checkpoint, insert_document_checkpoint,
    plan_document_history_prune, prune_document_history,
};
use super::persistence::read_document_authority;
use super::runtime::reconstruct_yjs_engine;
use super::{
    BlockDocumentSchema, decode_block_document, load_canvas_scene, materialize_decoded_document,
};

const MINIMUM_UPDATE_COUNT: i64 = 128;
const MINIMUM_UPDATE_BYTES: i64 = 2 * 1024 * 1024;
const MAXIMUM_DOCUMENTS: usize = 8;
const MAXIMUM_TAIL_BYTES: i64 = 32 * 1024 * 1024;
const SCAN_LIMIT: i64 = 128;
const MAXIMUM_HISTORY_DOCUMENTS: usize = 10_000;
const MAXIMUM_REVISION_SESSIONS: i64 = 200;
const REVISION_IDLE_MILLISECONDS: i64 = 120_000;

#[derive(Debug)]
struct CompactionCandidate {
    document_id: String,
    generation: i64,
    head_seq: i64,
    update_bytes: i64,
}

pub(crate) fn next_revision_maintenance_at_ms(
    connection: &Connection,
) -> Result<Option<i64>, StoreError> {
    connection
        .query_row(
            "SELECT MIN(CAST(unixepoch(last_edit_at, 'subsec') * 1000 AS INTEGER) + ?1) \
             FROM document_revision_sessions",
            [REVISION_IDLE_MILLISECONDS],
            |row| row.get::<_, Option<i64>>(0),
        )
        .map_err(Into::into)
}

pub(crate) fn has_document_compaction_work(connection: &Connection) -> Result<bool, StoreError> {
    connection
        .query_row(
            "SELECT EXISTS(\
               SELECT 1 FROM documents document \
               JOIN block_documents ownership ON ownership.document_id = document.id \
                 AND ownership.library_id = document.library_id \
               JOIN blocks owner ON owner.id = ownership.block_id \
                 AND owner.library_id = document.library_id \
               JOIN document_updates update_row ON update_row.document_id = document.id \
                 AND update_row.generation = document.generation \
               WHERE document.readiness = 'ready' AND document.sync_engine = 'yjs' \
               GROUP BY document.id, document.generation, document.head_seq \
               HAVING count(update_row.seq) >= ?1 \
                   OR COALESCE(SUM(length(update_row.update_blob)), 0) >= ?2 \
               LIMIT 1\
             )",
            params![MINIMUM_UPDATE_COUNT, MINIMUM_UPDATE_BYTES],
            |row| row.get::<_, bool>(0),
        )
        .map_err(Into::into)
}

pub(crate) fn has_document_history_retention_work(
    connection: &Connection,
) -> Result<bool, StoreError> {
    if connection.query_row("SELECT EXISTS(SELECT 1 FROM document_recovery_drafts WHERE resolution IS NOT NULL AND julianday(resolved_at) < julianday('now','-30 days'))", [], |row| row.get::<_, bool>(0))? { return Ok(true); }
    let now = connection.query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", [], |row| {
        row.get::<_, String>(0)
    })?;
    let document_ids = connection
        .prepare(
            "SELECT DISTINCT document_id FROM document_versions \
             ORDER BY document_id LIMIT 10001",
        )?
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if document_ids.len() > MAXIMUM_HISTORY_DOCUMENTS {
        return Err(corrupt(
            "Document history maintenance exceeds its Document bound",
        ));
    }
    for document_id in document_ids {
        if !plan_document_history_prune(connection, &document_id, &now)?.is_empty() {
            return Ok(true);
        }
    }
    Ok(false)
}

pub(crate) fn finalize_idle_document_revisions(
    connection: &mut Connection,
    context: &BoundModuleContext,
) -> Result<usize, StoreError> {
    let now = connection.query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", [], |row| {
        row.get::<_, String>(0)
    })?;
    let sessions = connection
        .prepare(
            "SELECT document_id, generation, last_edit_at \
             FROM document_revision_sessions \
             ORDER BY last_edit_at, document_id LIMIT ?1",
        )?
        .query_map([MAXIMUM_REVISION_SESSIONS], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut finalized = 0usize;
    for (document_id, session_generation, last_edit_at) in sessions {
        let idle = connection
            .query_row(
                "SELECT (julianday(?1) - julianday(?2)) * 86400000 >= ?3",
                params![now, last_edit_at, REVISION_IDLE_MILLISECONDS],
                |row| row.get::<_, Option<bool>>(0),
            )?
            .ok_or_else(|| corrupt("Document revision session timestamp is invalid"))?;
        if !idle {
            continue;
        }
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let Some(authority) = read_document_authority(&transaction, &document_id)? else {
            transaction.execute(
                "DELETE FROM document_revision_sessions WHERE document_id = ?1",
                [&document_id],
            )?;
            transaction.commit()?;
            continue;
        };
        if authority.head.generation != session_generation
            || authority.head.readiness != DocumentReadiness::Ready
        {
            transaction.execute(
                "DELETE FROM document_revision_sessions WHERE document_id = ?1",
                [&document_id],
            )?;
            transaction.commit()?;
            continue;
        }
        let actor_context = match context.project_id.as_ref() {
            Some(_) => context.clone(),
            None => BoundModuleContext {
                editor_history_owner: None,
                project_id: Some(ProjectId(crate::library::resolve_library_actor_project_id(
                    &transaction,
                    &authority.head.library_id,
                )?)),
                ..context.clone()
            },
        };
        let already_covered = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM document_versions \
             WHERE document_id = ?1 AND generation = ?2 AND base_head_seq = ?3)",
            params![
                document_id,
                authority.head.generation,
                authority.head.head_seq
            ],
            |row| row.get::<_, bool>(0),
        )?;
        if !already_covered || authority.head.sync_engine == DocumentSyncEngine::Yjs {
            let operation_id = format!(
                "revision-idle:{}:{}:{}",
                authority.head.id, authority.head.generation, authority.head.head_seq
            );
            let checkpoint = NewDocumentCheckpoint {
                operation_id: &operation_id,
                cause: "idle_edit",
                label: None,
                revision_kind: "automatic",
                source_mutation_id: None,
                source_change_seq: None,
                actor: None,
                context: &actor_context,
                now: &now,
            };
            let inserted = match authority.head.sync_engine {
                DocumentSyncEngine::Yjs => {
                    let schema = BlockDocumentSchema::from_identity(
                        &authority.head.schema_key,
                        authority.head.schema_version,
                    )
                    .ok_or_else(|| corrupt("Document revision schema is unsupported"))?;
                    let engine = reconstruct_yjs_engine(&transaction, &authority.head)?;
                    let decoded = decode_block_document(engine.document(), schema)
                        .map_err(|_| corrupt("Document revision authority cannot be decoded"))?;
                    let materialization = materialize_decoded_document(&decoded).map_err(|_| {
                        corrupt("Document revision authority cannot be materialized")
                    })?;
                    if !super::history::has_current_document_checkpoint(
                        &transaction,
                        &authority,
                        &materialization,
                    )? {
                        insert_document_checkpoint(
                            &transaction,
                            &authority,
                            &materialization,
                            checkpoint,
                        )?;
                        true
                    } else {
                        false
                    }
                }
                DocumentSyncEngine::CanvasScene => {
                    let loaded = load_canvas_scene(&transaction, &authority)?;
                    insert_canvas_checkpoint(&transaction, &authority, &loaded.scene, checkpoint)?;
                    true
                }
            };
            finalized = finalized
                .checked_add(usize::from(inserted))
                .ok_or_else(|| corrupt("Document revision finalization count overflowed"))?;
        }
        transaction.execute(
            "DELETE FROM document_revision_sessions WHERE document_id = ?1",
            [&document_id],
        )?;
        transaction.commit()?;
    }
    Ok(finalized)
}

pub(crate) fn compact_eligible_documents(connection: &mut Connection) -> Result<usize, StoreError> {
    let candidates = connection
        .prepare(
            "SELECT document.id, document.generation, document.head_seq, \
                    COALESCE(SUM(length(update_row.update_blob)), 0) AS update_bytes \
             FROM documents document \
             JOIN block_documents ownership ON ownership.document_id = document.id \
               AND ownership.library_id = document.library_id \
             JOIN blocks owner ON owner.id = ownership.block_id \
               AND owner.library_id = document.library_id \
             JOIN document_updates update_row ON update_row.document_id = document.id \
               AND update_row.generation = document.generation \
             WHERE document.readiness = 'ready' AND document.sync_engine = 'yjs' \
             GROUP BY document.id, document.generation, document.head_seq \
             HAVING count(update_row.seq) >= ?1 \
                 OR COALESCE(SUM(length(update_row.update_blob)), 0) >= ?2 \
             ORDER BY MIN(update_row.committed_at), update_bytes DESC, document.id \
             LIMIT ?3",
        )?
        .query_map(
            params![MINIMUM_UPDATE_COUNT, MINIMUM_UPDATE_BYTES, SCAN_LIMIT],
            |row| {
                Ok(CompactionCandidate {
                    document_id: row.get(0)?,
                    generation: row.get(1)?,
                    head_seq: row.get(2)?,
                    update_bytes: row.get(3)?,
                })
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut selected = Vec::new();
    let mut selected_bytes = 0i64;
    for candidate in candidates {
        if candidate.generation < 1 || candidate.head_seq < 0 || candidate.update_bytes < 0 {
            return Err(corrupt("Document compaction candidate is invalid"));
        }
        if selected.len() >= MAXIMUM_DOCUMENTS {
            break;
        }
        let next_bytes = selected_bytes
            .checked_add(candidate.update_bytes)
            .ok_or_else(|| corrupt("Document compaction byte budget overflowed"))?;
        if next_bytes > MAXIMUM_TAIL_BYTES && !selected.is_empty() {
            continue;
        }
        selected_bytes = next_bytes;
        selected.push(candidate);
    }

    for candidate in &selected {
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let authority = read_document_authority(&transaction, &candidate.document_id)?
            .ok_or_else(|| corrupt("Document compaction authority disappeared"))?;
        if authority.head.generation != candidate.generation
            || authority.head.head_seq != candidate.head_seq
            || authority.head.sync_engine != DocumentSyncEngine::Yjs
        {
            return Err(StoreError::new(
                StoreErrorCode::HeadConflict,
                "Document changed before maintenance compaction",
                true,
            ));
        }
        let engine = reconstruct_yjs_engine(&transaction, &authority.head)?;
        compact_yjs_document(&transaction, &authority, &engine)?;
        transaction.commit()?;
    }
    Ok(selected.len())
}

pub(crate) fn prune_document_history_pass(
    connection: &mut Connection,
) -> Result<usize, StoreError> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let now = transaction.query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", [], |row| {
        row.get::<_, String>(0)
    })?;
    let document_ids = transaction
        .prepare(
            "SELECT DISTINCT document_id FROM document_versions \
             ORDER BY document_id LIMIT 10001",
        )?
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if document_ids.len() > MAXIMUM_HISTORY_DOCUMENTS {
        return Err(corrupt(
            "Document history maintenance exceeds its Document bound",
        ));
    }
    let mut deleted = transaction.execute("DELETE FROM document_recovery_drafts WHERE (library_id, draft_id) IN (SELECT library_id, draft_id FROM document_recovery_drafts WHERE resolution IS NOT NULL AND julianday(resolved_at) < julianday('now','-30 days') ORDER BY resolved_at LIMIT 32)", [])?;
    for document_id in document_ids {
        deleted = deleted
            .checked_add(prune_document_history(&transaction, &document_id, &now)?)
            .ok_or_else(|| corrupt("Document history deletion count overflowed"))?;
    }
    transaction.commit()?;
    Ok(deleted)
}

fn corrupt(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message, false)
}

#[cfg(test)]
mod tests {
    use nodex_core_contracts::{AdapterKind, BoundModuleContext, LibraryId, ProfileId};
    use rusqlite::params;

    use crate::document::{
        DocumentPlacementEvidence, PersistYjsGenesis, persist_yjs_genesis,
        prepare_page_yjs_genesis, read_document_authority,
    };
    use crate::infrastructure::store::SqliteStoreKernel;

    use super::finalize_idle_document_revisions;

    #[test]
    fn finalizes_an_idle_revision_session_at_the_current_document_head() {
        let home = tempfile::tempdir().expect("Profile home");
        let kernel = SqliteStoreKernel::open_test(home.path()).expect("fresh store");
        kernel
            .writer()
            .call(|connection| {
                connection.execute(
                    "INSERT INTO block_store_metadata(id, store_epoch, created_at, updated_at) \
                     VALUES (1, 'epoch:revision-maintenance', ?1, ?1)",
                    ["2026-07-19T00:00:00.000Z"],
                )?;
                connection.execute(
                    "INSERT INTO profiles(id, created_at, updated_at) \
                     VALUES ('profile:revision-maintenance', ?1, ?1)",
                    ["2026-07-19T00:00:00.000Z"],
                )?;
                connection.execute(
                    "INSERT INTO libraries(id, profile_id, created_at, updated_at) \
                     VALUES ('library:revision-maintenance', \
                       'profile:revision-maintenance', ?1, ?1)",
                    ["2026-07-19T00:00:00.000Z"],
                )?;
                connection.execute(
                    "INSERT INTO projects(id, library_id, name, created, updated) \
                     VALUES ('project:revision-maintenance', \
                       'library:revision-maintenance', 'Revision maintenance', ?1, ?1)",
                    ["2026-07-19T00:00:00.000Z"],
                )?;
                connection.execute(
                    "INSERT INTO blocks( \
                       id, library_id, type, lifecycle, created_at, updated_at \
                     ) VALUES ('page:revision-maintenance', 'library:revision-maintenance', \
                       'page', 'active', ?1, ?1)",
                    ["2026-07-19T00:00:00.000Z"],
                )?;
                connection.execute(
                    "INSERT INTO documents( \
                       id, library_id, schema_key, schema_version, created_at, updated_at \
                     ) VALUES ('document:revision-maintenance', \
                       'library:revision-maintenance', 'nodex.page', 3, ?1, ?1)",
                    ["2026-07-19T00:00:00.000Z"],
                )?;
                connection.execute(
                    "INSERT INTO block_documents(block_id, document_id, library_id, created_at) \
                     VALUES ('page:revision-maintenance', 'document:revision-maintenance', \
                       'library:revision-maintenance', ?1)",
                    ["2026-07-19T00:00:00.000Z"],
                )?;
                connection.execute(
                    "INSERT INTO pages( \
                       block_id, library_id, document_id, parent_kind, parent_id, \
                       created_at, updated_at \
                     ) VALUES ('page:revision-maintenance', 'library:revision-maintenance', \
                       'document:revision-maintenance', 'library', \
                       'library:revision-maintenance', ?1, ?1)",
                    ["2026-07-19T00:00:00.000Z"],
                )?;
                connection.execute(
                    "INSERT INTO library_block_placements( \
                       block_id, library_id, rank_key, revision, created_at, updated_at \
                     ) VALUES ('page:revision-maintenance', 'library:revision-maintenance', \
                       'a0', 1, ?1, ?1)",
                    ["2026-07-19T00:00:00.000Z"],
                )?;
                let authority =
                    read_document_authority(connection, "document:revision-maintenance")?
                        .expect("pending Document authority");
                let genesis = prepare_page_yjs_genesis(
                    "document:revision-maintenance",
                    "Idle history",
                    "019c0000-0000-7000-8000-000000000099",
                )?;
                let persisted = persist_yjs_genesis(
                    connection,
                    PersistYjsGenesis {
                        authority: &authority,
                        actor_project_id: "project:revision-maintenance",
                        materialization: &genesis.materialization,
                        update_id: "genesis:revision-maintenance",
                        client_session_id: "client:revision-maintenance",
                        update: &genesis.update_v1,
                        state_vector: &genesis.state_vector_v1,
                        full_state: &genesis.engine.full_state_v1(),
                        store_epoch: "epoch:revision-maintenance",
                        operation_id: "operation:revision-maintenance-genesis",
                        placement: DocumentPlacementEvidence::STRUCTURAL,
                        emit_event: false,
                    },
                )?;
                connection.execute(
                    "INSERT INTO document_revision_sessions( \
                       document_id, generation, dirty_head_seq, burst_started_at, \
                       last_edit_at, last_checkpoint_at, client_session_id \
                     ) VALUES (?1, 1, ?2, ?3, ?3, NULL, ?4)",
                    params![
                        "document:revision-maintenance",
                        persisted.head_seq,
                        "2020-01-01T00:00:00.000Z",
                        "client:revision-maintenance"
                    ],
                )?;
                let finalized = finalize_idle_document_revisions(
                    connection,
                    &BoundModuleContext {
                        editor_history_owner: None,
                        profile_id: ProfileId("profile:revision-maintenance".to_owned()),
                        library_id: LibraryId("library:revision-maintenance".to_owned()),
                        project_id: None,
                        connection_id: "connection:revision-maintenance".to_owned(),
                        adapter: AdapterKind::ElectronHost,
                    },
                )?;
                assert_eq!(finalized, 1);
                assert_eq!(
                    connection.query_row(
                        "SELECT count(*) FROM document_revision_sessions \
                         WHERE document_id = 'document:revision-maintenance'",
                        [],
                        |row| row.get::<_, i64>(0),
                    )?,
                    0
                );
                assert_eq!(
                    connection.query_row(
                        "SELECT cause FROM document_versions \
                         WHERE document_id = 'document:revision-maintenance' \
                         ORDER BY created_at DESC LIMIT 1",
                        [],
                        |row| row.get::<_, String>(0),
                    )?,
                    "idle_edit"
                );
                Ok(())
            })
            .expect("idle revision maintenance");
    }
}
