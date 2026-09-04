use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

pub(super) mod history;
mod promotion_history;

use nodex_core_contracts::database::DatabaseViewPreferencesOverrideInput;
use nodex_core_contracts::library::{
    LibraryBlockLocation, LibraryBlockTransferDataSourcePlacement,
    LibraryBlockTransferDocumentCommit, LibraryBlockTransferDocumentHead,
    LibraryBlockTransferLogicalIntent, LibraryBlockTransferMode,
    LibraryBlockTransferPromotionEvidence, LibraryBlockTransferResult, LibraryBlockTransferSource,
    LibraryBlockTransferTarget, LibraryBlockTransferTransformationEvidence,
    LibraryBlockTransferUndoResult, LibraryBlockTransferUndoToken, LibraryCommitValue,
    LibraryPageCopyDestination, LibraryPageCopyPositionAnchor, LibraryPageCopyValue,
    LibraryPageCopyViewPlacement, LibraryPagePromotionPolicy, LibraryPageRelocationUndoResult,
    LibraryPageViewPlacementResult, LibraryPlacementAnchor, LibraryReceipt,
};
use nodex_core_contracts::{BoundModuleContext, ModuleName};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::database::{
    ExistingPageTransferTarget, PageCopyDataSourceDestination, PageCopyValueDraft,
    PageTaskShorthandBatchPlan, PageTaskShorthandCandidate, PageTaskShorthandPreservedReason,
    StagedPagePlacementRevisions, apply_page_task_shorthand_schema, current_page_key_for_page,
    place_staged_page_in_data_source, plan_page_task_shorthand,
    resolve_page_transfer_data_source_destination_prevalidated,
    resolve_page_transfer_list_destination, transfer_existing_page_for_agent_move_prevalidated,
    transfer_existing_page_for_block_transfer, validate_page_copy_data_source_source,
    validate_page_transfer_data_source_source,
    validate_page_transfer_data_source_source_prevalidated,
};
use crate::document::{
    BlockDocumentSchema, DocumentAuthorityRow, DocumentBlockOperation, DocumentMaterialization,
    DocumentPlacementEvidence, NewDocumentCheckpoint, PersistYjsCommit, PersistYjsGenesis,
    PortableSubtreeDocumentHead, PortableSubtreeTransferKind, PortableSubtreeTransferRequest,
    PreparedDocumentOperationUpdate, YrsDocumentEngine, decode_block_document,
    insert_document_checkpoint, materialize_decoded_document, persist_yjs_commit_with_local_commit,
    persist_yjs_genesis_with_local_commit, prepare_document_operation_update,
    prepare_page_yjs_genesis_with_content, prepare_portable_subtree_transfer_updates,
    prepare_yjs_clone_genesis, read_document_authority, reconstruct_yjs_engine, sha256,
};
use crate::domain::block_materialization::MaterializedBlockNode;
use crate::domain::block_to_page::{
    BlockToPageTransformation, PageWrapperReason, plan_block_to_page_transformation,
};
use crate::domain::identity::stable_uuid_v7;
use crate::domain::rich_text::RichTextItem;
use crate::domain::subtree::BlockSubtreeInsertionTarget;
use crate::domain::task_shorthand::{
    TASK_SHORTHAND_GRAMMAR_VERSION, TaskShorthandMatch, TaskShorthandParse, TaskShorthandRejection,
    parse_task_shorthand,
};
use crate::infrastructure::durable_mutation::{
    self, DurableMutationScope, OperationIdentity, SealedOutcome,
};
use crate::infrastructure::local_commit;
use crate::infrastructure::metrics::{DurationMetric, DurationMetricSnapshot};
use crate::infrastructure::module_receipts::read_module_receipt;
use crate::infrastructure::request_execution::check_request_interruption;
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

use super::LibraryApplyOutcome;
use super::mutation::{
    MutationEffects, ensure_default_page_intrinsic_properties, insert_library_placement,
    insert_page_read_model, library_commit_result, refresh_page_intrinsic_projection,
    require_project_in_library, seal_mutation_with, sqlite_now,
};
use super::page_copy::{
    PageCopyParentDocumentMode, execute_page_copy, page_copy_closure_document_heads,
};

const MODULE_NAME: &str = "library";
const MAX_ID_LENGTH: usize = 512;
const MAX_TRANSFER_ROOTS: usize = 10_000;
const MAX_ACTOR_BYTES: usize = 64 * 1024;
const TRANSFER_CLIENT_SESSION_ID: &str = "rust:block-transfer";

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct BlockTransferMetrics {
    pub page_parent_prepare: DurationMetricSnapshot,
    pub page_parent_reconstruct: DurationMetricSnapshot,
    pub page_parent_decode: DurationMetricSnapshot,
    pub page_parent_transform: DurationMetricSnapshot,
    pub page_parent_encode: DurationMetricSnapshot,
    pub page_parent_apply: DurationMetricSnapshot,
}

#[derive(Default)]
struct BlockTransferMetricSet {
    page_parent_prepare: DurationMetric,
    page_parent_reconstruct: DurationMetric,
    page_parent_decode: DurationMetric,
    page_parent_transform: DurationMetric,
    page_parent_encode: DurationMetric,
    page_parent_apply: DurationMetric,
}

static BLOCK_TRANSFER_METRICS: OnceLock<BlockTransferMetricSet> = OnceLock::new();

fn metrics() -> &'static BlockTransferMetricSet {
    BLOCK_TRANSFER_METRICS.get_or_init(BlockTransferMetricSet::default)
}

pub(super) fn metric_snapshot() -> BlockTransferMetrics {
    let metrics = metrics();
    BlockTransferMetrics {
        page_parent_prepare: metrics.page_parent_prepare.snapshot(),
        page_parent_reconstruct: metrics.page_parent_reconstruct.snapshot(),
        page_parent_decode: metrics.page_parent_decode.snapshot(),
        page_parent_transform: metrics.page_parent_transform.snapshot(),
        page_parent_encode: metrics.page_parent_encode.snapshot(),
        page_parent_apply: metrics.page_parent_apply.snapshot(),
    }
}

fn record_page_parent_prepare(
    total: Duration,
    reconstruct: Duration,
    decode: Duration,
    transform: Duration,
    encode: Duration,
) {
    let metrics = metrics();
    metrics.page_parent_prepare.record(total);
    metrics.page_parent_reconstruct.record(reconstruct);
    metrics.page_parent_decode.record(decode);
    metrics.page_parent_transform.record(transform);
    metrics.page_parent_encode.record(encode);
}

#[derive(Clone, Debug, Serialize)]
pub(super) struct AgentPageMoveTransferAuthority {
    pub(super) actor_project_id: String,
}

#[derive(Clone, Copy)]
enum PageOwnershipTransferAuthority<'a> {
    ProjectBound { project_id: &'a str },
    Agent(&'a AgentPageMoveTransferAuthority),
    TrustedLibrary(&'a super::mutation::LibraryMutationAuthority),
}

enum PageOwnershipHistory {
    None,
    RecordRelocation,
    UndoRelocation {
        recipe: PageRelocationUndoRecipeV3,
        token: LibraryBlockTransferUndoToken,
    },
}

impl PageOwnershipTransferAuthority<'_> {
    fn actor_project_id(&self) -> &str {
        match self {
            Self::ProjectBound { project_id } => project_id,
            Self::Agent(authority) => &authority.actor_project_id,
            Self::TrustedLibrary(authority) => &authority.actor_project_id,
        }
    }

    fn is_agent(&self) -> bool {
        matches!(self, Self::Agent(_))
    }

    fn is_prevalidated(&self) -> bool {
        !matches!(self, Self::ProjectBound { .. })
    }
}

pub(super) struct PreparedTransfer {
    source_authority: DocumentAuthorityRow,
    target_authority: DocumentAuthorityRow,
    source_engine: YrsDocumentEngine,
    target_engine: YrsDocumentEngine,
    source_materialization: DocumentMaterialization,
    target_materialization: DocumentMaterialization,
    prepared: crate::document::PreparedPortableSubtreeTransfer,
    expected_location_revisions: BTreeMap<String, i64>,
}

struct PersistedTransferCommit {
    public: LibraryBlockTransferDocumentCommit,
    materialization: DocumentMaterialization,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub(super) struct PreparedTransferMembership {
    membership_id: String,
    revision: i64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub(super) struct PreparedTransferReadSet {
    pub(super) documents: Vec<LibraryBlockTransferDocumentHead>,
    pub(super) location_revisions: BTreeMap<String, i64>,
    pub(super) source_memberships: BTreeMap<String, PreparedTransferMembership>,
}

pub(super) struct PreparedPageParentTransfer {
    source_authority: DocumentAuthorityRow,
    source_engine: YrsDocumentEngine,
    source_materialization: DocumentMaterialization,
    source_update: Option<PreparedDocumentOperationUpdate>,
    source_placeholder_block_id: Option<String>,
    roots: Vec<PreparedPageParentRoot>,
    expected_location_revisions: BTreeMap<String, i64>,
    copied_block_ids: BTreeMap<String, String>,
    actor_project_id: String,
    target: PreparedPageParentTarget,
    task_shorthand_plan: Option<PageTaskShorthandBatchPlan>,
}

const BLOCK_TRANSFER_UNDO_RECIPE_VERSION: u32 = 4;
const PAGE_RELOCATION_UNDO_RECIPE_VERSION: u32 = 3;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct BlockTransferUndoRecipeV4 {
    version: u32,
    mode: LibraryBlockTransferMode,
    project_id: String,
    library_id: String,
    store_epoch: String,
    source_document_id: String,
    source_generation: i64,
    source_post_head_seq: Option<i64>,
    source_pre_materialization: Option<DocumentMaterialization>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source_placeholder_block_id: Option<String>,
    roots: Vec<BlockTransferUndoRootV1>,
    target_guard_hash: String,
    schema_restore: Option<BlockTransferUndoSchemaRestoreV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    footprint: Option<promotion_history::PromotionFootprint>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct BlockTransferUndoRootV1 {
    source_root_id: String,
    result_page_id: String,
    result_document_id: String,
    source_block_ids: Vec<String>,
    source_root_type: String,
    source_root_properties: Vec<BlockTransferUndoBlockPropertyV1>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct BlockTransferUndoBlockPropertyV1 {
    property_key: String,
    value_type: String,
    value_json: String,
    revision: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct BlockTransferUndoSchemaRestoreV1 {
    data_source_id: String,
    property_id: String,
    pre_config_json: String,
    created_option_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct PageRelocationUndoRecipeV3 {
    version: u32,
    project_id: String,
    library_id: String,
    store_epoch: String,
    page_id: String,
    result_parent: PageRelocationUndoParentV2,
    result_location_revision: i64,
    source: PageRelocationUndoSourceV3,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct PageRelocationUndoPositionV3 {
    view_id: String,
    anchors: crate::database::PageOrderAnchors,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum PageRelocationUndoParentV2 {
    Library { library_id: String },
    Page { page_id: String },
    DataSource { data_source_id: String },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum PageRelocationUndoSourceV3 {
    Library {
        previous_sibling_id: Option<String>,
        next_sibling_id: Option<String>,
    },
    Page {
        page_id: String,
        document_id: String,
        parent_block_id: Option<String>,
        previous_sibling_id: Option<String>,
        next_sibling_id: Option<String>,
    },
    DataSource {
        data_source_id: String,
        default_view_id: String,
        positions: Vec<PageRelocationUndoPositionV3>,
    },
}

struct PreparedPageRelocationUndoV3 {
    page_id: String,
    source: PageRelocationUndoSourceV3,
}

struct PageParentApplyCommand<'a> {
    context: &'a BoundModuleContext,
    library_id: &'a str,
    operation_id: &'a str,
    store_epoch: &'a str,
    request_hash: &'a str,
    intent: &'a LibraryBlockTransferLogicalIntent,
}

enum PreparedPageParentTarget {
    Library {
        before_block_id: Option<String>,
    },
    DataSource {
        destination: PageCopyDataSourceDestination,
    },
}

fn resolve_data_source_placement(
    connection: &Connection,
    library_id: &str,
    project_id: &str,
    data_source_id: &str,
    placement: &LibraryBlockTransferDataSourcePlacement,
) -> Result<PageCopyDataSourceDestination, StoreError> {
    match placement {
        LibraryBlockTransferDataSourcePlacement::Direct {
            view_id,
            preferences_override,
            group_key,
            before_page_id,
            sorted_property_values,
        } => {
            let values = sorted_property_values
                .iter()
                .map(|value| PageCopyValueDraft {
                    property_id: value.property_id.clone(),
                    value: value.value.clone(),
                })
                .collect::<Vec<_>>();
            crate::database::resolve_page_transfer_board_destination(
                connection,
                library_id,
                project_id,
                data_source_id,
                view_id,
                preferences_override,
                group_key.as_deref(),
                before_page_id.as_deref(),
                &values,
            )
        }
        LibraryBlockTransferDataSourcePlacement::ListOccurrence {
            view_id,
            preferences_override,
            expected_projection,
            target,
        } => resolve_page_transfer_list_destination(
            connection,
            library_id,
            project_id,
            data_source_id,
            view_id,
            preferences_override,
            expected_projection,
            target,
        ),
    }
}

struct PreparedPageParentRoot {
    source_root_id: String,
    source_block_ids: Vec<String>,
    page_id: String,
    document_id: String,
    transformation: BlockToPageTransformation,
    source_to_result_block_ids: BTreeMap<String, String>,
    promotion_evidence: LibraryBlockTransferPromotionEvidence,
    task_shorthand: Option<TaskShorthandMatch>,
    destination_values: Option<Vec<PageCopyValueDraft>>,
    source_root_type: String,
    source_root_properties: Vec<BlockTransferUndoBlockPropertyV1>,
}

pub(super) struct PreparedPageOwnershipTransfer {
    roots: Vec<PreparedPageOwnershipRoot>,
    source: PreparedPageOwnershipSource,
    target: PreparedPageOwnershipTarget,
    source_document: Option<PreparedPageOwnershipDocument>,
    target_document: Option<PreparedPageOwnershipDocument>,
    copy_document_heads: Vec<LibraryBlockTransferDocumentHead>,
    copy_destination: Option<LibraryPageCopyDestination>,
}

struct PreparedPageOwnershipRoot {
    page_id: String,
    library_id: String,
    location_revision: i64,
    parent_revision: i64,
    source_membership: Option<PreparedTransferMembership>,
    shell: MaterializedBlockNode,
    owned_document_id: String,
    owned_document_generation: i64,
    owned_document_head_seq: i64,
}

struct PreparedPageOwnershipDocument {
    authority: DocumentAuthorityRow,
    engine: YrsDocumentEngine,
    full_state: Vec<u8>,
    base_materialization: DocumentMaterialization,
    schema: BlockDocumentSchema,
    update: PreparedDocumentOperationUpdate,
}

struct PreparedAgentPageDocument {
    document: PreparedPageOwnershipDocument,
    operations: Vec<DocumentBlockOperation>,
}

pub(super) struct PreparedAgentPageDocumentBatch {
    documents: BTreeMap<String, PreparedAgentPageDocument>,
}

pub(super) struct AppliedAgentPageDocumentBatch {
    commits: Vec<PersistedTransferCommit>,
}

impl AppliedAgentPageDocumentBatch {
    pub(super) fn document_commits(&self) -> Vec<LibraryBlockTransferDocumentCommit> {
        self.commits
            .iter()
            .map(|commit| commit.public.clone())
            .collect()
    }
}

struct PageOwnershipDocumentBase {
    authority: DocumentAuthorityRow,
    engine: YrsDocumentEngine,
    full_state: Vec<u8>,
    base_materialization: DocumentMaterialization,
    schema: BlockDocumentSchema,
    page_id: String,
}

enum PreparedPageOwnershipSource {
    Library,
    DataSource {
        data_source_id: String,
    },
    Document {
        document_id: String,
        page_id: String,
    },
}

enum PreparedPageOwnershipTarget {
    Library {
        before_block_id: Option<String>,
    },
    DataSource {
        destination: PageCopyDataSourceDestination,
    },
    Document {
        document_id: String,
        page_id: String,
        parent_block_id: Option<String>,
        before_block_id: Option<String>,
    },
}

pub(super) enum PreparedBlockTransfer {
    Ordinary(Box<PreparedTransfer>),
    PageParent(Box<PreparedPageParentTransfer>),
    PageOwnership(Box<PreparedPageOwnershipTransfer>),
}

fn preserve_page_relocation_source_values(
    prepared: &mut PreparedBlockTransfer,
) -> Result<(), StoreError> {
    let PreparedBlockTransfer::PageOwnership(prepared) = prepared else {
        return Err(corrupt("Page relocation Undo selected the wrong compiler"));
    };
    let PreparedPageOwnershipTarget::DataSource { destination } = &mut prepared.target else {
        return Err(corrupt("Page relocation Undo lost its source Database"));
    };
    // Direct placement normally derives Property writes from the target View.
    // Undo is different: the historical source membership already owns the
    // exact dormant values, so applying a missing group key would overwrite
    // the restored row (for example, clearing its workflow status).
    destination.values.clear();
    Ok(())
}

impl PreparedBlockTransfer {
    pub(super) fn read_set(&self) -> PreparedTransferReadSet {
        match self {
            Self::Ordinary(prepared) => prepared_transfer_read_set(prepared),
            Self::PageParent(prepared) => page_parent_read_set(prepared),
            Self::PageOwnership(prepared) => page_ownership_read_set(prepared),
        }
    }
}

impl PreparedAgentPageDocumentBatch {
    pub(super) fn empty() -> Self {
        Self {
            documents: BTreeMap::new(),
        }
    }

    pub(super) fn document_heads(&self) -> Vec<LibraryBlockTransferDocumentHead> {
        self.documents
            .values()
            .map(|entry| LibraryBlockTransferDocumentHead {
                document_id: entry.document.authority.head.id.clone(),
                generation: entry.document.authority.head.generation,
                expected_head_seq: entry.document.authority.head.head_seq,
            })
            .collect()
    }

    pub(super) fn revalidate(&self, connection: &Connection) -> Result<(), StoreError> {
        revalidate_read_set(
            connection,
            &PreparedTransferReadSet {
                documents: self.document_heads(),
                location_revisions: BTreeMap::new(),
                source_memberships: BTreeMap::new(),
            },
        )
    }
}

pub(super) fn extract_agent_page_document_batch(
    transfers: &mut [PreparedBlockTransfer],
    operation_id: &str,
) -> Result<PreparedAgentPageDocumentBatch, StoreError> {
    let mut batch = PreparedAgentPageDocumentBatch::empty();
    for transfer in transfers {
        check_request_interruption()?;
        let PreparedBlockTransfer::PageOwnership(prepared) = transfer else {
            return Err(corrupt(
                "Agent Page movement requires Page ownership preparations",
            ));
        };
        if let Some(document) = prepared.source_document.take() {
            let operations = prepared
                .roots
                .iter()
                .map(|root| DocumentBlockOperation::DeleteBlock {
                    block_id: root.page_id.clone(),
                })
                .collect::<Vec<_>>();
            merge_agent_page_document(&mut batch, document, operations)?;
        }
        if let Some(document) = prepared.target_document.take() {
            let PreparedPageOwnershipTarget::Document {
                parent_block_id,
                before_block_id,
                ..
            } = &prepared.target
            else {
                return Err(corrupt(
                    "Agent Page-move target Document preparation lost its target",
                ));
            };
            let operations = prepared
                .roots
                .iter()
                .map(|root| DocumentBlockOperation::InsertBlock {
                    block: root.shell.clone(),
                    parent_block_id: parent_block_id.clone(),
                    before_block_id: before_block_id.clone(),
                })
                .collect::<Vec<_>>();
            merge_agent_page_document(&mut batch, document, operations)?;
        }
    }
    for entry in batch.documents.values_mut() {
        check_request_interruption()?;
        recompile_page_ownership_document_update(
            &mut entry.document,
            &entry.operations,
            operation_id,
        )?;
    }
    Ok(batch)
}

pub(super) fn prepare_agent_created_page_document_batch(
    connection: &Connection,
    cache: Option<&Arc<Mutex<crate::document::DocumentRuntimeCache>>>,
    library_id: &str,
    destination: &LibraryPageCopyDestination,
    page_ids: &[String],
) -> Result<PreparedAgentPageDocumentBatch, StoreError> {
    check_request_interruption()?;
    let LibraryPageCopyDestination::Page {
        page_id,
        expected_document_generation,
        expected_document_head_seq,
        before,
    } = destination
    else {
        return Ok(PreparedAgentPageDocumentBatch::empty());
    };
    let document_id = resolve_page_document(connection, library_id, page_id)?;
    let base =
        load_page_ownership_document_prevalidated(connection, library_id, &document_id, cache)?;
    if base.authority.head.generation != *expected_document_generation
        || base.authority.head.head_seq != *expected_document_head_seq
    {
        return Err(StoreError::new(
            StoreErrorCode::RevisionConflict,
            "Agent Page-create target Document changed while it was prepared",
            true,
        ));
    }
    let mut operations = Vec::with_capacity(page_ids.len());
    for page_id in page_ids {
        check_request_interruption()?;
        operations.push(DocumentBlockOperation::InsertBlock {
            block: embedded_page_shell(page_id),
            parent_block_id: None,
            before_block_id: before.as_ref().map(|anchor| anchor.block_id.clone()),
        });
    }
    let document = prepare_page_ownership_document_update(base, &operations)?;
    let mut batch = PreparedAgentPageDocumentBatch::empty();
    merge_agent_page_document(&mut batch, document, operations)?;
    Ok(batch)
}

fn merge_agent_page_document(
    batch: &mut PreparedAgentPageDocumentBatch,
    document: PreparedPageOwnershipDocument,
    operations: Vec<DocumentBlockOperation>,
) -> Result<(), StoreError> {
    let document_id = document.authority.head.id.clone();
    if let Some(existing) = batch.documents.get_mut(&document_id) {
        if existing.document.authority.head.generation != document.authority.head.generation
            || existing.document.authority.head.head_seq != document.authority.head.head_seq
            || existing.document.authority.head.state_vector != document.authority.head.state_vector
        {
            return Err(StoreError::new(
                StoreErrorCode::RevisionConflict,
                format!("Document {document_id} changed during Agent Page preparation"),
                true,
            ));
        }
        existing.operations.extend(operations);
        return Ok(());
    }
    batch.documents.insert(
        document_id,
        PreparedAgentPageDocument {
            document,
            operations,
        },
    );
    Ok(())
}

pub(super) fn apply_agent_page_document_batch(
    connection: &Connection,
    scope: &DurableMutationScope<'_>,
    actor_project_id: &str,
    operation_id: &str,
    store_epoch: &str,
    batch: PreparedAgentPageDocumentBatch,
) -> Result<AppliedAgentPageDocumentBatch, StoreError> {
    batch.revalidate(connection)?;
    pre_detach_agent_page_moves(connection, &batch)?;
    let mut commits = Vec::with_capacity(batch.documents.len());
    for (index, entry) in batch.documents.into_values().enumerate() {
        check_request_interruption()?;
        let placement_block_ids = aggregate_owned_placement_block_ids(&entry.operations);
        let structurally_detached_block_ids = deleted_operation_block_ids(&entry.operations);
        let update_id = format!(
            "agent-page-document-batch:{}:{index}",
            sha256(operation_id.as_bytes())
        );
        let mut document = entry.document;
        let update = document.update;
        commits.push(persist_prepared_update(
            connection,
            actor_project_id,
            &document.authority,
            &document.base_materialization,
            &mut document.engine,
            update,
            &update_id,
            operation_id,
            store_epoch,
            TransferDocumentPlacement::Preapplied(&placement_block_ids),
            &structurally_detached_block_ids,
            scope.evidence(),
        )?);
    }
    Ok(AppliedAgentPageDocumentBatch { commits })
}

/// Removes only Page-shell index rows explicitly transferred between batch
/// Documents. Target-first persistence is then safe without erasing unrelated
/// source evidence or projections.
fn pre_detach_agent_page_moves(
    connection: &Connection,
    batch: &PreparedAgentPageDocumentBatch,
) -> Result<(), StoreError> {
    let insertions = batch
        .documents
        .iter()
        .flat_map(|(document_id, entry)| {
            entry
                .operations
                .iter()
                .filter_map(move |operation| match operation {
                    DocumentBlockOperation::InsertBlock { block, .. } => {
                        Some((block.id.as_str(), document_id.as_str()))
                    }
                    _ => None,
                })
        })
        .collect::<BTreeSet<_>>();
    for (source_document_id, entry) in &batch.documents {
        for block_id in entry
            .operations
            .iter()
            .filter_map(|operation| match operation {
                DocumentBlockOperation::DeleteBlock { block_id } => Some(block_id.as_str()),
                _ => None,
            })
        {
            let crosses_document = insertions.iter().any(|(inserted_id, target_document_id)| {
                inserted_id == &block_id && target_document_id != &source_document_id.as_str()
            });
            if !crosses_document {
                continue;
            }
            let changed = connection.execute(
                "DELETE FROM document_block_index WHERE document_id = ?1 AND block_id = ?2",
                params![source_document_id, block_id],
            )?;
            if changed != 1 {
                return Err(StoreError::new(
                    StoreErrorCode::RevisionConflict,
                    format!("Page shell {block_id} changed before its batch transfer"),
                    true,
                ));
            }
        }
    }
    Ok(())
}

pub(super) fn persist_agent_page_document_batch_checkpoints(
    connection: &Connection,
    context: &BoundModuleContext,
    operation_id: &str,
    actor: &Value,
    batch: &AppliedAgentPageDocumentBatch,
    change_log_seq: i64,
    now: &str,
) -> Result<(), StoreError> {
    persist_operation_checkpoints(
        connection,
        context,
        operation_id,
        actor,
        &batch.commits,
        change_log_seq,
        now,
    )
}

#[allow(clippy::too_many_arguments)]
pub(super) fn prepare_for_agent_page_move(
    connection: &Connection,
    cache: Option<&Arc<Mutex<crate::document::DocumentRuntimeCache>>>,
    context: &BoundModuleContext,
    library_id: &str,
    operation_id: &str,
    store_epoch: &str,
    intent: &LibraryBlockTransferLogicalIntent,
    authority: &AgentPageMoveTransferAuthority,
) -> Result<PreparedBlockTransfer, StoreError> {
    validate_id(operation_id, "operation_id")?;
    validate_intent(library_id, intent)?;
    let current_epoch = crate::document::read_store_epoch(connection)?;
    if current_epoch != store_epoch {
        return Err(StoreError::new(
            StoreErrorCode::StaleStoreEpoch,
            "Block transfer targets a stale store epoch",
            true,
        ));
    }
    validate_causal_dependencies(connection, context, store_epoch, intent)?;
    if !uses_page_ownership_parent_compiler(connection, intent)? {
        return Err(invalid("Agent Page movement requires Page ownership roots"));
    }
    prepare_page_ownership_transfer(
        connection,
        context,
        library_id,
        operation_id,
        intent,
        PageOwnershipTransferAuthority::Agent(authority),
        cache,
    )
    .map(Box::new)
    .map(PreparedBlockTransfer::PageOwnership)
}

#[allow(clippy::too_many_arguments)]
pub(super) fn prepare_for_semantic_page_move(
    connection: &Connection,
    cache: Option<&Arc<Mutex<crate::document::DocumentRuntimeCache>>>,
    context: &BoundModuleContext,
    library_id: &str,
    operation_id: &str,
    store_epoch: &str,
    intent: &LibraryBlockTransferLogicalIntent,
    authority: &super::mutation::LibraryMutationAuthority,
) -> Result<PreparedBlockTransfer, StoreError> {
    validate_id(operation_id, "operation_id")?;
    validate_intent(library_id, intent)?;
    let current_epoch = crate::document::read_store_epoch(connection)?;
    if current_epoch != store_epoch {
        return Err(StoreError::new(
            StoreErrorCode::StaleStoreEpoch,
            "Block transfer targets a stale store epoch",
            true,
        ));
    }
    validate_causal_dependencies(connection, context, store_epoch, intent)?;
    if !uses_page_ownership_parent_compiler(connection, intent)? {
        return Err(invalid(
            "Library Page movement requires Page ownership roots",
        ));
    }
    let transfer_authority = match authority.requesting_project_id.as_deref() {
        Some(project_id) => PageOwnershipTransferAuthority::ProjectBound { project_id },
        None => PageOwnershipTransferAuthority::TrustedLibrary(authority),
    };
    prepare_page_ownership_transfer(
        connection,
        context,
        library_id,
        operation_id,
        intent,
        transfer_authority,
        cache,
    )
    .map(Box::new)
    .map(PreparedBlockTransfer::PageOwnership)
}

pub(super) fn requires_preparation(
    connection: &Connection,
    context: &BoundModuleContext,
    operation_id: &str,
    store_epoch: &str,
    intent: &LibraryBlockTransferLogicalIntent,
) -> Result<bool, StoreError> {
    let request_hash = semantic_request_hash(context, store_epoch, intent)?;
    let Some(stored) = read_module_receipt(connection, MODULE_NAME, operation_id)? else {
        return Ok(true);
    };
    if stored.request_hash == request_hash {
        return Ok(false);
    }
    Err(StoreError::new(
        StoreErrorCode::IdempotencyKeyReused,
        "operation_id is already bound to another Block transfer",
        false,
    ))
}

pub(super) fn prepare_for_apply(
    connection: &Connection,
    cache: Option<&Arc<Mutex<crate::document::DocumentRuntimeCache>>>,
    context: &BoundModuleContext,
    library_id: &str,
    operation_id: &str,
    store_epoch: &str,
    intent: &LibraryBlockTransferLogicalIntent,
) -> Result<PreparedBlockTransfer, StoreError> {
    check_request_interruption()?;
    validate_id(operation_id, "operation_id")?;
    validate_intent(library_id, intent)?;
    let current_epoch = crate::document::read_store_epoch(connection)?;
    if current_epoch != store_epoch {
        return Err(StoreError::new(
            StoreErrorCode::StaleStoreEpoch,
            "Block transfer targets a stale store epoch",
            true,
        ));
    }
    validate_causal_dependencies(connection, context, store_epoch, intent)?;
    if uses_page_ownership_parent_compiler(connection, intent)? {
        let project_id = bound_project_id(context)?;
        return prepare_page_ownership_transfer(
            connection,
            context,
            library_id,
            operation_id,
            intent,
            PageOwnershipTransferAuthority::ProjectBound { project_id },
            cache,
        )
        .map(Box::new)
        .map(PreparedBlockTransfer::PageOwnership);
    }
    if matches!(
        intent.target,
        LibraryBlockTransferTarget::Library { .. } | LibraryBlockTransferTarget::DataSource { .. }
    ) {
        return prepare_page_parent_transfer(
            connection,
            context,
            library_id,
            operation_id,
            intent,
            cache,
        )
        .map(Box::new)
        .map(PreparedBlockTransfer::PageParent);
    }
    prepare_transfer(connection, context, library_id, operation_id, intent, cache)
        .map(Box::new)
        .map(PreparedBlockTransfer::Ordinary)
}

#[derive(Clone, Copy)]
enum TransferDocumentAccess {
    Read,
    Write,
}

type FinalBlockLocations = (
    BTreeMap<String, LibraryBlockLocation>,
    BTreeMap<String, i64>,
);

pub(super) fn semantic_request_hash(
    context: &BoundModuleContext,
    store_epoch: &str,
    intent: &LibraryBlockTransferLogicalIntent,
) -> Result<String, StoreError> {
    semantic_request_hash_with_authority(context, store_epoch, intent, None)
}

pub(super) fn semantic_agent_page_move_request_hash(
    context: &BoundModuleContext,
    store_epoch: &str,
    intent: &LibraryBlockTransferLogicalIntent,
    authority: &AgentPageMoveTransferAuthority,
) -> Result<String, StoreError> {
    semantic_request_hash_with_authority(context, store_epoch, intent, Some(authority))
}

fn semantic_request_hash_with_authority(
    context: &BoundModuleContext,
    store_epoch: &str,
    intent: &LibraryBlockTransferLogicalIntent,
    authority: Option<&AgentPageMoveTransferAuthority>,
) -> Result<String, StoreError> {
    let mut stable_intent = intent.clone();
    // A causal fence proves which local Document state the caller observed;
    // it is a freshness precondition, not the idempotent command identity.
    // Retrying the same operation after a re-read must therefore keep the
    // original request hash.
    stable_intent.causal_dependencies.clear();
    let fingerprint = serde_json::to_vec(&(
        &context.profile_id,
        &context.library_id,
        &context.project_id,
        store_epoch,
        stable_intent,
        authority,
    ))
    .map_err(|_| internal("Block transfer intent cannot be fingerprinted"))?;
    Ok(sha256(&fingerprint))
}

#[allow(clippy::too_many_arguments)]
pub(super) fn apply(
    connection: &Connection,
    context: &BoundModuleContext,
    library_id: &str,
    operation_id: &str,
    store_epoch: &str,
    request_hash: &str,
    intent: &LibraryBlockTransferLogicalIntent,
    assets_root: &Path,
    prepared: PreparedBlockTransfer,
) -> Result<LibraryApplyOutcome, StoreError> {
    let project_id = bound_project_id(context)?;
    apply_with_authority(
        connection,
        context,
        library_id,
        operation_id,
        store_epoch,
        request_hash,
        intent,
        assets_root,
        PageOwnershipTransferAuthority::ProjectBound { project_id },
        PageOwnershipHistory::None,
        None,
        prepared,
    )
}

#[allow(clippy::too_many_arguments)]
pub(super) fn apply_agent_page_move(
    connection: &Connection,
    context: &BoundModuleContext,
    library_id: &str,
    operation_id: &str,
    store_epoch: &str,
    request_hash: &str,
    intent: &LibraryBlockTransferLogicalIntent,
    assets_root: &Path,
    authority: &AgentPageMoveTransferAuthority,
    scope: &DurableMutationScope<'_>,
    prepared: PreparedBlockTransfer,
) -> Result<LibraryApplyOutcome, StoreError> {
    apply_with_authority(
        connection,
        context,
        library_id,
        operation_id,
        store_epoch,
        request_hash,
        intent,
        assets_root,
        PageOwnershipTransferAuthority::Agent(authority),
        PageOwnershipHistory::None,
        Some(scope),
        prepared,
    )
}

#[allow(clippy::too_many_arguments)]
pub(super) fn apply_semantic_page_move(
    connection: &Connection,
    context: &BoundModuleContext,
    library_id: &str,
    operation_id: &str,
    store_epoch: &str,
    request_hash: &str,
    intent: &LibraryBlockTransferLogicalIntent,
    assets_root: &Path,
    authority: &super::mutation::LibraryMutationAuthority,
    prepared: PreparedBlockTransfer,
) -> Result<LibraryApplyOutcome, StoreError> {
    let transfer_authority = match authority.requesting_project_id.as_deref() {
        Some(project_id) => PageOwnershipTransferAuthority::ProjectBound { project_id },
        None => PageOwnershipTransferAuthority::TrustedLibrary(authority),
    };
    apply_with_authority(
        connection,
        context,
        library_id,
        operation_id,
        store_epoch,
        request_hash,
        intent,
        assets_root,
        transfer_authority,
        PageOwnershipHistory::RecordRelocation,
        None,
        prepared,
    )
}

#[allow(clippy::too_many_arguments)]
fn apply_with_authority(
    connection: &Connection,
    context: &BoundModuleContext,
    library_id: &str,
    operation_id: &str,
    store_epoch: &str,
    request_hash: &str,
    intent: &LibraryBlockTransferLogicalIntent,
    assets_root: &Path,
    authority: PageOwnershipTransferAuthority<'_>,
    history: PageOwnershipHistory,
    attached_scope: Option<&DurableMutationScope<'_>>,
    prepared_transfer: PreparedBlockTransfer,
) -> Result<LibraryApplyOutcome, StoreError> {
    validate_intent(library_id, intent)?;
    let current_epoch = crate::document::read_store_epoch(connection)?;
    if current_epoch != store_epoch {
        return Err(StoreError::new(
            StoreErrorCode::StaleStoreEpoch,
            "Block transfer targets a stale store epoch",
            true,
        ));
    }
    validate_causal_dependencies(connection, context, store_epoch, intent)?;
    let read_set = prepared_transfer.read_set();
    match authority {
        PageOwnershipTransferAuthority::ProjectBound { .. } => {
            revalidate_command_authority(connection, context, library_id, intent)?;
        }
        PageOwnershipTransferAuthority::TrustedLibrary(authority) => {
            require_project_in_library(connection, &authority.actor_project_id, library_id)?;
        }
        PageOwnershipTransferAuthority::Agent(_) => {}
    }
    revalidate_read_set(connection, &read_set)?;
    if uses_page_ownership_parent_compiler(connection, intent)? {
        let prepared = match prepared_transfer {
            PreparedBlockTransfer::PageOwnership(prepared) => prepared,
            _ => return Err(corrupt("Prepared Block transfer compiler diverged")),
        };
        return apply_page_ownership_transfer(
            connection,
            context,
            library_id,
            operation_id,
            store_epoch,
            request_hash,
            intent,
            assets_root,
            authority,
            history,
            attached_scope,
            *prepared,
        );
    }
    if !matches!(
        authority,
        PageOwnershipTransferAuthority::ProjectBound { .. }
    ) || attached_scope.is_some()
    {
        return Err(invalid(
            "Agent Page-move authority requires Page ownership roots",
        ));
    }
    if matches!(
        intent.target,
        LibraryBlockTransferTarget::Library { .. } | LibraryBlockTransferTarget::DataSource { .. }
    ) {
        let prepared = match prepared_transfer {
            PreparedBlockTransfer::PageParent(prepared) => prepared,
            _ => return Err(corrupt("Prepared Block transfer compiler diverged")),
        };
        return apply_page_parent_transfer(
            connection,
            PageParentApplyCommand {
                context,
                library_id,
                operation_id,
                store_epoch,
                request_hash,
                intent,
            },
            *prepared,
        );
    }
    let mut prepared = match prepared_transfer {
        PreparedBlockTransfer::Ordinary(prepared) => *prepared,
        _ => return Err(corrupt("Prepared Block transfer compiler diverged")),
    };

    let inserted_ids = prepared.prepared.inserted_forest.block_ids.clone();
    if intent.mode == LibraryBlockTransferMode::Copy {
        assert_fresh_copy_identities(connection, &inserted_ids)?;
    }

    let now = sqlite_now(connection)?;
    let commit_result = durable_mutation::run(
        connection,
        OperationIdentity {
            module: ModuleName::Library,
            module_name: MODULE_NAME,
            operation_id,
            intent_hash: request_hash,
            store_epoch,
            committed_at: &now,
            context,
        },
        |scope| {
            let moves_between_documents = intent.mode == LibraryBlockTransferMode::Move
                && prepared.source_authority.head.id != prepared.target_authority.head.id;
            let source_update = prepared.prepared.source.take();
            let target_update = prepared.prepared.target.clone();
            let mut document_commits = Vec::new();
            if let Some(source_update) = source_update {
                let structurally_detached_block_ids = removed_document_block_ids(
                    &prepared.source_materialization,
                    &source_update.materialization,
                );
                let update_id = format!("relocation:{request_hash}:source");
                let commit = persist_prepared_update(
                    connection,
                    bound_project_id(context)?,
                    &prepared.source_authority,
                    &prepared.source_materialization,
                    &mut prepared.source_engine,
                    source_update,
                    &update_id,
                    operation_id,
                    store_epoch,
                    TransferDocumentPlacement::Derived {
                        advances: &[],
                        exact_moves: &[],
                    },
                    &structurally_detached_block_ids,
                    scope.evidence(),
                )?;
                document_commits.push(commit);
            }
            let target_update_id = if moves_between_documents {
                format!("relocation:{request_hash}:target")
            } else {
                format!("block-transfer:{request_hash}:target")
            };
            let target_commit = persist_prepared_update(
                connection,
                bound_project_id(context)?,
                &prepared.target_authority,
                &prepared.target_materialization,
                &mut prepared.target_engine,
                target_update,
                &target_update_id,
                operation_id,
                store_epoch,
                TransferDocumentPlacement::Derived {
                    advances: if moves_between_documents {
                        &prepared.prepared.inserted_forest.block_ids
                    } else {
                        &[]
                    },
                    exact_moves: if moves_between_documents {
                        &[]
                    } else {
                        &intent.root_block_ids
                    },
                },
                &[],
                scope.evidence(),
            )?;
            document_commits.push(target_commit);
            let result_block_ids = prepared.prepared.inserted_forest.block_ids.clone();
            let result_root_block_ids = prepared.prepared.inserted_forest.root_block_ids.clone();
            let copied_block_ids = if intent.mode == LibraryBlockTransferMode::Copy {
                prepared
                    .prepared
                    .source_forest
                    .block_ids
                    .iter()
                    .cloned()
                    .zip(result_block_ids.iter().cloned())
                    .collect()
            } else {
                BTreeMap::new()
            };
            let (final_locations, final_location_revisions) =
                read_final_locations(connection, &result_block_ids)?;
            let page_keys = read_current_page_keys(connection, library_id, &result_root_block_ids)?;
            let public_commits = document_commits
                .iter()
                .map(|commit| commit.public.clone())
                .collect::<Vec<_>>();
            let result = LibraryBlockTransferResult {
                mode: intent.mode,
                source_root_block_ids: intent.root_block_ids.clone(),
                result_root_block_ids,
                copied_block_ids,
                transformation_evidence: Vec::new(),
                final_locations,
                final_location_revisions: final_location_revisions.clone(),
                document_commits: public_commits,
                affected_database_ids: Vec::new(),
                page_keys,
                page_etags: BTreeMap::new(),
                move_etags: BTreeMap::new(),
                page_view_placements: BTreeMap::new(),
                undo_token: None,
                history: None,
            };
            let mut affected_page_ids = affected_page_ids(&prepared);
            affected_page_ids.sort();
            affected_page_ids.dedup();
            let is_same_storage_relocation = moves_between_documents
                && prepared.source_authority.head.library_id
                    == prepared.target_authority.head.library_id;
            let change_kind = if is_same_storage_relocation {
                "block_relocation"
            } else {
                "block_mutation"
            };
            let committed_revisions = final_location_revisions
                .iter()
                .map(|(block_id, revision)| (format!("blockLocation:{block_id}"), *revision))
                .chain(document_commits.iter().map(|commit| {
                    (
                        format!("documentHead:{}", commit.public.document_id),
                        commit.public.head_seq,
                    )
                }))
                .collect::<BTreeMap<_, _>>();
            seal_mutation_with(
                scope,
                context,
                operation_id,
                MutationEffects {
                    page_file_entries: Vec::new(),
                    file_revisions: BTreeMap::new(),
                    file_mutation: Default::default(),
                    project_id: bound_project_id(context)?.to_owned(),
                    operation_kind: "transfer_blocks",
                    change_kind,
                    did_mutate: true,
                    created_target: None,
                    affected_parent_keys: Vec::new(),
                    affected_block_ids: result_block_ids.clone(),
                    affected_page_ids,
                    affected_database_ids: Vec::new(),
                    affected_view_ids: Vec::new(),
                    affected_document_ids: read_set
                        .documents
                        .iter()
                        .map(|head| head.document_id.clone())
                        .collect(),
                    committed_revisions,
                    page_create: None,
                    page_copy: None,
                    canvas_mutation: None,
                    block_transfer: Some(result.clone()),
                    block_transfer_undo: None,
                    page_relocation_undo: None,
                    structural_edit: None,
                    page_lifecycle: None,
                    block_property_mutation: None,
                    agent_page_copy: None,
                    agent_create_pages: None,
                    agent_move_pages: None,
                    change_payload: None,
                    committed_at: now.clone(),
                },
                |_, event_sequence| {
                    if is_same_storage_relocation {
                        persist_relocation_ledger(
                            connection,
                            operation_id,
                            bound_project_id(context)?,
                            store_epoch,
                            request_hash,
                            intent,
                            &prepared,
                            &result,
                            &final_location_revisions,
                            event_sequence,
                            &now,
                        )?;
                    } else {
                        persist_mutation_ledger(
                            connection,
                            operation_id,
                            bound_project_id(context)?,
                            store_epoch,
                            request_hash,
                            intent,
                            &result,
                            event_sequence,
                            &now,
                        )?;
                    }
                    persist_operation_checkpoints(
                        connection,
                        context,
                        operation_id,
                        &intent.actor,
                        &document_commits,
                        event_sequence,
                        &now,
                    )
                },
            )
        },
    )?;
    library_commit_result(connection, commit_result)
}

fn prepare_transfer(
    connection: &Connection,
    context: &BoundModuleContext,
    library_id: &str,
    operation_id: &str,
    intent: &LibraryBlockTransferLogicalIntent,
    cache: Option<&Arc<Mutex<crate::document::DocumentRuntimeCache>>>,
) -> Result<PreparedTransfer, StoreError> {
    check_request_interruption()?;
    let project_id = bound_project_id(context)?;
    let source_page_id = match &intent.source {
        LibraryBlockTransferSource::Page { page_id } => Some(page_id.as_str()),
        _ => None,
    };
    let target_page_id = match &intent.target {
        LibraryBlockTransferTarget::Page { page_id, .. } => Some(page_id.as_str()),
        _ => None,
    };
    let source_document_id = resolve_source_document(connection, library_id, &intent.source)?;
    let (target_document_id, insertion) =
        resolve_target_document(connection, library_id, &intent.target)?;
    if intent.mode == LibraryBlockTransferMode::Move && source_document_id == target_document_id {
        return Err(invalid(
            "Move within one Document uses a stable-ID Document operation",
        ));
    }
    let source_authority = require_transfer_authority(
        connection,
        library_id,
        project_id,
        &source_document_id,
        source_page_id,
        match intent.mode {
            LibraryBlockTransferMode::Move => TransferDocumentAccess::Write,
            LibraryBlockTransferMode::Copy => TransferDocumentAccess::Read,
        },
    )?;
    let target_authority = require_transfer_authority(
        connection,
        library_id,
        project_id,
        &target_document_id,
        target_page_id,
        TransferDocumentAccess::Write,
    )?;
    let source_schema = require_schema(&source_authority)?;
    let target_schema = require_schema(&target_authority)?;
    let (source_engine, source_full_state) =
        clone_runtime_engine(connection, &source_authority.head, cache)?;
    let (target_engine, target_full_state) =
        clone_runtime_engine(connection, &target_authority.head, cache)?;
    check_request_interruption()?;
    let source_decoded = decode_block_document(source_engine.document(), source_schema)
        .map_err(|error| corrupt(error.to_string()))?;
    check_request_interruption()?;
    let source_materialization = materialize_decoded_document(&source_decoded)
        .map_err(|error| corrupt(error.to_string()))?;
    let target_decoded = decode_block_document(target_engine.document(), target_schema)
        .map_err(|error| corrupt(error.to_string()))?;
    check_request_interruption()?;
    let target_materialization = materialize_decoded_document(&target_decoded)
        .map_err(|error| corrupt(error.to_string()))?;
    let expected_location_revisions = validate_source_roots(
        connection,
        &source_authority.head.library_id,
        &source_document_id,
        &intent.root_block_ids,
    )?;
    let request = PortableSubtreeTransferRequest {
        kind: match intent.mode {
            LibraryBlockTransferMode::Move => PortableSubtreeTransferKind::Move,
            LibraryBlockTransferMode::Copy => PortableSubtreeTransferKind::Copy,
        },
        source: PortableSubtreeDocumentHead {
            document_id: source_document_id,
            schema: source_schema,
            full_state_v1: source_full_state,
            expected_state_vector_v1: source_engine.state_vector_v1(),
        },
        target: PortableSubtreeDocumentHead {
            document_id: target_document_id,
            schema: target_schema,
            full_state_v1: target_full_state,
            expected_state_vector_v1: target_engine.state_vector_v1(),
        },
        root_block_ids: intent.root_block_ids.clone(),
        insertion,
    };
    let mut allocate = |source_id: &str| stable_uuid_v7(operation_id, "block_transfer", source_id);
    let mut prepared = prepare_portable_subtree_transfer_updates(&request, &mut allocate)
        .map_err(|error| invalid(error.to_string()))?;
    for block_id in &prepared.source_forest.block_ids {
        if is_typed_resource(connection, block_id)? {
            return Err(invalid(
                "This native slice transfers ordinary Blocks only; Page ownership uses Library or Database semantics",
            ));
        }
    }
    if intent.mode == LibraryBlockTransferMode::Move {
        prepared.source = Some(
            prepare_block_transfer_source_update(
                &request.source.document_id,
                request.source.schema,
                &request.source.full_state_v1,
                &request.source.expected_state_vector_v1,
                &intent.root_block_ids,
                operation_id,
            )?
            .update,
        );
    }
    Ok(PreparedTransfer {
        source_authority,
        target_authority,
        source_engine,
        target_engine,
        source_materialization,
        target_materialization,
        prepared,
        expected_location_revisions,
    })
}

struct PreparedBlockTransferSourceUpdate {
    update: PreparedDocumentOperationUpdate,
    placeholder_block_id: Option<String>,
}

/// Compile the destructive side of a cross-surface move while preserving the
/// editable-root invariant of every persisted BlockNote-backed Document.
fn prepare_block_transfer_source_update(
    document_id: &str,
    schema: BlockDocumentSchema,
    full_state: &[u8],
    state_vector: &[u8],
    root_block_ids: &[String],
    operation_id: &str,
) -> Result<PreparedBlockTransferSourceUpdate, StoreError> {
    let operations = root_block_ids
        .iter()
        .map(|block_id| DocumentBlockOperation::DeleteBlock {
            block_id: block_id.clone(),
        })
        .collect::<Vec<_>>();
    prepare_block_transfer_update_with_editable_remainder(
        document_id,
        schema,
        full_state,
        state_vector,
        operations,
        operation_id,
    )
}

fn prepare_block_transfer_update_with_editable_remainder(
    document_id: &str,
    schema: BlockDocumentSchema,
    full_state: &[u8],
    state_vector: &[u8],
    mut operations: Vec<DocumentBlockOperation>,
    operation_id: &str,
) -> Result<PreparedBlockTransferSourceUpdate, StoreError> {
    let provisional = prepare_document_operation_update(
        document_id,
        schema,
        full_state,
        state_vector,
        &operations,
        true,
    )
    .map_err(|error| invalid(error.to_string()))?;
    if !provisional.materialization.block_tree.is_empty() {
        return Ok(PreparedBlockTransferSourceUpdate {
            update: provisional,
            placeholder_block_id: None,
        });
    }

    let placeholder_block_id = stable_uuid_v7(
        operation_id,
        "block_transfer_source_placeholder",
        document_id,
    );
    operations.push(DocumentBlockOperation::InsertBlock {
        block: MaterializedBlockNode {
            id: placeholder_block_id.clone(),
            block_type: "paragraph".to_owned(),
            props: BTreeMap::new(),
            content: Some(Value::Array(Vec::new())),
            children: Vec::new(),
        },
        parent_block_id: None,
        before_block_id: None,
    });
    let update = prepare_document_operation_update(
        document_id,
        schema,
        full_state,
        state_vector,
        &operations,
        false,
    )
    .map_err(|error| invalid(error.to_string()))?;
    Ok(PreparedBlockTransferSourceUpdate {
        update,
        placeholder_block_id: Some(placeholder_block_id),
    })
}

fn clone_runtime_engine(
    connection: &Connection,
    head: &crate::infrastructure::document_repository::DocumentHeadRow,
    cache: Option<&Arc<Mutex<crate::document::DocumentRuntimeCache>>>,
) -> Result<(YrsDocumentEngine, Vec<u8>), StoreError> {
    let Some(cache) = cache else {
        let engine = reconstruct_yjs_engine(connection, head)?;
        let full_state = engine.full_state_v1();
        return Ok((engine, full_state));
    };
    let working = cache
        .lock()
        .map_err(|_| internal("Document runtime cache lock failed"))?
        .clone_engine_with_state(connection, head)?;
    Ok((working.engine, working.full_state))
}

fn uses_page_ownership_parent_compiler(
    connection: &Connection,
    intent: &LibraryBlockTransferLogicalIntent,
) -> Result<bool, StoreError> {
    if matches!(
        intent.source,
        LibraryBlockTransferSource::Library { .. } | LibraryBlockTransferSource::DataSource { .. }
    ) {
        return Ok(true);
    }
    for block_id in &intent.root_block_ids {
        check_request_interruption()?;
        let block_type = connection
            .query_row("SELECT type FROM blocks WHERE id = ?1", [block_id], |row| {
                row.get::<_, String>(0)
            })
            .optional()?;
        if block_type.as_deref() == Some("page") {
            return Ok(true);
        }
    }
    Ok(false)
}

fn load_page_ownership_document(
    connection: &Connection,
    context: &BoundModuleContext,
    library_id: &str,
    document_id: &str,
    access: TransferDocumentAccess,
    cache: Option<&Arc<Mutex<crate::document::DocumentRuntimeCache>>>,
) -> Result<PageOwnershipDocumentBase, StoreError> {
    let authority = require_transfer_authority(
        connection,
        library_id,
        bound_project_id(context)?,
        document_id,
        None,
        access,
    )?;
    if authority.owner_type != "page" || !authority.head.is_live_yjs_authority() {
        return Err(invalid(
            "Page ownership transfer requires a live Page Document parent",
        ));
    }
    let schema = BlockDocumentSchema::from_identity(
        &authority.head.schema_key,
        authority.head.schema_version,
    )
    .filter(|schema| schema.has_title())
    .ok_or_else(|| corrupt("Page parent has an unsupported Document schema"))?;
    let (engine, full_state) = clone_runtime_engine(connection, &authority.head, cache)?;
    let decoded = decode_block_document(engine.document(), schema)
        .map_err(|error| corrupt(format!("Page parent schema is invalid: {error}")))?;
    let base_materialization = materialize_decoded_document(&decoded)
        .map_err(|error| corrupt(format!("Page parent cannot materialize: {error}")))?;
    Ok(PageOwnershipDocumentBase {
        page_id: authority.owner_block_id.clone(),
        authority,
        engine,
        full_state,
        base_materialization,
        schema,
    })
}

fn load_page_ownership_document_prevalidated(
    connection: &Connection,
    library_id: &str,
    document_id: &str,
    cache: Option<&Arc<Mutex<crate::document::DocumentRuntimeCache>>>,
) -> Result<PageOwnershipDocumentBase, StoreError> {
    let authority = read_document_authority(connection, document_id)?
        .ok_or_else(|| not_found("Page transfer Document is unavailable"))?;
    if authority.page_library_id.as_deref() != Some(library_id)
        || authority.owner_type != "page"
        || !authority.head.is_live_yjs_authority()
    {
        return Err(invalid(
            "Page ownership transfer requires a live Page Document parent",
        ));
    }
    let schema = BlockDocumentSchema::from_identity(
        &authority.head.schema_key,
        authority.head.schema_version,
    )
    .filter(|schema| schema.has_title())
    .ok_or_else(|| corrupt("Page parent has an unsupported Document schema"))?;
    let (engine, full_state) = clone_runtime_engine(connection, &authority.head, cache)?;
    let decoded = decode_block_document(engine.document(), schema)
        .map_err(|error| corrupt(format!("Page parent schema is invalid: {error}")))?;
    let base_materialization = materialize_decoded_document(&decoded)
        .map_err(|error| corrupt(format!("Page parent cannot materialize: {error}")))?;
    Ok(PageOwnershipDocumentBase {
        page_id: authority.owner_block_id.clone(),
        authority,
        engine,
        full_state,
        base_materialization,
        schema,
    })
}

fn prepare_page_ownership_document_update(
    base: PageOwnershipDocumentBase,
    operations: &[DocumentBlockOperation],
) -> Result<PreparedPageOwnershipDocument, StoreError> {
    let update = prepare_document_operation_update(
        &base.authority.head.id,
        base.schema,
        &base.full_state,
        &base.authority.head.state_vector,
        operations,
        false,
    )
    .map_err(|error| invalid(format!("Page parent update is invalid: {error}")))?;
    Ok(PreparedPageOwnershipDocument {
        authority: base.authority,
        engine: base.engine,
        full_state: base.full_state,
        base_materialization: base.base_materialization,
        schema: base.schema,
        update,
    })
}

fn prepare_page_ownership_source_document_update(
    base: PageOwnershipDocumentBase,
    root_block_ids: &[String],
    operation_id: &str,
) -> Result<PreparedPageOwnershipDocument, StoreError> {
    let update = prepare_block_transfer_source_update(
        &base.authority.head.id,
        base.schema,
        &base.full_state,
        &base.authority.head.state_vector,
        root_block_ids,
        operation_id,
    )?
    .update;
    Ok(PreparedPageOwnershipDocument {
        authority: base.authority,
        engine: base.engine,
        full_state: base.full_state,
        base_materialization: base.base_materialization,
        schema: base.schema,
        update,
    })
}

fn recompile_page_ownership_document_update(
    document: &mut PreparedPageOwnershipDocument,
    operations: &[DocumentBlockOperation],
    operation_id: &str,
) -> Result<(), StoreError> {
    document.update = prepare_block_transfer_update_with_editable_remainder(
        &document.authority.head.id,
        document.schema,
        &document.full_state,
        &document.authority.head.state_vector,
        operations.to_vec(),
        operation_id,
    )
    .map_err(|error| invalid(format!("Page parent update is invalid: {error}")))?
    .update;
    Ok(())
}

fn embedded_page_shell(page_id: &str) -> MaterializedBlockNode {
    MaterializedBlockNode {
        id: page_id.to_owned(),
        block_type: "page".to_owned(),
        props: BTreeMap::new(),
        content: None,
        children: Vec::new(),
    }
}

fn prepare_page_ownership_transfer(
    connection: &Connection,
    context: &BoundModuleContext,
    library_id: &str,
    operation_id: &str,
    intent: &LibraryBlockTransferLogicalIntent,
    authority: PageOwnershipTransferAuthority<'_>,
    cache: Option<&Arc<Mutex<crate::document::DocumentRuntimeCache>>>,
) -> Result<PreparedPageOwnershipTransfer, StoreError> {
    check_request_interruption()?;
    let requesting_project_id = authority.actor_project_id();
    require_project_in_library(connection, requesting_project_id, library_id)?;
    let mut source_document_base = None;
    let source = match &intent.source {
        LibraryBlockTransferSource::Library {
            library_id: source_library_id,
        } => {
            if source_library_id != library_id {
                return Err(unauthorized(
                    "Block transfer source belongs to another Library",
                ));
            }
            PreparedPageOwnershipSource::Library
        }
        LibraryBlockTransferSource::DataSource { data_source_id } => {
            if intent.mode == LibraryBlockTransferMode::Copy {
                validate_page_copy_data_source_source(
                    connection,
                    library_id,
                    requesting_project_id,
                    data_source_id,
                )?
            } else if authority.is_prevalidated() {
                validate_page_transfer_data_source_source_prevalidated(
                    connection,
                    library_id,
                    requesting_project_id,
                    data_source_id,
                )?
            } else {
                validate_page_transfer_data_source_source(
                    connection,
                    library_id,
                    requesting_project_id,
                    data_source_id,
                )?
            };
            PreparedPageOwnershipSource::DataSource {
                data_source_id: data_source_id.clone(),
            }
        }
        LibraryBlockTransferSource::Page { page_id } => {
            let document_id = resolve_page_document(connection, library_id, page_id)?;
            let base = if authority.is_prevalidated() {
                load_page_ownership_document_prevalidated(
                    connection,
                    library_id,
                    &document_id,
                    cache,
                )?
            } else {
                load_page_ownership_document(
                    connection,
                    context,
                    library_id,
                    &document_id,
                    if intent.mode == LibraryBlockTransferMode::Copy {
                        TransferDocumentAccess::Read
                    } else {
                        TransferDocumentAccess::Write
                    },
                    cache,
                )?
            };
            if base.page_id != *page_id {
                return Err(corrupt("Source Page Document owner is inconsistent"));
            }
            source_document_base = Some(base);
            PreparedPageOwnershipSource::Document {
                document_id,
                page_id: page_id.clone(),
            }
        }
        LibraryBlockTransferSource::Document { document_id } => {
            let base = if authority.is_prevalidated() {
                load_page_ownership_document_prevalidated(
                    connection,
                    library_id,
                    document_id,
                    cache,
                )?
            } else {
                load_page_ownership_document(
                    connection,
                    context,
                    library_id,
                    document_id,
                    if intent.mode == LibraryBlockTransferMode::Copy {
                        TransferDocumentAccess::Read
                    } else {
                        TransferDocumentAccess::Write
                    },
                    cache,
                )?
            };
            let page_id = base.page_id.clone();
            source_document_base = Some(base);
            PreparedPageOwnershipSource::Document {
                document_id: document_id.clone(),
                page_id,
            }
        }
    };
    let mut target_document_base = None;
    let target = match &intent.target {
        LibraryBlockTransferTarget::Library {
            library_id: target_library_id,
            before_block_id,
        } => {
            if target_library_id != library_id {
                return Err(unauthorized(
                    "Block transfer target belongs to another Library",
                ));
            }
            if before_block_id
                .as_ref()
                .is_some_and(|anchor| intent.root_block_ids.contains(anchor))
            {
                return Err(invalid("A moved Page cannot be its own placement anchor"));
            }
            if let Some(anchor) = before_block_id {
                read_library_anchor(connection, library_id, anchor)?;
            }
            PreparedPageOwnershipTarget::Library {
                before_block_id: before_block_id.clone(),
            }
        }
        LibraryBlockTransferTarget::DataSource {
            data_source_id,
            placement,
        } => {
            let destination = if authority.is_prevalidated() {
                let LibraryBlockTransferDataSourcePlacement::Direct {
                    view_id,
                    preferences_override: _,
                    group_key,
                    before_page_id,
                    sorted_property_values: _,
                } = placement.as_ref()
                else {
                    return Err(invalid(
                        "Agent Page movement does not accept renderer List occurrence targets",
                    ));
                };
                if before_page_id
                    .as_ref()
                    .is_some_and(|anchor| intent.root_block_ids.contains(anchor))
                {
                    return Err(invalid("A moved Page cannot be its own placement anchor"));
                }
                resolve_page_transfer_data_source_destination_prevalidated(
                    connection,
                    library_id,
                    authority.actor_project_id(),
                    data_source_id,
                    view_id,
                    group_key.as_deref(),
                    before_page_id.as_deref(),
                )?
            } else {
                resolve_data_source_placement(
                    connection,
                    library_id,
                    requesting_project_id,
                    data_source_id,
                    placement,
                )?
            };
            PreparedPageOwnershipTarget::DataSource { destination }
        }
        LibraryBlockTransferTarget::Page {
            page_id,
            parent_block_id,
            before_block_id,
        } => {
            let document_id = resolve_page_document(connection, library_id, page_id)?;
            let base = if authority.is_prevalidated() {
                load_page_ownership_document_prevalidated(
                    connection,
                    library_id,
                    &document_id,
                    cache,
                )?
            } else {
                load_page_ownership_document(
                    connection,
                    context,
                    library_id,
                    &document_id,
                    TransferDocumentAccess::Write,
                    cache,
                )?
            };
            if base.page_id != *page_id {
                return Err(corrupt("Target Page Document owner is inconsistent"));
            }
            target_document_base = Some(base);
            PreparedPageOwnershipTarget::Document {
                document_id,
                page_id: page_id.clone(),
                parent_block_id: parent_block_id.clone(),
                before_block_id: before_block_id.clone(),
            }
        }
        LibraryBlockTransferTarget::Document {
            document_id,
            parent_block_id,
            before_block_id,
        } => {
            let base = load_page_ownership_document(
                connection,
                context,
                library_id,
                document_id,
                TransferDocumentAccess::Write,
                cache,
            )?;
            let page_id = base.page_id.clone();
            target_document_base = Some(base);
            PreparedPageOwnershipTarget::Document {
                document_id: document_id.clone(),
                page_id,
                parent_block_id: parent_block_id.clone(),
                before_block_id: before_block_id.clone(),
            }
        }
    };
    if intent.mode == LibraryBlockTransferMode::Move
        && (matches!(
            (&source, &target),
            (
                PreparedPageOwnershipSource::Library,
                PreparedPageOwnershipTarget::Library { .. }
            )
        ) || matches!(
            (&source, &target),
            (
                PreparedPageOwnershipSource::Document { document_id: source, .. },
                PreparedPageOwnershipTarget::Document { document_id: target, .. }
            ) if source == target
        ))
    {
        return Err(invalid("Page already belongs to the requested parent"));
    }
    if intent.mode == LibraryBlockTransferMode::Move
        && let PreparedPageOwnershipTarget::Document {
            page_id: target_page_id,
            ..
        } = &target
    {
        for root_page_id in &intent.root_block_ids {
            check_request_interruption()?;
            let cycle = connection
                .query_row(
                    "WITH RECURSIVE descendants(page_id) AS ( \
                       SELECT ?1 UNION ALL \
                       SELECT page.block_id FROM pages page \
                       JOIN blocks block ON block.id = page.block_id \
                         AND block.library_id = page.library_id \
                       JOIN descendants parent \
                         ON page.parent_kind = 'page' AND page.parent_id = parent.page_id \
                       WHERE block.lifecycle = 'active' \
                     ) SELECT 1 FROM descendants WHERE page_id = ?2 LIMIT 1",
                    params![root_page_id, target_page_id],
                    |_| Ok(()),
                )
                .optional()?;
            if cycle.is_some() {
                return Err(invalid("A Page cannot move below its ownership subtree"));
            }
        }
    }

    let mut roots = Vec::with_capacity(intent.root_block_ids.len());
    for page_id in &intent.root_block_ids {
        check_request_interruption()?;
        let row = connection
            .query_row(
                "SELECT block.library_id, block.type, block.lifecycle, \
                   block.placement_revision, page.parent_kind, page.parent_id \
                 FROM blocks block LEFT JOIN pages page ON page.block_id = block.id \
                 WHERE block.id = ?1",
                [page_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, Option<String>>(5)?,
                    ))
                },
            )
            .optional()?
            .ok_or_else(|| not_found(format!("Transferred Page does not exist: {page_id}")))?;
        let (
            root_library_id,
            block_type,
            block_lifecycle,
            location_revision,
            parent_kind,
            parent_id,
        ) = row;
        // Agent Page movement has already authorized each exact source Page
        // against its call-scoped overlay at the operation boundary.
        if !authority.is_prevalidated() {
            if intent.mode == LibraryBlockTransferMode::Copy {
                super::require_page_read_access(
                    connection,
                    library_id,
                    requesting_project_id,
                    page_id,
                )?;
            } else {
                super::require_page_write_access(
                    connection,
                    library_id,
                    requesting_project_id,
                    page_id,
                )?;
            }
        }
        if root_library_id != library_id || block_type != "page" || block_lifecycle != "active" {
            return Err(invalid(
                "Page ownership transfer requires active Page roots",
            ));
        }
        let parent_revision = location_revision;
        let source_membership = match &source {
            PreparedPageOwnershipSource::Library => {
                if parent_kind.as_deref() != Some("library")
                    || parent_id.as_deref() != Some(library_id)
                    || connection
                        .query_row(
                            "SELECT 1 FROM library_block_placements \
                             WHERE block_id = ?1 AND library_id = ?2",
                            params![page_id, library_id],
                            |_| Ok(()),
                        )
                        .optional()?
                        .is_none()
                {
                    return Err(StoreError::new(
                        StoreErrorCode::RevisionConflict,
                        format!("Page {page_id} no longer belongs to the source Library"),
                        true,
                    ));
                }
                None
            }
            PreparedPageOwnershipSource::DataSource { data_source_id } => {
                if parent_kind.as_deref() != Some("data_source")
                    || parent_id.as_deref() != Some(data_source_id)
                {
                    return Err(StoreError::new(
                        StoreErrorCode::RevisionConflict,
                        format!("Page {page_id} no longer belongs to the source Data Source"),
                        true,
                    ));
                }
                let membership = connection
                    .query_row(
                        "SELECT id, revision FROM data_source_page_memberships \
                         WHERE page_block_id = ?1 AND data_source_id = ?2 \
                           AND removed_at IS NULL",
                        params![page_id, data_source_id],
                        |row| {
                            Ok(PreparedTransferMembership {
                                membership_id: row.get(0)?,
                                revision: row.get(1)?,
                            })
                        },
                    )
                    .optional()?
                    .ok_or_else(|| corrupt("Data Source Page has no active membership"))?;
                Some(membership)
            }
            PreparedPageOwnershipSource::Document {
                document_id: _,
                page_id: source_page_id,
            } => {
                if parent_kind.as_deref() != Some("page")
                    || parent_id.as_deref() != Some(source_page_id)
                {
                    return Err(StoreError::new(
                        StoreErrorCode::RevisionConflict,
                        format!("Page {page_id} no longer belongs to the source Document"),
                        true,
                    ));
                }
                None
            }
        };
        let shell = source_document_base
            .as_ref()
            .and_then(|document| {
                find_materialized_block(&document.base_materialization.block_tree, page_id)
            })
            .unwrap_or_else(|| embedded_page_shell(page_id));
        if shell.block_type != "page" || !shell.children.is_empty() {
            return Err(corrupt("Embedded Page shell is not canonical"));
        }
        let (owned_document_id, owned_document_generation, owned_document_head_seq, readiness) =
            connection.query_row(
                "SELECT document.id, document.generation, document.head_seq, document.readiness \
                     FROM pages page JOIN documents document ON document.id = page.document_id \
                     WHERE page.block_id = ?1 AND page.library_id = ?2",
                params![page_id, library_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                },
            )?;
        if readiness != "ready" {
            return Err(invalid("Page copy source Document is not ready"));
        }
        roots.push(PreparedPageOwnershipRoot {
            page_id: page_id.clone(),
            library_id: root_library_id,
            location_revision,
            parent_revision,
            source_membership,
            shell,
            owned_document_id,
            owned_document_generation,
            owned_document_head_seq,
        });
    }
    let mut copy_document_heads = Vec::new();
    let mut copy_destination = None;
    let (source_document, target_document) = if intent.mode == LibraryBlockTransferMode::Move {
        let source_document = source_document_base
            .map(|base| {
                let root_block_ids = roots
                    .iter()
                    .map(|root| root.page_id.clone())
                    .collect::<Vec<_>>();
                prepare_page_ownership_source_document_update(base, &root_block_ids, operation_id)
            })
            .transpose()?;
        let target_document = target_document_base
            .map(|base| {
                let PreparedPageOwnershipTarget::Document {
                    parent_block_id,
                    before_block_id,
                    ..
                } = &target
                else {
                    return Err(corrupt("Target Document preparation lost its target"));
                };
                let operations = roots
                    .iter()
                    .map(|root| DocumentBlockOperation::InsertBlock {
                        block: root.shell.clone(),
                        parent_block_id: parent_block_id.clone(),
                        before_block_id: before_block_id.clone(),
                    })
                    .collect::<Vec<_>>();
                prepare_page_ownership_document_update(base, &operations)
            })
            .transpose()?;
        (source_document, target_document)
    } else {
        if let Some(document) = &source_document_base {
            copy_document_heads.push(LibraryBlockTransferDocumentHead {
                document_id: document.authority.head.id.clone(),
                generation: document.authority.head.generation,
                expected_head_seq: document.authority.head.head_seq,
            });
        }
        if let Some(document) = &target_document_base {
            copy_document_heads.push(LibraryBlockTransferDocumentHead {
                document_id: document.authority.head.id.clone(),
                generation: document.authority.head.generation,
                expected_head_seq: document.authority.head.head_seq,
            });
        }
        for root in &roots {
            check_request_interruption()?;
            copy_document_heads.extend(page_copy_closure_document_heads(
                connection,
                operation_id,
                &root.library_id,
                &root.page_id,
                &root.owned_document_id,
            )?);
        }
        copy_document_heads.sort_by(|left, right| left.document_id.cmp(&right.document_id));
        copy_document_heads.dedup_by(|left, right| left.document_id == right.document_id);
        copy_destination = Some(match &target {
            PreparedPageOwnershipTarget::Library { before_block_id } => {
                LibraryPageCopyDestination::Library {
                    before: before_block_id
                        .as_deref()
                        .map(|block_id| read_library_anchor(connection, library_id, block_id))
                        .transpose()?,
                }
            }
            PreparedPageOwnershipTarget::DataSource { destination, .. } => {
                LibraryPageCopyDestination::DataSource {
                    data_source_id: destination.data_source_id.clone(),
                    expected_data_source_revision: destination.expected_data_source_revision,
                    values: destination
                        .values
                        .iter()
                        .map(|value| LibraryPageCopyValue {
                            property_id: value.property_id.clone(),
                            value: value.value.clone(),
                        })
                        .collect(),
                    view: destination
                        .view
                        .as_ref()
                        .map(|view| LibraryPageCopyViewPlacement {
                            view_id: view.view_id.clone(),
                            expected_view_revision: view.expected_view_revision,
                            group_key: view.group_key.clone(),
                            before: view.before.as_ref().map(|anchor| {
                                LibraryPageCopyPositionAnchor {
                                    page_id: anchor.page_id.clone(),
                                    expected_position_revision: anchor.expected_position_revision,
                                }
                            }),
                        }),
                }
            }
            PreparedPageOwnershipTarget::Document { page_id, .. } => {
                let document = target_document_base
                    .as_ref()
                    .ok_or_else(|| corrupt("Page copy target Document disappeared"))?;
                LibraryPageCopyDestination::Page {
                    page_id: page_id.clone(),
                    expected_document_generation: document.authority.head.generation,
                    expected_document_head_seq: document.authority.head.head_seq,
                    before: None,
                }
            }
        });
        let target_document = target_document_base
            .map(|base| {
                let PreparedPageOwnershipTarget::Document {
                    parent_block_id,
                    before_block_id,
                    ..
                } = &target
                else {
                    return Err(corrupt("Page copy target Document disappeared"));
                };
                let operations = roots
                    .iter()
                    .map(|root| DocumentBlockOperation::InsertBlock {
                        block: embedded_page_shell(&stable_uuid_v7(
                            operation_id,
                            "block",
                            &root.page_id,
                        )),
                        parent_block_id: parent_block_id.clone(),
                        before_block_id: before_block_id.clone(),
                    })
                    .collect::<Vec<_>>();
                prepare_page_ownership_document_update(base, &operations)
            })
            .transpose()?;
        (None, target_document)
    };
    Ok(PreparedPageOwnershipTransfer {
        roots,
        source,
        target,
        source_document,
        target_document,
        copy_document_heads,
        copy_destination,
    })
}

fn page_ownership_read_set(prepared: &PreparedPageOwnershipTransfer) -> PreparedTransferReadSet {
    let mut documents = prepared
        .source_document
        .iter()
        .chain(prepared.target_document.iter())
        .map(|document| LibraryBlockTransferDocumentHead {
            document_id: document.authority.head.id.clone(),
            generation: document.authority.head.generation,
            expected_head_seq: document.authority.head.head_seq,
        })
        .collect::<Vec<_>>();
    documents.extend(prepared.copy_document_heads.clone());
    documents.sort_by(|left, right| left.document_id.cmp(&right.document_id));
    documents.dedup_by(|left, right| left.document_id == right.document_id);
    let location_revisions = prepared
        .roots
        .iter()
        .map(|root| (root.page_id.clone(), root.location_revision))
        .collect();
    let source_memberships = prepared
        .roots
        .iter()
        .filter_map(|root| {
            root.source_membership
                .clone()
                .map(|membership| (root.page_id.clone(), membership))
        })
        .collect();
    PreparedTransferReadSet {
        documents,
        location_revisions,
        source_memberships,
    }
}

#[allow(clippy::too_many_arguments)]
fn apply_page_ownership_transfer(
    connection: &Connection,
    context: &BoundModuleContext,
    library_id: &str,
    operation_id: &str,
    store_epoch: &str,
    request_hash: &str,
    intent: &LibraryBlockTransferLogicalIntent,
    assets_root: &Path,
    authority: PageOwnershipTransferAuthority<'_>,
    history: PageOwnershipHistory,
    attached_scope: Option<&DurableMutationScope<'_>>,
    mut prepared: PreparedPageOwnershipTransfer,
) -> Result<LibraryApplyOutcome, StoreError> {
    let now = sqlite_now(connection)?;
    let apply = |scope: &DurableMutationScope<'_>| {
        if intent.mode == LibraryBlockTransferMode::Copy {
            return apply_page_ownership_copy(
                scope,
                context,
                library_id,
                operation_id,
                request_hash,
                intent,
                prepared,
                assets_root,
                &now,
            );
        }
        let requesting_project_id = authority.actor_project_id();
        let mut affected_database_ids = BTreeSet::new();
        let mut affected_view_ids = BTreeSet::new();
        let mut committed_revisions = BTreeMap::new();
        let mut document_commits = Vec::new();
        let mut staged_final_locations = BTreeMap::new();
        let mut staged_final_location_revisions = BTreeMap::new();
        let root_page_ids = prepared
            .roots
            .iter()
            .map(|root| root.page_id.clone())
            .collect::<Vec<_>>();
        let prepared_relocation_undo = if matches!(history, PageOwnershipHistory::RecordRelocation)
        {
            Some(capture_page_relocation_undo_source(
                connection, library_id, &prepared,
            )?)
        } else {
            None
        };
        // Remove Page shells from their old Document before changing the typed
        // parent. The Page invariant forbids a Library/Data Source root from
        // simultaneously remaining in a Document index.
        if let Some(mut document) = prepared.source_document.take() {
            let update_id = format!(
                "block-transfer-page-parent-source:{}",
                sha256(request_hash.as_bytes())
            );
            let update = document.update;
            document_commits.push(persist_prepared_update(
                connection,
                requesting_project_id,
                &document.authority,
                &document.base_materialization,
                &mut document.engine,
                update,
                &update_id,
                operation_id,
                store_epoch,
                TransferDocumentPlacement::Derived {
                    advances: &[],
                    exact_moves: &[],
                },
                &root_page_ids,
                scope.evidence(),
            )?);
        }
        for root in &prepared.roots {
            check_request_interruption()?;
            let expected_membership_revision = root
                .source_membership
                .as_ref()
                .map_or(0, |membership| membership.revision);
            let transfer_page = |target| {
                if authority.is_prevalidated() {
                    transfer_existing_page_for_agent_move_prevalidated(
                        connection,
                        library_id,
                        requesting_project_id,
                        &root.page_id,
                        root.parent_revision,
                        expected_membership_revision,
                        target,
                        &now,
                        false,
                    )
                } else {
                    transfer_existing_page_for_block_transfer(
                        connection,
                        library_id,
                        requesting_project_id,
                        &root.page_id,
                        root.parent_revision,
                        expected_membership_revision,
                        target,
                        &now,
                    )
                }
            };
            let placement = match &prepared.target {
                PreparedPageOwnershipTarget::Library { .. } => {
                    transfer_page(ExistingPageTransferTarget::Library)?
                }
                PreparedPageOwnershipTarget::DataSource { destination, .. } => {
                    transfer_page(ExistingPageTransferTarget::DataSource(destination))?
                }
                PreparedPageOwnershipTarget::Document { page_id, .. } => {
                    transfer_page(ExistingPageTransferTarget::Page { page_id })?
                }
            };
            if let PreparedPageOwnershipTarget::Library { before_block_id } = &prepared.target {
                connection.execute(
                    "DELETE FROM library_block_placements WHERE block_id = ?1 AND library_id = ?2",
                    params![root.page_id, library_id],
                )?;
                let anchor = before_block_id
                    .as_deref()
                    .map(|block_id| read_library_anchor(connection, library_id, block_id))
                    .transpose()?;
                insert_library_placement(
                    connection,
                    library_id,
                    &root.page_id,
                    anchor.as_ref(),
                    &now,
                )?;
            }
            let staged_location = match &prepared.target {
                PreparedPageOwnershipTarget::Library { .. } => {
                    let rank_key = connection
                        .query_row(
                            "SELECT rank_key FROM library_block_placements \
                             WHERE library_id = ?1 AND block_id = ?2",
                            params![library_id, root.page_id],
                            |row| row.get::<_, String>(0),
                        )
                        .optional()?
                        .ok_or_else(|| corrupt("Moved root Page lost its Library placement"))?;
                    LibraryBlockLocation::Library {
                        library_id: library_id.to_owned(),
                        rank_key,
                    }
                }
                PreparedPageOwnershipTarget::DataSource { .. } => {
                    LibraryBlockLocation::DataSource {
                        database_id: placement.database_id.clone().ok_or_else(|| {
                            corrupt("Moved Page lost its destination Database authority")
                        })?,
                        data_source_id: placement.data_source_id.clone().ok_or_else(|| {
                            corrupt("Moved Page lost its destination Data Source membership")
                        })?,
                    }
                }
                PreparedPageOwnershipTarget::Document { document_id, .. } => {
                    LibraryBlockLocation::Document {
                        document_id: document_id.clone(),
                    }
                }
            };
            staged_final_locations.insert(root.page_id.clone(), staged_location);
            staged_final_location_revisions
                .insert(root.page_id.clone(), placement.location_revision);
            affected_database_ids.extend(placement.affected_database_ids);
            affected_view_ids.extend(placement.affected_view_ids);
            committed_revisions.extend(placement.committed_revisions);
            committed_revisions.insert(
                format!("blockLocation:{}", root.page_id),
                placement.location_revision,
            );
            committed_revisions.insert(
                format!("blockMetadata:{}", root.page_id),
                placement.metadata_revision,
            );
            committed_revisions.insert(
                format!("pageParent:{}", root.page_id),
                placement.parent_revision,
            );
            if let (Some(database_id), Some(data_source_id), Some(membership_id)) = (
                placement.database_id,
                placement.data_source_id,
                placement.membership_id,
            ) {
                affected_database_ids.insert(database_id);
                committed_revisions
                    .entry(format!("membership:{data_source_id}:{membership_id}"))
                    .or_insert(1);
            }
        }
        if let Some(mut document) = prepared.target_document.take() {
            let update_id = format!(
                "block-transfer-page-parent-target:{}",
                sha256(request_hash.as_bytes())
            );
            let update = document.update;
            document_commits.push(persist_prepared_update(
                connection,
                requesting_project_id,
                &document.authority,
                &document.base_materialization,
                &mut document.engine,
                update,
                &update_id,
                operation_id,
                store_epoch,
                TransferDocumentPlacement::Preapplied(&root_page_ids),
                &[],
                scope.evidence(),
            )?);
        }
        if let PageOwnershipHistory::UndoRelocation { recipe, token } = &history {
            let (restored_view_ids, restored_revisions) =
                restore_page_relocation_positions(connection, recipe, &now)?;
            affected_view_ids.extend(restored_view_ids);
            committed_revisions.extend(restored_revisions);
            history::consume(
                connection,
                token,
                &recipe.project_id,
                &now,
                scope.evidence(),
            )?;
        }
        let result_block_ids = root_page_ids;
        // Agent Page moves merge every touched Document into one deterministic
        // batch after the per-Page typed-parent transfers. Until that batch is
        // persisted, a Page can intentionally have its new typed parent while
        // its old/new Document index still reflects the prepared base. Report
        // the staged target from this transaction phase; the outer operation
        // verifies the authoritative physical locations after the shared batch.
        let (final_locations, final_location_revisions) = if attached_scope.is_some() {
            (staged_final_locations, staged_final_location_revisions)
        } else {
            read_final_locations(connection, &result_block_ids)?
        };
        let pending_relocation_undo = prepared_relocation_undo
            .map(|prepared_undo| {
                let result_location_revision = final_location_revisions
                    .get(&prepared_undo.page_id)
                    .copied()
                    .ok_or_else(|| corrupt("Page relocation lost its final location revision"))?;
                seal_page_relocation_undo_recipe(
                    operation_id,
                    store_epoch,
                    library_id,
                    requesting_project_id,
                    &prepared.target,
                    result_location_revision,
                    prepared_undo,
                )
            })
            .transpose()?;
        let affected_database_ids = affected_database_ids.into_iter().collect::<Vec<_>>();
        let affected_view_ids = affected_view_ids.into_iter().collect::<Vec<_>>();
        let page_etags = result_block_ids
            .iter()
            .map(|page_id| {
                super::page_projection::mint_page_shell_etag(
                    connection,
                    library_id,
                    requesting_project_id,
                    store_epoch,
                    page_id,
                )
                .map(|etag| (page_id.clone(), etag))
            })
            .collect::<Result<BTreeMap<_, _>, _>>()?;
        let target_view = match &prepared.target {
            PreparedPageOwnershipTarget::DataSource { destination, .. } => {
                destination.view.as_ref()
            }
            PreparedPageOwnershipTarget::Library { .. }
            | PreparedPageOwnershipTarget::Document { .. } => None,
        };
        let target_view_id = target_view.map(|view| view.view_id.as_str());
        let move_etags = if !authority.is_agent() {
            result_block_ids
                .iter()
                .map(|page_id| {
                    if authority.is_prevalidated() {
                        crate::database::mint_page_move_etag_prevalidated(
                            connection,
                            library_id,
                            requesting_project_id,
                            store_epoch,
                            page_id,
                            target_view_id,
                        )
                    } else {
                        crate::database::mint_page_move_etag(
                            connection,
                            library_id,
                            requesting_project_id,
                            store_epoch,
                            page_id,
                            target_view_id,
                        )
                    }
                    .map(|etag| (page_id.clone(), etag))
                })
                .collect::<Result<BTreeMap<_, _>, _>>()?
        } else {
            BTreeMap::new()
        };
        let mut page_view_placements = BTreeMap::new();
        if let Some(view) = target_view {
            for page_id in &result_block_ids {
                let position_revision = connection
                    .query_row(
                        "SELECT revision FROM database_view_page_positions \
                         WHERE view_id = ?1 AND page_block_id = ?2",
                        params![view.view_id, page_id],
                        |row| row.get::<_, i64>(0),
                    )
                    .optional()?;
                let Some(position_revision) = position_revision else {
                    continue;
                };
                page_view_placements.insert(
                    page_id.clone(),
                    LibraryPageViewPlacementResult {
                        view_id: view.view_id.clone(),
                        group_key: view.group_key.clone(),
                        position_revision,
                    },
                );
            }
        }
        // Transfer accepts a bounded run of Page roots, so the receipt keeps a
        // root-indexed map rather than a singular key. `None` remains
        // meaningful after a move to Library or another Page.
        let page_keys = read_current_page_keys(connection, library_id, &result_block_ids)?;
        let relocation_undo_result = match &history {
            PageOwnershipHistory::UndoRelocation { recipe, token } => {
                let final_location = final_locations
                    .get(&recipe.page_id)
                    .cloned()
                    .ok_or_else(|| corrupt("Relocation Undo lost the restored Page location"))?;
                let final_location_revision = final_location_revisions
                    .get(&recipe.page_id)
                    .copied()
                    .ok_or_else(|| corrupt("Relocation Undo lost the restored Page revision"))?;
                Some(LibraryPageRelocationUndoResult {
                    transfer_operation_id: token.transfer_operation_id.clone(),
                    page_id: recipe.page_id.clone(),
                    final_location,
                    final_location_revision,
                    document_commits: document_commits
                        .iter()
                        .map(|commit| commit.public.clone())
                        .collect(),
                    affected_database_ids: affected_database_ids.clone(),
                    page_key: page_keys.get(&recipe.page_id).cloned().flatten(),
                })
            }
            PageOwnershipHistory::None | PageOwnershipHistory::RecordRelocation => None,
        };
        let result = LibraryBlockTransferResult {
            mode: LibraryBlockTransferMode::Move,
            source_root_block_ids: intent.root_block_ids.clone(),
            result_root_block_ids: result_block_ids.clone(),
            copied_block_ids: BTreeMap::new(),
            transformation_evidence: Vec::new(),
            final_locations,
            final_location_revisions: final_location_revisions.clone(),
            document_commits: document_commits
                .iter()
                .map(|commit| commit.public.clone())
                .collect(),
            affected_database_ids: affected_database_ids.clone(),
            page_keys,
            page_etags,
            move_etags,
            page_view_placements,
            undo_token: pending_relocation_undo
                .as_ref()
                .map(|pending| pending.token.clone()),
            history: None,
        };
        committed_revisions.extend(
            final_location_revisions
                .iter()
                .map(|(block_id, revision)| (format!("blockLocation:{block_id}"), *revision)),
        );
        committed_revisions.extend(document_commits.iter().map(|commit| {
            (
                format!("documentHead:{}", commit.public.document_id),
                commit.public.head_seq,
            )
        }));
        let mut affected_parent_keys = match &prepared.source {
            PreparedPageOwnershipSource::Library => vec![format!("library:{library_id}")],
            PreparedPageOwnershipSource::DataSource { data_source_id, .. } => {
                vec![format!("data_source:{data_source_id}")]
            }
            PreparedPageOwnershipSource::Document { page_id, .. } => {
                vec![format!("page:{page_id}")]
            }
        };
        affected_parent_keys.push(match &prepared.target {
            PreparedPageOwnershipTarget::Library { .. } => format!("library:{library_id}"),
            PreparedPageOwnershipTarget::DataSource { destination, .. } => {
                format!("data_source:{}", destination.data_source_id)
            }
            PreparedPageOwnershipTarget::Document { page_id, .. } => format!("page:{page_id}"),
        });
        affected_parent_keys.sort();
        affected_parent_keys.dedup();
        let mut affected_page_ids = prepared
            .roots
            .iter()
            .map(|root| root.page_id.clone())
            .collect::<Vec<_>>();
        if let PreparedPageOwnershipSource::Document { page_id, .. } = &prepared.source {
            affected_page_ids.push(page_id.clone());
        }
        if let PreparedPageOwnershipTarget::Document { page_id, .. } = &prepared.target {
            affected_page_ids.push(page_id.clone());
        }
        affected_page_ids.sort();
        affected_page_ids.dedup();
        let affected_document_ids = document_commits
            .iter()
            .map(|commit| commit.public.document_id.clone())
            .collect::<Vec<_>>();
        seal_mutation_with(
            scope,
            context,
            operation_id,
            MutationEffects {
                page_file_entries: Vec::new(),
                file_revisions: BTreeMap::new(),
                file_mutation: Default::default(),
                project_id: requesting_project_id.to_owned(),
                operation_kind: if relocation_undo_result.is_some() {
                    "undo_page_relocation"
                } else {
                    "transfer_blocks"
                },
                change_kind: "block_mutation",
                did_mutate: true,
                created_target: None,
                affected_parent_keys,
                affected_block_ids: result_block_ids.clone(),
                affected_page_ids,
                affected_database_ids,
                affected_view_ids,
                affected_document_ids,
                committed_revisions,
                page_create: None,
                page_copy: None,
                canvas_mutation: None,
                block_transfer: relocation_undo_result.is_none().then(|| result.clone()),
                block_transfer_undo: None,
                page_relocation_undo: relocation_undo_result,
                structural_edit: None,
                page_lifecycle: None,
                block_property_mutation: None,
                agent_page_copy: None,
                agent_create_pages: None,
                agent_move_pages: None,
                change_payload: None,
                committed_at: now.clone(),
            },
            |_, event_sequence| {
                persist_mutation_ledger(
                    connection,
                    operation_id,
                    requesting_project_id,
                    store_epoch,
                    request_hash,
                    intent,
                    &result,
                    event_sequence,
                    &now,
                )?;
                if let Some(pending) = &pending_relocation_undo {
                    history::persist(connection, pending, &now)?;
                }
                persist_operation_checkpoints(
                    connection,
                    context,
                    operation_id,
                    &intent.actor,
                    &document_commits,
                    event_sequence,
                    &now,
                )
            },
        )
    };
    if let Some(scope) = attached_scope {
        return Ok(LibraryApplyOutcome {
            committed: apply(scope)?.into_outcome(),
            event: None,
        });
    }
    let commit_result = durable_mutation::run(
        connection,
        OperationIdentity {
            module: ModuleName::Library,
            module_name: MODULE_NAME,
            operation_id,
            intent_hash: request_hash,
            store_epoch,
            committed_at: &now,
            context,
        },
        apply,
    )?;
    library_commit_result(connection, commit_result)
}

#[allow(clippy::too_many_arguments)]
fn apply_page_ownership_copy(
    scope: &DurableMutationScope<'_>,
    context: &BoundModuleContext,
    library_id: &str,
    operation_id: &str,
    request_hash: &str,
    intent: &LibraryBlockTransferLogicalIntent,
    mut prepared: PreparedPageOwnershipTransfer,
    assets_root: &Path,
    now: &str,
) -> Result<SealedOutcome<crate::ModuleWriterResult<LibraryCommitValue, LibraryReceipt>>, StoreError>
{
    let connection = scope.connection();
    let store_epoch = scope.store_epoch();
    let destination = prepared
        .copy_destination
        .as_ref()
        .ok_or_else(|| corrupt("Page copy preparation omitted its destination"))?;
    let mut copied_block_ids = BTreeMap::new();
    let mut result_root_block_ids = Vec::with_capacity(prepared.roots.len());
    let mut affected_page_ids = BTreeSet::new();
    let mut affected_database_ids = BTreeSet::new();
    let mut affected_view_ids = BTreeSet::new();
    let mut affected_document_ids = BTreeSet::new();
    let mut committed_revisions = BTreeMap::new();
    let mut document_commits = Vec::new();
    let mut checkpoint_commits = Vec::new();
    let mut actor_project_id = None;
    let mut affected_parent_keys = BTreeSet::new();
    let parent_document_mode = if prepared.target_document.is_some() {
        PageCopyParentDocumentMode::Defer
    } else {
        PageCopyParentDocumentMode::Commit
    };
    for root in &prepared.roots {
        check_request_interruption()?;
        let execution = execute_page_copy(
            connection,
            context,
            scope.evidence(),
            store_epoch,
            library_id,
            operation_id,
            &root.page_id,
            root.location_revision,
            root.parent_revision,
            root.source_membership
                .as_ref()
                .map_or(0, |membership| membership.revision),
            root.owned_document_generation,
            root.owned_document_head_seq,
            destination,
            parent_document_mode,
            false,
            assets_root,
            now,
        )?;
        if actor_project_id
            .as_ref()
            .is_some_and(|project_id| project_id != &execution.actor_project_id)
        {
            return Err(corrupt(
                "Page copy roots resolved to different actor Projects",
            ));
        }
        actor_project_id = Some(execution.actor_project_id.clone());
        affected_parent_keys.insert(execution.parent_key);
        affected_page_ids.extend(execution.affected_page_ids);
        affected_database_ids.extend(execution.affected_database_ids);
        affected_view_ids.extend(execution.affected_view_ids);
        affected_document_ids.extend(execution.affected_document_ids);
        committed_revisions.extend(execution.committed_revisions);
        document_commits.extend(execution.document_commits);
        result_root_block_ids.push(execution.result.page_id.clone());
        copied_block_ids.extend(execution.result.block_ids);
    }
    if let Some(mut document) = prepared.target_document.take() {
        let update_id = format!(
            "block-transfer-page-copy-target:{}",
            sha256(request_hash.as_bytes())
        );
        let update = document.update;
        let commit = persist_prepared_update(
            connection,
            bound_project_id(context)?,
            &document.authority,
            &document.base_materialization,
            &mut document.engine,
            update,
            &update_id,
            operation_id,
            store_epoch,
            TransferDocumentPlacement::Genesis(&result_root_block_ids),
            &[],
            scope.evidence(),
        )?;
        committed_revisions.insert(
            format!("documentHead:{}", commit.public.document_id),
            commit.public.head_seq,
        );
        affected_document_ids.insert(commit.public.document_id.clone());
        document_commits.push(commit.public.clone());
        checkpoint_commits.push(commit);
    }
    let (final_locations, final_location_revisions) =
        read_final_locations(connection, &result_root_block_ids)?;
    committed_revisions.extend(
        final_location_revisions
            .iter()
            .map(|(block_id, revision)| (format!("blockLocation:{block_id}"), *revision)),
    );
    let affected_database_ids = affected_database_ids.into_iter().collect::<Vec<_>>();
    let page_keys = read_current_page_keys(connection, library_id, &result_root_block_ids)?;
    let result = LibraryBlockTransferResult {
        mode: LibraryBlockTransferMode::Copy,
        source_root_block_ids: intent.root_block_ids.clone(),
        result_root_block_ids: result_root_block_ids.clone(),
        copied_block_ids: copied_block_ids.clone(),
        transformation_evidence: Vec::new(),
        final_locations,
        final_location_revisions: final_location_revisions.clone(),
        document_commits: document_commits.clone(),
        affected_database_ids: affected_database_ids.clone(),
        page_keys,
        page_etags: BTreeMap::new(),
        move_etags: BTreeMap::new(),
        page_view_placements: BTreeMap::new(),
        undo_token: None,
        history: None,
    };
    let actor_project_id =
        actor_project_id.ok_or_else(|| corrupt("Page copy produced no actor Project"))?;
    let affected_block_ids = copied_block_ids.values().cloned().collect::<Vec<_>>();
    seal_mutation_with(
        scope,
        context,
        operation_id,
        MutationEffects {
            page_file_entries: Vec::new(),
            file_revisions: BTreeMap::new(),
            file_mutation: Default::default(),
            project_id: actor_project_id.clone(),
            operation_kind: "transfer_blocks",
            change_kind: "block_mutation",
            did_mutate: true,
            created_target: None,
            affected_parent_keys: affected_parent_keys.into_iter().collect(),
            affected_block_ids,
            affected_page_ids: affected_page_ids.into_iter().collect(),
            affected_database_ids,
            affected_view_ids: affected_view_ids.into_iter().collect(),
            affected_document_ids: affected_document_ids.into_iter().collect(),
            committed_revisions,
            page_create: None,
            page_copy: None,
            canvas_mutation: None,
            block_transfer: Some(result.clone()),
            block_transfer_undo: None,
            page_relocation_undo: None,
            structural_edit: None,
            page_lifecycle: None,
            block_property_mutation: None,
            agent_page_copy: None,
            agent_create_pages: None,
            agent_move_pages: None,
            change_payload: None,
            committed_at: now.to_owned(),
        },
        |_, event_sequence| {
            persist_mutation_ledger(
                connection,
                operation_id,
                &actor_project_id,
                store_epoch,
                request_hash,
                intent,
                &result,
                event_sequence,
                now,
            )?;
            persist_operation_checkpoints(
                connection,
                context,
                operation_id,
                &intent.actor,
                &checkpoint_commits,
                event_sequence,
                now,
            )
        },
    )
}

fn prepare_page_parent_transfer(
    connection: &Connection,
    context: &BoundModuleContext,
    library_id: &str,
    operation_id: &str,
    intent: &LibraryBlockTransferLogicalIntent,
    cache: Option<&Arc<Mutex<crate::document::DocumentRuntimeCache>>>,
) -> Result<PreparedPageParentTransfer, StoreError> {
    check_request_interruption()?;
    let prepare_started_at = Instant::now();
    let project_id = bound_project_id(context)?;
    require_project_in_library(connection, project_id, library_id)?;
    let (actor_project_id, target) = match &intent.target {
        LibraryBlockTransferTarget::Library {
            library_id: target_library_id,
            before_block_id,
        } => {
            if target_library_id != library_id {
                return Err(unauthorized(
                    "Block transfer target belongs to another Library",
                ));
            }
            (
                project_id.to_owned(),
                PreparedPageParentTarget::Library {
                    before_block_id: before_block_id.clone(),
                },
            )
        }
        LibraryBlockTransferTarget::DataSource {
            data_source_id,
            placement,
        } => {
            let destination = resolve_data_source_placement(
                connection,
                library_id,
                project_id,
                data_source_id,
                placement,
            )?;
            (
                project_id.to_owned(),
                PreparedPageParentTarget::DataSource { destination },
            )
        }
        _ => {
            return Err(invalid(
                "Page-parent transfer requires a Library or Data Source target",
            ));
        }
    };
    let source_page_id = match &intent.source {
        LibraryBlockTransferSource::Page { page_id } => Some(page_id.as_str()),
        _ => None,
    };
    let source_document_id = resolve_source_document(connection, library_id, &intent.source)?;
    let source_authority = require_transfer_authority(
        connection,
        library_id,
        project_id,
        &source_document_id,
        source_page_id,
        match intent.mode {
            LibraryBlockTransferMode::Move => TransferDocumentAccess::Write,
            LibraryBlockTransferMode::Copy => TransferDocumentAccess::Read,
        },
    )?;
    let source_schema = require_schema(&source_authority)?;
    let reconstruct_started_at = Instant::now();
    let (source_engine, source_full_state) =
        clone_runtime_engine(connection, &source_authority.head, cache)?;
    let reconstruct_duration = reconstruct_started_at.elapsed();
    let decode_started_at = Instant::now();
    let source_decoded = decode_block_document(source_engine.document(), source_schema)
        .map_err(|error| corrupt(error.to_string()))?;
    let source_materialization = materialize_decoded_document(&source_decoded)
        .map_err(|error| corrupt(error.to_string()))?;
    let source_forest = crate::domain::subtree::capture_block_subtree_forest(
        &source_decoded.block_tree,
        &intent.root_block_ids,
    )
    .map_err(|error| invalid(error.to_string()))?;
    let decode_duration = decode_started_at.elapsed();
    for block_id in &source_forest.block_ids {
        if is_typed_resource(connection, block_id)? {
            return Err(invalid(
                "Page ownership roots use the recursive Page transfer compiler",
            ));
        }
    }
    let expected_location_revisions = validate_source_roots(
        connection,
        &source_authority.head.library_id,
        &source_document_id,
        &intent.root_block_ids,
    )?;
    let mut copied_block_ids = BTreeMap::new();
    let mut roots = Vec::with_capacity(source_forest.roots.len());
    let mut new_block_ids = Vec::new();
    let transform_started_at = Instant::now();
    for source_root in &source_forest.roots {
        check_request_interruption()?;
        let materialized = find_materialized_block(
            &source_materialization.block_tree,
            &source_root.root_block_id,
        )
        .ok_or_else(|| corrupt("Selected Block is absent from its materialization"))?;
        let source_to_result_block_ids = source_root
            .block_ids
            .iter()
            .map(|source_id| {
                let result_id = if intent.mode == LibraryBlockTransferMode::Copy {
                    stable_uuid_v7(operation_id, "block_transfer", source_id)
                } else {
                    source_id.clone()
                };
                (source_id.clone(), result_id)
            })
            .collect::<BTreeMap<_, _>>();
        if intent.mode == LibraryBlockTransferMode::Copy {
            copied_block_ids.extend(source_to_result_block_ids.clone());
        }
        let result_root = remap_materialized_block(&materialized, &source_to_result_block_ids)?;
        let result_root_id = source_to_result_block_ids
            .get(&source_root.root_block_id)
            .ok_or_else(|| corrupt("Page transformation omitted its result root"))?;
        let wrapper_page_id = stable_uuid_v7(
            operation_id,
            "block_transfer_wrapper",
            &source_root.root_block_id,
        );
        let empty_body_block_id = stable_uuid_v7(
            operation_id,
            "block_transfer_page_body",
            &source_root.root_block_id,
        );
        let transformation = plan_block_to_page_transformation(
            &result_root,
            result_root_id,
            &wrapper_page_id,
            &empty_body_block_id,
        )
        .map_err(|error| invalid(error.to_string()))?;
        let page_id = match &transformation {
            BlockToPageTransformation::Promote { page_id, .. }
            | BlockToPageTransformation::Wrap { page_id, .. }
            | BlockToPageTransformation::AlreadyPage { page_id } => page_id.clone(),
        };
        if matches!(
            transformation,
            BlockToPageTransformation::AlreadyPage { .. }
        ) {
            return Err(invalid(
                "Page ownership roots use the recursive Page transfer compiler",
            ));
        }
        let (promotion_evidence, task_shorthand) = prepare_task_shorthand_title_policy(
            intent.promotion_policy,
            matches!(target, PreparedPageParentTarget::DataSource { .. }),
            &transformation,
        );
        // A new promotion is a new Document lifetime, even when an earlier Undo
        // left this Block's previous Page Document dormant for Redo.
        let document_id = stable_uuid_v7(operation_id, "block_transfer_document", &page_id);
        require_fresh_page_authority(
            connection,
            &page_id,
            &document_id,
            &source_root.root_block_id,
        )?;
        new_block_ids.extend(
            transformation_result_blocks(&transformation)
                .into_iter()
                .filter(|block_id| {
                    intent.mode == LibraryBlockTransferMode::Copy
                        || block_id != &source_root.root_block_id
                            && !source_root.block_ids.contains(block_id)
                }),
        );
        let source_root_properties = connection
            .prepare(
                "SELECT property_key, value_type, value_json, revision \
                 FROM block_properties WHERE block_id = ?1 ORDER BY property_key",
            )?
            .query_map([&source_root.root_block_id], |row| {
                Ok(BlockTransferUndoBlockPropertyV1 {
                    property_key: row.get(0)?,
                    value_type: row.get(1)?,
                    value_json: row.get(2)?,
                    revision: row.get(3)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        roots.push(PreparedPageParentRoot {
            source_root_id: source_root.root_block_id.clone(),
            source_block_ids: source_root.block_ids.clone(),
            page_id,
            document_id,
            transformation,
            source_to_result_block_ids,
            promotion_evidence,
            task_shorthand,
            destination_values: None,
            source_root_type: materialized.block_type.clone(),
            source_root_properties,
        });
    }
    let task_shorthand_plan = if let PreparedPageParentTarget::DataSource { destination } = &target
    {
        let candidates = roots
            .iter()
            .filter_map(|root| {
                root.task_shorthand
                    .as_ref()
                    .map(|candidate| PageTaskShorthandCandidate {
                        root_id: root.source_root_id.clone(),
                        priority: candidate.priority,
                        estimate: candidate.estimate.clone(),
                        tag_names: candidate.tag_names.clone(),
                    })
            })
            .collect::<Vec<_>>();
        if candidates.is_empty() {
            None
        } else {
            Some(plan_page_task_shorthand(
                connection,
                library_id,
                project_id,
                operation_id,
                destination,
                &candidates,
            )?)
        }
    } else {
        None
    };
    if let Some(plan) = &task_shorthand_plan {
        for root in &mut roots {
            let Some(root_plan) = plan
                .roots
                .iter()
                .find(|candidate| candidate.root_id == root.source_root_id)
            else {
                if root.task_shorthand.is_some() {
                    let reason = match plan.preserved_reasons.get(&root.source_root_id) {
                        Some(PageTaskShorthandPreservedReason::TargetPropertyConflict) =>
                            nodex_core_contracts::library::LibraryTaskShorthandPreservedReason::TargetPropertyConflict,
                        Some(PageTaskShorthandPreservedReason::TagSchemaPermissionRequired) =>
                            nodex_core_contracts::library::LibraryTaskShorthandPreservedReason::TagSchemaPermissionRequired,
                        Some(PageTaskShorthandPreservedReason::TagOptionLimit) =>
                            nodex_core_contracts::library::LibraryTaskShorthandPreservedReason::TagOptionLimit,
                        Some(PageTaskShorthandPreservedReason::TargetSchemaIncompatible) | None =>
                            nodex_core_contracts::library::LibraryTaskShorthandPreservedReason::TargetSchemaIncompatible,
                    };
                    root.promotion_evidence = LibraryBlockTransferPromotionEvidence::Preserved {
                        grammar_version: TASK_SHORTHAND_GRAMMAR_VERSION,
                        reason,
                    };
                }
                continue;
            };
            if let (Some(candidate), BlockToPageTransformation::Promote { rich_title, .. }) =
                (&root.task_shorthand, &mut root.transformation)
            {
                *rich_title = candidate.rewritten_title.clone();
            }
            root.destination_values = Some(root_plan.values.clone());
            root.promotion_evidence = LibraryBlockTransferPromotionEvidence::Applied {
                grammar_version: TASK_SHORTHAND_GRAMMAR_VERSION,
                priority_option_id: root_plan.priority_option_id.clone(),
                estimate_option_id: root_plan.estimate_option_id.clone(),
                tag_option_ids: root_plan.tag_option_ids.clone(),
                tag_names: root_plan.tag_names.clone(),
                created_tag_option_ids: root_plan.created_tag_option_ids.clone(),
            };
        }
    }
    new_block_ids.sort();
    new_block_ids.dedup();
    assert_fresh_copy_identities(connection, &new_block_ids)?;
    let transform_duration = transform_started_at.elapsed();
    let encode_started_at = Instant::now();
    let source_preparation = if intent.mode == LibraryBlockTransferMode::Move {
        Some(prepare_block_transfer_source_update(
            &source_authority.head.id,
            source_schema,
            &source_full_state,
            &source_authority.head.state_vector,
            &intent.root_block_ids,
            operation_id,
        )?)
    } else {
        None
    };
    let source_placeholder_block_id = source_preparation
        .as_ref()
        .and_then(|prepared| prepared.placeholder_block_id.clone());
    let source_update = source_preparation.map(|prepared| prepared.update);
    let encode_duration = encode_started_at.elapsed();
    record_page_parent_prepare(
        prepare_started_at.elapsed(),
        reconstruct_duration,
        decode_duration,
        transform_duration,
        encode_duration,
    );
    Ok(PreparedPageParentTransfer {
        source_authority,
        source_engine,
        source_materialization,
        source_update,
        source_placeholder_block_id,
        roots,
        expected_location_revisions,
        copied_block_ids,
        actor_project_id,
        target,
        task_shorthand_plan,
    })
}

fn page_parent_read_set(prepared: &PreparedPageParentTransfer) -> PreparedTransferReadSet {
    PreparedTransferReadSet {
        documents: vec![LibraryBlockTransferDocumentHead {
            document_id: prepared.source_authority.head.id.clone(),
            generation: prepared.source_authority.head.generation,
            expected_head_seq: prepared.source_authority.head.head_seq,
        }],
        location_revisions: prepared.expected_location_revisions.clone(),
        source_memberships: BTreeMap::new(),
    }
}

fn find_materialized_block(
    blocks: &[MaterializedBlockNode],
    block_id: &str,
) -> Option<MaterializedBlockNode> {
    blocks.iter().find_map(|block| {
        if block.id == block_id {
            return Some(block.clone());
        }
        find_materialized_block(&block.children, block_id)
    })
}

fn remap_materialized_block(
    block: &MaterializedBlockNode,
    identities: &BTreeMap<String, String>,
) -> Result<MaterializedBlockNode, StoreError> {
    Ok(MaterializedBlockNode {
        id: identities
            .get(&block.id)
            .cloned()
            .ok_or_else(|| corrupt("Block transformation identity map is incomplete"))?,
        block_type: block.block_type.clone(),
        props: block.props.clone(),
        content: block.content.clone(),
        children: block
            .children
            .iter()
            .map(|child| remap_materialized_block(child, identities))
            .collect::<Result<_, _>>()?,
    })
}

fn transformation_result_blocks(transformation: &BlockToPageTransformation) -> Vec<String> {
    let mut result = Vec::new();
    match transformation {
        BlockToPageTransformation::Promote {
            page_id,
            body_roots,
            ..
        } => {
            result.push(page_id.clone());
            collect_materialized_block_ids(body_roots, &mut result);
        }
        BlockToPageTransformation::Wrap {
            page_id,
            wrapped_root,
            ..
        } => {
            result.push(page_id.clone());
            collect_materialized_block_ids(std::slice::from_ref(wrapped_root), &mut result);
        }
        BlockToPageTransformation::AlreadyPage { page_id } => result.push(page_id.clone()),
    }
    result
}

fn collect_materialized_block_ids(blocks: &[MaterializedBlockNode], output: &mut Vec<String>) {
    for block in blocks {
        output.push(block.id.clone());
        collect_materialized_block_ids(&block.children, output);
    }
}

fn require_fresh_page_authority(
    connection: &Connection,
    page_id: &str,
    document_id: &str,
    source_root_id: &str,
) -> Result<(), StoreError> {
    let page_collision = connection
        .query_row("SELECT type FROM blocks WHERE id = ?1", [page_id], |row| {
            row.get::<_, String>(0)
        })
        .optional()?;
    if page_collision.is_some() && page_id != source_root_id {
        return Err(invalid("Wrapper Page identity already exists"));
    }
    if connection
        .query_row(
            "SELECT 1 FROM documents WHERE id = ?1",
            [document_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some()
    {
        return Err(invalid(
            "Page transformation Document identity already exists",
        ));
    }
    Ok(())
}

fn prepared_transfer_read_set(prepared: &PreparedTransfer) -> PreparedTransferReadSet {
    let mut documents = vec![
        LibraryBlockTransferDocumentHead {
            document_id: prepared.source_authority.head.id.clone(),
            generation: prepared.source_authority.head.generation,
            expected_head_seq: prepared.source_authority.head.head_seq,
        },
        LibraryBlockTransferDocumentHead {
            document_id: prepared.target_authority.head.id.clone(),
            generation: prepared.target_authority.head.generation,
            expected_head_seq: prepared.target_authority.head.head_seq,
        },
    ];
    documents.sort_by(|left, right| left.document_id.cmp(&right.document_id));
    documents.dedup_by(|left, right| left.document_id == right.document_id);
    PreparedTransferReadSet {
        documents,
        location_revisions: prepared.expected_location_revisions.clone(),
        source_memberships: BTreeMap::new(),
    }
}

#[allow(clippy::too_many_arguments)]
fn read_task_shorthand_schema_restore(
    connection: &Connection,
    prepared: &PreparedPageParentTransfer,
) -> Result<Option<BlockTransferUndoSchemaRestoreV1>, StoreError> {
    let Some(plan) = &prepared.task_shorthand_plan else {
        return Ok(None);
    };
    if plan.new_tag_options.is_empty() {
        return Ok(None);
    }
    let PreparedPageParentTarget::DataSource { destination } = &prepared.target else {
        return Ok(None);
    };
    let pre_config_json = connection.query_row(
        "SELECT config_json FROM data_source_properties \
         WHERE data_source_id = ?1 AND id = 'tags' AND lifecycle = 'active'",
        [&destination.data_source_id],
        |row| row.get::<_, String>(0),
    )?;
    Ok(Some(BlockTransferUndoSchemaRestoreV1 {
        data_source_id: destination.data_source_id.clone(),
        property_id: "tags".to_owned(),
        pre_config_json,
        created_option_ids: plan
            .new_tag_options
            .iter()
            .map(|option| option.id.clone())
            .collect(),
    }))
}

fn block_transfer_target_guard_hash(
    connection: &Connection,
    roots: &[BlockTransferUndoRootV1],
    schema_restore: Option<&BlockTransferUndoSchemaRestoreV1>,
) -> Result<String, StoreError> {
    let mut guarded_pages = Vec::with_capacity(roots.len());
    for root in roots {
        let authority = connection
            .query_row(
                "SELECT block.type, block.lifecycle, block.placement_revision, \
                   block.metadata_revision, page.parent_kind, page.parent_id, \
                   page.document_id, document.generation, document.head_seq, document.state_hash \
                 FROM blocks block LEFT JOIN pages page ON page.block_id = block.id \
                 JOIN documents document ON document.id = ?2 \
                 WHERE block.id = ?1",
                params![root.result_page_id, root.result_document_id],
                |row| {
                    Ok(serde_json::json!({
                        "type": row.get::<_, String>(0)?,
                        "lifecycle": row.get::<_, String>(1)?,
                        "placementRevision": row.get::<_, i64>(2)?,
                        "metadataRevision": row.get::<_, i64>(3)?,
                        "parentKind": row.get::<_, Option<String>>(4)?,
                        "parentId": row.get::<_, Option<String>>(5)?,
                        "documentId": row.get::<_, Option<String>>(6)?,
                        "documentGeneration": row.get::<_, i64>(7)?,
                        "documentHeadSeq": row.get::<_, i64>(8)?,
                        "documentStateHash": row.get::<_, String>(9)?,
                    }))
                },
            )
            .optional()?
            .ok_or_else(|| conflict("Promoted Page is no longer available for Undo"))?;
        let memberships = connection
            .prepare(
                "SELECT id, data_source_id, revision, removed_at \
                 FROM data_source_page_memberships WHERE page_block_id = ?1 \
                 ORDER BY data_source_id, id",
            )?
            .query_map([&root.result_page_id], |row| {
                Ok(serde_json::json!([
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ]))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let values = connection
            .prepare(
                "SELECT value.data_source_id, value.membership_id, value.property_id, \
                   value.value_type, value.value_json, value.revision \
                 FROM data_source_property_values value \
                 JOIN data_source_page_memberships membership \
                   ON membership.id = value.membership_id \
                  AND membership.data_source_id = value.data_source_id \
                 WHERE membership.page_block_id = ?1 \
                 ORDER BY value.data_source_id, value.membership_id, value.property_id",
            )?
            .query_map([&root.result_page_id], |row| {
                Ok(serde_json::json!([
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, i64>(5)?,
                ]))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let positions =
            crate::database::retained_position_witnesses(connection, &root.result_page_id)?;
        let properties = connection
            .prepare(
                "SELECT property_key, value_type, value_json, revision \
                 FROM block_properties WHERE block_id = ?1 ORDER BY property_key",
            )?
            .query_map([&root.result_page_id], |row| {
                Ok(serde_json::json!([
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                ]))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let file_manifest = connection
            .query_row(
                "SELECT revision, body_usage_revision FROM page_file_manifests \
                 WHERE page_id = ?1",
                [&root.result_page_id],
                |row| {
                    Ok(serde_json::json!({
                        "revision": row.get::<_, i64>(0)?,
                        "bodyUsageRevision": row.get::<_, i64>(1)?,
                    }))
                },
            )
            .optional()?;
        let file_entries = connection
            .prepare("SELECT file_id, logical_path FROM page_file_entries WHERE page_id = ?1 ORDER BY file_id")?
            .query_map([&root.result_page_id], |row| Ok(serde_json::json!({
                "fileId": row.get::<_, String>(0)?,
                "logicalPath": row.get::<_, String>(1)?,
            })))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        guarded_pages.push(serde_json::json!({
            "pageId": root.result_page_id,
            "authority": authority,
            "memberships": memberships,
            "values": values,
            "positions": positions,
            "properties": properties,
            "fileManifest": file_manifest,
            "fileEntries": file_entries,
        }));
    }
    let schema = schema_restore
        .map(|restore| {
            connection.query_row(
                "SELECT source.schema_revision, property.schema_revision, property.config_json \
                 FROM data_sources source JOIN data_source_properties property \
                   ON property.data_source_id = source.id \
                 WHERE source.id = ?1 AND property.id = ?2",
                params![restore.data_source_id, restore.property_id],
                |row| {
                    Ok(serde_json::json!({
                        "dataSourceId": restore.data_source_id,
                        "propertyId": restore.property_id,
                        "sourceRevision": row.get::<_, i64>(0)?,
                        "propertyRevision": row.get::<_, i64>(1)?,
                        "config": row.get::<_, String>(2)?,
                    }))
                },
            )
        })
        .transpose()?;
    let bytes = serde_json::to_vec(&serde_json::json!({
        "pages": guarded_pages,
        "schema": schema,
    }))
    .map_err(|_| internal("Block transfer Undo guard cannot be encoded"))?;
    Ok(sha256(&bytes))
}

struct PageParentUndoRecipeInput<'a> {
    operation_id: &'a str,
    store_epoch: &'a str,
    intent: &'a LibraryBlockTransferLogicalIntent,
    prepared: &'a PreparedPageParentTransfer,
    document_commits: &'a [PersistedTransferCommit],
    schema_restore: Option<BlockTransferUndoSchemaRestoreV1>,
}

fn build_page_parent_undo_recipe(
    connection: &Connection,
    input: PageParentUndoRecipeInput<'_>,
) -> Result<history::Prepared, StoreError> {
    let PageParentUndoRecipeInput {
        operation_id,
        store_epoch,
        intent,
        prepared,
        document_commits,
        schema_restore,
    } = input;
    let source_post_head_seq = if intent.mode == LibraryBlockTransferMode::Move {
        Some(
            document_commits
                .iter()
                .find(|commit| {
                    commit.public.document_id == prepared.source_authority.head.id
                        && commit.public.base_head_seq == prepared.source_authority.head.head_seq
                })
                .ok_or_else(|| corrupt("Move transfer has no source Document commit"))?
                .public
                .head_seq,
        )
    } else {
        None
    };
    let roots = prepared
        .roots
        .iter()
        .map(|root| BlockTransferUndoRootV1 {
            source_root_id: root.source_root_id.clone(),
            result_page_id: root.page_id.clone(),
            result_document_id: root.document_id.clone(),
            source_block_ids: root.source_block_ids.clone(),
            source_root_type: root.source_root_type.clone(),
            source_root_properties: root.source_root_properties.clone(),
        })
        .collect::<Vec<_>>();
    let target_guard_hash =
        block_transfer_target_guard_hash(connection, &roots, schema_restore.as_ref())?;
    let footprint = promotion_history::capture_footprint(connection, &roots)?;
    let recipe = BlockTransferUndoRecipeV4 {
        version: BLOCK_TRANSFER_UNDO_RECIPE_VERSION,
        mode: intent.mode,
        project_id: prepared.actor_project_id.clone(),
        library_id: prepared.source_authority.head.library_id.clone(),
        store_epoch: store_epoch.to_owned(),
        source_document_id: prepared.source_authority.head.id.clone(),
        source_generation: prepared.source_authority.head.generation,
        source_post_head_seq,
        source_pre_materialization: (intent.mode == LibraryBlockTransferMode::Move)
            .then(|| prepared.source_materialization.clone()),
        source_placeholder_block_id: prepared.source_placeholder_block_id.clone(),
        roots,
        target_guard_hash,
        schema_restore,
        footprint: Some(footprint),
    };
    history::prepare_promotion(operation_id, &recipe)
}

fn capture_page_relocation_undo_source(
    connection: &Connection,
    library_id: &str,
    prepared: &PreparedPageOwnershipTransfer,
) -> Result<PreparedPageRelocationUndoV3, StoreError> {
    let [root] = prepared.roots.as_slice() else {
        return Err(invalid(
            "Reversible Page relocation requires exactly one Page root",
        ));
    };

    let source = match &prepared.source {
        PreparedPageOwnershipSource::Library => {
            let (previous_sibling_id, next_sibling_id) =
                library_sibling_anchors(connection, library_id, &root.page_id)?;
            PageRelocationUndoSourceV3::Library {
                previous_sibling_id,
                next_sibling_id,
            }
        }
        PreparedPageOwnershipSource::Document {
            document_id,
            page_id,
        } => {
            let document = prepared
                .source_document
                .as_ref()
                .ok_or_else(|| corrupt("Page relocation source Document was not prepared"))?;
            let placement = materialized_sibling_placement(
                &document.base_materialization.block_tree,
                &root.page_id,
                None,
            )
            .ok_or_else(|| corrupt("Page relocation source shell has no Document placement"))?;
            PageRelocationUndoSourceV3::Page {
                page_id: page_id.clone(),
                document_id: document_id.clone(),
                parent_block_id: placement.parent_block_id,
                previous_sibling_id: placement.previous_sibling_id,
                next_sibling_id: placement.next_sibling_id,
            }
        }
        PreparedPageOwnershipSource::DataSource { data_source_id } => {
            let default_view_id = connection
                .query_row(
                    "SELECT container.default_view_id FROM data_sources source \
                     JOIN database_containers container \
                       ON container.block_id = source.home_database_block_id \
                     JOIN database_views view ON view.id = container.default_view_id \
                     WHERE source.id = ?1 AND source.library_id = ?2 \
                       AND source.lifecycle = 'active' AND container.lifecycle = 'active' \
                       AND view.lifecycle = 'active' AND view.data_source_id = source.id",
                    params![data_source_id, library_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
                .ok_or_else(|| conflict("Source Database no longer has an active default View"))?;
            let view_ids = connection
                .prepare(
                    "SELECT id FROM database_views WHERE data_source_id = ?1 \
                       AND lifecycle = 'active' ORDER BY id",
                )?
                .query_map([data_source_id], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let positions = view_ids
                .into_iter()
                .map(|view_id| {
                    let anchors = crate::database::capture_page_order_anchors(
                        connection,
                        &view_id,
                        &root.page_id,
                    )?;
                    Ok(PageRelocationUndoPositionV3 { view_id, anchors })
                })
                .collect::<Result<Vec<_>, StoreError>>()?;
            PageRelocationUndoSourceV3::DataSource {
                data_source_id: data_source_id.clone(),
                default_view_id,
                positions,
            }
        }
    };
    Ok(PreparedPageRelocationUndoV3 {
        page_id: root.page_id.clone(),
        source,
    })
}

fn seal_page_relocation_undo_recipe(
    operation_id: &str,
    store_epoch: &str,
    library_id: &str,
    project_id: &str,
    target: &PreparedPageOwnershipTarget,
    result_location_revision: i64,
    prepared: PreparedPageRelocationUndoV3,
) -> Result<history::Prepared, StoreError> {
    let result_parent = match target {
        PreparedPageOwnershipTarget::Library { .. } => PageRelocationUndoParentV2::Library {
            library_id: library_id.to_owned(),
        },
        PreparedPageOwnershipTarget::Document { page_id, .. } => PageRelocationUndoParentV2::Page {
            page_id: page_id.clone(),
        },
        PreparedPageOwnershipTarget::DataSource { destination } => {
            PageRelocationUndoParentV2::DataSource {
                data_source_id: destination.data_source_id.clone(),
            }
        }
    };
    let recipe = PageRelocationUndoRecipeV3 {
        version: PAGE_RELOCATION_UNDO_RECIPE_VERSION,
        project_id: project_id.to_owned(),
        library_id: library_id.to_owned(),
        store_epoch: store_epoch.to_owned(),
        page_id: prepared.page_id,
        result_parent,
        result_location_revision,
        source: prepared.source,
    };
    history::prepare_relocation(operation_id, &recipe)
}

struct PageRelocationSiblingPlacement {
    parent_block_id: Option<String>,
    previous_sibling_id: Option<String>,
    next_sibling_id: Option<String>,
}

fn materialized_sibling_placement(
    blocks: &[MaterializedBlockNode],
    target_block_id: &str,
    parent_block_id: Option<&str>,
) -> Option<PageRelocationSiblingPlacement> {
    for (index, block) in blocks.iter().enumerate() {
        if block.id == target_block_id {
            return Some(PageRelocationSiblingPlacement {
                parent_block_id: parent_block_id.map(str::to_owned),
                previous_sibling_id: index
                    .checked_sub(1)
                    .and_then(|previous| blocks.get(previous))
                    .map(|sibling| sibling.id.clone()),
                next_sibling_id: blocks.get(index + 1).map(|sibling| sibling.id.clone()),
            });
        }
        if let Some(placement) =
            materialized_sibling_placement(&block.children, target_block_id, Some(&block.id))
        {
            return Some(placement);
        }
    }
    None
}

fn library_sibling_anchors(
    connection: &Connection,
    library_id: &str,
    page_id: &str,
) -> Result<(Option<String>, Option<String>), StoreError> {
    let rank_key = connection
        .query_row(
            "SELECT rank_key FROM library_block_placements \
             WHERE library_id = ?1 AND block_id = ?2",
            params![library_id, page_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .ok_or_else(|| conflict("Page no longer has its source Library placement"))?;
    let previous = connection
        .query_row(
            "SELECT block_id FROM library_block_placements \
             WHERE library_id = ?1 AND (rank_key < ?2 OR (rank_key = ?2 AND block_id < ?3)) \
             ORDER BY rank_key DESC, block_id DESC LIMIT 1",
            params![library_id, rank_key, page_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    let next = connection
        .query_row(
            "SELECT block_id FROM library_block_placements \
             WHERE library_id = ?1 AND (rank_key > ?2 OR (rank_key = ?2 AND block_id > ?3)) \
             ORDER BY rank_key, block_id LIMIT 1",
            params![library_id, rank_key, page_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    Ok((previous, next))
}

fn restore_page_relocation_positions(
    connection: &Connection,
    recipe: &PageRelocationUndoRecipeV3,
    now: &str,
) -> Result<(Vec<String>, BTreeMap<String, i64>), StoreError> {
    let PageRelocationUndoSourceV3::DataSource {
        data_source_id,
        positions,
        ..
    } = &recipe.source
    else {
        return Ok((Vec::new(), BTreeMap::new()));
    };
    let membership_id = connection
        .query_row(
            "SELECT id FROM data_source_page_memberships \
             WHERE data_source_id = ?1 AND page_block_id = ?2 AND removed_at IS NULL",
            params![data_source_id, recipe.page_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .ok_or_else(|| corrupt("Restored Page lost its source Database membership"))?;
    for position in positions {
        let still_active = connection
            .query_row(
                "SELECT 1 FROM database_views \
                 WHERE id = ?1 AND data_source_id = ?2 AND lifecycle = 'active'",
                params![position.view_id, data_source_id],
                |_| Ok(()),
            )
            .optional()?;
        if still_active.is_none() {
            return Err(conflict(
                "Source Database Views changed after the Page moved",
            ));
        }
    }
    let mut revisions = BTreeMap::new();
    let mut view_ids = Vec::with_capacity(positions.len());
    for position in positions {
        let committed = crate::database::restore_page_order_anchors(
            connection,
            &position.view_id,
            &recipe.page_id,
            &position.anchors,
            now,
        )?;
        revisions.insert(
            format!("viewPosition:{}:{}", position.view_id, recipe.page_id),
            committed.revision,
        );
        view_ids.push(position.view_id.clone());
    }
    crate::database::refresh_copied_page_projection(
        connection,
        &recipe.page_id,
        Some(&membership_id),
        Some(data_source_id),
        now,
    )?;
    Ok((view_ids, revisions))
}

fn apply_page_parent_transfer(
    connection: &Connection,
    command: PageParentApplyCommand<'_>,
    mut prepared: PreparedPageParentTransfer,
) -> Result<LibraryApplyOutcome, StoreError> {
    let context = command.context;
    let library_id = command.library_id;
    let operation_id = command.operation_id;
    let store_epoch = command.store_epoch;
    let request_hash = command.request_hash;
    let intent = command.intent;
    let apply_started_at = Instant::now();
    let now = sqlite_now(connection)?;
    let commit_result = durable_mutation::run(
        connection,
        OperationIdentity {
            module: ModuleName::Library,
            module_name: MODULE_NAME,
            operation_id,
            intent_hash: request_hash,
            store_epoch,
            committed_at: &now,
            context,
        },
        |scope| {
            let schema_restore = read_task_shorthand_schema_restore(connection, &prepared)?;
            let mut shorthand_schema_revisions = BTreeMap::new();
            if let Some(plan) = &prepared.task_shorthand_plan
                && !plan.new_tag_options.is_empty()
                && let PreparedPageParentTarget::DataSource { destination } = &mut prepared.target
            {
                let schema = apply_page_task_shorthand_schema(
                    connection,
                    library_id,
                    bound_project_id(context)?,
                    &destination.data_source_id,
                    &plan.new_tag_options,
                    plan.expected_tags_property_revision,
                    &now,
                )?;
                destination.expected_data_source_revision = schema.source_revision;
                shorthand_schema_revisions = schema.committed_revisions;
            }
            let persistence_started_at = Instant::now();
            let before_block_id = match &prepared.target {
                PreparedPageParentTarget::Library { before_block_id } => before_block_id.as_deref(),
                PreparedPageParentTarget::DataSource { .. } => None,
            };
            let mut staged = Vec::with_capacity(prepared.roots.len());
            for root in &prepared.roots {
                check_request_interruption()?;
                let stage = stage_page_parent_root(
                    connection,
                    library_id,
                    &prepared,
                    root,
                    before_block_id,
                    &now,
                )?;
                staged.push(stage);
            }
            let staging_elapsed = persistence_started_at.elapsed();

            let mut document_commits = Vec::new();
            let source_persistence_started_at = Instant::now();
            if let Some(source_update) = prepared.source_update.take() {
                let structurally_detached_block_ids = prepared
                    .roots
                    .iter()
                    .flat_map(|root| root.source_block_ids.iter().cloned())
                    .collect::<Vec<_>>();
                // The intent hash can recur after a completed transfer is undone. Keep the
                // Document receipt tied to the durable operation identity so a later, valid
                // transfer does not collide with the earlier receipt; replay of the same
                // operation is still handled by the durable mutation ledger above this seam.
                let update_id = format!(
                    "block-transfer:{}:{request_hash}:source",
                    sha256(operation_id.as_bytes())
                );
                document_commits.push(persist_prepared_update(
                    connection,
                    bound_project_id(context)?,
                    &prepared.source_authority,
                    &prepared.source_materialization,
                    &mut prepared.source_engine,
                    source_update,
                    &update_id,
                    operation_id,
                    store_epoch,
                    TransferDocumentPlacement::Derived {
                        advances: &[],
                        exact_moves: &[],
                    },
                    &structurally_detached_block_ids,
                    scope.evidence(),
                )?);
            }
            let source_persistence_elapsed = source_persistence_started_at.elapsed();
            let mut data_source_placements = Vec::new();
            let target_persistence_started_at = Instant::now();
            for stage in staged {
                check_request_interruption()?;
                let page_id = stage.page_id.clone();
                let staged_revisions = StagedPagePlacementRevisions {
                    location_revision: stage.location_revision,
                    metadata_revision: stage.metadata_revision,
                    parent_revision: stage.parent_revision,
                };
                document_commits.push(persist_page_parent_genesis(
                    connection,
                    &command,
                    stage,
                    &now,
                    scope.evidence(),
                )?);
                if let PreparedPageParentTarget::DataSource { destination, .. } = &prepared.target {
                    let mut root_destination = destination.clone();
                    if let Some(values) = prepared
                        .roots
                        .iter()
                        .find(|root| root.page_id == page_id)
                        .and_then(|root| root.destination_values.clone())
                    {
                        root_destination.values = values;
                    }
                    let placement = place_staged_page_in_data_source(
                        connection,
                        library_id,
                        bound_project_id(context)?,
                        None,
                        &page_id,
                        &root_destination,
                        staged_revisions,
                        &now,
                    )?;
                    data_source_placements.push((page_id, placement));
                }
            }
            let target_persistence_elapsed = target_persistence_started_at.elapsed();
            let result_root_block_ids = prepared
                .roots
                .iter()
                .map(|root| root.page_id.clone())
                .collect::<Vec<_>>();
            let result_block_ids = prepared
                .roots
                .iter()
                .flat_map(|root| transformation_result_blocks(&root.transformation))
                .collect::<Vec<_>>();
            let (final_locations, final_location_revisions) =
                read_final_locations(connection, &result_block_ids)?;
            let mut affected_database_ids = data_source_placements
                .iter()
                .map(|(_, placement)| placement.database_id.clone())
                .collect::<Vec<_>>();
            affected_database_ids.sort();
            affected_database_ids.dedup();
            let mut affected_view_ids = data_source_placements
                .iter()
                .flat_map(|(_, placement)| placement.affected_view_ids.clone())
                .collect::<Vec<_>>();
            affected_view_ids.sort();
            affected_view_ids.dedup();
            let page_keys = read_current_page_keys(connection, library_id, &result_root_block_ids)?;
            let pending_undo = build_page_parent_undo_recipe(
                connection,
                PageParentUndoRecipeInput {
                    operation_id,
                    store_epoch,
                    intent,
                    prepared: &prepared,
                    document_commits: &document_commits,
                    schema_restore,
                },
            )?;
            let result = LibraryBlockTransferResult {
                mode: intent.mode,
                source_root_block_ids: intent.root_block_ids.clone(),
                result_root_block_ids,
                copied_block_ids: prepared.copied_block_ids.clone(),
                transformation_evidence: prepared
                    .roots
                    .iter()
                    .map(transformation_evidence)
                    .collect::<Result<_, _>>()?,
                final_locations,
                final_location_revisions: final_location_revisions.clone(),
                document_commits: document_commits
                    .iter()
                    .map(|commit| commit.public.clone())
                    .collect(),
                affected_database_ids: affected_database_ids.clone(),
                page_keys,
                page_etags: BTreeMap::new(),
                move_etags: BTreeMap::new(),
                page_view_placements: BTreeMap::new(),
                undo_token: Some(pending_undo.token.clone()),
                history: pending_undo
                    .symmetric
                    .then(|| history::token(&pending_undo.token)),
            };
            let mut committed_revisions = final_location_revisions
                .iter()
                .map(|(block_id, revision)| (format!("blockLocation:{block_id}"), *revision))
                .collect::<BTreeMap<_, _>>();
            committed_revisions.extend(shorthand_schema_revisions);
            for commit in &document_commits {
                committed_revisions.insert(
                    format!("documentHead:{}", commit.public.document_id),
                    commit.public.head_seq,
                );
            }
            for (page_id, placement) in &data_source_placements {
                committed_revisions.insert(
                    format!("blockMetadata:{page_id}"),
                    placement.metadata_revision,
                );
                committed_revisions
                    .insert(format!("pageParent:{page_id}"), placement.parent_revision);
                committed_revisions.insert(
                    format!(
                        "membership:{}:{}",
                        placement.data_source_id, placement.membership_id
                    ),
                    placement.membership_revision,
                );
                for (property_id, revision) in &placement.value_revisions {
                    committed_revisions.insert(
                        format!(
                            "propertyValue:{}:{}:{}",
                            placement.data_source_id, page_id, property_id
                        ),
                        *revision,
                    );
                }
                if let (PreparedPageParentTarget::DataSource { destination, .. }, Some(revision)) =
                    (&prepared.target, placement.position_revision)
                    && let Some(view) = &destination.view
                {
                    committed_revisions
                        .insert(format!("viewPosition:{}:{page_id}", view.view_id), revision);
                }
            }
            let mut affected_parent_keys = match &prepared.target {
                PreparedPageParentTarget::Library { .. } => vec![format!("library:{library_id}")],
                PreparedPageParentTarget::DataSource { destination, .. } => {
                    vec![format!("data_source:{}", destination.data_source_id)]
                }
            };
            affected_parent_keys.sort();
            affected_parent_keys.dedup();
            let mut affected_page_ids = prepared
                .roots
                .iter()
                .map(|root| root.page_id.clone())
                .collect::<Vec<_>>();
            affected_page_ids.sort();
            affected_page_ids.dedup();
            let sealing_started_at = Instant::now();
            let sealed = seal_mutation_with(
                scope,
                context,
                operation_id,
                MutationEffects {
                    page_file_entries: Vec::new(),
                    file_revisions: BTreeMap::new(),
                    file_mutation: Default::default(),
                    project_id: prepared.actor_project_id.clone(),
                    operation_kind: "transfer_blocks",
                    change_kind: "block_mutation",
                    did_mutate: true,
                    created_target: None,
                    affected_parent_keys,
                    affected_block_ids: result_block_ids,
                    affected_page_ids,
                    affected_database_ids,
                    affected_view_ids,
                    affected_document_ids: document_commits
                        .iter()
                        .map(|commit| commit.public.document_id.clone())
                        .collect(),
                    committed_revisions,
                    page_create: None,
                    page_copy: None,
                    canvas_mutation: None,
                    block_transfer: Some(result.clone()),
                    block_transfer_undo: None,
                    page_relocation_undo: None,
                    structural_edit: None,
                    page_lifecycle: None,
                    block_property_mutation: None,
                    agent_page_copy: None,
                    agent_create_pages: None,
                    agent_move_pages: None,
                    change_payload: None,
                    committed_at: now.clone(),
                },
                |_, event_sequence| {
                    persist_mutation_ledger(
                        connection,
                        operation_id,
                        &prepared.actor_project_id,
                        store_epoch,
                        request_hash,
                        intent,
                        &result,
                        event_sequence,
                        &now,
                    )?;
                    history::persist(connection, &pending_undo, &now)?;
                    persist_operation_checkpoints(
                        connection,
                        context,
                        operation_id,
                        &intent.actor,
                        &document_commits,
                        event_sequence,
                        &now,
                    )?;
                    metrics()
                        .page_parent_apply
                        .record(apply_started_at.elapsed());
                    Ok(())
                },
            )?;
            let micros =
                |duration: Duration| u64::try_from(duration.as_micros()).unwrap_or(u64::MAX);
            tracing::debug!(
                operationId = operation_id,
                stagingMicros = micros(staging_elapsed),
                sourcePersistenceMicros = micros(source_persistence_elapsed),
                targetPersistenceMicros = micros(target_persistence_elapsed),
                sealingMicros = micros(sealing_started_at.elapsed()),
                totalMicros = micros(persistence_started_at.elapsed()),
                "Block-to-Page transfer persistence completed"
            );
            Ok(sealed)
        },
    )?;
    library_commit_result(connection, commit_result)
}

struct StagedPageParentGenesis {
    page_id: String,
    document_id: String,
    location_revision: i64,
    metadata_revision: i64,
    parent_revision: i64,
    placement_mutation_block_ids: Vec<String>,
    prepared: crate::document::PreparedYjsGenesis,
}

pub(super) struct StagedFreshPage {
    pub(super) document_id: String,
    pub(super) document_head_seq: i64,
    pub(super) body_block_ids: Vec<String>,
    pub(super) materialization: DocumentMaterialization,
}

pub(super) struct PreparedFreshPageGenesis {
    prepared: crate::document::PreparedYjsGenesis,
    pub(super) body_block_ids: Vec<String>,
}

pub(super) fn prepare_fresh_page_genesis(
    operation_id: &str,
    document_id: &str,
    body_block_id_role: &str,
    rich_title: &[RichTextItem],
    nfm: &str,
) -> Result<PreparedFreshPageGenesis, StoreError> {
    let mut block_ordinal = 0usize;
    let mut allocate_block_id = || {
        let block_id = stable_uuid_v7(operation_id, body_block_id_role, &block_ordinal.to_string());
        block_ordinal += 1;
        block_id
    };
    let prepared = prepare_page_yjs_genesis_with_content(
        document_id,
        rich_title,
        nfm,
        &mut allocate_block_id,
    )?;
    let mut body_block_ids = Vec::new();
    collect_materialized_block_ids(&prepared.materialization.block_tree, &mut body_block_ids);
    if prepared
        .materialization
        .block_tree
        .iter()
        .any(contains_owning_page)
    {
        return Err(invalid(
            "Page creation Nested Markdown cannot create an owning nested Page; use create_pages",
        ));
    }
    Ok(PreparedFreshPageGenesis {
        prepared,
        body_block_ids,
    })
}

#[allow(clippy::too_many_arguments)]
pub(super) fn stage_fresh_page_in_library(
    connection: &Connection,
    commit_context: &local_commit::CommitContext,
    library_id: &str,
    actor_project_id: &str,
    operation_id: &str,
    store_epoch: &str,
    page_id: &str,
    document_id: &str,
    body_block_id_role: &str,
    rich_title: &[RichTextItem],
    nfm: &str,
    before_block_id: Option<&str>,
    now: &str,
) -> Result<StagedFreshPage, StoreError> {
    let prepared = prepare_fresh_page_genesis(
        operation_id,
        document_id,
        body_block_id_role,
        rich_title,
        nfm,
    )?;
    stage_prepared_fresh_page_in_library(
        connection,
        commit_context,
        library_id,
        actor_project_id,
        operation_id,
        store_epoch,
        page_id,
        document_id,
        before_block_id,
        now,
        prepared,
    )
}

#[allow(clippy::too_many_arguments)]
pub(super) fn stage_prepared_fresh_page_in_library(
    connection: &Connection,
    commit_context: &local_commit::CommitContext,
    library_id: &str,
    actor_project_id: &str,
    operation_id: &str,
    store_epoch: &str,
    page_id: &str,
    document_id: &str,
    before_block_id: Option<&str>,
    now: &str,
    prepared: PreparedFreshPageGenesis,
) -> Result<StagedFreshPage, StoreError> {
    let PreparedFreshPageGenesis {
        prepared,
        body_block_ids,
    } = prepared;
    let mut fresh_block_ids = vec![page_id.to_owned()];
    fresh_block_ids.extend(body_block_ids.iter().cloned());
    assert_fresh_copy_identities(connection, &fresh_block_ids)?;
    if read_document_authority(connection, document_id)?.is_some() {
        return Err(StoreError::new(
            StoreErrorCode::AlreadyOwned,
            "Created Page Document identity is already owned",
            false,
        ));
    }

    connection.execute(
        "INSERT INTO blocks( \
           id, library_id, type, lifecycle, placement_revision, metadata_revision, \
           created_at, updated_at \
         ) VALUES (?1, ?2, 'page', 'active', 1, 1, ?3, ?3)",
        params![page_id, library_id, now],
    )?;
    connection.execute(
        "INSERT INTO documents( \
           id, library_id, generation, head_seq, schema_key, schema_version, state_vector, \
           state_hash, readiness, authority, genesis_source_revision, created_at, updated_at, \
           sync_engine \
         ) VALUES (?1, ?2, 1, 0, 'nodex.page', 3, X'', '', 'pending_genesis', \
           'legacy_shadow', NULL, ?3, ?3, 'yjs')",
        params![document_id, library_id, now],
    )?;
    connection.execute(
        "INSERT INTO block_documents(block_id, document_id, library_id, created_at) \
         VALUES (?1, ?2, ?3, ?4)",
        params![page_id, document_id, library_id, now],
    )?;
    connection.execute(
        "INSERT INTO pages( \
           block_id, library_id, document_id, parent_kind, parent_id, created_at, updated_at \
         ) VALUES (?1, ?2, ?3, 'library', ?2, ?4, ?4)",
        params![page_id, library_id, document_id, now],
    )?;
    let anchor = before_block_id
        .map(|block_id| read_library_anchor(connection, library_id, block_id))
        .transpose()?;
    insert_library_placement(connection, library_id, page_id, anchor.as_ref(), now)?;

    let authority = read_document_authority(connection, document_id)?
        .ok_or_else(|| corrupt("Created Page has no Document authority"))?;
    let update_id = format!("create-page-genesis:{}", sha256(operation_id.as_bytes()));
    let full_state = prepared.engine.full_state_v1();
    let persisted = persist_yjs_genesis_with_local_commit(
        connection,
        PersistYjsGenesis {
            authority: &authority,
            actor_project_id,
            materialization: &prepared.materialization,
            update_id: &update_id,
            client_session_id: "rust:nodex-page-create",
            update: &prepared.update_v1,
            state_vector: &prepared.state_vector_v1,
            full_state: &full_state,
            store_epoch,
            operation_id: &update_id,
            placement: DocumentPlacementEvidence::STRUCTURAL,
            emit_event: false,
        },
        commit_context,
    )?;
    insert_page_read_model(
        connection,
        page_id,
        &prepared.materialization,
        persisted.head_seq,
        now,
    )?;
    ensure_default_page_intrinsic_properties(connection, page_id, now)?;
    refresh_page_intrinsic_projection(connection, page_id, now)?;
    connection.execute(
        "UPDATE page_read_model SET placement_revision = 1, metadata_revision = 1 \
         WHERE page_block_id = ?1",
        [page_id],
    )?;
    Ok(StagedFreshPage {
        document_id: document_id.to_owned(),
        document_head_seq: persisted.head_seq,
        body_block_ids,
        materialization: prepared.materialization,
    })
}

fn contains_owning_page(block: &MaterializedBlockNode) -> bool {
    block.block_type == "page" || block.children.iter().any(contains_owning_page)
}

fn stage_page_parent_root(
    connection: &Connection,
    library_id: &str,
    prepared: &PreparedPageParentTransfer,
    root: &PreparedPageParentRoot,
    before_block_id: Option<&str>,
    now: &str,
) -> Result<StagedPageParentGenesis, StoreError> {
    let (rich_title, body_roots, promotes_existing_root) = match &root.transformation {
        BlockToPageTransformation::Promote {
            rich_title,
            body_roots,
            ..
        } => (
            rich_title,
            body_roots.as_slice(),
            root.page_id == root.source_root_id,
        ),
        BlockToPageTransformation::Wrap {
            rich_title,
            wrapped_root,
            ..
        } => (rich_title, std::slice::from_ref(wrapped_root), false),
        BlockToPageTransformation::AlreadyPage { .. } => {
            return Err(invalid("Page root requires the Page ownership compiler"));
        }
    };
    if prepared.source_update.is_some() {
        let source_block_ids_json = serde_json::to_string(&root.source_block_ids)
            .map_err(|_| internal("Page transformation closure JSON"))?;
        let detached = connection.execute(
            "DELETE FROM document_block_index \
             WHERE document_id = ?1 AND block_id IN (SELECT value FROM json_each(?2))",
            params![prepared.source_authority.head.id, source_block_ids_json],
        )?;
        if detached != root.source_block_ids.len() {
            return Err(StoreError::new(
                StoreErrorCode::RevisionConflict,
                format!(
                    "Page transformation closure changed before commit (expected {}, found {detached})",
                    root.source_block_ids.len(),
                ),
                true,
            ));
        }
    }
    if promotes_existing_root && prepared.source_update.is_some() {
        let changed = connection.execute(
            "UPDATE blocks SET type = 'page', \
               placement_revision = placement_revision + 1, \
               metadata_revision = metadata_revision + 1, updated_at = ?1 \
             WHERE id = ?2 AND library_id = ?3 AND lifecycle = 'active'",
            params![now, root.page_id, library_id],
        )?;
        if changed != 1 {
            return Err(StoreError::new(
                StoreErrorCode::RevisionConflict,
                format!("Block {} changed before Page promotion", root.page_id),
                true,
            ));
        }
    } else {
        connection.execute(
            "INSERT INTO blocks( \
               id, library_id, type, lifecycle, placement_revision, metadata_revision, \
               created_at, updated_at \
             ) VALUES (?1, ?2, 'page', 'active', 1, 1, ?3, ?3)",
            params![root.page_id, library_id, now],
        )?;
    }
    connection.execute(
        "INSERT INTO documents( \
           id, library_id, generation, head_seq, schema_key, schema_version, state_vector, \
           state_hash, readiness, authority, genesis_source_revision, created_at, updated_at, sync_engine \
         ) VALUES (?1, ?2, 1, 0, 'nodex.page', 3, X'', '', 'pending_genesis', \
           'legacy_shadow', NULL, ?3, ?3, 'yjs')",
        params![root.document_id, library_id, now],
    )?;
    connection.execute(
        "INSERT INTO block_documents(block_id, document_id, library_id, created_at) \
         VALUES (?1, ?2, ?3, ?4)",
        params![root.page_id, root.document_id, library_id, now],
    )?;
    let revisions = connection.query_row(
        "SELECT placement_revision, metadata_revision FROM blocks WHERE id = ?1",
        [&root.page_id],
        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
    )?;
    connection.execute(
        "INSERT INTO pages( \
           block_id, library_id, document_id, parent_kind, parent_id, created_at, updated_at \
         ) VALUES (?1, ?2, ?3, 'library', ?2, ?4, ?4)",
        params![root.page_id, library_id, root.document_id, now],
    )?;
    let anchor = before_block_id
        .map(|block_id| read_library_anchor(connection, library_id, block_id))
        .transpose()?;
    insert_library_placement(connection, library_id, &root.page_id, anchor.as_ref(), now)?;
    if matches!(&prepared.target, PreparedPageParentTarget::Library { .. }) {
        super::mutation::insert_creator_resource_grant(
            connection,
            &prepared.actor_project_id,
            library_id,
            "page",
            &root.page_id,
            now,
        )?;
    }
    let title_delta = crate::domain::rich_text::rich_text_to_delta(rich_title)
        .map_err(|error| invalid(error.to_string()))?;
    let prepared_genesis = prepare_yjs_clone_genesis(
        &root.document_id,
        "page",
        BlockDocumentSchema::PageV3,
        Some(&title_delta),
        body_roots,
    )?;
    let placement_mutation_block_ids = if prepared.source_update.is_some() {
        let body_block_ids = prepared_genesis
            .materialization
            .search_units
            .iter()
            .map(|unit| unit.block_id.as_str())
            .collect::<BTreeSet<_>>();
        let mut moved_block_ids = root
            .source_to_result_block_ids
            .values()
            .filter(|block_id| body_block_ids.contains(block_id.as_str()))
            .cloned()
            .collect::<Vec<_>>();
        moved_block_ids.sort();
        moved_block_ids.dedup();
        moved_block_ids
    } else {
        Vec::new()
    };
    Ok(StagedPageParentGenesis {
        page_id: root.page_id.clone(),
        document_id: root.document_id.clone(),
        location_revision: revisions.0,
        metadata_revision: revisions.1,
        parent_revision: revisions.0,
        placement_mutation_block_ids,
        prepared: prepared_genesis,
    })
}

fn persist_page_parent_genesis(
    connection: &Connection,
    command: &PageParentApplyCommand<'_>,
    stage: StagedPageParentGenesis,
    now: &str,
    attached_commit: &local_commit::CommitContext,
) -> Result<PersistedTransferCommit, StoreError> {
    let actor_project_id = bound_project_id(command.context)?;
    let operation_id = command.operation_id;
    let request_hash = command.request_hash;
    let authority = read_document_authority(connection, &stage.document_id)?
        .ok_or_else(|| corrupt("Staged Page has no Document authority"))?;
    let update_id = format!(
        "block-transfer-page-genesis:{}",
        sha256(format!("{operation_id}\0{request_hash}\0{}", stage.page_id).as_bytes())
    );
    let full_state = stage.prepared.engine.full_state_v1();
    let authorized_file_ids = stage.prepared.materialization.file_ids();
    let persisted = persist_yjs_genesis_with_local_commit(
        connection,
        PersistYjsGenesis {
            authority: &authority,
            actor_project_id,
            materialization: &stage.prepared.materialization,
            update_id: &update_id,
            client_session_id: TRANSFER_CLIENT_SESSION_ID,
            update: &stage.prepared.update_v1,
            state_vector: &stage.prepared.state_vector_v1,
            full_state: &full_state,
            store_epoch: command.store_epoch,
            operation_id: &update_id,
            // A Move can reuse the promoted Block's descendants (or an entire
            // wrapped subtree) in the new Page Document. Their source index
            // entries were detached during staging, but their placement
            // revisions still advance exactly once here at the new authority.
            placement: DocumentPlacementEvidence::STRUCTURAL
                .with_advances(&stage.placement_mutation_block_ids)
                .with_authorized_file_ids(&authorized_file_ids),
            emit_event: true,
        },
        attached_commit,
    )?;
    insert_page_read_model(
        connection,
        &stage.page_id,
        &stage.prepared.materialization,
        persisted.head_seq,
        now,
    )?;
    ensure_default_page_intrinsic_properties(connection, &stage.page_id, now)?;
    refresh_page_intrinsic_projection(connection, &stage.page_id, now)?;
    let revisions = connection.query_row(
        "SELECT placement_revision, metadata_revision FROM blocks WHERE id = ?1",
        [&stage.page_id],
        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
    )?;
    connection.execute(
        "UPDATE page_read_model SET placement_revision = ?1, metadata_revision = ?2 \
         WHERE page_block_id = ?3",
        params![revisions.0, revisions.1, stage.page_id],
    )?;
    Ok(PersistedTransferCommit {
        public: LibraryBlockTransferDocumentCommit {
            document_id: stage.document_id,
            generation: 1,
            base_head_seq: 0,
            head_seq: persisted.head_seq,
            update_id,
            update: stage.prepared.update_v1,
            state_vector: persisted.state_vector,
        },
        materialization: stage.prepared.materialization,
    })
}

pub(super) fn read_library_anchor(
    connection: &Connection,
    library_id: &str,
    block_id: &str,
) -> Result<LibraryPlacementAnchor, StoreError> {
    let revision = connection
        .query_row(
            "SELECT block.placement_revision FROM library_block_placements placement \
             JOIN blocks block ON block.id = placement.block_id \
             WHERE placement.library_id = ?1 AND placement.block_id = ?2 \
               AND block.library_id = placement.library_id \
               AND block.lifecycle = 'active'",
            params![library_id, block_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
        .ok_or_else(|| invalid("Library placement anchor is unavailable"))?;
    Ok(LibraryPlacementAnchor {
        block_id: block_id.to_owned(),
        expected_location_revision: revision,
    })
}

fn prepare_task_shorthand_title_policy(
    policy: LibraryPagePromotionPolicy,
    is_data_source_target: bool,
    transformation: &BlockToPageTransformation,
) -> (
    LibraryBlockTransferPromotionEvidence,
    Option<TaskShorthandMatch>,
) {
    if policy == LibraryPagePromotionPolicy::Literal {
        return (LibraryBlockTransferPromotionEvidence::NotRequested, None);
    }
    if !is_data_source_target {
        return (LibraryBlockTransferPromotionEvidence::NotApplicable, None);
    }
    let BlockToPageTransformation::Promote { rich_title, .. } = transformation else {
        return (LibraryBlockTransferPromotionEvidence::NotApplicable, None);
    };
    match parse_task_shorthand(rich_title) {
        TaskShorthandParse::NoMatch => (LibraryBlockTransferPromotionEvidence::NoMatch, None),
        TaskShorthandParse::Rejected(reason) => (
            LibraryBlockTransferPromotionEvidence::Preserved {
                grammar_version: TASK_SHORTHAND_GRAMMAR_VERSION,
                reason: match reason {
                    TaskShorthandRejection::Malformed => nodex_core_contracts::library::LibraryTaskShorthandPreservedReason::MalformedShorthand,
                    TaskShorthandRejection::NonemptyTitleRequired => nodex_core_contracts::library::LibraryTaskShorthandPreservedReason::NonemptyTitleRequired,
                    TaskShorthandRejection::RichTextBoundary => nodex_core_contracts::library::LibraryTaskShorthandPreservedReason::RichTextBoundary,
                },
            },
            None,
        ),
        TaskShorthandParse::Match(parsed) => (
            LibraryBlockTransferPromotionEvidence::NoMatch,
            Some(parsed),
        ),
    }
}

fn transformation_evidence(
    root: &PreparedPageParentRoot,
) -> Result<LibraryBlockTransferTransformationEvidence, StoreError> {
    let (kind, rich_title, body_root_ids, consumed_props, wrapper_reason) =
        match &root.transformation {
            BlockToPageTransformation::Promote {
                rich_title,
                body_roots,
                consumed_props,
                ..
            } => (
                "promote",
                rich_title,
                body_roots.iter().map(|block| block.id.clone()).collect(),
                consumed_props.keys().cloned().collect::<Vec<_>>(),
                None,
            ),
            BlockToPageTransformation::Wrap {
                rich_title,
                wrapped_root,
                reason,
                ..
            } => (
                "wrap",
                rich_title,
                vec![wrapped_root.id.clone()],
                Vec::new(),
                Some(match reason {
                    PageWrapperReason::TypeRequiresWrapper => "type_requires_wrapper",
                    PageWrapperReason::UnsupportedPrimaryContent => "unsupported_primary_content",
                    PageWrapperReason::UnmappedTypeState => "unmapped_type_state",
                }),
            ),
            BlockToPageTransformation::AlreadyPage { .. } => {
                return Err(corrupt("Committed Page transformation was not compiled"));
            }
        };
    let semantic_title =
        serde_json::to_vec(rich_title).map_err(|_| internal("Page transformation title JSON"))?;
    Ok(LibraryBlockTransferTransformationEvidence {
        source_block_id: root.source_root_id.clone(),
        result_page_id: root.page_id.clone(),
        kind: kind.to_owned(),
        source_block_type: match &root.transformation {
            BlockToPageTransformation::Promote { consumed_type, .. } => consumed_type,
            BlockToPageTransformation::Wrap { wrapped_root, .. } => &wrapped_root.block_type,
            BlockToPageTransformation::AlreadyPage { .. } => "page",
        }
        .to_owned(),
        semantic_title_hash: sha256(&semantic_title),
        consumed_property_keys: consumed_props,
        wrapper_reason: wrapper_reason.map(str::to_owned),
        body_root_block_ids: body_root_ids,
        source_to_result_block_ids: root.source_to_result_block_ids.clone(),
        promotion: root.promotion_evidence.clone(),
    })
}

fn affected_page_ids(prepared: &PreparedTransfer) -> Vec<String> {
    let mut page_ids = [&prepared.source_authority, &prepared.target_authority]
        .into_iter()
        .filter(|authority| authority.owner_type == "page")
        .map(|authority| authority.owner_block_id.clone())
        .collect::<Vec<_>>();
    page_ids.sort();
    page_ids.dedup();
    page_ids
}

/// Declares which aggregate owns cross-authority placement revisions in a
/// prepared Document update. Exact local moves are derived from the operation
/// compiler below and never from the write fence.
enum TransferDocumentPlacement<'a> {
    Derived {
        advances: &'a [String],
        exact_moves: &'a [String],
    },
    Preapplied(&'a [String]),
    Genesis(&'a [String]),
    Restore {
        advances: &'a [String],
        reactivations: &'a [String],
    },
}

fn aggregate_owned_placement_block_ids(operations: &[DocumentBlockOperation]) -> Vec<String> {
    let mut block_ids = operations
        .iter()
        .filter_map(|operation| match operation {
            DocumentBlockOperation::InsertBlock { block, .. } => Some(block.id.clone()),
            DocumentBlockOperation::MoveBlock { block_id, .. } => Some(block_id.clone()),
            DocumentBlockOperation::DeleteBlock { .. } => None,
            DocumentBlockOperation::SetTitle { .. }
            | DocumentBlockOperation::SetRichTitle { .. }
            | DocumentBlockOperation::UpdateBlock { .. }
            | DocumentBlockOperation::MergeBlockBackward { .. }
            | DocumentBlockOperation::RestoreBackwardMerge { .. }
            | DocumentBlockOperation::RestoreEditorHistoryForest { .. } => None,
        })
        .collect::<Vec<_>>();
    block_ids.sort();
    block_ids.dedup();
    block_ids
}

fn deleted_operation_block_ids(operations: &[DocumentBlockOperation]) -> Vec<String> {
    let mut block_ids = operations
        .iter()
        .filter_map(|operation| match operation {
            DocumentBlockOperation::DeleteBlock { block_id } => Some(block_id.clone()),
            _ => None,
        })
        .collect::<Vec<_>>();
    block_ids.sort();
    block_ids.dedup();
    block_ids
}

fn removed_document_block_ids(
    base: &DocumentMaterialization,
    result: &DocumentMaterialization,
) -> Vec<String> {
    let resulting_ids = result
        .search_units
        .iter()
        .map(|unit| unit.block_id.as_str())
        .collect::<BTreeSet<_>>();
    base.search_units
        .iter()
        .filter(|unit| !resulting_ids.contains(unit.block_id.as_str()))
        .map(|unit| unit.block_id.clone())
        .collect()
}

#[allow(clippy::too_many_arguments)]
fn persist_prepared_update(
    connection: &Connection,
    actor_project_id: &str,
    authority: &DocumentAuthorityRow,
    base_materialization: &DocumentMaterialization,
    engine: &mut YrsDocumentEngine,
    update: PreparedDocumentOperationUpdate,
    update_id: &str,
    operation_id: &str,
    store_epoch: &str,
    placement: TransferDocumentPlacement<'_>,
    structurally_detached_block_ids: &[String],
    attached_commit: &local_commit::CommitContext,
) -> Result<PersistedTransferCommit, StoreError> {
    let candidate = engine
        .prepare_update_v1(&update.update_v1)
        .map_err(|error| invalid(error.to_string()))?;
    let committed = engine
        .commit_candidate(candidate)
        .map_err(|error| invalid(error.to_string()))?;
    if !committed.did_change {
        return Err(invalid("Block transfer produced no Document change"));
    }
    let event_operation_id = format!(
        "block-transfer-document:{}",
        sha256(format!("{operation_id}\0{}", authority.head.id).as_bytes())
    );
    let (
        placement_genesis_block_ids,
        placement_preapplied_block_ids,
        placement_advance_block_ids,
        exact_moved_block_ids,
        tombstone_reactivations,
    ) = match placement {
        TransferDocumentPlacement::Derived {
            advances,
            exact_moves,
        } => (&[][..], &[][..], advances, exact_moves, &[][..]),
        TransferDocumentPlacement::Preapplied(block_ids) => {
            (&[][..], block_ids, &[][..], &[][..], &[][..])
        }
        TransferDocumentPlacement::Genesis(block_ids) => {
            (block_ids, &[][..], &[][..], &[][..], &[][..])
        }
        TransferDocumentPlacement::Restore {
            advances,
            reactivations,
        } => (&[][..], &[][..], advances, &[][..], reactivations),
    };
    let authorized_file_ids = update.materialization.file_ids();
    let input = PersistYjsCommit {
        authority,
        actor_project_id,
        base_materialization,
        materialization: &update.materialization,
        update_id,
        client_session_id: TRANSFER_CLIENT_SESSION_ID,
        base_head_seq: authority.head.head_seq,
        client_touched_block_ids: &update.write_fence_block_ids,
        update: &update.update_v1,
        state_vector: &engine.state_vector_v1(),
        store_epoch,
        operation_id: &event_operation_id,
        local_commit_id: Some(operation_id),
        event_kind: "document_updated",
        write_fence_block_ids: &update.write_fence_block_ids,
        title_write_fence_required: false,
        document_write_fence_required: false,
        placement: DocumentPlacementEvidence::STRUCTURAL
            .with_structural_detaches(structurally_detached_block_ids)
            .with_genesis(placement_genesis_block_ids)
            .with_preapplied(placement_preapplied_block_ids)
            .with_advances(placement_advance_block_ids)
            .with_exact_moves(exact_moved_block_ids)
            .with_tombstone_reactivation(
                tombstone_reactivations,
                &authority.head.id,
                authority.head.generation,
            )
            .with_authorized_file_ids(&authorized_file_ids),
    };
    let persisted = persist_yjs_commit_with_local_commit(connection, input, attached_commit)?;
    Ok(PersistedTransferCommit {
        public: LibraryBlockTransferDocumentCommit {
            document_id: authority.head.id.clone(),
            generation: authority.head.generation,
            base_head_seq: authority.head.head_seq,
            head_seq: persisted.head_seq,
            update_id: update_id.to_owned(),
            update: update.update_v1,
            state_vector: persisted.state_vector,
        },
        materialization: update.materialization,
    })
}

fn validate_source_roots(
    connection: &Connection,
    library_id: &str,
    source_document_id: &str,
    root_block_ids: &[String],
) -> Result<BTreeMap<String, i64>, StoreError> {
    let mut revisions = BTreeMap::new();
    for block_id in root_block_ids {
        let row = connection
            .query_row(
                "SELECT block.placement_revision, block.lifecycle \
                 FROM blocks block JOIN document_block_index index_row ON index_row.block_id = block.id \
                   AND index_row.document_id = ?1 \
                 WHERE block.id = ?2 AND block.library_id = ?3",
                params![source_document_id, block_id, library_id],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                    ))
                },
            )
            .optional()?
            .ok_or_else(|| not_found(format!("Source Block does not exist: {block_id}")))?;
        if row.1 != "active" {
            return Err(invalid(format!(
                "Source Block {block_id} is outside the source Document authority"
            )));
        }
        revisions.insert(block_id.clone(), row.0);
    }
    Ok(revisions)
}

fn revalidate_read_set(
    connection: &Connection,
    read_set: &PreparedTransferReadSet,
) -> Result<(), StoreError> {
    for document in &read_set.documents {
        let current = connection
            .query_row(
                "SELECT generation, head_seq, readiness FROM documents WHERE id = ?1",
                [&document.document_id],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()?;
        if current
            .as_ref()
            .is_none_or(|(generation, head_seq, readiness)| {
                *generation != document.generation
                    || *head_seq != document.expected_head_seq
                    || readiness != "ready"
            })
        {
            return Err(StoreError::new(
                StoreErrorCode::RevisionConflict,
                format!(
                    "Document {} changed while the Block transfer was prepared",
                    document.document_id
                ),
                true,
            ));
        }
    }
    for (block_id, expected_revision) in &read_set.location_revisions {
        let current = connection
            .query_row(
                "SELECT placement_revision, lifecycle FROM blocks WHERE id = ?1",
                [block_id],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;
        if current.as_ref().is_none_or(|(revision, lifecycle)| {
            revision != expected_revision || lifecycle != "active"
        }) {
            return Err(StoreError::new(
                StoreErrorCode::RevisionConflict,
                format!("Block {block_id} moved while the transfer was prepared"),
                true,
            ));
        }
    }
    for (page_id, expected) in &read_set.source_memberships {
        let current = connection
            .query_row(
                "SELECT id, revision FROM data_source_page_memberships \
                 WHERE page_block_id = ?1 AND removed_at IS NULL",
                [page_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
            )
            .optional()?;
        if current.as_ref().is_none_or(|(membership_id, revision)| {
            membership_id != &expected.membership_id || revision != &expected.revision
        }) {
            return Err(StoreError::new(
                StoreErrorCode::RevisionConflict,
                format!("Page {page_id} membership changed while the transfer was prepared"),
                true,
            ));
        }
    }
    Ok(())
}

fn revalidate_command_authority(
    connection: &Connection,
    context: &BoundModuleContext,
    library_id: &str,
    intent: &LibraryBlockTransferLogicalIntent,
) -> Result<(), StoreError> {
    let project_id = bound_project_id(context)?;
    require_project_in_library(connection, project_id, library_id)?;
    match &intent.source {
        LibraryBlockTransferSource::Page { page_id } => {
            let document_id = resolve_page_document(connection, library_id, page_id)?;
            require_transfer_authority(
                connection,
                library_id,
                project_id,
                &document_id,
                Some(page_id),
                if intent.mode == LibraryBlockTransferMode::Copy {
                    TransferDocumentAccess::Read
                } else {
                    TransferDocumentAccess::Write
                },
            )?;
        }
        LibraryBlockTransferSource::Document { document_id } => {
            require_transfer_authority(
                connection,
                library_id,
                project_id,
                document_id,
                None,
                if intent.mode == LibraryBlockTransferMode::Copy {
                    TransferDocumentAccess::Read
                } else {
                    TransferDocumentAccess::Write
                },
            )?;
        }
        LibraryBlockTransferSource::DataSource { data_source_id } => {
            if intent.mode == LibraryBlockTransferMode::Move {
                validate_page_transfer_data_source_source(
                    connection,
                    library_id,
                    project_id,
                    data_source_id,
                )?;
            } else {
                validate_page_copy_data_source_source(
                    connection,
                    library_id,
                    project_id,
                    data_source_id,
                )?;
                for page_id in &intent.root_block_ids {
                    super::require_page_read_access(connection, library_id, project_id, page_id)?;
                }
            }
        }
        LibraryBlockTransferSource::Library {
            library_id: source_library_id,
        } => {
            if source_library_id != library_id {
                return Err(unauthorized(
                    "Block transfer source belongs to another Library",
                ));
            }
            if intent.mode == LibraryBlockTransferMode::Copy {
                for page_id in &intent.root_block_ids {
                    super::require_page_read_access(connection, library_id, project_id, page_id)?;
                }
            }
        }
    }
    for root_block_id in &intent.root_block_ids {
        let owner = connection
            .query_row(
                "SELECT type, library_id, lifecycle FROM blocks WHERE id = ?1",
                [root_block_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()?
            .ok_or_else(|| not_found(format!("Source Block does not exist: {root_block_id}")))?;
        if owner.1 != library_id || owner.2 != "active" {
            return Err(StoreError::new(
                StoreErrorCode::RevisionConflict,
                format!("Source Block {root_block_id} changed while the transfer was prepared"),
                true,
            ));
        }
        if owner.0 != "page" {
            continue;
        }
        if intent.mode == LibraryBlockTransferMode::Copy {
            super::require_page_read_access(connection, library_id, project_id, root_block_id)?;
            continue;
        }
        super::require_page_write_access(connection, library_id, project_id, root_block_id)?;
    }
    match &intent.target {
        LibraryBlockTransferTarget::Page { page_id, .. } => {
            let document_id = resolve_page_document(connection, library_id, page_id)?;
            require_transfer_authority(
                connection,
                library_id,
                project_id,
                &document_id,
                Some(page_id),
                TransferDocumentAccess::Write,
            )?;
        }
        LibraryBlockTransferTarget::Document { document_id, .. } => {
            require_transfer_authority(
                connection,
                library_id,
                project_id,
                document_id,
                None,
                TransferDocumentAccess::Write,
            )?;
        }
        LibraryBlockTransferTarget::DataSource {
            data_source_id,
            placement,
        } => {
            resolve_data_source_placement(
                connection,
                library_id,
                project_id,
                data_source_id,
                placement,
            )?;
        }
        LibraryBlockTransferTarget::Library {
            library_id: target_library_id,
            ..
        } => {
            if target_library_id != library_id {
                return Err(unauthorized(
                    "Block transfer target belongs to another Library",
                ));
            }
        }
    }
    Ok(())
}

fn resolve_source_document(
    connection: &Connection,
    library_id: &str,
    source: &LibraryBlockTransferSource,
) -> Result<String, StoreError> {
    match source {
        LibraryBlockTransferSource::Document { document_id } => Ok(document_id.clone()),
        LibraryBlockTransferSource::Page { page_id } => {
            resolve_page_document(connection, library_id, page_id)
        }
        LibraryBlockTransferSource::Library { .. }
        | LibraryBlockTransferSource::DataSource { .. } => Err(invalid(
            "Ordinary Block transfer currently requires a Document or Page source",
        )),
    }
}

fn resolve_target_document(
    connection: &Connection,
    library_id: &str,
    target: &LibraryBlockTransferTarget,
) -> Result<(String, BlockSubtreeInsertionTarget), StoreError> {
    match target {
        LibraryBlockTransferTarget::Document {
            document_id,
            parent_block_id,
            before_block_id,
        } => Ok((
            document_id.clone(),
            BlockSubtreeInsertionTarget {
                parent_block_id: parent_block_id.clone(),
                before_block_id: before_block_id.clone(),
            },
        )),
        LibraryBlockTransferTarget::Page {
            page_id,
            parent_block_id,
            before_block_id,
        } => Ok((
            resolve_page_document(connection, library_id, page_id)?,
            BlockSubtreeInsertionTarget {
                parent_block_id: parent_block_id.clone(),
                before_block_id: before_block_id.clone(),
            },
        )),
        LibraryBlockTransferTarget::Library { .. }
        | LibraryBlockTransferTarget::DataSource { .. } => Err(invalid(
            "Ordinary Block transfer currently requires a Document or Page target",
        )),
    }
}

fn resolve_page_document(
    connection: &Connection,
    library_id: &str,
    page_id: &str,
) -> Result<String, StoreError> {
    connection
        .query_row(
            "SELECT page.document_id FROM pages page \
             JOIN blocks block ON block.id = page.block_id AND block.library_id = page.library_id \
             WHERE page.block_id = ?1 AND page.library_id = ?2 \
               AND block.lifecycle = 'active'",
            params![page_id, library_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .ok_or_else(|| not_found(format!("Page does not exist: {page_id}")))
}

fn require_transfer_authority(
    connection: &Connection,
    library_id: &str,
    project_id: &str,
    document_id: &str,
    declared_page_id: Option<&str>,
    access: TransferDocumentAccess,
) -> Result<DocumentAuthorityRow, StoreError> {
    let authority = read_document_authority(connection, document_id)?
        .ok_or_else(|| not_found(format!("Document does not exist: {document_id}")))?;
    if authority.owner_lifecycle != "active" || !authority.head.is_live_yjs_authority() {
        return Err(invalid("Document is not writable live Yjs authority"));
    }
    require_schema(&authority)?;
    if let Some(page_id) = declared_page_id
        && (authority.owner_type != "page" || authority.owner_block_id != page_id)
    {
        return Err(corrupt("Page alias does not own its resolved Document"));
    }
    if authority.head.library_id != library_id || authority.owner_lifecycle != "active" {
        return Err(not_found("Document is not available to the bound Project"));
    }
    if authority.owner_type != "page" {
        require_project_in_library(connection, project_id, library_id)?;
        return Ok(authority);
    }
    if authority.page_library_id.as_deref() != Some(library_id) {
        return Err(corrupt("Page Document escaped its Library authority"));
    }
    match access {
        TransferDocumentAccess::Read => super::require_page_read_access(
            connection,
            library_id,
            project_id,
            &authority.owner_block_id,
        )?,
        TransferDocumentAccess::Write => super::require_page_write_access(
            connection,
            library_id,
            project_id,
            &authority.owner_block_id,
        )?,
    }
    Ok(authority)
}

fn require_schema(authority: &DocumentAuthorityRow) -> Result<BlockDocumentSchema, StoreError> {
    BlockDocumentSchema::from_identity(&authority.head.schema_key, authority.head.schema_version)
        .ok_or_else(|| invalid("Document schema is not a registered Block tree"))
}

fn validate_intent(
    library_id: &str,
    intent: &LibraryBlockTransferLogicalIntent,
) -> Result<(), StoreError> {
    let actor_bytes = serde_json::to_vec(&intent.actor)
        .map_err(|_| invalid("Block transfer actor must be portable JSON"))?;
    if !intent.actor.is_object() || actor_bytes.len() > MAX_ACTOR_BYTES {
        return Err(invalid("Block transfer actor must be a bounded object"));
    }
    if intent.root_block_ids.is_empty() || intent.root_block_ids.len() > MAX_TRANSFER_ROOTS {
        return Err(invalid(
            "Block transfer root selection is outside its bound",
        ));
    }
    let mut unique = BTreeSet::new();
    for block_id in &intent.root_block_ids {
        validate_id(block_id, "root_block_id")?;
        if !unique.insert(block_id) {
            return Err(invalid(
                "Block transfer root selection contains a duplicate",
            ));
        }
    }
    match &intent.source {
        LibraryBlockTransferSource::Library {
            library_id: source_library_id,
        } if source_library_id != library_id => {
            return Err(unauthorized(
                "Block transfer source belongs to another Library",
            ));
        }
        _ => {}
    }
    match &intent.target {
        LibraryBlockTransferTarget::Library {
            library_id: target_library_id,
            ..
        } if target_library_id != library_id => {
            return Err(unauthorized(
                "Block transfer target belongs to another Library",
            ));
        }
        _ => {}
    }
    Ok(())
}

fn validate_causal_dependencies(
    connection: &Connection,
    context: &BoundModuleContext,
    store_epoch: &str,
    intent: &LibraryBlockTransferLogicalIntent,
) -> Result<(), StoreError> {
    if intent.causal_dependencies.len() > 16 {
        return Err(invalid(
            "Block transfer has too many causal Document dependencies",
        ));
    }
    if intent.causal_dependencies.is_empty() {
        return Ok(());
    }
    let library_id = context.library_id.0.as_str();
    let project_id = bound_project_id(context)?;
    let mut documents = BTreeSet::new();
    for dependency in &intent.causal_dependencies {
        validate_id(&dependency.document_id, "causal_dependency.document_id")?;
        if !documents.insert(&dependency.document_id) {
            return Err(invalid(
                "Block transfer causal Document dependencies contain a duplicate",
            ));
        }
        if dependency.generation < 1 || dependency.expected_head_seq < 0 {
            return Err(invalid(
                "Block transfer causal Document head is outside its bound",
            ));
        }
        // A causal head is a freshness fence over a Document the bound actor
        // can currently observe. Resolve it through the same Library/access
        // authority boundary as the transfer itself instead of duplicating the
        // physical ownership schema here.
        let authority = require_transfer_authority(
            connection,
            library_id,
            project_id,
            &dependency.document_id,
            None,
            TransferDocumentAccess::Read,
        )?;
        if authority.head.generation != dependency.generation
            || authority.head.head_seq != dependency.expected_head_seq
        {
            return Err(StoreError::new(
                StoreErrorCode::RevisionConflict,
                format!(
                    "Causal Document {} changed after the local mutation barrier",
                    dependency.document_id
                ),
                true,
            ));
        }
    }
    let current_epoch = crate::document::read_store_epoch(connection)?;
    if current_epoch != store_epoch {
        return Err(StoreError::new(
            StoreErrorCode::StaleStoreEpoch,
            "Block transfer causal fence targets a stale store epoch",
            true,
        ));
    }
    Ok(())
}

fn is_typed_resource(connection: &Connection, block_id: &str) -> Result<bool, StoreError> {
    let block_type =
        connection.query_row("SELECT type FROM blocks WHERE id = ?1", [block_id], |row| {
            row.get::<_, String>(0)
        })?;
    Ok(matches!(
        block_type.as_str(),
        "page" | "database" | "synced_block_source" | "reusable_template_source" | "canvas"
    ))
}

fn assert_fresh_copy_identities(
    connection: &Connection,
    block_ids: &[String],
) -> Result<(), StoreError> {
    for block_id in block_ids {
        let exists = connection
            .query_row(
                "SELECT 1 FROM blocks WHERE id = ?1 \
                 UNION ALL SELECT 1 FROM retired_block_identities WHERE block_id = ?1 LIMIT 1",
                [block_id],
                |_| Ok(()),
            )
            .optional()?;
        if exists.is_some() {
            return Err(StoreError::new(
                StoreErrorCode::IdempotencyKeyReused,
                format!("Copied Block identity is not fresh: {block_id}"),
                false,
            ));
        }
    }
    Ok(())
}

fn read_current_page_keys(
    connection: &Connection,
    library_id: &str,
    root_block_ids: &[String],
) -> Result<BTreeMap<String, Option<String>>, StoreError> {
    let mut page_keys = BTreeMap::new();
    for block_id in root_block_ids {
        let is_page = connection
            .query_row(
                "SELECT 1 FROM pages WHERE library_id = ?1 AND block_id = ?2",
                params![library_id, block_id],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        if !is_page {
            continue;
        }
        page_keys.insert(
            block_id.clone(),
            current_page_key_for_page(connection, library_id, block_id)?,
        );
    }
    Ok(page_keys)
}

fn read_final_locations(
    connection: &Connection,
    block_ids: &[String],
) -> Result<FinalBlockLocations, StoreError> {
    let mut locations = BTreeMap::new();
    let mut revisions = BTreeMap::new();
    for block_id in block_ids {
        let row = connection
            .query_row(
                "SELECT block.placement_revision, block.library_id, placement.rank_key, \
                        entry.document_id, page.parent_kind, page.parent_id, \
                        membership.data_source_id, source.home_database_block_id \
                 FROM blocks block \
                 LEFT JOIN library_block_placements placement ON placement.block_id = block.id \
                   AND placement.library_id = block.library_id \
                 LEFT JOIN document_block_index entry ON entry.block_id = block.id \
                 LEFT JOIN pages page ON page.block_id = block.id AND page.library_id = block.library_id \
                 LEFT JOIN data_source_page_memberships membership \
                   ON membership.page_block_id = block.id AND membership.removed_at IS NULL \
                 LEFT JOIN data_sources source ON source.id = membership.data_source_id \
                 WHERE block.id = ?1",
                [block_id],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, Option<String>>(5)?,
                        row.get::<_, Option<String>>(6)?,
                        row.get::<_, Option<String>>(7)?,
                    ))
                },
            )
            .optional()?
            .ok_or_else(|| corrupt(format!("Committed Block disappeared: {block_id}")))?;
        let location_evidence = (
            row.2.clone(),
            row.3.clone(),
            row.4.clone(),
            row.5.clone(),
            row.6.clone(),
            row.7.clone(),
        );
        let location = match location_evidence.clone() {
            (Some(rank_key), None, Some(parent_kind), _, None, None)
                if parent_kind == "library" =>
            {
                LibraryBlockLocation::Library {
                    library_id: row.1,
                    rank_key,
                }
            }
            (None, Some(document_id), _, _, None, None) => {
                LibraryBlockLocation::Document { document_id }
            }
            (
                None,
                None,
                Some(parent_kind),
                Some(parent_id),
                Some(data_source_id),
                Some(database_id),
            ) if parent_kind == "data_source" && parent_id == data_source_id => {
                LibraryBlockLocation::DataSource {
                    database_id,
                    data_source_id,
                }
            }
            _ => {
                return Err(corrupt(format!(
                    "Committed Block has invalid location: {block_id} {location_evidence:?}"
                )));
            }
        };
        locations.insert(block_id.clone(), location);
        revisions.insert(block_id.clone(), row.0);
    }
    Ok((locations, revisions))
}

pub(super) fn verify_agent_page_move_final_locations(
    connection: &Connection,
    library_id: &str,
    page_ids: &[String],
    destination: &LibraryPageCopyDestination,
) -> Result<(), StoreError> {
    let (locations, _) = read_final_locations(connection, page_ids)?;
    let destination_document_id = match destination {
        LibraryPageCopyDestination::Page { page_id, .. } => {
            Some(resolve_page_document(connection, library_id, page_id)?)
        }
        LibraryPageCopyDestination::Library { .. }
        | LibraryPageCopyDestination::DataSource { .. } => None,
    };
    let destination_database_id = match destination {
        LibraryPageCopyDestination::DataSource { data_source_id, .. } => connection
            .query_row(
                "SELECT home_database_block_id FROM data_sources \
                 WHERE id = ?1 AND library_id = ?2 AND lifecycle = 'active'",
                params![data_source_id, library_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .ok_or_else(|| corrupt("Agent Page-move destination Data Source disappeared"))?
            .into(),
        LibraryPageCopyDestination::Library { .. } | LibraryPageCopyDestination::Page { .. } => {
            None
        }
    };
    for page_id in page_ids {
        let location = locations
            .get(page_id)
            .ok_or_else(|| corrupt("Agent Page move omitted a final Page location"))?;
        let valid = match (destination, location) {
            (
                LibraryPageCopyDestination::Library { .. },
                LibraryBlockLocation::Library {
                    library_id: actual_library_id,
                    ..
                },
            ) => actual_library_id == library_id,
            (
                LibraryPageCopyDestination::Page { .. },
                LibraryBlockLocation::Document { document_id },
            ) => destination_document_id.as_deref() == Some(document_id.as_str()),
            (
                LibraryPageCopyDestination::DataSource { data_source_id, .. },
                LibraryBlockLocation::DataSource {
                    database_id,
                    data_source_id: actual_data_source_id,
                },
            ) => {
                actual_data_source_id == data_source_id
                    && destination_database_id.as_deref() == Some(database_id.as_str())
            }
            _ => false,
        };
        if !valid {
            return Err(corrupt(format!(
                "Agent Page move committed an unexpected final location for {page_id}: {location:?}"
            )));
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn persist_relocation_ledger(
    connection: &Connection,
    operation_id: &str,
    project_id: &str,
    store_epoch: &str,
    request_hash: &str,
    intent: &LibraryBlockTransferLogicalIntent,
    prepared: &PreparedTransfer,
    result: &LibraryBlockTransferResult,
    final_location_revisions: &BTreeMap<String, i64>,
    change_log_seq: i64,
    now: &str,
) -> Result<(), StoreError> {
    let source_commit = result
        .document_commits
        .iter()
        .find(|commit| commit.document_id == prepared.source_authority.head.id)
        .ok_or_else(|| corrupt("Relocation omitted its source commit"))?;
    let target_commit = result
        .document_commits
        .iter()
        .find(|commit| commit.document_id == prepared.target_authority.head.id)
        .ok_or_else(|| corrupt("Relocation omitted its target commit"))?;
    let insertion = match &intent.target {
        LibraryBlockTransferTarget::Page {
            parent_block_id,
            before_block_id,
            ..
        }
        | LibraryBlockTransferTarget::Document {
            parent_block_id,
            before_block_id,
            ..
        } => (parent_block_id.as_deref(), before_block_id.as_deref()),
        _ => (None, None),
    };
    let request_json =
        serde_json::to_string(intent).map_err(|_| internal("Relocation request JSON"))?;
    let roots_json = serde_json::to_string(&intent.root_block_ids)
        .map_err(|_| internal("Relocation roots JSON"))?;
    let expected_revisions_json = serde_json::to_string(&prepared.expected_location_revisions)
        .map_err(|_| internal("Relocation expected revisions JSON"))?;
    let final_revisions_json = serde_json::to_string(final_location_revisions)
        .map_err(|_| internal("Relocation final revisions JSON"))?;
    let result_json =
        serde_json::to_string(result).map_err(|_| internal("Relocation result JSON"))?;
    connection.execute(
        "INSERT INTO block_relocations(\
           id, project_id, library_id, store_epoch, request_hash, request_json, \
           source_document_id, source_generation, source_base_head_seq, target_kind, \
           target_document_id, target_generation, target_base_head_seq, target_parent_block_id, \
           target_before_block_id, root_block_ids_json, expected_placement_revisions_json, status, \
           source_update_id, source_committed_seq, target_update_id, target_committed_seq, \
           final_placement_revisions_json, result_json, change_log_seq, committed_at\
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'document', ?10, ?11, ?12, \
                   ?13, ?14, ?15, ?16, 'committed', ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24)",
        params![
            operation_id,
            project_id,
            prepared.source_authority.head.library_id,
            store_epoch,
            request_hash,
            request_json,
            prepared.source_authority.head.id,
            prepared.source_authority.head.generation,
            prepared.source_authority.head.head_seq,
            prepared.target_authority.head.id,
            prepared.target_authority.head.generation,
            prepared.target_authority.head.head_seq,
            insertion.0,
            insertion.1,
            roots_json,
            expected_revisions_json,
            source_commit.update_id,
            source_commit.head_seq,
            target_commit.update_id,
            target_commit.head_seq,
            final_revisions_json,
            result_json,
            change_log_seq,
            now,
        ],
    )?;
    let roots = intent.root_block_ids.iter().collect::<BTreeSet<_>>();
    for (ordinal, block_id) in prepared.prepared.source_forest.block_ids.iter().enumerate() {
        let source_revision = final_location_revisions
            .get(block_id)
            .copied()
            .ok_or_else(|| corrupt("Relocation member has no final revision"))?
            - 1;
        connection.execute(
            "INSERT INTO block_relocation_members(\
               relocation_id, block_id, library_id, tree_ordinal, is_root, \
               source_placement_revision, final_placement_revision\
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                operation_id,
                block_id,
                prepared.source_authority.head.library_id,
                i64::try_from(ordinal).map_err(|_| internal("Relocation ordinal overflow"))?,
                i64::from(roots.contains(block_id)),
                source_revision,
                source_revision + 1,
            ],
        )?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn persist_mutation_ledger(
    connection: &Connection,
    operation_id: &str,
    project_id: &str,
    store_epoch: &str,
    request_hash: &str,
    intent: &LibraryBlockTransferLogicalIntent,
    result: &LibraryBlockTransferResult,
    change_log_seq: i64,
    now: &str,
) -> Result<(), StoreError> {
    // Keep the operation description here; exact replay and Page History have
    // independent receipt/checkpoint owners and must not depend on ledger bodies.
    let document_heads = result
        .document_commits
        .iter()
        .map(|commit| (commit.document_id.clone(), commit.head_seq))
        .collect::<BTreeMap<_, _>>();
    connection.execute(
        "INSERT INTO block_mutations(\
           mutation_id, project_id, store_epoch, mutation_kind, actor_json, client_session_id, \
           request_hash, request_json, target_block_ids_json, affected_document_ids_json, \
           affected_database_block_ids_json, field_intents_json, expected_revisions_json, outcome, \
           result_json, committed_revisions_json, document_heads_json, change_log_seq, recorded_at\
         ) VALUES (?1, ?2, ?3, 'block_transfer', ?4, NULL, ?5, ?6, ?7, ?8, '[]', '[]', \
                   '{}', 'committed', ?9, '{}', ?10, ?11, ?12)",
        params![
            operation_id,
            project_id,
            store_epoch,
            serde_json::to_string(&intent.actor).map_err(|_| internal("Transfer actor JSON"))?,
            request_hash,
            serde_json::json!({ "kind": "transfer_blocks", "mode": intent.mode }).to_string(),
            serde_json::to_string(&result.result_root_block_ids)
                .map_err(|_| internal("Transfer target IDs JSON"))?,
            serde_json::to_string(
                &result
                    .document_commits
                    .iter()
                    .map(|commit| commit.document_id.clone())
                    .collect::<Vec<_>>(),
            )
            .map_err(|_| internal("Transfer Document IDs JSON"))?,
            "{}",
            serde_json::to_string(&document_heads)
                .map_err(|_| internal("Transfer Document heads JSON"))?,
            change_log_seq,
            now,
        ],
    )?;
    Ok(())
}

fn persist_operation_checkpoints(
    connection: &Connection,
    context: &BoundModuleContext,
    operation_id: &str,
    actor: &Value,
    commits: &[PersistedTransferCommit],
    change_log_seq: i64,
    now: &str,
) -> Result<(), StoreError> {
    let mut checkpoint_context = context.clone();
    if checkpoint_context.project_id.is_none() {
        checkpoint_context.project_id = Some(nodex_core_contracts::ProjectId(
            super::mutation::resolve_library_actor_project_id(connection, &context.library_id.0)?,
        ));
    }
    for commit in commits {
        let authority = read_document_authority(connection, &commit.public.document_id)?
            .ok_or_else(|| corrupt("Committed transfer Document disappeared"))?;
        insert_document_checkpoint(
            connection,
            &authority,
            &commit.materialization,
            NewDocumentCheckpoint {
                operation_id,
                cause: "block-transfer",
                label: None,
                revision_kind: "operation",
                source_mutation_id: Some(operation_id),
                source_change_seq: Some(change_log_seq),
                actor: Some(actor),
                context: &checkpoint_context,
                now,
            },
        )?;
    }
    Ok(())
}

fn read_block_transfer_undo_recipe(
    connection: &Connection,
    context: &BoundModuleContext,
    library_id: &str,
    token: &LibraryBlockTransferUndoToken,
) -> Result<BlockTransferUndoRecipeV4, StoreError> {
    let (json, project_id) = history::read(connection, context, library_id, token)?;
    if context.project_id.as_ref().map(|id| id.0.as_str()) != Some(project_id.as_str()) {
        return Err(unauthorized(
            "Block transfer Undo token is outside this scope",
        ));
    }
    let recipe = serde_json::from_str::<BlockTransferUndoRecipeV4>(&json)
        .map_err(|_| corrupt("Stored Block transfer Undo recipe is invalid"))?;
    if recipe.version != BLOCK_TRANSFER_UNDO_RECIPE_VERSION {
        return Err(conflict(
            "Promotion history uses an unavailable View position format",
        ));
    }
    if recipe.project_id != project_id
        || recipe.library_id != library_id
        || recipe.store_epoch != token.store_epoch
    {
        return Err(corrupt(
            "Stored Block transfer Undo recipe identity changed",
        ));
    }
    Ok(recipe)
}

/// Authorize the complete write set before normalizing stored bodies or
/// comparing any current head, property, schema, or File state. A conflict in
/// an earlier root must not reveal content after a later root loses access.
fn authorize_promotion_inverse(
    connection: &Connection,
    recipe: &BlockTransferUndoRecipeV4,
) -> Result<(), StoreError> {
    require_project_in_library(connection, &recipe.project_id, &recipe.library_id)?;
    for root in &recipe.roots {
        super::require_page_write_access(
            connection,
            &recipe.library_id,
            &recipe.project_id,
            &root.result_page_id,
        )?;
        let data_source = connection
            .query_row(
                "SELECT parent_id FROM pages WHERE block_id = ?1 AND parent_kind = 'data_source'",
                [&root.result_page_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        if let Some(data_source) = data_source {
            validate_page_transfer_data_source_source(
                connection,
                &recipe.library_id,
                &recipe.project_id,
                &data_source,
            )?;
        }
    }
    if recipe.mode == LibraryBlockTransferMode::Move {
        let source_page_id = connection
            .query_row(
                "SELECT block_id FROM block_documents WHERE document_id = ?1 AND library_id = ?2",
                params![recipe.source_document_id, recipe.library_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .ok_or_else(|| conflict("Source Page is no longer available for Undo"))?;
        super::require_page_write_access(
            connection,
            &recipe.library_id,
            &recipe.project_id,
            &source_page_id,
        )?;
    }
    if let Some(schema) = &recipe.schema_restore {
        validate_page_transfer_data_source_source(
            connection,
            &recipe.library_id,
            &recipe.project_id,
            &schema.data_source_id,
        )?;
    }
    Ok(())
}

fn read_page_relocation_undo_recipe(
    connection: &Connection,
    context: &BoundModuleContext,
    library_id: &str,
    token: &LibraryBlockTransferUndoToken,
    authority: &super::mutation::LibraryMutationAuthority,
) -> Result<PageRelocationUndoRecipeV3, StoreError> {
    let (json, project_id) = history::read(connection, context, library_id, token)?;
    let project_scope_matches = authority
        .requesting_project_id
        .as_deref()
        .is_none_or(|requesting| requesting == project_id);
    if !project_scope_matches || context.library_id.0 != library_id {
        return Err(unauthorized(
            "Page relocation Undo token is outside this scope",
        ));
    }
    let version = serde_json::from_str::<serde_json::Value>(&json)
        .ok()
        .and_then(|value| value.get("version").and_then(serde_json::Value::as_u64));
    if version != Some(u64::from(PAGE_RELOCATION_UNDO_RECIPE_VERSION)) {
        return Err(conflict("Page relocation Undo is no longer available"));
    }
    let recipe = serde_json::from_str::<PageRelocationUndoRecipeV3>(&json)
        .map_err(|_| corrupt("Stored Page relocation Undo recipe is invalid"))?;
    if recipe.project_id != project_id
        || recipe.library_id != library_id
        || recipe.store_epoch != token.store_epoch
    {
        return Err(corrupt(
            "Stored Page relocation Undo recipe identity changed",
        ));
    }
    require_project_in_library(connection, &recipe.project_id, library_id)?;
    Ok(recipe)
}

fn validate_undo_created_tags_are_private(
    connection: &Connection,
    recipe: &BlockTransferUndoRecipeV4,
) -> Result<(), StoreError> {
    let Some(schema) = &recipe.schema_restore else {
        return Ok(());
    };
    let removed_pages = recipe
        .roots
        .iter()
        .map(|root| root.result_page_id.as_str())
        .collect::<BTreeSet<_>>();
    let mut statement = connection.prepare(
        "SELECT membership.page_block_id, value.value_json \
         FROM data_source_property_values value \
         JOIN data_source_page_memberships membership \
           ON membership.id = value.membership_id \
          AND membership.data_source_id = value.data_source_id \
         WHERE value.data_source_id = ?1 AND value.property_id = ?2 \
           AND membership.removed_at IS NULL",
    )?;
    let rows = statement.query_map(params![schema.data_source_id, schema.property_id], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    for row in rows {
        let (page_id, value_json) = row?;
        if removed_pages.contains(page_id.as_str()) {
            continue;
        }
        let values = serde_json::from_str::<Vec<String>>(&value_json).unwrap_or_default();
        if values
            .iter()
            .any(|value| schema.created_option_ids.contains(value))
        {
            return Err(conflict(
                "A tag created by this promotion is now used by another Page",
            ));
        }
    }
    Ok(())
}

fn purge_promoted_page(
    connection: &Connection,
    recipe: &BlockTransferUndoRecipeV4,
    root: &BlockTransferUndoRootV1,
) -> Result<(), StoreError> {
    let indexed_block_ids = connection
        .prepare(
            "SELECT block_id FROM document_block_index \
             WHERE document_id = ?1 ORDER BY ordinal, block_id",
        )?
        .query_map([&root.result_document_id], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    crate::database::forget_page_view_order(connection, &root.result_page_id)?;
    connection.execute(
        "DELETE FROM data_source_page_memberships WHERE page_block_id = ?1",
        [&root.result_page_id],
    )?;
    connection.execute(
        "DELETE FROM page_read_model WHERE page_block_id = ?1",
        [&root.result_page_id],
    )?;
    connection.execute(
        "DELETE FROM scheduled_page_index WHERE page_block_id = ?1",
        [&root.result_page_id],
    )?;
    connection.execute(
        "DELETE FROM project_resource_grants WHERE root_kind = 'page' AND root_id = ?1",
        [&root.result_page_id],
    )?;
    connection.execute(
        "DELETE FROM library_block_placements WHERE block_id = ?1",
        [&root.result_page_id],
    )?;
    connection.execute(
        "DELETE FROM document_block_index WHERE document_id = ?1",
        [&root.result_document_id],
    )?;
    connection.execute(
        "DELETE FROM block_documents WHERE block_id = ?1 AND document_id = ?2",
        params![root.result_page_id, root.result_document_id],
    )?;
    connection.execute(
        "DELETE FROM pages WHERE block_id = ?1 AND document_id = ?2",
        params![root.result_page_id, root.result_document_id],
    )?;
    let deleted_document = connection.execute(
        "DELETE FROM documents WHERE id = ?1",
        [&root.result_document_id],
    )?;
    if deleted_document != 1 {
        return Err(conflict("Promoted Page Document changed before Undo"));
    }

    let retained = if recipe.mode == LibraryBlockTransferMode::Move {
        root.source_block_ids
            .iter()
            .cloned()
            .collect::<BTreeSet<_>>()
    } else {
        BTreeSet::new()
    };
    for block_id in indexed_block_ids
        .into_iter()
        .chain(std::iter::once(root.result_page_id.clone()))
    {
        if retained.contains(&block_id) {
            continue;
        }
        connection.execute("DELETE FROM blocks WHERE id = ?1", [&block_id])?;
    }
    // Wrapper promotion keeps the original media/code Block inside a fresh
    // Page. Only identity-preserving promotion changed the root into a Page
    // and therefore needs its type and intrinsic properties restored.
    if recipe.mode == LibraryBlockTransferMode::Move && root.source_root_id == root.result_page_id {
        connection.execute(
            "DELETE FROM block_properties WHERE block_id = ?1",
            [&root.source_root_id],
        )?;
        let changed = connection.execute(
            "UPDATE blocks SET type = ?1, placement_revision = placement_revision + 1, \
               metadata_revision = metadata_revision + 1, updated_at = ?2 \
             WHERE id = ?3 AND library_id = ?4 AND lifecycle = 'active' AND type = 'page'",
            params![
                root.source_root_type,
                sqlite_now(connection)?,
                root.source_root_id,
                recipe.library_id,
            ],
        )?;
        if changed != 1 {
            return Err(conflict("Promoted root changed before Undo"));
        }
        let now = sqlite_now(connection)?;
        for property in &root.source_root_properties {
            connection.execute(
                "INSERT INTO block_properties(\
                   block_id, library_id, property_key, value_type, value_json, revision, updated_at\
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    root.source_root_id,
                    recipe.library_id,
                    property.property_key,
                    property.value_type,
                    property.value_json,
                    property.revision + 1,
                    now,
                ],
            )?;
        }
    }
    Ok(())
}

fn restore_undo_schema(
    connection: &Connection,
    recipe: &BlockTransferUndoRecipeV4,
    now: &str,
) -> Result<BTreeMap<String, i64>, StoreError> {
    let Some(schema) = &recipe.schema_restore else {
        return Ok(BTreeMap::new());
    };
    let property_revision = connection.query_row(
        "UPDATE data_source_properties \
         SET config_json = ?1, schema_revision = schema_revision + 1, updated_at = ?2 \
         WHERE data_source_id = ?3 AND id = ?4 AND lifecycle = 'active' \
         RETURNING schema_revision",
        params![
            schema.pre_config_json,
            now,
            schema.data_source_id,
            schema.property_id,
        ],
        |row| row.get::<_, i64>(0),
    )?;
    let source_revision = connection.query_row(
        "UPDATE data_sources SET schema_revision = schema_revision + 1, updated_at = ?1 \
         WHERE id = ?2 AND lifecycle = 'active' RETURNING schema_revision",
        params![now, schema.data_source_id],
        |row| row.get::<_, i64>(0),
    )?;
    Ok(BTreeMap::from([
        (
            format!("dataSource:{}:schema", schema.data_source_id),
            source_revision,
        ),
        (
            format!(
                "dataSource:{}:property:{}:schema",
                schema.data_source_id, schema.property_id
            ),
            property_revision,
        ),
    ]))
}

fn page_relocation_result_parent_matches(
    expected: &PageRelocationUndoParentV2,
    library_id: &str,
    parent_kind: &str,
    parent_id: &str,
) -> bool {
    match expected {
        PageRelocationUndoParentV2::Library {
            library_id: expected_library_id,
        } => {
            parent_kind == "library" && parent_id == expected_library_id && parent_id == library_id
        }
        PageRelocationUndoParentV2::Page { page_id } => {
            parent_kind == "page" && parent_id == page_id
        }
        PageRelocationUndoParentV2::DataSource { data_source_id } => {
            parent_kind == "data_source" && parent_id == data_source_id
        }
    }
}

fn resolve_page_relocation_sibling_anchor(
    sibling_ids: &[String],
    previous_sibling_id: Option<&str>,
    next_sibling_id: Option<&str>,
) -> Result<Option<String>, StoreError> {
    if let Some(next_sibling_id) = next_sibling_id
        && sibling_ids.iter().any(|sibling| sibling == next_sibling_id)
    {
        return Ok(Some(next_sibling_id.to_owned()));
    }
    if let Some(previous_sibling_id) = previous_sibling_id
        && let Some(previous_index) = sibling_ids
            .iter()
            .position(|sibling| sibling == previous_sibling_id)
    {
        return Ok(sibling_ids.get(previous_index + 1).cloned());
    }
    if previous_sibling_id.is_none() && next_sibling_id.is_none() {
        return Ok(sibling_ids.first().cloned());
    }
    Err(conflict(
        "Page relocation source position changed and cannot be restored safely",
    ))
}

fn resolve_library_page_relocation_anchor(
    connection: &Connection,
    library_id: &str,
    previous_sibling_id: Option<&str>,
    next_sibling_id: Option<&str>,
) -> Result<Option<String>, StoreError> {
    let sibling_ids = connection
        .prepare(
            "SELECT placement.block_id FROM library_block_placements placement \
             JOIN blocks block ON block.id = placement.block_id \
             WHERE placement.library_id = ?1 AND block.library_id = ?1 \
               AND block.lifecycle = 'active' \
             ORDER BY placement.rank_key, placement.block_id",
        )?
        .query_map([library_id], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    resolve_page_relocation_sibling_anchor(&sibling_ids, previous_sibling_id, next_sibling_id)
}

fn resolve_document_page_relocation_anchor(
    connection: &Connection,
    library_id: &str,
    page_id: &str,
    document_id: &str,
    parent_block_id: Option<&str>,
    previous_sibling_id: Option<&str>,
    next_sibling_id: Option<&str>,
) -> Result<Option<String>, StoreError> {
    let current_document_id = resolve_page_document(connection, library_id, page_id)?;
    if current_document_id != document_id {
        return Err(conflict(
            "Page relocation source Document is no longer available for Undo",
        ));
    }
    let document =
        load_page_ownership_document_prevalidated(connection, library_id, document_id, None)?;
    let sibling_ids = match parent_block_id {
        Some(parent_block_id) => {
            materialized_child_ids(&document.base_materialization.block_tree, parent_block_id)
                .ok_or_else(|| conflict("Page relocation source parent changed before Undo"))?
        }
        None => document
            .base_materialization
            .block_tree
            .iter()
            .map(|sibling| sibling.id.clone())
            .collect(),
    };
    resolve_page_relocation_sibling_anchor(&sibling_ids, previous_sibling_id, next_sibling_id)
}

fn materialized_child_ids(
    blocks: &[MaterializedBlockNode],
    parent_block_id: &str,
) -> Option<Vec<String>> {
    for block in blocks {
        if block.id == parent_block_id {
            return Some(
                block
                    .children
                    .iter()
                    .map(|child| child.id.clone())
                    .collect(),
            );
        }
        if let Some(children) = materialized_child_ids(&block.children, parent_block_id) {
            return Some(children);
        }
    }
    None
}

#[allow(clippy::too_many_arguments)]
pub(super) fn undo_page_relocation(
    connection: &Connection,
    context: &BoundModuleContext,
    library_id: &str,
    operation_id: &str,
    store_epoch: &str,
    request_hash: &str,
    token: &LibraryBlockTransferUndoToken,
    assets_root: &Path,
) -> Result<LibraryApplyOutcome, StoreError> {
    if token.store_epoch != store_epoch {
        return Err(StoreError::new(
            StoreErrorCode::StaleStoreEpoch,
            "Page relocation Undo targets a stale store epoch",
            true,
        ));
    }
    let authority =
        super::mutation::resolve_library_mutation_authority(connection, context, library_id)?;
    let recipe =
        read_page_relocation_undo_recipe(connection, context, library_id, token, &authority)?;
    let (parent_kind, parent_id, location_revision) = connection
        .query_row(
            "SELECT page.parent_kind, page.parent_id, block.placement_revision FROM pages page \
             JOIN blocks block ON block.id = page.block_id \
               AND block.library_id = page.library_id \
             JOIN documents document ON document.id = page.document_id \
               AND document.library_id = page.library_id \
             WHERE page.block_id = ?1 AND page.library_id = ?2 \
               AND block.type = 'page' AND block.lifecycle = 'active' \
               AND document.readiness = 'ready'",
            params![recipe.page_id, library_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| conflict("Moved Page is no longer available for Undo"))?;
    if location_revision != recipe.result_location_revision
        || !page_relocation_result_parent_matches(
            &recipe.result_parent,
            library_id,
            &parent_kind,
            &parent_id,
        )
    {
        return Err(conflict("Page moved again after this relocation"));
    }
    let source = match parent_kind.as_str() {
        "library" if parent_id == library_id => LibraryBlockTransferSource::Library {
            library_id: library_id.to_owned(),
        },
        "page" => LibraryBlockTransferSource::Page { page_id: parent_id },
        "data_source" => LibraryBlockTransferSource::DataSource {
            data_source_id: parent_id,
        },
        _ => return Err(corrupt("Moved Page has inconsistent parent authority")),
    };
    let target = match &recipe.source {
        PageRelocationUndoSourceV3::Library {
            previous_sibling_id,
            next_sibling_id,
        } => LibraryBlockTransferTarget::Library {
            library_id: library_id.to_owned(),
            before_block_id: resolve_library_page_relocation_anchor(
                connection,
                library_id,
                previous_sibling_id.as_deref(),
                next_sibling_id.as_deref(),
            )?,
        },
        PageRelocationUndoSourceV3::Page {
            page_id,
            document_id,
            parent_block_id,
            previous_sibling_id,
            next_sibling_id,
        } => LibraryBlockTransferTarget::Page {
            page_id: page_id.clone(),
            parent_block_id: parent_block_id.clone(),
            before_block_id: resolve_document_page_relocation_anchor(
                connection,
                library_id,
                page_id,
                document_id,
                parent_block_id.as_deref(),
                previous_sibling_id.as_deref(),
                next_sibling_id.as_deref(),
            )?,
        },
        PageRelocationUndoSourceV3::DataSource {
            data_source_id,
            default_view_id,
            ..
        } => LibraryBlockTransferTarget::DataSource {
            data_source_id: data_source_id.clone(),
            placement: Box::new(LibraryBlockTransferDataSourcePlacement::Direct {
                view_id: default_view_id.clone(),
                preferences_override: DatabaseViewPreferencesOverrideInput::default(),
                group_key: None,
                before_page_id: None,
                sorted_property_values: Vec::new(),
            }),
        },
    };
    let intent = LibraryBlockTransferLogicalIntent {
        actor: serde_json::json!({ "kind": "electron_host", "command": "undo_page_relocation" }),
        mode: LibraryBlockTransferMode::Move,
        root_block_ids: vec![recipe.page_id.clone()],
        causal_dependencies: Vec::new(),
        source,
        target,
        promotion_policy: LibraryPagePromotionPolicy::Literal,
    };
    let mut prepared = prepare_for_semantic_page_move(
        connection,
        None,
        context,
        library_id,
        operation_id,
        store_epoch,
        &intent,
        &authority,
    )?;
    if matches!(
        &recipe.source,
        PageRelocationUndoSourceV3::DataSource { .. }
    ) {
        preserve_page_relocation_source_values(&mut prepared)?;
    }
    let transfer_authority = match authority.requesting_project_id.as_deref() {
        Some(project_id) => PageOwnershipTransferAuthority::ProjectBound { project_id },
        None => PageOwnershipTransferAuthority::TrustedLibrary(&authority),
    };
    apply_with_authority(
        connection,
        context,
        library_id,
        operation_id,
        store_epoch,
        request_hash,
        &intent,
        assets_root,
        transfer_authority,
        PageOwnershipHistory::UndoRelocation {
            recipe,
            token: token.clone(),
        },
        None,
        prepared,
    )
}

#[allow(clippy::too_many_arguments)]
pub(super) fn reverse_history_payload(
    connection: &Connection,
    context: &BoundModuleContext,
    library_id: &str,
    operation_id: &str,
    store_epoch: &str,
    request_hash: &str,
    token: &nodex_core_contracts::library::LibraryStructuralHistoryToken,
    project_id: &str,
    json: &str,
) -> Result<Option<LibraryApplyOutcome>, StoreError> {
    if let Ok(state) = serde_json::from_str::<promotion_history::PromotionRestore>(json) {
        if state.undo.project_id != project_id {
            return Err(corrupt("Promotion history Project changed"));
        }
        if state.undo.version != BLOCK_TRANSFER_UNDO_RECIPE_VERSION {
            return Err(conflict(
                "Promotion history uses an unavailable View position format",
            ));
        }
        return promotion_history::restore(
            connection,
            context,
            library_id,
            operation_id,
            store_epoch,
            request_hash,
            token,
            state,
        )
        .map(Some);
    }
    let Ok(recipe) = serde_json::from_str::<BlockTransferUndoRecipeV4>(json) else {
        return Ok(None);
    };
    if recipe.version != BLOCK_TRANSFER_UNDO_RECIPE_VERSION {
        return Err(conflict(
            "Promotion history uses an unavailable View position format",
        ));
    }
    if recipe.project_id != project_id
        || recipe.library_id != library_id
        || recipe.store_epoch != store_epoch
    {
        return Err(corrupt("Promotion history identity changed"));
    }
    undo_promotion(
        connection,
        context,
        library_id,
        operation_id,
        store_epoch,
        request_hash,
        &LibraryBlockTransferUndoToken {
            transfer_operation_id: token.recipe_operation_id.clone(),
            recipe_hash: token.recipe_hash.clone(),
            store_epoch: token.store_epoch.clone(),
        },
        recipe,
        true,
    )
    .map(Some)
}

pub(super) fn undo(
    connection: &Connection,
    context: &BoundModuleContext,
    library_id: &str,
    operation_id: &str,
    store_epoch: &str,
    request_hash: &str,
    token: &LibraryBlockTransferUndoToken,
) -> Result<LibraryApplyOutcome, StoreError> {
    if token.store_epoch != store_epoch {
        return Err(StoreError::new(
            StoreErrorCode::StaleStoreEpoch,
            "Block transfer Undo targets a stale store epoch",
            true,
        ));
    }
    let recipe = read_block_transfer_undo_recipe(connection, context, library_id, token)?;
    undo_promotion(
        connection,
        context,
        library_id,
        operation_id,
        store_epoch,
        request_hash,
        token,
        recipe,
        false,
    )
}

#[allow(clippy::too_many_arguments)]
fn undo_promotion(
    connection: &Connection,
    context: &BoundModuleContext,
    library_id: &str,
    operation_id: &str,
    store_epoch: &str,
    request_hash: &str,
    token: &LibraryBlockTransferUndoToken,
    mut recipe: BlockTransferUndoRecipeV4,
    structural_delivery: bool,
) -> Result<LibraryApplyOutcome, StoreError> {
    authorize_promotion_inverse(connection, &recipe)?;
    let footprint = promotion_history::capture_footprint(connection, &recipe.roots)?;
    if recipe
        .footprint
        .as_ref()
        .is_some_and(|expected| expected != &footprint)
    {
        return Err(conflict(
            "Promotion schema or Relations changed after commit",
        ));
    }
    recipe.footprint = Some(footprint);
    if let Some(stored) = &recipe.source_pre_materialization {
        let authority = read_document_authority(connection, &recipe.source_document_id)?
            .ok_or_else(|| conflict("Source Document is no longer available for Undo"))?;
        recipe.source_pre_materialization =
            Some(crate::document::normalize_stored_document_materialization(
                &recipe.source_document_id,
                require_schema(&authority)?,
                stored,
            )?);
    }
    if let Some(expected_head_seq) = recipe.source_post_head_seq {
        let current = read_document_authority(connection, &recipe.source_document_id)?
            .ok_or_else(|| conflict("Source Document is no longer available for Undo"))?;
        if current.head.generation != recipe.source_generation
            || current.head.head_seq != expected_head_seq
        {
            return Err(conflict("Source Document changed after Block promotion"));
        }
    }
    let target_guard = block_transfer_target_guard_hash(
        connection,
        &recipe.roots,
        recipe.schema_restore.as_ref(),
    )?;
    if target_guard != recipe.target_guard_hash {
        return Err(conflict(
            "Promoted Page or target schema changed after promotion",
        ));
    }
    validate_undo_created_tags_are_private(connection, &recipe)?;
    let mut promotion_restore = promotion_history::capture(connection, &recipe, operation_id)?;

    let mut source_restore = if recipe.mode == LibraryBlockTransferMode::Move {
        let authority = read_document_authority(connection, &recipe.source_document_id)?
            .ok_or_else(|| conflict("Source Document is no longer available for Undo"))?;
        let schema = require_schema(&authority)?;
        let engine = reconstruct_yjs_engine(connection, &authority.head)?;
        let decoded = decode_block_document(engine.document(), schema)
            .map_err(|error| corrupt(error.to_string()))?;
        let base =
            materialize_decoded_document(&decoded).map_err(|error| corrupt(error.to_string()))?;
        let target = recipe
            .source_pre_materialization
            .as_ref()
            .ok_or_else(|| corrupt("Move Undo recipe has no source snapshot"))?;
        let operations = source_restore_operations(
            target,
            &recipe.roots,
            recipe.source_placeholder_block_id.as_deref(),
        )?;
        let update = prepare_document_operation_update(
            &authority.head.id,
            schema,
            &engine.full_state_v1(),
            &authority.head.state_vector,
            &operations,
            false,
        )
        .map_err(|error| invalid(error.to_string()))?;
        if update.materialization != *target {
            return Err(corrupt(
                "Block transfer Undo did not restore the exact source Document",
            ));
        }
        Some((authority, engine, base, update))
    } else {
        None
    };

    let now = sqlite_now(connection)?;
    let commit_result = durable_mutation::run(
        connection,
        OperationIdentity {
            module: ModuleName::Library,
            module_name: MODULE_NAME,
            operation_id,
            intent_hash: request_hash,
            store_epoch,
            committed_at: &now,
            context,
        },
        |scope| {
            let mut document_commits = if let Some(state) = promotion_restore.as_mut() {
                promotion_history::retire(connection, state, operation_id, scope.evidence(), &now)?
            } else {
                for root in &recipe.roots {
                    purge_promoted_page(connection, &recipe, root)?;
                }
                Vec::new()
            };
            if let Some((authority, engine, base, update)) = source_restore.as_mut() {
                let advances = recipe
                    .roots
                    .iter()
                    .flat_map(|root| root.source_block_ids.iter().cloned())
                    .collect::<Vec<_>>();
                document_commits.push(persist_prepared_update(
                    connection,
                    &recipe.project_id,
                    authority,
                    base,
                    engine,
                    update.clone(),
                    &format!("block-transfer-undo:{request_hash}:source"),
                    operation_id,
                    store_epoch,
                    TransferDocumentPlacement::Derived {
                        advances: &advances,
                        exact_moves: &[],
                    },
                    &[],
                    scope.evidence(),
                )?);
            }
            let mut committed_revisions = restore_undo_schema(connection, &recipe, &now)?;
            if let Some(state) = &promotion_restore {
                committed_revisions.extend(promotion_history::block_revisions(connection, state)?);
            }
            let pending_history = promotion_restore
                .clone()
                .map(|state| promotion_history::seal_restore(connection, operation_id, state))
                .transpose()?;
            for commit in &document_commits {
                committed_revisions.insert(
                    format!("documentHead:{}", commit.public.document_id),
                    commit.public.head_seq,
                );
            }
            history::consume(
                connection,
                token,
                &recipe.project_id,
                &now,
                scope.evidence(),
            )?;
            let result = LibraryBlockTransferUndoResult {
                transfer_operation_id: token.transfer_operation_id.clone(),
                restored_source_root_ids: if recipe.mode == LibraryBlockTransferMode::Move {
                    recipe
                        .roots
                        .iter()
                        .map(|root| root.source_root_id.clone())
                        .collect()
                } else {
                    Vec::new()
                },
                removed_page_ids: recipe
                    .roots
                    .iter()
                    .map(|root| root.result_page_id.clone())
                    .collect(),
                document_commits: document_commits
                    .iter()
                    .map(|commit| commit.public.clone())
                    .collect(),
                history: pending_history
                    .as_ref()
                    .map(|prepared| history::token(&prepared.token)),
            };
            let affected_database_ids = promotion_restore
                .as_ref()
                .map(|state| state.database_ids())
                .unwrap_or_else(|| {
                    recipe
                        .schema_restore
                        .as_ref()
                        .map(|schema| vec![schema.data_source_id.clone()])
                        .unwrap_or_default()
                });
            let affected_view_ids = promotion_restore
                .as_ref()
                .map(|state| state.view_ids())
                .unwrap_or_default();
            let mut affected_parent_keys = promotion_restore
                .as_ref()
                .map(|state| state.parent_keys())
                .unwrap_or_else(|| {
                    recipe
                        .schema_restore
                        .as_ref()
                        .map(|schema| vec![format!("data_source:{}", schema.data_source_id)])
                        .unwrap_or_else(|| vec![format!("library:{library_id}")])
                });
            affected_parent_keys.sort();
            affected_parent_keys.dedup();
            let mut affected_page_ids = result.removed_page_ids.clone();
            affected_page_ids.sort();
            affected_page_ids.dedup();
            seal_mutation_with(
                scope,
                context,
                operation_id,
                MutationEffects {
                    page_file_entries: Vec::new(),
                    file_revisions: BTreeMap::new(),
                    file_mutation: Default::default(),
                    project_id: recipe.project_id.clone(),
                    operation_kind: if structural_delivery {
                        "reverse_structural_edit"
                    } else {
                        "undo_block_transfer"
                    },
                    change_kind: "block_mutation",
                    did_mutate: true,
                    created_target: None,
                    affected_parent_keys,
                    affected_block_ids: promotion_restore.as_ref().map_or_else(
                        || result.restored_source_root_ids.clone(),
                        |state| state.affected_block_ids(),
                    ),
                    affected_page_ids,
                    affected_database_ids: affected_database_ids.clone(),
                    affected_view_ids,
                    affected_document_ids: result
                        .document_commits
                        .iter()
                        .map(|commit| commit.document_id.clone())
                        .chain(
                            recipe
                                .roots
                                .iter()
                                .map(|root| root.result_document_id.clone()),
                        )
                        .collect(),
                    committed_revisions,
                    page_create: None,
                    page_copy: None,
                    canvas_mutation: None,
                    block_transfer: None,
                    block_transfer_undo: (!structural_delivery).then(|| result.clone()),
                    page_relocation_undo: None,
                    structural_edit: structural_delivery.then(|| {
                        promotion_history::structural_result(
                            &recipe,
                            recipe
                                .roots
                                .iter()
                                .map(|root| root.result_page_id.clone())
                                .collect(),
                            result.restored_source_root_ids.clone(),
                            result.document_commits.clone(),
                            result.history.clone(),
                            affected_database_ids.clone(),
                        )
                    }),
                    page_lifecycle: None,
                    block_property_mutation: None,
                    agent_page_copy: None,
                    agent_create_pages: None,
                    agent_move_pages: None,
                    change_payload: None,
                    committed_at: now.clone(),
                },
                |_, event_sequence| {
                    if let Some(prepared) = &pending_history {
                        promotion_history::persist_ledger(
                            connection,
                            operation_id,
                            store_epoch,
                            request_hash,
                            &recipe,
                            "undo_block_promotion",
                            &result.removed_page_ids,
                            &result.document_commits,
                            event_sequence,
                            &now,
                        )?;
                        history::persist(connection, prepared, &now)?;
                    }
                    Ok(())
                },
            )
        },
    )?;
    library_commit_result(connection, commit_result)
}

/// Reinsert moved roots at their original structural coordinates without
/// replacing the whole Yjs document. Open ProseMirror bindings can then apply
/// the relative update while preserving their live fragment and selection.
fn source_restore_operations(
    source_before_transfer: &DocumentMaterialization,
    roots: &[BlockTransferUndoRootV1],
    placeholder_block_id: Option<&str>,
) -> Result<Vec<DocumentBlockOperation>, StoreError> {
    let moved = roots
        .iter()
        .flat_map(|root| root.source_block_ids.iter().map(String::as_str))
        .collect::<BTreeSet<_>>();
    let expected_roots = roots
        .iter()
        .map(|root| root.source_root_id.as_str())
        .collect::<BTreeSet<_>>();

    struct SourceRestoreTraversal<'sets, 'roots> {
        moved: &'sets BTreeSet<&'roots str>,
        expected_roots: &'sets BTreeSet<&'roots str>,
        found_blocks: BTreeSet<String>,
        found_original_roots: BTreeSet<String>,
        operations: Vec<DocumentBlockOperation>,
    }

    impl SourceRestoreTraversal<'_, '_> {
        fn collect_moved(&mut self, block: &MaterializedBlockNode) {
            if self.moved.contains(block.id.as_str()) {
                self.found_blocks.insert(block.id.clone());
            }
            for child in &block.children {
                self.collect_moved(child);
            }
        }

        fn visit_siblings(
            &mut self,
            siblings: &[MaterializedBlockNode],
            parent_block_id: Option<&str>,
            parent_is_moved: bool,
        ) {
            for (index, block) in siblings.iter().enumerate() {
                let is_moved = self.moved.contains(block.id.as_str());
                if is_moved {
                    self.collect_moved(block);
                    if self.expected_roots.contains(block.id.as_str()) {
                        self.found_original_roots.insert(block.id.clone());
                    }
                }
                if is_moved && !parent_is_moved {
                    self.operations.push(DocumentBlockOperation::InsertBlock {
                        block: block.clone(),
                        parent_block_id: parent_block_id.map(str::to_owned),
                        before_block_id: siblings.get(index + 1).map(|sibling| sibling.id.clone()),
                    });
                    continue;
                }
                self.visit_siblings(
                    &block.children,
                    Some(block.id.as_str()),
                    parent_is_moved || is_moved,
                );
            }
        }
    }

    let mut traversal = SourceRestoreTraversal {
        moved: &moved,
        expected_roots: &expected_roots,
        found_blocks: BTreeSet::new(),
        found_original_roots: BTreeSet::new(),
        operations: Vec::with_capacity(expected_roots.len()),
    };
    traversal.visit_siblings(&source_before_transfer.block_tree, None, false);
    if traversal.found_blocks.len() != moved.len()
        || traversal.found_original_roots.len() != expected_roots.len()
    {
        return Err(corrupt(
            "Block transfer Undo source snapshot is missing moved Block evidence",
        ));
    }

    // A selected root may use the next selected sibling as its anchor. Apply
    // right-to-left so every such anchor exists before it is referenced.
    traversal.operations.reverse();
    if let Some(block_id) = placeholder_block_id {
        traversal.operations.insert(
            0,
            DocumentBlockOperation::DeleteBlock {
                block_id: block_id.to_owned(),
            },
        );
    }
    Ok(traversal.operations)
}

fn bound_project_id(context: &BoundModuleContext) -> Result<&str, StoreError> {
    context
        .project_id
        .as_ref()
        .map(|project_id| project_id.0.as_str())
        .ok_or_else(|| unauthorized("Block transfer requires a bound Project"))
}

fn validate_id(value: &str, label: &str) -> Result<(), StoreError> {
    if !value.is_empty() && value.trim() == value && value.len() <= MAX_ID_LENGTH {
        return Ok(());
    }
    Err(invalid(format!("{label} is invalid")))
}

fn invalid(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message, false)
}

fn not_found(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::NotFound, message, false)
}

fn conflict(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::RevisionConflict, message, true)
}

fn unauthorized(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::Unauthorized, message, false)
}

fn corrupt(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message, false)
}

fn internal(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::Internal, message, false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::document::{BlockDocumentKind, DocumentSearchMarkerKind, schema_metadata};
    use crate::domain::rich_text::RichTextStyles;
    use rusqlite::Connection;
    use serde_json::json;

    fn promoted_paragraph(title: &str) -> BlockToPageTransformation {
        BlockToPageTransformation::Promote {
            page_id: "page:result".to_owned(),
            rich_title: vec![RichTextItem::Text {
                text: title.to_owned(),
                styles: RichTextStyles::default(),
            }],
            body_roots: Vec::new(),
            consumed_type: "paragraph".to_owned(),
            consumed_props: BTreeMap::new(),
            placeholder_block_id: None,
        }
    }

    fn materialized_block(
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

    #[test]
    fn page_relocation_undo_anchor_prefers_next_then_previous_successor_and_fails_closed() {
        let siblings = ["first", "previous", "inserted", "next", "last"]
            .map(str::to_owned)
            .to_vec();
        assert_eq!(
            resolve_page_relocation_sibling_anchor(&siblings, Some("previous"), Some("next"))
                .expect("next sibling remains authoritative"),
            Some("next".to_owned())
        );

        let without_next = ["first", "previous", "inserted", "last"]
            .map(str::to_owned)
            .to_vec();
        assert_eq!(
            resolve_page_relocation_sibling_anchor(&without_next, Some("previous"), Some("next"))
                .expect("previous sibling still proves the local slot"),
            Some("inserted".to_owned())
        );
        assert_eq!(
            resolve_page_relocation_sibling_anchor(&without_next, None, None)
                .expect("an originally unique child restores at the current start"),
            Some("first".to_owned())
        );

        let conflict = resolve_page_relocation_sibling_anchor(
            &["unrelated".to_owned()],
            Some("previous"),
            Some("next"),
        )
        .expect_err("missing anchors cannot silently append");
        assert_eq!(conflict.code, StoreErrorCode::RevisionConflict);
    }

    #[test]
    fn undo_restore_reinserts_every_top_level_component_lifted_from_a_moved_root() {
        let schema = schema_metadata(BlockDocumentSchema::PageV3);
        let source_before_transfer = DocumentMaterialization {
            kind: BlockDocumentKind::Page,
            schema_version: schema.schema_version,
            schema,
            title: String::new(),
            rich_title: Vec::new(),
            block_tree: vec![
                materialized_block("code", "codeBlock", Vec::new()),
                materialized_block("lifted", "paragraph", Vec::new()),
                materialized_block("after", "paragraph", Vec::new()),
            ],
            nfm: String::new(),
            plain_text: String::new(),
            preview: String::new(),
            references: Vec::new(),
            asset_refs: Vec::new(),
            search_marker_kind: DocumentSearchMarkerKind::DocumentTitle,
            search_units: Vec::new(),
        };
        let roots = vec![BlockTransferUndoRootV1 {
            source_root_id: "code".to_owned(),
            result_page_id: "page:result".to_owned(),
            result_document_id: "document:result".to_owned(),
            source_block_ids: vec!["code".to_owned(), "lifted".to_owned()],
            source_root_type: "codeBlock".to_owned(),
            source_root_properties: Vec::new(),
        }];

        let operations = source_restore_operations(&source_before_transfer, &roots, None)
            .expect("restore normalized source components");
        let restored = operations
            .iter()
            .map(|operation| match operation {
                DocumentBlockOperation::InsertBlock {
                    block,
                    parent_block_id,
                    before_block_id,
                } => (
                    block.id.as_str(),
                    parent_block_id.as_deref(),
                    before_block_id.as_deref(),
                ),
                _ => panic!("restore operation must insert a Block"),
            })
            .collect::<Vec<_>>();
        assert_eq!(
            restored,
            vec![
                ("lifted", None, Some("after")),
                ("code", None, Some("lifted")),
            ]
        );
    }

    #[test]
    fn task_shorthand_evidence_distinguishes_literal_digit_titles_from_candidates() {
        let (ordinary_evidence, ordinary_candidate) = prepare_task_shorthand_title_policy(
            LibraryPagePromotionPolicy::TaskShorthandV1,
            true,
            &promoted_paragraph("4abc"),
        );
        assert_eq!(
            ordinary_evidence,
            LibraryBlockTransferPromotionEvidence::NoMatch
        );
        assert!(ordinary_candidate.is_none());

        let (candidate_evidence, candidate) = prepare_task_shorthand_title_policy(
            LibraryPagePromotionPolicy::TaskShorthandV1,
            true,
            &promoted_paragraph("4 Later"),
        );
        assert!(matches!(
            candidate_evidence,
            LibraryBlockTransferPromotionEvidence::Preserved { .. }
        ));
        assert!(candidate.is_none());
    }

    #[test]
    fn semantic_identity_ignores_connection_and_adapter_attempt() {
        let intent = LibraryBlockTransferLogicalIntent {
            actor: json!({ "kind": "test" }),
            mode: LibraryBlockTransferMode::Move,
            root_block_ids: vec!["block-1".to_owned()],
            causal_dependencies: Vec::new(),
            source: LibraryBlockTransferSource::Document {
                document_id: "document-1".to_owned(),
            },
            target: LibraryBlockTransferTarget::Document {
                document_id: "document-2".to_owned(),
                parent_block_id: None,
                before_block_id: None,
            },
            promotion_policy: nodex_core_contracts::library::LibraryPagePromotionPolicy::Literal,
        };
        let mut first = BoundModuleContext {
            editor_history_owner: None,
            profile_id: nodex_core_contracts::ProfileId("profile-1".to_owned()),
            library_id: nodex_core_contracts::LibraryId("library-1".to_owned()),
            project_id: Some(nodex_core_contracts::ProjectId("project-1".to_owned())),
            adapter: nodex_core_contracts::AdapterKind::ElectronHost,
            connection_id: "connection-1".to_owned(),
        };
        let expected = semantic_request_hash(&first, "epoch-1", &intent).unwrap();
        first.adapter = nodex_core_contracts::AdapterKind::Test;
        first.connection_id = "connection-2".to_owned();
        assert_eq!(
            semantic_request_hash(&first, "epoch-1", &intent).unwrap(),
            expected
        );
    }

    #[test]
    fn prepared_transfer_cas_rejects_changed_heads_locations_and_memberships() {
        let connection = Connection::open_in_memory().expect("in-memory connection");
        connection
            .execute_batch(
                "CREATE TABLE documents (
                    id TEXT PRIMARY KEY,
                    generation INTEGER NOT NULL,
                    head_seq INTEGER NOT NULL,
                    readiness TEXT NOT NULL
                );
                CREATE TABLE blocks (
                    id TEXT PRIMARY KEY,
                    placement_revision INTEGER NOT NULL,
                    lifecycle TEXT NOT NULL
                );
                CREATE TABLE data_source_page_memberships (
                    id TEXT PRIMARY KEY,
                    page_block_id TEXT NOT NULL,
                    revision INTEGER NOT NULL,
                    removed_at TEXT
                );
                INSERT INTO documents VALUES ('document:source', 2, 7, 'ready');
                INSERT INTO blocks VALUES ('page:source', 3, 'active');
                INSERT INTO data_source_page_memberships
                    VALUES ('membership:source', 'page:source', 5, NULL);",
            )
            .expect("CAS fixture");
        let read_set = PreparedTransferReadSet {
            documents: vec![LibraryBlockTransferDocumentHead {
                document_id: "document:source".to_owned(),
                generation: 2,
                expected_head_seq: 7,
            }],
            location_revisions: BTreeMap::from([("page:source".to_owned(), 3)]),
            source_memberships: BTreeMap::from([(
                "page:source".to_owned(),
                PreparedTransferMembership {
                    membership_id: "membership:source".to_owned(),
                    revision: 5,
                },
            )]),
        };

        revalidate_read_set(&connection, &read_set).expect("matching read set");
        connection
            .execute(
                "UPDATE documents SET head_seq = head_seq + 1 WHERE id = 'document:source'",
                [],
            )
            .expect("advance source head");
        let head_error = revalidate_read_set(&connection, &read_set).expect_err("stale head");
        assert_eq!(head_error.code, StoreErrorCode::RevisionConflict);
        connection
            .execute(
                "UPDATE documents SET head_seq = 7 WHERE id = 'document:source';",
                [],
            )
            .expect("restore source head");
        connection
            .execute(
                "UPDATE blocks SET placement_revision = 4 WHERE id = 'page:source'",
                [],
            )
            .expect("move source");
        let location_error =
            revalidate_read_set(&connection, &read_set).expect_err("stale location");
        assert_eq!(location_error.code, StoreErrorCode::RevisionConflict);
        connection
            .execute_batch(
                "UPDATE blocks SET placement_revision = 3 WHERE id = 'page:source';
                 UPDATE data_source_page_memberships
                    SET revision = 6 WHERE id = 'membership:source';",
            )
            .expect("advance membership");
        let membership_error =
            revalidate_read_set(&connection, &read_set).expect_err("stale membership");
        assert_eq!(membership_error.code, StoreErrorCode::RevisionConflict);
    }
}
