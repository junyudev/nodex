use std::collections::BTreeSet;
use std::path::Path;

use nodex_core_contracts::agent::{
    AgentConsentRequirement, AgentEffectClass, AgentOperationFootprint, AgentOperationPreparation,
    AgentOperationPreparationState, AgentOwnershipTransformation, AgentPreparedExecution,
    AgentProjectResourceAction, AgentResourceKind, AgentResourceTarget,
};
use nodex_core_contracts::library::{
    LibraryAgentDocumentHead, LibraryAgentPageCopyPreparation, LibraryAgentPageCopyRequest,
    LibraryAgentPageCopyResult, LibraryAgentPageDestination, LibraryAgentPageEtags,
    LibraryAgentPageLocation, LibraryAgentSiblingAnchor, LibraryPageCopyDestination,
    LibraryPageCopyPositionAnchor, LibraryPageCopyValue, LibraryPageCopyViewPlacement,
    LibraryPlacementAnchor, LibraryReadValue, LibraryResourceTarget,
};
use nodex_core_contracts::{
    AdapterKind, ApplyResponse, BoundModuleContext, LIBRARY_CONTRACT_VERSION, ModuleApplyRequest,
    ModuleName, ModuleReadSnapshot, StoreEpoch,
};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};

use crate::database::current_page_key_for_page;
use crate::document::{read_store_epoch, sha256};
use crate::infrastructure::agent_operations::{
    PreparedAgentOperationBinding, PreparedAgentOperationRegistry,
};
use crate::infrastructure::durable_mutation::{self, OperationIdentity};
use crate::infrastructure::module_receipts::read_module_receipt;
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};
use crate::infrastructure::writer::{StoreReaders, StoreWriter};

use super::LibraryApplyOutcome;
use super::mutation::{MutationEffects, library_commit_result, seal_mutation, sqlite_now};
use super::page_copy::{PageCopyParentDocumentMode, preview_page_copy};

const MODULE_NAME: &str = "library";
const MAX_ID_BYTES: usize = 512;

struct SourceAuthority {
    library_id: String,
    location_revision: i64,
    parent_revision: i64,
    active_membership_revision: i64,
    document_id: String,
    document_generation: i64,
    document_head_seq: i64,
}

struct CopyPreflight {
    binding: PreparedAgentOperationBinding,
    destination: LibraryPageCopyDestination,
    destination_document: Option<LibraryAgentDocumentHead>,
    destination_database_id: Option<String>,
    source: SourceAuthority,
    page_id: String,
    body_block_count: u32,
    document_heads: Vec<LibraryAgentDocumentHead>,
    footprint: AgentOperationFootprint,
}

pub(super) struct ResolvedDestination {
    pub(super) destination: LibraryPageCopyDestination,
    pub(super) authorization_fingerprint: String,
    pub(super) document_heads: Vec<LibraryAgentDocumentHead>,
    pub(super) database_id: Option<String>,
    /// Project-scoped actor/event-delivery coordinate; never a content owner.
    pub(super) actor_project_id: String,
}

pub(super) struct PreparePageCopyInput {
    pub(super) operation_id: String,
    pub(super) expected_store_epoch: String,
    pub(super) authorization: nodex_core_contracts::agent::AgentExecutionAuthorization,
    pub(super) request: LibraryAgentPageCopyRequest,
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
        preflight: Box<CopyPreflight>,
    },
}

pub(super) fn prepare_page_copy(
    readers: &StoreReaders,
    registry: &PreparedAgentOperationRegistry,
    context: &BoundModuleContext,
    library_id: &str,
    input: PreparePageCopyInput,
) -> Result<ModuleReadSnapshot<LibraryReadValue>, StoreError> {
    let PreparePageCopyInput {
        operation_id,
        expected_store_epoch,
        authorization,
        request,
    } = input;
    validate_id(&operation_id, "operation_id")?;
    let context = context.clone();
    let library_id = library_id.to_owned();
    let preparation = readers.read_default(|connection| {
        let transaction = connection.unchecked_transaction()?;
        let store_epoch = read_store_epoch(&transaction)?;
        if store_epoch != expected_store_epoch {
            return Err(StoreError::new(
                StoreErrorCode::StaleStoreEpoch,
                "Agent Page copy targets a stale store epoch",
                true,
            ));
        }
        let commit_head = super::navigation::commit_head(&transaction)?;
        let request_hash = request_hash(&context, &store_epoch, &authorization, &request)?;
        if let Some(stored) = read_module_receipt(&transaction, MODULE_NAME, &operation_id)? {
            if stored.request_hash != request_hash {
                return Err(StoreError::new(
                    StoreErrorCode::IdempotencyKeyReused,
                    "operation_id is already bound to another Agent Page copy",
                    false,
                ));
            }
            let local_commit_seq = stored.local_commit_seq;
            let mut committed = serde_json::from_value::<
                crate::ModuleWriterResult<
                    nodex_core_contracts::library::LibraryCommitValue,
                    nodex_core_contracts::library::LibraryReceipt,
                >,
            >(stored.result)
            .map_err(|_| corrupt("Stored Agent Page copy receipt is invalid"))?;
            committed.receipt.mutation.duplicate = true;
            let result = committed
                .value
                .agent_page_copy
                .as_ref()
                .ok_or_else(|| corrupt("Stored Library receipt is not an Agent Page copy"))?;
            let footprint = committed_footprint(result)?;
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
                .agent_page_copy
                .as_ref()
                .expect("validated committed Agent copy");
            Ok(ModuleReadSnapshot {
                contract_version: LIBRARY_CONTRACT_VERSION,
                store_epoch: StoreEpoch(store_epoch),
                commit_head,
                authorization: None,
                value: LibraryReadValue::AgentPageCopyPreparation {
                    value: Box::new(LibraryAgentPageCopyPreparation {
                        preparation: AgentOperationPreparation {
                            state: AgentOperationPreparationState::CommittedReplay,
                            consent: AgentConsentRequirement::None,
                            footprint,
                            preview_markdown: None,
                            token: None,
                            expires_at_unix_ms: None,
                        },
                        page_id: result.page_id.clone(),
                        body_block_count: result.body_blocks_created,
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
                value: LibraryReadValue::AgentPageCopyPreparation {
                    value: Box::new(LibraryAgentPageCopyPreparation {
                        preparation: AgentOperationPreparation {
                            state: AgentOperationPreparationState::Prepared,
                            consent: AgentConsentRequirement::None,
                            footprint: preflight.footprint,
                            preview_markdown: None,
                            token: Some(issued.token),
                            expires_at_unix_ms: Some(issued.expires_at_unix_ms),
                        },
                        page_id: preflight.page_id,
                        body_block_count: preflight.body_block_count,
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
pub(super) fn execute_page_copy(
    writer: &StoreWriter,
    registry: &PreparedAgentOperationRegistry,
    profile_id: &str,
    library_id: &str,
    context: &BoundModuleContext,
    request: ModuleApplyRequest<nodex_core_contracts::library::LibraryIntent>,
    authorization: AgentPreparedExecution,
    copy_request: LibraryAgentPageCopyRequest,
    assets_root: &Path,
) -> Result<LibraryApplyOutcome, StoreError> {
    let profile_id = profile_id.to_owned();
    let library_id = library_id.to_owned();
    let context = context.clone();
    let registry = registry.clone();
    let assets_root = assets_root.to_path_buf();
    let operation_id = request.operation_id;
    let expected_store_epoch = request.store_epoch.0;
    let result = writer.call(move |connection| {
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        super::mutation::assert_identity(&transaction, &profile_id, &library_id)?;
        let store_epoch = read_store_epoch(&transaction)?;
        if store_epoch != expected_store_epoch {
            return Err(StoreError::new(
                StoreErrorCode::StaleStoreEpoch,
                "Agent Page copy targets a stale store epoch",
                true,
            ));
        }
        let request_hash = request_hash(
            &context,
            &store_epoch,
            &authorization.authorization,
            &copy_request,
        )?;
        if let Some(stored) = read_module_receipt(&transaction, MODULE_NAME, &operation_id)? {
            if stored.request_hash != request_hash {
                return Err(StoreError::new(
                    StoreErrorCode::IdempotencyKeyReused,
                    "operation_id is already bound to another Agent Page copy",
                    false,
                ));
            }
            let mut committed = serde_json::from_value::<
                crate::ModuleWriterResult<
                    nodex_core_contracts::library::LibraryCommitValue,
                    nodex_core_contracts::library::LibraryReceipt,
                >,
            >(stored.result)
            .map_err(|_| corrupt("Stored Agent Page copy receipt is invalid"))?;
            if committed.value.agent_page_copy.is_none() {
                return Err(corrupt("Stored Library receipt is not an Agent Page copy"));
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
        let preflight = compile_preflight(
            &transaction,
            &context,
            &library_id,
            &operation_id,
            &store_epoch,
            &authorization.authorization,
            &copy_request,
            request_hash.clone(),
        )?;
        let token = authorization.token.as_deref().ok_or_else(stale)?;
        let lease = registry.acquire(token, &preflight.binding)?;
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
                let execution = super::page_copy::execute_page_copy(
                    &transaction,
                    &agent_context,
                    scope.evidence(),
                    &store_epoch,
                    &library_id,
                    &operation_id,
                    &copy_request.source_page_id,
                    preflight.source.location_revision,
                    preflight.source.parent_revision,
                    preflight.source.active_membership_revision,
                    preflight.source.document_generation,
                    preflight.source.document_head_seq,
                    &preflight.destination,
                    PageCopyParentDocumentMode::Commit,
                    true,
                    &assets_root,
                    &committed_at,
                )?;
                let result = agent_result(
                    &transaction,
                    &library_id,
                    &copy_request,
                    preflight.body_block_count,
                    &execution,
                )?;
                let affected_block_ids = execution
                    .result
                    .block_ids
                    .values()
                    .cloned()
                    .collect::<Vec<_>>();
                seal_mutation(
                    scope,
                    &agent_context,
                    &operation_id,
                    MutationEffects {
                        project_id: execution.actor_project_id,
                        operation_kind: "agent_duplicate_page",
                        change_kind: "library.changed",
                        did_mutate: true,
                        created_target: Some(LibraryResourceTarget::Page {
                            page_id: execution.result.page_id.clone(),
                        }),
                        affected_parent_keys: vec![execution.parent_key],
                        affected_block_ids,
                        affected_page_ids: execution.affected_page_ids,
                        affected_database_ids: execution.affected_database_ids,
                        affected_view_ids: execution.affected_view_ids,
                        affected_document_ids: execution.affected_document_ids,
                        committed_revisions: execution.committed_revisions,
                        page_create: None,
                        page_copy: Some(execution.result),
                        page_files: None,
                        canvas_mutation: None,
                        block_transfer: None,
                        block_transfer_undo: None,
                        page_relocation_undo: None,
                        structural_edit: None,
                        page_lifecycle: None,
                        block_property_mutation: None,
                        agent_page_copy: Some(result),
                        agent_create_pages: None,
                        agent_move_pages: None,
                        change_payload: None,
                        committed_at: execution.committed_at,
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

#[allow(clippy::too_many_arguments)]
fn compile_preflight(
    connection: &Connection,
    context: &BoundModuleContext,
    library_id: &str,
    operation_id: &str,
    store_epoch: &str,
    authorization: &nodex_core_contracts::agent::AgentExecutionAuthorization,
    request: &LibraryAgentPageCopyRequest,
    request_hash: String,
) -> Result<CopyPreflight, StoreError> {
    validate_id(&request.source_page_id, "source_page_id")?;
    let source_fingerprint = super::agent_authorization::authorize_execution(
        connection,
        context,
        library_id,
        authorization,
        &nodex_core_contracts::agent::AgentAuthorizationTarget::Page {
            page_id: request.source_page_id.clone(),
        },
        AgentProjectResourceAction::Read,
    )?;
    let source = read_source(connection, library_id, &request.source_page_id)?;
    let resolved_destination = resolve_destination(
        connection,
        context,
        library_id,
        authorization,
        &request.destination,
    )?;
    let ResolvedDestination {
        destination,
        authorization_fingerprint: destination_fingerprint,
        document_heads: mut destination_heads,
        database_id: destination_database_id,
        actor_project_id,
    } = resolved_destination;
    let destination_document = if matches!(
        request.destination,
        LibraryAgentPageDestination::Page { .. }
    ) {
        destination_heads.first().cloned()
    } else {
        None
    };
    let preview = preview_page_copy(
        connection,
        operation_id,
        &source.library_id,
        &request.source_page_id,
        &source.document_id,
    )?;
    let mut document_heads = preview
        .document_heads
        .iter()
        .map(|head| LibraryAgentDocumentHead {
            document_id: head.document_id.clone(),
            generation: head.generation,
            expected_head_seq: head.expected_head_seq,
        })
        .collect::<Vec<_>>();
    document_heads.append(&mut destination_heads);
    document_heads.sort_by(|left, right| left.document_id.cmp(&right.document_id));
    document_heads.dedup_by(|left, right| left.document_id == right.document_id);
    let parent_id = match &request.destination {
        LibraryAgentPageDestination::Library { .. } => Some(library_id.to_owned()),
        LibraryAgentPageDestination::Page { page_id, .. } => Some(page_id.clone()),
        LibraryAgentPageDestination::DataSource { data_source_id, .. } => {
            Some(data_source_id.clone())
        }
    };
    let footprint = AgentOperationFootprint {
        effect_class: AgentEffectClass::Write,
        targets: vec![
            AgentResourceTarget {
                kind: AgentResourceKind::Page,
                id: request.source_page_id.clone(),
            },
            destination_footprint_target(library_id, &request.destination),
        ],
        created_roots: preview.block_ids.values().cloned().collect(),
        updated_roots: Vec::new(),
        deleted_roots: Vec::new(),
        deleted_owner_roots: Vec::new(),
        ownership_transformations: vec![AgentOwnershipTransformation {
            resource_id: preview.page_id.clone(),
            parent_id,
            before_id: destination_before_id(&destination),
        }],
    };
    let authority_revisions_hash = hash_serializable(&(
        source_fingerprint,
        destination_fingerprint,
        store_epoch,
        &source.location_revision,
        &source.parent_revision,
        &source.active_membership_revision,
        &source.document_generation,
        &source.document_head_seq,
        &destination,
        &actor_project_id,
        &document_heads,
    ))?;
    let footprint_hash = hash_serializable(&footprint)?;
    Ok(CopyPreflight {
        binding: PreparedAgentOperationBinding {
            connection_id: context.connection_id.clone(),
            operation_id: operation_id.to_owned(),
            request_hash: request_hash.clone(),
            authority_revisions_hash,
            footprint_hash,
            effect_class: AgentEffectClass::Write,
        },
        destination,
        destination_document,
        destination_database_id,
        source,
        page_id: preview.page_id,
        body_block_count: preview.body_block_count,
        document_heads,
        footprint,
    })
}

fn read_source(
    connection: &Connection,
    library_id: &str,
    page_id: &str,
) -> Result<SourceAuthority, StoreError> {
    connection
        .query_row(
            "SELECT block.library_id, block.placement_revision, block.placement_revision, \
               COALESCE(membership.revision, 0), page.document_id, document.generation, \
               document.head_seq, block.lifecycle, document.readiness \
             FROM pages page JOIN blocks block ON block.id = page.block_id AND block.type = 'page' \
               AND block.library_id = page.library_id \
             JOIN documents document ON document.id = page.document_id \
               AND document.library_id = page.library_id \
             LEFT JOIN data_source_page_memberships membership \
               ON membership.page_block_id = page.block_id AND membership.removed_at IS NULL \
             WHERE page.block_id = ?1 AND page.library_id = ?2",
            params![page_id, library_id],
            |row| {
                Ok((
                    SourceAuthority {
                        library_id: row.get(0)?,
                        location_revision: row.get(1)?,
                        parent_revision: row.get(2)?,
                        active_membership_revision: row.get(3)?,
                        document_id: row.get(4)?,
                        document_generation: row.get(5)?,
                        document_head_seq: row.get(6)?,
                    },
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| not_found("Source Page is unavailable"))
        .and_then(|(source, block_lifecycle, readiness)| {
            if block_lifecycle == "active" && readiness == "ready" {
                return Ok(source);
            }
            Err(not_found("Source Page is unavailable"))
        })
}

pub(super) fn resolve_destination(
    connection: &Connection,
    context: &BoundModuleContext,
    library_id: &str,
    authorization: &nodex_core_contracts::agent::AgentExecutionAuthorization,
    destination: &LibraryAgentPageDestination,
) -> Result<ResolvedDestination, StoreError> {
    match destination {
        LibraryAgentPageDestination::Library { at } => {
            let fingerprint = super::agent_authorization::authorize_execution(
                connection,
                context,
                library_id,
                authorization,
                &nodex_core_contracts::agent::AgentAuthorizationTarget::Library {
                    library_id: library_id.to_owned(),
                },
                AgentProjectResourceAction::CreateChild,
            )?;
            let actor_project_id = authorization.provenance.authority.actor_project_id.as_str();
            let ids = connection
                .prepare(
                    "SELECT placement.block_id FROM library_block_placements placement \
                     JOIN blocks block ON block.id = placement.block_id \
                     WHERE placement.library_id = ?1 AND block.library_id = placement.library_id \
                       AND block.lifecycle = 'active' \
                     ORDER BY placement.rank_key, placement.block_id",
                )?
                .query_map([library_id], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let before_id = resolve_before_id(&ids, at.as_ref(), "Library")?;
            let before = before_id
                .map(|block_id| read_location_anchor(connection, &block_id))
                .transpose()?;
            Ok(ResolvedDestination {
                destination: LibraryPageCopyDestination::Library { before },
                authorization_fingerprint: fingerprint,
                document_heads: Vec::new(),
                database_id: None,
                actor_project_id: actor_project_id.to_owned(),
            })
        }
        LibraryAgentPageDestination::Page { page_id, at } => {
            validate_id(page_id, "destination.page_id")?;
            let fingerprint = super::agent_authorization::authorize_execution(
                connection,
                context,
                library_id,
                authorization,
                &nodex_core_contracts::agent::AgentAuthorizationTarget::Page {
                    page_id: page_id.clone(),
                },
                AgentProjectResourceAction::CreateChild,
            )?;
            let (document_id, generation, head_seq) = connection
                .query_row(
                    "SELECT page.document_id, document.generation, \
                       document.head_seq \
                     FROM pages page JOIN blocks block ON block.id = page.block_id \
                     JOIN documents document ON document.id = page.document_id \
                     WHERE page.block_id = ?1 AND page.library_id = ?2 \
                       AND block.library_id = page.library_id AND block.lifecycle = 'active' \
                       AND document.library_id = page.library_id \
                       AND document.readiness = 'ready'",
                    params![page_id, library_id],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, i64>(1)?,
                            row.get::<_, i64>(2)?,
                        ))
                    },
                )
                .optional()?
                .ok_or_else(|| not_found("Destination Page is unavailable"))?;
            let ids = connection
                .prepare(
                    "SELECT entry.block_id FROM document_block_index entry \
                     JOIN blocks block ON block.id = entry.block_id \
                     WHERE entry.document_id = ?1 AND entry.parent_block_id IS NULL \
                       AND block.lifecycle = 'active' \
                     ORDER BY entry.ordinal, entry.block_id",
                )?
                .query_map([&document_id], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let before_id = resolve_before_id(&ids, at.as_ref(), "Destination Page")?;
            let before = before_id
                .map(|block_id| read_location_anchor(connection, &block_id))
                .transpose()?;
            Ok(ResolvedDestination {
                destination: LibraryPageCopyDestination::Page {
                    page_id: page_id.clone(),
                    expected_document_generation: generation,
                    expected_document_head_seq: head_seq,
                    before,
                },
                authorization_fingerprint: fingerprint,
                document_heads: vec![LibraryAgentDocumentHead {
                    document_id,
                    generation,
                    expected_head_seq: head_seq,
                }],
                database_id: None,
                actor_project_id: authorization.provenance.authority.actor_project_id.clone(),
            })
        }
        LibraryAgentPageDestination::DataSource {
            data_source_id,
            values,
            view_id,
            group_key,
            at,
        } => resolve_data_source_destination(
            connection,
            context,
            library_id,
            authorization,
            data_source_id,
            values,
            view_id.as_deref(),
            group_key.as_deref(),
            at.as_ref(),
        ),
    }
}

#[allow(clippy::too_many_arguments)]
fn resolve_data_source_destination(
    connection: &Connection,
    context: &BoundModuleContext,
    library_id: &str,
    authorization: &nodex_core_contracts::agent::AgentExecutionAuthorization,
    data_source_id: &str,
    values: &[LibraryPageCopyValue],
    requested_view_id: Option<&str>,
    group_key: Option<&str>,
    at: Option<&LibraryAgentSiblingAnchor>,
) -> Result<ResolvedDestination, StoreError> {
    validate_id(data_source_id, "destination.data_source_id")?;
    let mut property_ids = BTreeSet::new();
    for value in values {
        validate_id(&value.property_id, "destination.values.property_id")?;
        if !property_ids.insert(value.property_id.as_str()) {
            return Err(invalid(format!(
                "destination.values repeats Property {}",
                value.property_id
            )));
        }
    }
    let fingerprint = super::agent_authorization::authorize_execution(
        connection,
        context,
        library_id,
        authorization,
        &nodex_core_contracts::agent::AgentAuthorizationTarget::DataSource {
            data_source_id: data_source_id.to_owned(),
        },
        AgentProjectResourceAction::CreateChild,
    )?;
    let (database_id, source_revision, default_view_id) = connection
        .query_row(
            "SELECT source.home_database_block_id, source.schema_revision, \
               container.default_view_id \
             FROM data_sources source JOIN database_containers container \
               ON container.block_id = source.home_database_block_id \
             JOIN blocks database_block ON database_block.id = source.home_database_block_id \
             WHERE source.id = ?1 AND source.library_id = ?2 \
               AND source.lifecycle = 'active' AND container.lifecycle = 'active'",
            params![data_source_id, library_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| not_found("Destination Data Source is unavailable"))?;
    let view_id = requested_view_id
        .map(str::to_owned)
        .or(default_view_id)
        .ok_or_else(|| corrupt("Destination Database has no default View"))?;
    let view_revision = connection
        .query_row(
            "SELECT revision FROM database_views \
             WHERE id = ?1 AND database_block_id = ?2 AND data_source_id = ?3 \
               AND lifecycle = 'active'",
            params![view_id, database_id, data_source_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
        .ok_or_else(|| not_found("Destination View is unavailable"))?;
    let ids = connection
        .prepare(
            "SELECT membership.page_block_id FROM data_source_page_memberships membership \
             JOIN pages page ON page.block_id = membership.page_block_id \
             LEFT JOIN database_view_page_positions position \
               ON position.view_id = ?1 AND position.page_block_id = membership.page_block_id \
             WHERE membership.data_source_id = ?2 AND membership.removed_at IS NULL \
               AND EXISTS(SELECT 1 FROM blocks block WHERE block.id = page.block_id \
                 AND block.library_id = page.library_id AND block.lifecycle = 'active') \
             ORDER BY CASE WHEN position.rank_key IS NULL THEN 1 ELSE 0 END, \
               position.rank_key, membership.page_block_id",
        )?
        .query_map(params![view_id, data_source_id], |row| {
            row.get::<_, String>(0)
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let before_page_id = resolve_before_id(&ids, at, "Destination View")?;
    let before = before_page_id
        .map(|page_id| {
            let expected_position_revision = connection
                .query_row(
                    "SELECT COALESCE(revision, 0) FROM database_view_page_positions \
                     WHERE view_id = ?1 AND page_block_id = ?2",
                    params![view_id, page_id],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?
                .unwrap_or(0);
            Ok::<_, StoreError>(LibraryPageCopyPositionAnchor {
                page_id,
                expected_position_revision,
            })
        })
        .transpose()?;
    Ok(ResolvedDestination {
        destination: LibraryPageCopyDestination::DataSource {
            data_source_id: data_source_id.to_owned(),
            expected_data_source_revision: source_revision,
            values: values.to_vec(),
            view: Some(LibraryPageCopyViewPlacement {
                view_id,
                expected_view_revision: view_revision,
                group_key: group_key.map(str::to_owned),
                before,
            }),
        },
        authorization_fingerprint: fingerprint,
        document_heads: Vec::new(),
        database_id: Some(database_id),
        actor_project_id: authorization.provenance.authority.actor_project_id.clone(),
    })
}

pub(super) fn resolve_before_id(
    ids: &[String],
    anchor: Option<&LibraryAgentSiblingAnchor>,
    label: &str,
) -> Result<Option<String>, StoreError> {
    let Some(anchor) = anchor else {
        return Ok(None);
    };
    match anchor {
        LibraryAgentSiblingAnchor::Start => Ok(ids.first().cloned()),
        LibraryAgentSiblingAnchor::End => Ok(None),
        LibraryAgentSiblingAnchor::Before { block_id }
        | LibraryAgentSiblingAnchor::After { block_id } => {
            let index = ids.iter().position(|id| id == block_id).ok_or_else(|| {
                StoreError::new(
                    StoreErrorCode::RevisionConflict,
                    format!("{label} anchor is unavailable"),
                    true,
                )
            })?;
            if matches!(anchor, LibraryAgentSiblingAnchor::Before { .. }) {
                return Ok(Some(ids[index].clone()));
            }
            Ok(ids.get(index + 1).cloned())
        }
    }
}

pub(super) fn read_location_anchor(
    connection: &Connection,
    block_id: &str,
) -> Result<LibraryPlacementAnchor, StoreError> {
    let expected_location_revision = connection
        .query_row(
            "SELECT placement_revision FROM blocks WHERE id = ?1 AND lifecycle = 'active'",
            [block_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
        .ok_or_else(|| not_found("Destination placement anchor is unavailable"))?;
    Ok(LibraryPlacementAnchor {
        block_id: block_id.to_owned(),
        expected_location_revision,
    })
}

fn agent_result(
    connection: &Connection,
    library_id: &str,
    request: &LibraryAgentPageCopyRequest,
    body_block_count: u32,
    execution: &super::page_copy::PageCopyExecution,
) -> Result<LibraryAgentPageCopyResult, StoreError> {
    let page_id = execution
        .result
        .block_ids
        .get(&request.source_page_id)
        .cloned()
        .ok_or_else(|| corrupt("Agent Page copy omitted its root identity"))?;
    let etags = if request.include_etags {
        Some(LibraryAgentPageEtags {
            title: execution.result.title_etag.clone(),
            body: execution.result.body_etag.clone(),
        })
    } else {
        None
    };
    Ok(LibraryAgentPageCopyResult {
        source_page_id: request.source_page_id.clone(),
        page_key: current_page_key_for_page(connection, library_id, &page_id)?,
        page_id,
        location: match &request.destination {
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
        },
        body_blocks_created: body_block_count,
        block_map: Some(execution.result.block_ids.clone()),
        etags,
        document_commits: execution.document_commits.clone(),
        affected_database_ids: execution.affected_database_ids.clone(),
    })
}

fn committed_footprint(
    result: &LibraryAgentPageCopyResult,
) -> Result<AgentOperationFootprint, StoreError> {
    let block_map = result
        .block_map
        .as_ref()
        .ok_or_else(|| corrupt("Committed Agent Page copy omitted its identity map"))?;
    let parent_id = match &result.location {
        LibraryAgentPageLocation::Library { library_id } => Some(library_id.clone()),
        LibraryAgentPageLocation::Page { page_id } => Some(page_id.clone()),
        LibraryAgentPageLocation::DataSource { data_source_id } => Some(data_source_id.clone()),
    };
    Ok(AgentOperationFootprint {
        effect_class: AgentEffectClass::Write,
        targets: vec![
            AgentResourceTarget {
                kind: AgentResourceKind::Page,
                id: result.source_page_id.clone(),
            },
            committed_destination_footprint_target(&result.location),
        ],
        created_roots: block_map.values().cloned().collect(),
        updated_roots: Vec::new(),
        deleted_roots: Vec::new(),
        deleted_owner_roots: Vec::new(),
        ownership_transformations: vec![AgentOwnershipTransformation {
            resource_id: result.page_id.clone(),
            parent_id,
            before_id: None,
        }],
    })
}

pub(super) fn destination_footprint_target(
    library_id: &str,
    destination: &LibraryAgentPageDestination,
) -> AgentResourceTarget {
    match destination {
        LibraryAgentPageDestination::Library { .. } => AgentResourceTarget {
            kind: AgentResourceKind::Library,
            id: library_id.to_owned(),
        },
        LibraryAgentPageDestination::Page { page_id, .. } => AgentResourceTarget {
            kind: AgentResourceKind::Page,
            id: page_id.clone(),
        },
        LibraryAgentPageDestination::DataSource { data_source_id, .. } => AgentResourceTarget {
            kind: AgentResourceKind::Database,
            id: data_source_id.clone(),
        },
    }
}

fn committed_destination_footprint_target(
    location: &LibraryAgentPageLocation,
) -> AgentResourceTarget {
    match location {
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
    }
}

pub(super) fn destination_before_id(destination: &LibraryPageCopyDestination) -> Option<String> {
    match destination {
        LibraryPageCopyDestination::Library { before }
        | LibraryPageCopyDestination::Page { before, .. } => {
            before.as_ref().map(|anchor| anchor.block_id.clone())
        }
        LibraryPageCopyDestination::DataSource { view, .. } => view
            .as_ref()
            .and_then(|view| view.before.as_ref())
            .map(|anchor| anchor.page_id.clone()),
    }
}

fn request_hash(
    context: &BoundModuleContext,
    store_epoch: &str,
    authorization: &nodex_core_contracts::agent::AgentExecutionAuthorization,
    request: &LibraryAgentPageCopyRequest,
) -> Result<String, StoreError> {
    let fingerprint = serde_json::to_vec(&(
        "nodex.agent.page-copy.v1",
        &context.profile_id,
        &context.library_id,
        &context.project_id,
        store_epoch,
        authorization,
        request,
    ))
    .map_err(|_| invalid("Agent Page copy request cannot be fingerprinted"))?;
    Ok(sha256(&fingerprint))
}

fn hash_serializable(value: &impl serde::Serialize) -> Result<String, StoreError> {
    serde_json::to_vec(value)
        .map(|bytes| sha256(&bytes))
        .map_err(|_| invalid("Agent Page copy authority cannot be fingerprinted"))
}

fn validate_id(value: &str, field: &str) -> Result<(), StoreError> {
    if !value.is_empty() && value.len() <= MAX_ID_BYTES && value.trim() == value {
        return Ok(());
    }
    Err(invalid(format!("{field} is invalid")))
}

fn stale() -> StoreError {
    StoreError::new(
        StoreErrorCode::RevisionConflict,
        "Prepared Agent Page copy is stale or missing its execution token",
        true,
    )
}

fn not_found(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::NotFound, message, false)
}

fn invalid(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message, false)
}

fn corrupt(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message, false)
}
