use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::{
    ModuleName, StoreEpoch,
    administration::StoreAdministrationEvent,
    automation::AutomationEvent,
    database::{DatabaseEvent, DatabaseRowSummary},
    document::{DocumentInvalidationReason, OwnedDocumentEvent, PageFileReferenceChange},
    library::LibraryEvent,
    workspace::ProjectWorkspaceEvent,
};

/// Stable identity shared by every authorized representation of one semantic
/// mutation. `manifest_hash` authenticates the immutable manifest; delivery
/// coverage and recipient identity are deliberately outside this coordinate.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct CommitIdentity {
    pub store_epoch: StoreEpoch,
    pub commit_seq: i64,
    pub manifest_hash: String,
}

/// Ordered digest of the private physical journal rows that prove a semantic
/// mutation. Physical payloads and their row identities never cross the Core
/// protocol boundary.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct PhysicalEvidenceDigest {
    pub effect_count: u32,
    pub first_change_log_seq: Option<i64>,
    pub last_change_log_seq: Option<i64>,
    pub ordered_digest: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "module", content = "event", rename_all = "snake_case")]
pub enum CoreModuleEventPayload {
    Library(LibraryEvent),
    Database(DatabaseEvent),
    OwnedDocument(OwnedDocumentEvent),
    ProjectWorkspace(ProjectWorkspaceEvent),
    Automation(AutomationEvent),
    StoreAdministration(StoreAdministrationEvent),
}

impl CoreModuleEventPayload {
    pub fn module_name(&self) -> ModuleName {
        match self {
            Self::Library(_) => ModuleName::Library,
            Self::Database(_) => ModuleName::Database,
            Self::OwnedDocument(_) => ModuleName::OwnedDocument,
            Self::ProjectWorkspace(_) => ModuleName::ProjectWorkspace,
            Self::Automation(_) => ModuleName::Automation,
            Self::StoreAdministration(_) => ModuleName::StoreAdministration,
        }
    }
}

/// Closed notification payloads that may cross the authorized delivery
/// boundary. Every value is the payload of one resource-atomic DeliveryAtom;
/// aggregate physical events are split before the manifest is sealed.
/// Document updates are intentionally absent: their bytes are available only
/// through `DocumentEffectRef` and its optional inline body.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "module", rename_all = "snake_case")]
pub enum DeliveryAtomPayload {
    Library {
        library_id: String,
        event: LibraryEvent,
    },
    Database {
        library_id: String,
        event: DatabaseEvent,
    },
    OwnedDocument {
        library_id: String,
        canvas_id: Option<String>,
        event: AuthorizedOwnedDocumentEvent,
    },
    ProjectWorkspace {
        library_id: String,
        event: ProjectWorkspaceEvent,
    },
    Automation {
        library_id: String,
        project_id: String,
        event: AutomationEvent,
    },
    StoreAdministration {
        library_id: String,
        event: StoreAdministrationEvent,
    },
}

impl DeliveryAtomPayload {
    pub fn module_name(&self) -> ModuleName {
        match self {
            Self::Library { .. } => ModuleName::Library,
            Self::Database { .. } => ModuleName::Database,
            Self::OwnedDocument { .. } => ModuleName::OwnedDocument,
            Self::ProjectWorkspace { .. } => ModuleName::ProjectWorkspace,
            Self::Automation { .. } => ModuleName::Automation,
            Self::StoreAdministration { .. } => ModuleName::StoreAdministration,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AuthorizedOwnedDocumentEvent {
    RecoveryChanged {
        document_id: String,
        detached: bool,
    },
    PageFileReferencesChanged {
        document_id: String,
        generation: i64,
        head_seq: i64,
        change: PageFileReferenceChange,
    },
    DocumentResyncRequired {
        document_id: String,
        generation: i64,
        head_seq: i64,
        update_id: String,
        update_hash: String,
    },
    CanvasUpdated {
        document_id: String,
        generation: i64,
        base_head_seq: i64,
        head_seq: i64,
        scene_hash: String,
        mutation: serde_json::Value,
    },
    CanvasGenerationChanged {
        document_id: String,
        previous_generation: i64,
        previous_head_seq: i64,
        generation: i64,
        head_seq: i64,
        scene_hash: String,
    },
    DocumentInvalidated {
        document_id: String,
        reason: DocumentInvalidationReason,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct PageDocumentHeadImpact {
    pub page_id: String,
    pub document_id: String,
    pub generation: i64,
    pub head_seq: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ProjectionImpact {
    None,
    All,
    Resources {
        page_ids: Vec<String>,
        database_ids: Vec<String>,
        data_source_ids: Vec<String>,
        view_ids: Vec<String>,
        document_heads: Vec<PageDocumentHeadImpact>,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct CommittedCoreModuleEvent {
    pub event_version: u32,
    pub sequence: i64,
    pub store_epoch: StoreEpoch,
    pub operation_id: Option<String>,
    pub committed_at: String,
    pub projection_impact: ProjectionImpact,
    pub payload: CoreModuleEventPayload,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum DocumentEffectResourceKind {
    DocumentUpdate,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct DocumentEffectRef {
    pub effect_order: i64,
    pub page_id: Option<String>,
    pub document_id: String,
    pub generation: i64,
    pub base_head_seq: i64,
    pub result_head_seq: i64,
    pub update_id: String,
    pub update_hash: String,
    pub update_byte_length: i64,
    pub resource_kind: DocumentEffectResourceKind,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LocalProjectionScope {
    Library {
        library_id: String,
    },
    Project {
        project_id: String,
    },
    DatabaseView {
        project_id: String,
        database_id: String,
        data_source_id: String,
        view_id: String,
    },
    PageDetailDatabase {
        project_id: String,
        database_id: String,
    },
    PageDetailDataSource {
        project_id: String,
        database_id: String,
        data_source_id: String,
    },
    Page {
        project_id: String,
        page_id: String,
    },
}

/// Core-computed read-model result. A patch never grants write authority; it
/// only makes a committed relational result visible before canonical repair.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LocalProjectionPatch {
    DatabaseRowUpsert {
        project_id: String,
        database_id: String,
        data_source_id: String,
        view_id: String,
        row: Box<DatabaseRowSummary>,
        total_rows: i64,
        group_total: Option<i64>,
    },
    DatabaseRowRemove {
        project_id: String,
        database_id: String,
        data_source_id: String,
        view_id: String,
        page_id: String,
        total_rows: i64,
        group_key: Option<String>,
        subgroup_key: Option<String>,
        group_total: Option<i64>,
    },
    PageChanged {
        project_id: String,
        page_id: String,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LocalCommitReceiptRef {
    pub module: ModuleName,
    pub operation_id: String,
    pub result_hash: String,
}

/// Exact authorization vocabulary used by semantic delivery. Scope resources
/// are explicit requirements rather than ambient packet metadata.
#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ResourceKey {
    Library { library_id: String },
    Project { project_id: String },
    Page { page_id: String },
    Document { document_id: String },
    Database { database_id: String },
    DataSource { data_source_id: String },
    View { view_id: String },
    Canvas { canvas_id: String },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum DeliveryAtomKind {
    LibraryNavigationChanged,
    DatabaseChanged,
    OwnedDocumentChanged,
    ProjectWorkspaceChanged,
    AutomationChanged,
    StoreAdministrationChanged,
}

/// Immutable resource-atomic semantic index entry. `atom_order` is unique
/// within one commit; `atom_id` authenticates its kind, exact requirements,
/// payload digest, and commit coordinate.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct DeliveryAtomDescriptor {
    pub atom_id: String,
    pub atom_order: i64,
    pub kind: DeliveryAtomKind,
    pub required_resources: Vec<ResourceKey>,
    pub payload_hash: String,
}

/// Immutable authority scope affected by a mutation. A routing claim is used
/// to find candidate subscriptions; it is never a recipient list or a read
/// capability.
#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RoutingClaim {
    Library { library_id: String },
    Project { project_id: String },
    Document { document_id: String },
    Page { page_id: String },
    Database { database_id: String },
    DataSource { data_source_id: String },
    View { view_id: String },
}

/// One projection scope transition. Revisions are per scope and advance in the
/// same transaction as the mutation. `covered_commit_seq` is a floor, not a
/// replacement for the scope revision.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ProjectionScopeKey {
    pub schema_version: u32,
    pub canonical_key: String,
    pub scope: LocalProjectionScope,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ProjectionEffect {
    pub scope: ProjectionScopeKey,
    pub base_revision: i64,
    pub result_revision: i64,
    pub covered_commit_seq: i64,
    pub patch: Option<LocalProjectionPatch>,
    pub requires_read_at_least: bool,
    pub effect_hash: String,
}

/// Exact causal coordinate returned with a canonical projection snapshot.
/// `covered_commit_seq` records the durable read floor reached by the
/// snapshot; ordering within the projection is owned by `revision`.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ProjectionSnapshotAuthority {
    pub scope: ProjectionScopeKey,
    pub revision: i64,
    pub covered_commit_seq: i64,
    pub effect_hash: Option<String>,
}

/// Immutable semantic artifact sealed by Core. Dynamic recipients and inline
/// resources are intentionally absent, so authorization changes cannot rewrite
/// history or alter `manifest_hash`.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct CommitManifest {
    pub event_version: u32,
    pub identity: CommitIdentity,
    pub operation_id: String,
    pub intent_hash: String,
    pub committed_at: String,
    pub delivery_atoms: Vec<DeliveryAtomDescriptor>,
    pub document_effects: Vec<DocumentEffectRef>,
    pub projection_effects: Vec<ProjectionEffect>,
    #[serde(default)]
    pub revocations: Vec<ResourceRevocation>,
    pub receipt: LocalCommitReceiptRef,
    pub routing_claims: Vec<RoutingClaim>,
    pub physical_evidence: PhysicalEvidenceDigest,
}

/// Minimal immutable manifest information carried by a delivery packet. It
/// proves which commit the packet represents without exposing unrelated
/// routing claims, intent evidence, or physical journal details.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct CommitManifestHeader {
    pub event_version: u32,
    pub identity: CommitIdentity,
    pub operation_id: String,
    pub committed_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct AuthorizedDeliveryAtom {
    pub descriptor: DeliveryAtomDescriptor,
    pub payload: DeliveryAtomPayload,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct AuthorizedDocumentEffect {
    pub reference: DocumentEffectRef,
    pub inline_update: Option<Vec<u8>>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum RevokedResourceKind {
    Page,
    Document,
    Database,
    DataSource,
    View,
    Canvas,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ResourceRevocationReason {
    OwnershipMoved,
    AccessRevoked,
    Archived,
    Deleted,
}

/// Core-authored authorization boundary for one delivery artifact. This is
/// part of packet integrity and must never be reconstructed by an Adapter.
#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DeliveryAuthorizationScope {
    Library {
        library_id: String,
    },
    Project {
        library_id: String,
        project_id: String,
    },
    Document {
        library_id: String,
        project_id: Option<String>,
        document_id: String,
    },
}

/// Logical destination selected by the authenticated Host broker. Routing is
/// distinct from authorization even when both identities are equal today.
#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DeliveryAddress {
    Library {
        library_id: String,
    },
    Project {
        library_id: String,
        project_id: String,
    },
    Document {
        library_id: String,
        project_id: Option<String>,
        document_id: String,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ConservativeResetReason {
    AuthorizationClosureExceeded,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum VisibilityDeltaKind {
    Grant,
    Revoke { reason: ResourceRevocationReason },
    ConservativeReset { reason: ConservativeResetReason },
}

/// Manifest-bound authorization change. Exact deltas carry one or more roots;
/// conservative resets intentionally carry none and fence the whole address.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct VisibilityDelta {
    pub authorization_scope: DeliveryAuthorizationScope,
    pub change: VisibilityDeltaKind,
    pub roots: Vec<ResourceKey>,
    pub delta_hash: String,
}

/// Core-issued identity for one active broker recipient. Main may route with
/// this lease but cannot construct or broaden its authorization scope.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct AuthorizedRecipientLease {
    pub lease_id: String,
    pub delivery_address: DeliveryAddress,
    pub authorization_scope: DeliveryAuthorizationScope,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum AddressResetReason {
    StreamGap,
    RecipientNack,
    AckTimeout,
    QueueOverflow,
    IntegrityFailure,
    StoreEpochReplacement,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct AddressReset {
    pub reset_id: String,
    pub store_epoch: StoreEpoch,
    pub recipient_lease_id: String,
    pub delivery_address: DeliveryAddress,
    pub authorization_scope: DeliveryAuthorizationScope,
    pub required_commit_seq: i64,
    pub reason: AddressResetReason,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct AuthorizedReadStamp {
    pub store_epoch: StoreEpoch,
    pub delivery_address: DeliveryAddress,
    pub authorization_scope: DeliveryAuthorizationScope,
    pub subject: ResourceKey,
    pub request_dependencies: Vec<ResourceKey>,
    pub authorization_dependencies: Vec<ResourceKey>,
    pub covered_commit_seq: i64,
    pub stamp_hash: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ResourceRevocation {
    pub authorization_scope: DeliveryAuthorizationScope,
    pub resource_kind: RevokedResourceKind,
    pub resource_id: String,
    pub reason: ResourceRevocationReason,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct DeliveryCoverage {
    pub atom_ids: Vec<String>,
    pub document_effect_orders: Vec<i64>,
    pub inline_document_effect_orders: Vec<i64>,
    pub projection_scope_keys: Vec<String>,
}

/// Post-state-authorized transport artifact. Packets for the apply response
/// and durable stream may have different coverage but always reference the
/// same immutable manifest identity.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct AuthorizedDeliveryPacket {
    pub packet_version: u32,
    pub delivery_address: DeliveryAddress,
    pub authorization_scope: DeliveryAuthorizationScope,
    pub manifest: CommitManifestHeader,
    pub atoms: Vec<AuthorizedDeliveryAtom>,
    pub document_effects: Vec<AuthorizedDocumentEffect>,
    pub projection_effects: Vec<ProjectionEffect>,
    pub visibility_deltas: Vec<VisibilityDelta>,
    pub coverage: DeliveryCoverage,
    pub packet_hash: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct StoreObservation {
    pub store_epoch: StoreEpoch,
    pub commit_head: i64,
}

/// Closed result of an authorized command. A semantic mutation returns its
/// immutable commit identity; a validated no-op returns only the observed
/// store cursor and therefore cannot masquerade as a new commit.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ApplyResponse<T, R> {
    Committed {
        outcome: T,
        receipt: R,
        commit: CommitIdentity,
        delivery: Option<Box<AuthorizedDeliveryPacket>>,
    },
    NoOp {
        outcome: T,
        receipt: R,
        observed: StoreObservation,
    },
}

impl<T, R> ApplyResponse<T, R> {
    pub fn outcome(&self) -> &T {
        match self {
            Self::Committed { outcome, .. } | Self::NoOp { outcome, .. } => outcome,
        }
    }

    pub fn receipt(&self) -> &R {
        match self {
            Self::Committed { receipt, .. } | Self::NoOp { receipt, .. } => receipt,
        }
    }

    pub fn store_epoch(&self) -> &StoreEpoch {
        match self {
            Self::Committed { commit, .. } => &commit.store_epoch,
            Self::NoOp { observed, .. } => &observed.store_epoch,
        }
    }

    pub fn commit_cursor(&self) -> i64 {
        match self {
            Self::Committed { commit, .. } => commit.commit_seq,
            Self::NoOp { observed, .. } => observed.commit_head,
        }
    }
}

/// Proof that Core's durable scanner inspected the ledger through a sequence.
/// Commit sequences are monotonic and unique but need not be contiguous.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct StreamCheckpoint {
    pub store_epoch: StoreEpoch,
    pub generation: String,
    pub scanned_through_seq: i64,
    pub oldest_available_seq: i64,
    pub resync_token: Option<String>,
}
