//! Bounded Inbox read models: the user's stream, the suggestion Agent's routing
//! context, and the Desktop Host's dispatch outbox.

use nodex_core_contracts::BoundModuleContext;
use nodex_core_contracts::collection::{
    CollectionWindow, CollectionWindowAuthority, CollectionWindowRequest,
};
use nodex_core_contracts::inbox::{
    ProjectWorkspaceInboxChat, ProjectWorkspaceInboxContextProject,
    ProjectWorkspaceInboxContextProposal, ProjectWorkspaceInboxContextSession,
    ProjectWorkspaceInboxDispatchAction, ProjectWorkspaceInboxDispatchContext,
    ProjectWorkspaceInboxDispatchWork, ProjectWorkspaceInboxEntryState, ProjectWorkspaceInboxItem,
    ProjectWorkspaceInboxLocation, ProjectWorkspaceInboxPageBasis, ProjectWorkspaceInboxProposal,
    ProjectWorkspaceInboxProposalOrigin, ProjectWorkspaceInboxProposalState,
    ProjectWorkspaceInboxSource, ProjectWorkspaceInboxSuggestionInput,
    ProjectWorkspaceInboxSuggestionState, ProjectWorkspaceInboxSummary,
    ProjectWorkspaceInboxWindowFilter,
};
use nodex_core_contracts::workspace::{
    CodexThreadActiveFlag, CodexThreadStatusType, ProjectWorkspaceThreadStatus,
};
use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, OptionalExtension, params, params_from_iter};

use crate::infrastructure::collection_window::{WindowCandidate, assemble, normalize_request};
use crate::infrastructure::cursor::{
    self, CollectionCursorSubject, CursorDirection, KeysetCoordinate, KeysetValue,
};
use crate::infrastructure::sqlite::StoreError;

use super::inbox::{
    MAX_PROPOSAL_PAGES, corrupt, invalid, parse_action, parse_kind, proposal_page_ids,
    read_registry, truncate_chars,
};

const MAX_STREAM_BODY_BYTES: usize = 8 * 1024;
const MAX_AGENT_BODY_BYTES: usize = 4 * 1024;
const MAX_CONTEXT_PROJECTS: i64 = 50;
const MAX_CONTEXT_SESSIONS: i64 = 30;
const MAX_CONTEXT_PROPOSALS: i64 = 20;
const MAX_CONTEXT_DESCRIPTION_CHARS: usize = 400;
const MAX_BATCH: u32 = 16;

pub(super) fn read_summary(
    connection: &Connection,
    _context: &BoundModuleContext,
    library_id: &str,
) -> Result<ProjectWorkspaceInboxSummary, StoreError> {
    let registry = read_registry(connection, library_id)?;
    let (entry_count, inbox_count, needs_decision_count, pending_suggestion_count) = connection
        .query_row(
            &format!(
                "SELECT count(*), \
                   COALESCE(SUM({IN_INBOX}), 0), \
                   COALESCE(SUM(entry.state = 'open' AND proposal.state = 'open'), 0), \
                   COALESCE(SUM(entry.state = 'open' AND entry.suggestion_state = 'pending'), 0) \
                 FROM inbox_entries entry \
                 JOIN blocks block ON block.id = entry.page_id AND block.lifecycle = 'active' \
                 LEFT JOIN inbox_proposals proposal \
                   ON proposal.proposal_id = entry.current_proposal_id \
                 WHERE entry.library_id = ?1"
            ),
            [library_id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            },
        )?;
    let dispatching_count = connection.query_row(
        "SELECT count(*) FROM inbox_proposals WHERE library_id = ?1 AND state = 'dispatching'",
        [library_id],
        |row| row.get::<_, i64>(0),
    )?;
    Ok(ProjectWorkspaceInboxSummary {
        database_id: registry
            .as_ref()
            .map(|registry| registry.database_id.clone()),
        view_id: registry.map(|registry| registry.view_id),
        entry_count: count(entry_count)?,
        inbox_count: count(inbox_count)?,
        needs_decision_count: count(needs_decision_count)?,
        pending_suggestion_count: count(pending_suggestion_count)?,
        dispatching_count: count(dispatching_count)?,
    })
}

/// A message stays in the Inbox until the user handles it. A confirmed chat dispatch,
/// a Page moved out of the Inbox Database, Keep, and Done all handle it. A failed
/// dispatch or a move that was undone brings it back. Never NULL.
const IN_INBOX: &str = "(entry.state = 'open' \
    AND COALESCE(proposal.state, '') <> 'dispatching' \
    AND NOT (COALESCE(proposal.state, '') = 'completed' \
      AND COALESCE(json_extract(proposal.action_json, '$.type'), '') \
        IN ('new_chat', 'send_to_chat')) \
    AND EXISTS (SELECT 1 FROM pages inbox_page \
      JOIN inbox_registry inbox_home ON inbox_home.library_id = entry.library_id \
      WHERE inbox_page.block_id = entry.page_id AND inbox_page.parent_kind = 'data_source' \
        AND inbox_page.parent_id = inbox_home.data_source_id))";

fn filter_predicate(filter: ProjectWorkspaceInboxWindowFilter) -> String {
    match filter {
        ProjectWorkspaceInboxWindowFilter::Inbox => IN_INBOX.to_owned(),
        ProjectWorkspaceInboxWindowFilter::Processed => format!("NOT {IN_INBOX}"),
    }
}

/// Newest-first stream window ordered by submission sequence.
pub(super) fn read_window(
    connection: &Connection,
    _context: &BoundModuleContext,
    library_id: &str,
    commit_head: i64,
    filter: ProjectWorkspaceInboxWindowFilter,
    request: &CollectionWindowRequest,
) -> Result<CollectionWindow<ProjectWorkspaceInboxItem>, StoreError> {
    let normalized = normalize_request(request)?;
    let fingerprint = cursor::query_fingerprint(&("workspace_inbox_window_v1", filter))?;
    let subject = CollectionCursorSubject {
        kind: "workspace_inbox_entries",
        library_id,
        query_fingerprint: &fingerprint,
    };
    let after = normalized
        .after
        .map(|encoded| cursor::decode(connection, encoded, subject))
        .transpose()?
        .map(|(direction, coordinate)| {
            let [KeysetValue::Integer { value }] = coordinate.values.as_slice() else {
                return Err(invalid("Inbox cursor coordinate is invalid"));
            };
            if direction != CursorDirection::Forward {
                return Err(invalid("Inbox cursor is incompatible"));
            }
            Ok(*value)
        })
        .transpose()?;
    let registry = read_registry(connection, library_id)?;
    let mut parameters = vec![SqlValue::Text(library_id.to_owned())];
    let cursor_predicate = match after {
        Some(seq) => {
            parameters.push(SqlValue::Integer(seq));
            "AND entry.seq < ?2"
        }
        None => "",
    };
    parameters.push(SqlValue::Integer(
        i64::try_from(normalized.first + 1).map_err(|_| invalid("Inbox window is invalid"))?,
    ));
    let limit_parameter = parameters.len();
    let sql = format!(
        "SELECT entry.page_id \
         FROM inbox_entries entry \
         JOIN blocks block ON block.id = entry.page_id AND block.lifecycle = 'active' \
         LEFT JOIN inbox_proposals proposal ON proposal.proposal_id = entry.current_proposal_id \
         WHERE entry.library_id = ?1 AND {} {cursor_predicate} \
         ORDER BY entry.seq DESC LIMIT ?{limit_parameter}",
        filter_predicate(filter)
    );
    let page_ids = connection
        .prepare(&sql)?
        .query_map(params_from_iter(parameters.iter()), |row| {
            row.get::<_, String>(0)
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut candidates = Vec::with_capacity(page_ids.len());
    for page_id in page_ids {
        let (item, seq) = read_item(connection, library_id, registry.as_ref(), &page_id)?;
        candidates.push(WindowCandidate {
            coordinate: KeysetCoordinate {
                values: vec![KeysetValue::Integer { value: seq }],
                stable_id: item.page_id.clone(),
            },
            item,
        });
    }
    assemble(
        candidates,
        normalized.first,
        CollectionWindowAuthority {
            projection_revision: commit_head,
        },
        |coordinate| {
            cursor::mint(
                connection,
                subject,
                CursorDirection::Forward,
                coordinate.clone(),
            )
        },
    )
}

struct EntryRow {
    seq: i64,
    submitted_at: String,
    source_kind: String,
    source_session_id: Option<String>,
    source_thread_id: Option<String>,
    source_run_id: Option<String>,
    source_project_id: Option<String>,
    source_label: Option<String>,
    provisional_title: Option<String>,
    kind: Option<String>,
    state: String,
    suggestion_state: String,
    suggestion_error: Option<String>,
    current_proposal_id: Option<String>,
    revision: i64,
    parent_kind: String,
    parent_id: String,
    title: String,
    nfm: Option<String>,
    source_body_truncated: bool,
    plain_text: String,
    generation: i64,
    head_seq: i64,
}

/// Admit a small complete NFM or bounded text prefix in SQLite before decoding.
/// Byte lengths read column metadata; oversized documents never enter the NFM parser.
fn read_entry(
    connection: &Connection,
    page_id: &str,
    body_budget: usize,
) -> Result<EntryRow, StoreError> {
    connection
        .query_row(
            "SELECT entry.seq, entry.submitted_at, entry.source_kind, entry.source_session_id, \
               entry.source_thread_id, entry.source_project_id, entry.source_label, entry.kind, \
               entry.state, entry.suggestion_state, entry.suggestion_error, \
               entry.current_proposal_id, entry.revision, page.parent_kind, page.parent_id, \
               COALESCE(materialization.title, ''), CASE WHEN octet_length(materialization.nfm) <= ?2 \
                 THEN materialization.nfm ELSE NULL END, \
               substr(COALESCE(materialization.plain_text, ''),1,?3), document.generation, document.head_seq, \
               entry.provisional_title, entry.source_turn_id, \
               COALESCE(octet_length(materialization.plain_text),0) > ?3 \
             FROM inbox_entries entry \
             JOIN pages page ON page.block_id = entry.page_id \
             JOIN documents document ON document.id = page.document_id \
             LEFT JOIN document_materializations materialization \
               ON materialization.document_id = page.document_id \
             WHERE entry.page_id = ?1",
            params![page_id, (body_budget * 8) as i64, body_budget as i64],
            |row| {
                Ok(EntryRow {
                    seq: row.get(0)?,
                    submitted_at: row.get(1)?,
                    source_kind: row.get(2)?,
                    source_session_id: row.get(3)?,
                    source_thread_id: row.get(4)?,
                    source_run_id: row.get(21)?,
                    source_body_truncated: row.get(22)?,
                    source_project_id: row.get(5)?,
                    source_label: row.get(6)?,
                    provisional_title: row.get(20)?,
                    kind: row.get(7)?,
                    state: row.get(8)?,
                    suggestion_state: row.get(9)?,
                    suggestion_error: row.get(10)?,
                    current_proposal_id: row.get(11)?,
                    revision: row.get(12)?,
                    parent_kind: row.get(13)?,
                    parent_id: row.get(14)?,
                    title: row.get(15)?,
                    nfm: row.get(16)?,
                    plain_text: row.get(17)?,
                    generation: row.get(18)?,
                    head_seq: row.get(19)?,
                })
            },
        )
        .optional()?
        .ok_or_else(|| corrupt("Inbox entry Page disappeared during the read"))
}

/// The message is the Page body; the title is only its label.
fn message_body(row: &EntryRow) -> String {
    let Some(nfm) = &row.nfm else {
        return row.plain_text.clone();
    };
    crate::domain::nfm_parser::parse_nfm(nfm)
        .map(|blocks| crate::domain::nfm::extract_block_lines(&blocks))
        .unwrap_or_else(|_| row.plain_text.clone())
}

fn bounded_utf8(value: &str, maximum: usize) -> (String, bool) {
    if value.len() <= maximum {
        return (value.to_owned(), false);
    }
    let mut boundary = maximum;
    while !value.is_char_boundary(boundary) {
        boundary -= 1;
    }
    (value[..boundary].to_owned(), true)
}

fn source(row: &EntryRow) -> ProjectWorkspaceInboxSource {
    match row.source_kind.as_str() {
        "agent" => ProjectWorkspaceInboxSource::Agent {
            session_id: row.source_session_id.clone(),
            thread_id: row.source_thread_id.clone(),
            run_id: row.source_run_id.clone(),
            project_id: row.source_project_id.clone(),
            label: row
                .source_label
                .clone()
                .unwrap_or_else(|| "Agent".to_owned()),
        },
        "command_line" => ProjectWorkspaceInboxSource::CommandLine {
            project_id: row.source_project_id.clone(),
            label: row
                .source_label
                .clone()
                .unwrap_or_else(|| super::inbox::COMMAND_LINE_SOURCE_LABEL.to_owned()),
        },
        _ => ProjectWorkspaceInboxSource::User,
    }
}

fn read_item(
    connection: &Connection,
    library_id: &str,
    registry: Option<&super::inbox::InboxRegistry>,
    page_id: &str,
) -> Result<(ProjectWorkspaceInboxItem, i64), StoreError> {
    let row = read_entry(connection, page_id, MAX_STREAM_BODY_BYTES)?;
    let (body, body_truncated) = bounded_utf8(&message_body(&row), MAX_STREAM_BODY_BYTES);
    let location = location(connection, registry, &row)?;
    let proposal = row
        .current_proposal_id
        .as_deref()
        .map(|proposal_id| read_proposal(connection, library_id, proposal_id))
        .transpose()?
        .flatten();
    Ok((
        ProjectWorkspaceInboxItem {
            page_id: page_id.to_owned(),
            page_key: crate::database::current_page_key_for_page(connection, library_id, page_id)?,
            title: row.title.clone(),
            body,
            body_truncated: body_truncated || row.source_body_truncated || row.nfm.is_none(),
            submitted_at: row.submitted_at.clone(),
            source: source(&row),
            kind: parse_kind(row.kind.as_deref())?,
            state: parse_state(&row.state)?,
            suggestion_state: parse_suggestion_state(&row.suggestion_state)?,
            suggestion_error: row.suggestion_error.clone(),
            location,
            proposal,
            revision: row.revision,
        },
        row.seq,
    ))
}

fn location(
    connection: &Connection,
    registry: Option<&super::inbox::InboxRegistry>,
    row: &EntryRow,
) -> Result<ProjectWorkspaceInboxLocation, StoreError> {
    if row.parent_kind != "data_source" {
        return Ok(ProjectWorkspaceInboxLocation::Other);
    }
    if registry.is_some_and(|registry| registry.data_source_id == row.parent_id) {
        return Ok(ProjectWorkspaceInboxLocation::Inbox);
    }
    Ok(connection
        .query_row(
            "SELECT container.block_id, container.name, project.id, project.name \
             FROM data_sources source \
             JOIN database_containers container ON container.block_id = source.home_database_block_id \
             LEFT JOIN project_database_bindings binding \
               ON binding.database_block_id = container.block_id AND binding.lifecycle = 'active' \
             LEFT JOIN projects project ON project.id = binding.project_id \
             WHERE source.id = ?1",
            [&row.parent_id],
            |row| {
                Ok(ProjectWorkspaceInboxLocation::Database {
                    database_id: row.get(0)?,
                    database_name: row.get(1)?,
                    project_id: row.get(2)?,
                    project_name: row.get(3)?,
                })
            },
        )
        .optional()?
        .unwrap_or(ProjectWorkspaceInboxLocation::Other))
}

fn read_proposal(
    connection: &Connection,
    library_id: &str,
    proposal_id: &str,
) -> Result<Option<ProjectWorkspaceInboxProposal>, StoreError> {
    let Some(row) = connection
        .query_row(
            "SELECT revision, origin, state, action_json, kind, summary, rationale, produced_by, \
               dispatch_session_id, failure_message, created_at, updated_at \
             FROM inbox_proposals WHERE proposal_id = ?1 AND library_id = ?2",
            params![proposal_id, library_id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, Option<String>>(8)?,
                    row.get::<_, Option<String>>(9)?,
                    row.get::<_, String>(10)?,
                    row.get::<_, String>(11)?,
                ))
            },
        )
        .optional()?
    else {
        return Ok(None);
    };
    let (
        revision,
        origin,
        state,
        action_json,
        kind,
        summary,
        rationale,
        produced_by,
        dispatch_session_id,
        failure_message,
        created_at,
        updated_at,
    ) = row;
    let state = parse_proposal_state(&state)?;
    if state == ProjectWorkspaceInboxProposalState::Superseded {
        return Ok(None);
    }
    let action = parse_action(&action_json)?;
    let target_project_id = match &action {
        ProjectWorkspaceInboxDispatchAction::NewChat { project_id, .. } => project_id.clone(),
        ProjectWorkspaceInboxDispatchAction::MoveToProject { project_id } => {
            Some(project_id.clone())
        }
        _ => None,
    };
    let target_project_name = target_project_id
        .map(|project_id| {
            connection
                .query_row(
                    "SELECT name FROM projects WHERE id = ?1 AND library_id = ?2",
                    params![project_id, library_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()
        })
        .transpose()?
        .flatten();
    let chat_session_id = dispatch_session_id.or_else(|| match &action {
        ProjectWorkspaceInboxDispatchAction::SendToChat { session_id, .. } => {
            Some(session_id.clone())
        }
        _ => None,
    });
    let chat = chat_session_id
        .map(|session_id| read_chat(connection, library_id, &session_id))
        .transpose()?
        .flatten();
    Ok(Some(ProjectWorkspaceInboxProposal {
        proposal_id: proposal_id.to_owned(),
        revision,
        origin: if origin == "user" {
            ProjectWorkspaceInboxProposalOrigin::User
        } else {
            ProjectWorkspaceInboxProposalOrigin::Agent
        },
        state,
        page_ids: proposal_page_ids(connection, proposal_id)?,
        action,
        kind: parse_kind(kind.as_deref())?,
        summary,
        rationale,
        produced_by,
        target_project_name,
        chat,
        failure_message,
        created_at,
        updated_at,
    }))
}

fn read_chat(
    connection: &Connection,
    library_id: &str,
    session_id: &str,
) -> Result<Option<ProjectWorkspaceInboxChat>, StoreError> {
    Ok(connection
        .query_row(
            "SELECT session.id, session.project_id, project.name, session.no_thread_fallback_title, \
               COALESCE(binding.runtime_thread_id,thread.thread_id), thread.thread_name, \
               substr(COALESCE(thread.thread_preview, ''),1,240), \
               thread.status_type, thread.status_active_flags_json, session.unread, session.archived \
             FROM project_sessions session \
             LEFT JOIN projects project ON project.id = session.project_id \
             LEFT JOIN project_session_execution_bindings binding ON binding.session_id=session.id \
             LEFT JOIN project_session_threads link ON link.session_id = session.id \
             LEFT JOIN codex_threads thread ON thread.thread_id = link.thread_id \
             WHERE session.id = ?1 AND (session.project_id IS NULL OR project.library_id = ?2)",
            params![session_id, library_id],
            |row| {
                let thread_id = row.get::<_, Option<String>>(4)?;
                let preview = super::task_window::bounded_preview(&row.get::<_, String>(6)?);
                let status = row.get::<_, Option<String>>(7)?.map(|status_type| {
                    thread_status(&status_type, &row.get::<_, String>(8)?)
                }).transpose()?;
                Ok(ProjectWorkspaceInboxChat {
                    session_id: row.get(0)?,
                    project_id: row.get(1)?,
                    project_name: row.get(2)?,
                    display_title: super::read::project_session_display_title(
                        row.get::<_, Option<String>>(5)?.as_deref(),
                        thread_id.as_ref().map(|_| preview.as_str()),
                        &row.get::<_, String>(3)?,
                    ),
                    thread_id,
                    status,
                    unread: row.get::<_, i64>(9)? == 1,
                    archived: row.get::<_, i64>(10)? == 1,
                })
            },
        )
        .optional()?)
}

fn thread_status(
    status_type: &str,
    active_flags: &str,
) -> rusqlite::Result<ProjectWorkspaceThreadStatus> {
    let status_type = match status_type {
        "notLoaded" => CodexThreadStatusType::NotLoaded,
        "idle" => CodexThreadStatusType::Idle,
        "systemError" => CodexThreadStatusType::SystemError,
        "active" => CodexThreadStatusType::Active,
        _ => return Err(rusqlite::Error::InvalidQuery),
    };
    let active_flags = serde_json::from_str::<Vec<CodexThreadActiveFlag>>(active_flags)
        .map_err(|_| rusqlite::Error::InvalidQuery)?;
    Ok(ProjectWorkspaceThreadStatus {
        status_type,
        active_flags,
    })
}

/// Open entries waiting for a suggestion, oldest first.
pub(super) fn read_pending_suggestions(
    connection: &Connection,
    _context: &BoundModuleContext,
    library_id: &str,
    limit: u32,
) -> Result<Vec<ProjectWorkspaceInboxSuggestionInput>, StoreError> {
    let limit = i64::from(limit.clamp(1, MAX_BATCH));
    let page_ids = connection
        .prepare(
            "SELECT entry.page_id FROM inbox_entries entry \
             JOIN blocks block ON block.id = entry.page_id AND block.lifecycle = 'active' \
             WHERE entry.library_id = ?1 AND entry.state = 'open' \
               AND entry.suggestion_state = 'pending' \
             ORDER BY entry.seq LIMIT ?2",
        )?
        .query_map(params![library_id, limit], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    page_ids
        .iter()
        .map(|page_id| suggestion_input(connection, library_id, page_id))
        .collect()
}

fn suggestion_input(
    connection: &Connection,
    library_id: &str,
    page_id: &str,
) -> Result<ProjectWorkspaceInboxSuggestionInput, StoreError> {
    let row = read_entry(connection, page_id, MAX_AGENT_BODY_BYTES)?;
    let (body, _) = bounded_utf8(&message_body(&row), MAX_AGENT_BODY_BYTES);
    Ok(ProjectWorkspaceInboxSuggestionInput {
        page_id: page_id.to_owned(),
        page_key: crate::database::current_page_key_for_page(connection, library_id, page_id)?,
        title: row.title.clone(),
        body,
        source: source(&row),
        kind: parse_kind(row.kind.as_deref())?,
        submitted_at: row.submitted_at.clone(),
        basis: ProjectWorkspaceInboxPageBasis {
            page_id: page_id.to_owned(),
            generation: row.generation,
            head_seq: row.head_seq,
        },
        // Any rename, by the user or by an earlier suggestion, makes the title theirs.
        title_provisional: row.provisional_title.as_deref() == Some(row.title.as_str()),
    })
}

pub(super) fn read_dispatch_context(
    connection: &Connection,
    _context: &BoundModuleContext,
    library_id: &str,
    page_ids: &[String],
) -> Result<ProjectWorkspaceInboxDispatchContext, StoreError> {
    if page_ids.is_empty() || page_ids.len() > MAX_PROPOSAL_PAGES {
        return Err(invalid("Inbox dispatch context needs 1 to 16 entries"));
    }
    let mut entries = Vec::with_capacity(page_ids.len());
    for page_id in page_ids {
        super::session_mutation::validate_id("page_id", page_id)?;
        let exists = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM inbox_entries WHERE page_id = ?1 AND library_id = ?2)",
            params![page_id, library_id],
            |row| row.get::<_, bool>(0),
        )?;
        if !exists {
            return Err(super::inbox::not_found("Inbox entry is unavailable"));
        }
        entries.push(suggestion_input(connection, library_id, page_id)?);
    }
    let projects = connection
        .prepare(
            "SELECT project.id, project.name, substr(project.description,1,400) FROM projects project \
             LEFT JOIN project_order ordering ON ordering.project_id = project.id \
             WHERE project.library_id = ?1 AND project.lifecycle = 'active' \
             ORDER BY COALESCE(ordering.\"order\", 0), project.id LIMIT ?2",
        )?
        .query_map(params![library_id, MAX_CONTEXT_PROJECTS], |row| {
            Ok(ProjectWorkspaceInboxContextProject {
                project_id: row.get(0)?,
                name: row.get(1)?,
                description: truncate_chars(
                    row.get::<_, String>(2)?.trim(),
                    MAX_CONTEXT_DESCRIPTION_CHARS,
                ),
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let sessions = connection
        .prepare(
            "SELECT session.id, session.project_id, thread.thread_name, \
               substr(COALESCE(thread.thread_preview, ''),1,240), session.no_thread_fallback_title, \
               thread.status_type, thread.status_active_flags_json, \
               COALESCE(thread.recency_at,unixepoch(session.updated_at)*1000) \
             FROM project_sessions session \
             LEFT JOIN project_session_execution_bindings binding ON binding.session_id=session.id \
             LEFT JOIN project_session_threads link ON link.session_id = session.id \
             LEFT JOIN codex_threads thread ON thread.thread_id = link.thread_id \
             LEFT JOIN projects project ON project.id = session.project_id \
             WHERE session.archived = 0 AND COALESCE(thread.archived, 0) = 0 \
               AND (binding.runtime_thread_id IS NOT NULL OR thread.thread_id IS NOT NULL) \
               AND (session.project_id IS NULL OR (project.library_id = ?1 \
                 AND project.lifecycle = 'active')) \
             ORDER BY COALESCE(thread.recency_at,unixepoch(session.updated_at)*1000) DESC, session.id LIMIT ?2",
        )?
        .query_map(params![library_id, MAX_CONTEXT_SESSIONS], |row| {
            let preview = super::task_window::bounded_preview(&row.get::<_, String>(3)?);
            Ok(ProjectWorkspaceInboxContextSession {
                session_id: row.get(0)?,
                project_id: row.get(1)?,
                title: super::read::project_session_display_title(
                    row.get::<_, Option<String>>(2)?.as_deref(),
                    Some(preview.as_str()),
                    &row.get::<_, String>(4)?,
                ),
                preview,
                status: row.get::<_, Option<String>>(5)?.map(|status_type| {
                    thread_status(&status_type, &row.get::<_, String>(6)?)
                }).transpose()?,
                recency_at: row.get(7)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let proposal_rows = connection
        .prepare(
            "SELECT proposal_id, action_json, summary FROM inbox_proposals \
             WHERE library_id = ?1 AND state = 'open' \
             ORDER BY created_at DESC, proposal_id LIMIT ?2",
        )?
        .query_map(params![library_id, MAX_CONTEXT_PROPOSALS], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut open_proposals = Vec::with_capacity(proposal_rows.len());
    for (proposal_id, action_json, summary) in proposal_rows {
        let page_ids = proposal_page_ids(connection, &proposal_id)?;
        let mut page_keys = Vec::new();
        for page_id in &page_ids {
            if let Some(key) =
                crate::database::current_page_key_for_page(connection, library_id, page_id)?
            {
                page_keys.push(key);
            }
        }
        open_proposals.push(ProjectWorkspaceInboxContextProposal {
            proposal_id,
            page_ids,
            page_keys,
            action: parse_action(&action_json)?,
            summary,
        });
    }
    Ok(ProjectWorkspaceInboxDispatchContext {
        entries,
        projects,
        sessions,
        open_proposals,
    })
}

/// Confirmed chat dispatches awaiting host delivery, oldest confirmation first.
pub(super) fn read_dispatch_outbox(
    connection: &Connection,
    _context: &BoundModuleContext,
    library_id: &str,
    limit: u32,
) -> Result<Vec<ProjectWorkspaceInboxDispatchWork>, StoreError> {
    let limit = i64::from(limit.clamp(1, MAX_BATCH));
    let rows = connection
        .prepare(
            "SELECT proposal.proposal_id, proposal.revision, proposal.action_json, \
               proposal.dispatch_session_id, session.project_id, \
               COALESCE(binding.runtime_thread_id,link.thread_id, proposal.dispatch_thread_id), proposal.attempt, \
               proposal.confirmed_at, thread.status_type, thread.status_active_flags_json, \
               thread.agent_backend_kind \
             FROM inbox_proposals proposal \
             LEFT JOIN project_sessions session ON session.id = proposal.dispatch_session_id \
             LEFT JOIN project_session_execution_bindings binding ON binding.session_id=proposal.dispatch_session_id \
             LEFT JOIN project_session_threads link ON link.session_id = proposal.dispatch_session_id \
             LEFT JOIN codex_threads thread \
               ON thread.thread_id = COALESCE(link.thread_id, proposal.dispatch_thread_id) \
             WHERE proposal.library_id = ?1 AND proposal.state = 'dispatching' \
             ORDER BY proposal.confirmed_at, proposal.proposal_id LIMIT ?2",
        )?
        .query_map(params![library_id, limit], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, i64>(6)?,
                row.get::<_, String>(7)?,
                match row.get::<_, Option<String>>(8)? {
                    Some(status_type) => {
                        Some(thread_status(&status_type, &row.get::<_, String>(9)?)?)
                    }
                    None => None,
                },
                row.get::<_, Option<String>>(10)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut work = Vec::with_capacity(rows.len());
    for (
        proposal_id,
        revision,
        action_json,
        session_id,
        project_id,
        thread_id,
        attempt,
        confirmed_at,
        thread_status,
        thread_backend_kind,
    ) in rows
    {
        let page_ids = proposal_page_ids(connection, &proposal_id)?;
        let mut page_keys = Vec::new();
        for page_id in &page_ids {
            if let Some(key) =
                crate::database::current_page_key_for_page(connection, library_id, page_id)?
            {
                page_keys.push(key);
            }
        }
        work.push(ProjectWorkspaceInboxDispatchWork {
            proposal_id,
            revision,
            action: parse_action(&action_json)?,
            session_id,
            project_id,
            thread_id,
            page_ids,
            page_keys,
            attempt,
            confirmed_at,
            thread_status,
            thread_backend_kind,
        });
    }
    Ok(work)
}

fn parse_state(value: &str) -> Result<ProjectWorkspaceInboxEntryState, StoreError> {
    match value {
        "open" => Ok(ProjectWorkspaceInboxEntryState::Open),
        "kept" => Ok(ProjectWorkspaceInboxEntryState::Kept),
        "done" => Ok(ProjectWorkspaceInboxEntryState::Done),
        _ => Err(corrupt("Stored Inbox entry state is invalid")),
    }
}

fn parse_suggestion_state(value: &str) -> Result<ProjectWorkspaceInboxSuggestionState, StoreError> {
    match value {
        "pending" => Ok(ProjectWorkspaceInboxSuggestionState::Pending),
        "settled" => Ok(ProjectWorkspaceInboxSuggestionState::Settled),
        "failed" => Ok(ProjectWorkspaceInboxSuggestionState::Failed),
        _ => Err(corrupt("Stored Inbox suggestion state is invalid")),
    }
}

fn parse_proposal_state(value: &str) -> Result<ProjectWorkspaceInboxProposalState, StoreError> {
    match value {
        "open" => Ok(ProjectWorkspaceInboxProposalState::Open),
        "superseded" => Ok(ProjectWorkspaceInboxProposalState::Superseded),
        "dismissed" => Ok(ProjectWorkspaceInboxProposalState::Dismissed),
        "dispatching" => Ok(ProjectWorkspaceInboxProposalState::Dispatching),
        "completed" => Ok(ProjectWorkspaceInboxProposalState::Completed),
        "failed" => Ok(ProjectWorkspaceInboxProposalState::Failed),
        _ => Err(corrupt("Stored Inbox proposal state is invalid")),
    }
}

fn count(value: i64) -> Result<u32, StoreError> {
    u32::try_from(value).map_err(|_| corrupt("Inbox count is invalid"))
}

#[cfg(test)]
mod tests {
    use super::super::test_support::{apply, seeded_workspace};
    use super::*;
    use nodex_core_contracts::workspace::ProjectWorkspaceIntent;

    #[test]
    fn edited_large_inbox_pages_admit_only_bounded_body_text_before_decoding() {
        let workspace = seeded_workspace();
        apply(
            &workspace.module,
            "large-capture",
            ProjectWorkspaceIntent::SendInboxMessage {
                page_id: "page:large".into(),
                document_id: "document:large".into(),
                text: "Initial message".into(),
                title: None,
            },
        );
        // Scale is the subject: ordinary captured Pages may grow long after capture.
        workspace.kernel.writer().call(|connection| {
            let huge="界".repeat(1_000_000);
            connection.execute("UPDATE document_materializations SET nfm=?1,plain_text=?1 WHERE document_id='document:large'",[huge])?;
            for budget in [MAX_STREAM_BODY_BYTES,MAX_AGENT_BODY_BYTES] {
                let row=read_entry(connection,"page:large",budget)?;
                assert!(row.nfm.is_none(),"oversized NFM never crosses the SQL read boundary");
                assert!(row.plain_text.len()<=budget*4);assert!(row.source_body_truncated);
                let (body,truncated)=bounded_utf8(&message_body(&row),budget);
                assert!(truncated);assert!(body.len()<=budget);assert!(!body.is_empty());
                assert!(body.chars().all(|value|value=='界'));
            }
            Ok(())
        }).expect("bounded reads");
    }
}
