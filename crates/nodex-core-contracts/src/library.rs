use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use serde_json::Value;

use crate::agent::{
    AgentExecutionAuthorization, AgentOperationPreparation, AgentPreparedExecution,
    AgentResourceAccessOverlay, AgentResourceAccessPlan, AgentResourceGrantSpec,
    AgentResourceIntent, AgentTurnProvenance,
};
use crate::database::{
    DatabaseGroupScope, DatabaseIntent, DatabaseListMoveTarget, DatabaseListProjectionExpectation,
    DatabasePageLayout, DatabasePropertyDescriptor, DatabaseViewPreferencesOverrideInput,
};
use crate::document::DocumentHeadRevision;
use crate::workspace::{ProjectAppearance, ProjectLifecycle};
use crate::{ApplyResponse, ModuleMutationReceipt, ModuleName, VersionedModuleContract};

pub const LIBRARY_CONTRACT_VERSION: u32 = 42;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LibraryRouteTarget {
    Page { page_id: String },
    Database { database_id: String },
    Canvas { canvas_id: String },
    View { view_id: String },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LibraryResourceTarget {
    Page { page_id: String },
    Database { database_id: String },
    Canvas { canvas_id: String },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LibraryNavigationParent {
    Library,
    Page { page_id: String },
    Database { database_id: String },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryPlacementAnchor {
    pub block_id: String,
    pub expected_location_revision: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LibraryWriteParent {
    Library {
        before: Option<LibraryPlacementAnchor>,
    },
    Page {
        page_id: String,
        expected_document_generation: i64,
        expected_document_head_seq: i64,
        before: Option<LibraryPlacementAnchor>,
        insertion: Option<LibraryPageInsertion>,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LibraryPageInsertion {
    Append {
        parent_block_id: Option<String>,
    },
    Before {
        parent_block_id: Option<String>,
        anchor_block_id: String,
    },
    ReplaceEmptyParagraph {
        block_id: String,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct LibraryPageMentionHost {
    pub page_id: String,
    pub document_id: String,
    pub expected_document_generation: i64,
    pub expected_document_head_seq: i64,
    pub block_id: String,
    pub expected_content: Vec<Value>,
    pub replacement_content: Vec<Value>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct LibraryPageMentionDestination {
    pub page_id: String,
    pub document_id: String,
    pub expected_document_generation: i64,
    pub expected_document_head_seq: i64,
    pub insertion: LibraryPageInsertion,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryPageMentionDestinationHead {
    pub page_id: String,
    pub document_id: String,
    pub document_generation: i64,
    pub document_head_seq: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LibraryCanvasDestination {
    Library {
        before: Option<LibraryPlacementAnchor>,
    },
    Page {
        page_id: String,
        expected_document_generation: i64,
        expected_document_head_seq: i64,
        insertion: LibraryPageInsertion,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LibraryPageCopyDestination {
    Library {
        before: Option<LibraryPlacementAnchor>,
    },
    Page {
        page_id: String,
        expected_document_generation: i64,
        expected_document_head_seq: i64,
        before: Option<LibraryPlacementAnchor>,
    },
    DataSource {
        data_source_id: String,
        expected_data_source_revision: i64,
        values: Vec<LibraryPageCopyValue>,
        view: Option<LibraryPageCopyViewPlacement>,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryPageCopyValue {
    pub property_id: String,
    pub value: Value,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryPageCopyViewPlacement {
    pub view_id: String,
    pub expected_view_revision: i64,
    pub group_key: Option<String>,
    pub before: Option<LibraryPageCopyPositionAnchor>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryPageCopyPositionAnchor {
    pub page_id: String,
    pub expected_position_revision: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LibraryAgentSiblingAnchor {
    Start,
    End,
    Before { block_id: String },
    After { block_id: String },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LibraryPageWriteDestination {
    Library {
        at: Option<LibraryAgentSiblingAnchor>,
    },
    Page {
        page_id: String,
        at: Option<LibraryAgentSiblingAnchor>,
    },
    DataSource {
        data_source_id: String,
        view_id: Option<String>,
        group: Option<DatabaseGroupScope>,
        at: Option<LibraryAgentSiblingAnchor>,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LibraryAgentPageDestination {
    Library {
        at: Option<LibraryAgentSiblingAnchor>,
    },
    Page {
        page_id: String,
        at: Option<LibraryAgentSiblingAnchor>,
    },
    DataSource {
        data_source_id: String,
        values: Vec<LibraryPageCopyValue>,
        view_id: Option<String>,
        group_key: Option<String>,
        at: Option<LibraryAgentSiblingAnchor>,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryAgentPageCopyRequest {
    pub source_page_id: String,
    pub destination: LibraryAgentPageDestination,
    pub include_block_map: bool,
    pub include_etags: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryAgentCreatePageDraft {
    pub title_markdown: String,
    pub nfm: String,
    pub values: Vec<LibraryPageCopyValue>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryAgentCreatePagesRequest {
    pub destination: LibraryAgentPageDestination,
    pub pages: Vec<LibraryAgentCreatePageDraft>,
    pub include_block_ids: bool,
    pub include_etags: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryAgentMovePagesRequest {
    pub page_ids: Vec<String>,
    pub destination: LibraryAgentPageDestination,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryAgentDocumentHead {
    pub document_id: String,
    pub generation: i64,
    pub expected_head_seq: i64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, ToSchema)]
pub struct LibraryAgentPageCopyPreparation {
    pub preparation: AgentOperationPreparation,
    pub page_id: String,
    pub body_block_count: u32,
    pub document_heads: Vec<LibraryAgentDocumentHead>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub destination: Option<LibraryPageCopyDestination>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub destination_document: Option<LibraryAgentDocumentHead>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub destination_database_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub committed: Option<Box<ApplyResponse<LibraryCommitValue, LibraryReceipt>>>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryAgentPageEtags {
    pub title: String,
    pub body: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryAgentPageCopyResult {
    pub source_page_id: String,
    pub page_id: String,
    pub page_key: Option<String>,
    pub location: LibraryAgentPageLocation,
    pub body_blocks_created: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub block_map: Option<std::collections::BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub etags: Option<LibraryAgentPageEtags>,
    pub document_commits: Vec<LibraryBlockTransferDocumentCommit>,
    pub affected_database_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryAgentCreatePagePreparation {
    pub page_id: String,
    pub body_block_ids: Vec<String>,
    pub primary_membership_id: String,
    pub target_membership_id: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, ToSchema)]
pub struct LibraryAgentCreatePagesPreparation {
    pub preparation: AgentOperationPreparation,
    pub pages: Vec<LibraryAgentCreatePagePreparation>,
    pub document_heads: Vec<LibraryAgentDocumentHead>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub destination: Option<LibraryPageCopyDestination>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub destination_document: Option<LibraryAgentDocumentHead>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub destination_database_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub committed: Option<Box<ApplyResponse<LibraryCommitValue, LibraryReceipt>>>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryAgentCreatedPage {
    pub page_id: String,
    pub page_key: Option<String>,
    pub location: LibraryAgentPageLocation,
    pub body_blocks_created: u32,
    pub block_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub etags: Option<LibraryAgentPageEtags>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryAgentCreatePagesResult {
    pub pages: Vec<LibraryAgentCreatedPage>,
    pub document_commits: Vec<LibraryBlockTransferDocumentCommit>,
    pub affected_database_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryAgentMovePagePreparation {
    pub page_id: String,
    pub source: LibraryBlockTransferSource,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_document_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_database_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, ToSchema)]
pub struct LibraryAgentMovePagesPreparation {
    pub preparation: AgentOperationPreparation,
    pub pages: Vec<LibraryAgentMovePagePreparation>,
    pub document_heads: Vec<LibraryAgentDocumentHead>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub destination: Option<LibraryPageCopyDestination>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub destination_document: Option<LibraryAgentDocumentHead>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub destination_database_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub committed: Option<Box<ApplyResponse<LibraryCommitValue, LibraryReceipt>>>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryAgentMovedPage {
    pub page_id: String,
    pub page_key: Option<String>,
    pub location: LibraryAgentPageLocation,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryAgentMovePagesResult {
    pub pages: Vec<LibraryAgentMovedPage>,
    pub document_commits: Vec<LibraryBlockTransferDocumentCommit>,
    pub affected_database_ids: Vec<String>,
    pub file_ownership_moves: Vec<LibraryPageFileOwnershipMove>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum LibraryBlockTransferMode {
    Move,
    Copy,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum LibraryPagePromotionPolicy {
    Literal,
    TaskShorthandV1,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LibraryBlockTransferSource {
    Library { library_id: String },
    Page { page_id: String },
    Document { document_id: String },
    DataSource { data_source_id: String },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LibraryBlockTransferTarget {
    Library {
        library_id: String,
        before_block_id: Option<String>,
    },
    Page {
        page_id: String,
        parent_block_id: Option<String>,
        before_block_id: Option<String>,
    },
    Document {
        document_id: String,
        parent_block_id: Option<String>,
        before_block_id: Option<String>,
    },
    DataSource {
        data_source_id: String,
        placement: Box<LibraryBlockTransferDataSourcePlacement>,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LibraryBlockTransferDataSourcePlacement {
    Direct {
        view_id: String,
        preferences_override: DatabaseViewPreferencesOverrideInput,
        group_key: Option<String>,
        before_page_id: Option<String>,
        #[serde(default)]
        sorted_property_values: Vec<LibraryPageCopyValue>,
    },
    ListOccurrence {
        view_id: String,
        preferences_override: DatabaseViewPreferencesOverrideInput,
        expected_projection: DatabaseListProjectionExpectation,
        target: DatabaseListMoveTarget,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryBlockTransferLogicalIntent {
    pub actor: Value,
    pub mode: LibraryBlockTransferMode,
    pub root_block_ids: Vec<String>,
    pub causal_dependencies: Vec<LibraryBlockTransferDocumentHead>,
    pub source: LibraryBlockTransferSource,
    pub target: LibraryBlockTransferTarget,
    pub promotion_policy: LibraryPagePromotionPolicy,
}

/// Exact durable coordinates for a Document mutation fence.
///
/// Structural owner mutations use the same coordinate shape as BlockTransfer:
/// the renderer must flush the live surface first, and Core then rejects a
/// mutation if the durable head has advanced in the meantime.
pub type LibraryDocumentHead = DocumentHeadRevision;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryBlockTransferDocumentHead {
    pub document_id: String,
    pub generation: i64,
    pub expected_head_seq: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LibraryBlockLocation {
    Library {
        library_id: String,
        rank_key: String,
    },
    Document {
        document_id: String,
    },
    DataSource {
        database_id: String,
        data_source_id: String,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryBlockTransferDocumentCommit {
    pub document_id: String,
    pub generation: i64,
    pub base_head_seq: i64,
    pub head_seq: i64,
    pub update_id: String,
    pub update: Vec<u8>,
    pub state_vector: Vec<u8>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryBlockTransferUndoToken {
    pub transfer_operation_id: String,
    pub recipe_hash: String,
    pub store_epoch: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryPageViewPlacementResult {
    pub view_id: String,
    pub group_key: Option<String>,
    pub position_revision: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum LibraryTaskShorthandPreservedReason {
    MalformedShorthand,
    NonemptyTitleRequired,
    RichTextBoundary,
    TargetPropertyConflict,
    TargetSchemaIncompatible,
    TagSchemaPermissionRequired,
    TagOptionLimit,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LibraryBlockTransferPromotionEvidence {
    NotRequested,
    NotApplicable,
    NoMatch,
    Applied {
        grammar_version: u32,
        priority_option_id: String,
        estimate_option_id: Option<String>,
        tag_option_ids: Vec<String>,
        tag_names: Vec<String>,
        created_tag_option_ids: Vec<String>,
    },
    Preserved {
        grammar_version: u32,
        reason: LibraryTaskShorthandPreservedReason,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct LibraryBlockTransferTransformationEvidence {
    pub source_block_id: String,
    pub result_page_id: String,
    pub kind: String,
    pub source_block_type: String,
    pub semantic_title_hash: String,
    pub consumed_property_keys: Vec<String>,
    pub wrapper_reason: Option<String>,
    pub body_root_block_ids: Vec<String>,
    pub source_to_result_block_ids: std::collections::BTreeMap<String, String>,
    pub promotion: LibraryBlockTransferPromotionEvidence,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryBlockTransferResult {
    pub mode: LibraryBlockTransferMode,
    pub source_root_block_ids: Vec<String>,
    pub result_root_block_ids: Vec<String>,
    pub copied_block_ids: std::collections::BTreeMap<String, String>,
    pub transformation_evidence: Vec<LibraryBlockTransferTransformationEvidence>,
    pub final_locations: std::collections::BTreeMap<String, LibraryBlockLocation>,
    pub final_location_revisions: std::collections::BTreeMap<String, i64>,
    pub document_commits: Vec<LibraryBlockTransferDocumentCommit>,
    pub affected_database_ids: Vec<String>,
    /// Current human-readable Page keys for result roots. A present `None`
    /// value means the root is a Page that is not currently in a keyed
    /// Database namespace.
    pub page_keys: std::collections::BTreeMap<String, Option<String>>,
    pub page_etags: std::collections::BTreeMap<String, String>,
    pub move_etags: std::collections::BTreeMap<String, String>,
    pub page_view_placements: std::collections::BTreeMap<String, LibraryPageViewPlacementResult>,
    pub file_ownership_moves: Vec<LibraryPageFileOwnershipMove>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub undo_token: Option<LibraryBlockTransferUndoToken>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryBlockTransferUndoResult {
    pub transfer_operation_id: String,
    pub restored_source_root_ids: Vec<String>,
    pub removed_page_ids: Vec<String>,
    pub document_commits: Vec<LibraryBlockTransferDocumentCommit>,
    pub file_ownership_moves: Vec<LibraryPageFileOwnershipMove>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryStructuralSelection {
    pub source_document_id: String,
    pub root_block_ids: Vec<String>,
    pub source_head: LibraryDocumentHead,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryStructuralTarget {
    pub target_document_id: String,
    pub parent_block_id: Option<String>,
    pub before_block_id: Option<String>,
    pub target_head: LibraryDocumentHead,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryStructuralClipboardToken {
    pub bundle_id: String,
    pub capability: String,
    pub manifest_hash: String,
    pub store_epoch: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryStructuralHistoryToken {
    pub recipe_operation_id: String,
    pub recipe_hash: String,
    pub store_epoch: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LibraryStructuralDeleteReason {
    Delete,
    Cut {
        bundle: LibraryStructuralClipboardToken,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum LibraryStructuralDeleteDirection {
    Backward,
    Forward,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum LibraryHeadingLevel {
    One,
    Two,
    Three,
}

/// The lossless ordinary Block shapes supported by the structural Turn into
/// operation. This is intentionally closed: typed owners and atom Blocks need
/// dedicated domain transitions rather than arbitrary type/props patches.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LibraryStructuralTurnIntoTarget {
    Paragraph,
    Heading {
        level: LibraryHeadingLevel,
        toggleable: bool,
    },
    BulletedList,
    NumberedList,
    TodoList,
    ToggleList,
    Quote,
    Callout,
    Code,
    Equation,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryStructuralReplacementBlock {
    pub block_type: String,
    pub props: std::collections::BTreeMap<String, serde_json::Value>,
    pub content: Option<serde_json::Value>,
    #[schema(no_recursion)]
    pub children: Vec<LibraryStructuralReplacementBlock>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LibraryStructuralReplacement {
    Clipboard {
        bundle: LibraryStructuralClipboardToken,
    },
    Blocks {
        blocks: Vec<LibraryStructuralReplacementBlock>,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LibraryStructuralEditCommand {
    CaptureClipboard {
        selection: LibraryStructuralSelection,
    },
    DeleteSelection {
        selection: LibraryStructuralSelection,
        reason: LibraryStructuralDeleteReason,
        direction: LibraryStructuralDeleteDirection,
    },
    PasteClipboard {
        bundle: LibraryStructuralClipboardToken,
        target: LibraryStructuralTarget,
    },
    DuplicateSelection {
        selection: LibraryStructuralSelection,
        target: LibraryStructuralTarget,
    },
    MoveSelection {
        selection: LibraryStructuralSelection,
        target: LibraryStructuralTarget,
    },
    ReplaceSelection {
        selection: LibraryStructuralSelection,
        replacement: LibraryStructuralReplacement,
    },
    TurnSelectionInto {
        selection: LibraryStructuralSelection,
        target: LibraryStructuralTurnIntoTarget,
    },
    MergeBlockBackward {
        selection: LibraryStructuralSelection,
        target_block_id: String,
    },
    ReleaseHistory {
        tokens: Vec<LibraryStructuralHistoryToken>,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum LibraryEditorResumeEdge {
    Start,
    End,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryEditorResumeTarget {
    pub block_id: String,
    pub edge: LibraryEditorResumeEdge,
    pub fallback_before_block_id: Option<String>,
    pub fallback_after_block_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryStructuralEditResult {
    pub operation_kind: String,
    pub source_root_block_ids: Vec<String>,
    pub result_root_block_ids: Vec<String>,
    pub copied_block_ids: std::collections::BTreeMap<String, String>,
    pub copied_document_ids: std::collections::BTreeMap<String, String>,
    pub document_commits: Vec<LibraryBlockTransferDocumentCommit>,
    pub affected_page_ids: Vec<String>,
    pub affected_database_ids: Vec<String>,
    pub clipboard: Option<LibraryStructuralClipboardToken>,
    pub history: Option<LibraryStructuralHistoryToken>,
    pub superseded_history_recipe_operation_ids: Vec<String>,
    pub resume: Option<LibraryEditorResumeTarget>,
    pub file_ownership_moves: Vec<LibraryPageFileOwnershipMove>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LibraryRead {
    Metadata,
    ResourceProjectAccess {
        target: LibraryResourceTarget,
    },
    FilterProjectionImpactForProject {
        project_id: String,
        impact: crate::ProjectionImpact,
    },
    Children {
        parent: LibraryNavigationParent,
        cursor: Option<String>,
        limit: Option<u32>,
        force_include_target: Option<LibraryRouteTarget>,
    },
    StandaloneRoots {
        cursor: Option<String>,
        limit: Option<u32>,
        force_include_target: Option<LibraryResourceTarget>,
    },
    Path {
        target: LibraryRouteTarget,
    },
    Catalog {
        query: Option<String>,
        kinds: Option<Vec<LibraryCatalogKind>>,
        lifecycle: Option<LibraryLifecycle>,
        cursor: Option<String>,
        limit: Option<u32>,
    },
    MoveDestinations {
        target: LibraryResourceTarget,
        scope: LibraryMoveDestinationScope,
        cursor: Option<String>,
        limit: Option<u32>,
    },
    PageMentionDestination {
        page_id: String,
    },
    PageDetail {
        page_id: String,
    },
    PageContent {
        page_id: String,
    },
    PageFiles {
        page_id: String,
        query: Option<String>,
        cursor: Option<String>,
        limit: Option<u32>,
        include_deleted: Option<bool>,
    },
    PageFileMetadata {
        page_id: String,
        file_id: String,
    },
    PageFileVersions {
        page_id: String,
        file_id: String,
        cursor: Option<String>,
        limit: Option<u32>,
    },
    PageProjectionFile {
        page_id: String,
        file_kind: LibraryPageProjectionFileKind,
        prepare: Option<LibraryPagePrepareKind>,
    },
    PageDraftProjection {
        page_id: String,
    },
    AcquireSearchSnapshot {
        scope: LibrarySearchSnapshotScope,
        strict_materialization: bool,
    },
    ReleaseSearchSnapshot {
        lease_id: String,
    },
    AgentBlockTarget {
        block_id: String,
        authorization: Box<AgentExecutionAuthorization>,
    },
    AgentSearch {
        authorization: Box<AgentExecutionAuthorization>,
        query: String,
        target: LibraryAgentSearchTarget,
        scope: LibraryAgentSearchScope,
        block_types: Option<Vec<String>>,
        include_archived: bool,
        cursor: Option<String>,
        limit: Option<u32>,
    },
    PageTarget {
        page_id: String,
    },
    PageKeyTarget {
        page_key: String,
    },
    PageOwnershipPath {
        page_id: String,
    },
    PageLocation {
        page_id: String,
    },
    CanvasTarget {
        canvas_id: String,
    },
    ViewLocation {
        view_id: String,
    },
    PageLifecyclePreflight {
        page_id: String,
    },
    Search {
        query: String,
        include_archived: bool,
        source_kinds: Option<Vec<LibrarySearchSourceKind>>,
        block_types: Option<Vec<String>>,
        cursor: Option<String>,
        limit: Option<u32>,
    },
    ProjectPageSearch {
        project_ids: Vec<String>,
        query: String,
        filters: Option<LibraryProjectPageSearchFilters>,
        preferred_project_id: Option<String>,
        recent_page_ids: Vec<String>,
        limit: Option<u32>,
    },
    ProjectPageSearchFacets {
        project_ids: Vec<String>,
    },
    ProjectPageSearchMetadata {
        project_ids: Vec<String>,
        page_ids: Option<Vec<String>>,
    },
    PageReferenceCandidates {
        query: String,
        limit: Option<u32>,
        source_page_id: Option<String>,
    },
    PageBacklinks {
        target_page_id: String,
        cursor: Option<String>,
        limit: Option<u32>,
    },
    PageHistory {
        page_id: String,
        before: Option<LibraryPageHistoryCursor>,
        limit: Option<u32>,
    },
    PlanAgentResourceAccess {
        provenance: Box<AgentTurnProvenance>,
        call_id: String,
        intents: Vec<AgentResourceIntent>,
        task_access: Option<Box<AgentResourceAccessOverlay>>,
    },
    PrepareAgentPageCopy {
        operation_id: String,
        store_epoch: String,
        authorization: Box<AgentExecutionAuthorization>,
        request: Box<LibraryAgentPageCopyRequest>,
    },
    PrepareAgentCreatePages {
        operation_id: String,
        store_epoch: String,
        authorization: Box<AgentExecutionAuthorization>,
        request: Box<LibraryAgentCreatePagesRequest>,
    },
    PrepareAgentMovePages {
        operation_id: String,
        store_epoch: String,
        authorization: Box<AgentExecutionAuthorization>,
        request: Box<LibraryAgentMovePagesRequest>,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum LibraryCatalogKind {
    Page,
    Database,
    Canvas,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum LibraryLifecycle {
    Active,
    Archived,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LibraryNavigationNode {
    Page {
        page_id: String,
        title: String,
        has_children: bool,
        parent_revision: i64,
        metadata_revision: i64,
        document_generation: i64,
        document_head_seq: i64,
        updated_at: String,
    },
    Database {
        database_id: String,
        title: String,
        default_view_id: String,
        has_multiple_views: bool,
        metadata_revision: i64,
        location_revision: i64,
        updated_at: String,
    },
    Canvas {
        canvas_id: String,
        title: String,
        is_primary: bool,
        metadata_revision: i64,
        location_revision: i64,
        document_generation: i64,
        document_head_seq: i64,
        updated_at: String,
    },
    View {
        view_id: String,
        database_id: String,
        data_source_id: String,
        title: String,
        layout: String,
        is_default: bool,
        revision: i64,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryCatalogEntry {
    pub target: LibraryResourceTarget,
    pub title: String,
    pub kind: LibraryCatalogKind,
    pub lifecycle: LibraryLifecycle,
    pub location_label: String,
    pub updated_at: String,
    pub location_revision: i64,
    pub metadata_revision: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LibraryMoveDestinationScope {
    Suggested,
    Children { parent: LibraryNavigationParent },
    Search { query: String },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryMoveDestinationEntry {
    pub page_id: String,
    pub title: String,
    pub path: Vec<String>,
    pub has_children: bool,
    pub is_current: bool,
    pub document_generation: i64,
    pub document_head_seq: i64,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LibraryCanvasLocation {
    Library,
    Page {
        page_id: String,
        document_id: String,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryCanvasSummary {
    pub canvas_id: String,
    pub title: String,
    pub lifecycle: String,
    pub is_primary: bool,
    pub location: LibraryCanvasLocation,
    pub metadata_revision: i64,
    pub location_revision: i64,
    pub document_generation: i64,
    pub document_head_seq: i64,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum LibraryCanvasTarget {
    Missing {
        canvas_id: String,
    },
    Deleted {
        canvas_id: String,
        library_id: String,
    },
    Available {
        summary: LibraryCanvasSummary,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryPageDocumentDescriptor {
    pub readiness: String,
    pub schema_key: String,
    pub schema_version: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum LibraryPageTarget {
    Missing {
        target_page_id: String,
    },
    InvalidTarget {
        target_page_id: String,
        actual_block_type: String,
    },
    Deleted {
        target_page_id: String,
        library_id: String,
    },
    Available {
        target_page_id: String,
        page: Value,
        document: LibraryPageDocumentDescriptor,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum LibraryPageKeyTarget {
    NotFound,
    Ambiguous,
    Resolved {
        page_id: String,
        current_page_key: Option<String>,
        matched_page_key: String,
        is_current: bool,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryPageOwnershipPathAncestor {
    pub page_id: String,
    pub title: String,
    pub lifecycle: LibraryLifecycle,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum LibraryPageOwnershipPath {
    Missing {
        target_page_id: String,
    },
    Available {
        target_page_id: String,
        ancestors: Vec<LibraryPageOwnershipPathAncestor>,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryPageLocation {
    pub page_id: String,
    pub access_project_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryViewLocation {
    pub view_id: String,
    pub data_source_id: String,
    pub database_id: String,
    pub access_project_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LibraryPageLifecycleParent {
    Library { library_id: String },
    Page { page_id: String },
    DataSource { data_source_id: String },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryPageLifecycleDocument {
    pub document_id: String,
    pub generation: i64,
    pub head_seq: i64,
    pub readiness: String,
    pub authority: String,
    pub schema_key: String,
    pub schema_version: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryPageLifecyclePosition {
    pub rank_key: String,
    pub revision: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryPageLifecycleMembership {
    pub membership_id: String,
    pub database_id: String,
    pub data_source_id: String,
    pub membership_revision: i64,
    pub view_id: String,
    pub view_revision: i64,
    pub status_property_id: String,
    pub status_value_revision: i64,
    pub status: LibraryPageWorkflowStatus,
    pub position: Option<LibraryPageLifecyclePosition>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryPageLifecycleRestoreMembership {
    pub membership_id: String,
    pub database_id: String,
    pub data_source_id: String,
    pub status: LibraryPageWorkflowStatus,
    pub view_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryPageLifecycleRestoreEvidence {
    pub delete_operation_id: String,
    pub previous_lifecycle: LibraryLifecycle,
    pub membership: Option<LibraryPageLifecycleRestoreMembership>,
    pub nested_parent: Option<LibraryPageLifecycleNestedParent>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryPageLifecycleAuthority {
    pub page_id: String,
    pub lifecycle: String,
    pub parent: LibraryPageLifecycleParent,
    pub library_rank_key: Option<String>,
    pub metadata_revision: i64,
    pub parent_revision: i64,
    pub document: LibraryPageLifecycleDocument,
    pub membership: Option<LibraryPageLifecycleMembership>,
    pub restore_evidence: Option<LibraryPageLifecycleRestoreEvidence>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryPageLifecyclePreflight {
    pub default_view: Value,
    pub tags_property: Value,
    pub reserved_block_type: Option<String>,
    pub page: Option<LibraryPageLifecycleAuthority>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryPageLifecycleTagOption {
    pub option_id: String,
    pub name: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryPageLifecycleRestorePosition {
    pub view_id: String,
    pub before_view_page_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryPageLifecycleMutationMembership {
    pub membership_id: String,
    pub database_id: String,
    pub data_source_id: String,
    pub status: LibraryPageWorkflowStatus,
    pub position: Option<LibraryPageLifecycleRestorePosition>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LibraryPageLifecycleViewPlacement {
    Start,
    End,
    Before { page_id: String },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
// This pre-release tagged union changes through coordinated Core protocol
// generation. The large create payload is boxed by
// `LibraryIntent::ApplyPageLifecycle`; boxing individual fields would not
// reduce the request retained by the transport.
#[allow(clippy::large_enum_variant)]
pub enum LibraryPageLifecycleMutation {
    CreatePage {
        page_id: String,
        title: String,
        rich_title: Option<Value>,
        nfm: String,
        status: LibraryPageWorkflowStatus,
        priority: Option<String>,
        estimate: Option<String>,
        due_date: Option<String>,
        scheduled_start: Option<String>,
        scheduled_end: Option<String>,
        is_all_day: bool,
        recurrence: Option<Value>,
        reminders: Vec<Value>,
        schedule_timezone: Option<String>,
        assignee: Option<String>,
        run_in_target: String,
        run_in_local_path: Option<String>,
        run_in_base_branch: Option<String>,
        run_in_worktree_path: Option<String>,
        run_in_environment_path: Option<String>,
        before_block_id: Option<String>,
        view_placement: LibraryPageLifecycleViewPlacement,
        data_source_id: String,
        tag_option_ids: Vec<String>,
        new_tag_options: Vec<LibraryPageLifecycleTagOption>,
        expected_tags_property_revision: i64,
    },
    ArchivePage {
        page_id: String,
        expected_metadata_revision: i64,
    },
    UnarchivePage {
        page_id: String,
        expected_metadata_revision: i64,
    },
    DeletePage {
        page_id: String,
        expected_metadata_revision: i64,
        expected_parent_revision: i64,
        parent_document_head: Option<LibraryDocumentHead>,
    },
    RestorePage {
        page_id: String,
        delete_operation_id: String,
        expected_metadata_revision: i64,
        expected_parent_revision: i64,
        membership: Option<LibraryPageLifecycleMutationMembership>,
        before_block_id: Option<String>,
        parent_document_head: Option<LibraryDocumentHead>,
    },
    MovePageInLibrary {
        page_id: String,
        expected_parent_revision: i64,
        before_block_id: Option<String>,
    },
}

impl LibraryPageLifecycleMutation {
    pub fn page_id(&self) -> &str {
        match self {
            Self::CreatePage { page_id, .. }
            | Self::ArchivePage { page_id, .. }
            | Self::UnarchivePage { page_id, .. }
            | Self::DeletePage { page_id, .. }
            | Self::RestorePage { page_id, .. }
            | Self::MovePageInLibrary { page_id, .. } => page_id,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum LibraryPageLifecycleState {
    Active,
    Archived,
    Deleted,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryPageLifecycleDeletedBlock {
    pub block_id: String,
    pub metadata_revision: i64,
    /// Post-delete metadata revision for an independent typed-owner
    /// authority, when this indexed Block has one.
    pub resource_metadata_revision: Option<i64>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryPageLifecycleDeleteEvidence {
    pub previous_lifecycle: LibraryLifecycle,
    pub membership: Option<LibraryPageLifecycleMutationMembership>,
    pub tombstoned_blocks: Vec<LibraryPageLifecycleDeletedBlock>,
    pub indexed_document_ids: Vec<String>,
    pub nested_parent: Option<LibraryPageLifecycleNestedParent>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryPageLifecycleNestedParent {
    pub document_id: String,
    pub parent_block_id: Option<String>,
    pub before_block_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryPageLifecycleMutationReceipt {
    pub operation_kind: String,
    pub page_id: String,
    pub metadata_revision: i64,
    pub parent_revision: i64,
    pub lifecycle: LibraryPageLifecycleState,
    pub document_id: String,
    pub document_generation: i64,
    pub document_head_seq: i64,
    pub database_id: Option<String>,
    pub data_source_id: Option<String>,
    pub membership_id: Option<String>,
    pub view_id: Option<String>,
    pub library_rank_key: Option<String>,
    pub view_rank_key: Option<String>,
    pub created_block_ids: Vec<String>,
    pub created_tag_option_ids: Vec<String>,
    pub delete_evidence: Option<LibraryPageLifecycleDeleteEvidence>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LibraryBlockPropertyFieldMutation {
    IntrinsicSet {
        block_id: String,
        property_key: String,
        expected_revision: i64,
        value: Value,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryBlockPropertyMutation {
    pub actor: Value,
    pub client_session_id: Option<String>,
    pub fields: Vec<LibraryBlockPropertyFieldMutation>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum LibraryBlockPropertyMutationErrorCode {
    InvalidPropertyMutationRequest,
    MutationIdCollision,
    ProjectNotFound,
    BlockNotFound,
    BlockNotActive,
    BlockTypeMismatch,
    PropertyNotFound,
    PropertyTypeMismatch,
    PropertyValueInvalid,
    PropertyValueCorrupt,
    PropertyConflict,
    Unknown,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryBlockPropertyMutationError {
    pub code: LibraryBlockPropertyMutationErrorCode,
    pub message: String,
    pub retryable: bool,
    pub field_path: Option<String>,
    pub expected_revision: Option<i64>,
    pub actual_revision: Option<i64>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "scope", rename_all = "snake_case")]
pub enum LibraryBlockPropertyFieldResult {
    Intrinsic {
        path: String,
        block_id: String,
        property_key: String,
        operation: String,
        revision: i64,
        value: Value,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum LibraryBlockPropertyMutationOutcome {
    Committed {
        fields: Vec<LibraryBlockPropertyFieldResult>,
        block_metadata_revisions: std::collections::BTreeMap<String, i64>,
    },
    Rejected {
        error: LibraryBlockPropertyMutationError,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryBlockPropertyMutationReceipt {
    pub outcome: LibraryBlockPropertyMutationOutcome,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, ToSchema)]
pub struct LibraryPageIntrinsicProperty {
    pub key: String,
    pub value_type: String,
    pub value: Value,
    pub revision: i64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, ToSchema)]
pub struct LibraryPageMembership {
    pub membership_id: String,
    pub data_source_id: String,
    pub revision: i64,
    pub created_at: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LibraryPageAccessContext {
    Library,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LibraryPageDataSourceContext {
    Standalone,
    Member {
        page_key: Option<String>,
        membership: Box<LibraryPageMembership>,
        database: Value,
        data_source: Value,
        properties: Vec<DatabasePropertyDescriptor>,
        page_layout: DatabasePageLayout,
        values: std::collections::BTreeMap<String, Value>,
    },
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, ToSchema)]
pub struct LibraryPageDetail {
    pub library_id: String,
    pub store_epoch: String,
    pub commit_seq: i64,
    pub page: Value,
    pub document: LibraryPageDocumentDescriptor,
    pub intrinsic_properties: Vec<LibraryPageIntrinsicProperty>,
    pub data_source_context: LibraryPageDataSourceContext,
    pub access_context: LibraryPageAccessContext,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, ToSchema)]
pub struct LibraryPageContent {
    pub library_id: String,
    pub store_epoch: String,
    pub commit_seq: i64,
    pub page_id: String,
    pub metadata_revision: i64,
    pub document_id: String,
    pub document_generation: i64,
    pub document_head_seq: i64,
    pub schema_key: String,
    pub schema_version: i64,
    pub title: String,
    pub rich_title: Value,
    pub body_nfm: String,
    pub plain_text: String,
    pub preview: String,
    pub references: Vec<LibraryContentReference>,
    pub asset_refs: Vec<LibraryContentAssetReference>,
    pub access_context: LibraryPageAccessContext,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum LibraryPageFileState {
    Live,
    Deleted,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum LibraryPageFileChangeKind {
    Create,
    Replace,
    Rename,
    Delete,
    Restore,
    Clone,
    Rehome,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryPageFileOwnershipMove {
    pub file_id: String,
    pub previous_owner_page_id: String,
    pub owner_page_id: String,
    pub previous_logical_path: String,
    pub logical_path: String,
    pub version: i64,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum LibraryPageFileCollisionPolicy {
    Reject,
    Suffix,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LibraryPageFileBodyUsage {
    NotInBody,
    Placed { placement_count: u64 },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryPageFileSummary {
    pub file_id: String,
    pub owner_page_id: String,
    pub logical_path: String,
    pub mime_type: String,
    pub byte_length: u64,
    pub version: i64,
    pub blob_etag: String,
    pub state: LibraryPageFileState,
    pub created_by_actor_id: String,
    pub created_by_turn_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub body_usage: LibraryPageFileBodyUsage,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryPageFileManifest {
    pub page_id: String,
    pub revision: i64,
    pub body_usage_revision: i64,
    pub files: Vec<LibraryPageFileSummary>,
    pub next_cursor: Option<String>,
    pub has_more: bool,
    pub total: u64,
    pub live_total: u64,
    pub unplaced_total: u64,
    pub placed_total: u64,
    pub deleted_total: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryPageFileVersion {
    pub file_id: String,
    pub version: i64,
    pub owner_page_id: String,
    pub manifest_revision: i64,
    pub change_kind: LibraryPageFileChangeKind,
    pub logical_path: String,
    pub mime_type: String,
    pub byte_length: u64,
    pub blob_etag: Option<String>,
    pub actor_id: String,
    pub turn_id: Option<String>,
    pub operation_id: String,
    pub occurred_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryPageFileVersionPage {
    pub page_id: String,
    pub file_id: String,
    pub versions: Vec<LibraryPageFileVersion>,
    pub next_cursor: Option<String>,
    pub has_more: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LibraryPageFileChange {
    Put {
        file_id: String,
        logical_path: String,
        mime_type: String,
        prepared_blob_receipt_id: String,
    },
    Create {
        file_id: String,
        logical_path: String,
        mime_type: String,
        prepared_blob_receipt_id: String,
        collision_policy: LibraryPageFileCollisionPolicy,
    },
    ReplaceContent {
        file_id: String,
        expected_version: i64,
        mime_type: String,
        prepared_blob_receipt_id: String,
    },
    Rename {
        file_id: String,
        expected_version: i64,
        logical_path: String,
    },
    Delete {
        file_id: String,
        expected_version: i64,
    },
    RestoreVersion {
        file_id: String,
        expected_version: i64,
        source_version: i64,
    },
    CloneIntoPage {
        source_page_id: String,
        source_file_id: String,
        target_file_id: String,
        logical_path: String,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryPageFileMutationReceipt {
    pub page_id: String,
    pub manifest_revision: i64,
    pub created_file_ids: Vec<String>,
    pub updated_file_ids: Vec<String>,
    pub deleted_file_ids: Vec<String>,
    pub consumed_blob_receipt_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryPreparedPageFileBlob {
    pub receipt_id: String,
    pub blob_etag: String,
    pub byte_length: u64,
    pub expires_at_unix_ms: u64,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum LibraryPageProjectionFileKind {
    BodyNestedMarkdown,
    MetaYaml,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum LibraryPagePrepareKind {
    TitleSet,
    DocumentReplace,
    PageDelete,
    PageMove { view_id: Option<String> },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProjectedPropertyTypeV1 {
    Text,
    Number,
    Checkbox,
    Select,
    MultiSelect,
    Date,
    Datetime,
    Relation,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ProjectedIdentityV1 {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ProjectedRelationSummaryV1 {
    pub targets: Vec<ProjectedIdentityV1>,
    pub total_count: i64,
    pub restricted_count: i64,
    pub has_more: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum ProjectedPropertyValueV1 {
    Null,
    Text(String),
    Number(f64),
    Checkbox(bool),
    Identity(ProjectedIdentityV1),
    Identities(Vec<ProjectedIdentityV1>),
    Relation(ProjectedRelationSummaryV1),
    Date(String),
    Datetime(String),
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, ToSchema)]
pub struct ProjectedPropertyV1 {
    pub property_id: String,
    pub name: String,
    pub value_type: ProjectedPropertyTypeV1,
    pub value: ProjectedPropertyValueV1,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ProjectedScheduleV1 {
    pub start: String,
    pub end: String,
    pub timezone: Option<String>,
    pub all_day: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, ToSchema)]
pub struct PageMetaProjectionV2 {
    pub id: String,
    pub page_key: Option<String>,
    pub title_markdown: String,
    pub properties: Vec<ProjectedPropertyV1>,
    pub schedule: Option<ProjectedScheduleV1>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryPageProjectionFileValidators {
    pub title_etag: Option<String>,
    pub body_etag: Option<String>,
    pub page_etag: Option<String>,
    pub move_etag: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, ToSchema)]
pub struct LibraryPageProjectionFile {
    pub version: u32,
    pub library_id: String,
    pub store_epoch: String,
    pub commit_head: i64,
    pub page_id: String,
    pub metadata_revision: i64,
    pub document_id: String,
    pub document_generation: i64,
    pub document_head_seq: i64,
    pub kind: LibraryPageProjectionFileKind,
    pub content: String,
    pub page_key: Option<String>,
    pub metadata: Option<PageMetaProjectionV2>,
    pub validators: LibraryPageProjectionFileValidators,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryPageDraftProjection {
    pub version: u32,
    pub metadata_projection_version: u32,
    pub library_id: String,
    pub store_epoch: String,
    pub commit_head: i64,
    pub page_id: String,
    pub metadata_revision: i64,
    pub document_id: String,
    pub document_generation: i64,
    pub document_head_seq: i64,
    pub meta_yaml: String,
    pub body_nested_markdown: String,
    pub page_files: LibraryPageFileManifest,
    pub title_etag: String,
    pub body_etag: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LibrarySearchSnapshotScope {
    Database { database_id: String },
    DataSource { data_source_id: String },
    Page { page_id: String },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum LibrarySearchSnapshotOwnerKind {
    Library,
    Database,
    DataSource,
    Page,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibrarySearchSnapshotOwner {
    pub kind: LibrarySearchSnapshotOwnerKind,
    pub id: String,
    pub title: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibrarySearchSnapshotFile {
    pub kind: LibraryPageProjectionFileKind,
    pub sha256: String,
    pub byte_length: u64,
    pub physical_relative_path: String,
    pub logical_path: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibrarySearchSnapshotPage {
    pub page_id: String,
    pub title_markdown: String,
    pub database_id: Option<String>,
    pub data_source_id: Option<String>,
    pub ownership_path: Vec<LibrarySearchSnapshotOwner>,
    pub metadata_revision: i64,
    pub document_generation: i64,
    pub document_head_seq: i64,
    pub data_source_schema_revision: Option<i64>,
    pub property_revisions: std::collections::BTreeMap<String, i64>,
    pub value_revisions: std::collections::BTreeMap<String, i64>,
    pub schedule_revision: Option<i64>,
    pub title_sha256: String,
    pub meta: LibrarySearchSnapshotFile,
    pub body: LibrarySearchSnapshotFile,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LibrarySearchSnapshotWarning {
    MaterializationStale { page_id: String },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibrarySearchSnapshotManifest {
    pub version: u32,
    pub projection_version: u32,
    pub library_id: String,
    pub access_project_id: String,
    pub store_epoch: String,
    pub commit_head: i64,
    pub scope: LibrarySearchSnapshotScope,
    pub pages: Vec<LibrarySearchSnapshotPage>,
    pub warnings: Vec<LibrarySearchSnapshotWarning>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibrarySearchSnapshotLease {
    pub lease_id: String,
    pub expires_at_unix_ms: i64,
    pub physical_root: String,
    pub manifest: LibrarySearchSnapshotManifest,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibrarySearchSnapshotRelease {
    pub lease_id: String,
    pub released: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, ToSchema)]
pub struct LibraryAgentBlockTarget {
    pub block_id: String,
    pub block_type: String,
    pub lifecycle: String,
    pub owner_page_id: String,
    pub document_id: String,
    pub document_generation: i64,
    pub document_head_seq: i64,
    pub owner_page: Box<LibraryPageDetail>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LibraryContentReference {
    Block {
        #[serde(rename = "sourceBlockId")]
        source_block_id: String,
        #[serde(rename = "targetBlockId")]
        target_block_id: String,
        #[serde(rename = "displayHint", skip_serializing_if = "Option::is_none")]
        display_hint: Option<String>,
    },
    DatabaseView {
        #[serde(rename = "sourceBlockId")]
        source_block_id: String,
        #[serde(rename = "databaseViewId")]
        database_view_id: String,
        #[serde(rename = "displayHint", skip_serializing_if = "Option::is_none")]
        display_hint: Option<String>,
    },
    Thread {
        #[serde(rename = "sourceBlockId")]
        source_block_id: String,
        #[serde(rename = "targetThreadId")]
        target_thread_id: String,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum LibraryContentAssetKind {
    Image,
    Attachment,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct LibraryContentAssetReference {
    pub source_block_id: String,
    pub kind: LibraryContentAssetKind,
    pub source: String,
    pub managed_file_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_id: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum LibrarySearchSourceKind {
    DocumentTitle,
    DocumentBlock,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum LibraryAgentSearchTarget {
    Pages,
    Blocks,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LibraryAgentSearchScope {
    Library,
    Database { database_id: String },
    DataSource { data_source_id: String },
    Page { page_id: String },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum LibraryAgentSearchMatchQuality {
    Exact,
    Prefix,
    Fuzzy,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LibraryAgentPageLocation {
    Library { library_id: String },
    Page { page_id: String },
    DataSource { data_source_id: String },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "source", rename_all = "snake_case")]
pub enum LibraryAgentPageSearchMatch {
    PageKey {
        quality: LibraryAgentSearchMatchQuality,
        page_key: String,
        is_current: bool,
    },
    Identity {
        quality: LibraryAgentSearchMatchQuality,
        excerpt: String,
    },
    Title {
        quality: LibraryAgentSearchMatchQuality,
        excerpt: String,
    },
    Property {
        quality: LibraryAgentSearchMatchQuality,
        property_id: String,
        property_name: String,
        excerpt: String,
    },
    Body {
        quality: LibraryAgentSearchMatchQuality,
        block_id: String,
        block_type: String,
        excerpt: String,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LibraryAgentSearchResult {
    Page {
        id: String,
        page_key: Option<String>,
        title: String,
        location: LibraryAgentPageLocation,
        matches: Vec<LibraryAgentPageSearchMatch>,
    },
    Block {
        id: String,
        block_type: String,
        owner_page_id: String,
        source: LibrarySearchSourceKind,
        quality: LibraryAgentSearchMatchQuality,
        excerpt: String,
    },
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, ToSchema)]
pub struct LibrarySearchHit {
    pub library_id: String,
    pub owner_page_id: String,
    pub document_id: String,
    pub block_id: String,
    pub block_type: String,
    pub document_generation: i64,
    pub projected_seq: i64,
    pub source_kind: LibrarySearchSourceKind,
    pub field_key: String,
    pub excerpt: String,
    pub rank: f64,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum LibraryPageWorkflowStatus {
    Triage,
    Plan,
    Build,
    Review,
    Ship,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryProjectPageSearchHit {
    pub project_id: String,
    pub page_id: String,
    pub page_key: Option<String>,
    pub title: String,
    pub status: Option<LibraryPageWorkflowStatus>,
    pub priority: Option<String>,
    pub tags: Vec<LibraryPageSearchOption>,
    pub assignee: Option<String>,
    pub location_label: String,
    pub title_parts: Vec<LibraryPageSearchTextPart>,
    pub excerpt: Option<String>,
    pub excerpt_parts: Vec<LibraryPageSearchTextPart>,
    pub matches: Vec<LibraryPageSearchMatch>,
    pub updated_at: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "kebab-case")]
pub enum LibraryPageSearchPriority {
    P0Critical,
    P1High,
    P2Medium,
    P3Low,
}

/// Core-authored, authorization-filtered metadata used by the renderer's
/// synchronous Page-search preview. It is always carried by a commit-fenced
/// Library read snapshot and is not a second durable authority.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryPageSearchMetadataDocument {
    pub page_id: String,
    #[schema(required = true)]
    pub page_key: Option<String>,
    pub title: String,
    pub preview: String,
    #[schema(required = true)]
    pub status: Option<LibraryPageWorkflowStatus>,
    #[schema(required = true, value_type = Option<LibraryPageSearchPriority>)]
    pub priority: Option<String>,
    pub tags: Vec<LibraryPageSearchOption>,
    #[schema(required = true)]
    pub assignee: Option<String>,
    pub location_label: String,
    pub updated_at: String,
    pub properties: Vec<LibraryPageSearchMetadataProperty>,
    pub authorized_project_ids: Vec<String>,
    pub data_source_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryPageSearchMetadataProperty {
    pub property_id: String,
    pub property_name: String,
    pub text: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryPageSearchTextPart {
    pub text: String,
    pub highlighted: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryPageSearchOptionIdentity {
    pub data_source_id: String,
    pub property_id: String,
    pub option_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryPageSearchOption {
    pub data_source_id: String,
    pub property_id: String,
    pub option_id: String,
    pub label: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum LibraryPageSearchTagMode {
    Any,
    All,
    None,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryProjectPageSearchFilters {
    pub statuses: Option<Vec<LibraryPageWorkflowStatus>>,
    pub priorities: Option<Vec<String>>,
    pub include_empty_priority: bool,
    pub tags: Vec<LibraryPageSearchOptionIdentity>,
    pub tag_mode: LibraryPageSearchTagMode,
    pub assignees: Vec<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum LibraryPageSearchMatchQuality {
    Exact,
    Prefix,
    Fuzzy,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "source", rename_all = "snake_case")]
pub enum LibraryPageSearchMatch {
    PageKey {
        quality: LibraryPageSearchMatchQuality,
        page_key: String,
        is_current: bool,
        parts: Vec<LibraryPageSearchTextPart>,
    },
    Identity {
        quality: LibraryPageSearchMatchQuality,
        parts: Vec<LibraryPageSearchTextPart>,
    },
    Title {
        quality: LibraryPageSearchMatchQuality,
        parts: Vec<LibraryPageSearchTextPart>,
    },
    Property {
        quality: LibraryPageSearchMatchQuality,
        property_id: String,
        property_name: String,
        parts: Vec<LibraryPageSearchTextPart>,
    },
    Body {
        quality: LibraryPageSearchMatchQuality,
        block_id: String,
        block_type: String,
        parts: Vec<LibraryPageSearchTextPart>,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryProjectPageSearchFacets {
    pub tags: Vec<LibraryPageSearchOption>,
    pub assignees: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryPageReferenceCandidate {
    pub page_id: String,
    pub title: String,
    pub page_key: Option<String>,
    pub status: Option<LibraryPageWorkflowStatus>,
    pub location_label: String,
    pub match_excerpt: Option<String>,
    pub match_source: LibraryPageReferenceMatchSource,
    pub title_parts: Vec<LibraryPageSearchTextPart>,
    pub match_excerpt_parts: Vec<LibraryPageSearchTextPart>,
    pub matches: Vec<LibraryPageSearchMatch>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum LibraryPageReferenceMatchSource {
    Recent,
    PageKey,
    Title,
    Content,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum LibraryPageReferencePresentation {
    Mention,
    ReferenceBlock,
    Link,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryPageBacklink {
    pub source_page_id: String,
    pub source_block_id: String,
    pub source_title: String,
    pub location_label: String,
    pub presentations: Vec<LibraryPageReferencePresentation>,
    pub occurrence_count: u32,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "source", rename_all = "snake_case")]
pub enum LibraryPageHistoryCursor {
    DocumentVersion {
        occurred_at: String,
        version_id: String,
    },
    ChangeLog {
        occurred_at: String,
        change_seq: i64,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum LibraryPageHistoryCategory {
    Checkpoint,
    Content,
    Property,
    Database,
    Lifecycle,
    Location,
    Unknown,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryPageHistoryDisplay {
    pub category: LibraryPageHistoryCategory,
    pub title: String,
    pub detail: Option<String>,
    pub actor_label: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum LibraryPageHistoryEvidenceReason {
    MissingLedger,
    MalformedEvidence,
    UnsupportedEvidence,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum LibraryPageHistoryEvidence {
    Verified,
    Unavailable {
        reason: LibraryPageHistoryEvidenceReason,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum LibraryPageHistoryRecoveryReason {
    DocumentGenerationChanged,
    InsufficientEvidence,
    NoInverseContract,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LibraryPageHistoryRecovery {
    RestoreDocumentVersion {
        document_id: String,
        version_id: String,
    },
    Unavailable {
        reason: LibraryPageHistoryRecoveryReason,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryPageHistoryEntryBase {
    pub id: String,
    pub library_id: String,
    pub page_id: String,
    pub document_id: String,
    pub occurred_at: String,
    pub display: LibraryPageHistoryDisplay,
    pub evidence: LibraryPageHistoryEvidence,
    pub recovery: LibraryPageHistoryRecovery,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum LibraryDocumentRevisionKind {
    Automatic,
    Manual,
    Operation,
    Restore,
    Safety,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryDocumentVersionMetadata {
    pub version_id: String,
    pub generation: i64,
    pub base_head_seq: i64,
    pub schema_key: String,
    pub schema_version: i64,
    pub cause: String,
    pub label: Option<String>,
    pub revision_kind: LibraryDocumentRevisionKind,
    pub source_mutation_id: Option<String>,
    pub source_change_seq: Option<i64>,
    pub pinned: bool,
    pub checkpoint_hash: String,
    pub byte_length: i64,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum LibraryBlockRelocationDirection {
    IntoPage,
    OutOfPage,
    WithinPage,
    Unknown,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LibraryPageHistoryEntry {
    DocumentVersion {
        #[serde(flatten)]
        entry: LibraryPageHistoryEntryBase,
        version_metadata: LibraryDocumentVersionMetadata,
    },
    BlockMutation {
        #[serde(flatten)]
        entry: LibraryPageHistoryEntryBase,
        change_seq: i64,
        mutation_id: Option<String>,
        mutation_kind: Option<String>,
        affected_block_count: Option<u32>,
        field_intent_count: Option<u32>,
    },
    BlockRelocation {
        #[serde(flatten)]
        entry: LibraryPageHistoryEntryBase,
        change_seq: i64,
        relocation_id: Option<String>,
        direction: LibraryBlockRelocationDirection,
        moved_block_count: Option<u32>,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryPageHistoryPage {
    pub library_id: String,
    pub page_id: String,
    pub document_id: String,
    pub entries: Vec<LibraryPageHistoryEntry>,
    pub next_cursor: Option<LibraryPageHistoryCursor>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LibraryReadValue {
    Metadata {
        profile_id: String,
        library_id: String,
        commit_seq: i64,
    },
    ResourceProjectAccess {
        value: Box<LibraryResourceProjectAccess>,
    },
    ProjectionImpact {
        impact: crate::ProjectionImpact,
    },
    Children {
        parent: LibraryNavigationParent,
        items: Vec<LibraryNavigationNode>,
        next_cursor: Option<String>,
        has_more: bool,
        total: u64,
    },
    StandaloneRoots {
        items: Vec<LibraryNavigationNode>,
        next_cursor: Option<String>,
        has_more: bool,
        total: u64,
    },
    Path {
        target: LibraryRouteTarget,
        nodes: Vec<LibraryNavigationNode>,
    },
    Catalog {
        items: Vec<LibraryCatalogEntry>,
        next_cursor: Option<String>,
        has_more: bool,
        total: u64,
    },
    MoveDestinations {
        target: LibraryResourceTarget,
        scope: LibraryMoveDestinationScope,
        items: Vec<LibraryMoveDestinationEntry>,
        current_destination: Option<LibraryMoveDestinationEntry>,
        next_cursor: Option<String>,
        has_more: bool,
        total: u64,
        root_is_current: bool,
    },
    PageMentionDestination {
        value: LibraryPageMentionDestinationHead,
    },
    PageDetail {
        value: Box<LibraryPageDetail>,
    },
    PageContent {
        value: Box<LibraryPageContent>,
    },
    PageFiles {
        value: Box<LibraryPageFileManifest>,
    },
    PageFileMetadata {
        value: Box<LibraryPageFileSummary>,
    },
    PageFileVersions {
        value: Box<LibraryPageFileVersionPage>,
    },
    PageProjectionFile {
        value: Box<LibraryPageProjectionFile>,
    },
    PageDraftProjection {
        value: Box<LibraryPageDraftProjection>,
    },
    SearchSnapshotLease {
        value: Box<LibrarySearchSnapshotLease>,
    },
    SearchSnapshotRelease {
        value: LibrarySearchSnapshotRelease,
    },
    AgentBlockTarget {
        value: Option<LibraryAgentBlockTarget>,
    },
    AgentSearch {
        items: Vec<LibraryAgentSearchResult>,
        next_cursor: Option<String>,
        has_more: bool,
    },
    PageTarget {
        value: Option<Box<LibraryPageTarget>>,
    },
    PageKeyTarget {
        value: LibraryPageKeyTarget,
    },
    PageOwnershipPath {
        value: Option<Box<LibraryPageOwnershipPath>>,
    },
    PageLocation {
        value: Option<LibraryPageLocation>,
    },
    CanvasTarget {
        value: Box<LibraryCanvasTarget>,
    },
    ViewLocation {
        value: Option<LibraryViewLocation>,
    },
    PageLifecyclePreflight {
        value: Box<LibraryPageLifecyclePreflight>,
    },
    Search {
        items: Vec<LibrarySearchHit>,
        next_cursor: Option<String>,
        has_more: bool,
    },
    ProjectPageSearch {
        items: Vec<LibraryProjectPageSearchHit>,
    },
    ProjectPageSearchFacets {
        value: LibraryProjectPageSearchFacets,
    },
    ProjectPageSearchMetadata {
        items: Vec<LibraryPageSearchMetadataDocument>,
    },
    PageReferenceCandidates {
        items: Vec<LibraryPageReferenceCandidate>,
    },
    PageBacklinks {
        target_page_id: String,
        items: Vec<LibraryPageBacklink>,
        next_cursor: Option<String>,
        has_more: bool,
        total: u64,
        source_page_count: u64,
    },
    PageHistory {
        value: Box<LibraryPageHistoryPage>,
    },
    AgentResourceAccessPlan {
        value: Box<AgentResourceAccessPlan>,
    },
    AgentPageCopyPreparation {
        value: Box<LibraryAgentPageCopyPreparation>,
    },
    AgentCreatePagesPreparation {
        value: Box<LibraryAgentCreatePagesPreparation>,
    },
    AgentMovePagesPreparation {
        value: Box<LibraryAgentMovePagesPreparation>,
    },
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LibraryIntent {
    CreatePage {
        page_id: String,
        document_id: String,
        title: String,
        parent: LibraryWriteParent,
    },
    CreatePageMention {
        page_id: String,
        document_id: String,
        title: String,
        mention_host: LibraryPageMentionHost,
        destination: LibraryPageMentionDestination,
    },
    CreatePageFromNfm {
        title_markdown: String,
        nfm: String,
        destination: LibraryPageWriteDestination,
    },
    ApplyPageFileChanges {
        page_id: String,
        expected_manifest_revision: i64,
        changes: Vec<LibraryPageFileChange>,
        turn_id: Option<String>,
    },
    PutPageFile {
        page_id: String,
        file_id: String,
        logical_path: String,
        mime_type: String,
        prepared_blob_receipt_id: String,
        turn_id: Option<String>,
    },
    CreateDatabase {
        database_id: String,
        data_source_id: String,
        view_id: String,
        name: String,
        parent: LibraryWriteParent,
    },
    CreateCanvas {
        canvas_id: String,
        document_id: String,
        display_name: String,
        destination: LibraryCanvasDestination,
    },
    RenameCanvas {
        canvas_id: String,
        display_name: String,
        expected_metadata_revision: i64,
    },
    MoveCanvas {
        canvas_id: String,
        expected_location_revision: i64,
        destination: LibraryCanvasDestination,
    },
    DuplicateCanvas {
        source_canvas_id: String,
        canvas_id: String,
        document_id: String,
        display_name: Option<String>,
        expected_document_generation: i64,
        expected_document_head_seq: i64,
        destination: LibraryCanvasDestination,
    },
    DeleteCanvas {
        canvas_id: String,
        expected_location_revision: i64,
        expected_metadata_revision: i64,
        containing_document_head: Option<LibraryDocumentHead>,
    },
    CopyPage {
        source_page_id: String,
        expected_location_revision: i64,
        expected_parent_revision: i64,
        expected_active_membership_revision: i64,
        expected_document_generation: i64,
        expected_document_head_seq: i64,
        destination: LibraryPageCopyDestination,
    },
    DuplicatePage {
        source_page_id: String,
        destination: LibraryPageWriteDestination,
    },
    MovePage {
        page_id: String,
        destination: LibraryPageWriteDestination,
        expected_etag: String,
    },
    DeletePage {
        page_id: String,
        expected_etag: String,
    },
    MoveBlock {
        target: LibraryResourceTarget,
        expected_location_revision: i64,
        parent: LibraryWriteParent,
    },
    ArchiveResource {
        target: LibraryResourceTarget,
        expected_metadata_revision: i64,
    },
    RestoreResource {
        target: LibraryResourceTarget,
        expected_metadata_revision: i64,
    },
    ApplyPageLifecycle {
        mutation: Box<LibraryPageLifecycleMutation>,
    },
    ApplyBlockPropertyMutation {
        mutation: Box<LibraryBlockPropertyMutation>,
    },
    ApplyPageMetadataProperties {
        database_intents: Vec<DatabaseIntent>,
        intrinsic_mutation: Box<LibraryBlockPropertyMutation>,
    },
    GrantProjectAccess {
        project_id: String,
        target: LibraryResourceTarget,
        access: LibraryAccess,
    },
    SetProjectAccess {
        target: LibraryResourceTarget,
        changes: Vec<LibraryProjectAccessChange>,
    },
    PersistAgentProjectResourceGrants {
        provenance: Box<AgentTurnProvenance>,
        grants: Vec<AgentResourceGrantSpec>,
    },
    ExecutePreparedAgentPageCopy {
        authorization: Box<AgentPreparedExecution>,
        request: Box<LibraryAgentPageCopyRequest>,
    },
    ExecutePreparedAgentCreatePages {
        authorization: Box<AgentPreparedExecution>,
        request: Box<LibraryAgentCreatePagesRequest>,
    },
    ExecutePreparedAgentMovePages {
        authorization: Box<AgentPreparedExecution>,
        request: Box<LibraryAgentMovePagesRequest>,
    },
    ApplyStructuralEdit {
        command: Box<LibraryStructuralEditCommand>,
    },
    ReverseStructuralEdit {
        token: LibraryStructuralHistoryToken,
    },
    TransferBlocks {
        intent: LibraryBlockTransferLogicalIntent,
    },
    UndoBlockTransfer {
        token: LibraryBlockTransferUndoToken,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum LibraryAccess {
    Read,
    ReadWrite,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryProjectDirectGrant {
    pub access: LibraryAccess,
    pub revision: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LibraryInheritedProjectAccessSource {
    PrimaryDatabase {
        database_id: String,
        database_name: String,
        access: LibraryAccess,
    },
    AncestorPage {
        page_id: String,
        page_title: String,
        access: LibraryAccess,
    },
    DatabaseGrant {
        database_id: String,
        database_name: String,
        access: LibraryAccess,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryProjectAccessRow {
    pub project_id: String,
    pub project_name: String,
    pub appearance: ProjectAppearance,
    pub lifecycle: ProjectLifecycle,
    pub direct_grant: Option<LibraryProjectDirectGrant>,
    pub inherited_sources: Vec<LibraryInheritedProjectAccessSource>,
    pub effective_access: Option<LibraryAccess>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryResourceProjectAccess {
    pub target: LibraryResourceTarget,
    pub projects: Vec<LibraryProjectAccessRow>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryProjectAccessChange {
    pub project_id: String,
    pub access: Option<LibraryAccess>,
    pub expected_revision: Option<i64>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryReceipt {
    #[serde(flatten)]
    pub mutation: ModuleMutationReceipt,
    pub operation_kind: String,
    pub did_mutate: bool,
    pub created_target: Option<LibraryResourceTarget>,
    pub affected_parent_keys: Vec<String>,
    pub affected_page_ids: Vec<String>,
    pub affected_database_ids: Vec<String>,
    pub affected_view_ids: Vec<String>,
    pub committed_revisions: std::collections::BTreeMap<String, i64>,
    pub commit_seq: i64,
    pub committed_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryCommitValue {
    pub affected_resource_ids: Vec<String>,
    pub page_create: Option<LibraryPageCreateResult>,
    pub page_copy: Option<LibraryPageCopyResult>,
    pub page_files: Option<LibraryPageFileMutationReceipt>,
    pub canvas_mutation: Option<LibraryCanvasMutationResult>,
    pub block_transfer: Option<LibraryBlockTransferResult>,
    pub block_transfer_undo: Option<LibraryBlockTransferUndoResult>,
    pub structural_edit: Option<LibraryStructuralEditResult>,
    pub page_lifecycle: Option<LibraryPageLifecycleMutationReceipt>,
    pub block_property_mutation: Option<LibraryBlockPropertyMutationReceipt>,
    pub agent_page_copy: Option<LibraryAgentPageCopyResult>,
    pub agent_create_pages: Option<LibraryAgentCreatePagesResult>,
    pub agent_move_pages: Option<LibraryAgentMovePagesResult>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryCanvasMutationResult {
    pub operation_kind: String,
    pub canvas_id: String,
    pub document_id: String,
    pub source_canvas_id: Option<String>,
    pub location_revision: i64,
    pub metadata_revision: i64,
    pub document_commits: Vec<LibraryBlockTransferDocumentCommit>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryPageCreateResult {
    pub page_id: String,
    pub page_key: Option<String>,
    pub document_id: String,
    pub document_generation: i64,
    pub document_head_seq: i64,
    pub block_ids: Vec<String>,
    pub title_etag: String,
    pub body_etag: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryPageCopyResult {
    pub source_page_id: String,
    pub page_id: String,
    pub page_key: Option<String>,
    pub document_id: String,
    pub block_ids: std::collections::BTreeMap<String, String>,
    pub document_ids: std::collections::BTreeMap<String, String>,
    pub document_generation: i64,
    pub document_head_seq: i64,
    pub title_etag: String,
    pub body_etag: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LibraryPageFileInvalidation {
    Exact {
        revision: i64,
        file_ids: Vec<String>,
    },
    Reset {
        revision: i64,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct LibraryEvent {
    pub kind: LibraryEventKind,
    pub page_ids: Vec<String>,
    pub database_ids: Vec<String>,
    pub view_ids: Vec<String>,
    pub parent_keys: Vec<String>,
    pub page_file_manifest_invalidations:
        std::collections::BTreeMap<String, LibraryPageFileInvalidation>,
    pub page_file_body_usage_revisions: std::collections::BTreeMap<String, i64>,
    pub page_file_content_invalidations:
        std::collections::BTreeMap<String, LibraryPageFileInvalidation>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum LibraryEventKind {
    LibraryChanged,
}

pub struct LibraryContract;

impl VersionedModuleContract for LibraryContract {
    type Read = LibraryRead;
    type Snapshot = LibraryReadValue;
    type Intent = LibraryIntent;
    type Receipt = LibraryReceipt;
    type Event = LibraryEvent;

    const VERSION: u32 = LIBRARY_CONTRACT_VERSION;
    const MODULE: ModuleName = ModuleName::Library;
}
