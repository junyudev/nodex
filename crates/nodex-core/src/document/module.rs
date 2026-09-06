mod recovery_drafts;
pub(crate) use recovery_drafts::{
    resolve_recovery_canvas_file_target, resolve_recovery_file_target,
};

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use nodex_core_contracts::agent::{
    AgentAuthorizationTarget, AgentConsentRequirement, AgentEffectClass,
    AgentExecutionAuthorization, AgentOperationFootprint, AgentOperationPreparation,
    AgentOperationPreparationState, AgentOwnershipTransformation, AgentPreparedExecution,
    AgentProjectResourceAction, AgentResourceKind, AgentResourceTarget, AgentTurnProvenance,
};
use nodex_core_contracts::document::{
    AgentDocumentBlockGuard, AgentDocumentBlockGuardKind, AgentDocumentSemanticBlock,
    AgentDocumentSemanticMutation, AgentDocumentSemanticSnapshot,
    DocumentBlockOperation as ContractDocumentBlockOperation, DocumentCheckpointEffect,
    DocumentCommitOutcome, DocumentInvalidationReason, DocumentMutationCoordination,
    DocumentMutationEffect, DocumentOptionalValue, DocumentOwnerCommand, DocumentRevisionKind,
    DocumentSemanticAnchor, DocumentSemanticBlockDraft, DocumentSemanticBlockEtags,
    DocumentSemanticCommand, DocumentSemanticEtags, DocumentUpdateResource,
    DocumentUpdateResourceUnavailable, DocumentUpdateResourceUnavailableReason,
    OWNED_DOCUMENT_DESCRIPTOR_VERSION, OwnedDocumentAccessContext, OwnedDocumentCommitValue,
    OwnedDocumentDescriptor, OwnedDocumentIntent, OwnedDocumentOwnerLifecycle, OwnedDocumentRead,
    OwnedDocumentReadValue, OwnedDocumentReadiness, OwnedDocumentReceipt,
    OwnedDocumentSyncDescriptor,
};
use nodex_core_contracts::events::ResourceKey;
use nodex_core_contracts::{
    AdapterKind, ApplyResponse, BoundModuleContext, CommittedCoreModuleEvent, CoreError,
    CoreErrorCode, CoreErrorRecovery, ModuleApplyRequest, ModuleMutationReceipt, ModuleName,
    ModuleReadRequest, ModuleReadSnapshot, OWNED_DOCUMENT_CONTRACT_VERSION, ProjectId,
    ProjectionImpact, StoreEpoch,
};
#[cfg(test)]
use nodex_core_contracts::{CoreModuleEventPayload, document::OwnedDocumentEvent};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior};
use serde::Serialize;
use serde_json::{Value, json};
use yrs::updates::encoder::Encode;
use yrs::{ReadTxn, Transact};

use crate::domain::block_materialization::MaterializedBlockNode;
use crate::domain::nfm::materialize_nfm;
use crate::domain::rich_text::RichTextItem;
use crate::infrastructure::agent_operations::{
    PreparedAgentOperationBinding, PreparedAgentOperationLease, PreparedAgentOperationRegistry,
};
use crate::infrastructure::document_repository::{
    DocumentAuthority, DocumentReadRepository, DocumentReadiness, DocumentSyncEngine,
};
use crate::infrastructure::durable_mutation::{
    self, CommitResult, DurableMutationScope, OperationIdentity, ReceiptMetadata, SealedOutcome,
};
use crate::infrastructure::event_log::{
    NewChangeLogEntry, append_change_log, load_committed_event_by_sequence,
};
use crate::infrastructure::metrics::DurationMetricSnapshot;
use crate::infrastructure::module_receipts::{DurableModuleContext, read_module_receipt};
use crate::infrastructure::resource_authorization;
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};
use crate::infrastructure::store::SqliteStoreKernel;
use crate::infrastructure::writer::{StoreReaders, StoreWriter};

use super::canvas::{
    ensure_canvas_scene, load_canvas_scene, persist_canvas_compaction, persist_canvas_mutation,
    persist_prepared_canvas_mutation, prepare_canvas_compaction,
    prepare_incremental_canvas_mutation, read_canvas_compaction_stats, validate_canvas_authority,
};
#[cfg(test)]
use super::canvas::{full_scene_load_count, reset_full_scene_load_count};
use super::canvas_scene::{
    apply_canvas_mutation as apply_canvas_candidate, canvas_semantic_intent_fingerprint,
    parse_canvas_mutation, prepare_canvas_restore,
};
use super::compaction::{DocumentCompactionResult, compact_yjs_document};
use super::genesis::{prepare_editable_root, prepare_yjs_genesis};
use super::history::{
    NewDocumentCheckpoint, get_document_version, insert_canvas_checkpoint,
    insert_document_checkpoint, insert_prepared_canvas_revision, list_document_versions,
    prepare_canvas_revision, prepare_document_revision, prepare_version_restore,
    record_document_revision_edit,
};
use super::operations::{
    DocumentBlockOperation as EngineDocumentBlockOperation,
    DocumentBlockUpdatePatch as EngineDocumentBlockUpdatePatch, DocumentOperationError,
    DocumentOperationErrorCode, prepare_document_operation_update, prepare_nfm_replacement_update,
};
use super::owners::execute_owner_command;
use super::persistence::{
    DocumentAuthorityRow, DocumentPlacementEvidence, PersistYjsCommit, PersistYjsGenesis,
    TYPED_CREATION_BLOCK_TYPES, derive_touched_block_ids, persist_yjs_commit_with_local_commit,
    persist_yjs_genesis_with_local_commit, read_document_authority, read_event_head,
    read_local_commit_head, read_store_epoch, sha256,
};
use super::recovery::{StaleYjsUpdate, persist_recovery_if_barrier_crossed};
use super::runtime::{
    DocumentRuntimeCache, reconstruct_retained_yjs_engine_at, reconstruction_duration_metrics,
};
use super::semantic::{
    AgentDocumentCursorCoordinate, SemanticMutationContext, SemanticMutationError,
    decode_agent_document_cursor, find_block, mint_agent_document_cursor, mint_document_block_etag,
    mint_document_semantic_etags, mint_document_subtree_etag, prepare_semantic_mutation,
};
use super::{
    BlockDocumentSchema, DocumentMaterialization, YrsEngineError, decode_block_document,
    derive_document_node_delta, derive_document_placement_delta, materialize_decoded_document,
};

const MODULE_NAME: &str = "owned_document";
const MAX_AGENT_FOOTPRINT_ROOTS: usize = 2_048;

struct DocumentUpdateJob {
    context: BoundModuleContext,
    client_session_id: String,
    operation_id: String,
    expected_store_epoch: StoreEpoch,
    document_id: String,
    generation: i64,
    operation_kind: &'static str,
    request_hash: String,
    publication: UpdatePublication,
    prepared_agent: Option<PreparedAgentExecutionJob>,
    semantic_block_etag_ids: Vec<String>,
    include_local_block_etags: bool,
    recovery: Option<recovery_drafts::RecoveryCommit>,
}

struct PreparedAgentExecutionJob {
    authorization: AgentPreparedExecution,
    mutation: AgentDocumentSemanticMutation,
}

struct DocumentCommitCheckpoint {
    actor: Value,
    cause: &'static str,
    label: Option<String>,
    revision_kind: &'static str,
}

struct AgentSemanticPreflight {
    footprint: AgentOperationFootprint,
    preview_markdown: Option<String>,
    consent: AgentConsentRequirement,
    binding: PreparedAgentOperationBinding,
}

enum AgentSemanticPreparationResult {
    Prepared {
        store_epoch: String,
        commit_head: i64,
        preflight: AgentSemanticPreflight,
    },
    CommittedReplay {
        store_epoch: String,
        commit_head: i64,
        footprint: AgentOperationFootprint,
        committed: Box<ApplyResponse<OwnedDocumentCommitValue, OwnedDocumentReceipt>>,
    },
}

#[derive(Clone, Copy)]
enum UpdatePublication {
    Updated,
    Invalidated(DocumentInvalidationReason),
}

enum PreparedPlacementAttribution {
    Collaborative,
    Exact(Vec<String>),
}

enum PreparedUpdate {
    Apply {
        file_restore: Option<crate::library::FileRestorePlan>,
        base_head_seq: i64,
        update_id: String,
        touched_block_ids: Vec<String>,
        update: Vec<u8>,
        write_fence_block_ids: Vec<String>,
        placement_attribution: PreparedPlacementAttribution,
        title_write_fence_required: bool,
        document_write_fence_required: bool,
        mutation_effect: Option<Box<DocumentMutationEffect>>,
        semantic_local_block_ids: Option<BTreeMap<String, String>>,
    },
    NoChange,
    Recovery {
        artifact_id: String,
    },
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct DocumentCacheMetrics {
    pub entries: usize,
    pub state_bytes: usize,
    pub hits: u64,
    pub misses: u64,
}

#[derive(Debug, Clone)]
pub struct OwnedDocumentApplyOutcome {
    pub committed: crate::ModuleWriterResult<OwnedDocumentCommitValue, OwnedDocumentReceipt>,
    pub events: Vec<CommittedCoreModuleEvent>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RealtimeDocumentBoundary {
    pub(crate) store_epoch: StoreEpoch,
    pub(crate) generation: i64,
    pub(crate) head_seq: i64,
    pub(crate) commit_head: i64,
    pub(crate) engine: DocumentSyncEngine,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CanvasSceneSyncSnapshot {
    pub library_id: String,
    pub access_context: OwnedDocumentAccessContext,
    pub document_id: String,
    pub store_epoch: String,
    pub generation: i64,
    pub head_seq: i64,
    pub scene_hash: String,
    pub scene_json: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CanvasCompactionFingerprint<'a> {
    version: u8,
    profile_id: &'a str,
    library_id: &'a str,
    project_id: Option<&'a str>,
    expected_store_epoch: &'a str,
    document_id: &'a str,
    generation: i64,
    expected_head_seq: i64,
    operation_id: &'a str,
    actor: &'a Value,
}

#[derive(Clone)]
pub struct OwnedDocumentModule {
    profile_id: String,
    library_id: String,
    writer: StoreWriter,
    readers: StoreReaders,
    cache: Arc<Mutex<DocumentRuntimeCache>>,
    fail_after_commit: Arc<AtomicBool>,
    prepared_agent_operations: PreparedAgentOperationRegistry,
    assets_root: PathBuf,
}

impl OwnedDocumentModule {
    pub fn new(
        profile_id: impl Into<String>,
        library_id: impl Into<String>,
        kernel: &SqliteStoreKernel,
    ) -> Self {
        Self {
            profile_id: profile_id.into(),
            library_id: library_id.into(),
            writer: kernel.writer(),
            readers: kernel.readers(),
            cache: kernel.document_runtime_cache(),
            fail_after_commit: Arc::new(AtomicBool::new(false)),
            prepared_agent_operations: PreparedAgentOperationRegistry::new(),
            assets_root: kernel
                .database_path()
                .parent()
                .expect("Profile database has a parent")
                .join("assets"),
        }
    }

    pub fn reset_for_store_replacement(&self) -> Result<(), CoreError> {
        let mut cache = self
            .cache
            .lock()
            .map_err(|_| core_error(internal("Owned Document runtime cache lock failed")))?;
        *cache = DocumentRuntimeCache::new();
        self.prepared_agent_operations
            .invalidate_all()
            .map_err(core_error)?;
        Ok(())
    }

    pub fn sync_canvas(
        &self,
        context: &BoundModuleContext,
        document_id: &str,
    ) -> Result<CanvasSceneSyncSnapshot, CoreError> {
        self.readers
            .read_default(|connection| {
                let authority = read_document_authority(connection, document_id)?
                    .ok_or_else(|| not_found("Owned Document was not found"))?;
                authorize_canvas(connection, context, &authority, DocumentAccessKind::Read)?;
                let loaded = load_canvas_scene(connection, &authority)?;
                Ok(CanvasSceneSyncSnapshot {
                    library_id: authority.head.library_id.clone(),
                    access_context: document_access_context(context),
                    document_id: authority.head.id.clone(),
                    store_epoch: read_store_epoch(connection)?,
                    generation: authority.head.generation,
                    head_seq: authority.head.head_seq,
                    scene_hash: loaded.scene_hash,
                    scene_json: loaded.scene.canonical_json()?,
                })
            })
            .map_err(core_error)
    }

    pub fn read(
        &self,
        context: &BoundModuleContext,
        request: ModuleReadRequest<OwnedDocumentRead>,
    ) -> Result<ModuleReadSnapshot<OwnedDocumentReadValue>, CoreError> {
        self.validate_context(context)?;
        if request.contract_version != OWNED_DOCUMENT_CONTRACT_VERSION {
            return Err(invalid("Unsupported Owned Document contract version"));
        }
        match request.read {
            OwnedDocumentRead::Recovery { read } => self.read_recovery(context, read),
            OwnedDocumentRead::RecoveryArtifact {
                document_id,
                artifact_id,
                store_epoch,
                generation,
            } => self
                .readers
                .read_default(|connection| {
                    let authority = read_document_authority(connection, &document_id)?
                        .ok_or_else(|| not_found("Owned Document was not found"))?;
                    authorize_document_access(
                        connection,
                        context,
                        &authority,
                        DocumentAccessKind::Read,
                    )?;
                    let current_epoch = read_store_epoch(connection)?;
                    if store_epoch.0 != current_epoch || generation != authority.head.generation {
                        return Err(not_found(
                            "Recovery artifact belongs to another document boundary",
                        ));
                    }
                    let artifact = super::recovery::get_recovery_artifact(
                        connection,
                        &document_id,
                        &artifact_id,
                        &current_epoch,
                        generation,
                    )?
                    .ok_or_else(|| not_found("Recovery artifact was not found"))?;
                    let commit_head = read_local_commit_head(connection)?;
                    let authorization = issue_descriptor_read_stamp(
                        connection,
                        context,
                        &authority,
                        &current_epoch,
                        commit_head,
                    )?;
                    Ok(ModuleReadSnapshot {
                        contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                        store_epoch: StoreEpoch(current_epoch),
                        commit_head,
                        authorization: Some(authorization),
                        value: OwnedDocumentReadValue::RecoveryArtifact { artifact },
                    })
                })
                .map_err(core_error),
            OwnedDocumentRead::Descriptor { owner_block_id } => self
                .readers
                .read_default(|connection| {
                    let authority = connection
                        .query_row(
                            "SELECT ownership.document_id FROM block_documents ownership \
                             WHERE ownership.block_id = ?1",
                            [&owner_block_id],
                            |row| row.get::<_, String>(0),
                        )
                        .optional()?
                        .ok_or_else(|| not_found("Owned Document descriptor was not found"))?;
                    let authority = read_document_authority(connection, &authority)?
                        .ok_or_else(|| not_found("Owned Document was not found"))?;
                    authorize_document_access(
                        connection,
                        context,
                        &authority,
                        DocumentAccessKind::Read,
                    )?;
                    let store_epoch = read_store_epoch(connection)?;
                    let commit_head = read_local_commit_head(connection)?;
                    let authorization = issue_descriptor_read_stamp(
                        connection,
                        context,
                        &authority,
                        &store_epoch,
                        commit_head,
                    )?;
                    Ok(ModuleReadSnapshot {
                        contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                        store_epoch: StoreEpoch(store_epoch.clone()),
                        commit_head,
                        authorization: Some(authorization),
                        value: OwnedDocumentReadValue::Descriptor {
                            descriptor: authority_descriptor(context, &authority, &store_epoch)?,
                        },
                    })
                })
                .map_err(core_error),
            OwnedDocumentRead::SyncYjs {
                document_id,
                state_vector,
                history_after_head_seq,
            } => {
                let context = context.clone();
                let cache = Arc::clone(&self.cache);
                self.writer
                    .call(move |connection| {
                        let authority = read_document_authority(connection, &document_id)?
                            .ok_or_else(|| not_found("Owned Document was not found"))?;
                        authorize_yjs(connection, &context, &authority, DocumentAccessKind::Read)?;
                        let update = cache
                            .lock()
                            .map_err(|_| internal("Document cache lock failed"))?
                            .sync_diff(connection, &authority.head, &state_vector)?;
                        let store_epoch = read_store_epoch(connection)?;
                        Ok(ModuleReadSnapshot {
                            contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                            store_epoch: StoreEpoch(store_epoch.clone()),
                            commit_head: read_local_commit_head(connection)?,
                            authorization: None,
                            value: OwnedDocumentReadValue::YjsSync {
                                descriptor: authority_descriptor(
                                    &context,
                                    &authority,
                                    &store_epoch,
                                )?,
                                update,
                                history_fence: super::history_fence::read(
                                    connection,
                                    &document_id,
                                    authority.head.generation,
                                    history_after_head_seq.unwrap_or(0),
                                    authority.head.head_seq,
                                )?,
                            },
                        })
                    })
                    .map_err(core_error)
            }
            OwnedDocumentRead::FetchUpdate {
                document_id,
                generation,
                update_id,
                update_hash,
            } => {
                if generation < 1
                    || update_id.is_empty()
                    || update_id.len() > 512
                    || update_id.trim() != update_id
                    || !is_sha256(&update_hash)
                {
                    return Err(invalid("Document update resource identity is invalid"));
                }
                self.readers
                    .read_default(|connection| {
                        let authority = read_document_authority(connection, &document_id)?
                            .ok_or_else(|| not_found("Owned Document was not found"))?;
                        authorize_yjs(
                            connection,
                            context,
                            &authority,
                            DocumentAccessKind::Read,
                        )?;
                        let store_epoch = read_store_epoch(connection)?;
                        let repository = DocumentReadRepository::new(connection);
                        let unavailable = |reason| {
                            OwnedDocumentReadValue::UpdateResourceUnavailable {
                                unavailable: DocumentUpdateResourceUnavailable {
                                    document_id: document_id.clone(),
                                    requested_generation: generation,
                                    current_generation: authority.head.generation,
                                    current_head_seq: authority.head.head_seq,
                                    update_id: update_id.clone(),
                                    update_hash: update_hash.clone(),
                                    reason,
                                },
                            }
                        };
                        let value = if authority.head.generation != generation {
                            unavailable(DocumentUpdateResourceUnavailableReason::GenerationChanged)
                        } else {
                            match repository.update_by_identity(
                                &document_id,
                                generation,
                                &update_id,
                            )? {
                                Some(update) if update.update_hash != update_hash => unavailable(
                                    DocumentUpdateResourceUnavailableReason::HashMismatch,
                                ),
                                Some(update) if sha256(&update.update_blob) != update.update_hash => {
                                    return Err(StoreError::new(
                                        StoreErrorCode::StoreCorrupt,
                                        "Document update resource hash does not match its durable bytes",
                                        false,
                                    ));
                                }
                                Some(update) => OwnedDocumentReadValue::UpdateResource {
                                    resource: DocumentUpdateResource {
                                        document_id: update.document_id,
                                        generation: update.generation,
                                        base_head_seq: update.base_head_seq,
                                        head_seq: update.seq,
                                        update_id: update.update_id,
                                        update_hash: update.update_hash,
                                        update_byte_length: i64::try_from(update.update_blob.len())
                                            .map_err(|_| {
                                                StoreError::new(
                                                    StoreErrorCode::StoreCorrupt,
                                                    "Document update resource length overflowed",
                                                    false,
                                                )
                                            })?,
                                        update: update.update_blob,
                                    },
                                },
                                None => match repository
                                    .update_receipt(&document_id, &update_id)?
                                {
                                    Some(receipt)
                                        if receipt.generation == generation
                                            && receipt.update_hash != update_hash =>
                                    {
                                        unavailable(
                                            DocumentUpdateResourceUnavailableReason::HashMismatch,
                                        )
                                    }
                                    Some(receipt) if receipt.generation == generation => unavailable(
                                        DocumentUpdateResourceUnavailableReason::Compacted,
                                    ),
                                    _ => unavailable(
                                        DocumentUpdateResourceUnavailableReason::Missing,
                                    ),
                                },
                            }
                        };
                        Ok(ModuleReadSnapshot {
                            contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                            store_epoch: StoreEpoch(store_epoch),
                            commit_head: read_local_commit_head(connection)?,
                            authorization: None,
                            value,
                        })
                    })
                    .map_err(core_error)
            }
            OwnedDocumentRead::ListVersions {
                document_id,
                before,
                limit,
            } => self
                .readers
                .read_default(|connection| {
                    let authority = read_document_authority(connection, &document_id)?
                        .ok_or_else(|| not_found("Owned Document was not found"))?;
                    authorize_owned_document(
                        connection,
                        context,
                        &authority,
                        DocumentAccessKind::Read,
                    )?;
                    let (items, next) =
                        list_document_versions(connection, &authority, before.as_ref(), limit)?;
                    Ok(ModuleReadSnapshot {
                        contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                        store_epoch: StoreEpoch(read_store_epoch(connection)?),
                        commit_head: read_local_commit_head(connection)?,
                        authorization: None,
                        value: OwnedDocumentReadValue::Versions { items, next },
                    })
                })
                .map_err(core_error),
            OwnedDocumentRead::GetVersion {
                document_id,
                version_id,
            } => self
                .readers
                .read_default(|connection| {
                    let authority = read_document_authority(connection, &document_id)?
                        .ok_or_else(|| not_found("Owned Document was not found"))?;
                    authorize_owned_document(
                        connection,
                        context,
                        &authority,
                        DocumentAccessKind::Read,
                    )?;
                    let version = get_document_version(connection, &authority, &version_id)?
                        .ok_or_else(|| not_found("Document version was not found"))?;
                    Ok(ModuleReadSnapshot {
                        contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                        store_epoch: StoreEpoch(read_store_epoch(connection)?),
                        commit_head: read_local_commit_head(connection)?,
                        authorization: None,
                        value: OwnedDocumentReadValue::Version {
                            value: json!({
                                "summary": version.summary,
                                "materialization": version.materialization,
                            }),
                        },
                    })
                })
                .map_err(core_error),
            OwnedDocumentRead::CanvasCompactionEligibility { document_id } => self
                .readers
                .read_default(|connection| {
                    let authority = read_document_authority(connection, &document_id)?
                        .ok_or_else(|| not_found("Canvas Document was not found"))?;
                    authorize_canvas(connection, context, &authority, DocumentAccessKind::Read)?;
                    let stats = read_canvas_compaction_stats(connection, &authority)?;
                    Ok(ModuleReadSnapshot {
                        contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                        store_epoch: StoreEpoch(read_store_epoch(connection)?),
                        commit_head: read_local_commit_head(connection)?,
                        authorization: None,
                        value: OwnedDocumentReadValue::CanvasCompactionEligibility { stats },
                    })
                })
                .map_err(core_error),
            OwnedDocumentRead::PrepareAgentSemanticMutation {
                operation_id,
                store_epoch,
                authorization,
                mutation,
            } => self.prepare_agent_semantic_mutation(
                context,
                operation_id,
                store_epoch,
                *authorization,
                *mutation,
            ),
            OwnedDocumentRead::AgentSemanticSnapshot {
                store_epoch,
                authorization,
                document_id,
                target_block_id,
                prepare_title,
                prepare_body,
                block_guards,
                max_depth,
                cursor,
                limit,
            } => self.agent_semantic_snapshot(
                context,
                store_epoch,
                *authorization,
                document_id,
                target_block_id,
                prepare_title,
                prepare_body,
                block_guards,
                max_depth,
                cursor,
                limit,
            ),
        }
    }

    pub fn apply(
        &self,
        context: &BoundModuleContext,
        request: ModuleApplyRequest<OwnedDocumentIntent>,
    ) -> Result<OwnedDocumentApplyOutcome, CoreError> {
        self.apply_with_client_session(context, &context.connection_id, request)
    }

    pub(crate) fn apply_with_client_session(
        &self,
        context: &BoundModuleContext,
        client_session_id: &str,
        request: ModuleApplyRequest<OwnedDocumentIntent>,
    ) -> Result<OwnedDocumentApplyOutcome, CoreError> {
        self.validate_context(context)?;
        if request.contract_version != OWNED_DOCUMENT_CONTRACT_VERSION {
            return Err(invalid("Unsupported Owned Document contract version"));
        }
        match request.intent {
            OwnedDocumentIntent::CaptureRecovery { capture } => {
                self.capture_recovery(context, request.operation_id, request.store_epoch, *capture)
            }
            OwnedDocumentIntent::ResolveRecovery { resolve } => {
                self.resolve_recovery(context, request.operation_id, request.store_epoch, resolve)
            }
            OwnedDocumentIntent::PrepareOwner { owner_block_id } => self.prepare_owner(
                context,
                request.operation_id,
                request.store_epoch,
                owner_block_id,
            ),
            OwnedDocumentIntent::ApplyYjsUpdate {
                document_id,
                generation,
                base_head_seq,
                update_id,
                touched_block_ids,
                update,
            } => self.apply_yjs_update(
                context,
                client_session_id,
                request.operation_id,
                request.store_epoch,
                document_id,
                generation,
                base_head_seq,
                update_id,
                touched_block_ids,
                update,
            ),
            OwnedDocumentIntent::ApplySemanticMutation {
                document_id,
                generation,
                expected_head_seq,
                commands,
            } => self.apply_semantic_mutation(
                context,
                request.operation_id,
                request.store_epoch,
                document_id,
                generation,
                expected_head_seq,
                commands,
                None,
            ),
            OwnedDocumentIntent::ApplyOperationBatch {
                document_id,
                generation,
                expected_head_seq,
                operations,
                actor,
            } => self.apply_operation_batch(
                context,
                request.operation_id,
                request.store_epoch,
                document_id,
                generation,
                expected_head_seq,
                operations,
                actor,
            ),
            OwnedDocumentIntent::ReplaceFromNfm {
                document_id,
                generation,
                expected_head_seq,
                nfm,
                rich_title,
                actor,
            } => self.replace_from_nfm(
                context,
                request.operation_id,
                request.store_epoch,
                document_id,
                generation,
                expected_head_seq,
                nfm,
                rich_title,
                actor,
            ),
            OwnedDocumentIntent::ExecutePreparedAgentSemanticMutation {
                authorization,
                mutation,
            } => self.apply_semantic_mutation(
                context,
                request.operation_id,
                request.store_epoch,
                mutation.document_id,
                mutation.generation,
                mutation.expected_head_seq,
                mutation.commands,
                Some(*authorization),
            ),
            OwnedDocumentIntent::ApplyCanvasMutation {
                document_id,
                generation,
                expected_head_seq,
                mutation,
            } => self.apply_canvas_scene_mutation(
                context,
                request.operation_id,
                request.store_epoch,
                document_id,
                generation,
                expected_head_seq,
                mutation,
            ),
            OwnedDocumentIntent::CompactCanvasTombstones {
                document_id,
                generation,
                expected_head_seq,
                actor,
            } => self.compact_canvas_tombstones(
                context,
                request.operation_id,
                request.store_epoch,
                document_id,
                generation,
                expected_head_seq,
                actor,
            ),
            OwnedDocumentIntent::CreateCheckpoint {
                document_id,
                generation,
                expected_head_seq,
                cause,
                label,
                actor,
                revision_kind,
                source_mutation_id,
                source_change_seq,
            } => self.create_checkpoint(
                context,
                request.operation_id,
                request.store_epoch,
                document_id,
                generation,
                expected_head_seq,
                cause,
                label,
                actor,
                revision_kind,
                source_mutation_id,
                source_change_seq,
            ),
            OwnedDocumentIntent::RestoreVersion {
                document_id,
                version_id,
                generation,
                expected_head_seq,
                actor,
            } => self.restore_version(
                context,
                request.operation_id,
                request.store_epoch,
                document_id,
                version_id,
                generation,
                expected_head_seq,
                actor,
            ),
            OwnedDocumentIntent::ApplyOwnerCommand { command } => self.apply_owner_command(
                context,
                request.operation_id,
                request.store_epoch,
                command,
            ),
        }
    }

    pub(crate) fn authorize_realtime_subscription(
        &self,
        context: &BoundModuleContext,
        document_id: &str,
    ) -> Result<RealtimeDocumentBoundary, CoreError> {
        self.validate_context(context)?;
        self.readers
            .read_default(|connection| {
                let transaction = connection.unchecked_transaction()?;
                let authority = read_document_authority(&transaction, document_id)?
                    .ok_or_else(|| not_found("Owned Document was not found"))?;
                authorize_owned_document(
                    &transaction,
                    context,
                    &authority,
                    DocumentAccessKind::Read,
                )?;
                let boundary = RealtimeDocumentBoundary {
                    store_epoch: StoreEpoch(read_store_epoch(&transaction)?),
                    generation: authority.head.generation,
                    head_seq: authority.head.head_seq,
                    commit_head: read_local_commit_head(&transaction)?,
                    engine: authority.head.sync_engine,
                };
                transaction.commit()?;
                Ok(boundary)
            })
            .map_err(core_error)
    }

    pub fn cache_metrics(&self) -> Result<DocumentCacheMetrics, CoreError> {
        let stats = self
            .cache
            .lock()
            .map_err(|_| core_error(internal("Document cache lock failed")))?
            .stats();
        Ok(DocumentCacheMetrics {
            entries: stats.entries,
            state_bytes: stats.state_bytes,
            hits: stats.hits,
            misses: stats.misses,
        })
    }

    pub fn reconstruction_metrics(&self) -> DurationMetricSnapshot {
        reconstruction_duration_metrics()
    }

    pub fn prepared_agent_operation_count(&self) -> Result<usize, CoreError> {
        self.prepared_agent_operations
            .active_count()
            .map_err(core_error)
    }

    pub fn inject_failure_after_next_commit(&self) {
        self.fail_after_commit.store(true, Ordering::Release);
    }

    #[allow(clippy::too_many_arguments)]
    fn agent_semantic_snapshot(
        &self,
        context: &BoundModuleContext,
        expected_store_epoch: StoreEpoch,
        authorization: AgentExecutionAuthorization,
        document_id: String,
        target_block_id: String,
        prepare_title: bool,
        prepare_body: bool,
        block_guards: Vec<AgentDocumentBlockGuard>,
        max_depth: Option<u32>,
        cursor: Option<String>,
        limit: Option<u32>,
    ) -> Result<ModuleReadSnapshot<OwnedDocumentReadValue>, CoreError> {
        validate_agent_transport_context(context, &authorization.provenance)?;
        if block_guards.len() > 512 {
            return Err(invalid(
                "Agent Document read requests too many Block guards",
            ));
        }
        let max_depth = max_depth.unwrap_or(512).min(512);
        let limit = limit.unwrap_or(40);
        if !(1..=100).contains(&limit) {
            return Err(invalid(
                "Agent Document read limit must be between 1 and 100",
            ));
        }
        let cache = Arc::clone(&self.cache);
        let context = context.clone();
        self.readers
            .read_default(|connection| {
                let transaction = connection.unchecked_transaction()?;
                let store_epoch = read_store_epoch(&transaction)?;
                if store_epoch != expected_store_epoch.0 {
                    return Err(StoreError::new(
                        StoreErrorCode::StaleStoreEpoch,
                        "Agent Document read targets a stale store epoch",
                        true,
                    ));
                }
                let authority = read_document_authority(&transaction, &document_id)?
                    .ok_or_else(|| not_found("Owned Document was not found"))?;
                authorize_agent_page_document(
                    &transaction,
                    &context,
                    &authorization,
                    &authority,
                    AgentProjectResourceAction::Read,
                )?;
                let engine = cache
                    .lock()
                    .map_err(|_| internal("Document cache lock failed"))?
                    .clone_engine(&transaction, &authority.head)?;
                let schema = registered_yjs_schema(&authority)?;
                let materialization = materialize_engine(&engine, schema)?;
                let target_coordinate = if target_block_id == authority.owner_block_id {
                    None
                } else {
                    Some(
                        find_agent_block_coordinate(
                            &materialization.block_tree,
                            &target_block_id,
                            None,
                            0,
                        )
                        .ok_or_else(|| not_found("Agent Document target Block was not found"))?,
                    )
                };
                if (prepare_title || prepare_body) && target_coordinate.is_some() {
                    return Err(invalid_store(
                        "Title and body preparation require the owning Page".to_owned(),
                    ));
                }
                let selected_roots = target_coordinate.as_ref().map_or_else(
                    || materialization.block_tree.clone(),
                    |coordinate| vec![coordinate.block.clone()],
                );
                let selected_nfm = materialize_nfm(&selected_roots)
                    .map_err(|error| invalid_store(error.to_string()))?;
                let mut coordinates = Vec::new();
                if let Some(target) = &target_coordinate {
                    collect_agent_block_coordinates(
                        &selected_roots,
                        target.parent_block_id.as_deref(),
                        target.sibling_index,
                        0,
                        max_depth,
                        &mut coordinates,
                    );
                } else {
                    collect_agent_block_coordinates(
                        &selected_roots,
                        None,
                        0,
                        0,
                        max_depth,
                        &mut coordinates,
                    );
                }
                let cursor_coordinate = AgentDocumentCursorCoordinate {
                    project_id: &authorization.provenance.authority.actor_project_id,
                    store_epoch: &store_epoch,
                    document_id: &authority.head.id,
                    target_block_id: &target_block_id,
                    generation: authority.head.generation,
                    head_seq: authority.head.head_seq,
                    max_depth,
                };
                let offset = cursor.as_deref().map_or(Ok(0), |cursor| {
                    decode_agent_document_cursor(&transaction, cursor_coordinate, cursor)
                        .map_err(semantic_error)
                })?;
                if offset > coordinates.len() {
                    return Err(invalid_store(
                        "Agent Document cursor offset is invalid".to_owned(),
                    ));
                }
                let page_end = offset.saturating_add(limit as usize).min(coordinates.len());
                let page_coordinates = &coordinates[offset..page_end];
                let page_ids = page_coordinates
                    .iter()
                    .map(|coordinate| coordinate.block.id.as_str())
                    .collect::<HashSet<_>>();
                let mut guard_kinds = HashMap::<String, AgentDocumentBlockGuardKind>::new();
                for guard in block_guards {
                    if !page_ids.contains(guard.block_id.as_str()) {
                        return Err(invalid_store(format!(
                            "Prepared Block {} is not present in the returned page",
                            guard.block_id
                        )));
                    }
                    if let Some(existing) = guard_kinds.insert(guard.block_id.clone(), guard.kind)
                        && existing != guard.kind
                    {
                        return Err(invalid_store(format!(
                            "Block {} cannot be prepared for update and deletion together",
                            guard.block_id
                        )));
                    }
                }
                let blocks = page_coordinates
                    .iter()
                    .map(|coordinate| {
                        let etag = guard_kinds
                            .get(&coordinate.block.id)
                            .map(|kind| match kind {
                                AgentDocumentBlockGuardKind::Update => mint_document_block_etag(
                                    &transaction,
                                    &authorization.provenance.authority.actor_project_id,
                                    &store_epoch,
                                    &authority.head.id,
                                    coordinate.block,
                                ),
                                AgentDocumentBlockGuardKind::Delete => mint_document_subtree_etag(
                                    &transaction,
                                    &authorization.provenance.authority.actor_project_id,
                                    &store_epoch,
                                    &authority.head.id,
                                    coordinate.block,
                                ),
                            })
                            .transpose()
                            .map_err(semantic_error)?;
                        Ok(AgentDocumentSemanticBlock {
                            block_id: coordinate.block.id.clone(),
                            parent_block_id: coordinate.parent_block_id.clone(),
                            sibling_index: coordinate.sibling_index,
                            depth: coordinate.depth,
                            block_type: coordinate.block.block_type.clone(),
                            props: coordinate.block.props.clone(),
                            content: coordinate.block.content.clone(),
                            etag,
                        })
                    })
                    .collect::<Result<Vec<_>, StoreError>>()?;
                let (title_etag, body_etag) = if prepare_title || prepare_body {
                    let (title, body) = mint_document_semantic_etags(
                        &transaction,
                        &authorization.provenance.authority.actor_project_id,
                        &store_epoch,
                        &authority.head.id,
                        &materialization,
                    )
                    .map_err(semantic_error)?;
                    (prepare_title.then_some(title), prepare_body.then_some(body))
                } else {
                    (None, None)
                };
                let has_more = page_end < coordinates.len();
                let next_cursor = has_more
                    .then(|| {
                        mint_agent_document_cursor(&transaction, cursor_coordinate, page_end)
                            .map_err(semantic_error)
                    })
                    .transpose()?;
                let commit_head = read_local_commit_head(&transaction)?;
                let snapshot = AgentDocumentSemanticSnapshot {
                    document_id: authority.head.id.clone(),
                    generation: authority.head.generation,
                    head_seq: authority.head.head_seq,
                    owner_block_id: authority.owner_block_id,
                    target_block_id,
                    title: materialization.title,
                    rich_title: serde_json::to_value(materialization.rich_title)
                        .map_err(|_| internal("Document rich title cannot be serialized"))?,
                    nested_markdown: selected_nfm.nfm,
                    plain_text: selected_nfm.plain_text,
                    blocks,
                    title_etag,
                    body_etag,
                    has_more,
                    next_cursor,
                };
                transaction.commit()?;
                Ok(ModuleReadSnapshot {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    store_epoch: StoreEpoch(store_epoch),
                    commit_head,
                    authorization: None,
                    value: OwnedDocumentReadValue::AgentSemanticSnapshot {
                        snapshot: Box::new(snapshot),
                    },
                })
            })
            .map_err(core_error)
    }

    fn prepare_agent_semantic_mutation(
        &self,
        context: &BoundModuleContext,
        operation_id: String,
        expected_store_epoch: StoreEpoch,
        authorization: AgentExecutionAuthorization,
        mutation: AgentDocumentSemanticMutation,
    ) -> Result<ModuleReadSnapshot<OwnedDocumentReadValue>, CoreError> {
        validate_agent_transport_context(context, &authorization.provenance)?;
        let request_hash = sha256(&agent_semantic_request_fingerprint(
            &operation_id,
            &expected_store_epoch,
            &authorization,
            &mutation,
        )?);
        let cache = Arc::clone(&self.cache);
        let context = context.clone();
        let preparation = self
            .readers
            .read_default(|connection| {
                let transaction = connection.unchecked_transaction()?;
                let store_epoch = read_store_epoch(&transaction)?;
                if store_epoch != expected_store_epoch.0 {
                    return Err(StoreError::new(
                        StoreErrorCode::StaleStoreEpoch,
                        "Prepared Agent operation targets a stale store epoch",
                        true,
                    ));
                }
                let commit_head = read_local_commit_head(&transaction)?;
                if let Some(stored) = read_module_receipt(&transaction, MODULE_NAME, &operation_id)?
                {
                    if stored.request_hash != request_hash {
                        return Err(StoreError::new(
                            StoreErrorCode::IdempotencyKeyReused,
                            "operation_id is already bound to another Owned Document intent",
                            false,
                        ));
                    }
                    let local_commit_seq = stored.local_commit_seq;
                    let mut committed = serde_json::from_value::<
                        crate::ModuleWriterResult<OwnedDocumentCommitValue, OwnedDocumentReceipt>,
                    >(stored.result)
                    .map_err(|_| corrupt_receipt())?;
                    committed.receipt.mutation.duplicate = true;
                    let authority = read_document_authority(&transaction, &mutation.document_id)?
                        .ok_or_else(corrupt_receipt)?;
                    let mut footprint = nominal_agent_semantic_footprint(
                        &authority.owner_block_id,
                        &mutation.commands,
                        committed.value.mutation_effect.as_ref(),
                    )?;
                    footprint.deleted_owner_roots = committed
                        .value
                        .semantic_deleted_owner_block_ids
                        .clone()
                        .unwrap_or_default();
                    let committed = durable_mutation::replay_apply_response(
                        &transaction,
                        local_commit_seq,
                        committed,
                    )?;
                    transaction.commit()?;
                    return Ok(AgentSemanticPreparationResult::CommittedReplay {
                        store_epoch,
                        commit_head,
                        footprint,
                        committed: Box::new(committed),
                    });
                }

                let authority = read_document_authority(&transaction, &mutation.document_id)?
                    .ok_or_else(|| not_found("Owned Document was not found"))?;
                let authority_fingerprint = authorize_agent_page_document(
                    &transaction,
                    &context,
                    &authorization,
                    &authority,
                    AgentProjectResourceAction::Write,
                )?;
                if authority.head.generation != mutation.generation {
                    return Err(StoreError::new(
                        StoreErrorCode::GenerationConflict,
                        "Owned Document generation does not match",
                        false,
                    ));
                }
                let engine = cache
                    .lock()
                    .map_err(|_| internal("Document cache lock failed"))?
                    .clone_engine(&transaction, &authority.head)?;
                let schema = registered_yjs_schema(&authority)?;
                let materialization = materialize_engine(&engine, schema)?;
                let (prepared_update, preview_markdown) = prepare_semantic_update(
                    &transaction,
                    &authority,
                    &engine,
                    &materialization,
                    &store_epoch,
                    mutation.expected_head_seq,
                    &mutation.commands,
                    &operation_id,
                    &operation_id,
                    &authorization.provenance.authority.actor_project_id,
                )?;
                let mutation_effect = match &prepared_update {
                    PreparedUpdate::Apply {
                        mutation_effect, ..
                    } => mutation_effect.as_deref(),
                    PreparedUpdate::NoChange | PreparedUpdate::Recovery { .. } => None,
                };
                let footprint = agent_semantic_footprint(
                    &authority.owner_block_id,
                    &mutation.commands,
                    &materialization,
                    mutation_effect,
                )?;
                assert_agent_owner_deletion_forbidden(&footprint)?;
                let authority_revisions_hash = agent_authority_revisions_hash(
                    &transaction,
                    &authority_fingerprint,
                    &store_epoch,
                    &authority,
                    &footprint,
                )?;
                let binding = PreparedAgentOperationBinding {
                    connection_id: context.connection_id.clone(),
                    operation_id: operation_id.clone(),
                    request_hash: request_hash.clone(),
                    authority_revisions_hash,
                    footprint_hash: hash_serializable(
                        &footprint,
                        "Agent operation footprint cannot be fingerprinted",
                    )?,
                    effect_class: footprint.effect_class,
                };
                transaction.commit()?;
                Ok(AgentSemanticPreparationResult::Prepared {
                    store_epoch,
                    commit_head,
                    preflight: AgentSemanticPreflight {
                        footprint,
                        preview_markdown,
                        consent: AgentConsentRequirement::None,
                        binding,
                    },
                })
            })
            .map_err(core_error)?;

        match preparation {
            AgentSemanticPreparationResult::CommittedReplay {
                store_epoch,
                commit_head,
                footprint,
                committed,
            } => Ok(ModuleReadSnapshot {
                contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                store_epoch: StoreEpoch(store_epoch),
                commit_head,
                authorization: None,
                value: OwnedDocumentReadValue::AgentSemanticMutationPreparation {
                    preparation: AgentOperationPreparation {
                        state: AgentOperationPreparationState::CommittedReplay,
                        consent: AgentConsentRequirement::None,
                        footprint,
                        preview_markdown: None,
                        token: None,
                        expires_at_unix_ms: None,
                    },
                    committed: Some(committed),
                },
            }),
            AgentSemanticPreparationResult::Prepared {
                store_epoch,
                commit_head,
                preflight,
            } => {
                let issued = self
                    .prepared_agent_operations
                    .issue(preflight.binding)
                    .map_err(core_error)?;
                Ok(ModuleReadSnapshot {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    store_epoch: StoreEpoch(store_epoch),
                    commit_head,
                    authorization: None,
                    value: OwnedDocumentReadValue::AgentSemanticMutationPreparation {
                        preparation: AgentOperationPreparation {
                            state: AgentOperationPreparationState::Prepared,
                            consent: preflight.consent,
                            footprint: preflight.footprint,
                            preview_markdown: preflight.preview_markdown,
                            token: Some(issued.token),
                            expires_at_unix_ms: Some(issued.expires_at_unix_ms),
                        },
                        committed: None,
                    },
                })
            }
        }
    }

    pub fn compact(
        &self,
        context: &BoundModuleContext,
        expected_store_epoch: StoreEpoch,
        document_id: String,
        generation: i64,
        expected_head_seq: i64,
    ) -> Result<DocumentCompactionResult, CoreError> {
        self.validate_context(context)?;
        let context = context.clone();
        let cache = Arc::clone(&self.cache);
        self.writer
            .call(move |connection| {
                let transaction =
                    connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
                if read_store_epoch(&transaction)? != expected_store_epoch.0 {
                    return Err(StoreError::new(
                        StoreErrorCode::StaleStoreEpoch,
                        "Document compaction targets a stale store epoch",
                        true,
                    ));
                }
                let authority = read_document_authority(&transaction, &document_id)?
                    .ok_or_else(|| not_found("Owned Document was not found"))?;
                authorize_yjs(
                    &transaction,
                    &context,
                    &authority,
                    DocumentAccessKind::Write,
                )?;
                assert_document_head(&authority, generation, expected_head_seq)?;
                let engine = cache
                    .lock()
                    .map_err(|_| internal("Document cache lock failed"))?
                    .clone_engine(&transaction, &authority.head)?;
                let result = compact_yjs_document(&transaction, &authority, &engine)?;
                transaction.commit()?;
                cache
                    .lock()
                    .map_err(|_| internal("Document cache lock failed"))?
                    .install(&authority.head, engine);
                Ok(result)
            })
            .map_err(core_error)
    }

    fn apply_owner_command(
        &self,
        context: &BoundModuleContext,
        operation_id: String,
        expected_store_epoch: StoreEpoch,
        command: DocumentOwnerCommand,
    ) -> Result<OwnedDocumentApplyOutcome, CoreError> {
        let fingerprint = serde_json::to_vec(&(
            &context.profile_id,
            &context.library_id,
            &context.project_id,
            expected_store_epoch.clone(),
            semantic_owner_command(&command),
        ))
        .map_err(|_| invalid("Document owner command cannot be fingerprinted"))?;
        let request_hash = sha256(&fingerprint);
        let context = context.clone();
        let cache = Arc::clone(&self.cache);
        let fail_after_commit = Arc::clone(&self.fail_after_commit);
        self.writer
            .call(move |connection| {
                let transaction =
                    connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
                let store_epoch = read_store_epoch(&transaction)?;
                if store_epoch != expected_store_epoch.0 {
                    return Err(StoreError::new(
                        StoreErrorCode::StaleStoreEpoch,
                        "Document owner command targets a stale store epoch",
                        true,
                    ));
                }
                if let Some(stored) = read_module_receipt(&transaction, MODULE_NAME, &operation_id)?
                {
                    if stored.request_hash != request_hash {
                        return Err(StoreError::new(
                            StoreErrorCode::IdempotencyKeyReused,
                            "operation_id is already bound to another Owned Document intent",
                            false,
                        ));
                    }
                    let mut committed = serde_json::from_value::<
                        crate::ModuleWriterResult<OwnedDocumentCommitValue, OwnedDocumentReceipt>,
                    >(stored.result)
                    .map_err(|_| corrupt_receipt())?;
                    committed.receipt.mutation.duplicate = true;
                    transaction.commit()?;
                    return Ok(OwnedDocumentApplyOutcome {
                        committed,
                        events: Vec::new(),
                    });
                }
                let committed_at = sqlite_now(&transaction)?;
                let mut execution_delivery = None;
                let result = durable_mutation::run(
                    &transaction,
                    OperationIdentity {
                        module: ModuleName::OwnedDocument,
                        module_name: MODULE_NAME,
                        operation_id: &operation_id,
                        intent_hash: &request_hash,
                        store_epoch: &store_epoch,
                        committed_at: &committed_at,
                        context: &context,
                    },
                    |scope| {
                        let executed = execute_owner_command(
                            &transaction,
                            &context,
                            scope.evidence(),
                            &store_epoch,
                            &operation_id,
                            &command,
                        )?;
                        for event in &executed.events {
                            crate::database::record_page_document_projection_delta(
                                &transaction,
                                scope.evidence(),
                                &context.library_id.0,
                                &event.projection_impact,
                            )?;
                        }
                        let outcome_committed_at = executed
                            .events
                            .iter()
                            .find(|event| event.sequence == executed.event_sequence)
                            .map(|event| event.committed_at.clone())
                            .map_or_else(|| sqlite_now(&transaction), Ok)?;
                        let committed = crate::ModuleWriterResult {
                            value: OwnedDocumentCommitValue {
                                recovery: None,
                                document_id: executed.primary_document_id.clone(),
                                generation: executed.generation,
                                head_seq: executed.head_seq,
                                outcome: DocumentCommitOutcome::Committed,
                                committed_at: Some(outcome_committed_at),
                                canvas: None,
                                owner_effect: Some(executed.effect),
                                checkpoint_effect: None,
                                mutation_effect: None,
                                semantic_etags: None,
                                semantic_block_etags: None,
                                semantic_local_block_ids: None,
                                semantic_deleted_owner_block_ids: None,
                            },
                            receipt: OwnedDocumentReceipt {
                                mutation: ModuleMutationReceipt {
                                    operation_id: operation_id.clone(),
                                    duplicate: false,
                                },
                                document_id: executed.primary_document_id,
                                generation: executed.generation,
                                head_seq: executed.head_seq,
                            },
                            commit_seq: 0,
                            event_sequence: executed.event_sequence,
                            store_epoch: StoreEpoch(store_epoch.clone()),
                        };
                        let event_sequence = executed.events.last().map(|event| event.sequence);
                        execution_delivery =
                            Some((executed.events, executed.invalidate_document_ids));
                        seal_typed_receipt(
                            scope,
                            owner_command_kind(&command),
                            committed,
                            event_sequence,
                        )
                    },
                )?;
                let committed = resolve_typed_commit(result);
                let (events, invalidate_document_ids) = execution_delivery.ok_or_else(|| {
                    internal("Document owner mutation omitted its delivery result")
                })?;
                transaction.commit()?;
                {
                    let mut cache = cache
                        .lock()
                        .map_err(|_| internal("Document cache lock failed"))?;
                    for document_id in &invalidate_document_ids {
                        cache.invalidate(document_id);
                    }
                }
                if fail_after_commit.swap(false, Ordering::AcqRel) {
                    return Err(StoreError::new(
                        StoreErrorCode::Internal,
                        "Injected failure after durable Document owner command",
                        true,
                    ));
                }
                Ok(OwnedDocumentApplyOutcome { committed, events })
            })
            .map_err(core_error)
    }

    fn prepare_owner(
        &self,
        context: &BoundModuleContext,
        operation_id: String,
        expected_store_epoch: StoreEpoch,
        owner_block_id: String,
    ) -> Result<OwnedDocumentApplyOutcome, CoreError> {
        let fingerprint = serde_json::to_vec(&(
            DurableModuleContext::from(context),
            expected_store_epoch.clone(),
            &owner_block_id,
        ))
        .map_err(|_| invalid("Owned Document preparation cannot be fingerprinted"))?;
        let request_hash = sha256(&fingerprint);
        let context = context.clone();
        let cache = Arc::clone(&self.cache);
        let fail_after_commit = Arc::clone(&self.fail_after_commit);
        let assets_root = self.assets_root.clone();
        self.writer
            .call(move |connection| {
                let transaction =
                    connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
                let store_epoch = read_store_epoch(&transaction)?;
                if store_epoch != expected_store_epoch.0 {
                    return Err(StoreError::new(
                        StoreErrorCode::StaleStoreEpoch,
                        "Owned Document preparation targets a stale store epoch",
                        true,
                    ));
                }
                if let Some(stored) = read_module_receipt(&transaction, MODULE_NAME, &operation_id)?
                {
                    if stored.request_hash != request_hash {
                        return Err(StoreError::new(
                            StoreErrorCode::IdempotencyKeyReused,
                            "operation_id is already bound to another Owned Document intent",
                            false,
                        ));
                    }
                    let mut committed = serde_json::from_value::<
                        crate::ModuleWriterResult<OwnedDocumentCommitValue, OwnedDocumentReceipt>,
                    >(stored.result)
                    .map_err(|_| corrupt_receipt())?;
                    committed.receipt.mutation.duplicate = true;
                    transaction.commit()?;
                    return Ok(OwnedDocumentApplyOutcome {
                        committed,
                        events: Vec::new(),
                    });
                }
                let document_id = transaction
                    .query_row(
                        "SELECT document_id FROM block_documents WHERE block_id = ?1",
                        [&owner_block_id],
                        |row| row.get::<_, String>(0),
                    )
                    .optional()?
                    .ok_or_else(|| not_found("Owned Document owner was not found"))?;
                let authority = read_document_authority(&transaction, &document_id)?
                    .ok_or_else(|| not_found("Owned Document was not found"))?;
                authorize_document_access(
                    &transaction,
                    &context,
                    &authority,
                    DocumentAccessKind::Write,
                )?;
                if authority.owner_block_id != owner_block_id
                    || authority.owner_lifecycle != "active"
                {
                    return Err(StoreError::new(
                        StoreErrorCode::Unauthorized,
                        "Owned Document owner is not active",
                        false,
                    ));
                }
                if authority.head.sync_engine == DocumentSyncEngine::CanvasScene {
                    authorize_canvas(
                        &transaction,
                        &context,
                        &authority,
                        DocumentAccessKind::Write,
                    )?;
                    let (_, created) = ensure_canvas_scene(&transaction, &authority, &assets_root)?;
                    let commit_head = read_event_head(&transaction)?;
                    let mut committed = committed_value(
                        &operation_id,
                        &store_epoch,
                        &authority,
                        authority.head.head_seq,
                        if created {
                            DocumentCommitOutcome::Committed
                        } else {
                            DocumentCommitOutcome::NoChange
                        },
                        commit_head,
                    );
                    insert_typed_receipt(
                        &transaction,
                        &context,
                        &operation_id,
                        &request_hash,
                        &store_epoch,
                        "prepare_owner",
                        &mut committed,
                        None,
                    )?;
                    transaction.commit()?;
                    if fail_after_commit.swap(false, Ordering::AcqRel) {
                        return Err(StoreError::new(
                            StoreErrorCode::Internal,
                            "Injected failure after durable Canvas preparation",
                            true,
                        ));
                    }
                    return Ok(OwnedDocumentApplyOutcome {
                        committed,
                        events: Vec::new(),
                    });
                }
                let schema = registered_yjs_schema(&authority)?;
                let root_block_id = allocate_document_block_id(&operation_id, 1);
                let (committed, event, next_head, next_engine) =
                    match (authority.head.readiness, authority.head.authority) {
                        (DocumentReadiness::PendingGenesis, DocumentAuthority::LegacyShadow) => {
                            if authority.head.head_seq != 0 {
                                return Err(StoreError::new(
                                    StoreErrorCode::StoreCorrupt,
                                    "Pending Document genesis has a nonzero head",
                                    false,
                                ));
                            }
                            let prepared = prepare_yjs_genesis(
                                &authority.head.id,
                                &authority.owner_type,
                                schema,
                                &root_block_id,
                            )?;
                            let committed_at = sqlite_now(&transaction)?;
                            let mut prepared_delivery = None;
                            let result = durable_mutation::run(
                                &transaction,
                                OperationIdentity {
                                    module: ModuleName::OwnedDocument,
                                    module_name: MODULE_NAME,
                                    operation_id: &operation_id,
                                    intent_hash: &request_hash,
                                    store_epoch: &store_epoch,
                                    committed_at: &committed_at,
                                    context: &context,
                                },
                                |scope| {
                                    let persisted = persist_yjs_genesis_with_local_commit(
                                        &transaction,
                                        PersistYjsGenesis {
                                            authority: &authority,
                                            actor_project_id: bound_actor_project_id(&context)?,
                                            materialization: &prepared.materialization,
                                            update_id: &operation_id,
                                            client_session_id: &context.connection_id,
                                            update: &prepared.update_v1,
                                            state_vector: &prepared.state_vector_v1,
                                            full_state: &prepared.update_v1,
                                            store_epoch: &store_epoch,
                                            operation_id: &operation_id,
                                            placement: DocumentPlacementEvidence::STRUCTURAL,
                                            emit_event: true,
                                        },
                                        scope.evidence(),
                                    )?;
                                    let committed = committed_value(
                                        &operation_id,
                                        &store_epoch,
                                        &authority,
                                        persisted.head_seq,
                                        DocumentCommitOutcome::Committed,
                                        persisted.event_sequence,
                                    );
                                    let event = load_committed_event_by_sequence(
                                        &transaction,
                                        persisted.event_sequence,
                                    )?;
                                    record_page_document_projection_delta(
                                        scope,
                                        &authority,
                                        &event.projection_impact,
                                    )?;
                                    let mut next_head = authority.head.clone();
                                    next_head.head_seq = persisted.head_seq;
                                    next_head.state_vector = persisted.state_vector;
                                    next_head.readiness = DocumentReadiness::Ready;
                                    next_head.authority = DocumentAuthority::YdocPrimary;
                                    prepared_delivery =
                                        Some((Some(event), next_head, prepared.engine));
                                    seal_typed_receipt(
                                        scope,
                                        "prepare_owner",
                                        committed,
                                        Some(persisted.event_sequence),
                                    )
                                },
                            )?;
                            let committed = resolve_typed_commit(result);
                            let (event, next_head, engine) =
                                prepared_delivery.ok_or_else(|| {
                                    internal("Document genesis omitted its delivery result")
                                })?;
                            (committed, event, next_head, engine)
                        }
                        (DocumentReadiness::Ready, DocumentAuthority::YdocPrimary) => {
                            authorize_yjs(
                                &transaction,
                                &context,
                                &authority,
                                DocumentAccessKind::Write,
                            )?;
                            let mut engine = cache
                                .lock()
                                .map_err(|_| internal("Document cache lock failed"))?
                                .clone_engine(&transaction, &authority.head)?;
                            let base_materialization = materialize_engine(&engine, schema)?;
                            let Some(prepared) = prepare_editable_root(
                                &authority.head.id,
                                schema,
                                &engine,
                                &root_block_id,
                            )?
                            else {
                                let commit_head = read_event_head(&transaction)?;
                                let mut committed = committed_value(
                                    &operation_id,
                                    &store_epoch,
                                    &authority,
                                    authority.head.head_seq,
                                    DocumentCommitOutcome::NoChange,
                                    commit_head,
                                );
                                insert_typed_receipt(
                                    &transaction,
                                    &context,
                                    &operation_id,
                                    &request_hash,
                                    &store_epoch,
                                    "prepare_owner",
                                    &mut committed,
                                    None,
                                )?;
                                transaction.commit()?;
                                cache
                                    .lock()
                                    .map_err(|_| internal("Document cache lock failed"))?
                                    .install(&authority.head, engine);
                                return Ok(OwnedDocumentApplyOutcome {
                                    committed,
                                    events: Vec::new(),
                                });
                            };
                            let candidate = engine
                                .prepare_update_v1(&prepared.update_v1)
                                .map_err(engine_error)?;
                            let materialization = materialize_candidate(&candidate, schema)?;
                            let candidate_transaction = candidate.document().transact();
                            let state_vector = candidate_transaction.state_vector().encode_v1();
                            drop(candidate_transaction);
                            let committed_at = sqlite_now(&transaction)?;
                            let mut prepared_delivery = None;
                            let result = durable_mutation::run(
                                &transaction,
                                OperationIdentity {
                                    module: ModuleName::OwnedDocument,
                                    module_name: MODULE_NAME,
                                    operation_id: &operation_id,
                                    intent_hash: &request_hash,
                                    store_epoch: &store_epoch,
                                    committed_at: &committed_at,
                                    context: &context,
                                },
                                |scope| {
                                    let persisted = persist_yjs_commit_with_local_commit(
                                        &transaction,
                                        PersistYjsCommit {
                                            authority: &authority,
                                            actor_project_id: bound_actor_project_id(&context)?,
                                            base_materialization: &base_materialization,
                                            materialization: &materialization,
                                            update_id: &operation_id,
                                            client_session_id: &context.connection_id,
                                            base_head_seq: authority.head.head_seq,
                                            client_touched_block_ids: &[],
                                            update: &prepared.update_v1,
                                            state_vector: &state_vector,
                                            store_epoch: &store_epoch,
                                            operation_id: &operation_id,
                                            local_commit_id: None,
                                            event_kind: "document_updated",
                                            write_fence_block_ids: &prepared.write_fence_block_ids,
                                            title_write_fence_required: prepared
                                                .title_write_fence_required,
                                            document_write_fence_required: false,
                                            placement: DocumentPlacementEvidence::STRUCTURAL,
                                        },
                                        scope.evidence(),
                                    )?;
                                    let committed = committed_value(
                                        &operation_id,
                                        &store_epoch,
                                        &authority,
                                        persisted.head_seq,
                                        DocumentCommitOutcome::Committed,
                                        persisted.event_sequence,
                                    );
                                    let event = load_committed_event_by_sequence(
                                        &transaction,
                                        persisted.event_sequence,
                                    )?;
                                    record_page_document_projection_delta(
                                        scope,
                                        &authority,
                                        &event.projection_impact,
                                    )?;
                                    engine.commit_candidate(candidate).map_err(engine_error)?;
                                    let mut next_head = authority.head.clone();
                                    next_head.head_seq = persisted.head_seq;
                                    next_head.state_vector = persisted.state_vector;
                                    prepared_delivery = Some((Some(event), next_head, engine));
                                    seal_typed_receipt(
                                        scope,
                                        "prepare_owner",
                                        committed,
                                        Some(persisted.event_sequence),
                                    )
                                },
                            )?;
                            let committed = resolve_typed_commit(result);
                            let (event, next_head, engine) =
                                prepared_delivery.ok_or_else(|| {
                                    internal("Document preparation omitted its delivery result")
                                })?;
                            (committed, event, next_head, engine)
                        }
                        _ => {
                            return Err(StoreError::new(
                                StoreErrorCode::StoreCorrupt,
                                "Owned Document readiness and authority diverge",
                                false,
                            ));
                        }
                    };
                transaction.commit()?;
                if fail_after_commit.swap(false, Ordering::AcqRel) {
                    cache
                        .lock()
                        .map_err(|_| internal("Document cache lock failed"))?
                        .invalidate(&document_id);
                    return Err(StoreError::new(
                        StoreErrorCode::Internal,
                        "Injected failure after durable Document preparation",
                        true,
                    ));
                }
                cache
                    .lock()
                    .map_err(|_| internal("Document cache lock failed"))?
                    .install(&next_head, next_engine);
                Ok(OwnedDocumentApplyOutcome {
                    committed,
                    events: event.into_iter().collect(),
                })
            })
            .map_err(core_error)
    }

    #[allow(clippy::too_many_arguments)]
    fn apply_canvas_scene_mutation(
        &self,
        context: &BoundModuleContext,
        operation_id: String,
        expected_store_epoch: StoreEpoch,
        document_id: String,
        generation: i64,
        base_head_seq: i64,
        mutation_value: Value,
    ) -> Result<OwnedDocumentApplyOutcome, CoreError> {
        let mutation = parse_canvas_mutation(&mutation_value).map_err(core_error)?;
        let fingerprint = canvas_semantic_intent_fingerprint(
            &self.profile_id,
            &self.library_id,
            context
                .project_id
                .as_ref()
                .map(|project_id| project_id.0.as_str()),
            &expected_store_epoch.0,
            &document_id,
            generation,
            base_head_seq,
            &operation_id,
            &mutation.canonical_value,
        )
        .map_err(core_error)?;
        let request_hash = sha256(&fingerprint);
        let context = context.clone();
        let fail_after_commit = Arc::clone(&self.fail_after_commit);
        let assets_root = self.assets_root.clone();
        self.writer
            .call(move |connection| {
                let transaction =
                    connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
                let store_epoch = read_store_epoch(&transaction)?;
                if store_epoch != expected_store_epoch.0 {
                    return Err(StoreError::new(
                        StoreErrorCode::StaleStoreEpoch,
                        "Canvas mutation targets a stale store epoch",
                        true,
                    ));
                }
                if let Some(stored) = read_module_receipt(&transaction, MODULE_NAME, &operation_id)?
                {
                    if stored.request_hash != request_hash {
                        return Err(StoreError::new(
                            StoreErrorCode::IdempotencyKeyReused,
                            "operation_id is already bound to another Owned Document intent",
                            false,
                        ));
                    }
                    let mut committed = serde_json::from_value::<
                        crate::ModuleWriterResult<OwnedDocumentCommitValue, OwnedDocumentReceipt>,
                    >(stored.result)
                    .map_err(|_| corrupt_receipt())?;
                    committed.receipt.mutation.duplicate = true;
                    if let Some(canvas) = committed.value.canvas.as_mut()
                        && let Some(object) = canvas.as_object_mut()
                    {
                        object.insert("duplicate".to_owned(), Value::Bool(true));
                    }
                    transaction.commit()?;
                    return Ok(OwnedDocumentApplyOutcome {
                        committed,
                        events: Vec::new(),
                    });
                }
                let authority = read_document_authority(&transaction, &document_id)?
                    .ok_or_else(|| not_found("Canvas Document was not found"))?;
                authorize_canvas(
                    &transaction,
                    &context,
                    &authority,
                    DocumentAccessKind::Write,
                )?;
                let actor_project_id = context
                    .project_id
                    .as_ref()
                    .map(|project_id| project_id.0.clone())
                    .map_or_else(
                        || {
                            crate::library::resolve_library_actor_project_id(
                                &transaction,
                                &authority.head.library_id,
                            )
                        },
                        Ok,
                    )?;
                let actor_context = if context.project_id.is_some() {
                    context.clone()
                } else {
                    BoundModuleContext {
                        editor_history_owner: None,
                        project_id: Some(ProjectId(actor_project_id.clone())),
                        ..context.clone()
                    }
                };
                if authority.head.generation != generation {
                    return Err(StoreError::new(
                        StoreErrorCode::GenerationConflict,
                        "Canvas Document generation does not match",
                        false,
                    ));
                }
                let prepared =
                    prepare_incremental_canvas_mutation(&transaction, &authority, &mutation)?;
                super::canvas_files::authorize_additions(
                    &transaction,
                    &context,
                    &authority,
                    prepared.added_files(),
                )?;
                let committed_at = sqlite_now(&transaction)?;
                let (committed, event) = if prepared.changed() {
                    let mut delivered_event = None;
                    let result = durable_mutation::run(
                        &transaction,
                        OperationIdentity {
                            module: ModuleName::OwnedDocument,
                            module_name: MODULE_NAME,
                            operation_id: &operation_id,
                            intent_hash: &request_hash,
                            store_epoch: &store_epoch,
                            committed_at: &committed_at,
                            context: &actor_context,
                        },
                        |scope| {
                            let revision_now = sqlite_now(&transaction)?;
                            if let Some(revision) =
                                prepare_canvas_revision(&transaction, &authority, &revision_now)?
                            {
                                let loaded = load_canvas_scene(&transaction, &authority)?;
                                insert_prepared_canvas_revision(
                                    &transaction,
                                    &authority,
                                    &loaded.scene,
                                    &actor_context,
                                    &revision_now,
                                    &revision,
                                )?;
                            }
                            let persisted = persist_prepared_canvas_mutation(
                                &transaction,
                                Some(scope.evidence()),
                                &authority,
                                &actor_project_id,
                                &document_access_context(&context),
                                &store_epoch,
                                &operation_id,
                                base_head_seq,
                                &request_hash,
                                &mutation,
                                &prepared,
                                &assets_root,
                                "canvas_scene_updated",
                            )?;
                            record_document_revision_edit(
                                &transaction,
                                &authority.head.id,
                                authority.head.generation,
                                persisted.head_seq,
                                &context.connection_id,
                                &persisted.committed_at,
                            )?;
                            let committed = committed_canvas_value(
                                &operation_id,
                                &store_epoch,
                                &authority,
                                persisted.head_seq,
                                DocumentCommitOutcome::Committed,
                                persisted.event_sequence,
                                persisted.result,
                            );
                            delivered_event = Some(load_committed_event_by_sequence(
                                &transaction,
                                persisted.event_sequence,
                            )?);
                            seal_typed_receipt(
                                scope,
                                "apply_canvas_mutation",
                                committed,
                                Some(persisted.event_sequence),
                            )
                        },
                    )?;
                    (resolve_typed_commit(result), delivered_event)
                } else {
                    let persisted = persist_prepared_canvas_mutation(
                        &transaction,
                        None,
                        &authority,
                        &actor_project_id,
                        &document_access_context(&context),
                        &store_epoch,
                        &operation_id,
                        base_head_seq,
                        &request_hash,
                        &mutation,
                        &prepared,
                        &assets_root,
                        "canvas_scene_updated",
                    )?;
                    let mut committed = committed_canvas_value(
                        &operation_id,
                        &store_epoch,
                        &authority,
                        persisted.head_seq,
                        DocumentCommitOutcome::NoChange,
                        persisted.event_sequence,
                        persisted.result,
                    );
                    insert_typed_receipt(
                        &transaction,
                        &actor_context,
                        &operation_id,
                        &request_hash,
                        &store_epoch,
                        "apply_canvas_mutation",
                        &mut committed,
                        None,
                    )?;
                    (committed, None)
                };
                transaction.commit()?;
                if fail_after_commit.swap(false, Ordering::AcqRel) {
                    return Err(StoreError::new(
                        StoreErrorCode::Internal,
                        "Injected failure after durable Canvas commit",
                        true,
                    ));
                }
                Ok(OwnedDocumentApplyOutcome {
                    committed,
                    events: event.into_iter().collect(),
                })
            })
            .map_err(core_error)
    }

    #[allow(clippy::too_many_arguments)]
    fn compact_canvas_tombstones(
        &self,
        context: &BoundModuleContext,
        operation_id: String,
        expected_store_epoch: StoreEpoch,
        document_id: String,
        generation: i64,
        expected_head_seq: i64,
        actor: Value,
    ) -> Result<OwnedDocumentApplyOutcome, CoreError> {
        validate_document_actor(&actor)?;
        let fingerprint = serde_json::to_vec(&CanvasCompactionFingerprint {
            version: 1,
            profile_id: &self.profile_id,
            library_id: &self.library_id,
            project_id: context
                .project_id
                .as_ref()
                .map(|project_id| project_id.0.as_str()),
            expected_store_epoch: &expected_store_epoch.0,
            document_id: &document_id,
            generation,
            expected_head_seq,
            operation_id: &operation_id,
            actor: &actor,
        })
        .map_err(|_| invalid("Canvas compaction request cannot be fingerprinted"))?;
        let request_hash = sha256(&fingerprint);
        let context = context.clone();
        let fail_after_commit = Arc::clone(&self.fail_after_commit);
        let assets_root = self.assets_root.clone();
        self.writer
            .call(move |connection| {
                let transaction =
                    connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
                let store_epoch = read_store_epoch(&transaction)?;
                if store_epoch != expected_store_epoch.0 {
                    return Err(StoreError::new(
                        StoreErrorCode::StaleStoreEpoch,
                        "Canvas compaction targets a stale store epoch",
                        true,
                    ));
                }
                if let Some(stored) = read_module_receipt(&transaction, MODULE_NAME, &operation_id)?
                {
                    if stored.request_hash != request_hash {
                        return Err(StoreError::new(
                            StoreErrorCode::IdempotencyKeyReused,
                            "operation_id is already bound to another Owned Document intent",
                            false,
                        ));
                    }
                    let mut committed = serde_json::from_value::<
                        crate::ModuleWriterResult<OwnedDocumentCommitValue, OwnedDocumentReceipt>,
                    >(stored.result)
                    .map_err(|_| corrupt_receipt())?;
                    committed.receipt.mutation.duplicate = true;
                    if let Some(canvas) = committed.value.canvas.as_mut()
                        && let Some(object) = canvas.as_object_mut()
                    {
                        object.insert("duplicate".to_owned(), Value::Bool(true));
                    }
                    transaction.commit()?;
                    return Ok(OwnedDocumentApplyOutcome {
                        committed,
                        events: Vec::new(),
                    });
                }
                let authority = read_document_authority(&transaction, &document_id)?
                    .ok_or_else(|| not_found("Canvas Document was not found"))?;
                authorize_canvas(
                    &transaction,
                    &context,
                    &authority,
                    DocumentAccessKind::Write,
                )?;
                let actor_project_id = context
                    .project_id
                    .as_ref()
                    .map(|project_id| project_id.0.clone())
                    .map_or_else(
                        || {
                            crate::library::resolve_library_actor_project_id(
                                &transaction,
                                &authority.head.library_id,
                            )
                        },
                        Ok,
                    )?;
                let actor_context = if context.project_id.is_some() {
                    context.clone()
                } else {
                    BoundModuleContext {
                        editor_history_owner: None,
                        project_id: Some(ProjectId(actor_project_id.clone())),
                        ..context.clone()
                    }
                };
                if authority.head.generation != generation {
                    return Err(StoreError::new(
                        StoreErrorCode::GenerationConflict,
                        "Canvas Document generation does not match",
                        false,
                    ));
                }
                if authority.head.head_seq != expected_head_seq {
                    return Err(StoreError::new(
                        StoreErrorCode::HeadConflict,
                        "Canvas compaction requires the exact current head",
                        true,
                    ));
                }
                let prepared = prepare_canvas_compaction(&transaction, &authority)?;
                let now = sqlite_now(&transaction)?;
                let changed = prepared.stats.tombstone_count > 0;
                let (committed, event) = if changed {
                    let mut delivered_event = None;
                    let result = durable_mutation::run(
                        &transaction,
                        OperationIdentity {
                            module: ModuleName::OwnedDocument,
                            module_name: MODULE_NAME,
                            operation_id: &operation_id,
                            intent_hash: &request_hash,
                            store_epoch: &store_epoch,
                            committed_at: &now,
                            context: &actor_context,
                        },
                        |scope| {
                            let checkpoint = insert_canvas_checkpoint(
                                &transaction,
                                &authority,
                                &prepared.original_scene,
                                NewDocumentCheckpoint {
                                    operation_id: &operation_id,
                                    cause: "canvas_tombstone_compaction",
                                    label: Some("Before Canvas compaction"),
                                    revision_kind: "safety",
                                    source_mutation_id: None,
                                    source_change_seq: None,
                                    actor: Some(&actor),
                                    context: &actor_context,
                                    now: &now,
                                },
                            )?;
                            let checkpoint_version_id = checkpoint
                                .version
                                .summary
                                .get("versionId")
                                .and_then(Value::as_str)
                                .map(str::to_owned)
                                .ok_or_else(|| {
                                    internal("Canvas compaction checkpoint identity is missing")
                                })?;
                            let persisted = persist_canvas_compaction(
                                &transaction,
                                &authority,
                                &prepared,
                                &now,
                                &assets_root,
                            )?;
                            let mut next_authority = authority.clone();
                            next_authority.head.generation = persisted.generation;
                            next_authority.head.head_seq = persisted.head_seq;
                            next_authority.head.state_hash = persisted.scene_hash;
                            transaction.execute(
                                "INSERT INTO canvas_scene_mutation_receipts (\
                                   document_id, generation, mutation_id, base_head_seq, committed_head_seq, \
                                   intent_hash, intent_byte_length, outcome, committed_at\
                                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'committed', ?8)",
                                rusqlite::params![
                                    authority.head.id,
                                    next_authority.head.generation,
                                    operation_id,
                                    authority.head.head_seq,
                                    next_authority.head.head_seq,
                                    request_hash,
                                    i64::try_from(fingerprint.len()).map_err(|_| {
                                        internal("Canvas compaction intent length")
                                    })?,
                                    now,
                                ],
                            )?;
                            let payload = json!({
                                "module": "owned_document",
                                "kind": "canvas_generation_changed",
                                "documentId": authority.head.id,
                                "previousGeneration": authority.head.generation,
                                "previousHeadSeq": authority.head.head_seq,
                                "generation": next_authority.head.generation,
                                "headSeq": next_authority.head.head_seq,
                                "sceneHash": next_authority.head.state_hash,
                            });
                            let block_ids = vec![authority.owner_block_id.clone()];
                            let document_ids = vec![authority.head.id.clone()];
                            let payload_json = serde_json::to_string(&payload)
                                .map_err(|_| internal("Canvas compaction event payload"))?;
                            let event_sequence = append_change_log(
                                &transaction,
                                NewChangeLogEntry {
                                    project_id: &actor_project_id,
                                    store_epoch: &store_epoch,
                                    kind: "owned_document.canvas_generation_changed",
                                    operation_id: Some(&operation_id),
                                    block_ids: &block_ids,
                                    document_ids: &document_ids,
                                    database_block_ids: &[],
                                    payload_json: &payload_json,
                                    projection_impact: &ProjectionImpact::None,
                                    committed_at: &now,
                                },
                                scope.evidence(),
                            )?;
                            let canvas_result = json!({
                                "kind": "tombstone_compaction",
                                "operationId": operation_id,
                                "libraryId": authority.head.library_id,
                                "accessContext": document_access_context(&context),
                                "documentId": authority.head.id,
                                "storeEpoch": store_epoch,
                                "previousGeneration": authority.head.generation,
                                "previousHeadSeq": authority.head.head_seq,
                                "generation": next_authority.head.generation,
                                "headSeq": next_authority.head.head_seq,
                                "duplicate": false,
                                "outcome": "committed",
                                "sceneHash": next_authority.head.state_hash,
                                "removedTombstoneCount": prepared.stats.tombstone_count,
                                "removedTombstoneBytes": prepared.stats.tombstone_bytes,
                                "checkpointVersionId": checkpoint_version_id,
                                "committedAt": now,
                            });
                            let committed = committed_canvas_value(
                                &operation_id,
                                &store_epoch,
                                &next_authority,
                                next_authority.head.head_seq,
                                DocumentCommitOutcome::Committed,
                                event_sequence,
                                canvas_result,
                            );
                            delivered_event = Some(load_committed_event_by_sequence(
                                &transaction,
                                event_sequence,
                            )?);
                            seal_typed_receipt(
                                scope,
                                "compact_canvas_tombstones",
                                committed,
                                Some(event_sequence),
                            )
                        },
                    )?;
                    (resolve_typed_commit(result), delivered_event)
                } else {
                    transaction.execute(
                        "INSERT INTO canvas_scene_mutation_receipts (\
                           document_id, generation, mutation_id, base_head_seq, committed_head_seq, \
                           intent_hash, intent_byte_length, outcome, committed_at\
                         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'no_change', ?8)",
                        rusqlite::params![
                            authority.head.id,
                            authority.head.generation,
                            operation_id,
                            authority.head.head_seq,
                            authority.head.head_seq,
                            request_hash,
                            i64::try_from(fingerprint.len())
                                .map_err(|_| internal("Canvas compaction intent length"))?,
                            now,
                        ],
                    )?;
                    let canvas_result = json!({
                        "kind": "tombstone_compaction",
                        "operationId": operation_id,
                        "libraryId": authority.head.library_id,
                        "accessContext": document_access_context(&context),
                        "documentId": authority.head.id,
                        "storeEpoch": store_epoch,
                        "previousGeneration": authority.head.generation,
                        "previousHeadSeq": authority.head.head_seq,
                        "generation": authority.head.generation,
                        "headSeq": authority.head.head_seq,
                        "duplicate": false,
                        "outcome": "no_change",
                        "sceneHash": authority.head.state_hash,
                        "removedTombstoneCount": 0,
                        "removedTombstoneBytes": 0,
                        "checkpointVersionId": Value::Null,
                        "committedAt": now,
                    });
                    let mut committed = committed_canvas_value(
                        &operation_id,
                        &store_epoch,
                        &authority,
                        authority.head.head_seq,
                        DocumentCommitOutcome::NoChange,
                        read_event_head(&transaction)?,
                        canvas_result,
                    );
                    insert_typed_receipt(
                        &transaction,
                        &actor_context,
                        &operation_id,
                        &request_hash,
                        &store_epoch,
                        "compact_canvas_tombstones",
                    &mut committed,
                    None,
                )?;
                    (committed, None)
                };
                transaction.commit()?;
                if fail_after_commit.swap(false, Ordering::AcqRel) {
                    return Err(StoreError::new(
                        StoreErrorCode::Internal,
                        "Injected failure after durable Canvas compaction",
                        true,
                    ));
                }
                Ok(OwnedDocumentApplyOutcome {
                    committed,
                    events: event.into_iter().collect(),
                })
            })
            .map_err(core_error)
    }

    #[allow(clippy::too_many_arguments)]
    fn apply_yjs_update(
        &self,
        context: &BoundModuleContext,
        client_session_id: &str,
        operation_id: String,
        expected_store_epoch: StoreEpoch,
        document_id: String,
        generation: i64,
        base_head_seq: i64,
        update_id: String,
        touched_block_ids: Vec<String>,
        update: Vec<u8>,
    ) -> Result<OwnedDocumentApplyOutcome, CoreError> {
        if operation_id != update_id {
            return Err(invalid(
                "Yjs update_id must equal the Module operation_id for durable idempotency",
            ));
        }
        validate_touched_block_ids(&touched_block_ids)?;
        let fingerprint = serde_json::to_vec(&(
            DurableModuleContext::from(context),
            client_session_id,
            expected_store_epoch.clone(),
            generation,
            base_head_seq,
            &update_id,
            &touched_block_ids,
            sha256(&update),
            update.len(),
        ))
        .map_err(|_| invalid("Owned Document request cannot be fingerprinted"))?;
        let request_hash = sha256(&fingerprint);
        let receipt_document_id = document_id.clone();
        let receipt_update_id = update_id.clone();
        let receipt_client_session_id = client_session_id.to_owned();
        let requested_actor_project_id = context
            .project_id
            .as_ref()
            .map(|project_id| project_id.0.clone());
        self.apply_document_update(
            DocumentUpdateJob {
                context: context.clone(),
                client_session_id: client_session_id.to_owned(),
                operation_id,
                expected_store_epoch,
                document_id,
                generation,
                operation_kind: "apply_yjs_update",
                request_hash,
                publication: UpdatePublication::Updated,
                prepared_agent: None,
                semantic_block_etag_ids: Vec::new(),
                include_local_block_etags: false,
                recovery: None,
            },
            move |connection, authority, engine, materialization, store_epoch| {
                if base_head_seq > authority.head.head_seq {
                    return Err(StoreError::new(
                        StoreErrorCode::HeadConflict,
                        "Yjs update is based on a future Document head",
                        true,
                    ));
                }
                let receipt_conflicts =
                    crate::infrastructure::document_repository::DocumentReadRepository::new(
                        connection,
                    )
                    .update_receipt(&receipt_document_id, &receipt_update_id)?
                    .is_some_and(|receipt| {
                        receipt.generation != generation
                            || receipt.client_session_id != receipt_client_session_id
                            || receipt.base_head_seq != base_head_seq
                            || receipt.client_touched_block_ids != touched_block_ids
                            || receipt.update_hash != sha256(&update)
                            || receipt.update_byte_length
                                != i64::try_from(update.len()).unwrap_or(i64::MAX)
                    });
                if receipt_conflicts {
                    return Err(StoreError::new(
                        StoreErrorCode::IdempotencyKeyReused,
                        "update_id is already bound to another Yjs update",
                        false,
                    ));
                }
                let derived_touched_block_ids = if base_head_seq < authority.head.head_seq {
                    let schema = BlockDocumentSchema::from_identity(
                        &authority.head.schema_key,
                        authority.head.schema_version,
                    )
                    .ok_or_else(|| {
                        StoreError::new(
                            StoreErrorCode::UnsupportedSchema,
                            "Owned Document schema is unsupported",
                            false,
                        )
                    })?;
                    let current_touched = derive_update_touched_block_ids(
                        &authority.owner_block_id,
                        engine,
                        materialization,
                        schema,
                        &update,
                    );
                    let historical_touched = if base_head_seq == 0 {
                        None
                    } else {
                        let historical_engine = reconstruct_retained_yjs_engine_at(
                            connection,
                            &authority.head,
                            base_head_seq,
                        )?;
                        match historical_engine {
                            Some(historical_engine) => {
                                let historical_materialization =
                                    materialize_engine(&historical_engine, schema)?;
                                derive_update_touched_block_ids(
                                    &authority.owner_block_id,
                                    &historical_engine,
                                    &historical_materialization,
                                    schema,
                                    &update,
                                )
                            }
                            None => None,
                        }
                    };
                    match (current_touched, historical_touched) {
                        (Some(mut current), Some(historical)) => {
                            current.extend(historical);
                            Some(current.into_iter().collect::<Vec<_>>())
                        }
                        _ => None,
                    }
                } else {
                    None
                };
                let actor_project_id = requested_actor_project_id.clone().map_or_else(
                    || {
                        crate::library::resolve_library_actor_project_id(
                            connection,
                            &authority.head.library_id,
                        )
                    },
                    Ok,
                )?;
                if let Some(artifact_id) = persist_recovery_if_barrier_crossed(
                    connection,
                    authority,
                    StaleYjsUpdate {
                        actor_project_id: &actor_project_id,
                        store_epoch,
                        client_session_id: &receipt_client_session_id,
                        generation,
                        base_head_seq,
                        update_id: &receipt_update_id,
                        touched_block_ids: &touched_block_ids,
                        derived_touched_block_ids: derived_touched_block_ids.as_deref(),
                        update: &update,
                    },
                )? {
                    return Ok(PreparedUpdate::Recovery { artifact_id });
                }
                Ok(PreparedUpdate::Apply {
                    file_restore: None,
                    base_head_seq,
                    update_id,
                    touched_block_ids,
                    update,
                    write_fence_block_ids: Vec::new(),
                    placement_attribution: PreparedPlacementAttribution::Collaborative,
                    title_write_fence_required: false,
                    document_write_fence_required: false,
                    mutation_effect: None,
                    semantic_local_block_ids: None,
                })
            },
            None,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn apply_semantic_mutation(
        &self,
        context: &BoundModuleContext,
        operation_id: String,
        expected_store_epoch: StoreEpoch,
        document_id: String,
        generation: i64,
        expected_head_seq: i64,
        commands: Vec<DocumentSemanticCommand>,
        prepared_agent: Option<AgentPreparedExecution>,
    ) -> Result<OwnedDocumentApplyOutcome, CoreError> {
        if let Some(execution) = prepared_agent.as_ref() {
            validate_agent_transport_context(context, &execution.authorization.provenance)?;
        }
        let mutation = AgentDocumentSemanticMutation {
            document_id: document_id.clone(),
            generation,
            expected_head_seq,
            commands: commands.clone(),
        };
        let fingerprint = if let Some(execution) = prepared_agent.as_ref() {
            agent_semantic_request_fingerprint(
                &operation_id,
                &expected_store_epoch,
                &execution.authorization,
                &mutation,
            )?
        } else {
            serde_json::to_vec(&(
                "nodex.document.semantic-mutation.v2",
                &context.profile_id,
                &context.library_id,
                &context.project_id,
                &context.adapter,
                expected_store_epoch.clone(),
                &document_id,
                generation,
                &commands,
            ))
            .map_err(|_| invalid("Owned Document semantic request cannot be fingerprinted"))?
        };
        let allocation_seed = operation_id.clone();
        let etag_project_id = prepared_agent
            .as_ref()
            .map(|execution| {
                execution
                    .authorization
                    .provenance
                    .authority
                    .actor_project_id
                    .clone()
            })
            .or_else(|| {
                context
                    .project_id
                    .as_ref()
                    .map(|project_id| project_id.0.clone())
            })
            .ok_or_else(|| unauthorized_core("Semantic mutation requires a bound Project"))?;
        let mutation_context = if prepared_agent.is_some() {
            BoundModuleContext {
                editor_history_owner: None,
                adapter: AdapterKind::Agent,
                ..context.clone()
            }
        } else {
            context.clone()
        };
        let semantic_block_etag_ids = commands
            .iter()
            .filter_map(|command| match command {
                DocumentSemanticCommand::UpdateBlock { block_id, .. }
                | DocumentSemanticCommand::MoveBlock { block_id, .. } => Some(block_id.clone()),
                _ => None,
            })
            .collect();
        let include_local_block_etags = commands
            .iter()
            .any(|command| matches!(command, DocumentSemanticCommand::InsertBlock { .. }));
        self.apply_document_update(
            DocumentUpdateJob {
                context: mutation_context,
                client_session_id: context.connection_id.clone(),
                operation_id: operation_id.clone(),
                expected_store_epoch,
                document_id,
                generation,
                operation_kind: "apply_semantic_mutation",
                request_hash: sha256(&fingerprint),
                publication: UpdatePublication::Updated,
                prepared_agent: prepared_agent.map(|authorization| PreparedAgentExecutionJob {
                    authorization,
                    mutation,
                }),
                semantic_block_etag_ids,
                include_local_block_etags,
                recovery: None,
            },
            move |connection, authority, engine, materialization, store_epoch| {
                prepare_semantic_update(
                    connection,
                    authority,
                    engine,
                    materialization,
                    store_epoch,
                    expected_head_seq,
                    &commands,
                    &allocation_seed,
                    &operation_id,
                    &etag_project_id,
                )
                .map(|(prepared, _preview_markdown)| prepared)
            },
            None,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn apply_operation_batch(
        &self,
        context: &BoundModuleContext,
        operation_id: String,
        expected_store_epoch: StoreEpoch,
        document_id: String,
        generation: i64,
        expected_head_seq: i64,
        contract_operations: Vec<ContractDocumentBlockOperation>,
        actor: Value,
    ) -> Result<OwnedDocumentApplyOutcome, CoreError> {
        validate_document_actor(&actor)?;
        let fingerprint = serde_json::to_vec(&(
            "nodex.document.operation-batch.v1",
            &context.profile_id,
            &context.library_id,
            &context.project_id,
            &expected_store_epoch,
            &document_id,
            generation,
            expected_head_seq,
            &contract_operations,
        ))
        .map_err(|_| invalid("Document operation batch cannot be fingerprinted"))?;
        let operations = contract_document_operations(contract_operations)?;
        let update_id = format!("document-mutation:{operation_id}");
        self.apply_document_update(
            DocumentUpdateJob {
                context: context.clone(),
                client_session_id: context.connection_id.clone(),
                operation_id,
                expected_store_epoch,
                document_id,
                generation,
                operation_kind: "apply_operation_batch",
                request_hash: sha256(&fingerprint),
                publication: UpdatePublication::Updated,
                prepared_agent: None,
                semantic_block_etag_ids: Vec::new(),
                include_local_block_etags: false,
                recovery: None,
            },
            move |connection, authority, engine, materialization, _store_epoch| {
                assert_document_head(authority, generation, expected_head_seq)?;
                assert_generic_document_operations_preserve_typed_owners(
                    &operations,
                    materialization,
                )?;
                let schema = registered_yjs_schema(authority)?;
                let prepared = match prepare_document_operation_update(
                    &authority.head.id,
                    schema,
                    &engine.full_state_v1(),
                    &engine.state_vector_v1(),
                    &operations,
                    false,
                ) {
                    Ok(prepared) => prepared,
                    Err(error) if error.code() == DocumentOperationErrorCode::NoChange => {
                        return Ok(PreparedUpdate::NoChange);
                    }
                    Err(error) => return Err(document_operation_store_error(error)),
                };
                let exact_moved_block_ids = operations
                    .iter()
                    .filter_map(|operation| match operation {
                        EngineDocumentBlockOperation::MoveBlock { block_id, .. } => {
                            Some(block_id.clone())
                        }
                        _ => None,
                    })
                    .collect::<Vec<_>>();
                let mutation_effect = document_mutation_effect(
                    &authority.owner_block_id,
                    authority.head.head_seq,
                    materialization,
                    &prepared.materialization,
                    DocumentMutationEffectPolicy {
                        write_fence_block_ids: &prepared.write_fence_block_ids,
                        title_write_fence_required: prepared.title_write_fence_required,
                        force_write_fence: false,
                        exact_moved_block_ids: Some(&exact_moved_block_ids),
                    },
                );
                assert_fresh_document_block_ids(
                    connection,
                    authority,
                    &mutation_effect.created_block_ids,
                )?;
                Ok(PreparedUpdate::Apply {
                    file_restore: None,
                    base_head_seq: authority.head.head_seq,
                    update_id,
                    touched_block_ids: mutation_effect.touched_block_ids.clone(),
                    update: prepared.update_v1,
                    write_fence_block_ids: prepared.write_fence_block_ids,
                    placement_attribution: PreparedPlacementAttribution::Exact(
                        exact_moved_block_ids,
                    ),
                    title_write_fence_required: prepared.title_write_fence_required,
                    document_write_fence_required: false,
                    mutation_effect: Some(Box::new(mutation_effect)),
                    semantic_local_block_ids: None,
                })
            },
            Some(DocumentCommitCheckpoint {
                actor,
                cause: "document_operation_batch",
                label: None,
                revision_kind: "operation",
            }),
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn replace_from_nfm(
        &self,
        context: &BoundModuleContext,
        operation_id: String,
        expected_store_epoch: StoreEpoch,
        document_id: String,
        generation: i64,
        expected_head_seq: i64,
        nfm: String,
        contract_rich_title: Option<Vec<Value>>,
        actor: Value,
    ) -> Result<OwnedDocumentApplyOutcome, CoreError> {
        validate_document_actor(&actor)?;
        let fingerprint = serde_json::to_vec(&(
            "nodex.document.replace-from-nfm.v1",
            &context.profile_id,
            &context.library_id,
            &context.project_id,
            &expected_store_epoch,
            &document_id,
            generation,
            expected_head_seq,
            &nfm,
            &contract_rich_title,
        ))
        .map_err(|_| invalid("Document NFM replacement cannot be fingerprinted"))?;
        let rich_title = contract_rich_title.map(contract_rich_text).transpose()?;
        let allocation_seed = operation_id.clone();
        let update_id = format!("document-mutation:{operation_id}");
        self.apply_document_update(
            DocumentUpdateJob {
                context: context.clone(),
                client_session_id: context.connection_id.clone(),
                operation_id,
                expected_store_epoch,
                document_id,
                generation,
                operation_kind: "replace_from_nfm",
                request_hash: sha256(&fingerprint),
                publication: UpdatePublication::Updated,
                prepared_agent: None,
                semantic_block_etag_ids: Vec::new(),
                include_local_block_etags: false,
                recovery: None,
            },
            move |connection, authority, engine, materialization, _store_epoch| {
                assert_document_head(authority, generation, expected_head_seq)?;
                let schema = registered_yjs_schema(authority)?;
                let mut allocation_index = 0_u64;
                let prepared = match prepare_nfm_replacement_update(
                    &authority.head.id,
                    schema,
                    &engine.full_state_v1(),
                    &engine.state_vector_v1(),
                    &nfm,
                    rich_title.as_deref(),
                    &mut || {
                        allocation_index += 1;
                        allocate_document_block_id(&allocation_seed, allocation_index)
                    },
                ) {
                    Ok(prepared) => prepared,
                    Err(error) if error.code() == DocumentOperationErrorCode::NoChange => {
                        return Ok(PreparedUpdate::NoChange);
                    }
                    Err(error) => return Err(document_operation_store_error(error)),
                };
                let mutation_effect = document_mutation_effect(
                    &authority.owner_block_id,
                    authority.head.head_seq,
                    materialization,
                    &prepared.materialization,
                    DocumentMutationEffectPolicy {
                        write_fence_block_ids: &prepared.write_fence_block_ids,
                        title_write_fence_required: prepared.title_write_fence_required,
                        force_write_fence: true,
                        exact_moved_block_ids: None,
                    },
                );
                assert_document_mutation_effect_preserves_typed_owners(
                    materialization,
                    &prepared.materialization,
                    &mutation_effect,
                )?;
                assert_fresh_document_block_ids(
                    connection,
                    authority,
                    &mutation_effect.created_block_ids,
                )?;
                Ok(PreparedUpdate::Apply {
                    file_restore: None,
                    base_head_seq: authority.head.head_seq,
                    update_id,
                    touched_block_ids: mutation_effect.touched_block_ids.clone(),
                    update: prepared.update_v1,
                    write_fence_block_ids: prepared.write_fence_block_ids,
                    placement_attribution: PreparedPlacementAttribution::Collaborative,
                    title_write_fence_required: prepared.title_write_fence_required,
                    document_write_fence_required: true,
                    mutation_effect: Some(Box::new(mutation_effect)),
                    semantic_local_block_ids: None,
                })
            },
            Some(DocumentCommitCheckpoint {
                actor,
                cause: "replace_document_from_nfm",
                label: None,
                revision_kind: "operation",
            }),
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn create_checkpoint(
        &self,
        context: &BoundModuleContext,
        operation_id: String,
        expected_store_epoch: StoreEpoch,
        document_id: String,
        generation: i64,
        expected_head_seq: i64,
        cause: String,
        label: Option<String>,
        actor: Value,
        revision_kind: Option<DocumentRevisionKind>,
        source_mutation_id: Option<String>,
        source_change_seq: Option<i64>,
    ) -> Result<OwnedDocumentApplyOutcome, CoreError> {
        let fingerprint = serde_json::to_vec(&(
            &context.profile_id,
            &context.library_id,
            &context.project_id,
            expected_store_epoch.clone(),
            &document_id,
            generation,
            expected_head_seq,
            &cause,
            &label,
            &actor,
            revision_kind,
            &source_mutation_id,
            source_change_seq,
        ))
        .map_err(|_| invalid("Document checkpoint request cannot be fingerprinted"))?;
        let request_hash = sha256(&fingerprint);
        let context = context.clone();
        let cache = Arc::clone(&self.cache);
        self.writer
            .call(move |connection| {
                let transaction =
                    connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
                let store_epoch = read_store_epoch(&transaction)?;
                if store_epoch != expected_store_epoch.0 {
                    return Err(StoreError::new(
                        StoreErrorCode::StaleStoreEpoch,
                        "Document checkpoint targets a stale store epoch",
                        true,
                    ));
                }
                if let Some(stored) = read_module_receipt(&transaction, MODULE_NAME, &operation_id)?
                {
                    if stored.request_hash != request_hash {
                        return Err(StoreError::new(
                            StoreErrorCode::IdempotencyKeyReused,
                            "operation_id is already bound to another Owned Document intent",
                            false,
                        ));
                    }
                    let mut committed = serde_json::from_value::<
                        crate::ModuleWriterResult<OwnedDocumentCommitValue, OwnedDocumentReceipt>,
                    >(stored.result)
                    .map_err(|_| corrupt_receipt())?;
                    committed.receipt.mutation.duplicate = true;
                    transaction.commit()?;
                    return Ok(OwnedDocumentApplyOutcome {
                        committed,
                        events: Vec::new(),
                    });
                }
                let authority = read_document_authority(&transaction, &document_id)?
                    .ok_or_else(|| not_found("Owned Document was not found"))?;
                assert_document_head(&authority, generation, expected_head_seq)?;
                let now = sqlite_now(&transaction)?;
                let revision_kind = revision_kind
                    .map(document_revision_kind_name)
                    .unwrap_or("manual");
                let checkpoint = NewDocumentCheckpoint {
                    operation_id: &operation_id,
                    cause: &cause,
                    label: label.as_deref(),
                    revision_kind,
                    source_mutation_id: source_mutation_id.as_deref(),
                    source_change_seq,
                    actor: Some(&actor),
                    context: &context,
                    now: &now,
                };
                let (yjs_engine, inserted_checkpoint) = match authority.head.sync_engine {
                    DocumentSyncEngine::Yjs => {
                        authorize_yjs(
                            &transaction,
                            &context,
                            &authority,
                            DocumentAccessKind::Write,
                        )?;
                        let engine = cache
                            .lock()
                            .map_err(|_| internal("Document cache lock failed"))?
                            .clone_engine(&transaction, &authority.head)?;
                        let schema = registered_yjs_schema(&authority)?;
                        let materialization = materialize_engine(&engine, schema)?;
                        let inserted = insert_document_checkpoint(
                            &transaction,
                            &authority,
                            &materialization,
                            checkpoint,
                        )?;
                        (Some(engine), inserted)
                    }
                    DocumentSyncEngine::CanvasScene => {
                        authorize_canvas(
                            &transaction,
                            &context,
                            &authority,
                            DocumentAccessKind::Write,
                        )?;
                        let loaded = load_canvas_scene(&transaction, &authority)?;
                        let inserted = insert_canvas_checkpoint(
                            &transaction,
                            &authority,
                            &loaded.scene,
                            checkpoint,
                        )?;
                        (None, inserted)
                    }
                };
                let commit_head = read_event_head(&transaction)?;
                let mut committed = committed_value(
                    &operation_id,
                    &store_epoch,
                    &authority,
                    authority.head.head_seq,
                    DocumentCommitOutcome::Committed,
                    commit_head,
                );
                committed.commit_seq = read_local_commit_head(&transaction)?;
                committed.value.checkpoint_effect = Some(DocumentCheckpointEffect {
                    checkpoint: inserted_checkpoint.version.summary,
                    duplicate: inserted_checkpoint.duplicate,
                });
                insert_typed_receipt(
                    &transaction,
                    &context,
                    &operation_id,
                    &request_hash,
                    &store_epoch,
                    "create_checkpoint",
                    &mut committed,
                    None,
                )?;
                transaction.commit()?;
                if let Some(engine) = yjs_engine {
                    cache
                        .lock()
                        .map_err(|_| internal("Document cache lock failed"))?
                        .install(&authority.head, engine);
                }
                Ok(OwnedDocumentApplyOutcome {
                    committed,
                    events: Vec::new(),
                })
            })
            .map_err(core_error)
    }

    #[allow(clippy::too_many_arguments)]
    fn restore_version(
        &self,
        context: &BoundModuleContext,
        operation_id: String,
        expected_store_epoch: StoreEpoch,
        document_id: String,
        version_id: String,
        generation: i64,
        expected_head_seq: i64,
        actor: Value,
    ) -> Result<OwnedDocumentApplyOutcome, CoreError> {
        validate_document_actor(&actor)?;
        let sync_engine = self
            .readers
            .read_default(|connection| {
                read_document_authority(connection, &document_id)?
                    .map(|authority| authority.head.sync_engine)
                    .ok_or_else(|| not_found("Owned Document was not found"))
            })
            .map_err(core_error)?;
        match sync_engine {
            DocumentSyncEngine::Yjs => self.restore_yjs_version(
                context,
                operation_id,
                expected_store_epoch,
                document_id,
                version_id,
                generation,
                expected_head_seq,
                actor,
            ),
            DocumentSyncEngine::CanvasScene => self.restore_canvas_version(
                context,
                operation_id,
                expected_store_epoch,
                document_id,
                version_id,
                generation,
                expected_head_seq,
                actor,
            ),
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn restore_yjs_version(
        &self,
        context: &BoundModuleContext,
        operation_id: String,
        expected_store_epoch: StoreEpoch,
        document_id: String,
        version_id: String,
        generation: i64,
        expected_head_seq: i64,
        actor: Value,
    ) -> Result<OwnedDocumentApplyOutcome, CoreError> {
        let fingerprint = serde_json::to_vec(&(
            &context.profile_id,
            &context.library_id,
            &context.project_id,
            expected_store_epoch.clone(),
            &document_id,
            &version_id,
            generation,
            expected_head_seq,
        ))
        .map_err(|_| invalid("Document restore request cannot be fingerprinted"))?;
        let checkpoint_operation_id = operation_id.clone();
        let checkpoint_context = context.clone();
        let before_restore_actor = restore_checkpoint_actor(&actor, &operation_id, &version_id)?;
        let after_restore_checkpoint = DocumentCommitCheckpoint {
            actor,
            cause: "after_restore",
            label: Some(format!("Restored {version_id}")),
            revision_kind: "restore",
        };
        self.apply_document_update(
            DocumentUpdateJob {
                context: context.clone(),
                client_session_id: context.connection_id.clone(),
                operation_id: operation_id.clone(),
                expected_store_epoch,
                document_id,
                generation,
                operation_kind: "restore_version",
                request_hash: sha256(&fingerprint),
                publication: UpdatePublication::Invalidated(DocumentInvalidationReason::Restored),
                prepared_agent: None,
                semantic_block_etag_ids: Vec::new(),
                include_local_block_etags: false,
                recovery: None,
            },
            move |connection, authority, engine, materialization, _store_epoch| {
                assert_document_head(authority, generation, expected_head_seq)?;
                let Some((prepared, file_restore)) = prepare_version_restore(
                    connection,
                    authority,
                    engine,
                    &version_id,
                    &operation_id,
                )?
                else {
                    return Ok(PreparedUpdate::NoChange);
                };
                let mutation_effect = document_mutation_effect(
                    &authority.owner_block_id,
                    authority.head.head_seq,
                    materialization,
                    &prepared.materialization,
                    DocumentMutationEffectPolicy {
                        write_fence_block_ids: &prepared.write_fence_block_ids,
                        title_write_fence_required: prepared.title_write_fence_required,
                        force_write_fence: true,
                        exact_moved_block_ids: None,
                    },
                );
                let now = sqlite_now(connection)?;
                let safety_label = format!("Before restore {version_id}");
                insert_document_checkpoint(
                    connection,
                    authority,
                    materialization,
                    NewDocumentCheckpoint {
                        operation_id: &checkpoint_operation_id,
                        cause: "before_restore",
                        label: Some(&safety_label),
                        revision_kind: "restore",
                        source_mutation_id: Some(&checkpoint_operation_id),
                        source_change_seq: None,
                        actor: Some(&before_restore_actor),
                        context: &checkpoint_context,
                        now: &now,
                    },
                )?;
                Ok(PreparedUpdate::Apply {
                    file_restore: Some(file_restore),
                    base_head_seq: authority.head.head_seq,
                    update_id: operation_id,
                    touched_block_ids: Vec::new(),
                    update: prepared.update_v1,
                    write_fence_block_ids: prepared.write_fence_block_ids,
                    placement_attribution: PreparedPlacementAttribution::Collaborative,
                    title_write_fence_required: prepared.title_write_fence_required,
                    document_write_fence_required: true,
                    mutation_effect: Some(Box::new(mutation_effect)),
                    semantic_local_block_ids: None,
                })
            },
            Some(after_restore_checkpoint),
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn restore_canvas_version(
        &self,
        context: &BoundModuleContext,
        operation_id: String,
        expected_store_epoch: StoreEpoch,
        document_id: String,
        version_id: String,
        generation: i64,
        expected_head_seq: i64,
        actor: Value,
    ) -> Result<OwnedDocumentApplyOutcome, CoreError> {
        let fingerprint = serde_json::to_vec(&(
            &context.profile_id,
            &context.library_id,
            &context.project_id,
            expected_store_epoch.clone(),
            &document_id,
            &version_id,
            generation,
            expected_head_seq,
        ))
        .map_err(|_| invalid("Canvas restore request cannot be fingerprinted"))?;
        let request_hash = sha256(&fingerprint);
        let context = context.clone();
        let before_restore_actor = restore_checkpoint_actor(&actor, &operation_id, &version_id)?;
        let fail_after_commit = Arc::clone(&self.fail_after_commit);
        let assets_root = self.assets_root.clone();
        self.writer
            .call(move |connection| {
                let transaction =
                    connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
                let store_epoch = read_store_epoch(&transaction)?;
                if store_epoch != expected_store_epoch.0 {
                    return Err(StoreError::new(
                        StoreErrorCode::StaleStoreEpoch,
                        "Canvas restore targets a stale store epoch",
                        true,
                    ));
                }
                if let Some(stored) = read_module_receipt(&transaction, MODULE_NAME, &operation_id)?
                {
                    if stored.request_hash != request_hash {
                        return Err(StoreError::new(
                            StoreErrorCode::IdempotencyKeyReused,
                            "operation_id is already bound to another Owned Document intent",
                            false,
                        ));
                    }
                    let mut committed = serde_json::from_value::<
                        crate::ModuleWriterResult<OwnedDocumentCommitValue, OwnedDocumentReceipt>,
                    >(stored.result)
                    .map_err(|_| corrupt_receipt())?;
                    committed.receipt.mutation.duplicate = true;
                    if let Some(canvas) = committed.value.canvas.as_mut()
                        && let Some(object) = canvas.as_object_mut()
                    {
                        object.insert("duplicate".to_owned(), Value::Bool(true));
                    }
                    transaction.commit()?;
                    return Ok(OwnedDocumentApplyOutcome {
                        committed,
                        events: Vec::new(),
                    });
                }
                let authority = read_document_authority(&transaction, &document_id)?
                    .ok_or_else(|| not_found("Canvas Document was not found"))?;
                authorize_canvas(
                    &transaction,
                    &context,
                    &authority,
                    DocumentAccessKind::Write,
                )?;
                assert_document_head(&authority, generation, expected_head_seq)?;
                let actor_project_id = context
                    .project_id
                    .as_ref()
                    .map(|project| Ok(project.0.clone()))
                    .unwrap_or_else(|| {
                        crate::library::resolve_library_actor_project_id(
                            &transaction,
                            &context.library_id.0,
                        )
                    })?;
                let loaded = load_canvas_scene(&transaction, &authority)?;
                let target = super::canvas_files::validated_revision_scene(
                    &transaction,
                    &context,
                    &document_id,
                    &version_id,
                )?;
                let (target, file_plans) = super::canvas_files::plan_restore(
                    &transaction,
                    &context.library_id.0,
                    &operation_id,
                    &target,
                )?;
                let Some(mutation) = prepare_canvas_restore(&loaded.scene, &target, &operation_id)?
                else {
                    let commit_head = read_event_head(&transaction)?;
                    let mut committed = committed_value(
                        &operation_id,
                        &store_epoch,
                        &authority,
                        authority.head.head_seq,
                        DocumentCommitOutcome::NoChange,
                        commit_head,
                    );
                    committed.commit_seq = read_local_commit_head(&transaction)?;
                    insert_typed_receipt(
                        &transaction,
                        &context,
                        &operation_id,
                        &request_hash,
                        &store_epoch,
                        "restore_version",
                        &mut committed,
                        None,
                    )?;
                    transaction.commit()?;
                    return Ok(OwnedDocumentApplyOutcome {
                        committed,
                        events: Vec::new(),
                    });
                };
                let now = sqlite_now(&transaction)?;
                let mut delivered_events = Vec::new();
                let result = durable_mutation::run(
                    &transaction,
                    OperationIdentity {
                        module: ModuleName::OwnedDocument,
                        module_name: MODULE_NAME,
                        operation_id: &operation_id,
                        intent_hash: &request_hash,
                        store_epoch: &store_epoch,
                        committed_at: &now,
                        context: &context,
                    },
                    |scope| {
                        let restored_files =
                            super::canvas_files::apply_restore(scope, &context, &file_plans)?;
                        if let Some(event) =
                            crate::library::publish_file_restore(scope, &context, &restored_files)?
                        {
                            delivered_events.push(event);
                        }
                        let safety_label = format!("Before restore {version_id}");
                        insert_canvas_checkpoint(
                            &transaction,
                            &authority,
                            &loaded.scene,
                            NewDocumentCheckpoint {
                                operation_id: &operation_id,
                                cause: "before_restore",
                                label: Some(&safety_label),
                                revision_kind: "restore",
                                source_mutation_id: Some(&operation_id),
                                source_change_seq: None,
                                actor: Some(&before_restore_actor),
                                context: &context,
                                now: &now,
                            },
                        )?;
                        let applied = apply_canvas_candidate(&loaded.scene, &mutation)?;
                        let persisted = persist_canvas_mutation(
                            &transaction,
                            Some(scope.evidence()),
                            &authority,
                            &actor_project_id,
                            &document_access_context(&context),
                            &store_epoch,
                            &operation_id,
                            authority.head.head_seq,
                            &request_hash,
                            &mutation,
                            &applied,
                            &assets_root,
                            "document_restored",
                        )?;
                        let mut restored_authority = authority.clone();
                        restored_authority.head.head_seq = persisted.head_seq;
                        restored_authority.head.state_hash = persisted.scene_hash.clone();
                        insert_canvas_checkpoint(
                            &transaction,
                            &restored_authority,
                            &applied.scene,
                            NewDocumentCheckpoint {
                                operation_id: &operation_id,
                                cause: "after_restore",
                                label: Some(&format!("Restored {version_id}")),
                                revision_kind: "restore",
                                source_mutation_id: Some(&operation_id),
                                source_change_seq: Some(persisted.event_sequence),
                                actor: Some(&actor),
                                context: &context,
                                now: &persisted.committed_at,
                            },
                        )?;
                        transaction.execute(
                            "DELETE FROM document_revision_sessions WHERE document_id = ?1",
                            [&authority.head.id],
                        )?;
                        let mut committed = committed_canvas_value(
                            &operation_id,
                            &store_epoch,
                            &authority,
                            persisted.head_seq,
                            DocumentCommitOutcome::Committed,
                            persisted.event_sequence,
                            persisted.result,
                        );
                        committed.value.committed_at = Some(persisted.committed_at.clone());
                        committed.value.mutation_effect = Some(DocumentMutationEffect {
                            base_head_seq: authority.head.head_seq,
                            touched_block_ids: vec![authority.owner_block_id.clone()],
                            created_block_ids: Vec::new(),
                            deleted_block_ids: Vec::new(),
                            updated_block_ids: vec![authority.owner_block_id.clone()],
                            moved_block_ids: Vec::new(),
                            write_fence_block_ids: vec![authority.owner_block_id.clone()],
                            title_changed: false,
                            coordination: DocumentMutationCoordination::WriteFence,
                        });
                        delivered_events.push(load_committed_event_by_sequence(
                            &transaction,
                            persisted.event_sequence,
                        )?);
                        seal_typed_receipt(
                            scope,
                            "restore_version",
                            committed,
                            Some(persisted.event_sequence),
                        )
                    },
                )?;
                let committed = resolve_typed_commit(result);
                transaction.commit()?;
                if fail_after_commit.swap(false, Ordering::AcqRel) {
                    return Err(StoreError::new(
                        StoreErrorCode::Internal,
                        "Injected failure after durable Canvas restore",
                        true,
                    ));
                }
                Ok(OwnedDocumentApplyOutcome {
                    committed,
                    events: delivered_events,
                })
            })
            .map_err(core_error)
    }

    fn apply_document_update<F>(
        &self,
        job: DocumentUpdateJob,
        prepare: F,
        commit_checkpoint: Option<DocumentCommitCheckpoint>,
    ) -> Result<OwnedDocumentApplyOutcome, CoreError>
    where
        F: FnOnce(
                &rusqlite::Connection,
                &DocumentAuthorityRow,
                &super::YrsDocumentEngine,
                &DocumentMaterialization,
                &str,
            ) -> Result<PreparedUpdate, StoreError>
            + Send
            + 'static,
    {
        let cache = Arc::clone(&self.cache);
        let fail_after_commit = Arc::clone(&self.fail_after_commit);
        let prepared_agent_operations = self.prepared_agent_operations.clone();
        self.writer
            .call(move |connection| {
                let transaction =
                    connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
                let store_epoch = read_store_epoch(&transaction)?;
                if store_epoch != job.expected_store_epoch.0 {
                    return Err(StoreError::new(
                        StoreErrorCode::StaleStoreEpoch,
                        "Owned Document mutation targets a stale store epoch",
                        true,
                    ));
                }
                if let Some(stored) =
                    read_module_receipt(&transaction, MODULE_NAME, &job.operation_id)?
                {
                    if stored.request_hash != job.request_hash {
                        return Err(StoreError::new(
                            StoreErrorCode::IdempotencyKeyReused,
                            "operation_id is already bound to another Owned Document intent",
                            false,
                        ));
                    }
                    let mut committed = serde_json::from_value::<
                        crate::ModuleWriterResult<OwnedDocumentCommitValue, OwnedDocumentReceipt>,
                    >(stored.result)
                    .map_err(|_| {
                        StoreError::new(
                            StoreErrorCode::StoreCorrupt,
                            "Stored Owned Document receipt result is invalid",
                            false,
                        )
                    })?;
                    committed.receipt.mutation.duplicate = true;
                    transaction.commit()?;
                    return Ok(OwnedDocumentApplyOutcome {
                        committed,
                        events: Vec::new(),
                    });
                }
                let authority = read_document_authority(&transaction, &job.document_id)?
                    .ok_or_else(|| not_found("Owned Document was not found"))?;
                let agent_authority_fingerprint = if let Some(prepared_agent) =
                    job.prepared_agent.as_ref()
                {
                    Some(authorize_agent_page_document(
                        &transaction,
                        &job.context,
                        &prepared_agent.authorization.authorization,
                        &authority,
                        AgentProjectResourceAction::Write,
                    )?)
                } else {
                    authorize_yjs(
                        &transaction,
                        &job.context,
                        &authority,
                        DocumentAccessKind::Write,
                    )?;
                    None
                };
                let actor_project_id = job
                    .context
                    .project_id
                    .as_ref()
                    .map(|project_id| project_id.0.clone())
                    .map_or_else(
                        || {
                            crate::library::resolve_library_actor_project_id(
                                &transaction,
                                &authority.head.library_id,
                            )
                        },
                        Ok,
                    )?;
                let actor_context = if job.context.project_id.is_some() {
                    job.context.clone()
                } else {
                    BoundModuleContext {
                        editor_history_owner: None,
                        project_id: Some(ProjectId(actor_project_id.clone())),
                        ..job.context.clone()
                    }
                };
                if authority.head.generation != job.generation {
                    return Err(StoreError::new(
                        StoreErrorCode::GenerationConflict,
                        "Owned Document generation does not match",
                        false,
                    ));
                }
                let mut engine = cache
                    .lock()
                    .map_err(|_| internal("Document cache lock failed"))?
                    .clone_engine(&transaction, &authority.head)?;
                let schema = BlockDocumentSchema::from_identity(
                    &authority.head.schema_key,
                    authority.head.schema_version,
                )
                .ok_or_else(|| {
                    StoreError::new(
                        StoreErrorCode::UnsupportedSchema,
                        "Owned Document schema is unsupported",
                        false,
                    )
                })?;
                let base_materialization = materialize_engine(&engine, schema)?;
                let prepared = prepare(
                    &transaction,
                    &authority,
                    &engine,
                    &base_materialization,
                    &store_epoch,
                )?;
                let (mut prepared_agent_lease, semantic_deleted_owner_block_ids) =
                    if let Some(prepared_agent) = job.prepared_agent.as_ref() {
                    let mutation_effect = match &prepared {
                        PreparedUpdate::Apply {
                            mutation_effect, ..
                        } => mutation_effect.as_deref(),
                        PreparedUpdate::NoChange | PreparedUpdate::Recovery { .. } => None,
                    };
                    let footprint = agent_semantic_footprint(
                        &authority.owner_block_id,
                        &prepared_agent.mutation.commands,
                        &base_materialization,
                        mutation_effect,
                    )?;
                    assert_agent_owner_deletion_forbidden(&footprint)?;
                    let authority_revisions_hash = agent_authority_revisions_hash(
                        &transaction,
                        agent_authority_fingerprint
                            .as_deref()
                            .expect("Agent authority was revalidated"),
                        &store_epoch,
                        &authority,
                        &footprint,
                    )?;
                    let binding = PreparedAgentOperationBinding {
                        connection_id: job.context.connection_id.clone(),
                        operation_id: job.operation_id.clone(),
                        request_hash: job.request_hash.clone(),
                        authority_revisions_hash,
                        footprint_hash: hash_serializable(
                            &footprint,
                            "Agent operation footprint cannot be fingerprinted",
                        )?,
                        effect_class: footprint.effect_class,
                    };
                    let token = prepared_agent
                        .authorization
                        .token
                        .as_deref()
                        .ok_or_else(stale_agent_operation)?;
                    let deleted_owner_block_ids = (!footprint.deleted_owner_roots.is_empty())
                        .then_some(footprint.deleted_owner_roots.clone());
                    (
                        Some(prepared_agent_operations.acquire(token, &binding)?),
                        deleted_owner_block_ids,
                    )
                } else {
                    (None, None)
                };
                if let PreparedUpdate::Recovery { artifact_id } = &prepared {
                    let artifact_id = artifact_id.clone();
                    transaction.commit()?;
                    return Err(StoreError::new(
                        StoreErrorCode::RevisionConflict,
                        "This edit conflicts with a structural change. A recovery copy is available.",
                        false,
                    ).with_recovery(CoreErrorRecovery::DocumentRecoveryArtifact {
                        artifact_id,
                        document_id: authority.head.id.clone(),
                        store_epoch: StoreEpoch(store_epoch.clone()),
                        generation: authority.head.generation,
                        update_id: job.operation_id.clone(),
                    }));
                }
                let PreparedUpdate::Apply {
                    file_restore,
                    base_head_seq,
                    update_id,
                    touched_block_ids,
                    update,
                    write_fence_block_ids,
                    placement_attribution,
                    title_write_fence_required,
                    document_write_fence_required,
                    mutation_effect,
                    semantic_local_block_ids,
                } = prepared
                else {
                    let commit_head = read_event_head(&transaction)?;
                    let mut committed = committed_value(
                        &job.operation_id,
                        &store_epoch,
                        &authority,
                        authority.head.head_seq,
                        DocumentCommitOutcome::NoChange,
                        commit_head,
                    );
                    committed.commit_seq = read_local_commit_head(&transaction)?;
                    committed.value.semantic_deleted_owner_block_ids =
                        semantic_deleted_owner_block_ids.clone();
                    attach_semantic_etags(
                        &transaction,
                        &job,
                        &store_epoch,
                        &authority,
                        &base_materialization,
                        &mut committed,
                    )?;
                    recovery_drafts::finish_or_record_noop(&transaction, &job, &mut committed)?;
                    transaction.commit()?;
                    consume_prepared_agent_lease(&mut prepared_agent_lease)?;
                    cache
                        .lock()
                        .map_err(|_| internal("Document cache lock failed"))?
                        .install(&authority.head, engine);
                    return Ok(OwnedDocumentApplyOutcome {
                        committed,
                        events: Vec::new(),
                    });
                };
                validate_touched_block_ids_store(&touched_block_ids)?;
                let candidate = engine.prepare_update_v1(&update).map_err(engine_error)?;
                let materialization = materialize_candidate(&candidate, schema)?;
                let did_change = candidate.did_change();
                let commit_head = read_event_head(&transaction)?;
                if !did_change {
                    let mut committed = committed_value(
                        &job.operation_id,
                        &store_epoch,
                        &authority,
                        authority.head.head_seq,
                        DocumentCommitOutcome::NoChange,
                        commit_head,
                    );
                    committed.commit_seq = read_local_commit_head(&transaction)?;
                    committed.value.semantic_deleted_owner_block_ids =
                        semantic_deleted_owner_block_ids.clone();
                    attach_semantic_etags(
                        &transaction,
                        &job,
                        &store_epoch,
                        &authority,
                        &base_materialization,
                        &mut committed,
                    )?;
                    recovery_drafts::finish_or_record_noop(&transaction, &job, &mut committed)?;
                    transaction.commit()?;
                    consume_prepared_agent_lease(&mut prepared_agent_lease)?;
                    cache
                        .lock()
                        .map_err(|_| internal("Document cache lock failed"))?
                        .install(&authority.head, engine);
                    return Ok(OwnedDocumentApplyOutcome {
                        committed,
                        events: Vec::new(),
                    });
                }
                let candidate_transaction = candidate.document().transact();
                let state_vector = candidate_transaction.state_vector().encode_v1();
                drop(candidate_transaction);
                let revision_now = sqlite_now(&transaction)?;
                let mut committed_delivery = None;
                let mut file_events = Vec::new();
                let authorized_file_ids = file_restore.as_ref().map(|plan| plan.authorized_file_ids()).unwrap_or_default();
                let result = durable_mutation::run(
                    &transaction,
                    OperationIdentity {
                        module: ModuleName::OwnedDocument,
                        module_name: MODULE_NAME,
                        operation_id: &job.operation_id,
                        intent_hash: &job.request_hash,
                        store_epoch: &store_epoch,
                        committed_at: &revision_now,
                        context: &actor_context,
                    },
                    |scope| {
                        prepare_document_revision(
                            &transaction,
                            &authority,
                            &base_materialization,
                            &actor_context,
                            &revision_now,
                        )?;
                        if let Some(plan) = &file_restore {
                            let restored = crate::library::apply_file_restore(scope, &job.context, plan)?;
                            file_events.extend(crate::library::publish_file_restore(scope, &job.context, &restored)?);
                        }
                        let persisted = persist_yjs_commit_with_local_commit(
                            &transaction,
                            PersistYjsCommit {
                                authority: &authority,
                                actor_project_id: &actor_project_id,
                                base_materialization: &base_materialization,
                                materialization: &materialization,
                                update_id: &update_id,
                                client_session_id: &job.client_session_id,
                                base_head_seq,
                                client_touched_block_ids: &touched_block_ids,
                                update: &update,
                                state_vector: &state_vector,
                                store_epoch: &store_epoch,
                                operation_id: &job.operation_id,
                                local_commit_id: None,
                                event_kind: match job.publication {
                                    UpdatePublication::Updated => "document_updated",
                                    UpdatePublication::Invalidated(
                                        DocumentInvalidationReason::Restored,
                                    ) => "document_restored",
                                    UpdatePublication::Invalidated(_) => "document_invalidated",
                                },
                                write_fence_block_ids: &write_fence_block_ids,
                                title_write_fence_required,
                                document_write_fence_required,
                                placement: (match &placement_attribution {
                                    PreparedPlacementAttribution::Collaborative => {
                                        DocumentPlacementEvidence::COLLABORATIVE
                                    }
                                    PreparedPlacementAttribution::Exact(block_ids) => {
                                        DocumentPlacementEvidence::STRUCTURAL
                                            .with_exact_moves(block_ids)
                                    }
                                }).with_authorized_file_ids(&authorized_file_ids),
                            },
                            scope.evidence(),
                        )?;
                        if commit_checkpoint.is_some() {
                            let mut committed_authority = authority.clone();
                            committed_authority.head.head_seq = persisted.head_seq;
                            committed_authority.head.state_vector = persisted.state_vector.clone();
                            insert_document_checkpoint(
                                &transaction,
                                &committed_authority,
                                &materialization,
                                NewDocumentCheckpoint {
                                    operation_id: &job.operation_id,
                                    cause: commit_checkpoint
                                        .as_ref()
                                        .map(|checkpoint| checkpoint.cause)
                                        .unwrap_or("operation"),
                                    label: commit_checkpoint
                                        .as_ref()
                                        .and_then(|checkpoint| checkpoint.label.as_deref()),
                                    revision_kind: commit_checkpoint
                                        .as_ref()
                                        .map(|checkpoint| checkpoint.revision_kind)
                                        .unwrap_or("operation"),
                                    source_mutation_id: Some(&job.operation_id),
                                    source_change_seq: Some(persisted.event_sequence),
                                    actor: commit_checkpoint
                                        .as_ref()
                                        .map(|checkpoint| &checkpoint.actor),
                                    context: &actor_context,
                                    now: &persisted.committed_at,
                                },
                            )?;
                            transaction.execute(
                                "DELETE FROM document_revision_sessions WHERE document_id = ?1",
                                [&authority.head.id],
                            )?;
                        } else {
                            record_document_revision_edit(
                                &transaction,
                                &authority.head.id,
                                authority.head.generation,
                                persisted.head_seq,
                                &job.client_session_id,
                                &persisted.committed_at,
                            )?;
                        }
                        let mut committed = committed_value(
                            &job.operation_id,
                            &store_epoch,
                            &authority,
                            persisted.head_seq,
                            DocumentCommitOutcome::Committed,
                            persisted.event_sequence,
                        );
                        committed.value.committed_at = Some(persisted.committed_at.clone());
                        committed.value.mutation_effect = mutation_effect.map(|effect| *effect);
                        committed.value.semantic_local_block_ids = semantic_local_block_ids.clone();
                        committed.value.semantic_deleted_owner_block_ids =
                            semantic_deleted_owner_block_ids.clone();
                        attach_semantic_etags(
                            &transaction,
                            &job,
                            &store_epoch,
                            &authority,
                            &materialization,
                            &mut committed,
                        )?;
                        let event = load_committed_event_by_sequence(
                            &transaction,
                            persisted.event_sequence,
                        )?;
                        record_page_document_projection_delta(
                            scope,
                            &authority,
                            &event.projection_impact,
                        )?;
                        committed_delivery = Some((
                            event,
                            persisted.head_seq,
                            persisted.state_vector,
                        ));
                        recovery_drafts::finish(scope, &job, &mut committed)?;
                        seal_typed_receipt(
                            scope,
                            job.operation_kind,
                            committed,
                            Some(persisted.event_sequence),
                        )
                    },
                )?;
                let committed = resolve_typed_commit(result);
                let (event, next_head_seq, next_state_vector) = committed_delivery
                    .ok_or_else(|| internal("Document update omitted its delivery result"))?;
                transaction.commit()?;
                consume_prepared_agent_lease(&mut prepared_agent_lease)?;
                if fail_after_commit.swap(false, Ordering::AcqRel) {
                    cache
                        .lock()
                        .map_err(|_| internal("Document cache lock failed"))?
                        .invalidate(&job.document_id);
                    return Err(StoreError::new(
                        StoreErrorCode::Internal,
                        "Injected failure after durable Document commit",
                        true,
                    ));
                }
                engine.commit_candidate(candidate).map_err(engine_error)?;
                let mut next_head = authority.head.clone();
                next_head.head_seq = next_head_seq;
                next_head.state_vector = next_state_vector;
                cache
                    .lock()
                    .map_err(|_| internal("Document cache lock failed"))?
                    .install(&next_head, engine);
                Ok(OwnedDocumentApplyOutcome {
                    committed,
                    events: { file_events.push(event); file_events },
                })
            })
            .map_err(core_error)
    }

    fn validate_context(&self, context: &BoundModuleContext) -> Result<(), CoreError> {
        if context.profile_id.0 == self.profile_id && context.library_id.0 == self.library_id {
            return Ok(());
        }
        Err(CoreError {
            code: CoreErrorCode::Unauthorized,
            message: "Owned Document context targets another Profile or Library".to_owned(),
            retryable: false,
            recovery: CoreErrorRecovery::None,
        })
    }
}

fn materialize_engine(
    engine: &super::YrsDocumentEngine,
    schema: BlockDocumentSchema,
) -> Result<DocumentMaterialization, StoreError> {
    let decoded = decode_block_document(engine.document(), schema)
        .map_err(|error| invalid_store(format!("Owned Document schema is invalid: {error}")))?;
    materialize_decoded_document(&decoded)
        .map_err(|error| invalid_store(format!("Owned Document is invalid: {error}")))
}

fn materialize_candidate(
    candidate: &super::YrsUpdateCandidate,
    schema: BlockDocumentSchema,
) -> Result<DocumentMaterialization, StoreError> {
    let decoded = decode_block_document(candidate.document(), schema)
        .map_err(|error| invalid_store(format!("Yjs update violates the schema: {error}")))?;
    materialize_decoded_document(&decoded)
        .map_err(|error| invalid_store(format!("Yjs update cannot materialize: {error}")))
}

fn derive_update_touched_block_ids(
    owner_block_id: &str,
    engine: &super::YrsDocumentEngine,
    before: &DocumentMaterialization,
    schema: BlockDocumentSchema,
    update: &[u8],
) -> Option<BTreeSet<String>> {
    let candidate = engine.prepare_update_v1(update).ok()?;
    let after = materialize_candidate(&candidate, schema).ok()?;
    let placement_delta = derive_document_placement_delta(before, &after);
    Some(
        derive_touched_block_ids(owner_block_id, before, &after, &placement_delta)
            .into_iter()
            .collect(),
    )
}

#[derive(Clone, Copy)]
struct SemanticBlockCoordinate<'a> {
    block: &'a MaterializedBlockNode,
}

fn flatten_semantic_coordinates<'a>(
    blocks: &'a [MaterializedBlockNode],
    coordinates: &mut Vec<SemanticBlockCoordinate<'a>>,
) {
    for block in blocks {
        coordinates.push(SemanticBlockCoordinate { block });
        flatten_semantic_coordinates(&block.children, coordinates);
    }
}

struct DocumentMutationEffectPolicy<'a> {
    write_fence_block_ids: &'a [String],
    title_write_fence_required: bool,
    force_write_fence: bool,
    exact_moved_block_ids: Option<&'a [String]>,
}

fn document_mutation_effect(
    owner_block_id: &str,
    base_head_seq: i64,
    before: &DocumentMaterialization,
    after: &DocumentMaterialization,
    policy: DocumentMutationEffectPolicy<'_>,
) -> DocumentMutationEffect {
    let mut before_coordinates = Vec::new();
    flatten_semantic_coordinates(&before.block_tree, &mut before_coordinates);
    let mut after_coordinates = Vec::new();
    flatten_semantic_coordinates(&after.block_tree, &mut after_coordinates);
    let before_ids = before_coordinates
        .iter()
        .map(|coordinate| coordinate.block.id.clone())
        .collect::<Vec<_>>();
    let after_ids = after_coordinates
        .iter()
        .map(|coordinate| coordinate.block.id.clone())
        .collect::<Vec<_>>();
    let before_id_set = before_ids.iter().cloned().collect::<HashSet<_>>();
    let after_id_set = after_ids.iter().cloned().collect::<HashSet<_>>();
    let title_changed = before.rich_title != after.rich_title;
    let created_block_ids = after_ids
        .iter()
        .filter(|block_id| !before_id_set.contains(*block_id))
        .cloned()
        .collect::<Vec<_>>();
    let deleted_block_ids = before_ids
        .iter()
        .filter(|block_id| !after_id_set.contains(*block_id))
        .cloned()
        .collect::<Vec<_>>();
    let node_delta = derive_document_node_delta(before, after);
    let updated_block_ids = before_ids
        .iter()
        .filter(|block_id| after_id_set.contains(*block_id) && node_delta.contains(*block_id))
        .cloned()
        .collect::<Vec<_>>();
    let placement_delta = derive_document_placement_delta(before, after);
    let exact_moved_block_ids = policy
        .exact_moved_block_ids
        .map(|block_ids| block_ids.iter().map(String::as_str).collect::<HashSet<_>>());
    let moved_block_ids = before_ids
        .iter()
        .filter(|block_id| {
            let changed = placement_delta.parent_changed_block_ids.contains(*block_id)
                || placement_delta.reordered_block_ids.contains(*block_id);
            changed
                && exact_moved_block_ids
                    .as_ref()
                    .is_none_or(|exact| exact.contains(block_id.as_str()))
        })
        .cloned()
        .collect::<Vec<_>>();
    let known_block_ids = before_id_set
        .union(&after_id_set)
        .map(String::as_str)
        .collect::<HashSet<_>>();
    let mut durable_write_fences = policy
        .write_fence_block_ids
        .iter()
        .filter(|block_id| known_block_ids.contains(block_id.as_str()))
        .cloned()
        .collect::<BTreeSet<_>>();
    if policy.title_write_fence_required {
        durable_write_fences.insert(owner_block_id.to_owned());
    }
    let mut touched_block_ids = created_block_ids
        .iter()
        .chain(deleted_block_ids.iter())
        .chain(updated_block_ids.iter())
        .chain(moved_block_ids.iter())
        .cloned()
        .collect::<BTreeSet<_>>();
    if title_changed {
        touched_block_ids.insert(owner_block_id.to_owned());
    }
    let coordination = if policy.force_write_fence || !durable_write_fences.is_empty() {
        DocumentMutationCoordination::WriteFence
    } else {
        DocumentMutationCoordination::MergeFriendly
    };
    DocumentMutationEffect {
        base_head_seq,
        touched_block_ids: touched_block_ids.into_iter().collect(),
        created_block_ids,
        deleted_block_ids,
        updated_block_ids,
        moved_block_ids,
        write_fence_block_ids: durable_write_fences.into_iter().collect(),
        title_changed,
        coordination,
    }
}

fn contract_document_operations(
    operations: Vec<ContractDocumentBlockOperation>,
) -> Result<Vec<EngineDocumentBlockOperation>, CoreError> {
    operations
        .into_iter()
        .map(|operation| match operation {
            ContractDocumentBlockOperation::SetTitle { title } => {
                Ok(EngineDocumentBlockOperation::SetTitle { title })
            }
            ContractDocumentBlockOperation::SetRichTitle { rich_title } => {
                Ok(EngineDocumentBlockOperation::SetRichTitle {
                    rich_title: contract_rich_text(rich_title)?,
                })
            }
            ContractDocumentBlockOperation::InsertBlock {
                block,
                parent_block_id,
                before_block_id,
            } => Ok(EngineDocumentBlockOperation::InsertBlock {
                block: serde_json::from_value(block)
                    .map_err(|_| invalid("Inserted Document Block is invalid"))?,
                parent_block_id,
                before_block_id,
            }),
            ContractDocumentBlockOperation::UpdateBlock { block_id, patch } => {
                Ok(EngineDocumentBlockOperation::UpdateBlock {
                    block_id,
                    patch: EngineDocumentBlockUpdatePatch {
                        block_type: patch.block_type,
                        props: patch.props,
                        content: match patch.content {
                            DocumentOptionalValue::Absent => None,
                            DocumentOptionalValue::Value { value } => Some(value),
                        },
                        unset_content: patch.unset_content,
                    },
                })
            }
            ContractDocumentBlockOperation::DeleteBlock { block_id } => {
                Ok(EngineDocumentBlockOperation::DeleteBlock { block_id })
            }
            ContractDocumentBlockOperation::MoveBlock {
                block_id,
                parent_block_id,
                before_block_id,
            } => Ok(EngineDocumentBlockOperation::MoveBlock {
                block_id,
                parent_block_id,
                before_block_id,
            }),
        })
        .collect()
}

fn contract_rich_text(values: Vec<Value>) -> Result<Vec<RichTextItem>, CoreError> {
    serde_json::from_value(Value::Array(values))
        .map_err(|_| invalid("Document rich title is invalid"))
}

fn assert_fresh_document_block_ids(
    connection: &rusqlite::Connection,
    authority: &DocumentAuthorityRow,
    block_ids: &[String],
) -> Result<(), StoreError> {
    for block_id in block_ids {
        let existing = connection
            .query_row(
                "SELECT source FROM (\
                   SELECT 'active_or_tombstoned' AS source FROM blocks WHERE id = ?1 \
                   UNION ALL \
                   SELECT 'retired' AS source FROM retired_block_identities WHERE block_id = ?1\
                 ) LIMIT 1",
                [block_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        if let Some(source) = existing {
            return Err(invalid_store(format!(
                "Duplicate Block identity {block_id} already exists as {source} in Project {}",
                authority.head.library_id
            )));
        }
    }
    Ok(())
}

fn document_operation_store_error(error: DocumentOperationError) -> StoreError {
    let code = match error.code() {
        DocumentOperationErrorCode::StaleStateVector => StoreErrorCode::HeadConflict,
        _ => StoreErrorCode::InvalidInput,
    };
    StoreError::new(code, error.to_string(), false)
}

fn validate_document_actor(actor: &Value) -> Result<(), CoreError> {
    let encoded = serde_json::to_vec(actor)
        .map_err(|_| invalid("Document mutation actor must be portable JSON"))?;
    if actor.is_object() && encoded.len() <= 64 * 1024 {
        return Ok(());
    }
    Err(invalid(
        "Document mutation actor must be a bounded portable object",
    ))
}

fn restore_checkpoint_actor(
    actor: &Value,
    mutation_id: &str,
    source_version_id: &str,
) -> Result<Value, CoreError> {
    validate_document_actor(actor)?;
    let mut enriched = actor.as_object().expect("validated restore actor").clone();
    enriched.insert(
        "restoreMutationId".to_owned(),
        Value::String(mutation_id.to_owned()),
    );
    enriched.insert(
        "sourceVersionId".to_owned(),
        Value::String(source_version_id.to_owned()),
    );
    let enriched = Value::Object(enriched);
    validate_document_actor(&enriched)?;
    Ok(enriched)
}

fn committed_value(
    operation_id: &str,
    store_epoch: &str,
    authority: &DocumentAuthorityRow,
    head_seq: i64,
    outcome: DocumentCommitOutcome,
    event_sequence: i64,
) -> crate::ModuleWriterResult<OwnedDocumentCommitValue, OwnedDocumentReceipt> {
    crate::ModuleWriterResult {
        value: OwnedDocumentCommitValue {
            recovery: None,
            document_id: authority.head.id.clone(),
            generation: authority.head.generation,
            head_seq,
            outcome,
            committed_at: None,
            canvas: None,
            owner_effect: None,
            checkpoint_effect: None,
            mutation_effect: None,
            semantic_etags: None,
            semantic_block_etags: None,
            semantic_local_block_ids: None,
            semantic_deleted_owner_block_ids: None,
        },
        receipt: OwnedDocumentReceipt {
            mutation: ModuleMutationReceipt {
                operation_id: operation_id.to_owned(),
                duplicate: false,
            },
            document_id: authority.head.id.clone(),
            generation: authority.head.generation,
            head_seq,
        },
        commit_seq: 0,
        event_sequence,
        store_epoch: StoreEpoch(store_epoch.to_owned()),
    }
}

fn attach_semantic_etags(
    connection: &Connection,
    job: &DocumentUpdateJob,
    store_epoch: &str,
    authority: &DocumentAuthorityRow,
    materialization: &DocumentMaterialization,
    committed: &mut crate::ModuleWriterResult<OwnedDocumentCommitValue, OwnedDocumentReceipt>,
) -> Result<(), StoreError> {
    let project_id = match job.prepared_agent.as_ref() {
        Some(prepared_agent) => prepared_agent
            .authorization
            .authorization
            .provenance
            .authority
            .actor_project_id
            .as_str(),
        None if job.context.adapter == AdapterKind::NativeCli
            && job.operation_kind == "apply_semantic_mutation" =>
        {
            bound_actor_project_id(&job.context)?
        }
        None => return Ok(()),
    };
    let (title, body) = mint_document_semantic_etags(
        connection,
        project_id,
        store_epoch,
        &authority.head.id,
        materialization,
    )
    .map_err(semantic_error)?;
    committed.value.semantic_etags = Some(DocumentSemanticEtags { title, body });
    let mut block_ids = job
        .semantic_block_etag_ids
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>();
    if job.include_local_block_etags {
        block_ids.extend(
            committed
                .value
                .semantic_local_block_ids
                .as_ref()
                .into_iter()
                .flat_map(|local_ids| local_ids.values().cloned()),
        );
    }
    let block_etags = block_ids
        .into_iter()
        .map(|block_id| {
            let block = find_block(&materialization.block_tree, &block_id).ok_or_else(|| {
                StoreError::new(
                    StoreErrorCode::Internal,
                    format!("Committed semantic Block {block_id} is absent from materialization"),
                    false,
                )
            })?;
            let update = mint_document_block_etag(
                connection,
                project_id,
                store_epoch,
                &authority.head.id,
                block,
            )
            .map_err(semantic_error)?;
            let delete = mint_document_subtree_etag(
                connection,
                project_id,
                store_epoch,
                &authority.head.id,
                block,
            )
            .map_err(semantic_error)?;
            Ok((block_id, DocumentSemanticBlockEtags { update, delete }))
        })
        .collect::<Result<BTreeMap<_, _>, StoreError>>()?;
    committed.value.semantic_block_etags = (!block_etags.is_empty()).then_some(block_etags);
    Ok(())
}

fn owner_command_kind(command: &DocumentOwnerCommand) -> &'static str {
    match command {
        DocumentOwnerCommand::CreateSyncedSource { .. } => "create_synced_source",
        DocumentOwnerCommand::PromoteSyncedSource { .. } => "promote_synced_source",
        DocumentOwnerCommand::DemoteSyncedSource { .. } => "demote_synced_source",
        DocumentOwnerCommand::CreateTemplate { .. } => "create_template",
        DocumentOwnerCommand::InstantiateTemplate { .. } => "instantiate_template",
        DocumentOwnerCommand::DeleteOwnedSource { .. } => "delete_owned_source",
    }
}

fn document_revision_kind_name(kind: DocumentRevisionKind) -> &'static str {
    match kind {
        DocumentRevisionKind::Automatic => "automatic",
        DocumentRevisionKind::Manual => "manual",
        DocumentRevisionKind::Operation => "operation",
        DocumentRevisionKind::Restore => "restore",
        DocumentRevisionKind::Safety => "safety",
    }
}

fn semantic_owner_command(command: &DocumentOwnerCommand) -> DocumentOwnerCommand {
    let mut command = command.clone();
    match &mut command {
        DocumentOwnerCommand::PromoteSyncedSource { host, .. } => {
            host.head_seq = 0;
        }
        DocumentOwnerCommand::DemoteSyncedSource { host, source, .. } => {
            host.head_seq = 0;
            source.head_seq = 0;
        }
        DocumentOwnerCommand::InstantiateTemplate { source, target, .. } => {
            source.head_seq = 0;
            target.head_seq = 0;
        }
        DocumentOwnerCommand::DeleteOwnedSource { owner, .. } => {
            owner.head_seq = 0;
        }
        DocumentOwnerCommand::CreateSyncedSource { .. }
        | DocumentOwnerCommand::CreateTemplate { .. } => {}
    }
    command
}

#[allow(clippy::too_many_arguments)]
fn committed_canvas_value(
    operation_id: &str,
    store_epoch: &str,
    authority: &DocumentAuthorityRow,
    head_seq: i64,
    outcome: DocumentCommitOutcome,
    event_sequence: i64,
    canvas: Value,
) -> crate::ModuleWriterResult<OwnedDocumentCommitValue, OwnedDocumentReceipt> {
    let mut committed = committed_value(
        operation_id,
        store_epoch,
        authority,
        head_seq,
        outcome,
        event_sequence,
    );
    committed.value.canvas = Some(canvas);
    committed
}

type OwnedDocumentWriterResult =
    crate::ModuleWriterResult<OwnedDocumentCommitValue, OwnedDocumentReceipt>;

fn record_page_document_projection_delta(
    scope: &DurableMutationScope<'_>,
    authority: &DocumentAuthorityRow,
    impact: &ProjectionImpact,
) -> Result<(), StoreError> {
    let Some(library_id) = authority.page_library_id.as_deref() else {
        return Ok(());
    };
    crate::database::record_page_document_projection_delta(
        scope.connection(),
        scope.evidence(),
        library_id,
        impact,
    )
}

fn seal_typed_receipt(
    scope: &DurableMutationScope<'_>,
    operation_kind: &str,
    mut committed: OwnedDocumentWriterResult,
    event_sequence: Option<i64>,
) -> Result<SealedOutcome<OwnedDocumentWriterResult>, StoreError> {
    committed.commit_seq = scope.commit_seq();
    Ok(scope.seal(
        committed,
        ReceiptMetadata {
            operation_kind,
            event_sequence,
            committed_at: scope.committed_at(),
        },
    ))
}

fn resolve_typed_commit(
    result: CommitResult<OwnedDocumentWriterResult>,
) -> OwnedDocumentWriterResult {
    match result {
        CommitResult::Committed { outcome, .. } | CommitResult::NoOp { outcome } => outcome,
        CommitResult::IdempotentReplay { mut outcome, .. } => {
            outcome.receipt.mutation.duplicate = true;
            outcome
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn insert_typed_receipt(
    connection: &rusqlite::Connection,
    context: &BoundModuleContext,
    operation_id: &str,
    request_hash: &str,
    store_epoch: &str,
    operation_kind: &str,
    committed: &mut crate::ModuleWriterResult<OwnedDocumentCommitValue, OwnedDocumentReceipt>,
    event_sequence: Option<i64>,
) -> Result<(), StoreError> {
    committed.commit_seq = read_local_commit_head(connection)?;
    let committed_at = sqlite_now(connection)?;
    let receipt = ReceiptMetadata {
        operation_kind,
        event_sequence,
        committed_at: &committed_at,
    };
    durable_mutation::record_no_op(
        connection,
        OperationIdentity {
            module: ModuleName::OwnedDocument,
            module_name: MODULE_NAME,
            operation_id,
            intent_hash: request_hash,
            store_epoch,
            context,
            committed_at: &committed_at,
        },
        &*committed,
        receipt,
    )
}

fn document_access_context(context: &BoundModuleContext) -> OwnedDocumentAccessContext {
    match context.project_id.as_ref() {
        Some(project_id) => OwnedDocumentAccessContext::Project {
            project_id: project_id.0.clone(),
        },
        None => OwnedDocumentAccessContext::Library,
    }
}

fn authority_descriptor(
    context: &BoundModuleContext,
    authority: &DocumentAuthorityRow,
    store_epoch: &str,
) -> Result<OwnedDocumentDescriptor, StoreError> {
    let readiness = match authority.head.readiness {
        DocumentReadiness::PendingGenesis => OwnedDocumentReadiness::PendingGenesis,
        DocumentReadiness::Ready => OwnedDocumentReadiness::Ready,
        DocumentReadiness::Failed => OwnedDocumentReadiness::Failed,
    };
    let sync = match authority.head.sync_engine {
        DocumentSyncEngine::Yjs => OwnedDocumentSyncDescriptor::Yjs {
            state_vector: authority.head.state_vector.clone(),
        },
        DocumentSyncEngine::CanvasScene => OwnedDocumentSyncDescriptor::CanvasScene,
    };
    let owner_lifecycle = match authority.owner_lifecycle.as_str() {
        "active" => OwnedDocumentOwnerLifecycle::Active,
        "archived" => OwnedDocumentOwnerLifecycle::Archived,
        "deleted" => OwnedDocumentOwnerLifecycle::Deleted,
        _ => {
            return Err(StoreError::new(
                StoreErrorCode::StoreCorrupt,
                "Owned Document owner lifecycle is invalid",
                false,
            ));
        }
    };
    Ok(OwnedDocumentDescriptor {
        version: OWNED_DOCUMENT_DESCRIPTOR_VERSION,
        library_id: authority.head.library_id.clone(),
        access_context: document_access_context(context),
        owner_block_id: authority.owner_block_id.clone(),
        owner_type: authority.owner_type.clone(),
        owner_lifecycle,
        document_id: authority.head.id.clone(),
        store_epoch: store_epoch.to_owned(),
        generation: authority.head.generation,
        head_seq: authority.head.head_seq,
        schema_key: authority.head.schema_key.clone(),
        schema_version: authority.head.schema_version,
        readiness,
        sync,
    })
}

fn issue_descriptor_read_stamp(
    connection: &Connection,
    context: &BoundModuleContext,
    authority: &DocumentAuthorityRow,
    store_epoch: &str,
    commit_head: i64,
) -> Result<nodex_core_contracts::events::AuthorizedReadStamp, StoreError> {
    let document = ResourceKey::Document {
        document_id: authority.head.id.clone(),
    };
    let subject = match authority.owner_type.as_str() {
        "page" => ResourceKey::Page {
            page_id: authority.owner_block_id.clone(),
        },
        "database" => ResourceKey::Database {
            database_id: authority.owner_block_id.clone(),
        },
        "canvas" => ResourceKey::Canvas {
            canvas_id: authority.owner_block_id.clone(),
        },
        _ => document.clone(),
    };
    resource_authorization::issue_read_stamp(
        connection,
        context,
        StoreEpoch(store_epoch.to_owned()),
        commit_head,
        subject.clone(),
        vec![subject.clone()],
        vec![subject, document],
    )
}

#[allow(clippy::too_many_arguments)]
fn prepare_semantic_update(
    connection: &rusqlite::Connection,
    authority: &DocumentAuthorityRow,
    engine: &super::YrsDocumentEngine,
    materialization: &DocumentMaterialization,
    store_epoch: &str,
    expected_head_seq: i64,
    commands: &[DocumentSemanticCommand],
    allocation_seed: &str,
    update_id: &str,
    etag_project_id: &str,
) -> Result<(PreparedUpdate, Option<String>), StoreError> {
    let footprint =
        agent_semantic_footprint(&authority.owner_block_id, commands, materialization, None)?;
    assert_agent_owner_deletion_forbidden(&footprint)?;
    let requires_structural_barrier = commands.iter().any(|command| {
        matches!(
            command,
            DocumentSemanticCommand::DeleteBlock { .. } | DocumentSemanticCommand::MoveBlock { .. }
        )
    });
    if expected_head_seq > authority.head.head_seq
        || (requires_structural_barrier && expected_head_seq != authority.head.head_seq)
    {
        return Err(StoreError::new(
            StoreErrorCode::HeadConflict,
            "Semantic mutation crossed its required Document head barrier",
            true,
        ));
    }
    let schema = BlockDocumentSchema::from_identity(
        &authority.head.schema_key,
        authority.head.schema_version,
    )
    .ok_or_else(|| {
        StoreError::new(
            StoreErrorCode::UnsupportedSchema,
            "Owned Document schema is unsupported",
            false,
        )
    })?;
    let full_state = engine.full_state_v1();
    let state_vector = engine.state_vector_v1();
    let mut allocation_index = 0_u64;
    let prepared = prepare_semantic_mutation(
        connection,
        SemanticMutationContext {
            document_id: &authority.head.id,
            project_id: etag_project_id,
            store_epoch,
            schema,
            full_state_v1: &full_state,
            state_vector_v1: &state_vector,
            materialization,
        },
        commands,
        &mut || {
            allocation_index += 1;
            allocate_document_block_id(allocation_seed, allocation_index)
        },
    );
    match prepared {
        Ok(prepared) => {
            let preview_markdown = prepared.materialization.nfm.clone();
            let semantic_local_block_ids =
                (!prepared.local_block_ids.is_empty()).then_some(prepared.local_block_ids.clone());
            let exact_moved_block_ids = commands
                .iter()
                .filter_map(|command| match command {
                    DocumentSemanticCommand::MoveBlock { block_id, .. } => Some(block_id.clone()),
                    _ => None,
                })
                .collect::<Vec<_>>();
            let mutation_effect = document_mutation_effect(
                &authority.owner_block_id,
                authority.head.head_seq,
                materialization,
                &prepared.materialization,
                DocumentMutationEffectPolicy {
                    write_fence_block_ids: &prepared.write_fence_block_ids,
                    title_write_fence_required: prepared.title_write_fence_required,
                    force_write_fence: false,
                    exact_moved_block_ids: Some(&exact_moved_block_ids),
                },
            );
            if commands.iter().any(|command| {
                matches!(
                    command,
                    DocumentSemanticCommand::PatchBody { .. }
                        | DocumentSemanticCommand::ReplaceBody { .. }
                )
            }) {
                assert_document_mutation_effect_preserves_typed_owners(
                    materialization,
                    &prepared.materialization,
                    &mutation_effect,
                )?;
            }
            assert_fresh_document_block_ids(
                connection,
                authority,
                &mutation_effect.created_block_ids,
            )?;
            Ok((
                PreparedUpdate::Apply {
                    file_restore: None,
                    base_head_seq: authority.head.head_seq,
                    update_id: update_id.to_owned(),
                    touched_block_ids: mutation_effect.touched_block_ids.clone(),
                    update: prepared.update_v1,
                    write_fence_block_ids: prepared.write_fence_block_ids,
                    placement_attribution: PreparedPlacementAttribution::Exact(
                        exact_moved_block_ids,
                    ),
                    title_write_fence_required: prepared.title_write_fence_required,
                    document_write_fence_required: false,
                    mutation_effect: Some(Box::new(mutation_effect)),
                    semantic_local_block_ids,
                },
                Some(preview_markdown),
            ))
        }
        Err(SemanticMutationError::NoChange) => {
            Ok((PreparedUpdate::NoChange, Some(materialization.nfm.clone())))
        }
        Err(error) => Err(semantic_error(error)),
    }
}

fn assert_generic_document_operations_preserve_typed_owners(
    operations: &[EngineDocumentBlockOperation],
    materialization: &DocumentMaterialization,
) -> Result<(), StoreError> {
    let block_types = materialization
        .search_units
        .iter()
        .map(|unit| (unit.block_id.clone(), unit.block_type.clone()))
        .collect::<HashMap<_, _>>();
    let is_typed_id = |block_id: &str| {
        block_types
            .get(block_id)
            .is_some_and(|kind| TYPED_CREATION_BLOCK_TYPES.contains(&kind.as_str()))
    };
    let mut children = HashMap::<String, Vec<String>>::new();
    for unit in &materialization.search_units {
        if let Some(parent_block_id) = &unit.parent_block_id {
            children
                .entry(parent_block_id.clone())
                .or_default()
                .push(unit.block_id.clone());
        }
    }
    for operation in operations {
        match operation {
            EngineDocumentBlockOperation::SetTitle { .. }
            | EngineDocumentBlockOperation::SetRichTitle { .. } => {}
            EngineDocumentBlockOperation::InsertBlock {
                block,
                parent_block_id,
                ..
            } => {
                assert_materialized_draft_has_no_typed_owner(block)?;
                if let Some(parent_block_id) = parent_block_id
                    .as_deref()
                    .filter(|parent_block_id| is_typed_id(parent_block_id))
                {
                    return Err(invalid_store(format!(
                        "Typed owner Block {parent_block_id} cannot contain child Blocks"
                    )));
                }
            }
            EngineDocumentBlockOperation::UpdateBlock {
                block_id, patch, ..
            } => {
                if is_typed_id(block_id)
                    || patch
                        .block_type
                        .as_deref()
                        .is_some_and(|kind| TYPED_CREATION_BLOCK_TYPES.contains(&kind))
                {
                    return Err(invalid_store(format!(
                        "Typed owner Block {block_id} cannot be edited by a generic Document update"
                    )));
                }
            }
            EngineDocumentBlockOperation::DeleteBlock { block_id } => {
                if document_subtree_contains_typed_owner(block_id, &children, &block_types) {
                    return Err(StoreError::new(
                        StoreErrorCode::ProtectedOwnerDeletion,
                        format!(
                            "Block subtree {block_id} contains a typed owner and cannot be removed by a generic Document update"
                        ),
                        false,
                    ));
                }
            }
            EngineDocumentBlockOperation::MoveBlock {
                block_id,
                parent_block_id,
                ..
            } => {
                if document_subtree_contains_typed_owner(block_id, &children, &block_types) {
                    return Err(invalid_store(format!(
                        "Block subtree {block_id} contains a typed owner and cannot be moved by a generic Document update"
                    )));
                }
                if let Some(parent_block_id) = parent_block_id
                    .as_deref()
                    .filter(|parent_block_id| is_typed_id(parent_block_id))
                {
                    return Err(invalid_store(format!(
                        "Typed owner Block {parent_block_id} cannot contain child Blocks"
                    )));
                }
            }
            EngineDocumentBlockOperation::MergeBlockBackward { .. }
            | EngineDocumentBlockOperation::RestoreBackwardMerge { .. }
            | EngineDocumentBlockOperation::RestoreEditorHistoryForest { .. } => {
                return Err(invalid_store(
                    "Editor history and backward merge operations require the Library structural authority".to_owned(),
                ));
            }
        }
    }
    Ok(())
}

fn document_subtree_contains_typed_owner(
    root_block_id: &str,
    children: &HashMap<String, Vec<String>>,
    block_types: &HashMap<String, String>,
) -> bool {
    let mut pending = VecDeque::from([root_block_id]);
    while let Some(block_id) = pending.pop_front() {
        if block_types
            .get(block_id)
            .is_some_and(|kind| TYPED_CREATION_BLOCK_TYPES.contains(&kind.as_str()))
        {
            return true;
        }
        if let Some(descendants) = children.get(block_id) {
            pending.extend(descendants.iter().map(String::as_str));
        }
    }
    false
}

fn assert_document_mutation_effect_preserves_typed_owners(
    before: &DocumentMaterialization,
    after: &DocumentMaterialization,
    effect: &DocumentMutationEffect,
) -> Result<(), StoreError> {
    let block_types = before
        .search_units
        .iter()
        .map(|unit| (unit.block_id.clone(), unit.block_type.clone()))
        .collect::<HashMap<_, _>>();
    let mut children = HashMap::<String, Vec<String>>::new();
    for unit in &before.search_units {
        if let Some(parent_block_id) = &unit.parent_block_id {
            children
                .entry(parent_block_id.clone())
                .or_default()
                .push(unit.block_id.clone());
        }
    }
    let deleted_owners = effect
        .deleted_block_ids
        .iter()
        .filter(|block_id| {
            block_types
                .get(block_id.as_str())
                .is_some_and(|kind| TYPED_CREATION_BLOCK_TYPES.contains(&kind.as_str()))
        })
        .cloned()
        .collect::<Vec<_>>();
    if !deleted_owners.is_empty() {
        return Err(StoreError::new(
            StoreErrorCode::ProtectedOwnerDeletion,
            format!(
                "Document edit would delete typed owner Block(s): {}",
                deleted_owners.join(", ")
            ),
            false,
        ));
    }
    let placement = derive_document_placement_delta(before, after);
    let moved_owner_subtrees = placement
        .parent_changed_block_ids
        .iter()
        .chain(&placement.reordered_block_ids)
        .filter(|block_id| document_subtree_contains_typed_owner(block_id, &children, &block_types))
        .cloned()
        .collect::<Vec<_>>();
    if moved_owner_subtrees.is_empty() {
        return Ok(());
    }
    Err(invalid_store(format!(
        "Document edit would move typed owner Block subtree(s): {}",
        moved_owner_subtrees.join(", ")
    )))
}

fn assert_materialized_draft_has_no_typed_owner(
    block: &MaterializedBlockNode,
) -> Result<(), StoreError> {
    if TYPED_CREATION_BLOCK_TYPES.contains(&block.block_type.as_str()) {
        return Err(invalid_store(format!(
            "Typed owner Block {} requires a typed creation operation",
            block.id
        )));
    }
    for child in &block.children {
        assert_materialized_draft_has_no_typed_owner(child)?;
    }
    Ok(())
}

fn validate_agent_transport_context(
    context: &BoundModuleContext,
    provenance: &AgentTurnProvenance,
) -> Result<(), CoreError> {
    let authority = &provenance.authority;
    let valid = matches!(
        context.adapter,
        AdapterKind::ElectronHost | AdapterKind::Test
    ) && context.profile_id.0 == provenance.profile_id
        && context.library_id.0 == authority.library_id
        && context.project_id.as_ref().map(|id| id.0.as_str())
            == Some(authority.actor_project_id.as_str())
        && !context.connection_id.is_empty()
        && context.connection_id.len() <= 512;
    if valid {
        return Ok(());
    }
    Err(CoreError {
        code: CoreErrorCode::Unauthorized,
        message: "Prepared Agent operation is not bound to its trusted Electron context".to_owned(),
        retryable: false,
        recovery: CoreErrorRecovery::None,
    })
}

fn authorize_agent_page_document(
    connection: &rusqlite::Connection,
    context: &BoundModuleContext,
    authorization: &AgentExecutionAuthorization,
    authority: &DocumentAuthorityRow,
    action: AgentProjectResourceAction,
) -> Result<String, StoreError> {
    if authority.owner_type != "page" || authority.owner_lifecycle != "active" {
        return Err(StoreError::new(
            StoreErrorCode::Unauthorized,
            "Prepared Agent semantic mutations require an active Page",
            false,
        ));
    }
    if authority.head.readiness != DocumentReadiness::Ready
        || authority.head.authority != DocumentAuthority::YdocPrimary
        || authority.head.sync_engine != DocumentSyncEngine::Yjs
    {
        return Err(StoreError::new(
            StoreErrorCode::Unauthorized,
            "Prepared Agent target is not live Yjs authority",
            false,
        ));
    }
    let page_library_id = connection
        .query_row(
            "SELECT library_id FROM pages WHERE block_id = ?1",
            [&authority.owner_block_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .ok_or_else(|| {
            StoreError::new(
                StoreErrorCode::StoreCorrupt,
                "Prepared Agent Page authority is missing",
                false,
            )
        })?;
    if page_library_id != authorization.provenance.authority.library_id {
        return Err(StoreError::new(
            StoreErrorCode::Unauthorized,
            "Prepared Agent target is outside its persisted Library authority",
            false,
        ));
    }
    registered_yjs_schema(authority)?;
    crate::library::agent_authorization::authorize_execution(
        connection,
        context,
        &page_library_id,
        authorization,
        &AgentAuthorizationTarget::Page {
            page_id: authority.owner_block_id.clone(),
        },
        action,
    )
}

fn agent_semantic_request_fingerprint(
    operation_id: &str,
    store_epoch: &StoreEpoch,
    authorization: &AgentExecutionAuthorization,
    mutation: &AgentDocumentSemanticMutation,
) -> Result<Vec<u8>, CoreError> {
    if operation_id.is_empty() || operation_id.len() > 512 || operation_id.trim() != operation_id {
        return Err(invalid("Prepared Agent operation_id is invalid"));
    }
    serde_json::to_vec(&(
        "nodex.agent.document.semantic.v2",
        operation_id,
        store_epoch,
        authorization,
        mutation,
    ))
    .map_err(|_| invalid("Prepared Agent semantic request cannot be fingerprinted"))
}

struct AgentBlockCoordinate<'a> {
    block: &'a MaterializedBlockNode,
    parent_block_id: Option<String>,
    sibling_index: u32,
    depth: u32,
}

fn find_agent_block_coordinate<'a>(
    blocks: &'a [MaterializedBlockNode],
    block_id: &str,
    parent_block_id: Option<&str>,
    depth: u32,
) -> Option<AgentBlockCoordinate<'a>> {
    for (sibling_index, block) in blocks.iter().enumerate() {
        if block.id == block_id {
            return Some(AgentBlockCoordinate {
                block,
                parent_block_id: parent_block_id.map(str::to_owned),
                sibling_index: sibling_index as u32,
                depth,
            });
        }
        if let Some(coordinate) = find_agent_block_coordinate(
            &block.children,
            block_id,
            Some(&block.id),
            depth.saturating_add(1),
        ) {
            return Some(coordinate);
        }
    }
    None
}

fn collect_agent_block_coordinates<'a>(
    blocks: &'a [MaterializedBlockNode],
    parent_block_id: Option<&str>,
    first_sibling_index: u32,
    depth: u32,
    max_depth: u32,
    coordinates: &mut Vec<AgentBlockCoordinate<'a>>,
) {
    if depth > max_depth {
        return;
    }
    for (relative_index, block) in blocks.iter().enumerate() {
        coordinates.push(AgentBlockCoordinate {
            block,
            parent_block_id: parent_block_id.map(str::to_owned),
            sibling_index: first_sibling_index.saturating_add(relative_index as u32),
            depth,
        });
        collect_agent_block_coordinates(
            &block.children,
            Some(&block.id),
            0,
            depth.saturating_add(1),
            max_depth,
            coordinates,
        );
    }
}

fn nominal_agent_semantic_footprint(
    owner_page_id: &str,
    commands: &[DocumentSemanticCommand],
    mutation_effect: Option<&DocumentMutationEffect>,
) -> Result<AgentOperationFootprint, StoreError> {
    build_agent_semantic_footprint(owner_page_id, commands, None, mutation_effect)
}

fn agent_semantic_footprint(
    owner_page_id: &str,
    commands: &[DocumentSemanticCommand],
    materialization: &DocumentMaterialization,
    mutation_effect: Option<&DocumentMutationEffect>,
) -> Result<AgentOperationFootprint, StoreError> {
    build_agent_semantic_footprint(
        owner_page_id,
        commands,
        Some(materialization),
        mutation_effect,
    )
}

fn build_agent_semantic_footprint(
    owner_page_id: &str,
    commands: &[DocumentSemanticCommand],
    materialization: Option<&DocumentMaterialization>,
    mutation_effect: Option<&DocumentMutationEffect>,
) -> Result<AgentOperationFootprint, StoreError> {
    let mut created_roots = HashSet::<String>::new();
    let mut updated_roots = HashSet::<String>::new();
    let mut deleted_roots = HashSet::<String>::new();
    let mut ownership_transformations = Vec::new();
    let mut destructive = false;
    let mut children = HashMap::<Option<String>, Vec<String>>::new();
    let mut parents = HashMap::<String, Option<String>>::new();
    let mut block_types = HashMap::<String, String>::new();
    if let Some(materialization) = materialization {
        for unit in &materialization.search_units {
            children
                .entry(unit.parent_block_id.clone())
                .or_default()
                .push(unit.block_id.clone());
            parents.insert(unit.block_id.clone(), unit.parent_block_id.clone());
            block_types.insert(unit.block_id.clone(), unit.block_type.clone());
        }
    }
    for command in commands {
        match command {
            DocumentSemanticCommand::SetTitle { .. }
            | DocumentSemanticCommand::PatchBody { .. } => {
                updated_roots.insert(owner_page_id.to_owned());
            }
            DocumentSemanticCommand::ReplaceBody { .. } => {
                destructive = true;
                updated_roots.insert(owner_page_id.to_owned());
            }
            DocumentSemanticCommand::InsertBody { anchor, .. } => {
                let (parent_block_id, _) = semantic_footprint_anchor(anchor, &parents, &children);
                assert_agent_anchor_outside_typed_owner(parent_block_id.as_deref(), &block_types)?;
                updated_roots.insert(parent_block_id.unwrap_or_else(|| owner_page_id.to_owned()));
            }
            DocumentSemanticCommand::InsertBlock { anchor, block } => {
                assert_agent_draft_has_no_typed_owner(block)?;
                let (parent_block_id, _) = semantic_footprint_anchor(anchor, &parents, &children);
                assert_agent_anchor_outside_typed_owner(parent_block_id.as_deref(), &block_types)?;
                updated_roots.insert(parent_block_id.unwrap_or_else(|| owner_page_id.to_owned()));
            }
            DocumentSemanticCommand::UpdateBlock {
                block_id, patch, ..
            } => {
                if block_types
                    .get(block_id)
                    .is_some_and(|kind| TYPED_CREATION_BLOCK_TYPES.contains(&kind.as_str()))
                    || patch
                        .block_type
                        .as_deref()
                        .is_some_and(|kind| TYPED_CREATION_BLOCK_TYPES.contains(&kind))
                {
                    return Err(invalid_store(format!(
                        "Typed owner Block {block_id} cannot be edited by a generic Document update"
                    )));
                }
                updated_roots.insert(block_id.clone());
            }
            DocumentSemanticCommand::DeleteBlock { block_id, .. } => {
                destructive = true;
                let parent = parents
                    .get(block_id)
                    .and_then(Clone::clone)
                    .unwrap_or_else(|| owner_page_id.to_owned());
                updated_roots.insert(parent);
                let mut pending = VecDeque::from([block_id.clone()]);
                while let Some(candidate) = pending.pop_front() {
                    if !deleted_roots.insert(candidate.clone()) {
                        continue;
                    }
                    if let Some(descendants) = children.get(&Some(candidate)) {
                        pending.extend(descendants.iter().cloned());
                    }
                }
            }
            DocumentSemanticCommand::MoveBlock { block_id, anchor } => {
                let mut pending = VecDeque::from([block_id.clone()]);
                let mut carries_typed_owner = false;
                while let Some(candidate) = pending.pop_front() {
                    if block_types
                        .get(&candidate)
                        .is_some_and(|kind| TYPED_CREATION_BLOCK_TYPES.contains(&kind.as_str()))
                    {
                        carries_typed_owner = true;
                        break;
                    }
                    if let Some(descendants) = children.get(&Some(candidate)) {
                        pending.extend(descendants.iter().cloned());
                    }
                }
                if carries_typed_owner {
                    return Err(invalid_store(format!(
                        "Block subtree {block_id} contains a typed owner and cannot be moved by a generic Document update"
                    )));
                }
                let (parent_block_id, before_block_id) =
                    semantic_footprint_anchor(anchor, &parents, &children);
                assert_agent_anchor_outside_typed_owner(parent_block_id.as_deref(), &block_types)?;
                updated_roots.insert(block_id.clone());
                updated_roots.insert(
                    parent_block_id
                        .clone()
                        .unwrap_or_else(|| owner_page_id.to_owned()),
                );
                if let Some(previous_parent) = parents.get(block_id).and_then(Clone::clone) {
                    updated_roots.insert(previous_parent);
                }
                ownership_transformations.push(AgentOwnershipTransformation {
                    resource_id: block_id.clone(),
                    parent_id: parent_block_id,
                    before_id: before_block_id,
                });
            }
        }
    }
    if let Some(effect) = mutation_effect {
        created_roots.extend(effect.created_block_ids.iter().cloned());
        updated_roots.extend(effect.updated_block_ids.iter().cloned());
        updated_roots.extend(effect.moved_block_ids.iter().cloned());
        deleted_roots.extend(effect.deleted_block_ids.iter().cloned());
        destructive |= !effect.deleted_block_ids.is_empty();
    }
    let mut created_roots = created_roots.into_iter().collect::<Vec<_>>();
    let mut updated_roots = updated_roots.into_iter().collect::<Vec<_>>();
    let mut deleted_roots = deleted_roots.into_iter().collect::<Vec<_>>();
    created_roots.sort();
    updated_roots.sort();
    deleted_roots.sort();
    let deleted_owner_roots = deleted_roots
        .iter()
        .filter(|block_id| {
            block_types
                .get(*block_id)
                .is_some_and(|kind| TYPED_CREATION_BLOCK_TYPES.contains(&kind.as_str()))
        })
        .cloned()
        .collect::<Vec<_>>();
    let footprint_size = created_roots
        .len()
        .checked_add(updated_roots.len())
        .and_then(|size| size.checked_add(deleted_roots.len()))
        .and_then(|size| size.checked_add(deleted_owner_roots.len()))
        .and_then(|size| size.checked_add(ownership_transformations.len()))
        .ok_or_else(|| exhausted_store("Agent operation footprint size overflowed"))?;
    if footprint_size > MAX_AGENT_FOOTPRINT_ROOTS {
        return Err(exhausted_store(
            "Agent operation footprint exceeds its Core bound",
        ));
    }
    Ok(AgentOperationFootprint {
        effect_class: if destructive {
            AgentEffectClass::Destructive
        } else {
            AgentEffectClass::Write
        },
        targets: vec![AgentResourceTarget {
            kind: AgentResourceKind::Page,
            id: owner_page_id.to_owned(),
        }],
        created_roots,
        updated_roots,
        deleted_roots,
        deleted_owner_roots,
        ownership_transformations,
    })
}

fn assert_agent_draft_has_no_typed_owner(
    block: &DocumentSemanticBlockDraft,
) -> Result<(), StoreError> {
    if TYPED_CREATION_BLOCK_TYPES.contains(&block.block_type.as_str()) {
        return Err(invalid_store(format!(
            "Typed owner Block draft {} requires a typed creation operation",
            block.local_id
        )));
    }
    for child in &block.children {
        assert_agent_draft_has_no_typed_owner(child)?;
    }
    Ok(())
}

fn assert_agent_anchor_outside_typed_owner(
    parent_block_id: Option<&str>,
    block_types: &HashMap<String, String>,
) -> Result<(), StoreError> {
    let Some(parent_block_id) = parent_block_id else {
        return Ok(());
    };
    if !block_types
        .get(parent_block_id)
        .is_some_and(|kind| TYPED_CREATION_BLOCK_TYPES.contains(&kind.as_str()))
    {
        return Ok(());
    }
    Err(invalid_store(format!(
        "Typed owner Block {parent_block_id} cannot contain child Blocks"
    )))
}

fn assert_agent_owner_deletion_forbidden(
    footprint: &AgentOperationFootprint,
) -> Result<(), StoreError> {
    if footprint.deleted_owner_roots.is_empty() {
        return Ok(());
    }
    Err(StoreError::new(
        StoreErrorCode::ProtectedOwnerDeletion,
        format!(
            "Document edit would delete typed owner Block(s): {}",
            footprint.deleted_owner_roots.join(", ")
        ),
        false,
    ))
}

fn semantic_footprint_anchor(
    anchor: &DocumentSemanticAnchor,
    parents: &HashMap<String, Option<String>>,
    children: &HashMap<Option<String>, Vec<String>>,
) -> (Option<String>, Option<String>) {
    match anchor {
        DocumentSemanticAnchor::Start { parent_block_id } => (
            parent_block_id.clone(),
            children
                .get(parent_block_id)
                .and_then(|siblings| siblings.first())
                .cloned(),
        ),
        DocumentSemanticAnchor::End { parent_block_id } => (parent_block_id.clone(), None),
        DocumentSemanticAnchor::Before { block_id } => (
            parents.get(block_id).and_then(Clone::clone),
            Some(block_id.clone()),
        ),
        DocumentSemanticAnchor::After { block_id } => {
            let parent_block_id = parents.get(block_id).and_then(Clone::clone);
            let before_block_id = children.get(&parent_block_id).and_then(|siblings| {
                siblings
                    .iter()
                    .position(|sibling| sibling == block_id)
                    .and_then(|index| siblings.get(index + 1))
                    .cloned()
            });
            (parent_block_id, before_block_id)
        }
    }
}

fn agent_authority_revisions_hash(
    connection: &rusqlite::Connection,
    turn_authority_fingerprint: &str,
    store_epoch: &str,
    authority: &DocumentAuthorityRow,
    footprint: &AgentOperationFootprint,
) -> Result<String, StoreError> {
    let page_revision = connection
        .query_row(
            "SELECT page.library_id, page.parent_kind, page.parent_id, \
               block.placement_revision, block.metadata_revision, block.lifecycle \
             FROM pages page JOIN blocks block ON block.id = page.block_id \
               AND block.library_id = page.library_id \
             WHERE page.block_id = ?1",
            [&authority.owner_block_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, String>(5)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| {
            StoreError::new(
                StoreErrorCode::StoreCorrupt,
                "Page authority is missing",
                false,
            )
        })?;
    let mut resource_ids = footprint.updated_roots.clone();
    resource_ids.extend(footprint.deleted_roots.iter().cloned());
    for transformation in &footprint.ownership_transformations {
        resource_ids.push(transformation.resource_id.clone());
        resource_ids.extend(transformation.parent_id.iter().cloned());
        resource_ids.extend(transformation.before_id.iter().cloned());
    }
    resource_ids.push(authority.owner_block_id.clone());
    resource_ids.sort();
    resource_ids.dedup();
    let mut revisions = Vec::with_capacity(resource_ids.len());
    for resource_id in resource_ids {
        let revision = connection
            .query_row(
                "SELECT block.library_id, block.lifecycle, block.placement_revision, \
                   block.metadata_revision, entry.document_id, entry.parent_block_id, \
                   entry.ordinal, placement.rank_key, placement.revision \
                 FROM blocks block \
                 LEFT JOIN document_block_index entry ON entry.block_id = block.id \
                 LEFT JOIN library_block_placements placement ON placement.block_id = block.id \
                   AND placement.library_id = block.library_id \
                 WHERE block.id = ?1",
                [&resource_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, Option<String>>(5)?,
                        row.get::<_, Option<i64>>(6)?,
                        row.get::<_, Option<String>>(7)?,
                        row.get::<_, Option<i64>>(8)?,
                    ))
                },
            )
            .optional()?
            .ok_or_else(|| {
                StoreError::new(
                    StoreErrorCode::RevisionConflict,
                    "Agent operation footprint no longer resolves to current Block authority",
                    true,
                )
            })?;
        revisions.push((resource_id, revision));
    }
    hash_serializable(
        &(
            "nodex.agent.authority-revisions.v2",
            turn_authority_fingerprint,
            store_epoch,
            &authority.head.id,
            authority.head.generation,
            authority.head.head_seq,
            &authority.head.library_id,
            &authority.owner_block_id,
            &authority.owner_lifecycle,
            page_revision,
            revisions,
        ),
        "Agent authority revisions cannot be fingerprinted",
    )
}

fn hash_serializable(value: &impl Serialize, message: &'static str) -> Result<String, StoreError> {
    let bytes = serde_json::to_vec(value)
        .map_err(|_| StoreError::new(StoreErrorCode::Internal, message, false))?;
    Ok(sha256(&bytes))
}

fn stale_agent_operation() -> StoreError {
    StoreError::new(
        StoreErrorCode::RevisionConflict,
        "Prepared Agent operation requires a current single-use token",
        true,
    )
}

fn consume_prepared_agent_lease(
    lease: &mut Option<PreparedAgentOperationLease>,
) -> Result<(), StoreError> {
    let Some(lease) = lease.take() else {
        return Ok(());
    };
    lease.consume()
}

fn exhausted_store(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::ResourceExhausted, message, true)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum DocumentAccessKind {
    Read,
    Write,
}

fn authorize_document_access(
    connection: &Connection,
    context: &BoundModuleContext,
    authority: &DocumentAuthorityRow,
    access: DocumentAccessKind,
) -> Result<(), StoreError> {
    if let Some(project_id) = context.project_id.as_ref() {
        if authority.owner_type == "canvas" {
            let (canvas_library_id, host_page_id) = connection
                .query_row(
                    "SELECT canvas.library_id, host_page.block_id \
                     FROM canvas_owners canvas \
                     JOIN blocks block ON block.id = canvas.block_id \
                       AND block.library_id = canvas.library_id \
                     LEFT JOIN document_block_index containing \
                       ON containing.block_id = block.id \
                     LEFT JOIN pages host_page \
                       ON host_page.document_id = containing.document_id \
                      AND host_page.library_id = block.library_id \
                     WHERE canvas.block_id = ?1",
                    [&authority.owner_block_id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
                )
                .optional()?
                .ok_or_else(|| {
                    StoreError::new(
                        StoreErrorCode::NotFound,
                        "Canvas owner metadata is unavailable",
                        false,
                    )
                })?;
            if canvas_library_id != context.library_id.0 {
                return Err(StoreError::new(
                    StoreErrorCode::Unauthorized,
                    "Canvas is outside the bound Library",
                    false,
                ));
            }
            if let Some(page_id) = host_page_id {
                match access {
                    DocumentAccessKind::Read => crate::library::require_page_read_access(
                        connection,
                        &context.library_id.0,
                        &project_id.0,
                        &page_id,
                    )?,
                    DocumentAccessKind::Write => crate::library::require_page_write_access(
                        connection,
                        &context.library_id.0,
                        &project_id.0,
                        &page_id,
                    )?,
                }
            } else {
                match access {
                    DocumentAccessKind::Read => crate::library::require_canvas_read_access(
                        connection,
                        &context.library_id.0,
                        &project_id.0,
                        &authority.owner_block_id,
                    )?,
                    DocumentAccessKind::Write => crate::library::require_canvas_write_access(
                        connection,
                        &context.library_id.0,
                        &project_id.0,
                        &authority.owner_block_id,
                    )?,
                }
            }
            return Ok(());
        }
        if authority.owner_type == "page" {
            match access {
                DocumentAccessKind::Read => crate::library::require_page_read_access(
                    connection,
                    &context.library_id.0,
                    &project_id.0,
                    &authority.owner_block_id,
                )?,
                DocumentAccessKind::Write => crate::library::require_page_write_access(
                    connection,
                    &context.library_id.0,
                    &project_id.0,
                    &authority.owner_block_id,
                )?,
            }
        } else {
            let project_is_available = connection
                .query_row(
                    "SELECT 1 FROM projects \
                     WHERE id = ?1 AND library_id = ?2 AND lifecycle = 'active'",
                    [&project_id.0, &authority.head.library_id],
                    |_| Ok(()),
                )
                .optional()?
                .is_some();
            if !project_is_available {
                return Err(StoreError::new(
                    StoreErrorCode::Unauthorized,
                    "Owned Document is outside the bound Library",
                    false,
                ));
            }
        }
        if access == DocumentAccessKind::Write
            && authority.owner_type == "page"
            && authority.owner_lifecycle != "active"
        {
            return Err(StoreError::new(
                StoreErrorCode::Unauthorized,
                "Page Document is not writable",
                false,
            ));
        }
        return Ok(());
    }
    authorize_library_document_scope(context)
        .map_err(|error| StoreError::new(StoreErrorCode::Unauthorized, error.message, false))?;
    if authority.owner_type == "canvas" {
        let available = connection
            .query_row(
                "SELECT 1 FROM canvas_owners \
                 WHERE block_id = ?1 AND library_id = ?2",
                [&authority.owner_block_id, &context.library_id.0],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        if available {
            return Ok(());
        }
        return Err(StoreError::new(
            StoreErrorCode::NotFound,
            "Canvas Document does not exist in the local Library",
            false,
        ));
    }
    if authority.owner_type != "page"
        || authority.page_library_id.as_deref() != Some(context.library_id.0.as_str())
        || authority.owner_lifecycle == "deleted"
    {
        return Err(StoreError::new(
            StoreErrorCode::NotFound,
            "Page Document does not exist in the local Library",
            false,
        ));
    }
    if access == DocumentAccessKind::Write && authority.owner_lifecycle != "active" {
        return Err(StoreError::new(
            StoreErrorCode::Unauthorized,
            "Page Document is not writable",
            false,
        ));
    }
    Ok(())
}

fn authorize_library_document_scope(context: &BoundModuleContext) -> Result<(), CoreError> {
    if context.project_id.is_some()
        || matches!(
            context.adapter,
            AdapterKind::ElectronHost | AdapterKind::NativeCli | AdapterKind::Test
        )
    {
        return Ok(());
    }
    Err(unauthorized_core(
        "Library Document scope requires a trusted local Adapter",
    ))
}

fn authorize_yjs(
    connection: &Connection,
    context: &BoundModuleContext,
    authority: &DocumentAuthorityRow,
    access: DocumentAccessKind,
) -> Result<(), StoreError> {
    authorize_document_access(connection, context, authority, access)?;
    if authority.owner_lifecycle == "deleted"
        || authority.head.readiness != DocumentReadiness::Ready
        || authority.head.authority != DocumentAuthority::YdocPrimary
        || authority.head.sync_engine != DocumentSyncEngine::Yjs
    {
        return Err(StoreError::new(
            StoreErrorCode::Unauthorized,
            "Owned Document is not readable live Yjs authority",
            false,
        ));
    }
    registered_yjs_schema(authority)?;
    Ok(())
}

fn authorize_canvas(
    connection: &Connection,
    context: &BoundModuleContext,
    authority: &DocumentAuthorityRow,
    access: DocumentAccessKind,
) -> Result<(), StoreError> {
    authorize_document_access(connection, context, authority, access)?;
    if authority.owner_lifecycle == "deleted" {
        return Err(StoreError::new(
            StoreErrorCode::Unauthorized,
            "Canvas Document owner is deleted",
            false,
        ));
    }
    validate_canvas_authority(authority)
}

fn authorize_owned_document(
    connection: &Connection,
    context: &BoundModuleContext,
    authority: &DocumentAuthorityRow,
    access: DocumentAccessKind,
) -> Result<(), StoreError> {
    match authority.head.sync_engine {
        DocumentSyncEngine::Yjs => authorize_yjs(connection, context, authority, access),
        DocumentSyncEngine::CanvasScene => authorize_canvas(connection, context, authority, access),
    }
}

/// Reuses the canonical post-state read boundary for resource delivery.
///
/// Delivery authorization is intentionally separate from command
/// authorization, but it must resolve the same Page, granted Page, synced
/// owner, and Canvas-shell ownership rules as a canonical Document read.
pub(crate) fn require_owned_document_read_access(
    connection: &Connection,
    context: &BoundModuleContext,
    document_id: &str,
) -> Result<(), StoreError> {
    let authority = read_document_authority(connection, document_id)?.ok_or_else(|| {
        StoreError::new(
            StoreErrorCode::NotFound,
            "Owned Document is unavailable",
            false,
        )
    })?;
    authorize_owned_document(connection, context, &authority, DocumentAccessKind::Read)
}

fn registered_yjs_schema(
    authority: &DocumentAuthorityRow,
) -> Result<BlockDocumentSchema, StoreError> {
    let schema = BlockDocumentSchema::from_identity(
        &authority.head.schema_key,
        authority.head.schema_version,
    )
    .ok_or_else(|| {
        StoreError::new(
            StoreErrorCode::UnsupportedSchema,
            "Owned Document schema is unsupported",
            false,
        )
    })?;
    if super::materialization::schema_metadata(schema).owner_type == authority.owner_type {
        return Ok(schema);
    }
    Err(StoreError::new(
        StoreErrorCode::UnsupportedSchema,
        "Owned Document owner type does not match its registered schema",
        false,
    ))
}

fn validate_touched_block_ids(ids: &[String]) -> Result<(), CoreError> {
    validate_touched_block_ids_store(ids).map_err(core_error)
}

fn validate_touched_block_ids_store(ids: &[String]) -> Result<(), StoreError> {
    if ids.len() > 100_000 {
        return Err(invalid_store(
            "Touched Block ID list exceeds its bound".to_owned(),
        ));
    }
    let mut sorted = ids.to_vec();
    sorted.sort();
    sorted.dedup();
    if sorted.len() == ids.len()
        && ids
            .iter()
            .all(|id| !id.is_empty() && id.len() <= 512 && id.trim() == id)
    {
        return Ok(());
    }
    Err(invalid_store(
        "Touched Block IDs must be unique canonical identities".to_owned(),
    ))
}

fn semantic_error(error: SemanticMutationError) -> StoreError {
    match error {
        SemanticMutationError::Invalid(message) => invalid_store(message),
        SemanticMutationError::RevisionConflict => StoreError::new(
            StoreErrorCode::RevisionConflict,
            "Semantic ETag no longer matches current Document state",
            true,
        ),
        SemanticMutationError::NoChange => {
            invalid_store("Semantic mutation makes no change".to_owned())
        }
        SemanticMutationError::EtagAuthority(message) => StoreError::new(
            StoreErrorCode::StoreCorrupt,
            format!("Semantic ETag authority is unavailable: {message}"),
            false,
        ),
        SemanticMutationError::Operation(error) => {
            let code = match error.code() {
                super::DocumentOperationErrorCode::StaleStateVector => StoreErrorCode::HeadConflict,
                super::DocumentOperationErrorCode::NfmPatchNotFound => {
                    StoreErrorCode::PatchNotFound
                }
                super::DocumentOperationErrorCode::NfmPatchAmbiguous => {
                    StoreErrorCode::PatchAmbiguous
                }
                super::DocumentOperationErrorCode::NfmPatchOverlap => StoreErrorCode::PatchOverlap,
                _ => StoreErrorCode::InvalidInput,
            };
            StoreError::new(code, error.to_string(), false)
        }
    }
}

fn assert_document_head(
    authority: &DocumentAuthorityRow,
    generation: i64,
    expected_head_seq: i64,
) -> Result<(), StoreError> {
    if authority.head.generation != generation {
        return Err(StoreError::new(
            StoreErrorCode::GenerationConflict,
            "Owned Document generation does not match",
            false,
        ));
    }
    if authority.head.head_seq == expected_head_seq {
        return Ok(());
    }
    Err(StoreError::new(
        StoreErrorCode::HeadConflict,
        "Owned Document head does not match the required history barrier",
        true,
    ))
}

fn corrupt_receipt() -> StoreError {
    StoreError::new(
        StoreErrorCode::StoreCorrupt,
        "Stored Owned Document receipt result is invalid",
        false,
    )
}

fn allocate_document_block_id(seed: &str, index: u64) -> String {
    let entropy = sha256(format!("nodex.document.semantic-block.v1:{seed}:{index}").as_bytes());
    format!(
        "{}-{}-7{}-8{}-{}",
        &entropy[..8],
        &entropy[8..12],
        &entropy[12..15],
        &entropy[15..18],
        &entropy[18..30],
    )
}

fn engine_error(error: YrsEngineError) -> StoreError {
    let (code, retryable) = match error {
        YrsEngineError::MissingDependencies => (StoreErrorCode::MissingDependencies, true),
        _ => (StoreErrorCode::InvalidInput, false),
    };
    StoreError::new(code, format!("Yjs update failed: {error}"), retryable)
}

fn core_error(error: StoreError) -> CoreError {
    let code = match error.code {
        StoreErrorCode::InvalidInput => CoreErrorCode::InvalidInput,
        StoreErrorCode::Unauthorized => CoreErrorCode::Unauthorized,
        StoreErrorCode::NotFound => CoreErrorCode::NotFound,
        StoreErrorCode::StaleStoreEpoch => CoreErrorCode::StaleStoreEpoch,
        StoreErrorCode::Conflict => CoreErrorCode::Conflict,
        StoreErrorCode::GenerationConflict => CoreErrorCode::GenerationConflict,
        StoreErrorCode::HeadConflict => CoreErrorCode::HeadConflict,
        StoreErrorCode::PatchNotFound => CoreErrorCode::PatchNotFound,
        StoreErrorCode::PatchAmbiguous => CoreErrorCode::PatchAmbiguous,
        StoreErrorCode::PatchOverlap => CoreErrorCode::PatchOverlap,
        StoreErrorCode::RevisionConflict => CoreErrorCode::RevisionConflict,
        StoreErrorCode::IdempotencyKeyReused => CoreErrorCode::IdempotencyKeyReused,
        StoreErrorCode::IdempotencyWindowExpired => CoreErrorCode::IdempotencyWindowExpired,
        StoreErrorCode::LegacyIdempotencyUnavailable => CoreErrorCode::LegacyIdempotencyUnavailable,
        StoreErrorCode::ProtectedOwnerDeletion => CoreErrorCode::ProtectedOwnerDeletion,
        StoreErrorCode::MissingDependencies => CoreErrorCode::DocumentUpdateMissingDependencies,
        StoreErrorCode::UnsupportedSchema => CoreErrorCode::InvalidDocumentSchema,
        StoreErrorCode::StoreCorrupt => CoreErrorCode::StoreCorrupt,
        StoreErrorCode::MaintenanceInProgress => CoreErrorCode::MaintenanceInProgress,
        StoreErrorCode::ResourceExhausted => CoreErrorCode::ResourceExhausted,
        StoreErrorCode::WriterQueueFull | StoreErrorCode::ReaderPoolTimeout => {
            CoreErrorCode::Overloaded
        }
        StoreErrorCode::QueryCancelled => CoreErrorCode::Cancelled,
        StoreErrorCode::DeadlineExceeded => CoreErrorCode::DeadlineExceeded,
        _ => CoreErrorCode::CoreUnavailable,
    };
    CoreError {
        code,
        message: error.message,
        retryable: error.retryable,
        recovery: error.recovery.unwrap_or(CoreErrorRecovery::None),
    }
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn invalid(message: &str) -> CoreError {
    CoreError {
        code: CoreErrorCode::InvalidInput,
        message: message.to_owned(),
        retryable: false,
        recovery: CoreErrorRecovery::None,
    }
}

fn unauthorized_core(message: &str) -> CoreError {
    CoreError {
        code: CoreErrorCode::Unauthorized,
        message: message.to_owned(),
        retryable: false,
        recovery: CoreErrorRecovery::None,
    }
}

fn bound_actor_project_id(context: &BoundModuleContext) -> Result<&str, StoreError> {
    context
        .project_id
        .as_ref()
        .map(|project_id| project_id.0.as_str())
        .ok_or_else(|| {
            StoreError::new(
                StoreErrorCode::Unauthorized,
                "Document mutation requires a bound Project",
                false,
            )
        })
}

fn invalid_store(message: String) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message, false)
}

fn not_found(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::NotFound, message, false)
}

fn internal(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::Internal, message, false)
}

fn sqlite_now(connection: &rusqlite::Connection) -> Result<String, StoreError> {
    connection
        .query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", [], |row| {
            row.get::<_, String>(0)
        })
        .map_err(StoreError::from)
}

#[cfg(test)]
mod tests {
    mod asset_migration;
    mod recovery;
    use std::fs;

    use nodex_core_contracts::agent::{
        AgentProjectResourceAccess, AgentResourceAccessOverlay, AgentResourceAccessOverlayKind,
        AgentResourceAccessOverlayScope, AgentResourceGrantRoot, AgentResourceGrantSpec,
    };
    use nodex_core_contracts::document::{
        AgentDocumentSemanticMutation, DeletableOwnedSourceKind,
        DocumentBlockOperation as ContractDocumentBlockOperation,
        DocumentBlockUpdatePatch as ContractDocumentBlockUpdatePatch, DocumentCommitOutcome,
        DocumentHeadRevision, DocumentMutationCoordination, DocumentOptionalValue,
        DocumentOwnerCommand, DocumentOwnerRevision, DocumentSemanticBlockDraft,
        DocumentSemanticCommand, DocumentVersionCursor, OwnedDocumentIntent, OwnedDocumentRead,
    };
    use nodex_core_contracts::library::{LibraryIntent, LibraryWriteParent};
    use nodex_core_contracts::workspace::{
        PROJECT_WORKSPACE_CONTRACT_VERSION, ProjectWorkspaceIntent, ProjectWorkspaceThreadPatch,
        ProjectWorkspaceTurnAuthority, ProjectWorkspaceTurnAuthorityScope,
        ProjectWorkspaceTurnAuthoritySource,
    };
    use nodex_core_contracts::{
        AdapterKind, LIBRARY_CONTRACT_VERSION, LibraryId, ModuleApplyRequest, ModuleReadRequest,
        PageDocumentHeadImpact, ProfileId, ProjectId, ProjectionImpact,
    };
    use rusqlite::params;
    use tempfile::tempdir;

    use crate::document::{
        BlockDocumentSchema, DocumentAwareness, DocumentBlockOperation, DocumentBlockUpdatePatch,
        DocumentRealtimeEvent, DocumentSubscriptionEngine, OwnedDocumentRealtimeAdapter,
        YrsDocumentEngine, prepare_document_operation_update,
    };
    use crate::infrastructure::sqlite::{StoreError, with_immediate_transaction};
    use crate::infrastructure::store_validation::validate_current_store;
    use crate::library::LibraryModule;
    use crate::workspace::ProjectWorkspaceModule;

    use super::*;

    const PROFILE_ID: &str = "profile:test";
    const LIBRARY_ID: &str = "library:test";
    const PROJECT_ID: &str = "project:test";
    const DOCUMENT_ID: &str = "document:test-page";
    const OWNER_BLOCK_ID: &str = "019bf52d-6870-7000-8000-000000000001";
    const DATABASE_ID: &str = "019bf52d-6870-7000-8000-000000000020";
    const DATA_SOURCE_ID: &str = "019bf52d-6870-7000-8000-000000000021";
    const MEMBERSHIP_ID: &str = "019bf52d-6870-7000-8000-000000000022";
    const VIEW_ID_A: &str = "019bf52d-6870-7000-8000-000000000023";
    const VIEW_ID_B: &str = "019bf52d-6870-7000-8000-000000000024";
    const TARGET_PAGE_BLOCK_ID: &str = "019bf52d-6870-7000-8000-000000000002";
    const STORE_EPOCH: &str = "epoch:test";
    const NOW: &str = "2026-07-18T00:00:00.000Z";
    const CREATED_SOURCE_BLOCK_ID: &str = "019bf52d-6870-7000-8000-000000000010";
    const CREATED_SOURCE_DOCUMENT_ID: &str = "019bf52d-6870-7000-8000-000000000011";
    const CREATED_CONTENT_BLOCK_ID: &str = "019bf52d-6870-7000-8000-000000000012";
    const CREATED_REFERENCE_BLOCK_ID: &str = "019bf52d-6870-7000-8000-000000000013";
    const CREATED_TEMPLATE_BLOCK_ID: &str = "019bf52d-6870-7000-8000-000000000014";
    const CREATED_TEMPLATE_DOCUMENT_ID: &str = "019bf52d-6870-7000-8000-000000000015";
    const CREATED_TEMPLATE_CONTENT_ID: &str = "019bf52d-6870-7000-8000-000000000016";

    struct SeededModule {
        _directory: tempfile::TempDir,
        kernel: SqliteStoreKernel,
        module: OwnedDocumentModule,
        full_state: Vec<u8>,
        state_vector: Vec<u8>,
    }

    fn context() -> BoundModuleContext {
        context_for("renderer-session:test")
    }

    fn context_for(connection_id: &str) -> BoundModuleContext {
        context_for_project(connection_id, PROJECT_ID)
    }

    fn context_for_project(connection_id: &str, project_id: &str) -> BoundModuleContext {
        BoundModuleContext {
            editor_history_owner: None,
            profile_id: ProfileId(PROFILE_ID.to_owned()),
            library_id: LibraryId(LIBRARY_ID.to_owned()),
            project_id: Some(ProjectId(project_id.to_owned())),
            connection_id: connection_id.to_owned(),
            adapter: AdapterKind::Test,
        }
    }

    fn native_cli_context_for(connection_id: &str, project_id: &str) -> BoundModuleContext {
        BoundModuleContext {
            editor_history_owner: None,
            adapter: AdapterKind::NativeCli,
            ..context_for_project(connection_id, project_id)
        }
    }

    fn electron_context_for(connection_id: &str, project_id: &str) -> BoundModuleContext {
        BoundModuleContext {
            editor_history_owner: None,
            adapter: AdapterKind::ElectronHost,
            ..context_for_project(connection_id, project_id)
        }
    }

    fn library_context_for(connection_id: &str, adapter: AdapterKind) -> BoundModuleContext {
        BoundModuleContext {
            editor_history_owner: None,
            profile_id: ProfileId(PROFILE_ID.to_owned()),
            library_id: LibraryId(LIBRARY_ID.to_owned()),
            project_id: None,
            connection_id: connection_id.to_owned(),
            adapter,
        }
    }

    fn seeded_module() -> SeededModule {
        let directory = tempdir().expect("Profile");
        let home = directory.path().canonicalize().expect("absolute Profile");
        let kernel = SqliteStoreKernel::open_test(&home).expect("fresh Store");
        let fixture = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/yjs-yrs/empty-page.bin");
        let full_state = fs::read(fixture).expect("empty Page fixture");
        let engine =
            YrsDocumentEngine::from_full_state_v1(DOCUMENT_ID, &full_state).expect("Page engine");
        let state_vector = engine.state_vector_v1();
        let materialization =
            materialize_engine(&engine, BlockDocumentSchema::PageV3).expect("Page materialization");
        let snapshot_hash = sha256(&full_state);
        kernel
            .writer()
            .call({
                let full_state = full_state.clone();
                let state_vector = state_vector.clone();
                move |connection| {
                    with_immediate_transaction(connection, |transaction| {
                        transaction.execute(
                            "INSERT INTO profiles(id, created_at, updated_at) VALUES (?1, ?2, ?2)",
                            params![PROFILE_ID, NOW],
                        )?;
                        transaction.execute(
                            "INSERT INTO libraries(id, profile_id, created_at, updated_at) \
                             VALUES (?1, ?2, ?3, ?3)",
                            params![LIBRARY_ID, PROFILE_ID, NOW],
                        )?;
                        transaction.execute(
                            "INSERT INTO projects(id, library_id, name, created, updated) \
                             VALUES (?1, ?2, 'Document test', ?3, ?3)",
                            params![PROJECT_ID, LIBRARY_ID, NOW],
                        )?;
                        transaction.execute(
                            "INSERT INTO block_store_metadata(id, store_epoch, created_at, updated_at) \
                             VALUES (1, ?1, ?2, ?2)",
                            params![STORE_EPOCH, NOW],
                        )?;
                        transaction.execute(
                            "INSERT INTO blocks(\
                               id, library_id, type, lifecycle, placement_revision, \
                               metadata_revision, created_at, updated_at\
                             ) VALUES (?1, ?2, 'page', 'active', 1, 1, ?3, ?3)",
                            params![OWNER_BLOCK_ID, LIBRARY_ID, NOW],
                        )?;
                        transaction.execute(
                            "INSERT INTO documents(\
                               id, library_id, generation, head_seq, schema_key, schema_version, \
                               state_vector, state_hash, readiness, authority, created_at, updated_at, sync_engine\
                             ) VALUES (?1, ?2, 1, 1, 'nodex.page', 3, ?3, ?4, \
                               'ready', 'ydoc_primary', ?5, ?5, 'yjs')",
                            params![DOCUMENT_ID, LIBRARY_ID, state_vector, "", NOW],
                        )?;
                        transaction.execute(
                            "INSERT INTO block_documents(block_id, document_id, library_id, created_at) \
                             VALUES (?1, ?2, ?3, ?4)",
                            params![OWNER_BLOCK_ID, DOCUMENT_ID, LIBRARY_ID, NOW],
                        )?;
                        transaction.execute(
                            "INSERT INTO pages(\
                               block_id, library_id, document_id, parent_kind, parent_id, \
                               created_at, updated_at\
                             ) VALUES (?1, ?2, ?3, 'library', ?2, ?4, ?4)",
                            params![OWNER_BLOCK_ID, LIBRARY_ID, DOCUMENT_ID, NOW],
                        )?;
                        transaction.execute(
                            "INSERT INTO library_block_placements(\
                               block_id, library_id, rank_key, revision, created_at, updated_at\
                             ) VALUES (?1, ?2, '7fffffffffffffffffffffffffffffff', 1, ?3, ?3)",
                            params![OWNER_BLOCK_ID, LIBRARY_ID, NOW],
                        )?;
                        transaction.execute(
                            "INSERT INTO project_resource_grants(\
                               id, project_id, library_id, root_kind, root_id, access, recursive, \
                               revision, lifecycle, created_at, updated_at\
                             ) VALUES ('grant:document-ready-page', ?1, ?2, 'page', ?3, \
                               'read_write', 1, 1, 'active', ?4, ?4)",
                            params![PROJECT_ID, LIBRARY_ID, OWNER_BLOCK_ID, NOW],
                        )?;
                        for unit in &materialization.search_units {
                            transaction.execute(
                                "INSERT INTO blocks(\
                                   id, library_id, type, lifecycle, placement_revision, \
                                   metadata_revision, created_at, updated_at\
                                 ) VALUES (?1, ?2, ?3, 'active', 1, 1, ?4, ?4)",
                                params![unit.block_id, LIBRARY_ID, unit.block_type, NOW],
                            )?;
                            transaction.execute(
                                "INSERT INTO document_block_index(\
                                   document_id, block_id, parent_block_id, ordinal, block_type, text, projected_seq\
                                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1)",
                                params![
                                    DOCUMENT_ID,
                                    unit.block_id,
                                    unit.parent_block_id,
                                    unit.ordinal as i64,
                                    unit.block_type,
                                    unit.text,
                                ],
                            )?;
                        }
                        transaction.execute(
                            "INSERT INTO document_updates(\
                               document_id, generation, seq, update_id, client_session_id, base_head_seq, \
                               touched_block_ids_json, update_blob, update_hash, committed_at\
                             ) VALUES (?1, 1, 1, 'genesis:test', 'seed:test', 0, '[]', ?2, ?3, ?4)",
                            params![DOCUMENT_ID, full_state, snapshot_hash, NOW],
                        )?;
                        transaction.execute(
                            "INSERT INTO document_update_receipts(\
                               document_id, generation, seq, update_id, client_session_id, base_head_seq, \
                               client_touched_block_ids_json, derived_touched_block_ids_json, \
                               derivation_version, update_hash, update_byte_length, committed_at\
                             ) VALUES (?1, 1, 1, 'genesis:test', 'seed:test', 0, '[]', '[]', 1, ?2, ?3, ?4)",
                            params![DOCUMENT_ID, snapshot_hash, full_state.len() as i64, NOW],
                        )?;
                        transaction.execute(
                            "INSERT INTO document_snapshots(\
                               document_id, generation, snapshot_seq, state_vector, snapshot_update, \
                               snapshot_hash, schema_version, created_at\
                             ) VALUES (?1, 1, 1, ?2, ?3, ?4, 3, ?5)",
                            params![DOCUMENT_ID, state_vector, full_state, snapshot_hash, NOW],
                        )?;
                        let rich_title = serde_json::to_string(&materialization.rich_title)
                            .map_err(|_| internal("seed rich title"))?;
                        transaction.execute(
                            "INSERT INTO document_materializations(\
                               document_id, generation, projected_seq, schema_version, title, title_rich_json, \
                               title_rich_hash, nfm, plain_text, preview, block_tree_json, references_json, \
                               asset_refs_json, updated_at\
                             ) VALUES (?1, 1, 1, 3, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                            params![
                                DOCUMENT_ID,
                                materialization.title,
                                rich_title,
                                sha256(rich_title.as_bytes()),
                                materialization.nfm,
                                materialization.plain_text,
                                materialization.preview,
                                serde_json::to_string(&materialization.block_tree)
                                    .map_err(|_| internal("seed blocks"))?,
                                serde_json::to_string(&materialization.references)
                                    .map_err(|_| internal("seed references"))?,
                                serde_json::to_string(&materialization.asset_refs)
                                    .map_err(|_| internal("seed assets"))?,
                                NOW,
                            ],
                        )?;
                        transaction.execute(
                            "INSERT INTO page_read_model(\
                               page_block_id, library_id, lifecycle, parent_kind, parent_id, \
                               library_rank_key, placement_revision, metadata_revision, \
                               document_id, document_generation, \
                               document_projected_seq, document_schema_version, document_authority, \
                               membership_id, database_block_id, view_id, view_group_key, view_rank_key, \
                               title, description_preview, description_length, has_description, \
                               database_values_json, intrinsic_properties_json, property_revisions_json, \
                               projection_version, created_at, updated_at\
                             ) VALUES (?1, ?2, 'active', 'library', ?2, \
                               '7fffffffffffffffffffffffffffffff', 1, 1, ?3, 1, 1, 3, \
                               'ydoc_primary', NULL, NULL, NULL, NULL, NULL, ?4, ?5, ?6, ?7, '{}', '{}', \
                               '{}', 1, ?8, ?8)",
                            params![
                                OWNER_BLOCK_ID,
                                LIBRARY_ID,
                                DOCUMENT_ID,
                                materialization.title,
                                materialization.preview,
                                materialization.nfm.len() as i64,
                                i64::from(!materialization.nfm.trim().is_empty()),
                                NOW,
                            ],
                        )?;
                        Ok(())
                    })
                }
            })
            .expect("seed ready Page");
        let module = OwnedDocumentModule::new(PROFILE_ID, LIBRARY_ID, &kernel);
        SeededModule {
            _directory: directory,
            kernel,
            module,
            full_state,
            state_vector,
        }
    }

    fn title_update(full_state: &[u8], state_vector: &[u8], title: &str) -> Vec<u8> {
        prepare_document_operation_update(
            DOCUMENT_ID,
            BlockDocumentSchema::PageV3,
            full_state,
            state_vector,
            &[DocumentBlockOperation::SetTitle {
                title: title.to_owned(),
            }],
            false,
        )
        .expect("title update")
        .update_v1
    }

    fn synced_page_engine(seeded: &SeededModule) -> (i64, YrsDocumentEngine) {
        let sync = seeded
            .module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    read: OwnedDocumentRead::SyncYjs {
                        document_id: DOCUMENT_ID.to_owned(),
                        state_vector: Vec::new(),
                        history_after_head_seq: None,
                    },
                },
            )
            .expect("Yjs sync");
        let OwnedDocumentReadValue::YjsSync {
            descriptor, update, ..
        } = sync.value
        else {
            panic!("expected Yjs sync")
        };
        let engine = YrsDocumentEngine::from_full_state_v1(DOCUMENT_ID, &update)
            .expect("synced Page engine");
        (descriptor.head_seq, engine)
    }

    fn raw_document_operation_update(
        engine: &YrsDocumentEngine,
        operations: &[DocumentBlockOperation],
    ) -> Vec<u8> {
        prepare_document_operation_update(
            DOCUMENT_ID,
            BlockDocumentSchema::PageV3,
            &engine.full_state_v1(),
            &engine.state_vector_v1(),
            operations,
            false,
        )
        .expect("raw Document operation update")
        .update_v1
    }

    fn persisted_body(seeded: &SeededModule) -> (String, Vec<MaterializedBlockNode>) {
        seeded
            .kernel
            .readers()
            .read_default(|connection| {
                let (nfm, block_tree_json): (String, String) = connection.query_row(
                    "SELECT nfm, block_tree_json FROM document_materializations WHERE document_id = ?1",
                    [DOCUMENT_ID],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )?;
                let block_tree = serde_json::from_str(&block_tree_json)
                    .map_err(|_| internal("persisted body Block tree JSON"))?;
                Ok::<_, StoreError>((nfm, block_tree))
            })
            .expect("persisted Document body")
    }

    fn move_seeded_page_under_database(seeded: &SeededModule) {
        seeded
            .kernel
            .writer()
            .call(|connection| {
                with_immediate_transaction(connection, |transaction| {
                    transaction.execute(
                        "INSERT OR IGNORE INTO profiles(id, created_at, updated_at) \
                         VALUES (?1, ?2, ?2)",
                        params![PROFILE_ID, NOW],
                    )?;
                    transaction.execute(
                        "INSERT OR IGNORE INTO libraries(id, profile_id, created_at, updated_at) \
                         VALUES (?1, ?2, ?3, ?3)",
                        params![LIBRARY_ID, PROFILE_ID, NOW],
                    )?;
                    transaction.execute(
                        "INSERT INTO blocks(\
                           id, library_id, type, lifecycle, placement_revision, metadata_revision, \
                           created_at, updated_at\
                         ) VALUES (?1, ?2, 'database', 'active', 1, 1, ?3, ?3)",
                        params![DATABASE_ID, LIBRARY_ID, NOW],
                    )?;
                    transaction.execute(
                        "INSERT INTO library_block_placements(\
                           block_id, library_id, rank_key, revision, created_at, updated_at\
                         ) VALUES (?1, ?2, 'b', 1, ?3, ?3)",
                        params![DATABASE_ID, LIBRARY_ID, NOW],
                    )?;
                    transaction.execute(
                        "INSERT INTO database_containers(\
                           block_id, library_id, name, lifecycle, default_view_id, access_revision, \
                           metadata_revision, created_at, updated_at\
                         ) VALUES (?1, ?2, 'Document test Database', 'active', NULL, 1, 1, ?3, ?3)",
                        params![DATABASE_ID, LIBRARY_ID, NOW],
                    )?;
                    transaction.execute(
                        "INSERT INTO data_sources(\
                           id, library_id, home_database_block_id, name, schema_key, schema_revision, \
                           lifecycle, rank_key, created_at, updated_at\
                         ) VALUES (?1, ?2, ?3, 'Document test Pages', 'nodex.pages', 1, \
                           'active', 'a', ?4, ?4)",
                        params![DATA_SOURCE_ID, LIBRARY_ID, DATABASE_ID, NOW],
                    )?;
                    let view_config = serde_json::to_string(&json!({
                        "schemaKey": "nodex.database-view",
                        "schemaVersion": 6,
                        "rules": {
                            "propertyFilters": [],
                            "advancedFilter": null,
                            "sorts": [{
                                "field": { "kind": "manual" },
                                "direction": "asc",
                                "nulls": "last"
                            }]
                        },
                        "presentation": {
                            "group": null,
                            "subgroup": null,
                            "groupDirection": "asc",
                            "completion": { "range": "all", "orderByRecency": false },
                            "hierarchy": { "showSubPages": true, "nestedSubPages": false },
                            "display": { "fields": [], "showEmptyGroups": false }
                        }
                    }))
                    .map_err(|_| internal("Document test View config"))?;
                    for (view_id, rank_key) in [(VIEW_ID_A, "a"), (VIEW_ID_B, "b")] {
                        transaction.execute(
                            "INSERT INTO database_views(\
                               id, database_block_id, data_source_id, name, layout, config_json, \
                               rank_key, created_at, updated_at\
                             ) VALUES (?1, ?2, ?3, 'Document test View', 'list', ?4, ?5, ?6, ?6)",
                            params![
                                view_id,
                                DATABASE_ID,
                                DATA_SOURCE_ID,
                                view_config,
                                rank_key,
                                NOW,
                            ],
                        )?;
                    }
                    transaction.execute(
                        "UPDATE database_containers SET default_view_id = ?1 WHERE block_id = ?2",
                        params![VIEW_ID_A, DATABASE_ID],
                    )?;
                    transaction.execute(
                        "UPDATE projects SET database_block_id = ?1, binding_revision = binding_revision + 1, \
                           updated = ?2 WHERE id = ?3 AND library_id = ?4",
                        params![DATABASE_ID, NOW, PROJECT_ID, LIBRARY_ID],
                    )?;
                    transaction.execute(
                        "DELETE FROM library_block_placements WHERE block_id = ?1 AND library_id = ?2",
                        params![OWNER_BLOCK_ID, LIBRARY_ID],
                    )?;
                    transaction.execute(
                        "UPDATE blocks SET placement_revision = placement_revision + 1, updated_at = ?1 \
                         WHERE id = ?2 AND library_id = ?3",
                        params![NOW, OWNER_BLOCK_ID, LIBRARY_ID],
                    )?;
                    transaction.execute(
                        "UPDATE pages SET parent_kind = 'data_source', parent_id = ?1, updated_at = ?2 \
                         WHERE block_id = ?3",
                        params![DATA_SOURCE_ID, NOW, OWNER_BLOCK_ID],
                    )?;
                    transaction.execute(
                        "INSERT INTO data_source_page_memberships(\
                           id, data_source_id, page_block_id, revision, created_at, removed_at\
                         ) VALUES (?1, ?2, ?3, 1, ?4, NULL)",
                        params![MEMBERSHIP_ID, DATA_SOURCE_ID, OWNER_BLOCK_ID, NOW],
                    )?;
                    crate::database::position_page_in_view(transaction, VIEW_ID_A, OWNER_BLOCK_ID,
                        crate::database::ViewOrderPlacement::End, NOW)?;
                    transaction.execute(
                        "UPDATE page_read_model SET parent_kind = 'data_source', parent_id = ?1, \
                           library_rank_key = NULL, placement_revision = 2, membership_id = ?2, \
                           database_block_id = ?3, view_id = ?4, view_rank_key = 'a', updated_at = ?5 \
                         WHERE page_block_id = ?6 AND library_id = ?7",
                        params![
                            DATA_SOURCE_ID,
                            MEMBERSHIP_ID,
                            DATABASE_ID,
                            VIEW_ID_A,
                            NOW,
                            OWNER_BLOCK_ID,
                            LIBRARY_ID,
                        ],
                    )?;
                    Ok(())
                })
            })
            .expect("move seeded Page under Database");
    }

    fn seed_agent_turn(seeded: &SeededModule, connection_id: &str) -> AgentTurnProvenance {
        seed_agent_turn_for_project(seeded, connection_id, PROJECT_ID)
    }

    fn seed_agent_turn_for_project(
        seeded: &SeededModule,
        connection_id: &str,
        actor_project_id: &str,
    ) -> AgentTurnProvenance {
        let thread_id = format!("thread:agent-prepared:{actor_project_id}");
        let turn_id = format!("turn:agent-prepared:{actor_project_id}");
        seeded
            .kernel
            .writer()
            .call({
                let actor_project_id = actor_project_id.to_owned();
                move |connection| {
                    with_immediate_transaction(connection, |transaction| {
                        transaction.execute(
                            "INSERT OR IGNORE INTO profiles(id, created_at, updated_at) \
                             VALUES (?1, ?2, ?2)",
                            params![PROFILE_ID, NOW],
                        )?;
                        transaction.execute(
                            "INSERT OR IGNORE INTO libraries(id, profile_id, created_at, updated_at) \
                         VALUES (?1, ?2, ?3, ?3)",
                            params![LIBRARY_ID, PROFILE_ID, NOW],
                        )?;
                        transaction.execute(
                            "INSERT OR IGNORE INTO pages(\
                           block_id, library_id, document_id, parent_kind, parent_id, \
                           created_at, updated_at\
                         ) VALUES (?1, ?2, ?3, 'library', ?2, ?4, ?4)",
                            params![OWNER_BLOCK_ID, LIBRARY_ID, DOCUMENT_ID, NOW],
                        )?;
                        if actor_project_id != PROJECT_ID {
                            transaction.execute(
                                "INSERT INTO projects(id, library_id, name, created, updated) \
                             VALUES (?1, ?2, 'Agent actor', ?3, ?3)",
                                params![actor_project_id, LIBRARY_ID, NOW],
                            )?;
                        }
                        Ok(())
                    })
                }
            })
            .expect("seed Agent authority coordinates");
        let workspace =
            ProjectWorkspaceModule::new(PROFILE_ID, LIBRARY_ID, &seeded.kernel).expect("Workspace");
        let host = context_for_project(connection_id, actor_project_id);
        workspace
            .apply(
                &host,
                ModuleApplyRequest {
                    contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                    operation_id: format!("workspace:agent-thread:{actor_project_id}"),
                    store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
                    intent: ProjectWorkspaceIntent::UpsertThread {
                        thread_id: thread_id.clone(),
                        patch: Box::new(ProjectWorkspaceThreadPatch {
                            project_id: Some(Some(actor_project_id.to_owned())),
                            thread_name: Some(Some("Prepared Agent test".to_owned())),
                            created_at: Some(1),
                            updated_at: Some(1),
                            linked_at: Some(NOW.to_owned()),
                            ..ProjectWorkspaceThreadPatch::default()
                        }),
                    },
                },
            )
            .expect("persist Agent Thread");
        workspace
            .apply(
                &host,
                ModuleApplyRequest {
                    contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                    operation_id: format!("workspace:agent-turn:{actor_project_id}"),
                    store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
                    intent: ProjectWorkspaceIntent::FreezeTurnAuthority {
                        thread_id: thread_id.clone(),
                        turn_id: turn_id.clone(),
                        root_thread_id: thread_id.clone(),
                        actor_project_id: actor_project_id.to_owned(),
                        source: ProjectWorkspaceTurnAuthoritySource::ProjectTurn,
                        inherited_from: None,
                    },
                },
            )
            .expect("freeze Agent Turn");
        AgentTurnProvenance {
            profile_id: PROFILE_ID.to_owned(),
            authority: ProjectWorkspaceTurnAuthority {
                thread_id: thread_id.clone(),
                turn_id,
                root_thread_id: thread_id,
                actor_project_id: actor_project_id.to_owned(),
                library_id: LIBRARY_ID.to_owned(),
                store_epoch: STORE_EPOCH.to_owned(),
                scope: ProjectWorkspaceTurnAuthorityScope::Project,
                source: ProjectWorkspaceTurnAuthoritySource::ProjectTurn,
            },
        }
    }

    fn agent_execution_authorization(
        provenance: AgentTurnProvenance,
    ) -> AgentExecutionAuthorization {
        let authority = provenance.authority.clone();
        let call_id = "call:agent-document-test".to_owned();
        AgentExecutionAuthorization {
            provenance,
            call_id: call_id.clone(),
            resource_access: Some(AgentResourceAccessOverlay {
                kind: AgentResourceAccessOverlayKind::Consent,
                scope: AgentResourceAccessOverlayScope::Call,
                thread_id: Some(authority.thread_id.clone()),
                turn_id: Some(authority.turn_id.clone()),
                call_id: Some(call_id),
                root_thread_id: authority.root_thread_id.clone(),
                actor_project_id: authority.actor_project_id.clone(),
                library_id: authority.library_id.clone(),
                store_epoch: authority.store_epoch.clone(),
                grants: vec![AgentResourceGrantSpec {
                    root: AgentResourceGrantRoot::Page {
                        page_id: OWNER_BLOCK_ID.to_owned(),
                    },
                    access: AgentProjectResourceAccess::ReadWrite,
                    library_actions: Vec::new(),
                }],
                persist_resulting_page_grants: false,
            }),
        }
    }

    fn apply_request(
        update_id: &str,
        base_head_seq: i64,
        update: Vec<u8>,
    ) -> ModuleApplyRequest<OwnedDocumentIntent> {
        ModuleApplyRequest {
            contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
            operation_id: update_id.to_owned(),
            store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
            intent: OwnedDocumentIntent::ApplyYjsUpdate {
                document_id: DOCUMENT_ID.to_owned(),
                generation: 1,
                base_head_seq,
                update_id: update_id.to_owned(),
                touched_block_ids: vec![OWNER_BLOCK_ID.to_owned()],
                update,
            },
        }
    }

    fn pending_module(owner_type: &str, schema_key: &str, schema_version: i64) -> SeededModule {
        let directory = tempdir().expect("Profile");
        let home = directory.path().canonicalize().expect("absolute Profile");
        let kernel = SqliteStoreKernel::open_test(&home).expect("fresh Store");
        let owner_type = owner_type.to_owned();
        let schema_key = schema_key.to_owned();
        kernel
            .writer()
            .call(move |connection| {
                with_immediate_transaction(connection, |transaction| {
                    transaction.execute(
                        "INSERT INTO profiles(id, created_at, updated_at) VALUES (?1, ?2, ?2)",
                        params![PROFILE_ID, NOW],
                    )?;
                    transaction.execute(
                        "INSERT INTO libraries(id, profile_id, created_at, updated_at) \
                         VALUES (?1, ?2, ?3, ?3)",
                        params![LIBRARY_ID, PROFILE_ID, NOW],
                    )?;
                    transaction.execute(
                        "INSERT INTO projects(id, library_id, name, created, updated) \
                         VALUES (?1, ?2, 'Pending Document test', ?3, ?3)",
                        params![PROJECT_ID, LIBRARY_ID, NOW],
                    )?;
                    transaction.execute(
                        "INSERT INTO block_store_metadata(id, store_epoch, created_at, updated_at) \
                         VALUES (1, ?1, ?2, ?2)",
                        params![STORE_EPOCH, NOW],
                    )?;
                    transaction.execute(
                        "INSERT INTO blocks(\
                           id, library_id, type, lifecycle, placement_revision, metadata_revision, \
                           created_at, updated_at\
                         ) VALUES (?1, ?2, ?3, 'active', 1, 1, ?4, ?4)",
                        params![OWNER_BLOCK_ID, LIBRARY_ID, owner_type, NOW],
                    )?;
                    transaction.execute(
                        "INSERT INTO documents(\
                           id, library_id, generation, head_seq, schema_key, schema_version, \
                           state_vector, state_hash, readiness, authority, created_at, updated_at, sync_engine\
                         ) VALUES (?1, ?2, 1, 0, ?3, ?4, X'', '', \
                           'pending_genesis', 'legacy_shadow', ?5, ?5, 'yjs')",
                        params![DOCUMENT_ID, LIBRARY_ID, schema_key, schema_version, NOW],
                    )?;
                    transaction.execute(
                        "INSERT INTO block_documents(block_id, document_id, library_id, created_at) \
                         VALUES (?1, ?2, ?3, ?4)",
                        params![OWNER_BLOCK_ID, DOCUMENT_ID, LIBRARY_ID, NOW],
                    )?;
                    transaction.execute(
                        "INSERT INTO library_block_placements(\
                           block_id, library_id, rank_key, revision, created_at, updated_at\
                         ) VALUES (?1, ?2, 'a', 1, ?3, ?3)",
                        params![OWNER_BLOCK_ID, LIBRARY_ID, NOW],
                    )?;
                    if owner_type == "page" {
                        transaction.execute(
                            "INSERT INTO pages(\
                               block_id, library_id, document_id, parent_kind, parent_id, \
                               created_at, updated_at\
                             ) VALUES (?1, ?2, ?3, 'library', ?2, ?4, ?4)",
                            params![OWNER_BLOCK_ID, LIBRARY_ID, DOCUMENT_ID, NOW],
                        )?;
                        transaction.execute(
                            "INSERT INTO page_read_model(\
                               page_block_id, library_id, lifecycle, parent_kind, parent_id, \
                               library_rank_key, placement_revision, metadata_revision, \
                               document_id, document_generation, \
                               document_projected_seq, document_schema_version, document_authority, \
                               membership_id, database_block_id, view_id, view_group_key, view_rank_key, \
                               title, description_preview, description_length, has_description, \
                               database_values_json, intrinsic_properties_json, property_revisions_json, \
                               projection_version, created_at, updated_at\
                             ) VALUES (?1, ?2, 'active', 'library', ?2, 'a', 1, 1, ?3, 1, 0, ?4, \
                               'legacy_shadow', NULL, NULL, NULL, NULL, NULL, '', '', 0, 0, '{}', '{}', \
                               '{}', 1, ?5, ?5)",
                            params![
                                OWNER_BLOCK_ID,
                                LIBRARY_ID,
                                DOCUMENT_ID,
                                schema_version,
                                NOW,
                            ],
                        )?;
                        transaction.execute(
                            "INSERT INTO project_resource_grants(\
                               id, project_id, library_id, root_kind, root_id, access, recursive, \
                               revision, lifecycle, created_at, updated_at\
                             ) VALUES ('grant:document-test', ?1, ?2, 'page', ?3, \
                               'read_write', 1, 1, 'active', ?4, ?4)",
                            params![PROJECT_ID, LIBRARY_ID, OWNER_BLOCK_ID, NOW],
                        )?;
                    }
                    Ok(())
                })
            })
            .expect("seed pending Document");
        let module = OwnedDocumentModule::new(PROFILE_ID, LIBRARY_ID, &kernel);
        SeededModule {
            _directory: directory,
            kernel,
            module,
            full_state: Vec::new(),
            state_vector: Vec::new(),
        }
    }

    fn empty_project_module() -> SeededModule {
        let directory = tempdir().expect("Profile");
        let home = directory.path().canonicalize().expect("absolute Profile");
        fs::create_dir(home.join("assets")).expect("assets root");
        let kernel = SqliteStoreKernel::open_test(&home).expect("fresh Store");
        kernel
            .writer()
            .call(|connection| {
                with_immediate_transaction(connection, |transaction| {
                    transaction.execute(
                        "INSERT OR IGNORE INTO profiles(id, created_at, updated_at) \
                         VALUES (?1, ?2, ?2)",
                        params![PROFILE_ID, NOW],
                    )?;
                    transaction.execute(
                        "INSERT OR IGNORE INTO libraries(id, profile_id, created_at, updated_at) \
                         VALUES (?1, ?2, ?3, ?3)",
                        params![LIBRARY_ID, PROFILE_ID, NOW],
                    )?;
                    transaction.execute(
                        "INSERT INTO projects(id, library_id, name, created, updated) \
                         VALUES (?1, ?2, 'Owner command test', ?3, ?3)",
                        params![PROJECT_ID, LIBRARY_ID, NOW],
                    )?;
                    transaction.execute(
                        "INSERT INTO block_store_metadata(id, store_epoch, created_at, updated_at) \
                         VALUES (1, ?1, ?2, ?2)",
                        params![STORE_EPOCH, NOW],
                    )?;
                    Ok(())
                })
            })
            .expect("seed empty Project");
        let module = OwnedDocumentModule::new(PROFILE_ID, LIBRARY_ID, &kernel);
        SeededModule {
            _directory: directory,
            kernel,
            module,
            full_state: Vec::new(),
            state_vector: Vec::new(),
        }
    }

    fn owner_request(
        operation_id: &str,
        command: DocumentOwnerCommand,
    ) -> ModuleApplyRequest<OwnedDocumentIntent> {
        ModuleApplyRequest {
            contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
            operation_id: operation_id.to_owned(),
            store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
            intent: OwnedDocumentIntent::ApplyOwnerCommand { command },
        }
    }

    fn paragraph(block_id: &str, text: &str) -> Value {
        json!({
            "id": block_id,
            "type": "paragraph",
            "props": {},
            "content": if text.is_empty() {
                Value::Array(Vec::new())
            } else {
                json!([{ "type": "text", "text": text, "styles": {} }])
            },
            "children": [],
        })
    }

    fn canvas_module() -> SeededModule {
        let directory = tempdir().expect("Profile");
        let home = directory.path().canonicalize().expect("absolute Profile");
        fs::create_dir(home.join("assets")).expect("assets root");
        let kernel = SqliteStoreKernel::open_test(&home).expect("fresh Store");
        kernel
            .writer()
            .call(|connection| {
                with_immediate_transaction(connection, |transaction| {
                    transaction.execute(
                        "INSERT OR IGNORE INTO profiles(id, created_at, updated_at) \
                         VALUES (?1, ?2, ?2)",
                        params![PROFILE_ID, NOW],
                    )?;
                    transaction.execute(
                        "INSERT OR IGNORE INTO libraries(id, profile_id, created_at, updated_at) \
                         VALUES (?1, ?2, ?3, ?3)",
                        params![LIBRARY_ID, PROFILE_ID, NOW],
                    )?;
                    transaction.execute(
                        "INSERT INTO projects(id, library_id, name, created, updated) \
                         VALUES (?1, ?2, 'Canvas test', ?3, ?3)",
                        params![PROJECT_ID, LIBRARY_ID, NOW],
                    )?;
                    transaction.execute(
                        "INSERT INTO block_store_metadata(id, store_epoch, created_at, updated_at) \
                         VALUES (1, ?1, ?2, ?2)",
                        params![STORE_EPOCH, NOW],
                    )?;
                    transaction.execute(
                        "INSERT INTO blocks(\
                           id, library_id, type, lifecycle, placement_revision, metadata_revision, \
                           created_at, updated_at\
                         ) VALUES (?1, ?2, 'canvas', 'active', 1, 1, ?3, ?3)",
                        params![OWNER_BLOCK_ID, LIBRARY_ID, NOW],
                    )?;
                    transaction.execute(
                        "INSERT INTO blocks(\
                           id, library_id, type, lifecycle, placement_revision, metadata_revision, \
                           created_at, updated_at\
                         ) VALUES (?1, ?2, 'page', 'active', 1, 1, ?3, ?3)",
                        params![TARGET_PAGE_BLOCK_ID, LIBRARY_ID, NOW],
                    )?;
                    transaction.execute(
                        "INSERT INTO documents(\
                           id, library_id, generation, head_seq, schema_key, schema_version, \
                           state_vector, state_hash, readiness, authority, created_at, updated_at, sync_engine\
                         ) VALUES (?1, ?2, 1, 0, 'nodex.canvas', 2, X'', ?3, \
                           'ready', 'ydoc_primary', ?4, ?4, 'canvas_scene')",
                        params![DOCUMENT_ID, LIBRARY_ID, "0".repeat(64), NOW],
                    )?;
                    transaction.execute(
                        "INSERT INTO block_documents(block_id, document_id, library_id, created_at) \
                         VALUES (?1, ?2, ?3, ?4)",
                        params![OWNER_BLOCK_ID, DOCUMENT_ID, LIBRARY_ID, NOW],
                    )?;
                    transaction.execute(
                        "INSERT INTO canvas_owners(block_id, library_id, created_at, updated_at) \
                         VALUES (?1, ?2, ?3, ?3)",
                        params![OWNER_BLOCK_ID, LIBRARY_ID, NOW],
                    )?;
                    transaction.execute(
                        "INSERT INTO library_block_placements(\
                           block_id, library_id, rank_key, revision, created_at, updated_at\
                         ) VALUES (?1, ?2, 'a', 1, ?3, ?3)",
                        params![OWNER_BLOCK_ID, LIBRARY_ID, NOW],
                    )?;
                    transaction.execute(
                        "INSERT INTO project_resource_grants(\
                           id, project_id, library_id, root_kind, root_id, access, recursive, \
                           revision, lifecycle, created_at, updated_at\
                         ) VALUES ('grant:canvas-test', ?1, ?2, 'canvas', ?3, \
                           'read_write', 1, 1, 'active', ?4, ?4)",
                        params![PROJECT_ID, LIBRARY_ID, OWNER_BLOCK_ID, NOW],
                    )?;
                    Ok(())
                })
            })
            .expect("seed Canvas");
        let module = OwnedDocumentModule::new(PROFILE_ID, LIBRARY_ID, &kernel);
        SeededModule {
            _directory: directory,
            kernel,
            module,
            full_state: Vec::new(),
            state_vector: Vec::new(),
        }
    }

    fn create_canvas_file(seeded: &SeededModule, file_id: &str, bytes: &[u8]) {
        use crate::infrastructure::managed_blobs::BlobWriter;
        use nodex_core_contracts::library::{
            LIBRARY_CONTRACT_VERSION, LibraryFileChange, LibraryIntent,
        };
        let root = seeded._directory.path().join("assets");
        let mut writer = BlobWriter::new(&root, 10 * 1024 * 1024).unwrap();
        writer.write_chunk(bytes).unwrap();
        let published = writer.finish().unwrap();
        let library = crate::library::LibraryModule::new(PROFILE_ID, LIBRARY_ID, &seeded.kernel);
        let operation = format!("create:{file_id}");
        let expiry = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64
            + 60_000;
        let receipt = library
            .register_prepared_file_blob(
                &context(),
                STORE_EPOCH,
                &operation,
                &operation,
                &published.content_hash,
                &published.physical_asset_name,
                published.byte_length,
                expiry,
            )
            .unwrap();
        library
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: operation,
                    store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
                    intent: LibraryIntent::ApplyFileChange {
                        change: LibraryFileChange::Create {
                            file_id: file_id.to_owned(),
                            default_name: "image.png".to_owned(),
                            mime_type: "image/png".to_owned(),
                            prepared_blob_receipt_id: receipt.receipt_id,
                        },
                        turn_id: None,
                    },
                },
            )
            .unwrap();
    }

    fn canvas_mutation_request(
        operation_id: &str,
        base_head_seq: i64,
        version: i64,
        text: &str,
    ) -> ModuleApplyRequest<OwnedDocumentIntent> {
        ModuleApplyRequest {
            contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
            operation_id: operation_id.to_owned(),
            store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
            intent: OwnedDocumentIntent::ApplyCanvasMutation {
                document_id: DOCUMENT_ID.to_owned(),
                generation: 1,
                expected_head_seq: base_head_seq,
                mutation: json!({
                    "elementCandidates": [{
                        "id": "element:page-ref",
                        "type": "rectangle",
                        "version": version,
                        "versionNonce": 7,
                        "index": "a0",
                        "isDeleted": false,
                        "text": text,
                        "customData": {
                            "type": "nodex-card",
                            "cardId": TARGET_PAGE_BLOCK_ID,
                            "titleHint": "Target"
                        }
                    }],
                    "appStateIntents": {
                        "gridSize": {
                            "expected": { "kind": "absent" },
                            "value": { "kind": "value", "value": 20 }
                        }
                    },
                    "fileAdditions": {}
                }),
            },
        }
    }

    fn canvas_geometry_mutation_request(
        operation_id: String,
        base_head_seq: i64,
        elements: Vec<Value>,
    ) -> ModuleApplyRequest<OwnedDocumentIntent> {
        ModuleApplyRequest {
            contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
            operation_id,
            store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
            intent: OwnedDocumentIntent::ApplyCanvasMutation {
                document_id: DOCUMENT_ID.to_owned(),
                generation: 1,
                expected_head_seq: base_head_seq,
                mutation: json!({
                    "elementCandidates": elements,
                    "appStateIntents": {},
                    "fileAdditions": {}
                }),
            },
        }
    }

    #[test]
    fn current_store_validation_accepts_unchanged_incremental_canvas_projections() {
        let seeded = canvas_module();
        seeded
            .module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    operation_id: "canvas:projection-validation:prepare".to_owned(),
                    store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
                    intent: OwnedDocumentIntent::PrepareOwner {
                        owner_block_id: OWNER_BLOCK_ID.to_owned(),
                    },
                },
            )
            .expect("prepare Canvas");
        seeded
            .module
            .apply(
                &context(),
                canvas_mutation_request(
                    "canvas:projection-validation:content",
                    0,
                    1,
                    "Native Canvas",
                ),
            )
            .expect("apply Canvas content edit");
        seeded
            .module
            .apply(
                &context(),
                canvas_geometry_mutation_request(
                    "canvas:projection-validation:geometry".to_owned(),
                    1,
                    vec![json!({
                        "id": "element:page-ref",
                        "type": "rectangle",
                        "version": 2,
                        "versionNonce": 7,
                        "index": "a0",
                        "isDeleted": false,
                        "text": "Native Canvas",
                        "x": 100,
                        "y": 200,
                        "customData": {
                            "type": "nodex-card",
                            "cardId": TARGET_PAGE_BLOCK_ID,
                            "titleHint": "Target"
                        }
                    })],
                ),
            )
            .expect("apply geometry-only Canvas edit");

        seeded
            .kernel
            .readers()
            .read_default(|connection| {
                let (document_head, projection_head, marker_seq, reference_seq):
                    (i64, i64, i64, i64) = connection.query_row(
                        "SELECT document.head_seq, head.projected_head_seq, marker.projected_seq, \
                                reference.projected_seq \
                         FROM documents document \
                         JOIN canvas_scene_projection_heads head ON head.document_id = document.id \
                         JOIN block_search_units marker ON marker.document_id = document.id \
                         JOIN canvas_page_references reference ON reference.document_id = document.id \
                         WHERE document.id = ?1 AND marker.source_kind = 'document_marker'",
                        [DOCUMENT_ID],
                        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                    )?;
                assert_eq!(
                    (document_head, projection_head, marker_seq, reference_seq),
                    (2, 2, 1, 1)
                );
                validate_current_store(connection)
            })
            .expect("incremental Canvas projections remain Store-ready");

        seeded
            .kernel
            .writer()
            .call(|connection| {
                connection.execute(
                    "UPDATE canvas_scene_projection_heads SET projected_head_seq = 1 \
                     WHERE document_id = ?1",
                    [DOCUMENT_ID],
                )?;
                let error = validate_current_store(connection)
                    .expect_err("a stale Canvas collection projection head must fail readiness");
                assert_eq!(error.code, StoreErrorCode::StoreCorrupt);
                assert!(error.message.contains("Document secondary"));
                Ok::<_, StoreError>(())
            })
            .expect("reject stale Canvas projection head");
    }

    #[test]
    #[ignore = "explicit Canvas scale and performance gate"]
    fn canvas_incremental_hot_path_stays_bounded_at_twenty_thousand_elements() {
        const ELEMENT_COUNT: usize = 20_000;
        const SEED_BATCH_SIZE: usize = 500;
        const WARM_EDIT_COUNT: usize = 1_001;

        let seeded = canvas_module();
        seeded
            .module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    operation_id: "canvas:perf:prepare".to_owned(),
                    store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
                    intent: OwnedDocumentIntent::PrepareOwner {
                        owner_block_id: OWNER_BLOCK_ID.to_owned(),
                    },
                },
            )
            .expect("prepare performance Canvas");

        let mut head_seq = 0_i64;
        for (batch_index, start) in (0..ELEMENT_COUNT).step_by(SEED_BATCH_SIZE).enumerate() {
            let end = (start + SEED_BATCH_SIZE).min(ELEMENT_COUNT);
            let elements = (start..end)
                .map(|index| {
                    json!({
                        "id": format!("element:perf:{index:05}"),
                        "type": "rectangle",
                        "version": 1,
                        "versionNonce": index as i64 + 1,
                        "index": format!("a{index:05}"),
                        "isDeleted": false,
                        "x": index,
                        "y": index % 100
                    })
                })
                .collect::<Vec<_>>();
            let applied = seeded
                .module
                .apply(
                    &context(),
                    canvas_geometry_mutation_request(
                        format!("canvas:perf:seed:{batch_index}"),
                        head_seq,
                        elements,
                    ),
                )
                .expect("seed performance Canvas batch");
            head_seq = applied.committed.value.head_seq;
        }
        assert_eq!(head_seq, (ELEMENT_COUNT / SEED_BATCH_SIZE) as i64);

        let page_count_before_edits = seeded
            .kernel
            .readers()
            .read_default(|connection| {
                connection
                    .query_row("PRAGMA page_count", [], |row| row.get::<_, i64>(0))
                    .map_err(StoreError::from)
            })
            .expect("read pre-edit page count");
        seeded
            .kernel
            .writer()
            .call(|_| {
                reset_full_scene_load_count();
                Ok::<_, StoreError>(())
            })
            .expect("reset Canvas materialization counter");

        let mut latest = None;
        for edit_index in 0..WARM_EDIT_COUNT {
            let version = i64::try_from(edit_index).expect("edit index") + 2;
            let applied = seeded
                .module
                .apply(
                    &context(),
                    canvas_geometry_mutation_request(
                        format!("canvas:perf:edit:{edit_index:04}"),
                        head_seq,
                        vec![json!({
                            "id": "element:perf:00123",
                            "type": "rectangle",
                            "version": version,
                            "versionNonce": 50_000 + version,
                            "index": "a00123",
                            "isDeleted": false,
                            "x": 10_000 + version,
                            "y": 23
                        })],
                    ),
                )
                .expect("apply warm Canvas edit");
            head_seq = applied.committed.value.head_seq;
            latest = Some(applied);
        }
        let full_loads = seeded
            .kernel
            .writer()
            .call(|_| Ok::<_, StoreError>(full_scene_load_count()))
            .expect("read Canvas materialization counter");
        assert_eq!(
            full_loads, 0,
            "an active-session geometry edit must not materialize the full scene"
        );

        let latest = latest.expect("warm edit result");
        let latest_canvas = latest
            .committed
            .value
            .canvas
            .as_ref()
            .expect("Canvas commit result");
        assert_eq!(
            latest_canvas["changedElementIds"],
            json!(["element:perf:00123"])
        );
        assert_eq!(
            latest_canvas["committedDelta"]["elementUpdates"]
                .as_array()
                .map(Vec::len),
            Some(1)
        );

        seeded
            .kernel
            .readers()
            .read_default(|connection| {
                let evidence = connection.query_row(
                    "SELECT scene.element_count, \
                            json_extract(element.element_json, '$.version'), \
                            (SELECT count(*) FROM canvas_scene_mutation_receipts \
                             WHERE mutation_id GLOB 'canvas:perf:edit:*'), \
                            (SELECT max(length(common.result_json)) FROM core_module_receipts common \
                             WHERE common.operation_id GLOB 'canvas:perf:edit:*'), \
                            (SELECT max(length(log.payload_json)) FROM change_log log \
                             WHERE log.operation_id GLOB 'canvas:perf:edit:*'), \
                            (SELECT coalesce(sum(receipt.intent_byte_length), 0) \
                             FROM canvas_scene_mutation_receipts receipt \
                             WHERE receipt.mutation_id GLOB 'canvas:perf:edit:*'), \
                            (SELECT count(*) FROM pragma_table_info('canvas_scene_mutation_receipts') \
                             WHERE name IN ('request_json', 'result_json')) \
                     FROM canvas_scenes scene \
                     JOIN canvas_scene_elements element ON element.document_id = scene.document_id \
                     WHERE scene.document_id = ?1 AND element.element_id = 'element:perf:00123'",
                    [DOCUMENT_ID],
                    |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, i64>(1)?,
                            row.get::<_, i64>(2)?,
                            row.get::<_, i64>(3)?,
                            row.get::<_, i64>(4)?,
                            row.get::<_, i64>(5)?,
                            row.get::<_, i64>(6)?,
                        ))
                    },
                )?;
                assert_eq!(evidence.0, ELEMENT_COUNT as i64);
                assert_eq!(evidence.1, WARM_EDIT_COUNT as i64 + 1);
                assert_eq!(evidence.2, WARM_EDIT_COUNT as i64);
                assert!(evidence.3 < 64 * 1024);
                assert!(evidence.4 < 64 * 1024);
                assert!(evidence.5 < 2 * 1024 * 1024);
                assert_eq!(evidence.6, 0);
                let page_count_after =
                    connection.query_row("PRAGMA page_count", [], |row| row.get::<_, i64>(0))?;
                assert!(
                    page_count_after - page_count_before_edits < 5_000,
                    "one-element receipt/event growth exceeded the loose 20 MiB page ceiling"
                );
                Ok::<_, StoreError>(())
            })
            .expect("Canvas performance-contract evidence");
    }

    #[test]
    fn canvas_prepare_sync_merge_and_exact_retry_share_scene_authority() {
        let seeded = canvas_module();
        let prepared = seeded
            .module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    operation_id: "canvas:prepare".to_owned(),
                    store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
                    intent: OwnedDocumentIntent::PrepareOwner {
                        owner_block_id: OWNER_BLOCK_ID.to_owned(),
                    },
                },
            )
            .expect("prepare Canvas");
        assert_eq!(prepared.committed.value.head_seq, 0);
        assert_eq!(
            prepared.committed.value.outcome,
            DocumentCommitOutcome::Committed
        );
        assert!(prepared.events.is_empty());

        let initial = seeded
            .module
            .sync_canvas(&context(), DOCUMENT_ID)
            .expect("initial Canvas sync");
        let initial_scene: Value = serde_json::from_str(&initial.scene_json).expect("scene JSON");
        assert_eq!(initial_scene["elements"], json!([]));
        assert_eq!(initial.scene_hash.len(), 64);

        let request = canvas_mutation_request("canvas:edit:1", 0, 1, "Native Canvas");
        let applied = seeded
            .module
            .apply(&context(), request.clone())
            .expect("Canvas edit");
        assert_eq!(applied.committed.value.head_seq, 1);
        assert_eq!(
            applied.committed.value.outcome,
            DocumentCommitOutcome::Committed
        );
        let canvas_result = applied
            .committed
            .value
            .canvas
            .as_ref()
            .expect("Canvas mutation result");
        assert_eq!(canvas_result["libraryId"], LIBRARY_ID);
        assert_eq!(
            canvas_result["accessContext"],
            json!({ "kind": "project", "projectId": PROJECT_ID })
        );
        assert!(canvas_result.get("projectId").is_none());
        assert!(matches!(
            applied.events.first().map(|event| &event.payload),
            Some(CoreModuleEventPayload::OwnedDocument(
                OwnedDocumentEvent::CanvasUpdated { .. }
            ))
        ));
        let event_log =
            crate::infrastructure::event_log::CoreEventLog::new(seeded.kernel.readers());
        let delivery = event_log
            .authorized_packet(
                applied.committed.commit_seq,
                &context(),
                Some(DOCUMENT_ID),
                false,
            )
            .expect("authorize exact Canvas delivery")
            .expect("Canvas mutation addresses its exact Document");
        assert!(matches!(
            delivery.atoms.as_slice(),
            [nodex_core_contracts::AuthorizedDeliveryAtom {
                payload: nodex_core_contracts::DeliveryAtomPayload::OwnedDocument {
                    event:
                    nodex_core_contracts::AuthorizedOwnedDocumentEvent::CanvasUpdated {
                        document_id,
                        ..
                    },
                    ..
                },
                ..
            }] if document_id == DOCUMENT_ID
        ));
        assert!(
            event_log
                .authorized_packet(
                    applied.committed.commit_seq,
                    &context(),
                    Some("document:unrelated"),
                    false,
                )
                .expect("filter unrelated exact Document delivery")
                .is_none()
        );
        seeded
            .module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    operation_id: "canvas:checkpoint".to_owned(),
                    store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
                    intent: OwnedDocumentIntent::CreateCheckpoint {
                        document_id: DOCUMENT_ID.to_owned(),
                        generation: 1,
                        expected_head_seq: 1,
                        cause: "manual".to_owned(),
                        label: Some("Canvas checkpoint".to_owned()),
                        actor: serde_json::json!({ "kind": "test" }),
                        revision_kind: Some(DocumentRevisionKind::Manual),
                        source_mutation_id: None,
                        source_change_seq: None,
                    },
                },
            )
            .expect("Canvas checkpoint");
        let versions = seeded
            .module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    read: OwnedDocumentRead::ListVersions {
                        document_id: DOCUMENT_ID.to_owned(),
                        before: None,
                        limit: None,
                    },
                },
            )
            .expect("Canvas versions");
        let OwnedDocumentReadValue::Versions { items, .. } = versions.value else {
            panic!("expected Canvas versions")
        };
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["materializationKind"], "canvas_scene");
        let canvas_version_id = items[0]["versionId"]
            .as_str()
            .expect("Canvas version ID")
            .to_owned();

        seeded
            .kernel
            .readers()
            .read_default(|connection| {
                let evidence = connection.query_row(
                    "SELECT document.head_seq, document.state_hash, scene.head_seq, scene.scene_hash, \
                            json_extract(element.element_json, '$.customData.type'), \
                            (SELECT count(*) FROM canvas_page_references WHERE document_id = ?1), \
                            (SELECT count(*) FROM canvas_scene_mutation_receipts WHERE document_id = ?1), \
                            (SELECT count(*) FROM change_log WHERE operation_id = 'canvas:edit:1') \
                     FROM documents document JOIN canvas_scenes scene ON scene.document_id = document.id \
                     JOIN canvas_scene_elements element ON element.document_id = document.id \
                     WHERE document.id = ?1",
                    [DOCUMENT_ID],
                    |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, i64>(2)?,
                            row.get::<_, String>(3)?,
                            row.get::<_, String>(4)?,
                            row.get::<_, i64>(5)?,
                            row.get::<_, i64>(6)?,
                            row.get::<_, i64>(7)?,
                        ))
                    },
                )?;
                assert_eq!(evidence.0, 1);
                assert_eq!(evidence.1, evidence.3);
                assert_eq!(evidence.2, 1);
                assert_eq!(evidence.4, "nodex-card-reference");
                assert_eq!((evidence.5, evidence.6, evidence.7), (1, 1, 1));
                Ok::<_, StoreError>(())
            })
            .expect("Canvas durable evidence");

        let mut retry_context = context_for("renderer-session:recovered");
        retry_context.adapter = AdapterKind::NativeCli;
        let duplicate = seeded
            .module
            .apply(&retry_context, request)
            .expect("Canvas exact retry");
        assert!(duplicate.committed.receipt.mutation.duplicate);
        assert_eq!(
            duplicate.committed.value.canvas.as_ref().unwrap()["duplicate"],
            true
        );
        assert!(duplicate.events.is_empty());

        let stale_merge = seeded
            .module
            .apply(
                &context(),
                canvas_mutation_request("canvas:edit:2", 0, 2, "Merged Canvas"),
            )
            .expect("stale element-clock merge");
        assert_eq!(stale_merge.committed.value.head_seq, 2);
        assert_eq!(
            stale_merge.committed.value.canvas.as_ref().unwrap()["skippedAppStateKeys"],
            json!(["gridSize"])
        );
        assert_eq!(
            stale_merge.committed.value.canvas.as_ref().unwrap()["baseHeadSeq"],
            0
        );
        let Some(CoreModuleEventPayload::OwnedDocument(OwnedDocumentEvent::CanvasUpdated {
            base_head_seq,
            ..
        })) = stale_merge.events.first().map(|event| &event.payload)
        else {
            panic!("stale Canvas merge should publish a durable event")
        };
        assert_eq!(*base_head_seq, 1);
        seeded.module.inject_failure_after_next_commit();
        let interrupted = seeded
            .module
            .apply(
                &context(),
                canvas_mutation_request("canvas:edit:3", 2, 3, "Recovered Canvas"),
            )
            .expect_err("failure after Canvas commit");
        assert_eq!(interrupted.code, CoreErrorCode::CoreUnavailable);
        let recovered = seeded
            .module
            .apply(
                &context(),
                canvas_mutation_request("canvas:edit:3", 2, 3, "Recovered Canvas"),
            )
            .expect("recover Canvas receipt");
        assert_eq!(recovered.committed.value.head_seq, 3);
        assert!(recovered.committed.receipt.mutation.duplicate);
        assert!(recovered.events.is_empty());

        create_canvas_file(&seeded, "canvas-image", b"managed-canvas-asset");
        let image = seeded
            .module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    operation_id: "canvas:image:add".to_owned(),
                    store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
                    intent: OwnedDocumentIntent::ApplyCanvasMutation {
                        document_id: DOCUMENT_ID.to_owned(),
                        generation: 1,
                        expected_head_seq: 3,
                        mutation: json!({
                            "elementCandidates": [{
                                "id": "element:image",
                                "type": "image",
                                "version": 1,
                                "versionNonce": 0,
                                "isDeleted": false,
                                "fileId": "file:image"
                            }],
                            "appStateIntents": {},
                            "fileAdditions": {
                                "file:image": {
                                    "id": "file:image",
                                    "mimeType": "image/png",
                                    "source": "nodex://files/canvas-image",
                                    "fileVersion": 1, "defaultName": "image.png",
                                    "created": 1
                                }
                            }
                        }),
                    },
                },
            )
            .expect("add Canvas image");
        assert_eq!(image.committed.value.head_seq, 4);
        seeded
            .kernel
            .readers()
            .read_default(|connection| {
                let evidence = connection.query_row(
                    "SELECT (SELECT count(*) FROM canvas_scene_files WHERE document_id = ?1), \
                            (SELECT count(*) FROM canvas_scene_file_refs WHERE document_id = ?1), \
                            (SELECT asset_hash FROM canvas_scene_file_refs WHERE document_id = ?1), \
                            (SELECT byte_length FROM canvas_scene_file_refs WHERE document_id = ?1)",
                    [DOCUMENT_ID],
                    |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, i64>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, i64>(3)?,
                        ))
                    },
                )?;
                assert_eq!((evidence.0, evidence.1), (1, 1));
                assert_eq!(evidence.2, sha256(b"managed-canvas-asset"));
                assert_eq!(evidence.3, 20);
                Ok::<_, StoreError>(())
            })
            .expect("Canvas asset evidence");

        let duplicate_image = seeded
            .module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    operation_id: "canvas:image:duplicate-assertion".to_owned(),
                    store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
                    intent: OwnedDocumentIntent::ApplyCanvasMutation {
                        document_id: DOCUMENT_ID.to_owned(),
                        generation: 1,
                        expected_head_seq: 4,
                        mutation: json!({
                            "elementCandidates": [],
                            "appStateIntents": {},
                            "fileAdditions": {
                                "file:image": {
                                    "id": "file:image",
                                    "mimeType": "image/png",
                                    "source": "nodex://files/canvas-image",
                                    "fileVersion": 1, "defaultName": "image.png",
                                    "created": 999
                                }
                            }
                        }),
                    },
                },
            )
            .expect("accept content-identical Canvas file assertion");
        assert_eq!(duplicate_image.committed.value.head_seq, 4);
        assert_eq!(
            duplicate_image.committed.value.outcome,
            DocumentCommitOutcome::NoChange,
        );

        create_canvas_file(&seeded, "canvas-image-conflict", b"different-canvas-asset");
        let conflicting_image = seeded
            .module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    operation_id: "canvas:image:conflicting-assertion".to_owned(),
                    store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
                    intent: OwnedDocumentIntent::ApplyCanvasMutation {
                        document_id: DOCUMENT_ID.to_owned(),
                        generation: 1,
                        expected_head_seq: 4,
                        mutation: json!({
                            "elementCandidates": [],
                            "appStateIntents": {},
                            "fileAdditions": {
                                "file:image": {
                                    "id": "file:image",
                                    "mimeType": "image/png",
                                    "source": "nodex://files/canvas-image-conflict",
                                    "fileVersion": 1, "defaultName": "image.png",
                                    "created": 999
                                }
                            }
                        }),
                    },
                },
            )
            .expect_err("reject content-changing Canvas file assertion");
        assert_eq!(conflicting_image.code, CoreErrorCode::InvalidInput);

        let removed = seeded
            .module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    operation_id: "canvas:image:remove".to_owned(),
                    store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
                    intent: OwnedDocumentIntent::ApplyCanvasMutation {
                        document_id: DOCUMENT_ID.to_owned(),
                        generation: 1,
                        expected_head_seq: 4,
                        mutation: json!({
                            "elementCandidates": [{
                                "id": "element:image",
                                "type": "image",
                                "version": 2,
                                "versionNonce": 0,
                                "isDeleted": true,
                                "fileId": "file:image"
                            }],
                            "appStateIntents": {},
                            "fileAdditions": {}
                        }),
                    },
                },
            )
            .expect("remove Canvas image");
        assert_eq!(removed.committed.value.head_seq, 5);
        assert_eq!(
            removed.committed.value.canvas.as_ref().unwrap()["removedFileIds"],
            json!(["file:image"])
        );
        seeded
            .kernel
            .readers()
            .read_default(|connection| {
                let count: i64 = connection.query_row(
                    "SELECT (SELECT count(*) FROM canvas_scene_files WHERE document_id = ?1) + \
                            (SELECT count(*) FROM canvas_scene_file_refs WHERE document_id = ?1)",
                    [DOCUMENT_ID],
                    |row| row.get(0),
                )?;
                assert_eq!(count, 0);
                Ok::<_, StoreError>(())
            })
            .expect("Canvas asset removed");

        let restored = seeded
            .module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    operation_id: "canvas:restore".to_owned(),
                    store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
                    intent: OwnedDocumentIntent::RestoreVersion {
                        document_id: DOCUMENT_ID.to_owned(),
                        version_id: canvas_version_id.clone(),
                        generation: 1,
                        expected_head_seq: 5,
                        actor: json!({ "kind": "test" }),
                    },
                },
            )
            .expect("restore Canvas version");
        assert_eq!(restored.committed.value.head_seq, 6);
        let restore_effect = restored
            .committed
            .value
            .mutation_effect
            .as_ref()
            .expect("Canvas restore effect");
        assert_eq!(restore_effect.base_head_seq, 5);
        assert_eq!(restore_effect.touched_block_ids, [OWNER_BLOCK_ID]);
        assert_eq!(restore_effect.updated_block_ids, [OWNER_BLOCK_ID]);
        assert_eq!(restore_effect.write_fence_block_ids, [OWNER_BLOCK_ID]);
        assert_eq!(
            restore_effect.coordination,
            DocumentMutationCoordination::WriteFence
        );
        assert!(restored.committed.value.committed_at.is_some());
        assert!(matches!(
            restored.events.first().map(|event| &event.payload),
            Some(CoreModuleEventPayload::OwnedDocument(
                OwnedDocumentEvent::DocumentInvalidated {
                    reason: DocumentInvalidationReason::Restored,
                    ..
                }
            ))
        ));
        let restored_scene = seeded
            .module
            .sync_canvas(&context(), DOCUMENT_ID)
            .expect("restored Canvas sync");
        let restored_scene: Value =
            serde_json::from_str(&restored_scene.scene_json).expect("restored scene");
        assert_eq!(restored_scene["elements"][0]["text"], "Native Canvas");
        let version = seeded
            .module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    read: OwnedDocumentRead::GetVersion {
                        document_id: DOCUMENT_ID.to_owned(),
                        version_id: canvas_version_id,
                    },
                },
            )
            .expect("Canvas version detail");
        let OwnedDocumentReadValue::Version { value } = version.value else {
            panic!("expected Canvas version detail")
        };
        assert_eq!(value["materialization"]["kind"], "canvas_scene");
    }

    #[test]
    fn canvas_scene_access_inherits_its_host_page_grant() {
        const GRANTED_PROJECT_ID: &str = "project:canvas-grantee";
        const HOST_DOCUMENT_ID: &str = "019bf52d-6870-7000-8000-000000000099";
        let seeded = canvas_module();
        seeded
            .kernel
            .writer()
            .call(|connection| {
                with_immediate_transaction(connection, |transaction| {
                    transaction.execute(
                        "INSERT INTO projects(id, library_id, name, created, updated) \
                         VALUES (?1, ?2, 'Canvas grantee', ?3, ?3)",
                        params![GRANTED_PROJECT_ID, LIBRARY_ID, NOW],
                    )?;
                    transaction.execute(
                        "INSERT INTO documents(\
                           id, library_id, generation, head_seq, schema_key, schema_version, \
                           state_vector, state_hash, readiness, authority, created_at, updated_at, sync_engine\
                         ) VALUES (?1, ?2, 1, 0, 'nodex.page', 3, X'', ?3, \
                           'ready', 'ydoc_primary', ?4, ?4, 'yjs')",
                        params![HOST_DOCUMENT_ID, LIBRARY_ID, "", NOW],
                    )?;
                    transaction.execute(
                        "INSERT INTO block_documents(block_id, document_id, library_id, created_at) \
                         VALUES (?1, ?2, ?3, ?4)",
                        params![TARGET_PAGE_BLOCK_ID, HOST_DOCUMENT_ID, LIBRARY_ID, NOW],
                    )?;
                    transaction.execute(
                        "INSERT INTO pages(\
                           block_id, library_id, document_id, parent_kind, parent_id, \
                           created_at, updated_at\
                         ) VALUES (?1, ?2, ?3, 'library', ?2, ?4, ?4)",
                        params![TARGET_PAGE_BLOCK_ID, LIBRARY_ID, HOST_DOCUMENT_ID, NOW],
                    )?;
                    transaction.execute(
                        "INSERT INTO library_block_placements(\
                           block_id, library_id, rank_key, revision, created_at, updated_at\
                         ) VALUES (?1, ?2, '7fffffffffffffffffffffffffffffff', 1, ?3, ?3)",
                        params![TARGET_PAGE_BLOCK_ID, LIBRARY_ID, NOW],
                    )?;
                    transaction.execute(
                        "DELETE FROM library_block_placements \
                         WHERE block_id = ?1 AND library_id = ?2",
                        params![OWNER_BLOCK_ID, LIBRARY_ID],
                    )?;
                    transaction.execute(
                        "UPDATE blocks SET placement_revision = placement_revision + 1, \
                           updated_at = ?1 WHERE id = ?2 AND library_id = ?3",
                        params![NOW, OWNER_BLOCK_ID, LIBRARY_ID],
                    )?;
                    transaction.execute(
                        "INSERT INTO document_block_index(\
                           document_id, block_id, parent_block_id, ordinal, block_type, text, projected_seq\
                         ) VALUES (?1, ?2, NULL, 0, 'canvas', '', 0)",
                        params![HOST_DOCUMENT_ID, OWNER_BLOCK_ID],
                    )?;
                    transaction.execute(
                        "INSERT INTO project_resource_grants(\
                           id, project_id, library_id, root_kind, root_id, access, recursive, \
                           revision, lifecycle, created_at, updated_at\
                         ) VALUES \
                           ('grant:canvas-host-owner', ?1, ?3, 'page', ?4, 'read_write', 1, 1, \
                            'active', ?5, ?5), \
                           ('grant:canvas-host-reader', ?2, ?3, 'page', ?4, 'read', 1, 1, \
                            'active', ?5, ?5)",
                        params![
                            PROJECT_ID,
                            GRANTED_PROJECT_ID,
                            LIBRARY_ID,
                            TARGET_PAGE_BLOCK_ID,
                            NOW,
                        ],
                    )?;
                    Ok(())
                })
            })
            .expect("seed hosted Canvas grant");

        seeded
            .module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    operation_id: "canvas:grantee:prepare".to_owned(),
                    store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
                    intent: OwnedDocumentIntent::PrepareOwner {
                        owner_block_id: OWNER_BLOCK_ID.to_owned(),
                    },
                },
            )
            .expect("prepare hosted Canvas scene");
        let granted = context_for_project("canvas-grantee:read", GRANTED_PROJECT_ID);
        seeded
            .module
            .sync_canvas(&granted, DOCUMENT_ID)
            .expect("read grant opens the hosted Canvas");
        seeded
            .module
            .apply(
                &granted,
                canvas_mutation_request("canvas:grantee:read-denied", 0, 1, "Denied"),
            )
            .expect_err("read grant cannot mutate the hosted Canvas");

        seeded
            .kernel
            .writer()
            .call(|connection| {
                connection.execute(
                    "UPDATE project_resource_grants \
                     SET access = 'read_write', revision = 2 \
                     WHERE id = 'grant:canvas-host-reader'",
                    [],
                )?;
                Ok(())
            })
            .unwrap();
        seeded
            .module
            .apply(
                &context_for_project("canvas-grantee:write", GRANTED_PROJECT_ID),
                canvas_mutation_request("canvas:grantee:write", 0, 1, "Granted"),
            )
            .expect("read-write grant mutates the hosted Canvas");

        seeded
            .kernel
            .writer()
            .call(|connection| {
                with_immediate_transaction(connection, |transaction| {
                    transaction.execute(
                        "DELETE FROM document_block_index WHERE block_id = ?1",
                        [OWNER_BLOCK_ID],
                    )?;
                    transaction.execute(
                        "INSERT INTO library_block_placements(\
                           block_id, library_id, rank_key, revision, created_at, updated_at\
                         ) VALUES (?1, ?2, 'bfffffffffffffffffffffffffffffff', 1, ?3, ?3)",
                        params![OWNER_BLOCK_ID, LIBRARY_ID, NOW],
                    )?;
                    transaction.execute(
                        "UPDATE blocks SET placement_revision = placement_revision + 1, \
                           updated_at = ?1 WHERE id = ?2 AND library_id = ?3",
                        params![NOW, OWNER_BLOCK_ID, LIBRARY_ID],
                    )?;
                    Ok(())
                })
            })
            .unwrap();
        seeded
            .module
            .sync_canvas(
                &context_for_project("canvas-grantee:top-level", GRANTED_PROJECT_ID),
                DOCUMENT_ID,
            )
            .expect_err("foreign Project cannot open a top-level Canvas");
    }

    #[test]
    fn canvas_tombstone_compaction_rotates_generation_with_pinned_history_and_exact_replay() {
        let seeded = canvas_module();
        seeded
            .module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    operation_id: "canvas:compact:prepare".to_owned(),
                    store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
                    intent: OwnedDocumentIntent::PrepareOwner {
                        owner_block_id: OWNER_BLOCK_ID.to_owned(),
                    },
                },
            )
            .expect("prepare Canvas");
        seeded
            .module
            .apply(
                &context(),
                canvas_mutation_request("canvas:compact:create", 0, 1, "Deleted later"),
            )
            .expect("create compacted element");
        seeded
            .module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    operation_id: "canvas:compact:delete".to_owned(),
                    store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
                    intent: OwnedDocumentIntent::ApplyCanvasMutation {
                        document_id: DOCUMENT_ID.to_owned(),
                        generation: 1,
                        expected_head_seq: 1,
                        mutation: json!({
                            "elementCandidates": [{
                                "id": "element:page-ref",
                                "type": "rectangle",
                                "version": 2,
                                "versionNonce": 7,
                                "index": "a0",
                                "isDeleted": true,
                                "text": "Deleted later",
                                "customData": {
                                    "type": "nodex-card",
                                    "cardId": TARGET_PAGE_BLOCK_ID,
                                    "titleHint": "Target"
                                }
                            }],
                            "appStateIntents": {},
                            "fileAdditions": {}
                        }),
                    },
                },
            )
            .expect("delete compacted element");
        seeded
            .kernel
            .writer()
            .call(|_| {
                reset_full_scene_load_count();
                Ok::<_, StoreError>(())
            })
            .expect("reset Canvas materialization counter");
        let eligibility = seeded
            .module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    read: OwnedDocumentRead::CanvasCompactionEligibility {
                        document_id: DOCUMENT_ID.to_owned(),
                    },
                },
            )
            .expect("read Canvas compaction eligibility");
        let OwnedDocumentReadValue::CanvasCompactionEligibility { stats } = eligibility.value
        else {
            panic!("expected Canvas compaction eligibility")
        };
        assert_eq!(stats.generation, 1);
        assert_eq!(stats.head_seq, 2);
        assert_eq!(stats.tombstone_count, 1);
        assert!(stats.tombstone_bytes > 0);
        assert!(!stats.eligible);
        let eligibility_full_loads = seeded
            .kernel
            .writer()
            .call(|_| Ok::<_, StoreError>(full_scene_load_count()))
            .expect("read Canvas materialization counter");
        assert_eq!(
            eligibility_full_loads, 0,
            "maintenance eligibility must read only persisted Canvas counters"
        );

        let request = ModuleApplyRequest {
            contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
            operation_id: "canvas:compact:apply".to_owned(),
            store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
            intent: OwnedDocumentIntent::CompactCanvasTombstones {
                document_id: DOCUMENT_ID.to_owned(),
                generation: 1,
                expected_head_seq: 2,
                actor: json!({ "kind": "test" }),
            },
        };
        let compacted = seeded
            .module
            .apply(&context(), request.clone())
            .expect("compact Canvas tombstones");
        assert_eq!(compacted.committed.value.generation, 2);
        assert_eq!(compacted.committed.value.head_seq, 1);
        assert_eq!(
            compacted.committed.value.outcome,
            DocumentCommitOutcome::Committed
        );
        assert!(matches!(
            compacted.events.first().map(|event| &event.payload),
            Some(CoreModuleEventPayload::OwnedDocument(
                OwnedDocumentEvent::CanvasGenerationChanged {
                    previous_generation: 1,
                    previous_head_seq: 2,
                    generation: 2,
                    head_seq: 1,
                    ..
                }
            ))
        ));
        let replay = seeded
            .module
            .apply(
                &context_for_project("connection:compaction-retry", PROJECT_ID),
                request,
            )
            .expect("replay committed Canvas compaction");
        assert!(replay.committed.receipt.mutation.duplicate);
        assert_eq!(replay.committed.value.generation, 2);
        assert!(replay.events.is_empty());

        seeded
            .kernel
            .readers()
            .read_default(|connection| {
                let evidence = connection.query_row(
                    "SELECT document.generation, document.head_seq, scene.generation, \
                            scene.head_seq, scene.element_count, scene.tombstone_count, \
                            projection.generation, projection.projected_head_seq, \
                            (SELECT count(*) FROM canvas_scene_elements WHERE document_id = ?1), \
                            (SELECT count(*) FROM document_versions \
                             WHERE document_id = ?1 AND cause = 'canvas_tombstone_compaction' \
                               AND revision_kind = 'safety' AND pinned = 1) \
                     FROM documents document \
                     JOIN canvas_scenes scene ON scene.document_id = document.id \
                     JOIN canvas_scene_projection_heads projection \
                       ON projection.document_id = document.id \
                     WHERE document.id = ?1",
                    [DOCUMENT_ID],
                    |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, i64>(1)?,
                            row.get::<_, i64>(2)?,
                            row.get::<_, i64>(3)?,
                            row.get::<_, i64>(4)?,
                            row.get::<_, i64>(5)?,
                            row.get::<_, i64>(6)?,
                            row.get::<_, i64>(7)?,
                            row.get::<_, i64>(8)?,
                            row.get::<_, i64>(9)?,
                        ))
                    },
                )?;
                assert_eq!(evidence, (2, 1, 2, 1, 0, 0, 2, 1, 0, 1));
                let checkpoint: Vec<u8> = connection.query_row(
                    "SELECT full_update_blob FROM document_versions \
                     WHERE document_id = ?1 AND cause = 'canvas_tombstone_compaction'",
                    [DOCUMENT_ID],
                    |row| row.get(0),
                )?;
                let checkpoint: Value =
                    serde_json::from_slice(&checkpoint).expect("Canvas compaction checkpoint");
                assert_eq!(checkpoint["elements"][0]["isDeleted"], true);
                Ok::<_, StoreError>(())
            })
            .expect("validate compacted Canvas authority");
        let synced = seeded
            .module
            .sync_canvas(&context(), DOCUMENT_ID)
            .expect("sync compacted Canvas");
        assert_eq!(synced.generation, 2);
        assert_eq!(synced.head_seq, 1);
        let scene: Value = serde_json::from_str(&synced.scene_json).expect("compacted scene");
        assert_eq!(scene["elements"], json!([]));

        let no_change = seeded
            .module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    operation_id: "canvas:compact:no-change".to_owned(),
                    store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
                    intent: OwnedDocumentIntent::CompactCanvasTombstones {
                        document_id: DOCUMENT_ID.to_owned(),
                        generation: 2,
                        expected_head_seq: 1,
                        actor: json!({ "kind": "test" }),
                    },
                },
            )
            .expect("no-op Canvas compaction");
        assert_eq!(
            no_change.committed.value.outcome,
            DocumentCommitOutcome::NoChange
        );
        assert_eq!(no_change.committed.value.generation, 2);
        assert_eq!(no_change.committed.value.head_seq, 1);
        assert!(no_change.events.is_empty());

        let stale = seeded
            .module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    operation_id: "canvas:compact:stale".to_owned(),
                    store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
                    intent: OwnedDocumentIntent::CompactCanvasTombstones {
                        document_id: DOCUMENT_ID.to_owned(),
                        generation: 1,
                        expected_head_seq: 2,
                        actor: json!({ "kind": "test" }),
                    },
                },
            )
            .expect_err("old-generation compaction must fail");
        assert_eq!(stale.code, CoreErrorCode::GenerationConflict);
    }

    #[test]
    fn owner_commands_create_retry_delete_and_replay_without_losing_history() {
        let seeded = empty_project_module();
        let create = owner_request(
            "owner:create-synced",
            DocumentOwnerCommand::CreateSyncedSource {
                source_block_id: CREATED_SOURCE_BLOCK_ID.to_owned(),
                document_id: CREATED_SOURCE_DOCUMENT_ID.to_owned(),
                initial_blocks: vec![paragraph(CREATED_CONTENT_BLOCK_ID, "Shared body")],
                before: None,
            },
        );
        let created = seeded
            .module
            .apply(&context(), create.clone())
            .expect("create Synced Block source");
        assert_eq!(created.committed.value.head_seq, 1);
        assert!(created.committed.value.committed_at.is_some());
        assert_eq!(created.events.len(), 1);
        assert_eq!(
            created
                .committed
                .value
                .owner_effect
                .as_ref()
                .expect("owner effect")
                .created_block_ids,
            vec![
                CREATED_SOURCE_BLOCK_ID.to_owned(),
                CREATED_CONTENT_BLOCK_ID.to_owned(),
            ]
        );

        let mut reconnected_context = context();
        reconnected_context.connection_id = "connection:reconnected".to_owned();
        let duplicate = seeded
            .module
            .apply(&reconnected_context, create)
            .expect("exact owner retry");
        assert!(duplicate.committed.receipt.mutation.duplicate);
        assert!(duplicate.events.is_empty());
        assert_eq!(
            duplicate.committed.value.committed_at,
            created.committed.value.committed_at
        );

        seeded
            .kernel
            .readers()
            .read_default(|connection| {
                let evidence = connection.query_row(
                    "SELECT document.readiness, document.authority, document.head_seq, \
                            owner.lifecycle, child.lifecycle, child_placement.document_id, \
                            (SELECT count(*) FROM document_snapshots WHERE document_id = ?1), \
                            (SELECT count(*) FROM document_updates WHERE document_id = ?1), \
                            (SELECT count(*) FROM core_module_receipts \
                              WHERE module_name = 'owned_document' AND operation_id = ?2) \
                     FROM documents document \
                     JOIN block_documents ownership ON ownership.document_id = document.id \
                     JOIN blocks owner ON owner.id = ownership.block_id \
                     JOIN blocks child ON child.id = ?3 \
                     JOIN document_block_index child_placement \
                       ON child_placement.block_id = child.id \
                      AND child_placement.document_id = document.id \
                     WHERE document.id = ?1",
                    params![
                        CREATED_SOURCE_DOCUMENT_ID,
                        "owner:create-synced",
                        CREATED_CONTENT_BLOCK_ID,
                    ],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, i64>(2)?,
                            row.get::<_, String>(3)?,
                            row.get::<_, String>(4)?,
                            row.get::<_, String>(5)?,
                            row.get::<_, i64>(6)?,
                            row.get::<_, i64>(7)?,
                            row.get::<_, i64>(8)?,
                        ))
                    },
                )?;
                assert_eq!(
                    evidence,
                    (
                        "ready".to_owned(),
                        "ydoc_primary".to_owned(),
                        1,
                        "active".to_owned(),
                        "active".to_owned(),
                        CREATED_SOURCE_DOCUMENT_ID.to_owned(),
                        1,
                        1,
                        1,
                    )
                );
                Ok::<_, StoreError>(())
            })
            .expect("created owner evidence");

        let delete = owner_request(
            "owner:delete-synced",
            DocumentOwnerCommand::DeleteOwnedSource {
                owner_kind: DeletableOwnedSourceKind::SyncedBlock,
                owner: DocumentOwnerRevision {
                    owner_block_id: CREATED_SOURCE_BLOCK_ID.to_owned(),
                    document_id: CREATED_SOURCE_DOCUMENT_ID.to_owned(),
                    generation: 1,
                    head_seq: 1,
                    metadata_revision: 1,
                    location_revision: 1,
                },
            },
        );
        let deleted = seeded
            .module
            .apply(&context(), delete.clone())
            .expect("delete unreferenced source");
        assert_eq!(deleted.events.len(), 1);
        assert!(matches!(
            &deleted.events[0].payload,
            CoreModuleEventPayload::OwnedDocument(OwnedDocumentEvent::DocumentInvalidated {
                reason: DocumentInvalidationReason::AccessChanged,
                ..
            })
        ));
        let mut renewed_delete = delete;
        let OwnedDocumentIntent::ApplyOwnerCommand {
            command: DocumentOwnerCommand::DeleteOwnedSource { owner, .. },
        } = &mut renewed_delete.intent
        else {
            panic!("expected delete owner command")
        };
        owner.head_seq = 99;
        let delete_retry = seeded
            .module
            .apply(&context(), renewed_delete)
            .expect("delete retry with renewed execution head");
        assert!(delete_retry.committed.receipt.mutation.duplicate);
        assert!(delete_retry.events.is_empty());

        seeded
            .kernel
            .readers()
            .read_default(|connection| {
                let evidence = connection.query_row(
                    "SELECT owner.lifecycle, child.lifecycle, document.head_seq, \
                            (SELECT count(*) FROM document_snapshots WHERE document_id = ?1), \
                            (SELECT count(*) FROM document_updates WHERE document_id = ?1), \
                            (SELECT count(*) FROM document_materializations WHERE document_id = ?1) \
                     FROM documents document \
                     JOIN block_documents ownership ON ownership.document_id = document.id \
                     JOIN blocks owner ON owner.id = ownership.block_id \
                     JOIN blocks child ON child.id = ?2 \
                     WHERE document.id = ?1",
                    params![CREATED_SOURCE_DOCUMENT_ID, CREATED_CONTENT_BLOCK_ID],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, i64>(2)?,
                            row.get::<_, i64>(3)?,
                            row.get::<_, i64>(4)?,
                            row.get::<_, i64>(5)?,
                        ))
                    },
                )?;
                assert_eq!(
                    evidence,
                    ("deleted".to_owned(), "deleted".to_owned(), 1, 1, 1, 1)
                );
                Ok::<_, StoreError>(())
            })
            .expect("retained source evidence");
    }

    #[test]
    fn owner_command_failure_rolls_back_staged_identity_and_receipt() {
        let seeded = empty_project_module();
        let error = seeded
            .module
            .apply(
                &context(),
                owner_request(
                    "owner:invalid-create",
                    DocumentOwnerCommand::CreateSyncedSource {
                        source_block_id: CREATED_SOURCE_BLOCK_ID.to_owned(),
                        document_id: CREATED_SOURCE_DOCUMENT_ID.to_owned(),
                        initial_blocks: vec![json!({
                            "id": CREATED_CONTENT_BLOCK_ID,
                            "type": "page",
                            "props": {},
                            "children": [],
                        })],
                        before: None,
                    },
                ),
            )
            .expect_err("typed Page cannot enter a Synced Block genesis");
        assert_eq!(error.code, CoreErrorCode::ProtectedOwnerDeletion);
        seeded
            .kernel
            .readers()
            .read_default(|connection| {
                let evidence = connection.query_row(
                    "SELECT (SELECT count(*) FROM blocks WHERE id IN (?1, ?2)), \
                            (SELECT count(*) FROM documents WHERE id = ?3), \
                            (SELECT count(*) FROM core_module_receipts WHERE operation_id = ?4)",
                    params![
                        CREATED_SOURCE_BLOCK_ID,
                        CREATED_CONTENT_BLOCK_ID,
                        CREATED_SOURCE_DOCUMENT_ID,
                        "owner:invalid-create",
                    ],
                    |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, i64>(1)?,
                            row.get::<_, i64>(2)?,
                        ))
                    },
                )?;
                assert_eq!(evidence, (0, 0, 0));
                Ok::<_, StoreError>(())
            })
            .expect("rollback evidence");
    }

    #[test]
    fn owner_command_retry_recovers_commit_lost_before_publication() {
        let seeded = empty_project_module();
        let request = owner_request(
            "owner:create-postcommit",
            DocumentOwnerCommand::CreateSyncedSource {
                source_block_id: CREATED_SOURCE_BLOCK_ID.to_owned(),
                document_id: CREATED_SOURCE_DOCUMENT_ID.to_owned(),
                initial_blocks: vec![paragraph(CREATED_CONTENT_BLOCK_ID, "Recovered")],
                before: None,
            },
        );
        seeded.module.inject_failure_after_next_commit();
        let failure = seeded
            .module
            .apply(&context(), request.clone())
            .expect_err("injected post-commit failure");
        assert_eq!(failure.code, CoreErrorCode::CoreUnavailable);

        let recovered = seeded
            .module
            .apply(&context(), request)
            .expect("recover durable owner receipt");
        assert!(recovered.committed.receipt.mutation.duplicate);
        assert!(recovered.events.is_empty());
        assert_eq!(recovered.committed.value.head_seq, 1);
    }

    #[test]
    fn template_instantiation_copies_fresh_ids_into_an_exact_target_head() {
        const TEMPLATE_GRANTEE_PROJECT_ID: &str = "project:template-grantee";
        let seeded = seeded_module();
        let created = seeded
            .module
            .apply(
                &context(),
                owner_request(
                    "owner:create-template",
                    DocumentOwnerCommand::CreateTemplate {
                        source_block_id: CREATED_TEMPLATE_BLOCK_ID.to_owned(),
                        document_id: CREATED_TEMPLATE_DOCUMENT_ID.to_owned(),
                        display_name: "Meeting note".to_owned(),
                        initial_blocks: vec![paragraph(
                            CREATED_TEMPLATE_CONTENT_ID,
                            "Template body",
                        )],
                        before: None,
                    },
                ),
            )
            .expect("create Reusable Template");
        assert_eq!(created.committed.value.head_seq, 1);
        seeded
            .kernel
            .writer()
            .call(|connection| {
                connection.execute(
                    "INSERT INTO projects(id, library_id, name, created, updated) \
                     VALUES (?1, ?2, 'Template grantee', ?3, ?3)",
                    params![TEMPLATE_GRANTEE_PROJECT_ID, LIBRARY_ID, NOW],
                )?;
                connection.execute(
                    "INSERT INTO project_resource_grants(\
                       id, project_id, library_id, root_kind, root_id, access, recursive, \
                       revision, lifecycle, created_at, updated_at\
                     ) VALUES ('grant:template-target', ?1, ?2, 'page', ?3, \
                       'read', 1, 1, 'active', ?4, ?4)",
                    params![TEMPLATE_GRANTEE_PROJECT_ID, LIBRARY_ID, OWNER_BLOCK_ID, NOW],
                )?;
                Ok(())
            })
            .expect("grant a second Project the template target Page");
        let instantiated = seeded
            .module
            .apply(
                &context(),
                owner_request(
                    "owner:instantiate-template",
                    DocumentOwnerCommand::InstantiateTemplate {
                        source_block_id: CREATED_TEMPLATE_BLOCK_ID.to_owned(),
                        source: DocumentHeadRevision {
                            document_id: CREATED_TEMPLATE_DOCUMENT_ID.to_owned(),
                            generation: 1,
                            head_seq: 1,
                        },
                        target: DocumentHeadRevision {
                            document_id: DOCUMENT_ID.to_owned(),
                            generation: 1,
                            head_seq: 1,
                        },
                        parent_block_id: None,
                        before_block_id: None,
                    },
                ),
            )
            .expect("instantiate Reusable Template");
        let effect = instantiated
            .committed
            .value
            .owner_effect
            .as_ref()
            .expect("template effect");
        assert_eq!(effect.created_block_ids.len(), 1);
        assert_ne!(effect.created_block_ids[0], CREATED_TEMPLATE_CONTENT_ID);
        assert_eq!(instantiated.committed.value.head_seq, 2);
        assert_eq!(instantiated.events.len(), 1);
        let manifest = seeded
            .kernel
            .readers()
            .read_default(|connection| {
                crate::infrastructure::local_commit::read_manifest(
                    connection,
                    instantiated.committed.commit_seq,
                )
            })
            .expect("template instantiation CommitManifest");
        for project_id in [PROJECT_ID, TEMPLATE_GRANTEE_PROJECT_ID] {
            assert!(manifest.projection_effects.iter().any(|effect| {
                matches!(
                    &effect.scope.scope,
                    nodex_core_contracts::LocalProjectionScope::Page {
                        project_id: effect_project_id,
                        page_id,
                    } if effect_project_id == project_id && page_id == OWNER_BLOCK_ID
                )
            }));
        }
        assert!(!manifest.projection_effects.iter().any(|effect| {
            matches!(
                &effect.scope.scope,
                nodex_core_contracts::LocalProjectionScope::Project { .. }
            )
        }));

        seeded
            .kernel
            .readers()
            .read_default(|connection| {
                let copied_document = connection.query_row(
                    "SELECT document_id FROM document_block_index WHERE block_id = ?1",
                    [&effect.created_block_ids[0]],
                    |row| row.get::<_, String>(0),
                )?;
                let source_document = connection.query_row(
                    "SELECT document_id FROM document_block_index WHERE block_id = ?1",
                    [CREATED_TEMPLATE_CONTENT_ID],
                    |row| row.get::<_, String>(0),
                )?;
                assert_eq!(copied_document, DOCUMENT_ID);
                assert_eq!(source_document, CREATED_TEMPLATE_DOCUMENT_ID);
                Ok::<_, StoreError>(())
            })
            .expect("template copy identities");
    }

    #[test]
    fn synced_promotion_and_demotion_preserve_content_identity_atomically() {
        let seeded = seeded_module();
        let root_block_id = seeded
            .kernel
            .readers()
            .read_default(|connection| {
                let tree = connection.query_row(
                    "SELECT block_tree_json FROM document_materializations WHERE document_id = ?1",
                    [DOCUMENT_ID],
                    |row| row.get::<_, String>(0),
                )?;
                let tree = serde_json::from_str::<Value>(&tree)
                    .map_err(|_| internal("test Block tree"))?;
                tree.as_array()
                    .and_then(|blocks| blocks.first())
                    .and_then(|block| block.get("id"))
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .ok_or_else(|| internal("test root Block"))
            })
            .expect("host root Block");
        let promoted = seeded
            .module
            .apply(
                &context(),
                owner_request(
                    "owner:promote-synced",
                    DocumentOwnerCommand::PromoteSyncedSource {
                        host: DocumentHeadRevision {
                            document_id: DOCUMENT_ID.to_owned(),
                            generation: 1,
                            head_seq: 1,
                        },
                        root_block_id: root_block_id.clone(),
                        reference_block_id: CREATED_REFERENCE_BLOCK_ID.to_owned(),
                        source_block_id: CREATED_SOURCE_BLOCK_ID.to_owned(),
                        source_document_id: CREATED_SOURCE_DOCUMENT_ID.to_owned(),
                    },
                ),
            )
            .expect("promote Page root to Synced Block source");
        assert_eq!(promoted.committed.value.head_seq, 2);
        assert_eq!(promoted.events.len(), 2);
        seeded
            .module
            .apply(
                &context(),
                owner_request(
                    "owner:delete-referenced-synced",
                    DocumentOwnerCommand::DeleteOwnedSource {
                        owner_kind: DeletableOwnedSourceKind::SyncedBlock,
                        owner: DocumentOwnerRevision {
                            owner_block_id: CREATED_SOURCE_BLOCK_ID.to_owned(),
                            document_id: CREATED_SOURCE_DOCUMENT_ID.to_owned(),
                            generation: 1,
                            head_seq: 1,
                            metadata_revision: 1,
                            location_revision: 1,
                        },
                    },
                ),
            )
            .expect_err("referenced Synced Block source cannot be deleted");
        let demoted = seeded
            .module
            .apply(
                &context(),
                owner_request(
                    "owner:demote-synced",
                    DocumentOwnerCommand::DemoteSyncedSource {
                        host: DocumentHeadRevision {
                            document_id: DOCUMENT_ID.to_owned(),
                            generation: 1,
                            head_seq: 2,
                        },
                        source: DocumentHeadRevision {
                            document_id: CREATED_SOURCE_DOCUMENT_ID.to_owned(),
                            generation: 1,
                            head_seq: 1,
                        },
                        reference_block_id: CREATED_REFERENCE_BLOCK_ID.to_owned(),
                        source_block_id: CREATED_SOURCE_BLOCK_ID.to_owned(),
                    },
                ),
            )
            .expect("demote sole Synced Block instance");
        assert_eq!(demoted.committed.value.head_seq, 4);
        assert_eq!(demoted.events.len(), 4);
        let effect = demoted
            .committed
            .value
            .owner_effect
            .as_ref()
            .expect("demotion effect");
        assert!(effect.preserved_block_ids.contains(&root_block_id));

        seeded
            .kernel
            .readers()
            .read_default(|connection| {
                let evidence = connection.query_row(
                    "SELECT root.lifecycle, root_placement.document_id, source.lifecycle, \
                            reference.lifecycle, host.head_seq, source_document.head_seq, \
                            (SELECT count(*) FROM document_snapshots \
                              WHERE document_id = source_document.id) \
                     FROM blocks root \
                     JOIN blocks source ON source.id = ?2 \
                     JOIN blocks reference ON reference.id = ?3 \
                     JOIN documents host ON host.id = ?4 \
                     JOIN document_block_index root_placement \
                       ON root_placement.block_id = root.id \
                      AND root_placement.document_id = host.id \
                     JOIN documents source_document ON source_document.id = ?5 \
                     WHERE root.id = ?1",
                    params![
                        root_block_id,
                        CREATED_SOURCE_BLOCK_ID,
                        CREATED_REFERENCE_BLOCK_ID,
                        DOCUMENT_ID,
                        CREATED_SOURCE_DOCUMENT_ID,
                    ],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, String>(3)?,
                            row.get::<_, i64>(4)?,
                            row.get::<_, i64>(5)?,
                            row.get::<_, i64>(6)?,
                        ))
                    },
                )?;
                assert_eq!(
                    evidence,
                    (
                        "active".to_owned(),
                        DOCUMENT_ID.to_owned(),
                        "deleted".to_owned(),
                        "deleted".to_owned(),
                        4,
                        2,
                        1,
                    )
                );
                Ok::<_, StoreError>(())
            })
            .expect("demotion identity evidence");
    }

    #[test]
    fn prepare_owner_commits_registered_genesis_once() {
        for (owner_type, schema_key, schema_version) in [
            ("page", "nodex.page", 3),
            ("synced_block_source", "nodex.synced-block", 2),
            ("reusable_template_source", "nodex.reusable-template", 2),
        ] {
            let seeded = pending_module(owner_type, schema_key, schema_version);
            let request = ModuleApplyRequest {
                contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                operation_id: format!("prepare:{owner_type}"),
                store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
                intent: OwnedDocumentIntent::PrepareOwner {
                    owner_block_id: OWNER_BLOCK_ID.to_owned(),
                },
            };
            let prepared = seeded
                .module
                .apply(&context(), request.clone())
                .expect("prepare pending owner");
            assert_eq!(prepared.committed.value.head_seq, 1);
            assert_eq!(
                prepared.committed.value.outcome,
                DocumentCommitOutcome::Committed
            );
            assert!(!prepared.events.is_empty());

            seeded
                .kernel
                .readers()
                .read_default(|connection| {
                    let evidence = connection.query_row(
                        "SELECT document.readiness, document.authority, document.head_seq, \
                                materialization.projected_seq, \
                                json_array_length(materialization.block_tree_json), \
                                (SELECT count(*) FROM document_updates WHERE document_id = ?1), \
                                (SELECT count(*) FROM document_snapshots WHERE document_id = ?1), \
                                (SELECT count(*) FROM document_update_receipts WHERE document_id = ?1), \
                                (SELECT count(*) FROM change_log WHERE operation_id = ?2) \
                         FROM documents document JOIN document_materializations materialization \
                           ON materialization.document_id = document.id WHERE document.id = ?1",
                        params![DOCUMENT_ID, format!("prepare:{owner_type}")],
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
                                row.get::<_, i64>(8)?,
                            ))
                        },
                    )?;
                    assert_eq!(
                        evidence,
                        (
                            "ready".to_owned(),
                            "ydoc_primary".to_owned(),
                            1,
                            1,
                            1,
                            1,
                            1,
                            1,
                            1,
                        )
                    );
                    Ok::<_, StoreError>(())
                })
                .expect("genesis evidence");

            let duplicate = seeded
                .module
                .apply(&context(), request)
                .expect("exact prepare retry");
            assert!(duplicate.committed.receipt.mutation.duplicate);
            assert!(duplicate.events.is_empty());

            let no_change = seeded
                .module
                .apply(
                    &context(),
                    ModuleApplyRequest {
                        contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                        operation_id: format!("prepare-again:{owner_type}"),
                        store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
                        intent: OwnedDocumentIntent::PrepareOwner {
                            owner_block_id: OWNER_BLOCK_ID.to_owned(),
                        },
                    },
                )
                .expect("already editable owner");
            assert_eq!(
                no_change.committed.value.outcome,
                DocumentCommitOutcome::NoChange
            );
            assert!(no_change.events.is_empty());
        }
    }

    #[test]
    fn sync_apply_and_exact_retry_share_one_durable_authority() {
        let seeded = seeded_module();
        let sync = seeded
            .module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    read: OwnedDocumentRead::SyncYjs {
                        document_id: DOCUMENT_ID.to_owned(),
                        state_vector: Vec::new(),
                        history_after_head_seq: None,
                    },
                },
            )
            .expect("Yjs sync");
        let OwnedDocumentReadValue::YjsSync { update, .. } = sync.value else {
            panic!("expected Yjs sync")
        };
        let synced = YrsDocumentEngine::from_full_state_v1(DOCUMENT_ID, &update)
            .expect("sync update is Yjs-compatible");
        assert!(synced.state_vector_equals_v1(&seeded.state_vector).unwrap());

        let update = title_update(&seeded.full_state, &seeded.state_vector, "Native Rust edit");
        let request = apply_request("update:native-title", 1, update.clone());
        let applied = seeded
            .module
            .apply(&context(), request.clone())
            .expect("Yjs apply");
        assert_eq!(applied.committed.value.head_seq, 2);
        assert_eq!(
            applied.committed.value.outcome,
            DocumentCommitOutcome::Committed
        );
        assert!(!applied.events.is_empty());
        assert!(!applied.committed.receipt.mutation.duplicate);
        let event_json =
            serde_json::to_value(&applied.events[0].payload).expect("Document event JSON");
        assert!(event_json["event"].get("page_impact").is_none());
        for projection_field in ["title", "summary", "propertyValues", "page"] {
            assert!(event_json["event"].get(projection_field).is_none());
        }
        seeded
            .kernel
            .readers()
            .read_default(|connection| {
                let evidence = connection.query_row(
                    "SELECT document.head_seq, materialization.title, \
                            (SELECT count(*) FROM document_update_receipts WHERE update_id = ?1), \
                            (SELECT count(*) FROM core_module_receipts WHERE operation_id = ?1), \
                            (SELECT count(*) FROM change_log WHERE operation_id = ?1) \
                     FROM documents document \
                     JOIN document_materializations materialization ON materialization.document_id = document.id \
                     WHERE document.id = ?2",
                    params!["update:native-title", DOCUMENT_ID],
                    |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, i64>(2)?,
                            row.get::<_, i64>(3)?,
                            row.get::<_, i64>(4)?,
                        ))
                    },
                )?;
                assert_eq!(evidence, (2, "Native Rust edit".to_owned(), 1, 1, 1));
                let fts: i64 = connection.query_row(
                    "SELECT count(*) FROM block_search_units_fts \
                     WHERE block_search_units_fts MATCH 'Native'",
                    [],
                    |row| row.get(0),
                )?;
                assert!(fts > 0);
                Ok::<_, StoreError>(())
            })
            .expect("durable evidence");

        let duplicate = seeded
            .module
            .apply(&context(), request)
            .expect("exact retry");
        assert!(duplicate.committed.receipt.mutation.duplicate);
        assert!(duplicate.events.is_empty());
        assert_eq!(
            duplicate.committed.event_sequence,
            applied.committed.event_sequence
        );
        assert!(seeded.module.cache_metrics().expect("cache metrics").hits > 0);
    }

    #[test]
    fn raw_yjs_parent_changes_derive_placement_without_renderer_metadata() {
        let seeded = seeded_module();
        let original_root_id = seeded
            .kernel
            .readers()
            .read_default(|connection| {
                connection
                    .query_row(
                        "SELECT block_id FROM document_block_index \
                         WHERE document_id = ?1 AND parent_block_id IS NULL \
                         ORDER BY ordinal LIMIT 1",
                        [DOCUMENT_ID],
                        |row| row.get::<_, String>(0),
                    )
                    .map_err(StoreError::from)
            })
            .expect("seed root");
        let indented_block_id = "019bf52d-6870-7000-8000-000000000120";
        let sibling_block_id = "019bf52d-6870-7000-8000-000000000121";
        seeded
            .module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    operation_id: "document-operation:seed-indent".to_owned(),
                    store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
                    intent: OwnedDocumentIntent::ApplyOperationBatch {
                        document_id: DOCUMENT_ID.to_owned(),
                        generation: 1,
                        expected_head_seq: 1,
                        operations: vec![
                            ContractDocumentBlockOperation::InsertBlock {
                                block: paragraph(indented_block_id, "Indent me"),
                                parent_block_id: None,
                                before_block_id: None,
                            },
                            ContractDocumentBlockOperation::InsertBlock {
                                block: paragraph(sibling_block_id, "Keep me stable"),
                                parent_block_id: None,
                                before_block_id: None,
                            },
                        ],
                        actor: json!({ "kind": "test" }),
                    },
                },
            )
            .expect("seed sibling roots");

        let (head_seq, engine) = synced_page_engine(&seeded);
        let indent_update = raw_document_operation_update(
            &engine,
            &[DocumentBlockOperation::MoveBlock {
                block_id: indented_block_id.to_owned(),
                parent_block_id: Some(original_root_id.clone()),
                before_block_id: None,
            }],
        );
        let indented = seeded
            .module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    operation_id: "update:raw-indent".to_owned(),
                    store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
                    intent: OwnedDocumentIntent::ApplyYjsUpdate {
                        document_id: DOCUMENT_ID.to_owned(),
                        generation: 1,
                        base_head_seq: head_seq,
                        update_id: "update:raw-indent".to_owned(),
                        touched_block_ids: Vec::new(),
                        update: indent_update,
                    },
                },
            )
            .expect("raw collaborative indent");
        assert_eq!(indented.committed.value.head_seq, head_seq + 1);

        seeded
            .kernel
            .readers()
            .read_default(|connection| {
                let placement = connection.query_row(
                    "SELECT entry.parent_block_id, moved.placement_revision, \
                            parent.placement_revision, sibling.placement_revision \
                     FROM document_block_index entry \
                     JOIN blocks moved ON moved.id = entry.block_id \
                     JOIN blocks parent ON parent.id = ?2 \
                     JOIN blocks sibling ON sibling.id = ?3 \
                     WHERE entry.document_id = ?1 AND entry.block_id = ?4",
                    params![
                        DOCUMENT_ID,
                        original_root_id,
                        sibling_block_id,
                        indented_block_id,
                    ],
                    |row| {
                        Ok((
                            row.get::<_, Option<String>>(0)?,
                            row.get::<_, i64>(1)?,
                            row.get::<_, i64>(2)?,
                            row.get::<_, i64>(3)?,
                        ))
                    },
                )?;
                assert_eq!(
                    placement,
                    (Some(original_root_id.clone()), 2, 1, 1),
                    "only the Block whose logical parent changed advances placement CAS",
                );
                Ok::<_, StoreError>(())
            })
            .expect("persisted indent placement");

        let (head_seq, engine) = synced_page_engine(&seeded);
        let outdent_update = raw_document_operation_update(
            &engine,
            &[DocumentBlockOperation::MoveBlock {
                block_id: indented_block_id.to_owned(),
                parent_block_id: None,
                before_block_id: Some(sibling_block_id.to_owned()),
            }],
        );
        seeded
            .module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    operation_id: "update:raw-outdent".to_owned(),
                    store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
                    intent: OwnedDocumentIntent::ApplyYjsUpdate {
                        document_id: DOCUMENT_ID.to_owned(),
                        generation: 1,
                        base_head_seq: head_seq,
                        update_id: "update:raw-outdent".to_owned(),
                        touched_block_ids: Vec::new(),
                        update: outdent_update,
                    },
                },
            )
            .expect("raw collaborative outdent");
        seeded
            .kernel
            .readers()
            .read_default(|connection| {
                let placement = connection.query_row(
                    "SELECT entry.parent_block_id, moved.placement_revision, \
                            sibling.placement_revision \
                     FROM document_block_index entry \
                     JOIN blocks moved ON moved.id = entry.block_id \
                     JOIN blocks sibling ON sibling.id = ?2 \
                     WHERE entry.document_id = ?1 AND entry.block_id = ?3",
                    params![DOCUMENT_ID, sibling_block_id, indented_block_id],
                    |row| {
                        Ok((
                            row.get::<_, Option<String>>(0)?,
                            row.get::<_, i64>(1)?,
                            row.get::<_, i64>(2)?,
                        ))
                    },
                )?;
                assert_eq!(placement, (None, 3, 1));
                Ok::<_, StoreError>(())
            })
            .expect("persisted outdent placement");
    }

    #[test]
    fn raw_yjs_delete_and_durable_undo_use_document_tombstone_authority() {
        let seeded = seeded_module();
        let block_id = "019bf52d-6870-7000-8000-000000000122";
        seeded
            .module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    operation_id: "document-operation:seed-durable-undo".to_owned(),
                    store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
                    intent: OwnedDocumentIntent::ApplyOperationBatch {
                        document_id: DOCUMENT_ID.to_owned(),
                        generation: 1,
                        expected_head_seq: 1,
                        operations: vec![ContractDocumentBlockOperation::InsertBlock {
                            block: paragraph(block_id, "Undo me after ACK"),
                            parent_block_id: None,
                            before_block_id: None,
                        }],
                        actor: json!({ "kind": "test" }),
                    },
                },
            )
            .expect("seed undoable Block");
        let (_, block_tree) = persisted_body(&seeded);
        let deleted_block = find_block(&block_tree, block_id)
            .expect("seeded Block materialization")
            .clone();

        let (head_seq, engine) = synced_page_engine(&seeded);
        let delete_update = raw_document_operation_update(
            &engine,
            &[DocumentBlockOperation::DeleteBlock {
                block_id: block_id.to_owned(),
            }],
        );
        let deleted = seeded
            .module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    operation_id: "update:raw-delete-before-undo".to_owned(),
                    store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
                    intent: OwnedDocumentIntent::ApplyYjsUpdate {
                        document_id: DOCUMENT_ID.to_owned(),
                        generation: 1,
                        base_head_seq: head_seq,
                        update_id: "update:raw-delete-before-undo".to_owned(),
                        touched_block_ids: Vec::new(),
                        update: delete_update,
                    },
                },
            )
            .expect("durable raw delete");
        assert_eq!(deleted.committed.value.head_seq, head_seq + 1);

        seeded
            .kernel
            .readers()
            .read_default(|connection| {
                let evidence = connection.query_row(
                    "SELECT block.lifecycle, block.placement_revision, block.metadata_revision, \
                            tombstone.document_id, tombstone.document_generation, \
                            tombstone.deletion_head_seq, tombstone.placement_revision, \
                            (SELECT count(*) FROM document_block_index entry \
                              WHERE entry.block_id = block.id), \
                            receipt.client_touched_block_ids_json, \
                            receipt.derived_touched_block_ids_json \
                     FROM blocks block \
                     JOIN document_block_tombstones tombstone ON tombstone.block_id = block.id \
                     JOIN document_update_receipts receipt \
                       ON receipt.update_id = 'update:raw-delete-before-undo' \
                     WHERE block.id = ?1",
                    [block_id],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, i64>(1)?,
                            row.get::<_, i64>(2)?,
                            row.get::<_, String>(3)?,
                            row.get::<_, i64>(4)?,
                            row.get::<_, i64>(5)?,
                            row.get::<_, i64>(6)?,
                            row.get::<_, i64>(7)?,
                            row.get::<_, String>(8)?,
                            row.get::<_, String>(9)?,
                        ))
                    },
                )?;
                assert_eq!(
                    &evidence.0, "deleted",
                    "the ACKed deletion must become a reversible Document tombstone",
                );
                assert_eq!((evidence.1, evidence.2), (2, 2));
                assert_eq!(evidence.3, DOCUMENT_ID);
                assert_eq!((evidence.4, evidence.5, evidence.6), (1, head_seq + 1, 2));
                assert_eq!(evidence.7, 0);
                assert_eq!(
                    serde_json::from_str::<Vec<String>>(&evidence.8).expect("client touched IDs"),
                    Vec::<String>::new(),
                );
                assert_eq!(
                    serde_json::from_str::<Vec<String>>(&evidence.9).expect("derived touched IDs"),
                    vec![block_id.to_owned()],
                );
                Ok::<_, StoreError>(())
            })
            .expect("durable deletion authority");

        let (head_seq, engine) = synced_page_engine(&seeded);
        let undo_update = raw_document_operation_update(
            &engine,
            &[DocumentBlockOperation::InsertBlock {
                block: deleted_block,
                parent_block_id: None,
                before_block_id: None,
            }],
        );
        let restored = seeded
            .module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    operation_id: "update:raw-undo-after-ack".to_owned(),
                    store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
                    intent: OwnedDocumentIntent::ApplyYjsUpdate {
                        document_id: DOCUMENT_ID.to_owned(),
                        generation: 1,
                        base_head_seq: head_seq,
                        update_id: "update:raw-undo-after-ack".to_owned(),
                        touched_block_ids: Vec::new(),
                        update: undo_update,
                    },
                },
            )
            .expect("raw undo after durable ACK");
        assert_eq!(restored.committed.value.head_seq, head_seq + 1);
        seeded
            .kernel
            .readers()
            .read_default(|connection| {
                let evidence = connection.query_row(
                    "SELECT block.lifecycle, block.placement_revision, block.metadata_revision, \
                            (SELECT count(*) FROM document_block_tombstones tombstone \
                              WHERE tombstone.block_id = block.id), \
                            (SELECT count(*) FROM document_block_index entry \
                              WHERE entry.block_id = block.id AND entry.document_id = ?2), \
                            receipt.client_touched_block_ids_json, \
                            receipt.derived_touched_block_ids_json \
                     FROM blocks block \
                     JOIN document_update_receipts receipt \
                       ON receipt.update_id = 'update:raw-undo-after-ack' \
                     WHERE block.id = ?1",
                    params![block_id, DOCUMENT_ID],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, i64>(1)?,
                            row.get::<_, i64>(2)?,
                            row.get::<_, i64>(3)?,
                            row.get::<_, i64>(4)?,
                            row.get::<_, String>(5)?,
                            row.get::<_, String>(6)?,
                        ))
                    },
                )?;
                assert_eq!(evidence.0, "active");
                assert_eq!((evidence.1, evidence.2), (3, 3));
                assert_eq!((evidence.3, evidence.4), (0, 1));
                assert_eq!(
                    serde_json::from_str::<Vec<String>>(&evidence.5).expect("client touched IDs"),
                    Vec::<String>::new(),
                );
                assert_eq!(
                    serde_json::from_str::<Vec<String>>(&evidence.6).expect("derived touched IDs"),
                    vec![block_id.to_owned()],
                );
                Ok::<_, StoreError>(())
            })
            .expect("durable undo evidence");
    }

    #[test]
    fn page_document_event_records_its_database_projection_impact() {
        const GRANTED_PROJECT_ID: &str = "project:document-projection-grantee";
        const RELATION_SOURCE_PAGE_ID: &str = "019bf52d-6870-7000-8000-000000000003";
        const RELATION_SOURCE_DOCUMENT_ID: &str = "019bf52d-6870-7000-8000-000000000004";
        const RELATION_SOURCE_MEMBERSHIP_ID: &str = "019bf52d-6870-7000-8000-000000000005";
        let seeded = seeded_module();
        move_seeded_page_under_database(&seeded);
        let library = LibraryModule::new(PROFILE_ID, LIBRARY_ID, &seeded.kernel);
        library
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "library:create-relation-source".to_owned(),
                    store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
                    intent: LibraryIntent::CreatePage {
                        page_id: RELATION_SOURCE_PAGE_ID.to_owned(),
                        document_id: RELATION_SOURCE_DOCUMENT_ID.to_owned(),
                        title: "Relation source".to_owned(),
                        parent: LibraryWriteParent::Library { before: None },
                    },
                },
            )
            .expect("create inbound Relation source Page");
        seeded
            .kernel
            .writer()
            .call(|connection| {
                with_immediate_transaction(connection, |transaction| {
                    transaction.execute(
                        "DELETE FROM library_block_placements WHERE block_id = ?1",
                        [RELATION_SOURCE_PAGE_ID],
                    )?;
                    transaction.execute(
                        "UPDATE blocks SET placement_revision = placement_revision + 1, \
                           updated_at = ?1 WHERE id = ?2 AND library_id = ?3",
                        params![NOW, RELATION_SOURCE_PAGE_ID, LIBRARY_ID],
                    )?;
                    transaction.execute(
                        "UPDATE pages SET parent_kind = 'data_source', parent_id = ?1, \
                           updated_at = ?2 \
                         WHERE block_id = ?3",
                        params![DATA_SOURCE_ID, NOW, RELATION_SOURCE_PAGE_ID],
                    )?;
                    transaction.execute(
                        "INSERT INTO data_source_page_memberships(\
                           id, data_source_id, page_block_id, revision, created_at, removed_at\
                         ) VALUES (?1, ?2, ?3, 1, ?4, NULL)",
                        params![
                            RELATION_SOURCE_MEMBERSHIP_ID,
                            DATA_SOURCE_ID,
                            RELATION_SOURCE_PAGE_ID,
                            NOW,
                        ],
                    )?;
                    crate::database::refresh_copied_page_projection(
                        transaction,
                        RELATION_SOURCE_PAGE_ID,
                        Some(RELATION_SOURCE_MEMBERSHIP_ID),
                        Some(DATA_SOURCE_ID),
                        NOW,
                    )?;
                    transaction.execute(
                        "INSERT INTO data_source_properties(\
                           data_source_id, id, name, value_type, config_json, rank_key, \
                           lifecycle, schema_revision, created_at, updated_at\
                         ) VALUES (?1, 'related', 'Related', 'relation', '{}', 'a', \
                           'active', 1, ?2, ?2)",
                        params![DATA_SOURCE_ID, NOW],
                    )?;
                    transaction.execute(
                        "INSERT INTO data_source_relation_properties(\
                           data_source_id, property_id, target_data_source_id\
                         ) VALUES (?1, 'related', ?1)",
                        [DATA_SOURCE_ID],
                    )?;
                    transaction.execute(
                        "INSERT INTO data_source_property_values(\
                           data_source_id, membership_id, property_id, value_type, value_json, \
                           revision, updated_at\
                         ) VALUES (?1, ?2, 'related', 'relation', 'null', 1, ?3)",
                        params![DATA_SOURCE_ID, RELATION_SOURCE_MEMBERSHIP_ID, NOW],
                    )?;
                    transaction.execute(
                        "INSERT INTO data_source_relation_edges(\
                           edge_id, source_data_source_id, source_membership_id, property_id, \
                           target_page_block_id, created_at\
                         ) VALUES (?1, ?2, ?3, 'related', ?4, ?5)",
                        params![
                            "a".repeat(64),
                            DATA_SOURCE_ID,
                            RELATION_SOURCE_MEMBERSHIP_ID,
                            OWNER_BLOCK_ID,
                            NOW,
                        ],
                    )?;
                    transaction.execute(
                        "INSERT INTO projects(id, library_id, name, created, updated) \
                         VALUES (?1, ?2, 'Document projection grantee', ?3, ?3)",
                        params![GRANTED_PROJECT_ID, LIBRARY_ID, NOW],
                    )?;
                    transaction.execute(
                        "INSERT INTO project_resource_grants(\
                           id, project_id, library_id, root_kind, root_id, access, recursive, \
                           revision, lifecycle, created_at, updated_at\
                         ) VALUES ('grant:document-projection', ?1, ?2, 'database', ?3, \
                           'read', 1, 1, 'active', ?4, ?4)",
                        params![GRANTED_PROJECT_ID, LIBRARY_ID, DATABASE_ID, NOW],
                    )?;
                    Ok(())
                })
            })
            .expect("grant a second Project the Page Database");
        let update = title_update(
            &seeded.full_state,
            &seeded.state_vector,
            "Database projection impact",
        );

        let applied = seeded
            .module
            .apply(
                &context(),
                apply_request("update:database-impact", 1, update),
            )
            .expect("Page update");
        let event_json =
            serde_json::to_value(&applied.events[0].payload).expect("Document event JSON");
        assert!(event_json["event"].get("page_impact").is_none());
        assert_eq!(
            applied.events[0].projection_impact,
            ProjectionImpact::Resources {
                page_ids: vec![
                    OWNER_BLOCK_ID.to_owned(),
                    RELATION_SOURCE_PAGE_ID.to_owned()
                ],
                database_ids: vec![DATABASE_ID.to_owned()],
                data_source_ids: vec![DATA_SOURCE_ID.to_owned()],
                view_ids: vec![VIEW_ID_A.to_owned(), VIEW_ID_B.to_owned()],
                document_heads: vec![PageDocumentHeadImpact {
                    page_id: OWNER_BLOCK_ID.to_owned(),
                    document_id: DOCUMENT_ID.to_owned(),
                    generation: 1,
                    head_seq: 2,
                }],
            }
        );
        let manifest = seeded
            .kernel
            .readers()
            .read_default(|connection| {
                crate::infrastructure::local_commit::read_manifest(
                    connection,
                    applied.committed.commit_seq,
                )
            })
            .expect("Page Document CommitManifest");
        assert!(manifest.projection_effects.iter().any(|effect| {
            matches!(
                &effect.scope.scope,
                nodex_core_contracts::LocalProjectionScope::Page {
                    project_id,
                    page_id,
                } if project_id == PROJECT_ID && page_id == OWNER_BLOCK_ID
            )
        }));
        assert!(manifest.projection_effects.iter().any(|effect| {
            matches!(
                &effect.scope.scope,
                nodex_core_contracts::LocalProjectionScope::Page {
                    project_id,
                    page_id,
                } if project_id == PROJECT_ID && page_id == RELATION_SOURCE_PAGE_ID
            )
        }));
        assert!(manifest.projection_effects.iter().any(|effect| {
            matches!(
                &effect.scope.scope,
                nodex_core_contracts::LocalProjectionScope::Page {
                    project_id,
                    page_id,
                } if project_id == GRANTED_PROJECT_ID && page_id == OWNER_BLOCK_ID
            )
        }));
        assert_eq!(
            manifest
                .projection_effects
                .iter()
                .filter(|effect| matches!(
                    &effect.scope.scope,
                    nodex_core_contracts::LocalProjectionScope::DatabaseView {
                        project_id,
                        ..
                    } if project_id == PROJECT_ID
                ))
                .count(),
            2,
        );
        assert_eq!(
            manifest
                .projection_effects
                .iter()
                .filter(|effect| matches!(
                    &effect.scope.scope,
                    nodex_core_contracts::LocalProjectionScope::DatabaseView {
                        project_id,
                        ..
                    } if project_id == GRANTED_PROJECT_ID
                ))
                .count(),
            2,
        );
        assert!(manifest.projection_effects.iter().all(|effect| {
            !matches!(
                &effect.scope.scope,
                nodex_core_contracts::LocalProjectionScope::DatabaseView { .. }
            ) || effect.patch.is_none()
        }));
        assert!(!manifest.projection_effects.iter().any(|effect| {
            matches!(
                &effect.scope.scope,
                nodex_core_contracts::LocalProjectionScope::Project { .. }
            )
        }));
        seeded
            .kernel
            .readers()
            .read_default(|connection| {
                let (payload_json, database_ids_json): (String, String) = connection.query_row(
                    "SELECT payload_json, database_block_ids_json FROM change_log \
                     WHERE operation_id = 'update:database-impact'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )?;
                assert!(
                    serde_json::from_str::<Value>(&payload_json)
                        .expect("event payload")
                        .get("pageImpact")
                        .is_none()
                );
                assert_eq!(
                    serde_json::from_str::<Value>(&database_ids_json).expect("Database impact IDs"),
                    json!([DATABASE_ID])
                );
                let projection: (String, String, i64, String, String, i64) = connection.query_row(
                    "SELECT page.title, page.description_preview, \
                                page.document_projected_seq, materialization.title, \
                                materialization.preview, materialization.projected_seq \
                         FROM page_read_model page \
                         JOIN document_materializations materialization \
                           ON materialization.document_id = page.document_id \
                         WHERE page.page_block_id = ?1",
                    [OWNER_BLOCK_ID],
                    |row| {
                        Ok((
                            row.get(0)?,
                            row.get(1)?,
                            row.get(2)?,
                            row.get(3)?,
                            row.get(4)?,
                            row.get(5)?,
                        ))
                    },
                )?;
                assert_eq!(projection.0, "Database projection impact");
                assert_eq!(projection.0, projection.3);
                assert_eq!(projection.1, projection.4);
                assert_eq!(projection.2, 2);
                assert_eq!(projection.2, projection.5);
                Ok::<_, StoreError>(())
            })
            .expect("durable Page impact");

        seeded
            .kernel
            .writer()
            .call(|connection| {
                with_immediate_transaction(connection, |transaction| {
                    transaction.execute(
                        "UPDATE pages SET parent_kind = 'library', parent_id = ?1 \
                         WHERE block_id = ?2",
                        params![LIBRARY_ID, OWNER_BLOCK_ID],
                    )?;
                    transaction.execute(
                        "DELETE FROM data_source_page_memberships WHERE id = ?1",
                        [MEMBERSHIP_ID],
                    )?;
                    Ok(())
                })
            })
            .expect("move Page after its Document commit");
        let packet = crate::infrastructure::event_log::CoreEventLog::new(seeded.kernel.readers())
            .authorized_packet(
                applied.committed.commit_seq,
                &library_context_for("electron-host:projection-replay", AdapterKind::ElectronHost),
                Some(DOCUMENT_ID),
                false,
            )
            .expect("resolve committed Page impact")
            .expect("Page Document delivery");
        assert_eq!(packet.document_effects.len(), 1);
    }

    #[test]
    fn page_document_commit_requires_its_exact_projection_row() {
        let seeded = seeded_module();
        seeded
            .kernel
            .writer()
            .call(|connection| {
                connection.execute(
                    "DELETE FROM page_read_model WHERE page_block_id = ?1",
                    [OWNER_BLOCK_ID],
                )?;
                Ok::<_, StoreError>(())
            })
            .expect("remove Page projection");
        let update = title_update(
            &seeded.full_state,
            &seeded.state_vector,
            "Must not commit without projection",
        );

        let error = seeded
            .module
            .apply(
                &context(),
                apply_request("update:missing-page-projection", 1, update),
            )
            .expect_err("Page commit must fail closed without its projection");
        assert_eq!(error.code, CoreErrorCode::StoreCorrupt);
        seeded
            .kernel
            .readers()
            .read_default(|connection| {
                let (head_seq, title, event_count): (i64, String, i64) = connection.query_row(
                    "SELECT document.head_seq, materialization.title, \
                            (SELECT count(*) FROM change_log \
                             WHERE operation_id = 'update:missing-page-projection') \
                     FROM documents document \
                     JOIN document_materializations materialization \
                       ON materialization.document_id = document.id \
                     WHERE document.id = ?1",
                    [DOCUMENT_ID],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )?;
                assert_eq!(head_seq, 1);
                assert_ne!(title, "Must not commit without projection");
                assert_eq!(event_count, 0);
                Ok::<_, StoreError>(())
            })
            .expect("failed Page commit rolled back");
    }

    #[test]
    fn realtime_requires_subscription_replays_durable_events_and_clears_awareness() {
        let seeded = seeded_module();
        let adapter = OwnedDocumentRealtimeAdapter::new(seeded.module.clone());
        let first_context = context_for("renderer:first");
        let second_context = context_for("renderer:second");
        let request = apply_request(
            "update:realtime",
            1,
            title_update(
                &seeded.full_state,
                &seeded.state_vector,
                "Realtime authority",
            ),
        );

        let unauthorized = adapter
            .apply(&first_context, "client:first", request.clone())
            .expect_err("subscribe-before-sync is mandatory");
        assert_eq!(unauthorized.code, CoreErrorCode::Unauthorized);
        assert_eq!(
            unauthorized.recovery,
            CoreErrorRecovery::ReconnectDocumentSubscription
        );
        let unauthorized_sync = adapter
            .sync_yjs(
                &first_context,
                "client:first",
                DOCUMENT_ID.to_owned(),
                Vec::new(),
                None,
            )
            .expect_err("sync also requires a subscription");
        assert_eq!(unauthorized_sync.code, CoreErrorCode::Unauthorized);
        assert_eq!(
            unauthorized_sync.recovery,
            CoreErrorRecovery::ReconnectDocumentSubscription
        );

        let first = adapter
            .subscribe(
                &first_context,
                DOCUMENT_ID.to_owned(),
                "client:first".to_owned(),
            )
            .expect("first subscription");
        let second = adapter
            .subscribe(
                &second_context,
                DOCUMENT_ID.to_owned(),
                "client:second".to_owned(),
            )
            .expect("second subscription");
        assert_eq!(first.head_seq, 1);
        assert_eq!(second.head_seq, 1);
        assert!(first.awareness_update.is_some());
        let synced = adapter
            .sync_yjs(
                &first_context,
                "client:first",
                DOCUMENT_ID.to_owned(),
                Vec::new(),
                None,
            )
            .expect("subscribed sync");
        assert!(matches!(
            synced.value,
            OwnedDocumentReadValue::YjsSync { .. }
        ));

        let applied = adapter
            .apply(&first_context, "client:first", request)
            .expect("subscribed mutation");
        assert_eq!(applied.committed.value.head_seq, 2);
        let mut remote_awareness = DocumentAwareness::new("awareness:remote");
        remote_awareness
            .set_local_state(&json!({ "user": "first" }))
            .expect("local awareness");
        let awareness_client_id = remote_awareness.client_id();
        let awareness_update = remote_awareness.local_update_v1().expect("join update");
        let publication = adapter
            .publish_awareness(
                "renderer:first",
                "client:first",
                &StoreEpoch(STORE_EPOCH.to_owned()),
                1,
                &awareness_update,
            )
            .expect("publish awareness")
            .expect("awareness changed");
        assert_eq!(publication.recipient_connections, ["renderer:second"]);

        let mut observer = DocumentAwareness::new("awareness:observer");
        observer
            .apply_update_v1(&awareness_update)
            .expect("observe join");
        assert!(observer.state(awareness_client_id).is_some());
        adapter
            .subscribe(
                &first_context,
                DOCUMENT_ID.to_owned(),
                "client:first-sibling".to_owned(),
            )
            .expect("same connection sibling subscription");
        let unsubscribed = adapter
            .unsubscribe("renderer:first", "client:first")
            .expect("exact unsubscribe clears presence")
            .expect("Awareness leave publication");
        let DocumentRealtimeEvent::Awareness { update, .. } = &unsubscribed.event;
        observer.apply_update_v1(update).expect("observe leave");
        assert!(observer.state(awareness_client_id).is_none());
        adapter
            .sync_yjs(
                &first_context,
                "client:first-sibling",
                DOCUMENT_ID.to_owned(),
                Vec::new(),
                None,
            )
            .expect("exact unsubscribe preserves its connection sibling");
        let removed = adapter
            .disconnect("renderer:first")
            .expect("connection disconnect clears remaining subscriptions");
        assert!(removed.is_empty());
        let disconnected_sibling = adapter
            .sync_yjs(
                &first_context,
                "client:first-sibling",
                DOCUMENT_ID.to_owned(),
                Vec::new(),
                None,
            )
            .expect_err("connection disconnect removes its remaining sibling");
        assert_eq!(disconnected_sibling.code, CoreErrorCode::Unauthorized);
        assert_eq!(
            disconnected_sibling.recovery,
            CoreErrorRecovery::ReconnectDocumentSubscription
        );

        seeded
            .module
            .compact(
                &second_context,
                StoreEpoch(STORE_EPOCH.to_owned()),
                DOCUMENT_ID.to_owned(),
                1,
                2,
            )
            .expect("compact event update tail");
    }

    #[test]
    fn electron_realtime_page_access_uses_recursive_project_grants() {
        const GRANTED_PROJECT_ID: &str = "project:electron-grantee";
        let seeded = seeded_module();
        seeded
            .kernel
            .writer()
            .call(|connection| {
                with_immediate_transaction(connection, |transaction| {
                    transaction.execute(
                        "INSERT INTO projects(id, library_id, name, created, updated) \
                         VALUES (?1, ?2, 'Electron grantee', ?3, ?3)",
                        params![GRANTED_PROJECT_ID, LIBRARY_ID, NOW],
                    )?;
                    transaction.execute(
                        "INSERT INTO project_resource_grants(\
                           id, project_id, library_id, root_kind, root_id, access, recursive, \
                           revision, lifecycle, created_at, updated_at\
                         ) VALUES ('grant:electron-page', ?1, ?2, 'page', ?3, 'read', 1, 1, \
                           'active', ?4, ?4)",
                        params![GRANTED_PROJECT_ID, LIBRARY_ID, OWNER_BLOCK_ID, NOW],
                    )?;
                    Ok(())
                })
            })
            .expect("seed Electron Page grant");

        let adapter = OwnedDocumentRealtimeAdapter::new(seeded.module.clone());
        let granted = electron_context_for("renderer:grantee", GRANTED_PROJECT_ID);
        adapter
            .subscribe(
                &granted,
                DOCUMENT_ID.to_owned(),
                "client:grantee".to_owned(),
            )
            .expect("read grant subscribes to the foreign Page");
        adapter
            .sync_yjs(
                &granted,
                "client:grantee",
                DOCUMENT_ID.to_owned(),
                Vec::new(),
                None,
            )
            .expect("read grant syncs the foreign Page");

        let request = apply_request(
            "update:electron-grantee",
            1,
            title_update(&seeded.full_state, &seeded.state_vector, "Electron grant"),
        );
        let denied = adapter
            .apply(&granted, "client:grantee", request.clone())
            .expect_err("read grant cannot mutate the foreign Page");
        assert_eq!(denied.code, CoreErrorCode::NotFound);

        seeded
            .kernel
            .writer()
            .call(|connection| {
                connection.execute(
                    "UPDATE project_resource_grants SET access = 'read_write', revision = 2 \
                     WHERE id = 'grant:electron-page'",
                    [],
                )?;
                Ok(())
            })
            .expect("upgrade Electron Page grant");
        let committed = adapter
            .apply(&granted, "client:grantee", request)
            .expect("read-write grant mutates the foreign Page");
        assert_eq!(committed.committed.value.head_seq, 2);
    }

    #[test]
    fn trusted_library_realtime_scope_crosses_project_access_paths() {
        let seeded = seeded_module();
        let adapter = OwnedDocumentRealtimeAdapter::new(seeded.module.clone());
        let library_context = library_context_for("renderer:library", AdapterKind::Test);
        let untrusted_context = library_context_for("agent:library", AdapterKind::Agent);
        let wrong_project = context_for_project("renderer:wrong", "project:other");

        let canvas = canvas_module();
        canvas
            .module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    operation_id: "canvas:library-access:prepare".to_owned(),
                    store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
                    intent: OwnedDocumentIntent::PrepareOwner {
                        owner_block_id: OWNER_BLOCK_ID.to_owned(),
                    },
                },
            )
            .expect("prepare Library-accessed Canvas");
        let canvas_adapter = OwnedDocumentRealtimeAdapter::new(canvas.module);
        let canvas_subscription = canvas_adapter
            .subscribe(
                &library_context,
                DOCUMENT_ID.to_owned(),
                "client:library-canvas".to_owned(),
            )
            .expect("trusted Library scope resolves a registered Canvas owner");
        assert_eq!(
            canvas_subscription.engine,
            DocumentSubscriptionEngine::CanvasScene
        );
        let library_canvas_applied = canvas_adapter
            .apply(
                &library_context,
                "client:library-canvas",
                canvas_mutation_request("canvas:library-access", 0, 1, "Library access"),
            )
            .expect("trusted Library scope mutates the registered Canvas");
        let library_canvas_result = library_canvas_applied
            .committed
            .value
            .canvas
            .as_ref()
            .expect("Library Canvas mutation result");
        assert_eq!(library_canvas_result["libraryId"], LIBRARY_ID);
        assert_eq!(
            library_canvas_result["accessContext"],
            json!({ "kind": "library" })
        );
        assert!(library_canvas_result.get("projectId").is_none());

        let unauthorized_library = adapter
            .subscribe(
                &untrusted_context,
                DOCUMENT_ID.to_owned(),
                "client:agent".to_owned(),
            )
            .expect_err("untrusted Adapter cannot request Library scope");
        assert_eq!(unauthorized_library.code, CoreErrorCode::Unauthorized);
        let unauthorized_project = adapter
            .subscribe(
                &wrong_project,
                DOCUMENT_ID.to_owned(),
                "client:wrong".to_owned(),
            )
            .expect_err("another Project cannot discover the foreign Page");
        assert_eq!(unauthorized_project.code, CoreErrorCode::NotFound);

        adapter
            .subscribe(
                &library_context,
                DOCUMENT_ID.to_owned(),
                "client:library".to_owned(),
            )
            .expect("trusted Library subscription");
        let synced = adapter
            .sync_yjs(
                &library_context,
                "client:library",
                DOCUMENT_ID.to_owned(),
                Vec::new(),
                None,
            )
            .expect("Library-scoped sync");
        assert!(matches!(
            synced.value,
            OwnedDocumentReadValue::YjsSync { .. }
        ));

        let applied = adapter
            .apply(
                &library_context,
                "client:library",
                apply_request(
                    "update:library-scope",
                    1,
                    title_update(&seeded.full_state, &seeded.state_vector, "Library scope"),
                ),
            )
            .expect("Library-scoped update");
        assert_eq!(applied.committed.value.head_seq, 2);

        seeded
            .kernel
            .writer()
            .call(|connection| {
                with_immediate_transaction(connection, |transaction| {
                    transaction.execute(
                        "UPDATE blocks SET lifecycle = 'archived' WHERE id = ?1",
                        [OWNER_BLOCK_ID],
                    )?;
                    transaction.execute(
                        "UPDATE page_read_model SET lifecycle = 'archived' WHERE page_block_id = ?1",
                        [OWNER_BLOCK_ID],
                    )?;
                    Ok(())
                })
            })
            .expect("archive Page authority");
        adapter
            .sync_yjs(
                &library_context,
                "client:library",
                DOCUMENT_ID.to_owned(),
                Vec::new(),
                None,
            )
            .expect("archived Library Page remains readable");
        let archived_write = adapter
            .apply(
                &library_context,
                "client:library",
                apply_request(
                    "update:archived-library-scope",
                    2,
                    title_update(&seeded.full_state, &seeded.state_vector, "Archived write"),
                ),
            )
            .expect_err("archived Library Page is not writable");
        assert_eq!(archived_write.code, CoreErrorCode::Unauthorized);
    }

    #[test]
    fn realtime_replays_a_commit_lost_before_publication() {
        let seeded = seeded_module();
        let adapter = OwnedDocumentRealtimeAdapter::new(seeded.module.clone());
        let first_context = context_for("renderer:faulted");
        adapter
            .subscribe(
                &first_context,
                DOCUMENT_ID.to_owned(),
                "client:faulted".to_owned(),
            )
            .expect("subscription");
        let request = apply_request(
            "update:lost-publication",
            1,
            title_update(
                &seeded.full_state,
                &seeded.state_vector,
                "Durable before publication",
            ),
        );
        seeded.module.inject_failure_after_next_commit();
        adapter
            .apply(&first_context, "client:faulted", request.clone())
            .expect_err("injected post-commit publication failure");

        let reconnected_context = context_for("renderer:reconnected");
        adapter
            .subscribe(
                &reconnected_context,
                DOCUMENT_ID.to_owned(),
                "client:faulted".to_owned(),
            )
            .expect("reconnected subscription");
        let retry = adapter
            .apply(&reconnected_context, "client:faulted", request)
            .expect("exact retry recovers receipt");
        assert!(retry.committed.receipt.mutation.duplicate);
        seeded
            .kernel
            .readers()
            .read_default(|connection| {
                let client_session_id = connection.query_row(
                    "SELECT client_session_id FROM document_update_receipts WHERE update_id = ?1",
                    ["update:lost-publication"],
                    |row| row.get::<_, String>(0),
                )?;
                assert_eq!(client_session_id, "client:faulted");
                Ok::<_, StoreError>(())
            })
            .expect("durable logical client session");
    }

    #[test]
    fn retry_recovers_a_commit_that_failed_before_cache_swap_and_publication() {
        let seeded = seeded_module();
        let first_update = title_update(
            &seeded.full_state,
            &seeded.state_vector,
            "First native edit",
        );
        let mut engine =
            YrsDocumentEngine::from_full_state_v1(DOCUMENT_ID, &seeded.full_state).unwrap();
        let first_candidate = engine.prepare_update_v1(&first_update).unwrap();
        engine.commit_candidate(first_candidate).unwrap();
        let second_update = title_update(
            &engine.full_state_v1(),
            &engine.state_vector_v1(),
            "Committed before publication",
        );
        seeded
            .module
            .apply(&context(), apply_request("update:first", 1, first_update))
            .expect("first update");

        let request = apply_request("update:fault", 2, second_update);
        seeded.module.inject_failure_after_next_commit();
        let failure = seeded
            .module
            .apply(&context(), request.clone())
            .expect_err("fault occurs after commit");
        assert_eq!(failure.code, CoreErrorCode::CoreUnavailable);

        let recovered = seeded
            .module
            .apply(&context(), request)
            .expect("receipt recovers committed result");
        assert!(recovered.committed.receipt.mutation.duplicate);
        assert_eq!(recovered.committed.value.head_seq, 3);
        assert!(recovered.events.is_empty());
        seeded
            .kernel
            .readers()
            .read_default(|connection| {
                let head: i64 = connection.query_row(
                    "SELECT head_seq FROM documents WHERE id = ?1",
                    [DOCUMENT_ID],
                    |row| row.get(0),
                )?;
                let title: String = connection.query_row(
                    "SELECT title FROM document_materializations WHERE document_id = ?1",
                    [DOCUMENT_ID],
                    |row| row.get(0),
                )?;
                assert_eq!(head, 3);
                assert_eq!(title, "Committed before publication");
                Ok::<_, StoreError>(())
            })
            .expect("committed authority survives missed publication");
    }

    #[test]
    fn checkpoints_list_get_and_restore_immutable_document_history() {
        let seeded = seeded_module();
        move_seeded_page_under_database(&seeded);
        let checkpoint_request = ModuleApplyRequest {
            contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
            operation_id: "checkpoint:initial".to_owned(),
            store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
            intent: OwnedDocumentIntent::CreateCheckpoint {
                document_id: DOCUMENT_ID.to_owned(),
                generation: 1,
                expected_head_seq: 1,
                cause: "manual".to_owned(),
                label: Some("Initial Page".to_owned()),
                actor: serde_json::json!({ "kind": "test" }),
                revision_kind: Some(DocumentRevisionKind::Manual),
                source_mutation_id: None,
                source_change_seq: None,
            },
        };
        let checkpoint = seeded
            .module
            .apply(&context(), checkpoint_request.clone())
            .expect("checkpoint");
        assert_eq!(checkpoint.committed.value.head_seq, 1);
        assert!(checkpoint.events.is_empty());
        let checkpoint_effect = checkpoint
            .committed
            .value
            .checkpoint_effect
            .as_ref()
            .expect("public checkpoint effect");
        assert!(!checkpoint_effect.duplicate);
        assert_eq!(checkpoint_effect.checkpoint["actor"]["kind"], "test");
        assert_eq!(checkpoint_effect.checkpoint["revisionKind"], "manual");
        assert!(
            seeded
                .module
                .apply(&context(), checkpoint_request)
                .unwrap()
                .committed
                .receipt
                .mutation
                .duplicate
        );
        let versions = seeded
            .module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    read: OwnedDocumentRead::ListVersions {
                        document_id: DOCUMENT_ID.to_owned(),
                        before: None,
                        limit: Some(50),
                    },
                },
            )
            .expect("history list");
        let OwnedDocumentReadValue::Versions { items, next } = versions.value else {
            panic!("expected history list")
        };
        assert_eq!(items.len(), 1);
        assert!(next.is_none());
        let version_id = items[0]["versionId"].as_str().unwrap().to_owned();
        let cursor = DocumentVersionCursor {
            base_head_seq: items[0]["baseHeadSeq"].as_i64().unwrap(),
            created_at: items[0]["createdAt"].as_str().unwrap().to_owned(),
            version_id: version_id.clone(),
        };
        let before = seeded
            .module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    read: OwnedDocumentRead::ListVersions {
                        document_id: DOCUMENT_ID.to_owned(),
                        before: Some(cursor.clone()),
                        limit: Some(50),
                    },
                },
            )
            .expect("history cursor");
        let OwnedDocumentReadValue::Versions { items, .. } = before.value else {
            panic!("expected cursor history list")
        };
        assert!(items.is_empty());
        let tampered_cursor = DocumentVersionCursor {
            created_at: "2026-07-19T00:00:00.000Z".to_owned(),
            ..cursor
        };
        let error = seeded
            .module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    read: OwnedDocumentRead::ListVersions {
                        document_id: DOCUMENT_ID.to_owned(),
                        before: Some(tampered_cursor),
                        limit: Some(50),
                    },
                },
            )
            .unwrap_err();
        assert_eq!(error.code, CoreErrorCode::NotFound);
        let version = seeded
            .module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    read: OwnedDocumentRead::GetVersion {
                        document_id: DOCUMENT_ID.to_owned(),
                        version_id: version_id.clone(),
                    },
                },
            )
            .expect("history detail");
        let OwnedDocumentReadValue::Version { value } = version.value else {
            panic!("expected history detail")
        };
        assert_eq!(
            value["summary"]["checkpointMetadata"]["format"],
            "block_tree_snapshot_v3"
        );

        let update = title_update(
            &seeded.full_state,
            &seeded.state_vector,
            "Changed after checkpoint",
        );
        seeded
            .module
            .apply(
                &context(),
                apply_request("update:after-checkpoint", 1, update),
            )
            .unwrap();
        let restore_request = ModuleApplyRequest {
            contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
            operation_id: "restore:initial".to_owned(),
            store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
            intent: OwnedDocumentIntent::RestoreVersion {
                document_id: DOCUMENT_ID.to_owned(),
                version_id: version_id.clone(),
                generation: 1,
                expected_head_seq: 2,
                actor: json!({ "kind": "test" }),
            },
        };
        let restored = seeded
            .module
            .apply(&context(), restore_request.clone())
            .expect("restore checkpoint");
        assert_eq!(restored.committed.value.head_seq, 3);
        let restore_effect = restored
            .committed
            .value
            .mutation_effect
            .as_ref()
            .expect("Document restore effect");
        assert_eq!(restore_effect.base_head_seq, 2);
        assert_eq!(restore_effect.touched_block_ids, [OWNER_BLOCK_ID]);
        assert!(restore_effect.created_block_ids.is_empty());
        assert!(restore_effect.deleted_block_ids.is_empty());
        assert!(restore_effect.updated_block_ids.is_empty());
        assert!(restore_effect.moved_block_ids.is_empty());
        assert!(
            restore_effect
                .write_fence_block_ids
                .contains(&OWNER_BLOCK_ID.to_owned())
        );
        assert!(restore_effect.title_changed);
        assert_eq!(
            restore_effect.coordination,
            DocumentMutationCoordination::WriteFence
        );
        assert!(restored.committed.value.committed_at.is_some());
        let CoreModuleEventPayload::OwnedDocument(OwnedDocumentEvent::DocumentInvalidated {
            reason,
            ..
        }) = &restored.events[0].payload
        else {
            panic!("expected restored Page Document invalidation")
        };
        assert_eq!(*reason, DocumentInvalidationReason::Restored);
        let mut replay_request = restore_request;
        let OwnedDocumentIntent::RestoreVersion { actor, .. } = &mut replay_request.intent else {
            unreachable!()
        };
        *actor = json!({ "kind": "replacement-audit-identity" });
        let replayed = seeded
            .module
            .apply(&context_for("renderer-session:reconnected"), replay_request)
            .unwrap();
        assert!(replayed.committed.receipt.mutation.duplicate);
        assert_eq!(
            replayed.committed.value.mutation_effect,
            restored.committed.value.mutation_effect
        );

        let no_change = seeded
            .module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    operation_id: "restore:already-current".to_owned(),
                    store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
                    intent: OwnedDocumentIntent::RestoreVersion {
                        document_id: DOCUMENT_ID.to_owned(),
                        version_id: version_id.clone(),
                        generation: 1,
                        expected_head_seq: 3,
                        actor: json!({ "kind": "test" }),
                    },
                },
            )
            .expect("already-current restore has a durable no-change receipt");
        assert_eq!(
            no_change.committed.value.outcome,
            DocumentCommitOutcome::NoChange
        );
        assert!(no_change.committed.value.mutation_effect.is_none());
        seeded
            .kernel
            .readers()
            .read_default(|connection| {
                let title: String = connection.query_row(
                    "SELECT title FROM document_materializations WHERE document_id = ?1",
                    [DOCUMENT_ID],
                    |row| row.get(0),
                )?;
                let versions: i64 = connection.query_row(
                    "SELECT count(*) FROM document_versions WHERE document_id = ?1",
                    [DOCUMENT_ID],
                    |row| row.get(0),
                )?;
                let restored_events: i64 = connection.query_row(
                    "SELECT count(*) FROM change_log \
                     WHERE operation_id = 'restore:initial' \
                       AND kind = 'owned_document.document_restored'",
                    [],
                    |row| row.get(0),
                )?;
                let checkpoint_actors = connection
                    .prepare(
                        "SELECT cause, actor_json FROM document_versions \
                         WHERE document_id = ?1 AND source_mutation_id = 'restore:initial' \
                         ORDER BY base_head_seq",
                    )?
                    .query_map([DOCUMENT_ID], |row| {
                        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                    })?
                    .collect::<Result<Vec<_>, _>>()?;
                assert_eq!(title, "");
                assert_eq!(versions, 3);
                assert_eq!(restored_events, 1);
                assert_eq!(checkpoint_actors.len(), 2);
                let before_actor: Value = serde_json::from_str(&checkpoint_actors[0].1).unwrap();
                let after_actor: Value = serde_json::from_str(&checkpoint_actors[1].1).unwrap();
                assert_eq!(before_actor["restoreMutationId"], "restore:initial");
                assert_eq!(before_actor["sourceVersionId"], version_id);
                assert_eq!(after_actor, json!({ "kind": "test" }));
                Ok::<_, StoreError>(())
            })
            .unwrap();
    }

    #[test]
    fn public_document_mutations_classify_fence_checkpoint_and_replay() {
        let seeded = seeded_module();
        let inserted_block_id = "019bf52d-6870-7000-8000-000000000101";
        let insert_request = ModuleApplyRequest {
            contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
            operation_id: "document-operation:insert".to_owned(),
            store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
            intent: OwnedDocumentIntent::ApplyOperationBatch {
                document_id: DOCUMENT_ID.to_owned(),
                generation: 1,
                expected_head_seq: 1,
                operations: vec![ContractDocumentBlockOperation::InsertBlock {
                    block: paragraph(inserted_block_id, "Inserted through Core"),
                    parent_block_id: None,
                    before_block_id: None,
                }],
                actor: json!({ "kind": "electron_renderer", "clientId": "renderer:test" }),
            },
        };
        let inserted = seeded
            .module
            .apply(&context(), insert_request)
            .expect("merge-friendly insertion");
        let insert_effect = inserted
            .committed
            .value
            .mutation_effect
            .as_ref()
            .expect("insert effect");
        assert_eq!(inserted.committed.value.head_seq, 2);
        assert_eq!(insert_effect.created_block_ids, [inserted_block_id]);
        assert_eq!(
            insert_effect.coordination,
            DocumentMutationCoordination::MergeFriendly
        );
        assert!(insert_effect.write_fence_block_ids.is_empty());

        let update_request = ModuleApplyRequest {
            contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
            operation_id: "document-operation:update".to_owned(),
            store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
            intent: OwnedDocumentIntent::ApplyOperationBatch {
                document_id: DOCUMENT_ID.to_owned(),
                generation: 1,
                expected_head_seq: 2,
                operations: vec![ContractDocumentBlockOperation::UpdateBlock {
                    block_id: inserted_block_id.to_owned(),
                    patch: ContractDocumentBlockUpdatePatch {
                        block_type: None,
                        props: None,
                        content: DocumentOptionalValue::Value {
                            value: json!([{
                                "type": "text",
                                "text": "Updated through Core",
                                "styles": {},
                            }]),
                        },
                        unset_content: false,
                    },
                }],
                actor: json!({ "kind": "electron_renderer", "clientId": "renderer:test" }),
            },
        };
        let updated = seeded
            .module
            .apply(&context(), update_request.clone())
            .expect("content replacement at the exact head");
        let update_effect = updated
            .committed
            .value
            .mutation_effect
            .as_ref()
            .expect("update effect");
        assert_eq!(updated.committed.value.head_seq, 3);
        assert_eq!(update_effect.updated_block_ids, [inserted_block_id]);
        assert_eq!(update_effect.write_fence_block_ids, [inserted_block_id]);
        assert_eq!(
            update_effect.coordination,
            DocumentMutationCoordination::WriteFence
        );

        let mut replay = update_request;
        let OwnedDocumentIntent::ApplyOperationBatch { actor, .. } = &mut replay.intent else {
            unreachable!()
        };
        *actor = json!({ "kind": "electron_renderer", "clientId": "renderer:reconnected" });
        let replayed = seeded
            .module
            .apply(&context_for("renderer-session:reconnected"), replay)
            .expect("receipt replay bypasses a new fence");
        assert!(replayed.committed.receipt.mutation.duplicate);
        assert_eq!(
            replayed.committed.value.mutation_effect,
            updated.committed.value.mutation_effect
        );

        let current_nfm = seeded
            .kernel
            .readers()
            .read_default(|connection| {
                connection
                    .query_row(
                        "SELECT nfm FROM document_materializations WHERE document_id = ?1",
                        [DOCUMENT_ID],
                        |row| row.get::<_, String>(0),
                    )
                    .map_err(StoreError::from)
            })
            .unwrap();
        let nfm_request = ModuleApplyRequest {
            contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
            operation_id: "document-operation:nfm".to_owned(),
            store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
            intent: OwnedDocumentIntent::ReplaceFromNfm {
                document_id: DOCUMENT_ID.to_owned(),
                generation: 1,
                expected_head_seq: 3,
                nfm: current_nfm,
                rich_title: Some(vec![json!({
                    "type": "text",
                    "text": "Native NFM title",
                    "styles": {},
                })]),
                actor: json!({ "kind": "electron_renderer", "clientId": "renderer:test" }),
            },
        };
        let replaced = seeded
            .module
            .apply(&context(), nfm_request)
            .expect("whole-NFM replacement at the exact head");
        let replace_effect = replaced
            .committed
            .value
            .mutation_effect
            .as_ref()
            .expect("NFM effect");
        assert!(replace_effect.title_changed);
        assert_eq!(
            replace_effect.coordination,
            DocumentMutationCoordination::WriteFence
        );

        seeded
            .kernel
            .readers()
            .read_default(|connection| {
                let checkpoints = connection.query_row(
                    "SELECT count(*) FROM document_versions \
                     WHERE source_mutation_id IN (\
                       'document-operation:insert', \
                       'document-operation:update', \
                       'document-operation:nfm'\
                     ) AND revision_kind = 'operation'",
                    [],
                    |row| row.get::<_, i64>(0),
                )?;
                assert_eq!(checkpoints, 3);
                Ok::<_, StoreError>(())
            })
            .unwrap();
    }

    #[test]
    fn public_document_mutation_cannot_reactivate_a_tombstoned_identity() {
        let seeded = seeded_module();
        let original_block_id = seeded
            .kernel
            .readers()
            .read_default(|connection| {
                connection
                    .query_row(
                        "SELECT block_id FROM document_block_index \
                         WHERE document_id = ?1 ORDER BY ordinal LIMIT 1",
                        [DOCUMENT_ID],
                        |row| row.get::<_, String>(0),
                    )
                    .map_err(StoreError::from)
            })
            .unwrap();
        let replacement_root_id = "019bf52d-6870-7000-8000-000000000102";
        seeded
            .module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    operation_id: "document-operation:add-second-root".to_owned(),
                    store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
                    intent: OwnedDocumentIntent::ApplyOperationBatch {
                        document_id: DOCUMENT_ID.to_owned(),
                        generation: 1,
                        expected_head_seq: 1,
                        operations: vec![ContractDocumentBlockOperation::InsertBlock {
                            block: paragraph(replacement_root_id, "Replacement root"),
                            parent_block_id: None,
                            before_block_id: None,
                        }],
                        actor: json!({ "kind": "test" }),
                    },
                },
            )
            .expect("second editable root");
        seeded
            .module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    operation_id: "document-operation:delete-original".to_owned(),
                    store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
                    intent: OwnedDocumentIntent::ApplyOperationBatch {
                        document_id: DOCUMENT_ID.to_owned(),
                        generation: 1,
                        expected_head_seq: 2,
                        operations: vec![ContractDocumentBlockOperation::DeleteBlock {
                            block_id: original_block_id.clone(),
                        }],
                        actor: json!({ "kind": "test" }),
                    },
                },
            )
            .expect("delete original root");
        let reactivation = seeded
            .module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    operation_id: "document-operation:reactivate".to_owned(),
                    store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
                    intent: OwnedDocumentIntent::ApplyOperationBatch {
                        document_id: DOCUMENT_ID.to_owned(),
                        generation: 1,
                        expected_head_seq: 3,
                        operations: vec![ContractDocumentBlockOperation::InsertBlock {
                            block: paragraph(&original_block_id, "Reused identity"),
                            parent_block_id: None,
                            before_block_id: None,
                        }],
                        actor: json!({ "kind": "test" }),
                    },
                },
            )
            .expect_err("ordinary operations cannot reactivate tombstones");
        assert_eq!(reactivation.code, CoreErrorCode::InvalidInput);
        assert!(reactivation.message.contains("Duplicate Block identity"));
    }

    #[test]
    fn history_pagination_returns_and_verifies_the_exact_last_row_cursor() {
        let seeded = seeded_module();
        for (operation_id, label) in [
            ("checkpoint:cursor-a", "Cursor A"),
            ("checkpoint:cursor-b", "Cursor B"),
        ] {
            seeded
                .module
                .apply(
                    &context(),
                    ModuleApplyRequest {
                        contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                        operation_id: operation_id.to_owned(),
                        store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
                        intent: OwnedDocumentIntent::CreateCheckpoint {
                            document_id: DOCUMENT_ID.to_owned(),
                            generation: 1,
                            expected_head_seq: 1,
                            cause: "manual".to_owned(),
                            label: Some(label.to_owned()),
                            actor: serde_json::json!({ "kind": "test" }),
                            revision_kind: Some(DocumentRevisionKind::Manual),
                            source_mutation_id: None,
                            source_change_seq: None,
                        },
                    },
                )
                .expect("cursor checkpoint");
        }
        let first = seeded
            .module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    read: OwnedDocumentRead::ListVersions {
                        document_id: DOCUMENT_ID.to_owned(),
                        before: None,
                        limit: Some(1),
                    },
                },
            )
            .expect("first history page");
        let OwnedDocumentReadValue::Versions { items, next } = first.value else {
            panic!("expected first history page")
        };
        assert_eq!(items.len(), 1);
        let next = next.expect("exact next cursor");
        assert_eq!(
            next.base_head_seq,
            items[0]["baseHeadSeq"].as_i64().unwrap()
        );
        assert_eq!(next.created_at, items[0]["createdAt"].as_str().unwrap());
        assert_eq!(next.version_id, items[0]["versionId"].as_str().unwrap());

        let second = seeded
            .module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    read: OwnedDocumentRead::ListVersions {
                        document_id: DOCUMENT_ID.to_owned(),
                        before: Some(next),
                        limit: Some(1),
                    },
                },
            )
            .expect("second history page");
        let OwnedDocumentReadValue::Versions { items, next } = second.value else {
            panic!("expected second history page")
        };
        assert_eq!(items.len(), 1);
        assert!(next.is_none());
    }

    #[test]
    fn compaction_reconstructs_from_one_verified_snapshot_and_keeps_receipts() {
        let seeded = seeded_module();
        let update = title_update(
            &seeded.full_state,
            &seeded.state_vector,
            "Compacted authority",
        );
        let request = apply_request("update:before-compaction", 1, update);
        seeded.module.apply(&context(), request.clone()).unwrap();
        let compacted = seeded
            .module
            .compact(
                &context(),
                StoreEpoch(STORE_EPOCH.to_owned()),
                DOCUMENT_ID.to_owned(),
                1,
                2,
            )
            .expect("compact current head");
        assert_eq!(compacted.snapshot_seq, 2);
        assert_eq!(compacted.pruned_update_count, 2);
        assert_eq!(compacted.retained_receipt_count, 2);
        seeded
            .kernel
            .readers()
            .read_default(|connection| {
                let evidence: (i64, i64, i64) = connection.query_row(
                    "SELECT \
                       (SELECT count(*) FROM document_updates WHERE document_id = ?1), \
                       (SELECT count(*) FROM document_snapshots WHERE document_id = ?1), \
                       (SELECT count(*) FROM document_update_receipts WHERE document_id = ?1)",
                    [DOCUMENT_ID],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )?;
                assert_eq!(evidence, (0, 1, 2));
                Ok::<_, StoreError>(())
            })
            .unwrap();

        let cold_module = OwnedDocumentModule::new(PROFILE_ID, LIBRARY_ID, &seeded.kernel);
        let synced = cold_module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    read: OwnedDocumentRead::SyncYjs {
                        document_id: DOCUMENT_ID.to_owned(),
                        state_vector: Vec::new(),
                        history_after_head_seq: None,
                    },
                },
            )
            .expect("cold snapshot reconstruction");
        let OwnedDocumentReadValue::YjsSync { update, .. } = synced.value else {
            panic!("expected Yjs sync")
        };
        let engine = YrsDocumentEngine::from_full_state_v1(DOCUMENT_ID, &update).unwrap();
        assert_eq!(
            materialize_engine(&engine, BlockDocumentSchema::PageV3)
                .unwrap()
                .title,
            "Compacted authority"
        );
        let duplicate = cold_module.apply(&context(), request).unwrap();
        assert!(duplicate.committed.receipt.mutation.duplicate);
        let repeated = cold_module
            .compact(
                &context(),
                StoreEpoch(STORE_EPOCH.to_owned()),
                DOCUMENT_ID.to_owned(),
                1,
                2,
            )
            .expect("repeat compaction");
        assert_eq!(repeated.pruned_update_count, 0);
        assert_eq!(repeated.retained_receipt_count, 2);
    }

    #[test]
    fn exact_update_resource_read_verifies_identity_and_reports_compaction() {
        let seeded = seeded_module();
        let update = title_update(
            &seeded.full_state,
            &seeded.state_vector,
            "Exact update resource",
        );
        let update_hash = sha256(&update);
        seeded
            .module
            .apply(
                &context(),
                apply_request("update:exact-resource", 1, update.clone()),
            )
            .expect("commit exact resource");

        let exact = seeded
            .module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    read: OwnedDocumentRead::FetchUpdate {
                        document_id: DOCUMENT_ID.to_owned(),
                        generation: 1,
                        update_id: "update:exact-resource".to_owned(),
                        update_hash: update_hash.clone(),
                    },
                },
            )
            .expect("read exact update resource");
        let OwnedDocumentReadValue::UpdateResource { resource } = exact.value else {
            panic!("expected exact update resource")
        };
        assert_eq!(resource.base_head_seq, 1);
        assert_eq!(resource.head_seq, 2);
        assert_eq!(resource.update_hash, update_hash);
        assert_eq!(resource.update_byte_length, update.len() as i64);
        assert_eq!(resource.update, update);

        let mismatched = seeded
            .module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    read: OwnedDocumentRead::FetchUpdate {
                        document_id: DOCUMENT_ID.to_owned(),
                        generation: 1,
                        update_id: "update:exact-resource".to_owned(),
                        update_hash: "f".repeat(64),
                    },
                },
            )
            .expect("hash mismatch is a typed resync boundary");
        assert!(matches!(
            mismatched.value,
            OwnedDocumentReadValue::UpdateResourceUnavailable {
                unavailable: DocumentUpdateResourceUnavailable {
                    reason: DocumentUpdateResourceUnavailableReason::HashMismatch,
                    ..
                }
            }
        ));

        seeded
            .module
            .compact(
                &context(),
                StoreEpoch(STORE_EPOCH.to_owned()),
                DOCUMENT_ID.to_owned(),
                1,
                2,
            )
            .expect("compact exact resource");
        let compacted = seeded
            .module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    read: OwnedDocumentRead::FetchUpdate {
                        document_id: DOCUMENT_ID.to_owned(),
                        generation: 1,
                        update_id: "update:exact-resource".to_owned(),
                        update_hash,
                    },
                },
            )
            .expect("compacted resource is a typed resync boundary");
        assert!(matches!(
            compacted.value,
            OwnedDocumentReadValue::UpdateResourceUnavailable {
                unavailable: DocumentUpdateResourceUnavailable {
                    reason: DocumentUpdateResourceUnavailableReason::Compacted,
                    ..
                }
            }
        ));
    }

    #[test]
    fn checkpoint_creation_bounds_unpinned_revision_retention() {
        let seeded = seeded_module();
        seeded
            .module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    operation_id: "checkpoint:retention-base".to_owned(),
                    store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
                    intent: OwnedDocumentIntent::CreateCheckpoint {
                        document_id: DOCUMENT_ID.to_owned(),
                        generation: 1,
                        expected_head_seq: 1,
                        cause: "manual".to_owned(),
                        label: None,
                        actor: serde_json::json!({ "kind": "test" }),
                        revision_kind: Some(DocumentRevisionKind::Manual),
                        source_mutation_id: None,
                        source_change_seq: None,
                    },
                },
            )
            .unwrap();
        seeded
            .kernel
            .writer()
            .call(|connection| {
                with_immediate_transaction(connection, |transaction| {
                    transaction.execute_batch(
                        "WITH RECURSIVE sequence(value) AS (\
                           SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value < 501\
                         ) \
                         INSERT INTO document_versions(\
                           version_id, document_id, project_id, generation, base_head_seq, \
                           schema_key, schema_version, cause, label, actor_json, revision_kind, \
                           source_mutation_id, source_change_seq, pinned, checkpoint_format, \
                           full_update_blob, state_vector, checkpoint_hash, byte_length, created_at\
                         ) \
                         SELECT printf('retention:auto:%03d', sequence.value), version.document_id, \
                           version.project_id, version.generation, version.base_head_seq, \
                           version.schema_key, version.schema_version, 'automatic', NULL, '{}', \
                           'automatic', NULL, NULL, 0, version.checkpoint_format, \
                           version.full_update_blob, version.state_vector, version.checkpoint_hash, \
                           version.byte_length, version.created_at \
                         FROM sequence \
                         JOIN document_versions version \
                           ON version.version_id LIKE 'document-version:%' \
                         LIMIT 501;",
                    )?;
                    Ok(())
                })
            })
            .unwrap();
        seeded
            .module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    operation_id: "checkpoint:retention-prune".to_owned(),
                    store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
                    intent: OwnedDocumentIntent::CreateCheckpoint {
                        document_id: DOCUMENT_ID.to_owned(),
                        generation: 1,
                        expected_head_seq: 1,
                        cause: "manual".to_owned(),
                        label: Some("Retention boundary".to_owned()),
                        actor: serde_json::json!({ "kind": "test" }),
                        revision_kind: Some(DocumentRevisionKind::Manual),
                        source_mutation_id: None,
                        source_change_seq: None,
                    },
                },
            )
            .unwrap();
        seeded
            .kernel
            .readers()
            .read_default(|connection| {
                let counts: (i64, i64) = connection.query_row(
                    "SELECT \
                       sum(CASE WHEN pinned = 0 THEN 1 ELSE 0 END), \
                       sum(CASE WHEN pinned = 1 THEN 1 ELSE 0 END) \
                     FROM document_versions WHERE document_id = ?1",
                    [DOCUMENT_ID],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )?;
                assert_eq!(counts, (500, 2));
                Ok::<_, StoreError>(())
            })
            .unwrap();
    }

    #[test]
    fn revision_sessions_checkpoint_edit_burst_boundaries() {
        let seeded = seeded_module();
        let first_update = title_update(&seeded.full_state, &seeded.state_vector, "Burst one");
        let mut engine =
            YrsDocumentEngine::from_full_state_v1(DOCUMENT_ID, &seeded.full_state).unwrap();
        let first_candidate = engine.prepare_update_v1(&first_update).unwrap();
        engine.commit_candidate(first_candidate).unwrap();
        seeded
            .module
            .apply(
                &context(),
                apply_request("update:burst-one", 1, first_update),
            )
            .unwrap();
        let second_update = title_update(
            &engine.full_state_v1(),
            &engine.state_vector_v1(),
            "Burst two",
        );
        let second_candidate = engine.prepare_update_v1(&second_update).unwrap();
        engine.commit_candidate(second_candidate).unwrap();
        seeded
            .module
            .apply(
                &context(),
                apply_request("update:burst-two", 2, second_update),
            )
            .unwrap();
        seeded
            .kernel
            .writer()
            .call(|connection| {
                with_immediate_transaction(connection, |transaction| {
                    let evidence: (i64, i64) = transaction.query_row(
                        "SELECT \
                           (SELECT count(*) FROM document_versions WHERE document_id = ?1), \
                           (SELECT dirty_head_seq FROM document_revision_sessions \
                            WHERE document_id = ?1)",
                        [DOCUMENT_ID],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )?;
                    assert_eq!(evidence, (1, 3));
                    transaction.execute(
                        "UPDATE document_revision_sessions \
                         SET last_edit_at = '2020-01-01T00:00:00.000Z' \
                         WHERE document_id = ?1",
                        [DOCUMENT_ID],
                    )?;
                    Ok(())
                })
            })
            .unwrap();
        let third_update = title_update(
            &engine.full_state_v1(),
            &engine.state_vector_v1(),
            "Burst after idle",
        );
        seeded
            .module
            .apply(
                &context(),
                apply_request("update:after-idle", 3, third_update),
            )
            .unwrap();
        seeded
            .kernel
            .readers()
            .read_default(|connection| {
                let evidence: (i64, i64, i64) = connection.query_row(
                    "SELECT \
                       (SELECT count(*) FROM document_versions \
                        WHERE document_id = ?1 AND cause = 'before_edit_burst'), \
                       (SELECT count(*) FROM document_versions \
                        WHERE document_id = ?1 AND cause = 'idle_edit'), \
                       (SELECT dirty_head_seq FROM document_revision_sessions \
                        WHERE document_id = ?1)",
                    [DOCUMENT_ID],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )?;
                assert_eq!(evidence, (1, 1, 4));
                Ok::<_, StoreError>(())
            })
            .unwrap();
    }

    #[test]
    fn releasing_an_old_physical_lease_keeps_its_replacement_authorized() {
        let seeded = seeded_module();
        let realtime = super::super::OwnedDocumentRealtimeAdapter::new(seeded.module.clone());
        let bound = context();
        let first = realtime
            .subscribe(
                &bound,
                DOCUMENT_ID.to_owned(),
                "replacement-client".to_owned(),
            )
            .unwrap();
        let replacement = realtime
            .subscribe(
                &bound,
                DOCUMENT_ID.to_owned(),
                "replacement-client".to_owned(),
            )
            .unwrap();
        assert_ne!(first.lease_id, replacement.lease_id);
        realtime
            .release_lease(&bound.connection_id, "replacement-client", first.lease_id)
            .unwrap();
        assert!(
            realtime
                .require_subscription(&bound.connection_id, "replacement-client", DOCUMENT_ID)
                .is_ok()
        );
        realtime
            .release_lease(
                &bound.connection_id,
                "replacement-client",
                replacement.lease_id,
            )
            .unwrap();
        assert!(
            realtime
                .require_subscription(&bound.connection_id, "replacement-client", DOCUMENT_ID)
                .is_err()
        );
    }

    #[test]
    fn stale_yjs_updates_crossing_structural_barriers_become_recovery_artifacts() {
        let seeded = seeded_module();
        let materialization = materialize_engine(
            &YrsDocumentEngine::from_full_state_v1(DOCUMENT_ID, &seeded.full_state).unwrap(),
            BlockDocumentSchema::PageV3,
        )
        .unwrap();
        let title_etag = seeded
            .kernel
            .readers()
            .read_default(|connection| {
                Ok::<_, StoreError>(
                    super::super::semantic::mint_etag(
                        connection,
                        "title",
                        PROJECT_ID,
                        STORE_EPOCH,
                        &[DOCUMENT_ID],
                        json!({ "richTitle": materialization.rich_title }),
                    )
                    .unwrap(),
                )
            })
            .unwrap();
        let stale_update = title_update(
            &seeded.full_state,
            &seeded.state_vector,
            "Unsafe stale renderer title",
        );
        seeded
            .module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    operation_id: "semantic:title-barrier".to_owned(),
                    store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
                    intent: OwnedDocumentIntent::ApplySemanticMutation {
                        document_id: DOCUMENT_ID.to_owned(),
                        generation: 1,
                        expected_head_seq: 1,
                        commands: vec![DocumentSemanticCommand::SetTitle {
                            inline_markdown: "Authoritative semantic title".to_owned(),
                            expected_etag: title_etag,
                        }],
                    },
                },
            )
            .unwrap();
        let request = apply_request("update:stale-across-barrier", 1, stale_update);
        let recovery = seeded
            .module
            .apply(&context(), request.clone())
            .expect_err("stale structural update requires recovery");
        assert_eq!(
            recovery.code,
            CoreErrorCode::RevisionConflict,
            "{}",
            recovery.message
        );
        let CoreErrorRecovery::DocumentRecoveryArtifact {
            ref artifact_id,
            ref document_id,
            ref update_id,
            generation,
            ..
        } = recovery.recovery
        else {
            panic!("Structural rejection must include typed recovery evidence");
        };
        assert!(artifact_id.starts_with("document-recovery:"));
        assert_eq!(document_id, DOCUMENT_ID);
        assert_eq!(update_id, "update:stale-across-barrier");
        assert_eq!(generation, 1);
        let artifact_read = OwnedDocumentRead::RecoveryArtifact {
            document_id: DOCUMENT_ID.to_owned(),
            artifact_id: artifact_id.clone(),
            store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
            generation: 1,
        };
        let snapshot = seeded
            .module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    read: artifact_read.clone(),
                },
            )
            .unwrap();
        let OwnedDocumentReadValue::RecoveryArtifact { artifact } = snapshot.value else {
            panic!("Expected recovery artifact");
        };
        assert_eq!(artifact.update_id, "update:stale-across-barrier");
        assert!(!artifact.update.is_empty());
        assert_eq!(artifact.update_hash, sha256(&artifact.update));
        let mut denied = context();
        denied.project_id = Some(nodex_core_contracts::ProjectId(
            "project:unrelated".to_owned(),
        ));
        assert!(
            seeded
                .module
                .read(
                    &denied,
                    ModuleReadRequest {
                        contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                        read: artifact_read
                    }
                )
                .is_err()
        );
        let repeated = seeded
            .module
            .apply(&context(), request.clone())
            .expect_err("recovery decision is durable");
        assert_eq!(repeated.message, recovery.message);
        assert_eq!(repeated.recovery, recovery.recovery);
        let mut changed_request = request;
        let OwnedDocumentIntent::ApplyYjsUpdate { update, .. } = &mut changed_request.intent else {
            unreachable!()
        };
        update.push(0);
        let collision = seeded
            .module
            .apply(&context(), changed_request)
            .expect_err("recovery update identity is immutable");
        assert_eq!(collision.code, CoreErrorCode::IdempotencyKeyReused);
        seeded
            .kernel
            .readers()
            .read_default(|connection| {
                let evidence: (i64, i64, i64, String) = connection.query_row(
                    "SELECT \
                       (SELECT head_seq FROM documents WHERE id = ?1), \
                       (SELECT count(*) FROM document_structural_barriers WHERE document_id = ?1), \
                       (SELECT count(*) FROM document_update_receipts \
                        WHERE update_id = 'update:stale-across-barrier'), \
                       (SELECT status FROM document_recovery_artifacts \
                        WHERE update_id = 'update:stale-across-barrier')",
                    [DOCUMENT_ID],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )?;
                assert_eq!(evidence, (2, 1, 0, "pending".to_owned()));
                Ok::<_, StoreError>(())
            })
            .unwrap();
    }

    #[test]
    fn stale_touch_attribution_includes_blocks_hidden_by_a_structural_barrier() {
        let seeded = seeded_module();
        let hidden_block_id = "019bf52d-6870-7000-8000-000000000124";
        let initial = materialize_engine(
            &YrsDocumentEngine::from_full_state_v1(DOCUMENT_ID, &seeded.full_state).unwrap(),
            BlockDocumentSchema::PageV3,
        )
        .unwrap();
        let visible_block_id = initial.block_tree[0].id.clone();
        seeded
            .module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    operation_id: "document-operation:seed-stale-hidden-block".to_owned(),
                    store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
                    intent: OwnedDocumentIntent::ApplyOperationBatch {
                        document_id: DOCUMENT_ID.to_owned(),
                        generation: 1,
                        expected_head_seq: 1,
                        operations: vec![ContractDocumentBlockOperation::InsertBlock {
                            block: paragraph(hidden_block_id, "Soon hidden"),
                            parent_block_id: None,
                            before_block_id: None,
                        }],
                        actor: json!({ "kind": "test" }),
                    },
                },
            )
            .expect("seed Block that will cross a barrier");
        let (base_head_seq, base_engine) = synced_page_engine(&seeded);
        assert_eq!(base_head_seq, 2);
        let patch = |text: &str| DocumentBlockUpdatePatch {
            block_type: None,
            props: None,
            content: Some(json!([{
                "type": "text",
                "text": text,
                "styles": {},
            }])),
            unset_content: false,
        };
        let mixed_stale_update = raw_document_operation_update(
            &base_engine,
            &[
                DocumentBlockOperation::UpdateBlock {
                    block_id: visible_block_id.clone(),
                    patch: patch("Visible stale edit"),
                },
                DocumentBlockOperation::UpdateBlock {
                    block_id: hidden_block_id.to_owned(),
                    patch: patch("Hidden stale edit"),
                },
            ],
        );
        let visible_only_stale_update = raw_document_operation_update(
            &base_engine,
            &[DocumentBlockOperation::UpdateBlock {
                block_id: visible_block_id.clone(),
                patch: patch("Safe disjoint stale edit"),
            }],
        );
        seeded
            .module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    operation_id: "document-operation:hide-stale-target".to_owned(),
                    store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
                    intent: OwnedDocumentIntent::ApplyOperationBatch {
                        document_id: DOCUMENT_ID.to_owned(),
                        generation: 1,
                        expected_head_seq: base_head_seq,
                        operations: vec![ContractDocumentBlockOperation::DeleteBlock {
                            block_id: hidden_block_id.to_owned(),
                        }],
                        actor: json!({ "kind": "test" }),
                    },
                },
            )
            .expect("delete Block behind a structural barrier");

        let mixed_request = ModuleApplyRequest {
            contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
            operation_id: "update:stale-hidden-and-visible".to_owned(),
            store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
            intent: OwnedDocumentIntent::ApplyYjsUpdate {
                document_id: DOCUMENT_ID.to_owned(),
                generation: 1,
                base_head_seq,
                update_id: "update:stale-hidden-and-visible".to_owned(),
                touched_block_ids: vec![visible_block_id.clone()],
                update: mixed_stale_update,
            },
        };
        let recovery = seeded
            .module
            .apply(&context(), mixed_request)
            .expect_err("base-head attribution catches the hidden fenced edit");
        assert_eq!(recovery.code, CoreErrorCode::RevisionConflict);

        let safe = seeded
            .module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    operation_id: "update:stale-visible-only".to_owned(),
                    store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
                    intent: OwnedDocumentIntent::ApplyYjsUpdate {
                        document_id: DOCUMENT_ID.to_owned(),
                        generation: 1,
                        base_head_seq,
                        update_id: "update:stale-visible-only".to_owned(),
                        touched_block_ids: vec![visible_block_id.clone()],
                        update: visible_only_stale_update,
                    },
                },
            )
            .expect("truly disjoint stale edit remains merge-friendly");
        assert_eq!(safe.committed.value.head_seq, 4);

        seeded
            .kernel
            .readers()
            .read_default(|connection| {
                let (head_seq, derived_json, artifact_status, hidden_index_count) = connection
                    .query_row(
                        "SELECT document.head_seq, artifact.derived_touched_block_ids_json, \
                                artifact.status, \
                                (SELECT count(*) FROM document_block_index \
                                  WHERE block_id = ?2) \
                         FROM documents document \
                         JOIN document_recovery_artifacts artifact \
                           ON artifact.document_id = document.id \
                          AND artifact.update_id = 'update:stale-hidden-and-visible' \
                         WHERE document.id = ?1",
                        params![DOCUMENT_ID, hidden_block_id],
                        |row| {
                            Ok((
                                row.get::<_, i64>(0)?,
                                row.get::<_, String>(1)?,
                                row.get::<_, String>(2)?,
                                row.get::<_, i64>(3)?,
                            ))
                        },
                    )?;
                let derived = serde_json::from_str::<BTreeSet<String>>(&derived_json)
                    .map_err(|_| internal("recovery derived touched IDs"))?;
                assert_eq!(head_seq, 4);
                assert_eq!(artifact_status, "pending");
                assert_eq!(hidden_index_count, 0);
                assert!(derived.contains(&visible_block_id));
                assert!(derived.contains(hidden_block_id));
                Ok::<_, StoreError>(())
            })
            .expect("base and current attribution evidence");
    }

    #[test]
    fn whole_document_replacement_fences_disjoint_stale_insertions() {
        let seeded = seeded_module();
        let stale_block_id = "019bf52d-6870-7000-8000-000000000123";
        let stale_engine = YrsDocumentEngine::from_full_state_v1(DOCUMENT_ID, &seeded.full_state)
            .expect("stale renderer state");
        let stale_update = raw_document_operation_update(
            &stale_engine,
            &[DocumentBlockOperation::InsertBlock {
                block: MaterializedBlockNode {
                    id: stale_block_id.to_owned(),
                    block_type: "paragraph".to_owned(),
                    props: BTreeMap::new(),
                    content: Some(json!([{
                        "type": "text",
                        "text": "Stale disjoint insertion",
                        "styles": {},
                    }])),
                    children: Vec::new(),
                },
                parent_block_id: None,
                before_block_id: None,
            }],
        );
        let current_nfm = seeded
            .kernel
            .readers()
            .read_default(|connection| {
                connection
                    .query_row(
                        "SELECT nfm FROM document_materializations WHERE document_id = ?1",
                        [DOCUMENT_ID],
                        |row| row.get::<_, String>(0),
                    )
                    .map_err(StoreError::from)
            })
            .expect("current NFM");
        seeded
            .module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    operation_id: "document-operation:whole-document-fence".to_owned(),
                    store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
                    intent: OwnedDocumentIntent::ReplaceFromNfm {
                        document_id: DOCUMENT_ID.to_owned(),
                        generation: 1,
                        expected_head_seq: 1,
                        nfm: current_nfm,
                        rich_title: Some(vec![json!({
                            "type": "text",
                            "text": "Whole document replacement",
                            "styles": {},
                        })]),
                        actor: json!({ "kind": "test" }),
                    },
                },
            )
            .expect("whole-Document replacement");

        let recovery = seeded
            .module
            .apply(
                &context(),
                apply_request("update:stale-disjoint-insertion", 1, stale_update),
            )
            .expect_err("whole-Document fence rejects disjoint stale insertions");
        assert_eq!(recovery.code, CoreErrorCode::RevisionConflict);
        assert!(matches!(
            recovery.recovery,
            CoreErrorRecovery::DocumentRecoveryArtifact { .. }
        ));
        seeded
            .kernel
            .readers()
            .read_default(|connection| {
                let evidence = connection.query_row(
                    "SELECT document.head_seq, \
                            (SELECT count(*) FROM document_block_index \
                              WHERE block_id = ?2), \
                            barrier.document_wide_fence, \
                            (SELECT status FROM document_recovery_artifacts \
                              WHERE update_id = 'update:stale-disjoint-insertion') \
                     FROM documents document \
                     JOIN document_structural_barriers barrier \
                       ON barrier.document_id = document.id AND barrier.head_seq = document.head_seq \
                     WHERE document.id = ?1",
                    params![DOCUMENT_ID, stale_block_id],
                    |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, i64>(1)?,
                            row.get::<_, i64>(2)?,
                            row.get::<_, String>(3)?,
                        ))
                    },
                )?;
                assert_eq!(evidence, (2, 0, 1, "pending".to_owned()));
                Ok::<_, StoreError>(())
            })
            .expect("whole-Document recovery evidence");
    }

    #[test]
    fn prepared_agent_semantic_operation_binds_turn_connection_and_exact_receipt() {
        let seeded = seeded_module();
        let connection_id = "electron:agent-prepared";
        let provenance = seed_agent_turn(&seeded, connection_id);
        let materialization = materialize_engine(
            &YrsDocumentEngine::from_full_state_v1(DOCUMENT_ID, &seeded.full_state).unwrap(),
            BlockDocumentSchema::PageV3,
        )
        .unwrap();
        let title_etag = seeded
            .kernel
            .readers()
            .read_default(|connection| {
                super::super::semantic::mint_etag(
                    connection,
                    "title",
                    PROJECT_ID,
                    STORE_EPOCH,
                    &[DOCUMENT_ID],
                    json!({ "richTitle": materialization.rich_title }),
                )
                .map_err(semantic_error)
            })
            .unwrap();
        let operation_id = "agent:semantic-title";
        let mutation = AgentDocumentSemanticMutation {
            document_id: DOCUMENT_ID.to_owned(),
            generation: 1,
            expected_head_seq: 1,
            commands: vec![DocumentSemanticCommand::SetTitle {
                inline_markdown: "Prepared Agent authority".to_owned(),
                expected_etag: title_etag,
            }],
        };
        let prepared = seeded
            .module
            .read(
                &context_for(connection_id),
                ModuleReadRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    read: OwnedDocumentRead::PrepareAgentSemanticMutation {
                        operation_id: operation_id.to_owned(),
                        store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
                        authorization: Box::new(agent_execution_authorization(provenance.clone())),
                        mutation: Box::new(mutation.clone()),
                    },
                },
            )
            .expect("mutation-free Agent preflight");
        let OwnedDocumentReadValue::AgentSemanticMutationPreparation {
            preparation,
            committed: None,
        } = prepared.value
        else {
            panic!("expected a new prepared Agent operation")
        };
        assert_eq!(preparation.state, AgentOperationPreparationState::Prepared);
        assert_eq!(preparation.consent, AgentConsentRequirement::None);
        assert_eq!(preparation.footprint.effect_class, AgentEffectClass::Write);
        assert_eq!(preparation.footprint.targets[0].id, OWNER_BLOCK_ID);
        assert!(preparation.footprint.created_roots.is_empty());
        assert_eq!(
            preparation.footprint.updated_roots,
            vec![OWNER_BLOCK_ID.to_owned()]
        );
        let token = preparation.token.expect("single-use token");
        seeded
            .kernel
            .readers()
            .read_default(|connection| {
                let evidence: (i64, i64) = connection.query_row(
                    "SELECT \
                       (SELECT head_seq FROM documents WHERE id = ?1), \
                       (SELECT count(*) FROM core_module_receipts WHERE operation_id = ?2)",
                    params![DOCUMENT_ID, operation_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )?;
                assert_eq!(evidence, (1, 0));
                Ok::<_, StoreError>(())
            })
            .unwrap();

        let execute = |token: Option<String>| ModuleApplyRequest {
            contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
            operation_id: operation_id.to_owned(),
            store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
            intent: OwnedDocumentIntent::ExecutePreparedAgentSemanticMutation {
                authorization: Box::new(AgentPreparedExecution {
                    authorization: agent_execution_authorization(provenance.clone()),
                    token,
                }),
                mutation: Box::new(mutation.clone()),
            },
        };
        let wrong_connection = seeded
            .module
            .apply(&context_for("electron:other"), execute(Some(token.clone())))
            .expect_err("token is bound to its connection");
        assert_eq!(wrong_connection.code, CoreErrorCode::RevisionConflict);

        let committed = seeded
            .module
            .apply(&context_for(connection_id), execute(Some(token)))
            .expect("execute exact prepared operation");
        assert_eq!(committed.committed.value.head_seq, 2);
        assert!(!committed.committed.receipt.mutation.duplicate);
        let mutation_effect = committed
            .committed
            .value
            .mutation_effect
            .as_ref()
            .expect("prepared Agent commit returns its exact Block effect");
        assert!(mutation_effect.title_changed);
        assert_eq!(
            mutation_effect.touched_block_ids,
            vec![OWNER_BLOCK_ID.to_owned()]
        );
        let semantic_etags = committed
            .committed
            .value
            .semantic_etags
            .clone()
            .expect("prepared Agent commit returns semantic ETags");
        assert!(semantic_etags.title.starts_with("nxe1."));
        assert!(semantic_etags.body.starts_with("nxe1."));
        let duplicate = seeded
            .module
            .apply(&context_for(connection_id), execute(None))
            .expect("durable receipt replay needs no fresh token");
        assert!(duplicate.committed.receipt.mutation.duplicate);
        assert_eq!(
            duplicate.committed.value.semantic_etags,
            Some(semantic_etags)
        );
        assert!(duplicate.events.is_empty());

        let replay = seeded
            .module
            .read(
                &context_for(connection_id),
                ModuleReadRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    read: OwnedDocumentRead::PrepareAgentSemanticMutation {
                        operation_id: operation_id.to_owned(),
                        store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
                        authorization: Box::new(agent_execution_authorization(provenance)),
                        mutation: Box::new(mutation),
                    },
                },
            )
            .expect("preflight recognizes exact committed receipt");
        let OwnedDocumentReadValue::AgentSemanticMutationPreparation {
            preparation,
            committed: Some(replayed),
        } = replay.value
        else {
            panic!("expected a committed Agent replay")
        };
        assert_eq!(
            preparation.state,
            AgentOperationPreparationState::CommittedReplay
        );
        assert!(preparation.token.is_none());
        assert!(replayed.receipt().mutation.duplicate);
        seeded
            .kernel
            .readers()
            .read_default(|connection| {
                let evidence: (String, i64, i64) = connection.query_row(
                    "SELECT materialization.title, \
                       (SELECT count(*) FROM core_module_receipts WHERE operation_id = ?2), \
                       (SELECT count(*) FROM change_log WHERE operation_id = ?2) \
                     FROM document_materializations materialization WHERE document_id = ?1",
                    params![DOCUMENT_ID, operation_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )?;
                assert_eq!(evidence, ("Prepared Agent authority".to_owned(), 1, 1));
                let adapter: String = connection.query_row(
                    "SELECT adapter_kind FROM core_module_receipts \
                     WHERE module_name = 'owned_document' AND operation_id = ?1",
                    [operation_id],
                    |row| row.get(0),
                )?;
                assert_eq!(adapter, "agent");
                Ok::<_, StoreError>(())
            })
            .unwrap();
    }

    #[test]
    fn prepared_agent_body_insertion_promotes_the_empty_seed_with_a_write_fence() {
        let seeded = seeded_module();
        let initial = materialize_engine(
            &YrsDocumentEngine::from_full_state_v1(DOCUMENT_ID, &seeded.full_state).unwrap(),
            BlockDocumentSchema::PageV3,
        )
        .unwrap();
        let seed_id = initial.block_tree[0].id.clone();
        let connection_id = "electron:agent-insert";
        let provenance = seed_agent_turn(&seeded, connection_id);
        let operation_id = "agent:semantic-insert";
        let mutation = AgentDocumentSemanticMutation {
            document_id: DOCUMENT_ID.to_owned(),
            generation: 1,
            expected_head_seq: 1,
            commands: vec![DocumentSemanticCommand::InsertBody {
                anchor: DocumentSemanticAnchor::End {
                    parent_block_id: None,
                },
                nested_markdown: "Inserted by Agent".to_owned(),
            }],
        };
        let prepared = seeded
            .module
            .read(
                &context_for(connection_id),
                ModuleReadRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    read: OwnedDocumentRead::PrepareAgentSemanticMutation {
                        operation_id: operation_id.to_owned(),
                        store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
                        authorization: Box::new(agent_execution_authorization(provenance.clone())),
                        mutation: Box::new(mutation.clone()),
                    },
                },
            )
            .expect("prepare body insertion");
        let OwnedDocumentReadValue::AgentSemanticMutationPreparation {
            preparation,
            committed: None,
        } = prepared.value
        else {
            panic!("expected prepared body insertion")
        };
        assert_eq!(preparation.footprint.effect_class, AgentEffectClass::Write);
        assert!(preparation.footprint.created_roots.is_empty());
        assert!(preparation.footprint.updated_roots.contains(&seed_id));
        assert!(preparation.footprint.deleted_roots.is_empty());
        let preview = preparation
            .preview_markdown
            .as_deref()
            .expect("insertion preflight returns canonical preview");
        assert_eq!(preview, "Inserted by Agent");
        let committed = seeded
            .module
            .apply(
                &context_for(connection_id),
                ModuleApplyRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    operation_id: operation_id.to_owned(),
                    store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
                    intent: OwnedDocumentIntent::ExecutePreparedAgentSemanticMutation {
                        authorization: Box::new(AgentPreparedExecution {
                            authorization: agent_execution_authorization(provenance),
                            token: preparation.token,
                        }),
                        mutation: Box::new(mutation),
                    },
                },
            )
            .expect("commit body insertion");
        let effect = committed
            .committed
            .value
            .mutation_effect
            .expect("insertion returns exact effect");
        assert!(effect.created_block_ids.is_empty());
        assert_eq!(
            effect.updated_block_ids.as_slice(),
            std::slice::from_ref(&seed_id)
        );
        assert!(effect.deleted_block_ids.is_empty());
        assert_eq!(
            effect.write_fence_block_ids.as_slice(),
            std::slice::from_ref(&seed_id)
        );
        assert_eq!(
            effect.coordination,
            DocumentMutationCoordination::WriteFence
        );
        assert!(!effect.title_changed);
        seeded
            .kernel
            .readers()
            .read_default(|connection| {
                let (nfm, block_tree_json): (String, String) = connection.query_row(
                    "SELECT nfm, block_tree_json FROM document_materializations WHERE document_id = ?1",
                    [DOCUMENT_ID],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )?;
                let block_tree: Vec<MaterializedBlockNode> =
                    serde_json::from_str(&block_tree_json)
                        .map_err(|_| internal("seed promotion Block tree JSON"))?;
                assert_eq!(nfm, "Inserted by Agent");
                assert_eq!(block_tree[0].id, seed_id);
                Ok::<_, StoreError>(())
            })
            .unwrap();
    }

    #[test]
    fn prepared_empty_seed_promotion_rejects_missing_or_stale_fence_authority() {
        let seeded = seeded_module();
        let initial = materialize_engine(
            &YrsDocumentEngine::from_full_state_v1(DOCUMENT_ID, &seeded.full_state).unwrap(),
            BlockDocumentSchema::PageV3,
        )
        .unwrap();
        let seed_id = initial.block_tree[0].id.clone();
        let connection_id = "electron:agent-seed-fence";
        let provenance = seed_agent_turn(&seeded, connection_id);
        let mutation = AgentDocumentSemanticMutation {
            document_id: DOCUMENT_ID.to_owned(),
            generation: 1,
            expected_head_seq: 1,
            commands: vec![DocumentSemanticCommand::InsertBody {
                anchor: DocumentSemanticAnchor::End {
                    parent_block_id: None,
                },
                nested_markdown: "Agent content".to_owned(),
            }],
        };
        let prepare = |operation_id: &str| {
            seeded.module.read(
                &context_for(connection_id),
                ModuleReadRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    read: OwnedDocumentRead::PrepareAgentSemanticMutation {
                        operation_id: operation_id.to_owned(),
                        store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
                        authorization: Box::new(agent_execution_authorization(provenance.clone())),
                        mutation: Box::new(mutation.clone()),
                    },
                },
            )
        };
        let missing_fence = prepare("agent:seed-fence-missing").expect("prepare promotion");
        let OwnedDocumentReadValue::AgentSemanticMutationPreparation {
            preparation: missing_fence,
            committed: None,
        } = missing_fence.value
        else {
            panic!("expected prepared promotion")
        };
        let error = seeded
            .module
            .apply(
                &context_for(connection_id),
                ModuleApplyRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    operation_id: "agent:seed-fence-missing".to_owned(),
                    store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
                    intent: OwnedDocumentIntent::ExecutePreparedAgentSemanticMutation {
                        authorization: Box::new(AgentPreparedExecution {
                            authorization: agent_execution_authorization(provenance.clone()),
                            token: None,
                        }),
                        mutation: Box::new(mutation.clone()),
                    },
                },
            )
            .expect_err("promotion execution requires its prepared fence token");
        assert_eq!(error.code, CoreErrorCode::RevisionConflict);
        assert!(missing_fence.token.is_some());

        let stale = prepare("agent:seed-fence-stale").expect("prepare stale promotion");
        let OwnedDocumentReadValue::AgentSemanticMutationPreparation {
            preparation: stale,
            committed: None,
        } = stale.value
        else {
            panic!("expected prepared stale promotion")
        };
        seeded
            .module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    operation_id: "renderer:edit-seed-before-agent".to_owned(),
                    store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
                    intent: OwnedDocumentIntent::ApplyOperationBatch {
                        document_id: DOCUMENT_ID.to_owned(),
                        generation: 1,
                        expected_head_seq: 1,
                        operations: vec![ContractDocumentBlockOperation::UpdateBlock {
                            block_id: seed_id,
                            patch: ContractDocumentBlockUpdatePatch {
                                block_type: None,
                                props: None,
                                content: DocumentOptionalValue::Value {
                                    value: json!([{
                                        "type": "text",
                                        "text": "Renderer content",
                                        "styles": {},
                                    }]),
                                },
                                unset_content: false,
                            },
                        }],
                        actor: json!({ "kind": "electron_renderer" }),
                    },
                },
            )
            .expect("renderer updates seed under a current fence");
        let error = seeded
            .module
            .apply(
                &context_for(connection_id),
                ModuleApplyRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    operation_id: "agent:seed-fence-stale".to_owned(),
                    store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
                    intent: OwnedDocumentIntent::ExecutePreparedAgentSemanticMutation {
                        authorization: Box::new(AgentPreparedExecution {
                            authorization: agent_execution_authorization(provenance),
                            token: stale.token,
                        }),
                        mutation: Box::new(mutation),
                    },
                },
            )
            .expect_err("stale promotion must not overwrite renderer content");
        assert_eq!(error.code, CoreErrorCode::RevisionConflict);
        seeded
            .kernel
            .readers()
            .read_default(|connection| {
                let nfm: String = connection.query_row(
                    "SELECT nfm FROM document_materializations WHERE document_id = ?1",
                    [DOCUMENT_ID],
                    |row| row.get(0),
                )?;
                assert_eq!(nfm, "Renderer content");
                Ok::<_, StoreError>(())
            })
            .unwrap();
    }

    #[test]
    fn whitespace_fragment_is_rejected_without_a_document_commit() {
        let seeded = seeded_module();
        let operation_id = "semantic:whitespace-fragment";
        let error = seeded
            .module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    operation_id: operation_id.to_owned(),
                    store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
                    intent: OwnedDocumentIntent::ApplySemanticMutation {
                        document_id: DOCUMENT_ID.to_owned(),
                        generation: 1,
                        expected_head_seq: 1,
                        commands: vec![DocumentSemanticCommand::InsertBody {
                            anchor: DocumentSemanticAnchor::End {
                                parent_block_id: None,
                            },
                            nested_markdown: "\n \t\n".to_owned(),
                        }],
                    },
                },
            )
            .expect_err("whitespace-only Fragment");
        assert_eq!(error.code, CoreErrorCode::InvalidInput);
        assert!(error.message.contains("<empty-block/>"));
        seeded
            .kernel
            .readers()
            .read_default(|connection| {
                let evidence: (i64, String, i64, i64) = connection.query_row(
                    "SELECT document.head_seq, materialization.nfm, \
                       (SELECT count(*) FROM core_module_receipts WHERE operation_id = ?2), \
                       (SELECT count(*) FROM change_log WHERE operation_id = ?2) \
                     FROM documents document \
                     JOIN document_materializations materialization ON materialization.document_id = document.id \
                     WHERE document.id = ?1",
                    params![DOCUMENT_ID, operation_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )?;
                assert_eq!(evidence, (1, String::new(), 0, 0));
                Ok::<_, StoreError>(())
            })
            .unwrap();
    }

    #[test]
    fn explicit_empty_fragment_and_multiple_insertions_preserve_seed_claim_rules() {
        let seeded = seeded_module();
        let initial = materialize_engine(
            &YrsDocumentEngine::from_full_state_v1(DOCUMENT_ID, &seeded.full_state).unwrap(),
            BlockDocumentSchema::PageV3,
        )
        .unwrap();
        let seed_id = initial.block_tree[0].id.clone();
        let committed = seeded
            .module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    operation_id: "semantic:multiple-insertions".to_owned(),
                    store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
                    intent: OwnedDocumentIntent::ApplySemanticMutation {
                        document_id: DOCUMENT_ID.to_owned(),
                        generation: 1,
                        expected_head_seq: 1,
                        commands: vec![
                            DocumentSemanticCommand::InsertBody {
                                anchor: DocumentSemanticAnchor::End {
                                    parent_block_id: None,
                                },
                                nested_markdown: "<empty-block/>".to_owned(),
                            },
                            DocumentSemanticCommand::InsertBody {
                                anchor: DocumentSemanticAnchor::End {
                                    parent_block_id: None,
                                },
                                nested_markdown: "First".to_owned(),
                            },
                            DocumentSemanticCommand::InsertBody {
                                anchor: DocumentSemanticAnchor::End {
                                    parent_block_id: None,
                                },
                                nested_markdown: "Second".to_owned(),
                            },
                        ],
                    },
                },
            )
            .expect("multiple InsertBody commands");
        let effect = committed
            .committed
            .value
            .mutation_effect
            .expect("multiple insertion effect");
        assert_eq!(
            effect.updated_block_ids.as_slice(),
            std::slice::from_ref(&seed_id)
        );
        assert_eq!(effect.created_block_ids.len(), 1);
        assert!(effect.deleted_block_ids.is_empty());
        assert_eq!(
            effect.coordination,
            DocumentMutationCoordination::WriteFence
        );
        let (nfm, block_tree) = persisted_body(&seeded);
        assert_eq!(nfm, "First\nSecond");
        assert_eq!(block_tree[0].id, seed_id);

        let explicit = seeded_module();
        let initial = materialize_engine(
            &YrsDocumentEngine::from_full_state_v1(DOCUMENT_ID, &explicit.full_state).unwrap(),
            BlockDocumentSchema::PageV3,
        )
        .unwrap();
        let explicit_seed_id = initial.block_tree[0].id.clone();
        let committed = explicit
            .module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    operation_id: "semantic:explicit-empty-first".to_owned(),
                    store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
                    intent: OwnedDocumentIntent::ApplySemanticMutation {
                        document_id: DOCUMENT_ID.to_owned(),
                        generation: 1,
                        expected_head_seq: 1,
                        commands: vec![DocumentSemanticCommand::InsertBody {
                            anchor: DocumentSemanticAnchor::End {
                                parent_block_id: None,
                            },
                            nested_markdown: "<empty-block/>\nHello".to_owned(),
                        }],
                    },
                },
            )
            .expect("explicit empty Block Fragment");
        assert_eq!(committed.committed.value.head_seq, 2);
        let (nfm, block_tree) = persisted_body(&explicit);
        assert_eq!(nfm, "<empty-block/>\nHello");
        assert_eq!(block_tree[0].id, explicit_seed_id);
        assert_eq!(block_tree.len(), 2);
    }

    #[test]
    fn singleton_explicit_empty_fragment_is_a_no_change() {
        let seeded = seeded_module();
        let committed = seeded
            .module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    operation_id: "semantic:explicit-empty-no-change".to_owned(),
                    store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
                    intent: OwnedDocumentIntent::ApplySemanticMutation {
                        document_id: DOCUMENT_ID.to_owned(),
                        generation: 1,
                        expected_head_seq: 1,
                        commands: vec![DocumentSemanticCommand::InsertBody {
                            anchor: DocumentSemanticAnchor::End {
                                parent_block_id: None,
                            },
                            nested_markdown: "<empty-block/>".to_owned(),
                        }],
                    },
                },
            )
            .expect("explicit empty Block no-op");

        assert_eq!(
            committed.committed.value.outcome,
            DocumentCommitOutcome::NoChange
        );
        assert_eq!(committed.committed.value.head_seq, 1);
        assert!(committed.committed.value.mutation_effect.is_none());
        assert!(committed.events.is_empty());
    }

    #[test]
    fn agent_semantic_footprint_rejects_every_generic_typed_owner_deletion() {
        let fixture = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/yjs-yrs/empty-page.bin");
        let full_state = fs::read(fixture).expect("empty Page fixture");
        let engine =
            YrsDocumentEngine::from_full_state_v1(DOCUMENT_ID, &full_state).expect("Page engine");
        for owner_type in TYPED_CREATION_BLOCK_TYPES {
            let mut materialization = materialize_engine(&engine, BlockDocumentSchema::PageV3)
                .expect("Page materialization");
            let owner_block = materialization
                .search_units
                .first_mut()
                .expect("fixture contains a body Block");
            owner_block.block_type = (*owner_type).to_owned();
            let owner_block_id = owner_block.block_id.clone();
            let commands = vec![DocumentSemanticCommand::DeleteBlock {
                block_id: owner_block_id.clone(),
                expected_etag: "nxe1.test".to_owned(),
            }];
            let footprint =
                agent_semantic_footprint(OWNER_BLOCK_ID, &commands, &materialization, None)
                    .expect("classify Agent deletion");
            assert_eq!(footprint.deleted_owner_roots, vec![owner_block_id]);

            let error = assert_agent_owner_deletion_forbidden(&footprint)
                .expect_err("typed owner deletion requires a lifecycle operation");
            assert_eq!(error.code, StoreErrorCode::ProtectedOwnerDeletion);
        }
    }

    #[test]
    fn agent_semantic_footprint_rejects_anchors_inside_every_typed_owner() {
        let fixture = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/yjs-yrs/empty-page.bin");
        let full_state = fs::read(fixture).expect("empty Page fixture");
        let engine =
            YrsDocumentEngine::from_full_state_v1(DOCUMENT_ID, &full_state).expect("Page engine");
        for owner_type in TYPED_CREATION_BLOCK_TYPES {
            let mut materialization = materialize_engine(&engine, BlockDocumentSchema::PageV3)
                .expect("Page materialization");
            let owner_block = materialization
                .search_units
                .first_mut()
                .expect("fixture contains a body Block");
            owner_block.block_type = (*owner_type).to_owned();
            let owner_block_id = owner_block.block_id.clone();
            let mut ordinary_block = owner_block.clone();
            ordinary_block.block_id = "ordinary-block".to_owned();
            ordinary_block.block_type = "paragraph".to_owned();
            materialization.search_units.push(ordinary_block);

            for command in [
                DocumentSemanticCommand::InsertBody {
                    anchor: DocumentSemanticAnchor::End {
                        parent_block_id: Some(owner_block_id.clone()),
                    },
                    nested_markdown: "Child".to_owned(),
                },
                DocumentSemanticCommand::MoveBlock {
                    block_id: "ordinary-block".to_owned(),
                    anchor: DocumentSemanticAnchor::End {
                        parent_block_id: Some(owner_block_id.clone()),
                    },
                },
            ] {
                let error =
                    agent_semantic_footprint(OWNER_BLOCK_ID, &[command], &materialization, None)
                        .expect_err("Agent anchors cannot target typed owner shells");
                assert_eq!(error.code, StoreErrorCode::InvalidInput);
            }
            for command in [
                DocumentSemanticCommand::InsertBlock {
                    anchor: DocumentSemanticAnchor::End {
                        parent_block_id: None,
                    },
                    block: DocumentSemanticBlockDraft {
                        local_id: "typed-owner".to_owned(),
                        block_type: (*owner_type).to_owned(),
                        props: BTreeMap::new(),
                        content: DocumentOptionalValue::Absent,
                        children: Vec::new(),
                    },
                },
                DocumentSemanticCommand::UpdateBlock {
                    block_id: owner_block_id.clone(),
                    expected_etag: "nxe1.test".to_owned(),
                    patch: ContractDocumentBlockUpdatePatch {
                        block_type: None,
                        props: Some(BTreeMap::new()),
                        content: DocumentOptionalValue::Absent,
                        unset_content: false,
                    },
                },
                DocumentSemanticCommand::MoveBlock {
                    block_id: owner_block_id.clone(),
                    anchor: DocumentSemanticAnchor::End {
                        parent_block_id: None,
                    },
                },
            ] {
                let error =
                    agent_semantic_footprint(OWNER_BLOCK_ID, &[command], &materialization, None)
                        .expect_err("Agent generic edits cannot mutate typed owner shells");
                assert_eq!(error.code, StoreErrorCode::InvalidInput);
            }
        }
    }

    #[test]
    fn generic_operation_batches_reject_every_typed_owner_mutation() {
        let fixture = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/yjs-yrs/empty-page.bin");
        let full_state = fs::read(fixture).expect("empty Page fixture");
        let engine =
            YrsDocumentEngine::from_full_state_v1(DOCUMENT_ID, &full_state).expect("Page engine");
        for owner_type in TYPED_CREATION_BLOCK_TYPES {
            let mut materialization = materialize_engine(&engine, BlockDocumentSchema::PageV3)
                .expect("Page materialization");
            let owner_block = materialization
                .search_units
                .first_mut()
                .expect("fixture contains a body Block");
            owner_block.block_type = (*owner_type).to_owned();
            let owner_block_id = owner_block.block_id.clone();

            let ordinary_draft = MaterializedBlockNode {
                id: "ordinary".to_owned(),
                block_type: "paragraph".to_owned(),
                props: BTreeMap::new(),
                content: None,
                children: Vec::new(),
            };
            let typed_draft = MaterializedBlockNode {
                block_type: (*owner_type).to_owned(),
                ..ordinary_draft.clone()
            };
            let cases = [
                EngineDocumentBlockOperation::InsertBlock {
                    block: typed_draft,
                    parent_block_id: None,
                    before_block_id: None,
                },
                EngineDocumentBlockOperation::InsertBlock {
                    block: ordinary_draft,
                    parent_block_id: Some(owner_block_id.clone()),
                    before_block_id: None,
                },
                EngineDocumentBlockOperation::UpdateBlock {
                    block_id: owner_block_id.clone(),
                    patch: EngineDocumentBlockUpdatePatch {
                        block_type: None,
                        props: Some(BTreeMap::new()),
                        content: None,
                        unset_content: false,
                    },
                },
                EngineDocumentBlockOperation::MoveBlock {
                    block_id: owner_block_id.clone(),
                    parent_block_id: None,
                    before_block_id: None,
                },
                EngineDocumentBlockOperation::DeleteBlock {
                    block_id: owner_block_id,
                },
            ];
            for operation in cases {
                let error = assert_generic_document_operations_preserve_typed_owners(
                    &[operation],
                    &materialization,
                )
                .expect_err("generic operation batches cannot mutate typed owners");
                assert!(matches!(
                    error.code,
                    StoreErrorCode::InvalidInput | StoreErrorCode::ProtectedOwnerDeletion
                ));
            }

            let mut nested_owner = materialization.search_units[0].clone();
            nested_owner.parent_block_id = Some("ordinary-parent".to_owned());
            let mut ordinary_parent = nested_owner.clone();
            ordinary_parent.block_id = "ordinary-parent".to_owned();
            ordinary_parent.block_type = "paragraph".to_owned();
            ordinary_parent.parent_block_id = None;
            materialization.search_units = vec![ordinary_parent, nested_owner];
            let error = assert_generic_document_operations_preserve_typed_owners(
                &[EngineDocumentBlockOperation::MoveBlock {
                    block_id: "ordinary-parent".to_owned(),
                    parent_block_id: None,
                    before_block_id: None,
                }],
                &materialization,
            )
            .expect_err("generic moves cannot carry typed owner subtrees");
            assert_eq!(error.code, StoreErrorCode::InvalidInput);
        }
    }

    #[test]
    fn whole_body_invariant_uses_canonical_placement_not_filtered_effect_metadata() {
        let fixture = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/yjs-yrs/empty-page.bin");
        let full_state = fs::read(fixture).expect("empty Page fixture");
        let engine =
            YrsDocumentEngine::from_full_state_v1(DOCUMENT_ID, &full_state).expect("Page engine");

        for owner_type in TYPED_CREATION_BLOCK_TYPES {
            let mut before = materialize_engine(&engine, BlockDocumentSchema::PageV3)
                .expect("Page materialization");
            let mut owner = before.block_tree[0].clone();
            owner.block_type = (*owner_type).to_owned();
            let mut ordinary = owner.clone();
            ordinary.id = "ordinary-sibling".to_owned();
            ordinary.block_type = "paragraph".to_owned();
            before.block_tree = vec![owner, ordinary];
            before.search_units[0].block_type = (*owner_type).to_owned();
            let mut ordinary_unit = before.search_units[0].clone();
            ordinary_unit.block_id = "ordinary-sibling".to_owned();
            ordinary_unit.block_type = "paragraph".to_owned();
            ordinary_unit.ordinal = 1;
            before.search_units.push(ordinary_unit);

            let mut after = before.clone();
            after.block_tree.swap(0, 1);
            after.search_units.swap(0, 1);
            after.search_units[0].ordinal = 0;
            after.search_units[1].ordinal = 1;
            let no_declared_moves = Vec::new();
            let effect = document_mutation_effect(
                OWNER_BLOCK_ID,
                1,
                &before,
                &after,
                DocumentMutationEffectPolicy {
                    write_fence_block_ids: &[],
                    title_write_fence_required: false,
                    force_write_fence: false,
                    exact_moved_block_ids: Some(&no_declared_moves),
                },
            );
            assert!(effect.moved_block_ids.is_empty());
            let error =
                assert_document_mutation_effect_preserves_typed_owners(&before, &after, &effect)
                    .expect_err("whole-body edits cannot hide owner movement in filtered metadata");
            assert_eq!(error.code, StoreErrorCode::InvalidInput);
        }
    }

    #[test]
    fn stable_block_commands_guard_fields_and_subtrees_and_replay_local_ids() {
        let seeded = seeded_module();
        let connection_id = "electron:agent-stable-blocks";
        let provenance = seed_agent_turn(&seeded, connection_id);
        let operation_id = "agent:stable-block-insert";
        let mutation = AgentDocumentSemanticMutation {
            document_id: DOCUMENT_ID.to_owned(),
            generation: 1,
            expected_head_seq: 1,
            commands: vec![DocumentSemanticCommand::InsertBlock {
                anchor: DocumentSemanticAnchor::End {
                    parent_block_id: None,
                },
                block: DocumentSemanticBlockDraft {
                    local_id: "root".to_owned(),
                    block_type: "paragraph".to_owned(),
                    props: BTreeMap::new(),
                    content: DocumentOptionalValue::Value {
                        value: json!([{ "type": "text", "text": "Root", "styles": {} }]),
                    },
                    children: vec![DocumentSemanticBlockDraft {
                        local_id: "child".to_owned(),
                        block_type: "paragraph".to_owned(),
                        props: BTreeMap::new(),
                        content: DocumentOptionalValue::Value {
                            value: json!([{ "type": "text", "text": "Child", "styles": {} }]),
                        },
                        children: Vec::new(),
                    }],
                },
            }],
        };
        let prepared = seeded
            .module
            .read(
                &context_for(connection_id),
                ModuleReadRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    read: OwnedDocumentRead::PrepareAgentSemanticMutation {
                        operation_id: operation_id.to_owned(),
                        store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
                        authorization: Box::new(agent_execution_authorization(provenance.clone())),
                        mutation: Box::new(mutation.clone()),
                    },
                },
            )
            .expect("prepare stable Block insertion");
        let OwnedDocumentReadValue::AgentSemanticMutationPreparation {
            preparation,
            committed: None,
        } = prepared.value
        else {
            panic!("expected prepared stable Block insertion")
        };
        assert_eq!(preparation.footprint.created_roots.len(), 2);
        let committed = seeded
            .module
            .apply(
                &context_for(connection_id),
                ModuleApplyRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    operation_id: operation_id.to_owned(),
                    store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
                    intent: OwnedDocumentIntent::ExecutePreparedAgentSemanticMutation {
                        authorization: Box::new(AgentPreparedExecution {
                            authorization: agent_execution_authorization(provenance.clone()),
                            token: preparation.token,
                        }),
                        mutation: Box::new(mutation.clone()),
                    },
                },
            )
            .expect("commit stable Block insertion");
        let local_block_ids = committed
            .committed
            .value
            .semantic_local_block_ids
            .clone()
            .expect("stable Block insertion returns local identities");
        let root_id = local_block_ids.get("root").expect("root identity").clone();
        let child_id = local_block_ids
            .get("child")
            .expect("child identity")
            .clone();
        let block_etags = committed
            .committed
            .value
            .semantic_block_etags
            .clone()
            .expect("stable Block insertion returns post-commit guards");
        assert_eq!(
            block_etags.keys().cloned().collect::<BTreeSet<_>>(),
            BTreeSet::from([root_id.clone(), child_id.clone()])
        );
        assert!(
            block_etags
                .values()
                .all(|etags| etags.update.starts_with("nxe1.") && etags.delete.starts_with("nxe1."))
        );
        assert_eq!(
            committed
                .committed
                .value
                .mutation_effect
                .as_ref()
                .expect("stable insertion effect")
                .created_block_ids
                .len(),
            2
        );
        let replay = seeded
            .module
            .apply(
                &context_for(connection_id),
                ModuleApplyRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    operation_id: operation_id.to_owned(),
                    store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
                    intent: OwnedDocumentIntent::ExecutePreparedAgentSemanticMutation {
                        authorization: Box::new(AgentPreparedExecution {
                            authorization: agent_execution_authorization(provenance.clone()),
                            token: None,
                        }),
                        mutation: Box::new(mutation),
                    },
                },
            )
            .expect("replay stable Block insertion");
        assert!(replay.committed.receipt.mutation.duplicate);
        assert_eq!(
            replay.committed.value.semantic_local_block_ids,
            Some(local_block_ids)
        );
        assert_eq!(
            replay.committed.value.semantic_block_etags,
            Some(block_etags)
        );

        let read_snapshot = |guard_kind: Option<AgentDocumentBlockGuardKind>,
                             cursor: Option<String>| {
            let read = seeded
                .module
                .read(
                    &context_for(connection_id),
                    ModuleReadRequest {
                        contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                        read: OwnedDocumentRead::AgentSemanticSnapshot {
                            store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
                            authorization: Box::new(agent_execution_authorization(
                                provenance.clone(),
                            )),
                            document_id: DOCUMENT_ID.to_owned(),
                            target_block_id: root_id.clone(),
                            prepare_title: false,
                            prepare_body: false,
                            block_guards: guard_kind
                                .map(|kind| {
                                    vec![AgentDocumentBlockGuard {
                                        block_id: root_id.clone(),
                                        kind,
                                    }]
                                })
                                .unwrap_or_default(),
                            max_depth: Some(512),
                            cursor,
                            limit: Some(1),
                        },
                    },
                )
                .expect("read stable Block semantic snapshot");
            let OwnedDocumentReadValue::AgentSemanticSnapshot { snapshot } = read.value else {
                panic!("expected stable Block semantic snapshot")
            };
            *snapshot
        };
        let update_snapshot = read_snapshot(Some(AgentDocumentBlockGuardKind::Update), None);
        assert_eq!(update_snapshot.blocks[0].block_id, root_id);
        assert!(update_snapshot.nested_markdown.contains("Root"));
        assert!(update_snapshot.has_more);
        let block_etag = update_snapshot.blocks[0]
            .etag
            .clone()
            .expect("Block update ETag");
        let stale_cursor = update_snapshot.next_cursor.clone();
        let next_page = read_snapshot(None, update_snapshot.next_cursor);
        assert_eq!(next_page.blocks[0].block_id, child_id);
        assert!(!next_page.has_more);
        let delete_snapshot = read_snapshot(Some(AgentDocumentBlockGuardKind::Delete), None);
        let subtree_etag = delete_snapshot.blocks[0]
            .etag
            .clone()
            .expect("Block subtree ETag");
        let updated = seeded
            .module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    operation_id: "semantic:stable-update".to_owned(),
                    store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
                    intent: OwnedDocumentIntent::ApplySemanticMutation {
                        document_id: DOCUMENT_ID.to_owned(),
                        generation: 1,
                        expected_head_seq: 2,
                        commands: vec![DocumentSemanticCommand::UpdateBlock {
                            block_id: root_id.clone(),
                            expected_etag: block_etag.clone(),
                            patch: ContractDocumentBlockUpdatePatch {
                                block_type: None,
                                props: Some(BTreeMap::from([(
                                    "textAlignment".to_owned(),
                                    json!("center"),
                                )])),
                                content: DocumentOptionalValue::Absent,
                                unset_content: false,
                            },
                        }],
                    },
                },
            )
            .expect("guarded stable Block update");
        assert_eq!(updated.committed.value.head_seq, 3);
        assert_eq!(
            updated
                .committed
                .value
                .mutation_effect
                .as_ref()
                .expect("stable update effect")
                .updated_block_ids,
            vec![root_id.clone()]
        );
        let stale_cursor_error = seeded
            .module
            .read(
                &context_for(connection_id),
                ModuleReadRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    read: OwnedDocumentRead::AgentSemanticSnapshot {
                        store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
                        authorization: Box::new(agent_execution_authorization(provenance.clone())),
                        document_id: DOCUMENT_ID.to_owned(),
                        target_block_id: root_id.clone(),
                        prepare_title: false,
                        prepare_body: false,
                        block_guards: Vec::new(),
                        max_depth: Some(512),
                        cursor: stale_cursor,
                        limit: Some(1),
                    },
                },
            )
            .expect_err("Agent Document cursor is stale after a commit");
        assert_eq!(stale_cursor_error.code, CoreErrorCode::RevisionConflict);
        let stale_update = seeded
            .module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    operation_id: "semantic:stable-update-stale".to_owned(),
                    store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
                    intent: OwnedDocumentIntent::ApplySemanticMutation {
                        document_id: DOCUMENT_ID.to_owned(),
                        generation: 1,
                        expected_head_seq: 3,
                        commands: vec![DocumentSemanticCommand::UpdateBlock {
                            block_id: root_id.clone(),
                            expected_etag: block_etag,
                            patch: ContractDocumentBlockUpdatePatch {
                                block_type: None,
                                props: Some(BTreeMap::new()),
                                content: DocumentOptionalValue::Absent,
                                unset_content: false,
                            },
                        }],
                    },
                },
            )
            .expect_err("stale stable Block update guard");
        assert_eq!(stale_update.code, CoreErrorCode::RevisionConflict);

        let moved = seeded
            .module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    operation_id: "semantic:stable-move".to_owned(),
                    store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
                    intent: OwnedDocumentIntent::ApplySemanticMutation {
                        document_id: DOCUMENT_ID.to_owned(),
                        generation: 1,
                        expected_head_seq: 3,
                        commands: vec![DocumentSemanticCommand::MoveBlock {
                            block_id: child_id,
                            anchor: DocumentSemanticAnchor::Start {
                                parent_block_id: None,
                            },
                        }],
                    },
                },
            )
            .expect("stable Block move");
        assert_eq!(moved.committed.value.head_seq, 4);
        let stale_delete = seeded
            .module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    operation_id: "semantic:stable-delete-stale".to_owned(),
                    store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
                    intent: OwnedDocumentIntent::ApplySemanticMutation {
                        document_id: DOCUMENT_ID.to_owned(),
                        generation: 1,
                        expected_head_seq: 4,
                        commands: vec![DocumentSemanticCommand::DeleteBlock {
                            block_id: root_id,
                            expected_etag: subtree_etag,
                        }],
                    },
                },
            )
            .expect_err("stale subtree delete guard");
        assert_eq!(stale_delete.code, CoreErrorCode::RevisionConflict);
    }

    #[test]
    fn prepared_agent_semantic_operation_rejects_a_page_from_another_library() {
        const FOREIGN_PROFILE_ID: &str = "profile:foreign";
        const FOREIGN_LIBRARY_ID: &str = "library:foreign";
        const FOREIGN_PROJECT_ID: &str = "project:foreign";
        const FOREIGN_PAGE_ID: &str = "page:foreign";
        const FOREIGN_DOCUMENT_ID: &str = "document:foreign";
        let seeded = seeded_module();
        let connection_id = "electron:agent-foreign-library";
        let provenance = seed_agent_turn(&seeded, connection_id);
        seeded
            .kernel
            .writer()
            .call(|connection| {
                with_immediate_transaction(connection, |transaction| {
                    transaction.execute(
                        "INSERT INTO profiles(id, created_at, updated_at) VALUES (?1, ?2, ?2)",
                        params![FOREIGN_PROFILE_ID, NOW],
                    )?;
                    transaction.execute(
                        "INSERT INTO libraries(id, profile_id, created_at, updated_at) \
                         VALUES (?1, ?2, ?3, ?3)",
                        params![FOREIGN_LIBRARY_ID, FOREIGN_PROFILE_ID, NOW],
                    )?;
                    transaction.execute(
                        "INSERT INTO projects(id, library_id, name, created, updated) \
                         VALUES (?1, ?2, 'Foreign Library actor', ?3, ?3)",
                        params![FOREIGN_PROJECT_ID, FOREIGN_LIBRARY_ID, NOW],
                    )?;
                    Ok(())
                })
            })
            .expect("seed foreign Library identity");
        let foreign_library =
            LibraryModule::new(FOREIGN_PROFILE_ID, FOREIGN_LIBRARY_ID, &seeded.kernel);
        foreign_library
            .apply(
                &BoundModuleContext {
                    editor_history_owner: None,
                    profile_id: ProfileId(FOREIGN_PROFILE_ID.to_owned()),
                    library_id: LibraryId(FOREIGN_LIBRARY_ID.to_owned()),
                    project_id: None,
                    connection_id: "trusted:foreign-library".to_owned(),
                    adapter: AdapterKind::Test,
                },
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "create:foreign-page".to_owned(),
                    store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
                    intent: LibraryIntent::CreatePage {
                        page_id: FOREIGN_PAGE_ID.to_owned(),
                        document_id: FOREIGN_DOCUMENT_ID.to_owned(),
                        title: "Foreign Page".to_owned(),
                        parent: LibraryWriteParent::Library { before: None },
                    },
                },
            )
            .expect("create foreign Library Page");

        let error = seeded
            .module
            .read(
                &context_for(connection_id),
                ModuleReadRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    read: OwnedDocumentRead::PrepareAgentSemanticMutation {
                        operation_id: "agent:foreign-library".to_owned(),
                        store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
                        authorization: Box::new(agent_execution_authorization(provenance)),
                        mutation: Box::new(AgentDocumentSemanticMutation {
                            document_id: FOREIGN_DOCUMENT_ID.to_owned(),
                            generation: 1,
                            expected_head_seq: 1,
                            commands: Vec::new(),
                        }),
                    },
                },
            )
            .expect_err("persisted Turn authority cannot cross Libraries");
        assert_eq!(error.code, CoreErrorCode::Unauthorized);
    }

    #[test]
    fn prepared_agent_execution_binds_one_call_resource_consent() {
        const ACTOR_PROJECT_ID: &str = "project:agent-consent";
        let seeded = seeded_module();
        let connection_id = "electron:agent-consent";
        let provenance = seed_agent_turn_for_project(&seeded, connection_id, ACTOR_PROJECT_ID);
        let materialization = materialize_engine(
            &YrsDocumentEngine::from_full_state_v1(DOCUMENT_ID, &seeded.full_state).unwrap(),
            BlockDocumentSchema::PageV3,
        )
        .unwrap();
        let title_etag = seeded
            .kernel
            .readers()
            .read_default(|connection| {
                super::super::semantic::mint_etag(
                    connection,
                    "title",
                    ACTOR_PROJECT_ID,
                    STORE_EPOCH,
                    &[DOCUMENT_ID],
                    json!({ "richTitle": materialization.rich_title }),
                )
                .map_err(semantic_error)
            })
            .unwrap();
        let operation_id = "agent:consented-title";
        let mutation = AgentDocumentSemanticMutation {
            document_id: DOCUMENT_ID.to_owned(),
            generation: 1,
            expected_head_seq: 1,
            commands: vec![DocumentSemanticCommand::SetTitle {
                inline_markdown: "One-call consent".to_owned(),
                expected_etag: title_etag,
            }],
        };
        let denied = seeded
            .module
            .read(
                &context_for_project(connection_id, ACTOR_PROJECT_ID),
                ModuleReadRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    read: OwnedDocumentRead::PrepareAgentSemanticMutation {
                        operation_id: "agent:unconsented-title".to_owned(),
                        store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
                        authorization: Box::new(AgentExecutionAuthorization {
                            provenance: provenance.clone(),
                            call_id: "call:agent-document-test".to_owned(),
                            resource_access: None,
                        }),
                        mutation: Box::new(mutation.clone()),
                    },
                },
            )
            .expect_err("ungranted Page write requires bound resource consent");
        assert_eq!(denied.code, CoreErrorCode::Unauthorized);
        let mut mismatched_authorization = agent_execution_authorization(provenance.clone());
        mismatched_authorization.call_id = "call:another-agent-call".to_owned();
        let mismatched = seeded
            .module
            .read(
                &context_for_project(connection_id, ACTOR_PROJECT_ID),
                ModuleReadRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    read: OwnedDocumentRead::PrepareAgentSemanticMutation {
                        operation_id: "agent:mismatched-consent-title".to_owned(),
                        store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
                        authorization: Box::new(mismatched_authorization),
                        mutation: Box::new(mutation.clone()),
                    },
                },
            )
            .expect_err("one-call consent cannot authorize another call");
        assert_eq!(mismatched.code, CoreErrorCode::Unauthorized);
        let prepared = seeded
            .module
            .read(
                &context_for_project(connection_id, ACTOR_PROJECT_ID),
                ModuleReadRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    read: OwnedDocumentRead::PrepareAgentSemanticMutation {
                        operation_id: operation_id.to_owned(),
                        store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
                        authorization: Box::new(agent_execution_authorization(provenance.clone())),
                        mutation: Box::new(mutation.clone()),
                    },
                },
            )
            .expect("same-Library Page is consent-eligible");
        let OwnedDocumentReadValue::AgentSemanticMutationPreparation {
            preparation,
            committed: None,
        } = prepared.value
        else {
            panic!("expected prepared consent operation")
        };
        assert_eq!(preparation.consent, AgentConsentRequirement::None);
        let committed = seeded
            .module
            .apply(
                &context_for_project(connection_id, ACTOR_PROJECT_ID),
                ModuleApplyRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    operation_id: operation_id.to_owned(),
                    store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
                    intent: OwnedDocumentIntent::ExecutePreparedAgentSemanticMutation {
                        authorization: Box::new(AgentPreparedExecution {
                            authorization: agent_execution_authorization(provenance),
                            token: preparation.token,
                        }),
                        mutation: Box::new(mutation),
                    },
                },
            )
            .expect("single-use token binds the consented resource footprint");
        assert_eq!(committed.committed.value.head_seq, 2);
        seeded
            .kernel
            .readers()
            .read_default(|connection| {
                let evidence: (String, i64) = connection.query_row(
                    "SELECT materialization.title, \
                       (SELECT count(*) FROM project_resource_grants \
                        WHERE project_id = ?2) \
                     FROM document_materializations materialization WHERE document_id = ?1",
                    params![DOCUMENT_ID, ACTOR_PROJECT_ID],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )?;
                assert_eq!(evidence, ("One-call consent".to_owned(), 0));
                Ok::<_, StoreError>(())
            })
            .unwrap();
    }

    #[test]
    fn semantic_title_and_body_guards_commit_atomically() {
        let seeded = seeded_module();
        let materialization = materialize_engine(
            &YrsDocumentEngine::from_full_state_v1(DOCUMENT_ID, &seeded.full_state).unwrap(),
            BlockDocumentSchema::PageV3,
        )
        .unwrap();
        let (title_etag, body_etag) = seeded
            .kernel
            .readers()
            .read_default(|connection| {
                let title = super::super::semantic::mint_etag(
                    connection,
                    "title",
                    PROJECT_ID,
                    STORE_EPOCH,
                    &[DOCUMENT_ID],
                    json!({ "richTitle": materialization.rich_title }),
                )
                .expect("title ETag");
                let body = super::super::semantic::mint_etag(
                    connection,
                    "document_body",
                    PROJECT_ID,
                    STORE_EPOCH,
                    &[DOCUMENT_ID],
                    json!({ "nfm": materialization.nfm }),
                )
                .expect("body ETag");
                Ok::<_, StoreError>((title, body))
            })
            .unwrap();
        let request = ModuleApplyRequest {
            contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
            operation_id: "semantic:title-and-body".to_owned(),
            store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
            intent: OwnedDocumentIntent::ApplySemanticMutation {
                document_id: DOCUMENT_ID.to_owned(),
                generation: 1,
                expected_head_seq: 1,
                commands: vec![
                    DocumentSemanticCommand::SetTitle {
                        inline_markdown: "**Semantic** title".to_owned(),
                        expected_etag: title_etag.clone(),
                    },
                    DocumentSemanticCommand::ReplaceBody {
                        nested_markdown: "Semantic body".to_owned(),
                        expected_etag: body_etag,
                    },
                ],
            },
        };
        let committed = seeded
            .module
            .apply(&context(), request.clone())
            .expect("semantic mutation");
        assert_eq!(committed.committed.value.head_seq, 2);
        assert!(!committed.events.is_empty());
        seeded
            .kernel
            .readers()
            .read_default(|connection| {
                let (title, nfm, rich_title): (String, String, String) = connection.query_row(
                    "SELECT title, nfm, title_rich_json FROM document_materializations \
                     WHERE document_id = ?1",
                    [DOCUMENT_ID],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )?;
                assert_eq!(title, "Semantic title");
                assert_eq!(nfm, "Semantic body");
                assert_eq!(
                    serde_json::from_str::<Value>(&rich_title).unwrap()[0]["styles"]["bold"],
                    true
                );
                Ok::<_, StoreError>(())
            })
            .unwrap();

        let duplicate = seeded.module.apply(&context(), request).unwrap();
        assert!(duplicate.committed.receipt.mutation.duplicate);
        assert!(duplicate.events.is_empty());
        let stale = seeded
            .module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    operation_id: "semantic:stale-title".to_owned(),
                    store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
                    intent: OwnedDocumentIntent::ApplySemanticMutation {
                        document_id: DOCUMENT_ID.to_owned(),
                        generation: 1,
                        expected_head_seq: 2,
                        commands: vec![DocumentSemanticCommand::SetTitle {
                            inline_markdown: "Stale overwrite".to_owned(),
                            expected_etag: title_etag,
                        }],
                    },
                },
            )
            .expect_err("stale narrow guard");
        assert_eq!(stale.code, CoreErrorCode::RevisionConflict);

        let sync = seeded
            .module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    read: OwnedDocumentRead::SyncYjs {
                        document_id: DOCUMENT_ID.to_owned(),
                        state_vector: Vec::new(),
                        history_after_head_seq: None,
                    },
                },
            )
            .unwrap();
        let OwnedDocumentReadValue::YjsSync { update, .. } = sync.value else {
            panic!("expected Yjs sync")
        };
        let current = YrsDocumentEngine::from_full_state_v1(DOCUMENT_ID, &update).unwrap();
        let renderer_update = title_update(
            &current.full_state_v1(),
            &current.state_vector_v1(),
            "Concurrent renderer title",
        );
        seeded
            .module
            .apply(
                &context(),
                apply_request("update:concurrent-title", 2, renderer_update),
            )
            .unwrap();
        let merged = seeded
            .module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    operation_id: "semantic:exact-patch-after-renderer".to_owned(),
                    store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
                    intent: OwnedDocumentIntent::ApplySemanticMutation {
                        document_id: DOCUMENT_ID.to_owned(),
                        generation: 1,
                        expected_head_seq: 2,
                        commands: vec![DocumentSemanticCommand::PatchBody {
                            old_fragment: "Semantic body".to_owned(),
                            new_fragment: "Merged body".to_owned(),
                            expected_matches: None,
                        }],
                    },
                },
            )
            .expect("exact patch rebases over unrelated renderer edit");
        assert_eq!(merged.committed.value.head_seq, 4);

        let structural = seeded
            .module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    operation_id: "semantic:stale-structural".to_owned(),
                    store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
                    intent: OwnedDocumentIntent::ApplySemanticMutation {
                        document_id: DOCUMENT_ID.to_owned(),
                        generation: 1,
                        expected_head_seq: 2,
                        commands: vec![DocumentSemanticCommand::DeleteBlock {
                            block_id: "019bf52d-6870-7000-8000-000000000099".to_owned(),
                            expected_etag: String::new(),
                        }],
                    },
                },
            )
            .expect_err("structural edits retain the exact-head barrier");
        assert_eq!(structural.code, CoreErrorCode::HeadConflict);
    }

    #[test]
    fn native_cli_semantic_replay_is_connection_and_head_independent() {
        let seeded = seeded_module();
        let materialization = materialize_engine(
            &YrsDocumentEngine::from_full_state_v1(DOCUMENT_ID, &seeded.full_state).unwrap(),
            BlockDocumentSchema::PageV3,
        )
        .unwrap();
        let title_etag = seeded
            .kernel
            .readers()
            .read_default(|connection| {
                super::super::semantic::mint_etag(
                    connection,
                    "title",
                    PROJECT_ID,
                    STORE_EPOCH,
                    &[DOCUMENT_ID],
                    json!({ "richTitle": materialization.rich_title }),
                )
                .map_err(semantic_error)
            })
            .unwrap();
        let command = DocumentSemanticCommand::SetTitle {
            inline_markdown: "Native CLI title".to_owned(),
            expected_etag: title_etag,
        };
        let request = |expected_head_seq| ModuleApplyRequest {
            contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
            operation_id: "cli:set-title:replay".to_owned(),
            store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
            intent: OwnedDocumentIntent::ApplySemanticMutation {
                document_id: DOCUMENT_ID.to_owned(),
                generation: 1,
                expected_head_seq,
                commands: vec![command.clone()],
            },
        };

        let committed = seeded
            .module
            .apply(
                &native_cli_context_for("native-cli:first", PROJECT_ID),
                request(1),
            )
            .expect("native CLI semantic mutation");
        let etags = committed
            .committed
            .value
            .semantic_etags
            .clone()
            .expect("native CLI receipt ETags");
        assert!(etags.title.starts_with("nxe1."));
        assert!(etags.body.starts_with("nxe1."));

        let replay = seeded
            .module
            .apply(
                &native_cli_context_for("native-cli:retry", PROJECT_ID),
                request(2),
            )
            .expect("lost-response replay from a new CLI process");
        assert!(replay.committed.receipt.mutation.duplicate);
        assert_eq!(replay.committed.value.semantic_etags, Some(etags));
        assert!(replay.events.is_empty());
    }

    #[test]
    fn native_cli_semantic_write_uses_recursive_project_grant_authority() {
        const CLI_PROJECT_ID: &str = "project:native-cli-grant";
        let seeded = seeded_module();
        seeded
            .kernel
            .writer()
            .call(|connection| {
                with_immediate_transaction(connection, |transaction| {
                    transaction.execute(
                        "INSERT INTO projects(id, library_id, name, created, updated) \
                         VALUES (?1, ?2, 'CLI project', ?3, ?3)",
                        params![CLI_PROJECT_ID, LIBRARY_ID, NOW],
                    )?;
                    transaction.execute(
                        "INSERT INTO project_resource_grants(\
                           id, project_id, library_id, root_kind, root_id, access, recursive, \
                           revision, lifecycle, created_at, updated_at\
                         ) VALUES ('grant:native-cli-page', ?1, ?2, 'page', ?3, 'read', 1, 1, \
                           'active', ?4, ?4)",
                        params![CLI_PROJECT_ID, LIBRARY_ID, OWNER_BLOCK_ID, NOW],
                    )?;
                    Ok(())
                })
            })
            .unwrap();
        let materialization = materialize_engine(
            &YrsDocumentEngine::from_full_state_v1(DOCUMENT_ID, &seeded.full_state).unwrap(),
            BlockDocumentSchema::PageV3,
        )
        .unwrap();
        let title_etag = seeded
            .kernel
            .readers()
            .read_default(|connection| {
                super::super::semantic::mint_etag(
                    connection,
                    "title",
                    CLI_PROJECT_ID,
                    STORE_EPOCH,
                    &[DOCUMENT_ID],
                    json!({ "richTitle": materialization.rich_title }),
                )
                .map_err(semantic_error)
            })
            .unwrap();
        let request = |operation_id: &str| ModuleApplyRequest {
            contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
            operation_id: operation_id.to_owned(),
            store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
            intent: OwnedDocumentIntent::ApplySemanticMutation {
                document_id: DOCUMENT_ID.to_owned(),
                generation: 1,
                expected_head_seq: 1,
                commands: vec![DocumentSemanticCommand::SetTitle {
                    inline_markdown: "Granted CLI title".to_owned(),
                    expected_etag: title_etag.clone(),
                }],
            },
        };
        let denied = seeded
            .module
            .apply(
                &native_cli_context_for("native-cli:read-grant", CLI_PROJECT_ID),
                request("cli:read-grant-denied"),
            )
            .expect_err("read-only recursive grant cannot mutate");
        assert_eq!(denied.code, CoreErrorCode::NotFound);

        seeded
            .kernel
            .writer()
            .call(|connection| {
                connection.execute(
                    "UPDATE project_resource_grants SET access = 'read_write', revision = 2 \
                     WHERE id = 'grant:native-cli-page'",
                    [],
                )?;
                Ok(())
            })
            .unwrap();
        let committed = seeded
            .module
            .apply(
                &native_cli_context_for("native-cli:write-grant", CLI_PROJECT_ID),
                request("cli:write-grant-accepted"),
            )
            .expect("read-write recursive grant authorizes the Page mutation");
        assert_eq!(committed.committed.value.head_seq, 2);
    }

    #[test]
    fn semantic_patch_failures_expose_stable_core_error_codes() {
        let seeded = seeded_module();
        let materialization = materialize_engine(
            &YrsDocumentEngine::from_full_state_v1(DOCUMENT_ID, &seeded.full_state).unwrap(),
            BlockDocumentSchema::PageV3,
        )
        .unwrap();
        let body_etag = seeded
            .kernel
            .readers()
            .read_default(|connection| {
                super::super::semantic::mint_etag(
                    connection,
                    "document_body",
                    PROJECT_ID,
                    STORE_EPOCH,
                    &[DOCUMENT_ID],
                    json!({ "nfm": materialization.nfm }),
                )
                .map_err(semantic_error)
            })
            .unwrap();
        seeded
            .module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    operation_id: "semantic:patch-errors:seed".to_owned(),
                    store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
                    intent: OwnedDocumentIntent::ApplySemanticMutation {
                        document_id: DOCUMENT_ID.to_owned(),
                        generation: 1,
                        expected_head_seq: 1,
                        commands: vec![DocumentSemanticCommand::ReplaceBody {
                            nested_markdown: "a\nb\nc\nsame\nsame".to_owned(),
                            expected_etag: body_etag,
                        }],
                    },
                },
            )
            .expect("seed patch corpus");
        let patch = |operation_id: &str, commands| {
            seeded.module.apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    operation_id: operation_id.to_owned(),
                    store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
                    intent: OwnedDocumentIntent::ApplySemanticMutation {
                        document_id: DOCUMENT_ID.to_owned(),
                        generation: 1,
                        expected_head_seq: 2,
                        commands,
                    },
                },
            )
        };

        let missing = patch(
            "semantic:patch-errors:missing",
            vec![DocumentSemanticCommand::PatchBody {
                old_fragment: "missing\n".to_owned(),
                new_fragment: "replacement\n".to_owned(),
                expected_matches: None,
            }],
        )
        .expect_err("missing exact fragment");
        assert_eq!(missing.code, CoreErrorCode::PatchNotFound);

        let ambiguous = patch(
            "semantic:patch-errors:ambiguous",
            vec![DocumentSemanticCommand::PatchBody {
                old_fragment: "same".to_owned(),
                new_fragment: "different".to_owned(),
                expected_matches: None,
            }],
        )
        .expect_err("ambiguous exact fragment");
        assert_eq!(ambiguous.code, CoreErrorCode::PatchAmbiguous);

        let overlap = patch(
            "semantic:patch-errors:overlap",
            vec![
                DocumentSemanticCommand::PatchBody {
                    old_fragment: "a\nb\n".to_owned(),
                    new_fragment: "A\nb\n".to_owned(),
                    expected_matches: None,
                },
                DocumentSemanticCommand::PatchBody {
                    old_fragment: "b\nc\n".to_owned(),
                    new_fragment: "B\nc\n".to_owned(),
                    expected_matches: None,
                },
            ],
        )
        .expect_err("overlapping exact fragments");
        assert_eq!(overlap.code, CoreErrorCode::PatchOverlap);
    }
}
