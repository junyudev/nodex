use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::json;
use sha2::{Digest, Sha256};

use nodex_core_contracts::ProjectionImpact;

use crate::domain::derived_records::{BlockDocumentAssetKind, BlockDocumentReference};
use crate::infrastructure::document_repository::{DocumentHeadRow, DocumentReadRepository};
use crate::infrastructure::event_log::{NewChangeLogEntry, append_change_log};
use crate::infrastructure::local_commit::{self, CommitContext, RegisteredDocumentEffect};
use crate::infrastructure::projection_impact::{
    PageProjectionCoordinates, PageProjectionDatabaseCoordinates, expand_database_coordinates,
    impact_for_page_document,
};
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

use super::materialization::DocumentPlacementDelta;
use super::{
    CURRENT_DOCUMENT_MATERIALIZATION_DERIVATION_VERSION, DocumentBlockSearchUnit,
    DocumentMaterialization, DocumentSearchMarkerKind, derive_document_node_delta,
    derive_document_placement_delta, exact_moves_explain_document_placement,
};

pub(super) const TYPED_CREATION_BLOCK_TYPES: &[&str] = &[
    "page",
    "database",
    "synced_block_source",
    "reusable_template_source",
    "canvas",
];
const PROJECTION_VERSION: i64 = 1;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DocumentAuthorityRow {
    pub head: DocumentHeadRow,
    pub owner_block_id: String,
    pub owner_type: String,
    pub owner_lifecycle: String,
    pub page_library_id: Option<String>,
    pub page_database: Option<PageProjectionDatabaseCoordinates>,
}

impl DocumentAuthorityRow {
    pub(crate) fn page_impact(&self) -> Option<PageProjectionCoordinates> {
        self.page_library_id.as_ref()?;
        Some(PageProjectionCoordinates {
            page_id: self.owner_block_id.clone(),
            database: self.page_database.clone(),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PersistedDocumentCommit {
    pub head_seq: i64,
    pub state_vector: Vec<u8>,
    pub derived_touched_block_ids: Vec<String>,
    /// Public event head after persistence. This is the emitted event's sequence
    /// when the owning aggregate publishes one.
    pub event_sequence: i64,
    pub committed_at: String,
}

/// Attributes same-parent ordering changes without trusting renderer metadata.
/// Collaborative updates use the conservative tree delta; typed compilers name
/// exact moved roots so dense ordinal shifts do not churn sibling CAS.
#[derive(Clone, Copy, Debug)]
pub(crate) enum DocumentReorderAttribution<'a> {
    Conservative,
    Exact(&'a [String]),
}

#[derive(Clone, Copy, Debug)]
struct DocumentTombstoneReactivation<'a> {
    block_ids: &'a [String],
    source_document_id: &'a str,
    source_document_generation: i64,
}

/// Declares only placement evidence that one Document's canonical before/after
/// trees cannot prove. Write fences are deliberately absent: coordination
/// scope and semantic placement identity are different concepts.
#[derive(Clone, Copy, Debug)]
#[must_use]
pub(crate) struct DocumentPlacementEvidence<'a> {
    structurally_detached_block_ids: &'a [String],
    placement_genesis_block_ids: &'a [String],
    placement_preapplied_block_ids: &'a [String],
    placement_advance_block_ids: &'a [String],
    reorder_attribution: DocumentReorderAttribution<'a>,
    allow_last_document_reactivation: bool,
    tombstone_reactivation: Option<DocumentTombstoneReactivation<'a>>,
    page_file_placements_prevalidated: bool,
}

impl<'a> DocumentPlacementEvidence<'a> {
    /// Raw collaborative or wholesale updates. Core derives every local
    /// placement change from the canonical materializations.
    pub(crate) const COLLABORATIVE: Self = Self {
        structurally_detached_block_ids: &[],
        placement_genesis_block_ids: &[],
        placement_preapplied_block_ids: &[],
        placement_advance_block_ids: &[],
        reorder_attribution: DocumentReorderAttribution::Conservative,
        allow_last_document_reactivation: true,
        tombstone_reactivation: None,
        page_file_placements_prevalidated: false,
    };

    /// Typed structural updates name their exact move and authority evidence.
    pub(crate) const STRUCTURAL: Self = Self {
        structurally_detached_block_ids: &[],
        placement_genesis_block_ids: &[],
        placement_preapplied_block_ids: &[],
        placement_advance_block_ids: &[],
        reorder_attribution: DocumentReorderAttribution::Exact(&[]),
        allow_last_document_reactivation: false,
        tombstone_reactivation: None,
        page_file_placements_prevalidated: false,
    };

    /// Blocks intentionally detached by the surrounding structural mutation.
    /// Generic Document edits must leave this empty so removal keeps its normal
    /// deletion semantics. The destination owns the canonical placement move.
    pub(crate) const fn with_structural_detaches(mut self, block_ids: &'a [String]) -> Self {
        self.structurally_detached_block_ids = block_ids;
        self
    }

    /// Typed Blocks receiving their first authoritative Document placement.
    pub(crate) const fn with_genesis(mut self, block_ids: &'a [String]) -> Self {
        self.placement_genesis_block_ids = block_ids;
        self
    }

    /// Placements whose owning aggregate already advanced their revision.
    pub(crate) const fn with_preapplied(mut self, block_ids: &'a [String]) -> Self {
        self.placement_preapplied_block_ids = block_ids;
        self
    }

    /// Existing Blocks attached from another authority whose placement
    /// revision advances in this persistence operation.
    pub(crate) const fn with_advances(mut self, block_ids: &'a [String]) -> Self {
        self.placement_advance_block_ids = block_ids;
        self
    }

    /// Exact moved roots emitted by a typed Document compiler.
    pub(crate) const fn with_exact_moves(mut self, block_ids: &'a [String]) -> Self {
        self.reorder_attribution = DocumentReorderAttribution::Exact(block_ids);
        self
    }

    /// The typed compiler derived every new File placement from an authorized
    /// source Document. This is narrower than generic structural persistence:
    /// callers that accept fresh content must still prove File read access.
    pub(crate) const fn with_prevalidated_page_file_placements(mut self) -> Self {
        self.page_file_placements_prevalidated = true;
        self
    }

    /// Ordinary Blocks may reactivate only from the exact tombstone authority
    /// named by the typed structural operation. This supports both same-Document
    /// undo and capability-authorized cross-Document cut moves without making
    /// generic Document updates a resurrection authority.
    pub(crate) const fn with_tombstone_reactivation(
        mut self,
        block_ids: &'a [String],
        source_document_id: &'a str,
        source_document_generation: i64,
    ) -> Self {
        self.tombstone_reactivation = Some(DocumentTombstoneReactivation {
            block_ids,
            source_document_id,
            source_document_generation,
        });
        self
    }
}

#[derive(Debug, Default)]
struct ReconciledDocumentBlocks {
    placement_changed_page_ids: Vec<String>,
}

pub(crate) struct PersistYjsCommit<'a> {
    pub authority: &'a DocumentAuthorityRow,
    pub actor_project_id: &'a str,
    pub base_materialization: &'a DocumentMaterialization,
    pub materialization: &'a DocumentMaterialization,
    pub update_id: &'a str,
    pub client_session_id: &'a str,
    pub base_head_seq: i64,
    pub client_touched_block_ids: &'a [String],
    pub update: &'a [u8],
    pub state_vector: &'a [u8],
    pub store_epoch: &'a str,
    pub operation_id: &'a str,
    pub local_commit_id: Option<&'a str>,
    pub event_kind: &'a str,
    pub write_fence_block_ids: &'a [String],
    pub title_write_fence_required: bool,
    pub document_write_fence_required: bool,
    pub placement: DocumentPlacementEvidence<'a>,
}

pub(crate) struct PersistYjsGenesis<'a> {
    pub authority: &'a DocumentAuthorityRow,
    pub actor_project_id: &'a str,
    pub materialization: &'a DocumentMaterialization,
    pub update_id: &'a str,
    pub client_session_id: &'a str,
    pub update: &'a [u8],
    pub state_vector: &'a [u8],
    pub full_state: &'a [u8],
    pub store_epoch: &'a str,
    pub operation_id: &'a str,
    pub placement: DocumentPlacementEvidence<'a>,
    /// Internal collaborator genesis keeps its durable Document artifacts but
    /// lets the owning aggregate publish the single public event.
    pub emit_event: bool,
}

pub(crate) fn read_document_authority(
    connection: &Connection,
    document_id: &str,
) -> Result<Option<DocumentAuthorityRow>, StoreError> {
    let Some(head) = DocumentReadRepository::new(connection).document_head(document_id)? else {
        return Ok(None);
    };
    read_document_authority_for_head(connection, head)
}

fn read_document_authority_for_head(
    connection: &Connection,
    head: DocumentHeadRow,
) -> Result<Option<DocumentAuthorityRow>, StoreError> {
    let owner = connection
        .query_row(
            "SELECT ownership.block_id, owner.type, owner.lifecycle, \
                    page.library_id, page.parent_kind, page.parent_id, \
                    source.home_database_block_id \
             FROM block_documents ownership \
             JOIN blocks owner ON owner.id = ownership.block_id \
               AND owner.library_id = ownership.library_id \
             LEFT JOIN pages page ON page.block_id = owner.id \
               AND page.document_id = ownership.document_id \
             LEFT JOIN data_sources source ON page.parent_kind = 'data_source' \
               AND source.id = page.parent_id AND source.library_id = page.library_id \
             WHERE ownership.document_id = ?1 AND ownership.library_id = ?2",
            params![head.id, head.library_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                ))
            },
        )
        .optional()
        .map_err(|_| corrupt("Document owner row has invalid column types"))?;
    let Some((
        owner_block_id,
        owner_type,
        owner_lifecycle,
        page_library_id,
        page_parent_kind,
        page_parent_id,
        page_database_id,
    )) = owner
    else {
        return Err(corrupt("Document has no owning Block"));
    };
    if owner_block_id.is_empty()
        || owner_type.is_empty()
        || !matches!(owner_lifecycle.as_str(), "active" | "archived" | "deleted")
    {
        return Err(corrupt("Document owner row is invalid"));
    }
    if owner_type == "page" {
        if page_library_id.as_deref().is_some_and(str::is_empty) {
            return Err(corrupt("Page Document authority row is invalid"));
        }
        if page_library_id.is_some()
            && (!matches!(
                page_parent_kind.as_deref(),
                Some("library" | "page" | "data_source")
            ) || page_parent_id.as_deref().is_none_or(str::is_empty))
        {
            return Err(corrupt("Page Document parent authority is invalid"));
        }
    } else if page_library_id.is_some() {
        return Err(corrupt("Non-Page Document has Page authority"));
    }
    let page_database = match page_parent_kind.as_deref() {
        Some("data_source") => {
            let database_id = page_database_id
                .filter(|database_id| !database_id.is_empty())
                .ok_or_else(|| corrupt("Page Data Source has no home Database"))?;
            let data_source_id = page_parent_id
                .filter(|data_source_id| !data_source_id.is_empty())
                .ok_or_else(|| corrupt("Page Data Source identity is invalid"))?;
            let view_ids = connection
                .prepare(
                    "SELECT id FROM database_views \
                     WHERE data_source_id = ?1 AND database_block_id = ?2 \
                       AND lifecycle = 'active' ORDER BY id",
                )?
                .query_map(params![data_source_id, database_id], |row| {
                    row.get::<_, String>(0)
                })?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(|_| corrupt("Page Data Source View identities are invalid"))?;
            Some(PageProjectionDatabaseCoordinates {
                database_id,
                data_source_id,
                view_ids,
            })
        }
        Some("library" | "page") | None => {
            if page_database_id.is_some() {
                return Err(corrupt("Non-Database Page has Database authority"));
            }
            None
        }
        Some(_) => return Err(corrupt("Page parent kind is invalid")),
    };
    Ok(Some(DocumentAuthorityRow {
        head,
        owner_block_id,
        owner_type,
        owner_lifecycle,
        page_library_id,
        page_database,
    }))
}

pub(crate) fn read_store_epoch(connection: &Connection) -> Result<String, StoreError> {
    connection
        .query_row(
            "SELECT store_epoch FROM block_store_metadata WHERE id = 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .filter(|epoch| !epoch.is_empty() && epoch.len() <= 512)
        .ok_or_else(|| corrupt("Profile store epoch is not initialized"))
}

pub(crate) fn read_event_head(connection: &Connection) -> Result<i64, StoreError> {
    let head = connection.query_row("SELECT COALESCE(max(seq), 0) FROM change_log", [], |row| {
        row.get::<_, i64>(0)
    })?;
    if head >= 0 {
        return Ok(head);
    }
    Err(corrupt("Change log head is invalid"))
}

pub(crate) fn read_local_commit_head(connection: &Connection) -> Result<i64, StoreError> {
    crate::infrastructure::local_commit::head(connection)
}

pub(crate) fn persist_yjs_commit_with_local_commit(
    connection: &Connection,
    input: PersistYjsCommit<'_>,
    context: &CommitContext,
) -> Result<PersistedDocumentCommit, StoreError> {
    persist_yjs_commit_inner(connection, input, context)
}

fn persist_yjs_commit_inner(
    connection: &Connection,
    input: PersistYjsCommit<'_>,
    context: &CommitContext,
) -> Result<PersistedDocumentCommit, StoreError> {
    let next_head_seq = input
        .authority
        .head
        .head_seq
        .checked_add(1)
        .ok_or_else(|| {
            StoreError::new(
                StoreErrorCode::Internal,
                "Document head sequence overflowed",
                false,
            )
        })?;
    let now = sqlite_now(connection)?;
    let page_file_body_usage_changed = if input.authority.owner_type == "page" {
        let owned_file_ids = owned_page_file_ids(connection, input.authority)?;
        page_file_body_usage_counts(input.base_materialization, &owned_file_ids)
            != page_file_body_usage_counts(input.materialization, &owned_file_ids)
    } else {
        false
    };
    let placement_delta =
        derive_document_placement_delta(input.base_materialization, input.materialization);
    let derived_touched_block_ids = derive_touched_block_ids(
        &input.authority.owner_block_id,
        input.base_materialization,
        input.materialization,
        &placement_delta,
    );
    validate_document_references(
        connection,
        &input.authority.head.library_id,
        input.actor_project_id,
        input.materialization,
        false,
    )?;
    validate_page_file_placements(
        connection,
        input.authority,
        input.actor_project_id,
        Some(input.base_materialization),
        input.materialization,
        input.placement.page_file_placements_prevalidated,
    )?;
    let reconciled_blocks = reconcile_document_blocks(
        connection,
        ReconcileDocumentBlocksInput {
            context,
            authority: input.authority,
            base_materialization: Some(input.base_materialization),
            materialization: input.materialization,
            placement: input.placement,
            derived_placement: &placement_delta,
            projected_seq: next_head_seq,
            now: &now,
        },
    )?;
    persist_materialization(
        connection,
        &input.authority.head.id,
        input.authority.head.generation,
        next_head_seq,
        input.materialization,
        &now,
    )?;
    let client_touched_json = serde_json::to_string(input.client_touched_block_ids)
        .map_err(|_| internal("Client touched Block IDs could not be encoded"))?;
    let derived_touched_json = serde_json::to_string(&derived_touched_block_ids)
        .map_err(|_| internal("Derived touched Block IDs could not be encoded"))?;
    let update_hash = sha256(input.update);
    connection.execute(
        "INSERT INTO document_update_receipts (\
           document_id, generation, seq, update_id, client_session_id, base_head_seq, \
           client_touched_block_ids_json, derived_touched_block_ids_json, derivation_version, \
           update_hash, update_byte_length, committed_at\
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, ?9, ?10, ?11)",
        params![
            input.authority.head.id,
            input.authority.head.generation,
            next_head_seq,
            input.update_id,
            input.client_session_id,
            input.base_head_seq,
            client_touched_json,
            derived_touched_json,
            update_hash,
            i64::try_from(input.update.len()).map_err(|_| internal("Update length overflow"))?,
            now,
        ],
    )?;
    connection.execute(
        "INSERT INTO document_updates (\
           document_id, generation, seq, update_id, client_session_id, base_head_seq, \
           touched_block_ids_json, update_blob, update_hash, committed_at\
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            input.authority.head.id,
            input.authority.head.generation,
            next_head_seq,
            input.update_id,
            input.client_session_id,
            input.base_head_seq,
            derived_touched_json,
            input.update,
            update_hash,
            now,
        ],
    )?;
    local_commit::record_document_effect(
        connection,
        context,
        RegisteredDocumentEffect {
            project_id: input.actor_project_id,
            page_id: (input.authority.owner_type == "page")
                .then_some(input.authority.owner_block_id.as_str()),
            document_id: &input.authority.head.id,
            generation: input.authority.head.generation,
            base_head_seq: input.base_head_seq,
            head_seq: next_head_seq,
            update_id: input.update_id,
            update_hash: &update_hash,
            update_byte_length: i64::try_from(input.update.len())
                .map_err(|_| internal("Update length overflow"))?,
        },
    )?;
    let changed = connection.execute(
        "UPDATE documents SET head_seq = ?1, state_vector = ?2, state_hash = '', updated_at = ?3 \
         WHERE id = ?4 AND generation = ?5 AND head_seq = ?6 \
           AND readiness = 'ready' AND authority = 'ydoc_primary' AND sync_engine = 'yjs'",
        params![
            next_head_seq,
            input.state_vector,
            now,
            input.authority.head.id,
            input.authority.head.generation,
            input.authority.head.head_seq,
        ],
    )?;
    if changed != 1 {
        return Err(conflict("Document head advanced before commit"));
    }
    if !input.write_fence_block_ids.is_empty()
        || input.title_write_fence_required
        || input.document_write_fence_required
    {
        let mut block_ids = input.write_fence_block_ids.to_vec();
        block_ids.sort();
        block_ids.dedup();
        connection.execute(
            "INSERT INTO document_structural_barriers (\
               document_id, generation, head_seq, operation_id, block_ids_json, \
               title_fence, document_wide_fence, committed_at\
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                input.authority.head.id,
                input.authority.head.generation,
                next_head_seq,
                input.operation_id,
                serde_json::to_string(&block_ids)
                    .map_err(|_| internal("Structural barrier Block IDs"))?,
                i64::from(input.title_write_fence_required),
                i64::from(input.document_write_fence_required),
                now,
            ],
        )?;
    }
    replace_secondary_projections(
        connection,
        input.authority,
        input.materialization,
        next_head_seq,
        &now,
        true,
    )?;
    if page_file_body_usage_changed {
        advance_page_file_body_usage_revision(connection, input.authority, &now)?;
    }
    let payload = json!({
        "module": "owned_document",
        "kind": input.event_kind,
        "documentId": input.authority.head.id,
        "generation": input.authority.head.generation,
        "headSeq": next_head_seq,
        "updateId": input.update_id,
        "updateHash": update_hash,
        "updateByteLength": input.update.len(),
        "localCommitId": input.local_commit_id,
        "pageFileBodyUsageChanged": page_file_body_usage_changed,
    });
    let page_impact = input.authority.page_impact();
    let owner_projection_impact = impact_for_page_document(
        page_impact.as_ref(),
        Some((
            &input.authority.head.id,
            input.authority.head.generation,
            next_head_seq,
        )),
    )?;
    let nested_page_placement_changed = !reconciled_blocks.placement_changed_page_ids.is_empty();
    let nested_page_projection_impact = if !nested_page_placement_changed {
        ProjectionImpact::None
    } else {
        ProjectionImpact::Resources {
            page_ids: reconciled_blocks.placement_changed_page_ids,
            database_ids: Vec::new(),
            data_source_ids: Vec::new(),
            view_ids: Vec::new(),
            document_heads: Vec::new(),
        }
    };
    let projection_impact = local_commit::merge_projection_impact(
        owner_projection_impact,
        nested_page_projection_impact,
    )?;
    let projection_impact = local_commit::merge_projection_impact(
        projection_impact,
        page_reference_target_impact(&[
            &input.base_materialization.references,
            &input.materialization.references,
        ]),
    )?;
    let projection_impact = if input.base_materialization.title != input.materialization.title
        || input.base_materialization.rich_title != input.materialization.rich_title
        || nested_page_placement_changed
    {
        expand_database_coordinates(connection, projection_impact)?
    } else {
        projection_impact
    };
    let database_ids = page_impact
        .as_ref()
        .and_then(|impact| impact.database.as_ref())
        .map(|database| vec![database.database_id.clone()])
        .unwrap_or_default();
    let document_ids = vec![input.authority.head.id.clone()];
    let payload_json =
        serde_json::to_string(&payload).map_err(|_| internal("Document event payload"))?;
    let kind = format!("owned_document.{}", input.event_kind);
    let entry = NewChangeLogEntry {
        project_id: input.actor_project_id,
        store_epoch: input.store_epoch,
        kind: &kind,
        operation_id: Some(input.operation_id),
        block_ids: &derived_touched_block_ids,
        document_ids: &document_ids,
        database_block_ids: &database_ids,
        payload_json: &payload_json,
        projection_impact: &projection_impact,
        committed_at: &now,
    };
    let event_sequence = append_change_log(connection, entry, context)?;
    Ok(PersistedDocumentCommit {
        head_seq: next_head_seq,
        state_vector: input.state_vector.to_vec(),
        derived_touched_block_ids,
        event_sequence,
        committed_at: now,
    })
}

#[cfg(test)]
pub(crate) fn persist_yjs_genesis(
    connection: &Connection,
    input: PersistYjsGenesis<'_>,
) -> Result<PersistedDocumentCommit, StoreError> {
    let intent_hash =
        sha256(format!("{}\0{}", input.operation_id, sha256(input.update)).as_bytes());
    let context = local_commit::begin(
        connection,
        input.store_epoch,
        input.operation_id,
        &intent_hash,
        &sqlite_now(connection)?,
    )?;
    let page_projection_required = input.emit_event;
    let persisted =
        persist_yjs_genesis_inner(connection, input, &context, page_projection_required)?;
    record_internal_receipt(connection, &context, &intent_hash)?;
    local_commit::finalize(connection, &context)?;
    Ok(persisted)
}

pub(crate) fn persist_yjs_genesis_with_local_commit(
    connection: &Connection,
    input: PersistYjsGenesis<'_>,
    context: &CommitContext,
) -> Result<PersistedDocumentCommit, StoreError> {
    // Page-parent promotion inserts its page read model immediately after
    // genesis. The durable event is part of the parent LocalCommit, but the
    // projection check belongs to that caller's explicit read-model write.
    persist_yjs_genesis_inner(connection, input, context, false)
}

fn persist_yjs_genesis_inner(
    connection: &Connection,
    input: PersistYjsGenesis<'_>,
    context: &CommitContext,
    page_projection_required: bool,
) -> Result<PersistedDocumentCommit, StoreError> {
    if input.authority.head.generation < 1
        || input.authority.head.head_seq != 0
        || input.authority.head.readiness
            != crate::infrastructure::document_repository::DocumentReadiness::PendingGenesis
        || input.authority.head.authority
            != crate::infrastructure::document_repository::DocumentAuthority::LegacyShadow
        || input.authority.head.sync_engine
            != crate::infrastructure::document_repository::DocumentSyncEngine::Yjs
    {
        return Err(StoreError::new(
            StoreErrorCode::Conflict,
            "Owned Document is not a pending Yjs genesis authority",
            false,
        ));
    }
    let now = sqlite_now(connection)?;
    let page_file_body_usage_changed = if input.authority.owner_type == "page" {
        let owned_file_ids = owned_page_file_ids(connection, input.authority)?;
        !page_file_body_usage_counts(input.materialization, &owned_file_ids).is_empty()
    } else {
        false
    };
    validate_document_references(
        connection,
        &input.authority.head.library_id,
        input.actor_project_id,
        input.materialization,
        false,
    )?;
    validate_page_file_placements(
        connection,
        input.authority,
        input.actor_project_id,
        None,
        input.materialization,
        input.placement.page_file_placements_prevalidated,
    )?;
    reconcile_document_blocks(
        connection,
        ReconcileDocumentBlocksInput {
            context,
            authority: input.authority,
            base_materialization: None,
            materialization: input.materialization,
            placement: input.placement,
            derived_placement: &DocumentPlacementDelta::default(),
            projected_seq: 1,
            now: &now,
        },
    )?;
    persist_materialization(
        connection,
        &input.authority.head.id,
        input.authority.head.generation,
        1,
        input.materialization,
        &now,
    )?;
    let derived_touched_block_ids = std::iter::once(input.authority.owner_block_id.clone())
        .chain(
            input
                .materialization
                .search_units
                .iter()
                .map(|unit| unit.block_id.clone()),
        )
        .collect::<Vec<_>>();
    let derived_touched_json = serde_json::to_string(&derived_touched_block_ids)
        .map_err(|_| internal("Genesis touched Block IDs"))?;
    let update_hash = sha256(input.update);
    connection.execute(
        "INSERT INTO document_update_receipts (\
           document_id, generation, seq, update_id, client_session_id, base_head_seq, \
           client_touched_block_ids_json, derived_touched_block_ids_json, derivation_version, \
           update_hash, update_byte_length, committed_at\
         ) VALUES (?1, ?2, 1, ?3, ?4, 0, '[]', ?5, 1, ?6, ?7, ?8)",
        params![
            input.authority.head.id,
            input.authority.head.generation,
            input.update_id,
            input.client_session_id,
            derived_touched_json,
            update_hash,
            i64::try_from(input.update.len()).map_err(|_| internal("Genesis update length"))?,
            now,
        ],
    )?;
    connection.execute(
        "INSERT INTO document_updates (\
           document_id, generation, seq, update_id, client_session_id, base_head_seq, \
           touched_block_ids_json, update_blob, update_hash, committed_at\
         ) VALUES (?1, ?2, 1, ?3, ?4, 0, ?5, ?6, ?7, ?8)",
        params![
            input.authority.head.id,
            input.authority.head.generation,
            input.update_id,
            input.client_session_id,
            derived_touched_json,
            input.update,
            update_hash,
            now,
        ],
    )?;
    local_commit::record_document_effect(
        connection,
        context,
        RegisteredDocumentEffect {
            project_id: input.actor_project_id,
            page_id: (input.authority.owner_type == "page")
                .then_some(input.authority.owner_block_id.as_str()),
            document_id: &input.authority.head.id,
            generation: input.authority.head.generation,
            base_head_seq: 0,
            head_seq: 1,
            update_id: input.update_id,
            update_hash: &update_hash,
            update_byte_length: i64::try_from(input.update.len())
                .map_err(|_| internal("Genesis update length"))?,
        },
    )?;
    let snapshot_hash = sha256(input.full_state);
    connection.execute(
        "INSERT INTO document_snapshots (\
           document_id, generation, snapshot_seq, state_vector, snapshot_update, \
           snapshot_hash, schema_version, created_at\
         ) VALUES (?1, ?2, 1, ?3, ?4, ?5, ?6, ?7)",
        params![
            input.authority.head.id,
            input.authority.head.generation,
            input.state_vector,
            input.full_state,
            snapshot_hash,
            input.authority.head.schema_version,
            now,
        ],
    )?;
    let changed = connection.execute(
        "UPDATE documents SET head_seq = 1, state_vector = ?1, state_hash = '', \
           readiness = 'ready', authority = 'ydoc_primary', updated_at = ?2 \
         WHERE id = ?3 AND generation = ?4 AND head_seq = 0 \
           AND readiness = 'pending_genesis' AND authority = 'legacy_shadow' \
           AND sync_engine = 'yjs'",
        params![
            input.state_vector,
            now,
            input.authority.head.id,
            input.authority.head.generation,
        ],
    )?;
    if changed != 1 {
        return Err(conflict("Document genesis authority changed before commit"));
    }
    replace_secondary_projections(
        connection,
        input.authority,
        input.materialization,
        1,
        &now,
        page_projection_required,
    )?;
    if page_file_body_usage_changed {
        advance_page_file_body_usage_revision(connection, input.authority, &now)?;
    }
    let event_sequence = if input.emit_event {
        let payload = json!({
            "module": "owned_document",
            "kind": "document_initialized",
            "documentId": input.authority.head.id,
            "generation": input.authority.head.generation,
            "headSeq": 1,
            "updateId": input.update_id,
            "updateHash": update_hash,
            "updateByteLength": input.update.len(),
            "pageFileBodyUsageChanged": page_file_body_usage_changed,
        });
        let page_impact = input.authority.page_impact();
        let projection_impact = impact_for_page_document(
            page_impact.as_ref(),
            Some((&input.authority.head.id, input.authority.head.generation, 1)),
        )?;
        let projection_impact = local_commit::merge_projection_impact(
            projection_impact,
            page_reference_target_impact(&[&input.materialization.references]),
        )?;
        let database_ids = page_impact
            .as_ref()
            .and_then(|impact| impact.database.as_ref())
            .map(|database| vec![database.database_id.clone()])
            .unwrap_or_default();
        let document_ids = vec![input.authority.head.id.clone()];
        let payload_json =
            serde_json::to_string(&payload).map_err(|_| internal("Genesis event payload"))?;
        let entry = NewChangeLogEntry {
            project_id: input.actor_project_id,
            store_epoch: input.store_epoch,
            kind: "owned_document.document_initialized",
            operation_id: Some(input.operation_id),
            block_ids: &derived_touched_block_ids,
            document_ids: &document_ids,
            database_block_ids: &database_ids,
            payload_json: &payload_json,
            projection_impact: &projection_impact,
            committed_at: &now,
        };
        append_change_log(connection, entry, context)?
    } else {
        connection.query_row("SELECT COALESCE(MAX(seq), 0) FROM change_log", [], |row| {
            row.get(0)
        })?
    };
    Ok(PersistedDocumentCommit {
        head_seq: 1,
        state_vector: input.state_vector.to_vec(),
        derived_touched_block_ids,
        event_sequence,
        committed_at: now,
    })
}

struct ReconcileDocumentBlocksInput<'a> {
    context: &'a CommitContext,
    authority: &'a DocumentAuthorityRow,
    base_materialization: Option<&'a DocumentMaterialization>,
    materialization: &'a DocumentMaterialization,
    placement: DocumentPlacementEvidence<'a>,
    derived_placement: &'a DocumentPlacementDelta,
    projected_seq: i64,
    now: &'a str,
}

fn reconcile_document_blocks(
    connection: &Connection,
    input: ReconcileDocumentBlocksInput<'_>,
) -> Result<ReconciledDocumentBlocks, StoreError> {
    let ReconcileDocumentBlocksInput {
        context,
        authority,
        base_materialization,
        materialization,
        placement,
        derived_placement,
        projected_seq,
        now,
    } = input;
    assert_typed_owner_shells_are_childless(&materialization.search_units)?;
    if matches!(
        placement.reorder_attribution,
        DocumentReorderAttribution::Conservative
    ) && let Some(base_materialization) = base_materialization
    {
        assert_generic_placement_preserves_typed_owner_subtrees(
            &base_materialization.search_units,
            derived_placement,
        )?;
    }
    let mut placement_changed_page_ids = HashSet::new();
    let existing = connection
        .prepare(
            "SELECT block.id, block.type, block.lifecycle \
             FROM document_block_index entry \
             JOIN blocks block ON block.id = entry.block_id \
             WHERE entry.document_id = ?1 ORDER BY block.id",
        )?
        .query_map([&authority.head.id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|_| corrupt("Document Block registry has invalid column types"))?;
    let existing_ids = existing
        .iter()
        .map(|row| row.0.clone())
        .collect::<HashSet<_>>();
    let active_ids = materialization
        .search_units
        .iter()
        .map(|unit| unit.block_id.clone())
        .collect::<HashSet<_>>();
    let placement_geneses = placement
        .placement_genesis_block_ids
        .iter()
        .map(String::as_str)
        .collect::<HashSet<_>>();
    let placement_preapplied = placement
        .placement_preapplied_block_ids
        .iter()
        .map(String::as_str)
        .collect::<HashSet<_>>();
    let placement_advances = placement
        .placement_advance_block_ids
        .iter()
        .map(String::as_str)
        .collect::<HashSet<_>>();
    let tombstone_reactivations = placement
        .tombstone_reactivation
        .map(|reactivation| {
            reactivation
                .block_ids
                .iter()
                .map(String::as_str)
                .collect::<HashSet<_>>()
        })
        .unwrap_or_default();
    let exact_moves = match placement.reorder_attribution {
        DocumentReorderAttribution::Conservative => None,
        DocumentReorderAttribution::Exact(block_ids) => {
            Some(block_ids.iter().map(String::as_str).collect::<HashSet<_>>())
        }
    };
    if let Some(exact_moves) = exact_moves.as_ref()
        && let Some(base_materialization) = base_materialization
        && !exact_moves_explain_document_placement(
            base_materialization,
            materialization,
            exact_moves,
        )
    {
        return Err(invalid(
            "Typed Document update changed placement outside its declared move roots".to_owned(),
        ));
    }
    let mut consumed_geneses = HashSet::new();
    let mut consumed_preapplied = HashSet::new();
    let mut consumed_advances = HashSet::new();
    let mut consumed_tombstone_reactivations = HashSet::new();
    if placement_geneses
        .iter()
        .any(|block_id| !active_ids.contains(*block_id))
    {
        return Err(invalid(
            "Placement genesis must name an active Block in the resulting Document".to_owned(),
        ));
    }

    for unit in &materialization.search_units {
        let registered = connection
            .query_row(
                "SELECT block.library_id, block.type, block.lifecycle, \
                        block.placement_revision, \
                        entry.document_id, \
                        placement.block_id IS NOT NULL, \
                        tombstone.document_id, tombstone.document_generation, \
                        tombstone.placement_revision \
                 FROM blocks block \
                 LEFT JOIN document_block_index entry ON entry.block_id = block.id \
                 LEFT JOIN library_block_placements placement ON placement.block_id = block.id \
                 LEFT JOIN document_block_tombstones tombstone \
                   ON tombstone.block_id = block.id \
                 WHERE block.id = ?1",
                [&unit.block_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, bool>(5)?,
                        row.get::<_, Option<String>>(6)?,
                        row.get::<_, Option<i64>>(7)?,
                        row.get::<_, Option<i64>>(8)?,
                    ))
                },
            )
            .optional()
            .map_err(|_| corrupt("Registered Block row has invalid column types"))?;
        match registered {
            None => {
                let retired = connection
                    .query_row(
                        "SELECT 1 FROM retired_block_identities WHERE block_id = ?1",
                        [&unit.block_id],
                        |_| Ok(()),
                    )
                    .optional()?
                    .is_some();
                if retired {
                    return Err(invalid(format!(
                        "Retired Block identity {} cannot be recreated",
                        unit.block_id
                    )));
                }
                if TYPED_CREATION_BLOCK_TYPES.contains(&unit.block_type.as_str()) {
                    return Err(protected_owner_mutation(format!(
                        "Block {} requires a typed creation operation",
                        unit.block_id
                    )));
                }
                if !is_uuid_v7(&unit.block_id) {
                    return Err(invalid(format!(
                        "Block {} requires a typed creation operation",
                        unit.block_id
                    )));
                }
                connection.execute(
                    "INSERT INTO blocks( \
                       id, library_id, type, lifecycle, placement_revision, \
                       metadata_revision, created_at, updated_at \
                     ) VALUES (?1, ?2, ?3, 'active', 1, 1, ?4, ?4)",
                    params![
                        unit.block_id,
                        authority.head.library_id,
                        unit.block_type,
                        now,
                    ],
                )?;
            }
            Some((
                library_id,
                block_type,
                lifecycle,
                placement_revision,
                document_id,
                is_library_root,
                tombstone_document_id,
                tombstone_document_generation,
                tombstone_placement_revision,
            )) => {
                if library_id != authority.head.library_id
                    || document_id
                        .as_deref()
                        .is_some_and(|document_id| document_id != authority.head.id)
                    || is_library_root
                {
                    return Err(invalid(format!(
                        "Block {} belongs to another authority",
                        unit.block_id
                    )));
                }
                let placement_genesis = placement_geneses.contains(unit.block_id.as_str());
                let placement_was_preapplied =
                    placement_preapplied.contains(unit.block_id.as_str());
                let placement_advances_here = placement_advances.contains(unit.block_id.as_str());
                if usize::from(placement_genesis)
                    + usize::from(placement_was_preapplied)
                    + usize::from(placement_advances_here)
                    > 1
                {
                    return Err(invalid(format!(
                        "Block {} has conflicting placement intents",
                        unit.block_id
                    )));
                }
                if placement_genesis
                    && (placement_revision != 1
                        || document_id.is_some()
                        || is_library_root
                        || lifecycle != "active")
                {
                    return Err(invalid(format!(
                        "Block {} is not eligible for placement genesis",
                        unit.block_id
                    )));
                }
                if block_type != unit.block_type
                    && (TYPED_CREATION_BLOCK_TYPES.contains(&block_type.as_str())
                        || TYPED_CREATION_BLOCK_TYPES.contains(&unit.block_type.as_str()))
                {
                    return Err(protected_owner_mutation(format!(
                        "Block {} requires a typed reclassification",
                        unit.block_id
                    )));
                }
                let typed_resource = TYPED_CREATION_BLOCK_TYPES.contains(&block_type.as_str());
                let attached_from_another_authority =
                    document_id.as_deref() != Some(&authority.head.id);
                let exact_tombstone_reactivation =
                    placement
                        .tombstone_reactivation
                        .is_some_and(|reactivation| {
                            tombstone_reactivations.contains(unit.block_id.as_str())
                                && attached_from_another_authority
                                && lifecycle == "deleted"
                                && !typed_resource
                                && tombstone_document_id.as_deref()
                                    == Some(reactivation.source_document_id)
                                && tombstone_document_generation
                                    == Some(reactivation.source_document_generation)
                                && tombstone_placement_revision == Some(placement_revision)
                        });
                let reactivating_from_last_document = placement.allow_last_document_reactivation
                    && attached_from_another_authority
                    && lifecycle == "deleted"
                    && !typed_resource
                    && tombstone_document_id.as_deref() == Some(&authority.head.id)
                    && tombstone_document_generation == Some(authority.head.generation)
                    && tombstone_placement_revision == Some(placement_revision);
                let reactivating_from_tombstone =
                    exact_tombstone_reactivation || reactivating_from_last_document;
                if lifecycle != "active"
                    && attached_from_another_authority
                    && !reactivating_from_tombstone
                {
                    return Err(invalid(format!(
                        "Deleted Block {} requires exact tombstone restore evidence",
                        unit.block_id
                    )));
                }
                let parent_changed = derived_placement
                    .parent_changed_block_ids
                    .contains(&unit.block_id);
                let reordered = derived_placement
                    .reordered_block_ids
                    .contains(&unit.block_id);
                let exact_move = exact_moves
                    .as_ref()
                    .is_some_and(|block_ids| block_ids.contains(unit.block_id.as_str()));
                let attributed_reorder = reordered
                    && match exact_moves.as_ref() {
                        None => true,
                        Some(_) => exact_move,
                    };
                if attached_from_another_authority
                    && !placement_genesis
                    && !placement_was_preapplied
                    && !placement_advances_here
                    && !reactivating_from_tombstone
                {
                    return Err(invalid(format!(
                        "Block {} attached without a cross-authority placement intent",
                        unit.block_id
                    )));
                }
                let local_placement_changed = parent_changed || attributed_reorder;
                let placement_changed = attached_from_another_authority || local_placement_changed;
                let placement_revision_advances =
                    placement_changed && !placement_genesis && !placement_was_preapplied;
                if placement_genesis {
                    consumed_geneses.insert(unit.block_id.as_str());
                }
                if placement_was_preapplied && placement_changed {
                    consumed_preapplied.insert(unit.block_id.as_str());
                }
                if placement_advances_here && attached_from_another_authority {
                    consumed_advances.insert(unit.block_id.as_str());
                }
                if exact_tombstone_reactivation {
                    consumed_tombstone_reactivations.insert(unit.block_id.as_str());
                }
                if (lifecycle != "active" && !typed_resource)
                    || block_type != unit.block_type
                    || placement_changed
                {
                    connection.execute(
                        "UPDATE blocks SET type = ?1, \
                           lifecycle = CASE WHEN ?2 THEN lifecycle ELSE 'active' END, \
                           metadata_revision = metadata_revision + CASE \
                             WHEN type <> ?1 OR (lifecycle <> 'active' AND NOT ?2) THEN 1 ELSE 0 END, \
                           placement_revision = placement_revision + CASE WHEN ?3 THEN 1 ELSE 0 END, \
                           updated_at = ?4 \
                         WHERE id = ?5 AND library_id = ?6",
                        params![
                            unit.block_type,
                            typed_resource,
                            placement_revision_advances,
                            now,
                            unit.block_id,
                            authority.head.library_id,
                        ],
                    )?;
                }
                if block_type == "page" && local_placement_changed {
                    let changed = connection.execute(
                        "UPDATE page_read_model SET \
                           placement_revision = ( \
                             SELECT placement_revision FROM blocks WHERE id = ?1 \
                           ), updated_at = ?2 \
                         WHERE page_block_id = ?1",
                        params![unit.block_id, now],
                    )?;
                    if changed != 1 {
                        return Err(corrupt(&format!(
                            "Page {} lost its placement projection",
                            unit.block_id
                        )));
                    }
                    placement_changed_page_ids.insert(unit.block_id.clone());
                }
                if reactivating_from_tombstone {
                    let (source_document_id, source_document_generation) = placement
                        .tombstone_reactivation
                        .filter(|_| exact_tombstone_reactivation)
                        .map(|reactivation| {
                            (
                                reactivation.source_document_id,
                                reactivation.source_document_generation,
                            )
                        })
                        .unwrap_or((&authority.head.id, authority.head.generation));
                    let removed = connection.execute(
                        "DELETE FROM document_block_tombstones \
                         WHERE block_id = ?1 AND document_id = ?2 AND document_generation = ?3 \
                           AND placement_revision = ?4",
                        params![
                            unit.block_id,
                            source_document_id,
                            source_document_generation,
                            placement_revision,
                        ],
                    )?;
                    if removed != 1 {
                        return Err(conflict("Document Block tombstone changed before restore"));
                    }
                }
            }
        }
    }

    let structural_detaches = placement
        .structurally_detached_block_ids
        .iter()
        .map(String::as_str)
        .collect::<HashSet<_>>();
    for detached_id in &structural_detaches {
        let valid = base_materialization.is_some_and(|base| {
            base.search_units
                .iter()
                .any(|unit| unit.block_id == *detached_id)
        }) && !active_ids.contains(*detached_id);
        if !valid {
            return Err(invalid(format!(
                "Structural detach {detached_id} is not an absent source Block"
            )));
        }
    }
    local_commit::register_relocation_obligations(
        connection,
        context,
        &authority.head.id,
        placement.structurally_detached_block_ids,
    )?;
    let require_exact_consumption = |declared: &HashSet<&str>,
                                     consumed: &HashSet<&str>,
                                     label: &str|
     -> Result<(), StoreError> {
        if declared == consumed {
            return Ok(());
        }
        Err(invalid(format!(
            "Document placement {label} evidence does not match the canonical transition"
        )))
    };
    require_exact_consumption(&placement_geneses, &consumed_geneses, "genesis")?;
    require_exact_consumption(&placement_preapplied, &consumed_preapplied, "preapplied")?;
    require_exact_consumption(&placement_advances, &consumed_advances, "advance")?;
    require_exact_consumption(
        &tombstone_reactivations,
        &consumed_tombstone_reactivations,
        "tombstone reactivation",
    )?;
    for (block_id, block_type, lifecycle) in &existing {
        if active_ids.contains(block_id) {
            continue;
        }
        if TYPED_CREATION_BLOCK_TYPES.contains(&block_type.as_str())
            && lifecycle != "deleted"
            && !structural_detaches.contains(block_id.as_str())
        {
            return Err(protected_owner_mutation(format!(
                "Typed owner Block {block_id} cannot be removed by a generic Document update"
            )));
        }
    }
    connection.execute(
        "DELETE FROM document_block_index WHERE document_id = ?1",
        [&authority.head.id],
    )?;
    for block_id in existing_ids.difference(&active_ids) {
        if structural_detaches.contains(block_id.as_str()) {
            continue;
        }
        let (_, block_type, lifecycle) = existing
            .iter()
            .find(|row| row.0 == *block_id)
            .ok_or_else(|| corrupt("Deleted Document Block lost its registry row"))?;
        if TYPED_CREATION_BLOCK_TYPES.contains(&block_type.as_str()) && lifecycle == "deleted" {
            continue;
        }
        let changed = connection.execute(
            "UPDATE blocks SET lifecycle = 'deleted', placement_revision = placement_revision + 1, \
               metadata_revision = metadata_revision + 1, \
               updated_at = ?1 WHERE id = ?2 AND library_id = ?3 AND lifecycle <> 'deleted'",
            params![now, block_id, authority.head.library_id],
        )?;
        if changed != 1 {
            return Err(corrupt(&format!(
                "Document Block {block_id} deletion did not advance its lifecycle"
            )));
        }
        if !TYPED_CREATION_BLOCK_TYPES.contains(&block_type.as_str()) {
            connection.execute(
                "INSERT INTO document_block_tombstones( \
                   block_id, library_id, document_id, document_generation, \
                   deletion_head_seq, placement_revision, deleted_at \
                 ) SELECT id, library_id, ?1, ?2, ?3, placement_revision, ?4 \
                   FROM blocks WHERE id = ?5 AND library_id = ?6",
                params![
                    authority.head.id,
                    authority.head.generation,
                    projected_seq,
                    now,
                    block_id,
                    authority.head.library_id,
                ],
            )?;
        }
    }
    for unit in &materialization.search_units {
        connection.execute(
            "INSERT INTO document_block_index ( \
               document_id, block_id, parent_block_id, ordinal, block_type, text, projected_seq \
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                authority.head.id,
                unit.block_id,
                unit.parent_block_id,
                i64::try_from(unit.ordinal).map_err(|_| internal("Block ordinal overflow"))?,
                unit.block_type,
                unit.text,
                projected_seq,
            ],
        )?;
    }
    let mut placement_changed_page_ids = placement_changed_page_ids.into_iter().collect::<Vec<_>>();
    placement_changed_page_ids.sort();
    Ok(ReconciledDocumentBlocks {
        placement_changed_page_ids,
    })
}

fn assert_typed_owner_shells_are_childless(
    search_units: &[DocumentBlockSearchUnit],
) -> Result<(), StoreError> {
    let typed_owner_ids = search_units
        .iter()
        .filter(|unit| TYPED_CREATION_BLOCK_TYPES.contains(&unit.block_type.as_str()))
        .map(|unit| unit.block_id.as_str())
        .collect::<HashSet<_>>();
    let illegal_parent = search_units.iter().find_map(|unit| {
        unit.parent_block_id
            .as_deref()
            .filter(|parent_id| typed_owner_ids.contains(parent_id))
    });
    let Some(parent_id) = illegal_parent else {
        return Ok(());
    };
    Err(protected_owner_mutation(format!(
        "Typed owner Block {parent_id} cannot contain child Blocks"
    )))
}

fn assert_generic_placement_preserves_typed_owner_subtrees(
    base: &[DocumentBlockSearchUnit],
    placement: &DocumentPlacementDelta,
) -> Result<(), StoreError> {
    let moved_block_ids = placement
        .parent_changed_block_ids
        .iter()
        .chain(&placement.reordered_block_ids)
        .map(String::as_str)
        .collect::<HashSet<_>>();
    if moved_block_ids.is_empty() {
        return Ok(());
    }
    let parents = base
        .iter()
        .map(|unit| (unit.block_id.as_str(), unit.parent_block_id.as_deref()))
        .collect::<HashMap<_, _>>();
    let moved_owner_roots = base
        .iter()
        .filter(|unit| TYPED_CREATION_BLOCK_TYPES.contains(&unit.block_type.as_str()))
        .filter_map(|unit| {
            let mut candidate = Some(unit.block_id.as_str());
            while let Some(block_id) = candidate {
                if moved_block_ids.contains(block_id) {
                    return Some(block_id);
                }
                candidate = parents.get(block_id).copied().flatten();
            }
            None
        })
        .collect::<HashSet<_>>();
    if moved_owner_roots.is_empty() {
        return Ok(());
    }
    let mut moved_owner_roots = moved_owner_roots.into_iter().collect::<Vec<_>>();
    moved_owner_roots.sort_unstable();
    Err(protected_owner_mutation(format!(
        "Generic Document update cannot move Block subtree(s) containing typed owners: {}",
        moved_owner_roots.join(", ")
    )))
}

#[cfg(test)]
fn record_internal_receipt(
    connection: &Connection,
    context: &local_commit::CommitContext,
    result_hash: &str,
) -> Result<(), StoreError> {
    local_commit::record_receipt(
        connection,
        context,
        &nodex_core_contracts::LocalCommitReceiptRef {
            module: nodex_core_contracts::ModuleName::OwnedDocument,
            operation_id: context.operation_id().to_owned(),
            result_hash: result_hash.to_owned(),
        },
    )
}

fn persist_materialization_row(
    connection: &Connection,
    document_id: &str,
    generation: i64,
    projected_seq: i64,
    materialization: &DocumentMaterialization,
    now: &str,
) -> Result<(), StoreError> {
    let rich_title_json = serde_json::to_string(&materialization.rich_title)
        .map_err(|_| internal("Rich title JSON"))?;
    let rich_title_hash = sha256(rich_title_json.as_bytes());
    let block_tree_json = serde_json::to_string(&materialization.block_tree)
        .map_err(|_| internal("Block tree JSON"))?;
    let references_json = serde_json::to_string(&materialization.references)
        .map_err(|_| internal("Reference JSON"))?;
    let asset_refs_json = serde_json::to_string(&materialization.asset_refs)
        .map_err(|_| internal("Asset reference JSON"))?;
    connection.execute(
        "INSERT INTO document_materializations (\
           document_id, generation, projected_seq, schema_version, \
           materialization_derivation_version, title, title_rich_json, title_rich_hash, \
           nfm, plain_text, preview, block_tree_json, references_json, asset_refs_json, \
           updated_at\
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15) \
         ON CONFLICT(document_id) DO UPDATE SET \
           generation = excluded.generation, projected_seq = excluded.projected_seq, \
           schema_version = excluded.schema_version, \
           materialization_derivation_version = excluded.materialization_derivation_version, \
           title = excluded.title, title_rich_json = excluded.title_rich_json, \
           title_rich_hash = excluded.title_rich_hash, nfm = excluded.nfm, \
           plain_text = excluded.plain_text, preview = excluded.preview, \
           block_tree_json = excluded.block_tree_json, \
           references_json = excluded.references_json, asset_refs_json = excluded.asset_refs_json, \
           updated_at = excluded.updated_at",
        params![
            document_id,
            generation,
            projected_seq,
            materialization.schema_version,
            CURRENT_DOCUMENT_MATERIALIZATION_DERIVATION_VERSION,
            materialization.title,
            rich_title_json,
            rich_title_hash,
            materialization.nfm,
            materialization.plain_text,
            materialization.preview,
            block_tree_json,
            references_json,
            asset_refs_json,
            now,
        ],
    )?;
    Ok(())
}

pub(crate) fn persist_materialization(
    connection: &Connection,
    document_id: &str,
    generation: i64,
    projected_seq: i64,
    materialization: &DocumentMaterialization,
    now: &str,
) -> Result<(), StoreError> {
    persist_materialization_row(
        connection,
        document_id,
        generation,
        projected_seq,
        materialization,
        now,
    )?;
    replace_page_reference_projection(connection, document_id, &materialization.references, now)
}

/// Rebuilds a schema-derived materialization without turning retained, unowned
/// recovery Documents back into visible reference sources. Their full
/// materialization remains durable for Undo/restore; only owner-scoped reverse
/// reference projection is absent until ownership is restored.
pub(crate) fn persist_materialization_for_schema_migration(
    connection: &Connection,
    document_id: &str,
    generation: i64,
    projected_seq: i64,
    materialization: &DocumentMaterialization,
    now: &str,
) -> Result<(), StoreError> {
    persist_materialization_row(
        connection,
        document_id,
        generation,
        projected_seq,
        materialization,
        now,
    )?;
    let has_owner = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM block_documents WHERE document_id = ?1)",
        [document_id],
        |row| row.get::<_, bool>(0),
    )?;
    if has_owner {
        return replace_page_reference_projection(
            connection,
            document_id,
            &materialization.references,
            now,
        );
    }
    connection.execute(
        "DELETE FROM document_page_references WHERE document_id = ?1",
        [document_id],
    )?;
    Ok(())
}

pub(crate) fn replace_document_block_index_for_schema_migration(
    connection: &Connection,
    document_id: &str,
    projected_seq: i64,
    materialization: &DocumentMaterialization,
) -> Result<(), StoreError> {
    let materialized_ids = materialization
        .search_units
        .iter()
        .map(|unit| unit.block_id.as_str())
        .collect::<HashSet<_>>();
    if materialized_ids.len() != materialization.search_units.len() {
        return Err(corrupt(
            "Migrated Document index contains duplicate Block IDs",
        ));
    }
    let indexed_ids = connection
        .prepare(
            "SELECT block_id FROM document_block_index \
             WHERE document_id = ?1 ORDER BY block_id",
        )?
        .query_map([document_id], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|_| corrupt("Migrated Document index has invalid Block identities"))?;
    for block_id in indexed_ids {
        if materialized_ids.contains(block_id.as_str()) {
            continue;
        }
        connection.execute(
            "DELETE FROM document_block_index WHERE document_id = ?1 AND block_id = ?2",
            params![document_id, block_id],
        )?;
    }

    // Deleted Pages retain their Document index for exact restore. Those Blocks
    // cannot be reinserted while deleted, so preserve identities and update the
    // schema-derived projection in place; active missing rows still use inserts.
    for unit in &materialization.search_units {
        let changed = connection.execute(
            "UPDATE document_block_index SET \
               parent_block_id = ?1, ordinal = ?2, block_type = ?3, text = ?4, projected_seq = ?5 \
             WHERE document_id = ?6 AND block_id = ?7",
            params![
                unit.parent_block_id,
                i64::try_from(unit.ordinal).map_err(|_| internal("Block ordinal overflow"))?,
                unit.block_type,
                unit.text,
                projected_seq,
                document_id,
                unit.block_id,
            ],
        )?;
        if changed == 1 {
            continue;
        }
        connection.execute(
            "INSERT INTO document_block_index (\
               document_id, block_id, parent_block_id, ordinal, block_type, text, projected_seq\
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                document_id,
                unit.block_id,
                unit.parent_block_id,
                i64::try_from(unit.ordinal).map_err(|_| internal("Block ordinal overflow"))?,
                unit.block_type,
                unit.text,
                projected_seq,
            ],
        )?;
    }
    Ok(())
}

pub(crate) fn replace_page_reference_projection(
    connection: &Connection,
    document_id: &str,
    references: &[crate::domain::derived_records::BlockDocumentReference],
    now: &str,
) -> Result<(), StoreError> {
    connection.execute(
        "DELETE FROM document_page_references WHERE document_id = ?1",
        [document_id],
    )?;
    let source_owner_block_id = connection
        .query_row(
            "SELECT block_id FROM block_documents WHERE document_id = ?1",
            [document_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .ok_or_else(|| corrupt("Document Page references have no owning Block"))?;
    for reference in references {
        let crate::domain::derived_records::BlockDocumentReference::Page {
            source_block_id,
            target_page_id,
            presentation,
            occurrence_count,
        } = reference
        else {
            continue;
        };
        let presentation = match presentation {
            crate::domain::derived_records::PageReferencePresentation::Mention => "mention",
            crate::domain::derived_records::PageReferencePresentation::ReferenceBlock => {
                "reference_block"
            }
            crate::domain::derived_records::PageReferencePresentation::Link => "link",
        };
        connection.execute(
            "INSERT INTO document_page_references( \
               document_id, source_owner_block_id, source_block_id, target_page_id, \
               presentation, occurrence_count, updated_at \
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                document_id,
                source_owner_block_id,
                source_block_id,
                target_page_id,
                presentation,
                occurrence_count,
                now,
            ],
        )?;
    }
    Ok(())
}

/// Rebuilds every owner-scoped projection derived from one migrated Document.
///
/// Schema migration deliberately skips placement and lifecycle reconciliation:
/// those authorities did not change. Everything derived from the Document
/// body, however, must go through the same projection writer as an ordinary
/// commit. Retained unowned Documents keep their materialization and Block
/// index for exact restore but must not remain visible through owner-scoped
/// search or asset projections.
pub(crate) fn replace_secondary_projections_for_schema_migration(
    connection: &Connection,
    document_id: &str,
    materialization: &DocumentMaterialization,
    projected_seq: i64,
    now: &str,
) -> Result<bool, StoreError> {
    let has_owner = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM block_documents WHERE document_id = ?1)",
        [document_id],
        |row| row.get::<_, bool>(0),
    )?;
    if !has_owner {
        connection.execute(
            "DELETE FROM block_asset_refs WHERE document_id = ?1",
            [document_id],
        )?;
        connection.execute(
            "DELETE FROM block_search_units WHERE document_id = ?1 AND source_revision IS NULL",
            [document_id],
        )?;
        return Ok(false);
    }

    let authority = read_document_authority(connection, document_id)?
        .ok_or_else(|| corrupt("Migrated Document ownership is incomplete"))?;
    replace_secondary_projections(
        connection,
        &authority,
        materialization,
        projected_seq,
        now,
        authority.owner_type == "page",
    )?;
    Ok(true)
}

fn page_reference_target_impact(reference_sets: &[&[BlockDocumentReference]]) -> ProjectionImpact {
    let mut page_ids = reference_sets
        .iter()
        .flat_map(|references| references.iter())
        .filter_map(|reference| match reference {
            BlockDocumentReference::Page { target_page_id, .. } => Some(target_page_id.clone()),
            _ => None,
        })
        .collect::<Vec<_>>();
    page_ids.sort();
    page_ids.dedup();
    if page_ids.is_empty() {
        return ProjectionImpact::None;
    }
    ProjectionImpact::Resources {
        page_ids,
        database_ids: Vec::new(),
        data_source_ids: Vec::new(),
        view_ids: Vec::new(),
        document_heads: Vec::new(),
    }
}

fn owned_page_file_ids(
    connection: &Connection,
    authority: &DocumentAuthorityRow,
) -> Result<BTreeSet<String>, StoreError> {
    connection
        .prepare(
            "SELECT file_id FROM page_files \
             WHERE library_id = ?1 AND owner_page_id = ?2",
        )?
        .query_map(
            params![authority.head.library_id, authority.owner_block_id],
            |row| row.get::<_, String>(0),
        )?
        .collect::<rusqlite::Result<BTreeSet<_>>>()
        .map_err(Into::into)
}

fn page_file_body_usage_counts(
    materialization: &DocumentMaterialization,
    owned_file_ids: &BTreeSet<String>,
) -> BTreeMap<String, usize> {
    let mut counts = BTreeMap::new();
    for file_id in materialization
        .asset_refs
        .iter()
        .filter_map(|reference| reference.file_id.as_deref())
    {
        if owned_file_ids.contains(file_id) {
            *counts.entry(file_id.to_owned()).or_insert(0) += 1;
        }
    }
    counts
}

fn validate_page_file_placements(
    connection: &Connection,
    authority: &DocumentAuthorityRow,
    actor_project_id: &str,
    base_materialization: Option<&DocumentMaterialization>,
    materialization: &DocumentMaterialization,
    prevalidated: bool,
) -> Result<(), StoreError> {
    let existing_file_ids = base_materialization
        .into_iter()
        .flat_map(|base| base.asset_refs.iter())
        .filter_map(|reference| reference.file_id.as_deref())
        .collect::<BTreeSet<_>>();
    let file_ids = materialization
        .asset_refs
        .iter()
        .filter_map(|reference| reference.file_id.as_deref())
        .filter(|file_id| !existing_file_ids.contains(file_id))
        .collect::<BTreeSet<_>>();
    if file_ids.is_empty() {
        return Ok(());
    }
    if authority.owner_type != "page" {
        return Err(invalid(
            "Page File placements require a containing Page Document".to_owned(),
        ));
    }
    for file_id in file_ids {
        let owner_page_id = connection
            .query_row(
                "SELECT owner_page_id FROM page_files \
                 WHERE file_id = ?1 AND library_id = ?2 AND state = 'live'",
                params![file_id, authority.head.library_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .ok_or_else(|| invalid("Page Document references an unavailable File".to_owned()))?;
        if owner_page_id == authority.owner_block_id
            || prevalidated
            || project_can_read_page(
                connection,
                &authority.head.library_id,
                actor_project_id,
                &owner_page_id,
            )?
            || project_can_read_existing_file_placement(
                connection,
                &authority.head.library_id,
                actor_project_id,
                file_id,
            )?
        {
            continue;
        }
        return Err(invalid(
            "Page Document references a File unavailable to this Page context".to_owned(),
        ));
    }
    Ok(())
}

fn project_can_read_page(
    connection: &Connection,
    library_id: &str,
    project_id: &str,
    page_id: &str,
) -> Result<bool, StoreError> {
    Ok(
        crate::library::page_read_authorization_roots(connection, library_id, project_id, page_id)?
            .is_some(),
    )
}

fn project_can_read_existing_file_placement(
    connection: &Connection,
    library_id: &str,
    project_id: &str,
    file_id: &str,
) -> Result<bool, StoreError> {
    let placement_page_ids = connection
        .prepare(
            "SELECT DISTINCT owner_block_id FROM block_asset_refs \
             WHERE library_id = ?1 AND page_file_id = ?2 \
             ORDER BY owner_block_id",
        )?
        .query_map(params![library_id, file_id], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for page_id in placement_page_ids {
        if project_can_read_page(connection, library_id, project_id, &page_id)? {
            return Ok(true);
        }
    }
    Ok(false)
}

fn advance_page_file_body_usage_revision(
    connection: &Connection,
    authority: &DocumentAuthorityRow,
    now: &str,
) -> Result<(), StoreError> {
    let changed = connection.execute(
        "UPDATE page_file_manifests \
         SET body_usage_revision = body_usage_revision + 1, updated_at = ?1 \
         WHERE page_id = ?2 AND library_id = ?3 \
           AND body_usage_revision < 9223372036854775807",
        params![now, authority.owner_block_id, authority.head.library_id],
    )?;
    if changed == 1 {
        return Ok(());
    }
    Err(corrupt(
        "Page File body usage revision authority is unavailable",
    ))
}

pub(super) fn replace_secondary_projections(
    connection: &Connection,
    authority: &DocumentAuthorityRow,
    materialization: &DocumentMaterialization,
    projected_seq: i64,
    now: &str,
    page_projection_required: bool,
) -> Result<(), StoreError> {
    update_page_document_projection(
        connection,
        authority,
        materialization,
        projected_seq,
        now,
        page_projection_required,
    )?;
    connection.execute(
        "DELETE FROM block_asset_refs WHERE document_id = ?1",
        [&authority.head.id],
    )?;
    connection.execute(
        "DELETE FROM block_search_units WHERE document_id = ?1 AND source_revision IS NULL",
        [&authority.head.id],
    )?;
    let marker_kind = match materialization.search_marker_kind {
        DocumentSearchMarkerKind::DocumentTitle => "document_title",
        DocumentSearchMarkerKind::DocumentMarker => "document_marker",
    };
    let marker_field = if marker_kind == "document_title" {
        "title"
    } else {
        "marker"
    };
    insert_library_search_unit(
        connection,
        authority,
        SearchUnitProjection {
            block_id: &authority.owner_block_id,
            projected_seq,
            source_kind: marker_kind,
            field_key: marker_field,
            text: &materialization.title,
            now,
        },
    )?;
    for unit in &materialization.search_units {
        insert_library_search_unit(
            connection,
            authority,
            SearchUnitProjection {
                block_id: &unit.block_id,
                projected_seq,
                source_kind: "document_block",
                field_key: "text",
                text: &unit.text,
                now,
            },
        )?;
    }
    let mut next_ordinal = HashMap::<(&str, &'static str), i64>::new();
    for asset in &materialization.asset_refs {
        let role = match asset.kind {
            BlockDocumentAssetKind::Image => "image",
            BlockDocumentAssetKind::Attachment => "attachment",
        };
        let ordinal = next_ordinal
            .entry((asset.source_block_id.as_str(), role))
            .or_insert(0);
        let asset_hash = asset
            .file_id
            .as_deref()
            .map(|file_id| {
                connection
                    .query_row(
                        "SELECT version.blob_hash FROM page_files file \
                         JOIN page_file_versions version ON version.file_id = file.file_id \
                           AND version.version = file.current_version \
                         WHERE file.file_id = ?1 AND file.library_id = ?2 \
                           AND file.state = 'live' \
                           AND version.blob_hash IS NOT NULL",
                        params![file_id, authority.head.library_id],
                        |row| row.get::<_, String>(0),
                    )
                    .optional()?
                    .ok_or_else(|| {
                        StoreError::new(
                            StoreErrorCode::InvalidInput,
                            "Page Document references an unavailable File",
                            false,
                        )
                    })
            })
            .transpose()?;
        connection.execute(
            "INSERT INTO block_asset_refs( \
               document_id, block_id, owner_block_id, library_id, document_generation, \
               projected_seq, projection_version, role, ordinal, asset_uri, asset_hash, \
               page_file_id, updated_at \
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                authority.head.id,
                asset.source_block_id,
                authority.owner_block_id,
                authority.head.library_id,
                authority.head.generation,
                projected_seq,
                PROJECTION_VERSION,
                role,
                *ordinal,
                asset.source,
                asset_hash,
                asset.file_id,
                now,
            ],
        )?;
        *ordinal += 1;
    }
    Ok(())
}

fn update_page_document_projection(
    connection: &Connection,
    authority: &DocumentAuthorityRow,
    materialization: &DocumentMaterialization,
    projected_seq: i64,
    now: &str,
    page_projection_required: bool,
) -> Result<(), StoreError> {
    if authority.owner_type != "page" {
        return Ok(());
    }
    let updated = connection.execute(
        "UPDATE page_read_model SET document_generation = ?1, document_projected_seq = ?2, \
           document_schema_version = ?3, document_authority = 'ydoc_primary', title = ?4, \
           description_preview = ?5, description_length = ?6, has_description = ?7, \
           updated_at = ?8 WHERE page_block_id = ?9 AND document_id = ?10",
        params![
            authority.head.generation,
            projected_seq,
            authority.head.schema_version,
            materialization.title,
            materialization.preview,
            i64::try_from(materialization.nfm.len())
                .map_err(|_| internal("Page description length overflow"))?,
            i64::from(!materialization.nfm.trim().is_empty()),
            now,
            authority.owner_block_id,
            authority.head.id,
        ],
    )?;
    if page_projection_required && updated != 1 {
        return Err(corrupt(
            "Page Document projection does not match its authority",
        ));
    }
    Ok(())
}

struct SearchUnitProjection<'a> {
    block_id: &'a str,
    projected_seq: i64,
    source_kind: &'a str,
    field_key: &'a str,
    text: &'a str,
    now: &'a str,
}

fn insert_library_search_unit(
    connection: &Connection,
    authority: &DocumentAuthorityRow,
    unit: SearchUnitProjection<'_>,
) -> Result<(), StoreError> {
    let unit_key = format!(
        "document:{}",
        sha256(
            serde_json::to_string(&[
                authority.head.id.as_str(),
                unit.block_id,
                unit.source_kind,
                unit.field_key,
            ])
            .map_err(|_| internal("Search unit key"))?
            .as_bytes()
        )
    );
    // A search unit belongs to the Block's logical field, not permanently to
    // one Document. Upserting that identity makes cross-Document moves
    // independent of which prepared Document is rebuilt first.
    connection.execute(
        "INSERT INTO block_search_units ( \
           unit_key, library_id, block_id, owner_block_id, document_id, document_generation, \
           projected_seq, source_revision, projection_version, source_kind, field_key, text, \
           text_hash, updated_at \
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, ?8, ?9, ?10, ?11, ?12, ?13) \
         ON CONFLICT(block_id, source_kind, field_key) DO UPDATE SET \
           unit_key = excluded.unit_key, library_id = excluded.library_id, \
           owner_block_id = excluded.owner_block_id, document_id = excluded.document_id, \
           document_generation = excluded.document_generation, \
           projected_seq = excluded.projected_seq, source_revision = NULL, \
           projection_version = excluded.projection_version, text = excluded.text, \
           text_hash = excluded.text_hash, updated_at = excluded.updated_at",
        params![
            unit_key,
            authority.head.library_id,
            unit.block_id,
            authority.owner_block_id,
            authority.head.id,
            authority.head.generation,
            unit.projected_seq,
            PROJECTION_VERSION,
            unit.source_kind,
            unit.field_key,
            unit.text,
            sha256(unit.text.as_bytes()),
            unit.now,
        ],
    )?;
    Ok(())
}

fn validate_document_references(
    connection: &Connection,
    library_id: &str,
    actor_project_id: &str,
    materialization: &DocumentMaterialization,
    allow_legacy_diagnostics: bool,
) -> Result<(), StoreError> {
    for reference in &materialization.references {
        let valid = match reference {
            BlockDocumentReference::Page { .. } => true,
            BlockDocumentReference::Block {
                target_block_id, ..
            } => block_reference_is_readable(
                connection,
                library_id,
                target_block_id,
                allow_legacy_diagnostics,
            )?,
            BlockDocumentReference::DatabaseView {
                database_view_id, ..
            } => connection
                .query_row(
                    "SELECT 1 FROM database_views view \
                     JOIN database_containers container \
                       ON container.block_id = view.database_block_id \
                     WHERE view.id = ?1 AND container.library_id = ?2 \
                       AND view.lifecycle <> 'deleted'",
                    params![database_view_id, library_id],
                    |_| Ok(()),
                )
                .optional()?
                .is_some(),
            BlockDocumentReference::Thread {
                target_thread_id, ..
            } => connection
                .query_row(
                    "SELECT 1 FROM codex_threads WHERE thread_id = ?1 \
                     AND (project_id = ?2 OR project_id IS NULL)",
                    params![target_thread_id, actor_project_id],
                    |_| Ok(()),
                )
                .optional()?
                .is_some(),
        };
        if valid {
            continue;
        }
        return Err(invalid(format!(
            "Document contains an {}",
            reference_description(reference)
        )));
    }
    Ok(())
}

fn reference_description(reference: &BlockDocumentReference) -> String {
    match reference {
        BlockDocumentReference::Page {
            source_block_id,
            target_page_id,
            presentation,
            ..
        } => format!(
            "unreadable {presentation:?} Page reference from `{source_block_id}` to `{target_page_id}`"
        ),
        BlockDocumentReference::Block {
            source_block_id,
            target_block_id,
            ..
        } => format!("unreadable Block reference from `{source_block_id}` to `{target_block_id}`"),
        BlockDocumentReference::DatabaseView {
            source_block_id,
            database_view_id,
            ..
        } => format!(
            "unreadable Database View reference from `{source_block_id}` to `{database_view_id}`"
        ),
        BlockDocumentReference::Thread {
            source_block_id,
            target_thread_id,
        } => {
            format!("unreadable Thread reference from `{source_block_id}` to `{target_thread_id}`")
        }
    }
}

fn block_reference_is_readable(
    connection: &Connection,
    library_id: &str,
    target_block_id: &str,
    allow_legacy_diagnostics: bool,
) -> Result<bool, StoreError> {
    let target = connection
        .query_row(
            "SELECT library_id, type, lifecycle FROM blocks WHERE id = ?1",
            [target_block_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .optional()?;
    let Some((target_library_id, target_type, target_lifecycle)) = target else {
        return Ok(false);
    };
    if target_lifecycle == "deleted" {
        return Ok(allow_legacy_diagnostics
            && target_library_id == library_id
            && target_type == "unresolved_card_reference");
    }
    if target_type == "unresolved_card_reference" {
        return Ok(false);
    }
    Ok(target_library_id == library_id)
}

pub(crate) fn derive_touched_block_ids(
    owner_block_id: &str,
    before: &DocumentMaterialization,
    after: &DocumentMaterialization,
    placement_delta: &DocumentPlacementDelta,
) -> Vec<String> {
    let mut touched = derive_document_node_delta(before, after)
        .into_iter()
        .collect::<HashSet<_>>();
    touched.extend(placement_delta.parent_changed_block_ids.iter().cloned());
    touched.extend(placement_delta.reordered_block_ids.iter().cloned());
    if before.title != after.title || before.rich_title != after.rich_title {
        touched.insert(owner_block_id.to_owned());
    }
    let mut touched = touched.into_iter().collect::<Vec<_>>();
    touched.sort();
    touched
}

fn sqlite_now(connection: &Connection) -> Result<String, StoreError> {
    connection
        .query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", [], |row| {
            row.get::<_, String>(0)
        })
        .map_err(StoreError::from)
}

pub(crate) fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn is_uuid_v7(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && bytes.get(8) == Some(&b'-')
        && bytes.get(13) == Some(&b'-')
        && bytes.get(14) == Some(&b'7')
        && bytes.get(18) == Some(&b'-')
        && bytes
            .get(19)
            .is_some_and(|value| matches!(value.to_ascii_lowercase(), b'8' | b'9' | b'a' | b'b'))
        && bytes.get(23) == Some(&b'-')
        && bytes
            .iter()
            .enumerate()
            .all(|(index, value)| matches!(index, 8 | 13 | 18 | 23) || value.is_ascii_hexdigit())
}

fn invalid(message: String) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message, false)
}

fn protected_owner_mutation(message: String) -> StoreError {
    StoreError::new(StoreErrorCode::ProtectedOwnerDeletion, message, false)
}

fn conflict(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::HeadConflict, message, true)
}

fn corrupt(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message, false)
}

fn internal(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::Internal, message, false)
}

#[cfg(test)]
mod typed_owner_shell_tests {
    use super::*;

    fn unit(
        block_id: &str,
        block_type: &str,
        parent_block_id: Option<&str>,
    ) -> DocumentBlockSearchUnit {
        DocumentBlockSearchUnit {
            block_id: block_id.to_owned(),
            parent_block_id: parent_block_id.map(str::to_owned),
            ordinal: 0,
            block_type: block_type.to_owned(),
            text: String::new(),
        }
    }

    #[test]
    fn generic_persistence_rejects_children_beneath_every_typed_owner_shell() {
        for owner_type in TYPED_CREATION_BLOCK_TYPES {
            let owner = unit("owner", owner_type, None);
            let child = unit("child", "paragraph", Some("owner"));
            let error = assert_typed_owner_shells_are_childless(&[owner, child])
                .expect_err("typed owner shells are childless");
            assert_eq!(error.code, StoreErrorCode::ProtectedOwnerDeletion);
            assert!(error.message.contains("owner"));
        }
    }

    #[test]
    fn generic_persistence_accepts_childless_owners_and_ordinary_parents() {
        assert_typed_owner_shells_are_childless(&[
            unit("owner", "page", None),
            unit("parent", "paragraph", None),
            unit("child", "paragraph", Some("parent")),
        ])
        .expect("only ordinary Blocks contain children");
    }

    #[test]
    fn generic_persistence_rejects_moving_any_ancestor_of_a_typed_owner() {
        for owner_type in TYPED_CREATION_BLOCK_TYPES {
            let base = vec![
                unit("parent", "paragraph", None),
                unit("owner", owner_type, Some("parent")),
                unit("unrelated", "paragraph", None),
            ];
            let placement = DocumentPlacementDelta {
                parent_changed_block_ids: ["parent".to_owned()].into_iter().collect(),
                ..DocumentPlacementDelta::default()
            };
            let error = assert_generic_placement_preserves_typed_owner_subtrees(&base, &placement)
                .expect_err("a generic move cannot carry a typed owner subtree");
            assert_eq!(error.code, StoreErrorCode::ProtectedOwnerDeletion);
            assert!(error.message.contains("parent"));

            let unrelated_placement = DocumentPlacementDelta {
                reordered_block_ids: ["unrelated".to_owned()].into_iter().collect(),
                ..DocumentPlacementDelta::default()
            };
            assert_generic_placement_preserves_typed_owner_subtrees(&base, &unrelated_placement)
                .expect("ordinary unrelated placement remains generic");
        }
    }
}
