//! Session pin positions are shared by draft, Codex, and ACP sidebar projections.
use std::collections::{BTreeSet, VecDeque};

use rusqlite::{Connection, params};

use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

pub(super) const MAX_PINNED_SESSIONS: usize = 100_000;

pub(super) struct PinnedSession {
    pub id: String,
    pub project_id: Option<String>,
    pub thread_id: Option<String>,
    pub title: String,
    pub rank: i64,
}

pub(super) fn read_order(
    connection: &Connection,
    library_id: &str,
) -> Result<Vec<PinnedSession>, StoreError> {
    let rows = connection
        .prepare(
            "SELECT session.id, session.project_id, thread.thread_id, \
           COALESCE(NULLIF(trim(thread.thread_name), ''), session.no_thread_fallback_title), \
           COALESCE(session.pinned_order, 9223372036854775807) \
         FROM project_sessions session \
         LEFT JOIN project_session_threads link ON link.session_id = session.id \
         LEFT JOIN codex_threads thread ON thread.thread_id = link.thread_id \
         WHERE session.pinned = 1 AND session.archived = 0 \
           AND (thread.thread_id IS NULL OR thread.parent_thread_id IS NULL) \
           AND (session.project_id IS NULL OR EXISTS (\
             SELECT 1 FROM projects project WHERE project.id = session.project_id \
               AND project.library_id = ?1 AND project.lifecycle <> 'archived')) \
         ORDER BY COALESCE(session.pinned_order, 9223372036854775807), session.id LIMIT ?2",
        )?
        .query_map(
            params![
                library_id,
                i64::try_from(MAX_PINNED_SESSIONS + 1).expect("bounded pin count")
            ],
            |row| {
                Ok(PinnedSession {
                    id: row.get(0)?,
                    project_id: row.get(1)?,
                    thread_id: row.get(2)?,
                    title: row.get(3)?,
                    rank: row.get(4)?,
                })
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if rows.len() > MAX_PINNED_SESSIONS {
        return Err(StoreError::new(
            StoreErrorCode::InvalidInput,
            "Pinned Session order exceeds its bound",
            false,
        ));
    }
    Ok(rows)
}

pub(super) fn next_order(connection: &Connection) -> Result<i64, StoreError> {
    connection
        .query_row(
            "SELECT COALESCE(MAX(pinned_order), -1) + 1 FROM project_sessions WHERE pinned = 1",
            [],
            |row| row.get(0),
        )
        .map_err(StoreError::from)
}

pub(super) fn clear_thread_projection(
    connection: &Connection,
    thread_id: &str,
) -> Result<(), StoreError> {
    connection.execute(
        "DELETE FROM codex_pinned_threads WHERE thread_id = ?1",
        [thread_id],
    )?;
    Ok(())
}

/// Attached Threads mirror their Session's pin without acquiring another position authority.
pub(super) fn sync_thread_projection(
    connection: &Connection,
    session_id: &str,
    now: &str,
) -> Result<(), StoreError> {
    connection.execute(
        "DELETE FROM codex_pinned_threads WHERE thread_id IN (\
           SELECT link.thread_id FROM project_session_threads link \
           JOIN project_sessions session ON session.id = link.session_id \
           WHERE session.id = ?1 AND (session.pinned = 0 OR session.archived = 1))",
        [session_id],
    )?;
    connection.execute(
        "INSERT INTO codex_pinned_threads(thread_id, pinned_order, created_at, updated_at) \
         SELECT link.thread_id, session.pinned_order, ?2, ?2 \
         FROM project_sessions session \
         JOIN project_session_threads link ON link.session_id = session.id \
         JOIN codex_threads thread ON thread.thread_id = link.thread_id \
         WHERE session.id = ?1 AND session.pinned = 1 AND session.archived = 0 \
           AND thread.parent_thread_id IS NULL AND thread.archived = 0 \
         ON CONFLICT(thread_id) DO UPDATE SET pinned_order = excluded.pinned_order, updated_at = excluded.updated_at",
        params![session_id, now],
    )?;
    Ok(())
}

pub(super) fn write_order(
    connection: &Connection,
    session_ids: &[String],
    now: &str,
) -> Result<(), StoreError> {
    for (index, session_id) in session_ids.iter().enumerate() {
        let rank = i64::try_from(index).map_err(|_| {
            StoreError::new(
                StoreErrorCode::InvalidInput,
                "Pinned Session order exceeds its bound",
                false,
            )
        })?;
        connection.execute(
            "UPDATE project_sessions SET pinned_order = ?1, updated_at = ?2 WHERE id = ?3",
            params![rank, now, session_id],
        )?;
        sync_thread_projection(connection, session_id, now)?;
    }
    Ok(())
}

/// A narrower Project or Thread gesture permutes its existing slots in the shared pin order.
pub(super) fn reorder_subset(
    connection: &Connection,
    library_id: &str,
    requested: &[String],
    now: &str,
) -> Result<(), StoreError> {
    let current = read_order(connection, library_id)?;
    let members = current
        .iter()
        .map(|row| row.id.as_str())
        .collect::<BTreeSet<_>>();
    let mut seen = BTreeSet::new();
    let mut replacement = requested
        .iter()
        .filter(|id| members.contains(id.as_str()) && seen.insert(id.as_str()))
        .cloned()
        .collect::<VecDeque<_>>();
    let ordered = current
        .into_iter()
        .map(|row| {
            if seen.contains(row.id.as_str()) {
                replacement
                    .pop_front()
                    .expect("requested pin slots are complete")
            } else {
                row.id
            }
        })
        .collect::<Vec<_>>();
    write_order(connection, &ordered, now)
}
