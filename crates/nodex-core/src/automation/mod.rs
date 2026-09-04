mod mutation;
mod occurrence;
mod occurrence_mutation;
pub(crate) use occurrence::{
    validate_recurrence_input, validate_reminders_input, validate_timezone_input,
};
pub(crate) use occurrence_mutation::refresh_scheduled_index;
mod read;
mod reminder;
mod run;
mod schedule;

use nodex_core_contracts::automation::{
    AutomationCommitValue, AutomationIntent, AutomationRead, AutomationReadValue, AutomationReceipt,
};
use nodex_core_contracts::{
    AUTOMATION_CONTRACT_VERSION, BoundModuleContext, CommittedCoreModuleEvent, CoreError,
    CoreErrorCode, CoreErrorRecovery, ModuleApplyRequest, ModuleReadRequest, ModuleReadSnapshot,
    StoreEpoch,
};
use rusqlite::OptionalExtension;
use std::path::PathBuf;

use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};
use crate::infrastructure::store::SqliteStoreKernel;
use crate::infrastructure::writer::{StoreReaders, StoreWriter};

#[derive(Clone, Debug)]
pub struct AutomationApplyOutcome {
    pub committed: crate::ModuleWriterResult<AutomationCommitValue, AutomationReceipt>,
    pub event: Option<CommittedCoreModuleEvent>,
}

pub struct AutomationModule {
    profile_id: String,
    library_id: String,
    readers: Option<StoreReaders>,
    writer: Option<StoreWriter>,
    assets_root: Option<PathBuf>,
}

impl AutomationModule {
    pub fn new(
        profile_id: impl Into<String>,
        library_id: impl Into<String>,
        kernel: &SqliteStoreKernel,
    ) -> Self {
        Self {
            profile_id: profile_id.into(),
            library_id: library_id.into(),
            readers: Some(kernel.readers()),
            writer: Some(kernel.writer()),
            assets_root: Some(
                kernel
                    .database_path()
                    .parent()
                    .expect("Profile database has a parent")
                    .join("assets"),
            ),
        }
    }

    pub fn read(
        &self,
        context: &BoundModuleContext,
        request: ModuleReadRequest<AutomationRead>,
    ) -> Result<ModuleReadSnapshot<AutomationReadValue>, CoreError> {
        self.validate_context(context)?;
        if request.contract_version != AUTOMATION_CONTRACT_VERSION {
            return Err(invalid("unsupported Automation contract version"));
        }
        let Some(readers) = &self.readers else {
            return Err(unavailable("Automation Module has no durable store"));
        };
        let profile_id = self.profile_id.clone();
        let library_id = self.library_id.clone();
        let context = context.clone();
        readers
            .read_default(move |connection| {
                let transaction = connection.unchecked_transaction()?;
                assert_identity(&transaction, &profile_id, &library_id)?;
                let store_epoch = transaction.query_row(
                    "SELECT metadata.store_epoch \
                     FROM block_store_metadata metadata WHERE metadata.id = 1",
                    [],
                    |row| row.get::<_, String>(0),
                )?;
                let commit_seq = crate::infrastructure::local_commit::head(&transaction)?;
                let snapshot = ModuleReadSnapshot {
                    contract_version: AUTOMATION_CONTRACT_VERSION,
                    store_epoch: StoreEpoch(store_epoch),
                    commit_head: commit_seq,
                    authorization: None,
                    value: read::read(
                        &transaction,
                        &library_id,
                        commit_seq,
                        &context,
                        request.read,
                    )?,
                };
                transaction.commit()?;
                Ok(snapshot)
            })
            .map_err(core_error)
    }

    pub fn apply(
        &self,
        context: &BoundModuleContext,
        request: ModuleApplyRequest<AutomationIntent>,
    ) -> Result<AutomationApplyOutcome, CoreError> {
        self.validate_context(context)?;
        if request.contract_version != AUTOMATION_CONTRACT_VERSION {
            return Err(invalid("unsupported Automation contract version"));
        }
        let Some(writer) = &self.writer else {
            return Err(unavailable("Automation Module has no durable store"));
        };
        let Some(assets_root) = &self.assets_root else {
            return Err(unavailable("Automation Module has no managed asset root"));
        };
        mutation::apply(
            writer,
            &self.profile_id,
            &self.library_id,
            context,
            request,
            assets_root,
        )
        .map_err(core_error)
    }

    pub fn has_due_background_work(&self, now_ms: i64) -> Result<bool, CoreError> {
        if now_ms < 0 {
            return Err(invalid("Automation idle-check time is invalid"));
        }
        let Some(readers) = &self.readers else {
            return Err(unavailable("Automation Module has no durable store"));
        };
        let profile_id = self.profile_id.clone();
        let library_id = self.library_id.clone();
        readers
            .read_default(move |connection| {
                assert_identity(connection, &profile_id, &library_id)?;
                let now_iso = occurrence::timestamp_to_iso(now_ms)?;
                connection
                    .query_row(
                        "SELECT EXISTS( \
                           SELECT 1 FROM codex_scheduled_automations \
                             WHERE status = 'ACTIVE' AND next_run_at IS NOT NULL \
                               AND next_run_at <= ?1 \
                           UNION ALL \
                           SELECT 1 FROM core_automation_leases \
                             WHERE status = 'claimed' AND expires_at_ms > ?1 \
                           UNION ALL \
                           SELECT 1 FROM core_reminder_leases \
                             WHERE status = 'claimed' AND expires_at_ms > ?1 \
                           UNION ALL \
                           SELECT 1 FROM reminder_snoozes \
                             WHERE consumed_at IS NULL AND due_at <= ?2 \
                           LIMIT 1)",
                        rusqlite::params![now_ms, now_iso],
                        |row| row.get::<_, bool>(0),
                    )
                    .map_err(Into::into)
            })
            .map_err(core_error)
    }

    fn validate_context(&self, context: &BoundModuleContext) -> Result<(), CoreError> {
        if context.profile_id.0 == self.profile_id && context.library_id.0 == self.library_id {
            return Ok(());
        }
        Err(CoreError {
            code: CoreErrorCode::Unauthorized,
            message: "bound Adapter identity does not match this Automation Module".to_owned(),
            retryable: false,
            recovery: CoreErrorRecovery::None,
        })
    }
}

impl Default for AutomationModule {
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

fn assert_identity(
    connection: &rusqlite::Connection,
    profile_id: &str,
    library_id: &str,
) -> Result<(), StoreError> {
    let identity = connection
        .query_row(
            "SELECT 1 FROM libraries WHERE id = ?1 AND profile_id = ?2",
            rusqlite::params![library_id, profile_id],
            |_| Ok(()),
        )
        .optional()?;
    if identity.is_some() {
        return Ok(());
    }
    Err(StoreError::new(
        StoreErrorCode::Unauthorized,
        "bound Automation identity is not present in this Profile store",
        false,
    ))
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
