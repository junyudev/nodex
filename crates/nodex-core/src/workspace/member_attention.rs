//! Each Member's own attention to a chat: unread state, pins, snoozes and settlement. Shared chat
//! state, such as its title, Project, archive state, activity and attention time, never depends on
//! it.
//!
//! Settling a chat ends that Member's pin, snooze and unread
//! state, and anything that asks for them again reopens it: their own message, marking it unread,
//! a snooze ending, a pin, or its Agent stopping to ask for them.
use crate::infrastructure::sqlite::StoreError;
use rusqlite::{Connection, params};

use crate::infrastructure::local_commit::CommitContext;

/// The local Profile's Member, for native Threads, which exist only on its own desktop.
pub(super) const LOCAL_MEMBER_SQL: &str = "(SELECT member_id FROM local_profile_members LIMIT 1)";

/// Whether `member` keeps the chat `session` unread. Arguments are SQL expressions.
pub(super) fn unread_sql(session: &str, member: &str) -> String {
    format!(
        "EXISTS(SELECT 1 FROM member_session_unread attention WHERE attention.session_id={session} AND attention.member_id={member})"
    )
}

/// Whether `member` pinned the chat `session`. Arguments are SQL expressions.
pub(super) fn pinned_sql(session: &str, member: &str) -> String {
    format!(
        "EXISTS(SELECT 1 FROM member_session_pins member_pin WHERE member_pin.session_id={session} AND member_pin.member_id={member})"
    )
}

/// Where `member` keeps the chat `session` among their pins, or NULL.
pub(super) fn pinned_order_sql(session: &str, member: &str) -> String {
    format!(
        "(SELECT member_pin.pinned_order FROM member_session_pins member_pin WHERE member_pin.session_id={session} AND member_pin.member_id={member})"
    )
}

/// When `member` asked to be snoozed of the chat `session`, or NULL.
pub(super) fn snoozed_until_sql(session: &str, member: &str) -> String {
    format!(
        "(SELECT member_snooze.snoozed_until FROM member_session_snoozes member_snooze WHERE member_snooze.session_id={session} AND member_snooze.member_id={member})"
    )
}

pub(super) fn snoozed_at_sql(session: &str, member: &str) -> String {
    format!(
        "(SELECT s.snoozed_at FROM member_session_snoozes s WHERE s.session_id={session} AND s.member_id={member})"
    )
}

pub(super) fn woke_at_sql(session: &str, member: &str) -> String {
    format!(
        "(SELECT w.woke_at FROM member_session_wakes w WHERE w.session_id={session} AND w.member_id={member})"
    )
}

/// When `member` settled the chat `session` (Unix ms), or NULL. Arguments are SQL expressions.
pub(super) fn settled_at_sql(session: &str, member: &str) -> String {
    format!(
        "(SELECT member_settled.settled_at FROM member_session_settled member_settled WHERE member_settled.session_id={session} AND member_settled.member_id={member})"
    )
}

/// When the chat `session` last came back to a person (Unix ms). The argument is a table alias.
pub(super) fn attention_at_sql(session: &str) -> String {
    format!("max({session}.activity_at, {session}.returned_at)")
}

/// An unread chat asks for its Member again, so it reopens if they had settled it.
pub(super) fn set_unread(
    c: &Connection,
    member: &str,
    session: &str,
    unread: bool,
) -> Result<(), StoreError> {
    if unread {
        c.execute(
            "INSERT OR IGNORE INTO member_session_unread(member_id,session_id) VALUES(?1,?2)",
            params![member, session],
        )?;
        reopen(c, member, session)?;
        return Ok(());
    }
    c.execute(
        "DELETE FROM member_session_unread WHERE member_id=?1 AND session_id=?2",
        params![member, session],
    )?;
    clear_woke(c, member, session)?;
    Ok(())
}

/// Removing a live snooze also wakes any Inbox episodes it deferred.
pub(super) fn cancel_snooze(
    c: &Connection,
    member: &str,
    session: &str,
) -> Result<usize, StoreError> {
    let snooze = c.execute(
        "DELETE FROM member_session_snoozes WHERE member_id=?1 AND session_id=?2",
        params![member, session],
    )?;
    let deliveries = clear_snooze_delivery(c, member, session)?;
    let deferrals = c.execute(
        "DELETE FROM inbox_deferrals WHERE linked_session_id=?2 AND member_id=?1",
        params![member, session],
    )?;
    if deferrals > 0 {
        invalidate(c, session, true)?;
    }
    Ok(snooze + deliveries + deferrals)
}

fn clear_snooze_delivery(c: &Connection, member: &str, session: &str) -> Result<usize, StoreError> {
    Ok(c.execute(
        "DELETE FROM member_session_snooze_deliveries WHERE member_id=?1 AND session_id=?2",
        params![member, session],
    )?)
}

pub(super) fn clear_woke(c: &Connection, member: &str, session: &str) -> Result<bool, StoreError> {
    let cleared = c.execute(
        "DELETE FROM member_session_wakes WHERE member_id=?1 AND session_id=?2",
        params![member, session],
    )? > 0;
    if cleared {
        clear_snooze_delivery(c, member, session)?;
    }
    Ok(cleared)
}

pub(super) fn wake_for_request(
    c: &Connection,
    member: &str,
    session: &str,
    asked_at: i64,
) -> Result<(), StoreError> {
    if c.query_row(
        "SELECT EXISTS(SELECT 1 FROM member_session_snoozes
           WHERE member_id=?1 AND session_id=?2 AND COALESCE(snoozed_at,0)<?3)",
        params![member, session, asked_at],
        |row| row.get::<_, bool>(0),
    )? {
        cancel_snooze(c, member, session)?;
    }
    Ok(())
}

/// Store one Member's snooze and end any pin and earlier return.
pub(super) fn snooze_chat(
    c: &Connection,
    member: &str,
    session: &str,
    until: &str,
    now: &str,
) -> Result<(), StoreError> {
    super::sidebar_pins::unpin(c, member, session, now)?;
    clear_woke(c, member, session)?;
    clear_snooze_delivery(c, member, session)?;
    let at = super::session_mutation::store_clock_ms(c, now)?;
    c.execute(
        "INSERT INTO member_session_snoozes(member_id,session_id,snoozed_until,snoozed_at)
         VALUES(?1,?2,?3,?4) ON CONFLICT(member_id,session_id) DO UPDATE
         SET snoozed_until=excluded.snoozed_until,snoozed_at=excluded.snoozed_at",
        params![member, session, until, at],
    )?;
    Ok(())
}

pub(super) fn record_woke(
    c: &Connection,
    member: &str,
    session: &str,
    now: &str,
) -> Result<(), StoreError> {
    let at = super::session_mutation::store_clock_ms(c, now)?;
    c.execute(
        "INSERT INTO member_session_wakes(member_id,session_id,woke_at) VALUES(?1,?2,?3)
         ON CONFLICT(member_id,session_id) DO UPDATE SET woke_at=excluded.woke_at",
        params![member, session, at],
    )?;
    Ok(())
}

/// Settles the chat for `member` at `settled_at` (Unix ms), keeping an earlier mark where it is.
/// Returns whether it was open.
pub(super) fn settle_chat(
    c: &Connection,
    member: &str,
    session: &str,
    settled_at: i64,
) -> Result<bool, StoreError> {
    Ok(c.execute(
        "INSERT INTO member_session_settled(member_id,session_id,settled_at) VALUES(?1,?2,?3) \
         ON CONFLICT(member_id,session_id) DO NOTHING",
        params![member, session, settled_at],
    )? > 0)
}

/// Reopens a settled chat for `member`. Returns whether it was settled.
pub(super) fn reopen(c: &Connection, member: &str, session: &str) -> Result<bool, StoreError> {
    Ok(c.execute(
        "DELETE FROM member_session_settled WHERE member_id=?1 AND session_id=?2",
        params![member, session],
    )? > 0)
}

/// Shared eligibility for both automatic settlement triggers. Requires left-joined native Thread
/// and execution observation rows. An execution binding alone can still be an unstarted draft.
pub(super) fn automatic_settlement_sql(library: &str, member: &str) -> String {
    format!(
        "session.archived=0 AND {listed} AND {in_library}
         AND (thread.thread_id IS NOT NULL
              OR EXISTS(SELECT 1 FROM project_session_user_message_receipts r WHERE r.session_id=session.id)
              OR json_extract(observation.observed_json,'$.runStartedAt') IS NOT NULL)
         AND thread.status_type IS NOT 'active'
         AND COALESCE(json_extract(observation.observed_json,'$.state'),'idle') NOT IN ('working','queued','waiting')
         AND {settled} IS NULL AND NOT {pinned} AND NOT {unread} AND {snoozed} IS NULL
         AND NOT EXISTS(SELECT 1 FROM member_session_snooze_deliveries delivery
             WHERE delivery.session_id=session.id AND delivery.member_id={member})",
        listed = super::task_window::LISTED_CHAT_SQL,
        in_library = super::task_window::listed_in_library_sql(library),
        settled = settled_at_sql("session.id", member),
        pinned = pinned_sql("session.id", member),
        unread = unread_sql("session.id", member),
        snoozed = snoozed_until_sql("session.id", member),
    )
}

pub(crate) fn settle_done_page_chat(
    c: &Connection,
    page: &str,
    now: &str,
) -> Result<(), StoreError> {
    let Some(active) = super::page_chat::active_chat(c, page)? else {
        return Ok(());
    };
    let at = super::session_mutation::store_clock_ms(c, now)?;
    let eligible = automatic_settlement_sql("page.library_id", "member.id");
    let changed = c.execute(
        &format!(
            "INSERT INTO member_session_settled(member_id,session_id,settled_at)
             SELECT member.id,session.id,?3 FROM pages page
             JOIN members member ON member.library_id=page.library_id AND member.lifecycle='active'
             JOIN project_sessions session ON session.id=?2
             LEFT JOIN project_session_threads link ON link.session_id=session.id
             LEFT JOIN codex_threads thread ON thread.thread_id=link.thread_id
             LEFT JOIN session_execution_observations observation ON observation.session_id=session.id
             WHERE page.block_id=?1 AND {eligible}"
        ),
        params![page, active.session_id, at],
    )?;
    if changed > 0 {
        c.execute(
            "DELETE FROM member_session_wakes AS wake WHERE wake.session_id=?1
             AND EXISTS(SELECT 1 FROM member_session_settled s
               WHERE s.session_id=wake.session_id AND s.member_id=wake.member_id)",
            [&active.session_id],
        )?;
        invalidate(c, &active.session_id, false)?;
    }
    Ok(())
}

pub(super) fn invalidate(
    c: &Connection,
    session: &str,
    inbox_changed: bool,
) -> Result<(), StoreError> {
    c.execute(
        "INSERT INTO session_attention_dirty(session_id,inbox_changed) VALUES(?1,?2)
         ON CONFLICT(session_id) DO UPDATE SET inbox_changed=max(inbox_changed,excluded.inbox_changed)",
        params![session, inbox_changed],
    )?;
    Ok(())
}

/// Changes originating outside a chat command still invalidate chat lists and exact chat reads.
pub(crate) fn publish_invalidations(
    c: &Connection,
    commit: &CommitContext,
) -> Result<(), StoreError> {
    use crate::infrastructure::event_log::{NewChangeLogEntry, append_change_log};
    use nodex_core_contracts::events::ProjectionImpact;
    use serde_json::json;
    if !c.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name='session_attention_dirty')",
        [],
        |row| row.get::<_, bool>(0),
    )? {
        return Ok(());
    }
    let rows = c.prepare(
        "SELECT dirty.session_id,session.project_id,dirty.inbox_changed
         FROM session_attention_dirty dirty LEFT JOIN project_sessions session ON session.id=dirty.session_id
         ORDER BY dirty.session_id",
    )?.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?, row.get::<_, bool>(2)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if rows.is_empty() {
        return Ok(());
    }
    c.execute("DELETE FROM session_attention_dirty", [])?;
    let mut scopes = Vec::new();
    let mut projects = std::collections::BTreeSet::new();
    let mut sessions = Vec::new();
    let mut inbox_changed = false;
    for (session, project, inbox) in rows {
        let scope = super::mutation::project_session_scope(project.as_deref());
        if !scopes.contains(&scope) {
            scopes.push(scope);
        }
        projects.extend(project);
        sessions.push(session);
        inbox_changed |= inbox;
    }
    append_change_log(
        c,
        NewChangeLogEntry {
            project_id: None,
            store_epoch: commit.store_epoch(),
            kind: "project_workspace.changed",
            operation_id: Some(commit.operation_id()),
            block_ids: &[],
            document_ids: &[],
            database_block_ids: &[],
            payload_json: &json!({
                "module": "project_workspace", "kind": "workspace_changed",
                "operationKind": "session_attention", "inboxChanged": inbox_changed,
                "projectIds": projects, "sessionIds": sessions, "threadIds": [],
                "sessionSummaryScopes": scopes, "sessionDetailIds": sessions,
            })
            .to_string(),
            projection_impact: &ProjectionImpact::None,
            committed_at: commit.committed_at(),
        },
        commit,
    )?;
    Ok(())
}
