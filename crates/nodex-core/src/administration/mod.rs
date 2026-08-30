mod backup;
mod operation_journal;
mod profile_clone;
mod restore;

#[cfg(test)]
mod tests;

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, TryLockError};
use std::time::{Duration, Instant};

use nodex_core_contracts::administration::{
    BackupJobPhase, BackupJobState, BackupRecord, BackupStartCoalescence, BackupTrigger,
    MaintenanceDueWorkPlan, MaintenanceTask, SchemaOwner, StoreAdministrationCommitValue,
    StoreAdministrationEvent, StoreAdministrationEventKind, StoreAdministrationIntent,
    StoreAdministrationRead, StoreAdministrationReadValue, StoreAdministrationReceipt,
    StoreIntegrity, StoreReadiness,
};
use nodex_core_contracts::collection::{
    CollectionWindow, CollectionWindowAuthority, CollectionWindowRequest,
};
use nodex_core_contracts::{
    AdapterKind, BoundModuleContext, CommittedCoreModuleEvent, CoreError, CoreErrorCode,
    CoreErrorRecovery, ModuleApplyRequest, ModuleMutationReceipt, ModuleName, ModuleReadRequest,
    ModuleReadSnapshot, STORE_ADMINISTRATION_CONTRACT_VERSION, StoreEpoch,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Deserializer, Serialize};
use sha2::{Digest, Sha256};

use crate::infrastructure::collection_window::{WindowCandidate, assemble, normalize_request};
use crate::infrastructure::cursor::{
    self, CollectionCursorSubject, CursorDirection, KeysetCoordinate, KeysetValue,
};
use crate::infrastructure::durable_mutation::{
    self, CommitResult, OperationIdentity, ReceiptMetadata, ReplayIdentity,
};
use crate::infrastructure::local_commit;
use crate::infrastructure::sqlite::{
    StoreError, StoreErrorCode, open_reader, with_immediate_transaction,
};
use crate::infrastructure::store::SqliteStoreKernel;
use crate::infrastructure::store_replacement::{
    StoreReplacementPhase, cleanup_store_replacement, read_store_replacement_journal,
};
use crate::infrastructure::writer::{StoreMaintenance, StoreReaders, StoreWriter};

pub use profile_clone::{
    ProfileCloneBackupSelection, ProfileCloneReceipt, ProfileCloneRequest,
    materialize_profile_clone,
};

const MODULE_NAME: &str = "store_administration";
const MAX_OPERATION_ID_BYTES: usize = 512;
const MAX_LABEL_CHARS: usize = 512;
const MAX_BACKUPS: usize = 200;
const MAX_BACKUP_START_COALESCENCES: usize = 32;
const DEFAULT_BLOCK_RETENTION_COUNT: usize = 10_000;
const BLOCK_RETENTION_SLICE_CANDIDATES: usize = 8;
const BLOCK_RETENTION_SLICE_TARGET: Duration = Duration::from_millis(100);

type StoreReplacementHook = Arc<dyn Fn(&str) -> Result<(), StoreError> + Send + Sync>;

#[derive(Clone, Debug)]
pub struct StoreAdministrationApplyOutcome {
    pub committed:
        crate::ModuleWriterResult<StoreAdministrationCommitValue, StoreAdministrationReceipt>,
    pub event: Option<CommittedCoreModuleEvent>,
    pub durability: StoreAdministrationOutcomeDurability,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StoreAdministrationOutcomeDurability {
    DurableReceipt,
    Transient,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DurableAdministrationOutcome {
    committed:
        crate::ModuleWriterResult<StoreAdministrationCommitValue, StoreAdministrationReceipt>,
    deleted_backup_ids: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CurrentDurableAdministrationOutcome {
    committed:
        crate::ModuleWriterResult<StoreAdministrationCommitValue, StoreAdministrationReceipt>,
    #[serde(default)]
    deleted_backup_ids: Vec<String>,
}

#[derive(Deserialize)]
struct LegacyDurableAdministrationOutcome {
    value: StoreAdministrationCommitValue,
    receipt: StoreAdministrationReceipt,
    #[serde(default)]
    commit_seq: i64,
    event_sequence: i64,
    store_epoch: StoreEpoch,
    #[serde(default, rename = "_coreDeletedBackupIds")]
    deleted_backup_ids: Vec<String>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum DurableAdministrationOutcomeWire {
    Current(CurrentDurableAdministrationOutcome),
    Legacy(LegacyDurableAdministrationOutcome),
}

impl<'de> Deserialize<'de> for DurableAdministrationOutcome {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let wire = DurableAdministrationOutcomeWire::deserialize(deserializer)?;
        Ok(match wire {
            DurableAdministrationOutcomeWire::Current(current) => Self {
                committed: current.committed,
                deleted_backup_ids: current.deleted_backup_ids,
            },
            DurableAdministrationOutcomeWire::Legacy(legacy) => {
                let commit_seq = if legacy.commit_seq > 0 {
                    legacy.commit_seq
                } else {
                    legacy.event_sequence
                };
                Self {
                    committed: crate::ModuleWriterResult {
                        value: legacy.value,
                        receipt: legacy.receipt,
                        commit_seq,
                        event_sequence: legacy.event_sequence,
                        store_epoch: legacy.store_epoch,
                    },
                    deleted_backup_ids: legacy.deleted_backup_ids,
                }
            }
        })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DurableBackupDeletionEvidence {
    #[serde(alias = "_coreDeletedBackupIds")]
    deleted_backup_ids: Vec<String>,
}

#[derive(Clone, Debug)]
struct ActiveOperation {
    operation_id: String,
    phase: String,
    cancellation_requested: bool,
}

fn backup_window(
    connection: &Connection,
    library_id: &str,
    commit_head: i64,
    items: Vec<BackupRecord>,
    request: &CollectionWindowRequest,
) -> Result<CollectionWindow<BackupRecord>, StoreError> {
    let normalized = normalize_request(request)?;
    let fingerprint = cursor::query_fingerprint(&"store_administration_backups_v1")?;
    let subject = CollectionCursorSubject {
        kind: "store_administration_backups",
        library_id,
        query_fingerprint: &fingerprint,
    };
    let after = normalized
        .after
        .map(|encoded| cursor::decode(connection, encoded, subject))
        .transpose()?
        .map(|(direction, coordinate)| {
            if direction != CursorDirection::Forward || coordinate.values.len() != 1 {
                return Err(invalid_store("Backup cursor is incompatible"));
            }
            let [KeysetValue::Text { value: created_at }] = coordinate.values.as_slice() else {
                return Err(invalid_store("Backup cursor coordinate is invalid"));
            };
            Ok((created_at.clone(), coordinate.stable_id))
        })
        .transpose()?;
    let candidates = items
        .into_iter()
        .filter(|item| {
            after.as_ref().is_none_or(|(created_at, backup_id)| {
                item.created_at < *created_at
                    || (item.created_at == *created_at && item.backup_id < *backup_id)
            })
        })
        .take(normalized.first + 1)
        .map(|item| WindowCandidate {
            coordinate: KeysetCoordinate {
                values: vec![KeysetValue::Text {
                    value: item.created_at.clone(),
                }],
                stable_id: item.backup_id.clone(),
            },
            item,
        });
    assemble(
        candidates,
        normalized.first,
        CollectionWindowAuthority {
            projection_revision: commit_head,
        },
        |coordinate| {
            cursor::mint(
                connection,
                subject,
                CursorDirection::Forward,
                coordinate.clone(),
            )
        },
    )
}

#[derive(Clone, Debug)]
struct RuntimeState {
    active: Option<ActiveOperation>,
    integrity: StoreIntegrity,
}

fn automatic_backups_outside_budget(
    inventory: Vec<backup::BackupInventoryItem>,
    retain_count: usize,
    retain_bytes: u64,
) -> Vec<String> {
    let mut retained_count = 0usize;
    let mut retained_bytes = 0u64;
    inventory
        .into_iter()
        .filter_map(|item| {
            let next_bytes = retained_bytes.checked_add(item.record.total_bytes);
            if retained_count < retain_count
                && next_bytes.is_some_and(|bytes| bytes <= retain_bytes)
            {
                retained_count += 1;
                retained_bytes = next_bytes.expect("validated retained Backup bytes");
                return None;
            }
            Some(item.record.backup_id)
        })
        .collect()
}

pub struct StoreAdministrationModule {
    profile_id: String,
    library_id: String,
    profile_home: Option<PathBuf>,
    readers: Option<StoreReaders>,
    writer: Option<StoreWriter>,
    maintenance: Option<StoreMaintenance>,
    store_replacement_hook: StoreReplacementHook,
    operation_lock: Arc<Mutex<()>>,
    runtime: Arc<Mutex<RuntimeState>>,
}

impl StoreAdministrationModule {
    pub fn new(
        profile_id: impl Into<String>,
        library_id: impl Into<String>,
        kernel: &SqliteStoreKernel,
    ) -> Self {
        Self {
            profile_id: profile_id.into(),
            library_id: library_id.into(),
            profile_home: kernel.database_path().parent().map(PathBuf::from),
            readers: Some(kernel.readers()),
            writer: Some(kernel.writer()),
            maintenance: Some(kernel.maintenance()),
            store_replacement_hook: Arc::new(|_| Ok(())),
            operation_lock: Arc::new(Mutex::new(())),
            runtime: Arc::new(Mutex::new(RuntimeState {
                active: None,
                integrity: StoreIntegrity::Unknown,
            })),
        }
    }

    pub fn with_store_replacement_hook(
        mut self,
        hook: impl Fn(&str) -> Result<(), StoreError> + Send + Sync + 'static,
    ) -> Self {
        self.store_replacement_hook = Arc::new(hook);
        self
    }

    pub fn read(
        &self,
        context: &BoundModuleContext,
        request: ModuleReadRequest<StoreAdministrationRead>,
    ) -> Result<ModuleReadSnapshot<StoreAdministrationReadValue>, CoreError> {
        self.validate_context(context)?;
        if request.contract_version != STORE_ADMINISTRATION_CONTRACT_VERSION {
            return Err(invalid("unsupported Store Administration contract version"));
        }
        let Some(readers) = &self.readers else {
            return Err(unavailable(
                "Store Administration Module has no durable store",
            ));
        };
        let Some(profile_home) = &self.profile_home else {
            return Err(unavailable(
                "Store Administration Module has no managed Profile home",
            ));
        };
        let maintenance_plan = match &request.read {
            StoreAdministrationRead::MaintenancePlan {
                tasks,
                block_retention_count,
            } => {
                let tasks = normalize_maintenance_tasks(tasks)?;
                if block_retention_count.is_some()
                    && !tasks.contains(&MaintenanceTask::BlockRetention)
                {
                    return Err(invalid(
                        "block retention policy requires the block_retention task",
                    ));
                }
                let retain_count = block_retention_count
                    .map(|count| {
                        usize::try_from(count)
                            .map_err(|_| invalid("block retention count exceeds platform bounds"))
                    })
                    .transpose()?
                    .unwrap_or(DEFAULT_BLOCK_RETENTION_COUNT);
                Some((tasks, retain_count))
            }
            _ => None,
        };
        let profile_id = self.profile_id.clone();
        let library_id = self.library_id.clone();
        let profile_home = profile_home.clone();
        let runtime = Arc::clone(&self.runtime);
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
                let value = match request.read {
                    StoreAdministrationRead::Status => {
                        let schema_version =
                            transaction
                                .query_row("PRAGMA user_version", [], |row| row.get::<_, u32>(0))?;
                        let schema_owner = transaction.query_row(
                            "SELECT schema_owner FROM core_store_metadata WHERE id = 1",
                            [],
                            |row| row.get::<_, String>(0),
                        )?;
                        if schema_owner != "rust_core" {
                            return Err(corrupt("Store schema owner is not Rust Core"));
                        }
                        let state = runtime.lock().map_err(|_| {
                            internal("Store Administration runtime state lock failed")
                        })?;
                        StoreAdministrationReadValue::Status {
                            readiness: if state.active.is_some() {
                                StoreReadiness::Maintenance
                            } else {
                                StoreReadiness::Ready
                            },
                            schema_version,
                            schema_owner: SchemaOwner::Rust,
                            integrity: state.integrity,
                        }
                    }
                    StoreAdministrationRead::Backups { window } => {
                        let deleted = logically_deleted_backup_ids(&transaction)?;
                        let mut inventory = backup::list_backup_inventory(&profile_home)?;
                        inventory.retain(|item| !deleted.contains(&item.record.backup_id));
                        let capacity = backup::backup_capacity(
                            &profile_home,
                            &inventory,
                            true,
                            backup::BackupCapacityMode::InventoryEstimate,
                        )?;
                        let items = inventory
                            .into_iter()
                            .map(|item| item.record)
                            .collect::<Vec<_>>();
                        StoreAdministrationReadValue::Backups {
                            backups: backup_window(
                                &transaction,
                                &library_id,
                                commit_seq,
                                items,
                                &window,
                            )?,
                            capacity,
                        }
                    }
                    StoreAdministrationRead::BackupJobs => {
                        StoreAdministrationReadValue::BackupJobs {
                            jobs: backup::list_backup_jobs(&profile_home)?,
                            coalesced_starts: read_backup_start_coalescences(&transaction)?,
                        }
                    }
                    StoreAdministrationRead::OperationalJournalStatus => {
                        StoreAdministrationReadValue::OperationalJournalStatus {
                            status: crate::infrastructure::operational_journal::read_status(
                                &transaction,
                            )?,
                        }
                    }
                    StoreAdministrationRead::MaintenanceStatus => {
                        let state = runtime.lock().map_err(|_| {
                            internal("Store Administration runtime state lock failed")
                        })?;
                        StoreAdministrationReadValue::MaintenanceStatus {
                            active: state.active.is_some(),
                            operation_id: state
                                .active
                                .as_ref()
                                .map(|operation| operation.operation_id.clone()),
                            phase: state
                                .active
                                .as_ref()
                                .map(|operation| operation.phase.clone()),
                        }
                    }
                    StoreAdministrationRead::MaintenancePlan { .. } => {
                        let (tasks, retain_count) = maintenance_plan
                            .as_ref()
                            .ok_or_else(|| internal("Store maintenance plan was not normalized"))?;
                        StoreAdministrationReadValue::MaintenancePlan {
                            plan: plan_maintenance_due_work(
                                &transaction,
                                tasks,
                                *retain_count,
                                commit_seq,
                            )?,
                        }
                    }
                };
                transaction.commit()?;
                Ok(ModuleReadSnapshot {
                    contract_version: STORE_ADMINISTRATION_CONTRACT_VERSION,
                    store_epoch: StoreEpoch(store_epoch),
                    commit_head: commit_seq,
                    authorization: None,
                    value,
                })
            })
            .map_err(core_error)
    }

    pub fn apply(
        &self,
        context: &BoundModuleContext,
        request: ModuleApplyRequest<StoreAdministrationIntent>,
    ) -> Result<StoreAdministrationApplyOutcome, CoreError> {
        self.validate_context(context)?;
        if request.contract_version != STORE_ADMINISTRATION_CONTRACT_VERSION {
            return Err(invalid("unsupported Store Administration contract version"));
        }
        require_private_adapter(context)?;
        validate_operation_id(&request.operation_id)?;
        if matches!(
            &request.intent,
            StoreAdministrationIntent::CancelBackup { .. }
        ) {
            return self.apply_cancel_backup(context, request);
        }
        if matches!(
            &request.intent,
            StoreAdministrationIntent::CoalesceBackup { .. }
        ) {
            return self.apply_coalesce_backup(context, request);
        }
        let intent = request.intent.clone();
        let (phase, normalized_label, maintenance_tasks) = match &intent {
            StoreAdministrationIntent::CreateBackup { label, .. } => {
                ("online_backup", normalize_label(label)?, None)
            }
            StoreAdministrationIntent::CoalesceBackup { .. } => unreachable!(
                "backup coalescence is handled before exclusive administration ownership"
            ),
            StoreAdministrationIntent::CancelBackup { .. } => unreachable!(
                "backup cancellation is handled before exclusive administration ownership"
            ),
            StoreAdministrationIntent::RestoreBackup { .. } => ("restore", None, None),
            StoreAdministrationIntent::DeleteBackup { .. } => ("delete_backup", None, None),
            StoreAdministrationIntent::PruneBackups { .. } => ("prune_backups", None, None),
            StoreAdministrationIntent::RunMaintenance { tasks, .. } => (
                "maintenance",
                None,
                Some(normalize_maintenance_tasks(tasks)?),
            ),
        };
        let operation_guard = match self.operation_lock.try_lock() {
            Ok(guard) => guard,
            Err(TryLockError::WouldBlock) => return Err(maintenance_in_progress()),
            Err(TryLockError::Poisoned(_)) => {
                return Err(unavailable("Store Administration operation lock failed"));
            }
        };
        self.set_active(&request.operation_id, phase)?;
        let result = match intent {
            StoreAdministrationIntent::CreateBackup { .. } => {
                self.apply_create_backup(context, request, normalized_label)
            }
            StoreAdministrationIntent::CoalesceBackup { .. } => unreachable!(
                "backup coalescence is handled before exclusive administration ownership"
            ),
            StoreAdministrationIntent::CancelBackup { .. } => unreachable!(
                "backup cancellation is handled before exclusive administration ownership"
            ),
            StoreAdministrationIntent::RestoreBackup { .. } => {
                self.apply_restore_backup(context, request)
            }
            StoreAdministrationIntent::DeleteBackup { .. } => {
                self.apply_delete_backup(context, request)
            }
            StoreAdministrationIntent::PruneBackups { .. } => {
                self.apply_prune_backups(context, request)
            }
            StoreAdministrationIntent::RunMaintenance { .. } => self.apply_maintenance(
                context,
                request,
                maintenance_tasks.expect("maintenance tasks were normalized"),
            ),
        };
        self.clear_active();
        drop(operation_guard);
        result
    }

    fn apply_cancel_backup(
        &self,
        context: &BoundModuleContext,
        request: ModuleApplyRequest<StoreAdministrationIntent>,
    ) -> Result<StoreAdministrationApplyOutcome, CoreError> {
        let Some(writer) = &self.writer else {
            return Err(unavailable(
                "Store Administration Module has no durable writer",
            ));
        };
        let Some(profile_home) = &self.profile_home else {
            return Err(unavailable(
                "Store Administration Module has no managed Profile home",
            ));
        };
        let StoreAdministrationIntent::CancelBackup { job_id } = &request.intent else {
            unreachable!("apply dispatches only Backup cancellation here")
        };
        validate_operation_id(job_id)?;
        let request_hash = sha256(
            &serde_json::to_vec(&(
                &self.profile_id,
                &self.library_id,
                request.contract_version,
                &request.store_epoch,
                "cancel_backup",
                job_id,
            ))
            .map_err(|_| unavailable("Backup cancellation cannot be fingerprinted"))?,
        );
        let has_active_worker = {
            let mut state = self
                .runtime
                .lock()
                .map_err(|_| unavailable("Store Administration runtime state lock failed"))?;
            let active = state
                .active
                .as_mut()
                .filter(|active| active.operation_id == *job_id);
            if let Some(active) = active {
                if matches!(active.phase.as_str(), "commit" | "publishing" | "ready") {
                    return Err(CoreError {
                        code: CoreErrorCode::Conflict,
                        message: "Snapshot can no longer be cancelled after publication has begun"
                            .to_owned(),
                        retryable: false,
                        recovery: CoreErrorRecovery::None,
                    });
                }
                active.cancellation_requested = true;
                true
            } else {
                false
            }
        };
        backup::request_backup_job_cancel(profile_home, job_id, has_active_worker)
            .map_err(core_error)?;

        let profile_id = self.profile_id.clone();
        let library_id = self.library_id.clone();
        let context = context.clone();
        let job_id = job_id.clone();
        let operation_id = request.operation_id;
        let requested_epoch = request.store_epoch.0;
        writer
            .call(move |connection| {
                let store_epoch = validate_maintenance_attempt(
                    connection,
                    &profile_id,
                    &library_id,
                    &requested_epoch,
                )?;
                if let Some(outcome) = replay_outcome(connection, &operation_id, &request_hash)? {
                    return Ok(outcome);
                }
                let committed_at = sqlite_now(connection)?;
                finish_administration_mutation(
                    connection,
                    &library_id,
                    &context,
                    &operation_id,
                    &request_hash,
                    &store_epoch,
                    "cancel_backup",
                    &committed_at,
                    StoreAdministrationCommitValue {
                        backup_id: None,
                        safety_backup_id: None,
                        cancelled_backup_job_id: Some(job_id.clone()),
                        coalesced_backup_job_id: None,
                        completed_tasks: Vec::new(),
                    },
                    Vec::new(),
                    StoreAdministrationEvent {
                        kind: StoreAdministrationEventKind::StoreAdministrationChanged,
                        operation: "cancel_backup".to_owned(),
                        backup_ids: Vec::new(),
                        readiness_changed: false,
                    },
                    false,
                )
            })
            .map_err(core_error)
    }

    fn apply_coalesce_backup(
        &self,
        context: &BoundModuleContext,
        request: ModuleApplyRequest<StoreAdministrationIntent>,
    ) -> Result<StoreAdministrationApplyOutcome, CoreError> {
        let Some(writer) = &self.writer else {
            return Err(unavailable(
                "Store Administration Module has no durable writer",
            ));
        };
        let Some(profile_home) = &self.profile_home else {
            return Err(unavailable(
                "Store Administration Module has no managed Profile home",
            ));
        };
        let StoreAdministrationIntent::CoalesceBackup {
            active_job_id,
            label,
            include_assets,
            trigger,
        } = request.intent
        else {
            unreachable!("apply dispatches only Backup coalescence here")
        };
        validate_operation_id(&active_job_id)?;
        let normalized_label = normalize_label(&label)?;
        // The target is Core's admission decision, not part of the caller's
        // command. Sharing CreateBackup's hash lets an exact retry replay this
        // durable B -> A relation even after Main forgets which path admitted B.
        let request_hash = backup_request_hash(
            &self.profile_id,
            &self.library_id,
            request.contract_version,
            &request.store_epoch,
            &normalized_label,
            include_assets,
            trigger,
        )?;
        let profile_id = self.profile_id.clone();
        let library_id = self.library_id.clone();
        let finish_context = context.clone();
        let profile_home = profile_home.clone();
        let runtime = Arc::clone(&self.runtime);
        let operation_id = request.operation_id;
        let requested_store_epoch = request.store_epoch.0;
        writer
            .call(move |connection| {
                assert_identity(connection, &profile_id, &library_id)?;
                let store_epoch = read_store_epoch(connection)?;
                if requested_store_epoch != store_epoch {
                    return Err(stale_store_epoch());
                }
                if let Some(outcome) = replay_outcome(connection, &operation_id, &request_hash)? {
                    return Ok(outcome);
                }
                let target_is_active = runtime
                    .lock()
                    .map_err(|_| internal("Store Administration runtime state lock failed"))?
                    .active
                    .as_ref()
                    .is_some_and(|active| active.operation_id == active_job_id);
                let target_exists = target_is_active
                    || backup::list_backup_jobs(&profile_home)?
                        .into_iter()
                        .any(|job| job.job_id == active_job_id);
                if !target_exists {
                    return Err(StoreError::new(
                        StoreErrorCode::NotFound,
                        "The active Backup job is no longer observable",
                        true,
                    ));
                }
                let committed_at = sqlite_now(connection)?;
                finish_administration_mutation(
                    connection,
                    &library_id,
                    &finish_context,
                    &operation_id,
                    &request_hash,
                    &store_epoch,
                    "coalesce_backup",
                    &committed_at,
                    StoreAdministrationCommitValue {
                        backup_id: None,
                        safety_backup_id: None,
                        cancelled_backup_job_id: None,
                        coalesced_backup_job_id: Some(active_job_id.clone()),
                        completed_tasks: Vec::new(),
                    },
                    Vec::new(),
                    StoreAdministrationEvent {
                        kind: StoreAdministrationEventKind::StoreAdministrationChanged,
                        operation: "coalesce_backup".to_owned(),
                        backup_ids: Vec::new(),
                        readiness_changed: false,
                    },
                    false,
                )
            })
            .map_err(core_error)
    }

    fn apply_create_backup(
        &self,
        context: &BoundModuleContext,
        request: ModuleApplyRequest<StoreAdministrationIntent>,
        normalized_label: Option<String>,
    ) -> Result<StoreAdministrationApplyOutcome, CoreError> {
        let Some(writer) = &self.writer else {
            return Err(unavailable(
                "Store Administration Module has no durable writer",
            ));
        };
        let Some(profile_home) = &self.profile_home else {
            return Err(unavailable(
                "Store Administration Module has no managed Profile home",
            ));
        };
        let StoreAdministrationIntent::CreateBackup {
            include_assets,
            trigger,
            ..
        } = request.intent
        else {
            unreachable!("apply validates the Store Administration intent")
        };
        let request_hash = backup_request_hash(
            &self.profile_id,
            &self.library_id,
            request.contract_version,
            &request.store_epoch,
            &normalized_label,
            include_assets,
            trigger,
        )?;
        let profile_id = self.profile_id.clone();
        let library_id = self.library_id.clone();
        let context = context.clone();
        let profile_home = profile_home.clone();
        let operation_id = request.operation_id;
        let requested_store_epoch = request.store_epoch.0;
        let preflight_profile_id = profile_id.clone();
        let preflight_library_id = library_id.clone();
        let preflight_operation_id = operation_id.clone();
        let preflight_request_hash = request_hash.clone();
        let preflight_epoch = requested_store_epoch.clone();
        let preflight_started_at = Instant::now();
        let preflight = writer
            .call(move |connection| {
                assert_identity(connection, &preflight_profile_id, &preflight_library_id)?;
                let store_epoch = read_store_epoch(connection)?;
                if preflight_epoch != store_epoch {
                    return Err(stale_store_epoch());
                }
                if let Some(outcome) =
                    replay_outcome(connection, &preflight_operation_id, &preflight_request_hash)?
                {
                    return Ok(Some(outcome));
                }
                Ok(None)
            })
            .map_err(core_error)?;
        if let Some(outcome) = preflight {
            if outcome.committed.value.coalesced_backup_job_id.is_some() {
                return Ok(outcome);
            }
            let backup_id = outcome
                .committed
                .value
                .backup_id
                .as_deref()
                .ok_or_else(|| {
                    core_error(corrupt("Backup creation receipt has no Backup identity"))
                })?;
            operation_journal::publish_backup(
                &profile_home,
                &operation_id,
                &request_hash,
                backup_id,
            )
            .map_err(core_error)?;
            backup::update_backup_job_phase(
                &profile_home,
                &operation_id,
                BackupJobState::Ready,
                BackupJobPhase::Ready,
                None,
            )
            .map_err(core_error)?;
            return Ok(outcome);
        }

        let trigger_name = match trigger {
            nodex_core_contracts::administration::BackupTrigger::Manual => "manual",
            nodex_core_contracts::administration::BackupTrigger::Auto => "auto",
            nodex_core_contracts::administration::BackupTrigger::PreRestore => "pre-restore",
        };
        let expected_backup_id = backup::backup_id(&profile_id, &operation_id);
        backup::begin_backup_job(
            &profile_home,
            &profile_id,
            &operation_id,
            &request_hash,
            normalized_label.as_deref(),
            include_assets,
            trigger_name,
            &expected_backup_id,
        )
        .map_err(core_error)?;
        backup::update_backup_job_progress(&profile_home, &operation_id, |progress| {
            progress.writer_held_ms = progress
                .writer_held_ms
                .saturating_add(duration_millis(preflight_started_at.elapsed()));
        })
        .map_err(core_error)?;
        let inventory = backup::list_backup_inventory(&profile_home).map_err(|error| {
            fail_backup_job(
                &profile_home,
                &operation_id,
                "Snapshot inventory could not be read.",
                error,
            )
        })?;
        let capacity = backup::backup_capacity(
            &profile_home,
            &inventory,
            include_assets,
            backup::BackupCapacityMode::LivePreflight,
        )
        .map_err(|error| {
            fail_backup_job(
                &profile_home,
                &operation_id,
                "Snapshot capacity could not be verified.",
                error,
            )
        })?;
        if inventory.len() >= MAX_BACKUPS || !capacity.can_create {
            backup::update_backup_job_phase(
                &profile_home,
                &operation_id,
                BackupJobState::Failed,
                BackupJobPhase::Failed,
                Some(if inventory.len() >= MAX_BACKUPS {
                    "Snapshot limit reached. Delete an older snapshot first."
                } else {
                    "Not enough disk space to create this snapshot safely."
                }),
            )
            .map_err(core_error)?;
            return Err(core_error(StoreError::new(
                StoreErrorCode::ResourceExhausted,
                if inventory.len() >= MAX_BACKUPS {
                    "Backup collection exceeds its fixed bound; delete an older Backup first"
                } else {
                    "Backup requires more free disk space and safety headroom"
                },
                false,
            )));
        }

        // The copy and full validation intentionally run on a dedicated reader
        // outside the serialized writer. WAL keeps the snapshot consistent
        // while interactive mutations continue to commit.
        let admin_reader = open_reader(&profile_home.join("nodex.db")).map_err(|error| {
            fail_backup_job(
                &profile_home,
                &operation_id,
                "Snapshot source could not be opened.",
                error,
            )
        })?;
        assert_identity(&admin_reader, &profile_id, &library_id).map_err(|error| {
            fail_backup_job(
                &profile_home,
                &operation_id,
                "Snapshot source identity could not be verified.",
                error,
            )
        })?;
        let source_epoch = read_store_epoch(&admin_reader).map_err(|error| {
            fail_backup_job(
                &profile_home,
                &operation_id,
                "Snapshot source authority could not be verified.",
                error,
            )
        })?;
        if source_epoch != requested_store_epoch {
            return Err(fail_backup_job(
                &profile_home,
                &operation_id,
                "Snapshot source changed before capture began.",
                stale_store_epoch(),
            ));
        }
        let progress_runtime = Arc::clone(&self.runtime);
        let cancellation_runtime = Arc::clone(&self.runtime);
        let cancellation_operation_id = operation_id.clone();
        let progress_profile_home = profile_home.clone();
        let progress_operation_id = operation_id.clone();
        let progress = move |phase: BackupJobPhase| {
            backup::update_backup_job_phase(
                &progress_profile_home,
                &progress_operation_id,
                BackupJobState::Running,
                phase,
                None,
            )?;
            let mut state = progress_runtime
                .lock()
                .map_err(|_| internal("Store Administration runtime state lock failed"))?;
            let active = state
                .active
                .as_mut()
                .filter(|active| active.operation_id == progress_operation_id)
                .ok_or_else(|| internal("Backup operation lost its runtime ownership"))?;
            active.phase = phase.as_str().to_owned();
            Ok(())
        };
        let cancellation_requested = move || {
            let state = cancellation_runtime
                .lock()
                .map_err(|_| internal("Store Administration runtime state lock failed"))?;
            let active = state
                .active
                .as_ref()
                .filter(|active| active.operation_id == cancellation_operation_id)
                .ok_or_else(|| internal("Backup operation lost its runtime ownership"))?;
            Ok(active.cancellation_requested)
        };
        let staged = operation_journal::stage_backup(
            &admin_reader,
            &profile_home,
            &profile_id,
            &operation_id,
            &request_hash,
            normalized_label.as_deref(),
            include_assets,
            trigger,
            &progress,
            &cancellation_requested,
        )
        .map_err(|error| {
            fail_backup_job(
                &profile_home,
                &operation_id,
                "Snapshot capture or verification failed.",
                error,
            )
        })?;
        let record = staged.record().clone();
        drop(admin_reader);
        backup::update_backup_job_phase(
            &profile_home,
            &operation_id,
            BackupJobState::Running,
            BackupJobPhase::Commit,
            None,
        )
        .map_err(core_error)?;

        let finish_profile_id = profile_id;
        let finish_library_id = library_id;
        let finish_context = context;
        let finish_operation_id = operation_id.clone();
        let finish_request_hash = request_hash.clone();
        let finish_epoch = requested_store_epoch;
        let finish_record = record.clone();
        let finish_writer_started_at = Instant::now();
        let outcome = match writer.call(move |connection| {
            assert_identity(connection, &finish_profile_id, &finish_library_id)?;
            let store_epoch = read_store_epoch(connection)?;
            if finish_epoch != store_epoch {
                return Err(stale_store_epoch());
            }
            if let Some(outcome) =
                replay_outcome(connection, &finish_operation_id, &finish_request_hash)?
            {
                return Ok(outcome);
            }
            finish_backup_creation(
                connection,
                &finish_library_id,
                &finish_context,
                &finish_operation_id,
                &finish_request_hash,
                &store_epoch,
                &finish_record,
            )
        }) {
            Ok(outcome) => outcome,
            Err(error) => {
                operation_journal::discard_verified_backup(staged).map_err(core_error)?;
                backup::update_backup_job_phase(
                    &profile_home,
                    &operation_id,
                    BackupJobState::Failed,
                    BackupJobPhase::Failed,
                    Some("Snapshot could not be committed."),
                )
                .map_err(core_error)?;
                return Err(core_error(error));
            }
        };
        backup::update_backup_job_progress(&profile_home, &operation_id, |progress| {
            progress.writer_held_ms = progress
                .writer_held_ms
                .saturating_add(duration_millis(finish_writer_started_at.elapsed()));
        })
        .map_err(core_error)?;
        backup::update_backup_job_phase(
            &profile_home,
            &operation_id,
            BackupJobState::Running,
            BackupJobPhase::Publishing,
            None,
        )
        .map_err(core_error)?;
        // Keep a publication failure durably running: the receipt already
        // exists, so startup recovery must retry adoption with the same
        // operation identity instead of turning a recoverable boundary into a
        // terminal job.
        let publish_started_at = Instant::now();
        let published = operation_journal::publish_verified_backup(staged).map_err(core_error)?;
        backup::update_backup_job_progress(&profile_home, &operation_id, |progress| {
            progress.publish_ms = duration_millis(publish_started_at.elapsed());
        })
        .map_err(core_error)?;
        if published.backup_id != record.backup_id
            || outcome.committed.value.backup_id.as_deref() != Some(record.backup_id.as_str())
        {
            return Err(fail_backup_job(
                &profile_home,
                &operation_id,
                "Snapshot publication evidence diverged.",
                corrupt("Backup publication diverges from its durable receipt"),
            ));
        }
        if let Ok(mut state) = self.runtime.lock() {
            state.integrity = StoreIntegrity::Ok;
        }
        backup::update_backup_job_phase(
            &profile_home,
            &operation_id,
            BackupJobState::Ready,
            BackupJobPhase::Ready,
            None,
        )
        .map_err(core_error)?;
        Ok(outcome)
    }

    fn apply_delete_backup(
        &self,
        context: &BoundModuleContext,
        request: ModuleApplyRequest<StoreAdministrationIntent>,
    ) -> Result<StoreAdministrationApplyOutcome, CoreError> {
        let Some(writer) = &self.writer else {
            return Err(unavailable(
                "Store Administration Module has no durable writer",
            ));
        };
        let Some(profile_home) = &self.profile_home else {
            return Err(unavailable(
                "Store Administration Module has no managed Profile home",
            ));
        };
        let StoreAdministrationIntent::DeleteBackup { backup_id } = request.intent else {
            unreachable!("apply validates the Store Administration intent")
        };
        let fingerprint = serde_json::to_vec(&(
            &self.profile_id,
            &self.library_id,
            request.contract_version,
            &request.store_epoch,
            "delete_backup",
            &backup_id,
        ))
        .map_err(|_| unavailable("Backup deletion request cannot be fingerprinted"))?;
        let request_hash = sha256(&fingerprint);
        let profile_id = self.profile_id.clone();
        let library_id = self.library_id.clone();
        let finish_context = context.clone();
        let operation_id = request.operation_id;
        let cleanup_operation_id = operation_id.clone();
        let requested_store_epoch = request.store_epoch.0;
        let profile_home_for_write = profile_home.clone();
        let backup_id_for_write = backup_id.clone();
        let (outcome, deleted_backup_ids) = writer
            .call(move |connection| {
                assert_identity(connection, &profile_id, &library_id)?;
                let store_epoch = read_store_epoch(connection)?;
                if requested_store_epoch != store_epoch {
                    return Err(stale_store_epoch());
                }
                if let Some(replayed) =
                    replay_cleanup_outcome(connection, &operation_id, &request_hash)?
                {
                    return Ok(replayed);
                }
                let deleted = logically_deleted_backup_ids(connection)?;
                if deleted.contains(&backup_id_for_write) {
                    return Err(StoreError::new(
                        StoreErrorCode::NotFound,
                        "Backup was not found",
                        false,
                    ));
                }
                let exists = backup::list_backup_inventory(&profile_home_for_write)?
                    .into_iter()
                    .any(|item| item.record.backup_id == backup_id_for_write);
                if !exists {
                    return Err(StoreError::new(
                        StoreErrorCode::NotFound,
                        "Backup was not found",
                        false,
                    ));
                }
                backup::validate_backup_for_deletion(
                    &profile_home_for_write,
                    &backup_id_for_write,
                )?;
                let committed_at = sqlite_now(connection)?;
                let deleted_backup_ids = vec![backup_id_for_write.clone()];
                let outcome = finish_cleanup_operation(
                    connection,
                    &library_id,
                    &finish_context,
                    &operation_id,
                    &request_hash,
                    &store_epoch,
                    "delete_backup",
                    Some(&backup_id_for_write),
                    &deleted_backup_ids,
                    &committed_at,
                )?;
                Ok((outcome, deleted_backup_ids))
            })
            .map_err(core_error)?;
        operation_journal::publish_backup_cleanup(
            profile_home,
            &cleanup_operation_id,
            &deleted_backup_ids,
        )
        .map_err(core_error)?;
        Ok(outcome)
    }

    fn apply_prune_backups(
        &self,
        context: &BoundModuleContext,
        request: ModuleApplyRequest<StoreAdministrationIntent>,
    ) -> Result<StoreAdministrationApplyOutcome, CoreError> {
        let Some(writer) = &self.writer else {
            return Err(unavailable(
                "Store Administration Module has no durable writer",
            ));
        };
        let Some(profile_home) = &self.profile_home else {
            return Err(unavailable(
                "Store Administration Module has no managed Profile home",
            ));
        };
        let StoreAdministrationIntent::PruneBackups {
            retain_count,
            retain_bytes,
        } = request.intent
        else {
            unreachable!("apply validates the Store Administration intent")
        };
        let fingerprint = serde_json::to_vec(&(
            &self.profile_id,
            &self.library_id,
            request.contract_version,
            &request.store_epoch,
            "prune_backups",
            retain_count,
            retain_bytes,
        ))
        .map_err(|_| unavailable("Backup pruning request cannot be fingerprinted"))?;
        let request_hash = sha256(&fingerprint);
        let profile_id = self.profile_id.clone();
        let library_id = self.library_id.clone();
        let finish_context = context.clone();
        let operation_id = request.operation_id;
        let cleanup_operation_id = operation_id.clone();
        let requested_store_epoch = request.store_epoch.0;
        let profile_home_for_write = profile_home.clone();
        let (outcome, deleted_backup_ids) = writer
            .call(move |connection| {
                assert_identity(connection, &profile_id, &library_id)?;
                let store_epoch = read_store_epoch(connection)?;
                if requested_store_epoch != store_epoch {
                    return Err(stale_store_epoch());
                }
                if let Some(replayed) =
                    replay_cleanup_outcome(connection, &operation_id, &request_hash)?
                {
                    return Ok(replayed);
                }
                let logically_deleted = logically_deleted_backup_ids(connection)?;
                let retain_count = usize::try_from(retain_count)
                    .map_err(|_| invalid_store("Backup retention count is invalid"))?;
                let automatic = backup::list_backup_inventory(&profile_home_for_write)?
                    .into_iter()
                    .filter(|item| {
                        item.trigger == "auto"
                            && !logically_deleted.contains(&item.record.backup_id)
                    })
                    .collect::<Vec<_>>();
                let deleted_backup_ids =
                    automatic_backups_outside_budget(automatic, retain_count, retain_bytes);
                for backup_id in &deleted_backup_ids {
                    backup::validate_backup_for_deletion(&profile_home_for_write, backup_id)?;
                }
                let committed_at = sqlite_now(connection)?;
                let outcome = finish_cleanup_operation(
                    connection,
                    &library_id,
                    &finish_context,
                    &operation_id,
                    &request_hash,
                    &store_epoch,
                    "prune_backups",
                    None,
                    &deleted_backup_ids,
                    &committed_at,
                )?;
                Ok((outcome, deleted_backup_ids))
            })
            .map_err(core_error)?;
        operation_journal::publish_backup_cleanup(
            profile_home,
            &cleanup_operation_id,
            &deleted_backup_ids,
        )
        .map_err(core_error)?;
        Ok(outcome)
    }

    fn apply_maintenance(
        &self,
        context: &BoundModuleContext,
        request: ModuleApplyRequest<StoreAdministrationIntent>,
        tasks: Vec<MaintenanceTask>,
    ) -> Result<StoreAdministrationApplyOutcome, CoreError> {
        let Some(writer) = &self.writer else {
            return Err(unavailable(
                "Store Administration Module has no durable writer",
            ));
        };
        let retention_readers = if tasks.iter().any(|task| {
            matches!(
                task,
                MaintenanceTask::BlockRetention | MaintenanceTask::OperationalJournal
            )
        }) {
            Some(
                self.readers
                    .clone()
                    .ok_or_else(|| unavailable("Store Administration Module has no readers"))?,
            )
        } else {
            None
        };
        let StoreAdministrationIntent::RunMaintenance {
            block_retention_count,
            work_token,
            ..
        } = &request.intent
        else {
            unreachable!("apply validates the Store Administration intent")
        };
        if block_retention_count.is_some() && !tasks.contains(&MaintenanceTask::BlockRetention) {
            return Err(invalid(
                "block retention policy requires the block_retention task",
            ));
        }
        let fingerprint = serde_json::to_vec(&(
            &self.profile_id,
            &self.library_id,
            request.contract_version,
            &request.store_epoch,
            "run_maintenance",
            &tasks,
            block_retention_count,
            work_token,
        ))
        .map_err(|_| unavailable("Store maintenance request cannot be fingerprinted"))?;
        let request_hash = sha256(&fingerprint);
        let work_token = work_token.clone();
        let block_retention_count = block_retention_count
            .as_ref()
            .map(|count| {
                usize::try_from(*count)
                    .map_err(|_| invalid("block retention count exceeds platform bounds"))
            })
            .transpose()?;
        let profile_id = self.profile_id.clone();
        let library_id = self.library_id.clone();
        let finish_context = context.clone();
        let operation_id = request.operation_id;
        let requested_store_epoch = request.store_epoch.0;
        let verifies_integrity = tasks.iter().any(|task| {
            matches!(
                task,
                MaintenanceTask::IntegrityCheck | MaintenanceTask::ForeignKeyCheck
            )
        });
        let preflight = {
            let profile_id = profile_id.clone();
            let library_id = library_id.clone();
            let operation_id = operation_id.clone();
            let request_hash = request_hash.clone();
            let requested_store_epoch = requested_store_epoch.clone();
            let work_token = work_token.clone();
            let tasks = tasks.clone();
            writer.call(move |connection| {
                validate_maintenance_attempt(
                    connection,
                    &profile_id,
                    &library_id,
                    &requested_store_epoch,
                )?;
                if let Some(outcome) = replay_outcome(connection, &operation_id, &request_hash)? {
                    return Ok(Some(outcome));
                }
                if let Some(work_token) = work_token.as_deref() {
                    let commit_head = crate::infrastructure::local_commit::head(connection)?;
                    let expected_token = maintenance_work_token(
                        connection,
                        &tasks,
                        block_retention_count.unwrap_or(DEFAULT_BLOCK_RETENTION_COUNT),
                        commit_head,
                    )?;
                    if expected_token != work_token {
                        return Err(StoreError::new(
                            StoreErrorCode::Conflict,
                            "Store maintenance due-work token is stale; plan maintenance again",
                            true,
                        ));
                    }
                }
                Ok(None)
            })
        };
        let result = match preflight {
            Ok(Some(outcome)) => Ok(outcome),
            Ok(None) => {
                let mut task_result = Ok(0usize);
                for task in &tasks {
                    if task_result.is_err() {
                        break;
                    }
                    let completed = task_result.expect("maintenance result was checked");
                    if *task == MaintenanceTask::OperationalJournal {
                        let readers = retention_readers
                            .as_ref()
                            .expect("Operational Journal readers were validated");
                        let plan = readers.read_default(
                            crate::infrastructure::operational_journal::plan_bounded_pass,
                        );
                        task_result = plan.and_then(|plan| {
                            let profile_id = profile_id.clone();
                            let library_id = library_id.clone();
                            let requested_store_epoch = requested_store_epoch.clone();
                            writer.call(move |connection| {
                                validate_maintenance_attempt(
                                    connection,
                                    &profile_id,
                                    &library_id,
                                    &requested_store_epoch,
                                )?;
                                crate::infrastructure::operational_journal::run_bounded_pass_with_plan(
                                    connection,
                                    &plan,
                                )?;
                                Ok(completed)
                            })
                        });
                    } else if *task == MaintenanceTask::BlockRetention {
                        let retain_count =
                            block_retention_count.unwrap_or(DEFAULT_BLOCK_RETENTION_COUNT);
                        let planning_profile_id = profile_id.clone();
                        let planning_library_id = library_id.clone();
                        let planning_store_epoch = requested_store_epoch.clone();
                        let readers = retention_readers
                            .as_ref()
                            .expect("Block retention readers were validated");
                        let planned = readers.read_default(move |connection| {
                            let transaction = connection.unchecked_transaction()?;
                            validate_maintenance_attempt(
                                &transaction,
                                &planning_profile_id,
                                &planning_library_id,
                                &planning_store_epoch,
                            )?;
                            let plan = crate::document::plan_block_retention_pass(
                                &transaction,
                                retain_count,
                            )?;
                            transaction.commit()?;
                            Ok(plan)
                        });
                        task_result = planned.and_then(|planned| {
                            let mut cursor = 0;
                            let mut changed_rows = completed;
                            while cursor < planned.len() {
                                let slice =
                                    planned.slice_from(cursor, BLOCK_RETENTION_SLICE_CANDIDATES)?;
                                let profile_id = profile_id.clone();
                                let library_id = library_id.clone();
                                let requested_store_epoch = requested_store_epoch.clone();
                                let (processed, collected_blocks) =
                                    writer.call(move |connection| {
                                        validate_maintenance_attempt(
                                            connection,
                                            &profile_id,
                                            &library_id,
                                            &requested_store_epoch,
                                        )?;
                                        let result =
                                            crate::document::run_bounded_block_retention_slice(
                                                connection,
                                                &slice,
                                                BLOCK_RETENTION_SLICE_TARGET,
                                            )?;
                                        Ok((
                                            result.processed_candidates,
                                            result.summary.collected_blocks,
                                        ))
                                    })?;
                                if processed == 0 {
                                    return Err(StoreError::new(
                                        StoreErrorCode::Internal,
                                        "Block retention slice made no progress",
                                        false,
                                    ));
                                }
                                cursor = cursor.checked_add(processed).ok_or_else(|| {
                                    StoreError::new(
                                        StoreErrorCode::StoreCorrupt,
                                        "Block retention cursor overflowed",
                                        false,
                                    )
                                })?;
                                changed_rows =
                                    changed_rows.checked_add(collected_blocks).ok_or_else(
                                        || corrupt("Maintenance change count overflowed"),
                                    )?;
                            }
                            Ok(changed_rows)
                        });
                    } else {
                        let task = *task;
                        let task_context = finish_context.clone();
                        let profile_id = profile_id.clone();
                        let library_id = library_id.clone();
                        let requested_store_epoch = requested_store_epoch.clone();
                        task_result = writer.call(move |connection| {
                            validate_maintenance_attempt(
                                connection,
                                &profile_id,
                                &library_id,
                                &requested_store_epoch,
                            )?;
                            let changed = run_maintenance_task(connection, &task_context, task)?;
                            completed
                                .checked_add(changed)
                                .ok_or_else(|| corrupt("Maintenance change count overflowed"))
                        });
                    }
                }
                task_result.and_then(|changed_rows| {
                    let profile_id = profile_id.clone();
                    let library_id = library_id.clone();
                    let finish_library_id = library_id.clone();
                    let finish_context = finish_context.clone();
                    let operation_id = operation_id.clone();
                    let request_hash = request_hash.clone();
                    let requested_store_epoch = requested_store_epoch.clone();
                    let tasks = tasks.clone();
                    writer.call(move |connection| {
                        let store_epoch = validate_maintenance_attempt(
                            connection,
                            &profile_id,
                            &library_id,
                            &requested_store_epoch,
                        )?;
                        if let Some(outcome) =
                            replay_outcome(connection, &operation_id, &request_hash)?
                        {
                            return Ok(outcome);
                        }
                        let committed_at = sqlite_now(connection)?;
                        finish_maintenance(
                            connection,
                            &finish_library_id,
                            &finish_context,
                            &operation_id,
                            &request_hash,
                            &store_epoch,
                            &tasks,
                            changed_rows,
                            &committed_at,
                        )
                    })
                })
            }
            Err(error) => Err(error),
        };
        match result {
            Ok(outcome) => {
                if verifies_integrity && let Ok(mut state) = self.runtime.lock() {
                    state.integrity = StoreIntegrity::Ok;
                }
                Ok(outcome)
            }
            Err(error) => {
                if verifies_integrity && let Ok(mut state) = self.runtime.lock() {
                    state.integrity = StoreIntegrity::Failed;
                }
                Err(core_error(error))
            }
        }
    }

    fn apply_restore_backup(
        &self,
        context: &BoundModuleContext,
        request: ModuleApplyRequest<StoreAdministrationIntent>,
    ) -> Result<StoreAdministrationApplyOutcome, CoreError> {
        let Some(writer) = &self.writer else {
            return Err(unavailable(
                "Store Administration Module has no durable writer",
            ));
        };
        let Some(maintenance) = &self.maintenance else {
            return Err(unavailable(
                "Store Administration Module has no maintenance runtime",
            ));
        };
        let Some(profile_home) = &self.profile_home else {
            return Err(unavailable(
                "Store Administration Module has no managed Profile home",
            ));
        };
        let StoreAdministrationIntent::RestoreBackup {
            backup_id,
            create_safety_backup,
        } = request.intent
        else {
            unreachable!("apply validates the Store Administration intent")
        };
        let fingerprint = serde_json::to_vec(&(
            &self.profile_id,
            &self.library_id,
            request.contract_version,
            "restore_backup",
            &backup_id,
            create_safety_backup,
        ))
        .map_err(|_| unavailable("Store restore request cannot be fingerprinted"))?;
        let request_hash = sha256(&fingerprint);
        let operation_id = request.operation_id;
        let existing_journal = read_store_replacement_journal(profile_home).map_err(core_error)?;
        if let Some(journal) = &existing_journal {
            restore::validate_journal_identity(journal, &operation_id, &request_hash, &backup_id)
                .map_err(core_error)?;
        }
        let profile_id = self.profile_id.clone();
        let library_id = self.library_id.clone();
        let preflight_operation_id = operation_id.clone();
        let preflight_request_hash = request_hash.clone();
        let preflight_backup_id = backup_id.clone();
        if let Some(outcome) = writer
            .call(move |connection| {
                assert_identity(connection, &profile_id, &library_id)?;
                if let Some(outcome) =
                    replay_outcome(connection, &preflight_operation_id, &preflight_request_hash)?
                {
                    return Ok(Some(outcome));
                }
                if logically_deleted_backup_ids(connection)?.contains(&preflight_backup_id) {
                    return Err(StoreError::new(
                        StoreErrorCode::NotFound,
                        "Restore backup was not found",
                        false,
                    ));
                }
                Ok(None)
            })
            .map_err(core_error)?
        {
            if let Some(journal) = &existing_journal {
                if journal.phase != StoreReplacementPhase::Committed {
                    return Err(core_error(corrupt(
                        "Store restore receipt exists before its replacement committed",
                    )));
                }
                cleanup_store_replacement(profile_home, journal).map_err(core_error)?;
            }
            return Ok(outcome);
        }

        let installation = if let Some(journal) = existing_journal
            .as_ref()
            .filter(|journal| journal.phase == StoreReplacementPhase::Committed)
        {
            restore::RestoreInstallation {
                installed_epoch: journal
                    .installed_store_epoch
                    .clone()
                    .ok_or_else(|| corrupt("Committed Store restore has no installed epoch"))
                    .map_err(core_error)?,
                safety_backup_id: journal.safety_backup_id.clone(),
                journal: journal.clone(),
            }
        } else {
            let profile_home = profile_home.clone();
            let profile_id = self.profile_id.clone();
            let library_id = self.library_id.clone();
            let operation_id = operation_id.clone();
            let request_hash = request_hash.clone();
            let requested_store_epoch = request.store_epoch.0;
            let backup_id = backup_id.clone();
            let replacement_hook = Arc::clone(&self.store_replacement_hook);
            maintenance
                .run(move |_| {
                    operation_journal::install_restore(restore::InstallRestoreRequest {
                        profile_home: &profile_home,
                        profile_id: &profile_id,
                        library_id: &library_id,
                        operation_id: &operation_id,
                        request_hash: &request_hash,
                        requested_store_epoch: &requested_store_epoch,
                        backup_id: &backup_id,
                        create_safety_backup,
                        existing_journal,
                        replacement_hook: replacement_hook.as_ref(),
                    })
                })
                .map_err(core_error)?
        };

        let finish_profile_id = self.profile_id.clone();
        let finish_library_id = self.library_id.clone();
        let finish_context = context.clone();
        let finish_operation_id = operation_id.clone();
        let finish_request_hash = request_hash.clone();
        let finish_backup_id = backup_id.clone();
        let finish_store_epoch = installation.installed_epoch.clone();
        let finish_safety_backup_id = installation.safety_backup_id.clone();
        let outcome = writer
            .call(move |connection| {
                assert_identity(connection, &finish_profile_id, &finish_library_id)?;
                if let Some(outcome) =
                    replay_outcome(connection, &finish_operation_id, &finish_request_hash)?
                {
                    return Ok(outcome);
                }
                if read_store_epoch(connection)? != finish_store_epoch {
                    return Err(corrupt(
                        "Committed Store restore epoch changed before receipt finalization",
                    ));
                }
                let committed_at = connection.query_row(
                    "SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
                    [],
                    |row| row.get::<_, String>(0),
                )?;
                finish_restore(
                    connection,
                    &finish_library_id,
                    &finish_context,
                    &finish_operation_id,
                    &finish_request_hash,
                    &finish_store_epoch,
                    &finish_backup_id,
                    finish_safety_backup_id.as_deref(),
                    &committed_at,
                )
            })
            .map_err(core_error)?;
        cleanup_store_replacement(profile_home, &installation.journal).map_err(core_error)?;
        if let Ok(mut state) = self.runtime.lock() {
            state.integrity = StoreIntegrity::Ok;
        }
        Ok(outcome)
    }

    fn validate_context(&self, context: &BoundModuleContext) -> Result<(), CoreError> {
        if context.profile_id.0 == self.profile_id && context.library_id.0 == self.library_id {
            return Ok(());
        }
        Err(CoreError {
            code: CoreErrorCode::Unauthorized,
            message: "bound Adapter identity does not match this Store Administration Module"
                .to_owned(),
            retryable: false,
            recovery: CoreErrorRecovery::None,
        })
    }

    fn set_active(&self, operation_id: &str, phase: &str) -> Result<(), CoreError> {
        let mut state = self
            .runtime
            .lock()
            .map_err(|_| unavailable("Store Administration runtime state lock failed"))?;
        state.active = Some(ActiveOperation {
            operation_id: operation_id.to_owned(),
            phase: phase.to_owned(),
            cancellation_requested: false,
        });
        Ok(())
    }

    fn clear_active(&self) {
        if let Ok(mut state) = self.runtime.lock() {
            state.active = None;
        }
    }
}

impl Default for StoreAdministrationModule {
    fn default() -> Self {
        Self {
            profile_id: "probe-profile".to_owned(),
            library_id: "probe-library".to_owned(),
            profile_home: None,
            readers: None,
            writer: None,
            maintenance: None,
            store_replacement_hook: Arc::new(|_| Ok(())),
            operation_lock: Arc::new(Mutex::new(())),
            runtime: Arc::new(Mutex::new(RuntimeState {
                active: None,
                integrity: StoreIntegrity::Unknown,
            })),
        }
    }
}

fn replay_outcome(
    connection: &Connection,
    operation_id: &str,
    request_hash: &str,
) -> Result<Option<StoreAdministrationApplyOutcome>, StoreError> {
    let Some(mut durable) = replay_durable_outcome(
        connection,
        operation_id,
        request_hash,
        read_store_epoch(connection)?.as_str(),
    )?
    else {
        return Ok(None);
    };
    durable.committed.receipt.mutation.duplicate = true;
    Ok(Some(StoreAdministrationApplyOutcome {
        committed: durable.committed,
        event: None,
        durability: StoreAdministrationOutcomeDurability::DurableReceipt,
    }))
}

fn replay_cleanup_outcome(
    connection: &Connection,
    operation_id: &str,
    request_hash: &str,
) -> Result<Option<(StoreAdministrationApplyOutcome, Vec<String>)>, StoreError> {
    let Some(mut durable) = replay_durable_outcome(
        connection,
        operation_id,
        request_hash,
        read_store_epoch(connection)?.as_str(),
    )?
    else {
        return Ok(None);
    };
    validate_deleted_backup_ids(&durable.deleted_backup_ids)?;
    durable.committed.receipt.mutation.duplicate = true;
    Ok(Some((
        StoreAdministrationApplyOutcome {
            committed: durable.committed,
            event: None,
            durability: StoreAdministrationOutcomeDurability::DurableReceipt,
        },
        durable.deleted_backup_ids,
    )))
}

fn replay_durable_outcome(
    connection: &Connection,
    operation_id: &str,
    request_hash: &str,
    store_epoch: &str,
) -> Result<Option<DurableAdministrationOutcome>, StoreError> {
    let replayed = durable_mutation::replay_existing(
        connection,
        ReplayIdentity {
            module: ModuleName::StoreAdministration,
            module_name: MODULE_NAME,
            operation_id,
            intent_hash: request_hash,
            store_epoch,
        },
    )?;
    match replayed {
        Some(CommitResult::IdempotentReplay { outcome, .. }) => Ok(Some(outcome)),
        Some(CommitResult::Committed { .. } | CommitResult::NoOp { .. }) => Err(corrupt(
            "Stored Store Administration replay returned a fresh disposition",
        )),
        None => Ok(None),
    }
}

fn read_backup_start_coalescences(
    connection: &Connection,
) -> Result<Vec<BackupStartCoalescence>, StoreError> {
    let outcomes = connection
        .prepare(
            "SELECT result_json FROM core_module_receipts \
             WHERE module_name = ?1 AND operation_kind = 'coalesce_backup' \
             ORDER BY committed_at DESC, operation_id DESC LIMIT ?2",
        )?
        .query_map(
            params![MODULE_NAME, MAX_BACKUP_START_COALESCENCES as i64],
            |row| row.get::<_, String>(0),
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    outcomes
        .into_iter()
        .map(|raw| {
            let durable = serde_json::from_str::<DurableAdministrationOutcome>(&raw)
                .map_err(|_| corrupt("Durable Backup coalescence receipt JSON is invalid"))?;
            let operation_id = durable.committed.receipt.mutation.operation_id;
            let active_job_id = durable
                .committed
                .value
                .coalesced_backup_job_id
                .ok_or_else(|| corrupt("Durable Backup coalescence target is missing"))?;
            if operation_id.is_empty()
                || operation_id.len() > MAX_OPERATION_ID_BYTES
                || active_job_id.is_empty()
                || active_job_id.len() > MAX_OPERATION_ID_BYTES
            {
                return Err(corrupt("Durable Backup coalescence identity is invalid"));
            }
            Ok(BackupStartCoalescence {
                operation_id,
                active_job_id,
            })
        })
        .collect()
}

fn logically_deleted_backup_ids(connection: &Connection) -> Result<BTreeSet<String>, StoreError> {
    let result_json = connection
        .prepare(
            "SELECT result_json FROM core_module_receipts \
             WHERE module_name = ?1 AND operation_kind IN ('delete_backup', 'prune_backups') \
             ORDER BY committed_at, operation_id LIMIT 10001",
        )?
        .query_map([MODULE_NAME], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if result_json.len() > 10_000 {
        return Err(corrupt(
            "Durable backup deletion ledger exceeds its row bound",
        ));
    }
    let mut deleted = BTreeSet::new();
    for raw in result_json {
        let evidence = serde_json::from_str::<DurableBackupDeletionEvidence>(&raw)
            .map_err(|_| corrupt("Durable backup deletion receipt JSON is invalid"))?;
        validate_deleted_backup_ids(&evidence.deleted_backup_ids)?;
        for backup_id in evidence.deleted_backup_ids {
            deleted.insert(backup_id);
        }
    }
    Ok(deleted)
}

fn validate_deleted_backup_ids(values: &[String]) -> Result<(), StoreError> {
    if values.len() > 10_000 {
        return Err(corrupt(
            "Durable backup deletion receipt exceeds its identity bound",
        ));
    }
    if values
        .iter()
        .any(|backup_id| !backup::is_safe_backup_id(backup_id))
    {
        return Err(corrupt("Durable backup deletion identity is invalid"));
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn finish_administration_mutation(
    connection: &mut Connection,
    library_id: &str,
    context: &BoundModuleContext,
    operation_id: &str,
    request_hash: &str,
    store_epoch: &str,
    operation_kind: &str,
    committed_at: &str,
    value: StoreAdministrationCommitValue,
    deleted_backup_ids: Vec<String>,
    event_payload: StoreAdministrationEvent,
    changed: bool,
) -> Result<StoreAdministrationApplyOutcome, StoreError> {
    validate_deleted_backup_ids(&deleted_backup_ids)?;
    with_immediate_transaction(connection, |transaction| {
        let result = durable_mutation::run(
            transaction,
            OperationIdentity {
                module: ModuleName::StoreAdministration,
                module_name: MODULE_NAME,
                operation_id,
                intent_hash: request_hash,
                store_epoch,
                committed_at,
                context,
            },
            |scope| {
                if changed {
                    local_commit::record_administration_effect(
                        transaction,
                        scope.evidence(),
                        library_id,
                        &event_payload,
                    )?;
                }
                let commit_seq = if changed {
                    scope.commit_seq()
                } else {
                    local_commit::head(transaction)?
                };
                let committed = crate::ModuleWriterResult {
                    value: value.clone(),
                    receipt: StoreAdministrationReceipt {
                        mutation: ModuleMutationReceipt {
                            operation_id: operation_id.to_owned(),
                            duplicate: false,
                        },
                        backup_id: value.backup_id.clone(),
                        safety_backup_id: value.safety_backup_id.clone(),
                    },
                    commit_seq,
                    event_sequence: 0,
                    store_epoch: StoreEpoch(store_epoch.to_owned()),
                };
                let durable = DurableAdministrationOutcome {
                    committed,
                    deleted_backup_ids: deleted_backup_ids.clone(),
                };
                let receipt = ReceiptMetadata {
                    operation_kind,
                    event_sequence: None,
                    committed_at,
                };
                Ok(if changed {
                    scope.seal(durable, receipt)
                } else {
                    scope.no_op(durable, receipt)
                })
            },
        )?;
        result.verify_manifest_identity(|durable| {
            (
                durable.committed.commit_seq,
                durable.committed.store_epoch.0.clone(),
            )
        })?;
        let (mut durable, replayed) = match result {
            CommitResult::Committed { outcome, .. } | CommitResult::NoOp { outcome } => {
                (outcome, false)
            }
            CommitResult::IdempotentReplay { outcome, .. } => (outcome, true),
        };
        if replayed {
            durable.committed.receipt.mutation.duplicate = true;
        }
        Ok(StoreAdministrationApplyOutcome {
            committed: durable.committed,
            event: None,
            durability: StoreAdministrationOutcomeDurability::DurableReceipt,
        })
    })
}

fn finish_backup_creation(
    connection: &mut Connection,
    library_id: &str,
    context: &BoundModuleContext,
    operation_id: &str,
    request_hash: &str,
    store_epoch: &str,
    backup: &BackupRecord,
) -> Result<StoreAdministrationApplyOutcome, StoreError> {
    finish_administration_mutation(
        connection,
        library_id,
        context,
        operation_id,
        request_hash,
        store_epoch,
        "create_backup",
        &backup.created_at,
        StoreAdministrationCommitValue {
            backup_id: Some(backup.backup_id.clone()),
            safety_backup_id: None,
            cancelled_backup_job_id: None,
            coalesced_backup_job_id: None,
            completed_tasks: Vec::new(),
        },
        Vec::new(),
        StoreAdministrationEvent {
            kind: StoreAdministrationEventKind::StoreAdministrationChanged,
            operation: "create_backup".to_owned(),
            backup_ids: vec![backup.backup_id.clone()],
            readiness_changed: false,
        },
        true,
    )
}

#[allow(clippy::too_many_arguments)]
fn finish_cleanup_operation(
    connection: &mut Connection,
    library_id: &str,
    context: &BoundModuleContext,
    operation_id: &str,
    request_hash: &str,
    store_epoch: &str,
    operation_kind: &str,
    backup_id: Option<&str>,
    deleted_backup_ids: &[String],
    committed_at: &str,
) -> Result<StoreAdministrationApplyOutcome, StoreError> {
    finish_administration_mutation(
        connection,
        library_id,
        context,
        operation_id,
        request_hash,
        store_epoch,
        operation_kind,
        committed_at,
        StoreAdministrationCommitValue {
            backup_id: backup_id.map(str::to_owned),
            safety_backup_id: None,
            cancelled_backup_job_id: None,
            coalesced_backup_job_id: None,
            completed_tasks: Vec::new(),
        },
        deleted_backup_ids.to_vec(),
        StoreAdministrationEvent {
            kind: StoreAdministrationEventKind::StoreAdministrationChanged,
            operation: operation_kind.to_owned(),
            backup_ids: deleted_backup_ids.to_vec(),
            readiness_changed: false,
        },
        !deleted_backup_ids.is_empty(),
    )
}

fn validate_maintenance_attempt(
    connection: &Connection,
    profile_id: &str,
    library_id: &str,
    requested_store_epoch: &str,
) -> Result<String, StoreError> {
    assert_identity(connection, profile_id, library_id)?;
    let store_epoch = read_store_epoch(connection)?;
    if requested_store_epoch != store_epoch {
        return Err(stale_store_epoch());
    }
    Ok(store_epoch)
}

fn plan_maintenance_due_work(
    connection: &Connection,
    tasks: &[MaintenanceTask],
    block_retention_count: usize,
    commit_head: i64,
) -> Result<MaintenanceDueWorkPlan, StoreError> {
    let now_ms = connection.query_row(
        "SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER)",
        [],
        |row| row.get::<_, i64>(0),
    )?;
    let mut due_tasks = Vec::new();
    let mut next_wake_at_ms = None;
    for task in tasks {
        let due = match task {
            MaintenanceTask::IntegrityCheck | MaintenanceTask::ForeignKeyCheck => true,
            MaintenanceTask::DocumentRevisionFinalize => {
                let next = crate::document::next_revision_maintenance_at_ms(connection)?;
                if let Some(next) = next {
                    next_wake_at_ms =
                        Some(next_wake_at_ms.map_or(next, |current: i64| current.min(next)));
                }
                next.is_some_and(|next| next <= now_ms)
            }
            MaintenanceTask::DocumentCompaction => {
                crate::document::has_document_compaction_work(connection)?
            }
            MaintenanceTask::HistoryRetention => {
                crate::document::has_document_history_retention_work(connection)?
            }
            MaintenanceTask::BlockRetention => {
                let (due, next) = crate::document::plan_block_retention_due_work(
                    connection,
                    block_retention_count,
                )?;
                if let Some(next) = next {
                    next_wake_at_ms =
                        Some(next_wake_at_ms.map_or(next, |current: i64| current.min(next)));
                }
                due
            }
            MaintenanceTask::OperationalJournal => {
                let (due, next) =
                    crate::infrastructure::operational_journal::plan_due_work(connection)?;
                if let Some(next) = next {
                    next_wake_at_ms =
                        Some(next_wake_at_ms.map_or(next, |current: i64| current.min(next)));
                }
                due
            }
        };
        if due {
            due_tasks.push(*task);
        }
    }
    let work_token = (!due_tasks.is_empty())
        .then(|| maintenance_work_token(connection, &due_tasks, block_retention_count, commit_head))
        .transpose()?;
    Ok(MaintenanceDueWorkPlan {
        due_tasks,
        next_wake_at_ms,
        work_token,
    })
}

fn maintenance_work_token(
    connection: &Connection,
    due_tasks: &[MaintenanceTask],
    block_retention_count: usize,
    commit_head: i64,
) -> Result<String, StoreError> {
    let journal_revision = if due_tasks.contains(&MaintenanceTask::OperationalJournal) {
        Some(crate::infrastructure::operational_journal::work_revision(
            connection,
        )?)
    } else {
        None
    };
    let block_retention_revision = if due_tasks.contains(&MaintenanceTask::BlockRetention) {
        Some(crate::document::block_retention_work_revision(connection)?)
    } else {
        None
    };
    let encoded = serde_json::to_vec(&(
        commit_head,
        due_tasks,
        block_retention_count,
        journal_revision,
        block_retention_revision,
    ))
    .map_err(|_| internal("Store maintenance plan cannot be fingerprinted"))?;
    Ok(format!("maintenance-due:{}", sha256(&encoded)))
}

fn run_maintenance_task(
    connection: &mut Connection,
    context: &BoundModuleContext,
    task: MaintenanceTask,
) -> Result<usize, StoreError> {
    match task {
        MaintenanceTask::IntegrityCheck => {
            let integrity = connection
                .query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))?;
            if integrity != "ok" {
                return Err(corrupt(format!(
                    "SQLite integrity_check failed: {integrity}"
                )));
            }
        }
        MaintenanceTask::ForeignKeyCheck => {
            let violations = connection.query_row(
                "SELECT count(*) FROM pragma_foreign_key_check",
                [],
                |row| row.get::<_, i64>(0),
            )?;
            if violations != 0 {
                return Err(corrupt(format!(
                    "SQLite foreign_key_check found {violations} violations"
                )));
            }
        }
        MaintenanceTask::DocumentRevisionFinalize => {
            return crate::document::finalize_idle_document_revisions(connection, context);
        }
        MaintenanceTask::DocumentCompaction => {
            return crate::document::compact_eligible_documents(connection);
        }
        MaintenanceTask::HistoryRetention => {
            return crate::document::prune_document_history_pass(connection);
        }
        MaintenanceTask::BlockRetention => {
            return Err(internal(
                "Block retention must run through the sliced maintenance coordinator",
            ));
        }
        MaintenanceTask::OperationalJournal => {
            let _pass = crate::infrastructure::operational_journal::run_bounded_pass(connection)?;
            // Operational retention advances replay metadata, not product
            // state, so it must not manufacture another semantic LocalCommit.
            return Ok(0);
        }
    }
    Ok(0)
}

#[allow(clippy::too_many_arguments)]
fn finish_maintenance(
    connection: &mut Connection,
    library_id: &str,
    context: &BoundModuleContext,
    operation_id: &str,
    request_hash: &str,
    store_epoch: &str,
    completed_tasks: &[MaintenanceTask],
    changed_rows: usize,
    committed_at: &str,
) -> Result<StoreAdministrationApplyOutcome, StoreError> {
    if changed_rows == 0 {
        // A read-only check or an Operational Journal slice has no product
        // outcome to replay. Persisting a no-op receipt here would make idle
        // maintenance grow the very journal it is responsible for bounding.
        return Ok(StoreAdministrationApplyOutcome {
            committed: crate::ModuleWriterResult {
                value: StoreAdministrationCommitValue {
                    backup_id: None,
                    safety_backup_id: None,
                    cancelled_backup_job_id: None,
                    coalesced_backup_job_id: None,
                    completed_tasks: completed_tasks.to_vec(),
                },
                receipt: StoreAdministrationReceipt {
                    mutation: ModuleMutationReceipt {
                        operation_id: operation_id.to_owned(),
                        duplicate: false,
                    },
                    backup_id: None,
                    safety_backup_id: None,
                },
                commit_seq: local_commit::head(connection)?,
                event_sequence: 0,
                store_epoch: StoreEpoch(store_epoch.to_owned()),
            },
            event: None,
            durability: StoreAdministrationOutcomeDurability::Transient,
        });
    }
    finish_administration_mutation(
        connection,
        library_id,
        context,
        operation_id,
        request_hash,
        store_epoch,
        "run_maintenance",
        committed_at,
        StoreAdministrationCommitValue {
            backup_id: None,
            safety_backup_id: None,
            cancelled_backup_job_id: None,
            coalesced_backup_job_id: None,
            completed_tasks: completed_tasks.to_vec(),
        },
        Vec::new(),
        StoreAdministrationEvent {
            kind: StoreAdministrationEventKind::StoreAdministrationChanged,
            operation: "run_maintenance".to_owned(),
            backup_ids: Vec::new(),
            readiness_changed: true,
        },
        true,
    )
}

#[allow(clippy::too_many_arguments)]
fn finish_restore(
    connection: &mut Connection,
    library_id: &str,
    context: &BoundModuleContext,
    operation_id: &str,
    request_hash: &str,
    store_epoch: &str,
    backup_id: &str,
    safety_backup_id: Option<&str>,
    committed_at: &str,
) -> Result<StoreAdministrationApplyOutcome, StoreError> {
    let mut backup_ids = vec![backup_id.to_owned()];
    if let Some(safety_backup_id) = safety_backup_id {
        backup_ids.push(safety_backup_id.to_owned());
    }
    finish_administration_mutation(
        connection,
        library_id,
        context,
        operation_id,
        request_hash,
        store_epoch,
        "restore_backup",
        committed_at,
        StoreAdministrationCommitValue {
            backup_id: Some(backup_id.to_owned()),
            safety_backup_id: safety_backup_id.map(str::to_owned),
            cancelled_backup_job_id: None,
            coalesced_backup_job_id: None,
            completed_tasks: Vec::new(),
        },
        Vec::new(),
        StoreAdministrationEvent {
            kind: StoreAdministrationEventKind::StoreAdministrationChanged,
            operation: "restore_backup".to_owned(),
            backup_ids,
            readiness_changed: true,
        },
        true,
    )
}

fn assert_identity(
    connection: &Connection,
    profile_id: &str,
    library_id: &str,
) -> Result<(), StoreError> {
    let identity = connection
        .query_row(
            "SELECT 1 FROM libraries WHERE id = ?1 AND profile_id = ?2",
            params![library_id, profile_id],
            |_| Ok(()),
        )
        .optional()?;
    if identity.is_some() {
        return Ok(());
    }
    Err(StoreError::new(
        StoreErrorCode::Unauthorized,
        "bound Store Administration identity is not present in this Profile store",
        false,
    ))
}

fn read_store_epoch(connection: &Connection) -> Result<String, StoreError> {
    connection
        .query_row(
            "SELECT store_epoch FROM block_store_metadata WHERE id = 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .ok_or_else(|| corrupt("Profile store epoch is unavailable"))
}

fn require_private_adapter(context: &BoundModuleContext) -> Result<(), CoreError> {
    if matches!(
        context.adapter,
        AdapterKind::ElectronHost | AdapterKind::NativeCli | AdapterKind::Test
    ) {
        return Ok(());
    }
    Err(CoreError {
        code: CoreErrorCode::Unauthorized,
        message: "Store Administration mutations require a private trusted Adapter".to_owned(),
        retryable: false,
        recovery: CoreErrorRecovery::None,
    })
}

fn normalize_label(label: &Option<String>) -> Result<Option<String>, CoreError> {
    let normalized = label
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if normalized.is_some_and(|value| value.chars().count() > MAX_LABEL_CHARS) {
        return Err(invalid("backup label exceeds its character bound"));
    }
    Ok(normalized.map(str::to_owned))
}

fn normalize_maintenance_tasks(
    tasks: &[MaintenanceTask],
) -> Result<Vec<MaintenanceTask>, CoreError> {
    const ORDER: [MaintenanceTask; 7] = [
        MaintenanceTask::IntegrityCheck,
        MaintenanceTask::ForeignKeyCheck,
        MaintenanceTask::DocumentRevisionFinalize,
        MaintenanceTask::DocumentCompaction,
        MaintenanceTask::HistoryRetention,
        MaintenanceTask::BlockRetention,
        MaintenanceTask::OperationalJournal,
    ];
    if tasks.is_empty() || tasks.len() > ORDER.len() {
        return Err(invalid(
            "maintenance tasks must contain one to six unique tasks",
        ));
    }
    let mut normalized = Vec::new();
    for task in ORDER {
        let count = tasks.iter().filter(|candidate| **candidate == task).count();
        if count > 1 {
            return Err(invalid("maintenance tasks must not contain duplicates"));
        }
        if count == 1 {
            normalized.push(task);
        }
    }
    Ok(normalized)
}

fn validate_operation_id(operation_id: &str) -> Result<(), CoreError> {
    if operation_id.is_empty() || operation_id.len() > MAX_OPERATION_ID_BYTES {
        return Err(invalid("operation_id is empty or exceeds its byte bound"));
    }
    Ok(())
}

fn sqlite_now(connection: &Connection) -> Result<String, StoreError> {
    connection
        .query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", [], |row| {
            row.get::<_, String>(0)
        })
        .map_err(Into::into)
}

fn backup_request_hash(
    profile_id: &str,
    library_id: &str,
    contract_version: u32,
    store_epoch: &StoreEpoch,
    normalized_label: &Option<String>,
    include_assets: bool,
    trigger: BackupTrigger,
) -> Result<String, CoreError> {
    serde_json::to_vec(&(
        profile_id,
        library_id,
        contract_version,
        store_epoch,
        normalized_label,
        include_assets,
        trigger,
    ))
    .map(|fingerprint| sha256(&fingerprint))
    .map_err(|_| unavailable("Store Administration request cannot be fingerprinted"))
}

fn stale_store_epoch() -> StoreError {
    StoreError::new(
        StoreErrorCode::StaleStoreEpoch,
        "Store Administration mutation targets a stale store epoch",
        true,
    )
}

fn invalid_store(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message, false)
}

fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn duration_millis(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

fn fail_backup_job(
    profile_home: &Path,
    operation_id: &str,
    user_message: &str,
    cause: StoreError,
) -> CoreError {
    let cancelled = cause.code == StoreErrorCode::QueryCancelled;
    if let Err(journal_error) = backup::update_backup_job_phase(
        profile_home,
        operation_id,
        if cancelled {
            BackupJobState::Cancelled
        } else {
            BackupJobState::Failed
        },
        if cancelled {
            BackupJobPhase::Cancelled
        } else {
            BackupJobPhase::Failed
        },
        (!cancelled).then_some(user_message),
    ) {
        return core_error(journal_error);
    }
    core_error(cause)
}

fn core_error(error: StoreError) -> CoreError {
    let code = match error.code {
        StoreErrorCode::InvalidInput => CoreErrorCode::InvalidInput,
        StoreErrorCode::Unauthorized => CoreErrorCode::Unauthorized,
        StoreErrorCode::NotFound => CoreErrorCode::NotFound,
        StoreErrorCode::PatchNotFound => CoreErrorCode::PatchNotFound,
        StoreErrorCode::PatchAmbiguous => CoreErrorCode::PatchAmbiguous,
        StoreErrorCode::PatchOverlap => CoreErrorCode::PatchOverlap,
        StoreErrorCode::StaleStoreEpoch => CoreErrorCode::StaleStoreEpoch,
        StoreErrorCode::Conflict => CoreErrorCode::Conflict,
        StoreErrorCode::GenerationConflict => CoreErrorCode::GenerationConflict,
        StoreErrorCode::HeadConflict => CoreErrorCode::HeadConflict,
        StoreErrorCode::RevisionConflict => CoreErrorCode::RevisionConflict,
        StoreErrorCode::IdempotencyKeyReused => CoreErrorCode::IdempotencyKeyReused,
        StoreErrorCode::IdempotencyWindowExpired => CoreErrorCode::IdempotencyWindowExpired,
        StoreErrorCode::LegacyIdempotencyUnavailable => CoreErrorCode::LegacyIdempotencyUnavailable,
        StoreErrorCode::ProtectedOwnerDeletion => CoreErrorCode::ProtectedOwnerDeletion,
        StoreErrorCode::MissingDependencies => CoreErrorCode::DocumentUpdateMissingDependencies,
        StoreErrorCode::MaterializationStale => CoreErrorCode::MaterializationStale,
        StoreErrorCode::UnsupportedSchema
        | StoreErrorCode::AlreadyOwned
        | StoreErrorCode::InvalidProfile
        | StoreErrorCode::RuntimeIncompatible => CoreErrorCode::SchemaUnsupported,
        StoreErrorCode::StoreCorrupt => CoreErrorCode::StoreCorrupt,
        StoreErrorCode::MaintenanceInProgress => CoreErrorCode::MaintenanceInProgress,
        StoreErrorCode::ResourceExhausted => CoreErrorCode::ResourceExhausted,
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

fn maintenance_in_progress() -> CoreError {
    CoreError {
        code: CoreErrorCode::MaintenanceInProgress,
        message: "Another Store Administration operation is already active".to_owned(),
        retryable: true,
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

fn corrupt(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message, false)
}

fn internal(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::Internal, message, false)
}
