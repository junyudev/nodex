use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::collection::{CollectionWindow, CollectionWindowRequest};
use crate::{ModuleMutationReceipt, ModuleName, VersionedModuleContract};

pub const STORE_ADMINISTRATION_CONTRACT_VERSION: u32 = 8;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StoreAdministrationRead {
    Status,
    Backups {
        window: CollectionWindowRequest,
    },
    BackupJobs,
    OperationalJournalStatus,
    MaintenanceStatus,
    MaintenancePlan {
        tasks: Vec<MaintenanceTask>,
        block_retention_count: Option<u64>,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StoreAdministrationReadValue {
    Status {
        readiness: StoreReadiness,
        schema_version: u32,
        schema_owner: SchemaOwner,
        integrity: StoreIntegrity,
    },
    Backups {
        backups: CollectionWindow<BackupRecord>,
        capacity: BackupCapacity,
    },
    BackupJobs {
        jobs: Vec<BackupJobRecord>,
        coalesced_starts: Vec<BackupStartCoalescence>,
    },
    OperationalJournalStatus {
        status: OperationalJournalStatus,
    },
    MaintenanceStatus {
        active: bool,
        operation_id: Option<String>,
        phase: Option<String>,
    },
    MaintenancePlan {
        plan: MaintenanceDueWorkPlan,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct OperationalJournalStatus {
    pub optimizing: bool,
    pub commit_head_seq: u64,
    pub replay_floor_seq: u64,
    pub pending_commit_metadata: u64,
    pub pending_receipt_metadata: u64,
    pub retained_commit_count: u64,
    pub retained_delivery_bytes: u64,
    pub retained_receipt_count: u64,
    pub retained_receipt_bytes: u64,
    pub receipt_floor_at: Option<String>,
    pub last_pruned_commit_seq: u64,
    pub freelist_pages: u64,
    pub reclaimable_bytes: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct MaintenanceDueWorkPlan {
    pub due_tasks: Vec<MaintenanceTask>,
    pub next_wake_at_ms: Option<i64>,
    pub work_token: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum StoreReadiness {
    Starting,
    Ready,
    Maintenance,
    Failed,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum SchemaOwner {
    TypeScript,
    Rust,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum StoreIntegrity {
    Unknown,
    Ok,
    Failed,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct BackupRecord {
    pub version: u32,
    pub backup_id: String,
    pub trigger: BackupTrigger,
    pub label: Option<String>,
    pub created_at: String,
    pub includes_assets: bool,
    pub db_bytes: u64,
    pub assets_bytes: u64,
    pub total_bytes: u64,
    pub byte_length: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct BackupCapacity {
    pub available_bytes: u64,
    pub estimated_next_backup_bytes: u64,
    pub safety_margin_bytes: u64,
    pub total_ready_bytes: u64,
    pub manual_ready_bytes: u64,
    pub automatic_ready_bytes: u64,
    pub can_create: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct BackupJobRecord {
    pub job_id: String,
    pub operation_id: String,
    pub state: BackupJobState,
    pub phase: BackupJobPhase,
    pub completed_units: u64,
    pub total_units: u64,
    pub started_at_ms: i64,
    pub updated_at_ms: i64,
    pub label: Option<String>,
    pub include_assets: bool,
    pub trigger: BackupTrigger,
    pub backup_id: String,
    pub error: Option<String>,
    pub progress: BackupJobProgress,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct BackupStartCoalescence {
    pub operation_id: String,
    pub active_job_id: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum BackupJobState {
    Running,
    Cancelling,
    Cancelled,
    Ready,
    Failed,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum BackupJobPhase {
    Queued,
    Preparing,
    CancellationRequested,
    Cancelled,
    DatabaseSnapshot,
    AssetCopy,
    Validation,
    Digest,
    Commit,
    Publishing,
    Ready,
    Failed,
}

impl BackupJobPhase {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Preparing => "preparing",
            Self::CancellationRequested => "cancellation_requested",
            Self::Cancelled => "cancelled",
            Self::DatabaseSnapshot => "database_snapshot",
            Self::AssetCopy => "asset_copy",
            Self::Validation => "validation",
            Self::Digest => "digest",
            Self::Commit => "commit",
            Self::Publishing => "publishing",
            Self::Ready => "ready",
            Self::Failed => "failed",
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct BackupJobProgress {
    pub database_copied_pages: u64,
    pub database_total_pages: u64,
    pub database_busy_retries: u64,
    pub asset_bytes_copied: u64,
    pub database_copy_ms: u64,
    pub asset_copy_ms: u64,
    pub validation_ms: u64,
    pub digest_ms: u64,
    pub publish_ms: u64,
    pub writer_held_ms: u64,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "kebab-case")]
pub enum BackupTrigger {
    Manual,
    Auto,
    PreRestore,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StoreAdministrationIntent {
    CreateBackup {
        label: Option<String>,
        include_assets: bool,
        trigger: BackupTrigger,
    },
    CoalesceBackup {
        active_job_id: String,
        label: Option<String>,
        include_assets: bool,
        trigger: BackupTrigger,
    },
    CancelBackup {
        job_id: String,
    },
    RestoreBackup {
        backup_id: String,
        create_safety_backup: bool,
    },
    DeleteBackup {
        backup_id: String,
    },
    PruneBackups {
        retain_count: u32,
        retain_bytes: u64,
    },
    RunMaintenance {
        tasks: Vec<MaintenanceTask>,
        block_retention_count: Option<u64>,
        work_token: Option<String>,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum MaintenanceTask {
    IntegrityCheck,
    ForeignKeyCheck,
    DocumentRevisionFinalize,
    DocumentCompaction,
    HistoryRetention,
    BlockRetention,
    OperationalJournal,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct StoreAdministrationCommitValue {
    pub backup_id: Option<String>,
    pub safety_backup_id: Option<String>,
    pub cancelled_backup_job_id: Option<String>,
    #[serde(default)]
    pub coalesced_backup_job_id: Option<String>,
    pub completed_tasks: Vec<MaintenanceTask>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct StoreAdministrationReceipt {
    #[serde(flatten)]
    pub mutation: ModuleMutationReceipt,
    pub backup_id: Option<String>,
    pub safety_backup_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct StoreAdministrationEvent {
    pub kind: StoreAdministrationEventKind,
    pub operation: String,
    pub backup_ids: Vec<String>,
    pub readiness_changed: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum StoreAdministrationEventKind {
    StoreAdministrationChanged,
}

pub struct StoreAdministrationContract;

impl VersionedModuleContract for StoreAdministrationContract {
    type Read = StoreAdministrationRead;
    type Snapshot = StoreAdministrationReadValue;
    type Intent = StoreAdministrationIntent;
    type Receipt = StoreAdministrationReceipt;
    type Event = StoreAdministrationEvent;

    const VERSION: u32 = STORE_ADMINISTRATION_CONTRACT_VERSION;
    const MODULE: ModuleName = ModuleName::StoreAdministration;
}
