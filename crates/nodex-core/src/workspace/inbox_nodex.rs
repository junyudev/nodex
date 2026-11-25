//! Inbox answers, Turn replies, and notification claims.
use super::*;
use nodex_core_contracts::workspace::{ProjectWorkspaceIntent, TurnActor};

pub(super) fn require_reply(
    connection: &Connection,
    library: &str,
    reply: Option<&str>,
    project: Option<&str>,
) -> Result<Option<String>, StoreError> {
    let Some(id) = reply else { return Ok(None) };
    validate_id("reply_to_page_id", id)?;
    let valid=connection.query_row("SELECT EXISTS(SELECT 1 FROM inbox_answers answer JOIN blocks block ON block.id=answer.page_id AND block.lifecycle='active' WHERE answer.page_id=?1 AND answer.library_id=?2 AND answer.scope_project_id IS ?3)",params![id,library,project],|r|r.get::<_,bool>(0))?;
    if !valid {
        return Err(invalid(
            "Reply must name an active Nodex answer in the same Inbox",
        ));
    }
    Ok(Some("answer".into()))
}
pub(super) fn finish_reply(
    connection: &Connection,
    _library: &str,
    reply: Option<&str>,
    now: &str,
) -> Result<(), StoreError> {
    if let Some(id) = reply {
        connection.execute(
            "UPDATE inbox_answers SET handled_at=COALESCE(handled_at,?2) WHERE page_id=?1",
            params![id, now],
        )?;
    }
    Ok(())
}
#[allow(clippy::too_many_arguments)]
pub(in crate::workspace) fn apply(
    connection: &Connection,
    library: &str,
    context: &BoundModuleContext,
    epoch: &str,
    operation: &str,
    hash: &str,
    provenance: Option<&AgentTurnProvenance>,
    intent: &ProjectWorkspaceIntent,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    let now = sqlite_now(connection)?;
    if !matches!(intent, ProjectWorkspaceIntent::AnswerInboxQuestion { .. })
        && context.adapter != nodex_core_contracts::AdapterKind::RemoteMember
    {
        require_host(context)?;
    }
    run_mutation(
        connection,
        context,
        epoch,
        operation,
        hash,
        &now,
        |scope| match intent {
            ProjectWorkspaceIntent::AnswerInboxQuestion {
                request_id,
                generation,
                question_page_id,
                page_id,
                document_id,
                body,
            } => {
                let caller = super::super::decision_run::caller(provenance)?;
                super::reliable::require_routing_delivery(
                    connection,
                    library,
                    request_id,
                    *generation,
                    caller,
                )?;
                let included = connection.query_row(
                    "SELECT EXISTS(SELECT 1 FROM inbox_suggestion_request_pages WHERE request_id=?1 AND page_id=?2)",
                    params![request_id,question_page_id], |row| row.get::<_, bool>(0),
                )?;
                if !included {
                    return Err(super::super::decision_run::denied());
                }
                if let Some(existing)=connection.query_row("SELECT answer.page_id FROM inbox_answers answer JOIN pages page ON page.block_id=answer.page_id JOIN document_materializations materialization ON materialization.document_id=page.document_id WHERE answer.question_page_id=?1 AND materialization.markdown=?2 AND answer.decision_session_id=?3",params![question_page_id,message_page(body,None)?.body_markdown,caller],|r|r.get::<_,String>(0)).optional()?{
                    let mut effects=simple_effects("inbox_write_replay",&now);effects.page_ids.push(existing);return Ok(effects)
                }
                if super::reliable::read_request(connection, context, library, request_id)?
                    .is_none_or(|request| request.generation != *generation)
                {
                    return Err(conflict("This routing request is no longer pending"));
                }
                let project:Option<String>=connection.query_row("SELECT intake.project_id FROM inbox_entries entry JOIN inbox_intake intake ON intake.page_id=entry.page_id WHERE entry.page_id=?1 AND entry.library_id=?2 AND intake.triage AND (entry.kind IS NULL OR entry.kind='question') AND EXISTS(SELECT 1 FROM inbox_rows row WHERE row.page_id=entry.page_id AND row.row_kind='intake' AND row.in_inbox=1)",params![question_page_id,library],|r|r.get(0)).optional()?.ok_or_else(||conflict("The Inbox question is no longer waiting for an answer"))?;
                let source = EntrySource {
                    kind: "answer",
                    session_id: Some(caller.to_owned()),
                    reply_to_page_id: Some(question_page_id.clone()),
                    ..EntrySource::default()
                };
                let mut effects = capture_message_in_scope(
                    connection,
                    library,
                    context,
                    epoch,
                    operation,
                    scope,
                    page_id,
                    document_id,
                    &message_page(body, None)?,
                    &source,
                    project.as_deref(),
                    &now,
                )?;
                move_message_status(
                    connection,
                    library,
                    context,
                    operation,
                    std::slice::from_ref(question_page_id),
                    "done",
                    false,
                    &mut effects,
                )?;
                move_message_status(
                    connection,
                    library,
                    context,
                    operation,
                    std::slice::from_ref(page_id),
                    "done",
                    false,
                    &mut effects,
                )?;
                effects.operation_kind = "inbox_write";
                effects.page_ids.insert(0, page_id.clone());
                effects.page_ids.push(question_page_id.clone());
                Ok(effects)
            }
            ProjectWorkspaceIntent::ReplyToPageTurn {
                page_id,
                episode,
                body,
                dispatch,
            } => super::reply::turn_reply(
                connection,
                context,
                library,
                epoch,
                operation,
                page_id,
                episode,
                body,
                dispatch.as_ref().ok_or_else(|| {
                    conflict("This reply cannot be delivered; open the active chat")
                })?,
                &now,
            ),
            ProjectWorkspaceIntent::ClaimTurnNotification { page_id, episode } => {
                let turn = super::super::inbox_projection::require_member_turn(
                    connection,
                    context,
                    library,
                    page_id,
                    Some(episode),
                )?;
                let TurnActor::Member { member_id } = turn.actor else {
                    return Err(conflict("This Turn is no longer yours"));
                };
                let changed=connection.execute("UPDATE page_turn_notification_intents SET claimed_at=?4 WHERE member_id=?1 AND page_id=?2 AND episode=?3 AND claimed_at IS NULL",params![member_id,page_id,episode,now])?;
                let mut effects = simple_effects(
                    if changed == 1 {
                        "inbox_write"
                    } else {
                        "inbox_write_replay"
                    },
                    &now,
                );
                effects.page_ids.push(page_id.clone());
                Ok(effects)
            }
            _ => Err(internal("Invalid Inbox writing command")),
        },
    )
}
