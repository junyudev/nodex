mod activity;
mod agent_command;
mod agent_runtime_authority;
mod agent_runtime_binding;
mod agent_runtime_cleanup;
mod app_tool_operation;
mod channels;
mod chat_stewardship;
mod child_thread_window;
mod codex_thread_navigation;
mod coordinator;
#[cfg(test)]
mod coordinator_tests;
mod execution;
pub(crate) mod execution_holds;
#[cfg(test)]
mod execution_holds_tests;
mod host_chat;
pub use host_chat::HostChatAction;
mod host_response;
mod inbox;
pub(crate) use inbox::scheduled::{
    PreparedRunPages, bind_automation_run_pages, prepare_automation_run_pages,
    run_held_automation_now,
};
pub(crate) mod automation_assessment;
pub(crate) mod page_turn;
#[cfg(test)]
mod page_turn_tests;
mod page_work;
#[cfg(test)]
mod page_work_tests;
pub(crate) mod page_workspace;
#[cfg(test)]
mod page_workspace_tests;
mod problems;
mod sources;
#[cfg(test)]
mod sources_tests;
mod thread_follows;
pub(crate) use inbox::reliable::discard_replaced_dispatches as discard_replaced_inbox_dispatches;
pub(crate) mod inbox_content;
mod inbox_projection;
mod inbox_read;
mod inbox_serialization;
#[cfg(test)]
pub(crate) use inbox_read::{
    FrozenSuggestionInput, frozen_input_for_content,
    message_basis as inbox_message_basis_for_migration,
};
pub(crate) use inbox_serialization::{
    rebuild_inbox_markdown_serialization, validate_inbox_markdown_serialization,
};
#[cfg(test)]
mod inbox_tests;
mod managed_worktree_lifecycle;
mod managed_worktree_window;
mod member_attention;
mod mutation;
mod page_chat;
mod page_create;
#[cfg(test)]
mod page_handoff_tests;
mod project_activity_summary;
mod project_window;
mod queued_message_state;
mod read;
mod session_activity;
mod session_lifecycle;
mod session_listing;
mod session_mutation;
mod session_order;
#[cfg(test)]
mod session_reminder_tests;
mod session_usage;
mod sidebar;
mod sidebar_builtin;
#[cfg(test)]
mod sidebar_builtin_tests;
mod sidebar_pins;
mod sidebar_section;
mod subagent_projection;
mod task_window;
#[cfg(test)]
mod test_support;
mod thread;
mod thread_assets;
mod thread_read_state;

pub(crate) use execution::validate_persisted_turn_authority;
pub use thread_assets::ThreadAssetBlob;

use std::path::PathBuf;

use nodex_core_contracts::workspace::{
    ProjectWorkspaceCommitValue, ProjectWorkspaceIntent, ProjectWorkspaceRead,
    ProjectWorkspaceReadValue, ProjectWorkspaceReceipt,
};
use nodex_core_contracts::{
    BoundModuleContext, CommittedCoreModuleEvent, CoreError, CoreErrorCode, CoreErrorRecovery,
    ModuleApplyRequest, ModuleReadRequest, ModuleReadSnapshot, PROJECT_WORKSPACE_CONTRACT_VERSION,
    StoreEpoch,
};
use rusqlite::OptionalExtension;

use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};
use crate::infrastructure::store::SqliteStoreKernel;
use crate::infrastructure::writer::{StoreReaders, StoreWriter};

#[derive(Clone, Debug)]
pub struct ProjectWorkspaceApplyOutcome {
    pub committed: crate::ModuleWriterResult<ProjectWorkspaceCommitValue, ProjectWorkspaceReceipt>,
    pub event: Option<CommittedCoreModuleEvent>,
}

pub struct ProjectWorkspaceModule {
    profile_id: String,
    library_id: String,
    readers: Option<StoreReaders>,
    writer: Option<StoreWriter>,
    assets_root: Option<PathBuf>,
}

impl ProjectWorkspaceModule {
    /// Admit an execution-owner response for the authenticated Member. Runtime
    /// request identity is verified again by the execution owner before dispatch.
    pub fn authorize_host_response(
        &self,
        principal: &nodex_core_contracts::RemotePrincipal,
        session: &str,
        run: Option<&str>,
        request: &str,
    ) -> Result<(), CoreError> {
        let Some(readers) = &self.readers else {
            return Err(unavailable("Project Workspace Module has no durable store"));
        };
        readers
            .read_default(|connection| {
                let transaction = connection.unchecked_transaction()?;
                host_response::authorize(
                    &transaction,
                    &self.library_id,
                    principal,
                    session,
                    run,
                    request,
                )
            })
            .map_err(core_error)
    }

    /// Admit a Member's action on a chat its Space host runs, from Core's own Store.
    pub fn authorize_host_chat(
        &self,
        principal: &nodex_core_contracts::RemotePrincipal,
        action: HostChatAction<'_>,
    ) -> Result<(), CoreError> {
        let Some(readers) = &self.readers else {
            return Err(unavailable("Project Workspace Module has no durable store"));
        };
        readers
            .read_default(|connection| {
                let transaction = connection.unchecked_transaction()?;
                host_chat::authorize(&transaction, &self.library_id, principal, action)
            })
            .map_err(core_error)
    }

    /// The Member a chat event concerns, for the local Host's phone notifications only.
    pub fn push_audience(
        &self,
        session: Option<&str>,
        audience: &nodex_core_contracts::team::PhonePushAudience,
    ) -> Result<Option<String>, CoreError> {
        let Some(readers) = &self.readers else {
            return Err(unavailable("Project Workspace Module has no durable store"));
        };
        readers
            .read_default(|connection| {
                host_response::push_audience(connection, &self.library_id, session, audience)
            })
            .map_err(core_error)
    }

    pub fn new(
        profile_id: impl Into<String>,
        library_id: impl Into<String>,
        kernel: &SqliteStoreKernel,
    ) -> Result<Self, CoreError> {
        let writer = kernel.writer();
        let assets_root = kernel
            .database_path()
            .parent()
            .expect("Profile database has a parent")
            .join("assets");
        let sweep_root = assets_root.clone();
        let _ = writer.call(move |connection| {
            crate::infrastructure::managed_blob_gc::collect(connection, &sweep_root, 512)
        });
        Ok(Self {
            profile_id: profile_id.into(),
            library_id: library_id.into(),
            readers: Some(kernel.readers()),
            writer: Some(writer),
            assets_root: Some(assets_root),
        })
    }

    pub fn admit_app_tool_operation(
        &self,
        context: &BoundModuleContext,
        request: nodex_core_contracts::workspace::AppToolOperationRequest,
    ) -> Result<nodex_core_contracts::workspace::AppToolOperationIdentity, CoreError> {
        self.validate_context(context)?;
        let Some(writer) = &self.writer else {
            return Err(unavailable("Project Workspace Module has no durable store"));
        };
        app_tool_operation::admit(writer, &self.library_id, context, request).map_err(core_error)
    }

    pub fn read(
        &self,
        context: &BoundModuleContext,
        request: ModuleReadRequest<ProjectWorkspaceRead>,
    ) -> Result<ModuleReadSnapshot<ProjectWorkspaceReadValue>, CoreError> {
        nodex_core_contracts::remote_admission::authorize(
            context,
            "workspace_read",
            &request.read,
        )?;
        self.validate_context(context)?;
        if request.contract_version != PROJECT_WORKSPACE_CONTRACT_VERSION {
            return Err(invalid("unsupported Project Workspace contract version"));
        }
        let Some(readers) = &self.readers else {
            return Err(unavailable("Project Workspace Module has no durable store"));
        };
        let profile_id = self.profile_id.clone();
        let library_id = self.library_id.clone();
        let context = context.clone();
        readers
            .read_default(move |connection| {
                let transaction = connection.unchecked_transaction()?;
                let context = crate::infrastructure::actors::bind(&transaction, &context)?;
                let identity = transaction
                    .query_row(
                        "SELECT 1 FROM libraries WHERE id = ?1 AND profile_id = ?2",
                        rusqlite::params![library_id, profile_id],
                        |_| Ok(()),
                    )
                    .optional()?;
                if identity.is_none() {
                    return Err(StoreError::new(
                        StoreErrorCode::Unauthorized,
                        "bound Project Workspace identity is not present in this Profile store",
                        false,
                    ));
                }
                let store_epoch = transaction
                    .query_row(
                        "SELECT store_epoch FROM block_store_metadata WHERE id = 1",
                        [],
                        |row| row.get::<_, String>(0),
                    )
                    .optional()?
                    .ok_or_else(|| corrupt("Profile store epoch is unavailable"))?;
                let commit_seq = crate::infrastructure::local_commit::head(&transaction)?;
                Ok(ModuleReadSnapshot {
                    contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                    store_epoch: StoreEpoch(store_epoch),
                    commit_head: commit_seq,
                    value: read::read(
                        &transaction,
                        &context,
                        &library_id,
                        commit_seq,
                        request.read,
                    )?,
                })
            })
            .map_err(core_error)
    }

    pub fn apply(
        &self,
        context: &BoundModuleContext,
        request: ModuleApplyRequest<ProjectWorkspaceIntent>,
    ) -> Result<ProjectWorkspaceApplyOutcome, CoreError> {
        nodex_core_contracts::remote_admission::authorize(
            context,
            "workspace_apply",
            &request.intent,
        )?;
        self.validate_context(context)?;
        if request.contract_version != PROJECT_WORKSPACE_CONTRACT_VERSION {
            return Err(invalid("unsupported Project Workspace contract version"));
        }
        let Some(writer) = &self.writer else {
            return Err(unavailable("Project Workspace Module has no durable store"));
        };
        let should_collect_blobs = matches!(
            &request.intent,
            ProjectWorkspaceIntent::DeleteThread { .. }
                | ProjectWorkspaceIntent::ReconcileAppServerThreadSweep { .. }
        );
        let assets_root = self
            .assets_root
            .as_deref()
            .expect("persistent Workspace has an assets root");
        let outcome = mutation::apply(
            writer,
            &self.profile_id,
            &self.library_id,
            context,
            request,
            assets_root,
        )
        .map_err(core_error)?;
        if should_collect_blobs {
            let assets_root = assets_root.to_path_buf();
            // Domain roots have committed. Physical collection is best-effort and
            // cannot turn an already committed mutation into a reported failure.
            let _ = writer.call(move |connection| {
                crate::infrastructure::managed_blob_gc::collect(connection, &assets_root, 512)
            });
        }
        Ok(outcome)
    }

    #[cfg(test)]
    pub(crate) fn seed_rootless_default_project_for_test(&self) {
        mutation::seed_rootless_default_project_for_test(
            self.writer.as_ref().expect("persistent Workspace writer"),
            &self.profile_id,
            &self.library_id,
            self.assets_root
                .as_deref()
                .expect("persistent Workspace assets root"),
        )
        .expect("seed rootless default Project");
    }

    fn validate_context(&self, context: &BoundModuleContext) -> Result<(), CoreError> {
        if context.profile_id.0 == self.profile_id && context.library_id.0 == self.library_id {
            return Ok(());
        }
        Err(CoreError {
            code: CoreErrorCode::Unauthorized,
            message: "bound Adapter identity does not match this Project Workspace Module"
                .to_owned(),
            retryable: false,
            recovery: CoreErrorRecovery::None,
        })
    }
}

impl Default for ProjectWorkspaceModule {
    fn default() -> Self {
        Self {
            profile_id: "probe-profile".to_owned(),
            library_id: "probe-library".to_owned(),
            readers: None,
            writer: None,
            assets_root: None,
        }
    }
}

fn core_error(error: StoreError) -> CoreError {
    let code = match error.code {
        StoreErrorCode::InvalidInput => CoreErrorCode::InvalidInput,
        StoreErrorCode::NotFound => CoreErrorCode::NotFound,
        StoreErrorCode::PatchNotFound => CoreErrorCode::PatchNotFound,
        StoreErrorCode::PatchAmbiguous => CoreErrorCode::PatchAmbiguous,
        StoreErrorCode::PatchOverlap => CoreErrorCode::PatchOverlap,
        StoreErrorCode::StoreCorrupt => CoreErrorCode::StoreCorrupt,
        StoreErrorCode::MaintenanceInProgress => CoreErrorCode::MaintenanceInProgress,
        StoreErrorCode::ResourceExhausted => CoreErrorCode::ResourceExhausted,
        StoreErrorCode::Unauthorized => CoreErrorCode::Unauthorized,
        StoreErrorCode::StaleStoreEpoch => CoreErrorCode::StaleStoreEpoch,
        StoreErrorCode::Conflict => CoreErrorCode::Conflict,
        StoreErrorCode::HeadConflict => CoreErrorCode::HeadConflict,
        StoreErrorCode::RevisionConflict => CoreErrorCode::RevisionConflict,
        StoreErrorCode::IdempotencyKeyReused => CoreErrorCode::IdempotencyKeyReused,
        StoreErrorCode::IdempotencyWindowExpired => CoreErrorCode::IdempotencyWindowExpired,
        StoreErrorCode::LegacyIdempotencyUnavailable => CoreErrorCode::LegacyIdempotencyUnavailable,
        StoreErrorCode::ProtectedOwnerDeletion => CoreErrorCode::ProtectedOwnerDeletion,
        StoreErrorCode::GenerationConflict => CoreErrorCode::GenerationConflict,
        StoreErrorCode::MissingDependencies => CoreErrorCode::DocumentUpdateMissingDependencies,
        StoreErrorCode::MaterializationStale => CoreErrorCode::MaterializationStale,
        StoreErrorCode::UnsupportedSchema
        | StoreErrorCode::AlreadyOwned
        | StoreErrorCode::InvalidProfile
        | StoreErrorCode::RuntimeIncompatible => CoreErrorCode::SchemaUnsupported,
        StoreErrorCode::WriterQueueFull | StoreErrorCode::ReaderPoolTimeout => {
            CoreErrorCode::Overloaded
        }
        StoreErrorCode::QueryCancelled => CoreErrorCode::Cancelled,
        StoreErrorCode::DeadlineExceeded => CoreErrorCode::DeadlineExceeded,
        StoreErrorCode::WriterClosed
        | StoreErrorCode::SqliteBusy
        | StoreErrorCode::SqliteFailure
        | StoreErrorCode::Internal => CoreErrorCode::CoreUnavailable,
    };
    CoreError {
        code,
        message: error.message,
        retryable: error.retryable,
        recovery: error.recovery.unwrap_or(CoreErrorRecovery::None),
    }
}

fn invalid(message: &str) -> CoreError {
    CoreError {
        code: CoreErrorCode::InvalidInput,
        message: message.to_owned(),
        retryable: false,
        recovery: CoreErrorRecovery::None,
    }
}

fn unavailable(message: &str) -> CoreError {
    CoreError {
        code: CoreErrorCode::CoreUnavailable,
        message: message.to_owned(),
        retryable: false,
        recovery: CoreErrorRecovery::None,
    }
}

fn corrupt(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message, false)
}

pub(crate) use inbox::scheduled::record_automation_changes;
