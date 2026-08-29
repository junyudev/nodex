use std::collections::{BTreeMap, BTreeSet, HashSet};

use nodex_core_contracts::collection::{CollectionWindowAuthority, CollectionWindowRequest};
use nodex_core_contracts::database::{
    DatabasePagePropertyAddress, DatabaseRelationCandidate, DatabaseRelationCardinality,
    DatabaseRelationTargetItem, DatabaseRelationTargetWindow, DatabaseTaskParentPage,
    DatabaseViewFilter, DatabaseViewFilterOperator,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};

use crate::domain::ordered_position::{LogicalPositionItem, PositionPlanError, plan_position_run};
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};
use crate::infrastructure::{
    collection_window::{WindowCandidate, assemble, normalize_request},
    cursor::{self, CollectionCursorSubject, CursorDirection, KeysetCoordinate, KeysetValue},
};

use super::property_semantics::TASK_PARENT_PROPERTY_ID;

pub(crate) const MAX_RELATION_TARGETS: usize = 10_000;
pub(crate) const MAX_RELATION_PATCH_TARGETS: usize = 100;
pub(crate) const MAX_RELATION_WINDOW: usize = 100;
pub(crate) const RELATION_PREVIEW_TARGETS: usize = 3;
const MAX_RELATION_CANDIDATE_QUERY_BYTES: usize = 512;
const MAX_TASK_PARENT_RUN: usize = 4_096;
const MAX_TASK_PARENT_ROWS: usize = 100_000;
const MAX_TASK_PARENT_DEPTH: usize = 10;

pub(crate) enum RelationValueEdit<'a> {
    ReplaceOne {
        expected_value_revision: i64,
        target_page_id: Option<&'a str>,
    },
    PatchMany {
        add_page_ids: &'a [String],
        remove_edge_ids: &'a [String],
    },
    ClearMany {
        expected_value_revision: i64,
    },
}

pub(crate) struct RelationMutationOutcome {
    pub affected_values: Vec<RelationValueRevision>,
    pub changed: bool,
}

pub(crate) struct RelationValueRevision {
    pub page_id: String,
    pub data_source_id: String,
    pub membership_id: String,
    pub property_id: String,
    pub value_revision: i64,
}

struct RelationDefinition {
    target_data_source_id: String,
    cardinality: DatabaseRelationCardinality,
}

#[derive(Clone)]
enum ProjectedRelationTarget {
    Visible {
        page_id: String,
        title: String,
        lifecycle: String,
        membership_state: String,
    },
    Restricted,
}

impl ProjectedRelationTarget {
    fn with_edge(self, edge_id: String) -> DatabaseRelationTargetItem {
        match self {
            Self::Visible {
                page_id,
                title,
                lifecycle,
                membership_state,
            } => DatabaseRelationTargetItem::Visible {
                edge_id,
                page_id,
                title,
                lifecycle,
                membership_state,
            },
            Self::Restricted => DatabaseRelationTargetItem::Restricted { edge_id },
        }
    }
}

pub(crate) fn target_data_source_id(
    connection: &Connection,
    data_source_id: &str,
    property_id: &str,
) -> Result<String, StoreError> {
    relation_definition(connection, data_source_id, property_id)
        .map(|definition| definition.target_data_source_id)
}

fn relation_definition(
    connection: &Connection,
    data_source_id: &str,
    property_id: &str,
) -> Result<RelationDefinition, StoreError> {
    let (target_data_source_id, cardinality) = connection
        .query_row(
            "SELECT relation.target_data_source_id, relation.cardinality \
             FROM data_source_relation_properties relation \
             JOIN data_source_properties property \
               ON property.data_source_id = relation.data_source_id \
               AND property.id = relation.property_id \
             WHERE relation.data_source_id = ?1 AND relation.property_id = ?2 \
               AND property.value_type = 'relation' AND property.lifecycle = 'active'",
            params![data_source_id, property_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?
        .ok_or_else(|| not_found("Relation Property is unavailable"))?;
    let cardinality = match cardinality.as_str() {
        "one" => DatabaseRelationCardinality::One,
        "many" => DatabaseRelationCardinality::Many,
        _ => return Err(corrupt("Relation Property has invalid cardinality")),
    };
    Ok(RelationDefinition {
        target_data_source_id,
        cardinality,
    })
}

pub(crate) fn apply_value_edit(
    connection: &Connection,
    library_id: &str,
    project_id: Option<&str>,
    address: &DatabasePagePropertyAddress,
    edit: RelationValueEdit<'_>,
    now: &str,
) -> Result<RelationMutationOutcome, StoreError> {
    let DatabasePagePropertyAddress {
        page_id,
        data_source_id,
        property_id,
    } = address;
    let definition = relation_definition(connection, data_source_id, property_id)?;
    let membership_id = connection
        .query_row(
            "SELECT membership.id \
             FROM data_source_page_memberships membership \
             JOIN pages page ON page.block_id = membership.page_block_id \
             JOIN blocks block ON block.id = page.block_id AND block.library_id = page.library_id \
             WHERE membership.data_source_id = ?1 AND membership.page_block_id = ?2 \
               AND membership.removed_at IS NULL \
               AND page.parent_kind = 'data_source' AND page.parent_id = ?1 \
               AND block.lifecycle = 'active'",
            params![data_source_id, page_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .ok_or_else(|| not_found("Page is not an active row in the Data Source"))?;
    let current_revision = connection
        .query_row(
            "SELECT revision FROM data_source_property_values \
             WHERE data_source_id = ?1 AND membership_id = ?2 AND property_id = ?3 \
               AND value_type = 'relation' AND json_type(value_json) = 'null'",
            params![data_source_id, membership_id, property_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
        .unwrap_or(0);
    let current_edges = connection
        .prepare(
            "SELECT edge_id, target_page_block_id FROM data_source_relation_edges \
             WHERE source_data_source_id = ?1 AND source_membership_id = ?2 \
               AND property_id = ?3 ORDER BY target_page_block_id",
        )?
        .query_map(params![data_source_id, membership_id, property_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<BTreeMap<_, _>>>()?;
    let current = current_edges.values().cloned().collect::<BTreeSet<_>>();

    let (desired, targets_requiring_read_access, removed_edge_ids) = match edit {
        RelationValueEdit::ReplaceOne {
            expected_value_revision,
            target_page_id,
        } if definition.cardinality == DatabaseRelationCardinality::One => {
            require_revision(expected_value_revision, current_revision)?;
            let desired = target_page_id
                .map(|page_id| canonical_targets(&[page_id.to_owned()], "Relation target"))
                .transpose()?
                .unwrap_or_default();
            (
                desired.clone(),
                desired,
                current_edges.keys().cloned().collect(),
            )
        }
        RelationValueEdit::PatchMany {
            add_page_ids,
            remove_edge_ids,
        } if definition.cardinality == DatabaseRelationCardinality::Many => {
            if add_page_ids.len() + remove_edge_ids.len() > MAX_RELATION_PATCH_TARGETS {
                return Err(resource_exhausted(format!(
                    "Relation patch exceeds {MAX_RELATION_PATCH_TARGETS} targets"
                )));
            }
            let add = canonical_targets(add_page_ids, "Relation add set")?;
            let remove = canonical_edge_ids(remove_edge_ids)?;
            if !remove
                .iter()
                .all(|edge_id| current_edges.contains_key(edge_id))
            {
                return Err(not_found("Relation edge is unavailable"));
            }
            let mut desired = current.clone();
            desired.extend(add.clone());
            for edge_id in &remove {
                if let Some(page_id) = current_edges.get(edge_id) {
                    desired.remove(page_id);
                }
            }
            (desired, add, remove)
        }
        RelationValueEdit::ClearMany {
            expected_value_revision,
        } if definition.cardinality == DatabaseRelationCardinality::Many => {
            require_revision(expected_value_revision, current_revision)?;
            (
                BTreeSet::new(),
                BTreeSet::new(),
                current_edges.keys().cloned().collect(),
            )
        }
        RelationValueEdit::ReplaceOne { .. } => {
            return Err(invalid(
                "Cardinality-many Relation Property cannot replace a single target",
            ));
        }
        RelationValueEdit::PatchMany { .. } | RelationValueEdit::ClearMany { .. } => {
            return Err(invalid(
                "Cardinality-one Relation Property cannot mutate a target set",
            ));
        }
    };
    if desired.len() > MAX_RELATION_TARGETS {
        return Err(resource_exhausted(format!(
            "Relation value exceeds {MAX_RELATION_TARGETS} targets"
        )));
    }
    validate_readable_targets(
        connection,
        library_id,
        project_id,
        &definition.target_data_source_id,
        &targets_requiring_read_access,
    )?;
    if desired == current {
        return Ok(RelationMutationOutcome {
            affected_values: Vec::new(),
            changed: false,
        });
    }
    let additions = desired.difference(&current).cloned().collect::<Vec<_>>();
    validate_active_targets(connection, &definition.target_data_source_id, &additions)?;
    if property_id == TASK_PARENT_PROPERTY_ID {
        let pages = [DatabaseTaskParentPage {
            page_id: page_id.clone(),
            expected_value_revision: current_revision,
        }];
        let affected_values = apply_task_parent_run(
            connection,
            data_source_id,
            &pages,
            desired.iter().next().map(String::as_str),
            None,
            now,
        )?;
        return Ok(RelationMutationOutcome {
            changed: !affected_values.is_empty(),
            affected_values,
        });
    }

    let next_revision = current_revision + 1;
    connection.execute(
        "INSERT INTO data_source_property_values(\
           data_source_id, membership_id, property_id, value_type, value_json, revision, updated_at\
         ) VALUES (?1, ?2, ?3, 'relation', 'null', ?4, ?5) \
         ON CONFLICT(data_source_id, membership_id, property_id) DO UPDATE SET \
           value_type = 'relation', value_json = 'null', revision = excluded.revision, \
           updated_at = excluded.updated_at",
        params![
            data_source_id,
            membership_id,
            property_id,
            next_revision,
            now
        ],
    )?;
    let mut delete = connection.prepare(
        "DELETE FROM data_source_relation_edges \
         WHERE source_data_source_id = ?1 AND source_membership_id = ?2 \
           AND property_id = ?3 AND edge_id = ?4",
    )?;
    for edge_id in removed_edge_ids {
        delete.execute(params![data_source_id, membership_id, property_id, edge_id])?;
    }
    drop(delete);
    let mut insert = connection.prepare(
        "INSERT INTO data_source_relation_edges(\
           edge_id, source_data_source_id, source_membership_id, property_id, \
           target_page_block_id, created_at\
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )?;
    for target_page_id in additions {
        insert.execute(params![
            new_edge_id()?,
            data_source_id,
            membership_id,
            property_id,
            target_page_id,
            now
        ])?;
    }
    Ok(RelationMutationOutcome {
        affected_values: vec![RelationValueRevision {
            page_id: page_id.clone(),
            data_source_id: data_source_id.clone(),
            membership_id,
            property_id: property_id.clone(),
            value_revision: next_revision,
        }],
        changed: true,
    })
}

pub(crate) fn new_edge_id() -> Result<String, StoreError> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| internal("Relation edge identity entropy failed"))?;
    Ok(hex::encode(bytes))
}

pub(crate) fn copy_relation_edges(
    connection: &Connection,
    data_source_id: &str,
    source_membership_id: &str,
    target_membership_id: &str,
    now: &str,
) -> Result<(), StoreError> {
    let edges = connection
        .prepare(
            "SELECT property_id, target_page_block_id \
             FROM data_source_relation_edges \
             WHERE source_data_source_id = ?1 AND source_membership_id = ?2 \
             ORDER BY property_id, target_page_block_id",
        )?
        .query_map(params![data_source_id, source_membership_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if edges.is_empty() {
        return Ok(());
    }
    let mut insert = connection.prepare(
        "INSERT INTO data_source_relation_edges(\
           edge_id, source_data_source_id, source_membership_id, property_id, \
           target_page_block_id, created_at\
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )?;
    for (property_id, target_page_id) in edges {
        if property_id == TASK_PARENT_PROPERTY_ID {
            continue;
        }
        insert.execute(params![
            new_edge_id()?,
            data_source_id,
            target_membership_id,
            property_id,
            target_page_id,
            now,
        ])?;
    }
    Ok(())
}

/// Applies the standard Parent policy when a Page leaves its Data Source.
/// Generic Relation references intentionally survive target lifecycle changes;
/// only Parent edges require both endpoints to remain active peers.
pub(crate) fn remove_membership_task_parent_edges(
    connection: &Connection,
    data_source_id: &str,
    membership_id: &str,
    now: &str,
) -> Result<Vec<RelationValueRevision>, StoreError> {
    let page_id = connection
        .query_row(
            "SELECT page_block_id FROM data_source_page_memberships \
             WHERE data_source_id = ?1 AND id = ?2 AND removed_at IS NULL",
            params![data_source_id, membership_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .ok_or_else(|| not_found("Active Data Source membership is unavailable"))?;
    let mut affected = connection
        .prepare(
            "SELECT value.data_source_id, value.membership_id, value.property_id, \
                    source_membership.page_block_id, value.revision \
             FROM data_source_relation_edges edge \
             JOIN data_source_page_memberships source_membership \
               ON source_membership.data_source_id = edge.source_data_source_id \
              AND source_membership.id = edge.source_membership_id \
             JOIN data_source_property_values value \
               ON value.data_source_id = edge.source_data_source_id \
              AND value.membership_id = edge.source_membership_id \
              AND value.property_id = edge.property_id \
             WHERE edge.source_data_source_id = ?1 \
               AND edge.property_id = 'task_parent' \
               AND edge.target_page_block_id = ?3 \
             UNION \
             SELECT value.data_source_id, value.membership_id, value.property_id, \
                    membership.page_block_id, value.revision \
             FROM data_source_property_values value \
             JOIN data_source_page_memberships membership \
               ON membership.data_source_id = value.data_source_id \
              AND membership.id = value.membership_id \
             WHERE value.data_source_id = ?1 AND value.membership_id = ?2 \
               AND value.property_id = 'task_parent' \
             ORDER BY 1, 2, 3",
        )?
        .query_map(params![data_source_id, membership_id, page_id], |row| {
            Ok(RelationValueRevision {
                data_source_id: row.get(0)?,
                membership_id: row.get(1)?,
                property_id: row.get(2)?,
                page_id: row.get(3)?,
                value_revision: row.get(4)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if !affected.iter().any(|value| {
        value.data_source_id == data_source_id
            && value.membership_id == membership_id
            && value.property_id == TASK_PARENT_PROPERTY_ID
    }) {
        return Err(corrupt(
            "An active membership is missing its Parent Relation value header",
        ));
    }

    connection.execute(
        "DELETE FROM data_source_relation_edges \
         WHERE source_data_source_id = ?1 AND property_id = 'task_parent' \
           AND (source_membership_id = ?2 OR target_page_block_id = ?3)",
        params![data_source_id, membership_id, page_id],
    )?;
    for value in &mut affected {
        let next_revision = value
            .value_revision
            .checked_add(1)
            .ok_or_else(|| corrupt("Relation value revision overflowed"))?;
        let changed = connection.execute(
            "UPDATE data_source_property_values SET revision = ?1, updated_at = ?2 \
             WHERE data_source_id = ?3 AND membership_id = ?4 AND property_id = ?5 \
               AND value_type = 'relation' AND json_type(value_json) = 'null' \
               AND revision = ?6",
            params![
                next_revision,
                now,
                value.data_source_id,
                value.membership_id,
                value.property_id,
                value.value_revision
            ],
        )?;
        if changed != 1 {
            return Err(corrupt(
                "Relation value header changed during membership removal",
            ));
        }
        value.value_revision = next_revision;
    }
    Ok(affected)
}

#[derive(Clone, Debug)]
struct TaskParentState {
    membership_id: String,
    is_active: bool,
    parent_page_id: Option<String>,
    sibling_rank: Option<String>,
    edge_id: Option<String>,
    value_revision: i64,
}

#[derive(Clone, Debug)]
struct DesiredTaskParent {
    parent_page_id: Option<String>,
    sibling_rank: Option<String>,
}

/// Applies the standard Parent Relation policy as one ordered run.
///
/// The relation value header is the concurrency authority even when a task is
/// currently a root. Sibling ranks are metadata on `task_parent` edges, never
/// an independent hierarchy record.
pub(crate) fn apply_task_parent_run(
    connection: &Connection,
    data_source_id: &str,
    pages: &[DatabaseTaskParentPage],
    parent_page_id: Option<&str>,
    before_page_id: Option<&str>,
    now: &str,
) -> Result<Vec<RelationValueRevision>, StoreError> {
    if pages.is_empty() || pages.len() > MAX_TASK_PARENT_RUN {
        return Err(invalid(format!(
            "Parent Relation run requires between 1 and {MAX_TASK_PARENT_RUN} Pages"
        )));
    }
    let definition = relation_definition(connection, data_source_id, TASK_PARENT_PROPERTY_ID)?;
    if definition.target_data_source_id != data_source_id
        || definition.cardinality != DatabaseRelationCardinality::One
    {
        return Err(corrupt(
            "The standard Parent Property is not a cardinality-one self Relation",
        ));
    }

    let page_ids = pages
        .iter()
        .map(|page| page.page_id.as_str())
        .collect::<HashSet<_>>();
    if page_ids.len() != pages.len() {
        return Err(invalid("Parent Relation Page IDs must be unique"));
    }
    if parent_page_id.is_some_and(|page_id| page_ids.contains(page_id)) {
        return Err(invalid("A task cannot be its own parent"));
    }
    if before_page_id.is_some_and(|page_id| page_ids.contains(page_id)) {
        return Err(invalid(
            "Parent Relation anchor must be outside the moved Page set",
        ));
    }
    if parent_page_id.is_none() && before_page_id.is_some() {
        return Err(invalid(
            "Root task ordering must use the View position operation",
        ));
    }

    let row_limit = i64::try_from(MAX_TASK_PARENT_ROWS + 1)
        .map_err(|_| internal("Parent Relation row bound is invalid"))?;
    let rows = connection
        .prepare(
            "SELECT membership.page_block_id, membership.id, value.revision, \
                    edge.edge_id, edge.target_page_block_id, edge.sibling_rank, \
                    block.lifecycle = 'active' \
             FROM data_source_page_memberships membership \
             JOIN pages page ON page.block_id = membership.page_block_id \
             JOIN blocks block ON block.id = page.block_id AND block.library_id = page.library_id \
             LEFT JOIN data_source_property_values value \
               ON value.data_source_id = membership.data_source_id \
              AND value.membership_id = membership.id \
              AND value.property_id = 'task_parent' \
              AND value.value_type = 'relation' AND json_type(value.value_json) = 'null' \
             LEFT JOIN data_source_relation_edges edge \
               ON edge.source_data_source_id = membership.data_source_id \
              AND edge.source_membership_id = membership.id \
              AND edge.property_id = 'task_parent' \
             WHERE membership.data_source_id = ?1 AND membership.removed_at IS NULL \
               AND page.parent_kind = 'data_source' AND page.parent_id = ?1 \
             ORDER BY membership.page_block_id LIMIT ?2",
        )?
        .query_map(params![data_source_id, row_limit], |row| {
            Ok((
                row.get::<_, String>(0)?,
                TaskParentState {
                    membership_id: row.get(1)?,
                    value_revision: row.get::<_, Option<i64>>(2)?.unwrap_or(-1),
                    edge_id: row.get(3)?,
                    parent_page_id: row.get(4)?,
                    sibling_rank: row.get(5)?,
                    is_active: row.get(6)?,
                },
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if rows.len() > MAX_TASK_PARENT_ROWS {
        return Err(resource_exhausted(format!(
            "Parent Relation exceeds {MAX_TASK_PARENT_ROWS} retained memberships"
        )));
    }
    let mut state = BTreeMap::new();
    for (page_id, row) in rows {
        if row.value_revision < 0 {
            return Err(corrupt(
                "A retained Data Source membership is missing its Parent value header",
            ));
        }
        if row.parent_page_id.is_some() != row.sibling_rank.is_some()
            || row.parent_page_id.is_some() != row.edge_id.is_some()
        {
            return Err(corrupt("A Parent Relation edge is structurally incomplete"));
        }
        if state.insert(page_id, row).is_some() {
            return Err(corrupt("A task has more than one parent"));
        }
    }

    for page in pages {
        let current = state
            .get(&page.page_id)
            .ok_or_else(|| not_found("Page is not an active row in the Data Source"))?;
        if !current.is_active {
            return Err(not_found("Page is not an active row in the Data Source"));
        }
        require_revision(page.expected_value_revision, current.value_revision)?;
        let mut cursor = current.parent_page_id.as_deref();
        while let Some(ancestor) = cursor {
            if page_ids.contains(ancestor) {
                return Err(invalid(
                    "A task selection cannot also contain one of its ancestors",
                ));
            }
            cursor = state
                .get(ancestor)
                .ok_or_else(|| corrupt("A Parent Relation targets an inactive Page"))?
                .parent_page_id
                .as_deref();
        }
    }
    if let Some(parent_page_id) = parent_page_id {
        if !state
            .get(parent_page_id)
            .is_some_and(|parent| parent.is_active)
        {
            return Err(not_found("Parent is not an active Page in the Data Source"));
        }
        let mut cursor = Some(parent_page_id);
        let mut visited = HashSet::new();
        while let Some(ancestor) = cursor {
            if !visited.insert(ancestor) {
                return Err(corrupt("Parent Relations contain a cycle"));
            }
            if page_ids.contains(ancestor) {
                return Err(invalid("Parent Relation mutation would create a cycle"));
            }
            cursor = state
                .get(ancestor)
                .ok_or_else(|| corrupt("A Parent Relation targets an inactive Page"))?
                .parent_page_id
                .as_deref();
        }
        let children = task_parent_children(&state)?;
        let parent_depth = task_parent_depth(parent_page_id, &state)?;
        for page in pages {
            let subtree_height =
                task_subtree_height(&page.page_id, &children, &mut HashSet::new())?;
            if parent_depth + 1 + subtree_height > MAX_TASK_PARENT_DEPTH {
                return Err(invalid(format!(
                    "Parent Relations cannot exceed depth {MAX_TASK_PARENT_DEPTH}"
                )));
            }
        }
        if let Some(before_page_id) = before_page_id {
            let anchor = state
                .get(before_page_id)
                .filter(|anchor| anchor.is_active)
                .ok_or_else(|| not_found("Parent Relation anchor is not an active Page"))?;
            if anchor.parent_page_id.as_deref() != Some(parent_page_id) {
                return Err(invalid("Parent Relation anchor is not a target sibling"));
            }
        }
    }

    let mut desired = BTreeMap::new();
    if let Some(parent_page_id) = parent_page_id {
        let mut target_siblings = state
            .iter()
            .filter_map(|(page_id, row)| {
                (row.parent_page_id.as_deref() == Some(parent_page_id)).then_some(
                    LogicalPositionItem {
                        page_id: page_id.clone(),
                        rank_key: row.sibling_rank.clone(),
                    },
                )
            })
            .collect::<Vec<_>>();
        target_siblings.sort_by(|left, right| {
            left.rank_key
                .cmp(&right.rank_key)
                .then_with(|| left.page_id.cmp(&right.page_id))
        });

        let current_order = target_siblings
            .iter()
            .map(|item| item.page_id.clone())
            .collect::<Vec<_>>();
        let mut desired_order = current_order
            .iter()
            .filter(|page_id| !page_ids.contains(page_id.as_str()))
            .cloned()
            .collect::<Vec<_>>();
        let insert_at = match before_page_id {
            Some(before_page_id) => desired_order
                .iter()
                .position(|page_id| page_id == before_page_id)
                .ok_or_else(|| invalid("Parent Relation anchor is not a target sibling"))?,
            None => desired_order.len(),
        };
        desired_order.splice(
            insert_at..insert_at,
            pages.iter().map(|page| page.page_id.clone()),
        );
        let parent_is_unchanged = pages.iter().all(|page| {
            state
                .get(&page.page_id)
                .is_some_and(|current| current.parent_page_id.as_deref() == Some(parent_page_id))
        });
        if parent_is_unchanged && desired_order == current_order {
            return Ok(Vec::new());
        }

        let moved_page_ids = pages
            .iter()
            .map(|page| page.page_id.clone())
            .collect::<Vec<_>>();
        let rank_plan = plan_position_run(&target_siblings, &moved_page_ids, before_page_id, false)
            .map_err(task_parent_position_plan_error)?;
        for write in rank_plan.sibling_writes {
            let current = state
                .get(&write.page_id)
                .ok_or_else(|| corrupt("Parent rank maintenance lost its sibling Page"))?;
            write_task_parent_rank_maintenance(
                connection,
                data_source_id,
                current,
                &write.rank_key,
            )?;
        }
        for page in pages {
            let sibling_rank = rank_plan
                .moved_rank_keys
                .get(&page.page_id)
                .cloned()
                .ok_or_else(|| corrupt("Parent rank plan omitted a moved Page"))?;
            desired.insert(
                page.page_id.clone(),
                DesiredTaskParent {
                    parent_page_id: Some(parent_page_id.to_owned()),
                    sibling_rank: Some(sibling_rank),
                },
            );
        }
    } else {
        for page in pages {
            desired.insert(
                page.page_id.clone(),
                DesiredTaskParent {
                    parent_page_id: None,
                    sibling_rank: None,
                },
            );
        }
    }

    let changed = desired
        .into_iter()
        .filter(|(page_id, desired)| {
            state.get(page_id).is_none_or(|current| {
                current.parent_page_id != desired.parent_page_id
                    || current.sibling_rank != desired.sibling_rank
            })
        })
        .collect::<BTreeMap<_, _>>();
    let mut affected_values = Vec::with_capacity(changed.len());
    for (page_id, desired) in changed {
        let current = state
            .get(&page_id)
            .ok_or_else(|| corrupt("Parent Relation change lost its source Page"))?;
        write_task_parent_edge(connection, data_source_id, current, &desired, now)?;
        let value_revision = current
            .value_revision
            .checked_add(1)
            .ok_or_else(|| corrupt("Parent Relation value revision overflowed"))?;
        let updated = connection.execute(
            "UPDATE data_source_property_values SET revision = ?1, updated_at = ?2 \
             WHERE data_source_id = ?3 AND membership_id = ?4 \
               AND property_id = 'task_parent' AND value_type = 'relation' \
               AND json_type(value_json) = 'null' AND revision = ?5",
            params![
                value_revision,
                now,
                data_source_id,
                current.membership_id,
                current.value_revision
            ],
        )?;
        if updated != 1 {
            return Err(corrupt(
                "Parent Relation value header changed during its mutation",
            ));
        }
        affected_values.push(RelationValueRevision {
            page_id,
            data_source_id: data_source_id.to_owned(),
            membership_id: current.membership_id.clone(),
            property_id: TASK_PARENT_PROPERTY_ID.to_owned(),
            value_revision,
        });
    }
    Ok(affected_values)
}

fn task_parent_position_plan_error(error: PositionPlanError) -> StoreError {
    match error {
        PositionPlanError::InvalidInput(message) | PositionPlanError::AnchorNotFound(message) => {
            invalid(message)
        }
        PositionPlanError::FractionalRank(error) => invalid(error.message),
    }
}

/// Rank maintenance preserves logical order and therefore must not advance the
/// sibling's Parent value revision or Page metadata revision.
fn write_task_parent_rank_maintenance(
    connection: &Connection,
    data_source_id: &str,
    current: &TaskParentState,
    sibling_rank: &str,
) -> Result<(), StoreError> {
    let edge_id = current
        .edge_id
        .as_deref()
        .ok_or_else(|| corrupt("Parent rank maintenance requires an existing edge"))?;
    replace_task_parent_edge_rank(connection, data_source_id, edge_id, sibling_rank)
}

fn write_task_parent_edge(
    connection: &Connection,
    data_source_id: &str,
    current: &TaskParentState,
    desired: &DesiredTaskParent,
    now: &str,
) -> Result<(), StoreError> {
    let Some(parent_page_id) = desired.parent_page_id.as_deref() else {
        if let Some(edge_id) = current.edge_id.as_deref() {
            connection.execute(
                "DELETE FROM data_source_relation_edges WHERE edge_id = ?1",
                [edge_id],
            )?;
        }
        return Ok(());
    };
    let sibling_rank = desired
        .sibling_rank
        .as_deref()
        .ok_or_else(|| internal("Parent Relation rank planning was incomplete"))?;
    if current.parent_page_id.as_deref() == Some(parent_page_id) {
        let edge_id = current
            .edge_id
            .as_deref()
            .ok_or_else(|| corrupt("Parent Relation edge identity is missing"))?;
        return replace_task_parent_edge_rank(connection, data_source_id, edge_id, sibling_rank);
    }
    if let Some(edge_id) = current.edge_id.as_deref() {
        connection.execute(
            "DELETE FROM data_source_relation_edges WHERE edge_id = ?1",
            [edge_id],
        )?;
    }
    connection.execute(
        "INSERT INTO data_source_relation_edges(\
           edge_id, source_data_source_id, source_membership_id, property_id, \
           target_page_block_id, created_at, sibling_rank\
         ) VALUES (?1, ?2, ?3, 'task_parent', ?4, ?5, ?6)",
        params![
            new_edge_id()?,
            data_source_id,
            current.membership_id,
            parent_page_id,
            now,
            sibling_rank
        ],
    )?;
    Ok(())
}

/// Relation edge identity is immutable. Rank-only maintenance therefore
/// replaces the row atomically while preserving its identity and creation time.
fn replace_task_parent_edge_rank(
    connection: &Connection,
    data_source_id: &str,
    edge_id: &str,
    sibling_rank: &str,
) -> Result<(), StoreError> {
    let edge = connection
        .query_row(
            "SELECT source_membership_id, target_page_block_id, created_at \
             FROM data_source_relation_edges \
             WHERE edge_id = ?1 AND source_data_source_id = ?2 \
               AND property_id = 'task_parent'",
            params![edge_id, data_source_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| corrupt("Parent Relation edge disappeared during rank maintenance"))?;
    let deleted = connection.execute(
        "DELETE FROM data_source_relation_edges \
         WHERE edge_id = ?1 AND source_data_source_id = ?2 AND property_id = 'task_parent'",
        params![edge_id, data_source_id],
    )?;
    if deleted != 1 {
        return Err(corrupt(
            "Parent Relation edge changed during rank maintenance",
        ));
    }
    connection.execute(
        "INSERT INTO data_source_relation_edges(\
           edge_id, source_data_source_id, source_membership_id, property_id, \
           target_page_block_id, created_at, sibling_rank\
         ) VALUES (?1, ?2, ?3, 'task_parent', ?4, ?5, ?6)",
        params![
            edge_id,
            data_source_id,
            edge.0,
            edge.1,
            edge.2,
            sibling_rank
        ],
    )?;
    Ok(())
}

fn task_parent_children(
    state: &BTreeMap<String, TaskParentState>,
) -> Result<BTreeMap<String, Vec<String>>, StoreError> {
    let mut children = BTreeMap::<String, Vec<String>>::new();
    for (page_id, row) in state {
        let Some(parent_page_id) = row.parent_page_id.as_ref() else {
            continue;
        };
        if !state.contains_key(parent_page_id) {
            return Err(corrupt("A Parent Relation targets an inactive Page"));
        }
        children
            .entry(parent_page_id.clone())
            .or_default()
            .push(page_id.clone());
    }
    Ok(children)
}

fn task_parent_depth(
    page_id: &str,
    state: &BTreeMap<String, TaskParentState>,
) -> Result<usize, StoreError> {
    let mut depth = 0;
    let mut cursor = page_id;
    let mut visited = HashSet::new();
    while let Some(parent_page_id) = state
        .get(cursor)
        .ok_or_else(|| corrupt("A Parent Relation references an inactive Page"))?
        .parent_page_id
        .as_deref()
    {
        if !visited.insert(cursor) {
            return Err(corrupt("Parent Relations contain a cycle"));
        }
        depth += 1;
        if depth > MAX_TASK_PARENT_DEPTH {
            return Err(corrupt("Parent Relations exceed their depth bound"));
        }
        cursor = parent_page_id;
    }
    Ok(depth)
}

fn task_subtree_height(
    page_id: &str,
    children: &BTreeMap<String, Vec<String>>,
    path: &mut HashSet<String>,
) -> Result<usize, StoreError> {
    if !path.insert(page_id.to_owned()) {
        return Err(corrupt("Parent Relations contain a cycle"));
    }
    let mut height = 0;
    for child_id in children.get(page_id).into_iter().flatten() {
        height = height.max(1 + task_subtree_height(child_id, children, path)?);
        if height > MAX_TASK_PARENT_DEPTH {
            return Err(corrupt("Parent Relations exceed their depth bound"));
        }
    }
    path.remove(page_id);
    Ok(height)
}

fn canonical_targets(values: &[String], label: &str) -> Result<BTreeSet<String>, StoreError> {
    if values.len() > MAX_RELATION_TARGETS {
        return Err(resource_exhausted(format!(
            "{label} exceeds {MAX_RELATION_TARGETS} targets"
        )));
    }
    let mut targets = BTreeSet::new();
    for value in values {
        if value.is_empty()
            || value.len() > 512
            || value != value.trim()
            || value.chars().any(char::is_control)
        {
            return Err(invalid(format!(
                "{label} contains an invalid Page identity"
            )));
        }
        if !targets.insert(value.clone()) {
            return Err(invalid(format!(
                "{label} contains a duplicate Page identity"
            )));
        }
    }
    Ok(targets)
}

fn canonical_edge_ids(values: &[String]) -> Result<BTreeSet<String>, StoreError> {
    let mut edge_ids = BTreeSet::new();
    for edge_id in values {
        if edge_id.len() != 64
            || !edge_id
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(invalid(
                "Relation remove set contains an invalid edge handle",
            ));
        }
        if !edge_ids.insert(edge_id.clone()) {
            return Err(invalid(
                "Relation remove set contains a duplicate edge handle",
            ));
        }
    }
    Ok(edge_ids)
}

pub(crate) fn target_window(
    connection: &Connection,
    library_id: &str,
    commit_head: i64,
    project_id: Option<&str>,
    address: &DatabasePagePropertyAddress,
    request: &CollectionWindowRequest,
) -> Result<DatabaseRelationTargetWindow, StoreError> {
    let normalized = normalize_request(request)?;
    if normalized.first > MAX_RELATION_WINDOW {
        return Err(invalid(format!(
            "Relation window cannot exceed {MAX_RELATION_WINDOW} targets"
        )));
    }
    let membership_id =
        active_membership_id(connection, &address.data_source_id, &address.page_id)?;
    let target_source =
        target_data_source_id(connection, &address.data_source_id, &address.property_id)?;
    let value_revision = value_revision(
        connection,
        &address.data_source_id,
        &membership_id,
        &address.property_id,
    )?;
    let total_count = connection.query_row(
        "SELECT count(*) FROM data_source_relation_edges \
         WHERE source_data_source_id = ?1 AND source_membership_id = ?2 \
           AND property_id = ?3",
        params![address.data_source_id, membership_id, address.property_id],
        |row| row.get::<_, i64>(0),
    )?;
    let fingerprint = cursor::query_fingerprint(&(
        "database_relation_target_window_v1",
        &address.page_id,
        &address.data_source_id,
        &address.property_id,
        value_revision,
    ))?;
    let subject = CollectionCursorSubject {
        kind: "database_relation_targets",
        library_id,
        query_fingerprint: &fingerprint,
    };
    let after_ordinal = normalized
        .after
        .map(|encoded| cursor::decode(connection, encoded, subject))
        .transpose()?
        .map(|(direction, coordinate)| {
            let [KeysetValue::Integer { value: ordinal }] = coordinate.values.as_slice() else {
                return Err(invalid("Relation cursor is incompatible"));
            };
            if direction != CursorDirection::Forward
                || coordinate.stable_id != "relation_target"
                || *ordinal < 0
            {
                return Err(invalid("Relation cursor is incompatible"));
            }
            Ok(*ordinal)
        })
        .transpose()?;
    let mut statement = connection.prepare(
        "WITH ranked AS (\
           SELECT edge_id, target_page_block_id, \
             row_number() OVER (ORDER BY target_page_block_id) AS ordinal \
           FROM data_source_relation_edges \
           WHERE source_data_source_id = ?1 AND source_membership_id = ?2 \
             AND property_id = ?3\
         ) \
         SELECT edge_id, target_page_block_id, ordinal FROM ranked \
         WHERE ordinal > COALESCE(?4, 0) ORDER BY ordinal LIMIT ?5",
    )?;
    let targets_with_ordinals = statement
        .query_map(
            params![
                address.data_source_id,
                membership_id,
                address.property_id,
                after_ordinal,
                i64::try_from(normalized.first + 1)
                    .map_err(|_| invalid("Relation window size is invalid"))?
            ],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let target_keys = targets_with_ordinals
        .iter()
        .map(|(_, page_id, _)| (target_source.clone(), page_id.clone()))
        .collect::<BTreeSet<_>>();
    let projected = project_targets(connection, library_id, project_id, &target_keys)?;
    let candidates = targets_with_ordinals
        .into_iter()
        .map(|(edge_id, page_id, ordinal)| {
            let item = projected
                .get(&(target_source.clone(), page_id.clone()))
                .cloned()
                .unwrap_or(ProjectedRelationTarget::Restricted)
                .with_edge(edge_id);
            Ok(WindowCandidate {
                item,
                coordinate: KeysetCoordinate {
                    values: vec![KeysetValue::Integer { value: ordinal }],
                    stable_id: "relation_target".to_owned(),
                },
            })
        })
        .collect::<Result<Vec<_>, StoreError>>()?;
    let targets = assemble(
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
    Ok(DatabaseRelationTargetWindow {
        value_revision,
        total_count,
        targets,
    })
}

pub(crate) fn candidate_window(
    connection: &Connection,
    library_id: &str,
    commit_head: i64,
    target_data_source_id: &str,
    query: Option<&str>,
    request: &CollectionWindowRequest,
) -> Result<nodex_core_contracts::collection::CollectionWindow<DatabaseRelationCandidate>, StoreError>
{
    let normalized = normalize_request(request)?;
    if normalized.first > MAX_RELATION_WINDOW {
        return Err(invalid(format!(
            "Relation candidate window cannot exceed {MAX_RELATION_WINDOW} Pages"
        )));
    }
    let query = query.unwrap_or_default().trim().to_ascii_lowercase();
    if query.len() > MAX_RELATION_CANDIDATE_QUERY_BYTES {
        return Err(invalid("Relation candidate query is too long"));
    }
    let fingerprint = cursor::query_fingerprint(&(
        "database_relation_candidate_window_v1",
        target_data_source_id,
        &query,
    ))?;
    let subject = CollectionCursorSubject {
        kind: "database_relation_candidates",
        library_id,
        query_fingerprint: &fingerprint,
    };
    let after = normalized
        .after
        .map(|encoded| cursor::decode(connection, encoded, subject))
        .transpose()?
        .map(|(direction, coordinate)| {
            let [KeysetValue::Text { value: title }] = coordinate.values.as_slice() else {
                return Err(invalid("Relation candidate cursor is incompatible"));
            };
            if direction != CursorDirection::Forward {
                return Err(invalid("Relation candidate cursor is incompatible"));
            }
            Ok((title.clone(), coordinate.stable_id))
        })
        .transpose()?;
    let (after_title, after_page_id) = after
        .map(|(title, page_id)| (Some(title), Some(page_id)))
        .unwrap_or((None, None));
    let query_limit = i64::try_from(normalized.first.saturating_add(1))
        .map_err(|_| invalid("Relation candidate window size is invalid"))?;
    let candidates = connection
        .prepare(
            "SELECT membership.page_block_id, model.title, lower(model.title) \
             FROM data_source_page_memberships membership \
             JOIN pages page ON page.block_id = membership.page_block_id \
             JOIN blocks block ON block.id = page.block_id \
             JOIN page_read_model model ON model.page_block_id = page.block_id \
             WHERE membership.data_source_id = ?1 AND membership.removed_at IS NULL \
               AND page.parent_kind = 'data_source' AND page.parent_id = ?1 \
               AND block.lifecycle = 'active' \
               AND (?2 = '' OR instr(lower(model.title), ?2) > 0) \
               AND (?3 IS NULL OR lower(model.title) > ?3 \
                 OR (lower(model.title) = ?3 AND membership.page_block_id > ?4)) \
             ORDER BY lower(model.title), membership.page_block_id LIMIT ?5",
        )?
        .query_map(
            params![
                target_data_source_id,
                query,
                after_title,
                after_page_id,
                query_limit
            ],
            |row| {
                let page_id = row.get::<_, String>(0)?;
                let title = row.get::<_, String>(1)?;
                let normalized_title = row.get::<_, String>(2)?;
                Ok(WindowCandidate {
                    item: DatabaseRelationCandidate {
                        page_id: page_id.clone(),
                        title,
                    },
                    coordinate: KeysetCoordinate {
                        values: vec![KeysetValue::Text {
                            value: normalized_title,
                        }],
                        stable_id: page_id,
                    },
                })
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    assemble(
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
    )
}

fn active_membership_id(
    connection: &Connection,
    data_source_id: &str,
    page_id: &str,
) -> Result<String, StoreError> {
    connection
        .query_row(
            "SELECT membership.id FROM data_source_page_memberships membership \
             JOIN pages page ON page.block_id = membership.page_block_id \
             JOIN blocks block ON block.id = page.block_id AND block.library_id = page.library_id \
             WHERE membership.data_source_id = ?1 AND membership.page_block_id = ?2 \
               AND membership.removed_at IS NULL AND page.parent_kind = 'data_source' \
               AND page.parent_id = ?1 AND block.lifecycle = 'active'",
            params![data_source_id, page_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .ok_or_else(|| not_found("Page is not an active row in the Data Source"))
}

fn value_revision(
    connection: &Connection,
    data_source_id: &str,
    membership_id: &str,
    property_id: &str,
) -> Result<i64, StoreError> {
    Ok(connection
        .query_row(
            "SELECT revision FROM data_source_property_values \
             WHERE data_source_id = ?1 AND membership_id = ?2 AND property_id = ?3 \
               AND value_type = 'relation'",
            params![data_source_id, membership_id, property_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
        .unwrap_or(0))
}

fn project_targets(
    connection: &Connection,
    library_id: &str,
    project_id: Option<&str>,
    targets: &BTreeSet<(String, String)>,
) -> Result<BTreeMap<(String, String), ProjectedRelationTarget>, StoreError> {
    if targets.is_empty() {
        return Ok(BTreeMap::new());
    }
    let candidates = targets
        .iter()
        .map(|(target_source_id, page_id)| {
            json!({ "targetSourceId": target_source_id, "pageId": page_id })
        })
        .collect::<Vec<_>>();
    let candidates_json = serde_json::to_string(&candidates)
        .map_err(|_| internal("Relation target candidates cannot encode"))?;
    let mut statement = connection.prepare(
        "WITH RECURSIVE \
         candidate(target_source_id, page_id) AS (\
           SELECT json_extract(value, '$.targetSourceId'), json_extract(value, '$.pageId') \
           FROM json_each(?1)\
         ), \
         ancestors(target_source_id, root_page_id, page_id, parent_kind, parent_id, path) AS (\
           SELECT candidate.target_source_id, candidate.page_id, page.block_id, \
             page.parent_kind, page.parent_id, '|' || page.block_id || '|' \
           FROM candidate JOIN pages page ON page.block_id = candidate.page_id \
             AND page.library_id = ?2 \
           UNION ALL \
           SELECT ancestors.target_source_id, ancestors.root_page_id, parent.block_id, \
             parent.parent_kind, parent.parent_id, ancestors.path || parent.block_id || '|' \
           FROM ancestors JOIN pages parent ON ancestors.parent_kind = 'page' \
             AND parent.block_id = ancestors.parent_id AND parent.library_id = ?2 \
           WHERE instr(ancestors.path, '|' || parent.block_id || '|') = 0\
         ) \
         SELECT candidate.target_source_id, candidate.page_id, block.lifecycle, \
           materialization.title, \
           EXISTS(SELECT 1 FROM data_source_page_memberships membership \
             WHERE membership.data_source_id = candidate.target_source_id \
               AND membership.page_block_id = candidate.page_id \
               AND membership.removed_at IS NULL), \
           COALESCE(CASE WHEN ?3 IS NULL THEN 1 ELSE \
             EXISTS(SELECT 1 FROM projects project \
               WHERE project.id = ?3 AND project.library_id = ?2) \
             AND (\
               EXISTS(\
                 SELECT 1 FROM ancestors terminal \
                 JOIN data_sources source ON terminal.parent_kind = 'data_source' \
                   AND source.id = terminal.parent_id AND source.library_id = ?2 \
                 JOIN projects project ON project.id = ?3 AND project.library_id = ?2 \
                 WHERE terminal.target_source_id = candidate.target_source_id \
                   AND terminal.root_page_id = candidate.page_id \
                   AND (source.home_database_block_id = project.database_block_id \
                     OR EXISTS(SELECT 1 FROM project_resource_grants grant_row \
                       WHERE grant_row.project_id = ?3 AND grant_row.root_kind = 'database' \
                         AND grant_row.root_id = source.home_database_block_id \
                         AND grant_row.lifecycle = 'active'))\
               ) \
               OR EXISTS(\
                 SELECT 1 FROM ancestors ancestor \
                 JOIN project_resource_grants grant_row \
                   ON grant_row.project_id = ?3 AND grant_row.root_kind = 'page' \
                   AND grant_row.root_id = ancestor.page_id AND grant_row.lifecycle = 'active' \
                 WHERE ancestor.target_source_id = candidate.target_source_id \
                   AND ancestor.root_page_id = candidate.page_id\
               )\
             ) END, 0) \
         FROM candidate \
         LEFT JOIN pages page ON page.block_id = candidate.page_id AND page.library_id = ?2 \
         LEFT JOIN blocks block ON block.id = page.block_id AND block.type = 'page' \
         LEFT JOIN documents document ON document.id = page.document_id \
         LEFT JOIN document_materializations materialization \
           ON materialization.document_id = document.id \
           AND materialization.generation = document.generation \
           AND materialization.projected_seq = document.head_seq \
           AND materialization.schema_version = document.schema_version",
    )?;
    let records = statement
        .query_map(params![candidates_json, library_id, project_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, i64>(4)? != 0,
                row.get::<_, i64>(5)? != 0,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut projected = BTreeMap::new();
    for (target_source_id, page_id, lifecycle, title, active_membership, authorized) in records {
        let item = match (authorized, lifecycle, title) {
            (true, Some(lifecycle), Some(title)) => {
                let membership_state = match lifecycle.as_str() {
                    "deleted" => "deleted",
                    "archived" => "archived",
                    _ if active_membership => "active_in_target_source",
                    _ => "out_of_source",
                };
                ProjectedRelationTarget::Visible {
                    page_id: page_id.clone(),
                    title,
                    lifecycle,
                    membership_state: membership_state.to_owned(),
                }
            }
            _ => ProjectedRelationTarget::Restricted,
        };
        projected.insert((target_source_id, page_id), item);
    }
    Ok(projected)
}

fn validate_readable_targets(
    connection: &Connection,
    library_id: &str,
    project_id: Option<&str>,
    target_data_source_id: &str,
    page_ids: &BTreeSet<String>,
) -> Result<(), StoreError> {
    let Some(project_id) = project_id else {
        return Ok(());
    };
    if page_ids.is_empty() {
        return Ok(());
    }
    let targets = page_ids
        .iter()
        .map(|page_id| (target_data_source_id.to_owned(), page_id.clone()))
        .collect::<BTreeSet<_>>();
    let projected = project_targets(connection, library_id, Some(project_id), &targets)?;
    if targets.iter().all(|target| {
        matches!(
            projected.get(target),
            Some(ProjectedRelationTarget::Visible { .. })
        )
    }) {
        return Ok(());
    }
    Err(not_found("Relation target is unavailable"))
}

pub(crate) fn validate_active_targets(
    connection: &Connection,
    target_data_source_id: &str,
    page_ids: &[String],
) -> Result<(), StoreError> {
    if page_ids.is_empty() {
        return Ok(());
    }
    let page_ids_json = serde_json::to_string(page_ids)
        .map_err(|_| internal("Relation target identities cannot encode"))?;
    let valid: i64 = connection.query_row(
        "SELECT count(DISTINCT candidate.value) \
         FROM json_each(?1) candidate \
         JOIN blocks block ON block.id = candidate.value \
           AND block.type = 'page' AND block.lifecycle = 'active' \
         JOIN pages page ON page.block_id = block.id AND page.library_id = block.library_id \
         JOIN data_source_page_memberships membership \
           ON membership.page_block_id = block.id \
           AND membership.data_source_id = ?2 AND membership.removed_at IS NULL \
         WHERE candidate.type = 'text'",
        params![page_ids_json, target_data_source_id],
        |row| row.get(0),
    )?;
    if usize::try_from(valid).ok() == Some(page_ids.len()) {
        return Ok(());
    }
    Err(not_found(
        "Relation target is not an active Page in the configured Data Source",
    ))
}

pub(crate) fn validate_view_filter_read_access(
    connection: &Connection,
    library_id: &str,
    project_id: Option<&str>,
    data_source_id: &str,
    filter: &DatabaseViewFilter,
) -> Result<(), StoreError> {
    let Some(project_id) = project_id else {
        return Ok(());
    };
    let mut targets = BTreeSet::new();
    collect_relation_filter_targets(connection, data_source_id, filter, 1, &mut 0, &mut targets)?;
    if targets.is_empty() {
        return Ok(());
    }
    let projected = project_targets(connection, library_id, Some(project_id), &targets)?;
    if targets.iter().all(|target| {
        matches!(
            projected.get(target),
            Some(ProjectedRelationTarget::Visible { .. })
        )
    }) {
        return Ok(());
    }
    Err(not_found("Database View is unavailable"))
}

fn collect_relation_filter_targets(
    connection: &Connection,
    data_source_id: &str,
    filter: &DatabaseViewFilter,
    depth: usize,
    nodes: &mut usize,
    targets: &mut BTreeSet<(String, String)>,
) -> Result<(), StoreError> {
    if depth > 8 || *nodes >= 1_024 {
        return Err(corrupt("Database View filter exceeds its structural bound"));
    }
    *nodes += 1;
    if let DatabaseViewFilter::Group { children, .. } = filter {
        for child in children {
            collect_relation_filter_targets(
                connection,
                data_source_id,
                child,
                depth + 1,
                nodes,
                targets,
            )?;
        }
        return Ok(());
    }
    let DatabaseViewFilter::Clause {
        property_id,
        operator,
        value,
    } = filter
    else {
        unreachable!("Database View filter variants are exhaustive")
    };
    if !matches!(
        operator,
        DatabaseViewFilterOperator::Contains | DatabaseViewFilterOperator::NotContains
    ) {
        return Ok(());
    }
    let target_data_source_id = connection
        .query_row(
            "SELECT relation.target_data_source_id \
             FROM data_source_relation_properties relation \
             JOIN data_source_properties property \
               ON property.data_source_id = relation.data_source_id \
               AND property.id = relation.property_id \
             WHERE relation.data_source_id = ?1 AND relation.property_id = ?2 \
               AND property.value_type = 'relation' AND property.lifecycle = 'active'",
            params![data_source_id, property_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    let Some(target_data_source_id) = target_data_source_id else {
        return Ok(());
    };
    let page_id = value
        .as_ref()
        .and_then(Option::as_ref)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| corrupt("Relation Property filter operand is invalid"))?;
    targets.insert((target_data_source_id, page_id.to_owned()));
    Ok(())
}

fn require_revision(expected: i64, actual: i64) -> Result<(), StoreError> {
    if expected == actual {
        return Ok(());
    }
    Err(StoreError::new(
        StoreErrorCode::RevisionConflict,
        format!("Relation value revision changed: expected {expected}, current {actual}"),
        true,
    ))
}

fn invalid(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message, false)
}

fn not_found(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::NotFound, message, false)
}

fn resource_exhausted(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::ResourceExhausted, message, false)
}

fn internal(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::Internal, message, false)
}

fn corrupt(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message, false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn view_relation_filter_is_reauthorized_after_target_access_revocation() {
        let connection = Connection::open_in_memory().expect("Relation authorization fixture");
        connection
            .execute_batch(
                "CREATE TABLE projects( \
                   id TEXT PRIMARY KEY, library_id TEXT NOT NULL, database_block_id TEXT); \
                 CREATE TABLE blocks( \
                   id TEXT PRIMARY KEY, library_id TEXT NOT NULL, type TEXT NOT NULL, \
                   lifecycle TEXT NOT NULL); \
                 CREATE TABLE pages( \
                   block_id TEXT PRIMARY KEY, library_id TEXT NOT NULL, document_id TEXT NOT NULL, \
                   parent_kind TEXT NOT NULL, parent_id TEXT NOT NULL); \
                 CREATE TABLE documents( \
                   id TEXT PRIMARY KEY, generation INTEGER NOT NULL, head_seq INTEGER NOT NULL, \
                   schema_version INTEGER NOT NULL); \
                 CREATE TABLE document_materializations( \
                   document_id TEXT NOT NULL, generation INTEGER NOT NULL, projected_seq INTEGER NOT NULL, \
                   schema_version INTEGER NOT NULL, title TEXT NOT NULL); \
                 CREATE TABLE data_sources( \
                   id TEXT PRIMARY KEY, library_id TEXT NOT NULL, home_database_block_id TEXT NOT NULL); \
                 CREATE TABLE data_source_page_memberships( \
                   data_source_id TEXT NOT NULL, page_block_id TEXT NOT NULL, removed_at TEXT); \
                 CREATE TABLE project_resource_grants( \
                   project_id TEXT NOT NULL, root_kind TEXT NOT NULL, root_id TEXT NOT NULL, \
                   lifecycle TEXT NOT NULL); \
                 CREATE TABLE data_source_properties( \
                   data_source_id TEXT NOT NULL, id TEXT NOT NULL, value_type TEXT NOT NULL, \
                   lifecycle TEXT NOT NULL); \
                 CREATE TABLE data_source_relation_properties( \
                   data_source_id TEXT NOT NULL, property_id TEXT NOT NULL, \
                   target_data_source_id TEXT NOT NULL); \
                 INSERT INTO projects VALUES ('project:reader', 'library:one', NULL); \
                 INSERT INTO blocks VALUES ('page:secret', 'library:one', 'page', 'active'); \
                 INSERT INTO pages VALUES ( \
                   'page:secret', 'library:one', 'document:secret', \
                   'data_source', 'source:secret'); \
                 INSERT INTO documents VALUES ('document:secret', 1, 1, 1); \
                 INSERT INTO document_materializations VALUES ( \
                   'document:secret', 1, 1, 1, 'Secret target'); \
                 INSERT INTO data_sources VALUES ( \
                   'source:secret', 'library:one', 'database:secret'); \
                 INSERT INTO data_source_page_memberships VALUES ( \
                   'source:secret', 'page:secret', NULL); \
                 INSERT INTO data_source_properties VALUES ( \
                   'source:tasks', 'p_blocked0', 'relation', 'active'); \
                 INSERT INTO data_source_relation_properties VALUES ( \
                   'source:tasks', 'p_blocked0', 'source:secret'); \
                 INSERT INTO project_resource_grants VALUES ( \
                   'project:reader', 'database', 'database:secret', 'active');",
            )
            .expect("Relation authorization rows");
        let filter = DatabaseViewFilter::Clause {
            property_id: "p_blocked0".to_owned(),
            operator: DatabaseViewFilterOperator::Contains,
            value: Some(Some(json!("page:secret"))),
        };
        validate_view_filter_read_access(
            &connection,
            "library:one",
            Some("project:reader"),
            "source:tasks",
            &filter,
        )
        .expect("authorized filter operand");

        connection
            .execute(
                "UPDATE project_resource_grants SET lifecycle = 'revoked'",
                [],
            )
            .expect("revoke target access");
        let error = validate_view_filter_read_access(
            &connection,
            "library:one",
            Some("project:reader"),
            "source:tasks",
            &filter,
        )
        .expect_err("stale View filter cannot retain a restricted Page identity");
        assert_eq!(error.code, StoreErrorCode::NotFound);
    }
}
