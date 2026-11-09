//! The mixed Inbox window hydrates only its selected Page identities.
use crate::infrastructure::sqlite::StoreError;
use nodex_core_contracts::inbox::*;
use nodex_core_contracts::workspace::{PageTurn, SessionExecutionObservation};
use rusqlite::{Connection, OptionalExtension, params};

pub(super) fn require_turn(
    connection: &Connection,
    library: &str,
    page: &str,
    episode: Option<&str>,
) -> Result<PageTurn, StoreError> {
    let eligible=connection.query_row("SELECT EXISTS(SELECT 1 FROM inbox_rows WHERE row_kind='turn' AND page_id=?1 AND library_id=?2)",params![page,library],|r|r.get::<_,bool>(0))?;
    if !eligible {
        return Err(super::inbox::conflict(
            "This Page's Turn is no longer yours in the Inbox",
        ));
    }
    let turn = super::page_turn::read_turns(connection, library, &[page.to_owned()])?.remove(0);
    if episode.is_some_and(|expected| expected != turn.episode) {
        return Err(super::inbox::conflict(
            "This Turn changed; refresh the Inbox before acting",
        ));
    }
    Ok(turn)
}

pub(super) fn item(
    connection: &Connection,
    library: &str,
    page: &str,
    kind: &str,
) -> Result<ProjectWorkspaceInboxItem, StoreError> {
    let (title,markdown):(String,String)=connection.query_row("SELECT COALESCE(materialization.title,''),substr(COALESCE(materialization.markdown,''),1,8192) FROM pages page LEFT JOIN document_materializations materialization ON materialization.document_id=page.document_id WHERE page.block_id=?1 AND page.library_id=?2",params![page,library],|r|Ok((r.get(0)?,r.get(1)?)))?;
    let (project, at): (Option<String>, String) = connection.query_row(
        "SELECT project_id,sort_at FROM inbox_rows WHERE page_id=?1 AND row_kind=?2",
        params![page, kind],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let scope = project.map_or(ProjectWorkspaceInboxScope::Library, |project_id| {
        ProjectWorkspaceInboxScope::Project { project_id }
    });
    let mut body = markdown;
    let turn = if kind == "turn" {
        let turn = require_turn(connection, library, page, None)?;
        let session: Option<String> = connection
            .query_row(
                "SELECT session_id FROM page_active_chats WHERE page_id=?1",
                [page],
                |r| r.get(0),
            )
            .optional()?;
        let chat = session
            .as_deref()
            .map(|id| super::inbox_read::read_chat(connection, library, id))
            .transpose()?
            .flatten()
            .filter(|chat| !chat.archived);
        let observation:Option<String>=connection.query_row("SELECT observation.observed_json FROM page_active_chats active JOIN session_execution_observations observation ON observation.session_id=active.session_id WHERE active.page_id=?1",[page],|r|r.get(0)).optional()?;
        let observation: Option<SessionExecutionObservation> = observation
            .map(|json| {
                serde_json::from_str(&json)
                    .map_err(|_| super::inbox::corrupt("Invalid execution observation"))
            })
            .transpose()?;
        let requests = observation
            .as_ref()
            .map(|o| o.pending_requests.as_slice())
            .unwrap_or_default();
        let question = requests.iter().find(|r| {
            matches!(
                r.kind,
                nodex_core_contracts::workspace::SessionExecutionRequestKind::Question
            )
        });
        let options = if requests.len() == 1 {
            question.map(|r| r.options.clone()).unwrap_or_default()
        } else {
            vec![]
        };
        let note:Option<(String,String)>=connection.query_row("SELECT note_id,body FROM page_turn_notes WHERE page_id=?1 AND episode=?2 ORDER BY created_seq DESC,note_id DESC LIMIT 1",params![page,turn.episode],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
        let report_outcome = match turn.reason {
            Some(nodex_core_contracts::workspace::TurnReason::Review) => Some("ready"),
            Some(nodex_core_contracts::workspace::TurnReason::Blocked) => Some("blocked"),
            Some(nodex_core_contracts::workspace::TurnReason::Failed) => Some("failed"),
            _ => None,
        };
        let report:Option<String>=connection.query_row("SELECT report_summary FROM project_session_pages WHERE page_id=?1 AND session_id=?2 AND report_outcome=?3",params![page,session,report_outcome],|r|r.get(0)).optional()?.flatten();
        let prerequisites = if turn.reason
            == Some(nodex_core_contracts::workspace::TurnReason::ReadyToStart)
        {
            connection.prepare("SELECT COALESCE(materialization.title,edge.target_page_block_id) FROM data_source_page_memberships membership JOIN data_source_relation_edges edge ON edge.source_membership_id=membership.id AND edge.property_id='blocked_by' JOIN pages prerequisite ON prerequisite.block_id=edge.target_page_block_id LEFT JOIN document_materializations materialization ON materialization.document_id=prerequisite.document_id WHERE membership.page_block_id=?1 AND membership.data_source_id=(SELECT parent_id FROM pages WHERE block_id=?1) AND membership.removed_at IS NULL ORDER BY edge.target_page_block_id LIMIT 16")?.query_map([page],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?
        } else {
            vec![]
        };
        body = note
            .as_ref()
            .map(|(_, body)| body.clone())
            .or_else(|| question.and_then(|q| q.question.clone()))
            .or(report)
            .or_else(|| observation.as_ref().and_then(|o| o.failure_reason.clone()))
            .unwrap_or_else(|| match turn.reason {
                Some(nodex_core_contracts::workspace::TurnReason::ReadyToStart) => {
                    format!("Finished: {}", prerequisites.join(", "))
                }
                Some(nodex_core_contracts::workspace::TurnReason::Approval) => {
                    "Approval is waiting in the chat.".into()
                }
                Some(nodex_core_contracts::workspace::TurnReason::Failed) => {
                    "The chat failed.".into()
                }
                Some(nodex_core_contracts::workspace::TurnReason::Blocked) => {
                    "Work is blocked.".into()
                }
                Some(nodex_core_contracts::workspace::TurnReason::Stalled) => {
                    "The chat has stopped making progress.".into()
                }
                _ => "Work is ready to review.".into(),
            });
        let url = connection
            .query_row(
                "SELECT url FROM page_pull_requests WHERE page_id=?1",
                [page],
                |r| r.get::<_, String>(0),
            )
            .optional()?;
        let delivery_error=connection.query_row("SELECT proposal.failure_message FROM page_turn_replies reply JOIN inbox_proposals proposal ON proposal.proposal_id=reply.proposal_id WHERE reply.page_id=?1 AND reply.episode=?2 AND proposal.state='failed' ORDER BY proposal.updated_at DESC LIMIT 1",params![page,turn.episode],|r|r.get::<_,String>(0)).optional()?;
        let delivery_error = delivery_error.or_else(|| {
            (requests.len() > 1)
                .then(|| "Several requests are pending; open the chat to reply.".into())
        });
        Some(InboxTurn {
            turn,
            note_id: note.map(|(id, _)| id),
            active_chat: chat,
            options,
            pull_request_url: url,
            delivery_error,
        })
    } else {
        None
    };
    Ok(ProjectWorkspaceInboxItem {
        problem: None,
        handback: None,
        row_kind: if kind == "turn" {
            InboxRowKind::Turn
        } else {
            InboxRowKind::Answer
        },
        turn,
        page_id: page.into(),
        page_key: crate::database::current_page_key_for_page(connection, library, page)?,
        page_status: None,
        title,
        body,
        body_truncated: false,
        body_editable: false,
        submitted_at: at,
        source: if kind == "answer" {
            ProjectWorkspaceInboxSource::Nodex {
                purpose: NodexEntryPurpose::Answer,
                subject_session_id: None,
                subject_page_id: None,
            }
        } else {
            ProjectWorkspaceInboxSource::User
        },
        reply_to_page_id: if kind == "answer" {
            connection
                .query_row(
                    "SELECT question_page_id FROM inbox_answers WHERE page_id=?1",
                    [page],
                    |r| r.get(0),
                )
                .optional()?
        } else {
            None
        },
        kind: None,
        important: false,
        state: ProjectWorkspaceInboxEntryState::Open,
        suggestion_state: ProjectWorkspaceInboxSuggestionState::None,
        suggestion_error: None,
        scope,
        location: ProjectWorkspaceInboxLocation::Other,
        proposal: None,
        revision: 1,
        basis: ProjectWorkspaceInboxPageBasis {
            page_id: page.into(),
            content_hash: "0".repeat(64),
        },
        outcome: None,
    })
}

pub(super) fn notification_intents(
    connection: &Connection,
    library: &str,
) -> Result<Vec<InboxTurnNotification>, StoreError> {
}
