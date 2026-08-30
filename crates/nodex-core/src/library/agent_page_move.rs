use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::path::Path;
use std::sync::{Arc, Mutex};

use nodex_core_contracts::agent::{
    AgentConsentRequirement, AgentEffectClass, AgentExecutionAuthorization,
    AgentOperationFootprint, AgentOperationPreparation, AgentOperationPreparationState,
    AgentOwnershipTransformation, AgentPreparedExecution, AgentResourceKind, AgentResourceTarget,
};
use nodex_core_contracts::library::{
    LibraryAgentDocumentHead, LibraryAgentMovePagePreparation, LibraryAgentMovePagesPreparation,
    LibraryAgentMovePagesRequest, LibraryAgentMovePagesResult, LibraryAgentMovedPage,
    LibraryAgentPageDestination, LibraryAgentPageLocation, LibraryBlockTransferDataSourcePlacement,
    LibraryBlockTransferDocumentHead, LibraryBlockTransferLogicalIntent, LibraryBlockTransferMode,
    LibraryBlockTransferSource, LibraryBlockTransferTarget, LibraryPageCopyDestination,
    LibraryReadValue,
};
use nodex_core_contracts::{
    AdapterKind, ApplyResponse, BoundModuleContext, LIBRARY_CONTRACT_VERSION, ModuleApplyRequest,
    ModuleName, ModuleReadSnapshot, StoreEpoch,
};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::Serialize;
use serde_json::json;

use crate::database::{
    PageCopyDataSourceDestination, PageCopyPositionAnchor, PageCopyValueDraft,
    PageCopyViewPlacement, current_page_key_for_page,
    finalize_agent_moved_pages_in_data_source_prevalidated,
};
use crate::document::{DocumentRuntimeCache, read_store_epoch, sha256};
use crate::infrastructure::agent_operations::{
    PreparedAgentOperationBinding, PreparedAgentOperationRegistry,
};
use crate::infrastructure::durable_mutation::{self, DurableMutationScope, OperationIdentity};
use crate::infrastructure::module_receipts::read_module_receipt;
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};
use crate::infrastructure::writer::{StoreReaders, StoreWriter};

use super::LibraryApplyOutcome;
use super::agent_page_write::{
    ResolvedDestination, destination_before_id, destination_footprint_target, read_location_anchor,
    resolve_before_id, resolve_destination,
};
use super::block_transfer::{
    AgentPageMoveTransferAuthority, AppliedAgentPageDocumentBatch, PreparedAgentPageDocumentBatch,
    PreparedBlockTransfer, PreparedTransferReadSet,
};
use super::mutation::{MutationEffects, library_commit_result, seal_mutation_with, sqlite_now};

const MODULE_NAME: &str = "library";
const MAX_PAGES: usize = 16;
const MAX_ID_BYTES: usize = 512;

#[derive(Serialize)]
struct PreparedMoveStep {
    page_id: String,
    source: LibraryBlockTransferSource,
    source_document_id: Option<String>,
    source_database_id: Option<String>,
    same_data_source: bool,
    source_authorization_fingerprint: String,
    source_state_hash: String,
    read_set: PreparedTransferReadSet,
    #[serde(skip)]
    prepared_transfer: Option<PreparedBlockTransfer>,
}

struct MovePreflight {
    binding: PreparedAgentOperationBinding,
    destination: LibraryPageCopyDestination,
    destination_document: Option<LibraryAgentDocumentHead>,
    destination_database_id: Option<String>,
    actor_project_id: String,
    destination_authority_hash: String,
    steps: Vec<PreparedMoveStep>,
    batch_documents: Option<PreparedAgentPageDocumentBatch>,
    document_heads: Vec<LibraryAgentDocumentHead>,
    footprint: AgentOperationFootprint,
}

pub(super) struct PrepareMovePagesInput {
    pub(super) operation_id: String,
    pub(super) expected_store_epoch: String,
    pub(super) authorization: AgentExecutionAuthorization,
    pub(super) request: LibraryAgentMovePagesRequest,
}

enum PreparationRead {
    Committed {
        store_epoch: String,
        commit_head: i64,
        footprint: AgentOperationFootprint,
        committed: Box<
            ApplyResponse<
                nodex_core_contracts::library::LibraryCommitValue,
                nodex_core_contracts::library::LibraryReceipt,
            >,
        >,
    },
    Prepared {
        store_epoch: String,
        commit_head: i64,
        preflight: Box<MovePreflight>,
    },
}

pub(super) fn prepare_move_pages(
    readers: &StoreReaders,
    document_runtime_cache: &Arc<Mutex<DocumentRuntimeCache>>,
    registry: &PreparedAgentOperationRegistry,
    context: &BoundModuleContext,
    library_id: &str,
    input: PrepareMovePagesInput,
) -> Result<ModuleReadSnapshot<LibraryReadValue>, StoreError> {
    let PrepareMovePagesInput {
        operation_id,
        expected_store_epoch,
        authorization,
        request,
    } = input;
    validate_id(&operation_id, "operation_id")?;
    let context = context.clone();
    let library_id = library_id.to_owned();
    let document_runtime_cache = Arc::clone(document_runtime_cache);
    let preparation = readers.read_default(|connection| {
        let transaction = connection.unchecked_transaction()?;
        let store_epoch = read_store_epoch(&transaction)?;
        if store_epoch != expected_store_epoch {
            return Err(stale_epoch());
        }
        let commit_head = super::navigation::commit_head(&transaction)?;
        let request_hash = request_hash(&context, &store_epoch, &authorization, &request)?;
        if let Some(stored) = read_module_receipt(&transaction, MODULE_NAME, &operation_id)? {
            if stored.request_hash != request_hash {
                return Err(reused());
            }
            let local_commit_seq = stored.local_commit_seq;
            let mut committed = serde_json::from_value::<
                crate::ModuleWriterResult<
                    nodex_core_contracts::library::LibraryCommitValue,
                    nodex_core_contracts::library::LibraryReceipt,
                >,
            >(stored.result)
            .map_err(|_| corrupt("Stored Agent Page-move receipt is invalid"))?;
            committed.receipt.mutation.duplicate = true;
            let result = committed
                .value
                .agent_move_pages
                .as_ref()
                .ok_or_else(|| corrupt("Stored Library receipt is not an Agent Page move"))?;
            let footprint = committed_footprint(&library_id, result);
            let committed =
                durable_mutation::replay_apply_response(&transaction, local_commit_seq, committed)?;
            transaction.commit()?;
            return Ok(PreparationRead::Committed {
                store_epoch,
                commit_head,
                footprint,
                committed: Box::new(committed),
            });
        }
        let preflight = compile_preflight(
            &transaction,
            Some(&document_runtime_cache),
            &context,
            &library_id,
            &operation_id,
            &store_epoch,
            &authorization,
            &request,
            request_hash,
        )?;
        transaction.commit()?;
        Ok(PreparationRead::Prepared {
            store_epoch,
            commit_head,
            preflight: Box::new(preflight),
        })
    })?;

    match preparation {
        PreparationRead::Committed {
            store_epoch,
            commit_head,
            footprint,
            committed,
        } => Ok(ModuleReadSnapshot {
            contract_version: LIBRARY_CONTRACT_VERSION,
            store_epoch: StoreEpoch(store_epoch),
            commit_head,
            authorization: None,
            value: LibraryReadValue::AgentMovePagesPreparation {
                value: Box::new(LibraryAgentMovePagesPreparation {
                    preparation: AgentOperationPreparation {
                        state: AgentOperationPreparationState::CommittedReplay,
                        consent: AgentConsentRequirement::None,
                        footprint,
                        preview_markdown: None,
                        token: None,
                        expires_at_unix_ms: None,
                    },
                    pages: Vec::new(),
                    document_heads: Vec::new(),
                    destination: None,
                    destination_document: None,
                    destination_database_id: None,
                    committed: Some(committed),
                }),
            },
        }),
        PreparationRead::Prepared {
            store_epoch,
            commit_head,
            preflight,
        } => {
            let issued = registry.issue(preflight.binding)?;
            Ok(ModuleReadSnapshot {
                contract_version: LIBRARY_CONTRACT_VERSION,
                store_epoch: StoreEpoch(store_epoch),
                commit_head,
                authorization: None,
                value: LibraryReadValue::AgentMovePagesPreparation {
                    value: Box::new(LibraryAgentMovePagesPreparation {
                        preparation: AgentOperationPreparation {
                            state: AgentOperationPreparationState::Prepared,
                            consent: AgentConsentRequirement::None,
                            footprint: preflight.footprint,
                            preview_markdown: None,
                            token: Some(issued.token),
                            expires_at_unix_ms: Some(issued.expires_at_unix_ms),
                        },
                        pages: preflight.steps.iter().map(page_preparation).collect(),
                        document_heads: preflight.document_heads,
                        destination: Some(preflight.destination),
                        destination_document: preflight.destination_document,
                        destination_database_id: preflight.destination_database_id,
                        committed: None,
                    }),
                },
            })
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) fn execute_move_pages(
    writer: &StoreWriter,
    readers: &StoreReaders,
    document_runtime_cache: &Arc<Mutex<DocumentRuntimeCache>>,
    registry: &PreparedAgentOperationRegistry,
    profile_id: &str,
    library_id: &str,
    context: &BoundModuleContext,
    request: ModuleApplyRequest<nodex_core_contracts::library::LibraryIntent>,
    authorization: AgentPreparedExecution,
    move_request: LibraryAgentMovePagesRequest,
    assets_root: &Path,
) -> Result<LibraryApplyOutcome, StoreError> {
    let profile_id = profile_id.to_owned();
    let library_id = library_id.to_owned();
    let context = context.clone();
    let assets_root = assets_root.to_path_buf();
    let operation_id = request.operation_id;
    let expected_store_epoch = request.store_epoch.0;
    let prepared_preflight = readers.read_default(|connection| {
        let transaction = connection.unchecked_transaction()?;
        super::mutation::assert_identity(&transaction, &profile_id, &library_id)?;
        let store_epoch = read_store_epoch(&transaction)?;
        if store_epoch != expected_store_epoch {
            return Err(stale_epoch());
        }
        let request_hash = request_hash(
            &context,
            &store_epoch,
            &authorization.authorization,
            &move_request,
        )?;
        if let Some(stored) = read_module_receipt(&transaction, MODULE_NAME, &operation_id)? {
            if stored.request_hash != request_hash {
                return Err(reused());
            }
            transaction.commit()?;
            return Ok(None);
        }
        let preflight = compile_preflight(
            &transaction,
            Some(document_runtime_cache),
            &context,
            &library_id,
            &operation_id,
            &store_epoch,
            &authorization.authorization,
            &move_request,
            request_hash,
        )?;
        transaction.commit()?;
        Ok(Some(preflight))
    })?;
    let prepared_lease = prepared_preflight
        .as_ref()
        .map(|preflight| {
            let token = authorization.token.as_deref().ok_or_else(stale_token)?;
            registry.acquire(token, &preflight.binding)
        })
        .transpose()?;
    let result = writer.call(move |connection| {
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        super::mutation::assert_identity(&transaction, &profile_id, &library_id)?;
        let store_epoch = read_store_epoch(&transaction)?;
        if store_epoch != expected_store_epoch {
            return Err(stale_epoch());
        }
        let request_hash = request_hash(
            &context,
            &store_epoch,
            &authorization.authorization,
            &move_request,
        )?;
        if let Some(stored) = read_module_receipt(&transaction, MODULE_NAME, &operation_id)? {
            if stored.request_hash != request_hash {
                return Err(reused());
            }
            let mut committed = serde_json::from_value::<
                crate::ModuleWriterResult<
                    nodex_core_contracts::library::LibraryCommitValue,
                    nodex_core_contracts::library::LibraryReceipt,
                >,
            >(stored.result)
            .map_err(|_| corrupt("Stored Agent Page-move receipt is invalid"))?;
            if committed.value.agent_move_pages.is_none() {
                return Err(corrupt("Stored Library receipt is not an Agent Page move"));
            }
            committed.receipt.mutation.duplicate = true;
            transaction.commit()?;
            return Ok((
                LibraryApplyOutcome {
                    committed,
                    event: None,
                },
                None,
            ));
        }
        let mut preflight = prepared_preflight.ok_or_else(|| {
            corrupt("Agent Page move lost its execution preparation before commit")
        })?;
        revalidate_preflight(
            &transaction,
            &context,
            &library_id,
            &authorization.authorization,
            &move_request,
            &preflight,
        )?;
        let lease = prepared_lease.ok_or_else(stale_token)?;
        let mut agent_context = context.clone();
        agent_context.adapter = AdapterKind::Agent;
        let committed_at = sqlite_now(&transaction)?;
        let committed = durable_mutation::run(
            &transaction,
            OperationIdentity {
                module: ModuleName::Library,
                module_name: "library",
                operation_id: &operation_id,
                intent_hash: &request_hash,
                store_epoch: &store_epoch,
                committed_at: &committed_at,
                context: &agent_context,
            },
            |scope| {
                let execution = apply_pages(
                    &transaction,
                    scope,
                    &agent_context,
                    &library_id,
                    &operation_id,
                    &store_epoch,
                    &move_request,
                    &mut preflight,
                    &authorization.authorization,
                    &assets_root,
                    &committed_at,
                )?;
                let document_batch = execution.document_batch;
                seal_mutation_with(
                    scope,
                    &agent_context,
                    &operation_id,
                    MutationEffects {
                        project_id: preflight.actor_project_id,
                        operation_kind: "agent_move_pages",
                        change_kind: "library.changed",
                        did_mutate: true,
                        created_target: None,
                        affected_parent_keys: execution.affected_parent_keys,
                        affected_block_ids: move_request.page_ids.clone(),
                        affected_page_ids: execution.affected_page_ids,
                        affected_database_ids: execution.result.affected_database_ids.clone(),
                        affected_view_ids: execution.affected_view_ids,
                        affected_document_ids: execution.affected_document_ids,
                        committed_revisions: execution.committed_revisions,
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
                        agent_move_pages: Some(execution.result),
                        change_payload: None,
                        committed_at: execution.committed_at,
                    },
                    |_, event_sequence| {
                        super::block_transfer::persist_agent_page_document_batch_checkpoints(
                            &transaction,
                            &agent_context,
                            &operation_id,
                            &agent_actor(&authorization.authorization),
                            &document_batch,
                            event_sequence,
                            &committed_at,
                        )
                    },
                )
            },
        )?;
        let outcome = library_commit_result(&transaction, committed)?;
        transaction.commit()?;
        Ok((outcome, Some(lease)))
    })?;
    if let Some(lease) = result.1 {
        lease.consume()?;
    }
    Ok(result.0)
}

struct MoveExecution {
    result: LibraryAgentMovePagesResult,
    affected_parent_keys: Vec<String>,
    affected_page_ids: Vec<String>,
    affected_view_ids: Vec<String>,
    affected_document_ids: Vec<String>,
    committed_revisions: BTreeMap<String, i64>,
    document_batch: AppliedAgentPageDocumentBatch,
    committed_at: String,
}

#[allow(clippy::too_many_arguments)]
fn apply_pages(
    connection: &Connection,
    scope: &DurableMutationScope<'_>,
    context: &BoundModuleContext,
    library_id: &str,
    operation_id: &str,
    store_epoch: &str,
    request: &LibraryAgentMovePagesRequest,
    preflight: &mut MovePreflight,
    authorization: &AgentExecutionAuthorization,
    assets_root: &Path,
    now: &str,
) -> Result<MoveExecution, StoreError> {
    let mut document_commits = Vec::new();
    let mut affected_parent_keys = BTreeSet::new();
    let mut affected_page_ids = request.page_ids.iter().cloned().collect::<BTreeSet<_>>();
    let mut affected_database_ids = BTreeSet::new();
    let mut affected_view_ids = BTreeSet::new();
    let mut affected_document_ids = BTreeSet::new();
    let mut committed_revisions = BTreeMap::new();
    let mut file_ownership_moves = Vec::new();
    affected_parent_keys.insert(destination_parent_key(library_id, &request.destination));

    for (index, step) in preflight.steps.iter_mut().enumerate() {
        affected_parent_keys.insert(source_parent_key(library_id, &step.source));
        if step.same_data_source {
            continue;
        }
        let transfer_operation_id = format!("{operation_id}:page:{index}");
        let intent = transfer_intent(
            library_id,
            &step.page_id,
            &step.source,
            &preflight.destination,
            authorization,
        )?;
        let transfer_authority = transfer_authority(&preflight.actor_project_id);
        let prepared_transfer = step
            .prepared_transfer
            .take()
            .ok_or_else(|| corrupt("Agent Page move omitted its prepared transfer"))?;
        let transfer_hash = super::block_transfer::semantic_agent_page_move_request_hash(
            context,
            store_epoch,
            &intent,
            &transfer_authority,
        )?;
        let outcome = super::block_transfer::apply_agent_page_move(
            connection,
            context,
            library_id,
            &transfer_operation_id,
            store_epoch,
            &transfer_hash,
            &intent,
            assets_root,
            &transfer_authority,
            scope,
            prepared_transfer,
        )?;
        let transfer = outcome
            .committed
            .value
            .block_transfer
            .ok_or_else(|| corrupt("Agent Page move omitted its transfer result"))?;
        for commit in &transfer.document_commits {
            affected_document_ids.insert(commit.document_id.clone());
        }
        document_commits.extend(transfer.document_commits);
        affected_database_ids.extend(transfer.affected_database_ids);
        file_ownership_moves.extend(transfer.file_ownership_moves);
        affected_page_ids.extend(outcome.committed.receipt.affected_page_ids);
        affected_view_ids.extend(outcome.committed.receipt.affected_view_ids);
        committed_revisions.extend(outcome.committed.receipt.committed_revisions);
    }

    let document_batch = super::block_transfer::apply_agent_page_document_batch(
        connection,
        scope,
        context
            .project_id
            .as_ref()
            .map(|project_id| project_id.0.as_str())
            .ok_or_else(|| unauthorized("Agent Page move requires a bound Project"))?,
        operation_id,
        store_epoch,
        preflight
            .batch_documents
            .take()
            .ok_or_else(|| corrupt("Agent Page move omitted its prepared Document batch"))?,
    )?;
    super::block_transfer::verify_agent_page_move_final_locations(
        connection,
        library_id,
        &request.page_ids,
        &preflight.destination,
    )?;
    let batch_document_commits = document_batch.document_commits();
    for commit in &batch_document_commits {
        affected_document_ids.insert(commit.document_id.clone());
        committed_revisions.insert(
            format!("documentHead:{}", commit.document_id),
            commit.head_seq,
        );
    }
    document_commits.extend(batch_document_commits);

    if let LibraryPageCopyDestination::DataSource { .. } = &preflight.destination {
        let destination = data_source_destination(&preflight.destination)?;
        let finalization = finalize_agent_moved_pages_in_data_source_prevalidated(
            connection,
            library_id,
            &preflight.actor_project_id,
            &request.page_ids,
            &destination,
            now,
        )?;
        affected_database_ids.extend(finalization.affected_database_ids);
        affected_view_ids.extend(finalization.affected_view_ids);
        committed_revisions.extend(finalization.committed_revisions);
    }

    let location = destination_location(library_id, &request.destination);
    let pages = request
        .page_ids
        .iter()
        .map(|page_id| {
            Ok(LibraryAgentMovedPage {
                page_id: page_id.clone(),
                page_key: current_page_key_for_page(connection, library_id, page_id)?,
                location: location.clone(),
            })
        })
        .collect::<Result<Vec<_>, StoreError>>()?;
    Ok(MoveExecution {
        result: LibraryAgentMovePagesResult {
            pages,
            document_commits,
            affected_database_ids: affected_database_ids.into_iter().collect(),
            file_ownership_moves,
        },
        affected_parent_keys: affected_parent_keys.into_iter().collect(),
        affected_page_ids: affected_page_ids.into_iter().collect(),
        affected_view_ids: affected_view_ids.into_iter().collect(),
        affected_document_ids: affected_document_ids.into_iter().collect(),
        committed_revisions,
        document_batch,
        committed_at: now.to_owned(),
    })
}

#[allow(clippy::too_many_arguments)]
fn compile_preflight(
    connection: &Connection,
    document_runtime_cache: Option<&Arc<Mutex<DocumentRuntimeCache>>>,
    context: &BoundModuleContext,
    library_id: &str,
    operation_id: &str,
    store_epoch: &str,
    authorization: &AgentExecutionAuthorization,
    request: &LibraryAgentMovePagesRequest,
    request_hash: String,
) -> Result<MovePreflight, StoreError> {
    validate_request(request)?;
    assert_no_ownership_overlap(connection, &request.page_ids)?;
    let ResolvedDestination {
        destination: resolved_destination,
        authorization_fingerprint: destination_fingerprint,
        document_heads: destination_heads,
        database_id: destination_database_id,
        actor_project_id,
    } = resolve_destination(
        connection,
        context,
        library_id,
        authorization,
        &request.destination,
    )?;
    let destination = resolve_move_destination(
        connection,
        &request.destination,
        resolved_destination,
        &request.page_ids,
        library_id,
    )?;
    let destination_document = matches!(
        request.destination,
        LibraryAgentPageDestination::Page { .. }
    )
    .then(|| destination_heads.first().cloned())
    .flatten();
    let destination_authority_hash = hash_serializable(&(
        &destination_fingerprint,
        &destination,
        &destination_heads,
        &destination_database_id,
        &actor_project_id,
    ))?;
    let mut source_fingerprints = Vec::with_capacity(request.page_ids.len());
    let mut steps = Vec::with_capacity(request.page_ids.len());
    let mut document_heads = destination_heads;
    for (index, page_id) in request.page_ids.iter().enumerate() {
        let source_fingerprint = super::agent_authorization::authorize_execution(
            connection,
            context,
            library_id,
            authorization,
            &nodex_core_contracts::agent::AgentAuthorizationTarget::Page {
                page_id: page_id.clone(),
            },
            nodex_core_contracts::agent::AgentProjectResourceAction::Move,
        )?;
        source_fingerprints.push(source_fingerprint.clone());
        let source = read_source(connection, library_id, page_id)?;
        let source_state_hash = source_state_hash(connection, page_id, &destination)?;
        let same_data_source = matches!(
            (&source.source, &destination),
            (
                LibraryBlockTransferSource::DataSource { data_source_id: source_id },
                LibraryPageCopyDestination::DataSource { data_source_id: target_id, .. }
            ) if source_id == target_id
        );
        if same_data_source
            && matches!(
                &destination,
                LibraryPageCopyDestination::DataSource { values, .. } if !values.is_empty()
            )
        {
            return Err(invalid(
                "Moving within one Data Source cannot change independent Property values",
            ));
        }
        let (read_set, prepared_transfer) = if same_data_source {
            (
                PreparedTransferReadSet {
                    documents: Vec::new(),
                    location_revisions: BTreeMap::new(),
                    source_memberships: BTreeMap::new(),
                },
                None,
            )
        } else {
            let intent = transfer_intent(
                library_id,
                page_id,
                &source.source,
                &destination,
                authorization,
            )?;
            let transfer_authority = transfer_authority(&actor_project_id);
            let prepared = super::block_transfer::prepare_for_agent_page_move(
                connection,
                document_runtime_cache,
                context,
                library_id,
                &format!("{operation_id}:page:{index}"),
                store_epoch,
                &intent,
                &transfer_authority,
            )?;
            (prepared.read_set(), Some(prepared))
        };
        steps.push(PreparedMoveStep {
            page_id: page_id.clone(),
            source: source.source,
            source_document_id: source.source_document_id,
            source_database_id: source.source_database_id,
            same_data_source,
            source_authorization_fingerprint: source_fingerprint,
            source_state_hash,
            read_set,
            prepared_transfer,
        });
    }
    let mut prepared_indexes = Vec::new();
    let mut prepared_transfers = Vec::new();
    for (index, step) in steps.iter_mut().enumerate() {
        if let Some(prepared) = step.prepared_transfer.take() {
            prepared_indexes.push(index);
            prepared_transfers.push(prepared);
        }
    }
    let batch_documents = super::block_transfer::extract_agent_page_document_batch(
        &mut prepared_transfers,
        operation_id,
    )?;
    for (index, prepared) in prepared_indexes.into_iter().zip(prepared_transfers) {
        steps[index].read_set = prepared.read_set();
        steps[index].prepared_transfer = Some(prepared);
    }
    for step in &steps {
        merge_document_heads(&mut document_heads, &step.read_set.documents)?;
    }
    merge_document_heads(&mut document_heads, &batch_documents.document_heads())?;
    document_heads.sort_by(|left, right| left.document_id.cmp(&right.document_id));
    let parent_id = destination_parent_id(library_id, &request.destination);
    let before_id = destination_before_id(&destination);
    let mut targets = request
        .page_ids
        .iter()
        .map(|page_id| AgentResourceTarget {
            kind: AgentResourceKind::Page,
            id: page_id.clone(),
        })
        .collect::<Vec<_>>();
    targets.push(destination_footprint_target(
        library_id,
        &request.destination,
    ));
    let footprint = AgentOperationFootprint {
        effect_class: AgentEffectClass::Write,
        targets,
        created_roots: Vec::new(),
        updated_roots: request.page_ids.clone(),
        deleted_roots: Vec::new(),
        deleted_owner_roots: Vec::new(),
        ownership_transformations: request
            .page_ids
            .iter()
            .map(|page_id| AgentOwnershipTransformation {
                resource_id: page_id.clone(),
                parent_id: Some(parent_id.clone()),
                before_id: before_id.clone(),
            })
            .collect(),
    };
    let authority_revisions_hash = hash_serializable(&(
        source_fingerprints,
        destination_fingerprint,
        store_epoch,
        &destination,
        &actor_project_id,
        &steps,
        &document_heads,
    ))?;
    let footprint_hash = hash_serializable(&footprint)?;
    Ok(MovePreflight {
        binding: PreparedAgentOperationBinding {
            connection_id: context.connection_id.clone(),
            operation_id: operation_id.to_owned(),
            request_hash,
            authority_revisions_hash,
            footprint_hash,
            effect_class: AgentEffectClass::Write,
        },
        destination,
        destination_document,
        destination_database_id,
        actor_project_id,
        destination_authority_hash,
        steps,
        batch_documents: Some(batch_documents),
        document_heads,
        footprint,
    })
}

fn revalidate_preflight(
    connection: &Connection,
    context: &BoundModuleContext,
    library_id: &str,
    authorization: &AgentExecutionAuthorization,
    request: &LibraryAgentMovePagesRequest,
    preflight: &MovePreflight,
) -> Result<(), StoreError> {
    validate_request(request)?;
    assert_no_ownership_overlap(connection, &request.page_ids)?;
    let ResolvedDestination {
        destination: resolved_destination,
        authorization_fingerprint: destination_fingerprint,
        document_heads: destination_heads,
        database_id: destination_database_id,
        actor_project_id,
    } = resolve_destination(
        connection,
        context,
        library_id,
        authorization,
        &request.destination,
    )?;
    let destination = resolve_move_destination(
        connection,
        &request.destination,
        resolved_destination,
        &request.page_ids,
        library_id,
    )?;
    let destination_authority_hash = hash_serializable(&(
        destination_fingerprint,
        &destination,
        destination_heads,
        destination_database_id,
        &actor_project_id,
    ))?;
    if destination_authority_hash != preflight.destination_authority_hash
        || actor_project_id != preflight.actor_project_id
    {
        return Err(stale_preflight("Agent Page-move destination changed"));
    }
    if preflight.steps.len() != request.page_ids.len() {
        return Err(corrupt("Agent Page-move preparation lost a source step"));
    }
    preflight
        .batch_documents
        .as_ref()
        .ok_or_else(|| corrupt("Agent Page-move preparation lost its Document batch"))?
        .revalidate(connection)?;
    for (page_id, step) in request.page_ids.iter().zip(&preflight.steps) {
        if page_id != &step.page_id {
            return Err(corrupt("Agent Page-move preparation reordered its Pages"));
        }
        let source_authorization_fingerprint = super::agent_authorization::authorize_execution(
            connection,
            context,
            library_id,
            authorization,
            &nodex_core_contracts::agent::AgentAuthorizationTarget::Page {
                page_id: page_id.clone(),
            },
            nodex_core_contracts::agent::AgentProjectResourceAction::Move,
        )?;
        if source_authorization_fingerprint != step.source_authorization_fingerprint {
            return Err(stale_preflight("Agent Page-move authorization changed"));
        }
        let source = read_source(connection, library_id, page_id)?;
        if source.source != step.source
            || source.source_document_id != step.source_document_id
            || source.source_database_id != step.source_database_id
        {
            return Err(stale_preflight("Agent Page-move source changed"));
        }
        let source_state_hash = source_state_hash(connection, page_id, &preflight.destination)?;
        if source_state_hash != step.source_state_hash {
            return Err(stale_preflight("Agent Page-move source authority changed"));
        }
    }
    Ok(())
}

struct SourcePlacement {
    source: LibraryBlockTransferSource,
    source_document_id: Option<String>,
    source_database_id: Option<String>,
}

fn read_source(
    connection: &Connection,
    library_id: &str,
    page_id: &str,
) -> Result<SourcePlacement, StoreError> {
    let row = connection
        .query_row(
            "SELECT page.parent_kind, page.parent_id, containing.document_id, \
                    source.home_database_block_id, block.lifecycle, document.readiness \
             FROM pages page \
             JOIN blocks block ON block.id = page.block_id \
               AND block.library_id = page.library_id \
             JOIN documents document ON document.id = page.document_id \
               AND document.library_id = page.library_id \
             LEFT JOIN document_block_index containing ON containing.block_id = page.block_id \
             LEFT JOIN data_sources source ON source.id = page.parent_id \
               AND page.parent_kind = 'data_source' AND source.library_id = page.library_id \
             WHERE page.block_id = ?1 AND page.library_id = ?2 AND block.type = 'page'",
            params![page_id, library_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| not_found("Source Page is unavailable"))?;
    if row.4 != "active" || row.5 != "ready" {
        return Err(not_found("Source Page is unavailable"));
    }
    let (source, source_document_id, source_database_id) = match row.0.as_str() {
        "library" if row.1 == library_id => (
            LibraryBlockTransferSource::Library {
                library_id: library_id.to_owned(),
            },
            None,
            None,
        ),
        "page" => {
            let document_id = row
                .2
                .ok_or_else(|| corrupt("Page-owned source has no containing Document"))?;
            (
                LibraryBlockTransferSource::Page {
                    page_id: row.1.clone(),
                },
                Some(document_id),
                None,
            )
        }
        "data_source" => {
            let database_id = row
                .3
                .ok_or_else(|| corrupt("Data Source Page has no containing Database"))?;
            (
                LibraryBlockTransferSource::DataSource {
                    data_source_id: row.1.clone(),
                },
                None,
                Some(database_id),
            )
        }
        _ => return Err(corrupt("Source Page has inconsistent parent authority")),
    };
    Ok(SourcePlacement {
        source,
        source_document_id,
        source_database_id,
    })
}

fn source_state_hash(
    connection: &Connection,
    page_id: &str,
    destination: &LibraryPageCopyDestination,
) -> Result<String, StoreError> {
    let authority = connection
        .query_row(
            "SELECT block.placement_revision, block.metadata_revision, \
               membership.id, membership.revision \
             FROM pages page JOIN blocks block ON block.id = page.block_id \
             LEFT JOIN data_source_page_memberships membership \
               ON membership.page_block_id = page.block_id AND membership.removed_at IS NULL \
             WHERE page.block_id = ?1",
            [page_id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<i64>>(3)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| not_found("Source Page is unavailable"))?;
    let data_source_authority = if let LibraryPageCopyDestination::DataSource {
        data_source_id,
        view: Some(view),
        ..
    } = destination
    {
        let position_revision = connection
            .query_row(
                "SELECT revision FROM database_view_page_positions \
                 WHERE view_id = ?1 AND page_block_id = ?2",
                params![view.view_id, page_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()?;
        let config = connection
            .query_row(
                "SELECT config_json FROM database_views \
                 WHERE id = ?1 AND data_source_id = ?2 AND lifecycle = 'active'",
                params![view.view_id, data_source_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .ok_or_else(|| not_found("Agent Page-move target View is unavailable"))?;
        let config = serde_json::from_str::<serde_json::Value>(&config)
            .map_err(|_| corrupt("Agent Page-move target View config is invalid"))?;
        let group_property_id = config
            .pointer("/group/propertyId")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned);
        let group_value_revision = group_property_id
            .as_deref()
            .map(|property_id| {
                connection
                    .query_row(
                        "SELECT property_value.revision \
                         FROM data_source_page_memberships membership \
                         LEFT JOIN data_source_property_values property_value \
                           ON property_value.data_source_id = membership.data_source_id \
                          AND property_value.membership_id = membership.id \
                          AND property_value.property_id = ?3 \
                         WHERE membership.data_source_id = ?1 \
                           AND membership.page_block_id = ?2 \
                           AND membership.removed_at IS NULL",
                        params![data_source_id, page_id, property_id],
                        |row| row.get::<_, Option<i64>>(0),
                    )
                    .optional()
                    .map(|value| value.flatten())
            })
            .transpose()?;
        Some((position_revision, group_property_id, group_value_revision))
    } else {
        None
    };
    hash_serializable(&(authority, data_source_authority))
}

fn transfer_intent(
    library_id: &str,
    page_id: &str,
    source: &LibraryBlockTransferSource,
    destination: &LibraryPageCopyDestination,
    authorization: &AgentExecutionAuthorization,
) -> Result<LibraryBlockTransferLogicalIntent, StoreError> {
    let target = match destination {
        LibraryPageCopyDestination::Library { before } => LibraryBlockTransferTarget::Library {
            library_id: library_id.to_owned(),
            before_block_id: before.as_ref().map(|anchor| anchor.block_id.clone()),
        },
        LibraryPageCopyDestination::Page {
            page_id, before, ..
        } => LibraryBlockTransferTarget::Page {
            page_id: page_id.clone(),
            parent_block_id: None,
            before_block_id: before.as_ref().map(|anchor| anchor.block_id.clone()),
        },
        LibraryPageCopyDestination::DataSource {
            data_source_id,
            view,
            ..
        } => {
            let view = view
                .as_ref()
                .ok_or_else(|| corrupt("Agent Page-move target has no resolved View"))?;
            LibraryBlockTransferTarget::DataSource {
                data_source_id: data_source_id.clone(),
                placement: Box::new(LibraryBlockTransferDataSourcePlacement::Direct {
                    view_id: view.view_id.clone(),
                    preferences_override: Default::default(),
                    group_key: view.group_key.clone(),
                    before_page_id: view.before.as_ref().map(|anchor| anchor.page_id.clone()),
                    sorted_property_values: Vec::new(),
                }),
            }
        }
    };
    Ok(LibraryBlockTransferLogicalIntent {
        actor: agent_actor(authorization),
        mode: LibraryBlockTransferMode::Move,
        root_block_ids: vec![page_id.to_owned()],
        causal_dependencies: Vec::new(),
        source: source.clone(),
        target,
        promotion_policy: nodex_core_contracts::library::LibraryPagePromotionPolicy::Literal,
    })
}

fn agent_actor(authorization: &AgentExecutionAuthorization) -> serde_json::Value {
    let authority = &authorization.provenance.authority;
    json!({
        "kind": "nodex_agent",
        "tool": "move_pages",
        "threadId": authority.thread_id,
        "turnId": authority.turn_id,
        "callId": authorization.call_id,
    })
}

fn merge_document_heads(
    heads: &mut Vec<LibraryAgentDocumentHead>,
    additions: &[LibraryBlockTransferDocumentHead],
) -> Result<(), StoreError> {
    for addition in additions {
        if let Some(existing) = heads
            .iter()
            .find(|head| head.document_id == addition.document_id)
        {
            if existing.generation != addition.generation
                || existing.expected_head_seq != addition.expected_head_seq
            {
                return Err(StoreError::new(
                    StoreErrorCode::RevisionConflict,
                    format!(
                        "Document {} changed while preparing Agent Page movement",
                        addition.document_id
                    ),
                    true,
                ));
            }
            continue;
        }
        heads.push(LibraryAgentDocumentHead {
            document_id: addition.document_id.clone(),
            generation: addition.generation,
            expected_head_seq: addition.expected_head_seq,
        });
    }
    Ok(())
}

fn data_source_destination(
    destination: &LibraryPageCopyDestination,
) -> Result<PageCopyDataSourceDestination, StoreError> {
    let LibraryPageCopyDestination::DataSource {
        data_source_id,
        expected_data_source_revision,
        values,
        view,
    } = destination
    else {
        return Err(corrupt("Agent Page move lost its Data Source destination"));
    };
    Ok(PageCopyDataSourceDestination {
        data_source_id: data_source_id.clone(),
        expected_data_source_revision: *expected_data_source_revision,
        values: values
            .iter()
            .map(|value| PageCopyValueDraft {
                property_id: value.property_id.clone(),
                value: value.value.clone(),
            })
            .collect(),
        view: view.as_ref().map(|view| PageCopyViewPlacement {
            view_id: view.view_id.clone(),
            expected_view_revision: view.expected_view_revision,
            group_key: view.group_key.clone(),
            before: view.before.as_ref().map(|anchor| PageCopyPositionAnchor {
                page_id: anchor.page_id.clone(),
                expected_position_revision: anchor.expected_position_revision,
            }),
        }),
    })
}

fn transfer_authority(actor_project_id: &str) -> AgentPageMoveTransferAuthority {
    AgentPageMoveTransferAuthority {
        actor_project_id: actor_project_id.to_owned(),
    }
}

fn resolve_move_destination(
    connection: &Connection,
    request: &LibraryAgentPageDestination,
    destination: LibraryPageCopyDestination,
    moved_page_ids: &[String],
    library_id: &str,
) -> Result<LibraryPageCopyDestination, StoreError> {
    let moved = moved_page_ids
        .iter()
        .map(String::as_str)
        .collect::<HashSet<_>>();
    match (request, destination) {
        (
            LibraryAgentPageDestination::Library { at },
            LibraryPageCopyDestination::Library { .. },
        ) => {
            let ids = connection
                .prepare(
                    "SELECT placement.block_id FROM library_block_placements placement \
                     JOIN blocks block ON block.id = placement.block_id \
                     WHERE placement.library_id = ?1 \
                       AND block.library_id = placement.library_id \
                       AND block.lifecycle = 'active' \
                     ORDER BY placement.rank_key, placement.block_id",
                )?
                .query_map([library_id], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?
                .into_iter()
                .filter(|block_id| !moved.contains(block_id.as_str()))
                .collect::<Vec<_>>();
            let before_id = resolve_before_id(&ids, at.as_ref(), "Library")?;
            let before = before_id
                .map(|block_id| read_location_anchor(connection, &block_id))
                .transpose()?;
            Ok(LibraryPageCopyDestination::Library { before })
        }
        (
            LibraryAgentPageDestination::Page { at, .. },
            LibraryPageCopyDestination::Page {
                page_id,
                expected_document_generation,
                expected_document_head_seq,
                ..
            },
        ) => {
            let document_id = connection.query_row(
                "SELECT document_id FROM pages WHERE block_id = ?1",
                [&page_id],
                |row| row.get::<_, String>(0),
            )?;
            let ids = connection
                .prepare(
                    "SELECT entry.block_id FROM document_block_index entry \
                     JOIN blocks block ON block.id = entry.block_id \
                     WHERE entry.document_id = ?1 AND entry.parent_block_id IS NULL \
                       AND block.lifecycle = 'active' ORDER BY entry.ordinal, entry.block_id",
                )?
                .query_map([document_id], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?
                .into_iter()
                .filter(|block_id| !moved.contains(block_id.as_str()))
                .collect::<Vec<_>>();
            let before_id = resolve_before_id(&ids, at.as_ref(), "Destination Page")?;
            let before = before_id
                .map(|block_id| read_location_anchor(connection, &block_id))
                .transpose()?;
            Ok(LibraryPageCopyDestination::Page {
                page_id,
                expected_document_generation,
                expected_document_head_seq,
                before,
            })
        }
        (
            LibraryAgentPageDestination::DataSource { at, .. },
            LibraryPageCopyDestination::DataSource {
                data_source_id,
                expected_data_source_revision,
                values,
                view: Some(mut view),
            },
        ) => {
            let ids = connection
                .prepare(
                    "SELECT membership.page_block_id \
                     FROM data_source_page_memberships membership \
                     JOIN pages page ON page.block_id = membership.page_block_id \
                     LEFT JOIN database_view_page_positions position \
                       ON position.view_id = ?1 \
                      AND position.page_block_id = membership.page_block_id \
                     WHERE membership.data_source_id = ?2 \
                       AND membership.removed_at IS NULL \
                       AND EXISTS (SELECT 1 FROM blocks block \
                         WHERE block.id = page.block_id \
                           AND block.library_id = page.library_id \
                           AND block.lifecycle = 'active') \
                     ORDER BY CASE WHEN position.rank_key IS NULL THEN 1 ELSE 0 END, \
                       position.rank_key, membership.page_block_id",
                )?
                .query_map(params![view.view_id, data_source_id], |row| {
                    row.get::<_, String>(0)
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?
                .into_iter()
                .filter(|page_id| !moved.contains(page_id.as_str()))
                .collect::<Vec<_>>();
            let before_page_id = resolve_before_id(&ids, at.as_ref(), "Destination View")?;
            view.before = before_page_id
                .map(|page_id| {
                    let expected_position_revision = connection
                        .query_row(
                            "SELECT COALESCE(revision, 0) \
                             FROM database_view_page_positions \
                             WHERE view_id = ?1 AND page_block_id = ?2",
                            params![view.view_id, page_id],
                            |row| row.get::<_, i64>(0),
                        )
                        .optional()?
                        .unwrap_or(0);
                    Ok::<_, StoreError>(
                        nodex_core_contracts::library::LibraryPageCopyPositionAnchor {
                            page_id,
                            expected_position_revision,
                        },
                    )
                })
                .transpose()?;
            Ok(LibraryPageCopyDestination::DataSource {
                data_source_id,
                expected_data_source_revision,
                values,
                view: Some(view),
            })
        }
        (_, destination) => Ok(destination),
    }
}

fn validate_request(request: &LibraryAgentMovePagesRequest) -> Result<(), StoreError> {
    if request.page_ids.is_empty() || request.page_ids.len() > MAX_PAGES {
        return Err(invalid("move_pages requires between 1 and 16 Page IDs"));
    }
    let mut unique = HashSet::new();
    for page_id in &request.page_ids {
        validate_id(page_id, "page_ids")?;
        if !unique.insert(page_id.as_str()) {
            return Err(invalid("move_pages Page IDs must be unique"));
        }
    }
    if let LibraryAgentPageDestination::Page { page_id, .. } = &request.destination
        && unique.contains(page_id.as_str())
    {
        return Err(invalid("A moved Page cannot be its own destination Page"));
    }
    let anchor = match &request.destination {
        LibraryAgentPageDestination::Library { at }
        | LibraryAgentPageDestination::Page { at, .. }
        | LibraryAgentPageDestination::DataSource { at, .. } => at,
    };
    if let Some(
        nodex_core_contracts::library::LibraryAgentSiblingAnchor::Before { block_id }
        | nodex_core_contracts::library::LibraryAgentSiblingAnchor::After { block_id },
    ) = anchor
        && unique.contains(block_id.as_str())
    {
        return Err(invalid(
            "A Page move anchor must be outside the moved Page set",
        ));
    }
    Ok(())
}

fn assert_no_ownership_overlap(
    connection: &Connection,
    page_ids: &[String],
) -> Result<(), StoreError> {
    let selected = page_ids.iter().map(String::as_str).collect::<HashSet<_>>();
    for page_id in page_ids {
        let mut current = page_id.clone();
        let mut visited = HashSet::new();
        let mut reached_root = false;
        for _ in 0..256 {
            if !visited.insert(current.clone()) {
                return Err(corrupt("Page ownership hierarchy contains a cycle"));
            }
            let parent = connection
                .query_row(
                    "SELECT parent_kind, parent_id FROM pages WHERE block_id = ?1",
                    [&current],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )
                .optional()?
                .ok_or_else(|| not_found("Source Page is unavailable"))?;
            if parent.0 != "page" {
                reached_root = true;
                break;
            }
            if selected.contains(parent.1.as_str()) {
                return Err(invalid(
                    "Page moves cannot select both an ownership ancestor and its descendant",
                ));
            }
            current = parent.1;
        }
        if !reached_root {
            return Err(corrupt(
                "Page ownership hierarchy exceeds its supported depth",
            ));
        }
    }
    Ok(())
}

fn page_preparation(step: &PreparedMoveStep) -> LibraryAgentMovePagePreparation {
    LibraryAgentMovePagePreparation {
        page_id: step.page_id.clone(),
        source: step.source.clone(),
        source_document_id: step.source_document_id.clone(),
        source_database_id: step.source_database_id.clone(),
    }
}

fn destination_location(
    library_id: &str,
    destination: &LibraryAgentPageDestination,
) -> LibraryAgentPageLocation {
    match destination {
        LibraryAgentPageDestination::Library { .. } => LibraryAgentPageLocation::Library {
            library_id: library_id.to_owned(),
        },
        LibraryAgentPageDestination::Page { page_id, .. } => LibraryAgentPageLocation::Page {
            page_id: page_id.clone(),
        },
        LibraryAgentPageDestination::DataSource { data_source_id, .. } => {
            LibraryAgentPageLocation::DataSource {
                data_source_id: data_source_id.clone(),
            }
        }
    }
}

fn destination_parent_id(library_id: &str, destination: &LibraryAgentPageDestination) -> String {
    match destination {
        LibraryAgentPageDestination::Library { .. } => library_id.to_owned(),
        LibraryAgentPageDestination::Page { page_id, .. } => page_id.clone(),
        LibraryAgentPageDestination::DataSource { data_source_id, .. } => data_source_id.clone(),
    }
}

fn destination_parent_key(library_id: &str, destination: &LibraryAgentPageDestination) -> String {
    match destination {
        LibraryAgentPageDestination::Library { .. } => format!("library:{library_id}"),
        LibraryAgentPageDestination::Page { page_id, .. } => format!("page:{page_id}"),
        LibraryAgentPageDestination::DataSource { data_source_id, .. } => {
            format!("data_source:{data_source_id}")
        }
    }
}

fn source_parent_key(library_id: &str, source: &LibraryBlockTransferSource) -> String {
    match source {
        LibraryBlockTransferSource::Library { .. } => format!("library:{library_id}"),
        LibraryBlockTransferSource::Page { page_id } => format!("page:{page_id}"),
        LibraryBlockTransferSource::Document { document_id } => {
            format!("document:{document_id}")
        }
        LibraryBlockTransferSource::DataSource { data_source_id } => {
            format!("data_source:{data_source_id}")
        }
    }
}

fn committed_footprint(
    library_id: &str,
    result: &LibraryAgentMovePagesResult,
) -> AgentOperationFootprint {
    let location = result.pages.first().map(|page| &page.location);
    let parent_id = location.map(|location| match location {
        LibraryAgentPageLocation::Library { library_id } => library_id.clone(),
        LibraryAgentPageLocation::Page { page_id } => page_id.clone(),
        LibraryAgentPageLocation::DataSource { data_source_id } => data_source_id.clone(),
    });
    let mut targets = result
        .pages
        .iter()
        .map(|page| AgentResourceTarget {
            kind: AgentResourceKind::Page,
            id: page.page_id.clone(),
        })
        .collect::<Vec<_>>();
    if let Some(location) = location {
        targets.push(match location {
            LibraryAgentPageLocation::Library { .. } => AgentResourceTarget {
                kind: AgentResourceKind::Library,
                id: library_id.to_owned(),
            },
            LibraryAgentPageLocation::Page { page_id } => AgentResourceTarget {
                kind: AgentResourceKind::Page,
                id: page_id.clone(),
            },
            LibraryAgentPageLocation::DataSource { data_source_id } => AgentResourceTarget {
                kind: AgentResourceKind::Database,
                id: data_source_id.clone(),
            },
        });
    }
    AgentOperationFootprint {
        effect_class: AgentEffectClass::Write,
        targets,
        created_roots: Vec::new(),
        updated_roots: result
            .pages
            .iter()
            .map(|page| page.page_id.clone())
            .collect(),
        deleted_roots: Vec::new(),
        deleted_owner_roots: Vec::new(),
        ownership_transformations: result
            .pages
            .iter()
            .map(|page| AgentOwnershipTransformation {
                resource_id: page.page_id.clone(),
                parent_id: parent_id.clone(),
                before_id: None,
            })
            .collect(),
    }
}

fn request_hash(
    context: &BoundModuleContext,
    store_epoch: &str,
    authorization: &AgentExecutionAuthorization,
    request: &LibraryAgentMovePagesRequest,
) -> Result<String, StoreError> {
    hash_serializable(&(
        context,
        LIBRARY_CONTRACT_VERSION,
        store_epoch,
        authorization,
        request,
    ))
}

fn hash_serializable(value: &impl Serialize) -> Result<String, StoreError> {
    serde_json::to_vec(value)
        .map(|bytes| sha256(&bytes))
        .map_err(|_| corrupt("Agent Page-move authority cannot be fingerprinted"))
}

fn validate_id(value: &str, field: &str) -> Result<(), StoreError> {
    if value.is_empty()
        || value.len() > MAX_ID_BYTES
        || value
            .bytes()
            .any(|byte| byte.is_ascii_control() || byte.is_ascii_whitespace())
    {
        return Err(invalid(format!("{field} is invalid")));
    }
    Ok(())
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

fn stale_epoch() -> StoreError {
    StoreError::new(
        StoreErrorCode::StaleStoreEpoch,
        "Agent Page move targets a stale store epoch",
        true,
    )
}

fn stale_token() -> StoreError {
    StoreError::new(
        StoreErrorCode::RevisionConflict,
        "Agent Page-move preparation token is missing",
        true,
    )
}

fn stale_preflight(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::RevisionConflict, message, true)
}

fn reused() -> StoreError {
    StoreError::new(
        StoreErrorCode::IdempotencyKeyReused,
        "operation_id is already bound to another Agent Page move",
        false,
    )
}
