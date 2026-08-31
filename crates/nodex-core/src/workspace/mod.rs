mod child_thread_window;
mod execution;
mod managed_worktree_lifecycle;
mod managed_worktree_window;
mod mutation;
mod page_chat;
mod project_activity_summary;
mod project_window;
pub(crate) mod queued_follow_up;
mod read;
mod session_lifecycle;
mod session_mutation;
mod sidebar;
mod sidebar_section;
mod subagent_projection;
mod task_window;
#[cfg(test)]
mod test_support;
mod thread;

pub(crate) use execution::validate_persisted_turn_authority;

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
        let _ = writer
            .call(move |connection| queued_follow_up::sweep_manifest_gc(connection, &sweep_root));
        Ok(Self {
            profile_id: profile_id.into(),
            library_id: library_id.into(),
            readers: Some(kernel.readers()),
            writer: Some(writer),
            assets_root: Some(assets_root),
        })
    }

    pub fn read(
        &self,
        context: &BoundModuleContext,
        request: ModuleReadRequest<ProjectWorkspaceRead>,
    ) -> Result<ModuleReadSnapshot<ProjectWorkspaceReadValue>, CoreError> {
        self.validate_context(context)?;
        if request.contract_version != PROJECT_WORKSPACE_CONTRACT_VERSION {
            return Err(invalid("unsupported Project Workspace contract version"));
        }
        let Some(readers) = &self.readers else {
            return Err(unavailable("Project Workspace Module has no durable store"));
        };
        let profile_id = self.profile_id.clone();
        let library_id = self.library_id.clone();
        let assets_root = self
            .assets_root
            .clone()
            .ok_or_else(|| unavailable("Project Workspace Module has no durable asset store"))?;
        readers
            .read_default(move |connection| {
                let transaction = connection.unchecked_transaction()?;
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
                    authorization: None,
                    value: read::read(
                        &transaction,
                        &library_id,
                        commit_seq,
                        &assets_root,
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
        self.validate_context(context)?;
        if request.contract_version != PROJECT_WORKSPACE_CONTRACT_VERSION {
            return Err(invalid("unsupported Project Workspace contract version"));
        }
        let Some(writer) = &self.writer else {
            return Err(unavailable("Project Workspace Module has no durable store"));
        };
        let should_sweep_queue_manifests = matches!(
            &request.intent,
            ProjectWorkspaceIntent::CommitQueuedFollowUpLedger { .. }
                | ProjectWorkspaceIntent::DeleteThread { .. }
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
        if should_sweep_queue_manifests {
            let assets_root = assets_root.to_path_buf();
            // The durable tombstone is the ownership boundary. Sweeping is best-effort so an
            // already-committed queue mutation is never reported as failed because unlinking a
            // private manifest was temporarily unavailable.
            let _ = writer.call(move |connection| {
                queued_follow_up::sweep_manifest_gc(connection, &assets_root)
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
        recovery: CoreErrorRecovery::None,
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
