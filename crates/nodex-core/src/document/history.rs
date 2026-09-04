use nodex_core_contracts::document::DocumentVersionCursor;
use nodex_core_contracts::{AdapterKind, BoundModuleContext, LibraryId, ProfileId, ProjectId};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

use serde_json::{Map, Value, json};

use crate::domain::block_materialization::MaterializedBlockNode;
use crate::domain::block_materialization::dematerialize_block_tree;
use crate::domain::files::FileSnapshotManifest;
use crate::domain::rich_text::{RichTextItem, rich_text_to_delta};
use crate::infrastructure::request_execution::check_request_interruption;
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

use super::canvas_scene::{CanvasScene, parse_canvas_scene};
use super::persistence::{DocumentAuthorityRow, read_store_epoch, sha256};
use super::{
    BlockDocumentKind, BlockDocumentSchema, DocumentMaterialization,
    PreparedDocumentOperationUpdate, YrsDocumentEngine, decode_block_document,
    encode_block_document, materialize_decoded_document,
};

const CHECKPOINT_FORMAT: &str = "block_tree_snapshot_v3";
const CANVAS_CHECKPOINT_FORMAT: &str = "canvas_scene_json_v2";
const DEFAULT_HISTORY_LIMIT: u32 = 50;
const MAX_HISTORY_LIMIT: u32 = 200;

#[derive(Debug, Clone)]
pub(crate) struct NewDocumentCheckpoint<'a> {
    pub(crate) operation_id: &'a str,
    pub(crate) cause: &'a str,
    pub(crate) label: Option<&'a str>,
    pub(crate) revision_kind: &'a str,
    pub(crate) source_mutation_id: Option<&'a str>,
    pub(crate) source_change_seq: Option<i64>,
    pub(crate) actor: Option<&'a Value>,
    pub(crate) context: &'a BoundModuleContext,
    pub(crate) now: &'a str,
}

#[derive(Debug, Clone)]
pub(crate) struct StoredDocumentVersion {
    pub(crate) summary: Value,
    pub(crate) materialization: Value,
    pub(crate) block_materialization: Option<DocumentMaterialization>,
    pub(crate) canvas_scene: Option<CanvasScene>,
    pub(crate) file_snapshot: Option<FileSnapshotManifest>,
}

pub(crate) struct InsertedDocumentCheckpoint {
    pub(crate) version: StoredDocumentVersion,
    pub(crate) duplicate: bool,
}

#[derive(Clone, Debug)]
pub(super) struct DocumentVersionRetentionBackfillPlan {
    version_id: String,
    checkpoint_hash: String,
    indexed_at: String,
    members: BTreeSet<(String, String)>,
    files: super::file_snapshots::FileSnapshotIndexPlan,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BlockTreeSnapshot {
    format_version: u32,
    kind: BlockDocumentKind,
    block_tree: Vec<MaterializedBlockNode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    rich_title: Option<Vec<RichTextItem>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    file_snapshot: Option<FileSnapshotManifest>,
}

#[derive(Debug)]
struct StoredVersionRow {
    version_id: String,
    document_id: String,
    actor_project_id: String,
    generation: i64,
    base_head_seq: i64,
    schema_key: String,
    schema_version: i64,
    cause: String,
    label: Option<String>,
    actor_json: String,
    revision_kind: String,
    source_mutation_id: Option<String>,
    source_change_seq: Option<i64>,
    pinned: i64,
    checkpoint_format: String,
    checkpoint_bytes: Vec<u8>,
    state_vector: Vec<u8>,
    checkpoint_hash: String,
    byte_length: i64,
    created_at: String,
}

fn current_block_snapshot(
    connection: &Connection,
    authority: &DocumentAuthorityRow,
    materialization: &DocumentMaterialization,
) -> Result<BlockTreeSnapshot, StoreError> {
    Ok(BlockTreeSnapshot {
        format_version: 3,
        kind: materialization.kind,
        block_tree: materialization.block_tree.clone(),
        rich_title: authority
            .head
            .schema_key
            .eq("nodex.page")
            .then(|| materialization.rich_title.clone()),
        file_snapshot: Some(crate::library::capture_file_snapshot(
            connection,
            &authority.head.library_id,
            materialization.file_ids().iter().map(String::as_str),
        )?),
    })
}

pub(super) fn has_current_document_checkpoint(
    connection: &Connection,
    authority: &DocumentAuthorityRow,
    materialization: &DocumentMaterialization,
) -> Result<bool, StoreError> {
    let snapshot = current_block_snapshot(connection, authority, materialization)?;
    let hash = sha256(&canonical_json_bytes(
        serde_json::to_value(snapshot)
            .map_err(|_| internal("Document checkpoint could not be encoded"))?,
    )?);
    Ok(connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM document_versions WHERE document_id = ?1 AND generation = ?2 AND base_head_seq = ?3 AND checkpoint_hash = ?4)",
        params![authority.head.id, authority.head.generation, authority.head.head_seq, hash], |row| row.get(0),
    )?)
}

pub(crate) fn insert_document_checkpoint(
    connection: &Connection,
    authority: &DocumentAuthorityRow,
    materialization: &DocumentMaterialization,
    input: NewDocumentCheckpoint<'_>,
) -> Result<InsertedDocumentCheckpoint, StoreError> {
    insert_document_checkpoint_with_prune(connection, authority, materialization, input, true)
}

fn insert_document_checkpoint_with_prune(
    connection: &Connection,
    authority: &DocumentAuthorityRow,
    materialization: &DocumentMaterialization,
    input: NewDocumentCheckpoint<'_>,
    prune: bool,
) -> Result<InsertedDocumentCheckpoint, StoreError> {
    validate_checkpoint_input(&input)?;
    let snapshot = current_block_snapshot(connection, authority, materialization)?;
    let snapshot_value = serde_json::to_value(&snapshot)
        .map_err(|_| internal("Document checkpoint could not be encoded"))?;
    let checkpoint_bytes = canonical_json_bytes(snapshot_value)?;
    let checkpoint_hash = sha256(&checkpoint_bytes);
    let actor = checkpoint_actor(&input)?;
    let actor_project_id =
        checkpoint_actor_project_id(connection, &authority.head.library_id, &input)?;
    let actor_json = String::from_utf8(canonical_json_bytes(actor.clone())?)
        .map_err(|_| internal("Checkpoint actor encoding is invalid"))?;
    let links_mutation = matches!(input.revision_kind, "operation" | "restore");
    let source_mutation_id = links_mutation.then_some(input.source_mutation_id).flatten();
    let source_change_seq = links_mutation.then_some(input.source_change_seq).flatten();
    let pinned = i64::from(matches!(input.revision_kind, "manual" | "restore"));
    let materialization_hash =
        block_materialization_hash(materialization, snapshot.file_snapshot.as_ref())?;
    let identity = json!({
        "version": 1,
        "documentId": authority.head.id,
        "actorProjectId": actor_project_id,
        "storeEpoch": read_store_epoch(connection)?,
        "generation": authority.head.generation,
        "baseHeadSeq": authority.head.head_seq,
        "schemaKey": authority.head.schema_key,
        "schemaVersion": authority.head.schema_version,
        "cause": input.cause,
        "label": input.label,
        "actor": actor,
        "revisionKind": input.revision_kind,
        "sourceMutationId": source_mutation_id,
        "sourceChangeSeq": source_change_seq,
        "pinned": pinned == 1,
        "checkpointHash": checkpoint_hash,
        "checkpointMetadata": { "format": CHECKPOINT_FORMAT },
        "materializationHash": materialization_hash,
    });
    let version_id = format!(
        "document-version:{}",
        sha256(&canonical_json_bytes(identity)?)
    );
    let byte_length = i64::try_from(checkpoint_bytes.len())
        .map_err(|_| internal("Checkpoint byte length overflowed"))?;
    let inserted = connection.execute(
        "INSERT INTO document_versions (\
           version_id, document_id, project_id, generation, base_head_seq, schema_key, \
           schema_version, cause, label, actor_json, revision_kind, source_mutation_id, \
           source_change_seq, pinned, checkpoint_format, full_update_blob, state_vector, \
           checkpoint_hash, byte_length, created_at\
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, \
                   ?15, ?16, X'', ?17, ?18, ?19) \
         ON CONFLICT(version_id) DO NOTHING",
        params![
            version_id,
            authority.head.id,
            actor_project_id,
            authority.head.generation,
            authority.head.head_seq,
            authority.head.schema_key,
            authority.head.schema_version,
            input.cause,
            input.label,
            actor_json,
            input.revision_kind,
            source_mutation_id,
            source_change_seq,
            pinned,
            CHECKPOINT_FORMAT,
            checkpoint_bytes,
            checkpoint_hash,
            byte_length,
            input.now,
        ],
    )?;
    let stored = read_document_version(connection, &authority.head.id, &version_id)?
        .ok_or_else(|| corrupt("Inserted Document checkpoint could not be read"))?;
    if stored.generation != authority.head.generation
        || stored.base_head_seq != authority.head.head_seq
        || stored.checkpoint_hash != checkpoint_hash
        || stored.cause != input.cause
        || stored.label.as_deref() != input.label
        || stored.actor_json != actor_json
        || stored.revision_kind != input.revision_kind
        || stored.source_mutation_id.as_deref() != source_mutation_id
        || stored.source_change_seq != source_change_seq
        || stored.pinned != pinned
        || stored.checkpoint_format != CHECKPOINT_FORMAT
    {
        return Err(StoreError::new(
            StoreErrorCode::IdempotencyKeyReused,
            "Document checkpoint identity collides with different immutable content",
            false,
        ));
    }
    let version = decode_document_version(stored)?;
    ensure_document_version_retention_index(
        connection,
        &version_id,
        &checkpoint_hash,
        input.now,
        &version,
    )?;
    if prune {
        prune_document_history(connection, &authority.head.id, input.now)?;
    }
    Ok(InsertedDocumentCheckpoint {
        version,
        duplicate: inserted == 0,
    })
}

pub(crate) fn insert_canvas_checkpoint(
    connection: &Connection,
    authority: &DocumentAuthorityRow,
    scene: &CanvasScene,
    input: NewDocumentCheckpoint<'_>,
) -> Result<InsertedDocumentCheckpoint, StoreError> {
    insert_canvas_checkpoint_with_prune(connection, authority, scene, input, true)
}

fn insert_canvas_checkpoint_with_prune(
    connection: &Connection,
    authority: &DocumentAuthorityRow,
    scene: &CanvasScene,
    input: NewDocumentCheckpoint<'_>,
    prune: bool,
) -> Result<InsertedDocumentCheckpoint, StoreError> {
    validate_checkpoint_input(&input)?;
    let checkpoint_bytes = canonical_json_bytes(scene.canonical_value())?;
    let checkpoint_hash = sha256(&checkpoint_bytes);
    let actor = checkpoint_actor(&input)?;
    let actor_project_id =
        checkpoint_actor_project_id(connection, &authority.head.library_id, &input)?;
    let actor_json = String::from_utf8(canonical_json_bytes(actor.clone())?)
        .map_err(|_| internal("Checkpoint actor encoding is invalid"))?;
    let links_mutation = matches!(input.revision_kind, "operation" | "restore");
    let source_mutation_id = links_mutation.then_some(input.source_mutation_id).flatten();
    let source_change_seq = links_mutation.then_some(input.source_change_seq).flatten();
    let pinned = i64::from(
        matches!(input.revision_kind, "manual" | "restore")
            || (input.revision_kind == "safety" && input.cause == "canvas_tombstone_compaction"),
    );
    let identity = json!({
        "version": 1,
        "documentId": authority.head.id,
        "actorProjectId": actor_project_id,
        "storeEpoch": read_store_epoch(connection)?,
        "generation": authority.head.generation,
        "baseHeadSeq": authority.head.head_seq,
        "schemaKey": authority.head.schema_key,
        "schemaVersion": authority.head.schema_version,
        "cause": input.cause,
        "label": input.label,
        "actor": actor,
        "revisionKind": input.revision_kind,
        "sourceMutationId": source_mutation_id,
        "sourceChangeSeq": source_change_seq,
        "pinned": pinned == 1,
        "checkpointHash": checkpoint_hash,
        "checkpointMetadata": { "format": CANVAS_CHECKPOINT_FORMAT },
        "materializationHash": checkpoint_hash,
    });
    let version_id = format!(
        "document-version:{}",
        sha256(&canonical_json_bytes(identity)?)
    );
    let byte_length = i64::try_from(checkpoint_bytes.len())
        .map_err(|_| internal("Checkpoint byte length overflowed"))?;
    let inserted = connection.execute(
        "INSERT INTO document_versions (\
           version_id, document_id, project_id, generation, base_head_seq, schema_key, \
           schema_version, cause, label, actor_json, revision_kind, source_mutation_id, \
           source_change_seq, pinned, checkpoint_format, full_update_blob, state_vector, \
           checkpoint_hash, byte_length, created_at\
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, \
                   ?15, ?16, X'', ?17, ?18, ?19) \
         ON CONFLICT(version_id) DO NOTHING",
        params![
            version_id,
            authority.head.id,
            actor_project_id,
            authority.head.generation,
            authority.head.head_seq,
            authority.head.schema_key,
            authority.head.schema_version,
            input.cause,
            input.label,
            actor_json,
            input.revision_kind,
            source_mutation_id,
            source_change_seq,
            pinned,
            CANVAS_CHECKPOINT_FORMAT,
            checkpoint_bytes,
            checkpoint_hash,
            byte_length,
            input.now,
        ],
    )?;
    let stored = read_document_version(connection, &authority.head.id, &version_id)?
        .ok_or_else(|| corrupt("Inserted Canvas checkpoint could not be read"))?;
    if stored.generation != authority.head.generation
        || stored.base_head_seq != authority.head.head_seq
        || stored.checkpoint_hash != checkpoint_hash
        || stored.checkpoint_format != CANVAS_CHECKPOINT_FORMAT
        || stored.cause != input.cause
        || stored.label.as_deref() != input.label
        || stored.actor_json != actor_json
        || stored.revision_kind != input.revision_kind
        || stored.source_mutation_id.as_deref() != source_mutation_id
        || stored.source_change_seq != source_change_seq
        || stored.pinned != pinned
    {
        return Err(StoreError::new(
            StoreErrorCode::IdempotencyKeyReused,
            "Canvas checkpoint identity collides with different immutable content",
            false,
        ));
    }
    let version = decode_document_version(stored)?;
    ensure_document_version_retention_index(
        connection,
        &version_id,
        &checkpoint_hash,
        input.now,
        &version,
    )?;
    if prune {
        prune_document_history(connection, &authority.head.id, input.now)?;
    }
    Ok(InsertedDocumentCheckpoint {
        version,
        duplicate: inserted == 0,
    })
}

pub(crate) fn get_document_version(
    connection: &Connection,
    authority: &DocumentAuthorityRow,
    version_id: &str,
) -> Result<Option<StoredDocumentVersion>, StoreError> {
    validate_identity(version_id, "version_id")?;
    read_document_version(connection, &authority.head.id, version_id)?
        .map(decode_document_version)
        .transpose()
}

pub(crate) fn list_document_versions(
    connection: &Connection,
    authority: &DocumentAuthorityRow,
    before: Option<&DocumentVersionCursor>,
    limit: Option<u32>,
) -> Result<(Vec<Value>, Option<DocumentVersionCursor>), StoreError> {
    let limit = limit.unwrap_or(DEFAULT_HISTORY_LIMIT);
    if limit == 0 || limit > MAX_HISTORY_LIMIT {
        return Err(invalid(format!(
            "Document history limit must be between 1 and {MAX_HISTORY_LIMIT}"
        )));
    }
    let before = before
        .map(|cursor| {
            validate_identity(&cursor.version_id, "before.version_id")?;
            read_document_version(connection, &authority.head.id, &cursor.version_id)?
                .filter(|row| {
                    row.base_head_seq == cursor.base_head_seq && row.created_at == cursor.created_at
                })
                .map(|row| (row.base_head_seq, row.created_at, row.version_id))
                .ok_or_else(|| not_found("Document history cursor was not found"))
        })
        .transpose()?;
    let query_limit = i64::from(limit) + 1;
    let mut statement = connection.prepare(
        "SELECT version_id, document_id, project_id, generation, base_head_seq, schema_key, \
                schema_version, cause, label, actor_json, revision_kind, source_mutation_id, \
                source_change_seq, pinned, checkpoint_format, full_update_blob, state_vector, \
                checkpoint_hash, byte_length, created_at \
         FROM document_versions \
         WHERE document_id = ?1 \
           AND (?2 IS NULL OR base_head_seq < ?3 \
             OR (base_head_seq = ?3 AND created_at < ?4) \
             OR (base_head_seq = ?3 AND created_at = ?4 AND version_id < ?2)) \
         ORDER BY base_head_seq DESC, created_at DESC, version_id DESC LIMIT ?5",
    )?;
    let rows = statement
        .query_map(
            params![
                authority.head.id,
                before.as_ref().map(|value| &value.2),
                before.as_ref().map(|value| value.0),
                before.as_ref().map(|value| &value.1),
                query_limit,
            ],
            decode_row,
        )?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|_| corrupt("Document history row has invalid column types"))?;
    let has_more = rows.len() > usize::try_from(limit).unwrap_or(usize::MAX);
    let rows = rows
        .into_iter()
        .take(usize::try_from(limit).unwrap_or_default())
        .collect::<Vec<_>>();
    let next = has_more
        .then(|| {
            rows.last().map(|row| DocumentVersionCursor {
                base_head_seq: row.base_head_seq,
                created_at: row.created_at.clone(),
                version_id: row.version_id.clone(),
            })
        })
        .flatten();
    let rows = rows
        .into_iter()
        .map(decode_document_version)
        .collect::<Result<Vec<_>, _>>()?;
    Ok((
        rows.into_iter().map(|version| version.summary).collect(),
        next,
    ))
}

pub(crate) fn prepare_version_restore(
    connection: &Connection,
    authority: &DocumentAuthorityRow,
    engine: &YrsDocumentEngine,
    version_id: &str,
    operation_id: &str,
) -> Result<
    Option<(
        PreparedDocumentOperationUpdate,
        crate::library::FileRestorePlan,
    )>,
    StoreError,
> {
    let version = get_document_version(connection, authority, version_id)?
        .ok_or_else(|| not_found("Document version was not found"))?;
    let snapshot = version.file_snapshot.as_ref().ok_or_else(|| {
        StoreError::new(
            StoreErrorCode::Conflict,
            "This legacy version has unresolved File content and cannot be restored in full",
            false,
        )
    })?;
    let hash = version
        .summary
        .get("checkpointHash")
        .and_then(Value::as_str)
        .ok_or_else(|| corrupt("Document checkpoint hash is unavailable"))?;
    super::file_snapshots::validate_index(
        connection,
        &super::file_snapshots::plan_index(connection, version_id, hash, &version)?,
    )?;
    let file_restore = crate::library::plan_file_restore(
        connection,
        &authority.head.library_id,
        operation_id,
        snapshot,
    )?;
    let mut materialization = version.block_materialization.ok_or_else(|| {
        StoreError::new(
            StoreErrorCode::UnsupportedSchema,
            "Canvas version cannot restore into a Yjs Document",
            false,
        )
    })?;
    crate::domain::files::remap_block_files(&mut materialization.block_tree, &file_restore.mapping);
    if materialization.schema.schema_key != authority.head.schema_key
        || i64::from(materialization.schema.schema_version) != authority.head.schema_version
    {
        return Err(StoreError::new(
            StoreErrorCode::UnsupportedSchema,
            "Document version schema cannot restore into the current authority",
            false,
        ));
    }
    let schema = BlockDocumentSchema::from_identity(
        &authority.head.schema_key,
        authority.head.schema_version,
    )
    .ok_or_else(|| {
        StoreError::new(
            StoreErrorCode::UnsupportedSchema,
            "Owned Document schema is unsupported",
            false,
        )
    })?;
    let prepared = super::operations::prepare_document_snapshot_restore_update(
        &authority.head.id,
        schema,
        &engine.full_state_v1(),
        &engine.state_vector_v1(),
        &materialization.block_tree,
        schema
            .has_title()
            .then_some(materialization.rich_title.as_slice()),
    );
    match prepared {
        Ok(prepared) => Ok(Some((prepared, file_restore))),
        Err(error) if error.code() == super::DocumentOperationErrorCode::NoChange => Ok(None),
        Err(error) => Err(invalid(error.to_string())),
    }
}

pub(crate) fn prepare_document_revision(
    connection: &Connection,
    authority: &DocumentAuthorityRow,
    materialization: &DocumentMaterialization,
    context: &BoundModuleContext,
    now: &str,
) -> Result<(), StoreError> {
    prepare_revision(connection, authority, materialization, context, now)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PreparedCanvasRevision {
    operation_id: String,
    cause: &'static str,
    revision_kind: &'static str,
    clear_revision_session: bool,
}

pub(crate) fn prepare_canvas_revision(
    connection: &Connection,
    authority: &DocumentAuthorityRow,
    now: &str,
) -> Result<Option<PreparedCanvasRevision>, StoreError> {
    let session = connection
        .query_row(
            "SELECT generation, last_edit_at FROM document_revision_sessions \
             WHERE document_id = ?1",
            [&authority.head.id],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?;
    if let Some((session_generation, last_edit_at)) = session {
        if session_generation != authority.head.generation {
            connection.execute(
                "DELETE FROM document_revision_sessions WHERE document_id = ?1",
                [&authority.head.id],
            )?;
        } else {
            let idle = connection
                .query_row(
                    "SELECT (julianday(?1) - julianday(?2)) * 86400000 >= 120000",
                    params![now, last_edit_at],
                    |row| row.get::<_, bool>(0),
                )
                .map_err(|_| corrupt("Document revision session timestamp is invalid"))?;
            if !idle {
                return Ok(None);
            }
            return Ok(Some(PreparedCanvasRevision {
                operation_id: format!(
                    "revision-idle:{}:{}:{}",
                    authority.head.id, authority.head.generation, authority.head.head_seq
                ),
                cause: "idle_edit",
                revision_kind: "automatic",
                clear_revision_session: true,
            }));
        }
    }
    let covered = connection
        .query_row(
            "SELECT 1 FROM document_versions \
             WHERE document_id = ?1 AND generation = ?2 AND base_head_seq = ?3 LIMIT 1",
            params![
                authority.head.id,
                authority.head.generation,
                authority.head.head_seq
            ],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if covered {
        return Ok(None);
    }
    Ok(Some(PreparedCanvasRevision {
        operation_id: format!(
            "revision-safety:{}:{}:{}",
            authority.head.id, authority.head.generation, authority.head.head_seq
        ),
        cause: "before_edit_burst",
        revision_kind: "safety",
        clear_revision_session: false,
    }))
}

pub(crate) fn insert_prepared_canvas_revision(
    connection: &Connection,
    authority: &DocumentAuthorityRow,
    scene: &CanvasScene,
    context: &BoundModuleContext,
    now: &str,
    prepared: &PreparedCanvasRevision,
) -> Result<(), StoreError> {
    insert_canvas_checkpoint(
        connection,
        authority,
        scene,
        NewDocumentCheckpoint {
            operation_id: &prepared.operation_id,
            cause: prepared.cause,
            label: None,
            revision_kind: prepared.revision_kind,
            source_mutation_id: None,
            source_change_seq: None,
            actor: None,
            context,
            now,
        },
    )?;
    if prepared.clear_revision_session {
        connection.execute(
            "DELETE FROM document_revision_sessions WHERE document_id = ?1",
            [&authority.head.id],
        )?;
    }
    Ok(())
}

fn prepare_revision(
    connection: &Connection,
    authority: &DocumentAuthorityRow,
    materialization: &DocumentMaterialization,
    context: &BoundModuleContext,
    now: &str,
) -> Result<(), StoreError> {
    let session = connection
        .query_row(
            "SELECT generation, last_edit_at FROM document_revision_sessions \
             WHERE document_id = ?1",
            [&authority.head.id],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?;
    if let Some((session_generation, last_edit_at)) = session {
        if session_generation != authority.head.generation {
            connection.execute(
                "DELETE FROM document_revision_sessions WHERE document_id = ?1",
                [&authority.head.id],
            )?;
        } else {
            let idle = connection
                .query_row(
                    "SELECT (julianday(?1) - julianday(?2)) * 86400000 >= 120000",
                    params![now, last_edit_at],
                    |row| row.get::<_, bool>(0),
                )
                .map_err(|_| corrupt("Document revision session timestamp is invalid"))?;
            if !idle {
                return Ok(());
            }
            let operation_id = format!(
                "revision-idle:{}:{}:{}",
                authority.head.id, authority.head.generation, authority.head.head_seq
            );
            insert_revision_checkpoint(
                connection,
                authority,
                materialization,
                NewDocumentCheckpoint {
                    operation_id: &operation_id,
                    cause: "idle_edit",
                    label: None,
                    revision_kind: "automatic",
                    source_mutation_id: None,
                    source_change_seq: None,
                    actor: None,
                    context,
                    now,
                },
            )?;
            connection.execute(
                "DELETE FROM document_revision_sessions WHERE document_id = ?1",
                [&authority.head.id],
            )?;
            return Ok(());
        }
    }
    if has_current_document_checkpoint(connection, authority, materialization)? {
        return Ok(());
    }
    let operation_id = format!(
        "revision-safety:{}:{}:{}",
        authority.head.id, authority.head.generation, authority.head.head_seq
    );
    insert_revision_checkpoint(
        connection,
        authority,
        materialization,
        NewDocumentCheckpoint {
            operation_id: &operation_id,
            cause: "before_edit_burst",
            label: None,
            revision_kind: "safety",
            source_mutation_id: None,
            source_change_seq: None,
            actor: None,
            context,
            now,
        },
    )?;
    Ok(())
}

fn insert_revision_checkpoint(
    connection: &Connection,
    authority: &DocumentAuthorityRow,
    materialization: &DocumentMaterialization,
    input: NewDocumentCheckpoint<'_>,
) -> Result<(), StoreError> {
    insert_document_checkpoint(connection, authority, materialization, input)?;
    Ok(())
}

pub(crate) fn record_document_revision_edit(
    connection: &Connection,
    document_id: &str,
    generation: i64,
    head_seq: i64,
    client_session_id: &str,
    committed_at: &str,
) -> Result<(), StoreError> {
    let existing = connection
        .query_row(
            "SELECT generation, burst_started_at, last_edit_at, last_checkpoint_at \
             FROM document_revision_sessions WHERE document_id = ?1",
            [document_id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            },
        )
        .optional()?;
    let continues_burst = if let Some(existing) = existing
        .as_ref()
        .filter(|existing| existing.0 == generation)
    {
        connection
            .query_row(
                "SELECT (julianday(?1) - julianday(?2)) * 86400000 < 120000",
                params![committed_at, existing.2],
                |row| row.get::<_, bool>(0),
            )
            .map_err(|_| corrupt("Document revision session timestamp is invalid"))?
    } else {
        false
    };
    let burst_started_at = existing
        .as_ref()
        .filter(|_| continues_burst)
        .map(|existing| existing.1.as_str())
        .unwrap_or(committed_at);
    let last_checkpoint_at = existing
        .as_ref()
        .filter(|_| continues_burst)
        .and_then(|existing| existing.3.as_deref());
    connection.execute(
        "INSERT INTO document_revision_sessions (\
           document_id, generation, dirty_head_seq, burst_started_at, last_edit_at, \
           last_checkpoint_at, client_session_id\
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) \
         ON CONFLICT(document_id) DO UPDATE SET \
           generation = excluded.generation, dirty_head_seq = excluded.dirty_head_seq, \
           burst_started_at = excluded.burst_started_at, last_edit_at = excluded.last_edit_at, \
           last_checkpoint_at = excluded.last_checkpoint_at, \
           client_session_id = excluded.client_session_id",
        params![
            document_id,
            generation,
            head_seq,
            burst_started_at,
            committed_at,
            last_checkpoint_at,
            client_session_id,
        ],
    )?;
    Ok(())
}

/// A shared File edit changes Page content without advancing its Yjs head.
/// Preserve the start of each edit burst and schedule the new exact state for
/// idle history through the Document owner's normal checkpoint rules.
pub(crate) fn prepare_file_content_revisions(
    connection: &Connection,
    context: &BoundModuleContext,
    file_id: &str,
    now: &str,
) -> Result<(), StoreError> {
    let document_ids = connection.prepare(
        "SELECT DISTINCT document_id FROM block_asset_refs WHERE library_id = ?1 AND file_id = ?2 ORDER BY document_id",
    )?.query_map(params![context.library_id.0, file_id], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for document_id in document_ids {
        let authority = super::read_document_authority(connection, &document_id)?
            .ok_or_else(|| corrupt("File placement lost its Document"))?;
        let schema = BlockDocumentSchema::from_identity(
            &authority.head.schema_key,
            authority.head.schema_version,
        )
        .ok_or_else(|| corrupt("File placement Document schema is unsupported"))?;
        let engine = super::reconstruct_yjs_engine(connection, &authority.head)?;
        let decoded = decode_block_document(engine.document(), schema)
            .map_err(|_| corrupt("File placement Document cannot be decoded"))?;
        let materialization = materialize_decoded_document(&decoded)
            .map_err(|_| corrupt("File placement Document cannot be materialized"))?;
        prepare_document_revision(connection, &authority, &materialization, context, now)?;
        record_document_revision_edit(
            connection,
            &document_id,
            authority.head.generation,
            authority.head.head_seq,
            &context.connection_id,
            now,
        )?;
    }
    Ok(())
}

fn read_document_version(
    connection: &Connection,
    document_id: &str,
    version_id: &str,
) -> Result<Option<StoredVersionRow>, StoreError> {
    connection
        .query_row(
            "SELECT version_id, document_id, project_id, generation, base_head_seq, schema_key, \
                    schema_version, cause, label, actor_json, revision_kind, source_mutation_id, \
                    source_change_seq, pinned, checkpoint_format, full_update_blob, state_vector, \
                    checkpoint_hash, byte_length, created_at \
             FROM document_versions WHERE document_id = ?1 AND version_id = ?2",
            params![document_id, version_id],
            decode_row,
        )
        .optional()
        .map_err(StoreError::from)
}

fn decode_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<StoredVersionRow> {
    Ok(StoredVersionRow {
        version_id: row.get(0)?,
        document_id: row.get(1)?,
        actor_project_id: row.get(2)?,
        generation: row.get(3)?,
        base_head_seq: row.get(4)?,
        schema_key: row.get(5)?,
        schema_version: row.get(6)?,
        cause: row.get(7)?,
        label: row.get(8)?,
        actor_json: row.get(9)?,
        revision_kind: row.get(10)?,
        source_mutation_id: row.get(11)?,
        source_change_seq: row.get(12)?,
        pinned: row.get(13)?,
        checkpoint_format: row.get(14)?,
        checkpoint_bytes: row.get(15)?,
        state_vector: row.get(16)?,
        checkpoint_hash: row.get(17)?,
        byte_length: row.get(18)?,
        created_at: row.get(19)?,
    })
}

pub(super) fn has_unindexed_document_version_retention_work(
    connection: &Connection,
) -> Result<bool, StoreError> {
    connection
        .query_row(
            "SELECT EXISTS( \
               SELECT 1 FROM document_versions version \
               WHERE NOT EXISTS ( \
                 SELECT 1 FROM document_version_retention_index retention \
                 WHERE retention.version_id = version.version_id \
               ) OR NOT EXISTS(SELECT 1 FROM document_version_file_index files WHERE files.version_id = version.version_id) LIMIT 1 \
             )",
            [],
            |row| row.get::<_, bool>(0),
        )
        .map_err(StoreError::from)
}

/// Decodes at most one immutable checkpoint on a WAL reader. The resulting
/// value plan lets the writer install a queryable retention index without ever
/// loading all retained history into one maintenance request.
pub(super) fn plan_document_version_retention_backfill(
    connection: &Connection,
) -> Result<Option<DocumentVersionRetentionBackfillPlan>, StoreError> {
    let row = connection
        .query_row(
            "SELECT version.version_id, version.document_id, version.project_id, \
                    version.generation, version.base_head_seq, version.schema_key, \
                    version.schema_version, version.cause, version.label, version.actor_json, \
                    version.revision_kind, version.source_mutation_id, \
                    version.source_change_seq, version.pinned, version.checkpoint_format, \
                    version.full_update_blob, version.state_vector, version.checkpoint_hash, \
                    version.byte_length, version.created_at \
             FROM document_versions version \
             WHERE NOT EXISTS ( \
               SELECT 1 FROM document_version_retention_index retention \
               WHERE retention.version_id = version.version_id \
             ) OR NOT EXISTS(SELECT 1 FROM document_version_file_index files WHERE files.version_id = version.version_id) \
             ORDER BY version.version_id LIMIT 1",
            [],
            decode_row,
        )
        .optional()
        .map_err(|_| corrupt("Document history row has invalid column types"))?;
    let Some(row) = row else {
        return Ok(None);
    };
    check_request_interruption()?;
    let version_id = row.version_id.clone();
    let checkpoint_hash = row.checkpoint_hash.clone();
    let indexed_at =
        connection.query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", [], |row| {
            row.get::<_, String>(0)
        })?;
    let version = decode_document_version(row)?;
    Ok(Some(DocumentVersionRetentionBackfillPlan {
        files: super::file_snapshots::plan_index(
            connection,
            &version_id,
            &checkpoint_hash,
            &version,
        )?,
        version_id,
        checkpoint_hash,
        indexed_at,
        members: document_version_retention_members(&version),
    }))
}

pub(super) fn apply_document_version_retention_backfill(
    connection: &Connection,
    plan: &DocumentVersionRetentionBackfillPlan,
) -> Result<bool, StoreError> {
    let stored_hash = connection
        .query_row(
            "SELECT checkpoint_hash FROM document_versions WHERE version_id = ?1",
            [&plan.version_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    let Some(stored_hash) = stored_hash else {
        return Ok(false);
    };
    if stored_hash != plan.checkpoint_hash {
        return Err(corrupt(
            "Document version changed while its retention index was planned",
        ));
    }
    ensure_document_version_retention_index_from_members(
        connection,
        &plan.version_id,
        &plan.checkpoint_hash,
        &plan.indexed_at,
        &plan.members,
    )?;
    super::file_snapshots::ensure_index(connection, &plan.files)?;
    Ok(true)
}

/// Completes every rebuildable retention index before v152 becomes visible.
/// Legacy Block checkpoints with File references are indexed as explicitly
/// unresolved; migrated Canvas checkpoints already contain exact targets.
pub(crate) fn backfill_migrated_document_history(
    connection: &Connection,
) -> Result<u64, StoreError> {
    let mut indexed = 0_u64;
    while let Some(plan) = plan_document_version_retention_backfill(connection)? {
        if apply_document_version_retention_backfill(connection, &plan)? {
            indexed = indexed
                .checked_add(1)
                .ok_or_else(|| internal("Document history migration count overflowed"))?;
        }
    }
    Ok(indexed)
}

/// Captures one exact post-migration checkpoint per current Document without
/// pruning any legacy history. Retained unowned Documents are recovery state,
/// not current content, and must not acquire an owner-scoped checkpoint.
/// This is the boundary after which every newly
/// created checkpoint has a complete File manifest.
pub(crate) fn insert_migrated_file_baselines(
    connection: &Connection,
    now: &str,
) -> Result<u64, StoreError> {
    let document_ids = connection
        .prepare(
            "SELECT document.id FROM documents document \
             JOIN block_documents ownership ON ownership.document_id = document.id \
               AND ownership.library_id = document.library_id \
             WHERE document.readiness = 'ready' ORDER BY document.id",
        )?
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let actor = json!({ "kind": "store_migration", "revision": 152 });
    let mut inserted = 0_u64;
    for document_id in document_ids {
        let authority = super::read_document_authority(connection, &document_id)?
            .ok_or_else(|| corrupt("Migrated Document authority is missing"))?;
        let profile_id = connection.query_row(
            "SELECT profile_id FROM libraries WHERE id = ?1",
            [&authority.head.library_id],
            |row| row.get::<_, String>(0),
        )?;
        let project_id = crate::library::resolve_library_actor_project_id(
            connection,
            &authority.head.library_id,
        )?;
        let context = BoundModuleContext {
            editor_history_owner: None,
            profile_id: ProfileId(profile_id),
            library_id: LibraryId(authority.head.library_id.clone()),
            project_id: Some(ProjectId(project_id)),
            connection_id: "store-migration:v152".to_owned(),
            adapter: AdapterKind::Test,
        };
        let operation_id = format!("migrate-file-baseline:{document_id}");
        let checkpoint = NewDocumentCheckpoint {
            operation_id: &operation_id,
            cause: "library_file_migration",
            label: Some("File migration baseline"),
            revision_kind: "safety",
            source_mutation_id: None,
            source_change_seq: None,
            actor: Some(&actor),
            context: &context,
            now,
        };
        let duplicate = if authority.head.schema_key == super::canvas_scene::CANVAS_SCHEMA_KEY {
            let scene = super::load_canvas_scene(connection, &authority)?.scene;
            insert_canvas_checkpoint_with_prune(connection, &authority, &scene, checkpoint, false)?
                .duplicate
        } else {
            let schema = BlockDocumentSchema::from_identity(
                &authority.head.schema_key,
                authority.head.schema_version,
            )
            .ok_or_else(|| corrupt("Migrated Document schema is unsupported"))?;
            let engine = super::reconstruct_yjs_engine(connection, &authority.head)?;
            let decoded = decode_block_document(engine.document(), schema)
                .map_err(|_| corrupt("Migrated Document cannot be decoded"))?;
            let materialization = materialize_decoded_document(&decoded)
                .map_err(|_| corrupt("Migrated Document cannot be materialized"))?;
            insert_document_checkpoint_with_prune(
                connection,
                &authority,
                &materialization,
                checkpoint,
                false,
            )?
            .duplicate
        };
        if !duplicate {
            inserted = inserted
                .checked_add(1)
                .ok_or_else(|| internal("Document baseline migration count overflowed"))?;
        }
    }
    Ok(inserted)
}

fn ensure_document_version_retention_index(
    connection: &Connection,
    version_id: &str,
    checkpoint_hash: &str,
    indexed_at: &str,
    version: &StoredDocumentVersion,
) -> Result<(), StoreError> {
    let files =
        super::file_snapshots::plan_index(connection, version_id, checkpoint_hash, version)?;
    super::file_snapshots::ensure_index(connection, &files)?;
    ensure_document_version_retention_index_from_members(
        connection,
        version_id,
        checkpoint_hash,
        indexed_at,
        &document_version_retention_members(version),
    )
}

fn ensure_document_version_retention_index_from_members(
    connection: &Connection,
    version_id: &str,
    checkpoint_hash: &str,
    indexed_at: &str,
    members: &BTreeSet<(String, String)>,
) -> Result<(), StoreError> {
    let expected_count = i64::try_from(members.len())
        .map_err(|_| internal("Document version retention member count overflowed"))?;
    let existing = connection
        .query_row(
            "SELECT checkpoint_hash, member_count \
             FROM document_version_retention_index WHERE version_id = ?1",
            [version_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()?;
    if let Some((stored_hash, stored_count)) = existing {
        if stored_hash != checkpoint_hash || stored_count != expected_count {
            return Err(corrupt("Document version retention index diverges"));
        }
        let stored_members = connection
            .prepare(
                "SELECT member_kind, member_id \
                 FROM document_version_retention_members \
                 WHERE version_id = ?1 ORDER BY member_kind, member_id",
            )?
            .query_map([version_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<BTreeSet<_>>>()?;
        if stored_members != *members {
            return Err(corrupt("Document version retention members diverge"));
        }
        return Ok(());
    }
    connection.execute(
        "INSERT INTO document_version_retention_index( \
           version_id, checkpoint_hash, member_count, indexed_at \
         ) VALUES (?1, ?2, ?3, ?4)",
        params![version_id, checkpoint_hash, expected_count, indexed_at],
    )?;
    let mut insert = connection.prepare_cached(
        "INSERT INTO document_version_retention_members(version_id, member_kind, member_id) \
         VALUES (?1, ?2, ?3)",
    )?;
    for (member_kind, member_id) in members {
        insert.execute(params![version_id, member_kind, member_id])?;
    }
    Ok(())
}

fn document_version_retention_members(
    version: &StoredDocumentVersion,
) -> BTreeSet<(String, String)> {
    let mut members = BTreeSet::new();
    if let Some(materialization) = &version.block_materialization {
        let mut block_ids = BTreeSet::new();
        collect_materialized_block_ids(&materialization.block_tree, &mut block_ids);
        members.extend(
            block_ids
                .into_iter()
                .map(|block_id| ("block".to_owned(), block_id)),
        );
        for reference in &materialization.references {
            if let Some(block_id) = reference.target_block_id() {
                members.insert(("block".to_owned(), block_id.to_owned()));
            }
            if let Some(view_id) = reference.database_view_id() {
                members.insert(("database_view".to_owned(), view_id.to_owned()));
            }
        }
    }
    if let Some(scene) = &version.canvas_scene {
        members.extend(
            scene
                .page_references
                .iter()
                .map(|reference| ("block".to_owned(), reference.target_block_id.clone())),
        );
    }
    members
}

fn collect_materialized_block_ids(blocks: &[MaterializedBlockNode], output: &mut BTreeSet<String>) {
    for block in blocks {
        output.insert(block.id.clone());
        collect_materialized_block_ids(&block.children, output);
    }
}

fn decode_document_version(row: StoredVersionRow) -> Result<StoredDocumentVersion, StoreError> {
    validate_stored_version(&row)?;
    let (
        materialization,
        block_materialization,
        canvas_scene,
        file_snapshot,
        kind,
        title,
        preview,
        block_count,
    ) = if row.checkpoint_format == CANVAS_CHECKPOINT_FORMAT {
        if row.schema_key != super::canvas_scene::CANVAS_SCHEMA_KEY
            || row.schema_version != super::canvas_scene::CANVAS_SCHEMA_VERSION
            || !row.state_vector.is_empty()
        {
            return Err(corrupt("Canvas Document checkpoint schema diverges"));
        }
        let value = serde_json::from_slice::<Value>(&row.checkpoint_bytes)
            .map_err(|_| corrupt("Canvas Document checkpoint JSON is invalid"))?;
        if canonical_json_bytes(value.clone())? != row.checkpoint_bytes {
            return Err(corrupt("Canvas Document checkpoint JSON is not canonical"));
        }
        let scene = parse_canvas_scene(&value)?;
        let preview = scene.preview.clone();
        let block_count = scene.elements.len();
        (
            value,
            None,
            Some(scene),
            None,
            json!("canvas_scene"),
            Value::Null,
            preview,
            block_count,
        )
    } else {
        let schema = BlockDocumentSchema::from_identity(&row.schema_key, row.schema_version)
            .ok_or_else(|| corrupt("Document version uses an unsupported schema"))?;
        let (block, file_snapshot) = match row.checkpoint_format.as_str() {
            CHECKPOINT_FORMAT | "block_tree_snapshot_v2" => {
                decode_block_tree_checkpoint(&row, schema)?
            }
            "yjs_update_v1" => (decode_yjs_checkpoint(&row, schema)?, None),
            _ => return Err(corrupt("Document version checkpoint format is invalid")),
        };
        let value = serde_json::to_value(&block)
            .map_err(|_| internal("Version materialization could not be encoded"))?;
        let kind = serde_json::to_value(block.kind)
            .map_err(|_| internal("Version kind could not be encoded"))?;
        let title = if schema.has_title() {
            Value::String(block.title.clone())
        } else {
            Value::Null
        };
        let preview = block.preview.clone();
        let block_count = count_blocks(&block.block_tree);
        let file_snapshot = if block.file_ids().is_empty() {
            Some(FileSnapshotManifest::default())
        } else {
            file_snapshot
        };
        (
            value,
            Some(block),
            None,
            file_snapshot,
            kind,
            title,
            preview,
            block_count,
        )
    };
    let actor = serde_json::from_str::<Value>(&row.actor_json)
        .ok()
        .filter(Value::is_object)
        .ok_or_else(|| corrupt("Document version actor JSON is invalid"))?;
    let materialization_hash = match block_materialization.as_ref() {
        Some(block) => block_materialization_hash(
            block,
            if row.checkpoint_format == CHECKPOINT_FORMAT {
                file_snapshot.as_ref()
            } else {
                None
            },
        )?,
        None => sha256(&canonical_json_bytes(materialization.clone())?),
    };
    let checkpoint_metadata = if row.checkpoint_format == "yjs_update_v1" {
        json!({
            "format": row.checkpoint_format,
            "stateVectorHash": sha256(&row.state_vector),
        })
    } else {
        json!({ "format": row.checkpoint_format })
    };
    let summary = json!({
        "versionId": row.version_id,
        "documentId": row.document_id,
        "projectId": row.actor_project_id,
        "generation": row.generation,
        "baseHeadSeq": row.base_head_seq,
        "schemaKey": row.schema_key,
        "schemaVersion": row.schema_version,
        "cause": row.cause,
        "label": row.label,
        "actor": actor,
        "revisionKind": row.revision_kind,
        "sourceMutationId": row.source_mutation_id,
        "sourceChangeSeq": row.source_change_seq,
        "pinned": row.pinned == 1,
        "checkpointHash": row.checkpoint_hash,
        "checkpointMetadata": checkpoint_metadata,
        "materializationHash": materialization_hash,
        "byteLength": row.byte_length,
        "materializationKind": kind,
        "title": title,
        "preview": preview,
        "blockCount": block_count,
        "createdAt": row.created_at,
        "fileSnapshotStatus": if file_snapshot.is_some() || canvas_scene.is_some() { "exact" } else if block_materialization.is_some() { "unresolved_legacy" } else { "not_applicable" },
    });
    Ok(StoredDocumentVersion {
        summary,
        materialization,
        block_materialization,
        canvas_scene,
        file_snapshot,
    })
}

fn decode_block_tree_checkpoint(
    row: &StoredVersionRow,
    schema: BlockDocumentSchema,
) -> Result<(DocumentMaterialization, Option<FileSnapshotManifest>), StoreError> {
    if !row.state_vector.is_empty() {
        return Err(corrupt(
            "BlockTree Document checkpoint contains causal Yjs state",
        ));
    }
    let value = serde_json::from_slice::<Value>(&row.checkpoint_bytes)
        .map_err(|_| corrupt("BlockTree Document checkpoint JSON is invalid"))?;
    if canonical_json_bytes(value.clone())? != row.checkpoint_bytes {
        return Err(corrupt(
            "BlockTree Document checkpoint JSON is not canonical",
        ));
    }
    let snapshot = serde_json::from_value::<BlockTreeSnapshot>(value)
        .map_err(|_| corrupt("BlockTree Document checkpoint payload is invalid"))?;
    let expected_version = if row.checkpoint_format == CHECKPOINT_FORMAT {
        3
    } else {
        2
    };
    if snapshot.format_version != expected_version
        || snapshot.kind != super::schema_metadata(schema).kind
        || (expected_version == 3) != snapshot.file_snapshot.is_some()
    {
        return Err(corrupt(
            "BlockTree Document checkpoint schema identity diverges",
        ));
    }
    if schema.has_title() != snapshot.rich_title.is_some() {
        return Err(corrupt(
            "BlockTree Document checkpoint title capability diverges",
        ));
    }
    let block_tree = dematerialize_block_tree(&snapshot.block_tree).map_err(|error| {
        StoreError::new(
            StoreErrorCode::StoreCorrupt,
            format!("BlockTree Document checkpoint has invalid Blocks: {error}"),
            false,
        )
    })?;
    let title = snapshot
        .rich_title
        .as_deref()
        .map(rich_text_to_delta)
        .transpose()
        .map_err(|error| {
            StoreError::new(
                StoreErrorCode::StoreCorrupt,
                format!("BlockTree Document checkpoint has an invalid title: {error}"),
                false,
            )
        })?;
    let document = encode_block_document(&row.document_id, schema, title.as_deref(), &block_tree)
        .map_err(|error| {
        StoreError::new(
            StoreErrorCode::StoreCorrupt,
            format!("BlockTree Document checkpoint cannot reconstruct: {error}"),
            false,
        )
    })?;
    let decoded = decode_block_document(&document, schema)
        .map_err(|_| corrupt("BlockTree Document checkpoint schema is invalid"))?;
    let materialization = materialize_decoded_document(&decoded)
        .map_err(|_| corrupt("BlockTree Document checkpoint materialization is invalid"))?;
    if let Some(manifest) = &snapshot.file_snapshot {
        manifest
            .validate()
            .map_err(|_| corrupt("Document File snapshot is invalid"))?;
        if manifest.files.keys().cloned().collect::<Vec<_>>() != materialization.file_ids() {
            return Err(corrupt(
                "Document File snapshot does not match its canonical references",
            ));
        }
    }
    Ok((materialization, snapshot.file_snapshot))
}

fn decode_yjs_checkpoint(
    row: &StoredVersionRow,
    schema: BlockDocumentSchema,
) -> Result<DocumentMaterialization, StoreError> {
    let engine = YrsDocumentEngine::from_full_state_v1(&row.document_id, &row.checkpoint_bytes)
        .map_err(|_| corrupt("Yjs Document checkpoint cannot reconstruct"))?;
    if engine.state_vector_v1() != row.state_vector {
        return Err(corrupt("Yjs Document checkpoint state vector diverges"));
    }
    let decoded = decode_block_document(engine.document(), schema)
        .map_err(|_| corrupt("Yjs Document checkpoint schema is invalid"))?;
    materialize_decoded_document(&decoded)
        .map_err(|_| corrupt("Yjs Document checkpoint materialization is invalid"))
}

fn validate_stored_version(row: &StoredVersionRow) -> Result<(), StoreError> {
    validate_identity(&row.version_id, "version_id")?;
    validate_identity(&row.document_id, "document_id")?;
    validate_identity(&row.actor_project_id, "actor_project_id")?;
    if row.generation < 1
        || row.base_head_seq < 0
        || row.schema_version < 1
        || row.byte_length != i64::try_from(row.checkpoint_bytes.len()).unwrap_or(-1)
        || row.checkpoint_bytes.is_empty()
        || sha256(&row.checkpoint_bytes) != row.checkpoint_hash
        || !matches!(row.pinned, 0 | 1)
        || !matches!(
            row.revision_kind.as_str(),
            "automatic" | "manual" | "operation" | "restore" | "safety"
        )
        || row.created_at.is_empty()
    {
        return Err(corrupt("Document version row is invalid"));
    }
    Ok(())
}

fn validate_checkpoint_input(input: &NewDocumentCheckpoint<'_>) -> Result<(), StoreError> {
    validate_identity(input.operation_id, "operation_id")?;
    let links_mutation = matches!(input.revision_kind, "operation" | "restore");
    if input.cause.is_empty()
        || input.cause.len() > 128
        || input
            .label
            .is_some_and(|label| label.is_empty() || label.len() > 512)
        || !matches!(
            input.revision_kind,
            "automatic" | "manual" | "operation" | "restore" | "safety"
        )
        || (!links_mutation
            && (input.source_mutation_id.is_some() || input.source_change_seq.is_some()))
        || (links_mutation && input.source_mutation_id.is_none())
        || (input.source_change_seq.is_some() && input.source_mutation_id.is_none())
        || input.source_change_seq.is_some_and(|sequence| sequence < 1)
        || input.now.is_empty()
    {
        return Err(invalid(
            "Document checkpoint metadata is invalid".to_owned(),
        ));
    }
    checkpoint_actor(input)?;
    Ok(())
}

fn checkpoint_actor(input: &NewDocumentCheckpoint<'_>) -> Result<Value, StoreError> {
    let actor = input.actor.cloned().unwrap_or_else(|| {
        json!({
            "adapter": input.context.adapter,
            "connectionId": input.context.connection_id,
        })
    });
    if !actor.is_object() || canonical_json_bytes(actor.clone())?.len() > 64 * 1024 {
        return Err(invalid(
            "Document checkpoint actor must be a bounded portable object".to_owned(),
        ));
    }
    Ok(actor)
}

fn checkpoint_actor_project_id(
    connection: &Connection,
    library_id: &str,
    input: &NewDocumentCheckpoint<'_>,
) -> Result<String, StoreError> {
    input
        .context
        .project_id
        .as_ref()
        .map(|project| project.0.clone())
        .map_or_else(
            || crate::library::resolve_library_actor_project_id(connection, library_id),
            Ok,
        )
}

fn block_materialization_hash(
    materialization: &DocumentMaterialization,
    file_snapshot: Option<&FileSnapshotManifest>,
) -> Result<String, StoreError> {
    let mut semantic = json!({
        "schemaVersion": materialization.schema_version,
        "kind": materialization.kind,
        "blockTree": materialization.block_tree,
        "nfm": materialization.nfm,
        "plainText": materialization.plain_text,
        "preview": materialization.preview,
        "references": materialization.references,
        "assetRefs": materialization.asset_refs,
    });
    if let Some(snapshot) = file_snapshot {
        semantic
            .as_object_mut()
            .ok_or_else(|| internal("Checkpoint materialization identity is invalid"))?
            .insert(
                "fileSnapshot".to_owned(),
                serde_json::to_value(snapshot)
                    .map_err(|_| internal("File snapshot encoding is invalid"))?,
            );
    }
    if materialization.kind == BlockDocumentKind::Page {
        semantic
            .as_object_mut()
            .ok_or_else(|| internal("Checkpoint materialization identity is invalid"))?
            .insert(
                "richTitle".to_owned(),
                serde_json::to_value(&materialization.rich_title)
                    .map_err(|_| internal("Checkpoint rich title could not be encoded"))?,
            );
    }
    Ok(sha256(&canonical_json_bytes(semantic)?))
}

pub(super) fn prune_document_history(
    connection: &Connection,
    document_id: &str,
    now: &str,
) -> Result<usize, StoreError> {
    let version_ids = plan_document_history_prune(connection, document_id, now)?;
    let mut deleted = 0usize;
    for version_id in version_ids {
        deleted = deleted
            .checked_add(connection.execute(
                "DELETE FROM document_versions \
                 WHERE version_id = ?1 AND document_id = ?2 AND pinned = 0",
                params![version_id, document_id],
            )?)
            .ok_or_else(|| corrupt("Document revision deletion count overflowed"))?;
    }
    Ok(deleted)
}

pub(super) fn plan_document_history_prune(
    connection: &Connection,
    document_id: &str,
    now: &str,
) -> Result<Vec<String>, StoreError> {
    const DAY_MS: i64 = 24 * 60 * 60 * 1_000;
    const KEEP_ALL_MS: i64 = 7 * DAY_MS;
    const KEEP_HOURLY_MS: i64 = 30 * DAY_MS;
    const KEEP_DAILY_MS: i64 = 90 * DAY_MS;
    const MAX_UNPINNED: usize = 500;
    let rows = connection
        .prepare(
            "SELECT version_id, created_at, pinned, \
                    CAST(MAX(0, (julianday(?2) - julianday(created_at)) * 86400000) AS INTEGER) \
             FROM document_versions WHERE document_id = ?1 \
             ORDER BY created_at DESC, version_id DESC",
        )?
        .query_map(params![document_id, now], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, Option<i64>>(3)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|_| corrupt("Document revision retention row is invalid"))?;
    let mut hourly = std::collections::HashSet::new();
    let mut daily = std::collections::HashSet::new();
    let mut retained_unpinned = 0usize;
    let mut deletions = Vec::new();
    for (version_id, created_at, pinned, age) in rows {
        if pinned == 1 {
            continue;
        }
        let age = age.ok_or_else(|| corrupt("Document revision timestamp is invalid"))?;
        let retain = if age < KEEP_ALL_MS {
            true
        } else if age < KEEP_HOURLY_MS {
            created_at
                .get(..13)
                .is_some_and(|bucket| hourly.insert(bucket.to_owned()))
        } else if age < KEEP_DAILY_MS {
            created_at
                .get(..10)
                .is_some_and(|bucket| daily.insert(bucket.to_owned()))
        } else {
            false
        };
        if retain && retained_unpinned < MAX_UNPINNED {
            retained_unpinned += 1;
            continue;
        }
        deletions.push(version_id);
    }
    Ok(deletions)
}

fn validate_identity(value: &str, field: &str) -> Result<(), StoreError> {
    if !value.is_empty() && value.len() <= 512 && value.trim() == value {
        return Ok(());
    }
    Err(invalid(format!("{field} is invalid")))
}

pub(crate) fn canonical_json_bytes(value: Value) -> Result<Vec<u8>, StoreError> {
    serde_json::to_vec(&canonical_json(value))
        .map_err(|_| internal("Canonical JSON could not be encoded"))
}

fn canonical_json(value: Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.into_iter().map(canonical_json).collect()),
        Value::Object(entries) => {
            let mut keys = entries.keys().cloned().collect::<Vec<_>>();
            keys.sort();
            let mut output = Map::new();
            for key in keys {
                if let Some(value) = entries.get(&key) {
                    output.insert(key, canonical_json(value.clone()));
                }
            }
            Value::Object(output)
        }
        value => value,
    }
}

fn count_blocks(blocks: &[MaterializedBlockNode]) -> usize {
    blocks
        .iter()
        .map(|block| 1 + count_blocks(&block.children))
        .sum()
}

fn invalid(message: String) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message, false)
}

fn not_found(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::NotFound, message, false)
}

fn corrupt(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message, false)
}

fn internal(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::Internal, message, false)
}
