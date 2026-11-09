//! A work start commits intent before Runtime admission. Launch identities outlive receipts.
use super::{
    ProjectWorkspaceApplyOutcome,
    mutation::{finish_no_op, project_session_scope},
    session_mutation::{sqlite_now, validate_id},
};
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};
use nodex_core_contracts::{AdapterKind, BoundModuleContext, workspace::*};
use rusqlite::{Connection, OptionalExtension, params};

fn invalid(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message, false)
}
fn conflict(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::Conflict, message, false)
}

pub(super) fn launch(
    connection: &Connection,
    id: &str,
) -> Result<Option<PageWorkLaunch>, StoreError> {
    validate_id("launch_id", id)?;
    Ok(connection.query_row("SELECT launch_id,page_id,project_id,session_id,message_id,selection_json,brief,again,created_at,accepted_at,rejection,status_fence,status_moved FROM page_work_launches WHERE launch_id=?1", [id], |r| {
        let selection: String = r.get(5)?;
    }).optional()?)
}
pub(super) fn outbox(
    connection: &Connection,
    limit: u32,
) -> Result<Vec<PageWorkLaunch>, StoreError> {
    if !(1..=100).contains(&limit) {
        return Err(invalid("Work outbox limit must be 1–100"));
    }
    let ids = connection.prepare("SELECT launch_id FROM page_work_launches WHERE accepted_at IS NULL AND rejection IS NULL ORDER BY created_at,launch_id LIMIT ?1")?.query_map([limit], |r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    let mut values = Vec::new();
    let mut bytes = 0;
    for id in ids {
        let value = launch(connection, &id)?.ok_or_else(|| invalid("Work launch disappeared"))?;
        bytes += serde_json::to_vec(&value)
            .map_err(|_| invalid("Work launch cannot be encoded"))?
            .len();
        if bytes > 1_750_000 {
            break;
        }
        values.push(value);
    }
    Ok(values)
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
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    if !matches!(
        context.adapter,
        AdapterKind::ElectronHost | AdapterKind::Test
    ) && !(context.adapter == AdapterKind::RemoteMember
        && matches!(intent, ProjectWorkspaceIntent::StartPageWork { .. }))
    {
        return Err(StoreError::new(
            StoreErrorCode::Unauthorized,
            "Work launch settlement belongs to the Desktop Host",
            false,
        ));
    }
    let now = sqlite_now(connection)?;
    if let ProjectWorkspaceIntent::SettlePageWorkLaunch {
        launch_id,
        accepted_at,
        rejection,
    } = intent
    {
        if accepted_at.is_some() == rejection.is_some()
            || accepted_at
                .as_ref()
                .is_some_and(|v| v.is_empty() || v.len() > 128)
            || rejection
                .as_ref()
                .is_some_and(|v| v.trim().is_empty() || v.len() > 4000)
        {
            return Err(invalid(
                "Settle work launch requires an acceptance time or rejection",
            ));
        }
        let value =
            launch(connection, launch_id)?.ok_or_else(|| invalid("Work launch is absent"))?;
        if (value.accepted_at.is_some() || value.rejection.is_some())
            && (&value.accepted_at != accepted_at || &value.rejection != rejection)
        {
            return Err(conflict("Work launch is already settled"));
        }
        connection.execute(
            "UPDATE page_work_launches SET accepted_at=?2,rejection=?3 WHERE launch_id=?1",
            params![launch_id, accepted_at, rejection],
        )?;
        return super::session_lifecycle::finish_lifecycle_mutation(
            connection,
            library,
            context,
            epoch,
            operation,
            hash,
            "settle_page_work_launch",
            vec![value.project_id],
            vec![value.session_id],
            vec![],
            vec![ProjectSessionInvalidationScope::All],
            None,
            &[],
            now,
        );
    }
    let ProjectWorkspaceIntent::StartPageWork {
        page_id,
        selection,
        session_id,
        launch_id,
        message_id,
        brief,
        again,
        expected_readiness_epoch,
        expected_turn_episode,
    } = intent
    else {
        return Err(invalid("Not a work start"));
    };
    if let Some(episode) = expected_turn_episode {
    }
    if let Some(stored) = launch(connection, launch_id)? {
        if stored.page_id != *page_id
            || stored.session_id != *session_id
            || stored.message_id != *message_id
            || stored.brief != *brief
            || stored.again != *again
            || selection.as_ref().is_some_and(|s| *s != stored.selection)
        {
            return Err(conflict("launch_id is already bound to another work start"));
        }
        return finish_no_op(
            connection,
            context,
            epoch,
            operation,
            hash,
            "start_page_work",
            vec![stored.project_id],
            vec![stored.session_id],
            &now,
        );
    }
    super::mutation::run_mutation(connection, context, epoch, operation, hash, &now, |scope| {
            scope.evidence(),
    commit: &crate::infrastructure::local_commit::CommitContext,
    let work = crate::database::work_graph::work_context(connection, library, page_id)?;
    if let Some(expected) = expected_readiness_epoch {
        let ready = crate::database::work_graph::ready_page(connection, library, page_id)?;
            return Err(conflict("Page is no longer ready for automatic work"));
        }
    }
    if !again
        && connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM page_active_chats WHERE page_id=?1)",
            [page_id],
            |r| r.get::<_, bool>(0),
        )?
    {
        return Err(conflict(
            "Page already has an active chat; use again to start another attempt",
        ));
    }
    let selection = selection
        .or_else(|| {
            work.page_work
                .as_ref()
                .and_then(|w| w.assignee.as_ref())
                .and_then(|a| a.agent_selection())
        })
        .ok_or_else(|| invalid("Work requires an Agent selection"))?;
    crate::library::validate_agent_selection(&selection)?;
    crate::library::members::assign_agent_if_unassigned(
        connection, library, context, commit, page_id, &selection,
    )?;
    let page_ids = vec![page_id.clone()];
    super::session_lifecycle::prepare_session(
        connection,
        library,
        session_id,
        Some(&work.project_id),
        &work.page.title,
        &page_ids,
        None,
    )?;
    super::coordinator::set_managed(connection, session_id, true, now)?;
    let retired = super::inbox::nodex::retire_page_start(connection, library, page_id, now)?;
    let inbox_changed = !retired.is_empty();
    super::coordinator::insert_event(
        connection,
        operation,
        0,
        &CoordinatorWorkEventInput {
            kind: CoordinatorWorkEventKind::Started,
            session_id: Some(session_id.clone()),
            page_id: Some(page_id.clone()),
            payload: serde_json::json!({"launch_id":launch_id}),
            dedupe_key: format!("started:{page_id}:{launch_id}"),
        },
        now,
    )?;
        connection, library, context, commit, operation, &page_ids, effects,
}
