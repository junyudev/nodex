use std::collections::HashSet;

use nodex_core_contracts::BoundModuleContext;
use nodex_core_contracts::agent::AgentExecutionAuthorization;
use nodex_core_contracts::library::{
    LibraryAgentSearchResult, LibraryAgentSearchScope, LibraryAgentSearchTarget, LibraryReadValue,
    LibrarySearchCoverage, LibrarySearchSourceKind,
};
use nodex_search_kernel::{QueryWord, page_query_words};
use rusqlite::Connection;
use sha2::{Digest, Sha256};

use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

use super::block_search::{self, IndexedHit};
use super::page_search::{
    self, PageSearchIndex, SearchResults, agent_quality, contract_quality, join_parts,
    merge_highlights,
};
use super::{agent_execution, cursor};

const MAX_QUERY_BYTES: usize = 512;
const MAX_FILTERS: usize = 64;
const DEFAULT_LIMIT: usize = 50;
const MAX_LIMIT: usize = 100;

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
    page_search_index: &PageSearchIndex,
) -> Result<LibraryReadValue, StoreError> {
    let query = validate_query(query)?;
    let words = page_query_words(query).map_err(invalid)?;
    let block_types = normalize_block_types(target, block_types)?;
    agent_execution::validate_execution(connection, context, library_id, authorization)?;
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
    if words.is_empty() || block_types.as_ref().is_some_and(Vec::is_empty) {
        return empty();
    }

    let (
        SearchResults {
            items,
            truncated,
            coverage,
        },
        has_more,
    ) = if target == LibraryAgentSearchTarget::Pages {
        page_search::search_agent_pages(
            connection,
            page_search_index,
            library_id,
            page_search::AgentSearchRequest {
                query,
                scope: &scope,
                include_archived,
            },
            after.as_deref(),
            limit,
        )?
    } else {
        let page_ids =
            page_search::agent_scope_page_ids(page_search_index, &scope, include_archived);
        search_blocks(
            connection,
            &words,
            block_search::Scope {
                library_id,
                page_ids: &page_ids,
                include_titles: true,
                block_types: block_types.as_deref(),
            },
            after.as_deref(),
            limit,
        )?
    };
    let next_cursor = if has_more {
        let stable_id = items
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
        items,
        truncated,
        coverage,
        next_cursor,
        has_more,
    })
}

fn empty() -> Result<LibraryReadValue, StoreError> {
    Ok(LibraryReadValue::AgentSearch {
        items: Vec::new(),
        truncated: false,
        coverage: LibrarySearchCoverage::Complete,
        next_cursor: None,
        has_more: false,
    })
}

pub(super) fn search_window(
    ids: impl ExactSizeIterator<Item = impl AsRef<str>>,
    after: Option<&str>,
    limit: usize,
) -> Result<(std::ops::Range<usize>, bool), StoreError> {
    let count = ids.len();
    let start = match after {
        Some(after) => ids
            .enumerate()
            .find_map(|(index, id)| (id.as_ref() == after).then_some(index + 1))
            .ok_or_else(|| conflict("Agent search cursor coordinate is no longer available"))?,
        None => 0,
    };
    let end = start.saturating_add(limit).min(count);
    Ok((start..end, end < count))
}

pub(super) fn search_blocks(
    connection: &Connection,
    words: &[QueryWord],
    scope: block_search::Scope<'_>,
    after: Option<&str>,
    limit: usize,
) -> Result<(SearchResults<LibraryAgentSearchResult>, bool), StoreError> {
    let raw = block_search::search(
        connection,
        words,
        scope,
        block_search::Target::Block,
        &mut HashSet::new(),
    )?;
    let mut complete = raw
        .resources
        .into_iter()
        .filter(|(_, terms)| terms.len() == words.len())
        .collect::<Vec<_>>();
    complete.sort_by(|(a, left), (b, right)| {
        let rank = |terms: &[(usize, IndexedHit)]| {
            (
                terms
                    .iter()
                    .map(|(_, hit)| hit.field_rank)
                    .max()
                    .unwrap_or(usize::MAX),
                terms
                    .iter()
                    .map(|(_, hit)| hit.rank)
                    .max_by(f64::total_cmp)
                    .unwrap_or(0.0),
            )
        };
        let left = rank(left);
        let right = rank(right);
        left.0
            .cmp(&right.0)
            .then_with(|| raw.ordered.contains(b).cmp(&raw.ordered.contains(a)))
            .then(left.1.total_cmp(&right.1))
            .then(a.cmp(b))
    });
    let (window, has_more) = search_window(complete.iter().map(|(id, _)| id), after, limit)?;
    let mut items = Vec::new();
    for (id, terms) in complete.drain(window) {
        let mut revealed = Vec::new();
        for (index, hit) in &terms {
            if let Some(evidence) = hit.reveal(connection, &words[*index])? {
                revealed.push(evidence);
            }
        }
        let Some(first) = revealed.first() else {
            continue;
        };
        let mut windows: Vec<Vec<_>> = Vec::new();
        for hit in &revealed {
            let parts = &hit.parts;
            let text = join_parts(parts);
            if let Some(existing) = windows
                .iter_mut()
                .find(|existing| join_parts(existing) == text)
            {
                *existing = merge_highlights(existing, parts);
            } else {
                windows.push(parts.clone());
            }
        }
        let quality = terms
            .iter()
            .map(|(_, hit)| hit.quality)
            .max()
            .expect("complete Block");
        items.push(LibraryAgentSearchResult::Block {
            id,
            block_type: first.block_type.clone(),
            owner_page_id: first.page_id.clone(),
            source: if first.source == "document_title" {
                LibrarySearchSourceKind::DocumentTitle
            } else {
                LibrarySearchSourceKind::DocumentBlock
            },
            quality: agent_quality(contract_quality(quality)),
            excerpt: windows
                .iter()
                .take(3)
                .map(|parts| join_parts(parts))
                .collect::<Vec<_>>()
                .join("  ·  "),
        });
    }
    Ok((
        SearchResults {
            items,
            truncated: raw.truncated,
            coverage: raw.coverage,
        },
        has_more,
    ))
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

fn invalid(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message, false)
}

fn conflict(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::RevisionConflict, message, false)
}

fn corrupt(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message, false)
}
