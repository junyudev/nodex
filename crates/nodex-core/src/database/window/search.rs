use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use nodex_core_contracts::library::LibrarySearchCoverage;

use crate::library::page_search::{MAX_VIEW_MATCHES, PageSearchIndexRegistry, ViewPageMatches};

use super::*;

/// Share the candidate set across a Board's group and row reads and List cursors.
#[derive(Clone, Default)]
pub(crate) struct ViewSearchRegistry {
    last: Arc<Mutex<Option<CachedViewSearch>>>,
    page_search: PageSearchIndexRegistry,
}

struct CachedViewSearch {
    request_key: String,
    prepared: Arc<PreparedViewSearch>,
    expires_at: Option<Instant>,
}

impl ViewSearchRegistry {
    pub(crate) fn new(page_search: PageSearchIndexRegistry) -> Self {
        Self {
            page_search,
            ..Default::default()
        }
    }
}

pub(super) struct PreparedViewSearch {
    pub matches: ViewPageMatches,
    list: Mutex<Option<(String, Arc<ListOccurrences>)>>,
    cache_list: bool,
}

impl PreparedViewSearch {
    /// One bounded occurrence projection serves every continuation for this
    /// query. The stable occurrence identity seeks into its position index.
    pub fn list_projection(
        &self,
        key: &str,
        build: impl FnOnce() -> Result<ListOccurrences, StoreError>,
    ) -> Result<Arc<ListOccurrences>, StoreError> {
        if !self.cache_list {
            return Ok(Arc::new(build()?));
        }
        let mut list = self
            .list
            .lock()
            .map_err(|_| corrupt("View search List cache is unavailable"))?;
        if let Some((cached_key, graph)) = list.as_ref()
            && cached_key == key
        {
            return Ok(graph.clone());
        }
        let graph = Arc::new(build()?);
        *list = Some((key.to_owned(), graph.clone()));
        Ok(graph)
    }
}

pub(in crate::database) struct ViewSearchRequest<'a> {
    pub query: &'a str,
    pub registry: &'a ViewSearchRegistry,
}

pub(super) fn prepare(
    connection: &Connection,
    library_id: &str,
    store_epoch: &str,
    commit_head: i64,
    project_id: Option<&str>,
    view: &mut ResolvedView,
    request: Option<ViewSearchRequest<'_>>,
) -> Result<(), StoreError> {
    let Some(ViewSearchRequest { query, registry }) = request else {
        return Ok(());
    };
    let query = query.trim();
    if query.is_empty() {
        return Ok(());
    }
    let filter = super::super::view_contract::effective_filter(&view.config.rules);
    super::super::relation::validate_view_filter_read_access(
        connection,
        library_id,
        project_id,
        &view.data_source_id,
        &filter,
    )?;

    prepare_authorized(
        connection,
        library_id,
        store_epoch,
        commit_head,
        view,
        ViewSearchRequest { query, registry },
    )
}

pub(super) fn prepare_authorized(
    connection: &Connection,
    library_id: &str,
    store_epoch: &str,
    commit_head: i64,
    view: &mut ResolvedView,
    ViewSearchRequest { query, registry }: ViewSearchRequest<'_>,
) -> Result<(), StoreError> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(());
    }
    let filter = super::super::view_contract::effective_filter(&view.config.rules);
    let key = cursor::query_fingerprint(&(
        store_epoch,
        commit_head,
        &view.data_source_id,
        &filter,
        &view.completion_cutoff,
        query,
    ))?;
    let mut last = registry
        .last
        .lock()
        .map_err(|_| corrupt("View search cache is unavailable"))?;
    if let Some(cached) = last.as_ref().filter(|cached| {
        cached.request_key == key && cached.expires_at.is_none_or(|end| Instant::now() < end)
    }) {
        view.search = Some(cached.prepared.clone());
        return Ok(());
    }

    let mut matches = registry.page_search.search_view(
        connection,
        library_id,
        store_epoch,
        commit_head,
        &view.data_source_id,
        query,
    )?;
    let relative_filter = has_relative_date(&filter);
    let over_bound = matches.exceeds_bound();
    if over_bound {
        let eligible = eligible_overflow(connection, view, &matches)?;
        matches.bound(eligible)?;
    }
    // Derived-index rebuilds can advance without a LocalCommit. Pin the
    // partial result briefly so a Board can read its groups and first rows
    // from one observation. Cursors bind the exact set across rebuild steps.
    let changes_without_commit = matches.status.coverage == LibrarySearchCoverage::Indexing
        || (over_bound && relative_filter);
    let result_key = if changes_without_commit {
        cursor::query_fingerprint(&(&key, &matches.ids_json))?
    } else {
        key.clone()
    };
    matches.status.result_key = result_key;
    let prepared = Arc::new(PreparedViewSearch {
        matches,
        list: Mutex::default(),
        cache_list: !relative_filter,
    });
    *last = Some(CachedViewSearch {
        request_key: key,
        prepared: prepared.clone(),
        expires_at: changes_without_commit.then(|| Instant::now() + Duration::from_secs(2)),
    });
    view.search = Some(prepared);
    Ok(())
}

// When more than the retained bound matches the Source, apply View
// eligibility before taking the bounded set used by every projection.
fn eligible_overflow(
    connection: &Connection,
    view: &ResolvedView,
    matches: &ViewPageMatches,
) -> Result<Option<Vec<String>>, StoreError> {
    let mut parameters = Vec::new();
    let (filter, completion) = view_predicates(view, &mut parameters)?;
    if filter == "1" && completion == "1" && matches.exact_heads {
        return Ok(None);
    }
    let source = bind(&mut parameters, SqlValue::Text(view.data_source_id.clone()));
    let (matching, predicate) = join_ids(matches.ids_json.clone(), &mut parameters);
    let exact_heads = if matches.exact_heads {
        ""
    } else {
        EXACT_HEAD_JOINS
    };
    let sql = format!(
        "SELECT membership.page_block_id FROM {matching}data_source_page_memberships membership
         JOIN page_read_model model ON model.page_block_id = membership.page_block_id
           AND model.membership_id = membership.id
         {exact_heads}
         WHERE membership.data_source_id = {source} AND membership.removed_at IS NULL
           AND model.lifecycle = 'active' {predicate} AND ({filter}) AND ({completion})
         ORDER BY membership.page_block_id LIMIT {}",
        MAX_VIEW_MATCHES + 1
    );
    let ids = connection
        .prepare(&sql)?
        .query_map(params_from_iter(parameters.iter()), |row| row.get(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(Some(ids))
}

fn has_relative_date(filter: &ViewFilter) -> bool {
    match filter {
        ViewFilter::Group { children, .. } => children.iter().any(has_relative_date),
        ViewFilter::Clause { operator, .. } => *operator == FilterOperator::DateRelativeTo,
    }
}

pub(super) fn membership_join(
    view: &ResolvedView,
    parameters: &mut Vec<SqlValue>,
) -> (String, String) {
    let Some(search) = &view.search else {
        return (String::new(), String::new());
    };
    join_ids(search.matches.ids_json.clone(), parameters)
}

pub(super) fn locator_membership_join(
    view: &ResolvedView,
    parameters: &mut Vec<SqlValue>,
) -> (String, String) {
    let ids = view
        .search
        .as_ref()
        .and_then(|search| search.matches.located_ids_json.as_ref());
    match ids {
        Some(ids) => join_ids(ids.clone(), parameters),
        None => membership_join(view, parameters),
    }
}

pub(super) fn join_ids(ids: String, parameters: &mut Vec<SqlValue>) -> (String, String) {
    let ids = bind(parameters, SqlValue::Text(ids));
    (
        format!("json_each({ids}) matched CROSS JOIN "),
        "AND membership.page_block_id = matched.value".to_owned(),
    )
}
