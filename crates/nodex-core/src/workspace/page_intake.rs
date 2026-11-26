//! Member-visible intake for Page surfaces and public SQL.
use super::{
    InboxReadCache, corrupt, parse_kind, parse_suggestion_state, project_member_chat,
    project_member_item, read_item, scope_home,
};
use crate::infrastructure::{
    actors,
    sqlite::{StoreError, StoreErrorCode},
};
use nodex_core_contracts::inbox::{
    CompactInboxHandoff, CompactPageIntake, InboxHandoff, InboxMessageSource,
    InboxReadSuggestionState, InboxSuggestionSummary, PageIntake, PageIntakeMetadata,
    ProjectWorkspaceInboxProposal, ProjectWorkspaceInboxSuggestionState,
};
use nodex_core_contracts::{BoundModuleContext, agent::AgentTurnProvenance};
use rusqlite::{Connection, OptionalExtension, params};
use std::collections::BTreeMap;

struct IntakeRecord {
    page_id: String,
    inbox_project_id: Option<String>,
    source: InboxMessageSource,
    kind: Option<String>,
    important: bool,
    captured_at: String,
    waiting: bool,
    suggestion_state: String,
    suggestion_id: Option<String>,
    running_decision_id: Option<String>,
}

// Intake history and the waiting stream already apply the reader's membership, Page lifecycle
// and Project eligibility. A confirmed delivery in recovery may still be in the waiting stream.
const VISIBLE_INTAKE: &str = "
SELECT entry.page_id, entry.scope_project_id, entry.source_kind, entry.source_label,
       entry.kind, entry.important, block.created_at, intake.in_inbox, entry.suggestion_state,
       suggestion.proposal_id,
       CASE WHEN intake.in_inbox AND entry.suggestion_state='pending'
         THEN (SELECT delivery.decision_session_id FROM inbox_routing_deliveries delivery
           WHERE delivery.request_id=entry.suggestion_request_id) END
FROM inbox_member_rows intake
JOIN inbox_entries entry ON entry.page_id=intake.page_id
JOIN blocks block ON block.id=entry.page_id
LEFT JOIN inbox_proposals suggestion ON suggestion.proposal_id=entry.current_proposal_id
  AND suggestion.library_id=entry.library_id AND intake.in_inbox
  AND suggestion.confirmed_at IS NULL AND suggestion.state='open'
WHERE intake.library_id=?1 AND intake.member_id=?2 AND intake.row_kind='intake'";

impl IntakeRecord {
    fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            page_id: row.get(0)?,
            inbox_project_id: row.get(1)?,
            source: InboxMessageSource {
                kind: row.get(2)?,
                label: row.get(3)?,
            },
            kind: row.get(4)?,
            important: row.get(5)?,
            captured_at: row.get(6)?,
            waiting: row.get(7)?,
            suggestion_state: row.get(8)?,
            suggestion_id: row.get(9)?,
            running_decision_id: row.get(10)?,
        })
    }

    fn read(
        connection: &Connection,
        library: &str,
        member: &str,
        page_id: &str,
    ) -> Result<Option<Self>, StoreError> {
        Ok(connection
            .query_row(
                &format!("{VISIBLE_INTAKE} AND intake.page_id=?3"),
                params![library, member, page_id],
                Self::from_row,
            )
            .optional()?)
    }

    fn suggestion<'a>(
        &self,
        proposal: Option<&'a ProjectWorkspaceInboxProposal>,
    ) -> Option<&'a ProjectWorkspaceInboxProposal> {
        proposal.filter(|proposal| self.suggestion_id.as_ref() == Some(&proposal.proposal_id))
    }

    fn suggestion_state(
        &self,
        proposal: Option<&ProjectWorkspaceInboxProposal>,
    ) -> Result<Option<InboxReadSuggestionState>, StoreError> {
        use InboxReadSuggestionState as State;
        use ProjectWorkspaceInboxSuggestionState as Stored;
        if !self.waiting {
            return Ok(None);
        }
        Ok(match parse_suggestion_state(&self.suggestion_state)? {
            Stored::Waiting => Some(State::Waiting),
            Stored::Pending => Some(State::Running),
            Stored::Failed => Some(State::Failed),
            _ => proposal.map(|proposal| {
                if proposal.outdated {
                    State::Outdated
                } else {
                    State::Settled
                }
            }),
        })
    }

    fn suggestion_summary(
        &self,
        proposal: Option<&ProjectWorkspaceInboxProposal>,
    ) -> Result<Option<InboxSuggestionSummary>, StoreError> {
        Ok(self
            .suggestion_state(proposal)?
            .map(|state| InboxSuggestionSummary {
                state,
                action_type: proposal
                    .map(|proposal| proposal.action_details().action_type.to_owned()),
                summary: proposal.map(|proposal| proposal.summary.clone()),
            }))
    }

    fn read_suggestion(
        &self,
        connection: &Connection,
        library: &str,
        cache: &mut InboxReadCache,
    ) -> Result<Option<ProjectWorkspaceInboxProposal>, StoreError> {
        let Some(id) = self.suggestion_id.as_deref() else {
            return Ok(None);
        };
        cache.proposal(connection, library, id)
    }
}

struct HandoffFact {
    proposal_id: String,
    decided_at: String,
    actor_json: String,
}

/// Select the latest disposition before narrowing to chats. A return or a subsequent
/// non-chat decision must hide the earlier handoff, even if the proposal is retained.
fn handoff_fact(
    connection: &Connection,
    library: &str,
    page_id: &str,
) -> Result<Option<HandoffFact>, StoreError> {
    Ok(connection
        .query_row(
            "SELECT proposal.proposal_id, disposition.at, disposition.actor_json
         FROM intake_dispositions disposition
         JOIN inbox_proposals proposal ON proposal.proposal_id=disposition.proposal_id
           AND proposal.library_id=disposition.library_id AND proposal.confirmed_at IS NOT NULL
           AND proposal.state<>'superseded'
         WHERE disposition.id=(SELECT id FROM intake_dispositions WHERE page_id=?1 AND library_id=?2
           ORDER BY id DESC LIMIT 1) AND disposition.disposition='chat'
         AND NOT EXISTS(
           SELECT 1 FROM chat_message_handback_pages returned
           JOIN chat_message_handbacks receipt USING(receipt_id)
           WHERE returned.page_id=disposition.page_id
             AND receipt.created_seq>COALESCE(disposition.commit_seq,0)
         )",
            params![page_id, library],
            |row| {
                Ok(HandoffFact {
                    proposal_id: row.get(0)?,
                    decided_at: row.get(1)?,
                    actor_json: row.get(2)?,
                })
            },
        )
        .optional()?)
}

pub(crate) fn read(
    connection: &Connection,
    context: &BoundModuleContext,
    library: &str,
    page_id: &str,
) -> Result<(PageIntake, Option<PageIntakeMetadata>), StoreError> {
    super::super::session_mutation::validate_id("page_id", page_id)?;
    let member = actors::requesting_member(connection, context)?;
    let mut intake = PageIntake {
        page_id: page_id.to_owned(),
        message: None,
        handoff: None,
    };
    let Some(record) = IntakeRecord::read(connection, library, &member, page_id)? else {
        return Ok((intake, None));
    };
    let mut cache = InboxReadCache::default();
    if record.waiting {
        let home = scope_home(connection, library, record.inbox_project_id.as_deref())?;
        let (item, _) = read_item(connection, library, home.as_ref(), page_id, &mut cache)?;
        intake.message = Some(project_member_item(connection, &member, item)?);
    }
    if let Some(fact) = handoff_fact(connection, library, page_id)?
        && let Some(mut proposal) = cache.proposal(connection, library, &fact.proposal_id)?
    {
        if let Some(chat) = proposal.chat.as_mut() {
            project_member_chat(connection, &member, chat)?;
        }
        let actor = serde_json::from_str(&fact.actor_json)
            .map_err(|_| corrupt("Invalid Inbox decision actor"))?;
        let actor_label = super::super::activity::actor_label(connection, &actor, &member)?;
        intake.handoff = Some(InboxHandoff {
            proposal,
            decided_at: fact.decided_at,
            actor,
            actor_label,
        });
    }
    let suggestion = record.suggestion(
        intake
            .message
            .as_ref()
            .and_then(|message| message.proposal.as_ref()),
    );
    let related_pages = suggestion
        .into_iter()
        .filter(|proposal| proposal.page_ids.len() > 1)
        .flat_map(|proposal| &proposal.page_ids)
        .chain(
            intake
                .handoff
                .iter()
                .flat_map(|handoff| &handoff.proposal.created_page_ids),
        );
    let mut page_keys = BTreeMap::new();
    for id in related_pages {
        page_keys.insert(
            id.clone(),
            crate::database::current_page_key_for_page(connection, library, id)?,
        );
    }
    let metadata = PageIntakeMetadata {
        suggestion: record.suggestion_summary(suggestion)?,
        suggestion_decision_session_id: record
            .running_decision_id
            .or_else(|| suggestion.and_then(|proposal| proposal.decision_session_id.clone())),
        source: record.source,
        kind: parse_kind(record.kind.as_deref())?,
        important: record.important,
        captured_at: record.captured_at,
        page_keys,
    };
    Ok((intake, Some(metadata)))
}

/// A managed Agent reads the Inbox of the Member it represents in a shared Space.
pub(crate) fn reader(
    connection: &Connection,
    context: &BoundModuleContext,
    verified_turn: Option<&AgentTurnProvenance>,
) -> Result<String, StoreError> {
    if let Some(turn) = verified_turn
        && !actors::is_personal(connection, &context.library_id.0)?
    {
        let context = actors::verified_turn(connection, context, turn)?;
        return actors::requesting_member(connection, &context);
    }
    actors::requesting_member(connection, context)
}

pub(crate) fn read_compact(
    connection: &Connection,
    context: &BoundModuleContext,
    verified_turn: &AgentTurnProvenance,
    page_id: &str,
) -> Result<Option<CompactPageIntake>, StoreError> {
    let library = &context.library_id.0;
    // Ordinary Page fetches do not require a managed Session to read their content.
    let message: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM inbox_intake WHERE page_id=?1 AND library_id=?2)",
        params![page_id, library],
        |row| row.get(0),
    )?;
    if !message {
        return Ok(None);
    }
    let member = match reader(connection, context, Some(verified_turn)) {
        Ok(member) => member,
        // Page access is independent of representing a Member in a Team Inbox.
        Err(error) if error.code == StoreErrorCode::Unauthorized => return Ok(None),
        Err(error) => return Err(error),
    };
    let Some(record) = IntakeRecord::read(connection, library, &member, page_id)? else {
        return Ok(None);
    };
    let mut cache = InboxReadCache::default();
    let proposal = record.read_suggestion(connection, library, &mut cache)?;
    let handoff = if let Some(fact) = handoff_fact(connection, library, page_id)? {
        cache
            .proposal(connection, library, &fact.proposal_id)?
            .map(|proposal| CompactInboxHandoff {
                session_id: proposal.action_details().session_id.map(str::to_owned),
                decided_at: fact.decided_at,
                confirmed_by: proposal.confirmed_by,
            })
    } else {
        None
    };
    Ok(Some(CompactPageIntake {
        suggestion: record.suggestion_summary(proposal.as_ref())?,
        source: record.source,
        waiting: record.waiting,
        handoff,
    }))
}

#[derive(Clone, Copy)]
pub(crate) enum SqlRelation {
    Messages,
    Suggestions,
}

pub(crate) fn visit_sql_rows(
    connection: &Connection,
    context: &BoundModuleContext,
    agent_turn: Option<&AgentTurnProvenance>,
    relation: SqlRelation,
    page_id: Option<&str>,
    mut accept: impl FnMut(serde_json::Value) -> Result<(), StoreError>,
) -> Result<(), StoreError> {
    let library = &context.library_id.0;
    let member = reader(connection, context, agent_turn)?;
    let sql = match page_id {
        Some(_) => format!("{VISIBLE_INTAKE} AND intake.page_id=?3"),
        None => VISIBLE_INTAKE.to_owned(),
    };
    let mut statement = connection.prepare(&sql)?;
    let mut rows = if let Some(page_id) = page_id {
        statement.query(params![library, member, page_id])?
    } else {
        statement.query(params![library, member])?
    };
    // A grouped proposal is read once for all its member rows.
    let mut cache = InboxReadCache::default();
    while let Some(row) = rows.next()? {
        crate::infrastructure::request_execution::check_request_interruption()?;
        let record = IntakeRecord::from_row(row)?;
        let suggestion = record.read_suggestion(connection, library, &mut cache)?;
        match relation {
            SqlRelation::Messages => accept(serde_json::json!({
                "page_id": record.page_id,
                "inbox_project_id": record.inbox_project_id,
                "source_kind": record.source.kind,
                "source_label": record.source.label,
                "kind": record.kind,
                "important": record.important,
                "captured_at": record.captured_at,
                "waiting": record.waiting,
                "suggestion_state": record.suggestion_state(suggestion.as_ref())?,
            }))?,
            SqlRelation::Suggestions => {
                if let Some(proposal) = suggestion
                    && let Some(value) = sql_suggestion(&record.page_id, &proposal, None)
                {
                    accept(value)?;
                }
                if let Some(fact) = handoff_fact(connection, library, &record.page_id)?
                    && let Some(proposal) =
                        cache.proposal(connection, library, &fact.proposal_id)?
                    && let Some(value) =
                        sql_suggestion(&record.page_id, &proposal, Some(&fact.decided_at))
                {
                    accept(value)?;
                }
            }
        }
    }
    Ok(())
}

fn sql_suggestion(
    page_id: &str,
    proposal: &ProjectWorkspaceInboxProposal,
    decided_at: Option<&str>,
) -> Option<serde_json::Value> {
    use nodex_core_contracts::inbox::ProjectWorkspaceInboxProposalOrigin as Origin;
    let index = proposal.page_ids.iter().position(|id| id == page_id)?;
    let action = proposal.action_details();
    Some(serde_json::json!({
        "proposal_id": proposal.proposal_id,
        "page_id": page_id,
        "member_index": index,
        "member_count": proposal.page_ids.len(),
        "stage": if decided_at.is_some() { "sent" } else { "suggested" },
        "outdated": proposal.outdated,
        "origin": match proposal.origin {
            Origin::Agent => "nodex",
            Origin::User => "user",
            Origin::Automation => "automation",
        },
        "action_type": action.action_type,
        "project_id": action.project_id,
        "session_id": action.session_id,
        "prompt": action.prompt,
        "additions": action.additions,
        "skills": action.skills,
        "summary": proposal.summary,
        "rationale": proposal.rationale,
        "suggested_by": proposal.produced_by,
        "decision_session_id": proposal.decision_session_id,
        "created_at": proposal.created_at,
        "decided_at": decided_at,
        "confirmed_by": proposal.confirmed_by,
    }))
}
