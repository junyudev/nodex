use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::path::Path;

#[cfg(test)]
use nodex_core_contracts::LIBRARY_CONTRACT_VERSION;
use nodex_core_contracts::library::{
    LibraryAccess, LibraryBlockPropertyMutationReceipt, LibraryBlockTransferDocumentCommit,
    LibraryBlockTransferResult, LibraryCanvasMutationResult, LibraryCommitValue, LibraryIntent,
    LibraryPageCopyResult, LibraryPageCreateResult, LibraryPageFileInvalidation,
    LibraryPageFileOwnershipMove, LibraryPageInsertion, LibraryPageLifecycleMutationReceipt,
    LibraryPageMentionDestination, LibraryPageMentionHost, LibraryProjectAccessChange,
    LibraryReceipt, LibraryResourceTarget, LibraryWriteParent,
};
use nodex_core_contracts::{
    AdapterKind, BoundModuleContext, ModuleApplyRequest, ModuleMutationReceipt, ModuleName,
    PageDocumentHeadImpact, ProjectionImpact, StoreEpoch,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::json;
use yrs::updates::encoder::Encode;
use yrs::{ReadTxn, Transact};

use crate::database::create_database_authority_records;
use crate::document::{
    BlockDocumentSchema, DocumentAuthorityRow, DocumentBlockOperation, DocumentBlockUpdatePatch,
    DocumentMaterialization, DocumentPlacementEvidence, PAGE_SCHEMA_KEY, PAGE_SCHEMA_VERSION,
    PersistYjsCommit, PersistYjsGenesis, YrsDocumentEngine, decode_block_document,
    materialize_decoded_document, mint_document_semantic_etags, parse_inline_markdown_title,
    persist_yjs_commit_with_local_commit, persist_yjs_genesis_with_local_commit,
    prepare_document_operation_update, prepare_page_yjs_genesis,
    prepare_page_yjs_genesis_with_content, read_document_authority, read_store_epoch,
    reconstruct_yjs_engine, sha256,
};
use crate::domain::block_materialization::MaterializedBlockNode;
use crate::domain::fractional_rank::{
    FractionalRankErrorCode, RankedItem, plan as plan_fractional_rank,
};
use crate::domain::identity::stable_uuid_v7;
use crate::domain::materialized_inline::{
    materialized_inline_from_rich_text, rich_text_from_materialized_inline,
};
use crate::domain::rich_text::{RichTextItem, RichTextStyles, canonicalize_rich_text};
use crate::infrastructure::durable_mutation::{
    self, CommitResult, DurableMutationScope, OperationIdentity, ReceiptMetadata, ReplayIdentity,
    SealedOutcome,
};
use crate::infrastructure::event_log::{
    NewChangeLogEntry, append_change_log, load_committed_event_by_sequence,
};
use crate::infrastructure::local_commit;
use crate::infrastructure::local_commit::CommitContext;
#[cfg(test)]
use crate::infrastructure::module_receipts::{NewModuleReceipt, insert_module_receipt};
use crate::infrastructure::projection_impact::expand_database_coordinates;
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode, with_immediate_transaction};
use crate::infrastructure::writer::StoreWriter;

use super::LibraryApplyOutcome;

const MODULE_NAME: &str = "library";
const MAX_ID_LENGTH: usize = 512;
const MAX_PAGE_TITLE_LENGTH: usize = 10_000;
const MAX_EXACT_PAGE_FILE_INVALIDATION_IDS: usize = 4_096;
const MAX_EXACT_PAGE_FILE_INVALIDATION_BYTES: usize = 128 * 1024;

pub(super) struct MutationEffects {
    pub(super) project_id: String,
    pub(super) operation_kind: &'static str,
    pub(super) change_kind: &'static str,
    pub(super) did_mutate: bool,
    pub(super) created_target: Option<LibraryResourceTarget>,
    pub(super) affected_parent_keys: Vec<String>,
    pub(super) affected_block_ids: Vec<String>,
    pub(super) affected_page_ids: Vec<String>,
    pub(super) affected_database_ids: Vec<String>,
    pub(super) affected_view_ids: Vec<String>,
    pub(super) affected_document_ids: Vec<String>,
    pub(super) committed_revisions: BTreeMap<String, i64>,
    pub(super) page_create: Option<LibraryPageCreateResult>,
    pub(super) page_copy: Option<LibraryPageCopyResult>,
    pub(super) page_files: Option<nodex_core_contracts::library::LibraryPageFileMutationReceipt>,
    pub(super) canvas_mutation: Option<LibraryCanvasMutationResult>,
    pub(super) block_transfer: Option<LibraryBlockTransferResult>,
    pub(super) block_transfer_undo:
        Option<nodex_core_contracts::library::LibraryBlockTransferUndoResult>,
    pub(super) page_relocation_undo:
        Option<nodex_core_contracts::library::LibraryPageRelocationUndoResult>,
    pub(super) structural_edit: Option<nodex_core_contracts::library::LibraryStructuralEditResult>,
    pub(super) page_lifecycle: Option<LibraryPageLifecycleMutationReceipt>,
    pub(super) block_property_mutation: Option<LibraryBlockPropertyMutationReceipt>,
    pub(super) agent_page_copy: Option<nodex_core_contracts::library::LibraryAgentPageCopyResult>,
    pub(super) agent_create_pages:
        Option<nodex_core_contracts::library::LibraryAgentCreatePagesResult>,
    pub(super) agent_move_pages: Option<nodex_core_contracts::library::LibraryAgentMovePagesResult>,
    pub(super) change_payload: Option<serde_json::Value>,
    pub(super) committed_at: String,
}

pub(super) struct ResolvedWriteParent {
    pub(super) parent_key: String,
    pub(super) page_id: Option<String>,
    /// Project whose command is responsible for the mutation. Content remains
    /// Library-owned even when it is inserted into a Page reached by a grant.
    pub(super) actor_project_id: String,
    /// A real Project actor that should receive an explicit grant when this
    /// command creates or moves a root resource. Trusted Library-wide commands
    /// do not mint a durable Project grant and therefore leave this coordinate
    /// empty.
    pub(super) creator_project_id: Option<String>,
    pub(super) document: Option<ResolvedParentDocument>,
    pub(super) before_block_id: Option<String>,
}

pub(super) struct LibraryMutationAuthority {
    /// Project actor/delivery coordinate for receipts and change events. It is
    /// derived for trusted Library commands and never owns physical content.
    pub(super) actor_project_id: String,
    pub(super) requesting_project_id: Option<String>,
}

pub(super) struct ResolvedParentDocument {
    pub(super) authority: DocumentAuthorityRow,
    pub(super) engine: YrsDocumentEngine,
    pub(super) base_materialization: DocumentMaterialization,
    pub(super) schema: BlockDocumentSchema,
}

/// Stable authority coordinates shared by every parent-Document write in one
/// Library mutation. Command-specific phase, operations, and placement remain
/// explicit at the persistence seam.
#[derive(Clone, Copy)]
pub(super) struct ParentDocumentWriteContext<'a> {
    pub(super) actor_project_id: &'a str,
    pub(super) store_epoch: &'a str,
    pub(super) operation_id: &'a str,
    pub(super) commit: &'a CommitContext,
}

pub(super) struct ResourceAuthority {
    pub(super) id: String,
    pub(super) resource_kind: &'static str,
    pub(super) lifecycle: String,
    pub(super) parent_kind: String,
    pub(super) parent_id: String,
    pub(super) containing_document_id: Option<String>,
    pub(super) placement_revision: i64,
    pub(super) block_metadata_revision: i64,
    pub(super) resource_metadata_revision: i64,
}

pub(super) fn apply(
    writer: &StoreWriter,
    profile_id: &str,
    library_id: &str,
    context: &BoundModuleContext,
    request: ModuleApplyRequest<LibraryIntent>,
    assets_root: &Path,
    prepared_transfer: Option<super::block_transfer::PreparedBlockTransfer>,
) -> Result<LibraryApplyOutcome, StoreError> {
    let profile_id = profile_id.to_owned();
    let library_id = library_id.to_owned();
    let context = context.clone();
    let assets_root = assets_root.to_path_buf();
    writer.call(move |connection| {
        with_immediate_transaction(connection, |transaction| {
            assert_identity(transaction, &profile_id, &library_id)?;
            let store_epoch = read_store_epoch(transaction)?;
            if request.store_epoch.0 != store_epoch {
                return Err(StoreError::new(
                    StoreErrorCode::StaleStoreEpoch,
                    "Library mutation targets a stale store epoch",
                    true,
                ));
            }
            let request_hash = match &request.intent {
                LibraryIntent::TransferBlocks { intent, .. } => {
                    super::block_transfer::semantic_request_hash(&context, &store_epoch, intent)?
                }
                LibraryIntent::ApplyBlockPropertyMutation { .. } => {
                    let fingerprint = serde_json::to_vec(&(
                        &context.profile_id,
                        &context.library_id,
                        &context.project_id,
                        request.contract_version,
                        &request.store_epoch,
                        &request.intent,
                    ))
                    .map_err(|_| internal("Library Property mutation cannot be fingerprinted"))?;
                    sha256(&fingerprint)
                }
                LibraryIntent::PersistAgentProjectResourceGrants { provenance, grants } => {
                    let grants = super::agent_authorization::canonicalize_grants(grants)?;
                    let fingerprint = serde_json::to_vec(&(
                        "nodex.agent.project-resource-grants.v1",
                        &context.profile_id,
                        &context.library_id,
                        &context.project_id,
                        request.contract_version,
                        &request.store_epoch,
                        provenance,
                        grants,
                    ))
                    .map_err(|_| internal("Agent Project grants cannot be fingerprinted"))?;
                    sha256(&fingerprint)
                }
                _ => {
                    let fingerprint = serde_json::to_vec(&(
                        &context.profile_id,
                        &context.library_id,
                        &context.project_id,
                        &context.adapter,
                        request.contract_version,
                        &request.store_epoch,
                        &request.intent,
                    ))
                    .map_err(|_| internal("Library mutation cannot be fingerprinted"))?;
                    sha256(&fingerprint)
                }
            };
            if let Some(replayed) = durable_mutation::replay_existing(
                transaction,
                ReplayIdentity {
                    module: ModuleName::Library,
                    module_name: MODULE_NAME,
                    operation_id: &request.operation_id,
                    intent_hash: &request_hash,
                    store_epoch: &store_epoch,
                },
            )? {
                return library_commit_result(transaction, replayed);
            }
            match &request.intent {
                LibraryIntent::CreatePage {
                    page_id,
                    document_id,
                    title,
                    parent,
                } => create_page(
                    transaction,
                    &context,
                    &store_epoch,
                    &library_id,
                    &request.operation_id,
                    &request_hash,
                    page_id,
                    document_id,
                    PageGenesisInput::PlainTitle(title),
                    parent,
                ),
                LibraryIntent::CreatePageMention {
                    page_id,
                    document_id,
                    title,
                    mention_host,
                    destination,
                } => create_page_mention(
                    transaction,
                    &context,
                    &store_epoch,
                    &library_id,
                    &request.operation_id,
                    &request_hash,
                    page_id,
                    document_id,
                    title,
                    mention_host,
                    destination,
                ),
                LibraryIntent::CreatePageFromNfm {
                    title_markdown,
                    nfm,
                    destination,
                } => {
                    let page_id = stable_uuid_v7(
                        &request.operation_id,
                        "page",
                        &format!("{library_id}:semantic"),
                    );
                    let document_id = stable_uuid_v7(
                        &request.operation_id,
                        "page_document",
                        &format!("{library_id}:semantic"),
                    );
                    super::page_write_semantic::create_page(
                        transaction,
                        &context,
                        &store_epoch,
                        &library_id,
                        &request.operation_id,
                        &request_hash,
                        &page_id,
                        &document_id,
                        title_markdown,
                        nfm,
                        destination,
                    )
                }
                LibraryIntent::ApplyPageFileChanges {
                    page_id,
                    expected_manifest_revision,
                    changes,
                    turn_id,
                } => super::page_files::apply(
                    transaction,
                    &context,
                    &store_epoch,
                    &library_id,
                    &request.operation_id,
                    &request_hash,
                    page_id,
                    *expected_manifest_revision,
                    changes,
                    turn_id.as_deref(),
                ),
                LibraryIntent::PutPageFile {
                    page_id,
                    file_id,
                    logical_path,
                    mime_type,
                    prepared_blob_receipt_id,
                    turn_id,
                } => super::page_files::put(
                    transaction,
                    &context,
                    &store_epoch,
                    &library_id,
                    &request.operation_id,
                    &request_hash,
                    page_id,
                    file_id,
                    logical_path,
                    mime_type,
                    prepared_blob_receipt_id,
                    turn_id.as_deref(),
                ),
                LibraryIntent::CreateDatabase {
                    database_id,
                    data_source_id,
                    view_id,
                    name,
                    parent,
                } => create_database(
                    transaction,
                    &context,
                    &store_epoch,
                    &library_id,
                    &request.operation_id,
                    &request_hash,
                    database_id,
                    data_source_id,
                    view_id,
                    name,
                    parent,
                ),
                LibraryIntent::CreateCanvas {
                    canvas_id,
                    document_id,
                    display_name,
                    destination,
                } => super::canvas_mutation::create(
                    transaction,
                    &context,
                    &store_epoch,
                    &library_id,
                    &request.operation_id,
                    &request_hash,
                    canvas_id,
                    document_id,
                    display_name,
                    destination,
                    &assets_root,
                ),
                LibraryIntent::RenameCanvas {
                    canvas_id,
                    display_name,
                    expected_metadata_revision,
                } => super::canvas_mutation::rename(
                    transaction,
                    &context,
                    &store_epoch,
                    &library_id,
                    &request.operation_id,
                    &request_hash,
                    canvas_id,
                    display_name,
                    *expected_metadata_revision,
                ),
                LibraryIntent::MoveCanvas {
                    canvas_id,
                    expected_location_revision,
                    destination,
                } => super::canvas_mutation::move_canvas(
                    transaction,
                    &context,
                    &store_epoch,
                    &library_id,
                    &request.operation_id,
                    &request_hash,
                    canvas_id,
                    *expected_location_revision,
                    destination,
                ),
                LibraryIntent::DuplicateCanvas {
                    source_canvas_id,
                    canvas_id,
                    document_id,
                    display_name,
                    expected_document_generation,
                    expected_document_head_seq,
                    destination,
                } => super::canvas_mutation::duplicate(
                    transaction,
                    &context,
                    &store_epoch,
                    &library_id,
                    &request.operation_id,
                    &request_hash,
                    source_canvas_id,
                    canvas_id,
                    document_id,
                    display_name.as_deref(),
                    *expected_document_generation,
                    *expected_document_head_seq,
                    destination,
                    &assets_root,
                ),
                LibraryIntent::DeleteCanvas {
                    canvas_id,
                    expected_location_revision,
                    expected_metadata_revision,
                    containing_document_head,
                } => super::canvas_mutation::delete(
                    transaction,
                    &context,
                    &store_epoch,
                    &library_id,
                    &request.operation_id,
                    &request_hash,
                    canvas_id,
                    *expected_location_revision,
                    *expected_metadata_revision,
                    containing_document_head.as_ref(),
                ),
                LibraryIntent::CopyPage {
                    source_page_id,
                    expected_location_revision,
                    expected_parent_revision,
                    expected_active_membership_revision,
                    expected_document_generation,
                    expected_document_head_seq,
                    destination,
                } => super::page_copy::copy_page(
                    transaction,
                    &context,
                    &store_epoch,
                    &library_id,
                    &request.operation_id,
                    &request_hash,
                    source_page_id,
                    *expected_location_revision,
                    *expected_parent_revision,
                    *expected_active_membership_revision,
                    *expected_document_generation,
                    *expected_document_head_seq,
                    destination,
                    &assets_root,
                ),
                LibraryIntent::DuplicatePage {
                    source_page_id,
                    destination,
                } => super::page_write_semantic::duplicate_page(
                    transaction,
                    &context,
                    &store_epoch,
                    &library_id,
                    &request.operation_id,
                    &request_hash,
                    source_page_id,
                    destination,
                    &assets_root,
                ),
                LibraryIntent::MovePage {
                    page_id,
                    destination,
                    expected_etag,
                } => super::page_write_semantic::move_page(
                    transaction,
                    &context,
                    &store_epoch,
                    &library_id,
                    &request.operation_id,
                    &request_hash,
                    page_id,
                    destination,
                    expected_etag,
                    &assets_root,
                ),
                LibraryIntent::DeletePage {
                    page_id,
                    expected_etag,
                } => super::page_lifecycle_mutation::delete_with_etag(
                    transaction,
                    &context,
                    &store_epoch,
                    &library_id,
                    &request.operation_id,
                    &request_hash,
                    page_id,
                    expected_etag,
                ),
                LibraryIntent::ArchiveResource {
                    target,
                    expected_metadata_revision,
                } => change_resource_lifecycle(
                    transaction,
                    &context,
                    &store_epoch,
                    &library_id,
                    &request.operation_id,
                    &request_hash,
                    target,
                    *expected_metadata_revision,
                    false,
                ),
                LibraryIntent::RestoreResource {
                    target,
                    expected_metadata_revision,
                } => change_resource_lifecycle(
                    transaction,
                    &context,
                    &store_epoch,
                    &library_id,
                    &request.operation_id,
                    &request_hash,
                    target,
                    *expected_metadata_revision,
                    true,
                ),
                LibraryIntent::ApplyPageLifecycle { mutation } => {
                    super::page_lifecycle_mutation::apply(
                        transaction,
                        &context,
                        &store_epoch,
                        &library_id,
                        &request.operation_id,
                        &request_hash,
                        mutation,
                    )
                }
                LibraryIntent::ApplyBlockPropertyMutation { mutation } => {
                    super::page_property_mutation::apply(
                        transaction,
                        &context,
                        &store_epoch,
                        &library_id,
                        &request.operation_id,
                        mutation,
                        super::page_property_mutation::PagePropertyApplySupplement {
                            core_request_hash: &request_hash,
                            database_receipt: None,
                            committed_at: None,
                        },
                    )
                }
                LibraryIntent::ApplyPageMetadataProperties {
                    database_intents,
                    intrinsic_mutation,
                } => {
                    validate_page_metadata_property_intents(
                        database_intents,
                        intrinsic_mutation,
                    )?;
                    let database_committed_at = sqlite_now(transaction)?;
                    let database_receipt = crate::database::apply_intents_as_collaborator(
                        transaction,
                        &library_id,
                        &context,
                        &request.operation_id,
                        database_intents,
                        &database_committed_at,
                    )?;
                    let outcome = super::page_property_mutation::apply(
                        transaction,
                        &context,
                        &store_epoch,
                        &library_id,
                        &request.operation_id,
                        intrinsic_mutation,
                        super::page_property_mutation::PagePropertyApplySupplement {
                            core_request_hash: &request_hash,
                            database_receipt: Some(&database_receipt),
                            committed_at: Some(&database_committed_at),
                        },
                    )?;
                    if let Some(receipt) = &outcome.committed.value.block_property_mutation
                        && let nodex_core_contracts::library::LibraryBlockPropertyMutationOutcome::Rejected { error } = &receipt.outcome
                    {
                        let code = match error.code {
                            nodex_core_contracts::library::LibraryBlockPropertyMutationErrorCode::MutationIdCollision => StoreErrorCode::IdempotencyKeyReused,
                            nodex_core_contracts::library::LibraryBlockPropertyMutationErrorCode::ProjectNotFound
                            | nodex_core_contracts::library::LibraryBlockPropertyMutationErrorCode::BlockNotFound
                            | nodex_core_contracts::library::LibraryBlockPropertyMutationErrorCode::PropertyNotFound => StoreErrorCode::NotFound,
                            nodex_core_contracts::library::LibraryBlockPropertyMutationErrorCode::PropertyConflict => StoreErrorCode::RevisionConflict,
                            nodex_core_contracts::library::LibraryBlockPropertyMutationErrorCode::PropertyValueCorrupt => StoreErrorCode::StoreCorrupt,
                            nodex_core_contracts::library::LibraryBlockPropertyMutationErrorCode::Unknown => StoreErrorCode::Internal,
                            _ => StoreErrorCode::InvalidInput,
                        };
                        return Err(StoreError::new(code, error.message.clone(), error.retryable));
                    }
                    Ok(outcome)
                }
                LibraryIntent::GrantProjectAccess {
                    project_id,
                    target,
                    access,
                } => grant_project_access(
                    transaction,
                    &context,
                    &store_epoch,
                    &library_id,
                    &request.operation_id,
                    &request_hash,
                    project_id,
                    target,
                    *access,
                ),
                LibraryIntent::SetProjectAccess { target, changes } => set_project_access(
                    transaction,
                    &context,
                    &store_epoch,
                    &library_id,
                    &request.operation_id,
                    &request_hash,
                    target,
                    changes,
                ),
                LibraryIntent::PersistAgentProjectResourceGrants { provenance, grants } => {
                    super::agent_authorization::persist_project_grants(
                        transaction,
                        &context,
                        &store_epoch,
                        &library_id,
                        &request.operation_id,
                        &request_hash,
                        provenance,
                        grants,
                    )
                }
                LibraryIntent::MoveBlock {
                    target,
                    expected_location_revision,
                    parent,
                } => move_block(
                    transaction,
                    &context,
                    &store_epoch,
                    &library_id,
                    &request.operation_id,
                    &request_hash,
                    target,
                    *expected_location_revision,
                    parent,
                ),
                LibraryIntent::TransferBlocks { intent } => super::block_transfer::apply(
                    transaction,
                    &context,
                    &library_id,
                    &request.operation_id,
                    &store_epoch,
                    &request_hash,
                    intent,
                    &assets_root,
                    prepared_transfer.ok_or_else(|| {
                        internal("Block transfer apply has no prepared artifact")
                    })?,
                ),
                LibraryIntent::UndoBlockTransfer { token } => super::block_transfer::undo(
                    transaction,
                    &context,
                    &library_id,
                    &request.operation_id,
                    &store_epoch,
                    &request_hash,
                    token,
                ),
                LibraryIntent::UndoPageRelocation { token } => {
                    super::block_transfer::undo_page_relocation(
                        transaction,
                        &context,
                        &library_id,
                        &request.operation_id,
                        &store_epoch,
                        &request_hash,
                        token,
                        &assets_root,
                    )
                }
                LibraryIntent::ApplyStructuralEdit { command } => super::structural_edit::apply(
                    transaction,
                    &context,
                    &library_id,
                    &request.operation_id,
                    &store_epoch,
                    &request_hash,
                    command,
                    &assets_root,
                ),
                LibraryIntent::ReverseStructuralEdit { token } => super::structural_edit::reverse(
                    transaction,
                    &context,
                    &library_id,
                    &request.operation_id,
                    &store_epoch,
                    &request_hash,
                    token,
                    &assets_root,
                ),
                LibraryIntent::ExecutePreparedAgentPageCopy { .. } => Err(invalid(
                    "Prepared Agent Page copy is assembled by the Library Module",
                )),
                LibraryIntent::ExecutePreparedAgentCreatePages { .. } => Err(invalid(
                    "Prepared Agent Page creation is assembled by the Library Module",
                )),
                LibraryIntent::ExecutePreparedAgentMovePages { .. } => Err(invalid(
                    "Prepared Agent Page movement is assembled by the Library Module",
                )),
            }
        })
    })
}

fn validate_page_metadata_property_intents(
    database_intents: &[nodex_core_contracts::database::DatabaseIntent],
    intrinsic_mutation: &nodex_core_contracts::library::LibraryBlockPropertyMutation,
) -> Result<(), StoreError> {
    let mut database_page_ids = BTreeSet::new();
    for intent in database_intents {
        let nodex_core_contracts::database::DatabaseIntent::EditPropertyValues { edits } = intent
        else {
            return Err(StoreError::new(
                StoreErrorCode::InvalidInput,
                "Page metadata orchestration only accepts Database property-value edits",
                false,
            ));
        };
        database_page_ids.extend(edits.iter().map(|edit| edit.address.page_id.clone()));
    }

    let intrinsic_page_ids = intrinsic_mutation
        .fields
        .iter()
        .map(|field| match field {
            nodex_core_contracts::library::LibraryBlockPropertyFieldMutation::IntrinsicSet {
                block_id,
                ..
            } => block_id.clone(),
        })
        .collect::<BTreeSet<_>>();
    if database_page_ids.is_empty() || database_page_ids != intrinsic_page_ids {
        return Err(StoreError::new(
            StoreErrorCode::InvalidInput,
            "Page metadata orchestration requires Database and intrinsic edits for the same non-empty Page set",
            false,
        ));
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn move_block(
    connection: &Connection,
    context: &BoundModuleContext,
    store_epoch: &str,
    library_id: &str,
    operation_id: &str,
    request_hash: &str,
    target: &LibraryResourceTarget,
    expected_location_revision: i64,
    parent: &LibraryWriteParent,
) -> Result<LibraryApplyOutcome, StoreError> {
    let authority = read_resource_authority(connection, library_id, target)?;
    if authority.lifecycle != "active" {
        return Err(StoreError::new(
            StoreErrorCode::NotFound,
            "Only an active Library resource can move",
            false,
        ));
    }
    if authority.placement_revision != expected_location_revision {
        return Err(StoreError::new(
            StoreErrorCode::RevisionConflict,
            "Library resource moved since this action began",
            true,
        ));
    }
    if authority.parent_kind == "data_source" {
        return Err(invalid(
            "A Data Source row Page must move through the Database Module",
        ));
    }
    let resolved_parent =
        resolve_write_parent_for_context(connection, context, library_id, parent)?;
    if authority.resource_kind == "page"
        && let Some(target_page_id) = &resolved_parent.page_id
    {
        let cycle = connection
            .query_row(
                "WITH RECURSIVE ancestors(page_id) AS (\
                   SELECT ?1 \
                   UNION ALL \
                   SELECT page.parent_id FROM pages page JOIN ancestors current \
                     ON page.block_id = current.page_id \
                   WHERE page.parent_kind = 'page'\
                 ) SELECT 1 FROM ancestors WHERE page_id = ?2 LIMIT 1",
                params![target_page_id, authority.id],
                |_| Ok(()),
            )
            .optional()?;
        if cycle.is_some() {
            return Err(invalid("A Page cannot move below itself"));
        }
    }
    let actor_project_id = resolved_parent.actor_project_id.clone();
    let source_parent_key = resource_parent_key(connection, &authority)?;
    let source_document_id = authority.containing_document_id.clone();
    let source_document = source_document_id
        .as_deref()
        .map(|document_id| load_parent_document(connection, document_id))
        .transpose()?;
    let source_parent_page_id =
        (authority.parent_kind == "page").then(|| authority.parent_id.clone());
    let target_document_id = resolved_parent
        .document
        .as_ref()
        .map(|target| target.authority.head.id.clone());
    let same_document = source_document_id.is_some() && source_document_id == target_document_id;
    let moved_block = source_document
        .as_ref()
        .and_then(|source| {
            find_materialized_block(&source.base_materialization.block_tree, &authority.id)
        })
        .unwrap_or_else(|| embedded_resource_block(&authority.id, authority.resource_kind));
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
            connection.execute(
                "DELETE FROM library_block_placements \
                 WHERE block_id = ?1 AND library_id = ?2",
                params![authority.id, library_id],
            )?;

            let parent_kind = if resolved_parent.page_id.is_some() {
                "page"
            } else {
                "library"
            };
            let parent_id = resolved_parent.page_id.as_deref().unwrap_or(library_id);
            if authority.resource_kind == "page" && target_document_id.is_some() {
                let changed = connection.execute(
                    "UPDATE pages SET parent_kind = ?1, parent_id = ?2, updated_at = ?3 \
                     WHERE block_id = ?4 AND library_id = ?5",
                    params![parent_kind, parent_id, now, authority.id, library_id],
                )?;
                if changed != 1 {
                    return Err(corrupt("Moved Page lost its typed parent authority"));
                }
            }

            let mut committed_document_heads = BTreeMap::new();
            let parent_write = ParentDocumentWriteContext {
                actor_project_id: &actor_project_id,
                store_epoch,
                operation_id,
                commit: scope.evidence(),
            };
            if same_document {
                let target_document = resolved_parent
                    .document
                    .as_ref()
                    .ok_or_else(|| corrupt("Same-Document move lost its target"))?;
                let head_seq = persist_parent_operations_detailed_with_local_commit(
                    connection,
                    parent_write,
                    "move",
                    target_document,
                    &[DocumentBlockOperation::MoveBlock {
                        block_id: authority.id.clone(),
                        parent_block_id: None,
                        before_block_id: resolved_parent.before_block_id.clone(),
                    }],
                    ParentDocumentPlacement::Derived {
                        attachment_advances: &[],
                    },
                )?
                .head_seq;
                committed_document_heads
                    .insert(target_document.authority.head.id.clone(), head_seq);
            } else {
                if let Some(source) = &source_document {
                    let head_seq = persist_parent_relocation_source_with_local_commit(
                        connection,
                        parent_write,
                        "source",
                        source,
                        &[DocumentBlockOperation::DeleteBlock {
                            block_id: authority.id.clone(),
                        }],
                        std::slice::from_ref(&authority.id),
                    )?
                    .head_seq;
                    committed_document_heads.insert(source.authority.head.id.clone(), head_seq);
                }
                if let Some(target_document) = &resolved_parent.document {
                    let head_seq = persist_parent_operations_detailed_with_local_commit(
                        connection,
                        parent_write,
                        "target",
                        target_document,
                        &[DocumentBlockOperation::InsertBlock {
                            block: moved_block,
                            parent_block_id: None,
                            before_block_id: resolved_parent.before_block_id.clone(),
                        }],
                        ParentDocumentPlacement::Derived {
                            attachment_advances: std::slice::from_ref(&authority.id),
                        },
                    )?
                    .head_seq;
                    committed_document_heads
                        .insert(target_document.authority.head.id.clone(), head_seq);
                }
            }

            let library_rank = if target_document_id.is_none() {
                if authority.resource_kind == "page" {
                    let changed = connection.execute(
                        "UPDATE pages SET parent_kind = 'library', parent_id = ?1, updated_at = ?2 \
                         WHERE block_id = ?3 AND library_id = ?1",
                        params![library_id, now, authority.id],
                    )?;
                    if changed != 1 {
                        return Err(corrupt("Moved Page lost its typed parent authority"));
                    }
                }
                let rank = insert_library_placement(
                    connection,
                    library_id,
                    &authority.id,
                    match parent {
                        LibraryWriteParent::Library { before } => before.as_ref(),
                        LibraryWriteParent::Page { .. } => None,
                    },
                    &now,
                )?;
                let changed = connection.execute(
                    "UPDATE blocks SET placement_revision = placement_revision + 1, updated_at = ?1 \
                     WHERE id = ?2 AND library_id = ?3 AND placement_revision = ?4",
                    params![now, authority.id, library_id, expected_location_revision],
                )?;
                if changed != 1 {
                    return Err(StoreError::new(
                        StoreErrorCode::RevisionConflict,
                        "Library resource changed during move",
                        true,
                    ));
                }
                if matches!(authority.resource_kind, "page" | "database")
                    && let Some(creator_project_id) = resolved_parent.creator_project_id.as_deref()
                {
                    insert_creator_resource_grant(
                        connection,
                        creator_project_id,
                        library_id,
                        authority.resource_kind,
                        &authority.id,
                        &now,
                    )?;
                }
                Some(rank)
            } else {
                None
            };

            if authority.resource_kind == "page" {
                let changed = connection.execute(
                    "UPDATE page_read_model SET parent_kind = ?1, parent_id = ?2, \
                       library_rank_key = ?3, placement_revision = ?4, updated_at = ?5 \
                     WHERE page_block_id = ?6 AND library_id = ?7",
                    params![
                        parent_kind,
                        parent_id,
                        library_rank,
                        expected_location_revision + 1,
                        now,
                        authority.id,
                        library_id,
                    ],
                )?;
                if changed != 1 {
                    return Err(corrupt("Moved Page lost its read projection"));
                }
            }

            let mut affected_page_ids = vec![];
            if authority.resource_kind == "page" {
                affected_page_ids.push(authority.id.clone());
            }
            affected_page_ids.extend(source_parent_page_id);
            affected_page_ids.extend(resolved_parent.page_id.clone());
            normalize_ids(&mut affected_page_ids);
            let mut affected_parent_keys = vec![source_parent_key, resolved_parent.parent_key];
            normalize_ids(&mut affected_parent_keys);
            let mut affected_document_ids =
                committed_document_heads.keys().cloned().collect::<Vec<_>>();
            normalize_ids(&mut affected_document_ids);
            let committed_revisions = BTreeMap::from_iter(
                [(
                    format!("blockLocation:{}", authority.id),
                    expected_location_revision + 1,
                )]
                .into_iter()
                .chain(
                    committed_document_heads
                        .into_iter()
                        .map(|(document_id, head_seq)| {
                            (format!("documentHead:{document_id}"), head_seq)
                        }),
                ),
            );
            seal_mutation(
                scope,
                context,
                operation_id,
                MutationEffects {
                    project_id: actor_project_id.clone(),
                    operation_kind: "move_block",
                    change_kind: "library.changed",
                    did_mutate: true,
                    created_target: None,
                    affected_parent_keys,
                    affected_block_ids: Vec::new(),
                    affected_page_ids,
                    affected_database_ids: (authority.resource_kind == "database")
                        .then(|| authority.id.clone())
                        .into_iter()
                        .collect(),
                    affected_view_ids: Vec::new(),
                    affected_document_ids,
                    committed_revisions,
                    page_create: None,
                    page_copy: None,
                    page_files: None,
                    canvas_mutation: None,
                    block_transfer: None,
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
            )
        },
    )?;
    library_commit_result(connection, commit_result)
}

#[allow(clippy::too_many_arguments)]
fn change_resource_lifecycle(
    connection: &Connection,
    context: &BoundModuleContext,
    store_epoch: &str,
    library_id: &str,
    operation_id: &str,
    request_hash: &str,
    target: &LibraryResourceTarget,
    expected_metadata_revision: i64,
    restore: bool,
) -> Result<LibraryApplyOutcome, StoreError> {
    let authority = read_resource_authority(connection, library_id, target)?;
    let (from, to, operation_kind) = if restore {
        ("archived", "active", "restore_resource")
    } else {
        ("active", "archived", "archive_resource")
    };
    if authority.lifecycle != from
        || authority.resource_metadata_revision != expected_metadata_revision
    {
        return Err(StoreError::new(
            StoreErrorCode::RevisionConflict,
            "Library resource lifecycle or metadata changed",
            true,
        ));
    }
    if authority.parent_kind == "data_source" {
        return Err(invalid(
            "A Data Source row Page must change lifecycle through the Database Module",
        ));
    }
    if authority.resource_kind == "canvas" {
        return Err(invalid(
            "Canvas lifecycle must change through a Canvas mutation",
        ));
    }
    if authority.resource_kind == "database" && !restore {
        let protected = connection
            .query_row(
                "SELECT 1 WHERE EXISTS (\
                   SELECT 1 FROM project_database_bindings \
                   WHERE database_block_id = ?1 AND lifecycle = 'active'\
                 ) OR EXISTS (\
                   SELECT 1 FROM projects \
                   WHERE database_block_id = ?1 AND lifecycle = 'active'\
                 )",
                [&authority.id],
                |_| Ok(()),
            )
            .optional()?;
        if protected.is_some() {
            return Err(StoreError::new(
                StoreErrorCode::Conflict,
                "An active primary Database cannot be archived",
                false,
            ));
        }
    }
    if authority.resource_kind == "page" && restore {
        let parent = connection.query_row(
            "SELECT parent_kind, parent_id FROM pages WHERE block_id = ?1",
            [&authority.id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )?;
        if parent.0 == "page" {
            let active = connection
                .query_row(
                    "SELECT 1 FROM pages page \
                     JOIN blocks block ON block.id = page.block_id \
                     WHERE page.block_id = ?1 AND page.library_id = ?2 \
                       AND block.library_id = page.library_id \
                       AND block.lifecycle = 'active'",
                    params![parent.1, library_id],
                    |_| Ok(()),
                )
                .optional()?;
            if active.is_none() {
                return Err(invalid(
                    "Restore the parent Page before restoring this Page",
                ));
            }
        }
    }
    let actor_project_id =
        resolve_library_mutation_authority(connection, context, library_id)?.actor_project_id;
    let now = sqlite_now(connection)?;
    let result = durable_mutation::run(
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
            let changed = connection.execute(
                "UPDATE blocks SET lifecycle = ?1, metadata_revision = metadata_revision + 1, \
           updated_at = ?2 WHERE id = ?3 AND lifecycle = ?4 AND metadata_revision = ?5",
                params![
                    to,
                    now,
                    authority.id,
                    from,
                    authority.block_metadata_revision
                ],
            )?;
            if changed != 1 {
                return Err(StoreError::new(
                    StoreErrorCode::RevisionConflict,
                    "Library resource changed during lifecycle transition",
                    true,
                ));
            }
            if authority.resource_kind == "page" {
                let changed = connection.execute(
                    "UPDATE page_read_model \
                     SET lifecycle = ?1, metadata_revision = ?2, updated_at = ?3 \
                     WHERE page_block_id = ?4 AND library_id = ?5",
                    params![
                        to,
                        authority.block_metadata_revision + 1,
                        now,
                        authority.id,
                        library_id,
                    ],
                )?;
                if changed != 1 {
                    return Err(corrupt("Page lifecycle read projection disappeared"));
                }
            } else {
                let changed = connection.execute(
                    "UPDATE database_containers SET lifecycle = ?1, \
               metadata_revision = metadata_revision + 1, updated_at = ?2 \
             WHERE block_id = ?3 AND lifecycle = ?4 AND metadata_revision = ?5",
                    params![
                        to,
                        now,
                        authority.id,
                        from,
                        authority.resource_metadata_revision
                    ],
                )?;
                if changed != 1 {
                    return Err(StoreError::new(
                        StoreErrorCode::RevisionConflict,
                        "Database changed during lifecycle transition",
                        true,
                    ));
                }
            }
            let parent_key = resource_parent_key(connection, &authority)?;
            let affected_document_ids = if authority.resource_kind == "page" {
                vec![connection.query_row(
                    "SELECT document_id FROM pages WHERE block_id = ?1",
                    [&authority.id],
                    |row| row.get::<_, String>(0),
                )?]
            } else {
                Vec::new()
            };
            seal_mutation(
                scope,
                context,
                operation_id,
                MutationEffects {
                    project_id: actor_project_id.clone(),
                    operation_kind,
                    change_kind: "library.changed",
                    did_mutate: true,
                    created_target: None,
                    affected_parent_keys: vec![parent_key],
                    affected_block_ids: Vec::new(),
                    affected_page_ids: (authority.resource_kind == "page")
                        .then(|| authority.id.clone())
                        .into_iter()
                        .collect(),
                    affected_database_ids: (authority.resource_kind == "database")
                        .then(|| authority.id.clone())
                        .into_iter()
                        .collect(),
                    affected_view_ids: Vec::new(),
                    affected_document_ids,
                    committed_revisions: BTreeMap::from_iter(
                        [(
                            format!("blockMetadata:{}", authority.id),
                            authority.block_metadata_revision + 1,
                        )]
                        .into_iter()
                        .chain(
                            (authority.resource_kind == "database").then(|| {
                                (
                                    format!("databaseMetadata:{}", authority.id),
                                    authority.resource_metadata_revision + 1,
                                )
                            }),
                        ),
                    ),
                    page_create: None,
                    page_copy: None,
                    page_files: None,
                    canvas_mutation: None,
                    block_transfer: None,
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
            )
        },
    )?;
    library_commit_result(connection, result)
}

#[allow(clippy::too_many_arguments)]
fn grant_project_access(
    connection: &Connection,
    context: &BoundModuleContext,
    store_epoch: &str,
    library_id: &str,
    operation_id: &str,
    request_hash: &str,
    project_id: &str,
    target: &LibraryResourceTarget,
    access: LibraryAccess,
) -> Result<LibraryApplyOutcome, StoreError> {
    let authority = read_resource_authority(connection, library_id, target)?;
    if authority.resource_kind == "canvas" {
        return Err(invalid(
            "Canvas access is inherited from its owning Page or Project",
        ));
    }
    let now = sqlite_now(connection)?;
    let result = durable_mutation::run(
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
            let mutation = mutate_direct_project_access(
                connection,
                library_id,
                &authority,
                project_id,
                Some(access),
                DirectGrantRevisionFence::Unchecked,
                PrimaryDatabaseAccessUpdate::Noop,
                &now,
            )?;
            seal_mutation(
                scope,
                context,
                operation_id,
                MutationEffects {
                    project_id: project_id.to_owned(),
                    operation_kind: "grant_project_access",
                    change_kind: "library.changed",
                    did_mutate: mutation.did_mutate,
                    created_target: None,
                    affected_parent_keys: Vec::new(),
                    affected_block_ids: Vec::new(),
                    affected_page_ids: (authority.resource_kind == "page")
                        .then(|| authority.id.clone())
                        .into_iter()
                        .collect(),
                    affected_database_ids: (authority.resource_kind == "database")
                        .then(|| authority.id.clone())
                        .into_iter()
                        .collect(),
                    affected_view_ids: Vec::new(),
                    affected_document_ids: Vec::new(),
                    committed_revisions: mutation
                        .revision
                        .map(|revision| (format!("projectGrant:{project_id}"), revision))
                        .into_iter()
                        .collect(),
                    page_create: None,
                    page_copy: None,
                    page_files: None,
                    canvas_mutation: None,
                    block_transfer: None,
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
            )
        },
    )?;
    library_commit_result(connection, result)
}

#[allow(clippy::too_many_arguments)]
fn set_project_access(
    connection: &Connection,
    context: &BoundModuleContext,
    store_epoch: &str,
    library_id: &str,
    operation_id: &str,
    request_hash: &str,
    target: &LibraryResourceTarget,
    changes: &[LibraryProjectAccessChange],
) -> Result<LibraryApplyOutcome, StoreError> {
    super::require_trusted_library_authority(context)?;
    const MAX_PROJECT_ACCESS_CHANGES: usize = 100_000;
    if changes.is_empty() || changes.len() > MAX_PROJECT_ACCESS_CHANGES {
        return Err(invalid(
            "Project access changes must contain 1 to 100000 Projects",
        ));
    }
    let authority = read_resource_authority(connection, library_id, target)?;
    if authority.resource_kind == "canvas" {
        return Err(invalid(
            "Canvas access is inherited from its owning Page or Project",
        ));
    }
    let mut project_ids = HashSet::with_capacity(changes.len());
    if changes
        .iter()
        .any(|change| !project_ids.insert(change.project_id.as_str()))
    {
        return Err(invalid(
            "Project access changes must contain unique Projects",
        ));
    }
    let actor_project_id =
        resolve_library_mutation_authority(connection, context, library_id)?.actor_project_id;

    let now = sqlite_now(connection)?;
    let result = durable_mutation::run(
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
            let mut did_mutate = false;
            let mut committed_revisions = BTreeMap::new();
            for change in changes {
                let mutation = mutate_direct_project_access(
                    connection,
                    library_id,
                    &authority,
                    &change.project_id,
                    change.access,
                    DirectGrantRevisionFence::Exact(change.expected_revision),
                    PrimaryDatabaseAccessUpdate::Reject,
                    &now,
                )?;
                did_mutate |= mutation.did_mutate;
                if let Some(revision) = mutation.revision {
                    committed_revisions
                        .insert(format!("projectGrant:{}", change.project_id), revision);
                }
            }

            seal_mutation(
                scope,
                context,
                operation_id,
                MutationEffects {
                    project_id: actor_project_id.clone(),
                    operation_kind: "set_project_access",
                    change_kind: "library.changed",
                    did_mutate,
                    created_target: None,
                    affected_parent_keys: Vec::new(),
                    affected_block_ids: Vec::new(),
                    affected_page_ids: (authority.resource_kind == "page")
                        .then(|| authority.id.clone())
                        .into_iter()
                        .collect(),
                    affected_database_ids: (authority.resource_kind == "database")
                        .then(|| authority.id.clone())
                        .into_iter()
                        .collect(),
                    affected_view_ids: Vec::new(),
                    affected_document_ids: Vec::new(),
                    committed_revisions,
                    page_create: None,
                    page_copy: None,
                    page_files: None,
                    canvas_mutation: None,
                    block_transfer: None,
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
            )
        },
    )?;
    library_commit_result(connection, result)
}

#[derive(Clone, Copy)]
enum DirectGrantRevisionFence {
    Unchecked,
    Exact(Option<i64>),
}

#[derive(Clone, Copy)]
enum PrimaryDatabaseAccessUpdate {
    Noop,
    Reject,
}

struct DirectGrantMutation {
    did_mutate: bool,
    revision: Option<i64>,
}

#[allow(clippy::too_many_arguments)]
fn mutate_direct_project_access(
    connection: &Connection,
    library_id: &str,
    authority: &ResourceAuthority,
    project_id: &str,
    access: Option<LibraryAccess>,
    revision_fence: DirectGrantRevisionFence,
    primary_database_update: PrimaryDatabaseAccessUpdate,
    now: &str,
) -> Result<DirectGrantMutation, StoreError> {
    validate_id("project_id", project_id)?;
    if let DirectGrantRevisionFence::Exact(Some(revision)) = revision_fence
        && revision < 1
    {
        return Err(invalid("Project grant revision must be positive"));
    }
    if authority.resource_kind == "canvas" && authority.containing_document_id.is_some() {
        return Err(invalid(
            "Embedded Canvas access is inherited from its owning Page",
        ));
    }
    let project = connection
        .query_row(
            "SELECT project.lifecycle, COALESCE(project.database_block_id, ( \
               SELECT binding.database_block_id FROM project_database_bindings binding \
               WHERE binding.project_id = project.id AND binding.library_id = project.library_id \
                 AND binding.lifecycle = 'active' \
             )) \
             FROM projects project WHERE project.id = ?1 AND project.library_id = ?2",
            params![project_id, library_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
        )
        .optional()?;
    let Some((project_lifecycle, primary_database_id)) = project else {
        return Err(StoreError::new(
            StoreErrorCode::NotFound,
            "Project is unavailable in this Library",
            false,
        ));
    };
    let existing = connection
        .query_row(
            "SELECT id, access, lifecycle, revision FROM project_resource_grants \
             WHERE project_id = ?1 AND root_kind = ?2 AND root_id = ?3",
            params![project_id, authority.resource_kind, authority.id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            },
        )
        .optional()?;
    let active_revision = existing
        .as_ref()
        .and_then(|(_, _, lifecycle, revision)| (lifecycle == "active").then_some(*revision));
    if let DirectGrantRevisionFence::Exact(expected_revision) = revision_fence
        && active_revision != expected_revision
    {
        return Err(StoreError::new(
            StoreErrorCode::RevisionConflict,
            "Project access changed while the dialog was open",
            true,
        ));
    }

    if access.is_some() && project_lifecycle != "active" {
        return Err(StoreError::new(
            StoreErrorCode::Unauthorized,
            "Inactive or archived Projects can only have direct access removed",
            false,
        ));
    }
    let primary_access = authority.resource_kind == "database"
        && primary_database_id.as_deref() == Some(authority.id.as_str());
    if primary_access && access.is_some() {
        return match primary_database_update {
            PrimaryDatabaseAccessUpdate::Noop => Ok(DirectGrantMutation {
                did_mutate: false,
                revision: None,
            }),
            PrimaryDatabaseAccessUpdate::Reject => Err(invalid(
                "A Project's primary Database access is managed by its binding",
            )),
        };
    }

    if let Some(access) = access {
        let access = access_literal(access);
        if let Some((grant_id, current_access, lifecycle, revision)) = existing {
            if lifecycle == "active" && current_access == access {
                return Ok(DirectGrantMutation {
                    did_mutate: false,
                    revision: Some(revision),
                });
            }
            let changed = connection.execute(
                "UPDATE project_resource_grants SET access = ?1, lifecycle = 'active', \
                   revision = revision + 1, updated_at = ?2 \
                 WHERE id = ?3 AND revision = ?4",
                params![access, now, grant_id, revision],
            )?;
            if changed != 1 {
                return Err(revision_conflict());
            }
            return Ok(DirectGrantMutation {
                did_mutate: true,
                revision: Some(revision + 1),
            });
        }
        let grant_id = format!(
            "grant:{}",
            sha256(
                serde_json::to_string(&[
                    project_id,
                    authority.resource_kind,
                    authority.id.as_str()
                ])
                .map_err(|_| internal("Project grant identity"))?
                .as_bytes(),
            ),
        );
        connection.execute(
            "INSERT INTO project_resource_grants(\
               id, project_id, library_id, root_kind, root_id, access, recursive, revision, \
               lifecycle, created_at, updated_at\
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, 1, 'active', ?7, ?7)",
            params![
                grant_id,
                project_id,
                library_id,
                authority.resource_kind,
                authority.id,
                access,
                now,
            ],
        )?;
        return Ok(DirectGrantMutation {
            did_mutate: true,
            revision: Some(1),
        });
    }

    let Some((grant_id, _, lifecycle, revision)) = existing else {
        return Ok(DirectGrantMutation {
            did_mutate: false,
            revision: None,
        });
    };
    if lifecycle != "active" {
        return Ok(DirectGrantMutation {
            did_mutate: false,
            revision: None,
        });
    }
    let changed = connection.execute(
        "UPDATE project_resource_grants SET lifecycle = 'revoked', \
           revision = revision + 1, updated_at = ?1 WHERE id = ?2 AND revision = ?3",
        params![now, grant_id, revision],
    )?;
    if changed != 1 {
        return Err(revision_conflict());
    }
    Ok(DirectGrantMutation {
        did_mutate: true,
        revision: Some(revision + 1),
    })
}

fn access_literal(access: LibraryAccess) -> &'static str {
    match access {
        LibraryAccess::Read => "read",
        LibraryAccess::ReadWrite => "read_write",
    }
}

fn revision_conflict() -> StoreError {
    StoreError::new(
        StoreErrorCode::RevisionConflict,
        "Project access changed during update",
        true,
    )
}

pub(super) fn read_resource_authority(
    connection: &Connection,
    library_id: &str,
    target: &LibraryResourceTarget,
) -> Result<ResourceAuthority, StoreError> {
    let (id, resource_kind) = match target {
        LibraryResourceTarget::Page { page_id } => (page_id, "page"),
        LibraryResourceTarget::Database { database_id } => (database_id, "database"),
        LibraryResourceTarget::Canvas { canvas_id } => (canvas_id, "canvas"),
    };
    let row = connection
        .query_row(
            "SELECT block.lifecycle, \
               COALESCE(page.parent_kind, CASE \
                 WHEN placement.block_id IS NOT NULL THEN 'library' \
                 WHEN block_index.block_id IS NOT NULL THEN 'page' END), \
               COALESCE(page.parent_id, CASE \
                 WHEN placement.block_id IS NOT NULL THEN block.library_id \
                 ELSE host_page.block_id END), \
               block_index.document_id, block.placement_revision, block.metadata_revision, \
               CASE WHEN block.type = 'database' THEN container.metadata_revision \
                    ELSE block.metadata_revision END \
             FROM blocks block \
             LEFT JOIN pages page ON page.block_id = block.id \
             LEFT JOIN database_containers container ON container.block_id = block.id \
             LEFT JOIN canvas_owners canvas ON canvas.block_id = block.id \
             LEFT JOIN library_block_placements placement ON placement.block_id = block.id \
             LEFT JOIN document_block_index block_index ON block_index.block_id = block.id \
             LEFT JOIN block_documents host_document \
               ON host_document.document_id = block_index.document_id \
             LEFT JOIN pages host_page ON host_page.block_id = host_document.block_id \
             WHERE block.id = ?1 AND block.type = ?2 \
               AND block.library_id = ?3 \
               AND COALESCE(page.library_id, container.library_id, canvas.library_id) = ?3",
            params![id, resource_kind, library_id],
            |row| {
                Ok(ResourceAuthority {
                    id: id.clone(),
                    resource_kind,
                    lifecycle: row.get(0)?,
                    parent_kind: row.get(1)?,
                    parent_id: row.get(2)?,
                    containing_document_id: row.get(3)?,
                    placement_revision: row.get(4)?,
                    block_metadata_revision: row.get(5)?,
                    resource_metadata_revision: row.get(6)?,
                })
            },
        )
        .optional()?;
    row.ok_or_else(|| {
        StoreError::new(
            StoreErrorCode::NotFound,
            "Library resource is unavailable",
            false,
        )
    })
}

fn resource_parent_key(
    _connection: &Connection,
    authority: &ResourceAuthority,
) -> Result<String, StoreError> {
    match authority.parent_kind.as_str() {
        "library" => Ok("library".to_owned()),
        "page" => Ok(format!("page:{}", authority.parent_id)),
        "data_source" => Ok(format!("dataSource:{}", authority.parent_id)),
        _ => Err(corrupt("Library resource has an invalid typed parent")),
    }
}

pub(super) fn resolve_write_parent(
    connection: &Connection,
    library_id: &str,
    requesting_project_id: &str,
    parent: &LibraryWriteParent,
) -> Result<ResolvedWriteParent, StoreError> {
    resolve_write_parent_with_access(
        connection,
        library_id,
        requesting_project_id,
        parent,
        true,
        true,
    )
}

pub(super) fn resolve_write_parent_for_context(
    connection: &Connection,
    context: &BoundModuleContext,
    library_id: &str,
    parent: &LibraryWriteParent,
) -> Result<ResolvedWriteParent, StoreError> {
    let authority = resolve_library_mutation_authority(connection, context, library_id)?;
    let Some(requesting_project_id) = authority.requesting_project_id.as_deref() else {
        return resolve_write_parent_with_access(
            connection,
            library_id,
            &authority.actor_project_id,
            parent,
            false,
            false,
        );
    };
    resolve_write_parent(connection, library_id, requesting_project_id, parent)
}

pub(super) fn resolve_write_parent_prevalidated(
    connection: &Connection,
    library_id: &str,
    requesting_project_id: &str,
    parent: &LibraryWriteParent,
) -> Result<ResolvedWriteParent, StoreError> {
    resolve_write_parent_with_access(
        connection,
        library_id,
        requesting_project_id,
        parent,
        false,
        true,
    )
}

fn resolve_write_parent_with_access(
    connection: &Connection,
    library_id: &str,
    requesting_project_id: &str,
    parent: &LibraryWriteParent,
    require_access: bool,
    grant_creator_access: bool,
) -> Result<ResolvedWriteParent, StoreError> {
    let LibraryWriteParent::Page {
        page_id,
        expected_document_generation,
        expected_document_head_seq,
        before,
        insertion,
    } = parent
    else {
        let LibraryWriteParent::Library { before } = parent else {
            unreachable!("closed LibraryWriteParent")
        };
        if let Some(anchor) = before {
            validate_library_anchor(connection, library_id, anchor)?;
        }
        if require_access {
            require_project_in_library(connection, requesting_project_id, library_id)?;
        }
        return Ok(ResolvedWriteParent {
            parent_key: "library".to_owned(),
            page_id: None,
            actor_project_id: requesting_project_id.to_owned(),
            creator_project_id: grant_creator_access.then(|| requesting_project_id.to_owned()),
            document: None,
            before_block_id: before.as_ref().map(|anchor| anchor.block_id.clone()),
        });
    };
    if before.is_some() && insertion.is_some() {
        return Err(invalid(
            "Page parent cannot combine a placement anchor with an insertion intent",
        ));
    }
    let parent_row = connection
        .query_row(
            "SELECT page.document_id, block.lifecycle \
             FROM pages page JOIN blocks block ON block.id = page.block_id \
             WHERE page.block_id = ?1 AND page.library_id = ?2 \
               AND block.library_id = page.library_id",
            params![page_id, library_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?;
    let Some((document_id, lifecycle)) = parent_row else {
        return Err(StoreError::new(
            StoreErrorCode::NotFound,
            "Target Page is not in this Library",
            false,
        ));
    };
    if lifecycle != "active" {
        return Err(invalid("Target Page is unavailable"));
    }
    if require_access {
        super::history::require_page_write_access(
            connection,
            library_id,
            requesting_project_id,
            page_id,
        )?;
    }
    let authority = read_document_authority(connection, &document_id)?
        .ok_or_else(|| corrupt("Target Page has no Document authority"))?;
    if authority.owner_block_id != *page_id
        || authority.owner_type != "page"
        || !authority.head.is_live_yjs_authority()
    {
        return Err(corrupt("Target Page Document authority is invalid"));
    }
    if authority.head.generation != *expected_document_generation
        || authority.head.head_seq != *expected_document_head_seq
    {
        return Err(StoreError::new(
            StoreErrorCode::HeadConflict,
            "Target Page content changed",
            true,
        ));
    }
    let schema = BlockDocumentSchema::from_identity(
        &authority.head.schema_key,
        authority.head.schema_version,
    )
    .filter(|schema| schema.has_title())
    .ok_or_else(|| corrupt("Target Page has an unsupported Document schema"))?;
    let engine = reconstruct_yjs_engine(connection, &authority.head)?;
    let decoded = decode_block_document(engine.document(), schema)
        .map_err(|error| corrupt(&format!("Target Page schema is invalid: {error}")))?;
    let base_materialization = materialize_decoded_document(&decoded)
        .map_err(|error| corrupt(&format!("Target Page cannot materialize: {error}")))?;
    let before_block_id = if let Some(anchor) = before {
        let actual = connection
            .query_row(
                "SELECT block.placement_revision FROM document_block_index indexed_block \
                 JOIN blocks block ON block.id = indexed_block.block_id \
                 WHERE indexed_block.document_id = ?1 AND indexed_block.block_id = ?2 \
                   AND indexed_block.parent_block_id IS NULL AND block.lifecycle = 'active'",
                params![document_id, anchor.block_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()?;
        let Some(actual) = actual else {
            return Err(invalid(
                "Placement anchor is unavailable in the target Page",
            ));
        };
        if actual != anchor.expected_location_revision {
            return Err(StoreError::new(
                StoreErrorCode::RevisionConflict,
                "Placement anchor changed",
                true,
            ));
        }
        Some(anchor.block_id.clone())
    } else {
        None
    };
    Ok(ResolvedWriteParent {
        parent_key: format!("page:{page_id}"),
        page_id: Some(page_id.clone()),
        actor_project_id: requesting_project_id.to_owned(),
        creator_project_id: grant_creator_access.then(|| requesting_project_id.to_owned()),
        document: Some(ResolvedParentDocument {
            authority,
            engine,
            base_materialization,
            schema,
        }),
        before_block_id,
    })
}

pub(super) fn load_parent_document(
    connection: &Connection,
    document_id: &str,
) -> Result<ResolvedParentDocument, StoreError> {
    let authority = read_document_authority(connection, document_id)?
        .ok_or_else(|| corrupt("Source Page has no Document authority"))?;
    if authority.owner_type != "page" || !authority.head.is_live_yjs_authority() {
        return Err(corrupt("Source Page Document authority is invalid"));
    }
    let schema = BlockDocumentSchema::from_identity(
        &authority.head.schema_key,
        authority.head.schema_version,
    )
    .filter(|schema| schema.has_title())
    .ok_or_else(|| corrupt("Source Page has an unsupported Document schema"))?;
    let engine = reconstruct_yjs_engine(connection, &authority.head)?;
    let decoded = decode_block_document(engine.document(), schema)
        .map_err(|error| corrupt(&format!("Source Page schema is invalid: {error}")))?;
    let base_materialization = materialize_decoded_document(&decoded)
        .map_err(|error| corrupt(&format!("Source Page cannot materialize: {error}")))?;
    Ok(ResolvedParentDocument {
        authority,
        engine,
        base_materialization,
        schema,
    })
}

pub(super) fn find_materialized_block(
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

fn normalize_ids(ids: &mut Vec<String>) {
    ids.sort();
    ids.dedup();
}

pub(super) fn persist_parent_insert(
    connection: &Connection,
    write: ParentDocumentWriteContext<'_>,
    parent: &ResolvedParentDocument,
    block: MaterializedBlockNode,
    before_block_id: Option<String>,
) -> Result<LibraryBlockTransferDocumentCommit, StoreError> {
    let placement_genesis_block_ids = vec![block.id.clone()];
    persist_parent_operations_detailed_with_local_commit(
        connection,
        write,
        "insert",
        parent,
        &[DocumentBlockOperation::InsertBlock {
            block,
            parent_block_id: None,
            before_block_id,
        }],
        ParentDocumentPlacement::Genesis(&placement_genesis_block_ids),
    )
}

pub(super) fn persist_parent_insert_with_insertion(
    connection: &Connection,
    write: ParentDocumentWriteContext<'_>,
    parent: &ResolvedParentDocument,
    insertion: &LibraryPageInsertion,
    block: MaterializedBlockNode,
) -> Result<LibraryBlockTransferDocumentCommit, StoreError> {
    let placement_genesis_block_ids = vec![block.id.clone()];
    let operations =
        super::canvas_mutation::page_shell_insertion_operations(parent, insertion, block)?;
    persist_parent_operations_detailed_with_local_commit(
        connection,
        write,
        "insert",
        parent,
        &operations,
        ParentDocumentPlacement::Genesis(&placement_genesis_block_ids),
    )
}

#[cfg(test)]
fn persist_parent_operations(
    connection: &Connection,
    write: ParentDocumentWriteContext<'_>,
    phase: &str,
    parent: &ResolvedParentDocument,
    operations: &[DocumentBlockOperation],
) -> Result<i64, StoreError> {
    persist_parent_operations_detailed(
        connection,
        write,
        phase,
        parent,
        operations,
        ParentDocumentPlacement::Derived {
            attachment_advances: &[],
        },
        StructuralDetachPolicy::Reject,
    )
    .map(|commit| commit.head_seq)
}

pub(super) fn persist_parent_operations_detailed_with_local_commit(
    connection: &Connection,
    write: ParentDocumentWriteContext<'_>,
    phase: &str,
    parent: &ResolvedParentDocument,
    operations: &[DocumentBlockOperation],
    placement: ParentDocumentPlacement<'_>,
) -> Result<LibraryBlockTransferDocumentCommit, StoreError> {
    persist_parent_operations_detailed(
        connection,
        write,
        phase,
        parent,
        operations,
        placement,
        StructuralDetachPolicy::Reject,
    )
}

/// Persists the source half of a cross-authority relocation. The caller must
/// commit the matching destination placement in the same LocalCommit.
pub(super) fn persist_parent_relocation_source_with_local_commit(
    connection: &Connection,
    write: ParentDocumentWriteContext<'_>,
    phase: &str,
    parent: &ResolvedParentDocument,
    operations: &[DocumentBlockOperation],
    relocated_block_ids: &[String],
) -> Result<LibraryBlockTransferDocumentCommit, StoreError> {
    persist_parent_operations_detailed(
        connection,
        write,
        phase,
        parent,
        operations,
        ParentDocumentPlacement::Derived {
            attachment_advances: &[],
        },
        StructuralDetachPolicy::Explicit(relocated_block_ids),
    )
}

/// Persists a structural relocation source and, when the move empties the
/// source Page, creates the editor-owned empty paragraph in the same Document
/// commit. Typed owner detaches remain explicit; a newly materialized ordinary
/// placeholder is registered by normal Document persistence and therefore is
/// not placement genesis (that evidence is reserved for pre-registered typed
/// shells).
pub(super) fn persist_parent_relocation_source_with_placeholder(
    connection: &Connection,
    write: ParentDocumentWriteContext<'_>,
    phase: &str,
    parent: &ResolvedParentDocument,
    operations: &[DocumentBlockOperation],
    relocated_block_ids: &[String],
) -> Result<LibraryBlockTransferDocumentCommit, StoreError> {
    persist_parent_operations_detailed(
        connection,
        write,
        phase,
        parent,
        operations,
        ParentDocumentPlacement::Derived {
            attachment_advances: &[],
        },
        StructuralDetachPolicy::Explicit(relocated_block_ids),
    )
}

/// Declares which aggregate owns placement revision changes while a typed
/// resource shell is reconciled into a parent Document.
#[derive(Clone, Copy)]
pub(super) enum ParentDocumentPlacement<'a> {
    Derived {
        attachment_advances: &'a [String],
    },
    Genesis(&'a [String]),
    Preapplied(&'a [String]),
    Restore {
        preapplied: &'a [String],
        tombstone_reactivations: &'a [String],
        source_document_id: &'a str,
        source_document_generation: i64,
    },
}

#[derive(Clone, Copy)]
enum StructuralDetachPolicy<'a> {
    Reject,
    Explicit(&'a [String]),
}

fn persist_parent_operations_detailed(
    connection: &Connection,
    write: ParentDocumentWriteContext<'_>,
    phase: &str,
    parent: &ResolvedParentDocument,
    operations: &[DocumentBlockOperation],
    placement: ParentDocumentPlacement<'_>,
    structural_detach_policy: StructuralDetachPolicy<'_>,
) -> Result<LibraryBlockTransferDocumentCommit, StoreError> {
    let full_state = parent.engine.full_state_v1();
    let prepared = prepare_document_operation_update(
        &parent.authority.head.id,
        parent.schema,
        &full_state,
        &parent.authority.head.state_vector,
        operations,
        false,
    )
    .map_err(|error| invalid(&format!("Parent Page update is invalid: {error}")))?;
    let candidate = parent
        .engine
        .prepare_update_v1(&prepared.update_v1)
        .map_err(|error| invalid(&format!("Parent Page update cannot apply: {error}")))?;
    let transaction = candidate.document().transact();
    let state_vector = transaction.state_vector().encode_v1();
    drop(transaction);
    if state_vector != prepared.state_vector_v1 {
        return Err(corrupt("Prepared parent state vector is inconsistent"));
    }
    let update_id = format!(
        "library-document-{phase}:{}",
        sha256(write.operation_id.as_bytes())
    );
    let structurally_detached_block_ids = match structural_detach_policy {
        StructuralDetachPolicy::Reject => Vec::new(),
        StructuralDetachPolicy::Explicit(block_ids) => block_ids.to_vec(),
    };
    let (
        placement_genesis_block_ids,
        placement_preapplied_block_ids,
        placement_advance_block_ids,
        tombstone_reactivation,
    ) = match placement {
        ParentDocumentPlacement::Derived {
            attachment_advances,
        } => (&[][..], &[][..], attachment_advances, None),
        ParentDocumentPlacement::Genesis(block_ids) => (block_ids, &[][..], &[][..], None),
        ParentDocumentPlacement::Preapplied(block_ids) => (&[][..], block_ids, &[][..], None),
        ParentDocumentPlacement::Restore {
            preapplied,
            tombstone_reactivations,
            source_document_id,
            source_document_generation,
        } => (
            &[][..],
            preapplied,
            &[][..],
            Some((
                tombstone_reactivations,
                source_document_id,
                source_document_generation,
            )),
        ),
    };
    let exact_moved_block_ids = operations
        .iter()
        .flat_map(|operation| {
            let block_ids: &[String] = match operation {
                DocumentBlockOperation::MoveBlock { block_id, .. } => {
                    std::slice::from_ref(block_id)
                }
                DocumentBlockOperation::MergeBlockBackward {
                    promoted_child_ids, ..
                }
                | DocumentBlockOperation::RestoreBackwardMerge {
                    promoted_child_ids, ..
                } => promoted_child_ids,
                _ => &[],
            };
            block_ids.iter().cloned()
        })
        .collect::<Vec<_>>();
    let persisted = persist_yjs_commit_with_local_commit(
        connection,
        PersistYjsCommit {
            authority: &parent.authority,
            actor_project_id: write.actor_project_id,
            base_materialization: &parent.base_materialization,
            materialization: &prepared.materialization,
            update_id: &update_id,
            client_session_id: "library-module",
            base_head_seq: parent.authority.head.head_seq,
            client_touched_block_ids: &[],
            update: &prepared.update_v1,
            state_vector: &state_vector,
            store_epoch: write.store_epoch,
            operation_id: &update_id,
            local_commit_id: Some(write.operation_id),
            event_kind: "document_updated",
            write_fence_block_ids: &prepared.write_fence_block_ids,
            title_write_fence_required: prepared.title_write_fence_required,
            document_write_fence_required: false,
            placement: {
                let evidence = DocumentPlacementEvidence::STRUCTURAL
                    .with_structural_detaches(&structurally_detached_block_ids)
                    .with_genesis(placement_genesis_block_ids)
                    .with_preapplied(placement_preapplied_block_ids)
                    .with_advances(placement_advance_block_ids)
                    .with_exact_moves(&exact_moved_block_ids);
                tombstone_reactivation.map_or(
                    evidence,
                    |(block_ids, source_document_id, source_document_generation)| {
                        evidence.with_tombstone_reactivation(
                            block_ids,
                            source_document_id,
                            source_document_generation,
                        )
                    },
                )
            },
        },
        write.commit,
    )?;
    Ok(LibraryBlockTransferDocumentCommit {
        document_id: parent.authority.head.id.clone(),
        generation: parent.authority.head.generation,
        base_head_seq: parent.authority.head.head_seq,
        head_seq: persisted.head_seq,
        update_id,
        update: prepared.update_v1,
        state_vector: persisted.state_vector,
    })
}

#[allow(clippy::too_many_arguments)]
fn create_database(
    connection: &Connection,
    context: &BoundModuleContext,
    store_epoch: &str,
    library_id: &str,
    operation_id: &str,
    request_hash: &str,
    database_id: &str,
    data_source_id: &str,
    view_id: &str,
    name: &str,
    parent: &LibraryWriteParent,
) -> Result<LibraryApplyOutcome, StoreError> {
    validate_uuid_v7("database_id", database_id)?;
    validate_uuid_v7("data_source_id", data_source_id)?;
    validate_uuid_v7("view_id", view_id)?;
    validate_id("operation_id", operation_id)?;
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 256 {
        return Err(invalid(
            "Database name must contain between 1 and 256 characters",
        ));
    }
    if matches!(
        parent,
        LibraryWriteParent::Page {
            insertion: Some(_),
            ..
        }
    ) {
        return Err(invalid(
            "Database creation does not accept a Page insertion intent",
        ));
    }
    let resolved_parent =
        resolve_write_parent_for_context(connection, context, library_id, parent)?;
    if connection
        .query_row(
            "SELECT 1 WHERE EXISTS (SELECT 1 FROM blocks WHERE id = ?1) \
             OR EXISTS (SELECT 1 FROM data_sources WHERE id = ?2) \
             OR EXISTS (SELECT 1 FROM database_views WHERE id = ?3)",
            params![database_id, data_source_id, view_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some()
    {
        return Err(StoreError::new(
            StoreErrorCode::Conflict,
            "New Database, Data Source, or View identity already exists",
            false,
        ));
    }
    let project_id = resolved_parent.actor_project_id.clone();
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
            connection.execute(
                "INSERT INTO blocks(\
           id, library_id, type, lifecycle, placement_revision, metadata_revision, \
           created_at, updated_at\
         ) VALUES (?1, ?2, 'database', 'active', 1, 1, ?3, ?3)",
                params![database_id, library_id, now],
            )?;
            if resolved_parent.document.is_none() {
                insert_library_placement(
                    connection,
                    library_id,
                    database_id,
                    match parent {
                        LibraryWriteParent::Library { before } => before.as_ref(),
                        LibraryWriteParent::Page { .. } => None,
                    },
                    &now,
                )?;
                if let Some(creator_project_id) = resolved_parent.creator_project_id.as_deref() {
                    insert_creator_resource_grant(
                        connection,
                        creator_project_id,
                        library_id,
                        "database",
                        database_id,
                        &now,
                    )?;
                }
            }
            create_database_authority_records(
                connection,
                library_id,
                database_id,
                data_source_id,
                view_id,
                name,
                &now,
            )?;
            let parent_head_seq = resolved_parent
                .document
                .as_ref()
                .map(|parent| {
                    persist_parent_insert(
                        connection,
                        ParentDocumentWriteContext {
                            actor_project_id: &project_id,
                            store_epoch,
                            operation_id,
                            commit: scope.evidence(),
                        },
                        parent,
                        embedded_resource_block(database_id, "database"),
                        resolved_parent.before_block_id.clone(),
                    )
                })
                .transpose()?;
            seal_mutation(
                scope,
                context,
                operation_id,
                MutationEffects {
                    project_id,
                    operation_kind: "create_database",
                    change_kind: "library.changed",
                    did_mutate: true,
                    created_target: Some(LibraryResourceTarget::Database {
                        database_id: database_id.to_owned(),
                    }),
                    affected_parent_keys: vec![resolved_parent.parent_key.clone()],
                    affected_block_ids: Vec::new(),
                    affected_page_ids: resolved_parent.page_id.clone().into_iter().collect(),
                    affected_database_ids: vec![database_id.to_owned()],
                    affected_view_ids: vec![view_id.to_owned()],
                    affected_document_ids: resolved_parent
                        .document
                        .as_ref()
                        .map(|parent| parent.authority.head.id.clone())
                        .into_iter()
                        .collect(),
                    committed_revisions: BTreeMap::from_iter(
                        [
                            (format!("blockLocation:{database_id}"), 1),
                            (format!("blockMetadata:{database_id}"), 1),
                            (format!("databaseMetadata:{database_id}"), 1),
                            (format!("dataSourceSchema:{data_source_id}"), 1),
                            (format!("view:{view_id}"), 1),
                        ]
                        .into_iter()
                        .chain(
                            parent_head_seq.zip(resolved_parent.document.as_ref()).map(
                                |(commit, parent)| {
                                    (
                                        format!("documentHead:{}", parent.authority.head.id),
                                        commit.head_seq,
                                    )
                                },
                            ),
                        ),
                    ),
                    page_create: None,
                    page_copy: None,
                    page_files: None,
                    canvas_mutation: None,
                    block_transfer: None,
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
            )
        },
    )?;
    library_commit_result(connection, commit_result)
}

#[allow(clippy::too_many_arguments)]
fn create_page_records_and_genesis(
    connection: &Connection,
    store_epoch: &str,
    library_id: &str,
    operation_id: &str,
    page_id: &str,
    document_id: &str,
    genesis: PageGenesisInput<'_>,
    parent: &LibraryWriteParent,
    resolved_parent: &ResolvedWriteParent,
    project_id: &str,
    now: &str,
    commit: &CommitContext,
) -> Result<LibraryPageCreateResult, StoreError> {
    let prepared = match genesis {
        PageGenesisInput::PlainTitle(title) => {
            let root_block_id = deterministic_block_id(operation_id);
            prepare_page_yjs_genesis(document_id, title, &root_block_id)?
        }
        PageGenesisInput::NestedMarkdown {
            title_markdown,
            nfm,
        } => {
            let rich_title = parse_inline_markdown_title(title_markdown)
                .map_err(|error| invalid(&error.to_string()))?;
            let mut ordinal = 0_u64;
            prepare_page_yjs_genesis_with_content(document_id, &rich_title, nfm, &mut || {
                let block_id =
                    stable_uuid_v7(operation_id, "page_body_block", &ordinal.to_string());
                ordinal += 1;
                block_id
            })?
        }
    };

    connection.execute(
        "INSERT INTO blocks (\
           id, library_id, type, lifecycle, placement_revision, metadata_revision, \
           created_at, updated_at\
         ) VALUES (?1, ?2, 'page', 'active', 1, 1, ?3, ?3)",
        params![page_id, library_id, now],
    )?;
    connection.execute(
        "INSERT INTO documents(\
           id, library_id, generation, head_seq, schema_key, schema_version, state_vector, \
           state_hash, readiness, authority, genesis_source_revision, created_at, updated_at, \
           sync_engine\
         ) VALUES (?1, ?2, 1, 0, ?3, ?4, X'', '', 'pending_genesis', 'legacy_shadow', \
           NULL, ?5, ?5, 'yjs')",
        params![
            document_id,
            library_id,
            PAGE_SCHEMA_KEY,
            i64::from(PAGE_SCHEMA_VERSION),
            now
        ],
    )?;
    connection.execute(
        "INSERT INTO block_documents(block_id, document_id, library_id, created_at) \
         VALUES (?1, ?2, ?3, ?4)",
        params![page_id, document_id, library_id, now],
    )?;
    connection.execute(
        "INSERT INTO pages(\
           block_id, library_id, document_id, parent_kind, parent_id, created_at, updated_at\
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
        params![
            page_id,
            library_id,
            document_id,
            if resolved_parent.page_id.is_some() {
                "page"
            } else {
                "library"
            },
            resolved_parent.page_id.as_deref().unwrap_or(library_id),
            now
        ],
    )?;
    if resolved_parent.document.is_none() {
        insert_library_placement(
            connection,
            library_id,
            page_id,
            match parent {
                LibraryWriteParent::Library { before } => before.as_ref(),
                LibraryWriteParent::Page { .. } => None,
            },
            now,
        )?;
        if let Some(creator_project_id) = resolved_parent.creator_project_id.as_deref() {
            insert_creator_resource_grant(
                connection,
                creator_project_id,
                library_id,
                "page",
                page_id,
                now,
            )?;
        }
    }
    let authority = read_document_authority(connection, document_id)?
        .ok_or_else(|| corrupt("Created Page has no Document authority"))?;
    if authority.head.schema_key != BlockDocumentSchema::PageV3.schema_key()
        || authority.head.schema_version != i64::from(PAGE_SCHEMA_VERSION)
    {
        return Err(corrupt("Created Page has the wrong Document schema"));
    }
    let genesis_update_id = format!("library-page-genesis:{}", sha256(operation_id.as_bytes()));
    let full_state = prepared.engine.full_state_v1();
    let persisted = persist_yjs_genesis_with_local_commit(
        connection,
        PersistYjsGenesis {
            authority: &authority,
            actor_project_id: project_id,
            materialization: &prepared.materialization,
            update_id: &genesis_update_id,
            client_session_id: "library-module",
            update: &prepared.update_v1,
            state_vector: &prepared.state_vector_v1,
            full_state: &full_state,
            store_epoch,
            operation_id: &genesis_update_id,
            placement: DocumentPlacementEvidence::STRUCTURAL,
            emit_event: false,
        },
        commit,
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
    let (title_etag, body_etag) = mint_document_semantic_etags(
        connection,
        project_id,
        store_epoch,
        document_id,
        &prepared.materialization,
    )
    .map_err(|error| internal(&error.to_string()))?;
    Ok(LibraryPageCreateResult {
        page_id: page_id.to_owned(),
        page_key: None,
        document_id: document_id.to_owned(),
        document_generation: 1,
        document_head_seq: persisted.head_seq,
        block_ids: materialized_block_ids(&prepared.materialization.block_tree),
        title_etag,
        body_etag,
    })
}

#[allow(clippy::too_many_arguments)]
fn create_page(
    connection: &Connection,
    context: &BoundModuleContext,
    store_epoch: &str,
    library_id: &str,
    operation_id: &str,
    request_hash: &str,
    page_id: &str,
    document_id: &str,
    genesis: PageGenesisInput<'_>,
    parent: &LibraryWriteParent,
) -> Result<LibraryApplyOutcome, StoreError> {
    validate_id("page_id", page_id)?;
    validate_id("document_id", document_id)?;
    validate_id("operation_id", operation_id)?;
    if genesis.title().len() > MAX_PAGE_TITLE_LENGTH {
        return Err(invalid("Page title exceeds its bound"));
    }
    let resolved_parent =
        resolve_write_parent_for_context(connection, context, library_id, parent)?;
    if connection
        .query_row(
            "SELECT 1 WHERE EXISTS (SELECT 1 FROM blocks WHERE id = ?1) \
             OR EXISTS (SELECT 1 FROM documents WHERE id = ?2)",
            params![page_id, document_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some()
    {
        return Err(StoreError::new(
            StoreErrorCode::Conflict,
            "New Page or Document identity already exists",
            false,
        ));
    }
    let project_id = resolved_parent.actor_project_id.clone();
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
            let page_create = create_page_records_and_genesis(
                connection,
                store_epoch,
                library_id,
                operation_id,
                page_id,
                document_id,
                genesis,
                parent,
                &resolved_parent,
                &project_id,
                &now,
                scope.evidence(),
            )?;

            let parent_insertion = match parent {
                LibraryWriteParent::Page { insertion, .. } => insertion.as_ref(),
                LibraryWriteParent::Library { .. } => None,
            };
            let parent_head_seq = resolved_parent
                .document
                .as_ref()
                .map(|parent| {
                    let write = ParentDocumentWriteContext {
                        actor_project_id: &project_id,
                        store_epoch,
                        operation_id,
                        commit: scope.evidence(),
                    };
                    if let Some(insertion) = parent_insertion {
                        return persist_parent_insert_with_insertion(
                            connection,
                            write,
                            parent,
                            insertion,
                            embedded_resource_block(page_id, "page"),
                        );
                    }
                    persist_parent_insert(
                        connection,
                        write,
                        parent,
                        embedded_resource_block(page_id, "page"),
                        resolved_parent.before_block_id.clone(),
                    )
                })
                .transpose()?;
            seal_mutation(
                scope,
                context,
                operation_id,
                MutationEffects {
                    project_id,
                    operation_kind: "create_page",
                    change_kind: "library.changed",
                    did_mutate: true,
                    created_target: Some(LibraryResourceTarget::Page {
                        page_id: page_id.to_owned(),
                    }),
                    affected_parent_keys: vec![resolved_parent.parent_key.clone()],
                    affected_block_ids: Vec::new(),
                    affected_page_ids: std::iter::once(page_id.to_owned())
                        .chain(resolved_parent.page_id.clone())
                        .collect(),
                    affected_database_ids: Vec::new(),
                    affected_view_ids: Vec::new(),
                    affected_document_ids: std::iter::once(document_id.to_owned())
                        .chain(
                            resolved_parent
                                .document
                                .as_ref()
                                .map(|parent| parent.authority.head.id.clone()),
                        )
                        .collect(),
                    committed_revisions: BTreeMap::from_iter(
                        [
                            (format!("blockLocation:{page_id}"), 1),
                            (format!("blockMetadata:{page_id}"), 1),
                            (
                                format!("documentHead:{document_id}"),
                                page_create.document_head_seq,
                            ),
                        ]
                        .into_iter()
                        .chain(
                            parent_head_seq.zip(resolved_parent.document.as_ref()).map(
                                |(commit, parent)| {
                                    (
                                        format!("documentHead:{}", parent.authority.head.id),
                                        commit.head_seq,
                                    )
                                },
                            ),
                        ),
                    ),
                    page_create: Some(page_create),
                    page_copy: None,
                    page_files: None,
                    canvas_mutation: None,
                    block_transfer: None,
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
            )
        },
    )?;
    library_commit_result(connection, commit_result)
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum PageMentionRichTextUnit {
    Character {
        value: char,
        styles: RichTextStyles,
        href: Option<String>,
    },
    Atom(RichTextItem),
}

fn page_mention_rich_text_units(items: &[RichTextItem]) -> Vec<PageMentionRichTextUnit> {
    items
        .iter()
        .flat_map(|item| match item {
            RichTextItem::Text { text, styles } => text
                .chars()
                .map(|value| PageMentionRichTextUnit::Character {
                    value,
                    styles: styles.clone(),
                    href: None,
                })
                .collect(),
            RichTextItem::Link { text, href, styles } => text
                .chars()
                .map(|value| PageMentionRichTextUnit::Character {
                    value,
                    styles: styles.clone(),
                    href: Some(href.clone()),
                })
                .collect(),
            item => vec![PageMentionRichTextUnit::Atom(item.clone())],
        })
        .collect()
}

fn parse_page_mention_rich_text(
    value: &[serde_json::Value],
    label: &str,
) -> Result<Vec<RichTextItem>, StoreError> {
    let parsed =
        serde_json::from_value::<Vec<RichTextItem>>(serde_json::Value::Array(value.to_vec()))
            .map_err(|_| invalid(&format!("{label} is not portable rich text")))?;
    let canonical = canonicalize_rich_text(&parsed)
        .map_err(|_| invalid(&format!("{label} is not canonical portable rich text")))?;
    if parsed != canonical.rich_text {
        return Err(invalid(&format!(
            "{label} must already be canonical portable rich text"
        )));
    }
    Ok(parsed)
}

fn is_plain_space(unit: &PageMentionRichTextUnit) -> bool {
    matches!(
        unit,
        PageMentionRichTextUnit::Character {
            value: ' ',
            styles,
            href: None,
        } if styles == &RichTextStyles::default()
    )
}

fn is_valid_page_mention_replacement(
    expected: &[RichTextItem],
    replacement: &[RichTextItem],
    page_id: &str,
) -> bool {
    let expected_target_count = expected
        .iter()
        .filter(|item| {
            matches!(
                item,
                RichTextItem::PageMention { target_page_id } if target_page_id == page_id
            )
        })
        .count();
    let replacement_target_count = replacement
        .iter()
        .filter(|item| {
            matches!(
                item,
                RichTextItem::PageMention { target_page_id } if target_page_id == page_id
            )
        })
        .count();
    if replacement_target_count != expected_target_count + 1 {
        return false;
    }

    let expected_units = page_mention_rich_text_units(expected);
    let replacement_units = page_mention_rich_text_units(replacement);
    replacement_units
        .iter()
        .enumerate()
        .filter(|(_, unit)| {
            matches!(
                unit,
                PageMentionRichTextUnit::Atom(RichTextItem::PageMention { target_page_id })
                    if target_page_id == page_id
            )
        })
        .any(|(mention_index, _)| {
            [true, false].into_iter().any(|consume_space| {
                let suffix_index = mention_index + 1 + usize::from(consume_space);
                if suffix_index > replacement_units.len() {
                    return false;
                }
                if consume_space
                    && !replacement_units
                        .get(mention_index + 1)
                        .is_some_and(is_plain_space)
                {
                    return false;
                }
                let prefix = &replacement_units[..mention_index];
                let suffix = &replacement_units[suffix_index..];
                if expected_units.len() < prefix.len() + suffix.len()
                    || !expected_units.starts_with(prefix)
                    || !expected_units.ends_with(suffix)
                {
                    return false;
                }
                let removed = &expected_units[prefix.len()..expected_units.len() - suffix.len()];
                if removed.is_empty()
                    || removed.iter().any(|unit| {
                        !matches!(unit, PageMentionRichTextUnit::Character { href: None, .. })
                    })
                {
                    return false;
                }
                let removed_text = removed
                    .iter()
                    .filter_map(|unit| match unit {
                        PageMentionRichTextUnit::Character { value, .. } => Some(*value),
                        PageMentionRichTextUnit::Atom(_) => None,
                    })
                    .collect::<String>();
                removed_text.starts_with('@')
                    || removed_text.starts_with('+')
                    || removed_text.starts_with("[[")
            })
        })
}

#[allow(clippy::too_many_arguments)]
fn create_page_mention(
    connection: &Connection,
    context: &BoundModuleContext,
    store_epoch: &str,
    library_id: &str,
    operation_id: &str,
    request_hash: &str,
    page_id: &str,
    document_id: &str,
    title: &str,
    mention_host: &LibraryPageMentionHost,
    destination: &LibraryPageMentionDestination,
) -> Result<LibraryApplyOutcome, StoreError> {
    validate_id("page_id", page_id)?;
    validate_id("document_id", document_id)?;
    validate_id("operation_id", operation_id)?;
    if title.len() > MAX_PAGE_TITLE_LENGTH {
        return Err(invalid("Page title exceeds its bound"));
    }
    if !matches!(destination.insertion, LibraryPageInsertion::Append { .. }) {
        return Err(invalid(
            "Page mention creation only supports append destinations",
        ));
    }
    let expected_rich_text =
        parse_page_mention_rich_text(&mention_host.expected_content, "expected_content")?;
    let replacement_rich_text =
        parse_page_mention_rich_text(&mention_host.replacement_content, "replacement_content")?;
    if !is_valid_page_mention_replacement(&expected_rich_text, &replacement_rich_text, page_id) {
        return Err(invalid(
            "Page mention replacement must replace one typed trigger with the new Page mention",
        ));
    }
    let expected_content = materialized_inline_from_rich_text(&expected_rich_text)
        .map_err(|_| invalid("expected_content cannot be materialized"))?;
    let replacement_content = materialized_inline_from_rich_text(&replacement_rich_text)
        .map_err(|_| invalid("replacement_content cannot be materialized"))?;

    let destination_parent = LibraryWriteParent::Page {
        page_id: destination.page_id.clone(),
        expected_document_generation: destination.expected_document_generation,
        expected_document_head_seq: destination.expected_document_head_seq,
        before: None,
        insertion: Some(destination.insertion.clone()),
    };
    let resolved_destination =
        resolve_write_parent_for_context(connection, context, library_id, &destination_parent)?;
    let destination_document = resolved_destination
        .document
        .as_ref()
        .ok_or_else(|| corrupt("Page mention destination lost its Document"))?;
    if destination_document.authority.head.id != destination.document_id {
        return Err(invalid(
            "Page mention destination Document identity does not match its Page",
        ));
    }

    let same_document = mention_host.document_id == destination.document_id;
    let resolved_host = if same_document {
        if mention_host.page_id != destination.page_id
            || mention_host.expected_document_generation != destination.expected_document_generation
            || mention_host.expected_document_head_seq != destination.expected_document_head_seq
        {
            return Err(invalid(
                "One Page Document cannot have different mention and destination coordinates",
            ));
        }
        None
    } else {
        let host_parent = LibraryWriteParent::Page {
            page_id: mention_host.page_id.clone(),
            expected_document_generation: mention_host.expected_document_generation,
            expected_document_head_seq: mention_host.expected_document_head_seq,
            before: None,
            insertion: None,
        };
        Some(resolve_write_parent_for_context(
            connection,
            context,
            library_id,
            &host_parent,
        )?)
    };
    let host_document = resolved_host
        .as_ref()
        .and_then(|host| host.document.as_ref())
        .unwrap_or(destination_document);
    if host_document.authority.head.id != mention_host.document_id
        || host_document.authority.owner_block_id != mention_host.page_id
    {
        return Err(invalid(
            "Page mention host Document identity does not match its Page",
        ));
    }
    let host_block = find_materialized_block(
        &host_document.base_materialization.block_tree,
        &mention_host.block_id,
    )
    .ok_or_else(|| {
        StoreError::new(
            StoreErrorCode::Conflict,
            "Page mention host Block is unavailable",
            true,
        )
    })?;
    let current_content = host_block
        .content
        .as_ref()
        .ok_or_else(|| invalid("Page mention host Block has no inline content"))?;
    let current_rich_text = rich_text_from_materialized_inline(current_content)
        .map_err(|_| invalid("Page mention host Block is not portable inline content"))?;
    if current_rich_text.rich_text != expected_rich_text {
        return Err(StoreError::new(
            StoreErrorCode::HeadConflict,
            "Page mention host content changed",
            true,
        ));
    }
    if connection
        .query_row(
            "SELECT 1 WHERE EXISTS (SELECT 1 FROM blocks WHERE id = ?1) \
             OR EXISTS (SELECT 1 FROM documents WHERE id = ?2)",
            params![page_id, document_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some()
    {
        return Err(StoreError::new(
            StoreErrorCode::Conflict,
            "New Page or Document identity already exists",
            false,
        ));
    }

    let project_id = resolved_destination.actor_project_id.clone();
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
            let page_create = create_page_records_and_genesis(
                connection,
                store_epoch,
                library_id,
                operation_id,
                page_id,
                document_id,
                PageGenesisInput::PlainTitle(title),
                &destination_parent,
                &resolved_destination,
                &project_id,
                &now,
                scope.evidence(),
            )?;
            let write = ParentDocumentWriteContext {
                actor_project_id: &project_id,
                store_epoch,
                operation_id,
                commit: scope.evidence(),
            };
            let content_operation = DocumentBlockOperation::UpdateBlock {
                block_id: mention_host.block_id.clone(),
                patch: DocumentBlockUpdatePatch {
                    block_type: None,
                    props: None,
                    content: Some(replacement_content.clone()),
                    unset_content: false,
                },
            };
            let document_commits = if same_document {
                let mut operations = super::canvas_mutation::page_shell_insertion_operations(
                    destination_document,
                    &destination.insertion,
                    embedded_resource_block(page_id, "page"),
                )?;
                operations.push(content_operation);
                let placement_ids = vec![page_id.to_owned()];
                vec![persist_parent_operations_detailed_with_local_commit(
                    connection,
                    write,
                    "create-page-mention",
                    destination_document,
                    &operations,
                    ParentDocumentPlacement::Genesis(&placement_ids),
                )?]
            } else {
                let destination_commit = persist_parent_insert_with_insertion(
                    connection,
                    write,
                    destination_document,
                    &destination.insertion,
                    embedded_resource_block(page_id, "page"),
                )?;
                let host_document = resolved_host
                    .as_ref()
                    .and_then(|host| host.document.as_ref())
                    .ok_or_else(|| corrupt("Page mention host lost its Document"))?;
                let host_commit = persist_parent_operations_detailed_with_local_commit(
                    connection,
                    write,
                    "create-page-mention-host",
                    host_document,
                    &[content_operation],
                    ParentDocumentPlacement::Derived {
                        attachment_advances: &[],
                    },
                )?;
                vec![destination_commit, host_commit]
            };
            let prepared_history = super::structural_edit::prepare_page_mention_history(
                connection,
                library_id,
                operation_id,
                store_epoch,
                &destination.page_id,
                &destination.document_id,
                page_id,
                &mention_host.page_id,
                &mention_host.document_id,
                &mention_host.block_id,
                expected_content.clone(),
                replacement_content.clone(),
                document_commits,
            )?;
            let mut effects = super::structural_edit::page_mention_history_effects(
                &prepared_history,
                &project_id,
                &now,
            );
            effects.created_target = Some(LibraryResourceTarget::Page {
                page_id: page_id.to_owned(),
            });
            effects.page_create = Some(page_create.clone());
            effects.affected_parent_keys.extend([
                format!("page:{}", mention_host.page_id),
                format!("page:{}", destination.page_id),
            ]);
            effects
                .affected_block_ids
                .push(mention_host.block_id.clone());
            effects.affected_page_ids.extend([
                page_id.to_owned(),
                mention_host.page_id.clone(),
                destination.page_id.clone(),
            ]);
            effects.affected_document_ids.push(document_id.to_owned());
            effects.committed_revisions.extend([
                (format!("blockLocation:{page_id}"), 1),
                (format!("blockMetadata:{page_id}"), 1),
                (
                    format!("documentHead:{document_id}"),
                    page_create.document_head_seq,
                ),
            ]);
            normalize_ids(&mut effects.affected_parent_keys);
            normalize_ids(&mut effects.affected_block_ids);
            normalize_ids(&mut effects.affected_page_ids);
            normalize_ids(&mut effects.affected_document_ids);
            let history_result =
                super::structural_edit::page_mention_history_result(&prepared_history).clone();
            effects.structural_edit = Some(history_result);
            let request = json!({
                "kind": "create_page_mention",
                "page_id": page_id,
                "document_id": document_id,
                "title": title,
                "mention_host": mention_host,
                "destination": destination,
            });
            seal_mutation_with(
                scope,
                context,
                operation_id,
                effects,
                |_, event_sequence| {
                    super::structural_edit::persist_page_mention_history(
                        connection,
                        &prepared_history,
                        operation_id,
                        library_id,
                        &project_id,
                        store_epoch,
                        request_hash,
                        &request,
                        event_sequence,
                        &now,
                    )
                },
            )
        },
    )?;
    library_commit_result(connection, commit_result)
}

#[allow(clippy::too_many_arguments)]
pub(super) fn create_page_from_nfm(
    connection: &Connection,
    context: &BoundModuleContext,
    store_epoch: &str,
    library_id: &str,
    operation_id: &str,
    request_hash: &str,
    page_id: &str,
    document_id: &str,
    title_markdown: &str,
    nfm: &str,
    parent: &LibraryWriteParent,
) -> Result<LibraryApplyOutcome, StoreError> {
    create_page(
        connection,
        context,
        store_epoch,
        library_id,
        operation_id,
        request_hash,
        page_id,
        document_id,
        PageGenesisInput::NestedMarkdown {
            title_markdown,
            nfm,
        },
        parent,
    )
}

enum PageGenesisInput<'a> {
    PlainTitle(&'a str),
    NestedMarkdown {
        title_markdown: &'a str,
        nfm: &'a str,
    },
}

pub(crate) fn insert_creator_resource_grant(
    connection: &Connection,
    project_id: &str,
    library_id: &str,
    root_kind: &str,
    root_id: &str,
    now: &str,
) -> Result<(), StoreError> {
    let grant_id = format!(
        "grant:{}",
        sha256(
            serde_json::to_string(&[project_id, root_kind, root_id])
                .map_err(|_| internal("Project grant identity"))?
                .as_bytes(),
        ),
    );
    connection.execute(
        "INSERT INTO project_resource_grants( \
           id, project_id, library_id, root_kind, root_id, access, recursive, revision, \
           lifecycle, created_at, updated_at \
         ) VALUES (?1, ?2, ?3, ?4, ?5, 'read_write', 1, 1, 'active', ?6, ?6) \
         ON CONFLICT(project_id, root_kind, root_id) DO UPDATE SET \
           access = 'read_write', recursive = 1, lifecycle = 'active', \
           revision = CASE \
             WHEN project_resource_grants.access = 'read_write' \
              AND project_resource_grants.recursive = 1 \
              AND project_resource_grants.lifecycle = 'active' \
             THEN project_resource_grants.revision \
             ELSE project_resource_grants.revision + 1 \
           END, \
           updated_at = CASE \
             WHEN project_resource_grants.access = 'read_write' \
              AND project_resource_grants.recursive = 1 \
              AND project_resource_grants.lifecycle = 'active' \
             THEN project_resource_grants.updated_at \
             ELSE excluded.updated_at \
           END",
        params![grant_id, project_id, library_id, root_kind, root_id, now],
    )?;
    Ok(())
}

impl PageGenesisInput<'_> {
    fn title(&self) -> &str {
        match self {
            Self::PlainTitle(title) => title,
            Self::NestedMarkdown { title_markdown, .. } => title_markdown,
        }
    }
}

pub(super) fn library_commit_result(
    connection: &Connection,
    result: CommitResult<crate::ModuleWriterResult<LibraryCommitValue, LibraryReceipt>>,
) -> Result<LibraryApplyOutcome, StoreError> {
    result.verify_manifest_identity(|committed| {
        (committed.commit_seq, committed.store_epoch.0.clone())
    })?;
    match result {
        CommitResult::Committed {
            outcome: committed, ..
        } => {
            let event = load_committed_event_by_sequence(connection, committed.event_sequence)?;
            Ok(LibraryApplyOutcome {
                committed,
                event: Some(event),
            })
        }
        CommitResult::NoOp { outcome: committed } => Ok(LibraryApplyOutcome {
            committed,
            event: None,
        }),
        CommitResult::IdempotentReplay {
            outcome: mut committed,
            ..
        } => {
            committed.receipt.mutation.duplicate = true;
            Ok(LibraryApplyOutcome {
                committed,
                event: None,
            })
        }
    }
}

pub(super) fn seal_mutation(
    scope: &DurableMutationScope<'_>,
    context: &BoundModuleContext,
    operation_id: &str,
    effects: MutationEffects,
) -> Result<SealedOutcome<crate::ModuleWriterResult<LibraryCommitValue, LibraryReceipt>>, StoreError>
{
    seal_mutation_with(scope, context, operation_id, effects, |_, _| Ok(()))
}

pub(super) fn seal_mutation_with(
    scope: &DurableMutationScope<'_>,
    context: &BoundModuleContext,
    operation_id: &str,
    effects: MutationEffects,
    before_seal: impl FnOnce(
        &crate::ModuleWriterResult<LibraryCommitValue, LibraryReceipt>,
        i64,
    ) -> Result<(), StoreError>,
) -> Result<SealedOutcome<crate::ModuleWriterResult<LibraryCommitValue, LibraryReceipt>>, StoreError>
{
    let committed_at = effects.committed_at.clone();
    let operation_kind = effects.operation_kind;
    if !effects.did_mutate {
        let commit_seq = local_commit::head(scope.connection())?;
        let event_sequence = scope.connection().query_row(
            "SELECT COALESCE(MAX(seq), 0) FROM change_log",
            [],
            |row| row.get::<_, i64>(0),
        )?;
        let committed = assemble_mutation_result(
            scope.store_epoch(),
            operation_id,
            effects,
            commit_seq,
            event_sequence,
        );
        before_seal(&committed, event_sequence)?;
        return Ok(scope.no_op(
            committed,
            ReceiptMetadata {
                operation_kind,
                event_sequence: None,
                committed_at: &committed_at,
            },
        ));
    }
    let authorization_before = scope.authorization_before()?;
    let (committed, event_sequence) = build_mutation_result(
        scope.connection(),
        context,
        scope.store_epoch(),
        operation_id,
        effects,
        scope.evidence(),
        &authorization_before,
    )?;
    before_seal(&committed, event_sequence)?;
    Ok(scope.seal(
        committed,
        ReceiptMetadata {
            operation_kind,
            event_sequence: Some(event_sequence),
            committed_at: &committed_at,
        },
    ))
}

#[allow(clippy::too_many_arguments)]
fn build_mutation_result(
    connection: &Connection,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    effects: MutationEffects,
    commit: &CommitContext,
    authorization_before: &[crate::infrastructure::durable_mutation::AuthorizedResourceObservation],
) -> Result<
    (
        crate::ModuleWriterResult<LibraryCommitValue, LibraryReceipt>,
        i64,
    ),
    StoreError,
> {
    let block_ids = effects
        .affected_block_ids
        .iter()
        .chain(effects.affected_page_ids.iter())
        .chain(&effects.affected_database_ids)
        .cloned()
        .collect::<Vec<_>>();
    let mut payload = effects.change_payload.clone().unwrap_or_else(|| {
        json!({
            "module": MODULE_NAME,
            "operationKind": effects.operation_kind,
            "didMutate": effects.did_mutate,
            "affectedParentKeys": effects.affected_parent_keys,
            "affectedPageIds": effects.affected_page_ids,
            "affectedDatabaseIds": effects.affected_database_ids,
            "affectedViewIds": effects.affected_view_ids,
        })
    });
    let payload_object = payload
        .as_object_mut()
        .ok_or_else(|| internal("Library event payload must be an object"))?;
    payload_object.insert("module".to_owned(), json!(MODULE_NAME));
    payload_object.insert(
        "affectedPageIds".to_owned(),
        json!(effects.affected_page_ids),
    );
    payload_object.insert(
        "affectedDatabaseIds".to_owned(),
        json!(effects.affected_database_ids),
    );
    payload_object.insert(
        "affectedViewIds".to_owned(),
        json!(effects.affected_view_ids),
    );
    payload_object.insert(
        "affectedParentKeys".to_owned(),
        json!(effects.affected_parent_keys),
    );
    let page_file_manifest_revisions = effects
        .committed_revisions
        .iter()
        .filter_map(|(key, revision)| {
            key.strip_prefix("pageFiles:")
                .filter(|page_id| !page_id.is_empty())
                .map(|page_id| (page_id.to_owned(), *revision))
        })
        .collect::<BTreeMap<_, _>>();
    let page_file_content_revisions = effects
        .committed_revisions
        .iter()
        .filter_map(|(key, revision)| {
            key.strip_prefix("pageFileContent:")
                .filter(|page_id| !page_id.is_empty())
                .map(|page_id| (page_id.to_owned(), *revision))
        })
        .collect::<BTreeMap<_, _>>();
    let (page_file_manifest_invalidations, page_file_content_invalidations) =
        derive_page_file_event_invalidations(
            connection,
            &context.library_id.0,
            &effects,
            &page_file_manifest_revisions,
            &page_file_content_revisions,
        )?;
    payload_object.insert(
        "pageFileManifestInvalidations".to_owned(),
        json!(page_file_manifest_invalidations),
    );
    payload_object.insert(
        "pageFileContentInvalidations".to_owned(),
        json!(page_file_content_invalidations),
    );
    let data_source_ids = effects
        .affected_parent_keys
        .iter()
        .filter_map(|key| key.strip_prefix("data_source:"))
        .map(str::to_owned)
        .collect::<Vec<_>>();
    // Database projection compilation is intentionally driven by the
    // relational resources named by the Library mutation itself. Document
    // owner Pages are added to the semantic impact below so open editors can
    // advance their heads, but cross-producting those owners with every
    // affected View would manufacture unrelated row removals and collapse an
    // otherwise exact row upsert into a read-only invalidation.
    let database_projection_impact = expand_database_coordinates(
        connection,
        ProjectionImpact::Resources {
            page_ids: effects.affected_page_ids.clone(),
            database_ids: effects.affected_database_ids.clone(),
            data_source_ids: data_source_ids.clone(),
            view_ids: effects.affected_view_ids.clone(),
            document_heads: Vec::new(),
        },
    )?;
    let document_heads = document_head_impacts(connection, &effects.affected_document_ids)?;
    let mut affected_page_ids = effects.affected_page_ids.clone();
    for head in &document_heads {
        if !affected_page_ids.contains(&head.page_id) {
            affected_page_ids.push(head.page_id.clone());
        }
    }
    affected_page_ids.sort();
    affected_page_ids.dedup();
    let projection_impact = if requires_library_projection_reset(effects.operation_kind) {
        ProjectionImpact::All
    } else {
        expand_database_coordinates(
            connection,
            ProjectionImpact::Resources {
                page_ids: affected_page_ids,
                database_ids: effects.affected_database_ids.clone(),
                data_source_ids,
                view_ids: effects.affected_view_ids.clone(),
                document_heads,
            },
        )?
    };
    crate::database::record_local_projection_delta(
        connection,
        commit,
        &context.library_id.0,
        &database_projection_impact,
        authorization_before,
    )?;
    crate::database::record_page_document_projection_delta(
        connection,
        commit,
        &context.library_id.0,
        &projection_impact,
    )?;
    let page_data_source_ids = effects
        .page_lifecycle
        .as_ref()
        .filter(|receipt| !receipt.created_tag_option_ids.is_empty())
        .and_then(|receipt| receipt.data_source_id.clone())
        .into_iter()
        .collect::<Vec<_>>();
    let page_database_ids = effects
        .affected_block_ids
        .iter()
        .chain(effects.affected_database_ids.iter())
        .map(|block_id| {
            let block_type = connection
                .query_row("SELECT type FROM blocks WHERE id = ?1", [block_id], |row| {
                    row.get::<_, String>(0)
                })
                .optional()?;
            Ok((block_type.as_deref() == Some("database")).then(|| block_id.clone()))
        })
        .collect::<Result<Vec<Option<String>>, StoreError>>()?
        .into_iter()
        .flatten()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    crate::database::record_page_detail_projection_delta(
        connection,
        commit,
        &context.library_id.0,
        &page_data_source_ids,
        &page_database_ids,
    )?;
    if matches!(projection_impact, ProjectionImpact::All) {
        local_commit::require_projection_read(
            connection,
            commit,
            nodex_core_contracts::LocalProjectionScope::Library {
                library_id: context.library_id.0.clone(),
            },
        )?;
    }
    let payload_json =
        serde_json::to_string(&payload).map_err(|_| internal("Library event payload"))?;
    let event_entry = NewChangeLogEntry {
        project_id: &effects.project_id,
        store_epoch,
        kind: effects.change_kind,
        operation_id: Some(operation_id),
        block_ids: &block_ids,
        document_ids: &effects.affected_document_ids,
        database_block_ids: &effects.affected_database_ids,
        payload_json: &payload_json,
        projection_impact: &projection_impact,
        committed_at: &effects.committed_at,
    };
    let event_sequence = append_change_log(connection, event_entry, commit)?;
    Ok((
        assemble_mutation_result(
            store_epoch,
            operation_id,
            effects,
            commit.commit_seq(),
            event_sequence,
        ),
        event_sequence,
    ))
}

fn derive_page_file_event_invalidations(
    connection: &Connection,
    library_id: &str,
    effects: &MutationEffects,
    manifest_revisions: &BTreeMap<String, i64>,
    content_revisions: &BTreeMap<String, i64>,
) -> Result<
    (
        BTreeMap<String, LibraryPageFileInvalidation>,
        BTreeMap<String, LibraryPageFileInvalidation>,
    ),
    StoreError,
> {
    let mut manifest_file_ids = BTreeMap::<String, BTreeSet<String>>::new();
    let mut placement_filtered_content_candidate_file_ids = BTreeSet::new();
    let mut content_file_ids = BTreeMap::<String, BTreeSet<String>>::new();

    if let Some(receipt) = &effects.page_files {
        manifest_file_ids
            .entry(receipt.page_id.clone())
            .or_default()
            .extend(
                receipt
                    .created_file_ids
                    .iter()
                    .chain(&receipt.updated_file_ids)
                    .chain(&receipt.deleted_file_ids)
                    .cloned(),
            );
        placement_filtered_content_candidate_file_ids
            .extend(receipt.updated_file_ids.iter().cloned());
    }

    for movement in page_file_ownership_moves(effects) {
        manifest_file_ids
            .entry(movement.previous_owner_page_id.clone())
            .or_default()
            .insert(movement.file_id.clone());
        manifest_file_ids
            .entry(movement.owner_page_id.clone())
            .or_default()
            .insert(movement.file_id.clone());
        // Ownership evidence is authoritative for both sides of a rehome.
        // The previous owner has no post-state placement left to discover,
        // but its Page-scoped File read cache must still be invalidated.
        content_file_ids
            .entry(movement.previous_owner_page_id.clone())
            .or_default()
            .insert(movement.file_id.clone());
        content_file_ids
            .entry(movement.owner_page_id.clone())
            .or_default()
            .insert(movement.file_id.clone());
        placement_filtered_content_candidate_file_ids.insert(movement.file_id.clone());
    }

    // Page copy deliberately exposes copied Block identities rather than its
    // private File identity remap. The copied Page starts with an empty File
    // manifest, so its complete live inventory is the exact changed set.
    if effects.page_copy.is_some() {
        for page_id in manifest_revisions.keys() {
            if manifest_file_ids.contains_key(page_id) {
                continue;
            }
            manifest_file_ids.insert(
                page_id.clone(),
                live_page_file_ids(connection, library_id, page_id)?,
            );
        }
    }

    let manifest_invalidations = build_page_file_invalidations(
        manifest_revisions,
        &manifest_file_ids,
        "Page File manifest invalidation",
    )?;

    for page_id in content_revisions.keys() {
        let placed_file_ids = placed_candidate_file_ids(
            connection,
            library_id,
            page_id,
            &placement_filtered_content_candidate_file_ids,
        )?;
        content_file_ids
            .entry(page_id.clone())
            .or_default()
            .extend(placed_file_ids);
    }
    let content_invalidations = build_page_file_invalidations(
        content_revisions,
        &content_file_ids,
        "Page File content invalidation",
    )?;

    Ok((manifest_invalidations, content_invalidations))
}

fn page_file_ownership_moves(
    effects: &MutationEffects,
) -> impl Iterator<Item = &LibraryPageFileOwnershipMove> {
    effects
        .block_transfer
        .iter()
        .flat_map(|result| &result.file_ownership_moves)
        .chain(
            effects
                .block_transfer_undo
                .iter()
                .flat_map(|result| &result.file_ownership_moves),
        )
        .chain(
            effects
                .structural_edit
                .iter()
                .flat_map(|result| &result.file_ownership_moves),
        )
        .chain(
            effects
                .agent_move_pages
                .iter()
                .flat_map(|result| &result.file_ownership_moves),
        )
}

fn live_page_file_ids(
    connection: &Connection,
    library_id: &str,
    page_id: &str,
) -> Result<BTreeSet<String>, StoreError> {
    connection
        .prepare(
            "SELECT file_id FROM page_files \
             WHERE owner_page_id = ?1 AND library_id = ?2 AND state = 'live' \
             ORDER BY file_id",
        )?
        .query_map(params![page_id, library_id], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<BTreeSet<_>>>()
        .map_err(Into::into)
}

fn placed_candidate_file_ids(
    connection: &Connection,
    library_id: &str,
    page_id: &str,
    candidate_file_ids: &BTreeSet<String>,
) -> Result<BTreeSet<String>, StoreError> {
    if candidate_file_ids.is_empty() {
        return Ok(BTreeSet::new());
    }
    let file_ids = serde_json::to_string(candidate_file_ids)
        .map_err(|_| internal("Page File invalidation candidates could not be encoded"))?;
    connection
        .prepare(
            "SELECT DISTINCT reference.page_file_id \
             FROM block_asset_refs reference \
             WHERE reference.library_id = ?1 AND reference.owner_block_id = ?2 \
               AND reference.page_file_id IN (SELECT value FROM json_each(?3)) \
             ORDER BY reference.page_file_id",
        )?
        .query_map(params![library_id, page_id, file_ids], |row| {
            row.get::<_, String>(0)
        })?
        .collect::<rusqlite::Result<BTreeSet<_>>>()
        .map_err(Into::into)
}

fn build_page_file_invalidations(
    revisions: &BTreeMap<String, i64>,
    file_ids_by_page: &BTreeMap<String, BTreeSet<String>>,
    label: &str,
) -> Result<BTreeMap<String, LibraryPageFileInvalidation>, StoreError> {
    let mut exact_identity_count = 0_usize;
    let mut exact_byte_length = 0_usize;
    revisions
        .iter()
        .map(|(page_id, revision)| {
            let Some(file_ids) = file_ids_by_page
                .get(page_id)
                .filter(|file_ids| !file_ids.is_empty())
            else {
                return Ok((
                    page_id.clone(),
                    LibraryPageFileInvalidation::Reset {
                        revision: *revision,
                    },
                ));
            };
            let file_ids = file_ids.iter().cloned().collect::<Vec<_>>();
            let identity_count = file_ids.len();
            let exact = LibraryPageFileInvalidation::Exact {
                revision: *revision,
                file_ids,
            };
            let encoded_length = serde_json::to_vec(&exact)
                .map_err(|_| internal(&format!("{label} could not be encoded")))?
                .len();
            let next_identity_count = exact_identity_count.saturating_add(identity_count);
            let next_byte_length = exact_byte_length.saturating_add(encoded_length);
            if next_identity_count > MAX_EXACT_PAGE_FILE_INVALIDATION_IDS
                || next_byte_length > MAX_EXACT_PAGE_FILE_INVALIDATION_BYTES
            {
                return Ok((
                    page_id.clone(),
                    LibraryPageFileInvalidation::Reset {
                        revision: *revision,
                    },
                ));
            }
            exact_identity_count = next_identity_count;
            exact_byte_length = next_byte_length;
            Ok((page_id.clone(), exact))
        })
        .collect()
}

fn assemble_mutation_result(
    store_epoch: &str,
    operation_id: &str,
    effects: MutationEffects,
    commit_seq: i64,
    event_sequence: i64,
) -> crate::ModuleWriterResult<LibraryCommitValue, LibraryReceipt> {
    let block_ids = effects
        .affected_block_ids
        .iter()
        .chain(effects.affected_page_ids.iter())
        .chain(&effects.affected_database_ids)
        .cloned()
        .collect::<Vec<_>>();
    let receipt = LibraryReceipt {
        mutation: ModuleMutationReceipt {
            operation_id: operation_id.to_owned(),
            duplicate: false,
        },
        operation_kind: effects.operation_kind.to_owned(),
        did_mutate: effects.did_mutate,
        created_target: effects.created_target,
        affected_parent_keys: effects.affected_parent_keys.clone(),
        affected_page_ids: effects.affected_page_ids.clone(),
        affected_database_ids: effects.affected_database_ids.clone(),
        affected_view_ids: effects.affected_view_ids.clone(),
        committed_revisions: effects.committed_revisions,
        commit_seq,
        committed_at: effects.committed_at.clone(),
    };
    crate::ModuleWriterResult {
        value: LibraryCommitValue {
            affected_resource_ids: block_ids,
            page_create: effects.page_create,
            page_copy: effects.page_copy,
            page_files: effects.page_files,
            canvas_mutation: effects.canvas_mutation,
            block_transfer: effects.block_transfer,
            block_transfer_undo: effects.block_transfer_undo,
            page_relocation_undo: effects.page_relocation_undo,
            structural_edit: effects.structural_edit,
            page_lifecycle: effects.page_lifecycle,
            block_property_mutation: effects.block_property_mutation,
            agent_page_copy: effects.agent_page_copy,
            agent_create_pages: effects.agent_create_pages,
            agent_move_pages: effects.agent_move_pages,
        },
        receipt,
        commit_seq,
        event_sequence,
        store_epoch: StoreEpoch(store_epoch.to_owned()),
    }
}

fn document_head_impacts(
    connection: &Connection,
    document_ids: &[String],
) -> Result<Vec<PageDocumentHeadImpact>, StoreError> {
    let mut impacts = Vec::new();
    for document_id in document_ids {
        let impact = connection
            .query_row(
                "SELECT page.block_id, document.generation, document.head_seq \
                 FROM pages page \
                 JOIN documents document ON document.id = page.document_id \
                 WHERE page.document_id = ?1",
                [document_id],
                |row| {
                    Ok(PageDocumentHeadImpact {
                        page_id: row.get(0)?,
                        document_id: document_id.clone(),
                        generation: row.get(1)?,
                        head_seq: row.get(2)?,
                    })
                },
            )
            .optional()?;
        if let Some(impact) = impact {
            impacts.push(impact);
        }
    }
    impacts.sort_by(|left, right| {
        left.page_id
            .cmp(&right.page_id)
            .then(left.document_id.cmp(&right.document_id))
    });
    impacts.dedup_by(|left, right| left.document_id == right.document_id);
    Ok(impacts)
}

fn requires_library_projection_reset(operation_kind: &str) -> bool {
    matches!(
        operation_kind,
        "grant_project_access" | "set_project_access" | "persist_agent_project_resource_grants"
    )
}

pub(super) fn assert_identity(
    connection: &Connection,
    profile_id: &str,
    library_id: &str,
) -> Result<(), StoreError> {
    let valid = connection
        .query_row(
            "SELECT 1 FROM libraries WHERE id = ?1 AND profile_id = ?2",
            params![library_id, profile_id],
            |_| Ok(()),
        )
        .optional()?;
    if valid.is_some() {
        return Ok(());
    }
    Err(StoreError::new(
        StoreErrorCode::Unauthorized,
        "bound Library identity is not present in this Profile store",
        false,
    ))
}

pub(super) fn resolve_library_mutation_authority(
    connection: &Connection,
    context: &BoundModuleContext,
    library_id: &str,
) -> Result<LibraryMutationAuthority, StoreError> {
    if let Some(project_id) = context.project_id.as_ref() {
        require_project_in_library(connection, &project_id.0, library_id)?;
        return Ok(LibraryMutationAuthority {
            actor_project_id: project_id.0.clone(),
            requesting_project_id: Some(project_id.0.clone()),
        });
    }
    if !matches!(
        context.adapter,
        AdapterKind::ElectronHost | AdapterKind::NativeCli | AdapterKind::Test
    ) {
        return Err(unauthorized(
            "Library mutations require a Project or trusted local Library authority",
        ));
    }
    let actor_project_id = resolve_library_actor_project_id(connection, library_id)?;
    Ok(LibraryMutationAuthority {
        actor_project_id,
        requesting_project_id: None,
    })
}

/// Returns the stable Project actor used by trusted local Library operations
/// whose transport does not carry a Project binding. This coordinate scopes
/// receipts and signed validators; it never owns Library content.
pub(crate) fn resolve_library_actor_project_id(
    connection: &Connection,
    library_id: &str,
) -> Result<String, StoreError> {
    connection
        .query_row(
            "SELECT id FROM projects WHERE library_id = ?1 ORDER BY created, id LIMIT 1",
            [library_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .ok_or_else(|| {
            StoreError::new(
                StoreErrorCode::NotFound,
                "The Library has no Project actor for local operations",
                false,
            )
        })
}

pub(crate) fn require_project_in_library(
    connection: &Connection,
    project_id: &str,
    library_id: &str,
) -> Result<(), StoreError> {
    let exists = connection
        .query_row(
            "SELECT 1 FROM projects WHERE id = ?1 AND library_id = ?2 AND lifecycle = 'active'",
            params![project_id, library_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if exists {
        return Ok(());
    }
    Err(unauthorized("Bound Project is unavailable in this Library"))
}

pub(crate) fn insert_library_placement(
    connection: &Connection,
    library_id: &str,
    block_id: &str,
    before: Option<&nodex_core_contracts::library::LibraryPlacementAnchor>,
    now: &str,
) -> Result<String, StoreError> {
    if let Some(anchor) = before {
        validate_library_anchor(connection, library_id, anchor)?;
    }
    let items = connection
        .prepare(
            "SELECT block_id, rank_key FROM library_block_placements WHERE library_id = ?1 \
             ORDER BY rank_key, block_id",
        )?
        .query_map([library_id], |row| {
            Ok(RankedItem {
                id: row.get(0)?,
                rank_key: row.get(1)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let plan = plan_fractional_rank(
        &items,
        block_id,
        before.map(|anchor| anchor.block_id.as_str()),
    )
    .map_err(placement_rank_error)?;
    for (sibling_id, rank_key) in &plan.rebalanced_rank_keys {
        synchronize_library_placement_rank(connection, library_id, sibling_id, rank_key, now)?;
    }
    connection.execute(
        "INSERT INTO library_block_placements(\
           block_id, library_id, rank_key, revision, created_at, updated_at\
         ) VALUES (?1, ?2, ?3, 1, ?4, ?4)",
        params![block_id, library_id, plan.rank_key, now],
    )?;
    Ok(plan.rank_key)
}

/// Rebalances a Library root's physical rank and its Page projection as one write.
/// Rebalancing preserves semantic order, so it advances only the placement-row
/// revision; the Block placement revision remains the user's structural CAS token.
pub(crate) fn synchronize_library_placement_rank(
    connection: &Connection,
    library_id: &str,
    block_id: &str,
    rank_key: &str,
    now: &str,
) -> Result<(), StoreError> {
    let changed = connection.execute(
        "UPDATE library_block_placements SET rank_key = ?1, revision = revision + 1, \
           updated_at = ?2 WHERE block_id = ?3 AND library_id = ?4 AND rank_key <> ?1",
        params![rank_key, now, block_id, library_id],
    )?;
    if changed == 0 {
        return Ok(());
    }
    let page_projection_exists = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM page_read_model \
         WHERE page_block_id = ?1 AND library_id = ?2)",
        params![block_id, library_id],
        |row| row.get::<_, bool>(0),
    )?;
    if !page_projection_exists {
        return Ok(());
    }
    let projected = connection.execute(
        "UPDATE page_read_model SET library_rank_key = ?1, updated_at = ?2 \
         WHERE page_block_id = ?3 AND library_id = ?4 AND parent_kind = 'library'",
        params![rank_key, now, block_id, library_id],
    )?;
    if projected == 1 {
        return Ok(());
    }
    Err(corrupt(
        "Library root rank changed without a matching Page projection",
    ))
}

fn placement_rank_error(error: crate::domain::fractional_rank::FractionalRankError) -> StoreError {
    match error.code {
        FractionalRankErrorCode::AnchorNotFound => invalid("Placement anchor disappeared"),
        FractionalRankErrorCode::RebalanceLimit => {
            StoreError::new(StoreErrorCode::ResourceExhausted, error.message, false)
        }
    }
}

fn validate_library_anchor(
    connection: &Connection,
    library_id: &str,
    anchor: &nodex_core_contracts::library::LibraryPlacementAnchor,
) -> Result<(), StoreError> {
    let actual = connection
        .query_row(
            "SELECT block.placement_revision FROM library_block_placements placement \
             JOIN blocks block ON block.id = placement.block_id \
             WHERE placement.library_id = ?1 AND placement.block_id = ?2 \
               AND block.lifecycle = 'active'",
            params![library_id, anchor.block_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()?;
    let Some(actual) = actual else {
        return Err(invalid(
            "Placement anchor is unavailable in the target Library",
        ));
    };
    if actual == anchor.expected_location_revision {
        return Ok(());
    }
    Err(StoreError::new(
        StoreErrorCode::RevisionConflict,
        "Placement anchor changed",
        true,
    ))
}

#[allow(clippy::too_many_arguments)]
pub(super) fn insert_page_read_model(
    connection: &Connection,
    page_id: &str,
    materialization: &crate::document::DocumentMaterialization,
    head_seq: i64,
    now: &str,
) -> Result<(), StoreError> {
    connection
        .execute(
            "INSERT INTO page_read_model(\
           page_block_id, library_id, lifecycle, parent_kind, parent_id, library_rank_key, \
           placement_revision, metadata_revision, \
           document_id, document_generation, document_projected_seq, document_schema_version, \
           document_authority, membership_id, database_block_id, view_id, view_group_key, \
           view_rank_key, title, description_preview, description_length, has_description, \
           database_values_json, intrinsic_properties_json, property_revisions_json, \
           projection_version, created_at, updated_at\
         ) \
         SELECT page.block_id, page.library_id, block.lifecycle, page.parent_kind, page.parent_id, \
                placement.rank_key, block.placement_revision, block.metadata_revision, \
                page.document_id, document.generation, ?2, document.schema_version, \
                document.authority, NULL, NULL, NULL, NULL, NULL, ?3, ?4, ?5, ?6, \
                '{}', '{}', '{}', 1, ?7, ?7 \
         FROM pages page \
         JOIN blocks block ON block.id = page.block_id AND block.library_id = page.library_id \
         JOIN documents document \
           ON document.id = page.document_id AND document.library_id = page.library_id \
         LEFT JOIN library_block_placements placement ON placement.block_id = page.block_id \
         WHERE page.block_id = ?1 AND document.head_seq = ?2",
            params![
                page_id,
                head_seq,
                materialization.title,
                materialization.preview,
                i64::try_from(materialization.nfm.len())
                    .map_err(|_| internal("Page description length overflow"))?,
                i64::from(!materialization.nfm.trim().is_empty()),
                now,
            ],
        )
        .and_then(|changed| {
            (changed == 1)
                .then_some(())
                .ok_or(rusqlite::Error::QueryReturnedNoRows)
        })
        .map_err(|_| corrupt("Page read model source authority is unavailable"))
}

pub(super) fn ensure_default_page_intrinsic_properties(
    connection: &Connection,
    page_id: &str,
    now: &str,
) -> Result<(), StoreError> {
    const DEFAULTS: &[(&str, &str, &str)] = &[
        ("run.target", "string", "\"localProject\""),
        ("run.localPath", "string", "null"),
        ("run.baseBranch", "string", "null"),
        ("run.worktreePath", "string", "null"),
        ("run.environmentPath", "string", "null"),
        ("schedule.isAllDay", "boolean", "false"),
        ("schedule.timezone", "string", "null"),
        ("recurrence.config", "json", "null"),
        ("reminders.config", "json", "[]"),
    ];
    for (key, value_type, value_json) in DEFAULTS {
        connection.execute(
            "INSERT OR IGNORE INTO block_properties( \
               block_id, library_id, property_key, value_type, value_json, revision, updated_at \
             ) SELECT ?1, library_id, ?2, ?3, ?4, 1, ?5 FROM blocks WHERE id = ?1",
            params![page_id, key, value_type, value_json, now],
        )?;
    }
    Ok(())
}

pub(super) fn refresh_page_intrinsic_projection(
    connection: &Connection,
    page_id: &str,
    now: &str,
) -> Result<(), StoreError> {
    let rows = connection
        .prepare(
            "SELECT property_key, value_json, revision FROM block_properties \
             WHERE block_id = ?1 ORDER BY property_key",
        )?
        .query_map([page_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut values = serde_json::Map::new();
    let mut intrinsic_revisions = serde_json::Map::new();
    for (key, value_json, revision) in rows {
        let value = serde_json::from_str(&value_json)
            .map_err(|_| corrupt("Page intrinsic Property JSON is invalid"))?;
        values.insert(key.clone(), value);
        intrinsic_revisions.insert(key, serde_json::Value::from(revision));
    }
    let revisions_json = connection
        .query_row(
            "SELECT property_revisions_json FROM page_read_model WHERE page_block_id = ?1",
            [page_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .ok_or_else(|| corrupt("Page intrinsic projection has no Page read model"))?;
    let mut revisions = serde_json::from_str::<serde_json::Value>(&revisions_json)
        .map_err(|_| corrupt("Page Property revision projection is invalid"))?;
    let revisions = revisions
        .as_object_mut()
        .ok_or_else(|| corrupt("Page Property revision projection is not an object"))?;
    revisions.insert(
        "intrinsic".to_owned(),
        serde_json::Value::Object(intrinsic_revisions),
    );
    revisions
        .entry("database".to_owned())
        .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
    let changed = connection.execute(
        "UPDATE page_read_model SET intrinsic_properties_json = ?1, \
           property_revisions_json = ?2, \
           metadata_revision = (SELECT metadata_revision FROM blocks WHERE id = ?4), \
           updated_at = ?3 WHERE page_block_id = ?4",
        params![
            serde_json::to_string(&values).map_err(|_| internal("Page intrinsic values"))?,
            serde_json::to_string(&revisions).map_err(|_| internal("Page intrinsic revisions"))?,
            now,
            page_id,
        ],
    )?;
    if changed == 1 {
        return Ok(());
    }
    Err(corrupt("Page intrinsic projection has no Page read model"))
}

fn validate_id(name: &str, value: &str) -> Result<(), StoreError> {
    if !value.trim().is_empty() && value.len() <= MAX_ID_LENGTH {
        return Ok(());
    }
    Err(invalid(&format!(
        "{name} must contain 1 to {MAX_ID_LENGTH} bytes"
    )))
}

fn validate_uuid_v7(name: &str, value: &str) -> Result<(), StoreError> {
    validate_id(name, value)?;
    let bytes = value.as_bytes();
    let valid = bytes.len() == 36
        && bytes.get(8) == Some(&b'-')
        && bytes.get(13) == Some(&b'-')
        && bytes.get(14) == Some(&b'7')
        && bytes.get(18) == Some(&b'-')
        && bytes.get(23) == Some(&b'-')
        && bytes
            .get(19)
            .is_some_and(|byte| matches!(byte.to_ascii_lowercase(), b'8' | b'9' | b'a' | b'b'))
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| matches!(index, 8 | 13 | 18 | 23) || byte.is_ascii_hexdigit());
    if valid {
        return Ok(());
    }
    Err(invalid(&format!("{name} must be a UUIDv7")))
}

fn deterministic_block_id(seed: &str) -> String {
    let entropy = sha256(format!("library-page-root:{seed}").as_bytes());
    format!(
        "{}-{}-7{}-8{}-{}",
        &entropy[..8],
        &entropy[8..12],
        &entropy[12..15],
        &entropy[15..18],
        &entropy[18..30]
    )
}

fn materialized_block_ids(blocks: &[MaterializedBlockNode]) -> Vec<String> {
    blocks
        .iter()
        .flat_map(|block| {
            std::iter::once(block.id.clone()).chain(materialized_block_ids(&block.children))
        })
        .collect()
}

pub(super) fn embedded_resource_block(block_id: &str, block_type: &str) -> MaterializedBlockNode {
    MaterializedBlockNode {
        id: block_id.to_owned(),
        block_type: block_type.to_owned(),
        props: BTreeMap::new(),
        content: None,
        children: Vec::new(),
    }
}

pub(super) fn sqlite_now(connection: &Connection) -> Result<String, StoreError> {
    connection
        .query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", [], |row| {
            row.get::<_, String>(0)
        })
        .map_err(StoreError::from)
}

fn invalid(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message, false)
}

fn unauthorized(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::Unauthorized, message, false)
}

fn corrupt(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message, false)
}

fn internal(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::Internal, message, false)
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    use nodex_core_contracts::document::{DocumentSemanticCommand, OwnedDocumentIntent};
    use nodex_core_contracts::library::{
        LibraryAgentSiblingAnchor, LibraryCanvasDestination, LibraryDocumentHead,
        LibraryInheritedProjectAccessSource, LibraryNavigationParent, LibraryPageInsertion,
        LibraryPageLifecycleMutation, LibraryPageLifecycleState, LibraryPagePrepareKind,
        LibraryPageProjectionFileKind, LibraryPageWriteDestination, LibraryRead, LibraryReadValue,
        LibrarySearchSnapshotScope,
    };
    use nodex_core_contracts::{
        AdapterKind, CoreErrorCode, LibraryId, LocalProjectionScope, ModuleReadRequest,
        OWNED_DOCUMENT_CONTRACT_VERSION, ProfileId, ProjectId, ResourceRevocationReason,
        RevokedResourceKind,
    };
    use tempfile::tempdir;

    use crate::document::OwnedDocumentModule;
    use crate::infrastructure::store::SqliteStoreKernel;
    use crate::library::LibraryModule;

    use super::*;

    const NOW: &str = "2026-07-18T23:59:00.000Z";

    #[test]
    fn only_unbounded_access_changes_require_library_projection_reset() {
        for operation in [
            "grant_project_access",
            "set_project_access",
            "persist_agent_project_resource_grants",
        ] {
            assert!(requires_library_projection_reset(operation), "{operation}");
        }
        for operation in [
            "move_block",
            "transfer_blocks",
            "agent_move_pages",
            "create_page",
            "create_page_mention",
            "mutate_block_properties",
        ] {
            assert!(!requires_library_projection_reset(operation), "{operation}");
        }
    }

    #[test]
    fn page_file_invalidations_preserve_sorted_exact_identities() {
        let invalidations = build_page_file_invalidations(
            &BTreeMap::from([("page:test".to_owned(), 7)]),
            &BTreeMap::from([(
                "page:test".to_owned(),
                BTreeSet::from(["file:b".to_owned(), "file:a".to_owned()]),
            )]),
            "test invalidation",
        )
        .expect("build exact invalidation");

        assert_eq!(
            invalidations.get("page:test"),
            Some(&LibraryPageFileInvalidation::Exact {
                revision: 7,
                file_ids: vec!["file:a".to_owned(), "file:b".to_owned()],
            })
        );
    }

    #[test]
    fn page_file_invalidations_reset_only_the_page_that_exhausts_the_budget() {
        let oversized = (0..=MAX_EXACT_PAGE_FILE_INVALIDATION_IDS)
            .map(|index| format!("file:{index:04}"))
            .collect();
        let invalidations = build_page_file_invalidations(
            &BTreeMap::from([("page:a".to_owned(), 3), ("page:b".to_owned(), 4)]),
            &BTreeMap::from([
                ("page:a".to_owned(), oversized),
                (
                    "page:b".to_owned(),
                    BTreeSet::from(["file:small".to_owned()]),
                ),
            ]),
            "test invalidation",
        )
        .expect("build bounded invalidations");

        assert_eq!(
            invalidations.get("page:a"),
            Some(&LibraryPageFileInvalidation::Reset { revision: 3 })
        );
        assert_eq!(
            invalidations.get("page:b"),
            Some(&LibraryPageFileInvalidation::Exact {
                revision: 4,
                file_ids: vec!["file:small".to_owned()],
            })
        );
    }

    fn context() -> BoundModuleContext {
        BoundModuleContext {
            profile_id: ProfileId("profile-1".to_owned()),
            library_id: LibraryId("library-1".to_owned()),
            project_id: Some(ProjectId("project-1".to_owned())),
            connection_id: "connection:library-write".to_owned(),
            adapter: AdapterKind::Test,
        }
    }

    fn library_context() -> BoundModuleContext {
        BoundModuleContext {
            profile_id: ProfileId("profile-1".to_owned()),
            library_id: LibraryId("library-1".to_owned()),
            project_id: None,
            connection_id: "connection:library-authority".to_owned(),
            adapter: AdapterKind::Test,
        }
    }

    fn create_request(operation_id: &str, title: &str) -> ModuleApplyRequest<LibraryIntent> {
        ModuleApplyRequest {
            contract_version: LIBRARY_CONTRACT_VERSION,
            operation_id: operation_id.to_owned(),
            store_epoch: StoreEpoch("epoch-1".to_owned()),
            intent: LibraryIntent::CreatePage {
                page_id: "page:created".to_owned(),
                document_id: "document:created".to_owned(),
                title: title.to_owned(),
                parent: LibraryWriteParent::Library { before: None },
            },
        }
    }

    fn create_mention_test_page(
        module: &LibraryModule,
        operation_id: &str,
        page_id: &str,
        document_id: &str,
    ) -> LibraryPageCreateResult {
        module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: operation_id.to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::CreatePage {
                        page_id: page_id.to_owned(),
                        document_id: document_id.to_owned(),
                        title: "Host".to_owned(),
                        parent: LibraryWriteParent::Library { before: None },
                    },
                },
            )
            .expect("create Page mention test Page")
            .committed
            .value
            .page_create
            .expect("Page creation result")
    }

    fn set_mention_test_content(
        kernel: &SqliteStoreKernel,
        page: &LibraryPageCreateResult,
        content: serde_json::Value,
        operation_id: &str,
    ) -> i64 {
        OwnedDocumentModule::new("profile-1", "library-1", kernel)
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    operation_id: operation_id.to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: OwnedDocumentIntent::ApplyOperationBatch {
                        document_id: page.document_id.clone(),
                        generation: page.document_generation,
                        expected_head_seq: page.document_head_seq,
                        operations: vec![
                            nodex_core_contracts::document::DocumentBlockOperation::UpdateBlock {
                                block_id: page.block_ids[0].clone(),
                                patch: nodex_core_contracts::document::DocumentBlockUpdatePatch {
                                    block_type: None,
                                    props: None,
                                    content: nodex_core_contracts::document::DocumentOptionalValue::Value {
                                        value: content,
                                    },
                                    unset_content: false,
                                },
                            },
                        ],
                        actor: json!({ "kind": "editor" }),
                    },
                },
            )
            .expect("seed typed Page mention content");
        kernel
            .readers()
            .read_default(|connection| {
                connection
                    .query_row(
                        "SELECT head_seq FROM documents WHERE id = ?1",
                        [&page.document_id],
                        |row| row.get::<_, i64>(0),
                    )
                    .map_err(StoreError::from)
            })
            .expect("read typed Page mention head")
    }

    struct PageMentionRequestInput<'a> {
        operation_id: &'a str,
        new_page_id: &'a str,
        new_document_id: &'a str,
        host: &'a LibraryPageCreateResult,
        host_head_seq: i64,
        destination: &'a LibraryPageCreateResult,
        destination_head_seq: i64,
        expected_content: Vec<serde_json::Value>,
    }

    fn page_mention_request(
        input: PageMentionRequestInput<'_>,
    ) -> ModuleApplyRequest<LibraryIntent> {
        ModuleApplyRequest {
            contract_version: LIBRARY_CONTRACT_VERSION,
            operation_id: input.operation_id.to_owned(),
            store_epoch: StoreEpoch("epoch-1".to_owned()),
            intent: LibraryIntent::CreatePageMention {
                page_id: input.new_page_id.to_owned(),
                document_id: input.new_document_id.to_owned(),
                title: "Plan".to_owned(),
                mention_host: LibraryPageMentionHost {
                    page_id: input.host.page_id.clone(),
                    document_id: input.host.document_id.clone(),
                    expected_document_generation: input.host.document_generation,
                    expected_document_head_seq: input.host_head_seq,
                    block_id: input.host.block_ids[0].clone(),
                    expected_content: input.expected_content,
                    replacement_content: vec![
                        json!({ "type": "pageMention", "targetPageId": input.new_page_id }),
                        json!({ "type": "text", "text": " ", "styles": {} }),
                    ],
                },
                destination: LibraryPageMentionDestination {
                    page_id: input.destination.page_id.clone(),
                    document_id: input.destination.document_id.clone(),
                    expected_document_generation: input.destination.document_generation,
                    expected_document_head_seq: input.destination_head_seq,
                    insertion: LibraryPageInsertion::Append {
                        parent_block_id: None,
                    },
                },
            },
        }
    }

    fn mention_test_block_rich_text(
        kernel: &SqliteStoreKernel,
        document_id: &str,
        block_id: &str,
    ) -> Vec<RichTextItem> {
        kernel
            .readers()
            .read_default(|connection| {
                let parent = load_parent_document(connection, document_id)?;
                let block =
                    find_materialized_block(&parent.base_materialization.block_tree, block_id)
                        .ok_or_else(|| corrupt("Page mention test Block is missing"))?;
                rich_text_from_materialized_inline(
                    block
                        .content
                        .as_ref()
                        .ok_or_else(|| corrupt("Page mention test Block has no content"))?,
                )
                .map(|value| value.rich_text)
                .map_err(|_| corrupt("Page mention test Block is not rich text"))
            })
            .expect("read Page mention test Block")
    }

    fn create_database_request(operation_id: &str) -> ModuleApplyRequest<LibraryIntent> {
        ModuleApplyRequest {
            contract_version: LIBRARY_CONTRACT_VERSION,
            operation_id: operation_id.to_owned(),
            store_epoch: StoreEpoch("epoch-1".to_owned()),
            intent: LibraryIntent::CreateDatabase {
                database_id: "018f0000-0000-7000-8000-000000000001".to_owned(),
                data_source_id: "018f0000-0000-7000-8000-000000000002".to_owned(),
                view_id: "018f0000-0000-7000-8000-000000000003".to_owned(),
                name: "Product work".to_owned(),
                parent: LibraryWriteParent::Library { before: None },
            },
        }
    }

    fn create_canvas_request(
        operation_id: &str,
        expected_document_head_seq: i64,
        replacement_block_id: &str,
    ) -> ModuleApplyRequest<LibraryIntent> {
        ModuleApplyRequest {
            contract_version: LIBRARY_CONTRACT_VERSION,
            operation_id: operation_id.to_owned(),
            store_epoch: StoreEpoch("epoch-1".to_owned()),
            intent: LibraryIntent::CreateCanvas {
                canvas_id: "018f0000-0000-7000-8000-000000000010".to_owned(),
                document_id: "018f0000-0000-7000-8000-000000000011".to_owned(),
                display_name: "Architecture sketch".to_owned(),
                destination: LibraryCanvasDestination::Page {
                    page_id: "page:created".to_owned(),
                    expected_document_generation: 1,
                    expected_document_head_seq,
                    insertion: LibraryPageInsertion::ReplaceEmptyParagraph {
                        block_id: replacement_block_id.to_owned(),
                    },
                },
            },
        }
    }

    fn prepare_move_etag(module: &LibraryModule, page_id: &str, view_id: Option<&str>) -> String {
        let prepared = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    read: LibraryRead::PageProjectionFile {
                        page_id: page_id.to_owned(),
                        file_kind: LibraryPageProjectionFileKind::MetaYaml,
                        prepare: Some(LibraryPagePrepareKind::PageMove {
                            view_id: view_id.map(str::to_owned),
                        }),
                    },
                },
            )
            .expect("prepare Page move");
        let LibraryReadValue::PageProjectionFile { value } = prepared.value else {
            panic!("Page move preparation")
        };
        value
            .validators
            .move_etag
            .expect("Page move preparation ETag")
    }

    type PageViewState = (
        String,
        String,
        String,
        i64,
        String,
        i64,
        Option<String>,
        String,
        i64,
    );

    fn read_page_view_state(kernel: &SqliteStoreKernel, page_id: &str) -> PageViewState {
        kernel
            .readers()
            .read_default(|connection| {
                connection
                    .query_row(
                        "SELECT page.parent_kind, page.parent_id, membership.id, \
                           membership.revision, value.value_json, value.revision, \
                           json_extract(value.value_json, '$'), position.rank_key, position.revision \
                         FROM pages page \
                         JOIN data_source_page_memberships membership \
                           ON membership.page_block_id = page.block_id \
                           AND membership.removed_at IS NULL \
                         JOIN data_source_property_values value \
                           ON value.data_source_id = membership.data_source_id \
                           AND value.membership_id = membership.id \
                           AND value.property_id = 'status' \
                         JOIN database_view_page_positions position \
                           ON position.view_id = ?1 \
                           AND position.page_block_id = page.block_id \
                         WHERE page.block_id = ?2",
                        params!["018f0000-0000-7000-8000-000000000003", page_id],
                        |row| {
                            Ok((
                                row.get::<_, String>(0)?,
                                row.get::<_, String>(1)?,
                                row.get::<_, String>(2)?,
                                row.get::<_, i64>(3)?,
                                row.get::<_, String>(4)?,
                                row.get::<_, i64>(5)?,
                                row.get::<_, Option<String>>(6)?,
                                row.get::<_, String>(7)?,
                                row.get::<_, i64>(8)?,
                            ))
                        },
                    )
                    .map_err(StoreError::from)
            })
            .expect("Page View authority state")
    }

    fn seeded_library() -> (tempfile::TempDir, SqliteStoreKernel, LibraryModule) {
        let directory = tempdir().expect("Profile");
        let home = directory.path().canonicalize().expect("absolute Profile");
        let kernel = SqliteStoreKernel::open_test(&home).expect("fresh store");
        kernel
            .writer()
            .call(|connection| {
                with_immediate_transaction(connection, |transaction| {
                    transaction.execute(
                        "INSERT INTO profiles(id, created_at, updated_at) VALUES ('profile-1', ?1, ?1)",
                        [NOW],
                    )?;
                    transaction.execute(
                        "INSERT INTO libraries(id, profile_id, created_at, updated_at) \
                         VALUES ('library-1', 'profile-1', ?1, ?1)",
                        [NOW],
                    )?;
                    transaction.execute(
                        "INSERT INTO projects(id, library_id, name, created, updated) \
                         VALUES ('project-1', 'library-1', 'Library writes', ?1, ?1)",
                        [NOW],
                    )?;
                    transaction.execute(
                        "INSERT INTO block_store_metadata(id, store_epoch, created_at, updated_at) \
                         VALUES (1, 'epoch-1', ?1, ?1)",
                        [NOW],
                    )?;
                    Ok(())
                })
            })
            .expect("seed Library identity");
        let module = LibraryModule::new("profile-1", "library-1", &kernel);
        (directory, kernel, module)
    }

    fn archive_actor_project(kernel: &SqliteStoreKernel) {
        kernel
            .writer()
            .call(|connection| {
                connection.execute(
                    "UPDATE projects SET lifecycle = 'archived' WHERE id = 'project-1'",
                    [],
                )?;
                Ok(())
            })
            .expect("archive actor Project");
    }

    #[test]
    fn trusted_library_authority_creates_root_resources_without_an_active_project() {
        let (_directory, kernel, module) = seeded_library();
        archive_actor_project(&kernel);

        let page = module
            .apply(
                &library_context(),
                create_request("operation:library-create-page", "Library Page"),
            )
            .expect("Library authority creates a Page");
        assert_eq!(
            page.committed.receipt.created_target,
            Some(LibraryResourceTarget::Page {
                page_id: "page:created".to_owned(),
            }),
        );

        let database = module
            .apply(
                &library_context(),
                create_database_request("operation:library-create-database"),
            )
            .expect("Library authority creates a Database");
        assert_eq!(
            database.committed.receipt.created_target,
            Some(LibraryResourceTarget::Database {
                database_id: "018f0000-0000-7000-8000-000000000001".to_owned(),
            }),
        );
    }

    #[test]
    fn untrusted_projectless_context_cannot_claim_library_authority() {
        let (_directory, _kernel, module) = seeded_library();
        for adapter in [AdapterKind::Agent, AdapterKind::LoopbackHttp] {
            let operation_id = format!("operation:untrusted-library-{adapter:?}");
            let mut context = library_context();
            context.adapter = adapter;
            let error = module
                .apply(&context, create_request(&operation_id, "Denied Page"))
                .expect_err("untrusted projectless context must fail closed");
            assert_eq!(error.code, CoreErrorCode::Unauthorized);
            assert_eq!(
                error.message,
                "Library mutations require a Project or trusted local Library authority",
            );
        }
    }

    #[test]
    fn trusted_library_authority_owns_the_complete_canvas_lifecycle() {
        let (_directory, kernel, module) = seeded_library();
        archive_actor_project(&kernel);
        let canvas_id = "018f0000-0000-7000-8000-000000000010";
        let duplicate_id = "018f0000-0000-7000-8000-000000000012";

        module
            .apply(
                &library_context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "operation:library-create-canvas".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::CreateCanvas {
                        canvas_id: canvas_id.to_owned(),
                        document_id: "018f0000-0000-7000-8000-000000000011".to_owned(),
                        display_name: "Library Canvas".to_owned(),
                        destination: LibraryCanvasDestination::Library { before: None },
                    },
                },
            )
            .expect("Library authority creates a Canvas");
        module
            .apply(
                &library_context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "operation:library-rename-canvas".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::RenameCanvas {
                        canvas_id: canvas_id.to_owned(),
                        display_name: "Renamed Canvas".to_owned(),
                        expected_metadata_revision: 1,
                    },
                },
            )
            .expect("Library authority renames a Canvas");
        module
            .apply(
                &library_context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "operation:library-duplicate-canvas".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::DuplicateCanvas {
                        source_canvas_id: canvas_id.to_owned(),
                        canvas_id: duplicate_id.to_owned(),
                        document_id: "018f0000-0000-7000-8000-000000000013".to_owned(),
                        display_name: None,
                        expected_document_generation: 1,
                        expected_document_head_seq: 0,
                        destination: LibraryCanvasDestination::Library { before: None },
                    },
                },
            )
            .expect("Library authority duplicates a Canvas");
        module
            .apply(
                &library_context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "operation:library-move-canvas".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::MoveCanvas {
                        canvas_id: canvas_id.to_owned(),
                        expected_location_revision: 1,
                        destination: LibraryCanvasDestination::Library { before: None },
                    },
                },
            )
            .expect("Library authority moves a Canvas");
        module
            .apply(
                &library_context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "operation:library-delete-canvas".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::DeleteCanvas {
                        canvas_id: canvas_id.to_owned(),
                        expected_location_revision: 2,
                        expected_metadata_revision: 2,
                        containing_document_head: None,
                    },
                },
            )
            .expect("Library authority deletes a Canvas");
    }

    #[test]
    fn trusted_library_authority_reorders_a_root_canvas_from_an_archived_actor_project() {
        let (_directory, kernel, module) = seeded_library();
        kernel
            .writer()
            .call(|connection| {
                connection.execute(
                    "INSERT INTO projects(id, library_id, name, created, updated) \
                     VALUES ('project-2', 'library-1', 'Second', \
                       '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z')",
                    [],
                )?;
                Ok(())
            })
            .expect("seed second actor Project");
        let mut project_context = context();
        project_context.project_id = Some(ProjectId("project-2".to_owned()));
        let canvas_id = "018f0000-0000-7000-8000-000000000020";
        module
            .apply(
                &project_context,
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "operation:second-project-canvas".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::CreateCanvas {
                        canvas_id: canvas_id.to_owned(),
                        document_id: "018f0000-0000-7000-8000-000000000021".to_owned(),
                        display_name: "Second Project Canvas".to_owned(),
                        destination: LibraryCanvasDestination::Library { before: None },
                    },
                },
            )
            .expect("Project creates a root Canvas");
        kernel
            .writer()
            .call(|connection| {
                connection.execute(
                    "UPDATE projects SET lifecycle = 'archived' WHERE id = 'project-2'",
                    [],
                )?;
                Ok(())
            })
            .expect("archive Canvas actor Project");

        module
            .apply(
                &library_context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "operation:reorder-second-project-canvas".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::MoveCanvas {
                        canvas_id: canvas_id.to_owned(),
                        expected_location_revision: 1,
                        destination: LibraryCanvasDestination::Library { before: None },
                    },
                },
            )
            .expect("Library authority reorders a Library-owned root Canvas");
    }

    #[test]
    fn creates_page_genesis_and_all_projections_once() {
        let (_directory, kernel, module) = seeded_library();

        let first = module
            .apply(
                &context(),
                create_request("operation:create-page", "Durable Page"),
            )
            .expect("create Page");
        let replay = module
            .apply(
                &context(),
                create_request("operation:create-page", "Durable Page"),
            )
            .expect("exact retry");
        let collision = module
            .apply(
                &context(),
                create_request("operation:create-page", "Different title"),
            )
            .expect_err("divergent retry");

        assert!(first.event.is_some());
        assert!(!first.committed.receipt.mutation.duplicate);
        assert!(replay.event.is_none());
        assert!(replay.committed.receipt.mutation.duplicate);
        assert_eq!(
            first.committed.event_sequence,
            replay.committed.event_sequence
        );
        assert_eq!(
            collision.code,
            nodex_core_contracts::CoreErrorCode::IdempotencyKeyReused
        );

        let children = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    read: LibraryRead::Children {
                        parent: LibraryNavigationParent::Library,
                        cursor: None,
                        limit: None,
                        force_include_target: None,
                    },
                },
            )
            .expect("read Library roots");
        let LibraryReadValue::Children { items, total, .. } = children.value else {
            panic!("children snapshot");
        };
        assert_eq!(total, 1);
        assert!(matches!(
            &items[0],
            nodex_core_contracts::library::LibraryNavigationNode::Page {
                page_id,
                title,
                document_head_seq: 1,
                ..
            } if page_id == "page:created" && title == "Durable Page"
        ));

        kernel
            .readers()
            .read_default(|connection| {
                let evidence = connection.query_row(
                    "SELECT document.head_seq, document.readiness, document.authority, \
                       materialization.title, projection.title, \
                       (SELECT count(*) FROM document_updates WHERE document_id = document.id), \
                       (SELECT count(*) FROM core_module_receipts \
                         WHERE module_name = 'library' AND operation_id = 'operation:create-page'), \
                       (SELECT count(*) FROM change_log \
                         WHERE operation_id = 'operation:create-page' AND kind = 'library.changed'), \
                       (SELECT count(*) FROM change_log \
                         WHERE kind = 'owned_document.document_initialized' \
                           AND document_ids_json = json_array(document.id)) \
                     FROM documents document \
                     JOIN document_materializations materialization \
                       ON materialization.document_id = document.id \
                     JOIN page_read_model projection ON projection.document_id = document.id \
                     WHERE document.id = 'document:created'",
                    [],
                    |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, String>(3)?,
                            row.get::<_, String>(4)?,
                            row.get::<_, i64>(5)?,
                            row.get::<_, i64>(6)?,
                            row.get::<_, i64>(7)?,
                            row.get::<_, i64>(8)?,
                        ))
                    },
                )?;
                assert_eq!(
                    evidence,
                    (
                        1,
                        "ready".to_owned(),
                        "ydoc_primary".to_owned(),
                        "Durable Page".to_owned(),
                        "Durable Page".to_owned(),
                        1,
                        1,
                        1,
                        0,
                    )
                );
                let intrinsic = connection.query_row(
                    "SELECT count(*), \
                       max(CASE WHEN property_key = 'run.target' THEN value_json END), \
                       json_extract(projection.intrinsic_properties_json, '$.\"run.target\"') \
                     FROM block_properties property \
                     JOIN page_read_model projection ON projection.page_block_id = property.block_id \
                     WHERE property.block_id = 'page:created'",
                    [],
                    |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                        ))
                    },
                )?;
                assert_eq!(
                    intrinsic,
                    (
                        9,
                        "\"localProject\"".to_owned(),
                        "localProject".to_owned(),
                    )
                );
                Ok(())
            })
            .expect("durable Page evidence");

        let database = module
            .apply(
                &context(),
                create_database_request("operation:create-database"),
            )
            .expect("create Database");
        let database_replay = module
            .apply(
                &context(),
                create_database_request("operation:create-database"),
            )
            .expect("retry Database");
        assert!(database.event.is_some());
        assert!(database_replay.event.is_none());
        assert!(database_replay.committed.receipt.mutation.duplicate);

        let views = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    read: LibraryRead::Children {
                        parent: LibraryNavigationParent::Database {
                            database_id: "018f0000-0000-7000-8000-000000000001".to_owned(),
                        },
                        cursor: None,
                        limit: None,
                        force_include_target: None,
                    },
                },
            )
            .expect("read Database Views");
        let LibraryReadValue::Children { items, total, .. } = views.value else {
            panic!("View children snapshot");
        };
        assert_eq!(total, 1);
        assert!(matches!(
            &items[0],
            nodex_core_contracts::library::LibraryNavigationNode::View {
                title,
                layout,
                is_default: true,
                ..
            } if title == "Board" && layout == "board"
        ));
        kernel
            .readers()
            .read_default(|connection| {
                let evidence = connection.query_row(
                    "SELECT container.name, container.default_view_id, source.schema_revision, \
                       view.revision, json_extract(view.config_json, '$.schemaVersion'), \
                       (SELECT count(*) FROM data_source_properties property \
                         WHERE property.data_source_id = source.id AND property.lifecycle = 'active'), \
                       (SELECT count(*) FROM core_module_receipts \
                         WHERE module_name = 'library' \
                           AND operation_id = 'operation:create-database'), \
                       (SELECT count(*) FROM change_log \
                         WHERE operation_id = 'operation:create-database' \
                           AND kind = 'library.changed') \
                     FROM database_containers container \
                     JOIN data_sources source ON source.home_database_block_id = container.block_id \
                     JOIN database_views view ON view.database_block_id = container.block_id \
                     WHERE container.block_id = '018f0000-0000-7000-8000-000000000001'",
                    [],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, i64>(2)?,
                            row.get::<_, i64>(3)?,
                            row.get::<_, i64>(4)?,
                            row.get::<_, i64>(5)?,
                            row.get::<_, i64>(6)?,
                            row.get::<_, i64>(7)?,
                        ))
                    },
                )?;
                assert_eq!(
                    evidence,
                    (
                        "Product work".to_owned(),
                        "018f0000-0000-7000-8000-000000000003".to_owned(),
                        1,
                        1,
                        5,
                        9,
                        1,
                        1,
                    )
                );
                Ok(())
            })
            .expect("durable Database evidence");

        let empty_paragraph_block_id = kernel
            .readers()
            .read_default(|connection| {
                connection
                    .query_row(
                        "SELECT block_id FROM document_block_index \
                         WHERE document_id = 'document:created' \
                         ORDER BY ordinal LIMIT 1",
                        [],
                        |row| row.get::<_, String>(0),
                    )
                    .map_err(StoreError::from)
            })
            .expect("initial empty paragraph");

        let nested_page = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "operation:create-nested-page".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::CreatePage {
                        page_id: "page:nested".to_owned(),
                        document_id: "document:nested".to_owned(),
                        title: "Nested Page".to_owned(),
                        parent: LibraryWriteParent::Page {
                            page_id: "page:created".to_owned(),
                            expected_document_generation: 1,
                            expected_document_head_seq: 1,
                            before: None,
                            insertion: Some(LibraryPageInsertion::ReplaceEmptyParagraph {
                                block_id: empty_paragraph_block_id.clone(),
                            }),
                        },
                    },
                },
            )
            .expect("create nested Page");
        assert_eq!(
            nested_page.committed.receipt.committed_revisions["documentHead:document:created"],
            2
        );
        let nested_database = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "operation:create-nested-database".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::CreateDatabase {
                        database_id: "018f0000-0000-7000-8000-000000000011".to_owned(),
                        data_source_id: "018f0000-0000-7000-8000-000000000012".to_owned(),
                        view_id: "018f0000-0000-7000-8000-000000000013".to_owned(),
                        name: "Nested work".to_owned(),
                        parent: LibraryWriteParent::Page {
                            page_id: "page:created".to_owned(),
                            expected_document_generation: 1,
                            expected_document_head_seq: 2,
                            before: None,
                            insertion: None,
                        },
                    },
                },
            )
            .expect("create nested Database");
        assert_eq!(
            nested_database.committed.receipt.committed_revisions["documentHead:document:created"],
            3
        );
        let nested_children = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    read: LibraryRead::Children {
                        parent: LibraryNavigationParent::Page {
                            page_id: "page:created".to_owned(),
                        },
                        cursor: None,
                        limit: None,
                        force_include_target: None,
                    },
                },
            )
            .expect("read nested resources");
        let LibraryReadValue::Children { items, total, .. } = nested_children.value else {
            panic!("nested children snapshot");
        };
        assert_eq!(total, 2);
        assert!(matches!(
            &items[0],
            nodex_core_contracts::library::LibraryNavigationNode::Page { page_id, .. }
                if page_id == "page:nested"
        ));
        assert!(matches!(
            &items[1],
            nodex_core_contracts::library::LibraryNavigationNode::Database { database_id, .. }
                if database_id == "018f0000-0000-7000-8000-000000000011"
        ));
        let stale = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "operation:stale-nested-page".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::CreatePage {
                        page_id: "page:must-rollback".to_owned(),
                        document_id: "document:must-rollback".to_owned(),
                        title: "Must roll back".to_owned(),
                        parent: LibraryWriteParent::Page {
                            page_id: "page:created".to_owned(),
                            expected_document_generation: 1,
                            expected_document_head_seq: 2,
                            before: None,
                            insertion: None,
                        },
                    },
                },
            )
            .expect_err("stale nested create");
        assert_eq!(
            stale.code,
            nodex_core_contracts::CoreErrorCode::HeadConflict
        );
        kernel
            .readers()
            .read_default(|connection| {
                let evidence = connection.query_row(
                    "SELECT parent.head_seq, parent_projection.document_projected_seq, \
                       nested_block.library_id, nested_block.placement_revision, \
                       nested_page.parent_kind, nested_page.parent_id, \
                       nested_projection.parent_kind, nested_projection.parent_id, \
                       database_block.library_id, database_block.placement_revision, \
                       (SELECT count(*) FROM document_block_index \
                         WHERE document_id = parent.id AND parent_block_id IS NULL \
                           AND block_id IN ('page:nested', \
                             '018f0000-0000-7000-8000-000000000011')), \
                       (SELECT count(*) FROM blocks WHERE id = 'page:must-rollback') \
                     FROM documents parent \
                     JOIN page_read_model parent_projection \
                       ON parent_projection.document_id = parent.id \
                     JOIN blocks nested_block ON nested_block.id = 'page:nested' \
                     JOIN pages nested_page ON nested_page.block_id = nested_block.id \
                     JOIN page_read_model nested_projection \
                       ON nested_projection.page_block_id = nested_block.id \
                     JOIN blocks database_block \
                       ON database_block.id = '018f0000-0000-7000-8000-000000000011' \
                     WHERE parent.id = 'document:created'",
                    [],
                    |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, i64>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, i64>(3)?,
                            row.get::<_, String>(4)?,
                            row.get::<_, String>(5)?,
                            row.get::<_, String>(6)?,
                            row.get::<_, String>(7)?,
                            row.get::<_, String>(8)?,
                            row.get::<_, i64>(9)?,
                            row.get::<_, i64>(10)?,
                            row.get::<_, i64>(11)?,
                        ))
                    },
                )?;
                assert_eq!(
                    evidence,
                    (
                        3,
                        3,
                        "library-1".to_owned(),
                        1,
                        "page".to_owned(),
                        "page:created".to_owned(),
                        "page".to_owned(),
                        "page:created".to_owned(),
                        "library-1".to_owned(),
                        1,
                        2,
                        0,
                    )
                );
                Ok(())
            })
            .expect("nested ownership evidence");

        let archive_page = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "operation:archive-nested-page".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::ArchiveResource {
                        target: LibraryResourceTarget::Page {
                            page_id: "page:nested".to_owned(),
                        },
                        expected_metadata_revision: 1,
                    },
                },
            )
            .expect("archive nested Page");
        assert_eq!(
            archive_page.committed.receipt.committed_revisions["blockMetadata:page:nested"],
            2
        );
        module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "operation:edit-parent-after-archive".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::CreateDatabase {
                        database_id: "018f0000-0000-7000-8000-000000000021".to_owned(),
                        data_source_id: "018f0000-0000-7000-8000-000000000022".to_owned(),
                        view_id: "018f0000-0000-7000-8000-000000000023".to_owned(),
                        name: "Archive fence".to_owned(),
                        parent: LibraryWriteParent::Page {
                            page_id: "page:created".to_owned(),
                            expected_document_generation: 1,
                            expected_document_head_seq: 3,
                            before: None,
                            insertion: None,
                        },
                    },
                },
            )
            .expect("edit parent after child archive");
        let archived_lifecycle = kernel
            .readers()
            .read_default(|connection| {
                connection
                    .query_row(
                        "SELECT lifecycle FROM blocks WHERE id = 'page:nested'",
                        [],
                        |row| row.get::<_, String>(0),
                    )
                    .map_err(StoreError::from)
            })
            .expect("archived lifecycle");
        assert_eq!(archived_lifecycle, "archived");
        module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "operation:restore-nested-page".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::RestoreResource {
                        target: LibraryResourceTarget::Page {
                            page_id: "page:nested".to_owned(),
                        },
                        expected_metadata_revision: 2,
                    },
                },
            )
            .expect("restore nested Page");

        for (operation_id, intent) in [
            (
                "operation:archive-database",
                LibraryIntent::ArchiveResource {
                    target: LibraryResourceTarget::Database {
                        database_id: "018f0000-0000-7000-8000-000000000001".to_owned(),
                    },
                    expected_metadata_revision: 1,
                },
            ),
            (
                "operation:restore-database",
                LibraryIntent::RestoreResource {
                    target: LibraryResourceTarget::Database {
                        database_id: "018f0000-0000-7000-8000-000000000001".to_owned(),
                    },
                    expected_metadata_revision: 2,
                },
            ),
        ] {
            let changed = module
                .apply(
                    &context(),
                    ModuleApplyRequest {
                        contract_version: LIBRARY_CONTRACT_VERSION,
                        operation_id: operation_id.to_owned(),
                        store_epoch: StoreEpoch("epoch-1".to_owned()),
                        intent,
                    },
                )
                .expect("Database lifecycle transition");
            if operation_id == "operation:restore-database" {
                let manifest = kernel
                    .readers()
                    .read_default(|connection| {
                        local_commit::read_manifest(connection, changed.committed.commit_seq)
                    })
                    .expect("restored Database CommitManifest");
                assert!(manifest.projection_effects.iter().any(|effect| {
                    matches!(
                        &effect.scope.scope,
                        LocalProjectionScope::PageDetailDatabase { database_id, .. }
                            if database_id == "018f0000-0000-7000-8000-000000000001"
                    )
                }));
                assert!(!manifest.projection_effects.iter().any(|effect| {
                    matches!(&effect.scope.scope, LocalProjectionScope::Project { .. })
                }));
            }
        }
        let first_grant = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "operation:grant-page".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::GrantProjectAccess {
                        project_id: "project-1".to_owned(),
                        target: LibraryResourceTarget::Page {
                            page_id: "page:nested".to_owned(),
                        },
                        access: LibraryAccess::Read,
                    },
                },
            )
            .expect("grant Page access");
        let before_redundant_grant = kernel
            .readers()
            .read_default(|connection| {
                Ok((
                    local_commit::head(connection)?,
                    connection.query_row("SELECT COUNT(*) FROM change_log", [], |row| {
                        row.get::<_, i64>(0)
                    })?,
                ))
            })
            .expect("read semantic heads before redundant grant");
        let already_granted = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "operation:grant-page-again".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::GrantProjectAccess {
                        project_id: "project-1".to_owned(),
                        target: LibraryResourceTarget::Page {
                            page_id: "page:nested".to_owned(),
                        },
                        access: LibraryAccess::Read,
                    },
                },
            )
            .expect("recognize existing grant");
        assert!(first_grant.committed.receipt.did_mutate);
        assert!(!already_granted.committed.receipt.did_mutate);
        assert!(already_granted.event.is_none());
        let after_redundant_grant = kernel
            .readers()
            .read_default(|connection| {
                Ok((
                    local_commit::head(connection)?,
                    connection.query_row("SELECT COUNT(*) FROM change_log", [], |row| {
                        row.get::<_, i64>(0)
                    })?,
                ))
            })
            .expect("read semantic heads after redundant grant");
        assert_eq!(after_redundant_grant, before_redundant_grant);
        let project_bound_access_read = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    read: LibraryRead::ResourceProjectAccess {
                        target: LibraryResourceTarget::Page {
                            page_id: "page:nested".to_owned(),
                        },
                    },
                },
            )
            .expect_err("Project-bound access matrix read");
        assert_eq!(project_bound_access_read.code, CoreErrorCode::Unauthorized);
        let project_bound_access_write = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "operation:project-bound-page-access".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::SetProjectAccess {
                        target: LibraryResourceTarget::Page {
                            page_id: "page:nested".to_owned(),
                        },
                        changes: vec![LibraryProjectAccessChange {
                            project_id: "project-1".to_owned(),
                            access: Some(LibraryAccess::ReadWrite),
                            expected_revision: Some(1),
                        }],
                    },
                },
            )
            .expect_err("Project-bound access matrix write");
        assert_eq!(project_bound_access_write.code, CoreErrorCode::Unauthorized);
        let access_snapshot = module
            .read(
                &library_context(),
                ModuleReadRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    read: LibraryRead::ResourceProjectAccess {
                        target: LibraryResourceTarget::Page {
                            page_id: "page:nested".to_owned(),
                        },
                    },
                },
            )
            .expect("read Project access matrix");
        let LibraryReadValue::ResourceProjectAccess { value } = access_snapshot.value else {
            panic!("Project access matrix snapshot");
        };
        assert_eq!(value.projects.len(), 1);
        assert_eq!(
            value.projects[0]
                .direct_grant
                .as_ref()
                .map(|grant| (grant.access, grant.revision)),
            Some((LibraryAccess::Read, 1)),
        );
        let upgraded_access = module
            .apply(
                &library_context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "operation:set-page-access".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::SetProjectAccess {
                        target: LibraryResourceTarget::Page {
                            page_id: "page:nested".to_owned(),
                        },
                        changes: vec![LibraryProjectAccessChange {
                            project_id: "project-1".to_owned(),
                            access: Some(LibraryAccess::ReadWrite),
                            expected_revision: Some(1),
                        }],
                    },
                },
            )
            .expect("upgrade direct Page access");
        assert_eq!(
            upgraded_access.committed.receipt.committed_revisions["projectGrant:project-1"],
            2,
        );
        let stale_revoke = module
            .apply(
                &library_context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "operation:stale-page-access".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::SetProjectAccess {
                        target: LibraryResourceTarget::Page {
                            page_id: "page:nested".to_owned(),
                        },
                        changes: vec![LibraryProjectAccessChange {
                            project_id: "project-1".to_owned(),
                            access: None,
                            expected_revision: Some(1),
                        }],
                    },
                },
            )
            .expect_err("stale direct Page access revoke");
        assert_eq!(stale_revoke.code, CoreErrorCode::RevisionConflict);
        kernel
            .writer()
            .call(|connection| {
                with_immediate_transaction(connection, |transaction| {
                    transaction.execute(
                        "UPDATE projects SET lifecycle = 'archived' WHERE id = 'project-1'",
                        [],
                    )?;
                    Ok(())
                })
            })
            .expect("archive Project for access management");
        let archived_upgrade = module
            .apply(
                &library_context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "operation:archived-page-access".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::SetProjectAccess {
                        target: LibraryResourceTarget::Page {
                            page_id: "page:nested".to_owned(),
                        },
                        changes: vec![LibraryProjectAccessChange {
                            project_id: "project-1".to_owned(),
                            access: Some(LibraryAccess::Read),
                            expected_revision: Some(2),
                        }],
                    },
                },
            )
            .expect_err("archived Project access change");
        assert_eq!(archived_upgrade.code, CoreErrorCode::Unauthorized);
        module
            .apply(
                &library_context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "operation:revoke-page-access".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::SetProjectAccess {
                        target: LibraryResourceTarget::Page {
                            page_id: "page:nested".to_owned(),
                        },
                        changes: vec![LibraryProjectAccessChange {
                            project_id: "project-1".to_owned(),
                            access: None,
                            expected_revision: Some(2),
                        }],
                    },
                },
            )
            .expect("revoke direct Page access");
        kernel
            .writer()
            .call(|connection| {
                with_immediate_transaction(connection, |transaction| {
                    transaction.execute(
                        "UPDATE projects SET lifecycle = 'active' WHERE id = 'project-1'",
                        [],
                    )?;
                    Ok(())
                })
            })
            .expect("restore Project after access management");
        module
            .apply(
                &library_context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "operation:grant-parent-page-access".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::SetProjectAccess {
                        target: LibraryResourceTarget::Page {
                            page_id: "page:created".to_owned(),
                        },
                        changes: vec![LibraryProjectAccessChange {
                            project_id: "project-1".to_owned(),
                            access: Some(LibraryAccess::Read),
                            expected_revision: Some(1),
                        }],
                    },
                },
            )
            .expect("grant parent Page access");
        let embedded_database_access = module
            .read(
                &library_context(),
                ModuleReadRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    read: LibraryRead::ResourceProjectAccess {
                        target: LibraryResourceTarget::Database {
                            database_id: "018f0000-0000-7000-8000-000000000011".to_owned(),
                        },
                    },
                },
            )
            .expect("read embedded Database access");
        let LibraryReadValue::ResourceProjectAccess { value } = embedded_database_access.value
        else {
            panic!("embedded Database Project access snapshot");
        };
        assert!(matches!(
            value.projects[0].inherited_sources.as_slice(),
            [nodex_core_contracts::library::LibraryInheritedProjectAccessSource::AncestorPage {
                page_id,
                access: LibraryAccess::Read,
                ..
            }] if page_id == "page:created"
        ));
        module
            .apply(
                &library_context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "operation:revoke-parent-page-access".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::SetProjectAccess {
                        target: LibraryResourceTarget::Page {
                            page_id: "page:created".to_owned(),
                        },
                        changes: vec![LibraryProjectAccessChange {
                            project_id: "project-1".to_owned(),
                            access: None,
                            expected_revision: Some(2),
                        }],
                    },
                },
            )
            .expect("revoke parent Page access");
        kernel
            .writer()
            .call(|connection| {
                with_immediate_transaction(connection, |transaction| {
                    transaction.execute(
                        "INSERT INTO projects(id, library_id, name, created, updated) \
                         VALUES ('project-2', 'library-1', 'Rollback target', ?1, ?1)",
                        [NOW],
                    )?;
                    Ok(())
                })
            })
            .expect("seed second Project for atomic access update");
        let partial_batch = module
            .apply(
                &library_context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "operation:atomic-page-access".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::SetProjectAccess {
                        target: LibraryResourceTarget::Page {
                            page_id: "page:nested".to_owned(),
                        },
                        changes: vec![
                            LibraryProjectAccessChange {
                                project_id: "project-1".to_owned(),
                                access: Some(LibraryAccess::Read),
                                expected_revision: None,
                            },
                            LibraryProjectAccessChange {
                                project_id: "project-2".to_owned(),
                                access: Some(LibraryAccess::Read),
                                expected_revision: Some(999),
                            },
                        ],
                    },
                },
            )
            .expect_err("conflicting Project access batch");
        assert_eq!(partial_batch.code, CoreErrorCode::RevisionConflict);
        let rolled_back_grant = kernel
            .readers()
            .read_default(|connection| {
                connection
                    .query_row(
                        "SELECT lifecycle, revision FROM project_resource_grants \
                         WHERE project_id = 'project-1' AND root_kind = 'page' \
                           AND root_id = 'page:nested'",
                        [],
                        |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
                    )
                    .map_err(StoreError::from)
            })
            .expect("rolled-back direct Page grant");
        assert_eq!(rolled_back_grant, ("revoked".to_owned(), 3));
        kernel
            .writer()
            .call(|connection| {
                with_immediate_transaction(connection, |transaction| {
                    transaction.execute(
                        "UPDATE projects SET database_block_id = ?1 WHERE id = 'project-1'",
                        ["018f0000-0000-7000-8000-000000000001"],
                    )?;
                    Ok(())
                })
            })
            .expect("bind primary Database");
        let primary_access_snapshot = module
            .read(
                &library_context(),
                ModuleReadRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    read: LibraryRead::ResourceProjectAccess {
                        target: LibraryResourceTarget::Database {
                            database_id: "018f0000-0000-7000-8000-000000000001".to_owned(),
                        },
                    },
                },
            )
            .expect("read primary Database access");
        let LibraryReadValue::ResourceProjectAccess { value } = primary_access_snapshot.value
        else {
            panic!("primary Database Project access snapshot");
        };
        assert_eq!(
            value.projects[0]
                .direct_grant
                .as_ref()
                .map(|grant| (grant.access, grant.revision)),
            Some((LibraryAccess::ReadWrite, 1)),
        );
        assert_eq!(
            value.projects[0].effective_access,
            Some(LibraryAccess::ReadWrite)
        );
        assert!(matches!(
            value.projects[0].inherited_sources.as_slice(),
            [nodex_core_contracts::library::LibraryInheritedProjectAccessSource::PrimaryDatabase {
                database_id,
                ..
            }] if database_id == "018f0000-0000-7000-8000-000000000001"
        ));
        let primary_grant = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "operation:grant-primary".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::GrantProjectAccess {
                        project_id: "project-1".to_owned(),
                        target: LibraryResourceTarget::Database {
                            database_id: "018f0000-0000-7000-8000-000000000001".to_owned(),
                        },
                        access: LibraryAccess::ReadWrite,
                    },
                },
            )
            .expect("primary Database already authorizes Project");
        assert!(!primary_grant.committed.receipt.did_mutate);
        let protected_archive = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "operation:archive-primary".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::ArchiveResource {
                        target: LibraryResourceTarget::Database {
                            database_id: "018f0000-0000-7000-8000-000000000001".to_owned(),
                        },
                        expected_metadata_revision: 3,
                    },
                },
            )
            .expect_err("primary Database cannot archive");
        assert_eq!(
            protected_archive.code,
            nodex_core_contracts::CoreErrorCode::Conflict
        );

        module
            .apply(
                &library_context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "operation:restore-parent-page-access".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::SetProjectAccess {
                        target: LibraryResourceTarget::Page {
                            page_id: "page:created".to_owned(),
                        },
                        changes: vec![LibraryProjectAccessChange {
                            project_id: "project-1".to_owned(),
                            access: Some(LibraryAccess::ReadWrite),
                            expected_revision: None,
                        }],
                    },
                },
            )
            .expect("restore parent Page access before moving into it");

        let move_to_library = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "operation:move-page-to-library".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::MoveBlock {
                        target: LibraryResourceTarget::Page {
                            page_id: "page:nested".to_owned(),
                        },
                        expected_location_revision: 1,
                        parent: LibraryWriteParent::Library {
                            before: Some(nodex_core_contracts::library::LibraryPlacementAnchor {
                                block_id: "018f0000-0000-7000-8000-000000000001".to_owned(),
                                expected_location_revision: 1,
                            }),
                        },
                    },
                },
            )
            .expect("move nested Page to Library");
        assert_eq!(
            move_to_library.committed.receipt.committed_revisions["documentHead:document:created"],
            5
        );
        module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "operation:move-page-back".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::MoveBlock {
                        target: LibraryResourceTarget::Page {
                            page_id: "page:nested".to_owned(),
                        },
                        expected_location_revision: 2,
                        parent: LibraryWriteParent::Page {
                            page_id: "page:created".to_owned(),
                            expected_document_generation: 1,
                            expected_document_head_seq: 5,
                            before: None,
                            insertion: None,
                        },
                    },
                },
            )
            .expect("move Page back into parent");
        module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "operation:reorder-page".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::MoveBlock {
                        target: LibraryResourceTarget::Page {
                            page_id: "page:nested".to_owned(),
                        },
                        expected_location_revision: 3,
                        parent: LibraryWriteParent::Page {
                            page_id: "page:created".to_owned(),
                            expected_document_generation: 1,
                            expected_document_head_seq: 6,
                            before: Some(nodex_core_contracts::library::LibraryPlacementAnchor {
                                block_id: "018f0000-0000-7000-8000-000000000011".to_owned(),
                                expected_location_revision: 1,
                            }),
                            insertion: None,
                        },
                    },
                },
            )
            .expect("reorder Page within parent");
        module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "operation:create-other-page".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::CreatePage {
                        page_id: "page:other".to_owned(),
                        document_id: "document:other".to_owned(),
                        title: "Other parent".to_owned(),
                        parent: LibraryWriteParent::Library { before: None },
                    },
                },
            )
            .expect("create other parent Page");
        let cross_document = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "operation:move-database-across-pages".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::MoveBlock {
                        target: LibraryResourceTarget::Database {
                            database_id: "018f0000-0000-7000-8000-000000000011".to_owned(),
                        },
                        expected_location_revision: 1,
                        parent: LibraryWriteParent::Page {
                            page_id: "page:other".to_owned(),
                            expected_document_generation: 1,
                            expected_document_head_seq: 1,
                            before: None,
                            insertion: None,
                        },
                    },
                },
            )
            .expect("move Database across Page Documents");
        assert_eq!(
            cross_document.committed.receipt.committed_revisions["documentHead:document:created"],
            8
        );
        assert_eq!(
            cross_document.committed.receipt.committed_revisions["documentHead:document:other"],
            2
        );
        let hierarchy_cycle = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "operation:reject-page-cycle".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::MoveBlock {
                        target: LibraryResourceTarget::Page {
                            page_id: "page:created".to_owned(),
                        },
                        expected_location_revision: 1,
                        parent: LibraryWriteParent::Page {
                            page_id: "page:nested".to_owned(),
                            expected_document_generation: 1,
                            expected_document_head_seq: 1,
                            before: None,
                            insertion: None,
                        },
                    },
                },
            )
            .expect_err("reject Page hierarchy cycle");
        assert_eq!(
            hierarchy_cycle.code,
            nodex_core_contracts::CoreErrorCode::InvalidInput
        );
        kernel
            .readers()
            .read_default(|connection| {
                let evidence = connection.query_row(
                    "SELECT moved_page.library_id, moved_page.placement_revision, \
                       (SELECT document_id FROM document_block_index \
                         WHERE block_id = moved_page.id), \
                       page.parent_kind, page.parent_id, projection.placement_revision, \
                       projection.parent_kind, \
                       projection.parent_id, moved_database.library_id, \
                       moved_database.placement_revision, \
                       (SELECT document_id FROM document_block_index \
                         WHERE block_id = moved_database.id), \
                       (SELECT ordinal FROM document_block_index \
                         WHERE document_id = 'document:created' AND block_id = 'page:nested') \
                     FROM blocks moved_page \
                     JOIN pages page ON page.block_id = moved_page.id \
                     JOIN page_read_model projection ON projection.page_block_id = moved_page.id \
                     JOIN blocks moved_database \
                       ON moved_database.id = '018f0000-0000-7000-8000-000000000011' \
                     WHERE moved_page.id = 'page:nested'",
                    [],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, i64>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, String>(3)?,
                            row.get::<_, String>(4)?,
                            row.get::<_, i64>(5)?,
                            row.get::<_, String>(6)?,
                            row.get::<_, String>(7)?,
                            row.get::<_, String>(8)?,
                            row.get::<_, i64>(9)?,
                            row.get::<_, String>(10)?,
                            row.get::<_, i64>(11)?,
                        ))
                    },
                )?;
                assert_eq!(
                    evidence,
                    (
                        "library-1".to_owned(),
                        4,
                        "document:created".to_owned(),
                        "page".to_owned(),
                        "page:created".to_owned(),
                        4,
                        "page".to_owned(),
                        "page:created".to_owned(),
                        "library-1".to_owned(),
                        2,
                        "document:other".to_owned(),
                        0,
                    )
                );
                let document_membership = connection.query_row(
                    "SELECT \
                       (SELECT count(*) FROM document_block_index \
                         WHERE document_id = 'document:created' \
                           AND block_id = '018f0000-0000-7000-8000-000000000011'), \
                       (SELECT count(*) FROM document_block_index \
                         WHERE document_id = 'document:other' \
                           AND block_id = '018f0000-0000-7000-8000-000000000011')",
                    [],
                    |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
                )?;
                assert_eq!(document_membership, (0, 1));
                Ok(())
            })
            .expect("move ownership evidence");

        let nested_page_etag = kernel
            .readers()
            .read_default(|connection| {
                crate::library::page_projection::mint_page_shell_etag(
                    connection,
                    "library-1",
                    "project-1",
                    "epoch-1",
                    "page:nested",
                )
            })
            .expect("nested Page shell ETag");
        let nested_delete = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "native-cli:delete-nested-page".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::DeletePage {
                        page_id: "page:nested".to_owned(),
                        expected_etag: nested_page_etag,
                    },
                },
            )
            .expect("headless typed deletion resolves the nested host head");
        assert_eq!(
            nested_delete.committed.receipt.committed_revisions["documentHead:document:created"],
            9
        );
        assert_eq!(
            nested_delete
                .committed
                .value
                .page_lifecycle
                .as_ref()
                .expect("nested Page lifecycle receipt")
                .lifecycle,
            LibraryPageLifecycleState::Deleted
        );
    }

    #[test]
    fn seals_project_access_revocation_as_immutable_commit_evidence() {
        let (_directory, kernel, module) = seeded_library();
        module
            .apply(
                &context(),
                create_request("operation:create-revocation-page", "Shared Page"),
            )
            .expect("create shared Page");
        kernel
            .writer()
            .call(|connection| {
                with_immediate_transaction(connection, |transaction| {
                    transaction.execute(
                        "INSERT INTO projects(id, library_id, name, created, updated)
                         VALUES ('project-2', 'library-1', 'Reader', ?1, ?1)",
                        [NOW],
                    )?;
                    Ok(())
                })
            })
            .expect("seed reader Project");
        let granted = module
            .apply(
                &library_context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "operation:grant-reader-page".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::SetProjectAccess {
                        target: LibraryResourceTarget::Page {
                            page_id: "page:created".to_owned(),
                        },
                        changes: vec![LibraryProjectAccessChange {
                            project_id: "project-2".to_owned(),
                            access: Some(LibraryAccess::Read),
                            expected_revision: None,
                        }],
                    },
                },
            )
            .expect("grant reader access");
        let revoked = module
            .apply(
                &library_context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "operation:revoke-reader-page".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::SetProjectAccess {
                        target: LibraryResourceTarget::Page {
                            page_id: "page:created".to_owned(),
                        },
                        changes: vec![LibraryProjectAccessChange {
                            project_id: "project-2".to_owned(),
                            access: None,
                            expected_revision: Some(1),
                        }],
                    },
                },
            )
            .expect("revoke reader access");
        let manifest = kernel
            .readers()
            .read_default(|connection| {
                local_commit::read_manifest(connection, revoked.committed.receipt.commit_seq)
            })
            .expect("read revocation Manifest");
        kernel
            .readers()
            .read_default(|connection| {
                let grant_delta_count: i64 = connection.query_row(
                    "SELECT count(*) FROM local_commit_visibility_deltas
                     WHERE commit_seq = ?1 AND delta_kind = 'grant'
                       AND authorization_scope_json LIKE '%project-2%'
                       AND roots_json LIKE '%page:created%'",
                    [granted.committed.receipt.commit_seq],
                    |row| row.get(0),
                )?;
                let revoke_delta_count: i64 = connection.query_row(
                    "SELECT count(*) FROM local_commit_visibility_deltas
                     WHERE commit_seq = ?1 AND delta_kind = 'revoke'
                       AND authorization_scope_json LIKE '%project-2%'
                       AND roots_json LIKE '%page:created%'",
                    [revoked.committed.receipt.commit_seq],
                    |row| row.get(0),
                )?;
                let dirty_fact_counts: (i64, i64) = connection.query_row(
                    "SELECT
                       (SELECT count(*) FROM local_commit_visibility_dirty_facts
                        WHERE commit_seq = ?1 AND consumed = 1),
                       (SELECT count(*) FROM local_commit_visibility_dirty_facts
                        WHERE commit_seq = ?2 AND consumed = 1)",
                    params![
                        granted.committed.receipt.commit_seq,
                        revoked.committed.receipt.commit_seq,
                    ],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )?;
                assert!(grant_delta_count >= 1);
                assert!(revoke_delta_count >= 1);
                assert_eq!(dirty_fact_counts, (1, 1));
                Ok(())
            })
            .expect("read exact grant/revoke visibility deltas");

        assert!(manifest.revocations.iter().any(|revocation| {
            revocation.resource_kind == RevokedResourceKind::Page
                && revocation.resource_id == "page:created"
                && revocation.reason == ResourceRevocationReason::AccessRevoked
                && matches!(
                    &revocation.authorization_scope,
                    nodex_core_contracts::events::DeliveryAuthorizationScope::Project {
                        project_id,
                        ..
                    } if project_id == "project-2"
                )
        }));
        assert!(manifest.revocations.iter().any(|revocation| {
            revocation.resource_kind == RevokedResourceKind::Document
                && revocation.reason == ResourceRevocationReason::AccessRevoked
                && matches!(
                    &revocation.authorization_scope,
                    nodex_core_contracts::events::DeliveryAuthorizationScope::Project {
                        project_id,
                        ..
                    } if project_id == "project-2"
                )
        }));
        assert!(manifest.revocations.iter().any(|revocation| {
            revocation.resource_kind == RevokedResourceKind::Document
                && revocation.reason == ResourceRevocationReason::AccessRevoked
                && matches!(
                    &revocation.authorization_scope,
                    nodex_core_contracts::events::DeliveryAuthorizationScope::Document {
                        project_id: Some(project_id),
                        ..
                    } if project_id == "project-2"
                )
        }));
        assert!(!manifest.revocations.iter().any(|revocation| matches!(
            revocation.authorization_scope,
            nodex_core_contracts::events::DeliveryAuthorizationScope::Library { .. }
        )));
    }

    #[test]
    fn canvas_lifecycle_is_atomic_with_its_host_page_shell() {
        let (_directory, kernel, module) = seeded_library();
        module
            .apply(
                &context(),
                create_request("operation:create-page-for-canvas", "Canvas host"),
            )
            .expect("create Canvas host Page");
        let (empty_block_id, page_head_seq) = kernel
            .readers()
            .read_default(|connection| {
                connection
                    .query_row(
                        "SELECT index_row.block_id, document.head_seq \
                     FROM pages page \
                     JOIN documents document ON document.id = page.document_id \
                     JOIN document_block_index index_row \
                       ON index_row.document_id = page.document_id \
                     WHERE page.block_id = 'page:created' \
                       AND index_row.block_type = 'paragraph'",
                        [],
                        |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
                    )
                    .map_err(StoreError::from)
            })
            .expect("empty Page paragraph");

        let created = module
            .apply(
                &context(),
                create_canvas_request("operation:create-canvas", page_head_seq, &empty_block_id),
            )
            .expect("create nested Canvas");
        let created_result = created
            .committed
            .value
            .canvas_mutation
            .as_ref()
            .expect("Canvas mutation result");
        assert_eq!(created_result.operation_kind, "create_canvas");
        assert_eq!(created_result.document_commits.len(), 1);
        let host_document_id = created_result.document_commits[0].document_id.clone();

        kernel
            .readers()
            .read_default(|connection| {
                let evidence = connection.query_row(
                    "SELECT block.type, containing.document_id, ownership.document_id, \
                            document.sync_engine, \
                            (SELECT count(*) FROM canvas_owners WHERE block_id = block.id), \
                            (SELECT count(*) FROM canvas_scenes \
                              WHERE document_id = ownership.document_id), \
                            (SELECT count(*) FROM document_block_index \
                              WHERE document_id = containing.document_id \
                                AND block_id = block.id AND block_type = 'canvas'), \
                            (SELECT count(*) FROM document_block_index \
                              WHERE document_id = containing.document_id \
                                AND block_id = ?1) \
                     FROM blocks block \
                     JOIN block_documents ownership ON ownership.block_id = block.id \
                       AND ownership.library_id = block.library_id \
                     JOIN documents document ON document.id = ownership.document_id \
                       AND document.library_id = ownership.library_id \
                     LEFT JOIN document_block_index containing ON containing.block_id = block.id \
                     WHERE block.id = '018f0000-0000-7000-8000-000000000010'",
                    [&empty_block_id],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, Option<String>>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, String>(3)?,
                            row.get::<_, i64>(4)?,
                            row.get::<_, i64>(5)?,
                            row.get::<_, i64>(6)?,
                            row.get::<_, i64>(7)?,
                        ))
                    },
                )?;
                assert_eq!(evidence.0, "canvas");
                assert_eq!(evidence.2, "018f0000-0000-7000-8000-000000000011");
                assert_eq!(evidence.3, "canvas_scene");
                assert_eq!(
                    (evidence.4, evidence.5, evidence.6, evidence.7),
                    (1, 1, 1, 0)
                );
                assert!(evidence.1.is_some());
                let replaced_paragraph = connection.query_row(
                    "SELECT block.lifecycle, block.placement_revision, block.metadata_revision, \
                            tombstone.document_id, tombstone.document_generation, \
                            tombstone.deletion_head_seq, tombstone.placement_revision \
                     FROM blocks block \
                     JOIN document_block_tombstones tombstone ON tombstone.block_id = block.id \
                     WHERE block.id = ?1",
                    [&empty_block_id],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, i64>(1)?,
                            row.get::<_, i64>(2)?,
                            row.get::<_, String>(3)?,
                            row.get::<_, i64>(4)?,
                            row.get::<_, i64>(5)?,
                            row.get::<_, i64>(6)?,
                        ))
                    },
                )?;
                assert_eq!(replaced_paragraph.0, "deleted");
                assert_eq!((replaced_paragraph.1, replaced_paragraph.2), (2, 2));
                assert_eq!(replaced_paragraph.3, host_document_id);
                assert_eq!(
                    (
                        replaced_paragraph.4,
                        replaced_paragraph.5,
                        replaced_paragraph.6,
                    ),
                    (1, page_head_seq + 1, 2),
                );
                Ok(())
            })
            .expect("Canvas authority evidence");

        let guard_host_document_id = host_document_id.clone();
        kernel
            .writer()
            .call(move |connection| {
                with_immediate_transaction(connection, |transaction| {
                    let parent = load_parent_document(transaction, &guard_host_document_id)?;
                    let request_hash = sha256(b"guard-setup");
                    let commit = local_commit::begin(
                        transaction,
                        "epoch-1",
                        "operation:add-guard-paragraph",
                        &request_hash,
                        "2026-08-07T00:00:00Z",
                    )?;
                    persist_parent_operations(
                        transaction,
                        ParentDocumentWriteContext {
                            actor_project_id: "project-1",
                            store_epoch: "epoch-1",
                            operation_id: "operation:add-guard-paragraph",
                            commit: &commit,
                        },
                        "guard-setup",
                        &parent,
                        &[DocumentBlockOperation::InsertBlock {
                            block: MaterializedBlockNode {
                                id: "018f0000-0000-7000-8000-000000000020".to_owned(),
                                block_type: "paragraph".to_owned(),
                                props: BTreeMap::from([
                                    ("backgroundColor".to_owned(), json!("default")),
                                    ("textColor".to_owned(), json!("default")),
                                    ("textAlignment".to_owned(), json!("left")),
                                ]),
                                content: Some(json!([])),
                                children: Vec::new(),
                            },
                            parent_block_id: None,
                            before_block_id: None,
                        }],
                    )?;
                    insert_module_receipt(
                        transaction,
                        NewModuleReceipt {
                            module_name: "owned_document",
                            operation_id: "operation:add-guard-paragraph",
                            context: &context(),
                            operation_kind: "test_setup",
                            store_epoch: "epoch-1",
                            request_hash: &request_hash,
                            result: &json!({}),
                            event_sequence: None,
                            local_commit: Some(&commit),
                            committed_at: "2026-08-07T00:00:00Z",
                        },
                    )?;
                    local_commit::finalize(transaction, &commit)?;
                    Ok(())
                })
            })
            .expect("add editable sibling for guard test");

        let ordinary_delete_document_id = host_document_id.clone();
        let ordinary_delete = kernel
            .writer()
            .call(move |connection| {
                with_immediate_transaction(connection, |transaction| {
                    let parent = load_parent_document(transaction, &ordinary_delete_document_id)?;
                    let commit = local_commit::begin(
                        transaction,
                        "epoch-1",
                        "operation:ordinary-canvas-delete",
                        &sha256(b"ordinary-canvas-delete"),
                        "2026-08-07T00:00:00Z",
                    )?;
                    persist_parent_operations(
                        transaction,
                        ParentDocumentWriteContext {
                            actor_project_id: "project-1",
                            store_epoch: "epoch-1",
                            operation_id: "operation:ordinary-canvas-delete",
                            commit: &commit,
                        },
                        "guard",
                        &parent,
                        &[DocumentBlockOperation::DeleteBlock {
                            block_id: "018f0000-0000-7000-8000-000000000010".to_owned(),
                        }],
                    )
                })
            })
            .expect_err("ordinary Document update cannot delete Canvas owner");
        assert_eq!(ordinary_delete.code, StoreErrorCode::ProtectedOwnerDeletion);
        assert!(
            ordinary_delete
                .message
                .contains("cannot be removed by a generic Document update"),
            "{}",
            ordinary_delete.message,
        );

        let renamed = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "operation:rename-canvas".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::RenameCanvas {
                        canvas_id: "018f0000-0000-7000-8000-000000000010".to_owned(),
                        display_name: "System map".to_owned(),
                        expected_metadata_revision: 1,
                    },
                },
            )
            .expect("rename Canvas");
        assert_eq!(
            renamed
                .committed
                .value
                .canvas_mutation
                .as_ref()
                .expect("rename result")
                .metadata_revision,
            2
        );
        assert_eq!(
            renamed.committed.receipt.affected_page_ids,
            vec!["page:created".to_owned()]
        );

        let duplicated = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "operation:duplicate-canvas".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::DuplicateCanvas {
                        source_canvas_id: "018f0000-0000-7000-8000-000000000010".to_owned(),
                        canvas_id: "018f0000-0000-7000-8000-000000000012".to_owned(),
                        document_id: "018f0000-0000-7000-8000-000000000013".to_owned(),
                        display_name: None,
                        expected_document_generation: 1,
                        expected_document_head_seq: 0,
                        destination: LibraryCanvasDestination::Library { before: None },
                    },
                },
            )
            .expect("duplicate Canvas");
        let duplicate_result = duplicated
            .committed
            .value
            .canvas_mutation
            .as_ref()
            .expect("duplicate result");
        assert_eq!(
            duplicate_result.source_canvas_id.as_deref(),
            Some("018f0000-0000-7000-8000-000000000010")
        );
        assert_ne!(
            duplicate_result.document_id,
            "018f0000-0000-7000-8000-000000000011"
        );
        kernel
            .readers()
            .read_default(|connection| {
                let active_grant = connection.query_row(
                    "SELECT count(*) FROM project_resource_grants \
                     WHERE project_id = 'project-1' AND root_kind = 'canvas' \
                       AND root_id = '018f0000-0000-7000-8000-000000000012' \
                       AND access = 'read_write' AND lifecycle = 'active'",
                    [],
                    |row| row.get::<_, i64>(0),
                )?;
                assert_eq!(active_grant, 1);
                Ok(())
            })
            .expect("created Canvas grants its Project explicit access");
        let access_snapshot = module
            .read(
                &library_context(),
                ModuleReadRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    read: LibraryRead::ResourceProjectAccess {
                        target: LibraryResourceTarget::Canvas {
                            canvas_id: "018f0000-0000-7000-8000-000000000012".to_owned(),
                        },
                    },
                },
            )
            .expect("read top-level Canvas Project access");
        let LibraryReadValue::ResourceProjectAccess { value } = access_snapshot.value else {
            panic!("Canvas access snapshot");
        };
        let project_access = value
            .projects
            .iter()
            .find(|project| project.project_id == "project-1")
            .expect("creator Project access");
        assert_eq!(
            project_access
                .direct_grant
                .as_ref()
                .map(|grant| grant.access),
            Some(LibraryAccess::ReadWrite),
        );

        let host_head_seq = kernel
            .readers()
            .read_default(|connection| {
                connection
                    .query_row(
                        "SELECT document.head_seq FROM pages page \
                         JOIN documents document ON document.id = page.document_id \
                         WHERE page.block_id = 'page:created'",
                        [],
                        |row| row.get::<_, i64>(0),
                    )
                    .map_err(StoreError::from)
            })
            .expect("current Canvas host head");
        let moved = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "operation:move-canvas".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::MoveCanvas {
                        canvas_id: "018f0000-0000-7000-8000-000000000012".to_owned(),
                        expected_location_revision: 1,
                        destination: LibraryCanvasDestination::Page {
                            page_id: "page:created".to_owned(),
                            expected_document_generation: 1,
                            expected_document_head_seq: host_head_seq,
                            insertion: LibraryPageInsertion::Append {
                                parent_block_id: None,
                            },
                        },
                    },
                },
            )
            .expect("move Canvas into Page");
        let move_result = moved
            .committed
            .value
            .canvas_mutation
            .as_ref()
            .expect("move result");
        assert_eq!(move_result.location_revision, 2);
        assert_eq!(
            move_result.document_id,
            "018f0000-0000-7000-8000-000000000013"
        );
        kernel
            .readers()
            .read_default(|connection| {
                let evidence = connection.query_row(
                    "SELECT containing.document_id, ownership.document_id, \
                            (SELECT count(*) FROM document_block_index \
                              WHERE block_id = block.id), \
                            (SELECT count(*) FROM library_block_placements \
                              WHERE block_id = block.id) \
                     FROM blocks block \
                     JOIN block_documents ownership ON ownership.block_id = block.id \
                       AND ownership.library_id = block.library_id \
                     LEFT JOIN document_block_index containing ON containing.block_id = block.id \
                     WHERE block.id = '018f0000-0000-7000-8000-000000000012'",
                    [],
                    |row| {
                        Ok((
                            row.get::<_, Option<String>>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, i64>(2)?,
                            row.get::<_, i64>(3)?,
                        ))
                    },
                )?;
                assert!(evidence.0.is_some());
                assert_eq!(evidence.1, "018f0000-0000-7000-8000-000000000013");
                assert_eq!((evidence.2, evidence.3), (1, 0));
                let grant = connection.query_row(
                    "SELECT lifecycle, revision FROM project_resource_grants \
                     WHERE project_id = 'project-1' AND root_kind = 'canvas' \
                       AND root_id = '018f0000-0000-7000-8000-000000000012'",
                    [],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
                )?;
                assert_eq!(grant, ("revoked".to_owned(), 2));
                Ok(())
            })
            .expect("moved Canvas identity evidence");
        let embedded_access = module
            .read(
                &library_context(),
                ModuleReadRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    read: LibraryRead::ResourceProjectAccess {
                        target: LibraryResourceTarget::Canvas {
                            canvas_id: "018f0000-0000-7000-8000-000000000012".to_owned(),
                        },
                    },
                },
            )
            .expect("read embedded Canvas Project access");
        let LibraryReadValue::ResourceProjectAccess { value } = embedded_access.value else {
            panic!("embedded Canvas access snapshot");
        };
        let project_access = value
            .projects
            .iter()
            .find(|project| project.project_id == "project-1")
            .expect("host Page Project access");
        assert!(project_access.direct_grant.is_none());
        assert!(
            project_access
                .inherited_sources
                .iter()
                .any(|source| matches!(
                    source,
                    LibraryInheritedProjectAccessSource::AncestorPage { page_id, .. }
                        if page_id == "page:created"
                ))
        );

        let target = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    read: LibraryRead::CanvasTarget {
                        canvas_id: "018f0000-0000-7000-8000-000000000010".to_owned(),
                    },
                },
            )
            .expect("read Canvas target");
        let LibraryReadValue::CanvasTarget { value } = target.value else {
            panic!("Canvas target snapshot");
        };
        assert!(matches!(
            value.as_ref(),
            nodex_core_contracts::library::LibraryCanvasTarget::Available { summary }
                if summary.title == "System map"
                    && summary.canvas_id == "018f0000-0000-7000-8000-000000000010"
        ));

        let children = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    read: LibraryRead::Children {
                        parent: LibraryNavigationParent::Page {
                            page_id: "page:created".to_owned(),
                        },
                        cursor: None,
                        limit: None,
                        force_include_target: None,
                    },
                },
            )
            .expect("read Canvas host children");
        let LibraryReadValue::Children { items, .. } = children.value else {
            panic!("Canvas child navigation");
        };
        assert_eq!(
            items
                .iter()
                .filter(|item| matches!(
                    item,
                    nodex_core_contracts::library::LibraryNavigationNode::Canvas { .. }
                ))
                .count(),
            2
        );

        let detached = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "operation:detach-canvas".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::MoveCanvas {
                        canvas_id: "018f0000-0000-7000-8000-000000000012".to_owned(),
                        expected_location_revision: 2,
                        destination: LibraryCanvasDestination::Library { before: None },
                    },
                },
            )
            .expect("move Canvas back to the Library");
        assert_eq!(
            detached
                .committed
                .value
                .canvas_mutation
                .as_ref()
                .expect("detach result")
                .location_revision,
            3,
        );
        kernel
            .readers()
            .read_default(|connection| {
                let evidence = connection.query_row(
                    "SELECT grant_row.lifecycle, grant_row.revision, \
                       EXISTS(SELECT 1 FROM library_block_placements placement \
                         WHERE placement.block_id = grant_row.root_id), \
                       EXISTS(SELECT 1 FROM document_block_index containing \
                         WHERE containing.block_id = grant_row.root_id) \
                     FROM project_resource_grants grant_row \
                     WHERE grant_row.project_id = 'project-1' \
                       AND grant_row.root_kind = 'canvas' \
                       AND grant_row.root_id = '018f0000-0000-7000-8000-000000000012'",
                    [],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, i64>(1)?,
                            row.get::<_, i64>(2)?,
                            row.get::<_, i64>(3)?,
                        ))
                    },
                )?;
                assert_eq!(evidence, ("active".to_owned(), 3, 1, 0));
                Ok(())
            })
            .expect("detached Canvas restores explicit Project access");

        let document_module = OwnedDocumentModule::new("profile-1", "library-1", &kernel);
        let scene_advanced = document_module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    operation_id: "operation:advance-canvas-before-delete".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: OwnedDocumentIntent::ApplyCanvasMutation {
                        document_id: "018f0000-0000-7000-8000-000000000011".to_owned(),
                        generation: 1,
                        expected_head_seq: 0,
                        mutation: json!({
                            "elementCandidates": [],
                            "appStateIntents": {
                                "gridSize": {
                                    "expected": { "kind": "absent" },
                                    "value": { "kind": "value", "value": 20 }
                                }
                            },
                            "fileAdditions": {}
                        }),
                    },
                },
            )
            .expect("advance Canvas content before deletion");
        assert_eq!(scene_advanced.committed.value.head_seq, 1);

        let containing_document_head = kernel
            .readers()
            .read_default(|connection| {
                connection
                    .query_row(
                        "SELECT generation, head_seq FROM documents WHERE id = ?1",
                        [&host_document_id],
                        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
                    )
                    .map_err(StoreError::from)
            })
            .expect("current Canvas host Document head");

        let deleted = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "operation:delete-canvas".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::DeleteCanvas {
                        canvas_id: "018f0000-0000-7000-8000-000000000010".to_owned(),
                        expected_location_revision: 1,
                        expected_metadata_revision: 2,
                        containing_document_head: Some(LibraryDocumentHead {
                            document_id: host_document_id.clone(),
                            generation: containing_document_head.0,
                            head_seq: containing_document_head.1,
                        }),
                    },
                },
            )
            .expect("delete Canvas");
        assert_eq!(
            deleted
                .committed
                .value
                .canvas_mutation
                .as_ref()
                .expect("delete result")
                .operation_kind,
            "delete_canvas"
        );
        assert_eq!(
            deleted.committed.receipt.affected_page_ids,
            vec!["page:created".to_owned()]
        );
        assert_eq!(
            deleted
                .committed
                .receipt
                .committed_revisions
                .get("documentHead:018f0000-0000-7000-8000-000000000011"),
            Some(&1)
        );
        kernel
            .readers()
            .read_default(|connection| {
                let evidence = connection.query_row(
                    "SELECT block.lifecycle, \
                       (SELECT count(*) FROM document_block_index \
                         WHERE block_id = block.id), \
                       (SELECT count(*) FROM canvas_scenes scene \
                         JOIN block_documents ownership ON ownership.document_id = scene.document_id \
                         WHERE ownership.block_id = block.id) \
                     FROM blocks block \
                     WHERE block.id = '018f0000-0000-7000-8000-000000000010'",
                    [],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, i64>(1)?,
                            row.get::<_, i64>(2)?,
                        ))
                    },
                )?;
                assert_eq!(evidence, ("deleted".to_owned(), 0, 1));
                Ok(())
            })
            .expect("Canvas tombstone evidence");
        let deleted_target = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    read: LibraryRead::CanvasTarget {
                        canvas_id: "018f0000-0000-7000-8000-000000000010".to_owned(),
                    },
                },
            )
            .expect("read deleted Canvas target");
        assert!(matches!(
            deleted_target.value,
            LibraryReadValue::CanvasTarget { value }
                if matches!(
                    value.as_ref(),
                    nodex_core_contracts::library::LibraryCanvasTarget::Deleted { .. }
                )
        ));
    }

    #[test]
    fn semantic_page_creation_owns_identity_content_etags_and_replay() {
        let (_directory, _kernel, module) = seeded_library();
        let request = |body: &str| ModuleApplyRequest {
            contract_version: LIBRARY_CONTRACT_VERSION,
            operation_id: "native-cli:create-page".to_owned(),
            store_epoch: StoreEpoch("epoch-1".to_owned()),
            intent: LibraryIntent::CreatePageFromNfm {
                title_markdown: "Native **Page**".to_owned(),
                nfm: body.to_owned(),
                destination: LibraryPageWriteDestination::Library { at: None },
            },
        };
        let first = module
            .apply(&context(), request("## Runtime\n\nCore starts on demand."))
            .expect("semantic Page create");
        let created = first
            .committed
            .value
            .page_create
            .clone()
            .expect("exact Page creation result");
        assert_eq!(created.document_generation, 1);
        assert_eq!(created.document_head_seq, 1);
        assert_eq!(created.page_key, None);
        assert_eq!(&created.page_id[14..15], "7");
        assert_eq!(&created.document_id[14..15], "7");
        assert_eq!(created.block_ids.len(), 2);
        assert!(created.title_etag.starts_with("nxe1."));
        assert!(created.body_etag.starts_with("nxe1."));

        let mut retry_context = context();
        retry_context.connection_id = "connection:native-cli-create-retry".to_owned();
        let replay = module
            .apply(
                &retry_context,
                request("## Runtime\n\nCore starts on demand."),
            )
            .expect("exact semantic Page replay");
        assert!(replay.committed.receipt.mutation.duplicate);
        assert_eq!(replay.committed.value.page_create, Some(created.clone()));
        let collision = module
            .apply(&context(), request("Changed body"))
            .expect_err("same key cannot change semantic Page content");
        assert_eq!(
            collision.code,
            nodex_core_contracts::CoreErrorCode::IdempotencyKeyReused
        );

        let body = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    read: LibraryRead::PageProjectionFile {
                        page_id: created.page_id.clone(),
                        file_kind: LibraryPageProjectionFileKind::BodyNestedMarkdown,
                        prepare: None,
                    },
                },
            )
            .expect("read created Page body");
        let LibraryReadValue::PageProjectionFile { value: body } = body.value else {
            panic!("Page body projection")
        };
        assert_eq!(body.content, "## Runtime\nCore starts on demand.\n");
        let metadata = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    read: LibraryRead::PageProjectionFile {
                        page_id: created.page_id.clone(),
                        file_kind: LibraryPageProjectionFileKind::MetaYaml,
                        prepare: None,
                    },
                },
            )
            .expect("read created Page metadata");
        let LibraryReadValue::PageProjectionFile { value: metadata } = metadata.value else {
            panic!("Page metadata projection")
        };
        assert_eq!(
            metadata.metadata.expect("typed metadata").title_markdown,
            "Native **Page**"
        );
        let draft = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    read: LibraryRead::PageDraftProjection {
                        page_id: created.page_id.clone(),
                    },
                },
            )
            .expect("read atomic Page draft projection");
        let LibraryReadValue::PageDraftProjection { value: draft } = draft.value else {
            panic!("Page draft projection")
        };
        assert_eq!(draft.page_id, created.page_id);
        assert_eq!(draft.document_id, created.document_id);
        assert_eq!(draft.document_head_seq, created.document_head_seq);
        assert_eq!(draft.body_nested_markdown, body.content);
        assert!(draft.meta_yaml.contains("title: \"Native **Page**\""));
        assert_eq!(draft.title_etag, created.title_etag);
        assert_eq!(draft.body_etag, created.body_etag);
    }

    #[test]
    fn page_mention_creation_is_atomic_idempotent_and_reversible() {
        const HOST_PAGE: &str = "018f0000-0000-7000-8000-000000000101";
        const HOST_DOCUMENT: &str = "018f0000-0000-7000-8000-000000000102";
        const CREATED_PAGE: &str = "018f0000-0000-7000-8000-000000000103";
        const CREATED_DOCUMENT: &str = "018f0000-0000-7000-8000-000000000104";
        let (_directory, kernel, module) = seeded_library();
        let host =
            create_mention_test_page(&module, "mention:create-host", HOST_PAGE, HOST_DOCUMENT);
        let expected_content = vec![json!({
            "type": "text",
            "text": "+plan",
            "styles": {},
        })];
        let host_head = set_mention_test_content(
            &kernel,
            &host,
            json!([{ "type": "text", "text": "+plan", "styles": {} }]),
            "mention:type-query",
        );
        let request = page_mention_request(PageMentionRequestInput {
            operation_id: "mention:create",
            new_page_id: CREATED_PAGE,
            new_document_id: CREATED_DOCUMENT,
            host: &host,
            host_head_seq: host_head,
            destination: &host,
            destination_head_seq: host_head,
            expected_content: expected_content.clone(),
        });
        let created = module
            .apply(&context(), request.clone())
            .expect("atomically create Page mention");
        let structural = created
            .committed
            .value
            .structural_edit
            .clone()
            .expect("Page mention structural result");
        let undo_token = structural.history.clone().expect("Page mention undo token");
        assert_eq!(structural.document_commits.len(), 1);
        assert_eq!(
            created.committed.receipt.created_target,
            Some(LibraryResourceTarget::Page {
                page_id: CREATED_PAGE.to_owned(),
            })
        );
        assert_eq!(
            mention_test_block_rich_text(&kernel, HOST_DOCUMENT, &host.block_ids[0]),
            vec![
                RichTextItem::PageMention {
                    target_page_id: CREATED_PAGE.to_owned(),
                },
                RichTextItem::Text {
                    text: " ".to_owned(),
                    styles: RichTextStyles::default(),
                },
            ],
        );
        kernel
            .readers()
            .read_default(|connection| {
                let evidence = connection.query_row(
                    "SELECT block.lifecycle, page.parent_kind, page.parent_id, \
                       EXISTS(SELECT 1 FROM document_block_index \
                         WHERE document_id = ?2 AND block_id = ?1), \
                       EXISTS(SELECT 1 FROM document_page_references \
                         WHERE document_id = ?2 AND source_block_id = ?3 AND target_page_id = ?1) \
                     FROM blocks block JOIN pages page ON page.block_id = block.id \
                     WHERE block.id = ?1",
                    params![CREATED_PAGE, HOST_DOCUMENT, host.block_ids[0]],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, i64>(3)?,
                            row.get::<_, i64>(4)?,
                        ))
                    },
                )?;
                assert_eq!(
                    evidence,
                    (
                        "active".to_owned(),
                        "page".to_owned(),
                        HOST_PAGE.to_owned(),
                        1,
                        1,
                    )
                );
                Ok(())
            })
            .expect("atomic Page mention evidence");

        let replay = module
            .apply(&context(), request)
            .expect("replay Page mention creation");
        assert!(replay.committed.receipt.mutation.duplicate);

        let undone = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "mention:undo".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::ReverseStructuralEdit { token: undo_token },
                },
            )
            .expect("undo Page mention creation");
        assert_eq!(
            mention_test_block_rich_text(&kernel, HOST_DOCUMENT, &host.block_ids[0]),
            vec![RichTextItem::Text {
                text: "+plan".to_owned(),
                styles: RichTextStyles::default(),
            }],
        );
        kernel
            .readers()
            .read_default(|connection| {
                assert_eq!(
                    connection.query_row(
                        "SELECT lifecycle FROM blocks WHERE id = ?1",
                        [CREATED_PAGE],
                        |row| row.get::<_, String>(0),
                    )?,
                    "deleted"
                );
                assert_eq!(
                    connection.query_row(
                        "SELECT count(*) FROM document_page_references WHERE target_page_id = ?1",
                        [CREATED_PAGE],
                        |row| row.get::<_, i64>(0),
                    )?,
                    0
                );
                Ok(())
            })
            .expect("Page mention undo evidence");

        let redo_token = undone
            .committed
            .value
            .structural_edit
            .expect("undo structural result")
            .history
            .expect("Page mention redo token");
        module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "mention:redo".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::ReverseStructuralEdit { token: redo_token },
                },
            )
            .expect("redo Page mention creation");
        assert!(matches!(
            mention_test_block_rich_text(&kernel, HOST_DOCUMENT, &host.block_ids[0]).as_slice(),
            [RichTextItem::PageMention { target_page_id }, RichTextItem::Text { text, .. }]
                if target_page_id == CREATED_PAGE && text == " "
        ));
        kernel
            .readers()
            .read_default(|connection| {
                assert_eq!(
                    connection.query_row(
                        "SELECT lifecycle FROM blocks WHERE id = ?1",
                        [CREATED_PAGE],
                        |row| row.get::<_, String>(0),
                    )?,
                    "active"
                );
                crate::infrastructure::store_validation::validate_store_semantics(connection)?;
                Ok(())
            })
            .expect("Page mention redo evidence");
    }

    #[test]
    fn page_mention_creation_supports_distinct_destination_and_rolls_back_conflicts() {
        const HOST_PAGE: &str = "018f0000-0000-7000-8000-000000000111";
        const HOST_DOCUMENT: &str = "018f0000-0000-7000-8000-000000000112";
        const DESTINATION_PAGE: &str = "018f0000-0000-7000-8000-000000000113";
        const DESTINATION_DOCUMENT: &str = "018f0000-0000-7000-8000-000000000114";
        const CREATED_PAGE: &str = "018f0000-0000-7000-8000-000000000115";
        const CREATED_DOCUMENT: &str = "018f0000-0000-7000-8000-000000000116";
        let (_directory, kernel, module) = seeded_library();
        let host =
            create_mention_test_page(&module, "mention:distinct-host", HOST_PAGE, HOST_DOCUMENT);
        let destination = create_mention_test_page(
            &module,
            "mention:distinct-destination",
            DESTINATION_PAGE,
            DESTINATION_DOCUMENT,
        );
        let host_head = set_mention_test_content(
            &kernel,
            &host,
            json!([{ "type": "text", "text": "[[plan", "styles": {} }]),
            "mention:distinct-query",
        );
        let request = page_mention_request(PageMentionRequestInput {
            operation_id: "mention:distinct-create",
            new_page_id: CREATED_PAGE,
            new_document_id: CREATED_DOCUMENT,
            host: &host,
            host_head_seq: host_head,
            destination: &destination,
            destination_head_seq: destination.document_head_seq,
            expected_content: vec![json!({ "type": "text", "text": "[[plan", "styles": {} })],
        });
        let created = module
            .apply(&context(), request)
            .expect("create mention in a distinct destination");
        let distinct_structural = created
            .committed
            .value
            .structural_edit
            .as_ref()
            .expect("distinct structural result");
        assert_eq!(distinct_structural.document_commits.len(), 2);
        let distinct_undo_token = distinct_structural
            .history
            .clone()
            .expect("distinct Page mention undo token");
        kernel
            .readers()
            .read_default(|connection| {
                assert_eq!(
                    connection.query_row(
                        "SELECT parent_id FROM pages WHERE block_id = ?1",
                        [CREATED_PAGE],
                        |row| row.get::<_, String>(0),
                    )?,
                    DESTINATION_PAGE
                );
                assert_eq!(
                    connection.query_row(
                        "SELECT count(*) FROM document_block_index \
                         WHERE document_id = ?1 AND block_id = ?2",
                        params![DESTINATION_DOCUMENT, CREATED_PAGE],
                        |row| row.get::<_, i64>(0),
                    )?,
                    1
                );
                Ok(())
            })
            .expect("distinct Page mention evidence");

        const FAILED_PAGE: &str = "018f0000-0000-7000-8000-000000000117";
        const FAILED_DOCUMENT: &str = "018f0000-0000-7000-8000-000000000118";
        let failed = page_mention_request(PageMentionRequestInput {
            operation_id: "mention:conflict",
            new_page_id: FAILED_PAGE,
            new_document_id: FAILED_DOCUMENT,
            host: &host,
            host_head_seq: host_head + 1,
            destination: &destination,
            destination_head_seq: destination.document_head_seq + 1,
            expected_content: vec![json!({ "type": "text", "text": "+stale", "styles": {} })],
        });
        let error = module
            .apply(&context(), failed)
            .expect_err("mismatched expected content must fail");
        assert_eq!(error.code, CoreErrorCode::HeadConflict);
        kernel
            .readers()
            .read_default(|connection| {
                assert_eq!(
                    connection.query_row(
                        "SELECT count(*) FROM blocks WHERE id = ?1",
                        [FAILED_PAGE],
                        |row| row.get::<_, i64>(0),
                    )?,
                    0
                );
                assert_eq!(
                    connection.query_row(
                        "SELECT count(*) FROM documents WHERE id = ?1",
                        [FAILED_DOCUMENT],
                        |row| row.get::<_, i64>(0),
                    )?,
                    0
                );
                Ok(())
            })
            .expect("conflicted Page mention leaves no orphan");

        let undone = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "mention:distinct-undo".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::ReverseStructuralEdit {
                        token: distinct_undo_token,
                    },
                },
            )
            .expect("undo distinct Page mention creation");
        assert_eq!(
            mention_test_block_rich_text(&kernel, HOST_DOCUMENT, &host.block_ids[0]),
            vec![RichTextItem::Text {
                text: "[[plan".to_owned(),
                styles: RichTextStyles::default(),
            }]
        );
        kernel
            .readers()
            .read_default(|connection| {
                assert_eq!(
                    connection.query_row(
                        "SELECT lifecycle FROM blocks WHERE id = ?1",
                        [CREATED_PAGE],
                        |row| row.get::<_, String>(0),
                    )?,
                    "deleted"
                );
                assert_eq!(
                    connection.query_row(
                        "SELECT count(*) FROM document_block_index \
                         WHERE document_id = ?1 AND block_id = ?2",
                        params![DESTINATION_DOCUMENT, CREATED_PAGE],
                        |row| row.get::<_, i64>(0),
                    )?,
                    0
                );
                Ok(())
            })
            .expect("distinct Page mention undo evidence");

        let redo_token = undone
            .committed
            .value
            .structural_edit
            .expect("distinct undo structural result")
            .history
            .expect("distinct Page mention redo token");
        module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "mention:distinct-redo".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::ReverseStructuralEdit { token: redo_token },
                },
            )
            .expect("redo distinct Page mention creation");
        assert!(matches!(
            mention_test_block_rich_text(&kernel, HOST_DOCUMENT, &host.block_ids[0]).as_slice(),
            [RichTextItem::PageMention { target_page_id }, RichTextItem::Text { text, .. }]
                if target_page_id == CREATED_PAGE && text == " "
        ));
        kernel
            .readers()
            .read_default(|connection| {
                assert_eq!(
                    connection.query_row(
                        "SELECT lifecycle FROM blocks WHERE id = ?1",
                        [CREATED_PAGE],
                        |row| row.get::<_, String>(0),
                    )?,
                    "active"
                );
                crate::infrastructure::store_validation::validate_store_semantics(connection)?;
                Ok(())
            })
            .expect("distinct Page mention redo evidence");
    }

    #[test]
    fn semantic_page_creation_places_a_complete_page_in_a_data_source_atomically() {
        let (_directory, kernel, module) = seeded_library();
        kernel
            .writer()
            .call(|connection| {
                with_immediate_transaction(connection, |transaction| {
                    transaction.execute(
                        "INSERT INTO projects(id, library_id, name, created, updated) \
                         VALUES ('project-storage', 'library-1', 'Database storage', ?1, ?1)",
                        [NOW],
                    )?;
                    Ok(())
                })
            })
            .expect("seed destination access Project");
        let mut storage_context = context();
        storage_context.project_id = Some(ProjectId("project-storage".to_owned()));
        storage_context.connection_id = "connection:database-storage".to_owned();
        module
            .apply(
                &storage_context,
                create_database_request("native-cli:create-database-for-page"),
            )
            .expect("create Data Source destination");
        kernel
            .writer()
            .call(|connection| {
                with_immediate_transaction(connection, |transaction| {
                    crate::database::create_page_key_namespace(
                        transaction,
                        "library-1",
                        "018f0000-0000-7000-8000-000000000001",
                        Some("LAB"),
                        "Product work",
                        "2026-07-01T00:00:00.000Z",
                    )?;
                    Ok(())
                })
            })
            .expect("create Page-key namespace for Data Source destination");
        module
            .apply(
                &storage_context,
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "native-cli:grant-database-for-page".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::GrantProjectAccess {
                        project_id: "project-1".to_owned(),
                        target: LibraryResourceTarget::Database {
                            database_id: "018f0000-0000-7000-8000-000000000001".to_owned(),
                        },
                        access: LibraryAccess::ReadWrite,
                    },
                },
            )
            .expect("grant Data Source destination");
        let request = |body: &str| ModuleApplyRequest {
            contract_version: LIBRARY_CONTRACT_VERSION,
            operation_id: "native-cli:create-data-source-page".to_owned(),
            store_epoch: StoreEpoch("epoch-1".to_owned()),
            intent: LibraryIntent::CreatePageFromNfm {
                title_markdown: "Database **Page**".to_owned(),
                nfm: body.to_owned(),
                destination: LibraryPageWriteDestination::DataSource {
                    data_source_id: "018f0000-0000-7000-8000-000000000002".to_owned(),
                    view_id: None,
                    group: None,
                    at: None,
                },
            },
        };
        let first = module
            .apply(&context(), request("## Work\n\nNative placement."))
            .expect("create Page in Data Source");
        let created = first
            .committed
            .value
            .page_create
            .clone()
            .expect("exact Page creation result");
        assert_eq!(created.document_generation, 1);
        assert_eq!(created.document_head_seq, 1);
        assert_eq!(created.page_key.as_deref(), Some("LAB-1"));
        assert_eq!(created.block_ids.len(), 2);
        assert_eq!(
            first.committed.receipt.affected_database_ids,
            vec!["018f0000-0000-7000-8000-000000000001"]
        );
        assert_eq!(
            first.committed.receipt.affected_view_ids,
            vec!["018f0000-0000-7000-8000-000000000003"]
        );
        assert_eq!(
            first.committed.receipt.committed_revisions
                [&format!("blockLocation:{}", created.page_id)],
            2
        );
        assert_eq!(
            first.committed.receipt.committed_revisions[&format!("pageParent:{}", created.page_id)],
            2
        );

        let page_projection_file = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    read: LibraryRead::PageProjectionFile {
                        page_id: created.page_id.clone(),
                        file_kind: LibraryPageProjectionFileKind::MetaYaml,
                        prepare: None,
                    },
                },
            )
            .expect("read keyed Page metadata");
        let LibraryReadValue::PageProjectionFile {
            value: page_projection_file,
        } = page_projection_file.value
        else {
            panic!("Page file projection")
        };
        assert_eq!(page_projection_file.version, 2);
        assert_eq!(page_projection_file.page_key.as_deref(), Some("LAB-1"));
        assert_eq!(
            page_projection_file
                .metadata
                .as_ref()
                .and_then(|metadata| metadata.page_key.as_deref()),
            Some("LAB-1")
        );
        assert!(
            page_projection_file
                .content
                .contains("page_key: \"LAB-1\"\n")
        );

        let evidence = kernel
            .readers()
            .read_default(|connection| {
                connection
                    .query_row(
                        "SELECT block.library_id, block.placement_revision, \
                           block.metadata_revision, page.parent_kind, page.parent_id, \
                           membership.revision, projection.parent_kind, \
                           projection.parent_id, projection.view_group_key, \
                           EXISTS(SELECT 1 FROM library_block_placements library \
                             WHERE library.block_id = block.id), document.library_id \
                         FROM blocks block JOIN pages page ON page.block_id = block.id \
                         JOIN documents document ON document.id = page.document_id \
                         JOIN data_source_page_memberships membership \
                           ON membership.page_block_id = block.id AND membership.removed_at IS NULL \
                         JOIN page_read_model projection ON projection.page_block_id = block.id \
                         WHERE block.id = ?1",
                        [&created.page_id],
                        |row| {
                            Ok((
                                row.get::<_, String>(0)?,
                                row.get::<_, i64>(1)?,
                                row.get::<_, i64>(2)?,
                                row.get::<_, String>(3)?,
                                row.get::<_, String>(4)?,
                                row.get::<_, i64>(5)?,
                                row.get::<_, String>(6)?,
                                row.get::<_, String>(7)?,
                                row.get::<_, Option<String>>(8)?,
                                row.get::<_, i64>(9)?,
                                row.get::<_, String>(10)?,
                            ))
                        },
                    )
                    .map_err(StoreError::from)
            })
            .expect("atomic Data Source placement evidence");
        assert_eq!(
            evidence,
            (
                "library-1".to_owned(),
                2,
                3,
                "data_source".to_owned(),
                "018f0000-0000-7000-8000-000000000002".to_owned(),
                1,
                "data_source".to_owned(),
                "018f0000-0000-7000-8000-000000000002".to_owned(),
                Some("triage".to_owned()),
                0,
                "library-1".to_owned(),
            )
        );

        let mut retry_context = context();
        retry_context.connection_id = "connection:native-cli-data-source-retry".to_owned();
        let replay = module
            .apply(&retry_context, request("## Work\n\nNative placement."))
            .expect("exact Data Source Page replay");
        assert!(replay.committed.receipt.mutation.duplicate);
        assert!(replay.event.is_none());
        assert_eq!(replay.committed.value.page_create, Some(created));
        let collision = module
            .apply(&context(), request("Changed body"))
            .expect_err("same key cannot change Data Source Page content");
        assert_eq!(
            collision.code,
            nodex_core_contracts::CoreErrorCode::IdempotencyKeyReused
        );
    }

    #[test]
    fn search_snapshot_leases_are_immutable_scoped_and_idempotently_released() {
        let (directory, kernel, module) = seeded_library();
        let created = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "native-cli:create-search-page".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::CreatePageFromNfm {
                        title_markdown: "Search **Page**".to_owned(),
                        nfm: "## Runtime\n\nCore starts on demand.".to_owned(),
                        destination: LibraryPageWriteDestination::Library { at: None },
                    },
                },
            )
            .expect("create searchable Page")
            .committed
            .value
            .page_create
            .expect("created Page result");
        let acquired = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    read: LibraryRead::AcquireSearchSnapshot {
                        scope: LibrarySearchSnapshotScope::Page {
                            page_id: created.page_id.clone(),
                        },
                        strict_materialization: true,
                    },
                },
            )
            .expect("acquire search snapshot");
        let LibraryReadValue::SearchSnapshotLease { value: lease } = acquired.value else {
            panic!("search snapshot lease")
        };
        assert_eq!(lease.manifest.pages.len(), 1);
        let page = &lease.manifest.pages[0];
        assert_eq!(page.page_id, created.page_id);
        assert!(page.body.logical_path.contains(&created.page_id));
        assert_eq!(
            page.body.sha256,
            crate::document::sha256(b"## Runtime\nCore starts on demand.\n")
        );
        let root = std::path::Path::new(&lease.physical_root);
        for file in [&page.meta, &page.body] {
            let path = root.join(&file.physical_relative_path);
            assert_eq!(
                std::fs::metadata(&path)
                    .expect("snapshot file")
                    .permissions()
                    .mode()
                    & 0o777,
                0o400
            );
        }
        assert_eq!(
            std::fs::metadata(root.join("manifest.json"))
                .expect("manifest commit marker")
                .permissions()
                .mode()
                & 0o777,
            0o400
        );
        let body_cache = directory
            .path()
            .join("search-snapshots/cache/v1/body")
            .join(&page.body.sha256);
        assert!(body_cache.is_file());
        assert_eq!(
            std::fs::metadata(root.join(&page.body.physical_relative_path))
                .expect("leased body metadata")
                .ino(),
            std::fs::metadata(&body_cache)
                .expect("cached body metadata")
                .ino(),
            "unchanged projections must use immutable hard links",
        );

        kernel
            .writer()
            .call({
                let document_id = created.document_id.clone();
                let stale_projected_seq = created.document_head_seq + 1;
                move |connection| {
                    connection.execute(
                        "UPDATE document_materializations SET projected_seq = ?1 WHERE document_id = ?2",
                        rusqlite::params![stale_projected_seq, document_id],
                    )?;
                    Ok(())
                }
            })
            .expect("make materialization stale");
        module
            .search_snapshot_lease_registry()
            .expect("search snapshot registry")
            .invalidate_prepared();
        let stale = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    read: LibraryRead::AcquireSearchSnapshot {
                        scope: LibrarySearchSnapshotScope::Page {
                            page_id: created.page_id.clone(),
                        },
                        strict_materialization: true,
                    },
                },
            )
            .expect_err("strict snapshots reject stale materialization");
        assert_eq!(
            stale.code,
            nodex_core_contracts::CoreErrorCode::MaterializationStale
        );
        let partial = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    read: LibraryRead::AcquireSearchSnapshot {
                        scope: LibrarySearchSnapshotScope::Page {
                            page_id: created.page_id.clone(),
                        },
                        strict_materialization: false,
                    },
                },
            )
            .expect("non-strict snapshots report and skip stale materialization");
        let LibraryReadValue::SearchSnapshotLease {
            value: partial_lease,
        } = partial.value
        else {
            panic!("partial search snapshot lease")
        };
        assert!(partial_lease.manifest.pages.is_empty());
        assert_eq!(
            partial_lease.manifest.warnings,
            vec![
                nodex_core_contracts::library::LibrarySearchSnapshotWarning::MaterializationStale {
                    page_id: created.page_id.clone(),
                },
            ]
        );
        kernel
            .writer()
            .call({
                let document_id = created.document_id.clone();
                let projected_seq = created.document_head_seq;
                move |connection| {
                    connection.execute(
                        "UPDATE document_materializations SET projected_seq = ?1 WHERE document_id = ?2",
                        rusqlite::params![projected_seq, document_id],
                    )?;
                    Ok(())
                }
            })
            .expect("restore exact materialization");
        module
            .search_snapshot_lease_registry()
            .expect("search snapshot registry")
            .invalidate_prepared();
        let partial_lease_id = partial_lease.lease_id.clone();

        std::fs::set_permissions(&body_cache, std::fs::Permissions::from_mode(0o600))
            .expect("make cache fixture writable");
        std::fs::write(&body_cache, b"corrupt cache fixture").expect("corrupt cache fixture");

        let prepared_title = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    read: LibraryRead::PageProjectionFile {
                        page_id: created.page_id.clone(),
                        file_kind: LibraryPageProjectionFileKind::MetaYaml,
                        prepare: Some(LibraryPagePrepareKind::TitleSet),
                    },
                },
            )
            .expect("prepare title mutation");
        let LibraryReadValue::PageProjectionFile {
            value: prepared_title,
        } = prepared_title.value
        else {
            panic!("prepared title projection")
        };
        OwnedDocumentModule::new("profile-1", "library-1", &kernel)
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    operation_id: "native-cli:rename-search-page".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: OwnedDocumentIntent::ApplySemanticMutation {
                        document_id: created.document_id.clone(),
                        generation: created.document_generation,
                        expected_head_seq: created.document_head_seq,
                        commands: vec![DocumentSemanticCommand::SetTitle {
                            inline_markdown: "Renamed Search Page".to_owned(),
                            expected_etag: prepared_title
                                .validators
                                .title_etag
                                .expect("title ETag"),
                        }],
                    },
                },
            )
            .expect("rename searchable Page");
        let reacquired = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    read: LibraryRead::AcquireSearchSnapshot {
                        scope: LibrarySearchSnapshotScope::Page {
                            page_id: created.page_id.clone(),
                        },
                        strict_materialization: true,
                    },
                },
            )
            .expect("reacquire after metadata-only change");
        let LibraryReadValue::SearchSnapshotLease {
            value: renamed_lease,
        } = reacquired.value
        else {
            panic!("renamed search snapshot lease")
        };
        let renamed_page = &renamed_lease.manifest.pages[0];
        assert_eq!(renamed_page.body.sha256, page.body.sha256);
        assert_ne!(renamed_page.meta.sha256, page.meta.sha256);
        assert_eq!(
            std::fs::read(&body_cache).expect("rebuilt body cache"),
            b"## Runtime\nCore starts on demand.\n"
        );
        assert_eq!(
            std::fs::metadata(&body_cache)
                .expect("rebuilt body cache metadata")
                .permissions()
                .mode()
                & 0o777,
            0o400
        );
        assert_eq!(
            std::fs::read_dir(directory.path().join("search-snapshots/cache/v1/body"))
                .expect("body cache")
                .count(),
            1
        );
        assert_eq!(
            std::fs::read_dir(directory.path().join("search-snapshots/cache/v1/meta"))
                .expect("metadata cache")
                .count(),
            2
        );

        module
            .apply(
                &context(),
                create_database_request("native-cli:create-search-database"),
            )
            .expect("create searchable Database");
        module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "native-cli:grant-search-database".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::GrantProjectAccess {
                        project_id: "project-1".to_owned(),
                        target: LibraryResourceTarget::Database {
                            database_id: "018f0000-0000-7000-8000-000000000001".to_owned(),
                        },
                        access: LibraryAccess::ReadWrite,
                    },
                },
            )
            .expect("grant searchable Database");
        let move_etag = prepare_move_etag(
            &module,
            &created.page_id,
            Some("018f0000-0000-7000-8000-000000000003"),
        );
        module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "native-cli:move-search-page".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::MovePage {
                        page_id: created.page_id.clone(),
                        destination: LibraryPageWriteDestination::DataSource {
                            data_source_id: "018f0000-0000-7000-8000-000000000002".to_owned(),
                            view_id: None,
                            group: None,
                            at: Some(LibraryAgentSiblingAnchor::End),
                        },
                        expected_etag: move_etag,
                    },
                },
            )
            .expect("move searchable Page into Data Source");
        let database_snapshot = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    read: LibraryRead::AcquireSearchSnapshot {
                        scope: LibrarySearchSnapshotScope::Database {
                            database_id: "018f0000-0000-7000-8000-000000000001".to_owned(),
                        },
                        strict_materialization: true,
                    },
                },
            )
            .expect("acquire Database search snapshot");
        let LibraryReadValue::SearchSnapshotLease {
            value: database_lease,
        } = database_snapshot.value
        else {
            panic!("Database search snapshot lease")
        };
        assert_eq!(database_lease.manifest.pages.len(), 1);
        assert_eq!(
            database_lease.manifest.pages[0].database_id.as_deref(),
            Some("018f0000-0000-7000-8000-000000000001")
        );
        assert_eq!(
            database_lease.manifest.pages[0].data_source_id.as_deref(),
            Some("018f0000-0000-7000-8000-000000000002")
        );
        assert!(
            database_lease.manifest.pages[0]
                .data_source_schema_revision
                .is_some()
        );

        let release = |lease_id: &str| {
            module
                .read(
                    &context(),
                    ModuleReadRequest {
                        contract_version: LIBRARY_CONTRACT_VERSION,
                        read: LibraryRead::ReleaseSearchSnapshot {
                            lease_id: lease_id.to_owned(),
                        },
                    },
                )
                .expect("release search snapshot")
                .value
        };
        let LibraryReadValue::SearchSnapshotRelease { value } = release(&lease.lease_id) else {
            panic!("search snapshot release")
        };
        assert!(value.released);
        assert!(!root.exists());
        let LibraryReadValue::SearchSnapshotRelease { value } = release(&partial_lease_id) else {
            panic!("partial search snapshot release")
        };
        assert!(value.released);
        let LibraryReadValue::SearchSnapshotRelease { value } = release(&renamed_lease.lease_id)
        else {
            panic!("renamed search snapshot release")
        };
        assert!(value.released);
        let LibraryReadValue::SearchSnapshotRelease { value } = release(&database_lease.lease_id)
        else {
            panic!("Database search snapshot release")
        };
        assert!(value.released);
        let reusable_root = directory.path().join("search-snapshots/.reusable");
        assert!(reusable_root.is_dir(), "validated lease tree is reusable");
        let reused_database_snapshot = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    read: LibraryRead::AcquireSearchSnapshot {
                        scope: LibrarySearchSnapshotScope::Database {
                            database_id: "018f0000-0000-7000-8000-000000000001".to_owned(),
                        },
                        strict_materialization: true,
                    },
                },
            )
            .expect("reuse unchanged Database search snapshot");
        let LibraryReadValue::SearchSnapshotLease {
            value: reused_database_lease,
        } = reused_database_snapshot.value
        else {
            panic!("reused Database search snapshot lease")
        };
        assert_eq!(reused_database_lease.manifest, database_lease.manifest);
        assert!(
            !reusable_root.exists(),
            "reusable tree moves atomically into its new random lease"
        );
        let LibraryReadValue::SearchSnapshotRelease { value } =
            release(&reused_database_lease.lease_id)
        else {
            panic!("reused Database search snapshot release")
        };
        assert!(value.released);
        let LibraryReadValue::SearchSnapshotRelease { value } = release(&lease.lease_id) else {
            panic!("idempotent search snapshot release")
        };
        assert!(!value.released);
        assert!(body_cache.is_file(), "release preserves immutable cache");
    }

    #[test]
    fn semantic_page_duplicate_move_and_guarded_delete_are_atomic_and_replayable() {
        let (_directory, kernel, module) = seeded_library();
        let mut retry_context = context();
        retry_context.connection_id = "connection:native-cli-retry".to_owned();
        let create = |operation_id: &str, title: &str| ModuleApplyRequest {
            contract_version: LIBRARY_CONTRACT_VERSION,
            operation_id: operation_id.to_owned(),
            store_epoch: StoreEpoch("epoch-1".to_owned()),
            intent: LibraryIntent::CreatePageFromNfm {
                title_markdown: title.to_owned(),
                nfm: "## Body\n\nDurable content.".to_owned(),
                destination: LibraryPageWriteDestination::Library { at: None },
            },
        };
        let parent = module
            .apply(&context(), create("native-cli:create-parent", "Parent"))
            .expect("create destination Page")
            .committed
            .value
            .page_create
            .expect("parent result");
        let source = module
            .apply(&context(), create("native-cli:create-source", "Source"))
            .expect("create source Page")
            .committed
            .value
            .page_create
            .expect("source result");
        module
            .apply(
                &context(),
                create_database_request("native-cli:create-destination-database"),
            )
            .expect("create Data Source destination");
        kernel
            .writer()
            .call(|connection| {
                with_immediate_transaction(connection, |transaction| {
                    crate::database::create_page_key_namespace(
                        transaction,
                        "library-1",
                        "018f0000-0000-7000-8000-000000000001",
                        Some("LAB"),
                        "Product work",
                        "2026-07-01T00:00:00.000Z",
                    )?;
                    Ok(())
                })
            })
            .expect("create Page-key namespace for semantic Page transfers");
        module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "native-cli:grant-destination-database".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::GrantProjectAccess {
                        project_id: "project-1".to_owned(),
                        target: LibraryResourceTarget::Database {
                            database_id: "018f0000-0000-7000-8000-000000000001".to_owned(),
                        },
                        access: LibraryAccess::ReadWrite,
                    },
                },
            )
            .expect("grant destination Database write access");
        let duplicate_request = ModuleApplyRequest {
            contract_version: LIBRARY_CONTRACT_VERSION,
            operation_id: "native-cli:duplicate-page".to_owned(),
            store_epoch: StoreEpoch("epoch-1".to_owned()),
            intent: LibraryIntent::DuplicatePage {
                source_page_id: source.page_id.clone(),
                destination: LibraryPageWriteDestination::Page {
                    page_id: parent.page_id.clone(),
                    at: Some(LibraryAgentSiblingAnchor::End),
                },
            },
        };
        let duplicated = module
            .apply(&context(), duplicate_request.clone())
            .expect("duplicate Page into Page")
            .committed;
        let copied = duplicated
            .value
            .page_copy
            .clone()
            .expect("exact duplicate result");
        assert_eq!(copied.source_page_id, source.page_id);
        assert_eq!(copied.page_key, None);
        assert_eq!(copied.document_generation, 1);
        assert_eq!(copied.document_head_seq, 1);
        assert!(copied.title_etag.starts_with("nxe1."));
        assert!(copied.body_etag.starts_with("nxe1."));

        let copied_to_data_source = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "native-cli:duplicate-page-to-data-source".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::DuplicatePage {
                        source_page_id: source.page_id.clone(),
                        destination: LibraryPageWriteDestination::DataSource {
                            data_source_id: "018f0000-0000-7000-8000-000000000002".to_owned(),
                            view_id: Some("018f0000-0000-7000-8000-000000000003".to_owned()),
                            group: None,
                            at: Some(LibraryAgentSiblingAnchor::End),
                        },
                    },
                },
            )
            .expect("duplicate Page into keyed Data Source")
            .committed
            .value
            .page_copy
            .expect("keyed duplicate result");
        assert_eq!(copied_to_data_source.page_key.as_deref(), Some("LAB-1"));
        let duplicate_replay = module
            .apply(&retry_context, duplicate_request)
            .expect("duplicate replay");
        assert!(duplicate_replay.committed.receipt.mutation.duplicate);
        assert_eq!(
            duplicate_replay.committed.value.page_copy,
            Some(copied.clone())
        );

        let before_move = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    read: LibraryRead::PageProjectionFile {
                        page_id: copied.page_id.clone(),
                        file_kind: LibraryPageProjectionFileKind::MetaYaml,
                        prepare: Some(LibraryPagePrepareKind::PageDelete),
                    },
                },
            )
            .expect("prepare delete before move");
        let LibraryReadValue::PageProjectionFile { value: before_move } = before_move.value else {
            panic!("Page file")
        };
        let stale_delete_etag = before_move.validators.page_etag.expect("Page ETag");
        let move_etag = prepare_move_etag(&module, &copied.page_id, None);

        let move_request = ModuleApplyRequest {
            contract_version: LIBRARY_CONTRACT_VERSION,
            operation_id: "native-cli:move-page".to_owned(),
            store_epoch: StoreEpoch("epoch-1".to_owned()),
            intent: LibraryIntent::MovePage {
                page_id: copied.page_id.clone(),
                destination: LibraryPageWriteDestination::Library {
                    at: Some(LibraryAgentSiblingAnchor::Start),
                },
                expected_etag: move_etag,
            },
        };
        let moved = module
            .apply(&context(), move_request.clone())
            .expect("move Page to Library")
            .committed;
        let transfer = moved
            .value
            .block_transfer
            .clone()
            .expect("exact transfer result");
        assert_eq!(transfer.page_keys.get(&copied.page_id), Some(&None));
        let moved_page_etag = transfer
            .page_etags
            .get(&copied.page_id)
            .cloned()
            .expect("post-move Page ETag");
        assert!(moved_page_etag.starts_with("nxe1."));
        let move_replay = module
            .apply(&retry_context, move_request)
            .expect("move replay across a new connection");
        assert!(move_replay.committed.receipt.mutation.duplicate);
        assert_eq!(move_replay.committed.value.block_transfer, Some(transfer));

        let move_to_data_source_etag = prepare_move_etag(
            &module,
            &copied.page_id,
            Some("018f0000-0000-7000-8000-000000000003"),
        );
        let moved_to_data_source = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "native-cli:move-page-to-data-source".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::MovePage {
                        page_id: copied.page_id.clone(),
                        destination: LibraryPageWriteDestination::DataSource {
                            data_source_id: "018f0000-0000-7000-8000-000000000002".to_owned(),
                            view_id: Some("018f0000-0000-7000-8000-000000000003".to_owned()),
                            group: None,
                            at: Some(LibraryAgentSiblingAnchor::End),
                        },
                        expected_etag: move_to_data_source_etag,
                    },
                },
            )
            .expect("move Page into the default Data Source View")
            .committed
            .value
            .block_transfer
            .expect("Data Source transfer result");
        assert_eq!(
            moved_to_data_source
                .page_keys
                .get(&copied.page_id)
                .and_then(Option::as_deref),
            Some("LAB-2")
        );
        let preserve_group_etag = moved_to_data_source
            .move_etags
            .get(&copied.page_id)
            .cloned()
            .expect("post-Data-Source move ETag");
        let projection_page_id = copied.page_id.clone();
        kernel
            .writer()
            .call(move |connection| {
                connection.execute(
                    "UPDATE page_read_model SET database_values_json = \
                       json_set(database_values_json, '$.status', 'display-only') \
                     WHERE page_block_id = ?1",
                    [projection_page_id],
                )?;
                Ok(())
            })
            .expect("diverge the compatibility display projection");
        let preserved_group_move = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "native-cli:move-page-preserving-group".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::MovePage {
                        page_id: copied.page_id.clone(),
                        destination: LibraryPageWriteDestination::DataSource {
                            data_source_id: "018f0000-0000-7000-8000-000000000002".to_owned(),
                            view_id: Some("018f0000-0000-7000-8000-000000000003".to_owned()),
                            group: None,
                            at: Some(LibraryAgentSiblingAnchor::Start),
                        },
                        expected_etag: preserve_group_etag,
                    },
                },
            )
            .expect("preserve the canonical group despite a divergent display projection")
            .committed
            .value
            .block_transfer
            .expect("canonical-group transfer result");
        let preserved_state = read_page_view_state(&kernel, &copied.page_id);
        assert_eq!(preserved_state.4, "\"triage\"");
        assert_eq!(preserved_state.6.as_deref(), Some("triage"));
        let move_within_view_etag = preserved_group_move
            .move_etags
            .get(&copied.page_id)
            .cloned()
            .expect("post-canonical-group move ETag");
        let move_within_view_request = ModuleApplyRequest {
            contract_version: LIBRARY_CONTRACT_VERSION,
            operation_id: "native-cli:move-page-to-build".to_owned(),
            store_epoch: StoreEpoch("epoch-1".to_owned()),
            intent: LibraryIntent::MovePage {
                page_id: copied.page_id.clone(),
                destination: LibraryPageWriteDestination::DataSource {
                    data_source_id: "018f0000-0000-7000-8000-000000000002".to_owned(),
                    view_id: Some("018f0000-0000-7000-8000-000000000003".to_owned()),
                    group: Some(nodex_core_contracts::database::DatabaseGroupScope::Path {
                        group_key: Some("build".to_owned()),
                        subgroup_key: None,
                    }),
                    at: Some(LibraryAgentSiblingAnchor::End),
                },
                expected_etag: move_within_view_etag,
            },
        };
        let moved_within_view_commit = module
            .apply(&context(), move_within_view_request.clone())
            .expect("move Page atomically within the Data Source View")
            .committed;
        let moved_within_view = moved_within_view_commit
            .value
            .block_transfer
            .clone()
            .expect("in-View transfer result");
        let moved_within_view_replay = module
            .apply(&retry_context, move_within_view_request)
            .expect("replay in-View Page move after its ETag advanced");
        assert!(
            moved_within_view_replay
                .committed
                .receipt
                .mutation
                .duplicate
        );
        assert_eq!(
            moved_within_view_replay.committed.value.block_transfer,
            Some(moved_within_view.clone())
        );
        assert_eq!(
            moved_within_view
                .page_view_placements
                .get(&copied.page_id)
                .map(|placement| placement.group_key.as_deref()),
            Some(Some("build"))
        );
        let stale_move_etag = moved_within_view
            .move_etags
            .get(&copied.page_id)
            .cloned()
            .expect("fresh in-View move ETag");
        let moved_page_etag = moved_within_view
            .page_etags
            .get(&copied.page_id)
            .cloned()
            .expect("post-in-View Page ETag");
        assert_eq!(
            moved_to_data_source.affected_database_ids,
            vec!["018f0000-0000-7000-8000-000000000001".to_owned()]
        );
        let concurrent_page_id = copied.page_id.clone();
        kernel
            .writer()
            .call(move |connection| {
                connection.execute(
                    "UPDATE database_view_page_positions \
                     SET revision = revision + 1, updated_at = ?1 \
                     WHERE view_id = ?2 AND page_block_id = ?3",
                    params![
                        NOW,
                        "018f0000-0000-7000-8000-000000000003",
                        concurrent_page_id
                    ],
                )?;
                Ok(())
            })
            .expect("concurrent View position revision");
        let state_after_concurrent_write = read_page_view_state(&kernel, &copied.page_id);
        assert_eq!(state_after_concurrent_write.4, "\"build\"");
        assert_eq!(state_after_concurrent_write.6.as_deref(), Some("build"));
        let stale_move = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "native-cli:move-page-with-stale-etag".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::MovePage {
                        page_id: copied.page_id.clone(),
                        destination: LibraryPageWriteDestination::DataSource {
                            data_source_id: "018f0000-0000-7000-8000-000000000002".to_owned(),
                            view_id: Some("018f0000-0000-7000-8000-000000000003".to_owned()),
                            group: Some(nodex_core_contracts::database::DatabaseGroupScope::Path {
                                group_key: Some("triage".to_owned()),
                                subgroup_key: None,
                            }),
                            at: Some(LibraryAgentSiblingAnchor::End),
                        },
                        expected_etag: stale_move_etag,
                    },
                },
            )
            .expect_err("stale move ETag must reject the whole transfer");
        assert_eq!(
            stale_move.code,
            nodex_core_contracts::CoreErrorCode::RevisionConflict
        );
        let state_after_rejected_move = read_page_view_state(&kernel, &copied.page_id);
        assert_eq!(state_after_rejected_move, state_after_concurrent_write);

        let stale_delete = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "native-cli:delete-stale-page".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::DeletePage {
                        page_id: copied.page_id.clone(),
                        expected_etag: stale_delete_etag,
                    },
                },
            )
            .expect_err("stale pre-move Page ETag must fail");
        assert_eq!(
            stale_delete.code,
            nodex_core_contracts::CoreErrorCode::RevisionConflict
        );

        let delete_request = ModuleApplyRequest {
            contract_version: LIBRARY_CONTRACT_VERSION,
            operation_id: "native-cli:delete-page".to_owned(),
            store_epoch: StoreEpoch("epoch-1".to_owned()),
            intent: LibraryIntent::DeletePage {
                page_id: copied.page_id.clone(),
                expected_etag: moved_page_etag,
            },
        };
        let deleted = module
            .apply(&context(), delete_request.clone())
            .expect("guarded Page delete");
        assert_eq!(
            deleted
                .committed
                .value
                .page_lifecycle
                .as_ref()
                .expect("delete receipt")
                .lifecycle,
            nodex_core_contracts::library::LibraryPageLifecycleState::Deleted
        );
        let delete_replay = module
            .apply(&retry_context, delete_request)
            .expect("delete replay after tombstone across a new connection");
        assert!(delete_replay.committed.receipt.mutation.duplicate);
        assert_eq!(
            delete_replay.committed.value.page_lifecycle,
            deleted.committed.value.page_lifecycle
        );
    }

    #[test]
    fn page_lifecycle_cascades_embedded_database_authority_atomically() {
        let (_directory, kernel, module) = seeded_library();
        let context = context();
        module
            .apply(
                &context,
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "page-with-database:create-page".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::CreatePage {
                        page_id: "page:database-host".to_owned(),
                        document_id: "document:database-host".to_owned(),
                        title: "Database host".to_owned(),
                        parent: LibraryWriteParent::Library { before: None },
                    },
                },
            )
            .expect("create Page host");
        module
            .apply(
                &context,
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "page-with-database:create-database".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::CreateDatabase {
                        database_id: "018f0000-0000-7000-8000-000000000021".to_owned(),
                        data_source_id: "018f0000-0000-7000-8000-000000000022".to_owned(),
                        view_id: "018f0000-0000-7000-8000-000000000023".to_owned(),
                        name: "Embedded database".to_owned(),
                        parent: LibraryWriteParent::Page {
                            page_id: "page:database-host".to_owned(),
                            expected_document_generation: 1,
                            expected_document_head_seq: 1,
                            before: None,
                            insertion: None,
                        },
                    },
                },
            )
            .expect("create embedded Database");

        let deleted = module
            .apply(
                &context,
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "page-with-database:delete".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::ApplyPageLifecycle {
                        mutation: Box::new(LibraryPageLifecycleMutation::DeletePage {
                            page_id: "page:database-host".to_owned(),
                            expected_metadata_revision: 1,
                            expected_parent_revision: 1,
                            parent_document_head: None,
                        }),
                    },
                },
            )
            .expect("delete Page with embedded Database");
        assert_eq!(
            deleted
                .committed
                .receipt
                .committed_revisions
                .get("databaseMetadata:018f0000-0000-7000-8000-000000000021"),
            Some(&2)
        );
        kernel
            .readers()
            .read_default(|connection| {
                let state = connection.query_row(
                    "SELECT block.lifecycle, block.metadata_revision, container.lifecycle, \
                       container.metadata_revision \
                     FROM blocks block JOIN database_containers container \
                       ON container.block_id = block.id \
                     WHERE block.id = '018f0000-0000-7000-8000-000000000021'",
                    [],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, i64>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, i64>(3)?,
                        ))
                    },
                )?;
                assert_eq!(state, ("deleted".to_owned(), 2, "deleted".to_owned(), 2));
                Ok(())
            })
            .expect("embedded Database authority is deleted with Page");

        module
            .apply(
                &context,
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "page-with-database:restore".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::ApplyPageLifecycle {
                        mutation: Box::new(LibraryPageLifecycleMutation::RestorePage {
                            page_id: "page:database-host".to_owned(),
                            delete_operation_id: "page-with-database:delete".to_owned(),
                            expected_metadata_revision: 2,
                            expected_parent_revision: 2,
                            membership: None,
                            before_block_id: None,
                            parent_document_head: None,
                        }),
                    },
                },
            )
            .expect("restore Page with embedded Database");
        kernel
            .readers()
            .read_default(|connection| {
                let state = connection.query_row(
                    "SELECT block.lifecycle, block.metadata_revision, container.lifecycle, \
                       container.metadata_revision \
                     FROM blocks block JOIN database_containers container \
                       ON container.block_id = block.id \
                     WHERE block.id = '018f0000-0000-7000-8000-000000000021'",
                    [],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, i64>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, i64>(3)?,
                        ))
                    },
                )?;
                assert_eq!(state, ("active".to_owned(), 3, "active".to_owned(), 3));
                Ok(())
            })
            .expect("embedded Database authority is restored with Page");
    }
}
