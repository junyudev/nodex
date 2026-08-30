use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex};

use nodex_core_contracts::agent::{
    AgentConsentRequirement, AgentEffectClass, AgentExecutionAuthorization,
    AgentOperationFootprint, AgentOperationPreparation, AgentOperationPreparationState,
    AgentOwnershipTransformation, AgentPreparedExecution, AgentResourceKind, AgentResourceTarget,
};
use nodex_core_contracts::library::{
    LibraryAgentCreatePagePreparation, LibraryAgentCreatePagesPreparation,
    LibraryAgentCreatePagesRequest, LibraryAgentCreatePagesResult, LibraryAgentCreatedPage,
    LibraryAgentDocumentHead, LibraryAgentPageDestination, LibraryAgentPageEtags,
    LibraryAgentPageLocation, LibraryPageCopyDestination, LibraryPageCopyValue, LibraryReadValue,
    LibraryResourceTarget,
};
use nodex_core_contracts::{
    AdapterKind, ApplyResponse, BoundModuleContext, LIBRARY_CONTRACT_VERSION, ModuleApplyRequest,
    ModuleName, ModuleReadSnapshot, StoreEpoch,
};
use rusqlite::{Connection, TransactionBehavior};
use serde_json::json;

use crate::database::{
    ExistingPageTransferTarget, PageCopyDataSourceDestination, PageCopyPositionAnchor,
    PageCopyValueDraft, PageCopyViewPlacement, StagedPagePlacementRevisions, active_property,
    current_page_key_for_page, normalize_value, place_staged_page_in_data_source_prevalidated,
    transfer_existing_page_for_agent_move_prevalidated,
};
use crate::document::{
    DocumentMaterialization, DocumentRuntimeCache, mint_document_semantic_etags,
    parse_inline_markdown_title, read_store_epoch, sha256,
};
use crate::domain::identity::stable_uuid_v7;
use crate::infrastructure::agent_operations::{
    PreparedAgentOperationBinding, PreparedAgentOperationRegistry,
};
use crate::infrastructure::durable_mutation::{self, DurableMutationScope, OperationIdentity};
use crate::infrastructure::module_receipts::read_module_receipt;
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};
use crate::infrastructure::writer::{StoreReaders, StoreWriter};

use super::LibraryApplyOutcome;
use super::agent_page_write::{
    ResolvedDestination, destination_before_id, destination_footprint_target, resolve_destination,
};
use super::block_transfer::{
    AppliedAgentPageDocumentBatch, PreparedAgentPageDocumentBatch, PreparedFreshPageGenesis,
};
use super::mutation::{MutationEffects, library_commit_result, seal_mutation_with, sqlite_now};

const MODULE_NAME: &str = "library";
const MAX_PAGES: usize = 16;
const MAX_TOTAL_NFM_BYTES: usize = 2 * 1024 * 1024;
const MAX_ID_BYTES: usize = 512;

struct PreparedPage {
    page_id: String,
    page_operation_id: String,
    body_block_ids: Vec<String>,
    primary_membership_id: String,
    target_membership_id: String,
    destination: LibraryPageCopyDestination,
    genesis: Option<PreparedFreshPageGenesis>,
}

struct CreatePreflight {
    binding: PreparedAgentOperationBinding,
    destination: LibraryPageCopyDestination,
    destination_document: Option<LibraryAgentDocumentHead>,
    destination_database_id: Option<String>,
    actor_project_id: String,
    destination_authority_hash: String,
    pages: Vec<PreparedPage>,
    batch_documents: Option<PreparedAgentPageDocumentBatch>,
    document_heads: Vec<LibraryAgentDocumentHead>,
    footprint: AgentOperationFootprint,
}

pub(super) struct PrepareCreatePagesInput {
    pub(super) operation_id: String,
    pub(super) expected_store_epoch: String,
    pub(super) authorization: nodex_core_contracts::agent::AgentExecutionAuthorization,
    pub(super) request: LibraryAgentCreatePagesRequest,
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
        preflight: Box<CreatePreflight>,
    },
}

pub(super) fn prepare_create_pages(
    readers: &StoreReaders,
    document_runtime_cache: &Arc<Mutex<DocumentRuntimeCache>>,
    registry: &PreparedAgentOperationRegistry,
    context: &BoundModuleContext,
    library_id: &str,
    input: PrepareCreatePagesInput,
) -> Result<ModuleReadSnapshot<LibraryReadValue>, StoreError> {
    let PrepareCreatePagesInput {
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
            .map_err(|_| corrupt("Stored Agent Page-create receipt is invalid"))?;
            committed.receipt.mutation.duplicate = true;
            let result = committed
                .value
                .agent_create_pages
                .as_ref()
                .ok_or_else(|| corrupt("Stored Library receipt is not an Agent Page create"))?;
            let footprint = committed_footprint(library_id.as_str(), result)?;
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
        } => {
            let result = committed
                .outcome()
                .agent_create_pages
                .as_ref()
                .expect("validated committed Agent Page create");
            Ok(ModuleReadSnapshot {
                contract_version: LIBRARY_CONTRACT_VERSION,
                store_epoch: StoreEpoch(store_epoch),
                commit_head,
                authorization: None,
                value: LibraryReadValue::AgentCreatePagesPreparation {
                    value: Box::new(LibraryAgentCreatePagesPreparation {
                        preparation: AgentOperationPreparation {
                            state: AgentOperationPreparationState::CommittedReplay,
                            consent: AgentConsentRequirement::None,
                            footprint,
                            preview_markdown: None,
                            token: None,
                            expires_at_unix_ms: None,
                        },
                        pages: result
                            .pages
                            .iter()
                            .enumerate()
                            .map(|(index, page)| {
                                committed_page_preparation(&operation_id, index, page)
                            })
                            .collect(),
                        document_heads: Vec::new(),
                        destination: None,
                        destination_document: None,
                        destination_database_id: None,
                        committed: Some(committed),
                    }),
                },
            })
        }
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
                value: LibraryReadValue::AgentCreatePagesPreparation {
                    value: Box::new(LibraryAgentCreatePagesPreparation {
                        preparation: AgentOperationPreparation {
                            state: AgentOperationPreparationState::Prepared,
                            consent: AgentConsentRequirement::None,
                            footprint: preflight.footprint,
                            preview_markdown: None,
                            token: Some(issued.token),
                            expires_at_unix_ms: Some(issued.expires_at_unix_ms),
                        },
                        pages: preflight.pages.iter().map(page_preparation).collect(),
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
pub(super) fn execute_create_pages(
    writer: &StoreWriter,
    readers: &StoreReaders,
    document_runtime_cache: &Arc<Mutex<DocumentRuntimeCache>>,
    registry: &PreparedAgentOperationRegistry,
    profile_id: &str,
    library_id: &str,
    context: &BoundModuleContext,
    request: ModuleApplyRequest<nodex_core_contracts::library::LibraryIntent>,
    authorization: AgentPreparedExecution,
    create_request: LibraryAgentCreatePagesRequest,
) -> Result<LibraryApplyOutcome, StoreError> {
    let profile_id = profile_id.to_owned();
    let library_id = library_id.to_owned();
    let context = context.clone();
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
            &create_request,
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
            &create_request,
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
            &create_request,
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
            .map_err(|_| corrupt("Stored Agent Page-create receipt is invalid"))?;
            if committed.value.agent_create_pages.is_none() {
                return Err(corrupt(
                    "Stored Library receipt is not an Agent Page create",
                ));
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
            corrupt("Agent Page create lost its execution preparation before commit")
        })?;
        revalidate_preflight(
            &transaction,
            &context,
            &library_id,
            &authorization.authorization,
            &create_request,
            &preflight,
        )?;
        let lease = prepared_lease.ok_or_else(stale_token)?;
        let mut agent_context = context.clone();
        agent_context.adapter = AdapterKind::Agent;
        let committed_at = sqlite_now(&transaction)?;
        let commit_result = durable_mutation::run(
            &transaction,
            OperationIdentity {
                module: ModuleName::Library,
                module_name: MODULE_NAME,
                operation_id: &operation_id,
                intent_hash: &request_hash,
                store_epoch: &store_epoch,
                committed_at: &committed_at,
                context: &agent_context,
            },
            |scope| {
                let execution = apply_pages(
                    &transaction,
                    &agent_context,
                    scope,
                    &library_id,
                    &operation_id,
                    &store_epoch,
                    &create_request,
                    &mut preflight,
                    &committed_at,
                )?;
                let created_target =
                    (execution.result.pages.len() == 1).then(|| LibraryResourceTarget::Page {
                        page_id: execution.result.pages[0].page_id.clone(),
                    });
                let document_batch = execution.document_batch;
                seal_mutation_with(
                    scope,
                    &agent_context,
                    &operation_id,
                    MutationEffects {
                        project_id: preflight.actor_project_id,
                        operation_kind: "agent_create_pages",
                        change_kind: "library.changed",
                        did_mutate: true,
                        created_target,
                        affected_parent_keys: vec![destination_parent_key(
                            &library_id,
                            &create_request.destination,
                        )],
                        affected_block_ids: execution.affected_block_ids,
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
                        agent_create_pages: Some(execution.result),
                        agent_move_pages: None,
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
        let outcome = library_commit_result(&transaction, commit_result)?;
        transaction.commit()?;
        Ok((outcome, Some(lease)))
    })?;
    if let Some(lease) = result.1 {
        lease.consume()?;
    }
    Ok(result.0)
}

struct CreateExecution {
    result: LibraryAgentCreatePagesResult,
    affected_block_ids: Vec<String>,
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
    context: &BoundModuleContext,
    scope: &DurableMutationScope<'_>,
    library_id: &str,
    operation_id: &str,
    store_epoch: &str,
    request: &LibraryAgentCreatePagesRequest,
    preflight: &mut CreatePreflight,
    committed_at: &str,
) -> Result<CreateExecution, StoreError> {
    let now = committed_at.to_owned();
    let mut created = Vec::with_capacity(preflight.pages.len());
    let mut affected_block_ids = BTreeSet::new();
    let mut affected_page_ids = BTreeSet::new();
    let mut affected_database_ids = BTreeSet::new();
    let mut affected_view_ids = BTreeSet::new();
    let mut affected_document_ids = BTreeSet::new();
    let mut committed_revisions = BTreeMap::new();
    let mut document_commits = Vec::new();
    let library_before = matches!(
        preflight.destination,
        LibraryPageCopyDestination::Library { .. }
    )
    .then(|| destination_before_id(&preflight.destination))
    .flatten();
    for page in &mut preflight.pages {
        let document_id = format!("document:{}", page.page_id);
        let staged = super::block_transfer::stage_prepared_fresh_page_in_library(
            connection,
            scope.evidence(),
            library_id,
            &preflight.actor_project_id,
            &page.page_operation_id,
            store_epoch,
            &page.page_id,
            &document_id,
            library_before.as_deref(),
            &now,
            page.genesis
                .take()
                .ok_or_else(|| corrupt("Prepared Page genesis disappeared"))?,
        )?;
        if staged.body_block_ids != page.body_block_ids {
            return Err(StoreError::new(
                StoreErrorCode::RevisionConflict,
                "Prepared Page body identities no longer match its Nested Markdown",
                true,
            ));
        }
        affected_block_ids.insert(page.page_id.clone());
        affected_block_ids.extend(page.body_block_ids.iter().cloned());
        affected_page_ids.insert(page.page_id.clone());
        affected_document_ids.insert(staged.document_id.clone());
        committed_revisions.insert(format!("blockLocation:{}", page.page_id), 1);
        committed_revisions.insert(format!("blockMetadata:{}", page.page_id), 1);
        committed_revisions.insert(format!("pageParent:{}", page.page_id), 1);
        committed_revisions.insert(
            format!("documentHead:{}", staged.document_id),
            staged.document_head_seq,
        );

        match &page.destination {
            LibraryPageCopyDestination::Library { .. } => {}
            LibraryPageCopyDestination::DataSource { .. } => {
                let destination = data_source_destination(&page.destination)?;
                let placement = place_staged_page_in_data_source_prevalidated(
                    connection,
                    library_id,
                    &preflight.actor_project_id,
                    &page.page_id,
                    &destination,
                    StagedPagePlacementRevisions {
                        location_revision: 1,
                        metadata_revision: 1,
                        parent_revision: 1,
                    },
                    &now,
                )?;
                affected_database_ids.insert(placement.database_id.clone());
                affected_view_ids.extend(placement.affected_view_ids.iter().cloned());
                committed_revisions.insert(
                    format!("blockLocation:{}", page.page_id),
                    placement.location_revision,
                );
                committed_revisions.insert(
                    format!("blockMetadata:{}", page.page_id),
                    placement.metadata_revision,
                );
                committed_revisions.insert(
                    format!("pageParent:{}", page.page_id),
                    placement.parent_revision,
                );
                committed_revisions.insert(
                    format!(
                        "membership:{}:{}",
                        placement.data_source_id, placement.membership_id
                    ),
                    1,
                );
                for (property_id, revision) in placement.value_revisions {
                    committed_revisions.insert(
                        format!(
                            "propertyValue:{}:{}:{}",
                            placement.data_source_id, page.page_id, property_id
                        ),
                        revision,
                    );
                }
                if let (Some(view), Some(revision)) =
                    (destination.view.as_ref(), placement.position_revision)
                {
                    committed_revisions.insert(
                        format!("viewPosition:{}:{}", view.view_id, page.page_id),
                        revision,
                    );
                }
            }
            LibraryPageCopyDestination::Page {
                page_id: target_page_id,
                ..
            } => {
                let placement = transfer_existing_page_for_agent_move_prevalidated(
                    connection,
                    library_id,
                    &preflight.actor_project_id,
                    &page.page_id,
                    1,
                    0,
                    ExistingPageTransferTarget::Page {
                        page_id: target_page_id,
                    },
                    &now,
                    false,
                )?;
                affected_page_ids.insert(target_page_id.clone());
                affected_database_ids.extend(placement.affected_database_ids);
                affected_view_ids.extend(placement.affected_view_ids);
                committed_revisions.extend(placement.committed_revisions);
                committed_revisions.insert(
                    format!("blockLocation:{}", page.page_id),
                    placement.location_revision,
                );
                committed_revisions.insert(
                    format!("blockMetadata:{}", page.page_id),
                    placement.metadata_revision,
                );
                committed_revisions.insert(
                    format!("pageParent:{}", page.page_id),
                    placement.parent_revision,
                );
            }
        }
        let etags = request
            .include_etags
            .then(|| {
                mint_etags(
                    connection,
                    &context_project_id(context)?,
                    store_epoch,
                    &staged.document_id,
                    &staged.materialization,
                )
            })
            .transpose()?;
        created.push(LibraryAgentCreatedPage {
            page_id: page.page_id.clone(),
            page_key: current_page_key_for_page(connection, library_id, &page.page_id)?,
            location: page_location(library_id, &request.destination),
            body_blocks_created: u32::try_from(page.body_block_ids.len())
                .map_err(|_| invalid("Created Page body exceeds its block bound"))?,
            block_ids: page.body_block_ids.clone(),
            etags,
        });
    }
    let document_batch = super::block_transfer::apply_agent_page_document_batch(
        connection,
        scope,
        context
            .project_id
            .as_ref()
            .map(|project_id| project_id.0.as_str())
            .ok_or_else(|| unauthorized("Agent Page create requires a bound Project"))?,
        operation_id,
        store_epoch,
        preflight
            .batch_documents
            .take()
            .ok_or_else(|| corrupt("Agent Page create omitted its prepared Document batch"))?,
    )?;
    document_commits.extend(document_batch.document_commits());
    for commit in &document_commits {
        committed_revisions.insert(
            format!("documentHead:{}", commit.document_id),
            commit.head_seq,
        );
    }
    affected_document_ids.extend(
        document_commits
            .iter()
            .map(|commit| commit.document_id.clone()),
    );
    Ok(CreateExecution {
        result: LibraryAgentCreatePagesResult {
            pages: created,
            document_commits,
            affected_database_ids: affected_database_ids.into_iter().collect(),
        },
        affected_block_ids: affected_block_ids.into_iter().collect(),
        affected_page_ids: affected_page_ids.into_iter().collect(),
        affected_view_ids: affected_view_ids.into_iter().collect(),
        affected_document_ids: affected_document_ids.into_iter().collect(),
        committed_revisions,
        document_batch,
        committed_at: now,
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
    authorization: &nodex_core_contracts::agent::AgentExecutionAuthorization,
    request: &LibraryAgentCreatePagesRequest,
    request_hash: String,
) -> Result<CreatePreflight, StoreError> {
    validate_request(request)?;
    let base_destination = destination_without_values(&request.destination)?;
    let ResolvedDestination {
        destination,
        authorization_fingerprint,
        mut document_heads,
        database_id: destination_database_id,
        actor_project_id,
    } = resolve_destination(
        connection,
        context,
        library_id,
        authorization,
        &base_destination,
    )?;
    let destination_document = matches!(
        request.destination,
        LibraryAgentPageDestination::Page { .. }
    )
    .then(|| document_heads.first().cloned())
    .flatten();
    let destination_authority_hash = hash_serializable(&(
        &authorization_fingerprint,
        &destination,
        &document_heads,
        &destination_database_id,
        &actor_project_id,
    ))?;
    let mut pages = Vec::with_capacity(request.pages.len());
    let mut created_roots = Vec::new();
    for (index, draft) in request.pages.iter().enumerate() {
        validate_values(connection, &request.destination, &draft.values)?;
        let page_operation_id = format!("{operation_id}:page:{index}");
        let page_id = stable_uuid_v7(operation_id, "agent_create_page", &index.to_string());
        let rich_title = parse_inline_markdown_title(&draft.title_markdown)
            .map_err(|error| invalid(error.to_string()))?;
        let document_id = format!("document:{page_id}");
        let genesis = super::block_transfer::prepare_fresh_page_genesis(
            &page_operation_id,
            &document_id,
            "agent_create_body",
            &rich_title,
            &draft.nfm,
        )?;
        let body_block_ids = genesis.body_block_ids.clone();
        let primary_membership_id = allocation_id(&page_operation_id, "primary-membership");
        let target_membership_id = match &request.destination {
            LibraryAgentPageDestination::DataSource { data_source_id, .. } => {
                format!(
                    "membership:{}",
                    sha256(format!("{data_source_id}\0{page_id}").as_bytes())
                )
            }
            _ => allocation_id(&page_operation_id, "target-membership"),
        };
        created_roots.push(page_id.clone());
        created_roots.extend(body_block_ids.iter().cloned());
        pages.push(PreparedPage {
            page_id,
            page_operation_id,
            body_block_ids,
            primary_membership_id,
            target_membership_id,
            destination: destination_with_values(&destination, &draft.values),
            genesis: Some(genesis),
        });
    }
    let batch_documents = super::block_transfer::prepare_agent_created_page_document_batch(
        connection,
        document_runtime_cache,
        library_id,
        &destination,
        &pages
            .iter()
            .map(|page| page.page_id.clone())
            .collect::<Vec<_>>(),
    )?;
    for head in batch_documents.document_heads() {
        if let Some(existing) = document_heads
            .iter()
            .find(|existing| existing.document_id == head.document_id)
        {
            if existing.generation != head.generation
                || existing.expected_head_seq != head.expected_head_seq
            {
                return Err(StoreError::new(
                    StoreErrorCode::RevisionConflict,
                    format!(
                        "Document {} changed while preparing Agent Page creation",
                        head.document_id
                    ),
                    true,
                ));
            }
            continue;
        }
        document_heads.push(LibraryAgentDocumentHead {
            document_id: head.document_id,
            generation: head.generation,
            expected_head_seq: head.expected_head_seq,
        });
    }
    document_heads.sort_by(|left, right| left.document_id.cmp(&right.document_id));
    let target = destination_footprint_target(library_id, &request.destination);
    let parent_id = match &request.destination {
        LibraryAgentPageDestination::Library { .. } => library_id.to_owned(),
        LibraryAgentPageDestination::Page { page_id, .. } => page_id.clone(),
        LibraryAgentPageDestination::DataSource { data_source_id, .. } => data_source_id.clone(),
    };
    let footprint = AgentOperationFootprint {
        effect_class: AgentEffectClass::Write,
        targets: vec![target],
        created_roots,
        updated_roots: Vec::new(),
        deleted_roots: Vec::new(),
        deleted_owner_roots: Vec::new(),
        ownership_transformations: pages
            .iter()
            .map(|page| AgentOwnershipTransformation {
                resource_id: page.page_id.clone(),
                parent_id: Some(parent_id.clone()),
                before_id: destination_before_id(&page.destination),
            })
            .collect(),
    };
    let authority_revisions_hash = hash_serializable(&(
        authorization_fingerprint,
        store_epoch,
        &destination,
        &actor_project_id,
        &document_heads,
        pages
            .iter()
            .map(|page| (&page.page_id, &page.body_block_ids, &page.destination))
            .collect::<Vec<_>>(),
    ))?;
    let footprint_hash = hash_serializable(&footprint)?;
    Ok(CreatePreflight {
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
        pages,
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
    request: &LibraryAgentCreatePagesRequest,
    preflight: &CreatePreflight,
) -> Result<(), StoreError> {
    validate_request(request)?;
    let base_destination = destination_without_values(&request.destination)?;
    let ResolvedDestination {
        destination,
        authorization_fingerprint,
        document_heads,
        database_id: destination_database_id,
        actor_project_id,
    } = resolve_destination(
        connection,
        context,
        library_id,
        authorization,
        &base_destination,
    )?;
    let destination_authority_hash = hash_serializable(&(
        authorization_fingerprint,
        destination,
        document_heads,
        destination_database_id,
        &actor_project_id,
    ))?;
    if destination_authority_hash != preflight.destination_authority_hash
        || actor_project_id != preflight.actor_project_id
    {
        return Err(StoreError::new(
            StoreErrorCode::RevisionConflict,
            "Agent Page-create destination changed while it was prepared",
            true,
        ));
    }
    preflight
        .batch_documents
        .as_ref()
        .ok_or_else(|| corrupt("Agent Page-create preparation lost its Document batch"))?
        .revalidate(connection)
}

fn validate_request(request: &LibraryAgentCreatePagesRequest) -> Result<(), StoreError> {
    if request.pages.is_empty() || request.pages.len() > MAX_PAGES {
        return Err(invalid(
            "create_pages requires between 1 and 16 Page drafts",
        ));
    }
    let total_nfm_bytes = request
        .pages
        .iter()
        .try_fold(0usize, |total, page| total.checked_add(page.nfm.len()))
        .ok_or_else(|| invalid("create_pages Nested Markdown size overflowed"))?;
    if total_nfm_bytes > MAX_TOTAL_NFM_BYTES {
        return Err(invalid(
            "create_pages exceeds the 2 MiB aggregate Nested Markdown limit",
        ));
    }
    if let LibraryAgentPageDestination::DataSource { values, .. } = &request.destination
        && !values.is_empty()
    {
        return Err(invalid(
            "create_pages Data Source values belong to each Page draft",
        ));
    }
    if !matches!(
        request.destination,
        LibraryAgentPageDestination::DataSource { .. }
    ) && request.pages.iter().any(|page| !page.values.is_empty())
    {
        return Err(invalid(
            "create_pages initial values require a Data Source destination",
        ));
    }
    Ok(())
}

fn validate_values(
    connection: &Connection,
    destination: &LibraryAgentPageDestination,
    values: &[LibraryPageCopyValue],
) -> Result<(), StoreError> {
    if values.len() > 512 {
        return Err(invalid("Page draft values exceed their bound"));
    }
    let LibraryAgentPageDestination::DataSource { data_source_id, .. } = destination else {
        return Ok(());
    };
    let mut ids = BTreeSet::new();
    for value in values {
        validate_id(&value.property_id, "pages.values.property_id")?;
        if !ids.insert(value.property_id.as_str()) {
            return Err(invalid(format!(
                "Page draft repeats Property {}",
                value.property_id
            )));
        }
        let property = active_property(connection, data_source_id, &value.property_id)?;
        normalize_value(&property, &value.value)?;
    }
    Ok(())
}

fn destination_without_values(
    destination: &LibraryAgentPageDestination,
) -> Result<LibraryAgentPageDestination, StoreError> {
    Ok(match destination {
        LibraryAgentPageDestination::Library { at } => {
            LibraryAgentPageDestination::Library { at: at.clone() }
        }
        LibraryAgentPageDestination::Page { page_id, at } => LibraryAgentPageDestination::Page {
            page_id: page_id.clone(),
            at: at.clone(),
        },
        LibraryAgentPageDestination::DataSource {
            data_source_id,
            values,
            view_id,
            group_key,
            at,
        } => {
            if !values.is_empty() {
                return Err(invalid(
                    "create_pages destination cannot carry shared Property values",
                ));
            }
            LibraryAgentPageDestination::DataSource {
                data_source_id: data_source_id.clone(),
                values: Vec::new(),
                view_id: view_id.clone(),
                group_key: group_key.clone(),
                at: at.clone(),
            }
        }
    })
}

fn destination_with_values(
    destination: &LibraryPageCopyDestination,
    values: &[LibraryPageCopyValue],
) -> LibraryPageCopyDestination {
    match destination {
        LibraryPageCopyDestination::DataSource {
            data_source_id,
            expected_data_source_revision,
            view,
            ..
        } => LibraryPageCopyDestination::DataSource {
            data_source_id: data_source_id.clone(),
            expected_data_source_revision: *expected_data_source_revision,
            values: values.to_vec(),
            view: view.clone(),
        },
        value => value.clone(),
    }
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
        return Err(corrupt("Created Page lost its Data Source destination"));
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
            before: view.before.as_ref().map(|before| PageCopyPositionAnchor {
                page_id: before.page_id.clone(),
                expected_position_revision: before.expected_position_revision,
            }),
        }),
    })
}

fn agent_actor(authorization: &AgentExecutionAuthorization) -> serde_json::Value {
    let authority = &authorization.provenance.authority;
    json!({
        "kind": "nodex_agent",
        "tool": "create_pages",
        "threadId": authority.thread_id,
        "turnId": authority.turn_id,
        "callId": authorization.call_id,
    })
}

fn mint_etags(
    connection: &Connection,
    actor_project_id: &str,
    store_epoch: &str,
    document_id: &str,
    materialization: &DocumentMaterialization,
) -> Result<LibraryAgentPageEtags, StoreError> {
    let (title, body) = mint_document_semantic_etags(
        connection,
        actor_project_id,
        store_epoch,
        document_id,
        materialization,
    )
    .map_err(|error| internal(format!("Created Page ETags could not be minted: {error:?}")))?;
    Ok(LibraryAgentPageEtags { title, body })
}

fn page_location(
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

fn page_preparation(page: &PreparedPage) -> LibraryAgentCreatePagePreparation {
    LibraryAgentCreatePagePreparation {
        page_id: page.page_id.clone(),
        body_block_ids: page.body_block_ids.clone(),
        primary_membership_id: page.primary_membership_id.clone(),
        target_membership_id: page.target_membership_id.clone(),
    }
}

fn committed_page_preparation(
    operation_id: &str,
    index: usize,
    page: &LibraryAgentCreatedPage,
) -> LibraryAgentCreatePagePreparation {
    let page_operation_id = format!("{operation_id}:page:{index}");
    LibraryAgentCreatePagePreparation {
        page_id: page.page_id.clone(),
        body_block_ids: page.block_ids.clone(),
        primary_membership_id: allocation_id(&page_operation_id, "primary-membership"),
        target_membership_id: allocation_id(&page_operation_id, "target-membership"),
    }
}

fn committed_footprint(
    library_id: &str,
    result: &LibraryAgentCreatePagesResult,
) -> Result<AgentOperationFootprint, StoreError> {
    let location = result
        .pages
        .first()
        .map(|page| &page.location)
        .ok_or_else(|| corrupt("Committed Agent Page-create batch is empty"))?;
    if result.pages.iter().any(|page| &page.location != location) {
        return Err(corrupt(
            "Committed Agent Page-create batch has divergent destinations",
        ));
    }
    let target = match location {
        LibraryAgentPageLocation::Library { library_id } => AgentResourceTarget {
            kind: AgentResourceKind::Library,
            id: library_id.clone(),
        },
        LibraryAgentPageLocation::Page { page_id } => AgentResourceTarget {
            kind: AgentResourceKind::Page,
            id: page_id.clone(),
        },
        LibraryAgentPageLocation::DataSource { data_source_id } => AgentResourceTarget {
            kind: AgentResourceKind::Database,
            id: data_source_id.clone(),
        },
    };
    let parent_id = match location {
        LibraryAgentPageLocation::Library { .. } => library_id.to_owned(),
        LibraryAgentPageLocation::Page { page_id } => page_id.clone(),
        LibraryAgentPageLocation::DataSource { data_source_id } => data_source_id.clone(),
    };
    Ok(AgentOperationFootprint {
        effect_class: AgentEffectClass::Write,
        targets: vec![target],
        created_roots: result
            .pages
            .iter()
            .flat_map(|page| {
                std::iter::once(page.page_id.clone()).chain(page.block_ids.iter().cloned())
            })
            .collect(),
        updated_roots: Vec::new(),
        deleted_roots: Vec::new(),
        deleted_owner_roots: Vec::new(),
        ownership_transformations: result
            .pages
            .iter()
            .map(|page| AgentOwnershipTransformation {
                resource_id: page.page_id.clone(),
                parent_id: Some(parent_id.clone()),
                before_id: None,
            })
            .collect(),
    })
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

fn allocation_id(operation_id: &str, role: &str) -> String {
    format!(
        "membership:{}",
        sha256(format!("{operation_id}\0{role}").as_bytes())
    )
}

fn context_project_id(context: &BoundModuleContext) -> Result<String, StoreError> {
    context
        .project_id
        .as_ref()
        .map(|project_id| project_id.0.clone())
        .ok_or_else(|| unauthorized("Agent Page creation requires an actor Project"))
}

fn request_hash(
    context: &BoundModuleContext,
    store_epoch: &str,
    authorization: &nodex_core_contracts::agent::AgentExecutionAuthorization,
    request: &LibraryAgentCreatePagesRequest,
) -> Result<String, StoreError> {
    let fingerprint = serde_json::to_vec(&(
        "nodex.agent.create-pages.v1",
        &context.profile_id,
        &context.library_id,
        &context.project_id,
        store_epoch,
        authorization,
        request,
    ))
    .map_err(|_| invalid("Agent Page-create request cannot be fingerprinted"))?;
    Ok(sha256(&fingerprint))
}

fn hash_serializable(value: &impl serde::Serialize) -> Result<String, StoreError> {
    serde_json::to_vec(value)
        .map(|bytes| sha256(&bytes))
        .map_err(|_| invalid("Agent Page-create authority cannot be fingerprinted"))
}

fn validate_id(value: &str, field: &str) -> Result<(), StoreError> {
    if !value.is_empty() && value.len() <= MAX_ID_BYTES && value.trim() == value {
        return Ok(());
    }
    Err(invalid(format!("{field} is invalid")))
}

fn stale_epoch() -> StoreError {
    StoreError::new(
        StoreErrorCode::StaleStoreEpoch,
        "Agent Page creation targets a stale store epoch",
        true,
    )
}

fn stale_token() -> StoreError {
    StoreError::new(
        StoreErrorCode::RevisionConflict,
        "Prepared Agent Page creation is stale or missing its execution token",
        true,
    )
}

fn reused() -> StoreError {
    StoreError::new(
        StoreErrorCode::IdempotencyKeyReused,
        "operation_id is already bound to another Agent Page creation",
        false,
    )
}

fn invalid(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message, false)
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
