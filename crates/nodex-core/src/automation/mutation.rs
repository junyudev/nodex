use std::collections::BTreeSet;
use std::path::{Component, Path, PathBuf};

use nodex_core_contracts::agent::AgentBackendBinding;
use nodex_core_contracts::automation::{
    AutomationCommitValue, AutomationDefinition, AutomationDefinitionInput,
    AutomationDefinitionKind, AutomationDefinitionStatus, AutomationDueWorkPlan, AutomationEvent,
    AutomationEventKind, AutomationExecutionEnvironment, AutomationIntent, AutomationLease,
    AutomationLeaseStatus, AutomationReceipt, AutomationRun, AutomationRunBulkResult,
    PageOccurrenceMutationResult, ReminderLease, ReminderSnooze,
};
use nodex_core_contracts::{
    AdapterKind, BoundModuleContext, CoreModuleEventPayload, ModuleApplyRequest,
    ModuleMutationReceipt, ModuleName, StoreEpoch,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::document::sha256;
use crate::domain::agent_backend::binding_storage;
use crate::infrastructure::durable_mutation::{
    self, CommitResult, DurableMutationScope, OperationIdentity, ReceiptMetadata, SealedOutcome,
};
use crate::infrastructure::event_log::{
    NewChangeLogEntry, append_change_log, load_committed_event_by_sequence,
};
use crate::infrastructure::module_receipts::read_module_receipt;
use crate::infrastructure::projection_impact::{expand_database_coordinates, impact_for_payload};
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode, with_immediate_transaction};
use crate::infrastructure::writer::StoreWriter;

use super::read::{environment_string, kind_string, read_definition, read_lease, status_string};
use super::schedule::{ScheduleError, next_run_at, normalize_rrule};
use super::{AutomationApplyOutcome, assert_identity};

const MODULE_NAME: &str = "automation";
const MAX_ID_LENGTH: usize = 512;
const MAX_NAME_CHARS: usize = 256;
const MAX_PROMPT_BYTES: usize = 1024 * 1024;
const MAX_CWDS: usize = 128;
const MAX_PATH_BYTES: usize = 16 * 1024;
const MAX_MODEL_BYTES: usize = 512;
const MAX_REASONING_EFFORT_BYTES: usize = 64;
const MAX_REASON_CODE_BYTES: usize = 128;
const MAX_CLAIM_LIMIT: u32 = 100;
const MAX_ACTIVE_DEFINITIONS: usize = 200;
const MIN_LEASE_DURATION_MS: u64 = 1_000;
const MAX_LEASE_DURATION_MS: u64 = 24 * 60 * 60 * 1_000;
const MAX_RETRY_DELAY_MS: u64 = 7 * 24 * 60 * 60 * 1_000;

struct NormalizedDefinition {
    kind: AutomationDefinitionKind,
    target_thread_id: Option<String>,
    name: String,
    prompt: String,
    rrule: String,
    model: Option<String>,
    reasoning_effort: Option<String>,
    service_tier: Option<String>,
    backend_binding: AgentBackendBinding,
    cwds: Vec<String>,
    execution_environment: AutomationExecutionEnvironment,
    local_environment_config_path: Option<String>,
}

struct MutationEffects {
    operation_kind: &'static str,
    automation_ids: Vec<String>,
    definitions: Vec<AutomationDefinition>,
    claimed_leases: Vec<AutomationLease>,
    lease_ids: Vec<String>,
    runs: Vec<AutomationRun>,
    deleted_run_ids: Vec<String>,
    run_ids: Vec<String>,
    run_bulk: Option<AutomationRunBulkResult>,
    reminder_leases: Vec<ReminderLease>,
    reminder_snoozes: Vec<ReminderSnooze>,
    reminder_lease_ids: Vec<String>,
    snooze_ids: Vec<i64>,
    page_occurrence_mutation: Option<PageOccurrenceMutationResult>,
    page_ids: Vec<String>,
    document_ids: Vec<String>,
    database_ids: Vec<String>,
    committed_at: String,
}

impl MutationEffects {
    fn is_empty_scheduler_claim(&self) -> bool {
        matches!(self.operation_kind, "claim_due" | "claim_due_reminders")
            && self.automation_ids.is_empty()
            && self.definitions.is_empty()
            && self.claimed_leases.is_empty()
            && self.lease_ids.is_empty()
            && self.reminder_leases.is_empty()
            && self.reminder_snoozes.is_empty()
            && self.reminder_lease_ids.is_empty()
            && self.snooze_ids.is_empty()
    }
}

pub(super) fn plan_definition_due_work(
    connection: &Connection,
) -> Result<AutomationDueWorkPlan, StoreError> {
    let now_ms = connection.query_row(
        "SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER)",
        [],
        |row| row.get::<_, i64>(0),
    )?;
    let candidate = connection
        .query_row(
            "SELECT definition.automation_id, definition.next_run_at, \
                    MAX(definition.next_run_at, COALESCE((\
                      SELECT MAX(lease.expires_at_ms) FROM core_automation_leases lease \
                      WHERE lease.automation_id = definition.automation_id \
                        AND lease.scheduled_for_ms = definition.next_run_at \
                        AND lease.status = 'claimed'\
                    ), definition.next_run_at)) AS eligible_at \
             FROM codex_scheduled_automations definition \
             WHERE definition.status = 'ACTIVE' AND definition.next_run_at IS NOT NULL \
             ORDER BY eligible_at, definition.automation_id LIMIT 1",
            [],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            },
        )
        .optional()?;
    let Some((automation_id, scheduled_for_ms, eligible_at_ms)) = candidate else {
        return Ok(AutomationDueWorkPlan {
            due_now: false,
            next_wake_at_ms: None,
            work_token: None,
        });
    };
    let due_now = eligible_at_ms <= now_ms;
    let work_token = due_now.then(|| {
        format!(
            "automation-due:{:x}",
            Sha256::digest(
                format!("definitions:{automation_id}:{scheduled_for_ms}:{eligible_at_ms}")
                    .as_bytes()
            )
        )
    });
    Ok(AutomationDueWorkPlan {
        due_now,
        next_wake_at_ms: Some(eligible_at_ms),
        work_token,
    })
}

fn validate_definition_work_token(
    connection: &Connection,
    work_token: &str,
) -> Result<(), StoreError> {
    let current = plan_definition_due_work(connection)?;
    if current.due_now && current.work_token.as_deref() == Some(work_token) {
        return Ok(());
    }
    Err(StoreError::new(
        StoreErrorCode::Conflict,
        "Automation due-work token is stale; plan due work again",
        true,
    ))
}

pub(super) fn apply(
    writer: &StoreWriter,
    profile_id: &str,
    library_id: &str,
    context: &BoundModuleContext,
    request: ModuleApplyRequest<AutomationIntent>,
    assets_root: &Path,
) -> Result<AutomationApplyOutcome, StoreError> {
    let profile_id = profile_id.to_owned();
    let library_id = library_id.to_owned();
    let context = context.clone();
    let assets_root = assets_root.to_path_buf();
    writer.call(move |connection| {
        let result = with_immediate_transaction(connection, |transaction| {
            assert_identity(transaction, &profile_id, &library_id)?;
            let store_epoch = transaction
                .query_row(
                    "SELECT store_epoch FROM block_store_metadata WHERE id = 1",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
                .ok_or_else(|| corrupt("Profile store epoch is unavailable"))?;
            if request.store_epoch.0 != store_epoch {
                return Err(StoreError::new(
                    StoreErrorCode::StaleStoreEpoch,
                    "Automation mutation targets a stale store epoch",
                    true,
                ));
            }
            validate_id("operation_id", &request.operation_id)?;
            require_trusted_host(&context, &request.intent)?;
            let fingerprint = if is_page_occurrence_intent(&request.intent) {
                serde_json::to_vec(&(
                    &profile_id,
                    &library_id,
                    &context.project_id,
                    request.contract_version,
                    &request.store_epoch,
                    &request.intent,
                ))
            } else {
                serde_json::to_vec(&(
                    &context.profile_id,
                    &context.library_id,
                    &context.project_id,
                    &context.adapter,
                    request.contract_version,
                    &request.store_epoch,
                    &request.intent,
                ))
            }
            .map_err(|_| internal("Automation mutation cannot be fingerprinted"))?;
            let request_hash = sha256(&fingerprint);
            if let Some(stored) =
                read_module_receipt(transaction, MODULE_NAME, &request.operation_id)?
            {
                if stored.request_hash != request_hash {
                    return Err(StoreError::new(
                        StoreErrorCode::IdempotencyKeyReused,
                        "operation_id is already bound to another Automation intent",
                        false,
                    ));
                }
                let mut committed = serde_json::from_value::<
                    crate::ModuleWriterResult<AutomationCommitValue, AutomationReceipt>,
                >(stored.result)
                .map_err(|_| corrupt("Stored Automation receipt is invalid"))?;
                committed.receipt.mutation.duplicate = true;
                if let Some(result) = committed.value.page_occurrence_mutation.as_mut() {
                    result.duplicate = true;
                }
                return Ok(AutomationApplyOutcome {
                    committed,
                    event: None,
                });
            }

            match &request.intent {
                AutomationIntent::CreateDefinition {
                    automation_id,
                    definition,
                } => create_definition(
                    transaction,
                    &library_id,
                    &context,
                    &store_epoch,
                    &request.operation_id,
                    &request_hash,
                    automation_id,
                    definition,
                ),
                AutomationIntent::UpdateDefinition {
                    automation_id,
                    expected_revision,
                    status,
                    definition,
                } => update_definition(
                    transaction,
                    &library_id,
                    &context,
                    &store_epoch,
                    &request.operation_id,
                    &request_hash,
                    automation_id,
                    *expected_revision,
                    *status,
                    definition,
                ),
                AutomationIntent::DeleteDefinition {
                    automation_id,
                    expected_revision,
                } => delete_definition(
                    transaction,
                    &library_id,
                    &context,
                    &store_epoch,
                    &request.operation_id,
                    &request_hash,
                    automation_id,
                    *expected_revision,
                ),
                AutomationIntent::DispatchNow { automation_id } => dispatch_now(
                    transaction,
                    &library_id,
                    &context,
                    &store_epoch,
                    &request.operation_id,
                    &request_hash,
                    automation_id,
                ),
                AutomationIntent::RescheduleDefinition {
                    automation_id,
                    expected_revision,
                    not_before_ms,
                    retry_within_ms,
                } => reschedule_definition(
                    transaction,
                    &library_id,
                    &context,
                    &store_epoch,
                    &request.operation_id,
                    &request_hash,
                    automation_id,
                    *expected_revision,
                    *not_before_ms,
                    *retry_within_ms,
                ),
                AutomationIntent::ClaimDue {
                    work_token,
                    limit,
                    lease_duration_ms,
                } => {
                    validate_definition_work_token(transaction, work_token)?;
                    claim_due(
                        transaction,
                        &library_id,
                        &context,
                        &store_epoch,
                        &request.operation_id,
                        &request_hash,
                        *limit,
                        *lease_duration_ms,
                    )
                }
                AutomationIntent::CompleteLease { lease_id } => settle_lease(
                    transaction,
                    &library_id,
                    &context,
                    &store_epoch,
                    &request.operation_id,
                    &request_hash,
                    lease_id,
                    None,
                    None,
                ),
                AutomationIntent::FailLease {
                    lease_id,
                    retry_delay_ms,
                    reason_code,
                } => settle_lease(
                    transaction,
                    &library_id,
                    &context,
                    &store_epoch,
                    &request.operation_id,
                    &request_hash,
                    lease_id,
                    *retry_delay_ms,
                    Some(reason_code),
                ),
                intent @ (AutomationIntent::SnoozeReminder { .. }
                | AutomationIntent::ClaimDueReminders { .. }
                | AutomationIntent::CompleteReminderLease { .. }
                | AutomationIntent::FailReminderLease { .. }) => {
                    let effects = super::reminder::apply(
                        transaction,
                        &library_id,
                        &context,
                        &request.operation_id,
                        intent,
                    )?;
                    finish_mutation(
                        transaction,
                        &library_id,
                        &context,
                        &store_epoch,
                        &request.operation_id,
                        &request_hash,
                        MutationEffects {
                            operation_kind: effects.operation_kind,
                            automation_ids: Vec::new(),
                            definitions: Vec::new(),
                            claimed_leases: Vec::new(),
                            lease_ids: Vec::new(),
                            runs: Vec::new(),
                            deleted_run_ids: Vec::new(),
                            run_ids: Vec::new(),
                            run_bulk: None,
                            reminder_leases: effects.leases,
                            reminder_snoozes: effects.snoozes,
                            reminder_lease_ids: effects.lease_ids,
                            snooze_ids: effects.snooze_ids,
                            page_occurrence_mutation: None,
                            page_ids: Vec::new(),
                            document_ids: Vec::new(),
                            database_ids: Vec::new(),
                            committed_at: effects.committed_at,
                        },
                    )
                }
                intent @ (AutomationIntent::CompletePageOccurrence { .. }
                | AutomationIntent::SkipPageOccurrence { .. }
                | AutomationIntent::UpdatePageOccurrence { .. }) => {
                    let committed_at = sqlite_now(transaction)?;
                    let result = durable_mutation::run(
                        transaction,
                        OperationIdentity {
                            module: ModuleName::Automation,
                            module_name: MODULE_NAME,
                            operation_id: &request.operation_id,
                            intent_hash: &request_hash,
                            store_epoch: &store_epoch,
                            committed_at: &committed_at,
                            context: &context,
                        },
                        |scope| {
                            let effects = super::occurrence_mutation::apply(
                                super::occurrence_mutation::OccurrenceMutationInput {
                                    connection: transaction,
                                    commit_context: scope.evidence(),
                                    library_id: &library_id,
                                    context: &context,
                                    store_epoch: &store_epoch,
                                    operation_id: &request.operation_id,
                                    intent,
                                    assets_root: &assets_root,
                                    committed_at: &committed_at,
                                },
                            )?;
                            if !effects.result.success {
                                return seal_occurrence_rejection(
                                    scope,
                                    &request.operation_id,
                                    effects,
                                );
                            }
                            seal_mutation(
                                scope,
                                &library_id,
                                &context,
                                &request.operation_id,
                                MutationEffects {
                                    operation_kind: effects.operation_kind,
                                    automation_ids: Vec::new(),
                                    definitions: Vec::new(),
                                    claimed_leases: Vec::new(),
                                    lease_ids: Vec::new(),
                                    runs: Vec::new(),
                                    deleted_run_ids: Vec::new(),
                                    run_ids: Vec::new(),
                                    run_bulk: None,
                                    reminder_leases: Vec::new(),
                                    reminder_snoozes: Vec::new(),
                                    reminder_lease_ids: Vec::new(),
                                    snooze_ids: Vec::new(),
                                    page_occurrence_mutation: Some(effects.result),
                                    page_ids: effects.page_ids,
                                    document_ids: effects.document_ids,
                                    database_ids: effects.database_ids,
                                    committed_at: effects.committed_at,
                                },
                            )
                        },
                    )?;
                    automation_commit_result(transaction, result)
                }
                intent @ (AutomationIntent::BeginRun { .. }
                | AutomationIntent::ReplacePendingRunThread { .. }
                | AutomationIntent::SetRunThreadTitle { .. }
                | AutomationIntent::CompleteRunForReview { .. }
                | AutomationIntent::SetRunInboxItem { .. }
                | AutomationIntent::AcceptRun { .. }
                | AutomationIntent::SetRunReadState { .. }
                | AutomationIntent::MarkAllRunsRead
                | AutomationIntent::ArchiveRun { .. }
                | AutomationIntent::UnarchiveRun { .. }
                | AutomationIntent::DeleteRun { .. }
                | AutomationIntent::SettleInterruptedRuns) => {
                    let effects = super::run::apply(transaction, intent)?;
                    finish_mutation(
                        transaction,
                        &library_id,
                        &context,
                        &store_epoch,
                        &request.operation_id,
                        &request_hash,
                        MutationEffects {
                            operation_kind: effects.operation_kind,
                            automation_ids: effects.automation_ids,
                            definitions: Vec::new(),
                            claimed_leases: Vec::new(),
                            lease_ids: Vec::new(),
                            runs: effects.runs,
                            deleted_run_ids: effects.deleted_run_ids,
                            run_ids: effects.run_ids,
                            run_bulk: effects.bulk,
                            reminder_leases: Vec::new(),
                            reminder_snoozes: Vec::new(),
                            reminder_lease_ids: Vec::new(),
                            snooze_ids: Vec::new(),
                            page_occurrence_mutation: None,
                            page_ids: Vec::new(),
                            document_ids: Vec::new(),
                            database_ids: Vec::new(),
                            committed_at: effects.committed_at,
                        },
                    )
                }
            }
        });
        crate::database::finish_order_attempt(connection, result)
    })
}

#[allow(clippy::too_many_arguments)]
fn reschedule_definition(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    automation_id: &str,
    expected_revision: i64,
    not_before_ms: Option<i64>,
    retry_within_ms: Option<u64>,
) -> Result<AutomationApplyOutcome, StoreError> {
    validate_id("automation_id", automation_id)?;
    if not_before_ms.is_some_and(|value| value < 0) {
        return Err(invalid("Scheduled Automation not-before time is invalid"));
    }
    if retry_within_ms.is_some_and(|delay| delay > MAX_RETRY_DELAY_MS) {
        return Err(invalid("Automation retry delay exceeds its bound"));
    }
    if not_before_ms.is_some() && retry_within_ms.is_some() {
        return Err(invalid(
            "Scheduled Automation reschedule policy is ambiguous",
        ));
    }
    let definition = read_definition(connection, automation_id)?
        .ok_or_else(|| not_found("Scheduled Automation is unavailable"))?;
    if definition.status != AutomationDefinitionStatus::Active {
        return Err(conflict("Only an active Automation can be rescheduled"));
    }
    if definition.definition_revision != expected_revision {
        return Err(conflict("Scheduled Automation changed before rescheduling"));
    }
    let (now_ms, committed_at) = core_now(connection)?;
    let scheduled = scheduled_next_for_stored(connection, &definition, now_ms)?;
    let next_run_at_ms = if let Some(not_before_ms) = not_before_ms {
        Some(scheduled.map_or(not_before_ms, |next| next.max(not_before_ms)))
    } else if let Some(retry_within_ms) = retry_within_ms {
        let retry_at = now_ms
            .checked_add(
                i64::try_from(retry_within_ms)
                    .map_err(|_| invalid("Automation retry delay exceeds the timestamp range"))?,
            )
            .ok_or_else(|| invalid("Automation retry time exceeds the timestamp range"))?;
        Some(scheduled.map_or(retry_at, |next| next.min(retry_at)))
    } else {
        scheduled
    };
    let changed = connection.execute(
        "UPDATE codex_scheduled_automations SET next_run_at = ?1, updated_at = ?2, \
           definition_revision = definition_revision + 1 \
         WHERE automation_id = ?3 AND definition_revision = ?4 AND status != 'DELETED'",
        params![next_run_at_ms, now_ms, automation_id, expected_revision],
    )?;
    if changed != 1 {
        return Err(conflict("Scheduled Automation changed before rescheduling"));
    }
    let stored = read_definition(connection, automation_id)?
        .ok_or_else(|| corrupt("Rescheduled Automation is unavailable"))?;
    finish_mutation(
        connection,
        library_id,
        context,
        store_epoch,
        operation_id,
        request_hash,
        MutationEffects {
            operation_kind: "reschedule_definition",
            automation_ids: vec![automation_id.to_owned()],
            definitions: vec![stored],
            claimed_leases: Vec::new(),
            lease_ids: Vec::new(),
            runs: Vec::new(),
            deleted_run_ids: Vec::new(),
            run_ids: Vec::new(),
            run_bulk: None,
            reminder_leases: Vec::new(),
            reminder_snoozes: Vec::new(),
            reminder_lease_ids: Vec::new(),
            snooze_ids: Vec::new(),
            page_occurrence_mutation: None,
            page_ids: Vec::new(),
            document_ids: Vec::new(),
            database_ids: Vec::new(),
            committed_at,
        },
    )
}

#[allow(clippy::too_many_arguments)]
fn dispatch_now(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    automation_id: &str,
) -> Result<AutomationApplyOutcome, StoreError> {
    validate_id("automation_id", automation_id)?;
    let definition = read_definition(connection, automation_id)?
        .ok_or_else(|| not_found("Scheduled Automation is unavailable"))?;
    if definition.status == AutomationDefinitionStatus::Deleted {
        return Err(not_found("Scheduled Automation is unavailable"));
    }
    let (now_ms, committed_at) = core_now(connection)?;
    let next_run = if definition.status == AutomationDefinitionStatus::Active {
        scheduled_next_for_stored(connection, &definition, now_ms)?
    } else {
        definition.next_run_at_ms
    };
    connection.execute(
        "UPDATE codex_scheduled_automations SET next_run_at = ?1, last_run_at = ?2, \
           updated_at = ?2 WHERE automation_id = ?3 AND status != 'DELETED'",
        params![next_run, now_ms, automation_id],
    )?;
    let stored = read_definition(connection, automation_id)?
        .ok_or_else(|| corrupt("Dispatched Scheduled Automation is unavailable"))?;
    finish_mutation(
        connection,
        library_id,
        context,
        store_epoch,
        operation_id,
        request_hash,
        MutationEffects {
            operation_kind: "dispatch_now",
            automation_ids: vec![automation_id.to_owned()],
            definitions: vec![stored],
            claimed_leases: Vec::new(),
            lease_ids: Vec::new(),
            runs: Vec::new(),
            deleted_run_ids: Vec::new(),
            run_ids: Vec::new(),
            run_bulk: None,
            reminder_leases: Vec::new(),
            reminder_snoozes: Vec::new(),
            reminder_lease_ids: Vec::new(),
            snooze_ids: Vec::new(),
            page_occurrence_mutation: None,
            page_ids: Vec::new(),
            document_ids: Vec::new(),
            database_ids: Vec::new(),
            committed_at,
        },
    )
}

#[allow(clippy::too_many_arguments)]
fn create_definition(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    automation_id: &str,
    input: &AutomationDefinitionInput,
) -> Result<AutomationApplyOutcome, StoreError> {
    validate_id("automation_id", automation_id)?;
    if read_definition(connection, automation_id)?.is_some() {
        return Err(conflict("Scheduled Automation id already exists"));
    }
    require_active_definition_capacity(connection)?;
    let definition = normalize_definition(connection, input)?;
    require_unique_active_heartbeat(
        connection,
        automation_id,
        AutomationDefinitionStatus::Active,
        &definition,
    )?;
    let (now_ms, committed_at) = core_now(connection)?;
    let next_run = scheduled_next(connection, automation_id, &definition, now_ms)?;
    let cwds_json = serde_json::to_string(&definition.cwds)
        .map_err(|_| internal("Scheduled Automation cwd JSON cannot be encoded"))?;
    let backend = binding_storage(&definition.backend_binding)
        .map_err(|_| internal("Normalized Agent backend binding is invalid"))?;
    connection.execute(
        "INSERT INTO codex_scheduled_automations(\
           automation_id, kind, status, target_thread_id, name, prompt, rrule, model, \
           reasoning_effort, service_tier, cwds_json, agent_backend_kind, \
           agent_backend_definition_id, agent_backend_instance_config_id, \
           execution_environment, local_environment_config_path, next_run_at, last_run_at, \
           created_at, updated_at, definition_revision\
         ) VALUES (?1, ?2, 'ACTIVE', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, \
           ?13, ?14, ?15, ?16, NULL, ?17, ?17, 1)",
        params![
            automation_id,
            kind_string(definition.kind),
            definition.target_thread_id,
            definition.name,
            definition.prompt,
            definition.rrule,
            definition.model,
            definition.reasoning_effort,
            definition.service_tier,
            cwds_json,
            backend.kind,
            backend.agent_definition_id,
            backend.instance_config_id,
            environment_string(definition.execution_environment),
            definition.local_environment_config_path,
            next_run,
            now_ms,
        ],
    )?;
    let stored = read_definition(connection, automation_id)?
        .ok_or_else(|| corrupt("Created Scheduled Automation is unavailable"))?;
    finish_mutation(
        connection,
        library_id,
        context,
        store_epoch,
        operation_id,
        request_hash,
        MutationEffects {
            operation_kind: "create_definition",
            automation_ids: vec![automation_id.to_owned()],
            definitions: vec![stored],
            claimed_leases: Vec::new(),
            lease_ids: Vec::new(),
            runs: Vec::new(),
            deleted_run_ids: Vec::new(),
            run_ids: Vec::new(),
            run_bulk: None,
            reminder_leases: Vec::new(),
            reminder_snoozes: Vec::new(),
            reminder_lease_ids: Vec::new(),
            snooze_ids: Vec::new(),
            page_occurrence_mutation: None,
            page_ids: Vec::new(),
            document_ids: Vec::new(),
            database_ids: Vec::new(),
            committed_at,
        },
    )
}

#[allow(clippy::too_many_arguments)]
fn update_definition(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    automation_id: &str,
    expected_revision: i64,
    status: AutomationDefinitionStatus,
    input: &AutomationDefinitionInput,
) -> Result<AutomationApplyOutcome, StoreError> {
    validate_id("automation_id", automation_id)?;
    if expected_revision < 1 {
        return Err(invalid("expected_revision must be positive"));
    }
    if status == AutomationDefinitionStatus::Deleted {
        return Err(invalid("DeleteDefinition owns the DELETED transition"));
    }
    let current = read_definition(connection, automation_id)?
        .ok_or_else(|| not_found("Scheduled Automation is unavailable"))?;
    if current.definition_revision != expected_revision {
        return Err(StoreError::new(
            StoreErrorCode::RevisionConflict,
            "Scheduled Automation definition revision changed",
            true,
        ));
    }
    if current.status == AutomationDefinitionStatus::Deleted {
        require_active_definition_capacity(connection)?;
    }
    let definition = normalize_definition(connection, input)?;
    require_unique_active_heartbeat(connection, automation_id, status, &definition)?;
    let (now_ms, committed_at) = core_now(connection)?;
    let schedule_changed = current.kind != definition.kind
        || current.rrule != definition.rrule
        || current.status != status;
    let next_run = if status == AutomationDefinitionStatus::Active {
        if schedule_changed || current.next_run_at_ms.is_none() {
            scheduled_next(connection, automation_id, &definition, now_ms)?
        } else {
            current.next_run_at_ms
        }
    } else {
        None
    };
    let cwds_json = serde_json::to_string(&definition.cwds)
        .map_err(|_| internal("Scheduled Automation cwd JSON cannot be encoded"))?;
    let backend = binding_storage(&definition.backend_binding)
        .map_err(|_| internal("Normalized Agent backend binding is invalid"))?;
    let changed = connection.execute(
        "UPDATE codex_scheduled_automations SET \
           kind = ?1, status = ?2, target_thread_id = ?3, name = ?4, prompt = ?5, rrule = ?6, \
           model = ?7, reasoning_effort = ?8, service_tier = ?9, cwds_json = ?10, \
           agent_backend_kind = ?11, agent_backend_definition_id = ?12, \
           agent_backend_instance_config_id = ?13, execution_environment = ?14, \
           local_environment_config_path = ?15, next_run_at = ?16, updated_at = ?17, \
           definition_revision = definition_revision + 1 \
         WHERE automation_id = ?18 AND definition_revision = ?19",
        params![
            kind_string(definition.kind),
            status_string(status),
            definition.target_thread_id,
            definition.name,
            definition.prompt,
            definition.rrule,
            definition.model,
            definition.reasoning_effort,
            definition.service_tier,
            cwds_json,
            backend.kind,
            backend.agent_definition_id,
            backend.instance_config_id,
            environment_string(definition.execution_environment),
            definition.local_environment_config_path,
            next_run,
            now_ms,
            automation_id,
            expected_revision,
        ],
    )?;
    if changed != 1 {
        return Err(conflict(
            "Scheduled Automation definition changed concurrently",
        ));
    }
    let lease_ids = if status == AutomationDefinitionStatus::Paused {
        cancel_claimed_leases(connection, automation_id, now_ms, "definition_paused")?
    } else {
        Vec::new()
    };
    let stored = read_definition(connection, automation_id)?
        .ok_or_else(|| corrupt("Updated Scheduled Automation is unavailable"))?;
    finish_mutation(
        connection,
        library_id,
        context,
        store_epoch,
        operation_id,
        request_hash,
        MutationEffects {
            operation_kind: "update_definition",
            automation_ids: vec![automation_id.to_owned()],
            definitions: vec![stored],
            claimed_leases: Vec::new(),
            lease_ids,
            runs: Vec::new(),
            deleted_run_ids: Vec::new(),
            run_ids: Vec::new(),
            run_bulk: None,
            reminder_leases: Vec::new(),
            reminder_snoozes: Vec::new(),
            reminder_lease_ids: Vec::new(),
            snooze_ids: Vec::new(),
            page_occurrence_mutation: None,
            page_ids: Vec::new(),
            document_ids: Vec::new(),
            database_ids: Vec::new(),
            committed_at,
        },
    )
}

#[allow(clippy::too_many_arguments)]
fn delete_definition(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    automation_id: &str,
    expected_revision: i64,
) -> Result<AutomationApplyOutcome, StoreError> {
    validate_id("automation_id", automation_id)?;
    if expected_revision < 1 {
        return Err(invalid("expected_revision must be positive"));
    }
    let current = read_definition(connection, automation_id)?
        .ok_or_else(|| not_found("Scheduled Automation is unavailable"))?;
    if current.definition_revision != expected_revision {
        return Err(StoreError::new(
            StoreErrorCode::RevisionConflict,
            "Scheduled Automation definition revision changed",
            true,
        ));
    }
    let (now_ms, committed_at) = core_now(connection)?;
    connection.execute(
        "UPDATE codex_scheduled_automations SET status = 'DELETED', next_run_at = NULL, \
           updated_at = ?1, definition_revision = definition_revision + 1 \
         WHERE automation_id = ?2 AND definition_revision = ?3",
        params![now_ms, automation_id, expected_revision],
    )?;
    let lease_ids = cancel_claimed_leases(connection, automation_id, now_ms, "definition_deleted")?;
    let deleted_run_ids = super::run::delete_for_automation(connection, automation_id)?;
    let stored = read_definition(connection, automation_id)?
        .ok_or_else(|| corrupt("Deleted Scheduled Automation is unavailable"))?;
    finish_mutation(
        connection,
        library_id,
        context,
        store_epoch,
        operation_id,
        request_hash,
        MutationEffects {
            operation_kind: "delete_definition",
            automation_ids: vec![automation_id.to_owned()],
            definitions: vec![stored],
            claimed_leases: Vec::new(),
            lease_ids,
            runs: Vec::new(),
            run_ids: deleted_run_ids.clone(),
            deleted_run_ids,
            run_bulk: None,
            reminder_leases: Vec::new(),
            reminder_snoozes: Vec::new(),
            reminder_lease_ids: Vec::new(),
            snooze_ids: Vec::new(),
            page_occurrence_mutation: None,
            page_ids: Vec::new(),
            document_ids: Vec::new(),
            database_ids: Vec::new(),
            committed_at,
        },
    )
}

#[allow(clippy::too_many_arguments)]
fn claim_due(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    limit: u32,
    lease_duration_ms: u64,
) -> Result<AutomationApplyOutcome, StoreError> {
    if !(1..=MAX_CLAIM_LIMIT).contains(&limit) {
        return Err(invalid("Automation claim limit is invalid"));
    }
    if !(MIN_LEASE_DURATION_MS..=MAX_LEASE_DURATION_MS).contains(&lease_duration_ms) {
        return Err(invalid("Automation lease duration is invalid"));
    }
    let (now_ms, committed_at) = core_now(connection)?;
    let expires_at_ms = now_ms
        .checked_add(
            i64::try_from(lease_duration_ms)
                .map_err(|_| invalid("Automation lease duration exceeds the timestamp range"))?,
        )
        .ok_or_else(|| invalid("Automation lease expiry exceeds the timestamp range"))?;
    let due = {
        let mut statement = connection.prepare(
            "SELECT automation_id, next_run_at FROM codex_scheduled_automations \
             WHERE status = 'ACTIVE' AND next_run_at IS NOT NULL AND next_run_at <= ?1 \
             ORDER BY next_run_at, automation_id LIMIT ?2",
        )?;
        statement
            .query_map(params![now_ms, limit], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };
    let mut leases = Vec::new();
    let mut affected_lease_ids = Vec::new();
    for (automation_id, scheduled_for_ms) in due {
        let expired_ids = {
            let mut statement = connection.prepare(
                "SELECT lease_id FROM core_automation_leases \
                 WHERE automation_id = ?1 AND scheduled_for_ms = ?2 AND status = 'claimed' \
                   AND expires_at_ms <= ?3 ORDER BY lease_id",
            )?;
            statement
                .query_map(params![automation_id, scheduled_for_ms, now_ms], |row| {
                    row.get::<_, String>(0)
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?
        };
        connection.execute(
            "UPDATE core_automation_leases SET status = 'failed', settled_at_ms = ?1, \
               retry_at_ms = ?1, reason_code = 'lease_expired' \
             WHERE automation_id = ?2 AND scheduled_for_ms = ?3 AND status = 'claimed' \
               AND expires_at_ms <= ?1",
            params![now_ms, automation_id, scheduled_for_ms],
        )?;
        affected_lease_ids.extend(expired_ids);
        let active = connection
            .query_row(
                "SELECT 1 FROM core_automation_leases \
                 WHERE automation_id = ?1 AND scheduled_for_ms = ?2 AND status = 'claimed'",
                params![automation_id, scheduled_for_ms],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        if active {
            continue;
        }
        let attempt: i64 = connection.query_row(
            "SELECT COALESCE(max(attempt), 0) + 1 FROM core_automation_leases \
             WHERE automation_id = ?1 AND scheduled_for_ms = ?2",
            params![automation_id, scheduled_for_ms],
            |row| row.get(0),
        )?;
        let attempt_u32 = u32::try_from(attempt)
            .map_err(|_| corrupt("Automation lease attempt exceeds its bound"))?;
        let lease_id = lease_id(operation_id, &automation_id, scheduled_for_ms, attempt_u32);
        connection.execute(
            "INSERT INTO core_automation_leases(\
               lease_id, automation_id, scheduled_for_ms, attempt, status, claimed_at_ms, \
               expires_at_ms, settled_at_ms, retry_at_ms, reason_code\
             ) VALUES (?1, ?2, ?3, ?4, 'claimed', ?5, ?6, NULL, NULL, NULL)",
            params![
                lease_id,
                automation_id,
                scheduled_for_ms,
                attempt,
                now_ms,
                expires_at_ms,
            ],
        )?;
        leases.push(
            read_lease(connection, &lease_id)?
                .ok_or_else(|| corrupt("Claimed Automation lease is unavailable"))?,
        );
        affected_lease_ids.push(lease_id);
    }
    let mut automation_ids = leases
        .iter()
        .map(|lease| lease.automation_id.clone())
        .collect::<Vec<_>>();
    automation_ids.sort();
    automation_ids.dedup();
    let definitions = automation_ids
        .iter()
        .map(|id| {
            read_definition(connection, id)?
                .ok_or_else(|| corrupt("Claimed Automation definition is unavailable"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    affected_lease_ids.sort();
    affected_lease_ids.dedup();
    finish_mutation(
        connection,
        library_id,
        context,
        store_epoch,
        operation_id,
        request_hash,
        MutationEffects {
            operation_kind: "claim_due",
            automation_ids,
            definitions,
            claimed_leases: leases,
            lease_ids: affected_lease_ids,
            runs: Vec::new(),
            deleted_run_ids: Vec::new(),
            run_ids: Vec::new(),
            run_bulk: None,
            reminder_leases: Vec::new(),
            reminder_snoozes: Vec::new(),
            reminder_lease_ids: Vec::new(),
            snooze_ids: Vec::new(),
            page_occurrence_mutation: None,
            page_ids: Vec::new(),
            document_ids: Vec::new(),
            database_ids: Vec::new(),
            committed_at,
        },
    )
}

#[allow(clippy::too_many_arguments)]
fn settle_lease(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    lease_id: &str,
    retry_delay_ms: Option<u64>,
    reason_code: Option<&String>,
) -> Result<AutomationApplyOutcome, StoreError> {
    validate_id("lease_id", lease_id)?;
    let reason_code = reason_code
        .map(|value| normalize_reason_code(value))
        .transpose()?;
    if retry_delay_ms.is_some_and(|delay| delay > MAX_RETRY_DELAY_MS) {
        return Err(invalid("Automation retry delay exceeds its bound"));
    }
    let (now_ms, committed_at) = core_now(connection)?;
    let lease = read_lease(connection, lease_id)?
        .ok_or_else(|| not_found("Automation lease is unavailable"))?;
    if lease.status != AutomationLeaseStatus::Claimed {
        return Err(conflict("Automation lease is already settled"));
    }
    if lease.expires_at_ms <= now_ms {
        return Err(conflict("Automation lease expired before settlement"));
    }
    let definition = read_definition(connection, &lease.automation_id)?
        .ok_or_else(|| corrupt("Automation lease definition is unavailable"))?;
    let failed = reason_code.is_some();
    let retry_at_ms =
        retry_delay_ms
            .map(|delay| {
                now_ms
                    .checked_add(i64::try_from(delay).map_err(|_| {
                        invalid("Automation retry delay exceeds the timestamp range")
                    })?)
                    .ok_or_else(|| invalid("Automation retry time exceeds the timestamp range"))
            })
            .transpose()?;
    connection.execute(
        "UPDATE core_automation_leases SET status = ?1, settled_at_ms = ?2, retry_at_ms = ?3, \
           reason_code = ?4 WHERE lease_id = ?5 AND status = 'claimed'",
        params![
            if failed { "failed" } else { "completed" },
            now_ms,
            retry_at_ms,
            reason_code,
            lease_id,
        ],
    )?;
    let next_scheduled = if definition.status == AutomationDefinitionStatus::Active {
        scheduled_next_for_stored(connection, &definition, now_ms)?
    } else {
        None
    };
    let next_run = if failed {
        match (retry_at_ms, next_scheduled) {
            (Some(retry), Some(scheduled)) => Some(retry.min(scheduled)),
            (Some(retry), None) => Some(retry),
            (None, scheduled) => scheduled,
        }
    } else {
        next_scheduled
    };
    connection.execute(
        "UPDATE codex_scheduled_automations SET next_run_at = ?1, \
           last_run_at = CASE WHEN ?2 THEN last_run_at ELSE ?3 END, updated_at = ?3 \
         WHERE automation_id = ?4",
        params![next_run, failed, now_ms, lease.automation_id],
    )?;
    let stored = read_definition(connection, &lease.automation_id)?
        .ok_or_else(|| corrupt("Settled Automation definition is unavailable"))?;
    finish_mutation(
        connection,
        library_id,
        context,
        store_epoch,
        operation_id,
        request_hash,
        MutationEffects {
            operation_kind: if failed {
                "fail_lease"
            } else {
                "complete_lease"
            },
            automation_ids: vec![lease.automation_id],
            definitions: vec![stored],
            claimed_leases: Vec::new(),
            lease_ids: vec![lease_id.to_owned()],
            runs: Vec::new(),
            deleted_run_ids: Vec::new(),
            run_ids: Vec::new(),
            run_bulk: None,
            reminder_leases: Vec::new(),
            reminder_snoozes: Vec::new(),
            reminder_lease_ids: Vec::new(),
            snooze_ids: Vec::new(),
            page_occurrence_mutation: None,
            page_ids: Vec::new(),
            document_ids: Vec::new(),
            database_ids: Vec::new(),
            committed_at,
        },
    )
}

#[allow(clippy::too_many_arguments)]
fn finish_mutation(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    effects: MutationEffects,
) -> Result<AutomationApplyOutcome, StoreError> {
    let committed_at = effects.committed_at.clone();
    let result = durable_mutation::run(
        connection,
        OperationIdentity {
            module: ModuleName::Automation,
            module_name: MODULE_NAME,
            operation_id,
            intent_hash: request_hash,
            store_epoch,
            committed_at: &committed_at,
            context,
        },
        |scope| seal_mutation(scope, library_id, context, operation_id, effects),
    )?;
    automation_commit_result(connection, result)
}

fn automation_commit_result(
    connection: &Connection,
    result: CommitResult<crate::ModuleWriterResult<AutomationCommitValue, AutomationReceipt>>,
) -> Result<AutomationApplyOutcome, StoreError> {
    result.verify_manifest_identity(|committed| {
        (committed.commit_seq, committed.store_epoch.0.clone())
    })?;
    match result {
        CommitResult::Committed {
            outcome: committed, ..
        } => {
            let event = load_committed_event_by_sequence(connection, committed.event_sequence)?;
            Ok(AutomationApplyOutcome {
                committed,
                event: Some(event),
            })
        }
        CommitResult::NoOp { outcome: committed } => Ok(AutomationApplyOutcome {
            committed,
            event: None,
        }),
        CommitResult::IdempotentReplay {
            outcome: mut committed,
            ..
        } => {
            committed.receipt.mutation.duplicate = true;
            if let Some(result) = committed.value.page_occurrence_mutation.as_mut() {
                result.duplicate = true;
            }
            Ok(AutomationApplyOutcome {
                committed,
                event: None,
            })
        }
    }
}

fn seal_mutation(
    scope: &DurableMutationScope<'_>,
    library_id: &str,
    context: &BoundModuleContext,
    operation_id: &str,
    mut effects: MutationEffects,
) -> Result<
    SealedOutcome<crate::ModuleWriterResult<AutomationCommitValue, AutomationReceipt>>,
    StoreError,
> {
    if effects.is_empty_scheduler_claim() {
        return seal_empty_scheduler_claim(scope, operation_id, effects);
    }
    let connection = scope.connection();
    let store_epoch = scope.store_epoch();
    let commit = scope.evidence();
    let project_id = event_project_id(connection, library_id, context)?;
    let payload = json!({
        "module": MODULE_NAME,
        "operationKind": effects.operation_kind,
        "kind": "automation_changed",
        "automationIds": effects.automation_ids,
        "leaseIds": effects.lease_ids,
        "runIds": effects.run_ids,
        "reminderLeaseIds": effects.reminder_lease_ids,
        "snoozeIds": effects.snooze_ids,
        "pageIds": effects.page_ids,
        "documentIds": effects.document_ids,
        "databaseIds": effects.database_ids,
    });
    let event_payload = CoreModuleEventPayload::Automation(AutomationEvent {
        kind: AutomationEventKind::AutomationChanged,
        automation_ids: effects.automation_ids.clone(),
        lease_ids: effects.lease_ids.clone(),
        run_ids: effects.run_ids.clone(),
        reminder_lease_ids: effects.reminder_lease_ids.clone(),
        snooze_ids: effects.snooze_ids.clone(),
        page_ids: effects.page_ids.clone(),
        document_ids: effects.document_ids.clone(),
        database_ids: effects.database_ids.clone(),
    });
    let projection_impact =
        expand_database_coordinates(connection, impact_for_payload(&event_payload)?)?;
    let authorization_before = scope.authorization_before()?;
    crate::database::record_local_projection_delta(
        connection,
        commit,
        library_id,
        &projection_impact,
        &authorization_before,
    )?;
    let payload_json = serde_json::to_string(&payload)
        .map_err(|_| internal("Automation event payload cannot be encoded"))?;
    let event_sequence = append_change_log(
        connection,
        NewChangeLogEntry {
            project_id: &project_id,
            store_epoch,
            kind: "automation.changed",
            operation_id: Some(operation_id),
            block_ids: &effects.page_ids,
            document_ids: &effects.document_ids,
            database_block_ids: &effects.database_ids,
            payload_json: &payload_json,
            projection_impact: &projection_impact,
            committed_at: &effects.committed_at,
        },
        commit,
    )?;
    if let Some(result) = effects.page_occurrence_mutation.as_mut() {
        result.commit_seq = Some(commit.commit_seq());
    }
    let committed = crate::ModuleWriterResult {
        value: AutomationCommitValue {
            affected_automation_ids: effects.automation_ids.clone(),
            definitions: effects.definitions,
            claimed_leases: effects.claimed_leases,
            runs: effects.runs,
            deleted_run_ids: effects.deleted_run_ids,
            run_bulk: effects.run_bulk,
            reminder_leases: effects.reminder_leases,
            reminder_snoozes: effects.reminder_snoozes,
            page_occurrence_mutation: effects.page_occurrence_mutation,
        },
        receipt: AutomationReceipt {
            mutation: ModuleMutationReceipt {
                operation_id: operation_id.to_owned(),
                duplicate: false,
            },
            affected_automation_ids: effects.automation_ids.clone(),
            affected_lease_ids: effects.lease_ids.clone(),
            affected_run_ids: effects.run_ids.clone(),
            affected_reminder_lease_ids: effects.reminder_lease_ids.clone(),
            affected_snooze_ids: effects.snooze_ids.clone(),
            affected_page_ids: effects.page_ids.clone(),
            affected_document_ids: effects.document_ids.clone(),
            affected_database_ids: effects.database_ids.clone(),
        },
        commit_seq: commit.commit_seq(),
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

fn seal_empty_scheduler_claim(
    scope: &DurableMutationScope<'_>,
    operation_id: &str,
    effects: MutationEffects,
) -> Result<
    SealedOutcome<crate::ModuleWriterResult<AutomationCommitValue, AutomationReceipt>>,
    StoreError,
> {
    let connection = scope.connection();
    let event_sequence =
        connection.query_row("SELECT COALESCE(MAX(seq), 0) FROM change_log", [], |row| {
            row.get::<_, i64>(0)
        })?;
    let commit_seq = crate::infrastructure::local_commit::head(connection)?;
    let committed = crate::ModuleWriterResult {
        value: AutomationCommitValue {
            affected_automation_ids: Vec::new(),
            definitions: Vec::new(),
            claimed_leases: Vec::new(),
            runs: Vec::new(),
            deleted_run_ids: Vec::new(),
            run_bulk: None,
            reminder_leases: Vec::new(),
            reminder_snoozes: Vec::new(),
            page_occurrence_mutation: None,
        },
        receipt: AutomationReceipt {
            mutation: ModuleMutationReceipt {
                operation_id: operation_id.to_owned(),
                duplicate: false,
            },
            affected_automation_ids: Vec::new(),
            affected_lease_ids: Vec::new(),
            affected_run_ids: Vec::new(),
            affected_reminder_lease_ids: Vec::new(),
            affected_snooze_ids: Vec::new(),
            affected_page_ids: Vec::new(),
            affected_document_ids: Vec::new(),
            affected_database_ids: Vec::new(),
        },
        commit_seq,
        event_sequence,
        store_epoch: StoreEpoch(scope.store_epoch().to_owned()),
    };
    Ok(scope.no_op(
        committed,
        ReceiptMetadata {
            operation_kind: effects.operation_kind,
            event_sequence: None,
            committed_at: &effects.committed_at,
        },
    ))
}

#[allow(clippy::too_many_arguments)]
fn seal_occurrence_rejection(
    scope: &DurableMutationScope<'_>,
    operation_id: &str,
    effects: super::occurrence_mutation::OccurrenceMutationEffects,
) -> Result<
    SealedOutcome<crate::ModuleWriterResult<AutomationCommitValue, AutomationReceipt>>,
    StoreError,
> {
    let connection = scope.connection();
    let commit_head =
        connection.query_row("SELECT COALESCE(MAX(seq), 0) FROM change_log", [], |row| {
            row.get::<_, i64>(0)
        })?;
    let commit_seq = crate::infrastructure::local_commit::head(connection)?;
    let committed = crate::ModuleWriterResult {
        value: AutomationCommitValue {
            affected_automation_ids: Vec::new(),
            definitions: Vec::new(),
            claimed_leases: Vec::new(),
            runs: Vec::new(),
            deleted_run_ids: Vec::new(),
            run_bulk: None,
            reminder_leases: Vec::new(),
            reminder_snoozes: Vec::new(),
            page_occurrence_mutation: Some(effects.result),
        },
        receipt: AutomationReceipt {
            mutation: ModuleMutationReceipt {
                operation_id: operation_id.to_owned(),
                duplicate: false,
            },
            affected_automation_ids: Vec::new(),
            affected_lease_ids: Vec::new(),
            affected_run_ids: Vec::new(),
            affected_reminder_lease_ids: Vec::new(),
            affected_snooze_ids: Vec::new(),
            affected_page_ids: effects.page_ids,
            affected_document_ids: Vec::new(),
            affected_database_ids: Vec::new(),
        },
        commit_seq,
        event_sequence: commit_head,
        store_epoch: StoreEpoch(scope.store_epoch().to_owned()),
    };
    Ok(scope.no_op(
        committed,
        ReceiptMetadata {
            operation_kind: effects.operation_kind,
            event_sequence: None,
            committed_at: &effects.committed_at,
        },
    ))
}

fn is_page_occurrence_intent(intent: &AutomationIntent) -> bool {
    matches!(
        intent,
        AutomationIntent::CompletePageOccurrence { .. }
            | AutomationIntent::SkipPageOccurrence { .. }
            | AutomationIntent::UpdatePageOccurrence { .. }
    )
}

fn normalize_definition(
    connection: &Connection,
    input: &AutomationDefinitionInput,
) -> Result<NormalizedDefinition, StoreError> {
    let name = input.name.trim();
    if name.is_empty() || name.chars().count() > MAX_NAME_CHARS {
        return Err(invalid("Scheduled Automation name is invalid"));
    }
    let prompt = input.prompt.as_deref().unwrap_or_default().trim();
    if prompt.len() > MAX_PROMPT_BYTES {
        return Err(invalid("Scheduled Automation prompt exceeds its bound"));
    }
    let rrule = normalize_rrule(input.rrule.as_deref()).map_err(schedule_invalid)?;
    let model = normalize_optional_string(input.model.as_deref(), MAX_MODEL_BYTES, "model")?;
    let reasoning_effort = normalize_optional_string(
        input.reasoning_effort.as_deref(),
        MAX_REASONING_EFFORT_BYTES,
        "reasoning_effort",
    )?;
    let service_tier = normalize_optional_string(
        input.service_tier.as_deref(),
        MAX_REASONING_EFFORT_BYTES,
        "service_tier",
    )?;
    binding_storage(&input.backend_binding).map_err(invalid)?;
    let target_thread_id = normalize_optional_string(
        input.target_thread_id.as_deref(),
        MAX_ID_LENGTH,
        "target_thread_id",
    )?;
    let execution_environment = input
        .execution_environment
        .unwrap_or(AutomationExecutionEnvironment::Worktree);
    let local_environment_config_path = input
        .local_environment_config_path
        .as_deref()
        .map(|value| normalize_absolute_path(value, "local_environment_config_path"))
        .transpose()?;
    let cwds = normalize_cwds(input.cwds.as_deref().unwrap_or_default())?;

    match input.kind {
        AutomationDefinitionKind::Cron => {
            if cwds.is_empty() {
                return Err(invalid(
                    "Cron Scheduled Automation requires at least one cwd",
                ));
            }
            if target_thread_id.is_some() {
                return Err(invalid("Cron Scheduled Automation cannot target a Thread"));
            }
        }
        AutomationDefinitionKind::Heartbeat => {
            let target = target_thread_id.as_deref().ok_or_else(|| {
                invalid("Heartbeat Scheduled Automation requires a target Thread")
            })?;
            if !cwds.is_empty() || local_environment_config_path.is_some() {
                return Err(invalid(
                    "Heartbeat Scheduled Automation cannot own cron execution paths",
                ));
            }
            let exists = connection
                .query_row(
                    "SELECT 1 FROM codex_threads WHERE thread_id = ?1",
                    [target],
                    |_| Ok(()),
                )
                .optional()?
                .is_some();
            if !exists {
                return Err(not_found("Heartbeat target Thread is unavailable"));
            }
        }
    }

    Ok(NormalizedDefinition {
        kind: input.kind,
        target_thread_id,
        name: name.to_owned(),
        prompt: prompt.to_owned(),
        rrule,
        model,
        reasoning_effort,
        service_tier,
        backend_binding: input.backend_binding.clone(),
        cwds,
        execution_environment,
        local_environment_config_path: if input.kind == AutomationDefinitionKind::Cron {
            local_environment_config_path
        } else {
            None
        },
    })
}

fn normalize_cwds(values: &[String]) -> Result<Vec<String>, StoreError> {
    if values.len() > MAX_CWDS {
        return Err(invalid("Scheduled Automation cwd list exceeds its bound"));
    }
    let mut seen = BTreeSet::new();
    let mut result = Vec::new();
    for value in values {
        let cwd = normalize_absolute_path(value, "cwd")?;
        if seen.insert(cwd.clone()) {
            result.push(cwd);
        }
    }
    Ok(result)
}

pub(super) fn normalize_absolute_path(value: &str, label: &str) -> Result<String, StoreError> {
    let value = value.trim();
    if value.is_empty() || value.len() > MAX_PATH_BYTES || !is_absolute_path(value) {
        return Err(invalid(&format!("Scheduled Automation {label} is invalid")));
    }
    if looks_like_windows_absolute(value) {
        return Ok(value.replace('\\', "/"));
    }
    let mut normalized = PathBuf::new();
    for component in Path::new(value).components() {
        match component {
            Component::RootDir | Component::Prefix(_) | Component::Normal(_) => {
                normalized.push(component.as_os_str());
            }
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() {
                    return Err(invalid(&format!(
                        "Scheduled Automation {label} escapes its root"
                    )));
                }
            }
        }
    }
    normalized
        .to_str()
        .filter(|path| !path.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| invalid(&format!("Scheduled Automation {label} is invalid UTF-8")))
}

fn is_absolute_path(value: &str) -> bool {
    Path::new(value).is_absolute()
        || looks_like_windows_absolute(value)
        || value
            .strip_prefix("\\\\")
            .is_some_and(|rest| rest.split('\\').filter(|part| !part.is_empty()).count() >= 2)
}

fn looks_like_windows_absolute(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'/' | b'\\')
}

fn normalize_optional_string(
    value: Option<&str>,
    max_bytes: usize,
    label: &str,
) -> Result<Option<String>, StoreError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let value = value.trim();
    if value.is_empty() {
        return Ok(None);
    }
    if value.len() > max_bytes {
        return Err(invalid(&format!(
            "Scheduled Automation {label} exceeds its bound"
        )));
    }
    Ok(Some(value.to_owned()))
}

fn require_unique_active_heartbeat(
    connection: &Connection,
    automation_id: &str,
    status: AutomationDefinitionStatus,
    definition: &NormalizedDefinition,
) -> Result<(), StoreError> {
    if definition.kind != AutomationDefinitionKind::Heartbeat
        || status != AutomationDefinitionStatus::Active
    {
        return Ok(());
    }
    let duplicate = connection
        .query_row(
            "SELECT 1 FROM codex_scheduled_automations \
             WHERE automation_id <> ?1 AND kind = 'heartbeat' AND status = 'ACTIVE' \
               AND target_thread_id = ?2",
            params![automation_id, definition.target_thread_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if duplicate {
        return Err(conflict("Target Thread already has an active heartbeat"));
    }
    Ok(())
}

fn scheduled_next(
    connection: &Connection,
    automation_id: &str,
    definition: &NormalizedDefinition,
    now_ms: i64,
) -> Result<Option<i64>, StoreError> {
    let salt = jitter_salt(connection)?;
    next_run_at(
        automation_id,
        definition.kind,
        &definition.rrule,
        now_ms,
        &salt,
    )
    .map_err(schedule_invalid)
}

fn scheduled_next_for_stored(
    connection: &Connection,
    definition: &AutomationDefinition,
    now_ms: i64,
) -> Result<Option<i64>, StoreError> {
    let salt = jitter_salt(connection)?;
    next_run_at(
        &definition.automation_id,
        definition.kind,
        &definition.rrule,
        now_ms,
        &salt,
    )
    .map_err(|_| corrupt("Stored Scheduled Automation RRULE is invalid"))
}

fn jitter_salt(connection: &Connection) -> Result<String, StoreError> {
    connection
        .query_row(
            "SELECT jitter_salt FROM core_automation_runtime_metadata WHERE id = 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .filter(|salt| !salt.is_empty() && salt.len() <= 512)
        .ok_or_else(|| corrupt("Automation jitter salt is unavailable"))
}

fn cancel_claimed_leases(
    connection: &Connection,
    automation_id: &str,
    now_ms: i64,
    reason_code: &str,
) -> Result<Vec<String>, StoreError> {
    let lease_ids = {
        let mut statement = connection.prepare(
            "SELECT lease_id FROM core_automation_leases \
             WHERE automation_id = ?1 AND status = 'claimed' ORDER BY lease_id",
        )?;
        statement
            .query_map([automation_id], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };
    connection.execute(
        "UPDATE core_automation_leases SET status = 'cancelled', settled_at_ms = ?1, \
           reason_code = ?2 WHERE automation_id = ?3 AND status = 'claimed'",
        params![now_ms, reason_code, automation_id],
    )?;
    Ok(lease_ids)
}

fn event_project_id(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
) -> Result<String, StoreError> {
    if let Some(project_id) = context.project_id.as_ref() {
        let bound = connection
            .query_row(
                "SELECT id FROM projects WHERE id = ?1 AND library_id = ?2",
                params![project_id.0, library_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        if let Some(bound) = bound {
            return Ok(bound);
        }
        return Err(StoreError::new(
            StoreErrorCode::Unauthorized,
            "bound Automation Project is unavailable in this Library",
            false,
        ));
    }
    connection
        .query_row(
            "SELECT id FROM projects WHERE library_id = ?1 \
             ORDER BY CASE lifecycle WHEN 'active' THEN 0 ELSE 1 END, created, id LIMIT 1",
            [library_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .ok_or_else(|| corrupt("Automation event has no Project scope"))
}

fn core_now(connection: &Connection) -> Result<(i64, String), StoreError> {
    connection
        .query_row(
            "SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER), \
                    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
            [],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        )
        .map_err(Into::into)
}

fn lease_id(
    operation_id: &str,
    automation_id: &str,
    scheduled_for_ms: i64,
    attempt: u32,
) -> String {
    let digest = Sha256::digest(
        format!("{operation_id}:{automation_id}:{scheduled_for_ms}:{attempt}").as_bytes(),
    );
    format!("automation-lease:{}", hex_digest(&digest))
}

fn hex_digest(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut result = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        result.push(char::from(HEX[usize::from(byte >> 4)]));
        result.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    result
}

fn require_trusted_host(
    context: &BoundModuleContext,
    intent: &AutomationIntent,
) -> Result<(), StoreError> {
    if !matches!(
        intent,
        AutomationIntent::ClaimDue { .. }
            | AutomationIntent::DispatchNow { .. }
            | AutomationIntent::RescheduleDefinition { .. }
            | AutomationIntent::CompleteLease { .. }
            | AutomationIntent::FailLease { .. }
            | AutomationIntent::BeginRun { .. }
            | AutomationIntent::ReplacePendingRunThread { .. }
            | AutomationIntent::SetRunThreadTitle { .. }
            | AutomationIntent::CompleteRunForReview { .. }
            | AutomationIntent::SetRunInboxItem { .. }
            | AutomationIntent::AcceptRun { .. }
            | AutomationIntent::SetRunReadState { .. }
            | AutomationIntent::MarkAllRunsRead
            | AutomationIntent::ArchiveRun { .. }
            | AutomationIntent::UnarchiveRun { .. }
            | AutomationIntent::DeleteRun { .. }
            | AutomationIntent::SettleInterruptedRuns
            | AutomationIntent::ClaimDueReminders { .. }
            | AutomationIntent::CompleteReminderLease { .. }
            | AutomationIntent::FailReminderLease { .. }
    ) || matches!(
        context.adapter,
        AdapterKind::ElectronHost | AdapterKind::Test
    ) {
        return Ok(());
    }
    Err(StoreError::new(
        StoreErrorCode::Unauthorized,
        "Automation execution and run transitions require a trusted Host Adapter",
        false,
    ))
}

fn normalize_reason_code(value: &str) -> Result<String, StoreError> {
    let value = value.trim();
    if value.is_empty() || value.len() > MAX_REASON_CODE_BYTES {
        return Err(invalid("Automation failure reason code is invalid"));
    }
    Ok(value.to_owned())
}

fn validate_id(label: &str, value: &str) -> Result<(), StoreError> {
    if !value.trim().is_empty()
        && value.trim() == value
        && value.len() <= MAX_ID_LENGTH
        && value != "."
        && value != ".."
        && !value.contains('/')
        && !value.contains('\\')
    {
        return Ok(());
    }
    Err(invalid(&format!("{label} is invalid")))
}

fn schedule_invalid(error: ScheduleError) -> StoreError {
    invalid(error.0)
}

fn invalid(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message, false)
}

fn require_active_definition_capacity(connection: &Connection) -> Result<(), StoreError> {
    let active_definitions = connection.query_row(
        "SELECT count(*) FROM codex_scheduled_automations \
         WHERE status <> 'DELETED'",
        [],
        |row| row.get::<_, i64>(0),
    )?;
    if active_definitions
        < i64::try_from(MAX_ACTIVE_DEFINITIONS).expect("active Scheduled Automation bound fits i64")
    {
        return Ok(());
    }
    Err(StoreError::new(
        StoreErrorCode::ResourceExhausted,
        "Active Scheduled Automation collection exceeds its fixed bound; delete one first",
        false,
    ))
}

fn not_found(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::NotFound, message, false)
}

fn conflict(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::RevisionConflict, message, true)
}

fn corrupt(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message, false)
}

fn internal(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::Internal, message, false)
}

fn sqlite_now(connection: &Connection) -> Result<String, StoreError> {
    connection
        .query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", [], |row| {
            row.get(0)
        })
        .map_err(StoreError::from)
}

#[cfg(test)]
mod tests {
    use chrono::{Duration, Utc};
    use nodex_core_contracts::agent::AgentBackendBinding;
    use nodex_core_contracts::automation::{
        AutomationDefinitionInput, AutomationDefinitionKind, AutomationDefinitionStatus,
        AutomationDueWorkLane, AutomationIntent, AutomationLeaseStatus, AutomationRead,
        AutomationReadValue, AutomationRunStatus, PageOccurrenceSchedulePatch,
        PageOccurrenceUpdateScope, ReminderLeaseStatus,
    };
    use nodex_core_contracts::database::{
        DATABASE_CONTRACT_VERSION, DatabaseIntent, DatabaseTransferTarget,
    };
    use nodex_core_contracts::library::{
        LIBRARY_CONTRACT_VERSION, LibraryIntent, LibraryWriteParent,
    };
    use nodex_core_contracts::{
        AUTOMATION_CONTRACT_VERSION, AdapterKind, BoundModuleContext, LibraryId,
        ModuleApplyRequest, ModuleReadRequest, ProfileId, ProjectId, StoreEpoch,
    };
    use rusqlite::params;
    use serde_json::{Value, json};
    use tempfile::{TempDir, tempdir};

    use crate::automation::AutomationModule;
    use crate::database::DatabaseModule;
    use crate::infrastructure::sqlite::StoreErrorCode;
    use crate::infrastructure::store::SqliteStoreKernel;
    use crate::library::LibraryModule;
    use crate::workspace::ProjectWorkspaceModule;

    struct Harness {
        _home: TempDir,
        kernel: SqliteStoreKernel,
        module: AutomationModule,
        context: BoundModuleContext,
        store_epoch: StoreEpoch,
    }

    fn harness() -> Harness {
        let home = tempdir().expect("Profile");
        let kernel = SqliteStoreKernel::open_test(home.path()).expect("Core store");
        kernel
            .writer()
            .call(|connection| {
                connection.execute(
                    "INSERT INTO profiles(id, created_at, updated_at) \
                     VALUES ('profile-1', '2026-07-18', '2026-07-18')",
                    [],
                )?;
                connection.execute(
                    "INSERT INTO libraries(id, profile_id, created_at, updated_at) \
                     VALUES ('library-1', 'profile-1', '2026-07-18', '2026-07-18')",
                    [],
                )?;
                connection.execute(
                    "INSERT INTO block_store_metadata(id, store_epoch, created_at, updated_at) \
                     VALUES (1, 'epoch-1', '2026-07-18', '2026-07-18')",
                    [],
                )?;
                Ok(())
            })
            .expect("seed identity");
        let workspace =
            ProjectWorkspaceModule::new("profile-1", "library-1", &kernel).expect("Workspace");
        workspace.seed_rootless_default_project_for_test();
        let module = AutomationModule::new("profile-1", "library-1", &kernel);
        Harness {
            _home: home,
            kernel,
            module,
            context: BoundModuleContext {
                editor_history_owner: None,
                profile_id: ProfileId("profile-1".to_owned()),
                library_id: LibraryId("library-1".to_owned()),
                project_id: None,
                connection_id: "test-connection".to_owned(),
                adapter: AdapterKind::Test,
            },
            store_epoch: StoreEpoch("epoch-1".to_owned()),
        }
    }

    fn definition() -> AutomationDefinitionInput {
        AutomationDefinitionInput {
            kind: AutomationDefinitionKind::Cron,
            target_thread_id: None,
            name: "Daily report".to_owned(),
            prompt: Some("Prepare the report".to_owned()),
            rrule: Some("FREQ=MINUTELY;INTERVAL=5".to_owned()),
            model: Some("claude-opus-4-1".to_owned()),
            reasoning_effort: Some("Thinking".to_owned()),
            service_tier: Some("priority".to_owned()),
            backend_binding: AgentBackendBinding::Codex,
            cwds: Some(vec!["/workspace/report".to_owned()]),
            execution_environment: None,
            local_environment_config_path: None,
        }
    }

    #[test]
    fn active_definition_capacity_is_enforced_at_growth_ingress() {
        let harness = harness();
        harness
            .kernel
            .writer()
            .call(|connection| {
                for index in 0..super::MAX_ACTIVE_DEFINITIONS {
                    connection.execute(
                        "INSERT INTO codex_scheduled_automations(\
                           automation_id, kind, status, name, prompt, rrule, cwds_json, \
                           execution_environment, created_at, updated_at\
                         ) VALUES (?1, 'cron', 'ACTIVE', ?1, '', \
                           'FREQ=DAILY', '[]', 'local', 1, 1)",
                        [format!("automation:capacity:{index}")],
                    )?;
                }

                let error = super::require_active_definition_capacity(connection)
                    .expect_err("full Scheduled Automation collection");
                assert_eq!(error.code, StoreErrorCode::ResourceExhausted);

                connection.execute(
                    "UPDATE codex_scheduled_automations SET status = 'DELETED' \
                     WHERE automation_id = 'automation:capacity:0'",
                    [],
                )?;
                super::require_active_definition_capacity(connection)
                    .expect("deleted definitions do not consume active capacity");
                Ok(())
            })
            .expect("check Scheduled Automation capacity");
    }

    fn apply(
        harness: &Harness,
        operation_id: &str,
        intent: AutomationIntent,
    ) -> Result<crate::automation::AutomationApplyOutcome, nodex_core_contracts::CoreError> {
        harness.module.apply(
            &harness.context,
            ModuleApplyRequest {
                contract_version: AUTOMATION_CONTRACT_VERSION,
                operation_id: operation_id.to_owned(),
                store_epoch: harness.store_epoch.clone(),
                intent,
            },
        )
    }

    fn definition_work_token(harness: &Harness) -> String {
        harness
            .kernel
            .readers()
            .read_default(super::plan_definition_due_work)
            .expect("plan Automation due work")
            .work_token
            .expect("Automation is due")
    }

    fn reminder_work_token(harness: &Harness) -> String {
        harness
            .kernel
            .readers()
            .read_default(|connection| {
                super::super::reminder::plan_due_work(connection, "library-1")
            })
            .expect("plan Reminder due work")
            .work_token
            .expect("Reminder is due")
    }

    fn project_context(harness: &Harness) -> BoundModuleContext {
        BoundModuleContext {
            editor_history_owner: None,
            project_id: Some(ProjectId("project:default".to_owned())),
            ..harness.context.clone()
        }
    }

    fn apply_with_context(
        harness: &Harness,
        context: &BoundModuleContext,
        operation_id: &str,
        intent: AutomationIntent,
    ) -> Result<crate::automation::AutomationApplyOutcome, nodex_core_contracts::CoreError> {
        harness.module.apply(
            context,
            ModuleApplyRequest {
                contract_version: AUTOMATION_CONTRACT_VERSION,
                operation_id: operation_id.to_owned(),
                store_epoch: harness.store_epoch.clone(),
                intent,
            },
        )
    }

    fn seed_scheduled_page(
        harness: &Harness,
        page_id: &str,
        title: &str,
        start: chrono::DateTime<Utc>,
        end: chrono::DateTime<Utc>,
        recurrence: serde_json::Value,
        reminders: serde_json::Value,
    ) {
        let context = project_context(harness);
        LibraryModule::new("profile-1", "library-1", &harness.kernel)
            .apply(
                &context,
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: format!("create:{page_id}"),
                    store_epoch: harness.store_epoch.clone(),
                    intent: LibraryIntent::CreatePage {
                        page_id: page_id.to_owned(),
                        document_id: format!("document:{page_id}"),
                        title: title.to_owned(),
                        parent: LibraryWriteParent::Library { before: None },
                    },
                },
            )
            .expect("create scheduled Page");
        let data_source_id = harness
            .kernel
            .readers()
            .read_default(|connection| {
                connection
                    .query_row(
                        "SELECT source.id FROM data_sources source \
                         JOIN project_database_bindings binding \
                           ON binding.database_block_id = source.home_database_block_id \
                         WHERE binding.project_id = 'project:default' \
                           AND binding.lifecycle = 'active' LIMIT 1",
                        [],
                        |row| row.get::<_, String>(0),
                    )
                    .map_err(Into::into)
            })
            .expect("default Data Source");
        DatabaseModule::new("profile-1", "library-1", &harness.kernel)
            .apply(
                &context,
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: format!("transfer:{page_id}"),
                    store_epoch: harness.store_epoch.clone(),
                    intent: vec![DatabaseIntent::TransferPage {
                        page_id: page_id.to_owned(),
                        expected_parent_revision: 1,
                        expected_active_membership_revision: 0,
                        target: DatabaseTransferTarget::DataSource {
                            data_source_id: data_source_id.clone(),
                        },
                    }],
                },
            )
            .expect("transfer Page to default Data Source");
        let page_id = page_id.to_owned();
        let start = start.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let end = end.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        harness
            .kernel
            .writer()
            .call(move |connection| {
                let membership_id = connection.query_row(
                    "SELECT id FROM data_source_page_memberships \
                     WHERE page_block_id = ?1 AND removed_at IS NULL",
                    [&page_id],
                    |row| row.get::<_, String>(0),
                )?;
                for (property_id, value) in [
                    ("scheduled_start", json!(start)),
                    ("scheduled_end", json!(end)),
                ] {
                    connection.execute(
                        "UPDATE data_source_property_values SET value_json = ?1, \
                           revision = revision + 1, updated_at = '2026-07-18T00:00:00.000Z' \
                         WHERE membership_id = ?2 AND data_source_id = ?3 AND property_id = ?4",
                        params![value.to_string(), membership_id, data_source_id, property_id],
                    )?;
                }
                let intrinsic = [
                    ("run.target", "string", json!("localProject")),
                    ("run.localPath", "string", serde_json::Value::Null),
                    ("run.baseBranch", "string", serde_json::Value::Null),
                    ("run.worktreePath", "string", serde_json::Value::Null),
                    ("run.environmentPath", "string", serde_json::Value::Null),
                    ("schedule.isAllDay", "boolean", json!(false)),
                    ("schedule.timezone", "string", json!("UTC")),
                    ("recurrence.config", "json", recurrence.clone()),
                    ("reminders.config", "json", reminders.clone()),
                ];
                for (key, value_type, value) in intrinsic {
                    connection.execute(
                        "INSERT INTO block_properties( \
                           block_id, library_id, property_key, value_type, value_json, revision, updated_at \
                         ) VALUES (?1, 'library-1', ?2, ?3, ?4, 1, \
                           '2026-07-18T00:00:00.000Z') \
                         ON CONFLICT(block_id, property_key) DO UPDATE SET \
                           value_type = excluded.value_type, \
                           value_json = excluded.value_json, \
                           revision = block_properties.revision + 1, \
                           updated_at = excluded.updated_at",
                        params![page_id, key, value_type, value.to_string()],
                    )?;
                }
                let metadata_revision = connection.query_row(
                    "UPDATE blocks SET metadata_revision = metadata_revision + 1, \
                       updated_at = '2026-07-18T00:00:00.000Z' \
                     WHERE id = ?1 RETURNING metadata_revision",
                    [&page_id],
                    |row| row.get::<_, i64>(0),
                )?;
                connection.execute(
                    "UPDATE page_read_model SET metadata_revision = ?1, \
                       updated_at = '2026-07-18T00:00:00.000Z' \
                     WHERE page_block_id = ?2 AND library_id = 'library-1'",
                    params![metadata_revision, page_id],
                )?;
                connection.execute(
                    "INSERT INTO scheduled_page_index( \
                       page_block_id, library_id, lifecycle, scheduled_start, scheduled_end, \
                       is_all_day, recurrence_json, reminders_json, schedule_timezone, \
                       source_metadata_revision, updated_at \
                     ) VALUES (?1, 'library-1', 'active', ?2, ?3, 0, ?4, ?5, 'UTC', ?6, \
                       '2026-07-18T00:00:00.000Z')",
                    params![
                        page_id,
                        start,
                        end,
                        recurrence.to_string(),
                        reminders.to_string(),
                        metadata_revision,
                    ],
                )?;
                Ok(())
            })
            .expect("seed scheduled Page properties");
    }

    fn create(harness: &Harness) {
        apply(
            harness,
            "create-automation",
            AutomationIntent::CreateDefinition {
                automation_id: "daily-report".to_owned(),
                definition: definition(),
            },
        )
        .expect("create Automation");
    }

    fn seed_thread(harness: &Harness, thread_id: &str) {
        let thread_id = thread_id.to_owned();
        harness
            .kernel
            .writer()
            .call(move |connection| {
                connection.execute(
                    "INSERT INTO codex_threads(\
                       thread_id, project_id, thread_name, thread_preview, \
                       status_type, status_active_flags_json, archived, created_at, updated_at, \
                       linked_at\
                     ) VALUES (?1, 'project:default', '', '', 'idle', '[]', 0, 1, 1, \
                       '2026-07-19T00:00:00.000Z')",
                    [thread_id],
                )?;
                Ok(())
            })
            .expect("seed Automation Thread");
    }

    #[test]
    fn idle_probe_detects_due_definitions_and_live_execution_leases() {
        let harness = harness();
        assert!(!harness.module.has_due_background_work(10).unwrap());
        create(&harness);
        harness
            .kernel
            .writer()
            .call(|connection| {
                connection.execute(
                    "UPDATE codex_scheduled_automations SET next_run_at = 10 \
                     WHERE automation_id = 'daily-report'",
                    [],
                )?;
                Ok(())
            })
            .unwrap();
        assert!(harness.module.has_due_background_work(10).unwrap());
        harness
            .kernel
            .writer()
            .call(|connection| {
                connection.execute(
                    "UPDATE codex_scheduled_automations SET next_run_at = 1000 \
                     WHERE automation_id = 'daily-report'",
                    [],
                )?;
                connection.execute(
                    "INSERT INTO core_automation_leases(\
                       lease_id, automation_id, scheduled_for_ms, attempt, status, claimed_at_ms, \
                       expires_at_ms, settled_at_ms, retry_at_ms, reason_code\
                     ) VALUES ('lease:idle', 'daily-report', 10, 1, 'claimed', 0, 20, \
                       NULL, NULL, NULL)",
                    [],
                )?;
                Ok(())
            })
            .unwrap();
        assert!(harness.module.has_due_background_work(10).unwrap());
        assert!(!harness.module.has_due_background_work(20).unwrap());
    }

    #[test]
    fn due_work_read_prevents_idle_claims_and_empty_claims_abandon_delivery() {
        let harness = harness();
        let idle = harness
            .module
            .read(
                &harness.context,
                ModuleReadRequest {
                    contract_version: AUTOMATION_CONTRACT_VERSION,
                    read: AutomationRead::DueWork {
                        lane: AutomationDueWorkLane::Definitions,
                    },
                },
            )
            .expect("plan idle Automation work");
        let AutomationReadValue::DueWork { plan } = idle.value else {
            panic!("due-work snapshot");
        };
        assert!(!plan.due_now);
        assert!(plan.work_token.is_none());

        let before = harness
            .kernel
            .readers()
            .read_default(|connection| {
                Ok((
                    connection.query_row("SELECT count(*) FROM local_commits", [], |row| {
                        row.get::<_, i64>(0)
                    })?,
                    connection.query_row("SELECT count(*) FROM change_log", [], |row| {
                        row.get::<_, i64>(0)
                    })?,
                ))
            })
            .expect("idle ledger baseline");
        let rejected = apply(
            &harness,
            "claim-idle",
            AutomationIntent::ClaimDue {
                work_token: "stale-idle-token".to_owned(),
                limit: 3,
                lease_duration_ms: 60_000,
            },
        )
        .expect_err("idle scheduler cannot claim without Core-authored due work");
        assert_eq!(rejected.code, nodex_core_contracts::CoreErrorCode::Conflict);
        let after = harness
            .kernel
            .readers()
            .read_default(|connection| {
                Ok((
                    connection.query_row("SELECT count(*) FROM local_commits", [], |row| {
                        row.get::<_, i64>(0)
                    })?,
                    connection.query_row("SELECT count(*) FROM change_log", [], |row| {
                        row.get::<_, i64>(0)
                    })?,
                ))
            })
            .expect("idle ledger result");
        assert_eq!(after, before);
    }

    #[test]
    fn definitions_are_typed_revisioned_and_exactly_replayed() {
        let harness = harness();
        let created = apply(
            &harness,
            "create-automation",
            AutomationIntent::CreateDefinition {
                automation_id: "daily-report".to_owned(),
                definition: definition(),
            },
        )
        .expect("create Automation");
        assert_eq!(
            created.committed.value.definitions[0].definition_revision,
            1
        );
        assert!(
            created.committed.value.definitions[0]
                .next_run_at_ms
                .is_some()
        );

        let replay = apply(
            &harness,
            "create-automation",
            AutomationIntent::CreateDefinition {
                automation_id: "daily-report".to_owned(),
                definition: definition(),
            },
        )
        .expect("replay Automation");
        assert_eq!(
            replay.committed.event_sequence,
            created.committed.event_sequence
        );
        assert!(replay.committed.receipt.mutation.duplicate);
        assert!(replay.event.is_none());

        let snapshot = harness
            .module
            .read(
                &harness.context,
                ModuleReadRequest {
                    contract_version: AUTOMATION_CONTRACT_VERSION,
                    read: AutomationRead::Definitions {
                        include_deleted: None,
                        window: Default::default(),
                    },
                },
            )
            .expect("read Automations");
        let AutomationReadValue::Definitions { window } = snapshot.value else {
            panic!("definitions snapshot");
        };
        let items = window.items;
        assert_eq!(items, created.committed.value.definitions);
        let definition = &items[0];
        assert_eq!(definition.model.as_deref(), Some("claude-opus-4-1"));
        assert_eq!(definition.reasoning_effort.as_deref(), Some("Thinking"));
        assert_eq!(definition.service_tier.as_deref(), Some("priority"));
    }

    #[test]
    fn trusted_host_manual_dispatch_advances_runtime_state_exactly_once() {
        let harness = harness();
        create(&harness);
        let dispatched = apply(
            &harness,
            "dispatch-now",
            AutomationIntent::DispatchNow {
                automation_id: "daily-report".to_owned(),
            },
        )
        .expect("dispatch Automation now");
        let definition = &dispatched.committed.value.definitions[0];
        assert_eq!(definition.definition_revision, 1);
        assert!(definition.last_run_at_ms.is_some());
        assert!(definition.next_run_at_ms.is_some());

        let replay = apply(
            &harness,
            "dispatch-now",
            AutomationIntent::DispatchNow {
                automation_id: "daily-report".to_owned(),
            },
        )
        .expect("replay manual dispatch");
        assert_eq!(
            replay.committed.event_sequence,
            dispatched.committed.event_sequence
        );
        assert_eq!(
            replay.committed.value.definitions,
            dispatched.committed.value.definitions
        );
        assert!(replay.committed.receipt.mutation.duplicate);
        assert!(replay.event.is_none());
    }

    #[test]
    fn durable_due_leases_reclaim_expiry_and_settle_once() {
        let harness = harness();
        create(&harness);
        harness
            .kernel
            .writer()
            .call(|connection| {
                connection.execute(
                    "UPDATE codex_scheduled_automations SET next_run_at = 0 \
                     WHERE automation_id = 'daily-report'",
                    [],
                )?;
                Ok(())
            })
            .expect("make Automation due");

        let first = apply(
            &harness,
            "claim-1",
            AutomationIntent::ClaimDue {
                work_token: definition_work_token(&harness),
                limit: 3,
                lease_duration_ms: 60_000,
            },
        )
        .expect("claim due Automation");
        let first_lease = first.committed.value.claimed_leases[0].clone();
        assert_eq!(first_lease.attempt, 1);

        harness
            .kernel
            .writer()
            .call({
                let lease_id = first_lease.lease_id.clone();
                move |connection| {
                    connection.execute(
                        "UPDATE core_automation_leases SET claimed_at_ms = 0, expires_at_ms = 1 \
                         WHERE lease_id = ?1",
                        [lease_id],
                    )?;
                    Ok(())
                }
            })
            .expect("expire lease");
        let second = apply(
            &harness,
            "claim-2",
            AutomationIntent::ClaimDue {
                work_token: definition_work_token(&harness),
                limit: 3,
                lease_duration_ms: 60_000,
            },
        )
        .expect("reclaim due Automation");
        let second_lease = second.committed.value.claimed_leases[0].clone();
        assert_eq!(second_lease.attempt, 2);

        let completed = apply(
            &harness,
            "complete-2",
            AutomationIntent::CompleteLease {
                lease_id: second_lease.lease_id.clone(),
            },
        )
        .expect("complete lease");
        assert!(
            completed.committed.value.definitions[0]
                .last_run_at_ms
                .is_some()
        );
        assert!(
            completed.committed.value.definitions[0]
                .next_run_at_ms
                .is_some()
        );
        let duplicate = apply(
            &harness,
            "complete-2",
            AutomationIntent::CompleteLease {
                lease_id: second_lease.lease_id,
            },
        )
        .expect("replay completion");
        assert!(duplicate.committed.receipt.mutation.duplicate);
    }

    #[test]
    fn untrusted_execution_intents_do_not_consume_due_work() {
        let harness = harness();
        create(&harness);
        harness
            .kernel
            .writer()
            .call(|connection| {
                connection.execute(
                    "UPDATE codex_scheduled_automations SET next_run_at = 0 \
                     WHERE automation_id = 'daily-report'",
                    [],
                )?;
                Ok(())
            })
            .expect("make Automation due");
        let mut context = harness.context.clone();
        context.adapter = AdapterKind::Agent;
        let error = harness
            .module
            .apply(
                &context,
                ModuleApplyRequest {
                    contract_version: AUTOMATION_CONTRACT_VERSION,
                    operation_id: "untrusted-claim".to_owned(),
                    store_epoch: harness.store_epoch.clone(),
                    intent: AutomationIntent::ClaimDue {
                        work_token: definition_work_token(&harness),
                        limit: 1,
                        lease_duration_ms: 60_000,
                    },
                },
            )
            .expect_err("Agent cannot claim");
        assert_eq!(
            error.code,
            nodex_core_contracts::CoreErrorCode::Unauthorized
        );
        let run_error = harness
            .module
            .apply(
                &context,
                ModuleApplyRequest {
                    contract_version: AUTOMATION_CONTRACT_VERSION,
                    operation_id: "untrusted-run".to_owned(),
                    store_epoch: harness.store_epoch.clone(),
                    intent: AutomationIntent::BeginRun {
                        thread_id: "pending:untrusted".to_owned(),
                        automation_id: "daily-report".to_owned(),
                        thread_title: None,
                        source_cwd: Some("/workspace/report".to_owned()),
                    },
                },
            )
            .expect_err("Agent cannot record a Host run");
        assert_eq!(
            run_error.code,
            nodex_core_contracts::CoreErrorCode::Unauthorized
        );
        let next_run = harness
            .kernel
            .readers()
            .read_default(|connection| {
                connection
                    .query_row(
                        "SELECT next_run_at FROM codex_scheduled_automations \
                         WHERE automation_id = 'daily-report'",
                        [],
                        |row| row.get::<_, i64>(0),
                    )
                    .map_err(Into::into)
            })
            .expect("due timestamp");
        assert_eq!(next_run, 0);
    }

    #[test]
    fn pause_cancels_claims_and_revision_fences_delete() {
        let harness = harness();
        create(&harness);
        harness
            .kernel
            .writer()
            .call(|connection| {
                connection.execute(
                    "UPDATE codex_scheduled_automations SET next_run_at = 0 \
                     WHERE automation_id = 'daily-report'",
                    [],
                )?;
                Ok(())
            })
            .expect("make Automation due");
        let claim = apply(
            &harness,
            "claim-before-pause",
            AutomationIntent::ClaimDue {
                work_token: definition_work_token(&harness),
                limit: 1,
                lease_duration_ms: 60_000,
            },
        )
        .expect("claim Automation");
        let lease_id = claim.committed.value.claimed_leases[0].lease_id.clone();

        let paused = apply(
            &harness,
            "pause-automation",
            AutomationIntent::UpdateDefinition {
                automation_id: "daily-report".to_owned(),
                expected_revision: 1,
                status: AutomationDefinitionStatus::Paused,
                definition: definition(),
            },
        )
        .expect("pause Automation");
        assert_eq!(paused.committed.value.definitions[0].definition_revision, 2);
        assert_eq!(paused.committed.value.definitions[0].next_run_at_ms, None);
        assert_eq!(
            paused.committed.receipt.affected_lease_ids.as_slice(),
            std::slice::from_ref(&lease_id)
        );
        let leases = harness
            .module
            .read(
                &harness.context,
                ModuleReadRequest {
                    contract_version: AUTOMATION_CONTRACT_VERSION,
                    read: AutomationRead::Leases {
                        automation_id: Some("daily-report".to_owned()),
                        include_settled: Some(true),
                        window: Default::default(),
                    },
                },
            )
            .expect("read leases");
        let AutomationReadValue::Leases { window } = leases.value else {
            panic!("lease snapshot");
        };
        let items = window.items;
        assert_eq!(items[0].status, AutomationLeaseStatus::Cancelled);

        let stale = apply(
            &harness,
            "stale-delete",
            AutomationIntent::DeleteDefinition {
                automation_id: "daily-report".to_owned(),
                expected_revision: 1,
            },
        )
        .expect_err("stale revision");
        assert_eq!(
            stale.code,
            nodex_core_contracts::CoreErrorCode::RevisionConflict
        );
        let deleted = apply(
            &harness,
            "delete-automation",
            AutomationIntent::DeleteDefinition {
                automation_id: "daily-report".to_owned(),
                expected_revision: 2,
            },
        )
        .expect("delete Automation");
        assert_eq!(
            deleted.committed.value.definitions[0].definition_revision,
            3
        );
        assert_eq!(
            deleted.committed.value.definitions[0].status,
            AutomationDefinitionStatus::Deleted
        );
    }

    #[test]
    fn definition_reschedule_is_revision_fenced_and_exactly_replayed() {
        let harness = harness();
        create(&harness);

        let rescheduled = apply(
            &harness,
            "reschedule-automation",
            AutomationIntent::RescheduleDefinition {
                automation_id: "daily-report".to_owned(),
                expected_revision: 1,
                not_before_ms: Some(4_000_000_000_000),
                retry_within_ms: None,
            },
        )
        .expect("reschedule Automation");
        assert_eq!(
            rescheduled.committed.value.definitions[0].next_run_at_ms,
            Some(4_000_000_000_000)
        );
        assert_eq!(
            rescheduled.committed.value.definitions[0].definition_revision,
            2
        );

        let replay = apply(
            &harness,
            "reschedule-automation",
            AutomationIntent::RescheduleDefinition {
                automation_id: "daily-report".to_owned(),
                expected_revision: 1,
                not_before_ms: Some(4_000_000_000_000),
                retry_within_ms: None,
            },
        )
        .expect("replay reschedule");
        assert!(replay.committed.receipt.mutation.duplicate);
        assert_eq!(
            replay.committed.event_sequence,
            rescheduled.committed.event_sequence
        );

        let stale = apply(
            &harness,
            "stale-reschedule",
            AutomationIntent::RescheduleDefinition {
                automation_id: "daily-report".to_owned(),
                expected_revision: 1,
                not_before_ms: Some(4_000_000_000_001),
                retry_within_ms: None,
            },
        )
        .expect_err("stale reschedule");
        assert_eq!(
            stale.code,
            nodex_core_contracts::CoreErrorCode::RevisionConflict
        );
    }

    #[test]
    fn failed_lease_records_reason_and_bounded_retry_without_last_run() {
        let harness = harness();
        create(&harness);
        harness
            .kernel
            .writer()
            .call(|connection| {
                connection.execute(
                    "UPDATE codex_scheduled_automations SET next_run_at = 0 \
                     WHERE automation_id = 'daily-report'",
                    [],
                )?;
                Ok(())
            })
            .expect("make Automation due");
        let claim = apply(
            &harness,
            "claim-before-failure",
            AutomationIntent::ClaimDue {
                work_token: definition_work_token(&harness),
                limit: 1,
                lease_duration_ms: 60_000,
            },
        )
        .expect("claim Automation");
        let lease_id = claim.committed.value.claimed_leases[0].lease_id.clone();
        let failed = apply(
            &harness,
            "fail-automation",
            AutomationIntent::FailLease {
                lease_id: lease_id.clone(),
                retry_delay_ms: Some(5_000),
                reason_code: "host_unavailable".to_owned(),
            },
        )
        .expect("fail lease");
        assert_eq!(failed.committed.value.definitions[0].last_run_at_ms, None);
        assert!(
            failed.committed.value.definitions[0]
                .next_run_at_ms
                .is_some()
        );
        let lease = harness
            .kernel
            .readers()
            .read_default(move |connection| super::read_lease(connection, &lease_id))
            .expect("failed lease")
            .expect("lease exists");
        assert_eq!(lease.status, AutomationLeaseStatus::Failed);
        assert_eq!(lease.reason_code.as_deref(), Some("host_unavailable"));
        assert!(lease.retry_at_ms.is_some());
    }

    #[test]
    fn run_lifecycle_is_revisioned_projected_and_exactly_replayed() {
        let harness = harness();
        create(&harness);
        let begun = apply(
            &harness,
            "begin-run",
            AutomationIntent::BeginRun {
                thread_id: "pending:run-1".to_owned(),
                automation_id: "daily-report".to_owned(),
                thread_title: Some("Daily report run".to_owned()),
                source_cwd: Some("/workspace/report".to_owned()),
            },
        )
        .expect("begin pending run");
        assert_eq!(begun.committed.value.runs[0].run_revision, 1);
        assert_eq!(
            begun.committed.value.runs[0].status,
            AutomationRunStatus::InProgress
        );
        let replay = apply(
            &harness,
            "begin-run",
            AutomationIntent::BeginRun {
                thread_id: "pending:run-1".to_owned(),
                automation_id: "daily-report".to_owned(),
                thread_title: Some("Daily report run".to_owned()),
                source_cwd: Some("/workspace/report".to_owned()),
            },
        )
        .expect("replay pending run");
        assert!(replay.committed.receipt.mutation.duplicate);
        assert_eq!(
            replay.committed.event_sequence,
            begun.committed.event_sequence
        );

        seed_thread(&harness, "thread:run-1");
        let replaced = apply(
            &harness,
            "replace-run-thread",
            AutomationIntent::ReplacePendingRunThread {
                pending_thread_id: "pending:run-1".to_owned(),
                thread_id: "thread:run-1".to_owned(),
                expected_revision: 1,
            },
        )
        .expect("replace pending Thread");
        assert_eq!(replaced.committed.value.runs[0].run_revision, 2);
        assert_eq!(
            replaced.committed.receipt.affected_run_ids,
            vec!["pending:run-1".to_owned(), "thread:run-1".to_owned()]
        );
        let titled = apply(
            &harness,
            "title-run",
            AutomationIntent::SetRunThreadTitle {
                thread_id: "thread:run-1".to_owned(),
                expected_revision: 2,
                thread_title: Some("Daily report result".to_owned()),
            },
        )
        .expect("title run");
        assert_eq!(titled.committed.value.runs[0].run_revision, 3);
        assert_eq!(
            titled.committed.value.runs[0].thread_title.as_deref(),
            Some("Daily report result")
        );
        let completed = apply(
            &harness,
            "complete-run",
            AutomationIntent::CompleteRunForReview {
                thread_id: "thread:run-1".to_owned(),
                expected_revision: 3,
                inbox_title: Some("Report ready".to_owned()),
                inbox_summary: Some("Review the generated summary.".to_owned()),
            },
        )
        .expect("complete run");
        assert_eq!(completed.committed.value.runs[0].run_revision, 4);
        assert_eq!(
            completed.committed.value.runs[0].status,
            AutomationRunStatus::PendingReview
        );
        let inbox_updated = apply(
            &harness,
            "update-run-inbox",
            AutomationIntent::SetRunInboxItem {
                thread_id: "thread:run-1".to_owned(),
                expected_revision: 4,
                inbox_title: Some("Report delivered".to_owned()),
                inbox_summary: Some("Review the generated summary.".to_owned()),
            },
        )
        .expect("update run inbox");
        assert_eq!(inbox_updated.committed.value.runs[0].run_revision, 5);

        let inbox = harness
            .module
            .read(
                &harness.context,
                ModuleReadRequest {
                    contract_version: AUTOMATION_CONTRACT_VERSION,
                    read: AutomationRead::Inbox {
                        window: Default::default(),
                    },
                },
            )
            .expect("read run inbox");
        let AutomationReadValue::Inbox {
            window,
            unread_counts,
        } = inbox.value
        else {
            panic!("inbox snapshot");
        };
        let items = window.items;
        assert_eq!(items[0].title.as_deref(), Some("Daily report"));
        assert_eq!(
            items[0].description.as_deref(),
            Some("Review the generated summary.")
        );
        assert_eq!(unread_counts.total, 1);

        let read = apply(
            &harness,
            "read-run",
            AutomationIntent::SetRunReadState {
                thread_id: "thread:run-1".to_owned(),
                expected_revision: 5,
                read: true,
            },
        )
        .expect("read run");
        assert!(read.committed.value.runs[0].read_at_ms.is_some());
        let accepted = apply(
            &harness,
            "accept-run",
            AutomationIntent::AcceptRun {
                thread_id: "thread:run-1".to_owned(),
                expected_revision: 6,
            },
        )
        .expect("accept run");
        assert_eq!(
            accepted.committed.value.runs[0].status,
            AutomationRunStatus::Accepted
        );
        let archived = apply(
            &harness,
            "archive-run",
            AutomationIntent::ArchiveRun {
                thread_id: "thread:run-1".to_owned(),
                expected_revision: 7,
                archived_user_message: None,
                archived_assistant_message: Some("Done".to_owned()),
                archived_reason: Some("manual".to_owned()),
            },
        )
        .expect("archive run");
        assert_eq!(archived.committed.value.runs[0].run_revision, 8);
        let restored = apply(
            &harness,
            "unarchive-run",
            AutomationIntent::UnarchiveRun {
                thread_id: "thread:run-1".to_owned(),
                expected_revision: 8,
            },
        )
        .expect("restore run");
        assert_eq!(
            restored.committed.value.runs[0].status,
            AutomationRunStatus::Accepted
        );
        let deleted = apply(
            &harness,
            "delete-run",
            AutomationIntent::DeleteRun {
                thread_id: "thread:run-1".to_owned(),
                expected_revision: 9,
            },
        )
        .expect("delete run");
        assert_eq!(
            deleted.committed.value.deleted_run_ids,
            vec!["thread:run-1".to_owned()]
        );
        let snapshot = harness
            .module
            .read(
                &harness.context,
                ModuleReadRequest {
                    contract_version: AUTOMATION_CONTRACT_VERSION,
                    read: AutomationRead::Run {
                        thread_id: "thread:run-1".to_owned(),
                    },
                },
            )
            .expect("read deleted run");
        let AutomationReadValue::Run { item } = snapshot.value else {
            panic!("run snapshot");
        };
        assert!(item.is_none());
    }

    #[test]
    fn interrupted_and_bulk_read_transitions_are_bounded_and_definition_owned() {
        let harness = harness();
        create(&harness);
        seed_thread(&harness, "thread:interrupted");
        for (operation_id, thread_id) in [
            ("begin-pending-interrupted", "pending:interrupted"),
            ("begin-real-interrupted", "thread:interrupted"),
        ] {
            apply(
                &harness,
                operation_id,
                AutomationIntent::BeginRun {
                    thread_id: thread_id.to_owned(),
                    automation_id: "daily-report".to_owned(),
                    thread_title: None,
                    source_cwd: Some("/workspace/report".to_owned()),
                },
            )
            .expect("begin interrupted run");
        }
        let settled = apply(
            &harness,
            "settle-interrupted",
            AutomationIntent::SettleInterruptedRuns,
        )
        .expect("settle interrupted runs");
        let bulk = settled
            .committed
            .value
            .run_bulk
            .as_ref()
            .expect("bulk result");
        assert_eq!(bulk.changed_count, 2);
        assert_eq!(bulk.archived_pending_count, 1);
        assert_eq!(bulk.pending_review_count, 1);
        assert!(!bulk.has_more);
        assert_eq!(
            settled
                .committed
                .value
                .runs
                .iter()
                .map(|run| (run.thread_id.clone(), run.status))
                .collect::<Vec<_>>(),
            vec![
                (
                    "pending:interrupted".to_owned(),
                    AutomationRunStatus::Archived
                ),
                (
                    "thread:interrupted".to_owned(),
                    AutomationRunStatus::PendingReview
                ),
            ]
        );
        let replay = apply(
            &harness,
            "settle-interrupted",
            AutomationIntent::SettleInterruptedRuns,
        )
        .expect("replay interrupted settlement");
        assert!(replay.committed.receipt.mutation.duplicate);

        let marked = apply(
            &harness,
            "mark-all-runs-read",
            AutomationIntent::MarkAllRunsRead,
        )
        .expect("mark all runs read");
        assert_eq!(
            marked
                .committed
                .value
                .run_bulk
                .as_ref()
                .expect("mark-all result")
                .changed_count,
            2
        );
        assert!(
            marked
                .committed
                .value
                .runs
                .iter()
                .all(|run| run.read_at_ms.is_some() && run.run_revision == 3)
        );
        let stale = apply(
            &harness,
            "stale-run-read",
            AutomationIntent::SetRunReadState {
                thread_id: "thread:interrupted".to_owned(),
                expected_revision: 2,
                read: false,
            },
        )
        .expect_err("stale run revision");
        assert_eq!(
            stale.code,
            nodex_core_contracts::CoreErrorCode::RevisionConflict
        );

        let deleted = apply(
            &harness,
            "delete-definition-with-runs",
            AutomationIntent::DeleteDefinition {
                automation_id: "daily-report".to_owned(),
                expected_revision: 1,
            },
        )
        .expect("delete definition aggregate");
        assert_eq!(
            deleted.committed.value.deleted_run_ids,
            vec![
                "pending:interrupted".to_owned(),
                "thread:interrupted".to_owned(),
            ]
        );
        assert_eq!(
            deleted.committed.receipt.affected_run_ids,
            deleted.committed.value.deleted_run_ids
        );
    }

    #[test]
    fn scheduled_page_occurrences_are_authorized_current_head_snapshots() {
        let harness = harness();
        seed_scheduled_page(
            &harness,
            "page:calendar",
            "Calendar authority",
            "2026-07-17T09:00:00Z".parse().expect("start"),
            "2026-07-17T10:00:00Z".parse().expect("end"),
            json!({ "frequency": "daily", "interval": 1 }),
            json!([{ "offsetMinutes": 30 }]),
        );
        let context = project_context(&harness);
        let snapshot = harness
            .module
            .read(
                &context,
                ModuleReadRequest {
                    contract_version: AUTOMATION_CONTRACT_VERSION,
                    read: AutomationRead::Occurrences {
                        window_start_ms: "2026-07-18T00:00:00Z"
                            .parse::<chrono::DateTime<Utc>>()
                            .expect("window start")
                            .timestamp_millis(),
                        window_end_ms: "2026-07-20T00:00:00Z"
                            .parse::<chrono::DateTime<Utc>>()
                            .expect("window end")
                            .timestamp_millis(),
                        search_query: Some("nodex-1".to_owned()),
                        window: Default::default(),
                    },
                },
            )
            .expect("read occurrences");
        let AutomationReadValue::Occurrences { window } = snapshot.value else {
            panic!("occurrence snapshot");
        };
        let items = window.items;
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].title, "Calendar authority");
        assert_eq!(items[0].page_key.as_deref(), Some("NODEX-1"));
        assert_eq!(items[0].status, "triage");
        assert_eq!(items[0].status_name, "Triage");
        assert_eq!(items[0].reminders[0].offset_minutes, 30);
        assert!(items[0].is_recurring);
        assert!(!items[0].this_and_future_equivalent_to_all);

        harness
            .kernel
            .writer()
            .call(|connection| {
                connection.execute(
                    "UPDATE documents SET head_seq = head_seq + 1 \
                     WHERE id = 'document:page:calendar'",
                    [],
                )?;
                Ok(())
            })
            .expect("make materialization stale");
        let stale = harness
            .module
            .read(
                &context,
                ModuleReadRequest {
                    contract_version: AUTOMATION_CONTRACT_VERSION,
                    read: AutomationRead::Occurrences {
                        window_start_ms: "2026-07-18T00:00:00Z"
                            .parse::<chrono::DateTime<Utc>>()
                            .expect("window start")
                            .timestamp_millis(),
                        window_end_ms: "2026-07-20T00:00:00Z"
                            .parse::<chrono::DateTime<Utc>>()
                            .expect("window end")
                            .timestamp_millis(),
                        search_query: None,
                        window: nodex_core_contracts::collection::CollectionWindowRequest {
                            after: None,
                            first: Some(10),
                        },
                    },
                },
            )
            .expect_err("stale materialization is rejected");
        assert_eq!(
            stale.code,
            nodex_core_contracts::CoreErrorCode::StoreCorrupt
        );
    }

    #[test]
    fn occurrence_order_preparation_survives_rollback_and_reaches_the_caller() {
        let harness = harness();
        let start = "2026-07-17T09:00:00Z"
            .parse::<chrono::DateTime<Utc>>()
            .unwrap();
        let end = "2026-07-17T10:00:00Z"
            .parse::<chrono::DateTime<Utc>>()
            .unwrap();
        seed_scheduled_page(
            &harness,
            "page:order-preparation",
            "Order preparation",
            start,
            end,
            json!({ "frequency": "daily", "interval": 1 }),
            json!([]),
        );
        // Physical pressure fixture: no rank remains after the canonical source row.
        harness.kernel.writer().call(|connection| {
            connection.execute_batch(
                "WITH RECURSIVE pressure(n) AS (VALUES(1) UNION ALL SELECT n + 1 FROM pressure WHERE n < 256) \
                 INSERT INTO blocks(id, library_id, type, lifecycle, created_at, updated_at) \
                 SELECT printf('a:retained:%03d', n), 'library-1', 'page', 'archived', 'created', 'updated' FROM pressure; \
                 INSERT INTO database_view_order_rows(view_id, generation, page_block_id, rank_key, default_epoch, revision, is_active, is_task_root, created_at, updated_at) \
                 SELECT position.view_id, position.generation, block.id, 'ffffffffffffffffffffffffffffffff', NULL, 1, 0, 1, 'created', 'updated' \
                 FROM database_view_order_rows position CROSS JOIN blocks block \
                 WHERE position.page_block_id = 'page:order-preparation' AND block.id LIKE 'a:retained:%';"
            )?;
            connection.execute("UPDATE database_view_order_rows SET rank_key = 'ffffffffffffffffffffffffffffffff' WHERE page_block_id = 'page:order-preparation'", [])?;
            Ok(())
        }).unwrap();
        let created_page_id = "018f1000-0000-7000-8000-000000000199";
        let error = apply_with_context(
            &harness,
            &project_context(&harness),
            "occurrence:order-preparation",
            AutomationIntent::CompletePageOccurrence {
                page_id: "page:order-preparation".into(),
                occurrence_start_ms: start.timestamp_millis(),
                created_page_id: created_page_id.into(),
            },
        )
        .expect_err("rank preparation required");
        assert_eq!(
            error.code,
            nodex_core_contracts::CoreErrorCode::MaintenanceInProgress
        );
        let nodex_core_contracts::CoreErrorRecovery::DatabaseViewOrderPreparation { view_id } =
            error.recovery
        else {
            panic!("Automation must preserve the exact preparation coordinate");
        };
        harness.kernel.readers().read_default(move |connection| {
            let phase: String = connection.query_row("SELECT phase FROM database_view_order_state WHERE view_id = ?1", [view_id], |row| row.get(0))?;
            assert_eq!(phase, "rebalance", "preparation survives semantic rollback");
            let created: i64 = connection.query_row("SELECT count(*) FROM pages WHERE block_id = ?1", [created_page_id], |row| row.get(0))?;
            assert_eq!(created, 0, "failed occurrence did not leave a copied Page");
            let receipt: i64 = connection.query_row("SELECT count(*) FROM core_module_receipts WHERE operation_id = 'occurrence:order-preparation'", [], |row| row.get(0))?;
            assert_eq!(receipt, 0, "failed occurrence has no success receipt");
            Ok(())
        }).unwrap();
    }

    #[test]
    fn occurrence_mutations_clone_advance_reject_and_replay_atomically() {
        let harness = harness();
        let start = "2026-07-17T09:00:00Z"
            .parse::<chrono::DateTime<Utc>>()
            .expect("start");
        let end = "2026-07-17T10:00:00Z"
            .parse::<chrono::DateTime<Utc>>()
            .expect("end");
        seed_scheduled_page(
            &harness,
            "page:occurrence-mutation",
            "Occurrence authority",
            start,
            end,
            json!({ "frequency": "daily", "interval": 1 }),
            json!([{ "offsetMinutes": 30 }]),
        );
        let context = project_context(&harness);
        let created_page_id = "018f1000-0000-7000-8000-000000000101";
        let completed = apply_with_context(
            &harness,
            &context,
            "occurrence:complete",
            AutomationIntent::CompletePageOccurrence {
                page_id: "page:occurrence-mutation".to_owned(),
                occurrence_start_ms: start.timestamp_millis(),
                created_page_id: created_page_id.to_owned(),
            },
        )
        .expect("complete occurrence");
        let result = completed
            .committed
            .value
            .page_occurrence_mutation
            .as_ref()
            .expect("occurrence result");
        assert!(result.success);
        assert_eq!(result.created_page_id.as_deref(), Some(created_page_id));
        assert_eq!(result.commit_seq, Some(completed.committed.commit_seq));
        assert_eq!(
            completed.committed.receipt.affected_page_ids,
            vec![
                created_page_id.to_owned(),
                "page:occurrence-mutation".to_owned()
            ]
        );
        let manifest = harness
            .kernel
            .readers()
            .read_default(|connection| {
                crate::infrastructure::local_commit::read_manifest(
                    connection,
                    completed.committed.commit_seq,
                )
            })
            .expect("Page occurrence CommitManifest");
        assert!(manifest.projection_effects.iter().any(|effect| {
            matches!(
                &effect.scope.scope,
                nodex_core_contracts::LocalProjectionScope::Page {
                    project_id,
                    page_id,
                } if project_id == "project:default" && page_id == "page:occurrence-mutation"
            )
        }));
        assert!(manifest.projection_effects.iter().any(|effect| {
            matches!(
                &effect.scope.scope,
                nodex_core_contracts::LocalProjectionScope::DatabaseView {
                    project_id,
                    ..
                } if project_id == "project:default"
            )
        }));
        assert!(!manifest.projection_effects.iter().any(|effect| {
            matches!(
                &effect.scope.scope,
                nodex_core_contracts::LocalProjectionScope::Project { .. }
            )
        }));
        let authority = harness
            .kernel
            .readers()
            .read_default({
                let created_page_id = created_page_id.to_owned();
                move |connection| {
                    connection
                        .query_row(
                            "SELECT source.scheduled_start, source.scheduled_end, clone.lifecycle, \
                               clone_schedule.scheduled_start, clone_schedule.scheduled_end, \
                               clone_schedule.recurrence_json, clone_schedule.reminders_json, \
                               document.readiness, document.authority, materialization.title \
                             FROM scheduled_page_index source \
                             JOIN blocks clone ON clone.id = ?1 \
                             JOIN scheduled_page_index clone_schedule ON clone_schedule.page_block_id = clone.id \
                             JOIN block_documents ownership ON ownership.block_id = clone.id \
                             JOIN documents document ON document.id = ownership.document_id \
                             JOIN document_materializations materialization ON materialization.document_id = document.id \
                             WHERE source.page_block_id = 'page:occurrence-mutation'",
                            [created_page_id],
                            |row| {
                                Ok((
                                    row.get::<_, String>(0)?,
                                    row.get::<_, String>(1)?,
                                    row.get::<_, String>(2)?,
                                    row.get::<_, String>(3)?,
                                    row.get::<_, String>(4)?,
                                    row.get::<_, String>(5)?,
                                    row.get::<_, String>(6)?,
                                    row.get::<_, String>(7)?,
                                    row.get::<_, String>(8)?,
                                    row.get::<_, String>(9)?,
                                ))
                            },
                        )
                        .map_err(Into::into)
                }
            })
            .expect("read occurrence authority");
        assert_eq!(authority.0, "2026-07-18T09:00:00.000Z");
        assert_eq!(authority.1, "2026-07-18T10:00:00.000Z");
        assert_eq!(authority.2, "archived");
        assert_eq!(authority.3, "2026-07-17T09:00:00.000Z");
        assert_eq!(authority.4, "2026-07-17T10:00:00.000Z");
        assert_eq!(authority.5, "null");
        assert_eq!(authority.6, "[]");
        assert_eq!(authority.7, "ready");
        assert_eq!(authority.8, "ydoc_primary");
        assert_eq!(authority.9, "Occurrence authority");

        let replay = apply_with_context(
            &harness,
            &BoundModuleContext {
                editor_history_owner: None,
                connection_id: "another-connection".to_owned(),
                adapter: AdapterKind::NativeCli,
                ..context.clone()
            },
            "occurrence:complete",
            AutomationIntent::CompletePageOccurrence {
                page_id: "page:occurrence-mutation".to_owned(),
                occurrence_start_ms: start.timestamp_millis(),
                created_page_id: created_page_id.to_owned(),
            },
        )
        .expect("cross-Adapter exact replay");
        assert!(replay.committed.receipt.mutation.duplicate);
        assert!(
            replay
                .committed
                .value
                .page_occurrence_mutation
                .expect("replay outcome")
                .duplicate
        );

        let rejected = apply_with_context(
            &harness,
            &context,
            "occurrence:rejected",
            AutomationIntent::UpdatePageOccurrence {
                page_id: "page:occurrence-mutation".to_owned(),
                occurrence_start_ms: start.timestamp_millis(),
                scope: PageOccurrenceUpdateScope::All,
                created_page_id: Some("018f1000-0000-7000-8000-000000000102".to_owned()),
                updates: PageOccurrenceSchedulePatch {
                    is_all_day: Some(false),
                    ..PageOccurrenceSchedulePatch::default()
                },
            },
        )
        .expect("durable rejection");
        assert!(rejected.event.is_none());
        assert!(
            !rejected
                .committed
                .value
                .page_occurrence_mutation
                .as_ref()
                .expect("rejection outcome")
                .success
        );
        let rejection_replay = apply_with_context(
            &harness,
            &context,
            "occurrence:rejected",
            AutomationIntent::UpdatePageOccurrence {
                page_id: "page:occurrence-mutation".to_owned(),
                occurrence_start_ms: start.timestamp_millis(),
                scope: PageOccurrenceUpdateScope::All,
                created_page_id: Some("018f1000-0000-7000-8000-000000000102".to_owned()),
                updates: PageOccurrenceSchedulePatch {
                    is_all_day: Some(false),
                    ..PageOccurrenceSchedulePatch::default()
                },
            },
        )
        .expect("replay rejection");
        assert!(
            rejection_replay
                .committed
                .value
                .page_occurrence_mutation
                .expect("replayed rejection")
                .duplicate
        );
    }

    #[test]
    fn occurrence_mutation_rolls_back_when_receipt_commit_fails() {
        let harness = harness();
        let start = "2026-07-17T09:00:00Z"
            .parse::<chrono::DateTime<Utc>>()
            .expect("start");
        let end = start + Duration::hours(1);
        seed_scheduled_page(
            &harness,
            "page:occurrence-rollback",
            "Rollback authority",
            start,
            end,
            json!({ "frequency": "daily", "interval": 1 }),
            json!([{ "offsetMinutes": 30 }]),
        );
        harness
            .kernel
            .writer()
            .call(|connection| {
                connection.execute_batch(
                    "CREATE TEMP TRIGGER fail_occurrence_receipt \
                     BEFORE INSERT ON core_module_receipts \
                     WHEN NEW.operation_id = 'occurrence:rollback' BEGIN \
                       SELECT RAISE(ABORT, 'injected occurrence receipt failure'); \
                     END;",
                )?;
                Ok(())
            })
            .expect("install receipt fault");
        let created_page_id = "018f1000-0000-7000-8000-000000000199";

        let error = apply_with_context(
            &harness,
            &project_context(&harness),
            "occurrence:rollback",
            AutomationIntent::CompletePageOccurrence {
                page_id: "page:occurrence-rollback".to_owned(),
                occurrence_start_ms: start.timestamp_millis(),
                created_page_id: created_page_id.to_owned(),
            },
        )
        .expect_err("receipt failure must roll back the occurrence aggregate");
        assert_eq!(
            error.code,
            nodex_core_contracts::CoreErrorCode::CoreUnavailable
        );

        let evidence = harness
            .kernel
            .readers()
            .read_default({
                let created_page_id = created_page_id.to_owned();
                move |connection| {
                    connection
                        .query_row(
                            "SELECT schedule.scheduled_start, schedule.scheduled_end, \
                               (SELECT count(*) FROM blocks WHERE id = ?1), \
                               (SELECT count(*) FROM scheduled_page_index WHERE page_block_id = ?1), \
                               (SELECT count(*) FROM core_module_receipts \
                                 WHERE operation_id = 'occurrence:rollback'), \
                               (SELECT count(*) FROM change_log \
                                 WHERE operation_id = 'occurrence:rollback') \
                             FROM scheduled_page_index schedule \
                             WHERE schedule.page_block_id = 'page:occurrence-rollback'",
                            [created_page_id],
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
                        )
                        .map_err(Into::into)
                }
            })
            .expect("read occurrence rollback evidence");
        assert_eq!(evidence.0, "2026-07-17T09:00:00.000Z");
        assert_eq!(evidence.1, "2026-07-17T10:00:00.000Z");
        assert_eq!(
            (evidence.2, evidence.3, evidence.4, evidence.5),
            (0, 0, 0, 0)
        );
    }

    #[test]
    fn occurrence_update_scopes_and_skip_preserve_series_boundaries() {
        let harness = harness();
        let context = project_context(&harness);
        let start = "2026-07-17T09:00:00Z"
            .parse::<chrono::DateTime<Utc>>()
            .expect("start");
        let end = start + Duration::hours(1);

        seed_scheduled_page(
            &harness,
            "page:detach-occurrence",
            "Detach occurrence",
            start,
            end,
            json!({ "frequency": "daily", "interval": 1 }),
            json!([{ "offsetMinutes": 30 }]),
        );
        let detached_page_id = "018f1000-0000-7000-8000-000000000201";
        let detached_occurrence = start + Duration::days(1);
        let detached_start = detached_occurrence + Duration::hours(2);
        let detached = apply_with_context(
            &harness,
            &context,
            "occurrence:update-this",
            AutomationIntent::UpdatePageOccurrence {
                page_id: "page:detach-occurrence".to_owned(),
                occurrence_start_ms: detached_occurrence.timestamp_millis(),
                scope: PageOccurrenceUpdateScope::This,
                created_page_id: Some(detached_page_id.to_owned()),
                updates: PageOccurrenceSchedulePatch {
                    scheduled_start_ms: Some(Some(detached_start.timestamp_millis())),
                    scheduled_end_ms: Some(Some(
                        (detached_start + Duration::hours(1)).timestamp_millis(),
                    )),
                    ..PageOccurrenceSchedulePatch::default()
                },
            },
        )
        .expect("detach one occurrence");
        assert!(
            detached
                .committed
                .value
                .page_occurrence_mutation
                .expect("detach result")
                .success
        );

        seed_scheduled_page(
            &harness,
            "page:split-occurrence",
            "Split occurrence",
            start,
            end,
            json!({ "frequency": "daily", "interval": 1 }),
            json!([]),
        );
        let split_page_id = "018f1000-0000-7000-8000-000000000202";
        let split_occurrence = start + Duration::days(2);
        let split_start = split_occurrence + Duration::hours(4);
        let split = apply_with_context(
            &harness,
            &context,
            "occurrence:update-this-and-future",
            AutomationIntent::UpdatePageOccurrence {
                page_id: "page:split-occurrence".to_owned(),
                occurrence_start_ms: split_occurrence.timestamp_millis(),
                scope: PageOccurrenceUpdateScope::ThisAndFuture,
                created_page_id: Some(split_page_id.to_owned()),
                updates: PageOccurrenceSchedulePatch {
                    scheduled_start_ms: Some(Some(split_start.timestamp_millis())),
                    scheduled_end_ms: Some(Some(
                        (split_start + Duration::hours(1)).timestamp_millis(),
                    )),
                    ..PageOccurrenceSchedulePatch::default()
                },
            },
        )
        .expect("split series");
        assert_eq!(
            split
                .committed
                .value
                .page_occurrence_mutation
                .expect("split result")
                .created_page_id
                .as_deref(),
            Some(split_page_id)
        );

        seed_scheduled_page(
            &harness,
            "page:skip-once",
            "Skip once",
            start,
            end,
            Value::Null,
            json!([]),
        );
        let skipped = apply_with_context(
            &harness,
            &context,
            "occurrence:skip-once",
            AutomationIntent::SkipPageOccurrence {
                page_id: "page:skip-once".to_owned(),
                occurrence_start_ms: start.timestamp_millis(),
            },
        )
        .expect("skip one-time Page");
        assert!(
            skipped
                .committed
                .value
                .page_occurrence_mutation
                .expect("skip result")
                .success
        );

        let authority = harness
            .kernel
            .readers()
            .read_default({
                let detached_page_id = detached_page_id.to_owned();
                let split_page_id = split_page_id.to_owned();
                move |connection| {
                    let detached = connection.query_row(
                        "SELECT scheduled_start, recurrence_json FROM scheduled_page_index \
                         WHERE page_block_id = ?1",
                        [&detached_page_id],
                        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                    )?;
                    let exception_count =
                        connection.query_row(
                            "SELECT COUNT(*) FROM recurrence_exceptions \
                         WHERE page_id = 'page:detach-occurrence' \
                           AND occurrence_start = ?1 AND exception_type = 'skip'",
                            [detached_occurrence
                                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)],
                            |row| row.get::<_, i64>(0),
                        )?;
                    let source_recurrence = connection.query_row(
                        "SELECT recurrence_json FROM scheduled_page_index \
                         WHERE page_block_id = 'page:split-occurrence'",
                        [],
                        |row| row.get::<_, String>(0),
                    )?;
                    let split_clone = connection.query_row(
                        "SELECT scheduled_start, recurrence_json FROM scheduled_page_index \
                         WHERE page_block_id = ?1",
                        [&split_page_id],
                        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                    )?;
                    let skipped_schedule = connection.query_row(
                        "SELECT scheduled_start, scheduled_end FROM scheduled_page_index \
                         WHERE page_block_id = 'page:skip-once'",
                        [],
                        |row| {
                            Ok((
                                row.get::<_, Option<String>>(0)?,
                                row.get::<_, Option<String>>(1)?,
                            ))
                        },
                    )?;
                    Ok((
                        detached,
                        exception_count,
                        source_recurrence,
                        split_clone,
                        skipped_schedule,
                    ))
                }
            })
            .expect("read occurrence scope authority");
        assert_eq!(authority.0.0, "2026-07-18T11:00:00.000Z");
        assert_eq!(authority.0.1, "null");
        assert_eq!(authority.1, 1);
        assert_eq!(
            serde_json::from_str::<Value>(&authority.2)
                .expect("source recurrence")
                .pointer("/endCondition/untilDate")
                .and_then(Value::as_str),
            Some("2026-07-18")
        );
        assert_eq!(authority.3.0, "2026-07-19T13:00:00.000Z");
        assert_eq!(
            serde_json::from_str::<Value>(&authority.3.1)
                .expect("clone recurrence")
                .get("frequency")
                .and_then(Value::as_str),
            Some("daily")
        );
        assert_eq!(authority.4, (None, None));
    }

    #[test]
    fn reminder_delivery_uses_reclaimable_leases_and_atomic_receipts() {
        let harness = harness();
        let now = Utc::now();
        let occurrence_start = now - Duration::minutes(5);
        seed_scheduled_page(
            &harness,
            "page:reminder",
            "Durable reminder",
            occurrence_start,
            occurrence_start + Duration::hours(1),
            serde_json::Value::Null,
            json!([{ "offsetMinutes": 0 }]),
        );

        let first_work_token = reminder_work_token(&harness);
        let first = apply(
            &harness,
            "claim-reminder-1",
            AutomationIntent::ClaimDueReminders {
                work_token: first_work_token.clone(),
                limit: 10,
                lease_duration_ms: 60_000,
            },
        )
        .expect("claim due reminder");
        assert_eq!(first.committed.value.reminder_leases.len(), 1);
        let first_lease = first.committed.value.reminder_leases[0].clone();
        assert_eq!(first_lease.attempt, 1);
        assert_eq!(first_lease.status, ReminderLeaseStatus::Claimed);
        assert_eq!(first_lease.title, "Durable reminder");
        let replay = apply(
            &harness,
            "claim-reminder-1",
            AutomationIntent::ClaimDueReminders {
                work_token: first_work_token,
                limit: 10,
                lease_duration_ms: 60_000,
            },
        )
        .expect("replay reminder claim");
        assert!(replay.committed.receipt.mutation.duplicate);
        assert_eq!(
            replay.committed.value.reminder_leases,
            vec![first_lease.clone()]
        );

        harness
            .kernel
            .writer()
            .call({
                let lease_id = first_lease.lease_id.clone();
                move |connection| {
                    connection.execute(
                        "UPDATE core_reminder_leases SET claimed_at_ms = 0, expires_at_ms = 1 \
                         WHERE lease_id = ?1",
                        [lease_id],
                    )?;
                    Ok(())
                }
            })
            .expect("expire reminder lease");
        let reclaimed = apply(
            &harness,
            "claim-reminder-2",
            AutomationIntent::ClaimDueReminders {
                work_token: reminder_work_token(&harness),
                limit: 10,
                lease_duration_ms: 60_000,
            },
        )
        .expect("reclaim reminder");
        let second_lease = reclaimed.committed.value.reminder_leases[0].clone();
        assert_eq!(second_lease.attempt, 2);
        assert!(
            reclaimed
                .committed
                .receipt
                .affected_reminder_lease_ids
                .contains(&first_lease.lease_id)
        );
        apply(
            &harness,
            "complete-reminder-2",
            AutomationIntent::CompleteReminderLease {
                lease_id: second_lease.lease_id,
            },
        )
        .expect("complete reminder lease");
        let completed_plan = harness
            .kernel
            .readers()
            .read_default(|connection| {
                crate::automation::reminder::plan_due_work(connection, "library-1")
            })
            .expect("plan completed Reminder");
        assert!(!completed_plan.due_now);
        assert!(completed_plan.work_token.is_none());

        let context = project_context(&harness);
        let snoozed = apply_with_context(
            &harness,
            &context,
            "snooze-reminder",
            AutomationIntent::SnoozeReminder {
                page_id: "page:reminder".to_owned(),
                occurrence_start_ms: occurrence_start.timestamp_millis(),
                snooze_minutes: 1,
            },
        )
        .expect("snooze reminder");
        let snooze_id = snoozed.committed.value.reminder_snoozes[0].snooze_id;
        harness
            .kernel
            .writer()
            .call(move |connection| {
                connection.execute(
                    "UPDATE reminder_snoozes SET due_at = \
                       strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 second') WHERE id = ?1",
                    [snooze_id],
                )?;
                Ok(())
            })
            .expect("make snooze due");
        let snooze_claim = apply(
            &harness,
            "claim-snooze-1",
            AutomationIntent::ClaimDueReminders {
                work_token: reminder_work_token(&harness),
                limit: 10,
                lease_duration_ms: 60_000,
            },
        )
        .expect("claim due snooze");
        let snooze_lease = snooze_claim
            .committed
            .value
            .reminder_leases
            .iter()
            .find(|lease| lease.reminder_offset_minutes == -1)
            .expect("snooze lease")
            .clone();
        apply(
            &harness,
            "fail-snooze-1",
            AutomationIntent::FailReminderLease {
                lease_id: snooze_lease.lease_id,
                retry_delay_ms: Some(0),
                reason_code: "notification_unavailable".to_owned(),
            },
        )
        .expect("fail snooze delivery");
        let retried = apply(
            &harness,
            "claim-snooze-2",
            AutomationIntent::ClaimDueReminders {
                work_token: reminder_work_token(&harness),
                limit: 10,
                lease_duration_ms: 60_000,
            },
        )
        .expect("retry snooze delivery");
        let retried_snooze = retried
            .committed
            .value
            .reminder_leases
            .iter()
            .find(|lease| lease.reminder_offset_minutes == -1)
            .expect("retried snooze")
            .clone();
        assert_eq!(retried_snooze.attempt, 2);
        let completed = apply(
            &harness,
            "complete-snooze-2",
            AutomationIntent::CompleteReminderLease {
                lease_id: retried_snooze.lease_id,
            },
        )
        .expect("complete snooze");
        assert!(
            completed
                .committed
                .value
                .reminder_snoozes
                .iter()
                .all(|snooze| snooze.consumed_at_ms.is_some())
        );

        let lease_snapshot = harness
            .module
            .read(
                &context,
                ModuleReadRequest {
                    contract_version: AUTOMATION_CONTRACT_VERSION,
                    read: AutomationRead::ReminderLeases {
                        include_settled: Some(true),
                        window: nodex_core_contracts::collection::CollectionWindowRequest {
                            after: None,
                            first: Some(20),
                        },
                    },
                },
            )
            .expect("read reminder leases");
        let AutomationReadValue::ReminderLeases { window } = lease_snapshot.value else {
            panic!("reminder lease snapshot");
        };
        let items = window.items;
        assert_eq!(items.len(), 4);
    }
}
