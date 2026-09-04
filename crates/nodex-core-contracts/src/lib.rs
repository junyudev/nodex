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

pub const CORE_EVENT_VERSION: u32 = 9;

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
    NativeCli,
    Agent,
    Test,
}

/// Trusted connection identity assembled by the Adapter. This type is not part
/// of the caller-authored protocol schema.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct BoundModuleContext {
    pub profile_id: ProfileId,
    pub library_id: LibraryId,
    pub project_id: Option<ProjectId>,
    pub connection_id: String,
    pub adapter: AdapterKind,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum CoreErrorCode {
    InvalidInput,
    Unauthorized,
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

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CoreErrorRecovery {
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
    DocumentRecoveryArtifact {
        artifact_id: String,
        document_id: String,
        store_epoch: StoreEpoch,
        generation: i64,
        update_id: String,
    },
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
    pub authorization: Option<events::AuthorizedReadStamp>,
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

pub mod administration;
pub mod agent;
pub mod automation;
pub mod collection;
pub mod database;
pub mod document;
pub mod events;
pub mod library;
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
    AuthorizedReadStamp, AuthorizedRecipientLease, CommitIdentity, CommitManifest,
    CommitManifestHeader, CommittedCoreModuleEvent, ConservativeResetReason,
    CoreModuleEventPayload, DeliveryAddress, DeliveryAtomDescriptor, DeliveryAtomKind,
    DeliveryAtomPayload, DeliveryAuthorizationScope, DeliveryCoverage, DocumentEffectRef,
    DocumentEffectResourceKind, LocalCommitReceiptRef, LocalProjectionPatch, LocalProjectionScope,
    PageDocumentHeadImpact, PhysicalEvidenceDigest, ProjectionEffect, ProjectionImpact,
    ProjectionScopeKey, ProjectionSnapshotAuthority, ResourceKey, ResourceRevocation,
    ResourceRevocationReason, RevokedResourceKind, RoutingClaim, StoreObservation,
    StreamCheckpoint, VisibilityDelta, VisibilityDeltaKind,
};
pub use library::LIBRARY_CONTRACT_VERSION;
pub use workspace::PROJECT_WORKSPACE_CONTRACT_VERSION;

pub const fn module_contract_manifest() -> [ModuleContractVersion; 6] {
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
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_module_names_match_the_adapter_budget() {
        let modules = [
            ModuleName::Library,
            ModuleName::Database,
            ModuleName::OwnedDocument,
            ModuleName::ProjectWorkspace,
            ModuleName::Automation,
            ModuleName::StoreAdministration,
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
                "store_administration"
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
            ]
        );
    }
}
