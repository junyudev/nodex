//! Typed Module variants on the existing Document v3 envelope. Only content bytes
//! move out of metadata; authorization, live sessions and LocalCommit proofs stay intact.
use crate::{
    MAX_DOCUMENT_RESPONSE_BYTES, OwnedDocumentApplyRequest, OwnedDocumentApplyResponse,
    OwnedDocumentReadRequest, OwnedDocumentReadResponse, ResponseEnvelope,
};
use nodex_core_contracts::document::{
    OwnedDocumentIntent, OwnedDocumentRead, OwnedDocumentReadValue, OwnedDocumentSyncDescriptor,
};
use nodex_core_contracts::{ApplyResponse, CoreError, CoreErrorCode, CoreErrorRecovery};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use utoipa::ToSchema;

pub const METADATA_BYTES: usize = 8 * 1024 * 1024;
pub const STATE_VECTOR_BYTES: usize = 64 * 1024;
pub const UPDATE_BYTES: usize = 2 * 1024 * 1024;
pub const CONTENT_BYTES: usize = 16 * 1024 * 1024;
pub const PAYLOAD_BYTES: usize = CONTENT_BYTES + STATE_VECTOR_BYTES;
const MAGIC: &[u8; 4] = b"NDX\x03";

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum DocumentModuleFrameMetadata {
    ModuleRead {
        request: OwnedDocumentReadRequest,
    },
    ModuleApply {
        request: OwnedDocumentApplyRequest,
    },
    ModuleReadResponse {
        response: OwnedDocumentReadResponse,
        state_vector_bytes: u32,
    },
    ModuleApplyResponse {
        response: OwnedDocumentApplyResponse,
        has_canvas: bool,
    },
}

fn invalid(message: &str) -> CoreError {
    CoreError {
        code: CoreErrorCode::InvalidInput,
        message: message.into(),
        retryable: false,
        recovery: CoreErrorRecovery::None,
    }
}

pub fn is_module_frame(bytes: &[u8]) -> Result<bool, CoreError> {
    let (metadata, _) = split(bytes)?;
    let value: Value =
        serde_json::from_slice(metadata).map_err(|_| invalid("Invalid Document metadata"))?;
    Ok(value
        .get("kind")
        .and_then(Value::as_str)
        .is_some_and(|kind| kind.starts_with("module_")))
}

fn split(bytes: &[u8]) -> Result<(&[u8], &[u8]), CoreError> {
    if bytes.len() < 8 || &bytes[..4] != MAGIC || bytes.len() > MAX_DOCUMENT_RESPONSE_BYTES {
        return Err(invalid("Invalid Document frame length or version"));
    }
    let length = u32::from_be_bytes(bytes[4..8].try_into().unwrap()) as usize;
    if length > METADATA_BYTES || length > bytes.len() - 8 {
        return Err(invalid("Invalid Document metadata length"));
    }
    Ok((&bytes[8..8 + length], &bytes[8 + length..]))
}

pub fn validate_json_tree(value: &Value, content: bool) -> Result<(), CoreError> {
    let mut pending = vec![(value, 1)];
    let mut nodes = 0;
    while let Some((value, depth)) = pending.pop() {
        nodes += 1;
        if depth > if content { 64 } else { 32 }
            || nodes > if content { 2_000_000 } else { 100_000 }
        {
            return Err(invalid("Document JSON exceeds its structural bound"));
        }
        match value {
            Value::Array(values) => {
                if values.len() > if content { 100_000 } else { 65_536 } {
                    return Err(invalid("Document JSON array exceeds its bound"));
                }
                pending.extend(values.iter().map(|value| (value, depth + 1)));
            }
            Value::Object(fields) => {
                if fields.len() > if content { 10_000 } else { 4_096 }
                    || fields.keys().any(|key| key.len() > 1024)
                {
                    return Err(invalid("Document JSON fields exceed their bound"));
                }
                pending.extend(fields.values().map(|value| (value, depth + 1)));
            }
            _ => {}
        }
    }
    Ok(())
}

fn encode(metadata: DocumentModuleFrameMetadata, payload: &[u8]) -> Result<Vec<u8>, CoreError> {
    let value = serde_json::to_value(metadata).map_err(|_| invalid("Invalid Document metadata"))?;
    validate_json_tree(&value, false)?;
    let metadata = serde_json::to_vec(&value).map_err(|_| invalid("Invalid Document metadata"))?;
    if metadata.len() > METADATA_BYTES
        || payload.len() > PAYLOAD_BYTES
        || 8 + metadata.len() + payload.len() > MAX_DOCUMENT_RESPONSE_BYTES
    {
        return Err(invalid("Document frame exceeds its bound"));
    }
    let mut bytes = Vec::with_capacity(8 + metadata.len() + payload.len());
    bytes.extend_from_slice(MAGIC);
    bytes.extend_from_slice(&(metadata.len() as u32).to_be_bytes());
    bytes.extend_from_slice(&metadata);
    bytes.extend_from_slice(payload);
    Ok(bytes)
}

fn decode(bytes: &[u8]) -> Result<(DocumentModuleFrameMetadata, &[u8]), CoreError> {
    let (metadata, payload) = split(bytes)?;
    if payload.len() > PAYLOAD_BYTES {
        return Err(invalid("Document payload exceeds its bound"));
    }
    let value: Value =
        serde_json::from_slice(metadata).map_err(|_| invalid("Invalid Document metadata"))?;
    validate_json_tree(&value, false)?;
    Ok((
        serde_json::from_value(value).map_err(|_| invalid("Invalid Document metadata"))?,
        payload,
    ))
}

fn json_content(payload: &[u8]) -> Result<Value, CoreError> {
    if payload.len() > CONTENT_BYTES {
        return Err(invalid("Document content exceeds its bound"));
    }
    let value =
        serde_json::from_slice(payload).map_err(|_| invalid("Invalid Document content JSON"))?;
    validate_json_tree(&value, true)?;
    Ok(value)
}

pub fn encode_read(mut request: OwnedDocumentReadRequest) -> Result<Vec<u8>, CoreError> {
    let payload = match &mut request.0.read {
        OwnedDocumentRead::SyncYjs { state_vector, .. } => std::mem::take(state_vector),
        OwnedDocumentRead::FetchUpdate { .. } | OwnedDocumentRead::RecoveryArtifact { .. } => {
            Vec::new()
        }
        _ => return Err(invalid("This Document read uses the control transport")),
    };
    if payload.len() > STATE_VECTOR_BYTES {
        return Err(invalid("Document state vector exceeds its bound"));
    }
    encode(
        DocumentModuleFrameMetadata::ModuleRead { request },
        &payload,
    )
}

pub fn decode_read(bytes: &[u8]) -> Result<OwnedDocumentReadRequest, CoreError> {
    let (DocumentModuleFrameMetadata::ModuleRead { mut request }, payload) = decode(bytes)? else {
        return Err(invalid("Expected Document Module read"));
    };
    match &mut request.0.read {
        OwnedDocumentRead::SyncYjs { state_vector, .. }
            if state_vector.is_empty() && payload.len() <= STATE_VECTOR_BYTES =>
        {
            *state_vector = payload.to_vec()
        }
        OwnedDocumentRead::FetchUpdate { .. } | OwnedDocumentRead::RecoveryArtifact { .. }
            if payload.is_empty() => {}
        _ => return Err(invalid("Invalid Document read payload")),
    }
    Ok(request)
}

pub fn encode_apply(mut request: OwnedDocumentApplyRequest) -> Result<Vec<u8>, CoreError> {
    let payload = match &mut request.0.intent {
        OwnedDocumentIntent::ApplyYjsUpdate { update, .. } if update.len() <= UPDATE_BYTES => {
            std::mem::take(update)
        }
        OwnedDocumentIntent::ApplyCanvasMutation { mutation, .. } => {
            serde_json::to_vec(&mutation.take()).map_err(|_| invalid("Invalid Canvas mutation"))?
        }
        _ => return Err(invalid("Invalid Document apply payload")),
    };
    if payload.len() > CONTENT_BYTES {
        return Err(invalid("Document mutation exceeds its bound"));
    }
    encode(
        DocumentModuleFrameMetadata::ModuleApply { request },
        &payload,
    )
}

pub fn decode_apply(bytes: &[u8]) -> Result<OwnedDocumentApplyRequest, CoreError> {
    let (DocumentModuleFrameMetadata::ModuleApply { mut request }, payload) = decode(bytes)? else {
        return Err(invalid("Expected Document Module apply"));
    };
    match &mut request.0.intent {
        OwnedDocumentIntent::ApplyYjsUpdate { update, .. }
            if update.is_empty() && payload.len() <= UPDATE_BYTES =>
        {
            *update = payload.to_vec()
        }
        OwnedDocumentIntent::ApplyCanvasMutation { mutation, .. } if mutation.is_null() => {
            *mutation = json_content(payload)?
        }
        _ => return Err(invalid("Invalid Document apply payload")),
    }
    Ok(request)
}

pub fn encode_read_response(mut response: OwnedDocumentReadResponse) -> Result<Vec<u8>, CoreError> {
    let mut vector = Vec::new();
    let mut payload = match &mut response.0 {
        ResponseEnvelope::Ok(snapshot) => match &mut snapshot.value {
            OwnedDocumentReadValue::YjsSync {
                descriptor, update, ..
            } => {
                if let OwnedDocumentSyncDescriptor::Yjs { state_vector } = &mut descriptor.sync {
                    vector = std::mem::take(state_vector);
                }
                std::mem::take(update)
            }
            OwnedDocumentReadValue::RecoveryArtifact { artifact } => {
                std::mem::take(&mut artifact.update)
            }
            OwnedDocumentReadValue::UpdateResource { resource } => {
                std::mem::take(&mut resource.update)
            }
            OwnedDocumentReadValue::UpdateResourceUnavailable { .. } => Vec::new(),
            _ => return Err(invalid("Unexpected Document byte response")),
        },
        ResponseEnvelope::Error(_) => Vec::new(),
    };
    if vector.len() > STATE_VECTOR_BYTES || payload.len() > CONTENT_BYTES {
        return Err(invalid("Document response exceeds its bound"));
    }
    let state_vector_bytes = vector.len() as u32;
    payload.extend_from_slice(&vector);
    encode(
        DocumentModuleFrameMetadata::ModuleReadResponse {
            response,
            state_vector_bytes,
        },
        &payload,
    )
}

pub fn decode_read_response(bytes: &[u8]) -> Result<OwnedDocumentReadResponse, CoreError> {
    let (
        DocumentModuleFrameMetadata::ModuleReadResponse {
            mut response,
            state_vector_bytes,
        },
        payload,
    ) = decode(bytes)?
    else {
        return Err(invalid("Expected Document Module read response"));
    };
    let vector_length = state_vector_bytes as usize;
    if vector_length > STATE_VECTOR_BYTES || vector_length > payload.len() {
        return Err(invalid("Invalid response state vector length"));
    }
    let (update, vector) = payload.split_at(payload.len() - vector_length);
    match &mut response.0 {
        ResponseEnvelope::Ok(snapshot) => match &mut snapshot.value {
            OwnedDocumentReadValue::YjsSync {
                descriptor,
                update: target,
                ..
            } if target.is_empty() && update.len() <= CONTENT_BYTES => {
                let OwnedDocumentSyncDescriptor::Yjs { state_vector } = &mut descriptor.sync else {
                    return Err(invalid("Invalid sync engine"));
                };
                if !state_vector.is_empty() {
                    return Err(invalid("Unexpected inline state vector"));
                }
                *state_vector = vector.to_vec();
                *target = update.to_vec();
            }
            OwnedDocumentReadValue::RecoveryArtifact { artifact }
                if artifact.update.is_empty()
                    && vector.is_empty()
                    && update.len() <= UPDATE_BYTES =>
            {
                artifact.update = update.to_vec()
            }
            OwnedDocumentReadValue::UpdateResource { resource }
                if resource.update.is_empty()
                    && vector.is_empty()
                    && update.len() <= UPDATE_BYTES =>
            {
                resource.update = update.to_vec()
            }
            OwnedDocumentReadValue::UpdateResourceUnavailable { .. } if payload.is_empty() => {}
            _ => return Err(invalid("Invalid Document response payload")),
        },
        ResponseEnvelope::Error(_) if payload.is_empty() => {}
        _ => return Err(invalid("Unexpected Document error payload")),
    }
    Ok(response)
}

pub fn encode_apply_response(
    mut response: OwnedDocumentApplyResponse,
) -> Result<Vec<u8>, CoreError> {
    // The optional fast-path packet can contain inline engine updates. A byte
    // command returns its immutable commit identity; the existing delivery lane
    // supplies the packet without duplicating its content into JSON metadata.
    if let ResponseEnvelope::Ok(ApplyResponse::Committed { delivery, .. }) = &mut response.0 {
        *delivery = None;
    }
    let canvas = match &mut response.0 {
        ResponseEnvelope::Ok(
            ApplyResponse::Committed { outcome, .. } | ApplyResponse::NoOp { outcome, .. },
        ) => outcome.canvas.take(),
        _ => None,
    };
    let payload = canvas
        .as_ref()
        .map(serde_json::to_vec)
        .transpose()
        .map_err(|_| invalid("Invalid Canvas response"))?
        .unwrap_or_default();
    if payload.len() > CONTENT_BYTES {
        return Err(invalid("Canvas response exceeds its bound"));
    }
    encode(
        DocumentModuleFrameMetadata::ModuleApplyResponse {
            response,
            has_canvas: canvas.is_some(),
        },
        &payload,
    )
}

pub fn decode_apply_response(bytes: &[u8]) -> Result<OwnedDocumentApplyResponse, CoreError> {
    let (
        DocumentModuleFrameMetadata::ModuleApplyResponse {
            mut response,
            has_canvas,
        },
        payload,
    ) = decode(bytes)?
    else {
        return Err(invalid("Expected Document Module apply response"));
    };
    if !has_canvas {
        if !payload.is_empty() {
            return Err(invalid("Unexpected Document apply response payload"));
        }
        return Ok(response);
    }
    let ResponseEnvelope::Ok(
        ApplyResponse::Committed { outcome, .. } | ApplyResponse::NoOp { outcome, .. },
    ) = &mut response.0
    else {
        return Err(invalid("Unexpected Canvas error payload"));
    };
    if outcome.canvas.is_some() {
        return Err(invalid("Unexpected inline Canvas response"));
    }
    outcome.canvas = Some(json_content(payload)?);
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    use nodex_core_contracts::document::OWNED_DOCUMENT_CONTRACT_VERSION;
    use nodex_core_contracts::{ModuleApplyRequest, ModuleReadRequest, StoreEpoch};

    #[test]
    fn module_frames_keep_original_identities_and_binary_limits() {
        let bytes: Vec<u8> = (0..UPDATE_BYTES).map(|index| index as u8).collect();
        let request = OwnedDocumentApplyRequest(ModuleApplyRequest {
            contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
            operation_id: "original:update".into(),
            store_epoch: StoreEpoch("original:epoch".into()),
            intent: OwnedDocumentIntent::ApplyYjsUpdate {
                document_id: "document".into(),
                generation: 4,
                base_head_seq: 9,
                update_id: "original:update".into(),
                touched_block_ids: vec!["block".into()],
                update: bytes,
            },
        });
        let encoded = encode_apply(request.clone()).unwrap();
        assert!(encoded.len() < UPDATE_BYTES + 1024);
        assert_eq!(decode_apply(&encoded).unwrap(), request);
        let mut invalid = request;
        if let OwnedDocumentIntent::ApplyYjsUpdate { update, .. } = &mut invalid.0.intent {
            update.push(0);
        }
        assert!(encode_apply(invalid).is_err());
        let read = OwnedDocumentReadRequest(ModuleReadRequest {
            contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
            read: OwnedDocumentRead::SyncYjs {
                document_id: "document".into(),
                state_vector: vec![255; STATE_VECTOR_BYTES],
                history_after_head_seq: Some(9),
            },
        });
        assert_eq!(
            decode_read(&encode_read(read.clone()).unwrap()).unwrap(),
            read
        );
    }

    #[test]
    fn module_frames_reject_conflicting_inline_bytes_and_metadata_bombs() {
        let request = OwnedDocumentReadRequest(ModuleReadRequest {
            contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
            read: OwnedDocumentRead::SyncYjs {
                document_id: "document".into(),
                state_vector: vec![1],
                history_after_head_seq: None,
            },
        });
        let bytes = encode(DocumentModuleFrameMetadata::ModuleRead { request }, &[2]).unwrap();
        assert!(decode_read(&bytes).is_err());
        assert!(decode_read(&bytes[..7]).is_err());
        let mut nested = Value::Null;
        for _ in 0..33 {
            nested = serde_json::json!([nested]);
        }
        assert!(validate_json_tree(&nested, false).is_err());
        assert!(validate_json_tree(&nested, true).is_ok());
    }
}
