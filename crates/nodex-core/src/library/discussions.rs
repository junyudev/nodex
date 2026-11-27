mod anchors;
pub(crate) mod asks;
pub(crate) mod inbox;
mod runs;

pub(crate) use anchors::reconcile as reconcile_anchors;
pub(crate) use runs::record as record_run_changes;

use std::collections::{BTreeMap, BTreeSet};

use nodex_core_contracts::{Actor, AdapterKind, BoundModuleContext, ModuleName, discussions::*};
use nodex_markdown::{Block, BlockKind, Inline};
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Serialize, de::DeserializeOwned};

use super::mutation::{
    self, MutationEffects, ParentDocumentPlacement, ParentDocumentWriteContext,
    ResolvedParentDocument,
};
use crate::document::{DocumentBlockOperation, sha256};
use crate::domain::markdown::{materialize_markdown, parse_markdown};
use crate::infrastructure::durable_mutation::{self, OperationIdentity};
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

const MAX_BODY_BYTES: usize = 64 * 1024;
const MAX_EDIT_BYTES: usize = 1024 * 1024;

const DISCUSSION_FIELDS: &str =
    "d.id, d.page_id, d.anchor_json, d.anchor_state, d.quote, d.created_by_json,
     d.created_at, d.resolved_by_json, d.resolved_at, d.last_activity_at";
const COMMENT_FIELDS: &str =
    "id, discussion_id, author_json, created_at, edited_at, deleted_at, body, mentions_json,
     ask_json, verdict_json, suggested_edit_json, question_for";

fn invalid(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message.into(), false)
}
fn denied(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::Unauthorized, message, false)
}
fn conflict(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::RevisionConflict, message, true)
}
fn missing() -> StoreError {
    StoreError::new(
        StoreErrorCode::NotFound,
        "Discussion or Comment is unavailable",
        false,
    )
}
fn encode(value: &impl Serialize) -> Result<String, StoreError> {
    serde_json::to_string(value)
        .map_err(|error| StoreError::new(StoreErrorCode::Internal, error.to_string(), false))
}
fn decode<T: DeserializeOwned>(row: &Row<'_>, index: usize) -> rusqlite::Result<T> {
    let value: String = row.get(index)?;
    serde_json::from_str(&value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            index,
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })
}
fn decode_optional<T: DeserializeOwned>(
    row: &Row<'_>,
    index: usize,
) -> rusqlite::Result<Option<T>> {
    if row.get::<_, Option<String>>(index)?.is_none() {
        return Ok(None);
    }
    decode(row, index).map(Some)
}

fn discussion(row: &Row<'_>) -> rusqlite::Result<Discussion> {
    let resolved_at: Option<String> = row.get(8)?;
    Ok(Discussion {
        id: row.get(0)?,
        page_id: row.get(1)?,
        anchor: decode(row, 2)?,
        anchor_state: if row.get::<_, String>(3)? == "live" {
            DiscussionAnchorState::Live
        } else {
            DiscussionAnchorState::Orphaned
        },
        quote: row.get(4)?,
        created_by: decode(row, 5)?,
        created_at: row.get(6)?,
        resolved_by: decode_optional(row, 7)?,
        status: if resolved_at.is_some() {
            DiscussionStatus::Resolved
        } else {
            DiscussionStatus::Open
        },
        resolved_at,
        last_activity_at: row.get(9)?,
    })
}
fn comment(row: &Row<'_>) -> rusqlite::Result<DiscussionComment> {
    let ask = decode_optional(row, 8)?;
    Ok(DiscussionComment {
        id: row.get(0)?,
        discussion_id: row.get(1)?,
        author: decode(row, 2)?,
        created_at: row.get(3)?,
        edited_at: row.get(4)?,
        deleted_at: row.get(5)?,
        body: row.get(6)?,
        mentions: decode(row, 7)?,
        to_nodex: ask.is_some(),
        ask,
        verdict: decode_optional(row, 9)?,
        suggested_edit: decode_optional(row, 10)?,
        question_for: row.get(11)?,
    })
}

fn read_discussion(
    connection: &Connection,
    context: &BoundModuleContext,
    id: &str,
) -> Result<Discussion, StoreError> {
    let value = connection.query_row(
        &format!("SELECT {DISCUSSION_FIELDS} FROM page_discussions d JOIN pages p ON p.block_id=d.page_id WHERE p.library_id=?1 AND d.id=?2"),
        params![context.library_id.0, id], discussion,
    ).optional()?.ok_or_else(missing)?;
    super::require_page_read_access(connection, &context.library_id.0, &value.page_id)?;
    Ok(value)
}

fn read_comment(
    connection: &Connection,
    context: &BoundModuleContext,
    id: &str,
) -> Result<(Discussion, DiscussionComment), StoreError> {
    let comment = connection
        .query_row(
            &format!("SELECT {COMMENT_FIELDS} FROM page_discussion_comments WHERE id=?1"),
            [id],
            comment,
        )
        .optional()?
        .ok_or_else(missing)?;
    let discussion = read_discussion(connection, context, &comment.discussion_id)?;
    Ok((discussion, comment))
}

fn with_comments(
    connection: &Connection,
    discussion: Discussion,
) -> Result<DiscussionDetail, StoreError> {
    let comments = connection.prepare(
        &format!("SELECT {COMMENT_FIELDS} FROM page_discussion_comments WHERE discussion_id=?1 ORDER BY created_at, id"),
    )?.query_map([&discussion.id], comment)?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(DiscussionDetail {
        discussion,
        comments,
    })
}

pub(super) fn detail(
    connection: &Connection,
    context: &BoundModuleContext,
    id: &str,
) -> Result<DiscussionDetail, StoreError> {
    with_comments(connection, read_discussion(connection, context, id)?)
}

pub(super) fn read_context(
    connection: &Connection,
    context: &BoundModuleContext,
    provenance: Option<&nodex_core_contracts::agent::AgentTurnProvenance>,
) -> Result<BoundModuleContext, StoreError> {
    if let Some(provenance) = provenance {
        if !matches!(
            context.adapter,
            AdapterKind::ElectronHost | AdapterKind::Test
        ) || context.agent_attribution.is_some()
        {
            return Err(denied(
                "Only the Host can supply a Discussion execution binding",
            ));
        }
        super::agent_execution::validate_transport_context(context, provenance)?;
        crate::workspace::validate_persisted_turn_authority(
            connection,
            &context.library_id.0,
            provenance,
        )?;
        return crate::infrastructure::actors::verified_turn(connection, context, provenance);
    }
    crate::infrastructure::actors::bind(connection, context)
}

pub(super) fn list(
    connection: &Connection,
    context: &BoundModuleContext,
    page_id: Option<&str>,
    status: Option<DiscussionStatus>,
    waiting: Option<DiscussionWaiting>,
    cursor: Option<&DiscussionCursor>,
    limit: Option<u32>,
) -> Result<DiscussionWindow, StoreError> {
    let limit = limit.unwrap_or(30);
    if !(1..=100).contains(&limit) {
        return Err(invalid("Discussion limit must be between 1 and 100"));
    }
    let nodex_answers_questions = page_id
        .map(|page| {
            super::require_page_read_access(connection, &context.library_id.0, page)?;
            setting(connection, page)
        })
        .transpose()?;
    let member = if waiting == Some(DiscussionWaiting::Me) {
        Some(crate::infrastructure::actors::requesting_member(
            connection, context,
        )?)
    } else {
        None
    };
    let nodex = waiting == Some(DiscussionWaiting::Nodex);
    let resolved = status.map(|status| status == DiscussionStatus::Resolved);
    let mut items = connection.prepare(&format!(
        "SELECT {DISCUSSION_FIELDS} FROM page_discussions d
          JOIN pages p ON p.block_id=d.page_id
          JOIN blocks b ON b.id=p.block_id AND b.library_id=p.library_id
         WHERE p.library_id=?1 AND b.lifecycle='active' AND (?2 IS NULL OR d.page_id=?2)
           AND (?3 IS NULL OR (d.resolved_at IS NOT NULL)=?3)
           AND (?4 IS NULL OR (d.last_activity_at,d.id)<(?4,?5))
           AND (NOT ?6 OR (d.resolved_at IS NULL AND EXISTS (
             SELECT 1 FROM page_discussion_comments c WHERE c.discussion_id=d.id AND c.deleted_at IS NULL
              AND json_extract(c.ask_json,'$.state') IN ('queued','working'))))
           AND (?7 IS NULL OR (d.resolved_at IS NULL AND EXISTS (
             SELECT 1 FROM page_discussion_comments c WHERE c.discussion_id=d.id AND c.deleted_at IS NULL
              AND (c.question_for=?7 OR (json_extract(c.ask_json,'$.state')='needs_you'
                AND coalesce(json_extract(c.ask_json,'$.requesterId'),json_extract(c.author_json,'$.member_id'),json_extract(c.author_json,'$.on_behalf_of'))=?7))
              AND NOT EXISTS (SELECT 1 FROM page_discussion_comments r WHERE r.discussion_id=d.id AND r.deleted_at IS NULL
                AND (r.created_at,r.id)>(c.created_at,c.id) AND json_extract(r.author_json,'$.member_id')=?7))))
         ORDER BY d.last_activity_at DESC,d.id DESC LIMIT ?8"),
    )?.query_map(params![
        context.library_id.0, page_id, resolved, cursor.map(|c| &c.last_activity_at),
        cursor.map(|c| &c.id), nodex, member, limit+1
    ], discussion)?.collect::<rusqlite::Result<Vec<_>>>()?;
    let next = if items.len() > limit as usize {
        items.pop();
        items.last().map(|item| DiscussionCursor {
            last_activity_at: item.last_activity_at.clone(),
            id: item.id.clone(),
        })
    } else {
        None
    };
    let items = items
        .into_iter()
        .map(|item| with_comments(connection, item))
        .collect::<Result<_, _>>()?;
    Ok(DiscussionWindow {
        items,
        next,
        nodex_answers_questions,
    })
}

pub(super) fn queued(
    connection: &Connection,
    context: &BoundModuleContext,
    cursor: Option<&QueuedAskCursor>,
    limit: Option<u32>,
) -> Result<QueuedAskWindow, StoreError> {
    if !matches!(
        context.adapter,
        AdapterKind::ElectronHost | AdapterKind::Test
    ) || context.agent_attribution.is_some()
    {
        return Err(denied("Only the Ask dispatcher can read the Space queue"));
    }
    let limit = limit.unwrap_or(30);
    if !(1..=100).contains(&limit) {
        return Err(invalid("Ask queue limit must be between 1 and 100"));
    }
    let mut statement = connection.prepare(
        "SELECT c.id,p.block_id,c.queued_at FROM page_discussion_comments c
          JOIN page_discussions d ON d.id=c.discussion_id JOIN pages p ON p.block_id=d.page_id
          JOIN blocks b ON b.id=p.block_id
         WHERE c.queued_at IS NOT NULL AND c.deleted_at IS NULL
           AND (d.resolved_at IS NULL OR json_extract(c.ask_json,'$.state') <> 'queued')
           AND p.library_id=?1 AND b.lifecycle='active'
           AND (?2 IS NULL OR (c.queued_at,c.id)>(?2,?3))
         ORDER BY c.queued_at,c.id LIMIT ?4",
    )?;
    let mut coordinates = statement
        .query_map(
            params![
                context.library_id.0,
                cursor.map(|c| &c.queued_at),
                cursor.map(|c| &c.id),
                limit + 1,
            ],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let next = if coordinates.len() > limit as usize {
        coordinates.pop();
        coordinates
            .last()
            .map(|(id, _, queued_at)| QueuedAskCursor {
                id: id.clone(),
                queued_at: queued_at.clone(),
            })
    } else {
        None
    };
    let items = coordinates
        .into_iter()
        .map(|(id, page_id, queued_at)| {
            let (_, comment) = read_comment(connection, context, &id)?;
            Ok(QueuedAsk {
                page_id,
                queued_at,
                comment,
            })
        })
        .collect::<Result<Vec<_>, StoreError>>()?;
    Ok(QueuedAskWindow { items, next })
}

fn setting(connection: &Connection, page: &str) -> Result<bool, StoreError> {
    Ok(connection.query_row(
        "SELECT nodex_answers_questions FROM pages WHERE block_id=?1",
        [page],
        |r| r.get(0),
    )?)
}

fn page_document(
    connection: &Connection,
    page: &str,
) -> Result<ResolvedParentDocument, StoreError> {
    let document_id: String = connection.query_row(
        "SELECT document_id FROM pages WHERE block_id=?1",
        [page],
        |r| r.get(0),
    )?;
    mutation::load_parent_document(connection, &document_id)
}

pub(super) fn apply(
    connection: &Connection,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    command: &DiscussionCommand,
) -> Result<super::LibraryApplyOutcome, StoreError> {
    let route =
        mutation::resolve_library_mutation_authority(connection, context, &context.library_id.0)?;
    let now = mutation::sqlite_now(connection)?;
    let result = durable_mutation::run_discussion(
        connection,
        OperationIdentity {
            module: ModuleName::Library,
            module_name: "library",
            operation_id,
            intent_hash: request_hash,
            store_epoch,
            committed_at: &now,
            context,
        },
        command,
        |scope| {
            let mut operation = Operation {
                connection,
                context,
                now: &now,
                documents: Vec::new(),
                ask_queued: false,
                write: ParentDocumentWriteContext {
                    actor_project_id: route.actor_project_id.as_deref(),
                    store_epoch,
                    operation_id,
                    commit: scope.evidence(),
                },
            };
            let (page, value, changed) = operation.execute(command)?;
            let effects = MutationEffects {
                project_id: route.actor_project_id.clone(),
                operation_kind: "discussion",
                change_kind: "library.changed",
                did_mutate: changed,
                affected_page_ids: vec![page],
                affected_document_ids: operation
                    .documents
                    .iter()
                    .map(|(id, _)| id.clone())
                    .collect(),
                committed_revisions: operation
                    .documents
                    .into_iter()
                    .map(|(id, head)| (format!("documentHead:{id}"), head))
                    .collect(),
                page_file_entries: Vec::new(),
                file_revisions: BTreeMap::new(),
                file_mutation: None,
                created_target: None,
                affected_parent_keys: Vec::new(),
                affected_block_ids: Vec::new(),
                affected_database_ids: Vec::new(),
                affected_view_ids: Vec::new(),
                page_create: None,
                page_copy: None,
                canvas_mutation: None,
                block_transfer: None,
                block_transfer_undo: None,
                page_relocation_undo: None,
                structural_edit: None,
                page_lifecycle: None,
                block_property_mutation: None,
                agent_page_copy: None,
                agent_create_pages: None,
                agent_move_pages: None,
                discussion: Some(value),
                change_payload: operation.ask_queued.then(|| serde_json::json!({"discussionAskQueued": true, "operationKind": "discussion", "didMutate": true})),
                committed_at: now.clone(),
            };
            mutation::seal_mutation(scope, context, operation_id, effects)
        },
    )?;
    mutation::library_commit_result(connection, result)
}

struct Operation<'a> {
    connection: &'a Connection,
    context: &'a BoundModuleContext,
    now: &'a str,
    write: ParentDocumentWriteContext<'a>,
    documents: Vec<(String, i64)>,
    ask_queued: bool,
}

impl Operation<'_> {
    fn execute(
        &mut self,
        command: &DiscussionCommand,
    ) -> Result<(String, DiscussionCommandResult, bool), StoreError> {
        use DiscussionCommand::*;
        match command {
            Create {
                page_id,
                discussion_id,
                first_comment_id,
                quote,
                anchor,
                text_range,
                first_comment,
            } => self.create(
                page_id,
                discussion_id.as_deref(),
                first_comment_id.as_deref(),
                quote.as_deref(),
                anchor,
                text_range.as_ref(),
                first_comment,
            ),
            Reply {
                discussion_id,
                comment,
            } => {
                let value = self.active_discussion(discussion_id)?;
                let comment = self.add_comment(
                    &value.page_id,
                    discussion_id,
                    &id_for(self.write.operation_id, "comment"),
                    comment,
                )?;
                Ok((
                    value.page_id,
                    DiscussionCommandResult::Comment {
                        value: Box::new(comment),
                    },
                    true,
                ))
            }
            Edit { comment_id, body } => self.edit_comment(comment_id, Some(body)),
            Delete { comment_id } => self.edit_comment(comment_id, None),
            Resolve { discussion_id } | Reopen { discussion_id } => {
                let value = self.active_discussion(discussion_id)?;
                let resolve = matches!(command, Resolve { .. });
                let changed = resolve != value.resolved_at.is_some();
                if changed {
                    let by = resolve.then(|| encode(&self.context.actor)).transpose()?;
                    self.connection.execute(
                        "UPDATE page_discussions SET resolved_by_json=?2,resolved_at=?3,last_activity_at=?4 WHERE id=?1",
                        params![discussion_id, by, resolve.then_some(self.now), self.now],
                    )?;
                    if !resolve {
                        self.ask_queued = self.connection.query_row(
                            "SELECT EXISTS(SELECT 1 FROM page_discussion_comments WHERE discussion_id=?1 AND queued_at IS NOT NULL)",
                            [discussion_id], |row| row.get(0),
                        )?;
                    }
                }
                let value = read_discussion(self.connection, self.context, discussion_id)?;
                Ok((
                    value.page_id.clone(),
                    DiscussionCommandResult::Discussion {
                        value: Box::new(value),
                    },
                    changed,
                ))
            }
            Accept { comment_id } | Reject { comment_id } => {
                self.decide(comment_id, matches!(command, Accept { .. }))
            }
            UpdateAsk {
                comment_id,
                expected_state,
                state,
                session_id,
                run_id,
                agent,
            } => {
                use DiscussionAskState::*;
                let (discussion, mut value) = self.active_comment(comment_id)?;
                let launch = matches!(
                    self.context.adapter,
                    AdapterKind::ElectronHost | AdapterKind::Test
                ) && matches!(self.context.actor, Actor::Member { .. });
                let retry = *state == Queued;
                if (!launch && !retry)
                    || (retry
                        && !same_author(&value.author, &self.context.actor)
                        && !value.ask.as_ref().is_some_and(|ask| {
                            ask.requester_id.as_deref() == self.context.actor.member_id()
                        }))
                {
                    return Err(denied(
                        "Only the dispatcher advances an Ask, and only its author can retry it",
                    ));
                }
                let ask = value
                    .ask
                    .as_mut()
                    .ok_or_else(|| invalid("Comment is not an Ask"))?;
                if &ask.state != expected_state
                    || value.deleted_at.is_some()
                    || (discussion.status == DiscussionStatus::Resolved
                        && (ask.state == Queued || retry))
                {
                    return Err(conflict("The Ask changed"));
                }
                if !matches!(
                    (ask.state, *state),
                    (Queued, Working)
                        | (Working, Answered | NeedsYou | Failed | Stopped)
                        | (Failed | Stopped, Queued)
                ) {
                    return Err(conflict("The Ask cannot take that transition"));
                }
                validate_ask_target(session_id.as_deref(), agent.as_ref())?;
                if retry && (session_id.is_some() || run_id.is_some() || agent.is_some()) {
                    return Err(invalid(
                        "Retry retains the requested conversation and Agent",
                    ));
                }
                ask.state = *state;
                if retry {
                    ask.session_id = None;
                    ask.run_id = None;
                    ask.dispatch = None;
                    self.ask_queued = true;
                } else {
                    ask.session_id = session_id.clone().or(ask.session_id.take());
                    ask.run_id = run_id.clone().or(ask.run_id.take());
                    ask.agent = ask.agent.take().or_else(|| agent.clone());
                    if ask.run_id.is_some() && ask.session_id.is_none() {
                        return Err(invalid("A Run requires its Session"));
                    }
                }
                self.connection.execute(
                    "UPDATE page_discussion_comments SET ask_json=?2,queued_at=?3 WHERE id=?1",
                    params![comment_id, encode(ask)?, retry.then_some(self.now)],
                )?;
                self.touch(&discussion.id)?;
                Ok((
                    discussion.page_id,
                    DiscussionCommandResult::Comment {
                        value: Box::new(value),
                    },
                    true,
                ))
            }
            ReserveAsk {
                comment_id,
                message_id,
                new_session_id,
                agent,
            } => self.reserve_ask(comment_id, message_id, new_session_id, agent.as_ref()),
            ObserveAsk {
                comment_id,
                message_id,
                run_id,
                waiting,
            } => self.observe_ask(comment_id, message_id, run_id, *waiting),
            SettleAsk {
                comment_id,
                message_id,
                run_id,
                state,
                fallback,
            } => self.settle_ask(comment_id, message_id, run_id.as_deref(), *state, fallback),
            StopAsk { comment_id } => self.stop_ask(comment_id),
            SetPageSetting {
                page_id,
                nodex_answers_questions,
            } => {
                self.require_active_page(page_id)?;
                let changed = self.connection.execute(
                    "UPDATE pages SET nodex_answers_questions=?2 WHERE block_id=?1 AND nodex_answers_questions<>?2",
                    params![page_id, nodex_answers_questions],
                )? != 0;
                Ok((
                    page_id.clone(),
                    DiscussionCommandResult::PageSetting {
                        page_id: page_id.clone(),
                        nodex_answers_questions: *nodex_answers_questions,
                    },
                    changed,
                ))
            }
            RevertRun { page_id, run_id } => {
                self.require_active_page(page_id)?;
                runs::revert(self, page_id, run_id)
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn create(
        &mut self,
        page: &str,
        discussion_id: Option<&str>,
        first_comment_id: Option<&str>,
        selected_quote: Option<&str>,
        anchor: &DiscussionAnchor,
        range: Option<&DiscussionTextRange>,
        draft: &DiscussionCommentDraft,
    ) -> Result<(String, DiscussionCommandResult, bool), StoreError> {
        self.require_active_page(page)?;
        for (label, id) in [("Discussion", discussion_id), ("Comment", first_comment_id)] {
            if let Some(id) = id {
                mutation::validate_uuid_v7(label, id)?;
            }
        }
        let id = discussion_id.map(str::to_owned).unwrap_or_else(|| {
            id_for(
                first_comment_id.unwrap_or(self.write.operation_id),
                "discussion",
            )
        });
        let comment_id = first_comment_id
            .map(str::to_owned)
            .unwrap_or_else(|| id_for(&id, "first-comment"));
        let creation_hash = sha256(
            encode(&(
                page,
                &comment_id,
                selected_quote,
                anchor,
                range,
                draft,
                author_identity(&self.context.actor),
            ))?
            .as_bytes(),
        );
        let existing: Option<String> = self
            .connection
            .query_row(
                "SELECT creation_hash FROM page_discussions WHERE id=?1",
                [&id],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(original) = existing {
            if original != creation_hash {
                return Err(conflict("Discussion identity is already in use"));
            }
            let value = read_discussion(self.connection, self.context, &id)?;
            return Ok((
                value.page_id.clone(),
                DiscussionCommandResult::Discussion {
                    value: Box::new(value),
                },
                false,
            ));
        }
        let comment_in_use: bool = self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM page_discussion_comments WHERE id=?1)",
            [&comment_id],
            |row| row.get(0),
        )?;
        if comment_in_use {
            return Err(conflict("Comment identity is already in use"));
        }
        let document = page_document(self.connection, page)?;
        let anchors::PreparedAnchor {
            anchor,
            quote,
            operation,
            indexed,
        } = anchors::prepare(
            &document.base_materialization,
            &id,
            anchor,
            range,
            selected_quote,
        )?;
        let live = !matches!(anchor, DiscussionAnchor::Text { .. }) || !indexed.is_empty();
        self.connection.execute(
            "INSERT INTO page_discussions(id,page_id,anchor_json,anchor_state,quote,created_by_json,created_at,last_activity_at,creation_hash)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?7,?8)",
            params![id, page, encode(&anchor)?, if live { "live" } else { "orphaned" }, quote, encode(&self.context.actor)?, self.now, creation_hash],
        )?;
        anchors::set_index(self.connection, &id, &indexed)?;
        if let Some(operation) = operation {
            self.write_document(&document, &[operation])?;
        }
        let first = self.add_comment(page, &id, &comment_id, draft)?;
        self.auto_answer(page, &first)?;
        let value = read_discussion(self.connection, self.context, &id)?;
        Ok((
            page.to_owned(),
            DiscussionCommandResult::Discussion {
                value: Box::new(value),
            },
            true,
        ))
    }

    fn add_comment(
        &mut self,
        page: &str,
        discussion: &str,
        id: &str,
        draft: &DiscussionCommentDraft,
    ) -> Result<DiscussionComment, StoreError> {
        let mentions = validate_body(self.connection, &self.context.library_id.0, &draft.body)?;
        if let Some(member) = &draft.question_for {
            require_member(self.connection, &self.context.library_id.0, member)?;
        }
        if let Some(verdict) = &draft.verdict {
            validate_verdict(verdict)?;
        }
        let edit = draft
            .suggested_edit
            .as_ref()
            .map(|draft| suggested_edit(self.connection, page, draft))
            .transpose()?;
        if !draft.to_nodex
            && (draft.ask_kind.is_some()
                || draft.ask_agent.is_some()
                || draft.requested_session_id.is_some())
        {
            return Err(invalid("Ask settings require toNodex"));
        }
        validate_ask_target(
            draft.requested_session_id.as_deref(),
            draft.ask_agent.as_ref(),
        )?;
        let ask = draft.to_nodex.then(|| DiscussionAsk {
            kind: draft.ask_kind.unwrap_or(DiscussionAskKind::Ask),
            state: DiscussionAskState::Queued,
            requested_session_id: draft.requested_session_id.clone(),
            session_id: None,
            run_id: None,
            agent: draft.ask_agent.clone(),
            requester_id: self.context.actor.member_id().map(str::to_owned),
            dispatch: None,
            discussion_session_id: None,
        });
        self.ask_queued = ask.is_some();
        self.connection.execute(
            "INSERT INTO page_discussion_comments(id,discussion_id,author_json,created_at,body,mentions_json,ask_json,verdict_json,suggested_edit_json,question_for,queued_at)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
            params![
                id, discussion, encode(&self.context.actor)?, self.now, draft.body, encode(&mentions)?,
                ask.as_ref().map(encode).transpose()?, draft.verdict.as_ref().map(encode).transpose()?,
                edit.as_ref().map(encode).transpose()?, draft.question_for, ask.is_some().then_some(self.now),
            ],
        )?;
        self.touch(discussion)?;
        read_comment(self.connection, self.context, id).map(|(_, comment)| comment)
    }

    fn edit_comment(
        &self,
        id: &str,
        body: Option<&str>,
    ) -> Result<(String, DiscussionCommandResult, bool), StoreError> {
        let (discussion, value) = self.active_comment(id)?;
        if !same_author(&value.author, &self.context.actor) {
            return Err(denied("Only the author can edit or delete a Comment"));
        }
        if value.deleted_at.is_some() {
            if body.is_some() {
                return Err(conflict("Comment was deleted"));
            }
            return Ok((
                discussion.page_id,
                DiscussionCommandResult::Comment {
                    value: Box::new(value),
                },
                false,
            ));
        }
        if let Some(body) = body {
            let mentions = validate_body(self.connection, &self.context.library_id.0, body)?;
            self.connection.execute(
                "UPDATE page_discussion_comments SET body=?2,mentions_json=?3,edited_at=?4 WHERE id=?1",
                params![id, body, encode(&mentions)?, self.now],
            )?;
        } else {
            self.connection.execute(
                "UPDATE page_discussion_comments SET deleted_at=?2,queued_at=NULL WHERE id=?1",
                params![id, self.now],
            )?;
        }
        self.touch(&discussion.id)?;
        let (_, value) = read_comment(self.connection, self.context, id)?;
        Ok((
            discussion.page_id,
            DiscussionCommandResult::Comment {
                value: Box::new(value),
            },
            true,
        ))
    }

    fn decide(
        &mut self,
        id: &str,
        accept: bool,
    ) -> Result<(String, DiscussionCommandResult, bool), StoreError> {
        let (discussion, mut value) = self.active_comment(id)?;
        if !accept
            && !same_author(&value.author, &self.context.actor)
            && crate::infrastructure::member_admission::is_commenter(self.connection, self.context)?
        {
            return Err(denied(
                "Rejecting this Suggested edit requires Page edit authority",
            ));
        }
        let edit = value
            .suggested_edit
            .as_mut()
            .ok_or_else(|| invalid("Comment has no Suggested edit"))?;
        if value.deleted_at.is_some() || edit.state != SuggestedEditState::Open {
            return Err(conflict("Suggested edit is no longer open"));
        }
        edit.state = if accept {
            self.accept_edit(&discussion.page_id, edit)?
        } else {
            SuggestedEditState::Rejected
        };
        edit.decided_by = Some(self.context.actor.clone());
        edit.decided_at = Some(self.now.to_owned());
        self.connection.execute(
            "UPDATE page_discussion_comments SET suggested_edit_json=?2 WHERE id=?1",
            params![id, encode(edit)?],
        )?;
        self.touch(&discussion.id)?;
        Ok((
            discussion.page_id,
            DiscussionCommandResult::Comment {
                value: Box::new(value),
            },
            true,
        ))
    }

    fn accept_edit(
        &mut self,
        page: &str,
        edit: &SuggestedEdit,
    ) -> Result<SuggestedEditState, StoreError> {
        let document = page_document(self.connection, page)?;
        let Some(range) =
            anchors::range(&document.base_materialization.block_tree, &edit.block_ids)
        else {
            return Ok(SuggestedEditState::Stale);
        };
        let markdown = materialize_markdown(range.blocks)
            .map_err(|e| invalid(e.to_string()))?
            .markdown;
        if markdown != edit.old_markdown || sha256(markdown.as_bytes()) != edit.base_hash {
            return Ok(SuggestedEditState::Stale);
        }
        let mut ordinal = 0;
        let mut operations = if edit.new_markdown.trim().is_empty()
            && (range.parent.is_some()
                || range.blocks.len() != document.base_materialization.block_tree.len())
        {
            range
                .blocks
                .iter()
                .map(|block| DocumentBlockOperation::DeleteBlock {
                    block_id: block.id.clone(),
                })
                .collect()
        } else {
            crate::document::markdown_patch::replace_range(
                &document.base_materialization,
                range.blocks,
                &edit.new_markdown,
                &mut || {
                    ordinal += 1;
                    id_for(self.write.operation_id, &format!("block:{ordinal}"))
                },
            )
            .map_err(|e| invalid(e.to_string()))?
        };
        for operation in &mut operations {
            match operation {
                DocumentBlockOperation::InsertBlock {
                    parent_block_id,
                    before_block_id,
                    ..
                }
                | DocumentBlockOperation::MoveBlock {
                    parent_block_id,
                    before_block_id,
                    ..
                } if parent_block_id.is_none() => {
                    *parent_block_id = range.parent.map(str::to_owned);
                    if before_block_id.is_none() {
                        *before_block_id = range.following.map(str::to_owned);
                    }
                }
                _ => {}
            }
        }
        self.write_document(&document, &operations)?;
        Ok(SuggestedEditState::Accepted)
    }

    fn require_active_page(&self, page: &str) -> Result<(), StoreError> {
        super::require_page_write_access(self.connection, &self.context.library_id.0, page)
    }

    fn active_discussion(&self, id: &str) -> Result<Discussion, StoreError> {
        let discussion = read_discussion(self.connection, self.context, id)?;
        self.require_active_page(&discussion.page_id)?;
        Ok(discussion)
    }

    fn active_comment(&self, id: &str) -> Result<(Discussion, DiscussionComment), StoreError> {
        let (discussion, comment) = read_comment(self.connection, self.context, id)?;
        self.require_active_page(&discussion.page_id)?;
        Ok((discussion, comment))
    }

    fn touch(&self, discussion: &str) -> Result<(), StoreError> {
        self.connection.execute(
            "UPDATE page_discussions SET last_activity_at=?2 WHERE id=?1",
            params![discussion, self.now],
        )?;
        Ok(())
    }

    fn write_document(
        &mut self,
        document: &ResolvedParentDocument,
        operations: &[DocumentBlockOperation],
    ) -> Result<(), StoreError> {
        if operations.is_empty() {
            return Ok(());
        }
        let commit = mutation::persist_parent_operations_detailed_with_local_commit(
            self.connection,
            self.write,
            "discussion",
            document,
            operations,
            ParentDocumentPlacement::Derived {
                attachment_advances: &[],
            },
        )?;
        self.documents.push((commit.document_id, commit.head_seq));
        Ok(())
    }
}

fn validate_body(
    connection: &Connection,
    library: &str,
    body: &str,
) -> Result<Vec<String>, StoreError> {
    if body.trim().is_empty() || body.len() > MAX_BODY_BYTES {
        return Err(invalid(
            "A Comment body must contain text and fit within 64 KiB",
        ));
    }
    let blocks = parse_markdown(body).map_err(|e| invalid(e.to_string()))?;
    let mut mentions = BTreeSet::new();
    collect_mentions(&blocks, &mut mentions)?;
    for member in &mentions {
        require_member(connection, library, member)?;
    }
    Ok(mentions.into_iter().collect())
}

fn collect_mentions(blocks: &[Block], mentions: &mut BTreeSet<String>) -> Result<(), StoreError> {
    for block in blocks {
        let text = match &block.kind {
            BlockKind::Paragraph { text, .. }
            | BlockKind::Bullet { text, .. }
            | BlockKind::Numbered { text, .. }
            | BlockKind::Check { text, .. } => text.as_slice(),
            BlockKind::Code { .. } => &[],
            _ => return Err(invalid("Comments support paragraphs, lists, and code")),
        };
        for inline in text {
            match inline {
                Inline::Link { href, .. } => {
                    let lowercase = href.to_ascii_lowercase();
                    if lowercase.starts_with("nodex://members/") {
                        let id = nodex_markdown::links::parse_member_link(href)
                            .ok_or_else(|| invalid("Member mention is invalid"))?;
                        mentions.insert(id);
                    }
                }
                Inline::Text { .. } | Inline::PageMention { .. } | Inline::ChatMention { .. } => {}
                _ => return Err(invalid("Comments support inline text, links, and mentions")),
            }
        }
        collect_mentions(&block.children, mentions)?;
    }
    Ok(())
}

fn require_member(connection: &Connection, library: &str, member: &str) -> Result<(), StoreError> {
    if !super::members::is_active(connection, library, member)? {
        return Err(invalid("The addressed Member is unavailable in this Space"));
    }
    Ok(())
}

fn validate_ask_target(
    session: Option<&str>,
    agent: Option<&DiscussionAskAgent>,
) -> Result<(), StoreError> {
    let valid = |id: &str| {
        !id.is_empty() && id.len() <= 512 && id.trim() == id && !id.chars().any(char::is_control)
    };
    if session.is_some_and(|id| !valid(id))
        || agent.is_some_and(|agent| {
            (!agent.provider_instance_id.is_empty() && !valid(&agent.provider_instance_id))
                || (!agent.model.is_empty() && !valid(&agent.model))
                || agent.options.as_object().is_none_or(|options| {
                    agent.provider_instance_id.is_empty()
                        && agent.model.is_empty()
                        && options.is_empty()
                })
        })
        || agent
            .map(encode)
            .transpose()?
            .is_some_and(|agent| agent.len() > 16 * 1024)
    {
        return Err(invalid("Ask conversation or Agent settings are invalid"));
    }
    Ok(())
}

fn validate_verdict(verdict: &DiscussionVerdict) -> Result<(), StoreError> {
    if verdict.evidence.len() > 50
        || verdict.evidence.iter().any(|entry| {
            entry.title.trim().is_empty()
                || entry.title.len() > 500
                || entry.excerpt.as_ref().is_some_and(|text| text.len() > 4000)
                || entry.url.as_ref().is_some_and(|url| {
                    url.len() > 4000
                        || url.chars().any(char::is_control)
                        || !["https://", "http://", "nodex://"]
                            .iter()
                            .any(|scheme| url.starts_with(scheme))
                })
        })
    {
        return Err(invalid("Verdict evidence needs titles and valid links"));
    }
    Ok(())
}

fn suggested_edit(
    connection: &Connection,
    page: &str,
    draft: &SuggestedEditDraft,
) -> Result<SuggestedEdit, StoreError> {
    if draft.new_markdown.len() > MAX_EDIT_BYTES {
        return Err(invalid("Suggested edit exceeds 1 MiB"));
    }
    let document = page_document(connection, page)?;
    let range = anchors::range(&document.base_materialization.block_tree, &draft.block_ids)
        .ok_or_else(|| invalid("Suggested edit needs contiguous sibling Blocks in order"))?;
    let old_markdown = materialize_markdown(range.blocks)
        .map_err(|e| invalid(e.to_string()))?
        .markdown;
    if old_markdown.len() > MAX_EDIT_BYTES {
        return Err(invalid("Suggested edit exceeds 1 MiB"));
    }
    if draft
        .expected_old_markdown
        .as_ref()
        .is_some_and(|expected| expected != &old_markdown)
    {
        return Err(conflict("Suggested edit's original Blocks changed"));
    }
    let replacement = parse_markdown(&draft.new_markdown).map_err(|e| invalid(e.to_string()))?;
    fn has_owner(blocks: &[Block]) -> bool {
        blocks.iter().any(|block| {
            matches!(
                block.kind,
                BlockKind::Page | BlockKind::Database | BlockKind::Canvas
            ) || has_owner(&block.children)
        })
    }
    let old = parse_markdown(&old_markdown).map_err(|e| invalid(e.to_string()))?;
    if has_owner(&replacement) || has_owner(&old) {
        return Err(invalid("Suggested edits replace editable body Blocks"));
    }
    Ok(SuggestedEdit {
        block_ids: draft.block_ids.clone(),
        base_hash: sha256(old_markdown.as_bytes()),
        old_markdown,
        new_markdown: draft.new_markdown.clone(),
        state: SuggestedEditState::Open,
        decided_by: None,
        decided_at: None,
    })
}

pub(super) fn author_identity(actor: &Actor) -> (Option<&str>, Option<&str>) {
    let session = match actor {
        Actor::Agent { session_id, .. } => Some(session_id.as_str()),
        _ => None,
    };
    (actor.member_id(), session)
}

fn same_author(a: &Actor, b: &Actor) -> bool {
    if a.member_id().is_none() || b.member_id().is_none() {
        return a == b;
    }
    author_identity(a) == author_identity(b)
}

fn id_for(operation: &str, domain: &str) -> String {
    crate::domain::identity::stable_uuid_v7("nodex.discussions.v1", domain, operation)
}
