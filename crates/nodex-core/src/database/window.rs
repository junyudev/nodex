use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use chrono::{Duration, Utc};
use nodex_core_contracts::collection::{
    CollectionWindow, CollectionWindowAuthority, CollectionWindowRequest,
};
use nodex_core_contracts::database::{
    DatabaseAgentDataSourceQuery, DatabaseDataSourceQueryWindow, DatabaseGroupScope,
    DatabaseListGroupSummary, DatabaseListProjectionRow, DatabaseListTransientKind,
    DatabaseListWindow, DatabaseRowDetail, DatabaseRowSummary, DatabaseRowsById,
    DatabaseViewAdvancedFilterOverrideInput, DatabaseViewCompletedRange,
    DatabaseViewCompletedRangeInput, DatabaseViewCompletion, DatabaseViewContextRow,
    DatabaseViewDefinition, DatabaseViewField, DatabaseViewFieldInput, DatabaseViewFilter,
    DatabaseViewFilterGroupOperator, DatabaseViewFilterOperator, DatabaseViewGroup,
    DatabaseViewGroupOverrideInput, DatabaseViewGroupSummary, DatabaseViewGroups,
    DatabaseViewHierarchy, DatabaseViewIntrinsicField, DatabaseViewLayout,
    DatabaseViewLayoutDisplay, DatabaseViewNullOrder, DatabaseViewNullOrderInput,
    DatabaseViewPreferencesOverrideInput, DatabaseViewPresentation, DatabaseViewRules,
    DatabaseViewSort, DatabaseViewSortDirection, DatabaseViewSortDirectionInput,
    DatabaseViewSortField, DatabaseViewSortFieldInput, DatabaseViewWindow,
    MAX_VIEW_GROUP_SUMMARIES,
};
use nodex_core_contracts::events::{LocalProjectionScope, ProjectionSnapshotAuthority};
use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, OptionalExtension, Row, params, params_from_iter};
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::authorization::{authorize_required, project_primary_database};
use super::order_read::{POSITION_RANK, POSITION_REVISION, order_rank, position_joins};
use super::view_contract::MAX_VIEW_SORT_RULES;
use crate::infrastructure::collection_window::{WindowCandidate, assemble, normalize_request};
use crate::infrastructure::cursor::{
    self, CollectionCursorSubject, CursorDirection, KeysetCoordinate, KeysetValue,
};
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

const MAX_FILTER_DEPTH: usize = 8;
const MAX_FILTER_NODES: usize = 1_024;
const MAX_DISPLAY_PROPERTIES: usize = 64;
const MAX_ROWS_BY_ID: usize = 100;
const MAX_LIST_PROJECTION_MODELS: usize = 100_000;
const SUMMARY_COLUMN_COUNT: usize = 29;
const COMPATIBILITY_CARD_PROPERTY_IDS: [&str; 8] = [
    "status",
    "priority",
    "estimate",
    "tags",
    "due_date",
    "scheduled_start",
    "scheduled_end",
    "assignee",
];

#[derive(Clone, Debug)]
struct ResolvedView {
    database_id: String,
    data_source_id: String,
    view_id: String,
    revision: i64,
    exact_primary_board_config: bool,
    task_status_capable: bool,
    completion_cutoff: Option<String>,
    layout: ViewLayout,
    config: ViewConfig,
    query_scope: RowQueryScope,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
enum RowQueryScope {
    View,
    DataSource,
}

pub(super) struct ViewContextProjection {
    pub database_id: String,
    pub data_source_id: String,
    pub property_ids: Vec<String>,
    pub groups: DatabaseViewGroups,
    pub projection: ProjectionSnapshotAuthority,
    pub rows: CollectionWindow<DatabaseViewContextRow>,
}

pub(super) struct ViewWindowRead<'a> {
    pub commit_head: i64,
    pub project_id: Option<&'a str>,
    pub store_epoch: &'a str,
    pub window: &'a CollectionWindowRequest,
    pub group_scope: Option<&'a DatabaseGroupScope>,
}

pub(super) struct ViewGroupsRead<'a> {
    pub commit_head: i64,
    pub project_id: Option<&'a str>,
    pub store_epoch: &'a str,
}

pub(super) struct ViewContextRead<'a> {
    pub commit_head: i64,
    pub project_id: &'a str,
    pub store_epoch: &'a str,
    pub window: &'a CollectionWindowRequest,
    pub group_scope: Option<&'a DatabaseGroupScope>,
}

type ViewConfig = DatabaseViewDefinition;
type ViewPresentation = DatabaseViewPresentation;
type ViewCompletedRange = DatabaseViewCompletedRange;
type ViewCompletion = DatabaseViewCompletion;
type ViewLayout = DatabaseViewLayout;
type ViewField = DatabaseViewField;
type ViewFilter = DatabaseViewFilter;
type FilterGroupOperator = DatabaseViewFilterGroupOperator;
type FilterOperator = DatabaseViewFilterOperator;
type ViewSort = DatabaseViewSort;
type ViewSortField = DatabaseViewSortField;
type SortDirection = DatabaseViewSortDirection;
type NullOrder = DatabaseViewNullOrder;
type ViewGroup = DatabaseViewGroup;

#[derive(Clone, Debug)]
struct SortComponent {
    expression: String,
    direction: SortDirection,
}

struct SummaryRow {
    summary: DatabaseRowSummary,
    coordinate_values: Vec<KeysetValue>,
}

pub(super) fn view_window(
    connection: &Connection,
    library_id: &str,
    view_id: &str,
    read: ViewWindowRead<'_>,
) -> Result<DatabaseViewWindow, StoreError> {
    let view = resolve_view(connection, library_id, view_id)?;
    let projection = projection_snapshot_authority(
        connection,
        library_id,
        read.store_epoch,
        read.commit_head,
        read.project_id,
        &view,
    )?;
    view_window_for(
        connection,
        library_id,
        read.commit_head,
        &view,
        read.window,
        read.group_scope,
        projection,
    )
}

pub(super) fn agent_view_window(
    connection: &Connection,
    library_id: &str,
    view_id: &str,
    projection_property_ids: Option<&[String]>,
    read: ViewWindowRead<'_>,
) -> Result<DatabaseViewWindow, StoreError> {
    let view = resolve_view(connection, library_id, view_id)?;
    let projection_property_ids = resolve_agent_projection_property_ids(
        connection,
        &view.data_source_id,
        projection_property_ids,
    )?;
    let projection = projection_snapshot_authority(
        connection,
        library_id,
        read.store_epoch,
        read.commit_head,
        read.project_id,
        &view,
    )?;
    view_window_for_projecting(
        connection,
        library_id,
        read.commit_head,
        &view,
        read.window,
        None,
        projection,
        &projection_property_ids,
    )
}

pub(super) fn agent_data_source_window(
    connection: &Connection,
    library_id: &str,
    data_source_id: &str,
    query: &DatabaseAgentDataSourceQuery,
    read: ViewWindowRead<'_>,
) -> Result<DatabaseDataSourceQueryWindow, StoreError> {
    let project_id = read
        .project_id
        .ok_or_else(|| unauthorized("Agent Data Source query requires a bound Project"))?;
    let view =
        resolve_agent_data_source_query(connection, library_id, project_id, data_source_id, query)?;
    let projection_property_ids = resolve_agent_projection_property_ids(
        connection,
        data_source_id,
        query.projection_property_ids.as_deref(),
    )?;
    let projection = data_source_projection_snapshot_authority(
        connection,
        read.store_epoch,
        read.commit_head,
        project_id,
        &view,
    )?;
    let rows = row_window_for(
        connection,
        library_id,
        read.commit_head,
        &view,
        read.window,
        None,
        &projection_property_ids,
    )?;
    Ok(DatabaseDataSourceQueryWindow {
        database_id: view.database_id,
        data_source_id: view.data_source_id,
        projection,
        rows,
    })
}

pub(super) fn presented_view_window(
    connection: &Connection,
    library_id: &str,
    view_id: &str,
    preferences_override: &DatabaseViewPreferencesOverrideInput,
    read: ViewWindowRead<'_>,
) -> Result<DatabaseViewWindow, StoreError> {
    let mut view = resolve_view(connection, library_id, view_id)?;
    apply_definition_override(&mut view.config, preferences_override)?;
    refresh_effective_presentation(connection, &mut view)?;
    view.exact_primary_board_config = false;
    let projection = projection_snapshot_authority(
        connection,
        library_id,
        read.store_epoch,
        read.commit_head,
        read.project_id,
        &view,
    )?;
    view_window_for(
        connection,
        library_id,
        read.commit_head,
        &view,
        read.window,
        read.group_scope,
        projection,
    )
}

pub(super) fn list_window(
    connection: &Connection,
    library_id: &str,
    view_id: &str,
    read: ViewWindowRead<'_>,
) -> Result<DatabaseListWindow, StoreError> {
    let view = resolve_view(connection, library_id, view_id)?;
    let projection = projection_snapshot_authority(
        connection,
        library_id,
        read.store_epoch,
        read.commit_head,
        read.project_id,
        &view,
    )?;
    list_window_for(
        connection,
        library_id,
        read.commit_head,
        &view,
        read.window,
        projection,
    )
}

pub(super) fn presented_list_window(
    connection: &Connection,
    library_id: &str,
    view_id: &str,
    preferences_override: &DatabaseViewPreferencesOverrideInput,
    read: ViewWindowRead<'_>,
) -> Result<DatabaseListWindow, StoreError> {
    let mut view = resolve_view(connection, library_id, view_id)?;
    apply_definition_override(&mut view.config, preferences_override)?;
    refresh_effective_presentation(connection, &mut view)?;
    view.exact_primary_board_config = false;
    let projection = projection_snapshot_authority(
        connection,
        library_id,
        read.store_epoch,
        read.commit_head,
        read.project_id,
        &view,
    )?;
    list_window_for(
        connection,
        library_id,
        read.commit_head,
        &view,
        read.window,
        projection,
    )
}

/// Resolves the exact effective List presentation and materializes its full
/// occurrence graph inside the caller's transaction. Semantic List mutations
/// use this same graph as bounded List reads, so filtering, grouping,
/// transient context, hierarchy, and occurrence identities cannot drift.
pub(crate) struct PresentedListProjection {
    pub(crate) graph: ListProjectionGraph,
    pub(crate) authority: ProjectionSnapshotAuthority,
}

pub(super) struct DirectDropPresentation {
    pub(crate) group_property_id: Option<String>,
    pub(crate) writable_sort_property_ids: Vec<String>,
}

/// Resolves the exact Board presentation that authored a direct drop. The
/// returned axes are deliberately small: BlockTransfer needs semantic Property
/// coordinates, not a second View projection implementation.
pub(super) fn direct_drop_presentation(
    connection: &Connection,
    library_id: &str,
    view_id: &str,
    preferences_override: &DatabaseViewPreferencesOverrideInput,
) -> Result<DirectDropPresentation, StoreError> {
    let mut view = resolve_view(connection, library_id, view_id)?;
    apply_definition_override(&mut view.config, preferences_override)?;
    if !matches!(view.layout, ViewLayout::Board) {
        return Err(invalid(
            "Direct Block transfer placement requires a Board presentation",
        ));
    }
    refresh_effective_presentation(connection, &mut view)?;
    let structural_property_ids = [
        view.config
            .presentation
            .group
            .as_ref()
            .map(|group| group.property_id.as_str()),
        view.config
            .presentation
            .subgroup
            .as_ref()
            .map(|group| group.property_id.as_str()),
    ];
    let mut writable_sort_property_ids = Vec::new();
    for sort in &view.config.rules.sorts {
        let ViewSortField::Property { property_id } = &sort.field else {
            break;
        };
        if structural_property_ids.contains(&Some(property_id.as_str())) {
            continue;
        }
        writable_sort_property_ids.push(property_id.clone());
    }
    Ok(DirectDropPresentation {
        group_property_id: view
            .config
            .presentation
            .group
            .map(|group| group.property_id),
        writable_sort_property_ids,
    })
}

pub(crate) fn presented_list_projection(
    connection: &Connection,
    library_id: &str,
    view_id: &str,
    preferences_override: &DatabaseViewPreferencesOverrideInput,
    store_epoch: &str,
    project_id: Option<&str>,
) -> Result<PresentedListProjection, StoreError> {
    let mut view = resolve_view(connection, library_id, view_id)?;
    apply_definition_override(&mut view.config, preferences_override)?;
    if !matches!(view.layout, ViewLayout::List) {
        return Err(invalid(
            "Semantic List movement requires a List presentation",
        ));
    }
    refresh_effective_presentation(connection, &mut view)?;
    let commit_head = crate::infrastructure::local_commit::head(connection)?;
    let authority = projection_snapshot_authority(
        connection,
        library_id,
        store_epoch,
        commit_head,
        project_id,
        &view,
    )?;
    let matched_rows = complete_filtered_view_rows(connection, library_id, commit_head, &view)?;
    Ok(PresentedListProjection {
        graph: build_list_projection_graph(connection, &view, matched_rows)?,
        authority,
    })
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize)]
struct ListGroupPath {
    group_key: Option<String>,
    subgroup_key: Option<String>,
}

#[derive(Clone, Debug)]
struct ListProjectionNode {
    summary: DatabaseRowSummary,
    transient_kind: DatabaseListTransientKind,
    sort_index: usize,
}

/// Complete occurrence projection shared by bounded List reads and semantic
/// List mutations. Its internal indexes keep subtree and target resolution out
/// of the renderer without exposing an unbounded payload.
#[derive(Clone, Debug)]
pub(crate) struct ListProjectionGraph {
    pub(crate) database_id: String,
    pub(crate) data_source_id: String,
    pub(crate) view_id: String,
    pub(crate) presentation: DatabaseViewPresentation,
    pub(crate) sorts: Vec<DatabaseViewSort>,
    pub(crate) rows: Vec<DatabaseListProjectionRow>,
    pub(crate) groups: Vec<DatabaseListGroupSummary>,
    pub(crate) total_occurrence_count: i64,
    pub(crate) total_model_count: i64,
    occurrence_index: HashMap<String, usize>,
}

impl ListProjectionGraph {
    pub(crate) fn occurrence_index(&self, occurrence_key: &str) -> Option<usize> {
        self.occurrence_index.get(occurrence_key).copied()
    }

    pub(crate) fn occurrence(&self, occurrence_key: &str) -> Option<&DatabaseListProjectionRow> {
        self.occurrence_index(occurrence_key)
            .and_then(|index| self.rows.get(index))
    }
}

fn complete_filtered_view_rows(
    connection: &Connection,
    library_id: &str,
    commit_head: i64,
    view: &ResolvedView,
) -> Result<Vec<DatabaseRowSummary>, StoreError> {
    let mut rows = Vec::new();
    let mut after = None;
    loop {
        let window = row_window_for(
            connection,
            library_id,
            commit_head,
            view,
            &CollectionWindowRequest {
                after,
                first: Some(200),
            },
            None,
            &BTreeSet::new(),
        )?;
        if window.items.len() > MAX_LIST_PROJECTION_MODELS.saturating_sub(rows.len()) {
            return Err(invalid("Database List projection exceeds its model bound"));
        }
        rows.extend(window.items);
        let Some(next_cursor) = window.next_cursor else {
            break;
        };
        after = Some(next_cursor);
    }
    Ok(rows)
}

fn canonical_group_value(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::String(value) => (!value.is_empty()).then(|| value.clone()),
        Value::Bool(value) => Some(value.to_string()),
        Value::Number(value) => Some(value.to_string()),
        Value::Array(value) if value.is_empty() => None,
        Value::Array(_) | Value::Object(_) => serde_json::to_string(value).ok(),
    }
}

fn list_group_memberships(
    summary: &DatabaseRowSummary,
    group: Option<&ViewGroup>,
    values: &BTreeMap<(String, String), Value>,
) -> Vec<Option<String>> {
    let Some(group) = group else {
        return vec![None];
    };
    let Some(value) = values.get(&(summary.membership_id.clone(), group.property_id.clone()))
    else {
        return vec![None];
    };
    let Value::Array(values) = value else {
        return vec![canonical_group_value(value)];
    };
    if values.is_empty() {
        return vec![None];
    }
    let mut seen = BTreeSet::new();
    let memberships = values
        .iter()
        .filter_map(canonical_group_value)
        .filter(|value| seen.insert(value.clone()))
        .map(Some)
        .collect::<Vec<_>>();
    if memberships.is_empty() {
        vec![None]
    } else {
        memberships
    }
}

fn list_group_paths(
    summary: &DatabaseRowSummary,
    presentation: &ViewPresentation,
    values: &BTreeMap<(String, String), Value>,
) -> Vec<ListGroupPath> {
    let groups = list_group_memberships(summary, presentation.group.as_ref(), values);
    let subgroups = list_group_memberships(summary, presentation.subgroup.as_ref(), values);
    groups
        .into_iter()
        .flat_map(|group_key| {
            subgroups
                .iter()
                .cloned()
                .map(move |subgroup_key| ListGroupPath {
                    group_key: group_key.clone(),
                    subgroup_key,
                })
        })
        .collect()
}

fn list_group_values(
    connection: &Connection,
    view: &ResolvedView,
) -> Result<BTreeMap<(String, String), Value>, StoreError> {
    let property_ids = [
        view.config.presentation.group.as_ref(),
        view.config.presentation.subgroup.as_ref(),
    ]
    .into_iter()
    .flatten()
    .map(|group| group.property_id.as_str())
    .collect::<BTreeSet<_>>();
    let mut values = BTreeMap::new();
    for property_id in property_ids {
        let rows = connection
            .prepare(
                "SELECT membership_id, value_json FROM data_source_property_values \
                 WHERE data_source_id = ?1 AND property_id = ?2 ORDER BY membership_id",
            )?
            .query_map(params![view.data_source_id, property_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for (membership_id, value_json) in rows {
            let value = serde_json::from_str(&value_json)
                .map_err(|_| corrupt("Database Property value is invalid"))?;
            values.insert((membership_id, property_id.to_owned()), value);
        }
    }
    Ok(values)
}

fn list_projection_key<T: Serialize>(kind: &str, value: &T) -> Result<String, StoreError> {
    let payload = serde_json::to_vec(value)
        .map_err(|_| invalid("Database List occurrence key cannot be encoded"))?;
    Ok(format!("{kind}_{}", hex::encode(Sha256::digest(payload))))
}

#[derive(Clone, Debug)]
struct ListHierarchyEdge {
    parent_page_id: String,
}

type ListHierarchyIndexes = (
    BTreeMap<String, ListHierarchyEdge>,
    BTreeMap<String, Vec<(String, String)>>,
);

fn list_hierarchy_edges(
    connection: &Connection,
    data_source_id: &str,
) -> Result<ListHierarchyIndexes, StoreError> {
    let edges = connection
        .prepare(
            "SELECT membership.page_block_id, edge.target_page_block_id, edge.sibling_rank \
             FROM data_source_relation_edges edge \
             JOIN data_source_page_memberships membership \
               ON membership.data_source_id = edge.source_data_source_id \
              AND membership.id = edge.source_membership_id \
              AND membership.removed_at IS NULL \
             JOIN page_read_model child_model \
               ON child_model.page_block_id = membership.page_block_id \
              AND child_model.membership_id = membership.id \
              AND child_model.lifecycle = 'active' \
             JOIN data_source_page_memberships parent_membership \
               ON parent_membership.data_source_id = edge.source_data_source_id \
              AND parent_membership.page_block_id = edge.target_page_block_id \
              AND parent_membership.removed_at IS NULL \
             JOIN page_read_model parent_model \
               ON parent_model.page_block_id = parent_membership.page_block_id \
              AND parent_model.membership_id = parent_membership.id \
              AND parent_model.lifecycle = 'active' \
             WHERE edge.source_data_source_id = ?1 \
               AND edge.property_id = 'task_parent' \
             ORDER BY edge.target_page_block_id, edge.sibling_rank, \
                      membership.page_block_id",
        )?
        .query_map([data_source_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut by_child = BTreeMap::new();
    let mut by_parent = BTreeMap::<String, Vec<(String, String)>>::new();
    for (child_page_id, parent_page_id, sibling_rank) in edges {
        by_child.insert(
            child_page_id.clone(),
            ListHierarchyEdge {
                parent_page_id: parent_page_id.clone(),
            },
        );
        by_parent
            .entry(parent_page_id)
            .or_default()
            .push((sibling_rank, child_page_id));
    }
    Ok((by_child, by_parent))
}

fn list_summary(
    connection: &Connection,
    view: &ResolvedView,
    summaries: &mut HashMap<String, DatabaseRowSummary>,
    page_id: &str,
) -> Result<Option<DatabaseRowSummary>, StoreError> {
    if let Some(summary) = summaries.get(page_id) {
        return Ok(Some(summary.clone()));
    }
    let summary = summary_by_id(connection, view, page_id)?;
    let summary = summary.filter(|summary| summary.lifecycle == "active");
    if let Some(summary) = &summary {
        summaries.insert(page_id.to_owned(), summary.clone());
    }
    Ok(summary)
}

fn transient_priority(kind: DatabaseListTransientKind) -> u8 {
    match kind {
        DatabaseListTransientKind::None => 0,
        DatabaseListTransientKind::Ancestor => 1,
        DatabaseListTransientKind::Child => 2,
    }
}

fn insert_list_node(
    nodes: &mut BTreeMap<String, ListProjectionNode>,
    summary: DatabaseRowSummary,
    transient_kind: DatabaseListTransientKind,
    sort_index: usize,
) {
    let page_id = summary.page_id.clone();
    if let Some(existing) = nodes.get_mut(&page_id) {
        if matches!(transient_kind, DatabaseListTransientKind::None)
            && !matches!(existing.transient_kind, DatabaseListTransientKind::None)
        {
            // A transient ancestor borrows a descendant's coordinate only
            // until its concrete occurrence is materialized. The concrete
            // root's own View rank must remain the subtree ordering authority.
            existing.sort_index = sort_index;
            existing.transient_kind = transient_kind;
            existing.summary = summary;
            return;
        }
        existing.sort_index = existing.sort_index.min(sort_index);
        if transient_priority(transient_kind) < transient_priority(existing.transient_kind) {
            existing.transient_kind = transient_kind;
            existing.summary = summary;
        }
        return;
    }
    nodes.insert(
        page_id,
        ListProjectionNode {
            summary,
            transient_kind,
            sort_index,
        },
    );
}

fn add_list_ancestors(
    connection: &Connection,
    view: &ResolvedView,
    page_id: &str,
    sort_index: usize,
    edges: &BTreeMap<String, ListHierarchyEdge>,
    summaries: &mut HashMap<String, DatabaseRowSummary>,
    nodes: &mut BTreeMap<String, ListProjectionNode>,
) -> Result<(), StoreError> {
    let mut cursor = page_id;
    let mut visited = HashSet::new();
    for _ in 0..10 {
        if !visited.insert(cursor.to_owned()) {
            return Err(corrupt("Task hierarchy contains a cycle"));
        }
        let Some(edge) = edges.get(cursor) else {
            return Ok(());
        };
        let Some(summary) = list_summary(connection, view, summaries, &edge.parent_page_id)? else {
            return Ok(());
        };
        insert_list_node(
            nodes,
            summary,
            DatabaseListTransientKind::Ancestor,
            sort_index,
        );
        cursor = &edge.parent_page_id;
    }
    if edges.contains_key(cursor) {
        return Err(corrupt("Task hierarchy exceeds its depth bound"));
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn add_list_children(
    connection: &Connection,
    view: &ResolvedView,
    page_id: &str,
    sort_index: usize,
    depth: usize,
    children: &BTreeMap<String, Vec<(String, String)>>,
    summaries: &mut HashMap<String, DatabaseRowSummary>,
    nodes: &mut BTreeMap<String, ListProjectionNode>,
    path: &mut HashSet<String>,
) -> Result<(), StoreError> {
    if depth >= 10 {
        return Ok(());
    }
    if !path.insert(page_id.to_owned()) {
        return Err(corrupt("Task hierarchy contains a cycle"));
    }
    for (_, child_page_id) in children.get(page_id).into_iter().flatten() {
        let Some(summary) = list_summary(connection, view, summaries, child_page_id)? else {
            continue;
        };
        insert_list_node(nodes, summary, DatabaseListTransientKind::Child, sort_index);
        add_list_children(
            connection,
            view,
            child_page_id,
            sort_index,
            depth + 1,
            children,
            summaries,
            nodes,
            path,
        )?;
    }
    path.remove(page_id);
    Ok(())
}

fn property_option_ids(
    connection: &Connection,
    data_source_id: &str,
    property_id: &str,
) -> Result<Vec<String>, StoreError> {
    let property = connection
        .query_row(
            "SELECT value_type, config_json FROM data_source_properties \
             WHERE data_source_id = ?1 AND id = ?2 AND lifecycle = 'active'",
            params![data_source_id, property_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?;
    let Some((value_type, config_json)) = property else {
        return Ok(Vec::new());
    };
    Ok(super::property_semantics::option_config_from_storage(
        property_id,
        &value_type,
        &config_json,
    )?
    .options
    .into_iter()
    .map(|option| option.id)
    .collect())
}

fn configured_list_group_paths(
    connection: &Connection,
    view: &ResolvedView,
) -> Result<Vec<ListGroupPath>, StoreError> {
    if !view.config.presentation.display.show_empty_groups {
        return Ok(Vec::new());
    }
    let Some(group) = &view.config.presentation.group else {
        return Ok(Vec::new());
    };
    let groups = property_option_ids(connection, &view.data_source_id, &group.property_id)?;
    if groups.is_empty() {
        return Ok(Vec::new());
    }
    let subgroups = match &view.config.presentation.subgroup {
        Some(subgroup) => {
            property_option_ids(connection, &view.data_source_id, &subgroup.property_id)?
        }
        None => Vec::new(),
    };
    let mut paths = Vec::new();
    for group_key in groups {
        if subgroups.is_empty() {
            paths.push(ListGroupPath {
                group_key: Some(group_key),
                subgroup_key: None,
            });
        } else {
            for subgroup_key in &subgroups {
                paths.push(ListGroupPath {
                    group_key: Some(group_key.clone()),
                    subgroup_key: Some(subgroup_key.clone()),
                });
                if paths.len() >= MAX_VIEW_GROUP_SUMMARIES {
                    return Ok(paths);
                }
            }
        }
        if paths.len() >= MAX_VIEW_GROUP_SUMMARIES {
            break;
        }
    }
    Ok(paths)
}

fn list_node_order_key(node: &ListProjectionNode, nested_child: bool) -> (String, usize, String) {
    (
        if nested_child {
            node.summary
                .task_sibling_rank
                .clone()
                .unwrap_or_else(|| "~".to_owned())
        } else {
            String::new()
        },
        node.sort_index,
        node.summary.page_id.clone(),
    )
}

fn flatten_list_node(
    path: &ListGroupPath,
    page_id: &str,
    nodes: &BTreeMap<String, ListProjectionNode>,
    children: &BTreeMap<String, Vec<String>>,
    ancestors: &mut Vec<String>,
    output: &mut Vec<DatabaseListProjectionRow>,
    visited: &mut HashSet<String>,
) -> Result<(u32, u32, u32), StoreError> {
    if ancestors.len() > 10 {
        return Err(corrupt("Task hierarchy exceeds its depth bound"));
    }
    if !visited.insert(page_id.to_owned()) {
        return Err(corrupt("Task hierarchy contains a cycle"));
    }
    let node = nodes
        .get(page_id)
        .ok_or_else(|| corrupt("Database List hierarchy references a missing Page"))?;
    let group_path = vec![path.group_key.clone(), path.subgroup_key.clone()];
    let occurrence_key =
        list_projection_key("ITEM", &(&group_path, ancestors.as_slice(), page_id))?;
    let row_index = output.len();
    output.push(DatabaseListProjectionRow::Page {
        occurrence_key,
        summary: Box::new(node.summary.clone()),
        group_path,
        ancestor_page_ids: ancestors.clone(),
        depth: u32::try_from(ancestors.len())
            .map_err(|_| invalid("Database List hierarchy depth is invalid"))?,
        has_children: children
            .get(page_id)
            .is_some_and(|child_page_ids| !child_page_ids.is_empty()),
        subtree_occurrence_count: 1,
        concrete_subtree_page_count: u32::from(matches!(
            node.transient_kind,
            DatabaseListTransientKind::None
        )),
        subtree_height: 0,
        first_child_occurrence_key: None,
        transient_kind: node.transient_kind,
    });
    ancestors.push(page_id.to_owned());
    let mut subtree_occurrence_count = 1_u32;
    let mut concrete_subtree_page_count = u32::from(matches!(
        node.transient_kind,
        DatabaseListTransientKind::None
    ));
    let mut subtree_height = 0_u32;
    let mut first_child_occurrence_key = None;
    for child_page_id in children.get(page_id).into_iter().flatten() {
        let child_row_index = output.len();
        let (child_occurrence_count, child_concrete_count, child_height) = flatten_list_node(
            path,
            child_page_id,
            nodes,
            children,
            ancestors,
            output,
            visited,
        )?;
        if first_child_occurrence_key.is_none() {
            first_child_occurrence_key = output
                .get(child_row_index)
                .map(|row| row.occurrence_key().to_owned());
        }
        subtree_occurrence_count = subtree_occurrence_count
            .checked_add(child_occurrence_count)
            .ok_or_else(|| invalid("Database List subtree occurrence count overflowed"))?;
        concrete_subtree_page_count = concrete_subtree_page_count
            .checked_add(child_concrete_count)
            .ok_or_else(|| invalid("Database List concrete subtree count overflowed"))?;
        subtree_height = subtree_height.max(
            child_height
                .checked_add(1)
                .ok_or_else(|| invalid("Database List subtree height overflowed"))?,
        );
    }
    ancestors.pop();
    let Some(DatabaseListProjectionRow::Page {
        subtree_occurrence_count: row_occurrence_count,
        concrete_subtree_page_count: row_concrete_count,
        subtree_height: row_subtree_height,
        first_child_occurrence_key: row_first_child,
        ..
    }) = output.get_mut(row_index)
    else {
        return Err(corrupt(
            "Database List subtree root disappeared while flattening",
        ));
    };
    *row_occurrence_count = subtree_occurrence_count;
    *row_concrete_count = concrete_subtree_page_count;
    *row_subtree_height = subtree_height;
    *row_first_child = first_child_occurrence_key;
    Ok((
        subtree_occurrence_count,
        concrete_subtree_page_count,
        subtree_height,
    ))
}

fn flatten_list_path(
    path: &ListGroupPath,
    nodes: &BTreeMap<String, ListProjectionNode>,
    nested: bool,
) -> Result<Vec<DatabaseListProjectionRow>, StoreError> {
    if !nested {
        let mut ordered = nodes.values().collect::<Vec<_>>();
        ordered.sort_by_key(|node| list_node_order_key(node, false));
        return ordered
            .into_iter()
            .map(|node| {
                let group_path = vec![path.group_key.clone(), path.subgroup_key.clone()];
                Ok(DatabaseListProjectionRow::Page {
                    occurrence_key: list_projection_key(
                        "ITEM",
                        &(&group_path, &[] as &[String], &node.summary.page_id),
                    )?,
                    summary: Box::new(node.summary.clone()),
                    group_path,
                    ancestor_page_ids: Vec::new(),
                    depth: 0,
                    has_children: false,
                    subtree_occurrence_count: 1,
                    concrete_subtree_page_count: u32::from(matches!(
                        node.transient_kind,
                        DatabaseListTransientKind::None
                    )),
                    subtree_height: 0,
                    first_child_occurrence_key: None,
                    transient_kind: node.transient_kind,
                })
            })
            .collect();
    }

    let mut children = BTreeMap::<String, Vec<String>>::new();
    let mut roots = Vec::new();
    for (page_id, node) in nodes {
        let parent_page_id = node.summary.task_parent_page_id.as_ref();
        if let Some(parent_page_id) = parent_page_id.filter(|parent| nodes.contains_key(*parent)) {
            children
                .entry(parent_page_id.clone())
                .or_default()
                .push(page_id.clone());
        } else {
            roots.push(page_id.clone());
        }
    }
    roots.sort_by_key(|page_id| list_node_order_key(&nodes[page_id], false));
    for child_ids in children.values_mut() {
        child_ids.sort_by_key(|page_id| list_node_order_key(&nodes[page_id], true));
    }
    let mut output = Vec::new();
    let mut visited = HashSet::new();
    for root in roots {
        flatten_list_node(
            path,
            &root,
            nodes,
            &children,
            &mut Vec::new(),
            &mut output,
            &mut visited,
        )?;
    }
    for page_id in nodes.keys() {
        if visited.contains(page_id) {
            continue;
        }
        flatten_list_node(
            path,
            page_id,
            nodes,
            &children,
            &mut Vec::new(),
            &mut output,
            &mut visited,
        )?;
    }
    Ok(output)
}

fn ordered_list_paths(
    configured: Vec<ListGroupPath>,
    encountered: &[ListGroupPath],
    grouped: bool,
    direction: SortDirection,
) -> Vec<ListGroupPath> {
    let mut seen = BTreeSet::new();
    let paths = configured
        .into_iter()
        .chain(encountered.iter().cloned())
        .filter(|path| seen.insert(path.clone()))
        .collect::<Vec<_>>();
    if !grouped || matches!(direction, SortDirection::Asc) {
        return paths;
    }
    let mut group_order = Vec::<Option<String>>::new();
    let mut paths_by_group = BTreeMap::<Option<String>, Vec<ListGroupPath>>::new();
    for path in paths {
        if !paths_by_group.contains_key(&path.group_key) {
            group_order.push(path.group_key.clone());
        }
        paths_by_group
            .entry(path.group_key.clone())
            .or_default()
            .push(path);
    }
    group_order.reverse();
    group_order
        .into_iter()
        .flat_map(|group_key| paths_by_group.remove(&group_key).unwrap_or_default())
        .collect()
}

fn flatten_list_projection(
    connection: &Connection,
    view: &ResolvedView,
    path_nodes: &BTreeMap<ListGroupPath, BTreeMap<String, ListProjectionNode>>,
    encountered_paths: &[ListGroupPath],
) -> Result<
    (
        Vec<DatabaseListProjectionRow>,
        Vec<DatabaseListGroupSummary>,
        i64,
    ),
    StoreError,
> {
    let grouped = view.config.presentation.group.is_some();
    let subgrouped = view.config.presentation.subgroup.is_some();
    let nested = view.config.presentation.hierarchy.show_sub_pages
        && view.config.presentation.hierarchy.nested_sub_pages;
    let paths = ordered_list_paths(
        configured_list_group_paths(connection, view)?,
        encountered_paths,
        grouped,
        view.config.presentation.group_direction,
    );
    let mut flattened_paths = Vec::with_capacity(paths.len());
    let mut group_totals = BTreeMap::<Option<String>, i64>::new();
    let mut total_occurrences = 0_i64;
    for path in paths {
        let nodes = path_nodes.get(&path).cloned().unwrap_or_default();
        let page_rows = flatten_list_path(&path, &nodes, nested)?;
        let path_total = i64::try_from(page_rows.len())
            .map_err(|_| invalid("Database List occurrence total is invalid"))?;
        total_occurrences = total_occurrences
            .checked_add(path_total)
            .ok_or_else(|| invalid("Database List occurrence total overflowed"))?;
        let group_total = group_totals.entry(path.group_key.clone()).or_default();
        *group_total = group_total
            .checked_add(path_total)
            .ok_or_else(|| invalid("Database List group total overflowed"))?;
        flattened_paths.push((path, page_rows, path_total));
    }

    let mut rows = Vec::new();
    let mut groups = Vec::with_capacity(flattened_paths.len());
    let mut emitted_groups = BTreeSet::new();
    for (path, page_rows, path_total) in flattened_paths {
        if grouped && emitted_groups.insert(path.group_key.clone()) {
            rows.push(DatabaseListProjectionRow::Group {
                occurrence_key: list_projection_key("GROUP", &path.group_key)?,
                group_key: path.group_key.clone(),
                total_occurrence_count: group_totals.get(&path.group_key).copied().unwrap_or(0),
            });
        }
        if subgrouped {
            rows.push(DatabaseListProjectionRow::Subgroup {
                occurrence_key: list_projection_key(
                    "SUBGROUP",
                    &(&path.group_key, &path.subgroup_key),
                )?,
                group_key: path.group_key.clone(),
                subgroup_key: path.subgroup_key.clone(),
                total_occurrence_count: path_total,
            });
        }
        groups.push(DatabaseListGroupSummary {
            group_key: path.group_key,
            subgroup_key: path.subgroup_key,
            total_occurrence_count: path_total,
        });
        rows.extend(page_rows);
    }
    Ok((rows, groups, total_occurrences))
}

fn build_list_projection_graph(
    connection: &Connection,
    view: &ResolvedView,
    matched_rows: Vec<DatabaseRowSummary>,
) -> Result<ListProjectionGraph, StoreError> {
    let (edges, children) = list_hierarchy_edges(connection, &view.data_source_id)?;
    let group_values = list_group_values(connection, view)?;
    let show_sub_pages = view.config.presentation.hierarchy.show_sub_pages;
    let nested = show_sub_pages && view.config.presentation.hierarchy.nested_sub_pages;
    let total_model_count = matched_rows
        .iter()
        .filter(|row| show_sub_pages || row.task_parent_page_id.is_none())
        .map(|row| row.page_id.as_str())
        .collect::<BTreeSet<_>>()
        .len();
    let mut summaries = matched_rows
        .iter()
        .cloned()
        .map(|summary| (summary.page_id.clone(), summary))
        .collect::<HashMap<_, _>>();
    let mut path_nodes = BTreeMap::<ListGroupPath, BTreeMap<String, ListProjectionNode>>::new();
    let mut encountered_paths = Vec::new();
    let mut encountered_path_set = BTreeSet::new();

    for (sort_index, summary) in matched_rows.into_iter().enumerate() {
        if !show_sub_pages && summary.task_parent_page_id.is_some() {
            continue;
        }
        for path in list_group_paths(&summary, &view.config.presentation, &group_values) {
            if encountered_path_set.insert(path.clone()) {
                encountered_paths.push(path.clone());
            }
            let nodes = path_nodes.entry(path).or_default();
            insert_list_node(
                nodes,
                summary.clone(),
                DatabaseListTransientKind::None,
                sort_index,
            );
            if !nested {
                continue;
            }
            add_list_ancestors(
                connection,
                view,
                &summary.page_id,
                sort_index,
                &edges,
                &mut summaries,
                nodes,
            )?;
            add_list_children(
                connection,
                view,
                &summary.page_id,
                sort_index,
                0,
                &children,
                &mut summaries,
                nodes,
                &mut HashSet::new(),
            )?;
            if nodes.len() > MAX_LIST_PROJECTION_MODELS {
                return Err(invalid(
                    "Database List projection exceeds its occurrence bound",
                ));
            }
        }
    }
    if encountered_paths.is_empty() && view.config.presentation.group.is_none() {
        encountered_paths.push(ListGroupPath {
            group_key: None,
            subgroup_key: None,
        });
    }
    let (rows, groups, total_occurrence_count) =
        flatten_list_projection(connection, view, &path_nodes, &encountered_paths)?;
    let occurrence_index = rows
        .iter()
        .enumerate()
        .map(|(index, row)| (row.occurrence_key().to_owned(), index))
        .collect::<HashMap<_, _>>();
    if occurrence_index.len() != rows.len() {
        return Err(corrupt(
            "Database List occurrence identities are not unique",
        ));
    }
    Ok(ListProjectionGraph {
        database_id: view.database_id.clone(),
        data_source_id: view.data_source_id.clone(),
        view_id: view.view_id.clone(),
        presentation: view.config.presentation.clone(),
        sorts: view.config.rules.sorts.clone(),
        rows,
        groups,
        total_occurrence_count,
        total_model_count: i64::try_from(total_model_count)
            .map_err(|_| invalid("Database List model total is invalid"))?,
        occurrence_index,
    })
}

fn list_window_for(
    connection: &Connection,
    library_id: &str,
    commit_head: i64,
    view: &ResolvedView,
    request: &CollectionWindowRequest,
    projection: ProjectionSnapshotAuthority,
) -> Result<DatabaseListWindow, StoreError> {
    let normalized = normalize_request(request)?;
    let matched_rows = complete_filtered_view_rows(connection, library_id, commit_head, view)?;
    let graph = build_list_projection_graph(connection, view, matched_rows)?;
    let total_projection_row_count = i64::try_from(graph.rows.len())
        .map_err(|_| invalid("Database List projection row total is invalid"))?;
    let fingerprint = cursor::query_fingerprint(&(
        "database_list_window_v1",
        super::manual_order::keyset_identity(connection, &view.view_id)?,
        &view.view_id,
        &view.data_source_id,
        &view.config,
        &view.completion_cutoff,
        commit_head,
    ))?;
    let subject = CollectionCursorSubject {
        kind: "database_list_projection",
        library_id,
        query_fingerprint: &fingerprint,
    };
    let start = normalized
        .after
        .map(|encoded| cursor::decode(connection, encoded, subject))
        .transpose()?
        .map(|(direction, coordinate)| {
            let [KeysetValue::Integer { value: index }] = coordinate.values.as_slice() else {
                return Err(invalid("Database List cursor is incompatible"));
            };
            if direction != CursorDirection::Forward || *index < 0 {
                return Err(invalid("Database List cursor is incompatible"));
            }
            let index = usize::try_from(*index)
                .map_err(|_| invalid("Database List cursor is incompatible"))?;
            if graph
                .rows
                .get(index)
                .is_none_or(|row| row.occurrence_key() != coordinate.stable_id)
            {
                return Err(invalid("Database List cursor projection changed"));
            }
            index
                .checked_add(1)
                .ok_or_else(|| invalid("Database List cursor overflowed"))
        })
        .transpose()?
        .unwrap_or(0);
    let candidates = graph
        .rows
        .iter()
        .enumerate()
        .skip(start)
        .take(normalized.first.saturating_add(1))
        .map(|(index, row)| WindowCandidate {
            coordinate: KeysetCoordinate {
                values: vec![KeysetValue::Integer {
                    value: i64::try_from(index)
                        .expect("bounded List projection indices fit in i64"),
                }],
                stable_id: row.occurrence_key().to_owned(),
            },
            item: row.clone(),
        });
    let rows = assemble(
        candidates,
        normalized.first,
        CollectionWindowAuthority {
            projection_revision: commit_head,
        },
        |coordinate| {
            cursor::mint(
                connection,
                subject,
                CursorDirection::Forward,
                coordinate.clone(),
            )
        },
    )?;
    let window_end = start
        .checked_add(rows.items.len())
        .ok_or_else(|| invalid("Database List window boundary overflowed"))?;
    Ok(DatabaseListWindow {
        database_id: view.database_id.clone(),
        data_source_id: view.data_source_id.clone(),
        view_id: view.view_id.clone(),
        projection,
        is_complete: rows.next_cursor.is_none(),
        rows,
        groups: graph.groups,
        total_projection_row_count,
        total_occurrence_count: graph.total_occurrence_count,
        total_model_count: graph.total_model_count,
        window_start: i64::try_from(start)
            .map_err(|_| invalid("Database List window start is invalid"))?,
        window_end: i64::try_from(window_end)
            .map_err(|_| invalid("Database List window end is invalid"))?,
    })
}

fn view_window_for(
    connection: &Connection,
    library_id: &str,
    commit_head: i64,
    view: &ResolvedView,
    request: &CollectionWindowRequest,
    group_scope: Option<&DatabaseGroupScope>,
    projection: ProjectionSnapshotAuthority,
) -> Result<DatabaseViewWindow, StoreError> {
    view_window_for_projecting(
        connection,
        library_id,
        commit_head,
        view,
        request,
        group_scope,
        projection,
        &BTreeSet::new(),
    )
}

#[allow(clippy::too_many_arguments)]
fn view_window_for_projecting(
    connection: &Connection,
    library_id: &str,
    commit_head: i64,
    view: &ResolvedView,
    request: &CollectionWindowRequest,
    group_scope: Option<&DatabaseGroupScope>,
    projection: ProjectionSnapshotAuthority,
    projection_property_ids: &BTreeSet<String>,
) -> Result<DatabaseViewWindow, StoreError> {
    let rows = row_window_for(
        connection,
        library_id,
        commit_head,
        view,
        request,
        group_scope,
        projection_property_ids,
    )?;
    Ok(DatabaseViewWindow {
        database_id: view.database_id.clone(),
        data_source_id: view.data_source_id.clone(),
        view_id: view.view_id.clone(),
        projection,
        rows,
    })
}

fn row_window_for(
    connection: &Connection,
    library_id: &str,
    commit_head: i64,
    view: &ResolvedView,
    request: &CollectionWindowRequest,
    group_scope: Option<&DatabaseGroupScope>,
    projection_property_ids: &BTreeSet<String>,
) -> Result<CollectionWindow<DatabaseRowSummary>, StoreError> {
    let normalized = normalize_request(request)?;
    let fingerprint = cursor::query_fingerprint(&(
        "database_view_window_v2",
        super::manual_order::keyset_identity(connection, &view.view_id)?,
        view.query_scope,
        &view.view_id,
        &view.data_source_id,
        &view.config,
        &view.completion_cutoff,
        group_scope,
        projection_property_ids,
    ))?;
    let subject = CollectionCursorSubject {
        kind: match view.query_scope {
            RowQueryScope::View => "database_view_rows",
            RowQueryScope::DataSource => "database_data_source_query_rows",
        },
        library_id,
        query_fingerprint: &fingerprint,
    };
    let mut parameters = Vec::new();
    let (effective_group, effective_subgroup) =
        effective_group_expressions(&view.config, &mut parameters)?;
    let sort_components = sort_components(
        &view.config,
        effective_group.as_deref(),
        effective_subgroup.as_deref(),
        &mut parameters,
    )?;
    let cursor_coordinate = normalized
        .after
        .map(|encoded| cursor::decode(connection, encoded, subject))
        .transpose()?
        .map(|(direction, coordinate)| {
            if direction != CursorDirection::Forward {
                return Err(invalid("Database View cursor direction is unsupported"));
            }
            if coordinate.values.len() != sort_components.len() {
                return Err(invalid(
                    "Database View cursor has an incompatible sort coordinate",
                ));
            }
            Ok(coordinate)
        })
        .transpose()?;

    let scope_predicate = group_scope
        .map(|scope| {
            group_scope_predicate(
                scope,
                effective_group.as_deref(),
                effective_subgroup.as_deref(),
                &mut parameters,
            )
        })
        .transpose()?
        .map(|predicate| format!("AND ({predicate}) "))
        .unwrap_or_default();
    let position_view = bind(&mut parameters, SqlValue::Text(view.view_id.clone()));
    let source = bind(&mut parameters, SqlValue::Text(view.data_source_id.clone()));
    let database = bind(&mut parameters, SqlValue::Text(view.database_id.clone()));
    let effective_filter = super::view_contract::effective_filter(&view.config.rules);
    let filter = compile_filter(&effective_filter, &mut parameters, 1, &mut 0)?;
    let completion = compile_completion_predicate(view, &mut parameters)?;
    let (database_values_projection, property_revisions_projection) =
        compact_value_projections_with(&view.config, projection_property_ids, &mut parameters)?;
    let effective_group_select = effective_group.as_deref().unwrap_or("NULL");
    let effective_subgroup_select = effective_subgroup.as_deref().unwrap_or("NULL");
    let sort_projection = sort_components
        .iter()
        .enumerate()
        .map(|(index, component)| {
            format!(
                "{expression} AS sort_{index}",
                expression = component.expression
            )
        })
        .collect::<Vec<_>>()
        .join(", ");
    let cursor_predicate = cursor_coordinate
        .as_ref()
        .map(|coordinate| compile_keyset_predicate(&sort_components, coordinate, &mut parameters))
        .transpose()?
        .map(|predicate| format!("WHERE {predicate}"))
        .unwrap_or_default();
    let order = sort_components
        .iter()
        .enumerate()
        .map(|(index, component)| format!("sort_{index} {}", direction_sql(component.direction)))
        .chain(std::iter::once("page_id ASC".to_owned()))
        .collect::<Vec<_>>()
        .join(", ");
    let limit = bind(
        &mut parameters,
        SqlValue::Integer(
            i64::try_from(normalized.first + 1)
                .map_err(|_| invalid("Database View window size is invalid"))?,
        ),
    );
    let sql = format!(
        "WITH candidate_rows AS (\
           SELECT model.page_block_id AS page_id, \
             CASE WHEN key_assignment.number IS NULL THEN NULL \
               ELSE key_prefix.normalized_prefix || '-' || key_assignment.number END AS page_key, \
             model.lifecycle, model.title, \
             materialization.title_rich_json, model.description_preview, \
             model.description_length, model.has_description, {database_values_projection}, \
             model.intrinsic_properties_json, \
             {property_revisions_projection}, \
             model.metadata_revision, model.placement_revision, model.document_id, \
             model.document_generation, model.document_projected_seq, membership.id, \
             membership.revision, membership.created_at, model.created_at, model.updated_at, \
             {effective_group_select} AS effective_group_key, \
             {effective_subgroup_select} AS effective_subgroup_key, {POSITION_RANK}, \
             {POSITION_REVISION}, NULL AS position_order, hierarchy.target_page_block_id, \
             hierarchy.sibling_rank, parent_value.revision, {sort_projection} \
           FROM data_source_page_memberships membership \
           JOIN page_read_model model \
             ON model.page_block_id = membership.page_block_id \
             AND model.membership_id = membership.id \
           JOIN documents document \
             ON document.id = model.document_id \
             AND document.generation = model.document_generation \
             AND document.head_seq = model.document_projected_seq \
           JOIN document_materializations materialization \
             ON materialization.document_id = document.id \
             AND materialization.generation = document.generation \
             AND materialization.projected_seq = document.head_seq \
             AND materialization.schema_version = document.schema_version \
           LEFT JOIN page_key_assignments key_assignment \
             ON key_assignment.database_block_id = {database} \
             AND key_assignment.page_block_id = membership.page_block_id \
           LEFT JOIN page_key_prefixes key_prefix \
             ON key_prefix.database_block_id = key_assignment.database_block_id \
             AND key_prefix.retired_at IS NULL \
           {position_read_joins} \
           JOIN data_source_property_values parent_value \
             ON parent_value.data_source_id = membership.data_source_id \
             AND parent_value.membership_id = membership.id \
             AND parent_value.property_id = 'task_parent' \
             AND parent_value.value_type = 'relation' \
             AND json_type(parent_value.value_json) = 'null' \
           LEFT JOIN data_source_relation_edges hierarchy \
             ON hierarchy.source_data_source_id = membership.data_source_id \
             AND hierarchy.source_membership_id = membership.id \
             AND hierarchy.property_id = 'task_parent' \
             AND EXISTS (\
               SELECT 1 FROM data_source_page_memberships parent_membership \
               JOIN page_read_model parent_model \
                 ON parent_model.page_block_id = parent_membership.page_block_id \
                AND parent_model.membership_id = parent_membership.id \
               WHERE parent_membership.data_source_id = membership.data_source_id \
                 AND parent_membership.page_block_id = hierarchy.target_page_block_id \
                 AND parent_membership.removed_at IS NULL \
                 AND parent_model.lifecycle = 'active'\
             ) \
           WHERE membership.data_source_id = {source} \
             AND membership.removed_at IS NULL \
             AND model.lifecycle = 'active' \
             {scope_predicate}\
             AND ({completion})\
             AND ({filter})\
         ) \
         SELECT * FROM candidate_rows {cursor_predicate} \
         ORDER BY {order} LIMIT {limit}",
        position_read_joins = position_joins(&position_view, "membership.page_block_id"),
    );
    let rows = connection
        .prepare(&sql)?
        .query_map(params_from_iter(parameters.iter()), |row| {
            summary_from_row(row, sort_components.len())
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let candidates = rows.into_iter().map(|row| WindowCandidate {
        coordinate: KeysetCoordinate {
            values: row.coordinate_values,
            stable_id: row.summary.page_id.clone(),
        },
        item: row.summary,
    });
    let rows = assemble(
        candidates,
        normalized.first,
        CollectionWindowAuthority {
            projection_revision: commit_head,
        },
        |coordinate| {
            cursor::mint(
                connection,
                subject,
                CursorDirection::Forward,
                coordinate.clone(),
            )
        },
    )?;
    Ok(rows)
}

fn projection_snapshot_authority(
    connection: &Connection,
    library_id: &str,
    store_epoch: &str,
    commit_head: i64,
    project_id: Option<&str>,
    view: &ResolvedView,
) -> Result<ProjectionSnapshotAuthority, StoreError> {
    let scope = match project_id {
        Some(project_id) => LocalProjectionScope::DatabaseView {
            project_id: project_id.to_owned(),
            database_id: view.database_id.clone(),
            data_source_id: view.data_source_id.clone(),
            view_id: view.view_id.clone(),
        },
        None => LocalProjectionScope::Library {
            library_id: library_id.to_owned(),
        },
    };
    let scope = crate::infrastructure::projection_scope_head::canonical_scope_key(scope)?;
    let head = crate::infrastructure::projection_scope_head::read(connection, store_epoch, &scope)?;
    Ok(ProjectionSnapshotAuthority {
        scope,
        revision: head.as_ref().map_or(0, |value| value.revision),
        covered_commit_seq: commit_head,
        effect_hash: head.map(|value| value.effect_hash),
    })
}

fn data_source_projection_snapshot_authority(
    connection: &Connection,
    store_epoch: &str,
    commit_head: i64,
    project_id: &str,
    view: &ResolvedView,
) -> Result<ProjectionSnapshotAuthority, StoreError> {
    let scope = crate::infrastructure::projection_scope_head::canonical_scope_key(
        LocalProjectionScope::PageDetailDataSource {
            project_id: project_id.to_owned(),
            database_id: view.database_id.clone(),
            data_source_id: view.data_source_id.clone(),
        },
    )?;
    let head = crate::infrastructure::projection_scope_head::read(connection, store_epoch, &scope)?;
    Ok(ProjectionSnapshotAuthority {
        scope,
        revision: head.as_ref().map_or(0, |value| value.revision),
        covered_commit_seq: commit_head,
        effect_hash: head.map(|value| value.effect_hash),
    })
}

/// Bounded per-group totals for a View, derived from the same candidate row
/// set (memberships, lifecycle, exact-head joins, View filter) and the same
/// effective-group expression as `view_window`, so counts always agree with
/// what group-scoped windows can reach.
pub(crate) fn view_groups(
    connection: &Connection,
    library_id: &str,
    view_id: &str,
    read: ViewGroupsRead<'_>,
) -> Result<DatabaseViewGroups, StoreError> {
    let view = resolve_view(connection, library_id, view_id)?;
    let projection = projection_snapshot_authority(
        connection,
        library_id,
        read.store_epoch,
        read.commit_head,
        read.project_id,
        &view,
    )?;
    view_groups_for(connection, &view, projection)
}

pub(crate) fn presented_view_groups(
    connection: &Connection,
    library_id: &str,
    view_id: &str,
    preferences_override: &DatabaseViewPreferencesOverrideInput,
    read: ViewGroupsRead<'_>,
) -> Result<DatabaseViewGroups, StoreError> {
    let mut view = resolve_view(connection, library_id, view_id)?;
    apply_definition_override(&mut view.config, preferences_override)?;
    refresh_effective_presentation(connection, &mut view)?;
    view.exact_primary_board_config = false;
    let projection = projection_snapshot_authority(
        connection,
        library_id,
        read.store_epoch,
        read.commit_head,
        read.project_id,
        &view,
    )?;
    view_groups_for(connection, &view, projection)
}

fn view_groups_for(
    connection: &Connection,
    view: &ResolvedView,
    projection: ProjectionSnapshotAuthority,
) -> Result<DatabaseViewGroups, StoreError> {
    let mut parameters = Vec::new();
    let (effective_group, effective_subgroup) =
        effective_group_expressions(&view.config, &mut parameters)?;
    let group_select = effective_group.as_deref().unwrap_or("NULL");
    let subgroup_select = effective_subgroup.as_deref().unwrap_or("NULL");
    let position_view = bind(&mut parameters, SqlValue::Text(view.view_id.clone()));
    let source = bind(&mut parameters, SqlValue::Text(view.data_source_id.clone()));
    let effective_filter = super::view_contract::effective_filter(&view.config.rules);
    let filter = compile_filter(&effective_filter, &mut parameters, 1, &mut 0)?;
    let completion = compile_completion_predicate(view, &mut parameters)?;
    let candidate_cte = format!(
        "WITH candidate_rows AS (\
           SELECT {group_select} AS group_key, {subgroup_select} AS subgroup_key \
           FROM data_source_page_memberships membership \
           JOIN page_read_model model \
             ON model.page_block_id = membership.page_block_id \
             AND model.membership_id = membership.id \
           JOIN documents document \
             ON document.id = model.document_id \
             AND document.generation = model.document_generation \
             AND document.head_seq = model.document_projected_seq \
           JOIN document_materializations materialization \
             ON materialization.document_id = document.id \
             AND materialization.generation = document.generation \
             AND materialization.projected_seq = document.head_seq \
             AND materialization.schema_version = document.schema_version \
           {position_read_joins} \
             WHERE membership.data_source_id = {source} \
             AND membership.removed_at IS NULL \
             AND model.lifecycle = 'active' \
             AND ({completion})\
             AND ({filter})\
         )",
        position_read_joins = position_joins(&position_view, "membership.page_block_id"),
    );
    let total_rows = connection.query_row(
        &format!("{candidate_cte} SELECT count(*) FROM candidate_rows"),
        params_from_iter(parameters.iter()),
        |row| row.get::<_, i64>(0),
    )?;
    if effective_group.is_none() {
        return Ok(DatabaseViewGroups {
            database_id: view.database_id.clone(),
            data_source_id: view.data_source_id.clone(),
            view_id: view.view_id.clone(),
            projection,
            grouped: false,
            subgrouped: false,
            total_rows,
            total_groups: 0,
            group_limit: MAX_VIEW_GROUP_SUMMARIES,
            truncated: false,
            groups: Vec::new(),
        });
    }
    let observed_total_groups = connection.query_row(
        &format!(
            "{candidate_cte} SELECT count(*) FROM (\
               SELECT 1 FROM candidate_rows GROUP BY group_key, subgroup_key\
             )"
        ),
        params_from_iter(parameters.iter()),
        |row| row.get::<_, i64>(0),
    )?;
    let limit = bind(
        &mut parameters,
        SqlValue::Integer(
            i64::try_from(MAX_VIEW_GROUP_SUMMARIES + 1)
                .map_err(|_| invalid("Database View group bound is invalid"))?,
        ),
    );
    let sql = format!(
        "{candidate_cte} \
         SELECT group_key, subgroup_key, count(*) FROM candidate_rows \
         GROUP BY group_key, subgroup_key \
         ORDER BY CASE WHEN group_key IS NULL THEN 1 ELSE 0 END, group_key, \
           CASE WHEN subgroup_key IS NULL THEN 1 ELSE 0 END, subgroup_key \
         LIMIT {limit}"
    );
    let mut groups = connection
        .prepare(&sql)?
        .query_map(params_from_iter(parameters.iter()), |row| {
            Ok(DatabaseViewGroupSummary {
                group_key: row.get(0)?,
                subgroup_key: row.get(1)?,
                total_rows: row.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut total_groups = observed_total_groups;
    let mut truncated = groups.len() > MAX_VIEW_GROUP_SUMMARIES;
    groups.truncate(MAX_VIEW_GROUP_SUMMARIES);
    if !truncated && show_empty_groups(view) {
        let primary = finite_group_keys(
            connection,
            &view.data_source_id,
            &view.config.presentation.group,
        )?;
        let secondary = finite_group_keys(
            connection,
            &view.data_source_id,
            &view.config.presentation.subgroup,
        )?;
        let secondary = match (effective_subgroup.is_some(), secondary) {
            (true, Some(secondary)) => Some(secondary),
            (true, None) => None,
            (false, _) => Some(vec![None]),
        };
        if let (Some(primary), Some(secondary)) = (primary, secondary) {
            let mut totals = groups
                .into_iter()
                .map(|group| ((group.group_key, group.subgroup_key), group.total_rows))
                .collect::<BTreeMap<_, _>>();
            for group_key in primary {
                for subgroup_key in &secondary {
                    totals
                        .entry((group_key.clone(), subgroup_key.clone()))
                        .or_insert(0);
                }
            }
            let expanded_total = totals.len();
            total_groups = i64::try_from(expanded_total).unwrap_or(i64::MAX);
            groups = totals
                .into_iter()
                .map(
                    |((group_key, subgroup_key), total_rows)| DatabaseViewGroupSummary {
                        group_key,
                        subgroup_key,
                        total_rows,
                    },
                )
                .collect();
            groups.sort_by(compare_group_summaries);
            truncated = expanded_total > MAX_VIEW_GROUP_SUMMARIES;
            groups.truncate(MAX_VIEW_GROUP_SUMMARIES);
        }
    }
    Ok(DatabaseViewGroups {
        database_id: view.database_id.clone(),
        data_source_id: view.data_source_id.clone(),
        view_id: view.view_id.clone(),
        projection,
        grouped: true,
        subgrouped: effective_subgroup.is_some(),
        total_rows,
        total_groups,
        group_limit: MAX_VIEW_GROUP_SUMMARIES,
        truncated,
        groups,
    })
}

fn show_empty_groups(view: &ResolvedView) -> bool {
    view.config.presentation.display.show_empty_groups
}

fn finite_group_keys(
    connection: &Connection,
    data_source_id: &str,
    group: &Option<ViewGroup>,
) -> Result<Option<Vec<Option<String>>>, StoreError> {
    let Some(group) = group else {
        return Ok(None);
    };
    let property = connection
        .query_row(
            "SELECT value_type, config_json FROM data_source_properties \
             WHERE data_source_id = ?1 AND id = ?2 AND lifecycle = 'active'",
            params![data_source_id, group.property_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?;
    let Some((value_type, config_json)) = property else {
        return Ok(None);
    };
    if value_type == "checkbox" {
        return Ok(Some(vec![
            Some("false".to_owned()),
            Some("true".to_owned()),
        ]));
    }
    if value_type != "select" {
        return Ok(None);
    }
    Ok(Some(
        super::property_semantics::option_config_from_storage(
            &group.property_id,
            &value_type,
            &config_json,
        )?
        .options
        .into_iter()
        .map(|option| Some(option.id))
        .collect(),
    ))
}

fn compare_optional_group_key(left: &Option<String>, right: &Option<String>) -> std::cmp::Ordering {
    match (left, right) {
        (Some(left), Some(right)) => left.cmp(right),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => std::cmp::Ordering::Equal,
    }
}

fn compare_group_summaries(
    left: &DatabaseViewGroupSummary,
    right: &DatabaseViewGroupSummary,
) -> std::cmp::Ordering {
    compare_optional_group_key(&left.group_key, &right.group_key)
        .then_with(|| compare_optional_group_key(&left.subgroup_key, &right.subgroup_key))
}

pub(super) fn view_context(
    connection: &Connection,
    library_id: &str,
    view_id: &str,
    read: ViewContextRead<'_>,
) -> Result<ViewContextProjection, StoreError> {
    let view = resolve_view(connection, library_id, view_id)?;
    let projection = projection_snapshot_authority(
        connection,
        library_id,
        read.store_epoch,
        read.commit_head,
        Some(read.project_id),
        &view,
    )?;
    let window = view_window_for(
        connection,
        library_id,
        read.commit_head,
        &view,
        read.window,
        read.group_scope,
        projection.clone(),
    )?;
    let groups = view_groups_for(connection, &view, projection.clone())?;
    let rows = CollectionWindow {
        items: window
            .rows
            .items
            .into_iter()
            .map(|summary| {
                let move_etag = mint_page_move_etag(
                    connection,
                    library_id,
                    read.project_id,
                    read.store_epoch,
                    &summary.page_id,
                    Some(&view.view_id),
                )?;
                Ok(DatabaseViewContextRow { summary, move_etag })
            })
            .collect::<Result<Vec<_>, StoreError>>()?,
        next_cursor: window.rows.next_cursor,
        authority: window.rows.authority,
    };
    Ok(ViewContextProjection {
        database_id: view.database_id.clone(),
        data_source_id: view.data_source_id.clone(),
        property_ids: projected_property_ids(&view.config)?.into_iter().collect(),
        groups,
        projection,
        rows,
    })
}

struct PageMoveAuthority {
    lifecycle: String,
    location_revision: i64,
    parent_kind: String,
    parent_id: String,
    parent_revision: i64,
    metadata_revision: i64,
}

struct PageMoveViewAuthority {
    database_id: String,
    data_source_id: String,
    view_id: String,
    revision: i64,
    grouping_property_id: Option<String>,
}

struct PageMoveMembershipAuthority {
    id: String,
    revision: i64,
    grouping_value_json: Option<String>,
    grouping_value_revision: Option<i64>,
    position_rank_key: Option<String>,
    position_revision: Option<i64>,
}

pub(crate) fn page_relocation_database_targets(
    connection: &Connection,
    library_id: &str,
    query: &str,
    after_updated_at: Option<&str>,
    after_database_id: Option<&str>,
    limit: usize,
) -> Result<(Vec<super::PageRelocationDatabaseTarget>, bool, i64), StoreError> {
    let query_limit = i64::try_from(limit.saturating_add(1))
        .map_err(|_| invalid("Database relocation target limit overflowed"))?;
    let rows_sql = "SELECT container.block_id, container.name, \
                      COALESCE((SELECT group_concat(primary_project.name, char(31)) FROM ( \
                        SELECT project.name FROM projects project \
                        WHERE project.library_id = container.library_id \
                          AND project.database_block_id = container.block_id \
                          AND project.lifecycle = 'active' \
                        ORDER BY project.name, project.id \
                      ) primary_project), ''), \
                      source.id, view.id, container.updated_at \
                    FROM database_containers container \
                    JOIN blocks block ON block.id = container.block_id \
                      AND block.library_id = container.library_id \
                    JOIN database_views view ON view.id = container.default_view_id \
                      AND view.database_block_id = container.block_id \
                      AND view.lifecycle = 'active' \
                    JOIN data_sources source ON source.id = view.data_source_id \
                      AND source.home_database_block_id = container.block_id \
                      AND source.library_id = container.library_id \
                      AND source.lifecycle = 'active' \
                    WHERE container.library_id = ?1 AND container.lifecycle = 'active' \
                      AND block.lifecycle = 'active' \
                      AND (?2 = '' OR instr(lower(container.name), ?2) > 0 OR EXISTS( \
                        SELECT 1 FROM projects project \
                        WHERE project.library_id = container.library_id \
                          AND project.database_block_id = container.block_id \
                          AND project.lifecycle = 'active' \
                          AND instr(lower(project.name), ?2) > 0 \
                      )) \
                      AND (?3 IS NULL OR container.updated_at < ?3 \
                        OR (container.updated_at = ?3 AND container.block_id > ?4)) \
                    ORDER BY container.updated_at DESC, container.block_id LIMIT ?5";
    let mut rows = connection
        .prepare(rows_sql)?
        .query_map(
            params![
                library_id,
                query,
                after_updated_at,
                after_database_id,
                query_limit
            ],
            |row| {
                Ok(super::PageRelocationDatabaseTarget {
                    database_id: row.get(0)?,
                    title: row.get(1)?,
                    primary_project_names: row
                        .get::<_, String>(2)?
                        .split('\u{1f}')
                        .filter(|name| !name.is_empty())
                        .map(str::to_owned)
                        .collect(),
                    data_source_id: row.get(3)?,
                    view_id: row.get(4)?,
                    updated_at: row.get(5)?,
                })
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let has_more = rows.len() > limit;
    rows.truncate(limit);
    let total = connection.query_row(
        "SELECT COUNT(*) FROM database_containers container \
         JOIN blocks block ON block.id = container.block_id \
           AND block.library_id = container.library_id \
         JOIN database_views view ON view.id = container.default_view_id \
           AND view.database_block_id = container.block_id AND view.lifecycle = 'active' \
         JOIN data_sources source ON source.id = view.data_source_id \
           AND source.home_database_block_id = container.block_id \
           AND source.library_id = container.library_id AND source.lifecycle = 'active' \
         WHERE container.library_id = ?1 AND container.lifecycle = 'active' \
           AND block.lifecycle = 'active' \
           AND (?2 = '' OR instr(lower(container.name), ?2) > 0 OR EXISTS( \
             SELECT 1 FROM projects project \
             WHERE project.library_id = container.library_id \
               AND project.database_block_id = container.block_id \
               AND project.lifecycle = 'active' \
               AND instr(lower(project.name), ?2) > 0 \
           ))",
        params![library_id, query],
        |row| row.get::<_, i64>(0),
    )?;
    Ok((rows, has_more, total))
}

pub(crate) fn default_page_move_view_id(
    connection: &Connection,
    library_id: &str,
    page_id: &str,
) -> Result<Option<String>, StoreError> {
    connection
        .query_row(
            "SELECT container.default_view_id \
             FROM data_source_page_memberships membership \
             JOIN data_sources source \
               ON source.id = membership.data_source_id \
               AND source.library_id = ?1 AND source.lifecycle = 'active' \
             JOIN database_containers container \
               ON container.block_id = source.home_database_block_id \
               AND container.library_id = source.library_id \
               AND container.lifecycle = 'active' \
             WHERE membership.page_block_id = ?2 AND membership.removed_at IS NULL",
            params![library_id, page_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map(Option::flatten)
        .map_err(StoreError::from)
}

pub(crate) fn mint_page_move_etag(
    connection: &Connection,
    library_id: &str,
    project_id: &str,
    store_epoch: &str,
    page_id: &str,
    view_id: Option<&str>,
) -> Result<String, StoreError> {
    mint_page_move_etag_with_authority(
        connection,
        library_id,
        project_id,
        Some(project_id),
        store_epoch,
        page_id,
        view_id,
    )
}

/// Mints the same validator as [`mint_page_move_etag`] after a trusted
/// Library operation has already established the destination authority. The
/// actor Project remains part of the signed coordinate, but it does not own or
/// constrain the target Database.
pub(crate) fn mint_page_move_etag_prevalidated(
    connection: &Connection,
    library_id: &str,
    actor_project_id: &str,
    store_epoch: &str,
    page_id: &str,
    view_id: Option<&str>,
) -> Result<String, StoreError> {
    mint_page_move_etag_with_authority(
        connection,
        library_id,
        actor_project_id,
        None,
        store_epoch,
        page_id,
        view_id,
    )
}

#[allow(clippy::too_many_arguments)]
fn mint_page_move_etag_with_authority(
    connection: &Connection,
    library_id: &str,
    actor_project_id: &str,
    authorizing_project_id: Option<&str>,
    store_epoch: &str,
    page_id: &str,
    view_id: Option<&str>,
) -> Result<String, StoreError> {
    let page = connection
        .query_row(
            "SELECT block.lifecycle, block.placement_revision, page.parent_kind, page.parent_id, \
               block.placement_revision, block.metadata_revision \
             FROM pages page \
             JOIN blocks block ON block.id = page.block_id AND block.library_id = page.library_id \
               AND block.type = 'page' \
             WHERE page.block_id = ?1 AND page.library_id = ?2 \
               AND block.lifecycle <> 'deleted'",
            params![page_id, library_id],
            |row| {
                Ok(PageMoveAuthority {
                    lifecycle: row.get(0)?,
                    location_revision: row.get(1)?,
                    parent_kind: row.get(2)?,
                    parent_id: row.get(3)?,
                    parent_revision: row.get(4)?,
                    metadata_revision: row.get(5)?,
                })
            },
        )
        .optional()?
        .ok_or_else(|| corrupt("Database row move authority is unavailable"))?;
    let view = view_id
        .map(|view_id| {
            let view = resolve_view(connection, library_id, view_id)?;
            if let Some(project_id) = authorizing_project_id {
                let primary_database_id =
                    project_primary_database(connection, library_id, project_id)?;
                authorize_required(
                    connection,
                    Some(project_id),
                    primary_database_id.as_deref(),
                    &view.database_id,
                )?;
            }
            Ok::<_, StoreError>(PageMoveViewAuthority {
                database_id: view.database_id,
                data_source_id: view.data_source_id,
                view_id: view.view_id,
                revision: view.revision,
                grouping_property_id: view
                    .config
                    .presentation
                    .group
                    .map(|group| group.property_id),
            })
        })
        .transpose()?;
    let membership = view
        .as_ref()
        .map(|view| {
            connection
                .query_row(
                    &format!("SELECT membership.id, membership.revision, value.value_json, value.revision, \
                       {POSITION_RANK}, {POSITION_REVISION} \
                     FROM data_source_page_memberships membership \
                     LEFT JOIN data_source_property_values value \
                       ON value.data_source_id = membership.data_source_id \
                       AND value.membership_id = membership.id \
                       AND value.property_id = ?3 \
                     {position_read_joins} \
                     WHERE membership.data_source_id = ?1 \
                       AND membership.page_block_id = ?2 \
                       AND membership.removed_at IS NULL",
                       position_read_joins = position_joins("?4", "membership.page_block_id")),
                    params![
                        view.data_source_id,
                        page_id,
                        view.grouping_property_id,
                        view.view_id
                    ],
                    |row| {
                        Ok(PageMoveMembershipAuthority {
                            id: row.get(0)?,
                            revision: row.get(1)?,
                            grouping_value_json: row.get(2)?,
                            grouping_value_revision: row.get(3)?,
                            position_rank_key: row.get(4)?,
                            position_revision: row.get(5)?,
                        })
                    },
                )
                .optional()
                .map_err(StoreError::from)
        })
        .transpose()?
        .flatten();
    let effective_group_key = membership.as_ref().and_then(|membership| {
        membership
            .grouping_value_json
            .as_deref()
            .and_then(normalize_grouping_value)
    });
    crate::document::mint_etag(
        connection,
        "page_move",
        actor_project_id,
        store_epoch,
        &[library_id, page_id, view_id.unwrap_or("-")],
        json!({
            "libraryId": library_id,
            "page": {
                "lifecycle": page.lifecycle,
                "locationRevision": page.location_revision,
                "parentKind": page.parent_kind,
                "parentId": page.parent_id,
                "parentRevision": page.parent_revision,
                "metadataRevision": page.metadata_revision,
            },
            "membership": {
                "id": membership.as_ref().map(|authority| &authority.id),
                "revision": membership.as_ref().map(|authority| authority.revision),
            },
            "view": {
                "databaseId": view.as_ref().map(|authority| &authority.database_id),
                "dataSourceId": view.as_ref().map(|authority| &authority.data_source_id),
                "id": view.as_ref().map(|authority| &authority.view_id),
                "revision": view.as_ref().map(|authority| authority.revision),
                "groupingPropertyId": view
                    .as_ref()
                    .and_then(|authority| authority.grouping_property_id.as_deref()),
                "groupingValueRevision": membership
                    .as_ref()
                    .and_then(|authority| authority.grouping_value_revision),
            },
            "position": {
                "revision": membership
                    .as_ref()
                    .and_then(|authority| authority.position_revision),
                "effectiveGroupKey": effective_group_key,
                "rankKey": membership
                    .as_ref()
                    .and_then(|authority| authority.position_rank_key.as_deref()),
            },
        }),
    )
    .map_err(|error| {
        StoreError::new(
            StoreErrorCode::StoreCorrupt,
            format!("Database row move validator authority is unavailable: {error}"),
            false,
        )
    })
}

fn normalize_grouping_value(raw: &str) -> Option<String> {
    match serde_json::from_str::<Value>(raw).ok()? {
        Value::Null => None,
        Value::String(value) => (!value.is_empty()).then_some(value),
        Value::Array(values) if values.is_empty() => None,
        Value::Bool(value) => Some(value.to_string()),
        value => Some(value.to_string()),
    }
}

pub(crate) fn rows_by_id(
    connection: &Connection,
    library_id: &str,
    view_id: &str,
    page_ids: &[String],
) -> Result<DatabaseRowsById, StoreError> {
    validate_page_ids(page_ids)?;
    let view = resolve_view(connection, library_id, view_id)?;
    let mut rows = Vec::with_capacity(page_ids.len());
    for page_id in page_ids {
        if let Some(summary) = summary_by_id(connection, &view, page_id)? {
            rows.push(summary);
        }
    }
    Ok(DatabaseRowsById { rows })
}

/// Returns a row patch only when this View has the exact primary Board
/// contract that the singleton patch protocol can represent. Other Views must
/// converge through their canonical bounded read; an identity read is not
/// evidence that a row belongs to a filtered or independently sorted View.
pub(crate) fn exact_primary_board_row_by_id(
    connection: &Connection,
    library_id: &str,
    view_id: &str,
    page_id: &str,
) -> Result<Option<DatabaseRowSummary>, StoreError> {
    validate_identity(page_id, "Database Page identity")?;
    let view = resolve_view(connection, library_id, view_id)?;
    if !has_exact_primary_board_patch_contract(connection, &view)? {
        return Ok(None);
    }
    let Some(mut summary) = summary_by_id(connection, &view, page_id)? else {
        return Ok(None);
    };
    if summary.lifecycle != "active" {
        return Ok(None);
    }
    let Some(rank_key) = summary.rank_key.as_deref() else {
        return Ok(None);
    };
    if !has_exact_active_position(connection, &view, page_id, rank_key)? {
        return Ok(None);
    }
    summary.position_order = Some(exact_manual_position_order(
        connection, &view, rank_key, page_id,
    )?);
    Ok(Some(summary))
}

fn has_exact_primary_board_patch_contract(
    connection: &Connection,
    view: &ResolvedView,
) -> Result<bool, StoreError> {
    let is_default = connection
        .query_row(
            "SELECT 1 FROM database_containers \
             WHERE block_id = ?1 AND default_view_id = ?2 AND lifecycle = 'active'",
            params![view.database_id, view.view_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    Ok(is_default && view.exact_primary_board_config)
}

fn has_exact_active_position(
    connection: &Connection,
    view: &ResolvedView,
    page_id: &str,
    rank_key: &str,
) -> Result<bool, StoreError> {
    connection
        .query_row(
            &format!(
                "SELECT 1 FROM data_source_page_memberships membership \
             JOIN page_read_model model \
               ON model.page_block_id = membership.page_block_id \
               AND model.membership_id = membership.id AND model.lifecycle = 'active' \
               AND model.view_id = ?1 \
             {position_read_joins} \
             WHERE membership.data_source_id = ?2 AND membership.removed_at IS NULL \
               AND membership.page_block_id = ?3 AND {POSITION_RANK} = ?4",
                position_read_joins = position_joins("?1", "membership.page_block_id")
            ),
            params![view.view_id, view.data_source_id, page_id, rank_key],
            |_| Ok(()),
        )
        .optional()
        .map(|value| value.is_some())
        .map_err(StoreError::from)
}

fn exact_manual_position_order(
    connection: &Connection,
    view: &ResolvedView,
    rank_key: &str,
    page_id: &str,
) -> Result<i64, StoreError> {
    connection
        .query_row(
            &format!(
                "SELECT count(*) FROM data_source_page_memberships membership \
             JOIN page_read_model model \
               ON model.page_block_id = membership.page_block_id \
               AND model.membership_id = membership.id AND model.lifecycle = 'active' \
               AND model.view_id = ?1 \
             {position_read_joins} \
             WHERE membership.data_source_id = ?2 AND membership.removed_at IS NULL \
               AND ({POSITION_RANK}, membership.page_block_id) < (?3, ?4)",
                position_read_joins = position_joins("?1", "membership.page_block_id")
            ),
            params![view.view_id, view.data_source_id, rank_key, page_id],
            |row| row.get(0),
        )
        .map_err(StoreError::from)
}

pub(super) fn row_detail(
    connection: &Connection,
    library_id: &str,
    view_id: &str,
    page_id: &str,
) -> Result<DatabaseRowDetail, StoreError> {
    validate_identity(page_id, "Database Page identity")?;
    let view = resolve_view(connection, library_id, view_id)?;
    let summary = summary_by_id(connection, &view, page_id)?
        .ok_or_else(|| not_found("Database row is unavailable"))?;
    let body_nfm = connection
        .query_row(
            "SELECT materialization.nfm FROM pages page \
             JOIN documents document ON document.id = page.document_id \
             JOIN document_materializations materialization \
               ON materialization.document_id = document.id \
               AND materialization.generation = document.generation \
               AND materialization.projected_seq = document.head_seq \
               AND materialization.schema_version = document.schema_version \
             WHERE page.block_id = ?1",
            [page_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .ok_or_else(|| corrupt("Database row has no exact-head Document projection"))?;
    Ok(DatabaseRowDetail { summary, body_nfm })
}

fn resolve_view(
    connection: &Connection,
    library_id: &str,
    view_id: &str,
) -> Result<ResolvedView, StoreError> {
    validate_identity(view_id, "Database View identity")?;
    connection
        .query_row(
            "SELECT view.database_block_id, view.data_source_id, view.config_json, \
               view.layout, view.revision, view.lifecycle, container.lifecycle, \
               source.lifecycle, \
               EXISTS(SELECT 1 FROM data_source_properties status_property \
                 WHERE status_property.data_source_id = view.data_source_id \
                   AND status_property.id = 'status' \
                   AND status_property.value_type = 'select' \
                   AND status_property.lifecycle = 'active') \
             FROM database_views view \
             JOIN database_containers container \
               ON container.block_id = view.database_block_id \
               AND container.library_id = ?1 \
             JOIN data_sources source \
               ON source.id = view.data_source_id \
               AND source.library_id = container.library_id \
             WHERE view.id = ?2",
            params![library_id, view_id],
            |row| {
                let config_json = row.get::<_, String>(2)?;
                let config = super::view_contract::decode_definition_json(&config_json).map_err(
                    |error| {
                        rusqlite::Error::FromSqlConversionFailure(
                            config_json.len(),
                            rusqlite::types::Type::Text,
                            std::io::Error::new(std::io::ErrorKind::InvalidData, error).into(),
                        )
                    },
                )?;
                let exact_primary_board_config =
                    super::view_contract::is_exact_primary_board_definition(&config);
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    config,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, bool>(8)?,
                    exact_primary_board_config,
                ))
            },
        )
        .optional()?
        .map(
            |(
                database_id,
                data_source_id,
                config,
                layout,
                revision,
                view_lifecycle,
                database_lifecycle,
                source_lifecycle,
                task_status_capable,
                exact_primary_board_config,
            )| {
                if view_lifecycle != "active"
                    || database_lifecycle != "active"
                    || source_lifecycle != "active"
                {
                    return Err(not_found("Database View is not active"));
                }
                validate_filter(
                    &super::view_contract::effective_filter(&config.rules),
                    1,
                    &mut 0,
                )?;
                if config.rules.sorts.len() > MAX_VIEW_SORT_RULES {
                    return Err(invalid("Database View has too many sort rules"));
                }
                if let Some(group) = &config.presentation.group {
                    validate_property_id(&group.property_id)?;
                }
                let layout = match layout.as_str() {
                    "board" => ViewLayout::Board,
                    "list" => ViewLayout::List,
                    _ => return Err(corrupt("Database View default layout is unsupported")),
                };
                let mut view = ResolvedView {
                    database_id,
                    data_source_id,
                    view_id: view_id.to_owned(),
                    revision,
                    exact_primary_board_config,
                    task_status_capable,
                    completion_cutoff: None,
                    layout,
                    config,
                    query_scope: RowQueryScope::View,
                };
                refresh_effective_presentation(connection, &mut view)?;
                Ok(view)
            },
        )
        .transpose()?
        .ok_or_else(|| not_found("Database View is unavailable"))
}

fn resolve_agent_data_source_query(
    connection: &Connection,
    library_id: &str,
    project_id: &str,
    data_source_id: &str,
    query: &DatabaseAgentDataSourceQuery,
) -> Result<ResolvedView, StoreError> {
    validate_identity(data_source_id, "Data Source identity")?;
    if query
        .sort
        .iter()
        .any(|rule| matches!(&rule.field, DatabaseViewSortField::Manual))
    {
        return Err(invalid(
            "Transient Data Source queries cannot use View manual order",
        ));
    }
    let source = connection
        .query_row(
            "SELECT source.home_database_block_id, source.schema_revision, source.lifecycle, \
               container.lifecycle, \
               EXISTS(SELECT 1 FROM data_source_properties status_property \
                 WHERE status_property.data_source_id = source.id \
                   AND status_property.id = 'status' \
                   AND status_property.value_type = 'select' \
                   AND status_property.lifecycle = 'active') \
             FROM data_sources source \
             JOIN database_containers container \
               ON container.block_id = source.home_database_block_id \
              AND container.library_id = source.library_id \
             WHERE source.id = ?1 AND source.library_id = ?2",
            params![data_source_id, library_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, bool>(4)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| not_found("Data Source is unavailable"))?;
    let (database_id, revision, source_lifecycle, database_lifecycle, task_status_capable) = source;
    if source_lifecycle != "active" || database_lifecycle != "active" {
        return Err(not_found("Data Source is not active"));
    }
    let empty_layout = DatabaseViewLayoutDisplay {
        fields: Vec::new(),
        property_order: Vec::new(),
        show_empty_groups: false,
        show_description: true,
    };
    let definition = DatabaseViewDefinition {
        rules: DatabaseViewRules {
            property_filters: Vec::new(),
            advanced_filter: Some(match &query.filter {
                DatabaseViewFilter::Group { .. } => query.filter.clone(),
                clause => DatabaseViewFilter::Group {
                    operator: DatabaseViewFilterGroupOperator::And,
                    children: vec![clause.clone()],
                },
            }),
            sorts: query.sort.clone(),
        },
        presentation: DatabaseViewPresentation {
            group: None,
            subgroup: None,
            group_direction: DatabaseViewSortDirection::Asc,
            completion: DatabaseViewCompletion {
                range: DatabaseViewCompletedRange::All,
                order_by_recency: false,
            },
            hierarchy: DatabaseViewHierarchy {
                show_sub_pages: false,
                nested_sub_pages: false,
            },
            display: empty_layout,
            conditional_colors: Vec::new(),
        },
    };
    super::mutation::validate_view_definition(
        connection,
        library_id,
        project_id,
        data_source_id,
        &definition,
        false,
    )?;
    let mut view = ResolvedView {
        database_id,
        data_source_id: data_source_id.to_owned(),
        view_id: format!(
            "agent-data-source:{}",
            hex::encode(Sha256::digest(data_source_id.as_bytes()))
        ),
        revision,
        exact_primary_board_config: false,
        task_status_capable,
        completion_cutoff: None,
        layout: DatabaseViewLayout::List,
        config: definition,
        query_scope: RowQueryScope::DataSource,
    };
    refresh_effective_presentation(connection, &mut view)?;
    Ok(view)
}

fn resolve_agent_projection_property_ids(
    connection: &Connection,
    data_source_id: &str,
    requested: Option<&[String]>,
) -> Result<BTreeSet<String>, StoreError> {
    let active = connection
        .prepare(
            "SELECT id FROM data_source_properties \
             WHERE data_source_id = ?1 AND lifecycle = 'active' ORDER BY id",
        )?
        .query_map([data_source_id], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<BTreeSet<_>>>()?;
    if active
        .iter()
        .any(|property_id| !super::property_semantics::is_canonical_property_id(property_id))
    {
        return Err(corrupt("Stored Property ID is not canonical"));
    }
    let Some(requested) = requested else {
        return Ok(active);
    };
    if requested.len() > super::MAX_DATA_SOURCE_PROPERTIES {
        return Err(invalid("Agent query projects too many Properties"));
    }
    let requested_count = requested.len();
    let requested = requested.iter().cloned().collect::<BTreeSet<_>>();
    if requested.len() != requested_count {
        return Err(invalid("Agent query repeats a projected Property"));
    }
    if requested
        .iter()
        .any(|property_id| !super::property_semantics::is_canonical_property_id(property_id))
    {
        return Err(invalid("Agent query Property ID is not canonical"));
    }
    if !requested.is_subset(&active) {
        return Err(not_found("Agent query references an unavailable Property"));
    }
    Ok(requested)
}

fn normalize_completion_capability(completion: &mut ViewCompletion, supported: bool) {
    if supported {
        return;
    }
    completion.range = ViewCompletedRange::All;
    completion.order_by_recency = false;
}

fn completion_cutoff(completion: &ViewCompletion) -> Result<Option<String>, StoreError> {
    let days = match completion.range {
        ViewCompletedRange::All | ViewCompletedRange::None => return Ok(None),
        ViewCompletedRange::PastDay => 0,
        ViewCompletedRange::PastWeek => 6,
        ViewCompletedRange::PastMonth => 29,
    };
    let date = Utc::now()
        .date_naive()
        .checked_sub_signed(Duration::days(days))
        .ok_or_else(|| invalid("Database View completion boundary is invalid"))?;
    Ok(Some(format!("{date}T00:00:00.000Z")))
}

fn refresh_effective_presentation(
    connection: &Connection,
    view: &mut ResolvedView,
) -> Result<(), StoreError> {
    let properties = connection
        .prepare(
            "SELECT id, value_type FROM data_source_properties \
             WHERE data_source_id = ?1 AND lifecycle = 'active' ORDER BY id",
        )?
        .query_map([&view.data_source_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<BTreeMap<_, _>>>()?;
    let valid_group = |group: &ViewGroup| {
        properties
            .get(&group.property_id)
            .is_some_and(|value_type| value_type != "relation")
    };
    if !view
        .config
        .presentation
        .group
        .as_ref()
        .is_some_and(valid_group)
    {
        view.config.presentation.group = None;
    }
    if view.config.presentation.group.is_none()
        || !view
            .config
            .presentation
            .subgroup
            .as_ref()
            .is_some_and(valid_group)
    {
        view.config.presentation.subgroup = None;
    }
    if view
        .config
        .presentation
        .group
        .as_ref()
        .is_some_and(|group| {
            view.config
                .presentation
                .subgroup
                .as_ref()
                .is_some_and(|subgroup| subgroup.property_id == group.property_id)
        })
    {
        view.config.presentation.subgroup = None;
    }
    view.config.rules.sorts.retain(|rule| match &rule.field {
        ViewSortField::Property { property_id } => properties
            .get(property_id)
            .is_some_and(|value_type| value_type != "relation"),
        ViewSortField::Manual | ViewSortField::Title | ViewSortField::Created => true,
    });
    {
        let layout = &mut view.config.presentation.display;
        let mut seen = BTreeSet::new();
        layout.fields.retain(|field| {
            let key = match field {
                ViewField::Property { property_id } if properties.contains_key(property_id) => {
                    format!("property:{property_id}")
                }
                ViewField::Intrinsic { field } => match field {
                    DatabaseViewIntrinsicField::PageKey => "intrinsic:page_key".to_owned(),
                    DatabaseViewIntrinsicField::CreatedAt => "intrinsic:created_at".to_owned(),
                    DatabaseViewIntrinsicField::UpdatedAt => "intrinsic:updated_at".to_owned(),
                },
                _ => return false,
            };
            seen.insert(key)
        });
        let mut seen_properties = BTreeSet::new();
        layout.property_order.retain(|property_id| {
            properties.contains_key(property_id) && seen_properties.insert(property_id.clone())
        });
    }
    let finite = |group: &Option<ViewGroup>| {
        group.as_ref().is_some_and(|group| {
            properties
                .get(&group.property_id)
                .is_some_and(|value_type| matches!(value_type.as_str(), "select" | "checkbox"))
        })
    };
    let empty_groups_supported = finite(&view.config.presentation.group)
        && (view.config.presentation.subgroup.is_none()
            || finite(&view.config.presentation.subgroup));
    if !empty_groups_supported {
        view.config.presentation.display.show_empty_groups = false;
    }
    normalize_completion_capability(
        &mut view.config.presentation.completion,
        view.task_status_capable,
    );
    view.completion_cutoff = completion_cutoff(&view.config.presentation.completion)?;
    Ok(())
}

fn view_group_override(
    input: &DatabaseViewGroupOverrideInput,
) -> Result<Option<ViewGroup>, StoreError> {
    match input {
        DatabaseViewGroupOverrideInput::None => Ok(None),
        DatabaseViewGroupOverrideInput::Property { property_id } => {
            validate_property_id(property_id)?;
            Ok(Some(ViewGroup {
                property_id: property_id.clone(),
            }))
        }
    }
}

fn view_field_override(input: &DatabaseViewFieldInput) -> Result<ViewField, StoreError> {
    match input {
        DatabaseViewFieldInput::Property { property_id } => {
            validate_property_id(property_id)?;
            Ok(ViewField::Property {
                property_id: property_id.clone(),
            })
        }
        DatabaseViewFieldInput::Intrinsic { field } => Ok(ViewField::Intrinsic { field: *field }),
    }
}

fn apply_definition_override(
    definition: &mut ViewConfig,
    input: &DatabaseViewPreferencesOverrideInput,
) -> Result<(), StoreError> {
    let rules_override = &input.rules_override;
    if let Some(property_filters) = &rules_override.property_filters {
        definition.rules.property_filters = property_filters.clone();
    }
    if let Some(advanced_filter) = &rules_override.advanced_filter {
        definition.rules.advanced_filter = match advanced_filter {
            DatabaseViewAdvancedFilterOverrideInput::None => None,
            DatabaseViewAdvancedFilterOverrideInput::Filter { filter } => Some(filter.clone()),
        };
    }
    if let Some(sort) = &rules_override.sorts {
        if sort.len() > MAX_VIEW_SORT_RULES {
            return Err(invalid(
                "Database View rules override has too many sort rules",
            ));
        }
        let mut sort_fields = HashSet::new();
        for rule in sort {
            let identity = match &rule.field {
                DatabaseViewSortFieldInput::Manual => "manual".to_owned(),
                DatabaseViewSortFieldInput::Title => "title".to_owned(),
                DatabaseViewSortFieldInput::Created => "created".to_owned(),
                DatabaseViewSortFieldInput::Property { property_id } => {
                    format!("property:{property_id}")
                }
            };
            if !sort_fields.insert(identity) {
                return Err(invalid("Database View rules override sort fields repeat"));
            }
        }
        definition.rules.sorts = sort
            .iter()
            .map(|rule| {
                let field = match &rule.field {
                    DatabaseViewSortFieldInput::Manual => ViewSortField::Manual,
                    DatabaseViewSortFieldInput::Title => ViewSortField::Title,
                    DatabaseViewSortFieldInput::Created => ViewSortField::Created,
                    DatabaseViewSortFieldInput::Property { property_id } => {
                        validate_property_id(property_id)?;
                        ViewSortField::Property {
                            property_id: property_id.clone(),
                        }
                    }
                };
                Ok(ViewSort {
                    field,
                    direction: match rule.direction {
                        DatabaseViewSortDirectionInput::Asc => SortDirection::Asc,
                        DatabaseViewSortDirectionInput::Desc => SortDirection::Desc,
                    },
                    nulls: match rule.nulls {
                        DatabaseViewNullOrderInput::First => NullOrder::First,
                        DatabaseViewNullOrderInput::Last => NullOrder::Last,
                    },
                })
            })
            .collect::<Result<Vec<_>, StoreError>>()?;
    }
    let presentation = &mut definition.presentation;
    let input = &input.presentation_override;
    if let Some(group) = &input.group {
        presentation.group = view_group_override(group)?;
    }
    if let Some(subgroup) = &input.subgroup {
        presentation.subgroup = view_group_override(subgroup)?;
    }
    if let Some(direction) = input.group_direction {
        presentation.group_direction = match direction {
            DatabaseViewSortDirectionInput::Asc => SortDirection::Asc,
            DatabaseViewSortDirectionInput::Desc => SortDirection::Desc,
        };
    }
    if presentation.group.as_ref().is_some_and(|group| {
        presentation
            .subgroup
            .as_ref()
            .is_some_and(|subgroup| subgroup.property_id == group.property_id)
    }) {
        return Err(invalid(
            "Database View presentation override group and subgroup must be different",
        ));
    }
    if let Some(completion) = &input.completion {
        if let Some(range) = completion.range {
            presentation.completion.range = match range {
                DatabaseViewCompletedRangeInput::All => ViewCompletedRange::All,
                DatabaseViewCompletedRangeInput::PastMonth => ViewCompletedRange::PastMonth,
                DatabaseViewCompletedRangeInput::PastWeek => ViewCompletedRange::PastWeek,
                DatabaseViewCompletedRangeInput::PastDay => ViewCompletedRange::PastDay,
                DatabaseViewCompletedRangeInput::None => ViewCompletedRange::None,
            };
        }
        if let Some(order_by_recency) = completion.order_by_recency {
            presentation.completion.order_by_recency = order_by_recency;
        }
    }
    if let Some(hierarchy) = &input.hierarchy {
        if let Some(show_sub_pages) = hierarchy.show_sub_pages {
            presentation.hierarchy.show_sub_pages = show_sub_pages;
        }
        if let Some(nested_sub_pages) = hierarchy.nested_sub_pages {
            presentation.hierarchy.nested_sub_pages = nested_sub_pages;
        }
        if !presentation.hierarchy.show_sub_pages {
            presentation.hierarchy.nested_sub_pages = false;
        }
    }
    if let Some(source) = &input.display {
        let target = &mut presentation.display;
        if let Some(fields) = &source.fields {
            if fields.len() > MAX_DISPLAY_PROPERTIES {
                return Err(invalid(
                    "Database View presentation override displays too many Properties",
                ));
            }
            target.fields = fields
                .iter()
                .map(view_field_override)
                .collect::<Result<Vec<_>, _>>()?;
        }
        if let Some(property_order) = &source.property_order {
            if property_order.len() > super::MAX_DATA_SOURCE_PROPERTIES {
                return Err(invalid(
                    "Database View presentation override orders too many Properties",
                ));
            }
            let mut seen = BTreeSet::new();
            for property_id in property_order {
                validate_property_id(property_id)?;
                if !seen.insert(property_id) {
                    return Err(invalid(
                        "Database View presentation override Property order repeats identities",
                    ));
                }
            }
            target.property_order = property_order.clone();
        }
        if let Some(show_empty_groups) = source.show_empty_groups {
            target.show_empty_groups = show_empty_groups;
        }
        if let Some(show_description) = source.show_description {
            target.show_description = show_description;
        }
    }
    Ok(())
}

pub(super) fn validate_preferences_override(
    connection: &Connection,
    library_id: &str,
    actor_project_id: &str,
    authority_project_id: Option<&str>,
    view_id: &str,
    preferences_override: &DatabaseViewPreferencesOverrideInput,
) -> Result<(), StoreError> {
    let mut view = resolve_view(connection, library_id, view_id)?;
    apply_definition_override(&mut view.config, preferences_override)?;
    refresh_effective_presentation(connection, &mut view)?;
    super::mutation::validate_view_definition(
        connection,
        library_id,
        actor_project_id,
        &view.data_source_id,
        &view.config,
        authority_project_id.is_none(),
    )
}

fn summary_by_id(
    connection: &Connection,
    view: &ResolvedView,
    page_id: &str,
) -> Result<Option<DatabaseRowSummary>, StoreError> {
    let mut parameters = Vec::new();
    let (effective_group, effective_subgroup) =
        effective_group_expressions(&view.config, &mut parameters)?;
    let effective_group_select = effective_group.as_deref().unwrap_or("NULL");
    let effective_subgroup_select = effective_subgroup.as_deref().unwrap_or("NULL");
    let view_parameter = bind(&mut parameters, SqlValue::Text(view.view_id.clone()));
    let source_parameter = bind(&mut parameters, SqlValue::Text(view.data_source_id.clone()));
    let database_parameter = bind(&mut parameters, SqlValue::Text(view.database_id.clone()));
    let page_parameter = bind(&mut parameters, SqlValue::Text(page_id.to_owned()));
    let (database_values_projection, property_revisions_projection) =
        compact_value_projections(&view.config, &mut parameters)?;
    let sql = format!(
        "SELECT model.page_block_id, \
               CASE WHEN key_assignment.number IS NULL THEN NULL \
                 ELSE key_prefix.normalized_prefix || '-' || key_assignment.number END, \
               model.lifecycle, model.title, \
               materialization.title_rich_json, model.description_preview, \
               model.description_length, model.has_description, {database_values_projection}, \
               model.intrinsic_properties_json, \
               {property_revisions_projection}, \
               model.metadata_revision, model.placement_revision, model.document_id, \
               model.document_generation, model.document_projected_seq, membership.id, \
               membership.revision, membership.created_at, model.created_at, model.updated_at, \
               {effective_group_select} AS effective_group_key, \
               {effective_subgroup_select} AS effective_subgroup_key, {POSITION_RANK}, \
               {POSITION_REVISION}, ({position_order}), \
               hierarchy.target_page_block_id, hierarchy.sibling_rank, \
               parent_value.revision \
             FROM data_source_page_memberships membership \
             JOIN page_read_model model \
               ON model.page_block_id = membership.page_block_id \
               AND model.membership_id = membership.id \
             JOIN documents document \
               ON document.id = model.document_id \
               AND document.generation = model.document_generation \
               AND document.head_seq = model.document_projected_seq \
             JOIN document_materializations materialization \
               ON materialization.document_id = document.id \
               AND materialization.generation = document.generation \
               AND materialization.projected_seq = document.head_seq \
               AND materialization.schema_version = document.schema_version \
             LEFT JOIN page_key_assignments key_assignment \
               ON key_assignment.database_block_id = {database_parameter} \
                 AND key_assignment.page_block_id = membership.page_block_id \
             LEFT JOIN page_key_prefixes key_prefix \
               ON key_prefix.database_block_id = key_assignment.database_block_id \
                 AND key_prefix.retired_at IS NULL \
             {position_read_joins} \
             JOIN data_source_property_values parent_value \
               ON parent_value.data_source_id = membership.data_source_id \
               AND parent_value.membership_id = membership.id \
               AND parent_value.property_id = 'task_parent' \
               AND parent_value.value_type = 'relation' \
               AND json_type(parent_value.value_json) = 'null' \
             LEFT JOIN data_source_relation_edges hierarchy \
               ON hierarchy.source_data_source_id = membership.data_source_id \
               AND hierarchy.source_membership_id = membership.id \
               AND hierarchy.property_id = 'task_parent' \
               AND EXISTS (\
                 SELECT 1 FROM data_source_page_memberships parent_membership \
                 JOIN page_read_model parent_model \
                   ON parent_model.page_block_id = parent_membership.page_block_id \
                  AND parent_model.membership_id = parent_membership.id \
                 WHERE parent_membership.data_source_id = membership.data_source_id \
                   AND parent_membership.page_block_id = hierarchy.target_page_block_id \
                   AND parent_membership.removed_at IS NULL \
                   AND parent_model.lifecycle = 'active'\
               ) \
             WHERE membership.data_source_id = {source_parameter} \
               AND membership.removed_at IS NULL \
               AND model.lifecycle <> 'deleted' AND model.page_block_id = {page_parameter}",
        position_read_joins = position_joins(&view_parameter, "model.page_block_id"),
        position_order =
            super::order_read::preceding_positions(&view_parameter, "model.page_block_id"),
    );
    connection
        .query_row(&sql, params_from_iter(parameters.iter()), |row| {
            summary_from_row(row, 0).map(|row| row.summary)
        })
        .optional()
        .map_err(StoreError::from)
}

fn summary_from_row(row: &Row<'_>, sort_component_count: usize) -> rusqlite::Result<SummaryRow> {
    let page_id = row.get::<_, String>(0)?;
    let database_values = parse_json_map(row.get::<_, String>(8)?, "Database values")?;
    let intrinsic_properties = parse_json_map(row.get::<_, String>(9)?, "intrinsic properties")?;
    let property_revisions = parse_json_map(row.get::<_, String>(10)?, "Property revisions")?;
    let database_value_revisions = property_revisions
        .get("database")
        .and_then(Value::as_object)
        .ok_or(rusqlite::Error::InvalidQuery)?
        .iter()
        .map(|(property_id, value)| {
            let revision = value.as_i64().ok_or(rusqlite::Error::InvalidQuery)?;
            Ok((property_id.clone(), revision))
        })
        .collect::<rusqlite::Result<BTreeMap<_, _>>>()?;
    let coordinate_values = (0..sort_component_count)
        .map(|index| row.get::<_, SqlValue>(SUMMARY_COLUMN_COUNT + index))
        .map(|value| value.and_then(keyset_value_from_sql))
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(SummaryRow {
        summary: DatabaseRowSummary {
            page_id,
            page_key: row.get(1)?,
            lifecycle: row.get(2)?,
            title: row.get(3)?,
            rich_title: parse_json_value(row.get::<_, String>(4)?, "Page rich title")?,
            description_preview: row.get(5)?,
            description_length: row.get(6)?,
            has_description: row.get::<_, i64>(7)? != 0,
            database_values,
            intrinsic_properties,
            database_value_revisions,
            metadata_revision: row.get(11)?,
            parent_revision: row.get(12)?,
            document_id: row.get(13)?,
            document_generation: row.get(14)?,
            document_head_seq: row.get(15)?,
            membership_id: row.get(16)?,
            membership_revision: row.get(17)?,
            membership_created_at: row.get(18)?,
            created_at: row.get(19)?,
            updated_at: row.get(20)?,
            effective_group_key: row.get(21)?,
            effective_subgroup_key: row.get(22)?,
            rank_key: row.get(23)?,
            position_revision: row.get(24)?,
            position_order: row.get(25)?,
            task_parent_page_id: row.get(26)?,
            task_sibling_rank: row.get(27)?,
            task_parent_value_revision: row.get(28)?,
        },
        coordinate_values,
    })
}

fn compact_value_projections(
    config: &ViewConfig,
    parameters: &mut Vec<SqlValue>,
) -> Result<(String, String), StoreError> {
    compact_value_projections_with(config, &BTreeSet::new(), parameters)
}

fn compact_value_projections_with(
    config: &ViewConfig,
    additional_property_ids: &BTreeSet<String>,
    parameters: &mut Vec<SqlValue>,
) -> Result<(String, String), StoreError> {
    let property_ids = projected_property_ids_with(config, additional_property_ids)?;
    if property_ids.is_empty() {
        return Ok(("'{}'".to_owned(), "'{\"database\":{}}'".to_owned()));
    }
    let placeholders = property_ids
        .into_iter()
        .map(|property_id| bind(parameters, SqlValue::Text(property_id)))
        .collect::<Vec<_>>()
        .join(", ");
    let predicate = format!("value.property_id IN ({placeholders})");
    let canonical_values = format!(
        "COALESCE((SELECT json_group_object(value.property_id, json(value.value_json)) \
         FROM data_source_property_values value \
         WHERE value.data_source_id = membership.data_source_id \
           AND value.membership_id = membership.id AND {predicate}), '{{}}')"
    );
    let revisions = format!(
        "json_object('database', json(COALESCE(( \
           SELECT json_group_object(value.property_id, value.revision) \
           FROM data_source_property_values value \
           WHERE value.data_source_id = membership.data_source_id \
             AND value.membership_id = membership.id AND {predicate} \
         ), '{{}}')))"
    );
    Ok((canonical_values, revisions))
}

fn projected_property_ids(config: &ViewConfig) -> Result<BTreeSet<String>, StoreError> {
    projected_property_ids_with(config, &BTreeSet::new())
}

fn projected_property_ids_with(
    config: &ViewConfig,
    additional_property_ids: &BTreeSet<String>,
) -> Result<BTreeSet<String>, StoreError> {
    let mut property_ids = BTreeSet::new();
    {
        let layout = &config.presentation.display;
        if layout.fields.len() > MAX_DISPLAY_PROPERTIES {
            return Err(invalid("Database View displays too many Properties"));
        }
        property_ids.extend(layout.fields.iter().filter_map(|field| match field {
            ViewField::Property { property_id } => Some(property_id.clone()),
            ViewField::Intrinsic { .. } => None,
        }));
    }
    if let Some(group) = &config.presentation.group {
        property_ids.insert(group.property_id.clone());
    }
    property_ids.extend(
        COMPATIBILITY_CARD_PROPERTY_IDS
            .into_iter()
            .map(str::to_owned),
    );
    property_ids.extend(additional_property_ids.iter().cloned());
    for property_id in &property_ids {
        validate_property_id(property_id)?;
    }
    Ok(property_ids)
}

/// SQL expression for a row's effective group key, the single source of truth
/// consumed by the summary projection, the sort order, group scoping, and
/// group totals. The grouping Property value is normalized so NULL, empty
/// strings, and empty lists all
/// mean "unassigned" (SQL NULL), while numbers, booleans, and composite values
/// group by their canonical JSON text. Manual position never owns grouping.
fn effective_group_expressions(
    config: &ViewConfig,
    parameters: &mut Vec<SqlValue>,
) -> Result<(Option<String>, Option<String>), StoreError> {
    Ok((
        config
            .presentation
            .group
            .as_ref()
            .map(|group| group_expression(group, parameters))
            .transpose()?,
        config
            .presentation
            .subgroup
            .as_ref()
            .map(|group| group_expression(group, parameters))
            .transpose()?,
    ))
}

fn group_expression(
    group: &ViewGroup,
    parameters: &mut Vec<SqlValue>,
) -> Result<String, StoreError> {
    let raw_json = canonical_property_value_json_expression(&group.property_id, parameters)?;
    let raw = format!("json_extract({raw_json}, '$')");
    let raw_type = format!("json_type({raw_json}, '$')");
    Ok(format!(
        "CASE {raw_type} \
           WHEN 'true' THEN 'true' \
           WHEN 'false' THEN 'false' \
           WHEN 'text' THEN NULLIF({raw}, '') \
           WHEN 'array' THEN \
             CASE WHEN json_array_length({raw}) = 0 THEN NULL ELSE {raw} END \
           WHEN 'null' THEN NULL \
           ELSE CAST({raw} AS TEXT) \
         END"
    ))
}

fn completed_status_expression(parameters: &mut Vec<SqlValue>) -> String {
    let raw_json = canonical_property_value_json_expression("status", parameters)
        .expect("built-in status Property identity");
    format!("json_extract({raw_json}, '$') IS 'ship'")
}

fn compile_completion_predicate(
    view: &ResolvedView,
    parameters: &mut Vec<SqlValue>,
) -> Result<String, StoreError> {
    match view.config.presentation.completion.range {
        ViewCompletedRange::All => Ok("1".to_owned()),
        ViewCompletedRange::None => {
            let completed = completed_status_expression(parameters);
            Ok(format!("NOT ({completed})"))
        }
        ViewCompletedRange::PastMonth
        | ViewCompletedRange::PastWeek
        | ViewCompletedRange::PastDay => {
            let cutoff = view
                .completion_cutoff
                .as_ref()
                .ok_or_else(|| corrupt("Database View completion cutoff is unavailable"))?;
            let cutoff = bind(parameters, SqlValue::Text(cutoff.clone()));
            let completed = completed_status_expression(parameters);
            Ok(format!(
                "NOT ({completed}) OR membership.completed_at >= {cutoff}"
            ))
        }
    }
}

fn group_scope_predicate(
    scope: &DatabaseGroupScope,
    effective_group: Option<&str>,
    effective_subgroup: Option<&str>,
    parameters: &mut Vec<SqlValue>,
) -> Result<String, StoreError> {
    let Some(expression) = effective_group else {
        return Err(invalid("Database View has no grouping to scope"));
    };
    let DatabaseGroupScope::Path {
        group_key,
        subgroup_key,
    } = scope;
    let primary = match group_key {
        Some(key) => {
            validate_identity(key, "Database View group key")?;
            let parameter = bind(parameters, SqlValue::Text(key.clone()));
            format!("{expression} IS {parameter}")
        }
        None => format!("{expression} IS NULL"),
    };
    let Some(subgroup_expression) = effective_subgroup else {
        if subgroup_key.is_some() {
            return Err(invalid("Database View has no subgrouping to scope"));
        }
        return Ok(primary);
    };
    let secondary = match subgroup_key {
        Some(key) => {
            validate_identity(key, "Database View subgroup key")?;
            let parameter = bind(parameters, SqlValue::Text(key.clone()));
            format!("{subgroup_expression} IS {parameter}")
        }
        None => format!("{subgroup_expression} IS NULL"),
    };
    Ok(format!("({primary}) AND ({secondary})"))
}

/// One effective-group-major total order shared by flat and group-scoped
/// windows: rows cluster by effective group (unassigned last), then manual
/// complete physical rank or the configured sort rules, then the stable
/// Page identity appended by the caller.
fn sort_components(
    config: &ViewConfig,
    effective_group: Option<&str>,
    effective_subgroup: Option<&str>,
    parameters: &mut Vec<SqlValue>,
) -> Result<Vec<SortComponent>, StoreError> {
    if config.rules.sorts.len() > MAX_VIEW_SORT_RULES {
        return Err(invalid("Database View has too many sort rules"));
    }
    let mut components = Vec::new();
    if let Some(expression) = effective_group {
        components.push(SortComponent {
            expression: format!("CASE WHEN {expression} IS NULL THEN 1 ELSE 0 END"),
            direction: SortDirection::Asc,
        });
        components.push(SortComponent {
            expression: expression.to_owned(),
            direction: SortDirection::Asc,
        });
    }
    if let Some(expression) = effective_subgroup {
        components.push(SortComponent {
            expression: format!("CASE WHEN {expression} IS NULL THEN 1 ELSE 0 END"),
            direction: SortDirection::Asc,
        });
        components.push(SortComponent {
            expression: expression.to_owned(),
            direction: SortDirection::Asc,
        });
    }
    let completed = config
        .presentation
        .completion
        .order_by_recency
        .then(|| completed_status_expression(parameters));
    if let Some(completed) = &completed {
        components.push(SortComponent {
            expression: format!("CASE WHEN {completed} THEN 1 ELSE 0 END"),
            direction: SortDirection::Asc,
        });
    }
    let active_expression = |expression: String| match &completed {
        Some(completed) => format!("CASE WHEN {completed} THEN NULL ELSE {expression} END"),
        None => expression,
    };
    if config.rules.sorts.is_empty() {
        let rank = active_expression(order_rank("membership.page_block_id"));
        components.push(SortComponent {
            expression: format!("CASE WHEN {rank} IS NULL THEN 1 ELSE 0 END"),
            direction: SortDirection::Asc,
        });
        components.push(SortComponent {
            expression: rank,
            direction: SortDirection::Asc,
        });
        if let Some(completed) = &completed {
            components.push(SortComponent {
                expression: format!(
                    "CASE WHEN {completed} THEN membership.completed_at ELSE NULL END"
                ),
                direction: SortDirection::Desc,
            });
        }
        return Ok(components);
    }
    for rule in &config.rules.sorts {
        let expression = active_expression(match &rule.field {
            ViewSortField::Manual => order_rank("membership.page_block_id"),
            ViewSortField::Title => "model.title".to_owned(),
            ViewSortField::Created => "model.created_at".to_owned(),
            ViewSortField::Property { property_id } => {
                let raw_json = canonical_property_value_json_expression(property_id, parameters)?;
                format!("json_extract({raw_json}, '$')")
            }
        });
        let null_rank = match rule.nulls {
            NullOrder::First => {
                format!("CASE WHEN {expression} IS NULL THEN 0 ELSE 1 END")
            }
            NullOrder::Last => {
                format!("CASE WHEN {expression} IS NULL THEN 1 ELSE 0 END")
            }
        };
        components.push(SortComponent {
            expression: null_rank,
            direction: SortDirection::Asc,
        });
        components.push(SortComponent {
            expression,
            direction: rule.direction,
        });
    }
    let has_explicit_manual = config
        .rules
        .sorts
        .iter()
        .any(|rule| rule.field == ViewSortField::Manual);
    if !has_explicit_manual
        && super::view_contract::fractional_order_direction(&config.rules.sorts).is_some()
    {
        let rank = active_expression(order_rank("membership.page_block_id"));
        components.push(SortComponent {
            expression: format!("CASE WHEN {rank} IS NULL THEN 1 ELSE 0 END"),
            direction: SortDirection::Asc,
        });
        components.push(SortComponent {
            expression: rank,
            direction: SortDirection::Asc,
        });
    }
    if let Some(completed) = &completed {
        components.push(SortComponent {
            expression: format!("CASE WHEN {completed} THEN membership.completed_at ELSE NULL END"),
            direction: SortDirection::Desc,
        });
    }
    Ok(components)
}

fn compile_filter(
    filter: &ViewFilter,
    parameters: &mut Vec<SqlValue>,
    depth: usize,
    nodes: &mut usize,
) -> Result<String, StoreError> {
    if depth > MAX_FILTER_DEPTH {
        return Err(invalid("Database View filter is too deep"));
    }
    *nodes += 1;
    if *nodes > MAX_FILTER_NODES {
        return Err(invalid("Database View filter has too many nodes"));
    }
    match filter {
        ViewFilter::Group { operator, children } => {
            let separator = match operator {
                FilterGroupOperator::And => " AND ",
                FilterGroupOperator::Or => " OR ",
            };
            if children.is_empty() {
                return Ok(match operator {
                    FilterGroupOperator::And => "1".to_owned(),
                    FilterGroupOperator::Or => "0".to_owned(),
                });
            }
            let children = children
                .iter()
                .map(|child| compile_filter(child, parameters, depth + 1, nodes))
                .collect::<Result<Vec<_>, _>>()?;
            Ok(format!("({})", children.join(separator)))
        }
        ViewFilter::Clause {
            property_id,
            operator,
            value,
        } => {
            let raw_json = canonical_property_value_json_expression(property_id, parameters)?;
            let edge_property = bind(parameters, SqlValue::Text(property_id.clone()));
            let current = format!("json_extract({raw_json}, '$')");
            let current_type = format!("json_type({raw_json}, '$')");
            let scalar_empty = format!(
                "({current_type} IS NULL OR {current_type} = 'null' \
                 OR ({current_type} = 'text' AND {current} = '') \
                 OR ({current_type} = 'array' AND json_array_length({current}) = 0))"
            );
            let edge_exists = format!(
                "EXISTS(SELECT 1 FROM data_source_relation_edges relation_edge \
                  WHERE relation_edge.source_data_source_id = membership.data_source_id \
                    AND relation_edge.source_membership_id = membership.id \
                    AND relation_edge.property_id = {edge_property})"
            );
            let empty = format!("({scalar_empty} AND NOT {edge_exists})");
            if matches!(operator, FilterOperator::IsEmpty) {
                return Ok(empty);
            }
            if matches!(operator, FilterOperator::IsNotEmpty) {
                return Ok(format!("NOT {empty}"));
            }
            let expected_value = value
                .as_ref()
                .and_then(Option::as_ref)
                .unwrap_or(&Value::Null);
            let expected = bind(
                parameters,
                SqlValue::Text(
                    serde_json::to_string(expected_value)
                        .map_err(|_| invalid("Database filter value is invalid"))?,
                ),
            );
            let expected_scalar = format!("json_extract({expected}, '$')");
            let equals = format!("({current} IS {expected_scalar})");
            let text_contains = format!(
                "({current_type} = 'text' AND instr(lower(CAST({current} AS TEXT)), \
                  lower(CAST({expected_scalar} AS TEXT))) > 0)"
            );
            let array_contains_any = format!(
                "({current_type} = 'array' AND EXISTS (SELECT 1 FROM json_each({current}) item \
                  WHERE item.value IN (SELECT expected_item.value FROM json_each({expected}) expected_item)))"
            );
            let array_contains_all = format!(
                "({current_type} = 'array' AND NOT EXISTS (SELECT 1 FROM json_each({expected}) expected_item \
                  WHERE NOT EXISTS (SELECT 1 FROM json_each({current}) item \
                    WHERE item.value IS expected_item.value)))"
            );
            let relation_contains = format!(
                "EXISTS(SELECT 1 FROM data_source_relation_edges relation_edge \
                  WHERE relation_edge.source_data_source_id = membership.data_source_id \
                    AND relation_edge.source_membership_id = membership.id \
                    AND relation_edge.property_id = {edge_property} \
                    AND (relation_edge.target_page_block_id IS {expected_scalar} \
                      OR relation_edge.target_page_block_id IN \
                        (SELECT expected_item.value FROM json_each({expected}) expected_item)))"
            );
            let expression = match operator {
                FilterOperator::Equals
                | FilterOperator::TextIs
                | FilterOperator::NumberEquals
                | FilterOperator::CheckboxIs
                | FilterOperator::SelectIs
                | FilterOperator::DateIs => equals,
                FilterOperator::NotEquals
                | FilterOperator::TextIsNot
                | FilterOperator::NumberDoesNotEqual
                | FilterOperator::CheckboxIsNot
                | FilterOperator::SelectIsNot
                | FilterOperator::DateIsNot => format!("NOT {equals}"),
                FilterOperator::Contains | FilterOperator::TextContains => text_contains,
                FilterOperator::NotContains | FilterOperator::TextDoesNotContain => {
                    format!("NOT {text_contains}")
                }
                FilterOperator::TextStartsWith => format!(
                    "({current_type} = 'text' AND lower(CAST({current} AS TEXT)) \
                      LIKE lower(CAST({expected_scalar} AS TEXT)) || '%')"
                ),
                FilterOperator::TextEndsWith => format!(
                    "({current_type} = 'text' AND lower(CAST({current} AS TEXT)) \
                      LIKE '%' || lower(CAST({expected_scalar} AS TEXT)))"
                ),
                FilterOperator::NumberGreaterThan => {
                    format!("(CAST({current} AS REAL) > CAST({expected_scalar} AS REAL))")
                }
                FilterOperator::NumberLessThan => {
                    format!("(CAST({current} AS REAL) < CAST({expected_scalar} AS REAL))")
                }
                FilterOperator::NumberGreaterThanOrEqualTo => {
                    format!("(CAST({current} AS REAL) >= CAST({expected_scalar} AS REAL))")
                }
                FilterOperator::NumberLessThanOrEqualTo => {
                    format!("(CAST({current} AS REAL) <= CAST({expected_scalar} AS REAL))")
                }
                FilterOperator::MultiSelectContains => array_contains_any,
                FilterOperator::MultiSelectDoesNotContain => format!("NOT {array_contains_any}"),
                FilterOperator::MultiSelectContainsAll => array_contains_all,
                FilterOperator::DateBefore => format!("({current} < {expected_scalar})"),
                FilterOperator::DateAfter => format!("({current} > {expected_scalar})"),
                FilterOperator::DateOnOrBefore => format!("({current} <= {expected_scalar})"),
                FilterOperator::DateOnOrAfter => format!("({current} >= {expected_scalar})"),
                FilterOperator::DateWithin => format!(
                    "({current} >= json_extract({expected}, '$.start') \
                      AND {current} <= json_extract({expected}, '$.end'))"
                ),
                FilterOperator::DateRelativeTo => {
                    let (direction, count, unit) = relative_date_parts(expected_value)?;
                    let sign = if direction == "past" { "-" } else { "+" };
                    let modifier =
                        bind(parameters, SqlValue::Text(format!("{sign}{count} {unit}")));
                    if direction == "past" {
                        format!(
                            "({current} >= datetime('now', {modifier}) AND {current} <= datetime('now'))"
                        )
                    } else {
                        format!(
                            "({current} >= datetime('now') AND {current} <= datetime('now', {modifier}))"
                        )
                    }
                }
                FilterOperator::RelationContains => relation_contains,
                FilterOperator::RelationDoesNotContain => format!("NOT {relation_contains}"),
                FilterOperator::IsEmpty | FilterOperator::IsNotEmpty => unreachable!(),
            };
            Ok(expression)
        }
    }
}

fn relative_date_parts(value: &Value) -> Result<(&str, u64, &str), StoreError> {
    let direction = value
        .get("direction")
        .and_then(Value::as_str)
        .filter(|direction| matches!(*direction, "past" | "future"))
        .ok_or_else(|| invalid("Relative date direction is invalid"))?;
    let count = value
        .get("count")
        .and_then(Value::as_u64)
        .filter(|count| *count > 0 && *count <= 10_000)
        .ok_or_else(|| invalid("Relative date count is invalid"))?;
    let unit = value
        .get("unit")
        .and_then(Value::as_str)
        .filter(|unit| matches!(*unit, "day" | "week" | "month" | "year"))
        .ok_or_else(|| invalid("Relative date unit is invalid"))?;
    Ok((direction, count, unit))
}

fn compile_keyset_predicate(
    components: &[SortComponent],
    coordinate: &KeysetCoordinate,
    parameters: &mut Vec<SqlValue>,
) -> Result<String, StoreError> {
    let mut disjunctions = Vec::new();
    let mut equal_prefix = Vec::new();
    for (index, (component, value)) in components.iter().zip(&coordinate.values).enumerate() {
        let parameter = bind(parameters, sql_value_from_keyset(value)?);
        if !matches!(value, KeysetValue::Null) {
            let comparator = match component.direction {
                SortDirection::Asc => ">",
                SortDirection::Desc => "<",
            };
            disjunctions.push(format!(
                "({prefix}sort_{index} {comparator} {parameter})",
                prefix = equality_prefix(&equal_prefix),
            ));
        }
        equal_prefix.push(format!("sort_{index} IS {parameter}"));
    }
    let stable_id = bind(parameters, SqlValue::Text(coordinate.stable_id.clone()));
    disjunctions.push(format!(
        "({prefix}page_id > {stable_id})",
        prefix = equality_prefix(&equal_prefix),
    ));
    Ok(format!("({})", disjunctions.join(" OR ")))
}

fn equality_prefix(clauses: &[String]) -> String {
    if clauses.is_empty() {
        return String::new();
    }
    format!("{} AND ", clauses.join(" AND "))
}

fn validate_filter(filter: &ViewFilter, depth: usize, nodes: &mut usize) -> Result<(), StoreError> {
    if depth > MAX_FILTER_DEPTH {
        return Err(invalid("Database View filter is too deep"));
    }
    *nodes += 1;
    if *nodes > MAX_FILTER_NODES {
        return Err(invalid("Database View filter has too many nodes"));
    }
    match filter {
        ViewFilter::Group { children, .. } => {
            for child in children {
                validate_filter(child, depth + 1, nodes)?;
            }
        }
        ViewFilter::Clause { property_id, .. } => validate_property_id(property_id)?,
    }
    Ok(())
}

fn validate_page_ids(page_ids: &[String]) -> Result<(), StoreError> {
    if page_ids.is_empty() || page_ids.len() > MAX_ROWS_BY_ID {
        return Err(invalid("Database rows-by-ID request is out of range"));
    }
    let mut unique = BTreeSet::new();
    for page_id in page_ids {
        validate_identity(page_id, "Database Page identity")?;
        if !unique.insert(page_id) {
            return Err(invalid("Database rows-by-ID request repeats an identity"));
        }
    }
    Ok(())
}

fn validate_property_id(property_id: &str) -> Result<(), StoreError> {
    validate_identity(property_id, "Database Property identity")?;
    if property_id
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b':' | b'.'))
    {
        return Ok(());
    }
    Err(invalid("Database Property identity is not JSON-path safe"))
}

/// Correlated scalar expression for one canonical Property JSON value.
/// `page_read_model.database_values_json` is a display/search projection and
/// may contain names for select-like values, so query identity never reads it.
fn canonical_property_value_json_expression(
    property_id: &str,
    parameters: &mut Vec<SqlValue>,
) -> Result<String, StoreError> {
    validate_property_id(property_id)?;
    let property = bind(parameters, SqlValue::Text(property_id.to_owned()));
    Ok(format!(
        "(SELECT property_value.value_json \
         FROM data_source_property_values property_value \
         WHERE property_value.data_source_id = membership.data_source_id \
           AND property_value.membership_id = membership.id \
           AND property_value.property_id = {property})"
    ))
}

fn validate_identity(value: &str, label: &str) -> Result<(), StoreError> {
    if !value.is_empty() && value.len() <= 512 && value.trim() == value {
        return Ok(());
    }
    Err(invalid(&format!("{label} is invalid")))
}

fn bind(parameters: &mut Vec<SqlValue>, value: SqlValue) -> String {
    parameters.push(value);
    format!("?{}", parameters.len())
}

fn direction_sql(direction: SortDirection) -> &'static str {
    match direction {
        SortDirection::Asc => "ASC",
        SortDirection::Desc => "DESC",
    }
}

fn keyset_value_from_sql(value: SqlValue) -> rusqlite::Result<KeysetValue> {
    match value {
        SqlValue::Null => Ok(KeysetValue::Null),
        SqlValue::Integer(value) => Ok(KeysetValue::Integer { value }),
        SqlValue::Real(value) if value.is_finite() => Ok(KeysetValue::Real {
            value: value.to_string(),
        }),
        SqlValue::Text(value) if value.len() <= 512 => Ok(KeysetValue::Text { value }),
        _ => Err(rusqlite::Error::InvalidQuery),
    }
}

fn sql_value_from_keyset(value: &KeysetValue) -> Result<SqlValue, StoreError> {
    match value {
        KeysetValue::Null => Ok(SqlValue::Null),
        KeysetValue::Integer { value } => Ok(SqlValue::Integer(*value)),
        KeysetValue::Real { value } => value
            .parse::<f64>()
            .ok()
            .filter(|value| value.is_finite())
            .map(SqlValue::Real)
            .ok_or_else(|| invalid("Database View cursor has an invalid numeric coordinate")),
        KeysetValue::Text { value } => Ok(SqlValue::Text(value.clone())),
    }
}

fn parse_json_map(value: String, label: &str) -> rusqlite::Result<BTreeMap<String, Value>> {
    serde_json::from_str(&value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            value.len(),
            rusqlite::types::Type::Text,
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("Database {label} projection is invalid: {error}"),
            )
            .into(),
        )
    })
}

fn parse_json_value(value: String, label: &str) -> rusqlite::Result<Value> {
    serde_json::from_str(&value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            value.len(),
            rusqlite::types::Type::Text,
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("Database {label} projection is invalid: {error}"),
            )
            .into(),
        )
    })
}

fn invalid(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message, false)
}

fn unauthorized(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::Unauthorized, message, false)
}

fn not_found(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::NotFound, message, false)
}

fn corrupt(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message, false)
}
