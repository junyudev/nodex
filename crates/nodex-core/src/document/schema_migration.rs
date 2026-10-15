use chrono::{SecondsFormat, TimeZone, Utc};
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use yrs::updates::encoder::Encode;
use yrs::{ReadTxn, StateVector, Transact};

use crate::domain::block_children::normalize_block_children_forest;
use crate::domain::block_materialization::{
    MaterializedBlockNode, dematerialize_block_tree,
    dematerialize_block_tree_allowing_illegal_children, materialize_block_tree,
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

const BASELINE_PAGE_SCHEMA_VERSION: i64 = 2;
const BASELINE_SYNCED_BLOCK_SCHEMA_VERSION: i64 = 1;
const BASELINE_REUSABLE_TEMPLATE_SCHEMA_VERSION: i64 = 1;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BlockChildrenMigrationEvidence {
    pub(crate) scanned_documents: usize,
    pub(crate) changed_documents: usize,
    pub(crate) scanned_versions: usize,
    pub(crate) changed_versions: usize,
    pub(crate) lifted_roots: usize,
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
    changed: bool,
    lifted_roots: usize,
}

#[derive(Debug)]
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
}

struct PreparedMigration {
    documents: Vec<PreparedDocument>,
    versions: Vec<PreparedVersion>,
    evidence: BlockChildrenMigrationEvidence,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BlockTreeSnapshotV2 {
    format_version: u32,
    kind: BlockDocumentKind,
    block_tree: Vec<MaterializedBlockNode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    rich_title: Option<Vec<RichTextItem>>,
}

pub(crate) fn validate_block_children_migration_source(
    connection: &Connection,
) -> Result<BlockChildrenMigrationEvidence, StoreError> {
    Ok(prepare_migration(connection)?.evidence)
}

pub(crate) fn migrate_block_children_contract(
    connection: &Connection,
    completed_at_unix_ms: i64,
) -> Result<BlockChildrenMigrationEvidence, StoreError> {
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
    Ok(prepared.evidence)
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
    let repository = DocumentReadRepository::new(connection);
    let mut documents = Vec::new();
    let mut evidence = BlockChildrenMigrationEvidence::default();
    for head in repository.live_yjs_heads()? {
        let prepared = prepare_document(&repository, head)?;
        evidence.scanned_documents += 1;
        evidence.changed_documents += usize::from(prepared.changed);
        evidence.lifted_roots += prepared.lifted_roots;
        documents.push(prepared);
    }

    let mut versions = Vec::new();
    for row in read_version_rows(connection)? {
        let prepared = prepare_version(row)?;
        evidence.scanned_versions += 1;
        evidence.changed_versions += usize::from(prepared.changed);
        evidence.lifted_roots += prepared.lifted_roots;
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
) -> Result<PreparedDocument, StoreError> {
    let target_schema = exact_baseline_schema(&head.schema_key, head.schema_version)?;
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
    let decoded = decode_block_document_allowing_illegal_children(engine.document(), target_schema)
        .map_err(|error| corrupt(format!("Document {} baseline schema: {error}", head.id)))?;
    let normalized = normalize_block_children_forest(decoded.block_tree.blocks);
    let normalized_document = DecodedBlockDocument {
        document_id: decoded.document_id,
        schema: target_schema,
        title: decoded.title,
        block_tree: crate::domain::block_tree::BlockTree {
            root_attributes: decoded.block_tree.root_attributes,
            blocks: normalized.blocks,
        },
    };
    let current_materialization =
        materialize_decoded_document(&normalized_document).map_err(|error| {
            corrupt(format!(
                "Document {} current materialization: {error}",
                head.id
            ))
        })?;
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
        changed: normalized.changed,
        lifted_roots: normalized.lifted_roots,
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

fn prepare_version(row: VersionRow) -> Result<PreparedVersion, StoreError> {
    let target_schema = exact_baseline_schema(&row.schema_key, row.schema_version)?;
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
    let (checkpoint, state_vector, changed, lifted_roots) = match row.checkpoint_format.as_str() {
        "yjs_update_v1" => prepare_yjs_version(&row, target_schema)?,
        "block_tree_snapshot_v2" => prepare_block_tree_version(&row, target_schema)?,
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
    })
}

fn prepare_yjs_version(
    row: &VersionRow,
    target_schema: BlockDocumentSchema,
) -> Result<(Vec<u8>, Vec<u8>, bool, usize), StoreError> {
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
    let decoded = decode_block_document_allowing_illegal_children(engine.document(), target_schema)
        .map_err(|error| corrupt(format!("Document version {}: {error}", row.version_id)))?;
    let normalized = normalize_block_children_forest(decoded.block_tree.blocks);
    if !normalized.changed {
        return Ok((
            row.full_update_blob.clone(),
            row.state_vector.clone(),
            false,
            0,
        ));
    }
    let normalized_document = DecodedBlockDocument {
        document_id: decoded.document_id,
        schema: target_schema,
        title: decoded.title,
        block_tree: crate::domain::block_tree::BlockTree {
            root_attributes: decoded.block_tree.root_attributes,
            blocks: normalized.blocks,
        },
    };
    let (checkpoint, state_vector) = encode_current_document(&normalized_document)?;
    Ok((checkpoint, state_vector, true, normalized.lifted_roots))
}

fn prepare_block_tree_version(
    row: &VersionRow,
    target_schema: BlockDocumentSchema,
) -> Result<(Vec<u8>, Vec<u8>, bool, usize), StoreError> {
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
    let mut snapshot = serde_json::from_value::<BlockTreeSnapshotV2>(value)
        .map_err(|_| corrupt("BlockTree Document checkpoint payload is invalid"))?;
    if snapshot.format_version != 2 || snapshot.kind != schema_metadata(target_schema).kind {
        return Err(corrupt(
            "BlockTree Document checkpoint schema identity diverges",
        ));
    }
    if target_schema.has_title() != snapshot.rich_title.is_some() {
        return Err(corrupt(
            "BlockTree Document checkpoint title capability diverges",
        ));
    }
    let tree = dematerialize_block_tree_allowing_illegal_children(&snapshot.block_tree)
        .map_err(|error| corrupt(format!("BlockTree Document checkpoint: {error}")))?;
    let normalized = normalize_block_children_forest(tree.blocks);
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
    materialize_decoded_document(&DecodedBlockDocument {
        document_id: row.document_id.clone(),
        schema: target_schema,
        title,
        block_tree: normalized_tree.clone(),
    })
    .map_err(|error| corrupt(format!("BlockTree Document checkpoint: {error}")))?;
    if !normalized.changed {
        return Ok((row.full_update_blob.clone(), Vec::new(), false, 0));
    }
    snapshot.block_tree = materialize_block_tree(&normalized_tree)
        .map_err(|error| corrupt(format!("BlockTree Document checkpoint: {error}")))?;
    let checkpoint = canonical_json_bytes(
        serde_json::to_value(snapshot)
            .map_err(|_| internal("BlockTree Document checkpoint could not be encoded"))?,
    )?;
    Ok((checkpoint, Vec::new(), true, normalized.lifted_roots))
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
            timestamp,
        ],
    )?;
    persist_materialization_for_schema_migration(
        connection,
        &prepared.head.id,
        prepared.head.generation,
        prepared.head.head_seq,
        &prepared.materialization,
        timestamp,
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
        timestamp,
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

fn exact_baseline_schema(
    schema_key: &str,
    schema_version: i64,
) -> Result<BlockDocumentSchema, StoreError> {
    match (schema_key, schema_version) {
        ("nodex.page", BASELINE_PAGE_SCHEMA_VERSION) => Ok(BlockDocumentSchema::PageV3),
        ("nodex.synced-block", BASELINE_SYNCED_BLOCK_SCHEMA_VERSION) => {
            Ok(BlockDocumentSchema::SyncedBlockV2)
        }
        ("nodex.reusable-template", BASELINE_REUSABLE_TEMPLATE_SCHEMA_VERSION) => {
            Ok(BlockDocumentSchema::ReusableTemplateV2)
        }
        _ => Err(corrupt(format!(
            "Yjs Document schema {schema_key}@{schema_version} is not the exact v134 baseline"
        ))),
    }
}

fn verify_hash(bytes: &[u8], expected: &str, label: &str) -> Result<(), StoreError> {
    if hash_bytes(bytes) == expected {
        return Ok(());
    }
    Err(corrupt(format!("{label} hash diverges")))
}

fn hash_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
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
            content: Some(json!([])),
            children,
        }
    }

    fn baseline_version(block_tree: Vec<MaterializedBlockNode>) -> VersionRow {
        let checkpoint = canonical_json_bytes(
            serde_json::to_value(BlockTreeSnapshotV2 {
                format_version: 2,
                kind: BlockDocumentKind::Page,
                block_tree,
                rich_title: Some(Vec::new()),
            })
            .expect("snapshot"),
        )
        .expect("canonical snapshot");
        VersionRow {
            version_id: "version-1".to_owned(),
            document_id: "document-1".to_owned(),
            project_id: "project-1".to_owned(),
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
        let snapshot = serde_json::from_slice::<BlockTreeSnapshotV2>(&prepared.checkpoint)
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
    fn exact_baseline_reader_rejects_old_schema_and_unknown_vocabulary() {
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

    #[test]
    fn migrates_a_retained_deleted_head_and_rebuilds_its_current_projection() {
        const NOW: &str = "2026-08-25T00:00:00.000Z";
        let document = create_compatible_document("document-1");
        document.get_or_insert_text("title");
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
            code.insert(&mut transaction, 0, XmlElementPrelim::empty("codeBlock"));
            let children = code.insert(&mut transaction, 1, XmlElementPrelim::empty("blockGroup"));
            let paragraph = children.insert(
                &mut transaction,
                0,
                XmlElementPrelim::empty("blockContainer"),
            );
            paragraph.insert_attribute(&mut transaction, "id", "paragraph");
            paragraph.insert(&mut transaction, 0, XmlElementPrelim::empty("paragraph"));
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
            ("code", "codeBlock"),
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
            "codeBlock",
            vec![block("paragraph", "paragraph", Vec::new())],
        )])
        .expect("baseline tree");
        connection
            .execute(
                "INSERT INTO document_materializations( \
                   document_id, generation, projected_seq, schema_version, nfm, plain_text, \
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

        let evidence = migrate_block_children_contract(&connection, 1_777_000_000_000)
            .expect("Block children migration");
        DocumentReadRepository::new(&connection)
            .materialization("document-1")
            .expect("canonical migrated materialization")
            .expect("migrated materialization");

        assert_eq!(
            evidence,
            BlockChildrenMigrationEvidence {
                scanned_documents: 1,
                changed_documents: 1,
                scanned_versions: 0,
                changed_versions: 0,
                lifted_roots: 1,
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
        assert_eq!(versions, (3, 3, 3));
        assert_eq!(
            connection
                .query_row(
                    "SELECT document_schema_version FROM page_read_model \
                     WHERE page_block_id = 'page-owner'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .expect("migrated Page projection"),
            3
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
            (3, "{\"status\":\"ship\"}".to_owned())
        );
    }
}
