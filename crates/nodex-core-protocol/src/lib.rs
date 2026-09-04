#![forbid(unsafe_code)]

use nodex_core_contracts::{
    AddressReset, AddressResetReason, ApplyResponse, AuthorizedDeliveryPacket, AuthorizedReadStamp,
    AuthorizedRecipientLease, CORE_EVENT_VERSION, CoreError, DeliveryAddress,
    DeliveryAuthorizationScope, ModuleApplyRequest, ModuleContractVersion, ModuleName,
    ModuleReadRequest, ModuleReadSnapshot, StoreEpoch, StreamCheckpoint,
    administration::{
        StoreAdministrationCommitValue, StoreAdministrationIntent, StoreAdministrationRead,
        StoreAdministrationReadValue, StoreAdministrationReceipt,
    },
    automation::{
        AutomationCommitValue, AutomationIntent, AutomationRead, AutomationReadValue,
        AutomationReceipt,
    },
    database::{
        DatabaseCommitValue, DatabaseIntent, DatabaseRead, DatabaseReadValue, DatabaseReceipt,
    },
    document::{
        OwnedDocumentCommitValue, OwnedDocumentEvent, OwnedDocumentIntent, OwnedDocumentRead,
        OwnedDocumentReadValue, OwnedDocumentReceipt,
    },
    library::{
        LibraryCommitValue, LibraryIntent, LibraryRead, LibraryReadValue, LibraryReceipt,
        PreparedBlobReceipt,
    },
    workspace::{
        ProjectWorkspaceCommitValue, ProjectWorkspaceIntent, ProjectWorkspaceRead,
        ProjectWorkspaceReadValue, ProjectWorkspaceReceipt,
    },
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use utoipa::{IntoParams, OpenApi, ToSchema};

pub use nodex_store_format::{
    CURRENT_STORE_SCHEMA_FINGERPRINT, CURRENT_STORE_VERSION, MIN_SUPPORTED_STORE_REVISION,
    STORE_LINEAGE,
};

pub const TRANSPORT_PROTOCOL_MIN: u32 = 12;
pub const TRANSPORT_PROTOCOL_MAX: u32 = 12;
pub const MAX_FILE_BLOB_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_MANAGED_BLOB_BYTES: usize = nodex_core_contracts::MAX_MANAGED_BLOB_BYTES as usize;
pub const COMPATIBILITY_MANIFEST_VERSION: u32 = 1;
pub const MAX_ORDINARY_JSON_REQUEST_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_ORDINARY_JSON_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_EVENT_FRAME_BYTES: usize = (2 * 1024 * 1024) + (256 * 1024);
/// Maximum decoded UTF-8 size of one JSON string on the Document transport.
///
/// This is also the public Page body input bound: JSON escaping may make the
/// encoded request substantially larger than the decoded string.
pub const MAX_DOCUMENT_JSON_STRING_BYTES: usize = 8 * 1024 * 1024;
/// Maximum encoded JSON body accepted by a Document HTTP endpoint.
pub const MAX_DOCUMENT_JSON_REQUEST_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_DOCUMENT_RESPONSE_BYTES: usize =
    MAX_ORDINARY_JSON_RESPONSE_BYTES + MAX_DOCUMENT_JSON_STRING_BYTES + 8;
pub const MIN_REQUEST_DEADLINE_MS: u64 = 250;
pub const MAX_REQUEST_DEADLINE_MS: u64 = 5 * 60_000;
pub const INTERACTIVE_REQUEST_DEADLINE_MS: u64 = 20_000;
pub const BACKGROUND_REQUEST_DEADLINE_MS: u64 = 60_000;
pub const MAINTENANCE_REQUEST_DEADLINE_MS: u64 = 120_000;

#[derive(Clone, Debug, Deserialize, Eq, IntoParams, PartialEq, Serialize, ToSchema)]
#[into_params(parameter_in = Query)]
pub struct PrepareFileBlobQuery {
    pub operation_id: String,
    pub store_epoch: String,
    pub idempotency_slot: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, IntoParams, PartialEq, Serialize, ToSchema)]
#[into_params(parameter_in = Query)]
pub struct ReadFileBlobQuery {
    #[serde(flatten)]
    pub source: nodex_core_contracts::library::LibraryFileReadSource,
    pub version: Option<i64>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct CoreTransportBudgets {
    pub ordinary_json_request_bytes: u64,
    pub ordinary_json_response_bytes: u64,
    pub event_frame_bytes: u64,
    pub document_json_request_bytes: u64,
    pub document_response_bytes: u64,
    pub file_blob_bytes: u64,
    pub managed_blob_bytes: u64,
    pub request_deadline_min_ms: u64,
    pub request_deadline_max_ms: u64,
    pub interactive_request_deadline_ms: u64,
    pub background_request_deadline_ms: u64,
    pub maintenance_request_deadline_ms: u64,
}

pub const CORE_TRANSPORT_BUDGETS: CoreTransportBudgets = CoreTransportBudgets {
    ordinary_json_request_bytes: MAX_ORDINARY_JSON_REQUEST_BYTES as u64,
    ordinary_json_response_bytes: MAX_ORDINARY_JSON_RESPONSE_BYTES as u64,
    event_frame_bytes: MAX_EVENT_FRAME_BYTES as u64,
    document_json_request_bytes: MAX_DOCUMENT_JSON_REQUEST_BYTES as u64,
    document_response_bytes: MAX_DOCUMENT_RESPONSE_BYTES as u64,
    file_blob_bytes: MAX_FILE_BLOB_BYTES as u64,
    managed_blob_bytes: MAX_MANAGED_BLOB_BYTES as u64,
    request_deadline_min_ms: MIN_REQUEST_DEADLINE_MS,
    request_deadline_max_ms: MAX_REQUEST_DEADLINE_MS,
    interactive_request_deadline_ms: INTERACTIVE_REQUEST_DEADLINE_MS,
    background_request_deadline_ms: BACKGROUND_REQUEST_DEADLINE_MS,
    maintenance_request_deadline_ms: MAINTENANCE_REQUEST_DEADLINE_MS,
};

pub fn store_format(version: u32) -> Option<StoreFormatIdentity> {
    let format = nodex_store_format::published_store_format(version)?;
    Some(StoreFormatIdentity {
        lineage: STORE_LINEAGE.to_owned(),
        version,
        schema_fingerprint: format.schema_fingerprint.to_owned(),
    })
}

pub fn core_compatibility_manifest() -> CoreCompatibilityManifest {
    CoreCompatibilityManifest {
        manifest_version: COMPATIBILITY_MANIFEST_VERSION,
        transport: VersionRange {
            min: TRANSPORT_PROTOCOL_MIN,
            max: TRANSPORT_PROTOCOL_MAX,
        },
        event_versions: VersionRange::exact(CORE_EVENT_VERSION),
        modules: nodex_core_contracts::module_contract_manifest()
            .into_iter()
            .map(|entry| ModuleContractSupport {
                module: entry.module,
                versions: VersionRange::exact(entry.contract_version),
            })
            .collect(),
        store: StoreFormatSupport {
            readable: vec![store_format(CURRENT_STORE_VERSION).expect("current Store format")],
            migratable: (MIN_SUPPORTED_STORE_REVISION..CURRENT_STORE_VERSION)
                .map(|version| store_format(version).expect("supported Store format"))
                .collect(),
            current: store_format(CURRENT_STORE_VERSION).expect("current Store format"),
        },
    }
}

pub fn core_client_requirements() -> CoreClientRequirements {
    CoreClientRequirements {
        transport: VersionRange {
            min: TRANSPORT_PROTOCOL_MIN,
            max: TRANSPORT_PROTOCOL_MAX,
        },
        event_version: CORE_EVENT_VERSION,
        modules: nodex_core_contracts::module_contract_manifest().to_vec(),
        accepted_store_formats: vec![
            store_format(CURRENT_STORE_VERSION).expect("current Store format"),
        ],
    }
}

pub fn canonical_manifest_digest(
    manifest: &CoreCompatibilityManifest,
) -> Result<String, CompatibilityMismatch> {
    validate_manifest(manifest)?;
    let encoded = serde_json::to_vec(manifest).map_err(|_| CompatibilityMismatch {
        axis: CompatibilityAxis::Manifest,
        required: "canonical JSON".to_owned(),
        offered: "unencodable manifest".to_owned(),
    })?;
    Ok(hex::encode(Sha256::digest(encoded)))
}

pub fn validate_manifest(
    manifest: &CoreCompatibilityManifest,
) -> Result<(), CompatibilityMismatch> {
    if manifest.manifest_version != COMPATIBILITY_MANIFEST_VERSION
        || !valid_range(manifest.transport)
        || !valid_range(manifest.event_versions)
    {
        return Err(CompatibilityMismatch {
            axis: CompatibilityAxis::Manifest,
            required: format!(
                "manifest version {COMPATIBILITY_MANIFEST_VERSION} with valid ranges"
            ),
            offered: format!("manifest version {}", manifest.manifest_version),
        });
    }
    let expected_modules = nodex_core_contracts::module_contract_manifest();
    if manifest.modules.len() != expected_modules.len()
        || manifest
            .modules
            .windows(2)
            .any(|entries| entries[0].module >= entries[1].module)
        || manifest
            .modules
            .iter()
            .any(|entry| !valid_range(entry.versions))
        || !manifest
            .modules
            .iter()
            .map(|entry| entry.module)
            .eq(expected_modules.iter().map(|entry| entry.module))
    {
        return Err(CompatibilityMismatch {
            axis: CompatibilityAxis::Manifest,
            required: "all six Modules in canonical order with non-zero version ranges".to_owned(),
            offered: "invalid Module manifest".to_owned(),
        });
    }
    if !valid_store_support(&manifest.store) {
        return Err(CompatibilityMismatch {
            axis: CompatibilityAxis::Manifest,
            required: "canonical, unique Store format identities".to_owned(),
            offered: "invalid Store support".to_owned(),
        });
    }
    Ok(())
}

pub fn evaluate_compatibility(
    requirements: &CoreClientRequirements,
    manifest: &CoreCompatibilityManifest,
    actual_store_format: &StoreFormatIdentity,
) -> Result<(), Vec<CompatibilityMismatch>> {
    let mut mismatches = Vec::new();
    if let Err(mismatch) = validate_manifest(manifest) {
        mismatches.push(mismatch);
        return Err(mismatches);
    }
    if !valid_range(requirements.transport) || !requirements.transport.overlaps(manifest.transport)
    {
        mismatches.push(CompatibilityMismatch {
            axis: CompatibilityAxis::Transport,
            required: format!(
                "{}..={}",
                requirements.transport.min, requirements.transport.max
            ),
            offered: format!("{}..={}", manifest.transport.min, manifest.transport.max),
        });
    }
    if !manifest.event_versions.contains(requirements.event_version) {
        mismatches.push(CompatibilityMismatch {
            axis: CompatibilityAxis::Event,
            required: requirements.event_version.to_string(),
            offered: format!(
                "{}..={}",
                manifest.event_versions.min, manifest.event_versions.max
            ),
        });
    }
    if requirements.modules.len() != nodex_core_contracts::module_contract_manifest().len()
        || requirements
            .modules
            .windows(2)
            .any(|entries| entries[0].module >= entries[1].module)
    {
        mismatches.push(CompatibilityMismatch {
            axis: CompatibilityAxis::Module,
            required: "all six Modules in canonical order".to_owned(),
            offered: "invalid client requirements".to_owned(),
        });
    } else {
        for required in &requirements.modules {
            let offered = manifest
                .modules
                .iter()
                .find(|entry| entry.module == required.module);
            if !offered.is_some_and(|entry| entry.versions.contains(required.contract_version)) {
                mismatches.push(CompatibilityMismatch {
                    axis: CompatibilityAxis::Module,
                    required: format!("{:?}={}", required.module, required.contract_version),
                    offered: offered.map_or_else(
                        || "missing".to_owned(),
                        |entry| format!("{}..={}", entry.versions.min, entry.versions.max),
                    ),
                });
            }
        }
    }
    if !requirements
        .accepted_store_formats
        .contains(actual_store_format)
        || (!manifest.store.readable.contains(actual_store_format)
            && manifest.store.current != *actual_store_format)
    {
        mismatches.push(CompatibilityMismatch {
            axis: CompatibilityAxis::Store,
            required: format_store_formats(&requirements.accepted_store_formats),
            offered: format_store_formats(std::slice::from_ref(actual_store_format)),
        });
    }
    if mismatches.is_empty() {
        Ok(())
    } else {
        Err(mismatches)
    }
}

pub fn replacement_is_forward_safe(
    incumbent: &CoreCompatibilityManifest,
    candidate: &CoreCompatibilityManifest,
    actual_store_format: &StoreFormatIdentity,
) -> Result<(), Vec<CompatibilityMismatch>> {
    let mut mismatches = Vec::new();
    if let Err(mismatch) = validate_manifest(candidate) {
        return Err(vec![mismatch]);
    }
    let candidate_reads_store = candidate.store.current == *actual_store_format
        || candidate.store.readable.contains(actual_store_format)
        || candidate.store.migratable.contains(actual_store_format);
    if !candidate_reads_store {
        mismatches.push(CompatibilityMismatch {
            axis: CompatibilityAxis::Store,
            required: format_store_formats(std::slice::from_ref(actual_store_format)),
            offered: format_store_formats(&candidate.store.readable),
        });
    }
    for incumbent_module in &incumbent.modules {
        let candidate_module = candidate
            .modules
            .iter()
            .find(|entry| entry.module == incumbent_module.module);
        if !candidate_module
            .is_some_and(|entry| entry.versions.max >= incumbent_module.versions.max)
        {
            mismatches.push(CompatibilityMismatch {
                axis: CompatibilityAxis::Module,
                required: format!(
                    "{:?}>={}",
                    incumbent_module.module, incumbent_module.versions.max
                ),
                offered: candidate_module.map_or_else(
                    || "missing".to_owned(),
                    |entry| entry.versions.max.to_string(),
                ),
            });
        }
    }
    if candidate.transport.max < incumbent.transport.max
        || candidate.event_versions.max < incumbent.event_versions.max
    {
        mismatches.push(CompatibilityMismatch {
            axis: CompatibilityAxis::Transport,
            required: format!(
                "transport>={}, event>={}",
                incumbent.transport.max, incumbent.event_versions.max
            ),
            offered: format!(
                "transport={}, event={}",
                candidate.transport.max, candidate.event_versions.max
            ),
        });
    }
    if mismatches.is_empty() {
        Ok(())
    } else {
        Err(mismatches)
    }
}

fn valid_range(range: VersionRange) -> bool {
    range.min > 0 && range.min <= range.max
}

fn valid_store_support(store: &StoreFormatSupport) -> bool {
    valid_store_identity(&store.current)
        && sorted_unique_store_formats(&store.readable)
        && sorted_unique_store_formats(&store.migratable)
        && !store
            .readable
            .iter()
            .any(|format| store.migratable.contains(format))
}

fn sorted_unique_store_formats(formats: &[StoreFormatIdentity]) -> bool {
    formats.iter().all(valid_store_identity)
        && formats.windows(2).all(|formats| formats[0] < formats[1])
}

fn valid_store_identity(format: &StoreFormatIdentity) -> bool {
    !format.lineage.is_empty()
        && format.version > 0
        && format.schema_fingerprint.len() == 64
        && format
            .schema_fingerprint
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn format_store_formats(formats: &[StoreFormatIdentity]) -> String {
    formats
        .iter()
        .map(|format| {
            format!(
                "{}:v{}:{}",
                format.lineage,
                format.version,
                &format.schema_fingerprint[..8.min(format.schema_fingerprint.len())]
            )
        })
        .collect::<Vec<_>>()
        .join(",")
}

#[cfg(unix)]
pub mod client;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct VersionRange {
    pub min: u32,
    pub max: u32,
}

impl VersionRange {
    pub const fn exact(version: u32) -> Self {
        Self {
            min: version,
            max: version,
        }
    }

    pub const fn contains(self, version: u32) -> bool {
        self.min <= version && version <= self.max
    }

    pub const fn overlaps(self, other: Self) -> bool {
        self.min <= other.max && other.min <= self.max
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ModuleContractSupport {
    pub module: ModuleName,
    pub versions: VersionRange,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Ord, PartialOrd, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct StoreFormatIdentity {
    pub lineage: String,
    pub version: u32,
    pub schema_fingerprint: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct StoreFormatSupport {
    pub readable: Vec<StoreFormatIdentity>,
    pub migratable: Vec<StoreFormatIdentity>,
    pub current: StoreFormatIdentity,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct CoreCompatibilityManifest {
    pub manifest_version: u32,
    pub transport: VersionRange,
    pub event_versions: VersionRange,
    pub modules: Vec<ModuleContractSupport>,
    pub store: StoreFormatSupport,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct CoreClientRequirements {
    pub transport: VersionRange,
    pub event_version: u32,
    pub modules: Vec<ModuleContractVersion>,
    pub accepted_store_formats: Vec<StoreFormatIdentity>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum CompatibilityAxis {
    Manifest,
    Transport,
    Event,
    Module,
    Store,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct CompatibilityMismatch {
    pub axis: CompatibilityAxis,
    pub required: String,
    pub offered: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct CoreArtifactIdentity {
    pub sha256: String,
    pub build_id: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum CoreSelectionPolicy {
    Compatible,
    PreferCurrentArtifact,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum LauncherKind {
    ElectronHost,
    NativeCli,
    Test,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct RuntimeDescriptor {
    pub manifest: CoreCompatibilityManifest,
    pub manifest_digest: String,
    pub artifact: CoreArtifactIdentity,
    pub actual_store_format: StoreFormatIdentity,
    pub pid: u32,
    pub start_nonce: String,
    pub socket_path: String,
    pub profile_id: String,
    pub store_epoch: String,
    pub readiness_generation: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ClientKind {
    ElectronHost,
    NativeCli,
    Test,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ClientIdentity {
    pub kind: ClientKind,
    pub build_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct HandshakeRequest {
    pub requirements: CoreClientRequirements,
    pub client: ClientIdentity,
    pub connection_id: String,
    pub expected_generation: RuntimeGenerationIdentity,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct HandshakeResponse {
    pub selected_transport_version: u32,
    pub selected_event_version: u32,
    pub selected_module_versions: Vec<ModuleContractVersion>,
    pub manifest_digest: String,
    pub artifact: CoreArtifactIdentity,
    pub actual_store_format: StoreFormatIdentity,
    pub generation: RuntimeGenerationIdentity,
    pub library_id: String,
    pub connection_binding: String,
    pub store_epoch: String,
    pub schema_version: u32,
    pub commit_head: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct HealthResponse {
    pub status: CoreReadiness,
    pub pid: u32,
    pub start_nonce: String,
    pub metrics: CoreHealthMetrics,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct HealthDurationMetric {
    pub count: u64,
    pub total_micros: u64,
    pub last_micros: u64,
    pub max_micros: u64,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum CoreRequestClass {
    Interactive,
    Background,
    Maintenance,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct CoreRequestCancelRequest {
    pub request_id: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct CoreRequestCancelResponse {
    pub cancelled: bool,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct CoreHealthMetrics {
    #[serde(default)]
    pub active_requests: u64,
    #[serde(default)]
    pub queued_requests: u64,
    #[serde(default)]
    pub request_admission_wait: HealthDurationMetric,
    #[serde(default)]
    pub request_execution_duration: HealthDurationMetric,
    #[serde(default)]
    pub request_deadline_exceeded: u64,
    #[serde(default)]
    pub request_cancelled: u64,
    #[serde(default)]
    pub request_overloaded: u64,
    pub writer_queue_depth: u64,
    pub active_writer_commands: u64,
    pub active_read_commands: u64,
    pub command_latency: HealthDurationMetric,
    pub writer_queue_wait: HealthDurationMetric,
    pub writer_execution: HealthDurationMetric,
    pub transaction_duration: HealthDurationMetric,
    pub document_cache_entries: u64,
    pub document_cache_state_bytes: u64,
    pub document_cache_hits: u64,
    pub document_cache_misses: u64,
    pub document_cache_hit_rate_ppm: u32,
    pub document_reconstruction_duration: HealthDurationMetric,
    pub block_transfer_prepare_duration: HealthDurationMetric,
    pub block_transfer_reconstruct_duration: HealthDurationMetric,
    pub block_transfer_decode_duration: HealthDurationMetric,
    pub block_transfer_transform_duration: HealthDurationMetric,
    pub block_transfer_encode_duration: HealthDurationMetric,
    pub block_transfer_apply_duration: HealthDurationMetric,
    pub local_commit_publication_duration: HealthDurationMetric,
    pub commit_head: i64,
    pub event_replay_lag: u64,
    pub event_replay_lag_max: u64,
    pub wal_size_bytes: u64,
    pub backup_duration: HealthDurationMetric,
    #[serde(default)]
    pub canvas_sync_initial_snapshots: u64,
    #[serde(default)]
    pub canvas_sync_repair_snapshots: u64,
    #[serde(default)]
    pub canvas_sync_up_to_date: u64,
    #[serde(default)]
    pub canvas_sync_snapshot_bytes: u64,
    pub active_clients: u64,
    pub active_event_subscriptions: u64,
    pub active_document_subscriptions: u64,
    pub active_awareness_clients: u64,
    pub active_prepared_agent_operations: u64,
    #[serde(default)]
    pub dropped_log_records: u64,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum CoreReadiness {
    Starting,
    Ready,
    Maintenance,
    Draining,
    Failed,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct RuntimeGenerationIdentity {
    pub manifest_digest: String,
    pub artifact_sha256: String,
    pub pid: u32,
    pub start_nonce: String,
    pub profile_id: String,
    pub store_epoch: String,
    pub readiness_generation: u64,
}

impl From<&RuntimeDescriptor> for RuntimeGenerationIdentity {
    fn from(descriptor: &RuntimeDescriptor) -> Self {
        Self {
            manifest_digest: descriptor.manifest_digest.clone(),
            artifact_sha256: descriptor.artifact.sha256.clone(),
            pid: descriptor.pid,
            start_nonce: descriptor.start_nonce.clone(),
            profile_id: descriptor.profile_id.clone(),
            store_epoch: descriptor.store_epoch.clone(),
            readiness_generation: descriptor.readiness_generation,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct CoreReplacementRequest {
    pub candidate_manifest: CoreCompatibilityManifest,
    pub candidate_manifest_digest: String,
    pub candidate_artifact: CoreArtifactIdentity,
    pub policy: CoreSelectionPolicy,
    pub launcher: LauncherKind,
    pub expected: RuntimeGenerationIdentity,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(
    tag = "kind",
    content = "request",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum ShutdownRequest {
    #[default]
    Shutdown,
    Replacement(Box<CoreReplacementRequest>),
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ShutdownResponse {
    pub status: ShutdownStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime: Option<RuntimeGenerationIdentity>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after_ms: Option<u64>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ShutdownStatus {
    Draining,
    Busy,
    Incompatible,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum CoreSelectionDisposition {
    Started,
    Reused,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum CoreSelectionReason {
    StartedNoIncumbent,
    ReusedCompatible,
    ReplacedContract,
    ReplacedArtifact,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum CoreStartupEvent {
    CandidateChecked {
        artifact_hash_ms: u64,
    },
    MigrationStarted {
        from_version: i64,
        to_version: i64,
    },
    MigrationProgress {
        completed: u64,
        total: u64,
    },
    MigrationHeartbeat,
    StoreReady {
        created_fresh: bool,
        migrated_from_version: Option<i64>,
        store_open_ms: u64,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct CoreStartupEventFrame {
    pub startup_event_version: u32,
    pub event: CoreStartupEvent,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct CoreSelectionResult {
    pub selection_version: u32,
    pub disposition: CoreSelectionDisposition,
    pub reason: CoreSelectionReason,
    pub descriptor: RuntimeDescriptor,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, ToSchema)]
#[serde(tag = "status", content = "payload", rename_all = "snake_case")]
pub enum ResponseEnvelope<T> {
    Ok(T),
    Error(CoreError),
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct EventEnvelope {
    pub transport_version: u32,
    pub packet: AuthorizedDeliveryPacket,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct EventReplayRequired {
    pub requested_after: i64,
    pub oldest_available: i64,
    pub commit_head: i64,
    pub generation: String,
    pub resync_token: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct LocalMutationResolveRequest {
    pub module: ModuleName,
    pub operation_id: String,
    pub store_epoch: StoreEpoch,
    pub intent_hash: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, ToSchema)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum LocalMutationResolveResponse {
    Committed {
        module: ModuleName,
        operation_id: String,
        request_hash: String,
        result: Value,
        #[serde(skip_serializing_if = "Option::is_none")]
        delivery: Option<Box<AuthorizedDeliveryPacket>>,
    },
    NotCommitted {
        module: ModuleName,
        operation_id: String,
    },
    IntentConflict {
        module: ModuleName,
        operation_id: String,
        expected_hash: String,
        observed_hash: String,
    },
    EpochMismatch {
        requested_store_epoch: StoreEpoch,
        current_store_epoch: StoreEpoch,
    },
}

macro_rules! define_module_transport {
    (
        $read_request:ident,
        $read_response:ident,
        $apply_request:ident,
        $apply_response:ident,
        $read:ty,
        $read_value:ty,
        $intent:ty,
        $commit_value:ty,
        $receipt:ty
    ) => {
        #[derive(Clone, Debug, Deserialize, PartialEq, Serialize, ToSchema)]
        #[serde(transparent)]
        pub struct $read_request(pub ModuleReadRequest<$read>);

        #[derive(Clone, Debug, Deserialize, PartialEq, Serialize, ToSchema)]
        #[serde(transparent)]
        pub struct $read_response(pub ResponseEnvelope<ModuleReadSnapshot<$read_value>>);

        #[derive(Clone, Debug, Deserialize, PartialEq, Serialize, ToSchema)]
        #[serde(transparent)]
        pub struct $apply_request(pub ModuleApplyRequest<$intent>);

        #[derive(Clone, Debug, Deserialize, PartialEq, Serialize, ToSchema)]
        #[serde(transparent)]
        pub struct $apply_response(pub ResponseEnvelope<ApplyResponse<$commit_value, $receipt>>);
    };
}

define_module_transport!(
    LibraryReadRequest,
    LibraryReadResponse,
    LibraryApplyRequest,
    LibraryApplyResponse,
    LibraryRead,
    LibraryReadValue,
    LibraryIntent,
    LibraryCommitValue,
    LibraryReceipt
);
define_module_transport!(
    DatabaseReadRequest,
    DatabaseReadResponse,
    DatabaseApplyRequest,
    DatabaseApplyResponse,
    DatabaseRead,
    DatabaseReadValue,
    Vec<DatabaseIntent>,
    DatabaseCommitValue,
    DatabaseReceipt
);
define_module_transport!(
    OwnedDocumentReadRequest,
    OwnedDocumentReadResponse,
    OwnedDocumentApplyRequest,
    OwnedDocumentApplyResponse,
    OwnedDocumentRead,
    OwnedDocumentReadValue,
    OwnedDocumentIntent,
    OwnedDocumentCommitValue,
    OwnedDocumentReceipt
);
define_module_transport!(
    ProjectWorkspaceReadRequest,
    ProjectWorkspaceReadResponse,
    ProjectWorkspaceApplyRequest,
    ProjectWorkspaceApplyResponse,
    ProjectWorkspaceRead,
    ProjectWorkspaceReadValue,
    ProjectWorkspaceIntent,
    ProjectWorkspaceCommitValue,
    ProjectWorkspaceReceipt
);
define_module_transport!(
    AutomationReadRequest,
    AutomationReadResponse,
    AutomationApplyRequest,
    AutomationApplyResponse,
    AutomationRead,
    AutomationReadValue,
    AutomationIntent,
    AutomationCommitValue,
    AutomationReceipt
);
define_module_transport!(
    StoreAdministrationReadRequest,
    StoreAdministrationReadResponse,
    StoreAdministrationApplyRequest,
    StoreAdministrationApplyResponse,
    StoreAdministrationRead,
    StoreAdministrationReadValue,
    StoreAdministrationIntent,
    StoreAdministrationCommitValue,
    StoreAdministrationReceipt
);

#[allow(dead_code)]
mod api {
    use super::*;

    #[utoipa::path(
        get,
        path = "/core/v1/health",
        responses((status = 200, body = HealthResponse))
    )]
    pub(super) fn health() {}

    #[utoipa::path(
        post,
        path = "/core/v1/handshake",
        request_body = HandshakeRequest,
        responses((status = 200, body = HandshakeResponse))
    )]
    pub(super) fn handshake() {}

    #[utoipa::path(
        get,
        path = "/core/v1/events",
        params(("after" = Option<i64>, Query, description = "Last committed event sequence observed")),
        responses((status = 200, description = "Server-sent committed Module events", body = EventEnvelope, content_type = "text/event-stream"))
    )]
    pub(super) fn events() {}

    #[utoipa::path(
        post,
        path = "/core/v1/local-mutations/resolve",
        params(
            ("x-nodex-request-id" = Option<String>, Header),
            ("x-nodex-request-class" = Option<CoreRequestClass>, Header),
            ("x-nodex-request-deadline-ms" = Option<u64>, Header)
        ),
        request_body = LocalMutationResolveRequest,
        responses((status = 200, body = LocalMutationResolveResponse))
    )]
    pub(super) fn resolve_local_mutation() {}

    #[utoipa::path(
        post,
        path = "/core/v1/requests/cancel",
        request_body = CoreRequestCancelRequest,
        responses((status = 200, body = CoreRequestCancelResponse))
    )]
    pub(super) fn cancel_request() {}

    #[utoipa::path(
        post,
        path = "/core/v1/admin/shutdown",
        request_body = ShutdownRequest,
        responses((status = 200, body = ShutdownResponse))
    )]
    pub(super) fn shutdown() {}

    #[utoipa::path(
        post,
        path = "/core/v1/blobs/prepare",
        params(PrepareFileBlobQuery),
        request_body(content = Vec<u8>, content_type = "application/octet-stream"),
        responses((status = 200, body = PreparedBlobReceipt))
    )]
    pub(super) fn prepare_blob() {}

    #[utoipa::path(
        get,
        path = "/core/v1/threads/{thread_id}/blobs/{content_hash}",
        params(("thread_id" = String, Path), ("content_hash" = String, Path)),
        responses((status = 200, body = Vec<u8>, content_type = "application/octet-stream"))
    )]
    pub(super) fn read_thread_asset_blob() {}

    #[utoipa::path(
        get,
        path = "/core/v1/files/blobs/{file_id}",
        params(
            ("file_id" = String, Path),
            ("kind" = String, Query, description = "direct, page, document_revision, or canvas"),
            ("page_id" = Option<String>, Query),
            ("document_id" = Option<String>, Query),
            ("revision_id" = Option<String>, Query),
            ("canvas_id" = Option<String>, Query),
            ("scene_file_id" = Option<String>, Query),
            ("version" = Option<i64>, Query),
            ("x-nodex-request-id" = Option<String>, Header),
            ("x-nodex-request-class" = Option<CoreRequestClass>, Header),
            ("x-nodex-request-deadline-ms" = Option<u64>, Header)
        ),
        responses((status = 200, body = Vec<u8>, content_type = "application/octet-stream"))
    )]
    pub(super) fn read_file_blob() {}

    #[utoipa::path(
        post,
        path = "/core/v1/files/blobs/prepare",
        params(PrepareFileBlobQuery),
        request_body(content = Vec<u8>, content_type = "application/octet-stream"),
        responses((status = 200, body = PreparedBlobReceipt))
    )]
    pub(super) fn prepare_file_blob() {}

    macro_rules! module_paths {
        ($read_fn:ident, $apply_fn:ident, $path:literal, $read:ty, $read_response:ty, $apply:ty, $apply_response:ty) => {
            #[utoipa::path(
                                        post,
                                        path = concat!($path, "/read"),
                                        params(
                                            ("x-nodex-request-id" = Option<String>, Header),
                                            ("x-nodex-request-class" = Option<CoreRequestClass>, Header),
                                            ("x-nodex-request-deadline-ms" = Option<u64>, Header)
                                        ),
                                        request_body = $read,
                                        responses((status = 200, body = $read_response))
                                    )]
            pub(super) fn $read_fn() {}

            #[utoipa::path(
                                        post,
                                        path = concat!($path, "/apply"),
                                        params(
                                            ("x-nodex-request-id" = Option<String>, Header),
                                            ("x-nodex-request-class" = Option<CoreRequestClass>, Header),
                                            ("x-nodex-request-deadline-ms" = Option<u64>, Header)
                                        ),
                                        request_body = $apply,
                                        responses((status = 200, body = $apply_response))
                                    )]
            pub(super) fn $apply_fn() {}
        };
    }

    module_paths!(
        library_read,
        library_apply,
        "/core/v1/modules/library",
        LibraryReadRequest,
        LibraryReadResponse,
        LibraryApplyRequest,
        LibraryApplyResponse
    );
    module_paths!(
        database_read,
        database_apply,
        "/core/v1/modules/database",
        DatabaseReadRequest,
        DatabaseReadResponse,
        DatabaseApplyRequest,
        DatabaseApplyResponse
    );
    module_paths!(
        document_read,
        document_apply,
        "/core/v1/modules/document",
        OwnedDocumentReadRequest,
        OwnedDocumentReadResponse,
        OwnedDocumentApplyRequest,
        OwnedDocumentApplyResponse
    );
    module_paths!(
        workspace_read,
        workspace_apply,
        "/core/v1/modules/workspace",
        ProjectWorkspaceReadRequest,
        ProjectWorkspaceReadResponse,
        ProjectWorkspaceApplyRequest,
        ProjectWorkspaceApplyResponse
    );
    module_paths!(
        automation_read,
        automation_apply,
        "/core/v1/modules/automation",
        AutomationReadRequest,
        AutomationReadResponse,
        AutomationApplyRequest,
        AutomationApplyResponse
    );
    module_paths!(
        administration_read,
        administration_apply,
        "/core/v1/modules/administration",
        StoreAdministrationReadRequest,
        StoreAdministrationReadResponse,
        StoreAdministrationApplyRequest,
        StoreAdministrationApplyResponse
    );
}

#[derive(OpenApi)]
#[openapi(
    info(title = "Nodex Core private protocol", version = "1.0.0"),
    paths(
        api::health,
        api::handshake,
        api::events,
        api::resolve_local_mutation,
        api::cancel_request,
        api::shutdown,
        api::prepare_blob,
        api::read_thread_asset_blob,
        api::read_file_blob,
        api::prepare_file_blob,
        api::library_read,
        api::library_apply,
        api::database_read,
        api::database_apply,
        api::document_read,
        api::document_apply,
        api::workspace_read,
        api::workspace_apply,
        api::automation_read,
        api::automation_apply,
        api::administration_read,
        api::administration_apply,
    ),
    components(schemas(
        RuntimeDescriptor,
        CoreCompatibilityManifest,
        CoreClientRequirements,
        CoreTransportBudgets,
        CoreArtifactIdentity,
        CoreStartupEvent,
        CoreStartupEventFrame,
        CoreSelectionResult,
        CoreReplacementRequest,
        StoreFormatIdentity,
        StoreFormatSupport,
        ModuleContractSupport,
        VersionRange,
        CompatibilityMismatch,
        HandshakeRequest,
        HandshakeResponse,
        HealthResponse,
        CoreHealthMetrics,
        HealthDurationMetric,
        CoreRequestClass,
        CoreRequestCancelRequest,
        CoreRequestCancelResponse,
        PrepareFileBlobQuery,
        ReadFileBlobQuery,
        PreparedBlobReceipt,
        ShutdownRequest,
        ShutdownResponse,
        RuntimeGenerationIdentity,
        EventEnvelope,
        EventReplayRequired,
        StreamCheckpoint,
        OwnedDocumentEvent,
        LocalMutationResolveRequest,
        LocalMutationResolveResponse,
        LibraryReadRequest,
        LibraryReadResponse,
        LibraryApplyRequest,
        LibraryApplyResponse,
        DatabaseReadRequest,
        DatabaseReadResponse,
        DatabaseApplyRequest,
        DatabaseApplyResponse,
        OwnedDocumentReadRequest,
        OwnedDocumentReadResponse,
        OwnedDocumentApplyRequest,
        OwnedDocumentApplyResponse,
        ProjectWorkspaceReadRequest,
        ProjectWorkspaceReadResponse,
        ProjectWorkspaceApplyRequest,
        ProjectWorkspaceApplyResponse,
        AutomationReadRequest,
        AutomationReadResponse,
        AutomationApplyRequest,
        AutomationApplyResponse,
        StoreAdministrationReadRequest,
        StoreAdministrationReadResponse,
        StoreAdministrationApplyRequest,
        StoreAdministrationApplyResponse,
        DeliveryAddress,
        DeliveryAuthorizationScope,
        AuthorizedRecipientLease,
        AddressResetReason,
        AddressReset,
        AuthorizedReadStamp,
    ))
)]
pub struct CoreProtocolApi;

pub fn openapi() -> utoipa::openapi::OpenApi {
    CoreProtocolApi::openapi()
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::*;

    #[test]
    fn openapi_surface_is_limited_to_infrastructure_and_module_pairs() {
        let actual = openapi()
            .paths
            .paths
            .keys()
            .cloned()
            .collect::<BTreeSet<_>>();
        let expected = [
            "/core/v1/admin/shutdown",
            "/core/v1/events",
            "/core/v1/handshake",
            "/core/v1/health",
            "/core/v1/local-mutations/resolve",
            "/core/v1/requests/cancel",
            "/core/v1/modules/administration/apply",
            "/core/v1/modules/administration/read",
            "/core/v1/modules/automation/apply",
            "/core/v1/modules/automation/read",
            "/core/v1/modules/database/apply",
            "/core/v1/modules/database/read",
            "/core/v1/modules/document/apply",
            "/core/v1/modules/document/read",
            "/core/v1/modules/library/apply",
            "/core/v1/modules/library/read",
            "/core/v1/modules/workspace/apply",
            "/core/v1/modules/workspace/read",
            "/core/v1/files/blobs/prepare",
            "/core/v1/files/blobs/{file_id}",
            "/core/v1/blobs/prepare",
            "/core/v1/threads/{thread_id}/blobs/{content_hash}",
        ]
        .into_iter()
        .map(str::to_owned)
        .collect();

        assert_eq!(actual, expected);
    }

    #[test]
    fn openapi_is_version_3_1() {
        let json = serde_json::to_value(openapi()).expect("OpenAPI serializes");
        assert_eq!(json["openapi"], "3.1.0");
    }

    #[test]
    fn module_execution_headers_are_optional_in_openapi() {
        let json = serde_json::to_value(openapi()).expect("OpenAPI serializes");
        for path in json["paths"]
            .as_object()
            .expect("OpenAPI paths")
            .keys()
            .filter(|path| path.starts_with("/core/v1/modules/"))
        {
            let parameters = json["paths"][path]["post"]["parameters"]
                .as_array()
                .expect("module execution headers");
            assert_eq!(parameters.len(), 3);
            assert!(parameters.iter().all(|parameter| {
                parameter["in"] == "header" && parameter["required"] == false
            }));
        }
    }

    #[test]
    fn current_client_and_core_are_compatible_on_every_axis() {
        assert_eq!(
            evaluate_compatibility(
                &core_client_requirements(),
                &core_compatibility_manifest(),
                &store_format(CURRENT_STORE_VERSION).expect("current Store"),
            ),
            Ok(()),
        );
    }

    #[test]
    fn module_contract_drift_is_not_hidden_by_transport_overlap() {
        let mut manifest = core_compatibility_manifest();
        let workspace = manifest
            .modules
            .iter_mut()
            .find(|entry| entry.module == ModuleName::ProjectWorkspace)
            .expect("Workspace contract");
        workspace.versions = VersionRange::exact(1);

        let mismatches = evaluate_compatibility(
            &core_client_requirements(),
            &manifest,
            &store_format(CURRENT_STORE_VERSION).expect("current Store"),
        )
        .expect_err("Workspace 1 cannot satisfy the current Workspace contract");
        assert_eq!(mismatches.len(), 1);
        assert_eq!(mismatches[0].axis, CompatibilityAxis::Module);
        assert!(mismatches[0].required.contains(&format!(
            "ProjectWorkspace={}",
            nodex_core_contracts::PROJECT_WORKSPACE_CONTRACT_VERSION,
        )));
    }

    #[test]
    fn store_identity_requires_the_exact_published_schema_fingerprint() {
        let mut impostor = store_format(CURRENT_STORE_VERSION).expect("current Store");
        impostor.schema_fingerprint = "0".repeat(64);

        let mismatches = evaluate_compatibility(
            &core_client_requirements(),
            &core_compatibility_manifest(),
            &impostor,
        )
        .expect_err("version alone cannot identify a Store format");
        assert!(
            mismatches
                .iter()
                .any(|mismatch| mismatch.axis == CompatibilityAxis::Store)
        );
    }

    #[test]
    fn replacement_refuses_contract_downgrade_and_unknown_store_format() {
        let incumbent = core_compatibility_manifest();
        let mut downgraded = incumbent.clone();
        downgraded
            .modules
            .iter_mut()
            .find(|entry| entry.module == ModuleName::ProjectWorkspace)
            .expect("Workspace contract")
            .versions = VersionRange::exact(1);
        let unknown_store = StoreFormatIdentity {
            lineage: STORE_LINEAGE.to_owned(),
            version: 89,
            schema_fingerprint: "f".repeat(64),
        };

        let mismatches = replacement_is_forward_safe(&incumbent, &downgraded, &unknown_store)
            .expect_err("replacement cannot downgrade or open an unknown Store");
        assert!(
            mismatches
                .iter()
                .any(|mismatch| mismatch.axis == CompatibilityAxis::Module)
        );
        assert!(
            mismatches
                .iter()
                .any(|mismatch| mismatch.axis == CompatibilityAxis::Store)
        );
    }

    #[test]
    fn manifest_digest_is_canonical_and_reordered_modules_are_rejected() {
        let manifest = core_compatibility_manifest();
        assert_eq!(
            canonical_manifest_digest(&manifest),
            canonical_manifest_digest(&manifest.clone()),
        );
        let mut reordered = manifest;
        reordered.modules.swap(0, 1);
        assert_eq!(
            canonical_manifest_digest(&reordered)
                .expect_err("non-canonical Module order must fail")
                .axis,
            CompatibilityAxis::Manifest,
        );
    }

    #[test]
    fn transport_four_shutdown_does_not_accept_legacy_handoff_or_extra_fields() {
        assert!(
            serde_json::from_value::<ShutdownRequest>(serde_json::json!({
                "version_handoff": null
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<ShutdownRequest>(serde_json::json!({
                "kind": "shutdown",
                "version_handoff": null
            }))
            .is_err()
        );
        assert_eq!(
            serde_json::from_value::<ShutdownRequest>(serde_json::json!({
                "kind": "shutdown"
            }))
            .expect("strict shutdown"),
            ShutdownRequest::Shutdown,
        );
    }
}
