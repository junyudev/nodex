use std::collections::HashSet;

use nodex_core_contracts::workspace::{
    ProjectSessionInvalidationScope, ProjectWorkspaceSessionActivityEntry,
    ProjectWorkspaceSessionPlacement,
};

use nodex_core_contracts::BoundModuleContext;
use rusqlite::{Connection, OptionalExtension, params};

use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

use super::ProjectWorkspaceApplyOutcome;
use super::mutation::{WorkspaceMutationEffects, finish_no_op, project_session_scope};
use super::session_mutation::{
    SessionInvalidationKind, finish_session_mutation, require_session, sqlite_now, validate_id,
};

const MAX_SESSION_TITLE_BYTES: usize = 8_000;
const MAX_SESSION_TITLE_UTF16: usize = 2_000;
const MAX_SESSIONS_PER_LANE: usize = 100_000;

#[allow(clippy::too_many_arguments)]
pub(super) fn create_session(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    session_id: &str,
    project_id: Option<&str>,
    title: &str,
    initial_page_ids: &[String],
    sidebar_section_id: Option<&str>,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    let now = prepare_session(
        connection,
        library_id,
        session_id,
        project_id,
        title,
        initial_page_ids,
        sidebar_section_id,
    )?;
    finish_lifecycle_mutation(
        connection,
        library_id,
        context,
        store_epoch,
        operation_id,
        request_hash,
        "create_session",
        project_id.into_iter().map(str::to_owned).collect(),
        vec![session_id.to_owned()],
        Vec::new(),
        vec![project_session_scope(project_id)],
        project_id,
        initial_page_ids,
        now,
    )
}

pub(super) fn prepare_session(
    connection: &Connection,
    library_id: &str,
    session_id: &str,
    project_id: Option<&str>,
    title: &str,
    initial_page_ids: &[String],
    sidebar_section_id: Option<&str>,
) -> Result<String, StoreError> {
    validate_id("session_id", session_id)?;
    if let Some(project_id) = project_id {
        validate_id("project_id", project_id)?;
        require_project(connection, library_id, project_id, true)?;
    }
    super::page_chat::validate_initial_page_ids(connection, library_id, initial_page_ids)?;
    let title = normalize_session_title(title)?;
    let now = insert_session_records(connection, session_id, project_id, &title, false)?;
    super::page_chat::insert_initial_page_links(connection, session_id, initial_page_ids, &now)?;
    if let Some(section_id) = sidebar_section_id {
        super::sidebar_section::place_created_session(
            connection, library_id, section_id, session_id, &now,
        )?;
    }
    Ok(now)
}

/// Every replacement draft Core creates reads the same as a draft the user opens.
pub(super) const NEW_CHAT_TITLE: &str = "New chat";

#[allow(clippy::too_many_arguments)]
pub(super) fn ensure_default_draft_session(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    session_id: &str,
    project_id: Option<&str>,
    title: &str,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    validate_id("session_id", session_id)?;
    if let Some(project_id) = project_id {
        validate_id("project_id", project_id)?;
        require_project(connection, library_id, project_id, true)?;
    }
    let title = normalize_session_title(title)?;
    // Each Member opens a draft of their own: another Member's unstarted chat is never theirs.
    let member = super::chat_stewardship::acting_member(connection, library_id, context)?;
    let existing_session_id = connection
        .query_row(
            &format!(
                "SELECT session.id FROM project_sessions session \
                 WHERE session.project_id IS ?1 AND session.is_default_draft = 1 AND {} IS ?2",
                super::chat_stewardship::opener_sql("session.id")
            ),
            params![project_id, member],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    let project_ids = project_id.into_iter().map(str::to_owned).collect();
    if let Some(existing_session_id) = existing_session_id {
        let now = sqlite_now(connection)?;
        return finish_no_op(
            connection,
            context,
            store_epoch,
            operation_id,
            request_hash,
            "ensure_default_draft_session",
            project_ids,
            vec![existing_session_id],
            &now,
        );
    }
    let now = insert_session_records(connection, session_id, project_id, &title, true)?;
    super::chat_stewardship::record_owner(connection, session_id, &member, &now)?;
    finish_lifecycle_mutation(
        connection,
        library_id,
        context,
        store_epoch,
        operation_id,
        request_hash,
        "ensure_default_draft_session",
        project_ids,
        vec![session_id.to_owned()],
        Vec::new(),
        vec![project_session_scope(project_id)],
        project_id,
        &[],
        now,
    )
}

pub(super) fn insert_session_records(
    connection: &Connection,
    session_id: &str,
    project_id: Option<&str>,
    title: &str,
    is_default_draft: bool,
) -> Result<String, StoreError> {
    if connection
        .query_row(
            "SELECT 1 FROM project_sessions WHERE id = ?1",
            [session_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some()
    {
        return Err(StoreError::new(
            StoreErrorCode::Conflict,
            "Project Session identity already exists",
            false,
        ));
    }
    let count = connection.query_row(
        "SELECT count(*) FROM project_sessions WHERE project_id IS ?1",
        [project_id],
        |row| row.get::<_, i64>(0),
    )?;
    if usize::try_from(count)
        .ok()
        .is_none_or(|count| count >= MAX_SESSIONS_PER_LANE)
    {
        return Err(invalid("Project has too many Sessions"));
    }
    let now = sqlite_now(connection)?;
    connection.execute(
        "INSERT INTO project_sessions(\
           id, project_id, no_thread_fallback_title, activity_at, \
           archived, archived_at, is_default_draft, \
           created_at, updated_at\
         ) VALUES (?1, ?2, ?3, CAST(round(unixepoch(?5, 'subsec') * 1000) AS INTEGER), 0, NULL, ?4, ?5, ?5)",
        params![
            session_id,
            project_id,
            title,
            i64::from(is_default_draft),
            now
        ],
    )?;
    Ok(now)
}

#[allow(clippy::too_many_arguments)]
pub(super) fn delete_session(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    session_id: &str,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    validate_id("session_id", session_id)?;
    // A Member deletes only a side chat of their own.
    if context.adapter == nodex_core_contracts::AdapterKind::RemoteMember {
        let principal = context.principal.as_ref().ok_or_else(|| {
            StoreError::new(
                StoreErrorCode::Unauthorized,
                "A verified Member is required",
                false,
            )
        })?;
        super::host_chat::authorize(
            connection,
            library_id,
            principal,
            super::HostChatAction::OwnSideChat {
                session: session_id,
            },
        )?;
    }
    let authority = require_session(connection, library_id, session_id)?;
    let session_ids = super::session_side_chats::attached_session_ids(connection, session_id)?;
    let mut thread_ids = Vec::new();
    let mut project_ids = Vec::new();
    let mut scopes = Vec::new();
    let mut deleted_folders = Vec::new();
    for id in session_ids.iter().rev() {
        let current = require_session(connection, library_id, id)?;
        if let Some(thread_id) = &current.thread_id {
            super::sidebar_pins::clear_thread_projection(connection, thread_id)?;
            thread_ids.push(thread_id.clone());
        }
        // The root keeps its operation receipt identity; every descendant needs its own.
        let cleanup_id = if id == session_id {
            operation_id.to_owned()
        } else {
            crate::domain::identity::stable_uuid_v7(operation_id, "session_execution_cleanup", id)
        };
        super::agent_runtime_cleanup::enqueue(
            connection,
            library_id,
            &cleanup_id,
            id,
            current.project_id.as_deref(),
        )?;
        // Runtime consumers remain until native execution cleanup is acknowledged.
        connection.execute("DELETE FROM session_workspaces WHERE session_id=?1 AND NOT EXISTS(SELECT 1 FROM project_session_execution_bindings WHERE session_id=?1)",[id])?;
        if let Some(folder) = super::chat_folder::read(connection, id)?
            && folder.origin == nodex_core_contracts::workspace::ChatFolderOrigin::Generated
        {
            deleted_folders.push(folder);
        }
        if connection.execute("DELETE FROM project_sessions WHERE id = ?1", [id])? != 1 {
            return Err(corrupt("Project Session disappeared during deletion"));
        }
        if let Some(project_id) = &current.project_id {
            project_ids.push(project_id.clone());
        }
        let scope = project_session_scope(current.project_id.as_deref());
        if !scopes.contains(&scope) {
            scopes.push(scope);
        }
    }
    let deleted_folders = deleted_folders
        .into_iter()
        .filter_map(
            |folder| match super::chat_folder::still_referenced(connection, &folder) {
                Ok(false) => Some(Ok(folder)),
                Ok(true) => None,
                Err(error) => Some(Err(error)),
            },
        )
        .collect::<Result<Vec<_>, _>>()?;
    project_ids.sort();
    project_ids.dedup();
    finish_lifecycle_mutation_with_folders(
        connection,
        library_id,
        context,
        store_epoch,
        operation_id,
        request_hash,
        "delete_session",
        project_ids,
        session_ids,
        thread_ids,
        scopes,
        authority.project_id.as_deref(),
        &[],
        sqlite_now(connection)?,
        deleted_folders,
    )
}

#[allow(clippy::too_many_arguments)]
pub(super) fn move_session(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    session_id: &str,
    project_id: Option<&str>,
    placement: Option<&ProjectWorkspaceSessionPlacement>,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    validate_id("session_id", session_id)?;
    if let Some(project_id) = project_id {
        validate_id("project_id", project_id)?;
        require_project(connection, library_id, project_id, true)?;
    }
    let authority = require_session(connection, library_id, session_id)?;
    super::chat_stewardship::require(
        connection,
        library_id,
        context,
        session_id,
        super::chat_stewardship::ChatControl::Manage,
    )?;
    let workspace_project: Option<String> = connection.query_row("SELECT w.project_id FROM session_workspaces binding JOIN page_workspaces w ON w.workspace_id=binding.workspace_id WHERE binding.session_id=?1",[session_id],|r|r.get(0)).optional()?;
    if workspace_project
        .as_deref()
        .is_some_and(|owner| Some(owner) != project_id)
    {
        return Err(StoreError::new(
            StoreErrorCode::Conflict,
            "A Page Workspace chat stays in its Project",
            false,
        ));
    }

    let now = sqlite_now(connection)?;
    if authority.project_id.as_deref() == project_id && placement.is_none() {
        return finish_session_mutation(
            connection,
            library_id,
            context,
            store_epoch,
            operation_id,
            request_hash,
            "move_session",
            session_id,
            &authority,
            authority.thread_id.iter().cloned().collect(),
            SessionInvalidationKind::None,
            now,
        );
    }
    if authority.is_default_draft {
        let opener = super::chat_stewardship::opener_sql;
        let target_has_default = connection.query_row(
            &format!(
                "SELECT EXISTS(SELECT 1 FROM project_sessions draft \
                 WHERE draft.project_id IS ?1 AND draft.is_default_draft = 1 AND draft.id <> ?2 \
                   AND {} IS {})",
                opener("draft.id"),
                opener("?2")
            ),
            params![project_id, session_id],
            |row| row.get::<_, i64>(0),
        )? == 1;
        if target_has_default {
            return Err(StoreError::new(
                StoreErrorCode::Conflict,
                "Target scope already owns a default-draft Project Session",
                false,
            ));
        }
    }
    let source_project_id = connection.query_row(
        "SELECT source.project_id FROM project_session_side_chats side \
         JOIN project_sessions source ON source.id = side.source_session_id WHERE side.session_id = ?1",
        [session_id], |row| row.get::<_, Option<String>>(0),
    ).optional()?;
    if source_project_id.is_some_and(|source| source.as_deref() != project_id) {
        return Err(invalid(
            "A side chat must stay in its source Session's Project",
        ));
    }
    let session_ids = super::session_side_chats::attached_session_ids(connection, session_id)?;
    let mut thread_ids = authority.thread_id.iter().cloned().collect::<Vec<_>>();
    for id in session_ids.iter().filter(|id| id.as_str() != session_id) {
        let child = require_session(connection, library_id, id)?;
        connection.execute(
            "UPDATE project_sessions SET project_id = ?1, manual_rank = NULL, updated_at = ?2 WHERE id = ?3",
            params![project_id, now, id],
        )?;
        connection.execute(
            "UPDATE codex_threads SET project_id = ?1 WHERE thread_id IN (\
               SELECT thread_id FROM project_session_threads WHERE session_id = ?2\
             )",
            params![project_id, id],
        )?;
        thread_ids.extend(child.thread_id);
    }
    let changed = connection.execute(
        "UPDATE project_sessions SET project_id = ?1, manual_rank = NULL, updated_at = ?2 \
         WHERE id = ?3",
        params![project_id, now, session_id],
    )?;
    if changed != 1 {
        return Err(corrupt("Project Session disappeared during Project move"));
    }
    connection.execute(
        "UPDATE codex_threads SET project_id = ?1 WHERE thread_id IN (\
           SELECT thread_id FROM project_session_threads WHERE session_id = ?2\
         )",
        params![project_id, session_id],
    )?;

    if let Some(placement) = placement {
        super::session_order::place(
            connection,
            &crate::infrastructure::actors::requesting_member(connection, context)?,
            session_id,
            project_id,
            placement,
        )?;
    }
    let mut project_ids = authority.project_id.iter().cloned().collect::<Vec<_>>();
    if let Some(project_id) = project_id
        && !project_ids.iter().any(|candidate| candidate == project_id)
    {
        project_ids.push(project_id.to_owned());
    }
    let mut summary_scopes = vec![project_session_scope(authority.project_id.as_deref())];
    let target_scope = project_session_scope(project_id);
    if !summary_scopes.contains(&target_scope) {
        summary_scopes.push(target_scope);
    }
    finish_lifecycle_mutation(
        connection,
        library_id,
        context,
        store_epoch,
        operation_id,
        request_hash,
        "move_session",
        project_ids,
        session_ids,
        thread_ids,
        summary_scopes,
        project_id.or(authority.project_id.as_deref()),
        &[],
        now,
    )
}

#[allow(clippy::too_many_arguments)]
pub(super) fn reorder_pinned_sessions(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    project_id: Option<&str>,
    session_ids: &[String],
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    if session_ids.len() > MAX_SESSIONS_PER_LANE {
        return Err(invalid("Pinned Session order exceeds its bound"));
    }
    if let Some(id) = project_id {
        validate_id("project_id", id)?;
        require_project(connection, library_id, id, true)?;
    }
    for id in session_ids {
        validate_id("session_id", id)?;
    }
    let now = sqlite_now(connection)?;
    let member = crate::infrastructure::actors::requesting_member(connection, context)?;
    let current = super::sidebar_pins::read_order(connection, library_id, &member)?;
    let eligible = current
        .iter()
        .filter(|row| row.project_id.as_deref() == project_id)
        .map(|row| row.id.as_str())
        .collect::<HashSet<_>>();
    let selected = session_ids
        .iter()
        .filter(|id| eligible.contains(id.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    super::sidebar_pins::reorder_subset(connection, library_id, &member, &selected, &now)?;
    let pins = super::sidebar_pins::read_order(connection, library_id, &member)?;
    finish_lifecycle_mutation(
        connection,
        library_id,
        context,
        store_epoch,
        operation_id,
        request_hash,
        "reorder_pinned_sessions",
        project_id.into_iter().map(str::to_owned).collect(),
        pins.iter().map(|p| p.id.clone()).collect(),
        pins.iter().filter_map(|p| p.thread_id.clone()).collect(),
        vec![ProjectSessionInvalidationScope::All],
        project_id,
        &[],
        now,
    )
}

#[allow(clippy::too_many_arguments)]
pub(super) fn place_session(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    session_id: &str,
    placement: &ProjectWorkspaceSessionPlacement,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    let authority = require_session(connection, library_id, session_id)?;
    super::session_order::place(
        connection,
        &crate::infrastructure::actors::requesting_member(connection, context)?,
        session_id,
        authority.project_id.as_deref(),
        placement,
    )?;
    finish_lifecycle_mutation(
        connection,
        library_id,
        context,
        store_epoch,
        operation_id,
        request_hash,
        "place_session",
        authority.project_id.iter().cloned().collect(),
        vec![session_id.to_owned()],
        vec![],
        vec![project_session_scope(authority.project_id.as_deref())],
        authority.project_id.as_deref(),
        &[],
        sqlite_now(connection)?,
    )
}

/// The activity relay is replayable and tolerates Sessions deleted between catalog pages.
#[allow(clippy::too_many_arguments)]
pub(super) fn record_session_activity(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    entries: &[ProjectWorkspaceSessionActivityEntry],
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    if entries.len() > 500 {
        return Err(invalid("Session activity accepts at most 500 entries"));
    }
    for entry in entries {
        validate_id("session_id", &entry.session_id)?;
    }
    let now = sqlite_now(connection)?;
    let mut session_ids = Vec::new();
    for entry in entries {
        let changed = connection.execute(
            "UPDATE project_sessions SET activity_at=max(activity_at, CAST(round(unixepoch(created_at,'subsec')*1000) AS INTEGER), min(?1, CAST(round(unixepoch(?2,'subsec')*1000) AS INTEGER))) \
             WHERE id=?3 AND (project_id IS NULL OR EXISTS(SELECT 1 FROM projects WHERE projects.id=project_sessions.project_id AND library_id=?4)) \
             AND activity_at < max(CAST(round(unixepoch(created_at,'subsec')*1000) AS INTEGER),min(?1,CAST(round(unixepoch(?2,'subsec')*1000) AS INTEGER)))",
            params![entry.at_ms,now,entry.session_id,library_id])?;
        if changed != 0 {
            session_ids.push(entry.session_id.clone());
        }
    }
    if session_ids.is_empty() {
        return finish_no_op(
            connection,
            context,
            store_epoch,
            operation_id,
            request_hash,
            "record_session_activity",
            vec![],
            vec![],
            &now,
        );
    }
    finish_lifecycle_mutation(
        connection,
        library_id,
        context,
        store_epoch,
        operation_id,
        request_hash,
        "record_session_activity",
        vec![],
        session_ids,
        vec![],
        vec![ProjectSessionInvalidationScope::All],
        None,
        &[],
        now,
    )
}

#[allow(clippy::too_many_arguments)]
pub(super) fn finish_lifecycle_mutation(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    operation_kind: &'static str,
    project_ids: Vec<String>,
    session_ids: Vec<String>,
    thread_ids: Vec<String>,
    session_summary_scopes: Vec<nodex_core_contracts::workspace::ProjectSessionInvalidationScope>,
    change_project_id: Option<&str>,
    handed_off_page_ids: &[String],
    committed_at: String,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    finish_lifecycle_mutation_with_folders(
        connection,
        library_id,
        context,
        store_epoch,
        operation_id,
        request_hash,
        operation_kind,
        project_ids,
        session_ids,
        thread_ids,
        session_summary_scopes,
        change_project_id,
        handed_off_page_ids,
        committed_at,
        Vec::new(),
    )
}

#[allow(clippy::too_many_arguments)]
fn finish_lifecycle_mutation_with_folders(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    operation_kind: &'static str,
    project_ids: Vec<String>,
    session_ids: Vec<String>,
    thread_ids: Vec<String>,
    session_summary_scopes: Vec<nodex_core_contracts::workspace::ProjectSessionInvalidationScope>,
    change_project_id: Option<&str>,
    handed_off_page_ids: &[String],
    committed_at: String,
    deleted_folders: Vec<nodex_core_contracts::workspace::ChatFolder>,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    let change_project_id = change_project_id.map(str::to_owned);
    let effects = WorkspaceMutationEffects {
        operation_kind,
        project_catalog_change: None,
        change_project_id,
        project_ids,
        session_detail_ids: session_ids.clone(),
        session_ids,
        thread_ids,
        session_summary_scopes,
        block_ids: Vec::new(),
        document_ids: Vec::new(),
        database_ids: Vec::new(),
        page_ids: Vec::new(),
        data_source_ids: Vec::new(),
        view_ids: Vec::new(),
        document_heads: Vec::new(),
        committed_at: committed_at.clone(),
    };
    super::mutation::run_mutation_with_folder_result(
        connection,
        context,
        store_epoch,
        operation_id,
        request_hash,
        &committed_at,
        super::mutation::FolderMutationResult {
            bound: None,
            deleted: deleted_folders,
        },
        |scope| {
            super::page_chat::advance_handed_off_pages(
                connection,
                library_id,
                context,
                scope.evidence(),
                operation_id,
                handed_off_page_ids,
                effects,
            )
        },
    )
}

pub(super) fn require_project(
    connection: &Connection,
    library_id: &str,
    project_id: &str,
    active: bool,
) -> Result<(), StoreError> {
    let lifecycle = connection
        .query_row(
            "SELECT lifecycle FROM projects WHERE id = ?1 AND library_id = ?2",
            params![project_id, library_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .ok_or_else(|| not_found("Project is unavailable in this Library"))?;
    if !active || lifecycle == "active" {
        return Ok(());
    }
    Err(invalid("New Sessions require an active Project"))
}

pub(super) fn normalize_session_title(value: &str) -> Result<String, StoreError> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > MAX_SESSION_TITLE_BYTES
        || value.encode_utf16().count() > MAX_SESSION_TITLE_UTF16
    {
        return Err(invalid("Project Session title is invalid"));
    }
    Ok(value.to_owned())
}

fn invalid(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message, false)
}

fn not_found(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::NotFound, message, false)
}

fn corrupt(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message, false)
}
