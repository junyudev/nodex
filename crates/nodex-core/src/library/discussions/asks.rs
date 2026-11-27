//! Core owns the durable dispatch reservation, its requester, and final Discussion reply.

use super::*;
use crate::domain::block_materialization::MaterializedBlockNode;
use crate::infrastructure::{actors, member_admission};
use crate::workspace::chat_stewardship;

const MESSAGE_PREFIX: &str = "page-ask:";
const LAUNCH_PREFIX: &str = "page-ask-session:";

fn host_only(context: &BoundModuleContext) -> Result<(), StoreError> {
    if matches!(
        context.adapter,
        AdapterKind::ElectronHost | AdapterKind::Test
    ) && context.principal.is_none()
        && context.agent_attribution.is_none()
        && matches!(context.actor, Actor::Member { .. })
    {
        return Ok(());
    }
    Err(denied("Only the Space host can dispatch an Ask"))
}

fn requester<'a>(ask: &'a DiscussionAsk, author: &'a Actor) -> Option<&'a str> {
    ask.requester_id.as_deref().or(author.member_id())
}

fn page_project(c: &Connection, page: &str) -> Result<Option<String>, StoreError> {
    // A nested Page inherits the Project of its nearest owning Data Source.
    Ok(c.query_row(
        "WITH RECURSIVE ancestry(id,kind,parent) AS (
           SELECT block_id,parent_kind,parent_id FROM pages WHERE block_id=?1
           UNION ALL SELECT p.block_id,p.parent_kind,p.parent_id FROM ancestry a
             JOIN pages p ON a.kind='page' AND a.parent=p.block_id
         ) SELECT s.project_id FROM ancestry a JOIN activity_page_scopes s ON s.page_id=a.id
           WHERE a.kind='data_source' AND s.project_id IS NOT NULL LIMIT 1",
        [page],
        |row| row.get(0),
    )
    .optional()?)
}

fn page_owner(c: &Connection, library: &str, page: &str) -> Result<Option<String>, StoreError> {
    Ok(c.query_row(
        "SELECT m.id FROM block_properties work JOIN members m
         ON m.id=json_extract(work.value_json,'$.owner') AND m.library_id=work.library_id
         WHERE work.block_id=?1 AND work.library_id=?2 AND work.property_key='work'
           AND m.lifecycle='active'",
        params![page, library],
        |row| row.get(0),
    )
    .optional()?
    .or(if actors::is_personal(c, library)? {
        Some(actors::local_member(c, library)?)
    } else {
        None
    }))
}

fn nearby_markdown(
    blocks: &[MaterializedBlockNode],
    anchor: &DiscussionAnchor,
    discussion_id: &str,
) -> Result<(String, Option<String>), StoreError> {
    fn visit<'a>(
        blocks: &'a [MaterializedBlockNode],
        ordered: &mut Vec<&'a MaterializedBlockNode>,
    ) {
        for block in blocks {
            ordered.push(block);
            visit(&block.children, ordered);
        }
    }
    let mut ordered = Vec::new();
    visit(blocks, &mut ordered);
    let anchored: &[String] = match anchor {
        DiscussionAnchor::Blocks { block_ids } => block_ids,
        DiscussionAnchor::Text { block_id } | DiscussionAnchor::Datum { block_id, .. } => {
            std::slice::from_ref(block_id)
        }
        DiscussionAnchor::Page => &[],
    };
    let mut positions = ordered
        .iter()
        .enumerate()
        .filter(|(_, b)| anchored.contains(&b.id));
    let first = positions.next();
    let last = positions.next_back().or(first);
    let pending = first
        .filter(|(_, block)| {
            block.block_type == "pending"
                && block
                    .props
                    .get("discussion")
                    .and_then(serde_json::Value::as_str)
                    == Some(discussion_id)
        })
        .map(|(_, block)| block.id.clone());
    let selected = if let Some(((first, _), (last, _))) = first.zip(last) {
        ordered[first.saturating_sub(3)..first]
            .iter()
            .chain(ordered[first..=last].iter().take(3))
            .chain(&ordered[last + 1..(last + 4).min(ordered.len())])
            .copied()
            .collect::<Vec<_>>()
    } else {
        ordered.into_iter().take(7).collect()
    };
    let mut markdown = String::new();
    for block in selected {
        let mut own = block.clone();
        own.children.clear();
        let rendered = materialize_markdown(&[own]).map_err(|error| invalid(error.to_string()))?;
        markdown.extend(rendered.markdown.chars().take(450));
        markdown.push_str("\n\n");
    }
    Ok((markdown.trim().to_owned(), pending))
}

pub(crate) fn read(
    c: &Connection,
    context: &BoundModuleContext,
    comment_id: &str,
) -> Result<DiscussionAskContext, StoreError> {
    host_only(context)?;
    let (discussion, comment) = read_comment(c, context, comment_id)?;
    let ask = comment.ask.as_ref().ok_or_else(missing)?;
    let member = requester(ask, &comment.author).ok_or_else(missing)?;
    let library = &context.library_id.0;
    let page = &discussion.page_id;
    let document = page_document(c, page)?;
    let (markdown, pending_block_id) = nearby_markdown(
        &document.base_materialization.block_tree,
        &discussion.anchor,
        &discussion.id,
    )?;
    let title = c.query_row(
        "SELECT title FROM document_materializations WHERE document_id=(SELECT document_id FROM pages WHERE block_id=?1)",
        [page], |row| row.get(0),
    ).optional()?.unwrap_or_default();
    let commenter = c.query_row(
        "SELECT EXISTS(SELECT 1 FROM members WHERE id=?1 AND library_id=?2 AND role='commenter')",
        params![member, library],
        |row| row.get(0),
    )?;
    // A launch may reserve a chat before it exists. An existing chat must still be usable.
    let can_dispatch = if let (Some(dispatch), Some(session)) = (&ask.dispatch, &ask.session_id) {
        !dispatch.stop_requested
            && super::super::members::is_active(c, library, member)?
            && ((dispatch.launch_id.is_some()
                && c.query_row(
                    "SELECT NOT EXISTS(SELECT 1 FROM project_sessions WHERE id=?1)",
                    [session],
                    |row| row.get::<_, bool>(0),
                )?)
                || usable_session(c, library, member, session)?)
    } else {
        false
    };
    Ok(DiscussionAskContext {
        project_id: page_project(c, page)?,
        page_key: crate::database::page_key::current_page_key_for_page(c, library, page)?,
        detail: with_comments(c, discussion)?,
        title,
        markdown,
        pending_block_id,
        commenter,
        can_dispatch,
    })
}

fn usable_session(
    c: &Connection,
    library: &str,
    member: &str,
    session: &str,
) -> Result<bool, StoreError> {
    let usable = c.query_row(
        "SELECT EXISTS(SELECT 1 FROM project_sessions s
          JOIN project_session_execution_bindings b ON b.session_id=s.id
          WHERE s.id=?1 AND s.archived=0
            AND (s.project_id IS NULL OR EXISTS(SELECT 1 FROM projects p
               WHERE p.id=s.project_id AND p.library_id=?2 AND p.lifecycle='active'))
            AND NOT EXISTS(SELECT 1 FROM nodex_decision_runs WHERE session_id=s.id)
            AND NOT EXISTS(SELECT 1 FROM project_session_pages WHERE session_id=s.id)
            AND NOT EXISTS(SELECT 1 FROM session_workspaces WHERE session_id=s.id))",
        params![session, library],
        |row| row.get::<_, bool>(0),
    )?;
    Ok(usable && chat_stewardship::owns(c, library, member, session)?)
}

/// Explicit destinations take precedence. A fallback conversation belongs to one Member and
/// Discussion, follows the current Page, and lasts across Ask attempts.
fn find_ask_session(
    c: &Connection,
    library: &str,
    discussion: &Discussion,
    member: &str,
    project: Option<&str>,
    requested: Option<&str>,
) -> Result<Option<(String, bool)>, StoreError> {
    if !super::super::members::is_active(c, library, member)? {
        return Ok(None);
    }
    if let Some(session) = requested
        && usable_session(c, library, member, session)?
    {
        return Ok(Some((session.to_owned(), false)));
    }
    let mut stmt = c.prepare(
        "SELECT s.id FROM page_discussion_comments c
         JOIN project_sessions s ON s.id=json_extract(c.ask_json,'$.discussionSessionId') AND s.project_id IS ?3
         WHERE c.discussion_id=?1 AND json_extract(c.ask_json,'$.requesterId')=?2
         ORDER BY c.created_at DESC,c.id DESC",
    )?;
    let sessions = stmt.query_map(params![discussion.id, member, project], |row| {
        row.get::<_, String>(0)
    })?;
    for session in sessions {
        let session = session?;
        if usable_session(c, library, member, &session)? {
            return Ok(Some((session, true)));
        }
    }
    Ok(None)
}

/// Core uses the Ask's own reservation as the launch grant and names the requester as chat owner.
pub(crate) fn launch_requester(
    c: &Connection,
    context: &BoundModuleContext,
    session: &str,
    project: Option<&str>,
    launch_id: &str,
    initial_page_ids: &[String],
) -> Result<Option<String>, StoreError> {
    if !launch_id.starts_with(LAUNCH_PREFIX) {
        return Ok(None);
    }
    host_only(context)?;
    if !initial_page_ids.is_empty() {
        return Err(denied(
            "An Ask's conversation only takes the Page as context",
        ));
    }
    let library = &context.library_id.0;
    let reservation = c
        .query_row(
            "SELECT d.page_id, json_extract(c.ask_json,'$.requesterId') FROM page_discussion_comments c
             JOIN page_discussions d ON d.id=c.discussion_id JOIN pages p ON p.block_id=d.page_id
             WHERE p.library_id=?1 AND c.queued_at IS NOT NULL AND c.deleted_at IS NULL
               AND json_extract(c.ask_json,'$.sessionId')=?2
               AND json_extract(c.ask_json,'$.dispatch.launchId')=?3
               AND json_extract(c.ask_json,'$.dispatch.stopRequested')=0",
            params![library, session, launch_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
        )
        .optional()?;
    if let Some((page, Some(member))) = reservation
        && page_project(c, &page)?.as_deref() == project
        && super::super::members::is_active(c, library, &member)?
    {
        super::super::require_page_read_access(c, library, &page)?;
        return Ok(Some(member));
    }
    Err(denied("The Ask's conversation grant is no longer current"))
}

pub(crate) fn message_requester(
    c: &Connection,
    session: &str,
    message: &str,
) -> Result<Option<String>, StoreError> {
    if !message.starts_with(MESSAGE_PREFIX) {
        return Ok(None);
    }
    Ok(c.query_row(
        "SELECT json_extract(c.ask_json,'$.requesterId') FROM page_discussion_comments c
         WHERE c.queued_at IS NOT NULL AND c.deleted_at IS NULL
           AND json_extract(c.ask_json,'$.sessionId')=?1
           AND json_extract(c.ask_json,'$.dispatch.messageId')=?2
           AND json_extract(c.ask_json,'$.dispatch.stopRequested')=0",
        params![session, message],
        |row| row.get(0),
    )
    .optional()?
    .flatten())
}

impl Operation<'_> {
    pub(super) fn auto_answer(
        &mut self,
        page: &str,
        first: &DiscussionComment,
    ) -> Result<(), StoreError> {
        if first.ask.is_some()
            || first.question_for.is_some()
            || !first.mentions.is_empty()
            || !matches!(first.author, Actor::Member { .. })
            || !first.body.trim_end().ends_with(['?', '？'])
            || !setting(self.connection, page)?
        {
            return Ok(());
        }
        let Some(owner) = page_owner(self.connection, &self.context.library_id.0, page)? else {
            return Ok(());
        };
        let ask = DiscussionAsk {
            kind: DiscussionAskKind::Ask,
            state: DiscussionAskState::Queued,
            requested_session_id: None,
            session_id: None,
            run_id: None,
            agent: None,
            requester_id: Some(owner),
            dispatch: None,
            discussion_session_id: None,
        };
        self.save_ask(&first.id, &ask, Some(self.now))?;
        self.ask_queued = true;
        Ok(())
    }

    pub(super) fn reserve_ask(
        &mut self,
        id: &str,
        message: &str,
        new_session: &str,
        agent: Option<&DiscussionAskAgent>,
    ) -> Result<(String, DiscussionCommandResult, bool), StoreError> {
        host_only(self.context)?;
        let (discussion, mut comment) = self.active_comment(id)?;
        let ask = comment.ask.as_mut().ok_or_else(missing)?;
        if ask.state != DiscussionAskState::Queued
            || comment.deleted_at.is_some()
            || discussion.status == DiscussionStatus::Resolved
        {
            return Err(conflict("The Ask changed"));
        }
        if !message.starts_with(MESSAGE_PREFIX) || message.len() > 128 {
            return Err(invalid("The Ask's message identity is invalid"));
        }
        mutation::validate_uuid_v7("Session", new_session)?;
        validate_ask_target(None, agent)?;
        let member = requester(ask, &comment.author)
            .ok_or_else(missing)?
            .to_owned();
        let library = &self.context.library_id.0;
        let project = page_project(self.connection, &discussion.page_id)?;
        let target = find_ask_session(
            self.connection,
            library,
            &discussion,
            &member,
            project.as_deref(),
            ask.requested_session_id.as_deref(),
        )?;
        let launch_id = match &target {
            Some((session, true)) => {
                ask.discussion_session_id = Some(session.clone());
                None
            }
            Some((_, false)) => None,
            None => {
                ask.discussion_session_id = Some(new_session.to_owned());
                Some(format!("{LAUNCH_PREFIX}{new_session}"))
            }
        };
        ask.requester_id = Some(member);
        ask.session_id =
            Some(target.map_or_else(|| new_session.to_owned(), |(session, _)| session));
        ask.state = DiscussionAskState::Working;
        ask.dispatch = Some(DiscussionAskDispatch {
            message_id: message.to_owned(),
            launch_id,
            stop_requested: false,
            agent: agent.cloned(),
        });
        self.keep_ask_queued(id, ask)?;
        self.ask_result(discussion, comment)
    }

    pub(super) fn observe_ask(
        &mut self,
        id: &str,
        message: &str,
        run: &str,
        waiting: bool,
    ) -> Result<(String, DiscussionCommandResult, bool), StoreError> {
        host_only(self.context)?;
        let (discussion, mut comment) = self.active_comment(id)?;
        let ask = self.dispatched(&mut comment, message)?;
        let state = if waiting {
            DiscussionAskState::NeedsYou
        } else {
            DiscussionAskState::Working
        };
        if ask.run_id.as_deref() == Some(run) && ask.state == state {
            return Ok((
                discussion.page_id,
                DiscussionCommandResult::Comment {
                    value: Box::new(comment),
                },
                false,
            ));
        }
        ask.run_id = Some(run.to_owned());
        ask.state = state;
        self.keep_ask_queued(id, ask)?;
        self.ask_result(discussion, comment)
    }

    pub(super) fn settle_ask(
        &mut self,
        id: &str,
        message: &str,
        run: Option<&str>,
        state: DiscussionAskState,
        fallback: &str,
    ) -> Result<(String, DiscussionCommandResult, bool), StoreError> {
        use DiscussionAskState::*;
        host_only(self.context)?;
        if !matches!(state, Failed | Stopped) {
            return Err(invalid("An Ask with no reply must fail or stop"));
        }
        let (discussion, mut comment) = self.active_comment(id)?;
        let author = comment.author.clone();
        let ask = self.dispatched(&mut comment, message)?;
        let session = ask.session_id.as_deref().ok_or_else(missing)?;
        let member = requester(ask, &author).ok_or_else(missing)?;
        let has_session: bool = self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM project_sessions WHERE id=?1)",
            [session],
            |row| row.get(0),
        )?;
        let run = has_session.then_some(run).flatten();
        let stopped = ask
            .dispatch
            .as_ref()
            .is_some_and(|dispatch| dispatch.stop_requested);
        let mut final_state = state;
        let reply = if let Some(run) = run {
            let mut replies = self.connection.prepare(
                "SELECT question_for FROM page_discussion_comments WHERE discussion_id=?1 AND deleted_at IS NULL
                 AND json_extract(author_json,'$.type')='agent' AND json_extract(author_json,'$.session_id')=?2
                 AND json_extract(author_json,'$.run_id')=?3 AND json_extract(author_json,'$.on_behalf_of')=?4
                 ORDER BY created_at DESC,id DESC LIMIT 1",
            )?;
            replies
                .query_row(params![discussion.id, session, run, member], |row| {
                    row.get::<_, Option<String>>(0)
                })
                .optional()?
        } else {
            None
        };
        if stopped {
            final_state = Stopped;
        } else if let Some(question) = &reply {
            final_state = if question.is_some() {
                NeedsYou
            } else {
                Answered
            };
        }
        if reply.is_none() && !fallback.is_empty() {
            validate_body(self.connection, &self.context.library_id.0, fallback)?;
            let actor = if has_session {
                Actor::Agent {
                    session_id: session.to_owned(),
                    run_id: run.map(str::to_owned),
                    on_behalf_of: member.to_owned(),
                }
            } else {
                Actor::Service {
                    kind: nodex_core_contracts::ServiceKind::AgentRuntime,
                }
            };
            self.connection.execute(
                "INSERT OR IGNORE INTO page_discussion_comments(id,discussion_id,author_json,created_at,body,mentions_json)
                 VALUES(?1,?2,?3,?4,?5,'[]')",
                params![id_for(message, "ask-fallback"), discussion.id, encode(&actor)?, self.now, fallback],
            )?;
        }
        ask.run_id = if has_session {
            run.map(str::to_owned).or(ask.run_id.take())
        } else {
            None
        };
        if !has_session {
            ask.session_id = None;
        }
        ask.state = final_state;
        self.save_ask(id, ask, None)?;
        self.ask_result(discussion, comment)
    }

    pub(super) fn stop_ask(
        &mut self,
        id: &str,
    ) -> Result<(String, DiscussionCommandResult, bool), StoreError> {
        let (discussion, mut comment) = self.active_comment(id)?;
        if !matches!(self.context.actor, Actor::Member { .. }) {
            return Err(denied("Only a Member can stop an Ask"));
        }
        let ask = comment.ask.as_mut().ok_or_else(missing)?;
        let member = actors::requesting_member(self.connection, self.context)?;
        if requester(ask, &comment.author) != Some(&member)
            && member_admission::is_commenter(self.connection, self.context)?
        {
            return Err(denied(
                "Only the requester or a Page editor can stop this Ask",
            ));
        }
        let scheduled: bool = self.connection.query_row(
            "SELECT queued_at IS NOT NULL FROM page_discussion_comments WHERE id=?1 AND deleted_at IS NULL",
            [id], |row| row.get(0),
        ).optional()?.unwrap_or(false);
        if !scheduled {
            return Err(conflict("The Ask has already ended"));
        }
        if let Some(dispatch) = ask.dispatch.as_mut() {
            dispatch.stop_requested = true;
            self.keep_ask_queued(id, ask)?;
            self.ask_queued = true;
        } else {
            ask.state = DiscussionAskState::Stopped;
            self.save_ask(id, ask, None)?;
        }
        self.ask_result(discussion, comment)
    }

    fn dispatched<'a>(
        &self,
        comment: &'a mut DiscussionComment,
        message: &str,
    ) -> Result<&'a mut DiscussionAsk, StoreError> {
        let ask = comment.ask.as_mut().ok_or_else(missing)?;
        if comment.deleted_at.is_some()
            || !matches!(
                ask.state,
                DiscussionAskState::Working | DiscussionAskState::NeedsYou
            )
            || !ask
                .dispatch
                .as_ref()
                .is_some_and(|dispatch| dispatch.message_id == message)
        {
            return Err(conflict("The Ask attempt changed"));
        }
        let active: bool = self.connection.query_row(
            "SELECT queued_at IS NOT NULL FROM page_discussion_comments WHERE id=?1",
            [&comment.id],
            |row| row.get(0),
        )?;
        if !active {
            return Err(conflict("The Ask attempt has ended"));
        }
        Ok(ask)
    }

    fn ask_result(
        &self,
        discussion: Discussion,
        comment: DiscussionComment,
    ) -> Result<(String, DiscussionCommandResult, bool), StoreError> {
        self.touch(&discussion.id)?;
        Ok((
            discussion.page_id,
            DiscussionCommandResult::Comment {
                value: Box::new(comment),
            },
            true,
        ))
    }

    fn keep_ask_queued(&self, id: &str, ask: &DiscussionAsk) -> Result<(), StoreError> {
        self.connection.execute(
            "UPDATE page_discussion_comments SET ask_json=?2 WHERE id=?1",
            params![id, encode(ask)?],
        )?;
        Ok(())
    }

    fn save_ask(
        &self,
        id: &str,
        ask: &DiscussionAsk,
        queued_at: Option<&str>,
    ) -> Result<(), StoreError> {
        self.connection.execute(
            "UPDATE page_discussion_comments SET ask_json=?2,queued_at=?3 WHERE id=?1",
            params![id, encode(ask)?, queued_at],
        )?;
        Ok(())
    }
}

pub(crate) fn block_writers(
    c: &Connection,
    context: &BoundModuleContext,
    page: &str,
) -> Result<Vec<DiscussionBlockWriter>, StoreError> {
    super::super::require_page_read_access(c, &context.library_id.0, page)?;
    let mut stmt = c.prepare(
        "WITH writes AS (
          SELECT touched.value AS id, commit_row.actor_json, commit_row.committed_at,
                 ROW_NUMBER() OVER(PARTITION BY touched.value ORDER BY commit_row.commit_seq DESC) AS recent
          FROM pages p JOIN document_update_receipts update_row ON update_row.document_id=p.document_id
          JOIN json_each(update_row.derived_touched_block_ids_json) touched
          JOIN local_commit_documents link ON link.document_id=update_row.document_id
             AND link.generation=update_row.generation AND link.head_seq=update_row.seq
          JOIN local_commits commit_row ON commit_row.store_epoch=link.store_epoch AND commit_row.commit_seq=link.commit_seq
          WHERE p.block_id=?1 AND commit_row.finalized=1 AND commit_row.actor_json IS NOT NULL
        )
        SELECT w.id,w.actor_json,w.committed_at FROM writes w
        JOIN pages p ON p.block_id=?1 JOIN document_block_index b ON b.document_id=p.document_id AND b.block_id=w.id
        WHERE w.recent=1 ORDER BY w.id",
    )?;
    let rows = stmt.query_map([page], |row| {
        Ok(DiscussionBlockWriter {
            block_id: row.get(0)?,
            actor: decode(row, 1)?,
            written_at: row.get(2)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}
