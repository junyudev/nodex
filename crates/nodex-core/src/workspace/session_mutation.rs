use std::collections::BTreeSet;

use nodex_core_contracts::BoundModuleContext;
use nodex_core_contracts::workspace::{ProjectSessionIntent, RuntimeMessageRequester};
use rusqlite::{Connection, OptionalExtension, params};

use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

use super::ProjectWorkspaceApplyOutcome;
use super::mutation::{
    WorkspaceMutationEffects, finish_mutation, finish_no_op, project_session_scope,
};
use super::thread::{finish_thread_mutation, upsert_thread_records};

const MAX_ID_LENGTH: usize = 512;
const MAX_SESSION_TITLE_BYTES: usize = 8_000;
const MAX_MANUAL_TITLE_UTF16: usize = 60;

pub(super) struct SessionAuthority {
    pub(super) project_id: Option<String>,
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
    if matches!(
        intent,
        ProjectSessionIntent::Rename { .. }
            | ProjectSessionIntent::SetArchived { .. }
            | ProjectSessionIntent::SetPinned { .. }
            | ProjectSessionIntent::SetFallbackTitle { .. }
            | ProjectSessionIntent::RecordUserMessage { .. }
            | ProjectSessionIntent::AdmitRuntimeMessage { .. }
            | ProjectSessionIntent::RecordAgentMessage { .. }
            | ProjectSessionIntent::LinkThread { .. }
            | ProjectSessionIntent::UnlinkThread { .. }
    ) {
        super::decision_run::require_chat(connection, session_id)?;
    }
    // A chat's title and lifecycle are shared by every Member; Core decides who may change them.
    if matches!(
        intent,
        ProjectSessionIntent::Rename { .. } | ProjectSessionIntent::SetArchived { .. }
    ) {
        super::chat_stewardship::require(
            connection,
            library_id,
            context,
            session_id,
            super::chat_stewardship::ChatControl::Manage,
        )?;
    }
    match intent {
        ProjectSessionIntent::RecordOpened => super::session_usage::record_opened(
            connection,
            library_id,
            context,
            store_epoch,
            operation_id,
            request_hash,
            session_id,
            &authority,
        ),
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
        ProjectSessionIntent::RecordAttention { seen, asked_at } => record_session_attention(
            connection,
            library_id,
            context,
            store_epoch,
            operation_id,
            request_hash,
            session_id,
            &authority,
            *seen,
            *asked_at,
        ),
        ProjectSessionIntent::SetSnooze { snoozed_until } => set_session_snooze(
            connection,
            library_id,
            context,
            store_epoch,
            operation_id,
            request_hash,
            session_id,
            &authority,
            &crate::infrastructure::actors::requesting_member(connection, context)?,
            snoozed_until.as_deref(),
            None,
            false,
        ),
        ProjectSessionIntent::ConsumeSnooze {
            member_id,
            snoozed_until,
            deliver,
        } => {
            validate_id("member_id", member_id)?;
            set_session_snooze(
                connection,
                library_id,
                context,
                store_epoch,
                operation_id,
                request_hash,
                session_id,
                &authority,
                member_id,
                None,
                Some(snoozed_until),
                *deliver,
            )
        }
        ProjectSessionIntent::DeferSnoozeDelivery { delivery_id } => {
            validate_id("delivery_id", delivery_id)?;
            connection.execute("UPDATE member_session_snooze_deliveries SET next_attempt_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+30 seconds') WHERE delivery_id=?1 AND session_id=?2", params![delivery_id,session_id])?;
            finish_session_mutation(
                connection,
                library_id,
                context,
                store_epoch,
                operation_id,
                request_hash,
                "defer_session_snooze",
                session_id,
                &authority,
                Vec::new(),
                SessionInvalidationKind::None,
                sqlite_now(connection)?,
            )
        }
        ProjectSessionIntent::CompleteSnoozeDelivery {
            delivery_id,
            unread,
        } => {
            validate_id("delivery_id", delivery_id)?;
            let member: Option<String> = connection.query_row("DELETE FROM member_session_snooze_deliveries WHERE delivery_id=?1 AND session_id=?2 RETURNING member_id", params![delivery_id,session_id], |row| row.get(0)).optional()?;
            if *unread && let Some(member) = &member {
                super::member_attention::set_unread(connection, member, session_id, true)?;
            }
            let changed = usize::from(member.is_some());
            finish_session_mutation(
                connection,
                library_id,
                context,
                store_epoch,
                operation_id,
                request_hash,
                "complete_session_snooze",
                session_id,
                &authority,
                Vec::new(),
                if changed == 1 {
                    SessionInvalidationKind::SummaryAndDetail
                } else {
                    SessionInvalidationKind::None
                },
                sqlite_now(connection)?,
            )
        }
        ProjectSessionIntent::RecordUserMessage { message_id }
        | ProjectSessionIntent::AdmitRuntimeMessage { message_id, .. } => {
            let now = sqlite_now(connection)?;
            let changed = if let ProjectSessionIntent::AdmitRuntimeMessage { requester, .. } =
                intent
            {
                if authority.archived {
                    return Err(not_found("The Runtime chat is unavailable"));
                }
                admit_runtime_message(connection, context, session_id, message_id, requester, &now)?
            } else {
                accept_person_message(
                    connection,
                    session_id,
                    message_id,
                    &crate::infrastructure::actors::requesting_member(connection, context)?,
                    &now,
                )?
            };
            finish_session_mutation(
                connection,
                library_id,
                context,
                store_epoch,
                operation_id,
                request_hash,
                "record_session_user_message",
                session_id,
                &authority,
                Vec::new(),
                if changed {
                    SessionInvalidationKind::SummaryAndDetail
                } else {
                    SessionInvalidationKind::None
                },
                now,
            )
        }
        ProjectSessionIntent::RecordAgentMessage { message_id } => {
            if !matches!(
                context.adapter,
                nodex_core_contracts::AdapterKind::ElectronHost
                    | nodex_core_contracts::AdapterKind::Test
            ) || context.agent_attribution.is_some()
            {
                return Err(StoreError::new(
                    StoreErrorCode::Unauthorized,
                    "Accepted Agent messages require their execution Host",
                    false,
                ));
            }
            let now = sqlite_now(connection)?;
            if !adopt_run_session(connection, session_id, message_id)? {
                return finish_no_op(
                    connection,
                    context,
                    store_epoch,
                    operation_id,
                    request_hash,
                    "record_session_agent_message",
                    Vec::new(),
                    Vec::new(),
                    &now,
                );
            }
            finish_session_mutation(
                connection,
                library_id,
                context,
                store_epoch,
                operation_id,
                request_hash,
                "record_session_agent_message",
                session_id,
                &authority,
                Vec::new(),
                SessionInvalidationKind::SummaryAndDetail,
                now,
            )
        }
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
        ProjectSessionIntent::SetFallbackTitle { title, replaces } => set_fallback_title(
            connection,
            library_id,
            context,
            store_epoch,
            operation_id,
            request_hash,
            session_id,
            &authority,
            title,
            replaces.as_deref(),
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
        ProjectSessionIntent::LinkPage { page_id } => super::page_chat::link_page(
            connection,
            library_id,
            context,
            store_epoch,
            operation_id,
            request_hash,
            session_id,
            &authority,
            page_id,
            super::page_chat::PageLinkIntent::Related,
        ),
        ProjectSessionIntent::HandOffPage { page_id } => super::page_chat::link_page(
            connection,
            library_id,
            context,
            store_epoch,
            operation_id,
            request_hash,
            session_id,
            &authority,
            page_id,
            super::page_chat::PageLinkIntent::HandOff,
        ),
        ProjectSessionIntent::UnlinkPage { page_id } => super::page_chat::unlink_page(
            connection,
            library_id,
            context,
            store_epoch,
            operation_id,
            request_hash,
            session_id,
            &authority,
            page_id,
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
    replaces: Option<&str>,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    let title = normalize_fallback_title(title)?;
    let now = sqlite_now(connection)?;
    let changed = connection.execute(
        "UPDATE project_sessions SET no_thread_fallback_title = ?1, updated_at = ?2 \
         WHERE id = ?3 AND (?4 IS NULL OR no_thread_fallback_title = ?4)",
        params![title, now, session_id, replaces.map(str::trim)],
    )?;
    if changed != 1 && replaces.is_none() {
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
        if changed == 1 {
            SessionInvalidationKind::SummaryAndDetail
        } else {
            SessionInvalidationKind::None
        },
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
    let member = crate::infrastructure::actors::requesting_member(connection, context)?;
    if pinned {
        connection.execute(
            "DELETE FROM workspace_sidebar_section_items WHERE session_id = ?1",
            [session_id],
        )?;
        super::sidebar_pins::pin(connection, &member, session_id, &now)?;
    } else {
        super::sidebar_pins::unpin(connection, &member, session_id, &now)?;
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
        authority.thread_id.iter().cloned().collect(),
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
    if unread && authority.archived {
        return finish_session_mutation(
            connection,
            library_id,
            context,
            store_epoch,
            operation_id,
            request_hash,
            "set_session_unread",
            session_id,
            authority,
            Vec::new(),
            SessionInvalidationKind::None,
            now,
        );
    }
    super::member_attention::set_unread(
        connection,
        &crate::infrastructure::actors::requesting_member(connection, context)?,
        session_id,
        unread,
    )?;
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

/// Settling a chat ends the requesting Member's pin, snooze and unread state. Reopening
/// leaves the chat's shared activity and attention time alone, so it returns exactly where it was.
#[allow(clippy::too_many_arguments)]
pub(super) fn set_sessions_settled(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    session_ids: &[String],
    settled: bool,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    use super::member_attention;
    if !(1..=200).contains(&session_ids.len())
        || session_ids.iter().collect::<BTreeSet<_>>().len() != session_ids.len()
    {
        return Err(invalid("Choose 1–200 distinct Session ids"));
    }
    let member = crate::infrastructure::actors::requesting_member(connection, context)?;
    let now = sqlite_now(connection)?;
    let at_ms = store_clock_ms(connection, &now)?;
    let mut changed_ids = Vec::new();
    let mut projects = BTreeSet::new();
    let mut threads = Vec::new();
    let mut scopes = Vec::new();
    for id in session_ids {
        validate_id("session_id", id)?;
        let authority = require_session(connection, library_id, id)?;
        super::decision_run::require_chat(connection, id)?;
        let changed = if settled {
            !authority.archived && member_attention::settle_chat(connection, &member, id, at_ms)?
        } else {
            member_attention::reopen(connection, &member, id)?
        };
        if !changed {
            continue;
        }
        if settled {
            super::sidebar_pins::unpin(connection, &member, id, &now)?;
            member_attention::cancel_snooze(connection, &member, id)?;
            member_attention::set_unread(connection, &member, id, false)?;
        }
        let scope = project_session_scope(authority.project_id.as_deref());
        if !scopes.contains(&scope) {
            scopes.push(scope);
        }
        projects.extend(authority.project_id);
        threads.extend(authority.thread_id);
        changed_ids.push(id.clone());
    }
    if changed_ids.is_empty() {
        return super::mutation::finish_no_op(
            connection,
            context,
            store_epoch,
            operation_id,
            request_hash,
            "set_sessions_settled",
            vec![],
            vec![],
            &now,
        );
    }
    super::session_lifecycle::finish_lifecycle_mutation(
        connection,
        library_id,
        context,
        store_epoch,
        operation_id,
        request_hash,
        "set_sessions_settled",
        projects.into_iter().collect(),
        changed_ids,
        threads,
        scopes,
        None,
        &[],
        now,
    )
}

/// The chat's Agent stopped and asks for the requesting Member. Its attention time is shared, so
/// the chat comes back for everyone; it reopens, and turns unread, only for that Member.
#[allow(clippy::too_many_arguments)]
fn record_session_attention(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    session_id: &str,
    authority: &SessionAuthority,
    seen: bool,
    asked_at: Option<i64>,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    let now = sqlite_now(connection)?;
    if authority.archived {
        return finish_session_mutation(
            connection,
            library_id,
            context,
            store_epoch,
            operation_id,
            request_hash,
            "record_session_attention",
            session_id,
            authority,
            Vec::new(),
            SessionInvalidationKind::None,
            now,
        );
    }
    connection.execute(
        "UPDATE project_sessions SET returned_at = max(returned_at, ?2) WHERE id = ?1",
        params![session_id, store_clock_ms(connection, &now)?],
    )?;
    let member = crate::infrastructure::actors::requesting_member(connection, context)?;
    if let Some(asked_at) = asked_at {
        if asked_at < 0 {
            return Err(invalid("asked_at must be a Unix millisecond instant"));
        }
        super::member_attention::wake_for_request(connection, &member, session_id, asked_at)?;
    }
    super::member_attention::reopen(connection, &member, session_id)?;
    if seen {
        super::member_attention::clear_woke(connection, &member, session_id)?;
    } else {
        super::member_attention::set_unread(connection, &member, session_id, true)?;
    }
    finish_session_mutation(
        connection,
        library_id,
        context,
        store_epoch,
        operation_id,
        request_hash,
        "record_session_attention",
        session_id,
        authority,
        authority.thread_id.iter().cloned().collect(),
        SessionInvalidationKind::SummaryAndDetail,
        now,
    )
}

/// Snooze deadlines have one canonical UTC millisecond representation in storage and projections.
#[allow(clippy::too_many_arguments)]
fn set_session_snooze(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    session_id: &str,
    authority: &SessionAuthority,
    member: &str,
    snoozed_until: Option<&str>,
    expected: Option<&str>,
    deliver: bool,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    use chrono::{DateTime, Duration, SecondsFormat};
    let now = sqlite_now(connection)?;
    let clock =
        DateTime::parse_from_rfc3339(&now).map_err(|_| corrupt("Store clock is invalid"))?;
    let normalized = snoozed_until
        .map(|value| {
            let instant = DateTime::parse_from_rfc3339(value)
                .map_err(|_| invalid("snoozed_until must be an ISO 8601 instant with an offset"))?;
            if instant > clock + Duration::days(366) {
                return Err(invalid(
                    "snoozed_until must be no more than 366 days in the future",
                ));
            }
            let settled: bool = connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM member_session_settled WHERE member_id=?1 AND session_id=?2)",
                params![member,session_id], |row| row.get(0),
            )?;
            if authority.archived || settled {
                return Err(invalid("Only open chats can have a snooze"));
            }
            Ok(instant
                .to_utc()
                .to_rfc3339_opts(SecondsFormat::Millis, true))
        })
        .transpose()?;
    let changed = match (expected, normalized.as_deref()) {
        // The host claims only the exact snooze it observed coming due.
        (Some(expected), _) => connection.execute(
            "DELETE FROM member_session_snoozes WHERE member_id = ?1 AND session_id = ?2 \
             AND snoozed_until = ?3 AND julianday(snoozed_until) <= julianday(?4) \
             AND EXISTS (SELECT 1 FROM project_sessions WHERE id = ?2 AND archived = 0)",
            params![member, session_id, expected, now],
        )?,
        (None, Some(snoozed_until)) => {
            super::member_attention::snooze_chat(
                connection,
                member,
                session_id,
                snoozed_until,
                &now,
            )?;
            super::inbox::snooze::link_chat_turns(
                connection,
                member,
                session_id,
                snoozed_until,
                &now,
            )?;
            1
        }
        (None, None) => super::member_attention::cancel_snooze(connection, member, session_id)?,
    };
    if changed > 0 && expected.is_some() {
        super::member_attention::record_woke(connection, member, session_id, &now)?;
        let linked: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM inbox_deferrals WHERE linked_session_id=?1 AND member_id=?2)",
            params![session_id,member], |row| row.get(0),
        )?;
        if linked {
            super::member_attention::invalidate(connection, session_id, true)?;
        }
    }
    if changed > 0 && deliver {
        connection.execute("INSERT INTO member_session_snooze_deliveries(delivery_id,member_id,session_id,snoozed_until,next_attempt_at) VALUES (?1,?2,?3,?4,?5)", params![operation_id,member,session_id,expected,now])?;
    }
    // A snooze that comes due brings its chat back to the top, like a person's message. Chat
    // order is shared, so only a personal Space's one Member reorders it with their snooze.
    if changed > 0
        && expected.is_some()
        && crate::infrastructure::actors::is_personal(connection, library_id)?
    {
        super::session_order::raise_activity(connection, session_id, &now)?;
    }
    finish_session_mutation(
        connection,
        library_id,
        context,
        store_epoch,
        operation_id,
        request_hash,
        if expected.is_some() {
            "consume_session_snooze"
        } else {
            "set_session_snooze"
        },
        session_id,
        authority,
        Vec::new(),
        if changed > 0 {
            SessionInvalidationKind::SummaryAndDetail
        } else {
            SessionInvalidationKind::None
        },
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
            "UPDATE project_sessions SET archived = 1, archived_at = ?1, is_default_draft = 0, \
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
    if super::agent_runtime_binding::is_runtime_bound(connection, session_id)? {
        return Err(StoreError::new(
            StoreErrorCode::Conflict,
            "Session execution belongs to Agent Runtime",
            false,
        ));
    }
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
    if let Some(previous_thread_id) = authority.thread_id.as_deref().filter(|id| *id != thread_id) {
        super::sidebar_pins::clear_thread_projection(connection, previous_thread_id)?;
    }
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
        "UPDATE project_sessions SET is_default_draft = 0, updated_at = ?1 WHERE id = ?2",
        params![now, session_id],
    )?;
    super::member_attention::set_unread(
        connection,
        &crate::infrastructure::actors::requesting_member(connection, context)?,
        session_id,
        unread == 1,
    )?;
    super::sidebar_pins::sync_thread_projection(connection, session_id, &now)?;
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
    super::sidebar_pins::clear_thread_projection(connection, thread_id)?;
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
    _library_id: &str,
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
    let change_project_id = authority.project_id.clone();
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
            session_ids: match invalidation {
                SessionInvalidationKind::None => Vec::new(),
                SessionInvalidationKind::SummaryAndDetail => vec![session_id.to_owned()],
            },
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
            "SELECT session.project_id, link.thread_id, session.is_default_draft, session.archived \
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
                    thread_id: row.get(1)?,
                    is_default_draft: row.get::<_, i64>(2)? == 1,
                    archived: row.get::<_, i64>(3)? == 1,
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

fn admit_runtime_message(
    connection: &Connection,
    context: &BoundModuleContext,
    session: &str,
    message: &str,
    requester: &RuntimeMessageRequester,
    now: &str,
) -> Result<bool, StoreError> {
    let bound: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM project_session_execution_bindings WHERE session_id=?1)",
        [session],
        |row| row.get(0),
    )?;
    if !bound {
        return Err(not_found("The Runtime chat is unavailable"));
    }
    let member = context
        .actor
        .member_id()
        .or(context.authorizing_member_id.as_deref())
        .ok_or_else(|| {
            StoreError::new(
                StoreErrorCode::Unauthorized,
                "The Runtime message requires its requesting Member",
                false,
            )
        })?;
    let evidence: Option<(String, bool)> = connection
        .query_row(
            "SELECT member_id, EXISTS (
                 SELECT 1 FROM project_session_user_message_receipts receipt
                 WHERE receipt.session_id=requester.session_id AND receipt.message_id=requester.message_id
             )
             FROM session_requesting_members requester WHERE session_id=?1 AND message_id=?2",
            params![session, message],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let member = if let Some((accepted_by, has_receipt)) = &evidence {
        if accepted_by != member
            && !(matches!(requester, RuntimeMessageRequester::Member)
                && context.principal.is_none()
                && connection.query_row(
                    "SELECT EXISTS(SELECT 1 FROM inbox_handoffs handoff JOIN inbox_proposals proposal USING(proposal_id)
                     WHERE proposal.dispatch_session_id=?1 AND handoff.message_id=?2)",
                    params![session, message],
                    |row| row.get::<_, bool>(0),
                )?)
        {
            return Err(StoreError::new(
                StoreErrorCode::Conflict,
                "This message identity was accepted for another Member",
                false,
            ));
        }
        if *has_receipt {
            return Ok(false);
        }
        // Earlier Inbox confirmations could leave requester evidence without the receipt.
        // Complete acceptance for that Member even when the local Host drains the handoff.
        accepted_by
    } else {
        member
    };
    if matches!(
        requester,
        RuntimeMessageRequester::Member | RuntimeMessageRequester::Automation
    ) {
        return accept_person_message(connection, session, message, member, now);
    }
    accept_message(connection, session, message, member, now, false)?;
    adopt_run_session(connection, session, message)
}

/// A person's newly accepted message becomes the Session's activity, ends their snooze and
/// reopens the chat for them. Receipts keep retries and restarts idempotent. Returns whether the
/// Session changed.
pub(super) fn accept_person_message(
    connection: &Connection,
    session_id: &str,
    message_id: &str,
    member: &str,
    now: &str,
) -> Result<bool, StoreError> {
    accept_message(connection, session_id, message_id, member, now, true)
}

fn accept_message(
    connection: &Connection,
    session_id: &str,
    message_id: &str,
    member: &str,
    now: &str,
    person_action: bool,
) -> Result<bool, StoreError> {
    validate_id("message_id", message_id)?;
    let accepted = connection.execute(
        "INSERT INTO project_session_user_message_receipts(session_id, message_id) VALUES (?1, ?2) ON CONFLICT DO NOTHING",
        params![session_id, message_id],
    )?;
    connection.execute(
        "INSERT INTO session_requesting_members(session_id,message_id,member_id,accepted_at) VALUES(?1,?2,?3,?4) ON CONFLICT(session_id,message_id) DO NOTHING",
        params![session_id, message_id, member, now],
    )?;
    if accepted == 0 {
        return Ok(false);
    }
    connection.execute("INSERT OR IGNORE INTO page_turn_dirty SELECT page_id FROM page_active_chats WHERE session_id=?1",[session_id])?;
    if !person_action {
        return Ok(false);
    }
    let moved = super::session_order::raise_activity(connection, session_id, now)?;
    let cancelled = super::member_attention::cancel_snooze(connection, member, session_id)?;
    let reopened = super::member_attention::reopen(connection, member, session_id)?;
    let seen = super::member_attention::clear_woke(connection, member, session_id)?;
    let adopted = adopt_run_session(connection, session_id, message_id)?;
    Ok(moved || cancelled > 0 || reopened || seen || adopted)
}

/// Direct dispatches carry their exact Automation message ID. The delivery record covers
/// a follow-up racing the initial run binding after the runtime has accepted the dispatch.
fn adopt_run_session(
    connection: &Connection,
    session_id: &str,
    message_id: &str,
) -> Result<bool, StoreError> {
    validate_id("message_id", message_id)?;
    let changed = connection.execute(
        "INSERT INTO automation_run_session_adoptions(session_id)
         SELECT ?1 WHERE NOT EXISTS (
           SELECT 1 FROM automation_execution_runs WHERE message_id=?2
         ) AND (
           EXISTS (
             SELECT 1 FROM automation_execution_runs run
             JOIN automations definition ON definition.automation_id=run.automation_id
             WHERE run.session_id=?1 AND definition.kind='cron' AND definition.trigger_kind='clock'
           ) OR EXISTS (
             SELECT 1 FROM chat_message_deliveries delivery
             JOIN automation_execution_runs run ON run.message_id=delivery.delivery_id
             JOIN automations definition ON definition.automation_id=run.automation_id
             WHERE delivery.session_id=?1 AND run.session_id IS NULL
               AND definition.kind='cron' AND definition.trigger_kind='clock'
           )
         ) ON CONFLICT DO NOTHING",
        params![session_id, message_id],
    )?;
    Ok(changed > 0)
}

pub(super) fn sqlite_now(connection: &Connection) -> Result<String, StoreError> {
    connection
        .query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", [], |row| {
            row.get::<_, String>(0)
        })
        .map_err(Into::into)
}

/// A Store clock reading (RFC 3339) in Unix milliseconds.
pub(super) fn store_clock_ms(connection: &Connection, now: &str) -> Result<i64, StoreError> {
    connection
        .query_row(
            "SELECT CAST(round(unixepoch(?1, 'subsec') * 1000) AS INTEGER)",
            [now],
            |row| row.get::<_, i64>(0),
        )
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
