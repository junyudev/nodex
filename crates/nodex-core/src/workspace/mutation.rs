use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use nodex_core_contracts::workspace::{
    ProjectAppearance, ProjectCatalogChangeKind, ProjectLifecycle, ProjectMarker,
    ProjectSessionInvalidationScope, ProjectWorkspaceCommitValue, ProjectWorkspaceIntent,
    ProjectWorkspaceQueuedFollowUpLedgerCommit, ProjectWorkspaceReceipt,
    ProjectWorkspaceStarterPage, ProjectWorkspaceThreadMoveProjectAccessGrant,
};
use nodex_core_contracts::{
    BoundModuleContext, ModuleApplyRequest, ModuleMutationReceipt, ModuleName,
    PageDocumentHeadImpact, ProjectionImpact, StoreEpoch,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::json;

use crate::database::{
    create_database_authority_records, create_page_key_namespace,
    resolve_page_transfer_data_source_destination_prevalidated,
};
use crate::document::{
    PrimaryCanvasIdentity, create_primary_canvas, primary_canvas_block_id,
    primary_canvas_document_id, read_store_epoch, sha256,
};
use crate::domain::identity::stable_uuid_v7;
use crate::domain::project_appearance::{
    normalize_project_appearance, project_marker_color_literal, project_marker_icon_literal,
};
use crate::infrastructure::durable_mutation::{
    self, CommitResult, DurableMutationScope, OperationIdentity, ReceiptMetadata, SealedOutcome,
};
use crate::infrastructure::event_log::{
    NewChangeLogEntry, append_change_log, load_committed_event_by_sequence,
};
use crate::infrastructure::local_commit::{self, CommitContext};
use crate::infrastructure::module_receipts::read_module_receipt;
#[cfg(test)]
use crate::infrastructure::module_receipts::{NewModuleReceipt, insert_module_receipt};
use crate::infrastructure::projection_impact::expand_database_coordinates;
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode, with_immediate_transaction};
use crate::infrastructure::writer::StoreWriter;

use super::{
    ProjectWorkspaceApplyOutcome, execution, queued_follow_up, session_lifecycle, session_mutation,
    sidebar, sidebar_section, subagent_projection, thread,
};

const MODULE_NAME: &str = "project_workspace";
const MAX_ID_LENGTH: usize = 512;
const MAX_PROJECT_NAME_CHARS: usize = 256;
const MAX_PROJECT_RESOURCE_NAME_CHARS: usize = 256;
const MAX_PROJECT_DESCRIPTION_BYTES: usize = 100_000;
const MAX_SOURCE_ROOTS: usize = 128;
const MAX_SOURCE_ROOT_BYTES: usize = 4_096;
const MAX_PROJECT_ORDER_SIZE: usize = 100_000;
const MAX_UNARCHIVED_PROJECTS: usize = 200;
const INITIAL_RANK_KEY: &str = "7fffffffffffffffffffffffffffffff";
const PROJECT_DATABASE_NAME_SUFFIX: &str = " DB";
const PROJECT_CANVAS_NAME_SUFFIX: &str = " Canvas";

struct ProjectAggregateIdentities {
    database_id: String,
    data_source_id: String,
    view_id: String,
}

struct CreatedProjectAggregate {
    identities: ProjectAggregateIdentities,
    canvas: PrimaryCanvasIdentity,
    starter_page: Option<crate::library::page_genesis::CreatedPageGenesis>,
}

struct StarterPageGenesisRequest<'a> {
    page: &'a ProjectWorkspaceStarterPage,
    store_epoch: &'a str,
}

pub(super) struct WorkspaceMutationEffects {
    pub(super) operation_kind: &'static str,
    pub(super) project_catalog_change: Option<ProjectCatalogChangeKind>,
    pub(super) change_project_id: String,
    pub(super) project_ids: Vec<String>,
    pub(super) session_ids: Vec<String>,
    pub(super) thread_ids: Vec<String>,
    pub(super) session_summary_scopes: Vec<ProjectSessionInvalidationScope>,
    pub(super) session_detail_ids: Vec<String>,
    pub(super) block_ids: Vec<String>,
    pub(super) document_ids: Vec<String>,
    pub(super) database_ids: Vec<String>,
    pub(super) page_ids: Vec<String>,
    pub(super) data_source_ids: Vec<String>,
    pub(super) view_ids: Vec<String>,
    pub(super) document_heads: Vec<PageDocumentHeadImpact>,
    pub(super) committed_at: String,
    pub(super) queued_follow_up_ledger: Option<ProjectWorkspaceQueuedFollowUpLedgerCommit>,
}

pub(super) fn project_session_scope(project_id: Option<&str>) -> ProjectSessionInvalidationScope {
    project_id.map_or(ProjectSessionInvalidationScope::Projectless, |project_id| {
        ProjectSessionInvalidationScope::Project {
            project_id: project_id.to_owned(),
        }
    })
}

struct ProjectSource {
    root: String,
    root_key: String,
}

#[cfg(test)]
pub(super) fn seed_rootless_default_project_for_test(
    writer: &StoreWriter,
    profile_id: &str,
    library_id: &str,
    assets_root: &Path,
) -> Result<(), StoreError> {
    let profile_id = profile_id.to_owned();
    let library_id = library_id.to_owned();
    let assets_root = assets_root.to_path_buf();
    writer.call(move |connection| {
        with_immediate_transaction(connection, |transaction| {
            assert_identity(transaction, &profile_id, &library_id)?;
            let operation_id = "test:rootless-default-project:v1";
            let request_hash = sha256(operation_id.as_bytes());
            let committed_at = sqlite_now(transaction)?;
            let commit = local_commit::begin(
                transaction,
                &read_store_epoch(transaction)?,
                operation_id,
                &request_hash,
                &committed_at,
            )?;
            create_project_records(
                transaction,
                &commit,
                &committed_at,
                &library_id,
                "project:default",
                "Nodex",
                "",
                &ProjectAppearance::default(),
                &[],
                None,
                "test:rootless-default-project:v1",
                &assets_root,
                None,
            )?;
            let receipt_context = nodex_core_contracts::BoundModuleContext {
                profile_id: nodex_core_contracts::ProfileId(profile_id.clone()),
                library_id: nodex_core_contracts::LibraryId(library_id.clone()),
                project_id: Some(nodex_core_contracts::ProjectId(
                    "project:default".to_owned(),
                )),
                connection_id: "test:rootless-default-project".to_owned(),
                adapter: nodex_core_contracts::AdapterKind::Test,
            };
            let event_sequence = append_change_log(
                transaction,
                NewChangeLogEntry {
                    project_id: "project:default",
                    store_epoch: commit.store_epoch(),
                    kind: "project_workspace.changed",
                    operation_id: Some(operation_id),
                    block_ids: &[],
                    document_ids: &[],
                    database_block_ids: &[],
                    payload_json: &json!({
                        "module": MODULE_NAME,
                        "operationKind": "test_seed",
                        "kind": "workspace_changed",
                        "projectIds": ["project:default"],
                    })
                    .to_string(),
                    projection_impact: &ProjectionImpact::All,
                    committed_at: &committed_at,
                },
                &commit,
            )?;
            insert_module_receipt(
                transaction,
                NewModuleReceipt {
                    module_name: MODULE_NAME,
                    operation_id,
                    context: &receipt_context,
                    operation_kind: "test_seed",
                    store_epoch: commit.store_epoch(),
                    request_hash: &request_hash,
                    result: &json!({}),
                    event_sequence: Some(event_sequence),
                    local_commit: Some(&commit),
                    committed_at: &committed_at,
                },
            )?;
            local_commit::finalize(transaction, &commit)?;
            Ok(())
        })
    })
}

pub(super) fn apply(
    writer: &StoreWriter,
    profile_id: &str,
    library_id: &str,
    context: &BoundModuleContext,
    request: ModuleApplyRequest<ProjectWorkspaceIntent>,
    assets_root: &Path,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
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
                    "Project Workspace mutation targets a stale store epoch",
                    true,
                ));
            }
            validate_id("operation_id", &request.operation_id)?;
            let fingerprint = serde_json::to_vec(&(
                &context.profile_id,
                &context.library_id,
                &context.project_id,
                &context.adapter,
                request.contract_version,
                &request.store_epoch,
                &request.intent,
            ))
            .map_err(|_| internal("Project Workspace mutation cannot be fingerprinted"))?;
            let request_hash = sha256(&fingerprint);
            if let Some(stored) =
                read_module_receipt(transaction, MODULE_NAME, &request.operation_id)?
            {
                if stored.request_hash != request_hash {
                    return Err(StoreError::new(
                        StoreErrorCode::IdempotencyKeyReused,
                        "operation_id is already bound to another Project Workspace intent",
                        false,
                    ));
                }
                let mut committed = serde_json::from_value::<
                    crate::ModuleWriterResult<ProjectWorkspaceCommitValue, ProjectWorkspaceReceipt>,
                >(stored.result)
                .map_err(|_| corrupt("Stored Project Workspace receipt is invalid"))?;
                committed.receipt.mutation.duplicate = true;
                return Ok(ProjectWorkspaceApplyOutcome {
                    committed,
                    event: None,
                });
            }

            if !matches!(
                &request.intent,
                ProjectWorkspaceIntent::CreateInitialProject { .. }
                    | ProjectWorkspaceIntent::SetProjectlessPermissionMode { .. }
            ) && project_catalog_is_empty(transaction, &library_id)?
            {
                return Err(conflict(
                    "The initial Project must be created before other Workspace mutations",
                ));
            }

            match &request.intent {
                ProjectWorkspaceIntent::CreateInitialProject {
                    project_id,
                    name,
                    description,
                    appearance,
                    source_roots,
                    page_key_prefix,
                    starter_page,
                } => create_project(
                    transaction,
                    &library_id,
                    &context,
                    &store_epoch,
                    &request.operation_id,
                    &request_hash,
                    project_id,
                    name,
                    description,
                    appearance.as_ref(),
                    source_roots,
                    page_key_prefix.as_deref(),
                    Some(starter_page),
                    &assets_root,
                    ProjectCreationMode::Initial,
                ),
                ProjectWorkspaceIntent::CreateProject {
                    project_id,
                    name,
                    description,
                    appearance,
                    source_roots,
                    page_key_prefix,
                } => create_project(
                    transaction,
                    &library_id,
                    &context,
                    &store_epoch,
                    &request.operation_id,
                    &request_hash,
                    project_id,
                    name,
                    description,
                    appearance.as_ref(),
                    source_roots,
                    page_key_prefix.as_deref(),
                    None,
                    &assets_root,
                    ProjectCreationMode::Subsequent,
                ),
                ProjectWorkspaceIntent::UpdateProject {
                    project_id,
                    expected_binding_revision,
                    name,
                    description,
                    appearance,
                    source_roots,
                } => update_project(
                    transaction,
                    &library_id,
                    &context,
                    &store_epoch,
                    &request.operation_id,
                    &request_hash,
                    project_id,
                    *expected_binding_revision,
                    name.as_deref(),
                    description.as_deref(),
                    appearance.as_ref(),
                    source_roots.as_deref(),
                ),
                ProjectWorkspaceIntent::SetProjectLifecycle {
                    project_id,
                    lifecycle,
                } => set_project_lifecycle(
                    transaction,
                    &library_id,
                    &context,
                    &store_epoch,
                    &request.operation_id,
                    &request_hash,
                    project_id,
                    *lifecycle,
                ),
                ProjectWorkspaceIntent::ReorderProjects { project_ids } => reorder_projects(
                    transaction,
                    &library_id,
                    &context,
                    &store_epoch,
                    &request.operation_id,
                    &request_hash,
                    project_ids,
                ),
                ProjectWorkspaceIntent::ReorderPinnedProjects { project_ids } => {
                    reorder_pinned_projects(
                        transaction,
                        &library_id,
                        &context,
                        &store_epoch,
                        &request.operation_id,
                        &request_hash,
                        project_ids,
                    )
                }
                ProjectWorkspaceIntent::SetProjectPinned { project_id, pinned } => {
                    set_project_pinned(
                        transaction,
                        &library_id,
                        &context,
                        &store_epoch,
                        &request.operation_id,
                        &request_hash,
                        project_id,
                        *pinned,
                    )
                }
                ProjectWorkspaceIntent::CreateSidebarSection {
                    section_id,
                    name,
                    initial_item,
                } => sidebar_section::create_section(
                    transaction,
                    &library_id,
                    &context,
                    &store_epoch,
                    &request.operation_id,
                    &request_hash,
                    section_id,
                    name,
                    initial_item.as_ref(),
                ),
                ProjectWorkspaceIntent::RenameSidebarSection {
                    section_id,
                    name,
                    expected_revision,
                } => sidebar_section::rename_section(
                    transaction,
                    &library_id,
                    &context,
                    &store_epoch,
                    &request.operation_id,
                    &request_hash,
                    section_id,
                    name,
                    *expected_revision,
                ),
                ProjectWorkspaceIntent::DeleteSidebarSection {
                    section_id,
                    expected_revision,
                } => sidebar_section::set_section_deleted(
                    transaction,
                    &library_id,
                    &context,
                    &store_epoch,
                    &request.operation_id,
                    &request_hash,
                    section_id,
                    *expected_revision,
                    true,
                ),
                ProjectWorkspaceIntent::RestoreSidebarSection {
                    section_id,
                    expected_revision,
                } => sidebar_section::set_section_deleted(
                    transaction,
                    &library_id,
                    &context,
                    &store_epoch,
                    &request.operation_id,
                    &request_hash,
                    section_id,
                    *expected_revision,
                    false,
                ),
                ProjectWorkspaceIntent::MoveSidebarSectionItem {
                    item,
                    section_id,
                    placement,
                } => sidebar_section::move_item(
                    transaction,
                    &library_id,
                    &context,
                    &store_epoch,
                    &request.operation_id,
                    &request_hash,
                    item,
                    section_id.as_deref(),
                    placement,
                ),
                ProjectWorkspaceIntent::ReorderSidebarSectionSessions {
                    section_id,
                    session_ids,
                } => sidebar_section::reorder_section_sessions(
                    transaction,
                    &library_id,
                    &context,
                    &store_epoch,
                    &request.operation_id,
                    &request_hash,
                    section_id,
                    session_ids,
                ),
                ProjectWorkspaceIntent::ReorderSidebarSections { section_ids } => {
                    sidebar_section::reorder_sections(
                        transaction,
                        &library_id,
                        &context,
                        &store_epoch,
                        &request.operation_id,
                        &request_hash,
                        section_ids,
                    )
                }
                ProjectWorkspaceIntent::ArchiveSidebarSectionSessions {
                    section_id,
                    replacement_session_id,
                } => {
                    sidebar_section::archive_section_sessions(
                        transaction,
                        &library_id,
                        &context,
                        &store_epoch,
                        &request.operation_id,
                        &request_hash,
                        section_id,
                        replacement_session_id.as_deref(),
                    )
                }
                ProjectWorkspaceIntent::UpsertSidebarSectionHostLink { link } => {
                    sidebar_section::upsert_host_link(
                        transaction,
                        &library_id,
                        &context,
                        &store_epoch,
                        &request.operation_id,
                        &request_hash,
                        link,
                    )
                }
                ProjectWorkspaceIntent::DeleteSidebarSectionHostLink {
                    section_id,
                    host_id,
                } => sidebar_section::delete_host_link(
                    transaction,
                    &library_id,
                    &context,
                    &store_epoch,
                    &request.operation_id,
                    &request_hash,
                    section_id,
                    host_id,
                ),
                ProjectWorkspaceIntent::CreateSession {
                    session_id,
                    project_id,
                    title,
                    initial_page_ids,
                } => session_lifecycle::create_session(
                    transaction,
                    &library_id,
                    &context,
                    &store_epoch,
                    &request.operation_id,
                    &request_hash,
                    session_id,
                    project_id.as_deref(),
                    title,
                    initial_page_ids,
                    None,
                ),
                ProjectWorkspaceIntent::CreateSessionInSidebarSection {
                    session_id,
                    section_id,
                    title,
                    initial_page_ids,
                } => session_lifecycle::create_session(
                    transaction,
                    &library_id,
                    &context,
                    &store_epoch,
                    &request.operation_id,
                    &request_hash,
                    session_id,
                    None,
                    title,
                    initial_page_ids,
                    Some(section_id),
                ),
                ProjectWorkspaceIntent::EnsureDefaultDraftSession {
                    session_id,
                    project_id,
                    title,
                } => session_lifecycle::ensure_default_draft_session(
                    transaction,
                    &library_id,
                    &context,
                    &store_epoch,
                    &request.operation_id,
                    &request_hash,
                    session_id,
                    project_id.as_deref(),
                    title,
                ),
                ProjectWorkspaceIntent::DeleteSession { session_id } => {
                    session_lifecycle::delete_session(
                        transaction,
                        &library_id,
                        &context,
                        &store_epoch,
                        &request.operation_id,
                        &request_hash,
                        session_id,
                    )
                }
                ProjectWorkspaceIntent::MoveSession {
                    session_id,
                    project_id,
                } => session_lifecycle::move_session(
                    transaction,
                    &library_id,
                    &context,
                    &store_epoch,
                    &request.operation_id,
                    &request_hash,
                    session_id,
                    project_id.as_deref(),
                ),
                ProjectWorkspaceIntent::ReorderSessions {
                    project_id,
                    session_ids,
                } => session_lifecycle::reorder_sessions(
                    transaction,
                    &library_id,
                    &context,
                    &store_epoch,
                    &request.operation_id,
                    &request_hash,
                    project_id.as_deref(),
                    session_ids,
                    false,
                ),
                ProjectWorkspaceIntent::ReorderPinnedSessions {
                    project_id,
                    session_ids,
                } => session_lifecycle::reorder_sessions(
                    transaction,
                    &library_id,
                    &context,
                    &store_epoch,
                    &request.operation_id,
                    &request_hash,
                    project_id.as_deref(),
                    session_ids,
                    true,
                ),
                ProjectWorkspaceIntent::UpsertThread { thread_id, patch } => thread::upsert_thread(
                    transaction,
                    &library_id,
                    &context,
                    &store_epoch,
                    &request.operation_id,
                    &request_hash,
                    thread_id,
                    patch,
                ),
                ProjectWorkspaceIntent::UpdateThread { thread_id, patch } => thread::update_thread(
                    transaction,
                    &library_id,
                    &context,
                    &store_epoch,
                    &request.operation_id,
                    &request_hash,
                    thread_id,
                    patch,
                ),
                ProjectWorkspaceIntent::SetThreadExecutionLocation {
                    thread_id,
                    location,
                } => thread::set_thread_execution_location(
                    transaction,
                    &library_id,
                    &context,
                    &store_epoch,
                    &request.operation_id,
                    &request_hash,
                    thread_id,
                    location,
                ),
                ProjectWorkspaceIntent::BindThreadBackendSession {
                    thread_id,
                    backend_binding,
                    backend_session_id,
                } => thread::bind_thread_backend_session(
                    transaction,
                    &library_id,
                    &context,
                    &store_epoch,
                    &request.operation_id,
                    &request_hash,
                    thread_id,
                    backend_binding,
                    backend_session_id,
                ),
                ProjectWorkspaceIntent::ClearThreadBackendSession {
                    thread_id,
                    backend_binding,
                } => thread::clear_thread_backend_session(
                    transaction,
                    &library_id,
                    &context,
                    &store_epoch,
                    &request.operation_id,
                    &request_hash,
                    thread_id,
                    backend_binding,
                ),
                ProjectWorkspaceIntent::DeleteThread { thread_id } => thread::delete_thread(
                    transaction,
                    &library_id,
                    &context,
                    &store_epoch,
                    &request.operation_id,
                    &request_hash,
                    thread_id,
                ),
                ProjectWorkspaceIntent::RetainThreadAssets { thread_id, prepared_blob_receipt_ids } => super::thread_assets::retain(
                    transaction, &context, &store_epoch, &request.operation_id, &request_hash, thread_id, prepared_blob_receipt_ids,
                ),
                ProjectWorkspaceIntent::CommitQueuedFollowUpLedger {
                    thread_id,
                    expected_revision,
                    entries,
                    prepared_blob_receipt_ids,
                } => queued_follow_up::commit_ledger(
                    transaction,
                    &library_id,
                    &context,
                    &store_epoch,
                    &request.operation_id,
                    &request_hash,
                    thread_id,
                    *expected_revision,
                    entries,
                    prepared_blob_receipt_ids,
                    &assets_root,
                ),
                ProjectWorkspaceIntent::ObserveAppServerThreadWindow {
                    sweep_id,
                    thread_ids,
                } => thread::observe_app_server_thread_window(
                    transaction,
                    &library_id,
                    &context,
                    &store_epoch,
                    &request.operation_id,
                    &request_hash,
                    sweep_id,
                    thread_ids,
                ),
                ProjectWorkspaceIntent::ReconcileAppServerThreadSweep { sweep_id, limit } => {
                    thread::reconcile_app_server_thread_sweep(
                        transaction,
                        &library_id,
                        &context,
                        &store_epoch,
                        &request.operation_id,
                        &request_hash,
                        sweep_id,
                        *limit,
                    )
                }
                ProjectWorkspaceIntent::ObserveSubagentDiscoveryPage {
                    universe,
                    page_identity,
                    observations,
                    continuation,
                    complete,
                } => subagent_projection::observe_discovery_page(
                    transaction,
                    &library_id,
                    &context,
                    &store_epoch,
                    &request.operation_id,
                    &request_hash,
                    universe,
                    page_identity,
                    observations,
                    continuation.as_deref(),
                    *complete,
                ),
                ProjectWorkspaceIntent::ObserveSubagentStatusEvidence {
                    universe,
                    thread_id,
                    status,
                    evidence_kind,
                    source_revision,
                    observed_at_ms,
                    precondition,
                } => subagent_projection::observe_status_evidence(
                    transaction,
                    &library_id,
                    &context,
                    &store_epoch,
                    &request.operation_id,
                    &request_hash,
                    universe,
                    thread_id,
                    *status,
                    *evidence_kind,
                    *source_revision,
                    *observed_at_ms,
                    precondition.as_ref(),
                ),
                ProjectWorkspaceIntent::BufferSubagentStatusEvidence {
                    host_id,
                    source_epoch,
                    generation,
                    thread_id,
                    status,
                    evidence_kind,
                    source_revision,
                    observed_at_ms,
                } => subagent_projection::buffer_status_evidence(
                    transaction,
                    &library_id,
                    &context,
                    &store_epoch,
                    &request.operation_id,
                    &request_hash,
                    host_id,
                    source_epoch,
                    *generation,
                    thread_id,
                    *status,
                    *evidence_kind,
                    *source_revision,
                    *observed_at_ms,
                ),
                ProjectWorkspaceIntent::BeginSubagentLifecycle {
                    universe,
                    lifecycle_operation_id,
                    action,
                } => subagent_projection::begin_lifecycle(
                    transaction,
                    &library_id,
                    &context,
                    &store_epoch,
                    &request.operation_id,
                    &request_hash,
                    universe,
                    lifecycle_operation_id,
                    *action,
                ),
                ProjectWorkspaceIntent::ObserveSubagentLifecycleOutcomes {
                    lifecycle_operation_id,
                    observations,
                } => subagent_projection::observe_lifecycle_outcomes(
                    transaction,
                    &library_id,
                    &context,
                    &store_epoch,
                    &request.operation_id,
                    &request_hash,
                    lifecycle_operation_id,
                    observations,
                ),
                ProjectWorkspaceIntent::SetThreadArchived {
                    thread_id,
                    archived,
                } => thread::set_thread_archived(
                    transaction,
                    &library_id,
                    &context,
                    &store_epoch,
                    &request.operation_id,
                    &request_hash,
                    thread_id,
                    *archived,
                ),
                ProjectWorkspaceIntent::SetThreadPinned {
                    thread_id,
                    pinned,
                    placement,
                } => {
                    thread::set_thread_pinned(
                        transaction,
                        &library_id,
                        &context,
                        &store_epoch,
                        &request.operation_id,
                        &request_hash,
                        thread_id,
                        *pinned,
                        placement.as_ref(),
                    )
                }
                ProjectWorkspaceIntent::ReorderPinnedThreads { thread_ids } => {
                    thread::reorder_pinned_threads(
                        transaction,
                        &library_id,
                        &context,
                        &store_epoch,
                        &request.operation_id,
                        &request_hash,
                        thread_ids,
                    )
                }
                ProjectWorkspaceIntent::MoveThread {
                    thread_id,
                    source,
                    target,
                    placement,
                    metadata,
                    runtime_workspace_roots,
                    project_access_grant,
                } => sidebar::move_thread(
                    transaction,
                    &library_id,
                    &context,
                    &store_epoch,
                    &request.operation_id,
                    &request_hash,
                    thread_id,
                    match source {
                        nodex_core_contracts::workspace::ProjectWorkspaceThreadLane::Project {
                            project_id,
                        } => Some(project_id.as_str()),
                        nodex_core_contracts::workspace::ProjectWorkspaceThreadLane::Projectless => {
                            None
                        }
                    },
                    match target {
                        nodex_core_contracts::workspace::ProjectWorkspaceThreadLane::Project {
                            project_id,
                        } => Some(project_id.as_str()),
                        nodex_core_contracts::workspace::ProjectWorkspaceThreadLane::Projectless => {
                            None
                        }
                    },
                    placement,
                    metadata,
                    runtime_workspace_roots.as_deref(),
                    project_access_grant.as_ref(),
                ),
                ProjectWorkspaceIntent::SetThreadUnread { thread_id, unread } => {
                    thread::set_thread_unread(
                        transaction,
                        &library_id,
                        &context,
                        &store_epoch,
                        &request.operation_id,
                        &request_hash,
                        thread_id,
                        *unread,
                    )
                }
                ProjectWorkspaceIntent::ReplaceThreadDynamicToolCatalogs {
                    thread_id,
                    catalogs,
                } => thread::replace_dynamic_tool_catalogs(
                    transaction,
                    &library_id,
                    &context,
                    &store_epoch,
                    &request.operation_id,
                    &request_hash,
                    thread_id,
                    catalogs,
                ),
                ProjectWorkspaceIntent::MergeThreadWritableRoots { thread_id, roots } => {
                    execution::mutate_writable_roots(
                        transaction,
                        &library_id,
                        &context,
                        &store_epoch,
                        &request.operation_id,
                        &request_hash,
                        thread_id,
                        roots,
                        true,
                    )
                }
                ProjectWorkspaceIntent::ReplaceThreadWritableRoots { thread_id, roots } => {
                    execution::mutate_writable_roots(
                        transaction,
                        &library_id,
                        &context,
                        &store_epoch,
                        &request.operation_id,
                        &request_hash,
                        thread_id,
                        roots,
                        false,
                    )
                }
                ProjectWorkspaceIntent::FreezeTurnAuthority {
                    thread_id,
                    turn_id,
                    root_thread_id,
                    actor_project_id,
                    source,
                    inherited_from,
                } => execution::freeze_turn_authority(
                    transaction,
                    &library_id,
                    &context,
                    &store_epoch,
                    &request.operation_id,
                    &request_hash,
                    thread_id,
                    turn_id,
                    root_thread_id,
                    actor_project_id,
                    *source,
                    inherited_from.as_ref().map(|coordinate| {
                        (coordinate.thread_id.as_str(), coordinate.turn_id.as_str())
                    }),
                ),
                ProjectWorkspaceIntent::UpsertBackgroundProcess {
                    process,
                    preserve_started_at,
                } => execution::upsert_background_process(
                    transaction,
                    &library_id,
                    &context,
                    &store_epoch,
                    &request.operation_id,
                    &request_hash,
                    process,
                    preserve_started_at.unwrap_or(true),
                ),
                ProjectWorkspaceIntent::SetProjectPermissionMode { project_id, mode } => {
                    thread::set_project_permission_mode(
                        transaction,
                        &library_id,
                        &context,
                        &store_epoch,
                        &request.operation_id,
                        &request_hash,
                        project_id,
                        *mode,
                    )
                }
                ProjectWorkspaceIntent::SetProjectlessPermissionMode { mode } => {
                    thread::set_projectless_permission_mode(
                        transaction,
                        &library_id,
                        &context,
                        &store_epoch,
                        &request.operation_id,
                        &request_hash,
                        *mode,
                    )
                }
                ProjectWorkspaceIntent::MutateSession { session_id, intent } => {
                    session_mutation::mutate_session(
                        transaction,
                        &library_id,
                        &context,
                        &store_epoch,
                        &request.operation_id,
                        &request_hash,
                        session_id,
                        intent,
                    )
                }
            }
        })
    })
}

#[derive(Clone, Copy)]
enum ProjectCreationMode {
    Initial,
    Subsequent,
}

fn project_catalog_is_empty(connection: &Connection, library_id: &str) -> Result<bool, StoreError> {
    Ok(connection.query_row(
        "SELECT NOT EXISTS(SELECT 1 FROM projects WHERE library_id = ?1)",
        [library_id],
        |row| row.get(0),
    )?)
}

#[allow(clippy::too_many_arguments)]
fn create_project(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    project_id: &str,
    name: &str,
    description: &str,
    appearance: Option<&ProjectAppearance>,
    source_roots: &[String],
    page_key_prefix: Option<&str>,
    starter_page: Option<&ProjectWorkspaceStarterPage>,
    assets_root: &Path,
    mode: ProjectCreationMode,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    validate_project_input(project_id, description)?;
    let project_count = connection.query_row(
        "SELECT count(*) FROM projects WHERE library_id = ?1",
        [library_id],
        |row| row.get::<_, i64>(0),
    )?;
    match mode {
        ProjectCreationMode::Initial if project_count != 0 => {
            return Err(conflict(
                "The initial Project has already been created for this Library",
            ));
        }
        ProjectCreationMode::Subsequent if project_count == 0 => {
            return Err(conflict(
                "The first Project must be created with CreateInitialProject",
            ));
        }
        ProjectCreationMode::Initial | ProjectCreationMode::Subsequent => {}
    }
    require_unarchived_project_capacity(connection, library_id)?;
    let sources = normalize_source_roots(source_roots)?;
    if matches!(mode, ProjectCreationMode::Initial) && sources.is_empty() {
        return Err(invalid(
            "The initial Project requires at least one source root",
        ));
    }
    let name = normalize_project_name(name, &sources)?;
    let appearance = appearance
        .map(normalize_project_appearance)
        .transpose()
        .map_err(invalid)?
        .unwrap_or_default();
    let committed_at = sqlite_now(connection)?;
    let commit_result = durable_mutation::run(
        connection,
        OperationIdentity {
            module: ModuleName::ProjectWorkspace,
            module_name: MODULE_NAME,
            operation_id,
            intent_hash: request_hash,
            store_epoch,
            committed_at: &committed_at,
            context,
        },
        |scope| {
            let created = create_project_records(
                connection,
                scope.evidence(),
                &committed_at,
                library_id,
                project_id,
                &name,
                description,
                &appearance,
                &sources,
                page_key_prefix,
                operation_id,
                assets_root,
                starter_page.map(|page| StarterPageGenesisRequest { page, store_epoch }),
            )?;
            let mut block_ids = vec![
                created.identities.database_id.clone(),
                created.canvas.block_id,
            ];
            let mut document_ids = vec![created.canvas.document_id];
            let mut page_ids = Vec::new();
            let mut data_source_ids = Vec::new();
            let mut view_ids = Vec::new();
            let mut document_heads = Vec::new();
            if let Some(starter_page) = &created.starter_page {
                page_ids.push(starter_page.page_create.page_id.clone());
                block_ids.push(starter_page.page_create.page_id.clone());
                block_ids.extend(starter_page.page_create.block_ids.iter().cloned());
                document_ids.push(starter_page.page_create.document_id.clone());
                data_source_ids.push(starter_page.data_source_id.clone());
                view_ids.extend(starter_page.affected_view_ids.iter().cloned());
                document_heads.push(starter_page.document_head.clone());
            }
            seal_mutation(
                scope,
                context,
                operation_id,
                WorkspaceMutationEffects {
                    operation_kind: "create_project",
                    project_catalog_change: Some(ProjectCatalogChangeKind::Created),
                    change_project_id: project_id.to_owned(),
                    project_ids: vec![project_id.to_owned()],
                    session_ids: Vec::new(),
                    thread_ids: Vec::new(),
                    session_summary_scopes: Vec::new(),
                    session_detail_ids: Vec::new(),
                    block_ids,
                    document_ids,
                    database_ids: vec![created.identities.database_id],
                    page_ids,
                    data_source_ids,
                    view_ids,
                    document_heads,
                    committed_at: committed_at.clone(),
                    queued_follow_up_ledger: None,
                },
            )
        },
    )?;
    workspace_commit_result(connection, commit_result)
}

pub(super) fn run_mutation(
    connection: &Connection,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    committed_at: &str,
    apply: impl FnOnce(&DurableMutationScope<'_>) -> Result<WorkspaceMutationEffects, StoreError>,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    let result = durable_mutation::run(
        connection,
        OperationIdentity {
            module: ModuleName::ProjectWorkspace,
            module_name: MODULE_NAME,
            operation_id,
            intent_hash: request_hash,
            store_epoch,
            committed_at,
            context,
        },
        |scope| {
            let effects = apply(scope)?;
            seal_mutation(scope, context, operation_id, effects)
        },
    )?;
    workspace_commit_result(connection, result)
}

pub(super) fn finish_mutation(
    connection: &Connection,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    effects: WorkspaceMutationEffects,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    let committed_at = effects.committed_at.clone();
    run_mutation(
        connection,
        context,
        store_epoch,
        operation_id,
        request_hash,
        &committed_at,
        |_| Ok(effects),
    )
}

#[allow(clippy::too_many_arguments)]
pub(super) fn finish_no_op(
    connection: &Connection,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    operation_kind: &'static str,
    project_ids: Vec<String>,
    session_ids: Vec<String>,
    committed_at: &str,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    finish_no_op_with_queued_follow_up(
        connection,
        context,
        store_epoch,
        operation_id,
        request_hash,
        operation_kind,
        project_ids,
        session_ids,
        committed_at,
        None,
    )
}

#[allow(clippy::too_many_arguments)]
pub(super) fn finish_no_op_with_queued_follow_up(
    connection: &Connection,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    operation_kind: &'static str,
    project_ids: Vec<String>,
    session_ids: Vec<String>,
    committed_at: &str,
    queued_follow_up_ledger: Option<ProjectWorkspaceQueuedFollowUpLedgerCommit>,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    let result = durable_mutation::run(
        connection,
        OperationIdentity {
            module: ModuleName::ProjectWorkspace,
            module_name: MODULE_NAME,
            operation_id,
            intent_hash: request_hash,
            store_epoch,
            committed_at,
            context,
        },
        |scope| {
            let commit_seq = local_commit::head(scope.connection())?;
            let event_sequence = scope.connection().query_row(
                "SELECT COALESCE(MAX(seq), 0) FROM change_log",
                [],
                |row| row.get::<_, i64>(0),
            )?;
            let committed = crate::ModuleWriterResult {
                value: ProjectWorkspaceCommitValue {
                    affected_project_ids: project_ids.clone(),
                    affected_session_ids: session_ids.clone(),
                    affected_thread_ids: Vec::new(),
                    queued_follow_up_ledger: queued_follow_up_ledger.clone(),
                },
                receipt: ProjectWorkspaceReceipt {
                    mutation: ModuleMutationReceipt {
                        operation_id: operation_id.to_owned(),
                        duplicate: false,
                    },
                    affected_project_ids: project_ids.clone(),
                    affected_session_ids: session_ids.clone(),
                },
                commit_seq,
                event_sequence,
                store_epoch: StoreEpoch(store_epoch.to_owned()),
            };
            Ok(scope.no_op(
                committed,
                ReceiptMetadata {
                    operation_kind,
                    event_sequence: None,
                    committed_at,
                },
            ))
        },
    )?;
    workspace_commit_result(connection, result)
}

fn workspace_commit_result(
    connection: &Connection,
    result: CommitResult<
        crate::ModuleWriterResult<ProjectWorkspaceCommitValue, ProjectWorkspaceReceipt>,
    >,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    result.verify_manifest_identity(|committed| {
        (committed.commit_seq, committed.store_epoch.0.clone())
    })?;
    match result {
        CommitResult::Committed {
            outcome: committed, ..
        } => {
            let event = load_committed_event_by_sequence(connection, committed.event_sequence)?;
            Ok(ProjectWorkspaceApplyOutcome {
                committed,
                event: Some(event),
            })
        }
        CommitResult::NoOp { outcome: committed } => Ok(ProjectWorkspaceApplyOutcome {
            committed,
            event: None,
        }),
        CommitResult::IdempotentReplay {
            outcome: mut committed,
            ..
        } => {
            committed.receipt.mutation.duplicate = true;
            Ok(ProjectWorkspaceApplyOutcome {
                committed,
                event: None,
            })
        }
    }
}

fn seal_mutation(
    scope: &DurableMutationScope<'_>,
    context: &BoundModuleContext,
    operation_id: &str,
    effects: WorkspaceMutationEffects,
) -> Result<
    SealedOutcome<crate::ModuleWriterResult<ProjectWorkspaceCommitValue, ProjectWorkspaceReceipt>>,
    StoreError,
> {
    let connection = scope.connection();
    let store_epoch = scope.store_epoch();
    let payload = json!({
        "module": MODULE_NAME,
        "operationKind": effects.operation_kind,
        "kind": "workspace_changed",
        "projectCatalogChange": effects.project_catalog_change,
        "projectIds": effects.project_ids,
        "sessionIds": effects.session_ids,
        "threadIds": effects.thread_ids,
        "sessionSummaryScopes": effects.session_summary_scopes,
        "sessionDetailIds": effects.session_detail_ids,
    });
    let projection_impact = expand_database_coordinates(
        connection,
        ProjectionImpact::Resources {
            page_ids: effects.page_ids.clone(),
            database_ids: effects.database_ids.clone(),
            data_source_ids: effects.data_source_ids.clone(),
            view_ids: effects.view_ids.clone(),
            document_heads: effects.document_heads.clone(),
        },
    )?;
    let authorization_before = scope.authorization_before()?;
    crate::database::record_local_projection_delta(
        connection,
        scope.evidence(),
        &context.library_id.0,
        &projection_impact,
        &authorization_before,
    )?;
    let payload_json =
        serde_json::to_string(&payload).map_err(|_| internal("Project Workspace event payload"))?;
    let event_sequence = append_change_log(
        connection,
        NewChangeLogEntry {
            project_id: &effects.change_project_id,
            store_epoch,
            kind: "project_workspace.changed",
            operation_id: Some(operation_id),
            block_ids: &effects.block_ids,
            document_ids: &effects.document_ids,
            database_block_ids: &effects.database_ids,
            payload_json: &payload_json,
            projection_impact: &projection_impact,
            committed_at: &effects.committed_at,
        },
        scope.evidence(),
    )?;
    let committed = crate::ModuleWriterResult {
        value: ProjectWorkspaceCommitValue {
            affected_project_ids: effects.project_ids.clone(),
            affected_session_ids: effects.session_ids.clone(),
            affected_thread_ids: effects.thread_ids.clone(),
            queued_follow_up_ledger: effects.queued_follow_up_ledger.clone(),
        },
        receipt: ProjectWorkspaceReceipt {
            mutation: ModuleMutationReceipt {
                operation_id: operation_id.to_owned(),
                duplicate: false,
            },
            affected_project_ids: effects.project_ids.clone(),
            affected_session_ids: effects.session_ids.clone(),
        },
        commit_seq: scope.commit_seq(),
        event_sequence,
        store_epoch: StoreEpoch(store_epoch.to_owned()),
    };
    Ok(scope.seal(
        committed,
        ReceiptMetadata {
            operation_kind: effects.operation_kind,
            event_sequence: Some(event_sequence),
            committed_at: &effects.committed_at,
        },
    ))
}

#[allow(clippy::too_many_arguments)]
fn update_project(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    project_id: &str,
    expected_binding_revision: i64,
    name: Option<&str>,
    description: Option<&str>,
    appearance: Option<&ProjectAppearance>,
    source_roots: Option<&[String]>,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    validate_id("project_id", project_id)?;
    if expected_binding_revision < 1 {
        return Err(invalid("expected_binding_revision must be positive"));
    }
    let (lifecycle, binding_revision) = require_project(connection, library_id, project_id)?;
    if lifecycle != "active" {
        return Err(conflict(
            "Project must be active to update metadata or sources",
        ));
    }
    if binding_revision != expected_binding_revision {
        return Err(StoreError::new(
            StoreErrorCode::RevisionConflict,
            "Project binding revision changed",
            true,
        ));
    }
    let name = name
        .map(|value| normalize_project_name(value, &[]))
        .transpose()?;
    if let Some(value) = description {
        validate_description(value)?;
    }
    let appearance = appearance
        .map(normalize_project_appearance)
        .transpose()
        .map_err(invalid)?;
    let sources = source_roots.map(normalize_source_roots).transpose()?;
    let now = sqlite_now(connection)?;
    let project_catalog_change = if sources.is_some() {
        ProjectCatalogChangeKind::SourcesUpdated
    } else {
        ProjectCatalogChangeKind::MetadataUpdated
    };
    run_mutation(
        connection,
        context,
        store_epoch,
        operation_id,
        request_hash,
        &now,
        |_| {
            let metadata_changed = name.is_some() || description.is_some() || appearance.is_some();
            if metadata_changed {
                let appearance_storage = appearance.as_ref().map(project_appearance_storage);
                let changed = connection.execute(
                    "UPDATE projects SET \
                       name = COALESCE(?1, name), description = COALESCE(?2, description), \
                       appearance_color = COALESCE(?3, appearance_color), \
                       appearance_marker_kind = COALESCE(?4, appearance_marker_kind), \
                       appearance_marker_value = COALESCE(?5, appearance_marker_value), \
                       binding_revision = binding_revision + 1, updated = ?6 \
                     WHERE id = ?7 AND library_id = ?8 AND binding_revision = ?9",
                    params![
                        name.as_deref(),
                        description,
                        appearance_storage.as_ref().map(|value| value.0),
                        appearance_storage.as_ref().map(|value| value.1),
                        appearance_storage.as_ref().map(|value| value.2.as_str()),
                        now,
                        project_id,
                        library_id,
                        expected_binding_revision,
                    ],
                )?;
                if changed != 1 {
                    return Err(corrupt("Project disappeared during metadata update"));
                }
            }
            if let Some(sources) = &sources {
                connection.execute(
                    "DELETE FROM project_sources WHERE project_id = ?1",
                    [project_id],
                )?;
                insert_project_sources(connection, project_id, sources, &now)?;
                if !metadata_changed {
                    let changed = connection.execute(
                        "UPDATE projects SET binding_revision = binding_revision + 1, updated = ?1 \
                         WHERE id = ?2 AND library_id = ?3 AND binding_revision = ?4",
                        params![now, project_id, library_id, expected_binding_revision],
                    )?;
                    if changed != 1 {
                        return Err(corrupt("Project disappeared during source update"));
                    }
                }
            }
            let effects = project_mutation_effects(
                "update_project",
                project_catalog_change,
                project_id,
                Vec::new(),
                now.clone(),
            );
            Ok(effects)
        },
    )
}

#[allow(clippy::too_many_arguments)]
fn set_project_lifecycle(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    project_id: &str,
    lifecycle: ProjectLifecycle,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    validate_id("project_id", project_id)?;
    let (current_lifecycle, _) = require_project(connection, library_id, project_id)?;
    let next_lifecycle = lifecycle_literal(lifecycle);
    let now = sqlite_now(connection)?;
    if current_lifecycle == "archived" && next_lifecycle != "archived" {
        require_unarchived_project_capacity(connection, library_id)?;
    }
    let effects = project_mutation_effects(
        "set_project_lifecycle",
        ProjectCatalogChangeKind::LifecycleUpdated,
        project_id,
        vec![ProjectSessionInvalidationScope::All],
        now.clone(),
    );
    run_mutation(
        connection,
        context,
        store_epoch,
        operation_id,
        request_hash,
        &now,
        |_| {
            if current_lifecycle != next_lifecycle {
                let changed = connection.execute(
                    "UPDATE projects SET lifecycle = ?1, binding_revision = binding_revision + 1, \
                       updated = ?2 WHERE id = ?3 AND library_id = ?4 AND lifecycle = ?5",
                    params![
                        next_lifecycle,
                        now,
                        project_id,
                        library_id,
                        current_lifecycle
                    ],
                )?;
                if changed != 1 {
                    return Err(StoreError::new(
                        StoreErrorCode::RevisionConflict,
                        "Project lifecycle changed",
                        true,
                    ));
                }
                if next_lifecycle == "archived" {
                    connection.execute(
                        "DELETE FROM pinned_project_order WHERE project_id = ?1",
                        [project_id],
                    )?;
                    connection.execute(
                        "DELETE FROM project_order WHERE project_id = ?1",
                        [project_id],
                    )?;
                } else if current_lifecycle == "archived" {
                    connection.execute(
                        "INSERT INTO project_order(project_id, \"order\", updated) \
                         SELECT ?1, COALESCE(MAX(ordering.\"order\"), -1) + 1, ?2 \
                         FROM project_order ordering \
                         JOIN projects project ON project.id = ordering.project_id \
                         WHERE project.library_id = ?3",
                        params![project_id, now, library_id],
                    )?;
                }
            }
            Ok(effects)
        },
    )
}

fn reorder_projects(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    project_ids: &[String],
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    if project_ids.len() > MAX_PROJECT_ORDER_SIZE {
        return Err(invalid("Project order exceeds its bound"));
    }
    for project_id in project_ids {
        validate_id("project_id", project_id)?;
    }
    let requested = project_ids.iter().cloned().collect::<BTreeSet<_>>();
    if requested.len() != project_ids.len() {
        return Err(invalid("Project order contains duplicate identities"));
    }
    let current = connection
        .prepare(
            "SELECT project.id FROM projects project \
             LEFT JOIN project_order ordering ON ordering.project_id = project.id \
             WHERE project.library_id = ?1 AND project.lifecycle <> 'archived' \
             ORDER BY COALESCE(ordering.\"order\", 9223372036854775807), \
               project.created, project.id",
        )?
        .query_map([library_id], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if requested != current.iter().cloned().collect::<BTreeSet<_>>() {
        return Err(StoreError::new(
            StoreErrorCode::Conflict,
            "Project order must contain exactly the current sidebar Projects",
            true,
        ));
    }
    let now = sqlite_now(connection)?;
    for (order, project_id) in project_ids.iter().enumerate() {
        connection.execute(
            "INSERT INTO project_order(project_id, \"order\", updated) VALUES (?1, ?2, ?3) \
             ON CONFLICT(project_id) DO UPDATE SET \
               \"order\" = excluded.\"order\", updated = excluded.updated",
            params![
                project_id,
                i64::try_from(order).map_err(|_| internal("Project order"))?,
                now
            ],
        )?;
    }
    let change_project_id = project_ids
        .first()
        .cloned()
        .map_or_else(|| workspace_event_anchor(connection, library_id), Ok)?;
    finish_mutation(
        connection,
        context,
        store_epoch,
        operation_id,
        request_hash,
        WorkspaceMutationEffects {
            operation_kind: "reorder_projects",
            project_catalog_change: Some(ProjectCatalogChangeKind::Reordered),
            change_project_id,
            project_ids: project_ids.to_vec(),
            session_ids: Vec::new(),
            thread_ids: Vec::new(),
            session_summary_scopes: Vec::new(),
            session_detail_ids: Vec::new(),
            block_ids: Vec::new(),
            document_ids: Vec::new(),
            database_ids: Vec::new(),
            page_ids: Vec::new(),
            data_source_ids: Vec::new(),
            view_ids: Vec::new(),
            document_heads: Vec::new(),
            committed_at: now,
            queued_follow_up_ledger: None,
        },
    )
}

#[allow(clippy::too_many_arguments)]
fn set_project_pinned(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    project_id: &str,
    pinned: bool,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    validate_id("project_id", project_id)?;
    let (lifecycle, _) = require_project(connection, library_id, project_id)?;
    if lifecycle != "active" {
        return Err(conflict("Project must be active to change pin state"));
    }
    let now = sqlite_now(connection)?;
    if pinned {
        connection.execute(
            "DELETE FROM workspace_sidebar_section_items WHERE project_id = ?1",
            [project_id],
        )?;
        connection.execute(
            "INSERT INTO pinned_project_order(project_id, \"order\", updated) \
             SELECT ?1, COALESCE(MAX(pinned.\"order\"), -1) + 1, ?2 \
             FROM projects project \
             LEFT JOIN pinned_project_order pinned ON pinned.project_id = project.id \
             WHERE project.library_id = ?3 \
             ON CONFLICT(project_id) DO NOTHING",
            params![project_id, now, library_id],
        )?;
    } else {
        connection.execute(
            "DELETE FROM pinned_project_order WHERE project_id = ?1",
            [project_id],
        )?;
    }
    finish_project_mutation(
        connection,
        context,
        store_epoch,
        operation_id,
        request_hash,
        "set_project_pinned",
        ProjectCatalogChangeKind::PinUpdated,
        project_id,
        Vec::new(),
        Vec::new(),
        now,
    )
}

#[allow(clippy::too_many_arguments)]
fn reorder_pinned_projects(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    project_ids: &[String],
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    if project_ids.len() > MAX_PROJECT_ORDER_SIZE {
        return Err(invalid("Pinned Project order exceeds its bound"));
    }
    for project_id in project_ids {
        validate_id("project_id", project_id)?;
    }
    let requested = project_ids.iter().cloned().collect::<BTreeSet<_>>();
    if requested.len() != project_ids.len() {
        return Err(invalid(
            "Pinned Project order contains duplicate identities",
        ));
    }
    let current = connection
        .prepare(
            "SELECT project.id FROM pinned_project_order pinned \
             JOIN projects project ON project.id = pinned.project_id \
             WHERE project.library_id = ?1 AND project.lifecycle <> 'archived' \
             ORDER BY pinned.\"order\", project.created, project.id",
        )?
        .query_map([library_id], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if requested != current.iter().cloned().collect::<BTreeSet<_>>() {
        return Err(StoreError::new(
            StoreErrorCode::Conflict,
            "Pinned Project order must contain exactly the current pinned Projects",
            true,
        ));
    }
    let now = sqlite_now(connection)?;
    for (order, project_id) in project_ids.iter().enumerate() {
        let changed = connection.execute(
            "UPDATE pinned_project_order SET \"order\" = ?1, updated = ?2 \
             WHERE project_id = ?3",
            params![
                i64::try_from(order).map_err(|_| internal("Pinned Project order"))?,
                now,
                project_id,
            ],
        )?;
        if changed != 1 {
            return Err(corrupt("Pinned Project order changed during mutation"));
        }
    }
    let change_project_id = project_ids
        .first()
        .cloned()
        .map_or_else(|| workspace_event_anchor(connection, library_id), Ok)?;
    finish_mutation(
        connection,
        context,
        store_epoch,
        operation_id,
        request_hash,
        WorkspaceMutationEffects {
            operation_kind: "reorder_pinned_projects",
            project_catalog_change: Some(ProjectCatalogChangeKind::PinUpdated),
            change_project_id,
            project_ids: project_ids.to_vec(),
            session_ids: Vec::new(),
            thread_ids: Vec::new(),
            session_summary_scopes: Vec::new(),
            session_detail_ids: Vec::new(),
            block_ids: Vec::new(),
            document_ids: Vec::new(),
            database_ids: Vec::new(),
            page_ids: Vec::new(),
            data_source_ids: Vec::new(),
            view_ids: Vec::new(),
            document_heads: Vec::new(),
            committed_at: now,
            queued_follow_up_ledger: None,
        },
    )
}

#[allow(clippy::too_many_arguments)]
fn finish_project_mutation(
    connection: &Connection,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    operation_kind: &'static str,
    project_catalog_change: ProjectCatalogChangeKind,
    project_id: &str,
    database_ids: Vec<String>,
    session_summary_scopes: Vec<ProjectSessionInvalidationScope>,
    committed_at: String,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    let mut effects = project_mutation_effects(
        operation_kind,
        project_catalog_change,
        project_id,
        session_summary_scopes,
        committed_at,
    );
    effects.database_ids = database_ids;
    finish_mutation(
        connection,
        context,
        store_epoch,
        operation_id,
        request_hash,
        effects,
    )
}

fn project_mutation_effects(
    operation_kind: &'static str,
    project_catalog_change: ProjectCatalogChangeKind,
    project_id: &str,
    session_summary_scopes: Vec<ProjectSessionInvalidationScope>,
    committed_at: String,
) -> WorkspaceMutationEffects {
    WorkspaceMutationEffects {
        operation_kind,
        project_catalog_change: Some(project_catalog_change),
        change_project_id: project_id.to_owned(),
        project_ids: vec![project_id.to_owned()],
        session_ids: Vec::new(),
        thread_ids: Vec::new(),
        session_summary_scopes,
        session_detail_ids: Vec::new(),
        block_ids: Vec::new(),
        document_ids: Vec::new(),
        database_ids: Vec::new(),
        page_ids: Vec::new(),
        data_source_ids: Vec::new(),
        view_ids: Vec::new(),
        document_heads: Vec::new(),
        committed_at,
        queued_follow_up_ledger: None,
    }
}

fn require_project(
    connection: &Connection,
    library_id: &str,
    project_id: &str,
) -> Result<(String, i64), StoreError> {
    connection
        .query_row(
            "SELECT lifecycle, binding_revision FROM projects \
             WHERE id = ?1 AND library_id = ?2",
            params![project_id, library_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?
        .ok_or_else(|| not_found("Project is unavailable in this Library"))
}

pub(super) fn grant_project_sources_for_thread_move(
    connection: &Connection,
    library_id: &str,
    source_project_id: &str,
    target_project_id: &str,
    grant: &ProjectWorkspaceThreadMoveProjectAccessGrant,
) -> Result<(), StoreError> {
    if grant.expected_target_binding_revision < 1 {
        return Err(invalid("expected_target_binding_revision must be positive"));
    }
    if grant.missing_source_roots.is_empty() {
        return Err(invalid("Project access grant must include source roots"));
    }

    let (source_lifecycle, _) = require_project(connection, library_id, source_project_id)?;
    if source_lifecycle != "active" {
        return Err(conflict("Source Project must be active during Thread move"));
    }
    let (target_lifecycle, target_binding_revision) =
        require_project(connection, library_id, target_project_id)?;
    if target_lifecycle != "active" {
        return Err(conflict("Target Project must be active during Thread move"));
    }
    if target_binding_revision != grant.expected_target_binding_revision {
        return Err(StoreError::new(
            StoreErrorCode::RevisionConflict,
            "Target Project binding revision changed",
            true,
        ));
    }

    let source_roots = connection
        .prepare("SELECT root FROM project_sources WHERE project_id = ?1 ORDER BY \"order\"")?
        .query_map([source_project_id], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let source_root_set = source_roots.into_iter().collect::<BTreeSet<_>>();
    let requested = normalize_source_roots(&grant.missing_source_roots)?;
    if requested.len() != grant.missing_source_roots.len() {
        return Err(invalid(
            "Project access grant source roots must be unique and non-empty",
        ));
    }
    if requested
        .iter()
        .any(|source| !source_root_set.contains(&source.root))
    {
        return Err(invalid(
            "Project access grant may only add roots from the source Project",
        ));
    }

    let target_roots = connection
        .prepare("SELECT root FROM project_sources WHERE project_id = ?1 ORDER BY \"order\"")?
        .query_map([target_project_id], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut next_roots = target_roots.clone();
    next_roots.extend(requested.iter().map(|source| source.root.clone()));
    let next_sources = normalize_source_roots(&next_roots)?;
    if next_sources.len() == target_roots.len() {
        return Err(conflict(
            "Target Project sources changed before the confirmed Thread move",
        ));
    }

    let now = sqlite_now(connection)?;
    let updated = connection.execute(
        "UPDATE projects SET binding_revision = binding_revision + 1, updated = ?1 \
         WHERE id = ?2 AND library_id = ?3 AND lifecycle = 'active' \
           AND binding_revision = ?4",
        params![
            now,
            target_project_id,
            library_id,
            grant.expected_target_binding_revision,
        ],
    )?;
    if updated != 1 {
        return Err(StoreError::new(
            StoreErrorCode::RevisionConflict,
            "Target Project binding revision changed",
            true,
        ));
    }
    connection.execute(
        "DELETE FROM project_sources WHERE project_id = ?1",
        [target_project_id],
    )?;
    insert_project_sources(connection, target_project_id, &next_sources, &now)
}

pub(super) fn workspace_event_anchor(
    connection: &Connection,
    library_id: &str,
) -> Result<String, StoreError> {
    connection
        .query_row(
            "SELECT id FROM projects WHERE library_id = ?1 ORDER BY created, id LIMIT 1",
            [library_id],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| corrupt("Project Workspace has no event anchor Project"))
}

fn lifecycle_literal(lifecycle: ProjectLifecycle) -> &'static str {
    match lifecycle {
        ProjectLifecycle::Active => "active",
        ProjectLifecycle::Inactive => "inactive",
        ProjectLifecycle::Archived => "archived",
    }
}

#[allow(clippy::too_many_arguments)]
fn create_project_records(
    connection: &Connection,
    commit_context: &CommitContext,
    committed_at: &str,
    library_id: &str,
    project_id: &str,
    name: &str,
    description: &str,
    appearance: &ProjectAppearance,
    sources: &[ProjectSource],
    page_key_prefix: Option<&str>,
    identity_namespace: &str,
    assets_root: &Path,
    starter_page: Option<StarterPageGenesisRequest<'_>>,
) -> Result<CreatedProjectAggregate, StoreError> {
    let identities = aggregate_identities(identity_namespace, project_id);
    let canvas_block_id = primary_canvas_block_id(project_id);
    let canvas_document_id = primary_canvas_document_id(project_id);
    let collision = connection
        .query_row(
            "SELECT 1 WHERE EXISTS (SELECT 1 FROM projects WHERE id = ?1) \
             OR EXISTS (SELECT 1 FROM blocks WHERE id IN (?2, ?3)) \
             OR EXISTS (SELECT 1 FROM documents WHERE id = ?4) \
             OR EXISTS (SELECT 1 FROM data_sources WHERE id = ?5) \
             OR EXISTS (SELECT 1 FROM database_views WHERE id = ?6)",
            params![
                project_id,
                identities.database_id,
                canvas_block_id,
                canvas_document_id,
                identities.data_source_id,
                identities.view_id,
            ],
            |_| Ok(()),
        )
        .optional()?;
    if collision.is_some() {
        return Err(StoreError::new(
            StoreErrorCode::Conflict,
            "Project aggregate identity already exists",
            false,
        ));
    }
    let database_name = derive_project_resource_name(name, PROJECT_DATABASE_NAME_SUFFIX);
    let canvas_name = derive_project_resource_name(name, PROJECT_CANVAS_NAME_SUFFIX);
    let now = committed_at.to_owned();
    let appearance_storage = project_appearance_storage(appearance);
    connection.execute("UPDATE project_order SET \"order\" = \"order\" + 1", [])?;
    connection.execute(
        "INSERT INTO projects(\
           id, library_id, database_block_id, lifecycle, binding_revision, name, description, \
           appearance_color, appearance_marker_kind, appearance_marker_value, created, updated\
         ) VALUES (?1, ?2, ?3, 'active', 1, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
        params![
            project_id,
            library_id,
            identities.database_id,
            name,
            description,
            appearance_storage.0,
            appearance_storage.1,
            appearance_storage.2,
            now
        ],
    )?;
    connection.execute(
        "INSERT INTO project_order(project_id, \"order\", updated) VALUES (?1, 0, ?2)",
        params![project_id, now],
    )?;
    insert_project_sources(connection, project_id, sources, &now)?;
    connection.execute(
        "INSERT INTO blocks(\
           id, library_id, type, lifecycle, placement_revision, metadata_revision, \
           created_at, updated_at\
         ) VALUES (?1, ?2, 'database', 'active', 1, 1, ?3, ?3)",
        params![identities.database_id, library_id, now],
    )?;
    connection.execute(
        "INSERT INTO library_block_placements(\
           block_id, library_id, rank_key, revision, created_at, updated_at\
         ) VALUES (?1, ?2, ?3, 1, ?4, ?4)",
        params![identities.database_id, library_id, INITIAL_RANK_KEY, now],
    )?;
    create_database_authority_records(
        connection,
        library_id,
        &identities.database_id,
        &identities.data_source_id,
        &identities.view_id,
        &database_name,
        &now,
    )?;
    create_page_key_namespace(
        connection,
        library_id,
        &identities.database_id,
        page_key_prefix,
        name,
        &now,
    )?;
    connection.execute(
        "INSERT INTO project_database_bindings(\
           project_id, library_id, database_block_id, lifecycle, revision, created_at, updated_at\
         ) VALUES (?1, ?2, ?3, 'active', 1, ?4, ?4)",
        params![project_id, library_id, identities.database_id, now],
    )?;
    let starter_page = starter_page
        .map(|request| {
            let destination = resolve_page_transfer_data_source_destination_prevalidated(
                connection,
                library_id,
                project_id,
                &identities.data_source_id,
                &identities.view_id,
                Some("triage"),
                None,
            )?;
            crate::library::page_genesis::create_page_in_data_source(
                connection,
                crate::library::page_genesis::PageGenesisInput {
                    commit_context,
                    library_id,
                    actor_project_id: project_id,
                    placement_access_project_id: None,
                    operation_id: identity_namespace,
                    store_epoch: request.store_epoch,
                    page_id: &request.page.page_id,
                    document_id: &request.page.document_id,
                    title_markdown: &request.page.title_markdown,
                    nfm: &request.page.nfm,
                    destination: &destination,
                    now: &now,
                },
            )
        })
        .transpose()?;
    let canvas = create_primary_canvas(
        connection,
        library_id,
        project_id,
        &canvas_name,
        &now,
        assets_root,
    )?;
    crate::library::insert_creator_resource_grant(
        connection,
        project_id,
        library_id,
        "canvas",
        &canvas.block_id,
        &now,
    )?;
    Ok(CreatedProjectAggregate {
        identities,
        canvas,
        starter_page,
    })
}

fn insert_project_sources(
    connection: &Connection,
    project_id: &str,
    sources: &[ProjectSource],
    now: &str,
) -> Result<(), StoreError> {
    for (order, source) in sources.iter().enumerate() {
        connection.execute(
            "INSERT INTO project_sources(\
               project_id, root, root_key, \"order\", created, updated\
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            params![
                project_id,
                source.root,
                source.root_key,
                i64::try_from(order).map_err(|_| internal("Project source order"))?,
                now,
            ],
        )?;
    }
    Ok(())
}

fn aggregate_identities(namespace: &str, project_id: &str) -> ProjectAggregateIdentities {
    ProjectAggregateIdentities {
        database_id: stable_uuid_v7(namespace, "database", project_id),
        data_source_id: stable_uuid_v7(namespace, "data_source", project_id),
        view_id: stable_uuid_v7(namespace, "view", project_id),
    }
}

fn validate_project_input(project_id: &str, description: &str) -> Result<(), StoreError> {
    validate_id("project_id", project_id)?;
    validate_description(description)
}

fn require_unarchived_project_capacity(
    connection: &Connection,
    library_id: &str,
) -> Result<(), StoreError> {
    let project_count = connection.query_row(
        "SELECT count(*) FROM projects \
         WHERE library_id = ?1 AND lifecycle <> 'archived'",
        [library_id],
        |row| row.get::<_, i64>(0),
    )?;
    if project_count
        < i64::try_from(MAX_UNARCHIVED_PROJECTS).expect("Project collection bound fits i64")
    {
        return Ok(());
    }
    Err(StoreError::new(
        StoreErrorCode::ResourceExhausted,
        "Available Project collection exceeds its fixed bound; remove a Project first",
        false,
    ))
}

fn validate_description(description: &str) -> Result<(), StoreError> {
    if description.len() > MAX_PROJECT_DESCRIPTION_BYTES {
        return Err(invalid("Project description exceeds its bound"));
    }
    Ok(())
}

fn project_appearance_storage(
    appearance: &ProjectAppearance,
) -> (&'static str, &'static str, String) {
    let color = project_marker_color_literal(appearance.color);
    match &appearance.marker {
        ProjectMarker::Icon { icon } => {
            (color, "icon", project_marker_icon_literal(*icon).to_owned())
        }
        ProjectMarker::Emoji { emoji } => (color, "emoji", emoji.clone()),
    }
}

fn normalize_project_name(name: &str, sources: &[ProjectSource]) -> Result<String, StoreError> {
    let explicit = name.trim();
    let value = if !explicit.is_empty() {
        explicit.to_owned()
    } else {
        sources
            .first()
            .and_then(|source| Path::new(&source.root).file_name())
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
            .unwrap_or("New project")
            .to_owned()
    };
    if value.chars().count() > MAX_PROJECT_NAME_CHARS || value.chars().any(char::is_control) {
        return Err(invalid("Project name is invalid"));
    }
    Ok(value)
}

fn derive_project_resource_name(project_name: &str, suffix: &str) -> String {
    let suffix_chars = suffix.chars().count();
    let project_name_chars = project_name.chars().count();
    if project_name_chars + suffix_chars <= MAX_PROJECT_RESOURCE_NAME_CHARS {
        return format!("{project_name}{suffix}");
    }

    let prefix_chars = MAX_PROJECT_RESOURCE_NAME_CHARS.saturating_sub(suffix_chars + 1);
    let prefix = project_name.chars().take(prefix_chars).collect::<String>();
    format!("{}…{suffix}", prefix.trim_end())
}

fn normalize_source_roots(values: &[String]) -> Result<Vec<ProjectSource>, StoreError> {
    if values.len() > MAX_SOURCE_ROOTS {
        return Err(invalid("Project source roots exceed their bound"));
    }
    let mut seen = BTreeSet::new();
    let mut sources = Vec::new();
    for value in values {
        let root = value.trim();
        if root.is_empty() {
            continue;
        }
        if root.len() > MAX_SOURCE_ROOT_BYTES
            || root.chars().any(char::is_control)
            || !PathBuf::from(root).is_absolute()
        {
            return Err(invalid(
                "Project source root must be a bounded absolute path",
            ));
        }
        let root_key = root.to_owned();
        if !seen.insert(root_key.clone()) {
            continue;
        }
        sources.push(ProjectSource {
            root: root.to_owned(),
            root_key,
        });
    }
    Ok(sources)
}

fn assert_identity(
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
        "bound Project Workspace identity is not present in this Profile store",
        false,
    ))
}

fn validate_id(name: &str, value: &str) -> Result<(), StoreError> {
    if !value.is_empty()
        && value == value.trim()
        && value.len() <= MAX_ID_LENGTH
        && !value.chars().any(char::is_control)
    {
        return Ok(());
    }
    Err(invalid(&format!(
        "{name} must be a canonical identity of at most {MAX_ID_LENGTH} bytes"
    )))
}

fn sqlite_now(connection: &Connection) -> Result<String, StoreError> {
    connection
        .query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", [], |row| {
            row.get::<_, String>(0)
        })
        .map_err(Into::into)
}

fn invalid(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message, false)
}

fn conflict(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::Conflict, message, true)
}

fn corrupt(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message, false)
}

fn internal(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::Internal, message, false)
}

fn not_found(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::NotFound, message, false)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use nodex_core_contracts::library::{
        LibraryIntent, LibraryRead, LibraryReadValue, LibraryRouteTarget,
    };
    use nodex_core_contracts::workspace::{
        CodexThreadActiveFlag, CodexThreadStatusType, ProjectAppearance, ProjectCatalogChangeKind,
        ProjectLifecycle, ProjectMarker, ProjectMarkerColor, ProjectMarkerIcon,
        ProjectSessionIntent, ProjectSessionInvalidationScope, ProjectWorkspaceBootstrapStatus,
        ProjectWorkspaceIntent, ProjectWorkspaceRead, ProjectWorkspaceReadValue,
        ProjectWorkspaceStarterPage, ProjectWorkspaceThreadPatch, ProjectWorkspaceThreadStatus,
        ProjectWorkspaceTurnAuthoritySource,
    };
    use nodex_core_contracts::{
        AdapterKind, BoundModuleContext, CoreErrorCode, CoreModuleEventPayload,
        LIBRARY_CONTRACT_VERSION, LibraryId, ModuleApplyRequest, ModuleReadRequest,
        PROJECT_WORKSPACE_CONTRACT_VERSION, ProfileId, ProjectId, ProjectionImpact, StoreEpoch,
    };
    use tempfile::{TempDir, tempdir};

    use crate::infrastructure::sqlite::{StoreErrorCode, with_immediate_transaction};
    use crate::infrastructure::store::SqliteStoreKernel;
    use crate::library::LibraryModule;
    use crate::workspace::ProjectWorkspaceModule;

    const NOW: &str = "2026-07-19T04:00:00.000Z";

    #[test]
    fn derives_project_resource_names_with_suffixes_and_bounds() {
        assert_eq!(
            super::derive_project_resource_name("Research", super::PROJECT_DATABASE_NAME_SUFFIX),
            "Research DB"
        );
        assert_eq!(
            super::derive_project_resource_name("研究 🚀", super::PROJECT_CANVAS_NAME_SUFFIX),
            "研究 🚀 Canvas"
        );

        let database_boundary = "x".repeat(
            super::MAX_PROJECT_RESOURCE_NAME_CHARS
                - super::PROJECT_DATABASE_NAME_SUFFIX.chars().count(),
        );
        assert_eq!(
            super::derive_project_resource_name(
                &database_boundary,
                super::PROJECT_DATABASE_NAME_SUFFIX,
            ),
            format!("{database_boundary} DB")
        );

        let canvas_boundary = "x".repeat(
            super::MAX_PROJECT_RESOURCE_NAME_CHARS
                - super::PROJECT_CANVAS_NAME_SUFFIX.chars().count(),
        );
        assert_eq!(
            super::derive_project_resource_name(
                &canvas_boundary,
                super::PROJECT_CANVAS_NAME_SUFFIX
            ),
            format!("{canvas_boundary} Canvas")
        );

        let oversized_database = super::derive_project_resource_name(
            &"x".repeat(super::MAX_PROJECT_RESOURCE_NAME_CHARS),
            super::PROJECT_DATABASE_NAME_SUFFIX,
        );
        assert_eq!(
            oversized_database.chars().count(),
            super::MAX_PROJECT_RESOURCE_NAME_CHARS
        );
        assert!(oversized_database.ends_with(super::PROJECT_DATABASE_NAME_SUFFIX));
        assert!(oversized_database.contains('…'));

        let oversized_canvas = super::derive_project_resource_name(
            &"🚀".repeat(super::MAX_PROJECT_RESOURCE_NAME_CHARS),
            super::PROJECT_CANVAS_NAME_SUFFIX,
        );
        assert_eq!(
            oversized_canvas.chars().count(),
            super::MAX_PROJECT_RESOURCE_NAME_CHARS
        );
        assert!(oversized_canvas.ends_with(super::PROJECT_CANVAS_NAME_SUFFIX));
        assert!(oversized_canvas.contains('…'));

        let truncated_at_space = format!("{} suffix", "x".repeat(251));
        assert_eq!(
            super::derive_project_resource_name(
                &truncated_at_space,
                super::PROJECT_DATABASE_NAME_SUFFIX,
            ),
            format!("{}… DB", "x".repeat(251))
        );
    }

    fn read_project_resource_names(
        connection: &rusqlite::Connection,
        project_id: &str,
    ) -> rusqlite::Result<(String, String, String)> {
        connection.query_row(
            "SELECT \
                (SELECT name FROM database_containers \
                 WHERE block_id = project.database_block_id), \
                (SELECT name FROM data_sources \
                 WHERE home_database_block_id = project.database_block_id \
                 ORDER BY rank_key LIMIT 1), \
                (SELECT json_extract(value_json, '$') FROM block_properties \
                 WHERE block_id = 'canvas:primary:' || project.id \
                   AND property_key = 'document.display_name') \
             FROM projects project \
             WHERE project.id = ?1",
            [project_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
    }

    fn context() -> BoundModuleContext {
        BoundModuleContext {
            profile_id: ProfileId("profile-1".to_owned()),
            library_id: LibraryId("library-1".to_owned()),
            project_id: Some(ProjectId("project:default".to_owned())),
            connection_id: "connection:workspace-mutation".to_owned(),
            adapter: AdapterKind::Test,
        }
    }

    fn bootstrap_context() -> BoundModuleContext {
        BoundModuleContext {
            project_id: None,
            ..context()
        }
    }

    fn empty_module() -> (TempDir, SqliteStoreKernel, ProjectWorkspaceModule) {
        let directory = tempdir().expect("Profile");
        let home = directory.path().canonicalize().expect("absolute Profile");
        fs::create_dir(home.join("assets")).expect("assets root");
        let kernel = SqliteStoreKernel::open_test(&home).expect("fresh store");
        kernel
            .writer()
            .call(|connection| {
                with_immediate_transaction(connection, |transaction| {
                    transaction.execute(
                        "INSERT INTO profiles(id, created_at, updated_at) \
                         VALUES ('profile-1', ?1, ?1)",
                        [NOW],
                    )?;
                    transaction.execute(
                        "INSERT INTO libraries(id, profile_id, created_at, updated_at) \
                         VALUES ('library-1', 'profile-1', ?1, ?1)",
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
            .expect("seed Workspace identity");
        let module = ProjectWorkspaceModule::new("profile-1", "library-1", &kernel)
            .expect("Workspace module");
        (directory, kernel, module)
    }

    fn seeded_module() -> (TempDir, SqliteStoreKernel, ProjectWorkspaceModule) {
        let (directory, kernel, module) = empty_module();
        module.seed_rootless_default_project_for_test();
        (directory, kernel, module)
    }

    fn create_request(
        operation_id: &str,
        project_id: &str,
    ) -> ModuleApplyRequest<ProjectWorkspaceIntent> {
        request(
            operation_id,
            ProjectWorkspaceIntent::CreateProject {
                project_id: project_id.to_owned(),
                name: "  Native project  ".to_owned(),
                description: "Workspace aggregate".to_owned(),
                appearance: Some(ProjectAppearance {
                    color: ProjectMarkerColor::Black,
                    marker: ProjectMarker::Emoji {
                        emoji: "🚀".to_owned(),
                    },
                }),
                source_roots: vec![
                    "/workspace/native".to_owned(),
                    "/workspace/native".to_owned(),
                    "/workspace/secondary".to_owned(),
                ],
                page_key_prefix: None,
            },
        )
    }

    fn request(
        operation_id: &str,
        intent: ProjectWorkspaceIntent,
    ) -> ModuleApplyRequest<ProjectWorkspaceIntent> {
        ModuleApplyRequest {
            contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
            operation_id: operation_id.to_owned(),
            store_epoch: StoreEpoch("epoch-1".to_owned()),
            intent,
        }
    }

    fn session_request(
        operation_id: &str,
        session_id: &str,
        intent: ProjectSessionIntent,
    ) -> ModuleApplyRequest<ProjectWorkspaceIntent> {
        request(
            operation_id,
            ProjectWorkspaceIntent::MutateSession {
                session_id: session_id.to_owned(),
                intent,
            },
        )
    }

    fn starter_page(seed: &str) -> ProjectWorkspaceStarterPage {
        ProjectWorkspaceStarterPage {
            page_id: format!("page:getting-started:{seed}"),
            document_id: format!("document:getting-started:{seed}"),
            title_markdown: "Welcome to Nodex".to_owned(),
            nfm: "Welcome to **Nodex**.".to_owned(),
        }
    }

    #[test]
    fn derives_bootstrap_and_atomically_creates_exactly_one_source_backed_initial_project() {
        let (_directory, kernel, module) = empty_module();
        let read_bootstrap = |module: &ProjectWorkspaceModule| {
            let snapshot = module
                .read(
                    &context(),
                    ModuleReadRequest {
                        contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                        read: ProjectWorkspaceRead::ProjectBootstrap,
                    },
                )
                .expect("Project bootstrap");
            let ProjectWorkspaceReadValue::ProjectBootstrap { bootstrap } = snapshot.value else {
                panic!("Project bootstrap value");
            };
            bootstrap
        };

        let empty = read_bootstrap(&module);
        assert_eq!(empty.status, ProjectWorkspaceBootstrapStatus::Empty);

        let ordinary_error = module
            .apply(
                &bootstrap_context(),
                request(
                    "initial-ordinary-create",
                    ProjectWorkspaceIntent::CreateProject {
                        project_id: "project:ordinary".to_owned(),
                        name: "Ordinary".to_owned(),
                        description: String::new(),
                        appearance: None,
                        source_roots: vec!["/workspace/ordinary".to_owned()],
                        page_key_prefix: None,
                    },
                ),
            )
            .expect_err("ordinary creation cannot claim the empty catalog");
        assert_eq!(ordinary_error.code, CoreErrorCode::Conflict);

        let projectless_error = module
            .apply(
                &bootstrap_context(),
                request(
                    "initial-projectless-session",
                    ProjectWorkspaceIntent::CreateSession {
                        session_id: "session:projectless".to_owned(),
                        project_id: None,
                        title: "Projectless".to_owned(),
                        initial_page_ids: Vec::new(),
                    },
                ),
            )
            .expect_err("Projectless mutations wait for initial Project bootstrap");
        assert_eq!(projectless_error.code, CoreErrorCode::Conflict);

        let rootless_error = module
            .apply(
                &bootstrap_context(),
                request(
                    "initial-rootless-create",
                    ProjectWorkspaceIntent::CreateInitialProject {
                        project_id: "project:rootless".to_owned(),
                        name: "Rootless".to_owned(),
                        description: String::new(),
                        appearance: None,
                        source_roots: Vec::new(),
                        page_key_prefix: None,
                        starter_page: starter_page("rootless"),
                    },
                ),
            )
            .expect_err("initial Project requires a source");
        assert_eq!(rootless_error.code, CoreErrorCode::InvalidInput);

        let first = ProjectWorkspaceModule::new("profile-1", "library-1", &kernel)
            .expect("first competing Workspace module");
        let second = ProjectWorkspaceModule::new("profile-1", "library-1", &kernel)
            .expect("second competing Workspace module");
        let first_thread = std::thread::spawn(move || {
            first.apply(
                &bootstrap_context(),
                request(
                    "initial-concurrent-a",
                    ProjectWorkspaceIntent::CreateInitialProject {
                        project_id: "project:initial-a".to_owned(),
                        name: "My Project".to_owned(),
                        description: String::new(),
                        appearance: None,
                        source_roots: vec!["/workspace/default-a".to_owned()],
                        page_key_prefix: None,
                        starter_page: starter_page("concurrent-a"),
                    },
                ),
            )
        });
        let second_thread = std::thread::spawn(move || {
            second.apply(
                &bootstrap_context(),
                request(
                    "initial-concurrent-b",
                    ProjectWorkspaceIntent::CreateInitialProject {
                        project_id: "project:initial-b".to_owned(),
                        name: "My Project".to_owned(),
                        description: String::new(),
                        appearance: None,
                        source_roots: vec!["/workspace/default-b".to_owned()],
                        page_key_prefix: None,
                        starter_page: starter_page("concurrent-b"),
                    },
                ),
            )
        });
        let outcomes = [
            first_thread.join().expect("first competing writer"),
            second_thread.join().expect("second competing writer"),
        ];
        assert_eq!(
            outcomes.iter().filter(|outcome| outcome.is_ok()).count(),
            1,
            "competing initial Project outcomes: {outcomes:?}",
        );
        let loser = outcomes
            .iter()
            .find_map(|outcome| outcome.as_ref().err())
            .expect("one initial Project loses");
        assert_eq!(loser.code, CoreErrorCode::Conflict);

        let ready = read_bootstrap(&module);
        assert_eq!(ready.status, ProjectWorkspaceBootstrapStatus::Ready);
        let (project_count, page_count, ready_document_count, membership_count, starter_page_key) =
            kernel
                .writer()
                .call(|connection| {
                    Ok((
                        connection.query_row(
                            "SELECT count(*) FROM projects WHERE library_id = 'library-1'",
                            [],
                            |row| row.get::<_, i64>(0),
                        )?,
                        connection.query_row(
                            "SELECT count(*) FROM pages WHERE library_id = 'library-1'",
                            [],
                            |row| row.get::<_, i64>(0),
                        )?,
                        connection.query_row(
                            "SELECT count(*) FROM pages page \
                         JOIN documents document ON document.id = page.document_id \
                         WHERE page.library_id = 'library-1' AND document.readiness = 'ready'",
                            [],
                            |row| row.get::<_, i64>(0),
                        )?,
                        connection.query_row(
                            "SELECT count(*) FROM data_source_page_memberships \
                         WHERE removed_at IS NULL",
                            [],
                            |row| row.get::<_, i64>(0),
                        )?,
                        connection.query_row(
                            "SELECT prefix.normalized_prefix || '-' || assignment.number \
                         FROM page_key_assignments assignment \
                         JOIN page_key_prefixes prefix \
                           ON prefix.database_block_id = assignment.database_block_id \
                          AND prefix.retired_at IS NULL",
                            [],
                            |row| row.get::<_, String>(0),
                        )?,
                    ))
                })
                .expect("initial Project aggregate counts");
        assert_eq!(project_count, 1);
        assert_eq!(page_count, 1);
        assert_eq!(ready_document_count, 1);
        assert_eq!(membership_count, 1);
        assert_eq!(starter_page_key, "MP-1");
        let winner = outcomes
            .into_iter()
            .find_map(Result::ok)
            .expect("one initial Project wins");
        let impact = winner
            .event
            .expect("initial Project event")
            .projection_impact;
        let ProjectionImpact::Resources {
            page_ids,
            database_ids,
            data_source_ids,
            view_ids,
            document_heads,
        } = impact
        else {
            panic!("initial Project has bounded projection impact")
        };
        assert_eq!(page_ids.len(), 1);
        assert_eq!(database_ids.len(), 1);
        assert_eq!(data_source_ids.len(), 1);
        assert_eq!(view_ids.len(), 1);
        assert_eq!(document_heads.len(), 1);
        assert_eq!(document_heads[0].page_id, page_ids[0]);
    }

    #[test]
    fn bootstrap_includes_rootless_and_archived_projects_without_special_repair_state() {
        let (_directory, _kernel, module) = seeded_module();
        let read_bootstrap = || {
            let snapshot = module
                .read(
                    &context(),
                    ModuleReadRequest {
                        contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                        read: ProjectWorkspaceRead::ProjectBootstrap,
                    },
                )
                .expect("Project bootstrap");
            let ProjectWorkspaceReadValue::ProjectBootstrap { bootstrap } = snapshot.value else {
                panic!("Project bootstrap value");
            };
            bootstrap
        };

        let rootless = read_bootstrap();
        assert_eq!(rootless.status, ProjectWorkspaceBootstrapStatus::Ready);

        module
            .apply(
                &context(),
                request(
                    "archive-legacy-default",
                    ProjectWorkspaceIntent::SetProjectLifecycle {
                        project_id: "project:default".to_owned(),
                        lifecycle: ProjectLifecycle::Archived,
                    },
                ),
            )
            .expect("archive legacy default");
        let archived = read_bootstrap();
        assert_eq!(archived.status, ProjectWorkspaceBootstrapStatus::Ready);
    }

    #[test]
    fn invalid_starter_page_rolls_back_the_entire_initial_project_aggregate() {
        let (_directory, kernel, module) = empty_module();
        let mut invalid_starter_page = starter_page("invalid");
        invalid_starter_page.nfm = "<page uuid=\"nested-page\" />".to_owned();

        let error = module
            .apply(
                &bootstrap_context(),
                request(
                    "initial-invalid-starter-page",
                    ProjectWorkspaceIntent::CreateInitialProject {
                        project_id: "project:initial-invalid".to_owned(),
                        name: "My Project".to_owned(),
                        description: String::new(),
                        appearance: None,
                        source_roots: vec!["/workspace/default-invalid".to_owned()],
                        page_key_prefix: None,
                        starter_page: invalid_starter_page,
                    },
                ),
            )
            .expect_err("owning nested Page must reject starter genesis");
        assert_eq!(error.code, CoreErrorCode::InvalidInput);

        let (project_count, database_count, page_count) = kernel
            .writer()
            .call(|connection| {
                Ok((
                    connection.query_row("SELECT count(*) FROM projects", [], |row| {
                        row.get::<_, i64>(0)
                    })?,
                    connection.query_row(
                        "SELECT count(*) FROM database_containers",
                        [],
                        |row| row.get::<_, i64>(0),
                    )?,
                    connection
                        .query_row("SELECT count(*) FROM pages", [], |row| row.get::<_, i64>(0))?,
                ))
            })
            .expect("rolled-back aggregate counts");
        assert_eq!((project_count, database_count, page_count), (0, 0, 0));
        let bootstrap = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                    read: ProjectWorkspaceRead::ProjectBootstrap,
                },
            )
            .expect("empty bootstrap after rollback");
        let ProjectWorkspaceReadValue::ProjectBootstrap { bootstrap } = bootstrap.value else {
            panic!("Project bootstrap value")
        };
        assert_eq!(bootstrap.status, ProjectWorkspaceBootstrapStatus::Empty);
    }

    #[test]
    fn initial_project_creation_replays_its_receipt_before_the_empty_catalog_precondition() {
        let (_directory, kernel, module) = empty_module();
        let initial = request(
            "initial-exact-replay",
            ProjectWorkspaceIntent::CreateInitialProject {
                project_id: "project:initial".to_owned(),
                name: "My Project".to_owned(),
                description: String::new(),
                appearance: None,
                source_roots: vec!["/workspace/default".to_owned()],
                page_key_prefix: None,
                starter_page: starter_page("replay"),
            },
        );
        let committed = module
            .apply(&bootstrap_context(), initial.clone())
            .expect("create initial Project");
        let mut rebound_context = bootstrap_context();
        rebound_context.connection_id = "connection:rebound-generation".to_owned();
        let replay = module
            .apply(&rebound_context, initial)
            .expect("replay initial Project");

        assert_eq!(
            replay.committed.event_sequence,
            committed.committed.event_sequence,
        );
        assert!(replay.committed.receipt.mutation.duplicate);
        assert!(replay.event.is_none());
        let count = kernel
            .writer()
            .call(|connection| {
                Ok(connection.query_row(
                    "SELECT count(*) FROM projects WHERE library_id = 'library-1'",
                    [],
                    |row| row.get::<_, i64>(0),
                )?)
            })
            .expect("Project count");
        assert_eq!(count, 1);
    }

    #[test]
    fn fresh_project_primary_canvas_round_trips_through_library_navigation_and_delete_guard() {
        let (_directory, kernel, workspace) = seeded_module();
        workspace
            .apply(
                &context(),
                create_request("workspace-create-primary-canvas", "project-native"),
            )
            .expect("create Project with primary Canvas");

        let library = LibraryModule::new("profile-1", "library-1", &kernel);
        let mut native_context = context();
        native_context.project_id = Some(ProjectId("project-native".to_owned()));
        let canvas_id = "canvas:primary:project-native";

        let target = library
            .read(
                &native_context,
                ModuleReadRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    read: LibraryRead::CanvasTarget {
                        canvas_id: canvas_id.to_owned(),
                    },
                },
            )
            .expect("read primary Canvas target");
        assert!(matches!(
            target.value,
            LibraryReadValue::CanvasTarget { value }
                if matches!(
                    value.as_ref(),
                    nodex_core_contracts::library::LibraryCanvasTarget::Available { summary }
                        if summary.canvas_id == canvas_id
                            && summary.title == "Native project Canvas"
                            && summary.is_primary
                )
        ));

        let path = library
            .read(
                &native_context,
                ModuleReadRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    read: LibraryRead::Path {
                        target: LibraryRouteTarget::Canvas {
                            canvas_id: canvas_id.to_owned(),
                        },
                    },
                },
            )
            .expect("read primary Canvas navigation path");
        let LibraryReadValue::Path { nodes, .. } = path.value else {
            panic!("primary Canvas navigation path");
        };
        assert!(matches!(
            nodes.last(),
            Some(
            nodex_core_contracts::library::LibraryNavigationNode::Canvas {
                canvas_id: candidate,
                title,
                is_primary: true,
                ..
            }) if candidate == canvas_id
                && title == "Native project Canvas"
        ));

        let deletion = library
            .apply(
                &native_context,
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "library-delete-primary-canvas".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::DeleteCanvas {
                        canvas_id: canvas_id.to_owned(),
                        expected_location_revision: 1,
                        expected_metadata_revision: 1,
                        containing_document_head: None,
                    },
                },
            )
            .expect_err("primary Canvas deletion must remain protected");
        assert_eq!(deletion.code, CoreErrorCode::ProtectedOwnerDeletion);
        assert!(
            deletion
                .message
                .contains("primary Canvas cannot be deleted"),
            "{}",
            deletion.message,
        );
    }

    #[test]
    fn available_project_capacity_is_enforced_at_growth_ingress() {
        let (_directory, kernel, _module) = seeded_module();
        kernel
            .writer()
            .call(|connection| {
                let existing = connection.query_row(
                    "SELECT count(*) FROM projects \
                     WHERE library_id = 'library-1' AND lifecycle <> 'archived'",
                    [],
                    |row| row.get::<_, i64>(0),
                )?;
                let existing = usize::try_from(existing).expect("Project count fits usize");
                for index in existing..super::MAX_UNARCHIVED_PROJECTS {
                    connection.execute(
                        "INSERT INTO projects(\
                           id, name, description, created, updated, library_id, lifecycle\
                         ) VALUES (?1, ?1, '', ?2, ?2, 'library-1', 'active')",
                        rusqlite::params![format!("project:capacity:{index}"), NOW],
                    )?;
                }

                let error = super::require_unarchived_project_capacity(connection, "library-1")
                    .expect_err("full Project collection");
                assert_eq!(error.code, StoreErrorCode::ResourceExhausted);

                connection.execute(
                    "UPDATE projects SET lifecycle = 'archived' \
                     WHERE id = ?1",
                    [format!("project:capacity:{existing}")],
                )?;
                super::require_unarchived_project_capacity(connection, "library-1")
                    .expect("archived Projects do not consume available capacity");
                Ok(())
            })
            .expect("check Project capacity");
    }

    #[test]
    fn validates_and_persists_the_closed_project_appearance_catalog() {
        let (_directory, kernel, module) = seeded_module();
        let mut binding_revision = 1;
        let colors = [
            ProjectMarkerColor::Black,
            ProjectMarkerColor::Red,
            ProjectMarkerColor::Orange,
            ProjectMarkerColor::Yellow,
            ProjectMarkerColor::Green,
            ProjectMarkerColor::Blue,
            ProjectMarkerColor::Purple,
            ProjectMarkerColor::Pink,
        ];
        for (index, color) in colors.into_iter().enumerate() {
            let outcome = module
                .apply(
                    &context(),
                    request(
                        &format!("appearance-color-{index}"),
                        ProjectWorkspaceIntent::UpdateProject {
                            project_id: "project:default".to_owned(),
                            expected_binding_revision: binding_revision,
                            name: None,
                            description: None,
                            appearance: Some(ProjectAppearance {
                                color,
                                marker: ProjectMarker::Icon {
                                    icon: ProjectMarkerIcon::Heart,
                                },
                            }),
                            source_roots: None,
                        },
                    ),
                )
                .expect("legal Project color");
            binding_revision += 1;
            let Some(event) = outcome.event else {
                panic!("appearance update event");
            };
            let CoreModuleEventPayload::ProjectWorkspace(event) = event.payload else {
                panic!("Project Workspace event");
            };
            assert_eq!(
                event.project_catalog_change,
                Some(ProjectCatalogChangeKind::MetadataUpdated)
            );
        }
        for (index, icon) in [
            ProjectMarkerIcon::Folder,
            ProjectMarkerIcon::CurrencyDollar,
            ProjectMarkerIcon::DeskGlobe,
            ProjectMarkerIcon::Plant,
        ]
        .into_iter()
        .enumerate()
        {
            module
                .apply(
                    &context(),
                    request(
                        &format!("appearance-icon-{index}"),
                        ProjectWorkspaceIntent::UpdateProject {
                            project_id: "project:default".to_owned(),
                            expected_binding_revision: binding_revision,
                            name: None,
                            description: None,
                            appearance: Some(ProjectAppearance {
                                color: ProjectMarkerColor::Blue,
                                marker: ProjectMarker::Icon { icon },
                            }),
                            source_roots: None,
                        },
                    ),
                )
                .expect("legal Project marker icon");
            binding_revision += 1;
        }
        module
            .apply(
                &context(),
                request(
                    "appearance-emoji",
                    ProjectWorkspaceIntent::UpdateProject {
                        project_id: "project:default".to_owned(),
                        expected_binding_revision: binding_revision,
                        name: None,
                        description: None,
                        appearance: Some(ProjectAppearance {
                            color: ProjectMarkerColor::Green,
                            marker: ProjectMarker::Emoji {
                                emoji: "  Ship 👩🏽‍💻 now  ".to_owned(),
                            },
                        }),
                        source_roots: None,
                    },
                ),
            )
            .expect("normalized Project emoji");
        binding_revision += 1;
        for (index, emoji) in ["plain text".to_owned(), "🚀\0".to_owned(), "🚀".repeat(100)]
            .into_iter()
            .enumerate()
        {
            let error = module
                .apply(
                    &context(),
                    request(
                        &format!("appearance-invalid-emoji-{index}"),
                        ProjectWorkspaceIntent::UpdateProject {
                            project_id: "project:default".to_owned(),
                            expected_binding_revision: binding_revision,
                            name: None,
                            description: None,
                            appearance: Some(ProjectAppearance {
                                color: ProjectMarkerColor::Black,
                                marker: ProjectMarker::Emoji { emoji },
                            }),
                            source_roots: None,
                        },
                    ),
                )
                .expect_err("invalid Project emoji");
            assert_eq!(error.code, CoreErrorCode::InvalidInput);
        }

        kernel
            .writer()
            .call(move |connection| {
                let stored = connection.query_row(
                    "SELECT appearance_color, appearance_marker_kind, appearance_marker_value, \
                       binding_revision \
                     FROM projects WHERE id = 'project:default'",
                    [],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, i64>(3)?,
                        ))
                    },
                )?;
                assert_eq!(
                    stored,
                    (
                        "green".to_owned(),
                        "emoji".to_owned(),
                        "👩🏽‍💻".to_owned(),
                        binding_revision,
                    )
                );
                assert!(
                    connection
                        .execute(
                            "UPDATE projects SET appearance_color = 'chartreuse' \
                             WHERE id = 'project:default'",
                            [],
                        )
                        .is_err()
                );
                assert!(
                    connection
                        .execute(
                            "UPDATE projects SET appearance_marker_kind = 'icon', \
                               appearance_marker_value = 'unknown' \
                             WHERE id = 'project:default'",
                            [],
                        )
                        .is_err()
                );
                Ok(())
            })
            .expect("verify Project appearance storage");
    }

    #[test]
    fn bootstraps_and_creates_complete_project_aggregates_with_exact_replay() {
        let (_directory, kernel, module) = seeded_module();
        let bootstrap = kernel
            .writer()
            .call(|connection| {
                connection
                    .query_row(
                        "SELECT project.database_block_id, binding.database_block_id, \
                            (SELECT count(*) FROM project_sessions \
                             WHERE project_id = 'project:default'), \
                            (SELECT count(*) FROM canvas_scenes scene \
                             JOIN block_documents owner ON owner.document_id = scene.document_id \
                             WHERE owner.block_id = 'canvas:primary:project:default') \
                     FROM projects project JOIN project_database_bindings binding \
                       ON binding.project_id = project.id \
                     WHERE project.id = 'project:default'",
                        [],
                        |row| {
                            Ok((
                                row.get::<_, String>(0)?,
                                row.get::<_, String>(1)?,
                                row.get::<_, i64>(2)?,
                                row.get::<_, i64>(3)?,
                            ))
                        },
                    )
                    .map_err(Into::into)
            })
            .expect("read bootstrap aggregate");
        assert_eq!(bootstrap.0, bootstrap.1);
        assert_eq!(bootstrap.2, 0);
        assert_eq!(bootstrap.3, 1);
        let bootstrap_resource_names = kernel
            .writer()
            .call(|connection| {
                read_project_resource_names(connection, "project:default").map_err(Into::into)
            })
            .expect("read bootstrapped resource names");
        assert_eq!(
            bootstrap_resource_names,
            (
                "Nodex DB".to_owned(),
                "Nodex DB".to_owned(),
                "Nodex Canvas".to_owned(),
            )
        );

        let request = create_request("workspace-create-1", "project-native");
        let outcome = module
            .apply(&context(), request.clone())
            .expect("create Project aggregate");
        assert_eq!(
            outcome.committed.value.affected_project_ids,
            vec!["project-native"]
        );
        assert!(outcome.committed.value.affected_session_ids.is_empty());
        assert!(outcome.committed.value.affected_thread_ids.is_empty());
        assert!(!outcome.committed.receipt.mutation.duplicate);
        let Some(event) = outcome.event.as_ref() else {
            panic!("Project creation must publish a Workspace event");
        };
        let CoreModuleEventPayload::ProjectWorkspace(event) = &event.payload else {
            panic!("Project creation must publish a Project Workspace event");
        };
        assert_eq!(
            event.project_catalog_change,
            Some(ProjectCatalogChangeKind::Created)
        );
        let ProjectionImpact::Resources {
            database_ids,
            data_source_ids,
            view_ids,
            ..
        } = &outcome
            .event
            .as_ref()
            .expect("Workspace event")
            .projection_impact
        else {
            panic!("Project creation must invalidate its Database projection");
        };
        assert_eq!(database_ids.len(), 1);
        assert_eq!(data_source_ids.len(), 1);
        assert_eq!(view_ids.len(), 1);

        let replay = module.apply(&context(), request).expect("exact replay");
        assert!(replay.committed.receipt.mutation.duplicate);
        assert_eq!(
            replay.committed.event_sequence,
            outcome.committed.event_sequence
        );
        assert!(replay.event.is_none());

        let stored = kernel
            .writer()
            .call(|connection| {
                connection
                    .query_row(
                        "SELECT project.name, project.description, project.appearance_color, \
                            project.appearance_marker_kind, project.appearance_marker_value, \
                            project.database_block_id, binding.database_block_id, \
                            (SELECT count(*) FROM project_sources \
                             WHERE project_id = project.id), \
                            (SELECT count(*) FROM data_source_properties property \
                             JOIN data_sources source ON source.id = property.data_source_id \
                             WHERE source.home_database_block_id = project.database_block_id), \
                            (SELECT count(*) FROM project_sessions session \
                             WHERE session.project_id = project.id), \
                            (SELECT count(*) FROM canvas_scenes scene \
                             JOIN block_documents owner ON owner.document_id = scene.document_id \
                             WHERE owner.block_id = 'canvas:primary:' || project.id), \
                            (SELECT count(*) FROM change_log \
                             WHERE kind = 'project_workspace.changed' \
                               AND operation_id = 'workspace-create-1'), \
                            (SELECT count(*) FROM core_module_receipts \
                             WHERE module_name = 'project_workspace' \
                               AND operation_id = 'workspace-create-1') \
                     FROM projects project JOIN project_database_bindings binding \
                       ON binding.project_id = project.id \
                     WHERE project.id = 'project-native'",
                        [],
                        |row| {
                            Ok((
                                row.get::<_, String>(0)?,
                                row.get::<_, String>(1)?,
                                row.get::<_, String>(2)?,
                                row.get::<_, String>(3)?,
                                row.get::<_, String>(4)?,
                                row.get::<_, String>(5)?,
                                row.get::<_, String>(6)?,
                                row.get::<_, i64>(7)?,
                                row.get::<_, i64>(8)?,
                                row.get::<_, i64>(9)?,
                                row.get::<_, i64>(10)?,
                                row.get::<_, i64>(11)?,
                                row.get::<_, i64>(12)?,
                            ))
                        },
                    )
                    .map_err(Into::into)
            })
            .expect("read created aggregate");
        assert_eq!(stored.0, "Native project");
        assert_eq!(stored.1, "Workspace aggregate");
        assert_eq!(
            (&stored.2[..], &stored.3[..], &stored.4[..]),
            ("black", "emoji", "🚀")
        );
        assert_eq!(stored.5, stored.6);
        assert_eq!(stored.7, 2);
        assert_eq!(stored.8, 9);
        assert_eq!(stored.9, 0);
        assert_eq!(stored.10, 1);
        assert_eq!(stored.11, 1);
        assert_eq!(stored.12, 1);

        let created_resource_names = kernel
            .writer()
            .call(|connection| {
                read_project_resource_names(connection, "project-native").map_err(Into::into)
            })
            .expect("read created resource names");
        assert_eq!(
            created_resource_names,
            (
                "Native project DB".to_owned(),
                "Native project DB".to_owned(),
                "Native project Canvas".to_owned(),
            )
        );

        let divergent = module
            .apply(
                &context(),
                create_request("workspace-create-1", "project-divergent"),
            )
            .expect_err("reject divergent replay");
        assert_eq!(divergent.code, CoreErrorCode::IdempotencyKeyReused);
    }

    #[test]
    fn updates_lifecycle_order_and_pinning_with_revision_guards_and_exact_replay() {
        let (_directory, kernel, module) = seeded_module();
        module
            .apply(
                &context(),
                create_request("workspace-create-native", "project-native"),
            )
            .expect("create native Project");
        let native_session_id = "session:native".to_owned();
        module
            .apply(
                &context(),
                request(
                    "workspace-create-native-session",
                    ProjectWorkspaceIntent::CreateSession {
                        session_id: native_session_id.clone(),
                        project_id: Some("project-native".to_owned()),
                        title: "Native Session".to_owned(),
                        initial_page_ids: Vec::new(),
                    },
                ),
            )
            .expect("create native Session");
        module
            .apply(
                &context(),
                create_request("workspace-create-secondary", "project-secondary"),
            )
            .expect("create secondary Project");

        let update = request(
            "workspace-update-native",
            ProjectWorkspaceIntent::UpdateProject {
                project_id: "project-native".to_owned(),
                expected_binding_revision: 1,
                name: Some("  Renamed Project  ".to_owned()),
                description: Some("Updated metadata".to_owned()),
                appearance: Some(ProjectAppearance {
                    color: ProjectMarkerColor::Purple,
                    marker: ProjectMarker::Emoji {
                        emoji: "  Build 🧭 workspace  ".to_owned(),
                    },
                }),
                source_roots: Some(vec![
                    "/workspace/updated".to_owned(),
                    "/workspace/updated".to_owned(),
                ]),
            },
        );
        let updated = module
            .apply(&context(), update.clone())
            .expect("update Project");
        assert_eq!(
            updated.committed.value.affected_project_ids,
            ["project-native"]
        );
        let replay = module
            .apply(&context(), update)
            .expect("replay Project update");
        assert!(replay.committed.receipt.mutation.duplicate);
        assert_eq!(
            replay.committed.event_sequence,
            updated.committed.event_sequence
        );
        let resource_names_after_rename = kernel
            .writer()
            .call(|connection| {
                read_project_resource_names(connection, "project-native").map_err(Into::into)
            })
            .expect("read resource names after Project rename");
        assert_eq!(
            resource_names_after_rename,
            (
                "Native project DB".to_owned(),
                "Native project DB".to_owned(),
                "Native project Canvas".to_owned(),
            )
        );

        let stale = module
            .apply(
                &context(),
                request(
                    "workspace-update-stale",
                    ProjectWorkspaceIntent::UpdateProject {
                        project_id: "project-native".to_owned(),
                        expected_binding_revision: 1,
                        name: Some("Stale".to_owned()),
                        description: None,
                        appearance: None,
                        source_roots: None,
                    },
                ),
            )
            .expect_err("reject stale Project binding revision");
        assert_eq!(stale.code, CoreErrorCode::RevisionConflict);

        module
            .apply(
                &context(),
                request(
                    "workspace-update-native-sources",
                    ProjectWorkspaceIntent::UpdateProject {
                        project_id: "project-native".to_owned(),
                        expected_binding_revision: 2,
                        name: None,
                        description: None,
                        appearance: None,
                        source_roots: Some(vec!["/workspace/source-only".to_owned()]),
                    },
                ),
            )
            .expect("update only Project sources");
        let (_, binding_revision) = kernel
            .writer()
            .call(|connection| super::require_project(connection, "library-1", "project-native"))
            .expect("read advanced Project binding revision");
        assert_eq!(binding_revision, 3);

        module
            .apply(
                &context(),
                request(
                    "workspace-pin-native",
                    ProjectWorkspaceIntent::SetProjectPinned {
                        project_id: "project-native".to_owned(),
                        pinned: true,
                    },
                ),
            )
            .expect("pin Project");
        module
            .apply(
                &context(),
                request(
                    "workspace-pin-secondary",
                    ProjectWorkspaceIntent::SetProjectPinned {
                        project_id: "project-secondary".to_owned(),
                        pinned: true,
                    },
                ),
            )
            .expect("pin secondary Project");
        module
            .apply(
                &context(),
                request(
                    "workspace-reorder-pinned",
                    ProjectWorkspaceIntent::ReorderPinnedProjects {
                        project_ids: vec![
                            "project-secondary".to_owned(),
                            "project-native".to_owned(),
                        ],
                    },
                ),
            )
            .expect("reorder pinned Projects");
        let pinned_projects = kernel
            .writer()
            .call(|connection| {
                Ok(connection
                    .prepare("SELECT project_id FROM pinned_project_order ORDER BY \"order\"")?
                    .query_map([], |row| row.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?)
            })
            .expect("read pinned Project order");
        assert_eq!(pinned_projects, ["project-secondary", "project-native"]);
        module
            .apply(
                &context(),
                request(
                    "workspace-reorder",
                    ProjectWorkspaceIntent::ReorderProjects {
                        project_ids: vec![
                            "project-native".to_owned(),
                            "project:default".to_owned(),
                            "project-secondary".to_owned(),
                        ],
                    },
                ),
            )
            .expect("reorder Projects");
        kernel
            .writer()
            .call(|connection| {
                connection.execute(
                    "INSERT INTO codex_threads(\
                       thread_id, project_id, thread_name, thread_preview, \
                       status_type, status_active_flags_json, archived, created_at, updated_at, \
                       recency_at, linked_at\
                     ) VALUES (\
                       'thread-archived-owner', 'project-native', '', 'Preview', \
                       'idle', '[]', 0, 1, 2, 2, ?1\
                     )",
                    [NOW],
                )?;
                Ok(())
            })
            .expect("seed archived-owner Thread");
        kernel
            .writer()
            .call(|connection| {
                connection.execute(
                    "DELETE FROM local_commit_visibility_context WHERE mode = 'maintenance'",
                    [],
                )?;
                Ok(())
            })
            .expect("production visibility guard");
        module
            .apply(
                &context(),
                request(
                    "workspace-inactivate-native",
                    ProjectWorkspaceIntent::SetProjectLifecycle {
                        project_id: "project-native".to_owned(),
                        lifecycle: ProjectLifecycle::Inactive,
                    },
                ),
            )
            .expect("inactivate Project");
        module
            .apply(
                &context(),
                request(
                    "workspace-archive-native",
                    ProjectWorkspaceIntent::SetProjectLifecycle {
                        project_id: "project-native".to_owned(),
                        lifecycle: ProjectLifecycle::Archived,
                    },
                ),
            )
            .expect("archive Project");

        let archived_update = module
            .apply(
                &context(),
                request(
                    "workspace-update-archived",
                    ProjectWorkspaceIntent::UpdateProject {
                        project_id: "project-native".to_owned(),
                        expected_binding_revision: 5,
                        name: Some("Must not change".to_owned()),
                        description: None,
                        appearance: None,
                        source_roots: None,
                    },
                ),
            )
            .expect_err("reject archived Project metadata mutation");
        assert_eq!(archived_update.code, CoreErrorCode::Conflict);

        let archived_session_create = module
            .apply(
                &context(),
                request(
                    "workspace-create-session-archived",
                    ProjectWorkspaceIntent::CreateSession {
                        session_id: "session-archived".to_owned(),
                        project_id: Some("project-native".to_owned()),
                        title: "Must not exist".to_owned(),
                        initial_page_ids: Vec::new(),
                    },
                ),
            )
            .expect_err("reject Session creation for archived Project");
        assert_eq!(archived_session_create.code, CoreErrorCode::InvalidInput);

        let archived_session_update = module
            .apply(
                &context(),
                session_request(
                    "workspace-update-session-archived",
                    &native_session_id,
                    ProjectSessionIntent::Rename {
                        title: "Must not change".to_owned(),
                    },
                ),
            )
            .expect_err("reject Session mutation for archived Project");
        assert_eq!(archived_session_update.code, CoreErrorCode::NotFound);

        for (operation_id, intent) in [
            (
                "workspace-update-thread-archived-owner",
                ProjectWorkspaceIntent::UpdateThread {
                    thread_id: "thread-archived-owner".to_owned(),
                    patch: Box::new(ProjectWorkspaceThreadPatch::default()),
                },
            ),
            (
                "workspace-roots-archived-owner",
                ProjectWorkspaceIntent::ReplaceThreadWritableRoots {
                    thread_id: "thread-archived-owner".to_owned(),
                    roots: vec!["/workspace/rejected".to_owned()],
                },
            ),
        ] {
            let error = module
                .apply(&context(), request(operation_id, intent))
                .expect_err("reject archived-owner Thread mutation");
            assert_eq!(error.code, CoreErrorCode::NotFound);
        }

        let authority_read = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                    read: ProjectWorkspaceRead::TurnAuthority {
                        thread_id: "thread-archived-owner".to_owned(),
                        turn_id: "turn-archived-owner".to_owned(),
                        root_thread_id: "thread-archived-owner".to_owned(),
                        actor_project_id: "project-native".to_owned(),
                    },
                },
            )
            .expect_err("reject turn authority resolution for archived Project");
        assert_eq!(authority_read.code, CoreErrorCode::NotFound);

        let mut archived_project_context = context();
        archived_project_context.project_id = Some(ProjectId("project-native".to_owned()));
        let authority_freeze = module
            .apply(
                &archived_project_context,
                request(
                    "workspace-freeze-authority-archived-owner",
                    ProjectWorkspaceIntent::FreezeTurnAuthority {
                        thread_id: "thread-archived-owner".to_owned(),
                        turn_id: "turn-archived-owner".to_owned(),
                        root_thread_id: "thread-archived-owner".to_owned(),
                        actor_project_id: "project-native".to_owned(),
                        source: ProjectWorkspaceTurnAuthoritySource::ProjectTurn,
                        inherited_from: None,
                    },
                ),
            )
            .expect_err("reject turn authority freeze for archived Project");
        assert_eq!(authority_freeze.code, CoreErrorCode::NotFound);

        let stored = kernel
            .writer()
            .call(|connection| {
                connection
                    .query_row(
                        "SELECT project.name, project.description, project.appearance_color, \
                            project.appearance_marker_kind, project.appearance_marker_value, \
                            project.lifecycle, project.binding_revision, \
                            binding.lifecycle, binding.revision, \
                            (SELECT group_concat(root, '|') FROM project_sources \
                             WHERE project_id = project.id ORDER BY \"order\"), \
                            (SELECT count(*) FROM project_order \
                             WHERE project_id = project.id), \
                            (SELECT count(*) FROM pinned_project_order \
                             WHERE project_id = project.id), \
                            (SELECT count(*) FROM core_module_receipts \
                             WHERE operation_id = 'workspace-update-stale'), \
                            (SELECT count(*) FROM change_log \
                             WHERE operation_id = 'workspace-update-stale') \
                     FROM projects project JOIN project_database_bindings binding \
                       ON binding.project_id = project.id \
                     WHERE project.id = 'project-native'",
                        [],
                        |row| {
                            Ok((
                                row.get::<_, String>(0)?,
                                row.get::<_, String>(1)?,
                                row.get::<_, String>(2)?,
                                row.get::<_, String>(3)?,
                                row.get::<_, String>(4)?,
                                row.get::<_, String>(5)?,
                                row.get::<_, i64>(6)?,
                                row.get::<_, String>(7)?,
                                row.get::<_, i64>(8)?,
                                row.get::<_, String>(9)?,
                                row.get::<_, i64>(10)?,
                                row.get::<_, i64>(11)?,
                                row.get::<_, i64>(12)?,
                                row.get::<_, i64>(13)?,
                            ))
                        },
                    )
                    .map_err(Into::into)
            })
            .expect("read mutated Project");
        assert_eq!(stored.0, "Renamed Project");
        assert_eq!(stored.1, "Updated metadata");
        assert_eq!(
            (&stored.2[..], &stored.3[..], &stored.4[..]),
            ("purple", "emoji", "🧭")
        );
        assert_eq!(stored.5, "archived");
        assert_eq!(stored.6, 5);
        assert_eq!(stored.7, "archived");
        assert_eq!(stored.8, 5);
        assert_eq!(stored.9, "/workspace/source-only");
        assert_eq!((stored.10, stored.11), (0, 0));
        assert_eq!((stored.12, stored.13), (0, 0));

        module
            .apply(
                &context(),
                request(
                    "workspace-restore-native",
                    ProjectWorkspaceIntent::SetProjectLifecycle {
                        project_id: "project-native".to_owned(),
                        lifecycle: ProjectLifecycle::Active,
                    },
                ),
            )
            .expect("restore Project");
        let restored = kernel
            .writer()
            .call(|connection| {
                connection
                    .query_row(
                        "SELECT project.lifecycle, project.binding_revision, ordering.\"order\" \
                         FROM projects project JOIN project_order ordering \
                           ON ordering.project_id = project.id \
                         WHERE project.id = 'project-native'",
                        [],
                        |row| {
                            Ok((
                                row.get::<_, String>(0)?,
                                row.get::<_, i64>(1)?,
                                row.get::<_, i64>(2)?,
                            ))
                        },
                    )
                    .map_err(Into::into)
            })
            .expect("read restored Project");
        assert_eq!(restored, ("active".to_owned(), 6, 3));
    }

    #[test]
    fn mutates_session_state_and_existing_thread_links_with_exact_replay() {
        let (_directory, kernel, module) = seeded_module();
        module
            .apply(
                &context(),
                create_request("workspace-create-session-owner", "project-native"),
            )
            .expect("create Session owner Project");
        let session_id = "session:native".to_owned();
        module
            .apply(
                &context(),
                request(
                    "workspace-create-session",
                    ProjectWorkspaceIntent::CreateSession {
                        session_id: session_id.clone(),
                        project_id: Some("project-native".to_owned()),
                        title: "New chat".to_owned(),
                        initial_page_ids: Vec::new(),
                    },
                ),
            )
            .expect("create Session");
        kernel
            .writer()
            .call(|connection| {
                connection.execute(
                    "INSERT INTO codex_threads(\
                       thread_id, project_id, thread_name, thread_preview, \
                       status_type, status_active_flags_json, archived, created_at, updated_at, \
                       recency_at, linked_at\
                     ) VALUES (\
                       'thread-native', 'project-native', '', 'Preview', 'idle', '[]', \
                       0, 1, 2, 2, ?1\
                     )",
                    [NOW],
                )?;
                connection.execute(
                    "INSERT INTO codex_unread_threads(thread_id) VALUES ('thread-native')",
                    [],
                )?;
                Ok(())
            })
            .expect("seed existing Codex Thread");

        let rename = session_request(
            "workspace-session-rename-fallback",
            &session_id,
            ProjectSessionIntent::Rename {
                title: "  Fallback   title  ".to_owned(),
            },
        );
        let renamed = module
            .apply(&context(), rename.clone())
            .expect("rename unlinked Session");
        assert_eq!(
            renamed.committed.value.affected_session_ids.as_slice(),
            std::slice::from_ref(&session_id)
        );
        let Some(event) = renamed.event.as_ref() else {
            panic!("Session rename must publish a Workspace event");
        };
        let CoreModuleEventPayload::ProjectWorkspace(event) = &event.payload else {
            panic!("Session rename must publish a Project Workspace event");
        };
        assert_eq!(event.project_catalog_change, None);
        assert_eq!(
            event.session_summary_scopes,
            vec![ProjectSessionInvalidationScope::Project {
                project_id: "project-native".to_owned(),
            }]
        );
        assert_eq!(event.session_detail_ids, vec![session_id.clone()]);
        let replay = module
            .apply(&context(), rename)
            .expect("replay Session rename");
        assert!(replay.committed.receipt.mutation.duplicate);
        assert_eq!(
            replay.committed.event_sequence,
            renamed.committed.event_sequence
        );

        let mismatched = module
            .apply(
                &context(),
                session_request(
                    "workspace-session-link-mismatch",
                    &session_id,
                    ProjectSessionIntent::LinkThread {
                        thread_id: "thread-native".to_owned(),
                        expected_project_id: Some("project:default".to_owned()),
                        thread_patch: None,
                        execution_location: None,
                    },
                ),
            )
            .expect_err("reject mismatched Thread Project");
        assert_eq!(mismatched.code, CoreErrorCode::Conflict);

        let linked = module
            .apply(
                &context(),
                session_request(
                    "workspace-session-link",
                    &session_id,
                    ProjectSessionIntent::LinkThread {
                        thread_id: "thread-native".to_owned(),
                        expected_project_id: Some("project-native".to_owned()),
                        thread_patch: Some(Box::new(ProjectWorkspaceThreadPatch {
                            project_id: Some(Some("project-native".to_owned())),
                            thread_preview: Some("Updated preview".to_owned()),
                            status: Some(ProjectWorkspaceThreadStatus {
                                status_type: CodexThreadStatusType::Active,
                                active_flags: vec![CodexThreadActiveFlag::WaitingOnApproval],
                            }),
                            updated_at: Some(3),
                            ..ProjectWorkspaceThreadPatch::default()
                        })),
                        execution_location: None,
                    },
                ),
            )
            .expect("link existing Codex Thread");
        assert_eq!(
            linked.committed.value.affected_thread_ids,
            ["thread-native"]
        );
        module
            .apply(
                &context(),
                session_request(
                    "workspace-session-rename-thread",
                    &session_id,
                    ProjectSessionIntent::Rename {
                        title: "  Thread   title  ".to_owned(),
                    },
                ),
            )
            .expect("rename linked Codex Thread");
        module
            .apply(
                &context(),
                session_request(
                    "workspace-session-unpin",
                    &session_id,
                    ProjectSessionIntent::SetPinned { pinned: false },
                ),
            )
            .expect("unpin Session");
        module
            .apply(
                &context(),
                session_request(
                    "workspace-session-read",
                    &session_id,
                    ProjectSessionIntent::SetUnread { unread: false },
                ),
            )
            .expect("mark Session read");
        module
            .apply(
                &context(),
                session_request(
                    "workspace-session-unlink",
                    &session_id,
                    ProjectSessionIntent::UnlinkThread {
                        thread_id: "thread-native".to_owned(),
                    },
                ),
            )
            .expect("unlink Codex Thread");

        let stored = kernel
            .writer()
            .call(move |connection| {
                connection
                    .query_row(
                        "SELECT session.no_thread_fallback_title, session.pinned, \
                            session.pinned_order, session.unread, thread.thread_name, \
                            thread.thread_preview, thread.status_type, \
                            (SELECT count(*) FROM project_session_threads \
                             WHERE session_id = session.id), \
                            (SELECT count(*) FROM core_module_receipts \
                             WHERE operation_id = 'workspace-session-link-mismatch'), \
                            (SELECT count(*) FROM change_log \
                             WHERE operation_id = 'workspace-session-link-mismatch') \
                         FROM project_sessions session CROSS JOIN codex_threads thread \
                         WHERE session.id = ?1 AND thread.thread_id = 'thread-native'",
                        [&session_id],
                        |row| {
                            Ok((
                                row.get::<_, String>(0)?,
                                row.get::<_, i64>(1)?,
                                row.get::<_, Option<i64>>(2)?,
                                row.get::<_, i64>(3)?,
                                row.get::<_, String>(4)?,
                                row.get::<_, String>(5)?,
                                row.get::<_, String>(6)?,
                                row.get::<_, i64>(7)?,
                                row.get::<_, i64>(8)?,
                                row.get::<_, i64>(9)?,
                            ))
                        },
                    )
                    .map_err(Into::into)
            })
            .expect("read mutated Session");
        assert_eq!(stored.0, "Fallback title");
        assert_eq!((stored.1, stored.2, stored.3), (0, None, 0));
        assert_eq!(stored.4, "Thread title");
        assert_eq!(
            (stored.5.as_str(), stored.6.as_str()),
            ("Updated preview", "active")
        );
        assert_eq!((stored.7, stored.8, stored.9), (0, 0, 0));
    }

    #[test]
    fn ensures_one_default_draft_per_scope_and_owns_its_lifecycle() {
        let (_directory, kernel, module) = seeded_module();
        for (operation_id, project_id) in [
            ("default-draft-project-alpha", "project-alpha"),
            ("default-draft-project-beta", "project-beta"),
            ("default-draft-project-gamma", "project-gamma"),
        ] {
            module
                .apply(&context(), create_request(operation_id, project_id))
                .expect("create default-draft test Project");
        }
        module
            .apply(
                &context(),
                request(
                    "default-draft-ordinary-threadless",
                    ProjectWorkspaceIntent::CreateSession {
                        session_id: "session:ordinary-threadless".to_owned(),
                        project_id: Some("project-alpha".to_owned()),
                        title: "Page workspace".to_owned(),
                        initial_page_ids: Vec::new(),
                    },
                ),
            )
            .expect("create ordinary threadless Session");

        let first = ProjectWorkspaceModule::new("profile-1", "library-1", &kernel)
            .expect("first competing Workspace module");
        let second = ProjectWorkspaceModule::new("profile-1", "library-1", &kernel)
            .expect("second competing Workspace module");
        let first_thread = std::thread::spawn(move || {
            first.apply(
                &context(),
                request(
                    "default-draft-concurrent-a",
                    ProjectWorkspaceIntent::EnsureDefaultDraftSession {
                        session_id: "session:default-a".to_owned(),
                        project_id: Some("project-alpha".to_owned()),
                        title: "New chat".to_owned(),
                    },
                ),
            )
        });
        let second_thread = std::thread::spawn(move || {
            second.apply(
                &context(),
                request(
                    "default-draft-concurrent-b",
                    ProjectWorkspaceIntent::EnsureDefaultDraftSession {
                        session_id: "session:default-b".to_owned(),
                        project_id: Some("project-alpha".to_owned()),
                        title: "New chat".to_owned(),
                    },
                ),
            )
        });
        let outcomes = [
            first_thread
                .join()
                .expect("first competing default-draft writer")
                .expect("first default-draft ensure"),
            second_thread
                .join()
                .expect("second competing default-draft writer")
                .expect("second default-draft ensure"),
        ];
        let winner = outcomes[0].committed.value.affected_session_ids[0].clone();
        assert_eq!(
            outcomes[1].committed.value.affected_session_ids,
            std::slice::from_ref(&winner)
        );
        assert_eq!(
            outcomes
                .iter()
                .filter(|outcome| outcome.event.is_some())
                .count(),
            1
        );

        let ensure = |operation_id: &str, candidate: &str, project_id: Option<&str>| {
            module
                .apply(
                    &context(),
                    request(
                        operation_id,
                        ProjectWorkspaceIntent::EnsureDefaultDraftSession {
                            session_id: candidate.to_owned(),
                            project_id: project_id.map(str::to_owned),
                            title: "New chat".to_owned(),
                        },
                    ),
                )
                .expect("ensure default-draft Session")
                .committed
                .value
                .affected_session_ids[0]
                .clone()
        };
        assert_eq!(
            ensure(
                "default-draft-repeat-alpha",
                "session:ignored-alpha",
                Some("project-alpha")
            ),
            winner
        );
        let beta = ensure(
            "default-draft-ensure-beta",
            "session:default-beta",
            Some("project-beta"),
        );
        let projectless = ensure(
            "default-draft-ensure-projectless",
            "session:default-projectless",
            None,
        );
        assert_ne!(winner, beta);
        assert_ne!(winner, projectless);

        module
            .apply(
                &context(),
                session_request(
                    "default-draft-rename",
                    &winner,
                    ProjectSessionIntent::Rename {
                        title: "Still drafting".to_owned(),
                    },
                ),
            )
            .expect("rename default draft");
        module
            .apply(
                &context(),
                session_request(
                    "default-draft-pin",
                    &winner,
                    ProjectSessionIntent::SetPinned { pinned: true },
                ),
            )
            .expect("pin default draft");
        let move_conflict = module
            .apply(
                &context(),
                request(
                    "default-draft-move-conflict",
                    ProjectWorkspaceIntent::MoveSession {
                        session_id: winner.clone(),
                        project_id: Some("project-beta".to_owned()),
                    },
                ),
            )
            .expect_err("reject moving a default draft into an occupied scope");
        assert_eq!(move_conflict.code, CoreErrorCode::Conflict);
        module
            .apply(
                &context(),
                request(
                    "default-draft-move-gamma",
                    ProjectWorkspaceIntent::MoveSession {
                        session_id: winner.clone(),
                        project_id: Some("project-gamma".to_owned()),
                    },
                ),
            )
            .expect("move default draft into empty scope");

        kernel
            .writer()
            .call(|connection| {
                connection.execute(
                    "INSERT INTO codex_threads(\
                       thread_id, project_id, thread_name, thread_preview, \
                       status_type, status_active_flags_json, archived, created_at, updated_at, \
                       recency_at, linked_at\
                     ) VALUES (\
                       'thread:default-draft', 'project-gamma', '', '', 'idle', '[]', \
                       0, 1, 1, 1, ?1\
                     )",
                    [NOW],
                )?;
                connection.execute(
                    "INSERT INTO codex_threads(\
                       thread_id, project_id, thread_name, thread_preview, \
                       status_type, status_active_flags_json, archived, created_at, updated_at, \
                       recency_at, linked_at\
                     ) VALUES (\
                       'thread:default-draft-race', 'project-gamma', '', '', 'idle', \
                       '[]', 0, 1, 1, 1, ?1\
                     )",
                    [NOW],
                )?;
                Ok(())
            })
            .expect("seed Thread for default-draft graduation");
        module
            .apply(
                &context(),
                session_request(
                    "default-draft-link-thread",
                    &winner,
                    ProjectSessionIntent::LinkThread {
                        thread_id: "thread:default-draft".to_owned(),
                        expected_project_id: Some("project-gamma".to_owned()),
                        thread_patch: None,
                        execution_location: None,
                    },
                ),
            )
            .expect("graduate default draft by linking a Thread");
        let competing_link = module
            .apply(
                &context(),
                session_request(
                    "default-draft-competing-link",
                    &winner,
                    ProjectSessionIntent::LinkThread {
                        thread_id: "thread:default-draft-race".to_owned(),
                        expected_project_id: Some("project-gamma".to_owned()),
                        thread_patch: None,
                        execution_location: None,
                    },
                ),
            )
            .expect_err("reject replacing a Session's existing Thread link");
        assert_eq!(competing_link.code, CoreErrorCode::Conflict);
        module
            .apply(
                &context(),
                session_request(
                    "default-draft-unlink-thread",
                    &winner,
                    ProjectSessionIntent::UnlinkThread {
                        thread_id: "thread:default-draft".to_owned(),
                    },
                ),
            )
            .expect("unlink graduated Thread");
        let gamma_after_link = ensure(
            "default-draft-after-link",
            "session:default-gamma-after-link",
            Some("project-gamma"),
        );
        assert_ne!(gamma_after_link, winner);
        module
            .apply(
                &context(),
                session_request(
                    "default-draft-archive",
                    &gamma_after_link,
                    ProjectSessionIntent::SetArchived { archived: true },
                ),
            )
            .expect("archive default draft");
        module
            .apply(
                &context(),
                session_request(
                    "default-draft-restore",
                    &gamma_after_link,
                    ProjectSessionIntent::SetArchived { archived: false },
                ),
            )
            .expect("restore graduated archived draft");
        let gamma_after_archive = ensure(
            "default-draft-after-archive",
            "session:default-gamma-after-archive",
            Some("project-gamma"),
        );
        assert_ne!(gamma_after_archive, gamma_after_link);

        module
            .apply(
                &context(),
                request(
                    "default-draft-delete-beta",
                    ProjectWorkspaceIntent::DeleteSession {
                        session_id: beta.clone(),
                    },
                ),
            )
            .expect("delete beta default draft");
        assert_ne!(
            ensure(
                "default-draft-after-delete",
                "session:default-beta-after-delete",
                Some("project-beta")
            ),
            beta
        );

        let counts = kernel
            .writer()
            .call(move |connection| {
                connection
                    .query_row(
                        "SELECT \
                           (SELECT count(*) FROM project_sessions \
                            WHERE project_id = 'project-alpha' AND is_default_draft = 1), \
                           (SELECT count(*) FROM project_sessions \
                            WHERE project_id = 'project-beta' AND is_default_draft = 1), \
                           (SELECT count(*) FROM project_sessions \
                            WHERE project_id = 'project-gamma' AND is_default_draft = 1), \
                           (SELECT count(*) FROM project_sessions \
                            WHERE project_id IS NULL AND is_default_draft = 1), \
                           (SELECT is_default_draft FROM project_sessions \
                            WHERE id = 'session:ordinary-threadless'), \
                           (SELECT is_default_draft FROM project_sessions WHERE id = ?1), \
                           (SELECT is_default_draft FROM project_sessions WHERE id = ?2)",
                        [&winner, &gamma_after_link],
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
                    )
                    .map_err(Into::into)
            })
            .expect("read default-draft invariants");
        assert_eq!(counts, (0, 1, 1, 1, 0, 0, 0));
    }

    #[test]
    fn owns_session_lifecycle_order_move_and_delete_with_exact_replay() {
        let (_directory, kernel, module) = seeded_module();
        module
            .apply(
                &context(),
                create_request("workspace-session-lifecycle-project", "project-native"),
            )
            .expect("create Session lifecycle Project");

        let create_a = request(
            "workspace-session-create-a",
            ProjectWorkspaceIntent::CreateSession {
                session_id: "session-a".to_owned(),
                project_id: Some("project-native".to_owned()),
                title: "  Lifecycle A  ".to_owned(),
                initial_page_ids: Vec::new(),
            },
        );
        let created_a = module
            .apply(&context(), create_a.clone())
            .expect("create first explicit Session");
        let replayed_a = module
            .apply(&context(), create_a)
            .expect("replay explicit Session creation");
        assert!(replayed_a.committed.receipt.mutation.duplicate);
        assert_eq!(
            replayed_a.committed.event_sequence,
            created_a.committed.event_sequence
        );
        assert!(replayed_a.event.is_none());
        module
            .apply(
                &context(),
                request(
                    "workspace-session-create-b",
                    ProjectWorkspaceIntent::CreateSession {
                        session_id: "session-b".to_owned(),
                        project_id: Some("project-native".to_owned()),
                        title: "Lifecycle B".to_owned(),
                        initial_page_ids: Vec::new(),
                    },
                ),
            )
            .expect("create second explicit Session");
        for session_id in ["session-a", "session-b"] {
            module
                .apply(
                    &context(),
                    session_request(
                        &format!("workspace-session-pin-{session_id}"),
                        session_id,
                        ProjectSessionIntent::SetPinned { pinned: true },
                    ),
                )
                .expect("pin explicit Session");
        }
        module
            .apply(
                &context(),
                request(
                    "workspace-session-reorder",
                    ProjectWorkspaceIntent::ReorderSessions {
                        project_id: Some("project-native".to_owned()),
                        session_ids: vec!["session-b".to_owned(), "session-a".to_owned()],
                    },
                ),
            )
            .expect("reorder active Sessions");
        module
            .apply(
                &context(),
                request(
                    "workspace-session-reorder-pinned",
                    ProjectWorkspaceIntent::ReorderPinnedSessions {
                        project_id: Some("project-native".to_owned()),
                        session_ids: vec!["session-b".to_owned(), "session-a".to_owned()],
                    },
                ),
            )
            .expect("reorder pinned Sessions");

        module
            .apply(
                &context(),
                session_request(
                    "workspace-session-archive-b",
                    "session-b",
                    ProjectSessionIntent::SetArchived { archived: true },
                ),
            )
            .expect("archive Session");
        let archived = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                    read: ProjectWorkspaceRead::Session {
                        session_id: "session-b".to_owned(),
                    },
                },
            )
            .expect("read archived Session");
        let ProjectWorkspaceReadValue::Session { session, .. } = archived.value else {
            panic!("archived Session snapshot");
        };
        assert!(session.archived);
        assert!(session.archived_at.is_some());
        assert!(!session.pinned);
        assert_eq!(session.pinned_order, None);
        module
            .apply(
                &context(),
                session_request(
                    "workspace-session-restore-b",
                    "session-b",
                    ProjectSessionIntent::SetArchived { archived: false },
                ),
            )
            .expect("restore Session");

        module
            .apply(
                &context(),
                request(
                    "workspace-session-create-projectless",
                    ProjectWorkspaceIntent::CreateSession {
                        session_id: "session-projectless".to_owned(),
                        project_id: None,
                        title: "Projectless browser".to_owned(),
                        initial_page_ids: Vec::new(),
                    },
                ),
            )
            .expect("create projectless Session");
        kernel
            .writer()
            .call(|connection| {
                connection.execute(
                    "INSERT INTO codex_threads(\
                       thread_id, project_id, thread_name, thread_preview, \
                       status_type, status_active_flags_json, archived, created_at, updated_at, \
                       recency_at, linked_at\
                     ) VALUES (\
                       'thread-projectless', NULL, '', 'Projectless preview', \
                       'idle', '[]', 0, 1, 2, 2, ?1\
                     )",
                    [NOW],
                )?;
                Ok(())
            })
            .expect("seed projectless Codex Thread");
        module
            .apply(
                &context(),
                session_request(
                    "workspace-session-link-projectless",
                    "session-projectless",
                    ProjectSessionIntent::LinkThread {
                        thread_id: "thread-projectless".to_owned(),
                        expected_project_id: None,
                        thread_patch: None,
                        execution_location: None,
                    },
                ),
            )
            .expect("link projectless Codex Thread");
        let archived_link = module
            .apply(
                &context(),
                session_request(
                    "workspace-session-archive-projectless",
                    "session-projectless",
                    ProjectSessionIntent::SetArchived { archived: true },
                ),
            )
            .expect("archive linked projectless Session");
        assert_eq!(
            archived_link.committed.value.affected_thread_ids,
            ["thread-projectless"]
        );
        let archived_thread = kernel
            .writer()
            .call(|connection| {
                let archived = connection.query_row(
                    "SELECT archived FROM codex_threads WHERE thread_id = 'thread-projectless'",
                    [],
                    |row| row.get::<_, i64>(0),
                )?;
                Ok(archived)
            })
            .expect("read archived linked Agent Thread");
        assert_eq!(archived_thread, 1);
        module
            .apply(
                &context(),
                session_request(
                    "workspace-session-restore-projectless",
                    "session-projectless",
                    ProjectSessionIntent::SetArchived { archived: false },
                ),
            )
            .expect("restore linked projectless Session");
        let moved = module
            .apply(
                &context(),
                request(
                    "workspace-session-move-projectless",
                    ProjectWorkspaceIntent::MoveSession {
                        session_id: "session-projectless".to_owned(),
                        project_id: Some("project-native".to_owned()),
                    },
                ),
            )
            .expect("move projectless Session into Project");
        assert_eq!(
            moved.committed.value.affected_thread_ids,
            ["thread-projectless"]
        );
        let CoreModuleEventPayload::ProjectWorkspace(moved_event) =
            &moved.event.as_ref().expect("Session move event").payload
        else {
            panic!("Session move must publish a Project Workspace event");
        };
        assert_eq!(
            moved_event.session_summary_scopes,
            vec![
                ProjectSessionInvalidationScope::Projectless,
                ProjectSessionInvalidationScope::Project {
                    project_id: "project-native".to_owned(),
                },
            ]
        );
        assert_eq!(moved_event.session_detail_ids, vec!["session-projectless"]);
        let moved_back = module
            .apply(
                &context(),
                request(
                    "workspace-session-move-projectless-back",
                    ProjectWorkspaceIntent::MoveSession {
                        session_id: "session-projectless".to_owned(),
                        project_id: None,
                    },
                ),
            )
            .expect("move Session back to projectless");
        assert_eq!(
            moved_back.committed.value.affected_thread_ids,
            ["thread-projectless"]
        );
        let deleted = module
            .apply(
                &context(),
                request(
                    "workspace-session-delete-projectless",
                    ProjectWorkspaceIntent::DeleteSession {
                        session_id: "session-projectless".to_owned(),
                    },
                ),
            )
            .expect("delete moved Session");
        assert_eq!(
            deleted.committed.value.affected_thread_ids,
            ["thread-projectless"]
        );

        let stored = kernel
            .writer()
            .call(move |connection| {
                let session_rows = connection
                    .prepare(
                        "SELECT id, \"order\", pinned, pinned_order, archived, archived_at, \
                           no_thread_fallback_title \
                         FROM project_sessions WHERE project_id = 'project-native' \
                         ORDER BY id",
                    )?
                    .query_map([], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, i64>(1)?,
                            row.get::<_, i64>(2)?,
                            row.get::<_, Option<i64>>(3)?,
                            row.get::<_, i64>(4)?,
                            row.get::<_, Option<String>>(5)?,
                            row.get::<_, String>(6)?,
                        ))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                let lifecycle_counts = connection.query_row(
                    "SELECT \
                       (SELECT count(*) FROM project_sessions \
                        WHERE id = 'session-projectless'), \
                       (SELECT count(*) FROM project_session_threads \
                        WHERE thread_id = 'thread-projectless'), \
                       (SELECT project_id FROM codex_threads \
                        WHERE thread_id = 'thread-projectless')",
                    [],
                    |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, i64>(1)?,
                            row.get::<_, Option<String>>(2)?,
                        ))
                    },
                )?;
                Ok((session_rows, lifecycle_counts))
            })
            .expect("read Session lifecycle effects");
        let session_a = stored
            .0
            .iter()
            .find(|row| row.0 == "session-a")
            .expect("first explicit Session");
        assert_eq!((session_a.1, session_a.2, session_a.3), (2, 1, Some(1)));
        assert_eq!(session_a.6, "Lifecycle A");
        let session_b = stored
            .0
            .iter()
            .find(|row| row.0 == "session-b")
            .expect("second explicit Session");
        assert_eq!((session_b.1, session_b.2, session_b.3), (1, 0, None));
        assert_eq!(session_b.4, 0);
        assert_eq!(session_b.5, None);
        assert_eq!(stored.1, (0, 0, None));
    }

    #[test]
    fn rolls_back_the_complete_project_when_a_nested_canvas_write_fails() {
        let (_directory, kernel, module) = seeded_module();
        let identities =
            super::aggregate_identities("workspace-create-rollback", "project-rollback");
        kernel
            .writer()
            .call(|connection| {
                connection.execute_batch(
                    "CREATE TEMP TRIGGER fail_workspace_canvas \
                     BEFORE INSERT ON canvas_scenes BEGIN \
                       SELECT RAISE(ABORT, 'injected Canvas failure'); \
                     END;",
                )?;
                Ok(())
            })
            .expect("install fault trigger");
        let error = module
            .apply(
                &context(),
                create_request("workspace-create-rollback", "project-rollback"),
            )
            .expect_err("nested failure must reject aggregate");
        assert_eq!(error.code, CoreErrorCode::CoreUnavailable);
        let counts = kernel
            .writer()
            .call(|connection| {
                connection
                    .query_row(
                        "SELECT \
                       (SELECT count(*) FROM projects WHERE id = 'project-rollback'), \
                       (SELECT count(*) FROM blocks \
                        WHERE id IN (?1, 'canvas:primary:project-rollback')), \
                       (SELECT count(*) FROM project_sessions \
                        WHERE project_id = 'project-rollback'), \
                       (SELECT count(*) FROM core_module_receipts \
                        WHERE operation_id = 'workspace-create-rollback'), \
                       (SELECT count(*) FROM change_log \
                        WHERE operation_id = 'workspace-create-rollback')",
                        [identities.database_id],
                        |row| {
                            Ok((
                                row.get::<_, i64>(0)?,
                                row.get::<_, i64>(1)?,
                                row.get::<_, i64>(2)?,
                                row.get::<_, i64>(3)?,
                                row.get::<_, i64>(4)?,
                            ))
                        },
                    )
                    .map_err(Into::into)
            })
            .expect("read rollback state");
        assert_eq!(counts, (0, 0, 0, 0, 0));
    }
}
