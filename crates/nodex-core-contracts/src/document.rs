use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use utoipa::ToSchema;

use crate::agent::{
    AgentExecutionAuthorization, AgentOperationPreparation, AgentPreparedExecution,
};
use crate::{
    ApplyResponse, ModuleMutationReceipt, ModuleName, StoreEpoch, VersionedModuleContract,
};

mod recovery;
pub use recovery::*;

pub const OWNED_DOCUMENT_CONTRACT_VERSION: u32 = 12;
pub const OWNED_DOCUMENT_DESCRIPTOR_VERSION: u32 = 3;

/// Exact rejected input, retained separately from committed content. It is not a full document backup.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, ToSchema)]
pub struct DocumentRecoveryArtifact {
    pub artifact_id: String,
    pub document_id: String,
    pub store_epoch: StoreEpoch,
    pub generation: i64,
    pub update_id: String,
    pub client_session_id: String,
    pub base_head_seq: i64,
    pub update: Vec<u8>,
    pub update_hash: String,
    pub created_at: String,
    pub expires_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum OwnedDocumentAccessContext {
    Library,
    Project {
        #[serde(rename = "projectId")]
        project_id: String,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum OwnedDocumentOwnerLifecycle {
    Active,
    Archived,
    Deleted,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum OwnedDocumentReadiness {
    PendingGenesis,
    Ready,
    Failed,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum OwnedDocumentSyncDescriptor {
    Yjs {
        #[serde(rename = "stateVector")]
        state_vector: Vec<u8>,
    },
    CanvasScene,
}

/// Canonical identity and durable head for a Document as observed through one
/// explicit access boundary. Library ownership and Project authorization are
/// deliberately separate fields; adapters must validate this descriptor, not
/// rewrite it into a caller-shaped identity.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct OwnedDocumentDescriptor {
    pub version: u32,
    pub library_id: String,
    pub access_context: OwnedDocumentAccessContext,
    pub owner_block_id: String,
    pub owner_type: String,
    pub owner_lifecycle: OwnedDocumentOwnerLifecycle,
    pub document_id: String,
    pub store_epoch: String,
    pub generation: i64,
    pub head_seq: i64,
    pub schema_key: String,
    pub schema_version: i64,
    pub readiness: OwnedDocumentReadiness,
    pub sync: OwnedDocumentSyncDescriptor,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum DocumentLiveEngine {
    Yjs,
    CanvasScene,
}

/// Atomic authorization and coverage boundary for one exact Document lease.
/// Historical state through `commit_head` is supplied by canonical sync;
/// only later addressed commits belong to this live stream.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct DocumentLiveBarrier {
    pub store_epoch: StoreEpoch,
    pub core_generation: String,
    pub document_id: String,
    pub document_generation: i64,
    pub head_seq: i64,
    pub commit_head: i64,
    pub engine: DocumentLiveEngine,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum DocumentLiveRepairReason {
    ReceiverLagged,
    PayloadUnavailable,
    IdentityChanged,
    AccessRevoked,
    EventGap,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct DocumentLiveRepair {
    pub document_id: String,
    pub store_epoch: StoreEpoch,
    pub document_generation: i64,
    pub head_seq: i64,
    pub commit_head: i64,
    pub reason: DocumentLiveRepairReason,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct CanvasCompactionStats {
    pub document_id: String,
    pub generation: i64,
    pub head_seq: i64,
    pub scene_hash: String,
    pub tombstone_count: i64,
    pub tombstone_bytes: i64,
    pub eligible: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum DocumentUpdateResourceUnavailableReason {
    Compacted,
    GenerationChanged,
    HashMismatch,
    Missing,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct DocumentUpdateResource {
    pub document_id: String,
    pub generation: i64,
    pub base_head_seq: i64,
    pub head_seq: i64,
    pub update_id: String,
    pub update_hash: String,
    pub update_byte_length: i64,
    pub update: Vec<u8>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct DocumentUpdateResourceUnavailable {
    pub document_id: String,
    pub requested_generation: i64,
    pub current_generation: i64,
    pub current_head_seq: i64,
    pub update_id: String,
    pub update_hash: String,
    pub reason: DocumentUpdateResourceUnavailableReason,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct AgentDocumentSemanticMutation {
    pub document_id: String,
    pub generation: i64,
    pub expected_head_seq: i64,
    pub commands: Vec<DocumentSemanticCommand>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DocumentSemanticAnchor {
    Start { parent_block_id: Option<String> },
    End { parent_block_id: Option<String> },
    Before { block_id: String },
    After { block_id: String },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum OwnedDocumentRead {
    Recovery {
        read: RecoveryRead,
    },
    RecoveryArtifact {
        document_id: String,
        artifact_id: String,
        store_epoch: StoreEpoch,
        generation: i64,
    },
    Descriptor {
        owner_block_id: String,
    },
    SyncYjs {
        document_id: String,
        state_vector: Vec<u8>,
    },
    FetchUpdate {
        document_id: String,
        generation: i64,
        update_id: String,
        update_hash: String,
    },
    ListVersions {
        document_id: String,
        before: Option<DocumentVersionCursor>,
        limit: Option<u32>,
    },
    GetVersion {
        document_id: String,
        version_id: String,
    },
    CanvasCompactionEligibility {
        document_id: String,
    },
    PrepareAgentSemanticMutation {
        operation_id: String,
        store_epoch: StoreEpoch,
        authorization: Box<AgentExecutionAuthorization>,
        mutation: Box<AgentDocumentSemanticMutation>,
    },
    AgentSemanticSnapshot {
        store_epoch: StoreEpoch,
        authorization: Box<AgentExecutionAuthorization>,
        document_id: String,
        target_block_id: String,
        prepare_title: bool,
        prepare_body: bool,
        block_guards: Vec<AgentDocumentBlockGuard>,
        max_depth: Option<u32>,
        cursor: Option<String>,
        limit: Option<u32>,
    },
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum OwnedDocumentReadValue {
    Recovery {
        value: RecoveryReadValue,
    },
    RecoveryArtifact {
        artifact: DocumentRecoveryArtifact,
    },
    Descriptor {
        descriptor: OwnedDocumentDescriptor,
    },
    YjsSync {
        descriptor: OwnedDocumentDescriptor,
        update: Vec<u8>,
    },
    UpdateResource {
        resource: DocumentUpdateResource,
    },
    UpdateResourceUnavailable {
        unavailable: DocumentUpdateResourceUnavailable,
    },
    Versions {
        items: Vec<Value>,
        next: Option<DocumentVersionCursor>,
    },
    Version {
        value: Value,
    },
    CanvasCompactionEligibility {
        stats: CanvasCompactionStats,
    },
    AgentSemanticMutationPreparation {
        preparation: AgentOperationPreparation,
        #[serde(skip_serializing_if = "Option::is_none")]
        committed: Option<Box<ApplyResponse<OwnedDocumentCommitValue, OwnedDocumentReceipt>>>,
    },
    AgentSemanticSnapshot {
        snapshot: Box<AgentDocumentSemanticSnapshot>,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum AgentDocumentBlockGuardKind {
    Update,
    Delete,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct AgentDocumentBlockGuard {
    pub block_id: String,
    pub kind: AgentDocumentBlockGuardKind,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, ToSchema)]
pub struct AgentDocumentSemanticBlock {
    pub block_id: String,
    pub parent_block_id: Option<String>,
    pub sibling_index: u32,
    pub depth: u32,
    pub block_type: String,
    pub props: BTreeMap<String, Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub etag: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, ToSchema)]
pub struct AgentDocumentSemanticSnapshot {
    pub document_id: String,
    pub generation: i64,
    pub head_seq: i64,
    pub owner_block_id: String,
    pub target_block_id: String,
    pub title: String,
    pub rich_title: Value,
    pub nested_markdown: String,
    pub plain_text: String,
    pub blocks: Vec<AgentDocumentSemanticBlock>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title_etag: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body_etag: Option<String>,
    pub has_more: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum OwnedDocumentIntent {
    CaptureRecovery {
        capture: Box<RecoveryDraftCapture>,
    },
    ResolveRecovery {
        resolve: RecoveryDraftResolve,
    },
    PrepareOwner {
        owner_block_id: String,
    },
    ApplyYjsUpdate {
        document_id: String,
        generation: i64,
        base_head_seq: i64,
        update_id: String,
        touched_block_ids: Vec<String>,
        update: Vec<u8>,
    },
    ApplySemanticMutation {
        document_id: String,
        generation: i64,
        expected_head_seq: i64,
        commands: Vec<DocumentSemanticCommand>,
    },
    ApplyOperationBatch {
        document_id: String,
        generation: i64,
        expected_head_seq: i64,
        operations: Vec<DocumentBlockOperation>,
        actor: Value,
    },
    ReplaceFromNfm {
        document_id: String,
        generation: i64,
        expected_head_seq: i64,
        nfm: String,
        rich_title: Option<Vec<Value>>,
        actor: Value,
    },
    ExecutePreparedAgentSemanticMutation {
        authorization: Box<AgentPreparedExecution>,
        mutation: Box<AgentDocumentSemanticMutation>,
    },
    ApplyCanvasMutation {
        document_id: String,
        generation: i64,
        expected_head_seq: i64,
        mutation: Value,
    },
    CompactCanvasTombstones {
        document_id: String,
        generation: i64,
        expected_head_seq: i64,
        actor: Value,
    },
    CreateCheckpoint {
        document_id: String,
        generation: i64,
        expected_head_seq: i64,
        cause: String,
        label: Option<String>,
        actor: Value,
        revision_kind: Option<DocumentRevisionKind>,
        source_mutation_id: Option<String>,
        source_change_seq: Option<i64>,
    },
    RestoreVersion {
        document_id: String,
        version_id: String,
        generation: i64,
        expected_head_seq: i64,
        actor: Value,
    },
    ApplyOwnerCommand {
        command: DocumentOwnerCommand,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct DocumentVersionCursor {
    pub base_head_seq: i64,
    pub created_at: String,
    pub version_id: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum DocumentRevisionKind {
    Automatic,
    Manual,
    Operation,
    Restore,
    Safety,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DocumentSemanticCommand {
    SetTitle {
        inline_markdown: String,
        expected_etag: String,
    },
    PatchBody {
        old_fragment: String,
        new_fragment: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        expected_matches: Option<u32>,
    },
    InsertBody {
        anchor: DocumentSemanticAnchor,
        nested_markdown: String,
    },
    ReplaceBody {
        nested_markdown: String,
        expected_etag: String,
    },
    InsertBlock {
        anchor: DocumentSemanticAnchor,
        block: DocumentSemanticBlockDraft,
    },
    UpdateBlock {
        block_id: String,
        expected_etag: String,
        patch: DocumentBlockUpdatePatch,
    },
    DeleteBlock {
        block_id: String,
        expected_etag: String,
    },
    MoveBlock {
        block_id: String,
        anchor: DocumentSemanticAnchor,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct DocumentSemanticBlockDraft {
    pub local_id: String,
    pub block_type: String,
    pub props: BTreeMap<String, Value>,
    pub content: DocumentOptionalValue,
    #[schema(no_recursion)]
    pub children: Vec<DocumentSemanticBlockDraft>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum DocumentOptionalValue {
    Absent,
    Value { value: Value },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct DocumentBlockUpdatePatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub block_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub props: Option<BTreeMap<String, Value>>,
    pub content: DocumentOptionalValue,
    pub unset_content: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DocumentBlockOperation {
    SetTitle {
        title: String,
    },
    SetRichTitle {
        rich_title: Vec<Value>,
    },
    InsertBlock {
        block: Value,
        parent_block_id: Option<String>,
        before_block_id: Option<String>,
    },
    UpdateBlock {
        block_id: String,
        patch: DocumentBlockUpdatePatch,
    },
    DeleteBlock {
        block_id: String,
    },
    MoveBlock {
        block_id: String,
        parent_block_id: Option<String>,
        before_block_id: Option<String>,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DocumentOwnerCommand {
    CreateSyncedSource {
        source_block_id: String,
        document_id: String,
        initial_blocks: Vec<Value>,
        before: Option<DocumentSpaceAnchor>,
    },
    PromoteSyncedSource {
        host: DocumentHeadRevision,
        root_block_id: String,
        reference_block_id: String,
        source_block_id: String,
        source_document_id: String,
    },
    DemoteSyncedSource {
        host: DocumentHeadRevision,
        source: DocumentHeadRevision,
        reference_block_id: String,
        source_block_id: String,
    },
    CreateTemplate {
        source_block_id: String,
        document_id: String,
        display_name: String,
        initial_blocks: Vec<Value>,
        before: Option<DocumentSpaceAnchor>,
    },
    InstantiateTemplate {
        source_block_id: String,
        source: DocumentHeadRevision,
        target: DocumentHeadRevision,
        parent_block_id: Option<String>,
        before_block_id: Option<String>,
    },
    DeleteOwnedSource {
        owner_kind: DeletableOwnedSourceKind,
        owner: DocumentOwnerRevision,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct DocumentHeadRevision {
    pub document_id: String,
    pub generation: i64,
    pub head_seq: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct DocumentOwnerRevision {
    pub owner_block_id: String,
    pub document_id: String,
    pub generation: i64,
    pub head_seq: i64,
    pub metadata_revision: i64,
    pub location_revision: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct DocumentSpaceAnchor {
    pub block_id: String,
    pub expected_location_revision: i64,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum DeletableOwnedSourceKind {
    SyncedBlock,
    ReusableTemplate,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct DocumentOwnerEffect {
    pub created_block_ids: Vec<String>,
    pub preserved_block_ids: Vec<String>,
    pub deleted_block_ids: Vec<String>,
    pub document_heads: Vec<DocumentHeadRevision>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct OwnedDocumentCommitValue {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recovery: Option<RecoveryDraftSummary>,
    pub document_id: String,
    pub generation: i64,
    pub head_seq: i64,
    pub outcome: DocumentCommitOutcome,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub committed_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub canvas: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_effect: Option<DocumentOwnerEffect>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checkpoint_effect: Option<DocumentCheckpointEffect>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mutation_effect: Option<DocumentMutationEffect>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub semantic_etags: Option<DocumentSemanticEtags>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub semantic_block_etags: Option<BTreeMap<String, DocumentSemanticBlockEtags>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub semantic_local_block_ids: Option<BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub semantic_deleted_owner_block_ids: Option<Vec<String>>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct DocumentSemanticEtags {
    pub title: String,
    pub body: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct DocumentSemanticBlockEtags {
    pub update: String,
    pub delete: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct DocumentCheckpointEffect {
    pub checkpoint: Value,
    pub duplicate: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum DocumentMutationCoordination {
    MergeFriendly,
    WriteFence,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct DocumentMutationEffect {
    pub base_head_seq: i64,
    pub touched_block_ids: Vec<String>,
    pub created_block_ids: Vec<String>,
    pub deleted_block_ids: Vec<String>,
    pub updated_block_ids: Vec<String>,
    pub moved_block_ids: Vec<String>,
    pub write_fence_block_ids: Vec<String>,
    pub title_changed: bool,
    pub coordination: DocumentMutationCoordination,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum DocumentCommitOutcome {
    Committed,
    NoChange,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct OwnedDocumentReceipt {
    #[serde(flatten)]
    pub mutation: ModuleMutationReceipt,
    pub document_id: String,
    pub generation: i64,
    pub head_seq: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PageFileReferenceChange {
    Exact {
        added_file_ids: Vec<String>,
        removed_file_ids: Vec<String>,
    },
    Reset,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum OwnedDocumentEvent {
    RecoveryChanged {
        document_id: String,
        detached: bool,
    },
    DocumentUpdated {
        document_id: String,
        generation: i64,
        head_seq: i64,
        update: Vec<u8>,
        page_file_body_usage_changed: bool,
        page_file_reference_change: Option<PageFileReferenceChange>,
    },
    /// The durable document effect remains replayable after Yjs history
    /// compaction, but its original update bytes are no longer retained.
    /// Consumers must perform a canonical document resync instead of
    /// treating the compacted effect as an empty update.
    DocumentResyncRequired {
        document_id: String,
        generation: i64,
        head_seq: i64,
        update_id: String,
        update_hash: String,
        page_file_body_usage_changed: bool,
        page_file_reference_change: Option<PageFileReferenceChange>,
    },
    CanvasUpdated {
        document_id: String,
        generation: i64,
        base_head_seq: i64,
        head_seq: i64,
        scene_hash: String,
        mutation: Value,
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
        generation: i64,
        head_seq: i64,
        reason: DocumentInvalidationReason,
        page_file_body_usage_changed: bool,
        page_file_reference_change: Option<PageFileReferenceChange>,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum DocumentInvalidationReason {
    AccessChanged,
    GenerationChanged,
    Restored,
}

pub struct OwnedDocumentContract;

impl VersionedModuleContract for OwnedDocumentContract {
    type Read = OwnedDocumentRead;
    type Snapshot = OwnedDocumentReadValue;
    type Intent = OwnedDocumentIntent;
    type Receipt = OwnedDocumentReceipt;
    type Event = OwnedDocumentEvent;

    const VERSION: u32 = OWNED_DOCUMENT_CONTRACT_VERSION;
    const MODULE: ModuleName = ModuleName::OwnedDocument;
}
