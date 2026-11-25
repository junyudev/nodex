//! Work reports and execution observations are the facts behind Page Turns.
use super::{
    ProjectWorkspaceApplyOutcome,
    mutation::{WorkspaceMutationEffects, finish_mutation},
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
        return Err(denied("Execution observations belong to the Desktop Host"));
    }
    match intent {
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
            super::execution::require_root_agent(provenance)?;
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
            // A Runtime native connection is verified authority without a causal Run.
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
            let (fence, previous_ready_move): (Option<i64>, bool) = connection.query_row(
                "SELECT status_fence, COALESCE(report_outcome='ready' AND report_status_moved,0)
                 FROM project_session_pages WHERE page_id=?1 AND session_id=?2",
                params![page, session],
                |r| Ok((r.get(0)?, r.get(1)?)),
            ).optional()?.ok_or_else(|| denied("The reporting Session is not linked to this Page"))?;
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
            // A fresh ready report can arrive before the observer saw its Run start.
            // It inherits responsibility for the Review stage the previous claim opened.
            let status_moved = status_receipt.is_some()
                || (active && previous_ready_move && *outcome == WorkReportOutcome::Ready);
            connection.execute(
                "UPDATE project_session_pages SET report_outcome=?3,report_summary=?4,report_at=?5,
                 report_run_id=?6,report_status_moved=?7,report_revision=report_revision+1
                 WHERE session_id=?1 AND page_id=?2",
                params![
                    session,
                    page,
                    literal(outcome),
                    summary,
                    now,
                    report_run_id,
                    status_moved
                ],
            )?;
            // A connection-level report has no Run to join against the observation. Require
            // a fresh quiet read and reject any capture already in flight when the claim changed.
            if status_moved && *outcome == WorkReportOutcome::Ready && report_run_id.is_none() {
                connection.execute(
                    "UPDATE session_execution_observations
                     SET revision=revision+1,
                         observed_json=CASE WHEN json_extract(observed_json,'$.state') IN ('idle','failed')
                           THEN json_set(observed_json,'$.state','unavailable','$.terminalStatus',NULL)
                           ELSE observed_json END
                     WHERE session_id=?1",
                    [&session],
                )?;
            }
            sessions.push(session);
            pages.push(page);
        }
        ProjectWorkspaceIntent::RecordSessionExecution {
            session_id,
            expected_revision,
            observation,
        } => {
            require_session(connection, library, session_id)?;
            if super::decision_run::read(connection, session_id)?.is_some() {
                return Err(invalid(
                    "Decision runs are outside chat execution observation",
                ));
            }
            if observation.pending_requests.len() > 100
                || observation.pending_request_ids.len() > 100
            {
                return Err(invalid("Execution capture is bounded to 100 requests"));
            }
            if observation
                .last_reply_excerpt
                .as_ref()
                .is_some_and(|text| text.chars().count() > 400)
            {
                return Err(invalid("Last reply excerpt exceeds 400 characters"));
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
            pages.extend(
                connection
                    .prepare("SELECT page_id FROM page_active_chats WHERE session_id=?1")?
                    .query_map([session_id], |r| r.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?,
            );
            status_receipt = supersede_ready_reports(
                connection,
                library,
                context,
                operation,
                session_id,
                observation,
                &now,
            )?;
            sessions.push(session_id.clone());
        }
        _ => return Err(invalid("Not a work facts command")),
    }
    let mut effects = WorkspaceMutationEffects {
        operation_kind: match intent {
            ProjectWorkspaceIntent::AcceptPageWork { .. } => "accept_page_work",
            ProjectWorkspaceIntent::ReportPageWork { .. } => "report_page_work",
            _ => "record_session_execution",
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

/// A later root Run invalidates the active chat's earlier claim, even if the
/// Run already ended by the time the Host observed it. The person still owns Status.
fn supersede_ready_reports(
    connection: &Connection,
    library: &str,
    context: &BoundModuleContext,
    operation: &str,
    session: &str,
    observation: &SessionExecutionObservation,
    now: &str,
) -> Result<Option<nodex_core_contracts::database::DatabaseReceipt>, StoreError> {
    let start = observation
        .run_id
        .as_deref()
        .zip(observation.run_started_at)
        .or_else(|| {
            observation
                .earlier_run_start
                .as_ref()
                .map(|start| (start.run_id.as_str(), start.started_at))
        });
    let Some((run, started_at)) = start else {
        return Ok(None);
    };
    if observation.state == SessionExecutionState::Unavailable {
        return Ok(None);
    }
    let candidates = connection.prepare(
        "SELECT report.page_id, CASE WHEN report.report_status_moved THEN report.status_fence END
         FROM page_active_chats active
         JOIN project_session_pages report USING (page_id, session_id)
         WHERE active.session_id=?1 AND report.report_outcome='ready'
           AND report.report_run_id IS NOT ?2
           AND CAST(round(unixepoch(report.report_at, 'subsec') * 1000) AS INTEGER) < ?3",
    )?.query_map(params![session, run, started_at], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, Option<i64>>(1)?))
    })?.collect::<rusqlite::Result<Vec<_>>>()?;
    let steps = candidates
        .iter()
        .filter_map(|(page, fence)| {
            Some(crate::database::WorkflowStatusStep {
                page_id: page,
                predecessors: &["review"],
                to: "doing",
                person_revision: (*fence)?,
            })
        })
        .collect::<Vec<_>>();
    let receipt = crate::database::follow_workflow_status(
        connection, library, context, operation, &steps, now,
    )?;
    for (page, _) in candidates {
        connection.execute(
            "UPDATE project_session_pages
             SET report_outcome=NULL,report_summary=NULL,report_at=NULL,
                 report_run_id=NULL,report_status_moved=NULL
             WHERE page_id=?1 AND session_id=?2",
            params![page, session],
        )?;
    }
    Ok(receipt)
}

pub(super) fn managed_chat(
    connection: &Connection,
    session_id: &str,
) -> Result<Option<ManagedChat>, StoreError> {
    validate_id("session_id", session_id)?;
    Ok(connection
        .query_row(
            "SELECT since FROM managed_chats WHERE session_id=?1",
            [session_id],
            |row| {
                Ok(ManagedChat {
                    session_id: session_id.into(),
                    since: row.get(0)?,
                })
            },
        )
        .optional()?)
}

/// Dispatch and Page start transfer attention to the Page's Turn.
pub(super) fn mark_chat_managed(
    connection: &Connection,
    session_id: &str,
    now: &str,
) -> Result<(), StoreError> {
    if super::decision_run::read(connection, session_id)?.is_some() {
        return Err(invalid("A decision run cannot be a managed chat"));
    }
    connection.execute(
        "INSERT INTO managed_chats(session_id,since) VALUES(?1,?2) ON CONFLICT DO NOTHING",
        params![session_id, now],
    )?;
    Ok(())
}

pub(super) fn work_descriptor(
    connection: &Connection,
    page: &str,
) -> Result<PageWorkDescriptor, StoreError> {
    // Reports remain evidence after a work chat is archived; unlinking removes that evidence.
    let latest_report=connection.query_row("SELECT session_id,report_outcome,report_at,report_revision,report_status_moved FROM project_session_pages relation WHERE page_id=?1 AND report_outcome IS NOT NULL AND NOT EXISTS(SELECT 1 FROM nodex_decision_runs WHERE session_id=relation.session_id) ORDER BY report_at DESC,report_revision DESC,session_id LIMIT 1",[page],|r| Ok(PageLatestWorkReport { status_moved:r.get(4)?, session_id:r.get(0)?,outcome:decode(format!("\"{}\"",r.get::<_,String>(1)?))?,at:r.get(2)?,revision:r.get(3)? })).optional()?;
    let managed_session_count=connection.query_row("SELECT count(*) FROM project_session_pages relation JOIN managed_chats managed ON managed.session_id=relation.session_id WHERE relation.page_id=?1",[page],|r| r.get(0))?;
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
