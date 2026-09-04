#[cfg(test)]
use std::cell::Cell;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::Path;

use nodex_core_contracts::{
    ProjectionImpact,
    document::{CanvasCompactionStats, OwnedDocumentAccessContext},
};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Map, Value, json};

use crate::infrastructure::document_repository::{
    DocumentAuthority, DocumentReadiness, DocumentSyncEngine,
};
use crate::infrastructure::event_log::{NewChangeLogEntry, append_change_log};
use crate::infrastructure::local_commit::CommitContext;
use crate::infrastructure::request_execution::check_request_interruption;
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

use super::canvas_scene::{
    AppliedCanvasMutation, CANVAS_OWNER_TYPE, CANVAS_SCENE_HASH_VERSION, CANVAS_SCHEMA_KEY,
    CANVAS_SCHEMA_VERSION, CanvasElement, CanvasFile, CanvasHashBucket, CanvasHashItem,
    CanvasHashItemKind, CanvasMutation, CanvasPageReference, CanvasScene, CanvasSceneCounters,
    DerivedCanvasElement, OptionalJson, canonical_json, canvas_bucket_hash, canvas_hash_bucket,
    canvas_plain_text_preview, canvas_scene_root_hash, choose_element_winner,
    compact_canvas_tombstones, compute_canvas_scene_incremental_metadata, derive_canvas_element,
    legacy_order_key, materialize_canvas_plain_text, materialize_loaded_scene, optional_matches,
    parse_stored_element, parse_stored_file,
};
use super::persistence::{DocumentAuthorityRow, read_event_head, sha256};

const MAX_CANVAS_ELEMENTS: i64 = 100_000;
const MAX_CANVAS_FILES: i64 = 10_000;
const PROJECTION_VERSION: i64 = 2;
const CANVAS_COMPACTION_TOMBSTONE_COUNT_THRESHOLD: i64 = 5_000;
const CANVAS_COMPACTION_TOMBSTONE_BYTES_THRESHOLD: i64 = 4 * 1024 * 1024;

fn canvas_compaction_eligible(tombstone_count: i64, tombstone_bytes: i64) -> bool {
    tombstone_count >= CANVAS_COMPACTION_TOMBSTONE_COUNT_THRESHOLD
        || tombstone_bytes >= CANVAS_COMPACTION_TOMBSTONE_BYTES_THRESHOLD
}

#[cfg(test)]
thread_local! {
    static FULL_SCENE_LOAD_COUNT: Cell<usize> = const { Cell::new(0) };
}

#[cfg(test)]
pub(crate) fn reset_full_scene_load_count() {
    FULL_SCENE_LOAD_COUNT.with(|count| count.set(0));
}

#[cfg(test)]
pub(crate) fn full_scene_load_count() -> usize {
    FULL_SCENE_LOAD_COUNT.with(Cell::get)
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct LoadedCanvasAuthority {
    pub(crate) scene: CanvasScene,
    pub(crate) scene_hash: String,
    pub(crate) updated_at: String,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct PersistedCanvasMutation {
    pub(crate) event_base_head_seq: i64,
    pub(crate) head_seq: i64,
    pub(crate) scene_hash: String,
    pub(crate) result: Value,
    pub(crate) event_delta: Option<Value>,
    pub(crate) event_sequence: i64,
    pub(crate) committed_at: String,
}

#[derive(Debug, Clone)]
pub(crate) struct PreparedCanvasCompaction {
    pub(crate) original_scene: CanvasScene,
    pub(crate) compacted_scene: CanvasScene,
    pub(crate) stats: CanvasCompactionStats,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PersistedCanvasCompaction {
    pub(crate) generation: i64,
    pub(crate) head_seq: i64,
    pub(crate) scene_hash: String,
}

#[derive(Debug, Clone)]
struct CanvasElementRecord {
    element: CanvasElement,
    element_json: String,
    element_hash: String,
    hash_bucket: u16,
    derived: DerivedCanvasElement,
}

#[derive(Debug, Clone)]
struct CanvasElementChange {
    before: Option<CanvasElementRecord>,
    after: CanvasElementRecord,
}

#[derive(Debug, Clone)]
struct CanvasFileRecord {
    file: CanvasFile,
    file_json: String,
    file_hash: String,
    hash_bucket: u16,
}

#[derive(Debug, Clone)]
pub(crate) struct PreparedCanvasMutation {
    element_changes: Vec<CanvasElementChange>,
    app_state_json_after: String,
    app_state_hash_after: String,
    file_additions: Vec<CanvasFileRecord>,
    removed_files: Vec<CanvasFileRecord>,
    affected_bucket_indices: BTreeSet<u16>,
    counters_after: CanvasSceneCounters,
    applied_app_state_keys: Vec<String>,
    skipped_app_state_keys: Vec<String>,
    changed_element_ids: Vec<String>,
    added_file_ids: Vec<String>,
    removed_file_ids: Vec<String>,
    event_delta: Value,
    scene_hash_before: String,
    plain_text_after: Option<String>,
    app_state_changed: bool,
}

impl PreparedCanvasMutation {
    pub(crate) fn added_files(&self) -> impl Iterator<Item = &CanvasFile> {
        self.file_additions.iter().map(|record| &record.file)
    }

    pub(crate) fn changed(&self) -> bool {
        !self.element_changes.is_empty()
            || !self.file_additions.is_empty()
            || !self.removed_files.is_empty()
            || self.app_state_changed
    }
}

#[derive(Debug)]
struct CanvasAuthorityMetadata {
    app_state_json: String,
    scene_hash: String,
    counters: CanvasSceneCounters,
}

pub(crate) fn validate_canvas_authority(
    authority: &DocumentAuthorityRow,
) -> Result<(), StoreError> {
    if authority.head.sync_engine != DocumentSyncEngine::CanvasScene
        || authority.head.schema_key != CANVAS_SCHEMA_KEY
        || authority.head.schema_version != CANVAS_SCHEMA_VERSION
        || authority.owner_type != CANVAS_OWNER_TYPE
        || authority.head.readiness != DocumentReadiness::Ready
        || authority.head.authority != DocumentAuthority::YdocPrimary
        || !authority.head.state_vector.is_empty()
    {
        return Err(StoreError::new(
            StoreErrorCode::UnsupportedSchema,
            "Owned Document is not registered Canvas scene authority",
            false,
        ));
    }
    Ok(())
}

pub(crate) fn prepare_canvas_compaction(
    connection: &Connection,
    authority: &DocumentAuthorityRow,
) -> Result<PreparedCanvasCompaction, StoreError> {
    validate_canvas_authority(authority)?;
    let stats = read_canvas_compaction_stats(connection, authority)?;
    let loaded = load_canvas_scene(connection, authority)?;
    let compacted_scene = compact_canvas_tombstones(&loaded.scene)?;
    Ok(PreparedCanvasCompaction {
        original_scene: loaded.scene,
        compacted_scene,
        stats,
    })
}

pub(crate) fn read_canvas_compaction_stats(
    connection: &Connection,
    authority: &DocumentAuthorityRow,
) -> Result<CanvasCompactionStats, StoreError> {
    validate_canvas_authority(authority)?;
    let metadata = read_canvas_authority_metadata(connection, authority)?;
    let tombstone_count = metadata.counters.tombstone_count;
    let tombstone_bytes = metadata.counters.tombstone_json_bytes;
    Ok(CanvasCompactionStats {
        document_id: authority.head.id.clone(),
        generation: authority.head.generation,
        head_seq: authority.head.head_seq,
        scene_hash: metadata.scene_hash,
        tombstone_count,
        tombstone_bytes,
        eligible: canvas_compaction_eligible(tombstone_count, tombstone_bytes),
    })
}

pub(crate) fn prepare_incremental_canvas_mutation(
    connection: &Connection,
    authority: &DocumentAuthorityRow,
    mutation: &CanvasMutation,
) -> Result<PreparedCanvasMutation, StoreError> {
    validate_canvas_authority(authority)?;
    let metadata = read_canvas_authority_metadata(connection, authority)?;
    let existing = read_candidate_elements(connection, &authority.head.id, mutation)?;
    let mut element_changes = Vec::new();
    for (ordinal, candidate) in mutation.element_candidates.iter().enumerate() {
        let before = existing.get(&candidate.id).cloned();
        let winner = before
            .as_ref()
            .map(|record| choose_element_winner(&record.element, candidate))
            .transpose()?
            .unwrap_or_else(|| candidate.clone());
        if before
            .as_ref()
            .is_some_and(|record| record.element.value == winner.value)
        {
            continue;
        }
        let mut winner = winner;
        winner.order_key = winner
            .value
            .get("index")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .or_else(|| {
                before
                    .as_ref()
                    .map(|record| record.element.order_key.clone())
            })
            .unwrap_or_else(|| {
                let base = usize::try_from(metadata.counters.element_count).unwrap_or(usize::MAX);
                legacy_order_key(base.saturating_add(ordinal))
            });
        let after = prepare_element_record(winner)?;
        validate_changed_page_reference(
            connection,
            authority,
            after.derived.page_reference.as_ref(),
        )?;
        element_changes.push(CanvasElementChange { before, after });
    }
    element_changes.sort_by(|left, right| left.after.element.id.cmp(&right.after.element.id));

    let app_state = serde_json::from_str::<Value>(&metadata.app_state_json)
        .map_err(|_| corrupt("Canvas appState metadata is invalid"))?;
    let mut app_state_after = app_state
        .as_object()
        .cloned()
        .ok_or_else(|| corrupt("Canvas appState metadata is not an object"))?;
    let mut applied_app_state_keys = Vec::new();
    let mut skipped_app_state_keys = Vec::new();
    let mut app_state_changed = false;
    for (key, intent) in &mutation.app_state_intents {
        if !optional_matches(app_state_after.get(key), &intent.expected) {
            skipped_app_state_keys.push(key.clone());
            continue;
        }
        applied_app_state_keys.push(key.clone());
        let before = app_state_after.get(key).cloned();
        match &intent.value {
            OptionalJson::Absent => {
                app_state_after.remove(key);
            }
            OptionalJson::Value(value) => {
                app_state_after.insert(key.clone(), value.clone());
            }
        }
        app_state_changed |= before != app_state_after.get(key).cloned();
    }
    applied_app_state_keys.sort();
    skipped_app_state_keys.sort();
    let app_state_json_after = canonical_json(&Value::Object(app_state_after.clone()))?;
    let app_state_hash_after = sha256(app_state_json_after.as_bytes());

    let changed_ids = element_changes
        .iter()
        .map(|change| change.after.element.id.clone())
        .collect::<HashSet<_>>();
    let mut affected_file_ids = mutation
        .file_additions
        .keys()
        .cloned()
        .collect::<BTreeSet<_>>();
    for change in &element_changes {
        if let Some(file_id) = change
            .before
            .as_ref()
            .and_then(|record| record.derived.referenced_file_id.as_ref())
        {
            affected_file_ids.insert(file_id.clone());
        }
        if let Some(file_id) = &change.after.derived.referenced_file_id {
            affected_file_ids.insert(file_id.clone());
        }
    }
    let existing_files = read_candidate_files(connection, &authority.head.id, &affected_file_ids)?;
    let mut file_additions = Vec::new();
    let mut removed_files = Vec::new();
    for file_id in &affected_file_ids {
        let referenced_by_changed = element_changes.iter().any(|change| {
            change.after.derived.referenced_file_id.as_deref() == Some(file_id.as_str())
        });
        let referenced_by_unchanged = canvas_file_has_unchanged_reference(
            connection,
            &authority.head.id,
            file_id,
            &changed_ids,
        )?;
        let referenced_after = referenced_by_changed || referenced_by_unchanged;
        let existing_file = existing_files.get(file_id);
        let addition = mutation.file_additions.get(file_id);
        if let (Some(existing), Some(addition)) = (existing_file, addition)
            && existing.file.value != addition.value
            && !existing.file.same_binding(addition)
        {
            return Err(invalid(format!(
                "Canvas managed file {file_id} cannot be redefined"
            )));
        }
        if referenced_after {
            if existing_file.is_none() {
                let addition = addition.ok_or_else(|| {
                    invalid(format!(
                        "Canvas image references missing managed file {file_id}"
                    ))
                })?;
                file_additions.push(prepare_file_record(addition.clone())?);
            }
            continue;
        }
        if let Some(existing) = existing_file {
            removed_files.push(existing.clone());
        }
    }
    file_additions.sort_by(|left, right| left.file.id.cmp(&right.file.id));
    removed_files.sort_by(|left, right| left.file.id.cmp(&right.file.id));

    let element_count_delta = element_changes
        .iter()
        .filter(|change| change.before.is_none())
        .count();
    let element_count =
        checked_count_delta(metadata.counters.element_count, element_count_delta, 0)?;
    let tombstone_count =
        element_changes
            .iter()
            .try_fold(metadata.counters.tombstone_count, |count, change| {
                count
                    .checked_add(i64::from(change.after.element.is_deleted))
                    .and_then(|count| {
                        count.checked_sub(
                            change
                                .before
                                .as_ref()
                                .map_or(0, |record| i64::from(record.element.is_deleted)),
                        )
                    })
                    .ok_or_else(|| internal("Canvas tombstone counter overflowed"))
            })?;
    let element_json_bytes = element_changes.iter().try_fold(
        metadata.counters.element_json_bytes,
        |bytes, change| {
            checked_byte_delta(
                bytes,
                change.after.element_json.len(),
                change
                    .before
                    .as_ref()
                    .map_or(0, |record| record.element_json.len()),
            )
        },
    )?;
    let tombstone_json_bytes = element_changes.iter().try_fold(
        metadata.counters.tombstone_json_bytes,
        |bytes, change| {
            checked_byte_delta(
                bytes,
                if change.after.element.is_deleted {
                    change.after.element_json.len()
                } else {
                    0
                },
                change
                    .before
                    .as_ref()
                    .filter(|record| record.element.is_deleted)
                    .map_or(0, |record| record.element_json.len()),
            )
        },
    )?;
    let file_count = checked_count_delta(
        metadata.counters.file_count,
        file_additions.len(),
        removed_files.len(),
    )?;
    if element_count > MAX_CANVAS_ELEMENTS || file_count > MAX_CANVAS_FILES {
        return Err(invalid("Canvas scene exceeds its aggregate bound"));
    }
    let file_json_bytes = file_additions
        .iter()
        .try_fold(metadata.counters.file_json_bytes, |bytes, file| {
            checked_byte_delta(bytes, file.file_json.len(), 0)
        })?;
    let file_json_bytes = removed_files
        .iter()
        .try_fold(file_json_bytes, |bytes, file| {
            checked_byte_delta(bytes, 0, file.file_json.len())
        })?;

    let plain_text_changed = element_changes.iter().any(|change| {
        change
            .before
            .as_ref()
            .map_or("", |record| record.derived.plain_text.as_str())
            != change.after.derived.plain_text
    });
    let plain_text_after = plain_text_changed
        .then(|| {
            materialize_incremental_plain_text(
                connection,
                &authority.head.id,
                &element_changes,
                &changed_ids,
            )
        })
        .transpose()?;
    let scene_byte_length = incremental_scene_byte_length(
        connection,
        authority,
        &metadata,
        &element_changes,
        &app_state_json_after,
        &file_additions,
        &removed_files,
        plain_text_after.as_deref(),
    )?;
    let mut affected_bucket_indices = BTreeSet::new();
    for change in &element_changes {
        if let Some(before) = &change.before {
            affected_bucket_indices.insert(before.hash_bucket);
        }
        affected_bucket_indices.insert(change.after.hash_bucket);
    }
    for file in file_additions.iter().chain(&removed_files) {
        affected_bucket_indices.insert(file.hash_bucket);
    }
    let changed_element_ids = element_changes
        .iter()
        .map(|change| change.after.element.id.clone())
        .collect::<Vec<_>>();
    let added_file_ids = file_additions
        .iter()
        .map(|file| file.file.id.clone())
        .collect::<Vec<_>>();
    let removed_file_ids = removed_files
        .iter()
        .map(|file| file.file.id.clone())
        .collect::<Vec<_>>();
    let event_delta = json!({
        "elementUpdates": element_changes
            .iter()
            .map(|change| change.after.element.value.clone())
            .collect::<Vec<_>>(),
        "appState": app_state_after.clone(),
        "fileAdditions": file_additions
            .iter()
            .map(|file| (file.file.id.clone(), file.file.value.clone()))
            .collect::<Map<_, _>>(),
        "removedFileIds": removed_file_ids.clone(),
    });
    Ok(PreparedCanvasMutation {
        element_changes,
        app_state_json_after,
        app_state_hash_after,
        file_additions,
        removed_files,
        affected_bucket_indices,
        counters_after: CanvasSceneCounters {
            element_count,
            tombstone_count,
            tombstone_json_bytes,
            file_count,
            element_json_bytes,
            file_json_bytes,
            scene_byte_length,
        },
        applied_app_state_keys,
        skipped_app_state_keys,
        changed_element_ids,
        added_file_ids,
        removed_file_ids,
        event_delta,
        scene_hash_before: metadata.scene_hash,
        plain_text_after,
        app_state_changed,
    })
}

fn read_canvas_authority_metadata(
    connection: &Connection,
    authority: &DocumentAuthorityRow,
) -> Result<CanvasAuthorityMetadata, StoreError> {
    let metadata = connection
        .query_row(
            "SELECT generation, head_seq, schema_version, scene_hash_version, app_state_json, \
                    app_state_hash, scene_hash, element_count, tombstone_count, file_count, \
                    element_json_bytes, tombstone_json_bytes, file_json_bytes, scene_byte_length \
             FROM canvas_scenes WHERE document_id = ?1",
            [&authority.head.id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, i64>(7)?,
                    row.get::<_, i64>(8)?,
                    row.get::<_, i64>(9)?,
                    row.get::<_, i64>(10)?,
                    row.get::<_, i64>(11)?,
                    row.get::<_, i64>(12)?,
                    row.get::<_, i64>(13)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| corrupt("Canvas scene authority is missing"))?;
    if metadata.0 != authority.head.generation
        || metadata.1 != authority.head.head_seq
        || metadata.2 != authority.head.schema_version
        || metadata.3 != CANVAS_SCENE_HASH_VERSION
        || metadata.6 != authority.head.state_hash
        || sha256(metadata.4.as_bytes()) != metadata.5
    {
        return Err(corrupt(
            "Canvas incremental metadata diverges from its Document head",
        ));
    }
    Ok(CanvasAuthorityMetadata {
        app_state_json: metadata.4,
        scene_hash: metadata.6,
        counters: CanvasSceneCounters {
            element_count: metadata.7,
            tombstone_count: metadata.8,
            file_count: metadata.9,
            element_json_bytes: metadata.10,
            tombstone_json_bytes: metadata.11,
            file_json_bytes: metadata.12,
            scene_byte_length: metadata.13,
        },
    })
}

fn prepare_element_record(element: CanvasElement) -> Result<CanvasElementRecord, StoreError> {
    let element_json = canonical_json(&element.value)?;
    Ok(CanvasElementRecord {
        element_hash: sha256(element_json.as_bytes()),
        hash_bucket: canvas_hash_bucket(CanvasHashItemKind::Element, &element.id),
        derived: derive_canvas_element(&element)?,
        element,
        element_json,
    })
}

fn prepare_file_record(file: CanvasFile) -> Result<CanvasFileRecord, StoreError> {
    let file_json = canonical_json(&file.value)?;
    Ok(CanvasFileRecord {
        file_hash: sha256(file_json.as_bytes()),
        hash_bucket: canvas_hash_bucket(CanvasHashItemKind::File, &file.id),
        file,
        file_json,
    })
}

fn read_candidate_elements(
    connection: &Connection,
    document_id: &str,
    mutation: &CanvasMutation,
) -> Result<HashMap<String, CanvasElementRecord>, StoreError> {
    if mutation.element_candidates.is_empty() {
        return Ok(HashMap::new());
    }
    let placeholders = (0..mutation.element_candidates.len())
        .map(|index| format!("?{}", index + 2))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "SELECT element_id, version, version_nonce, order_key, is_deleted, element_json, \
                element_hash, hash_bucket, referenced_file_id, plain_text \
         FROM canvas_scene_elements \
         WHERE document_id = ?1 AND element_id IN ({placeholders})"
    );
    let ids = mutation
        .element_candidates
        .iter()
        .map(|element| element.id.as_str());
    let mut values = Vec::with_capacity(mutation.element_candidates.len() + 1);
    values.push(document_id);
    values.extend(ids);
    let rows = connection
        .prepare(&sql)?
        .query_map(rusqlite::params_from_iter(values), |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, i64>(7)?,
                row.get::<_, Option<String>>(8)?,
                row.get::<_, String>(9)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter()
        .map(|row| {
            let value = serde_json::from_str::<Value>(&row.5)
                .map_err(|_| corrupt("Canvas candidate row JSON is invalid"))?;
            let element = parse_stored_element(&value, &row.0, row.3)?;
            let record = prepare_element_record(element)?;
            if record.element.version != row.1
                || record.element.version_nonce != row.2
                || i64::from(record.element.is_deleted) != row.4
                || record.element_json != row.5
                || record.element_hash != row.6
                || i64::from(record.hash_bucket) != row.7
                || record.derived.referenced_file_id != row.8
                || record.derived.plain_text != row.9
            {
                return Err(corrupt("Canvas candidate row evidence is inconsistent"));
            }
            Ok((row.0, record))
        })
        .collect()
}

fn read_candidate_files(
    connection: &Connection,
    document_id: &str,
    file_ids: &BTreeSet<String>,
) -> Result<HashMap<String, CanvasFileRecord>, StoreError> {
    if file_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let placeholders = (0..file_ids.len())
        .map(|index| format!("?{}", index + 2))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "SELECT file_id, mime_type, asset_uri, created_ms, file_json, file_hash, hash_bucket \
         FROM canvas_scene_files \
         WHERE document_id = ?1 AND file_id IN ({placeholders})"
    );
    let mut values = Vec::with_capacity(file_ids.len() + 1);
    values.push(document_id);
    values.extend(file_ids.iter().map(String::as_str));
    let rows = connection
        .prepare(&sql)?
        .query_map(rusqlite::params_from_iter(values), |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<i64>>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, i64>(6)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter()
        .map(|row| {
            let value = serde_json::from_str::<Value>(&row.4)
                .map_err(|_| corrupt("Canvas candidate file JSON is invalid"))?;
            let file = parse_stored_file(&value, &row.0)?;
            let record = prepare_file_record(file)?;
            if record.file.mime_type != row.1
                || record.file.source != row.2
                || record.file.created_ms != row.3
                || record.file_json != row.4
                || record.file_hash != row.5
                || i64::from(record.hash_bucket) != row.6
            {
                return Err(corrupt("Canvas candidate file evidence is inconsistent"));
            }
            Ok((row.0, record))
        })
        .collect()
}

fn canvas_file_has_unchanged_reference(
    connection: &Connection,
    document_id: &str,
    file_id: &str,
    changed_ids: &HashSet<String>,
) -> Result<bool, StoreError> {
    let mut sql = String::from(
        "SELECT 1 FROM canvas_scene_elements \
         WHERE document_id = ?1 AND referenced_file_id = ?2 AND is_deleted = 0",
    );
    if !changed_ids.is_empty() {
        let placeholders = (0..changed_ids.len())
            .map(|index| format!("?{}", index + 3))
            .collect::<Vec<_>>()
            .join(", ");
        sql.push_str(&format!(" AND element_id NOT IN ({placeholders})"));
    }
    sql.push_str(" LIMIT 1");
    let mut values = Vec::with_capacity(changed_ids.len() + 2);
    values.push(document_id);
    values.push(file_id);
    values.extend(changed_ids.iter().map(String::as_str));
    Ok(connection
        .query_row(&sql, rusqlite::params_from_iter(values), |_| Ok(()))
        .optional()?
        .is_some())
}

fn validate_changed_page_reference(
    connection: &Connection,
    authority: &DocumentAuthorityRow,
    reference: Option<&CanvasPageReference>,
) -> Result<(), StoreError> {
    let Some(reference) = reference else {
        return Ok(());
    };
    let valid = connection
        .query_row(
            "SELECT 1 FROM blocks WHERE id = ?1 AND library_id = ?2 \
               AND lifecycle <> 'deleted' AND type = 'page'",
            params![reference.target_block_id, authority.head.library_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if valid {
        return Ok(());
    }
    Err(invalid(
        "Canvas scene contains a missing, deleted, or cross-Project Page reference",
    ))
}

fn materialize_incremental_plain_text(
    connection: &Connection,
    document_id: &str,
    changes: &[CanvasElementChange],
    changed_ids: &HashSet<String>,
) -> Result<String, StoreError> {
    let mut rows = connection
        .prepare(
            "SELECT order_key, element_id, plain_text FROM canvas_scene_elements \
             WHERE document_id = ?1 AND is_deleted = 0 AND plain_text <> '' \
             ORDER BY order_key, element_id",
        )?
        .query_map([document_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.retain(|row| !changed_ids.contains(&row.1));
    rows.extend(
        changes
            .iter()
            .filter(|change| {
                !change.after.element.is_deleted && !change.after.derived.plain_text.is_empty()
            })
            .map(|change| {
                (
                    change.after.element.order_key.clone(),
                    change.after.element.id.clone(),
                    change.after.derived.plain_text.clone(),
                )
            }),
    );
    rows.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));
    Ok(materialize_canvas_plain_text(
        &rows.into_iter().map(|row| row.2).collect::<Vec<_>>(),
    ))
}

#[allow(clippy::too_many_arguments)]
fn incremental_scene_byte_length(
    connection: &Connection,
    authority: &DocumentAuthorityRow,
    metadata: &CanvasAuthorityMetadata,
    element_changes: &[CanvasElementChange],
    app_state_json_after: &str,
    file_additions: &[CanvasFileRecord],
    removed_files: &[CanvasFileRecord],
    plain_text_after: Option<&str>,
) -> Result<i64, StoreError> {
    let mut length = i128::from(metadata.counters.scene_byte_length);
    let mut inserted_elements = 0_i64;
    for change in element_changes {
        let before_length = change
            .before
            .as_ref()
            .map_or(0_i128, |record| record.element_json.len() as i128);
        length += change.after.element_json.len() as i128 - before_length;
        if change.before.is_none() {
            if metadata.counters.element_count + inserted_elements > 0 {
                length += 1;
            }
            inserted_elements += 1;
        }
    }
    length += app_state_json_after.len() as i128 - metadata.app_state_json.len() as i128;
    let file_entry_length = |record: &CanvasFileRecord| -> Result<i128, StoreError> {
        let key = serde_json::to_string(&record.file.id)
            .map_err(|_| internal("Canvas file identity cannot be encoded"))?;
        Ok((key.len() + 1 + record.file_json.len()) as i128)
    };
    let old_file_commas = (metadata.counters.file_count - 1).max(0);
    let new_file_count = metadata.counters.file_count
        + i64::try_from(file_additions.len()).map_err(|_| internal("Canvas file count"))?
        - i64::try_from(removed_files.len()).map_err(|_| internal("Canvas file count"))?;
    let new_file_commas = (new_file_count - 1).max(0);
    for file in file_additions {
        length += file_entry_length(file)?;
    }
    for file in removed_files {
        length -= file_entry_length(file)?;
    }
    length += i128::from(new_file_commas - old_file_commas);

    let old_reference_count: i64 = connection.query_row(
        "SELECT count(*) FROM canvas_page_references WHERE document_id = ?1",
        [&authority.head.id],
        |row| row.get(0),
    )?;
    let mut reference_count = old_reference_count;
    for change in element_changes {
        let before = change
            .before
            .as_ref()
            .and_then(|record| record.derived.page_reference.as_ref());
        let after = change.after.derived.page_reference.as_ref();
        length += canvas_reference_json_length(after)? - canvas_reference_json_length(before)?;
        reference_count += i64::from(after.is_some()) - i64::from(before.is_some());
    }
    length += i128::from((reference_count - 1).max(0) - (old_reference_count - 1).max(0));
    if let Some(plain_text_after) = plain_text_after {
        let plain_text_before = connection
            .query_row(
                "SELECT text FROM block_search_units \
                 WHERE document_id = ?1 AND source_revision IS NULL \
                   AND source_kind = 'document_marker'",
                [&authority.head.id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .ok_or_else(|| corrupt("Canvas search marker is missing"))?;
        length += json_string_length(plain_text_after)? - json_string_length(&plain_text_before)?;
        length += json_string_length(&canvas_plain_text_preview(plain_text_after))?
            - json_string_length(&canvas_plain_text_preview(&plain_text_before))?;
    }
    if !(0..=i128::from(16 * 1024 * 1024)).contains(&length) {
        return Err(invalid("Canvas scene exceeds its snapshot byte bound"));
    }
    i64::try_from(length).map_err(|_| internal("Canvas scene byte length overflowed"))
}

fn canvas_reference_json_length(
    reference: Option<&CanvasPageReference>,
) -> Result<i128, StoreError> {
    let Some(reference) = reference else {
        return Ok(0);
    };
    let mut value = Map::from_iter([
        (
            "sourceElementId".to_owned(),
            Value::String(reference.source_element_id.clone()),
        ),
        (
            "targetBlockId".to_owned(),
            Value::String(reference.target_block_id.clone()),
        ),
    ]);
    if let Some(title_hint) = &reference.title_hint {
        value.insert("titleHint".to_owned(), Value::String(title_hint.clone()));
    }
    Ok(canonical_json(&Value::Object(value))?.len() as i128)
}

fn json_string_length(value: &str) -> Result<i128, StoreError> {
    serde_json::to_string(value)
        .map(|value| value.len() as i128)
        .map_err(|_| internal("Canvas derived text cannot be encoded"))
}

fn checked_count_delta(current: i64, added: usize, removed: usize) -> Result<i64, StoreError> {
    let added = i64::try_from(added).map_err(|_| internal("Canvas counter overflowed"))?;
    let removed = i64::try_from(removed).map_err(|_| internal("Canvas counter overflowed"))?;
    let value = current
        .checked_add(added)
        .and_then(|value| value.checked_sub(removed))
        .ok_or_else(|| internal("Canvas counter overflowed"))?;
    if value < 0 {
        return Err(corrupt("Canvas counter became negative"));
    }
    Ok(value)
}

fn checked_byte_delta(current: i64, added: usize, removed: usize) -> Result<i64, StoreError> {
    checked_count_delta(current, added, removed)
}

pub(crate) fn load_canvas_scene(
    connection: &Connection,
    authority: &DocumentAuthorityRow,
) -> Result<LoadedCanvasAuthority, StoreError> {
    check_request_interruption()?;
    #[cfg(test)]
    FULL_SCENE_LOAD_COUNT.with(|count| count.set(count.get().saturating_add(1)));
    validate_canvas_authority(authority)?;
    let scene_row = connection
        .query_row(
            "SELECT generation, head_seq, schema_version, scene_hash_version, app_state_json, \
                    app_state_hash, scene_hash, element_count, tombstone_count, file_count, \
                    element_json_bytes, tombstone_json_bytes, file_json_bytes, scene_byte_length, \
                    updated_at \
             FROM canvas_scenes WHERE document_id = ?1",
            [&authority.head.id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, i64>(7)?,
                    row.get::<_, i64>(8)?,
                    row.get::<_, i64>(9)?,
                    row.get::<_, i64>(10)?,
                    row.get::<_, i64>(11)?,
                    row.get::<_, i64>(12)?,
                    row.get::<_, i64>(13)?,
                    row.get::<_, String>(14)?,
                ))
            },
        )
        .optional()
        .map_err(|_| corrupt("Canvas scene row has invalid column types"))?
        .ok_or_else(|| corrupt("Canvas scene authority is missing"))?;
    if scene_row.0 != authority.head.generation
        || scene_row.1 != authority.head.head_seq
        || scene_row.2 != authority.head.schema_version
        || scene_row.3 != CANVAS_SCENE_HASH_VERSION
    {
        return Err(corrupt(
            "Canvas scene coordinate does not match its Document head",
        ));
    }
    let element_rows = connection
        .prepare(
            "SELECT element_id, version, version_nonce, order_key, is_deleted, \
                    element_json, element_hash, hash_bucket, referenced_file_id, plain_text \
             FROM canvas_scene_elements WHERE document_id = ?1 ORDER BY order_key, element_id",
        )?
        .query_map([&authority.head.id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, i64>(7)?,
                row.get::<_, Option<String>>(8)?,
                row.get::<_, String>(9)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|_| corrupt("Canvas element row has invalid column types"))?;
    check_request_interruption()?;
    let mut elements = Vec::with_capacity(element_rows.len());
    for row in element_rows {
        check_request_interruption()?;
        let value = serde_json::from_str::<Value>(&row.5)
            .map_err(|_| corrupt("Canvas element JSON is invalid"))?;
        let element = parse_stored_element(&value, &row.0, row.3.clone())?;
        let derived = derive_canvas_element(&element)
            .map_err(|_| corrupt("Canvas element derived metadata is invalid"))?;
        if element.version != row.1
            || element.version_nonce != row.2
            || i64::from(element.is_deleted) != row.4
            || sha256(canonical_json(&element.value)?.as_bytes()) != row.6
            || i64::from(canvas_hash_bucket(CanvasHashItemKind::Element, &element.id)) != row.7
            || derived.referenced_file_id != row.8
            || derived.plain_text != row.9
            || element
                .value
                .get("index")
                .and_then(Value::as_str)
                .is_some_and(|index| index != row.3)
        {
            return Err(corrupt("Canvas element evidence diverges from its row"));
        }
        elements.push(element);
    }
    let file_rows = connection
        .prepare(
            "SELECT file_id, mime_type, asset_uri, created_ms, file_json, file_hash, hash_bucket \
             FROM canvas_scene_files WHERE document_id = ?1 ORDER BY file_id",
        )?
        .query_map([&authority.head.id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<i64>>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, i64>(6)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|_| corrupt("Canvas file row has invalid column types"))?;
    check_request_interruption()?;
    let mut files = BTreeMap::new();
    for row in file_rows {
        check_request_interruption()?;
        let value = serde_json::from_str::<Value>(&row.4)
            .map_err(|_| corrupt("Canvas file JSON is invalid"))?;
        let file = parse_stored_file(&value, &row.0)?;
        if file.mime_type != row.1
            || file.source != row.2
            || file.created_ms != row.3
            || sha256(canonical_json(&file.value)?.as_bytes()) != row.5
            || i64::from(canvas_hash_bucket(CanvasHashItemKind::File, &row.0)) != row.6
        {
            return Err(corrupt("Canvas file evidence diverges from its row"));
        }
        files.insert(row.0, file);
    }
    let app_state = serde_json::from_str::<Value>(&scene_row.4)
        .map_err(|_| corrupt("Canvas appState JSON is invalid"))?;
    let scene = materialize_loaded_scene(elements, &app_state, files)?;
    check_request_interruption()?;
    let metadata = compute_canvas_scene_incremental_metadata(&scene)
        .map_err(|_| corrupt("Canvas incremental scene metadata is invalid"))?;
    let mismatches = [
        (metadata.app_state_json != scene_row.4, "app_state_json"),
        (metadata.app_state_hash != scene_row.5, "app_state_hash"),
        (metadata.scene_hash != scene_row.6, "scene_hash"),
        (
            metadata.counters.element_count != scene_row.7,
            "element_count",
        ),
        (
            metadata.counters.tombstone_count != scene_row.8,
            "tombstone_count",
        ),
        (metadata.counters.file_count != scene_row.9, "file_count"),
        (
            metadata.counters.element_json_bytes != scene_row.10,
            "element_json_bytes",
        ),
        (
            metadata.counters.tombstone_json_bytes != scene_row.11,
            "tombstone_json_bytes",
        ),
        (
            metadata.counters.file_json_bytes != scene_row.12,
            "file_json_bytes",
        ),
        (
            metadata.counters.scene_byte_length != scene_row.13,
            "scene_byte_length",
        ),
        (
            metadata.scene_hash != authority.head.state_hash,
            "document_state_hash",
        ),
    ]
    .into_iter()
    .filter_map(|(mismatched, field)| mismatched.then_some(field))
    .collect::<Vec<_>>();
    if !mismatches.is_empty() {
        return Err(corrupt(format!(
            "Canvas scene metadata diverges from its Document authority (fields: {}; \
             computed_scene_bytes={}, stored_scene_bytes={})",
            mismatches.join(", "),
            metadata.counters.scene_byte_length,
            scene_row.13
        )));
    }
    let bucket_rows = connection
        .prepare(
            "SELECT bucket_index, item_count, bucket_hash \
             FROM canvas_scene_hash_buckets WHERE document_id = ?1 ORDER BY bucket_index",
        )?
        .query_map([&authority.head.id], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|_| corrupt("Canvas hash bucket row has invalid column types"))?;
    if bucket_rows.len() != metadata.hash_buckets.len()
        || bucket_rows.iter().any(|row| {
            u16::try_from(row.0)
                .ok()
                .and_then(|bucket_index| metadata.hash_buckets.get(&bucket_index))
                .is_none_or(|bucket| bucket.item_count != row.1 || bucket.bucket_hash != row.2)
        })
    {
        return Err(corrupt(
            "Canvas hash buckets diverge from the scene authority",
        ));
    }
    let projection_head = connection
        .query_row(
            "SELECT generation, projected_head_seq, projection_version \
             FROM canvas_scene_projection_heads WHERE document_id = ?1",
            [&authority.head.id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            },
        )
        .optional()?;
    if projection_head
        != Some((
            authority.head.generation,
            authority.head.head_seq,
            PROJECTION_VERSION,
        ))
    {
        return Err(corrupt(
            "Canvas projection head diverges from the scene authority",
        ));
    }
    Ok(LoadedCanvasAuthority {
        scene,
        scene_hash: metadata.scene_hash,
        updated_at: scene_row.14,
    })
}

pub(crate) fn ensure_canvas_scene(
    connection: &Connection,
    authority: &DocumentAuthorityRow,
    assets_root: &Path,
) -> Result<(LoadedCanvasAuthority, bool), StoreError> {
    validate_canvas_authority(authority)?;
    let exists = connection
        .query_row(
            "SELECT 1 FROM canvas_scenes WHERE document_id = ?1",
            [&authority.head.id],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if exists {
        return load_canvas_scene(connection, authority).map(|loaded| (loaded, false));
    }
    let scene = CanvasScene::empty();
    let metadata = compute_canvas_scene_incremental_metadata(&scene)?;
    let scene_hash = metadata.scene_hash.clone();
    let now = sqlite_now(connection)?;
    let changed = connection.execute(
        "UPDATE documents SET state_hash = ?1, updated_at = ?2 \
         WHERE id = ?3 AND library_id = ?4 AND generation = ?5 AND head_seq = ?6 \
           AND sync_engine = 'canvas_scene' AND readiness = 'ready' \
           AND authority = 'ydoc_primary' AND length(state_vector) = 0",
        params![
            scene_hash,
            now,
            authority.head.id,
            authority.head.library_id,
            authority.head.generation,
            authority.head.head_seq,
        ],
    )?;
    if changed != 1 {
        return Err(conflict(
            "Canvas Document changed before scene initialization",
        ));
    }
    connection.execute(
        "INSERT INTO canvas_scenes (\
           document_id, generation, head_seq, schema_version, scene_hash_version, app_state_json, \
           app_state_hash, scene_hash, element_count, tombstone_count, file_count, \
           element_json_bytes, tombstone_json_bytes, file_json_bytes, scene_byte_length, updated_at\
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
        params![
            authority.head.id,
            authority.head.generation,
            authority.head.head_seq,
            authority.head.schema_version,
            CANVAS_SCENE_HASH_VERSION,
            metadata.app_state_json,
            metadata.app_state_hash,
            scene_hash,
            metadata.counters.element_count,
            metadata.counters.tombstone_count,
            metadata.counters.file_count,
            metadata.counters.element_json_bytes,
            metadata.counters.tombstone_json_bytes,
            metadata.counters.file_json_bytes,
            metadata.counters.scene_byte_length,
            now,
        ],
    )?;
    let mut updated = authority.clone();
    updated.head.state_hash = scene_hash.clone();
    replace_canvas_projections(connection, &updated, &scene, &now, assets_root)?;
    Ok((
        LoadedCanvasAuthority {
            scene,
            scene_hash,
            updated_at: now,
        },
        true,
    ))
}

pub(crate) fn clone_canvas_genesis(
    connection: &Connection,
    source_authority: &DocumentAuthorityRow,
    target_authority: &DocumentAuthorityRow,
    assets_root: &Path,
) -> Result<i64, StoreError> {
    let source = load_canvas_scene(connection, source_authority)?;
    clone_canvas_scene_genesis(connection, source.scene, target_authority, assets_root)
}

/// Instantiates a Canvas from a captured scene rather than re-reading a live
/// source Document. Structural clipboard snapshots therefore remain immutable
/// even when their source Canvas changes before paste.
pub(crate) fn clone_canvas_scene_genesis(
    connection: &Connection,
    scene: CanvasScene,
    target_authority: &DocumentAuthorityRow,
    assets_root: &Path,
) -> Result<i64, StoreError> {
    let (_, created) = ensure_canvas_scene(connection, target_authority, assets_root)?;
    if !created {
        return Err(corrupt("Canvas clone target already has scene authority"));
    }
    validate_page_references(connection, target_authority, &scene)?;
    let changed_element_ids = scene
        .elements
        .iter()
        .map(|element| element.id.clone())
        .collect::<Vec<_>>();
    let added_file_ids = scene.files.keys().cloned().collect::<Vec<_>>();
    let changed = !changed_element_ids.is_empty()
        || !added_file_ids.is_empty()
        || !scene.app_state.is_empty();
    if !changed {
        return Ok(0);
    }
    let applied = AppliedCanvasMutation {
        scene,
        changed_element_ids,
        applied_app_state_keys: Vec::new(),
        skipped_app_state_keys: Vec::new(),
        added_file_ids,
        removed_file_ids: Vec::new(),
        app_state_changed: true,
        event_delta: json!({}),
    };
    let scene_hash = compute_canvas_scene_incremental_metadata(&applied.scene)?.scene_hash;
    let now = sqlite_now(connection)?;
    persist_changed_scene(
        connection,
        target_authority,
        &applied.scene,
        &applied,
        1,
        &scene_hash,
        &now,
        assets_root,
    )?;
    Ok(1)
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn persist_canvas_mutation(
    connection: &Connection,
    commit_context: Option<&CommitContext>,
    authority: &DocumentAuthorityRow,
    actor_project_id: &str,
    access_context: &OwnedDocumentAccessContext,
    store_epoch: &str,
    operation_id: &str,
    base_head_seq: i64,
    intent_hash: &str,
    mutation: &CanvasMutation,
    applied: &AppliedCanvasMutation,
    assets_root: &Path,
    durable_event_kind: &str,
) -> Result<PersistedCanvasMutation, StoreError> {
    validate_canvas_authority(authority)?;
    if base_head_seq > authority.head.head_seq {
        return Err(StoreError::new(
            StoreErrorCode::HeadConflict,
            "Canvas mutation is based on a future Document head",
            true,
        ));
    }
    validate_page_references(connection, authority, &applied.scene)?;
    validate_file_additions(connection, authority, &mutation.file_additions)?;
    let intent_json = canonical_json(&mutation.canonical_value)?;
    if connection
        .query_row(
            "SELECT 1 FROM canvas_scene_mutation_receipts \
             WHERE document_id = ?1 AND mutation_id = ?2",
            params![authority.head.id, operation_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some()
    {
        return Err(corrupt(
            "Canvas mutation receipt exists without its Module receipt",
        ));
    }
    let now = sqlite_now(connection)?;
    let changed = applied.changed();
    let head_seq = if changed {
        authority
            .head
            .head_seq
            .checked_add(1)
            .ok_or_else(|| internal("Canvas head sequence overflowed"))?
    } else {
        authority.head.head_seq
    };
    let scene_hash = compute_canvas_scene_incremental_metadata(&applied.scene)?.scene_hash;
    let event_sequence = if changed {
        persist_changed_scene(
            connection,
            authority,
            &applied.scene,
            applied,
            head_seq,
            &scene_hash,
            &now,
            assets_root,
        )?;
        let payload = json!({
            "module": "owned_document",
            "kind": durable_event_kind,
            "documentId": authority.head.id,
            "generation": authority.head.generation,
            "baseHeadSeq": authority.head.head_seq,
            "headSeq": head_seq,
            "mutationId": operation_id,
            "sceneHash": scene_hash,
            "changedElementIds": applied.changed_element_ids,
            "appliedAppStateKeys": applied.applied_app_state_keys,
            "skippedAppStateKeys": applied.skipped_app_state_keys,
            "addedFileIds": applied.added_file_ids,
            "removedFileIds": applied.removed_file_ids,
            "eventDelta": applied.event_delta,
        });
        let block_ids = vec![authority.owner_block_id.clone()];
        let document_ids = vec![authority.head.id.clone()];
        let payload_json = canonical_json(&payload)?;
        let kind = format!("owned_document.{durable_event_kind}");
        append_change_log(
            connection,
            NewChangeLogEntry {
                project_id: actor_project_id,
                store_epoch,
                kind: &kind,
                operation_id: Some(operation_id),
                block_ids: &block_ids,
                document_ids: &document_ids,
                database_block_ids: &[],
                payload_json: &payload_json,
                projection_impact: &ProjectionImpact::None,
                committed_at: &now,
            },
            commit_context
                .ok_or_else(|| corrupt("Canvas mutation changed without a LocalCommit context"))?,
        )?
    } else {
        read_event_head(connection)?
    };
    let outcome = if changed { "committed" } else { "no_change" };
    let mut result = json!({
        "mutationId": operation_id,
        "libraryId": authority.head.library_id,
        "accessContext": access_context,
        "documentId": authority.head.id,
        "storeEpoch": store_epoch,
        "generation": authority.head.generation,
        "baseHeadSeq": base_head_seq,
        "headSeq": head_seq,
        "duplicate": false,
        "outcome": outcome,
        "sceneHash": scene_hash,
        "changedElementIds": applied.changed_element_ids,
        "appliedAppStateKeys": applied.applied_app_state_keys,
        "skippedAppStateKeys": applied.skipped_app_state_keys,
        "addedFileIds": applied.added_file_ids,
        "removedFileIds": applied.removed_file_ids,
        "committedAt": now,
    });
    if changed {
        result
            .as_object_mut()
            .ok_or_else(|| internal("Canvas mutation result must be an object"))?
            .insert("committedDelta".to_owned(), applied.event_delta.clone());
    }
    connection.execute(
        "INSERT INTO canvas_scene_mutation_receipts (\
           document_id, generation, mutation_id, base_head_seq, committed_head_seq, \
           intent_hash, intent_byte_length, outcome, committed_at\
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            authority.head.id,
            authority.head.generation,
            operation_id,
            base_head_seq,
            head_seq,
            intent_hash,
            i64::try_from(intent_json.len()).map_err(|_| internal("Canvas intent length"))?,
            outcome,
            now,
        ],
    )?;
    Ok(PersistedCanvasMutation {
        event_base_head_seq: authority.head.head_seq,
        head_seq,
        scene_hash,
        result,
        event_delta: changed.then(|| applied.event_delta.clone()),
        event_sequence,
        committed_at: now,
    })
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn persist_prepared_canvas_mutation(
    connection: &Connection,
    commit_context: Option<&CommitContext>,
    authority: &DocumentAuthorityRow,
    actor_project_id: &str,
    access_context: &OwnedDocumentAccessContext,
    store_epoch: &str,
    operation_id: &str,
    base_head_seq: i64,
    intent_hash: &str,
    mutation: &CanvasMutation,
    prepared: &PreparedCanvasMutation,
    assets_root: &Path,
    durable_event_kind: &str,
) -> Result<PersistedCanvasMutation, StoreError> {
    validate_canvas_authority(authority)?;
    if base_head_seq > authority.head.head_seq {
        return Err(StoreError::new(
            StoreErrorCode::HeadConflict,
            "Canvas mutation is based on a future Document head",
            true,
        ));
    }
    if connection
        .query_row(
            "SELECT 1 FROM canvas_scene_mutation_receipts \
             WHERE document_id = ?1 AND mutation_id = ?2",
            params![authority.head.id, operation_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some()
    {
        return Err(corrupt(
            "Canvas mutation receipt exists without its Module receipt",
        ));
    }
    validate_file_additions(
        connection,
        authority,
        &prepared
            .file_additions
            .iter()
            .map(|record| (record.file.id.clone(), record.file.clone()))
            .collect(),
    )?;
    let now = sqlite_now(connection)?;
    let changed = prepared.changed();
    let head_seq = if changed {
        authority
            .head
            .head_seq
            .checked_add(1)
            .ok_or_else(|| internal("Canvas head sequence overflowed"))?
    } else {
        authority.head.head_seq
    };
    let scene_hash = if changed {
        apply_prepared_canvas_authority(
            connection,
            authority,
            prepared,
            head_seq,
            &now,
            assets_root,
        )?
    } else {
        prepared.scene_hash_before.clone()
    };
    let event_sequence = if changed {
        let payload = json!({
            "module": "owned_document",
            "kind": durable_event_kind,
            "documentId": authority.head.id,
            "generation": authority.head.generation,
            "baseHeadSeq": authority.head.head_seq,
            "headSeq": head_seq,
            "mutationId": operation_id,
            "sceneHash": scene_hash,
            "changedElementIds": prepared.changed_element_ids,
            "appliedAppStateKeys": prepared.applied_app_state_keys,
            "skippedAppStateKeys": prepared.skipped_app_state_keys,
            "addedFileIds": prepared.added_file_ids,
            "removedFileIds": prepared.removed_file_ids,
            "eventDelta": prepared.event_delta,
        });
        let block_ids = vec![authority.owner_block_id.clone()];
        let document_ids = vec![authority.head.id.clone()];
        let payload_json = canonical_json(&payload)?;
        let kind = format!("owned_document.{durable_event_kind}");
        append_change_log(
            connection,
            NewChangeLogEntry {
                project_id: actor_project_id,
                store_epoch,
                kind: &kind,
                operation_id: Some(operation_id),
                block_ids: &block_ids,
                document_ids: &document_ids,
                database_block_ids: &[],
                payload_json: &payload_json,
                projection_impact: &ProjectionImpact::None,
                committed_at: &now,
            },
            commit_context
                .ok_or_else(|| corrupt("Canvas mutation changed without a LocalCommit context"))?,
        )?
    } else {
        read_event_head(connection)?
    };
    let outcome = if changed { "committed" } else { "no_change" };
    let mut result = json!({
        "mutationId": operation_id,
        "libraryId": authority.head.library_id,
        "accessContext": access_context,
        "documentId": authority.head.id,
        "storeEpoch": store_epoch,
        "generation": authority.head.generation,
        "baseHeadSeq": base_head_seq,
        "headSeq": head_seq,
        "duplicate": false,
        "outcome": outcome,
        "sceneHash": scene_hash,
        "changedElementIds": prepared.changed_element_ids,
        "appliedAppStateKeys": prepared.applied_app_state_keys,
        "skippedAppStateKeys": prepared.skipped_app_state_keys,
        "addedFileIds": prepared.added_file_ids,
        "removedFileIds": prepared.removed_file_ids,
        "committedAt": now,
    });
    if changed {
        result
            .as_object_mut()
            .ok_or_else(|| internal("Canvas mutation result must be an object"))?
            .insert("committedDelta".to_owned(), prepared.event_delta.clone());
    }
    let intent_json = canonical_json(&mutation.canonical_value)?;
    connection.execute(
        "INSERT INTO canvas_scene_mutation_receipts (\
           document_id, generation, mutation_id, base_head_seq, committed_head_seq, \
           intent_hash, intent_byte_length, outcome, committed_at\
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            authority.head.id,
            authority.head.generation,
            operation_id,
            base_head_seq,
            head_seq,
            intent_hash,
            i64::try_from(intent_json.len()).map_err(|_| internal("Canvas intent length"))?,
            outcome,
            now,
        ],
    )?;
    Ok(PersistedCanvasMutation {
        event_base_head_seq: authority.head.head_seq,
        head_seq,
        scene_hash,
        result,
        event_delta: changed.then(|| prepared.event_delta.clone()),
        event_sequence,
        committed_at: now,
    })
}

fn apply_prepared_canvas_authority(
    connection: &Connection,
    authority: &DocumentAuthorityRow,
    prepared: &PreparedCanvasMutation,
    head_seq: i64,
    now: &str,
    assets_root: &Path,
) -> Result<String, StoreError> {
    for change in &prepared.element_changes {
        let element = &change.after;
        connection.execute(
            "INSERT INTO canvas_scene_elements (\
               document_id, element_id, version, version_nonce, order_key, is_deleted, \
               element_json, element_hash, hash_bucket, referenced_file_id, plain_text, updated_at\
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12) \
             ON CONFLICT(document_id, element_id) DO UPDATE SET \
               version = excluded.version, version_nonce = excluded.version_nonce, \
               order_key = excluded.order_key, is_deleted = excluded.is_deleted, \
               element_json = excluded.element_json, element_hash = excluded.element_hash, \
               hash_bucket = excluded.hash_bucket, \
               referenced_file_id = excluded.referenced_file_id, plain_text = excluded.plain_text, \
               updated_at = excluded.updated_at",
            params![
                authority.head.id,
                element.element.id,
                element.element.version,
                element.element.version_nonce,
                element.element.order_key,
                i64::from(element.element.is_deleted),
                element.element_json,
                element.element_hash,
                i64::from(element.hash_bucket),
                element.derived.referenced_file_id,
                element.derived.plain_text,
                now,
            ],
        )?;
    }
    for file in &prepared.removed_files {
        connection.execute(
            "DELETE FROM canvas_scene_files WHERE document_id = ?1 AND file_id = ?2",
            params![authority.head.id, file.file.id],
        )?;
    }
    for file in &prepared.file_additions {
        persist_file(connection, &authority.head.id, &file.file, now)?;
    }
    for bucket_index in &prepared.affected_bucket_indices {
        refresh_canvas_hash_bucket(connection, &authority.head.id, *bucket_index)?;
    }
    let buckets = read_canvas_hash_buckets(connection, &authority.head.id)?;
    let scene_hash = canvas_scene_root_hash(
        authority.head.schema_version,
        &prepared.app_state_hash_after,
        prepared.counters_after.element_count,
        prepared.counters_after.file_count,
        &buckets,
    )?;
    let updated_document = connection.execute(
        "UPDATE documents SET head_seq = ?1, state_hash = ?2, updated_at = ?3 \
         WHERE id = ?4 AND library_id = ?5 AND generation = ?6 AND head_seq = ?7 \
           AND sync_engine = 'canvas_scene' AND readiness = 'ready' \
           AND authority = 'ydoc_primary' AND length(state_vector) = 0",
        params![
            head_seq,
            scene_hash,
            now,
            authority.head.id,
            authority.head.library_id,
            authority.head.generation,
            authority.head.head_seq,
        ],
    )?;
    let updated_scene = connection.execute(
        "UPDATE canvas_scenes SET head_seq = ?1, app_state_json = ?2, app_state_hash = ?3, \
           scene_hash = ?4, element_count = ?5, tombstone_count = ?6, file_count = ?7, \
           element_json_bytes = ?8, tombstone_json_bytes = ?9, file_json_bytes = ?10, \
           scene_byte_length = ?11, updated_at = ?12 \
         WHERE document_id = ?13 AND generation = ?14 AND head_seq = ?15 \
           AND scene_hash_version = ?16",
        params![
            head_seq,
            prepared.app_state_json_after,
            prepared.app_state_hash_after,
            scene_hash,
            prepared.counters_after.element_count,
            prepared.counters_after.tombstone_count,
            prepared.counters_after.file_count,
            prepared.counters_after.element_json_bytes,
            prepared.counters_after.tombstone_json_bytes,
            prepared.counters_after.file_json_bytes,
            prepared.counters_after.scene_byte_length,
            now,
            authority.head.id,
            authority.head.generation,
            authority.head.head_seq,
            CANVAS_SCENE_HASH_VERSION,
        ],
    )?;
    if updated_document != 1 || updated_scene != 1 {
        return Err(conflict("Canvas Document head changed before commit"));
    }
    apply_canvas_projection_delta(connection, authority, prepared, head_seq, now, assets_root)?;
    Ok(scene_hash)
}

pub(crate) fn persist_canvas_compaction(
    connection: &Connection,
    authority: &DocumentAuthorityRow,
    prepared: &PreparedCanvasCompaction,
    now: &str,
    assets_root: &Path,
) -> Result<PersistedCanvasCompaction, StoreError> {
    validate_canvas_authority(authority)?;
    if prepared.stats.document_id != authority.head.id
        || prepared.stats.generation != authority.head.generation
        || prepared.stats.head_seq != authority.head.head_seq
        || prepared.stats.scene_hash != authority.head.state_hash
        || prepared.stats.tombstone_count < 1
    {
        return Err(conflict(
            "Canvas compaction preparation no longer matches its authority",
        ));
    }
    let generation = authority
        .head
        .generation
        .checked_add(1)
        .ok_or_else(|| internal("Canvas generation overflowed"))?;
    let head_seq = 1;
    let metadata = compute_canvas_scene_incremental_metadata(&prepared.compacted_scene)?;
    connection.execute(
        "DELETE FROM canvas_scene_elements WHERE document_id = ?1 AND is_deleted = 1",
        [&authority.head.id],
    )?;
    connection.execute(
        "DELETE FROM canvas_scene_files \
         WHERE document_id = ?1 AND file_id NOT IN (\
           SELECT DISTINCT referenced_file_id FROM canvas_scene_elements \
           WHERE document_id = ?1 AND referenced_file_id IS NOT NULL\
         )",
        [&authority.head.id],
    )?;
    connection.execute(
        "DELETE FROM canvas_scene_hash_buckets WHERE document_id = ?1",
        [&authority.head.id],
    )?;
    for (bucket_index, bucket) in &metadata.hash_buckets {
        connection.execute(
            "INSERT INTO canvas_scene_hash_buckets (\
               document_id, bucket_index, item_count, bucket_hash\
             ) VALUES (?1, ?2, ?3, ?4)",
            params![
                authority.head.id,
                i64::from(*bucket_index),
                bucket.item_count,
                bucket.bucket_hash
            ],
        )?;
    }
    let updated_document = connection.execute(
        "UPDATE documents SET generation = ?1, head_seq = ?2, state_hash = ?3, updated_at = ?4 \
         WHERE id = ?5 AND library_id = ?6 AND generation = ?7 AND head_seq = ?8 \
           AND sync_engine = 'canvas_scene' AND readiness = 'ready' \
           AND authority = 'ydoc_primary' AND length(state_vector) = 0",
        params![
            generation,
            head_seq,
            metadata.scene_hash,
            now,
            authority.head.id,
            authority.head.library_id,
            authority.head.generation,
            authority.head.head_seq,
        ],
    )?;
    let updated_scene = connection.execute(
        "UPDATE canvas_scenes SET generation = ?1, head_seq = ?2, \
           app_state_json = ?3, app_state_hash = ?4, scene_hash = ?5, \
           element_count = ?6, tombstone_count = ?7, file_count = ?8, \
           element_json_bytes = ?9, tombstone_json_bytes = ?10, file_json_bytes = ?11, \
           scene_byte_length = ?12, updated_at = ?13 \
         WHERE document_id = ?14 AND generation = ?15 AND head_seq = ?16 \
           AND scene_hash_version = ?17",
        params![
            generation,
            head_seq,
            metadata.app_state_json,
            metadata.app_state_hash,
            metadata.scene_hash,
            metadata.counters.element_count,
            metadata.counters.tombstone_count,
            metadata.counters.file_count,
            metadata.counters.element_json_bytes,
            metadata.counters.tombstone_json_bytes,
            metadata.counters.file_json_bytes,
            metadata.counters.scene_byte_length,
            now,
            authority.head.id,
            authority.head.generation,
            authority.head.head_seq,
            CANVAS_SCENE_HASH_VERSION,
        ],
    )?;
    if updated_document != 1 || updated_scene != 1 {
        return Err(conflict("Canvas head changed before compaction commit"));
    }
    let mut next_authority = authority.clone();
    next_authority.head.generation = generation;
    next_authority.head.head_seq = head_seq;
    next_authority.head.state_hash = metadata.scene_hash.clone();
    replace_canvas_projections(
        connection,
        &next_authority,
        &prepared.compacted_scene,
        now,
        assets_root,
    )?;
    connection.execute(
        "DELETE FROM document_revision_sessions WHERE document_id = ?1",
        [&authority.head.id],
    )?;
    Ok(PersistedCanvasCompaction {
        generation,
        head_seq,
        scene_hash: metadata.scene_hash,
    })
}

fn refresh_canvas_hash_bucket(
    connection: &Connection,
    document_id: &str,
    bucket_index: u16,
) -> Result<(), StoreError> {
    let mut items = connection
        .prepare(
            "SELECT element_id, element_hash FROM canvas_scene_elements \
             WHERE document_id = ?1 AND hash_bucket = ?2 ORDER BY element_id",
        )?
        .query_map(params![document_id, i64::from(bucket_index)], |row| {
            Ok(CanvasHashItem {
                kind: CanvasHashItemKind::Element,
                id: row.get(0)?,
                canonical_hash: row.get(1)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    items.extend(
        connection
            .prepare(
                "SELECT file_id, file_hash FROM canvas_scene_files \
                 WHERE document_id = ?1 AND hash_bucket = ?2 ORDER BY file_id",
            )?
            .query_map(params![document_id, i64::from(bucket_index)], |row| {
                Ok(CanvasHashItem {
                    kind: CanvasHashItemKind::File,
                    id: row.get(0)?,
                    canonical_hash: row.get(1)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?,
    );
    if items.is_empty() {
        connection.execute(
            "DELETE FROM canvas_scene_hash_buckets \
             WHERE document_id = ?1 AND bucket_index = ?2",
            params![document_id, i64::from(bucket_index)],
        )?;
        return Ok(());
    }
    let bucket_hash = canvas_bucket_hash(bucket_index, &items)?;
    connection.execute(
        "INSERT INTO canvas_scene_hash_buckets (\
           document_id, bucket_index, item_count, bucket_hash\
         ) VALUES (?1, ?2, ?3, ?4) \
         ON CONFLICT(document_id, bucket_index) DO UPDATE SET \
           item_count = excluded.item_count, bucket_hash = excluded.bucket_hash",
        params![
            document_id,
            i64::from(bucket_index),
            i64::try_from(items.len()).map_err(|_| internal("Canvas bucket item count"))?,
            bucket_hash
        ],
    )?;
    Ok(())
}

fn read_canvas_hash_buckets(
    connection: &Connection,
    document_id: &str,
) -> Result<BTreeMap<u16, CanvasHashBucket>, StoreError> {
    connection
        .prepare(
            "SELECT bucket_index, item_count, bucket_hash \
             FROM canvas_scene_hash_buckets WHERE document_id = ?1 ORDER BY bucket_index",
        )?
        .query_map([document_id], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                CanvasHashBucket {
                    item_count: row.get(1)?,
                    bucket_hash: row.get(2)?,
                },
            ))
        })?
        .map(|row| {
            let (bucket_index, bucket) = row?;
            let bucket_index = u16::try_from(bucket_index)
                .map_err(|_| corrupt("Canvas hash bucket index is invalid"))?;
            Ok((bucket_index, bucket))
        })
        .collect()
}

fn apply_canvas_projection_delta(
    connection: &Connection,
    authority: &DocumentAuthorityRow,
    prepared: &PreparedCanvasMutation,
    head_seq: i64,
    now: &str,
    assets_root: &Path,
) -> Result<(), StoreError> {
    for change in &prepared.element_changes {
        if change
            .before
            .as_ref()
            .and_then(|record| record.derived.page_reference.as_ref())
            == change.after.derived.page_reference.as_ref()
        {
            continue;
        }
        connection.execute(
            "DELETE FROM canvas_page_references \
             WHERE document_id = ?1 AND source_element_id = ?2",
            params![authority.head.id, change.after.element.id],
        )?;
        let Some(reference) = &change.after.derived.page_reference else {
            continue;
        };
        connection.execute(
            "INSERT INTO canvas_page_references (\
               document_id, source_element_id, target_block_id, owner_block_id, library_id, \
               document_generation, projected_seq, title_hint, updated_at\
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                authority.head.id,
                reference.source_element_id,
                reference.target_block_id,
                authority.owner_block_id,
                authority.head.library_id,
                authority.head.generation,
                head_seq,
                reference.title_hint,
                now,
            ],
        )?;
    }
    for file in &prepared.removed_files {
        connection.execute(
            "DELETE FROM canvas_scene_file_refs WHERE document_id = ?1 AND file_id = ?2",
            params![authority.head.id, file.file.id],
        )?;
    }
    for file in &prepared.file_additions {
        let evidence = asset_evidence(connection, &authority.head.id, &file.file, assets_root)?;
        connection.execute(
            "INSERT INTO canvas_scene_file_refs (\
               document_id, file_id, owner_block_id, library_id, document_generation, \
               projected_seq, mime_type, asset_uri, target_file_id, file_version, default_name, asset_hash, \
               byte_length, updated_at\
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![
                authority.head.id,
                file.file.id,
                authority.owner_block_id,
                authority.head.library_id,
                authority.head.generation,
                head_seq,
                file.file.mime_type,
                file.file.source,
                file.file.target_file_id,
                file.file.file_version,
                file.file.default_name,
                evidence.0,
                evidence.1,
                now,
            ],
        )?;
    }
    if let Some(plain_text) = &prepared.plain_text_after {
        let updated = connection.execute(
            "UPDATE block_search_units SET document_generation = ?1, projected_seq = ?2, \
               projection_version = ?3, text = ?4, text_hash = ?5, updated_at = ?6 \
             WHERE document_id = ?7 AND source_revision IS NULL \
               AND source_kind = 'document_marker'",
            params![
                authority.head.generation,
                head_seq,
                PROJECTION_VERSION,
                plain_text,
                sha256(plain_text.as_bytes()),
                now,
                authority.head.id
            ],
        )?;
        if updated != 1 {
            return Err(corrupt("Canvas search marker is missing or ambiguous"));
        }
    }
    connection.execute(
        "INSERT INTO canvas_scene_projection_heads (\
           document_id, generation, projected_head_seq, projection_version, updated_at\
         ) VALUES (?1, ?2, ?3, ?4, ?5) \
         ON CONFLICT(document_id) DO UPDATE SET \
           generation = excluded.generation, projected_head_seq = excluded.projected_head_seq, \
           projection_version = excluded.projection_version, updated_at = excluded.updated_at",
        params![
            authority.head.id,
            authority.head.generation,
            head_seq,
            PROJECTION_VERSION,
            now
        ],
    )?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn persist_changed_scene(
    connection: &Connection,
    authority: &DocumentAuthorityRow,
    scene: &CanvasScene,
    applied: &AppliedCanvasMutation,
    head_seq: i64,
    scene_hash: &str,
    now: &str,
    assets_root: &Path,
) -> Result<(), StoreError> {
    let metadata = compute_canvas_scene_incremental_metadata(scene)?;
    for id in &applied.changed_element_ids {
        let Some(element) = scene.elements.iter().find(|element| &element.id == id) else {
            return Err(internal("Changed Canvas element is missing from candidate"));
        };
        let element_json = canonical_json(&element.value)?;
        let derived = derive_canvas_element(element)?;
        connection.execute(
            "INSERT INTO canvas_scene_elements (\
               document_id, element_id, version, version_nonce, order_key, is_deleted, \
               element_json, element_hash, hash_bucket, referenced_file_id, plain_text, updated_at\
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12) \
             ON CONFLICT(document_id, element_id) DO UPDATE SET \
               version = excluded.version, version_nonce = excluded.version_nonce, \
               order_key = excluded.order_key, is_deleted = excluded.is_deleted, \
               element_json = excluded.element_json, element_hash = excluded.element_hash, \
               hash_bucket = excluded.hash_bucket, \
               referenced_file_id = excluded.referenced_file_id, plain_text = excluded.plain_text, \
               updated_at = excluded.updated_at",
            params![
                authority.head.id,
                element.id,
                element.version,
                element.version_nonce,
                element.order_key,
                i64::from(element.is_deleted),
                element_json,
                sha256(element_json.as_bytes()),
                i64::from(canvas_hash_bucket(CanvasHashItemKind::Element, &element.id)),
                derived.referenced_file_id,
                derived.plain_text,
                now,
            ],
        )?;
    }
    for id in &applied.removed_file_ids {
        connection.execute(
            "DELETE FROM canvas_scene_files WHERE document_id = ?1 AND file_id = ?2",
            params![authority.head.id, id],
        )?;
    }
    for id in &applied.added_file_ids {
        let file = scene
            .files
            .get(id)
            .ok_or_else(|| internal("Added Canvas file is missing from candidate"))?;
        persist_file(connection, &authority.head.id, file, now)?;
    }
    connection.execute(
        "DELETE FROM canvas_scene_hash_buckets WHERE document_id = ?1",
        [&authority.head.id],
    )?;
    for (bucket_index, bucket) in &metadata.hash_buckets {
        connection.execute(
            "INSERT INTO canvas_scene_hash_buckets (\
               document_id, bucket_index, item_count, bucket_hash\
             ) VALUES (?1, ?2, ?3, ?4)",
            params![
                authority.head.id,
                i64::from(*bucket_index),
                bucket.item_count,
                bucket.bucket_hash
            ],
        )?;
    }
    let updated_document = connection.execute(
        "UPDATE documents SET head_seq = ?1, state_hash = ?2, updated_at = ?3 \
         WHERE id = ?4 AND library_id = ?5 AND generation = ?6 AND head_seq = ?7 \
           AND sync_engine = 'canvas_scene' AND readiness = 'ready' \
           AND authority = 'ydoc_primary' AND length(state_vector) = 0",
        params![
            head_seq,
            scene_hash,
            now,
            authority.head.id,
            authority.head.library_id,
            authority.head.generation,
            authority.head.head_seq,
        ],
    )?;
    let updated_scene = connection.execute(
        "UPDATE canvas_scenes SET head_seq = ?1, app_state_json = ?2, app_state_hash = ?3, \
           scene_hash = ?4, element_count = ?5, tombstone_count = ?6, file_count = ?7, \
           element_json_bytes = ?8, tombstone_json_bytes = ?9, file_json_bytes = ?10, \
           scene_byte_length = ?11, updated_at = ?12 \
         WHERE document_id = ?13 AND generation = ?14 AND head_seq = ?15 \
           AND scene_hash_version = ?16",
        params![
            head_seq,
            metadata.app_state_json,
            metadata.app_state_hash,
            scene_hash,
            metadata.counters.element_count,
            metadata.counters.tombstone_count,
            metadata.counters.file_count,
            metadata.counters.element_json_bytes,
            metadata.counters.tombstone_json_bytes,
            metadata.counters.file_json_bytes,
            metadata.counters.scene_byte_length,
            now,
            authority.head.id,
            authority.head.generation,
            authority.head.head_seq,
            CANVAS_SCENE_HASH_VERSION,
        ],
    )?;
    if updated_document != 1 || updated_scene != 1 {
        return Err(conflict("Canvas Document head changed before commit"));
    }
    let mut next_authority = authority.clone();
    next_authority.head.head_seq = head_seq;
    next_authority.head.state_hash = scene_hash.to_owned();
    replace_canvas_projections(connection, &next_authority, scene, now, assets_root)
}

/// Recomputes every derived Canvas coordinate after the v151 asset slots have
/// been rewritten to exact Library File versions. Migration keeps generation
/// and head sequence stable; only the schema identity and canonical state hash
/// change.
pub(crate) fn rebuild_migrated_canvas_scene(
    connection: &Connection,
    document_id: &str,
    assets_root: &Path,
    now: &str,
) -> Result<(), StoreError> {
    let mut authority = super::read_document_authority(connection, document_id)?
        .ok_or_else(|| corrupt("Migrated Canvas lost its Document authority"))?;
    let app_state_json: String = connection.query_row(
        "SELECT app_state_json FROM canvas_scenes WHERE document_id = ?1",
        [document_id],
        |row| row.get(0),
    )?;
    let element_rows = connection
        .prepare(
            "SELECT element_id, order_key, element_json FROM canvas_scene_elements \
             WHERE document_id = ?1 ORDER BY order_key, element_id",
        )?
        .query_map([document_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut elements = Vec::with_capacity(element_rows.len());
    for (id, order_key, encoded) in element_rows {
        let value = serde_json::from_str::<Value>(&encoded)
            .map_err(|_| corrupt("Migrated Canvas element JSON is invalid"))?;
        elements.push(parse_stored_element(&value, &id, order_key)?);
    }
    let file_rows = connection
        .prepare(
            "SELECT file_id, file_json FROM canvas_scene_files \
             WHERE document_id = ?1 ORDER BY file_id",
        )?
        .query_map([document_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut files = BTreeMap::new();
    for (id, encoded) in file_rows {
        let value = serde_json::from_str::<Value>(&encoded)
            .map_err(|_| corrupt("Migrated Canvas File JSON is invalid"))?;
        files.insert(id.clone(), parse_stored_file(&value, &id)?);
    }
    let app_state = serde_json::from_str::<Value>(&app_state_json)
        .map_err(|_| corrupt("Migrated Canvas appState is invalid"))?;
    let scene = materialize_loaded_scene(elements, &app_state, files)?;
    let metadata = compute_canvas_scene_incremental_metadata(&scene)?;

    connection.execute(
        "UPDATE documents SET schema_version = ?1, state_hash = ?2, updated_at = ?3 \
         WHERE id = ?4 AND sync_engine = 'canvas_scene'",
        params![CANVAS_SCHEMA_VERSION, metadata.scene_hash, now, document_id],
    )?;
    connection.execute(
        "UPDATE canvas_scenes SET schema_version = ?1, app_state_json = ?2, app_state_hash = ?3, \
           scene_hash = ?4, element_count = ?5, tombstone_count = ?6, file_count = ?7, \
           element_json_bytes = ?8, tombstone_json_bytes = ?9, file_json_bytes = ?10, \
           scene_byte_length = ?11, updated_at = ?12 WHERE document_id = ?13",
        params![
            CANVAS_SCHEMA_VERSION,
            metadata.app_state_json,
            metadata.app_state_hash,
            metadata.scene_hash,
            metadata.counters.element_count,
            metadata.counters.tombstone_count,
            metadata.counters.file_count,
            metadata.counters.element_json_bytes,
            metadata.counters.tombstone_json_bytes,
            metadata.counters.file_json_bytes,
            metadata.counters.scene_byte_length,
            now,
            document_id,
        ],
    )?;
    connection.execute(
        "DELETE FROM canvas_scene_hash_buckets WHERE document_id = ?1",
        [document_id],
    )?;
    for (bucket_index, bucket) in &metadata.hash_buckets {
        connection.execute(
            "INSERT INTO canvas_scene_hash_buckets(document_id, bucket_index, item_count, bucket_hash) \
             VALUES (?1, ?2, ?3, ?4)",
            params![document_id, i64::from(*bucket_index), bucket.item_count, bucket.bucket_hash],
        )?;
    }
    authority.head.schema_version = CANVAS_SCHEMA_VERSION;
    authority.head.state_hash = metadata.scene_hash;
    replace_canvas_projections(connection, &authority, &scene, now, assets_root)
}

fn persist_file(
    connection: &Connection,
    document_id: &str,
    file: &CanvasFile,
    now: &str,
) -> Result<(), StoreError> {
    let file_json = canonical_json(&file.value)?;
    connection.execute(
        "INSERT INTO canvas_scene_files (\
           document_id, file_id, mime_type, asset_uri, created_ms, file_json, file_hash, \
           hash_bucket, updated_at\
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) \
         ON CONFLICT(document_id, file_id) DO UPDATE SET \
           mime_type = excluded.mime_type, asset_uri = excluded.asset_uri, \
           created_ms = excluded.created_ms, file_json = excluded.file_json, \
           file_hash = excluded.file_hash, hash_bucket = excluded.hash_bucket, \
           updated_at = excluded.updated_at",
        params![
            document_id,
            file.id,
            file.mime_type,
            file.source,
            file.created_ms,
            file_json,
            sha256(file_json.as_bytes()),
            i64::from(canvas_hash_bucket(CanvasHashItemKind::File, &file.id)),
            now,
        ],
    )?;
    Ok(())
}

pub(super) fn replace_canvas_projections(
    connection: &Connection,
    authority: &DocumentAuthorityRow,
    scene: &CanvasScene,
    now: &str,
    assets_root: &Path,
) -> Result<(), StoreError> {
    connection.execute(
        "DELETE FROM block_asset_refs WHERE document_id = ?1",
        [&authority.head.id],
    )?;
    connection.execute(
        "DELETE FROM canvas_scene_file_refs WHERE document_id = ?1",
        [&authority.head.id],
    )?;
    connection.execute(
        "DELETE FROM canvas_page_references WHERE document_id = ?1",
        [&authority.head.id],
    )?;
    connection.execute(
        "DELETE FROM block_search_units WHERE document_id = ?1 AND source_revision IS NULL",
        [&authority.head.id],
    )?;
    let unit_key = format!(
        "document:{}",
        sha256(
            serde_json::to_string(&[
                authority.head.id.as_str(),
                authority.owner_block_id.as_str(),
                "document_marker",
                "marker",
            ])
            .map_err(|_| internal("Canvas search unit key"))?
            .as_bytes()
        )
    );
    connection.execute(
        "INSERT INTO block_search_units (\
           unit_key, library_id, block_id, owner_block_id, document_id, \
           document_generation, projected_seq, source_revision, projection_version, \
           source_kind, field_key, text, text_hash, updated_at\
         ) VALUES (?1, ?2, ?3, ?3, ?4, ?5, ?6, NULL, ?7, \
                   'document_marker', 'marker', ?8, ?9, ?10)",
        params![
            unit_key,
            authority.head.library_id,
            authority.owner_block_id,
            authority.head.id,
            authority.head.generation,
            authority.head.head_seq,
            PROJECTION_VERSION,
            scene.plain_text,
            sha256(scene.plain_text.as_bytes()),
            now,
        ],
    )?;
    for reference in &scene.page_references {
        connection.execute(
            "INSERT INTO canvas_page_references (\
               document_id, source_element_id, target_block_id, owner_block_id, library_id, \
               document_generation, projected_seq, title_hint, updated_at\
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                authority.head.id,
                reference.source_element_id,
                reference.target_block_id,
                authority.owner_block_id,
                authority.head.library_id,
                authority.head.generation,
                authority.head.head_seq,
                reference.title_hint,
                now,
            ],
        )?;
    }
    for file in scene.files.values() {
        let evidence = asset_evidence(connection, &authority.head.id, file, assets_root)?;
        connection.execute(
            "INSERT INTO canvas_scene_file_refs (\
               document_id, file_id, owner_block_id, library_id, document_generation, \
               projected_seq, mime_type, asset_uri, target_file_id, file_version, default_name, asset_hash, \
               byte_length, updated_at\
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![
                authority.head.id,
                file.id,
                authority.owner_block_id,
                authority.head.library_id,
                authority.head.generation,
                authority.head.head_seq,
                file.mime_type,
                file.source,
                file.target_file_id,
                file.file_version,
                file.default_name,
                evidence.0,
                evidence.1,
                now,
            ],
        )?;
    }
    connection.execute(
        "INSERT INTO canvas_scene_projection_heads (\
           document_id, generation, projected_head_seq, projection_version, updated_at\
         ) VALUES (?1, ?2, ?3, ?4, ?5) \
         ON CONFLICT(document_id) DO UPDATE SET \
           generation = excluded.generation, projected_head_seq = excluded.projected_head_seq, \
           projection_version = excluded.projection_version, updated_at = excluded.updated_at",
        params![
            authority.head.id,
            authority.head.generation,
            authority.head.head_seq,
            PROJECTION_VERSION,
            now
        ],
    )?;
    Ok(())
}

fn asset_evidence(
    connection: &Connection,
    document_id: &str,
    file: &CanvasFile,
    _assets_root: &Path,
) -> Result<(String, i64), StoreError> {
    super::canvas_files::content_evidence(connection, document_id, file)
}

fn validate_file_additions(
    connection: &Connection,
    authority: &DocumentAuthorityRow,
    files: &BTreeMap<String, CanvasFile>,
) -> Result<(), StoreError> {
    for file in files.values() {
        super::canvas_files::content_evidence(connection, &authority.head.id, file)?;
    }
    Ok(())
}

fn validate_page_references(
    connection: &Connection,
    authority: &DocumentAuthorityRow,
    scene: &CanvasScene,
) -> Result<(), StoreError> {
    for reference in &scene.page_references {
        let valid = connection
            .query_row(
                "SELECT 1 FROM blocks WHERE id = ?1 AND library_id = ?2 \
                   AND lifecycle <> 'deleted' AND type = 'page'",
                params![reference.target_block_id, authority.head.library_id],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        if !valid {
            return Err(invalid(
                "Canvas scene contains a missing, deleted, or cross-Project Page reference",
            ));
        }
    }
    Ok(())
}

fn sqlite_now(connection: &Connection) -> Result<String, StoreError> {
    connection
        .query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", [], |row| {
            row.get::<_, String>(0)
        })
        .map_err(StoreError::from)
}

fn invalid(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message.into(), false)
}

fn conflict(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::HeadConflict, message, true)
}

fn corrupt(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message.into(), false)
}

fn internal(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::Internal, message, false)
}

#[cfg(test)]
mod maintenance_tests {
    use super::{
        CANVAS_COMPACTION_TOMBSTONE_BYTES_THRESHOLD, CANVAS_COMPACTION_TOMBSTONE_COUNT_THRESHOLD,
        canvas_compaction_eligible,
    };

    #[test]
    fn compaction_thresholds_are_inclusive() {
        assert!(!canvas_compaction_eligible(
            CANVAS_COMPACTION_TOMBSTONE_COUNT_THRESHOLD - 1,
            CANVAS_COMPACTION_TOMBSTONE_BYTES_THRESHOLD - 1,
        ));
        assert!(canvas_compaction_eligible(
            CANVAS_COMPACTION_TOMBSTONE_COUNT_THRESHOLD,
            0,
        ));
        assert!(canvas_compaction_eligible(
            1,
            CANVAS_COMPACTION_TOMBSTONE_BYTES_THRESHOLD,
        ));
    }
}
