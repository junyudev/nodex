//! Bounded Inbox read models: the user's stream, the suggestion Agent's routing
//! context, and the Desktop Host's dispatch outbox.

use std::collections::HashMap;

use nodex_core_contracts::BoundModuleContext;
use nodex_core_contracts::collection::{
    CollectionWindow, CollectionWindowAuthority, CollectionWindowRequest,
};
use nodex_core_contracts::inbox::{
    ProjectWorkspaceInboxChat, ProjectWorkspaceInboxContextProject,
    ProjectWorkspaceInboxContextProposal, ProjectWorkspaceInboxContextSession,
    ProjectWorkspaceInboxCounts, ProjectWorkspaceInboxDispatchAction,
    ProjectWorkspaceInboxDispatchContext, ProjectWorkspaceInboxDispatchWork,
    ProjectWorkspaceInboxEntryState, ProjectWorkspaceInboxImportantMessage,
    ProjectWorkspaceInboxItem, ProjectWorkspaceInboxLocation, ProjectWorkspaceInboxMessageEdit,
    ProjectWorkspaceInboxPageBasis, ProjectWorkspaceInboxPageStatus,
    ProjectWorkspaceInboxProjectCount, ProjectWorkspaceInboxProposal,
    ProjectWorkspaceInboxProposalOrigin, ProjectWorkspaceInboxProposalState,
    ProjectWorkspaceInboxScope, ProjectWorkspaceInboxSource, ProjectWorkspaceInboxSuggestionInput,
    ProjectWorkspaceInboxSuggestionState, ProjectWorkspaceInboxSummary,
    ProjectWorkspaceInboxWindowFilter,
};
use nodex_core_contracts::workspace::{
    CodexThreadActiveFlag, CodexThreadStatusType, ProjectWorkspaceSessionExecutionRef,
    ProjectWorkspaceThreadStatus,
};
use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, OptionalExtension, params, params_from_iter};

use crate::infrastructure::collection_window::{WindowCandidate, assemble, normalize_request};
use crate::infrastructure::cursor::{
    self, CollectionCursorSubject, CursorDirection, KeysetCoordinate, KeysetValue,
};
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

use super::inbox::{
    MAX_PROPOSAL_PAGES, corrupt, invalid, parse_action, parse_kind, proposal_page_ids, scope_home,
    truncate_chars,
};

const MAX_STREAM_BODY_BYTES: usize = 8 * 1024;
const MAX_AGENT_BODY_BYTES: usize = 64 * 1024;
const MAX_CONTEXT_PROJECTS: i64 = 50;
const MAX_CONTEXT_SESSIONS: i64 = 30;
const MAX_CONTEXT_PROPOSALS: i64 = 20;
const MAX_CONTEXT_DESCRIPTION_CHARS: usize = 400;
const MAX_BATCH: u32 = 16;
const MAX_COUNTED_PROJECTS: i64 = 200;
const MAX_SUMMARY_IMPORTANT: i64 = 20;

/// The Project an Inbox scope names, validated, or None for the Library Inbox.
fn scope_project(scope: &ProjectWorkspaceInboxScope) -> Result<Option<&str>, StoreError> {
    let project_id = scope.project_id();
    if let Some(project_id) = project_id {
        super::session_mutation::validate_id("project_id", project_id)?;
    }
    Ok(project_id)
}

fn scope_of(project_id: Option<String>) -> ProjectWorkspaceInboxScope {
    match project_id {
        None => ProjectWorkspaceInboxScope::Library,
        Some(project_id) => ProjectWorkspaceInboxScope::Project { project_id },
    }
}

pub(super) fn read_summary(
    connection: &Connection,
    _context: &BoundModuleContext,
    library_id: &str,
    scope: &ProjectWorkspaceInboxScope,
) -> Result<ProjectWorkspaceInboxSummary, StoreError> {
    let project_id = scope_project(scope)?;
    let home = scope_home(connection, library_id, project_id)?;
    let (entry_count, inbox_count, needs_decision_count, pending_suggestion_count, important_count) =
        connection.query_row(
            &format!(
                "SELECT count(*), \
                   COALESCE(SUM({IN_INBOX}), 0), \
                   COALESCE(SUM(entry.state = 'open' AND proposal.state = 'open'), 0), \
                   COALESCE(SUM(entry.state = 'open' AND entry.suggestion_state IN ('waiting','pending') AND entry.source_kind <> 'scheduled_task'), 0), \
                   COALESCE(SUM(entry.important = 1 AND {IN_INBOX}), 0) \
                 FROM inbox_entries entry \
                 JOIN blocks block ON block.id = entry.page_id AND block.lifecycle = 'active' \
                 LEFT JOIN inbox_proposals proposal \
                   ON proposal.proposal_id = entry.current_proposal_id \
                 WHERE entry.library_id = ?1 AND entry.scope_project_id IS ?2"
            ),
            params![library_id, project_id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            },
        )?;
    let important = connection
        .prepare(&format!(
            "SELECT entry.page_id, COALESCE(materialization.title, ''), entry.submitted_at \
             FROM inbox_entries entry \
             JOIN blocks block ON block.id = entry.page_id AND block.lifecycle = 'active' \
             JOIN pages page ON page.block_id = entry.page_id \
             LEFT JOIN document_materializations materialization \
               ON materialization.document_id = page.document_id \
             LEFT JOIN inbox_proposals proposal \
               ON proposal.proposal_id = entry.current_proposal_id \
             WHERE entry.library_id = ?1 AND entry.scope_project_id IS ?2 \
               AND entry.important = 1 AND {IN_INBOX} \
             ORDER BY entry.seq ASC LIMIT ?3"
        ))?
        .query_map(
            params![library_id, project_id, MAX_SUMMARY_IMPORTANT],
            |row| {
                Ok(ProjectWorkspaceInboxImportantMessage {
                    page_id: row.get(0)?,
                    title: row.get(1)?,
                    submitted_at: row.get(2)?,
                })
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let dispatching_count = connection.query_row(
        "SELECT count(DISTINCT proposal.proposal_id) FROM inbox_proposals proposal \
         JOIN inbox_proposal_pages link ON link.proposal_id = proposal.proposal_id \
         JOIN inbox_entries entry ON entry.page_id = link.page_id \
         WHERE proposal.library_id = ?1 AND proposal.state = 'dispatching' AND COALESCE(proposal.failure_kind,'') <> 'unknown' \
           AND entry.scope_project_id IS ?2",
        params![library_id, project_id],
        |row| row.get::<_, i64>(0),
    )?;
    Ok(ProjectWorkspaceInboxSummary {
        database_id: home.as_ref().map(|home| home.database_id.clone()),
        view_id: home.map(|home| home.view_id),
        entry_count: count(entry_count)?,
        inbox_count: count(inbox_count)?,
        needs_decision_count: count(needs_decision_count)?,
        pending_suggestion_count: count(pending_suggestion_count)?,
        dispatching_count: count(dispatching_count)?,
        important_count: count(important_count)?,
        important,
    })
}

/// A message stays in its Inbox until the user handles it. A confirmed chat dispatch,
/// filing it into a Project, Keep, and Done all handle it; a failed dispatch brings it
/// back. Where the Page lives does not matter. Never NULL.
pub(super) const IN_INBOX: &str = "(entry.state = 'open' \
    AND NOT (COALESCE(proposal.state, '') = 'dispatching' AND COALESCE(proposal.failure_kind,'') <> 'unknown') \
    AND NOT (COALESCE(proposal.state, '') = 'completed' \
      AND COALESCE(json_extract(proposal.action_json, '$.type'), '') \
        IN ('new_chat', 'send_to_chat', 'run_task')))";

/// Messages still waiting in the Library Inbox and in each active Project's Inbox.
pub(super) fn read_counts(
    connection: &Connection,
    _context: &BoundModuleContext,
    library_id: &str,
) -> Result<ProjectWorkspaceInboxCounts, StoreError> {
    let rows = connection
        .prepare(&format!(
            "SELECT entry.scope_project_id, COALESCE(SUM({IN_INBOX}), 0) AS waiting \
             FROM inbox_entries entry \
             JOIN blocks block ON block.id = entry.page_id AND block.lifecycle = 'active' \
             LEFT JOIN inbox_proposals proposal ON proposal.proposal_id = entry.current_proposal_id \
             LEFT JOIN projects project ON project.id = entry.scope_project_id \
             WHERE entry.library_id = ?1 \
               AND (entry.scope_project_id IS NULL OR project.lifecycle = 'active') \
             GROUP BY entry.scope_project_id HAVING waiting > 0 \
             ORDER BY entry.scope_project_id IS NOT NULL, entry.scope_project_id LIMIT ?2"
        ))?
        .query_map(params![library_id, MAX_COUNTED_PROJECTS + 1], |row| {
            Ok((row.get::<_, Option<String>>(0)?, row.get::<_, i64>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut counts = ProjectWorkspaceInboxCounts {
        library_count: 0,
        projects: Vec::new(),
    };
    for (project_id, waiting) in rows {
        match project_id {
            None => counts.library_count = count(waiting)?,
            Some(project_id) => counts.projects.push(ProjectWorkspaceInboxProjectCount {
                project_id,
                inbox_count: count(waiting)?,
            }),
        }
    }
    Ok(counts)
}

fn filter_predicate(filter: ProjectWorkspaceInboxWindowFilter) -> String {
    match filter {
        ProjectWorkspaceInboxWindowFilter::Inbox => IN_INBOX.to_owned(),
        ProjectWorkspaceInboxWindowFilter::Processed => format!("NOT {IN_INBOX}"),
    }
}

/// One pinned read shares content evidence and resolved advice across every group member.
#[derive(Default)]
struct InboxReadCache {
    bases: HashMap<String, ProjectWorkspaceInboxPageBasis>,
    proposals: HashMap<String, Option<ProjectWorkspaceInboxProposal>>,
}

impl InboxReadCache {
    fn basis(
        &mut self,
        connection: &Connection,
        page_id: &str,
    ) -> Result<ProjectWorkspaceInboxPageBasis, StoreError> {
        if let Some(basis) = self.bases.get(page_id) {
            return Ok(basis.clone());
        }
        let basis = message_basis(connection, page_id)?;
        self.bases.insert(page_id.to_owned(), basis.clone());
        Ok(basis)
    }

    fn proposal(
        &mut self,
        connection: &Connection,
        library_id: &str,
        proposal_id: &str,
    ) -> Result<Option<ProjectWorkspaceInboxProposal>, StoreError> {
        if let Some(proposal) = self.proposals.get(proposal_id) {
            return Ok(proposal.clone());
        }
        let proposal = read_proposal(connection, library_id, proposal_id, self)?;
        self.proposals
            .insert(proposal_id.to_owned(), proposal.clone());
        Ok(proposal)
    }
}

/// Newest-first stream window ordered by submission sequence.
pub(super) fn read_window(
    connection: &Connection,
    _context: &BoundModuleContext,
    library_id: &str,
    commit_head: i64,
    scope: &ProjectWorkspaceInboxScope,
    filter: ProjectWorkspaceInboxWindowFilter,
    request: &CollectionWindowRequest,
) -> Result<CollectionWindow<ProjectWorkspaceInboxItem>, StoreError> {
    let project_id = scope_project(scope)?;
    let normalized = normalize_request(request)?;
    let fingerprint = cursor::query_fingerprint(&("workspace_inbox_window_v2", scope, filter))?;
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
    let home = scope_home(connection, library_id, project_id)?;
    let mut parameters = vec![
        SqlValue::Text(library_id.to_owned()),
        project_id.map_or(SqlValue::Null, |project_id| {
            SqlValue::Text(project_id.to_owned())
        }),
    ];
    let cursor_predicate = match after {
        Some(seq) => {
            parameters.push(SqlValue::Integer(seq));
            "AND entry.seq < ?3"
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
         WHERE entry.library_id = ?1 AND entry.scope_project_id IS ?2 AND {} {cursor_predicate} \
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
    let mut cache = InboxReadCache::default();
    for page_id in page_ids {
        let (item, seq) = read_item(connection, library_id, home.as_ref(), &page_id, &mut cache)?;
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
    page_status: Option<ProjectWorkspaceInboxPageStatus>,
    seq: i64,
    submitted_at: String,
    source_kind: String,
    source_session_id: Option<String>,
    source_thread_id: Option<String>,
    source_run_id: Option<String>,
    source_project_id: Option<String>,
    source_label: Option<String>,
    source_automation_id: Option<String>,
    source_dispatch_id: Option<String>,
    provisional_title: Option<String>,
    kind: Option<String>,
    state: String,
    suggestion_state: String,
    suggestion_error: Option<String>,
    current_proposal_id: Option<String>,
    scope_project_id: Option<String>,
    revision: i64,
    parent_kind: String,
    parent_id: String,
    title: String,
    markdown: Option<String>,
    source_body_truncated: bool,
    plain_text: String,
}

/// Admit a small complete Markdown or bounded text prefix in SQLite before decoding.
/// Byte lengths read column metadata; oversized documents never enter the Markdown parser.
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
               COALESCE(materialization.title, ''), CASE WHEN octet_length(materialization.markdown) <= ?2 \
                 THEN materialization.markdown ELSE NULL END, \
               substr(COALESCE(materialization.plain_text, ''),1,?3), document.generation, document.head_seq, \
               entry.provisional_title, entry.source_turn_id, \
               COALESCE(octet_length(materialization.plain_text),0) > ?3, entry.scope_project_id, (SELECT placement_revision FROM blocks WHERE id=entry.page_id), entry.source_automation_id, entry.source_dispatch_id, \
               json_extract(status_option.value, '$.id'), json_extract(status_option.value, '$.name') \
             FROM inbox_entries entry \
             JOIN pages page ON page.block_id = entry.page_id \
             JOIN documents document ON document.id = page.document_id \
             LEFT JOIN document_materializations materialization \
               ON materialization.document_id = page.document_id \
             LEFT JOIN data_source_page_memberships membership \
               ON page.parent_kind = 'data_source' AND membership.data_source_id = page.parent_id \
              AND membership.page_block_id = page.block_id AND membership.removed_at IS NULL \
             LEFT JOIN data_source_properties status_property \
               ON status_property.data_source_id = membership.data_source_id \
              AND status_property.id = ?4 AND status_property.lifecycle = 'active' \
              AND status_property.value_type = 'select' \
             LEFT JOIN data_source_property_values status_value \
               ON status_value.data_source_id = status_property.data_source_id \
              AND status_value.membership_id = membership.id AND status_value.property_id = status_property.id \
             LEFT JOIN json_each(status_property.config_json, '$.options') status_option \
               ON json_extract(status_option.value, '$.id') = json_extract(status_value.value_json, '$') \
             WHERE entry.page_id = ?1",
            params![
                page_id,
                (body_budget * 8) as i64,
                body_budget as i64,
                crate::database::property_semantics::STATUS_PROPERTY_ID,
            ],
            |row| {
                Ok(EntryRow {
                    source_automation_id: row.get(25)?,
                    source_dispatch_id: row.get(26)?,
                    page_status: row.get::<_, Option<String>>(27)?.zip(row.get(28)?).map(
                        |(id, label)| ProjectWorkspaceInboxPageStatus { id, label },
                    ),
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
                    scope_project_id: row.get(23)?,
                    revision: row.get(12)?,
                    parent_kind: row.get(13)?,
                    parent_id: row.get(14)?,
                    title: row.get(15)?,
                    markdown: row.get(16)?,
                    plain_text: row.get(17)?,
                })
            },
        )
        .optional()?
        .ok_or_else(|| corrupt("Inbox entry Page disappeared during the read"))
}

/// Prepares a user's rewrite of a message: the same rules as sending it, fenced by the
/// body the user started from and the Page state that body was read at.
pub(super) fn read_message_edit(
    connection: &Connection,
    _context: &BoundModuleContext,
    library_id: &str,
    page_id: &str,
    original_body: &str,
    body: &str,
) -> Result<ProjectWorkspaceInboxMessageEdit, StoreError> {
    super::inbox::require_waiting_entry(connection, library_id, page_id)?;
    let row = read_entry(connection, page_id, MAX_STREAM_BODY_BYTES)?;
    let current = editable_body(&row).ok_or_else(|| {
        StoreError::new(
            StoreErrorCode::Conflict,
            "This message has richer content now; edit it as its Page",
            false,
        )
    })?;
    // The rewrite started from the stored body, so it compares as Nodex Markdown, not as
    // message text.
    let original = crate::domain::markdown::parse_markdown(original_body)
        .ok()
        .map(|blocks| crate::domain::markdown::serialize_markdown(&blocks));
    if original.is_none_or(|original| original != current) {
        return Err(StoreError::new(
            StoreErrorCode::RevisionConflict,
            "This message changed while you were editing it",
            true,
        ));
    }
    let next = super::inbox::message_body(body)?;
    let changed = next.markdown != current;
    let provisional = row.provisional_title.as_deref() == Some(row.title.as_str());
    let title_markdown = changed
        .then(|| super::inbox::provisional_title(&next.title_text))
        .filter(|excerpt| provisional && *excerpt != row.title)
        .map(|excerpt| super::inbox::title_markdown(&excerpt));
    Ok(ProjectWorkspaceInboxMessageEdit {
        basis: message_basis(connection, page_id)?,
        body_markdown: changed.then_some(next.markdown),
        title_markdown,
    })
}

/// The Page body while the stream shows it whole and it still has the message shape;
/// otherwise the message is edited as its Page.
fn editable_body(row: &EntryRow) -> Option<String> {
    let markdown = row
        .markdown
        .as_deref()
        .filter(|_| !row.source_body_truncated)?;
    let blocks = crate::domain::markdown::parse_markdown(markdown).ok()?;
    super::inbox::has_message_shape(&blocks)
        .then(|| crate::domain::markdown::serialize_markdown(&blocks))
}

/// The message as the stream shows it, in Nodex Markdown: the Page body when it fits
/// the stream budget, otherwise the opening of its text as plain paragraphs.
fn stream_body(row: &EntryRow) -> (String, bool) {
    if let Some(markdown) = row
        .markdown
        .as_deref()
        .filter(|_| !row.source_body_truncated)
    {
        return (markdown.to_owned(), false);
    }
    let (text, _) = bounded_utf8(&row.plain_text, MAX_STREAM_BODY_BYTES);
    (super::inbox::text_paragraphs_markdown(&text), true)
}

/// The message's text, one line per Block, for the suggestion Agent.
fn message_text(row: &EntryRow) -> String {
    let Some(markdown) = &row.markdown else {
        return row.plain_text.clone();
    };
    crate::domain::markdown::parse_markdown(markdown)
        .map(|blocks| crate::domain::markdown::extract_block_lines(&blocks))
        .unwrap_or_else(|_| row.plain_text.clone())
}

#[cfg(test)]
thread_local! {
    static MESSAGE_BASIS_COMPUTATIONS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
pub(super) fn take_message_basis_computations() -> usize {
    MESSAGE_BASIS_COMPUTATIONS.with(|count| count.replace(0))
}

/// Synchronous content evidence: bounded Markdown parsing matches suggestion_input; oversized
/// Pages hash their complete text even though they cannot be sent to the suggestion Agent.
pub(crate) fn message_basis(
    connection: &Connection,
    page_id: &str,
) -> Result<ProjectWorkspaceInboxPageBasis, StoreError> {
    #[cfg(test)]
    MESSAGE_BASIS_COMPUTATIONS.with(|count| count.set(count.get() + 1));
    let mut row = read_entry(connection, page_id, MAX_AGENT_BODY_BYTES)?;
    if row.source_body_truncated {
        row.plain_text = connection.query_row(
            "SELECT COALESCE(materialization.plain_text,'') FROM pages page LEFT JOIN document_materializations materialization ON materialization.document_id=page.document_id WHERE page.block_id=?1",
            [page_id],
            |row| row.get(0),
        )?;
    }
    Ok(ProjectWorkspaceInboxPageBasis {
        page_id: page_id.to_owned(),
        content_hash: crate::document::sha256(message_text(&row).as_bytes()),
    })
}

/// Freeze model-visible text at the reviewed Document head. Images remain on the Page.
pub(super) fn frozen_message_text(
    connection: &Connection,
    page_id: &str,
) -> Result<String, StoreError> {
    let row = read_entry(connection, page_id, 1024 * 1024)?;
    if row.source_body_truncated {
        return Err(invalid(
            "The complete message exceeds the scheduled prompt limit",
        ));
    }
    Ok(message_text(&row))
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
        "scheduled_task" => ProjectWorkspaceInboxSource::ScheduledTask {
            automation_id: row.source_automation_id.clone().unwrap_or_default(),
            dispatch_id: row.source_dispatch_id.clone().unwrap_or_default(),
            project_id: row.source_project_id.clone(),
            label: row.source_label.clone().unwrap_or_default(),
        },
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

/// `home` is the Database of the Inbox the message belongs to.
fn read_item(
    connection: &Connection,
    library_id: &str,
    home: Option<&super::inbox::InboxHome>,
    page_id: &str,
    cache: &mut InboxReadCache,
) -> Result<(ProjectWorkspaceInboxItem, i64), StoreError> {
    let row = read_entry(connection, page_id, MAX_STREAM_BODY_BYTES)?;
    let (body, body_truncated) = stream_body(&row);
    let location = location(connection, home, &row)?;
    let proposal = row
        .current_proposal_id
        .as_deref()
        .map(|proposal_id| cache.proposal(connection, library_id, proposal_id))
        .transpose()?
        .flatten();
    Ok((
        ProjectWorkspaceInboxItem {
            basis: cache.basis(connection, page_id)?,
            outcome: connection
                .query_row(
                    "SELECT outcome FROM inbox_entries WHERE page_id=?1",
                    [page_id],
                    |row| row.get::<_, Option<String>>(0),
                )?
                .map(|value| {
                    serde_json::from_value(serde_json::Value::String(value))
                        .map_err(|_| corrupt("Invalid Inbox outcome"))
                })
                .transpose()?,
            page_id: page_id.to_owned(),
            page_key: crate::database::current_page_key_for_page(connection, library_id, page_id)?,
            page_status: row.page_status.clone(),
            title: row.title.clone(),
            body_editable: !body_truncated && editable_body(&row).is_some(),
            body,
            body_truncated,
            submitted_at: row.submitted_at.clone(),
            source: source(&row),
            kind: parse_kind(row.kind.as_deref())?,
            important: connection.query_row(
                "SELECT important FROM inbox_entries WHERE page_id=?1",
                [page_id],
                |row| row.get::<_, bool>(0),
            )?,
            state: parse_state(&row.state)?,
            suggestion_state: parse_suggestion_state(&row.suggestion_state)?,
            suggestion_error: row.suggestion_error.clone(),
            scope: scope_of(row.scope_project_id.clone()),
            location,
            proposal,
            firing: crate::automation::firing::item(connection, page_id)?,
            revision: row.revision,
        },
        row.seq,
    ))
}

fn location(
    connection: &Connection,
    home: Option<&super::inbox::InboxHome>,
    row: &EntryRow,
) -> Result<ProjectWorkspaceInboxLocation, StoreError> {
    if row.parent_kind != "data_source" {
        return Ok(ProjectWorkspaceInboxLocation::Other);
    }
    if home.is_some_and(|home| home.data_source_id == row.parent_id) {
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
    cache: &mut InboxReadCache,
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
    let task_target = match &action {
        ProjectWorkspaceInboxDispatchAction::RunTask { automation_id, .. } => connection
            .query_row(
                "SELECT kind, project_id, target_session_id FROM codex_scheduled_automations WHERE automation_id=?1",
                [automation_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?, row.get::<_, Option<String>>(2)?)),
            )
            .optional()?,
        _ => None,
    };
    let target_project_id = match &action {
        ProjectWorkspaceInboxDispatchAction::NewChat { project_id, .. } => project_id.clone(),
        ProjectWorkspaceInboxDispatchAction::MoveToProject { project_id } => {
            Some(project_id.clone())
        }
        ProjectWorkspaceInboxDispatchAction::RunTask { .. } => task_target
            .as_ref()
            .filter(|(kind, ..)| kind == "cron")
            .and_then(|(_, project_id, _)| project_id.clone()),
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
    let dispatch_session_id = if let ProjectWorkspaceInboxDispatchAction::RunTask {
        dispatch_id,
        ..
    } = &action
    {
        match task_target.as_ref() {
            Some((kind, _, session_id)) if kind == "heartbeat" => session_id.clone(),
            _ => connection.query_row("SELECT session_id FROM core_automation_runs WHERE dispatch_id=?1 AND session_id IS NOT NULL ORDER BY created_at,run_id LIMIT 1",[dispatch_id],|r|r.get::<_,String>(0)).optional()?,
        }
    } else {
        dispatch_session_id
    };
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
    let written = super::inbox::require_proposal(connection, library_id, proposal_id)?;
    let basis = written
        .page_ids
        .iter()
        .map(|page| cache.basis(connection, page))
        .collect::<Result<Vec<_>, _>>()?;
    let outdated = basis.iter().any(|current| !written.basis.contains(current));
    Ok(Some(ProjectWorkspaceInboxProposal {
        failure_kind: connection
            .query_row(
                "SELECT failure_kind FROM inbox_proposals WHERE proposal_id=?1",
                [proposal_id],
                |r| r.get::<_, Option<String>>(0),
            )?
            .map(|v| {
                serde_json::from_value(serde_json::Value::String(v))
                    .map_err(|_| corrupt("Invalid failure kind"))
            })
            .transpose()?,
        basis,
        outdated,
        proposal_id: proposal_id.to_owned(),
        revision,
        origin: if origin == "schedule" {
            ProjectWorkspaceInboxProposalOrigin::Schedule
        } else if origin == "user" {
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
               thread.status_type, thread.status_active_flags_json, session.unread, session.archived, \
               binding.runtime_id \
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
                let execution_ref = row
                    .get::<_, Option<String>>(11)?
                    .zip(thread_id.clone())
                    .map(|(runtime_id, thread_id)| ProjectWorkspaceSessionExecutionRef {
                        runtime_id,
                        thread_id,
                    });
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
                    execution_ref,
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

/// Open entries waiting for a suggestion, oldest first, from the Inbox of the oldest
/// one only, so one suggestion pass never routes across Inboxes.
pub(super) fn read_pending_suggestions(
    connection: &Connection,
    _context: &BoundModuleContext,
    library_id: &str,
    limit: u32,
) -> Result<Vec<ProjectWorkspaceInboxSuggestionInput>, StoreError> {
    let limit = i64::from(limit.clamp(1, MAX_BATCH));
    let page_ids = connection
        .prepare(
            "WITH waiting AS (\
               SELECT entry.page_id, entry.seq, entry.scope_project_id FROM inbox_entries entry \
               JOIN blocks block ON block.id = entry.page_id AND block.lifecycle = 'active' \
               WHERE entry.library_id = ?1 AND entry.state = 'open' \
                 AND entry.suggestion_state IN ('waiting','pending') AND entry.source_kind <> 'scheduled_task'), \
             oldest AS (SELECT scope_project_id FROM waiting ORDER BY seq LIMIT 1) \
             SELECT waiting.page_id FROM waiting, oldest \
             WHERE waiting.scope_project_id IS oldest.scope_project_id \
             ORDER BY waiting.seq LIMIT ?2",
        )?
        .query_map(params![library_id, limit], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    page_ids
        .iter()
        .map(|page_id| suggestion_input(connection, library_id, page_id))
        .collect()
}

pub(super) fn suggestion_input(
    connection: &Connection,
    library_id: &str,
    page_id: &str,
) -> Result<ProjectWorkspaceInboxSuggestionInput, StoreError> {
    let row = read_entry(connection, page_id, MAX_AGENT_BODY_BYTES)?;
    let full_body = message_text(&row);
    if row.source_body_truncated || full_body.len() > MAX_AGENT_BODY_BYTES {
        return Err(invalid("Inbox input exceeds the complete 64 KiB bound"));
    }
    let body = full_body;
    let basis = ProjectWorkspaceInboxPageBasis {
        page_id: page_id.to_owned(),
        content_hash: crate::document::sha256(body.as_bytes()),
    };
    Ok(ProjectWorkspaceInboxSuggestionInput {
        page_id: page_id.to_owned(),
        page_key: crate::database::current_page_key_for_page(connection, library_id, page_id)?,
        title: row.title.clone(),
        body,
        source: source(&row),
        kind: parse_kind(row.kind.as_deref())?,
        submitted_at: row.submitted_at.clone(),
        scope: scope_of(row.scope_project_id.clone()),
        basis,
        // Any rename, by the user or by an earlier suggestion, makes the title theirs.
        title_provisional: row.provisional_title.as_deref() == Some(row.title.as_str()),
    })
}

/// The Library images of a message's Page as it is now, for a chat that receives it.
pub(super) fn message_image_sources(
    connection: &Connection,
    page_id: &str,
    sources: &mut Vec<String>,
) -> Result<(), StoreError> {
    let row = read_entry(connection, page_id, MAX_AGENT_BODY_BYTES)?;
    if let Some(blocks) = row
        .markdown
        .as_deref()
        .and_then(|markdown| crate::domain::markdown::parse_markdown(markdown).ok())
    {
        super::inbox::collect_image_sources(&blocks, sources);
    }
    Ok(())
}

/// Small lexical hints let related older chats compete with recent activity. This does
/// not read transcripts or add a second search authority to Inbox.
fn context_search_terms(entries: &[ProjectWorkspaceInboxSuggestionInput]) -> Vec<String> {
    let mut terms = Vec::new();
    for entry in entries {
        let text = format!(
            "{} {}",
            entry.title,
            entry.body.chars().take(4096).collect::<String>()
        )
        .to_lowercase();
        for word in text.split(|ch: char| !ch.is_alphanumeric()) {
            let chars = word.chars().collect::<Vec<_>>();
            if chars.len() < 3 {
                continue;
            }
            let candidates = if chars
                .iter()
                .all(|ch| ('\u{3400}'..='\u{9fff}').contains(ch))
            {
                chars
                    .windows(2)
                    .map(|pair| pair.iter().collect())
                    .collect::<Vec<String>>()
            } else if chars.len() <= 64 {
                vec![word.to_owned()]
            } else {
                vec![]
            };
            for term in candidates {
                if !terms.contains(&term) {
                    terms.push(term);
                }
                if terms.len() == 24 {
                    return terms;
                }
            }
        }
    }
    terms
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
    dispatch_context_for_inputs(connection, library_id, entries)
}

/// Message inputs are immutable request evidence; routing targets remain live.
pub(super) fn dispatch_context_for_inputs(
    connection: &Connection,
    library_id: &str,
    entries: Vec<ProjectWorkspaceInboxSuggestionInput>,
) -> Result<ProjectWorkspaceInboxDispatchContext, StoreError> {
    let scope = entries
        .first()
        .map(|entry| entry.scope.clone())
        .unwrap_or(ProjectWorkspaceInboxScope::Library);
    if entries.iter().any(|entry| entry.scope != scope) {
        return Err(invalid(
            "Messages from different Inboxes cannot be routed together",
        ));
    }
    // A Project's Inbox routes only inside its Project.
    let project_id = scope.project_id();
    let projects = connection
        .prepare(
            "SELECT project.id, project.name, substr(project.description,1,400) FROM projects project \
             LEFT JOIN project_order ordering ON ordering.project_id = project.id \
             WHERE project.library_id = ?1 AND project.lifecycle = 'active' \
               AND (?3 IS NULL OR project.id = ?3) \
             ORDER BY COALESCE(ordering.\"order\", 0), project.id LIMIT ?2",
        )?
        .query_map(
            params![library_id, MAX_CONTEXT_PROJECTS, project_id],
            |row| {
                Ok(ProjectWorkspaceInboxContextProject {
                    project_id: row.get(0)?,
                    name: row.get(1)?,
                    description: truncate_chars(
                        row.get::<_, String>(2)?.trim(),
                        MAX_CONTEXT_DESCRIPTION_CHARS,
                    ),
                })
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let terms = serde_json::to_string(&context_search_terms(&entries))
        .map_err(|_| corrupt("Inbox context terms cannot be encoded"))?;
    let sessions = connection
        .prepare(
            "SELECT session.id, session.project_id, thread.thread_name, \
               substr(COALESCE(thread.thread_preview, ''),1,240), session.no_thread_fallback_title, \
               thread.status_type, thread.status_active_flags_json, \
               COALESCE(thread.recency_at,unixepoch(session.updated_at)*1000), \
               (SELECT count(*) FROM json_each(?4) term WHERE instr(lower( \
                 COALESCE(thread.thread_name,'') || ' ' || session.no_thread_fallback_title || ' ' || \
                 substr(COALESCE(thread.thread_preview,''),1,4000)),term.value)>0) AS relevance \
             FROM project_sessions session \
             LEFT JOIN project_session_execution_bindings binding ON binding.session_id=session.id \
             LEFT JOIN project_session_threads link ON link.session_id = session.id \
             LEFT JOIN codex_threads thread ON thread.thread_id = link.thread_id \
             LEFT JOIN projects project ON project.id = session.project_id \
             WHERE session.archived = 0 AND COALESCE(thread.archived, 0) = 0 \
               AND (binding.runtime_thread_id IS NOT NULL OR thread.thread_id IS NOT NULL) \
               AND (session.project_id IS NULL OR (project.library_id = ?1 \
                 AND project.lifecycle = 'active')) \
               AND (?3 IS NULL OR session.project_id = ?3) \
             ORDER BY relevance DESC, COALESCE(thread.recency_at,unixepoch(session.updated_at)*1000) DESC, session.id LIMIT ?2",
        )?
        .query_map(
            params![library_id, MAX_CONTEXT_SESSIONS, project_id, terms],
            |row| {
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
                    status: row
                        .get::<_, Option<String>>(5)?
                        .map(|status_type| thread_status(&status_type, &row.get::<_, String>(6)?))
                        .transpose()?,
                    recency_at: row.get(7)?,
                })
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let proposal_rows = connection
        .prepare(
            "SELECT proposal.proposal_id, proposal.action_json, proposal.summary \
             FROM inbox_proposals proposal \
             WHERE proposal.library_id = ?1 AND proposal.state = 'open' \
               AND EXISTS (SELECT 1 FROM inbox_proposal_pages link \
                 JOIN inbox_entries entry ON entry.page_id = link.page_id \
                 WHERE link.proposal_id = proposal.proposal_id \
                   AND entry.scope_project_id IS ?3) \
             ORDER BY proposal.created_at DESC, proposal.proposal_id LIMIT ?2",
        )?
        .query_map(
            params![library_id, MAX_CONTEXT_PROPOSALS, project_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )?
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
        scope,
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
               COALESCE(proposal.dispatch_thread_id,binding.runtime_thread_id,link.thread_id), proposal.attempt, \
               proposal.confirmed_at, thread.status_type, thread.status_active_flags_json, \
               thread.agent_backend_kind \
             FROM inbox_proposals proposal \
             LEFT JOIN project_sessions session ON session.id = proposal.dispatch_session_id \
             LEFT JOIN project_session_execution_bindings binding ON binding.session_id=proposal.dispatch_session_id \
             LEFT JOIN project_session_threads link ON link.session_id = proposal.dispatch_session_id \
             LEFT JOIN codex_threads thread \
               ON thread.thread_id = COALESCE(link.thread_id, proposal.dispatch_thread_id) \
             WHERE proposal.library_id = ?1 AND proposal.state = 'dispatching' AND COALESCE(proposal.failure_kind,'') <> 'unknown' \
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
    let mut encoded_bytes = 0;
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
        let item = ProjectWorkspaceInboxDispatchWork {
            final_text: connection
                .query_row(
                    "SELECT final_text FROM inbox_handoffs WHERE proposal_id=?1",
                    [&proposal_id],
                    |row| row.get(0),
                )
                .optional()?,
            image_sources: super::inbox::reliable::read_handoff_json(
                connection,
                &proposal_id,
                "image_sources_json",
            )?
            .unwrap_or_default(),
            launch_id: super::inbox::reliable::stored_handoff_identity(
                connection,
                &proposal_id,
                "launch",
            )?,
            message_id: super::inbox::reliable::stored_handoff_identity(
                connection,
                &proposal_id,
                "message",
            )?,
            execution_selection: super::inbox::reliable::read_handoff_json(
                connection,
                &proposal_id,
                "execution_selection_json",
            )?,
            target_execution_ref: super::inbox::reliable::read_handoff_json(
                connection,
                &proposal_id,
                "target_execution_ref_json",
            )?,
            failure_kind: connection
                .query_row(
                    "SELECT failure_kind FROM inbox_proposals WHERE proposal_id=?1",
                    [&proposal_id],
                    |row| row.get::<_, Option<String>>(0),
                )?
                .map(|value| {
                    serde_json::from_value(serde_json::Value::String(value))
                        .map_err(|_| corrupt("Invalid Inbox failure kind"))
                })
                .transpose()?,
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
        };
        let bytes = serde_json::to_vec(&item)
            .map_err(|_| corrupt("Inbox delivery cannot be encoded"))?
            .len();
        if !work.is_empty() && encoded_bytes + bytes > 12 * 1024 * 1024 {
            break;
        }
        encoded_bytes += bytes;
        work.push(item);
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
        "none" => Ok(ProjectWorkspaceInboxSuggestionState::None),
        "waiting" => Ok(ProjectWorkspaceInboxSuggestionState::Waiting),
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

/// Search the complete eligible Session collection before applying the cursor window.
pub(super) fn read_chat_targets(
    connection: &Connection,
    library_id: &str,
    commit_head: i64,
    scope: &ProjectWorkspaceInboxScope,
    query: &str,
    request: &CollectionWindowRequest,
) -> Result<CollectionWindow<ProjectWorkspaceInboxChat>, StoreError> {
    let project_id = scope_project(scope)?;
    if query.len() > 512 {
        return Err(invalid("Chat search is too long"));
    }
    let query = query.trim().to_lowercase();
    let normalized = normalize_request(request)?;
    let fingerprint = cursor::query_fingerprint(&("inbox_chat_targets_v1", scope, &query))?;
    let subject = CollectionCursorSubject {
        kind: "inbox_chat_targets",
        library_id,
        query_fingerprint: &fingerprint,
    };
    let after = normalized
        .after
        .map(|value| cursor::decode(connection, value, subject))
        .transpose()?
        .map(|(direction, coordinate)| {
            if direction != CursorDirection::Forward || !coordinate.values.is_empty() {
                return Err(invalid("Chat cursor is incompatible"));
            }
            Ok(coordinate.stable_id)
        })
        .transpose()?;
    let rows=connection.prepare("SELECT session.id FROM project_sessions session LEFT JOIN projects project ON project.id=session.project_id LEFT JOIN project_session_execution_bindings binding ON binding.session_id=session.id LEFT JOIN project_session_threads link ON link.session_id=session.id LEFT JOIN codex_threads thread ON thread.thread_id=link.thread_id WHERE NOT EXISTS (SELECT 1 FROM project_session_side_chats side WHERE side.session_id=session.id) AND session.archived=0 AND (session.project_id IS NULL OR (project.library_id=?1 AND project.lifecycle='active')) AND (?2 IS NULL OR session.project_id=?2) AND (binding.runtime_thread_id IS NOT NULL OR thread.thread_id IS NOT NULL) AND (?3='' OR instr(lower(COALESCE(thread.thread_name,'') || ' ' || session.no_thread_fallback_title || ' ' || COALESCE(thread.thread_preview,'')),?3)>0) AND (?4 IS NULL OR session.id>?4) ORDER BY session.id LIMIT ?5")?.query_map(params![library_id,project_id,query,after,normalized.first as i64+1],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    let candidates = rows
        .into_iter()
        .map(|id| {
            Ok(WindowCandidate {
                coordinate: KeysetCoordinate {
                    values: Vec::new(),
                    stable_id: id.clone(),
                },
                item: read_chat(connection, library_id, &id)?
                    .ok_or_else(|| corrupt("Chat disappeared during read"))?,
            })
        })
        .collect::<Result<Vec<_>, StoreError>>()?;
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
                expected_store_epoch: None,
                page_id: "page:large".into(),
                document_id: "document:large".into(),
                body: "Initial message".into(),
                title: None,
                project_id: None,
            },
        );
        // Scale is the subject: ordinary captured Pages may grow long after capture.
        workspace.kernel.writer().call(|connection| {
            let huge="界".repeat(1_000_000);
            connection.execute("UPDATE document_materializations SET markdown=?1,plain_text=?1 WHERE document_id='document:large'",[huge])?;
            let fingerprint=message_basis(connection,"page:large")?;
            assert_eq!(fingerprint.content_hash,crate::document::sha256("界".repeat(1_000_000).as_bytes()));
            assert!(suggestion_input(connection,"library-1","page:large").is_err());
            connection.execute("UPDATE document_materializations SET markdown=markdown || 'changed',plain_text=plain_text || 'changed' WHERE document_id='document:large'",[])?;
            assert_ne!(message_basis(connection,"page:large")?,fingerprint);
            connection.execute("UPDATE document_materializations SET markdown=substr(markdown,1,1000000),plain_text=substr(plain_text,1,1000000) WHERE document_id='document:large'",[])?;
            for budget in [MAX_STREAM_BODY_BYTES,MAX_AGENT_BODY_BYTES] {
                let row=read_entry(connection,"page:large",budget)?;
                assert!(row.markdown.is_none(),"oversized Markdown never crosses the SQL read boundary");
                assert!(row.plain_text.len()<=budget*4);assert!(row.source_body_truncated);
                let (body,truncated)=bounded_utf8(&message_text(&row),budget);
                assert!(truncated);assert!(body.len()<=budget);assert!(!body.is_empty());
                assert!(body.chars().all(|value|value=='界'));
            }
            Ok(())
        }).expect("bounded reads");
    }
}
