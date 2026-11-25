//! Durable identity and request authority for single-purpose Nodex decisions.
use super::{inbox::reliable::pending_request_filter, session_mutation::validate_id};
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};
use nodex_core_contracts::{
    BoundModuleContext,
    agent::AgentTurnProvenance,
    workspace::{NodexDecisionRun, NodexDecisionRunInput, NodexDecisionRunKind},
};
use rusqlite::{Connection, OptionalExtension, params};

fn kind_name(kind: NodexDecisionRunKind) -> &'static str {
    match kind {
        NodexDecisionRunKind::Routing => "routing",
        NodexDecisionRunKind::Assessment => "assessment",
    }
}

pub(super) fn read_kind(
    row: &rusqlite::Row<'_>,
    column: &str,
) -> rusqlite::Result<Option<NodexDecisionRunKind>> {
    match row.get::<_, Option<String>>(column)?.as_deref() {
        Some("routing") => Ok(Some(NodexDecisionRunKind::Routing)),
        Some("assessment") => Ok(Some(NodexDecisionRunKind::Assessment)),
        None => Ok(None),
        _ => Err(rusqlite::Error::InvalidQuery),
    }
}

pub(super) fn require_chat(c: &Connection, session_id: &str) -> Result<(), StoreError> {
    if read(c, session_id)?.is_some() {
        return Err(StoreError::new(
            StoreErrorCode::Unauthorized,
            "Decision runs are read-only",
            false,
        ));
    }
    Ok(())
}

pub(super) fn read(
    c: &Connection,
    session_id: &str,
) -> Result<Option<NodexDecisionRun>, StoreError> {
    validate_id("session_id", session_id)?;
    Ok(c.query_row(
        "SELECT session_id,kind,request_id,generation,created_at FROM nodex_decision_runs WHERE session_id=?1",
        [session_id],
        run_row,
    )
    .optional()?)
}

fn run_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<NodexDecisionRun> {
    Ok(NodexDecisionRun {
        session_id: row.get("session_id")?,
        kind: read_kind(row, "kind")?.ok_or(rusqlite::Error::InvalidQuery)?,
        request_id: row.get("request_id")?,
        generation: row.get("generation")?,
        created_at: row.get("created_at")?,
    })
}

pub(super) fn find_session(
    c: &Connection,
    input: &NodexDecisionRunInput,
) -> Result<Option<String>, StoreError> {
    Ok(c.query_row(
        "SELECT session_id FROM nodex_decision_runs WHERE kind=?1 AND request_id=?2 AND generation=?3",
        params![kind_name(input.kind), input.request_id, input.generation],
        |row| row.get(0),
    ).optional()?)
}

// Both liveness and reservations use the current request fence, independent of execution holds.
const PENDING_ASSESSMENT: &str = "library_id=?1 AND state='pending'";

fn live_request() -> String {
    let routing = pending_request_filter();
    format!("(
        (run.kind='routing' AND EXISTS(
            SELECT 1 FROM inbox_suggestion_requests
            WHERE inbox_suggestion_requests.request_id=run.request_id AND inbox_suggestion_requests.generation=run.generation AND {routing}
        )) OR (run.kind='assessment' AND EXISTS(
            SELECT 1 FROM automation_assessment_requests request
            WHERE request.request_id=run.request_id AND request.generation=run.generation AND {PENDING_ASSESSMENT}
        ))
    )")
}

pub(super) fn reservations(c: &Connection, library_id: &str) -> Result<(u32, u32), StoreError> {
    let routing = pending_request_filter();
    Ok(c.query_row(&format!("SELECT
        (SELECT count(*) FROM inbox_suggestion_requests WHERE {routing} AND EXISTS(
            SELECT 1 FROM inbox_routing_deliveries delivery
            WHERE delivery.request_id=inbox_suggestion_requests.request_id AND delivery.generation=inbox_suggestion_requests.generation
        )),
        (SELECT count(*) FROM automation_assessment_requests
         WHERE {PENDING_ASSESSMENT} AND decision_session_id IS NOT NULL)"), [library_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?)
}

pub(super) fn pending(
    c: &Connection,
    library_id: &str,
    session_id: &str,
) -> Result<bool, StoreError> {
    let live = live_request();
    Ok(c.query_row(
        &format!(
            "SELECT EXISTS(
        SELECT 1 FROM nodex_decision_runs run WHERE run.session_id=?2 AND {live}
    )"
        ),
        params![library_id, session_id],
        |row| row.get(0),
    )?)
}

pub(super) fn retired(
    c: &Connection,
    library_id: &str,
    after: Option<&str>,
) -> Result<Vec<NodexDecisionRun>, StoreError> {
    if let Some(after) = after {
        validate_id("after_session_id", after)?;
    }
    let live = live_request();
    Ok(c.prepare(&format!(
        "SELECT run.* FROM nodex_decision_runs run
        WHERE run.execution_stopped=0 AND run.session_id>?2 AND NOT {live}
        ORDER BY run.session_id LIMIT 32"
    ))?
    .query_map(params![library_id, after.unwrap_or("")], run_row)?
    .collect::<rusqlite::Result<Vec<_>>>()?)
}

pub(super) fn acknowledge_stopped(
    c: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    epoch: &str,
    operation: &str,
    hash: &str,
    session_id: &str,
) -> Result<super::ProjectWorkspaceApplyOutcome, StoreError> {
    super::inbox::require_host(context)?;
    validate_id("session_id", session_id)?;
    let live = live_request();
    c.execute(
        &format!(
            "UPDATE nodex_decision_runs AS run SET execution_stopped=1
        WHERE run.session_id=?2 AND run.execution_stopped=0 AND NOT {live}"
        ),
        params![library_id, session_id],
    )?;
    super::mutation::finish_no_op(
        c,
        context,
        epoch,
        operation,
        hash,
        "acknowledge_decision_run_stopped",
        vec![],
        vec![session_id.to_owned()],
        &super::session_mutation::sqlite_now(c)?,
    )
}

pub(super) fn insert(
    c: &Connection,
    session_id: &str,
    input: &NodexDecisionRunInput,
    created_at: &str,
) -> Result<(), StoreError> {
    validate_id("request_id", &input.request_id)?;
    if input.generation < 1 {
        return Err(StoreError::new(
            StoreErrorCode::InvalidInput,
            "Decision run generation must be positive",
            false,
        ));
    }
    c.execute(
        "INSERT INTO nodex_decision_runs(session_id,kind,request_id,generation,created_at) VALUES(?1,?2,?3,?4,?5)",
        params![session_id,kind_name(input.kind),input.request_id,input.generation,created_at],
    )?;
    Ok(())
}

pub(super) fn denied() -> StoreError {
    StoreError::new(
        StoreErrorCode::Unauthorized,
        "Decision belongs to the active run for this request",
        false,
    )
}

pub(super) fn require(
    c: &Connection,
    session_id: &str,
    kind: NodexDecisionRunKind,
    request_id: &str,
    generation: i64,
) -> Result<(), StoreError> {
    let matches: bool = c.query_row(
        "SELECT EXISTS(SELECT 1 FROM nodex_decision_runs run JOIN project_sessions session
         ON session.id=run.session_id WHERE run.session_id=?1 AND run.kind=?2
         AND run.request_id=?3 AND run.generation=?4 AND session.archived=0)",
        params![session_id, kind_name(kind), request_id, generation],
        |row| row.get(0),
    )?;
    if !matches {
        return Err(denied());
    }
    Ok(())
}

pub(super) fn caller(provenance: Option<&AgentTurnProvenance>) -> Result<&str, StoreError> {
    let provenance = provenance.ok_or_else(denied)?;
    super::execution::require_root_agent(provenance)?;
    provenance
        .authority
        .runtime
        .as_ref()
        .map(|runtime| runtime.session_id.as_str())
        .ok_or_else(denied)
}
