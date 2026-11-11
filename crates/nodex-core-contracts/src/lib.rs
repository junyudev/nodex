#![forbid(unsafe_code)]

use serde::{Deserialize, Deserializer, Serialize};
use utoipa::ToSchema;

/// Preserve the distinction between an omitted field and an explicitly null
/// field when the target type is `Option<Option<T>>`.
pub(crate) fn deserialize_present<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

pub const CORE_EVENT_VERSION: u32 = 12;
pub const OPERATION_RECEIPT_WINDOW_MS: i64 = 7 * 24 * 60 * 60 * 1_000;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(transparent)]
pub struct ProfileId(pub String);

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(transparent)]
pub struct LibraryId(pub String);

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(transparent)]
pub struct ProjectId(pub String);

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(transparent)]
pub struct StoreEpoch(pub String);

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AdapterKind {
    ElectronHost,
    LoopbackHttp,
    RemoteMember,
    NativeCli,
    Agent,
    Test,
}

/// Trusted connection identity assembled by the Adapter. This type is not part
/// of the caller-authored protocol schema.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct BoundModuleContext {
    pub actor: Actor,
    /// A standing grant is separate from the Service that performs its work.
    pub authorizing_member_id: Option<String>,
    pub profile_id: ProfileId,
    pub library_id: LibraryId,
    pub project_id: Option<ProjectId>,
    pub connection_id: String,
    pub adapter: AdapterKind,
    /// Core-verified remote identity; never caller-authored command data.
    #[serde(default)]
    pub principal: Option<RemotePrincipal>,
    /// Main-authenticated editor lifetime; never accepted from command JSON.
    #[serde(default)]
    pub editor_history_owner: Option<BoundEditorHistoryOwner>,
    /// A Core-verified Agent execution acting through this request; never accepted from
    /// command JSON. Absent for people and for callers without a verified credential.
    #[serde(default)]
    pub agent_attribution: Option<BoundAgentAttribution>,
}

/// Space membership proven by a renewable, device-bound session.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct RemotePrincipal {
    pub space_id: String,
    pub member_id: String,
    pub device_id: String,
    pub session_id: String,
    pub role: library::MemberRole,
}

/// The product Session and backend family whose Agent issued a request, proven by a
/// credential Core itself issued to the desktop Host for that Session.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct BoundAgentAttribution {
    pub session_id: String,
    pub run_id: Option<String>,
    pub backend: crate::agent::AgentBackendKind,
}

/// An editor lifetime and the authenticated Host process run it belongs to.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct BoundEditorHistoryOwner {
    pub id: String,
    pub peer_pid: u32,
    /// The Host's OS start time; with the PID it names one process run, so a
    /// recycled PID never inherits or prolongs this lifetime.
    pub peer_started: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum CoreErrorCode {
    InvalidInput,
    Unauthorized,
    AgentTurnEnded,
    AgentSessionUnavailable,
    AgentGenerationChanged,
    AgentBindingMalformed,

    NotFound,
    Ambiguous,
    Conflict,
    StaleStoreEpoch,
    RevisionConflict,
    GenerationConflict,
    HeadConflict,
    PatchNotFound,
    PatchAmbiguous,
    PatchOverlap,
    IdempotencyKeyReused,
    IdempotencyWindowExpired,
    LegacyIdempotencyUnavailable,
    ProtectedOwnerDeletion,
    DocumentUpdateMissingDependencies,
    InvalidDocumentSchema,
    MaterializationStale,
    MaintenanceInProgress,
    SchemaUnsupported,
    StoreCorrupt,
    ProtocolIncompatible,
    EventReplayUnavailable,
    DeadlineExceeded,
    Cancelled,
    Overloaded,
    ResourceExhausted,
    CoreUnavailable,
}

/// Exact coordinates for retrieving a rejected Document update.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct DocumentRecoveryArtifactReference {
    pub artifact_id: String,
    pub document_id: String,
    pub store_epoch: StoreEpoch,
    pub generation: i64,
    pub update_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CoreErrorRecovery {
    /// Only device-credential renewal may return authenticated withdrawal evidence.
    RemoteAccessWithdrawn,
    RenewRemoteSession,
    UseNewIdempotencyKey,
    ReconcileExpiredOperation,
    RetryAfter {
        budget: team::RemoteBudget,
        milliseconds: u64,
    },
    RecoveryPackage {
        failure: Box<document::RecoveryPackageFailure>,
    },
    None,
    CurrentStoreEpoch {
        store_epoch: StoreEpoch,
    },
    CurrentRevision {
        revision: i64,
    },
    CurrentDocumentHead {
        generation: i64,
        head_seq: i64,
    },
    ReconnectDocumentSubscription,
    InboxRemindAtPassed,
    DatabaseViewOrderPreparation {
        view_id: String,
    },
    // Rare recovery coordinates must not inflate every Core and Store Result.
    DocumentRecoveryArtifact(Box<DocumentRecoveryArtifactReference>),
    SupportedSchema {
        minimum: u32,
        maximum: u32,
        actual: u32,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct CoreError {
    pub code: CoreErrorCode,
    pub message: String,
    pub retryable: bool,
    pub recovery: CoreErrorRecovery,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ModuleReadRequest<T> {
    pub contract_version: u32,
    pub read: T,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ModuleApplyRequest<T> {
    pub contract_version: u32,
    pub operation_id: String,
    pub store_epoch: StoreEpoch,
    pub intent: T,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ModuleReadSnapshot<T> {
    pub contract_version: u32,
    pub store_epoch: StoreEpoch,
    pub commit_head: i64,
    pub value: T,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ModuleMutationReceipt {
    pub operation_id: String,
    pub duplicate: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ModuleName {
    Library,
    Database,
    OwnedDocument,
    ProjectWorkspace,
    Automation,
    StoreAdministration,
    Query,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ModuleContractVersion {
    pub module: ModuleName,
    pub contract_version: u32,
}

pub trait VersionedModuleContract {
    type Read: Serialize;
    type Snapshot: Serialize;
    type Intent: Serialize;
    type Receipt: Serialize;
    type Event: Serialize;

    const VERSION: u32;
    const MODULE: ModuleName;
}

/// Maximum bytes in one prepared immutable Blob, including private attachments.
pub const MAX_MANAGED_BLOB_BYTES: u64 = 256 * 1024 * 1024;

pub mod actor;
pub mod administration;
pub use actor::{Actor, ServiceKind};
pub mod agent;
pub mod automation;
pub mod automation_assessment;
pub mod collection;
pub mod database;
pub mod database_configuration;
pub mod document;
pub mod events;
pub mod inbox;
pub mod library;
pub mod query;
pub mod sql;
pub mod workspace;

#[cfg(test)]
mod collection_audit;

pub use administration::STORE_ADMINISTRATION_CONTRACT_VERSION;
pub use automation::AUTOMATION_CONTRACT_VERSION;
pub use database::DATABASE_CONTRACT_VERSION;
pub use document::OWNED_DOCUMENT_CONTRACT_VERSION;
pub use events::{
    AddressReset, AddressResetReason, ApplyResponse, AuthorizedDeliveryAtom,
    AuthorizedDeliveryPacket, AuthorizedDocumentEffect, AuthorizedOwnedDocumentEvent,
    AuthorizedRecipientLease, CommitIdentity, CommitManifest, CommitManifestHeader,
    CommittedCoreModuleEvent, CoreModuleEventPayload, DeliveryAddress, DeliveryAtomDescriptor,
    DeliveryAtomKind, DeliveryAtomPayload, DeliveryCoverage, DocumentEffectRef,
    DocumentEffectResourceKind, LocalCommitReceiptRef, LocalProjectionPatch, LocalProjectionScope,
    PageDocumentHeadImpact, PhysicalEvidenceDigest, ProjectionEffect, ProjectionImpact,
    ProjectionScopeKey, ProjectionSnapshotAuthority, ResourceKey, RoutingClaim, StoreObservation,
    StreamCheckpoint,
};
pub use library::LIBRARY_CONTRACT_VERSION;
pub use query::QUERY_CONTRACT_VERSION;
pub use workspace::PROJECT_WORKSPACE_CONTRACT_VERSION;

pub const fn module_contract_manifest() -> [ModuleContractVersion; 7] {
    [
        ModuleContractVersion {
            module: ModuleName::Library,
            contract_version: LIBRARY_CONTRACT_VERSION,
        },
        ModuleContractVersion {
            module: ModuleName::Database,
            contract_version: DATABASE_CONTRACT_VERSION,
        },
        ModuleContractVersion {
            module: ModuleName::OwnedDocument,
            contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
        },
        ModuleContractVersion {
            module: ModuleName::ProjectWorkspace,
            contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
        },
        ModuleContractVersion {
            module: ModuleName::Automation,
            contract_version: AUTOMATION_CONTRACT_VERSION,
        },
        ModuleContractVersion {
            module: ModuleName::StoreAdministration,
            contract_version: STORE_ADMINISTRATION_CONTRACT_VERSION,
        },
        ModuleContractVersion {
            module: ModuleName::Query,
            contract_version: QUERY_CONTRACT_VERSION,
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn document_recovery_artifact_preserves_flat_wire_coordinates() {
        let wire = serde_json::json!({
            "kind": "document_recovery_artifact",
            "artifact_id": "artifact-1",
            "document_id": "document-1",
            "store_epoch": "epoch-1",
            "generation": 4,
            "update_id": "update-1"
        });
        let recovery: CoreErrorRecovery = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(recovery).unwrap(), wire);
    }

    #[test]
    fn public_module_names_match_the_adapter_budget() {
        let modules = [
            ModuleName::Library,
            ModuleName::Database,
            ModuleName::OwnedDocument,
            ModuleName::ProjectWorkspace,
            ModuleName::Automation,
            ModuleName::StoreAdministration,
            ModuleName::Query,
        ];

        let json = serde_json::to_value(modules).expect("module names serialize");
        assert_eq!(
            json,
            serde_json::json!([
                "library",
                "database",
                "owned_document",
                "project_workspace",
                "automation",
                "store_administration",
                "query"
            ])
        );
    }

    #[test]
    fn caller_requests_cannot_supply_bound_identity() {
        let request = ModuleReadRequest {
            contract_version: LIBRARY_CONTRACT_VERSION,
            read: library::LibraryRead::Metadata,
        };
        let json = serde_json::to_value(request).expect("request serializes");

        assert_eq!(json["contract_version"], LIBRARY_CONTRACT_VERSION);
        assert!(json.get("profile_id").is_none());
        assert!(json.get("library_id").is_none());
        assert!(json.get("adapter").is_none());
    }

    #[test]
    fn module_contract_manifest_is_complete_and_canonical() {
        assert_eq!(
            module_contract_manifest(),
            [
                ModuleContractVersion {
                    module: ModuleName::Library,
                    contract_version: LIBRARY_CONTRACT_VERSION,
                },
                ModuleContractVersion {
                    module: ModuleName::Database,
                    contract_version: DATABASE_CONTRACT_VERSION,
                },
                ModuleContractVersion {
                    module: ModuleName::OwnedDocument,
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                },
                ModuleContractVersion {
                    module: ModuleName::ProjectWorkspace,
                    contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                },
                ModuleContractVersion {
                    module: ModuleName::Automation,
                    contract_version: AUTOMATION_CONTRACT_VERSION,
                },
                ModuleContractVersion {
                    module: ModuleName::StoreAdministration,
                    contract_version: STORE_ADMINISTRATION_CONTRACT_VERSION,
                },
                ModuleContractVersion {
                    module: ModuleName::Query,
                    contract_version: QUERY_CONTRACT_VERSION
                },
            ]
        );
    }
}

pub mod remote_admission;
pub mod sources;
pub mod team;
