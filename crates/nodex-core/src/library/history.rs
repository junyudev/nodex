use std::cmp::Ordering;
use std::collections::{BTreeSet, HashSet};

use nodex_core_contracts::events::ResourceKey;
use nodex_core_contracts::library::{
    LibraryBlockRelocationDirection, LibraryDocumentRevisionKind, LibraryDocumentVersionMetadata,
    LibraryPageHistoryCategory, LibraryPageHistoryCursor, LibraryPageHistoryDisplay,
    LibraryPageHistoryEntry, LibraryPageHistoryEntryBase, LibraryPageHistoryEvidence,
    LibraryPageHistoryEvidenceReason, LibraryPageHistoryPage, LibraryPageHistoryRecovery,
    LibraryPageHistoryRecoveryReason,
};
use rusqlite::{Connection, OptionalExtension, params, params_from_iter};
use serde_json::{Map, Value};

use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

const DEFAULT_LIMIT: u32 = 50;
const MAX_LIMIT: u32 = 100;
const MAX_ID_LENGTH: usize = 512;
const MAX_JSON_BYTES: usize = 256 * 1024;
const MAX_JSON_DEPTH: usize = 16;
const MAX_JSON_NODES: usize = 2_048;
const MAX_ARRAY_LENGTH: usize = 1_024;
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

struct PageScope {
    library_id: String,
    page_id: String,
    document_id: String,
    document_generation: i64,
}

struct VersionRow {
    version_id: String,
    document_id: String,
    project_id: String,
    generation: i64,
    base_head_seq: i64,
    schema_key: String,
    schema_version: i64,
    cause: String,
    label: Option<String>,
    actor_json: Option<String>,
    revision_kind: String,
    source_mutation_id: Option<String>,
    source_change_seq: Option<i64>,
    pinned: i64,
    checkpoint_hash: String,
    byte_length: i64,
    created_at: String,
}

struct ChangeRow {
    seq: i64,
    project_id: String,
    store_epoch: String,
    kind: String,
    operation_id: Option<String>,
    block_ids_json: Option<String>,
    document_ids_json: Option<String>,
    database_ids_json: Option<String>,
    payload_json: Option<String>,
    committed_at: String,
    mutation_id: Option<String>,
    mutation_project_id: Option<String>,
    mutation_store_epoch: Option<String>,
    mutation_kind: Option<String>,
    mutation_actor_json: Option<String>,
    mutation_request_hash: Option<String>,
    mutation_block_ids_json: Option<String>,
    mutation_document_ids_json: Option<String>,
    mutation_database_ids_json: Option<String>,
    mutation_field_intents_json: Option<String>,
    mutation_outcome: Option<String>,
    mutation_change_seq: Option<i64>,
    relocation_id: Option<String>,
    relocation_project_id: Option<String>,
    relocation_store_epoch: Option<String>,
    relocation_status: Option<String>,
    relocation_source_document_id: Option<String>,
    relocation_target_document_id: Option<String>,
    relocation_root_ids_json: Option<String>,
    relocation_result_json: Option<String>,
    relocation_change_seq: Option<i64>,
    relocation_committed_at: Option<String>,
}

struct MutationEvidence {
    mutation_id: String,
    mutation_kind: String,
    actor_label: Option<String>,
    affected_block_count: u32,
    field_intent_count: u32,
    payload: Map<String, Value>,
}

struct RelocationEvidence {
    relocation_id: String,
    direction: LibraryBlockRelocationDirection,
    moved_block_count: u32,
}

pub(crate) fn require_page_read_access(
    connection: &Connection,
    library_id: &str,
    project_id: &str,
    page_id: &str,
) -> Result<(), StoreError> {
    require_page_access(connection, library_id, project_id, page_id, false)
}

pub(crate) fn page_read_authorization_roots(
    connection: &Connection,
    library_id: &str,
    project_id: &str,
    page_id: &str,
) -> Result<Option<Vec<ResourceKey>>, StoreError> {
    page_authorization_roots(connection, library_id, project_id, page_id, false, false)
}

/// Lifecycle tooling must be able to inspect an authorized tombstone in order
/// to present and execute its durable restore coordinates. Ordinary Page reads
/// continue to treat deleted Pages as unavailable.
pub(crate) fn require_page_lifecycle_read_access(
    connection: &Connection,
    library_id: &str,
    project_id: &str,
    page_id: &str,
) -> Result<(), StoreError> {
    if page_authorization_roots(connection, library_id, project_id, page_id, false, true)?.is_some()
    {
        return Ok(());
    }
    Err(not_found("Page is not available to the bound Project"))
}

pub(crate) fn require_page_write_access(
    connection: &Connection,
    library_id: &str,
    project_id: &str,
    page_id: &str,
) -> Result<(), StoreError> {
    require_page_access(connection, library_id, project_id, page_id, true)
}

pub(crate) fn require_canvas_read_access(
    connection: &Connection,
    library_id: &str,
    project_id: &str,
    canvas_id: &str,
) -> Result<(), StoreError> {
    require_canvas_access(connection, library_id, project_id, canvas_id, false)
}

pub(crate) fn require_canvas_write_access(
    connection: &Connection,
    library_id: &str,
    project_id: &str,
    canvas_id: &str,
) -> Result<(), StoreError> {
    require_canvas_access(connection, library_id, project_id, canvas_id, true)
}

pub(crate) fn require_canvas_lifecycle_read_access(
    connection: &Connection,
    library_id: &str,
    project_id: &str,
    canvas_id: &str,
) -> Result<(), StoreError> {
    if super::canvas_lifecycle_grant_authorization_proof(
        connection, library_id, project_id, canvas_id,
    )?
    .is_some()
    {
        return Ok(());
    }
    Err(not_found("Canvas is not available to the bound Project"))
}

fn require_canvas_access(
    connection: &Connection,
    library_id: &str,
    project_id: &str,
    canvas_id: &str,
    write_required: bool,
) -> Result<(), StoreError> {
    if super::canvas_grant_authorization_proof(
        connection,
        library_id,
        project_id,
        canvas_id,
        write_required,
    )?
    .is_some()
    {
        return Ok(());
    }
    Err(not_found("Canvas is not available to the bound Project"))
}

fn require_page_access(
    connection: &Connection,
    library_id: &str,
    project_id: &str,
    page_id: &str,
    write_required: bool,
) -> Result<(), StoreError> {
    if page_authorization_roots(
        connection,
        library_id,
        project_id,
        page_id,
        write_required,
        false,
    )?
    .is_some()
    {
        return Ok(());
    }
    Err(not_found("Page is not available to the bound Project"))
}

fn page_authorization_roots(
    connection: &Connection,
    library_id: &str,
    project_id: &str,
    page_id: &str,
    write_required: bool,
    include_deleted: bool,
) -> Result<Option<Vec<ResourceKey>>, StoreError> {
    let project: Option<Option<String>> = connection
        .query_row(
            "SELECT database_block_id FROM projects WHERE id = ?1 AND library_id = ?2",
            params![project_id, library_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?;
    let Some(primary_database_id) = project else {
        return Ok(None);
    };
    let page_lifecycle = connection
        .query_row(
            "SELECT block.lifecycle FROM pages page \
             JOIN blocks block ON block.id = page.block_id AND block.type = 'page' \
             WHERE page.block_id = ?1 AND page.library_id = ?2 \
               AND block.library_id = page.library_id",
            params![page_id, library_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    let Some(page_lifecycle) = page_lifecycle else {
        return Ok(None);
    };
    if page_lifecycle == "deleted" && !include_deleted {
        return Ok(None);
    }
    let database_id = owning_database(connection, library_id, page_id)?;
    let mut roots = BTreeSet::from([ResourceKey::Page {
        page_id: page_id.to_owned(),
    }]);
    let primary_database = database_id.is_some() && database_id == primary_database_id;
    let mut database_grant = false;
    if let Some(database_id) = database_id.as_ref() {
        database_grant = connection
            .query_row(
                "SELECT 1 FROM project_resource_grants WHERE project_id = ?1 \
                 AND root_kind = 'database' AND root_id = ?2 AND lifecycle = 'active' \
                 AND (?3 = 0 OR access = 'read_write')",
                params![project_id, database_id, i64::from(write_required)],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        if primary_database || database_grant {
            roots.insert(ResourceKey::Database {
                database_id: database_id.clone(),
            });
        }
    }
    let page_grant_proof =
        super::page_grant_ownership_proof(connection, project_id, page_id, write_required)?;
    if let Some(proof) = &page_grant_proof {
        roots.extend(proof.iter().cloned());
    }
    if primary_database || database_grant || page_grant_proof.is_some() {
        return Ok(Some(roots.into_iter().collect()));
    }
    Ok(None)
}

pub(super) fn page_history(
    connection: &Connection,
    library_id: &str,
    requesting_project_id: Option<&str>,
    page_id: &str,
    before: Option<LibraryPageHistoryCursor>,
    limit: Option<u32>,
) -> Result<LibraryPageHistoryPage, StoreError> {
    validate_id(page_id, "page_id")?;
    let project_id = requesting_project_id
        .ok_or_else(|| unauthorized("Page history requires a bound Project"))?;
    validate_id(project_id, "project_id")?;
    let limit = limit.unwrap_or(DEFAULT_LIMIT);
    if limit == 0 || limit > MAX_LIMIT {
        return Err(invalid("Page history limit must be between 1 and 100"));
    }
    validate_cursor(before.as_ref())?;
    let scope = read_scope(connection, library_id, project_id, page_id)?;
    let candidate_limit = i64::from(limit) + 1;
    let mut entries = read_versions(connection, &scope, before.as_ref(), candidate_limit)?
        .into_iter()
        .map(|row| decode_version(row, &scope))
        .collect::<Result<Vec<_>, _>>()?;
    entries.extend(
        read_changes(connection, &scope, before.as_ref(), candidate_limit)?
            .into_iter()
            .map(|row| decode_change(row, &scope))
            .collect::<Result<Vec<_>, _>>()?,
    );
    entries.sort_by(compare_entries);
    let has_more = entries.len() > limit as usize;
    entries.truncate(limit as usize);
    let next_cursor = has_more
        .then(|| entries.last().map(cursor_for_entry))
        .flatten();
    Ok(LibraryPageHistoryPage {
        library_id: scope.library_id,
        page_id: scope.page_id,
        document_id: scope.document_id,
        entries,
        next_cursor,
    })
}

fn read_scope(
    connection: &Connection,
    library_id: &str,
    project_id: &str,
    page_id: &str,
) -> Result<PageScope, StoreError> {
    if page_read_authorization_roots(connection, library_id, project_id, page_id)?.is_none() {
        return Err(not_found("Page is not available to the bound Project"));
    }
    let row = connection
        .query_row(
            "SELECT page.document_id, document.library_id, document.generation, \
               document.readiness, ownership.document_id \
             FROM pages page JOIN blocks block ON block.id = page.block_id AND block.type = 'page' \
               AND block.library_id = page.library_id \
             LEFT JOIN documents document ON document.id = page.document_id \
               AND document.library_id = page.library_id \
             LEFT JOIN block_documents ownership ON ownership.block_id = page.block_id \
               AND ownership.library_id = page.library_id \
             WHERE page.block_id = ?1 AND page.library_id = ?2",
            params![page_id, library_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| not_found("Page is not available to the bound Project"))?;
    if row.1.as_deref() != Some(library_id)
        || row.2.is_none_or(|generation| !safe_integer(generation, 1))
        || row.3.as_deref() != Some("ready")
        || row.4.as_deref() != Some(row.0.as_str())
    {
        return Err(corrupt("Page has no current ready owned Document"));
    }
    Ok(PageScope {
        library_id: library_id.to_owned(),
        page_id: page_id.to_owned(),
        document_id: row.0,
        document_generation: row.2.expect("validated Document generation"),
    })
}

fn owning_database(
    connection: &Connection,
    library_id: &str,
    page_id: &str,
) -> Result<Option<String>, StoreError> {
    let terminal = connection
        .query_row(
            "WITH RECURSIVE ancestors(page_id, parent_kind, parent_id, path) AS ( \
               SELECT block_id, parent_kind, parent_id, '|' || block_id || '|' FROM pages \
                 WHERE block_id = ?1 AND library_id = ?2 \
               UNION ALL \
               SELECT parent.block_id, parent.parent_kind, parent.parent_id, \
                 ancestors.path || parent.block_id || '|' \
               FROM pages parent JOIN ancestors \
                 ON ancestors.parent_kind = 'page' AND parent.block_id = ancestors.parent_id \
               WHERE parent.library_id = ?2 \
                 AND instr(ancestors.path, '|' || parent.block_id || '|') = 0 \
             ) SELECT parent_kind, parent_id FROM ancestors \
               WHERE parent_kind <> 'page' LIMIT 1",
            params![page_id, library_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?
        .ok_or_else(|| not_found("Page is not available to the bound Project"))?;
    match terminal.0.as_str() {
        "library" if terminal.1 == library_id => Ok(None),
        "data_source" => connection
            .query_row(
                "SELECT home_database_block_id FROM data_sources \
                 WHERE id = ?1 AND library_id = ?2",
                params![terminal.1, library_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .map(Some)
            .ok_or_else(|| not_found("Page is not available to the bound Project")),
        _ => Err(not_found("Page is not available to the bound Project")),
    }
}

fn read_versions(
    connection: &Connection,
    scope: &PageScope,
    before: Option<&LibraryPageHistoryCursor>,
    limit: i64,
) -> Result<Vec<VersionRow>, StoreError> {
    let (predicate, cursor_parameters): (&str, Vec<rusqlite::types::Value>) = match before {
        None => ("", Vec::new()),
        Some(LibraryPageHistoryCursor::ChangeLog { occurred_at, .. }) => (
            "AND version.created_at < ?",
            vec![occurred_at.clone().into()],
        ),
        Some(LibraryPageHistoryCursor::DocumentVersion {
            occurred_at,
            version_id,
        }) => (
            "AND (version.created_at < ? OR (version.created_at = ? AND version.version_id < ?))",
            vec![
                occurred_at.clone().into(),
                occurred_at.clone().into(),
                version_id.clone().into(),
            ],
        ),
    };
    let sql = format!(
        "SELECT version_id, document_id, project_id, generation, base_head_seq, schema_key, \
           schema_version, cause, label, CASE WHEN length(CAST(actor_json AS BLOB)) <= {MAX_JSON_BYTES} \
           THEN actor_json ELSE NULL END, revision_kind, source_mutation_id, source_change_seq, \
           pinned, checkpoint_hash, byte_length, created_at FROM document_versions version \
         WHERE document_id = ? {predicate} \
         ORDER BY created_at DESC, version_id DESC LIMIT ?"
    );
    let mut parameters = vec![scope.document_id.clone().into()];
    parameters.extend(cursor_parameters);
    parameters.push(limit.into());
    connection
        .prepare(&sql)?
        .query_map(params_from_iter(parameters), |row| {
            Ok(VersionRow {
                version_id: row.get(0)?,
                document_id: row.get(1)?,
                project_id: row.get(2)?,
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
                checkpoint_hash: row.get(14)?,
                byte_length: row.get(15)?,
                created_at: row.get(16)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(StoreError::from)
}

fn bounded_json_column(column: &str, maximum: usize) -> String {
    format!("CASE WHEN length(CAST({column} AS BLOB)) <= {maximum} THEN {column} ELSE NULL END")
}

fn read_changes(
    connection: &Connection,
    scope: &PageScope,
    before: Option<&LibraryPageHistoryCursor>,
    limit: i64,
) -> Result<Vec<ChangeRow>, StoreError> {
    let (predicate, cursor_parameters): (&str, Vec<rusqlite::types::Value>) = match before {
        None => ("", Vec::new()),
        Some(LibraryPageHistoryCursor::DocumentVersion { occurred_at, .. }) => (
            "AND change.committed_at <= ?",
            vec![occurred_at.clone().into()],
        ),
        Some(LibraryPageHistoryCursor::ChangeLog {
            occurred_at,
            change_seq,
        }) => (
            "AND (change.committed_at < ? OR (change.committed_at = ? AND change.seq < ?))",
            vec![
                occurred_at.clone().into(),
                occurred_at.clone().into(),
                (*change_seq).into(),
            ],
        ),
    };
    let block_ids = bounded_json_column("change.block_ids_json", MAX_JSON_BYTES);
    let document_ids = bounded_json_column("change.document_ids_json", MAX_JSON_BYTES);
    let sql = format!(
        "SELECT change.seq, change.project_id, change.store_epoch, change.kind, change.operation_id, \
           {block_ids}, {document_ids}, {database_ids}, {payload}, change.committed_at, \
           mutation.mutation_id, mutation.project_id, mutation.store_epoch, mutation.mutation_kind, \
           {actor}, mutation.request_hash, {mutation_blocks}, {mutation_documents}, \
           {mutation_databases}, {field_intents}, mutation.outcome, mutation.change_log_seq, \
           relocation.id, relocation.project_id, relocation.store_epoch, relocation.status, \
           relocation.source_document_id, relocation.target_document_id, {relocation_roots}, \
           {relocation_result}, relocation.change_log_seq, relocation.committed_at \
         FROM change_log change LEFT JOIN block_mutations mutation \
           ON mutation.change_log_seq = change.seq AND mutation.project_id = change.project_id \
         LEFT JOIN block_relocations relocation \
           ON relocation.change_log_seq = change.seq AND relocation.project_id = change.project_id \
         WHERE change.kind IN ('block_mutation', 'block_relocation') \
           AND NOT EXISTS (SELECT 1 FROM document_versions version \
             WHERE version.document_id = ? \
               AND version.source_change_seq = change.seq) \
           AND (EXISTS (SELECT 1 FROM json_each(CASE \
             WHEN length(CAST(change.block_ids_json AS BLOB)) <= {MAX_JSON_BYTES} \
               AND json_valid(change.block_ids_json) THEN change.block_ids_json ELSE '[]' END) item \
             WHERE item.type = 'text' AND item.value = ?) \
             OR EXISTS (SELECT 1 FROM json_each(CASE \
             WHEN length(CAST(change.document_ids_json AS BLOB)) <= {MAX_JSON_BYTES} \
               AND json_valid(change.document_ids_json) THEN change.document_ids_json ELSE '[]' END) item \
               WHERE item.type = 'text' AND item.value = ?)) {predicate} \
         ORDER BY change.committed_at DESC, change.seq DESC LIMIT ?",
        database_ids = bounded_json_column("change.database_block_ids_json", MAX_JSON_BYTES),
        payload = bounded_json_column("change.payload_json", MAX_JSON_BYTES),
        actor = bounded_json_column("mutation.actor_json", MAX_JSON_BYTES),
        mutation_blocks = bounded_json_column("mutation.target_block_ids_json", MAX_JSON_BYTES),
        mutation_documents =
            bounded_json_column("mutation.affected_document_ids_json", MAX_JSON_BYTES),
        mutation_databases =
            bounded_json_column("mutation.affected_database_block_ids_json", MAX_JSON_BYTES),
        field_intents = bounded_json_column("mutation.field_intents_json", MAX_JSON_BYTES),
        relocation_roots = bounded_json_column("relocation.root_block_ids_json", MAX_JSON_BYTES),
        relocation_result = bounded_json_column("relocation.result_json", MAX_JSON_BYTES),
    );
    let mut parameters = vec![
        scope.document_id.clone().into(),
        scope.page_id.clone().into(),
        scope.document_id.clone().into(),
    ];
    parameters.extend(cursor_parameters);
    parameters.push(limit.into());
    connection
        .prepare(&sql)?
        .query_map(params_from_iter(parameters), |row| {
            Ok(ChangeRow {
                seq: row.get(0)?,
                project_id: row.get(1)?,
                store_epoch: row.get(2)?,
                kind: row.get(3)?,
                operation_id: row.get(4)?,
                block_ids_json: row.get(5)?,
                document_ids_json: row.get(6)?,
                database_ids_json: row.get(7)?,
                payload_json: row.get(8)?,
                committed_at: row.get(9)?,
                mutation_id: row.get(10)?,
                mutation_project_id: row.get(11)?,
                mutation_store_epoch: row.get(12)?,
                mutation_kind: row.get(13)?,
                mutation_actor_json: row.get(14)?,
                mutation_request_hash: row.get(15)?,
                mutation_block_ids_json: row.get(16)?,
                mutation_document_ids_json: row.get(17)?,
                mutation_database_ids_json: row.get(18)?,
                mutation_field_intents_json: row.get(19)?,
                mutation_outcome: row.get(20)?,
                mutation_change_seq: row.get(21)?,
                relocation_id: row.get(22)?,
                relocation_project_id: row.get(23)?,
                relocation_store_epoch: row.get(24)?,
                relocation_status: row.get(25)?,
                relocation_source_document_id: row.get(26)?,
                relocation_target_document_id: row.get(27)?,
                relocation_root_ids_json: row.get(28)?,
                relocation_result_json: row.get(29)?,
                relocation_change_seq: row.get(30)?,
                relocation_committed_at: row.get(31)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(StoreError::from)
}

fn decode_version(
    row: VersionRow,
    scope: &PageScope,
) -> Result<LibraryPageHistoryEntry, StoreError> {
    if row.document_id != scope.document_id
        || !bounded(&row.project_id)
        || !safe_integer(row.generation, 1)
        || !safe_integer(row.base_head_seq, 0)
        || !safe_integer(row.schema_version, 1)
        || !bounded(&row.version_id)
        || !bounded_with(&row.schema_key, 128)
        || !bounded_with(&row.cause, 128)
        || row
            .label
            .as_ref()
            .is_some_and(|label| js_length(label) > 512)
        || row
            .source_mutation_id
            .as_ref()
            .is_some_and(|mutation_id| !bounded(mutation_id))
        || row
            .source_change_seq
            .is_some_and(|change_seq| !safe_integer(change_seq, 1))
        || row.pinned < 0
        || row.pinned > 1
        || !hex_hash(&row.checkpoint_hash)
        || !safe_integer(row.byte_length, 1)
        || !canonical_timestamp(&row.created_at)
    {
        return Err(corrupt("Document version has invalid immutable metadata"));
    }
    let revision_kind = match row.revision_kind.as_str() {
        "automatic" => LibraryDocumentRevisionKind::Automatic,
        "manual" => LibraryDocumentRevisionKind::Manual,
        "operation" => LibraryDocumentRevisionKind::Operation,
        "restore" => LibraryDocumentRevisionKind::Restore,
        "safety" => LibraryDocumentRevisionKind::Safety,
        _ => return Err(corrupt("Document version revision kind is invalid")),
    };
    let actor = row.actor_json.as_deref().and_then(parse_object);
    let actor_label = actor.as_ref().and_then(actor_label);
    let (category, title, detail) = match revision_kind {
        LibraryDocumentRevisionKind::Automatic => (
            LibraryPageHistoryCategory::Content,
            "Edited Page".to_owned(),
            Some("Automatic revision".to_owned()),
        ),
        LibraryDocumentRevisionKind::Operation => (
            LibraryPageHistoryCategory::Content,
            "Edited Page content".to_owned(),
            Some(row.label.clone().unwrap_or_else(|| row.cause.clone())),
        ),
        LibraryDocumentRevisionKind::Restore => (
            LibraryPageHistoryCategory::Content,
            if row.cause == "before_restore" {
                "Before restore".to_owned()
            } else {
                "Restored Page content".to_owned()
            },
            Some(row.label.clone().unwrap_or_else(|| row.cause.clone())),
        ),
        LibraryDocumentRevisionKind::Safety => (
            LibraryPageHistoryCategory::Checkpoint,
            "Before editing".to_owned(),
            Some("Safety revision".to_owned()),
        ),
        LibraryDocumentRevisionKind::Manual => (
            LibraryPageHistoryCategory::Checkpoint,
            row.label
                .clone()
                .unwrap_or_else(|| "Saved Page revision".to_owned()),
            Some(if row.label.is_some() {
                "Named revision".to_owned()
            } else {
                "Manual revision".to_owned()
            }),
        ),
    };
    let version_id = row.version_id.clone();
    Ok(LibraryPageHistoryEntry::DocumentVersion {
        entry: LibraryPageHistoryEntryBase {
            id: format!("document-version:{version_id}"),
            library_id: scope.library_id.clone(),
            page_id: scope.page_id.clone(),
            document_id: scope.document_id.clone(),
            occurred_at: row.created_at,
            display: LibraryPageHistoryDisplay {
                category,
                title,
                detail,
                actor_label,
            },
            evidence: if actor.is_some() {
                LibraryPageHistoryEvidence::Verified
            } else {
                LibraryPageHistoryEvidence::Unavailable {
                    reason: LibraryPageHistoryEvidenceReason::MalformedEvidence,
                }
            },
            recovery: if row.generation == scope.document_generation {
                LibraryPageHistoryRecovery::RestoreDocumentVersion {
                    document_id: scope.document_id.clone(),
                    version_id: version_id.clone(),
                }
            } else {
                LibraryPageHistoryRecovery::Unavailable {
                    reason: LibraryPageHistoryRecoveryReason::DocumentGenerationChanged,
                }
            },
        },
        version_metadata: LibraryDocumentVersionMetadata {
            version_id,
            generation: row.generation,
            base_head_seq: row.base_head_seq,
            schema_key: row.schema_key,
            schema_version: row.schema_version,
            cause: row.cause,
            label: row.label,
            revision_kind,
            source_mutation_id: row.source_mutation_id,
            source_change_seq: row.source_change_seq,
            pinned: row.pinned == 1,
            checkpoint_hash: row.checkpoint_hash,
            byte_length: row.byte_length,
        },
    })
}

fn decode_change(row: ChangeRow, scope: &PageScope) -> Result<LibraryPageHistoryEntry, StoreError> {
    if !bounded(&row.project_id) || !safe_integer(row.seq, 1) {
        return Err(corrupt("Page history change has an invalid actor scope"));
    }
    if !canonical_timestamp(&row.committed_at) {
        return Err(corrupt("Page history change timestamp is invalid"));
    }
    match row.kind.as_str() {
        "block_mutation" => decode_mutation(row, scope),
        "block_relocation" => decode_relocation(row, scope),
        _ => Err(corrupt("Page history change kind is invalid")),
    }
}

fn decode_mutation(
    row: ChangeRow,
    scope: &PageScope,
) -> Result<LibraryPageHistoryEntry, StoreError> {
    let evidence = mutation_evidence(&row);
    let recovery_reason = if evidence.is_ok() {
        LibraryPageHistoryRecoveryReason::NoInverseContract
    } else {
        LibraryPageHistoryRecoveryReason::InsufficientEvidence
    };
    let (display, public_evidence, mutation_id, mutation_kind, blocks, intents) = match evidence {
        Ok(evidence) => (
            mutation_display(&evidence),
            LibraryPageHistoryEvidence::Verified,
            Some(evidence.mutation_id),
            Some(evidence.mutation_kind),
            Some(evidence.affected_block_count),
            Some(evidence.field_intent_count),
        ),
        Err(reason) => (
            unknown_display(None),
            LibraryPageHistoryEvidence::Unavailable { reason },
            None,
            None,
            None,
            None,
        ),
    };
    Ok(LibraryPageHistoryEntry::BlockMutation {
        entry: change_entry_base(scope, &row, display, public_evidence, recovery_reason),
        change_seq: row.seq,
        mutation_id,
        mutation_kind,
        affected_block_count: blocks,
        field_intent_count: intents,
    })
}

fn mutation_evidence(
    row: &ChangeRow,
) -> Result<MutationEvidence, LibraryPageHistoryEvidenceReason> {
    let mutation_id = row
        .mutation_id
        .as_ref()
        .ok_or(LibraryPageHistoryEvidenceReason::MissingLedger)?;
    let actor = row
        .mutation_actor_json
        .as_deref()
        .and_then(parse_object)
        .ok_or(LibraryPageHistoryEvidenceReason::MalformedEvidence)?;
    let payload = row
        .payload_json
        .as_deref()
        .and_then(parse_object)
        .ok_or(LibraryPageHistoryEvidenceReason::MalformedEvidence)?;
    let field_intents = row
        .mutation_field_intents_json
        .as_deref()
        .and_then(parse_array)
        .ok_or(LibraryPageHistoryEvidenceReason::MalformedEvidence)?;
    let change_blocks = string_array(row.block_ids_json.as_deref());
    let change_documents = string_array(row.document_ids_json.as_deref());
    let change_databases = string_array(row.database_ids_json.as_deref());
    let mutation_blocks = string_array(row.mutation_block_ids_json.as_deref());
    let mutation_documents = string_array(row.mutation_document_ids_json.as_deref());
    let mutation_databases = string_array(row.mutation_database_ids_json.as_deref());
    let request_hash = row.mutation_request_hash.as_deref();
    if row.operation_id.as_deref() != Some(mutation_id)
        || row.mutation_project_id.as_deref() != Some(row.project_id.as_str())
        || row.mutation_store_epoch.as_deref() != Some(row.store_epoch.as_str())
        || row.mutation_outcome.as_deref() != Some("committed")
        || row.mutation_change_seq != Some(row.seq)
        || row
            .mutation_kind
            .as_deref()
            .is_none_or(|kind| !bounded_with(kind, 128))
        || request_hash.is_none_or(|hash| !hex_hash(hash))
        || change_blocks.is_none()
        || change_documents.is_none()
        || change_databases.is_none()
        || mutation_blocks.is_none()
        || mutation_documents.is_none()
        || mutation_databases.is_none()
        || !same_set(
            change_blocks.as_ref().unwrap(),
            mutation_blocks.as_ref().unwrap(),
        )
        || !same_set(
            change_documents.as_ref().unwrap(),
            mutation_documents.as_ref().unwrap(),
        )
        || !same_set(
            change_databases.as_ref().unwrap(),
            mutation_databases.as_ref().unwrap(),
        )
        || payload.get("requestHash").and_then(Value::as_str) != request_hash
    {
        return Err(LibraryPageHistoryEvidenceReason::MalformedEvidence);
    }
    Ok(MutationEvidence {
        mutation_id: mutation_id.clone(),
        mutation_kind: row.mutation_kind.clone().unwrap(),
        actor_label: actor_label(&actor),
        affected_block_count: u32::try_from(change_blocks.unwrap().len())
            .map_err(|_| LibraryPageHistoryEvidenceReason::MalformedEvidence)?,
        field_intent_count: u32::try_from(field_intents.len())
            .map_err(|_| LibraryPageHistoryEvidenceReason::MalformedEvidence)?,
        payload,
    })
}

fn mutation_display(evidence: &MutationEvidence) -> LibraryPageHistoryDisplay {
    let detail_count = |label: &str, count: u32| {
        Some(format!(
            "{count} {label} intent{}",
            if count == 1 { "" } else { "s" }
        ))
    };
    let (category, title, detail) = match evidence.mutation_kind.as_str() {
        "page_lifecycle" => {
            let operation = evidence.payload.get("operation").and_then(Value::as_str);
            match operation {
                Some("create_page") => {
                    (LibraryPageHistoryCategory::Lifecycle, "Created Page", None)
                }
                Some("archive_page") => {
                    (LibraryPageHistoryCategory::Lifecycle, "Archived Page", None)
                }
                Some("unarchive_page") => (
                    LibraryPageHistoryCategory::Lifecycle,
                    "Unarchived Page",
                    None,
                ),
                Some("delete_page") => {
                    (LibraryPageHistoryCategory::Lifecycle, "Deleted Page", None)
                }
                Some("restore_page") => {
                    (LibraryPageHistoryCategory::Lifecycle, "Restored Page", None)
                }
                Some("move_page_in_library") => (
                    LibraryPageHistoryCategory::Location,
                    "Reordered Page in Library",
                    None,
                ),
                _ => return unknown_display(evidence.actor_label.clone()),
            }
        }
        "property_batch" => (
            LibraryPageHistoryCategory::Property,
            "Updated Page properties",
            detail_count("field", evidence.field_intent_count),
        ),
        "database_operation" => {
            let operations = evidence
                .payload
                .get("operationKinds")
                .and_then(Value::as_array)
                .filter(|items| items.len() <= 256)
                .filter(|items| {
                    items.iter().all(|item| {
                        item.as_str()
                            .is_some_and(|operation| bounded_with(operation, 128))
                    })
                })
                .map(|items| items.iter().filter_map(Value::as_str).collect::<Vec<_>>())
                .unwrap_or_default();
            if operations
                .iter()
                .any(|operation| matches!(*operation, "position_page" | "position_pages"))
            {
                (
                    LibraryPageHistoryCategory::Database,
                    "Reordered Page in a database View",
                    None,
                )
            } else if operations
                .iter()
                .any(|operation| matches!(*operation, "transfer_page" | "transfer_membership"))
            {
                (
                    LibraryPageHistoryCategory::Database,
                    "Changed Page database membership",
                    None,
                )
            } else {
                (
                    LibraryPageHistoryCategory::Database,
                    "Updated Page database values",
                    detail_count("field", evidence.field_intent_count),
                )
            }
        }
        "document_operation_batch" => (
            LibraryPageHistoryCategory::Content,
            "Edited Page content",
            None,
        ),
        "replace_document_from_nfm" => (
            LibraryPageHistoryCategory::Content,
            "Replaced Page content from NFM",
            None,
        ),
        _ => return unknown_display(evidence.actor_label.clone()),
    };
    LibraryPageHistoryDisplay {
        category,
        title: title.to_owned(),
        detail,
        actor_label: evidence.actor_label.clone(),
    }
}

fn decode_relocation(
    row: ChangeRow,
    scope: &PageScope,
) -> Result<LibraryPageHistoryEntry, StoreError> {
    let evidence = relocation_evidence(&row, scope);
    let recovery_reason = if evidence.is_ok() {
        LibraryPageHistoryRecoveryReason::NoInverseContract
    } else {
        LibraryPageHistoryRecoveryReason::InsufficientEvidence
    };
    let (display, public_evidence, relocation_id, direction, moved_count) = match evidence {
        Ok(evidence) => (
            relocation_display(&evidence),
            LibraryPageHistoryEvidence::Verified,
            Some(evidence.relocation_id),
            evidence.direction,
            Some(evidence.moved_block_count),
        ),
        Err(reason) => (
            unknown_display(None),
            LibraryPageHistoryEvidence::Unavailable { reason },
            None,
            LibraryBlockRelocationDirection::Unknown,
            None,
        ),
    };
    Ok(LibraryPageHistoryEntry::BlockRelocation {
        entry: change_entry_base(scope, &row, display, public_evidence, recovery_reason),
        change_seq: row.seq,
        relocation_id,
        direction,
        moved_block_count: moved_count,
    })
}

fn relocation_evidence(
    row: &ChangeRow,
    scope: &PageScope,
) -> Result<RelocationEvidence, LibraryPageHistoryEvidenceReason> {
    let relocation_id = row
        .relocation_id
        .as_ref()
        .ok_or(LibraryPageHistoryEvidenceReason::MissingLedger)?;
    let change_blocks = string_array(row.block_ids_json.as_deref());
    let change_documents = string_array(row.document_ids_json.as_deref());
    let roots = string_array(row.relocation_root_ids_json.as_deref());
    if row.operation_id.as_deref() != Some(relocation_id)
        || row.relocation_project_id.as_deref() != Some(row.project_id.as_str())
        || row.relocation_store_epoch.as_deref() != Some(row.store_epoch.as_str())
        || row.relocation_status.as_deref() != Some("committed")
        || row.relocation_change_seq != Some(row.seq)
        || row.relocation_committed_at.as_deref() != Some(row.committed_at.as_str())
        || row.relocation_source_document_id.is_none()
        || row.relocation_target_document_id.is_none()
        || row
            .relocation_result_json
            .as_deref()
            .and_then(parse_object)
            .is_none()
        || change_blocks.is_none()
        || change_documents.is_none()
        || roots.is_none()
    {
        return Err(LibraryPageHistoryEvidenceReason::MalformedEvidence);
    }
    let change_blocks = change_blocks.unwrap();
    let change_documents = change_documents.unwrap();
    let roots = roots.unwrap();
    if !change_documents.contains(row.relocation_source_document_id.as_ref().unwrap())
        || !change_documents.contains(row.relocation_target_document_id.as_ref().unwrap())
        || !roots.iter().all(|root| change_blocks.contains(root))
    {
        return Err(LibraryPageHistoryEvidenceReason::MalformedEvidence);
    }
    let source = row.relocation_source_document_id.as_deref() == Some(&scope.document_id);
    let target = row.relocation_target_document_id.as_deref() == Some(&scope.document_id);
    let direction = match (source, target) {
        (true, true) => LibraryBlockRelocationDirection::WithinPage,
        (true, false) => LibraryBlockRelocationDirection::OutOfPage,
        (false, true) => LibraryBlockRelocationDirection::IntoPage,
        (false, false) => LibraryBlockRelocationDirection::Unknown,
    };
    Ok(RelocationEvidence {
        relocation_id: relocation_id.clone(),
        direction,
        moved_block_count: u32::try_from(change_blocks.len())
            .map_err(|_| LibraryPageHistoryEvidenceReason::MalformedEvidence)?,
    })
}

fn relocation_display(evidence: &RelocationEvidence) -> LibraryPageHistoryDisplay {
    let title = match evidence.direction {
        LibraryBlockRelocationDirection::IntoPage => "Moved blocks into Page",
        LibraryBlockRelocationDirection::OutOfPage => "Moved blocks out of Page",
        LibraryBlockRelocationDirection::WithinPage => "Moved blocks within Page",
        LibraryBlockRelocationDirection::Unknown => "Moved Page blocks",
    };
    LibraryPageHistoryDisplay {
        category: LibraryPageHistoryCategory::Location,
        title: title.to_owned(),
        detail: Some(format!(
            "{} block{}",
            evidence.moved_block_count,
            if evidence.moved_block_count == 1 {
                ""
            } else {
                "s"
            }
        )),
        actor_label: None,
    }
}

fn change_entry_base(
    scope: &PageScope,
    row: &ChangeRow,
    display: LibraryPageHistoryDisplay,
    evidence: LibraryPageHistoryEvidence,
    recovery_reason: LibraryPageHistoryRecoveryReason,
) -> LibraryPageHistoryEntryBase {
    LibraryPageHistoryEntryBase {
        id: format!("change:{}", row.seq),
        library_id: scope.library_id.clone(),
        page_id: scope.page_id.clone(),
        document_id: scope.document_id.clone(),
        occurred_at: row.committed_at.clone(),
        display,
        evidence,
        recovery: LibraryPageHistoryRecovery::Unavailable {
            reason: recovery_reason,
        },
    }
}

fn compare_entries(left: &LibraryPageHistoryEntry, right: &LibraryPageHistoryEntry) -> Ordering {
    occurred_at(right)
        .cmp(occurred_at(left))
        .then_with(|| source_rank(right).cmp(&source_rank(left)))
        .then_with(|| entry_tiebreaker(right).cmp(&entry_tiebreaker(left)))
}

fn occurred_at(entry: &LibraryPageHistoryEntry) -> &str {
    entry_base(entry).occurred_at.as_str()
}

fn source_rank(entry: &LibraryPageHistoryEntry) -> u8 {
    u8::from(matches!(
        entry,
        LibraryPageHistoryEntry::DocumentVersion { .. }
    ))
}

fn entry_tiebreaker(entry: &LibraryPageHistoryEntry) -> String {
    match entry {
        LibraryPageHistoryEntry::DocumentVersion {
            version_metadata, ..
        } => version_metadata.version_id.clone(),
        LibraryPageHistoryEntry::BlockMutation { change_seq, .. }
        | LibraryPageHistoryEntry::BlockRelocation { change_seq, .. } => {
            format!("{change_seq:020}")
        }
    }
}

fn cursor_for_entry(entry: &LibraryPageHistoryEntry) -> LibraryPageHistoryCursor {
    match entry {
        LibraryPageHistoryEntry::DocumentVersion {
            entry,
            version_metadata,
        } => LibraryPageHistoryCursor::DocumentVersion {
            occurred_at: entry.occurred_at.clone(),
            version_id: version_metadata.version_id.clone(),
        },
        LibraryPageHistoryEntry::BlockMutation {
            entry, change_seq, ..
        }
        | LibraryPageHistoryEntry::BlockRelocation {
            entry, change_seq, ..
        } => LibraryPageHistoryCursor::ChangeLog {
            occurred_at: entry.occurred_at.clone(),
            change_seq: *change_seq,
        },
    }
}

fn entry_base(entry: &LibraryPageHistoryEntry) -> &LibraryPageHistoryEntryBase {
    match entry {
        LibraryPageHistoryEntry::DocumentVersion { entry, .. }
        | LibraryPageHistoryEntry::BlockMutation { entry, .. }
        | LibraryPageHistoryEntry::BlockRelocation { entry, .. } => entry,
    }
}

fn validate_cursor(cursor: Option<&LibraryPageHistoryCursor>) -> Result<(), StoreError> {
    let Some(cursor) = cursor else { return Ok(()) };
    match cursor {
        LibraryPageHistoryCursor::DocumentVersion {
            occurred_at,
            version_id,
        } => {
            validate_id(version_id, "history version_id")?;
            if !canonical_timestamp(occurred_at) {
                return Err(invalid("Page history cursor timestamp is invalid"));
            }
        }
        LibraryPageHistoryCursor::ChangeLog {
            occurred_at,
            change_seq,
        } => {
            if !safe_integer(*change_seq, 1) || !canonical_timestamp(occurred_at) {
                return Err(invalid("Page history cursor is invalid"));
            }
        }
    }
    Ok(())
}

fn parse_object(serialized: &str) -> Option<Map<String, Value>> {
    bounded_json(serialized).and_then(|value| value.as_object().cloned())
}

fn parse_array(serialized: &str) -> Option<Vec<Value>> {
    bounded_json(serialized).and_then(|value| value.as_array().cloned())
}

fn bounded_json(serialized: &str) -> Option<Value> {
    if serialized.len() > MAX_JSON_BYTES {
        return None;
    }
    let value = serde_json::from_str::<Value>(serialized).ok()?;
    let mut pending = vec![(&value, 0_usize)];
    let mut nodes = 0_usize;
    while let Some((value, depth)) = pending.pop() {
        nodes += 1;
        if nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH {
            return None;
        }
        match value {
            Value::Array(values) => pending.extend(values.iter().map(|value| (value, depth + 1))),
            Value::Object(values) => {
                if values
                    .keys()
                    .any(|key| key.is_empty() || js_length(key) > 256)
                {
                    return None;
                }
                pending.extend(values.values().map(|value| (value, depth + 1)));
            }
            Value::String(value) if js_length(value) > 16_384 => return None,
            _ => {}
        }
    }
    Some(value)
}

fn string_array(serialized: Option<&str>) -> Option<Vec<String>> {
    let values = parse_array(serialized?)?;
    if values.len() > MAX_ARRAY_LENGTH {
        return None;
    }
    let values = values
        .into_iter()
        .map(|value| {
            value
                .as_str()
                .filter(|value| bounded(value))
                .map(str::to_owned)
        })
        .collect::<Option<Vec<_>>>()?;
    (values.iter().collect::<HashSet<_>>().len() == values.len()).then_some(values)
}

fn same_set(left: &[String], right: &[String]) -> bool {
    left.len() == right.len()
        && left.iter().collect::<HashSet<_>>() == right.iter().collect::<HashSet<_>>()
}

fn actor_label(actor: &Map<String, Value>) -> Option<String> {
    ["displayName", "name", "label", "kind"]
        .into_iter()
        .find_map(|key| {
            actor
                .get(key)
                .and_then(Value::as_str)
                .filter(|label| !label.trim().is_empty())
        })
        .map(|label| {
            let normalized = label.split_whitespace().collect::<Vec<_>>().join(" ");
            if normalized.chars().count() <= 120 {
                normalized
            } else {
                normalized.chars().take(119).collect::<String>() + "…"
            }
        })
}

fn unknown_display(actor_label: Option<String>) -> LibraryPageHistoryDisplay {
    LibraryPageHistoryDisplay {
        category: LibraryPageHistoryCategory::Unknown,
        title: "Page change".to_owned(),
        detail: Some("Stored evidence is unavailable or cannot be displayed safely.".to_owned()),
        actor_label,
    }
}

fn canonical_timestamp(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 24 {
        return false;
    }
    let shape_is_canonical = bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[10] == b'T'
        && bytes[13] == b':'
        && bytes[16] == b':'
        && bytes[19] == b'.'
        && bytes[23] == b'Z'
        && bytes.iter().enumerate().all(|(index, byte)| {
            matches!(index, 4 | 7 | 10 | 13 | 16 | 19 | 23) || byte.is_ascii_digit()
        });
    if !shape_is_canonical {
        return false;
    }
    let number = |start: usize, end: usize| {
        value[start..end]
            .parse::<u32>()
            .expect("timestamp digit shape was validated")
    };
    let year = number(0, 4);
    let month = number(5, 7);
    let day = number(8, 10);
    let hour = number(11, 13);
    let minute = number(14, 16);
    let second = number(17, 19);
    let leap_year = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days_in_month = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap_year => 29,
        2 => 28,
        _ => return false,
    };
    day >= 1 && day <= days_in_month && hour < 24 && minute < 60 && second < 60
}

fn hex_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn bounded(value: &str) -> bool {
    bounded_with(value, MAX_ID_LENGTH)
}

fn bounded_with(value: &str, maximum: usize) -> bool {
    !value.is_empty() && js_length(value) <= maximum && value.trim() == value
}

fn js_length(value: &str) -> usize {
    value.encode_utf16().count()
}

fn safe_integer(value: i64, minimum: i64) -> bool {
    value >= minimum && value <= MAX_SAFE_INTEGER
}

fn validate_id(value: &str, label: &str) -> Result<(), StoreError> {
    if bounded(value) {
        return Ok(());
    }
    Err(invalid(format!(
        "{label} must be a canonical bounded identity"
    )))
}

fn invalid(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message, false)
}

fn unauthorized(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::Unauthorized, message, false)
}

fn not_found(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::NotFound, message, false)
}

fn corrupt(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message, false)
}

#[cfg(test)]
mod tests {
    use nodex_core_contracts::library::{
        LibraryPageHistoryEntry, LibraryPageHistoryEvidence, LibraryPageHistoryRecovery,
        LibraryPageHistoryRecoveryReason,
    };
    use rusqlite::params;
    use tempfile::tempdir;

    use crate::infrastructure::sqlite::with_immediate_transaction;
    use crate::infrastructure::store::SqliteStoreKernel;

    use super::*;

    const LIBRARY: &str = "library:history";
    const PROJECT: &str = "project:history";
    const OTHER_PROJECT: &str = "project:other";
    const DATABASE: &str = "database:history";
    const SOURCE: &str = "source:history";
    const PAGE: &str = "page:history";
    const DOCUMENT: &str = "document:history";
    const STORE_EPOCH: &str = "epoch:history";
    const HASH: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn insert_mutation(
        connection: &Connection,
        mutation_id: &str,
        committed_at: &str,
        payload_request_hash: &str,
        mutation_kind: &str,
        redundant_body: &str,
    ) -> rusqlite::Result<i64> {
        connection.execute(
            "INSERT INTO change_log( \
               project_id, store_epoch, kind, operation_id, block_ids_json, document_ids_json, \
               database_block_ids_json, payload_json, projection_impact_json, committed_at \
             ) VALUES (?1, ?2, 'block_mutation', ?3, ?4, ?5, '[]', ?6, \
               '{\"kind\":\"none\"}', ?7)",
            params![
                PROJECT,
                STORE_EPOCH,
                mutation_id,
                format!("[\"{PAGE}\"]"),
                format!("[\"{DOCUMENT}\"]"),
                format!("{{\"requestHash\":\"{payload_request_hash}\"}}"),
                committed_at,
            ],
        )?;
        let change_seq = connection.last_insert_rowid();
        connection.execute(
            "INSERT INTO block_mutations( \
               mutation_id, project_id, store_epoch, mutation_kind, actor_json, request_hash, \
               request_json, target_block_ids_json, affected_document_ids_json, \
               affected_database_block_ids_json, field_intents_json, expected_revisions_json, \
               outcome, result_json, committed_revisions_json, document_heads_json, \
               change_log_seq, recorded_at \
             ) VALUES (?1, ?2, ?3, ?9, \
               '{\"displayName\":\"History editor\"}', ?4, ?10, ?5, ?6, '[]', \
               '[{\"path\":\"title\",\"operation\":\"set\"}]', '{}', 'committed', \
               ?10, '{}', '{}', ?7, ?8)",
            params![
                mutation_id,
                PROJECT,
                STORE_EPOCH,
                HASH,
                format!("[\"{PAGE}\"]"),
                format!("[\"{DOCUMENT}\"]"),
                change_seq,
                committed_at,
                mutation_kind,
                redundant_body,
            ],
        )?;
        Ok(change_seq)
    }

    #[test]
    fn merges_versions_and_changes_with_source_specific_cursors() {
        const LATEST: &str = "2026-07-18T10:00:00.000Z";
        const EARLIER: &str = "2026-07-18T09:00:00.000Z";
        let directory = tempdir().expect("Profile");
        let home = directory.path().canonicalize().expect("absolute Profile");
        let kernel = SqliteStoreKernel::open_test(&home).expect("fresh store");
        let bad_change_seq = kernel
            .writer()
            .call(|connection| {
                with_immediate_transaction(connection, |transaction| {
                    transaction.execute(
                        "INSERT INTO profiles(id, created_at, updated_at) VALUES ('profile:history', ?1, ?1)",
                        [LATEST],
                    )?;
                    transaction.execute(
                        "INSERT INTO libraries(id, profile_id, created_at, updated_at) \
                         VALUES (?1, 'profile:history', ?2, ?2)",
                        params![LIBRARY, LATEST],
                    )?;
                    transaction.execute(
                        "INSERT INTO projects(id, library_id, name, database_block_id, created, updated) \
                         VALUES (?1, ?2, 'History', NULL, ?3, ?3), \
                                (?4, ?2, 'Other', NULL, ?3, ?3)",
                        params![PROJECT, LIBRARY, LATEST, OTHER_PROJECT],
                    )?;
                    transaction.execute(
                        "INSERT INTO block_store_metadata(id, store_epoch, created_at, updated_at) \
                         VALUES (1, ?1, ?2, ?2)",
                        params![STORE_EPOCH, LATEST],
                    )?;
                    transaction.execute(
                        "INSERT INTO blocks( \
                           id, library_id, type, lifecycle, placement_revision, metadata_revision, \
                           created_at, updated_at \
                         ) VALUES (?1, ?2, 'database', 'active', 1, 1, ?3, ?3)",
                        params![DATABASE, LIBRARY, LATEST],
                    )?;
                    transaction.execute(
                        "INSERT INTO database_containers( \
                           block_id, library_id, name, lifecycle, created_at, updated_at \
                         ) VALUES (?1, ?2, 'History', 'active', ?3, ?3)",
                        params![DATABASE, LIBRARY, LATEST],
                    )?;
                    transaction.execute(
                        "UPDATE projects SET database_block_id = ?1 WHERE id = ?2",
                        params![DATABASE, PROJECT],
                    )?;
                    transaction.execute(
                        "INSERT INTO data_sources( \
                           id, library_id, home_database_block_id, name, schema_key, rank_key, \
                           lifecycle, created_at, updated_at \
                         ) VALUES (?1, ?2, ?3, 'History', 'nodex.database', 'a', 'active', ?4, ?4)",
                        params![SOURCE, LIBRARY, DATABASE, LATEST],
                    )?;
                    transaction.execute(
                        "INSERT INTO blocks( \
                           id, library_id, type, lifecycle, placement_revision, metadata_revision, \
                           created_at, updated_at \
                         ) VALUES (?1, ?2, 'page', 'active', 1, 1, ?3, ?3)",
                        params![PAGE, LIBRARY, LATEST],
                    )?;
                    transaction.execute(
                        "INSERT INTO documents( \
                           id, library_id, generation, head_seq, schema_key, schema_version, \
                           state_vector, state_hash, readiness, authority, created_at, updated_at, sync_engine \
                         ) VALUES (?1, ?2, 1, 0, 'nodex.page', 3, X'', ?3, 'ready', \
                           'ydoc_primary', ?4, ?4, 'yjs')",
                        params![DOCUMENT, LIBRARY, "", LATEST],
                    )?;
                    transaction.execute(
                        "INSERT INTO block_documents(block_id, document_id, library_id, created_at) \
                         VALUES (?1, ?2, ?3, ?4)",
                        params![PAGE, DOCUMENT, LIBRARY, LATEST],
                    )?;
                    transaction.execute(
                        "INSERT INTO pages( \
                           block_id, library_id, document_id, parent_kind, parent_id, created_at, updated_at \
                         ) VALUES (?1, ?2, ?3, 'data_source', ?4, ?5, ?5)",
                        params![PAGE, LIBRARY, DOCUMENT, SOURCE, LATEST],
                    )?;
                    transaction.execute(
                        "INSERT INTO data_source_page_memberships( \
                           id, data_source_id, page_block_id, revision, created_at, removed_at \
                         ) VALUES ('membership:history', ?1, ?2, 1, ?3, NULL)",
                        params![SOURCE, PAGE, LATEST],
                    )?;
                    transaction.execute(
                        "INSERT INTO document_versions( \
                           version_id, document_id, project_id, generation, base_head_seq, \
                           schema_key, schema_version, cause, label, actor_json, revision_kind, \
                           pinned, checkpoint_format, full_update_blob, state_vector, \
                           checkpoint_hash, byte_length, created_at \
                         ) VALUES ('version:latest', ?1, ?2, 1, 0, 'nodex.page', 3, 'manual', \
                           'Milestone', '{\"displayName\":\"Checkpoint editor\"}', 'manual', 1, \
                           'block_tree_snapshot_v2', X'7B7D', X'', ?3, 2, ?4)",
                        params![DOCUMENT, PROJECT, HASH, LATEST],
                    )?;
                    insert_mutation(transaction, "mutation:valid", LATEST, HASH, "property_batch", "{}")?;
                    let bad_change_seq = insert_mutation(
                        transaction,
                        "mutation:bad-evidence",
                        EARLIER,
                        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                        "property_batch",
                        "{}",
                    )?;
                    Ok(bad_change_seq)
                })
            })
            .expect("seed history");

        let first = kernel
            .readers()
            .read_default(|connection| {
                page_history(connection, LIBRARY, Some(PROJECT), PAGE, None, Some(1))
            })
            .expect("first history page");
        assert_eq!(first.entries.len(), 1);
        let LibraryPageHistoryEntry::DocumentVersion { entry, .. } = &first.entries[0] else {
            panic!("Document revision sorts before a same-time mutation");
        };
        assert!(matches!(
            entry.evidence,
            LibraryPageHistoryEvidence::Verified
        ));
        assert!(matches!(
            entry.recovery,
            LibraryPageHistoryRecovery::RestoreDocumentVersion { .. }
        ));

        let second = kernel
            .readers()
            .read_default(|connection| {
                page_history(
                    connection,
                    LIBRARY,
                    Some(PROJECT),
                    PAGE,
                    first.next_cursor,
                    Some(1),
                )
            })
            .expect("second history page");
        let LibraryPageHistoryEntry::BlockMutation {
            entry, mutation_id, ..
        } = &second.entries[0]
        else {
            panic!("same-time mutation follows the Document revision");
        };
        assert_eq!(mutation_id.as_deref(), Some("mutation:valid"));
        assert!(matches!(
            entry.evidence,
            LibraryPageHistoryEvidence::Verified
        ));
        assert_eq!(entry.display.actor_label.as_deref(), Some("History editor"));

        let third = kernel
            .readers()
            .read_default(|connection| {
                page_history(
                    connection,
                    LIBRARY,
                    Some(PROJECT),
                    PAGE,
                    second.next_cursor,
                    Some(1),
                )
            })
            .expect("third history page");
        let LibraryPageHistoryEntry::BlockMutation {
            entry,
            change_seq,
            mutation_id,
            ..
        } = &third.entries[0]
        else {
            panic!("malformed mutation remains visible");
        };
        assert_eq!(*change_seq, bad_change_seq);
        assert!(mutation_id.is_none());
        assert!(matches!(
            entry.evidence,
            LibraryPageHistoryEvidence::Unavailable { .. }
        ));
        assert!(matches!(
            entry.recovery,
            LibraryPageHistoryRecovery::Unavailable {
                reason: LibraryPageHistoryRecoveryReason::InsufficientEvidence
            }
        ));
        assert!(third.next_cursor.is_none());

        // Historical storage shape: a structural event once duplicated its
        // result body in the ledger. Every visible history field must survive
        // body collection, including the separate Document checkpoint.
        kernel.writer().call(|connection| {
            with_immediate_transaction(connection, |transaction| {
                let body = serde_json::json!({ "content": "正文".repeat(100_000) }).to_string();
                insert_mutation(transaction, "mutation:structural", LATEST, HASH, "structural_edit", &body)?;
                transaction.execute("INSERT INTO block_mutation_body_gc(mutation_id) VALUES ('mutation:structural')", [])?;
                Ok(())
            })
        }).expect("historical body fixture");
        let before_collection = kernel
            .readers()
            .read_default(|connection| {
                page_history(connection, LIBRARY, Some(PROJECT), PAGE, None, None)
            })
            .unwrap();
        kernel
            .writer()
            .call(|connection| {
                with_immediate_transaction(connection, |transaction| {
                    let now_ms: i64 = transaction.query_row(
                        "SELECT CAST(unixepoch(?1, 'subsec') * 1000 AS INTEGER)",
                        [LATEST],
                        |row| row.get(0),
                    )?;
                    let collected = super::super::mutation_ledger::collect_one(
                        transaction,
                        now_ms + crate::infrastructure::module_receipts::RECEIPT_RETENTION_MS,
                    )?;
                    assert!(collected.bytes > 1_000_000);
                    Ok(())
                })
            })
            .expect("collect only redundant ledger bodies");
        let after_collection = kernel
            .readers()
            .read_default(|connection| {
                page_history(connection, LIBRARY, Some(PROJECT), PAGE, None, None)
            })
            .unwrap();
        assert_eq!(after_collection, before_collection);

        let unauthorized = kernel
            .readers()
            .read_default(|connection| {
                page_history(connection, LIBRARY, Some(OTHER_PROJECT), PAGE, None, None)
            })
            .expect_err("unbound Project cannot read history");
        assert_eq!(unauthorized.code, StoreErrorCode::NotFound);
    }

    #[test]
    fn canonical_timestamps_match_javascript_iso_boundaries() {
        assert!(canonical_timestamp("2024-02-29T23:59:59.999Z"));
        assert!(!canonical_timestamp("2023-02-29T23:59:59.999Z"));
        assert!(!canonical_timestamp("2026-07-18T24:00:00.000Z"));
        assert!(!canonical_timestamp("2026-07-18T10:00:00Z"));
    }
}
