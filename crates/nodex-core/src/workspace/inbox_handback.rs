//! Delivery evidence and routing receipts. Runtime owns the original chat content.
use super::*;
use nodex_core_contracts::inbox::ProjectWorkspaceInboxSource;
use nodex_core_contracts::inbox::{ChatMessageHandbackReceipt, ChatMessageInbound, InboxHandback};
use nodex_core_contracts::workspace::ProjectWorkspaceIntent;

pub(in crate::workspace) fn inbound(
    connection: &Connection,
    session: &str,
    run: &str,
) -> Result<Option<ChatMessageInbound>, StoreError> {
    let delivery: Option<(String,u32,bool)> = connection.query_row("SELECT delivery.delivery_id,delivery.attachment_count,inbound.question_answered FROM chat_message_inbounds inbound JOIN chat_message_deliveries delivery USING(delivery_id) WHERE inbound.session_id=?1 AND inbound.run_id=?2",params![session,run],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
    let Some((id, count, answered)) = delivery else {
        return Ok(None);
    };
    let pages = delivery_pages(connection, &id)?
        .into_iter()
        .map(|(page, _, _)| page)
        .collect();
    Ok(Some(ChatMessageInbound {
        delivery_id: id.clone(),
        session_id: session.into(),
        run_id: run.into(),
        original_page_ids: pages,
        attachment_count: count,
        question_answered: answered,
        receipt: receipt(connection, &id)?,
    }))
}
fn receipt(
    connection: &Connection,
    id: &str,
) -> Result<Option<ChatMessageHandbackReceipt>, StoreError> {
    let receipt: Option<String> = connection
        .query_row(
            "SELECT receipt_id FROM chat_message_handbacks WHERE delivery_id=?1",
            [id],
            |r| r.get(0),
        )
        .optional()?;
    receipt.map(|id|{let pages=connection.prepare("SELECT page_id FROM chat_message_handback_pages WHERE receipt_id=?1 ORDER BY page_id")?.query_map([&id],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;Ok(ChatMessageHandbackReceipt{receipt_id:id,page_ids:pages})}).transpose()
}
pub(in crate::workspace) fn context(
    connection: &Connection,
    library: &str,
    page: &str,
) -> Result<Option<InboxHandback>, StoreError> {
    // Historical serializers run before handback authority is installed.
    let revision: i64 = connection.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if revision < 204 {
        return Ok(None);
    }
    let row:Option<(String,String,String,String,String)>=connection.query_row("SELECT receipt.receipt_id,delivery.session_id,delivery.destination_title,receipt.reason,receipt.created_at FROM chat_message_handback_pages member JOIN chat_message_handbacks receipt USING(receipt_id) JOIN chat_message_deliveries delivery USING(delivery_id) WHERE member.page_id=?1 ORDER BY receipt.created_seq DESC LIMIT 1",[page],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional()?;
    let Some((id, session, title, reason, at)) = row else {
        return Ok(None);
    };
    let chat = super::super::inbox_read::read_chat(connection, library, &session)?.unwrap_or(
        nodex_core_contracts::inbox::ProjectWorkspaceInboxChat {
            session_id: session,
            project_id: None,
            project_name: None,
            display_title: title,
            thread_id: None,
            execution_ref: None,
            status: None,
            unread: false,
            archived: true,
        },
    );
    Ok(Some(InboxHandback {
        receipt_id: id,
        chat,
        reason,
        returned_at: at,
    }))
}
fn delivery_pages(
    connection: &Connection,
    id: &str,
) -> Result<Vec<(String, Option<String>, String)>, StoreError> {
    Ok(connection.prepare("SELECT page_id,proposal_id,content_fingerprint FROM chat_message_delivery_pages WHERE delivery_id=?1 ORDER BY page_id")?.query_map([id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?.collect::<rusqlite::Result<Vec<_>>>()?)
}
pub(in crate::workspace) fn record(
    connection: &Connection,
    library: &str,
    intent: &ProjectWorkspaceIntent,
    now: &str,
) -> Result<WorkspaceMutationEffects, StoreError> {
    let ProjectWorkspaceIntent::RecordChatDelivery {
        session_id,
        delivery_id,
        body_hash,
        author,
        attachment_count,
        question_answer_run_id,
    } = intent
    else {
        unreachable!()
    };
    validate_id("delivery_id", delivery_id)?;
    if body_hash.len() != 64
        || !body_hash.bytes().all(|b| b.is_ascii_hexdigit())
        || *attachment_count > 100
    {
        return Err(invalid("Invalid message delivery evidence"));
    }
    if matches!(author, ProjectWorkspaceInboxSource::Nodex { .. }) {
        return Err(invalid("Inbox answers are not chat deliveries"));
    }
    let chat = super::super::inbox_read::read_chat(connection, library, session_id)?
        .filter(|chat| !chat.archived)
        .ok_or_else(|| not_found("The delivery chat is unavailable"))?;
    let title = chat.display_title;
    let source = serde_json::to_string(author).map_err(|_| invalid("Invalid message author"))?;
    let old:Option<(String,String,String,u32)>=connection.query_row("SELECT session_id,body_hash,author_json,attachment_count FROM chat_message_deliveries WHERE delivery_id=?1",[delivery_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
    if let Some(old) = old {
        let github_batch:bool=connection.query_row("SELECT EXISTS(SELECT 1 FROM thread_delivery_batches WHERE message_id=?1 AND session_id=?2 AND body_hash=?3 AND library_id=?4)",params![delivery_id,session_id,body_hash,library],|r|r.get(0))?;
        if github_batch && old.0 == *session_id && old.1 == *body_hash && old.3 == *attachment_count
        {
            return Ok(simple_effects("chat_delivery_replay", now));
        }
        if old
            != (
                session_id.clone(),
                body_hash.clone(),
                source,
                *attachment_count,
            )
        {
            return Err(conflict(
                "This delivery identity already names another message",
            ));
        }
        return Ok(simple_effects("chat_delivery_replay", now));
    }
    let answer=question_answer_run_id.is_some() || connection.query_row("SELECT EXISTS(SELECT 1 FROM inbox_handoffs WHERE message_id=?1 AND question_response_json IS NOT NULL)",[delivery_id],|r|r.get::<_,bool>(0))?;
    connection.execute("INSERT INTO chat_message_deliveries(delivery_id,library_id,session_id,destination_title,body_hash,author_json,attachment_count,question_answer,answer_run_id,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",params![delivery_id,library,session_id,title,body_hash,source,attachment_count,answer,question_answer_run_id,now])?;
    let members=connection.prepare("SELECT member.page_id,proposal.proposal_id FROM inbox_handoffs handoff JOIN inbox_proposals proposal USING(proposal_id) JOIN inbox_proposal_pages member USING(proposal_id) WHERE handoff.message_id=?1 AND proposal.dispatch_session_id=?2 ORDER BY member.position")?.query_map(params![delivery_id,session_id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
    if !members.is_empty() {
        connection.execute(
            "UPDATE chat_message_deliveries SET original_page_count=?2 WHERE delivery_id=?1",
            params![delivery_id, members.len() as i64],
        )?;
    }
    for (page, proposal) in &members {
        let hash:String=connection.query_row("SELECT json_extract(basis.value,'$.content_hash') FROM inbox_proposals proposal,json_each(proposal.basis_json) basis WHERE proposal.proposal_id=?1 AND json_extract(basis.value,'$.page_id')=?2",params![proposal,page],|r|r.get(0))?;
        connection.execute(
            "INSERT INTO chat_message_delivery_pages VALUES(?1,?2,?3,?4)",
            params![delivery_id, page, proposal, hash],
        )?;
        let inherited:Option<String>=connection.query_row("SELECT receipt.delivery_id FROM chat_message_handback_pages member JOIN chat_message_handbacks receipt USING(receipt_id) WHERE member.page_id=?1 ORDER BY receipt.created_seq DESC LIMIT 1",[page],|r|r.get(0)).optional()?;
        if let Some(parent) = inherited {
            connection.execute("INSERT OR IGNORE INTO chat_message_delivery_origins SELECT ?1,origin_id FROM chat_message_delivery_origins WHERE delivery_id=?2",params![delivery_id,parent])?;
            continue;
        }
        connection.execute(
            "INSERT OR IGNORE INTO chat_message_delivery_origins VALUES(?1,?2)",
            params![delivery_id, page],
        )?;
    }
    if members.is_empty() {
        connection.execute(
            "INSERT INTO chat_message_delivery_origins VALUES(?1,?1)",
            [delivery_id],
        )?;
    }
    if let Some(run) = question_answer_run_id {
        connection.execute("UPDATE chat_message_inbounds SET question_answered=1 WHERE session_id=?1 AND run_id=?2",params![session_id,run])?;
    }
    Ok(simple_effects("chat_delivery", now))
}
/// The chat delivery a handback answers: the Run and delivery it returns, the message digest and its author.
struct HandbackDelivery<'a> {
    session: &'a str,
    run: &'a str,
    delivery: &'a str,
    body_hash: &'a str,
    attachment_count: u32,
    author: &'a ProjectWorkspaceInboxSource,
fn bind(
    connection: &Connection,
    library: &str,
    handback_delivery: HandbackDelivery<'_>,
    now: &str,
) -> Result<WorkspaceMutationEffects, StoreError> {
    let HandbackDelivery {
        body_hash,
        attachment_count,
    } = handback_delivery;
    if body_hash.len() != 64
        || !body_hash.bytes().all(|b| b.is_ascii_hexdigit())
        || attachment_count > 100
    {
        return Err(invalid("Invalid inbound message evidence"));
    }
    let exists=connection.query_row("SELECT EXISTS(SELECT 1 FROM chat_message_deliveries WHERE session_id=?1 AND delivery_id=?2)",params![session,delivery],|r|r.get::<_,bool>(0))?;
    if !exists {
        record(
            connection,
            library,
            &ProjectWorkspaceIntent::RecordChatDelivery {
                session_id: session.into(),
                delivery_id: delivery.into(),
                body_hash: body_hash.into(),
                author: author.clone(),
                attachment_count,
                question_answer_run_id: None,
            },
            now,
        )?;
    }
    let old: Option<String> = connection
        .query_row(
            "SELECT delivery_id FROM chat_message_inbounds WHERE session_id=?1 AND run_id=?2",
            params![session, run],
            |r| r.get(0),
        )
        .optional()?;
    if old.as_deref().is_some_and(|old| old != delivery) {
        return Err(conflict(
            "This Run is already bound to another inbound message",
        ));
    }
    if old.is_none() {
        let changed = connection.query_row(
            "SELECT body_hash<>?2 FROM chat_message_deliveries WHERE delivery_id=?1",
            params![delivery, body_hash],
            |r| r.get::<_, bool>(0),
        )?;
        if changed {
            connection.execute(
                "UPDATE chat_message_deliveries SET original_page_count=0 WHERE delivery_id=?1",
                [delivery],
            )?;
            connection.execute(
                "DELETE FROM chat_message_delivery_pages WHERE delivery_id=?1",
                [delivery],
            )?;
        }
        connection.execute("UPDATE chat_message_deliveries SET body_hash=?2,attachment_count=?3 WHERE delivery_id=?1",params![delivery,body_hash,attachment_count])?;
    }
    connection.execute("INSERT OR IGNORE INTO chat_message_inbounds(session_id,run_id,delivery_id,question_answered) VALUES(?1,?2,?3,EXISTS(SELECT 1 FROM chat_message_deliveries WHERE session_id=?1 AND answer_run_id=?2))",params![session,run,delivery])?;
    connection.execute("INSERT OR REPLACE INTO session_run_members(session_id,run_id,member_id) SELECT ?1,?2,entry.author_member_id FROM chat_message_delivery_pages link JOIN inbox_entries entry ON entry.page_id=link.page_id WHERE link.delivery_id=?3 AND entry.author_member_id IS NOT NULL ORDER BY link.page_id LIMIT 1",params![session,run,delivery])?;
    Ok(simple_effects("chat_inbound", now))
}
#[allow(clippy::too_many_arguments)]
fn hand_back(
    connection: &Connection,
    library: &str,
    context: &BoundModuleContext,
    epoch: &str,
    operation: &str,
    scope: &crate::infrastructure::durable_mutation::DurableMutationScope<'_>,
    provenance: &AgentTurnProvenance,
    reason: &str,
    page: &str,
    document: &str,
    message: Option<&nodex_core_contracts::inbox::HandbackMessage>,
    now: &str,
) -> Result<WorkspaceMutationEffects, StoreError> {
    let runtime = provenance
        .authority
        .runtime
        .as_ref()
        .ok_or_else(|| conflict("A trusted inbound message is required to hand it back"))?;
    let session = &runtime.session_id;
    let managed = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM coordinator_managed_sessions WHERE session_id=?1)",
        [session],
        |r| r.get::<_, bool>(0),
    )?;
    if !managed {
        return Err(conflict(
            "Only a managed chat can hand back its inbound message",
        ));
    }
    let input = inbound(connection, session, &provenance.authority.turn_id)?
        .ok_or_else(|| conflict("This execution has no trusted inbound delivery to hand back"))?;
    if reason.trim().is_empty() || reason.chars().count() > 2000 {
        return Err(invalid("Handback reason must contain 1–2000 characters"));
    }
    if let Some(receipt) = input.receipt {
        let original: String = connection.query_row(
            "SELECT reason FROM chat_message_handbacks WHERE receipt_id=?1",
            [&receipt.receipt_id],
            |r| r.get(0),
        )?;
        if original != reason {
            return Err(conflict(
                "This message was already handed back with another reason",
            ));
        }
        let mut effects = simple_effects("inbox_write_replay", now);
        effects.page_ids = receipt.page_ids;
        return Ok(effects);
    }
    if input.question_answered {
        return Err(conflict(
            "An already-answered question cannot be handed back",
        ));
    }
    let limit=connection.query_row("SELECT EXISTS(SELECT 1 FROM chat_message_delivery_origins current WHERE current.delivery_id=?1 AND (SELECT count(*) FROM chat_message_delivery_origins previous JOIN chat_message_handbacks receipt ON receipt.delivery_id=previous.delivery_id WHERE previous.origin_id=current.origin_id)>=2)",[&input.delivery_id],|r|r.get::<_,bool>(0))?;
    if limit {
        return Err(conflict(
            "This message has already been handed back twice; it cannot be handed back again",
        ));
    }
    let pages = delivery_pages(connection, &input.delivery_id)?;
    let original_page_count: i64 = connection.query_row(
        "SELECT original_page_count FROM chat_message_deliveries WHERE delivery_id=?1",
        [&input.delivery_id],
        |r| r.get(0),
    )?;
    if original_page_count != pages.len() as i64 {
        return Err(conflict(
            "The original intake message was erased; it cannot be handed back",
        ));
    }

    for (id, proposal, hash) in &pages {
        if proposal.is_none() {
            return Err(conflict(
                "The original dispatch was removed; it cannot be handed back",
            ));
        }

        let valid=connection.query_row("SELECT EXISTS(SELECT 1 FROM inbox_entries entry JOIN blocks block ON block.id=entry.page_id AND block.lifecycle='active' WHERE entry.page_id=?1 AND entry.state='open' AND entry.current_proposal_id IS ?2 AND NOT EXISTS(SELECT 1 FROM inbox_answers WHERE question_page_id=entry.page_id))",params![id,proposal],|r|r.get::<_,bool>(0))?;
        if !valid || super::super::inbox_read::message_basis(connection, id)?.content_hash != *hash
        {
            return Err(conflict(
                "The message was changed, closed or answered since delivery; it cannot be handed back",
            ));
        }
    }
    let mut effects = simple_effects("inbox_write", now);
    if pages.is_empty() {
        let message =
            message.ok_or_else(|| invalid("The Host must supply the original inbound message"))?;
        let (hash,author,project):(String,String,Option<String>)=connection.query_row("SELECT delivery.body_hash,delivery.author_json,session.project_id FROM chat_message_deliveries delivery LEFT JOIN project_sessions session ON session.id=delivery.session_id WHERE delivery.delivery_id=?1",[&input.delivery_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
        if crate::document::sha256(message.text.as_bytes()) != hash {
            return Err(conflict(
                "The inbound text does not match the recorded delivery",
            ));
        }
        if message.files.len() != input.attachment_count as usize {
            return Err(invalid("All inbound attachments must be preserved"));
        }
        let file_markdown = crate::library::publish_inbound_files(
            connection,
            context,
            epoch,
            operation,
            scope,
            &message.files,
            now,
        )?;
        let combined = [message.text.as_str(), file_markdown.as_str()]
            .into_iter()
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>()
            .join("\n\n");
        if combined.trim().is_empty() {
            return Err(invalid(
                "The inbound message has no text or portable attachment to return",
            ));
        }
        if combined.len() > 1_179_648 {
            return Err(invalid(
                "The inbound message exceeds the Page capture limit",
            ));
        }
        let blocks = nodex_markdown::read(&combined, ReadOptions::BOUNDARY)
            .map_err(|error| invalid(&error.to_string()))?;
        let title = provisional_title(&message_title_text(&blocks));
        let body = MessagePage {
            title_markdown: title_markdown(&title),
            body_markdown: serialize_markdown(&blocks),
            provisional_title: Some(title),
        };
        let author: ProjectWorkspaceInboxSource =
            serde_json::from_str(&author).map_err(|_| corrupt("Invalid inbound author"))?;
        let source = source_for_capture(author.clone())?;
        effects = capture_message_in_scope(
            connection,
            library,
            context,
            epoch,
            operation,
            scope,
            page,
            document,
            &body,
            &source,
            project.as_deref(),
            now,
        )?;
        super::github::register(connection, page, &author)?;
        super::github::register_delivery_origins(connection, library, &input.delivery_id, page)?;
    }
    let receipt = stable_uuid_v7("inbox-handback", "delivery", &input.delivery_id);
    connection.execute(
        "INSERT INTO chat_message_handbacks(receipt_id,delivery_id,reason,created_seq,created_at) VALUES(?1,?2,?3,?4,?5)",
        params![
            receipt,
            input.delivery_id,
            reason,
            scope.evidence().commit_seq(),
            now
        ],
    )?;
    let ids = if pages.is_empty() {
        vec![page.to_string()]
    } else {
        pages.iter().map(|(page, _, _)| page.clone()).collect()
    };
    for id in &ids {
        connection.execute("UPDATE inbox_suggestion_requests SET state='superseded',generation=generation+1,correction=NULL WHERE state='pending' AND request_id IN (SELECT request_id FROM inbox_suggestion_request_pages WHERE page_id=?1)",[id])?;
        connection.execute("UPDATE inbox_entries SET state='open',outcome=NULL,current_proposal_id=NULL,suggestion_state='waiting',suggestion_error=NULL,suggestion_request_id=NULL,revision=revision+1,submitted_at=?2,updated_at=?2 WHERE page_id=?1",params![id,now])?;
        connection.execute(
            "INSERT INTO chat_message_handback_pages VALUES(?1,?2)",
            params![receipt, id],
        )?;
    }
    for (_, proposal, _) in &pages {
        if let Some(proposal) = proposal {
            connection.execute(
                "UPDATE inbox_handoffs SET final_text='' WHERE proposal_id=?1",
                [proposal],
            )?;
            connection.execute("UPDATE inbox_proposals SET state='completed',failure_kind=NULL,failure_message=NULL,revision=revision+1,updated_at=?2 WHERE proposal_id=?1 AND state='dispatching'",params![proposal,now])?;
        }
    }
    effects.operation_kind = "inbox_write";
    effects.page_ids = ids;
    effects.session_ids.push(session.clone());
    Ok(effects)
}
fn source_for_capture(source: ProjectWorkspaceInboxSource) -> Result<EntrySource, StoreError> {
    Ok(match source {
        ProjectWorkspaceInboxSource::Github { actor_login, .. } => EntrySource {
            kind: "github",
            label: Some(actor_login),
            ..Default::default()
        },
        ProjectWorkspaceInboxSource::User => EntrySource {
            kind: "user",
            ..EntrySource::default()
        },
        ProjectWorkspaceInboxSource::Agent {
            session_id,
            thread_id,
            run_id,
            project_id,
            label,
        } => EntrySource {
            kind: "agent",
            session_id,
            thread_id,
            turn_id: run_id,
            project_id,
            label: Some(label),
            ..EntrySource::default()
        },
        ProjectWorkspaceInboxSource::CommandLine { project_id, label } => EntrySource {
            kind: "command_line",
            project_id,
            label: Some(label),
            ..EntrySource::default()
        },
        _ => return Err(invalid("This inbound source cannot be captured")),
    })
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
    if !matches!(intent, ProjectWorkspaceIntent::HandBackMessage { .. }) && provenance.is_some() {
        return Err(invalid("Delivery evidence belongs to the Host"));
    }
    let now = sqlite_now(connection)?;
    run_mutation(
        connection,
        context,
        epoch,
        operation,
        hash,
        &now,
        |scope| match intent {
            ProjectWorkspaceIntent::RecordChatDelivery { .. } => {
                record(connection, library, intent, &now)
            }
            ProjectWorkspaceIntent::BindChatInbound {
                session_id,
                run_id,
                delivery_id,
                body_hash,
                attachment_count,
                author,
            } => bind(
                connection,
                library,
                HandbackDelivery {
                    session: session_id,
                    run: run_id,
                    delivery: delivery_id,
                    body_hash,
                    attachment_count: *attachment_count,
                    author,
                &now,
            ),
            ProjectWorkspaceIntent::HandBackMessage {
                reason,
                page_id,
                document_id,
                message,
            } => hand_back(
                connection,
                library,
                context,
                epoch,
                operation,
                scope,
                provenance.ok_or_else(|| {
                    conflict("A managed chat's captured tool authority is required")
                })?,
                reason,
                page_id,
                document_id,
                message.as_ref(),
                &now,
            ),
            _ => unreachable!(),
        },
    )
}
