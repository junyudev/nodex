use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::{Arc, Mutex};

use nodex_core_contracts::BoundModuleContext;
use nodex_core_contracts::agent::AgentExecutionAuthorization;
use nodex_core_contracts::library::{
    LibraryAgentPageLocation, LibraryAgentPageSearchMatch, LibraryAgentSearchMatchQuality,
    LibraryAgentSearchResult, LibraryAgentSearchScope, LibraryPageReferenceCandidate,
    LibraryPageReferenceMatchSource, LibraryPageSearchMatch, LibraryPageSearchMatchQuality,
    LibraryPageSearchMetadataDocument, LibraryPageSearchMetadataProperty, LibraryPageSearchOption,
    LibraryPageSearchOptionIdentity, LibraryPageSearchTagMode, LibraryPageSearchTextPart,
    LibraryPageWorkflowStatus, LibraryProjectPageSearchFacets, LibraryProjectPageSearchFilters,
    LibraryProjectPageSearchHit,
};
use nodex_page_search_kernel::{
    MatchQuality as KernelMatchQuality, MetadataDocument as KernelDocument,
    MetadataMatchSource as KernelMatchSource, MetadataProperty as KernelProperty,
    MetadataSearchIndex, SearchOption as KernelOption, TextPart as KernelTextPart,
    WorkflowStatus as KernelWorkflowStatus,
};
use rusqlite::{Connection, params};
use serde_json::Value;

use crate::database::{self, current_page_keys_in_library, resolve_page_key_matches_in_library};
use crate::domain::page_key::is_explicit_page_key_search;
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

use super::search_match::{SearchTermMatchQuality, normalize_search_text, search_tokens};

const MAX_QUERY_BYTES: usize = 512;
const MAX_QUERY_TERMS: usize = 32;
const MAX_PROJECT_SCOPES: usize = 256;
const MAX_RECENT_HINTS: usize = 100;
const MAX_PAGE_RESULTS: usize = 100;
const MAX_FTS_HITS_PER_TERM: usize = 20_000;
const MAX_FILTER_VALUES: usize = 64;
const MAX_IDENTITY_BYTES: usize = 512;
const MAX_EXCERPT_FRAGMENTS: usize = 3;
const MAX_FRAGMENT_CHARACTERS: usize = 240;
const PAGE_BODY_SEARCH_SQL: &str = "SELECT unit.owner_block_id, unit.block_id, source.type, \
            snippet(block_search_units_fts, 0, char(2), char(3), '…', 32), \
            bm25(block_search_units_fts) AS rank \
     FROM block_search_units_fts \
     CROSS JOIN block_search_units unit ON unit.rowid = block_search_units_fts.rowid \
     JOIN documents document ON document.id = unit.document_id AND document.library_id = unit.library_id \
     JOIN blocks source ON source.id = unit.block_id AND source.library_id = unit.library_id \
     JOIN blocks owner ON owner.id = unit.owner_block_id AND owner.library_id = unit.library_id \
     WHERE block_search_units_fts MATCH ?1 AND unit.library_id = ?2 \
       AND unit.source_kind = 'document_block' AND unit.document_id IS NOT NULL \
       AND document.readiness = 'ready' \
       AND document.generation = unit.document_generation \
       AND document.head_seq = unit.projected_seq \
       AND source.lifecycle <> 'deleted' AND owner.lifecycle <> 'deleted' \
     ORDER BY rank, unit.owner_block_id, unit.block_id LIMIT ?3";

#[derive(Clone, Default)]
pub(crate) struct PageSearchIndexRegistry {
    state: Arc<Mutex<Option<CachedIndex>>>,
}

#[derive(Clone)]
struct CachedIndex {
    store_epoch: String,
    commit_head: i64,
    index: Arc<PageSearchIndex>,
}

#[derive(Clone, Debug)]
struct IndexedProperty {
    property_id: String,
    property_name: String,
    text: String,
}

#[derive(Clone, Debug)]
struct IndexedPage {
    id: String,
    title: String,
    preview: String,
    lifecycle: String,
    parent_kind: String,
    parent_id: String,
    updated_at: String,
    properties: Vec<IndexedProperty>,
    status: Option<LibraryPageWorkflowStatus>,
    priority: Option<String>,
    tags: Vec<LibraryPageSearchOption>,
    assignee: Option<String>,
    authorized_project_ids: BTreeSet<String>,
    page_key: Option<String>,
    location_label: String,
    data_source_ids: BTreeSet<String>,
}

pub(super) struct PageSearchIndex {
    pages: BTreeMap<String, IndexedPage>,
    data_source_databases: HashMap<String, String>,
    metadata_index: MetadataSearchIndex,
}

impl PageSearchIndexRegistry {
    pub(super) fn snapshot(
        &self,
        connection: &Connection,
        library_id: &str,
        store_epoch: &str,
        commit_head: i64,
    ) -> Result<Arc<PageSearchIndex>, StoreError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| internal("Page search index lock is unavailable"))?;
        if let Some(cached) = state.as_ref()
            && cached.store_epoch == store_epoch
            && cached.commit_head == commit_head
        {
            return Ok(cached.index.clone());
        }
        let index = Arc::new(build_index(connection, library_id)?);
        *state = Some(CachedIndex {
            store_epoch: store_epoch.to_owned(),
            commit_head,
            index: index.clone(),
        });
        Ok(index)
    }
}

fn build_index(connection: &Connection, library_id: &str) -> Result<PageSearchIndex, StoreError> {
    let pages = connection
        .prepare(
            "SELECT page_block_id, title, description_preview, lifecycle, parent_kind, parent_id, updated_at \
             FROM page_read_model WHERE library_id = ?1 AND lifecycle <> 'deleted' ORDER BY page_block_id",
        )?
        .query_map([library_id], |row| {
            let parent_kind: String = row.get(4)?;
            let parent_id: String = row.get(5)?;
            Ok(IndexedPage {
                id: row.get(0)?,
                title: row.get(1)?,
                preview: row.get(2)?,
                lifecycle: row.get(3)?,
                data_source_ids: if parent_kind == "data_source" {
                    BTreeSet::from([parent_id.clone()])
                } else {
                    BTreeSet::new()
                },
                parent_kind,
                parent_id,
                updated_at: row.get(6)?,
                properties: Vec::new(),
                status: None,
                priority: None,
                tags: Vec::new(),
                assignee: None,
                authorized_project_ids: BTreeSet::new(),
                page_key: None,
                location_label: String::new(),
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut pages = pages
        .into_iter()
        .map(|page| (page.id.clone(), page))
        .collect::<BTreeMap<_, _>>();
    let rows = connection
        .prepare(
            "SELECT membership.page_block_id, membership.data_source_id, property.id, property.name, \
                    property.value_type, property.config_json, value.value_json \
             FROM data_source_page_memberships membership \
             JOIN data_source_properties property ON property.data_source_id = membership.data_source_id \
               AND property.lifecycle = 'active' \
             JOIN data_source_property_values value ON value.membership_id = membership.id \
               AND value.property_id = property.id AND value.data_source_id = membership.data_source_id \
             JOIN page_read_model page ON page.page_block_id = membership.page_block_id \
               AND page.library_id = ?1 AND page.lifecycle <> 'deleted' \
             WHERE membership.removed_at IS NULL \
             ORDER BY membership.page_block_id, property.rank_key, property.id",
        )?
        .query_map([library_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (
        page_id,
        data_source_id,
        property_id,
        property_name,
        value_type,
        config_json,
        value_json,
    ) in rows
    {
        let Some(page) = pages.get_mut(&page_id) else {
            continue;
        };
        page.data_source_ids.insert(data_source_id.clone());
        let value = serde_json::from_str::<Value>(&value_json)
            .map_err(|_| corrupt("Page search Property value is invalid"))?;
        let Some((text, options)) = property_display_value(
            &data_source_id,
            &property_id,
            &value_type,
            &config_json,
            &value,
        )?
        else {
            continue;
        };
        if text.is_empty() {
            continue;
        }
        let owns_membership = page.parent_kind == "data_source" && page.parent_id == data_source_id;
        if owns_membership && property_id == "status" {
            page.status = workflow_status(value.as_str());
        } else if owns_membership && property_id == "priority" {
            page.priority = value.as_str().map(ToOwned::to_owned);
        } else if owns_membership && property_id == "tags" {
            page.tags = options.clone();
        } else if owns_membership && property_id == "assignee" {
            page.assignee = value.as_str().map(ToOwned::to_owned);
        }
        page.properties.push(IndexedProperty {
            property_id,
            property_name,
            text,
        });
    }

    let data_source_databases = connection
        .prepare("SELECT id, home_database_block_id FROM data_sources WHERE library_id = ?1")?
        .query_map([library_id], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<HashMap<_, _>>>()?;
    populate_authorized_projects(connection, library_id, &data_source_databases, &mut pages)?;
    let page_keys = current_page_keys_in_library(connection, library_id)?;
    let data_source_names = connection
        .prepare(
            "SELECT source.id, container.name FROM data_sources source \
             JOIN database_containers container ON container.block_id = source.home_database_block_id \
             WHERE source.library_id = ?1",
        )?
        .query_map([library_id], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<HashMap<String, String>>>()?;
    let locations = pages
        .keys()
        .map(|page_id| {
            let label = page_location_label(&pages, &data_source_names, library_id, page_id)
                .unwrap_or_else(|error| {
                    tracing::warn!(
                        subsystem = "library_page_search",
                        page_id = %page_id,
                        error = %error,
                        "Page search location label is unavailable"
                    );
                    String::new()
                });
            (page_id.clone(), label)
        })
        .collect::<HashMap<_, _>>();
    for page in pages.values_mut() {
        page.page_key = page_keys.get(&page.id).cloned();
        page.location_label = locations.get(&page.id).cloned().unwrap_or_default();
    }
    let metadata_documents = pages
        .values()
        .map(|page| KernelDocument {
            page_id: page.id.clone(),
            page_key: page.page_key.clone(),
            title: page.title.clone(),
            preview: page.preview.clone(),
            status: page.status.map(kernel_workflow_status),
            priority: page.priority.clone(),
            tags: page.tags.iter().map(kernel_option).collect(),
            assignee: page.assignee.clone(),
            location_label: page.location_label.clone(),
            updated_at: page.updated_at.clone(),
            properties: page
                .properties
                .iter()
                .map(|property| KernelProperty {
                    property_id: property.property_id.clone(),
                    property_name: property.property_name.clone(),
                    text: property.text.clone(),
                })
                .collect(),
            authorized_project_ids: page.authorized_project_ids.iter().cloned().collect(),
            data_source_ids: page.data_source_ids.iter().cloned().collect(),
        })
        .collect::<Vec<_>>();
    Ok(PageSearchIndex {
        pages,
        data_source_databases,
        metadata_index: MetadataSearchIndex::new(metadata_documents),
    })
}

fn page_location_label(
    pages: &BTreeMap<String, IndexedPage>,
    data_source_names: &HashMap<String, String>,
    library_id: &str,
    page_id: &str,
) -> Result<String, StoreError> {
    let mut current = pages
        .get(page_id)
        .ok_or_else(|| corrupt("Page search location is missing"))?;
    let mut ancestors = Vec::new();
    let mut seen = HashSet::new();
    loop {
        if !seen.insert(current.id.as_str()) {
            return Err(corrupt("Page search location contains a cycle"));
        }
        match current.parent_kind.as_str() {
            "page" => {
                current = pages
                    .get(&current.parent_id)
                    .ok_or_else(|| corrupt("Page search parent is missing"))?;
                ancestors.push(current.title.clone());
            }
            "library" if current.parent_id == library_id => {
                ancestors.reverse();
                return Ok(std::iter::once("Pages".to_owned())
                    .chain(ancestors)
                    .collect::<Vec<_>>()
                    .join(" / "));
            }
            "data_source" => {
                let boundary = data_source_names
                    .get(&current.parent_id)
                    .ok_or_else(|| corrupt("Page search Database boundary is missing"))?
                    .clone();
                ancestors.reverse();
                return Ok(std::iter::once(boundary)
                    .chain(ancestors)
                    .collect::<Vec<_>>()
                    .join(" / "));
            }
            _ => return Err(corrupt("Page search location has an invalid boundary")),
        }
    }
}

fn kernel_workflow_status(status: LibraryPageWorkflowStatus) -> KernelWorkflowStatus {
    match status {
        LibraryPageWorkflowStatus::Triage => KernelWorkflowStatus::Triage,
        LibraryPageWorkflowStatus::Plan => KernelWorkflowStatus::Plan,
        LibraryPageWorkflowStatus::Build => KernelWorkflowStatus::Build,
        LibraryPageWorkflowStatus::Review => KernelWorkflowStatus::Review,
        LibraryPageWorkflowStatus::Ship => KernelWorkflowStatus::Ship,
    }
}

fn kernel_option(option: &LibraryPageSearchOption) -> KernelOption {
    KernelOption {
        data_source_id: option.data_source_id.clone(),
        property_id: option.property_id.clone(),
        option_id: option.option_id.clone(),
        label: option.label.clone(),
    }
}

/// Materializes the same Project read roots used by ordinary Page reads into
/// the commit-fenced search projection. Queries can then authorize the whole
/// corpus before top-K selection without issuing SQL once per Page.
fn populate_authorized_projects(
    connection: &Connection,
    library_id: &str,
    data_source_databases: &HashMap<String, String>,
    pages: &mut BTreeMap<String, IndexedPage>,
) -> Result<(), StoreError> {
    let mut database_projects = HashMap::<String, BTreeSet<String>>::new();
    for (project_id, primary_database_id) in connection
        .prepare("SELECT id, database_block_id FROM projects WHERE library_id = ?1 ORDER BY id")?
        .query_map([library_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?
    {
        if let Some(database_id) = primary_database_id {
            database_projects
                .entry(database_id)
                .or_default()
                .insert(project_id);
        }
    }

    let mut page_grants = HashMap::<String, BTreeSet<String>>::new();
    for (project_id, root_kind, root_id) in connection
        .prepare(
            "SELECT grant_row.project_id, grant_row.root_kind, grant_row.root_id \
             FROM project_resource_grants grant_row \
             JOIN projects project ON project.id = grant_row.project_id \
               AND project.library_id = grant_row.library_id \
               AND project.library_id = ?1 \
             WHERE grant_row.lifecycle = 'active' ORDER BY grant_row.project_id, grant_row.id",
        )?
        .query_map([library_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?
    {
        match root_kind.as_str() {
            "database" => {
                database_projects
                    .entry(root_id)
                    .or_default()
                    .insert(project_id);
            }
            "page" => {
                page_grants.entry(root_id).or_default().insert(project_id);
            }
            _ => {}
        }
    }

    let page_ids = pages.keys().cloned().collect::<Vec<_>>();
    for page_id in page_ids {
        let Some((ancestors, database_id)) =
            page_access_coordinates(pages, data_source_databases, library_id, &page_id)
        else {
            continue;
        };
        let mut authorized = BTreeSet::new();
        if let Some(database_id) = database_id
            && let Some(projects) = database_projects.get(&database_id)
        {
            authorized.extend(projects.iter().cloned());
        }
        for ancestor_id in ancestors {
            if let Some(projects) = page_grants.get(&ancestor_id) {
                authorized.extend(projects.iter().cloned());
            }
        }
        if let Some(page) = pages.get_mut(&page_id) {
            page.authorized_project_ids = authorized;
        }
    }
    Ok(())
}

fn page_access_coordinates(
    pages: &BTreeMap<String, IndexedPage>,
    data_source_databases: &HashMap<String, String>,
    library_id: &str,
    page_id: &str,
) -> Option<(Vec<String>, Option<String>)> {
    let mut current = pages.get(page_id)?;
    let mut ancestors = Vec::new();
    let mut seen = HashSet::new();
    loop {
        if !seen.insert(current.id.clone()) {
            return None;
        }
        ancestors.push(current.id.clone());
        match current.parent_kind.as_str() {
            "page" => current = pages.get(&current.parent_id)?,
            "library" if current.parent_id == library_id => return Some((ancestors, None)),
            "data_source" => {
                let database_id = data_source_databases.get(&current.parent_id)?.clone();
                return Some((ancestors, Some(database_id)));
            }
            _ => return None,
        }
    }
}

fn property_display_value(
    data_source_id: &str,
    property_id: &str,
    value_type: &str,
    config_json: &str,
    value: &Value,
) -> Result<Option<(String, Vec<LibraryPageSearchOption>)>, StoreError> {
    if value.is_null() {
        return Ok(None);
    }
    if matches!(value_type, "select" | "multi_select") {
        let config = database::property_semantics::option_config_from_storage(
            property_id,
            value_type,
            config_json,
        )?;
        let registry = config
            .options
            .iter()
            .map(|option| (option.id.as_str(), option.name.as_str()))
            .collect::<HashMap<_, _>>();
        let ids = if value_type == "select" {
            vec![
                value
                    .as_str()
                    .ok_or_else(|| corrupt("Page search select Property value is invalid"))?,
            ]
        } else {
            value
                .as_array()
                .ok_or_else(|| corrupt("Page search multi-select Property value is invalid"))?
                .iter()
                .map(|item| {
                    item.as_str().ok_or_else(|| {
                        corrupt("Page search multi-select Property contains a non-string option")
                    })
                })
                .collect::<Result<Vec<_>, _>>()?
        };
        let mut selected = HashSet::new();
        let options = ids
            .into_iter()
            .map(|option_id| {
                if !selected.insert(option_id) {
                    return Err(corrupt("Page search Property repeats an option"));
                }
                let label = registry
                    .get(option_id)
                    .copied()
                    .ok_or_else(|| corrupt("Page search Property option is not registered"))?;
                Ok(LibraryPageSearchOption {
                    data_source_id: data_source_id.to_owned(),
                    property_id: property_id.to_owned(),
                    option_id: option_id.to_owned(),
                    label: label.to_owned(),
                })
            })
            .collect::<Result<Vec<_>, StoreError>>()?;
        return Ok(Some((
            options
                .iter()
                .map(|option| option.label.as_str())
                .collect::<Vec<_>>()
                .join(" "),
            options,
        )));
    }
    let config = serde_json::from_str::<Value>(config_json)
        .map_err(|_| corrupt("Page search Property config is invalid"))?;
    if !config.is_object() {
        return Err(corrupt("Page search Property config is not an object"));
    }
    let display = match value_type {
        "checkbox" => Some(
            value
                .as_bool()
                .ok_or_else(|| corrupt("Page search checkbox Property value is invalid"))?
                .to_string(),
        ),
        "number" => {
            let value = value
                .as_f64()
                .filter(|value| value.is_finite())
                .ok_or_else(|| corrupt("Page search number Property value is invalid"))?;
            Some(if value.fract() == 0.0 {
                format!("{value:.0}")
            } else {
                value.to_string()
            })
        }
        "text" | "date" | "datetime" => Some(
            value
                .as_str()
                .ok_or_else(|| corrupt("Page search textual Property value is invalid"))?
                .to_owned(),
        ),
        "relation" => None,
        _ => return Err(corrupt("Page search Property type is unsupported")),
    };
    Ok(display.map(|text| (text, Vec::new())))
}

fn workflow_status(value: Option<&str>) -> Option<LibraryPageWorkflowStatus> {
    match value {
        Some("triage") => Some(LibraryPageWorkflowStatus::Triage),
        Some("plan") => Some(LibraryPageWorkflowStatus::Plan),
        Some("build") => Some(LibraryPageWorkflowStatus::Build),
        Some("review") => Some(LibraryPageWorkflowStatus::Review),
        Some("ship") => Some(LibraryPageWorkflowStatus::Ship),
        _ => None,
    }
}

#[derive(Clone)]
struct Evidence {
    term: String,
    matched_token: String,
    kind: EvidenceKind,
    quality: SearchTermMatchQuality,
    edit_distance: usize,
    parts: Vec<LibraryPageSearchTextPart>,
}

#[derive(Clone)]
enum EvidenceKind {
    PageKey {
        page_key: String,
        is_current: bool,
    },
    Identity,
    Title,
    Property {
        property_id: String,
        property_name: String,
    },
    Body {
        block_id: String,
        block_type: String,
    },
}

struct Aggregate {
    page_id: String,
    terms: HashSet<String>,
    evidence: Vec<Evidence>,
    body_ranks: HashMap<String, f64>,
}

struct SearchOutcome {
    aggregate: Aggregate,
    project_id: Option<String>,
    recent_index: Option<usize>,
}

pub(super) struct ProjectSearchRequest<'a> {
    pub project_ids: &'a [String],
    pub query: &'a str,
    pub filters: Option<&'a LibraryProjectPageSearchFilters>,
    pub preferred_project_id: Option<&'a str>,
    pub recent_page_ids: &'a [String],
    pub limit: Option<u32>,
}

pub(super) struct AgentSearchRequest<'a> {
    pub context: &'a BoundModuleContext,
    pub authorization: &'a AgentExecutionAuthorization,
    pub query: &'a str,
    pub scope: &'a LibraryAgentSearchScope,
    pub include_archived: bool,
}

pub(super) fn search_projects(
    connection: &Connection,
    index: &PageSearchIndex,
    library_id: &str,
    request: ProjectSearchRequest<'_>,
) -> Result<Vec<LibraryProjectPageSearchHit>, StoreError> {
    validate_project_request(&request)?;
    let query = normalize_query(request.query)?;
    let terms = unique_terms(&query)?;
    let aggregates = search_index(connection, index, library_id, &query, &terms)?;
    let outcomes = rank_project_outcomes(index, aggregates, &request);
    let limit = result_limit(request.limit)?;
    outcomes
        .into_iter()
        .take(limit)
        .map(|outcome| project_hit(index, outcome))
        .collect()
}

fn rank_project_outcomes(
    index: &PageSearchIndex,
    aggregates: Vec<Aggregate>,
    request: &ProjectSearchRequest<'_>,
) -> Vec<SearchOutcome> {
    let projects = preferred_projects(request.project_ids, request.preferred_project_id);
    let recent = request
        .recent_page_ids
        .iter()
        .enumerate()
        .map(|(index, page_id)| (page_id.as_str(), index))
        .collect::<HashMap<_, _>>();
    let mut outcomes = Vec::new();
    for aggregate in aggregates {
        let Some(page) = index.pages.get(&aggregate.page_id) else {
            continue;
        };
        if page.lifecycle != "active" || !matches_filters(page, request.filters) {
            continue;
        }
        let mut project_id = None;
        for candidate_project_id in &projects {
            if page.authorized_project_ids.contains(candidate_project_id) {
                project_id = Some(candidate_project_id.clone());
                break;
            }
        }
        let Some(project_id) = project_id else {
            continue;
        };
        outcomes.push(SearchOutcome {
            recent_index: recent.get(page.id.as_str()).copied(),
            aggregate,
            project_id: Some(project_id),
        });
    }
    outcomes
        .sort_by(|left, right| compare_outcomes(left, right, index, request.preferred_project_id));
    outcomes
}

pub(super) fn project_facets(
    index: &PageSearchIndex,
    project_ids: &[String],
) -> Result<LibraryProjectPageSearchFacets, StoreError> {
    validate_project_ids(project_ids)?;
    let mut tags = BTreeMap::<(String, String, String), LibraryPageSearchOption>::new();
    let mut assignees = BTreeSet::new();
    for page in index
        .pages
        .values()
        .filter(|page| page.lifecycle == "active")
    {
        if !project_ids
            .iter()
            .any(|project_id| page.authorized_project_ids.contains(project_id))
        {
            continue;
        }
        for tag in &page.tags {
            tags.insert(
                (
                    tag.data_source_id.clone(),
                    tag.property_id.clone(),
                    tag.option_id.clone(),
                ),
                tag.clone(),
            );
        }
        if let Some(assignee) = page
            .assignee
            .as_ref()
            .filter(|value| !value.trim().is_empty())
        {
            assignees.insert(assignee.clone());
        }
    }
    let mut tags = tags.into_values().collect::<Vec<_>>();
    tags.sort_by(|left, right| {
        left.label
            .cmp(&right.label)
            .then_with(|| left.option_id.cmp(&right.option_id))
    });
    Ok(LibraryProjectPageSearchFacets {
        tags,
        assignees: assignees.into_iter().collect(),
    })
}

pub(super) fn project_metadata(
    index: &PageSearchIndex,
    project_ids: &[String],
    requested_page_ids: Option<&[String]>,
) -> Result<Vec<LibraryPageSearchMetadataDocument>, StoreError> {
    validate_project_ids(project_ids)?;
    if requested_page_ids.is_some_and(|ids| ids.len() > 10_000) {
        return Err(invalid("Page search metadata delta is out of range"));
    }
    if let Some(ids) = requested_page_ids {
        validate_unique_identities(ids, "Page search metadata Page")?;
    }
    let requested =
        requested_page_ids.map(|ids| ids.iter().map(String::as_str).collect::<HashSet<_>>());
    index
        .pages
        .values()
        .filter(|page| page.lifecycle == "active")
        .filter(|page| {
            requested
                .as_ref()
                .is_none_or(|ids| ids.contains(page.id.as_str()))
        })
        .filter_map(|page| {
            let authorized_project_ids = project_ids
                .iter()
                .filter(|project_id| page.authorized_project_ids.contains(*project_id))
                .cloned()
                .collect::<Vec<_>>();
            (!authorized_project_ids.is_empty()).then_some((page, authorized_project_ids))
        })
        .map(|(page, authorized_project_ids)| {
            Ok(LibraryPageSearchMetadataDocument {
                page_id: page.id.clone(),
                page_key: page.page_key.clone(),
                title: page.title.clone(),
                preview: page.preview.clone(),
                status: page.status,
                priority: page.priority.clone(),
                tags: page.tags.clone(),
                assignee: page.assignee.clone(),
                location_label: page.location_label.clone(),
                updated_at: page.updated_at.clone(),
                properties: page
                    .properties
                    .iter()
                    .map(|property| LibraryPageSearchMetadataProperty {
                        property_id: property.property_id.clone(),
                        property_name: property.property_name.clone(),
                        text: property.text.clone(),
                    })
                    .collect(),
                authorized_project_ids,
                data_source_ids: page.data_source_ids.iter().cloned().collect(),
            })
        })
        .collect()
}

pub(super) fn search_references(
    connection: &Connection,
    index: &PageSearchIndex,
    library_id: &str,
    context: &BoundModuleContext,
    query: &str,
    requested_limit: Option<u32>,
    source_page_id: Option<&str>,
) -> Result<Vec<LibraryPageReferenceCandidate>, StoreError> {
    let query = normalize_query(query)?;
    let terms = unique_terms(&query)?;
    let mut aggregates = search_index(connection, index, library_id, &query, &terms)?;
    aggregates.retain_mut(|aggregate| {
        if source_page_id != Some(aggregate.page_id.as_str()) {
            return true;
        }
        aggregate
            .evidence
            .retain(|evidence| !matches!(evidence.kind, EvidenceKind::Body { .. }));
        aggregate.terms = aggregate
            .evidence
            .iter()
            .map(|evidence| evidence.term.clone())
            .collect();
        terms.iter().all(|term| aggregate.terms.contains(term)) || terms.is_empty()
    });
    let mut outcomes = Vec::new();
    for aggregate in aggregates {
        let Some(page) = index.pages.get(&aggregate.page_id) else {
            continue;
        };
        if page.lifecycle != "active" {
            continue;
        }
        if let Some(project_id) = context.project_id.as_ref()
            && !page.authorized_project_ids.contains(&project_id.0)
        {
            continue;
        }
        outcomes.push(SearchOutcome {
            aggregate,
            project_id: None,
            recent_index: None,
        });
    }
    outcomes.sort_by(|left, right| compare_outcomes(left, right, index, None));
    let limit = result_limit(requested_limit)?.min(60);
    outcomes
        .into_iter()
        .take(limit)
        .map(|outcome| reference_hit(index, outcome))
        .collect()
}

pub(super) fn search_agent_pages(
    connection: &Connection,
    index: &PageSearchIndex,
    library_id: &str,
    request: AgentSearchRequest<'_>,
) -> Result<Vec<LibraryAgentSearchResult>, StoreError> {
    let query = normalize_query(request.query)?;
    let terms = unique_terms(&query)?;
    let aggregates = search_index(connection, index, library_id, &query, &terms)?;
    let candidate_ids = aggregates
        .iter()
        .filter_map(|aggregate| index.pages.get(&aggregate.page_id))
        .filter(|page| request.include_archived || page.lifecycle == "active")
        .filter(|page| page_in_agent_scope(index, page, request.scope))
        .map(|page| page.id.clone())
        .collect::<Vec<_>>();
    let authorized = super::agent_authorization::authorized_page_ids(
        connection,
        request.context,
        library_id,
        request.authorization,
        &candidate_ids,
    )?;
    let mut outcomes = aggregates
        .into_iter()
        .filter(|aggregate| authorized.contains(&aggregate.page_id))
        .filter(|aggregate| {
            index.pages.get(&aggregate.page_id).is_some_and(|page| {
                (request.include_archived || page.lifecycle == "active")
                    && page_in_agent_scope(index, page, request.scope)
            })
        })
        .map(|aggregate| SearchOutcome {
            aggregate,
            project_id: None,
            recent_index: None,
        })
        .collect::<Vec<_>>();
    outcomes.sort_by(|left, right| compare_outcomes(left, right, index, None));
    outcomes
        .into_iter()
        .map(|outcome| agent_hit(index, library_id, outcome))
        .collect()
}

fn search_index(
    connection: &Connection,
    index: &PageSearchIndex,
    library_id: &str,
    query: &str,
    terms: &[String],
) -> Result<Vec<Aggregate>, StoreError> {
    if terms.is_empty() {
        return Ok(index
            .pages
            .values()
            .map(|page| Aggregate {
                page_id: page.id.clone(),
                terms: HashSet::new(),
                evidence: Vec::new(),
                body_ranks: HashMap::new(),
            })
            .collect());
    }
    let mut aggregates = HashMap::<String, Aggregate>::new();
    for matched in index
        .metadata_index
        .match_documents(query)
        .map_err(|message| invalid(&format!("Page search kernel rejected query: {message}")))?
    {
        for evidence in matched.evidence {
            let kind = match evidence.source {
                // Core resolves Page keys separately so casing and historical-key
                // status come from the authoritative PageKeyResolution.
                KernelMatchSource::PageKey { .. } => continue,
                KernelMatchSource::Identity => EvidenceKind::Identity,
                KernelMatchSource::Title => EvidenceKind::Title,
                KernelMatchSource::Property {
                    property_id,
                    property_name,
                } => EvidenceKind::Property {
                    property_id,
                    property_name,
                },
            };
            add_evidence(
                &mut aggregates,
                &matched.page_id,
                Evidence {
                    term: evidence.term,
                    matched_token: evidence.matched_token,
                    kind,
                    quality: core_match_quality(evidence.quality),
                    edit_distance: evidence.edit_distance,
                    parts: evidence.parts.into_iter().map(core_text_part).collect(),
                },
                None,
            );
        }
    }
    for resolution in resolve_page_key_matches_in_library(connection, library_id, query)? {
        let Some(page) = index.pages.get(&resolution.page_block_id) else {
            continue;
        };
        let parts = highlight_text(
            &resolution.matched_page_key,
            std::slice::from_ref(&resolution.matched_page_key),
        );
        add_evidence(
            &mut aggregates,
            &page.id,
            Evidence {
                term: terms.join(" "),
                matched_token: resolution.matched_page_key.clone(),
                kind: EvidenceKind::PageKey {
                    page_key: resolution.matched_page_key,
                    is_current: resolution.is_current,
                },
                quality: SearchTermMatchQuality::Exact,
                edit_distance: 0,
                parts,
            },
            None,
        );
    }
    if is_explicit_page_key_search(query) {
        return Ok(aggregates.into_values().collect());
    }
    for term in terms {
        for hit in search_body_term(connection, library_id, term)? {
            add_evidence(
                &mut aggregates,
                &hit.page_id,
                Evidence {
                    term: term.clone(),
                    matched_token: hit.matched_token,
                    kind: EvidenceKind::Body {
                        block_id: hit.block_id,
                        block_type: hit.block_type,
                    },
                    quality: hit.quality,
                    edit_distance: 0,
                    parts: hit.parts,
                },
                Some(hit.rank),
            );
        }
    }
    Ok(aggregates
        .into_values()
        .filter(|aggregate| terms.iter().all(|term| aggregate.terms.contains(term)))
        .collect())
}

fn core_match_quality(quality: KernelMatchQuality) -> SearchTermMatchQuality {
    match quality {
        KernelMatchQuality::Exact => SearchTermMatchQuality::Exact,
        KernelMatchQuality::Prefix => SearchTermMatchQuality::Prefix,
        KernelMatchQuality::Fuzzy => SearchTermMatchQuality::Fuzzy,
    }
}

fn core_text_part(part: KernelTextPart) -> LibraryPageSearchTextPart {
    LibraryPageSearchTextPart {
        text: part.text,
        highlighted: part.highlighted,
    }
}

fn add_evidence(
    aggregates: &mut HashMap<String, Aggregate>,
    page_id: &str,
    evidence: Evidence,
    body_rank: Option<f64>,
) {
    let aggregate = aggregates
        .entry(page_id.to_owned())
        .or_insert_with(|| Aggregate {
            page_id: page_id.to_owned(),
            terms: HashSet::new(),
            evidence: Vec::new(),
            body_ranks: HashMap::new(),
        });
    aggregate.terms.insert(evidence.term.clone());
    if let Some(body_rank) = body_rank {
        aggregate
            .body_ranks
            .entry(evidence.term.clone())
            .and_modify(|rank| *rank = rank.min(body_rank))
            .or_insert(body_rank);
    }
    let duplicate = aggregate.evidence.iter().any(|existing| {
        existing.term == evidence.term
            && existing.matched_token == evidence.matched_token
            && evidence_kind_key(&existing.kind) == evidence_kind_key(&evidence.kind)
    });
    if !duplicate {
        aggregate.evidence.push(evidence);
    }
}

fn evidence_kind_key(kind: &EvidenceKind) -> String {
    match kind {
        EvidenceKind::PageKey { page_key, .. } => format!("page_key:{page_key}"),
        EvidenceKind::Identity => "identity".to_owned(),
        EvidenceKind::Title => "title".to_owned(),
        EvidenceKind::Property { property_id, .. } => format!("property:{property_id}"),
        EvidenceKind::Body { block_id, .. } => format!("body:{block_id}"),
    }
}

struct BodyHit {
    page_id: String,
    block_id: String,
    block_type: String,
    quality: SearchTermMatchQuality,
    matched_token: String,
    parts: Vec<LibraryPageSearchTextPart>,
    rank: f64,
}

fn search_body_term(
    connection: &Connection,
    library_id: &str,
    term: &str,
) -> Result<Vec<BodyHit>, StoreError> {
    let match_query = if term.chars().count() >= 2 {
        format!("{}*", quote_fts_term(term))
    } else {
        quote_fts_term(term)
    };
    // FTS MATCH is the selective operation and must drive rowid lookups. A
    // plain JOIN lets a statistics-free Store put `unit` in the outer loop,
    // which re-evaluates the virtual table once for every search unit.
    let mut hits = connection
        .prepare(PAGE_BODY_SEARCH_SQL)?
        .query_map(
            params![match_query, library_id, (MAX_FTS_HITS_PER_TERM + 1) as i64],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, f64>(4)?,
                ))
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if hits.len() > MAX_FTS_HITS_PER_TERM {
        return Err(StoreError::new(
            StoreErrorCode::ResourceExhausted,
            "Page search term matches too many body units",
            false,
        ));
    }
    hits.drain(..)
        .map(|(page_id, block_id, block_type, excerpt, rank)| {
            if !rank.is_finite() {
                return Err(corrupt("Page search FTS rank is invalid"));
            }
            let (parts, matched_tokens) = parse_fts_parts(&excerpt);
            let matched_token = matched_tokens
                .first()
                .cloned()
                .unwrap_or_else(|| term.to_owned());
            let quality = if matched_tokens
                .iter()
                .any(|token| normalize_search_text(token) == term)
            {
                SearchTermMatchQuality::Exact
            } else {
                SearchTermMatchQuality::Prefix
            };
            Ok(BodyHit {
                page_id,
                block_id,
                block_type,
                quality,
                matched_token,
                parts,
                rank,
            })
        })
        .collect()
}

fn quote_fts_term(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

fn parse_fts_parts(excerpt: &str) -> (Vec<LibraryPageSearchTextPart>, Vec<String>) {
    let mut parts = Vec::new();
    let mut matched = Vec::new();
    let mut buffer = String::new();
    let mut highlighted = false;
    for character in excerpt.chars() {
        if character == '\u{2}' || character == '\u{3}' {
            if !buffer.is_empty() {
                if highlighted {
                    matched.push(buffer.clone());
                }
                push_part(&mut parts, std::mem::take(&mut buffer), highlighted);
            }
            highlighted = character == '\u{2}';
            continue;
        }
        buffer.push(character);
    }
    if !buffer.is_empty() {
        if highlighted {
            matched.push(buffer.clone());
        }
        push_part(&mut parts, buffer, highlighted);
    }
    (parts, matched)
}

fn highlight_text(text: &str, matched_tokens: &[String]) -> Vec<LibraryPageSearchTextPart> {
    if text.is_empty() {
        return Vec::new();
    }
    let matched = matched_tokens
        .iter()
        .map(|token| normalize_search_text(token))
        .collect::<HashSet<_>>();
    let mut parts = Vec::new();
    let mut buffer = String::new();
    let mut current_highlight = None;
    for token in split_preserving_whitespace(text) {
        let normalized = normalize_search_text(token);
        let highlight = !normalized.is_empty() && matched.contains(&normalized);
        if current_highlight == Some(highlight) || current_highlight.is_none() {
            buffer.push_str(token);
            current_highlight = Some(highlight);
            continue;
        }
        push_part(
            &mut parts,
            std::mem::take(&mut buffer),
            current_highlight.unwrap_or(false),
        );
        buffer.push_str(token);
        current_highlight = Some(highlight);
    }
    if !buffer.is_empty() {
        push_part(&mut parts, buffer, current_highlight.unwrap_or(false));
    }
    parts
}

fn split_preserving_whitespace(value: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut start = 0;
    let mut whitespace = None;
    for (index, character) in value.char_indices() {
        let next = character.is_whitespace();
        if whitespace.is_some_and(|current| current != next) {
            parts.push(&value[start..index]);
            start = index;
        }
        whitespace = Some(next);
    }
    if start < value.len() {
        parts.push(&value[start..]);
    }
    parts
}

fn push_part(parts: &mut Vec<LibraryPageSearchTextPart>, text: String, highlighted: bool) {
    if text.is_empty() {
        return;
    }
    if let Some(last) = parts.last_mut()
        && last.highlighted == highlighted
    {
        last.text.push_str(&text);
        return;
    }
    parts.push(LibraryPageSearchTextPart { text, highlighted });
}

fn matches_filters(page: &IndexedPage, filters: Option<&LibraryProjectPageSearchFilters>) -> bool {
    let Some(filters) = filters else {
        return true;
    };
    if let Some(statuses) = filters.statuses.as_ref()
        && !page.status.is_some_and(|status| statuses.contains(&status))
    {
        return false;
    }
    if let Some(priorities) = filters.priorities.as_ref() {
        match page.priority.as_ref() {
            Some(priority) if priorities.contains(priority) => {}
            None if filters.include_empty_priority => {}
            _ => return false,
        }
    }
    if !filters.assignees.is_empty()
        && !page
            .assignee
            .as_ref()
            .is_some_and(|assignee| filters.assignees.contains(assignee))
    {
        return false;
    }
    if filters.tags.is_empty() {
        return true;
    }
    let selected = page
        .tags
        .iter()
        .map(option_identity)
        .collect::<HashSet<_>>();
    let requested = filters.tags.iter().map(filter_identity).collect::<Vec<_>>();
    match filters.tag_mode {
        LibraryPageSearchTagMode::Any => {
            requested.iter().any(|identity| selected.contains(identity))
        }
        LibraryPageSearchTagMode::All => {
            requested.iter().all(|identity| selected.contains(identity))
        }
        LibraryPageSearchTagMode::None => requested
            .iter()
            .all(|identity| !selected.contains(identity)),
    }
}

fn option_identity(option: &LibraryPageSearchOption) -> (String, String, String) {
    (
        option.data_source_id.clone(),
        option.property_id.clone(),
        option.option_id.clone(),
    )
}

fn filter_identity(option: &LibraryPageSearchOptionIdentity) -> (String, String, String) {
    (
        option.data_source_id.clone(),
        option.property_id.clone(),
        option.option_id.clone(),
    )
}

fn compare_outcomes(
    left: &SearchOutcome,
    right: &SearchOutcome,
    index: &PageSearchIndex,
    preferred_project_id: Option<&str>,
) -> Ordering {
    let left_page = index
        .pages
        .get(&left.aggregate.page_id)
        .expect("indexed Page");
    let right_page = index
        .pages
        .get(&right.aggregate.page_id)
        .expect("indexed Page");
    if left.aggregate.evidence.is_empty() && right.aggregate.evidence.is_empty() {
        return compare_context(left, right, preferred_project_id)
            .then_with(|| right_page.updated_at.cmp(&left_page.updated_at))
            .then_with(|| left_page.id.cmp(&right_page.id));
    }
    aggregate_rank(&left.aggregate)
        .cmp(&aggregate_rank(&right.aggregate))
        .then_with(|| compare_context(left, right, preferred_project_id))
        .then_with(|| compare_body_ranks(&left.aggregate, &right.aggregate))
        .then_with(|| right_page.updated_at.cmp(&left_page.updated_at))
        .then_with(|| left_page.id.cmp(&right_page.id))
}

fn compare_context(
    left: &SearchOutcome,
    right: &SearchOutcome,
    preferred: Option<&str>,
) -> Ordering {
    let preferred_rank = |outcome: &SearchOutcome| {
        usize::from(outcome.project_id.as_deref() != preferred || preferred.is_none())
    };
    preferred_rank(left)
        .cmp(&preferred_rank(right))
        .then_with(|| {
            left.recent_index
                .unwrap_or(usize::MAX)
                .cmp(&right.recent_index.unwrap_or(usize::MAX))
        })
}

fn aggregate_rank(aggregate: &Aggregate) -> (usize, usize, usize, usize, usize) {
    let mut best_by_term = HashMap::<&str, (usize, usize)>::new();
    for evidence in &aggregate.evidence {
        let candidate = (evidence_rank(evidence), evidence.edit_distance);
        best_by_term
            .entry(&evidence.term)
            .and_modify(|best| *best = (*best).min(candidate))
            .or_insert(candidate);
    }
    let mut ranks = best_by_term.values().copied().collect::<Vec<_>>();
    ranks.sort_unstable();
    (
        ranks
            .iter()
            .map(|(rank, _)| *rank)
            .max()
            .unwrap_or(usize::MAX),
        ranks
            .iter()
            .map(|(_, edit_distance)| *edit_distance)
            .max()
            .unwrap_or(0),
        ranks.iter().map(|(rank, _)| *rank).sum(),
        ranks.iter().map(|(_, edit_distance)| *edit_distance).sum(),
        usize::MAX - aggregate.evidence.len(),
    )
}

fn compare_body_ranks(left: &Aggregate, right: &Aggregate) -> Ordering {
    let score = |aggregate: &Aggregate| {
        let worst = aggregate
            .body_ranks
            .values()
            .copied()
            .max_by(f64::total_cmp)
            .unwrap_or(0.0);
        let total = aggregate.body_ranks.values().sum::<f64>();
        (worst, total)
    };
    let left = score(left);
    let right = score(right);
    left.0
        .total_cmp(&right.0)
        .then_with(|| left.1.total_cmp(&right.1))
}

fn evidence_rank(evidence: &Evidence) -> usize {
    match (&evidence.kind, evidence.quality) {
        (EvidenceKind::PageKey { .. }, _) => 0,
        (EvidenceKind::Identity, SearchTermMatchQuality::Exact) => 1,
        (EvidenceKind::Identity, _) => 2,
        (EvidenceKind::Title, SearchTermMatchQuality::Exact) => 3,
        (EvidenceKind::Title, SearchTermMatchQuality::Prefix) => 4,
        (EvidenceKind::Title, SearchTermMatchQuality::Fuzzy) => 5,
        (EvidenceKind::Property { .. }, SearchTermMatchQuality::Exact) => 6,
        (EvidenceKind::Property { .. }, SearchTermMatchQuality::Prefix) => 7,
        (EvidenceKind::Property { .. }, SearchTermMatchQuality::Fuzzy) => 8,
        (EvidenceKind::Body { .. }, SearchTermMatchQuality::Exact) => 9,
        (EvidenceKind::Body { .. }, _) => 10,
    }
}

fn project_hit(
    index: &PageSearchIndex,
    outcome: SearchOutcome,
) -> Result<LibraryProjectPageSearchHit, StoreError> {
    let page = index
        .pages
        .get(&outcome.aggregate.page_id)
        .ok_or_else(|| corrupt("Page search result disappeared"))?;
    let matches = representative_evidence(&outcome.aggregate.evidence);
    let title_parts = title_parts(page, &outcome.aggregate.evidence);
    let (excerpt, excerpt_parts) = excerpt_parts(page, &outcome.aggregate.evidence);
    Ok(LibraryProjectPageSearchHit {
        project_id: outcome
            .project_id
            .ok_or_else(|| corrupt("Project Page search result has no access context"))?,
        page_id: page.id.clone(),
        page_key: page.page_key.clone(),
        title: page.title.clone(),
        status: page.status,
        priority: page.priority.clone(),
        tags: page.tags.clone(),
        assignee: page.assignee.clone(),
        location_label: page.location_label.clone(),
        title_parts,
        excerpt,
        excerpt_parts,
        matches,
        updated_at: page.updated_at.clone(),
    })
}

fn reference_hit(
    index: &PageSearchIndex,
    outcome: SearchOutcome,
) -> Result<LibraryPageReferenceCandidate, StoreError> {
    let page = index
        .pages
        .get(&outcome.aggregate.page_id)
        .ok_or_else(|| corrupt("Page reference result disappeared"))?;
    let matches = representative_evidence(&outcome.aggregate.evidence);
    let title_parts = title_parts(page, &outcome.aggregate.evidence);
    let (match_excerpt, match_excerpt_parts) = excerpt_parts(page, &outcome.aggregate.evidence);
    let match_source = strongest_source(&outcome.aggregate.evidence);
    Ok(LibraryPageReferenceCandidate {
        page_id: page.id.clone(),
        title: page.title.clone(),
        page_key: page.page_key.clone(),
        status: page.status,
        location_label: page.location_label.clone(),
        match_excerpt,
        match_source,
        title_parts,
        match_excerpt_parts,
        matches,
    })
}

fn agent_hit(
    index: &PageSearchIndex,
    library_id: &str,
    outcome: SearchOutcome,
) -> Result<LibraryAgentSearchResult, StoreError> {
    let page = index
        .pages
        .get(&outcome.aggregate.page_id)
        .ok_or_else(|| corrupt("Agent Page search result disappeared"))?;
    let location = match page.parent_kind.as_str() {
        "library" => LibraryAgentPageLocation::Library {
            library_id: library_id.to_owned(),
        },
        "page" => LibraryAgentPageLocation::Page {
            page_id: page.parent_id.clone(),
        },
        "data_source" => LibraryAgentPageLocation::DataSource {
            data_source_id: page.parent_id.clone(),
        },
        _ => return Err(corrupt("Agent Page search result has an invalid location")),
    };
    Ok(LibraryAgentSearchResult::Page {
        id: page.id.clone(),
        page_key: page.page_key.clone(),
        title: page.title.clone(),
        location,
        matches: representative_evidence(&outcome.aggregate.evidence)
            .into_iter()
            .map(agent_evidence)
            .collect(),
    })
}

struct EvidenceFragment {
    evidence: Evidence,
    terms: BTreeSet<String>,
}

/// Merge per-term evidence before spending the snippet budget. Distinct windows
/// within one long block retain their own text and the same source identity.
fn evidence_fragments(evidence: &[Evidence]) -> Vec<EvidenceFragment> {
    let mut fragments: BTreeMap<(String, String), EvidenceFragment> = BTreeMap::new();
    for item in evidence {
        let key = (evidence_kind_key(&item.kind), join_parts(&item.parts));
        let fragment = fragments.entry(key).or_insert_with(|| EvidenceFragment {
            evidence: item.clone(),
            terms: BTreeSet::new(),
        });
        fragment.terms.insert(item.term.clone());
        fragment.evidence.parts = merge_highlights(&fragment.evidence.parts, &item.parts);
    }
    fragments.into_values().collect()
}

fn is_content_evidence(kind: &EvidenceKind) -> bool {
    matches!(
        kind,
        EvidenceKind::Body { .. } | EvidenceKind::Property { .. }
    )
}

fn selected_content_fragments(evidence: &[Evidence]) -> Vec<Evidence> {
    let title = evidence
        .iter()
        .find(|item| matches!(item.kind, EvidenceKind::Title))
        .map(|item| normalize_search_text(&join_parts(&item.parts)))
        .unwrap_or_default();
    let mut candidates = evidence_fragments(evidence)
        .into_iter()
        .filter(|fragment| is_content_evidence(&fragment.evidence.kind))
        .collect::<Vec<_>>();
    let mut covered = BTreeSet::new();
    let mut sources = HashSet::new();
    let mut selected = Vec::new();
    while selected.len() < MAX_EXCERPT_FRAGMENTS && !candidates.is_empty() {
        let score = |fragment: &EvidenceFragment| {
            let text = normalize_search_text(&join_parts(&fragment.evidence.parts));
            let repeats_title = !text.is_empty() && !title.is_empty() && title.contains(&text);
            (
                !repeats_title,
                fragment.terms.difference(&covered).count(),
                !sources.contains(&evidence_kind_key(&fragment.evidence.kind)),
                fragment.terms.len(),
                std::cmp::Reverse(evidence_rank(&fragment.evidence)),
            )
        };
        // Prefer the first candidate for tied scores; the source/text order is stable.
        let index = (0..candidates.len())
            .max_by(|left, right| {
                score(&candidates[*left])
                    .cmp(&score(&candidates[*right]))
                    .then_with(|| right.cmp(left))
            })
            .expect("nonempty candidates");
        let mut fragment = candidates.remove(index);
        covered.extend(fragment.terms);
        sources.insert(evidence_kind_key(&fragment.evidence.kind));
        fragment.evidence.parts = bounded_fragment_parts(&fragment.evidence.parts);
        selected.push(fragment.evidence);
    }
    selected
}

/// Keep Unicode characters intact and retain context around the first match.
fn bounded_fragment_parts(parts: &[LibraryPageSearchTextPart]) -> Vec<LibraryPageSearchTextPart> {
    let characters = parts
        .iter()
        .flat_map(|part| {
            part.text
                .chars()
                .map(move |character| (character, part.highlighted))
        })
        .collect::<Vec<_>>();
    if characters.len() <= MAX_FRAGMENT_CHARACTERS {
        return parts.to_vec();
    }
    let first_match = characters
        .iter()
        .position(|(_, highlighted)| *highlighted)
        .unwrap_or(0);
    let start = first_match
        .saturating_sub(48)
        .min(characters.len() - MAX_FRAGMENT_CHARACTERS + 2);
    let end = (start + MAX_FRAGMENT_CHARACTERS - 2).min(characters.len());
    let mut bounded = Vec::new();
    if start > 0 {
        push_part(&mut bounded, "…".to_owned(), false);
    }
    for (character, highlighted) in &characters[start..end] {
        push_part(&mut bounded, character.to_string(), *highlighted);
    }
    if end < characters.len() {
        push_part(&mut bounded, "…".to_owned(), false);
    }
    bounded
}

fn representative_evidence(evidence: &[Evidence]) -> Vec<LibraryPageSearchMatch> {
    let metadata = evidence_fragments(evidence)
        .into_iter()
        .filter(|fragment| !is_content_evidence(&fragment.evidence.kind))
        .map(|fragment| fragment.evidence);
    metadata
        .chain(selected_content_fragments(evidence))
        .map(contract_evidence)
        .collect()
}

fn contract_evidence(evidence: Evidence) -> LibraryPageSearchMatch {
    let quality = contract_quality(evidence.quality);
    match evidence.kind {
        EvidenceKind::PageKey {
            page_key,
            is_current,
        } => LibraryPageSearchMatch::PageKey {
            quality,
            page_key,
            is_current,
            parts: evidence.parts,
        },
        EvidenceKind::Identity => LibraryPageSearchMatch::Identity {
            quality,
            parts: evidence.parts,
        },
        EvidenceKind::Title => LibraryPageSearchMatch::Title {
            quality,
            parts: evidence.parts,
        },
        EvidenceKind::Property {
            property_id,
            property_name,
        } => LibraryPageSearchMatch::Property {
            quality,
            property_id,
            property_name,
            parts: evidence.parts,
        },
        EvidenceKind::Body {
            block_id,
            block_type,
        } => LibraryPageSearchMatch::Body {
            quality,
            block_id,
            block_type,
            parts: evidence.parts,
        },
    }
}

fn agent_evidence(evidence: LibraryPageSearchMatch) -> LibraryAgentPageSearchMatch {
    match evidence {
        LibraryPageSearchMatch::PageKey {
            quality,
            page_key,
            is_current,
            ..
        } => LibraryAgentPageSearchMatch::PageKey {
            quality: agent_quality(quality),
            page_key,
            is_current,
        },
        LibraryPageSearchMatch::Identity { quality, parts } => {
            LibraryAgentPageSearchMatch::Identity {
                quality: agent_quality(quality),
                excerpt: join_parts(&parts),
            }
        }
        LibraryPageSearchMatch::Title { quality, parts } => LibraryAgentPageSearchMatch::Title {
            quality: agent_quality(quality),
            excerpt: join_parts(&parts),
        },
        LibraryPageSearchMatch::Property {
            quality,
            property_id,
            property_name,
            parts,
        } => LibraryAgentPageSearchMatch::Property {
            quality: agent_quality(quality),
            property_id,
            property_name,
            excerpt: join_parts(&parts),
        },
        LibraryPageSearchMatch::Body {
            quality,
            block_id,
            block_type,
            parts,
        } => LibraryAgentPageSearchMatch::Body {
            quality: agent_quality(quality),
            block_id,
            block_type,
            excerpt: join_parts(&parts),
        },
    }
}

fn join_parts(parts: &[LibraryPageSearchTextPart]) -> String {
    parts.iter().map(|part| part.text.as_str()).collect()
}

fn title_parts(page: &IndexedPage, evidence: &[Evidence]) -> Vec<LibraryPageSearchTextPart> {
    let tokens = evidence
        .iter()
        .filter(|evidence| matches!(evidence.kind, EvidenceKind::Title))
        .map(|evidence| evidence.matched_token.clone())
        .collect::<Vec<_>>();
    highlight_text(&page.title, &tokens)
}

fn excerpt_parts(
    page: &IndexedPage,
    evidence: &[Evidence],
) -> (Option<String>, Vec<LibraryPageSearchTextPart>) {
    if let Some(parts) = compose_excerpt_parts(evidence) {
        return (Some(join_parts(&parts)), parts);
    }
    if evidence.iter().any(|evidence| {
        matches!(
            evidence.kind,
            EvidenceKind::Title | EvidenceKind::PageKey { .. } | EvidenceKind::Identity
        )
    }) {
        return (Some(page.title.clone()), title_parts(page, evidence));
    }
    if page.preview.is_empty() {
        return (None, Vec::new());
    }
    (
        Some(page.preview.clone()),
        vec![LibraryPageSearchTextPart {
            text: page.preview.clone(),
            highlighted: false,
        }],
    )
}

/// Builds one bounded preview that proves multiple query terms. Evidence for
/// the same source excerpt is merged; terms from different excerpts are shown
/// as separate fragments instead of silently dropping every term but one.
fn compose_excerpt_parts(evidence: &[Evidence]) -> Option<Vec<LibraryPageSearchTextPart>> {
    let selected = selected_content_fragments(evidence);
    if selected.is_empty() {
        return None;
    }
    let mut combined = Vec::new();
    for fragment in selected {
        if !combined.is_empty() {
            push_part(&mut combined, "  ·  ".to_owned(), false);
        }
        for part in fragment.parts {
            push_part(&mut combined, part.text, part.highlighted);
        }
    }
    Some(combined)
}

fn merge_highlights(
    left: &[LibraryPageSearchTextPart],
    right: &[LibraryPageSearchTextPart],
) -> Vec<LibraryPageSearchTextPart> {
    let characters = join_parts(left).chars().collect::<Vec<_>>();
    let mut highlighted = vec![false; characters.len()];
    for parts in [left, right] {
        let mut offset = 0;
        for part in parts {
            let length = part.text.chars().count();
            if part.highlighted {
                highlighted[offset..offset + length].fill(true);
            }
            offset += length;
        }
    }
    let mut merged = Vec::new();
    let mut buffer = String::new();
    let mut state = None;
    for (character, is_highlighted) in characters.into_iter().zip(highlighted) {
        if state.is_some_and(|current| current != is_highlighted) {
            push_part(
                &mut merged,
                std::mem::take(&mut buffer),
                state.unwrap_or(false),
            );
        }
        buffer.push(character);
        state = Some(is_highlighted);
    }
    push_part(&mut merged, buffer, state.unwrap_or(false));
    merged
}

fn strongest_source(evidence: &[Evidence]) -> LibraryPageReferenceMatchSource {
    let Some(strongest) = evidence
        .iter()
        .min_by_key(|evidence| evidence_rank(evidence))
    else {
        return LibraryPageReferenceMatchSource::Recent;
    };
    match strongest.kind {
        EvidenceKind::PageKey { .. } => LibraryPageReferenceMatchSource::PageKey,
        EvidenceKind::Identity | EvidenceKind::Title | EvidenceKind::Property { .. } => {
            LibraryPageReferenceMatchSource::Title
        }
        EvidenceKind::Body { .. } => LibraryPageReferenceMatchSource::Content,
    }
}

fn contract_quality(quality: SearchTermMatchQuality) -> LibraryPageSearchMatchQuality {
    match quality {
        SearchTermMatchQuality::Exact => LibraryPageSearchMatchQuality::Exact,
        SearchTermMatchQuality::Prefix => LibraryPageSearchMatchQuality::Prefix,
        SearchTermMatchQuality::Fuzzy => LibraryPageSearchMatchQuality::Fuzzy,
    }
}

fn agent_quality(quality: LibraryPageSearchMatchQuality) -> LibraryAgentSearchMatchQuality {
    match quality {
        LibraryPageSearchMatchQuality::Exact => LibraryAgentSearchMatchQuality::Exact,
        LibraryPageSearchMatchQuality::Prefix => LibraryAgentSearchMatchQuality::Prefix,
        LibraryPageSearchMatchQuality::Fuzzy => LibraryAgentSearchMatchQuality::Fuzzy,
    }
}

fn page_in_agent_scope(
    index: &PageSearchIndex,
    page: &IndexedPage,
    scope: &LibraryAgentSearchScope,
) -> bool {
    match scope {
        LibraryAgentSearchScope::Library => true,
        LibraryAgentSearchScope::Page { page_id } => &page.id == page_id,
        LibraryAgentSearchScope::DataSource { data_source_id } => terminal_parent(index, page)
            .is_some_and(|(kind, id)| kind == "data_source" && id == data_source_id),
        LibraryAgentSearchScope::Database { database_id } => terminal_parent(index, page)
            .and_then(|(kind, id)| (kind == "data_source").then_some(id))
            .and_then(|data_source_id| index.data_source_databases.get(data_source_id))
            .is_some_and(|candidate| candidate == database_id),
    }
}

fn terminal_parent<'a>(
    index: &'a PageSearchIndex,
    page: &'a IndexedPage,
) -> Option<(&'a str, &'a str)> {
    let mut current = page;
    let mut seen = HashSet::new();
    loop {
        if current.parent_kind != "page" {
            return Some((current.parent_kind.as_str(), current.parent_id.as_str()));
        }
        if !seen.insert(current.id.as_str()) {
            return None;
        }
        current = index.pages.get(&current.parent_id)?;
    }
}

fn validate_project_request(request: &ProjectSearchRequest<'_>) -> Result<(), StoreError> {
    validate_project_ids(request.project_ids)?;
    validate_filters(request.filters)?;
    if request.recent_page_ids.len() > MAX_RECENT_HINTS {
        return Err(invalid("Page search has too many recent Page hints"));
    }
    validate_unique_identities(request.recent_page_ids, "Page search recent Page")?;
    if let Some(preferred) = request.preferred_project_id
        && !request
            .project_ids
            .iter()
            .any(|project_id| project_id == preferred)
    {
        return Err(invalid(
            "Page search preferred Project is outside its scope",
        ));
    }
    Ok(())
}

fn validate_project_ids(project_ids: &[String]) -> Result<(), StoreError> {
    if project_ids.is_empty() || project_ids.len() > MAX_PROJECT_SCOPES {
        return Err(invalid("Page search Project scope is out of range"));
    }
    let mut unique = HashSet::new();
    for project_id in project_ids {
        if project_id.is_empty()
            || project_id.len() > MAX_IDENTITY_BYTES
            || project_id.trim() != project_id
        {
            return Err(invalid("Page search Project identity is invalid"));
        }
        if !unique.insert(project_id) {
            return Err(invalid("Page search repeats a Project scope"));
        }
    }
    Ok(())
}

fn validate_filters(filters: Option<&LibraryProjectPageSearchFilters>) -> Result<(), StoreError> {
    let Some(filters) = filters else {
        return Ok(());
    };
    if filters
        .statuses
        .as_ref()
        .is_some_and(|statuses| statuses.len() > MAX_FILTER_VALUES)
        || filters
            .priorities
            .as_ref()
            .is_some_and(|priorities| priorities.len() > MAX_FILTER_VALUES)
        || filters.tags.len() > MAX_FILTER_VALUES
        || filters.assignees.len() > MAX_FILTER_VALUES
    {
        return Err(invalid("Page search filter exceeds its value bound"));
    }
    if let Some(statuses) = filters.statuses.as_ref() {
        let mut unique = Vec::new();
        for status in statuses {
            if unique.contains(status) {
                return Err(invalid("Page search repeats a status filter"));
            }
            unique.push(*status);
        }
    }
    if let Some(priorities) = filters.priorities.as_ref() {
        let allowed = ["p0-critical", "p1-high", "p2-medium", "p3-low"];
        validate_unique_identities(priorities, "Page search priority")?;
        if priorities
            .iter()
            .any(|priority| !allowed.contains(&priority.as_str()))
        {
            return Err(invalid("Page search priority filter is invalid"));
        }
    }
    let mut tag_identities = HashSet::new();
    for tag in &filters.tags {
        for (value, label) in [
            (&tag.data_source_id, "data source"),
            (&tag.property_id, "Property"),
            (&tag.option_id, "option"),
        ] {
            validate_identity(value, &format!("Page search tag {label}"))?;
        }
        if !tag_identities.insert(filter_identity(tag)) {
            return Err(invalid("Page search repeats a tag filter"));
        }
    }
    validate_unique_identities(&filters.assignees, "Page search assignee")?;
    Ok(())
}

fn validate_unique_identities(values: &[String], label: &str) -> Result<(), StoreError> {
    let mut unique = HashSet::new();
    for value in values {
        validate_identity(value, label)?;
        if !unique.insert(value) {
            return Err(invalid(&format!("{label} filter is repeated")));
        }
    }
    Ok(())
}

fn validate_identity(value: &str, label: &str) -> Result<(), StoreError> {
    if value.is_empty() || value.len() > MAX_IDENTITY_BYTES || value.trim() != value {
        return Err(invalid(&format!("{label} identity is invalid")));
    }
    Ok(())
}

fn normalize_query(query: &str) -> Result<String, StoreError> {
    if query.len() > MAX_QUERY_BYTES {
        return Err(invalid("Page search query exceeds its UTF-8 byte bound"));
    }
    Ok(normalize_search_text(query))
}

fn unique_terms(query: &str) -> Result<Vec<String>, StoreError> {
    let mut terms = Vec::new();
    for term in search_tokens(query) {
        if !terms.contains(&term) {
            terms.push(term);
        }
    }
    if terms.len() > MAX_QUERY_TERMS {
        return Err(invalid("Page search query has too many terms"));
    }
    Ok(terms)
}

fn result_limit(limit: Option<u32>) -> Result<usize, StoreError> {
    let limit = usize::try_from(limit.unwrap_or(20))
        .map_err(|_| invalid("Page search limit is invalid"))?;
    if limit == 0 || limit > MAX_PAGE_RESULTS {
        return Err(invalid("Page search limit is out of range"));
    }
    Ok(limit)
}

fn preferred_projects(project_ids: &[String], preferred: Option<&str>) -> Vec<String> {
    let mut projects = project_ids.to_vec();
    if let Some(preferred) = preferred
        && let Some(index) = projects
            .iter()
            .position(|project_id| project_id == preferred)
    {
        let project = projects.remove(index);
        projects.insert(0, project);
    }
    projects
}

fn invalid(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message, false)
}

fn corrupt(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message, false)
}

fn internal(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::Internal, message, false)
}

#[cfg(test)]
mod tests {
    use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

    use nodex_core_contracts::library::{
        LibraryPageSearchMatch, LibraryPageSearchTagMode, LibraryPageWorkflowStatus,
        LibraryProjectPageSearchFilters,
    };
    use nodex_page_search_kernel::MetadataSearchIndex;
    use rusqlite::{Connection, params};
    use tempfile::tempdir;

    use crate::infrastructure::store::SqliteStoreKernel;

    use super::{
        Aggregate, Evidence, EvidenceKind, IndexedPage, PAGE_BODY_SEARCH_SQL, PageSearchIndex,
        ProjectSearchRequest, SearchTermMatchQuality, aggregate_rank, compare_body_ranks,
        highlight_text, rank_project_outcomes, search_projects,
    };

    #[test]
    fn page_body_search_is_fts_driven_without_planner_statistics() {
        let directory = tempdir().expect("Store directory");
        let kernel = SqliteStoreKernel::open_test(directory.path()).expect("current Store");
        let plan = kernel
            .writer()
            .call(|connection| {
                connection.execute("DELETE FROM sqlite_stat1", [])?;
                connection.execute_batch("ANALYZE sqlite_schema")?;
                let mut statement =
                    connection.prepare(&format!("EXPLAIN QUERY PLAN {PAGE_BODY_SEARCH_SQL}"))?;
                let details = statement
                    .query_map(params!["\"needle\"*", "library:test", 20_001_i64], |row| {
                        row.get::<_, String>(3)
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(details)
            })
            .expect("Page search query plan");
        let fts_loop = plan
            .iter()
            .position(|detail| detail.contains("block_search_units_fts VIRTUAL TABLE"))
            .expect("FTS loop");
        let unit_loop = plan
            .iter()
            .position(|detail| detail.contains("unit USING INTEGER PRIMARY KEY"))
            .expect("search-unit rowid loop");

        assert!(
            fts_loop < unit_loop,
            "query plan was not FTS-driven: {plan:?}"
        );
    }

    #[test]
    fn highlight_parts_preserve_original_unicode_text() {
        assert_eq!(
            highlight_text("讨论 Canonical ✅", &["canonical".to_owned()]),
            vec![
                nodex_core_contracts::library::LibraryPageSearchTextPart {
                    text: "讨论 ".to_owned(),
                    highlighted: false,
                },
                nodex_core_contracts::library::LibraryPageSearchTextPart {
                    text: "Canonical".to_owned(),
                    highlighted: true,
                },
                nodex_core_contracts::library::LibraryPageSearchTextPart {
                    text: " ✅".to_owned(),
                    highlighted: false,
                },
            ],
        );
    }

    #[test]
    fn project_search_keeps_multi_term_body_evidence_visible() {
        let connection = Connection::open_in_memory().expect("search database");
        connection
            .execute_batch(
                "CREATE TABLE documents(\
                   id TEXT NOT NULL, library_id TEXT NOT NULL, readiness TEXT NOT NULL,\
                   generation INTEGER NOT NULL, head_seq INTEGER NOT NULL\
                 );\
                 CREATE TABLE blocks(\
                   id TEXT NOT NULL, library_id TEXT NOT NULL, type TEXT NOT NULL,\
                   lifecycle TEXT NOT NULL\
                 );\
                 CREATE TABLE block_search_units(\
                   rowid INTEGER PRIMARY KEY, library_id TEXT NOT NULL, block_id TEXT NOT NULL,\
                   owner_block_id TEXT NOT NULL, document_id TEXT, document_generation INTEGER,\
                   projected_seq INTEGER, source_kind TEXT NOT NULL, text TEXT NOT NULL\
                 );\
                 CREATE VIRTUAL TABLE block_search_units_fts USING fts5(\
                   text, content='block_search_units', content_rowid='rowid'\
                 );\
                 INSERT INTO documents VALUES(\
                   'document:multi-term', 'library:test', 'ready', 1, 1\
                 ), (\
                   'document:split-terms', 'library:test', 'ready', 1, 1\
                 );\
                 INSERT INTO blocks VALUES\
                   ('page:multi-term', 'library:test', 'page', 'active'),\
                   ('block:multi-term', 'library:test', 'paragraph', 'active'),\
                   ('page:split-terms', 'library:test', 'page', 'active'),\
                   ('block:codex', 'library:test', 'paragraph', 'active'),\
                   ('block:electron', 'library:test', 'paragraph', 'active');\
                 INSERT INTO block_search_units VALUES(\
                   1, 'library:test', 'block:multi-term', 'page:multi-term',\
                   'document:multi-term', 1, 1, 'document_block',\
                   'Run codex with electron'\
                 ), (\
                   2, 'library:test', 'block:codex', 'page:split-terms',\
                   'document:split-terms', 1, 1, 'document_block',\
                   'Codex runtime details'\
                 ), (\
                   3, 'library:test', 'block:electron', 'page:split-terms',\
                   'document:split-terms', 1, 1, 'document_block',\
                   'Electron shell details'\
                 );\
                 INSERT INTO block_search_units_fts(rowid, text) VALUES\
                   (1, 'Run codex with electron'),\
                   (2, 'Codex runtime details'),\
                   (3, 'Electron shell details');",
            )
            .expect("body search fixture");
        let indexed_page = |page_id: &str| IndexedPage {
            id: page_id.to_owned(),
            title: "Search architecture".to_owned(),
            preview: String::new(),
            lifecycle: "active".to_owned(),
            parent_kind: "library".to_owned(),
            parent_id: "library:test".to_owned(),
            updated_at: "2026-08-19T00:00:00.000Z".to_owned(),
            properties: Vec::new(),
            status: None,
            priority: None,
            tags: Vec::new(),
            assignee: None,
            page_key: None,
            location_label: "Pages".to_owned(),
            data_source_ids: BTreeSet::new(),
            authorized_project_ids: BTreeSet::from(["project:test".to_owned()]),
        };
        let index = PageSearchIndex {
            pages: BTreeMap::from([
                (
                    "page:multi-term".to_owned(),
                    indexed_page("page:multi-term"),
                ),
                (
                    "page:split-terms".to_owned(),
                    indexed_page("page:split-terms"),
                ),
            ]),
            data_source_databases: HashMap::new(),
            metadata_index: MetadataSearchIndex::default(),
        };
        let project_ids = vec!["project:test".to_owned()];
        let hits = search_projects(
            &connection,
            &index,
            "library:test",
            ProjectSearchRequest {
                project_ids: &project_ids,
                query: "codex electron",
                filters: None,
                preferred_project_id: None,
                recent_page_ids: &[],
                limit: Some(10),
            },
        )
        .expect("Project Page search");
        assert_eq!(hits.len(), 2);
        let hit = hits
            .iter()
            .find(|hit| hit.page_id == "page:multi-term")
            .expect("same-block multi-term hit");

        let highlighted = hit
            .excerpt_parts
            .iter()
            .filter(|part| part.highlighted)
            .map(|part| part.text.as_str())
            .collect::<Vec<_>>();
        assert_eq!(hit.excerpt.as_deref(), Some("Run codex with electron"));
        assert_eq!(highlighted, ["codex", "electron"]);
        assert_eq!(
            hit.matches
                .iter()
                .filter(|evidence| matches!(evidence, LibraryPageSearchMatch::Body { .. }))
                .count(),
            1
        );

        let split_hit = hits
            .iter()
            .find(|hit| hit.page_id == "page:split-terms")
            .expect("cross-block multi-term hit");
        let split_highlights = split_hit
            .excerpt_parts
            .iter()
            .filter(|part| part.highlighted)
            .map(|part| part.text.to_lowercase())
            .collect::<Vec<_>>();
        assert_eq!(split_highlights, ["codex", "electron"]);
        assert!(
            split_hit
                .excerpt
                .as_deref()
                .is_some_and(|excerpt| excerpt.contains(" · "))
        );
    }

    fn snippet(term: &str, text: &str, kind: EvidenceKind) -> Evidence {
        Evidence {
            term: term.to_owned(),
            matched_token: term.to_owned(),
            kind,
            quality: SearchTermMatchQuality::Exact,
            edit_distance: 0,
            parts: highlight_text(text, &[term.to_owned()]),
        }
    }

    #[test]
    fn representative_snippets_merge_titles_and_preserve_distinct_sources_and_aliases() {
        let mut evidence = ["cedar", "release", "plan"]
            .into_iter()
            .map(|term| snippet(term, "Cedar release plan", EvidenceKind::Title))
            .collect::<Vec<_>>();
        evidence.push(snippet(
            "cedar",
            "Cedar release",
            EvidenceKind::Body {
                block_id: "heading".into(),
                block_type: "heading".into(),
            },
        ));
        evidence.push(snippet(
            "release",
            "Release date: Friday.",
            EvidenceKind::Body {
                block_id: "date".into(),
                block_type: "paragraph".into(),
            },
        ));
        evidence.push(snippet(
            "cedar",
            "Tracking code: CEDAR-42.",
            EvidenceKind::Body {
                block_id: "code".into(),
                block_type: "paragraph".into(),
            },
        ));
        evidence.push(snippet(
            "plan",
            "Current plan",
            EvidenceKind::Property {
                property_id: "status".into(),
                property_name: "Status".into(),
            },
        ));
        evidence.push(snippet(
            "old-1",
            "OLD-1",
            EvidenceKind::PageKey {
                page_key: "OLD-1".into(),
                is_current: false,
            },
        ));
        let matches = super::representative_evidence(&evidence);
        assert_eq!(matches.len(), 5);
        assert_eq!(
            matches
                .iter()
                .filter(|item| matches!(item, LibraryPageSearchMatch::Title { .. }))
                .count(),
            1
        );
        assert!(matches.iter().any(|item| matches!(item, LibraryPageSearchMatch::PageKey { page_key, is_current: false, .. } if page_key == "OLD-1")));
        assert!(matches.iter().any(|item| matches!(item, LibraryPageSearchMatch::Property { property_id, .. } if property_id == "status")));
        let blocks = matches
            .iter()
            .filter_map(|item| match item {
                LibraryPageSearchMatch::Body { block_id, .. } => Some(block_id.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(blocks.len(), 2);
        assert!(blocks.contains(&"date") && blocks.contains(&"code"));
        let forward = super::compose_excerpt_parts(&evidence);
        evidence.reverse();
        assert_eq!(super::compose_excerpt_parts(&evidence), forward);
    }

    #[test]
    fn long_block_windows_keep_separate_matches_with_bounded_unicode_context() {
        let kind = EvidenceKind::Body {
            block_id: "long-block".into(),
            block_type: "paragraph".into(),
        };
        let text = format!("{} needle {}", "前".repeat(300), "后".repeat(300));
        let evidence = vec![
            snippet("needle", &text, kind.clone()),
            snippet("second", "A distant second match", kind),
        ];
        let matches = super::representative_evidence(&evidence);
        assert_eq!(matches.len(), 2);
        let snippets = matches
            .iter()
            .map(|item| match item {
                LibraryPageSearchMatch::Body {
                    block_id, parts, ..
                } => {
                    assert_eq!(block_id, "long-block");
                    super::join_parts(parts)
                }
                _ => panic!("expected body evidence"),
            })
            .collect::<Vec<_>>();
        assert!(
            snippets
                .iter()
                .all(|text| text.chars().count() <= super::MAX_FRAGMENT_CHARACTERS)
        );
        let bounded = snippets
            .iter()
            .find(|text| text.contains("needle"))
            .expect("matching term retained");
        assert!(bounded.starts_with('…') && bounded.ends_with('…'));
        assert!(snippets.iter().any(|text| text.contains("second")));
    }

    #[test]
    fn weakest_body_term_contributes_to_multi_term_rank() {
        let aggregate = |page_id: &str, codex: f64, electron: f64| Aggregate {
            page_id: page_id.to_owned(),
            terms: HashSet::from(["codex".to_owned(), "electron".to_owned()]),
            evidence: Vec::new(),
            body_ranks: HashMap::from([
                ("codex".to_owned(), codex),
                ("electron".to_owned(), electron),
            ]),
        };
        let one_dominant_term = aggregate("page:dominant", -10.0, -1.0);
        let balanced_terms = aggregate("page:balanced", -6.0, -6.0);

        assert_eq!(
            compare_body_ranks(&balanced_terms, &one_dominant_term),
            std::cmp::Ordering::Less
        );
    }

    #[test]
    fn strongest_evidence_for_each_term_determines_rank() {
        let evidence = |kind, quality| Evidence {
            term: "canonical".to_owned(),
            matched_token: "canonical".to_owned(),
            kind,
            quality,
            edit_distance: 0,
            parts: Vec::new(),
        };
        let title_and_body = Aggregate {
            page_id: "page:title".to_owned(),
            terms: HashSet::from(["canonical".to_owned()]),
            evidence: vec![
                evidence(EvidenceKind::Title, SearchTermMatchQuality::Exact),
                evidence(
                    EvidenceKind::Body {
                        block_id: "block:body".to_owned(),
                        block_type: "text".to_owned(),
                    },
                    SearchTermMatchQuality::Prefix,
                ),
            ],
            body_ranks: HashMap::from([("canonical".to_owned(), -1.0)]),
        };
        let property_only = Aggregate {
            page_id: "page:property".to_owned(),
            terms: HashSet::from(["canonical".to_owned()]),
            evidence: vec![evidence(
                EvidenceKind::Property {
                    property_id: "summary".to_owned(),
                    property_name: "Summary".to_owned(),
                },
                SearchTermMatchQuality::Exact,
            )],
            body_ranks: HashMap::new(),
        };

        assert!(aggregate_rank(&title_and_body) < aggregate_rank(&property_only));
    }

    #[test]
    fn authorization_and_filters_run_before_top_k_without_a_page_candidate_cliff() {
        let mut pages = BTreeMap::new();
        let mut aggregates = Vec::new();
        for index in 0..=6_000 {
            let page_id = format!("page:{index:04}");
            let eligible = index == 6_000;
            pages.insert(
                page_id.clone(),
                IndexedPage {
                    id: page_id.clone(),
                    title: "Needle".to_owned(),
                    preview: String::new(),
                    lifecycle: "active".to_owned(),
                    parent_kind: "library".to_owned(),
                    parent_id: "library:test".to_owned(),
                    updated_at: format!("2026-08-17T00:{:02}:00.000Z", index % 60),
                    properties: Vec::new(),
                    status: Some(if index >= 3_000 {
                        if eligible {
                            LibraryPageWorkflowStatus::Ship
                        } else {
                            LibraryPageWorkflowStatus::Plan
                        }
                    } else {
                        LibraryPageWorkflowStatus::Ship
                    }),
                    priority: None,
                    tags: Vec::new(),
                    assignee: None,
                    page_key: None,
                    location_label: "Pages".to_owned(),
                    data_source_ids: BTreeSet::new(),
                    authorized_project_ids: if index >= 3_000 {
                        BTreeSet::from(["project:test".to_owned()])
                    } else {
                        BTreeSet::new()
                    },
                },
            );
            aggregates.push(Aggregate {
                page_id,
                terms: HashSet::from(["needle".to_owned()]),
                evidence: vec![Evidence {
                    term: "needle".to_owned(),
                    matched_token: "needle".to_owned(),
                    kind: EvidenceKind::Title,
                    quality: SearchTermMatchQuality::Exact,
                    edit_distance: 0,
                    parts: Vec::new(),
                }],
                body_ranks: HashMap::new(),
            });
        }
        let index = PageSearchIndex {
            pages,
            data_source_databases: HashMap::new(),
            metadata_index: MetadataSearchIndex::default(),
        };
        let project_ids = vec!["project:test".to_owned()];
        let filters = LibraryProjectPageSearchFilters {
            statuses: Some(vec![LibraryPageWorkflowStatus::Ship]),
            priorities: None,
            include_empty_priority: true,
            tags: Vec::new(),
            tag_mode: LibraryPageSearchTagMode::Any,
            assignees: Vec::new(),
        };
        let outcomes = rank_project_outcomes(
            &index,
            aggregates,
            &ProjectSearchRequest {
                project_ids: &project_ids,
                query: "needle",
                filters: Some(&filters),
                preferred_project_id: Some("project:test"),
                recent_page_ids: &[],
                limit: Some(1),
            },
        );

        assert_eq!(outcomes.len(), 1);
        assert_eq!(outcomes[0].aggregate.page_id, "page:6000");
    }
}
