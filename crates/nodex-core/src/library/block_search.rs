use std::collections::{HashMap, HashSet};

use nodex_core_contracts::library::{LibraryPageSearchTextPart, LibrarySearchCoverage};
use nodex_search_kernel::{
    ANALYZER_VERSION, MatchQuality, QueryWord, TextKind, match_word_evidence, match_words,
};
use rusqlite::{Connection, OptionalExtension, params};

use crate::infrastructure::sqlite::StoreError;

use super::page_search::{bounded_fragment_parts, bounded_fragment_parts_around, core_text_part};
use super::search_match::rank_with_context;

const MAX_DICTIONARY_TERMS: usize = 256;

const FTS_POSTINGS: &str = "
FROM page_search_words
CROSS JOIN block_search_units unit ON unit.rowid = page_search_words.rowid";

const CURRENT_POSTINGS: &str = "
CROSS JOIN documents document ON document.id = unit.document_id
CROSS JOIN blocks source ON source.id = unit.block_id
CROSS JOIN page_search_documents state ON state.document_id = document.id
WHERE page_search_words MATCH ?1
  AND state.analyzer_version = ?7
  AND unit.library_id = ?2
  AND source.lifecycle <> 'deleted'
  AND document.readiness = 'ready'
  AND document.generation = unit.document_generation
  AND unit.projected_seq <= document.head_seq
  AND (unit.source_kind IN ('document_block', 'document_context')
       OR (?4 AND unit.source_kind = 'document_title'))
  AND (?5 IS NULL OR source.type IN (SELECT value FROM json_each(?5)))";

fn ranked_postings() -> String {
    format!(
        "{FTS_POSTINGS} {CURRENT_POSTINGS}
         AND unit.owner_block_id IN (SELECT value FROM json_each(?3))"
    )
}

fn body_candidate_sql(postings: &str) -> String {
    format!(
        "SELECT CASE WHEN ?6 THEN unit.block_id ELSE unit.owner_block_id END AS resource_id,
                unit.rowid, unit.source_kind, min(page_search_words.rank), unit.owner_block_id
         {postings}
         GROUP BY resource_id, unit.source_kind"
    )
}

#[cfg(test)]
pub(super) fn candidate_sql() -> String {
    body_candidate_sql(&ranked_postings())
}

pub(super) struct Scope<'a> {
    pub library_id: &'a str,
    pub page_ids: &'a [&'a str],
    pub include_titles: bool,
    pub block_types: Option<&'a [String]>,
}

#[derive(Clone, Copy)]
pub(super) enum Target {
    Page,
    Block,
}

#[derive(Clone)]
pub(super) struct IndexedHit {
    pub rowid: i64,
    pub quality: MatchQuality,
    pub rank: f64,
    pub field_rank: usize,
}

pub(super) struct BlockSearchHit {
    pub page_id: String,
    pub block_id: String,
    pub block_type: String,
    pub source: String,
    pub parts: Vec<LibraryPageSearchTextPart>,
}

impl IndexedHit {
    /// Read original text only after the caller has ranked and windowed results.
    pub(super) fn reveal(
        &self,
        connection: &Connection,
        word: &QueryWord,
    ) -> Result<Option<BlockSearchHit>, StoreError> {
        let unit = SearchUnit::read(connection, self.rowid)?;
        Ok(word
            .match_text(
                &unit.text,
                TextKind::LongText,
                self.quality == MatchQuality::Typo,
            )
            .map(|matched| BlockSearchHit {
                page_id: unit.page_id,
                block_id: unit.block_id,
                block_type: unit.block_type,
                source: unit.source,
                parts: bounded_fragment_parts(
                    &matched
                        .parts
                        .into_iter()
                        .map(core_text_part)
                        .collect::<Vec<_>>(),
                ),
            }))
    }
}

struct SearchUnit {
    page_id: String,
    block_id: String,
    block_type: String,
    source: String,
    text: String,
}

impl SearchUnit {
    fn read(connection: &Connection, rowid: i64) -> Result<Self, StoreError> {
        Self::lookup(connection, rowid)?.ok_or_else(|| rusqlite::Error::QueryReturnedNoRows.into())
    }

    fn lookup(connection: &Connection, rowid: i64) -> Result<Option<Self>, StoreError> {
        Ok(connection
            .prepare_cached(
                "SELECT unit.owner_block_id, unit.block_id, block.type, unit.source_kind, unit.text
                 FROM block_search_units unit JOIN blocks block ON block.id = unit.block_id
                 WHERE unit.rowid = ?1",
            )?
            .query_row([rowid], |row| {
                Ok(Self {
                    page_id: row.get(0)?,
                    block_id: row.get(1)?,
                    block_type: row.get(2)?,
                    source: row.get(3)?,
                    text: row.get(4)?,
                })
            })
            .optional()?)
    }
}

pub(super) struct CombinedBodyHit {
    pub block_id: String,
    pub block_type: String,
    pub matches: Vec<(MatchQuality, Vec<LibraryPageSearchTextPart>)>,
}

pub(super) fn reveal_combined_body(
    connection: &Connection,
    rowid: i64,
    words: &[QueryWord],
    allow_typo: impl Fn(usize) -> bool,
) -> Result<Option<CombinedBodyHit>, StoreError> {
    let unit = SearchUnit::read(connection, rowid)?;
    let Some(matches) = match_words(&unit.text, words, TextKind::LongText, allow_typo) else {
        return Ok(None);
    };
    let matches = matches
        .into_iter()
        .map(|matched| {
            (
                matched.quality,
                matched
                    .parts
                    .into_iter()
                    .map(core_text_part)
                    .collect::<Vec<_>>(),
            )
        })
        .collect::<Vec<_>>();
    // Use identical window bounds for every word so their highlights merge.
    let span = matches
        .iter()
        .filter_map(|(_, parts)| {
            let mut offset = 0;
            parts.iter().find_map(|part| {
                let start = offset;
                offset += part.text.chars().count();
                part.highlighted.then_some(start..offset)
            })
        })
        .reduce(|left, right| left.start.min(right.start)..left.end.max(right.end));
    let matches = matches
        .into_iter()
        .map(|(quality, parts)| {
            let bounded = span
                .as_ref()
                .and_then(|span| bounded_fragment_parts_around(&parts, span.clone()))
                .unwrap_or_else(|| bounded_fragment_parts(&parts));
            (quality, bounded)
        })
        .collect();
    Ok(Some(CombinedBodyHit {
        block_id: unit.block_id,
        block_type: unit.block_type,
        matches,
    }))
}

#[derive(Default)]
pub(super) struct BlockSearchResults {
    pub owners: HashMap<String, String>,
    pub resources: HashMap<String, Vec<(usize, IndexedHit)>>,
    pub ordered: HashSet<String>,
    pub combined_body: HashMap<String, i64>,
    pub truncated: bool,
    pub coverage: LibrarySearchCoverage,
}

/// A View keeps one representative indexed unit per Page alongside its match IDs.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(super) struct ViewBodyHit {
    field_rank: usize,
    rowid: i64,
}

pub(super) struct ViewBodyEvidence {
    pub block_id: String,
    pub block_type: String,
    pub context: bool,
    pub matches: Vec<(usize, MatchQuality, Vec<LibraryPageSearchTextPart>)>,
}

impl ViewBodyHit {
    pub(super) fn reveal(
        &self,
        connection: &Connection,
        words: &[QueryWord],
        strong: &HashSet<String>,
    ) -> Result<Option<ViewBodyEvidence>, StoreError> {
        let Some(unit) = SearchUnit::lookup(connection, self.rowid)? else {
            // A background rebuild can replace a unit between the groups and window reads.
            return Ok(None);
        };
        let matches = match_word_evidence(&unit.text, words, TextKind::LongText, |index| {
            !strong.contains(words[index].text())
        });
        let matches = matches
            .into_iter()
            .enumerate()
            .filter_map(|(index, matched)| {
                let matched = matched?;
                let parts = matched
                    .parts
                    .into_iter()
                    .map(core_text_part)
                    .collect::<Vec<_>>();
                Some((index, matched.quality, bounded_fragment_parts(&parts)))
            })
            .collect();
        Ok(Some(ViewBodyEvidence {
            block_id: unit.block_id,
            block_type: unit.block_type,
            context: unit.source == "document_context",
            matches,
        }))
    }
}

pub(super) struct ViewWordPages {
    pub hits: HashMap<usize, ViewBodyHit>,
    pub strong: bool,
    pub truncated: bool,
}

/// Record a unit while reading the matching postings used to decide membership.
/// Windows can then read original text by rowid without walking the postings again.
pub(super) fn view_word_pages(
    connection: &Connection,
    word: &QueryWord,
    library_id: &str,
    metadata_has_strong: bool,
    eligible: impl Fn(&str, &str, i64, i64) -> Option<usize>,
) -> Result<ViewWordPages, StoreError> {
    let mut statement = connection.prepare_cached(&format!(
        "SELECT unit.owner_block_id, unit.document_id, unit.document_generation, unit.projected_seq,
                unit.rowid, unit.source_kind = 'document_context'
         {FTS_POSTINGS}
         CROSS JOIN page_search_documents state ON state.document_id = unit.document_id
         WHERE page_search_words MATCH ?1 AND unit.library_id = ?2 AND state.analyzer_version = ?3
           AND unit.source_kind IN ('document_block', 'document_context')
           AND (unit.block_id = unit.owner_block_id OR EXISTS (
             SELECT 1 FROM blocks source WHERE source.id = unit.block_id AND source.lifecycle <> 'deleted'
           ))"
    ))?;
    let mut hits = HashMap::<usize, ViewBodyHit>::new();
    let mut collect = |expression: &str, quality| -> Result<bool, StoreError> {
        let mut rows = statement.query(params![expression, library_id, ANALYZER_VERSION])?;
        let mut found = false;
        while let Some(row) = rows.next()? {
            let owner = row
                .get_ref(0)?
                .as_str()
                .map_err(|_| rusqlite::Error::InvalidQuery)?;
            let document = row
                .get_ref(1)?
                .as_str()
                .map_err(|_| rusqlite::Error::InvalidQuery)?;
            let Some(slot) = eligible(owner, document, row.get(2)?, row.get(3)?) else {
                continue;
            };
            found = true;
            let candidate = ViewBodyHit {
                field_rank: rank_with_context(quality, 4, row.get(5)?),
                rowid: row.get(4)?,
            };
            let best = hits.entry(slot).or_insert(candidate);
            *best = (*best).min(candidate);
        }
        Ok(found)
    };
    let prefix = word.allows_prefix(TextKind::LongText);
    let mut strong = phrase(word.segments(), prefix);
    if let Some(stem) = word.stem().filter(|stem| *stem != word.segments()[0]) {
        if word.segments().len() == 1 && word.segments()[0].starts_with(stem) {
            strong = format!("{}*", quoted(stem));
        } else {
            strong.push_str(" OR ");
            strong.push_str(&format!("{}*", quoted(stem)));
        }
    }
    // Strong spellings share one posting lookup. The exact quality is recovered
    // from the representative unit's original text when a row is shown.
    let strong = collect(&strong, MatchQuality::Exact)? || metadata_has_strong;
    let mut truncated = false;
    if let [needle] = word.segments()
        && needle.chars().take(4).count() == 4
    {
        let (infix, infix_truncated) = infix_terms(connection, word, needle)?;
        truncated |= infix_truncated;
        if !strong {
            let (typos, typo_truncated) = typo_terms(connection, word, needle)?;
            truncated |= typo_truncated;
            if !typos.is_empty() {
                collect(&typos.join(" OR "), MatchQuality::Typo)?;
            }
        }
        if !infix.is_empty() {
            collect(&infix.join(" OR "), MatchQuality::Infix)?;
        }
    }
    Ok(ViewWordPages {
        hits,
        strong,
        truncated,
    })
}

pub(super) fn view_coverage(
    connection: &Connection,
    data_source_id: &str,
) -> Result<LibrarySearchCoverage, StoreError> {
    let indexing = connection.prepare_cached(
        "SELECT EXISTS (
           SELECT 1 FROM page_search_documents state
           WHERE (state.analyzer_version IS NULL OR state.analyzer_version < ?1 OR state.analyzer_version > ?1)
             AND EXISTS (
                SELECT 1 FROM page_read_model model
                CROSS JOIN data_source_page_memberships membership ON membership.id = model.membership_id
                WHERE model.document_id = state.document_id AND model.lifecycle = 'active'
                  AND membership.data_source_id = ?2 AND membership.removed_at IS NULL
             )
         )",
    )?.query_row(params![ANALYZER_VERSION, data_source_id], |row| row.get::<_, bool>(0))?;
    Ok(if indexing {
        LibrarySearchCoverage::Indexing
    } else {
        LibrarySearchCoverage::Complete
    })
}

pub(super) fn search(
    connection: &Connection,
    words: &[QueryWord],
    scope: Scope<'_>,
    target: Target,
    strong_terms: &mut HashSet<String>,
) -> Result<BlockSearchResults, StoreError> {
    if scope.page_ids.is_empty() {
        return Ok(BlockSearchResults::default());
    }
    let page_ids = serde_json::json!(scope.page_ids).to_string();
    let block_types = scope
        .block_types
        .map(|types| serde_json::json!(types).to_string());
    let postings = ranked_postings();
    let mut statement = connection.prepare_cached(&body_candidate_sql(&postings))?;
    let indexing = connection
        .prepare_cached(
            "SELECT EXISTS (
                SELECT 1 FROM page_search_documents state
                JOIN pages page ON page.document_id = state.document_id
                WHERE (state.analyzer_version IS NULL OR state.analyzer_version < ?1 OR state.analyzer_version > ?1)
                  AND page.block_id IN (SELECT value FROM json_each(?2))
            )",
        )?
        .query_row(params![ANALYZER_VERSION, page_ids], |row| row.get::<_, bool>(0))?;
    let mut result = BlockSearchResults {
        coverage: if indexing {
            LibrarySearchCoverage::Indexing
        } else {
            LibrarySearchCoverage::Complete
        },
        ..Default::default()
    };

    let mut word_expressions = Vec::new();
    for (word_index, word) in words.iter().enumerate() {
        let mut best = HashMap::<String, IndexedHit>::new();
        let mut alternatives = Vec::new();
        let mut collect = |expression: &str, quality: MatchQuality| -> Result<bool, StoreError> {
            let mut rows = statement.query(params![
                expression,
                scope.library_id,
                page_ids,
                scope.include_titles,
                block_types,
                matches!(target, Target::Block),
                ANALYZER_VERSION,
            ])?;
            let mut found = false;
            while let Some(row) = rows.next()? {
                found = true;
                let source: &str = row
                    .get_ref(2)?
                    .as_str()
                    .map_err(|_| rusqlite::Error::InvalidQuery)?;
                let field = if source == "document_title" { 2 } else { 4 };
                let candidate = IndexedHit {
                    rowid: row.get(1)?,
                    rank: row.get(3)?,
                    quality,
                    field_rank: rank_with_context(quality, field, source == "document_context"),
                };
                let key = |hit: &IndexedHit| (hit.field_rank, hit.rank, hit.rowid);
                let resource_id: String = row.get(0)?;
                if best
                    .get(&resource_id)
                    .is_none_or(|previous| key(&candidate) < key(previous))
                {
                    if matches!(target, Target::Block) && !result.owners.contains_key(&resource_id)
                    {
                        result.owners.insert(resource_id.clone(), row.get(4)?);
                    }
                    best.insert(resource_id, candidate);
                }
            }
            if found && matches!(target, Target::Page) && words.len() > 1 {
                alternatives.push(expression.to_owned());
            }
            Ok(found)
        };

        let exact = phrase(word.segments(), false);
        let prefix = word
            .allows_prefix(TextKind::LongText)
            .then(|| phrase(word.segments(), true));
        let direct = prefix.as_deref().unwrap_or(&exact);
        let mut strong = collect(&exact, MatchQuality::Exact)?;
        if let Some(prefix) = &prefix {
            strong |= collect(&format!("{prefix} NOT {exact}"), MatchQuality::Prefix)?;
        }
        if let Some(stem) = word.stem().filter(|stem| *stem != word.segments()[0]) {
            strong |= collect(
                &format!("{}* NOT {direct}", quoted(stem)),
                MatchQuality::Stem,
            )?;
        }
        if strong {
            strong_terms.insert(word.text().to_owned());
        }
        if let [needle] = word.segments()
            && needle.chars().take(4).count() == 4
        {
            if !strong_terms.contains(word.text()) {
                let (terms, truncated) = typo_terms(connection, word, needle)?;
                result.truncated |= truncated;
                if !terms.is_empty() {
                    collect(&terms.join(" OR "), MatchQuality::Typo)?;
                }
            }
            let (terms, truncated) = infix_terms(connection, word, needle)?;
            result.truncated |= truncated;
            if !terms.is_empty() {
                collect(&terms.join(" OR "), MatchQuality::Infix)?;
            }
        }
        for (resource, hit) in best {
            result
                .resources
                .entry(resource)
                .or_default()
                .push((word_index, hit));
        }
        word_expressions.push(format!("({})", alternatives.join(" OR ")));
    }
    if words.len() > 1 && !result.resources.is_empty() {
        let expression = words
            .iter()
            .map(|word| phrase(word.segments(), word.allows_prefix(TextKind::LongText)))
            .collect::<Vec<_>>()
            .join(" + ");
        let mut combined = connection.prepare_cached(&format!(
            "SELECT CASE WHEN ?6 THEN unit.block_id ELSE unit.owner_block_id END AS resource_id,
                    min(CASE WHEN unit.source_kind = 'document_block' THEN unit.rowid END)
             {postings}
             GROUP BY resource_id"
        ))?;
        let mut lookup = |expression: &str, page_ids: &str| {
            combined
                .query_map(
                    params![
                        expression,
                        scope.library_id,
                        page_ids,
                        scope.include_titles,
                        block_types,
                        matches!(target, Target::Block),
                        ANALYZER_VERSION,
                    ],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<i64>>(1)?)),
                )?
                .collect::<rusqlite::Result<Vec<_>>>()
        };
        for (id, rowid) in lookup(&expression, &page_ids)? {
            if let Some(rowid) = rowid
                && matches!(target, Target::Page)
            {
                result.combined_body.insert(id.clone(), rowid);
            }
            result.ordered.insert(id);
        }
        if matches!(target, Target::Page) {
            let remaining = result
                .resources
                .iter()
                .filter(|(id, hits)| {
                    hits.len() == words.len() && !result.combined_body.contains_key(*id)
                })
                .map(|(id, _)| id)
                .collect::<Vec<_>>();
            if !remaining.is_empty() {
                let ids = serde_json::json!(remaining).to_string();
                let expression = word_expressions.join(" AND ");
                result.combined_body.extend(
                    lookup(&expression, &ids)?
                        .into_iter()
                        .filter_map(|(id, rowid)| Some((id, rowid?))),
                );
            }
        }
    }
    Ok(result)
}

fn quoted(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

fn phrase(segments: &[String], prefix: bool) -> String {
    let mut phrase = quoted(&segments.join(" "));
    if prefix {
        phrase.push('*');
    }
    phrase
}

fn infix_terms(
    connection: &Connection,
    word: &QueryWord,
    needle: &str,
) -> Result<(Vec<String>, bool), StoreError> {
    let mut statement = connection.prepare_cached(
        "SELECT term FROM page_search_dictionary
         WHERE instr(term, ?1) > 1 ORDER BY unit_count, term LIMIT ?2",
    )?;
    let mut terms = statement
        .query_map(params![needle, (MAX_DICTIONARY_TERMS + 1) as i64], |row| {
            row.get::<_, String>(0)
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let truncated = terms.len() > MAX_DICTIONARY_TERMS;
    terms.truncate(MAX_DICTIONARY_TERMS);
    Ok((
        terms
            .into_iter()
            .filter(|term| {
                word.classify_segment(term, TextKind::LongText, false) == Some(MatchQuality::Infix)
            })
            .map(|term| quoted(&term))
            .collect(),
        truncated,
    ))
}

fn typo_terms(
    connection: &Connection,
    word: &QueryWord,
    needle: &str,
) -> Result<(Vec<String>, bool), StoreError> {
    if !needle.chars().any(char::is_alphabetic) {
        return Ok((Vec::new(), false));
    }
    let mut initials = needle.chars().take(2).collect::<Vec<_>>();
    initials.dedup();
    let mut terms = Vec::new();
    let mut statement = connection.prepare_cached(
        "SELECT term FROM page_search_dictionary WHERE term >= ?1 AND term <= ?2",
    )?;
    for initial in initials {
        let mut rows =
            statement.query(params![initial.to_string(), format!("{initial}\u{10ffff}")])?;
        while let Some(row) = rows.next()? {
            let term: String = row.get(0)?;
            if word.classify_segment(&term, TextKind::LongText, true) != Some(MatchQuality::Typo) {
                continue;
            }
            if terms.len() == MAX_DICTIONARY_TERMS {
                return Ok((terms, true));
            }
            terms.push(quoted(&term));
        }
    }
    Ok((terms, false))
}

#[cfg(test)]
mod tests {
    use std::time::Instant;

    use nodex_search_kernel::query_words;

    use super::*;
    use crate::document::search_projection::write_words;

    fn install_fixture(connection: &Connection) {
        connection.execute_batch(
            "PRAGMA foreign_keys=ON;
             CREATE TABLE documents(id TEXT PRIMARY KEY, readiness TEXT, generation INTEGER, head_seq INTEGER);
             CREATE TABLE blocks(id TEXT PRIMARY KEY, type TEXT, lifecycle TEXT);
             CREATE TABLE pages(block_id TEXT PRIMARY KEY, document_id TEXT, updated_at TEXT);
             CREATE TABLE data_source_page_memberships(id TEXT, page_block_id TEXT, data_source_id TEXT, removed_at TEXT);
             CREATE TABLE page_read_model(page_block_id TEXT PRIMARY KEY, membership_id TEXT, lifecycle TEXT);
             CREATE TABLE block_search_units(
               rowid INTEGER PRIMARY KEY, library_id TEXT, owner_block_id TEXT,
               block_id TEXT, document_id TEXT, source_kind TEXT, text TEXT,
               document_generation INTEGER, projected_seq INTEGER
             );"
        ).unwrap();
        connection
            .execute_batch(include_str!("../../schema/migrations/v212_to_v213.sql"))
            .unwrap();
        connection
            .execute_batch(&format!(
                "CREATE TRIGGER fixture_document_ai AFTER INSERT ON documents BEGIN
               INSERT INTO page_search_documents(document_id, analyzer_version) VALUES (NEW.id, {ANALYZER_VERSION});
             END;"
            ))
            .unwrap();
    }

    #[test]
    fn fts_vocabulary_preserves_folded_segments_across_scripts() {
        let connection = Connection::open_in_memory().unwrap();
        install_fixture(&connection);
        let text = "数据库 ＤＢ ＡＢＣ：１２３ が ガ か나 한글 عَرَبِيّ 👩‍👩‍👧‍👦 #️⃣ *️⃣ 2️⃣ Café";
        connection
            .execute("INSERT INTO block_search_units(rowid) VALUES (1)", [])
            .unwrap();
        write_words(&connection, 1, text).unwrap();
        // The tokenizer must keep every kernel segment intact; read its terms directly.
        connection
            .execute_batch(
                "CREATE VIRTUAL TABLE temp.page_search_terms USING fts5vocab(main, page_search_words, row)",
            )
            .unwrap();
        let mut statement = connection
            .prepare("SELECT term FROM temp.page_search_terms ORDER BY term")
            .unwrap();
        let actual = statement
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        let mut expected = nodex_search_kernel::analyze(text)
            .into_iter()
            .map(|segment| segment.folded)
            .collect::<Vec<_>>();
        expected.sort();
        expected.dedup();
        assert_eq!(actual, expected);
    }

    #[test]
    fn expansion_dictionary_forgets_edited_and_deleted_terms() {
        let connection = Connection::open_in_memory().unwrap();
        install_fixture(&connection);
        connection
            .execute_batch("INSERT INTO block_search_units(rowid) VALUES (1),(2)")
            .unwrap();
        let dictionary = || {
            connection
                .prepare("SELECT term, unit_count FROM page_search_dictionary ORDER BY term")
                .unwrap()
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
                })
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap()
        };

        write_words(&connection, 1, "Migration migration oldnote").unwrap();
        write_words(&connection, 2, "migration").unwrap();
        assert_eq!(
            dictionary(),
            [("migration".into(), 2), ("oldnote".into(), 1)]
        );
        write_words(&connection, 1, "Migration newnote").unwrap();
        assert_eq!(
            dictionary(),
            [("migration".into(), 2), ("newnote".into(), 1)]
        );
        connection
            .execute("DELETE FROM block_search_units WHERE rowid = 1", [])
            .unwrap();
        assert_eq!(dictionary(), [("migration".into(), 1)]);
        connection
            .execute("DELETE FROM block_search_units WHERE rowid = 2", [])
            .unwrap();
        assert!(dictionary().is_empty());
    }

    #[test]
    fn finds_scoped_exact_hit_after_twenty_thousand_prefix_units() {
        let connection = Connection::open_in_memory().unwrap();
        install_fixture(&connection);
        // The exact hit is written after 20,001 scoped prefix hits. The
        // outside-scope exact hit must stay out of the candidate pool.
        connection.execute_batch(
            "INSERT INTO documents VALUES ('doc','ready',1,1), ('other','ready',1,1);
             INSERT INTO blocks VALUES ('block','paragraph','active');
             WITH RECURSIVE ids(id) AS (VALUES(1) UNION ALL SELECT id+1 FROM ids WHERE id<20001)
               INSERT INTO block_search_units
               SELECT id,'library','page','block','doc','document_block','checkpointing',1,1 FROM ids;
             INSERT INTO block_search_units VALUES
               (20002,'library','page','block','doc','document_block','Checkpoint',1,1),
               (20003,'library','outside','block','other','document_block','checkpoint',1,1);
             INSERT INTO page_search_words(rowid, segments) SELECT rowid, lower(text) FROM block_search_units;"
        ).unwrap();

        let words = query_words("checkpoint");
        let result = search(
            &connection,
            &words,
            Scope {
                library_id: "library",
                page_ids: &["page"],
                include_titles: false,
                block_types: None,
            },
            Target::Page,
            &mut HashSet::new(),
        )
        .unwrap();
        assert!(!result.truncated);
        assert_eq!(result.resources.len(), 1);
        let (_, hit) = &result.resources["page"][0];
        assert_eq!(hit.rowid, 20_002);
        assert_eq!(hit.quality, MatchQuality::Exact);
        let evidence = hit.reveal(&connection, &words[0]).unwrap().unwrap();
        assert_eq!(evidence.parts[0].text, "Checkpoint");
        assert_eq!(evidence.block_id, "block");
    }

    #[test]
    fn ordered_lookup_requires_adjacency_and_accepts_prefixes_at_every_word_end() {
        let connection = Connection::open_in_memory().unwrap();
        install_fixture(&connection);
        connection
            .execute_batch(
                "INSERT INTO documents VALUES ('doc','ready',1,1);
             INSERT INTO blocks VALUES ('block','paragraph','active');
             INSERT INTO block_search_units VALUES
               (1,'library','ordered','block','doc','document_block','PageSearch Kernel',1,1),
               (2,'library','reverse','block','doc','document_block','Kernel PageSearch',1,1),
               (3,'library','gap','block','doc','document_block','PageSearch Rust Kernel',1,1);
             INSERT INTO page_search_words VALUES
               ('page search kernel'), ('kernel page search'), ('page search rust kernel');",
            )
            .unwrap();

        let result = search(
            &connection,
            &query_words("page_sear kern"),
            Scope {
                library_id: "library",
                page_ids: &["ordered", "reverse", "gap"],
                include_titles: false,
                block_types: None,
            },
            Target::Page,
            &mut HashSet::new(),
        )
        .unwrap();
        assert_eq!(result.resources.len(), 3);
        assert_eq!(result.ordered, HashSet::from(["ordered".into()]));
    }

    #[test]
    #[ignore = "builds and measures a 20,000 Page / 500,000 Block synthetic index"]
    fn benchmark_page_word_index() {
        const PAGES: usize = 20_000;
        const BLOCKS_PER_PAGE: usize = 25;
        let dir = nodex_platform::test_support::tempdir().unwrap();
        let mut connection = Connection::open(dir.path().join("search.db")).unwrap();
        connection
            .execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;")
            .unwrap();
        install_fixture(&connection);
        let texts = [
            "Release notes. We reviewed the database migration, tested the rollback procedure, and scheduled the production checkpoint for next Thursday.",
            "开发团队正在讨论数据库迁移方案，验证配置和恢复步骤。本周应该提交检查结果。",
            "The build plan includes checking service readiness and reviewing retry limits with the support team. Record open questions in this issue.",
            "Before deploying the new release, confirm the snapshot works and the previous configuration remains available for the operators.",
            "完成这一步后，请检查缓存是否需要更新，并记录观察到的异常。下一次会议一起评估结果。",
            "A short note about reliability. The incident response guide describes how to coordinate recovery and confirm the state of the system.",
        ];
        let page_ids = (0..PAGES)
            .map(|n| format!("page-{n:05}"))
            .collect::<Vec<_>>();
        let mut text_bytes = 0;
        {
            let transaction = connection.transaction().unwrap();
            let mut document = transaction
                .prepare("INSERT INTO documents VALUES (?1,'ready',1,1)")
                .unwrap();
            let mut block = transaction
                .prepare("INSERT INTO blocks VALUES (?1,'paragraph','active')")
                .unwrap();
            let mut unit = transaction.prepare("INSERT INTO block_search_units VALUES (?1,'library',?2,?3,?2,'document_block',?4,1,1)").unwrap();
            for (page, id) in page_ids.iter().enumerate() {
                document.execute([id]).unwrap();
                for ordinal in 0..BLOCKS_PER_PAGE {
                    let n = page * BLOCKS_PER_PAGE + ordinal;
                    let block_id = format!("block-{n:06}");
                    block.execute([&block_id]).unwrap();
                    // Spread a realistic dictionary of project-specific names
                    // across otherwise recurring notes.
                    let text = format!(
                        "{} {}{}",
                        texts[n % texts.len()],
                        if n == 17 {
                            "saffronartifact"
                        } else {
                            "initiative"
                        },
                        n % 81_413
                    );
                    text_bytes += text.len();
                    unit.execute(params![n as i64 + 1, id, block_id, text])
                        .unwrap();
                }
            }
            drop((document, block, unit));
            transaction.commit().unwrap();
        }
        let database_bytes = |connection: &Connection| {
            let pages: i64 = connection
                .pragma_query_value(None, "page_count", |row| row.get(0))
                .unwrap();
            let size: i64 = connection
                .pragma_query_value(None, "page_size", |row| row.get(0))
                .unwrap();
            pages * size
        };
        let before = database_bytes(&connection);
        let started = Instant::now();
        {
            let transaction = connection.transaction().unwrap();
            let mut statement = transaction
                .prepare("SELECT rowid,text FROM block_search_units ORDER BY rowid")
                .unwrap();
            let mut rows = statement.query([]).unwrap();
            while let Some(row) = rows.next().unwrap() {
                let text = row.get_ref(1).unwrap().as_str().unwrap();
                write_words(&transaction, row.get(0).unwrap(), text).unwrap();
            }
            drop(rows);
            drop(statement);
            transaction
                .execute(
                    "INSERT INTO page_search_words(page_search_words) VALUES ('optimize')",
                    [],
                )
                .unwrap();
            transaction.commit().unwrap();
        }
        eprintln!(
            "text_bytes={text_bytes} index_bytes={} reindex_ms={:.2}",
            database_bytes(&connection) - before,
            started.elapsed().as_secs_f64() * 1_000.0
        );
        let mut edits = Vec::new();
        for rowid in 300..340 {
            let started = Instant::now();
            let transaction = connection.transaction().unwrap();
            let text = "Follow up after this week's maintenance. 数据库迁移方案已验证。";
            transaction
                .execute(
                    "UPDATE block_search_units SET text=?1 WHERE rowid=?2",
                    params![text, rowid],
                )
                .unwrap();
            write_words(&transaction, rowid, text).unwrap();
            transaction.commit().unwrap();
            edits.push(started.elapsed().as_secs_f64() * 1_000.0);
        }
        edits.sort_by(f64::total_cmp);
        eprintln!("single_block_write_median_ms={:.3}", edits[20]);

        let ids = page_ids.iter().map(String::as_str).collect::<Vec<_>>();
        for (name, query) in [
            ("common", "release"),
            ("rare", "saffronartifact"),
            ("han", "迁移"),
            ("two", "release notes"),
            ("typo", "migartion"),
            ("infix", "figur"),
        ] {
            let mut timings = Vec::new();
            let mut last = BlockSearchResults::default();
            for _ in 0..7 {
                let started = Instant::now();
                last = search(
                    &connection,
                    &query_words(query),
                    Scope {
                        library_id: "library",
                        page_ids: &ids,
                        include_titles: false,
                        block_types: None,
                    },
                    Target::Page,
                    &mut HashSet::new(),
                )
                .unwrap();
                timings.push(started.elapsed().as_secs_f64() * 1_000.0);
            }
            timings.sort_by(f64::total_cmp);
            assert!(!last.resources.is_empty(), "{query}");
            eprintln!(
                "{name} median_ms={:.2} max_ms={:.2} pages={} truncated={}",
                timings[3],
                timings[6],
                last.resources.len(),
                last.truncated
            );
        }
    }
}
