//! Lossless retained-package framing shared by transport and durable storage.
use super::*;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug)]
pub struct RecoveryBundleError {
    pub failure: RecoveryPackageFailure,
    pub message: String,
}
impl From<&str> for RecoveryBundleError {
    fn from(message: &str) -> Self {
        Self {
            failure: RecoveryPackageFailure {
                reason: RecoveryFailureReason::InvalidManifest,
                effect: RecoveryFailureEffect::NotApplied,
                actual: None,
                limit: None,
            },
            message: message.into(),
        }
    }
}
impl From<String> for RecoveryBundleError {
    fn from(message: String) -> Self {
        message.as_str().into()
    }
}
impl std::fmt::Display for RecoveryBundleError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}
impl std::error::Error for RecoveryBundleError {}
impl std::ops::Deref for RecoveryBundleError {
    type Target = str;
    fn deref(&self) -> &str {
        &self.message
    }
}
fn rejected(
    reason: RecoveryFailureReason,
    message: &str,
    actual: Option<usize>,
    limit: Option<usize>,
) -> RecoveryBundleError {
    RecoveryBundleError {
        message: message.into(),
        failure: RecoveryPackageFailure {
            reason,
            effect: RecoveryFailureEffect::NotApplied,
            actual: actual.map(|n| n as u64),
            limit: limit.map(|n| n as u64),
        },
    }
}

pub fn payload_hash(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

pub struct DecodedRecoveryBundle {
    pub manifest: RecoveryBundleManifest,
    pub capture: RecoveryDraftCapture,
    pub payload_hash: String,
}

/// Freeze one complete logical capture. Byte arrays in evidence use explicit JSON pointers.
pub fn encode(
    capture: &RecoveryDraftCapture,
    source_revision: &str,
) -> Result<Vec<u8>, RecoveryBundleError> {
    let mut sections: Vec<RecoveryBundleSection> = Vec::new();
    let mut bodies: Vec<Vec<u8>> = Vec::new();
    let mut add =
        |encoding: RecoverySectionEncoding, body: Vec<u8>| -> Result<String, RecoveryBundleError> {
            let hash = payload_hash(&body);
            if let Some(index) = sections.iter().enumerate().position(|(index, section)| {
                section.encoding == encoding && section.sha256 == hash && bodies[index] == body
            }) {
                return Ok(sections[index].id.clone());
            }
            if sections.len() >= MAX_RECOVERY_SECTIONS || body.len() > MAX_RECOVERY_BUNDLE_BYTES {
                return Err("Recovery sections exceed their bounds".into());
            }
            let id = sections.len().to_string();
            sections.push(RecoveryBundleSection {
                id: id.clone(),
                encoding,
                byte_length: body.len() as u32,
                sha256: hash,
            });
            bodies.push(body);
            Ok(id)
        };
    let content = match &capture.content {
        RecoveryDraftContent::Yjs {
            state,
            unintegrated_updates,
        } => RecoveryBundleContent::Yjs {
            state: add(RecoverySectionEncoding::Bytes, state.clone())?,
            unintegrated_updates: unintegrated_updates
                .iter()
                .map(|bytes| add(RecoverySectionEncoding::Bytes, bytes.clone()))
                .collect::<Result<_, _>>()?,
        },
        RecoveryDraftContent::Canvas { scene, mutations } => RecoveryBundleContent::Canvas {
            scene: scene
                .as_ref()
                .map(|value| {
                    add(
                        RecoverySectionEncoding::Json,
                        serde_json::to_vec(value).unwrap(),
                    )
                })
                .transpose()?,
            mutations: mutations
                .iter()
                .map(|value| {
                    add(
                        RecoverySectionEncoding::Json,
                        serde_json::to_vec(value).unwrap(),
                    )
                })
                .collect::<Result<_, _>>()?,
        },
    };
    let mut source = capture.source.clone();
    let mut references = Vec::new();
    extract_evidence(&mut source, "", &mut add, &mut references, 0)?;
    let source_id = add(
        RecoverySectionEncoding::Json,
        serde_json::to_vec(&source).map_err(|_| "Invalid recovery evidence")?,
    )?;
    let manifest = RecoveryBundleManifest {
        format_version: 1,
        draft_id: capture.draft_id.clone(),
        document_id: capture.document_id.clone(),
        source_store_epoch: capture.source_store_epoch.clone(),
        source_revision: source_revision.into(),
        generation: capture.generation,
        base_head_seq: capture.base_head_seq,
        created_at: capture.created_at.clone(),
        schema_key: capture.schema_key.clone(),
        schema_version: capture.schema_version,
        content,
        source: source_id,
        source_references: references,
        sections,
    };
    let metadata = serde_json::to_vec(&manifest).map_err(|_| "Invalid recovery manifest")?;
    let length = bodies
        .iter()
        .try_fold(12 + metadata.len(), |sum, body| sum.checked_add(body.len()))
        .ok_or("Recovery bundle length overflow")?;
    if metadata.len() > MAX_RECOVERY_MANIFEST_BYTES || length > MAX_RECOVERY_BUNDLE_BYTES {
        return Err("Recovery bundle exceeds its bounds".into());
    }
    let mut output = Vec::with_capacity(length);
    output.extend_from_slice(b"NDRB");
    output.extend_from_slice(&1_u32.to_le_bytes());
    output.extend_from_slice(&(metadata.len() as u32).to_le_bytes());
    output.extend_from_slice(&metadata);
    for body in bodies {
        output.extend_from_slice(&body);
    }
    Ok(output)
}

fn extract_evidence(
    value: &mut Value,
    pointer: &str,
    add: &mut impl FnMut(RecoverySectionEncoding, Vec<u8>) -> Result<String, RecoveryBundleError>,
    references: &mut Vec<RecoveryEvidenceReference>,
    depth: usize,
) -> Result<(), RecoveryBundleError> {
    if depth > 64 {
        return Err("Recovery evidence is too deeply nested".into());
    }
    match value {
        Value::Array(items)
            if items.len() >= 256
                && items
                    .iter()
                    .all(|item| item.as_u64().is_some_and(|n| n <= 255)) =>
        {
            let bytes = items
                .iter()
                .map(|item| item.as_u64().unwrap() as u8)
                .collect();
            references.push(RecoveryEvidenceReference {
                pointer: pointer.into(),
                section_id: add(RecoverySectionEncoding::Bytes, bytes)?,
                representation: None,
            });
            *value = Value::Null;
        }
        Value::Array(items) => {
            for (index, item) in items.iter_mut().enumerate() {
                extract_evidence(
                    item,
                    &format!("{pointer}/{index}"),
                    add,
                    references,
                    depth + 1,
                )?;
            }
        }
        Value::Object(fields) => {
            for (key, item) in fields {
                let key = key.replace('~', "~0").replace('/', "~1");
                extract_evidence(
                    item,
                    &format!("{pointer}/{key}"),
                    add,
                    references,
                    depth + 1,
                )?;
            }
        }
        _ => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn capture() -> RecoveryDraftCapture {
        let bytes: Vec<u8> = (0..70_020).map(|n| n as u8).collect();
        RecoveryDraftCapture {
            draft_id: "draft".into(),
            document_id: "document".into(),
            source_store_epoch: "epoch".into(),
            generation: 1,
            base_head_seq: 0,
            created_at: "2026-09-12".into(),
            schema_key: "page".into(),
            schema_version: 1,
            content: RecoveryDraftContent::Yjs {
                state: bytes.clone(),
                unintegrated_updates: vec![vec![], vec![255, 0]],
            },
            source: serde_json::json!({"state": bytes, "submission": {"update": bytes, "id": "原始"}, "~special/path": [0, 255], "unknown": {"$bytes": "unchanged"}}),
        }
    }
    #[test]
    fn recovery_bundle_preserves_evidence_and_stores_shared_bytes_once() {
        let original = capture();
        let bytes = encode(&original, "revision").unwrap();
        assert!(bytes.len() < 73_000);
        let decoded = decode(&bytes).unwrap();
        assert_eq!(decoded.capture, original);
        assert_eq!(decoded.manifest.source_revision, "revision");
        assert_eq!(decoded.payload_hash, payload_hash(&bytes));
    }
    #[test]
    fn recovery_bundle_rejects_corruption_truncation_and_future_formats() {
        let bytes = encode(&capture(), "revision").unwrap();
        for length in [0, 11, 12, bytes.len() - 1] {
            assert!(decode(&bytes[..length]).is_err());
        }
        let mut corrupt = bytes.clone();
        *corrupt.last_mut().unwrap() ^= 1;
        assert!(decode(&corrupt).is_err());
        let mut future = bytes.clone();
        future[4] = 2;
        assert!(decode(&future).is_err());
        let mut trailing = bytes;
        trailing.push(0);
        assert!(decode(&trailing).is_err());
    }
}

fn validate_manifest_tree(value: &Value) -> Result<(), RecoveryBundleError> {
    let mut pending = vec![(value, 0_usize)];
    let mut nodes = 0;
    while let Some((value, depth)) = pending.pop() {
        nodes += 1;
        if nodes > MAX_RECOVERY_MANIFEST_NODES || depth > MAX_RECOVERY_MANIFEST_DEPTH {
            return Err("Recovery manifest structure exceeds its bound".into());
        }
        match value {
            Value::Array(values) => pending.extend(values.iter().map(|item| (item, depth + 1))),
            Value::Object(values) => pending.extend(values.values().map(|item| (item, depth + 1))),
            _ => (),
        }
    }
    Ok(())
}

/// Verify framing and every section before interpreting engine content.
pub fn decode(bytes: &[u8]) -> Result<DecodedRecoveryBundle, RecoveryBundleError> {
    decode_inner(bytes, true)
}

/// Semantic analysis does not need to expand duplicate source evidence into JSON byte arrays.
pub fn decode_content(bytes: &[u8]) -> Result<DecodedRecoveryBundle, RecoveryBundleError> {
    decode_inner(bytes, false)
}

fn decode_inner(
    bytes: &[u8],
    expand_evidence: bool,
) -> Result<DecodedRecoveryBundle, RecoveryBundleError> {
    if bytes.len() > MAX_RECOVERY_BUNDLE_BYTES {
        return Err(rejected(
            RecoveryFailureReason::RequestTooLarge,
            "Recovery bundle exceeds its bound",
            Some(bytes.len()),
            Some(MAX_RECOVERY_BUNDLE_BYTES),
        ));
    }
    if bytes.len() < 12 {
        return Err("Truncated recovery header".into());
    }
    if &bytes[..4] != b"NDRB" || bytes[4..8] != 1_u32.to_le_bytes() {
        return Err(rejected(
            RecoveryFailureReason::UnsupportedFormat,
            "Unsupported recovery bundle format",
            None,
            None,
        ));
    }
    let size = u32::from_le_bytes(bytes[8..12].try_into().unwrap()) as usize;
    if size > MAX_RECOVERY_MANIFEST_BYTES {
        return Err(rejected(
            RecoveryFailureReason::ManifestTooLarge,
            "Recovery manifest exceeds its bound",
            Some(size),
            Some(MAX_RECOVERY_MANIFEST_BYTES),
        ));
    }
    if size > bytes.len() - 12 {
        return Err("Invalid recovery manifest length".into());
    }
    let metadata: Value =
        serde_json::from_slice(&bytes[12..12 + size]).map_err(|_| "Invalid recovery manifest")?;
    validate_manifest_tree(&metadata)?;
    let manifest: RecoveryBundleManifest =
        serde_json::from_value(metadata).map_err(|_| "Invalid recovery manifest")?;
    if manifest.format_version != 1 || manifest.sections.len() > MAX_RECOVERY_SECTIONS {
        return Err("Unsupported recovery manifest".into());
    }
    let mut sections = BTreeMap::new();
    let mut offset = 12 + size;
    for section in &manifest.sections {
        let end = offset
            .checked_add(section.byte_length as usize)
            .filter(|end| *end <= bytes.len())
            .ok_or("Truncated recovery section")?;
        let body = &bytes[offset..end];
        if section.sha256 != payload_hash(body) {
            return Err(rejected(
                RecoveryFailureReason::InvalidDigest,
                "Recovery section digest does not match",
                None,
                None,
            ));
        }
        if section.id.is_empty()
            || sections
                .insert(section.id.as_str(), (&section.encoding, body))
                .is_some()
        {
            return Err("Invalid recovery section identity or digest".into());
        }
        offset = end;
    }
    if offset != bytes.len() {
        return Err("Trailing recovery bytes".into());
    }
    let read =
        |id: &str, encoding: RecoverySectionEncoding| -> Result<&[u8], RecoveryBundleError> {
            let (actual, body) = sections.get(id).ok_or("Missing recovery section")?;
            if **actual != encoding {
                return Err("Invalid recovery section encoding".into());
            }
            Ok(body)
        };
    let json = |id: &str| -> Result<Value, RecoveryBundleError> {
        serde_json::from_slice(read(id, RecoverySectionEncoding::Json)?)
            .map_err(|_| "Invalid recovery JSON section".into())
    };
    let content_ids: Vec<&str> = match &manifest.content {
        RecoveryBundleContent::Yjs {
            state,
            unintegrated_updates,
        } => std::iter::once(state.as_str())
            .chain(unintegrated_updates.iter().map(String::as_str))
            .collect(),
        RecoveryBundleContent::Canvas { scene, mutations } => scene
            .iter()
            .chain(mutations.iter())
            .map(String::as_str)
            .collect(),
    };
    let mut materialized_bytes = 0_usize;
    for id in content_ids {
        let (_, body) = sections.get(id).ok_or("Missing recovery content section")?;
        materialized_bytes = materialized_bytes
            .checked_add(body.len())
            .ok_or("Recovery content length overflow")?;
        if materialized_bytes > MAX_RECOVERY_BUNDLE_BYTES {
            return Err(rejected(
                RecoveryFailureReason::RequestTooLarge,
                "Recovery content expansion exceeds its bound",
                Some(materialized_bytes),
                Some(MAX_RECOVERY_BUNDLE_BYTES),
            ));
        }
    }
    let content = match &manifest.content {
        RecoveryBundleContent::Yjs {
            state,
            unintegrated_updates,
        } => RecoveryDraftContent::Yjs {
            state: read(state, RecoverySectionEncoding::Bytes)?.to_vec(),
            unintegrated_updates: unintegrated_updates
                .iter()
                .map(|id| read(id, RecoverySectionEncoding::Bytes).map(Vec::from))
                .collect::<Result<_, _>>()?,
        },
        RecoveryBundleContent::Canvas { scene, mutations } => RecoveryDraftContent::Canvas {
            scene: scene.as_deref().map(json).transpose()?,
            mutations: mutations
                .iter()
                .map(|id| json(id))
                .collect::<Result<_, _>>()?,
        },
    };
    let mut source = json(&manifest.source)?;
    let mut pointers = BTreeSet::new();
    let mut validated_json = BTreeSet::new();
    for reference in &manifest.source_references {
        if !pointers.insert(&reference.pointer) {
            return Err("Duplicate recovery evidence reference".into());
        }
        let target = source
            .pointer_mut(&reference.pointer)
            .ok_or("Missing recovery evidence location")?;
        if !target.is_null() {
            return Err("Recovery evidence reference replaces existing content".into());
        }
        let (encoding, body) = sections
            .get(reference.section_id.as_str())
            .ok_or("Missing recovery evidence section")?;
        if reference.representation.is_some() && **encoding != RecoverySectionEncoding::Bytes {
            return Err("Invalid recovery evidence representation".into());
        }
        if expand_evidence {
            materialized_bytes = materialized_bytes
                .checked_add(body.len())
                .ok_or("Recovery evidence length overflow")?;
            if materialized_bytes > MAX_RECOVERY_BUNDLE_BYTES * 4 {
                return Err("Recovery evidence expansion exceeds its bound".into());
            }
        }
        if **encoding == RecoverySectionEncoding::Json {
            if expand_evidence {
                *target = json(&reference.section_id)?;
            } else if validated_json.insert(&reference.section_id) {
                json(&reference.section_id)?;
            }
        } else if expand_evidence {
            *target = serde_json::to_value(body).map_err(|_| "Invalid recovery evidence")?;
        }
    }
    let capture = RecoveryDraftCapture {
        draft_id: manifest.draft_id.clone(),
        document_id: manifest.document_id.clone(),
        source_store_epoch: manifest.source_store_epoch.clone(),
        generation: manifest.generation,
        base_head_seq: manifest.base_head_seq,
        created_at: manifest.created_at.clone(),
        schema_key: manifest.schema_key.clone(),
        schema_version: manifest.schema_version,
        content,
        source: if expand_evidence { source } else { Value::Null },
    };
    Ok(DecodedRecoveryBundle {
        manifest,
        capture,
        payload_hash: payload_hash(bytes),
    })
}
