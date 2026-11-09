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

fn validate_start(
    c: &Connection,
    page: &str,
    session: &str,
    launch: &str,
    message: &str,
    brief: &str,
) -> Result<(), StoreError> {
    for (name, id) in [
        ("page_id", page),
        ("session_id", session),
        ("launch_id", launch),
        ("message_id", message),
    ] {
        validate_id(name, id)?;
    }
    if brief.trim().is_empty() || brief.len() > 256_000 {
        return Err(invalid("Work brief must contain 1–256000 bytes"));
    }
    if !super::execution_holds::for_page(c, page)?.is_empty() {
        return Err(conflict("Resume work before starting this Page"));
    }
    Ok(())
}

pub(super) fn launch(
    connection: &Connection,
    id: &str,
) -> Result<Option<PageWorkLaunch>, StoreError> {
    validate_id("launch_id", id)?;
    let automation_decision:Option<String> = connection.query_row("SELECT dispatch_id FROM automation_decisions WHERE page_id=(SELECT page_id FROM page_work_launches WHERE launch_id=?1) AND assessment_json IS NOT NULL", [id], |r|r.get(0)).optional()?;
    let automation_decision = automation_decision.filter(|decision| {
        crate::domain::identity::stable_uuid_v7("automation-page-start", decision, "launch") == id
    });
    Ok(connection.query_row("SELECT launch_id,page_id,project_id,session_id,message_id,selection_json,brief,again,created_at,accepted_at,rejection,status_fence,status_moved FROM page_work_launches WHERE launch_id=?1", [id], |r| {
        let selection: String = r.get(5)?;
        Ok(PageWorkLaunch {automation_decision_id:automation_decision.clone(),launch_id:r.get(0)?,page_id:r.get(1)?,project_id:r.get(2)?,session_id:r.get(3)?,message_id:r.get(4)?,selection:serde_json::from_str(&selection).map_err(|_|rusqlite::Error::InvalidQuery)?,brief:r.get(6)?,again:r.get(7)?,created_at:r.get(8)?,accepted_at:r.get(9)?,rejection:r.get(10)?,status_fence:r.get(11)?,status_moved:r.get(12)?})
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
        if value.automation_decision_id.is_some() {
            connection.execute("UPDATE automation_decisions SET status=?2,failure_message=?3,updated_at_ms=CAST(unixepoch(?4,'subsec')*1000 AS INTEGER) WHERE dispatch_id=?1 AND status='admitted'",params![value.automation_decision_id,if rejection.is_some(){"failed"}else{"admitted"},rejection,now])?;
        }
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
        super::inbox_projection::require_member_turn(
            connection,
            context,
            library,
            page_id,
            Some(episode),
        )?;
    }
    validate_start(
        connection, page_id, session_id, launch_id, message_id, brief,
    )?;
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
        prepare_start(
            connection,
            context,
            scope.evidence(),
            library,
            operation,
            page_id,
            selection.as_ref(),
            session_id,
            launch_id,
            message_id,
            brief,
            *again,
            expected_readiness_epoch.as_deref(),
            &now,
        )
    })
}

#[allow(clippy::too_many_arguments)]
pub(super) fn prepare_start(
    connection: &Connection,
    context: &BoundModuleContext,
    commit: &crate::infrastructure::local_commit::CommitContext,
    library: &str,
    operation: &str,
    page_id: &String,
    selection: Option<&nodex_core_contracts::library::AgentWorkSelection>,
    session_id: &String,
    launch_id: &String,
    message_id: &String,
    brief: &String,
    again: bool,
    expected_readiness_epoch: Option<&str>,
    now: &str,
) -> Result<super::mutation::WorkspaceMutationEffects, StoreError> {
    validate_start(
        connection, page_id, session_id, launch_id, message_id, brief,
    )?;
    let work = crate::database::work_graph::work_context(connection, library, page_id)?;
    if let Some(expected) = expected_readiness_epoch {
        let ready = crate::database::work_graph::ready_page(connection, library, page_id)?;
        if !ready.is_some_and(|r| r.readiness_epoch == expected && r.page_work.auto_start) {
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
        .cloned()
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
    let requesting_member = context
        .actor
        .member_id()
        .or(context.authorizing_member_id.as_deref())
        .or(work.page_work.as_ref().map(|work| work.owner.as_str()))
        .ok_or_else(|| {
            StoreError::new(
                StoreErrorCode::Unauthorized,
                "Work requires its requesting Member",
                false,
            )
        })?;
    if !crate::library::members::is_active(connection, library, requesting_member)? {
        return Err(StoreError::new(
            StoreErrorCode::Unauthorized,
            "Work requires an active requesting Member",
            false,
        ));
    }
    // Capture the person at launch; execution observations must not fall back to
    // a different Page Owner or a later message in the same Session. The person who started the
    // work owns the chat.
    super::chat_stewardship::record_owner(connection, session_id, requesting_member, now)?;
    super::session_mutation::accept_person_message(
        connection,
        session_id,
        message_id,
        requesting_member,
        now,
    )?;
    super::coordinator::set_managed(connection, session_id, true, now)?;
    let retired = super::inbox::nodex::retire_page_start(connection, library, page_id, now)?;
    let inbox_changed = !retired.is_empty();
    connection.execute("INSERT INTO page_work_launches(launch_id,page_id,project_id,session_id,message_id,selection_json,brief,again,created_at,status_fence,actor_json) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,(SELECT status_person_revision FROM pages WHERE block_id=?2),?10)", params![launch_id,page_id,work.project_id,session_id,message_id,serde_json::to_string(&selection).map_err(|_|invalid("Invalid Agent selection"))?,brief,again,now,crate::infrastructure::actors::encode(&context.actor)?])?;
    connection.execute(
        "UPDATE page_work_launches SET automatic=?2 WHERE launch_id=?1",
        params![launch_id, expected_readiness_epoch.is_some()],
    )?;
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
    let effects = super::mutation::WorkspaceMutationEffects {
        operation_kind: if inbox_changed {
            "inbox_start_page_work"
        } else {
            "start_page_work"
        },
        project_catalog_change: None,
        change_project_id: Some(work.project_id.clone()),
        project_ids: vec![work.project_id.clone()],
        session_ids: vec![session_id.clone()],
        thread_ids: vec![],
        session_summary_scopes: vec![project_session_scope(Some(&work.project_id))],
        session_detail_ids: vec![session_id.clone()],
        block_ids: retired.iter().cloned().chain([page_id.clone()]).collect(),
        page_ids: retired.into_iter().chain([page_id.clone()]).collect(),
        document_ids: vec![],
        database_ids: vec![],
        data_source_ids: vec![],
        view_ids: vec![],
        document_heads: vec![],
        committed_at: now.to_owned(),
    };
    super::page_chat::advance_handed_off_pages(
        connection, library, context, commit, operation, &page_ids, effects,
    )
}
