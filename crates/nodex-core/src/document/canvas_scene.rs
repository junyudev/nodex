use std::cmp::Ordering;
use std::collections::{BTreeMap, HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

pub(crate) const CANVAS_SCHEMA_KEY: &str = "nodex.canvas";
pub(crate) const CANVAS_SCHEMA_VERSION: i64 = 2;
pub(crate) const CANVAS_OWNER_TYPE: &str = "canvas";
const MAX_ELEMENTS: usize = 100_000;
const MAX_FILES: usize = 10_000;
const MAX_ID_LENGTH: usize = 512;
const MAX_ORDER_KEY_LENGTH: usize = 256;
const MAX_SHARED_TEXT_UTF16: usize = 4_000_000;
const MAX_MUTATION_BYTES: usize = 2 * 1024 * 1024;
pub(crate) const CANVAS_HASH_BUCKET_COUNT: usize = 1_024;
pub(crate) const CANVAS_SCENE_HASH_VERSION: i64 = 2;
pub(crate) const MAX_CANVAS_SCENE_BYTES: usize = 16 * 1024 * 1024;
const CANVAS_BUCKET_INDEX_DOMAIN: &[u8] = b"nodex.canvas.bucket-index.v1\0";
const CANVAS_LEAF_DOMAIN: &[u8] = b"nodex.canvas.leaf.v1\0";
const CANVAS_BUCKET_DOMAIN: &[u8] = b"nodex.canvas.bucket.v1\0";
const CANVAS_ROOT_DOMAIN: &[u8] = b"nodex.canvas.root.v2\0";
const DURABLE_APP_STATE_KEYS: [&str; 4] = [
    "gridModeEnabled",
    "gridSize",
    "gridStep",
    "viewBackgroundColor",
];

#[derive(Debug, Clone, Deserialize, PartialEq, Serialize)]
pub(crate) struct CanvasElement {
    pub(crate) id: String,
    pub(crate) version: i64,
    pub(crate) version_nonce: i64,
    pub(crate) order_key: String,
    pub(crate) is_deleted: bool,
    pub(crate) value: Value,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Serialize)]
pub(crate) struct CanvasFile {
    pub(crate) id: String,
    pub(crate) mime_type: String,
    pub(crate) source: String,
    pub(crate) target_file_id: String,
    pub(crate) file_version: i64,
    pub(crate) default_name: String,
    pub(crate) created_ms: Option<i64>,
    pub(crate) value: Value,
}

impl CanvasFile {
    pub(crate) fn same_binding(&self, other: &Self) -> bool {
        self.target_file_id == other.target_file_id
            && self.file_version == other.file_version
            && self.default_name == other.default_name
            && self.mime_type == other.mime_type
    }
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Serialize)]
pub(crate) struct CanvasPageReference {
    pub(crate) source_element_id: String,
    pub(crate) target_block_id: String,
    pub(crate) title_hint: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DerivedCanvasElement {
    pub(crate) referenced_file_id: Option<String>,
    pub(crate) plain_text: String,
    pub(crate) page_reference: Option<CanvasPageReference>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct CanvasSceneCounters {
    pub(crate) element_count: i64,
    pub(crate) tombstone_count: i64,
    pub(crate) tombstone_json_bytes: i64,
    pub(crate) file_count: i64,
    pub(crate) element_json_bytes: i64,
    pub(crate) file_json_bytes: i64,
    pub(crate) scene_byte_length: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CanvasHashBucket {
    pub(crate) item_count: i64,
    pub(crate) bucket_hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CanvasSceneIncrementalMetadata {
    pub(crate) app_state_json: String,
    pub(crate) app_state_hash: String,
    pub(crate) scene_hash: String,
    pub(crate) counters: CanvasSceneCounters,
    pub(crate) hash_buckets: BTreeMap<u16, CanvasHashBucket>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum CanvasHashItemKind {
    Element,
    File,
}

impl CanvasHashItemKind {
    fn as_bytes(self) -> &'static [u8] {
        match self {
            Self::Element => b"element",
            Self::File => b"file",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CanvasHashItem {
    pub(crate) kind: CanvasHashItemKind,
    pub(crate) id: String,
    pub(crate) canonical_hash: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CanvasSemanticIntentFingerprint<'a> {
    version: u8,
    profile_id: &'a str,
    library_id: &'a str,
    project_id: Option<&'a str>,
    expected_store_epoch: &'a str,
    document_id: &'a str,
    generation: i64,
    base_head_seq: i64,
    mutation_id: &'a str,
    mutation: &'a Value,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Serialize)]
pub(crate) struct CanvasScene {
    pub(crate) elements: Vec<CanvasElement>,
    pub(crate) app_state: Map<String, Value>,
    pub(crate) files: BTreeMap<String, CanvasFile>,
    pub(crate) page_references: Vec<CanvasPageReference>,
    pub(crate) plain_text: String,
    pub(crate) preview: String,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct CanvasMutation {
    pub(crate) element_candidates: Vec<CanvasElement>,
    pub(crate) app_state_intents: BTreeMap<String, CanvasAppStateIntent>,
    pub(crate) file_additions: BTreeMap<String, CanvasFile>,
    pub(crate) canonical_value: Value,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct CanvasAppStateIntent {
    pub(crate) expected: OptionalJson,
    pub(crate) value: OptionalJson,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum OptionalJson {
    Absent,
    Value(Value),
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct AppliedCanvasMutation {
    pub(crate) scene: CanvasScene,
    pub(crate) changed_element_ids: Vec<String>,
    pub(crate) applied_app_state_keys: Vec<String>,
    pub(crate) skipped_app_state_keys: Vec<String>,
    pub(crate) added_file_ids: Vec<String>,
    pub(crate) removed_file_ids: Vec<String>,
    pub(crate) app_state_changed: bool,
    pub(crate) event_delta: Value,
}

impl AppliedCanvasMutation {
    pub(crate) fn changed(&self) -> bool {
        !self.changed_element_ids.is_empty()
            || !self.added_file_ids.is_empty()
            || !self.removed_file_ids.is_empty()
            || self.app_state_changed
    }
}

impl CanvasScene {
    pub(crate) fn empty() -> Self {
        materialize_scene(Vec::new(), Map::new(), BTreeMap::new())
            .expect("empty Canvas scene is valid")
    }

    pub(crate) fn canonical_value(&self) -> Value {
        let elements = self
            .elements
            .iter()
            .map(|element| element.value.clone())
            .collect::<Vec<_>>();
        let files = self
            .files
            .iter()
            .map(|(id, file)| (id.clone(), file.value.clone()))
            .collect::<Map<_, _>>();
        let references = self
            .page_references
            .iter()
            .map(|reference| {
                json!({
                    "sourceElementId": reference.source_element_id,
                    "targetBlockId": reference.target_block_id,
                    "titleHint": reference.title_hint,
                })
            })
            .map(remove_null_fields)
            .collect::<Vec<_>>();
        json!({
            "kind": "canvas_scene",
            "schemaVersion": CANVAS_SCHEMA_VERSION,
            "elements": elements,
            "appState": self.app_state,
            "files": files,
            "pageReferences": references,
            "plainText": self.plain_text,
            "preview": self.preview,
        })
    }

    pub(crate) fn canonical_json(&self) -> Result<String, StoreError> {
        canonical_json(&self.canonical_value())
    }
}

pub(crate) fn compact_canvas_tombstones(scene: &CanvasScene) -> Result<CanvasScene, StoreError> {
    let elements = scene
        .elements
        .iter()
        .filter(|element| !element.is_deleted)
        .cloned()
        .collect::<Vec<_>>();
    let referenced_file_ids = elements
        .iter()
        .filter_map(|element| {
            let object = element.value.as_object()?;
            (object.get("type").and_then(Value::as_str) == Some("image"))
                .then(|| object.get("fileId").and_then(Value::as_str))
                .flatten()
        })
        .collect::<HashSet<_>>();
    let files = scene
        .files
        .iter()
        .filter(|(file_id, _)| referenced_file_ids.contains(file_id.as_str()))
        .map(|(file_id, file)| (file_id.clone(), file.clone()))
        .collect::<BTreeMap<_, _>>();
    materialize_scene(elements, scene.app_state.clone(), files)
}

pub(crate) fn derive_canvas_element(
    element: &CanvasElement,
) -> Result<DerivedCanvasElement, StoreError> {
    if element.is_deleted {
        return Ok(DerivedCanvasElement {
            referenced_file_id: None,
            plain_text: String::new(),
            page_reference: None,
        });
    }
    let object = element
        .value
        .as_object()
        .ok_or_else(|| invalid("Canvas element is not an object"))?;
    let referenced_file_id = (object.get("type").and_then(Value::as_str) == Some("image"))
        .then(|| {
            object
                .get("fileId")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .flatten();
    Ok(DerivedCanvasElement {
        referenced_file_id,
        plain_text: element_plain_text(element).unwrap_or_default().to_owned(),
        page_reference: read_page_reference(element).transpose()?,
    })
}

pub(crate) fn canvas_hash_bucket(kind: CanvasHashItemKind, id: &str) -> u16 {
    let mut hasher = Sha256::new();
    hasher.update(CANVAS_BUCKET_INDEX_DOMAIN);
    hasher.update(kind.as_bytes());
    hasher.update([0]);
    hasher.update(id.as_bytes());
    let digest = hasher.finalize();
    (u16::from_be_bytes([digest[0], digest[1]]) >> 6) & 0x03ff
}

pub(crate) fn canvas_leaf_hash(item: &CanvasHashItem) -> Result<[u8; 32], StoreError> {
    let canonical_hash = decode_sha256(&item.canonical_hash)?;
    let mut hasher = Sha256::new();
    hasher.update(CANVAS_LEAF_DOMAIN);
    hasher.update(item.kind.as_bytes());
    hasher.update([0]);
    update_length_prefixed(&mut hasher, item.id.as_bytes())?;
    hasher.update(canonical_hash);
    Ok(hasher.finalize().into())
}

pub(crate) fn canvas_bucket_hash(
    bucket_index: u16,
    items: &[CanvasHashItem],
) -> Result<String, StoreError> {
    if usize::from(bucket_index) >= CANVAS_HASH_BUCKET_COUNT {
        return Err(internal("Canvas hash bucket index is out of range"));
    }
    let mut sorted = items.to_vec();
    sorted.sort_by(|left, right| {
        left.kind
            .cmp(&right.kind)
            .then_with(|| left.id.cmp(&right.id))
    });
    let mut hasher = Sha256::new();
    hasher.update(CANVAS_BUCKET_DOMAIN);
    hasher.update(bucket_index.to_be_bytes());
    hasher.update(
        u64::try_from(sorted.len())
            .map_err(|_| internal("Canvas hash bucket item count overflowed"))?
            .to_be_bytes(),
    );
    for item in &sorted {
        hasher.update(canvas_leaf_hash(item)?);
    }
    Ok(hex_digest(hasher.finalize().into()))
}

pub(crate) fn canvas_scene_root_hash(
    schema_version: i64,
    app_state_hash: &str,
    element_count: i64,
    file_count: i64,
    buckets: &BTreeMap<u16, CanvasHashBucket>,
) -> Result<String, StoreError> {
    if schema_version < 1 || element_count < 0 || file_count < 0 {
        return Err(internal("Canvas root hash coordinates are invalid"));
    }
    let app_state_hash = decode_sha256(app_state_hash)?;
    let mut hasher = Sha256::new();
    hasher.update(CANVAS_ROOT_DOMAIN);
    hasher.update(schema_version.to_be_bytes());
    hasher.update(app_state_hash);
    hasher.update(
        u64::try_from(element_count)
            .map_err(|_| internal("Canvas element count overflowed"))?
            .to_be_bytes(),
    );
    hasher.update(
        u64::try_from(file_count)
            .map_err(|_| internal("Canvas file count overflowed"))?
            .to_be_bytes(),
    );
    for bucket_index in 0..CANVAS_HASH_BUCKET_COUNT {
        let bucket_index = u16::try_from(bucket_index)
            .map_err(|_| internal("Canvas hash bucket index overflowed"))?;
        let bucket_hash = if let Some(bucket) = buckets.get(&bucket_index) {
            if bucket.item_count < 1 {
                return Err(internal("Canvas sparse hash bucket is empty"));
            }
            decode_sha256(&bucket.bucket_hash)?
        } else {
            decode_sha256(&canvas_bucket_hash(bucket_index, &[])?)?
        };
        hasher.update(bucket_hash);
    }
    Ok(hex_digest(hasher.finalize().into()))
}

pub(crate) fn compute_canvas_scene_incremental_metadata(
    scene: &CanvasScene,
) -> Result<CanvasSceneIncrementalMetadata, StoreError> {
    let app_state_json = canonical_json(&Value::Object(scene.app_state.clone()))?;
    let app_state_hash = sha256_bytes(app_state_json.as_bytes());
    let mut element_json_bytes = 0_i64;
    let mut tombstone_json_bytes = 0_i64;
    let mut file_json_bytes = 0_i64;
    let mut tombstone_count = 0_i64;
    let mut items = BTreeMap::<u16, Vec<CanvasHashItem>>::new();
    for element in &scene.elements {
        let element_json = canonical_json(&element.value)?;
        element_json_bytes = checked_json_bytes(element_json_bytes, &element_json)?;
        if element.is_deleted {
            tombstone_json_bytes = checked_json_bytes(tombstone_json_bytes, &element_json)?;
        }
        tombstone_count += i64::from(element.is_deleted);
        let item = CanvasHashItem {
            kind: CanvasHashItemKind::Element,
            id: element.id.clone(),
            canonical_hash: sha256_bytes(element_json.as_bytes()),
        };
        items
            .entry(canvas_hash_bucket(item.kind, &item.id))
            .or_default()
            .push(item);
    }
    for (id, file) in &scene.files {
        let file_json = canonical_json(&file.value)?;
        file_json_bytes = checked_json_bytes(file_json_bytes, &file_json)?;
        let item = CanvasHashItem {
            kind: CanvasHashItemKind::File,
            id: id.clone(),
            canonical_hash: sha256_bytes(file_json.as_bytes()),
        };
        items
            .entry(canvas_hash_bucket(item.kind, &item.id))
            .or_default()
            .push(item);
    }
    let hash_buckets = items
        .into_iter()
        .map(|(bucket_index, items)| {
            Ok((
                bucket_index,
                CanvasHashBucket {
                    item_count: i64::try_from(items.len())
                        .map_err(|_| internal("Canvas hash bucket item count overflowed"))?,
                    bucket_hash: canvas_bucket_hash(bucket_index, &items)?,
                },
            ))
        })
        .collect::<Result<BTreeMap<_, _>, StoreError>>()?;
    let element_count = i64::try_from(scene.elements.len())
        .map_err(|_| internal("Canvas element count overflowed"))?;
    let file_count =
        i64::try_from(scene.files.len()).map_err(|_| internal("Canvas file count overflowed"))?;
    let scene_json = scene.canonical_json()?;
    if scene_json.len() > MAX_CANVAS_SCENE_BYTES {
        return Err(invalid("Canvas scene exceeds its snapshot byte bound"));
    }
    let scene_byte_length = i64::try_from(scene_json.len())
        .map_err(|_| internal("Canvas scene byte length overflowed"))?;
    let scene_hash = canvas_scene_root_hash(
        CANVAS_SCHEMA_VERSION,
        &app_state_hash,
        element_count,
        file_count,
        &hash_buckets,
    )?;
    Ok(CanvasSceneIncrementalMetadata {
        app_state_json,
        app_state_hash,
        scene_hash,
        counters: CanvasSceneCounters {
            element_count,
            tombstone_count,
            tombstone_json_bytes,
            file_count,
            element_json_bytes,
            file_json_bytes,
            scene_byte_length,
        },
        hash_buckets,
    })
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn canvas_semantic_intent_fingerprint(
    profile_id: &str,
    library_id: &str,
    project_id: Option<&str>,
    expected_store_epoch: &str,
    document_id: &str,
    generation: i64,
    base_head_seq: i64,
    mutation_id: &str,
    mutation: &Value,
) -> Result<Vec<u8>, StoreError> {
    serde_json::to_vec(&CanvasSemanticIntentFingerprint {
        version: 2,
        profile_id,
        library_id,
        project_id,
        expected_store_epoch,
        document_id,
        generation,
        base_head_seq,
        mutation_id,
        mutation,
    })
    .map_err(|_| internal("Canvas semantic intent cannot be fingerprinted"))
}

fn checked_json_bytes(current: i64, value: &str) -> Result<i64, StoreError> {
    let length =
        i64::try_from(value.len()).map_err(|_| internal("Canvas JSON byte length overflowed"))?;
    current
        .checked_add(length)
        .ok_or_else(|| internal("Canvas JSON byte counter overflowed"))
}

fn update_length_prefixed(hasher: &mut Sha256, value: &[u8]) -> Result<(), StoreError> {
    hasher.update(
        u64::try_from(value.len())
            .map_err(|_| internal("Canvas hash value length overflowed"))?
            .to_be_bytes(),
    );
    hasher.update(value);
    Ok(())
}

fn sha256_bytes(value: &[u8]) -> String {
    let digest: [u8; 32] = Sha256::digest(value).into();
    hex_digest(digest)
}

fn decode_sha256(value: &str) -> Result<[u8; 32], StoreError> {
    if value.len() != 64 {
        return Err(internal("Canvas SHA-256 evidence has invalid length"));
    }
    let mut decoded = [0_u8; 32];
    for (index, pair) in value.as_bytes().chunks_exact(2).enumerate() {
        decoded[index] = decode_hex_nibble(pair[0])
            .and_then(|high| decode_hex_nibble(pair[1]).map(|low| (high << 4) | low))
            .ok_or_else(|| internal("Canvas SHA-256 evidence is not lowercase hexadecimal"))?;
    }
    Ok(decoded)
}

fn decode_hex_nibble(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        _ => None,
    }
}

fn hex_digest(value: [u8; 32]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(64);
    for byte in value {
        output.push(char::from(HEX[usize::from(byte >> 4)]));
        output.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    output
}

pub(crate) fn parse_canvas_mutation(value: &Value) -> Result<CanvasMutation, StoreError> {
    let object = exact_object_exact(
        value,
        "Canvas mutation",
        &["elementCandidates", "appStateIntents", "fileAdditions"],
    )?;
    let element_values = object["elementCandidates"]
        .as_array()
        .ok_or_else(|| invalid("Canvas elementCandidates must be an array"))?;
    if element_values.len() > MAX_ELEMENTS {
        return Err(invalid("Canvas mutation has too many element candidates"));
    }
    let mut element_candidates = Vec::with_capacity(element_values.len());
    let mut element_ids = HashSet::new();
    for (ordinal, element) in element_values.iter().enumerate() {
        let parsed = parse_element(element, None, format!("candidate:{ordinal}"))?;
        if !element_ids.insert(parsed.id.clone()) {
            return Err(invalid("Canvas mutation repeats an element identity"));
        }
        element_candidates.push(parsed);
    }
    let app_state = object["appStateIntents"]
        .as_object()
        .ok_or_else(|| invalid("Canvas appStateIntents must be an object"))?;
    let mut app_state_intents = BTreeMap::new();
    for (key, value) in app_state {
        if !DURABLE_APP_STATE_KEYS.contains(&key.as_str()) {
            return Err(invalid(format!(
                "Canvas mutation contains non-durable appState key {key}"
            )));
        }
        let intent = exact_object_exact(value, "Canvas appState intent", &["expected", "value"])?;
        app_state_intents.insert(
            key.clone(),
            CanvasAppStateIntent {
                expected: parse_optional_json(&intent["expected"], key)?,
                value: parse_optional_json(&intent["value"], key)?,
            },
        );
    }
    let file_values = object["fileAdditions"]
        .as_object()
        .ok_or_else(|| invalid("Canvas fileAdditions must be an object"))?;
    if file_values.len() > MAX_FILES {
        return Err(invalid("Canvas mutation has too many file additions"));
    }
    let mut file_additions = BTreeMap::new();
    for (id, value) in file_values {
        file_additions.insert(id.clone(), parse_file(value, id)?);
    }
    let canonical_value = json!({
        "elementCandidates": element_candidates
            .iter()
            .map(|element| element.value.clone())
            .collect::<Vec<_>>(),
        "appStateIntents": app_state_intents.iter().map(|(key, intent)| {
            (key.clone(), json!({
                "expected": optional_value(&intent.expected),
                "value": optional_value(&intent.value),
            }))
        }).collect::<Map<_, _>>(),
        "fileAdditions": file_additions.iter().map(|(id, file)| {
            (id.clone(), file.value.clone())
        }).collect::<Map<_, _>>(),
    });
    if canonical_json(&canonical_value)?.len() > MAX_MUTATION_BYTES {
        return Err(invalid("Canvas mutation exceeds its byte bound"));
    }
    Ok(CanvasMutation {
        element_candidates,
        app_state_intents,
        file_additions,
        canonical_value,
    })
}

pub(crate) fn materialize_loaded_scene(
    elements: Vec<CanvasElement>,
    app_state: &Value,
    files: BTreeMap<String, CanvasFile>,
) -> Result<CanvasScene, StoreError> {
    let app_state = pick_app_state(
        app_state
            .as_object()
            .ok_or_else(|| corrupt("Canvas appState is not an object"))?,
    )?;
    materialize_scene(elements, app_state, files)
}

pub(crate) fn parse_canvas_scene(value: &Value) -> Result<CanvasScene, StoreError> {
    let object = value
        .as_object()
        .ok_or_else(|| corrupt("Canvas checkpoint must be an object"))?;
    if object.get("kind").and_then(Value::as_str) != Some("canvas_scene")
        || object.get("schemaVersion").and_then(Value::as_i64) != Some(CANVAS_SCHEMA_VERSION)
    {
        return Err(corrupt("Canvas checkpoint schema identity is invalid"));
    }
    let element_values = object
        .get("elements")
        .and_then(Value::as_array)
        .ok_or_else(|| corrupt("Canvas checkpoint elements are invalid"))?;
    let elements = element_values
        .iter()
        .enumerate()
        .map(|(ordinal, value)| {
            parse_element(value, None, legacy_order_key(ordinal)).map_err(|error| {
                StoreError::new(StoreErrorCode::StoreCorrupt, error.message, false)
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    let file_values = object
        .get("files")
        .and_then(Value::as_object)
        .ok_or_else(|| corrupt("Canvas checkpoint files are invalid"))?;
    let files = file_values
        .iter()
        .map(|(id, value)| parse_stored_file(value, id).map(|file| (id.clone(), file)))
        .collect::<Result<BTreeMap<_, _>, _>>()?;
    let app_state = object
        .get("appState")
        .ok_or_else(|| corrupt("Canvas checkpoint appState is missing"))?;
    let scene = materialize_loaded_scene(elements, app_state, files)?;
    if scene.canonical_value() != *value {
        return Err(corrupt(
            "Canvas checkpoint does not match its derived projection",
        ));
    }
    Ok(scene)
}

pub(crate) fn prepare_canvas_restore(
    current: &CanvasScene,
    target: &CanvasScene,
    restore_identity: &str,
) -> Result<Option<CanvasMutation>, StoreError> {
    if restore_identity.is_empty() || restore_identity.len() > MAX_ID_LENGTH {
        return Err(invalid("Canvas restore identity is invalid"));
    }
    if semantic_fingerprint(current)? == semantic_fingerprint(target)? {
        return Ok(None);
    }
    let target = restore_file_slots(current, target, restore_identity)?;
    let current_by_id = current
        .elements
        .iter()
        .map(|element| (element.id.as_str(), element))
        .collect::<HashMap<_, _>>();
    let target_ids = target
        .elements
        .iter()
        .map(|element| element.id.as_str())
        .collect::<HashSet<_>>();
    let mut candidates = target
        .elements
        .iter()
        .map(|target| {
            restored_element(
                target,
                current_by_id.get(target.id.as_str()).copied(),
                restore_identity,
                false,
            )
        })
        .collect::<Result<Vec<_>, _>>()?;
    for current in &current.elements {
        if target_ids.contains(current.id.as_str()) {
            continue;
        }
        candidates.push(restored_element(
            current,
            Some(current),
            restore_identity,
            true,
        )?);
    }
    let app_state_intents = DURABLE_APP_STATE_KEYS
        .into_iter()
        .map(|key| {
            (
                key.to_owned(),
                json!({
                    "expected": current.app_state.get(key).map_or_else(
                        || json!({ "kind": "absent" }),
                        |value| json!({ "kind": "value", "value": value }),
                    ),
                    "value": target.app_state.get(key).map_or_else(
                        || json!({ "kind": "absent" }),
                        |value| json!({ "kind": "value", "value": value }),
                    ),
                }),
            )
        })
        .collect::<Map<_, _>>();
    let file_additions = target
        .files
        .iter()
        .map(|(id, file)| (id.clone(), file.value.clone()))
        .collect::<Map<_, _>>();
    parse_canvas_mutation(&json!({
        "elementCandidates": candidates
            .into_iter()
            .map(|element| element.value)
            .collect::<Vec<_>>(),
        "appStateIntents": app_state_intents,
        "fileAdditions": file_additions,
    }))
    .map(Some)
}

/// Scene slot identity is immutable while occupied. A forward restore gives
/// conflicting historical bindings fresh slots and rewrites image references.
fn restore_file_slots(
    current: &CanvasScene,
    target: &CanvasScene,
    restore_identity: &str,
) -> Result<CanvasScene, StoreError> {
    let mut value = target.canonical_value();
    let mut replacements = BTreeMap::new();
    for (id, file) in &target.files {
        let Some(existing) = current.files.get(id) else {
            continue;
        };
        if existing.same_binding(file) {
            continue;
        }
        let mut attempt = 0;
        let replacement = loop {
            let candidate = crate::domain::identity::stable_uuid_v7(
                restore_identity,
                "restored_canvas_slot",
                &format!("{id}:{attempt}"),
            );
            if !current.files.contains_key(&candidate)
                && !target.files.contains_key(&candidate)
                && !replacements.values().any(|id| id == &candidate)
            {
                break candidate;
            }
            attempt += 1;
            if attempt > 1000 {
                return Err(invalid("Canvas restore cannot allocate an image slot"));
            }
        };
        let mut binding = file.value.clone();
        binding["id"] = json!(replacement);
        value["files"]
            .as_object_mut()
            .ok_or_else(|| invalid("Canvas files are unavailable"))?
            .remove(id);
        value["files"][&replacement] = binding;
        replacements.insert(id.clone(), replacement);
    }
    if let Some(elements) = value["elements"].as_array_mut() {
        for element in elements {
            if element.get("type").and_then(Value::as_str) != Some("image") {
                continue;
            }
            if let Some(replacement) = element
                .get("fileId")
                .and_then(Value::as_str)
                .and_then(|id| replacements.get(id))
            {
                element["fileId"] = json!(replacement);
            }
        }
    }
    parse_canvas_scene(&value)
}

pub(crate) fn apply_canvas_mutation(
    current: &CanvasScene,
    mutation: &CanvasMutation,
) -> Result<AppliedCanvasMutation, StoreError> {
    let mut elements = current
        .elements
        .iter()
        .cloned()
        .map(|element| (element.id.clone(), element))
        .collect::<HashMap<_, _>>();
    let mut changed_element_ids = Vec::new();
    for (ordinal, candidate) in mutation.element_candidates.iter().enumerate() {
        let winner = match elements.get(&candidate.id) {
            Some(current) => choose_element_winner(current, candidate)?,
            None => candidate.clone(),
        };
        if elements
            .get(&candidate.id)
            .is_some_and(|current| current.value == winner.value)
        {
            continue;
        }
        let existing_order = elements
            .get(&candidate.id)
            .map(|element| element.order_key.clone());
        let mut winner = winner;
        winner.order_key = winner
            .value
            .get("index")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .or(existing_order)
            .unwrap_or_else(|| legacy_order_key(current.elements.len() + ordinal));
        changed_element_ids.push(winner.id.clone());
        elements.insert(winner.id.clone(), winner);
    }

    let mut app_state = current.app_state.clone();
    let mut applied_app_state_keys = Vec::new();
    let mut skipped_app_state_keys = Vec::new();
    let mut app_state_changed = false;
    for (key, intent) in &mutation.app_state_intents {
        if !optional_matches(app_state.get(key), &intent.expected) {
            skipped_app_state_keys.push(key.clone());
            continue;
        }
        applied_app_state_keys.push(key.clone());
        let before = app_state.get(key).cloned();
        match &intent.value {
            OptionalJson::Absent => {
                app_state.remove(key);
            }
            OptionalJson::Value(value) => {
                app_state.insert(key.clone(), value.clone());
            }
        }
        app_state_changed |= before != app_state.get(key).cloned();
    }

    let mut combined_files = current.files.clone();
    for (id, file) in &mutation.file_additions {
        if let Some(current) = combined_files.get(id) {
            if !current.same_binding(file) {
                return Err(invalid(format!(
                    "Canvas image slot {id} cannot be redefined"
                )));
            }
            continue;
        }
        combined_files.insert(id.clone(), file.clone());
    }
    let referenced = elements
        .values()
        .filter(|element| !element.is_deleted)
        .filter_map(|element| {
            let object = element.value.as_object()?;
            (object.get("type").and_then(Value::as_str) == Some("image"))
                .then(|| object.get("fileId").and_then(Value::as_str))
                .flatten()
                .map(str::to_owned)
        })
        .collect::<HashSet<_>>();
    for id in &referenced {
        if !combined_files.contains_key(id) {
            return Err(invalid(format!(
                "Canvas image references missing managed file {id}"
            )));
        }
    }
    let files = combined_files
        .into_iter()
        .filter(|(id, _)| referenced.contains(id))
        .collect::<BTreeMap<_, _>>();
    let mut added_file_ids = files
        .keys()
        .filter(|id| !current.files.contains_key(*id))
        .cloned()
        .collect::<Vec<_>>();
    let mut removed_file_ids = current
        .files
        .keys()
        .filter(|id| !files.contains_key(*id))
        .cloned()
        .collect::<Vec<_>>();
    changed_element_ids.sort();
    applied_app_state_keys.sort();
    skipped_app_state_keys.sort();
    added_file_ids.sort();
    removed_file_ids.sort();
    let mut elements = elements.into_values().collect::<Vec<_>>();
    elements.sort_by(|left, right| {
        left.order_key
            .cmp(&right.order_key)
            .then_with(|| left.id.cmp(&right.id))
    });
    let scene = materialize_scene(elements, app_state, files)?;
    let changed_elements = changed_element_ids
        .iter()
        .filter_map(|id| {
            scene
                .elements
                .iter()
                .find(|element| &element.id == id)
                .map(|element| element.value.clone())
        })
        .collect::<Vec<_>>();
    let file_additions = added_file_ids
        .iter()
        .filter_map(|id| {
            scene
                .files
                .get(id)
                .map(|file| (id.clone(), file.value.clone()))
        })
        .collect::<Map<_, _>>();
    let event_delta = json!({
        "elementUpdates": changed_elements,
        "appState": scene.app_state,
        "fileAdditions": file_additions,
        "removedFileIds": removed_file_ids,
    });
    Ok(AppliedCanvasMutation {
        scene,
        changed_element_ids,
        applied_app_state_keys,
        skipped_app_state_keys,
        added_file_ids,
        removed_file_ids,
        app_state_changed,
        event_delta,
    })
}

pub(crate) fn parse_stored_element(
    value: &Value,
    expected_id: &str,
    order_key: String,
) -> Result<CanvasElement, StoreError> {
    parse_element(value, Some(expected_id), order_key)
        .map_err(|error| StoreError::new(StoreErrorCode::StoreCorrupt, error.message, false))
}

pub(crate) fn parse_stored_file(
    value: &Value,
    expected_id: &str,
) -> Result<CanvasFile, StoreError> {
    parse_file(value, expected_id)
        .map_err(|error| StoreError::new(StoreErrorCode::StoreCorrupt, error.message, false))
}

pub(crate) fn canonical_json(value: &Value) -> Result<String, StoreError> {
    serde_json::to_string(value).map_err(|_| internal("Canvas JSON could not be encoded"))
}

fn materialize_scene(
    elements: Vec<CanvasElement>,
    app_state: Map<String, Value>,
    files: BTreeMap<String, CanvasFile>,
) -> Result<CanvasScene, StoreError> {
    if elements.len() > MAX_ELEMENTS || files.len() > MAX_FILES {
        return Err(invalid("Canvas scene exceeds its aggregate bound"));
    }
    let mut ids = HashSet::new();
    if elements.iter().any(|element| !ids.insert(&element.id)) {
        return Err(invalid("Canvas scene repeats an element identity"));
    }
    for element in &elements {
        if element.is_deleted {
            continue;
        }
        let object = element
            .value
            .as_object()
            .ok_or_else(|| invalid("Canvas element is not an object"))?;
        if object.get("type").and_then(Value::as_str) == Some("image")
            && let Some(file_id) = object.get("fileId").and_then(Value::as_str)
            && !files.contains_key(file_id)
        {
            return Err(invalid(format!(
                "Canvas image references missing managed file {file_id}"
            )));
        }
    }
    let page_references = elements
        .iter()
        .filter(|element| !element.is_deleted)
        .filter_map(read_page_reference)
        .collect::<Result<Vec<_>, _>>()?;
    let plain_text = truncate_utf16(
        &elements
            .iter()
            .filter(|element| !element.is_deleted)
            .filter_map(element_plain_text)
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        MAX_SHARED_TEXT_UTF16,
    );
    let preview = truncate_utf16(
        &plain_text.split_whitespace().collect::<Vec<_>>().join(" "),
        280,
    );
    Ok(CanvasScene {
        elements,
        app_state,
        files,
        page_references,
        plain_text,
        preview,
    })
}

fn parse_element(
    value: &Value,
    expected_id: Option<&str>,
    fallback_order_key: String,
) -> Result<CanvasElement, StoreError> {
    let mut object = value
        .as_object()
        .cloned()
        .ok_or_else(|| invalid("Canvas element must be an object"))?;
    let id = require_identity(object.get("id"), "Canvas element.id")?;
    if expected_id.is_some_and(|expected| expected != id) {
        return Err(invalid("Canvas element identity does not match its row"));
    }
    let version = require_integer(object.get("version"), "Canvas element.version", 1)?;
    let version_nonce =
        require_integer(object.get("versionNonce"), "Canvas element.versionNonce", 0)?;
    let is_deleted = object
        .get("isDeleted")
        .and_then(Value::as_bool)
        .ok_or_else(|| invalid("Canvas element.isDeleted must be boolean"))?;
    let index = object
        .get("index")
        .map(|value| {
            value
                .as_str()
                .filter(|value| !value.is_empty() && value.len() <= MAX_ORDER_KEY_LENGTH)
                .map(str::to_owned)
                .ok_or_else(|| invalid("Canvas element.index must be a bounded string"))
        })
        .transpose()?;
    canonicalize_page_reference(&mut object)?;
    Ok(CanvasElement {
        id,
        version,
        version_nonce,
        order_key: index.unwrap_or(fallback_order_key),
        is_deleted,
        value: Value::Object(object),
    })
}

fn parse_file(value: &Value, expected_id: &str) -> Result<CanvasFile, StoreError> {
    let object = exact_object(
        value,
        "Canvas file",
        &["id", "mimeType", "source", "fileVersion", "defaultName"],
    )?;
    let unsupported = object.keys().find(|key| {
        !matches!(
            key.as_str(),
            "id" | "mimeType" | "source" | "fileVersion" | "defaultName" | "created"
        )
    });
    if let Some(key) = unsupported {
        return Err(invalid(format!(
            "Canvas file contains unsupported field {key}"
        )));
    }
    let id = require_identity(object.get("id"), "Canvas file.id")?;
    if id != expected_id {
        return Err(invalid("Canvas file identity does not match its map key"));
    }
    let mime_type = object
        .get("mimeType")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= 256)
        .map(str::to_owned)
        .ok_or_else(|| invalid("Canvas file.mimeType must be a bounded string"))?;
    let source = object
        .get("source")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| invalid("Canvas file.source must be a managed asset URI"))?;
    let target_file_id = crate::domain::derived_records::parse_page_file_source(&source)
        .ok_or_else(|| invalid("Canvas file.source must be a canonical Library File URI"))?;
    let file_version = require_integer(object.get("fileVersion"), "Canvas file.fileVersion", 1)?;
    let default_name = object
        .get("defaultName")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("Canvas file.defaultName is required"))?;
    let normalized_name = crate::domain::file_path::normalize_file_name(default_name)?;
    if normalized_name != default_name {
        return Err(invalid("Canvas file.defaultName must be canonical"));
    }
    let created_ms = object
        .get("created")
        .map(|value| require_integer(Some(value), "Canvas file.created", 0))
        .transpose()?;
    Ok(CanvasFile {
        id,
        mime_type,
        source,
        target_file_id,
        file_version,
        default_name: normalized_name,
        created_ms,
        value: Value::Object(object.clone()),
    })
}

fn pick_app_state(input: &Map<String, Value>) -> Result<Map<String, Value>, StoreError> {
    let mut output = Map::new();
    for key in DURABLE_APP_STATE_KEYS {
        let Some(value) = input.get(key) else {
            continue;
        };
        validate_app_state_value(key, value)?;
        output.insert(key.to_owned(), value.clone());
    }
    Ok(output)
}

fn parse_optional_json(value: &Value, key: &str) -> Result<OptionalJson, StoreError> {
    let object = value
        .as_object()
        .ok_or_else(|| invalid("Canvas optional appState value must be an object"))?;
    match object.get("kind").and_then(Value::as_str) {
        Some("absent") if object.len() == 1 => Ok(OptionalJson::Absent),
        Some("value") if object.len() == 2 && object.contains_key("value") => {
            let value = object["value"].clone();
            validate_app_state_value(key, &value)?;
            Ok(OptionalJson::Value(value))
        }
        _ => Err(invalid(
            "Canvas optional appState value must be exact absent or value",
        )),
    }
}

fn optional_value(value: &OptionalJson) -> Value {
    match value {
        OptionalJson::Absent => json!({ "kind": "absent" }),
        OptionalJson::Value(value) => json!({ "kind": "value", "value": value }),
    }
}

pub(crate) fn optional_matches(current: Option<&Value>, expected: &OptionalJson) -> bool {
    match expected {
        OptionalJson::Absent => current.is_none(),
        OptionalJson::Value(expected) => current == Some(expected),
    }
}

fn validate_app_state_value(key: &str, value: &Value) -> Result<(), StoreError> {
    match key {
        "gridModeEnabled" if value.is_boolean() => Ok(()),
        "gridSize" | "gridStep"
            if value.is_null() || value.as_f64().is_some_and(|value| value > 0.0) =>
        {
            Ok(())
        }
        "viewBackgroundColor" if value.as_str().is_some_and(|value| value.len() <= 128) => Ok(()),
        _ => Err(invalid(format!("Canvas appState.{key} is invalid"))),
    }
}

pub(crate) fn choose_element_winner(
    left: &CanvasElement,
    right: &CanvasElement,
) -> Result<CanvasElement, StoreError> {
    if left.id != right.id {
        return Err(invalid(
            "Canvas element contenders have different identities",
        ));
    }
    let ordering = left
        .version
        .cmp(&right.version)
        .then_with(|| right.version_nonce.cmp(&left.version_nonce));
    match ordering {
        Ordering::Greater => return Ok(left.clone()),
        Ordering::Less => return Ok(right.clone()),
        Ordering::Equal => {}
    }
    let left_json = canonical_json(&left.value)?;
    let right_json = canonical_json(&right.value)?;
    let left_hash = element_tie_hash(&left_json);
    let right_hash = element_tie_hash(&right_json);
    if left_hash != right_hash {
        return Ok(if left_hash < right_hash {
            left.clone()
        } else {
            right.clone()
        });
    }
    Ok(if left_json <= right_json {
        left.clone()
    } else {
        right.clone()
    })
}

fn semantic_fingerprint(scene: &CanvasScene) -> Result<String, StoreError> {
    let elements = scene
        .elements
        .iter()
        .filter(|element| !element.is_deleted)
        .map(|element| {
            let mut value = element.value.clone();
            if let Some(object) = value.as_object_mut() {
                object.remove("version");
                object.remove("versionNonce");
            }
            value
        })
        .collect::<Vec<_>>();
    let files = scene
        .files
        .iter()
        .map(|(id, file)| (id.clone(), file.value.clone()))
        .collect::<Map<_, _>>();
    canonical_json(&json!({
        "schemaVersion": 1,
        "elements": elements,
        "appState": scene.app_state,
        "files": files,
    }))
}

fn restored_element(
    target: &CanvasElement,
    current: Option<&CanvasElement>,
    restore_identity: &str,
    deleted: bool,
) -> Result<CanvasElement, StoreError> {
    let next_version = current
        .map_or(0, |element| element.version)
        .max(target.version)
        .checked_add(1)
        .ok_or_else(|| invalid("Canvas element version overflowed during restore"))?;
    let nonce = element_tie_hash(&format!("{restore_identity}\0{}", target.id));
    let version_nonce = i64::from_str_radix(&nonce[..8], 16)
        .map_err(|_| internal("Canvas restore nonce could not be derived"))?;
    let mut value = target.value.clone();
    let object = value
        .as_object_mut()
        .ok_or_else(|| corrupt("Canvas restore element is invalid"))?;
    object.insert("version".to_owned(), json!(next_version));
    object.insert("versionNonce".to_owned(), json!(version_nonce));
    object.insert("isDeleted".to_owned(), json!(deleted));
    parse_element(&value, Some(&target.id), target.order_key.clone())
}

fn element_tie_hash(value: &str) -> String {
    [0x811c_9dc5, 0x9e37_79b9, 0x85eb_ca6b, 0xc2b2_ae35]
        .into_iter()
        .map(|seed| {
            let hash = value.encode_utf16().fold(seed, |hash, unit| {
                (hash ^ u32::from(unit)).wrapping_mul(0x0100_0193)
            });
            format!("{hash:08x}")
        })
        .collect()
}

fn canonicalize_page_reference(object: &mut Map<String, Value>) -> Result<(), StoreError> {
    let Some(custom_data) = object.get("customData").and_then(Value::as_object) else {
        return Ok(());
    };
    if !matches!(
        custom_data.get("type").and_then(Value::as_str),
        Some("nodex-card" | "nodex-card-reference")
    ) {
        return Ok(());
    }
    let target = require_identity(
        custom_data
            .get("targetBlockId")
            .or_else(|| custom_data.get("cardId")),
        "Canvas page reference targetBlockId",
    )?;
    let title = custom_data
        .get("titleHint")
        .and_then(Value::as_str)
        .map(|title| truncate_utf16(title, 512))
        .filter(|title| !title.is_empty());
    object.insert(
        "customData".to_owned(),
        remove_null_fields(json!({
            "type": "nodex-card-reference",
            "targetBlockId": target,
            "titleHint": title,
        })),
    );
    Ok(())
}

fn read_page_reference(element: &CanvasElement) -> Option<Result<CanvasPageReference, StoreError>> {
    let custom_data = element.value.get("customData").and_then(Value::as_object)?;
    if custom_data.get("type").and_then(Value::as_str) != Some("nodex-card-reference") {
        return None;
    }
    Some(
        require_identity(
            custom_data.get("targetBlockId"),
            "Canvas page reference targetBlockId",
        )
        .map(|target_block_id| CanvasPageReference {
            source_element_id: element.id.clone(),
            target_block_id,
            title_hint: custom_data
                .get("titleHint")
                .and_then(Value::as_str)
                .map(|title| truncate_utf16(title, 512))
                .filter(|title| !title.is_empty()),
        }),
    )
}

fn element_plain_text(element: &CanvasElement) -> Option<&str> {
    let object = element.value.as_object()?;
    object.get("text").and_then(Value::as_str).or_else(|| {
        object
            .get("label")
            .and_then(Value::as_object)
            .and_then(|label| label.get("text"))
            .and_then(Value::as_str)
    })
}

fn exact_object<'a>(
    value: &'a Value,
    field: &str,
    required: &[&str],
) -> Result<&'a Map<String, Value>, StoreError> {
    let object = value
        .as_object()
        .ok_or_else(|| invalid(format!("{field} must be an object")))?;
    if required.iter().any(|key| !object.contains_key(*key)) {
        return Err(invalid(format!("{field} is missing a required field")));
    }
    Ok(object)
}

fn exact_object_exact<'a>(
    value: &'a Value,
    field: &str,
    required: &[&str],
) -> Result<&'a Map<String, Value>, StoreError> {
    let object = exact_object(value, field, required)?;
    if object.len() != required.len() || object.keys().any(|key| !required.contains(&key.as_str()))
    {
        return Err(invalid(format!("{field} contains unsupported fields")));
    }
    Ok(object)
}

fn require_identity(value: Option<&Value>, field: &str) -> Result<String, StoreError> {
    value
        .and_then(Value::as_str)
        .filter(|value| {
            !value.is_empty() && value.len() <= MAX_ID_LENGTH && value.trim().len() == value.len()
        })
        .map(str::to_owned)
        .ok_or_else(|| invalid(format!("{field} must be a canonical bounded identity")))
}

fn require_integer(value: Option<&Value>, field: &str, minimum: i64) -> Result<i64, StoreError> {
    value
        .and_then(Value::as_i64)
        .filter(|value| *value >= minimum)
        .ok_or_else(|| invalid(format!("{field} must be an integer >= {minimum}")))
}

pub(crate) fn legacy_order_key(ordinal: usize) -> String {
    format!("legacy:{ordinal:016x}")
}

pub(crate) fn materialize_canvas_plain_text(values: &[String]) -> String {
    truncate_utf16(
        &values
            .iter()
            .filter(|value| !value.is_empty())
            .cloned()
            .collect::<Vec<_>>()
            .join("\n"),
        MAX_SHARED_TEXT_UTF16,
    )
}

pub(crate) fn canvas_plain_text_preview(value: &str) -> String {
    truncate_utf16(&value.split_whitespace().collect::<Vec<_>>().join(" "), 280)
}

fn truncate_utf16(value: &str, limit: usize) -> String {
    let mut remaining = limit;
    value
        .chars()
        .take_while(|character| {
            let width = character.len_utf16();
            if width > remaining {
                return false;
            }
            remaining -= width;
            true
        })
        .collect()
}

fn remove_null_fields(mut value: Value) -> Value {
    if let Some(object) = value.as_object_mut() {
        object.retain(|_, value| !value.is_null());
    }
    value
}

fn invalid(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message.into(), false)
}

fn corrupt(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message.into(), false)
}

fn internal(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::Internal, message, false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn element(id: &str, version: i64, nonce: i64, text: &str) -> Value {
        json!({
            "id": id,
            "type": "text",
            "version": version,
            "versionNonce": nonce,
            "isDeleted": false,
            "text": text,
        })
    }

    #[test]
    fn element_clock_and_field_intents_merge_without_a_global_head_barrier() {
        let current_element =
            parse_element(&element("e1", 2, 4, "current"), None, "a".into()).expect("current");
        let current = materialize_scene(
            vec![current_element],
            Map::from_iter([("gridModeEnabled".to_owned(), json!(false))]),
            BTreeMap::new(),
        )
        .expect("scene");
        let mutation = parse_canvas_mutation(&json!({
            "elementCandidates": [element("e1", 3, 9, "next")],
            "appStateIntents": {
                "gridModeEnabled": {
                    "expected": { "kind": "value", "value": true },
                    "value": { "kind": "value", "value": true }
                },
                "gridSize": {
                    "expected": { "kind": "absent" },
                    "value": { "kind": "value", "value": 20 }
                }
            },
            "fileAdditions": {}
        }))
        .expect("mutation");
        let applied = apply_canvas_mutation(&current, &mutation).expect("apply");
        assert_eq!(applied.changed_element_ids, ["e1"]);
        assert_eq!(applied.applied_app_state_keys, ["gridSize"]);
        assert_eq!(applied.skipped_app_state_keys, ["gridModeEnabled"]);
        assert_eq!(applied.scene.elements[0].value["text"], "next");
        assert_eq!(applied.scene.app_state["gridSize"], 20);
    }

    #[test]
    fn canonicalizes_page_references_and_derives_scene_projection() {
        let element = parse_element(
            &json!({
                "id": "page-ref",
                "type": "rectangle",
                "version": 1,
                "versionNonce": 0,
                "isDeleted": false,
                "label": { "text": "Page label" },
                "customData": {
                    "type": "nodex-card",
                    "cardId": "page:target",
                    "titleHint": "Target"
                }
            }),
            None,
            "a".into(),
        )
        .expect("element");
        let scene = materialize_scene(vec![element], Map::new(), BTreeMap::new()).expect("scene");
        assert_eq!(scene.plain_text, "Page label");
        assert_eq!(scene.preview, "Page label");
        assert_eq!(scene.page_references[0].target_block_id, "page:target");
        assert_eq!(
            scene.elements[0].value["customData"]["type"],
            "nodex-card-reference"
        );
        assert_eq!(scene.canonical_value()["kind"], "canvas_scene");
    }

    #[test]
    fn incremental_scene_metadata_is_exact_and_order_independent() {
        let first = parse_element(
            &json!({
                "id": "first",
                "type": "text",
                "version": 1,
                "versionNonce": 7,
                "index": "a0",
                "isDeleted": false,
                "text": "First",
            }),
            None,
            "a0".into(),
        )
        .expect("first");
        let second = parse_element(
            &json!({
                "id": "second",
                "type": "text",
                "version": 2,
                "versionNonce": 3,
                "index": "a1",
                "isDeleted": true,
                "text": "Second",
            }),
            None,
            "a1".into(),
        )
        .expect("second");
        let ordered = materialize_scene(
            vec![first.clone(), second.clone()],
            Map::from_iter([("gridSize".to_owned(), json!(20))]),
            BTreeMap::new(),
        )
        .expect("ordered");
        let reversed = materialize_scene(
            vec![second, first],
            Map::from_iter([("gridSize".to_owned(), json!(20))]),
            BTreeMap::new(),
        )
        .expect("reversed");
        let ordered_metadata =
            compute_canvas_scene_incremental_metadata(&ordered).expect("ordered metadata");
        let reversed_metadata =
            compute_canvas_scene_incremental_metadata(&reversed).expect("reversed metadata");
        assert_eq!(
            ordered_metadata.counters.scene_byte_length,
            i64::try_from(ordered.canonical_json().expect("scene JSON").len())
                .expect("scene byte length")
        );
        assert_eq!(ordered_metadata.counters.element_count, 2);
        assert_eq!(ordered_metadata.counters.tombstone_count, 1);
        assert_eq!(ordered_metadata.scene_hash, reversed_metadata.scene_hash);
        assert_eq!(
            ordered_metadata.hash_buckets,
            reversed_metadata.hash_buckets
        );
    }
}

#[cfg(test)]
mod restore_file_tests {
    use super::*;

    #[test]
    fn forward_restore_allocates_a_slot_for_a_different_historical_file_binding() {
        let scene = |file: &str| {
            parse_canvas_scene(&json!({
            "kind":"canvas_scene", "schemaVersion":2, "plainText":"", "preview":"", "pageReferences":[],
            "elements":[{"id":"image","type":"image","version":1,"versionNonce":1,"isDeleted":false,"fileId":"slot"}],
            "appState":{},"files":{"slot":{"id":"slot","mimeType":"image/png","source":format!("nodex://files/{file}"),"fileVersion":1,"defaultName":"image.png"}}
        })).unwrap()
        };
        let current = scene("current-file");
        let historical = scene("historical-file");
        let mutation = prepare_canvas_restore(&current, &historical, "restore")
            .unwrap()
            .unwrap();
        let restored = apply_canvas_mutation(&current, &mutation).unwrap().scene;
        let slot = restored.elements[0].value["fileId"].as_str().unwrap();
        assert_ne!(slot, "slot");
        assert_eq!(restored.files[slot].target_file_id, "historical-file");
        assert_eq!(restored.elements[0].id, "image");
        assert!(restored.elements[0].value["version"].as_i64().unwrap() > 1);
        assert_eq!(
            mutation,
            prepare_canvas_restore(&current, &historical, "restore")
                .unwrap()
                .unwrap()
        );
    }
}
