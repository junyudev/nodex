//! Person replies commit their decision and delivery evidence with capture.
use super::*;
use nodex_core_contracts::inbox::InboxReplyDispatch;
use nodex_core_contracts::workspace::ProjectWorkspaceSessionExecutionRef;

/// Person replies reuse the durable handoff owner without creating an intake entry.
#[allow(clippy::too_many_arguments)]
pub(super) fn turn_reply(
    connection: &Connection,
    library: &str,
    epoch: &str,
    operation: &str,
    page: &str,
    episode: &str,
    body: &str,
    dispatch: &InboxReplyDispatch,
    now: &str,
) -> Result<WorkspaceMutationEffects, StoreError> {
    if body.trim().is_empty() || body.len() > MAX_MESSAGE_BYTES {
        return Err(invalid("Reply is empty or too large"));
    }
    if !matches!(
        turn.reason,
        Some(
            nodex_core_contracts::workspace::TurnReason::Question
                | nodex_core_contracts::workspace::TurnReason::Review
                | nodex_core_contracts::workspace::TurnReason::Blocked
                | nodex_core_contracts::workspace::TurnReason::Failed
                | nodex_core_contracts::workspace::TurnReason::Stalled
        )
    ) {
        return Err(conflict("Open the active chat for this Turn"));
    }
    let session:String=connection.query_row("SELECT active.session_id FROM page_active_chats active JOIN project_sessions session ON session.id=active.session_id AND session.archived=0 WHERE active.page_id=?1",[page],|r|r.get(0)).optional()?.ok_or_else(||conflict("No active chat can receive this reply; open the Page"))?;
    if !super::super::execution_holds::for_session(connection, &session)?.is_empty() {
        return Err(conflict("Resume work before replying"));
    }
    let observation: Option<String> = connection
        .query_row(
            "SELECT observed_json FROM session_execution_observations WHERE session_id=?1",
            [&session],
            |r| r.get(0),
        )
        .optional()?;
    let observation: Option<nodex_core_contracts::workspace::SessionExecutionObservation> =
        observation
            .map(|value| {
                serde_json::from_str(&value).map_err(|_| corrupt("Invalid execution observation"))
            })
            .transpose()?;
    let requests = observation
        .as_ref()
        .map(|o| o.pending_requests.as_slice())
        .unwrap_or_default();
    let response = match dispatch {
        InboxReplyDispatch::Send => {
            if !requests.is_empty() {
                return Err(conflict(
                    "The chat has a pending request; open the chat to answer it",
                ));
            }
            None
        }
        InboxReplyDispatch::Answer { response } => {
            if requests.len() != 1
                || requests[0].kind
                    != nodex_core_contracts::workspace::SessionExecutionRequestKind::Question
                || requests[0].id != response.request_id
                || observation.as_ref().and_then(|o| o.run_id.as_ref()) != response.run_id.as_ref()
            {
                return Err(conflict(
                    "The chat's pending question changed; open the chat",
                ));
            }
            Some(response)
        }
    };
    let proposal = stable_uuid_v7(operation, "turn-reply", page);
    let action = ProjectWorkspaceInboxDispatchAction::SendToChat {
        session_id: session.clone(),
        prompt: body.into(),
        additions: vec![],
    };
    connection.execute("INSERT INTO inbox_proposals(proposal_id,library_id,origin,state,action_json,summary,basis_json,dispatch_session_id,confirmed_at,confirmed_by,attempt,created_at,updated_at) VALUES(?1,?2,'user','dispatching',?3,'Reply to the active chat','[]',?4,?5,'user',1,?5,?5)",params![proposal,library,action_json(&action)?,session,now])?;
    connection.execute(
        "INSERT INTO page_turn_replies VALUES(?1,?2,?3)",
        params![proposal, page, episode],
    )?;
    let target=connection.query_row("SELECT runtime_id,runtime_thread_id FROM project_session_execution_bindings WHERE session_id=?1",[&session],|r|Ok(ProjectWorkspaceSessionExecutionRef{runtime_id:r.get(0)?,thread_id:r.get(1)?})).optional()?;
    connection.execute("INSERT INTO inbox_handoffs(proposal_id,store_epoch,final_text,launch_id,message_id,target_execution_ref_json,question_response_json) VALUES(?1,?2,?3,?4,?5,?6,?7)",params![proposal,epoch,body,reliable::handoff_identity(&proposal,"launch",epoch),reliable::handoff_identity(&proposal,"message",epoch),target.map(|v|serde_json::to_string(&v)).transpose().map_err(|_|internal("Reply target cannot be encoded"))?,response.map(serde_json::to_string).transpose().map_err(|_|internal("Answer cannot be encoded"))?])?;
    let mut effects = simple_effects("inbox_turn_reply", now);
    effects.page_ids.push(page.into());
    effects.session_ids.push(session);
    Ok(effects)
}
