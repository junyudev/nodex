use nodex_core_contracts::document::{DocumentInvalidationReason, OwnedDocumentEvent};
use nodex_core_contracts::{
    CORE_EVENT_VERSION, CommittedCoreModuleEvent, CoreModuleEventPayload, ProjectionImpact,
    StoreEpoch,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Deserialize;
use serde_json::Value;

use crate::infrastructure::projection_impact::decode as decode_projection_impact;
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

const MAX_EVENT_PAYLOAD_BYTES: usize = 1024 * 1024;

#[derive(Debug)]
pub(crate) struct ChangeLogRow {
    pub(crate) sequence: i64,
    pub(crate) project_id: String,
    pub(crate) store_epoch: String,
    pub(crate) kind: String,
    pub(crate) operation_id: Option<String>,
    pub(crate) payload_json: String,
    pub(crate) projection_impact_json: Option<String>,
    pub(crate) committed_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DocumentEventMetadata {
    module: String,
    kind: String,
    document_id: String,
    generation: i64,
    #[serde(default)]
    base_head_seq: Option<i64>,
    #[serde(default)]
    previous_generation: Option<i64>,
    #[serde(default)]
    previous_head_seq: Option<i64>,
    head_seq: i64,
    #[serde(default)]
    update_id: Option<String>,
    #[serde(default)]
    update_hash: Option<String>,
    #[serde(default)]
    scene_hash: Option<String>,
    #[serde(default)]
    event_delta: Option<Value>,
    #[serde(default)]
    reason: Option<String>,
    #[serde(default)]
    local_commit_id: Option<String>,
    #[serde(default)]
    page_file_body_usage_changed: bool,
    #[serde(default)]
    page_file_references_changed: bool,
}

pub(crate) fn reconstruct_document_event(
    connection: &Connection,
    row: &ChangeLogRow,
) -> Result<Option<CommittedCoreModuleEvent>, StoreError> {
    if row.payload_json.len() > MAX_EVENT_PAYLOAD_BYTES {
        return Err(corrupt("Owned Document event payload exceeds its bound"));
    }
    let metadata = serde_json::from_str::<DocumentEventMetadata>(&row.payload_json)
        .map_err(|_| corrupt("Owned Document event payload is invalid"))?;
    if metadata.module != "owned_document"
        || format!("owned_document.{}", metadata.kind) != row.kind
        || metadata.document_id.is_empty()
        || metadata.document_id.len() > 512
        || metadata.generation < 1
        || metadata.head_seq < 0
        || (metadata.kind != "document_invalidated" && metadata.head_seq < 1)
    {
        return Err(corrupt("Owned Document event metadata is inconsistent"));
    }
    let local_commit_id = metadata.local_commit_id.clone();
    let payload = match metadata.kind.as_str() {
        "document_initialized" | "document_updated" => {
            let update_id = metadata
                .update_id
                .as_deref()
                .ok_or_else(|| corrupt("Yjs event update identity is missing"))?;
            let update = connection
                .query_row(
                    "SELECT update_blob, update_hash FROM document_updates \
                     WHERE document_id = ?1 AND generation = ?2 AND seq = ?3 AND update_id = ?4",
                    params![
                        metadata.document_id,
                        metadata.generation,
                        metadata.head_seq,
                        update_id,
                    ],
                    |row| Ok((row.get::<_, Vec<u8>>(0)?, row.get::<_, String>(1)?)),
                )
                .optional()
                .map_err(|_| corrupt("Yjs event update row has invalid column types"))?;
            match update {
                Some((update, update_hash)) => {
                    if update.is_empty()
                        || metadata.update_hash.as_deref() != Some(update_hash.as_str())
                        || super::persistence::sha256(&update) != update_hash
                    {
                        return Err(corrupt("Yjs event update evidence is inconsistent"));
                    }
                    OwnedDocumentEvent::DocumentUpdated {
                        document_id: metadata.document_id,
                        generation: metadata.generation,
                        head_seq: metadata.head_seq,
                        update,
                        page_file_body_usage_changed: metadata.page_file_body_usage_changed,
                        page_file_references_changed: metadata.page_file_references_changed,
                    }
                }
                None => OwnedDocumentEvent::DocumentResyncRequired {
                    document_id: metadata.document_id,
                    generation: metadata.generation,
                    head_seq: metadata.head_seq,
                    update_id: update_id.to_owned(),
                    update_hash: metadata
                        .update_hash
                        .clone()
                        .filter(|hash| is_sha256(hash))
                        .ok_or_else(|| corrupt("Yjs event update hash is invalid"))?,
                    page_file_body_usage_changed: metadata.page_file_body_usage_changed,
                    page_file_references_changed: metadata.page_file_references_changed,
                },
            }
        }
        "canvas_scene_updated" => {
            let base_head_seq = metadata
                .base_head_seq
                .filter(|base_head_seq| *base_head_seq >= 0)
                .ok_or_else(|| corrupt("Canvas event base head is invalid"))?;
            let operation_id = row
                .operation_id
                .as_deref()
                .ok_or_else(|| corrupt("Canvas event operation identity is missing"))?;
            let receipt_exists = connection
                .query_row(
                    "SELECT 1 FROM canvas_scene_mutation_receipts \
                     WHERE document_id = ?1 AND generation = ?2 AND mutation_id = ?3 \
                       AND committed_head_seq = ?4 AND outcome = 'committed'",
                    params![
                        metadata.document_id,
                        metadata.generation,
                        operation_id,
                        metadata.head_seq,
                    ],
                    |row| row.get::<_, i64>(0),
                )
                .optional()
                .map_err(|_| corrupt("Canvas event receipt has invalid column types"))?;
            if receipt_exists != Some(1) {
                return Ok(None);
            }
            let Some(mutation) = metadata.event_delta else {
                return Ok(None);
            };
            if !mutation.is_object() {
                return Err(corrupt("Canvas event delta is invalid"));
            }
            let scene_hash = metadata
                .scene_hash
                .filter(|hash| is_sha256(hash))
                .ok_or_else(|| corrupt("Canvas event scene hash is invalid"))?;
            OwnedDocumentEvent::CanvasUpdated {
                document_id: metadata.document_id,
                generation: metadata.generation,
                base_head_seq,
                head_seq: metadata.head_seq,
                scene_hash,
                mutation,
            }
        }
        "canvas_generation_changed" => {
            let previous_generation = metadata
                .previous_generation
                .filter(|generation| *generation >= 1 && *generation < metadata.generation)
                .ok_or_else(|| corrupt("Canvas generation event previous generation is invalid"))?;
            let previous_head_seq = metadata
                .previous_head_seq
                .filter(|head_seq| *head_seq >= 1)
                .ok_or_else(|| corrupt("Canvas generation event previous head is invalid"))?;
            if metadata.generation != previous_generation + 1 || metadata.head_seq != 1 {
                return Err(corrupt(
                    "Canvas generation event replacement coordinates are invalid",
                ));
            }
            let operation_id = row
                .operation_id
                .as_deref()
                .ok_or_else(|| corrupt("Canvas generation event operation identity is missing"))?;
            let receipt_exists = connection
                .query_row(
                    "SELECT 1 FROM canvas_scene_mutation_receipts \
                     WHERE document_id = ?1 AND generation = ?2 AND mutation_id = ?3 \
                       AND base_head_seq = ?4 AND committed_head_seq = ?5 \
                       AND outcome = 'committed'",
                    params![
                        metadata.document_id,
                        metadata.generation,
                        operation_id,
                        previous_head_seq,
                        metadata.head_seq,
                    ],
                    |row| row.get::<_, i64>(0),
                )
                .optional()
                .map_err(|_| corrupt("Canvas generation event receipt is invalid"))?;
            if receipt_exists != Some(1) {
                return Ok(None);
            }
            let scene_hash = metadata
                .scene_hash
                .filter(|hash| is_sha256(hash))
                .ok_or_else(|| corrupt("Canvas generation event scene hash is invalid"))?;
            OwnedDocumentEvent::CanvasGenerationChanged {
                document_id: metadata.document_id,
                previous_generation,
                previous_head_seq,
                generation: metadata.generation,
                head_seq: metadata.head_seq,
                scene_hash,
            }
        }
        "document_restored" => OwnedDocumentEvent::DocumentInvalidated {
            document_id: metadata.document_id,
            generation: metadata.generation,
            head_seq: metadata.head_seq,
            reason: DocumentInvalidationReason::Restored,
            page_file_body_usage_changed: metadata.page_file_body_usage_changed,
            page_file_references_changed: metadata.page_file_references_changed,
        },
        "document_invalidated" => {
            let reason = match metadata.reason.as_deref() {
                Some("access_changed") => DocumentInvalidationReason::AccessChanged,
                Some("generation_changed") => DocumentInvalidationReason::GenerationChanged,
                Some("restored") => DocumentInvalidationReason::Restored,
                _ => return Err(corrupt("Document invalidation reason is invalid")),
            };
            OwnedDocumentEvent::DocumentInvalidated {
                document_id: metadata.document_id,
                generation: metadata.generation,
                head_seq: metadata.head_seq,
                reason,
                page_file_body_usage_changed: metadata.page_file_body_usage_changed,
                page_file_references_changed: metadata.page_file_references_changed,
            }
        }
        _ => return Err(corrupt("Owned Document event kind is unsupported")),
    };

    let projection_impact = row
        .projection_impact_json
        .as_deref()
        .map(decode_projection_impact)
        .transpose()?
        .unwrap_or(ProjectionImpact::None);
    let operation_id = local_commit_id.or_else(|| row.operation_id.clone());
    Ok(Some(CommittedCoreModuleEvent {
        event_version: CORE_EVENT_VERSION,
        sequence: row.sequence,
        store_epoch: StoreEpoch(row.store_epoch.clone()),
        operation_id,
        committed_at: row.committed_at.clone(),
        projection_impact,
        payload: CoreModuleEventPayload::OwnedDocument(payload),
    }))
}

pub(crate) fn validate_change_log_row(
    row: &ChangeLogRow,
    previous: i64,
    commit_head: i64,
) -> Result<(), StoreError> {
    if row.sequence <= previous
        || row.sequence > commit_head
        || row.project_id.is_empty()
        || row.project_id.len() > 512
        || row.store_epoch.is_empty()
        || row.store_epoch.len() > 512
        || row.kind.is_empty()
        || row.kind.len() > 128
        || row
            .operation_id
            .as_ref()
            .is_some_and(|value| value.is_empty() || value.len() > 512)
        || row.committed_at.is_empty()
        || row.committed_at.len() > 64
    {
        return Err(corrupt("Change log event boundary is invalid"));
    }
    Ok(())
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn corrupt(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message, false)
}
