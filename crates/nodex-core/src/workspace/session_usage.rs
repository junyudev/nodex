use nodex_core_contracts::BoundModuleContext;
use rusqlite::{Connection, OptionalExtension, params};

use super::ProjectWorkspaceApplyOutcome;
use super::session_mutation::{SessionAuthority, SessionInvalidationKind, finish_session_mutation};
use crate::infrastructure::sqlite::StoreError;

const OPEN_DEDUPE_MS: i64 = 10 * 60 * 1000;
const OPEN_HALF_LIFE_MS: f64 = 14.0 * 24.0 * 60.0 * 60.0 * 1000.0;

/// Opens measure foreground navigation, independently of receipts and conversation activity.
fn next_open(previous: Option<(i64, f64)>, at: i64) -> (i64, f64) {
    let Some((opened_at, score)) = previous else {
        return (at, 1.0);
    };
    if at - opened_at < OPEN_DEDUPE_MS {
        return (opened_at, score);
    }
    (
        at,
        score * 2_f64.powf(-((at - opened_at) as f64) / OPEN_HALF_LIFE_MS) + 1.0,
    )
}

#[allow(clippy::too_many_arguments)]
pub(super) fn record_opened(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    session_id: &str,
    authority: &SessionAuthority,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    let (at, committed_at): (i64, String) = connection.query_row(
        "SELECT CAST(round(unixepoch('now', 'subsec') * 1000) AS INTEGER), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    let previous = connection
        .query_row(
            "SELECT opened_at, score FROM project_session_usage WHERE session_id = ?1",
            [session_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let (opened_at, score) = next_open(previous, at);
    if previous != Some((opened_at, score)) {
        connection.execute(
            "INSERT INTO project_session_usage(session_id, opened_at, score) VALUES (?1, ?2, ?3) ON CONFLICT(session_id) DO UPDATE SET opened_at = excluded.opened_at, score = excluded.score",
            params![session_id, opened_at, score],
        )?;
    }
    finish_session_mutation(
        connection,
        library_id,
        context,
        store_epoch,
        operation_id,
        request_hash,
        "record_session_opened",
        session_id,
        authority,
        vec![],
        SessionInvalidationKind::None,
        committed_at,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opens_dedupe_without_extending_the_window_and_decay_over_fourteen_days() {
        let first = next_open(None, 1_000);
        assert_eq!(first, (1_000, 1.0));
        assert_eq!(next_open(Some(first), 600_999), first);
        assert_eq!(next_open(Some(first), 0), first);
        assert!(next_open(Some(first), 601_000).1 > 1.99);
        assert_eq!(
            next_open(Some(first), 1_000 + OPEN_HALF_LIFE_MS as i64),
            (1_000 + OPEN_HALF_LIFE_MS as i64, 1.5)
        );
    }
}
