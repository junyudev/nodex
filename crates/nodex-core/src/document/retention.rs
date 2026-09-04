use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use std::time::{Duration, Instant};

use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde_json::Value;

use crate::domain::derived_records::BlockDocumentReference;
use crate::infrastructure::document_repository::{
    DocumentAuthority, DocumentReadiness, DocumentSyncEngine,
};
use crate::infrastructure::request_execution::check_request_interruption;
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

use super::canvas_scene::{CANVAS_OWNER_TYPE, CANVAS_SCHEMA_KEY, CANVAS_SCHEMA_VERSION};
use super::history::{
    DocumentVersionRetentionBackfillPlan, apply_document_version_retention_backfill,
    has_unindexed_document_version_retention_work, plan_document_version_retention_backfill,
    prune_document_history,
};
use super::{
    BlockDocumentSchema, CURRENT_DOCUMENT_MATERIALIZATION_DERIVATION_VERSION,
    read_document_authority, schema_metadata,
};

const MAX_CANDIDATES_PER_PASS: usize = 100;
const RETAINED_CANDIDATE_RETRY_MS: i64 = 15 * 60 * 1_000;

const DOCUMENT_BEARING_BLOCK_TYPES: [&str; 4] = [
    "page",
    "synced_block_source",
    "reusable_template_source",
    CANVAS_OWNER_TYPE,
];

const KNOWN_INBOUND_AUTHORITY_TABLES: [&str; 35] = [
    "block_asset_refs",
    "block_documents",
    "block_properties",
    "block_retention_deferrals",
    "block_relocation_members",
    "block_relocations",
    "block_search_units",
    "blocks",
    "canvas_page_references",
    "canvas_scene_elements",
    "canvas_scene_file_refs",
    "canvas_scene_files",
    "canvas_scene_mutation_receipts",
    "canvas_scenes",
    "data_source_page_memberships",
    "data_source_relation_edges",
    "data_source_relation_properties",
    "database_view_page_positions",
    "document_block_index",
    "document_materializations",
    "document_recovery_artifacts",
    "document_snapshots",
    "document_update_receipts",
    "document_updates",
    "document_versions",
    "library_block_placements",
    "page_read_model",
    "page_file_entries",
    "page_file_manifests",
    "pages",
    "recurrence_exceptions",
    "reminder_receipts",
    "reminder_snoozes",
    "scheduled_page_index",
    "structural_cut_claims",
];

#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct BlockRetentionSummary {
    pub(crate) selected_candidates: usize,
    pub(crate) collected_candidates: usize,
    pub(crate) collected_blocks: usize,
    pub(crate) retained_candidates: usize,
    pub(crate) covered_candidates: usize,
    pub(crate) failed_candidates: usize,
}

#[derive(Clone, Debug)]
pub(crate) struct BlockRetentionCandidate {
    pub(crate) library_id: String,
    pub(crate) root_block_id: String,
    dormant_document_id: Option<String>,
}

#[derive(Debug)]
pub(crate) struct BlockRetentionPlan {
    work: BlockRetentionPlanWork,
    commit_head: i64,
}

#[derive(Debug)]
enum BlockRetentionPlanWork {
    IndexDocumentVersion(DocumentVersionRetentionBackfillPlan),
    Collect {
        candidates: Vec<BlockRetentionCandidate>,
        evidence: Arc<RetentionEvidenceIndex>,
    },
}

impl BlockRetentionPlan {
    pub(crate) fn len(&self) -> usize {
        match &self.work {
            BlockRetentionPlanWork::IndexDocumentVersion(_) => 1,
            BlockRetentionPlanWork::Collect { candidates, .. } => candidates.len(),
        }
    }

    pub(crate) fn slice_from(
        &self,
        cursor: usize,
        maximum_candidates: usize,
    ) -> Result<BlockRetentionSlice, StoreError> {
        if maximum_candidates == 0 || cursor > self.len() {
            return Err(internal("Block retention slice cursor is invalid"));
        }
        let work = match &self.work {
            BlockRetentionPlanWork::IndexDocumentVersion(plan) => {
                if cursor != 0 {
                    return Err(internal("Document retention index slice cursor is invalid"));
                }
                BlockRetentionSliceWork::IndexDocumentVersion(plan.clone())
            }
            BlockRetentionPlanWork::Collect {
                candidates,
                evidence,
            } => {
                let end = cursor
                    .saturating_add(maximum_candidates)
                    .min(candidates.len());
                BlockRetentionSliceWork::Collect {
                    candidates: candidates[cursor..end].to_vec(),
                    evidence: Arc::clone(evidence),
                }
            }
        };
        Ok(BlockRetentionSlice {
            work,
            commit_head: self.commit_head,
        })
    }
}

#[derive(Debug)]
pub(crate) struct BlockRetentionSlice {
    work: BlockRetentionSliceWork,
    commit_head: i64,
}

#[derive(Debug)]
enum BlockRetentionSliceWork {
    IndexDocumentVersion(DocumentVersionRetentionBackfillPlan),
    Collect {
        candidates: Vec<BlockRetentionCandidate>,
        evidence: Arc<RetentionEvidenceIndex>,
    },
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct BlockRetentionSliceResult {
    pub(crate) summary: BlockRetentionSummary,
    pub(crate) processed_candidates: usize,
}

#[derive(Debug, Clone)]
struct BlockRow {
    id: String,
    library_id: String,
    block_type: String,
    lifecycle: String,
}

#[derive(Debug)]
struct CandidateClosure {
    root_block_id: String,
    library_id: String,
    block_ids: BTreeSet<String>,
    document_ids: BTreeSet<String>,
    owner_block_ids: BTreeSet<String>,
}

#[derive(Debug)]
struct CandidateAnalysis {
    collectible: bool,
    prunable_recovery_artifact_ids: Vec<String>,
}

#[derive(Debug)]
enum CurrentDocumentEvidence {
    Available {
        document_id: String,
        referenced_block_ids: BTreeSet<String>,
        database_view_ids: BTreeSet<String>,
    },
    Unavailable {
        document_id: String,
    },
}

#[derive(Debug)]
struct ImmutableRetentionEvidence {
    library_id: String,
    block_ids: BTreeSet<String>,
    document_ids: BTreeSet<String>,
    database_block_ids: BTreeSet<String>,
}

#[derive(Debug)]
struct RelocationRetentionEvidence {
    library_id: String,
    source_document_id: String,
    target_document_id: Option<String>,
    target_parent_block_id: Option<String>,
    target_before_block_id: Option<String>,
    member_block_id: Option<String>,
}

#[derive(Debug)]
struct RecoveryRetentionEvidence {
    id: String,
    library_id: String,
    document_id: String,
    status: String,
    touched_block_ids: BTreeSet<String>,
    derived_touched_block_ids: BTreeSet<String>,
}

#[derive(Debug)]
struct StructuralRetentionEvidence {
    library_id: String,
    member_kind: String,
    member_id: String,
}

#[derive(Debug)]
struct UnknownInboundForeignKey {
    table_name: String,
    columns: Vec<ForeignKeyColumn>,
}

impl CurrentDocumentEvidence {
    fn document_id(&self) -> &str {
        match self {
            Self::Available { document_id, .. } | Self::Unavailable { document_id } => document_id,
        }
    }
}

/// Pass-local, fail-closed evidence for physical Block collection.
///
/// Current projections are decoded once and immutable audit evidence is scoped
/// away from the candidate Library when possible. Retained Document versions
/// use their durable identity projection, so candidate analysis never rebuilds
/// every historical checkpoint.
#[derive(Debug, Default)]
struct RetentionEvidenceIndex {
    current_documents: Vec<CurrentDocumentEvidence>,
    immutable_rows: Vec<ImmutableRetentionEvidence>,
    relocations: Vec<RelocationRetentionEvidence>,
    recovery_artifacts: Vec<RecoveryRetentionEvidence>,
    recovery_block_roots: BTreeMap<String, BTreeSet<String>>,
    structural_members: Vec<StructuralRetentionEvidence>,
    unknown_inbound_foreign_keys: Vec<UnknownInboundForeignKey>,
    newest_deleted_blocks: BTreeMap<String, BTreeSet<String>>,
}

impl RetentionEvidenceIndex {
    fn load(
        connection: &Connection,
        candidates: &[BlockRetentionCandidate],
        retain_newest_deleted_blocks: usize,
    ) -> Result<Self, StoreError> {
        let document_ids = connection
            .prepare("SELECT id FROM documents ORDER BY id")?
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut current_documents = Vec::with_capacity(document_ids.len());
        for (index, document_id) in document_ids.into_iter().enumerate() {
            if index % 64 == 0 {
                check_request_interruption()?;
            }
            current_documents.push(load_current_document_evidence(connection, document_id));
        }
        let candidate_libraries = candidates
            .iter()
            .map(|candidate| candidate.library_id.as_str())
            .collect::<BTreeSet<_>>();
        let excluded_library = (candidate_libraries.len() == 1).then(|| {
            *candidate_libraries
                .first()
                .expect("single candidate Library")
        });
        let immutable_rows = load_immutable_retention_evidence(connection, excluded_library)?;
        let relocations = load_relocation_retention_evidence(connection)?;
        let recovery_artifacts = load_recovery_retention_evidence(connection)?;
        let mut recovery_block_roots: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
        let mut statement =
            connection.prepare("SELECT library_id, block_id FROM document_recovery_block_roots")?;
        for row in statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })? {
            let (library_id, block_id) = row?;
            recovery_block_roots
                .entry(library_id)
                .or_default()
                .insert(block_id);
        }
        let structural_members = load_structural_retention_evidence(connection)?;
        let unknown_inbound_foreign_keys = load_unknown_inbound_foreign_keys(connection)?;
        let newest_deleted_blocks = load_newest_deleted_blocks(
            connection,
            &candidate_libraries,
            retain_newest_deleted_blocks,
        )?;
        Ok(Self {
            current_documents,
            immutable_rows,
            relocations,
            recovery_artifacts,
            recovery_block_roots,
            structural_members,
            unknown_inbound_foreign_keys,
            newest_deleted_blocks,
        })
    }

    fn intersects_newest_deleted_blocks(&self, closure: &CandidateClosure) -> bool {
        self.newest_deleted_blocks
            .get(&closure.library_id)
            .is_some_and(|newest| sets_intersect(newest, &closure.block_ids))
    }

    fn has_current_authority_reference(
        &self,
        closure: &CandidateClosure,
        database_view_ids: &BTreeSet<String>,
    ) -> bool {
        self.current_documents.iter().any(|evidence| {
            if closure.document_ids.contains(evidence.document_id()) {
                return false;
            }
            match evidence {
                CurrentDocumentEvidence::Unavailable { .. } => true,
                CurrentDocumentEvidence::Available {
                    referenced_block_ids,
                    database_view_ids: referenced_database_view_ids,
                    ..
                } => {
                    sets_intersect(referenced_block_ids, &closure.block_ids)
                        || sets_intersect(referenced_database_view_ids, database_view_ids)
                }
            }
        })
    }

    fn has_cross_library_immutable_reference(&self, closure: &CandidateClosure) -> bool {
        self.immutable_rows.iter().any(|row| {
            if row.library_id == closure.library_id {
                return false;
            }
            let external_databases = row
                .database_block_ids
                .difference(&closure.block_ids)
                .cloned()
                .collect::<BTreeSet<_>>();
            let authority_blocks = row
                .block_ids
                .difference(&external_databases)
                .cloned()
                .collect::<BTreeSet<_>>();
            sets_intersect(&authority_blocks, &closure.block_ids)
                || sets_intersect(&row.document_ids, &closure.document_ids)
                || sets_intersect(&row.database_block_ids, &closure.block_ids)
        })
    }

    fn has_relocation_reference(&self, closure: &CandidateClosure) -> bool {
        self.relocations.iter().any(|row| {
            row.library_id == closure.library_id
                && (closure.document_ids.contains(&row.source_document_id)
                    || row
                        .target_document_id
                        .as_ref()
                        .is_some_and(|id| closure.document_ids.contains(id))
                    || row
                        .target_parent_block_id
                        .as_ref()
                        .is_some_and(|id| closure.block_ids.contains(id))
                    || row
                        .target_before_block_id
                        .as_ref()
                        .is_some_and(|id| closure.block_ids.contains(id))
                    || row
                        .member_block_id
                        .as_ref()
                        .is_some_and(|id| closure.block_ids.contains(id)))
        })
    }

    fn has_structural_reference(&self, closure: &CandidateClosure) -> bool {
        self.structural_members.iter().any(|member| {
            member.library_id == closure.library_id
                && match member.member_kind.as_str() {
                    "block" | "database" => closure.block_ids.contains(&member.member_id),
                    "document" => closure.document_ids.contains(&member.member_id),
                    "asset" => false,
                    _ => true,
                }
        })
    }

    fn read_prunable_recovery_artifacts(
        &self,
        closure: &CandidateClosure,
        ignored_artifact_ids: &BTreeSet<String>,
    ) -> Option<Vec<String>> {
        let mut prunable = Vec::new();
        for artifact in &self.recovery_artifacts {
            if ignored_artifact_ids.contains(&artifact.id) {
                continue;
            }
            let relevant = closure.document_ids.contains(&artifact.document_id)
                || sets_intersect(&artifact.touched_block_ids, &closure.block_ids)
                || sets_intersect(&artifact.derived_touched_block_ids, &closure.block_ids);
            if !relevant {
                continue;
            }
            if artifact.library_id != closure.library_id
                || artifact.status == "pending"
                || !matches!(artifact.status.as_str(), "resolved" | "discarded")
                || !closure.document_ids.contains(&artifact.document_id)
                || !artifact.touched_block_ids.is_subset(&closure.block_ids)
                || !artifact
                    .derived_touched_block_ids
                    .is_subset(&closure.block_ids)
            {
                return None;
            }
            prunable.push(artifact.id.clone());
        }
        Some(prunable)
    }

    fn has_unknown_inbound_reference(
        &self,
        connection: &Connection,
        closure: &CandidateClosure,
    ) -> Result<bool, StoreError> {
        for foreign_key in &self.unknown_inbound_foreign_keys {
            if unknown_foreign_key_matches(
                connection,
                &foreign_key.table_name,
                &foreign_key.columns,
                closure,
            )? {
                return Ok(true);
            }
        }
        Ok(false)
    }
}

fn load_current_document_evidence(
    connection: &Connection,
    document_id: String,
) -> CurrentDocumentEvidence {
    let unavailable = || CurrentDocumentEvidence::Unavailable {
        document_id: document_id.clone(),
    };
    let Ok(Some(authority)) = read_document_authority(connection, &document_id) else {
        return unavailable();
    };
    if authority.head.readiness != DocumentReadiness::Ready
        || authority.head.authority != DocumentAuthority::YdocPrimary
    {
        return unavailable();
    }
    match authority.head.sync_engine {
        DocumentSyncEngine::Yjs => {
            let Some(schema) = BlockDocumentSchema::from_identity(
                &authority.head.schema_key,
                authority.head.schema_version,
            ) else {
                return unavailable();
            };
            if schema_metadata(schema).owner_type != authority.owner_type {
                return unavailable();
            }
            let materialization = connection
                .query_row(
                    "SELECT references_json FROM document_materializations \
                     WHERE document_id = ?1 AND generation = ?2 AND projected_seq = ?3 \
                       AND schema_version = ?4 AND materialization_derivation_version = ?5",
                    params![
                        document_id,
                        authority.head.generation,
                        authority.head.head_seq,
                        authority.head.schema_version,
                        CURRENT_DOCUMENT_MATERIALIZATION_DERIVATION_VERSION,
                    ],
                    |row| row.get::<_, String>(0),
                )
                .optional();
            let Ok(Some(references_json)) = materialization else {
                return unavailable();
            };
            let Ok(references) =
                serde_json::from_str::<Vec<BlockDocumentReference>>(&references_json)
            else {
                return unavailable();
            };
            let mut referenced_block_ids = BTreeSet::new();
            let mut database_view_ids = BTreeSet::new();
            for reference in references {
                if let Some(block_id) = reference.target_block_id() {
                    referenced_block_ids.insert(block_id.to_owned());
                }
                if let Some(view_id) = reference.database_view_id() {
                    database_view_ids.insert(view_id.to_owned());
                }
            }
            CurrentDocumentEvidence::Available {
                document_id,
                referenced_block_ids,
                database_view_ids,
            }
        }
        DocumentSyncEngine::CanvasScene => {
            if authority.owner_type != CANVAS_OWNER_TYPE
                || authority.head.schema_key != CANVAS_SCHEMA_KEY
                || authority.head.schema_version != CANVAS_SCHEMA_VERSION
            {
                return unavailable();
            }
            let exact_scene = connection.query_row(
                "SELECT count(*) FROM canvas_scenes \
                 WHERE document_id = ?1 AND generation = ?2 AND head_seq = ?3 \
                   AND schema_version = ?4",
                params![
                    document_id,
                    authority.head.generation,
                    authority.head.head_seq,
                    authority.head.schema_version,
                ],
                |row| row.get::<_, i64>(0),
            );
            if !matches!(exact_scene, Ok(1)) {
                return unavailable();
            }
            let references = connection
                .prepare(
                    "SELECT target_block_id FROM canvas_page_references \
                     WHERE document_id = ?1 AND document_generation = ?2 \
                       AND projected_seq = ?3 ORDER BY source_element_id",
                )
                .and_then(|mut statement| {
                    statement
                        .query_map(
                            params![
                                document_id,
                                authority.head.generation,
                                authority.head.head_seq,
                            ],
                            |row| row.get::<_, String>(0),
                        )?
                        .collect::<rusqlite::Result<BTreeSet<_>>>()
                });
            let Ok(referenced_block_ids) = references else {
                return unavailable();
            };
            CurrentDocumentEvidence::Available {
                document_id,
                referenced_block_ids,
                database_view_ids: BTreeSet::new(),
            }
        }
    }
}

fn load_immutable_retention_evidence(
    connection: &Connection,
    excluded_library: Option<&str>,
) -> Result<Vec<ImmutableRetentionEvidence>, StoreError> {
    let rows = connection
        .prepare(
            "SELECT project.library_id, mutation.target_block_ids_json, \
                    mutation.affected_document_ids_json, \
                    mutation.affected_database_block_ids_json \
             FROM projects project \
             CROSS JOIN block_mutations mutation INDEXED BY idx_block_mutations_project_recorded \
               ON mutation.project_id = project.id \
             WHERE (?1 IS NULL OR project.library_id <> ?1) \
               AND (json_array_length(mutation.target_block_ids_json) > 0 \
                 OR json_array_length(mutation.affected_document_ids_json) > 0 \
                 OR json_array_length(mutation.affected_database_block_ids_json) > 0) \
             UNION ALL \
             SELECT project.library_id, change.block_ids_json, change.document_ids_json, \
                    change.database_block_ids_json \
             FROM projects project \
             CROSS JOIN change_log change INDEXED BY idx_change_log_project_seq \
               ON change.project_id = project.id \
             WHERE (?1 IS NULL OR project.library_id <> ?1) \
               AND (json_array_length(change.block_ids_json) > 0 \
                 OR json_array_length(change.document_ids_json) > 0 \
                 OR json_array_length(change.database_block_ids_json) > 0)",
        )?
        .query_map([excluded_library], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter()
        .enumerate()
        .map(|(index, (library_id, blocks, documents, databases))| {
            if index % 64 == 0 {
                check_request_interruption()?;
            }
            Ok(ImmutableRetentionEvidence {
                library_id,
                block_ids: read_identity_set(&blocks)?,
                document_ids: read_identity_set(&documents)?,
                database_block_ids: read_identity_set(&databases)?,
            })
        })
        .collect()
}

fn load_newest_deleted_blocks(
    connection: &Connection,
    libraries: &BTreeSet<&str>,
    retain_newest_deleted_blocks: usize,
) -> Result<BTreeMap<String, BTreeSet<String>>, StoreError> {
    let limit = i64::try_from(retain_newest_deleted_blocks)
        .map_err(|_| invalid("Block retention count exceeds SQLite bounds"))?;
    let mut by_library = BTreeMap::new();
    for library_id in libraries {
        let newest = if limit == 0 {
            BTreeSet::new()
        } else {
            connection
                .prepare(
                    "SELECT id FROM blocks INDEXED BY idx_blocks_library_lifecycle_updated \
                     WHERE library_id = ?1 AND lifecycle = 'deleted' \
                     ORDER BY updated_at DESC, id DESC LIMIT ?2",
                )?
                .query_map(params![library_id, limit], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<BTreeSet<_>>>()?
        };
        by_library.insert((*library_id).to_owned(), newest);
    }
    Ok(by_library)
}

fn load_relocation_retention_evidence(
    connection: &Connection,
) -> Result<Vec<RelocationRetentionEvidence>, StoreError> {
    let mut statement = connection.prepare(
        "SELECT relocation.library_id, relocation.source_document_id, \
                    relocation.target_document_id, relocation.target_parent_block_id, \
                    relocation.target_before_block_id, member.block_id \
             FROM block_relocations relocation \
             LEFT JOIN block_relocation_members member ON member.relocation_id = relocation.id \
             ORDER BY relocation.library_id, relocation.id, member.block_id",
    )?;
    let mut query = statement.query([])?;
    let mut rows = Vec::new();
    while let Some(row) = query.next()? {
        if rows.len() % 64 == 0 {
            check_request_interruption()?;
        }
        rows.push(RelocationRetentionEvidence {
            library_id: row.get(0)?,
            source_document_id: row.get(1)?,
            target_document_id: row.get(2)?,
            target_parent_block_id: row.get(3)?,
            target_before_block_id: row.get(4)?,
            member_block_id: row.get(5)?,
        });
    }
    Ok(rows)
}

fn load_recovery_retention_evidence(
    connection: &Connection,
) -> Result<Vec<RecoveryRetentionEvidence>, StoreError> {
    let rows = connection
        .prepare(
            "SELECT artifact.id, project.library_id, artifact.document_id, artifact.status, \
                    artifact.touched_block_ids_json, artifact.derived_touched_block_ids_json \
             FROM document_recovery_artifacts artifact \
             JOIN projects project ON project.id = artifact.project_id \
             ORDER BY project.library_id, artifact.id",
        )?
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, Option<String>>(5)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter()
        .enumerate()
        .map(
            |(index, (id, library_id, document_id, status, touched, derived))| {
                if index % 64 == 0 {
                    check_request_interruption()?;
                }
                Ok(RecoveryRetentionEvidence {
                    id,
                    library_id,
                    document_id,
                    status,
                    touched_block_ids: read_identity_set(&touched)?,
                    derived_touched_block_ids: derived
                        .as_deref()
                        .map(read_identity_set)
                        .transpose()?
                        .unwrap_or_default(),
                })
            },
        )
        .collect()
}

fn load_structural_retention_evidence(
    connection: &Connection,
) -> Result<Vec<StructuralRetentionEvidence>, StoreError> {
    connection
        .prepare(
            "SELECT member.library_id, member.member_kind, member.member_id \
             FROM structural_retention_members member \
             WHERE (member.authority_kind = 'clipboard_bundle' AND EXISTS ( \
                      SELECT 1 FROM structural_clipboard_leases lease \
                      WHERE lease.bundle_id = member.authority_id AND lease.state = 'active')) \
                OR (member.authority_kind = 'history_recipe' AND EXISTS ( \
                      SELECT 1 FROM structural_history_recipes recipe \
                      WHERE recipe.recipe_operation_id = member.authority_id \
                        AND recipe.state = 'available')) \
             ORDER BY member.library_id, member.member_kind, member.member_id",
        )?
        .query_map([], |row| {
            Ok(StructuralRetentionEvidence {
                library_id: row.get(0)?,
                member_kind: row.get(1)?,
                member_id: row.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(StoreError::from)
}

fn load_unknown_inbound_foreign_keys(
    connection: &Connection,
) -> Result<Vec<UnknownInboundForeignKey>, StoreError> {
    let table_names = connection
        .prepare(
            "SELECT name FROM sqlite_master \
             WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )?
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut result = Vec::new();
    for (index, table_name) in table_names.into_iter().enumerate() {
        if index % 32 == 0 {
            check_request_interruption()?;
        }
        if KNOWN_INBOUND_AUTHORITY_TABLES.contains(&table_name.as_str()) {
            continue;
        }
        let pragma = format!("PRAGMA foreign_key_list({})", quote_identifier(&table_name));
        let foreign_keys = connection
            .prepare(&pragma)?
            .query_map([], |row| {
                Ok(ForeignKeyColumn {
                    id: row.get(0)?,
                    referenced_table: row.get(2)?,
                    from_column: row.get(3)?,
                    to_column: row.get(4)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut groups = BTreeMap::<i64, Vec<ForeignKeyColumn>>::new();
        for foreign_key in foreign_keys {
            if matches!(
                foreign_key.referenced_table.as_str(),
                "blocks" | "documents" | "block_documents"
            ) {
                groups.entry(foreign_key.id).or_default().push(foreign_key);
            }
        }
        result.extend(
            groups
                .into_values()
                .map(|columns| UnknownInboundForeignKey {
                    table_name: table_name.clone(),
                    columns,
                }),
        );
    }
    Ok(result)
}

#[derive(Debug, Clone)]
struct ForeignKeyColumn {
    id: i64,
    referenced_table: String,
    from_column: String,
    to_column: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum CandidateOutcome {
    Collected(BTreeSet<String>),
    Retained,
    Covered,
}

#[cfg(test)]
pub(crate) fn run_block_retention_pass(
    connection: &mut Connection,
    retain_newest_deleted_blocks: usize,
) -> Result<BlockRetentionSummary, StoreError> {
    let plan = plan_block_retention_pass(connection, retain_newest_deleted_blocks)?;
    let slice = plan.slice_from(0, plan.len().max(1))?;
    Ok(run_block_retention_slice_with_target(connection, &slice, None)?.summary)
}

pub(crate) fn plan_block_retention_pass(
    connection: &Connection,
    retain_newest_deleted_blocks: usize,
) -> Result<BlockRetentionPlan, StoreError> {
    // Store open/migration and backup boundaries own whole-Store FK scans;
    // every maintenance write still runs with SQLite FK enforcement enabled.
    // Repeating a global scan here would make Block retention scale with
    // unrelated Operational Journal history before it has found a candidate.
    let commit_head = crate::infrastructure::local_commit::head(connection)?;
    let work = if let Some(backfill) = plan_document_version_retention_backfill(connection)? {
        BlockRetentionPlanWork::IndexDocumentVersion(backfill)
    } else {
        let candidates = read_candidate_roots(connection, retain_newest_deleted_blocks)?;
        let evidence = if candidates.is_empty() {
            Arc::new(RetentionEvidenceIndex::default())
        } else {
            Arc::new(RetentionEvidenceIndex::load(
                connection,
                &candidates,
                retain_newest_deleted_blocks,
            )?)
        };
        BlockRetentionPlanWork::Collect {
            candidates,
            evidence,
        }
    };
    Ok(BlockRetentionPlan { work, commit_head })
}

/// Cheap due-work probe for the scheduler. Candidates that were proven unsafe
/// to collect are durably deferred, allowing the scan to advance instead of
/// continuously re-reading the same oldest tombstones.
pub(crate) fn plan_block_retention_due_work(
    connection: &Connection,
    retain_newest_deleted_blocks: usize,
) -> Result<(bool, Option<i64>), StoreError> {
    if has_unindexed_document_version_retention_work(connection)? {
        return Ok((true, None));
    }
    if !read_candidate_roots(connection, retain_newest_deleted_blocks)?.is_empty() {
        return Ok((true, None));
    }
    let now_ms = sqlite_now_ms(connection)?;
    let next_wake_at_ms = connection.query_row(
        "SELECT min(retry_after_ms) FROM block_retention_deferrals \
         WHERE retry_after_ms > ?1",
        [now_ms],
        |row| row.get::<_, Option<i64>>(0),
    )?;
    Ok((false, next_wake_at_ms))
}

pub(crate) fn block_retention_work_revision(connection: &Connection) -> Result<i64, StoreError> {
    connection
        .query_row(
            "SELECT maintenance_revision FROM block_retention_state WHERE id = 1",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(StoreError::from)
}

pub(crate) fn run_bounded_block_retention_slice(
    connection: &mut Connection,
    slice: &BlockRetentionSlice,
    target_duration: Duration,
) -> Result<BlockRetentionSliceResult, StoreError> {
    run_block_retention_slice_with_target(connection, slice, Some(target_duration))
}

fn run_block_retention_slice_with_target(
    connection: &mut Connection,
    slice: &BlockRetentionSlice,
    target_duration: Option<Duration>,
) -> Result<BlockRetentionSliceResult, StoreError> {
    let current_commit_head = crate::infrastructure::local_commit::head(connection)?;
    if current_commit_head != slice.commit_head {
        return Err(StoreError::new(
            StoreErrorCode::RevisionConflict,
            "Block retention evidence snapshot was superseded by a Store commit",
            true,
        ));
    }
    if let BlockRetentionSliceWork::IndexDocumentVersion(plan) = &slice.work {
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let indexed = apply_document_version_retention_backfill(&transaction, plan)?;
        transaction.commit()?;
        return Ok(BlockRetentionSliceResult {
            summary: BlockRetentionSummary::default(),
            processed_candidates: usize::from(indexed),
        });
    }
    if has_unindexed_document_version_retention_work(connection)? {
        return Err(StoreError::new(
            StoreErrorCode::RevisionConflict,
            "Block retention requires the Document history index to catch up",
            true,
        ));
    }
    let BlockRetentionSliceWork::Collect {
        candidates,
        evidence,
    } = &slice.work
    else {
        unreachable!("Document history indexing returned above")
    };
    let started_at = Instant::now();
    let mut summary = BlockRetentionSummary::default();
    let mut first_failure = None;
    let mut retained_roots = BTreeSet::new();
    for (index, candidate) in candidates.iter().enumerate() {
        if index % 8 == 0 {
            check_request_interruption()?;
        }
        summary.selected_candidates += 1;
        let outcome = if let Some(document_id) = candidate.dormant_document_id.as_deref() {
            maintain_dormant_document_candidate(
                connection,
                evidence,
                &candidate.library_id,
                &candidate.root_block_id,
                document_id,
                slice.commit_head,
            )
        } else {
            maintain_candidate(
                connection,
                evidence,
                &candidate.library_id,
                &candidate.root_block_id,
                slice.commit_head,
            )
        };
        match outcome {
            Ok(CandidateOutcome::Collected(block_ids)) => {
                summary.collected_candidates += 1;
                summary.collected_blocks = summary
                    .collected_blocks
                    .checked_add(block_ids.len())
                    .ok_or_else(|| corrupt("Collected Block count overflowed"))?;
                for block_id in block_ids {
                    if retained_roots.remove(&block_id) {
                        summary.retained_candidates -= 1;
                        summary.covered_candidates += 1;
                    }
                }
            }
            Ok(CandidateOutcome::Retained) => {
                summary.retained_candidates += 1;
                retained_roots.insert(candidate.root_block_id.clone());
            }
            Ok(CandidateOutcome::Covered) => summary.covered_candidates += 1,
            Err(error) => {
                summary.failed_candidates += 1;
                if first_failure.is_none() {
                    first_failure = Some(error);
                }
            }
        }
        if target_duration.is_some_and(|target| started_at.elapsed() >= target) {
            break;
        }
    }
    if let Some(error) = first_failure {
        return Err(error);
    }
    Ok(BlockRetentionSliceResult {
        processed_candidates: summary.selected_candidates,
        summary,
    })
}

fn read_candidate_roots(
    connection: &Connection,
    retain_newest_deleted_blocks: usize,
) -> Result<Vec<BlockRetentionCandidate>, StoreError> {
    let retain_count = i64::try_from(retain_newest_deleted_blocks)
        .map_err(|_| invalid("Block retention count exceeds SQLite bounds"))?;
    let candidate_count = i64::try_from(MAX_CANDIDATES_PER_PASS)
        .map_err(|_| internal("Block retention candidate bound overflowed"))?;
    let mut candidates = connection
        .prepare(
            "WITH ranked_deleted AS ( \
               SELECT id, library_id, updated_at, \
                      row_number() OVER ( \
                        PARTITION BY library_id ORDER BY updated_at DESC, id DESC \
                      ) AS recency_rank \
               FROM blocks INDEXED BY idx_blocks_library_lifecycle_updated \
               WHERE lifecycle = 'deleted' \
             ) \
             SELECT ranked.library_id, ranked.id FROM ranked_deleted ranked \
             WHERE ranked.recency_rank > ?1 \
               AND NOT EXISTS ( \
                 SELECT 1 FROM block_retention_deferrals deferral \
                 WHERE deferral.root_block_id = ranked.id \
                   AND deferral.retry_after_ms > \
                     CAST(unixepoch('subsec') * 1000 AS INTEGER) \
               ) \
             ORDER BY updated_at, library_id, id LIMIT ?2",
        )?
        .query_map(params![retain_count, candidate_count], |row| {
            Ok(BlockRetentionCandidate {
                library_id: row.get(0)?,
                root_block_id: row.get(1)?,
                dormant_document_id: None,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(StoreError::from)?;
    candidates.extend(read_dormant_document_candidates(
        connection,
        candidate_count,
    )?);
    candidates.sort_by(|left, right| {
        left.library_id
            .cmp(&right.library_id)
            .then_with(|| left.root_block_id.cmp(&right.root_block_id))
            .then_with(|| left.dormant_document_id.cmp(&right.dormant_document_id))
    });
    candidates.truncate(
        usize::try_from(candidate_count)
            .map_err(|_| internal("Block retention candidate bound is invalid"))?,
    );
    Ok(candidates)
}

/// A consumed Page-to-ordinary inverse recipe is the durable provenance for
/// an intentionally unowned Page Document. Once no active retention authority
/// names that Document, maintenance may collect its sole placeholder without
/// touching the still-active ordinary Block that inherited the Page identity.
/// Structural recipe actions are compositional, so discovery follows wrapper
/// actions instead of assuming the Page transition is the recipe root.
fn read_dormant_document_candidates(
    connection: &Connection,
    candidate_count: i64,
) -> Result<Vec<BlockRetentionCandidate>, StoreError> {
    connection
        .prepare(
            "WITH RECURSIVE recipe_actions(library_id, action_json) AS ( \
               SELECT library_id, json_extract(recipe_json, '$.action') \
               FROM structural_history_recipes WHERE state <> 'available' \
               UNION ALL \
               SELECT action.library_id, json_extract(action.action_json, '$.action') \
               FROM recipe_actions action \
               WHERE json_extract(action.action_json, '$.kind') = 'with_inline_content' \
             ) \
             SELECT DISTINCT action.library_id, \
                    json_extract(dormant.value, '$.placeholderBlockId'), \
                    json_extract(dormant.value, '$.documentId') \
             FROM recipe_actions action \
             JOIN json_each(action.action_json, '$.state.dormantPages') dormant \
             JOIN documents document \
               ON document.id = json_extract(dormant.value, '$.documentId') \
              AND document.library_id = action.library_id \
             JOIN blocks inherited \
               ON inherited.id = json_extract(dormant.value, '$.pageId') \
              AND inherited.library_id = action.library_id \
              AND inherited.lifecycle = 'active' AND inherited.type <> 'page' \
             JOIN blocks placeholder \
               ON placeholder.id = json_extract(dormant.value, '$.placeholderBlockId') \
              AND placeholder.library_id = action.library_id \
             WHERE json_extract(action.action_json, '$.kind') = 'restore_turned_selection' \
               AND NOT EXISTS ( \
                 SELECT 1 FROM block_retention_deferrals deferral \
                 WHERE deferral.root_block_id = placeholder.id \
                   AND deferral.retry_after_ms > \
                     CAST(unixepoch('subsec') * 1000 AS INTEGER) \
               ) \
               AND NOT EXISTS ( \
                 SELECT 1 FROM block_documents ownership \
                 WHERE ownership.document_id = document.id \
               ) \
               AND NOT EXISTS ( \
                 SELECT 1 FROM structural_retention_members member \
                 WHERE member.library_id = action.library_id \
                   AND member.member_kind = 'document' AND member.member_id = document.id \
               ) \
             ORDER BY action.library_id, document.id LIMIT ?1",
        )?
        .query_map([candidate_count], |row| {
            Ok(BlockRetentionCandidate {
                library_id: row.get(0)?,
                root_block_id: row.get(1)?,
                dormant_document_id: Some(row.get(2)?),
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(StoreError::from)
}

fn maintain_dormant_document_candidate(
    connection: &mut Connection,
    evidence: &RetentionEvidenceIndex,
    library_id: &str,
    placeholder_block_id: &str,
    document_id: &str,
    commit_head: i64,
) -> Result<CandidateOutcome, StoreError> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let outcome = (|| -> Result<CandidateOutcome, StoreError> {
        let Some(closure) = build_dormant_document_closure(
            &transaction,
            library_id,
            placeholder_block_id,
            document_id,
        )?
        else {
            return Ok(CandidateOutcome::Covered);
        };
        let now = sqlite_now(&transaction)?;
        prune_document_history(&transaction, document_id, &now)?;
        let analysis = analyze_candidate(&transaction, evidence, &closure, &BTreeSet::new())?;
        if !analysis.collectible {
            return Ok(CandidateOutcome::Retained);
        }
        delete_exact_recovery_artifacts(&transaction, &analysis.prunable_recovery_artifact_ids)?;
        let Some(replanned) = build_dormant_document_closure(
            &transaction,
            library_id,
            placeholder_block_id,
            document_id,
        )?
        else {
            return Ok(CandidateOutcome::Covered);
        };
        let deleted_recovery_artifact_ids = analysis
            .prunable_recovery_artifact_ids
            .iter()
            .cloned()
            .collect::<BTreeSet<_>>();
        let post_prune = analyze_candidate(
            &transaction,
            evidence,
            &replanned,
            &deleted_recovery_artifact_ids,
        )?;
        if !post_prune.collectible || !post_prune.prunable_recovery_artifact_ids.is_empty() {
            return Ok(CandidateOutcome::Retained);
        }
        collect_dormant_document_closure(&transaction, &replanned, &now)?;
        Ok(CandidateOutcome::Collected(replanned.block_ids))
    })()?;
    if matches!(outcome, CandidateOutcome::Covered) {
        return Ok(outcome);
    }
    if matches!(outcome, CandidateOutcome::Retained) {
        record_retained_candidate_deferral(&transaction, placeholder_block_id, commit_head)?;
    }
    transaction.commit()?;
    Ok(outcome)
}

fn build_dormant_document_closure(
    connection: &Connection,
    library_id: &str,
    placeholder_block_id: &str,
    document_id: &str,
) -> Result<Option<CandidateClosure>, StoreError> {
    let document = connection
        .query_row(
            "SELECT schema_key, schema_version, readiness, authority, sync_engine \
             FROM documents WHERE id = ?1 AND library_id = ?2 \
               AND NOT EXISTS (SELECT 1 FROM block_documents WHERE document_id = ?1)",
            params![document_id, library_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            },
        )
        .optional()?;
    let Some((schema_key, schema_version, readiness, authority, sync_engine)) = document else {
        return Ok(None);
    };
    if schema_key != "nodex.page"
        || schema_version != 3
        || readiness != "ready"
        || authority != "ydoc_primary"
        || sync_engine != "yjs"
    {
        return Ok(None);
    }
    let indexed = connection
        .prepare(
            "SELECT entry.block_id, entry.parent_block_id, block.type, block.lifecycle \
             FROM document_block_index entry JOIN blocks block ON block.id = entry.block_id \
             WHERE entry.document_id = ?1 AND block.library_id = ?2 ORDER BY entry.block_id",
        )?
        .query_map(params![document_id, library_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let [(block_id, parent_block_id, block_type, lifecycle)] = indexed.as_slice() else {
        return Ok(None);
    };
    if block_id != placeholder_block_id
        || parent_block_id.is_some()
        || block_type != "paragraph"
        || lifecycle != "active"
    {
        return Ok(None);
    }
    Ok(Some(CandidateClosure {
        root_block_id: placeholder_block_id.to_owned(),
        library_id: library_id.to_owned(),
        block_ids: BTreeSet::from([placeholder_block_id.to_owned()]),
        document_ids: BTreeSet::from([document_id.to_owned()]),
        owner_block_ids: BTreeSet::new(),
    }))
}

fn collect_dormant_document_closure(
    connection: &Connection,
    closure: &CandidateClosure,
    retired_at: &str,
) -> Result<(), StoreError> {
    let mut document_ids = closure.document_ids.iter();
    let Some(document_id) = document_ids.next() else {
        return Err(corrupt("Dormant Document closure is not exact"));
    };
    if document_ids.next().is_some() {
        return Err(corrupt("Dormant Document closure is not exact"));
    }
    let mut block_ids = closure.block_ids.iter();
    let Some(block_id) = block_ids.next() else {
        return Err(corrupt("Dormant Document placeholder closure is not exact"));
    };
    if block_ids.next().is_some() {
        return Err(corrupt("Dormant Document placeholder closure is not exact"));
    }
    let changed = connection.execute(
        "UPDATE blocks SET lifecycle = 'deleted', metadata_revision = metadata_revision + 1, \
           updated_at = ?1 WHERE id = ?2 AND library_id = ?3 AND lifecycle = 'active'",
        params![retired_at, block_id, closure.library_id],
    )?;
    if changed != 1 {
        return Err(conflict(
            "Dormant Document placeholder changed before collection",
        ));
    }
    connection.execute(
        "INSERT INTO retired_block_identities( \
           block_id, library_id, block_type, retention_root_block_id, retired_at \
         ) SELECT id, library_id, type, id, ?1 FROM blocks \
           WHERE id = ?2 AND library_id = ?3 AND lifecycle = 'deleted'",
        params![retired_at, block_id, closure.library_id],
    )?;
    let deleted_document = connection.execute(
        "DELETE FROM documents WHERE id = ?1 AND library_id = ?2 \
           AND NOT EXISTS (SELECT 1 FROM block_documents WHERE document_id = ?1)",
        params![document_id, closure.library_id],
    )?;
    if deleted_document != 1 {
        return Err(conflict("Dormant Document changed before collection"));
    }
    let deleted_block = connection.execute(
        "DELETE FROM blocks WHERE id = ?1 AND library_id = ?2 AND lifecycle = 'deleted'",
        params![block_id, closure.library_id],
    )?;
    if deleted_block != 1 {
        return Err(conflict(
            "Dormant Document placeholder changed before collection",
        ));
    }
    Ok(())
}

fn maintain_candidate(
    connection: &mut Connection,
    evidence: &RetentionEvidenceIndex,
    library_id: &str,
    root_block_id: &str,
    commit_head: i64,
) -> Result<CandidateOutcome, StoreError> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let outcome = (|| -> Result<CandidateOutcome, StoreError> {
        let Some(root) = read_block(&transaction, root_block_id)? else {
            return Ok(CandidateOutcome::Covered);
        };
        if root.library_id != library_id || root.lifecycle != "deleted" {
            return Ok(CandidateOutcome::Covered);
        }
        let Some(closure) = build_candidate_closure(&transaction, library_id, root_block_id)?
        else {
            return Ok(CandidateOutcome::Retained);
        };
        if evidence.intersects_newest_deleted_blocks(&closure) {
            return Ok(CandidateOutcome::Retained);
        }
        let now = sqlite_now(&transaction)?;
        for document_id in &closure.document_ids {
            prune_document_history(&transaction, document_id, &now)?;
        }
        let analysis = analyze_candidate(&transaction, evidence, &closure, &BTreeSet::new())?;
        if !analysis.collectible {
            return Ok(CandidateOutcome::Retained);
        }
        delete_exact_recovery_artifacts(&transaction, &analysis.prunable_recovery_artifact_ids)?;
        let Some(replanned) = build_candidate_closure(&transaction, library_id, root_block_id)?
        else {
            return Ok(CandidateOutcome::Retained);
        };
        let deleted_recovery_artifact_ids = analysis
            .prunable_recovery_artifact_ids
            .iter()
            .cloned()
            .collect::<BTreeSet<_>>();
        let post_prune = analyze_candidate(
            &transaction,
            evidence,
            &replanned,
            &deleted_recovery_artifact_ids,
        )?;
        if !post_prune.collectible || !post_prune.prunable_recovery_artifact_ids.is_empty() {
            return Ok(CandidateOutcome::Retained);
        }
        let collected = collect_candidate_closure(&transaction, &replanned, &now)?;
        Ok(CandidateOutcome::Collected(collected))
    })()?;
    if matches!(outcome, CandidateOutcome::Covered) {
        return Ok(outcome);
    }
    if matches!(outcome, CandidateOutcome::Retained) {
        record_retained_candidate_deferral(&transaction, root_block_id, commit_head)?;
    }
    transaction.commit()?;
    Ok(outcome)
}

fn record_retained_candidate_deferral(
    connection: &Connection,
    root_block_id: &str,
    commit_head: i64,
) -> Result<(), StoreError> {
    let now_ms = sqlite_now_ms(connection)?;
    let retry_after_ms = now_ms
        .checked_add(RETAINED_CANDIDATE_RETRY_MS)
        .ok_or_else(|| corrupt("Block retention retry time overflowed"))?;
    connection.execute(
        "INSERT INTO block_retention_deferrals( \
           root_block_id, evaluated_commit_seq, retry_after_ms \
         ) VALUES (?1, ?2, ?3) \
         ON CONFLICT(root_block_id) DO UPDATE SET \
           evaluated_commit_seq = excluded.evaluated_commit_seq, \
           retry_after_ms = excluded.retry_after_ms",
        params![root_block_id, commit_head, retry_after_ms],
    )?;
    let changed = connection.execute(
        "UPDATE block_retention_state SET \
           maintenance_revision = maintenance_revision + 1, updated_at_ms = ?1 \
         WHERE id = 1 AND maintenance_revision < ?2",
        params![now_ms, i64::MAX],
    )?;
    if changed != 1 {
        return Err(corrupt("Block retention state is missing or exhausted"));
    }
    Ok(())
}

fn build_candidate_closure(
    connection: &Connection,
    library_id: &str,
    root_block_id: &str,
) -> Result<Option<CandidateClosure>, StoreError> {
    let Some(root) = read_block(connection, root_block_id)? else {
        return Ok(None);
    };
    if root.library_id != library_id || root.lifecycle != "deleted" {
        return Ok(None);
    }
    let mut closure = CandidateClosure {
        root_block_id: root.id.clone(),
        library_id: library_id.to_owned(),
        block_ids: BTreeSet::from([root.id.clone()]),
        document_ids: BTreeSet::new(),
        owner_block_ids: BTreeSet::new(),
    };
    let mut pending = vec![root];
    while let Some(block) = pending.pop() {
        let ownership = connection
            .query_row(
                "SELECT block_id, document_id, library_id FROM block_documents \
                 WHERE block_id = ?1",
                [&block.id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()?;
        let Some((owner_block_id, document_id, ownership_library_id)) = ownership else {
            if DOCUMENT_BEARING_BLOCK_TYPES.contains(&block.block_type.as_str()) {
                return Ok(None);
            }
            continue;
        };
        if owner_block_id != block.id
            || ownership_library_id != library_id
            || closure.document_ids.contains(&document_id)
        {
            return Ok(None);
        }
        let document = connection
            .query_row(
                "SELECT library_id, schema_key, schema_version, readiness, authority, sync_engine \
                 FROM documents WHERE id = ?1",
                [&document_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                    ))
                },
            )
            .optional()?;
        let Some((
            document_library_id,
            schema_key,
            schema_version,
            readiness,
            authority,
            sync_engine,
        )) = document
        else {
            return Ok(None);
        };
        if document_library_id != library_id
            || readiness != "ready"
            || authority != "ydoc_primary"
            || !registered_owner_schema(
                &block.block_type,
                &schema_key,
                schema_version,
                &sync_engine,
            )
        {
            return Ok(None);
        }
        closure.document_ids.insert(document_id.clone());
        closure.owner_block_ids.insert(block.id.clone());
        let children = connection
            .prepare(
                "SELECT block.id, block.library_id, block.type, block.lifecycle \
                 FROM document_block_index entry \
                 JOIN blocks block ON block.id = entry.block_id \
                 WHERE entry.document_id = ?1 AND block.library_id = ?2 \
                 ORDER BY block.id",
            )?
            .query_map(params![document_id, library_id], decode_block_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for child in children {
            if child.lifecycle != "deleted" {
                return Ok(None);
            }
            if closure.block_ids.insert(child.id.clone()) {
                pending.push(child);
            }
        }
    }
    Ok(Some(closure))
}

fn registered_owner_schema(
    owner_type: &str,
    schema_key: &str,
    schema_version: i64,
    sync_engine: &str,
) -> bool {
    if owner_type == CANVAS_OWNER_TYPE {
        return schema_key == CANVAS_SCHEMA_KEY
            && schema_version == CANVAS_SCHEMA_VERSION
            && sync_engine == "canvas_scene";
    }
    let Some(schema) = BlockDocumentSchema::from_identity(schema_key, schema_version) else {
        return false;
    };
    schema_metadata(schema).owner_type == owner_type && sync_engine == "yjs"
}

fn analyze_candidate(
    connection: &Connection,
    evidence: &RetentionEvidenceIndex,
    closure: &CandidateClosure,
    ignored_recovery_artifact_ids: &BTreeSet<String>,
) -> Result<CandidateAnalysis, StoreError> {
    let block_ids_json = identities_json(&closure.block_ids)?;
    let document_ids_json = identities_json(&closure.document_ids)?;
    let database_view_ids = read_database_view_ids(connection, &block_ids_json)?;
    let database_view_ids_json = identities_json(&database_view_ids)?;
    if evidence
        .recovery_block_roots
        .get(&closure.library_id)
        .is_some_and(|roots| sets_intersect(roots, &closure.block_ids))
        || evidence.has_unknown_inbound_reference(connection, closure)?
        || evidence.has_current_authority_reference(closure, &database_view_ids)
        || has_current_projection_reference(connection, closure)?
        || has_historical_reference(connection, closure, &database_view_ids)?
        || evidence.has_cross_library_immutable_reference(closure)
        || evidence.has_relocation_reference(closure)
        || evidence.has_structural_reference(closure)
        || has_relational_reference(
            connection,
            closure,
            &block_ids_json,
            &document_ids_json,
            &database_view_ids_json,
        )?
        || has_page_behavior_reference(connection, closure, &block_ids_json)?
    {
        return Ok(CandidateAnalysis {
            collectible: false,
            prunable_recovery_artifact_ids: Vec::new(),
        });
    }
    let Some(prunable_recovery_artifact_ids) =
        evidence.read_prunable_recovery_artifacts(closure, ignored_recovery_artifact_ids)
    else {
        return Ok(CandidateAnalysis {
            collectible: false,
            prunable_recovery_artifact_ids: Vec::new(),
        });
    };
    let retained_owned_versions = connection.query_row(
        "SELECT count(*) FROM document_versions \
         WHERE document_id IN (SELECT value FROM json_each(?1))",
        [&document_ids_json],
        |row| row.get::<_, i64>(0),
    )?;
    Ok(CandidateAnalysis {
        collectible: retained_owned_versions == 0,
        prunable_recovery_artifact_ids,
    })
}

fn has_historical_reference(
    connection: &Connection,
    closure: &CandidateClosure,
    database_view_ids: &BTreeSet<String>,
) -> Result<bool, StoreError> {
    let referenced = connection.query_row(
        "SELECT EXISTS( \
           SELECT 1 \
           FROM document_version_retention_members member \
           JOIN document_version_retention_index retention \
             ON retention.version_id = member.version_id \
           JOIN document_versions version ON version.version_id = retention.version_id \
           WHERE version.document_id NOT IN (SELECT value FROM json_each(?1)) \
             AND ( \
               (member.member_kind = 'block' \
                 AND member.member_id IN (SELECT value FROM json_each(?2))) \
               OR (member.member_kind = 'database_view' \
                 AND member.member_id IN (SELECT value FROM json_each(?3))) \
             ) \
           LIMIT 1 \
         )",
        params![
            identities_json(&closure.document_ids)?,
            identities_json(&closure.block_ids)?,
            identities_json(database_view_ids)?,
        ],
        |row| row.get::<_, bool>(0),
    )?;
    Ok(referenced)
}

fn has_current_projection_reference(
    connection: &Connection,
    closure: &CandidateClosure,
) -> Result<bool, StoreError> {
    let block_ids_json = identities_json(&closure.block_ids)?;
    let external_index = connection.query_row(
        "SELECT count(*) FROM document_block_index \
         WHERE block_id IN (SELECT value FROM json_each(?1)) \
           AND document_id NOT IN (SELECT value FROM json_each(?2))",
        params![block_ids_json, identities_json(&closure.document_ids)?],
        |row| row.get::<_, i64>(0),
    )?;
    if external_index != 0 {
        return Ok(true);
    }
    let external_canvas_reference = connection.query_row(
        "SELECT count(*) FROM canvas_page_references \
         WHERE target_block_id IN (SELECT value FROM json_each(?1)) \
           AND document_id NOT IN (SELECT value FROM json_each(?2))",
        params![block_ids_json, identities_json(&closure.document_ids)?],
        |row| row.get::<_, i64>(0),
    )?;
    Ok(external_canvas_reference != 0)
}

fn has_relational_reference(
    connection: &Connection,
    closure: &CandidateClosure,
    block_ids_json: &str,
    document_ids_json: &str,
    database_view_ids_json: &str,
) -> Result<bool, StoreError> {
    let library_roots = connection.query_row(
        "SELECT count(*) FROM library_block_placements \
         WHERE library_id = ?1 AND block_id IN (SELECT value FROM json_each(?2))",
        params![closure.library_id, block_ids_json],
        |row| row.get::<_, i64>(0),
    )?;
    let active_memberships = connection.query_row(
        "SELECT count(*) FROM data_source_page_memberships membership \
         JOIN blocks page ON page.id = membership.page_block_id AND page.library_id = ?1 \
         WHERE membership.removed_at IS NULL \
           AND membership.page_block_id IN (SELECT value FROM json_each(?2))",
        params![closure.library_id, block_ids_json],
        |row| row.get::<_, i64>(0),
    )?;
    let positions = connection.query_row(
        "SELECT count(*) FROM database_view_page_positions position \
         JOIN blocks page ON page.id = position.page_block_id AND page.library_id = ?1 \
         WHERE position.page_block_id IN (SELECT value FROM json_each(?2))",
        params![closure.library_id, block_ids_json],
        |row| row.get::<_, i64>(0),
    )?;
    let external_index = connection.query_row(
        "SELECT count(*) FROM document_block_index \
         WHERE block_id IN (SELECT value FROM json_each(?1)) \
           AND document_id NOT IN (SELECT value FROM json_each(?2))",
        params![block_ids_json, document_ids_json],
        |row| row.get::<_, i64>(0),
    )?;
    let active_database_dependents = connection.query_row(
        "SELECT \
           (SELECT count(*) FROM project_database_bindings binding \
             WHERE binding.database_block_id IN (SELECT value FROM json_each(?1)) \
               AND binding.lifecycle = 'active') + \
           (SELECT count(*) FROM data_sources source \
             JOIN data_source_properties property ON property.data_source_id = source.id \
               AND property.lifecycle = 'active' \
             WHERE source.home_database_block_id IN (SELECT value FROM json_each(?1)) \
               AND source.lifecycle = 'active') + \
           (SELECT count(*) FROM database_views view \
             WHERE view.database_block_id IN (SELECT value FROM json_each(?1)) \
               AND view.lifecycle = 'active') + \
           (SELECT count(*) FROM data_sources source \
             JOIN data_source_page_memberships membership \
               ON membership.data_source_id = source.id AND membership.removed_at IS NULL \
             WHERE source.home_database_block_id IN (SELECT value FROM json_each(?1)))",
        [block_ids_json],
        |row| row.get::<_, i64>(0),
    )?;
    let dangling_view_positions = connection.query_row(
        "SELECT count(*) FROM database_view_page_positions \
         WHERE view_id IN (SELECT value FROM json_each(?1))",
        [database_view_ids_json],
        |row| row.get::<_, i64>(0),
    )?;
    let external_relation_edges = connection.query_row(
        "SELECT count(*) FROM data_source_relation_edges edge \
         JOIN data_source_page_memberships source_membership \
           ON source_membership.data_source_id = edge.source_data_source_id \
           AND source_membership.id = edge.source_membership_id \
         WHERE edge.target_page_block_id IN (SELECT value FROM json_each(?1)) \
           AND source_membership.page_block_id NOT IN (SELECT value FROM json_each(?1))",
        [block_ids_json],
        |row| row.get::<_, i64>(0),
    )?;
    let external_relation_definitions = connection.query_row(
        "SELECT count(*) FROM data_source_relation_properties relation \
         JOIN data_sources target ON target.id = relation.target_data_source_id \
         JOIN data_sources source ON source.id = relation.data_source_id \
         WHERE target.home_database_block_id IN (SELECT value FROM json_each(?1)) \
           AND source.home_database_block_id NOT IN (SELECT value FROM json_each(?1))",
        [block_ids_json],
        |row| row.get::<_, i64>(0),
    )?;
    Ok(library_roots != 0
        || active_memberships != 0
        || positions != 0
        || external_index != 0
        || active_database_dependents != 0
        || dangling_view_positions != 0
        || external_relation_edges != 0
        || external_relation_definitions != 0)
}

fn has_page_behavior_reference(
    connection: &Connection,
    closure: &CandidateClosure,
    block_ids_json: &str,
) -> Result<bool, StoreError> {
    let count = connection.query_row(
        "SELECT \
           (SELECT count(*) FROM recurrence_exceptions \
             WHERE library_id = ?1 AND page_id IN (SELECT value FROM json_each(?2))) + \
           (SELECT count(*) FROM reminder_receipts \
             WHERE library_id = ?1 AND page_id IN (SELECT value FROM json_each(?2))) + \
           (SELECT count(*) FROM reminder_snoozes \
             WHERE library_id = ?1 AND page_id IN (SELECT value FROM json_each(?2)))",
        params![closure.library_id, block_ids_json],
        |row| row.get::<_, i64>(0),
    )?;
    Ok(count != 0)
}

fn delete_exact_recovery_artifacts(
    connection: &Connection,
    artifact_ids: &[String],
) -> Result<(), StoreError> {
    if artifact_ids.is_empty() {
        return Ok(());
    }
    let serialized = serde_json::to_string(artifact_ids)
        .map_err(|_| internal("Recovery artifact identities cannot be encoded"))?;
    let deleted = connection.execute(
        "DELETE FROM document_recovery_artifacts \
         WHERE id IN (SELECT value FROM json_each(?1))",
        [&serialized],
    )?;
    if deleted != artifact_ids.len() {
        return Err(conflict("Recovery evidence changed during Block retention"));
    }
    Ok(())
}

fn collect_candidate_closure(
    connection: &Connection,
    closure: &CandidateClosure,
    retired_at: &str,
) -> Result<BTreeSet<String>, StoreError> {
    for block_id in &closure.block_ids {
        let inserted = connection.execute(
            "INSERT INTO retired_block_identities( \
               block_id, library_id, block_type, retention_root_block_id, retired_at \
             ) \
             SELECT id, library_id, type, ?1, ?2 FROM blocks \
             WHERE id = ?3 AND library_id = ?4 AND lifecycle = 'deleted'",
            params![
                closure.root_block_id,
                retired_at,
                block_id,
                closure.library_id
            ],
        )?;
        if inserted != 1 {
            return Err(conflict("Block closure changed before identity retirement"));
        }
    }
    let block_ids_json = identities_json(&closure.block_ids)?;
    let document_ids_json = identities_json(&closure.document_ids)?;
    connection.execute(
        "DELETE FROM database_view_page_positions \
         WHERE page_block_id IN (SELECT value FROM json_each(?1))",
        [&block_ids_json],
    )?;
    connection.execute(
        "DELETE FROM data_source_page_memberships \
         WHERE page_block_id IN (SELECT value FROM json_each(?1))",
        [&block_ids_json],
    )?;
    connection.execute(
        "DELETE FROM library_block_placements \
         WHERE block_id IN (SELECT value FROM json_each(?1))",
        [&block_ids_json],
    )?;
    // Page relationships cascade from the Page. Remove the candidate's derived
    // occurrences first so same-closure references do not falsely act like
    // external retention roots. External occurrences were rejected by candidate
    // analysis above and therefore remain untouched.
    connection.execute(
        "DELETE FROM block_asset_refs \
         WHERE document_id IN (SELECT value FROM json_each(?1))",
        [&document_ids_json],
    )?;
    connection.execute(
        "DELETE FROM pages WHERE block_id IN (SELECT value FROM json_each(?1))",
        [&block_ids_json],
    )?;
    if !closure.document_ids.is_empty() {
        let deleted_ownerships = connection.execute(
            "DELETE FROM block_documents \
             WHERE library_id = ?1 \
               AND block_id IN (SELECT value FROM json_each(?2)) \
               AND document_id IN (SELECT value FROM json_each(?3))",
            params![closure.library_id, block_ids_json, document_ids_json],
        )?;
        if deleted_ownerships != closure.document_ids.len() {
            return Err(conflict("Block ownership closure changed during retention"));
        }
    }
    let deleted_blocks = connection.execute(
        "DELETE FROM blocks WHERE library_id = ?1 AND lifecycle = 'deleted' \
           AND id IN (SELECT value FROM json_each(?2))",
        params![closure.library_id, block_ids_json],
    )?;
    if deleted_blocks != closure.block_ids.len() {
        return Err(conflict("Block closure changed during retention"));
    }
    if !closure.document_ids.is_empty() {
        let deleted_documents = connection.execute(
            "DELETE FROM documents WHERE library_id = ?1 \
               AND id IN (SELECT value FROM json_each(?2))",
            params![closure.library_id, document_ids_json],
        )?;
        if deleted_documents != closure.document_ids.len() {
            return Err(conflict("Document closure changed during Block retention"));
        }
    }
    Ok(closure.block_ids.clone())
}

fn read_database_view_ids(
    connection: &Connection,
    block_ids_json: &str,
) -> Result<BTreeSet<String>, StoreError> {
    connection
        .prepare(
            "SELECT id FROM database_views \
             WHERE database_block_id IN (SELECT value FROM json_each(?1)) ORDER BY id",
        )?
        .query_map([block_ids_json], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<BTreeSet<_>>>()
        .map_err(StoreError::from)
}

fn unknown_foreign_key_matches(
    connection: &Connection,
    table_name: &str,
    foreign_key: &[ForeignKeyColumn],
    closure: &CandidateClosure,
) -> Result<bool, StoreError> {
    let Some(referenced_table) = foreign_key
        .first()
        .map(|column| column.referenced_table.as_str())
    else {
        return Ok(false);
    };
    let mut predicates = Vec::new();
    let mut bindings = Vec::new();
    let mut recognized_identity_column = false;
    for column in foreign_key {
        let identities = match (referenced_table, column.to_column.as_str()) {
            ("blocks", "id") => &closure.block_ids,
            ("documents", "id") => &closure.document_ids,
            ("block_documents", "block_id") => &closure.owner_block_ids,
            ("block_documents", "document_id") => &closure.document_ids,
            _ => continue,
        };
        recognized_identity_column = true;
        if identities.is_empty() {
            continue;
        }
        predicates.push(format!(
            "{} IN (SELECT value FROM json_each(?{}))",
            quote_identifier(&column.from_column),
            bindings.len() + 1
        ));
        bindings.push(identities_json(identities)?);
    }
    if predicates.is_empty() {
        return Ok(!recognized_identity_column);
    }
    let sql = format!(
        "SELECT count(*) FROM {} WHERE {}",
        quote_identifier(table_name),
        predicates.join(" OR ")
    );
    let count = connection.query_row(&sql, rusqlite::params_from_iter(bindings.iter()), |row| {
        row.get::<_, i64>(0)
    })?;
    Ok(count != 0)
}

fn read_block(connection: &Connection, block_id: &str) -> Result<Option<BlockRow>, StoreError> {
    connection
        .query_row(
            "SELECT id, library_id, type, lifecycle FROM blocks WHERE id = ?1",
            [block_id],
            decode_block_row,
        )
        .optional()
        .map_err(StoreError::from)
}

fn decode_block_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<BlockRow> {
    Ok(BlockRow {
        id: row.get(0)?,
        library_id: row.get(1)?,
        block_type: row.get(2)?,
        lifecycle: row.get(3)?,
    })
}

fn read_identity_set(serialized: &str) -> Result<BTreeSet<String>, StoreError> {
    let identities = serde_json::from_str::<Vec<Value>>(serialized)
        .map_err(|_| corrupt("Retention evidence contains invalid JSON"))?;
    identities
        .into_iter()
        .map(|identity| {
            let identity = identity
                .as_str()
                .filter(|value| !value.is_empty() && value.len() <= 512 && value.trim() == *value)
                .ok_or_else(|| corrupt("Retention evidence contains an invalid identity"))?;
            Ok(identity.to_owned())
        })
        .collect()
}

fn identities_json(identities: &BTreeSet<String>) -> Result<String, StoreError> {
    serde_json::to_string(identities)
        .map_err(|_| internal("Retention identities cannot be encoded"))
}

fn sets_intersect(left: &BTreeSet<String>, right: &BTreeSet<String>) -> bool {
    left.iter().any(|identity| right.contains(identity))
}

fn quote_identifier(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

fn sqlite_now(connection: &Connection) -> Result<String, StoreError> {
    connection
        .query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", [], |row| {
            row.get::<_, String>(0)
        })
        .map_err(StoreError::from)
}

fn sqlite_now_ms(connection: &Connection) -> Result<i64, StoreError> {
    connection
        .query_row(
            "SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER)",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(StoreError::from)
}

fn invalid(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message, false)
}

fn conflict(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::HeadConflict, message, true)
}

fn corrupt(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message, false)
}

fn internal(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::Internal, message, false)
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Barrier};
    use std::thread;
    use std::time::{Duration, Instant};

    use tempfile::TempDir;

    use crate::database::page_key::{
        UniquePageKeyResolution, create_page_key_namespace, ensure_database_page_key,
        resolve_unique_page_key_in_library,
    };
    use crate::document::{
        DocumentPlacementEvidence, PersistYjsGenesis, persist_yjs_genesis,
        prepare_page_yjs_genesis, read_document_authority,
    };
    use crate::infrastructure::request_execution::{
        RequestExecutionClass, RequestExecutionContext, within_request_execution,
    };
    use crate::infrastructure::sqlite::{QueryCancellation, with_immediate_transaction};
    use crate::infrastructure::store::SqliteStoreKernel;

    use super::*;

    const PROJECT_ID: &str = "project:block-retention";
    const LIBRARY_ID: &str = "library:block-retention";
    const OWNED_CHILD_ID: &str = "019c0000-0000-7000-8000-000000000001";

    struct Fixture {
        _home: TempDir,
        kernel: SqliteStoreKernel,
    }

    impl Fixture {
        fn new() -> Self {
            let home = tempfile::tempdir().expect("Profile home");
            let kernel = SqliteStoreKernel::open_test(home.path()).expect("fresh store");
            kernel
                .writer()
                .call(|connection| {
                    connection.execute(
                        "INSERT INTO profiles(id, created_at, updated_at) \
                         VALUES ('profile:block-retention', ?1, ?1)",
                        ["2026-07-19T00:00:00.000Z"],
                    )?;
                    connection.execute(
                        "INSERT INTO libraries(id, profile_id, created_at, updated_at) \
                         VALUES ('library:block-retention', 'profile:block-retention', ?1, ?1)",
                        ["2026-07-19T00:00:00.000Z"],
                    )?;
                    connection.execute(
                        "INSERT INTO projects(id, library_id, name, created, updated) \
                         VALUES (?1, 'library:block-retention', 'Retention', ?2, ?2)",
                        params![PROJECT_ID, "2026-07-19T00:00:00.000Z"],
                    )?;
                    Ok(())
                })
                .expect("retention identity");
            Self {
                _home: home,
                kernel,
            }
        }

        fn insert_deleted_block(&self, block_id: &str) {
            let block_id = block_id.to_owned();
            self.kernel
                .writer()
                .call(move |connection| {
                    connection.execute(
                        "INSERT INTO blocks( \
                           id, library_id, type, lifecycle, created_at, updated_at \
                         ) VALUES (?1, ?2, 'paragraph', 'deleted', ?3, ?3)",
                        params![block_id, LIBRARY_ID, "2026-01-01T00:00:00.000Z"],
                    )?;
                    Ok(())
                })
                .expect("deleted Block");
        }

        fn insert_owned_page_closure(&self, child_lifecycle: &str) {
            let child_lifecycle = child_lifecycle.to_owned();
            self.kernel
                .writer()
                .call(move |connection| {
                    connection.execute(
                        "INSERT INTO blocks( \
                           id, library_id, type, lifecycle, created_at, updated_at \
                         ) VALUES ( \
                           'block:owned-page', ?1, 'page', 'deleted', ?2, ?2 \
                         )",
                        params![LIBRARY_ID, "2026-01-01T00:00:00.000Z"],
                    )?;
                    connection.execute(
                        "INSERT INTO documents( \
                           id, library_id, schema_key, schema_version, created_at, updated_at \
                         ) VALUES ( \
                           'document:owned-page', ?1, 'nodex.page', 3, ?2, ?2 \
                         )",
                        params![LIBRARY_ID, "2026-01-01T00:00:00.000Z"],
                    )?;
                    connection.execute(
                        "INSERT INTO block_documents(block_id, document_id, library_id, created_at) \
                         VALUES ('block:owned-page', 'document:owned-page', ?1, ?2)",
                        params![LIBRARY_ID, "2026-01-01T00:00:00.000Z"],
                    )?;
                    connection.execute(
                        "INSERT INTO pages( \
                           block_id, library_id, document_id, parent_kind, parent_id, \
                           created_at, updated_at \
                         ) VALUES ('block:owned-page', ?1, 'document:owned-page', \
                           'library', ?1, ?2, ?2)",
                        params![LIBRARY_ID, "2026-01-01T00:00:00.000Z"],
                    )?;
                    let authority = read_document_authority(connection, "document:owned-page")?
                        .expect("pending Page authority");
                    let genesis = prepare_page_yjs_genesis(
                        "document:owned-page",
                        "",
                        OWNED_CHILD_ID,
                    )?;
                    persist_yjs_genesis(
                        connection,
                        PersistYjsGenesis {
                            authority: &authority,
                            actor_project_id: PROJECT_ID,
                            materialization: &genesis.materialization,
                            update_id: "genesis:owned-page",
                            client_session_id: "client:retention-test",
                            update: &genesis.update_v1,
                            state_vector: &genesis.state_vector_v1,
                            full_state: &genesis.engine.full_state_v1(),
                            store_epoch: "epoch:test",
                            operation_id: "operation:owned-page-genesis",
                            placement: DocumentPlacementEvidence::STRUCTURAL,
                            emit_event: false,
                        },
                    )?;
                    connection.execute(
                        "UPDATE blocks SET lifecycle = ?1, updated_at = ?2 \
                         WHERE id = ?3",
                        params![
                            child_lifecycle,
                            "2026-01-01T00:00:00.000Z",
                            OWNED_CHILD_ID
                        ],
                    )?;
                    Ok(())
                })
                .expect("owned Page closure");
        }

        fn insert_active_page_documents(&self, count: usize) {
            self.kernel
                .writer()
                .call_with_budget(
                    Duration::from_secs(30),
                    QueryCancellation::new(),
                    move |connection| {
                        let now = "2026-01-01T00:00:00.000Z";
                        for index in 0..count {
                            let page_id = format!("page:retention-pressure:{index:04}");
                            let document_id = format!("document:retention-pressure:{index:04}");
                            connection.execute(
                                "INSERT INTO blocks( \
                               id, library_id, type, lifecycle, created_at, updated_at \
                             ) VALUES (?1, ?2, 'page', 'active', ?3, ?3)",
                                params![page_id, LIBRARY_ID, now],
                            )?;
                            connection.execute(
                                "INSERT INTO documents( \
                               id, library_id, schema_key, schema_version, created_at, updated_at \
                             ) VALUES (?1, ?2, 'nodex.page', 3, ?3, ?3)",
                                params![document_id, LIBRARY_ID, now],
                            )?;
                            connection.execute(
                                "INSERT INTO block_documents( \
                               block_id, document_id, library_id, created_at \
                             ) VALUES (?1, ?2, ?3, ?4)",
                                params![page_id, document_id, LIBRARY_ID, now],
                            )?;
                            connection.execute(
                                "INSERT INTO pages( \
                               block_id, library_id, document_id, parent_kind, parent_id, \
                               created_at, updated_at \
                             ) VALUES (?1, ?2, ?3, 'library', ?2, ?4, ?4)",
                                params![page_id, LIBRARY_ID, document_id, now],
                            )?;
                            let authority = read_document_authority(connection, &document_id)?
                                .expect("pending pressure Page authority");
                            let root_block_id = format!("019c0000-0000-7000-8001-{index:012x}");
                            let genesis =
                                prepare_page_yjs_genesis(&document_id, "", &root_block_id)?;
                            let update_id = format!("genesis:retention-pressure:{index:04}");
                            let operation_id = format!("operation:retention-pressure:{index:04}");
                            persist_yjs_genesis(
                                connection,
                                PersistYjsGenesis {
                                    authority: &authority,
                                    actor_project_id: PROJECT_ID,
                                    materialization: &genesis.materialization,
                                    update_id: &update_id,
                                    client_session_id: "client:retention-pressure",
                                    update: &genesis.update_v1,
                                    state_vector: &genesis.state_vector_v1,
                                    full_state: &genesis.engine.full_state_v1(),
                                    store_epoch: "epoch:test",
                                    operation_id: &operation_id,
                                    placement: DocumentPlacementEvidence::STRUCTURAL,
                                    emit_event: false,
                                },
                            )?;
                        }
                        Ok(())
                    },
                )
                .expect("active pressure Documents");
        }
    }

    #[test]
    fn retention_pressure_reads_five_hundred_current_projections_without_reconstruction() {
        let fixture = Fixture::new();
        fixture.insert_active_page_documents(500);
        for index in 0..100 {
            fixture.insert_deleted_block(&format!("block:pressure:{index:03}"));
        }

        fixture
            .kernel
            .writer()
            .call(|connection| {
                let reconstructions_before = super::super::runtime::thread_reconstruction_count();
                let started_at = Instant::now();
                let summary = run_block_retention_pass(connection, 0)?;
                let elapsed = started_at.elapsed();
                let reconstructions_after = super::super::runtime::thread_reconstruction_count();

                assert_eq!(summary.selected_candidates, 100);
                assert_eq!(summary.collected_candidates, 100);
                assert_eq!(summary.collected_blocks, 100);
                assert_eq!(summary.failed_candidates, 0);
                assert_eq!(reconstructions_after, reconstructions_before);
                eprintln!(
                    "retention pressure: documents=500 candidates=100 elapsed_ms={}",
                    elapsed.as_millis(),
                );
                Ok(())
            })
            .expect("pressure retention");
    }

    #[test]
    fn dormant_document_discovery_traverses_composed_history_actions() {
        let connection = rusqlite::Connection::open_in_memory().expect("retention fixture");
        connection
            .execute_batch(
                "CREATE TABLE structural_history_recipes( \
                   library_id TEXT NOT NULL, recipe_json TEXT NOT NULL, state TEXT NOT NULL \
                 ); \
                 CREATE TABLE documents(id TEXT PRIMARY KEY, library_id TEXT NOT NULL); \
                 CREATE TABLE blocks( \
                   id TEXT PRIMARY KEY, library_id TEXT NOT NULL, lifecycle TEXT NOT NULL, \
                   type TEXT NOT NULL \
                 ); \
                 CREATE TABLE block_documents(document_id TEXT NOT NULL); \
                 CREATE TABLE block_retention_deferrals( \
                   root_block_id TEXT NOT NULL, retry_after_ms INTEGER NOT NULL \
                 ); \
                 CREATE TABLE structural_retention_members( \
                   library_id TEXT NOT NULL, member_kind TEXT NOT NULL, member_id TEXT NOT NULL \
                 ); \
                 INSERT INTO documents(id, library_id) \
                 VALUES ('document:dormant', 'library:dormant'); \
                 INSERT INTO blocks(id, library_id, lifecycle, type) VALUES \
                   ('page:inherited', 'library:dormant', 'active', 'paragraph'), \
                   ('block:placeholder', 'library:dormant', 'deleted', 'paragraph');",
            )
            .expect("dormant document authorities");
        let recipe = serde_json::json!({
            "action": {
                "kind": "with_inline_content",
                "action": {
                    "kind": "restore_turned_selection",
                    "state": {
                        "dormantPages": [{
                            "pageId": "page:inherited",
                            "documentId": "document:dormant",
                            "placeholderBlockId": "block:placeholder",
                        }],
                    },
                },
            },
        });
        connection
            .execute(
                "INSERT INTO structural_history_recipes(library_id, recipe_json, state) \
                 VALUES ('library:dormant', ?1, 'consumed')",
                [recipe.to_string()],
            )
            .expect("composed structural recipe");

        let candidates =
            read_dormant_document_candidates(&connection, 10).expect("dormant candidates");

        assert_eq!(candidates.len(), 1);
        let candidate = &candidates[0];
        assert_eq!(candidate.library_id, "library:dormant");
        assert_eq!(candidate.root_block_id, "block:placeholder");
        assert_eq!(
            candidate.dormant_document_id.as_deref(),
            Some("document:dormant")
        );
    }

    #[test]
    fn document_history_retention_index_backfills_one_checkpoint_per_pass() {
        let fixture = Fixture::new();
        fixture.insert_active_page_documents(1);
        fixture
            .kernel
            .writer()
            .call(|connection| {
                let checkpoint = super::super::history::canonical_json_bytes(serde_json::json!({
                    "formatVersion": 2,
                    "kind": "page",
                    "blockTree": [],
                    "richTitle": [],
                }))?;
                let checkpoint_hash = super::super::persistence::sha256(&checkpoint);
                connection.execute(
                    "INSERT INTO document_versions( \
                       version_id, document_id, project_id, generation, base_head_seq, \
                       schema_key, schema_version, cause, actor_json, revision_kind, pinned, \
                       checkpoint_format, full_update_blob, state_vector, checkpoint_hash, \
                       byte_length, created_at \
                     ) VALUES ('version:retention-backfill', \
                       'document:retention-pressure:0000', ?1, 1, 1, 'nodex.page', 3, \
                       'manual', '{}', 'manual', 1, 'block_tree_snapshot_v2', ?2, X'', ?3, \
                       ?4, '2026-01-01T00:00:00.000Z')",
                    params![
                        PROJECT_ID,
                        checkpoint,
                        checkpoint_hash,
                        i64::try_from(checkpoint.len()).expect("checkpoint length"),
                    ],
                )?;
                assert!(has_unindexed_document_version_retention_work(connection)?);

                let summary = run_block_retention_pass(connection, 0)?;
                assert_eq!(summary, BlockRetentionSummary::default());
                assert!(!has_unindexed_document_version_retention_work(connection)?);
                assert_eq!(
                    connection.query_row(
                        "SELECT member_count FROM document_version_retention_index \
                         WHERE version_id = 'version:retention-backfill'",
                        [],
                        |row| row.get::<_, i64>(0),
                    )?,
                    0
                );
                Ok(())
            })
            .expect("bounded Document history retention indexing");
    }

    #[test]
    fn retention_plan_is_globally_bounded_across_libraries() {
        let fixture = Fixture::new();
        fixture
            .kernel
            .writer()
            .call(|connection| {
                connection.execute(
                    "INSERT INTO profiles(id, created_at, updated_at) \
                     VALUES ('profile:block-retention:other', ?1, ?1)",
                    ["2026-01-01T00:00:00.000Z"],
                )?;
                connection.execute(
                    "INSERT INTO libraries(id, profile_id, created_at, updated_at) \
                     VALUES ('library:block-retention:other', \
                             'profile:block-retention:other', ?1, ?1)",
                    ["2026-01-01T00:00:00.000Z"],
                )?;
                for index in 0..100 {
                    connection.execute(
                        "INSERT INTO blocks( \
                           id, library_id, type, lifecycle, created_at, updated_at \
                         ) VALUES (?1, ?2, 'paragraph', 'deleted', ?3, ?3)",
                        params![
                            format!("block:newer:{index:03}"),
                            LIBRARY_ID,
                            "2026-01-02T00:00:00.000Z",
                        ],
                    )?;
                    connection.execute(
                        "INSERT INTO blocks( \
                           id, library_id, type, lifecycle, created_at, updated_at \
                         ) VALUES (?1, ?2, 'paragraph', 'deleted', ?3, ?3)",
                        params![
                            format!("block:older:{index:03}"),
                            "library:block-retention:other",
                            "2026-01-01T00:00:00.000Z",
                        ],
                    )?;
                }
                Ok(())
            })
            .expect("multi-Library tombstones");

        let plan = fixture
            .kernel
            .readers()
            .read_default(|connection| {
                let transaction = connection.unchecked_transaction()?;
                let plan = plan_block_retention_pass(&transaction, 0)?;
                transaction.commit()?;
                Ok(plan)
            })
            .expect("global retention plan");

        assert_eq!(plan.len(), MAX_CANDIDATES_PER_PASS);
        let BlockRetentionPlanWork::Collect { candidates, .. } = &plan.work else {
            panic!("fresh fixture has no Document history backfill");
        };
        assert!(
            candidates
                .iter()
                .all(|candidate| { candidate.library_id == "library:block-retention:other" })
        );
    }

    #[test]
    fn production_scale_retention_keeps_interactive_writer_samples_responsive() {
        let fixture = Fixture::new();
        fixture.insert_active_page_documents(500);
        for index in 0..100 {
            fixture.insert_deleted_block(&format!("block:concurrent-pressure:{index:03}"));
        }
        let plan = fixture
            .kernel
            .readers()
            .read_default(|connection| {
                let transaction = connection.unchecked_transaction()?;
                let plan = plan_block_retention_pass(&transaction, 0)?;
                transaction.commit()?;
                Ok(plan)
            })
            .expect("retention plan");
        assert_eq!(plan.len(), 100);

        let start = Arc::new(Barrier::new(5));
        let writer = fixture.kernel.writer();
        let maintenance = {
            let writer = writer.clone();
            let start = Arc::clone(&start);
            thread::spawn(move || {
                within_request_execution(
                    RequestExecutionContext::new(
                        RequestExecutionClass::Maintenance,
                        QueryCancellation::new(),
                        Instant::now() + Duration::from_secs(20),
                    ),
                    || {
                        start.wait();
                        let reconstructions_before =
                            super::super::runtime::thread_reconstruction_count();
                        let mut cursor = 0;
                        let mut collected = 0;
                        let mut slice_durations = Vec::new();
                        while cursor < plan.len() {
                            let slice = plan.slice_from(cursor, 8)?;
                            let started_at = Instant::now();
                            let result = writer.call(move |connection| {
                                run_bounded_block_retention_slice(
                                    connection,
                                    &slice,
                                    Duration::from_millis(100),
                                )
                            })?;
                            slice_durations.push(started_at.elapsed());
                            cursor += result.processed_candidates;
                            collected += result.summary.collected_candidates;
                        }
                        let reconstruction_delta =
                            super::super::runtime::thread_reconstruction_count()
                                - reconstructions_before;
                        Ok::<_, StoreError>((reconstruction_delta, collected, slice_durations))
                    },
                )
            })
        };
        let background = (0..3)
            .map(|_| {
                let writer = writer.clone();
                let start = Arc::clone(&start);
                thread::spawn(move || {
                    within_request_execution(
                        RequestExecutionContext::new(
                            RequestExecutionClass::Background,
                            QueryCancellation::new(),
                            Instant::now() + Duration::from_secs(10),
                        ),
                        || {
                            start.wait();
                            for _ in 0..5 {
                                writer.call(|connection| {
                                    connection
                                        .query_row("SELECT 1", [], |row| row.get::<_, i64>(0))?;
                                    Ok(())
                                })?;
                            }
                            Ok::<_, StoreError>(())
                        },
                    )
                })
            })
            .collect::<Vec<_>>();

        start.wait();
        let mut interactive_durations = Vec::new();
        for _ in 0..20 {
            let started_at = Instant::now();
            within_request_execution(
                RequestExecutionContext::new(
                    RequestExecutionClass::Interactive,
                    QueryCancellation::new(),
                    Instant::now() + Duration::from_secs(1),
                ),
                || {
                    writer.call(|connection| {
                        connection.query_row("SELECT 1", [], |row| row.get::<_, i64>(0))?;
                        Ok(())
                    })
                },
            )
            .expect("interactive writer sample");
            interactive_durations.push(started_at.elapsed());
        }
        for handle in background {
            handle
                .join()
                .expect("background join")
                .expect("background writer samples");
        }
        let (reconstruction_delta, collected, mut slice_durations) = maintenance
            .join()
            .expect("maintenance join")
            .expect("maintenance slices");

        interactive_durations.sort_unstable();
        slice_durations.sort_unstable();
        let p95_index = |sample_count: usize| {
            (sample_count * 95)
                .div_ceil(100)
                .saturating_sub(1)
                .min(sample_count.saturating_sub(1))
        };
        let interactive_p95 = interactive_durations[p95_index(interactive_durations.len())];
        let interactive_max = *interactive_durations.last().expect("interactive samples");
        let slice_p95 = slice_durations[p95_index(slice_durations.len())];
        let slice_max = *slice_durations.last().expect("maintenance slices");

        eprintln!(
            "retention concurrency: documents=500 candidates=100 reconstructions={reconstruction_delta} interactive_samples=20 interactive_p95_ms={} interactive_max_ms={} slice_p95_ms={} slice_max_ms={}",
            interactive_p95.as_millis(),
            interactive_max.as_millis(),
            slice_p95.as_millis(),
            slice_max.as_millis(),
        );
        assert_eq!(collected, 100);
        assert_eq!(reconstruction_delta, 0);
        assert_eq!(interactive_durations.len(), 20);
        assert!(slice_durations.len() >= 100usize.div_ceil(8));
        assert!(slice_durations.len() <= 100);
    }

    #[test]
    fn bounded_slice_stops_between_candidates_after_its_time_target() {
        let fixture = Fixture::new();
        for index in 0..3 {
            fixture.insert_deleted_block(&format!("block:bounded:{index}"));
        }

        fixture
            .kernel
            .writer()
            .call(|connection| {
                let plan = plan_block_retention_pass(connection, 0)?;
                let slice = plan.slice_from(0, plan.len())?;
                let result = run_bounded_block_retention_slice(connection, &slice, Duration::ZERO)?;

                assert_eq!(result.processed_candidates, 1);
                assert_eq!(result.summary.selected_candidates, 1);
                assert_eq!(result.summary.collected_candidates, 1);
                assert_eq!(
                    connection.query_row(
                        "SELECT count(*) FROM blocks WHERE lifecycle = 'deleted'",
                        [],
                        |row| row.get::<_, i64>(0),
                    )?,
                    2,
                );
                Ok(())
            })
            .expect("bounded retention slice");
    }

    #[test]
    fn writer_slice_rejects_evidence_superseded_by_an_interactive_commit() {
        let fixture = Fixture::new();
        fixture.insert_deleted_block("block:stale-evidence");
        let plan = fixture
            .kernel
            .readers()
            .read_default(|connection| {
                let transaction = connection.unchecked_transaction()?;
                let plan = plan_block_retention_pass(&transaction, 0)?;
                transaction.commit()?;
                Ok(plan)
            })
            .expect("retention plan");
        let slice = plan.slice_from(0, 1).expect("retention slice");

        fixture.insert_active_page_documents(1);

        let error = fixture
            .kernel
            .writer()
            .call(move |connection| {
                run_bounded_block_retention_slice(connection, &slice, Duration::from_millis(100))
            })
            .expect_err("stale evidence must fail closed");
        assert_eq!(error.code, StoreErrorCode::RevisionConflict);
        let retained = fixture
            .kernel
            .readers()
            .read_default(|connection| {
                connection
                    .query_row(
                        "SELECT count(*) FROM blocks WHERE id = 'block:stale-evidence'",
                        [],
                        |row| row.get::<_, i64>(0),
                    )
                    .map_err(StoreError::from)
            })
            .expect("retained candidate");
        assert_eq!(retained, 1);
    }

    #[test]
    fn current_projection_reference_retains_a_deleted_target_without_reconstruction() {
        let fixture = Fixture::new();
        fixture.insert_active_page_documents(1);
        fixture.insert_deleted_block("block:projection-target");
        fixture
            .kernel
            .writer()
            .call(|connection| {
                connection.execute(
                    "UPDATE document_materializations SET references_json = ?1 \
                     WHERE document_id = 'document:retention-pressure:0000'",
                    [r#"[{"kind":"block","sourceBlockId":"source:pressure","targetBlockId":"block:projection-target"}]"#],
                )?;
                let before = super::super::runtime::thread_reconstruction_count();
                let summary = run_block_retention_pass(connection, 0)?;
                let after = super::super::runtime::thread_reconstruction_count();

                assert_eq!(summary.retained_candidates, 1);
                assert_eq!(summary.collected_candidates, 0);
                assert_eq!(after, before);
                let (due, next_wake_at_ms) = plan_block_retention_due_work(connection, 0)?;
                assert!(!due);
                assert!(next_wake_at_ms.is_some());
                assert_eq!(
                    connection.query_row(
                        "SELECT count(*) FROM block_retention_deferrals \
                         WHERE root_block_id = 'block:projection-target'",
                        [],
                        |row| row.get::<_, i64>(0),
                    )?,
                    1
                );
                connection.execute(
                    "UPDATE block_retention_deferrals SET retry_after_ms = 0 \
                     WHERE root_block_id = 'block:projection-target'",
                    [],
                )?;
                assert!(plan_block_retention_due_work(connection, 0)?.0);
                Ok(())
            })
            .expect("projection reference retention");
    }

    #[test]
    fn collecting_a_page_keeps_shared_library_files_and_other_placements() {
        let fixture = Fixture::new();
        fixture.insert_owned_page_closure("deleted");
        fixture.insert_active_page_documents(1);
        fixture.kernel.writer().call(|connection| {
            with_immediate_transaction(connection, |connection| {
                let now = "2026-01-01T00:00:00.000Z";
                let hash = "b".repeat(64);
                connection.execute("INSERT INTO managed_blobs(content_hash, physical_asset_name, byte_length, created_at) VALUES (?1, ?1, 4, ?2)", params![hash, now])?;
                connection.execute("INSERT INTO file_versions(file_id, version, library_id, blob_hash, mime_type, byte_length, actor_id, operation_id, occurred_at) VALUES ('file:shared', 1, ?1, ?2, 'image/png', 4, ?3, 'create-file', ?4)", params![LIBRARY_ID, hash, PROJECT_ID, now])?;
                connection.execute("INSERT INTO library_files(file_id, library_id, default_name, head_version, revision, lifecycle, created_by_actor_id, created_at, updated_at) VALUES ('file:shared', ?1, 'shared.png', 1, 1, 'live', ?2, ?3, ?3)", params![LIBRARY_ID, PROJECT_ID, now])?;
                connection.execute("INSERT INTO page_file_entries(page_id, library_id, file_id, logical_path, path_key) VALUES ('block:owned-page', ?1, 'file:shared', 'shared.png', 'shared.png')", [LIBRARY_ID])?;
                let (block_id, projected_seq) = connection.query_row("SELECT block_id, projected_seq FROM document_block_index WHERE document_id = 'document:retention-pressure:0000' ORDER BY ordinal LIMIT 1", [], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))?;
                connection.execute("INSERT INTO block_asset_refs(document_id, block_id, owner_block_id, library_id, document_generation, projected_seq, projection_version, role, ordinal, asset_uri, asset_hash, file_id, updated_at) VALUES ('document:retention-pressure:0000', ?1, 'page:retention-pressure:0000', ?2, 1, ?3, 1, 'image', 0, 'nodex://files/file:shared', ?4, 'file:shared', ?5)", params![block_id, LIBRARY_ID, projected_seq, hash, now])?;
                Ok(())
            })?;
            let collected = run_block_retention_pass(connection, 0)?;
            assert_eq!(collected.collected_candidates, 1);
            for (sql, expected) in [
                ("SELECT count(*) FROM blocks WHERE id = 'block:owned-page'", 0),
                ("SELECT count(*) FROM page_file_entries WHERE file_id = 'file:shared'", 0),
                ("SELECT count(*) FROM library_files WHERE file_id = 'file:shared'", 1),
                ("SELECT count(*) FROM file_versions WHERE file_id = 'file:shared'", 1),
                ("SELECT count(*) FROM block_asset_refs WHERE file_id = 'file:shared'", 1),
            ] { assert_eq!(connection.query_row(sql, [], |row| row.get::<_, i64>(0))?, expected); }
            Ok(())
        }).expect("Page collection preserves independent File identity");
    }

    #[test]
    fn stale_current_projection_fails_closed_without_reconstruction_fallback() {
        let fixture = Fixture::new();
        fixture.insert_active_page_documents(1);
        fixture.insert_deleted_block("block:stale-projection-target");
        fixture
            .kernel
            .writer()
            .call(|connection| {
                connection.execute(
                    "UPDATE document_materializations SET projected_seq = 0 \
                     WHERE document_id = 'document:retention-pressure:0000'",
                    [],
                )?;
                let before = super::super::runtime::thread_reconstruction_count();
                let summary = run_block_retention_pass(connection, 0)?;
                let after = super::super::runtime::thread_reconstruction_count();

                assert_eq!(summary.retained_candidates, 1);
                assert_eq!(summary.collected_candidates, 0);
                assert_eq!(after, before);
                Ok(())
            })
            .expect("stale projection retention");
    }

    #[test]
    fn collects_an_unreachable_tombstone_and_preserves_immutable_audit_evidence() {
        let fixture = Fixture::new();
        fixture.insert_deleted_block("block:collectible");
        fixture
            .kernel
            .writer()
            .call(|connection| {
                connection.execute(
                    "INSERT INTO change_log( \
                       project_id, store_epoch, kind, block_ids_json, projection_impact_json, committed_at \
                     ) VALUES (?1, 'epoch:test', 'block_deleted', '[\"block:collectible\"]', \
                       '{\"kind\":\"none\"}', ?2)",
                    params![PROJECT_ID, "2026-01-01T00:00:00.000Z"],
                )?;
                let summary = run_block_retention_pass(connection, 0)?;
                assert_eq!(
                    summary,
                    BlockRetentionSummary {
                        selected_candidates: 1,
                        collected_candidates: 1,
                        collected_blocks: 1,
                        retained_candidates: 0,
                        covered_candidates: 0,
                        failed_candidates: 0,
                    }
                );
                assert_eq!(
                    connection.query_row(
                        "SELECT count(*) FROM blocks WHERE id = 'block:collectible'",
                        [],
                        |row| row.get::<_, i64>(0),
                    )?,
                    0
                );
                assert_eq!(
                    connection.query_row(
                        "SELECT retention_root_block_id FROM retired_block_identities \
                         WHERE block_id = 'block:collectible'",
                        [],
                        |row| row.get::<_, String>(0),
                    )?,
                    "block:collectible"
                );
                assert_eq!(
                    connection.query_row("SELECT count(*) FROM change_log", [], |row| {
                        row.get::<_, i64>(0)
                    })?,
                    1
                );
                Ok(())
            })
            .expect("collect tombstone");
    }

    #[test]
    fn page_key_tombstone_survives_hard_retention_and_its_number_is_never_reused() {
        let fixture = Fixture::new();
        fixture.insert_owned_page_closure("deleted");
        fixture
            .kernel
            .writer()
            .call(|connection| {
                let old = "2026-01-01T00:00:00.000Z";
                connection.execute(
                    "INSERT INTO blocks( \
                       id, library_id, type, lifecycle, created_at, updated_at \
                     ) VALUES ('database:key-retention', 'library:block-retention', \
                       'database', 'active', ?1, ?1)",
                    [old],
                )?;
                connection.execute(
                    "INSERT INTO database_containers( \
                       block_id, library_id, name, lifecycle, created_at, updated_at \
                     ) VALUES ('database:key-retention', 'library:block-retention', \
                       'Key retention', 'active', ?1, ?1)",
                    [old],
                )?;
                connection.execute(
                    "INSERT INTO data_sources( \
                       id, library_id, home_database_block_id, name, schema_key, lifecycle, \
                       rank_key, created_at, updated_at \
                     ) VALUES ('source:key-retention', 'library:block-retention', \
                       'database:key-retention', 'Key retention', 'nodex.database', 'active', \
                       'a', ?1, ?1)",
                    [old],
                )?;
                create_page_key_namespace(
                    connection,
                    "library:block-retention",
                    "database:key-retention",
                    Some("RET"),
                    "Retention",
                    old,
                )?;
                connection.execute(
                    "INSERT INTO data_source_page_memberships( \
                       id, data_source_id, page_block_id, revision, created_at, removed_at \
                     ) VALUES ('membership:key-retention:original', 'source:key-retention', \
                       'block:owned-page', 1, ?1, ?1)",
                    [old],
                )?;
                let original = ensure_database_page_key(
                    connection,
                    "library:block-retention",
                    "database:key-retention",
                    "block:owned-page",
                    old,
                )?
                .expect("enabled Page-key namespace");
                assert_eq!(original.number, 1);
                assert_eq!(original.current_page_key, "RET-1");

                assert_eq!(
                    connection.query_row(
                        "SELECT count(*) FROM page_key_assignments \
                         WHERE database_block_id = 'database:key-retention' \
                           AND page_block_id = 'block:owned-page'",
                        [],
                        |row| row.get::<_, i64>(0),
                    )?,
                    1,
                );

                let summary = run_block_retention_pass(connection, 0)?;
                assert_eq!(summary.collected_candidates, 1, "{summary:?}");
                assert_eq!(summary.collected_blocks, 2);
                assert_eq!(
                    connection.query_row(
                        "SELECT count(*) FROM pages WHERE block_id = 'block:owned-page'",
                        [],
                        |row| row.get::<_, i64>(0),
                    )?,
                    0,
                );
                assert_eq!(
                    connection.query_row(
                        "SELECT block_type FROM retired_block_identities \
                         WHERE block_id = 'block:owned-page'",
                        [],
                        |row| row.get::<_, String>(0),
                    )?,
                    "page",
                );
                assert_eq!(
                    connection.query_row(
                        "SELECT number FROM page_key_assignments \
                         WHERE database_block_id = 'database:key-retention' \
                           AND page_block_id = 'block:owned-page'",
                        [],
                        |row| row.get::<_, i64>(0),
                    )?,
                    1,
                );
                assert_eq!(
                    connection.query_row(
                        "SELECT next_number FROM page_key_namespaces \
                         WHERE database_block_id = 'database:key-retention'",
                        [],
                        |row| row.get::<_, i64>(0),
                    )?,
                    2,
                );
                assert!(
                    resolve_unique_page_key_in_library(
                        connection,
                        "library:block-retention",
                        "RET-1",
                    )? == UniquePageKeyResolution::NotFound,
                );

                connection.execute(
                    "INSERT INTO blocks( \
                       id, library_id, type, lifecycle, created_at, updated_at \
                     ) VALUES ('page:key-retention-successor', 'library:block-retention', \
                       'page', 'active', ?1, ?1)",
                    [old],
                )?;
                connection.execute(
                    "INSERT INTO documents( \
                       id, library_id, schema_key, schema_version, created_at, updated_at \
                     ) VALUES ('document:key-retention-successor', 'library:block-retention', \
                       'nodex.page', 3, ?1, ?1)",
                    [old],
                )?;
                connection.execute(
                    "INSERT INTO block_documents(block_id, document_id, library_id, created_at) \
                     VALUES ('page:key-retention-successor', 'document:key-retention-successor', \
                       'library:block-retention', ?1)",
                    [old],
                )?;
                connection.execute(
                    "INSERT INTO pages( \
                       block_id, library_id, document_id, parent_kind, parent_id, \
                       created_at, updated_at \
                     ) VALUES ('page:key-retention-successor', 'library:block-retention', \
                       'document:key-retention-successor', 'data_source', \
                       'source:key-retention', ?1, ?1)",
                    [old],
                )?;
                connection.execute(
                    "INSERT INTO data_source_page_memberships( \
                       id, data_source_id, page_block_id, revision, created_at, removed_at \
                     ) VALUES ('membership:key-retention:successor', 'source:key-retention', \
                       'page:key-retention-successor', 1, ?1, NULL)",
                    [old],
                )?;
                let successor = ensure_database_page_key(
                    connection,
                    "library:block-retention",
                    "database:key-retention",
                    "page:key-retention-successor",
                    old,
                )?
                .expect("enabled Page-key namespace");
                assert_eq!(successor.number, 2);
                assert_eq!(successor.current_page_key, "RET-2");
                assert_eq!(
                    connection.query_row(
                        "SELECT next_number FROM page_key_namespaces \
                         WHERE database_block_id = 'database:key-retention'",
                        [],
                        |row| row.get::<_, i64>(0),
                    )?,
                    3,
                );
                Ok(())
            })
            .expect("retain Page-key tombstone across physical Page purge");
    }

    #[test]
    fn session_domain_state_does_not_retain_a_window_local_page_target() {
        let fixture = Fixture::new();
        fixture.insert_deleted_block("block:session-target");
        fixture
            .kernel
            .writer()
            .call(|connection| {
                connection.execute(
                    "INSERT INTO project_sessions( \
                       id, project_id, no_thread_fallback_title, \"order\", \
                       created_at, updated_at \
                     ) VALUES ('session:retention', ?1, 'Retention', 0, ?2, ?2)",
                    params![PROJECT_ID, "2026-01-01T00:00:00.000Z"],
                )?;
                let summary = run_block_retention_pass(connection, 0)?;
                assert_eq!(summary.retained_candidates, 0);
                assert_eq!(summary.collected_blocks, 1);
                assert_eq!(
                    connection.query_row(
                        "SELECT count(*) FROM blocks WHERE id = 'block:session-target'",
                        [],
                        |row| row.get::<_, i64>(0),
                    )?,
                    0
                );
                Ok(())
            })
            .expect("collect window-local target");
    }

    #[test]
    fn an_unknown_inbound_foreign_key_retains_the_candidate() {
        let fixture = Fixture::new();
        fixture.insert_deleted_block("block:unknown-root");
        fixture
            .kernel
            .writer()
            .call(|connection| {
                connection.execute_batch(
                    "CREATE TABLE extension_reference( \
                       id TEXT PRIMARY KEY, \
                       target_block_id TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE \
                     ); \
                     INSERT INTO extension_reference(id, target_block_id) \
                     VALUES ('extension:1', 'block:unknown-root');",
                )?;
                let summary = run_block_retention_pass(connection, 0)?;
                assert_eq!(summary.retained_candidates, 1);
                assert_eq!(summary.collected_blocks, 0);
                Ok(())
            })
            .expect("retain unknown reference");
    }

    #[test]
    fn an_external_relation_edge_retains_its_deleted_target_page() {
        let fixture = Fixture::new();
        fixture
            .kernel
            .writer()
            .call(|connection| {
                let old = "2026-01-01T00:00:00.000Z";
                connection.execute(
                    "INSERT INTO blocks(\
                       id, library_id, type, lifecycle, created_at, updated_at\
                     ) VALUES ('database:relation-retention', ?1, 'database', 'active', \
                       ?2, ?2)",
                    params![LIBRARY_ID, old],
                )?;
                connection.execute(
                    "INSERT INTO database_containers(\
                       block_id, library_id, name, lifecycle, created_at, updated_at\
                     ) VALUES ('database:relation-retention', 'library:block-retention', \
                       'Relations', 'active', ?1, ?1)",
                    [old],
                )?;
                connection.execute(
                    "INSERT INTO data_sources(\
                       id, library_id, home_database_block_id, name, schema_key, lifecycle, \
                       rank_key, created_at, updated_at\
                     ) VALUES ('source:relation-retention', 'library:block-retention', \
                       'database:relation-retention', 'Relations', 'nodex.database', 'active', \
                       'a', ?1, ?1)",
                    [old],
                )?;
                for (page_id, document_id) in [
                    ("page:relation-source", "document:relation-source"),
                    ("page:relation-target", "document:relation-target"),
                ] {
                    connection.execute(
                        "INSERT INTO blocks(\
                           id, library_id, type, lifecycle, created_at, updated_at\
                         ) VALUES (?1, ?2, 'page', 'active', ?3, ?3)",
                        params![page_id, LIBRARY_ID, old],
                    )?;
                    connection.execute(
                        "INSERT INTO documents(\
                           id, library_id, schema_key, schema_version, created_at, updated_at\
                         ) VALUES (?1, ?2, 'nodex.page', 3, ?3, ?3)",
                        params![document_id, LIBRARY_ID, old],
                    )?;
                    connection.execute(
                        "INSERT INTO block_documents(block_id, document_id, library_id, created_at) \
                         VALUES (?1, ?2, ?3, ?4)",
                        params![page_id, document_id, LIBRARY_ID, old],
                    )?;
                    connection.execute(
                        "INSERT INTO pages(\
                           block_id, library_id, document_id, parent_kind, parent_id, \
                           created_at, updated_at\
                         ) VALUES (?1, 'library:block-retention', ?2, 'data_source', \
                           'source:relation-retention', ?3, ?3)",
                        params![page_id, document_id, old],
                    )?;
                }
                connection.execute(
                    "INSERT INTO data_source_page_memberships(\
                       id, data_source_id, page_block_id, revision, created_at, removed_at\
                     ) VALUES \
                       ('membership:relation-source', 'source:relation-retention', \
                         'page:relation-source', 1, ?1, NULL), \
                       ('membership:relation-target', 'source:relation-retention', \
                         'page:relation-target', 1, ?1, NULL)",
                    [old],
                )?;
                connection.execute(
                    "INSERT INTO data_source_properties(\
                       data_source_id, id, name, value_type, config_json, rank_key, lifecycle, \
                       schema_revision, created_at, updated_at\
                     ) VALUES ('source:relation-retention', 'p_blocked0', 'Blocked by', \
                       'relation', '{}', 'z', 'active', 1, ?1, ?1)",
                    [old],
                )?;
                connection.execute(
                    "INSERT INTO data_source_relation_properties(\
                       data_source_id, property_id, target_data_source_id\
                     ) VALUES ('source:relation-retention', 'p_blocked0', \
                       'source:relation-retention')",
                    [],
                )?;
                connection.execute(
                    "INSERT INTO data_source_property_values(\
                       data_source_id, membership_id, property_id, value_type, value_json, \
                       revision, updated_at\
                     ) VALUES ('source:relation-retention', 'membership:relation-source', \
                       'p_blocked0', 'relation', 'null', 1, ?1)",
                    [old],
                )?;
                connection.execute(
                    "INSERT INTO data_source_relation_edges(\
                       edge_id, source_data_source_id, source_membership_id, property_id, \
                       target_page_block_id, created_at\
                     ) VALUES (?1, 'source:relation-retention', 'membership:relation-source', \
                       'p_blocked0', 'page:relation-target', ?2)",
                    params!["b".repeat(64), old],
                )?;
                connection.execute(
                    "UPDATE data_source_page_memberships SET removed_at = ?1 \
                     WHERE id = 'membership:relation-target'",
                    [old],
                )?;
                connection.execute(
                    "UPDATE blocks SET lifecycle = 'deleted', updated_at = ?1 \
                     WHERE id = 'page:relation-target'",
                    [old],
                )?;

                let summary = run_block_retention_pass(connection, 0)?;
                assert_eq!(summary.retained_candidates, 1);
                assert_eq!(summary.collected_blocks, 0);
                assert_eq!(
                    connection.query_row(
                        "SELECT count(*) FROM blocks WHERE id = 'page:relation-target'",
                        [],
                        |row| row.get::<_, i64>(0),
                    )?,
                    1
                );
                Ok(())
            })
            .expect("retain Relation target");
    }

    #[test]
    fn retained_draft_roots_protect_deleted_owners_until_the_package_is_collected() {
        let fixture = Fixture::new();
        fixture.insert_owned_page_closure("deleted");
        fixture.kernel.writer().call(|connection| {
            connection.execute("INSERT INTO document_recovery_drafts(library_id, draft_id, document_id, source_store_epoch, generation, created_at, received_at, payload_json, payload_hash, byte_length) VALUES (?1, 'draft:protected', 'document:owned-page', 'epoch:test', 1, '2000-01-01', '2000-01-01', '{}', ?2, 2)", params![LIBRARY_ID, "0".repeat(64)])?;
            connection.execute("INSERT INTO document_recovery_block_roots VALUES (?1, 'draft:protected', ?2)", params![LIBRARY_ID, OWNED_CHILD_ID])?;
            assert_eq!(run_block_retention_pass(connection, 0)?.collected_candidates, 0);
            connection.execute("DELETE FROM document_recovery_drafts WHERE draft_id = 'draft:protected'", [])?;
            connection.execute("UPDATE block_retention_deferrals SET retry_after_ms = 0", [])?;
            assert_eq!(run_block_retention_pass(connection, 0)?.collected_candidates, 1);
            Ok(())
        }).expect("draft retention protects the entire ownership closure");
    }

    #[test]
    fn collects_a_deleted_ownership_closure_and_prunes_resolved_recovery() {
        let fixture = Fixture::new();
        fixture.insert_owned_page_closure("deleted");
        fixture
            .kernel
            .writer()
            .call(|connection| {
                connection.execute(
                    "INSERT INTO document_recovery_artifacts( \
                       id, project_id, store_epoch, document_id, generation, update_id, \
                       client_session_id, base_head_seq, touched_block_ids_json, \
                       derived_touched_block_ids_json, update_blob, update_hash, \
                       update_byte_length, reason, status, created_at, expires_at, resolved_at \
                     ) VALUES ( \
                       'recovery:resolved', ?1, 'epoch:test', 'document:owned-page', 1, \
                       'update:resolved', 'client:test', 0, ?5, \
                       '[\"block:owned-page\"]', X'01', ?2, 1, 'unsafe_stale_update', \
                       'resolved', ?3, ?4, ?3 \
                     )",
                    params![
                        PROJECT_ID,
                        "0000000000000000000000000000000000000000000000000000000000000000",
                        "2026-01-01T00:00:00.000Z",
                        "2026-02-01T00:00:00.000Z",
                        serde_json::to_string(&[OWNED_CHILD_ID]).expect("touched IDs")
                    ],
                )?;
                let summary = run_block_retention_pass(connection, 0)?;
                assert_eq!(summary.collected_candidates, 1, "{summary:?}");
                assert_eq!(summary.collected_blocks, 2);
                assert_eq!(
                    connection.query_row(
                        "SELECT count(*) FROM blocks \
                         WHERE id = 'block:owned-page' OR id = ?1",
                        [OWNED_CHILD_ID],
                        |row| row.get::<_, i64>(0),
                    )?,
                    0
                );
                assert_eq!(
                    connection.query_row(
                        "SELECT count(*) FROM documents WHERE id = 'document:owned-page'",
                        [],
                        |row| row.get::<_, i64>(0),
                    )?,
                    0
                );
                assert_eq!(
                    connection.query_row(
                        "SELECT count(*) FROM document_recovery_artifacts \
                         WHERE id = 'recovery:resolved'",
                        [],
                        |row| row.get::<_, i64>(0),
                    )?,
                    0
                );
                Ok(())
            })
            .expect("collect ownership closure");
    }

    #[test]
    fn a_live_contained_block_retains_the_entire_ownership_closure() {
        let fixture = Fixture::new();
        fixture.insert_owned_page_closure("active");
        fixture
            .kernel
            .writer()
            .call(|connection| {
                let summary = run_block_retention_pass(connection, 0)?;
                assert_eq!(summary.retained_candidates, 1);
                assert_eq!(
                    connection.query_row(
                        "SELECT count(*) FROM blocks \
                         WHERE id = 'block:owned-page' OR id = ?1",
                        [OWNED_CHILD_ID],
                        |row| row.get::<_, i64>(0),
                    )?,
                    2
                );
                Ok(())
            })
            .expect("retain live child closure");
    }

    #[test]
    fn a_late_document_delete_failure_rolls_back_the_complete_candidate() {
        let fixture = Fixture::new();
        fixture.insert_owned_page_closure("deleted");
        fixture
            .kernel
            .writer()
            .call(|connection| {
                connection.execute_batch(
                    "CREATE TEMP TRIGGER fail_retention_document_delete \
                     BEFORE DELETE ON documents BEGIN \
                       SELECT RAISE(ABORT, 'injected retention failure'); \
                     END;",
                )?;
                assert!(run_block_retention_pass(connection, 0).is_err());
                assert_eq!(
                    connection.query_row(
                        "SELECT count(*) FROM blocks \
                         WHERE id = 'block:owned-page' OR id = ?1",
                        [OWNED_CHILD_ID],
                        |row| row.get::<_, i64>(0),
                    )?,
                    2
                );
                assert_eq!(
                    connection.query_row(
                        "SELECT count(*) FROM retired_block_identities \
                         WHERE block_id = 'block:owned-page' OR block_id = ?1",
                        [OWNED_CHILD_ID],
                        |row| row.get::<_, i64>(0),
                    )?,
                    0
                );
                Ok(())
            })
            .expect("candidate rollback");
    }
}
