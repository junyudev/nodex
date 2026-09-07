//! Built-in ordering is a fenced view over existing Project and Session positions.
use std::collections::{BTreeSet, VecDeque};

use nodex_core_contracts::BoundModuleContext;
use nodex_core_contracts::collection::{
    CollectionWindow, CollectionWindowAuthority, CollectionWindowRequest,
};
use nodex_core_contracts::workspace::{
    ProjectCatalogChangeKind, ProjectSessionInvalidationScope, ProjectWorkspaceBuiltinSidebarLane,
    ProjectWorkspaceSidebarOrderEntry, ProjectWorkspaceSidebarSectionItemRef,
};
use rusqlite::{Connection, params};

use crate::infrastructure::collection_window::{WindowCandidate, assemble, normalize_request};
use crate::infrastructure::cursor::{
    self, CollectionCursorSubject, CursorDirection, KeysetCoordinate, KeysetValue,
};
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

use super::ProjectWorkspaceApplyOutcome;
use super::mutation::{WorkspaceMutationEffects, finish_mutation, finish_no_op};
use super::session_mutation::{sqlite_now, validate_id};

const MAX_BUILTIN_ORDER_ITEMS: usize = 10_000;

struct OrderRow {
    id: String,
    title: String,
    rank: i64,
    project_id: Option<String>,
    thread_id: Option<String>,
}

fn project_rows(
    connection: &Connection,
    library_id: &str,
    pinned: bool,
    default_only: bool,
) -> Result<Vec<OrderRow>, StoreError> {
    let rows = connection.prepare(
        "SELECT project.id, project.name, \
           CASE WHEN ?2 = 1 THEN pinned.\"order\" ELSE COALESCE(ordering.\"order\", 9223372036854775807) END AS rank \
         FROM projects project \
         LEFT JOIN project_order ordering ON ordering.project_id = project.id \
         LEFT JOIN pinned_project_order pinned ON pinned.project_id = project.id \
         WHERE project.library_id = ?1 AND project.lifecycle <> 'archived' \
           AND (?2 = 0 OR pinned.project_id IS NOT NULL) \
           AND (?3 = 0 OR (pinned.project_id IS NULL AND NOT EXISTS (\
             SELECT 1 FROM workspace_sidebar_section_items item \
             JOIN workspace_sidebar_sections section ON section.section_id = item.section_id \
               AND section.library_id = item.library_id \
             WHERE item.project_id = project.id AND section.lifecycle = 'active'))) \
         ORDER BY rank, project.created, project.id LIMIT ?4",
    )?.query_map(params![library_id, pinned, default_only, i64::try_from(MAX_BUILTIN_ORDER_ITEMS + 1).expect("bounded Sidebar count")], |row| Ok(OrderRow {
        id: row.get(0)?, title: row.get(1)?, rank: row.get(2)?, project_id: Some(row.get(0)?), thread_id: None,
    }))?.collect::<rusqlite::Result<Vec<_>>>()?;
    require_bounded(rows)
}

fn require_bounded(rows: Vec<OrderRow>) -> Result<Vec<OrderRow>, StoreError> {
    if rows.len() > MAX_BUILTIN_ORDER_ITEMS {
        return Err(invalid(
            "Built-in Sidebar order exceeds its 10000-item bound",
        ));
    }
    Ok(rows)
}

fn rows(
    connection: &Connection,
    library_id: &str,
    lane: ProjectWorkspaceBuiltinSidebarLane,
) -> Result<Vec<OrderRow>, StoreError> {
    match lane {
        ProjectWorkspaceBuiltinSidebarLane::Projects => {
            project_rows(connection, library_id, false, true)
        }
        ProjectWorkspaceBuiltinSidebarLane::PinnedProjects => {
            project_rows(connection, library_id, true, false)
        }
        ProjectWorkspaceBuiltinSidebarLane::PinnedSessions => require_bounded(
            super::sidebar_pins::read_order(connection, library_id)?
                .into_iter()
                .map(|row| OrderRow {
                    id: row.id,
                    title: row.title,
                    rank: row.rank,
                    project_id: row.project_id,
                    thread_id: row.thread_id,
                })
                .collect(),
        ),
    }
}

fn order_revision(
    lane: ProjectWorkspaceBuiltinSidebarLane,
    rows: &[OrderRow],
) -> Result<String, StoreError> {
    cursor::query_fingerprint(&(
        "builtin_sidebar_order_v1",
        lane,
        rows.iter()
            .map(|row| (&row.id, row.rank))
            .collect::<Vec<_>>(),
    ))
}

pub(super) fn read_order(
    connection: &Connection,
    library_id: &str,
    commit_head: i64,
    lane: ProjectWorkspaceBuiltinSidebarLane,
    request: &CollectionWindowRequest,
) -> Result<(String, CollectionWindow<ProjectWorkspaceSidebarOrderEntry>), StoreError> {
    let normalized = normalize_request(request)?;
    let current = rows(connection, library_id, lane)?;
    let revision = order_revision(lane, &current)?;
    let subject = CollectionCursorSubject {
        kind: "builtin_sidebar_order",
        library_id,
        query_fingerprint: &revision,
    };
    let after = normalized
        .after
        .map(|encoded| cursor::decode(connection, encoded, subject))
        .transpose()?
        .map(|(direction, coordinate)| {
            if direction != CursorDirection::Forward || coordinate.values.len() != 1 {
                return Err(invalid("Sidebar order cursor is incompatible"));
            }
            let [KeysetValue::Integer { value: index }] = coordinate.values.as_slice() else {
                return Err(invalid("Sidebar order cursor is invalid"));
            };
            let index =
                usize::try_from(*index).map_err(|_| invalid("Sidebar order cursor is invalid"))?;
            if current
                .get(index)
                .is_none_or(|row| row.id != coordinate.stable_id)
            {
                return Err(invalid("Sidebar order cursor is stale"));
            }
            Ok(index + 1)
        })
        .transpose()?
        .unwrap_or(0);
    let candidates = current
        .into_iter()
        .enumerate()
        .skip(after)
        .take(normalized.first + 1)
        .map(|(index, row)| WindowCandidate {
            coordinate: KeysetCoordinate {
                values: vec![KeysetValue::Integer {
                    value: i64::try_from(index).expect("bounded Sidebar position"),
                }],
                stable_id: row.id.clone(),
            },
            item: ProjectWorkspaceSidebarOrderEntry {
                item: if lane == ProjectWorkspaceBuiltinSidebarLane::PinnedSessions {
                    ProjectWorkspaceSidebarSectionItemRef::Session { session_id: row.id }
                } else {
                    ProjectWorkspaceSidebarSectionItemRef::Project { project_id: row.id }
                },
                title: row.title,
            },
        });
    let window = assemble(
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
    Ok((revision, window))
}

pub(super) enum OrderSelection<'a> {
    Complete(&'a [String]),
    ProjectPrefix(&'a [String]),
}

#[allow(clippy::too_many_arguments)]
pub(super) fn reorder(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    lane: ProjectWorkspaceBuiltinSidebarLane,
    expected_revision: &str,
    selection: OrderSelection<'_>,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    let (item_ids, operation_kind) = match selection {
        OrderSelection::Complete(ids) => (ids, "reorder_builtin_sidebar_items"),
        OrderSelection::ProjectPrefix(ids) => {
            if lane == ProjectWorkspaceBuiltinSidebarLane::PinnedSessions {
                return Err(invalid("Project priority requires a Project order lane"));
            }
            (ids, "prioritize_builtin_sidebar_projects")
        }
    };
    if item_ids.len() > MAX_BUILTIN_ORDER_ITEMS {
        return Err(invalid("Sidebar order exceeds its bound"));
    }
    for id in item_ids {
        validate_id("item_id", id)?;
    }
    let current = rows(connection, library_id, lane)?;
    if expected_revision != order_revision(lane, &current)? {
        return Err(conflict("Sidebar order changed; read every page again"));
    }
    let members = current
        .iter()
        .map(|row| row.id.as_str())
        .collect::<BTreeSet<_>>();
    let requested = item_ids.iter().map(String::as_str).collect::<BTreeSet<_>>();
    if requested.len() != item_ids.len() || !requested.is_subset(&members) {
        return Err(conflict("Sidebar order must contain unique current items"));
    }
    let item_ids = match selection {
        OrderSelection::Complete(_) => {
            if requested != members {
                return Err(conflict(
                    "Sidebar order must contain every current item exactly once",
                ));
            }
            item_ids.to_vec()
        }
        OrderSelection::ProjectPrefix(_) => item_ids
            .iter()
            .cloned()
            .chain(
                current
                    .iter()
                    .filter(|row| !requested.contains(row.id.as_str()))
                    .map(|row| row.id.clone()),
            )
            .collect(),
    };
    let project_ids = current
        .iter()
        .filter_map(|row| row.project_id.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let session_ids = if lane == ProjectWorkspaceBuiltinSidebarLane::PinnedSessions {
        item_ids.to_vec()
    } else {
        Vec::new()
    };
    let now = sqlite_now(connection)?;
    if item_ids
        .iter()
        .map(String::as_str)
        .eq(current.iter().map(|row| row.id.as_str()))
    {
        return finish_no_op(
            connection,
            context,
            store_epoch,
            operation_id,
            request_hash,
            operation_kind,
            project_ids,
            session_ids,
            &now,
        );
    }
    match lane {
        ProjectWorkspaceBuiltinSidebarLane::Projects => {
            let all = project_rows(connection, library_id, false, false)?;
            let mut replacement = item_ids.iter().collect::<VecDeque<_>>();
            for (rank, row) in all.iter().enumerate() {
                let id = if members.contains(row.id.as_str()) {
                    replacement
                        .pop_front()
                        .expect("complete Project lane membership")
                } else {
                    &row.id
                };
                connection.execute("INSERT INTO project_order(project_id, \"order\", updated) VALUES (?1, ?2, ?3) ON CONFLICT(project_id) DO UPDATE SET \"order\" = excluded.\"order\", updated = excluded.updated", params![id, i64::try_from(rank).expect("bounded Sidebar rank"), now])?;
            }
        }
        ProjectWorkspaceBuiltinSidebarLane::PinnedProjects => {
            for (rank, id) in item_ids.iter().enumerate() {
                connection.execute("UPDATE pinned_project_order SET \"order\" = ?1, updated = ?2 WHERE project_id = ?3", params![i64::try_from(rank).expect("bounded Sidebar rank"), now, id])?;
            }
        }
        ProjectWorkspaceBuiltinSidebarLane::PinnedSessions => {
            super::sidebar_pins::write_order(connection, &item_ids, &now)?
        }
    }
    finish_mutation(
        connection,
        context,
        store_epoch,
        operation_id,
        request_hash,
        WorkspaceMutationEffects {
            operation_kind,
            project_catalog_change: match lane {
                ProjectWorkspaceBuiltinSidebarLane::Projects => {
                    Some(ProjectCatalogChangeKind::Reordered)
                }
                ProjectWorkspaceBuiltinSidebarLane::PinnedProjects => {
                    Some(ProjectCatalogChangeKind::PinUpdated)
                }
                ProjectWorkspaceBuiltinSidebarLane::PinnedSessions => None,
            },
            change_project_id: None,
            project_ids,
            session_ids: session_ids.clone(),
            thread_ids: current
                .iter()
                .filter_map(|row| row.thread_id.clone())
                .collect(),
            session_summary_scopes: vec![ProjectSessionInvalidationScope::All],
            session_detail_ids: session_ids,
            block_ids: Vec::new(),
            document_ids: Vec::new(),
            database_ids: Vec::new(),
            page_ids: Vec::new(),
            data_source_ids: Vec::new(),
            view_ids: Vec::new(),
            document_heads: Vec::new(),
            committed_at: now,
            queued_follow_up_ledger: None,
        },
    )
}

fn invalid(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message, false)
}
fn conflict(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::RevisionConflict, message, true)
}
