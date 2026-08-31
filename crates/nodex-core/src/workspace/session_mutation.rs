use std::collections::BTreeSet;

use nodex_core_contracts::BoundModuleContext;
use nodex_core_contracts::workspace::ProjectSessionIntent;
use rusqlite::{Connection, OptionalExtension, params};

use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

use super::ProjectWorkspaceApplyOutcome;
use super::mutation::{
    WorkspaceMutationEffects, finish_mutation, project_session_scope, workspace_event_anchor,
};
use super::thread::{finish_thread_mutation, upsert_thread_records};

const MAX_ID_LENGTH: usize = 512;
const MAX_SESSION_TITLE_BYTES: usize = 8_000;
const MAX_MANUAL_TITLE_UTF16: usize = 60;

pub(super) struct SessionAuthority {
    pub(super) project_id: Option<String>,
    pub(super) pinned: bool,
    pub(super) pinned_order: Option<i64>,
    pub(super) thread_id: Option<String>,
    pub(super) is_default_draft: bool,
    pub(super) archived: bool,
}

#[derive(Clone, Copy)]
pub(super) enum SessionInvalidationKind {
    None,
    SummaryAndDetail,
}

#[allow(clippy::too_many_arguments)]
pub(super) fn mutate_session(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    session_id: &str,
    intent: &ProjectSessionIntent,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    validate_id("session_id", session_id)?;
    let authority = require_session(connection, library_id, session_id)?;
    match intent {
        ProjectSessionIntent::Rename { title } => rename_session(
            connection,
            library_id,
            context,
            store_epoch,
            operation_id,
            request_hash,
            session_id,
            &authority,
            title,
        ),
        ProjectSessionIntent::SetPinned { pinned } => set_session_pinned(
            connection,
            library_id,
            context,
            store_epoch,
            operation_id,
            request_hash,
            session_id,
            &authority,
            *pinned,
        ),
        ProjectSessionIntent::SetUnread { unread } => set_session_unread(
            connection,
            library_id,
            context,
            store_epoch,
            operation_id,
            request_hash,
            session_id,
            &authority,
            *unread,
        ),
        ProjectSessionIntent::SetArchived { archived } => set_session_archived(
            connection,
            library_id,
            context,
            store_epoch,
            operation_id,
            request_hash,
            session_id,
            &authority,
            *archived,
        ),
        ProjectSessionIntent::SetFallbackTitle { title } => set_fallback_title(
            connection,
            library_id,
            context,
            store_epoch,
            operation_id,
            request_hash,
            session_id,
            &authority,
            title,
        ),
        ProjectSessionIntent::LinkThread {
            thread_id,
            expected_project_id,
            thread_patch,
            execution_location,
        } => link_thread(
            connection,
            library_id,
            context,
            store_epoch,
            operation_id,
            request_hash,
            session_id,
            &authority,
            thread_id,
            expected_project_id.as_deref(),
            thread_patch.as_deref(),
            execution_location.as_deref(),
        ),
        ProjectSessionIntent::UnlinkThread { thread_id } => unlink_thread(
            connection,
            library_id,
            context,
            store_epoch,
            operation_id,
            request_hash,
            session_id,
            &authority,
            thread_id,
        ),
        ProjectSessionIntent::LinkPage {
            page_id,
            page_access_project_id,
        } => super::page_chat::link_page(
            connection,
            library_id,
            context,
            store_epoch,
            operation_id,
            request_hash,
            session_id,
            &authority,
            page_id,
            page_access_project_id,
        ),
        ProjectSessionIntent::UnlinkPage {
            page_id,
            page_access_project_id,
        } => super::page_chat::unlink_page(
            connection,
            library_id,
            context,
            store_epoch,
            operation_id,
            request_hash,
            session_id,
            &authority,
            page_id,
            page_access_project_id,
        ),
    }
}

#[allow(clippy::too_many_arguments)]
fn set_fallback_title(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    session_id: &str,
    authority: &SessionAuthority,
    title: &str,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    let title = normalize_fallback_title(title)?;
    let now = sqlite_now(connection)?;
    let changed = connection.execute(
        "UPDATE project_sessions SET no_thread_fallback_title = ?1, updated_at = ?2 \
         WHERE id = ?3",
        params![title, now, session_id],
    )?;
    if changed != 1 {
        return Err(corrupt(
            "Project Session disappeared during fallback-title update",
        ));
    }
    finish_session_mutation(
        connection,
        library_id,
        context,
        store_epoch,
        operation_id,
        request_hash,
        "set_session_fallback_title",
        session_id,
        authority,
        Vec::new(),
        SessionInvalidationKind::SummaryAndDetail,
        now,
    )
}

fn normalize_fallback_title(value: &str) -> Result<String, StoreError> {
    let normalized = value.trim();
    if normalized.is_empty()
        || normalized.len() > MAX_SESSION_TITLE_BYTES
        || normalized.encode_utf16().count() > 2_000
    {
        return Err(invalid("Project Session fallback title is invalid"));
    }
    Ok(normalized.to_owned())
}

#[allow(clippy::too_many_arguments)]
fn rename_session(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    session_id: &str,
    authority: &SessionAuthority,
    title: &str,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    let normalized = normalize_manual_title(title)?;
    let now = sqlite_now(connection)?;
    if let Some(normalized) = normalized {
        if let Some(thread_id) = &authority.thread_id {
            let changed = connection.execute(
                "UPDATE codex_threads SET thread_name = ?1 WHERE thread_id = ?2",
                params![normalized, thread_id],
            )?;
            if changed != 1 {
                return Err(corrupt("Linked Codex Thread disappeared during rename"));
            }
        } else {
            let changed = connection.execute(
                "UPDATE project_sessions SET no_thread_fallback_title = ?1 \
                 WHERE id = ?2",
                params![normalized, session_id],
            )?;
            if changed != 1 {
                return Err(corrupt("Project Session disappeared during rename"));
            }
        }
        touch_session(connection, session_id, &now)?;
    }
    finish_session_mutation(
        connection,
        library_id,
        context,
        store_epoch,
        operation_id,
        request_hash,
        "rename_session",
        session_id,
        authority,
        authority.thread_id.iter().cloned().collect(),
        SessionInvalidationKind::SummaryAndDetail,
        now,
    )
}

#[allow(clippy::too_many_arguments)]
fn set_session_pinned(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    session_id: &str,
    authority: &SessionAuthority,
    pinned: bool,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    let now = sqlite_now(connection)?;
    let pinned_order = if pinned {
        connection.execute(
            "DELETE FROM workspace_sidebar_section_items WHERE session_id = ?1",
            [session_id],
        )?;
        authority
            .pinned
            .then_some(authority.pinned_order)
            .flatten()
            .or(connection
                .query_row(
                    "SELECT MAX(pinned_order) FROM project_sessions \
                     WHERE project_id IS ?1 AND pinned = 1 AND archived = 0",
                    params![authority.project_id],
                    |row| row.get::<_, Option<i64>>(0),
                )?
                .map(|order| order + 1)
                .or(Some(0)))
    } else {
        None
    };
    let changed = connection.execute(
        "UPDATE project_sessions SET pinned = ?1, pinned_order = ?2, updated_at = ?3 \
         WHERE id = ?4",
        params![i64::from(pinned), pinned_order, now, session_id],
    )?;
    if changed != 1 {
        return Err(corrupt("Project Session disappeared during pin update"));
    }
    finish_session_mutation(
        connection,
        library_id,
        context,
        store_epoch,
        operation_id,
        request_hash,
        "set_session_pinned",
        session_id,
        authority,
        Vec::new(),
        SessionInvalidationKind::SummaryAndDetail,
        now,
    )
}

#[allow(clippy::too_many_arguments)]
fn set_session_unread(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    session_id: &str,
    authority: &SessionAuthority,
    unread: bool,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    let now = sqlite_now(connection)?;
    let changed = connection.execute(
        "UPDATE project_sessions SET unread = ?1, updated_at = ?2 WHERE id = ?3",
        params![i64::from(unread), now, session_id],
    )?;
    if changed != 1 {
        return Err(corrupt("Project Session disappeared during unread update"));
    }
    finish_session_mutation(
        connection,
        library_id,
        context,
        store_epoch,
        operation_id,
        request_hash,
        "set_session_unread",
        session_id,
        authority,
        authority.thread_id.iter().cloned().collect(),
        SessionInvalidationKind::SummaryAndDetail,
        now,
    )
}

#[allow(clippy::too_many_arguments)]
fn set_session_archived(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    session_id: &str,
    authority: &SessionAuthority,
    archived: bool,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    let now = sqlite_now(connection)?;
    let changed = if archived {
        connection.execute(
            "UPDATE project_sessions SET archived = 1, archived_at = ?1, pinned = 0, \
               pinned_order = NULL, unread = 0, is_default_draft = 0, \
               updated_at = ?1 WHERE id = ?2",
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
            "Project Session disappeared during lifecycle update",
        ));
    }
    if let Some(thread_id) = &authority.thread_id {
        let changed = connection.execute(
            "UPDATE codex_threads SET archived = ?1 WHERE thread_id = ?2",
            params![i64::from(archived), thread_id],
        )?;
        if changed != 1 {
            return Err(corrupt(
                "Linked Agent Thread disappeared during lifecycle update",
            ));
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
    }
    finish_session_mutation(
        connection,
        library_id,
        context,
        store_epoch,
        operation_id,
        request_hash,
        if archived {
            "archive_session"
        } else {
            "restore_session"
        },
        session_id,
        authority,
        authority.thread_id.iter().cloned().collect(),
        SessionInvalidationKind::SummaryAndDetail,
        now,
    )
}

#[allow(clippy::too_many_arguments)]
fn link_thread(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    session_id: &str,
    authority: &SessionAuthority,
    thread_id: &str,
    expected_project_id: Option<&str>,
    thread_patch: Option<&nodex_core_contracts::workspace::ProjectWorkspaceThreadPatch>,
    execution_location: Option<
        &nodex_core_contracts::workspace::ProjectWorkspaceThreadExecutionLocation,
    >,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    validate_id("thread_id", thread_id)?;
    if let Some(project_id) = expected_project_id {
        validate_id("expected_project_id", project_id)?;
    }
    if authority.project_id.as_deref() != expected_project_id {
        return Err(StoreError::new(
            StoreErrorCode::Conflict,
            "Thread Project does not match the owning Session",
            false,
        ));
    }
    if authority
        .thread_id
        .as_deref()
        .is_some_and(|existing_thread_id| existing_thread_id != thread_id)
    {
        return Err(StoreError::new(
            StoreErrorCode::Conflict,
            "Project Session is already linked to another Codex Thread",
            false,
        ));
    }
    let upsert_effects = thread_patch
        .map(|patch| upsert_thread_records(connection, library_id, thread_id, patch))
        .transpose()?;
    if let Some(location) = execution_location {
        super::thread::replace_thread_execution_location_records(connection, thread_id, location)?;
    }
    let (thread_project_id, parent_thread_id) = connection
        .query_row(
            "SELECT project_id, parent_thread_id FROM codex_threads WHERE thread_id = ?1",
            [thread_id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| not_found("Codex Thread is unavailable"))?;
    if parent_thread_id.is_some() {
        return Err(StoreError::new(
            StoreErrorCode::InvalidInput,
            "Child Codex Threads cannot be linked to sidebar Sessions",
            false,
        ));
    }
    if thread_project_id.as_deref() != expected_project_id {
        return Err(StoreError::new(
            StoreErrorCode::Conflict,
            "Persisted Codex Thread Project changed",
            true,
        ));
    }
    let conflicting_owner = connection
        .query_row(
            "SELECT session_id FROM project_session_threads \
             WHERE thread_id = ?1 AND session_id <> ?2 ORDER BY linked_at, session_id LIMIT 1",
            params![thread_id, session_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    if conflicting_owner.is_some() {
        return Err(StoreError::new(
            StoreErrorCode::Conflict,
            "Codex Thread is already linked to another Project Session",
            false,
        ));
    }
    let now = sqlite_now(connection)?;
    connection.execute(
        "INSERT INTO project_session_threads(session_id, thread_id, linked_at) \
         VALUES (?1, ?2, ?3) ON CONFLICT(session_id) DO UPDATE SET \
           thread_id = excluded.thread_id, linked_at = excluded.linked_at",
        params![session_id, thread_id, now],
    )?;
    let unread = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM codex_unread_threads WHERE thread_id = ?1)",
        [thread_id],
        |row| row.get::<_, i64>(0),
    )?;
    connection.execute(
        "UPDATE project_sessions SET unread = ?1, is_default_draft = 0, \
           updated_at = ?2 WHERE id = ?3",
        params![unread, now, session_id],
    )?;
    let mut thread_ids = authority.thread_id.iter().cloned().collect::<BTreeSet<_>>();
    thread_ids.insert(thread_id.to_owned());
    let mut project_ids = upsert_effects
        .as_ref()
        .map(|effects| effects.project_ids.iter().cloned().collect::<BTreeSet<_>>())
        .unwrap_or_default();
    project_ids.extend(authority.project_id.iter().cloned());
    let mut session_ids = upsert_effects
        .map(|effects| effects.session_ids.into_iter().collect::<BTreeSet<_>>())
        .unwrap_or_default();
    session_ids.insert(session_id.to_owned());
    finish_thread_mutation(
        connection,
        library_id,
        context,
        store_epoch,
        operation_id,
        request_hash,
        "link_session_thread",
        vec![project_session_scope(authority.project_id.as_deref())],
        project_ids.into_iter().collect(),
        session_ids.into_iter().collect(),
        thread_ids.into_iter().collect(),
    )
}

#[allow(clippy::too_many_arguments)]
fn unlink_thread(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    session_id: &str,
    authority: &SessionAuthority,
    thread_id: &str,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    validate_id("thread_id", thread_id)?;
    let Some(linked_thread_id) = authority.thread_id.as_deref() else {
        return Err(not_found("Project Session has no linked Codex Thread"));
    };
    if linked_thread_id != thread_id {
        return Err(StoreError::new(
            StoreErrorCode::Conflict,
            "Project Session is linked to a different Codex Thread",
            true,
        ));
    }
    let changed = connection.execute(
        "DELETE FROM project_session_threads WHERE session_id = ?1 AND thread_id = ?2",
        params![session_id, thread_id],
    )?;
    if changed != 1 {
        return Err(corrupt("Project Session Thread link disappeared"));
    }
    let now = sqlite_now(connection)?;
    touch_session(connection, session_id, &now)?;
    finish_session_mutation(
        connection,
        library_id,
        context,
        store_epoch,
        operation_id,
        request_hash,
        "unlink_session_thread",
        session_id,
        authority,
        vec![thread_id.to_owned()],
        SessionInvalidationKind::SummaryAndDetail,
        now,
    )
}

#[allow(clippy::too_many_arguments)]
pub(super) fn finish_session_mutation(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    operation_kind: &'static str,
    session_id: &str,
    authority: &SessionAuthority,
    thread_ids: Vec<String>,
    invalidation: SessionInvalidationKind,
    committed_at: String,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    let project_ids = authority.project_id.iter().cloned().collect::<Vec<_>>();
    let change_project_id = authority
        .project_id
        .clone()
        .map_or_else(|| workspace_event_anchor(connection, library_id), Ok)?;
    finish_mutation(
        connection,
        context,
        store_epoch,
        operation_id,
        request_hash,
        WorkspaceMutationEffects {
            operation_kind,
            project_catalog_change: None,
            change_project_id,
            project_ids,
            session_ids: vec![session_id.to_owned()],
            thread_ids,
            session_summary_scopes: match invalidation {
                SessionInvalidationKind::None => Vec::new(),
                SessionInvalidationKind::SummaryAndDetail => {
                    vec![project_session_scope(authority.project_id.as_deref())]
                }
            },
            session_detail_ids: match invalidation {
                SessionInvalidationKind::None => Vec::new(),
                SessionInvalidationKind::SummaryAndDetail => {
                    vec![session_id.to_owned()]
                }
            },
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

pub(super) fn require_session(
    connection: &Connection,
    library_id: &str,
    session_id: &str,
) -> Result<SessionAuthority, StoreError> {
    connection
        .query_row(
            "SELECT session.project_id, session.pinned, session.pinned_order, link.thread_id, \
               session.is_default_draft, session.archived \
             FROM project_sessions session \
             LEFT JOIN project_session_threads link ON link.session_id = session.id \
             WHERE session.id = ?1 AND (session.project_id IS NULL OR EXISTS(\
               SELECT 1 FROM projects project \
               WHERE project.id = session.project_id AND project.library_id = ?2 \
                 AND project.lifecycle = 'active'\
             ))",
            params![session_id, library_id],
            |row| {
                Ok(SessionAuthority {
                    project_id: row.get(0)?,
                    pinned: row.get::<_, i64>(1)? == 1,
                    pinned_order: row.get(2)?,
                    thread_id: row.get(3)?,
                    is_default_draft: row.get::<_, i64>(4)? == 1,
                    archived: row.get::<_, i64>(5)? == 1,
                })
            },
        )
        .optional()?
        .ok_or_else(|| not_found("Project Session is unavailable in this Library"))
}

fn normalize_manual_title(value: &str) -> Result<Option<String>, StoreError> {
    if value.len() > MAX_SESSION_TITLE_BYTES {
        return Err(invalid("Project Session title exceeds its bound"));
    }
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty() {
        return Ok(None);
    }
    let utf16 = normalized.encode_utf16().collect::<Vec<_>>();
    if utf16.len() <= MAX_MANUAL_TITLE_UTF16 {
        return Ok(Some(normalized));
    }
    let prefix = String::from_utf16_lossy(&utf16[..MAX_MANUAL_TITLE_UTF16 - 1]);
    Ok(Some(format!("{}…", prefix.trim_end())))
}

fn touch_session(connection: &Connection, session_id: &str, now: &str) -> Result<(), StoreError> {
    let changed = connection.execute(
        "UPDATE project_sessions SET updated_at = ?1 WHERE id = ?2",
        params![now, session_id],
    )?;
    if changed == 1 {
        return Ok(());
    }
    Err(corrupt("Project Session disappeared during mutation"))
}

pub(super) fn validate_id(name: &str, value: &str) -> Result<(), StoreError> {
    if !value.is_empty()
        && value == value.trim()
        && value.len() <= MAX_ID_LENGTH
        && !value.chars().any(char::is_control)
    {
        return Ok(());
    }
    Err(invalid(&format!(
        "{name} must be a canonical identity of at most {MAX_ID_LENGTH} bytes"
    )))
}

pub(super) fn sqlite_now(connection: &Connection) -> Result<String, StoreError> {
    connection
        .query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", [], |row| {
            row.get::<_, String>(0)
        })
        .map_err(Into::into)
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
