#[cfg(test)]
use std::cell::Cell;
use std::collections::{HashMap, VecDeque};
use std::sync::OnceLock;
use std::time::Instant;

use rusqlite::Connection;
use sha2::{Digest, Sha256};

use crate::infrastructure::document_repository::{DocumentHeadRow, DocumentReadRepository};
use crate::infrastructure::metrics::{DurationMetric, DurationMetricSnapshot};
use crate::infrastructure::request_execution::check_request_interruption;
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

use super::{
    BlockDocumentSchema, MAX_DOCUMENT_UPDATE_BYTES, YrsDocumentEngine, decode_block_document,
    materialize_decoded_document,
};

const DEFAULT_MAX_DOCUMENTS: usize = 64;
const DEFAULT_MAX_STATE_BYTES: usize = 64 * 1024 * 1024;
static RECONSTRUCTION_DURATION: OnceLock<DurationMetric> = OnceLock::new();

#[cfg(test)]
thread_local! {
    static THREAD_RECONSTRUCTION_COUNT: Cell<u64> = const { Cell::new(0) };
}

pub(crate) struct DocumentRuntimeCache {
    entries: HashMap<String, CacheEntry>,
    lru: VecDeque<String>,
    total_state_bytes: usize,
    maximum_documents: usize,
    maximum_state_bytes: usize,
    hits: u64,
    misses: u64,
}

pub(crate) struct DocumentWorkingCopy {
    pub engine: YrsDocumentEngine,
    pub full_state: Vec<u8>,
}

struct CacheEntry {
    generation: i64,
    head_seq: i64,
    state_vector: Vec<u8>,
    state_bytes: usize,
    full_state: Vec<u8>,
    engine: YrsDocumentEngine,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct DocumentCacheStats {
    pub entries: usize,
    pub state_bytes: usize,
    pub hits: u64,
    pub misses: u64,
}

impl DocumentRuntimeCache {
    pub(crate) fn new() -> Self {
        Self::with_limits(DEFAULT_MAX_DOCUMENTS, DEFAULT_MAX_STATE_BYTES)
    }

    #[cfg(test)]
    pub(crate) fn with_limits(maximum_documents: usize, maximum_state_bytes: usize) -> Self {
        Self {
            entries: HashMap::new(),
            lru: VecDeque::new(),
            total_state_bytes: 0,
            maximum_documents,
            maximum_state_bytes,
            hits: 0,
            misses: 0,
        }
    }

    #[cfg(not(test))]
    fn with_limits(maximum_documents: usize, maximum_state_bytes: usize) -> Self {
        Self {
            entries: HashMap::new(),
            lru: VecDeque::new(),
            total_state_bytes: 0,
            maximum_documents,
            maximum_state_bytes,
            hits: 0,
            misses: 0,
        }
    }

    pub(crate) fn clone_engine(
        &mut self,
        connection: &Connection,
        head: &DocumentHeadRow,
    ) -> Result<YrsDocumentEngine, StoreError> {
        self.clone_engine_with_state(connection, head)
            .map(|working| working.engine)
    }

    pub(crate) fn clone_engine_with_state(
        &mut self,
        connection: &Connection,
        head: &DocumentHeadRow,
    ) -> Result<DocumentWorkingCopy, StoreError> {
        check_request_interruption()?;
        if let Some(entry) = self.entries.get(&head.id)
            && entry_matches(entry, head)
        {
            let full_state = entry.full_state.clone();
            self.hits += 1;
            self.touch(&head.id);
            let engine = YrsDocumentEngine::from_full_state_v1(&head.id, &full_state)
                .map_err(|error| corrupt(format!("Cached Document clone failed: {error}")))?;
            check_request_interruption()?;
            return Ok(DocumentWorkingCopy { engine, full_state });
        }
        self.remove(&head.id);
        self.misses += 1;
        let engine = reconstruct_yjs_engine(connection, head)?;
        let full_state = engine.full_state_v1();
        check_request_interruption()?;
        let working = YrsDocumentEngine::from_full_state_v1(&head.id, &full_state)
            .map_err(|error| corrupt(format!("Reconstructed Document clone failed: {error}")))?;
        self.install_with_state(head, engine, full_state.clone());
        Ok(DocumentWorkingCopy {
            engine: working,
            full_state,
        })
    }

    pub(crate) fn sync_diff(
        &mut self,
        connection: &Connection,
        head: &DocumentHeadRow,
        remote_state_vector: &[u8],
    ) -> Result<Vec<u8>, StoreError> {
        check_request_interruption()?;
        if let Some(entry) = self.entries.get(&head.id)
            && entry_matches(entry, head)
        {
            let update = entry
                .engine
                .diff_v1(remote_state_vector)
                .map_err(|error| invalid_input(format!("Invalid client state vector: {error}")))?;
            check_request_interruption()?;
            self.hits += 1;
            self.touch(&head.id);
            return Ok(update);
        }
        self.remove(&head.id);
        self.misses += 1;
        let engine = reconstruct_yjs_engine(connection, head)?;
        check_request_interruption()?;
        let update = engine
            .diff_v1(remote_state_vector)
            .map_err(|error| invalid_input(format!("Invalid client state vector: {error}")))?;
        check_request_interruption()?;
        self.install(head, engine);
        Ok(update)
    }

    pub(crate) fn install(&mut self, head: &DocumentHeadRow, engine: YrsDocumentEngine) {
        let full_state = engine.full_state_v1();
        self.install_with_state(head, engine, full_state);
    }

    fn install_with_state(
        &mut self,
        head: &DocumentHeadRow,
        engine: YrsDocumentEngine,
        full_state: Vec<u8>,
    ) {
        self.remove(&head.id);
        let state_bytes = full_state.len();
        if self.maximum_documents == 0
            || self.maximum_state_bytes == 0
            || state_bytes > self.maximum_state_bytes
        {
            return;
        }
        while self.entries.len() >= self.maximum_documents
            || self.total_state_bytes + state_bytes > self.maximum_state_bytes
        {
            let Some(oldest) = self.lru.pop_front() else {
                break;
            };
            if let Some(entry) = self.entries.remove(&oldest) {
                self.total_state_bytes = self.total_state_bytes.saturating_sub(entry.state_bytes);
            }
        }
        self.total_state_bytes += state_bytes;
        self.lru.push_back(head.id.clone());
        self.entries.insert(
            head.id.clone(),
            CacheEntry {
                generation: head.generation,
                head_seq: head.head_seq,
                state_vector: head.state_vector.clone(),
                state_bytes,
                full_state,
                engine,
            },
        );
    }

    pub(crate) fn invalidate(&mut self, document_id: &str) {
        self.remove(document_id);
    }

    pub(crate) fn stats(&self) -> DocumentCacheStats {
        DocumentCacheStats {
            entries: self.entries.len(),
            state_bytes: self.total_state_bytes,
            hits: self.hits,
            misses: self.misses,
        }
    }

    fn touch(&mut self, document_id: &str) {
        self.lru.retain(|candidate| candidate != document_id);
        self.lru.push_back(document_id.to_owned());
    }

    fn remove(&mut self, document_id: &str) {
        self.lru.retain(|candidate| candidate != document_id);
        if let Some(entry) = self.entries.remove(document_id) {
            self.total_state_bytes = self.total_state_bytes.saturating_sub(entry.state_bytes);
        }
    }
}

pub(crate) fn reconstruct_yjs_engine(
    connection: &Connection,
    head: &DocumentHeadRow,
) -> Result<YrsDocumentEngine, StoreError> {
    #[cfg(test)]
    THREAD_RECONSTRUCTION_COUNT.with(|count| count.set(count.get().saturating_add(1)));
    let started_at = Instant::now();
    let result = reconstruct_yjs_engine_inner(connection, head);
    RECONSTRUCTION_DURATION
        .get_or_init(DurationMetric::default)
        .record(started_at.elapsed());
    result
}

#[cfg(test)]
pub(crate) fn thread_reconstruction_count() -> u64 {
    THREAD_RECONSTRUCTION_COUNT.with(Cell::get)
}

/// Reconstructs a retained historical head for stale-update attribution.
///
/// Retention is allowed to remove history older than the latest usable
/// snapshot. In that case this returns `None` so the recovery boundary can
/// fail closed instead of guessing which Blocks the stale update addressed.
pub(crate) fn reconstruct_retained_yjs_engine_at(
    connection: &Connection,
    head: &DocumentHeadRow,
    target_head_seq: i64,
) -> Result<Option<YrsDocumentEngine>, StoreError> {
    check_request_interruption()?;
    if !head.is_live_yjs_authority() {
        return Err(corrupt(format!(
            "Document {} is not live Yjs authority",
            head.id
        )));
    }
    if target_head_seq < 0 || target_head_seq > head.head_seq {
        return Err(corrupt(format!(
            "Document {} historical head is outside its generation",
            head.id
        )));
    }
    if target_head_seq == head.head_seq {
        return reconstruct_yjs_engine(connection, head).map(Some);
    }

    let repository = DocumentReadRepository::new(connection);
    let snapshot = repository.latest_snapshot(&head.id, head.generation, target_head_seq)?;
    let snapshot_seq = snapshot
        .as_ref()
        .map_or(0, |snapshot| snapshot.snapshot_seq);
    let mut engine = match snapshot {
        Some(snapshot) => {
            if snapshot.schema_version != head.schema_version
                || sha256(&snapshot.snapshot_update) != snapshot.snapshot_hash
            {
                return Err(corrupt(format!(
                    "Document {} historical snapshot evidence is invalid",
                    head.id
                )));
            }
            YrsDocumentEngine::from_full_state_v1(&head.id, &snapshot.snapshot_update).map_err(
                |error| {
                    corrupt(format!(
                        "Document {} historical snapshot failed: {error}",
                        head.id
                    ))
                },
            )?
        }
        None => YrsDocumentEngine::new(&head.id),
    };
    let updates =
        repository.updates_between(&head.id, head.generation, snapshot_seq, target_head_seq)?;
    let mut expected_seq = snapshot_seq + 1;
    for update in updates {
        check_request_interruption()?;
        if update.seq != expected_seq {
            return Ok(None);
        }
        if sha256(&update.update_blob) != update.update_hash {
            return Err(corrupt(format!(
                "Document {} historical update evidence is invalid at sequence {expected_seq}",
                head.id
            )));
        }
        let candidate = engine
            .prepare_update_v1(&update.update_blob)
            .map_err(|error| {
                corrupt(format!(
                    "Document {} historical update failed at sequence {expected_seq}: {error}",
                    head.id
                ))
            })?;
        engine.commit_candidate(candidate).map_err(|error| {
            corrupt(format!(
                "Document {} historical update commit failed at sequence {expected_seq}: {error}",
                head.id
            ))
        })?;
        expected_seq += 1;
    }
    if expected_seq - 1 != target_head_seq {
        return Ok(None);
    }
    if engine.full_state_v1().len() > MAX_DOCUMENT_UPDATE_BYTES {
        return Err(corrupt(format!(
            "Document {} historical state exceeds the runtime bound",
            head.id
        )));
    }
    Ok(Some(engine))
}

pub(crate) fn reconstruction_duration_metrics() -> DurationMetricSnapshot {
    RECONSTRUCTION_DURATION
        .get_or_init(DurationMetric::default)
        .snapshot()
}

fn reconstruct_yjs_engine_inner(
    connection: &Connection,
    head: &DocumentHeadRow,
) -> Result<YrsDocumentEngine, StoreError> {
    check_request_interruption()?;
    if !head.is_live_yjs_authority() {
        return Err(corrupt(format!(
            "Document {} is not live Yjs authority",
            head.id
        )));
    }
    let schema = BlockDocumentSchema::from_identity(&head.schema_key, head.schema_version)
        .ok_or_else(|| corrupt(format!("Document {} schema is unsupported", head.id)))?;
    let repository = DocumentReadRepository::new(connection);
    let snapshot = repository.latest_snapshot(&head.id, head.generation, head.head_seq)?;
    let snapshot_seq = snapshot
        .as_ref()
        .map_or(0, |snapshot| snapshot.snapshot_seq);
    let mut engine = match snapshot {
        Some(snapshot) => {
            if snapshot.schema_version != head.schema_version
                || sha256(&snapshot.snapshot_update) != snapshot.snapshot_hash
            {
                return Err(corrupt(format!(
                    "Document {} snapshot evidence is invalid",
                    head.id
                )));
            }
            let engine = YrsDocumentEngine::from_full_state_v1(&head.id, &snapshot.snapshot_update)
                .map_err(|error| {
                    corrupt(format!("Document {} snapshot failed: {error}", head.id))
                })?;
            if !engine
                .state_vector_equals_v1(&snapshot.state_vector)
                .map_err(|error| {
                    corrupt(format!("Document {} snapshot vector: {error}", head.id))
                })?
            {
                return Err(corrupt(format!(
                    "Document {} snapshot vector does not match",
                    head.id
                )));
            }
            engine
        }
        None => YrsDocumentEngine::new(&head.id),
    };
    let updates =
        repository.updates_between(&head.id, head.generation, snapshot_seq, head.head_seq)?;
    let mut expected_seq = snapshot_seq + 1;
    for update in updates {
        check_request_interruption()?;
        if update.seq != expected_seq || sha256(&update.update_blob) != update.update_hash {
            return Err(corrupt(format!(
                "Document {} update tail is invalid at sequence {expected_seq}",
                head.id
            )));
        }
        let candidate = engine
            .prepare_update_v1(&update.update_blob)
            .map_err(|error| corrupt(format!("Document {} update failed: {error}", head.id)))?;
        engine.commit_candidate(candidate).map_err(|error| {
            corrupt(format!(
                "Document {} update commit failed: {error}",
                head.id
            ))
        })?;
        expected_seq += 1;
    }
    if expected_seq - 1 != head.head_seq
        || !engine
            .state_vector_equals_v1(&head.state_vector)
            .map_err(|error| corrupt(format!("Document {} head vector: {error}", head.id)))?
    {
        return Err(corrupt(format!(
            "Document {} reconstructed head does not match SQLite",
            head.id
        )));
    }
    if engine.full_state_v1().len() > MAX_DOCUMENT_UPDATE_BYTES {
        return Err(corrupt(format!(
            "Document {} state exceeds the runtime bound",
            head.id
        )));
    }
    check_request_interruption()?;
    let decoded = decode_block_document(engine.document(), schema)
        .map_err(|error| corrupt(format!("Document {} schema: {error}", head.id)))?;
    let actual = materialize_decoded_document(&decoded)
        .map_err(|error| corrupt(format!("Document {} materialization: {error}", head.id)))?;
    check_request_interruption()?;
    let persisted = repository
        .materialization(&head.id)?
        .ok_or_else(|| corrupt(format!("Document {} has no materialization", head.id)))?;
    if persisted.generation != head.generation
        || persisted.projected_seq != head.head_seq
        || persisted.schema_version != i64::from(actual.schema_version)
        || persisted.title != actual.title
        || persisted.rich_title != serde_json::to_value(&actual.rich_title).map_err(json_error)?
        || persisted.markdown != actual.markdown
        || persisted.plain_text != actual.plain_text
        || persisted.preview != actual.preview
        || persisted.block_tree != serde_json::to_value(&actual.block_tree).map_err(json_error)?
        || persisted.references != serde_json::to_value(&actual.references).map_err(json_error)?
        || persisted.asset_refs != serde_json::to_value(&actual.asset_refs).map_err(json_error)?
    {
        return Err(corrupt(format!(
            "Document {} materialization does not match its head",
            head.id
        )));
    }
    Ok(engine)
}

fn entry_matches(entry: &CacheEntry, head: &DocumentHeadRow) -> bool {
    entry.generation == head.generation
        && entry.head_seq == head.head_seq
        && entry.state_vector == head.state_vector
}

fn sha256(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn corrupt(message: String) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message, false)
}

fn invalid_input(message: String) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message, false)
}

fn json_error(error: serde_json::Error) -> StoreError {
    StoreError::new(
        StoreErrorCode::Internal,
        format!("Document materialization could not be encoded: {error}"),
        false,
    )
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use rusqlite::Connection;
    use yrs::{Text, Transact};

    use super::*;
    use crate::infrastructure::document_repository::{
        DocumentAuthority, DocumentHeadRow, DocumentReadiness, DocumentSyncEngine,
    };

    fn ready_head(engine: &YrsDocumentEngine) -> DocumentHeadRow {
        let full_state = engine.full_state_v1();
        DocumentHeadRow {
            id: engine.document_id().to_owned(),
            library_id: "library:cache".to_owned(),
            generation: 1,
            head_seq: 1,
            schema_key: "nodex.page".to_owned(),
            schema_version: 3,
            state_vector: engine.state_vector_v1(),
            state_hash: sha256(&full_state),
            readiness: DocumentReadiness::Ready,
            authority: DocumentAuthority::YdocPrimary,
            genesis_source_revision: None,
            created_at: "2026-08-07T00:00:00.000Z".to_owned(),
            updated_at: "2026-08-07T00:00:00.000Z".to_owned(),
            sync_engine: DocumentSyncEngine::Yjs,
        }
    }

    fn engine_with_title(document_id: &str, title: &str) -> YrsDocumentEngine {
        let engine = YrsDocumentEngine::new(document_id);
        let text = engine.document().get_or_insert_text("title");
        text.insert(&mut engine.document().transact_mut(), 0, title);
        engine
    }

    fn set_title(engine: &YrsDocumentEngine, title: &str) {
        let text = engine.document().get_or_insert_text("title");
        let mut transaction = engine.document().transact_mut();
        let length = text.len(&transaction);
        if length > 0 {
            text.remove_range(&mut transaction, 0, length);
        }
        text.insert(&mut transaction, 0, title);
    }

    #[test]
    fn cached_base_is_immutable_across_isolated_working_clones() {
        let connection = Connection::open_in_memory().expect("in-memory connection");
        let base = engine_with_title("document:cache", "base");
        let head = ready_head(&base);
        let expected = base.full_state_v1();
        let mut cache = DocumentRuntimeCache::with_limits(4, 1024 * 1024);
        cache.install(&head, base);

        let first = cache
            .clone_engine(&connection, &head)
            .expect("first working clone");
        let second = cache
            .clone_engine(&connection, &head)
            .expect("second working clone");
        set_title(&first, "first mutation");

        let third = cache
            .clone_engine(&connection, &head)
            .expect("clone after working mutation");
        assert_ne!(first.full_state_v1(), expected);
        assert_eq!(second.full_state_v1(), expected);
        assert_eq!(third.full_state_v1(), expected);
        assert_eq!(cache.stats().hits, 3);
    }

    #[test]
    fn concurrent_prepares_clone_the_same_base_without_cross_contamination() {
        let base = engine_with_title("document:concurrent-cache", "base");
        let head = ready_head(&base);
        let expected = base.full_state_v1();
        let cache = Arc::new(Mutex::new(DocumentRuntimeCache::with_limits(
            4,
            1024 * 1024,
        )));
        cache.lock().expect("cache lock").install(&head, base);

        let workers = ["left", "right"].map(|title| {
            let cache = Arc::clone(&cache);
            let head = head.clone();
            std::thread::spawn(move || {
                let connection = Connection::open_in_memory().expect("worker connection");
                let working = cache
                    .lock()
                    .expect("cache lock")
                    .clone_engine(&connection, &head)
                    .expect("working clone");
                set_title(&working, title);
                working.full_state_v1()
            })
        });
        let mut results = workers
            .into_iter()
            .map(|worker| worker.join().expect("worker"));
        let left = results.next().expect("left worker");
        let right = results.next().expect("right worker");

        assert_ne!(left, right);
        let connection = Connection::open_in_memory().expect("verification connection");
        let cached = cache
            .lock()
            .expect("cache lock")
            .clone_engine(&connection, &head)
            .expect("cached base clone");
        assert_eq!(cached.full_state_v1(), expected);
    }
}
