mod view;

pub(crate) use view::{MAX_VIEW_MATCHES, ViewPageMatches};

use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::{Arc, Mutex};

use nodex_core_contracts::BoundModuleContext;
use nodex_core_contracts::library::{
    LibraryAgentPageLocation, LibraryAgentPageSearchMatch, LibraryAgentSearchMatchQuality,
    LibraryAgentSearchResult, LibraryAgentSearchScope, LibraryPageReferenceCandidate,
    LibraryPageReferenceMatchSource, LibraryPageSearchMatch, LibraryPageSearchMatchQuality,
    LibraryPageSearchMetadataDocument, LibraryPageSearchMetadataProperty, LibraryPageSearchOption,
    LibraryPageSearchTextPart, LibraryPageWorkflowStatus, LibraryPageWorkflowStatusValue,
    LibraryProjectPageSearchHit, LibrarySearchCoverage,
};
use nodex_search_kernel::{
    MetadataDocument as KernelDocument, MetadataMatchSource as KernelMatchSource,
    MetadataProperty as KernelProperty, MetadataSearchIndex, QueryWord,
    SearchOption as KernelOption, TextPart as KernelTextPart,
    WorkflowStatus as KernelWorkflowStatus, page_query_words,
};
use rusqlite::Connection;
use serde_json::Value;

use crate::database::{self, current_page_keys_in_library, resolve_page_key_matches_in_library};
use crate::domain::page_key::is_explicit_page_key_search;
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

use super::block_search;
use super::search_match::{SearchTermMatchQuality, normalize_search_text};

const MAX_PROJECT_SCOPES: usize = 256;
const MAX_RECENT_HINTS: usize = 100;
const MAX_PAGE_RESULTS: usize = 100;
const MAX_IDENTITY_BYTES: usize = 512;
const MAX_EXCERPT_FRAGMENTS: usize = 3;
const MAX_FRAGMENT_CHARACTERS: usize = 240;
const CONTEXT_PROPERTY_PREFIX: &str = "\0search-context:";

pub(super) struct SearchResults<T> {
    pub items: Vec<T>,
    pub truncated: bool,
    pub coverage: LibrarySearchCoverage,
}

#[derive(Clone, Default)]
pub(crate) struct PageSearchIndexRegistry {
    state: Arc<Mutex<Option<CachedIndex>>>,
    view_metadata: Arc<view::ViewMetadataCache>,
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
    status: Option<LibraryPageWorkflowStatusValue>,
    priority: Option<String>,
    tags: Vec<LibraryPageSearchOption>,
    assignee: Option<nodex_core_contracts::library::PageAssignee>,
    owner: Option<String>,
    project_ids: BTreeSet<String>,
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
    /// The Database and Library share View metadata. Ranked snapshots belong
    /// to the Library Module that reads them.
    pub(crate) fn with_shared_view_metadata(&self) -> Self {
        Self {
            view_metadata: Arc::clone(&self.view_metadata),
            ..Self::default()
        }
    }

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
                owner: None,
                project_ids: BTreeSet::new(),
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
            page.status =
                workflow_status(value.as_str()).map(|option_id| LibraryPageWorkflowStatusValue {
                    option_id,
                    label: text.clone(),
                });
        } else if owns_membership && property_id == "priority" {
            page.priority = value.as_str().map(ToOwned::to_owned);
        } else if owns_membership && property_id == "tags" {
            page.tags = options.clone();
        }
        page.properties.push(IndexedProperty {
            property_id,
            property_name,
            text,
        });
    }

    let members = super::members::list(connection, library_id)?;
    let mut statement = connection.prepare(
        "SELECT block_id,value_json FROM block_properties WHERE library_id=?1 AND property_key='work'",
    )?;
    let rows = statement.query_map([library_id], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    for row in rows {
        let (id, encoded) = row?;
        let Some(page) = pages.get_mut(&id) else {
            continue;
        };
        let work = super::parse_page_work(
            &serde_json::from_str::<Value>(&encoded)
                .map_err(|_| corrupt("Page work JSON is invalid"))?,
        )?;
        page.owner = Some(work.owner.clone());
        page.assignee = work.assignee.clone();
        let label = |assignment: &nodex_core_contracts::library::PageAssignee| match assignment {
            nodex_core_contracts::library::PageAssignee::Member { member_id } => members
                .iter()
                .find(|member| &member.id == member_id)
                .map(|member| member.display_name.clone())
                .unwrap_or_default(),
            nodex_core_contracts::library::PageAssignee::Agent {
                instance_id, model, ..
            } => format!("{instance_id} {model}"),
        };
        for (id, name, assignment) in [
            (
                "owner",
                "Owner",
                Some(nodex_core_contracts::library::PageAssignee::Member {
                    member_id: work.owner,
                }),
            ),
            ("assignee", "Assignee", work.assignee),
        ] {
            let Some(assignment) = assignment else {
                continue;
            };
            page.properties.push(IndexedProperty {
                property_id: id.into(),
                property_name: name.into(),
                text: label(&assignment),
            });
        }
    }
    let data_source_databases = connection
        .prepare("SELECT id, home_database_block_id FROM data_sources WHERE library_id = ?1")?
        .query_map([library_id], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<HashMap<_, _>>>()?;
    populate_project_associations(connection, library_id, &data_source_databases, &mut pages)?;
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
    let mut context = read_search_context(connection, library_id)?;
    let property_names = read_search_property_names(connection, library_id)?;
    let metadata_documents = pages
        .values()
        .map(|page| {
            let mut context = context.remove(&page.id).unwrap_or_default();
            context.extend(
                page.data_source_ids
                    .iter()
                    .filter_map(|source| property_names.get(source))
                    .flatten()
                    .cloned(),
            );
            context.sort_unstable();
            context.dedup();
            let context = context
                .into_iter()
                .enumerate()
                .map(|(index, text)| KernelProperty {
                    property_id: format!("{CONTEXT_PROPERTY_PREFIX}{index}"),
                    property_name: String::new(),
                    text,
                });
            KernelDocument {
                page_id: page.id.clone(),
                page_key: page.page_key.clone(),
                title: page.title.clone(),
                preview: page.preview.clone(),
                status: page
                    .status
                    .as_ref()
                    .map(|status| kernel_workflow_status(status.option_id)),
                priority: page.priority.clone(),
                tags: page.tags.iter().map(kernel_option).collect(),
                assignee: page.assignee.clone(),
                owner: page.owner.clone(),
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
                    .chain(context)
                    .collect(),
                project_ids: page.project_ids.iter().cloned().collect(),
                data_source_ids: page.data_source_ids.iter().cloned().collect(),
            }
        })
        .collect::<Vec<_>>();
    Ok(PageSearchIndex {
        pages,
        data_source_databases,
        metadata_index: MetadataSearchIndex::new(metadata_documents),
    })
}

// Resolve mutable display names from their current authority. Renaming a
// mentioned Page or File then invalidates the usual commit-fenced index,
// without rewriting any of the referencing Documents.
fn read_search_context(
    connection: &Connection,
    library_id: &str,
) -> Result<HashMap<String, Vec<String>>, StoreError> {
    let mut statement = connection.prepare(
        "SELECT entry.page_id, entry.logical_path
         FROM page_file_entries entry
         JOIN library_files file ON file.file_id = entry.file_id
         WHERE entry.library_id = ?1 AND file.lifecycle = 'live'
         UNION
         SELECT asset.owner_block_id, file.default_name
         FROM block_asset_refs asset
         JOIN library_files file ON file.file_id = asset.file_id
         WHERE asset.library_id = ?1 AND file.lifecycle = 'live'
         UNION
         SELECT reference.source_owner_block_id, target.title
         FROM document_page_references reference
         JOIN page_read_model target ON target.page_block_id = reference.target_page_id
         WHERE target.library_id = ?1 AND target.lifecycle <> 'deleted'
           AND reference.presentation IN ('mention', 'reference_block')",
    )?;
    let mut context = HashMap::<String, Vec<String>>::new();
    for row in statement.query_map([library_id], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })? {
        let (page_id, text) = row?;
        if !text.trim().is_empty() {
            context.entry(page_id).or_default().push(text);
        }
    }
    Ok(context)
}

/// Schema names are shared across every Page in a Data Source. Read each
/// name once instead of joining the entire schema to every active membership.
fn read_search_property_names(
    connection: &Connection,
    library_id: &str,
) -> Result<HashMap<String, Vec<String>>, StoreError> {
    let mut statement = connection.prepare(
        "SELECT property.data_source_id, property.name
         FROM data_source_properties property
         JOIN data_sources source ON source.id = property.data_source_id
         WHERE source.library_id = ?1 AND property.lifecycle = 'active'",
    )?;
    let mut names = HashMap::<String, Vec<String>>::new();
    for row in statement.query_map([library_id], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })? {
        let (source, name) = row?;
        if !name.trim().is_empty() {
            names.entry(source).or_default().push(name);
        }
    }
    Ok(names)
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
        LibraryPageWorkflowStatus::Doing => KernelWorkflowStatus::Doing,
        LibraryPageWorkflowStatus::Review => KernelWorkflowStatus::Review,
        LibraryPageWorkflowStatus::Done => KernelWorkflowStatus::Done,
        LibraryPageWorkflowStatus::Canceled => KernelWorkflowStatus::Canceled,
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

/// Records physical Project associations for explicitly scoped search and facets.
fn populate_project_associations(
    connection: &Connection,
    library_id: &str,
    data_source_databases: &HashMap<String, String>,
    pages: &mut BTreeMap<String, IndexedPage>,
) -> Result<(), StoreError> {
    let mut database_projects = HashMap::<String, BTreeSet<String>>::new();
    for (project_id, database_id) in connection.prepare("SELECT id, database_block_id FROM projects WHERE library_id = ?1 AND lifecycle <> 'deleted' ORDER BY id")?.query_map([library_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()? {
        if let Some(database_id) = database_id { database_projects.entry(database_id).or_default().insert(project_id); }
    }
    for page_id in pages.keys().cloned().collect::<Vec<_>>() {
        let Some((_, Some(database_id))) =
            page_access_coordinates(pages, data_source_databases, library_id, &page_id)
        else {
            continue;
        };
        if let Some(page) = pages.get_mut(&page_id) {
            page.project_ids = database_projects
                .get(&database_id)
                .cloned()
                .unwrap_or_default();
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
        Some("doing") => Some(LibraryPageWorkflowStatus::Doing),
        Some("review") => Some(LibraryPageWorkflowStatus::Review),
        Some("done") => Some(LibraryPageWorkflowStatus::Done),
        Some("canceled") => Some(LibraryPageWorkflowStatus::Canceled),
        _ => None,
    }
}

#[derive(Clone)]
struct Evidence {
    term: String,
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
    Context,
    Body {
        block_id: String,
        block_type: String,
        combined: bool,
    },
}

#[derive(Clone, Default)]
struct Aggregate {
    page_id: String,
    terms: HashMap<String, (usize, usize)>,
    evidence: Vec<Evidence>,
    body_ranks: Vec<f64>,
    ordered: bool,
    indexed_body: Vec<(usize, String, block_search::IndexedHit)>,
    combined_body: Option<i64>,
}

struct SearchOutcome {
    aggregate: Aggregate,
    project_id: Option<String>,
    recent_index: Option<usize>,
}

pub(super) struct ProjectSearchRequest<'a> {
    pub project_filter_ids: Option<&'a [String]>,
    pub query: &'a str,
    pub instant: bool,
    pub exclude_page_ids: &'a [String],
    pub data_source_ids: Option<&'a [String]>,
    pub preferred_project_id: Option<&'a str>,
    pub recent_page_ids: &'a [String],
    pub limit: Option<u32>,
}

pub(super) struct AgentSearchRequest<'a> {
    pub query: &'a str,
    pub scope: &'a LibraryAgentSearchScope,
    pub include_archived: bool,
}

pub(super) fn search_projects(
    connection: &Connection,
    index: &PageSearchIndex,
    library_id: &str,
    request: ProjectSearchRequest<'_>,
) -> Result<SearchResults<LibraryProjectPageSearchHit>, StoreError> {
    validate_project_request(&request)?;
    let words = page_query_words(request.query).map_err(|message| invalid(&message))?;
    let results = search_index(
        connection,
        index,
        library_id,
        request.query,
        &words,
        IndexSearchOptions {
            in_scope: |page: &IndexedPage| project_search_scope(page, &request),
            exclude_body_page_id: None,
            instant: request.instant,
        },
    )?;
    let outcomes = rank_project_outcomes(index, results.items, &request);
    let limit = result_limit(request.limit)?;
    let truncated =
        results.truncated || (!request.query.trim().is_empty() && outcomes.len() > limit);
    let items = outcomes
        .into_iter()
        .take(limit)
        .map(|outcome| project_hit(index, reveal_body(connection, &words, outcome)?))
        .collect::<Result<_, _>>()?;
    Ok(SearchResults {
        items,
        truncated,
        coverage: results.coverage,
    })
}

pub(super) fn search_project_blocks(
    connection: &Connection,
    index: &PageSearchIndex,
    library_id: &str,
    query: &str,
    project_id: Option<&str>,
    preferred_project_id: Option<&str>,
    limit: Option<u32>,
) -> Result<SearchResults<nodex_core_contracts::library::LibraryProjectBlockSearchHit>, StoreError>
{
    use nodex_core_contracts::library::{LibraryProjectBlockSearchHit, LibrarySearchSourceKind};

    let words = page_query_words(query).map_err(|message| invalid(&message))?;
    let limit = result_limit(limit)?;
    if words.is_empty() {
        return Ok(SearchResults {
            items: vec![],
            truncated: false,
            coverage: LibrarySearchCoverage::Complete,
        });
    }
    let page_ids = index
        .pages
        .values()
        .filter(|page| project_id.is_none_or(|id| page.project_ids.contains(id)))
        .map(|page| page.id.as_str())
        .collect::<Vec<_>>();
    let (ranked, raw) = super::agent_search::ranked_blocks(
        connection,
        &words,
        block_search::Scope {
            library_id,
            page_ids: &page_ids,
            include_titles: true,
            block_types: None,
        },
        |page_id| {
            let page = &index.pages[page_id];
            (
                page.lifecycle != "active",
                preferred_project_id.is_none_or(|id| !page.project_ids.contains(id)),
            )
        },
    )?;
    let truncated = raw.truncated || ranked.len() > limit;
    let mut items = Vec::new();
    for (block_id, terms) in ranked.into_iter().take(limit) {
        let Some(super::agent_search::BlockWindows { first, windows }) =
            super::agent_search::block_windows(connection, &words, &terms)?
        else {
            continue;
        };
        let page = &index.pages[&first.page_id];
        let mut parts = Vec::new();
        for window in windows.into_iter().take(3) {
            if !parts.is_empty() {
                parts.push(LibraryPageSearchTextPart {
                    text: "  ·  ".into(),
                    highlighted: false,
                });
            }
            parts.extend(window);
        }
        items.push(LibraryProjectBlockSearchHit {
            ordered: raw.ordered.contains(&block_id),
            block_id,
            page_id: first.page_id,
            title: page.title.clone(),
            project_id: project_id
                .or(preferred_project_id)
                .filter(|id| page.project_ids.contains(*id))
                .map(str::to_owned)
                .or_else(|| page.project_ids.iter().next().cloned()),
            location_label: page.location_label.clone(),
            archived: page.lifecycle != "active",
            text_rank: terms
                .iter()
                .map(|(_, hit)| hit.field_rank as u32)
                .max()
                .unwrap_or(0),
            source: if first.source == "document_title" {
                LibrarySearchSourceKind::DocumentTitle
            } else {
                LibrarySearchSourceKind::DocumentBlock
            },
            parts,
        });
    }
    Ok(SearchResults {
        items,
        truncated,
        coverage: raw.coverage,
    })
}

fn project_search_scope(page: &IndexedPage, request: &ProjectSearchRequest<'_>) -> bool {
    !request.exclude_page_ids.contains(&page.id)
        && request
            .data_source_ids
            .is_none_or(|ids| ids.iter().any(|id| page.data_source_ids.contains(id)))
        && (request.project_filter_ids.is_none()
            || request
                .project_filter_ids
                .unwrap_or_default()
                .iter()
                .any(|id| page.project_ids.contains(id)))
}

fn rank_project_outcomes(
    index: &PageSearchIndex,
    aggregates: Vec<Aggregate>,
    request: &ProjectSearchRequest<'_>,
) -> Vec<SearchOutcome> {
    let projects = preferred_projects(
        request.project_filter_ids.unwrap_or_default(),
        request.preferred_project_id,
    );
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
        if !project_search_scope(page, request) {
            continue;
        }
        let mut project_id = None;
        for candidate_project_id in &projects {
            if page.project_ids.contains(candidate_project_id) {
                project_id = Some(candidate_project_id.clone());
                break;
            }
        }
        if project_id.is_none() && request.project_filter_ids.is_some() {
            continue;
        }
        let project_id = project_id.or_else(|| {
            request
                .preferred_project_id
                .filter(|id| page.project_ids.contains(*id))
                .map(str::to_owned)
                .or_else(|| page.project_ids.iter().next().cloned())
        });
        outcomes.push(SearchOutcome {
            recent_index: recent.get(page.id.as_str()).copied(),
            aggregate,
            project_id,
        });
    }
    outcomes
        .sort_by(|left, right| compare_outcomes(left, right, index, request.preferred_project_id));
    outcomes
}

pub(super) fn project_metadata(
    index: &PageSearchIndex,
    project_filter_ids: Option<&[String]>,
    requested_page_ids: Option<&[String]>,
) -> Result<Vec<LibraryPageSearchMetadataDocument>, StoreError> {
    if let Some(ids) = project_filter_ids {
        validate_project_ids(ids)?;
    }
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
        .filter(|page| {
            project_filter_ids.is_none_or(|ids| ids.iter().any(|id| page.project_ids.contains(id)))
        })
        .map(|page| {
            Ok(LibraryPageSearchMetadataDocument {
                page_id: page.id.clone(),
                page_key: page.page_key.clone(),
                title: page.title.clone(),
                preview: page.preview.clone(),
                status: page.status.clone(),
                priority: page.priority.clone(),
                tags: page.tags.clone(),
                assignee: page.assignee.clone(),
                owner: page.owner.clone(),
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
                project_ids: page.project_ids.iter().cloned().collect(),
                data_source_ids: page.data_source_ids.iter().cloned().collect(),
            })
        })
        .collect()
}

pub(super) fn search_references(
    connection: &Connection,
    index: &PageSearchIndex,
    library_id: &str,
    _context: &BoundModuleContext,
    query: &str,
    requested_limit: Option<u32>,
    source_page_id: Option<&str>,
) -> Result<Vec<LibraryPageReferenceCandidate>, StoreError> {
    result_limit(requested_limit)?;
    search_library(
        connection,
        index,
        library_id,
        query,
        Some(requested_limit.unwrap_or(20).min(60)),
        source_page_id,
    )
}

pub(super) fn search_library(
    connection: &Connection,
    index: &PageSearchIndex,
    library_id: &str,
    query: &str,
    requested_limit: Option<u32>,
    source_page_id: Option<&str>,
) -> Result<Vec<LibraryPageReferenceCandidate>, StoreError> {
    Ok(search_library_with_status(
        connection,
        index,
        library_id,
        query,
        requested_limit,
        source_page_id,
    )?
    .items)
}

pub(super) fn search_library_with_status(
    connection: &Connection,
    index: &PageSearchIndex,
    library_id: &str,
    query: &str,
    requested_limit: Option<u32>,
    source_page_id: Option<&str>,
) -> Result<SearchResults<LibraryPageReferenceCandidate>, StoreError> {
    let words = page_query_words(query).map_err(|message| invalid(&message))?;
    let results = search_index(
        connection,
        index,
        library_id,
        query,
        &words,
        IndexSearchOptions {
            in_scope: |page: &IndexedPage| page.lifecycle == "active",
            exclude_body_page_id: source_page_id,
            instant: false,
        },
    )?;
    let mut outcomes = Vec::new();
    for aggregate in results.items {
        let Some(page) = index.pages.get(&aggregate.page_id) else {
            continue;
        };
        if page.lifecycle != "active" {
            continue;
        }

        outcomes.push(SearchOutcome {
            aggregate,
            project_id: None,
            recent_index: None,
        });
    }
    outcomes.sort_by(|left, right| compare_outcomes(left, right, index, None));
    let limit = result_limit(requested_limit)?;
    let truncated = results.truncated;
    let items = outcomes
        .into_iter()
        .take(limit)
        .map(|outcome| reference_hit(index, reveal_body(connection, &words, outcome)?))
        .collect::<Result<_, _>>()?;
    Ok(SearchResults {
        items,
        truncated,
        coverage: results.coverage,
    })
}

pub(super) fn search_agent_pages(
    connection: &Connection,
    index: &PageSearchIndex,
    library_id: &str,
    request: AgentSearchRequest<'_>,
    after: Option<&str>,
    limit: usize,
) -> Result<(SearchResults<LibraryAgentSearchResult>, bool), StoreError> {
    let words = page_query_words(request.query).map_err(|message| invalid(&message))?;
    let results = search_index(
        connection,
        index,
        library_id,
        request.query,
        &words,
        IndexSearchOptions {
            in_scope: |page: &IndexedPage| {
                (request.include_archived || page.lifecycle == "active")
                    && page_in_agent_scope(index, page, request.scope)
            },
            exclude_body_page_id: None,
            instant: false,
        },
    )?;
    let mut outcomes = results
        .items
        .into_iter()
        .map(|aggregate| SearchOutcome {
            aggregate,
            project_id: None,
            recent_index: None,
        })
        .collect::<Vec<_>>();
    outcomes.sort_by(|left, right| compare_outcomes(left, right, index, None));
    let (window, has_more) = super::agent_search::search_window(
        outcomes.iter().map(|outcome| &outcome.aggregate.page_id),
        after,
        limit,
    )?;
    let items = outcomes
        .drain(window)
        .map(|outcome| agent_hit(index, library_id, reveal_body(connection, &words, outcome)?))
        .collect::<Result<_, _>>()?;
    Ok((
        SearchResults {
            items,
            truncated: results.truncated,
            coverage: results.coverage,
        },
        has_more,
    ))
}

/// Which Pages one index search may return, and how much work it may spend finding them.
struct IndexSearchOptions<'a, F: Fn(&IndexedPage) -> bool> {
    in_scope: F,
    /// The Page doing the searching, whose own body never counts as a match.
    exclude_body_page_id: Option<&'a str>,
    /// Skip body and metadata matching and keep only strong title and key matches, for
    /// results that update as the person types.
    instant: bool,
}

fn search_index(
    connection: &Connection,
    index: &PageSearchIndex,
    library_id: &str,
    query: &str,
    words: &[QueryWord],
    options: IndexSearchOptions<'_, impl Fn(&IndexedPage) -> bool>,
) -> Result<SearchResults<Aggregate>, StoreError> {
    let IndexSearchOptions {
        in_scope,
        exclude_body_page_id,
        instant,
    } = options;
    let scoped_id = |id: &str| index.pages.get(id).is_some_and(&in_scope);
    if query.trim().is_empty() {
        return Ok(SearchResults {
            items: index
                .pages
                .values()
                .filter(|page| in_scope(page))
                .map(|page| Aggregate {
                    page_id: page.id.clone(),
                    ..Default::default()
                })
                .collect(),
            truncated: false,
            coverage: LibrarySearchCoverage::Complete,
        });
    }

    let key_query = normalize_search_text(query);
    let key_only = is_explicit_page_key_search(&key_query);
    let mut aggregates = HashMap::<String, Aggregate>::new();
    let mut strong_terms = HashSet::new();
    for resolution in resolve_page_key_matches_in_library(connection, library_id, &key_query)? {
        if !scoped_id(&resolution.page_block_id) {
            continue;
        }
        let Some(word) = words.first() else {
            continue;
        };
        strong_terms.insert(word.text().to_owned());
        add_evidence(
            &mut aggregates,
            &resolution.page_block_id,
            Evidence {
                term: word.text().to_owned(),
                parts: vec![LibraryPageSearchTextPart {
                    text: resolution.matched_page_key.clone(),
                    highlighted: true,
                }],
                kind: EvidenceKind::PageKey {
                    page_key: resolution.matched_page_key,
                    is_current: resolution.is_current,
                },
                quality: SearchTermMatchQuality::Exact,
                edit_distance: 0,
            },
        );
    }
    if key_only || words.is_empty() {
        return Ok(SearchResults {
            items: aggregates.into_values().collect(),
            truncated: false,
            coverage: LibrarySearchCoverage::Complete,
        });
    }

    let metadata = index
        .metadata_index
        .match_documents(query, scoped_id, |_| true)
        .map_err(|message| invalid(&message))?;
    for evidence in metadata.iter().flat_map(|page| &page.evidence) {
        if evidence.quality.is_strong() {
            strong_terms.insert(evidence.term.clone());
        }
    }
    let body = if instant {
        block_search::BlockSearchResults::default()
    } else {
        let page_ids = index
            .pages
            .keys()
            .filter(|id| exclude_body_page_id != Some(id.as_str()) && scoped_id(id))
            .map(String::as_str)
            .collect::<Vec<_>>();
        block_search::search(
            connection,
            words,
            block_search::Scope {
                library_id,
                page_ids: &page_ids,
                include_titles: false,
                block_types: None,
            },
            block_search::Target::Page,
            &mut strong_terms,
        )?
    };
    let metadata = if !instant && words.iter().any(|word| !strong_terms.contains(word.text())) {
        index
            .metadata_index
            .match_documents(query, scoped_id, |word| strong_terms.contains(word.text()))
            .map_err(|message| invalid(&message))?
    } else {
        metadata
    };
    let (truncated, coverage) = (body.truncated, body.coverage);
    add_body_evidence(&mut aggregates, words, body);
    add_metadata_evidence(&mut aggregates, metadata);
    Ok(SearchResults {
        items: aggregates
            .into_values()
            .filter(|aggregate| {
                words
                    .iter()
                    .all(|word| aggregate.terms.contains_key(word.text()))
                    && (!instant || aggregate_rank(aggregate) < 24)
            })
            .collect(),
        truncated,
        coverage,
    })
}

fn add_body_evidence(
    aggregates: &mut HashMap<String, Aggregate>,
    words: &[QueryWord],
    body: block_search::BlockSearchResults,
) {
    for (page_id, hits) in body.resources {
        let aggregate = aggregates
            .entry(page_id.clone())
            .or_insert_with(|| Aggregate {
                page_id: page_id.clone(),
                ..Default::default()
            });
        aggregate.ordered = body.ordered.contains(&page_id);
        aggregate.combined_body = body.combined_body.get(&page_id).copied();
        for (index, hit) in hits {
            let term = words[index].text().to_owned();
            record_term(aggregate, &term, (hit.field_rank, 0));
            aggregate.body_ranks.push(hit.rank);
            aggregate.indexed_body.push((index, term, hit));
        }
    }
}

fn add_metadata_evidence(
    aggregates: &mut HashMap<String, Aggregate>,
    metadata: Vec<nodex_search_kernel::MetadataMatch>,
) {
    for matched in metadata {
        for evidence in matched.evidence {
            let kind = match evidence.source {
                // Core resolves current and historical Page keys above.
                KernelMatchSource::PageKey { .. } => continue,
                KernelMatchSource::Identity => EvidenceKind::Identity,
                KernelMatchSource::Title => EvidenceKind::Title,
                KernelMatchSource::Property {
                    ref property_id, ..
                } if property_id.starts_with(CONTEXT_PROPERTY_PREFIX) => EvidenceKind::Context,
                KernelMatchSource::Property {
                    property_id,
                    property_name,
                } => EvidenceKind::Property {
                    property_id,
                    property_name,
                },
            };
            add_evidence(
                aggregates,
                &matched.page_id,
                Evidence {
                    term: evidence.term,
                    kind,
                    quality: evidence.quality,
                    edit_distance: evidence.edit_distance,
                    parts: evidence.parts.into_iter().map(core_text_part).collect(),
                },
            );
        }
        if let Some(aggregate) = aggregates.get_mut(&matched.page_id) {
            aggregate.ordered |= matched.ordered;
        }
    }
}

fn reveal_body(
    connection: &Connection,
    words: &[QueryWord],
    mut outcome: SearchOutcome,
) -> Result<SearchOutcome, StoreError> {
    let indexed_body = std::mem::take(&mut outcome.aggregate.indexed_body);
    if let Some(rowid) = outcome.aggregate.combined_body
        && let Some(revealed) =
            block_search::reveal_combined_body(connection, rowid, words, |index| {
                indexed_body.iter().any(|(word_index, _, hit)| {
                    *word_index == index && hit.quality == SearchTermMatchQuality::Typo
                })
            })?
    {
        let kind = EvidenceKind::Body {
            block_id: revealed.block_id,
            block_type: revealed.block_type,
            combined: true,
        };
        outcome
            .aggregate
            .evidence
            .extend(
                words
                    .iter()
                    .zip(revealed.matches)
                    .map(|(word, (quality, parts))| Evidence {
                        term: word.text().to_owned(),
                        kind: kind.clone(),
                        quality,
                        edit_distance: 0,
                        parts,
                    }),
            );
        return Ok(outcome);
    }
    for (index, term, hit) in indexed_body {
        let word = &words[index];
        let Some(revealed) = hit.reveal(connection, word)? else {
            continue;
        };
        let kind = if revealed.source == "document_context" {
            EvidenceKind::Context
        } else {
            EvidenceKind::Body {
                block_id: revealed.block_id,
                block_type: revealed.block_type,
                combined: false,
            }
        };
        outcome.aggregate.evidence.push(Evidence {
            term,
            kind,
            quality: hit.quality,
            edit_distance: 0,
            parts: revealed.parts,
        });
    }
    Ok(outcome)
}

pub(super) fn core_text_part(part: KernelTextPart) -> LibraryPageSearchTextPart {
    LibraryPageSearchTextPart {
        text: part.text,
        highlighted: part.highlighted,
    }
}

fn add_evidence(aggregates: &mut HashMap<String, Aggregate>, page_id: &str, evidence: Evidence) {
    let aggregate = aggregates
        .entry(page_id.to_owned())
        .or_insert_with(|| Aggregate {
            page_id: page_id.to_owned(),
            ..Default::default()
        });
    record_term(
        aggregate,
        &evidence.term,
        (evidence_rank(&evidence), evidence.edit_distance),
    );
    let duplicate = aggregate.evidence.iter().any(|existing| {
        existing.term == evidence.term
            && existing.parts == evidence.parts
            && evidence_kind_key(&existing.kind) == evidence_kind_key(&evidence.kind)
    });
    if !duplicate {
        aggregate.evidence.push(evidence);
    }
}

fn record_term(aggregate: &mut Aggregate, term: &str, candidate: (usize, usize)) {
    if let Some(best) = aggregate.terms.get_mut(term) {
        *best = (*best).min(candidate);
    } else {
        aggregate.terms.insert(term.to_owned(), candidate);
    }
}

fn evidence_kind_key(kind: &EvidenceKind) -> String {
    match kind {
        EvidenceKind::PageKey { page_key, .. } => format!("page_key:{page_key}"),
        EvidenceKind::Identity => "identity".to_owned(),
        EvidenceKind::Title => "title".to_owned(),
        EvidenceKind::Property { property_id, .. } => format!("property:{property_id}"),
        EvidenceKind::Body { block_id, .. } => format!("body:{block_id}"),
        EvidenceKind::Context => "context".to_owned(),
    }
}

#[cfg(test)]
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

#[cfg(test)]
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
    let placement = (left_page.lifecycle != "active")
        .cmp(&(right_page.lifecycle != "active"))
        .then_with(|| {
            let preferred = |outcome: &SearchOutcome| {
                preferred_project_id.is_some()
                    && outcome.project_id.as_deref() == preferred_project_id
            };
            preferred(right).cmp(&preferred(left))
        });
    if placement != Ordering::Equal {
        return placement;
    }
    if left.aggregate.terms.is_empty() && right.aggregate.terms.is_empty() {
        return compare_context(left, right, preferred_project_id)
            .then_with(|| right_page.updated_at.cmp(&left_page.updated_at))
            .then_with(|| left_page.id.cmp(&right_page.id));
    }
    aggregate_rank(&left.aggregate)
        .cmp(&aggregate_rank(&right.aggregate))
        .then_with(|| right.aggregate.ordered.cmp(&left.aggregate.ordered))
        .then_with(|| compare_context(left, right, preferred_project_id))
        .then_with(|| compare_body_ranks(&left.aggregate, &right.aggregate))
        .then_with(|| {
            metadata_relevance(&left.aggregate).cmp(&metadata_relevance(&right.aggregate))
        })
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

fn aggregate_rank(aggregate: &Aggregate) -> usize {
    aggregate
        .terms
        .values()
        .map(|&(rank, _)| rank)
        .max()
        .unwrap_or(usize::MAX)
}

fn metadata_relevance(aggregate: &Aggregate) -> (usize, usize, usize) {
    let best = &aggregate.terms;
    (
        best.values().map(|&(_, distance)| distance).sum(),
        best.values().map(|&(rank, _)| rank).sum(),
        usize::MAX - aggregate.evidence.len() - aggregate.indexed_body.len(),
    )
}

fn compare_body_ranks(left: &Aggregate, right: &Aggregate) -> Ordering {
    let score = |aggregate: &Aggregate| {
        let worst = aggregate
            .body_ranks
            .iter()
            .copied()
            .max_by(f64::total_cmp)
            .unwrap_or(0.0);
        let total = aggregate.body_ranks.iter().sum::<f64>();
        (worst, total)
    };
    let left = score(left);
    let right = score(right);
    left.0
        .total_cmp(&right.0)
        .then_with(|| left.1.total_cmp(&right.1))
}

fn evidence_rank(evidence: &Evidence) -> usize {
    let field = match evidence.kind {
        EvidenceKind::PageKey { .. } => 0,
        EvidenceKind::Identity => 1,
        EvidenceKind::Title => 2,
        EvidenceKind::Property { .. } => 3,
        EvidenceKind::Body { .. } | EvidenceKind::Context => 4,
    };

    super::search_match::rank_with_context(
        evidence.quality,
        field,
        matches!(evidence.kind, EvidenceKind::Context),
    )
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
        project_id: outcome.project_id,
        page_id: page.id.clone(),
        archived: page.lifecycle != "active",
        text_rank: u32::try_from(aggregate_rank(&outcome.aggregate)).ok(),
        ordered: outcome.aggregate.ordered,
        page_key: page.page_key.clone(),
        title: page.title.clone(),
        status: page.status.clone(),
        priority: page.priority.clone(),
        tags: page.tags.clone(),
        assignee: page.assignee.clone(),
        owner: page.owner.clone(),
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
        status: page.status.clone(),
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
            .take(MAX_EXCERPT_FRAGMENTS)
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
        if (item.quality, item.edit_distance)
            < (fragment.evidence.quality, fragment.evidence.edit_distance)
        {
            fragment.evidence.quality = item.quality;
            fragment.evidence.edit_distance = item.edit_distance;
        }
        fragment.evidence.parts = merge_highlights(&fragment.evidence.parts, &item.parts);
    }
    fragments.into_values().collect()
}

fn is_content_evidence(kind: &EvidenceKind) -> bool {
    matches!(
        kind,
        EvidenceKind::Body { .. } | EvidenceKind::Property { .. } | EvidenceKind::Context
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
                matches!(
                    fragment.evidence.kind,
                    EvidenceKind::Body { combined: true, .. }
                ),
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
pub(super) fn bounded_fragment_parts(
    parts: &[LibraryPageSearchTextPart],
) -> Vec<LibraryPageSearchTextPart> {
    let first_match: usize = parts
        .iter()
        .take_while(|part| !part.highlighted)
        .map(|part| part.text.chars().count())
        .sum();
    bounded_fragment_parts_around(parts, first_match..first_match)
        .expect("a single position fits in a fragment")
}

pub(super) fn bounded_fragment_parts_around(
    parts: &[LibraryPageSearchTextPart],
    matched: std::ops::Range<usize>,
) -> Option<Vec<LibraryPageSearchTextPart>> {
    let length: usize = parts.iter().map(|part| part.text.chars().count()).sum();
    if length <= MAX_FRAGMENT_CHARACTERS {
        return Some(parts.to_vec());
    }
    let window = MAX_FRAGMENT_CHARACTERS - 2;
    if matched.len() > window {
        return None;
    }
    let start = matched
        .start
        .saturating_sub(48)
        .max(matched.end.saturating_sub(window))
        .min(length - window);
    let end = start + window;
    let mut bounded = Vec::new();
    if start > 0 {
        push_part(&mut bounded, "…".to_owned(), false);
    }
    let mut offset = 0;
    for part in parts {
        let part_end = offset + part.text.chars().count();
        let from = start.saturating_sub(offset);
        let to = end.min(part_end).saturating_sub(offset);
        if from < to {
            let text = part
                .text
                .chars()
                .skip(from)
                .take(to - from)
                .collect::<String>();
            push_part(&mut bounded, text, part.highlighted);
        }
        offset = part_end;
        if offset >= end {
            break;
        }
    }
    if end < length {
        push_part(&mut bounded, "…".to_owned(), false);
    }
    Some(bounded)
}

fn representative_evidence(evidence: &[Evidence]) -> Vec<LibraryPageSearchMatch> {
    let metadata = evidence_fragments(evidence)
        .into_iter()
        .filter(|fragment| !is_content_evidence(&fragment.evidence.kind))
        .map(|fragment| fragment.evidence);
    let mut selected = metadata
        .chain(selected_content_fragments(evidence))
        .collect::<Vec<_>>();
    selected.sort_by_key(evidence_rank);
    selected.into_iter().map(contract_evidence).collect()
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
        EvidenceKind::Context => LibraryPageSearchMatch::Context {
            quality,
            parts: evidence.parts,
        },
        EvidenceKind::Body {
            block_id,
            block_type,
            ..
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
        LibraryPageSearchMatch::Context { quality, parts } => {
            LibraryAgentPageSearchMatch::Context {
                quality: agent_quality(quality),
                excerpt: join_parts(&parts),
            }
        }
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

pub(super) fn join_parts(parts: &[LibraryPageSearchTextPart]) -> String {
    parts.iter().map(|part| part.text.as_str()).collect()
}

fn title_parts(page: &IndexedPage, evidence: &[Evidence]) -> Vec<LibraryPageSearchTextPart> {
    title_parts_for_text(&page.title, evidence)
}

fn title_parts_for_text(title: &str, evidence: &[Evidence]) -> Vec<LibraryPageSearchTextPart> {
    evidence
        .iter()
        .filter(|evidence| matches!(evidence.kind, EvidenceKind::Title))
        .map(|evidence| evidence.parts.clone())
        .reduce(|left, right| merge_highlights(&left, &right))
        .unwrap_or_else(|| {
            (!title.is_empty())
                .then(|| LibraryPageSearchTextPart {
                    text: title.to_owned(),
                    highlighted: false,
                })
                .into_iter()
                .collect()
        })
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

pub(super) fn merge_highlights(
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
        EvidenceKind::Identity | EvidenceKind::Title => LibraryPageReferenceMatchSource::Title,
        EvidenceKind::Property { .. } | EvidenceKind::Body { .. } | EvidenceKind::Context => {
            LibraryPageReferenceMatchSource::Content
        }
    }
}

pub(super) fn contract_quality(quality: SearchTermMatchQuality) -> LibraryPageSearchMatchQuality {
    match quality {
        SearchTermMatchQuality::Exact => LibraryPageSearchMatchQuality::Exact,
        SearchTermMatchQuality::Prefix => LibraryPageSearchMatchQuality::Prefix,
        SearchTermMatchQuality::Joined => LibraryPageSearchMatchQuality::Joined,
        SearchTermMatchQuality::Stem => LibraryPageSearchMatchQuality::Stem,
        SearchTermMatchQuality::Typo => LibraryPageSearchMatchQuality::Typo,
        SearchTermMatchQuality::Infix => LibraryPageSearchMatchQuality::Infix,
    }
}

pub(super) fn agent_quality(
    quality: LibraryPageSearchMatchQuality,
) -> LibraryAgentSearchMatchQuality {
    match quality {
        LibraryPageSearchMatchQuality::Exact => LibraryAgentSearchMatchQuality::Exact,
        LibraryPageSearchMatchQuality::Prefix => LibraryAgentSearchMatchQuality::Prefix,
        LibraryPageSearchMatchQuality::Joined => LibraryAgentSearchMatchQuality::Joined,
        LibraryPageSearchMatchQuality::Stem => LibraryAgentSearchMatchQuality::Stem,
        LibraryPageSearchMatchQuality::Typo => LibraryAgentSearchMatchQuality::Typo,
        LibraryPageSearchMatchQuality::Infix => LibraryAgentSearchMatchQuality::Infix,
    }
}

pub(super) fn agent_scope_page_ids<'a>(
    index: &'a PageSearchIndex,
    scope: &LibraryAgentSearchScope,
    include_archived: bool,
) -> Vec<&'a str> {
    index
        .pages
        .values()
        .filter(|page| {
            (include_archived || page.lifecycle == "active")
                && page_in_agent_scope(index, page, scope)
        })
        .map(|page| page.id.as_str())
        .collect()
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
    if let Some(ids) = request.project_filter_ids {
        validate_project_ids(ids)?;
    }
    if request.recent_page_ids.len() > MAX_RECENT_HINTS {
        return Err(invalid("Page search has too many recent Page hints"));
    }
    validate_unique_identities(request.recent_page_ids, "Page search recent Page")?;
    Ok(())
}

fn validate_project_ids(project_ids: &[String]) -> Result<(), StoreError> {
    if project_ids.is_empty() || project_ids.len() > MAX_PROJECT_SCOPES {
        return Err(invalid("Page search Project filter is out of range"));
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
    use std::collections::{BTreeMap, BTreeSet, HashMap};

    use nodex_core_contracts::library::{
        LibraryPageSearchMatch, LibraryPageWorkflowStatus, LibraryPageWorkflowStatusValue,
    };
    use nodex_platform::test_support::tempdir;
    use nodex_search_kernel::MetadataSearchIndex;
    use rusqlite::{Connection, params};

    use crate::infrastructure::store::SqliteStoreKernel;

    use super::block_search::candidate_sql;
    use super::{
        Aggregate, Evidence, EvidenceKind, IndexedPage, PageSearchIndex, ProjectSearchRequest,
        SearchTermMatchQuality, add_evidence, aggregate_rank, compare_body_ranks, highlight_text,
        rank_project_outcomes, search_projects,
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
                    connection.prepare(&format!("EXPLAIN QUERY PLAN {}", candidate_sql()))?;
                let details = statement
                    .query_map(
                        params![
                            "\"needle\"*",
                            "library:test",
                            "[]",
                            false,
                            None::<String>,
                            false,
                            nodex_search_kernel::ANALYZER_VERSION,
                        ],
                        |row| row.get::<_, String>(3),
                    )?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(details)
            })
            .expect("Page search query plan");
        let fts_loop = plan
            .iter()
            .position(|detail| detail.contains("page_search_words VIRTUAL TABLE"))
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
    fn project_search_prefers_a_phrase_then_one_block_for_multi_term_body_evidence() {
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
                 CREATE TABLE page_search_documents(document_id TEXT PRIMARY KEY, analyzer_version INTEGER);\
                 CREATE TABLE pages(block_id TEXT PRIMARY KEY, document_id TEXT);\
                 CREATE VIRTUAL TABLE page_search_words USING fts5(segments);\
                 CREATE TABLE page_search_dictionary(term TEXT PRIMARY KEY, unit_count INTEGER);\
                 INSERT INTO documents VALUES(\
                   'document:multi-term', 'library:test', 'ready', 1, 1\
                 ), (\
                   'document:split-terms', 'library:test', 'ready', 1, 1\
                 );\
                 INSERT INTO blocks VALUES\
                   ('page:multi-term', 'library:test', 'page', 'active'),\
                   ('block:multi-term', 'library:test', 'paragraph', 'active'),\
                   ('block:single-codex', 'library:test', 'paragraph', 'active'),\
                   ('block:single-electron', 'library:test', 'paragraph', 'active'),\
                   ('block:phrase', 'library:test', 'paragraph', 'active'),\
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
                 ), (\
                   4, 'library:test', 'block:single-codex', 'page:multi-term',\
                   'document:multi-term', 1, 1, 'document_block', 'Codex'\
                 ), (\
                   5, 'library:test', 'block:single-electron', 'page:multi-term',\
                   'document:multi-term', 1, 1, 'document_block', 'Electron'\
                 ), (\
                   6, 'library:test', 'block:phrase', 'page:multi-term',\
                   'document:multi-term', 1, 1, 'document_block',\
                   'Run codex electron after preparing the development environment'\
                 );\
                 INSERT INTO page_search_words(rowid, segments) VALUES\
                   (1, 'Run codex with electron'),\
                   (2, 'Codex runtime details'),\
                   (3, 'Electron shell details'), (4, 'Codex'), (5, 'Electron'),\
                   (6, 'Run codex electron after preparing the development environment');",
            )
            .expect("body search fixture");
        connection
            .execute(
                "INSERT INTO page_search_documents SELECT id, ?1 FROM documents",
                [nodex_search_kernel::ANALYZER_VERSION],
            )
            .unwrap();
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
            owner: None,
            page_key: None,
            location_label: "Pages".to_owned(),
            data_source_ids: BTreeSet::new(),
            project_ids: BTreeSet::from(["project:test".to_owned()]),
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
        let search = || {
            search_projects(
                &connection,
                &index,
                "library:test",
                ProjectSearchRequest {
                    project_filter_ids: None,
                    query: "codex electron",
                    instant: false,
                    exclude_page_ids: &[],
                    data_source_ids: None,
                    preferred_project_id: None,
                    recent_page_ids: &[],
                    limit: Some(10),
                },
            )
            .expect("Project Page search")
            .items
        };

        let assert_same_block_hit = |hits: &[super::LibraryProjectPageSearchHit], id, excerpt| {
            let hit = hits
                .iter()
                .find(|hit| hit.page_id == "page:multi-term")
                .expect("same-block multi-term hit");
            assert_eq!(hit.excerpt.as_deref(), Some(excerpt));
            let [
                LibraryPageSearchMatch::Body {
                    block_id, parts, ..
                },
            ] = hit.matches.as_slice()
            else {
                panic!("expected one body fragment, got {:?}", hit.matches);
            };
            assert_eq!(block_id, id);
            for parts in [parts, &hit.excerpt_parts] {
                let highlighted = parts
                    .iter()
                    .filter(|part| part.highlighted)
                    .map(|part| part.text.as_str())
                    .collect::<Vec<_>>();
                assert_eq!(highlighted, ["codex", "electron"]);
            }
        };
        assert_same_block_hit(
            &search(),
            "block:phrase",
            "Run codex electron after preparing the development environment",
        );
        connection
            .execute("DELETE FROM page_search_words WHERE rowid = 6", [])
            .unwrap();

        let hits = search();
        assert_eq!(hits.len(), 2);
        assert_same_block_hit(&hits, "block:multi-term", "Run codex with electron");

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
                combined: false,
            },
        ));
        evidence.push(snippet(
            "release",
            "Release date: Friday.",
            EvidenceKind::Body {
                block_id: "date".into(),
                block_type: "paragraph".into(),
                combined: false,
            },
        ));
        evidence.push(snippet(
            "cedar",
            "Tracking code: CEDAR-42.",
            EvidenceKind::Body {
                block_id: "code".into(),
                block_type: "paragraph".into(),
                combined: false,
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
            combined: false,
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
            terms: HashMap::from([
                ("codex".to_owned(), (0, 0)),
                ("electron".to_owned(), (0, 0)),
            ]),
            evidence: Vec::new(),
            ordered: false,
            indexed_body: Vec::new(),
            combined_body: None,
            body_ranks: vec![codex, electron],
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
            kind,
            quality,
            edit_distance: 0,
            parts: Vec::new(),
        };
        let mut pages = HashMap::new();
        add_evidence(
            &mut pages,
            "title",
            evidence(EvidenceKind::Title, SearchTermMatchQuality::Exact),
        );
        add_evidence(
            &mut pages,
            "title",
            evidence(
                EvidenceKind::Body {
                    block_id: "block:body".to_owned(),
                    block_type: "text".to_owned(),
                    combined: false,
                },
                SearchTermMatchQuality::Prefix,
            ),
        );
        add_evidence(
            &mut pages,
            "property",
            evidence(
                EvidenceKind::Property {
                    property_id: "summary".to_owned(),
                    property_name: "Summary".to_owned(),
                },
                SearchTermMatchQuality::Exact,
            ),
        );

        assert!(aggregate_rank(&pages["title"]) < aggregate_rank(&pages["property"]));
    }

    #[test]
    fn project_preference_and_archive_order_run_before_the_limit() {
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
                    lifecycle: if index < 3_000 || index == 6_000 {
                        "active"
                    } else {
                        "archived"
                    }
                    .to_owned(),
                    parent_kind: "library".to_owned(),
                    parent_id: "library:test".to_owned(),
                    updated_at: format!("2026-08-17T00:{:02}:00.000Z", index % 60),
                    properties: Vec::new(),
                    status: Some(LibraryPageWorkflowStatusValue {
                        option_id: if index >= 3_000 {
                            if eligible {
                                LibraryPageWorkflowStatus::Done
                            } else {
                                LibraryPageWorkflowStatus::Plan
                            }
                        } else {
                            LibraryPageWorkflowStatus::Done
                        },
                        label: "Done".to_owned(),
                    }),
                    priority: None,
                    tags: Vec::new(),
                    assignee: None,
                    owner: None,
                    page_key: None,
                    location_label: "Pages".to_owned(),
                    data_source_ids: BTreeSet::new(),
                    project_ids: if index >= 3_000 {
                        BTreeSet::from(["project:test".to_owned()])
                    } else {
                        BTreeSet::new()
                    },
                },
            );
            aggregates.push(Aggregate {
                page_id,
                terms: HashMap::from([(
                    "needle".to_owned(),
                    (SearchTermMatchQuality::Exact.rank(2), 0),
                )]),
                evidence: vec![Evidence {
                    term: "needle".to_owned(),
                    kind: EvidenceKind::Title,
                    quality: SearchTermMatchQuality::Exact,
                    edit_distance: 0,
                    parts: Vec::new(),
                }],
                body_ranks: Vec::new(),
                ordered: false,
                indexed_body: Vec::new(),
                combined_body: None,
            });
        }
        let index = PageSearchIndex {
            pages,
            data_source_databases: HashMap::new(),
            metadata_index: MetadataSearchIndex::default(),
        };
        let outcomes = rank_project_outcomes(
            &index,
            aggregates,
            &ProjectSearchRequest {
                project_filter_ids: None,
                query: "needle",
                instant: false,
                exclude_page_ids: &[],
                data_source_ids: None,
                preferred_project_id: Some("project:test"),
                recent_page_ids: &[],
                limit: Some(1),
            },
        );

        assert_eq!(outcomes.len(), 6001);
        assert_eq!(outcomes[0].aggregate.page_id, "page:6000");
        assert_eq!(
            outcomes.last().unwrap().project_id.as_deref(),
            Some("project:test")
        );
    }
}
