//! One durable owner for retained edits. Source envelopes are immutable; resolution is revisioned.
use super::*;
use crate::infrastructure::event_log::{NewChangeLogEntry, append_change_log};
use nodex_core_contracts::document::*;
use rusqlite::params;

mod preview_files;
use preview_files::{
    canvas_preview_bindings, current_body_bindings, merged_body_bindings, retained_body_bindings,
    set_preview_files,
};

use crate::document::YrsDocumentEngine;
use crate::document::canvas_scene::{
    apply_canvas_mutation, parse_canvas_mutation, parse_canvas_scene,
};
use crate::infrastructure::document_repository::DocumentSyncEngine;

const MAX_DRAFT_BYTES: usize = 32 * 1024 * 1024;
const MAX_LIBRARY_DRAFT_BYTES: i64 = 256 * 1024 * 1024;
const MAX_LIBRARY_DRAFTS: i64 = 512;
const SUMMARY_COLUMNS: &str = "draft_id, document_id, revision, created_at, received_at, byte_length, payload_hash, resolution, resolved_at, target_owner_id, target_document_id, (SELECT title FROM document_materializations WHERE document_id = document_recovery_drafts.document_id)";

pub(super) struct RecoveryCommit {
    pub draft_id: String,
    pub revision: i64,
    pub resolution: RecoveryResolution,
}

impl OwnedDocumentModule {
    pub(super) fn read_recovery(
        &self,
        context: &BoundModuleContext,
        read: RecoveryRead,
    ) -> Result<ModuleReadSnapshot<OwnedDocumentReadValue>, CoreError> {
        self.readers.read_default(|connection| {
            let value = match read {
                RecoveryRead::List { ref document_id, include_resolved, ref before, limit } => {
                    if limit == 0 || limit > 50 { return Err(invalid_store("Recovery list limit must be between 1 and 50")); }
                    if let Some(id) = document_id { authorize_source(connection, context, &self.library_id, id)?; }
                    let sql = format!("SELECT {SUMMARY_COLUMNS} FROM document_recovery_drafts WHERE library_id = ?1 AND (?2 IS NULL OR document_id = ?2) AND (?3 OR resolution IS NULL) AND (?4 IS NULL OR draft_id > ?4) ORDER BY draft_id LIMIT ?5");
                    // Scan a bounded page even when Project access filters some rows.
                    let rows = connection.prepare(&sql)?.query_map(params![self.library_id, document_id, include_resolved, before, limit + 1], read_summary)?.collect::<rusqlite::Result<Vec<_>>>()?;
                    let next_cursor = (rows.len() > limit as usize).then(|| rows[limit as usize - 1].draft_id.clone());
                    let drafts = rows.into_iter().take(limit as usize).filter(|row| authorize_source(connection, context, &self.library_id, &row.document_id).is_ok()).collect();
                    let pending_documents = connection.prepare("SELECT document_id FROM document_recovery_drafts WHERE library_id = ?1 AND (?2 IS NULL OR document_id = ?2) AND resolution IS NULL")?.query_map(params![self.library_id, document_id], |row| row.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
                    let pending_count = pending_documents.iter().filter(|id| authorize_source(connection, context, &self.library_id, id).is_ok()).count() as u32;
                    RecoveryReadValue::List { page: RecoveryDraftPage { drafts, next_cursor, pending_count } }
                },
                RecoveryRead::Inspect { ref draft_id } => {
                    let (summary, capture) = load_draft(connection, context, &self.library_id, draft_id)?;
                    RecoveryReadValue::Inspect { inspection: Box::new(inspect(connection, context, summary, capture)?) }
                },
            };
            Ok(ModuleReadSnapshot { contract_version: OWNED_DOCUMENT_CONTRACT_VERSION, store_epoch: StoreEpoch(read_store_epoch(connection)?), commit_head: read_local_commit_head(connection)?, authorization: None, value: OwnedDocumentReadValue::Recovery { value } })
        }).map_err(core_error)
    }

    pub(super) fn capture_recovery(
        &self,
        context: &BoundModuleContext,
        operation_id: String,
        epoch: StoreEpoch,
        capture: RecoveryDraftCapture,
    ) -> Result<OwnedDocumentApplyOutcome, CoreError> {
        let payload =
            serde_json::to_string(&capture).map_err(|_| invalid("Invalid recovery package"))?;
        if payload.len() > MAX_DRAFT_BYTES
            || capture.draft_id.is_empty()
            || capture.draft_id.len() > 512
            || capture.document_id.is_empty()
            || capture.generation < 1
            || capture.base_head_seq < 0
            || capture.created_at.len() > 64
        {
            return Err(invalid(
                "Recovery package exceeds its bounds or has an invalid identity",
            ));
        }
        let payload_hash = sha256(payload.as_bytes());
        let context = context.clone();
        let library_id = self.library_id.clone();
        let fail_after_commit = self.fail_after_commit.clone();
        self.writer.call(move |connection| {
            let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            require_epoch(&tx, &epoch)?;
            let source = authorize_source(&tx, &context, &library_id, &capture.document_id)?;
            if source.is_none() && capture.source_store_epoch != epoch.0 {
                return Err(invalid_store("This local draft has no verified source in this Library. Its original local copy has been retained."));
            }
            if let Some(result) = replay(&tx, &operation_id, &payload_hash)? { return Ok(result); }
            if let Some(existing) = find_summary(&tx, &library_id, &capture.draft_id)? {
                if existing.payload_hash != payload_hash { return Err(StoreError::new(StoreErrorCode::IdempotencyKeyReused, "This recovery identity already contains different edits", false)); }
                let mut result = metadata_result(&tx, &operation_id, &epoch.0, &capture, existing)?;
                insert_typed_receipt(&tx, &context, &operation_id, &payload_hash, &epoch.0, "capture_recovery", &mut result.committed, None)?;
                tx.commit()?;
                return Ok(result);
            }
            prune_resolved(&tx, &library_id)?;
            let (count, bytes): (i64, i64) = tx.query_row("SELECT count(*), COALESCE(sum(byte_length), 0) + COALESCE((SELECT sum(length(CAST(snapshot_json AS BLOB))) FROM document_recovery_file_snapshots WHERE library_id = ?1), 0) FROM document_recovery_drafts WHERE library_id = ?1", [&library_id], |row| Ok((row.get(0)?, row.get(1)?)))?;
            if count >= MAX_LIBRARY_DRAFTS || bytes + payload.len() as i64 > MAX_LIBRARY_DRAFT_BYTES { return Err(invalid_store("Recovery storage is full. Keep or export the local draft before continuing.")); }
            let now = sqlite_now(&tx)?;
            let result = durable_mutation::run(&tx, OperationIdentity { module: ModuleName::OwnedDocument, module_name: MODULE_NAME, operation_id: &operation_id, intent_hash: &payload_hash, store_epoch: &epoch.0, committed_at: &now, context: &context }, |scope| {
                tx.execute("INSERT INTO document_recovery_drafts(library_id, draft_id, document_id, source_store_epoch, generation, created_at, received_at, payload_json, payload_hash, byte_length) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)", params![library_id, capture.draft_id, capture.document_id, capture.source_store_epoch, capture.generation, capture.created_at, now, payload, payload_hash, payload.len() as i64])?;
                let retained_file_ids = retained_file_uses(&tx, &capture);
                let companion_bytes = super::super::recovery_files::capture(&tx, &context, &capture.document_id, &capture.draft_id, retained_file_ids)?;
                let total_bytes = payload.len().checked_add(companion_bytes).ok_or_else(|| invalid_store("Recovery package is too large"))?;
                if total_bytes > MAX_DRAFT_BYTES || bytes + total_bytes as i64 > MAX_LIBRARY_DRAFT_BYTES {
                    return Err(invalid_store("Recovery storage is full. Keep or export the local draft before continuing."));
                }
                let summary = find_summary(&tx, &library_id, &capture.draft_id)?.ok_or_else(|| internal("Recovery draft disappeared"))?;
                let analysis = inspect(&tx, &context, summary.clone(), capture.clone())?;
                let summary = if analysis.already_saved { set_resolution(&tx, &library_id, &capture.draft_id, summary.revision, Some(RecoveryResolution::AlreadySaved), &operation_id, None)? } else { summary };
                retain_assets(&tx, &library_id, &capture, &analysis)?;
                let event = record_change(scope, &context, &library_id, &capture.document_id, capture.generation)?;
                let mut result = metadata_result(&tx, &operation_id, &epoch.0, &capture, summary)?.committed;
                result.event_sequence = event;
                seal_typed_receipt(scope, "capture_recovery", result, Some(event))
            })?;
            let committed = resolve_typed_commit(result);
            tx.commit()?;
            if fail_after_commit.swap(false, Ordering::SeqCst) { return Err(internal("Injected failure after recovery commit")); }
            Ok(OwnedDocumentApplyOutcome { committed, events: Vec::new() })
        }).map_err(core_error)
    }

    pub(super) fn resolve_recovery(
        &self,
        context: &BoundModuleContext,
        operation_id: String,
        epoch: StoreEpoch,
        resolve: RecoveryDraftResolve,
    ) -> Result<OwnedDocumentApplyOutcome, CoreError> {
        if matches!(resolve.choice, RecoveryChoice::Restore) {
            return self.restore_recovery(context, operation_id, epoch, resolve);
        }
        if matches!(resolve.choice, RecoveryChoice::Copy) {
            return self.copy_recovery(context, operation_id, epoch, resolve);
        }
        let context = context.clone();
        let library_id = self.library_id.clone();
        let request_hash =
            hash_serializable(&resolve, "Recovery resolution cannot be fingerprinted")
                .map_err(core_error)?;
        self.writer
            .call(move |connection| {
                let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
                require_epoch(&tx, &epoch)?;
                let (summary, capture) = load_draft(&tx, &context, &library_id, &resolve.draft_id)?;
                if let Some(result) = replay(&tx, &operation_id, &request_hash)? {
                    return Ok(result);
                }
                require_revision(&summary, &resolve)?;
                let resolution = match resolve.choice {
                    RecoveryChoice::Discard if summary.resolution.is_none() => {
                        Some(RecoveryResolution::Discarded)
                    }
                    RecoveryChoice::Reopen
                        if summary.resolution == Some(RecoveryResolution::Discarded) =>
                    {
                        None
                    }
                    RecoveryChoice::Reconcile if summary.resolution.is_none() => {
                        if !inspect(&tx, &context, summary.clone(), capture.clone())?.already_saved
                        {
                            let mut result =
                                metadata_result(&tx, &operation_id, &epoch.0, &capture, summary)?;
                            insert_typed_receipt(
                                &tx,
                                &context,
                                &operation_id,
                                &request_hash,
                                &epoch.0,
                                "reconcile_recovery",
                                &mut result.committed,
                                None,
                            )?;
                            tx.commit()?;
                            return Ok(result);
                        }
                        Some(RecoveryResolution::AlreadySaved)
                    }
                    _ => {
                        return Err(conflict(
                            "This draft has already been handled. Refresh to see its result.",
                        ));
                    }
                };
                let now = sqlite_now(&tx)?;
                let result = durable_mutation::run(
                    &tx,
                    OperationIdentity {
                        module: ModuleName::OwnedDocument,
                        module_name: MODULE_NAME,
                        operation_id: &operation_id,
                        intent_hash: &request_hash,
                        store_epoch: &epoch.0,
                        committed_at: &now,
                        context: &context,
                    },
                    |scope| {
                        let summary = set_resolution(
                            &tx,
                            &library_id,
                            &resolve.draft_id,
                            resolve.revision,
                            resolution,
                            &operation_id,
                            None,
                        )?;
                        let event = record_change(
                            scope,
                            &context,
                            &library_id,
                            &capture.document_id,
                            capture.generation,
                        )?;
                        let mut result =
                            metadata_result(&tx, &operation_id, &epoch.0, &capture, summary)?
                                .committed;
                        result.event_sequence = event;
                        seal_typed_receipt(scope, "resolve_recovery", result, Some(event))
                    },
                )?;
                let committed = resolve_typed_commit(result);
                tx.commit()?;
                Ok(OwnedDocumentApplyOutcome {
                    committed,
                    events: Vec::new(),
                })
            })
            .map_err(core_error)
    }
}

fn require_epoch(connection: &Connection, epoch: &StoreEpoch) -> Result<(), StoreError> {
    if read_store_epoch(connection)? == epoch.0 {
        return Ok(());
    }
    Err(StoreError::new(
        StoreErrorCode::StaleStoreEpoch,
        "Recovery request belongs to a different Library world",
        false,
    ))
}

fn authorize_source(
    connection: &Connection,
    context: &BoundModuleContext,
    library_id: &str,
    document_id: &str,
) -> Result<Option<DocumentAuthorityRow>, StoreError> {
    let authority = read_document_authority(connection, document_id)?;
    if let Some(authority) = &authority {
        if authority.head.library_id != library_id {
            return Err(not_found("Recovery document was not found"));
        }
        if context.project_id.is_some() {
            authorize_document_access(connection, context, authority, DocumentAccessKind::Read)?;
        }
        return Ok(Some(authority.clone()));
    }
    if context.project_id.is_some() {
        return Err(not_found(
            "Recovery document is unavailable in this Project",
        ));
    }
    Ok(None)
}

pub(crate) fn resolve_recovery_file_target(
    connection: &Connection,
    context: &BoundModuleContext,
    document_id: &str,
    draft_id: &str,
    file_id: &str,
) -> Result<crate::domain::files::FileSnapshotTarget, StoreError> {
    let (_, capture) = load_draft(connection, context, &context.library_id.0, draft_id)?;
    if capture.document_id != document_id {
        return Err(not_found("Recovery File source was not found"));
    }
    super::super::recovery_files::load(connection, &context.library_id.0, draft_id)?
        .and_then(|snapshot| snapshot.target(file_id))
        .ok_or_else(|| not_found("Recovery draft has no exact target for this File"))
}

pub(crate) fn resolve_recovery_canvas_file_target(
    connection: &Connection,
    context: &BoundModuleContext,
    document_id: &str,
    draft_id: &str,
    scene_file_id: &str,
    file_id: &str,
) -> Result<crate::domain::files::FileSnapshotTarget, StoreError> {
    let (_, capture) = load_draft(connection, context, &context.library_id.0, draft_id)?;
    if capture.document_id != document_id {
        return Err(not_found("Recovery Canvas source was not found"));
    }
    super::super::recovery_files::load(connection, &context.library_id.0, draft_id)?
        .and_then(|snapshot| snapshot.canvas_target(scene_file_id, file_id))
        .ok_or_else(|| not_found("Recovery Canvas slot has no exact target for this File"))
}

fn read_summary(row: &rusqlite::Row<'_>) -> rusqlite::Result<RecoveryDraftSummary> {
    let resolution: Option<String> = row.get(7)?;
    let resolution = resolution
        .map(|value| {
            serde_json::from_value(Value::String(value)).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    7,
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })
        })
        .transpose()?;
    Ok(RecoveryDraftSummary {
        draft_id: row.get(0)?,
        document_id: row.get(1)?,
        revision: row.get(2)?,
        created_at: row.get(3)?,
        received_at: row.get(4)?,
        byte_length: row.get(5)?,
        payload_hash: row.get(6)?,
        resolution,
        resolved_at: row.get(8)?,
        target_owner_id: row.get(9)?,
        target_document_id: row.get(10)?,
        source_title: row.get(11)?,
    })
}

fn find_summary(
    connection: &Connection,
    library_id: &str,
    draft_id: &str,
) -> Result<Option<RecoveryDraftSummary>, StoreError> {
    Ok(connection.query_row(&format!("SELECT {SUMMARY_COLUMNS} FROM document_recovery_drafts WHERE library_id = ?1 AND draft_id = ?2"), params![library_id, draft_id], read_summary).optional()?)
}

fn load_draft(
    connection: &Connection,
    context: &BoundModuleContext,
    library_id: &str,
    draft_id: &str,
) -> Result<(RecoveryDraftSummary, RecoveryDraftCapture), StoreError> {
    let summary = find_summary(connection, library_id, draft_id)?
        .ok_or_else(|| not_found("Recovery draft was not found"))?;
    authorize_source(connection, context, library_id, &summary.document_id)?;
    let payload: String = connection.query_row(
        "SELECT payload_json FROM document_recovery_drafts WHERE library_id = ?1 AND draft_id = ?2",
        params![library_id, draft_id],
        |row| row.get(0),
    )?;
    if sha256(payload.as_bytes()) != summary.payload_hash {
        return Err(StoreError::new(
            StoreErrorCode::StoreCorrupt,
            "Recovery draft failed its integrity check",
            false,
        ));
    }
    let capture = serde_json::from_str(&payload)
        .map_err(|_| internal("Stored recovery package is invalid"))?;
    Ok((summary, capture))
}

fn require_revision(
    summary: &RecoveryDraftSummary,
    resolve: &RecoveryDraftResolve,
) -> Result<(), StoreError> {
    if summary.revision == resolve.revision {
        return Ok(());
    }
    Err(conflict(
        "This draft changed in another window. Refresh to see its result.",
    ))
}

fn set_resolution(
    connection: &Connection,
    library_id: &str,
    draft_id: &str,
    revision: i64,
    resolution: Option<RecoveryResolution>,
    operation_id: &str,
    target: Option<(&str, &str)>,
) -> Result<RecoveryDraftSummary, StoreError> {
    let value = resolution.map(|value| {
        serde_json::to_value(value)
            .expect("resolution enum")
            .as_str()
            .expect("resolution string")
            .to_owned()
    });
    let changed = connection.execute("UPDATE document_recovery_drafts SET revision = revision + 1, resolution = ?1, resolved_at = CASE WHEN ?1 IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ','now') END, resolution_operation_id = ?2, target_owner_id = ?3, target_document_id = ?4 WHERE library_id = ?5 AND draft_id = ?6 AND revision = ?7", params![value, operation_id, target.map(|t| t.0), target.map(|t| t.1), library_id, draft_id, revision])?;
    if changed != 1 {
        return Err(conflict("This draft was handled in another window"));
    }
    find_summary(connection, library_id, draft_id)?
        .ok_or_else(|| internal("Recovery draft disappeared"))
}

pub(super) fn prune_resolved(connection: &Connection, library_id: &str) -> Result<(), StoreError> {
    connection.execute("DELETE FROM document_recovery_drafts WHERE library_id = ?1 AND draft_id IN (SELECT draft_id FROM document_recovery_drafts WHERE library_id = ?1 AND resolution IS NOT NULL AND julianday(resolved_at) < julianday('now','-30 days') ORDER BY resolved_at LIMIT 32)", [library_id])?;
    Ok(())
}

fn metadata_result(
    connection: &Connection,
    operation_id: &str,
    epoch: &str,
    capture: &RecoveryDraftCapture,
    summary: RecoveryDraftSummary,
) -> Result<OwnedDocumentApplyOutcome, StoreError> {
    Ok(OwnedDocumentApplyOutcome {
        committed: crate::ModuleWriterResult {
            value: OwnedDocumentCommitValue {
                recovery: Some(summary),
                document_id: capture.document_id.clone(),
                generation: capture.generation,
                head_seq: capture.base_head_seq,
                outcome: DocumentCommitOutcome::Committed,
                committed_at: Some(sqlite_now(connection)?),
                canvas: None,
                owner_effect: None,
                checkpoint_effect: None,
                mutation_effect: None,
                semantic_etags: None,
                semantic_block_etags: None,
                semantic_local_block_ids: None,
                semantic_deleted_owner_block_ids: None,
            },
            receipt: OwnedDocumentReceipt {
                mutation: ModuleMutationReceipt {
                    operation_id: operation_id.to_owned(),
                    duplicate: false,
                },
                document_id: capture.document_id.clone(),
                generation: capture.generation,
                head_seq: capture.base_head_seq,
            },
            store_epoch: StoreEpoch(epoch.to_owned()),
            commit_seq: read_local_commit_head(connection)?,
            event_sequence: read_event_head(connection)?,
        },
        events: Vec::new(),
    })
}

fn replay(
    connection: &Connection,
    operation_id: &str,
    hash: &str,
) -> Result<Option<OwnedDocumentApplyOutcome>, StoreError> {
    let Some(stored) = read_module_receipt(connection, MODULE_NAME, operation_id)? else {
        return Ok(None);
    };
    if stored.request_hash != hash {
        return Err(StoreError::new(
            StoreErrorCode::IdempotencyKeyReused,
            "Recovery operation identity was reused",
            false,
        ));
    }
    let mut committed: OwnedDocumentWriterResult =
        serde_json::from_value(stored.result).map_err(|_| internal("Invalid recovery receipt"))?;
    committed.receipt.mutation.duplicate = true;
    Ok(Some(OwnedDocumentApplyOutcome {
        committed,
        events: Vec::new(),
    }))
}

fn record_change(
    scope: &DurableMutationScope<'_>,
    context: &BoundModuleContext,
    library_id: &str,
    document_id: &str,
    generation: i64,
) -> Result<i64, StoreError> {
    let actor = context
        .project_id
        .as_ref()
        .map(|id| Ok(id.0.clone()))
        .unwrap_or_else(|| {
            crate::library::resolve_library_actor_project_id(scope.connection(), library_id)
        })?;
    let detached = read_document_authority(scope.connection(), document_id)?.is_none();
    let payload = serde_json::json!({ "module": "owned_document", "kind": "recovery_changed", "documentId": document_id, "generation": generation, "headSeq": 0, "detached": detached });
    append_change_log(
        scope.connection(),
        NewChangeLogEntry {
            project_id: &actor,
            store_epoch: scope.store_epoch(),
            kind: "owned_document.recovery_changed",
            operation_id: Some(scope.evidence().operation_id()),
            block_ids: &[],
            document_ids: &[document_id.to_owned()],
            database_block_ids: &[],
            payload_json: &payload.to_string(),
            projection_impact: &ProjectionImpact::None,
            committed_at: scope.committed_at(),
        },
        scope.evidence(),
    )
}

fn preview(materialization: &DocumentMaterialization) -> RecoveryPreview {
    RecoveryPreview::Document {
        title: materialization.title.clone(),
        rich_title: serde_json::to_value(&materialization.rich_title)
            .expect("serializable rich title"),
        nfm: materialization.nfm.clone(),
        files: Default::default(),
    }
}

fn inspect(
    connection: &Connection,
    context: &BoundModuleContext,
    summary: RecoveryDraftSummary,
    capture: RecoveryDraftCapture,
) -> Result<RecoveryDraftInspection, StoreError> {
    let authority = read_document_authority(connection, &capture.document_id)?;
    let mut result = RecoveryDraftInspection {
        summary,
        capture,
        current: None,
        retained: None,
        restored: None,
        current_generation: authority.as_ref().map(|a| a.head.generation),
        current_head_seq: authority.as_ref().map(|a| a.head.head_seq),
        already_saved: false,
        can_restore: false,
        can_copy: false,
        explanation: None,
    };
    let analysis = analyse_content(connection, context, authority.as_ref(), &mut result);
    if let Err(error) = analysis {
        result.explanation = Some(format!(
            "The retained bytes are safe, but a complete preview is unavailable: {error}"
        ));
        result.can_restore = false;
        result.can_copy = false;
        result.already_saved = false;
    }
    if result.can_restore {
        result.explanation = None;
    }
    if result.summary.resolution.is_some() {
        result.can_restore = false;
        result.can_copy = false;
    }
    Ok(result)
}

fn analyse_content(
    connection: &Connection,
    context: &BoundModuleContext,
    authority: Option<&DocumentAuthorityRow>,
    result: &mut RecoveryDraftInspection,
) -> Result<(), StoreError> {
    let capture = &result.capture;
    let same_boundary = authority.is_some_and(|a| {
        a.head.generation == capture.generation
            && a.head.schema_key == capture.schema_key
            && a.head.schema_version == capture.schema_version
    }) && read_store_epoch(connection)? == capture.source_store_epoch;
    match &capture.content {
        RecoveryDraftContent::Yjs {
            state,
            unintegrated_updates,
        } => {
            let schema =
                BlockDocumentSchema::from_identity(&capture.schema_key, capture.schema_version)
                    .ok_or_else(|| invalid_store("Unsupported retained document schema"))?;
            let retained = decode_retained_yjs(&capture.document_id, state, unintegrated_updates)?;
            let retained_materialization = materialize_engine(&retained, schema)?;
            let retained_bindings =
                retained_body_bindings(connection, context, capture, &retained_materialization)?;
            let mut retained_preview = preview(&retained_materialization);
            set_preview_files(&mut retained_preview, retained_bindings.clone());
            result.retained = Some(retained_preview);
            let file_snapshot = retained_file_snapshot(
                connection,
                &context.library_id.0,
                &capture.draft_id,
                &retained_materialization,
            )?;
            result.can_copy = copy_is_complete(&retained_materialization, file_snapshot.as_ref());
            if !result.can_copy {
                result.explanation = Some("This draft references owned content or files that are not included in its retained package. You can export it without discarding the draft.".to_owned());
            }
            let Some(authority) = authority else {
                return Ok(());
            };
            if authority.head.sync_engine != DocumentSyncEngine::Yjs {
                return Ok(());
            }
            let mut cache = DocumentRuntimeCache::new();
            let engine = cache.clone_engine(connection, &authority.head)?;
            let current_schema = BlockDocumentSchema::from_identity(
                &authority.head.schema_key,
                authority.head.schema_version,
            )
            .ok_or_else(|| invalid_store("Unsupported current document schema"))?;
            let current_materialization = materialize_engine(&engine, current_schema)?;
            let current_bindings =
                current_body_bindings(connection, context, authority, &current_materialization)?;
            let mut current_preview = preview(&current_materialization);
            set_preview_files(&mut current_preview, current_bindings.clone());
            result.current = Some(current_preview);
            if !same_boundary {
                if result.can_copy {
                    result.explanation = Some("This draft belongs to an earlier document. Save a copy to keep the current content.".to_owned());
                }
                return Ok(());
            }
            // Snapshot comparison includes deletion sets and every shared type; pending dependencies fail above.
            let candidate = engine
                .prepare_update_v1(&retained.full_state_v1())
                .map_err(engine_error)?;
            let files_unchanged = file_snapshot
                .as_ref()
                .map(|snapshot| {
                    crate::library::plan_file_restore(
                        connection,
                        &context.library_id.0,
                        "recovery-inspection",
                        snapshot,
                    )
                    .map(|plan| plan.mapping.iter().all(|(source, target)| source == target))
                })
                .transpose()?
                .unwrap_or(false);
            result.already_saved = !candidate.did_change() && files_unchanged;
            let materialization = materialize_candidate(&candidate, schema)?;
            let retained_ids = retained_materialization.file_ids();
            let restored_bindings = merged_body_bindings(
                &materialization.file_ids(),
                &retained_ids,
                &retained_bindings,
                &current_bindings,
            );
            let mut restored_preview = preview(&materialization);
            set_preview_files(&mut restored_preview, restored_bindings);
            result.restored = Some(restored_preview);
            let barrier: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM document_structural_barriers WHERE document_id = ?1 AND generation = ?2 AND head_seq > ?3)", params![capture.document_id, capture.generation, capture.base_head_seq], |row| row.get(0))?;
            result.can_restore = file_snapshot.is_some()
                && !barrier
                && capture.base_head_seq <= authority.head.head_seq
                && authorize_yjs(connection, context, authority, DocumentAccessKind::Write).is_ok()
                && ownership_unchanged(&current_materialization, &materialization);
            if barrier && result.can_copy {
                result.explanation = Some("The document structure changed after these edits. Save a copy to keep both versions.".to_owned());
            }
        }
        RecoveryDraftContent::Canvas { scene, mutations } => {
            let file_snapshot = super::super::recovery_files::load(
                connection,
                &context.library_id.0,
                &capture.draft_id,
            )?;
            if let Some(scene) = scene {
                let scene = retained_canvas(scene, mutations)?;
                result.can_copy = scene.page_references.is_empty()
                    && file_snapshot
                        .as_ref()
                        .is_some_and(|snapshot| snapshot.covers_canvas(&scene));
                if !result.can_copy {
                    result.explanation = Some("This Canvas draft references files or Pages that are not included in its retained package. You can export it without discarding the draft.".to_owned());
                }
                result.retained = Some(RecoveryPreview::Canvas {
                    scene: scene.canonical_value(),
                    files: canvas_preview_bindings(capture, &scene, file_snapshot.as_ref(), None),
                });
            }
            let Some(authority) =
                authority.filter(|a| a.head.sync_engine == DocumentSyncEngine::CanvasScene)
            else {
                return Ok(());
            };
            let current = load_canvas_scene(connection, authority)?.scene;
            result.current = Some(RecoveryPreview::Canvas {
                scene: current.canonical_value(),
                files: canvas_preview_bindings(
                    capture,
                    &current,
                    None,
                    Some((authority, &current)),
                ),
            });
            if !same_boundary {
                if result.can_copy {
                    result.explanation = Some("This draft belongs to an earlier Canvas. Save a copy to keep the current content.".to_owned());
                }
                return Ok(());
            }
            let mut restored = current.clone();
            let mut exact = true;
            for mutation in mutations {
                let mutation = parse_canvas_mutation(mutation)?;
                let Some(mutation) = file_snapshot
                    .as_ref()
                    .map(|snapshot| {
                        snapshot.prepare_canvas_mutation(
                            connection,
                            &context.library_id.0,
                            &restored,
                            &mutation,
                        )
                    })
                    .transpose()?
                    .flatten()
                else {
                    result.explanation = Some("A retained image slot changed after these edits. Save a copy to preserve the captured image.".to_owned());
                    return Ok(());
                };
                let applied = match apply_canvas_mutation(&restored, &mutation) {
                    Ok(applied) => applied,
                    Err(error) if error.code == StoreErrorCode::InvalidInput => {
                        result.explanation = Some("This Canvas draft conflicts with the current scene. Its retained copy remains available.".to_owned());
                        return Ok(());
                    }
                    Err(error) => return Err(error),
                };
                exact &=
                    mutation
                        .app_state_intents
                        .iter()
                        .all(|(key, intent)| match &intent.value {
                            crate::document::canvas_scene::OptionalJson::Absent => {
                                !applied.scene.app_state.contains_key(key)
                            }
                            crate::document::canvas_scene::OptionalJson::Value(value) => {
                                applied.scene.app_state.get(key) == Some(value)
                            }
                        })
                        && mutation.element_candidates.iter().all(|wanted| {
                            applied.scene.elements.iter().any(|actual| {
                                actual.id == wanted.id && actual.value == wanted.value
                            })
                        });
                restored = applied.scene;
            }
            // Full-scene equality is sufficient only when it covers every retained intent and snapshot.
            let snapshot_covered = match &result.retained {
                Some(RecoveryPreview::Canvas { scene, .. }) => {
                    parse_canvas_scene(scene)? == current
                }
                _ => true,
            };
            result.already_saved = exact && restored == current && snapshot_covered;
            result.can_restore = exact
                && !mutations.is_empty()
                && authorize_canvas(connection, context, authority, DocumentAccessKind::Write)
                    .is_ok();
            result.restored = Some(RecoveryPreview::Canvas {
                scene: restored.canonical_value(),
                files: canvas_preview_bindings(
                    capture,
                    &restored,
                    file_snapshot.as_ref(),
                    Some((authority, &current)),
                ),
            });
            if result.retained.is_none() && exact {
                result.retained = result.restored.clone();
            }
            if !exact {
                result.explanation = Some("Some Canvas elements changed after these edits. The retained draft remains available for review and export.".to_owned());
            }
        }
    }
    Ok(())
}

fn decode_retained_yjs(
    document_id: &str,
    state: &[u8],
    updates: &[Vec<u8>],
) -> Result<super::super::YrsDocumentEngine, StoreError> {
    let mut retained = super::super::YrsDocumentEngine::from_full_state_v1(document_id, state)
        .map_err(engine_error)?;
    for update in updates {
        let candidate = retained.prepare_update_v1(update).map_err(engine_error)?;
        retained.commit_candidate(candidate).map_err(engine_error)?;
    }
    Ok(retained)
}

/// Preserve intended values even when normal convergence chooses a newer canonical element.
/// This candidate is only for an explicit independent copy, never for overwriting current content.
fn retained_canvas(
    scene: &Value,
    mutations: &[Value],
) -> Result<crate::document::canvas_scene::CanvasScene, StoreError> {
    let base = parse_canvas_scene(scene)?;
    let mut elements: std::collections::BTreeMap<_, _> = base
        .elements
        .into_iter()
        .map(|element| (element.id.clone(), element))
        .collect();
    let mut app_state = base.app_state;
    let mut files = base.files;
    for mutation in mutations {
        let mutation = parse_canvas_mutation(mutation)?;
        for element in mutation.element_candidates {
            elements.insert(element.id.clone(), element);
        }
        for (key, intent) in mutation.app_state_intents {
            match intent.value {
                crate::document::canvas_scene::OptionalJson::Absent => {
                    app_state.remove(&key);
                }
                crate::document::canvas_scene::OptionalJson::Value(value) => {
                    app_state.insert(key, value);
                }
            }
        }
        for (id, file) in mutation.file_additions {
            files.insert(id, file);
        }
    }
    let mut elements: Vec<_> = elements.into_values().collect();
    elements.sort_by(|a, b| a.order_key.cmp(&b.order_key).then_with(|| a.id.cmp(&b.id)));
    crate::document::canvas_scene::materialize_loaded_scene(
        elements,
        &Value::Object(app_state),
        files,
    )
}

fn copy_is_complete(
    materialization: &DocumentMaterialization,
    snapshot: Option<&crate::domain::files::FileSnapshotManifest>,
) -> bool {
    owned_ids(materialization).is_empty()
        && materialization.asset_refs.iter().all(|reference| {
            reference
                .file_id
                .as_ref()
                .is_some_and(|id| snapshot.is_some_and(|snapshot| snapshot.files.contains_key(id)))
        })
}
fn owned_ids(materialization: &DocumentMaterialization) -> BTreeSet<String> {
    fn visit(
        nodes: &[crate::domain::block_materialization::MaterializedBlockNode],
        result: &mut BTreeSet<String>,
    ) {
        for node in nodes {
            if TYPED_CREATION_BLOCK_TYPES.contains(&node.block_type.as_str()) {
                result.insert(node.id.clone());
            }
            visit(&node.children, result);
        }
    }
    let mut result = BTreeSet::new();
    visit(&materialization.block_tree, &mut result);
    result
}
fn ownership_unchanged(before: &DocumentMaterialization, after: &DocumentMaterialization) -> bool {
    owned_ids(before) == owned_ids(after)
}

fn retained_file_uses(
    connection: &Connection,
    capture: &RecoveryDraftCapture,
) -> super::super::recovery_files::RetainedFileUses {
    use super::super::recovery_files::RetainedFileUses as Uses;
    let uses = (|| -> Result<Uses, StoreError> {
        match &capture.content {
            RecoveryDraftContent::Yjs {
                state,
                unintegrated_updates,
            } => {
                let schema =
                    BlockDocumentSchema::from_identity(&capture.schema_key, capture.schema_version)
                        .ok_or_else(|| invalid_store("Recovery schema is unavailable"))?;
                let engine =
                    decode_retained_yjs(&capture.document_id, state, unintegrated_updates)?;
                Ok(Uses::Body(materialize_engine(&engine, schema)?.file_ids()))
            }
            RecoveryDraftContent::Canvas { scene, mutations } => {
                let base = match scene {
                    Some(scene) => scene.clone(),
                    None => match read_document_authority(connection, &capture.document_id)? {
                        Some(authority)
                            if authority.head.sync_engine == DocumentSyncEngine::CanvasScene =>
                        {
                            load_canvas_scene(connection, &authority)?
                                .scene
                                .canonical_value()
                        }
                        _ => crate::document::CanvasScene::empty().canonical_value(),
                    },
                };
                Ok(Uses::Canvas(
                    retained_canvas(&base, mutations)?
                        .files
                        .into_values()
                        .collect(),
                ))
            }
        }
    })();
    uses.unwrap_or(Uses::Unresolved)
}

fn retained_file_snapshot(
    connection: &Connection,
    library_id: &str,
    draft_id: &str,
    materialization: &DocumentMaterialization,
) -> Result<Option<crate::domain::files::FileSnapshotManifest>, StoreError> {
    let snapshot = super::super::recovery_files::load(connection, library_id, draft_id)?;
    if materialization.file_ids().is_empty() {
        return Ok(Some(Default::default()));
    }
    let Some(snapshot) = snapshot.and_then(|snapshot| snapshot.exact()) else {
        return Ok(None);
    };
    if snapshot.files.keys().cloned().collect::<Vec<_>>() != materialization.file_ids() {
        return Err(StoreError::new(
            StoreErrorCode::StoreCorrupt,
            "Recovery File snapshot does not cover the retained content",
            false,
        ));
    }
    Ok(Some(snapshot))
}

fn retain_assets(
    connection: &Connection,
    library_id: &str,
    capture: &RecoveryDraftCapture,
    analysis: &RecoveryDraftInspection,
) -> Result<(), StoreError> {
    // Root canonical ownership and the retained package's references separately from its bytes.
    connection.execute("INSERT OR IGNORE INTO document_recovery_block_roots SELECT ?1, ?2, block_id FROM block_documents WHERE document_id = ?3 AND library_id = ?1", params![library_id, capture.draft_id, capture.document_id])?;
    if let Some(RecoveryPreview::Document { .. }) = &analysis.retained {
        let schema =
            BlockDocumentSchema::from_identity(&capture.schema_key, capture.schema_version);
        if let (
            Some(schema),
            RecoveryDraftContent::Yjs {
                state,
                unintegrated_updates,
            },
        ) = (schema, &capture.content)
        {
            let engine = decode_retained_yjs(&capture.document_id, state, unintegrated_updates)?;
            let materialization = materialize_engine(&engine, schema)?;
            for id in owned_ids(&materialization) {
                connection.execute("INSERT OR IGNORE INTO document_recovery_block_roots SELECT ?1, ?2, id FROM blocks WHERE id = ?3 AND library_id = ?1", params![library_id, capture.draft_id, id])?;
            }
            for asset in materialization.asset_refs {
                if let Some(name) = asset.managed_file_name {
                    connection.execute("INSERT OR IGNORE INTO document_recovery_asset_roots SELECT ?1, ?2, content_hash FROM managed_blobs WHERE physical_asset_name = ?3", params![library_id, capture.draft_id, name])?;
                }
                if let Some(file_id) = asset.file_id {
                    connection.execute("INSERT OR IGNORE INTO document_recovery_asset_roots SELECT ?1, ?2, version.blob_hash FROM document_recovery_file_refs reference JOIN file_versions version ON version.file_id = reference.file_id AND version.version = reference.file_version AND version.library_id = reference.library_id WHERE reference.library_id = ?1 AND reference.draft_id = ?2 AND reference.file_id = ?3", params![library_id, capture.draft_id, file_id])?;
                }
            }
        }
    }
    connection.execute("INSERT OR IGNORE INTO document_recovery_asset_roots SELECT ?1, ?2, version.blob_hash FROM document_recovery_file_refs reference JOIN file_versions version ON version.file_id = reference.file_id AND version.version = reference.file_version AND version.library_id = reference.library_id WHERE reference.library_id = ?1 AND reference.draft_id = ?2", params![library_id, capture.draft_id])?;
    // Canonical resource evidence is copied while the source is authorized; no arbitrary filesystem reads.
    connection.execute("INSERT OR IGNORE INTO document_recovery_asset_roots(library_id, draft_id, asset_hash) SELECT ?1, ?2, asset_hash FROM block_asset_refs WHERE document_id = ?3 AND asset_hash IS NOT NULL", params![library_id, capture.draft_id, capture.document_id])?;
    connection.execute("INSERT OR IGNORE INTO document_recovery_asset_roots(library_id, draft_id, asset_hash) SELECT ?1, ?2, asset_hash FROM canvas_scene_file_refs WHERE document_id = ?3 AND asset_hash IS NOT NULL", params![library_id, capture.draft_id, capture.document_id])?;
    Ok(())
}

fn invalid_store(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message.into(), false)
}
fn conflict(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::RevisionConflict, message, false)
}

/// Merge the retained Yjs state first, then remap File occurrences on that
/// candidate. Emitting the resulting state preserves the retained causal edits.
fn prepare_recovery_update(
    connection: &Connection,
    context: &BoundModuleContext,
    authority: &DocumentAuthorityRow,
    engine: &YrsDocumentEngine,
    capture: &RecoveryDraftCapture,
    operation_id: &str,
) -> Result<
    (
        Vec<u8>,
        DocumentMaterialization,
        crate::library::FileRestorePlan,
    ),
    StoreError,
> {
    let RecoveryDraftContent::Yjs {
        state,
        unintegrated_updates,
    } = &capture.content
    else {
        return Err(invalid_store("Recovery engine changed"));
    };
    let retained = decode_retained_yjs(&capture.document_id, state, unintegrated_updates)?;
    let schema = BlockDocumentSchema::from_identity(
        &authority.head.schema_key,
        authority.head.schema_version,
    )
    .ok_or_else(|| invalid_store("Unsupported schema"))?;
    let retained_materialization = materialize_engine(&retained, schema)?;
    let snapshot = retained_file_snapshot(
        connection,
        &context.library_id.0,
        &capture.draft_id,
        &retained_materialization,
    )?
    .ok_or_else(|| conflict("This draft has unresolved File targets"))?;
    let plan = crate::library::plan_file_restore(
        connection,
        &context.library_id.0,
        operation_id,
        &snapshot,
    )?;
    let candidate = engine
        .prepare_update_v1(&retained.full_state_v1())
        .map_err(engine_error)?;
    let mut materialization = materialize_candidate(&candidate, schema)?;
    let candidate_state = candidate
        .document()
        .transact()
        .encode_state_as_update_v1(&yrs::StateVector::default());
    let mut merged = YrsDocumentEngine::from_full_state_v1(&capture.document_id, &candidate_state)
        .map_err(engine_error)?;
    if plan.mapping.iter().any(|(source, target)| source != target) {
        crate::domain::files::remap_block_files(&mut materialization.block_tree, &plan.mapping);
        let remapped = super::super::operations::prepare_document_snapshot_restore_update(
            &capture.document_id,
            schema,
            &merged.full_state_v1(),
            &merged.state_vector_v1(),
            &materialization.block_tree,
            schema
                .has_title()
                .then_some(materialization.rich_title.as_slice()),
        )
        .map_err(|error| invalid_store(error.to_string()))?;
        let changed = merged
            .prepare_update_v1(&remapped.update_v1)
            .map_err(engine_error)?;
        merged.commit_candidate(changed).map_err(engine_error)?;
    }
    let materialization = materialize_engine(&merged, schema)?;
    Ok((merged.full_state_v1(), materialization, plan))
}

impl OwnedDocumentModule {
    fn restore_recovery(
        &self,
        context: &BoundModuleContext,
        operation_id: String,
        epoch: StoreEpoch,
        resolve: RecoveryDraftResolve,
    ) -> Result<OwnedDocumentApplyOutcome, CoreError> {
        let (summary, capture) = self
            .readers
            .read_default(|connection| {
                load_draft(connection, context, &self.library_id, &resolve.draft_id)
            })
            .map_err(core_error)?;
        if matches!(capture.content, RecoveryDraftContent::Canvas { .. }) {
            return self.restore_canvas_recovery(context, operation_id, epoch, resolve);
        }
        let request_hash =
            hash_serializable(&resolve, "Recovery resolution cannot be fingerprinted")
                .map_err(core_error)?;
        let context_for_prepare = context.clone();
        let library_id = self.library_id.clone();
        let generation = resolve
            .expected_generation
            .ok_or_else(|| invalid("A current document preview is required"))?;
        self.apply_document_update(DocumentUpdateJob {
            context: context.clone(), client_session_id: context.connection_id.clone(), operation_id: operation_id.clone(), expected_store_epoch: epoch, document_id: summary.document_id, generation, operation_kind: "restore_recovery", request_hash,
            publication: UpdatePublication::Updated, prepared_agent: None, semantic_block_etag_ids: Vec::new(), include_local_block_etags: false,
            recovery: Some(RecoveryCommit { draft_id: resolve.draft_id.clone(), revision: resolve.revision, resolution: RecoveryResolution::Restored }),
        }, move |connection, authority, engine, materialization, _| {
            let (summary, capture) = load_draft(connection, &context_for_prepare, &library_id, &resolve.draft_id)?;
            require_revision(&summary, &resolve)?;
            require_preview(authority, &resolve)?;
            let analysis = inspect(connection, &context_for_prepare, summary, capture.clone())?;
            if !analysis.can_restore { return Err(conflict("These edits cannot be merged safely. Review the available recovery options.")); }
            let (update, restored, file_restore) = prepare_recovery_update(connection, &context_for_prepare, authority, engine, &capture, &operation_id)?;
            if !engine.prepare_update_v1(&update).map_err(engine_error)?.did_change() { return Ok(PreparedUpdate::NoChange); }
            let placement = derive_document_placement_delta(materialization, &restored);
            let touched = derive_touched_block_ids(&authority.owner_block_id, materialization, &restored, &placement);
            let now = sqlite_now(connection)?;
            insert_document_checkpoint(connection, authority, materialization, NewDocumentCheckpoint { operation_id: &operation_id, cause: "before_restore", label: Some("Before restoring unsaved edits"), revision_kind: "restore", source_mutation_id: Some(&operation_id), source_change_seq: None, actor: None, context: &context_for_prepare, now: &now })?;
            Ok(PreparedUpdate::Apply { file_restore: Some(file_restore), base_head_seq: authority.head.head_seq, update_id: operation_id, touched_block_ids: touched.clone(), update, write_fence_block_ids: touched, placement_attribution: PreparedPlacementAttribution::Collaborative, title_write_fence_required: materialization.rich_title != restored.rich_title, document_write_fence_required: true, mutation_effect: None, semantic_local_block_ids: None })
        }, Some(DocumentCommitCheckpoint { actor: serde_json::json!({"kind":"user"}), cause: "after_restore", label: Some("Restored unsaved edits".to_owned()), revision_kind: "restore" }))
    }

    fn restore_canvas_recovery(
        &self,
        context: &BoundModuleContext,
        operation_id: String,
        epoch: StoreEpoch,
        resolve: RecoveryDraftResolve,
    ) -> Result<OwnedDocumentApplyOutcome, CoreError> {
        let context = context.clone();
        let library_id = self.library_id.clone();
        let assets_root = self.assets_root.clone();
        let request_hash =
            hash_serializable(&resolve, "Recovery resolution cannot be fingerprinted")
                .map_err(core_error)?;
        let fail_after_commit = self.fail_after_commit.clone();
        self.writer
            .call(move |connection| {
                let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
                require_epoch(&tx, &epoch)?;
                let (summary, capture) = load_draft(&tx, &context, &library_id, &resolve.draft_id)?;
                if let Some(result) = replay(&tx, &operation_id, &request_hash)? {
                    return Ok(result);
                }
                require_revision(&summary, &resolve)?;
                let authority = read_document_authority(&tx, &capture.document_id)?
                    .ok_or_else(|| not_found("Canvas was not found"))?;
                require_preview(&authority, &resolve)?;
                let inspection = inspect(&tx, &context, summary, capture.clone())?;
                if !inspection.can_restore {
                    return Err(conflict(
                        "The Canvas changed. Review its recovery options again.",
                    ));
                }
                let Some(RecoveryPreview::Canvas { scene, .. }) = inspection.restored else {
                    return Err(invalid_store("Canvas preview is unavailable"));
                };
                let loaded = load_canvas_scene(&tx, &authority)?;
                let target = parse_canvas_scene(&scene)?;
                let (target, file_plans) = super::super::canvas_files::plan_restore(&tx, &library_id, &operation_id, &target)?;
                let mutation = crate::document::canvas_scene::prepare_canvas_restore(
                    &loaded.scene,
                    &target,
                    &operation_id,
                )?;
                let now = sqlite_now(&tx)?;
                let actor_project_id = context
                    .project_id
                    .as_ref()
                    .map(|id| Ok(id.0.clone()))
                    .unwrap_or_else(|| {
                        crate::library::resolve_library_actor_project_id(&tx, &library_id)
                    })?;
                let result = durable_mutation::run(
                    &tx,
                    OperationIdentity {
                        module: ModuleName::OwnedDocument,
                        module_name: MODULE_NAME,
                        operation_id: &operation_id,
                        intent_hash: &request_hash,
                        store_epoch: &epoch.0,
                        committed_at: &now,
                        context: &context,
                    },
                    |scope| {
                        let restored_files = super::super::canvas_files::apply_restore(scope, &context, &file_plans)?;
                        crate::library::publish_file_restore(scope, &context, &restored_files)?;
                        let mut result = metadata_result(
                            &tx,
                            &operation_id,
                            &epoch.0,
                            &capture,
                            inspection.summary.clone(),
                        )?
                        .committed;
                        if let Some(mutation) = &mutation {
                            insert_canvas_checkpoint(
                                &tx,
                                &authority,
                                &loaded.scene,
                                NewDocumentCheckpoint {
                                    operation_id: &operation_id,
                                    cause: "before_restore",
                                    label: Some("Before restoring unsaved edits"),
                                    revision_kind: "restore",
                                    source_mutation_id: Some(&operation_id),
                                    source_change_seq: None,
                                    actor: None,
                                    context: &context,
                                    now: &now,
                                },
                            )?;
                            let applied = apply_canvas_mutation(&loaded.scene, mutation)?;
                            let persisted = persist_canvas_mutation(
                                &tx,
                                Some(scope.evidence()),
                                &authority,
                                &actor_project_id,
                                &document_access_context(&context),
                                &epoch.0,
                                &operation_id,
                                authority.head.head_seq,
                                &request_hash,
                                mutation,
                                &applied,
                                &assets_root,
                                "document_restored",
                            )?;
                            let mut restored_authority = authority.clone();
                            restored_authority.head.head_seq = persisted.head_seq;
                            restored_authority.head.state_hash = persisted.scene_hash.clone();
                            insert_canvas_checkpoint(
                                &tx,
                                &restored_authority,
                                &applied.scene,
                                NewDocumentCheckpoint {
                                    operation_id: &operation_id,
                                    cause: "after_restore",
                                    label: Some("Restored unsaved edits"),
                                    revision_kind: "restore",
                                    source_mutation_id: Some(&operation_id),
                                    source_change_seq: Some(persisted.event_sequence),
                                    actor: None,
                                    context: &context,
                                    now: &persisted.committed_at,
                                },
                            )?;
                            tx.execute(
                                "DELETE FROM document_revision_sessions WHERE document_id = ?1",
                                [&authority.head.id],
                            )?;
                            result = committed_canvas_value(
                                &operation_id,
                                &epoch.0,
                                &authority,
                                persisted.head_seq,
                                DocumentCommitOutcome::Committed,
                                persisted.event_sequence,
                                persisted.result,
                            );
                        }
                        result.value.recovery = Some(set_resolution(
                            &tx,
                            &library_id,
                            &resolve.draft_id,
                            resolve.revision,
                            Some(RecoveryResolution::Restored),
                            &operation_id,
                            Some((&authority.owner_block_id, &authority.head.id)),
                        )?);
                        let event = record_change(
                            scope,
                            &context,
                            &library_id,
                            &capture.document_id,
                            capture.generation,
                        )?;
                        seal_typed_receipt(scope, "restore_recovery", result, Some(event))
                    },
                )?;
                let committed = resolve_typed_commit(result);
                let sequences = tx.prepare("SELECT seq FROM change_log WHERE store_epoch = ?1 AND operation_id = ?2 ORDER BY seq")?
                    .query_map(params![epoch.0, operation_id], |row| row.get::<_, i64>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
                let events = sequences.into_iter().map(|sequence| load_committed_event_by_sequence(&tx, sequence)).collect::<Result<Vec<_>, _>>()?;
                tx.commit()?;
                if fail_after_commit.swap(false, Ordering::SeqCst) {
                    return Err(internal("Injected failure after recovery commit"));
                }
                Ok(OwnedDocumentApplyOutcome {
                    committed,
                    events,
                })
            })
            .map_err(core_error)
    }
}

fn require_preview(
    authority: &DocumentAuthorityRow,
    resolve: &RecoveryDraftResolve,
) -> Result<(), StoreError> {
    if resolve.expected_generation == Some(authority.head.generation)
        && resolve.expected_head_seq == Some(authority.head.head_seq)
    {
        return Ok(());
    }
    Err(conflict(
        "The document changed after this preview. Review the latest preview before restoring.",
    ))
}

pub(super) fn finish(
    scope: &DurableMutationScope<'_>,
    job: &DocumentUpdateJob,
    committed: &mut OwnedDocumentWriterResult,
) -> Result<(), StoreError> {
    let Some(recovery) = &job.recovery else {
        return Ok(());
    };
    let authority = read_document_authority(scope.connection(), &job.document_id)?
        .ok_or_else(|| not_found("Recovery target was not found"))?;
    committed.value.recovery = Some(set_resolution(
        scope.connection(),
        &job.context.library_id.0,
        &recovery.draft_id,
        recovery.revision,
        Some(recovery.resolution),
        &job.operation_id,
        Some((&authority.owner_block_id, &job.document_id)),
    )?);
    record_change(
        scope,
        &job.context,
        &job.context.library_id.0,
        &job.document_id,
        job.generation,
    )?;
    Ok(())
}

pub(super) fn finish_or_record_noop(
    connection: &Connection,
    job: &DocumentUpdateJob,
    committed: &mut OwnedDocumentWriterResult,
) -> Result<(), StoreError> {
    if job.recovery.is_none() {
        return insert_typed_receipt(
            connection,
            &job.context,
            &job.operation_id,
            &job.request_hash,
            &job.expected_store_epoch.0,
            job.operation_kind,
            committed,
            None,
        );
    }
    let now = sqlite_now(connection)?;
    let result = durable_mutation::run(
        connection,
        OperationIdentity {
            module: ModuleName::OwnedDocument,
            module_name: MODULE_NAME,
            operation_id: &job.operation_id,
            intent_hash: &job.request_hash,
            store_epoch: &job.expected_store_epoch.0,
            committed_at: &now,
            context: &job.context,
        },
        |scope| {
            let mut result = committed.clone();
            finish(scope, job, &mut result)?;
            seal_typed_receipt(scope, job.operation_kind, result, None)
        },
    )?;
    *committed = resolve_typed_commit(result);
    Ok(())
}

impl OwnedDocumentModule {
    fn copy_recovery(
        &self,
        context: &BoundModuleContext,
        operation_id: String,
        epoch: StoreEpoch,
        resolve: RecoveryDraftResolve,
    ) -> Result<OwnedDocumentApplyOutcome, CoreError> {
        let context = context.clone();
        let library_id = self.library_id.clone();
        let assets_root = self.assets_root.clone();
        let fail_after_commit = self.fail_after_commit.clone();
        let request_hash =
            hash_serializable(&resolve, "Recovery resolution cannot be fingerprinted")
                .map_err(core_error)?;
        self.writer.call(move |connection| {
            let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            require_epoch(&tx, &epoch)?;
            let (summary, capture) = load_draft(&tx, &context, &library_id, &resolve.draft_id)?;
            if let Some(result) = replay(&tx, &operation_id, &request_hash)? { return Ok(result); }
            require_revision(&summary, &resolve)?;
            if let Some(authority) = read_document_authority(&tx, &capture.document_id)? { require_preview(&authority, &resolve)?; }
            let inspection = inspect(&tx, &context, summary, capture.clone())?;
            if !inspection.can_copy { return Err(conflict("This draft does not contain a complete recoverable copy. Export it or keep it for later.")); }
            let mut preview = inspection.retained.ok_or_else(|| invalid_store("Recovery preview is unavailable"))?;
            let file_restore = if let RecoveryDraftContent::Yjs { state, unintegrated_updates } = &capture.content {
                let schema = BlockDocumentSchema::from_identity(&capture.schema_key, capture.schema_version).ok_or_else(|| invalid_store("Unsupported retained schema"))?;
                let engine = decode_retained_yjs(&capture.document_id, state, unintegrated_updates)?;
                let mut materialization = materialize_engine(&engine, schema)?;
                let snapshot = retained_file_snapshot(&tx, &library_id, &capture.draft_id, &materialization)?.ok_or_else(|| conflict("This draft has unresolved File targets"))?;
                let plan = crate::library::plan_file_restore(&tx, &library_id, &operation_id, &snapshot)?;
                crate::domain::files::remap_block_files(&mut materialization.block_tree, &plan.mapping);
                let nfm = crate::domain::nfm::materialize_nfm(&materialization.block_tree).map_err(|error| invalid_store(error.to_string()))?.nfm;
                if let RecoveryPreview::Document { nfm: target, .. } = &mut preview { *target = nfm; }
                Some(plan)
            } else { None };
            let canvas_plans = if let RecoveryPreview::Canvas { scene, .. } = &mut preview {
                let (target, plans) = super::super::canvas_files::plan_restore(&tx, &library_id, &operation_id, &parse_canvas_scene(scene)?)?;
                *scene = target.canonical_value();
                plans
            } else { Vec::new() };
            let owner_id = crate::domain::identity::stable_uuid_v7(&operation_id, "recovery_owner", &resolve.draft_id);
            let document_id = crate::domain::identity::stable_uuid_v7(&operation_id, "recovery_document", &resolve.draft_id);
            let now = sqlite_now(&tx)?;
            let result = durable_mutation::run(&tx, OperationIdentity { module: ModuleName::OwnedDocument, module_name: MODULE_NAME, operation_id: &operation_id, intent_hash: &request_hash, store_epoch: &epoch.0, committed_at: &now, context: &context }, |scope| {
                let mut restored_files = file_restore.as_ref().map(|plan| crate::library::apply_file_restore(scope, &context, plan)).transpose()?.unwrap_or_default();
                restored_files.merge(super::super::canvas_files::apply_restore(scope, &context, &canvas_plans)?);
                crate::library::create_recovery_copy(scope, &context, &owner_id, &document_id, &preview, &assets_root, &restored_files)?;
                let summary = set_resolution(&tx, &library_id, &resolve.draft_id, resolve.revision, Some(RecoveryResolution::Copied), &operation_id, Some((&owner_id, &document_id)))?;
                let event = record_change(scope, &context, &library_id, &capture.document_id, capture.generation)?;
                let mut result = metadata_result(&tx, &operation_id, &epoch.0, &capture, summary)?.committed;
                result.event_sequence = event;
                seal_typed_receipt(scope, "copy_recovery", result, Some(event))
            })?;
            let committed = resolve_typed_commit(result);
            let sequences = tx.prepare("SELECT seq FROM change_log WHERE store_epoch = ?1 AND operation_id = ?2 ORDER BY seq")?
                .query_map(params![epoch.0, operation_id], |row| row.get::<_, i64>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
            let events = sequences.into_iter().map(|sequence| load_committed_event_by_sequence(&tx, sequence)).collect::<Result<Vec<_>, _>>()?;
            tx.commit()?;
            if fail_after_commit.swap(false, Ordering::SeqCst) { return Err(internal("Injected failure after recovery commit")); }
            Ok(OwnedDocumentApplyOutcome { committed, events })
        }).map_err(core_error)
    }
}
