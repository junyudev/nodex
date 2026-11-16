use std::collections::HashSet;
use std::time::{Duration, Instant};

use nodex_search_kernel::ANALYZER_VERSION;
use rusqlite::{Connection, OptionalExtension, params};

use crate::domain::block_materialization::{MaterializedBlockNode, dematerialize_block_tree};
use crate::infrastructure::request_execution::check_request_interruption;
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode, with_immediate_transaction};
use crate::infrastructure::writer::{StoreReaders, StoreWriter};

use super::persistence::{
    DocumentAuthorityRow, SearchUnitProjection, insert_library_search_unit,
    read_document_authority, write_block_search_context,
};

const WRITE_BUDGET: Duration = Duration::from_millis(6);
const UNIT_LIMIT: usize = 32;
const TEXT_LIMIT: usize = 48 * 1024;
const PRUNE_LIMIT: usize = 32;
const MERGE_PAGES: i64 = 8;
const REBUILD_CACHE_KIB: i64 = 128 * 1024;

#[derive(Default)]
pub(crate) struct PageSearchMaintenance {
    plan: Option<PagePlan>,
    merge_pending: bool,
    original_cache_size: Option<i64>,
}

#[derive(PartialEq)]
struct Position {
    id: String,
    building_version: Option<u32>,
    indexed_units: usize,
    prune_after_rowid: i64,
    has_page: bool,
}

type Field = (String, String, String);

struct PagePlan {
    authority: DocumentAuthorityRow,
    epoch: String,
    units: Vec<(Field, String)>,
    stale_rows: Vec<i64>,
}

struct Posting {
    index: usize,
    field: Field,
    text: String,
    hash: String,
    segments: Vec<String>,
}

struct Batch {
    position: Position,
    epoch: String,
    authority: DocumentAuthorityRow,
    postings: Vec<Posting>,
    unit_count: usize,
    stale_rows: Vec<i64>,
    prune_after_rowid: i64,
}

enum Next {
    Empty,
    Discard(String),
    Build(Box<Batch>),
}

impl PageSearchMaintenance {
    pub(crate) fn maintain(
        &mut self,
        readers: &StoreReaders,
        writer: &StoreWriter,
    ) -> Result<bool, StoreError> {
        // Keep compaction on its own writer turn and keep pace with the
        // posting batches so the segment count stays low during search.
        if self.merge_pending {
            self.merge_pending = merge_slice(writer)?;
            return Ok(true);
        }

        let next = readers.read_default(|connection| {
            let snapshot = connection.unchecked_transaction()?;
            self.prepare_next(&snapshot)
        })?;
        if self.original_cache_size.is_none() {
            let resume_merges = readers.read_default(|connection| {
                Ok(connection.query_row(
                    "SELECT EXISTS(SELECT 1 FROM page_search_words_config
                     WHERE k = 'automerge' AND v = 0)",
                    [],
                    |row| row.get::<_, bool>(0),
                )?)
            })?;
            if matches!(next, Next::Empty) && !resume_merges {
                return Ok(false);
            }
            self.original_cache_size = Some(configure_writer(writer, None)?);
        }

        match next {
            Next::Empty => {
                if merge_slice(writer)? {
                    return Ok(true);
                }
                configure_writer(writer, self.original_cache_size)?;
                self.original_cache_size = None;
                Ok(false)
            }
            Next::Discard(id) => {
                writer.call(move |connection| {
                    connection.execute(
                        "DELETE FROM page_search_documents WHERE document_id = ?1
                         AND analyzer_version IS NOT ?2 AND NOT EXISTS(
                           SELECT 1 FROM pages JOIN documents ON documents.id = pages.document_id
                           WHERE document_id = ?1 AND readiness = 'ready'
                             AND authority = 'ydoc_primary' AND sync_engine = 'yjs'
                         )",
                        params![id, ANALYZER_VERSION],
                    )?;
                    Ok(())
                })?;
                Ok(true)
            }
            Next::Build(batch) => {
                let posted = writer.call(move |connection| {
                    with_immediate_transaction(connection, |transaction| batch.publish(transaction))
                })?;
                self.merge_pending = posted;
                Ok(true)
            }
        }
    }

    fn prepare_next(&mut self, connection: &Connection) -> Result<Next, StoreError> {
        let Some(position) = next_position(connection)? else {
            self.plan = None;
            return Ok(Next::Empty);
        };
        if !position.has_page {
            self.plan = None;
            return Ok(Next::Discard(position.id));
        }
        let Some(authority) =
            read_document_authority(connection, &position.id)?.filter(|authority| {
                authority.page_library_id.is_some() && authority.head.is_live_yjs_authority()
            })
        else {
            self.plan = None;
            return Ok(Next::Discard(position.id));
        };
        let epoch = crate::document::read_store_epoch(connection)?;
        if self
            .plan
            .as_ref()
            .is_none_or(|plan| plan.authority != authority || plan.epoch != epoch)
        {
            self.plan = Some(PagePlan::read(connection, authority, epoch)?);
        }
        let plan = self.plan.as_ref().expect("plan for the selected Page");
        Ok(Next::Build(Box::new(plan.prepare_batch(position)?)))
    }
}

fn next_position(connection: &Connection) -> rusqlite::Result<Option<Position>> {
    connection.prepare_cached(
        // Jump between analyzer versions in the priority index. Each lookup
        // visits only the newest queued document in that version.
        "WITH RECURSIVE versions(version) AS (
             SELECT COALESCE(min(analyzer_version), 0) FROM page_search_documents
             UNION ALL
             SELECT COALESCE((SELECT min(analyzer_version) FROM page_search_documents
                              WHERE analyzer_version > versions.version), 0)
             FROM versions WHERE versions.version > 0
         ),
         candidates(document_id) AS (
             SELECT (SELECT document_id FROM page_search_documents
                     WHERE analyzer_version IS NULL ORDER BY page_updated_at DESC, document_id LIMIT 1)
             UNION ALL
             SELECT (SELECT document_id FROM page_search_documents WHERE analyzer_version = version
                     ORDER BY page_updated_at DESC, document_id LIMIT 1)
             FROM versions WHERE version > 0 AND version <> ?1
         )
         SELECT state.document_id, building_version, indexed_units, prune_after_rowid, page_updated_at IS NOT NULL
         FROM candidates JOIN page_search_documents state USING(document_id)
         ORDER BY page_updated_at DESC, state.document_id LIMIT 1",
    )?.query_row([ANALYZER_VERSION], position_row).optional()
}

fn position_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Position> {
    Ok(Position {
        id: row.get(0)?,
        building_version: row.get(1)?,
        indexed_units: row.get::<_, i64>(2)? as usize,
        prune_after_rowid: row.get(3)?,
        has_page: row.get(4)?,
    })
}

impl PagePlan {
    fn read(
        connection: &Connection,
        authority: DocumentAuthorityRow,
        epoch: String,
    ) -> Result<Self, StoreError> {
        let head = &authority.head;
        let (title, tree): (String, String) = connection.prepare_cached(
            "SELECT title, block_tree_json FROM document_materializations
             WHERE document_id = ?1 AND generation = ?2 AND projected_seq = ?3 AND schema_version = ?4",
        )?.query_row(params![head.id, head.generation, head.head_seq, head.schema_version], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })?;
        let blocks = serde_json::from_str::<Vec<MaterializedBlockNode>>(&tree)
            .map_err(|_| corrupt("Indexed Page Document has an invalid Block tree"))?;
        let tree = dematerialize_block_tree(&blocks)
            .map_err(|error| corrupt(format!("Indexed Page Document Block tree: {error}")))?;
        let mut units = Vec::new();
        let mut add = |block: &str, source: &str, field: &str, text: &str| {
            check_request_interruption()?;
            units.push(((block.into(), source.into(), field.into()), text.into()));
            Ok(())
        };
        add(&authority.owner_block_id, "document_title", "title", &title)?;
        for block in crate::domain::block_tree::scan_block_tree(&tree) {
            add(&block.id, "document_block", "text", &block.search_text)?;
        }
        write_block_search_context(&blocks, &mut add)?;
        let fields = units.iter().map(|(field, _)| field).collect::<HashSet<_>>();
        let stale_rows = find_stale_rows(connection, &authority, &fields)?;
        Ok(Self {
            authority,
            epoch,
            units,
            stale_rows,
        })
    }

    fn prepare_batch(&self, position: Position) -> Result<Batch, StoreError> {
        let (indexed_units, prune_after_rowid) =
            if position.building_version == Some(ANALYZER_VERSION) {
                (position.indexed_units, position.prune_after_rowid)
            } else {
                (0, 0)
            };
        let mut stale_rows = Vec::new();
        let mut cursor = -1;
        if prune_after_rowid != -1 {
            let remaining = &self.stale_rows[self
                .stale_rows
                .partition_point(|rowid| *rowid <= prune_after_rowid)..];
            stale_rows.extend(remaining.iter().take(PRUNE_LIMIT));
            if remaining.len() > PRUNE_LIMIT {
                cursor = *stale_rows.last().expect("maximum-size prune batch");
            }
        }
        let mut postings = Vec::new();
        let mut bytes = 0;
        for (index, (field, text)) in self
            .units
            .iter()
            .enumerate()
            .skip(indexed_units)
            .take(UNIT_LIMIT)
        {
            bytes += text.len();
            if bytes > TEXT_LIMIT && !postings.is_empty() {
                break;
            }
            check_request_interruption()?;
            postings.push(Posting {
                index,
                field: field.clone(),
                text: text.clone(),
                hash: super::persistence::sha256(text.as_bytes()),
                segments: index_segments(text),
            });
        }
        Ok(Batch {
            position,
            epoch: self.epoch.clone(),
            authority: self.authority.clone(),
            postings,
            unit_count: self.units.len(),
            stale_rows,
            prune_after_rowid: cursor,
        })
    }
}

fn find_stale_rows(
    connection: &Connection,
    authority: &DocumentAuthorityRow,
    fields: &HashSet<&Field>,
) -> Result<Vec<i64>, StoreError> {
    let mut statement = connection.prepare_cached(
        "SELECT rowid, block_id, source_kind, field_key, document_generation
         FROM block_search_units WHERE document_id = ?1 AND source_revision IS NULL",
    )?;
    let mut rows = statement.query([&authority.head.id])?;
    let mut stale = Vec::new();
    while let Some(row) = rows.next()? {
        check_request_interruption()?;
        let field = (row.get(1)?, row.get(2)?, row.get(3)?);
        if row.get::<_, i64>(4)? != authority.head.generation || !fields.contains(&field) {
            stale.push(row.get(0)?);
        }
    }
    stale.sort_unstable();
    Ok(stale)
}

impl Batch {
    fn publish(self, connection: &Connection) -> Result<bool, StoreError> {
        let started = Instant::now();
        let head = &self.authority.head;
        let current = connection.prepare_cached(
            "SELECT state.document_id, building_version, indexed_units, prune_after_rowid, page_updated_at IS NOT NULL
             FROM page_search_documents state
             JOIN documents document ON document.id = state.document_id
             JOIN pages page ON page.document_id = state.document_id
             WHERE state.document_id = ?1 AND state.analyzer_version IS NOT ?2
              AND document.generation = ?3 AND document.head_seq = ?4 AND document.schema_version = ?5
              AND document.readiness = 'ready' AND document.authority = 'ydoc_primary'
              AND document.sync_engine = 'yjs'
              AND page.block_id = ?6 AND ?7 = (SELECT store_epoch FROM block_store_metadata WHERE id = 1)",
        )?.query_row(
            params![head.id, ANALYZER_VERSION, head.generation, head.head_seq, head.schema_version,
                self.authority.owner_block_id, self.epoch], position_row,
        ).optional()?;
        if current.as_ref() != Some(&self.position) {
            return Ok(false);
        }

        let mut last_pruned = None;
        let mut prune_after_rowid = self.prune_after_rowid;
        for rowid in self.stale_rows {
            if let Some(cursor) = last_pruned
                && started.elapsed() >= WRITE_BUDGET
            {
                prune_after_rowid = cursor;
                break;
            }
            connection
                .prepare_cached(
                    "DELETE FROM block_search_units WHERE rowid = ?1 AND document_id = ?2",
                )?
                .execute(params![rowid, head.id])?;
            last_pruned = Some(rowid);
        }
        let mut indexed = if self.position.building_version == Some(ANALYZER_VERSION) {
            self.position.indexed_units
        } else {
            0
        };
        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let mut postings = Vec::new();
        for posting in self.postings {
            if (last_pruned.is_some() || !postings.is_empty()) && started.elapsed() >= WRITE_BUDGET
            {
                break;
            }
            let rowid = posting.persist_unit(connection, &self.authority, &now)?;
            write_dictionary(connection, rowid, &posting.segments)?;
            postings.push((rowid, posting.segments.join(" ")));
            indexed = posting.index + 1;
        }
        if indexed == self.unit_count && prune_after_rowid == -1 {
            record_version(connection, &head.id)?;
        } else {
            connection
                .prepare_cached(
                    "UPDATE page_search_documents SET building_version = ?2, indexed_units = ?3,
                    prune_after_rowid = ?4 WHERE document_id = ?1",
                )?
                .execute(params![
                    head.id,
                    ANALYZER_VERSION,
                    indexed as i64,
                    prune_after_rowid
                ])?;
        }
        if postings.is_empty() {
            return Ok(last_pruned.is_some());
        }
        // Publish last. Interleaving dictionary writes would flush FTS at SQLite
        // statement savepoints and create a segment for each indexed unit.
        connection
            .prepare_cached(
                "INSERT OR REPLACE INTO page_search_words(rowid, segments)
             SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?1)",
            )?
            .execute([serde_json::json!(postings).to_string()])?;
        Ok(true)
    }
}

impl Posting {
    fn persist_unit(
        &self,
        connection: &Connection,
        authority: &DocumentAuthorityRow,
        now: &str,
    ) -> Result<i64, StoreError> {
        let (block, source, field) = &self.field;
        let existing = connection.prepare_cached(
            "SELECT rowid FROM block_search_units WHERE block_id = ?1 AND source_kind = ?2 AND field_key = ?3
             AND document_id = ?4 AND document_generation = ?5 AND text_hash = ?6 AND source_revision IS NULL",
        )?.query_row(params![block, source, field, authority.head.id, authority.head.generation, self.hash], |row| row.get(0)).optional()?;
        if let Some(rowid) = existing {
            return Ok(rowid);
        }
        insert_library_search_unit(
            connection,
            authority,
            SearchUnitProjection {
                block_id: block,
                source_kind: source,
                field_key: field,
                text: &self.text,
                text_hash: &self.hash,
                projected_seq: authority.head.head_seq,
                now,
            },
        )
    }
}

fn configure_writer(
    writer: &StoreWriter,
    restore_cache_size: Option<i64>,
) -> Result<i64, StoreError> {
    writer.call(move |connection| {
        let original_cache_size =
            connection.pragma_query_value(None, "cache_size", |row| row.get(0))?;
        let (automatic, crisis) = if restore_cache_size.is_some() {
            (4, 16)
        } else {
            (0, 1999)
        };
        with_immediate_transaction(connection, |transaction| {
            transaction.execute(
                "INSERT INTO page_search_words(page_search_words, rank)
                 VALUES ('automerge', ?1), ('crisismerge', ?2)",
                params![automatic, crisis],
            )?;
            Ok(())
        })?;
        // FTS reads replaced segment pages back while retiring them. Reuse
        // those pages across writer turns with a fixed cache during rebuilding.
        connection.pragma_update(
            None,
            "cache_size",
            restore_cache_size.unwrap_or(-REBUILD_CACHE_KIB),
        )?;
        Ok(original_cache_size)
    })
}

fn merge_slice(writer: &StoreWriter) -> Result<bool, StoreError> {
    writer.call(|connection| {
        let before = connection.total_changes();
        connection.execute(
            "INSERT INTO page_search_words(page_search_words, rank) VALUES ('merge', ?1)",
            [MERGE_PAGES],
        )?;
        // FTS itself changes only its shadow rows. See the FTS5 merge contract.
        Ok(connection.total_changes() - before > 1)
    })
}

pub(super) fn record_version(connection: &Connection, id: &str) -> rusqlite::Result<()> {
    connection.prepare_cached(
        "INSERT INTO page_search_documents(document_id, analyzer_version, page_updated_at)
         VALUES (?1, ?2, (SELECT updated_at FROM pages WHERE document_id = ?1))
         ON CONFLICT(document_id) DO UPDATE SET analyzer_version = excluded.analyzer_version,
           page_updated_at = excluded.page_updated_at, building_version = NULL, indexed_units = 0, prune_after_rowid = 0
         WHERE analyzer_version IS NOT excluded.analyzer_version",
    )?.execute(params![id, ANALYZER_VERSION])?;
    Ok(())
}

pub(super) fn needs_build(connection: &Connection, id: &str) -> rusqlite::Result<bool> {
    connection
        .prepare_cached(
            "SELECT NOT EXISTS (SELECT 1 FROM page_search_documents
         WHERE document_id = ?1 AND analyzer_version = ?2)",
        )?
        .query_row(params![id, ANALYZER_VERSION], |row| row.get(0))
}

fn corrupt(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message, false)
}
// FTS5 clamps tokens to this many bytes. Clamp our only possible
// overlength tokens at a scalar boundary so fts5vocab stays valid UTF-8.
const FTS5_MAX_TOKEN_BYTES: usize = 32_768;

/// Keep only the index-side representation here. The search unit owns the
/// original text and its Block identity.
pub(crate) fn write_words(
    connection: &Connection,
    rowid: i64,
    text: &str,
) -> Result<(), StoreError> {
    let segments = index_segments(text);
    connection
        .prepare_cached(
            "INSERT OR REPLACE INTO page_search_words(rowid, segments) VALUES (?1, ?2)",
        )?
        .execute(params![rowid, segments.join(" ")])?;
    write_dictionary(connection, rowid, &segments)
}

fn index_segments(text: &str) -> Vec<String> {
    nodex_search_kernel::analyze(text)
        .into_iter()
        .map(|segment| {
            let mut folded = segment.folded;
            folded.truncate(folded.floor_char_boundary(FTS5_MAX_TOKEN_BYTES));
            folded
        })
        .collect()
}

fn write_dictionary(
    connection: &Connection,
    rowid: i64,
    segments: &[String],
) -> Result<(), StoreError> {
    connection
        .prepare_cached("DELETE FROM page_search_dictionary_units WHERE unit_rowid = ?1")?
        .execute([rowid])?;
    // The FTS vocabulary walks postings even when only the terms are read.
    // Mirror only terms that could serve typo or infix dictionary expansion.
    let mut terms = segments
        .iter()
        .filter(|term| term.chars().take(4).count() == 4)
        .collect::<Vec<_>>();
    terms.sort_unstable();
    terms.dedup();
    if terms.is_empty() {
        return Ok(());
    }
    let terms = serde_json::json!(terms).to_string();
    connection
        .prepare_cached(
            "INSERT INTO page_search_dictionary(term, unit_count)
         SELECT value, 1 FROM json_each(?1) WHERE true
         ON CONFLICT(term) DO UPDATE SET unit_count = unit_count + 1",
        )?
        .execute([&terms])?;
    connection
        .prepare_cached(
            "INSERT INTO page_search_dictionary_units(unit_rowid, terms) VALUES (?1, ?2)",
        )?
        .execute(params![rowid, terms])?;
    Ok(())
}
