use chrono::{SecondsFormat, TimeZone, Utc};
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use yrs::updates::encoder::Encode;
use yrs::{ReadTxn, StateVector, Transact};

use super::schema_compatibility::{
    decode_stored_materialized_forest, normalize_nodex_markdown_forest,
};
use crate::domain::block_materialization::{
    MaterializedBlockNode, dematerialize_block_tree, materialize_block_tree,
};
use crate::domain::rich_text::{RichTextItem, rich_text_to_delta};
use crate::infrastructure::document_repository::{
    DocumentHeadRow, DocumentReadRepository, DocumentSnapshotRow,
};
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

use super::block_document::decode_block_document_allowing_illegal_children;
use super::history::canonical_json_bytes;
use super::persistence::{
    persist_materialization_for_schema_migration,
    replace_document_block_index_for_schema_migration,
    replace_secondary_projections_for_schema_migration,
};
use super::{
    BlockDocumentKind, BlockDocumentSchema, DecodedBlockDocument, DocumentMaterialization,
    YrsDocumentEngine, decode_block_document, encode_block_document, materialize_decoded_document,
    schema_metadata,
};

#[cfg(test)]
const BASELINE_PAGE_SCHEMA_VERSION: i64 = 2;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DocumentSchemaMigrationEvidence {
    pub(crate) scanned_documents: usize,
    pub(crate) changed_documents: usize,
    pub(crate) scanned_versions: usize,
    pub(crate) changed_versions: usize,
    pub(crate) lifted_roots: usize,
    pub(crate) removed_prompt_markers: usize,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DocumentProjectionRepairEvidence {
    pub(crate) scanned_documents: usize,
    pub(crate) refreshed_owned_projections: usize,
    pub(crate) cleared_unowned_projections: usize,
}

struct PreparedDocument {
    head: DocumentHeadRow,
    target_schema: BlockDocumentSchema,
    full_state: Vec<u8>,
    state_vector: Vec<u8>,
    materialization: DocumentMaterialization,
    snapshot_created_at: String,
    materialization_updated_at: String,
    changed: bool,
    lifted_roots: usize,
    removed_prompt_markers: usize,
}

#[derive(Debug)]
struct VersionRow {
    version_id: String,
    document_id: String,
    project_id: Option<String>,
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
    full_update_blob: Vec<u8>,
    state_vector: Vec<u8>,
    checkpoint_hash: String,
    byte_length: i64,
    created_at: String,
}

#[derive(Debug)]
struct PreparedVersion {
    row: VersionRow,
    target_schema: BlockDocumentSchema,
    checkpoint: Vec<u8>,
    state_vector: Vec<u8>,
    changed: bool,
    lifted_roots: usize,
    removed_prompt_markers: usize,
}

struct MigratedCheckpoint {
    bytes: Vec<u8>,
    state_vector: Vec<u8>,
    changed: bool,
    lifted_roots: usize,
    removed_prompt_markers: usize,
}

struct PreparedMigration {
    documents: Vec<PreparedDocument>,
    versions: Vec<PreparedVersion>,
    evidence: DocumentSchemaMigrationEvidence,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BlockTreeMigrationSnapshot {
    format_version: u32,
    kind: BlockDocumentKind,
    block_tree: Vec<MaterializedBlockNode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    rich_title: Option<Vec<RichTextItem>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    file_snapshot: Option<crate::domain::files::FileSnapshotManifest>,
}

pub(crate) fn validate_block_children_migration_source(
    connection: &Connection,
) -> Result<DocumentSchemaMigrationEvidence, StoreError> {
    Ok(prepare_migration(connection)?.evidence)
}

pub(crate) fn migrate_block_children_contract(
    connection: &Connection,
    completed_at_unix_ms: i64,
) -> Result<DocumentSchemaMigrationEvidence, StoreError> {
    let prepared = prepare_migration(connection)?;
    let timestamp = Utc
        .timestamp_millis_opt(completed_at_unix_ms)
        .single()
        .map(|timestamp| timestamp.to_rfc3339_opts(SecondsFormat::Millis, true))
        .ok_or_else(|| internal("Block children migration timestamp is outside the UTC range"))?;
    for document in &prepared.documents {
        write_document(connection, document, &timestamp)?;
    }
    for version in &prepared.versions {
        write_version(connection, version)?;
    }
    for (schema, previous) in [
        (BlockDocumentSchema::PageV4, 3),
        (BlockDocumentSchema::SyncedBlockV3, 2),
        (BlockDocumentSchema::ReusableTemplateV3, 2),
    ] {
        connection.execute("UPDATE documents SET schema_version = ?1 WHERE schema_key = ?2 AND schema_version <= ?3 AND readiness = 'pending_genesis' AND sync_engine = 'yjs'", params![schema.schema_version(), schema.schema_key(), previous])?;
    }
    connection.execute("UPDATE page_read_model SET document_schema_version = (SELECT schema_version FROM documents WHERE id = page_read_model.document_id) WHERE document_id IN (SELECT id FROM documents WHERE readiness = 'pending_genesis' AND sync_engine = 'yjs')", [])?;
    Ok(prepared.evidence)
}

/// Historical migration readers can access the predecessor column before its rename.
pub(crate) fn stored_markdown_column(connection: &Connection) -> Result<&'static str, StoreError> {
    let has_current: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('document_materializations') WHERE name='markdown')", [], |row| row.get(0))?;
    Ok(if has_current { "markdown" } else { "nfm" })
}

/// One schema transition for the unreleased Nodex Markdown normalization steps.
pub(crate) fn migrate_nodex_markdown_contract(
    connection: &Connection,
    completed_at_unix_ms: i64,
) -> Result<DocumentSchemaMigrationEvidence, StoreError> {
    let context = MarkdownMigration::load(connection)?;
    let prepared = prepare_migration_with_markdown(connection, Some(&context))?;
    if stored_markdown_column(connection)? != "markdown" {
        connection
            .execute_batch("ALTER TABLE document_materializations RENAME COLUMN nfm TO markdown")?;
    }
    let timestamp = Utc
        .timestamp_millis_opt(completed_at_unix_ms)
        .single()
        .ok_or_else(|| internal("Markdown migration timestamp"))?
        .to_rfc3339_opts(SecondsFormat::Millis, true);
    for document in &prepared.documents {
        write_document(connection, document, &timestamp)?;
    }
    for version in &prepared.versions {
        write_version(connection, version)?;
    }
    connection.execute("UPDATE documents SET schema_version = CASE schema_key WHEN 'nodex.page' THEN 4 ELSE 3 END WHERE readiness = 'pending_genesis' AND sync_engine = 'yjs'", [])?;
    connection.execute("UPDATE page_read_model SET document_schema_version = (SELECT schema_version FROM documents WHERE id = page_read_model.document_id) WHERE document_id IN (SELECT id FROM documents WHERE readiness = 'pending_genesis' AND sync_engine = 'yjs')", [])?;
    let evidence = prepared.evidence;
    if context.legacy_column || evidence.changed_documents > 0 || evidence.changed_versions > 0 {
        let epoch = crate::domain::identity::random_uuid_v7()
            .map_err(|_| internal("Markdown migration epoch entropy failed"))?;
        connection.execute(
            "UPDATE block_store_metadata SET store_epoch = ?1, updated_at = ?2 WHERE id=1",
            params![format!("epoch:{epoch}"), timestamp],
        )?;
    }
    rebuild_retained_projection_indexes(connection)?;
    Ok(evidence)
}

/// Earlier Store steps normalize their document baseline without adopting the
/// successor's physical text column or caption and mention semantics.
pub(crate) fn migrate_block_document_baselines(
    connection: &Connection,
    completed_at_unix_ms: i64,
) -> Result<DocumentSchemaMigrationEvidence, StoreError> {
    let evidence = migrate_block_children_contract(connection, completed_at_unix_ms)?;
    rebuild_retained_projection_indexes(connection)?;
    Ok(evidence)
}

fn rebuild_retained_projection_indexes(connection: &Connection) -> Result<(), StoreError> {
    // Checkpoints own File bindings; retention tables are projections of the new
    // canonical bytes and hashes, including retained deleted/unowned Documents.
    // Schema-rebuild transactions disable foreign-key cascades, so clear child
    // rows explicitly before replacing their hash-fenced index headers.
    connection.execute("DELETE FROM document_version_retention_members WHERE version_id IN (SELECT version.version_id FROM document_versions version JOIN documents document ON document.id = version.document_id WHERE document.sync_engine = 'yjs')", [])?;
    connection.execute("DELETE FROM document_version_file_refs WHERE version_id IN (SELECT version.version_id FROM document_versions version JOIN documents document ON document.id = version.document_id WHERE document.sync_engine = 'yjs')", [])?;
    connection.execute("DELETE FROM document_version_retention_index WHERE version_id IN (SELECT version.version_id FROM document_versions version JOIN documents document ON document.id = version.document_id WHERE document.sync_engine = 'yjs')", [])?;
    connection.execute("DELETE FROM document_version_file_index WHERE version_id IN (SELECT version.version_id FROM document_versions version JOIN documents document ON document.id = version.document_id WHERE document.sync_engine = 'yjs')", [])?;
    super::history::backfill_migrated_document_history(connection)?;
    Ok(())
}

pub(crate) fn validate_nodex_markdown_migration_source(
    connection: &Connection,
) -> Result<DocumentSchemaMigrationEvidence, StoreError> {
    Ok(
        prepare_migration_with_markdown(connection, Some(&MarkdownMigration::load(connection)?))?
            .evidence,
    )
}

/// Repairs Profiles that completed the original Document schema migration
/// without rebuilding the full owner-scoped projection bundle.
pub(crate) fn repair_document_schema_projections(
    connection: &Connection,
    completed_at_unix_ms: i64,
) -> Result<DocumentProjectionRepairEvidence, StoreError> {
    let timestamp = Utc
        .timestamp_millis_opt(completed_at_unix_ms)
        .single()
        .map(|timestamp| timestamp.to_rfc3339_opts(SecondsFormat::Millis, true))
        .ok_or_else(|| internal("Document projection repair timestamp is outside the UTC range"))?;
    let repository = DocumentReadRepository::new(connection);
    let mut evidence = DocumentProjectionRepairEvidence::default();
    for head in repository.live_yjs_heads()? {
        let persisted = repository
            .materialization(&head.id)?
            .ok_or_else(|| corrupt(format!("Document {} has no materialization", head.id)))?;
        if persisted.generation != head.generation
            || persisted.projected_seq != head.head_seq
            || persisted.schema_version != head.schema_version
        {
            return Err(corrupt(format!(
                "Document {} materialization is not at its current head",
                head.id
            )));
        }
        let schema = BlockDocumentSchema::from_identity(&head.schema_key, head.schema_version)
            .ok_or_else(|| corrupt(format!("Document {} schema is not current", head.id)))?;
        let rich_title = serde_json::from_value::<Vec<RichTextItem>>(persisted.rich_title)
            .map_err(|_| corrupt(format!("Document {} rich title is invalid", head.id)))?;
        let blocks = serde_json::from_value::<Vec<MaterializedBlockNode>>(persisted.block_tree)
            .map_err(|_| corrupt(format!("Document {} Block tree is invalid", head.id)))?;
        let block_tree = dematerialize_block_tree(&blocks)
            .map_err(|error| corrupt(format!("Document {} Block tree: {error}", head.id)))?;
        let title = schema
            .has_title()
            .then(|| rich_text_to_delta(&rich_title))
            .transpose()
            .map_err(|error| corrupt(format!("Document {} rich title: {error}", head.id)))?;
        let materialization = materialize_decoded_document(&DecodedBlockDocument {
            document_id: head.id.clone(),
            schema,
            title,
            block_tree,
        })
        .map_err(|error| corrupt(format!("Document {} materialization: {error}", head.id)))?;
        evidence.scanned_documents += 1;
        if replace_secondary_projections_for_schema_migration(
            connection,
            &head.id,
            &materialization,
            head.head_seq,
            &timestamp,
        )? {
            evidence.refreshed_owned_projections += 1;
        } else {
            evidence.cleared_unowned_projections += 1;
        }
    }
    Ok(evidence)
}

fn prepare_migration(connection: &Connection) -> Result<PreparedMigration, StoreError> {
    prepare_migration_with_markdown(connection, None)
}

fn prepare_migration_with_markdown(
    connection: &Connection,
    markdown: Option<&MarkdownMigration>,
) -> Result<PreparedMigration, StoreError> {
    let repository = DocumentReadRepository::new(connection);
    let mut documents = Vec::new();
    let mut evidence = DocumentSchemaMigrationEvidence::default();
    for head in repository.live_yjs_heads()? {
        let prepared = prepare_document(&repository, head, markdown)?;
        evidence.scanned_documents += 1;
        evidence.changed_documents += usize::from(prepared.changed);
        evidence.lifted_roots += prepared.lifted_roots;
        evidence.removed_prompt_markers += prepared.removed_prompt_markers;
        documents.push(prepared);
    }

    let mut versions = Vec::new();
    for row in read_version_rows(connection)? {
        let prepared = prepare_version_with_markdown(row, markdown)?;
        evidence.scanned_versions += 1;
        evidence.changed_versions += usize::from(prepared.changed);
        evidence.lifted_roots += prepared.lifted_roots;
        evidence.removed_prompt_markers += prepared.removed_prompt_markers;
        versions.push(prepared);
    }
    Ok(PreparedMigration {
        documents,
        versions,
        evidence,
    })
}

fn prepare_document(
    repository: &DocumentReadRepository<'_>,
    head: DocumentHeadRow,
    markdown: Option<&MarkdownMigration>,
) -> Result<PreparedDocument, StoreError> {
    let target_schema = stored_migration_schema(&head.schema_key, head.schema_version)?;
    let snapshot = repository
        .latest_snapshot(&head.id, head.generation, head.head_seq)?
        .ok_or_else(|| corrupt(format!("Document {} has no baseline snapshot", head.id)))?;
    if snapshot.schema_version != head.schema_version {
        return Err(corrupt(format!(
            "Document {} latest snapshot is not exact baseline schema",
            head.id
        )));
    }
    let materialization = repository
        .materialization(&head.id)?
        .ok_or_else(|| corrupt(format!("Document {} has no materialization", head.id)))?;
    if materialization.generation != head.generation
        || materialization.projected_seq != head.head_seq
        || materialization.schema_version != head.schema_version
    {
        return Err(corrupt(format!(
            "Document {} materialization is not exact baseline schema",
            head.id
        )));
    }

    let engine = reconstruct_baseline_document(repository, &head, &snapshot)?;
    let decoded =
        decode_schema_migration_document(engine.document(), target_schema, head.schema_version)
            .map_err(|error| corrupt(format!("Document {} baseline schema: {error}", head.id)))?;
    let (mut normalized, removed_prompt_markers) = normalize_schema_migration_forest(
        decoded.block_tree.blocks,
        head.schema_version,
        target_schema,
        &head.id,
    );
    let mut normalized_document = DecodedBlockDocument {
        document_id: decoded.document_id,
        schema: target_schema,
        title: decoded.title,
        block_tree: crate::domain::block_tree::BlockTree {
            root_attributes: decoded.block_tree.root_attributes,
            blocks: normalized.blocks,
        },
    };
    if let Some(markdown) =
        markdown.filter(|context| context.applies_to(head.schema_version, target_schema))
    {
        normalized.changed |= markdown.transform_document(&mut normalized_document)?;
    }
    let current_materialization =
        materialize_decoded_document(&normalized_document).map_err(|error| {
            corrupt(format!(
                "Document {} current materialization: {error}",
                head.id
            ))
        })?;
    let stored_blocks: Vec<MaterializedBlockNode> =
        serde_json::from_value(materialization.block_tree).map_err(|_| {
            corrupt(format!(
                "Document {} materialized Block tree is invalid",
                head.id
            ))
        })?;
    let mut stored_normalized =
        super::schema_compatibility::normalize_stored_forest(&stored_blocks, &head.id)?;
    if let Some(markdown) =
        markdown.filter(|context| context.applies_to(head.schema_version, target_schema))
    {
        markdown.transform_blocks(&mut stored_normalized);
    }
    if stored_normalized != current_materialization.block_tree {
        return Err(corrupt(format!(
            "Document {} materialized Block tree diverges",
            head.id
        )));
    }
    let (full_state, state_vector) = if normalized.changed {
        encode_current_document(&normalized_document)?
    } else {
        (engine.full_state_v1(), engine.state_vector_v1())
    };
    Ok(PreparedDocument {
        head,
        target_schema,
        full_state,
        state_vector,
        materialization: current_materialization,
        snapshot_created_at: snapshot.created_at,
        materialization_updated_at: materialization.updated_at,
        changed: normalized.changed,
        lifted_roots: normalized.lifted_roots,
        removed_prompt_markers,
    })
}

fn reconstruct_baseline_document(
    repository: &DocumentReadRepository<'_>,
    head: &DocumentHeadRow,
    snapshot: &DocumentSnapshotRow,
) -> Result<YrsDocumentEngine, StoreError> {
    verify_hash(
        &snapshot.snapshot_update,
        &snapshot.snapshot_hash,
        "Document snapshot",
    )?;
    let mut engine = YrsDocumentEngine::from_full_state_v1(&head.id, &snapshot.snapshot_update)
        .map_err(|error| corrupt(format!("Document {} snapshot: {error}", head.id)))?;
    if !engine
        .state_vector_equals_v1(&snapshot.state_vector)
        .map_err(|error| {
            corrupt(format!(
                "Document {} snapshot state vector: {error}",
                head.id
            ))
        })?
    {
        return Err(corrupt(format!(
            "Document {} snapshot state vector diverges",
            head.id
        )));
    }
    let updates = repository.updates_between(
        &head.id,
        head.generation,
        snapshot.snapshot_seq,
        head.head_seq,
    )?;
    let mut expected_seq = snapshot.snapshot_seq + 1;
    for update in updates {
        if update.seq != expected_seq {
            return Err(corrupt(format!(
                "Document {} update tail is not contiguous",
                head.id
            )));
        }
        verify_hash(&update.update_blob, &update.update_hash, "Document update")?;
        let candidate = engine
            .prepare_update_v1(&update.update_blob)
            .map_err(|error| corrupt(format!("Document {} update: {error}", head.id)))?;
        engine
            .commit_candidate(candidate)
            .map_err(|error| corrupt(format!("Document {} update commit: {error}", head.id)))?;
        expected_seq += 1;
    }
    if expected_seq - 1 != head.head_seq
        || !engine
            .state_vector_equals_v1(&head.state_vector)
            .map_err(|error| corrupt(format!("Document {} head state vector: {error}", head.id)))?
    {
        return Err(corrupt(format!(
            "Document {} reconstructed head diverges",
            head.id
        )));
    }
    Ok(engine)
}

#[cfg(test)]
fn prepare_version(row: VersionRow) -> Result<PreparedVersion, StoreError> {
    prepare_version_with_markdown(row, None)
}

fn prepare_version_with_markdown(
    row: VersionRow,
    markdown: Option<&MarkdownMigration>,
) -> Result<PreparedVersion, StoreError> {
    let target_schema = stored_migration_schema(&row.schema_key, row.schema_version)?;
    if row.byte_length != i64::try_from(row.full_update_blob.len()).unwrap_or(-1) {
        return Err(corrupt(format!(
            "Document version {} length diverges",
            row.version_id
        )));
    }
    verify_hash(
        &row.full_update_blob,
        &row.checkpoint_hash,
        "Document version checkpoint",
    )?;
    let MigratedCheckpoint {
        bytes: checkpoint,
        state_vector,
        changed,
        lifted_roots,
        removed_prompt_markers,
    } = match row.checkpoint_format.as_str() {
        "yjs_update_v1" => prepare_yjs_version(&row, target_schema, markdown)?,
        "block_tree_snapshot_v2" | "block_tree_snapshot_v3" => {
            prepare_block_tree_version(&row, target_schema, markdown)?
        }
        other => {
            return Err(corrupt(format!(
                "Yjs Document version {} uses unsupported checkpoint format {other}",
                row.version_id
            )));
        }
    };
    Ok(PreparedVersion {
        row,
        target_schema,
        checkpoint,
        state_vector,
        changed,
        lifted_roots,
        removed_prompt_markers,
    })
}

fn prepare_yjs_version(
    row: &VersionRow,
    target_schema: BlockDocumentSchema,
    markdown: Option<&MarkdownMigration>,
) -> Result<MigratedCheckpoint, StoreError> {
    let engine = YrsDocumentEngine::from_full_state_v1(&row.document_id, &row.full_update_blob)
        .map_err(|error| corrupt(format!("Document version {}: {error}", row.version_id)))?;
    if !engine
        .state_vector_equals_v1(&row.state_vector)
        .map_err(|error| {
            corrupt(format!(
                "Document version {} state vector: {error}",
                row.version_id
            ))
        })?
    {
        return Err(corrupt(format!(
            "Document version {} state vector diverges",
            row.version_id
        )));
    }
    let decoded =
        decode_schema_migration_document(engine.document(), target_schema, row.schema_version)
            .map_err(|error| corrupt(format!("Document version {}: {error}", row.version_id)))?;
    let (mut normalized, removed_prompt_markers) = normalize_schema_migration_forest(
        decoded.block_tree.blocks,
        row.schema_version,
        target_schema,
        &row.document_id,
    );
    let mut normalized_document = DecodedBlockDocument {
        document_id: decoded.document_id,
        schema: target_schema,
        title: decoded.title,
        block_tree: crate::domain::block_tree::BlockTree {
            root_attributes: decoded.block_tree.root_attributes,
            blocks: normalized.blocks,
        },
    };
    if let Some(markdown) =
        markdown.filter(|context| context.applies_to(row.schema_version, target_schema))
    {
        normalized.changed |= markdown.transform_document(&mut normalized_document)?;
    }
    if !normalized.changed {
        return Ok(MigratedCheckpoint {
            bytes: row.full_update_blob.clone(),
            state_vector: row.state_vector.clone(),
            changed: false,
            lifted_roots: 0,
            removed_prompt_markers: 0,
        });
    }
    let (checkpoint, state_vector) = encode_current_document(&normalized_document)?;
    Ok(MigratedCheckpoint {
        bytes: checkpoint,
        state_vector,
        changed: true,
        lifted_roots: normalized.lifted_roots,
        removed_prompt_markers,
    })
}

fn prepare_block_tree_version(
    row: &VersionRow,
    target_schema: BlockDocumentSchema,
    markdown: Option<&MarkdownMigration>,
) -> Result<MigratedCheckpoint, StoreError> {
    if !row.state_vector.is_empty() {
        return Err(corrupt(format!(
            "Document version {} block-tree checkpoint has causal state",
            row.version_id
        )));
    }
    let value = serde_json::from_slice::<serde_json::Value>(&row.full_update_blob)
        .map_err(|_| corrupt("BlockTree Document checkpoint JSON is invalid"))?;
    if canonical_json_bytes(value.clone())? != row.full_update_blob {
        return Err(corrupt(
            "BlockTree Document checkpoint JSON is not canonical",
        ));
    }
    let mut snapshot = serde_json::from_value::<BlockTreeMigrationSnapshot>(value)
        .map_err(|_| corrupt("BlockTree Document checkpoint payload is invalid"))?;
    let expected_format = if row.checkpoint_format == "block_tree_snapshot_v3" {
        3
    } else {
        2
    };
    if snapshot.format_version != expected_format
        || (expected_format == 3 && snapshot.file_snapshot.is_none())
        || snapshot.kind != schema_metadata(target_schema).kind
    {
        return Err(corrupt(
            "BlockTree Document checkpoint schema identity diverges",
        ));
    }
    if target_schema.has_title() != snapshot.rich_title.is_some() {
        return Err(corrupt(
            "BlockTree Document checkpoint title capability diverges",
        ));
    }
    let tree = if row.schema_version == i64::from(target_schema.schema_version()) {
        dematerialize_block_tree(&snapshot.block_tree)
            .map_err(|error| corrupt(format!("Current checkpoint: {error}")))?
    } else {
        decode_stored_materialized_forest(&snapshot.block_tree, &row.document_id)?
    };
    let (mut normalized, _) = normalize_schema_migration_forest(
        tree.blocks,
        row.schema_version,
        target_schema,
        &row.document_id,
    );
    let markdown = markdown.filter(|context| context.applies_to(row.schema_version, target_schema));
    if let Some(markdown) = markdown {
        let mut blocks = materialize_block_tree(&crate::domain::block_tree::BlockTree {
            root_attributes: tree.root_attributes.clone(),
            blocks: normalized.blocks.clone(),
        })
        .map_err(|error| corrupt(error.to_string()))?;
        normalized.changed |= markdown.transform_blocks(&mut blocks);
        normalized.blocks = dematerialize_block_tree(&blocks)
            .map_err(|error| corrupt(error.to_string()))?
            .blocks;
        if let Some(title) = &mut snapshot.rich_title {
            normalized.changed |= markdown.transform_title(title);
        }
    }
    let removed_prompt_markers = count_prompt_markers(&snapshot.block_tree);
    normalized.changed |= removed_prompt_markers > 0;
    let normalized_tree = crate::domain::block_tree::BlockTree {
        root_attributes: tree.root_attributes,
        blocks: normalized.blocks,
    };
    let title = snapshot
        .rich_title
        .as_deref()
        .map(rich_text_to_delta)
        .transpose()
        .map_err(|error| corrupt(format!("BlockTree Document checkpoint title: {error}")))?;
    let materialization = materialize_decoded_document(&DecodedBlockDocument {
        document_id: row.document_id.clone(),
        schema: target_schema,
        title,
        block_tree: normalized_tree.clone(),
    })
    .map_err(|error| corrupt(format!("BlockTree Document checkpoint: {error}")))?;
    if markdown.is_some()
        && let Some(files) = &mut snapshot.file_snapshot
    {
        let retained: std::collections::BTreeSet<_> =
            materialization.file_ids().into_iter().collect();
        let previous = files.files.len();
        files.files.retain(|id, _| retained.contains(id));
        normalized.changed |= files.files.len() != previous;
    }
    if !normalized.changed {
        return Ok(MigratedCheckpoint {
            bytes: row.full_update_blob.clone(),
            state_vector: Vec::new(),
            changed: false,
            lifted_roots: 0,
            removed_prompt_markers: 0,
        });
    }
    snapshot.block_tree = materialize_block_tree(&normalized_tree)
        .map_err(|error| corrupt(format!("BlockTree Document checkpoint: {error}")))?;
    let checkpoint = canonical_json_bytes(
        serde_json::to_value(snapshot)
            .map_err(|_| internal("BlockTree Document checkpoint could not be encoded"))?,
    )?;
    Ok(MigratedCheckpoint {
        bytes: checkpoint,
        state_vector: Vec::new(),
        changed: true,
        lifted_roots: normalized.lifted_roots,
        removed_prompt_markers,
    })
}

fn encode_current_document(
    document: &DecodedBlockDocument,
) -> Result<(Vec<u8>, Vec<u8>), StoreError> {
    let encoded = encode_block_document(
        &document.document_id,
        document.schema,
        document.title.as_deref(),
        &document.block_tree,
    )
    .map_err(|error| corrupt(format!("Current Document encoding failed: {error}")))?;
    decode_block_document(&encoded, document.schema)
        .map_err(|error| corrupt(format!("Current Document validation failed: {error}")))?;
    let transaction = encoded.transact();
    Ok((
        transaction.encode_state_as_update_v1(&StateVector::default()),
        transaction.state_vector().encode_v1(),
    ))
}

fn write_document(
    connection: &Connection,
    prepared: &PreparedDocument,
    timestamp: &str,
) -> Result<(), StoreError> {
    let projection_timestamp = if prepared.changed {
        timestamp
    } else {
        &prepared.materialization_updated_at
    };
    let snapshot_timestamp = if prepared.changed {
        timestamp
    } else {
        &prepared.snapshot_created_at
    };
    let target_version = i64::from(prepared.target_schema.schema_version());
    let changed = connection.execute(
        "UPDATE documents SET schema_version = ?1, state_vector = ?2, state_hash = '' \
         WHERE id = ?3 AND generation = ?4 AND head_seq = ?5 AND schema_key = ?6 \
           AND schema_version = ?7 AND readiness = 'ready' \
           AND authority = 'ydoc_primary' AND sync_engine = 'yjs'",
        params![
            target_version,
            prepared.state_vector,
            prepared.head.id,
            prepared.head.generation,
            prepared.head.head_seq,
            prepared.head.schema_key,
            prepared.head.schema_version,
        ],
    )?;
    if changed != 1 {
        return Err(corrupt(format!(
            "Document {} changed during schema migration",
            prepared.head.id
        )));
    }
    connection.execute(
        "DELETE FROM document_snapshots WHERE document_id = ?1 AND generation = ?2",
        params![prepared.head.id, prepared.head.generation],
    )?;
    connection.execute(
        "INSERT INTO document_snapshots(\
           document_id, generation, snapshot_seq, state_vector, snapshot_update, \
           snapshot_hash, schema_version, created_at\
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            prepared.head.id,
            prepared.head.generation,
            prepared.head.head_seq,
            prepared.state_vector,
            prepared.full_state,
            hash_bytes(&prepared.full_state),
            target_version,
            snapshot_timestamp,
        ],
    )?;
    persist_materialization_for_schema_migration(
        connection,
        &prepared.head.id,
        prepared.head.generation,
        prepared.head.head_seq,
        &prepared.materialization,
        projection_timestamp,
    )?;
    replace_document_block_index_for_schema_migration(
        connection,
        &prepared.head.id,
        prepared.head.head_seq,
        &prepared.materialization,
    )?;
    let _owned = replace_secondary_projections_for_schema_migration(
        connection,
        &prepared.head.id,
        &prepared.materialization,
        prepared.head.head_seq,
        projection_timestamp,
    )?;
    Ok(())
}

fn write_version(connection: &Connection, prepared: &PreparedVersion) -> Result<(), StoreError> {
    let row = &prepared.row;
    let checkpoint_hash = hash_bytes(&prepared.checkpoint);
    connection.execute(
        "INSERT OR REPLACE INTO document_versions(\
           version_id, document_id, project_id, generation, base_head_seq, schema_key, \
           schema_version, cause, label, actor_json, revision_kind, source_mutation_id, \
           source_change_seq, pinned, checkpoint_format, full_update_blob, state_vector, \
           checkpoint_hash, byte_length, created_at\
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, \
                   ?15, ?16, ?17, ?18, ?19, ?20)",
        params![
            row.version_id,
            row.document_id,
            row.project_id,
            row.generation,
            row.base_head_seq,
            row.schema_key,
            i64::from(prepared.target_schema.schema_version()),
            row.cause,
            row.label,
            row.actor_json,
            row.revision_kind,
            row.source_mutation_id,
            row.source_change_seq,
            row.pinned,
            row.checkpoint_format,
            prepared.checkpoint,
            prepared.state_vector,
            checkpoint_hash,
            i64::try_from(prepared.checkpoint.len())
                .map_err(|_| internal("Document version length overflow"))?,
            row.created_at,
        ],
    )?;
    Ok(())
}

fn read_version_rows(connection: &Connection) -> Result<Vec<VersionRow>, StoreError> {
    connection
        .prepare(
            "SELECT version.version_id, version.document_id, version.project_id, \
                    version.generation, version.base_head_seq, version.schema_key, \
                    version.schema_version, version.cause, version.label, version.actor_json, \
                    version.revision_kind, version.source_mutation_id, \
                    version.source_change_seq, version.pinned, version.checkpoint_format, \
                    version.full_update_blob, version.state_vector, version.checkpoint_hash, \
                    version.byte_length, version.created_at \
             FROM document_versions version \
             JOIN documents document ON document.id = version.document_id \
             WHERE document.sync_engine = 'yjs' ORDER BY version.version_id",
        )?
        .query_map([], |row| {
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
                checkpoint_format: row.get(14)?,
                full_update_blob: row.get(15)?,
                state_vector: row.get(16)?,
                checkpoint_hash: row.get(17)?,
                byte_length: row.get(18)?,
                created_at: row.get(19)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(StoreError::from)
}

fn stored_migration_schema(
    schema_key: &str,
    schema_version: i64,
) -> Result<BlockDocumentSchema, StoreError> {
    super::schema_compatibility::current_schema_for_stored_identity(schema_key, schema_version)
        .map_err(|_| corrupt(format!("Yjs Document schema {schema_key}@{schema_version} is not a published document migration baseline")))
}

fn decode_schema_migration_document(
    document: &yrs::Doc,
    target_schema: BlockDocumentSchema,
    source_version: i64,
) -> Result<DecodedBlockDocument, super::BlockDocumentError> {
    if source_version == i64::from(target_schema.schema_version()) {
        return decode_block_document(document, target_schema);
    }
    decode_block_document_allowing_illegal_children(document, target_schema)
}

fn normalize_schema_migration_forest(
    blocks: Vec<crate::domain::block_tree::BlockNode>,
    source_version: i64,
    target_schema: BlockDocumentSchema,
    document_id: &str,
) -> (crate::domain::block_children::NormalizedBlockForest, usize) {
    // Further steps in this unreleased version must never reinterpret content
    // already written with its current identity (especially Session mentions).
    if source_version == i64::from(target_schema.schema_version()) {
        return (
            crate::domain::block_children::NormalizedBlockForest {
                blocks,
                changed: false,
                lifted_roots: 0,
            },
            0,
        );
    }
    normalize_nodex_markdown_forest(blocks, document_id)
}

fn count_prompt_markers(blocks: &[MaterializedBlockNode]) -> usize {
    blocks
        .iter()
        .map(|block| {
            usize::from(block.block_type == "threadSection") + count_prompt_markers(&block.children)
        })
        .sum()
}

fn verify_hash(bytes: &[u8], expected: &str, label: &str) -> Result<(), StoreError> {
    if hash_bytes(bytes) == expected {
        return Ok(());
    }
    Err(corrupt(format!("{label} hash diverges")))
}

fn hash_bytes(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn corrupt(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message.into(), false)
}

fn internal(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::Internal, message.into(), false)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use rusqlite::params;
    use serde_json::json;
    use yrs::{StateVector, Text, Transact, Xml, XmlElementPrelim, XmlFragment};

    use super::*;
    use crate::document::create_compatible_document;
    use crate::infrastructure::document_repository::{
        DocumentAuthority, DocumentReadiness, DocumentSyncEngine,
    };
    use crate::infrastructure::legacy_visibility_migration::install_test_maintenance_context;
    use crate::infrastructure::schema::install_current_schema;

    fn block(
        id: &str,
        block_type: &str,
        children: Vec<MaterializedBlockNode>,
    ) -> MaterializedBlockNode {
        MaterializedBlockNode {
            id: id.to_owned(),
            block_type: block_type.to_owned(),
            props: BTreeMap::new(),
            content: (block_type != "threadSection").then(|| json!([])),
            children,
        }
    }

    fn baseline_version(block_tree: Vec<MaterializedBlockNode>) -> VersionRow {
        let checkpoint = canonical_json_bytes(
            serde_json::to_value(BlockTreeMigrationSnapshot {
                format_version: 2,
                kind: BlockDocumentKind::Page,
                block_tree,
                rich_title: Some(Vec::new()),
                file_snapshot: None,
            })
            .expect("snapshot"),
        )
        .expect("canonical snapshot");
        VersionRow {
            version_id: "version-1".to_owned(),
            document_id: "document-1".to_owned(),
            project_id: Some("project-1".to_owned()),
            generation: 1,
            base_head_seq: 1,
            schema_key: "nodex.page".to_owned(),
            schema_version: BASELINE_PAGE_SCHEMA_VERSION,
            cause: "manual".to_owned(),
            label: None,
            actor_json: "{}".to_owned(),
            revision_kind: "manual".to_owned(),
            source_mutation_id: None,
            source_change_seq: None,
            pinned: 1,
            checkpoint_format: "block_tree_snapshot_v2".to_owned(),
            checkpoint_hash: hash_bytes(&checkpoint),
            byte_length: checkpoint.len() as i64,
            full_update_blob: checkpoint,
            state_vector: Vec::new(),
            created_at: "2026-08-25T00:00:00.000Z".to_owned(),
        }
    }

    fn write_var_uint(bytes: &mut Vec<u8>, mut value: u64) {
        while value >= 0x80 {
            bytes.push((value as u8 & 0x7f) | 0x80);
            value >>= 7;
        }
        bytes.push(value as u8);
    }

    fn encode_state_vector_in_order(entries: &[(u64, u64)]) -> Vec<u8> {
        let mut encoded = Vec::new();
        write_var_uint(&mut encoded, entries.len() as u64);
        for &(client, clock) in entries {
            write_var_uint(&mut encoded, client);
            write_var_uint(&mut encoded, clock);
        }
        encoded
    }

    #[test]
    fn migrated_plain_captions_release_obsolete_retained_file_bindings() {
        let image = MaterializedBlockNode {
            id: "image".into(),
            block_type: "image".into(),
            props: BTreeMap::from([
                ("url".into(), json!("https://example.com/a.png")),
                (
                    "caption".into(),
                    json!(
                        r#"<attachment kind="file" source="nodex://files/caption-only" name="notes.txt" />"#
                    ),
                ),
            ]),
            content: None,
            children: vec![],
        };
        let mut row = baseline_version(vec![image]);
        row.checkpoint_format = "block_tree_snapshot_v3".into();
        let mut snapshot: serde_json::Value =
            serde_json::from_slice(&row.full_update_blob).unwrap();
        snapshot["formatVersion"] = json!(3);
        snapshot["fileSnapshot"] =
            json!({"files":{"caption-only":{"version":1,"defaultName":"notes.txt"}}});
        row.full_update_blob = canonical_json_bytes(snapshot).unwrap();
        row.byte_length = row.full_update_blob.len() as i64;
        row.checkpoint_hash = hash_bytes(&row.full_update_blob);
        let migration = MarkdownMigration {
            legacy_column: true,
            sessions: Default::default(),
            native_titles: Default::default(),
        };
        let prepared = prepare_version_with_markdown(row, Some(&migration)).unwrap();
        let snapshot: BlockTreeMigrationSnapshot =
            serde_json::from_slice(&prepared.checkpoint).unwrap();
        assert_eq!(snapshot.block_tree[0].props["caption"], "notes.txt");
        assert!(snapshot.file_snapshot.unwrap().files.is_empty());
    }

    #[test]
    fn reconstruction_accepts_semantically_equal_state_vector_ordering() {
        const NOW: &str = "2026-08-25T00:00:00.000Z";
        let first = create_compatible_document("first-client");
        let first_text = first.get_or_insert_text("first");
        first_text.insert(&mut first.transact_mut(), 0, "first");
        let first_transaction = first.transact();
        let snapshot_update = first_transaction.encode_state_as_update_v1(&StateVector::default());
        let snapshot_vector = first_transaction.state_vector().encode_v1();
        drop(first_transaction);

        let second = create_compatible_document("second-client");
        let second_text = second.get_or_insert_text("second");
        second_text.insert(&mut second.transact_mut(), 0, "second");
        let tail_update = second
            .transact()
            .encode_state_as_update_v1(&StateVector::default());

        let mut expected = YrsDocumentEngine::from_full_state_v1("document-1", &snapshot_update)
            .expect("snapshot");
        let tail = expected.prepare_update_v1(&tail_update).expect("tail");
        expected.commit_candidate(tail).expect("tail commit");
        let canonical_vector = expected.state_vector_v1();
        let mut entries = expected
            .document()
            .transact()
            .state_vector()
            .iter()
            .map(|(client, clock)| (client.get(), u64::from(*clock)))
            .collect::<Vec<_>>();
        assert_eq!(entries.len(), 2);
        entries.reverse();
        let differently_ordered_vector = encode_state_vector_in_order(&entries);
        if differently_ordered_vector == canonical_vector {
            entries.reverse();
        }
        let differently_ordered_vector = encode_state_vector_in_order(&entries);
        assert_ne!(differently_ordered_vector, canonical_vector);
        assert!(
            expected
                .state_vector_equals_v1(&differently_ordered_vector)
                .expect("semantic vector")
        );

        let connection = Connection::open_in_memory().expect("in-memory update log");
        connection
            .execute_batch(
                "CREATE TABLE document_updates (\
                   document_id TEXT NOT NULL, generation INTEGER NOT NULL, seq INTEGER NOT NULL, \
                   update_id TEXT NOT NULL, client_session_id TEXT NOT NULL, \
                   base_head_seq INTEGER NOT NULL, touched_block_ids_json TEXT NOT NULL, \
                   update_blob BLOB NOT NULL, update_hash TEXT NOT NULL, committed_at TEXT NOT NULL\
                 );",
            )
            .expect("update log");
        connection
            .execute(
                "INSERT INTO document_updates(\
                   document_id, generation, seq, update_id, client_session_id, base_head_seq, \
                   touched_block_ids_json, update_blob, update_hash, committed_at\
                 ) VALUES ('document-1', 1, 2, 'update-2', 'client-2', 1, '[]', ?1, ?2, ?3)",
                params![tail_update, hash_bytes(&tail_update), NOW],
            )
            .expect("tail update");
        let head = DocumentHeadRow {
            id: "document-1".to_owned(),
            library_id: "library-1".to_owned(),
            generation: 1,
            head_seq: 2,
            schema_key: "nodex.page".to_owned(),
            schema_version: BASELINE_PAGE_SCHEMA_VERSION,
            state_vector: differently_ordered_vector,
            state_hash: String::new(),
            readiness: DocumentReadiness::Ready,
            authority: DocumentAuthority::YdocPrimary,
            genesis_source_revision: None,
            created_at: NOW.to_owned(),
            updated_at: NOW.to_owned(),
            sync_engine: DocumentSyncEngine::Yjs,
        };
        let snapshot = DocumentSnapshotRow {
            document_id: head.id.clone(),
            generation: 1,
            snapshot_seq: 1,
            state_vector: snapshot_vector,
            snapshot_hash: hash_bytes(&snapshot_update),
            snapshot_update,
            schema_version: BASELINE_PAGE_SCHEMA_VERSION,
            created_at: NOW.to_owned(),
        };

        let reconstructed = reconstruct_baseline_document(
            &DocumentReadRepository::new(&connection),
            &head,
            &snapshot,
        )
        .expect("semantic head vector must reconstruct");
        assert!(
            reconstructed
                .state_vector_equals_v1(&head.state_vector)
                .expect("reconstructed semantic vector")
        );
    }

    #[test]
    fn retained_version_stably_lifts_illegal_children_and_then_converges() {
        let prepared = prepare_version(baseline_version(vec![block(
            "code",
            "codeBlock",
            vec![block("child", "paragraph", Vec::new())],
        )]))
        .expect("baseline version");
        assert!(prepared.changed);
        assert_eq!(prepared.lifted_roots, 1);
        let snapshot = serde_json::from_slice::<BlockTreeMigrationSnapshot>(&prepared.checkpoint)
            .expect("current checkpoint");
        assert_eq!(
            snapshot
                .block_tree
                .iter()
                .map(|block| block.id.as_str())
                .collect::<Vec<_>>(),
            ["code", "child"]
        );
        assert!(snapshot.block_tree[0].children.is_empty());

        let converged = prepare_version(baseline_version(snapshot.block_tree))
            .expect("already normalized baseline payload");
        assert!(!converged.changed);
        assert_eq!(converged.lifted_roots, 0);
    }

    #[test]
    fn migration_reader_rejects_unpublished_schemas_and_unknown_vocabulary() {
        let mut old_schema = baseline_version(Vec::new());
        old_schema.schema_version = 1;
        assert_eq!(
            prepare_version(old_schema).expect_err("old schema").code,
            StoreErrorCode::StoreCorrupt
        );

        let unknown = baseline_version(vec![block("unknown", "unknownRetiredType", Vec::new())]);
        assert_eq!(
            prepare_version(unknown)
                .expect_err("unknown current type")
                .code,
            StoreErrorCode::StoreCorrupt
        );
    }

    fn retained_legacy_store(
        content_type: &str,
        include_child: bool,
        has_title: bool,
    ) -> Connection {
        const NOW: &str = "2026-08-25T00:00:00.000Z";
        let document = create_compatible_document("document-1");
        if has_title {
            document.get_or_insert_text("title");
        }
        let body = document.get_or_insert_xml_fragment("body");
        {
            let mut transaction = document.transact_mut();
            let root = body.insert(&mut transaction, 0, XmlElementPrelim::empty("blockGroup"));
            let code = root.insert(
                &mut transaction,
                0,
                XmlElementPrelim::empty("blockContainer"),
            );
            code.insert_attribute(&mut transaction, "id", "code");
            code.insert(&mut transaction, 0, XmlElementPrelim::empty(content_type));
            if include_child {
                let children =
                    code.insert(&mut transaction, 1, XmlElementPrelim::empty("blockGroup"));
                let paragraph = children.insert(
                    &mut transaction,
                    0,
                    XmlElementPrelim::empty("blockContainer"),
                );
                paragraph.insert_attribute(&mut transaction, "id", "paragraph");
                paragraph.insert(&mut transaction, 0, XmlElementPrelim::empty("paragraph"));
            }
        }
        let transaction = document.transact();
        let full_state = transaction.encode_state_as_update_v1(&StateVector::default());
        let state_vector = transaction.state_vector().encode_v1();
        drop(transaction);

        let mut connection = Connection::open_in_memory().expect("in-memory Store");
        install_current_schema(&mut connection).expect("current schema");
        install_test_maintenance_context(&connection).expect("maintenance context");
        connection
            .execute(
                "INSERT INTO profiles(id, created_at, updated_at) VALUES ('profile-1', ?1, ?1)",
                [NOW],
            )
            .expect("Profile");
        connection
            .execute(
                "INSERT INTO libraries(id, profile_id, created_at, updated_at) \
                 VALUES ('library-1', 'profile-1', ?1, ?1)",
                [NOW],
            )
            .expect("Library");
        for (id, block_type) in [
            ("page-owner", "page"),
            ("code", content_type),
            ("paragraph", "paragraph"),
        ] {
            connection
                .execute(
                    "INSERT INTO blocks(id, library_id, type, created_at, updated_at) \
                     VALUES (?1, 'library-1', ?2, ?3, ?3)",
                    params![id, block_type, NOW],
                )
                .expect("Block");
        }
        connection
            .execute(
                "INSERT INTO documents( \
                   id, library_id, generation, head_seq, schema_key, schema_version, state_vector, \
                   state_hash, readiness, authority, created_at, updated_at, sync_engine \
                 ) VALUES ('document-1', 'library-1', 1, 0, 'nodex.page', 2, ?1, '', \
                   'ready', 'ydoc_primary', ?2, ?2, 'yjs')",
                params![state_vector, NOW],
            )
            .expect("baseline Document");
        connection
            .execute(
                "INSERT INTO block_documents(block_id, document_id, library_id, created_at) \
                 VALUES ('page-owner', 'document-1', 'library-1', ?1)",
                [NOW],
            )
            .expect("Document owner");
        connection
            .execute(
                "INSERT INTO pages( \
                   block_id, library_id, document_id, parent_kind, parent_id, created_at, updated_at \
                 ) VALUES ('page-owner', 'library-1', 'document-1', 'library', 'library-1', ?1, ?1)",
                [NOW],
            )
            .expect("Page authority");
        connection
            .execute(
                "INSERT INTO document_snapshots( \
                   document_id, generation, snapshot_seq, state_vector, snapshot_update, \
                   snapshot_hash, schema_version, created_at \
                 ) VALUES ('document-1', 1, 0, ?1, ?2, ?3, 2, ?4)",
                params![state_vector, full_state, hash_bytes(&full_state), NOW],
            )
            .expect("baseline snapshot");
        let baseline_tree = serde_json::to_string(&vec![block(
            "code",
            content_type,
            if include_child {
                vec![block("paragraph", "paragraph", Vec::new())]
            } else {
                Vec::new()
            },
        )])
        .expect("baseline tree");
        connection
            .execute(
                "INSERT INTO document_materializations( \
                   document_id, generation, projected_seq, schema_version, markdown, plain_text, \
                   preview, block_tree_json, updated_at \
                 ) VALUES ('document-1', 1, 0, 2, '', '', '', ?1, ?2)",
                params![baseline_tree, NOW],
            )
            .expect("baseline materialization");
        connection
            .execute(
                "INSERT INTO document_block_index( \
                   document_id, block_id, parent_block_id, ordinal, block_type, text, projected_seq\
                 ) VALUES \
                   ('document-1', 'code', NULL, 0, 'codeBlock', '', 0), \
                   ('document-1', 'paragraph', 'code', 0, 'paragraph', '', 0)",
                [],
            )
            .expect("baseline index");
        connection
            .execute(
                "UPDATE document_block_index SET block_type = ?1 WHERE block_id = 'code'",
                [content_type],
            )
            .expect("source index type");
        if !include_child {
            connection
                .execute(
                    "DELETE FROM document_block_index WHERE block_id = 'paragraph'",
                    [],
                )
                .expect("no child index");
        }
        connection
            .execute(
                "UPDATE blocks SET lifecycle = 'deleted' \
                 WHERE id IN ('page-owner', 'code', 'paragraph')",
                [],
            )
            .expect("retained deleted Document");
        connection
            .execute(
                "INSERT INTO page_read_model( \
                   page_block_id, library_id, lifecycle, parent_kind, parent_id, \
                   placement_revision, metadata_revision, document_id, document_generation, \
                   document_projected_seq, document_schema_version, document_authority, \
                   title, description_preview, description_length, has_description, \
                   created_at, updated_at \
                 ) VALUES ( \
                   'page-owner', 'library-1', 'deleted', 'library', 'library-1', \
                   1, 1, 'document-1', 1, 0, 2, 'ydoc_primary', '', '', 0, 0, ?1, ?1 \
                 )",
                [NOW],
            )
            .expect("baseline Page projection");

        connection
    }

    #[test]
    fn migrates_a_retained_deleted_head_and_rebuilds_its_current_projection() {
        let connection = retained_legacy_store("codeBlock", true, true);
        let evidence = migrate_block_children_contract(&connection, 1_777_000_000_000)
            .expect("Block children migration");
        DocumentReadRepository::new(&connection)
            .materialization("document-1")
            .expect("canonical migrated materialization")
            .expect("migrated materialization");

        assert_eq!(
            evidence,
            DocumentSchemaMigrationEvidence {
                scanned_documents: 1,
                changed_documents: 1,
                scanned_versions: 0,
                changed_versions: 0,
                lifted_roots: 1,
                removed_prompt_markers: 0,
            }
        );
        let versions = connection
            .query_row(
                "SELECT document.schema_version, snapshot.schema_version, materialization.schema_version \
                 FROM documents document \
                 JOIN document_snapshots snapshot ON snapshot.document_id = document.id \
                 JOIN document_materializations materialization ON materialization.document_id = document.id \
                 WHERE document.id = 'document-1'",
                [],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?)),
            )
            .expect("current versions");
        assert_eq!(versions, (4, 4, 4));
        assert_eq!(
            connection
                .query_row(
                    "SELECT document_schema_version FROM page_read_model \
                     WHERE page_block_id = 'page-owner'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .expect("migrated Page projection"),
            4
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT count(*) FROM blocks \
                     WHERE id IN ('page-owner', 'code', 'paragraph') AND lifecycle = 'deleted'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .expect("retained deleted Blocks"),
            3
        );
        let placements = connection
            .prepare(
                "SELECT block_id, parent_block_id, ordinal FROM document_block_index \
                 WHERE document_id = 'document-1' ORDER BY ordinal",
            )
            .expect("index query")
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })
            .expect("index rows")
            .collect::<rusqlite::Result<Vec<_>>>()
            .expect("current index");
        assert_eq!(
            placements,
            vec![
                ("code".to_owned(), None, 0),
                ("paragraph".to_owned(), None, 1),
            ]
        );

        connection
            .execute_batch("DROP TRIGGER page_read_model_validate_update;")
            .expect("controlled stale projection fixture");
        connection
            .execute(
                "UPDATE page_read_model SET document_schema_version = 2, \
                   database_values_json = '{\"status\":\"ship\"}' \
                 WHERE page_block_id = 'page-owner'",
                [],
            )
            .expect("published stale projection shape");
        let repair = repair_document_schema_projections(&connection, 1_777_000_000_001)
            .expect("repair published projection gap");
        assert_eq!(
            repair,
            DocumentProjectionRepairEvidence {
                scanned_documents: 1,
                refreshed_owned_projections: 1,
                cleared_unowned_projections: 0,
            }
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT document_schema_version, database_values_json \
                     FROM page_read_model WHERE page_block_id = 'page-owner'",
                    [],
                    |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
                )
                .expect("repaired Page projection"),
            (4, "{\"status\":\"ship\"}".to_owned())
        );
    }
    #[test]
    fn nodex_markdown_removes_markers_from_all_document_kinds_and_retained_heads() {
        for (schema_key, source_version, schema, has_title) in [
            ("nodex.page", 3, BlockDocumentSchema::PageV4, true),
            (
                "nodex.synced-block",
                2,
                BlockDocumentSchema::SyncedBlockV3,
                false,
            ),
            (
                "nodex.reusable-template",
                2,
                BlockDocumentSchema::ReusableTemplateV3,
                false,
            ),
        ] {
            for include_child in [true, false] {
                let connection = retained_legacy_store("threadSection", include_child, has_title);
                if !has_title {
                    connection
                        .execute("DELETE FROM page_read_model", [])
                        .unwrap();
                    connection.execute("DELETE FROM pages", []).unwrap();
                    connection
                        .execute("DELETE FROM block_documents", [])
                        .unwrap();
                }
                connection
                    .execute(
                        "UPDATE documents SET schema_key = ?1, schema_version = ?2",
                        params![schema_key, source_version],
                    )
                    .unwrap();
                connection
                    .execute(
                        "UPDATE document_snapshots SET schema_version = ?1",
                        [source_version],
                    )
                    .unwrap();
                connection
                    .execute(
                        "UPDATE document_materializations SET schema_version = ?1",
                        [source_version],
                    )
                    .unwrap();
                if has_title {
                    connection
                        .execute(
                            "UPDATE page_read_model SET document_schema_version = ?1",
                            [source_version],
                        )
                        .unwrap();
                    connection.execute("INSERT INTO project_sessions(id,no_thread_fallback_title,\"order\",created_at,updated_at) VALUES ('session-1','Keep chat',0,'2026-08-25T00:00:00.000Z','2026-08-25T00:00:00.000Z')", []).unwrap();
                    connection.execute("INSERT INTO project_session_pages(session_id,page_id,linked_at) VALUES ('session-1','page-owner','2026-08-25T00:00:00.000Z')", []).unwrap();
                }
                let source_repository = DocumentReadRepository::new(&connection);
                let source_snapshot = source_repository
                    .latest_snapshot("document-1", 1, 0)
                    .unwrap()
                    .unwrap();
                let source_tree: Vec<MaterializedBlockNode> = serde_json::from_value(
                    source_repository
                        .materialization("document-1")
                        .unwrap()
                        .unwrap()
                        .block_tree,
                )
                .unwrap();
                for (name, format) in [
                    ("yrs", "yjs_update_v1"),
                    ("tree2", "block_tree_snapshot_v2"),
                    ("tree3", "block_tree_snapshot_v3"),
                ] {
                    let (bytes, vector) = if name == "yrs" {
                        (
                            source_snapshot.snapshot_update.clone(),
                            source_snapshot.state_vector.clone(),
                        )
                    } else {
                        let snapshot = BlockTreeMigrationSnapshot {
                            format_version: if name == "tree3" { 3 } else { 2 },
                            kind: schema_metadata(schema).kind,
                            block_tree: source_tree.clone(),
                            rich_title: has_title.then(Vec::new),
                            file_snapshot: (name == "tree3").then(|| {
                                crate::domain::files::FileSnapshotManifest {
                                    files: BTreeMap::new(),
                                }
                            }),
                        };
                        (
                            canonical_json_bytes(serde_json::to_value(snapshot).unwrap()).unwrap(),
                            Vec::new(),
                        )
                    };
                    connection.execute(
                        "INSERT INTO document_versions(version_id,document_id,project_id,generation,base_head_seq,schema_key,schema_version,cause,checkpoint_format,full_update_blob,state_vector,checkpoint_hash,byte_length,created_at) VALUES (?1,'document-1',NULL,1,0,?2,?3,'manual',?4,?5,?6,?7,?8,'2026-08-25T00:00:00.000Z')",
                        params![name, schema_key, source_version, format, bytes, vector, hash_bytes(&bytes), bytes.len() as i64],
                    ).unwrap();
                }
                let evidence = migrate_nodex_markdown_contract(&connection, 1_777_000_000_000)
                    .expect("Nodex Markdown migration");
                assert_eq!(evidence.removed_prompt_markers, 4);
                assert_eq!(evidence.changed_versions, 3);
                assert_eq!(evidence.changed_documents, 1);
                let repository = DocumentReadRepository::new(&connection);
                let head = repository.document_head("document-1").unwrap().unwrap();
                assert_eq!(head.schema_version, i64::from(schema.schema_version()));
                let snapshot = repository
                    .latest_snapshot("document-1", 1, 0)
                    .unwrap()
                    .unwrap();
                let engine =
                    YrsDocumentEngine::from_full_state_v1("document-1", &snapshot.snapshot_update)
                        .unwrap();
                let decoded = decode_block_document(engine.document(), schema)
                    .expect("strict current schema");
                let current = materialize_decoded_document(&decoded).unwrap();
                assert_eq!(current.block_tree.len(), 1);
                let paragraph = &current.block_tree[0];
                assert_eq!(paragraph.block_type, "paragraph");
                assert!(paragraph.children.is_empty());
                assert_eq!(paragraph.content, Some(json!([])));
                if include_child {
                    assert_eq!(paragraph.id, "paragraph");
                } else {
                    assert_ne!(paragraph.id, "code");
                }
                let persisted = repository.materialization("document-1").unwrap().unwrap();
                assert_eq!(
                    persisted.block_tree,
                    serde_json::to_value(&current.block_tree).unwrap()
                );
                assert!(current.markdown.is_empty());
                assert_eq!(
                    connection
                        .query_row(
                            "SELECT count(*) FROM document_block_index WHERE block_id = 'code'",
                            [],
                            |row| row.get::<_, i64>(0)
                        )
                        .unwrap(),
                    0
                );
                assert_eq!(
                    connection
                        .query_row(
                            "SELECT lifecycle FROM blocks WHERE id = 'code'",
                            [],
                            |row| row.get::<_, String>(0)
                        )
                        .unwrap(),
                    "deleted"
                );
                if has_title {
                    assert_eq!(connection.query_row("SELECT count(*) FROM project_session_pages WHERE session_id = 'session-1' AND page_id = 'page-owner'", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
                }
                let versions = read_version_rows(&connection).unwrap();
                assert_eq!(versions.len(), 3);
                for row in &versions {
                    assert_eq!(row.schema_version, i64::from(schema.schema_version()));
                    assert_eq!(hash_bytes(&row.full_update_blob), row.checkpoint_hash);
                    assert_eq!(row.byte_length, row.full_update_blob.len() as i64);
                    assert_eq!(connection.query_row("SELECT checkpoint_hash FROM document_version_retention_index WHERE version_id = ?1", [&row.version_id], |row| row.get::<_, String>(0)).unwrap(), row.checkpoint_hash);
                    assert_eq!(connection.query_row("SELECT checkpoint_hash FROM document_version_file_index WHERE version_id = ?1", [&row.version_id], |row| row.get::<_, String>(0)).unwrap(), row.checkpoint_hash);
                }
                let before = snapshot.snapshot_update;
                let repeat =
                    migrate_nodex_markdown_contract(&connection, 1_777_000_000_001).unwrap();
                assert_eq!(repeat.changed_documents, 0);
                assert_eq!(repeat.removed_prompt_markers, 0);
                assert_eq!(
                    repository
                        .latest_snapshot("document-1", 1, 0)
                        .unwrap()
                        .unwrap()
                        .snapshot_update,
                    before
                );
            }
        }
    }

    #[test]
    fn nodex_markdown_preserves_siblings_and_nested_children_in_every_checkpoint_schema() {
        for (schema_key, source_version, kind, rich_title) in [
            ("nodex.page", 3, BlockDocumentKind::Page, Some(Vec::new())),
            (
                "nodex.synced-block",
                2,
                BlockDocumentKind::SyncedBlock,
                None,
            ),
            (
                "nodex.reusable-template",
                2,
                BlockDocumentKind::ReusableTemplate,
                None,
            ),
        ] {
            let mut following = block("following", "paragraph", Vec::new());
            following.content = Some(
                json!([{ "type":"text", "text":"Keep following content", "styles": {"bold":true} }, {"type":"agentConfig", "props":{"mode":"plan"}}]),
            );
            let tree = vec![
                block("before", "paragraph", Vec::new()),
                block(
                    "marker",
                    "threadSection",
                    vec![block(
                        "nested",
                        "threadSection",
                        vec![block("lifted", "paragraph", Vec::new())],
                    )],
                ),
                following.clone(),
            ];
            let mut row = baseline_version(tree.clone());
            row.schema_key = schema_key.to_owned();
            row.schema_version = source_version;
            row.full_update_blob = canonical_json_bytes(
                serde_json::to_value(BlockTreeMigrationSnapshot {
                    format_version: 2,
                    kind,
                    block_tree: tree,
                    rich_title,
                    file_snapshot: None,
                })
                .unwrap(),
            )
            .unwrap();
            row.byte_length = row.full_update_blob.len() as i64;
            row.checkpoint_hash = hash_bytes(&row.full_update_blob);
            let prepared = prepare_version(row).unwrap();
            assert_eq!(prepared.removed_prompt_markers, 2);
            let current: BlockTreeMigrationSnapshot =
                serde_json::from_slice(&prepared.checkpoint).unwrap();
            assert_eq!(
                current
                    .block_tree
                    .iter()
                    .map(|block| block.id.as_str())
                    .collect::<Vec<_>>(),
                ["before", "lifted", "following"]
            );
            assert_eq!(current.block_tree[2], following);
        }
    }

    #[test]
    fn nodex_markdown_rewrites_yjs_checkpoints_and_rejects_corruption_before_writes() {
        let connection = retained_legacy_store("threadSection", true, true);
        let repository = DocumentReadRepository::new(&connection);
        let snapshot = repository
            .latest_snapshot("document-1", 1, 0)
            .unwrap()
            .unwrap();
        let source_engine =
            YrsDocumentEngine::from_full_state_v1("document-1", &snapshot.snapshot_update).unwrap();
        assert!(
            decode_block_document(source_engine.document(), BlockDocumentSchema::PageV4).is_err()
        );
        let mut row = baseline_version(Vec::new());
        row.schema_version = 3;
        row.checkpoint_format = "yjs_update_v1".to_owned();
        row.full_update_blob = snapshot.snapshot_update.clone();
        row.state_vector = snapshot.state_vector;
        row.byte_length = row.full_update_blob.len() as i64;
        row.checkpoint_hash = hash_bytes(&row.full_update_blob);
        let prepared = prepare_version(row).expect("retained Yjs checkpoint");
        assert_eq!(prepared.removed_prompt_markers, 1);
        let engine =
            YrsDocumentEngine::from_full_state_v1("document-1", &prepared.checkpoint).unwrap();
        let decoded =
            decode_block_document(engine.document(), BlockDocumentSchema::PageV4).unwrap();
        assert_eq!(decoded.block_tree.blocks[0].id, "paragraph");
        assert!(
            engine
                .state_vector_equals_v1(&prepared.state_vector)
                .unwrap()
        );

        connection
            .execute(
                "UPDATE document_snapshots SET snapshot_hash = ?1",
                ["0".repeat(64)],
            )
            .unwrap();
        assert!(migrate_nodex_markdown_contract(&connection, 1_777_000_000_000).is_err());
        assert_eq!(
            repository
                .document_head("document-1")
                .unwrap()
                .unwrap()
                .schema_version,
            2
        );
        assert_eq!(
            repository
                .latest_snapshot("document-1", 1, 0)
                .unwrap()
                .unwrap()
                .snapshot_update,
            snapshot.snapshot_update
        );
    }

    #[test]
    fn nodex_markdown_rolls_back_head_and_checkpoint_rewrites_on_projection_failure() {
        let mut connection = retained_legacy_store("threadSection", true, true);
        let before = DocumentReadRepository::new(&connection)
            .latest_snapshot("document-1", 1, 0)
            .unwrap()
            .unwrap();
        connection.execute_batch("CREATE TRIGGER reject_migration_projection BEFORE UPDATE ON document_materializations BEGIN SELECT RAISE(ABORT, 'projection failure'); END;").unwrap();
        let result = crate::infrastructure::sqlite::with_immediate_transaction(
            &mut connection,
            |transaction| migrate_nodex_markdown_contract(transaction, 1_777_000_000_000),
        );
        assert!(result.is_err());
        let repository = DocumentReadRepository::new(&connection);
        assert_eq!(
            repository
                .document_head("document-1")
                .unwrap()
                .unwrap()
                .schema_version,
            2
        );
        let after = repository
            .latest_snapshot("document-1", 1, 0)
            .unwrap()
            .unwrap();
        assert_eq!(after.snapshot_update, before.snapshot_update);
        assert_eq!(after.state_vector, before.state_vector);
        assert_eq!(after.snapshot_hash, before.snapshot_hash);
        assert_eq!(
            connection
                .query_row(
                    "SELECT count(*) FROM document_block_index WHERE block_id = 'code'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
    }
    #[test]
    fn nodex_markdown_upgrades_pending_documents_without_creating_body_content() {
        let connection = retained_legacy_store("threadSection", false, true);
        for (key, old_version, new_version) in [
            ("nodex.page", 3, 4),
            ("nodex.synced-block", 2, 3),
            ("nodex.reusable-template", 2, 3),
        ] {
            connection.execute("INSERT INTO documents(id,library_id,schema_key,schema_version,readiness,authority,created_at,updated_at) VALUES (?1,'library-1',?1,?2,'pending_genesis','legacy_shadow','2026-08-25T00:00:00.000Z','2026-08-25T00:00:00.000Z')", params![key, old_version]).unwrap();
            migrate_nodex_markdown_contract(&connection, 1_777_000_000_000).unwrap();
            let head = DocumentReadRepository::new(&connection)
                .document_head(key)
                .unwrap()
                .unwrap();
            assert_eq!(head.schema_version, new_version);
            assert_eq!(head.readiness, DocumentReadiness::PendingGenesis);
            assert!(
                DocumentReadRepository::new(&connection)
                    .materialization(key)
                    .unwrap()
                    .is_none()
            );
        }
    }

    #[test]
    fn nodex_markdown_retains_image_metadata_and_frozen_file_bindings() {
        let image = MaterializedBlockNode {
            id: "image".to_owned(),
            block_type: "image".to_owned(),
            props: BTreeMap::from([
                ("url".to_owned(), json!("nodex://files/file-1")),
                ("caption".to_owned(), json!("**Sketch**")),
                ("backgroundColor".to_owned(), json!("blue")),
                ("name".to_owned(), json!("diagram.png")),
                ("sourceWidth".to_owned(), json!(640)),
                ("sourceHeight".to_owned(), json!(480)),
            ]),
            content: None,
            children: Vec::new(),
        };
        let files = crate::domain::files::FileSnapshotManifest {
            files: BTreeMap::from([(
                "file-1".to_owned(),
                crate::domain::files::FileSnapshotTarget {
                    version: 7,
                    default_name: "original.png".to_owned(),
                },
            )]),
        };
        let snapshot = BlockTreeMigrationSnapshot {
            format_version: 3,
            kind: BlockDocumentKind::Page,
            block_tree: vec![block("marker", "threadSection", Vec::new()), image.clone()],
            rich_title: Some(Vec::new()),
            file_snapshot: Some(files.clone()),
        };
        let mut row = baseline_version(Vec::new());
        row.schema_version = 3;
        row.checkpoint_format = "block_tree_snapshot_v3".to_owned();
        row.full_update_blob =
            canonical_json_bytes(serde_json::to_value(snapshot).unwrap()).unwrap();
        row.byte_length = row.full_update_blob.len() as i64;
        row.checkpoint_hash = hash_bytes(&row.full_update_blob);
        let prepared = prepare_version(row).unwrap();
        let current: BlockTreeMigrationSnapshot =
            serde_json::from_slice(&prepared.checkpoint).unwrap();
        assert_eq!(current.block_tree, vec![image]);
        assert_eq!(current.file_snapshot, Some(files));
    }
}

/// The one-time translation of predecessor content. Session identity is Profile-wide;
/// an ambiguous execution root must never choose an arbitrary Session.
struct MarkdownMigration {
    legacy_column: bool,
    sessions: std::collections::BTreeMap<String, std::collections::BTreeSet<String>>,
    native_titles: std::collections::BTreeMap<String, String>,
}

enum MentionTarget<'a> {
    Session(&'a str),
    Native(&'a str),
    Unchanged,
}

impl MarkdownMigration {
    fn applies_to(&self, source_version: i64, target_schema: BlockDocumentSchema) -> bool {
        self.legacy_column || source_version < i64::from(target_schema.schema_version())
    }
    fn load(connection: &Connection) -> Result<Self, StoreError> {
        let mut sessions =
            std::collections::BTreeMap::<String, std::collections::BTreeSet<String>>::new();
        for (table, column) in [
            ("project_session_threads", "thread_id"),
            ("project_session_execution_bindings", "runtime_thread_id"),
        ] {
            let exists: bool = connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
                [table],
                |row| row.get(0),
            )?;
            if !exists {
                continue;
            }
            let mut statement = connection.prepare(&format!("SELECT binding.{column},binding.session_id FROM {table} binding JOIN project_sessions session ON session.id=binding.session_id"))?;
            for row in statement.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })? {
                let (thread, session) = row?;
                sessions.entry(thread).or_default().insert(session);
            }
        }
        let has_backend: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('codex_threads') WHERE name='agent_backend_kind')",[],|row| row.get(0))?;
        let filter = if has_backend {
            " WHERE agent_backend_kind = 'codex'"
        } else {
            ""
        };
        let native_titles = connection.prepare(&format!("SELECT thread_id,COALESCE(NULLIF(thread_name,''),'Codex chat') FROM codex_threads{filter}"))?.query_map([], |row| Ok((row.get(0)?,row.get(1)?)))?.collect::<rusqlite::Result<_>>()?;
        Ok(Self {
            legacy_column: stored_markdown_column(connection)? != "markdown",
            sessions,
            native_titles,
        })
    }

    fn target(&self, thread: &str) -> MentionTarget<'_> {
        if let Some(sessions) = self.sessions.get(thread) {
            return if sessions.len() == 1 {
                MentionTarget::Session(sessions.first().expect("one Session"))
            } else {
                MentionTarget::Unchanged
            };
        }
        self.native_titles
            .get(thread)
            .map_or(MentionTarget::Unchanged, |title| {
                MentionTarget::Native(title)
            })
    }

    fn transform_title(&self, title: &mut Vec<RichTextItem>) -> bool {
        let mut changed = false;
        for item in title {
            let RichTextItem::ThreadMention { uuid } = item else {
                continue;
            };
            match self.target(uuid) {
                MentionTarget::Session(session) => {
                    changed |= uuid != session;
                    *uuid = session.into();
                }
                MentionTarget::Native(title) => {
                    *item = RichTextItem::Link {
                        text: title.into(),
                        href: format!(
                            "codex://threads/{}",
                            nodex_markdown::links::encode_component(uuid)
                        ),
                        styles: Default::default(),
                    };
                    changed = true;
                }
                MentionTarget::Unchanged => {}
            }
        }
        changed
    }

    fn transform_inline(&self, value: &mut serde_json::Value) -> bool {
        use serde_json::{Value, json};
        match value {
            Value::Array(items) => items
                .iter_mut()
                .fold(false, |changed, item| self.transform_inline(item) | changed),
            Value::Object(object) => {
                if object.get("type").and_then(Value::as_str) == Some("threadMention") {
                    let Some(uuid) = object
                        .get("props")
                        .and_then(|props| props.get("uuid"))
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                    else {
                        return false;
                    };
                    match self.target(&uuid) {
                        MentionTarget::Session(session) if session != uuid => {
                            object.get_mut("props").expect("mention props")["uuid"] =
                                json!(session);
                            return true;
                        }
                        MentionTarget::Native(title) => {
                            *value = json!({"type":"link","href":format!("codex://threads/{}",nodex_markdown::links::encode_component(&uuid)),"content":[{"type":"text","text":title,"styles":{}}]});
                            return true;
                        }
                        _ => return false,
                    }
                }
                object.values_mut().fold(false, |changed, value| {
                    self.transform_inline(value) | changed
                })
            }
            _ => false,
        }
    }

    fn transform_blocks(&self, blocks: &mut [MaterializedBlockNode]) -> bool {
        let mut changed = false;
        for block in blocks {
            if block.block_type == "image" {
                changed |= block.props.remove("backgroundColor").is_some();
                if let Some(serde_json::Value::String(caption)) = block.props.get_mut("caption") {
                    let plain = decode_legacy_caption(caption);
                    changed |= *caption != plain;
                    *caption = plain;
                }
            }
            if let Some(content) = &mut block.content {
                changed |= self.transform_inline(content);
            }
            changed |= self.transform_blocks(&mut block.children);
        }
        changed
    }

    fn transform_document(&self, document: &mut DecodedBlockDocument) -> Result<bool, StoreError> {
        let mut blocks = materialize_block_tree(&document.block_tree)
            .map_err(|error| corrupt(error.to_string()))?;
        let mut changed = self.transform_blocks(&mut blocks);
        if changed {
            document.block_tree =
                dematerialize_block_tree(&blocks).map_err(|error| corrupt(error.to_string()))?;
        }
        if let Some(delta) = &mut document.title {
            let mut title = crate::domain::rich_text::materialize_rich_text(delta)
                .map_err(|error| corrupt(error.to_string()))?
                .rich_text;
            if self.transform_title(&mut title) {
                *delta = rich_text_to_delta(&title).map_err(|error| corrupt(error.to_string()))?;
                changed = true;
            }
        }
        Ok(changed)
    }
}

/// Only predecessor image captions contain escaped inline NFM. Decode their text once,
/// preserving whitespace; current captions never pass through a markup decoder.
fn decode_legacy_caption(caption: &str) -> String {
    use std::sync::LazyLock;
    static SPAN: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"</?span(?:\s[^>]*)?>").expect("legacy span pattern"));
    static ATOM: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(
            r#"<(attachment|mention-page|mention-thread|mention-date|agent-config)\b([^>]*)/?>"#,
        )
        .expect("legacy caption atoms")
    });
    static ATTR: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r#"([a-z-]+)="([^"]*)""#).expect("legacy caption attributes")
    });
    let escaped = |text: &str, start: usize| {
        text[..start]
            .bytes()
            .rev()
            .take_while(|byte| *byte == b'\\')
            .count()
            % 2
            == 1
    };
    let caption = SPAN.replace_all(caption, |capture: &regex::Captures<'_>| {
        let found = capture.get(0).expect("span match");
        if escaped(caption, found.start()) {
            found.as_str().to_owned()
        } else {
            String::new()
        }
    });
    let decoded = ATOM.replace_all(&caption, |capture: &regex::Captures<'_>| {
        let found = capture.get(0).expect("atom match");
        if escaped(&caption, found.start()) {
            return found.as_str().to_owned();
        }
        let attributes = ATTR
            .captures_iter(&capture[2])
            .map(|item| {
                (
                    item[1].to_owned(),
                    item[2]
                        .replace("&quot;", "\"")
                        .replace("&lt;", "<")
                        .replace("&gt;", ">")
                        .replace("&amp;", "&"),
                )
            })
            .collect::<std::collections::BTreeMap<_, _>>();
        let text = match &capture[1] {
            "attachment" => attributes.get("name").cloned().unwrap_or_default(),
            "mention-page" => attributes.get("url").cloned().unwrap_or_default(),
            "mention-thread" => attributes.get("uuid").cloned().unwrap_or_default(),
            "mention-date" => nodex_markdown::text::date_plain_text(&nodex_markdown::DateMention {
                start: attributes.get("start").cloned().unwrap_or_default(),
                end: attributes.get("end").cloned(),
                tz: attributes.get("tz").cloned(),
                format: attributes.get("format").cloned(),
                time_format: attributes.get("time-format").cloned(),
                reminder: attributes.get("reminder").cloned(),
            }),
            "agent-config" => ["mode", "model", "reasoning"]
                .iter()
                .filter_map(|key| attributes.get(*key))
                .cloned()
                .collect::<Vec<_>>()
                .join(" "),
            _ => String::new(),
        };
        nodex_markdown::write_inline(&[nodex_markdown::Inline::Text {
            text,
            style: Default::default(),
        }])
    });
    nodex_markdown::read_inline(&decoded, nodex_markdown::ReadOptions::BOUNDARY)
        .map(|inline| nodex_markdown::text::inline_text(&inline))
        .unwrap_or_else(|_| decoded.into_owned())
}

#[cfg(test)]
mod markdown_contract_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn legacy_captions_become_plain_text_without_collapsing_spaces() {
        assert_eq!(
            decode_legacy_caption(r#"A \*literal\* **bold**  caption<br>next"#),
            "A *literal* bold  caption\nnext"
        );
        assert_eq!(
            decode_legacy_caption(
                r#"<span color="red">a</span> [link](https://example.com) `code`"#
            ),
            "a link code"
        );
        assert_eq!(
            decode_legacy_caption(r#"\<span color="red">literal\</span>"#),
            r#"<span color="red">literal</span>"#
        );
        assert_eq!(
            decode_legacy_caption(
                r#"<attachment kind="file" name="*literal*.txt" source="file" />"#
            ),
            "*literal*.txt"
        );
    }

    #[test]
    fn mentions_use_unique_sessions_and_only_native_threads_fall_back_to_links() {
        use std::collections::{BTreeMap, BTreeSet};
        let context = MarkdownMigration {
            legacy_column: true,
            sessions: BTreeMap::from([
                ("root".into(), BTreeSet::from(["session".into()])),
                ("ambiguous".into(), BTreeSet::from(["a".into(), "b".into()])),
            ]),
            native_titles: BTreeMap::from([
                ("native /id".into(), "Known chat".into()),
                ("ambiguous".into(), "Must stay ambiguous".into()),
            ]),
        };
        let mut content = json!([{"type":"threadMention","props":{"uuid":"root"}},{"type":"threadMention","props":{"uuid":"native /id"}},{"type":"threadMention","props":{"uuid":"ambiguous"}},{"type":"threadMention","props":{"uuid":"unknown-runtime"}}]);
        assert!(context.transform_inline(&mut content));
        assert_eq!(content[0]["props"]["uuid"], "session");
        assert_eq!(content[1]["href"], "codex://threads/native%20%2Fid");
        assert_eq!(content[1]["content"][0]["text"], "Known chat");
        assert_eq!(content[2]["props"]["uuid"], "ambiguous");
        assert_eq!(content[3]["type"], "threadMention");
        let mut title = vec![RichTextItem::ThreadMention {
            uuid: "native /id".into(),
        }];
        assert!(context.transform_title(&mut title));
        assert!(
            matches!(&title[0], RichTextItem::Link { href, .. } if href == "codex://threads/native%20%2Fid")
        );
    }
}
