use std::collections::{BTreeSet, HashMap};

use nodex_core_contracts::BoundModuleContext;
use nodex_core_contracts::collection::{
    CollectionWindow, CollectionWindowAuthority, CollectionWindowRequest,
};
use nodex_core_contracts::workspace::{
    CodexThreadActiveFlag, CodexThreadStatusType, ProjectLifecycle,
    ProjectSessionInvalidationScope, ProjectWorkspaceSidebarProjectItem,
    ProjectWorkspaceSidebarSectionHostLink, ProjectWorkspaceSidebarSectionHostSyncState,
    ProjectWorkspaceSidebarSectionItem, ProjectWorkspaceSidebarSectionItemPlacement,
    ProjectWorkspaceSidebarSectionItemRef, ProjectWorkspaceSidebarSectionItemValue,
    ProjectWorkspaceSidebarSectionKind, ProjectWorkspaceSidebarSectionLifecycle,
    ProjectWorkspaceSidebarSectionSummary, ProjectWorkspaceSidebarSessionItem,
    ProjectWorkspaceThreadStatus,
};
use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, OptionalExtension, params, params_from_iter};

use crate::domain::project_appearance::project_appearance_from_storage;
use crate::infrastructure::collection_window::{WindowCandidate, assemble, normalize_request};
use crate::infrastructure::cursor::{
    self, CollectionCursorSubject, CursorDirection, KeysetCoordinate, KeysetValue,
};
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

use super::ProjectWorkspaceApplyOutcome;
use super::mutation::{WorkspaceMutationEffects, finish_mutation, workspace_event_anchor};
use super::session_mutation::{sqlite_now, validate_id};

const MAX_SECTION_NAME_CHARS: usize = 120;
const MAX_CUSTOM_SECTIONS: i64 = 1_000;
const ROOT_CUSTOM_BASE: i64 = 2_000_000_000_000;
const ROOT_RANK_STEP: i64 = 1_000_000;
const ITEM_RANK_STEP: i64 = 1_000_000;

struct SectionRow {
    section_id: String,
    kind: String,
    name: Option<String>,
    rank_key: i64,
    revision: i64,
    lifecycle: String,
}

pub(super) fn read_direct_placement(
    connection: &Connection,
    library_id: &str,
    item: &ProjectWorkspaceSidebarSectionItemRef,
) -> Result<Option<String>, StoreError> {
    let (column, identity) = match item {
        ProjectWorkspaceSidebarSectionItemRef::Project { project_id } => {
            validate_id("project_id", project_id)?;
            ("project_id", project_id)
        }
        ProjectWorkspaceSidebarSectionItemRef::Session { session_id } => {
            validate_id("session_id", session_id)?;
            ("session_id", session_id)
        }
    };
    let sql = format!(
        "SELECT i.section_id FROM workspace_sidebar_section_items i \
         JOIN workspace_sidebar_sections s \
           ON s.library_id = i.library_id AND s.section_id = i.section_id \
         WHERE i.{column} = ?1 AND i.library_id = ?2 AND s.kind = 'custom' \
           AND s.lifecycle = 'active'"
    );
    connection
        .query_row(&sql, params![identity, library_id], |row| row.get(0))
        .optional()
        .map_err(StoreError::from)
}

pub(super) fn read_section_window(
    connection: &Connection,
    library_id: &str,
    commit_head: i64,
    include_deleted: bool,
    request: &CollectionWindowRequest,
) -> Result<CollectionWindow<ProjectWorkspaceSidebarSectionSummary>, StoreError> {
    let normalized = normalize_request(request)?;
    let fingerprint =
        cursor::query_fingerprint(&("workspace_sidebar_sections_v1", include_deleted))?;
    let subject = CollectionCursorSubject {
        kind: "workspace_sidebar_sections",
        library_id,
        query_fingerprint: &fingerprint,
    };
    let coordinate = normalized
        .after
        .map(|encoded| cursor::decode(connection, encoded, subject))
        .transpose()?
        .map(|(direction, coordinate)| {
            if direction != CursorDirection::Forward || coordinate.values.len() != 1 {
                return Err(invalid("Sidebar Section cursor is incompatible"));
            }
            let [KeysetValue::Integer { value: rank_key }] = coordinate.values.as_slice() else {
                return Err(invalid("Sidebar Section cursor coordinate is invalid"));
            };
            Ok((*rank_key, coordinate.stable_id))
        })
        .transpose()?;
    let mut parameters = vec![
        SqlValue::Text(library_id.to_owned()),
        SqlValue::Integer(i64::from(include_deleted)),
    ];
    let cursor_predicate = coordinate
        .map(|(rank_key, stable_id)| {
            parameters.extend([SqlValue::Integer(rank_key), SqlValue::Text(stable_id)]);
            "AND (rank_key > ?3 OR (rank_key = ?3 AND section_id > ?4))"
        })
        .unwrap_or_default();
    parameters.push(SqlValue::Integer(
        i64::try_from(normalized.first + 1)
            .map_err(|_| invalid("Sidebar Section window is too large"))?,
    ));
    let limit_parameter = parameters.len();
    let sql = format!(
        "SELECT section_id, kind, name, rank_key, revision, lifecycle \
         FROM workspace_sidebar_sections \
         WHERE library_id = ?1 AND (?2 = 1 OR lifecycle = 'active') {cursor_predicate} \
         ORDER BY rank_key, section_id LIMIT ?{limit_parameter}"
    );
    let rows = connection
        .prepare(&sql)?
        .query_map(params_from_iter(parameters.iter()), |row| {
            Ok(SectionRow {
                section_id: row.get(0)?,
                kind: row.get(1)?,
                name: row.get(2)?,
                rank_key: row.get(3)?,
                revision: row.get(4)?,
                lifecycle: row.get(5)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let candidates = rows
        .into_iter()
        .map(|row| {
            let rank_key = row.rank_key;
            let summary = section_summary(connection, library_id, row)?;
            Ok(WindowCandidate {
                coordinate: KeysetCoordinate {
                    values: vec![KeysetValue::Integer { value: rank_key }],
                    stable_id: summary.section_id.clone(),
                },
                item: summary,
            })
        })
        .collect::<Result<Vec<_>, StoreError>>()?;
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

pub(super) fn read_section_item_window(
    connection: &Connection,
    library_id: &str,
    commit_head: i64,
    section_id: &str,
    include_archived: bool,
    request: &CollectionWindowRequest,
) -> Result<CollectionWindow<ProjectWorkspaceSidebarSectionItem>, StoreError> {
    validate_id("section_id", section_id)?;
    require_custom_section(connection, library_id, section_id, true)?;
    let normalized = normalize_request(request)?;
    let fingerprint = cursor::query_fingerprint(&(
        "workspace_sidebar_section_items_v1",
        section_id,
        include_archived,
    ))?;
    let subject = CollectionCursorSubject {
        kind: "workspace_sidebar_section_items",
        library_id,
        query_fingerprint: &fingerprint,
    };
    let coordinate = normalized
        .after
        .map(|encoded| cursor::decode(connection, encoded, subject))
        .transpose()?
        .map(|(direction, coordinate)| {
            if direction != CursorDirection::Forward || coordinate.values.len() != 1 {
                return Err(invalid("Sidebar Section item cursor is incompatible"));
            }
            let [KeysetValue::Integer { value: rank_key }] = coordinate.values.as_slice() else {
                return Err(invalid("Sidebar Section item cursor coordinate is invalid"));
            };
            Ok((*rank_key, coordinate.stable_id))
        })
        .transpose()?;
    let mut parameters = vec![
        SqlValue::Text(section_id.to_owned()),
        SqlValue::Text(library_id.to_owned()),
        SqlValue::Integer(i64::from(include_archived)),
    ];
    let cursor_predicate = coordinate
        .map(|(rank_key, stable_id)| {
            parameters.extend([SqlValue::Integer(rank_key), SqlValue::Text(stable_id)]);
            "AND (item.rank_key > ?4 OR (item.rank_key = ?4 AND item.placement_id > ?5))"
        })
        .unwrap_or_default();
    parameters.push(SqlValue::Integer(
        i64::try_from(normalized.first + 1)
            .map_err(|_| invalid("Sidebar Section item window is too large"))?,
    ));
    let limit_parameter = parameters.len();
    let sql = format!(
        "SELECT item.placement_id, item.rank_key, item.revision, \
           project.id, project.name, project.lifecycle, project.appearance_color, \
           project.appearance_marker_kind, project.appearance_marker_value, \
           pinned_project.project_id, \
           session.id, session.project_id, session.no_thread_fallback_title, \
           session.pinned, session.archived, session.unread, \
           thread.thread_id, thread.thread_name, thread.thread_preview, \
           thread.status_type, thread.status_active_flags_json \
         FROM workspace_sidebar_section_items item \
         JOIN workspace_sidebar_sections section \
           ON section.library_id = item.library_id AND section.section_id = item.section_id \
         LEFT JOIN projects project ON project.id = item.project_id \
         LEFT JOIN pinned_project_order pinned_project ON pinned_project.project_id = project.id \
         LEFT JOIN project_sessions session ON session.id = item.session_id \
         LEFT JOIN project_session_threads link ON link.session_id = session.id \
         LEFT JOIN codex_threads thread ON thread.thread_id = link.thread_id \
         WHERE item.section_id = ?1 AND item.library_id = ?2 AND section.lifecycle = 'active' \
           AND ((project.id IS NOT NULL AND (?3 = 1 OR project.lifecycle <> 'archived')) \
             OR (session.id IS NOT NULL AND (?3 = 1 OR session.archived = 0))) \
           {cursor_predicate} \
         ORDER BY item.rank_key, item.placement_id LIMIT ?{limit_parameter}"
    );
    let rows = connection
        .prepare(&sql)?
        .query_map(params_from_iter(parameters.iter()), section_item_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let candidates = rows.into_iter().map(|item| WindowCandidate {
        coordinate: KeysetCoordinate {
            values: vec![KeysetValue::Integer {
                value: item.rank_key,
            }],
            stable_id: item.placement_id.clone(),
        },
        item,
    });
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

pub(super) fn read_host_link_window(
    connection: &Connection,
    library_id: &str,
    commit_head: i64,
    host_id: &str,
    request: &CollectionWindowRequest,
) -> Result<CollectionWindow<ProjectWorkspaceSidebarSectionHostLink>, StoreError> {
    validate_id("host_id", host_id)?;
    let normalized = normalize_request(request)?;
    let fingerprint = cursor::query_fingerprint(&("workspace_sidebar_host_links_v1", host_id))?;
    let subject = CollectionCursorSubject {
        kind: "workspace_sidebar_host_links",
        library_id,
        query_fingerprint: &fingerprint,
    };
    let stable_after = normalized
        .after
        .map(|encoded| cursor::decode(connection, encoded, subject))
        .transpose()?
        .map(|(direction, coordinate)| {
            if direction != CursorDirection::Forward || !coordinate.values.is_empty() {
                return Err(invalid("Sidebar Section host-link cursor is incompatible"));
            }
            Ok(coordinate.stable_id)
        })
        .transpose()?;
    let rows = connection
        .prepare(
            "SELECT link.section_id, link.host_id, link.remote_section_id, link.sync_state, \
               link.observed_generation, link.last_error, link.updated_at \
             FROM workspace_sidebar_section_host_links link \
             WHERE link.library_id = ?1 AND link.host_id = ?2 AND link.section_id > ?3 \
             ORDER BY link.section_id LIMIT ?4",
        )?
        .query_map(
            params![
                library_id,
                host_id,
                stable_after.as_deref().unwrap_or(""),
                i64::try_from(normalized.first + 1)
                    .map_err(|_| invalid("Sidebar Section host-link window is too large"))?,
            ],
            |row| {
                Ok(ProjectWorkspaceSidebarSectionHostLink {
                    section_id: row.get(0)?,
                    host_id: row.get(1)?,
                    remote_section_id: row.get(2)?,
                    sync_state: parse_sync_state(&row.get::<_, String>(3)?)?,
                    observed_generation: row.get(4)?,
                    last_error: row.get(5)?,
                    updated_at: row.get(6)?,
                })
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let candidates = rows.into_iter().map(|link| WindowCandidate {
        coordinate: KeysetCoordinate {
            values: Vec::new(),
            stable_id: link.section_id.clone(),
        },
        item: link,
    });
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

#[allow(clippy::too_many_arguments)]
pub(super) fn create_section(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    section_id: &str,
    name: &str,
    initial_item: Option<&ProjectWorkspaceSidebarSectionItemRef>,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    validate_id("section_id", section_id)?;
    let name = normalize_name(name, true)?;
    let custom_count = connection.query_row(
        "SELECT count(*) FROM workspace_sidebar_sections WHERE library_id = ?1 AND kind = 'custom'",
        [library_id],
        |row| row.get::<_, i64>(0),
    )?;
    if custom_count >= MAX_CUSTOM_SECTIONS {
        return Err(StoreError::new(
            StoreErrorCode::ResourceExhausted,
            "Sidebar Section collection reached its bound",
            false,
        ));
    }
    let exists = connection
        .query_row(
            "SELECT 1 FROM workspace_sidebar_sections \
             WHERE library_id = ?1 AND section_id = ?2",
            params![library_id, section_id],
            |_| Ok(()),
        )
        .optional()?;
    if exists.is_some() {
        return Err(conflict("Sidebar Section identity already exists"));
    }
    let now = sqlite_now(connection)?;
    let rank_key = ROOT_CUSTOM_BASE
        .checked_add(custom_count.saturating_mul(ROOT_RANK_STEP))
        .ok_or_else(|| invalid("Sidebar Section rank overflowed"))?;
    connection.execute(
        "INSERT INTO workspace_sidebar_sections( \
           section_id, library_id, kind, name, rank_key, revision, lifecycle, \
           deleted_at, created_at, updated_at \
         ) VALUES (?1, ?2, 'custom', ?3, ?4, 1, 'active', NULL, ?5, ?5)",
        params![section_id, library_id, name, rank_key, now],
    )?;
    let mut project_ids = Vec::new();
    let mut session_ids = Vec::new();
    if let Some(item) = initial_item {
        place_item(
            connection,
            library_id,
            section_id,
            item,
            &ProjectWorkspaceSidebarSectionItemPlacement::End,
            &now,
        )?;
        collect_item_ids(item, &mut project_ids, &mut session_ids);
    }
    finish_section_mutation(
        connection,
        library_id,
        context,
        store_epoch,
        operation_id,
        request_hash,
        "create_sidebar_section",
        project_ids,
        session_ids,
        now,
    )
}

#[allow(clippy::too_many_arguments)]
pub(super) fn rename_section(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    section_id: &str,
    name: &str,
    expected_revision: i64,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    validate_id("section_id", section_id)?;
    let name = normalize_name(name, false)?;
    let now = sqlite_now(connection)?;
    let changed = connection.execute(
        "UPDATE workspace_sidebar_sections SET name = ?1, revision = revision + 1, updated_at = ?2 \
         WHERE section_id = ?3 AND library_id = ?4 AND kind = 'custom' \
           AND lifecycle = 'active' AND revision = ?5",
        params![name, now, section_id, library_id, expected_revision],
    )?;
    require_revision_change(connection, library_id, section_id, changed)?;
    finish_section_mutation(
        connection,
        library_id,
        context,
        store_epoch,
        operation_id,
        request_hash,
        "rename_sidebar_section",
        Vec::new(),
        Vec::new(),
        now,
    )
}

#[allow(clippy::too_many_arguments)]
pub(super) fn set_section_deleted(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    section_id: &str,
    expected_revision: i64,
    deleted: bool,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    validate_id("section_id", section_id)?;
    let now = sqlite_now(connection)?;
    let source = if deleted { "active" } else { "deleted" };
    let target = if deleted { "deleted" } else { "active" };
    let changed = connection.execute(
        "UPDATE workspace_sidebar_sections SET lifecycle = ?1, deleted_at = ?2, \
           revision = revision + 1, updated_at = ?3 \
         WHERE section_id = ?4 AND library_id = ?5 AND kind = 'custom' \
           AND lifecycle = ?6 AND revision = ?7",
        params![
            target,
            deleted.then_some(now.as_str()),
            now,
            section_id,
            library_id,
            source,
            expected_revision,
        ],
    )?;
    require_revision_change(connection, library_id, section_id, changed)?;
    let (project_ids, session_ids) = section_member_ids(connection, library_id, section_id)?;
    finish_section_mutation(
        connection,
        library_id,
        context,
        store_epoch,
        operation_id,
        request_hash,
        if deleted {
            "delete_sidebar_section"
        } else {
            "restore_sidebar_section"
        },
        project_ids,
        session_ids,
        now,
    )
}

#[allow(clippy::too_many_arguments)]
pub(super) fn move_item(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    item: &ProjectWorkspaceSidebarSectionItemRef,
    section_id: Option<&str>,
    placement: &ProjectWorkspaceSidebarSectionItemPlacement,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    validate_item(connection, library_id, item)?;
    let now = sqlite_now(connection)?;
    if let Some(section_id) = section_id {
        validate_id("section_id", section_id)?;
        require_custom_section(connection, library_id, section_id, true)?;
        place_item(connection, library_id, section_id, item, placement, &now)?;
    } else {
        connection.execute(
            "DELETE FROM workspace_sidebar_section_items \
             WHERE placement_id = ?1 AND library_id = ?2",
            params![item.stable_key(), library_id],
        )?;
    }
    let mut project_ids = Vec::new();
    let mut session_ids = Vec::new();
    collect_item_ids(item, &mut project_ids, &mut session_ids);
    finish_section_mutation(
        connection,
        library_id,
        context,
        store_epoch,
        operation_id,
        request_hash,
        "move_sidebar_section_item",
        project_ids,
        session_ids,
        now,
    )
}

#[allow(clippy::too_many_arguments)]
pub(super) fn reorder_sections(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    section_ids: &[String],
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    let requested = section_ids.iter().cloned().collect::<BTreeSet<_>>();
    if requested.len() != section_ids.len() {
        return Err(invalid(
            "Sidebar Section order contains duplicate identities",
        ));
    }
    let current = connection
        .prepare(
            "SELECT section_id FROM workspace_sidebar_sections \
             WHERE library_id = ?1 AND kind = 'custom' AND lifecycle = 'active' \
             ORDER BY rank_key, section_id",
        )?
        .query_map([library_id], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if requested != current.iter().cloned().collect::<BTreeSet<_>>() {
        return Err(conflict(
            "Sidebar Section order must contain every active custom Section",
        ));
    }
    let now = sqlite_now(connection)?;
    for section_id in section_ids {
        connection.execute(
            "UPDATE workspace_sidebar_sections SET rank_key = -rank_key - 1 \
             WHERE section_id = ?1 AND library_id = ?2",
            params![section_id, library_id],
        )?;
    }
    for (index, section_id) in section_ids.iter().enumerate() {
        connection.execute(
            "UPDATE workspace_sidebar_sections SET rank_key = ?1, revision = revision + 1, \
               updated_at = ?2 WHERE section_id = ?3 AND library_id = ?4",
            params![
                ROOT_CUSTOM_BASE
                    + i64::try_from(index)
                        .map_err(|_| invalid("Sidebar Section order is invalid"))?
                        * ROOT_RANK_STEP,
                now,
                section_id,
                library_id,
            ],
        )?;
    }
    finish_section_mutation(
        connection,
        library_id,
        context,
        store_epoch,
        operation_id,
        request_hash,
        "reorder_sidebar_sections",
        Vec::new(),
        Vec::new(),
        now,
    )
}

#[allow(clippy::too_many_arguments)]
pub(super) fn reorder_section_sessions(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    section_id: &str,
    session_ids: &[String],
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    require_custom_section(connection, library_id, section_id, true)?;
    let rows = read_placement_rows(connection, library_id, section_id)?;
    let current_sessions = rows
        .iter()
        .filter_map(|row| row.session_id.clone())
        .collect::<Vec<_>>();
    let requested = session_ids.iter().cloned().collect::<BTreeSet<_>>();
    if requested.len() != session_ids.len()
        || requested != current_sessions.iter().cloned().collect::<BTreeSet<_>>()
    {
        return Err(conflict(
            "Section Session order must contain every direct Session exactly once",
        ));
    }
    let session_placements = rows
        .iter()
        .filter_map(|row| {
            row.session_id
                .as_ref()
                .map(|id| (id.clone(), row.placement_id.clone()))
        })
        .collect::<HashMap<_, _>>();
    let session_ranks = rows
        .iter()
        .filter(|row| row.session_id.is_some())
        .map(|row| row.rank_key)
        .collect::<Vec<_>>();
    let now = sqlite_now(connection)?;
    for placement_id in session_placements.values() {
        connection.execute(
            "UPDATE workspace_sidebar_section_items SET rank_key = -rank_key - 1 WHERE placement_id = ?1",
            [placement_id],
        )?;
    }
    for (session_id, rank_key) in session_ids.iter().zip(session_ranks) {
        let placement_id = session_placements
            .get(session_id)
            .ok_or_else(|| corrupt("Section Session placement disappeared"))?;
        connection.execute(
            "UPDATE workspace_sidebar_section_items SET rank_key = ?1, revision = revision + 1, \
               updated_at = ?2 WHERE placement_id = ?3",
            params![rank_key, now, placement_id],
        )?;
    }
    finish_section_mutation(
        connection,
        library_id,
        context,
        store_epoch,
        operation_id,
        request_hash,
        "reorder_sidebar_section_sessions",
        Vec::new(),
        session_ids.to_vec(),
        now,
    )
}

#[allow(clippy::too_many_arguments)]
pub(super) fn archive_section_sessions(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    section_id: &str,
    replacement_session_id: Option<&str>,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    require_custom_section(connection, library_id, section_id, true)?;
    let mut session_ids = effective_session_ids(connection, library_id, section_id, false)?;
    let now = sqlite_now(connection)?;
    let mut project_ids = BTreeSet::new();
    for session_id in &session_ids {
        if let Some(project_id) = connection.query_row(
            "SELECT project_id FROM project_sessions WHERE id = ?1",
            [session_id],
            |row| row.get::<_, Option<String>>(0),
        )? {
            project_ids.insert(project_id);
        }
        connection.execute(
            "UPDATE project_sessions SET archived = 1, archived_at = ?1, pinned = 0, \
               pinned_order = NULL, unread = 0, updated_at = ?1 WHERE id = ?2",
            params![now, session_id],
        )?;
        connection.execute(
            "UPDATE codex_threads SET archived = 1 WHERE thread_id IN ( \
               SELECT thread_id FROM project_session_threads WHERE session_id = ?1)",
            [session_id],
        )?;
        connection.execute(
            "DELETE FROM codex_pinned_threads WHERE thread_id IN ( \
               SELECT thread_id FROM project_session_threads WHERE session_id = ?1)",
            [session_id],
        )?;
    }
    if let Some(replacement_session_id) = replacement_session_id {
        validate_id("replacement_session_id", replacement_session_id)?;
        let replacement_now = super::session_lifecycle::insert_session_records(
            connection,
            replacement_session_id,
            None,
            "New chat",
            false,
        )?;
        place_created_session(
            connection,
            library_id,
            section_id,
            replacement_session_id,
            &replacement_now,
        )?;
        session_ids.push(replacement_session_id.to_owned());
    }
    finish_section_mutation(
        connection,
        library_id,
        context,
        store_epoch,
        operation_id,
        request_hash,
        "archive_sidebar_section_sessions",
        project_ids.into_iter().collect(),
        session_ids,
        now,
    )
}

#[allow(clippy::too_many_arguments)]
pub(super) fn upsert_host_link(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    link: &ProjectWorkspaceSidebarSectionHostLink,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    validate_id("section_id", &link.section_id)?;
    validate_id("host_id", &link.host_id)?;
    if let Some(remote_section_id) = &link.remote_section_id {
        validate_id("remote_section_id", remote_section_id)?;
    }
    require_custom_section(connection, library_id, &link.section_id, false)?;
    let now = sqlite_now(connection)?;
    connection.execute(
        "INSERT INTO workspace_sidebar_section_host_links( \
           library_id, section_id, host_id, remote_section_id, sync_state, observed_generation, \
           last_error, updated_at \
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) \
         ON CONFLICT(library_id, section_id, host_id) DO UPDATE SET \
           remote_section_id = excluded.remote_section_id, sync_state = excluded.sync_state, \
           observed_generation = excluded.observed_generation, last_error = excluded.last_error, \
           updated_at = excluded.updated_at",
        params![
            library_id,
            link.section_id,
            link.host_id,
            link.remote_section_id,
            sync_state_literal(link.sync_state),
            link.observed_generation,
            link.last_error,
            now,
        ],
    )?;
    finish_section_mutation(
        connection,
        library_id,
        context,
        store_epoch,
        operation_id,
        request_hash,
        "upsert_sidebar_section_host_link",
        Vec::new(),
        Vec::new(),
        now,
    )
}

#[allow(clippy::too_many_arguments)]
pub(super) fn delete_host_link(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    section_id: &str,
    host_id: &str,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    require_custom_section(connection, library_id, section_id, false)?;
    validate_id("host_id", host_id)?;
    let now = sqlite_now(connection)?;
    connection.execute(
        "DELETE FROM workspace_sidebar_section_host_links \
         WHERE library_id = ?1 AND section_id = ?2 AND host_id = ?3",
        params![library_id, section_id, host_id],
    )?;
    finish_section_mutation(
        connection,
        library_id,
        context,
        store_epoch,
        operation_id,
        request_hash,
        "delete_sidebar_section_host_link",
        Vec::new(),
        Vec::new(),
        now,
    )
}

pub(super) fn place_created_session(
    connection: &Connection,
    library_id: &str,
    section_id: &str,
    session_id: &str,
    now: &str,
) -> Result<(), StoreError> {
    let item = ProjectWorkspaceSidebarSectionItemRef::Session {
        session_id: session_id.to_owned(),
    };
    place_item(
        connection,
        library_id,
        section_id,
        &item,
        &ProjectWorkspaceSidebarSectionItemPlacement::Start,
        now,
    )
}

fn section_summary(
    connection: &Connection,
    library_id: &str,
    row: SectionRow,
) -> Result<ProjectWorkspaceSidebarSectionSummary, StoreError> {
    let kind = parse_section_kind(&row.kind)?;
    let lifecycle = parse_lifecycle(&row.lifecycle)?;
    let (direct_item_count, effective_session_count, has_running, has_unread) =
        section_metrics(connection, library_id, &row.section_id, kind, lifecycle)?;
    Ok(ProjectWorkspaceSidebarSectionSummary {
        section_id: row.section_id,
        kind,
        name: row.name,
        rank_key: row.rank_key,
        revision: row.revision,
        lifecycle,
        direct_item_count,
        effective_session_count,
        has_running,
        has_unread,
    })
}

fn section_metrics(
    connection: &Connection,
    library_id: &str,
    section_id: &str,
    kind: ProjectWorkspaceSidebarSectionKind,
    lifecycle: ProjectWorkspaceSidebarSectionLifecycle,
) -> Result<(u32, u32, bool, bool), StoreError> {
    if lifecycle == ProjectWorkspaceSidebarSectionLifecycle::Deleted {
        return Ok((0, 0, false, false));
    }
    let (direct, session_ids) = match kind {
        ProjectWorkspaceSidebarSectionKind::Custom => {
            let direct = connection.query_row(
                "SELECT count(*) FROM workspace_sidebar_section_items \
                 WHERE library_id = ?1 AND section_id = ?2",
                params![library_id, section_id],
                |row| row.get::<_, i64>(0),
            )?;
            (
                direct,
                effective_session_ids(connection, library_id, section_id, false)?,
            )
        }
        ProjectWorkspaceSidebarSectionKind::Pinned => {
            let direct = connection.query_row(
                "SELECT (SELECT count(*) FROM pinned_project_order pinned \
                    JOIN projects project ON project.id = pinned.project_id \
                    WHERE project.library_id = ?1 AND project.lifecycle <> 'archived') \
                  + (SELECT count(*) FROM project_sessions session \
                    LEFT JOIN projects project ON project.id = session.project_id \
                    WHERE session.pinned = 1 AND session.archived = 0 \
                      AND (session.project_id IS NULL OR project.library_id = ?1))",
                [library_id],
                |row| row.get::<_, i64>(0),
            )?;
            let ids = connection
                .prepare(
                    "SELECT session.id FROM project_sessions session \
                     LEFT JOIN projects project ON project.id = session.project_id \
                     WHERE session.archived = 0 AND (session.pinned = 1 OR EXISTS ( \
                       SELECT 1 FROM pinned_project_order pinned \
                       WHERE pinned.project_id = session.project_id)) \
                       AND NOT EXISTS (SELECT 1 FROM workspace_sidebar_section_items item \
                         JOIN workspace_sidebar_sections section \
                           ON section.library_id = item.library_id \
                          AND section.section_id = item.section_id \
                         WHERE item.session_id = session.id AND item.library_id = ?1 \
                           AND section.lifecycle = 'active') \
                       AND (session.project_id IS NULL OR project.library_id = ?1)",
                )?
                .query_map([library_id], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            (direct, ids)
        }
        ProjectWorkspaceSidebarSectionKind::Projects => {
            let direct = connection.query_row(
                "SELECT count(*) FROM projects project \
                 WHERE project.library_id = ?1 AND project.lifecycle <> 'archived' \
                   AND NOT EXISTS (SELECT 1 FROM pinned_project_order pinned WHERE pinned.project_id = project.id) \
                   AND NOT EXISTS (SELECT 1 FROM workspace_sidebar_section_items item \
                     JOIN workspace_sidebar_sections section \
                       ON section.library_id = item.library_id \
                      AND section.section_id = item.section_id \
                     WHERE item.project_id = project.id AND item.library_id = ?1 \
                       AND section.lifecycle = 'active')",
                [library_id],
                |row| row.get::<_, i64>(0),
            )?;
            (direct, Vec::new())
        }
        ProjectWorkspaceSidebarSectionKind::Chats => {
            let ids = connection
                .prepare(
                    "SELECT session.id FROM project_sessions session \
                     WHERE session.project_id IS NULL AND session.archived = 0 AND session.pinned = 0 \
                       AND NOT EXISTS (SELECT 1 FROM workspace_sidebar_section_items item \
                         JOIN workspace_sidebar_sections section \
                           ON section.library_id = item.library_id \
                          AND section.section_id = item.section_id \
                         WHERE item.session_id = session.id AND item.library_id = ?1 \
                           AND section.lifecycle = 'active')",
                )?
                .query_map([library_id], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            (i64::try_from(ids.len()).unwrap_or(i64::MAX), ids)
        }
        ProjectWorkspaceSidebarSectionKind::Pages => (0, Vec::new()),
    };
    let (has_running, has_unread) = session_activity(connection, &session_ids)?;
    Ok((
        u32::try_from(direct).map_err(|_| corrupt("Sidebar Section item count overflowed"))?,
        u32::try_from(session_ids.len())
            .map_err(|_| corrupt("Sidebar Section Session count overflowed"))?,
        has_running,
        has_unread,
    ))
}

fn effective_session_ids(
    connection: &Connection,
    library_id: &str,
    section_id: &str,
    include_archived: bool,
) -> Result<Vec<String>, StoreError> {
    connection
        .prepare(
            "SELECT session.id FROM project_sessions session \
             WHERE (?3 = 1 OR session.archived = 0) AND ( \
               EXISTS (SELECT 1 FROM workspace_sidebar_section_items direct \
                 WHERE direct.library_id = ?1 AND direct.section_id = ?2 \
                   AND direct.session_id = session.id) \
               OR (EXISTS (SELECT 1 FROM workspace_sidebar_section_items project_item \
                     WHERE project_item.library_id = ?1 AND project_item.section_id = ?2 \
                       AND project_item.project_id = session.project_id) \
                 AND NOT EXISTS (SELECT 1 FROM workspace_sidebar_section_items override_item \
                   JOIN workspace_sidebar_sections override_section \
                     ON override_section.library_id = override_item.library_id \
                    AND override_section.section_id = override_item.section_id \
                   WHERE override_item.library_id = ?1 AND override_item.session_id = session.id \
                     AND override_section.lifecycle = 'active')) \
             ) ORDER BY session.id",
        )?
        .query_map(
            params![library_id, section_id, i64::from(include_archived)],
            |row| row.get::<_, String>(0),
        )?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(Into::into)
}

fn session_activity(
    connection: &Connection,
    session_ids: &[String],
) -> Result<(bool, bool), StoreError> {
    if session_ids.is_empty() {
        return Ok((false, false));
    }
    let encoded = serde_json::to_string(session_ids)
        .map_err(|_| corrupt("Sidebar Section Session activity input could not be encoded"))?;
    connection
        .query_row(
            "WITH requested(session_id) AS (SELECT value FROM json_each(?1)) \
             SELECT EXISTS(SELECT 1 FROM requested \
               JOIN project_sessions session ON session.id = requested.session_id \
               JOIN project_session_threads link ON link.session_id = session.id \
               JOIN codex_threads thread ON thread.thread_id = link.thread_id \
               WHERE thread.status_type = 'active'), \
             EXISTS(SELECT 1 FROM requested \
               JOIN project_sessions session ON session.id = requested.session_id \
               WHERE session.unread = 1)",
            [encoded],
            |row| Ok((row.get::<_, i64>(0)? == 1, row.get::<_, i64>(1)? == 1)),
        )
        .map_err(Into::into)
}

fn section_item_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<ProjectWorkspaceSidebarSectionItem> {
    let value = if let Some(project_id) = row.get::<_, Option<String>>(3)? {
        let lifecycle = parse_project_lifecycle(&row.get::<_, String>(5)?)?;
        let appearance = project_appearance_from_storage(
            &row.get::<_, String>(6)?,
            &row.get::<_, String>(7)?,
            &row.get::<_, String>(8)?,
        )
        .map_err(|_| rusqlite::Error::InvalidQuery)?;
        ProjectWorkspaceSidebarSectionItemValue::Project {
            project: ProjectWorkspaceSidebarProjectItem {
                project_id,
                name: row.get(4)?,
                lifecycle,
                appearance,
                pinned: row.get::<_, Option<String>>(9)?.is_some(),
            },
        }
    } else {
        let fallback_title = row.get::<_, String>(12)?;
        let thread_name = row.get::<_, Option<String>>(17)?;
        let thread_preview = row.get::<_, Option<String>>(18)?;
        let display_title = super::read::project_session_display_title(
            thread_name.as_deref(),
            thread_preview.as_deref(),
            &fallback_title,
        );
        let status = row
            .get::<_, Option<String>>(19)?
            .map(|status| {
                Ok::<ProjectWorkspaceThreadStatus, rusqlite::Error>(ProjectWorkspaceThreadStatus {
                    status_type: parse_status_type(&status)?,
                    active_flags: serde_json::from_str::<Vec<CodexThreadActiveFlag>>(
                        &row.get::<_, String>(20)?,
                    )
                    .map_err(|_| rusqlite::Error::InvalidQuery)?,
                })
            })
            .transpose()?;
        ProjectWorkspaceSidebarSectionItemValue::Session {
            session: ProjectWorkspaceSidebarSessionItem {
                session_id: row.get(10)?,
                project_id: row.get(11)?,
                display_title,
                pinned: row.get::<_, i64>(13)? == 1,
                archived: row.get::<_, i64>(14)? == 1,
                unread: row.get::<_, i64>(15)? == 1,
                thread_id: row.get(16)?,
                status,
            },
        }
    };
    Ok(ProjectWorkspaceSidebarSectionItem {
        placement_id: row.get(0)?,
        rank_key: row.get(1)?,
        revision: row.get(2)?,
        value,
    })
}

fn place_item(
    connection: &Connection,
    library_id: &str,
    section_id: &str,
    item: &ProjectWorkspaceSidebarSectionItemRef,
    placement: &ProjectWorkspaceSidebarSectionItemPlacement,
    now: &str,
) -> Result<(), StoreError> {
    validate_item(connection, library_id, item)?;
    clear_pin(connection, item)?;
    let placement_id = item.stable_key();
    connection.execute(
        "DELETE FROM workspace_sidebar_section_items WHERE placement_id = ?1",
        [&placement_id],
    )?;
    let mut rows = read_placement_rows(connection, library_id, section_id)?;
    let target_index = match placement {
        ProjectWorkspaceSidebarSectionItemPlacement::Start => 0,
        ProjectWorkspaceSidebarSectionItemPlacement::End => rows.len(),
        ProjectWorkspaceSidebarSectionItemPlacement::Before { item: anchor } => rows
            .iter()
            .position(|row| row.placement_id == anchor.stable_key())
            .ok_or_else(|| conflict("Sidebar Section placement anchor is unavailable"))?,
        ProjectWorkspaceSidebarSectionItemPlacement::After { item: anchor } => rows
            .iter()
            .position(|row| row.placement_id == anchor.stable_key())
            .map(|index| index + 1)
            .ok_or_else(|| conflict("Sidebar Section placement anchor is unavailable"))?,
    };
    for row in &rows {
        connection.execute(
            "UPDATE workspace_sidebar_section_items SET rank_key = -rank_key - 1 WHERE placement_id = ?1",
            [&row.placement_id],
        )?;
    }
    rows.insert(
        target_index,
        PlacementRow {
            placement_id: placement_id.clone(),
            project_id: match item {
                ProjectWorkspaceSidebarSectionItemRef::Project { project_id } => {
                    Some(project_id.clone())
                }
                ProjectWorkspaceSidebarSectionItemRef::Session { .. } => None,
            },
            session_id: match item {
                ProjectWorkspaceSidebarSectionItemRef::Session { session_id } => {
                    Some(session_id.clone())
                }
                ProjectWorkspaceSidebarSectionItemRef::Project { .. } => None,
            },
            rank_key: 0,
        },
    );
    for (index, row) in rows.iter().enumerate() {
        let rank_key = i64::try_from(index)
            .map_err(|_| invalid("Sidebar Section item order is invalid"))?
            .saturating_mul(ITEM_RANK_STEP);
        if row.placement_id == placement_id {
            connection.execute(
                "INSERT INTO workspace_sidebar_section_items( \
                   placement_id, library_id, section_id, section_kind, project_id, session_id, \
                   rank_key, revision, created_at, updated_at \
                 ) VALUES (?1, ?2, ?3, 'custom', ?4, ?5, ?6, 1, ?7, ?7)",
                params![
                    row.placement_id,
                    library_id,
                    section_id,
                    row.project_id,
                    row.session_id,
                    rank_key,
                    now,
                ],
            )?;
        } else {
            connection.execute(
                "UPDATE workspace_sidebar_section_items SET rank_key = ?1, revision = revision + 1, \
                   updated_at = ?2 WHERE placement_id = ?3",
                params![rank_key, now, row.placement_id],
            )?;
        }
    }
    Ok(())
}

#[derive(Clone)]
struct PlacementRow {
    placement_id: String,
    project_id: Option<String>,
    session_id: Option<String>,
    rank_key: i64,
}

fn read_placement_rows(
    connection: &Connection,
    library_id: &str,
    section_id: &str,
) -> Result<Vec<PlacementRow>, StoreError> {
    connection
        .prepare(
            "SELECT placement_id, project_id, session_id, rank_key \
             FROM workspace_sidebar_section_items \
             WHERE library_id = ?1 AND section_id = ?2 \
             ORDER BY rank_key, placement_id",
        )?
        .query_map(params![library_id, section_id], |row| {
            Ok(PlacementRow {
                placement_id: row.get(0)?,
                project_id: row.get(1)?,
                session_id: row.get(2)?,
                rank_key: row.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(Into::into)
}

fn clear_pin(
    connection: &Connection,
    item: &ProjectWorkspaceSidebarSectionItemRef,
) -> Result<(), StoreError> {
    match item {
        ProjectWorkspaceSidebarSectionItemRef::Project { project_id } => {
            connection.execute(
                "DELETE FROM pinned_project_order WHERE project_id = ?1",
                [project_id],
            )?;
        }
        ProjectWorkspaceSidebarSectionItemRef::Session { session_id } => {
            connection.execute(
                "UPDATE project_sessions SET pinned = 0, pinned_order = NULL WHERE id = ?1",
                [session_id],
            )?;
            connection.execute(
                "DELETE FROM codex_pinned_threads WHERE thread_id IN ( \
                   SELECT thread_id FROM project_session_threads WHERE session_id = ?1)",
                [session_id],
            )?;
        }
    }
    Ok(())
}

fn validate_item(
    connection: &Connection,
    library_id: &str,
    item: &ProjectWorkspaceSidebarSectionItemRef,
) -> Result<(), StoreError> {
    let exists = match item {
        ProjectWorkspaceSidebarSectionItemRef::Project { project_id } => {
            validate_id("project_id", project_id)?;
            connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM projects WHERE id = ?1 AND library_id = ?2)",
                params![project_id, library_id],
                |row| row.get::<_, i64>(0),
            )?
        }
        ProjectWorkspaceSidebarSectionItemRef::Session { session_id } => {
            validate_id("session_id", session_id)?;
            connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM project_sessions session \
                   LEFT JOIN projects project ON project.id = session.project_id \
                   WHERE session.id = ?1 AND (session.project_id IS NULL OR project.library_id = ?2))",
                params![session_id, library_id],
                |row| row.get::<_, i64>(0),
            )?
        }
    };
    if exists == 1 {
        return Ok(());
    }
    Err(not_found("Sidebar Section item is unavailable"))
}

fn require_custom_section(
    connection: &Connection,
    library_id: &str,
    section_id: &str,
    require_active: bool,
) -> Result<i64, StoreError> {
    connection
        .query_row(
            "SELECT revision FROM workspace_sidebar_sections \
             WHERE section_id = ?1 AND library_id = ?2 AND kind = 'custom' \
               AND (?3 = 0 OR lifecycle = 'active')",
            params![section_id, library_id, i64::from(require_active)],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| not_found("Custom Sidebar Section is unavailable"))
}

fn normalize_name(value: &str, allow_default: bool) -> Result<String, StoreError> {
    let normalized = value.trim();
    let normalized = if normalized.is_empty() && allow_default {
        "New section"
    } else {
        normalized
    };
    if normalized.is_empty()
        || normalized.chars().count() > MAX_SECTION_NAME_CHARS
        || normalized.chars().any(char::is_control)
    {
        return Err(invalid("Sidebar Section name is invalid"));
    }
    Ok(normalized.to_owned())
}

fn require_revision_change(
    connection: &Connection,
    library_id: &str,
    section_id: &str,
    changed: usize,
) -> Result<(), StoreError> {
    if changed == 1 {
        return Ok(());
    }
    let exists = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM workspace_sidebar_sections \
         WHERE section_id = ?1 AND library_id = ?2 AND kind = 'custom')",
        params![section_id, library_id],
        |row| row.get::<_, i64>(0),
    )?;
    if exists == 0 {
        return Err(not_found("Custom Sidebar Section is unavailable"));
    }
    Err(StoreError::new(
        StoreErrorCode::RevisionConflict,
        "Sidebar Section revision changed",
        true,
    ))
}

fn section_member_ids(
    connection: &Connection,
    library_id: &str,
    section_id: &str,
) -> Result<(Vec<String>, Vec<String>), StoreError> {
    let rows = read_placement_rows(connection, library_id, section_id)?;
    Ok((
        rows.iter()
            .filter_map(|row| row.project_id.clone())
            .collect(),
        rows.iter()
            .filter_map(|row| row.session_id.clone())
            .collect(),
    ))
}

fn collect_item_ids(
    item: &ProjectWorkspaceSidebarSectionItemRef,
    project_ids: &mut Vec<String>,
    session_ids: &mut Vec<String>,
) {
    match item {
        ProjectWorkspaceSidebarSectionItemRef::Project { project_id } => {
            project_ids.push(project_id.clone());
        }
        ProjectWorkspaceSidebarSectionItemRef::Session { session_id } => {
            session_ids.push(session_id.clone());
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn finish_section_mutation(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    operation_kind: &'static str,
    project_ids: Vec<String>,
    session_ids: Vec<String>,
    committed_at: String,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    finish_mutation(
        connection,
        context,
        store_epoch,
        operation_id,
        request_hash,
        WorkspaceMutationEffects {
            operation_kind,
            project_catalog_change: None,
            change_project_id: workspace_event_anchor(connection, library_id)?,
            project_ids,
            session_ids: session_ids.clone(),
            thread_ids: Vec::new(),
            session_summary_scopes: vec![ProjectSessionInvalidationScope::All],
            session_detail_ids: session_ids,
            block_ids: Vec::new(),
            document_ids: Vec::new(),
            database_ids: Vec::new(),
            page_ids: Vec::new(),
            data_source_ids: Vec::new(),
            view_ids: Vec::new(),
            document_heads: Vec::new(),
            committed_at,
            queued_follow_up_ledger: None,
        },
    )
}

fn parse_section_kind(value: &str) -> Result<ProjectWorkspaceSidebarSectionKind, StoreError> {
    match value {
        "pinned" => Ok(ProjectWorkspaceSidebarSectionKind::Pinned),
        "pages" => Ok(ProjectWorkspaceSidebarSectionKind::Pages),
        "projects" => Ok(ProjectWorkspaceSidebarSectionKind::Projects),
        "chats" => Ok(ProjectWorkspaceSidebarSectionKind::Chats),
        "custom" => Ok(ProjectWorkspaceSidebarSectionKind::Custom),
        _ => Err(corrupt("Stored Sidebar Section kind is invalid")),
    }
}

fn parse_lifecycle(value: &str) -> Result<ProjectWorkspaceSidebarSectionLifecycle, StoreError> {
    match value {
        "active" => Ok(ProjectWorkspaceSidebarSectionLifecycle::Active),
        "deleted" => Ok(ProjectWorkspaceSidebarSectionLifecycle::Deleted),
        _ => Err(corrupt("Stored Sidebar Section lifecycle is invalid")),
    }
}

fn parse_project_lifecycle(value: &str) -> rusqlite::Result<ProjectLifecycle> {
    match value {
        "active" => Ok(ProjectLifecycle::Active),
        "inactive" => Ok(ProjectLifecycle::Inactive),
        "archived" => Ok(ProjectLifecycle::Archived),
        _ => Err(rusqlite::Error::InvalidQuery),
    }
}

fn parse_status_type(value: &str) -> rusqlite::Result<CodexThreadStatusType> {
    match value {
        "notLoaded" => Ok(CodexThreadStatusType::NotLoaded),
        "idle" => Ok(CodexThreadStatusType::Idle),
        "systemError" => Ok(CodexThreadStatusType::SystemError),
        "active" => Ok(CodexThreadStatusType::Active),
        _ => Err(rusqlite::Error::InvalidQuery),
    }
}

fn parse_sync_state(value: &str) -> rusqlite::Result<ProjectWorkspaceSidebarSectionHostSyncState> {
    match value {
        "pending" => Ok(ProjectWorkspaceSidebarSectionHostSyncState::Pending),
        "ready" => Ok(ProjectWorkspaceSidebarSectionHostSyncState::Ready),
        "delete_pending" => Ok(ProjectWorkspaceSidebarSectionHostSyncState::DeletePending),
        "conflict" => Ok(ProjectWorkspaceSidebarSectionHostSyncState::Conflict),
        "unsupported" => Ok(ProjectWorkspaceSidebarSectionHostSyncState::Unsupported),
        _ => Err(rusqlite::Error::InvalidQuery),
    }
}

fn sync_state_literal(value: ProjectWorkspaceSidebarSectionHostSyncState) -> &'static str {
    match value {
        ProjectWorkspaceSidebarSectionHostSyncState::Pending => "pending",
        ProjectWorkspaceSidebarSectionHostSyncState::Ready => "ready",
        ProjectWorkspaceSidebarSectionHostSyncState::DeletePending => "delete_pending",
        ProjectWorkspaceSidebarSectionHostSyncState::Conflict => "conflict",
        ProjectWorkspaceSidebarSectionHostSyncState::Unsupported => "unsupported",
    }
}

fn invalid(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message, false)
}

fn conflict(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::Conflict, message, false)
}

fn not_found(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::NotFound, message, false)
}

fn corrupt(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message, false)
}

#[cfg(test)]
mod tests {
    use nodex_core_contracts::collection::CollectionWindowRequest;
    use nodex_core_contracts::workspace::{
        ProjectWorkspaceIntent, ProjectWorkspaceRead, ProjectWorkspaceReadValue,
        ProjectWorkspaceSidebarSectionItemPlacement, ProjectWorkspaceSidebarSectionItemRef,
        ProjectWorkspaceSidebarSectionKind, ProjectWorkspaceSidebarSectionLifecycle,
    };

    use super::super::test_support::{apply, read, seeded_workspace};
    use crate::infrastructure::sqlite::with_immediate_transaction;

    fn window() -> CollectionWindowRequest {
        CollectionWindowRequest {
            after: None,
            first: Some(50),
        }
    }

    fn sections(
        module: &super::super::ProjectWorkspaceModule,
        include_deleted: bool,
    ) -> Vec<nodex_core_contracts::workspace::ProjectWorkspaceSidebarSectionSummary> {
        let ProjectWorkspaceReadValue::SidebarSectionWindow { sections } = read(
            module,
            ProjectWorkspaceRead::SidebarSectionWindow {
                include_deleted: Some(include_deleted),
                window: window(),
            },
        ) else {
            panic!("Sidebar Section window");
        };
        sections.items
    }

    #[test]
    fn built_in_section_identities_are_scoped_to_each_library() {
        let workspace = seeded_workspace();
        let sections = workspace
            .kernel
            .writer()
            .call(|connection| {
                with_immediate_transaction(connection, |transaction| {
                    transaction.execute(
                        "INSERT INTO profiles(id, created_at, updated_at) \
                         VALUES ('profile-2', ?1, ?1)",
                        [super::super::test_support::NOW],
                    )?;
                    transaction.execute(
                        "INSERT INTO libraries(id, profile_id, created_at, updated_at) \
                         VALUES ('library-2', 'profile-2', ?1, ?1)",
                        [super::super::test_support::NOW],
                    )?;
                    transaction
                        .prepare(
                            "SELECT library_id, section_id FROM workspace_sidebar_sections \
                             WHERE kind <> 'custom' ORDER BY library_id, rank_key",
                        )?
                        .query_map([], |row| {
                            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                        })?
                        .collect::<rusqlite::Result<Vec<_>>>()
                        .map_err(Into::into)
                })
            })
            .expect("seed a second Profile-scoped Section collection");

        let expected_ids = [
            "sidebar:pinned",
            "sidebar:pages",
            "sidebar:projects",
            "sidebar:chats",
        ];
        assert_eq!(sections.len(), expected_ids.len() * 2);
        for library_id in ["library-1", "library-2"] {
            assert_eq!(
                sections
                    .iter()
                    .filter(|(stored_library_id, _)| stored_library_id == library_id)
                    .map(|(_, section_id)| section_id.as_str())
                    .collect::<Vec<_>>(),
                expected_ids,
            );
        }
    }

    #[test]
    fn custom_sections_preserve_project_ownership_and_apply_session_overrides() {
        let workspace = seeded_workspace();
        apply(
            &workspace.module,
            "section-session",
            ProjectWorkspaceIntent::CreateSession {
                session_id: "session:section".to_owned(),
                project_id: Some("project:default".to_owned()),
                title: "Section task".to_owned(),
                initial_page_ids: Vec::new(),
            },
        );
        apply(
            &workspace.module,
            "section-alpha",
            ProjectWorkspaceIntent::CreateSidebarSection {
                section_id: "section:alpha".to_owned(),
                name: "Alpha".to_owned(),
                initial_item: Some(ProjectWorkspaceSidebarSectionItemRef::Project {
                    project_id: "project:default".to_owned(),
                }),
            },
        );
        apply(
            &workspace.module,
            "section-beta",
            ProjectWorkspaceIntent::CreateSidebarSection {
                section_id: "section:beta".to_owned(),
                name: "Beta".to_owned(),
                initial_item: None,
            },
        );

        let alpha = sections(&workspace.module, false)
            .into_iter()
            .find(|section| section.section_id == "section:alpha")
            .expect("Alpha Section");
        assert_eq!(alpha.direct_item_count, 1);
        assert_eq!(alpha.effective_session_count, 1);

        apply(
            &workspace.module,
            "section-override",
            ProjectWorkspaceIntent::MoveSidebarSectionItem {
                item: ProjectWorkspaceSidebarSectionItemRef::Session {
                    session_id: "session:section".to_owned(),
                },
                section_id: Some("section:beta".to_owned()),
                placement: ProjectWorkspaceSidebarSectionItemPlacement::End,
            },
        );

        let sections = sections(&workspace.module, false);
        let alpha = sections
            .iter()
            .find(|section| section.section_id == "section:alpha")
            .expect("Alpha Section");
        let beta = sections
            .iter()
            .find(|section| section.section_id == "section:beta")
            .expect("Beta Section");
        assert_eq!(alpha.effective_session_count, 0);
        assert_eq!(beta.effective_session_count, 1);
        let ProjectWorkspaceReadValue::Session { session } = read(
            &workspace.module,
            ProjectWorkspaceRead::Session {
                session_id: "session:section".to_owned(),
            },
        ) else {
            panic!("Session snapshot");
        };
        assert_eq!(session.project_id.as_deref(), Some("project:default"));
    }

    #[test]
    fn custom_placement_and_pinning_are_mutually_exclusive() {
        let workspace = seeded_workspace();
        apply(
            &workspace.module,
            "section-pin",
            ProjectWorkspaceIntent::CreateSidebarSection {
                section_id: "section:pin".to_owned(),
                name: "Pinning".to_owned(),
                initial_item: Some(ProjectWorkspaceSidebarSectionItemRef::Project {
                    project_id: "project:default".to_owned(),
                }),
            },
        );
        apply(
            &workspace.module,
            "pin-project",
            ProjectWorkspaceIntent::SetProjectPinned {
                project_id: "project:default".to_owned(),
                pinned: true,
            },
        );

        let ProjectWorkspaceReadValue::SidebarSectionItemWindow { items } = read(
            &workspace.module,
            ProjectWorkspaceRead::SidebarSectionItemWindow {
                section_id: "section:pin".to_owned(),
                include_archived: None,
                window: window(),
            },
        ) else {
            panic!("Sidebar Section items");
        };
        assert!(items.items.is_empty());
        let pinned = sections(&workspace.module, false)
            .into_iter()
            .find(|section| section.kind == ProjectWorkspaceSidebarSectionKind::Pinned)
            .expect("Pinned Section");
        assert_eq!(pinned.direct_item_count, 1);
    }

    #[test]
    fn deleted_sections_are_restorable_tombstones() {
        let workspace = seeded_workspace();
        apply(
            &workspace.module,
            "section-trash",
            ProjectWorkspaceIntent::CreateSidebarSection {
                section_id: "section:trash".to_owned(),
                name: "Trash".to_owned(),
                initial_item: None,
            },
        );
        apply(
            &workspace.module,
            "delete-section-trash",
            ProjectWorkspaceIntent::DeleteSidebarSection {
                section_id: "section:trash".to_owned(),
                expected_revision: 1,
            },
        );
        assert!(
            sections(&workspace.module, false)
                .iter()
                .all(|section| section.section_id != "section:trash")
        );
        let deleted = sections(&workspace.module, true)
            .into_iter()
            .find(|section| section.section_id == "section:trash")
            .expect("deleted Section");
        assert_eq!(
            deleted.lifecycle,
            ProjectWorkspaceSidebarSectionLifecycle::Deleted
        );
        assert_eq!(deleted.revision, 2);

        apply(
            &workspace.module,
            "restore-section-trash",
            ProjectWorkspaceIntent::RestoreSidebarSection {
                section_id: "section:trash".to_owned(),
                expected_revision: 2,
            },
        );
        let restored = sections(&workspace.module, false)
            .into_iter()
            .find(|section| section.section_id == "section:trash")
            .expect("restored Section");
        assert_eq!(
            restored.lifecycle,
            ProjectWorkspaceSidebarSectionLifecycle::Active
        );
        assert_eq!(restored.revision, 3);
    }

    #[test]
    fn archive_all_can_atomically_place_a_replacement_session() {
        let workspace = seeded_workspace();
        apply(
            &workspace.module,
            "section-archive",
            ProjectWorkspaceIntent::CreateSidebarSection {
                section_id: "section:archive".to_owned(),
                name: "Archive".to_owned(),
                initial_item: None,
            },
        );
        apply(
            &workspace.module,
            "section-original-session",
            ProjectWorkspaceIntent::CreateSessionInSidebarSection {
                session_id: "session:original".to_owned(),
                section_id: "section:archive".to_owned(),
                title: "Original".to_owned(),
                initial_page_ids: Vec::new(),
            },
        );

        apply(
            &workspace.module,
            "section-archive-all",
            ProjectWorkspaceIntent::ArchiveSidebarSectionSessions {
                section_id: "section:archive".to_owned(),
                replacement_session_id: Some("session:replacement".to_owned()),
            },
        );

        let ProjectWorkspaceReadValue::Session { session: original } = read(
            &workspace.module,
            ProjectWorkspaceRead::Session {
                session_id: "session:original".to_owned(),
            },
        ) else {
            panic!("original Session");
        };
        let ProjectWorkspaceReadValue::Session {
            session: replacement,
        } = read(
            &workspace.module,
            ProjectWorkspaceRead::Session {
                session_id: "session:replacement".to_owned(),
            },
        )
        else {
            panic!("replacement Session");
        };
        assert!(original.archived);
        assert!(!replacement.archived);
        assert_eq!(replacement.project_id, None);

        let ProjectWorkspaceReadValue::SidebarSectionItemWindow { items } = read(
            &workspace.module,
            ProjectWorkspaceRead::SidebarSectionItemWindow {
                section_id: "section:archive".to_owned(),
                include_archived: None,
                window: window(),
            },
        ) else {
            panic!("Sidebar Section items");
        };
        assert_eq!(items.items.len(), 1);
        let nodex_core_contracts::workspace::ProjectWorkspaceSidebarSectionItemValue::Session {
            session,
        } = &items.items[0].value
        else {
            panic!("replacement Session item");
        };
        assert_eq!(session.session_id, "session:replacement");
    }
}
