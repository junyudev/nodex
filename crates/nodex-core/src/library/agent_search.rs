use std::cmp::Ordering;
use std::collections::HashSet;

use nodex_core_contracts::BoundModuleContext;
use nodex_core_contracts::agent::{
    AgentAuthorizationTarget, AgentExecutionAuthorization, AgentProjectResourceAction,
};
use nodex_core_contracts::library::{
    LibraryAgentSearchMatchQuality, LibraryAgentSearchResult, LibraryAgentSearchScope,
    LibraryAgentSearchTarget, LibraryReadValue, LibrarySearchSourceKind,
};
use rusqlite::{Connection, params_from_iter, types::Value as SqlValue};
use sha2::{Digest, Sha256};

use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

use super::{agent_authorization, cursor, search_match::search_tokens};

const MAX_QUERY_BYTES: usize = 512;
const MAX_TERMS: usize = 32;
const MAX_FILTERS: usize = 64;
const MAX_METADATA_PAGES: usize = 5_000;
const MAX_FTS_HITS_PER_TERM: usize = 200;
const SQLITE_ID_BATCH: usize = 400;
const DEFAULT_LIMIT: usize = 50;
const MAX_LIMIT: usize = 100;

#[derive(Clone)]
struct PageCandidate {
    id: String,
}

#[derive(Clone)]
struct FtsHit {
    owner_page_id: String,
    block_id: String,
    block_type: String,
    source: LibrarySearchSourceKind,
    excerpt: String,
    rank: f64,
}

#[allow(clippy::too_many_arguments)]
pub(super) fn read(
    connection: &Connection,
    context: &BoundModuleContext,
    library_id: &str,
    authorization: &AgentExecutionAuthorization,
    query: &str,
    target: LibraryAgentSearchTarget,
    scope: LibraryAgentSearchScope,
    block_types: Option<Vec<String>>,
    include_archived: bool,
    requested_cursor: Option<&str>,
    limit: Option<u32>,
    page_search_index: Option<&super::page_search::PageSearchIndex>,
) -> Result<LibraryReadValue, StoreError> {
    let query = validate_query(query)?;
    let terms = search_terms(query)?;
    let block_types = normalize_block_types(target, block_types)?;
    authorize_explicit_scope(connection, context, library_id, authorization, &scope)?;
    let subject = search_subject(
        query,
        target,
        &scope,
        &block_types,
        include_archived,
        authorization
            .provenance
            .authority
            .actor_project_id
            .as_deref(),
    )?;
    let after = search_cursor_identity(connection, requested_cursor, library_id, &subject)?;
    let limit = search_limit(limit)?;
    if terms.is_empty() || block_types.as_ref().is_some_and(Vec::is_empty) {
        agent_authorization::authorized_page_ids(
            connection,
            context,
            library_id,
            authorization,
            &[],
        )?;
        return empty();
    }

    let mut items = if target == LibraryAgentSearchTarget::Pages {
        let page_search_index =
            page_search_index.ok_or_else(|| corrupt("Agent Page search index is unavailable"))?;
        super::page_search::search_agent_pages(
            connection,
            page_search_index,
            library_id,
            super::page_search::AgentSearchRequest {
                context,
                authorization,
                query,
                scope: &scope,
                include_archived,
            },
        )?
    } else {
        let candidates = read_page_candidates(connection, library_id, &scope, include_archived)?;
        let candidate_ids = candidates
            .iter()
            .map(|candidate| candidate.id.clone())
            .collect::<Vec<_>>();
        let authorized = agent_authorization::authorized_page_ids(
            connection,
            context,
            library_id,
            authorization,
            &candidate_ids,
        )?;
        let candidates = candidates
            .into_iter()
            .filter(|candidate| authorized.contains(&candidate.id))
            .collect::<Vec<_>>();
        let authorized_ids = candidates
            .iter()
            .map(|candidate| candidate.id.clone())
            .collect::<Vec<_>>();
        search_blocks(
            connection,
            &terms,
            &authorized_ids,
            block_types.as_deref(),
            include_archived,
        )?
    };
    let start = after
        .as_deref()
        .map(|after| {
            items
                .iter()
                .position(|item| search_result_id(item) == after)
                .map(|index| index + 1)
                .ok_or_else(|| conflict("Agent search cursor coordinate is no longer available"))
        })
        .transpose()?
        .unwrap_or(0);
    let end = start.saturating_add(limit).min(items.len());
    let has_more = end < items.len();
    let page = items.drain(start..end).collect::<Vec<_>>();
    let next_cursor = if has_more {
        let stable_id = page
            .last()
            .map(search_result_id)
            .ok_or_else(|| corrupt("Agent search continuation has no result"))?;
        Some(cursor::mint(
            connection,
            library_id,
            &subject,
            cursor::KeysetCoordinate {
                values: Vec::new(),
                stable_id: stable_id.to_owned(),
            },
        )?)
    } else {
        None
    };
    Ok(LibraryReadValue::AgentSearch {
        items: page,
        next_cursor,
        has_more,
    })
}

fn empty() -> Result<LibraryReadValue, StoreError> {
    Ok(LibraryReadValue::AgentSearch {
        items: Vec::new(),
        next_cursor: None,
        has_more: false,
    })
}

fn authorize_explicit_scope(
    connection: &Connection,
    context: &BoundModuleContext,
    library_id: &str,
    authorization: &AgentExecutionAuthorization,
    scope: &LibraryAgentSearchScope,
) -> Result<(), StoreError> {
    let target = match scope {
        LibraryAgentSearchScope::Library => return Ok(()),
        LibraryAgentSearchScope::Database { database_id } => AgentAuthorizationTarget::Database {
            database_id: database_id.clone(),
        },
        LibraryAgentSearchScope::DataSource { data_source_id } => {
            AgentAuthorizationTarget::DataSource {
                data_source_id: data_source_id.clone(),
            }
        }
        LibraryAgentSearchScope::Page { page_id } => AgentAuthorizationTarget::Page {
            page_id: page_id.clone(),
        },
    };
    agent_authorization::authorize_execution(
        connection,
        context,
        library_id,
        authorization,
        &target,
        AgentProjectResourceAction::Read,
    )?;
    Ok(())
}

fn read_page_candidates(
    connection: &Connection,
    library_id: &str,
    scope: &LibraryAgentSearchScope,
    include_archived: bool,
) -> Result<Vec<PageCandidate>, StoreError> {
    let lifecycle = if include_archived {
        "page_block.lifecycle <> 'deleted'"
    } else {
        "page_block.lifecycle = 'active'"
    };
    let mut conditions = vec![
        "page.library_id = ?".to_owned(),
        lifecycle.to_owned(),
        "document.readiness = 'ready'".to_owned(),
        "materialization.generation = document.generation".to_owned(),
        "materialization.projected_seq = document.head_seq".to_owned(),
        "materialization.schema_version = document.schema_version".to_owned(),
    ];
    let mut parameters = vec![
        SqlValue::Text(library_id.to_owned()),
        SqlValue::Text(library_id.to_owned()),
        SqlValue::Text(library_id.to_owned()),
    ];
    match scope {
        LibraryAgentSearchScope::Library => {}
        LibraryAgentSearchScope::Page { page_id } => {
            conditions.push("page.block_id = ?".to_owned());
            parameters.push(SqlValue::Text(page_id.clone()));
        }
        LibraryAgentSearchScope::DataSource { data_source_id } => {
            conditions.push("terminal.parent_kind = 'data_source'".to_owned());
            conditions.push("terminal.parent_id = ?".to_owned());
            parameters.push(SqlValue::Text(data_source_id.clone()));
        }
        LibraryAgentSearchScope::Database { database_id } => {
            conditions.push("terminal.parent_kind = 'data_source'".to_owned());
            conditions.push("source.home_database_block_id = ?".to_owned());
            parameters.push(SqlValue::Text(database_id.clone()));
        }
    }
    parameters.push(SqlValue::Integer((MAX_METADATA_PAGES + 1) as i64));
    let sql = format!(
        "WITH RECURSIVE hierarchy(root_page_id, page_id, parent_kind, parent_id, path) AS ( \
           SELECT block_id, block_id, parent_kind, parent_id, '|' || block_id || '|' \
           FROM pages WHERE library_id = ? \
           UNION ALL \
           SELECT hierarchy.root_page_id, parent.block_id, parent.parent_kind, parent.parent_id, \
             hierarchy.path || parent.block_id || '|' \
           FROM hierarchy JOIN pages parent \
             ON hierarchy.parent_kind = 'page' AND parent.block_id = hierarchy.parent_id \
           WHERE parent.library_id = ? \
             AND instr(hierarchy.path, '|' || parent.block_id || '|') = 0 \
         ) \
         SELECT page.block_id \
         FROM pages page \
         JOIN blocks page_block ON page_block.id = page.block_id \
           AND page_block.library_id = page.library_id \
         JOIN documents document ON document.id = page.document_id \
           AND document.library_id = page.library_id \
         JOIN document_materializations materialization \
           ON materialization.document_id = document.id \
         JOIN hierarchy terminal ON terminal.root_page_id = page.block_id \
           AND terminal.parent_kind <> 'page' \
         LEFT JOIN data_sources source ON terminal.parent_kind = 'data_source' \
           AND source.id = terminal.parent_id AND source.library_id = page.library_id \
         WHERE {} ORDER BY page.block_id LIMIT ?",
        conditions.join(" AND ")
    );
    let candidates = connection
        .prepare(&sql)?
        .query_map(params_from_iter(parameters.iter()), |row| {
            Ok(PageCandidate { id: row.get(0)? })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if candidates.len() > MAX_METADATA_PAGES {
        return Err(StoreError::new(
            StoreErrorCode::ResourceExhausted,
            "Agent Page-search scope exceeds its bounded metadata index",
            false,
        ));
    }
    Ok(candidates)
}

fn search_blocks(
    connection: &Connection,
    terms: &[String],
    page_ids: &[String],
    block_types: Option<&[String]>,
    include_archived: bool,
) -> Result<Vec<LibraryAgentSearchResult>, StoreError> {
    let query = terms.join(" ");
    let hits = search_fts(connection, &query, page_ids, block_types, include_archived)?;
    let mut seen = HashSet::new();
    Ok(hits
        .into_iter()
        .filter(|hit| seen.insert(hit.block_id.clone()))
        .take(MAX_FTS_HITS_PER_TERM)
        .map(|hit| LibraryAgentSearchResult::Block {
            id: hit.block_id,
            block_type: hit.block_type,
            owner_page_id: hit.owner_page_id,
            source: hit.source,
            quality: if terms.iter().all(|term| {
                exact_or_prefix(&hit.excerpt, term) == LibraryAgentSearchMatchQuality::Exact
            }) {
                LibraryAgentSearchMatchQuality::Exact
            } else {
                LibraryAgentSearchMatchQuality::Prefix
            },
            excerpt: hit.excerpt,
        })
        .collect())
}

fn search_fts(
    connection: &Connection,
    query: &str,
    page_ids: &[String],
    block_types: Option<&[String]>,
    include_archived: bool,
) -> Result<Vec<FtsHit>, StoreError> {
    if page_ids.is_empty() {
        return Ok(Vec::new());
    }
    let Some(match_query) = build_fts_match_query(query)? else {
        return Ok(Vec::new());
    };
    let mut all = Vec::new();
    for page_ids in page_ids.chunks(SQLITE_ID_BATCH) {
        let page_placeholders = placeholders(page_ids.len());
        let mut conditions = vec![
            "block_search_units_fts MATCH ?".to_owned(),
            "unit.owner_block_id IN (".to_owned() + &page_placeholders + ")",
            "unit.document_id IS NOT NULL".to_owned(),
            "unit.source_kind IN ('document_title', 'document_block')".to_owned(),
            "document.readiness = 'ready'".to_owned(),
            "document.generation = unit.document_generation".to_owned(),
            "document.head_seq = unit.projected_seq".to_owned(),
            "source.lifecycle <> 'deleted'".to_owned(),
            "owner.lifecycle <> 'deleted'".to_owned(),
            "owner.type = 'page'".to_owned(),
        ];
        let mut parameters = vec![SqlValue::Text(match_query.clone())];
        parameters.extend(page_ids.iter().cloned().map(SqlValue::Text));
        if !include_archived {
            conditions.push("owner.lifecycle = 'active'".to_owned());
        }
        if let Some(block_types) = block_types {
            conditions.push(format!(
                "source.type IN ({})",
                placeholders(block_types.len())
            ));
            parameters.extend(block_types.iter().cloned().map(SqlValue::Text));
        }
        parameters.push(SqlValue::Integer(MAX_FTS_HITS_PER_TERM as i64));
        // Search candidates originate in FTS. CROSS JOIN preserves that loop
        // order on statistics-free Stores and makes the rowid join O(matches).
        let sql = format!(
            "SELECT unit.owner_block_id, unit.block_id, source.type, unit.source_kind, \
               snippet(block_search_units_fts, 0, char(2), char(3), '…', 32), \
               bm25(block_search_units_fts) AS rank \
             FROM block_search_units_fts \
             CROSS JOIN block_search_units unit ON unit.rowid = block_search_units_fts.rowid \
             JOIN documents document ON document.id = unit.document_id \
               AND document.library_id = unit.library_id \
             JOIN blocks source ON source.id = unit.block_id \
               AND source.library_id = unit.library_id \
             JOIN blocks owner ON owner.id = unit.owner_block_id \
               AND owner.library_id = unit.library_id \
             JOIN pages owner_page ON owner_page.block_id = owner.id \
             WHERE {} ORDER BY rank, unit.owner_block_id, unit.block_id LIMIT ?",
            conditions.join(" AND ")
        );
        let rows = connection
            .prepare(&sql)?
            .query_map(params_from_iter(parameters.iter()), |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, f64>(5)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for (owner_page_id, block_id, block_type, source, excerpt, rank) in rows {
            let source = match source.as_str() {
                "document_title" => LibrarySearchSourceKind::DocumentTitle,
                "document_block" => LibrarySearchSourceKind::DocumentBlock,
                _ => return Err(corrupt("Agent search returned an invalid source")),
            };
            if !rank.is_finite() {
                return Err(corrupt("Agent search returned an invalid rank"));
            }
            all.push(FtsHit {
                owner_page_id,
                block_id,
                block_type,
                source,
                excerpt: normalize_excerpt(&excerpt),
                rank,
            });
        }
    }
    all.sort_by(|left, right| {
        left.rank
            .partial_cmp(&right.rank)
            .unwrap_or(Ordering::Equal)
            .then_with(|| left.owner_page_id.cmp(&right.owner_page_id))
            .then_with(|| left.block_id.cmp(&right.block_id))
    });
    Ok(all)
}

fn validate_query(query: &str) -> Result<&str, StoreError> {
    let query = query.trim();
    if query.is_empty() {
        return Err(invalid("Agent search query cannot be empty"));
    }
    if query.len() > MAX_QUERY_BYTES {
        return Err(invalid("Agent search query exceeds its UTF-8 byte bound"));
    }
    Ok(query)
}

fn search_terms(query: &str) -> Result<Vec<String>, StoreError> {
    let mut terms = Vec::new();
    for term in search_tokens(query) {
        if terms.contains(&term) {
            continue;
        }
        terms.push(term);
        if terms.len() > MAX_TERMS {
            return Err(invalid("Agent search query has too many terms"));
        }
    }
    Ok(terms)
}

fn build_fts_match_query(query: &str) -> Result<Option<String>, StoreError> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    for character in query.to_lowercase().chars().chain(std::iter::once(' ')) {
        if character.is_alphabetic()
            || character.is_numeric()
            || matches!(character, '_' | '-' | '/' | '@' | '.' | ':' | '#')
        {
            current.push(character);
            continue;
        }
        if current.is_empty() {
            continue;
        }
        if !tokens.contains(&current) {
            tokens.push(std::mem::take(&mut current));
            if tokens.len() > MAX_TERMS {
                return Err(invalid("Agent search query has too many FTS terms"));
            }
        } else {
            current.clear();
        }
    }
    if tokens.is_empty() {
        return Ok(None);
    }
    Ok(Some(
        tokens
            .into_iter()
            .map(|token| format!("\"{token}\"*"))
            .collect::<Vec<_>>()
            .join(" "),
    ))
}

fn exact_or_prefix(excerpt: &str, term: &str) -> LibraryAgentSearchMatchQuality {
    if search_tokens(excerpt).iter().any(|token| token == term) {
        LibraryAgentSearchMatchQuality::Exact
    } else {
        LibraryAgentSearchMatchQuality::Prefix
    }
}

fn normalize_block_types(
    target: LibraryAgentSearchTarget,
    block_types: Option<Vec<String>>,
) -> Result<Option<Vec<String>>, StoreError> {
    if target == LibraryAgentSearchTarget::Pages && block_types.is_some() {
        return Err(invalid(
            "Agent search Block types require the Blocks target",
        ));
    }
    let Some(block_types) = block_types else {
        return Ok(None);
    };
    if block_types.len() > MAX_FILTERS {
        return Err(invalid("Agent search Block type filter exceeds its bound"));
    }
    let mut unique = HashSet::new();
    for block_type in block_types {
        if block_type.is_empty() || block_type.trim() != block_type || block_type.len() > 256 {
            return Err(invalid("Agent search Block type is invalid"));
        }
        unique.insert(block_type);
    }
    let mut block_types = unique.into_iter().collect::<Vec<_>>();
    block_types.sort();
    Ok(Some(block_types))
}

fn search_subject(
    query: &str,
    target: LibraryAgentSearchTarget,
    scope: &LibraryAgentSearchScope,
    block_types: &Option<Vec<String>>,
    include_archived: bool,
    actor_project_id: Option<&str>,
) -> Result<Vec<String>, StoreError> {
    let canonical = serde_json::to_vec(&(
        query,
        target,
        scope,
        block_types,
        include_archived,
        actor_project_id,
    ))
    .map_err(|_| invalid("Agent search query cannot be fingerprinted"))?;
    let fingerprint = Sha256::digest(canonical)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok(vec!["agent_search".to_owned(), fingerprint])
}

fn search_cursor_identity(
    connection: &Connection,
    requested_cursor: Option<&str>,
    library_id: &str,
    subject: &[String],
) -> Result<Option<String>, StoreError> {
    let Some(requested_cursor) = requested_cursor else {
        return Ok(None);
    };
    let decoded = cursor::decode(connection, requested_cursor, library_id, subject)?;
    if !decoded.values.is_empty() {
        return Err(invalid("Agent search cursor coordinate is invalid"));
    }
    Ok(Some(decoded.stable_id))
}

fn search_result_id(result: &LibraryAgentSearchResult) -> &str {
    match result {
        LibraryAgentSearchResult::Page { id, .. } | LibraryAgentSearchResult::Block { id, .. } => {
            id
        }
    }
}

fn search_limit(limit: Option<u32>) -> Result<usize, StoreError> {
    let limit = usize::try_from(limit.unwrap_or(DEFAULT_LIMIT as u32))
        .map_err(|_| invalid("Agent search limit is invalid"))?;
    if (1..=MAX_LIMIT).contains(&limit) {
        Ok(limit)
    } else {
        Err(invalid("Agent search limit is out of range"))
    }
}

fn placeholders(count: usize) -> String {
    std::iter::repeat_n("?", count)
        .collect::<Vec<_>>()
        .join(", ")
}

fn normalize_excerpt(value: &str) -> String {
    value
        .replace(['\u{2}', '\u{3}'], "")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn invalid(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message, false)
}

fn conflict(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::RevisionConflict, message, false)
}

fn corrupt(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message, false)
}
