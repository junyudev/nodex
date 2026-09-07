use std::collections::BTreeSet;

use nodex_core_contracts::BoundModuleContext;
use nodex_core_contracts::workspace::{
    ProjectCatalogChangeKind, ProjectWorkspaceThreadMoveMetadataPatch,
    ProjectWorkspaceThreadMoveProjectAccessGrant, ProjectWorkspaceThreadPlacement,
};
use rusqlite::{Connection, OptionalExtension, params};

use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

use super::ProjectWorkspaceApplyOutcome;
use super::session_mutation::{sqlite_now, validate_id};
use super::thread::apply_thread_mutation;

const SIDEBAR_RANK_GAP: i64 = 1_000_000;
const MAX_PATH_BYTES: usize = 16 * 1024;

#[derive(Clone)]
struct ThreadOwner {
    project_id: Option<String>,
    session_id: String,
    session_project_id: Option<String>,
}

#[allow(clippy::too_many_arguments)]
pub(super) fn move_thread(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    thread_id: &str,
    source_project_id: Option<&str>,
    target_project_id: Option<&str>,
    placement: &ProjectWorkspaceThreadPlacement,
    metadata: &ProjectWorkspaceThreadMoveMetadataPatch,
    runtime_workspace_roots: Option<&[String]>,
    project_access_grant: Option<&ProjectWorkspaceThreadMoveProjectAccessGrant>,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    validate_id("thread_id", thread_id)?;
    if let Some(project_id) = source_project_id {
        validate_id("source_project_id", project_id)?;
    }
    if let Some(project_id) = target_project_id {
        validate_id("target_project_id", project_id)?;
        require_project(connection, library_id, project_id)?;
    }
    if let ProjectWorkspaceThreadPlacement::Before {
        thread_id: anchor_thread_id,
    }
    | ProjectWorkspaceThreadPlacement::After {
        thread_id: anchor_thread_id,
    } = placement
    {
        validate_id("placement.thread_id", anchor_thread_id)?;
        if anchor_thread_id == thread_id {
            return Err(invalid(
                "Thread placement anchor must reference another Thread",
            ));
        }
    }
    validate_move_metadata(metadata)?;
    if source_project_id == target_project_id && runtime_workspace_roots.is_some() {
        return Err(invalid(
            "Runtime workspace roots require a cross-Project Thread move",
        ));
    }

    let owner = require_thread_owner(connection, library_id, thread_id)?;
    if owner.project_id.as_deref() != source_project_id
        || owner.session_project_id.as_deref() != source_project_id
    {
        return Err(conflict(format!(
            "Thread {thread_id} is no longer in the expected Project"
        )));
    }

    let project_access = match (project_access_grant, source_project_id, target_project_id) {
        (None, _, _) => None,
        (Some(grant), Some(source_project_id), Some(target_project_id))
            if source_project_id != target_project_id =>
        {
            Some((source_project_id, target_project_id, grant))
        }
        (Some(_), _, _) => {
            return Err(invalid(
                "Project access grants require a cross-Project Thread move",
            ));
        }
    };

    let project_ids = [source_project_id, target_project_id]
        .into_iter()
        .flatten()
        .map(str::to_owned)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let mut session_summary_scopes =
        vec![super::mutation::project_session_scope(source_project_id)];
    let target_scope = super::mutation::project_session_scope(target_project_id);
    if !session_summary_scopes.contains(&target_scope) {
        session_summary_scopes.push(target_scope);
    }
    let session_ids = vec![owner.session_id.clone()];
    let thread_ids = vec![thread_id.to_owned()];
    apply_thread_mutation(
        connection,
        library_id,
        context,
        store_epoch,
        operation_id,
        request_hash,
        "move_thread",
        project_access.map(|_| ProjectCatalogChangeKind::SourcesUpdated),
        session_summary_scopes,
        project_ids,
        session_ids,
        thread_ids,
        || {
            if let Some((source_project_id, target_project_id, grant)) = project_access {
                super::mutation::grant_project_sources_for_thread_move(
                    connection,
                    library_id,
                    source_project_id,
                    target_project_id,
                    grant,
                )?;
            }
            if source_project_id != target_project_id {
                move_thread_membership(
                    connection,
                    thread_id,
                    source_project_id,
                    target_project_id,
                    &owner,
                    metadata,
                )?;
            }
            if let Some(roots) = runtime_workspace_roots {
                super::execution::replace_writable_roots_records(connection, thread_id, roots)?;
            }
            update_thread_lane_rank(
                connection,
                thread_id,
                &owner.session_id,
                target_project_id,
                placement,
            )
        },
    )
}

#[cfg(test)]
fn read_project_thread_order(
    connection: &Connection,
    project_id: &str,
) -> Result<Option<Vec<String>>, StoreError> {
    let lane_exists = connection
        .query_row(
            "SELECT 1 FROM workspace_sidebar_lanes
             WHERE scope_key = ?1
               AND lane_kind = 'project'
               AND project_id = ?2
               AND order_mode = 'manual'",
            params![project_lane_scope(project_id), project_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if !lane_exists {
        return Ok(None);
    }
    let rows = connection
        .prepare(
            "SELECT position.thread_id, thread.project_id,
                    pinned.thread_id IS NOT NULL
             FROM workspace_sidebar_positions position
             JOIN codex_threads thread ON thread.thread_id = position.thread_id
             LEFT JOIN codex_pinned_threads pinned ON pinned.thread_id = position.thread_id
             WHERE position.scope_key = ?1
             ORDER BY position.rank_key, position.thread_id",
        )?
        .query_map([project_lane_scope(project_id)], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut order = Vec::with_capacity(rows.len());
    for (thread_id, owner_project_id, pinned) in rows {
        if owner_project_id.as_deref() != Some(project_id) || pinned != 0 {
            return Err(corrupt(
                "Workspace Project lane contains a Thread outside its lane",
            ));
        }
        order.push(thread_id);
    }
    Ok(Some(order))
}

fn require_project(
    connection: &Connection,
    library_id: &str,
    project_id: &str,
) -> Result<(), StoreError> {
    let exists = connection
        .query_row(
            "SELECT 1 FROM projects \
             WHERE id = ?1 AND library_id = ?2 AND lifecycle = 'active'",
            params![project_id, library_id],
            |_| Ok(()),
        )
        .optional()?;
    exists.ok_or_else(|| not_found("Target Project is unavailable in this Library"))
}

fn project_lane_scope(project_id: &str) -> String {
    format!("project:{project_id}")
}

pub(super) fn replace_lane_with_session_order(
    connection: &Connection,
    project_id: Option<&str>,
    now: &str,
) -> Result<(), StoreError> {
    let (scope_key, lane_kind) = project_id.map_or_else(
        || ("projectless".to_owned(), "projectless"),
        |project_id| (project_lane_scope(project_id), "project"),
    );
    connection.execute(
        "INSERT INTO workspace_sidebar_lanes(
           scope_key, lane_kind, project_id, order_mode, revision, updated_at
         ) VALUES (?1, ?2, ?3, 'manual', 1, ?4)
         ON CONFLICT(scope_key) DO UPDATE SET
           order_mode = 'manual',
           revision = workspace_sidebar_lanes.revision + 1,
           updated_at = excluded.updated_at",
        params![scope_key, lane_kind, project_id, now],
    )?;
    connection.execute(
        "DELETE FROM workspace_sidebar_positions WHERE scope_key = ?1",
        [scope_key],
    )?;
    Ok(())
}

fn write_lane_order(
    connection: &Connection,
    scope_key: &str,
    lane_kind: &str,
    project_id: Option<&str>,
    order: &[String],
    now: &str,
) -> Result<(), StoreError> {
    connection.execute(
        "INSERT INTO workspace_sidebar_lanes(
           scope_key, lane_kind, project_id, order_mode, revision, updated_at
         ) VALUES (?1, ?2, ?3, 'manual', 1, ?4)
         ON CONFLICT(scope_key) DO UPDATE SET
           order_mode = 'manual',
           revision = workspace_sidebar_lanes.revision + 1,
           updated_at = excluded.updated_at",
        params![scope_key, lane_kind, project_id, now],
    )?;
    connection.execute(
        "DELETE FROM workspace_sidebar_positions WHERE scope_key = ?1",
        [scope_key],
    )?;
    let revision = connection.query_row(
        "SELECT revision FROM workspace_sidebar_lanes WHERE scope_key = ?1",
        [scope_key],
        |row| row.get::<_, i64>(0),
    )?;
    let mut insert = connection.prepare(
        "INSERT INTO workspace_sidebar_positions(
           scope_key, thread_id, rank_key, revision, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5)",
    )?;
    for (index, thread_id) in order.iter().enumerate() {
        let rank = i64::try_from(index + 1)
            .ok()
            .and_then(|value| value.checked_mul(SIDEBAR_RANK_GAP))
            .ok_or_else(|| invalid("Workspace Thread order rank overflowed"))?;
        insert.execute(params![scope_key, thread_id, rank, revision, now])?;
    }
    Ok(())
}

fn require_thread_owner(
    connection: &Connection,
    library_id: &str,
    thread_id: &str,
) -> Result<ThreadOwner, StoreError> {
    let row = connection
        .query_row(
            "SELECT thread.project_id, link.session_id, session.project_id,
               project.library_id
             FROM codex_threads thread
             LEFT JOIN project_session_threads link ON link.thread_id = thread.thread_id
             LEFT JOIN project_sessions session ON session.id = link.session_id
             LEFT JOIN projects project ON project.id = thread.project_id
             WHERE thread.thread_id = ?1",
            [thread_id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| not_found("Codex Thread is unavailable"))?;
    if row.0.is_some() && row.3.as_deref() != Some(library_id) {
        return Err(not_found("Codex Thread is unavailable in this Library"));
    }
    let session_id = row
        .1
        .ok_or_else(|| not_found("Codex Thread has no Project Session"))?;
    Ok(ThreadOwner {
        project_id: row.0,
        session_id,
        session_project_id: row.2,
    })
}

fn validate_move_metadata(
    metadata: &ProjectWorkspaceThreadMoveMetadataPatch,
) -> Result<(), StoreError> {
    if let Some(host_id) = metadata.execution_host_id.as_deref() {
        validate_id("execution_host_id", host_id)?;
    }
    for (name, value) in [
        ("cwd", &metadata.cwd),
        ("managed_worktree_path", &metadata.managed_worktree_path),
        (
            "projectless_output_directory",
            &metadata.projectless_output_directory,
        ),
        (
            "projectless_workspace_browser_root",
            &metadata.projectless_workspace_browser_root,
        ),
    ] {
        let Some(Some(value)) = value else {
            continue;
        };
        if value.len() > MAX_PATH_BYTES {
            return Err(invalid(format!("{name} exceeds its Core bound")));
        }
    }
    Ok(())
}

fn move_thread_membership(
    connection: &Connection,
    thread_id: &str,
    source_project_id: Option<&str>,
    target_project_id: Option<&str>,
    owner: &ThreadOwner,
    metadata: &ProjectWorkspaceThreadMoveMetadataPatch,
) -> Result<(), StoreError> {
    let now = sqlite_now(connection)?;
    connection.execute(
        "UPDATE project_sessions
         SET \"order\" = \"order\" + 1, updated_at = ?1
         WHERE project_id IS ?2",
        params![now, target_project_id],
    )?;
    let moved = connection.execute(
        "UPDATE project_sessions
         SET project_id = ?1, \"order\" = 0, updated_at = ?2
         WHERE id = ?3 AND project_id IS ?4",
        params![target_project_id, now, owner.session_id, source_project_id],
    )?;
    if moved != 1 {
        return Err(conflict("Project Session changed during Thread move"));
    }
    let updated = connection.execute(
        "UPDATE codex_threads SET
           project_id = ?1,
           execution_host_id = CASE WHEN ?2 = 1 THEN ?3 ELSE execution_host_id END,
           cwd = CASE WHEN ?4 = 1 THEN ?5 ELSE cwd END,
           managed_worktree_path = CASE WHEN ?6 = 1 THEN ?7 ELSE managed_worktree_path END,
           projectless_output_directory = CASE WHEN ?8 = 1 THEN ?9
             ELSE projectless_output_directory END,
           projectless_workspace_browser_root = CASE WHEN ?10 = 1 THEN ?11
             ELSE projectless_workspace_browser_root END
         WHERE thread_id = ?12 AND project_id IS ?13",
        params![
            target_project_id,
            i64::from(metadata.execution_host_id.is_some()),
            metadata.execution_host_id,
            i64::from(metadata.cwd.is_some()),
            metadata.cwd.as_ref().and_then(Clone::clone),
            i64::from(metadata.managed_worktree_path.is_some()),
            metadata
                .managed_worktree_path
                .as_ref()
                .and_then(Clone::clone),
            i64::from(metadata.projectless_output_directory.is_some()),
            metadata
                .projectless_output_directory
                .as_ref()
                .and_then(Clone::clone),
            i64::from(metadata.projectless_workspace_browser_root.is_some()),
            metadata
                .projectless_workspace_browser_root
                .as_ref()
                .and_then(Clone::clone),
            thread_id,
            source_project_id,
        ],
    )?;
    if updated != 1 {
        return Err(conflict("Codex Thread changed during Thread move"));
    }
    Ok(())
}

fn update_thread_lane_rank(
    connection: &Connection,
    moved_thread_id: &str,
    moved_session_id: &str,
    target_project_id: Option<&str>,
    placement: &ProjectWorkspaceThreadPlacement,
) -> Result<(), StoreError> {
    let now = sqlite_now(connection)?;
    let target_scope =
        target_project_id.map_or_else(|| "projectless".to_owned(), project_lane_scope);
    let removed_scopes = connection
        .prepare(
            "SELECT scope_key
             FROM workspace_sidebar_positions
             WHERE thread_id = ?1",
        )?
        .query_map([moved_thread_id], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    connection.execute(
        "DELETE FROM workspace_sidebar_positions WHERE thread_id = ?1",
        [moved_thread_id],
    )?;

    for scope_key in removed_scopes
        .iter()
        .filter(|scope_key| scope_key.as_str() != target_scope)
    {
        bump_lane_revision(connection, scope_key, &now)?;
    }

    if lane_uses_session_order(connection, &target_scope)? {
        return update_session_lane_order_for_thread_move(
            connection,
            moved_session_id,
            target_project_id,
            placement,
            &now,
        );
    }

    if matches!(placement, ProjectWorkspaceThreadPlacement::Default) {
        let mut changed_scopes = removed_scopes.into_iter().collect::<BTreeSet<_>>();
        if lane_is_manual(connection, &target_scope)? {
            changed_scopes.insert(target_scope);
        }
        for scope_key in changed_scopes {
            bump_lane_revision(connection, &scope_key, &now)?;
        }
        return Ok(());
    }

    if !lane_is_manual(connection, &target_scope)?
        || lane_has_unpositioned_threads(
            connection,
            target_project_id,
            &target_scope,
            moved_thread_id,
        )?
    {
        let current =
            list_lane_thread_ids_in_display_order(connection, target_project_id, &target_scope)?
                .into_iter()
                .filter(|thread_id| thread_id != moved_thread_id)
                .collect::<Vec<_>>();
        let next = apply_thread_placement(current, moved_thread_id, placement)?;
        write_lane_order(
            connection,
            &target_scope,
            if target_project_id.is_some() {
                "project"
            } else {
                "projectless"
            },
            target_project_id,
            &next,
            &now,
        )?;
        return Ok(());
    }

    let rank = rank_for_placement(connection, &target_scope, placement)?;
    let revision = bump_lane_revision(connection, &target_scope, &now)?;
    connection.execute(
        "INSERT INTO workspace_sidebar_positions(
           scope_key, thread_id, rank_key, revision, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![target_scope, moved_thread_id, rank, revision, now],
    )?;
    Ok(())
}

fn lane_uses_session_order(connection: &Connection, scope_key: &str) -> Result<bool, StoreError> {
    Ok(connection.query_row(
        "SELECT EXISTS(
           SELECT 1 FROM workspace_sidebar_lanes lane
           WHERE lane.scope_key = ?1
             AND lane.order_mode = 'manual'
             AND NOT EXISTS (
               SELECT 1 FROM workspace_sidebar_positions position
               WHERE position.scope_key = lane.scope_key
             )
         )",
        [scope_key],
        |row| row.get::<_, i64>(0),
    )? != 0)
}

fn update_session_lane_order_for_thread_move(
    connection: &Connection,
    moved_session_id: &str,
    target_project_id: Option<&str>,
    placement: &ProjectWorkspaceThreadPlacement,
    now: &str,
) -> Result<(), StoreError> {
    if matches!(placement, ProjectWorkspaceThreadPlacement::Default) {
        return replace_lane_with_session_order(connection, target_project_id, now);
    }

    let mut current = connection
        .prepare(
            "SELECT id FROM project_sessions
             WHERE project_id IS ?1 AND archived = 0
             ORDER BY \"order\", created_at, id",
        )?
        .query_map([target_project_id], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    current.retain(|session_id| session_id != moved_session_id);
    let anchor_session_id = match placement {
        ProjectWorkspaceThreadPlacement::Before { thread_id }
        | ProjectWorkspaceThreadPlacement::After { thread_id } => Some(
            connection
                .query_row(
                    "SELECT link.session_id
                     FROM project_session_threads link
                     JOIN project_sessions session ON session.id = link.session_id
                     WHERE link.thread_id = ?1 AND session.project_id IS ?2",
                    params![thread_id, target_project_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
                .ok_or_else(|| conflict("Thread placement anchor is no longer in its lane"))?,
        ),
        ProjectWorkspaceThreadPlacement::Start
        | ProjectWorkspaceThreadPlacement::End
        | ProjectWorkspaceThreadPlacement::Default => None,
    };
    let insertion_index = match placement {
        ProjectWorkspaceThreadPlacement::Start => 0,
        ProjectWorkspaceThreadPlacement::End => current.len(),
        ProjectWorkspaceThreadPlacement::Before { .. } => current
            .iter()
            .position(|session_id| Some(session_id) == anchor_session_id.as_ref())
            .ok_or_else(|| conflict("Thread placement anchor is no longer in its lane"))?,
        ProjectWorkspaceThreadPlacement::After { .. } => current
            .iter()
            .position(|session_id| Some(session_id) == anchor_session_id.as_ref())
            .map(|index| index + 1)
            .ok_or_else(|| conflict("Thread placement anchor is no longer in its lane"))?,
        ProjectWorkspaceThreadPlacement::Default => unreachable!("handled above"),
    };
    current.insert(insertion_index, moved_session_id.to_owned());
    for (order, session_id) in current.iter().enumerate() {
        let order =
            i64::try_from(order).map_err(|_| invalid("Project Session order exceeds its bound"))?;
        connection.execute(
            "UPDATE project_sessions SET \"order\" = ?1, updated_at = ?2 WHERE id = ?3",
            params![order, now, session_id],
        )?;
    }
    replace_lane_with_session_order(connection, target_project_id, now)
}

fn lane_is_manual(connection: &Connection, scope_key: &str) -> Result<bool, StoreError> {
    Ok(connection
        .query_row(
            "SELECT 1 FROM workspace_sidebar_lanes
             WHERE scope_key = ?1 AND order_mode = 'manual'",
            [scope_key],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

fn lane_has_unpositioned_threads(
    connection: &Connection,
    project_id: Option<&str>,
    scope_key: &str,
    moved_thread_id: &str,
) -> Result<bool, StoreError> {
    let exists = connection.query_row(
        "SELECT EXISTS(
           SELECT 1
           FROM project_sessions session
           JOIN project_session_threads link ON link.session_id = session.id
           JOIN codex_threads thread ON thread.thread_id = link.thread_id
           WHERE session.project_id IS ?1
             AND thread.thread_id <> ?2
             AND NOT EXISTS (
               SELECT 1 FROM workspace_sidebar_positions position
               WHERE position.scope_key = ?3
                 AND position.thread_id = thread.thread_id
             )
         )",
        params![project_id, moved_thread_id, scope_key],
        |row| row.get::<_, i64>(0),
    )?;
    Ok(exists != 0)
}

fn list_lane_thread_ids_in_display_order(
    connection: &Connection,
    project_id: Option<&str>,
    scope_key: &str,
) -> Result<Vec<String>, StoreError> {
    connection
        .prepare(
            "SELECT thread.thread_id
             FROM project_sessions session
             JOIN project_session_threads link ON link.session_id = session.id
             JOIN codex_threads thread ON thread.thread_id = link.thread_id
             LEFT JOIN workspace_sidebar_positions position
               ON position.scope_key = ?2
               AND position.thread_id = thread.thread_id
             WHERE session.project_id IS ?1
             ORDER BY COALESCE(
               position.rank_key,
               -COALESCE(thread.recency_at, session.\"order\")
             ), session.id",
        )?
        .query_map(params![project_id, scope_key], |row| {
            row.get::<_, String>(0)
        })?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(StoreError::from)
}

fn apply_thread_placement(
    mut current: Vec<String>,
    moved_thread_id: &str,
    placement: &ProjectWorkspaceThreadPlacement,
) -> Result<Vec<String>, StoreError> {
    match placement {
        ProjectWorkspaceThreadPlacement::Start => {
            current.insert(0, moved_thread_id.to_owned());
        }
        ProjectWorkspaceThreadPlacement::End => {
            current.push(moved_thread_id.to_owned());
        }
        ProjectWorkspaceThreadPlacement::Before { thread_id } => {
            let index = current
                .iter()
                .position(|candidate| candidate == thread_id)
                .ok_or_else(|| conflict("Thread placement anchor is no longer in its lane"))?;
            current.insert(index, moved_thread_id.to_owned());
        }
        ProjectWorkspaceThreadPlacement::After { thread_id } => {
            let index = current
                .iter()
                .position(|candidate| candidate == thread_id)
                .ok_or_else(|| conflict("Thread placement anchor is no longer in its lane"))?;
            current.insert(index + 1, moved_thread_id.to_owned());
        }
        ProjectWorkspaceThreadPlacement::Default => {
            return Err(invalid("Default placement does not define a manual rank"));
        }
    }
    Ok(current)
}

fn rank_for_placement(
    connection: &Connection,
    scope_key: &str,
    placement: &ProjectWorkspaceThreadPlacement,
) -> Result<i64, StoreError> {
    let rank = match placement {
        ProjectWorkspaceThreadPlacement::Start => {
            let first = connection.query_row(
                "SELECT min(rank_key) FROM workspace_sidebar_positions WHERE scope_key = ?1",
                [scope_key],
                |row| row.get::<_, Option<i64>>(0),
            )?;
            first
                .unwrap_or(SIDEBAR_RANK_GAP)
                .checked_sub(SIDEBAR_RANK_GAP)
        }
        ProjectWorkspaceThreadPlacement::End => {
            let last = connection.query_row(
                "SELECT max(rank_key) FROM workspace_sidebar_positions WHERE scope_key = ?1",
                [scope_key],
                |row| row.get::<_, Option<i64>>(0),
            )?;
            last.unwrap_or(0).checked_add(SIDEBAR_RANK_GAP)
        }
        ProjectWorkspaceThreadPlacement::Before { thread_id } => {
            let anchor = connection
                .query_row(
                    "SELECT rank_key FROM workspace_sidebar_positions
                     WHERE scope_key = ?1 AND thread_id = ?2",
                    params![scope_key, thread_id],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?
                .ok_or_else(|| conflict("Thread placement anchor is no longer in its lane"))?;
            let previous = connection.query_row(
                "SELECT max(rank_key) FROM workspace_sidebar_positions
                 WHERE scope_key = ?1 AND rank_key < ?2",
                params![scope_key, anchor],
                |row| row.get::<_, Option<i64>>(0),
            )?;
            match previous {
                Some(previous) if anchor - previous > 1 => {
                    Some(previous + ((anchor - previous) / 2))
                }
                Some(_) => None,
                None => anchor.checked_sub(SIDEBAR_RANK_GAP),
            }
        }
        ProjectWorkspaceThreadPlacement::After { thread_id } => {
            let anchor = connection
                .query_row(
                    "SELECT rank_key FROM workspace_sidebar_positions
                     WHERE scope_key = ?1 AND thread_id = ?2",
                    params![scope_key, thread_id],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?
                .ok_or_else(|| conflict("Thread placement anchor is no longer in its lane"))?;
            let next = connection.query_row(
                "SELECT min(rank_key) FROM workspace_sidebar_positions
                 WHERE scope_key = ?1 AND rank_key > ?2",
                params![scope_key, anchor],
                |row| row.get::<_, Option<i64>>(0),
            )?;
            match next {
                Some(next) if next - anchor > 1 => Some(anchor + ((next - anchor) / 2)),
                Some(_) => None,
                None => anchor.checked_add(SIDEBAR_RANK_GAP),
            }
        }
        ProjectWorkspaceThreadPlacement::Default => None,
    };
    if let Some(rank) = rank.filter(|rank| *rank >= 0) {
        return Ok(rank);
    }

    rebalance_lane(connection, scope_key)?;
    let retry = match placement {
        ProjectWorkspaceThreadPlacement::Start => 0,
        ProjectWorkspaceThreadPlacement::End => connection.query_row(
            "SELECT COALESCE(max(rank_key), 0) + ?2
             FROM workspace_sidebar_positions WHERE scope_key = ?1",
            params![scope_key, SIDEBAR_RANK_GAP],
            |row| row.get::<_, i64>(0),
        )?,
        ProjectWorkspaceThreadPlacement::Before { thread_id } => {
            let (anchor, previous) = connection.query_row(
                "SELECT anchor.rank_key, max(previous.rank_key)
                 FROM workspace_sidebar_positions anchor
                 LEFT JOIN workspace_sidebar_positions previous
                   ON previous.scope_key = anchor.scope_key
                  AND previous.rank_key < anchor.rank_key
                 WHERE anchor.scope_key = ?1 AND anchor.thread_id = ?2
                 GROUP BY anchor.rank_key",
                params![scope_key, thread_id],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Option<i64>>(1)?)),
            )?;
            previous.map_or(0, |previous| previous + ((anchor - previous) / 2))
        }
        ProjectWorkspaceThreadPlacement::After { thread_id } => {
            let (anchor, next) = connection.query_row(
                "SELECT anchor.rank_key, min(next.rank_key)
                 FROM workspace_sidebar_positions anchor
                 LEFT JOIN workspace_sidebar_positions next
                   ON next.scope_key = anchor.scope_key
                  AND next.rank_key > anchor.rank_key
                 WHERE anchor.scope_key = ?1 AND anchor.thread_id = ?2
                 GROUP BY anchor.rank_key",
                params![scope_key, thread_id],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Option<i64>>(1)?)),
            )?;
            match next {
                Some(next) => anchor + ((next - anchor) / 2),
                None => anchor
                    .checked_add(SIDEBAR_RANK_GAP)
                    .ok_or_else(|| invalid("Workspace Thread order rank overflowed"))?,
            }
        }
        ProjectWorkspaceThreadPlacement::Default => {
            return Err(invalid("Default placement does not define a manual rank"));
        }
    };
    Ok(retry)
}

fn rebalance_lane(connection: &Connection, scope_key: &str) -> Result<(), StoreError> {
    let positions = connection
        .prepare(
            "SELECT thread_id, revision, updated_at FROM workspace_sidebar_positions
             WHERE scope_key = ?1 ORDER BY rank_key, thread_id",
        )?
        .query_map([scope_key], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    connection.execute(
        "DELETE FROM workspace_sidebar_positions WHERE scope_key = ?1",
        [scope_key],
    )?;
    let mut insert = connection.prepare(
        "INSERT INTO workspace_sidebar_positions(
           scope_key, thread_id, rank_key, revision, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5)",
    )?;
    for (index, (thread_id, revision, updated_at)) in positions.iter().enumerate() {
        let rank = i64::try_from(index + 1)
            .ok()
            .and_then(|value| value.checked_mul(SIDEBAR_RANK_GAP))
            .ok_or_else(|| invalid("Workspace Thread order rank overflowed"))?;
        insert.execute(params![scope_key, thread_id, rank, revision, updated_at])?;
    }
    Ok(())
}

fn bump_lane_revision(
    connection: &Connection,
    scope_key: &str,
    now: &str,
) -> Result<i64, StoreError> {
    let updated = connection.execute(
        "UPDATE workspace_sidebar_lanes
         SET revision = revision + 1, updated_at = ?2
         WHERE scope_key = ?1 AND order_mode = 'manual'",
        params![scope_key, now],
    )?;
    if updated == 0 {
        return Err(conflict("Workspace sidebar lane is no longer manual"));
    }
    connection
        .query_row(
            "SELECT revision FROM workspace_sidebar_lanes WHERE scope_key = ?1",
            [scope_key],
            |row| row.get::<_, i64>(0),
        )
        .map_err(StoreError::from)
}

fn invalid(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message, false)
}

fn not_found(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::NotFound, message, false)
}

fn conflict(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::RevisionConflict, message, true)
}

#[cfg(test)]
fn corrupt(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message, false)
}

#[cfg(test)]
mod tests {
    use nodex_core_contracts::workspace::{
        ProjectWorkspaceIntent, ProjectWorkspaceThreadLane,
        ProjectWorkspaceThreadMoveMetadataPatch, ProjectWorkspaceThreadMoveProjectAccessGrant,
        ProjectWorkspaceThreadPlacement,
    };

    use super::super::test_support::{
        apply, context, create_project, create_session_thread, request, seeded_workspace,
    };

    #[test]
    fn rejects_self_anchored_thread_placements_before_mutating_the_lane() {
        let workspace = seeded_workspace();
        create_session_thread(
            &workspace.module,
            "self-anchor-thread",
            "session:self-anchor",
            "thread:self-anchor",
            Some("project:default"),
            100,
        );

        for (operation_id, placement) in [
            (
                "move-before-self",
                ProjectWorkspaceThreadPlacement::Before {
                    thread_id: "thread:self-anchor".to_owned(),
                },
            ),
            (
                "move-after-self",
                ProjectWorkspaceThreadPlacement::After {
                    thread_id: "thread:self-anchor".to_owned(),
                },
            ),
        ] {
            let error = workspace
                .module
                .apply(
                    &context(),
                    request(
                        operation_id,
                        ProjectWorkspaceIntent::MoveThread {
                            thread_id: "thread:self-anchor".to_owned(),
                            source: ProjectWorkspaceThreadLane::Project {
                                project_id: "project:default".to_owned(),
                            },
                            target: ProjectWorkspaceThreadLane::Project {
                                project_id: "project:default".to_owned(),
                            },
                            placement,
                            metadata: ProjectWorkspaceThreadMoveMetadataPatch::default(),
                            runtime_workspace_roots: None,
                            project_access_grant: None,
                        },
                    ),
                )
                .expect_err("self anchor must be rejected");
            assert_eq!(
                error.code,
                nodex_core_contracts::CoreErrorCode::InvalidInput
            );
        }

        let order = workspace
            .kernel
            .writer()
            .call(|connection| super::read_project_thread_order(connection, "project:default"))
            .expect("unchanged lane state");
        assert_eq!(order, None);
    }

    #[test]
    fn moving_inside_a_materialized_lane_only_rewrites_the_moved_rank() {
        let workspace = seeded_workspace();
        for (index, thread_id) in ["thread:a", "thread:b", "thread:c"].iter().enumerate() {
            create_session_thread(
                &workspace.module,
                &format!("rank-{index}"),
                &format!("session:{index}"),
                thread_id,
                Some("project:default"),
                300 - i64::try_from(index).expect("small index"),
            );
        }
        apply(
            &workspace.module,
            "materialize-ranks",
            ProjectWorkspaceIntent::MoveThread {
                thread_id: "thread:a".to_owned(),
                source: ProjectWorkspaceThreadLane::Project {
                    project_id: "project:default".to_owned(),
                },
                target: ProjectWorkspaceThreadLane::Project {
                    project_id: "project:default".to_owned(),
                },
                placement: ProjectWorkspaceThreadPlacement::Before {
                    thread_id: "thread:c".to_owned(),
                },
                metadata: ProjectWorkspaceThreadMoveMetadataPatch::default(),
                runtime_workspace_roots: None,
                project_access_grant: None,
            },
        );
        let before = workspace
            .kernel
            .writer()
            .call(|connection| {
                connection
                    .prepare(
                        "SELECT thread_id, rank_key, revision
                         FROM workspace_sidebar_positions
                         WHERE scope_key = 'project:project:default'
                         ORDER BY thread_id",
                    )?
                    .query_map([], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, i64>(1)?,
                            row.get::<_, i64>(2)?,
                        ))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()
                    .map_err(crate::infrastructure::sqlite::StoreError::from)
            })
            .expect("initial ranks");

        apply(
            &workspace.module,
            "move-one-rank",
            ProjectWorkspaceIntent::MoveThread {
                thread_id: "thread:c".to_owned(),
                source: ProjectWorkspaceThreadLane::Project {
                    project_id: "project:default".to_owned(),
                },
                target: ProjectWorkspaceThreadLane::Project {
                    project_id: "project:default".to_owned(),
                },
                placement: ProjectWorkspaceThreadPlacement::Before {
                    thread_id: "thread:a".to_owned(),
                },
                metadata: ProjectWorkspaceThreadMoveMetadataPatch::default(),
                runtime_workspace_roots: None,
                project_access_grant: None,
            },
        );

        let (after, order) = workspace
            .kernel
            .writer()
            .call(|connection| {
                let positions = connection
                    .prepare(
                        "SELECT thread_id, rank_key, revision
                         FROM workspace_sidebar_positions
                         WHERE scope_key = 'project:project:default'
                         ORDER BY thread_id",
                    )?
                    .query_map([], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, i64>(1)?,
                            row.get::<_, i64>(2)?,
                        ))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok((
                    positions,
                    super::read_project_thread_order(connection, "project:default")?,
                ))
            })
            .expect("updated ranks");
        assert_eq!(
            order,
            Some(vec![
                "thread:b".to_owned(),
                "thread:c".to_owned(),
                "thread:a".to_owned(),
            ])
        );
        assert_eq!(after[0], before[0], "thread:a rank must remain stable");
        assert_eq!(after[1], before[1], "thread:b rank must remain stable");
        assert_ne!(after[2], before[2], "only the moved rank is rewritten");
    }

    #[test]
    fn confirmed_move_owns_authority_roots_and_membership_in_one_journaled_commit() {
        let workspace = seeded_workspace();
        create_project(&workspace.module, "create-source-project", "project:source");
        create_project(&workspace.module, "create-target-project", "project:target");
        create_session_thread(
            &workspace.module,
            "grant-and-move",
            "session:grant-and-move",
            "thread:grant-and-move",
            Some("project:source"),
            100,
        );
        workspace
            .kernel
            .writer()
            .call(|connection| {
                connection.execute_batch(
                    "CREATE TRIGGER test_thread_project_move_requires_visibility_journal
                     BEFORE UPDATE OF project_id ON codex_threads
                     WHEN OLD.project_id IS NOT NEW.project_id
                     BEGIN
                       SELECT CASE WHEN NOT EXISTS (
                         SELECT 1 FROM local_commit_visibility_context
                         WHERE id = 1 AND mode = 'active'
                       ) THEN RAISE(ABORT, 'test move requires active visibility journal') END;
                     END;
                     DELETE FROM local_commit_visibility_context WHERE mode = 'maintenance';",
                )?;
                Ok(())
            })
            .expect("production visibility guard");

        apply(
            &workspace.module,
            "grant-project-access-and-move-thread",
            ProjectWorkspaceIntent::MoveThread {
                thread_id: "thread:grant-and-move".to_owned(),
                source: ProjectWorkspaceThreadLane::Project {
                    project_id: "project:source".to_owned(),
                },
                target: ProjectWorkspaceThreadLane::Project {
                    project_id: "project:target".to_owned(),
                },
                placement: ProjectWorkspaceThreadPlacement::Default,
                metadata: ProjectWorkspaceThreadMoveMetadataPatch::default(),
                runtime_workspace_roots: Some(vec![
                    "/workspace/project:target".to_owned(),
                    "/workspace/project:source".to_owned(),
                ]),
                project_access_grant: Some(ProjectWorkspaceThreadMoveProjectAccessGrant {
                    expected_target_binding_revision: 1,
                    missing_source_roots: vec!["/workspace/project:source".to_owned()],
                }),
            },
        );

        let (thread_project_id, target_revision, target_roots, writable_roots, open_journals) =
            workspace
                .kernel
                .writer()
                .call(|connection| {
                    let thread_project_id = connection.query_row(
                        "SELECT project_id FROM codex_threads WHERE thread_id = ?1",
                        ["thread:grant-and-move"],
                        |row| row.get::<_, String>(0),
                    )?;
                    let target_revision = connection.query_row(
                        "SELECT binding_revision FROM projects WHERE id = ?1",
                        ["project:target"],
                        |row| row.get::<_, i64>(0),
                    )?;
                    let target_roots = connection
                    .prepare(
                        "SELECT root FROM project_sources WHERE project_id = ?1 ORDER BY \"order\"",
                    )?
                    .query_map(["project:target"], |row| row.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                    let writable_roots = connection
                        .prepare(
                            "SELECT root FROM codex_thread_writable_roots
                         WHERE thread_id = ?1 ORDER BY root_order",
                        )?
                        .query_map(["thread:grant-and-move"], |row| row.get::<_, String>(0))?
                        .collect::<rusqlite::Result<Vec<_>>>()?;
                    let open_journals = connection.query_row(
                        "SELECT count(*) FROM local_commit_visibility_context",
                        [],
                        |row| row.get::<_, i64>(0),
                    )?;
                    Ok((
                        thread_project_id,
                        target_revision,
                        target_roots,
                        writable_roots,
                        open_journals,
                    ))
                })
                .expect("confirmed Project access move");
        assert_eq!(thread_project_id, "project:target");
        assert_eq!(target_revision, 2);
        assert_eq!(
            target_roots,
            [
                "/workspace/project:target".to_owned(),
                "/workspace/project:source".to_owned(),
            ],
        );
        assert_eq!(
            writable_roots,
            [
                "/workspace/project:target".to_owned(),
                "/workspace/project:source".to_owned(),
            ],
        );
        assert_eq!(open_journals, 0);
    }

    #[test]
    fn stale_project_access_confirmation_rolls_back_roots_and_membership() {
        let workspace = seeded_workspace();
        create_project(
            &workspace.module,
            "create-stale-source-project",
            "project:source",
        );
        create_project(
            &workspace.module,
            "create-stale-target-project",
            "project:target",
        );
        create_session_thread(
            &workspace.module,
            "stale-grant-and-move",
            "session:stale-grant-and-move",
            "thread:stale-grant-and-move",
            Some("project:source"),
            100,
        );

        let error = workspace
            .module
            .apply(
                &context(),
                request(
                    "stale-project-access-and-move-thread",
                    ProjectWorkspaceIntent::MoveThread {
                        thread_id: "thread:stale-grant-and-move".to_owned(),
                        source: ProjectWorkspaceThreadLane::Project {
                            project_id: "project:source".to_owned(),
                        },
                        target: ProjectWorkspaceThreadLane::Project {
                            project_id: "project:target".to_owned(),
                        },
                        placement: ProjectWorkspaceThreadPlacement::Default,
                        metadata: ProjectWorkspaceThreadMoveMetadataPatch::default(),
                        runtime_workspace_roots: None,
                        project_access_grant: Some(ProjectWorkspaceThreadMoveProjectAccessGrant {
                            expected_target_binding_revision: 99,
                            missing_source_roots: vec!["/workspace/project:source".to_owned()],
                        }),
                    },
                ),
            )
            .expect_err("stale confirmation must fail");
        assert_eq!(
            error.code,
            nodex_core_contracts::CoreErrorCode::RevisionConflict
        );

        let (thread_project_id, target_roots) = workspace
            .kernel
            .writer()
            .call(|connection| {
                let thread_project_id = connection.query_row(
                    "SELECT project_id FROM codex_threads WHERE thread_id = ?1",
                    ["thread:stale-grant-and-move"],
                    |row| row.get::<_, String>(0),
                )?;
                let target_roots = connection
                    .prepare(
                        "SELECT root FROM project_sources WHERE project_id = ?1 ORDER BY \"order\"",
                    )?
                    .query_map(["project:target"], |row| row.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok((thread_project_id, target_roots))
            })
            .expect("unchanged stale move state");
        assert_eq!(thread_project_id, "project:source");
        assert_eq!(target_roots, ["/workspace/project:target".to_owned()]);
    }
}
