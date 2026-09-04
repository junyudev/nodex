use base64::prelude::{BASE64_STANDARD, Engine as _};
use nodex_core::document::CanvasSceneSyncSnapshot;
use nodex_core::infrastructure::request_execution::request_is_cancelled;
use nodex_core_contracts::document::{
    OwnedDocumentAccessContext, OwnedDocumentCommitValue, OwnedDocumentDescriptor,
    OwnedDocumentReadValue, OwnedDocumentReceipt, OwnedDocumentSyncDescriptor,
};
use nodex_core_contracts::{
    ApplyResponse, AuthorizedDeliveryPacket, CommitIdentity, CoreError, ModuleReadSnapshot,
    StoreObservation,
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;

const MAGIC: [u8; 4] = [0x4e, 0x44, 0x58, 0x03];
const HEADER_BYTES: usize = MAGIC.len() + size_of::<u32>();
const MAX_METADATA_BYTES: usize = 8 * 1024 * 1024;
const MAX_TRANSPORT_UPDATE_BYTES: usize = 2 * 1024 * 1024;
const MAX_TRANSPORT_AWARENESS_BYTES: usize = 64 * 1024;
pub(crate) const MAX_CANVAS_SCENE_SNAPSHOT_BYTES: usize = 16 * 1024 * 1024;
pub(crate) const CONTENT_TYPE: &str = "application/vnd.nodex.document-sync.v3+octet-stream";
pub(crate) const MAX_SYNC_FRAME_BYTES: usize =
    MAX_METADATA_BYTES + MAX_CANVAS_SCENE_SNAPSHOT_BYTES + HEADER_BYTES;
pub(crate) const MAX_APPLY_FRAME_BYTES: usize =
    MAX_METADATA_BYTES + MAX_TRANSPORT_UPDATE_BYTES + HEADER_BYTES;
pub(crate) const MAX_AWARENESS_FRAME_BYTES: usize =
    MAX_METADATA_BYTES + MAX_TRANSPORT_AWARENESS_BYTES + HEADER_BYTES;
pub(crate) const MAX_DOCUMENT_FRAME_BYTES: usize = MAX_APPLY_FRAME_BYTES;

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum WireEngine {
    Yjs,
    CanvasScene,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct YjsSyncRequestMetadata {
    pub(crate) version: u32,
    engine: WireEngine,
    pub(crate) client_session_id: String,
    pub(crate) history_after_head_seq: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CanvasSyncRequestMetadata {
    pub(crate) version: u32,
    engine: WireEngine,
    pub(crate) sync_request_id: String,
    pub(crate) client_session_id: String,
    pub(crate) known_store_epoch: Option<String>,
    pub(crate) known_generation: Option<i64>,
    pub(crate) known_head_seq: Option<i64>,
    pub(crate) known_scene_hash: Option<String>,
}

#[derive(Debug)]
pub(crate) enum SyncFrame {
    Yjs(YjsSyncRequestMetadata, Vec<u8>),
    Canvas(CanvasSyncRequestMetadata),
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ApplyRequestMetadata {
    pub(crate) version: u32,
    engine: WireEngine,
    pub(crate) store_epoch: String,
    pub(crate) generation: i64,
    pub(crate) update_id: String,
    pub(crate) client_session_id: String,
    pub(crate) base_head_seq: i64,
    pub(crate) touched_block_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AwarenessRequestMetadata {
    pub(crate) version: u32,
    engine: WireEngine,
    pub(crate) client_session_id: String,
    pub(crate) store_epoch: String,
    pub(crate) generation: i64,
}

pub(crate) enum ApplyFrame {
    Update(ApplyRequestMetadata, Vec<u8>),
    Awareness(AwarenessRequestMetadata, Vec<u8>),
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncResponseMetadata<'a> {
    version: u32,
    engine: WireEngine,
    document_id: &'a str,
    store_epoch: &'a str,
    generation: i64,
    head_seq: i64,
    state_vector: String,
    history_fence: &'a nodex_core_contracts::document::DocumentHistoryFence,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ApplyAckMetadata<'a> {
    version: u32,
    engine: WireEngine,
    document_id: &'a str,
    store_epoch: &'a str,
    generation: i64,
    update_id: &'a str,
    committed_seq: i64,
    head_seq: i64,
    duplicate: bool,
    #[serde(flatten)]
    proof: ApplyAckProof<'a>,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum ApplyAckProof<'a> {
    Committed {
        commit: &'a CommitIdentity,
        #[serde(skip_serializing_if = "Option::is_none")]
        delivery: Option<&'a AuthorizedDeliveryPacket>,
    },
    NoOp {
        observed: &'a StoreObservation,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CanvasSyncResponseMetadata<'a> {
    version: u32,
    engine: WireEngine,
    kind: CanvasSyncKind,
    sync_request_id: &'a str,
    library_id: &'a str,
    access_context: &'a OwnedDocumentAccessContext,
    document_id: &'a str,
    store_epoch: &'a str,
    generation: i64,
    head_seq: i64,
    scene_hash: &'a str,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CanvasSyncKind {
    UpToDate,
    Snapshot,
}

#[derive(Debug)]
pub(crate) struct YjsSyncValue {
    pub(crate) document_id: String,
    pub(crate) store_epoch: String,
    pub(crate) generation: i64,
    pub(crate) head_seq: i64,
    pub(crate) state_vector: Vec<u8>,
    pub(crate) update: Vec<u8>,
    pub(crate) history_fence: nodex_core_contracts::document::DocumentHistoryFence,
}

#[derive(Debug)]
pub(crate) struct CanvasSyncValue {
    pub(crate) library_id: String,
    pub(crate) access_context: OwnedDocumentAccessContext,
    pub(crate) document_id: String,
    pub(crate) store_epoch: String,
    pub(crate) generation: i64,
    pub(crate) head_seq: i64,
    pub(crate) scene_hash: String,
    pub(crate) scene_json: Vec<u8>,
}

pub(crate) fn decode_sync(bytes: &[u8]) -> Result<SyncFrame, CoreError> {
    let metadata = decode_metadata(bytes)?;
    match metadata.get("engine").and_then(Value::as_str) {
        Some("yjs") => {
            let (metadata, payload) = decode_envelope::<YjsSyncRequestMetadata>(
                bytes,
                nodex_core::document::MAX_STATE_VECTOR_BYTES,
            )?;
            if !matches!(metadata.engine, WireEngine::Yjs) {
                return Err(invalid("Yjs sync frame has the wrong engine"));
            }
            Ok(SyncFrame::Yjs(metadata, payload))
        }
        Some("canvas_scene") => {
            let (metadata, payload) = decode_envelope::<CanvasSyncRequestMetadata>(bytes, 0)?;
            if !matches!(metadata.engine, WireEngine::CanvasScene) || !payload.is_empty() {
                return Err(invalid("Canvas sync request payload must be empty"));
            }
            if metadata.sync_request_id.trim() != metadata.sync_request_id
                || metadata.sync_request_id.is_empty()
                || metadata.client_session_id.trim() != metadata.client_session_id
                || metadata.client_session_id.is_empty()
                || metadata.known_generation.is_some_and(|value| value < 1)
                || metadata.known_head_seq.is_some_and(|value| value < 0)
                || metadata
                    .known_scene_hash
                    .as_deref()
                    .is_some_and(|value| !is_sha256(value))
            {
                return Err(invalid("Canvas sync request metadata is invalid"));
            }
            Ok(SyncFrame::Canvas(metadata))
        }
        _ => Err(invalid("Document binary sync engine is unsupported")),
    }
}

pub(crate) fn decode_apply(bytes: &[u8]) -> Result<ApplyFrame, CoreError> {
    let metadata = decode_metadata(bytes)?;
    if metadata.get("updateId").is_some() {
        let (metadata, payload) =
            decode_envelope::<ApplyRequestMetadata>(bytes, MAX_TRANSPORT_UPDATE_BYTES)?;
        if !matches!(metadata.engine, WireEngine::Yjs) {
            return Err(invalid("Yjs update frame has the wrong engine"));
        }
        return Ok(ApplyFrame::Update(metadata, payload));
    }
    let (metadata, payload) =
        decode_envelope::<AwarenessRequestMetadata>(bytes, MAX_TRANSPORT_AWARENESS_BYTES)?;
    if !matches!(metadata.engine, WireEngine::Yjs) {
        return Err(invalid("Yjs Awareness frame has the wrong engine"));
    }
    Ok(ApplyFrame::Awareness(metadata, payload))
}

pub(crate) fn parse_yjs_sync(
    snapshot: ModuleReadSnapshot<OwnedDocumentReadValue>,
) -> Result<YjsSyncValue, CoreError> {
    let OwnedDocumentReadValue::YjsSync {
        descriptor,
        update,
        history_fence,
    } = snapshot.value
    else {
        return Err(invalid("Core returned a non-Yjs Document sync value"));
    };
    let OwnedDocumentDescriptor {
        document_id,
        store_epoch,
        generation,
        head_seq,
        sync,
        ..
    } = descriptor;
    let OwnedDocumentSyncDescriptor::Yjs { state_vector } = sync else {
        return Err(invalid("Core Document descriptor is not Yjs"));
    };
    Ok(YjsSyncValue {
        document_id,
        store_epoch,
        generation,
        head_seq,
        state_vector,
        update,
        history_fence,
    })
}

pub(crate) fn encode_sync(value: &YjsSyncValue) -> Result<Vec<u8>, CoreError> {
    ensure_request_active()?;
    let state_vector = BASE64_STANDARD.encode(&value.state_vector);
    ensure_request_active()?;
    encode_envelope(
        &SyncResponseMetadata {
            version: 3,
            engine: WireEngine::Yjs,
            document_id: &value.document_id,
            store_epoch: &value.store_epoch,
            generation: value.generation,
            head_seq: value.head_seq,
            state_vector,
            history_fence: &value.history_fence,
        },
        &value.update,
    )
}

pub(crate) fn parse_canvas_sync(
    snapshot: CanvasSceneSyncSnapshot,
) -> Result<CanvasSyncValue, CoreError> {
    let scene_json = snapshot.scene_json.into_bytes();
    if scene_json.len() > MAX_CANVAS_SCENE_SNAPSHOT_BYTES {
        return Err(invalid("Canvas scene snapshot exceeds its byte bound"));
    }
    Ok(CanvasSyncValue {
        library_id: snapshot.library_id,
        access_context: snapshot.access_context,
        document_id: snapshot.document_id,
        store_epoch: snapshot.store_epoch,
        generation: snapshot.generation,
        head_seq: snapshot.head_seq,
        scene_hash: snapshot.scene_hash,
        scene_json,
    })
}

pub(crate) fn encode_canvas_sync(
    value: &CanvasSyncValue,
    sync_request_id: &str,
    kind: CanvasSyncKind,
) -> Result<Vec<u8>, CoreError> {
    if value.scene_json.len() > MAX_CANVAS_SCENE_SNAPSHOT_BYTES {
        return Err(invalid("Canvas scene snapshot exceeds its byte bound"));
    }
    let payload = match kind {
        CanvasSyncKind::UpToDate => &[][..],
        CanvasSyncKind::Snapshot => value.scene_json.as_slice(),
    };
    encode_envelope(
        &CanvasSyncResponseMetadata {
            version: 3,
            engine: WireEngine::CanvasScene,
            kind,
            sync_request_id,
            library_id: &value.library_id,
            access_context: &value.access_context,
            document_id: &value.document_id,
            store_epoch: &value.store_epoch,
            generation: value.generation,
            head_seq: value.head_seq,
            scene_hash: &value.scene_hash,
        },
        payload,
    )
}

pub(crate) fn encode_apply_ack(
    response: &ApplyResponse<OwnedDocumentCommitValue, OwnedDocumentReceipt>,
    update_id: &str,
    sync: &YjsSyncValue,
) -> Result<Vec<u8>, CoreError> {
    let (receipt, store_epoch, proof) = match response {
        ApplyResponse::Committed {
            receipt,
            commit,
            delivery,
            ..
        } => (
            receipt,
            &commit.store_epoch,
            ApplyAckProof::Committed {
                commit,
                delivery: delivery.as_deref(),
            },
        ),
        ApplyResponse::NoOp {
            receipt, observed, ..
        } => (
            receipt,
            &observed.store_epoch,
            ApplyAckProof::NoOp { observed },
        ),
    };
    encode_envelope(
        &ApplyAckMetadata {
            version: 3,
            engine: WireEngine::Yjs,
            document_id: &receipt.document_id,
            store_epoch: &store_epoch.0,
            generation: receipt.generation,
            update_id,
            committed_seq: receipt.head_seq,
            head_seq: sync.head_seq,
            duplicate: receipt.mutation.duplicate,
            proof,
        },
        &sync.state_vector,
    )
}

pub(crate) fn encode_realtime_event(
    event: &nodex_core::document::DocumentRealtimeEvent,
) -> Result<String, CoreError> {
    ensure_request_active()?;
    let nodex_core::document::DocumentRealtimeEvent::Awareness {
        document_id,
        store_epoch,
        generation,
        client_session_id,
        update,
    } = event;
    let encoded = serde_json::to_string(&serde_json::json!({
        "version": 1,
        "kind": "awareness",
        "documentId": document_id,
        "storeEpoch": store_epoch,
        "generation": generation,
        "clientSessionId": client_session_id,
        "update": BASE64_STANDARD.encode(update),
    }))
    .map_err(|_| invalid("Document realtime event cannot be encoded"))?;
    ensure_request_active()?;
    Ok(encoded)
}

fn decode_envelope<T: DeserializeOwned>(
    bytes: &[u8],
    maximum_payload_bytes: usize,
) -> Result<(T, Vec<u8>), CoreError> {
    let metadata = decode_metadata_bytes(bytes)?;
    let payload_offset = HEADER_BYTES + metadata.len();
    let payload = bytes
        .get(payload_offset..)
        .ok_or_else(|| invalid("Document binary frame is truncated"))?;
    if payload.len() > maximum_payload_bytes {
        return Err(invalid("Document binary payload exceeds its bound"));
    }
    let metadata = serde_json::from_slice(metadata)
        .map_err(|_| invalid("Document binary metadata is invalid"))?;
    Ok((metadata, payload.to_vec()))
}

fn decode_metadata(bytes: &[u8]) -> Result<Value, CoreError> {
    serde_json::from_slice(decode_metadata_bytes(bytes)?)
        .map_err(|_| invalid("Document binary metadata is invalid"))
}

fn decode_metadata_bytes(bytes: &[u8]) -> Result<&[u8], CoreError> {
    if bytes.len() < HEADER_BYTES || bytes.get(..MAGIC.len()) != Some(MAGIC.as_slice()) {
        return Err(invalid("Document binary frame has an invalid version"));
    }
    let length = u32::from_be_bytes(
        bytes[MAGIC.len()..HEADER_BYTES]
            .try_into()
            .map_err(|_| invalid("Document binary frame is truncated"))?,
    ) as usize;
    if length > MAX_METADATA_BYTES {
        return Err(invalid("Document binary metadata exceeds its bound"));
    }
    bytes
        .get(HEADER_BYTES..HEADER_BYTES + length)
        .ok_or_else(|| invalid("Document binary metadata is truncated"))
}

fn encode_envelope<T: Serialize>(metadata: &T, payload: &[u8]) -> Result<Vec<u8>, CoreError> {
    ensure_request_active()?;
    let metadata = serde_json::to_vec(metadata)
        .map_err(|_| invalid("Document binary metadata cannot be encoded"))?;
    ensure_request_active()?;
    if metadata.len() > MAX_METADATA_BYTES {
        return Err(invalid("Document binary metadata exceeds its bound"));
    }
    let length = u32::try_from(metadata.len())
        .map_err(|_| invalid("Document binary metadata exceeds its bound"))?;
    let mut frame = Vec::with_capacity(HEADER_BYTES + metadata.len() + payload.len());
    frame.extend_from_slice(&MAGIC);
    frame.extend_from_slice(&length.to_be_bytes());
    frame.extend_from_slice(&metadata);
    frame.extend_from_slice(payload);
    ensure_request_active()?;
    Ok(frame)
}

fn ensure_request_active() -> Result<(), CoreError> {
    if request_is_cancelled() {
        return Err(cancelled());
    }
    Ok(())
}

fn cancelled() -> CoreError {
    CoreError {
        code: nodex_core_contracts::CoreErrorCode::Cancelled,
        message: "Core request was cancelled".to_owned(),
        retryable: true,
        recovery: nodex_core_contracts::CoreErrorRecovery::None,
    }
}

fn invalid(message: &str) -> CoreError {
    CoreError {
        code: nodex_core_contracts::CoreErrorCode::InvalidInput,
        message: message.to_owned(),
        retryable: false,
        recovery: nodex_core_contracts::CoreErrorRecovery::None,
    }
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use nodex_core::infrastructure::request_execution::{
        RequestExecutionContext, within_request_execution,
    };
    use nodex_core::infrastructure::sqlite::QueryCancellation;

    use super::*;

    #[test]
    fn sync_frame_round_trips_raw_state_vector_bytes() {
        let frame = encode_envelope(
            &serde_json::json!({
                "version": 2,
                "engine": "yjs",
                "clientSessionId": "renderer:one",
            }),
            &[0, 1, 2, 255],
        )
        .expect("frame");
        let SyncFrame::Yjs(metadata, payload) = decode_sync(&frame).expect("decode") else {
            panic!("expected Yjs frame");
        };
        assert_eq!(metadata.version, 2);
        assert_eq!(metadata.client_session_id, "renderer:one");
        assert_eq!(payload, [0, 1, 2, 255]);
    }

    #[test]
    fn apply_frame_distinguishes_durable_updates_from_awareness() {
        let update = encode_envelope(
            &serde_json::json!({
                "version": 2,
                "engine": "yjs",
                "storeEpoch": "epoch:one",
                "generation": 1,
                "updateId": "update:one",
                "clientSessionId": "renderer:one",
                "baseHeadSeq": 2,
                "touchedBlockIds": [],
            }),
            &[1, 2, 3],
        )
        .expect("update frame");
        assert!(
            matches!(decode_apply(&update), Ok(ApplyFrame::Update(_, payload)) if payload == [1, 2, 3])
        );

        let awareness = encode_envelope(
            &serde_json::json!({
                "version": 2,
                "engine": "yjs",
                "clientSessionId": "renderer:one",
                "storeEpoch": "epoch:one",
                "generation": 1,
            }),
            &[4, 5, 6],
        )
        .expect("Awareness frame");
        assert!(
            matches!(decode_apply(&awareness), Ok(ApplyFrame::Awareness(_, payload)) if payload == [4, 5, 6])
        );
    }

    #[test]
    fn frame_decoder_rejects_claimed_metadata_and_payload_overflow() {
        let mut oversized_metadata = MAGIC.to_vec();
        oversized_metadata.extend_from_slice(
            &u32::try_from(MAX_METADATA_BYTES + 1)
                .expect("bounded test length")
                .to_be_bytes(),
        );
        assert_eq!(
            decode_sync(&oversized_metadata)
                .expect_err("oversized metadata")
                .message,
            "Document binary metadata exceeds its bound",
        );

        let oversized_payload = encode_envelope(
            &serde_json::json!({
                "version": 2,
                "engine": "yjs",
                "clientSessionId": "renderer:one",
            }),
            &vec![0; nodex_core::document::MAX_STATE_VECTOR_BYTES + 1],
        )
        .expect("oversized payload frame");
        assert_eq!(
            decode_sync(&oversized_payload)
                .expect_err("oversized payload")
                .message,
            "Document binary payload exceeds its bound",
        );
    }

    #[test]
    fn canvas_snapshot_frame_keeps_raw_json_and_up_to_date_is_empty() {
        let scene = br#"{"appState":{},"elements":[],"files":{},"kind":"canvas_scene","pageReferences":[],"plainText":"","preview":"","schemaVersion":1}"#.to_vec();
        let value = CanvasSyncValue {
            library_id: "library:one".to_owned(),
            access_context: OwnedDocumentAccessContext::Project {
                project_id: "project:one".to_owned(),
            },
            document_id: "canvas:one".to_owned(),
            store_epoch: "epoch:one".to_owned(),
            generation: 1,
            head_seq: 2,
            scene_hash: "a".repeat(64),
            scene_json: scene.clone(),
        };
        let snapshot =
            encode_canvas_sync(&value, "sync:one", CanvasSyncKind::Snapshot).expect("snapshot");
        let (metadata, payload) =
            decode_envelope::<Value>(&snapshot, MAX_CANVAS_SCENE_SNAPSHOT_BYTES)
                .expect("decode snapshot");
        assert_eq!(metadata["engine"], "canvas_scene");
        assert_eq!(metadata["kind"], "snapshot");
        assert_eq!(metadata["libraryId"], "library:one");
        assert_eq!(
            metadata["accessContext"],
            serde_json::json!({ "kind": "project", "projectId": "project:one" }),
        );
        assert!(metadata.get("projectId").is_none());
        assert_eq!(payload, scene);

        let current =
            encode_canvas_sync(&value, "sync:two", CanvasSyncKind::UpToDate).expect("current");
        let (metadata, payload) =
            decode_envelope::<Value>(&current, MAX_CANVAS_SCENE_SNAPSHOT_BYTES)
                .expect("decode current");
        assert_eq!(metadata["kind"], "up_to_date");
        assert!(payload.is_empty());
    }

    #[test]
    fn canvas_snapshot_encoder_rejects_limit_plus_one() {
        let value = CanvasSyncValue {
            library_id: "library:one".to_owned(),
            access_context: OwnedDocumentAccessContext::Library,
            document_id: "canvas:one".to_owned(),
            store_epoch: "epoch:one".to_owned(),
            generation: 1,
            head_seq: 2,
            scene_hash: "a".repeat(64),
            scene_json: vec![b'x'; MAX_CANVAS_SCENE_SNAPSHOT_BYTES + 1],
        };
        assert_eq!(
            encode_canvas_sync(&value, "sync:one", CanvasSyncKind::Snapshot)
                .expect_err("oversized Canvas snapshot")
                .message,
            "Canvas scene snapshot exceeds its byte bound",
        );
    }

    #[test]
    fn response_encoding_preserves_request_cancellation() {
        let cancellation = QueryCancellation::new();
        let result = within_request_execution(
            RequestExecutionContext::new(
                nodex_core::infrastructure::request_execution::RequestExecutionClass::Interactive,
                cancellation.clone(),
                Instant::now() + Duration::from_secs(2),
            ),
            || {
                cancellation.cancel();
                encode_envelope(&serde_json::json!({ "kind": "sync" }), &[])
            },
        );

        assert_eq!(
            result.expect_err("cancelled response was encoded").code,
            nodex_core_contracts::CoreErrorCode::Cancelled,
        );
    }
}
