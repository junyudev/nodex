//! Retained edits are distinct from committed history and rejected single-update evidence.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use utoipa::ToSchema;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct RecoveryDraftCapture {
    pub draft_id: String,
    pub document_id: String,
    pub source_store_epoch: String,
    pub generation: i64,
    pub base_head_seq: i64,
    pub created_at: String,
    pub schema_key: String,
    pub schema_version: i64,
    pub content: RecoveryDraftContent,
    /// Lossless source envelope, including original request identities. Never replayed with new IDs.
    pub source: Value,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RecoveryDraftContent {
    Yjs {
        state: Vec<u8>,
        unintegrated_updates: Vec<Vec<u8>>,
    },
    Canvas {
        scene: Option<Value>,
        mutations: Vec<Value>,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum RecoveryResolution {
    AlreadySaved,
    Restored,
    Copied,
    Discarded,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct RecoveryDraftSummary {
    pub draft_id: String,
    pub document_id: String,
    pub source_title: Option<String>,
    pub revision: i64,
    pub created_at: String,
    pub received_at: String,
    pub byte_length: i64,
    pub payload_hash: String,
    pub resolution: Option<RecoveryResolution>,
    pub resolved_at: Option<String>,
    pub target_owner_id: Option<String>,
    pub target_document_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct RecoveryDraftPage {
    pub drafts: Vec<RecoveryDraftSummary>,
    pub next_cursor: Option<String>,
    pub pending_count: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RecoveryPreview {
    Document {
        title: String,
        rich_title: Value,
        nfm: String,
        files: std::collections::BTreeMap<String, crate::library::LibraryFileReadBinding>,
    },
    Canvas {
        scene: Value,
        files: std::collections::BTreeMap<String, crate::library::LibraryFileReadBinding>,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct RecoveryDraftInspection {
    pub summary: RecoveryDraftSummary,
    pub capture: RecoveryDraftCapture,
    pub current: Option<RecoveryPreview>,
    pub retained: Option<RecoveryPreview>,
    pub restored: Option<RecoveryPreview>,
    pub current_generation: Option<i64>,
    pub current_head_seq: Option<i64>,
    pub already_saved: bool,
    pub can_restore: bool,
    pub can_copy: bool,
    pub explanation: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RecoveryRead {
    List {
        document_id: Option<String>,
        include_resolved: bool,
        before: Option<String>,
        limit: u32,
    },
    Inspect {
        draft_id: String,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RecoveryReadValue {
    List {
        page: RecoveryDraftPage,
    },
    Inspect {
        inspection: Box<RecoveryDraftInspection>,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RecoveryChoice {
    Reconcile,
    Restore,
    Copy,
    Discard,
    Reopen,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct RecoveryDraftResolve {
    pub draft_id: String,
    pub revision: i64,
    pub expected_generation: Option<i64>,
    pub expected_head_seq: Option<i64>,
    pub choice: RecoveryChoice,
}
