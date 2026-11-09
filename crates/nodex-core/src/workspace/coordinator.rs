//! Workspace owns Coordinator identity, work facts, and the immutable delivery outbox.
use super::{
    ProjectWorkspaceApplyOutcome,
    mutation::{WorkspaceMutationEffects, finish_mutation, finish_no_op},
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
    let mut value = connection.query_row("SELECT session_id,since,observed_json,observed_revision,(SELECT max(report_at) FROM project_session_pages WHERE session_id=managed.session_id) FROM coordinator_managed_sessions managed WHERE session_id=?1", [id], |r| Ok(CoordinatorManagedSession { active_page_ids: Vec::new(), session_id:r.get(0)?, since:r.get(1)?, observed_json:r.get::<_,Option<String>>(2)?.map(decode).transpose()?, observed_revision:r.get(3)?, latest_report_at:r.get(4)? })).optional()?;
    if let Some(value) = &mut value {
        value.active_page_ids = connection
            .prepare("SELECT page_id FROM page_active_chats WHERE session_id=?1 ORDER BY page_id")?
            .query_map([id], |r| r.get(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
    }
    Ok(value)
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
    let mut events = connection.prepare(&format!("SELECT event_id,dedupe_key,kind,session_id,page_id,payload_json,created_at,(SELECT COALESCE(NULLIF(thread.thread_name,''),session.no_thread_fallback_title) FROM project_sessions session LEFT JOIN project_session_threads link ON link.session_id=session.id LEFT JOIN codex_threads thread ON thread.thread_id=link.thread_id WHERE session.id=event.session_id),(SELECT title FROM page_read_model WHERE page_block_id=event.page_id) FROM coordinator_work_events event WHERE batch_id IS NULL AND resolved_at IS NULL AND NOT ({}) ORDER BY created_at,event_id LIMIT ?1",super::execution_holds::event_predicate("event.page_id","event.session_id")))?.query_map([limit(count)?], |r| Ok(CoordinatorWorkEvent { event_id:r.get(0)?, dedupe_key:r.get(1)?, kind:decode(format!("\"{}\"",r.get::<_,String>(2)?))?, session_id:r.get(3)?, page_id:r.get(4)?, payload:decode(r.get(5)?)?, created_at:r.get(6)?, session_title:r.get(7)?, page_title:r.get(8)?, page_key:None }))?.collect::<rusqlite::Result<Vec<_>>>()?;
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
    let mut status_receipt = None;
    if !matches!(
        intent,
        ProjectWorkspaceIntent::ReportPageWork { .. }
            | ProjectWorkspaceIntent::AcceptPageWork { .. }
    ) && (provenance.is_some()
        || !matches!(
            context.adapter,
            nodex_core_contracts::AdapterKind::ElectronHost
                | nodex_core_contracts::AdapterKind::Test
        ))
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
        ProjectWorkspaceIntent::AcceptPageWork {
            page_id,
            expected_turn_episode,
        } => {
            if let Some(episode) = expected_turn_episode {
                super::inbox_projection::require_member_turn(
                    connection,
                    context,
                    library,
                    page_id,
                    Some(episode),
                )?;
            }
            // A person accepts, or an Agent accepts for its Member; its instructions say when.
            if context.actor.member_id().is_none()
                || !matches!(
                    context.adapter,
                    nodex_core_contracts::AdapterKind::RemoteMember
                        | nodex_core_contracts::AdapterKind::ElectronHost
                        | nodex_core_contracts::AdapterKind::NativeCli
                        | nodex_core_contracts::AdapterKind::LoopbackHttp
                        | nodex_core_contracts::AdapterKind::Test
                )
            {
                return Err(denied("Accepting work acts for a Member"));
            }
            validate_id("page_id", page_id)?;
            crate::library::require_page_read_access(connection, library, page_id)?;
            status_receipt = crate::database::follow_workflow_status(
                connection,
                library,
                context,
                operation,
                &[crate::database::WorkflowStatusStep {
                    page_id,
                    predecessors: &["review"],
                    to: "done",
                    person_revision: crate::database::status_person_revision(connection, page_id)?,
                }],
                &now,
            )?;
            // Like its other Status edits, an Agent's acceptance is not a person's move.
            if status_receipt.is_some()
                && matches!(context.actor, nodex_core_contracts::Actor::Member { .. })
            {
                crate::database::record_person_status_edit(connection, page_id)?;
            }
            pages.push(page_id.clone());
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
            let page = reported_page(connection, library, &session, page_id.as_deref())?;
            crate::library::require_page_read_access(connection, library, &page)?;
            let revision: i64 = connection.query_row("UPDATE project_session_pages SET report_outcome=?3,report_summary=?4,report_at=?5,report_run_id=?6,report_revision=report_revision+1 WHERE session_id=?1 AND page_id=?2 RETURNING report_revision", params![session,page,literal(outcome),summary,now,report_run_id], |r| r.get(0)).optional()?.ok_or_else(|| denied("The reporting Session is not linked to this Page"))?;
            let fence: Option<i64> = connection.query_row(
                "SELECT status_fence FROM project_session_pages WHERE page_id=?1 AND session_id=?2",
                params![page, session],
                |r| r.get(0),
            )?;
            let transition = match outcome {
                WorkReportOutcome::Ready => Some((&["doing"][..], "review")),
                WorkReportOutcome::Dropped => Some((&["triage", "plan", "doing"][..], "canceled")),
                WorkReportOutcome::Blocked | WorkReportOutcome::Failed => None,
            };
            // An older chat keeps its evidence, but cannot move a newer attempt's Page.
            let active = super::page_chat::active_chat(connection, &page)?
                .is_some_and(|active| active.session_id == session);
            if let Some(((predecessors, to), fence)) = transition.filter(|_| active).zip(fence) {
                status_receipt = crate::database::follow_workflow_status(
                    connection,
                    library,
                    context,
                    operation,
                    &[crate::database::WorkflowStatusStep {
                        page_id: &page,
                        predecessors,
                        to,
                        person_revision: fence,
                    }],
                    &now,
                )?;
            }
            let status_moved = status_receipt.is_some();
            connection.execute("UPDATE project_session_pages SET report_status_moved=?3 WHERE page_id=?1 AND session_id=?2",params![page,session,status_moved])?;
            if managed(connection, &session)?.is_some() {
                insert_event(
                    connection,
                    operation,
                    0,
                    &CoordinatorWorkEventInput {
                        kind: CoordinatorWorkEventKind::Report,
                        session_id: Some(session.clone()),
                        page_id: Some(page.clone()),
                        payload: serde_json::json!({"outcome":outcome,"summary":summary,"revision":revision,"run_id":report_run_id,"status_moved":status_moved}),
                        dedupe_key: format!("report:{session}:{page}:{revision}"),
                    },
                    &now,
                )?;
            }
            sessions.push(session);
            pages.push(page);
        }
        ProjectWorkspaceIntent::RecordSessionExecution {
            session_id,
            expected_revision,
            observation,
            events,
            resolved_request_ids,
        } => {
            if !matches!(
                context.adapter,
                nodex_core_contracts::AdapterKind::ElectronHost
                    | nodex_core_contracts::AdapterKind::Test
            ) || context.agent_attribution.is_some()
            {
                return Err(denied(
                    "Session execution observations belong to the Desktop Host",
                ));
            }
            require_session(connection, library, session_id)?;
            if events.len() > 100
                || observation.pending_requests.len() > 100
                || observation.pending_request_ids.len() > 100
                || resolved_request_ids.len() > 100
            {
                return Err(invalid(
                    "Execution capture is bounded to 100 requests and events",
                ));
            }
            if observation.state == SessionExecutionState::Queued
                && observation
                    .queue
                    .as_ref()
                    .is_none_or(|queue| queue.position == 0)
            {
                return Err(invalid(
                    "Queued execution requires a positive queue position",
                ));
            }
            for request in &observation.pending_requests {
                validate_id("request_id", &request.id)?;
            }
            if let Some(agent) = &observation.agent {
                crate::library::validate_agent_selection(agent)?;
            }
            let mut recorded = observation.clone();
            if recorded.agent.is_none() {
                recorded.agent = super::page_chat::session_agent_selection(connection, session_id)?;
            }
            let encoded = serde_json::to_string(&recorded)
                .map_err(|_| invalid("Invalid execution observation"))?;
            if encoded.len() > 16000 {
                return Err(invalid("Observation exceeds 16000 bytes"));
            }
            let revision = connection
                .query_row(
                    "SELECT revision FROM session_execution_observations WHERE session_id=?1",
                    [session_id],
                    |r| r.get::<_, i64>(0),
                )
                .optional()?
                .unwrap_or(0);
            if revision != *expected_revision {
                return Err(conflict("Session execution observation revision changed"));
            }
            if let Some(run) = &observation.run_id {
                connection.execute("INSERT OR IGNORE INTO session_run_members(session_id,run_id,member_id) SELECT ?1,?2,member_id FROM session_requesting_members WHERE session_id=?1 ORDER BY accepted_at DESC,message_id DESC LIMIT 1",params![session_id,run])?;
            }
            connection.execute("INSERT INTO session_execution_observations(session_id,revision,observed_json,observed_at) VALUES(?1,1,?2,?3) ON CONFLICT(session_id) DO UPDATE SET revision=revision+1,observed_json=excluded.observed_json,observed_at=excluded.observed_at",params![session_id,encoded,now])?;
            let managed = managed(connection, session_id)?.is_some();
            if !managed && (!events.is_empty() || !resolved_request_ids.is_empty()) {
                return Err(invalid("Only managed chats publish Coordinator events"));
            }
            if managed {
                // Unknown execution facts cannot consume pending managed notifications.
                if observation.state != SessionExecutionState::Unavailable {
                    connection.execute("UPDATE coordinator_managed_sessions SET observed_json=?2,observed_revision=observed_revision+1 WHERE session_id=?1",params![session_id,encoded])?;
                }
                for request in resolved_request_ids {
                    validate_id("resolved_request_id", request)?;
                    let key = format!("attention:{session_id}:{request}");
                    let ids=connection.prepare("SELECT event_id FROM coordinator_work_events WHERE dedupe_key=?1 AND kind='attention' AND resolved_at IS NULL")?.query_map([key],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
                    let handled =
                        super::inbox::nodex::retire_attention(connection, library, &ids, &now)?;
                    retired_attention |= !handled.is_empty();
                    pages.extend(handled);
                }
                for (index, event) in events.iter().enumerate() {
                    if event.session_id.as_deref() != Some(session_id) {
                        return Err(invalid(
                            "Observation events must belong to the observed Session",
                        ));
                    }
                    insert_event(connection, operation, index, event, &now)?;
                }
            }
            pages.extend(
                connection
                    .prepare("SELECT page_id FROM page_active_chats WHERE session_id=?1")?
                    .query_map([session_id], |r| r.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?,
            );
            sessions.push(session_id.clone());
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
            let mut inserted = false;
            for (i, event) in events.iter().enumerate() {
                inserted |= insert_event(connection, operation, i, event, &now)?;
            }
            // A duplicate wake must not publish another invalidation and wake its own scheduler.
            if !inserted && observed.is_empty() {
                return finish_no_op(
                    connection,
                    context,
                    epoch,
                    operation,
                    hash,
                    "coordinator",
                    vec![],
                    sessions,
                    &now,
                );
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
                let (page, session): (Option<String>, Option<String>) = connection.query_row(
                    "SELECT page_id,session_id FROM coordinator_work_events WHERE event_id=?1",
                    [id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )?;
                if super::execution_holds::event_held(
                    connection,
                    page.as_deref(),
                    session.as_deref(),
                )? {
                    return Err(conflict("Work event is paused"));
                }
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
    let mut effects = WorkspaceMutationEffects {
        operation_kind: if retired_attention {
            "inbox_retire_attention"
        } else {
            "coordinator"
        },
        project_catalog_change: None,
        change_project_id: None,
        project_ids: vec![],
        session_ids: sessions.clone(),
        thread_ids: vec![],
        session_summary_scopes: vec![ProjectSessionInvalidationScope::All],
        session_detail_ids: sessions,
        block_ids: pages.clone(),
        document_ids: vec![],
        database_ids: vec![],
        page_ids: pages,
        data_source_ids: vec![],
        view_ids: vec![],
        document_heads: vec![],
        committed_at: now,
    };
    if let Some(receipt) = status_receipt {
        effects.absorb_database(receipt);
    }
    finish_mutation(connection, context, epoch, operation, hash, effects)
}

pub(super) fn insert_event(
    connection: &Connection,
    operation: &str,
    index: usize,
    event: &CoordinatorWorkEventInput,
    now: &str,
) -> Result<bool, StoreError> {
    // Composite keys include bounded Page/Session identities and revision tokens.
    if event.dedupe_key.is_empty()
        || event.dedupe_key.len() > 2048
        || event.dedupe_key.trim() != event.dedupe_key
        || event.dedupe_key.chars().any(char::is_control)
    {
        return Err(invalid(
            "Work event dedupe_key must contain 1–2048 canonical bytes",
        ));
    }
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
            "SELECT EXISTS(SELECT 1 FROM page_active_chats WHERE page_id=?1)",
            [page],
            |r| r.get::<_, bool>(0),
        )?,
        _ => false,
    };
    let inserted = connection.execute("INSERT INTO coordinator_work_events(event_id,dedupe_key,kind,session_id,page_id,payload_json,created_at,resolved_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(dedupe_key) DO NOTHING", params![crate::domain::identity::stable_uuid_v7("coordinator", operation, &index.to_string()),event.dedupe_key,literal(&event.kind),event.session_id,event.page_id,payload,now,if already_started { Some(now) } else { None }])?;
    Ok(inserted > 0)
}

pub(super) fn work_descriptor(
    connection: &Connection,
    page: &str,
) -> Result<PageWorkDescriptor, StoreError> {
    // Reports remain evidence after a work chat is archived; unlinking removes that evidence.
    let latest_report=connection.query_row("SELECT session_id,report_outcome,report_at,report_revision,report_status_moved FROM project_session_pages relation WHERE page_id=?1 AND report_outcome IS NOT NULL AND NOT EXISTS(SELECT 1 FROM coordinator WHERE session_id=relation.session_id) ORDER BY report_at DESC,report_revision DESC,session_id LIMIT 1",[page],|r| Ok(PageLatestWorkReport { status_moved:r.get(4)?, session_id:r.get(0)?,outcome:decode(format!("\"{}\"",r.get::<_,String>(1)?))?,at:r.get(2)?,revision:r.get(3)? })).optional()?;
    let managed_session_count=connection.query_row("SELECT count(*) FROM project_session_pages relation JOIN coordinator_managed_sessions managed ON managed.session_id=relation.session_id WHERE relation.page_id=?1",[page],|r| r.get(0))?;
    Ok(PageWorkDescriptor {
        effective_hold: super::execution_holds::for_page(connection, page)?,
        active_chat: super::page_chat::active_chat(connection, page)?,
        latest_report,
        managed_session_count,
    })
}

/// A chat reports on one of its own linked Pages, named by ID or by the Page key it was given in
/// its brief; when it names none or one it is not linked to, the refusal lists what it may name.
fn reported_page(
    connection: &Connection,
    library: &str,
    session: &str,
    named: Option<&str>,
) -> Result<String, StoreError> {
    let linked = connection
        .prepare("SELECT page_id FROM project_session_pages WHERE session_id=?1 ORDER BY linked_at, page_id LIMIT 50")?
        .query_map([session], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut keyed = Vec::with_capacity(linked.len());
    for id in linked {
        let key = crate::database::current_page_key_for_page(connection, library, &id)?;
        keyed.push((id, key));
    }
    let found = match named {
        Some(value) => {
            let value = value.trim();
            keyed.iter().find(|(id, key)| {
                id == value
                    || key
                        .as_deref()
                        .is_some_and(|key| key.eq_ignore_ascii_case(value))
            })
        }
        None if keyed.len() == 1 => keyed.first(),
        None => {
            let active = connection.prepare("SELECT page_id FROM page_active_chats WHERE session_id=?1 ORDER BY page_id LIMIT 2")?.query_map([session],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
            if active.len() == 1 {
                keyed.iter().find(|(id, _)| *id == active[0])
            } else {
                None
            }
        }
    };
    if let Some((id, _)) = found {
        return Ok(id.clone());
    }
    let choices = keyed
        .iter()
        .map(|(id, key)| key.clone().unwrap_or_else(|| id.clone()))
        .collect::<Vec<_>>();
    Err(invalid(&match (named, choices.is_empty()) {
        (_, true) => "This chat is not linked to a Page to report on".to_owned(),
        (None, false) => format!(
            "This chat works on several Pages; pass pageId as one of: {}",
            choices.join(", ")
        ),
        (Some(value), false) => format!(
            "This chat is not linked to {value}; pass pageId as one of: {}",
            choices.join(", ")
        ),
    }))
}
