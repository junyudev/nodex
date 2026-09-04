use std::collections::{BTreeMap, BTreeSet, HashSet};

use nodex_core_contracts::database::{
    DatabaseListMoveEdge, DatabaseListMoveNormalizedTarget, DatabaseListMoveParentGuard,
    DatabaseListMovePropertyState, DatabaseListMoveRestoreRun, DatabaseListMoveSelection,
    DatabaseListMoveTarget, DatabaseListMoveUndoRecipe, DatabaseListProjectionExpectation,
    DatabaseListProjectionRow, DatabaseListTransientKind, DatabasePagePosition,
    DatabasePagePropertyAddress, DatabasePropertyValueEdit, DatabasePropertyValueInput,
    DatabasePropertyValueMutation, DatabaseTaskParentPage, DatabaseViewSortField,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;

use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

use super::mutation::PropertyRow;
use super::mutation::property_value_history::{current_property_state, input_from_value};
use super::window::{ListProjectionGraph, PresentedListProjection};

const MAX_LIST_MOVE_PAGES: usize = 4_096;

#[derive(Clone, Debug)]
pub(crate) struct DatabaseListParentRunPlan {
    pub(crate) pages: Vec<DatabaseTaskParentPage>,
    pub(crate) parent_page_id: Option<String>,
    pub(crate) before_page_id: Option<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct DatabaseListPositionRunPlan {
    pub(crate) pages: Vec<DatabasePagePosition>,
    pub(crate) before_page_id: Option<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct DatabaseListMovePlan {
    pub(crate) view_id: String,
    pub(crate) data_source_id: String,
    pub(crate) database_id: String,
    pub(crate) moved_page_ids: Vec<String>,
    pub(crate) move_root_page_ids: Vec<String>,
    pub(crate) property_edits: Vec<DatabasePropertyValueMutation>,
    pub(crate) parent_run: Option<DatabaseListParentRunPlan>,
    pub(crate) position_run: Option<DatabaseListPositionRunPlan>,
    pub(crate) normalized_target: DatabaseListMoveNormalizedTarget,
    pub(crate) undo_recipe: DatabaseListMoveUndoRecipe,
}

#[derive(Clone, Debug)]
pub(crate) struct DatabaseListUndoPlan {
    pub(crate) view_id: String,
    pub(crate) data_source_id: String,
    pub(crate) property_edits: Vec<DatabasePropertyValueMutation>,
    pub(crate) parent_runs: Vec<DatabaseListParentRunPlan>,
    pub(crate) position_runs: Vec<DatabaseListPositionRunPlan>,
    pub(crate) restored_page_ids: Vec<String>,
    pub(crate) undo_recipe: DatabaseListMoveUndoRecipe,
}

#[derive(Clone, Debug)]
struct ConcreteOccurrence {
    page_id: String,
    group_key: Option<String>,
    subgroup_key: Option<String>,
    summary: nodex_core_contracts::database::DatabaseRowSummary,
}

#[derive(Clone, Debug)]
struct ResolvedSources {
    concrete: Vec<ConcreteOccurrence>,
    moved_page_ids: Vec<String>,
    root_occurrence_indices: Vec<usize>,
    root_page_ids: Vec<String>,
}

type ListPageOccurrence<'a> = (
    &'a str,
    &'a nodex_core_contracts::database::DatabaseRowSummary,
    &'a [Option<String>],
    &'a [String],
    u32,
    bool,
    u32,
    DatabaseListTransientKind,
);

fn invalid(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message, false)
}

fn conflict(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::RevisionConflict, message, true)
}

fn not_found(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::NotFound, message, false)
}

fn corrupt(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message, false)
}

fn page_row(graph: &ListProjectionGraph, index: usize) -> Option<ListPageOccurrence<'_>> {
    let DatabaseListProjectionRow::Page {
        occurrence_key,
        summary,
        group_path,
        ancestor_page_ids,
        depth,
        has_children,
        subtree_occurrence_count,
        transient_kind,
        ..
    } = graph.rows.get(index)?
    else {
        return None;
    };
    Some((
        occurrence_key,
        summary,
        group_path,
        ancestor_page_ids,
        *depth,
        *has_children,
        *subtree_occurrence_count,
        *transient_kind,
    ))
}

fn group_path_parts(path: &[Option<String>]) -> (Option<String>, Option<String>) {
    (
        path.first().cloned().flatten(),
        path.get(1).cloned().flatten(),
    )
}

fn projection_matches(
    projection: &PresentedListProjection,
    expected: &DatabaseListProjectionExpectation,
) -> bool {
    let actual = &projection.authority;
    actual.scope.canonical_key == expected.scope_key
        && actual.scope.schema_version == expected.schema_version
        && actual.revision == expected.revision
        && actual.covered_commit_seq >= expected.covered_commit_seq
        && actual.effect_hash == expected.effect_hash
}

fn resolve_selected_indices(
    graph: &ListProjectionGraph,
    initiator_occurrence_key: &str,
    selection: &DatabaseListMoveSelection,
) -> Result<Vec<usize>, StoreError> {
    let initiator_index = graph
        .occurrence_index(initiator_occurrence_key)
        .ok_or_else(|| not_found("The dragged List occurrence is no longer available"))?;
    let Some((_, _, _, _, _, _, _, initiator_transient)) = page_row(graph, initiator_index) else {
        return Err(invalid("Only a Page occurrence can start a List drag"));
    };
    if initiator_transient != DatabaseListTransientKind::None {
        return Err(invalid("A transient hierarchy context row cannot be moved"));
    }

    let mut selected = match selection {
        DatabaseListMoveSelection::Explicit { occurrence_keys } => occurrence_keys
            .iter()
            .map(|key| {
                graph
                    .occurrence_index(key)
                    .ok_or_else(|| not_found("A selected List occurrence is no longer available"))
            })
            .collect::<Result<Vec<_>, _>>()?,
        DatabaseListMoveSelection::AllMatching {
            excluded_occurrence_keys,
        } => {
            let excluded = excluded_occurrence_keys
                .iter()
                .map(String::as_str)
                .collect::<HashSet<_>>();
            graph
                .rows
                .iter()
                .enumerate()
                .filter_map(|(index, row)| match row {
                    DatabaseListProjectionRow::Page {
                        occurrence_key,
                        transient_kind: DatabaseListTransientKind::None,
                        ..
                    } if !excluded.contains(occurrence_key.as_str()) => Some(index),
                    _ => None,
                })
                .collect()
        }
    };
    selected.sort_unstable();
    selected.dedup();
    let initiator_selected = selected.contains(&initiator_index);
    if !initiator_selected {
        return Ok(vec![initiator_index]);
    }
    selected.retain(|index| {
        page_row(graph, *index).is_some_and(|(_, _, _, _, _, _, _, transient)| {
            transient == DatabaseListTransientKind::None
        })
    });
    if selected.is_empty() {
        return Err(invalid("The List drag selection contains no movable Pages"));
    }
    if selected.len() > MAX_LIST_MOVE_PAGES {
        return Err(invalid(format!(
            "A List drag cannot select more than {MAX_LIST_MOVE_PAGES} occurrences"
        )));
    }
    Ok(selected)
}

fn resolve_sources(
    graph: &ListProjectionGraph,
    initiator_occurrence_key: &str,
    selection: &DatabaseListMoveSelection,
) -> Result<ResolvedSources, StoreError> {
    let selected_indices = resolve_selected_indices(graph, initiator_occurrence_key, selection)?;
    let selected_by_path = selected_indices
        .iter()
        .filter_map(|index| {
            page_row(graph, *index).map(|(_, summary, group_path, _, _, _, _, _)| {
                ((group_path.to_vec(), summary.page_id.clone()), *index)
            })
        })
        .collect::<BTreeMap<_, _>>();
    let root_occurrence_indices = selected_indices
        .into_iter()
        .filter(|index| {
            let Some((_, _, group_path, ancestors, _, _, _, _)) = page_row(graph, *index) else {
                return false;
            };
            !ancestors.iter().any(|ancestor_page_id| {
                selected_by_path.contains_key(&(group_path.to_vec(), ancestor_page_id.clone()))
            })
        })
        .collect::<Vec<_>>();

    let mut seen_occurrences = HashSet::new();
    let mut seen_pages = HashSet::new();
    let mut concrete = Vec::new();
    let mut moved_page_ids = Vec::new();
    let mut root_page_ids = Vec::new();
    let mut seen_roots = HashSet::new();
    for root_index in &root_occurrence_indices {
        let Some((_, root_summary, _, _, _, _, subtree_count, _)) = page_row(graph, *root_index)
        else {
            return Err(corrupt("A normalized List source root disappeared"));
        };
        if seen_roots.insert(root_summary.page_id.clone()) {
            root_page_ids.push(root_summary.page_id.clone());
        }
        let end = root_index
            .checked_add(
                usize::try_from(subtree_count)
                    .map_err(|_| invalid("List subtree size is invalid"))?,
            )
            .ok_or_else(|| invalid("List subtree boundary overflowed"))?;
        if end > graph.rows.len() {
            return Err(corrupt("List subtree metadata exceeds its projection"));
        }
        for index in *root_index..end {
            let Some((occurrence_key, summary, group_path, _, _, _, _, transient)) =
                page_row(graph, index)
            else {
                return Err(corrupt("A List subtree crossed a non-Page projection row"));
            };
            if !seen_occurrences.insert(occurrence_key.to_owned())
                || transient != DatabaseListTransientKind::None
            {
                continue;
            }
            let (group_key, subgroup_key) = group_path_parts(group_path);
            concrete.push(ConcreteOccurrence {
                page_id: summary.page_id.clone(),
                group_key,
                subgroup_key,
                summary: summary.clone(),
            });
            if seen_pages.insert(summary.page_id.clone()) {
                moved_page_ids.push(summary.page_id.clone());
            }
        }
    }
    if concrete.is_empty() || moved_page_ids.is_empty() || root_page_ids.is_empty() {
        return Err(invalid("The List drag has no concrete Page closure"));
    }
    if moved_page_ids.len() > MAX_LIST_MOVE_PAGES {
        return Err(invalid(format!(
            "A List drag cannot move more than {MAX_LIST_MOVE_PAGES} Pages"
        )));
    }
    Ok(ResolvedSources {
        concrete,
        moved_page_ids,
        root_occurrence_indices,
        root_page_ids,
    })
}

fn next_direct_child_outside_closure(
    graph: &ListProjectionGraph,
    target_index: usize,
    closure_page_ids: &HashSet<&str>,
) -> Option<String> {
    let (_, _, _, _, target_depth, _, subtree_count, _) = page_row(graph, target_index)?;
    let end = target_index.checked_add(usize::try_from(subtree_count).ok()?)?;
    for index in target_index + 1..end.min(graph.rows.len()) {
        let Some((_, summary, _, _, depth, _, _, _)) = page_row(graph, index) else {
            break;
        };
        if depth <= target_depth {
            break;
        }
        if depth == target_depth + 1 && !closure_page_ids.contains(summary.page_id.as_str()) {
            return Some(summary.page_id.clone());
        }
    }
    None
}

fn next_sibling_outside_closure(
    graph: &ListProjectionGraph,
    target_index: usize,
    closure_page_ids: &HashSet<&str>,
) -> Option<String> {
    let (_, target_summary, target_group_path, _, target_depth, _, subtree_count, _) =
        page_row(graph, target_index)?;
    let target_parent = target_summary.task_parent_page_id.as_deref();
    let mut index = target_index.checked_add(usize::try_from(subtree_count).ok()?)?;
    while index < graph.rows.len() {
        let (_, summary, group_path, _, depth, _, candidate_count, _) = page_row(graph, index)?;
        if group_path != target_group_path || depth < target_depth {
            return None;
        }
        if depth == target_depth
            && summary.task_parent_page_id.as_deref() == target_parent
            && !closure_page_ids.contains(summary.page_id.as_str())
        {
            return Some(summary.page_id.clone());
        }
        index = index.checked_add(usize::try_from(candidate_count).ok()?)?;
    }
    None
}

fn resolve_target(
    graph: &ListProjectionGraph,
    closure_page_ids: &HashSet<&str>,
    target: &DatabaseListMoveTarget,
) -> Result<DatabaseListMoveNormalizedTarget, StoreError> {
    match target {
        DatabaseListMoveTarget::Root => Ok(DatabaseListMoveNormalizedTarget {
            target_occurrence_key: None,
            target_page_id: None,
            parent_page_id: None,
            before_page_id: None,
            group_key: None,
            subgroup_key: None,
            depth: 0,
            edge: DatabaseListMoveEdge::Inside,
        }),
        DatabaseListMoveTarget::Group { occurrence_key } => {
            let row = graph
                .occurrence(occurrence_key)
                .ok_or_else(|| not_found("The List drop group is no longer available"))?;
            let (group_key, subgroup_key) = match row {
                DatabaseListProjectionRow::Group { group_key, .. } => (group_key.clone(), None),
                DatabaseListProjectionRow::Subgroup {
                    group_key,
                    subgroup_key,
                    ..
                } => (group_key.clone(), subgroup_key.clone()),
                DatabaseListProjectionRow::Page { .. } => {
                    return Err(invalid("A Page occurrence requires a Page drop edge"));
                }
            };
            Ok(DatabaseListMoveNormalizedTarget {
                target_occurrence_key: Some(occurrence_key.clone()),
                target_page_id: None,
                parent_page_id: None,
                before_page_id: None,
                group_key,
                subgroup_key,
                depth: 0,
                edge: DatabaseListMoveEdge::Inside,
            })
        }
        DatabaseListMoveTarget::Page {
            occurrence_key,
            edge,
        } => {
            let target_index = graph
                .occurrence_index(occurrence_key)
                .ok_or_else(|| not_found("The List drop Page is no longer available"))?;
            let Some((_, summary, group_path, _, depth, has_children, _, _)) =
                page_row(graph, target_index)
            else {
                return Err(invalid("The List drop target is not a Page occurrence"));
            };
            if closure_page_ids.contains(summary.page_id.as_str()) {
                return Err(invalid("A moved subtree cannot be dropped inside itself"));
            }
            let (group_key, subgroup_key) = group_path_parts(group_path);
            let (parent_page_id, before_page_id, prospective_depth) = match edge {
                DatabaseListMoveEdge::Before => (
                    summary.task_parent_page_id.clone(),
                    Some(summary.page_id.clone()),
                    depth,
                ),
                DatabaseListMoveEdge::After if has_children => (
                    Some(summary.page_id.clone()),
                    next_direct_child_outside_closure(graph, target_index, closure_page_ids),
                    depth.saturating_add(1),
                ),
                DatabaseListMoveEdge::After => (
                    summary.task_parent_page_id.clone(),
                    next_sibling_outside_closure(graph, target_index, closure_page_ids),
                    depth,
                ),
                DatabaseListMoveEdge::Inside => {
                    (Some(summary.page_id.clone()), None, depth.saturating_add(1))
                }
            };
            Ok(DatabaseListMoveNormalizedTarget {
                target_occurrence_key: Some(occurrence_key.clone()),
                target_page_id: Some(summary.page_id.clone()),
                parent_page_id,
                before_page_id,
                group_key,
                subgroup_key,
                depth: prospective_depth,
                edge: *edge,
            })
        }
    }
}

pub(crate) fn resolve_list_insertion_target(
    projection: &PresentedListProjection,
    expected_projection: &DatabaseListProjectionExpectation,
    target: &DatabaseListMoveTarget,
) -> Result<DatabaseListMoveNormalizedTarget, StoreError> {
    if !projection_matches(projection, expected_projection) {
        return Err(conflict(
            "The Database List projection changed during this drop",
        ));
    }
    resolve_target(&projection.graph, &HashSet::new(), target)
}

fn scalar_target_value(
    property: &PropertyRow,
    target_key: Option<&str>,
) -> Result<DatabasePropertyValueInput, StoreError> {
    let Some(target_key) = target_key else {
        return Ok(DatabasePropertyValueInput::Empty);
    };
    match property.value_type.as_str() {
        "text" => Ok(DatabasePropertyValueInput::Text {
            value: target_key.to_owned(),
        }),
        "number" => target_key
            .parse::<f64>()
            .map(|value| DatabasePropertyValueInput::Number { value })
            .map_err(|_| invalid("The target number group is invalid")),
        "checkbox" => target_key
            .parse::<bool>()
            .map(|value| DatabasePropertyValueInput::Checkbox { value })
            .map_err(|_| invalid("The target checkbox group is invalid")),
        "select" => Ok(DatabasePropertyValueInput::Select {
            option_id: target_key.to_owned(),
        }),
        "date" => Ok(DatabasePropertyValueInput::Date {
            value: target_key.to_owned(),
        }),
        "datetime" => Ok(DatabasePropertyValueInput::Datetime {
            value: target_key.to_owned(),
        }),
        "multi_select" => Err(corrupt(
            "Multi-select group adoption requires set semantics",
        )),
        _ => Err(invalid("This Property type cannot own a List group")),
    }
}

fn property_adoption(
    connection: &Connection,
    graph: &ListProjectionGraph,
    sources: &ResolvedSources,
    normalized: &DatabaseListMoveNormalizedTarget,
) -> Result<
    (
        Vec<DatabasePropertyValueMutation>,
        Vec<DatabaseListMovePropertyState>,
    ),
    StoreError,
> {
    let axes = [
        (
            graph
                .presentation
                .group
                .as_ref()
                .map(|group| group.property_id.as_str()),
            normalized.group_key.as_deref(),
            true,
        ),
        (
            graph
                .presentation
                .subgroup
                .as_ref()
                .map(|group| group.property_id.as_str()),
            normalized.subgroup_key.as_deref(),
            false,
        ),
    ];
    let first_occurrence = sources
        .concrete
        .iter()
        .map(|occurrence| (occurrence.page_id.as_str(), occurrence))
        .collect::<BTreeMap<_, _>>();
    let mut edits = Vec::new();
    let mut states = Vec::new();
    let mut seen_addresses = HashSet::new();
    for (property_id, target_key, primary_axis) in axes.iter().copied() {
        let Some(property_id) = property_id else {
            continue;
        };
        let property = super::active_property(connection, &graph.data_source_id, property_id)?;
        for page_id in &sources.moved_page_ids {
            let occurrence = first_occurrence
                .get(page_id.as_str())
                .ok_or_else(|| corrupt("A concrete List Page lost its source occurrence"))?;
            if !seen_addresses.insert((page_id.clone(), property_id.to_owned())) {
                return Err(invalid(
                    "A List cannot group and subgroup by the same Property",
                ));
            }
            let before_json = occurrence
                .summary
                .database_values
                .get(property_id)
                .cloned()
                .unwrap_or(Value::Null);
            let before_value = input_from_value(&property, &before_json)?;
            let after_value = if property.value_type == "multi_select" {
                let DatabasePropertyValueInput::MultiSelect { option_ids } = &before_value else {
                    return Err(corrupt("A grouped multi-select value is not a set"));
                };
                let source_keys = sources
                    .concrete
                    .iter()
                    .filter(|candidate| candidate.page_id == *page_id)
                    .filter_map(|candidate| {
                        if primary_axis {
                            candidate.group_key.as_deref()
                        } else {
                            candidate.subgroup_key.as_deref()
                        }
                    })
                    .collect::<BTreeSet<_>>();
                let mut next = option_ids
                    .iter()
                    .filter(|option_id| {
                        !source_keys.contains(option_id.as_str())
                            || Some(option_id.as_str()) == target_key
                    })
                    .cloned()
                    .collect::<Vec<_>>();
                if let Some(target_key) = target_key
                    && !next.iter().any(|option_id| option_id == target_key)
                {
                    next.push(target_key.to_owned());
                }
                DatabasePropertyValueInput::MultiSelect { option_ids: next }
            } else {
                scalar_target_value(&property, target_key)?
            };
            if before_value == after_value {
                continue;
            }
            let expected_value_revision = occurrence
                .summary
                .database_value_revisions
                .get(property_id)
                .copied()
                .unwrap_or(0);
            edits.push(DatabasePropertyValueMutation {
                address: DatabasePagePropertyAddress {
                    page_id: page_id.clone(),
                    data_source_id: graph.data_source_id.clone(),
                    property_id: property_id.to_owned(),
                },
                edit: DatabasePropertyValueEdit::Replace {
                    expected_value_revision,
                    value: after_value.clone(),
                },
            });
            states.push(DatabaseListMovePropertyState {
                page_id: page_id.clone(),
                property_id: property_id.to_owned(),
                before_value,
                after_value,
            });
        }
    }
    if normalized.parent_page_id.is_some() {
        return Ok((edits, states));
    }
    let moved = sources
        .moved_page_ids
        .iter()
        .map(String::as_str)
        .collect::<HashSet<_>>();
    for (property_id, target_json) in
        inferred_list_drop_sort_values(connection, graph, normalized, &moved)?
    {
        let property = super::active_property(connection, &graph.data_source_id, &property_id)?;
        let after_value = input_from_value(&property, &target_json)?;
        for page_id in &sources.root_page_ids {
            if !seen_addresses.insert((page_id.clone(), property_id.clone())) {
                continue;
            }
            let occurrence = first_occurrence
                .get(page_id.as_str())
                .ok_or_else(|| corrupt("A List move root lost its source occurrence"))?;
            let before_json = occurrence
                .summary
                .database_values
                .get(&property_id)
                .cloned()
                .unwrap_or(Value::Null);
            let before_value = input_from_value(&property, &before_json)?;
            if before_value == after_value {
                continue;
            }
            edits.push(DatabasePropertyValueMutation {
                address: DatabasePagePropertyAddress {
                    page_id: page_id.clone(),
                    data_source_id: graph.data_source_id.clone(),
                    property_id: property_id.clone(),
                },
                edit: DatabasePropertyValueEdit::Replace {
                    expected_value_revision: occurrence
                        .summary
                        .database_value_revisions
                        .get(&property_id)
                        .copied()
                        .unwrap_or(0),
                    value: after_value.clone(),
                },
            });
            states.push(DatabaseListMovePropertyState {
                page_id: page_id.clone(),
                property_id: property_id.clone(),
                before_value,
                after_value: after_value.clone(),
            });
        }
    }
    Ok((edits, states))
}

pub(crate) fn inferred_list_drop_sort_values(
    connection: &Connection,
    graph: &ListProjectionGraph,
    normalized: &DatabaseListMoveNormalizedTarget,
    ignored_page_ids: &HashSet<&str>,
) -> Result<Vec<(String, Value)>, StoreError> {
    if normalized.parent_page_id.is_some() || normalized.target_page_id.is_none() {
        return Ok(Vec::new());
    }
    let (before, after) = sorted_target_neighbors(graph, normalized, ignored_page_ids)?;
    let structural_property_ids = [
        graph
            .presentation
            .group
            .as_ref()
            .map(|group| group.property_id.as_str()),
        graph
            .presentation
            .subgroup
            .as_ref()
            .map(|group| group.property_id.as_str()),
    ];
    let mut values = Vec::new();
    for sort in &graph.sorts {
        let DatabaseViewSortField::Property { property_id } = &sort.field else {
            break;
        };
        if structural_property_ids.contains(&Some(property_id.as_str())) {
            continue;
        }
        let property = super::active_property(connection, &graph.data_source_id, property_id)?;
        if property.value_type == "relation" {
            break;
        }
        let before_json = before
            .and_then(|summary| summary.database_values.get(property_id))
            .cloned()
            .unwrap_or(Value::Null);
        let after_json = after
            .and_then(|summary| summary.database_values.get(property_id))
            .cloned()
            .unwrap_or(Value::Null);
        if before.is_none() && after.is_none() {
            break;
        }
        values.push((
            property_id.clone(),
            if after.is_some() {
                after_json.clone()
            } else {
                before_json.clone()
            },
        ));
        if before.is_none() || after.is_none() || before_json != after_json {
            break;
        }
    }
    Ok(values)
}

fn sorted_target_neighbors<'a>(
    graph: &'a ListProjectionGraph,
    normalized: &DatabaseListMoveNormalizedTarget,
    ignored_page_ids: &HashSet<&str>,
) -> Result<
    (
        Option<&'a nodex_core_contracts::database::DatabaseRowSummary>,
        Option<&'a nodex_core_contracts::database::DatabaseRowSummary>,
    ),
    StoreError,
> {
    let mut seen = HashSet::new();
    let peers = graph
        .rows
        .iter()
        .enumerate()
        .filter_map(|(index, _)| page_row(graph, index))
        .filter(|(_, summary, group_path, ..)| {
            let (group_key, subgroup_key) = group_path_parts(group_path);
            !ignored_page_ids.contains(summary.page_id.as_str())
                && summary.task_parent_page_id == normalized.parent_page_id
                && group_key == normalized.group_key
                && subgroup_key == normalized.subgroup_key
        })
        .filter_map(|(_, summary, ..)| seen.insert(summary.page_id.as_str()).then_some(summary))
        .collect::<Vec<_>>();
    let after_index = normalized
        .before_page_id
        .as_deref()
        .map(|page_id| {
            peers
                .iter()
                .position(|summary| summary.page_id == page_id)
                .ok_or_else(|| conflict("The List insertion anchor changed during this drag"))
        })
        .transpose()?
        .unwrap_or(peers.len());
    Ok((
        after_index
            .checked_sub(1)
            .and_then(|index| peers.get(index).copied()),
        peers.get(after_index).copied(),
    ))
}

fn fractional_root_order(graph: &ListProjectionGraph) -> bool {
    super::view_contract::fractional_order_direction(&graph.sorts).is_some()
}

fn fractional_root_order_descending(graph: &ListProjectionGraph) -> bool {
    super::view_contract::fractional_order_direction(&graph.sorts).is_some_and(|direction| {
        direction == nodex_core_contracts::database::DatabaseViewSortDirection::Desc
    })
}

fn ordered_child_pages(
    connection: &Connection,
    data_source_id: &str,
    parent_page_id: &str,
) -> Result<Vec<String>, StoreError> {
    connection
        .prepare(
            "SELECT membership.page_block_id \
             FROM data_source_relation_edges edge \
             JOIN data_source_page_memberships membership \
               ON membership.data_source_id = edge.source_data_source_id \
              AND membership.id = edge.source_membership_id \
              AND membership.removed_at IS NULL \
             WHERE edge.source_data_source_id = ?1 AND edge.property_id = 'task_parent' \
               AND edge.target_page_block_id = ?2 \
             ORDER BY edge.sibling_rank, membership.page_block_id",
        )?
        .query_map(params![data_source_id, parent_page_id], |row| {
            row.get::<_, String>(0)
        })?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(Into::into)
}

fn capture_root_runs(
    connection: &Connection,
    view_id: &str,
    selected: &HashSet<&str>,
    descending: bool,
) -> Result<Vec<DatabaseListMoveRestoreRun>, StoreError> {
    let order = super::manual_order::require_ready(connection, view_id)?;
    Ok(
        super::manual_order::capture_root_runs(connection, &order, selected, descending)?
            .into_iter()
            .map(|run| DatabaseListMoveRestoreRun {
                page_ids: run.page_ids,
                parent_page_id: None,
                before_page_id: run.before_page_id,
            })
            .collect(),
    )
}

fn contiguous_restore_runs(
    ordered_page_ids: &[String],
    selected_page_ids: &HashSet<&str>,
    parent_page_id: Option<String>,
) -> Result<Vec<DatabaseListMoveRestoreRun>, StoreError> {
    crate::domain::ordered_position::capture_position_runs(ordered_page_ids, selected_page_ids)
        .map_err(|_| corrupt("A List source root is missing from its original sibling run"))
        .map(|runs| {
            runs.into_iter()
                .map(|run| DatabaseListMoveRestoreRun {
                    page_ids: run.page_ids,
                    parent_page_id: parent_page_id.clone(),
                    before_page_id: run.before_page_id,
                })
                .collect()
        })
}

fn restore_runs(
    connection: &Connection,
    graph: &ListProjectionGraph,
    sources: &ResolvedSources,
) -> Result<Vec<DatabaseListMoveRestoreRun>, StoreError> {
    capture_current_runs(
        connection,
        &graph.data_source_id,
        &graph.view_id,
        &sources.root_page_ids,
    )
}

/// Capture logical sibling runs, including discontiguous roots and multiple parents.
fn capture_current_runs(
    connection: &Connection,
    data_source_id: &str,
    view_id: &str,
    page_ids: &[String],
) -> Result<Vec<DatabaseListMoveRestoreRun>, StoreError> {
    let mut by_parent = BTreeMap::<Option<String>, Vec<String>>::new();
    for page_id in page_ids {
        let (parent, _) = current_task_parent(connection, data_source_id, page_id)?;
        by_parent.entry(parent).or_default().push(page_id.clone());
    }
    let mut runs = Vec::new();
    for (parent_page_id, page_ids) in by_parent {
        let selected = page_ids.iter().map(String::as_str).collect::<HashSet<_>>();
        let Some(parent) = parent_page_id.as_deref() else {
            runs.extend(capture_root_runs(
                connection,
                view_id,
                &selected,
                view_manual_descending(connection, view_id)?.unwrap_or(false),
            )?);
            continue;
        };
        let ordered = ordered_child_pages(connection, data_source_id, parent)?;
        runs.extend(contiguous_restore_runs(
            &ordered,
            &selected,
            parent_page_id,
        )?);
    }
    Ok(runs)
}

fn sequence_matches_slot(
    ordered: &[String],
    moved: &[String],
    before_page_id: Option<&str>,
) -> bool {
    let moved_set = moved.iter().map(String::as_str).collect::<HashSet<_>>();
    let expected_insert = ordered
        .iter()
        .filter(|page_id| !moved_set.contains(page_id.as_str()))
        .position(|page_id| Some(page_id.as_str()) == before_page_id)
        .unwrap_or_else(|| {
            ordered
                .iter()
                .filter(|page_id| !moved_set.contains(page_id.as_str()))
                .count()
        });
    let mut desired = ordered
        .iter()
        .filter(|page_id| !moved_set.contains(page_id.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    desired.splice(expected_insert..expected_insert, moved.iter().cloned());
    desired == ordered
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn plan_list_occurrence_move(
    connection: &Connection,
    projection: &PresentedListProjection,
    expected_projection: &DatabaseListProjectionExpectation,
    initiator_occurrence_key: &str,
    selection: &DatabaseListMoveSelection,
    target: &DatabaseListMoveTarget,
) -> Result<DatabaseListMovePlan, StoreError> {
    if !projection_matches(projection, expected_projection) {
        return Err(conflict(
            "The Database List projection changed during this drag",
        ));
    }
    let graph = &projection.graph;
    let sources = resolve_sources(graph, initiator_occurrence_key, selection)?;
    let closure_page_ids = sources
        .moved_page_ids
        .iter()
        .map(String::as_str)
        .collect::<HashSet<_>>();
    let normalized_target = resolve_target(graph, &closure_page_ids, target)?;
    let (property_edits, property_states) =
        property_adoption(connection, graph, &sources, &normalized_target)?;
    let summaries = sources
        .root_occurrence_indices
        .iter()
        .filter_map(|index| page_row(graph, *index).map(|(_, summary, ..)| summary))
        .map(|summary| (summary.page_id.as_str(), summary))
        .collect::<BTreeMap<_, _>>();
    let parent_pages = sources
        .root_page_ids
        .iter()
        .map(|page_id| {
            let summary = summaries
                .get(page_id.as_str())
                .ok_or_else(|| corrupt("A List source root lost its Parent revision"))?;
            Ok(DatabaseTaskParentPage {
                page_id: page_id.clone(),
                expected_value_revision: summary.task_parent_value_revision,
            })
        })
        .collect::<Result<Vec<_>, StoreError>>()?;
    let all_parent_unchanged = sources.root_page_ids.iter().all(|page_id| {
        summaries
            .get(page_id.as_str())
            .is_some_and(|summary| summary.task_parent_page_id == normalized_target.parent_page_id)
    });
    let order_unchanged = if !all_parent_unchanged {
        false
    } else if let Some(parent) = normalized_target.parent_page_id.as_deref() {
        sequence_matches_slot(
            &ordered_child_pages(connection, &graph.data_source_id, parent)?,
            &sources.root_page_ids,
            normalized_target.before_page_id.as_deref(),
        )
    } else if fractional_root_order(graph) {
        let selected = sources.root_page_ids.iter().map(String::as_str).collect();
        let runs = capture_root_runs(
            connection,
            &graph.view_id,
            &selected,
            fractional_root_order_descending(graph),
        )?;
        matches!(runs.as_slice(), [run] if run.page_ids == sources.root_page_ids
            && run.before_page_id == normalized_target.before_page_id)
    } else {
        true
    };
    let hierarchy_ordered = normalized_target.parent_page_id.is_some();
    let root_ordered = normalized_target.parent_page_id.is_none() && fractional_root_order(graph);
    let parent_run =
        (!all_parent_unchanged || (hierarchy_ordered && !order_unchanged)).then(|| {
            DatabaseListParentRunPlan {
                pages: parent_pages,
                parent_page_id: normalized_target.parent_page_id.clone(),
                before_page_id: normalized_target
                    .parent_page_id
                    .as_ref()
                    .and(normalized_target.before_page_id.clone()),
            }
        });
    let position_run = (root_ordered && !order_unchanged).then(|| DatabaseListPositionRunPlan {
        pages: sources
            .root_page_ids
            .iter()
            .map(|page_id| {
                let summary = summaries
                    .get(page_id.as_str())
                    .expect("source root summary was validated");
                DatabasePagePosition {
                    page_id: page_id.clone(),
                    expected_position_revision: summary.position_revision.unwrap_or(0),
                }
            })
            .collect(),
        before_page_id: normalized_target.before_page_id.clone(),
    });
    if property_edits.is_empty() && parent_run.is_none() && position_run.is_none() {
        return Err(invalid("The moved Pages are already at this List position"));
    }
    let restore_runs = restore_runs(connection, graph, &sources)?;
    let undo_recipe = DatabaseListMoveUndoRecipe {
        view_id: graph.view_id.clone(),
        data_source_id: graph.data_source_id.clone(),
        property_states,
        post_parent_guards: sources
            .root_page_ids
            .iter()
            .map(|page_id| DatabaseListMoveParentGuard {
                page_id: page_id.clone(),
                parent_page_id: normalized_target.parent_page_id.clone(),
            })
            .collect(),
        post_order_runs: Vec::new(),
        restore_runs,
    };
    Ok(DatabaseListMovePlan {
        view_id: graph.view_id.clone(),
        data_source_id: graph.data_source_id.clone(),
        database_id: graph.database_id.clone(),
        moved_page_ids: sources.moved_page_ids,
        move_root_page_ids: sources.root_page_ids,
        property_edits,
        parent_run,
        position_run,
        normalized_target,
        undo_recipe,
    })
}

fn current_task_parent(
    connection: &Connection,
    data_source_id: &str,
    page_id: &str,
) -> Result<(Option<String>, i64), StoreError> {
    connection
        .query_row(
            "SELECT edge.target_page_block_id, value.revision \
             FROM data_source_page_memberships membership \
             JOIN data_source_property_values value \
               ON value.data_source_id = membership.data_source_id \
              AND value.membership_id = membership.id \
              AND value.property_id = 'task_parent' \
             LEFT JOIN data_source_relation_edges edge \
               ON edge.source_data_source_id = membership.data_source_id \
              AND edge.source_membership_id = membership.id \
              AND edge.property_id = 'task_parent' \
             WHERE membership.data_source_id = ?1 AND membership.page_block_id = ?2 \
               AND membership.removed_at IS NULL",
            params![data_source_id, page_id],
            |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()?
        .ok_or_else(|| not_found("An affected List Page is no longer active"))
}

fn current_position_revision(
    connection: &Connection,
    view_id: &str,
    page_id: &str,
) -> Result<i64, StoreError> {
    Ok(connection
        .query_row(
            "SELECT revision FROM database_view_page_positions \
             WHERE view_id = ?1 AND page_block_id = ?2",
            params![view_id, page_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
        .unwrap_or(0))
}

fn view_manual_descending(
    connection: &Connection,
    view_id: &str,
) -> Result<Option<bool>, StoreError> {
    let config_json = connection
        .query_row(
            "SELECT config_json FROM database_views WHERE id = ?1 AND lifecycle = 'active'",
            [view_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .ok_or_else(|| not_found("The Database View is no longer active"))?;
    let definition = super::view_contract::decode_definition_json(&config_json).map_err(corrupt)?;
    Ok(
        super::view_contract::fractional_order_direction(&definition.rules.sorts).map(
            |direction| {
                direction == nodex_core_contracts::database::DatabaseViewSortDirection::Desc
            },
        ),
    )
}

fn order_guard_matches(
    connection: &Connection,
    recipe: &DatabaseListMoveUndoRecipe,
) -> Result<bool, StoreError> {
    let mut by_parent = BTreeMap::<Option<String>, Vec<DatabaseListMoveRestoreRun>>::new();
    for run in &recipe.post_order_runs {
        by_parent
            .entry(run.parent_page_id.clone())
            .or_default()
            .push(run.clone());
    }
    for (parent, mut expected) in by_parent {
        let selected = expected
            .iter()
            .flat_map(|run| run.page_ids.iter().map(String::as_str))
            .collect::<HashSet<_>>();
        let mut current = match parent.as_deref() {
            Some(parent_id) => contiguous_restore_runs(
                &ordered_child_pages(connection, &recipe.data_source_id, parent_id)?,
                &selected,
                parent.clone(),
            )?,
            None => {
                let Some(descending) = view_manual_descending(connection, &recipe.view_id)? else {
                    return Err(conflict("The List order mode changed after the move"));
                };
                capture_root_runs(connection, &recipe.view_id, &selected, descending)?
            }
        };
        // Recipe run order is not authority; compare the complete sibling slots.
        expected.sort_by(|left, right| left.page_ids.cmp(&right.page_ids));
        current.sort_by(|left, right| left.page_ids.cmp(&right.page_ids));
        if current != expected {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Finish the inverse from the actual committed post-image, inside the same transaction.
pub(crate) fn finish_list_inverse(
    connection: &Connection,
    mut inverse: DatabaseListMoveUndoRecipe,
) -> Result<DatabaseListMoveUndoRecipe, StoreError> {
    for state in &mut inverse.property_states {
        let (_, value, _) = current_property_state(
            connection,
            &inverse.data_source_id,
            &state.page_id,
            &state.property_id,
        )?;
        state.after_value = value;
    }
    for guard in &mut inverse.post_parent_guards {
        guard.parent_page_id =
            current_task_parent(connection, &inverse.data_source_id, &guard.page_id)?.0;
    }
    let roots = inverse
        .post_parent_guards
        .iter()
        .map(|guard| guard.page_id.clone())
        .collect::<Vec<_>>();
    let manual = view_manual_descending(connection, &inverse.view_id)?.is_some();
    inverse.post_order_runs = capture_current_runs(
        connection,
        &inverse.data_source_id,
        &inverse.view_id,
        &roots,
    )?
    .into_iter()
    .filter(|run| run.parent_page_id.is_some() || manual)
    .collect();
    Ok(inverse)
}

pub(crate) fn plan_list_occurrence_move_undo(
    connection: &Connection,
    recipe: &DatabaseListMoveUndoRecipe,
) -> Result<DatabaseListUndoPlan, StoreError> {
    if recipe.post_parent_guards.is_empty() || recipe.restore_runs.is_empty() {
        return Err(invalid("The List move Undo recipe is empty"));
    }
    let mut property_edits = Vec::new();
    for state in &recipe.property_states {
        let (_, current, current_revision) = current_property_state(
            connection,
            &recipe.data_source_id,
            &state.page_id,
            &state.property_id,
        )?;
        if current != state.after_value {
            return Err(conflict(
                "A moved Page Property changed after the drag and cannot be undone safely",
            ));
        }
        property_edits.push(DatabasePropertyValueMutation {
            address: DatabasePagePropertyAddress {
                page_id: state.page_id.clone(),
                data_source_id: recipe.data_source_id.clone(),
                property_id: state.property_id.clone(),
            },
            edit: DatabasePropertyValueEdit::Replace {
                expected_value_revision: current_revision,
                value: state.before_value.clone(),
            },
        });
    }
    for guard in &recipe.post_parent_guards {
        let (current_parent, _) =
            current_task_parent(connection, &recipe.data_source_id, &guard.page_id)?;
        if current_parent != guard.parent_page_id {
            return Err(conflict(
                "A moved Page hierarchy changed after the drag and cannot be undone safely",
            ));
        }
    }
    if !order_guard_matches(connection, recipe)? {
        return Err(conflict(
            "The moved Page order changed after the drag and cannot be undone safely",
        ));
    }

    let mut parent_runs = Vec::new();
    let mut position_runs = Vec::new();
    let roots = recipe
        .post_parent_guards
        .iter()
        .map(|guard| guard.page_id.clone())
        .collect::<Vec<_>>();
    let mut undo_recipe = recipe.clone();
    undo_recipe.restore_runs =
        capture_current_runs(connection, &recipe.data_source_id, &recipe.view_id, &roots)?;
    for state in &mut undo_recipe.property_states {
        std::mem::swap(&mut state.before_value, &mut state.after_value);
    }
    for run in recipe.restore_runs.iter().rev() {
        let pages = run
            .page_ids
            .iter()
            .map(|page_id| {
                current_task_parent(connection, &recipe.data_source_id, page_id).map(
                    |(_, expected_value_revision)| DatabaseTaskParentPage {
                        page_id: page_id.clone(),
                        expected_value_revision,
                    },
                )
            })
            .collect::<Result<Vec<_>, _>>()?;
        parent_runs.push(DatabaseListParentRunPlan {
            pages,
            parent_page_id: run.parent_page_id.clone(),
            before_page_id: run.parent_page_id.as_ref().and(run.before_page_id.clone()),
        });
        if run.parent_page_id.is_none()
            && view_manual_descending(connection, &recipe.view_id)?.is_some()
        {
            position_runs.push(DatabaseListPositionRunPlan {
                pages: run
                    .page_ids
                    .iter()
                    .map(|page_id| {
                        current_position_revision(connection, &recipe.view_id, page_id).map(
                            |expected_position_revision| DatabasePagePosition {
                                page_id: page_id.clone(),
                                expected_position_revision,
                            },
                        )
                    })
                    .collect::<Result<Vec<_>, _>>()?,
                before_page_id: run.before_page_id.clone(),
            });
        }
    }
    let restored_page_ids = recipe
        .post_parent_guards
        .iter()
        .map(|guard| guard.page_id.clone())
        .chain(
            recipe
                .property_states
                .iter()
                .map(|state| state.page_id.clone()),
        )
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    Ok(DatabaseListUndoPlan {
        view_id: recipe.view_id.clone(),
        data_source_id: recipe.data_source_id.clone(),
        property_edits,
        parent_runs,
        position_runs,
        restored_page_ids,
        undo_recipe,
    })
}
