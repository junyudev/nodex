//! Workspace owns Coordinator identity, work facts, and the immutable delivery outbox.
use super::{
    ProjectWorkspaceApplyOutcome,
    session_mutation::{require_session, sqlite_now, validate_id},
};
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};
use nodex_core_contracts::{BoundModuleContext, agent::AgentTurnProvenance, workspace::*};
use rusqlite::{Connection, OptionalExtension, params};

fn invalid(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message, false)
}
fn conflict(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::RevisionConflict, message, true)
}
fn denied(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::Unauthorized, message, false)
}
fn literal<T: serde::Serialize>(value: &T) -> String {
    serde_json::to_value(value)
        .expect("enum")
        .as_str()
        .expect("literal")
        .to_owned()
}
fn decode<T: serde::de::DeserializeOwned>(value: String) -> rusqlite::Result<T> {
    serde_json::from_str(&value).map_err(|_| rusqlite::Error::InvalidQuery)
}
fn limit(value: u32) -> Result<i64, StoreError> {
    if !(1..=100).contains(&value) {
        return Err(invalid("Coordinator read limit must be 1–100"));
    }
    Ok(i64::from(value))
}

pub(super) fn binding(connection: &Connection) -> Result<Option<String>, StoreError> {
    Ok(connection
        .query_row("SELECT session_id FROM coordinator WHERE id=1", [], |r| {
            r.get(0)
        })
        .optional()?)
}
pub(super) fn managed(
    connection: &Connection,
    id: &str,
) -> Result<Option<CoordinatorManagedSession>, StoreError> {
    validate_id("session_id", id)?;
}
/// Used by chat dispatch inside its existing Workspace transaction.
pub(super) fn set_managed(
    connection: &Connection,
    session_id: &str,
    enabled: bool,
    now: &str,
) -> Result<(), StoreError> {
    validate_id("session_id", session_id)?;
    if binding(connection)?.as_deref() == Some(session_id) {
        return Err(invalid("The Coordinator cannot manage itself"));
    }
    if !enabled {
        connection.execute(
            "DELETE FROM coordinator_managed_sessions WHERE session_id=?1",
            [session_id],
        )?;
        return Ok(());
    }
    connection.execute("INSERT INTO coordinator_managed_sessions(session_id,since) VALUES(?1,?2) ON CONFLICT DO NOTHING", params![session_id,now])?;
    Ok(())
}

pub(super) fn managed_sessions(
    connection: &Connection,
    after: Option<&str>,
    count: u32,
) -> Result<Vec<CoordinatorManagedSession>, StoreError> {
    let ids = connection.prepare("SELECT managed.session_id FROM coordinator_managed_sessions managed JOIN project_sessions session ON session.id=managed.session_id WHERE session.archived=0 AND (?1 IS NULL OR managed.session_id > ?1) ORDER BY managed.session_id LIMIT ?2")?
        .query_map(params![after, limit(count)?], |r| r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    ids.iter()
        .map(|id| managed(connection, id)?.ok_or_else(|| conflict("Managed Session changed")))
        .collect()
}

pub(super) fn pending(
    connection: &Connection,
    library: &str,
    count: u32,
) -> Result<Vec<CoordinatorWorkEvent>, StoreError> {
    for event in &mut events {
        if let Some(id) = &event.page_id {
            event.page_key = crate::database::current_page_key_for_page(connection, library, id)?;
        }
    }
    Ok(events)
}
pub(super) fn event_batch(
    connection: &Connection,
    id: &str,
) -> Result<Option<CoordinatorEventBatch>, StoreError> {
    validate_id("batch_id", id)?;
    Ok(connection.query_row("SELECT batch_id,coordinator_session_id,message_id,body,fingerprint,created_at,accepted_at,invalidated_at FROM coordinator_event_batches WHERE batch_id=?1 AND discarded_at IS NULL",[id], read_event_batch).optional()?)
}
fn read_event_batch(r: &rusqlite::Row<'_>) -> rusqlite::Result<CoordinatorEventBatch> {
    Ok(CoordinatorEventBatch {
        batch_id: r.get(0)?,
        coordinator_session_id: r.get(1)?,
        message_id: r.get(2)?,
        body: r.get(3)?,
        fingerprint: r.get(4)?,
        created_at: r.get(5)?,
        accepted_at: r.get(6)?,
        invalidated_at: r.get(7)?,
    })
}
pub(super) fn open_batches(
    connection: &Connection,
    count: u32,
) -> Result<Vec<CoordinatorEventBatch>, StoreError> {
    Ok(connection.prepare("SELECT batch_id,coordinator_session_id,message_id,body,fingerprint,created_at,accepted_at,invalidated_at FROM coordinator_event_batches WHERE accepted_at IS NULL AND discarded_at IS NULL ORDER BY created_at,batch_id LIMIT ?1")?.query_map([limit(count)?], read_event_batch)?.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub(super) fn bind(
    connection: &Connection,
    library: &str,
    session_id: &str,
    now: &str,
) -> Result<(), StoreError> {
    validate_id("session_id", session_id)?;
    let authority = require_session(connection, library, session_id)?;
    if authority.archived
        || authority.project_id.is_some()
        || !connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM project_session_execution_bindings WHERE session_id=?1)",
            [session_id],
            |r| r.get::<_, bool>(0),
        )?
    {
        return Err(invalid(
            "The Coordinator must be a live projectless Runtime Session",
        ));
    }
    if managed(connection, session_id)?.is_some() {
        return Err(invalid("A managed Session cannot be the Coordinator"));
    }

    connection.execute("INSERT INTO coordinator(id,session_id,created_at) VALUES(1,?1,?2) ON CONFLICT(id) DO UPDATE SET session_id=excluded.session_id,created_at=excluded.created_at", params![session_id,now])?;
    connection.execute(
        "UPDATE session_search_revision SET revision=revision+1 WHERE id=1",
        [],
    )?;

    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(super) fn apply(
    connection: &Connection,
    context: &BoundModuleContext,
    library: &str,
    epoch: &str,
    operation: &str,
    hash: &str,
    intent: &ProjectWorkspaceIntent,
    provenance: Option<&AgentTurnProvenance>,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    let now = sqlite_now(connection)?;
    let mut sessions = Vec::new();
    let mut pages = Vec::new();
    let mut retired_attention = false;
    {
        return Err(denied("Coordinator control belongs to the Desktop Host"));
    }
    match intent {
        ProjectWorkspaceIntent::BindCoordinator { session_id } => {
            sessions.extend(binding(connection)?);
            bind(connection, library, session_id, &now)?;
            sessions.push(session_id.clone());
        }
        ProjectWorkspaceIntent::UnbindCoordinator { session_id } => {
            if binding(connection)?.as_deref() != Some(session_id) {
                return Err(conflict("Coordinator binding changed"));
            }
            connection.execute("DELETE FROM coordinator WHERE id=1", [])?;
            connection.execute(
                "UPDATE session_search_revision SET revision=revision+1 WHERE id=1",
                [],
            )?;
            sessions.push(session_id.clone());
        }
        ProjectWorkspaceIntent::SetSessionManaged {
            session_id,
            managed: enabled,
        } => {
            validate_id("session_id", session_id)?;
            require_session(connection, library, session_id)?;
            set_managed(connection, session_id, *enabled, &now)?;
            sessions.push(session_id.clone());
        }
        ProjectWorkspaceIntent::ReportPageWork {
            page_id,
            outcome,
            summary,
        } => {
            let provenance = provenance
                .ok_or_else(|| denied("Work reports require verified Agent provenance"))?;
            let session = match &provenance.authority.runtime {
                Some(runtime) => Some(runtime.session_id.clone()),
                None => connection
                    .query_row(
                        "SELECT session_id FROM project_session_threads WHERE thread_id=?1",
                        [&provenance.authority.root_thread_id],
                        |r| r.get::<_, String>(0),
                    )
                    .optional()?,
            }
            .ok_or_else(|| denied("The reporting Agent has no linked Session"))?;
            // A native connection is verified authority, but it does not identify a causal Run.
            let report_run_id = match &provenance.authority.runtime {
                Some(runtime) if runtime.turn_kind != ProjectWorkspaceAgentRuntimeTurnKind::Run => {
                    None
                }
                _ => Some(provenance.authority.turn_id.as_str()),
            };
            let authority = require_session(connection, library, &session)?;
            if authority.archived {
                return Err(invalid("The reporting Session is archived"));
            }
            if summary.trim().is_empty() || summary.chars().count() > 4000 {
                return Err(invalid("Work summary must contain 1–4000 characters"));
            }
            crate::library::require_page_read_access(connection, library, &page)?;
            let revision: i64 = connection.query_row("UPDATE project_session_pages SET report_outcome=?3,report_summary=?4,report_at=?5,report_run_id=?6,report_revision=report_revision+1 WHERE session_id=?1 AND page_id=?2 RETURNING report_revision", params![session,page,literal(outcome),summary,now,report_run_id], |r| r.get(0)).optional()?.ok_or_else(|| denied("The reporting Session is not linked to this Page"))?;
            if managed(connection, &session)?.is_some() {
                insert_event(
                    connection,
                    operation,
                    0,
                    &CoordinatorWorkEventInput {
                        kind: CoordinatorWorkEventKind::Report,
                        session_id: Some(session.clone()),
                        page_id: Some(page.clone()),
                        dedupe_key: format!("report:{session}:{page}:{revision}"),
                    },
                    &now,
                )?;
            }
            sessions.push(session);
            pages.push(page);
        }
        ProjectWorkspaceIntent::RecordWorkEvents { events, observed } => {
            if events.len() > 100 || observed.len() > 100 {
                return Err(invalid(
                    "Work capture is bounded to 100 events and observations",
                ));
            }
            for item in observed {
                if item.resolved_request_ids.len() > 100 {
                    return Err(invalid(
                        "At most 100 resolved requests can be captured per chat",
                    ));
                }
                for request in &item.resolved_request_ids {
                    validate_id("resolved_request_id", request)?;
                    let key = format!("attention:{}:{request}", item.session_id);
                    let ids = connection.prepare("SELECT event_id FROM coordinator_work_events WHERE dedupe_key=?1 AND kind='attention' AND resolved_at IS NULL")?.query_map([key], |r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
                    let handled =
                        super::inbox::nodex::retire_attention(connection, library, &ids, &now)?;
                    retired_attention |= !handled.is_empty();
                    pages.extend(handled);
                }
                let encoded = serde_json::to_string(&item.observed_json)
                    .map_err(|_| invalid("Invalid observation"))?;
                if encoded.len() > 16000 {
                    return Err(invalid("Observation exceeds 16000 bytes"));
                }
                if connection.execute("UPDATE coordinator_managed_sessions SET observed_json=?2,observed_revision=observed_revision+1 WHERE session_id=?1 AND observed_revision=?3", params![item.session_id,encoded,item.expected_revision])? != 1 { return Err(conflict("Managed Session observation revision changed")); }
            }
            for (i, event) in events.iter().enumerate() {
            }
        }
        ProjectWorkspaceIntent::CreateEventBatch {
            batch_id,
            coordinator_session_id,
            event_ids,
            message_id,
            body,
            fingerprint,
        } => {
            validate_id("batch_id", batch_id)?;
            validate_id("message_id", message_id)?;
            if binding(connection)?.as_deref() != Some(coordinator_session_id)
                || require_session(connection, library, coordinator_session_id)?.archived
            {
                return Err(conflict("Coordinator binding changed"));
            }
            if event_ids.is_empty()
                || event_ids.len() > 20
                || body.is_empty()
                || body.len() > 64000
                || fingerprint.len() != 64
            {
                return Err(invalid("Invalid bounded Coordinator batch"));
            }
            connection.execute("INSERT INTO coordinator_event_batches(batch_id,coordinator_session_id,message_id,body,fingerprint,created_at) VALUES(?1,?2,?3,?4,?5,?6)", params![batch_id,coordinator_session_id,message_id,body,fingerprint,now])?;
            for id in event_ids {
                if connection.execute("UPDATE coordinator_work_events SET batch_id=?2 WHERE event_id=?1 AND batch_id IS NULL AND resolved_at IS NULL",params![id,batch_id])? != 1 { return Err(conflict("A work event is missing or already batched")); }
            }
        }
        ProjectWorkspaceIntent::DiscardEventBatch { batch_id } => {
            validate_id("batch_id", batch_id)?;
            if connection.execute("UPDATE coordinator_event_batches SET discarded_at=?2 WHERE batch_id=?1 AND accepted_at IS NULL AND invalidated_at IS NOT NULL AND discarded_at IS NULL",params![batch_id,now])? != 1 {
                return Err(conflict("Batch is delivered, absent or still current"));
            }
            // Main checked Runtime admission first. Only the still-live facts need a new batch.
            connection.execute("UPDATE coordinator_work_events SET batch_id=NULL WHERE batch_id=?1 AND resolved_at IS NULL",[batch_id])?;
        }
        ProjectWorkspaceIntent::SettleEventBatch {
            batch_id,
            accepted_at,
        } => {
            if !chrono::DateTime::parse_from_rfc3339(accepted_at).is_ok_and(|at| {
                at.with_timezone(&chrono::Utc)
                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
                    == *accepted_at
            }) {
                return Err(invalid("Invalid acceptance timestamp"));
            }
            let changed=connection.execute("UPDATE coordinator_event_batches SET accepted_at=?2 WHERE batch_id=?1 AND discarded_at IS NULL AND (accepted_at IS NULL OR accepted_at=?2)",params![batch_id,accepted_at])?;
            if changed != 1 {
                return Err(conflict("Batch is absent or has a different acceptance"));
            }
        }
        _ => return Err(invalid("Not a Coordinator command")),
    }
        },
}
    connection: &Connection,
    operation: &str,
    index: usize,
    event: &CoordinatorWorkEventInput,
    now: &str,
    if let Some(id) = &event.session_id {
        validate_id("session_id", id)?;
    }
    if let Some(id) = &event.page_id {
        validate_id("page_id", id)?;
    }
    let payload =
        serde_json::to_string(&event.payload).map_err(|_| invalid("Invalid work payload"))?;
    if payload.len() > 24000 {
        return Err(invalid("Work payload exceeds 24000 bytes"));
    }
    let already_started = match (event.kind, event.page_id.as_deref()) {
        (CoordinatorWorkEventKind::ReadyToStart, Some(page)) => connection.query_row(
            [page],
            |r| r.get::<_, bool>(0),
        )?,
        _ => false,
    };
    let inserted = connection.execute("INSERT INTO coordinator_work_events(event_id,dedupe_key,kind,session_id,page_id,payload_json,created_at,resolved_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(dedupe_key) DO NOTHING", params![crate::domain::identity::stable_uuid_v7("coordinator", operation, &index.to_string()),event.dedupe_key,literal(&event.kind),event.session_id,event.page_id,payload,now,if already_started { Some(now) } else { None }])?;
}

pub(super) fn work_descriptor(
    connection: &Connection,
    page: &str,
) -> Result<PageWorkDescriptor, StoreError> {
    // Reports remain evidence after a work chat is archived; unlinking removes that evidence.
    let managed_session_count=connection.query_row("SELECT count(*) FROM project_session_pages relation JOIN coordinator_managed_sessions managed ON managed.session_id=relation.session_id WHERE relation.page_id=?1",[page],|r| r.get(0))?;
    Ok(PageWorkDescriptor {
        latest_report,
        managed_session_count,
    })
}
