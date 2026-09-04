mod block_document;
mod canvas;
mod canvas_scene;
mod compaction;
pub(crate) mod event_log;
mod genesis;
mod history;
pub(crate) mod integrity;
mod maintenance;
mod materialization;
mod module;
mod nfm_input;
mod operations;
mod owners;
mod persistence;
mod primary_canvas;
mod realtime;
mod recovery;
mod retention;
mod runtime;
mod schema_compatibility;
mod schema_migration;
mod semantic;
mod yrs_engine;

pub use block_document::{
    BlockDocumentError, BlockDocumentSchema, DecodedBlockDocument, PAGE_SCHEMA_KEY,
    PAGE_SCHEMA_VERSION, REUSABLE_TEMPLATE_SCHEMA_KEY, REUSABLE_TEMPLATE_SCHEMA_VERSION,
    SYNCED_BLOCK_SCHEMA_KEY, SYNCED_BLOCK_SCHEMA_VERSION, decode_block_document,
    encode_block_document,
};
pub use compaction::DocumentCompactionResult;
pub(crate) use maintenance::{
    compact_eligible_documents, finalize_idle_document_revisions, has_document_compaction_work,
    has_document_history_retention_work, next_revision_maintenance_at_ms,
    prune_document_history_pass,
};
pub(crate) use materialization::CURRENT_DOCUMENT_MATERIALIZATION_DERIVATION_VERSION;
pub use materialization::{
    BlockDocumentKind, BlockDocumentSchemaMetadata, DocumentBlockSearchUnit,
    DocumentMaterialization, DocumentMaterializationError, DocumentSearchMarkerKind,
    materialize_decoded_document, schema_metadata,
};
pub(crate) use materialization::{
    derive_document_node_delta, derive_document_placement_delta,
    exact_moves_explain_document_placement,
};
pub(crate) use module::require_owned_document_read_access;
pub use module::{
    CanvasSceneSyncSnapshot, DocumentCacheMetrics, OwnedDocumentApplyOutcome, OwnedDocumentModule,
};
pub use operations::{
    DocumentBlockOperation, DocumentBlockUpdatePatch, DocumentOperationError,
    DocumentOperationErrorCode, ExactNfmPatch, MAX_DOCUMENT_OPERATION_BATCH_SIZE,
    PortableSubtreeDocumentHead, PortableSubtreeTransferKind, PortableSubtreeTransferRequest,
    PreparedDocumentOperationUpdate, PreparedPortableSubtreeTransfer, apply_exact_nfm_patches,
    prepare_document_operation_update, prepare_exact_nfm_patch_update,
    prepare_nfm_replacement_update, prepare_portable_subtree_transfer_updates,
};
pub use realtime::{
    AwarenessPublication, DocumentRealtimeEvent, DocumentSubscriptionAck,
    DocumentSubscriptionEngine, OwnedDocumentRealtimeAdapter,
};
#[cfg(test)]
pub(crate) use retention::run_block_retention_pass;
pub(crate) use retention::{
    block_retention_work_revision, plan_block_retention_due_work, plan_block_retention_pass,
    run_bounded_block_retention_slice,
};
pub(crate) use runtime::DocumentRuntimeCache;
pub use yrs_engine::{
    AwarenessChange, CandidateCommit, DocumentAwareness, MAX_AWARENESS_UPDATE_BYTES,
    MAX_DOCUMENT_UPDATE_BYTES, MAX_STATE_VECTOR_BYTES, YrsDiagnostic, YrsDocumentEngine,
    YrsEngineError, YrsUpdateCandidate, create_compatible_document, decode_state_vector_v1,
    has_pending_dependencies,
};

pub(crate) use canvas::{
    clone_canvas_genesis, clone_canvas_scene_genesis, ensure_canvas_scene, load_canvas_scene,
};
pub(crate) use canvas_scene::{
    CANVAS_OWNER_TYPE, CANVAS_SCHEMA_KEY, CANVAS_SCHEMA_VERSION, CanvasScene,
};
pub(crate) use genesis::{
    PreparedYjsGenesis, prepare_page_yjs_genesis, prepare_page_yjs_genesis_with_content,
    prepare_yjs_clone_genesis,
};
pub(crate) use history::{NewDocumentCheckpoint, insert_document_checkpoint};
#[cfg(test)]
pub(crate) use persistence::persist_yjs_genesis;
pub(crate) use persistence::{
    DocumentAuthorityRow, DocumentPlacementEvidence, PersistYjsCommit, PersistYjsGenesis,
    persist_yjs_commit_with_local_commit, persist_yjs_genesis_with_local_commit,
    read_document_authority, read_store_epoch, sha256,
};
pub(crate) use primary_canvas::{
    PrimaryCanvasIdentity, create_primary_canvas, is_primary_canvas_block_id,
    primary_canvas_block_id, primary_canvas_document_id,
};
pub(crate) use runtime::reconstruct_yjs_engine;
pub(crate) use schema_compatibility::{
    current_schema_for_stored_identity, normalize_stored_document_materialization,
    normalize_stored_materialized_forest,
};
pub(crate) use schema_migration::{
    migrate_block_children_contract, repair_document_schema_projections,
    validate_block_children_migration_source,
};
pub(crate) use semantic::{
    mint_document_projection_etags, mint_document_semantic_etags, mint_etag,
    parse_inline_markdown_title,
};

pub(crate) use canvas_scene::parse_canvas_scene as parse_recovery_canvas;
