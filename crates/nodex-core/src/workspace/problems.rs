//! One durable failure streak per semantic scope. Only opened, unresolved problems enter Inbox.
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};
use nodex_core_contracts::sources::*;
use rusqlite::{Connection, OptionalExtension, params};

pub(super) fn invalid(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message, false)
}
pub(super) fn now(c: &Connection) -> Result<i64, StoreError> {
    Ok(c.query_row(
        "SELECT CAST(unixepoch('subsec')*1000 AS INTEGER)",
        [],
        |r| r.get(0),
    )?)
}
pub(super) fn project(c: &Connection, page: Option<&str>) -> Result<Option<String>, StoreError> {
    Ok(c.query_row("SELECT binding.project_id FROM pages p JOIN data_sources source ON source.id=p.parent_id AND p.parent_kind='data_source' JOIN project_database_bindings binding ON binding.database_block_id=source.home_database_block_id AND binding.lifecycle='active' WHERE p.block_id=?1",[page],|r|r.get(0)).optional()?)
}
const COLUMNS: &str = "id,library_id,source_id,page_id,project_id,scope,kind,first_failure_at_ms,last_failure_at_ms,consecutive_failures,summary,fix,evidence_json,opened_at_ms,resolved_at_ms";
fn row(r: &rusqlite::Row<'_>) -> rusqlite::Result<SourceProblem> {
    Ok(SourceProblem {
        id: r.get(0)?,
        library_id: r.get(1)?,
        source_id: r.get(2)?,
        page_id: r.get(3)?,
        project_id: r.get(4)?,
        scope: r.get(5)?,
        kind: r.get(6)?,
        first_failure_at_ms: r.get(7)?,
        last_failure_at_ms: r.get(8)?,
        consecutive_failures: r.get(9)?,
        summary: r.get(10)?,
        fix: match r.get::<_, String>(11)?.as_str() {
            "retry" => ProblemFix::Retry,
            "open_card" => ProblemFix::OpenCard,
            _ => ProblemFix::Reconnect,
        },
        evidence: serde_json::from_str(&r.get::<_, String>(12)?)
            .map_err(|_| rusqlite::Error::InvalidQuery)?,
        opened_at_ms: r.get(13)?,
        resolved_at_ms: r.get(14)?,
    })
}
pub(super) fn get(c: &Connection, library: &str, id: &str) -> Result<SourceProblem, StoreError> {
    c.query_row(
        &format!("SELECT {COLUMNS} FROM problems WHERE library_id=?1 AND id=?2"),
        params![library, id],
        row,
    )
    .optional()?
    .ok_or_else(|| invalid("Problem is unavailable"))
}
pub(super) fn open(
    c: &Connection,
    library: &str,
    source: Option<&str>,
    after: Option<&str>,
    limit: u32,
) -> Result<Vec<SourceProblem>, StoreError> {
    if !(1..=100).contains(&limit) {
        return Err(invalid("Problem limit must be 1–100"));
    }
    Ok(c.prepare(&format!("SELECT {COLUMNS} FROM problems WHERE library_id=?1 AND (?2 IS NULL OR source_id=?2) AND opened_at_ms IS NOT NULL AND resolved_at_ms IS NULL AND (?3 IS NULL OR id>?3) ORDER BY id LIMIT ?4"))?.query_map(params![library,source,after,limit],row)?.collect::<rusqlite::Result<Vec<_>>>()?)
}
pub(super) struct Failure<'a> {
    pub library: &'a str,
    pub source: Option<&'a str>,
    pub page: Option<&'a str>,
    pub scope: &'a str,
    pub kind: &'a str,
    pub summary: &'a str,
    pub fix: &'a str,
    pub evidence: serde_json::Value,
    pub immediate: bool,
}
pub(super) fn fail(c: &Connection, f: Failure<'_>) -> Result<(), StoreError> {
    let at = now(c)?;
    let evidence =
        serde_json::to_string(&f.evidence).map_err(|_| invalid("Invalid problem evidence"))?;
    if evidence.len() > 65536 || f.summary.len() > 2000 {
        return Err(invalid("Problem exceeds its evidence bound"));
    }
    c.execute("INSERT INTO problems(id,library_id,source_id,page_id,project_id,scope,kind,first_failure_at_ms,last_failure_at_ms,consecutive_failures,summary,fix,evidence_json,opened_at_ms) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?8,1,?9,?10,?11,CASE WHEN ?12 THEN ?8 END) ON CONFLICT(library_id,kind,scope) WHERE resolved_at_ms IS NULL DO UPDATE SET last_failure_at_ms=excluded.last_failure_at_ms,consecutive_failures=problems.consecutive_failures+1,summary=excluded.summary,fix=excluded.fix,evidence_json=excluded.evidence_json,opened_at_ms=COALESCE(problems.opened_at_ms,CASE WHEN ?12 OR problems.consecutive_failures+1>=3 THEN ?8 END)",params![crate::domain::identity::random_uuid_v7().map_err(|_|invalid("Problem identity unavailable"))?,f.library,f.source,f.page,project(c,f.page)?,f.scope,f.kind,at,f.summary,f.fix,evidence,f.immediate])?;
    Ok(())
}
pub(super) fn resolve(c: &Connection, library: &str, scope: &str) -> Result<(), StoreError> {
    c.execute("UPDATE problems SET resolved_at_ms=?3 WHERE library_id=?1 AND scope=?2 AND resolved_at_ms IS NULL",params![library,scope,now(c)?])?;
    Ok(())
}
/// A retry re-arms the same frozen intent; it never changes its destination or erases evidence.
pub(super) fn retry(c: &Connection, library: &str, id: &str) -> Result<(), StoreError> {
    let p = get(c, library, id)?;
    if p.opened_at_ms.is_none() || p.resolved_at_ms.is_some() || p.fix != ProblemFix::Retry {
        return Err(invalid("This problem has no Retry action"));
    }
    match p.kind.as_str() {
        "channel_failing" => {
            c.execute("UPDATE channel_outbox SET state='pending',consecutive_failures=0,retry_at_ms=0,lease_token=NULL,lease_expires_at_ms=NULL WHERE id=?1 AND library_id=?2 AND state='failed'",params![p.scope,library])?;
        }
        "delivery_failing" => {
            c.execute("UPDATE thread_delivery_batches SET consecutive_failures=0,retry_at_ms=0 WHERE message_id=?1 AND library_id=?2 AND state='pending'",params![p.scope,library])?;
        }
        _ => return Err(invalid("Unknown retry target")),
    }
    Ok(())
}
pub(super) fn delivery_failure(
    c: &Connection,
    library: &str,
    message: &str,
    reason: &str,
) -> Result<(), StoreError> {
    if reason.trim().is_empty() || reason.len() > 2000 {
        return Err(invalid("Delivery failure requires a bounded reason"));
    }
    let count:Option<i64>=c.query_row("UPDATE thread_delivery_batches SET consecutive_failures=consecutive_failures+1,last_failure=?3,retry_at_ms=?4+min(60000,1000*(1<<min(consecutive_failures,6))) WHERE message_id=?1 AND library_id=?2 AND state='pending' RETURNING consecutive_failures",params![message,library,reason,now(c)?],|r|r.get(0)).optional()?;
    if count.is_none() {
        return Err(invalid("Delivery batch is unavailable"));
    }
    let page: Option<String> = c
        .query_row(
            "SELECT page_id FROM thread_deliveries WHERE message_id=?1 ORDER BY id LIMIT 1",
            [message],
            |r| r.get(0),
        )
        .optional()?;
    fail(
        c,
        Failure {
            library,
            source: None,
            page: page.as_deref(),
            scope: message,
            kind: "delivery_failing",
            summary: "GitHub update could not reach its chat",
            fix: "retry",
            evidence: serde_json::json!({"reason":reason,"message_id":message}),
            immediate: false,
        },
    )
}

pub(super) fn inbox_item(
    connection: &Connection,
    library: &str,
    page: &str,
) -> Result<nodex_core_contracts::inbox::ProjectWorkspaceInboxItem, StoreError> {
    use nodex_core_contracts::inbox::*;
    let problem = get(connection, library, page)?;
    let scope = problem
        .project_id
        .clone()
        .map_or(ProjectWorkspaceInboxScope::Library, |project_id| {
            ProjectWorkspaceInboxScope::Project { project_id }
        });
    let at:String=connection.query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ',opened_at_ms/1000.0,'unixepoch') FROM problems WHERE id=?1",[page],|r|r.get(0))?;
    Ok(ProjectWorkspaceInboxItem {
        later: None,
        problem: Some(problem.clone()),
        handback: None,
        row_kind: InboxRowKind::Problem,
        turn: None,
        page_id: page.into(),
        page_key: None,
        page_status: None,
        title: problem.summary.clone(),
        body: String::new(),
        body_truncated: false,
        body_editable: false,
        submitted_at: at,
        source: ProjectWorkspaceInboxSource::User,
        reply_to_page_id: None,
        kind: None,
        important: false,
        waiting: false,
        suggestion_state: ProjectWorkspaceInboxSuggestionState::None,
        suggestion_error: None,
        scope,
        location: ProjectWorkspaceInboxLocation::Other,
        proposal: None,
        automation_decision: None,
        revision: 1,
        basis: ProjectWorkspaceInboxPageBasis {
            page_id: page.into(),
            content_hash: "0".repeat(64),
        },
    })
}
