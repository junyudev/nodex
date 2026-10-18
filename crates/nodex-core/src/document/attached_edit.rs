//! Exact-head text edits composed by another domain owner inside its LocalCommit.
use super::*;
use crate::infrastructure::durable_mutation::DurableMutationScope;
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};
use rusqlite::{Connection, params};

/// The caller owns domain validation; Document owns canonical text, projections and history.
#[allow(clippy::too_many_arguments)]
pub(crate) fn edit_page_in_scope(
    connection: &Connection,
    scope: &DurableMutationScope<'_>,
    context: &nodex_core_contracts::BoundModuleContext,
    library_id: &str,
    page_id: &str,
    generation: i64,
    head_seq: i64,
    body: Option<&str>,
    title: Option<&str>,
    operation_id: &str,
) -> Result<i64, StoreError> {
    let document_id: String = connection.query_row(
        "SELECT document_id FROM pages WHERE block_id=?1 AND library_id=?2",
        params![page_id, library_id],
        |row| row.get(0),
    )?;
    let authority = read_document_authority(connection, &document_id)?.ok_or_else(|| {
        StoreError::new(
            StoreErrorCode::NotFound,
            "Page Document is unavailable",
            false,
        )
    })?;
    if authority.owner_lifecycle != "active"
        || authority.head.generation != generation
        || authority.head.head_seq != head_seq
    {
        return Err(StoreError::new(
            StoreErrorCode::RevisionConflict,
            "The message changed; review it again",
            true,
        ));
    }
    let mut engine = reconstruct_yjs_engine(connection, &authority.head)?;
    let schema = BlockDocumentSchema::from_identity(
        &authority.head.schema_key,
        authority.head.schema_version,
    )
    .ok_or_else(|| {
        StoreError::new(
            StoreErrorCode::UnsupportedSchema,
            "Page schema is unavailable",
            false,
        )
    })?;
    let full_state = engine.full_state_v1();
    let decoded = decode_block_document(engine.document(), schema)
        .map_err(|e| StoreError::new(StoreErrorCode::InvalidInput, e.to_string(), false))?;
    let base = materialize_decoded_document(&decoded)
        .map_err(|e| StoreError::new(StoreErrorCode::InvalidInput, e.to_string(), false))?;
    let title = title
        .map(parse_inline_markdown_title)
        .transpose()
        .map_err(|e| StoreError::new(StoreErrorCode::InvalidInput, e.to_string(), false))?;
    let mut ordinal = 0;
    let update = if body.is_none() {
        super::operations::prepare_document_snapshot_restore_update(
            &document_id,
            schema,
            &full_state,
            &engine.state_vector_v1(),
            &base.block_tree,
            title.as_deref(),
        )
    } else {
        prepare_nfm_replacement_update(
            &document_id,
            schema,
            &full_state,
            &engine.state_vector_v1(),
            body.unwrap_or(&base.nfm),
            title.as_deref(),
            &mut || {
                ordinal += 1;
                crate::domain::identity::stable_uuid_v7(
                    operation_id,
                    "inbox-document-block",
                    &format!("{page_id}:{ordinal}"),
                )
            },
        )
    }
    .map_err(|e| StoreError::new(StoreErrorCode::InvalidInput, e.to_string(), false))?;
    let candidate = engine
        .prepare_update_v1(&update.update_v1)
        .map_err(|e| StoreError::new(StoreErrorCode::InvalidInput, e.to_string(), false))?;
    let committed = engine
        .commit_candidate(candidate)
        .map_err(|e| StoreError::new(StoreErrorCode::InvalidInput, e.to_string(), false))?;
    if !committed.did_change {
        return Ok(head_seq);
    }
    let update_id = format!(
        "inbox-edit:{}",
        sha256(format!("{operation_id}:{page_id}").as_bytes())
    );
    let now: String =
        connection.query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')", [], |row| {
            row.get(0)
        })?;
    super::history::prepare_document_revision(connection, &authority, &base, context, &now)?;
    let persisted = persist_yjs_commit_with_local_commit(
        connection,
        PersistYjsCommit {
            authority: &authority,
            actor_project_id: None,
            base_materialization: &base,
            materialization: &update.materialization,
            update_id: &update_id,
            client_session_id: "inbox-domain",
            base_head_seq: head_seq,
            client_touched_block_ids: &update.write_fence_block_ids,
            update: &update.update_v1,
            state_vector: &engine.state_vector_v1(),
            store_epoch: scope.store_epoch(),
            operation_id: &update_id,
            local_commit_id: Some(operation_id),
            event_kind: "document_updated",
            write_fence_block_ids: &update.write_fence_block_ids,
            title_write_fence_required: title.is_some(),
            document_write_fence_required: false,
            placement: DocumentPlacementEvidence::COLLABORATIVE,
        },
        scope.evidence(),
    )?;
    super::history::record_document_revision_edit(
        connection,
        &document_id,
        generation,
        persisted.head_seq,
        &context.connection_id,
        &persisted.committed_at,
    )?;
    Ok(persisted.head_seq)
}
