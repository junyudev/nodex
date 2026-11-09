//! Coordinator notes explain a Page's current Turn; answers remain conversations.
use super::*;
use nodex_core_contracts::workspace::{ProjectWorkspaceIntent, TurnActor, TurnReason};

fn coordinator_caller(
    connection: &Connection,
    provenance: Option<&AgentTurnProvenance>,
) -> Result<String, StoreError> {
    let provenance = provenance.ok_or_else(|| {
        StoreError::new(
            StoreErrorCode::Unauthorized,
            "Only the Coordinator can write Turn notes or Inbox answers",
            false,
        )
    })?;
    let session = match &provenance.authority.runtime {
        Some(runtime) => Some(runtime.session_id.clone()),
        None => connection
            .query_row(
                "SELECT session_id FROM project_session_threads WHERE thread_id=?1",
                [&provenance.authority.root_thread_id],
                |r| r.get::<_, String>(0),
            )
            .optional()?,
    };
    if session.is_none() || session != super::super::coordinator::binding(connection)? {
        return Err(StoreError::new(
            StoreErrorCode::Unauthorized,
            "Only the Coordinator can write Turn notes or Inbox answers",
            false,
        ));
    }
    Ok(session.expect("verified Coordinator"))
}

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
/// Resolution ends delivery of a Work fact, independently of Inbox membership.
pub(in crate::workspace) fn retire_attention(
    connection: &Connection,
    _library: &str,
    event_ids: &[String],
    now: &str,
) -> Result<Vec<String>, StoreError> {
    for id in event_ids {
        connection.execute("UPDATE coordinator_event_batches SET invalidated_at=COALESCE(invalidated_at,?2) WHERE batch_id=(SELECT batch_id FROM coordinator_work_events WHERE event_id=?1) AND accepted_at IS NULL AND discarded_at IS NULL",params![id,now])?;
        connection.execute("UPDATE coordinator_work_events SET resolved_at=COALESCE(resolved_at,?2) WHERE event_id=?1",params![id,now])?;
    }
    Ok(vec![])
}
pub(in crate::workspace) fn retire_page_start(
    connection: &Connection,
    library: &str,
    page: &str,
    now: &str,
) -> Result<Vec<String>, StoreError> {
    let ids=connection.prepare("SELECT event_id FROM coordinator_work_events WHERE kind='ready_to_start' AND page_id=?1 AND resolved_at IS NULL")?.query_map([page],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    retire_attention(connection, library, &ids, now)
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
    let caller = if matches!(
        intent,
        ProjectWorkspaceIntent::WriteTurnNote { .. }
            | ProjectWorkspaceIntent::AnswerInboxQuestion { .. }
    ) {
        Some(coordinator_caller(connection, provenance)?)
    } else {
        {
            require_host(context)?;
        }
        if provenance.is_some() || context.agent_attribution.is_some() {
            return Err(StoreError::new(
                StoreErrorCode::Unauthorized,
                "Only a person may act on an Inbox Turn",
                false,
            ));
        }
        None
    };
    run_mutation(
        connection,
        context,
        epoch,
        operation,
        hash,
        &now,
        |scope| match intent {
            ProjectWorkspaceIntent::WriteTurnNote {
                page_id,
                note_id,
                body,
                event_ids,
                notify,
            } => {
                validate_id("note_id", note_id)?;
                if body.trim().is_empty() || body.chars().count() > 2000 {
                    return Err(invalid(
                        "Turn note body must contain 1–2000 characters and at most 100 words",
                    ));
                }
                if event_ids.is_empty()
                    || event_ids.len() > 8
                    || event_ids.iter().collect::<BTreeSet<_>>().len() != event_ids.len()
                {
                    return Err(invalid(
                        "Pass 1–8 distinct eventIds from your delivered Work updates",
                    ));
                }
                let turn = super::super::page_turn::read_turns(
                    connection,
                    library,
                    std::slice::from_ref(page_id),
                )?
                .remove(0);
                let caller = caller.as_ref().expect("Coordinator");
                let active: Option<String> = connection
                    .query_row(
                        "SELECT session_id FROM page_active_chats WHERE page_id=?1",
                        [page_id],
                        |r| r.get(0),
                    )
                    .optional()?;
                let mut existing: Option<String> = None;
                for event in event_ids {
                    validate_id("event_id", event)?;
                    let subject:Option<(Option<String>,Option<String>,bool)>=connection.query_row("SELECT event.page_id,event.session_id,event.resolved_at IS NOT NULL FROM coordinator_work_events event JOIN coordinator_event_batches batch ON batch.batch_id=event.batch_id WHERE event.event_id=?1 AND batch.coordinator_session_id=?2 AND batch.accepted_at IS NOT NULL",params![event,caller],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
                    let Some((page, session, resolved)) = subject else {
                        return Err(invalid(&format!(
                            "Event {event} was not delivered to this Coordinator"
                        )));
                    };
                    if page.as_deref() != Some(page_id)
                        && !(page.is_none() && active.is_some() && session == active)
                    {
                        return Err(invalid(&format!(
                            "Event {event} does not concern this Page or its active chat"
                        )));
                    }
                    let bound:Option<String>=connection.query_row("SELECT note_id FROM page_turn_note_events WHERE page_id=?1 AND episode=?2 AND event_id=?3",params![page_id,turn.episode,event],|r|r.get(0)).optional()?;
                    if bound.is_none() && resolved {
                        return Err(conflict(
                            "This Work event is already resolved; no note was written",
                        ));
                    }
                    if let Some(bound) = bound {
                        if existing.as_ref().is_some_and(|id| id != &bound) {
                            return Err(conflict("These events already back different Turn notes"));
                        }
                        existing = Some(bound)
                    }
                }
                if let Some(id) = existing {
                    let exact:bool=connection.query_row("SELECT body=?2 AND notify=?3 AND coordinator_session_id=?4 AND (SELECT count(*) FROM page_turn_note_events WHERE note_id=?1)=?5 AND NOT EXISTS(SELECT 1 FROM json_each(?6) requested WHERE NOT EXISTS(SELECT 1 FROM page_turn_note_events linked WHERE linked.note_id=?1 AND linked.event_id=requested.value)) FROM page_turn_notes WHERE note_id=?1",params![id,body,notify,caller,event_ids.len() as i64,serde_json::to_string(event_ids).expect("event IDs")],|r|r.get(0))?;
                    if !exact {
                        return Err(conflict(
                            "An event already backs a note in this episode; retry its exact body, notify and eventIds",
                        ));
                    }
                    let mut effects = simple_effects("inbox_write_replay", &now);
                    effects.page_ids.push(page_id.clone());
                    return Ok(effects);
                }
                connection.execute(
                    params![
                        note_id,
                        page_id,
                        local,
                        turn.episode,
                        caller,
                        body,
                        notify,
                        scope.evidence().commit_seq(),
                        now
                    ],
                )?;
                for event in event_ids {
                    connection.execute(
                        "INSERT INTO page_turn_note_events VALUES(?1,?2,?3,?4)",
                        params![page_id, turn.episode, event, note_id],
                    )?;
                }
                if *notify
                    && matches!(
                        turn.reason,
                        Some(
                            TurnReason::Review
                                | TurnReason::Blocked
                                | TurnReason::Failed
                                | TurnReason::Stalled
                        )
                    )
                {
                    connection.execute("INSERT INTO page_turn_notification_intents(member_id,page_id,episode,created_at) VALUES(?1,?2,?3,?4) ON CONFLICT DO NOTHING",params![local,page_id,turn.episode,now])?;
                }
                let mut effects = simple_effects("inbox_write", &now);
                effects.page_ids.push(page_id.clone());
                Ok(effects)
            }
            ProjectWorkspaceIntent::AnswerInboxQuestion {
                question_page_id,
                page_id,
                document_id,
                body,
            } => {
                let caller = caller.as_ref().expect("Coordinator");
                if let Some(existing)=connection.query_row("SELECT answer.page_id FROM inbox_answers answer JOIN pages page ON page.block_id=answer.page_id JOIN document_materializations materialization ON materialization.document_id=page.document_id WHERE answer.question_page_id=?1 AND materialization.markdown=?2",params![question_page_id,message_page(body,None)?.body_markdown],|r|r.get::<_,String>(0)).optional()?{
                    let mut effects=simple_effects("inbox_write_replay",&now);effects.page_ids.push(existing);return Ok(effects)
                }
                let project:Option<String>=connection.query_row("SELECT scope_project_id FROM inbox_entries entry JOIN blocks block ON block.id=entry.page_id AND block.lifecycle='active' WHERE entry.page_id=?1 AND entry.library_id=?2 AND entry.state='open' AND (entry.kind IS NULL OR entry.kind='question') AND EXISTS(SELECT 1 FROM inbox_rows row WHERE row.page_id=entry.page_id AND row.row_kind='intake' AND row.in_inbox=1)",params![question_page_id,library],|r|r.get(0)).optional()?.ok_or_else(||conflict("The Inbox question is no longer waiting for an answer"))?;
                let source = EntrySource {
                    kind: "answer",
                    session_id: Some(caller.clone()),
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
                set_entries_state(
                    connection,
                    library,
                    std::slice::from_ref(question_page_id),
                    "done",
                    &now,
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
                    connection,
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
