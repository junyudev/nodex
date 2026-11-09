//! Each Member's own attention to a chat: unread state, pins and reminders. Shared chat state,
//! such as its title, Project, archive state and activity, never depends on it.
use crate::infrastructure::sqlite::StoreError;
use rusqlite::{Connection, params};

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

/// When `member` asked to be reminded of the chat `session`, or NULL.
pub(super) fn remind_at_sql(session: &str, member: &str) -> String {
    format!(
        "(SELECT member_reminder.remind_at FROM member_session_reminders member_reminder WHERE member_reminder.session_id={session} AND member_reminder.member_id={member})"
    )
}

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
        return Ok(());
    }
    c.execute(
        "DELETE FROM member_session_unread WHERE member_id=?1 AND session_id=?2",
        params![member, session],
    )?;
    Ok(())
}

/// A person's own message ends their reminder of that chat.
pub(super) fn cancel_reminder(
    c: &Connection,
    member: &str,
    session: &str,
) -> Result<usize, StoreError> {
    Ok(c.execute(
        "DELETE FROM member_session_reminders WHERE member_id=?1 AND session_id=?2",
        params![member, session],
    )? + c.execute(
        "DELETE FROM member_session_reminder_deliveries WHERE member_id=?1 AND session_id=?2",
        params![member, session],
    )?)
}
