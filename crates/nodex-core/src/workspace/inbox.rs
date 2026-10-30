//! Inbox capture and dispatch authority.
//!
//! Every Inbox message is an ordinary Page. The Library Inbox keeps its Pages in the
//! Library's Inbox Database; a Project's Inbox keeps them in the Project's own
//! Database. Which Inbox owns a message's decision is fixed at capture and recorded
//! on the entry, never derived from where the Page lives now. The Workspace owns the
//! entry provenance, triage state, and dispatch proposals beside it. A proposal is advice: only `ConfirmInboxDispatch` or
//! `DispatchInboxEntries` can turn it into dispatch work, and confirmed chat
//! work is delivered by the Desktop Host through the dispatch outbox.

#[path = "inbox_reliable.rs"]
pub(super) mod reliable;
#[path = "inbox_scheduled.rs"]
pub(crate) mod scheduled;
pub(super) use reliable::{apply_reliable, read_requests};
pub(super) use scheduled::{hold_scheduled_firing, refresh_scheduled_firing};
use std::collections::BTreeSet;

use nodex_core_contracts::agent::AgentTurnProvenance;
use nodex_core_contracts::inbox::{
    ProjectWorkspaceInboxChatAgent, ProjectWorkspaceInboxDelegate,
    ProjectWorkspaceInboxDispatchAction, ProjectWorkspaceInboxEntryKind,
    ProjectWorkspaceInboxEntryState, ProjectWorkspaceInboxPageBasis,
    ProjectWorkspaceInboxProposalOrigin,
};
use nodex_core_contracts::workspace::ProjectWorkspaceAgentRuntimeTurnKind;
use nodex_core_contracts::{AdapterKind, BoundModuleContext};
use rusqlite::{Connection, OptionalExtension, params};

use crate::database::{
    WorkflowStatusStep, create_database_authority_records, create_page_key_namespace,
    follow_workflow_status, resolve_page_transfer_data_source_destination,
};
use crate::domain::derived_records::parse_page_file_source;
use crate::domain::identity::stable_uuid_v7;
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};
use nodex_markdown::{Block, BlockKind, Inline, ReadOptions, Style, write as serialize_markdown};

use super::ProjectWorkspaceApplyOutcome;
use super::mutation::{WorkspaceMutationEffects, project_session_scope, run_mutation};
use super::session_mutation::{sqlite_now, validate_id};

pub(super) const INBOX_DATABASE_NAME: &str = "Inbox";
const INBOX_PAGE_KEY_PREFIX: &str = "IN";
const INBOX_STATUS_GROUP_KEY: &str = "triage";
const INBOX_PLACEMENT_RANK_KEY: &str = "7fffffffffffffffffffffffffffffff";
const MAX_MESSAGE_BYTES: usize = 64 * 1024;
const MAX_GIVEN_TITLE_CHARS: usize = 200;
const PROVISIONAL_TITLE_COLUMNS: usize = 48;
/// More than any opening line a provisional title can be cut from.
const OPENING_TEXT_CHARS: i64 = 4_096;
pub(super) const MAX_PROPOSAL_PAGES: usize = 16;
const MAX_BULK_PAGES: usize = 200;
const MAX_PROMPT_BYTES: usize = 32 * 1024;
const MAX_SUMMARY_CHARS: usize = 4_000;
const MAX_RATIONALE_CHARS: usize = 4_000;
const MAX_PRODUCED_BY_CHARS: usize = 256;
const MAX_MESSAGE_CHARS: usize = 2_000;
const MAX_SOURCE_LABEL_CHARS: usize = 512;
const MAX_SESSION_TITLE_CHARS: usize = 120;
/// Capture remains bounded per causal Run, or per native connection when its Run is unknown.
pub(super) const MAX_AGENT_MESSAGES_PER_TURN: i64 = 5;
pub(super) const COMMAND_LINE_SOURCE_LABEL: &str = "Command line";

/// Where an Inbox's new messages become Pages.
pub(super) struct InboxHome {
    pub(super) database_id: String,
    pub(super) data_source_id: String,
    pub(super) view_id: String,
}

/// Dispatch suggestions and delivery are Desktop Host responsibilities.
fn require_host(context: &BoundModuleContext) -> Result<(), StoreError> {
    if matches!(
        context.adapter,
        AdapterKind::ElectronHost | AdapterKind::Test
    ) {
        return Ok(());
    }
    Err(StoreError::new(
        StoreErrorCode::Unauthorized,
        "Inbox dispatch work is reserved for the Desktop Host",
        false,
    ))
}

pub(super) fn read_registry(
    connection: &Connection,
    library_id: &str,
) -> Result<Option<InboxHome>, StoreError> {
    Ok(connection
        .query_row(
            "SELECT inbox.database_block_id, inbox.data_source_id, inbox.view_id \
             FROM inbox_registry inbox \
             JOIN blocks block ON block.id = inbox.database_block_id \
               AND block.library_id = inbox.library_id AND block.lifecycle = 'active' \
             JOIN database_containers container ON container.block_id = inbox.database_block_id \
               AND container.lifecycle = 'active' \
             JOIN data_sources source ON source.id = inbox.data_source_id \
               AND source.home_database_block_id = inbox.database_block_id \
               AND source.lifecycle = 'active' \
             JOIN database_views view ON view.id = inbox.view_id \
               AND view.data_source_id = inbox.data_source_id AND view.lifecycle = 'active' \
             WHERE inbox.library_id = ?1",
            [library_id],
            |row| {
                Ok(InboxHome {
                    database_id: row.get(0)?,
                    data_source_id: row.get(1)?,
                    view_id: row.get(2)?,
                })
            },
        )
        .optional()?)
}

/// A Project's Inbox lives in its primary Database: the first active Data Source and
/// the Database's default View, or its first View when no default is set.
pub(super) fn project_home(
    connection: &Connection,
    library_id: &str,
    project_id: &str,
) -> Result<Option<InboxHome>, StoreError> {
    Ok(connection
        .query_row(
            "SELECT binding.database_block_id, source.id, COALESCE(default_view.id, (\
               SELECT view.id FROM database_views view \
               WHERE view.data_source_id = source.id AND view.lifecycle = 'active' \
               ORDER BY view.rank_key, view.id LIMIT 1)) \
             FROM projects project \
             JOIN project_database_bindings binding ON binding.project_id = project.id \
               AND binding.library_id = project.library_id AND binding.lifecycle = 'active' \
             JOIN database_containers container ON container.block_id = binding.database_block_id \
               AND container.lifecycle = 'active' \
             JOIN data_sources source ON source.home_database_block_id = binding.database_block_id \
               AND source.lifecycle = 'active' \
             LEFT JOIN database_views default_view ON default_view.id = container.default_view_id \
               AND default_view.data_source_id = source.id AND default_view.lifecycle = 'active' \
             WHERE project.id = ?1 AND project.library_id = ?2 AND project.lifecycle = 'active' \
             ORDER BY source.rank_key, source.id LIMIT 1",
            params![project_id, library_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            },
        )
        .optional()?
        .and_then(|(database_id, data_source_id, view_id)| {
            view_id.map(|view_id| InboxHome {
                database_id,
                data_source_id,
                view_id,
            })
        }))
}

/// The home of the Inbox named by `scope`: the Library's Inbox Database or a Project's.
pub(super) fn scope_home(
    connection: &Connection,
    library_id: &str,
    scope: Option<&str>,
) -> Result<Option<InboxHome>, StoreError> {
    match scope {
        None => read_registry(connection, library_id),
        Some(project_id) => project_home(connection, library_id, project_id),
    }
}

/// Creates the Library's Inbox Database when it is missing or no longer active.
/// A replaced Database keeps its Pages; their entries continue to appear by Page.
fn ensure_registry(
    connection: &Connection,
    library_id: &str,
    identity_namespace: &str,
    now: &str,
) -> Result<(InboxHome, bool), StoreError> {
    if let Some(registry) = read_registry(connection, library_id)? {
        return Ok((registry, false));
    }
    let registry = InboxHome {
        database_id: stable_uuid_v7(identity_namespace, "inbox-database", library_id),
        data_source_id: stable_uuid_v7(identity_namespace, "inbox-data-source", library_id),
        view_id: stable_uuid_v7(identity_namespace, "inbox-view", library_id),
    };
    connection.execute(
        "INSERT INTO blocks(\
           id, library_id, type, lifecycle, placement_revision, metadata_revision, \
           created_at, updated_at\
         ) VALUES (?1, ?2, 'database', 'active', 1, 1, ?3, ?3)",
        params![registry.database_id, library_id, now],
    )?;
    connection.execute(
        "INSERT INTO library_block_placements(\
           block_id, library_id, rank_key, revision, created_at, updated_at\
         ) VALUES (?1, ?2, ?3, 1, ?4, ?4)",
        params![
            registry.database_id,
            library_id,
            INBOX_PLACEMENT_RANK_KEY,
            now
        ],
    )?;
    create_database_authority_records(
        connection,
        library_id,
        &registry.database_id,
        &registry.data_source_id,
        &registry.view_id,
        INBOX_DATABASE_NAME,
        now,
    )?;
    // `IN-12` reads well in chat; fall back to a derived prefix when `IN` is taken.
    match create_page_key_namespace(
        connection,
        library_id,
        &registry.database_id,
        Some(INBOX_PAGE_KEY_PREFIX),
        INBOX_DATABASE_NAME,
        now,
    ) {
        Err(error) if error.code == StoreErrorCode::Conflict => {
            create_page_key_namespace(
                connection,
                library_id,
                &registry.database_id,
                None,
                INBOX_DATABASE_NAME,
                now,
            )?;
        }
        result => {
            result?;
        }
    }
    let next_seq = connection.query_row(
        "SELECT COALESCE(MAX(seq), 0) + 1 FROM inbox_entries WHERE library_id = ?1",
        [library_id],
        |row| row.get::<_, i64>(0),
    )?;
    connection.execute(
        "INSERT INTO inbox_registry(\
           library_id, database_block_id, data_source_id, view_id, next_seq, created_at, updated_at\
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6) \
         ON CONFLICT(library_id) DO UPDATE SET \
           database_block_id = excluded.database_block_id, \
           data_source_id = excluded.data_source_id, \
           view_id = excluded.view_id, \
           next_seq = MAX(inbox_registry.next_seq, excluded.next_seq), \
           updated_at = excluded.updated_at",
        params![
            library_id,
            registry.database_id,
            registry.data_source_id,
            registry.view_id,
            next_seq,
            now
        ],
    )?;
    Ok((registry, true))
}

/// A message becomes a Page whose body is the message itself: a Nodex Markdown document
/// with the message shape (see Message Content Behavior). Its title is the sender's own
/// when one is given. Otherwise it is a short provisional label that the suggestion Agent
/// may later replace with a name.
pub(super) struct MessagePage {
    pub(super) title_markdown: String,
    pub(super) body_markdown: String,
    /// Plain provisional title; absent when the sender chose the title.
    pub(super) provisional_title: Option<String>,
}

pub(super) fn message_page(body: &str, title: Option<&str>) -> Result<MessagePage, StoreError> {
    let message = message_body(body)?;
    let (title, provisional_title) = match title {
        Some(title) => {
            let title = normalize_given_title(title)?;
            (title, None)
        }
        None => {
            let excerpt = provisional_title(&message.title_text);
            (excerpt.clone(), Some(excerpt))
        }
    };
    Ok(MessagePage {
        title_markdown: title_markdown(&title),
        body_markdown: message.markdown,
        provisional_title,
    })
}

fn normalize_given_title(title: &str) -> Result<String, StoreError> {
    let title = title.split_whitespace().collect::<Vec<_>>().join(" ");
    if title.is_empty() || title.chars().count() > MAX_GIVEN_TITLE_CHARS {
        return Err(invalid(
            "Inbox message title must contain 1 to 200 characters",
        ));
    }
    Ok(title)
}

/// A message body as Core keeps it: canonical Nodex Markdown, and the text a
/// provisional title is drawn from.
pub(super) struct MessageBody {
    pub(super) markdown: String,
    pub(super) title_text: String,
}

/// Reads a message as message text: GitHub Flavored Markdown as people write messages, where
/// a single newline is a line break. Text that forms no markup stays literal, so everyday
/// writing is always a valid body; a body must hold text or an image and keep the message
/// shape a Composer writes and edits in place.
pub(super) fn message_body(body: &str) -> Result<MessageBody, StoreError> {
    if body.len() > MAX_MESSAGE_BYTES {
        return Err(invalid("Inbox message exceeds its 64 KiB bound"));
    }
    let blocks = nodex_markdown::read(body, ReadOptions::BOUNDARY)
        .map_err(|error| invalid(&error.to_string()))?;
    if nodex_markdown::text::plain_text(&blocks).trim().is_empty()
        && !blocks.iter().any(contains_image)
    {
        return Err(invalid("Inbox message must contain text or an image"));
    }
    if !has_message_shape(&blocks) {
        return Err(invalid(
            "An Inbox message has its Library images together before or after its text; edit other bodies as their Page",
        ));
    }
    Ok(MessageBody {
        title_text: message_title_text(&blocks),
        markdown: serialize_markdown(&blocks),
    })
}

/// Library image Blocks form one contiguous run at either edge, without inline or nested images.
pub(super) fn has_message_shape(blocks: &[Block]) -> bool {
    let plain_image = |block: &Block| matches!(&block.kind, BlockKind::Image { url, .. } if block.children.is_empty() && parse_page_file_source(url).is_some());
    let Some(first) = blocks.iter().position(contains_image) else {
        return true;
    };
    let end = blocks[first..]
        .iter()
        .take_while(|block| plain_image(block))
        .count()
        + first;
    end > first
        && (first == 0 || end == blocks.len())
        && blocks[end..].iter().all(|block| !contains_image(block))
}

/// Collects both Block images and inline images, including table cells.
pub(super) fn collect_image_sources(blocks: &[Block], sources: &mut Vec<String>) {
    let mut append = |url: &str| {
        if parse_page_file_source(url).is_some() && !sources.iter().any(|source| source == url) {
            sources.push(url.into());
        }
    };
    for block in blocks {
        if let BlockKind::Image { url, .. } = &block.kind {
            append(url);
        }
        for item in block_inline(block) {
            if let Inline::Image(image) = item {
                append(&image.url);
            }
        }
    }
    for block in blocks {
        collect_image_sources(&block.children, sources);
    }
}

fn block_inline(block: &Block) -> Vec<&Inline> {
    match &block.kind {
        BlockKind::Paragraph { text, .. }
        | BlockKind::Heading { text, .. }
        | BlockKind::Bullet { text, .. }
        | BlockKind::Numbered { text, .. }
        | BlockKind::Check { text, .. }
        | BlockKind::Toggle { text, .. }
        | BlockKind::Quote { text, .. }
        | BlockKind::Callout { text, .. } => text.iter().collect(),
        BlockKind::Table(table) => table
            .rows
            .iter()
            .flatten()
            .flat_map(|cell| &cell.text)
            .collect(),
        _ => Vec::new(),
    }
}

fn contains_image(block: &Block) -> bool {
    matches!(block.kind, BlockKind::Image { .. })
        || block_inline(block)
            .iter()
            .any(|item| matches!(item, Inline::Image(_)))
        || block.children.iter().any(contains_image)
}

fn message_title_text(blocks: &[Block]) -> String {
    let text = blocks
        .iter()
        .filter(|block| !matches!(block.kind, BlockKind::Image { .. }))
        .find_map(|block| {
            nodex_markdown::text::block_lines(std::slice::from_ref(block))
                .lines()
                .map(str::trim)
                .find(|line| !line.is_empty())
                .map(str::to_owned)
        });
    text.or_else(|| {
        blocks.iter().find_map(|block| match &block.kind {
            BlockKind::Image { caption, .. } if !caption.is_empty() => Some(caption.clone()),
            _ => None,
        })
    })
    .unwrap_or_else(|| "Image".into())
}

pub(super) fn text_paragraphs_markdown(text: &str) -> String {
    let blocks = text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            Block::new(BlockKind::Paragraph {
                text: vec![plain_text(line.trim_end())],
                colors: Default::default(),
            })
        })
        .collect::<Vec<_>>();
    serialize_markdown(&blocks)
}

pub(super) fn title_markdown(title: &str) -> String {
    nodex_markdown::write_inline(&[plain_text(title)])
}

/// A label for the message until it is named: its opening words, cut to a
/// short display width. Wide characters count twice, and a cut prefers a word
/// boundary when one is near.
pub(super) fn provisional_title(first_line: &str) -> String {
    let collapsed = first_line.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut width = 0;
    let mut cut = None;
    let mut last_space = None;
    for (index, character) in collapsed.char_indices() {
        width += display_width(character);
        if width > PROVISIONAL_TITLE_COLUMNS {
            cut = Some(index);
            break;
        }
        if character == ' ' {
            last_space = Some(index);
        }
    }
    let Some(cut) = cut else {
        return collapsed;
    };
    let cut = last_space
        .filter(|space| *space >= cut * 2 / 3)
        .unwrap_or(cut);
    format!("{}…", collapsed[..cut].trim_end())
}

fn display_width(character: char) -> usize {
    match u32::from(character) {
        0x1100..=0x115F
        | 0x2E80..=0x303E
        | 0x3041..=0x33FF
        | 0x3400..=0x4DBF
        | 0x4E00..=0x9FFF
        | 0xA000..=0xA4CF
        | 0xAC00..=0xD7A3
        | 0xF900..=0xFAFF
        | 0xFE30..=0xFE4F
        | 0xFF00..=0xFF60
        | 0xFFE0..=0xFFE6
        | 0x1F300..=0x1F64F
        | 0x1F900..=0x1F9FF
        | 0x20000..=0x3FFFD => 2,
        _ => 1,
    }
}

fn plain_text(text: &str) -> Inline {
    Inline::Text {
        text: text.into(),
        style: Style::default(),
    }
}

#[derive(Default)]
struct EntrySource {
    kind: &'static str,
    automation_id: Option<String>,
    dispatch_id: Option<String>,
    session_id: Option<String>,
    thread_id: Option<String>,
    turn_id: Option<String>,
    budget_key: Option<String>,
    project_id: Option<String>,
    label: Option<String>,
}

/// Who left the message is decided here from the connection, never by the caller.
/// The Desktop Host speaks for the user; command line and Agent messages retain
/// their captured execution source independently of the selected Project.
fn entry_source(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    provenance: Option<&AgentTurnProvenance>,
) -> Result<EntrySource, StoreError> {
    if let Some(provenance) = provenance {
        return agent_source(connection, provenance);
    }
    match context.adapter {
        AdapterKind::ElectronHost | AdapterKind::Test => Ok(EntrySource {
            kind: "user",
            ..EntrySource::default()
        }),
        AdapterKind::NativeCli => {
            let project = context
                .project_id
                .as_ref()
                .map(|project_id| project_id.0.as_str())
                .map(|project_id| {
                    connection
                        .query_row(
                            "SELECT name FROM projects WHERE id = ?1 AND library_id = ?2",
                            params![project_id, library_id],
                            |row| row.get::<_, String>(0),
                        )
                        .optional()?
                        .map(|name| (project_id.to_owned(), name))
                        .ok_or_else(|| {
                            StoreError::new(StoreErrorCode::NotFound, "Project not found", false)
                        })
                })
                .transpose()?;
            let label = match &project {
                Some((_, name)) => format!("{COMMAND_LINE_SOURCE_LABEL} · {}", name.trim()),
                None => COMMAND_LINE_SOURCE_LABEL.to_owned(),
            };
            Ok(EntrySource {
                kind: "command_line",
                project_id: project.map(|(project_id, _)| project_id),
                label: Some(truncate_chars(&label, MAX_SOURCE_LABEL_CHARS)),
                ..EntrySource::default()
            })
        }
        _ => Err(StoreError::new(
            StoreErrorCode::Unauthorized,
            "This connection cannot send to the Inbox",
            false,
        )),
    }
}

/// Which Inbox receives a new message. The Desktop Host chooses; an Agent Turn and the
/// command line speak for their own Project. A Project that is no longer active, or has
/// no Database, cannot hold messages, so theirs go to the Library Inbox.
fn capture_scope(
    connection: &Connection,
    library_id: &str,
    source: &EntrySource,
    requested: Option<&str>,
) -> Result<Option<String>, StoreError> {
    if let Some(project_id) = requested {
        if source.kind != "user" {
            return Err(StoreError::new(
                StoreErrorCode::Unauthorized,
                "Only the desktop app chooses which Inbox receives a message",
                false,
            ));
        }
        validate_id("project_id", project_id)?;
        super::session_lifecycle::require_project(connection, library_id, project_id, true)?;
        if project_home(connection, library_id, project_id)?.is_none() {
            return Err(not_found("The Project has no active Database"));
        }
        return Ok(Some(project_id.to_owned()));
    }
    let Some(project_id) = source.project_id.as_deref() else {
        return Ok(None);
    };
    Ok(project_home(connection, library_id, project_id)?.map(|_| project_id.to_owned()))
}

/// Runs inside the mutation so an idempotent replay returns its receipt instead.
fn require_turn_capacity(
    connection: &Connection,
    library_id: &str,
    source: &EntrySource,
) -> Result<(), StoreError> {
    let Some(budget_key) = &source.budget_key else {
        return Ok(());
    };
    let sent = connection.query_row(
        "SELECT COUNT(*) FROM inbox_entries \
         WHERE library_id = ?1 AND source_budget_key = ?2",
        params![library_id, budget_key],
        |row| row.get::<_, i64>(0),
    )?;
    if sent >= MAX_AGENT_MESSAGES_PER_TURN {
        return Err(StoreError::new(
            StoreErrorCode::ResourceExhausted,
            format!(
                "An Agent execution source can send at most {MAX_AGENT_MESSAGES_PER_TURN} Inbox messages"
            ),
            false,
        ));
    }
    Ok(())
}

/// Runtime callers name their Session and engine coordinates, never a foreground Run guessed by
/// Core. A native connection without causal Run evidence keeps that coordinate empty.
fn agent_source(
    connection: &Connection,
    provenance: &AgentTurnProvenance,
) -> Result<EntrySource, StoreError> {
    let authority = &provenance.authority;
    let (session_id, thread_id, turn_id, budget_key) = match &authority.runtime {
        Some(runtime) => {
            let run = (runtime.turn_kind == ProjectWorkspaceAgentRuntimeTurnKind::Run)
                .then(|| authority.turn_id.clone());
            let kind = if run.is_some() {
                "runtime-run"
            } else {
                "native-connection"
            };
            let key = serde_json::json!([
                kind,
                runtime.runtime_id,
                authority.thread_id,
                authority.turn_id
            ]);
            (
                Some(runtime.session_id.clone()),
                authority.thread_id.clone(),
                run,
                key.to_string(),
            )
        }
        None => {
            let session = connection
                .query_row(
                    "SELECT session_id FROM project_session_threads WHERE thread_id=?1",
                    [&authority.root_thread_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;
            (
                session,
                authority.thread_id.clone(),
                Some(authority.turn_id.clone()),
                serde_json::json!(["native-turn", authority.thread_id, authority.turn_id])
                    .to_string(),
            )
        }
    };
    let label = if let Some(session_id) = &session_id {
        connection.query_row(
            "SELECT COALESCE((SELECT definition.name FROM core_automation_runs run JOIN codex_scheduled_automations definition ON definition.automation_id=run.automation_id WHERE run.session_id=session.id AND definition.status<>'DELETED' ORDER BY run.created_at,run.run_id LIMIT 1), thread.thread_name,NULLIF(substr(thread.thread_preview,1,240),''), \
               session.no_thread_fallback_title) \
             FROM project_sessions session LEFT JOIN project_session_threads link ON link.session_id=session.id \
             LEFT JOIN codex_threads thread ON thread.thread_id=link.thread_id WHERE session.id=?1",
            [session_id], |row| row.get::<_,String>(0),
        )?
    } else {
        "Agent".to_owned()
    };
    Ok(EntrySource {
        kind: "agent",
        automation_id: None,
        dispatch_id: None,
        session_id,
        thread_id: Some(thread_id),
        turn_id,
        budget_key: Some(budget_key),
        project_id: authority.actor_project_id.clone(),
        label: Some(truncate_chars(label.trim(), MAX_SOURCE_LABEL_CHARS)),
    })
}

#[allow(clippy::too_many_arguments)]
pub(super) fn send_message(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    provenance: Option<&AgentTurnProvenance>,
    page_id: &str,
    document_id: &str,
    body: &str,
    title: Option<&str>,
    project_id: Option<&str>,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    validate_id("page_id", page_id)?;
    validate_id("document_id", document_id)?;
    let message = message_page(body, title)?;
    let mut source = entry_source(connection, library_id, context, provenance)?;
    let inbox_project = capture_scope(connection, library_id, &source, project_id)?;
    // A Project's Inbox already names its Project; the label names it only when the
    // message had to land somewhere else.
    if source.kind == "command_line"
        && inbox_project.is_some()
        && inbox_project == source.project_id
    {
        source.label = Some(COMMAND_LINE_SOURCE_LABEL.to_owned());
    }
    let now = sqlite_now(connection)?;
    run_mutation(
        connection,
        context,
        store_epoch,
        operation_id,
        request_hash,
        &now,
        |scope| {
            capture_message_in_scope(
                connection,
                library_id,
                context,
                store_epoch,
                operation_id,
                scope,
                page_id,
                document_id,
                &message,
                &source,
                inbox_project.as_deref(),
                &now,
            )
        },
    )
}

#[allow(clippy::too_many_arguments)]
fn capture_message_in_scope(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    scope: &crate::infrastructure::durable_mutation::DurableMutationScope<'_>,
    page_id: &str,
    document_id: &str,
    message: &MessagePage,
    source: &EntrySource,
    inbox_project: Option<&str>,
    now: &str,
) -> Result<WorkspaceMutationEffects, StoreError> {
    require_turn_capacity(connection, library_id, source)?;
    // The Library Inbox registry also allocates every Inbox's message sequence.
    let (registry, created) = ensure_registry(connection, library_id, operation_id, now)?;
    let home = match inbox_project {
        None => None,
        Some(project_id) => Some(
            project_home(connection, library_id, project_id)?
                .ok_or_else(|| not_found("The Project has no active Database"))?,
        ),
    };
    let home_ref = home.as_ref().unwrap_or(&registry);
    let destination = resolve_page_transfer_data_source_destination(
        connection,
        library_id,
        inbox_project,
        &home_ref.data_source_id,
        &home_ref.view_id,
        Some(INBOX_STATUS_GROUP_KEY),
        None,
    )?;
    let created_page = crate::library::page_genesis::create_page_in_data_source(
        connection,
        crate::library::page_genesis::PageGenesisInput {
            context,
            commit_context: scope.evidence(),
            library_id,
            actor_project_id: inbox_project,
            operation_id,
            store_epoch,
            page_id,
            document_id,
            title_markdown: &message.title_markdown,
            markdown: &message.body_markdown,
            destination: &destination,
            now,
        },
    )?;
    let seq = allocate_seq(connection, library_id, now)?;
    connection.execute(
                "INSERT INTO inbox_entries(\
                   page_id, library_id, seq, submitted_at, source_kind, source_session_id, \
                   source_thread_id, source_turn_id, source_project_id, source_label, source_budget_key, source_automation_id, source_dispatch_id, \
                   provisional_title, scope_project_id, updated_at, suggestion_state\
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?4, 'waiting')",
                params![
                    page_id,
                    library_id,
                    seq,
                    now,
                    source.kind,
                    source.session_id,
                    source.thread_id,
                    source.turn_id,
                    source.project_id,
                    source.label,
                    source.budget_key,
                    source.automation_id,
                    source.dispatch_id,
                    message.provisional_title,
                    inbox_project,
                ],
            )?;
    let mut block_ids = vec![created_page.page_create.page_id.clone()];
    block_ids.extend(created_page.page_create.block_ids.iter().cloned());
    let mut database_ids = Vec::new();
    let mut view_ids = created_page.affected_view_ids.clone();
    if created {
        block_ids.push(registry.database_id.clone());
        database_ids.push(registry.database_id.clone());
        view_ids.push(registry.view_id.clone());
    }
    Ok(inbox_effects(
        "inbox_send_message",
        InboxEffectResources {
            block_ids,
            document_ids: vec![created_page.page_create.document_id.clone()],
            database_ids,
            page_ids: vec![page_id.to_owned()],
            data_source_ids: vec![created_page.data_source_id.clone()],
            view_ids,
            document_heads: vec![created_page.document_head.clone()],
        },
        now,
    ))
}

fn allocate_seq(connection: &Connection, library_id: &str, now: &str) -> Result<i64, StoreError> {
    let seq = connection.query_row(
        "SELECT next_seq FROM inbox_registry WHERE library_id = ?1",
        [library_id],
        |row| row.get::<_, i64>(0),
    )?;
    connection.execute(
        "UPDATE inbox_registry SET next_seq = next_seq + 1, updated_at = ?2 WHERE library_id = ?1",
        params![library_id, now],
    )?;
    Ok(seq)
}

#[derive(Default)]
struct InboxEffectResources {
    block_ids: Vec<String>,
    document_ids: Vec<String>,
    database_ids: Vec<String>,
    page_ids: Vec<String>,
    data_source_ids: Vec<String>,
    view_ids: Vec<String>,
    document_heads: Vec<nodex_core_contracts::PageDocumentHeadImpact>,
}

fn inbox_effects(
    operation_kind: &'static str,
    resources: InboxEffectResources,
    now: &str,
) -> WorkspaceMutationEffects {
    WorkspaceMutationEffects {
        operation_kind,
        project_catalog_change: None,
        change_project_id: None,
        project_ids: Vec::new(),
        session_ids: Vec::new(),
        thread_ids: Vec::new(),
        session_summary_scopes: Vec::new(),
        session_detail_ids: Vec::new(),
        block_ids: resources.block_ids,
        document_ids: resources.document_ids,
        database_ids: resources.database_ids,
        page_ids: resources.page_ids,
        data_source_ids: resources.data_source_ids,
        view_ids: resources.view_ids,
        document_heads: resources.document_heads,
        committed_at: now.to_owned(),
    }
}

fn simple_effects(operation_kind: &'static str, now: &str) -> WorkspaceMutationEffects {
    inbox_effects(operation_kind, InboxEffectResources::default(), now)
}

// ---------------------------------------------------------------------------
// Workflow status
// ---------------------------------------------------------------------------

/// The workflow status a message's handling implies for its Page: Triage while it waits,
/// Build once its work is handed to a chat, Plan when it is kept or filed, Ship when done.
fn implied_status(connection: &Connection, page_id: &str) -> Result<String, StoreError> {
    Ok(connection.query_row(
        "SELECT CASE entry.state WHEN 'done' THEN 'ship' WHEN 'kept' THEN 'plan' \
           ELSE CASE WHEN COALESCE(proposal.state, '') IN ('dispatching', 'completed', 'failed') \
             AND COALESCE(json_extract(proposal.action_json, '$.type'), '') \
               IN ('new_chat', 'send_to_chat', 'run_task') \
           THEN 'build' ELSE 'triage' END END \
         FROM inbox_entries entry \
         LEFT JOIN inbox_proposals proposal ON proposal.proposal_id = entry.current_proposal_id \
         WHERE entry.page_id = ?1",
        [page_id],
        |row| row.get(0),
    )?)
}

/// What each message's handling implied before a decision, so the decision can move the
/// messages' Pages along with it.
pub(super) struct ImpliedStatuses(Vec<(String, String)>);

impl ImpliedStatuses {
    pub(super) fn read(connection: &Connection, page_ids: &[String]) -> Result<Self, StoreError> {
        page_ids
            .iter()
            .map(|page_id| Ok((page_id.clone(), implied_status(connection, page_id)?)))
            .collect::<Result<_, StoreError>>()
            .map(Self)
    }

    /// Moves each Page's status to what its message's handling implies now. A Page whose
    /// status someone set since keeps it; the Board stays theirs.
    pub(super) fn follow(
        self,
        connection: &Connection,
        library_id: &str,
        context: &BoundModuleContext,
        operation_id: &str,
        effects: &mut WorkspaceMutationEffects,
    ) -> Result<(), StoreError> {
        let after = self
            .0
            .iter()
            .map(|(page_id, _)| implied_status(connection, page_id))
            .collect::<Result<Vec<_>, _>>()?;
        let steps = self
            .0
            .iter()
            .zip(&after)
            .map(|((page_id, from), to)| WorkflowStatusStep { page_id, from, to })
            .collect::<Vec<_>>();
        let Some(receipt) = follow_workflow_status(
            connection,
            library_id,
            context,
            &format!("{operation_id}:inbox-status"),
            &steps,
            &effects.committed_at,
        )?
        else {
            return Ok(());
        };
        let absorb = |into: &mut Vec<String>, ids: &[String]| {
            for id in ids {
                if !into.contains(id) {
                    into.push(id.clone());
                }
            }
        };
        absorb(&mut effects.page_ids, &receipt.affected_page_ids);
        absorb(&mut effects.database_ids, &receipt.affected_database_ids);
        absorb(
            &mut effects.data_source_ids,
            &receipt.affected_data_source_ids,
        );
        absorb(&mut effects.view_ids, &receipt.affected_view_ids);
        absorb(&mut effects.block_ids, &receipt.affected_page_ids);
        absorb(&mut effects.block_ids, &receipt.affected_database_ids);
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------

pub(super) struct ProposalInput<'a> {
    pub(super) proposal_id: &'a str,
    pub(super) page_ids: &'a [String],
    pub(super) basis: &'a [ProjectWorkspaceInboxPageBasis],
    pub(super) action: &'a ProjectWorkspaceInboxDispatchAction,
    pub(super) entry_kind: Option<ProjectWorkspaceInboxEntryKind>,
    pub(super) summary: &'a str,
    pub(super) rationale: Option<&'a str>,
    pub(super) produced_by: Option<&'a str>,
}

#[allow(clippy::too_many_arguments)]
pub(super) fn propose(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    input: ProposalInput<'_>,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    require_host(context)?;
    validate_id("proposal_id", input.proposal_id)?;
    let page_ids = unique_page_ids(input.page_ids, MAX_PROPOSAL_PAGES)?;
    for page in &page_ids {
        if crate::automation::firing::item(connection, page)?.is_some_and(|firing| {
            firing.status == nodex_core_contracts::automation::AutomationFiringStatus::Held
        }) {
            return Err(conflict(
                "This scheduled task already has its own Run task decision",
            ));
        }
    }
    require_open_entries(connection, library_id, &page_ids)?;
    require_basis(connection, &page_ids, input.basis)?;
    let scope = require_one_scope(connection, &page_ids)?;
    let action = normalize_action(connection, library_id, scope.as_deref(), input.action)?;
    let summary = bounded_text("summary", input.summary, MAX_SUMMARY_CHARS)?;
    let rationale = input
        .rationale
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| bounded_text("rationale", value, MAX_RATIONALE_CHARS))
        .transpose()?;
    let produced_by = input
        .produced_by
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| truncate_chars(value, MAX_PRODUCED_BY_CHARS));
    let now = sqlite_now(connection)?;
    run_mutation(
        connection,
        context,
        store_epoch,
        operation_id,
        request_hash,
        &now,
        |_| {
            insert_proposal(
                connection,
                library_id,
                NewProposal {
                    proposal_id: input.proposal_id,
                    origin: ProjectWorkspaceInboxProposalOrigin::Agent,
                    page_ids: &page_ids,
                    basis: input.basis,
                    action: &action,
                    entry_kind: input.entry_kind,
                    summary: &summary,
                    rationale: rationale.as_deref(),
                    produced_by: produced_by.as_deref(),
                },
                &now,
            )?;
            Ok(simple_effects("inbox_propose_dispatch", &now))
        },
    )
}

struct NewProposal<'a> {
    proposal_id: &'a str,
    origin: ProjectWorkspaceInboxProposalOrigin,
    page_ids: &'a [String],
    basis: &'a [ProjectWorkspaceInboxPageBasis],
    action: &'a ProjectWorkspaceInboxDispatchAction,
    entry_kind: Option<ProjectWorkspaceInboxEntryKind>,
    summary: &'a str,
    rationale: Option<&'a str>,
    produced_by: Option<&'a str>,
}

fn insert_proposal(
    connection: &Connection,
    library_id: &str,
    proposal: NewProposal<'_>,
    now: &str,
) -> Result<(), StoreError> {
    if connection
        .query_row(
            "SELECT 1 FROM inbox_proposals WHERE proposal_id = ?1",
            [proposal.proposal_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some()
    {
        return Err(conflict("Inbox proposal identity already exists"));
    }
    if has_in_flight_dispatch(connection, proposal.page_ids)? {
        return Err(conflict(
            "An Inbox entry is still being dispatched; wait for it to finish",
        ));
    }
    supersede_failed_proposals(connection, proposal.page_ids, now)?;
    // New advice may split an older group. Uncovered members lose that whole-group
    // proposal, while any separate request they already own continues normally.
    let members = serde_json::to_string(proposal.page_ids)
        .map_err(|_| internal("Inbox members cannot be encoded"))?;
    connection.execute("UPDATE inbox_entries SET current_proposal_id=NULL,suggestion_state=CASE WHEN suggestion_state='settled' THEN 'none' ELSE suggestion_state END,revision=revision+1,updated_at=?2 WHERE state='open' AND page_id NOT IN (SELECT value FROM json_each(?1)) AND current_proposal_id IN (SELECT previous.proposal_id FROM inbox_proposals previous JOIN inbox_proposal_pages member USING(proposal_id) WHERE previous.state='open' AND member.page_id IN (SELECT value FROM json_each(?1)))",params![members,now])?;
    supersede_open_proposals(connection, proposal.page_ids, "superseded", now)?;
    connection.execute(
        "INSERT INTO inbox_proposals(\
           proposal_id, library_id, origin, state, revision, action_json, kind, summary, \
           rationale, produced_by, basis_json, created_at, updated_at\
         ) VALUES (?1, ?2, ?3, 'open', 1, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
        params![
            proposal.proposal_id,
            library_id,
            origin_literal(proposal.origin),
            action_json(proposal.action)?,
            proposal.entry_kind.map(kind_literal),
            proposal.summary,
            proposal.rationale,
            proposal.produced_by,
            serde_json::to_string(proposal.basis)
                .map_err(|_| internal("Inbox proposal basis cannot be encoded"))?,
            now,
        ],
    )?;
    for (position, page_id) in proposal.page_ids.iter().enumerate() {
        connection.execute(
            "INSERT INTO inbox_proposal_pages(proposal_id, page_id, position) VALUES (?1, ?2, ?3)",
            params![
                proposal.proposal_id,
                page_id,
                i64::try_from(position).map_err(|_| invalid("Inbox proposal is too large"))?
            ],
        )?;
        connection.execute(
            "UPDATE inbox_entries SET current_proposal_id = ?2, suggestion_state = 'settled', \
               suggestion_error = NULL, \
               kind = CASE WHEN kind_set_by_user = 1 OR ?3 IS NULL THEN kind ELSE ?3 END, \
               revision = revision + 1, updated_at = ?4 \
             WHERE page_id = ?1 AND library_id = ?5",
            params![
                page_id,
                proposal.proposal_id,
                proposal.entry_kind.map(kind_literal),
                now,
                library_id
            ],
        )?;
    }
    Ok(())
}

fn has_in_flight_dispatch(
    connection: &Connection,
    page_ids: &[String],
) -> Result<bool, StoreError> {
    for page_id in page_ids {
        let in_flight = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM inbox_proposal_pages member \
               JOIN inbox_proposals proposal ON proposal.proposal_id = member.proposal_id \
               WHERE member.page_id = ?1 AND proposal.state = 'dispatching')",
            [page_id],
            |row| row.get::<_, bool>(0),
        )?;
        if in_flight {
            return Ok(true);
        }
    }
    Ok(false)
}

fn supersede_open_proposals(
    connection: &Connection,
    page_ids: &[String],
    state: &str,
    now: &str,
) -> Result<(), StoreError> {
    for page_id in page_ids {
        connection.execute(
            "UPDATE inbox_proposals SET state = ?2, updated_at = ?3 \
             WHERE state = 'open' AND proposal_id IN (\
               SELECT proposal_id FROM inbox_proposal_pages WHERE page_id = ?1)",
            params![page_id, state, now],
        )?;
    }
    Ok(())
}

/// Replacing any member retires the entire failed delivery, including its frozen payload.
fn supersede_failed_proposals(
    connection: &Connection,
    page_ids: &[String],
    now: &str,
) -> Result<(), StoreError> {
    let page_ids = serde_json::to_string(page_ids)
        .map_err(|_| internal("Inbox proposal members cannot be encoded"))?;
    let proposals = connection
        .prepare(
            "SELECT DISTINCT proposal.proposal_id FROM inbox_proposals proposal \
             JOIN inbox_proposal_pages member USING(proposal_id) \
             WHERE proposal.state='failed' \
               AND member.page_id IN (SELECT value FROM json_each(?1))",
        )?
        .query_map([page_ids], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for proposal_id in proposals {
        connection.execute(
            "UPDATE inbox_entries SET current_proposal_id=NULL,outcome=NULL, \
               suggestion_state='none',suggestion_request_id=NULL,suggestion_error=NULL, \
               revision=revision+1,updated_at=?2 \
             WHERE current_proposal_id=?1 AND state='open'",
            params![proposal_id, now],
        )?;
        connection.execute(
            "UPDATE inbox_proposals SET state='superseded',revision=revision+1,updated_at=?2 \
             WHERE proposal_id=?1",
            params![proposal_id, now],
        )?;
        connection.execute(
            "DELETE FROM inbox_handoffs WHERE proposal_id=?1",
            [&proposal_id],
        )?;
    }
    Ok(())
}

fn user_summary(action: &ProjectWorkspaceInboxDispatchAction) -> String {
    match action {
        ProjectWorkspaceInboxDispatchAction::RunTask { .. } => "Run task".to_owned(),
        ProjectWorkspaceInboxDispatchAction::Keep => "Keep as a note".to_owned(),
        ProjectWorkspaceInboxDispatchAction::NewChat { .. } => "Start a new chat".to_owned(),
        ProjectWorkspaceInboxDispatchAction::SendToChat { .. } => {
            "Send to an existing chat".to_owned()
        }
        ProjectWorkspaceInboxDispatchAction::MoveToProject { .. } => "File in a Project".to_owned(),
    }
}

fn apply_confirmation(
    connection: &Connection,
    library_id: &str,
    proposal_id: &str,
    page_ids: &[String],
    action: &ProjectWorkspaceInboxDispatchAction,
    session_id: Option<&str>,
    now: &str,
) -> Result<WorkspaceMutationEffects, StoreError> {
    if !matches!(action, ProjectWorkspaceInboxDispatchAction::RunTask { .. }) {
        scheduled::consume(
            connection,
            page_ids,
            if matches!(action, ProjectWorkspaceInboxDispatchAction::Keep) {
                "skipped"
            } else {
                "withdrawn"
            },
            now,
        )?;
    }
    let encoded_action = action_json(action)?;
    match action {
        ProjectWorkspaceInboxDispatchAction::RunTask {
            automation_id,
            dispatch_id,
            agent,
        } => {
            scheduled::admit(
                connection,
                library_id,
                page_ids,
                automation_id,
                dispatch_id,
                agent.as_ref(),
                now,
            )?;
            finish_proposal(connection, proposal_id, &encoded_action, now)?;
            connection.execute("UPDATE inbox_entries SET outcome='chat',revision=revision+1,updated_at=?2 WHERE page_id=?1",params![page_ids[0],now])?;
            let mut effects = simple_effects("inbox_confirm_scheduled", now);
            effects.page_ids = page_ids.to_vec();
            Ok(effects)
        }
        ProjectWorkspaceInboxDispatchAction::Keep => {
            finish_proposal(connection, proposal_id, &encoded_action, now)?;
            set_entries_state(connection, library_id, page_ids, "kept", now)?;
            Ok(simple_effects("inbox_confirm_keep", now))
        }
        ProjectWorkspaceInboxDispatchAction::MoveToProject { project_id } => {
            // Library has relocated every member inside this decision transaction.
            // Verify the resulting placement before recording the Inbox outcome.
            let data_source_id = project_data_source(connection, library_id, project_id)?;
            for page_id in page_ids {
                let parent = connection.query_row(
                    "SELECT parent_kind, parent_id FROM pages WHERE block_id = ?1",
                    [page_id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )?;
                if parent != ("data_source".to_owned(), data_source_id.clone()) {
                    return Err(conflict(
                        "Move the message into the Project before completing this suggestion",
                    ));
                }
            }
            finish_proposal(connection, proposal_id, &encoded_action, now)?;
            // Filing is the decision: the message stays handled in its own Inbox and does
            // not open again in the Project it was filed into.
            set_entries_state(connection, library_id, page_ids, "kept", now)?;
            Ok(simple_effects("inbox_confirm_move", now))
        }
        ProjectWorkspaceInboxDispatchAction::NewChat { project_id, .. } => {
            let session_id = session_id.ok_or_else(|| {
                invalid("Starting a new chat requires a preallocated Session identity")
            })?;
            validate_id("session_id", session_id)?;
            let title = session_title(connection, page_ids)?;
            super::session_lifecycle::insert_session_records(
                connection,
                session_id,
                project_id.as_deref(),
                &title,
                false,
            )?;
            // The messages become the new chat's Linked Pages, so each Page shows the work it
            // started for as long as the chat exists.
            super::page_chat::insert_initial_page_links(connection, session_id, page_ids, now)?;
            start_dispatch(
                connection,
                proposal_id,
                &encoded_action,
                session_id,
                None,
                now,
            )?;
            let mut effects = simple_effects("inbox_confirm_new_chat", now);
            effects.project_ids = project_id.iter().cloned().collect();
            effects.change_project_id = project_id.clone();
            effects.session_ids = vec![session_id.to_owned()];
            effects.session_summary_scopes = vec![project_session_scope(project_id.as_deref())];
            effects.session_detail_ids = vec![session_id.to_owned()];
            Ok(effects)
        }
        ProjectWorkspaceInboxDispatchAction::SendToChat {
            session_id: target, ..
        } => {
            let authority =
                super::session_mutation::require_session(connection, library_id, target)?;
            super::page_chat::link_pages(connection, target, page_ids, now)?;
            start_dispatch(
                connection,
                proposal_id,
                &encoded_action,
                target,
                session_thread_id(connection, target)?.as_deref(),
                now,
            )?;
            let mut effects = simple_effects("inbox_confirm_send", now);
            effects.project_ids = authority.project_id.iter().cloned().collect();
            effects.change_project_id = authority.project_id.clone();
            effects.session_ids = vec![target.clone()];
            effects.thread_ids = authority.thread_id.iter().cloned().collect();
            effects.session_summary_scopes =
                vec![project_session_scope(authority.project_id.as_deref())];
            effects.session_detail_ids = vec![target.clone()];
            Ok(effects)
        }
    }
}

fn finish_proposal(
    connection: &Connection,
    proposal_id: &str,
    action_json: &str,
    now: &str,
) -> Result<(), StoreError> {
    connection.execute(
        "UPDATE inbox_proposals SET state = 'completed', action_json = ?2, \
           revision = revision + 1, confirmed_at = ?3, updated_at = ?3 \
         WHERE proposal_id = ?1",
        params![proposal_id, action_json, now],
    )?;
    Ok(())
}

fn session_thread_id(
    connection: &Connection,
    session_id: &str,
) -> Result<Option<String>, StoreError> {
    Ok(connection.query_row(
        "SELECT COALESCE(binding.runtime_thread_id,link.thread_id) FROM project_sessions session \
         LEFT JOIN project_session_execution_bindings binding ON binding.session_id=session.id \
         LEFT JOIN project_session_threads link ON link.session_id=session.id WHERE session.id=?1",
        [session_id],
        |row| row.get(0),
    )?)
}

fn start_dispatch(
    connection: &Connection,
    proposal_id: &str,
    action_json: &str,
    session_id: &str,
    thread_id: Option<&str>,
    now: &str,
) -> Result<(), StoreError> {
    connection.execute(
        "UPDATE inbox_proposals SET state = 'dispatching', action_json = ?2, \
           dispatch_session_id = ?3, dispatch_thread_id = ?4, confirmed_at = ?5, \
           failure_message = NULL, revision = revision + 1, updated_at = ?5 \
         WHERE proposal_id = ?1",
        params![proposal_id, action_json, session_id, thread_id, now],
    )?;
    Ok(())
}

fn session_title(connection: &Connection, page_ids: &[String]) -> Result<String, StoreError> {
    let first = page_ids
        .first()
        .ok_or_else(|| invalid("A dispatch needs at least one Inbox entry"))?;
    let title = connection
        .query_row(
            "SELECT materialization.title FROM pages page \
             JOIN document_materializations materialization \
               ON materialization.document_id = page.document_id \
             WHERE page.block_id = ?1",
            [first],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .unwrap_or_default();
    let title = truncate_chars(title.trim(), MAX_SESSION_TITLE_CHARS);
    Ok(if title.is_empty() {
        "Inbox message".to_owned()
    } else {
        title
    })
}

#[allow(clippy::too_many_arguments)]
pub(super) fn keep_entries(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    page_ids: &[String],
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    let page_ids = unique_page_ids(page_ids, MAX_BULK_PAGES)?;
    require_live_entries(connection, library_id, &page_ids)?;
    let now = sqlite_now(connection)?;
    run_mutation(
        connection,
        context,
        store_epoch,
        operation_id,
        request_hash,
        &now,
        |_| {
            let before = ImpliedStatuses::read(connection, &page_ids)?;
            supersede_open_proposals(connection, &page_ids, "dismissed", &now)?;
            set_entries_state(connection, library_id, &page_ids, "kept", &now)?;
            let mut effects = simple_effects("inbox_keep_entries", &now);
            effects.page_ids = page_ids.clone();
            before.follow(connection, library_id, context, operation_id, &mut effects)?;
            Ok(effects)
        },
    )
}

/// Deleting is erasure: a message that held a secret must not survive in a suggestion,
/// the Page, its history, or trash. Everything the Inbox owns goes in this transaction;
/// Store maintenance then collects the tombstoned Page's remaining storage.
pub(super) fn delete_messages(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    page_ids: &[String],
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    let page_ids = unique_page_ids(page_ids, MAX_BULK_PAGES)?;
    let now = sqlite_now(connection)?;
    run_mutation(
        connection,
        context,
        store_epoch,
        operation_id,
        request_hash,
        &now,
        |_| {
            for page_id in &page_ids {
                let (parent_kind, parent_id, scope) = connection
                    .query_row(
                        "SELECT page.parent_kind, page.parent_id, entry.scope_project_id \
                         FROM inbox_entries entry \
                         JOIN pages page ON page.block_id = entry.page_id \
                         JOIN blocks block ON block.id = entry.page_id \
                           AND block.lifecycle <> 'deleted' \
                         WHERE entry.page_id = ?1 AND entry.library_id = ?2",
                        params![page_id, library_id],
                        |row| {
                            Ok((
                                row.get::<_, String>(0)?,
                                row.get::<_, String>(1)?,
                                row.get::<_, Option<String>>(2)?,
                            ))
                        },
                    )
                    .optional()?
                    .ok_or_else(|| not_found("Inbox message not found"))?;
                let home = scope_home(connection, library_id, scope.as_deref())?;
                if parent_kind != "data_source"
                    || home.is_none_or(|home| home.data_source_id != parent_id)
                {
                    return Err(conflict(
                        "This message was filed elsewhere; delete its Page there",
                    ));
                }
            }
            scheduled::consume(connection, &page_ids, "withdrawn", &now)?;
            for page in &page_ids {
                connection.execute("UPDATE core_automation_firings SET status='withdrawn',waiting_in_inbox=0,admission_prompt=NULL,admission_agent_json=NULL,admitted_at_ms=NULL,due_at_ms=NULL WHERE page_id=?1",[page])?;
            }
            forget_proposals(connection, &page_ids, &now)?;
            let page_ids_json = serde_json::to_string(&page_ids)
                .map_err(|_| internal("Inbox message identities cannot be encoded"))?;
            connection.execute(
                "DELETE FROM inbox_entries WHERE page_id IN (SELECT value FROM json_each(?1))",
                [&page_ids_json],
            )?;
            let mut resources = InboxEffectResources {
                page_ids: page_ids.clone(),
                ..InboxEffectResources::default()
            };
            for page_id in &page_ids {
                let erased = crate::library::page_lifecycle_mutation::tombstone_page_for_erasure(
                    connection, library_id, page_id, &now,
                )?;
                for document_id in &erased.document_ids {
                    crate::document::erase_document_history(connection, document_id)?;
                }
                crate::document::request_block_erasure(connection, library_id, page_id, &now)?;
                resources.block_ids.extend(erased.block_ids);
                resources.document_ids.extend(erased.document_ids);
                resources.data_source_ids.extend(erased.data_source_id);
                resources.view_ids.extend(erased.view_id);
            }
            for ids in [
                &mut resources.block_ids,
                &mut resources.document_ids,
                &mut resources.data_source_ids,
                &mut resources.view_ids,
            ] {
                ids.sort();
                ids.dedup();
            }
            Ok(inbox_effects("inbox_delete_messages", resources, &now))
        },
    )
}

/// Erase advice and delivery content that could quote a deleted message. An unacknowledged
/// delivery retains only its remaining members and receipt references for explicit review.
fn forget_proposals(
    connection: &Connection,
    page_ids: &[String],
    now: &str,
) -> Result<(), StoreError> {
    let page_ids_json = serde_json::to_string(page_ids)
        .map_err(|_| internal("Inbox message identities cannot be encoded"))?;
    connection.execute("UPDATE inbox_entries SET suggestion_request_id=NULL,suggestion_state=CASE WHEN state='open' THEN 'none' ELSE suggestion_state END WHERE suggestion_request_id IN (SELECT request_id FROM inbox_suggestion_request_pages WHERE page_id IN (SELECT value FROM json_each(?1)))",[&page_ids_json])?;
    connection.execute("DELETE FROM inbox_suggestion_requests WHERE request_id IN (SELECT request_id FROM inbox_suggestion_request_pages WHERE page_id IN (SELECT value FROM json_each(?1)))",[&page_ids_json])?;
    let proposals = connection
        .prepare(
            "SELECT DISTINCT proposal.proposal_id, proposal.state \
             FROM inbox_proposal_pages link \
             JOIN inbox_proposals proposal ON proposal.proposal_id = link.proposal_id \
             WHERE link.page_id IN (SELECT value FROM json_each(?1))",
        )?
        .query_map([&page_ids_json], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (proposal_id, state) in proposals {
        let remaining = proposal_page_ids(connection, &proposal_id)?
            .into_iter()
            .filter(|page| !page_ids.contains(page))
            .collect::<Vec<_>>();
        if state == "dispatching" && !remaining.is_empty() {
            // Runtime may already have accepted even a local delivery. Erasure cannot infer
            // non-delivery, replay it, or report the remaining members as completed.
            connection.execute("UPDATE inbox_proposals SET action_json=json_set(action_json,'$.prompt','Review the remaining Inbox messages'),summary='Delivery needs review',rationale=NULL,produced_by=NULL,kind=NULL,basis_json=?2,failure_kind='unknown',failure_message='A message was deleted before delivery was confirmed',revision=revision+1,updated_at=?3 WHERE proposal_id=?1",params![proposal_id,serde_json::to_string(&current_basis(connection,&remaining)?).map_err(|_| internal("Inbox basis cannot be encoded"))?,now])?;
            connection.execute("UPDATE inbox_handoffs SET final_text='',execution_selection_json=NULL WHERE proposal_id=?1",[&proposal_id])?;
            connection.execute("DELETE FROM inbox_proposal_pages WHERE proposal_id=?1 AND page_id IN (SELECT value FROM json_each(?2))",params![proposal_id,page_ids_json])?;
            connection.execute("UPDATE inbox_entries SET state='open',outcome=NULL,suggestion_state='settled',suggestion_request_id=NULL,suggestion_error=NULL,revision=revision+1,updated_at=?2 WHERE current_proposal_id=?1 AND page_id NOT IN (SELECT value FROM json_each(?3))",params![proposal_id,now,page_ids_json])?;
            continue;
        }
        let handled = state == "completed";
        connection.execute(
            "UPDATE inbox_entries SET current_proposal_id = NULL, \
               state = CASE WHEN ?2 THEN 'done' ELSE state END, \
               suggestion_state = CASE WHEN ?2 THEN suggestion_state ELSE 'none' END, \
               suggestion_error = CASE WHEN ?2 THEN suggestion_error ELSE NULL END, \
               revision = revision + 1, updated_at = ?3 \
             WHERE current_proposal_id = ?1 \
               AND page_id NOT IN (SELECT value FROM json_each(?4))",
            params![proposal_id, handled, now, page_ids_json],
        )?;
        connection.execute(
            "DELETE FROM inbox_proposals WHERE proposal_id = ?1",
            [&proposal_id],
        )?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(super) fn set_state(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    page_ids: &[String],
    state: ProjectWorkspaceInboxEntryState,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    let page_ids = unique_page_ids(page_ids, MAX_BULK_PAGES)?;
    require_live_entries(connection, library_id, &page_ids)?;
    let now = sqlite_now(connection)?;
    run_mutation(
        connection,
        context,
        store_epoch,
        operation_id,
        request_hash,
        &now,
        |_| {
            let before = ImpliedStatuses::read(connection, &page_ids)?;
            set_entries_state(
                connection,
                library_id,
                &page_ids,
                state_literal(state),
                &now,
            )?;
            let mut effects = simple_effects("inbox_set_entry_state", &now);
            effects.page_ids = page_ids.clone();
            before.follow(connection, library_id, context, operation_id, &mut effects)?;
            Ok(effects)
        },
    )
}

fn set_entries_state(
    connection: &Connection,
    library_id: &str,
    page_ids: &[String],
    state: &str,
    now: &str,
) -> Result<(), StoreError> {
    if state == "open" {
        scheduled::reopen(connection, page_ids, now)?;
    } else {
        scheduled::consume(connection, page_ids, "skipped", now)?;
    }
    if state != "open" {
        let ids = serde_json::to_string(page_ids)
            .map_err(|_| internal("Inbox identities cannot be encoded"))?;
        connection.execute("UPDATE inbox_suggestion_requests SET state='superseded',generation=generation+1,correction=NULL WHERE state='pending' AND request_id IN (SELECT request_id FROM inbox_suggestion_request_pages WHERE page_id IN (SELECT value FROM json_each(?1)))",[&ids])?;
        connection.execute("UPDATE inbox_entries SET suggestion_request_id=NULL,suggestion_state=CASE WHEN state='open' THEN 'none' ELSE suggestion_state END WHERE suggestion_request_id IN (SELECT request_id FROM inbox_suggestion_requests WHERE state='superseded')",[])?;
    }
    for page_id in page_ids {
        connection.execute(
            // Work handed to a chat cannot be recalled; marking it done or not only closes it.
            "UPDATE inbox_entries SET state = ?2, outcome=CASE \
               WHEN ?2 IN ('kept','done') AND EXISTS (SELECT 1 FROM core_automation_firings firing \
                 WHERE firing.page_id=inbox_entries.page_id AND firing.status='skipped') THEN 'done' \
               WHEN outcome = 'chat' THEN outcome \
               WHEN ?2 = 'kept' THEN 'kept' WHEN ?2 = 'done' THEN 'done' ELSE NULL END, \
               suggestion_state = CASE WHEN ?2 = 'open' AND source_kind <> 'scheduled_task' THEN 'none' \
                 WHEN suggestion_state IN ('waiting','pending') AND ?2 <> 'open' \
                 THEN 'none' ELSE suggestion_state END, suggestion_error = NULL, \
               revision = revision + 1, updated_at = ?3 \
             WHERE page_id = ?1 AND library_id = ?4 AND state <> ?2",
            params![page_id, state, now, library_id],
        )?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(super) fn set_kind(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    page_id: &str,
    kind: Option<ProjectWorkspaceInboxEntryKind>,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    let page_ids = unique_page_ids(std::slice::from_ref(&page_id.to_owned()), 1)?;
    require_live_entries(connection, library_id, &page_ids)?;
    let now = sqlite_now(connection)?;
    run_mutation(
        connection,
        context,
        store_epoch,
        operation_id,
        request_hash,
        &now,
        |_| {
            connection.execute(
                "UPDATE inbox_entries SET kind = ?2, kind_set_by_user = ?3, \
                   revision = revision + 1, updated_at = ?4 \
                 WHERE page_id = ?1 AND library_id = ?5",
                params![
                    page_id,
                    kind.map(kind_literal),
                    i64::from(kind.is_some()),
                    now,
                    library_id
                ],
            )?;
            Ok(simple_effects("inbox_set_entry_kind", &now))
        },
    )
}

/// Only the user marks a message important; it keeps the mark across Keep, Done and
/// `Return to Inbox`, and the mark matters only while the message waits in its Inbox.
#[allow(clippy::too_many_arguments)]
pub(super) fn set_important(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    page_id: &str,
    important: bool,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    let page_ids = unique_page_ids(std::slice::from_ref(&page_id.to_owned()), 1)?;
    require_live_entries(connection, library_id, &page_ids)?;
    let now = sqlite_now(connection)?;
    run_mutation(
        connection,
        context,
        store_epoch,
        operation_id,
        request_hash,
        &now,
        |_| {
            connection.execute(
                "UPDATE inbox_entries SET important = ?2, revision = revision + 1, updated_at = ?3 \
                 WHERE page_id = ?1 AND library_id = ?4 AND important <> ?2",
                params![page_id, i64::from(important), now, library_id],
            )?;
            Ok(simple_effects("inbox_set_entry_important", &now))
        },
    )
}

/// A Document write may refresh a provisional title, but never requests advice. Only
/// SendInboxMessage and a saved stream rewrite queue automatic suggestions.
#[allow(clippy::too_many_arguments)]
pub(super) fn revise_message(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    page_id: &str,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    validate_id("page_id", page_id)?;
    require_waiting_entry(connection, library_id, page_id)?;
    // The opening words are all a provisional title needs, so only a bounded text prefix is read.
    let (title, opening) = connection.query_row(
        "SELECT COALESCE(materialization.title, ''), \
           substr(COALESCE(materialization.plain_text, ''), 1, ?2) \
         FROM pages page \
         LEFT JOIN document_materializations materialization \
           ON materialization.document_id = page.document_id \
         WHERE page.block_id = ?1",
        params![page_id, OPENING_TEXT_CHARS],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
    )?;
    let follows_text = opening
        .lines()
        .find(|line| !line.trim().is_empty())
        .is_some_and(|line| provisional_title(line) == title);
    let now = sqlite_now(connection)?;
    run_mutation(
        connection,
        context,
        store_epoch,
        operation_id,
        request_hash,
        &now,
        |_| {
            if scheduled::refence(connection, page_id, &now)? {
                return Ok(simple_effects("inbox_revise_message", &now));
            }
            if follows_text {
                connection.execute(
                    "UPDATE inbox_entries SET provisional_title = ?2 \
                     WHERE page_id = ?1 AND library_id = ?3",
                    params![page_id, title, library_id],
                )?;
            }
            Ok(simple_effects("inbox_revise_message", &now))
        },
    )
}

#[allow(clippy::too_many_arguments)]
pub(super) fn record_suggestion_failure(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    page_ids: &[String],
    message: &str,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    require_host(context)?;
    let page_ids = unique_page_ids(page_ids, MAX_PROPOSAL_PAGES)?;
    let message = failure_text(message);
    let now = sqlite_now(connection)?;
    run_mutation(
        connection,
        context,
        store_epoch,
        operation_id,
        request_hash,
        &now,
        |_| {
            for page_id in &page_ids {
                connection.execute(
                    "UPDATE inbox_entries SET suggestion_state = 'failed', suggestion_error = ?2, \
                       revision = revision + 1, updated_at = ?3 \
                     WHERE page_id = ?1 AND library_id = ?4 AND suggestion_state IN ('waiting','pending')",
                    params![page_id, message, now, library_id],
                )?;
            }
            Ok(simple_effects("inbox_record_suggestion_failure", &now))
        },
    )
}

#[allow(clippy::too_many_arguments)]
pub(super) fn retry_dispatch(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    proposal_id: &str,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    let proposal = require_proposal(connection, library_id, proposal_id)?;
    if matches!(
        proposal.action,
        ProjectWorkspaceInboxDispatchAction::RunTask { .. }
    ) {
        require_host(context)?;
        let now = sqlite_now(connection)?;
        return run_mutation(
            connection,
            context,
            store_epoch,
            operation_id,
            request_hash,
            &now,
            |_| {
                scheduled::retry(connection, library_id, &proposal, proposal_id, &now)?;
                let mut effects = simple_effects("inbox_retry_scheduled", &now);
                effects.page_ids = proposal.page_ids.clone();
                Ok(effects)
            },
        );
    }
    if proposal.state != "failed" || proposal.dispatch_session_id.is_none() {
        return Err(conflict("Only a failed chat dispatch can be retried"));
    }
    let kind: Option<String> = connection.query_row(
        "SELECT failure_kind FROM inbox_proposals WHERE proposal_id=?1",
        [proposal_id],
        |r| r.get(0),
    )?;
    if kind.as_deref() != Some("unavailable") {
        return Err(conflict(
            "Review this rejected decision before sending again",
        ));
    }
    let now = sqlite_now(connection)?;
    run_mutation(
        connection,
        context,
        store_epoch,
        operation_id,
        request_hash,
        &now,
        |_| {
            require_live_entries(connection, library_id, &proposal.page_ids)?;
            for page_id in &proposal.page_ids {
                let still_owned = connection.query_row(
                    "SELECT state='open' AND current_proposal_id IS ?2 \
                     FROM inbox_entries WHERE page_id=?1",
                    params![page_id, proposal_id],
                    |row| row.get::<_, bool>(0),
                )?;
                if !still_owned {
                    return Err(conflict(
                        "The Inbox group changed; review its messages before sending again",
                    ));
                }
            }
            connection.execute(
                "UPDATE inbox_proposals SET state = 'dispatching', failure_message = NULL, failure_kind = NULL, \
                   revision = revision + 1, updated_at = ?2 \
                 WHERE proposal_id = ?1",
                params![proposal_id, now],
            )?;
            Ok(simple_effects("inbox_retry_dispatch", &now))
        },
    )
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

pub(super) struct StoredProposal {
    pub(super) state: String,
    pub(super) revision: i64,
    pub(super) action: ProjectWorkspaceInboxDispatchAction,
    pub(super) basis: Vec<ProjectWorkspaceInboxPageBasis>,
    pub(super) page_ids: Vec<String>,
    pub(super) dispatch_session_id: Option<String>,
}

pub(super) fn require_proposal(
    connection: &Connection,
    library_id: &str,
    proposal_id: &str,
) -> Result<StoredProposal, StoreError> {
    validate_id("proposal_id", proposal_id)?;
    let (state, revision, action, basis, dispatch_session_id) = connection
        .query_row(
            "SELECT state, revision, action_json, basis_json, dispatch_session_id \
             FROM inbox_proposals WHERE proposal_id = ?1 AND library_id = ?2",
            params![proposal_id, library_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| not_found("Inbox suggestion is unavailable"))?;
    Ok(StoredProposal {
        state,
        revision,
        action: parse_action(&action)?,
        basis: serde_json::from_str(&basis)
            .map_err(|_| corrupt("Stored Inbox proposal basis is invalid"))?,
        page_ids: proposal_page_ids(connection, proposal_id)?,
        dispatch_session_id,
    })
}

pub(super) fn proposal_page_ids(
    connection: &Connection,
    proposal_id: &str,
) -> Result<Vec<String>, StoreError> {
    Ok(connection
        .prepare(
            "SELECT page_id FROM inbox_proposal_pages WHERE proposal_id = ?1 ORDER BY position",
        )?
        .query_map([proposal_id], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?)
}

pub(super) fn parse_action(value: &str) -> Result<ProjectWorkspaceInboxDispatchAction, StoreError> {
    serde_json::from_str(value).map_err(|_| corrupt("Stored Inbox dispatch action is invalid"))
}

fn action_json(action: &ProjectWorkspaceInboxDispatchAction) -> Result<String, StoreError> {
    serde_json::to_string(action).map_err(|_| internal("Inbox dispatch action cannot be encoded"))
}

fn unique_page_ids(page_ids: &[String], maximum: usize) -> Result<Vec<String>, StoreError> {
    if page_ids.is_empty() {
        return Err(invalid("Select at least one Inbox entry"));
    }
    if page_ids.len() > maximum {
        return Err(StoreError::new(
            StoreErrorCode::ResourceExhausted,
            format!("At most {maximum} Inbox entries can be handled together"),
            false,
        ));
    }
    let mut seen = BTreeSet::new();
    for page_id in page_ids {
        validate_id("page_id", page_id)?;
        if !seen.insert(page_id.as_str()) {
            return Err(invalid("Inbox entries must be unique"));
        }
    }
    Ok(page_ids.to_vec())
}

/// Entries exist in this Library and their Pages are active.
fn require_live_entries(
    connection: &Connection,
    library_id: &str,
    page_ids: &[String],
) -> Result<(), StoreError> {
    for page_id in page_ids {
        let live = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM inbox_entries entry \
               JOIN blocks block ON block.id = entry.page_id AND block.lifecycle = 'active' \
               WHERE entry.page_id = ?1 AND entry.library_id = ?2)",
            params![page_id, library_id],
            |row| row.get::<_, bool>(0),
        )?;
        if !live {
            return Err(not_found("Inbox entry is unavailable"));
        }
    }
    Ok(())
}

/// Only a message still waiting in its Inbox can be rewritten: a handled one is a record
/// of what was decided, and one being delivered must keep the text it was sent with.
pub(super) fn require_waiting_entry(
    connection: &Connection,
    library_id: &str,
    page_id: &str,
) -> Result<(), StoreError> {
    let page_ids = [page_id.to_owned()];
    require_live_entries(connection, library_id, &page_ids)?;
    let waiting = connection.query_row(
        &format!(
            "SELECT {} FROM inbox_entries entry \
             LEFT JOIN inbox_proposals proposal \
               ON proposal.proposal_id = entry.current_proposal_id \
             WHERE entry.page_id = ?1",
            super::inbox_read::IN_INBOX
        ),
        [page_id],
        |row| row.get::<_, bool>(0),
    )?;
    if !waiting || has_in_flight_dispatch(connection, &page_ids)? {
        return Err(conflict("This message was already handled"));
    }
    Ok(())
}

/// Suggestions target only open entries; kept or done entries are the user's call.
fn require_open_entries(
    connection: &Connection,
    library_id: &str,
    page_ids: &[String],
) -> Result<(), StoreError> {
    require_live_entries(connection, library_id, page_ids)?;
    for page_id in page_ids {
        let open = connection.query_row(
            "SELECT state = 'open' FROM inbox_entries WHERE page_id = ?1",
            [page_id],
            |row| row.get::<_, bool>(0),
        )?;
        if !open {
            return Err(conflict("Only open Inbox entries can receive suggestions"));
        }
    }
    Ok(())
}

pub(super) fn current_basis(
    connection: &Connection,
    page_ids: &[String],
) -> Result<Vec<ProjectWorkspaceInboxPageBasis>, StoreError> {
    page_ids
        .iter()
        .map(|page_id| super::inbox_read::message_basis(connection, page_id))
        .collect()
}

fn document_head(connection: &Connection, page_id: &str) -> Result<(i64, i64), StoreError> {
    Ok(connection.query_row(
        "SELECT document.generation,document.head_seq FROM pages page JOIN documents document ON document.id=page.document_id WHERE page.block_id=?1",
        [page_id],
        |row| Ok((row.get(0)?,row.get(1)?)),
    )?)
}

fn require_basis(
    connection: &Connection,
    page_ids: &[String],
    basis: &[ProjectWorkspaceInboxPageBasis],
) -> Result<(), StoreError> {
    let current = current_basis(connection, page_ids)?;
    let mut expected = basis.to_vec();
    expected.sort_by(|left, right| left.page_id.cmp(&right.page_id));
    let mut actual = current;
    actual.sort_by(|left, right| left.page_id.cmp(&right.page_id));
    if expected == actual {
        return Ok(());
    }
    Err(StoreError::new(
        StoreErrorCode::Conflict,
        "The message changed after this suggestion was made",
        true,
    ))
}

/// The Inbox that owns these entries. Entries decided together must share it.
fn require_one_scope(
    connection: &Connection,
    page_ids: &[String],
) -> Result<Option<String>, StoreError> {
    let mut scopes = BTreeSet::new();
    for page_id in page_ids {
        let scope = connection
            .query_row(
                "SELECT scope_project_id FROM inbox_entries WHERE page_id = ?1",
                [page_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .ok_or_else(|| not_found("Inbox entry is unavailable"))?;
        scopes.insert(scope);
    }
    if scopes.len() > 1 {
        return Err(invalid(
            "Messages from different Inboxes cannot be handled together",
        ));
    }
    Ok(scopes.into_iter().next().flatten())
}

/// Bounds what a stored decision may carry; how many parts to delegate is the Agent's judgment.
const MAX_INBOX_DELEGATES: usize = 8;
const MAX_INBOX_DELEGATE_WORK_CHARS: usize = 500;
const MAX_INBOX_PLAN_CHARS: usize = 4_000;
const MAX_INBOX_CHOICE_CHARS: usize = 256;

/// An Agent choice names a real-looking instance and bounded option values. Whether it can
/// run is the Desktop Host's to resolve against its live catalog at confirmation.
fn normalize_chat_agent(
    agent: &ProjectWorkspaceInboxChatAgent,
) -> Result<ProjectWorkspaceInboxChatAgent, StoreError> {
    validate_id("agent.instance_id", &agent.instance_id)?;
    let choice = |value: &Option<String>| -> Result<Option<String>, StoreError> {
        match value.as_deref().map(str::trim) {
            None | Some("") => Ok(None),
            Some(value) if value.chars().count() <= MAX_INBOX_CHOICE_CHARS => {
                Ok(Some(value.to_owned()))
            }
            Some(_) => Err(invalid("An Agent choice is too long")),
        }
    };
    Ok(ProjectWorkspaceInboxChatAgent {
        instance_id: agent.instance_id.clone(),
        model: choice(&agent.model)?,
        reasoning_effort: choice(&agent.reasoning_effort)?,
        service_tier: choice(&agent.service_tier)?,
    })
}

/// Validates targets against current Workspace state and returns the canonical action.
/// A Project's Inbox works inside its Project: its chats start or continue there, and
/// filing moves a message to a different Project.
fn normalize_action(
    connection: &Connection,
    library_id: &str,
    scope: Option<&str>,
    action: &ProjectWorkspaceInboxDispatchAction,
) -> Result<ProjectWorkspaceInboxDispatchAction, StoreError> {
    match action {
        ProjectWorkspaceInboxDispatchAction::RunTask {
            automation_id,
            dispatch_id,
            agent,
        } => {
            validate_id("automation_id", automation_id)?;
            validate_id("dispatch_id", dispatch_id)?;
            Ok(ProjectWorkspaceInboxDispatchAction::RunTask {
                automation_id: automation_id.clone(),
                dispatch_id: dispatch_id.clone(),
                agent: agent.as_ref().map(normalize_chat_agent).transpose()?,
            })
        }
        ProjectWorkspaceInboxDispatchAction::Keep => Ok(ProjectWorkspaceInboxDispatchAction::Keep),
        ProjectWorkspaceInboxDispatchAction::NewChat {
            project_id,
            prompt,
            agent,
            delegates,
            plan,
        } => {
            if scope.is_some() && project_id.as_deref() != scope {
                return Err(invalid(
                    "A chat started from a Project's Inbox runs in that Project",
                ));
            }
            if let Some(project_id) = project_id {
                validate_id("project_id", project_id)?;
                super::session_lifecycle::require_project(
                    connection, library_id, project_id, true,
                )?;
            }
            if delegates.len() > MAX_INBOX_DELEGATES {
                return Err(invalid("A new chat names too many delegated parts"));
            }
            let delegates = delegates
                .iter()
                .map(|delegate| {
                    let work = delegate.work.trim();
                    if work.is_empty() || work.chars().count() > MAX_INBOX_DELEGATE_WORK_CHARS {
                        return Err(invalid("A delegated part needs a short description"));
                    }
                    Ok(ProjectWorkspaceInboxDelegate {
                        work: work.to_owned(),
                        agent: normalize_chat_agent(&delegate.agent)?,
                    })
                })
                .collect::<Result<Vec<_>, StoreError>>()?;
            let plan = plan
                .as_deref()
                .map(str::trim)
                .filter(|plan| !plan.is_empty())
                .map(|plan| {
                    if plan.chars().count() > MAX_INBOX_PLAN_CHARS {
                        Err(invalid("The chat's plan is too long"))
                    } else {
                        Ok(plan.to_owned())
                    }
                })
                .transpose()?;
            Ok(ProjectWorkspaceInboxDispatchAction::NewChat {
                project_id: project_id.clone(),
                prompt: normalize_prompt(prompt)?,
                agent: agent.as_ref().map(normalize_chat_agent).transpose()?,
                delegates,
                plan,
            })
        }
        ProjectWorkspaceInboxDispatchAction::SendToChat { session_id, prompt } => {
            validate_id("session_id", session_id)?;
            let authority =
                super::session_mutation::require_session(connection, library_id, session_id)?;
            if authority.archived {
                return Err(conflict("The target chat is archived"));
            }
            if session_thread_id(connection, session_id)?.is_none() {
                return Err(conflict(
                    "The target chat has not started yet; start a new chat instead",
                ));
            }
            if scope.is_some() && authority.project_id.as_deref() != scope {
                return Err(invalid(
                    "A Project's Inbox can only send to that Project's chats",
                ));
            }
            Ok(ProjectWorkspaceInboxDispatchAction::SendToChat {
                session_id: session_id.clone(),
                prompt: normalize_prompt(prompt)?,
            })
        }
        ProjectWorkspaceInboxDispatchAction::MoveToProject { project_id } => {
            validate_id("project_id", project_id)?;
            if scope == Some(project_id.as_str()) {
                return Err(invalid("The message is already in this Project"));
            }
            super::session_lifecycle::require_project(connection, library_id, project_id, true)?;
            project_data_source(connection, library_id, project_id)?;
            Ok(ProjectWorkspaceInboxDispatchAction::MoveToProject {
                project_id: project_id.clone(),
            })
        }
    }
}

/// The primary Database's single Data Source for one active Project.
pub(super) fn project_data_source(
    connection: &Connection,
    library_id: &str,
    project_id: &str,
) -> Result<String, StoreError> {
    connection
        .query_row(
            "SELECT source.id FROM project_database_bindings binding \
             JOIN data_sources source ON source.home_database_block_id = binding.database_block_id \
               AND source.lifecycle = 'active' \
             WHERE binding.project_id = ?1 AND binding.library_id = ?2 \
               AND binding.lifecycle = 'active' \
             ORDER BY source.rank_key, source.id LIMIT 1",
            params![project_id, library_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .ok_or_else(|| not_found("The Project has no active Database"))
}

fn normalize_prompt(prompt: &str) -> Result<String, StoreError> {
    let prompt = prompt.trim();
    if prompt.is_empty() {
        return Err(invalid("A dispatch prompt cannot be empty"));
    }
    if prompt.len() > MAX_PROMPT_BYTES {
        return Err(invalid("A dispatch prompt exceeds its 32 KiB bound"));
    }
    Ok(prompt.to_owned())
}

fn bounded_text(field: &str, value: &str, maximum: usize) -> Result<String, StoreError> {
    let value = value.trim();
    if value.is_empty() {
        return Err(invalid(&format!("Inbox proposal {field} cannot be empty")));
    }
    Ok(truncate_chars(value, maximum))
}

fn failure_text(message: &str) -> String {
    let message = truncate_chars(message.trim(), MAX_MESSAGE_CHARS);
    if message.is_empty() {
        "The operation failed".to_owned()
    } else {
        message
    }
}

pub(super) fn truncate_chars(value: &str, maximum: usize) -> String {
    if value.chars().count() <= maximum {
        return value.to_owned();
    }
    let mut truncated = value
        .chars()
        .take(maximum.saturating_sub(1))
        .collect::<String>()
        .trim_end()
        .to_owned();
    truncated.push('…');
    truncated
}

pub(super) fn kind_literal(kind: ProjectWorkspaceInboxEntryKind) -> &'static str {
    match kind {
        ProjectWorkspaceInboxEntryKind::Note => "note",
        ProjectWorkspaceInboxEntryKind::Todo => "todo",
        ProjectWorkspaceInboxEntryKind::Question => "question",
    }
}

pub(super) fn parse_kind(
    value: Option<&str>,
) -> Result<Option<ProjectWorkspaceInboxEntryKind>, StoreError> {
    value
        .map(|value| match value {
            "note" => Ok(ProjectWorkspaceInboxEntryKind::Note),
            "todo" => Ok(ProjectWorkspaceInboxEntryKind::Todo),
            "question" => Ok(ProjectWorkspaceInboxEntryKind::Question),
            _ => Err(corrupt("Stored Inbox entry kind is invalid")),
        })
        .transpose()
}

fn state_literal(state: ProjectWorkspaceInboxEntryState) -> &'static str {
    match state {
        ProjectWorkspaceInboxEntryState::Open => "open",
        ProjectWorkspaceInboxEntryState::Kept => "kept",
        ProjectWorkspaceInboxEntryState::Done => "done",
    }
}

fn origin_literal(origin: ProjectWorkspaceInboxProposalOrigin) -> &'static str {
    match origin {
        ProjectWorkspaceInboxProposalOrigin::Agent => "agent",
        ProjectWorkspaceInboxProposalOrigin::User => "user",
        ProjectWorkspaceInboxProposalOrigin::Schedule => "schedule",
    }
}

pub(super) fn invalid(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message, false)
}

pub(super) fn conflict(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::Conflict, message, false)
}

pub(super) fn not_found(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::NotFound, message, false)
}

pub(super) fn corrupt(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message, false)
}

fn internal(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::Internal, message, false)
}
