//! Inbox capture, dispatch proposals, and dispatch outbox contracts.
//!
//! The Inbox is a Workspace-owned triage surface over ordinary Library Pages.
//! A Page enters it as an Inbox entry with immutable provenance. A dispatch
//! proposal is a versioned, typed suggestion for one or more entries; only an
//! explicit confirmation turns it into executable dispatch work.

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::collection::CollectionWindow;
use crate::workspace::ProjectWorkspaceThreadStatus;

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
    /// The suggestion Agent should consider this entry.
    Pending,
    /// A suggestion exists or no suggestion is wanted.
    Settled,
    /// The latest suggestion attempt failed and can be retried.
    Failed,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProjectWorkspaceInboxProposalOrigin {
    Agent,
    User,
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
    },
    /// Send a follow-up to one existing chat. Delivery waits until it is idle.
    SendToChat { session_id: String, prompt: String },
    /// Move the entries' Pages into one active Project's primary Database.
    MoveToProject { project_id: String },
}

/// Causal evidence that a proposal was made for the current message content.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ProjectWorkspaceInboxPageBasis {
    pub page_id: String,
    pub generation: i64,
    pub head_seq: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ProjectWorkspaceInboxSource {
    User,
    Agent {
        session_id: Option<String>,
        thread_id: Option<String>,
        project_id: Option<String>,
        label: String,
    },
    /// Sent through the `nodex` command line, optionally from inside a Project.
    CommandLine {
        project_id: Option<String>,
        label: String,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ProjectWorkspaceInboxLocation {
    Inbox,
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
    /// Messages the user has handled: dispatched, moved out, kept, or done.
    Processed,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ProjectWorkspaceInboxChat {
    pub session_id: String,
    pub project_id: Option<String>,
    pub project_name: Option<String>,
    pub display_title: String,
    pub thread_id: Option<String>,
    pub status: Option<ProjectWorkspaceThreadStatus>,
    pub unread: bool,
    pub archived: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ProjectWorkspaceInboxProposal {
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

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ProjectWorkspaceInboxItem {
    pub page_id: String,
    pub page_key: Option<String>,
    pub title: String,
    pub body: String,
    pub body_truncated: bool,
    pub submitted_at: String,
    pub source: ProjectWorkspaceInboxSource,
    pub kind: Option<ProjectWorkspaceInboxEntryKind>,
    pub state: ProjectWorkspaceInboxEntryState,
    pub suggestion_state: ProjectWorkspaceInboxSuggestionState,
    pub suggestion_error: Option<String>,
    pub location: ProjectWorkspaceInboxLocation,
    pub proposal: Option<ProjectWorkspaceInboxProposal>,
    pub revision: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ProjectWorkspaceInboxSummary {
    pub database_id: Option<String>,
    pub view_id: Option<String>,
    pub entry_count: u32,
    /// Messages still in the Inbox; the user's goal is to bring this to zero.
    pub inbox_count: u32,
    pub needs_decision_count: u32,
    pub pending_suggestion_count: u32,
    pub dispatching_count: u32,
}

/// One entry the suggestion Agent should consider, with bounded content.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ProjectWorkspaceInboxSuggestionInput {
    pub page_id: String,
    pub page_key: Option<String>,
    pub title: String,
    pub body: String,
    pub source: ProjectWorkspaceInboxSource,
    pub kind: Option<ProjectWorkspaceInboxEntryKind>,
    pub submitted_at: String,
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
/// no transcripts or Page bodies other than the entries being considered.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ProjectWorkspaceInboxDispatchContext {
    pub entries: Vec<ProjectWorkspaceInboxSuggestionInput>,
    pub projects: Vec<ProjectWorkspaceInboxContextProject>,
    pub sessions: Vec<ProjectWorkspaceInboxContextSession>,
    pub open_proposals: Vec<ProjectWorkspaceInboxContextProposal>,
}

/// A confirmed dispatch that the Desktop Host must deliver.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ProjectWorkspaceInboxDispatchWork {
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
