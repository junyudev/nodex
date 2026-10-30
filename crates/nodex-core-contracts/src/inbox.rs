//! Inbox capture, dispatch proposals, and dispatch outbox contracts.
//!
//! An Inbox is a Workspace-owned triage surface over ordinary Library Pages. The
//! Library has one Inbox and every Project has its own. A Page enters exactly one of
//! them as an Inbox entry with immutable provenance. A dispatch proposal is a
//! versioned, typed suggestion for one or more entries of the same Inbox; only an
//! explicit confirmation turns it into executable dispatch work.

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::collection::CollectionWindow;
use crate::workspace::{ProjectWorkspaceSessionExecutionRef, ProjectWorkspaceThreadStatus};

/// Which Inbox owns an entry's decision. It is fixed at capture and does not follow
/// the Page: a message filed into another Project stays in its own Inbox's History.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ProjectWorkspaceInboxScope {
    /// The Library Inbox, for thoughts whose Project is not known yet.
    Library,
    /// A Project's own Inbox. Its messages are Pages in the Project's Database.
    Project { project_id: String },
}

impl ProjectWorkspaceInboxScope {
    pub fn project_id(&self) -> Option<&str> {
        match self {
            Self::Library => None,
            Self::Project { project_id } => Some(project_id),
        }
    }
}

/// User-editable classification of what an Inbox entry is. It never implies
/// that work is authorized.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProjectWorkspaceInboxEntryKind {
    Note,
    Todo,
    Question,
}

/// Triage state chosen by the user. Execution state lives on proposals.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProjectWorkspaceInboxEntryState {
    Open,
    Kept,
    Done,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProjectWorkspaceInboxSuggestionState {
    /// No suggestion is requested.
    None,
    /// A send or saved stream rewrite awaits automatic suggestion preparation.
    Waiting,
    /// A suggestion request is running for this entry.
    Pending,
    /// A suggestion exists.
    Settled,
    /// The latest suggestion attempt failed and can be retried.
    Failed,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProjectWorkspaceInboxProposalOrigin {
    Agent,
    User,
    /// Written by a scheduled task for its own firing, from the user's saved definition.
    Schedule,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProjectWorkspaceInboxProposalState {
    Open,
    Superseded,
    Dismissed,
    Dispatching,
    Completed,
    Failed,
}

/// The exact action a proposal asks the user to authorize.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ProjectWorkspaceInboxDispatchAction {
    /// Keep the entries open as notes, todos, or questions.
    Keep,
    /// Start a new chat in one active Project, or a projectless chat.
    NewChat {
        project_id: Option<String>,
        prompt: String,
        /// What the chat runs on when chosen for this decision; the Inbox's own otherwise.
        #[serde(default)]
        agent: Option<ProjectWorkspaceInboxChatAgent>,
        /// Parts of the work the chat's Agent hands to other Agents.
        #[serde(default)]
        delegates: Vec<ProjectWorkspaceInboxDelegate>,
        /// How the chat's Agent should run the work, written to it.
        #[serde(default)]
        plan: Option<String>,
    },
    /// Send a follow-up to one existing chat. Delivery waits until it is idle.
    SendToChat { session_id: String, prompt: String },
    /// File the entries into one active Project: their Pages move into its primary
    /// Database and the entries are kept, without reopening there.
    MoveToProject { project_id: String },
    /// Run one waiting firing of a scheduled task. The message's reviewed text is the run's
    /// instructions; everything else comes from the task when it runs.
    RunTask {
        automation_id: String,
        dispatch_id: String,
        /// What this run uses instead of the task's own Agent selection.
        #[serde(default)]
        agent: Option<ProjectWorkspaceInboxChatAgent>,
    },
}

/// An Agent instance and, when chosen, its model, effort and speed. Unset choices use the
/// Agent's catalog default model and that model's own options.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ProjectWorkspaceInboxChatAgent {
    pub instance_id: String,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub service_tier: Option<String>,
}

/// One part of a new chat's work that its Agent delegates to another Agent.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ProjectWorkspaceInboxDelegate {
    pub work: String,
    pub agent: ProjectWorkspaceInboxChatAgent,
}

/// Fingerprint of the exact Page-body Markdown and ordered Library image content hashes.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ProjectWorkspaceInboxPageBasis {
    pub page_id: String,
    pub content_hash: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ProjectWorkspaceInboxSource {
    User,
    Agent {
        session_id: Option<String>,
        thread_id: Option<String>,
        /// The captured causal Run; absent when the native protocol cannot identify one.
        run_id: Option<String>,
        project_id: Option<String>,
        label: String,
    },
    /// Sent through the `nodex` command line, optionally from inside a Project.
    CommandLine {
        project_id: Option<String>,
        label: String,
    },
    /// A due firing of a scheduled task that asks before it runs.
    ScheduledTask {
        automation_id: String,
        dispatch_id: String,
        project_id: Option<String>,
        /// The task's name when the firing arrived.
        label: String,
    },
}

/// The firing behind a scheduled task's message, as it stands now.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ProjectWorkspaceInboxFiring {
    pub automation_id: String,
    pub dispatch_id: String,
    pub status: crate::automation::AutomationFiringStatus,
    pub first_scheduled_for_ms: i64,
    pub last_scheduled_for_ms: i64,
    /// Later firings that fell due while this one waited.
    pub missed_count: u32,
    /// Why its execution failed before reaching a chat.
    pub failure_message: Option<String>,
}

/// Where a message's Page lives, relative to the Inbox that received it.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ProjectWorkspaceInboxLocation {
    /// Still in its Inbox's home Database: the Library Inbox Database, or the
    /// Project's own Database for a Project's Inbox.
    Inbox,
    /// Filed or moved into another Database.
    Database {
        database_id: String,
        database_name: String,
        project_id: Option<String>,
        project_name: Option<String>,
    },
    Other,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProjectWorkspaceInboxWindowFilter {
    /// Messages that still need the user: undecided, being suggested, or failed.
    Inbox,
    /// Messages the user has handled: dispatched, filed, kept, or done.
    Processed,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ProjectWorkspaceInboxChat {
    pub session_id: String,
    pub project_id: Option<String>,
    pub project_name: Option<String>,
    pub display_title: String,
    pub thread_id: Option<String>,
    /// Present for Runtime-bound Sessions; their status comes from execution, not `status`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_ref: Option<ProjectWorkspaceSessionExecutionRef>,
    pub status: Option<ProjectWorkspaceThreadStatus>,
    pub unread: bool,
    pub archived: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ProjectWorkspaceInboxProposal {
    pub failure_kind: Option<ProjectWorkspaceInboxFailureKind>,
    /// Current member fingerprints, fenced when the user confirms.
    pub basis: Vec<ProjectWorkspaceInboxPageBasis>,
    /// Any current member text differs from the text this advice was written from.
    pub outdated: bool,
    pub proposal_id: String,
    pub revision: i64,
    pub origin: ProjectWorkspaceInboxProposalOrigin,
    pub state: ProjectWorkspaceInboxProposalState,
    pub page_ids: Vec<String>,
    pub action: ProjectWorkspaceInboxDispatchAction,
    pub kind: Option<ProjectWorkspaceInboxEntryKind>,
    pub summary: String,
    pub rationale: Option<String>,
    pub produced_by: Option<String>,
    /// Display context for the action's target Project.
    pub target_project_name: Option<String>,
    /// Current state of the chat named by `send_to_chat`, or the dispatched chat.
    pub chat: Option<ProjectWorkspaceInboxChat>,
    pub failure_message: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// The message Page's current workflow Status option and display name.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ProjectWorkspaceInboxPageStatus {
    pub id: String,
    pub label: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ProjectWorkspaceInboxItem {
    pub basis: ProjectWorkspaceInboxPageBasis,
    pub outcome: Option<ProjectWorkspaceInboxOutcome>,
    pub page_id: String,
    pub page_key: Option<String>,
    pub page_status: Option<ProjectWorkspaceInboxPageStatus>,
    pub title: String,
    /// The message as the stream shows it, in Nodex Markdown: the Page body when it
    /// fits the stream budget, otherwise the opening of its text as paragraphs.
    pub body: String,
    pub body_truncated: bool,
    /// The stream shows the whole body and it still has the message shape, text followed
    /// by images, so the user can rewrite it in place. Other bodies are edited as their Page.
    pub body_editable: bool,
    pub submitted_at: String,
    pub source: ProjectWorkspaceInboxSource,
    pub kind: Option<ProjectWorkspaceInboxEntryKind>,
    /// The user marked the message important, so it stays in view while it waits.
    pub important: bool,
    pub state: ProjectWorkspaceInboxEntryState,
    pub suggestion_state: ProjectWorkspaceInboxSuggestionState,
    pub suggestion_error: Option<String>,
    pub scope: ProjectWorkspaceInboxScope,
    pub location: ProjectWorkspaceInboxLocation,
    pub proposal: Option<ProjectWorkspaceInboxProposal>,
    /// Present for a scheduled task's firing.
    pub firing: Option<ProjectWorkspaceInboxFiring>,
    pub revision: i64,
}

/// The Page write that rewrites one message, prepared by Core's message rules so
/// an edit reads exactly like a message sent with the same text.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ProjectWorkspaceInboxMessageEdit {
    /// The Page state the write must still apply to.
    pub basis: ProjectWorkspaceInboxPageBasis,
    /// The new body, or None when the text did not change.
    pub body_markdown: Option<String>,
    /// The new provisional title, only while the title is still provisional.
    pub title_markdown: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ProjectWorkspaceInboxSummary {
    /// The Database new messages of this Inbox become Pages in, once it exists.
    pub database_id: Option<String>,
    pub view_id: Option<String>,
    pub entry_count: u32,
    /// Messages still in the Inbox; the user's goal is to bring this to zero.
    pub inbox_count: u32,
    pub needs_decision_count: u32,
    pub pending_suggestion_count: u32,
    pub dispatching_count: u32,
    /// Important messages still in the Inbox.
    pub important_count: u32,
    /// The longest-waiting important messages still in the Inbox, oldest first, so one
    /// out of view can be found without loading the stream back to it.
    pub important: Vec<ProjectWorkspaceInboxImportantMessage>,
}

/// An important message still waiting in its Inbox, as the stream points back to it.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ProjectWorkspaceInboxImportantMessage {
    pub page_id: String,
    /// The Page title: the sender's own, or the name the suggestion Agent gave it.
    pub title: String,
    pub submitted_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ProjectWorkspaceInboxProjectCount {
    pub project_id: String,
    pub inbox_count: u32,
}

/// Messages still waiting in each Inbox, for navigation badges.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ProjectWorkspaceInboxCounts {
    pub library_count: u32,
    /// Only active Projects whose Inbox holds at least one message.
    pub projects: Vec<ProjectWorkspaceInboxProjectCount>,
}

/// One Library image referenced by a message, in body reading order.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ProjectWorkspaceInboxMessageImage {
    pub source: String,
    pub file_id: String,
    /// Lowercase SHA-256 of the Library's stored bytes.
    pub content_hash: String,
}

/// One entry the suggestion Agent should consider, with bounded content.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ProjectWorkspaceInboxSuggestionInput {
    pub page_id: String,
    pub page_key: Option<String>,
    /// Exact body Markdown with numbered Library image markers.
    pub body: String,
    pub images: Vec<ProjectWorkspaceInboxMessageImage>,
    pub source: ProjectWorkspaceInboxSource,
    pub kind: Option<ProjectWorkspaceInboxEntryKind>,
    pub submitted_at: String,
    pub scope: ProjectWorkspaceInboxScope,
    pub basis: ProjectWorkspaceInboxPageBasis,
    /// The Page still has Core's provisional title, so the suggestion Agent may name it.
    pub title_provisional: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ProjectWorkspaceInboxContextProject {
    pub project_id: String,
    pub name: String,
    pub description: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ProjectWorkspaceInboxContextSession {
    pub session_id: String,
    pub project_id: Option<String>,
    pub title: String,
    pub preview: String,
    pub status: Option<ProjectWorkspaceThreadStatus>,
    pub recency_at: Option<i64>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ProjectWorkspaceInboxContextProposal {
    pub proposal_id: String,
    pub page_ids: Vec<String>,
    pub page_keys: Vec<String>,
    pub action: ProjectWorkspaceInboxDispatchAction,
    pub summary: String,
}

/// Bounded routing context for the suggestion Agent. It intentionally carries
/// no transcripts or Page bodies other than the entries being considered. For a
/// Project's Inbox, Projects and chats are narrowed to that Project.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ProjectWorkspaceInboxDispatchContext {
    pub scope: ProjectWorkspaceInboxScope,
    pub entries: Vec<ProjectWorkspaceInboxSuggestionInput>,
    pub projects: Vec<ProjectWorkspaceInboxContextProject>,
    pub sessions: Vec<ProjectWorkspaceInboxContextSession>,
    pub open_proposals: Vec<ProjectWorkspaceInboxContextProposal>,
}

/// A confirmed dispatch that the Desktop Host must deliver.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ProjectWorkspaceInboxDispatchWork {
    /// None only for pre-snapshot history that must be reconciled, never sent.
    pub final_text: Option<String>,
    /// Bindings to the reviewed Library image bytes, in marker order. Delivery must read
    /// bytes matching content_hash or mark the image unavailable; File heads may change.
    pub images: Vec<ProjectWorkspaceInboxMessageImage>,
    pub launch_id: String,
    pub message_id: String,
    pub execution_selection: Option<ProjectWorkspaceInboxExecutionSelection>,
    pub target_execution_ref: Option<crate::workspace::ProjectWorkspaceSessionExecutionRef>,
    pub failure_kind: Option<ProjectWorkspaceInboxFailureKind>,
    pub proposal_id: String,
    pub revision: i64,
    pub action: ProjectWorkspaceInboxDispatchAction,
    pub session_id: String,
    pub project_id: Option<String>,
    pub thread_id: Option<String>,
    pub page_ids: Vec<String>,
    pub page_keys: Vec<String>,
    pub attempt: i64,
    pub confirmed_at: String,
    /// Current status of the target chat's Thread, used to wait until it is idle.
    pub thread_status: Option<ProjectWorkspaceThreadStatus>,
    /// Runtime family of the target chat's Thread: codex, claude, opencode, or acp.
    pub thread_backend_kind: Option<String>,
}

pub type ProjectWorkspaceInboxWindow = CollectionWindow<ProjectWorkspaceInboxItem>;

/// Product decision, independent of the Page's current location.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProjectWorkspaceInboxOutcome {
    Kept,
    Done,
    Moved,
    Chat,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectWorkspaceInboxModelSelection {
    pub instance_id: String,
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<ProjectWorkspaceInboxModelOption>>,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ProjectWorkspaceInboxModelOption {
    pub id: String,
    pub value: serde_json::Value,
}
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProjectWorkspaceInboxInteractionMode {
    Default,
    Plan,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ProjectWorkspaceInboxExecutionSelection {
    pub model_selection: ProjectWorkspaceInboxModelSelection,
    pub interaction_mode: ProjectWorkspaceInboxInteractionMode,
    /// The delegation instructions written from the confirmed plan, placed after the prompt.
    #[serde(default)]
    pub orchestration: Option<String>,
}
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProjectWorkspaceInboxFailureKind {
    Rejected,
    Unavailable,
    Unknown,
}
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProjectWorkspaceInboxSuggestionMode {
    Auto,
    Grouped,
    Refine,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ProjectWorkspaceInboxSuggestionRequest {
    pub request_id: String,
    pub generation: i64,
    pub mode: ProjectWorkspaceInboxSuggestionMode,
    pub page_ids: Vec<String>,
    pub basis: Vec<ProjectWorkspaceInboxPageBasis>,
    pub proposal_id: Option<String>,
    pub expected_revision: Option<i64>,
    pub correction: Option<String>,
    pub context: ProjectWorkspaceInboxDispatchContext,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ProjectWorkspaceInboxSuggestionTitle {
    pub page_id: String,
    pub title: String,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ProjectWorkspaceInboxSuggestedDispatch {
    pub proposal_id: String,
    pub page_ids: Vec<String>,
    pub action: ProjectWorkspaceInboxDispatchAction,
    pub entry_kind: Option<ProjectWorkspaceInboxEntryKind>,
    pub summary: String,
    pub rationale: Option<String>,
}
