use std::collections::BTreeSet;
use std::time::{SystemTime, UNIX_EPOCH};

use nodex_core_contracts::BoundModuleContext;
use nodex_core_contracts::agent::AgentBackendBinding;
use nodex_core_contracts::workspace::{
    CodexPermissionMode, CodexThreadActiveFlag, CodexThreadStatusType,
    ProjectWorkspaceDynamicToolCatalog, ProjectWorkspaceThread,
    ProjectWorkspaceThreadBackendSession, ProjectWorkspaceThreadExecutionLocation,
    ProjectWorkspaceThreadPatch, ProjectWorkspaceThreadPlacement, ProjectWorkspaceThreadStatus,
};
use rusqlite::{Connection, OptionalExtension, params};

use crate::domain::agent_backend::{binding_from_storage, binding_storage};
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

use super::ProjectWorkspaceApplyOutcome;
use super::execution::read_writable_roots;
use super::mutation::{
    WorkspaceMutationEffects, finish_mutation, project_session_scope, run_mutation,
    workspace_event_anchor,
};
use super::session_mutation::sqlite_now;

const MAX_ID_BYTES: usize = 512;
const MAX_THREAD_NAME_UTF16: usize = 2_000;
const MAX_SHORT_TEXT_BYTES: usize = 4_096;
const MAX_REASONING_EFFORT_BYTES: usize = 64;
const MAX_PATH_BYTES: usize = 16_384;
const MAX_PREVIEW_BYTES: usize = 1_024;
const MAX_CATALOGS: usize = 64;
const MAX_CATALOG_NAMESPACE_BYTES: usize = 256;
const MAX_THREADS: usize = 100_000;
const MAX_APP_SERVER_SWEEP_WINDOW: usize = 200;
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

const THREAD_COLUMNS: &str = "
  thread.thread_id,
  thread.project_id,
  thread.forked_from_id,
  thread.parent_thread_id,
  thread.thread_name,
  thread.thread_source,
  thread.service_name,
  thread.agent_nickname,
  thread.agent_role,
  thread.agent_path,
  thread.thread_preview,
  thread.model_id,
  thread.reasoning_effort,
  thread.service_tier,
  thread.agent_backend_kind,
  thread.agent_backend_definition_id,
  thread.agent_backend_instance_config_id,
  thread.execution_host_id,
  thread.cwd,
  thread.managed_worktree_path,
  thread.projectless_output_directory,
  thread.projectless_workspace_browser_root,
  thread.status_type,
  thread.status_active_flags_json,
  thread.archived,
  pinned.pinned_order,
  CASE WHEN unread.thread_id IS NULL THEN 0 ELSE 1 END,
  thread.created_at,
  thread.updated_at,
  thread.recency_at,
  thread.linked_at
";

#[derive(Clone)]
struct ThreadRow {
    thread_id: String,
    project_id: Option<String>,
    forked_from_id: Option<String>,
    parent_thread_id: Option<String>,
    thread_name: Option<String>,
    thread_source: Option<String>,
    service_name: Option<String>,
    agent_nickname: Option<String>,
    agent_role: Option<String>,
    agent_path: Option<String>,
    thread_preview: String,
    model_id: Option<String>,
    reasoning_effort: Option<String>,
    service_tier: Option<String>,
    backend_binding: AgentBackendBinding,
    execution_host_id: String,
    cwd: Option<String>,
    managed_worktree_path: Option<String>,
    projectless_output_directory: Option<String>,
    projectless_workspace_browser_root: Option<String>,
    status_type: String,
    status_active_flags_json: String,
    archived: i64,
    pinned_order: Option<i64>,
    has_unread_turn: i64,
    created_at: i64,
    updated_at: i64,
    recency_at: i64,
    linked_at: String,
}

pub(super) fn read_thread(
    connection: &Connection,
    library_id: &str,
    thread_id: &str,
) -> Result<Option<ProjectWorkspaceThread>, StoreError> {
    let sql = format!(
        "SELECT {THREAD_COLUMNS} \
         FROM codex_threads thread \
         LEFT JOIN codex_pinned_threads pinned ON pinned.thread_id = thread.thread_id \
         LEFT JOIN codex_unread_threads unread ON unread.thread_id = thread.thread_id \
         WHERE thread.thread_id = ?1 \
           AND (thread.project_id IS NULL OR EXISTS (\
             SELECT 1 FROM projects project \
             WHERE project.id = thread.project_id AND project.library_id = ?2\
           ))"
    );
    connection
        .query_row(&sql, params![thread_id, library_id], thread_row)
        .optional()?
        .map(|row| project_workspace_thread(connection, library_id, row))
        .transpose()
}

pub(super) fn read_thread_backend_session(
    connection: &Connection,
    library_id: &str,
    thread_id: &str,
) -> Result<Option<ProjectWorkspaceThreadBackendSession>, StoreError> {
    let thread = require_thread(connection, library_id, thread_id)?;
    let stored = connection
        .query_row(
            "SELECT backend_kind, agent_definition_id, instance_config_id, \
                    backend_session_id, updated_at \
             FROM thread_backend_sessions WHERE thread_id = ?1",
            [thread_id],
            |row| {
                let kind = row.get::<_, String>(0)?;
                let binding = binding_from_storage(&kind, row.get(1)?, row.get(2)?)
                    .map_err(|_| rusqlite::Error::InvalidQuery)?;
                Ok(ProjectWorkspaceThreadBackendSession {
                    thread_id: thread_id.to_owned(),
                    backend_binding: binding,
                    backend_session_id: row.get(3)?,
                    updated_at: row.get(4)?,
                })
            },
        )
        .optional()
        .map_err(|_| corrupt("Stored Thread backend session is invalid"))?;
    if stored
        .as_ref()
        .is_some_and(|session| session.backend_binding != thread.backend_binding)
    {
        return Err(corrupt(
            "Stored Thread backend session does not match its backend binding",
        ));
    }
    Ok(stored)
}

#[allow(clippy::too_many_arguments)]
pub(super) fn bind_thread_backend_session(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    thread_id: &str,
    backend_binding: &AgentBackendBinding,
    backend_session_id: &str,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    validate_id("thread_id", thread_id)?;
    validate_id("backend_session_id", backend_session_id)?;
    let thread = require_thread(connection, library_id, thread_id)?;
    if &thread.backend_binding != backend_binding {
        return Err(conflict(
            "Thread backend binding changed before its session could be persisted",
        ));
    }
    let storage = binding_storage(backend_binding).map_err(invalid)?;
    if storage.kind != "acp" {
        return Err(invalid(
            "Native Codex Threads do not persist a backend protocol session",
        ));
    }
    let now = unix_time_millis()?;
    connection.execute(
        "INSERT INTO thread_backend_sessions(\
           thread_id, backend_kind, agent_definition_id, instance_config_id, \
           backend_session_id, updated_at\
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6) \
         ON CONFLICT(thread_id) DO UPDATE SET \
           backend_kind = excluded.backend_kind, \
           agent_definition_id = excluded.agent_definition_id, \
           instance_config_id = excluded.instance_config_id, \
           backend_session_id = excluded.backend_session_id, \
           updated_at = excluded.updated_at",
        params![
            thread_id,
            storage.kind,
            storage.agent_definition_id,
            storage.instance_config_id,
            backend_session_id,
            now,
        ],
    )?;
    let session_ids = linked_session_ids(
        connection,
        library_id,
        thread_id,
        thread.project_id.as_deref(),
    )?;
    let project_ids = thread.project_id.into_iter().collect::<Vec<_>>();
    let scopes = project_session_scopes(&project_ids, &session_ids);
    finish_thread_mutation(
        connection,
        library_id,
        context,
        store_epoch,
        operation_id,
        request_hash,
        "bind_thread_backend_session",
        scopes,
        project_ids,
        session_ids,
        vec![thread_id.to_owned()],
    )
}

#[allow(clippy::too_many_arguments)]
pub(super) fn clear_thread_backend_session(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    thread_id: &str,
    backend_binding: &AgentBackendBinding,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    validate_id("thread_id", thread_id)?;
    let thread = require_thread(connection, library_id, thread_id)?;
    if &thread.backend_binding != backend_binding {
        return Err(conflict(
            "Thread backend binding changed before its session could be cleared",
        ));
    }
    connection.execute(
        "DELETE FROM thread_backend_sessions WHERE thread_id = ?1",
        [thread_id],
    )?;
    let session_ids = linked_session_ids(
        connection,
        library_id,
        thread_id,
        thread.project_id.as_deref(),
    )?;
    let project_ids = thread.project_id.into_iter().collect::<Vec<_>>();
    let scopes = project_session_scopes(&project_ids, &session_ids);
    finish_thread_mutation(
        connection,
        library_id,
        context,
        store_epoch,
        operation_id,
        request_hash,
        "clear_thread_backend_session",
        scopes,
        project_ids,
        session_ids,
        vec![thread_id.to_owned()],
    )
}

#[cfg(test)]
pub(super) fn read_threads(
    connection: &Connection,
    library_id: &str,
    project_id: Option<&str>,
    exact_project_scope: bool,
    parent_thread_id: Option<&str>,
    include_archived: bool,
) -> Result<Vec<ProjectWorkspaceThread>, StoreError> {
    if let Some(project_id) = project_id {
        validate_id("project_id", project_id)?;
        require_known_project(connection, library_id, project_id)?;
    }
    if let Some(parent_thread_id) = parent_thread_id {
        validate_id("parent_thread_id", parent_thread_id)?;
    }
    let sql = format!(
        "SELECT {THREAD_COLUMNS} \
         FROM codex_threads thread \
         LEFT JOIN codex_pinned_threads pinned ON pinned.thread_id = thread.thread_id \
         LEFT JOIN codex_unread_threads unread ON unread.thread_id = thread.thread_id \
         WHERE (thread.project_id IS NULL OR EXISTS (\
             SELECT 1 FROM projects project \
             WHERE project.id = thread.project_id AND project.library_id = ?1 \
               AND (?4 = 1 OR project.lifecycle <> 'archived')\
           )) \
           AND ((?5 = 0 AND (?2 IS NULL OR thread.project_id = ?2)) \
             OR (?5 = 1 AND ((?2 IS NULL AND thread.project_id IS NULL) \
               OR thread.project_id = ?2))) \
           AND ((?3 IS NULL AND thread.parent_thread_id IS NULL) \
             OR thread.parent_thread_id = ?3) \
           AND (?4 = 1 OR thread.archived = 0) \
         ORDER BY thread.recency_at DESC, thread.thread_id \
         LIMIT ?6"
    );
    let rows = connection
        .prepare(&sql)?
        .query_map(
            params![
                library_id,
                project_id,
                parent_thread_id,
                i64::from(include_archived),
                i64::from(exact_project_scope),
                i64::try_from(MAX_THREADS + 1).expect("thread bound fits i64"),
            ],
            thread_row,
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if rows.len() > MAX_THREADS {
        return Err(corrupt("Codex Thread collection exceeds its Core bound"));
    }
    rows.into_iter()
        .map(|row| project_workspace_thread(connection, library_id, row))
        .collect()
}

pub(super) fn read_permission_mode(
    connection: &Connection,
    project_id: &str,
) -> Result<Option<CodexPermissionMode>, StoreError> {
    connection
        .query_row(
            "SELECT mode FROM codex_project_permission_mode_selections WHERE project_id = ?1",
            [project_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .map(|mode| parse_permission_mode(&mode))
        .transpose()
}

pub(super) fn read_projectless_permission_mode(
    connection: &Connection,
) -> Result<Option<CodexPermissionMode>, StoreError> {
    connection
        .query_row(
            "SELECT mode FROM codex_projectless_permission_mode_selection WHERE id = 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .map(|mode| parse_permission_mode(&mode))
        .transpose()
}

pub(super) struct ThreadUpsertEffects {
    pub(super) project_ids: Vec<String>,
    pub(super) session_ids: Vec<String>,
    pub(super) session_summary_scopes:
        Vec<nodex_core_contracts::workspace::ProjectSessionInvalidationScope>,
}

#[allow(clippy::too_many_arguments)]
pub(super) fn upsert_thread(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    thread_id: &str,
    patch: &ProjectWorkspaceThreadPatch,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    let effects = upsert_thread_records(connection, library_id, thread_id, patch)?;
    finish_thread_mutation(
        connection,
        library_id,
        context,
        store_epoch,
        operation_id,
        request_hash,
        "upsert_thread",
        effects.session_summary_scopes,
        effects.project_ids,
        effects.session_ids,
        vec![thread_id.to_owned()],
    )
}

#[allow(clippy::too_many_arguments)]
pub(super) fn update_thread(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    thread_id: &str,
    patch: &ProjectWorkspaceThreadPatch,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    require_thread(connection, library_id, thread_id)?;
    let effects = upsert_thread_records(connection, library_id, thread_id, patch)?;
    finish_thread_mutation(
        connection,
        library_id,
        context,
        store_epoch,
        operation_id,
        request_hash,
        "update_thread",
        effects.session_summary_scopes,
        effects.project_ids,
        effects.session_ids,
        vec![thread_id.to_owned()],
    )
}

#[allow(clippy::too_many_arguments)]
pub(super) fn set_thread_execution_location(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    thread_id: &str,
    location: &ProjectWorkspaceThreadExecutionLocation,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    let existing = read_stored_thread(connection, thread_id)?
        .ok_or_else(|| not_found("Codex Thread is unavailable"))?;
    validate_stored_thread(&existing)?;
    assert_project_visible(connection, library_id, existing.project_id.as_deref())?;
    replace_thread_execution_location_records(connection, thread_id, location)?;
    let session_ids = linked_session_ids(
        connection,
        library_id,
        thread_id,
        existing.project_id.as_deref(),
    )?;
    let project_ids = existing.project_id.into_iter().collect::<Vec<_>>();
    let scopes = project_session_scopes(&project_ids, &session_ids);
    finish_thread_mutation(
        connection,
        library_id,
        context,
        store_epoch,
        operation_id,
        request_hash,
        "set_thread_execution_location",
        scopes,
        project_ids,
        session_ids,
        vec![thread_id.to_owned()],
    )
}

pub(super) fn replace_thread_execution_location_records(
    connection: &Connection,
    thread_id: &str,
    location: &ProjectWorkspaceThreadExecutionLocation,
) -> Result<(), StoreError> {
    validate_id("thread_id", thread_id)?;
    validate_id("execution_host_id", &location.execution_host_id)?;
    for (name, value) in [
        ("cwd", location.cwd.as_deref()),
        (
            "managed_worktree_path",
            location.managed_worktree_path.as_deref(),
        ),
        (
            "projectless_output_directory",
            location.projectless_output_directory.as_deref(),
        ),
        (
            "projectless_workspace_browser_root",
            location.projectless_workspace_browser_root.as_deref(),
        ),
    ] {
        if let Some(value) = value {
            validate_text(name, value, MAX_PATH_BYTES)?;
        }
    }
    super::execution::replace_writable_roots_records(
        connection,
        thread_id,
        &location.runtime_workspace_roots,
    )?;
    let updated = connection.execute(
        "UPDATE codex_threads SET \
           execution_host_id = ?1, cwd = ?2, managed_worktree_path = ?3, \
           projectless_output_directory = ?4, projectless_workspace_browser_root = ?5 \
         WHERE thread_id = ?6",
        params![
            &location.execution_host_id,
            location.cwd.as_deref(),
            location.managed_worktree_path.as_deref(),
            location.projectless_output_directory.as_deref(),
            location.projectless_workspace_browser_root.as_deref(),
            thread_id,
        ],
    )?;
    if updated != 1 {
        return Err(conflict(
            "Codex Thread changed during execution-location update",
        ));
    }
    Ok(())
}

pub(super) fn upsert_thread_records(
    connection: &Connection,
    library_id: &str,
    thread_id: &str,
    patch: &ProjectWorkspaceThreadPatch,
) -> Result<ThreadUpsertEffects, StoreError> {
    validate_id("thread_id", thread_id)?;
    let existing = read_stored_thread(connection, thread_id)?;
    if let Some(existing) = &existing {
        validate_stored_thread(existing)?;
        thread_status(existing)?;
        assert_project_visible(connection, library_id, existing.project_id.as_deref())?;
        if patch
            .project_id
            .as_ref()
            .is_some_and(|project_id| project_id.as_deref() != existing.project_id.as_deref())
        {
            return Err(conflict(
                "Codex Thread ownership changes require the MoveThread intent",
            ));
        }
    }

    let project_id = merge_identity(
        existing.as_ref().and_then(|row| row.project_id.clone()),
        &patch.project_id,
        "project_id",
    )?;
    if let Some(project_id) = project_id.as_deref() {
        require_project(connection, library_id, project_id)?;
    }
    assert_linked_session_project(connection, library_id, thread_id, project_id.as_deref())?;

    let forked_from_id = merge_identity(
        existing.as_ref().and_then(|row| row.forked_from_id.clone()),
        &patch.forked_from_id,
        "forked_from_id",
    )?;
    let parent_thread_id = merge_identity(
        existing
            .as_ref()
            .and_then(|row| row.parent_thread_id.clone()),
        &patch.parent_thread_id,
        "parent_thread_id",
    )?;
    if parent_thread_id.as_deref() == Some(thread_id) {
        return Err(invalid("A Codex Thread cannot be its own parent"));
    }
    let linked_sidebar_session_ids = if parent_thread_id.is_some() {
        linked_session_ids(connection, library_id, thread_id, project_id.as_deref())?
    } else {
        Vec::new()
    };
    let thread_name = merge_nullable_text(
        existing.as_ref().and_then(|row| row.thread_name.clone()),
        &patch.thread_name,
        "thread_name",
        MAX_SHORT_TEXT_BYTES,
        true,
    )?;
    if thread_name
        .as_deref()
        .is_some_and(|name| name.encode_utf16().count() > MAX_THREAD_NAME_UTF16)
    {
        return Err(invalid("thread_name exceeds 2,000 UTF-16 code units"));
    }
    let thread_source = merge_nullable_text(
        existing.as_ref().and_then(|row| row.thread_source.clone()),
        &patch.thread_source,
        "thread_source",
        MAX_SHORT_TEXT_BYTES,
        true,
    )?;
    let service_name = merge_nullable_text(
        existing.as_ref().and_then(|row| row.service_name.clone()),
        &patch.service_name,
        "service_name",
        MAX_SHORT_TEXT_BYTES,
        true,
    )?;
    let agent_nickname = merge_nullable_text(
        existing.as_ref().and_then(|row| row.agent_nickname.clone()),
        &patch.agent_nickname,
        "agent_nickname",
        MAX_SHORT_TEXT_BYTES,
        true,
    )?;
    let agent_role = merge_nullable_text(
        existing.as_ref().and_then(|row| row.agent_role.clone()),
        &patch.agent_role,
        "agent_role",
        MAX_SHORT_TEXT_BYTES,
        true,
    )?;
    let agent_path = merge_nullable_text(
        existing.as_ref().and_then(|row| row.agent_path.clone()),
        &patch.agent_path,
        "agent_path",
        MAX_PATH_BYTES,
        true,
    )?;
    let cwd = merge_nullable_text(
        existing.as_ref().and_then(|row| row.cwd.clone()),
        &patch.cwd,
        "cwd",
        MAX_PATH_BYTES,
        true,
    )?;
    let managed_worktree_path = merge_nullable_text(
        existing
            .as_ref()
            .and_then(|row| row.managed_worktree_path.clone()),
        &patch.managed_worktree_path,
        "managed_worktree_path",
        MAX_PATH_BYTES,
        true,
    )?;
    let projectless_output_directory = merge_nullable_text(
        existing
            .as_ref()
            .and_then(|row| row.projectless_output_directory.clone()),
        &patch.projectless_output_directory,
        "projectless_output_directory",
        MAX_PATH_BYTES,
        true,
    )?;
    let projectless_workspace_browser_root = merge_nullable_text(
        existing
            .as_ref()
            .and_then(|row| row.projectless_workspace_browser_root.clone()),
        &patch.projectless_workspace_browser_root,
        "projectless_workspace_browser_root",
        MAX_PATH_BYTES,
        true,
    )?;
    let normalized_thread_preview = patch
        .thread_preview
        .as_deref()
        .map(super::task_window::bounded_preview);
    let thread_preview = merge_required_text(
        existing.as_ref().map(|row| row.thread_preview.as_str()),
        normalized_thread_preview.as_deref(),
        "thread_preview",
        MAX_PREVIEW_BYTES,
        false,
    )?;
    let model_id = merge_nullable_text(
        existing.as_ref().and_then(|row| row.model_id.clone()),
        &patch.model_id,
        "model_id",
        MAX_SHORT_TEXT_BYTES,
        true,
    )?;
    let reasoning_effort = merge_nullable_text(
        existing
            .as_ref()
            .and_then(|row| row.reasoning_effort.clone()),
        &patch.reasoning_effort,
        "reasoning_effort",
        MAX_REASONING_EFFORT_BYTES,
        true,
    )?;
    let service_tier = merge_nullable_text(
        existing.as_ref().and_then(|row| row.service_tier.clone()),
        &patch.service_tier,
        "service_tier",
        MAX_REASONING_EFFORT_BYTES,
        true,
    )?;
    let backend_binding = patch
        .backend_binding
        .clone()
        .or_else(|| existing.as_ref().map(|row| row.backend_binding.clone()))
        .unwrap_or_default();
    let backend_storage = binding_storage(&backend_binding).map_err(invalid)?;
    let backend_changed = existing
        .as_ref()
        .is_some_and(|row| row.backend_binding != backend_binding);
    let execution_host_id = match patch.execution_host_id.as_deref() {
        Some(host_id) => {
            validate_id("execution_host_id", host_id)?;
            host_id.to_owned()
        }
        None => existing
            .as_ref()
            .map_or_else(|| "local".to_owned(), |row| row.execution_host_id.clone()),
    };
    let status = match &patch.status {
        Some(status) => validate_status(status.clone())?,
        None => existing.as_ref().map(thread_status).transpose()?.unwrap_or(
            ProjectWorkspaceThreadStatus {
                status_type: CodexThreadStatusType::NotLoaded,
                active_flags: Vec::new(),
            },
        ),
    };
    let archived = patch
        .archived
        .unwrap_or_else(|| existing.as_ref().is_some_and(|row| row.archived == 1));
    let now_ms = unix_time_millis()?;
    let created_at = if let Some(existing) = &existing {
        if patch
            .created_at
            .is_some_and(|created_at| created_at != existing.created_at)
        {
            return Err(invalid("created_at is immutable after Thread creation"));
        }
        existing.created_at
    } else {
        patch.created_at.unwrap_or(now_ms)
    };
    let updated_at = match (&existing, patch.updated_at) {
        (Some(existing), Some(observed)) => existing.updated_at.max(observed),
        (Some(existing), None) => existing.updated_at,
        (None, Some(observed)) => observed,
        (None, None) => now_ms,
    };
    let recency_at = match (&existing, patch.recency_at) {
        (Some(existing), Some(observed)) => existing.recency_at.max(observed),
        (Some(existing), None) => existing.recency_at,
        (None, Some(observed)) => observed,
        (None, None) => updated_at,
    };
    validate_timestamp("created_at", created_at)?;
    validate_timestamp("updated_at", updated_at)?;
    validate_timestamp("recency_at", recency_at)?;
    if updated_at < created_at {
        return Err(invalid("updated_at must not precede created_at"));
    }
    if recency_at < created_at {
        return Err(invalid("recency_at must not precede created_at"));
    }
    let linked_at = if let Some(existing) = &existing {
        if patch
            .linked_at
            .as_deref()
            .map(validate_linked_at)
            .transpose()?
            .is_some_and(|linked_at| linked_at != existing.linked_at)
        {
            return Err(invalid("linked_at is immutable after Thread creation"));
        }
        existing.linked_at.clone()
    } else {
        patch
            .linked_at
            .as_deref()
            .map(validate_linked_at)
            .transpose()?
            .map_or_else(|| sqlite_now(connection), Ok)?
    };
    let status_type = status_type_literal(status.status_type);
    let active_flags_json = serde_json::to_string(&status.active_flags)
        .map_err(|_| internal("Could not encode Codex Thread status flags"))?;

    connection.execute(
        "INSERT INTO codex_threads (\
           thread_id, project_id, parent_thread_id, thread_name, thread_source, service_name, \
           agent_nickname, agent_role, agent_path, thread_preview, model_id, \
           reasoning_effort, service_tier, agent_backend_kind, agent_backend_definition_id, \
           agent_backend_instance_config_id, execution_host_id, cwd, \
           managed_worktree_path, projectless_output_directory, \
           projectless_workspace_browser_root, status_type, status_active_flags_json, archived, \
           created_at, updated_at, recency_at, linked_at, forked_from_id\
         ) VALUES (\
           ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, \
           ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29\
         ) ON CONFLICT(thread_id) DO UPDATE SET \
           project_id = excluded.project_id, parent_thread_id = excluded.parent_thread_id, \
           thread_name = excluded.thread_name, thread_source = excluded.thread_source, \
           service_name = excluded.service_name, agent_nickname = excluded.agent_nickname, \
           agent_role = excluded.agent_role, agent_path = excluded.agent_path, \
           thread_preview = excluded.thread_preview, \
           model_id = excluded.model_id, reasoning_effort = excluded.reasoning_effort, \
           service_tier = excluded.service_tier, \
           agent_backend_kind = excluded.agent_backend_kind, \
           agent_backend_definition_id = excluded.agent_backend_definition_id, \
           agent_backend_instance_config_id = excluded.agent_backend_instance_config_id, \
           execution_host_id = excluded.execution_host_id, cwd = excluded.cwd, \
           managed_worktree_path = excluded.managed_worktree_path, \
           projectless_output_directory = excluded.projectless_output_directory, \
           projectless_workspace_browser_root = excluded.projectless_workspace_browser_root, \
           status_type = excluded.status_type, \
           status_active_flags_json = excluded.status_active_flags_json, \
           archived = excluded.archived, updated_at = excluded.updated_at, \
           recency_at = excluded.recency_at, \
           forked_from_id = excluded.forked_from_id",
        params![
            thread_id,
            project_id,
            parent_thread_id,
            thread_name,
            thread_source,
            service_name,
            agent_nickname,
            agent_role,
            agent_path,
            thread_preview,
            model_id,
            reasoning_effort,
            service_tier,
            backend_storage.kind,
            backend_storage.agent_definition_id,
            backend_storage.instance_config_id,
            execution_host_id,
            cwd,
            managed_worktree_path,
            projectless_output_directory,
            projectless_workspace_browser_root,
            status_type,
            active_flags_json,
            i64::from(archived),
            created_at,
            updated_at,
            recency_at,
            linked_at,
            forked_from_id,
        ],
    )?;
    if backend_changed {
        connection.execute(
            "DELETE FROM thread_backend_sessions WHERE thread_id = ?1",
            [thread_id],
        )?;
    }
    if archived {
        connection.execute(
            "DELETE FROM codex_unread_threads WHERE thread_id = ?1",
            [thread_id],
        )?;
    }

    let session_ids = if parent_thread_id.is_some() {
        retire_child_sidebar_materialization(connection, thread_id, &linked_sidebar_session_ids)?;
        linked_sidebar_session_ids
    } else {
        linked_session_ids(connection, library_id, thread_id, project_id.as_deref())?
    };
    let project_ids = affected_projects(
        existing.as_ref().and_then(|row| row.project_id.as_deref()),
        project_id.as_deref(),
    );
    let session_summary_scopes = project_session_scopes(&project_ids, &session_ids);
    Ok(ThreadUpsertEffects {
        project_ids,
        session_ids,
        session_summary_scopes,
    })
}

fn retire_child_sidebar_materialization(
    connection: &Connection,
    thread_id: &str,
    session_ids: &[String],
) -> Result<(), StoreError> {
    connection.execute(
        "DELETE FROM codex_pinned_threads WHERE thread_id = ?1",
        [thread_id],
    )?;
    connection.execute(
        "DELETE FROM codex_unread_threads WHERE thread_id = ?1",
        [thread_id],
    )?;
    if session_ids.is_empty() {
        return Ok(());
    }

    let now = sqlite_now(connection)?;
    for session_id in session_ids {
        let changed = connection.execute(
            "UPDATE project_sessions SET archived = 1, archived_at = ?1, pinned = 0, \
               pinned_order = NULL, unread = 0, updated_at = ?1 WHERE id = ?2",
            params![now, session_id],
        )?;
        if changed != 1 {
            return Err(corrupt(
                "Child Codex Thread sidebar Session disappeared during retirement",
            ));
        }
    }
    let detached = connection.execute(
        "DELETE FROM project_session_threads WHERE thread_id = ?1",
        [thread_id],
    )?;
    if detached != session_ids.len() {
        return Err(corrupt(
            "Child Codex Thread sidebar Session link changed during retirement",
        ));
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(super) fn delete_thread(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    thread_id: &str,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    validate_id("thread_id", thread_id)?;
    let thread = require_thread(connection, library_id, thread_id)?;
    let session_ids = linked_session_ids(
        connection,
        library_id,
        thread_id,
        thread.project_id.as_deref(),
    )?;
    let now = sqlite_now(connection)?;
    let queued_payloads = super::queued_follow_up::thread_payloads(connection, thread_id)?;
    sync_linked_sessions_archived(connection, &session_ids, true, &now)?;
    connection.execute(
        "DELETE FROM codex_threads WHERE thread_id = ?1",
        [thread_id],
    )?;
    super::queued_follow_up::release_thread_payloads(connection, &queued_payloads, &now)?;
    let project_ids = thread.project_id.into_iter().collect::<Vec<_>>();
    let summary_scopes = project_session_scopes(&project_ids, &session_ids);
    finish_thread_mutation(
        connection,
        library_id,
        context,
        store_epoch,
        operation_id,
        request_hash,
        "delete_thread",
        summary_scopes,
        project_ids,
        session_ids,
        vec![thread_id.to_owned()],
    )
}

#[allow(clippy::too_many_arguments)]
pub(super) fn observe_app_server_thread_window(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    sweep_id: &str,
    thread_ids: &[String],
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    validate_id("sweep_id", sweep_id)?;
    if thread_ids.len() > MAX_APP_SERVER_SWEEP_WINDOW {
        return Err(invalid("App-server sweep window exceeds its Core bound"));
    }
    let unique = thread_ids.iter().collect::<BTreeSet<_>>();
    if unique.len() != thread_ids.len() {
        return Err(invalid(
            "App-server sweep window contains duplicate Threads",
        ));
    }
    let now = sqlite_now(connection)?;
    let mut require = connection.prepare(
        "SELECT count(*)
         FROM codex_threads thread
         LEFT JOIN projects project ON project.id = thread.project_id
         WHERE thread.thread_id = ?1
           AND thread.parent_thread_id IS NULL
           AND (thread.project_id IS NULL OR project.library_id = ?2)",
    )?;
    let mut observe = connection.prepare(
        "INSERT INTO workspace_app_server_thread_observations(
           thread_id, last_seen_sweep_id, updated_at
         ) VALUES (?1, ?2, ?3)
         ON CONFLICT(thread_id) DO UPDATE SET
           last_seen_sweep_id = excluded.last_seen_sweep_id,
           updated_at = excluded.updated_at",
    )?;
    for thread_id in thread_ids {
        validate_id("thread_id", thread_id)?;
        if require.query_row(params![thread_id, library_id], |row| row.get::<_, i64>(0))? != 1 {
            return Err(not_found(
                "App-server sweep Thread is unavailable in this Library",
            ));
        }
        observe.execute(params![thread_id, sweep_id, now])?;
    }
    finish_thread_mutation(
        connection,
        library_id,
        context,
        store_epoch,
        operation_id,
        request_hash,
        "observe_app_server_thread_window",
        Vec::new(),
        Vec::new(),
        Vec::new(),
        Vec::new(),
    )
}

#[allow(clippy::too_many_arguments)]
pub(super) fn reconcile_app_server_thread_sweep(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    sweep_id: &str,
    limit: Option<u32>,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    validate_id("sweep_id", sweep_id)?;
    let limit = usize::try_from(limit.unwrap_or(100))
        .map_err(|_| invalid("App-server sweep reconcile limit is invalid"))?;
    if limit == 0 || limit > MAX_APP_SERVER_SWEEP_WINDOW {
        return Err(invalid(
            "App-server sweep reconcile limit exceeds its Core bound",
        ));
    }
    let candidates = connection
        .prepare(
            "SELECT observation.thread_id, thread.project_id
             FROM workspace_app_server_thread_observations observation
             JOIN codex_threads thread ON thread.thread_id = observation.thread_id
             LEFT JOIN projects project ON project.id = thread.project_id
             WHERE observation.last_seen_sweep_id <> ?1
               AND (thread.project_id IS NULL OR project.library_id = ?2)
             ORDER BY observation.thread_id
             LIMIT ?3",
        )?
        .query_map(
            params![
                sweep_id,
                library_id,
                i64::try_from(limit)
                    .map_err(|_| invalid("App-server sweep reconcile limit is invalid"))?
            ],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut project_ids = BTreeSet::new();
    let mut session_ids = BTreeSet::new();
    let now = sqlite_now(connection)?;
    for (thread_id, project_id) in &candidates {
        let linked = linked_session_ids(connection, library_id, thread_id, project_id.as_deref())?;
        sync_linked_sessions_archived(connection, &linked, true, &now)?;
        session_ids.extend(linked);
        if let Some(project_id) = project_id {
            project_ids.insert(project_id.clone());
        }
        let queued_payloads = super::queued_follow_up::thread_payloads(connection, thread_id)?;
        let deleted = connection.execute(
            "DELETE FROM codex_threads WHERE thread_id = ?1",
            [thread_id],
        )?;
        if deleted != 1 {
            return Err(corrupt(
                "App-server sweep Thread disappeared during reconciliation",
            ));
        }
        super::queued_follow_up::release_thread_payloads(connection, &queued_payloads, &now)?;
    }
    let project_ids = project_ids.into_iter().collect::<Vec<_>>();
    let session_ids = session_ids.into_iter().collect::<Vec<_>>();
    let summary_scopes = project_session_scopes(&project_ids, &session_ids);
    finish_thread_mutation(
        connection,
        library_id,
        context,
        store_epoch,
        operation_id,
        request_hash,
        "reconcile_app_server_thread_sweep",
        summary_scopes,
        project_ids,
        session_ids,
        candidates
            .into_iter()
            .map(|(thread_id, _)| thread_id)
            .collect(),
    )
}

#[allow(clippy::too_many_arguments)]
pub(super) fn set_thread_archived(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    thread_id: &str,
    archived: bool,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    validate_id("thread_id", thread_id)?;
    let thread = require_thread(connection, library_id, thread_id)?;
    let session_ids = linked_session_ids(
        connection,
        library_id,
        thread_id,
        thread.project_id.as_deref(),
    )?;
    let now = sqlite_now(connection)?;
    let changed = connection.execute(
        "UPDATE codex_threads SET archived = ?1 WHERE thread_id = ?2",
        params![i64::from(archived), thread_id],
    )?;
    if changed != 1 {
        return Err(corrupt("Codex Thread disappeared during lifecycle update"));
    }
    if archived {
        connection.execute(
            "DELETE FROM codex_pinned_threads WHERE thread_id = ?1",
            [thread_id],
        )?;
        connection.execute(
            "DELETE FROM codex_unread_threads WHERE thread_id = ?1",
            [thread_id],
        )?;
    }
    sync_linked_sessions_archived(connection, &session_ids, archived, &now)?;
    let summary_scopes = if session_ids.is_empty() {
        Vec::new()
    } else {
        vec![project_session_scope(thread.project_id.as_deref())]
    };
    finish_thread_mutation(
        connection,
        library_id,
        context,
        store_epoch,
        operation_id,
        request_hash,
        if archived {
            "archive_thread"
        } else {
            "restore_thread"
        },
        summary_scopes,
        thread.project_id.into_iter().collect(),
        session_ids,
        vec![thread_id.to_owned()],
    )
}

fn sync_linked_sessions_archived(
    connection: &Connection,
    session_ids: &[String],
    archived: bool,
    now: &str,
) -> Result<(), StoreError> {
    for session_id in session_ids {
        let changed = if archived {
            connection.execute(
                "UPDATE project_sessions SET archived = 1, archived_at = ?1, pinned = 0, \
                   pinned_order = NULL, unread = 0, updated_at = ?1 WHERE id = ?2",
                params![now, session_id],
            )?
        } else {
            connection.execute(
                "UPDATE project_sessions SET archived = 0, archived_at = NULL, updated_at = ?1 \
                 WHERE id = ?2",
                params![now, session_id],
            )?
        };
        if changed != 1 {
            return Err(corrupt(
                "Linked Project Session disappeared during Thread lifecycle update",
            ));
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(super) fn set_thread_pinned(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    thread_id: &str,
    pinned: bool,
    placement: Option<&ProjectWorkspaceThreadPlacement>,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    validate_id("thread_id", thread_id)?;
    let thread = require_thread(connection, library_id, thread_id)?;
    if thread.parent_thread_id.is_some() {
        return Err(invalid(
            "Child Codex Threads cannot be pinned in the sidebar",
        ));
    }
    if !pinned && placement.is_some() {
        return Err(invalid(
            "An unpinned Codex Thread cannot have pin placement",
        ));
    }
    let session_ids = linked_session_ids(
        connection,
        library_id,
        thread_id,
        thread.project_id.as_deref(),
    )?;
    let now = sqlite_now(connection)?;
    if pinned {
        for session_id in &session_ids {
            connection.execute(
                "DELETE FROM workspace_sidebar_section_items WHERE session_id = ?1",
                [session_id],
            )?;
        }
        let next_order = connection.query_row(
            "SELECT COALESCE(max(pinned_order), -1) + 1 FROM codex_pinned_threads",
            [],
            |row| row.get::<_, i64>(0),
        )?;
        connection.execute(
            "INSERT OR IGNORE INTO codex_pinned_threads(\
               thread_id, pinned_order, created_at, updated_at\
             ) VALUES (?1, ?2, ?3, ?3)",
            params![thread_id, next_order, now],
        )?;
        if let Some(placement) = placement {
            place_pinned_thread(connection, library_id, thread_id, placement, &now)?;
        }
    } else {
        connection.execute(
            "DELETE FROM codex_pinned_threads WHERE thread_id = ?1",
            [thread_id],
        )?;
    }
    sync_linked_session_pin_mirrors(
        connection,
        &session_ids,
        thread.project_id.as_deref(),
        pinned,
        &now,
    )?;
    let summary_scopes = if session_ids.is_empty() {
        Vec::new()
    } else {
        vec![project_session_scope(thread.project_id.as_deref())]
    };
    finish_thread_mutation(
        connection,
        library_id,
        context,
        store_epoch,
        operation_id,
        request_hash,
        "set_thread_pinned",
        summary_scopes,
        thread.project_id.into_iter().collect(),
        session_ids,
        vec![thread_id.to_owned()],
    )
}

fn place_pinned_thread(
    connection: &Connection,
    library_id: &str,
    thread_id: &str,
    placement: &ProjectWorkspaceThreadPlacement,
    now: &str,
) -> Result<(), StoreError> {
    let current = pinned_threads(connection, library_id)?;
    let mut ordered = current
        .iter()
        .map(|thread| thread.thread_id.clone())
        .filter(|candidate| candidate != thread_id)
        .collect::<Vec<_>>();
    let insertion_index = match placement {
        ProjectWorkspaceThreadPlacement::Start => 0,
        ProjectWorkspaceThreadPlacement::End => ordered.len(),
        ProjectWorkspaceThreadPlacement::Before {
            thread_id: before_thread_id,
        } => {
            validate_id("before_thread_id", before_thread_id)?;
            ordered
                .iter()
                .position(|candidate| candidate == before_thread_id)
                .unwrap_or(ordered.len())
        }
        ProjectWorkspaceThreadPlacement::After {
            thread_id: after_thread_id,
        } => {
            validate_id("after_thread_id", after_thread_id)?;
            ordered
                .iter()
                .position(|candidate| candidate == after_thread_id)
                .map_or(ordered.len(), |index| index + 1)
        }
        ProjectWorkspaceThreadPlacement::Default => {
            return Err(invalid(
                "Pinned Codex Thread placement must be start, end, before, or after",
            ));
        }
    };
    ordered.insert(insertion_index, thread_id.to_owned());
    write_pinned_thread_order(connection, &ordered, now)
}

fn sync_linked_session_pin_mirrors(
    connection: &Connection,
    session_ids: &[String],
    project_id: Option<&str>,
    pinned: bool,
    now: &str,
) -> Result<(), StoreError> {
    for session_id in session_ids {
        let (was_pinned, existing_order) = connection.query_row(
            "SELECT pinned, pinned_order FROM project_sessions WHERE id = ?1",
            [session_id],
            |row| Ok((row.get::<_, i64>(0)? != 0, row.get::<_, Option<i64>>(1)?)),
        )?;
        let pinned_order = if pinned {
            if was_pinned && existing_order.is_some() {
                existing_order
            } else {
                Some(connection.query_row(
                    "SELECT COALESCE(max(pinned_order), -1) + 1 \
                             FROM project_sessions \
                             WHERE project_id IS ?1 AND pinned = 1 AND archived = 0",
                    [project_id],
                    |row| row.get::<_, i64>(0),
                )?)
            }
        } else {
            None
        };
        let changed = connection.execute(
            "UPDATE project_sessions SET pinned = ?1, pinned_order = ?2, updated_at = ?3 \
             WHERE id = ?4",
            params![i64::from(pinned), pinned_order, now, session_id],
        )?;
        if changed != 1 {
            return Err(corrupt(
                "Linked Project Session disappeared during Thread pin update",
            ));
        }
    }
    Ok(())
}

fn write_pinned_thread_order(
    connection: &Connection,
    ordered: &[String],
    now: &str,
) -> Result<(), StoreError> {
    let mut update = connection.prepare(
        "UPDATE codex_pinned_threads SET pinned_order = ?1, updated_at = ?2 \
         WHERE thread_id = ?3",
    )?;
    for (index, thread_id) in ordered.iter().enumerate() {
        update.execute(params![
            i64::try_from(index).expect("pinned Thread order fits i64"),
            now,
            thread_id,
        ])?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(super) fn reorder_pinned_threads(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    thread_ids: &[String],
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    if thread_ids.len() > MAX_THREADS {
        return Err(invalid("Pinned Codex Thread order exceeds its Core bound"));
    }
    let current = pinned_threads(connection, library_id)?;
    let current_ids = current
        .iter()
        .map(|thread| thread.thread_id.as_str())
        .collect::<BTreeSet<_>>();
    let mut seen = BTreeSet::new();
    let mut ordered = Vec::with_capacity(current.len());
    for thread_id in thread_ids {
        validate_id("thread_id", thread_id)?;
        if current_ids.contains(thread_id.as_str()) && seen.insert(thread_id.as_str()) {
            ordered.push(thread_id.clone());
        }
    }
    ordered.extend(
        current
            .iter()
            .map(|thread| &thread.thread_id)
            .filter(|thread_id| !seen.contains(thread_id.as_str()))
            .cloned(),
    );
    let now = sqlite_now(connection)?;
    write_pinned_thread_order(connection, &ordered, &now)?;
    let project_ids = current
        .iter()
        .filter_map(|thread| thread.project_id.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    finish_thread_mutation(
        connection,
        library_id,
        context,
        store_epoch,
        operation_id,
        request_hash,
        "reorder_pinned_threads",
        Vec::new(),
        project_ids,
        Vec::new(),
        ordered,
    )
}

#[allow(clippy::too_many_arguments)]
pub(super) fn set_thread_unread(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    thread_id: &str,
    unread: bool,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    validate_id("thread_id", thread_id)?;
    let thread = require_thread(connection, library_id, thread_id)?;
    if unread && thread.archived {
        return Err(invalid("An archived Codex Thread cannot be marked unread"));
    }
    let session_ids = linked_session_ids(
        connection,
        library_id,
        thread_id,
        thread.project_id.as_deref(),
    )?;
    if unread {
        connection.execute(
            "INSERT OR IGNORE INTO codex_unread_threads(thread_id) VALUES (?1)",
            [thread_id],
        )?;
    } else {
        connection.execute(
            "DELETE FROM codex_unread_threads WHERE thread_id = ?1",
            [thread_id],
        )?;
    }
    let now = sqlite_now(connection)?;
    for session_id in &session_ids {
        let changed = connection.execute(
            "UPDATE project_sessions SET unread = ?1, updated_at = ?2 WHERE id = ?3",
            params![i64::from(unread), now, session_id],
        )?;
        if changed != 1 {
            return Err(corrupt(
                "Linked Project Session disappeared during Thread unread update",
            ));
        }
    }
    let summary_scopes = if session_ids.is_empty() {
        Vec::new()
    } else {
        vec![project_session_scope(thread.project_id.as_deref())]
    };
    finish_thread_mutation(
        connection,
        library_id,
        context,
        store_epoch,
        operation_id,
        request_hash,
        "set_thread_unread",
        summary_scopes,
        thread.project_id.into_iter().collect(),
        session_ids,
        vec![thread_id.to_owned()],
    )
}

#[allow(clippy::too_many_arguments)]
pub(super) fn replace_dynamic_tool_catalogs(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    thread_id: &str,
    catalogs: &[ProjectWorkspaceDynamicToolCatalog],
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    validate_id("thread_id", thread_id)?;
    let thread = require_thread(connection, library_id, thread_id)?;
    let catalogs = normalize_catalogs(catalogs)?;
    connection.execute(
        "DELETE FROM codex_thread_dynamic_tool_catalogs WHERE thread_id = ?1",
        [thread_id],
    )?;
    let mut insert = connection.prepare(
        "INSERT INTO codex_thread_dynamic_tool_catalogs(\
           thread_id, namespace, toolset_revision\
         ) VALUES (?1, ?2, ?3)",
    )?;
    for catalog in catalogs {
        insert.execute(params![
            thread_id,
            catalog.namespace,
            catalog.toolset_revision,
        ])?;
    }
    finish_thread_mutation(
        connection,
        library_id,
        context,
        store_epoch,
        operation_id,
        request_hash,
        "replace_thread_dynamic_tool_catalogs",
        Vec::new(),
        thread.project_id.into_iter().collect(),
        Vec::new(),
        vec![thread_id.to_owned()],
    )
}

#[allow(clippy::too_many_arguments)]
pub(super) fn set_project_permission_mode(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    project_id: &str,
    mode: CodexPermissionMode,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    validate_id("project_id", project_id)?;
    require_project(connection, library_id, project_id)?;
    let now = sqlite_now(connection)?;
    connection.execute(
        "INSERT INTO codex_project_permission_mode_selections(project_id, mode, updated_at) \
         VALUES (?1, ?2, ?3) \
         ON CONFLICT(project_id) DO UPDATE SET \
           mode = excluded.mode, updated_at = excluded.updated_at",
        params![project_id, permission_mode_literal(mode), now],
    )?;
    finish_thread_mutation(
        connection,
        library_id,
        context,
        store_epoch,
        operation_id,
        request_hash,
        "set_project_permission_mode",
        Vec::new(),
        vec![project_id.to_owned()],
        Vec::new(),
        Vec::new(),
    )
}

#[allow(clippy::too_many_arguments)]
pub(super) fn set_projectless_permission_mode(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    mode: CodexPermissionMode,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    let now = sqlite_now(connection)?;
    connection.execute(
        "INSERT INTO codex_projectless_permission_mode_selection(id, mode, updated_at) \
         VALUES (1, ?1, ?2) \
         ON CONFLICT(id) DO UPDATE SET \
           mode = excluded.mode, updated_at = excluded.updated_at",
        params![permission_mode_literal(mode), now],
    )?;
    finish_thread_mutation(
        connection,
        library_id,
        context,
        store_epoch,
        operation_id,
        request_hash,
        "set_projectless_permission_mode",
        Vec::new(),
        Vec::new(),
        Vec::new(),
        Vec::new(),
    )
}

fn project_workspace_thread(
    connection: &Connection,
    library_id: &str,
    row: ThreadRow,
) -> Result<ProjectWorkspaceThread, StoreError> {
    validate_stored_thread(&row)?;
    let status = thread_status(&row)?;
    let session_ids = linked_session_ids(
        connection,
        library_id,
        &row.thread_id,
        row.project_id.as_deref(),
    )?;
    if session_ids.len() > 1 {
        return Err(corrupt(
            "A Codex Thread is linked to multiple Project Sessions",
        ));
    }
    let dynamic_tool_catalogs = read_dynamic_tool_catalogs(connection, &row.thread_id)?;
    let writable_roots = read_writable_roots(connection, &row.thread_id)?;
    Ok(ProjectWorkspaceThread {
        thread_id: row.thread_id,
        project_id: row.project_id,
        session_id: session_ids.into_iter().next(),
        forked_from_id: row.forked_from_id,
        parent_thread_id: row.parent_thread_id,
        thread_name: row.thread_name,
        thread_source: row.thread_source,
        service_name: row.service_name,
        agent_nickname: row.agent_nickname,
        agent_role: row.agent_role,
        agent_path: row.agent_path,
        thread_preview: row.thread_preview,
        model_id: row.model_id,
        reasoning_effort: row.reasoning_effort,
        service_tier: row.service_tier,
        backend_binding: row.backend_binding,
        execution_host_id: row.execution_host_id,
        cwd: row.cwd,
        managed_worktree_path: row.managed_worktree_path,
        projectless_output_directory: row.projectless_output_directory,
        projectless_workspace_browser_root: row.projectless_workspace_browser_root,
        status,
        archived: row.archived == 1,
        pinned_order: row.pinned_order,
        has_unread_turn: row.has_unread_turn == 1,
        dynamic_tool_catalogs,
        writable_roots,
        created_at: row.created_at,
        updated_at: row.updated_at,
        recency_at: row.recency_at,
        linked_at: row.linked_at,
    })
}

fn thread_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ThreadRow> {
    Ok(ThreadRow {
        thread_id: row.get(0)?,
        project_id: row.get(1)?,
        forked_from_id: row.get(2)?,
        parent_thread_id: row.get(3)?,
        thread_name: row.get(4)?,
        thread_source: row.get(5)?,
        service_name: row.get(6)?,
        agent_nickname: row.get(7)?,
        agent_role: row.get(8)?,
        agent_path: row.get(9)?,
        thread_preview: row.get(10)?,
        model_id: row.get(11)?,
        reasoning_effort: row.get(12)?,
        service_tier: row.get(13)?,
        backend_binding: binding_from_storage(
            row.get::<_, String>(14)?.as_str(),
            row.get(15)?,
            row.get(16)?,
        )
        .map_err(|_| rusqlite::Error::InvalidQuery)?,
        execution_host_id: row.get(17)?,
        cwd: row.get(18)?,
        managed_worktree_path: row.get(19)?,
        projectless_output_directory: row.get(20)?,
        projectless_workspace_browser_root: row.get(21)?,
        status_type: row.get(22)?,
        status_active_flags_json: row.get(23)?,
        archived: row.get(24)?,
        pinned_order: row.get(25)?,
        has_unread_turn: row.get(26)?,
        created_at: row.get(27)?,
        updated_at: row.get(28)?,
        recency_at: row.get(29)?,
        linked_at: row.get(30)?,
    })
}

fn read_stored_thread(
    connection: &Connection,
    thread_id: &str,
) -> Result<Option<ThreadRow>, StoreError> {
    let sql = format!(
        "SELECT {THREAD_COLUMNS} \
         FROM codex_threads thread \
         LEFT JOIN codex_pinned_threads pinned ON pinned.thread_id = thread.thread_id \
         LEFT JOIN codex_unread_threads unread ON unread.thread_id = thread.thread_id \
         WHERE thread.thread_id = ?1"
    );
    connection
        .query_row(&sql, [thread_id], thread_row)
        .optional()
        .map_err(Into::into)
}

fn require_thread(
    connection: &Connection,
    library_id: &str,
    thread_id: &str,
) -> Result<ProjectWorkspaceThread, StoreError> {
    let thread = read_thread(connection, library_id, thread_id)?
        .ok_or_else(|| not_found("Codex Thread is unavailable in this Library"))?;
    assert_project_visible(connection, library_id, thread.project_id.as_deref())?;
    Ok(thread)
}

fn pinned_threads(
    connection: &Connection,
    library_id: &str,
) -> Result<Vec<ProjectWorkspaceThread>, StoreError> {
    let sql = format!(
        "SELECT {THREAD_COLUMNS} \
         FROM codex_threads thread \
         JOIN codex_pinned_threads pinned ON pinned.thread_id = thread.thread_id \
         LEFT JOIN codex_unread_threads unread ON unread.thread_id = thread.thread_id \
         WHERE thread.archived = 0 AND thread.parent_thread_id IS NULL \
           AND (thread.project_id IS NULL OR EXISTS (\
             SELECT 1 FROM projects project \
             WHERE project.id = thread.project_id AND project.library_id = ?1 \
               AND project.lifecycle <> 'archived'\
           )) \
         ORDER BY pinned.pinned_order, pinned.created_at, thread.thread_id \
         LIMIT ?2"
    );
    let rows = connection
        .prepare(&sql)?
        .query_map(
            params![
                library_id,
                i64::try_from(MAX_THREADS + 1).expect("thread bound fits i64"),
            ],
            thread_row,
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if rows.len() > MAX_THREADS {
        return Err(corrupt(
            "Pinned Codex Thread collection exceeds its Core bound",
        ));
    }
    rows.into_iter()
        .map(|row| project_workspace_thread(connection, library_id, row))
        .collect()
}

fn linked_session_ids(
    connection: &Connection,
    library_id: &str,
    thread_id: &str,
    thread_project_id: Option<&str>,
) -> Result<Vec<String>, StoreError> {
    let rows = connection
        .prepare(
            "SELECT session.id, session.project_id, project.library_id \
             FROM project_session_threads link \
             JOIN project_sessions session ON session.id = link.session_id \
             LEFT JOIN projects project ON project.id = session.project_id \
             WHERE link.thread_id = ?1 \
             ORDER BY link.linked_at, session.id LIMIT 2",
        )?
        .query_map([thread_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut ids = Vec::with_capacity(rows.len());
    for (session_id, project_id, owner_library_id) in rows {
        if project_id.as_deref() != thread_project_id {
            return Err(corrupt(
                "A linked Codex Thread and Project Session have different Projects",
            ));
        }
        if project_id.is_some() && owner_library_id.as_deref() != Some(library_id) {
            return Err(corrupt(
                "A linked Codex Thread Session belongs to another Library",
            ));
        }
        ids.push(session_id);
    }
    Ok(ids)
}

fn assert_linked_session_project(
    connection: &Connection,
    library_id: &str,
    thread_id: &str,
    project_id: Option<&str>,
) -> Result<(), StoreError> {
    let rows = connection
        .prepare(
            "SELECT session.project_id, project.library_id \
             FROM project_session_threads link \
             JOIN project_sessions session ON session.id = link.session_id \
             LEFT JOIN projects project ON project.id = session.project_id \
             WHERE link.thread_id = ?1 LIMIT 2",
        )?
        .query_map([thread_id], |row| {
            Ok((
                row.get::<_, Option<String>>(0)?,
                row.get::<_, Option<String>>(1)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if rows.len() > 1 {
        return Err(corrupt(
            "A Codex Thread is linked to multiple Project Sessions",
        ));
    }
    let Some((session_project_id, owner_library_id)) = rows.into_iter().next() else {
        return Ok(());
    };
    if session_project_id.as_deref() != project_id {
        return Err(invalid(
            "Codex Thread Project must match its linked Project Session",
        ));
    }
    if session_project_id.is_some() && owner_library_id.as_deref() != Some(library_id) {
        return Err(corrupt(
            "A linked Codex Thread Session belongs to another Library",
        ));
    }
    Ok(())
}

fn read_dynamic_tool_catalogs(
    connection: &Connection,
    thread_id: &str,
) -> Result<Vec<ProjectWorkspaceDynamicToolCatalog>, StoreError> {
    let catalogs = connection
        .prepare(
            "SELECT namespace, toolset_revision \
             FROM codex_thread_dynamic_tool_catalogs \
             WHERE thread_id = ?1 ORDER BY namespace LIMIT ?2",
        )?
        .query_map(
            params![
                thread_id,
                i64::try_from(MAX_CATALOGS + 1).expect("catalog bound fits i64"),
            ],
            |row| {
                Ok(ProjectWorkspaceDynamicToolCatalog {
                    namespace: row.get(0)?,
                    toolset_revision: row.get(1)?,
                })
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if catalogs.len() > MAX_CATALOGS {
        return Err(corrupt(
            "Stored Codex Thread dynamic tool catalogs exceed their Core bound",
        ));
    }
    normalize_catalogs(&catalogs).map_err(|error| {
        corrupt(format!(
            "Stored Codex Thread dynamic tool catalog is invalid: {}",
            error.message
        ))
    })
}

fn normalize_catalogs(
    catalogs: &[ProjectWorkspaceDynamicToolCatalog],
) -> Result<Vec<ProjectWorkspaceDynamicToolCatalog>, StoreError> {
    if catalogs.len() > MAX_CATALOGS {
        return Err(invalid("A Codex Thread has too many dynamic tool catalogs"));
    }
    let mut namespaces = BTreeSet::new();
    let mut normalized = Vec::with_capacity(catalogs.len());
    for catalog in catalogs {
        let namespace = catalog.namespace.trim();
        if namespace.is_empty() || namespace.len() > MAX_CATALOG_NAMESPACE_BYTES {
            return Err(invalid("Dynamic tool namespace is invalid"));
        }
        if !namespaces.insert(namespace.to_owned()) {
            return Err(invalid(
                "A Codex Thread cannot bind multiple revisions of one dynamic tool namespace",
            ));
        }
        if !(1..=MAX_SAFE_INTEGER).contains(&catalog.toolset_revision) {
            return Err(invalid(
                "Dynamic tool revision must be a positive safe integer",
            ));
        }
        normalized.push(ProjectWorkspaceDynamicToolCatalog {
            namespace: namespace.to_owned(),
            toolset_revision: catalog.toolset_revision,
        });
    }
    normalized.sort_by(|left, right| left.namespace.cmp(&right.namespace));
    Ok(normalized)
}

fn validate_stored_thread(row: &ThreadRow) -> Result<(), StoreError> {
    validate_stored_id("thread_id", &row.thread_id)?;
    if let Some(project_id) = row.project_id.as_deref() {
        validate_stored_id("project_id", project_id)?;
    }
    for (field, value) in [
        ("forked_from_id", row.forked_from_id.as_deref()),
        ("parent_thread_id", row.parent_thread_id.as_deref()),
    ] {
        if let Some(value) = value {
            validate_stored_id(field, value)?;
        }
    }
    for (field, value, bound) in [
        (
            "thread_name",
            row.thread_name.as_deref(),
            MAX_SHORT_TEXT_BYTES,
        ),
        (
            "thread_source",
            row.thread_source.as_deref(),
            MAX_SHORT_TEXT_BYTES,
        ),
        (
            "service_name",
            row.service_name.as_deref(),
            MAX_SHORT_TEXT_BYTES,
        ),
        (
            "agent_nickname",
            row.agent_nickname.as_deref(),
            MAX_SHORT_TEXT_BYTES,
        ),
        (
            "agent_role",
            row.agent_role.as_deref(),
            MAX_SHORT_TEXT_BYTES,
        ),
        ("agent_path", row.agent_path.as_deref(), MAX_PATH_BYTES),
        ("model_id", row.model_id.as_deref(), MAX_SHORT_TEXT_BYTES),
        (
            "reasoning_effort",
            row.reasoning_effort.as_deref(),
            MAX_REASONING_EFFORT_BYTES,
        ),
        (
            "service_tier",
            row.service_tier.as_deref(),
            MAX_REASONING_EFFORT_BYTES,
        ),
        (
            "execution_host_id",
            Some(row.execution_host_id.as_str()),
            MAX_ID_BYTES,
        ),
        ("cwd", row.cwd.as_deref(), MAX_PATH_BYTES),
        (
            "managed_worktree_path",
            row.managed_worktree_path.as_deref(),
            MAX_PATH_BYTES,
        ),
        (
            "projectless_output_directory",
            row.projectless_output_directory.as_deref(),
            MAX_PATH_BYTES,
        ),
        (
            "projectless_workspace_browser_root",
            row.projectless_workspace_browser_root.as_deref(),
            MAX_PATH_BYTES,
        ),
    ] {
        if let Some(value) = value {
            validate_stored_text(field, value, bound)?;
        }
    }
    validate_stored_text("thread_preview", &row.thread_preview, MAX_PREVIEW_BYTES)?;
    if row
        .thread_name
        .as_deref()
        .is_some_and(|name| name.encode_utf16().count() > MAX_THREAD_NAME_UTF16)
    {
        return Err(corrupt(
            "Codex Thread thread_name exceeds 2,000 UTF-16 code units",
        ));
    }
    if row.status_active_flags_json.len() > 256 {
        return Err(corrupt("Codex Thread active flags exceed their Core bound"));
    }
    if row.archived != 0 && row.archived != 1 {
        return Err(corrupt("Codex Thread archive state is invalid"));
    }
    if row.has_unread_turn != 0 && row.has_unread_turn != 1 {
        return Err(corrupt("Codex Thread unread state is invalid"));
    }
    if row.archived == 1 && row.has_unread_turn == 1 {
        return Err(corrupt("An archived Codex Thread is marked unread"));
    }
    if row.pinned_order.is_some_and(|order| order < 0) {
        return Err(corrupt("Codex Thread pinned order is invalid"));
    }
    validate_stored_timestamp("created_at", row.created_at)?;
    validate_stored_timestamp("updated_at", row.updated_at)?;
    validate_stored_timestamp("recency_at", row.recency_at)?;
    if row.updated_at < row.created_at {
        return Err(corrupt("Codex Thread update time precedes creation"));
    }
    if row.recency_at < row.created_at {
        return Err(corrupt("Codex Thread recency precedes creation"));
    }
    if row.linked_at.trim().is_empty() || row.linked_at.len() > 128 {
        return Err(corrupt("Codex Thread link time is invalid"));
    }
    Ok(())
}

fn thread_status(row: &ThreadRow) -> Result<ProjectWorkspaceThreadStatus, StoreError> {
    decode_thread_status(&row.status_type, &row.status_active_flags_json)
}

pub(super) fn decode_thread_status(
    status_type: &str,
    active_flags_json: &str,
) -> Result<ProjectWorkspaceThreadStatus, StoreError> {
    let status_type = parse_status_type(status_type)?;
    let active_flags = serde_json::from_str::<Vec<CodexThreadActiveFlag>>(active_flags_json)
        .map_err(|_| corrupt("Codex Thread active flags are invalid"))?;
    validate_status(ProjectWorkspaceThreadStatus {
        status_type,
        active_flags,
    })
    .map_err(|error| corrupt(error.message))
}

fn validate_status(
    status: ProjectWorkspaceThreadStatus,
) -> Result<ProjectWorkspaceThreadStatus, StoreError> {
    if status.active_flags.len() > 2 {
        return Err(invalid(
            "Codex Thread active flags exceed their protocol bound",
        ));
    }
    let unique = status.active_flags.iter().copied().collect::<BTreeSet<_>>();
    if unique.len() != status.active_flags.len() {
        return Err(invalid("Codex Thread active flags must be unique"));
    }
    if status.status_type != CodexThreadStatusType::Active && !status.active_flags.is_empty() {
        return Err(invalid(
            "Only an active Codex Thread may carry active status flags",
        ));
    }
    Ok(status)
}

fn parse_status_type(value: &str) -> Result<CodexThreadStatusType, StoreError> {
    match value {
        "notLoaded" => Ok(CodexThreadStatusType::NotLoaded),
        "idle" => Ok(CodexThreadStatusType::Idle),
        "systemError" => Ok(CodexThreadStatusType::SystemError),
        "active" => Ok(CodexThreadStatusType::Active),
        _ => Err(corrupt("Codex Thread status type is invalid")),
    }
}

fn status_type_literal(value: CodexThreadStatusType) -> &'static str {
    match value {
        CodexThreadStatusType::NotLoaded => "notLoaded",
        CodexThreadStatusType::Idle => "idle",
        CodexThreadStatusType::SystemError => "systemError",
        CodexThreadStatusType::Active => "active",
    }
}

fn parse_permission_mode(value: &str) -> Result<CodexPermissionMode, StoreError> {
    match value {
        "auto" => Ok(CodexPermissionMode::Auto),
        "guardian-approvals" => Ok(CodexPermissionMode::GuardianApprovals),
        "full-access" => Ok(CodexPermissionMode::FullAccess),
        "custom" => Ok(CodexPermissionMode::Custom),
        _ => Err(corrupt("Codex Project permission mode is invalid")),
    }
}

fn permission_mode_literal(value: CodexPermissionMode) -> &'static str {
    match value {
        CodexPermissionMode::Auto => "auto",
        CodexPermissionMode::GuardianApprovals => "guardian-approvals",
        CodexPermissionMode::FullAccess => "full-access",
        CodexPermissionMode::Custom => "custom",
    }
}

fn merge_identity(
    current: Option<String>,
    patch: &Option<Option<String>>,
    field: &str,
) -> Result<Option<String>, StoreError> {
    let Some(value) = patch else {
        return Ok(current);
    };
    let Some(value) = value else {
        return Ok(None);
    };
    validate_id(field, value)?;
    Ok(Some(value.clone()))
}

fn merge_nullable_text(
    current: Option<String>,
    patch: &Option<Option<String>>,
    field: &str,
    max_bytes: usize,
    trim: bool,
) -> Result<Option<String>, StoreError> {
    let Some(value) = patch else {
        return Ok(current);
    };
    let Some(value) = value else {
        return Ok(None);
    };
    let value = if trim { value.trim() } else { value.as_str() };
    if value.is_empty() {
        return Ok(None);
    }
    validate_text(field, value, max_bytes)?;
    Ok(Some(value.to_owned()))
}

fn merge_required_text(
    current: Option<&str>,
    patch: Option<&str>,
    field: &str,
    max_bytes: usize,
    trim: bool,
) -> Result<String, StoreError> {
    let value = patch.or(current).unwrap_or_default();
    let value = if trim { value.trim() } else { value };
    validate_text(field, value, max_bytes)?;
    Ok(value.to_owned())
}

fn validate_text(field: &str, value: &str, max_bytes: usize) -> Result<(), StoreError> {
    if value.len() <= max_bytes && !value.contains('\0') {
        return Ok(());
    }
    Err(invalid(format!(
        "{field} must contain at most {max_bytes} bytes and no NUL"
    )))
}

fn validate_linked_at(value: &str) -> Result<String, StoreError> {
    let value = value.trim();
    if !value.is_empty() && value.len() <= 128 && !value.chars().any(char::is_control) {
        return Ok(value.to_owned());
    }
    Err(invalid("linked_at must be a bounded timestamp string"))
}

fn validate_timestamp(field: &str, value: i64) -> Result<(), StoreError> {
    if (0..=MAX_SAFE_INTEGER).contains(&value) {
        return Ok(());
    }
    Err(invalid(format!(
        "{field} must be a non-negative safe integer"
    )))
}

fn validate_stored_timestamp(field: &str, value: i64) -> Result<(), StoreError> {
    validate_timestamp(field, value)
        .map_err(|_| corrupt(format!("Codex Thread {field} is invalid")))
}

fn validate_id(field: &str, value: &str) -> Result<(), StoreError> {
    if !value.is_empty()
        && value == value.trim()
        && value.len() <= MAX_ID_BYTES
        && !value.chars().any(char::is_control)
    {
        return Ok(());
    }
    Err(invalid(format!(
        "{field} must be a canonical identity of at most {MAX_ID_BYTES} bytes"
    )))
}

fn validate_stored_id(field: &str, value: &str) -> Result<(), StoreError> {
    validate_id(field, value).map_err(|_| corrupt(format!("Codex Thread {field} is invalid")))
}

fn validate_stored_text(field: &str, value: &str, max_bytes: usize) -> Result<(), StoreError> {
    validate_text(field, value, max_bytes)
        .map_err(|_| corrupt(format!("Codex Thread {field} is invalid")))
}

fn require_project(
    connection: &Connection,
    library_id: &str,
    project_id: &str,
) -> Result<(), StoreError> {
    if connection
        .query_row(
            "SELECT 1 FROM projects \
             WHERE id = ?1 AND library_id = ?2 AND lifecycle = 'active'",
            params![project_id, library_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some()
    {
        return Ok(());
    }
    Err(not_found("Project is unavailable in this Library"))
}

#[cfg(test)]
fn require_known_project(
    connection: &Connection,
    library_id: &str,
    project_id: &str,
) -> Result<(), StoreError> {
    if connection
        .query_row(
            "SELECT 1 FROM projects WHERE id = ?1 AND library_id = ?2",
            params![project_id, library_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some()
    {
        return Ok(());
    }
    Err(not_found("Project is unavailable in this Library"))
}

fn assert_project_visible(
    connection: &Connection,
    library_id: &str,
    project_id: Option<&str>,
) -> Result<(), StoreError> {
    project_id.map_or(Ok(()), |project_id| {
        require_project(connection, library_id, project_id)
    })
}

fn affected_projects(previous: Option<&str>, next: Option<&str>) -> Vec<String> {
    [previous, next]
        .into_iter()
        .flatten()
        .map(str::to_owned)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn project_session_scopes(
    project_ids: &[String],
    session_ids: &[String],
) -> Vec<nodex_core_contracts::workspace::ProjectSessionInvalidationScope> {
    if session_ids.is_empty() {
        return Vec::new();
    }
    if project_ids.is_empty() {
        return vec![project_session_scope(None)];
    }
    project_ids
        .iter()
        .map(|project_id| project_session_scope(Some(project_id)))
        .collect()
}

#[allow(clippy::too_many_arguments)]
pub(super) fn finish_thread_mutation(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    operation_kind: &'static str,
    session_summary_scopes: Vec<nodex_core_contracts::workspace::ProjectSessionInvalidationScope>,
    project_ids: Vec<String>,
    session_ids: Vec<String>,
    thread_ids: Vec<String>,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    finish_thread_mutation_with_optional_project_catalog_change(
        connection,
        library_id,
        context,
        store_epoch,
        operation_id,
        request_hash,
        operation_kind,
        None,
        session_summary_scopes,
        project_ids,
        session_ids,
        thread_ids,
    )
}

#[allow(clippy::too_many_arguments)]
pub(super) fn apply_thread_mutation(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    operation_kind: &'static str,
    project_catalog_change: Option<nodex_core_contracts::workspace::ProjectCatalogChangeKind>,
    session_summary_scopes: Vec<nodex_core_contracts::workspace::ProjectSessionInvalidationScope>,
    project_ids: Vec<String>,
    session_ids: Vec<String>,
    thread_ids: Vec<String>,
    apply: impl FnOnce() -> Result<(), StoreError>,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    let committed_at = sqlite_now(connection)?;
    let effects = thread_mutation_effects(
        connection,
        library_id,
        operation_kind,
        project_catalog_change,
        session_summary_scopes,
        project_ids,
        session_ids,
        thread_ids,
        committed_at.clone(),
    )?;
    run_mutation(
        connection,
        context,
        store_epoch,
        operation_id,
        request_hash,
        &committed_at,
        |_| {
            apply()?;
            Ok(effects)
        },
    )
}

#[allow(clippy::too_many_arguments)]
fn finish_thread_mutation_with_optional_project_catalog_change(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    operation_kind: &'static str,
    project_catalog_change: Option<nodex_core_contracts::workspace::ProjectCatalogChangeKind>,
    session_summary_scopes: Vec<nodex_core_contracts::workspace::ProjectSessionInvalidationScope>,
    project_ids: Vec<String>,
    session_ids: Vec<String>,
    thread_ids: Vec<String>,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    let effects = thread_mutation_effects(
        connection,
        library_id,
        operation_kind,
        project_catalog_change,
        session_summary_scopes,
        project_ids,
        session_ids,
        thread_ids,
        sqlite_now(connection)?,
    )?;
    finish_mutation(
        connection,
        context,
        store_epoch,
        operation_id,
        request_hash,
        effects,
    )
}

#[allow(clippy::too_many_arguments)]
fn thread_mutation_effects(
    connection: &Connection,
    library_id: &str,
    operation_kind: &'static str,
    project_catalog_change: Option<nodex_core_contracts::workspace::ProjectCatalogChangeKind>,
    session_summary_scopes: Vec<nodex_core_contracts::workspace::ProjectSessionInvalidationScope>,
    project_ids: Vec<String>,
    session_ids: Vec<String>,
    thread_ids: Vec<String>,
    committed_at: String,
) -> Result<WorkspaceMutationEffects, StoreError> {
    let session_detail_ids = if session_summary_scopes.is_empty() {
        Vec::new()
    } else {
        session_ids.clone()
    };
    let change_project_id = project_ids
        .first()
        .cloned()
        .map_or_else(|| workspace_event_anchor(connection, library_id), Ok)?;
    Ok(WorkspaceMutationEffects {
        operation_kind,
        project_catalog_change,
        change_project_id,
        project_ids,
        session_detail_ids,
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
        committed_at,
        queued_follow_up_ledger: None,
    })
}

fn unix_time_millis() -> Result<i64, StoreError> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| internal("System clock precedes the Unix epoch"))?
        .as_millis();
    i64::try_from(millis).map_err(|_| internal("System timestamp exceeds SQLite integer range"))
}

fn invalid(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message.into(), false)
}

fn conflict(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::Conflict, message.into(), true)
}

fn not_found(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::NotFound, message.into(), false)
}

fn corrupt(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message.into(), false)
}

fn internal(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::Internal, message.into(), false)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use nodex_core_contracts::agent::AgentBackendBinding;
    use nodex_core_contracts::collection::CollectionWindowRequest;
    use nodex_core_contracts::workspace::{
        CodexPermissionMode, CodexThreadActiveFlag, CodexThreadStatusType, ProjectSessionIntent,
        ProjectWorkspaceBackgroundProcess, ProjectWorkspaceBackgroundProcessSource,
        ProjectWorkspaceDynamicToolCatalog, ProjectWorkspaceIntent, ProjectWorkspaceRead,
        ProjectWorkspaceReadValue, ProjectWorkspaceThreadExecutionLocation,
        ProjectWorkspaceThreadPatch, ProjectWorkspaceThreadPlacement, ProjectWorkspaceThreadStatus,
        ProjectWorkspaceTurnAuthorityScope, ProjectWorkspaceTurnAuthoritySource,
        ProjectWorkspaceTurnCoordinate,
    };
    use nodex_core_contracts::{
        AdapterKind, BoundModuleContext, CoreErrorCode, LibraryId, ModuleApplyRequest,
        ModuleReadRequest, PROJECT_WORKSPACE_CONTRACT_VERSION, ProfileId, ProjectId, StoreEpoch,
    };
    use tempfile::{TempDir, tempdir};

    use crate::infrastructure::sqlite::with_immediate_transaction;
    use crate::infrastructure::store::SqliteStoreKernel;
    use crate::workspace::ProjectWorkspaceModule;

    const NOW: &str = "2026-07-19T06:00:00.000Z";

    fn context() -> BoundModuleContext {
        BoundModuleContext {
            profile_id: ProfileId("profile-1".to_owned()),
            library_id: LibraryId("library-1".to_owned()),
            project_id: Some(ProjectId("project:default".to_owned())),
            connection_id: "connection:workspace-thread".to_owned(),
            adapter: AdapterKind::Test,
        }
    }

    fn seeded_module() -> (TempDir, SqliteStoreKernel, ProjectWorkspaceModule) {
        let directory = tempdir().expect("Profile");
        let home = directory.path().canonicalize().expect("absolute Profile");
        fs::create_dir(home.join("assets")).expect("assets root");
        let kernel = SqliteStoreKernel::open_test(&home).expect("fresh store");
        kernel
            .writer()
            .call(|connection| {
                with_immediate_transaction(connection, |transaction| {
                    transaction.execute(
                        "INSERT INTO profiles(id, created_at, updated_at) \
                         VALUES ('profile-1', ?1, ?1)",
                        [NOW],
                    )?;
                    transaction.execute(
                        "INSERT INTO libraries(id, profile_id, created_at, updated_at) \
                         VALUES ('library-1', 'profile-1', ?1, ?1)",
                        [NOW],
                    )?;
                    transaction.execute(
                        "INSERT INTO block_store_metadata(id, store_epoch, created_at, updated_at) \
                         VALUES (1, 'epoch-1', ?1, ?1)",
                        [NOW],
                    )?;
                    Ok(())
                })
            })
            .expect("seed Workspace identity");
        let module = ProjectWorkspaceModule::new("profile-1", "library-1", &kernel)
            .expect("Workspace module");
        module.seed_rootless_default_project_for_test();
        (directory, kernel, module)
    }

    fn request(
        operation_id: &str,
        intent: ProjectWorkspaceIntent,
    ) -> ModuleApplyRequest<ProjectWorkspaceIntent> {
        ModuleApplyRequest {
            contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
            operation_id: operation_id.to_owned(),
            store_epoch: StoreEpoch("epoch-1".to_owned()),
            intent,
        }
    }

    fn read(
        module: &ProjectWorkspaceModule,
        read: ProjectWorkspaceRead,
    ) -> ProjectWorkspaceReadValue {
        module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                    read,
                },
            )
            .expect("Workspace read")
            .value
    }

    fn create_thread(
        module: &ProjectWorkspaceModule,
        operation_id: &str,
        thread_id: &str,
        project_id: Option<&str>,
        parent_thread_id: Option<&str>,
    ) {
        module
            .apply(
                &context(),
                request(
                    operation_id,
                    ProjectWorkspaceIntent::UpsertThread {
                        thread_id: thread_id.to_owned(),
                        patch: Box::new(ProjectWorkspaceThreadPatch {
                            project_id: Some(project_id.map(str::to_owned)),
                            parent_thread_id: parent_thread_id.map(str::to_owned).map(Some),
                            thread_name: Some(Some(thread_id.to_owned())),
                            created_at: Some(100),
                            updated_at: Some(100),
                            linked_at: Some(NOW.to_owned()),
                            ..ProjectWorkspaceThreadPatch::default()
                        }),
                    },
                ),
            )
            .expect("create Thread");
    }

    fn create_session(module: &ProjectWorkspaceModule, operation_id: &str, session_id: &str) {
        module
            .apply(
                &context(),
                request(
                    operation_id,
                    ProjectWorkspaceIntent::CreateSession {
                        session_id: session_id.to_owned(),
                        project_id: Some("project:default".to_owned()),
                        title: "New chat".to_owned(),
                        initial_page_ids: Vec::new(),
                    },
                ),
            )
            .expect("create Session");
    }

    #[test]
    fn persists_backend_binding_and_acp_session_identity_across_restart() {
        let (directory, kernel, module) = seeded_module();
        create_thread(
            &module,
            "thread-backend-create",
            "thread-backend",
            Some("project:default"),
            None,
        );
        let ProjectWorkspaceReadValue::Thread { thread } = read(
            &module,
            ProjectWorkspaceRead::Thread {
                thread_id: "thread-backend".to_owned(),
            },
        ) else {
            panic!("Thread read");
        };
        assert_eq!(thread.backend_binding, AgentBackendBinding::Codex);

        let acp_binding = AgentBackendBinding::Acp {
            agent_definition_id: "claude-agent-acp".to_owned(),
            instance_config_id: Some("claude-work".to_owned()),
        };
        module
            .apply(
                &context(),
                request(
                    "thread-backend-select-acp",
                    ProjectWorkspaceIntent::UpdateThread {
                        thread_id: "thread-backend".to_owned(),
                        patch: Box::new(ProjectWorkspaceThreadPatch {
                            backend_binding: Some(acp_binding.clone()),
                            ..ProjectWorkspaceThreadPatch::default()
                        }),
                    },
                ),
            )
            .expect("select ACP backend");
        module
            .apply(
                &context(),
                request(
                    "thread-backend-bind-session",
                    ProjectWorkspaceIntent::BindThreadBackendSession {
                        thread_id: "thread-backend".to_owned(),
                        backend_binding: acp_binding.clone(),
                        backend_session_id: "acp-session-1".to_owned(),
                    },
                ),
            )
            .expect("bind ACP session");

        drop(module);
        drop(kernel);
        let reopened_kernel =
            SqliteStoreKernel::open_test(directory.path()).expect("reopen Profile store");
        let reopened = ProjectWorkspaceModule::new("profile-1", "library-1", &reopened_kernel)
            .expect("reopened Workspace module");
        let ProjectWorkspaceReadValue::ThreadBackendSession { session } = read(
            &reopened,
            ProjectWorkspaceRead::ThreadBackendSession {
                thread_id: "thread-backend".to_owned(),
            },
        ) else {
            panic!("backend session read");
        };
        let session = session.expect("persisted ACP session");
        assert_eq!(session.backend_binding, acp_binding);
        assert_eq!(session.backend_session_id, "acp-session-1");

        reopened
            .apply(
                &context(),
                request(
                    "thread-backend-select-codex",
                    ProjectWorkspaceIntent::UpdateThread {
                        thread_id: "thread-backend".to_owned(),
                        patch: Box::new(ProjectWorkspaceThreadPatch {
                            backend_binding: Some(AgentBackendBinding::Codex),
                            ..ProjectWorkspaceThreadPatch::default()
                        }),
                    },
                ),
            )
            .expect("return to native Codex backend");
        let ProjectWorkspaceReadValue::ThreadBackendSession { session } = read(
            &reopened,
            ProjectWorkspaceRead::ThreadBackendSession {
                thread_id: "thread-backend".to_owned(),
            },
        ) else {
            panic!("cleared backend session read");
        };
        assert_eq!(session, None);
    }

    #[test]
    fn execution_location_is_atomic_and_lifecycle_snapshot_keeps_every_consumer() {
        let (_directory, _kernel, module) = seeded_module();
        for index in 1..=3 {
            create_thread(
                &module,
                &format!("operation:create:{index}"),
                &format!("thread:{index}"),
                Some("project:default"),
                None,
            );
        }

        let ProjectWorkspaceReadValue::Thread { thread } = read(
            &module,
            ProjectWorkspaceRead::Thread {
                thread_id: "thread:1".to_owned(),
            },
        ) else {
            panic!("Thread read");
        };
        assert_eq!(thread.execution_host_id, "local");

        let ProjectWorkspaceReadValue::ManagedWorktreeLifecycleSnapshot { snapshot: before } = read(
            &module,
            ProjectWorkspaceRead::ManagedWorktreeLifecycleSnapshot,
        ) else {
            panic!("lifecycle snapshot");
        };
        module
            .apply(
                &context(),
                request(
                    "operation:location:1",
                    ProjectWorkspaceIntent::SetThreadExecutionLocation {
                        thread_id: "thread:1".to_owned(),
                        location: ProjectWorkspaceThreadExecutionLocation {
                            execution_host_id: "ssh:build-box".to_owned(),
                            cwd: Some("/worktrees/shared/nested".to_owned()),
                            managed_worktree_path: Some("/worktrees/shared".to_owned()),
                            runtime_workspace_roots: vec![
                                "/worktrees/shared".to_owned(),
                                "/workspace/additional".to_owned(),
                            ],
                            projectless_output_directory: None,
                            projectless_workspace_browser_root: None,
                        },
                    },
                ),
            )
            .expect("set execution location");
        let ProjectWorkspaceReadValue::ManagedWorktreeLifecycleSnapshot { snapshot: after } = read(
            &module,
            ProjectWorkspaceRead::ManagedWorktreeLifecycleSnapshot,
        ) else {
            panic!("lifecycle snapshot");
        };
        assert_eq!(after.projection_revision, before.projection_revision + 1);
        assert_eq!(after.consumers.len(), 1);
        assert_eq!(after.consumers[0].execution_host_id, "ssh:build-box");
        assert_eq!(
            after.consumers[0].runtime_workspace_roots,
            ["/worktrees/shared", "/workspace/additional"]
        );

        for index in 2..=3 {
            module
                .apply(
                    &context(),
                    request(
                        &format!("operation:location:{index}"),
                        ProjectWorkspaceIntent::SetThreadExecutionLocation {
                            thread_id: format!("thread:{index}"),
                            location: ProjectWorkspaceThreadExecutionLocation {
                                execution_host_id: "local".to_owned(),
                                cwd: Some("/worktrees/shared".to_owned()),
                                managed_worktree_path: Some("/worktrees/shared".to_owned()),
                                runtime_workspace_roots: vec!["/worktrees/shared".to_owned()],
                                projectless_output_directory: None,
                                projectless_workspace_browser_root: None,
                            },
                        },
                    ),
                )
                .expect("set shared execution location");
        }
        module
            .apply(
                &context(),
                request(
                    "operation:archive:2",
                    ProjectWorkspaceIntent::SetThreadArchived {
                        thread_id: "thread:2".to_owned(),
                        archived: true,
                    },
                ),
            )
            .expect("archive consumer");
        module
            .apply(
                &context(),
                request(
                    "operation:pin:3",
                    ProjectWorkspaceIntent::SetThreadPinned {
                        thread_id: "thread:3".to_owned(),
                        pinned: true,
                        placement: None,
                    },
                ),
            )
            .expect("pin consumer");

        let ProjectWorkspaceReadValue::ManagedWorktreeLifecycleSnapshot { snapshot } = read(
            &module,
            ProjectWorkspaceRead::ManagedWorktreeLifecycleSnapshot,
        ) else {
            panic!("lifecycle snapshot");
        };
        assert_eq!(snapshot.consumers.len(), 3);
        assert!(
            snapshot
                .consumers
                .iter()
                .any(|consumer| consumer.thread_id == "thread:2" && consumer.archived)
        );
        assert!(
            snapshot
                .consumers
                .iter()
                .any(|consumer| consumer.thread_id == "thread:3" && consumer.pinned_order.is_some())
        );
        assert_eq!(snapshot.projects.len(), 1);
        assert_eq!(snapshot.projects[0].project_id, "project:default");
    }

    #[test]
    fn session_link_publishes_thread_and_execution_location_in_one_revision() {
        let (_directory, _kernel, module) = seeded_module();
        create_session(&module, "operation:create-session", "session:atomic-link");
        let ProjectWorkspaceReadValue::ManagedWorktreeLifecycleSnapshot { snapshot: before } = read(
            &module,
            ProjectWorkspaceRead::ManagedWorktreeLifecycleSnapshot,
        ) else {
            panic!("lifecycle snapshot");
        };

        module
            .apply(
                &context(),
                request(
                    "operation:atomic-link",
                    ProjectWorkspaceIntent::MutateSession {
                        session_id: "session:atomic-link".to_owned(),
                        intent: ProjectSessionIntent::LinkThread {
                            thread_id: "thread:atomic-link".to_owned(),
                            expected_project_id: Some("project:default".to_owned()),
                            thread_patch: Some(Box::new(ProjectWorkspaceThreadPatch {
                                project_id: Some(Some("project:default".to_owned())),
                                cwd: Some(Some("/worktrees/atomic/nested".to_owned())),
                                managed_worktree_path: Some(Some("/worktrees/atomic".to_owned())),
                                ..ProjectWorkspaceThreadPatch::default()
                            })),
                            execution_location: Some(Box::new(
                                ProjectWorkspaceThreadExecutionLocation {
                                    execution_host_id: "local".to_owned(),
                                    cwd: Some("/worktrees/atomic/nested".to_owned()),
                                    managed_worktree_path: Some("/worktrees/atomic".to_owned()),
                                    runtime_workspace_roots: vec![
                                        "/worktrees/atomic".to_owned(),
                                        "/workspace/additional".to_owned(),
                                    ],
                                    projectless_output_directory: None,
                                    projectless_workspace_browser_root: None,
                                },
                            )),
                        },
                    },
                ),
            )
            .expect("link Thread with execution location");

        let ProjectWorkspaceReadValue::ManagedWorktreeLifecycleSnapshot { snapshot: after } = read(
            &module,
            ProjectWorkspaceRead::ManagedWorktreeLifecycleSnapshot,
        ) else {
            panic!("lifecycle snapshot");
        };
        assert_eq!(after.projection_revision, before.projection_revision + 1);
        assert_eq!(after.consumers.len(), 1);
        assert_eq!(
            after.consumers[0].session_id.as_deref(),
            Some("session:atomic-link")
        );
        assert_eq!(
            after.consumers[0].runtime_workspace_roots,
            ["/worktrees/atomic", "/workspace/additional"]
        );
    }

    #[test]
    fn child_metadata_retires_an_existing_sidebar_session_without_archiving_the_thread() {
        let (_directory, kernel, module) = seeded_module();
        create_thread(
            &module,
            "child-retirement-parent",
            "thread:parent",
            Some("project:default"),
            None,
        );
        create_thread(
            &module,
            "child-retirement-candidate",
            "thread:candidate",
            Some("project:default"),
            None,
        );
        create_session(&module, "child-retirement-session", "session:candidate");
        module
            .apply(
                &context(),
                request(
                    "child-retirement-link",
                    ProjectWorkspaceIntent::MutateSession {
                        session_id: "session:candidate".to_owned(),
                        intent: ProjectSessionIntent::LinkThread {
                            thread_id: "thread:candidate".to_owned(),
                            expected_project_id: Some("project:default".to_owned()),
                            thread_patch: None,
                            execution_location: None,
                        },
                    },
                ),
            )
            .expect("link root candidate to sidebar Session");
        module
            .apply(
                &context(),
                request(
                    "child-retirement-pin",
                    ProjectWorkspaceIntent::SetThreadPinned {
                        thread_id: "thread:candidate".to_owned(),
                        pinned: true,
                        placement: None,
                    },
                ),
            )
            .expect("pin root candidate");
        module
            .apply(
                &context(),
                request(
                    "child-retirement-unread",
                    ProjectWorkspaceIntent::SetThreadUnread {
                        thread_id: "thread:candidate".to_owned(),
                        unread: true,
                    },
                ),
            )
            .expect("mark root candidate unread");

        module
            .apply(
                &context(),
                request(
                    "child-retirement-classify",
                    ProjectWorkspaceIntent::UpsertThread {
                        thread_id: "thread:candidate".to_owned(),
                        patch: Box::new(ProjectWorkspaceThreadPatch {
                            parent_thread_id: Some(Some("thread:parent".to_owned())),
                            ..ProjectWorkspaceThreadPatch::default()
                        }),
                    },
                ),
            )
            .expect("classify candidate as child Thread");

        let ProjectWorkspaceReadValue::Thread { thread } = read(
            &module,
            ProjectWorkspaceRead::Thread {
                thread_id: "thread:candidate".to_owned(),
            },
        ) else {
            panic!("child Thread read");
        };
        assert_eq!(thread.parent_thread_id.as_deref(), Some("thread:parent"));
        assert_eq!(thread.session_id, None);
        assert_eq!(thread.pinned_order, None);
        assert!(!thread.has_unread_turn);
        assert!(!thread.archived);

        let retired = kernel
            .writer()
            .call(|connection| {
                Ok(connection.query_row(
                    "SELECT archived, pinned, unread, \
                       (SELECT count(*) FROM project_session_threads \
                        WHERE session_id = 'session:candidate') \
                     FROM project_sessions WHERE id = 'session:candidate'",
                    [],
                    |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, i64>(1)?,
                            row.get::<_, i64>(2)?,
                            row.get::<_, i64>(3)?,
                        ))
                    },
                )?)
            })
            .expect("retired child sidebar materialization");
        assert_eq!(retired, (1, 0, 0, 0));
    }

    #[test]
    fn child_threads_cannot_be_linked_to_sidebar_sessions() {
        let (_directory, _kernel, module) = seeded_module();
        create_thread(
            &module,
            "child-link-parent",
            "thread:parent",
            Some("project:default"),
            None,
        );
        create_thread(
            &module,
            "child-link-child",
            "thread:child",
            Some("project:default"),
            Some("thread:parent"),
        );
        create_session(&module, "child-link-session", "session:child");

        let error = module
            .apply(
                &context(),
                request(
                    "child-link-rejected",
                    ProjectWorkspaceIntent::MutateSession {
                        session_id: "session:child".to_owned(),
                        intent: ProjectSessionIntent::LinkThread {
                            thread_id: "thread:child".to_owned(),
                            expected_project_id: Some("project:default".to_owned()),
                            thread_patch: None,
                            execution_location: None,
                        },
                    },
                ),
            )
            .expect_err("child Thread link must fail");
        assert_eq!(error.code, CoreErrorCode::InvalidInput);
        assert_eq!(
            error.message,
            "Child Codex Threads cannot be linked to sidebar Sessions"
        );
    }

    #[test]
    fn owns_thread_execution_context_and_metadata_lifecycle() {
        let (_directory, kernel, module) = seeded_module();
        let upsert = request(
            "thread-upsert-root",
            ProjectWorkspaceIntent::UpsertThread {
                thread_id: "thread-root".to_owned(),
                patch: Box::new(ProjectWorkspaceThreadPatch {
                    project_id: Some(Some("project:default".to_owned())),
                    forked_from_id: Some(Some("thread-origin".to_owned())),
                    thread_name: Some(Some("  Root Thread  ".to_owned())),
                    thread_source: Some(Some("appServer".to_owned())),
                    service_name: Some(Some("codex".to_owned())),
                    agent_nickname: Some(Some("@Nash".to_owned())),
                    agent_role: Some(Some("worker".to_owned())),
                    agent_path: Some(Some("agents/nash".to_owned())),
                    thread_preview: Some("Persisted execution context".to_owned()),
                    model_id: Some(Some("claude-opus-4-1".to_owned())),
                    reasoning_effort: Some(Some("Thinking".to_owned())),
                    service_tier: Some(Some("priority".to_owned())),
                    cwd: Some(Some("/workspace/root".to_owned())),
                    managed_worktree_path: Some(Some("/workspace/worktree".to_owned())),
                    status: Some(ProjectWorkspaceThreadStatus {
                        status_type: CodexThreadStatusType::Active,
                        active_flags: vec![CodexThreadActiveFlag::WaitingOnApproval],
                    }),
                    created_at: Some(100),
                    updated_at: Some(200),
                    linked_at: Some(NOW.to_owned()),
                    ..ProjectWorkspaceThreadPatch::default()
                }),
            },
        );
        let committed = module
            .apply(&context(), upsert.clone())
            .expect("upsert Thread");
        let replay = module
            .apply(&context(), upsert)
            .expect("replay Thread upsert");
        assert_eq!(
            replay.committed.event_sequence,
            committed.committed.event_sequence
        );
        assert!(replay.committed.receipt.mutation.duplicate);

        module
            .apply(
                &context(),
                request(
                    "thread-update-root",
                    ProjectWorkspaceIntent::UpdateThread {
                        thread_id: "thread-root".to_owned(),
                        patch: Box::new(ProjectWorkspaceThreadPatch {
                            thread_name: Some(Some("Updated Root".to_owned())),
                            status: Some(ProjectWorkspaceThreadStatus {
                                status_type: CodexThreadStatusType::Idle,
                                active_flags: Vec::new(),
                            }),
                            updated_at: Some(300),
                            ..ProjectWorkspaceThreadPatch::default()
                        }),
                    },
                ),
            )
            .expect("update existing Thread metadata");
        let ProjectWorkspaceReadValue::Thread { thread } = read(
            &module,
            ProjectWorkspaceRead::Thread {
                thread_id: "thread-root".to_owned(),
            },
        ) else {
            panic!("Thread read");
        };
        assert_eq!(thread.updated_at, 300);
        assert_eq!(thread.recency_at, 200);
        let missing_update = module
            .apply(
                &context(),
                request(
                    "thread-update-missing",
                    ProjectWorkspaceIntent::UpdateThread {
                        thread_id: "thread-missing".to_owned(),
                        patch: Box::new(ProjectWorkspaceThreadPatch {
                            thread_name: Some(Some("Must not materialize".to_owned())),
                            ..ProjectWorkspaceThreadPatch::default()
                        }),
                    },
                ),
            )
            .expect_err("missing Thread update must fail closed");
        assert_eq!(missing_update.code, CoreErrorCode::NotFound);

        module
            .apply(
                &context(),
                request(
                    "thread-catalogs-root",
                    ProjectWorkspaceIntent::ReplaceThreadDynamicToolCatalogs {
                        thread_id: "thread-root".to_owned(),
                        catalogs: vec![
                            ProjectWorkspaceDynamicToolCatalog {
                                namespace: " zeta ".to_owned(),
                                toolset_revision: 3,
                            },
                            ProjectWorkspaceDynamicToolCatalog {
                                namespace: "nodex_app".to_owned(),
                                toolset_revision: 5,
                            },
                        ],
                    },
                ),
            )
            .expect("replace dynamic catalogs");
        module
            .apply(
                &context(),
                request(
                    "thread-permission-root",
                    ProjectWorkspaceIntent::SetProjectPermissionMode {
                        project_id: "project:default".to_owned(),
                        mode: CodexPermissionMode::FullAccess,
                    },
                ),
            )
            .expect("select permission mode");
        let ProjectWorkspaceReadValue::ProjectPermissionMode { mode } = read(
            &module,
            ProjectWorkspaceRead::ProjectPermissionMode {
                project_id: "project:default".to_owned(),
            },
        ) else {
            panic!("Project permission mode");
        };
        assert_eq!(mode, Some(CodexPermissionMode::FullAccess));
        module
            .apply(
                &context(),
                request(
                    "thread-projectless-permission",
                    ProjectWorkspaceIntent::SetProjectlessPermissionMode {
                        mode: CodexPermissionMode::GuardianApprovals,
                    },
                ),
            )
            .expect("select projectless permission mode");
        let ProjectWorkspaceReadValue::ProjectlessPermissionMode { mode } =
            read(&module, ProjectWorkspaceRead::ProjectlessPermissionMode)
        else {
            panic!("Projectless permission mode");
        };
        assert_eq!(mode, Some(CodexPermissionMode::GuardianApprovals));
        create_thread(
            &module,
            "thread-projectless-create",
            "thread-projectless",
            None,
            None,
        );
        let ProjectWorkspaceReadValue::ExecutionContext {
            context: projectless_execution_context,
        } = read(
            &module,
            ProjectWorkspaceRead::ExecutionContext {
                thread_id: "thread-projectless".to_owned(),
            },
        )
        else {
            panic!("projectless execution context");
        };
        assert!(projectless_execution_context.project.is_none());
        assert_eq!(
            projectless_execution_context.permission_mode,
            Some(CodexPermissionMode::GuardianApprovals)
        );
        module
            .apply(
                &context(),
                request(
                    "thread-pin-root",
                    ProjectWorkspaceIntent::SetThreadPinned {
                        thread_id: "thread-root".to_owned(),
                        pinned: true,
                        placement: None,
                    },
                ),
            )
            .expect("pin Thread");
        module
            .apply(
                &context(),
                request(
                    "thread-unread-root",
                    ProjectWorkspaceIntent::SetThreadUnread {
                        thread_id: "thread-root".to_owned(),
                        unread: true,
                    },
                ),
            )
            .expect("mark Thread unread");

        let ProjectWorkspaceReadValue::ExecutionContext {
            context: execution_context,
        } = read(
            &module,
            ProjectWorkspaceRead::ExecutionContext {
                thread_id: "thread-root".to_owned(),
            },
        )
        else {
            panic!("execution context");
        };
        assert_eq!(
            execution_context.permission_mode,
            Some(CodexPermissionMode::FullAccess)
        );
        assert_eq!(
            execution_context
                .project
                .as_ref()
                .map(|project| project.id.as_str()),
            Some("project:default")
        );
        assert_eq!(
            execution_context.thread.thread_name.as_deref(),
            Some("Updated Root")
        );
        assert_eq!(
            execution_context.thread.agent_path.as_deref(),
            Some("agents/nash")
        );
        assert_eq!(
            execution_context.thread.model_id.as_deref(),
            Some("claude-opus-4-1")
        );
        assert_eq!(
            execution_context.thread.reasoning_effort.as_deref(),
            Some("Thinking")
        );
        assert_eq!(
            execution_context.thread.service_tier.as_deref(),
            Some("priority")
        );
        assert_eq!(
            execution_context.thread.status.status_type,
            CodexThreadStatusType::Idle
        );
        assert_eq!(execution_context.thread.pinned_order, Some(0));
        assert!(execution_context.thread.has_unread_turn);
        assert_eq!(
            execution_context
                .thread
                .dynamic_tool_catalogs
                .iter()
                .map(|catalog| catalog.namespace.as_str())
                .collect::<Vec<_>>(),
            vec!["nodex_app", "zeta"]
        );

        let duplicate_catalog = module
            .apply(
                &context(),
                request(
                    "thread-catalogs-invalid",
                    ProjectWorkspaceIntent::ReplaceThreadDynamicToolCatalogs {
                        thread_id: "thread-root".to_owned(),
                        catalogs: vec![
                            ProjectWorkspaceDynamicToolCatalog {
                                namespace: "nodex_app".to_owned(),
                                toolset_revision: 5,
                            },
                            ProjectWorkspaceDynamicToolCatalog {
                                namespace: " nodex_app ".to_owned(),
                                toolset_revision: 6,
                            },
                        ],
                    },
                ),
            )
            .expect_err("duplicate dynamic namespace must fail");
        assert_eq!(duplicate_catalog.code, CoreErrorCode::InvalidInput);

        let session_id = "session:thread-root".to_owned();
        create_session(&module, "thread-create-session-root", &session_id);
        module
            .apply(
                &context(),
                request(
                    "thread-link-root",
                    ProjectWorkspaceIntent::MutateSession {
                        session_id,
                        intent: ProjectSessionIntent::LinkThread {
                            thread_id: "thread-root".to_owned(),
                            expected_project_id: Some("project:default".to_owned()),
                            thread_patch: None,
                            execution_location: None,
                        },
                    },
                ),
            )
            .expect("link Thread to Session");
        let mismatched_move = module
            .apply(
                &context(),
                request(
                    "thread-invalid-project-clear",
                    ProjectWorkspaceIntent::UpsertThread {
                        thread_id: "thread-root".to_owned(),
                        patch: Box::new(ProjectWorkspaceThreadPatch {
                            project_id: Some(None),
                            ..ProjectWorkspaceThreadPatch::default()
                        }),
                    },
                ),
            )
            .expect_err("linked Thread cannot leave its Session Project");
        assert_eq!(mismatched_move.code, CoreErrorCode::Conflict);

        module
            .apply(
                &context(),
                request(
                    "thread-archive-root",
                    ProjectWorkspaceIntent::UpsertThread {
                        thread_id: "thread-root".to_owned(),
                        patch: Box::new(ProjectWorkspaceThreadPatch {
                            status: Some(ProjectWorkspaceThreadStatus {
                                status_type: CodexThreadStatusType::Idle,
                                active_flags: Vec::new(),
                            }),
                            archived: Some(true),
                            managed_worktree_path: Some(None),
                            updated_at: Some(300),
                            ..ProjectWorkspaceThreadPatch::default()
                        }),
                    },
                ),
            )
            .expect("archive Thread");
        let ProjectWorkspaceReadValue::Thread { thread } = read(
            &module,
            ProjectWorkspaceRead::Thread {
                thread_id: "thread-root".to_owned(),
            },
        ) else {
            panic!("Thread read");
        };
        assert!(thread.archived);
        assert!(!thread.has_unread_turn);
        assert_eq!(thread.managed_worktree_path, None);

        let threads = kernel
            .writer()
            .call(|connection| {
                super::read_threads(
                    connection,
                    "library-1",
                    Some("project:default"),
                    true,
                    None,
                    false,
                )
            })
            .expect("Thread collection");
        assert!(threads.is_empty());

        let stored = kernel
            .writer()
            .call(|connection| {
                Ok(connection.query_row(
                    "SELECT \
                       (SELECT count(*) FROM codex_thread_dynamic_tool_catalogs \
                        WHERE thread_id = 'thread-root'), \
                       (SELECT count(*) FROM core_module_receipts \
                        WHERE operation_id IN (\
                          'thread-catalogs-invalid', 'thread-invalid-project-clear'\
                        ))",
                    [],
                    |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
                )?)
            })
            .expect("Thread rollback evidence");
        assert_eq!(stored, (2, 0));
    }

    #[test]
    fn preserves_existing_thread_ownership_until_an_explicit_move() {
        let (_directory, _kernel, module) = seeded_module();
        create_thread(
            &module,
            "thread-owner-create-project",
            "thread-owner-project",
            Some("project:default"),
            None,
        );
        create_thread(
            &module,
            "thread-owner-create-projectless",
            "thread-owner-projectless",
            None,
            None,
        );

        module
            .apply(
                &context(),
                request(
                    "thread-owner-same-project",
                    ProjectWorkspaceIntent::UpsertThread {
                        thread_id: "thread-owner-project".to_owned(),
                        patch: Box::new(ProjectWorkspaceThreadPatch {
                            project_id: Some(Some("project:default".to_owned())),
                            ..ProjectWorkspaceThreadPatch::default()
                        }),
                    },
                ),
            )
            .expect("same-owner metadata upsert");

        let project_to_projectless = module
            .apply(
                &context(),
                request(
                    "thread-owner-project-to-projectless",
                    ProjectWorkspaceIntent::UpsertThread {
                        thread_id: "thread-owner-project".to_owned(),
                        patch: Box::new(ProjectWorkspaceThreadPatch {
                            project_id: Some(None),
                            ..ProjectWorkspaceThreadPatch::default()
                        }),
                    },
                ),
            )
            .expect_err("metadata upsert cannot clear Project ownership");
        assert_eq!(project_to_projectless.code, CoreErrorCode::Conflict);
        assert!(project_to_projectless.retryable);

        let projectless_to_project = module
            .apply(
                &context(),
                request(
                    "thread-owner-projectless-to-project",
                    ProjectWorkspaceIntent::UpdateThread {
                        thread_id: "thread-owner-projectless".to_owned(),
                        patch: Box::new(ProjectWorkspaceThreadPatch {
                            project_id: Some(Some("project:default".to_owned())),
                            ..ProjectWorkspaceThreadPatch::default()
                        }),
                    },
                ),
            )
            .expect_err("metadata update cannot assign Project ownership");
        assert_eq!(projectless_to_project.code, CoreErrorCode::Conflict);

        let ProjectWorkspaceReadValue::Thread {
            thread: project_thread,
        } = read(
            &module,
            ProjectWorkspaceRead::Thread {
                thread_id: "thread-owner-project".to_owned(),
            },
        )
        else {
            panic!("Project Thread read");
        };
        let ProjectWorkspaceReadValue::Thread {
            thread: projectless_thread,
        } = read(
            &module,
            ProjectWorkspaceRead::Thread {
                thread_id: "thread-owner-projectless".to_owned(),
            },
        )
        else {
            panic!("Projectless Thread read");
        };
        assert_eq!(
            project_thread.project_id.as_deref(),
            Some("project:default")
        );
        assert_eq!(projectless_thread.project_id, None);
    }

    #[test]
    fn owns_root_child_projectless_pinned_order_and_delete_collections() {
        let (_directory, kernel, module) = seeded_module();
        create_thread(
            &module,
            "thread-create-a",
            "thread-a",
            Some("project:default"),
            None,
        );
        create_thread(
            &module,
            "thread-create-b",
            "thread-b",
            Some("project:default"),
            None,
        );
        create_thread(
            &module,
            "thread-create-c",
            "thread-c",
            Some("project:default"),
            None,
        );
        create_thread(
            &module,
            "thread-create-child",
            "thread-child",
            Some("project:default"),
            Some("thread-a"),
        );
        create_thread(
            &module,
            "thread-create-projectless",
            "thread-projectless",
            None,
            None,
        );
        let session_id = "session:thread-b".to_owned();
        create_session(&module, "thread-create-session-b", &session_id);
        module
            .apply(
                &context(),
                request(
                    "thread-link-b",
                    ProjectWorkspaceIntent::MutateSession {
                        session_id: session_id.clone(),
                        intent: ProjectSessionIntent::LinkThread {
                            thread_id: "thread-b".to_owned(),
                            expected_project_id: Some("project:default".to_owned()),
                            thread_patch: None,
                            execution_location: None,
                        },
                    },
                ),
            )
            .expect("link Thread to Session");

        for thread_id in ["thread-a", "thread-b", "thread-c"] {
            module
                .apply(
                    &context(),
                    request(
                        &format!("thread-pin-{thread_id}"),
                        ProjectWorkspaceIntent::SetThreadPinned {
                            thread_id: thread_id.to_owned(),
                            pinned: true,
                            placement: None,
                        },
                    ),
                )
                .expect("pin root Thread");
        }
        module
            .apply(
                &context(),
                request(
                    "thread-reorder-pinned",
                    ProjectWorkspaceIntent::ReorderPinnedThreads {
                        thread_ids: vec![
                            "thread-c".to_owned(),
                            "unknown-thread".to_owned(),
                            "thread-a".to_owned(),
                            "thread-c".to_owned(),
                        ],
                    },
                ),
            )
            .expect("partial pinned order");
        let pinned_orders = ["thread-c", "thread-a", "thread-b"]
            .into_iter()
            .map(|thread_id| {
                let ProjectWorkspaceReadValue::Thread { thread } = read(
                    &module,
                    ProjectWorkspaceRead::Thread {
                        thread_id: thread_id.to_owned(),
                    },
                ) else {
                    panic!("Thread read");
                };
                thread.pinned_order
            })
            .collect::<Vec<_>>();
        assert_eq!(pinned_orders, vec![Some(0), Some(1), Some(2)]);

        module
            .apply(
                &context(),
                request(
                    "thread-unpin-b",
                    ProjectWorkspaceIntent::SetThreadPinned {
                        thread_id: "thread-b".to_owned(),
                        pinned: false,
                        placement: None,
                    },
                ),
            )
            .expect("unpin linked Thread");
        module
            .apply(
                &context(),
                request(
                    "thread-repin-b-before-c",
                    ProjectWorkspaceIntent::SetThreadPinned {
                        thread_id: "thread-b".to_owned(),
                        pinned: true,
                        placement: Some(ProjectWorkspaceThreadPlacement::Before {
                            thread_id: "thread-c".to_owned(),
                        }),
                    },
                ),
            )
            .expect("re-pin linked Thread before anchor");
        let pinned_after_reinsert = ["thread-b", "thread-c", "thread-a"]
            .into_iter()
            .map(|thread_id| {
                let ProjectWorkspaceReadValue::Thread { thread } = read(
                    &module,
                    ProjectWorkspaceRead::Thread {
                        thread_id: thread_id.to_owned(),
                    },
                ) else {
                    panic!("Thread read");
                };
                thread.pinned_order
            })
            .collect::<Vec<_>>();
        assert_eq!(pinned_after_reinsert, vec![Some(0), Some(1), Some(2)]);
        module
            .apply(
                &context(),
                request(
                    "thread-unread-b",
                    ProjectWorkspaceIntent::SetThreadUnread {
                        thread_id: "thread-b".to_owned(),
                        unread: true,
                    },
                ),
            )
            .expect("mark linked Thread unread");
        let session_id_for_state = session_id.clone();
        let session_state = kernel
            .writer()
            .call(move |connection| {
                Ok(connection.query_row(
                    "SELECT pinned, pinned_order, unread FROM project_sessions WHERE id = ?1",
                    [&session_id_for_state],
                    |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, Option<i64>>(1)?,
                            row.get::<_, i64>(2)?,
                        ))
                    },
                )?)
            })
            .expect("linked Session Thread-state mirrors");
        assert_eq!(session_state, (1, Some(0), 1));
        module
            .apply(
                &context(),
                request(
                    "thread-read-b",
                    ProjectWorkspaceIntent::SetThreadUnread {
                        thread_id: "thread-b".to_owned(),
                        unread: false,
                    },
                ),
            )
            .expect("mark linked Thread read");
        module
            .apply(
                &context(),
                request(
                    "thread-archive-b",
                    ProjectWorkspaceIntent::SetThreadArchived {
                        thread_id: "thread-b".to_owned(),
                        archived: true,
                    },
                ),
            )
            .expect("archive linked Thread");
        let ProjectWorkspaceReadValue::Thread {
            thread: archived_thread,
        } = read(
            &module,
            ProjectWorkspaceRead::Thread {
                thread_id: "thread-b".to_owned(),
            },
        )
        else {
            panic!("archived Thread read");
        };
        assert!(archived_thread.archived);
        assert_eq!(archived_thread.pinned_order, None);
        assert!(!archived_thread.has_unread_turn);
        assert_eq!(archived_thread.recency_at, 100);
        let archived_session_id = session_id.clone();
        let archived_session_state = kernel
            .writer()
            .call(move |connection| {
                Ok(connection.query_row(
                    "SELECT archived, pinned, unread FROM project_sessions WHERE id = ?1",
                    [&archived_session_id],
                    |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, i64>(1)?,
                            row.get::<_, i64>(2)?,
                        ))
                    },
                )?)
            })
            .expect("archived linked Session state");
        assert_eq!(archived_session_state, (1, 0, 0));
        module
            .apply(
                &context(),
                request(
                    "thread-restore-b",
                    ProjectWorkspaceIntent::SetThreadArchived {
                        thread_id: "thread-b".to_owned(),
                        archived: false,
                    },
                ),
            )
            .expect("restore linked Thread");
        let ProjectWorkspaceReadValue::Thread {
            thread: restored_thread,
        } = read(
            &module,
            ProjectWorkspaceRead::Thread {
                thread_id: "thread-b".to_owned(),
            },
        )
        else {
            panic!("restored Thread read");
        };
        assert!(!restored_thread.archived);
        assert_eq!(restored_thread.recency_at, 100);

        let ProjectWorkspaceReadValue::ChildThreadWindow { threads } = read(
            &module,
            ProjectWorkspaceRead::ChildThreadWindow {
                parent_thread_id: "thread-a".to_owned(),
                include_archived: None,
                window: CollectionWindowRequest {
                    after: None,
                    first: Some(50),
                },
            },
        ) else {
            panic!("child Thread collection");
        };
        assert_eq!(
            threads
                .items
                .iter()
                .map(|thread| thread.thread_id.as_str())
                .collect::<Vec<_>>(),
            vec!["thread-child"]
        );
        let child_pin = module
            .apply(
                &context(),
                request(
                    "thread-pin-child",
                    ProjectWorkspaceIntent::SetThreadPinned {
                        thread_id: "thread-child".to_owned(),
                        pinned: true,
                        placement: None,
                    },
                ),
            )
            .expect_err("child Thread cannot be pinned");
        assert_eq!(child_pin.code, CoreErrorCode::InvalidInput);

        let all_roots = kernel
            .writer()
            .call(|connection| {
                super::read_threads(connection, "library-1", None, true, None, false)
            })
            .expect("Projectless root Threads");
        assert!(
            all_roots
                .iter()
                .any(|thread| thread.thread_id == "thread-projectless")
        );
        assert!(
            all_roots
                .iter()
                .all(|thread| thread.thread_id != "thread-child")
        );
        let project_roots = kernel
            .writer()
            .call(|connection| {
                super::read_threads(
                    connection,
                    "library-1",
                    Some("project:default"),
                    true,
                    None,
                    false,
                )
            })
            .expect("Project root Threads");
        assert_eq!(project_roots.len(), 3);

        module
            .apply(
                &context(),
                request(
                    "thread-repin-b-before-delete",
                    ProjectWorkspaceIntent::SetThreadPinned {
                        thread_id: "thread-b".to_owned(),
                        pinned: true,
                        placement: None,
                    },
                ),
            )
            .expect("re-pin Thread before delete");
        module
            .apply(
                &context(),
                request(
                    "thread-unread-b-before-delete",
                    ProjectWorkspaceIntent::SetThreadUnread {
                        thread_id: "thread-b".to_owned(),
                        unread: true,
                    },
                ),
            )
            .expect("mark Thread unread before delete");

        let delete = request(
            "thread-delete-b",
            ProjectWorkspaceIntent::DeleteThread {
                thread_id: "thread-b".to_owned(),
            },
        );
        let committed = module
            .apply(&context(), delete.clone())
            .expect("delete Thread");
        let replay = module
            .apply(&context(), delete)
            .expect("replay Thread delete");
        assert_eq!(
            replay.committed.event_sequence,
            committed.committed.event_sequence
        );
        assert!(replay.committed.receipt.mutation.duplicate);
        let deleted_session_id = session_id.clone();
        let deleted_session_state = kernel
            .writer()
            .call(move |connection| {
                Ok(connection.query_row(
                    "SELECT archived, pinned, unread FROM project_sessions WHERE id = ?1",
                    [&deleted_session_id],
                    |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, i64>(1)?,
                            row.get::<_, i64>(2)?,
                        ))
                    },
                )?)
            })
            .expect("deleted Thread Session shell");
        assert_eq!(deleted_session_state, (1, 0, 0));
        let missing = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                    read: ProjectWorkspaceRead::Thread {
                        thread_id: "thread-b".to_owned(),
                    },
                },
            )
            .expect_err("deleted Thread must be unavailable");
        assert_eq!(missing.code, CoreErrorCode::NotFound);
    }

    #[test]
    fn owns_host_observed_execution_authority_and_continuity() {
        let (_directory, kernel, module) = seeded_module();
        create_thread(
            &module,
            "execution-root-create",
            "thread-root",
            Some("project:default"),
            None,
        );
        create_thread(
            &module,
            "execution-child-create",
            "thread-child",
            Some("project:default"),
            Some("thread-root"),
        );

        module
            .apply(
                &context(),
                request(
                    "execution-roots-replace",
                    ProjectWorkspaceIntent::ReplaceThreadWritableRoots {
                        thread_id: "thread-root".to_owned(),
                        roots: vec![
                            "relative".to_owned(),
                            " /workspace/ignored ".to_owned(),
                            "/workspace/a".to_owned(),
                            "/workspace/a".to_owned(),
                        ],
                    },
                ),
            )
            .expect("replace writable roots");
        module
            .apply(
                &context(),
                request(
                    "execution-roots-merge",
                    ProjectWorkspaceIntent::MergeThreadWritableRoots {
                        thread_id: "thread-root".to_owned(),
                        roots: vec!["/workspace/b".to_owned(), "/workspace/a".to_owned()],
                    },
                ),
            )
            .expect("merge writable roots");
        let ProjectWorkspaceReadValue::Thread { thread } = read(
            &module,
            ProjectWorkspaceRead::Thread {
                thread_id: "thread-root".to_owned(),
            },
        ) else {
            panic!("Thread read");
        };
        assert_eq!(thread.writable_roots, ["/workspace/a", "/workspace/b"]);

        module
            .apply(
                &context(),
                request(
                    "execution-permission-full-access",
                    ProjectWorkspaceIntent::SetProjectPermissionMode {
                        project_id: "project:default".to_owned(),
                        mode: CodexPermissionMode::FullAccess,
                    },
                ),
            )
            .expect("full access permission");
        let ProjectWorkspaceReadValue::TurnAuthority { resolution } = read(
            &module,
            ProjectWorkspaceRead::TurnAuthority {
                thread_id: "thread-root".to_owned(),
                turn_id: "turn-unrecorded".to_owned(),
                root_thread_id: "thread-root".to_owned(),
                actor_project_id: "project:default".to_owned(),
            },
        ) else {
            panic!("unrecorded Turn authority read");
        };
        assert!(!resolution.persisted);
        assert_eq!(resolution.frozen_at_ms, None);
        assert_eq!(
            resolution.authority.expect("project fallback").scope,
            ProjectWorkspaceTurnAuthorityScope::Project
        );

        let mut untrusted = context();
        untrusted.adapter = AdapterKind::NativeCli;
        let rejected = module
            .apply(
                &untrusted,
                request(
                    "execution-authority-untrusted",
                    ProjectWorkspaceIntent::FreezeTurnAuthority {
                        thread_id: "thread-root".to_owned(),
                        turn_id: "turn-untrusted".to_owned(),
                        root_thread_id: "thread-root".to_owned(),
                        actor_project_id: "project:default".to_owned(),
                        source: ProjectWorkspaceTurnAuthoritySource::ProjectTurn,
                        inherited_from: None,
                    },
                ),
            )
            .expect_err("untrusted Adapter cannot freeze Turn authority");
        assert_eq!(rejected.code, CoreErrorCode::Unauthorized);

        for (operation_id, turn_id, source) in [
            (
                "execution-authority-project",
                "turn-project",
                ProjectWorkspaceTurnAuthoritySource::ProjectTurn,
            ),
            (
                "execution-authority-builtin",
                "turn-builtin",
                ProjectWorkspaceTurnAuthoritySource::BuiltinFullAccess,
            ),
        ] {
            module
                .apply(
                    &context(),
                    request(
                        operation_id,
                        ProjectWorkspaceIntent::FreezeTurnAuthority {
                            thread_id: "thread-root".to_owned(),
                            turn_id: turn_id.to_owned(),
                            root_thread_id: "thread-root".to_owned(),
                            actor_project_id: "project:default".to_owned(),
                            source,
                            inherited_from: None,
                        },
                    ),
                )
                .expect("freeze root Turn authority");
        }
        module
            .apply(
                &context(),
                request(
                    "execution-authority-inherited",
                    ProjectWorkspaceIntent::FreezeTurnAuthority {
                        thread_id: "thread-child".to_owned(),
                        turn_id: "turn-child".to_owned(),
                        root_thread_id: "thread-root".to_owned(),
                        actor_project_id: "project:default".to_owned(),
                        source: ProjectWorkspaceTurnAuthoritySource::InheritedBuiltinFullAccess,
                        inherited_from: Some(ProjectWorkspaceTurnCoordinate {
                            thread_id: "thread-root".to_owned(),
                            turn_id: "turn-builtin".to_owned(),
                        }),
                    },
                ),
            )
            .expect("freeze inherited Turn authority");

        let ProjectWorkspaceReadValue::TurnAuthority { resolution } = read(
            &module,
            ProjectWorkspaceRead::TurnAuthority {
                thread_id: "thread-child".to_owned(),
                turn_id: "turn-child".to_owned(),
                root_thread_id: "thread-root".to_owned(),
                actor_project_id: "project:default".to_owned(),
            },
        ) else {
            panic!("Turn authority read");
        };
        assert!(resolution.persisted);
        assert!(resolution.frozen_at_ms.is_some_and(|value| value > 0));
        assert_eq!(
            resolution.authority.expect("current authority").scope,
            ProjectWorkspaceTurnAuthorityScope::Library
        );
        let fingerprint = kernel
            .readers()
            .read_default(|connection| {
                connection
                    .query_row(
                        "SELECT authority_fingerprint FROM nodex_agent_turn_authorities \
                         WHERE thread_id = 'thread-root' AND turn_id = 'turn-builtin'",
                        [],
                        |row| row.get::<_, String>(0),
                    )
                    .map_err(crate::infrastructure::sqlite::StoreError::from)
            })
            .expect("Turn authority fingerprint");
        assert_eq!(
            fingerprint,
            "0f460f8fdae5552468b1b7bedc4cf07ae5c02568cf5a1780244c0fc51364a792"
        );

        let process = ProjectWorkspaceBackgroundProcess {
            id: "thread-root:item-1".to_owned(),
            thread_id: "thread-root".to_owned(),
            thread_title: Some(" Root execution ".to_owned()),
            item_id: "item-1".to_owned(),
            turn_id: Some("turn-builtin".to_owned()),
            command: " pnpm test ".to_owned(),
            cwd: Some(" /workspace/a ".to_owned()),
            process_id: Some(" process-1 ".to_owned()),
            os_pid: Some(42),
            terminal_session_id: Some(" terminal-1 ".to_owned()),
            source: ProjectWorkspaceBackgroundProcessSource::AppServer,
            started_at_ms: 10,
            updated_at_ms: 20,
        };
        module
            .apply(
                &context(),
                request(
                    "execution-process-create",
                    ProjectWorkspaceIntent::UpsertBackgroundProcess {
                        process: process.clone(),
                        preserve_started_at: None,
                    },
                ),
            )
            .expect("record background process");
        module
            .apply(
                &context(),
                request(
                    "execution-process-update",
                    ProjectWorkspaceIntent::UpsertBackgroundProcess {
                        process: ProjectWorkspaceBackgroundProcess {
                            thread_title: None,
                            turn_id: None,
                            command: "pnpm test:all".to_owned(),
                            cwd: None,
                            process_id: None,
                            os_pid: None,
                            terminal_session_id: None,
                            started_at_ms: 99,
                            updated_at_ms: 30,
                            ..process
                        },
                        preserve_started_at: None,
                    },
                ),
            )
            .expect("update background process");
        let ProjectWorkspaceReadValue::BackgroundProcessWindow { processes } = read(
            &module,
            ProjectWorkspaceRead::BackgroundProcessWindow {
                thread_id: Some("thread-root".to_owned()),
                window: CollectionWindowRequest {
                    after: None,
                    first: Some(50),
                },
            },
        ) else {
            panic!("background processes read");
        };
        assert_eq!(processes.items.len(), 1);
        assert_eq!(
            processes.items[0].thread_title.as_deref(),
            Some("Root execution")
        );
        assert_eq!(processes.items[0].cwd.as_deref(), Some("/workspace/a"));
        assert_eq!(processes.items[0].command, "pnpm test:all");
        assert_eq!(processes.items[0].started_at_ms, 10);
        assert_eq!(processes.items[0].updated_at_ms, 30);
        module
            .apply(
                &context(),
                request(
                    "execution-process-restart",
                    ProjectWorkspaceIntent::UpsertBackgroundProcess {
                        process: ProjectWorkspaceBackgroundProcess {
                            started_at_ms: 99,
                            updated_at_ms: 40,
                            ..processes.items[0].clone()
                        },
                        preserve_started_at: Some(false),
                    },
                ),
            )
            .expect("restart background process");
        let ProjectWorkspaceReadValue::BackgroundProcessWindow { processes } = read(
            &module,
            ProjectWorkspaceRead::BackgroundProcessWindow {
                thread_id: Some("thread-root".to_owned()),
                window: CollectionWindowRequest {
                    after: None,
                    first: Some(50),
                },
            },
        ) else {
            panic!("restarted background process read");
        };
        assert_eq!(processes.items[0].started_at_ms, 99);
        assert_eq!(processes.items[0].updated_at_ms, 40);

        kernel
            .writer()
            .call(|connection| {
                assert!(
                    connection
                        .execute(
                            "UPDATE nodex_agent_turn_authorities SET scope = 'project' \
                             WHERE thread_id = 'thread-root' AND turn_id = 'turn-builtin'",
                            [],
                        )
                        .is_err()
                );
                assert!(
                    connection
                        .execute(
                            "DELETE FROM nodex_agent_turn_authorities \
                             WHERE thread_id = 'thread-root' AND turn_id = 'turn-builtin'",
                            [],
                        )
                        .is_err()
                );
                connection.execute(
                    "UPDATE block_store_metadata SET store_epoch = 'epoch-2' WHERE id = 1",
                    [],
                )?;
                Ok(())
            })
            .expect("verify immutable authority and advance epoch");
        let ProjectWorkspaceReadValue::TurnAuthority { resolution } = read(
            &module,
            ProjectWorkspaceRead::TurnAuthority {
                thread_id: "thread-root".to_owned(),
                turn_id: "turn-builtin".to_owned(),
                root_thread_id: "thread-root".to_owned(),
                actor_project_id: "project:default".to_owned(),
            },
        ) else {
            panic!("stale Turn authority read");
        };
        assert!(resolution.persisted);
        assert!(resolution.authority.is_none());
        assert_eq!(resolution.frozen_at_ms, None);
    }

    #[test]
    fn only_a_completed_app_server_sweep_reconciles_missing_threads() {
        let (_directory, _kernel, module) = seeded_module();
        for thread_id in ["thread:sweep-a", "thread:sweep-b"] {
            module
                .apply(
                    &context(),
                    request(
                        &format!("create-{thread_id}"),
                        ProjectWorkspaceIntent::UpsertThread {
                            thread_id: thread_id.to_owned(),
                            patch: Box::new(ProjectWorkspaceThreadPatch {
                                thread_name: Some(Some(thread_id.to_owned())),
                                ..ProjectWorkspaceThreadPatch::default()
                            }),
                        },
                    ),
                )
                .expect("sweep Thread");
        }
        module
            .apply(
                &context(),
                request(
                    "observe-sweep-one",
                    ProjectWorkspaceIntent::ObserveAppServerThreadWindow {
                        sweep_id: "sweep:one".to_owned(),
                        thread_ids: vec!["thread:sweep-a".to_owned(), "thread:sweep-b".to_owned()],
                    },
                ),
            )
            .expect("first complete observation");
        module
            .apply(
                &context(),
                request(
                    "observe-partial-sweep-two",
                    ProjectWorkspaceIntent::ObserveAppServerThreadWindow {
                        sweep_id: "sweep:two".to_owned(),
                        thread_ids: vec!["thread:sweep-a".to_owned()],
                    },
                ),
            )
            .expect("partial second observation");

        let ProjectWorkspaceReadValue::Thread { thread } = read(
            &module,
            ProjectWorkspaceRead::Thread {
                thread_id: "thread:sweep-b".to_owned(),
            },
        ) else {
            panic!("unseen Thread still exists before finalize");
        };
        assert_eq!(thread.thread_id, "thread:sweep-b");

        let reconciled = module
            .apply(
                &context(),
                request(
                    "finalize-sweep-two",
                    ProjectWorkspaceIntent::ReconcileAppServerThreadSweep {
                        sweep_id: "sweep:two".to_owned(),
                        limit: Some(100),
                    },
                ),
            )
            .expect("complete sweep reconciliation");
        assert_eq!(
            reconciled.committed.value.affected_thread_ids,
            ["thread:sweep-b"]
        );
        let missing = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                    read: ProjectWorkspaceRead::Thread {
                        thread_id: "thread:sweep-b".to_owned(),
                    },
                },
            )
            .expect_err("completed sweep deletes missing app-server Thread");
        assert_eq!(missing.code, CoreErrorCode::NotFound);
    }
}
