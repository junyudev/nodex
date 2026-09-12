//! Retained edits are distinct from committed history and rejected single-update evidence.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use utoipa::ToSchema;

pub const MAX_RECOVERY_BUNDLE_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_RECOVERY_MANIFEST_BYTES: usize = 256 * 1024;
pub const MAX_RECOVERY_SECTIONS: usize = 4096;
pub const MAX_RECOVERY_MANIFEST_DEPTH: usize = 32;
pub const MAX_RECOVERY_MANIFEST_NODES: usize = 100_000;

/// References live outside source JSON, so arbitrary user fields remain unambiguous.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct RecoveryEvidenceReference {
    pub pointer: String,
    pub section_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub representation: Option<RecoveryEvidenceRepresentation>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum RecoveryEvidenceRepresentation {
    Uint8Array,
    ArrayBuffer,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum RecoverySectionEncoding {
    Bytes,
    Json,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct RecoveryBundleSection {
    pub id: String,
    pub encoding: RecoverySectionEncoding,
    pub byte_length: u32,
    pub sha256: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum RecoveryBundleContent {
    Yjs {
        state: String,
        unintegrated_updates: Vec<String>,
    },
    Canvas {
        scene: Option<String>,
        mutations: Vec<String>,
    },
}

/// NDRB v1 has a 12-byte header followed by this manifest and ordered sections.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct RecoveryBundleManifest {
    pub format_version: u32,
    pub draft_id: String,
    pub document_id: String,
    pub source_store_epoch: String,
    pub source_revision: String,
    pub generation: i64,
    pub base_head_seq: i64,
    pub created_at: String,
    pub schema_key: String,
    pub schema_version: i64,
    pub content: RecoveryBundleContent,
    pub source: String,
    pub source_references: Vec<RecoveryEvidenceReference>,
    pub sections: Vec<RecoveryBundleSection>,
}

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
pub struct RecoveryCaptureReceipt {
    pub draft_id: String,
    pub source_revision: String,
    pub submitted_payload_hash: String,
    pub stored_payload_hash: String,
    pub stored_encoding: String,
    pub stored_byte_length: i64,
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
    pub source_store_epoch: String,
    pub source_generation: i64,
    pub current: bool,
    pub retained: bool,
    pub restored: bool,
    pub current_generation: Option<i64>,
    pub current_head_seq: Option<i64>,
    pub already_saved: bool,
    pub can_restore: bool,
    pub can_copy: bool,
    pub explanation: Option<String>,
}

pub const MAX_RECOVERY_PREVIEW_BYTES: usize = 512 * 1024;
pub const MAX_RECOVERY_EXPORT_BYTES: usize =
    MAX_RECOVERY_BUNDLE_BYTES + MAX_RECOVERY_MANIFEST_BYTES + 12;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum RecoveryPreviewView {
    Current,
    Retained,
    Restored,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct RecoveryPreviewRequest {
    pub draft_id: String,
    pub revision: i64,
    pub expected_generation: Option<i64>,
    pub expected_head_seq: Option<i64>,
    pub view: RecoveryPreviewView,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RecoveryPreviewResult {
    Complete {
        preview: RecoveryPreview,
    },
    Limited {
        byte_length: usize,
        explanation: String,
    },
    Unavailable {
        explanation: String,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RecoveryRead {
    Preview {
        request: RecoveryPreviewRequest,
    },
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
    Preview {
        result: RecoveryPreviewResult,
    },
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

/// Export preserves payload bytes and the File dependency snapshot without decoding content.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct RecoveryExportRequest {
    pub draft_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct RecoveryExportManifest {
    pub format_version: u32,
    pub draft_id: String,
    pub document_id: String,
    pub payload_encoding: String,
    pub payload_byte_length: usize,
    pub payload_sha256: String,
    /// Original recorded digest, retained for diagnosing damaged payloads.
    pub expected_payload_sha256: Option<String>,
    pub companion_byte_length: usize,
    pub companion_sha256: String,
    /// File contents are external dependencies, not embedded backups.
    pub external_files: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum RecoveryFailureReason {
    RequestTooLarge,
    ResponseTooLarge,
    ManifestTooLarge,
    InvalidManifest,
    InvalidJson,
    UnsupportedFormat,
    UnsupportedTransport,
    InvalidDigest,
    CapacityExhausted,
    SourceUnverified,
}
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum RecoveryFailureEffect {
    NotApplied,
    Unknown,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct RecoveryPackageFailure {
    pub reason: RecoveryFailureReason,
    pub effect: RecoveryFailureEffect,
    pub actual: Option<u64>,
    pub limit: Option<u64>,
}
