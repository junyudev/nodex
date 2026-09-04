use nodex_core_contracts::document::{
    DocumentInvalidationReason, OwnedDocumentEvent, PageFileReferenceChange,
};
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
    #[serde(default)]
    detached: bool,
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
    page_file_reference_change: Option<PageFileReferenceChange>,
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
        || (!matches!(
            metadata.kind.as_str(),
            "document_invalidated" | "recovery_changed"
        ) && metadata.head_seq < 1)
    {
        return Err(corrupt("Owned Document event metadata is inconsistent"));
    }
    let local_commit_id = metadata.local_commit_id.clone();
    if metadata.page_file_reference_change.is_some() && metadata.page_file_references_changed {
        return Err(corrupt(
            "Owned Document event contains duplicate Page File reference evidence",
        ));
    }
    let page_file_reference_change = metadata.page_file_reference_change.clone().or_else(|| {
        metadata
            .page_file_references_changed
            .then_some(PageFileReferenceChange::Reset)
    });
    if let Some(change) = &page_file_reference_change {
        validate_page_file_reference_change(change)?;
    }
    let payload = match metadata.kind.as_str() {
        "recovery_changed" => OwnedDocumentEvent::RecoveryChanged {
            document_id: metadata.document_id,
            detached: metadata.detached,
        },
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
                        page_file_reference_change: page_file_reference_change.clone(),
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
                    page_file_reference_change: page_file_reference_change.clone(),
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
            page_file_reference_change: page_file_reference_change.clone(),
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
                page_file_reference_change,
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

fn validate_page_file_reference_change(change: &PageFileReferenceChange) -> Result<(), StoreError> {
    let PageFileReferenceChange::Exact {
        added_file_ids,
        removed_file_ids,
    } = change
    else {
        return Ok(());
    };
    if added_file_ids.is_empty() && removed_file_ids.is_empty() {
        return Err(corrupt("Exact Page File reference change is empty"));
    }
    validate_ordered_identities(added_file_ids, "added Page File")?;
    validate_ordered_identities(removed_file_ids, "removed Page File")?;
    if added_file_ids
        .iter()
        .any(|file_id| removed_file_ids.binary_search(file_id).is_ok())
    {
        return Err(corrupt(
            "Page File reference change adds and removes the same identity",
        ));
    }
    Ok(())
}

fn validate_ordered_identities(values: &[String], label: &str) -> Result<(), StoreError> {
    if values.len() > 4_096
        || values
            .iter()
            .any(|value| value.is_empty() || value.len() > 512 || value.trim() != value)
        || values.windows(2).any(|pair| pair[0] >= pair[1])
    {
        return Err(corrupt(&format!("{label} identities are invalid")));
    }
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;

    fn event_row(reference_evidence: &str) -> ChangeLogRow {
        ChangeLogRow {
            sequence: 1,
            project_id: "project:test".to_owned(),
            store_epoch: "epoch:test".to_owned(),
            kind: "owned_document.document_updated".to_owned(),
            operation_id: Some("operation:test".to_owned()),
            payload_json: format!(
                r#"{{
                  "module":"owned_document",
                  "kind":"document_updated",
                  "documentId":"document:test",
                  "generation":1,
                  "headSeq":1,
                  "updateId":"update:test",
                  "updateHash":"{}",
                  {reference_evidence}
                }}"#,
                "a".repeat(64),
            ),
            projection_impact_json: None,
            committed_at: "2026-08-29T00:00:00.000Z".to_owned(),
        }
    }

    fn connection_without_retained_updates() -> Connection {
        let connection = Connection::open_in_memory().expect("event store");
        connection
            .execute_batch(
                "CREATE TABLE document_updates( \
                   document_id TEXT NOT NULL, generation INTEGER NOT NULL, seq INTEGER NOT NULL, \
                   update_id TEXT NOT NULL, update_blob BLOB NOT NULL, update_hash TEXT NOT NULL \
                 );",
            )
            .expect("document update table");
        connection
    }

    #[test]
    fn exact_reference_evidence_survives_resync_reconstruction() {
        let event = reconstruct_document_event(
            &connection_without_retained_updates(),
            &event_row(
                r#""pageFileReferenceChange":{
                  "kind":"exact",
                  "added_file_ids":["file:added"],
                  "removed_file_ids":["file:removed"]
                }"#,
            ),
        )
        .expect("reconstruct event")
        .expect("document event");

        assert!(matches!(
            event.payload,
            CoreModuleEventPayload::OwnedDocument(
                OwnedDocumentEvent::DocumentResyncRequired {
                    page_file_reference_change: Some(PageFileReferenceChange::Exact {
                        added_file_ids,
                        removed_file_ids,
                    }),
                    ..
                }
            ) if added_file_ids == ["file:added"] && removed_file_ids == ["file:removed"]
        ));
    }

    #[test]
    fn legacy_reference_boolean_replays_as_reset_evidence() {
        let event = reconstruct_document_event(
            &connection_without_retained_updates(),
            &event_row(r#""pageFileReferencesChanged":true"#),
        )
        .expect("reconstruct legacy event")
        .expect("document event");

        assert!(matches!(
            event.payload,
            CoreModuleEventPayload::OwnedDocument(OwnedDocumentEvent::DocumentResyncRequired {
                page_file_reference_change: Some(PageFileReferenceChange::Reset),
                ..
            })
        ));
    }

    #[test]
    fn duplicate_new_and_legacy_reference_evidence_is_rejected() {
        let error = reconstruct_document_event(
            &connection_without_retained_updates(),
            &event_row(
                r#""pageFileReferenceChange":{"kind":"reset"},
                   "pageFileReferencesChanged":true"#,
            ),
        )
        .expect_err("duplicate evidence must be rejected");

        assert_eq!(error.code, StoreErrorCode::StoreCorrupt);
    }
}
