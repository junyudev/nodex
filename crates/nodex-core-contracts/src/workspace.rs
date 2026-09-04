use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::agent::AgentBackendBinding;
use crate::collection::{CollectionWindow, CollectionWindowRequest};
use crate::{ModuleMutationReceipt, ModuleName, VersionedModuleContract};

pub const PROJECT_WORKSPACE_CONTRACT_VERSION: u32 = 21;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ProjectWorkspaceRead {
    ProjectBootstrap,
    ProjectWindow {
        include_archived: Option<bool>,
        window: CollectionWindowRequest,
    },
    Project {
        project_id: String,
    },
    ProjectActivitySummaries {
        project_ids: Vec<String>,
    },
    PageChatActivitySummaries {
        page_access_project_id: String,
        page_ids: Vec<String>,
    },
    PageChatWindow {
        page_access_project_id: String,
        page_id: String,
        include_archived: Option<bool>,
        window: CollectionWindowRequest,
    },
    ProjectPermissionMode {
        project_id: String,
    },
    ProjectlessPermissionMode,
    TaskWindow {
        project_id: Option<String>,
        include_archived: Option<bool>,
        window: CollectionWindowRequest,
    },
    SidebarOverview {
        include_archived: Option<bool>,
        pinned_window: CollectionWindowRequest,
    },
    SidebarSectionWindow {
        include_deleted: Option<bool>,
        window: CollectionWindowRequest,
    },
    SidebarSectionItemWindow {
        section_id: String,
        include_archived: Option<bool>,
        window: CollectionWindowRequest,
    },
    SidebarSectionPlacement {
        item: ProjectWorkspaceSidebarSectionItemRef,
    },
    SidebarSectionHostLinkWindow {
        host_id: String,
        window: CollectionWindowRequest,
    },
    Session {
        session_id: String,
    },
    Thread {
        thread_id: String,
    },
    ThreadBackendSession {
        thread_id: String,
    },
    QueuedFollowUpLedger {
        thread_id: String,
    },
    ChildThreadWindow {
        parent_thread_id: String,
        include_archived: Option<bool>,
        window: CollectionWindowRequest,
    },
    SubagentOverviewWindow {
        universe: ProjectWorkspaceSubagentUniverse,
        active_window: CollectionWindowRequest,
        done_window: CollectionWindowRequest,
    },
    SubagentOverviewItem {
        universe: ProjectWorkspaceSubagentUniverse,
        thread_id: String,
    },
    SubagentLifecycleBatch {
        lifecycle_operation_id: String,
        include_settled: bool,
        window: CollectionWindowRequest,
    },
    ExecutionContext {
        thread_id: String,
    },
    TurnAuthority {
        thread_id: String,
        turn_id: String,
        root_thread_id: String,
        actor_project_id: String,
    },
    BackgroundProcessWindow {
        thread_id: Option<String>,
        window: CollectionWindowRequest,
    },
    ManagedWorktreeWindow {
        project_id: Option<String>,
        window: CollectionWindowRequest,
    },
    ManagedWorktreeLifecycleSnapshot,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ProjectWorkspaceReadValue {
    ProjectBootstrap {
        bootstrap: ProjectWorkspaceBootstrap,
    },
    ProjectWindow {
        projects: CollectionWindow<ProjectWorkspaceProject>,
    },
    Project {
        project: ProjectWorkspaceProject,
    },
    ProjectActivitySummaries {
        summaries: Vec<ProjectWorkspaceProjectActivitySummary>,
        projection_revision: i64,
    },
    PageChatActivitySummaries {
        summaries: Vec<ProjectWorkspacePageChatActivitySummary>,
        projection_revision: i64,
    },
    PageChatWindow {
        chats: CollectionWindow<ProjectWorkspacePageChatItem>,
    },
    ProjectPermissionMode {
        mode: Option<CodexPermissionMode>,
    },
    ProjectlessPermissionMode {
        mode: Option<CodexPermissionMode>,
    },
    TaskWindow {
        tasks: CollectionWindow<ProjectWorkspaceTaskSummary>,
    },
    SidebarOverview {
        pinned_tasks: CollectionWindow<ProjectWorkspaceTaskSummary>,
    },
    SidebarSectionWindow {
        sections: CollectionWindow<ProjectWorkspaceSidebarSectionSummary>,
    },
    SidebarSectionItemWindow {
        items: CollectionWindow<ProjectWorkspaceSidebarSectionItem>,
    },
    SidebarSectionPlacement {
        section_id: Option<String>,
    },
    SidebarSectionHostLinkWindow {
        links: CollectionWindow<ProjectWorkspaceSidebarSectionHostLink>,
    },
    Session {
        session: ProjectWorkspaceSessionSummary,
    },
    Thread {
        thread: Box<ProjectWorkspaceThread>,
    },
    ThreadBackendSession {
        session: Option<ProjectWorkspaceThreadBackendSession>,
    },
    QueuedFollowUpLedger {
        ledger: ProjectWorkspaceQueuedFollowUpLedger,
    },
    ChildThreadWindow {
        threads: CollectionWindow<ProjectWorkspaceThreadSummary>,
    },
    SubagentOverviewWindow {
        overview: ProjectWorkspaceSubagentOverview,
    },
    SubagentOverviewItem {
        item: Option<Box<ProjectWorkspaceSubagentOverviewItem>>,
        projection_revision: i64,
    },
    SubagentLifecycleBatch {
        lifecycle: ProjectWorkspaceSubagentLifecycle,
    },
    ExecutionContext {
        context: Box<ProjectWorkspaceExecutionContext>,
    },
    TurnAuthority {
        resolution: ProjectWorkspaceTurnAuthorityResolution,
    },
    BackgroundProcessWindow {
        processes: CollectionWindow<ProjectWorkspaceBackgroundProcess>,
    },
    ManagedWorktreeWindow {
        worktrees: CollectionWindow<ProjectWorkspaceManagedWorktreeSummary>,
    },
    ManagedWorktreeLifecycleSnapshot {
        snapshot: ProjectWorkspaceManagedWorktreeLifecycleSnapshot,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProjectWorkspaceBootstrapStatus {
    Empty,
    Ready,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ProjectWorkspaceBootstrap {
    pub status: ProjectWorkspaceBootstrapStatus,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ProjectWorkspaceThreadPlacement {
    Start,
    End,
    Default,
    Before { thread_id: String },
    After { thread_id: String },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ProjectWorkspaceThreadLane {
    Project { project_id: String },
    Projectless,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProjectWorkspaceSidebarSectionKind {
    Pinned,
    Pages,
    Projects,
    Chats,
    Custom,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProjectWorkspaceSidebarSectionLifecycle {
    Active,
    Deleted,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ProjectWorkspaceSidebarSectionSummary {
    pub section_id: String,
    pub kind: ProjectWorkspaceSidebarSectionKind,
    pub name: Option<String>,
    pub rank_key: i64,
    pub revision: i64,
    pub lifecycle: ProjectWorkspaceSidebarSectionLifecycle,
    pub direct_item_count: u32,
    pub effective_session_count: u32,
    pub has_running: bool,
    pub has_unread: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ProjectWorkspaceSidebarSectionItemRef {
    Project { project_id: String },
    Session { session_id: String },
}

impl ProjectWorkspaceSidebarSectionItemRef {
    pub fn stable_key(&self) -> String {
        match self {
            Self::Project { project_id } => format!("project:{project_id}"),
            Self::Session { session_id } => format!("session:{session_id}"),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ProjectWorkspaceSidebarSectionItemPlacement {
    Start,
    End,
    Before {
        item: ProjectWorkspaceSidebarSectionItemRef,
    },
    After {
        item: ProjectWorkspaceSidebarSectionItemRef,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ProjectWorkspaceSidebarProjectItem {
    pub project_id: String,
    pub name: String,
    pub lifecycle: ProjectLifecycle,
    pub appearance: ProjectAppearance,
    pub pinned: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ProjectWorkspaceSidebarSectionItemValue {
    Project {
        project: ProjectWorkspaceSidebarProjectItem,
    },
    Session {
        task: ProjectWorkspaceTaskSummary,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ProjectWorkspaceSidebarSectionItem {
    pub placement_id: String,
    pub rank_key: i64,
    pub revision: i64,
    pub value: ProjectWorkspaceSidebarSectionItemValue,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProjectWorkspaceSidebarSectionHostSyncState {
    Pending,
    Ready,
    DeletePending,
    Conflict,
    Unsupported,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ProjectWorkspaceSidebarSectionHostLink {
    pub section_id: String,
    pub host_id: String,
    pub remote_section_id: Option<String>,
    pub sync_state: ProjectWorkspaceSidebarSectionHostSyncState,
    pub observed_generation: i64,
    pub last_error: Option<String>,
    pub updated_at: String,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ProjectWorkspaceThreadMoveMetadataPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_host_id: Option<String>,
    #[serde(
        default,
        deserialize_with = "crate::deserialize_present",
        skip_serializing_if = "Option::is_none"
    )]
    pub cwd: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "crate::deserialize_present",
        skip_serializing_if = "Option::is_none"
    )]
    pub managed_worktree_path: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "crate::deserialize_present",
        skip_serializing_if = "Option::is_none"
    )]
    pub projectless_output_directory: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "crate::deserialize_present",
        skip_serializing_if = "Option::is_none"
    )]
    pub projectless_workspace_browser_root: Option<Option<String>>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ProjectWorkspaceThreadMoveProjectAccessGrant {
    pub expected_target_binding_revision: i64,
    pub missing_source_roots: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ProjectWorkspaceExecutionContext {
    pub thread: ProjectWorkspaceThread,
    pub project: Option<ProjectWorkspaceProject>,
    pub permission_mode: Option<CodexPermissionMode>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ProjectWorkspaceThread {
    pub thread_id: String,
    pub project_id: Option<String>,
    pub session_id: Option<String>,
    pub forked_from_id: Option<String>,
    pub parent_thread_id: Option<String>,
    pub thread_name: Option<String>,
    pub thread_source: Option<String>,
    pub service_name: Option<String>,
    pub agent_nickname: Option<String>,
    pub agent_role: Option<String>,
    pub agent_path: Option<String>,
    pub thread_preview: String,
    pub model_id: Option<String>,
    pub reasoning_effort: Option<String>,
    pub service_tier: Option<String>,
    pub backend_binding: AgentBackendBinding,
    pub execution_host_id: String,
    pub cwd: Option<String>,
    pub managed_worktree_path: Option<String>,
    pub projectless_output_directory: Option<String>,
    pub projectless_workspace_browser_root: Option<String>,
    pub status: ProjectWorkspaceThreadStatus,
    pub archived: bool,
    pub pinned_order: Option<i64>,
    pub has_unread_turn: bool,
    pub dynamic_tool_catalogs: Vec<ProjectWorkspaceDynamicToolCatalog>,
    pub writable_roots: Vec<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub recency_at: i64,
    pub linked_at: String,
}

/// Durable protocol-session identity for a non-native Agent Backend. It is
/// separate from backend instance configuration and may be cleared when a
/// backend can no longer resume the remote session.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ProjectWorkspaceThreadBackendSession {
    pub thread_id: String,
    pub backend_binding: AgentBackendBinding,
    pub backend_session_id: String,
    pub updated_at: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ProjectWorkspaceThreadStatus {
    pub status_type: CodexThreadStatusType,
    pub active_flags: Vec<CodexThreadActiveFlag>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum CodexThreadStatusType {
    NotLoaded,
    Idle,
    SystemError,
    Active,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum CodexThreadActiveFlag {
    WaitingOnApproval,
    WaitingOnUserInput,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ProjectWorkspaceSubagentUniverse {
    pub host_id: String,
    pub source_epoch: String,
    pub generation: i64,
    pub root_thread_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ProjectWorkspaceSubagentObservation {
    pub thread_id: String,
    pub parent_thread_id: String,
    pub patch: Box<ProjectWorkspaceThreadPatch>,
    pub source_revision: i64,
    pub observed_at_ms: i64,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProjectWorkspaceSubagentStatus {
    Active,
    Waiting,
    Done,
    Unknown,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProjectWorkspaceSubagentStatusEvidenceKind {
    Metadata,
    Notification,
    Completion,
    Reconciliation,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ProjectWorkspaceSubagentStatusEvidence {
    pub kind: ProjectWorkspaceSubagentStatusEvidenceKind,
    pub source_revision: i64,
    pub observed_at_ms: i64,
}

/// Optional compare-and-set guard for observations derived from an asynchronous remote read.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum ProjectWorkspaceSubagentStatusEvidencePrecondition {
    Absent,
    Exact {
        evidence_kind: ProjectWorkspaceSubagentStatusEvidenceKind,
        source_revision: i64,
        observed_at_ms: i64,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ProjectWorkspaceSubagentOverviewItem {
    pub thread: ProjectWorkspaceThreadSummary,
    pub status: ProjectWorkspaceSubagentStatus,
    pub evidence: Option<ProjectWorkspaceSubagentStatusEvidence>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ProjectWorkspaceSubagentOverview {
    pub universe: ProjectWorkspaceSubagentUniverse,
    pub active: CollectionWindow<ProjectWorkspaceSubagentOverviewItem>,
    pub done: CollectionWindow<ProjectWorkspaceSubagentOverviewItem>,
    pub known_active_count: u32,
    pub known_done_count: u32,
    pub discovery_complete: bool,
    pub discovery_continuation: Option<String>,
    pub projection_revision: i64,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProjectWorkspaceSubagentLifecycleAction {
    Archive,
    Delete,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProjectWorkspaceSubagentLifecycleOutcome {
    Pending,
    Unresolved,
    Failed,
    Settled,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ProjectWorkspaceSubagentLifecycleObservation {
    pub thread_id: String,
    pub outcome: ProjectWorkspaceSubagentLifecycleOutcome,
    pub reason: Option<String>,
    pub observed_at_ms: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ProjectWorkspaceSubagentLifecycleMember {
    pub thread_id: String,
    pub outcome: ProjectWorkspaceSubagentLifecycleOutcome,
    pub attempt_count: u32,
    pub last_reason: Option<String>,
    pub observed_at_ms: Option<i64>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ProjectWorkspaceSubagentLifecycle {
    pub universe: ProjectWorkspaceSubagentUniverse,
    pub lifecycle_operation_id: String,
    pub action: ProjectWorkspaceSubagentLifecycleAction,
    pub members: CollectionWindow<ProjectWorkspaceSubagentLifecycleMember>,
    pub expected_count: u32,
    pub processed_count: u32,
    pub unresolved_count: u32,
    pub complete: bool,
    pub projection_revision: i64,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "kebab-case")]
pub enum CodexPermissionMode {
    Auto,
    GuardianApprovals,
    FullAccess,
    Custom,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ProjectWorkspaceDynamicToolCatalog {
    pub namespace: String,
    pub toolset_revision: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ProjectWorkspaceTurnCoordinate {
    pub thread_id: String,
    pub turn_id: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProjectWorkspaceTurnAuthorityScope {
    Project,
    Library,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProjectWorkspaceTurnAuthoritySource {
    ProjectTurn,
    BuiltinFullAccess,
    InheritedBuiltinFullAccess,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ProjectWorkspaceTurnAuthority {
    pub thread_id: String,
    pub turn_id: String,
    pub root_thread_id: String,
    pub actor_project_id: String,
    pub library_id: String,
    pub store_epoch: String,
    pub scope: ProjectWorkspaceTurnAuthorityScope,
    pub source: ProjectWorkspaceTurnAuthoritySource,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ProjectWorkspaceTurnAuthorityResolution {
    pub authority: Option<ProjectWorkspaceTurnAuthority>,
    pub persisted: bool,
    /// Present only for persisted authority and stable across process restarts.
    pub frozen_at_ms: Option<i64>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "kebab-case")]
pub enum ProjectWorkspaceBackgroundProcessSource {
    AppServer,
    TerminalAction,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ProjectWorkspaceBackgroundProcess {
    pub id: String,
    pub thread_id: String,
    pub thread_title: Option<String>,
    pub item_id: String,
    pub turn_id: Option<String>,
    pub command: String,
    pub cwd: Option<String>,
    pub process_id: Option<String>,
    pub os_pid: Option<i64>,
    pub terminal_session_id: Option<String>,
    pub source: ProjectWorkspaceBackgroundProcessSource,
    pub started_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ProjectWorkspaceManagedWorktreeSummary {
    pub thread_id: String,
    pub project_id: String,
    pub session_id: Option<String>,
    pub session_title: Option<String>,
    pub thread_name: Option<String>,
    pub path: String,
    pub linked_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ProjectWorkspaceThreadExecutionLocation {
    pub execution_host_id: String,
    pub cwd: Option<String>,
    pub managed_worktree_path: Option<String>,
    pub runtime_workspace_roots: Vec<String>,
    pub projectless_output_directory: Option<String>,
    pub projectless_workspace_browser_root: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ProjectWorkspaceManagedWorktreeConsumer {
    pub thread_id: String,
    pub project_id: Option<String>,
    pub session_id: Option<String>,
    pub execution_host_id: String,
    pub cwd: Option<String>,
    pub managed_worktree_path: String,
    pub runtime_workspace_roots: Vec<String>,
    pub archived: bool,
    pub pinned_order: Option<i64>,
    pub status: ProjectWorkspaceThreadStatus,
    pub created_at: i64,
    pub updated_at: i64,
    pub linked_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ProjectWorkspaceManagedWorktreeProjectProtection {
    pub project_id: String,
    pub lifecycle: ProjectLifecycle,
    pub sources: Vec<ProjectSource>,
    pub primary_workspace_root: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ProjectWorkspaceManagedWorktreeLifecycleSnapshot {
    pub projection_revision: i64,
    pub consumers: Vec<ProjectWorkspaceManagedWorktreeConsumer>,
    pub projects: Vec<ProjectWorkspaceManagedWorktreeProjectProtection>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ProjectWorkspaceThreadPatch {
    #[serde(
        default,
        deserialize_with = "crate::deserialize_present",
        skip_serializing_if = "Option::is_none"
    )]
    pub project_id: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "crate::deserialize_present",
        skip_serializing_if = "Option::is_none"
    )]
    pub forked_from_id: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "crate::deserialize_present",
        skip_serializing_if = "Option::is_none"
    )]
    pub parent_thread_id: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "crate::deserialize_present",
        skip_serializing_if = "Option::is_none"
    )]
    pub thread_name: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "crate::deserialize_present",
        skip_serializing_if = "Option::is_none"
    )]
    pub thread_source: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "crate::deserialize_present",
        skip_serializing_if = "Option::is_none"
    )]
    pub service_name: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "crate::deserialize_present",
        skip_serializing_if = "Option::is_none"
    )]
    pub agent_nickname: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "crate::deserialize_present",
        skip_serializing_if = "Option::is_none"
    )]
    pub agent_role: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "crate::deserialize_present",
        skip_serializing_if = "Option::is_none"
    )]
    pub agent_path: Option<Option<String>>,
    pub thread_preview: Option<String>,
    #[serde(
        default,
        deserialize_with = "crate::deserialize_present",
        skip_serializing_if = "Option::is_none"
    )]
    pub model_id: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "crate::deserialize_present",
        skip_serializing_if = "Option::is_none"
    )]
    pub reasoning_effort: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "crate::deserialize_present",
        skip_serializing_if = "Option::is_none"
    )]
    pub service_tier: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backend_binding: Option<AgentBackendBinding>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_host_id: Option<String>,
    #[serde(
        default,
        deserialize_with = "crate::deserialize_present",
        skip_serializing_if = "Option::is_none"
    )]
    pub cwd: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "crate::deserialize_present",
        skip_serializing_if = "Option::is_none"
    )]
    pub managed_worktree_path: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "crate::deserialize_present",
        skip_serializing_if = "Option::is_none"
    )]
    pub projectless_output_directory: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "crate::deserialize_present",
        skip_serializing_if = "Option::is_none"
    )]
    pub projectless_workspace_browser_root: Option<Option<String>>,
    pub status: Option<ProjectWorkspaceThreadStatus>,
    pub archived: Option<bool>,
    pub created_at: Option<i64>,
    pub updated_at: Option<i64>,
    pub recency_at: Option<i64>,
    pub linked_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ProjectWorkspaceProject {
    pub id: String,
    pub library_id: String,
    pub database_id: String,
    /// Current default View of the Project's primary Database, resolved from
    /// Database authority at read time. `None` only when the Database has no
    /// active default View.
    pub default_database_view_id: Option<String>,
    pub lifecycle: ProjectLifecycle,
    pub binding_revision: i64,
    pub name: String,
    pub description: String,
    pub appearance: ProjectAppearance,
    pub sources: Vec<ProjectSource>,
    pub primary_workspace_root: Option<String>,
    pub pinned: bool,
    pub pinned_order: Option<i64>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProjectMarkerColor {
    Black,
    Red,
    Orange,
    Yellow,
    Green,
    Blue,
    Purple,
    Pink,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "kebab-case")]
pub enum ProjectMarkerIcon {
    Folder,
    CurrencyDollar,
    Book,
    GraduationCap,
    Edit,
    Writing,
    Function,
    Terminal,
    Music,
    Popcorn,
    Customize,
    Palette,
    Stethoscope,
    Health,
    Lotus,
    Suitcase,
    BarChart,
    Kettlebell,
    Dumbbell,
    Logs,
    Scale,
    DeskGlobe,
    Plane,
    Globe,
    Wrench,
    Paw,
    Flask,
    Brain,
    Heart,
    Plant,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ProjectMarker {
    Icon { icon: ProjectMarkerIcon },
    Emoji { emoji: String },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ProjectAppearance {
    pub color: ProjectMarkerColor,
    pub marker: ProjectMarker,
}

impl Default for ProjectAppearance {
    fn default() -> Self {
        Self {
            color: ProjectMarkerColor::Black,
            marker: ProjectMarker::Icon {
                icon: ProjectMarkerIcon::Folder,
            },
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ProjectWorkspaceProjectActivitySummary {
    pub project_id: String,
    pub task_count: u32,
    pub waiting_count: u32,
    pub unread_count: u32,
    pub active_count: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ProjectWorkspacePageChatActivitySummary {
    pub page_id: String,
    pub related_count: u32,
    pub working_count: u32,
    pub waiting_on_approval_count: u32,
    pub waiting_on_user_input_count: u32,
    pub error_count: u32,
    pub unread_count: u32,
    pub sole_session_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ProjectWorkspacePageChatItem {
    pub session_id: String,
    pub project_id: Option<String>,
    pub project_name: Option<String>,
    pub display_title: String,
    pub thread_id: Option<String>,
    pub thread_preview: String,
    pub status: Option<ProjectWorkspaceThreadStatus>,
    pub thread_archived: bool,
    pub unread: bool,
    pub session_archived: bool,
    pub conversation_recency_at: Option<i64>,
    pub linked_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ProjectSource {
    pub root: String,
    pub order: i64,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProjectLifecycle {
    Active,
    Inactive,
    Archived,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ProjectWorkspaceSessionSummary {
    pub id: String,
    pub project_id: Option<String>,
    pub no_thread_fallback_title: String,
    pub display_title: String,
    pub order: i64,
    pub pinned: bool,
    pub pinned_order: Option<i64>,
    pub archived: bool,
    pub archived_at: Option<String>,
    pub unread: bool,
    pub thread_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ProjectWorkspaceTaskSummary {
    pub session: ProjectWorkspaceSessionSummary,
    pub thread: Option<ProjectWorkspaceTaskThreadSummary>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ProjectWorkspaceTaskThreadSummary {
    pub thread_id: String,
    pub project_id: Option<String>,
    pub session_id: Option<String>,
    pub forked_from_id: Option<String>,
    pub parent_thread_id: Option<String>,
    pub thread_name: Option<String>,
    pub thread_source: Option<String>,
    pub service_name: Option<String>,
    pub agent_nickname: Option<String>,
    pub agent_role: Option<String>,
    pub agent_path: Option<String>,
    pub thread_preview: String,
    pub model_id: Option<String>,
    pub reasoning_effort: Option<String>,
    pub service_tier: Option<String>,
    pub backend_binding: AgentBackendBinding,
    pub execution_host_id: String,
    pub cwd: Option<String>,
    pub managed_worktree_path: Option<String>,
    pub projectless_output_directory: Option<String>,
    pub projectless_workspace_browser_root: Option<String>,
    pub status: ProjectWorkspaceThreadStatus,
    pub archived: bool,
    pub created_at: i64,
    pub updated_at: i64,
    pub recency_at: i64,
    pub linked_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ProjectWorkspaceThreadSummary {
    pub thread_id: String,
    pub project_id: Option<String>,
    pub session_id: Option<String>,
    pub forked_from_id: Option<String>,
    pub parent_thread_id: Option<String>,
    pub thread_name: Option<String>,
    pub thread_source: Option<String>,
    pub service_name: Option<String>,
    pub agent_nickname: Option<String>,
    pub agent_role: Option<String>,
    pub agent_path: Option<String>,
    pub thread_preview: String,
    pub model_id: Option<String>,
    pub reasoning_effort: Option<String>,
    pub service_tier: Option<String>,
    pub backend_binding: AgentBackendBinding,
    pub execution_host_id: String,
    pub cwd: Option<String>,
    pub managed_worktree_path: Option<String>,
    pub projectless_output_directory: Option<String>,
    pub projectless_workspace_browser_root: Option<String>,
    pub status: ProjectWorkspaceThreadStatus,
    pub archived: bool,
    pub created_at: i64,
    pub updated_at: i64,
    pub recency_at: i64,
    pub linked_at: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, ToSchema)]
pub struct ProjectWorkspaceStarterPage {
    pub page_id: String,
    pub document_id: String,
    pub title_markdown: String,
    pub nfm: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ProjectWorkspaceQueuedFollowUpPayloadRef {
    pub schema_version: u32,
    pub asset_uri: String,
    pub sha256: String,
    pub byte_length: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ProjectWorkspaceQueuedFollowUpPause {
    Interrupted { reason: String },
    Failed { reason: String },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ProjectWorkspaceQueuedFollowUpEntry {
    pub follow_up_id: String,
    pub client_user_message_id: String,
    pub created_at_ms: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pause: Option<ProjectWorkspaceQueuedFollowUpPause>,
    pub payload: ProjectWorkspaceQueuedFollowUpPayloadRef,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ProjectWorkspaceQueuedFollowUpLedger {
    pub thread_id: String,
    pub revision: i64,
    pub ledger_hash: String,
    pub entries: Vec<ProjectWorkspaceQueuedFollowUpEntry>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ProjectWorkspaceQueuedFollowUpLedgerCommit {
    pub thread_id: String,
    pub revision: i64,
    pub ledger_hash: String,
    pub changed: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ProjectWorkspaceIntent {
    CreateInitialProject {
        project_id: String,
        name: String,
        description: String,
        appearance: Option<ProjectAppearance>,
        source_roots: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        page_key_prefix: Option<String>,
        starter_page: ProjectWorkspaceStarterPage,
    },
    CreateProject {
        project_id: String,
        name: String,
        description: String,
        appearance: Option<ProjectAppearance>,
        source_roots: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        page_key_prefix: Option<String>,
    },
    UpdateProject {
        project_id: String,
        expected_binding_revision: i64,
        name: Option<String>,
        description: Option<String>,
        appearance: Option<ProjectAppearance>,
        source_roots: Option<Vec<String>>,
    },
    SetProjectLifecycle {
        project_id: String,
        lifecycle: ProjectLifecycle,
    },
    ReorderProjects {
        project_ids: Vec<String>,
    },
    ReorderPinnedProjects {
        project_ids: Vec<String>,
    },
    SetProjectPinned {
        project_id: String,
        pinned: bool,
    },
    CreateSidebarSection {
        section_id: String,
        name: String,
        initial_item: Option<ProjectWorkspaceSidebarSectionItemRef>,
    },
    RenameSidebarSection {
        section_id: String,
        name: String,
        expected_revision: i64,
    },
    DeleteSidebarSection {
        section_id: String,
        expected_revision: i64,
    },
    RestoreSidebarSection {
        section_id: String,
        expected_revision: i64,
    },
    MoveSidebarSectionItem {
        item: ProjectWorkspaceSidebarSectionItemRef,
        section_id: Option<String>,
        placement: ProjectWorkspaceSidebarSectionItemPlacement,
    },
    ReorderSidebarSectionSessions {
        section_id: String,
        session_ids: Vec<String>,
    },
    ReorderSidebarSections {
        section_ids: Vec<String>,
    },
    ArchiveSidebarSectionSessions {
        section_id: String,
        replacement_session_id: Option<String>,
    },
    UpsertSidebarSectionHostLink {
        link: ProjectWorkspaceSidebarSectionHostLink,
    },
    DeleteSidebarSectionHostLink {
        section_id: String,
        host_id: String,
    },
    CreateSession {
        session_id: String,
        project_id: Option<String>,
        title: String,
        initial_page_ids: Vec<String>,
    },
    CreateSessionInSidebarSection {
        session_id: String,
        section_id: String,
        title: String,
        initial_page_ids: Vec<String>,
    },
    EnsureDefaultDraftSession {
        session_id: String,
        project_id: Option<String>,
        title: String,
    },
    DeleteSession {
        session_id: String,
    },
    MoveSession {
        session_id: String,
        project_id: Option<String>,
    },
    ReorderSessions {
        project_id: Option<String>,
        session_ids: Vec<String>,
    },
    ReorderPinnedSessions {
        project_id: Option<String>,
        session_ids: Vec<String>,
    },
    UpsertThread {
        thread_id: String,
        patch: Box<ProjectWorkspaceThreadPatch>,
    },
    UpdateThread {
        thread_id: String,
        patch: Box<ProjectWorkspaceThreadPatch>,
    },
    SetThreadExecutionLocation {
        thread_id: String,
        location: ProjectWorkspaceThreadExecutionLocation,
    },
    BindThreadBackendSession {
        thread_id: String,
        backend_binding: AgentBackendBinding,
        backend_session_id: String,
    },
    ClearThreadBackendSession {
        thread_id: String,
        backend_binding: AgentBackendBinding,
    },
    DeleteThread {
        thread_id: String,
    },
    RetainThreadAssets {
        thread_id: String,
        prepared_blob_receipt_ids: Vec<String>,
    },
    CommitQueuedFollowUpLedger {
        thread_id: String,
        expected_revision: i64,
        entries: Vec<ProjectWorkspaceQueuedFollowUpEntry>,
        prepared_blob_receipt_ids: Vec<String>,
    },
    ObserveAppServerThreadWindow {
        sweep_id: String,
        thread_ids: Vec<String>,
    },
    ReconcileAppServerThreadSweep {
        sweep_id: String,
        limit: Option<u32>,
    },
    ObserveSubagentDiscoveryPage {
        universe: ProjectWorkspaceSubagentUniverse,
        page_identity: String,
        observations: Vec<ProjectWorkspaceSubagentObservation>,
        continuation: Option<String>,
        complete: bool,
    },
    ObserveSubagentStatusEvidence {
        universe: ProjectWorkspaceSubagentUniverse,
        thread_id: String,
        status: ProjectWorkspaceSubagentStatus,
        evidence_kind: ProjectWorkspaceSubagentStatusEvidenceKind,
        source_revision: i64,
        observed_at_ms: i64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        precondition: Option<ProjectWorkspaceSubagentStatusEvidencePrecondition>,
    },
    BufferSubagentStatusEvidence {
        host_id: String,
        source_epoch: String,
        generation: i64,
        thread_id: String,
        status: ProjectWorkspaceSubagentStatus,
        evidence_kind: ProjectWorkspaceSubagentStatusEvidenceKind,
        source_revision: i64,
        observed_at_ms: i64,
    },
    BeginSubagentLifecycle {
        universe: ProjectWorkspaceSubagentUniverse,
        lifecycle_operation_id: String,
        action: ProjectWorkspaceSubagentLifecycleAction,
    },
    ObserveSubagentLifecycleOutcomes {
        lifecycle_operation_id: String,
        observations: Vec<ProjectWorkspaceSubagentLifecycleObservation>,
    },
    SetThreadArchived {
        thread_id: String,
        archived: bool,
    },
    SetThreadPinned {
        thread_id: String,
        pinned: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        placement: Option<ProjectWorkspaceThreadPlacement>,
    },
    ReorderPinnedThreads {
        thread_ids: Vec<String>,
    },
    MoveThread {
        thread_id: String,
        source: ProjectWorkspaceThreadLane,
        target: ProjectWorkspaceThreadLane,
        placement: ProjectWorkspaceThreadPlacement,
        metadata: ProjectWorkspaceThreadMoveMetadataPatch,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        runtime_workspace_roots: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        project_access_grant: Option<ProjectWorkspaceThreadMoveProjectAccessGrant>,
    },
    SetThreadUnread {
        thread_id: String,
        unread: bool,
    },
    ReplaceThreadDynamicToolCatalogs {
        thread_id: String,
        catalogs: Vec<ProjectWorkspaceDynamicToolCatalog>,
    },
    MergeThreadWritableRoots {
        thread_id: String,
        roots: Vec<String>,
    },
    ReplaceThreadWritableRoots {
        thread_id: String,
        roots: Vec<String>,
    },
    FreezeTurnAuthority {
        thread_id: String,
        turn_id: String,
        root_thread_id: String,
        actor_project_id: String,
        source: ProjectWorkspaceTurnAuthoritySource,
        inherited_from: Option<ProjectWorkspaceTurnCoordinate>,
    },
    UpsertBackgroundProcess {
        process: ProjectWorkspaceBackgroundProcess,
        preserve_started_at: Option<bool>,
    },
    SetProjectPermissionMode {
        project_id: String,
        mode: CodexPermissionMode,
    },
    SetProjectlessPermissionMode {
        mode: CodexPermissionMode,
    },
    MutateSession {
        session_id: String,
        intent: ProjectSessionIntent,
    },
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ProjectSessionIntent {
    Rename {
        title: String,
    },
    SetPinned {
        pinned: bool,
    },
    SetUnread {
        unread: bool,
    },
    SetArchived {
        archived: bool,
    },
    SetFallbackTitle {
        title: String,
    },
    LinkThread {
        thread_id: String,
        expected_project_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        thread_patch: Option<Box<ProjectWorkspaceThreadPatch>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        execution_location: Option<Box<ProjectWorkspaceThreadExecutionLocation>>,
    },
    UnlinkThread {
        thread_id: String,
    },
    LinkPage {
        page_id: String,
        page_access_project_id: String,
    },
    UnlinkPage {
        page_id: String,
        page_access_project_id: String,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ProjectWorkspaceCommitValue {
    pub affected_project_ids: Vec<String>,
    pub affected_session_ids: Vec<String>,
    pub affected_thread_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub queued_follow_up_ledger: Option<ProjectWorkspaceQueuedFollowUpLedgerCommit>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ProjectWorkspaceReceipt {
    #[serde(flatten)]
    pub mutation: ModuleMutationReceipt,
    pub affected_project_ids: Vec<String>,
    pub affected_session_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ProjectWorkspaceEvent {
    pub kind: ProjectWorkspaceEventKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_catalog_change: Option<ProjectCatalogChangeKind>,
    pub project_ids: Vec<String>,
    pub session_ids: Vec<String>,
    pub thread_ids: Vec<String>,
    pub session_summary_scopes: Vec<ProjectSessionInvalidationScope>,
    pub session_detail_ids: Vec<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProjectCatalogChangeKind {
    Created,
    MetadataUpdated,
    SourcesUpdated,
    LifecycleUpdated,
    Reordered,
    PinUpdated,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ProjectSessionInvalidationScope {
    Project { project_id: String },
    Projectless,
    All,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProjectWorkspaceEventKind {
    WorkspaceChanged,
}

pub struct ProjectWorkspaceContract;

impl VersionedModuleContract for ProjectWorkspaceContract {
    type Read = ProjectWorkspaceRead;
    type Snapshot = ProjectWorkspaceReadValue;
    type Intent = ProjectWorkspaceIntent;
    type Receipt = ProjectWorkspaceReceipt;
    type Event = ProjectWorkspaceEvent;

    const VERSION: u32 = PROJECT_WORKSPACE_CONTRACT_VERSION;
    const MODULE: ModuleName = ModuleName::ProjectWorkspace;
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{
        ProjectAppearance, ProjectMarker, ProjectMarkerColor, ProjectMarkerIcon,
        ProjectWorkspaceIntent, ProjectWorkspaceQueuedFollowUpEntry,
        ProjectWorkspaceQueuedFollowUpPause, ProjectWorkspaceQueuedFollowUpPayloadRef,
        ProjectWorkspaceThreadLane, ProjectWorkspaceThreadPlacement,
    };

    #[test]
    fn project_appearance_has_a_closed_tagged_wire_contract() {
        let value = serde_json::to_value(ProjectAppearance {
            color: ProjectMarkerColor::Purple,
            marker: ProjectMarker::Icon {
                icon: ProjectMarkerIcon::CurrencyDollar,
            },
        })
        .expect("Project appearance");
        assert_eq!(
            value,
            json!({
                "color": "purple",
                "marker": {
                    "kind": "icon",
                    "icon": "currency-dollar"
                }
            })
        );
        assert!(
            serde_json::from_value::<ProjectAppearance>(json!({
                "color": "chartreuse",
                "marker": { "kind": "icon", "icon": "folder" }
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<ProjectAppearance>(json!({
                "color": "black",
                "marker": { "kind": "icon", "icon": "unknown" }
            }))
            .is_err()
        );
    }

    #[test]
    fn thread_patch_distinguishes_absence_from_an_explicit_clear() {
        let intent = serde_json::from_value::<ProjectWorkspaceIntent>(json!({
            "kind": "upsert_thread",
            "thread_id": "thread-1",
            "patch": {
                "project_id": null,
                "managed_worktree_path": null,
                "status": {
                    "status_type": "active",
                    "active_flags": ["waitingOnApproval"]
                }
            }
        }))
        .expect("presence-sensitive Thread patch");
        let ProjectWorkspaceIntent::UpsertThread { patch, .. } = intent else {
            panic!("upsert Thread intent");
        };
        assert_eq!(patch.project_id, Some(None));
        assert_eq!(patch.managed_worktree_path, Some(None));
        assert_eq!(patch.cwd, None);

        let encoded = serde_json::to_value(ProjectWorkspaceIntent::UpsertThread {
            thread_id: "thread-1".to_owned(),
            patch,
        })
        .expect("Thread patch round trip");
        assert_eq!(encoded["patch"]["project_id"], serde_json::Value::Null);
        assert!(encoded["patch"].get("cwd").is_none());
    }

    #[test]
    fn sidebar_intents_encode_explicit_lane_order_and_presence_semantics() {
        let intent = serde_json::from_value::<ProjectWorkspaceIntent>(json!({
            "kind": "move_thread",
            "thread_id": "thread-1",
            "source": { "kind": "projectless" },
            "target": { "kind": "project", "project_id": "project-1" },
            "placement": { "kind": "before", "thread_id": "thread-2" },
            "metadata": {
                "cwd": null,
                "managed_worktree_path": "/tmp/worktree"
            }
        }))
        .expect("explicit Thread move contract");
        let ProjectWorkspaceIntent::MoveThread {
            source,
            target,
            placement,
            metadata,
            runtime_workspace_roots,
            project_access_grant,
            ..
        } = intent
        else {
            panic!("move Thread intent");
        };
        assert_eq!(source, ProjectWorkspaceThreadLane::Projectless);
        assert_eq!(
            target,
            ProjectWorkspaceThreadLane::Project {
                project_id: "project-1".to_owned(),
            }
        );
        assert_eq!(
            placement,
            ProjectWorkspaceThreadPlacement::Before {
                thread_id: "thread-2".to_owned(),
            }
        );
        assert_eq!(metadata.cwd, Some(None));
        assert_eq!(
            metadata.managed_worktree_path,
            Some(Some("/tmp/worktree".to_owned()))
        );
        assert_eq!(metadata.projectless_output_directory, None);
        assert_eq!(runtime_workspace_roots, None);
        assert_eq!(project_access_grant, None);

        let after = serde_json::to_value(ProjectWorkspaceThreadPlacement::After {
            thread_id: "thread-2".to_owned(),
        })
        .expect("after placement");
        assert_eq!(after, json!({ "kind": "after", "thread_id": "thread-2" }));
    }

    #[test]
    fn page_backed_session_contract_requires_explicit_initial_page_ids() {
        assert!(
            serde_json::from_value::<ProjectWorkspaceIntent>(json!({
                "kind": "create_session",
                "session_id": "session-1",
                "project_id": "project-1",
                "title": "Page chat"
            }))
            .is_err()
        );
        let intent = serde_json::from_value::<ProjectWorkspaceIntent>(json!({
            "kind": "create_session",
            "session_id": "session-1",
            "project_id": "project-1",
            "title": "Page chat",
            "initial_page_ids": ["page-1"]
        }))
        .expect("Page-backed Session contract");
        assert_eq!(
            intent,
            ProjectWorkspaceIntent::CreateSession {
                session_id: "session-1".to_owned(),
                project_id: Some("project-1".to_owned()),
                title: "Page chat".to_owned(),
                initial_page_ids: vec!["page-1".to_owned()],
            }
        );
    }

    #[test]
    fn queued_follow_up_contract_keeps_queue_and_wire_identities_distinct() {
        let intent = ProjectWorkspaceIntent::CommitQueuedFollowUpLedger {
            prepared_blob_receipt_ids: Vec::new(),
            thread_id: "thread-1".to_owned(),
            expected_revision: 7,
            entries: vec![ProjectWorkspaceQueuedFollowUpEntry {
                follow_up_id: "follow-up-1".to_owned(),
                client_user_message_id: "message-1".to_owned(),
                created_at_ms: 42,
                pause: Some(ProjectWorkspaceQueuedFollowUpPause::Interrupted {
                    reason: "Interrupted before the steer was accepted.".to_owned(),
                }),
                payload: ProjectWorkspaceQueuedFollowUpPayloadRef {
                    schema_version: 2,
                    asset_uri: format!("nodex://assets/{}.blob", "a".repeat(64)),
                    sha256: "a".repeat(64),
                    byte_length: 123,
                },
            }],
        };
        let encoded = serde_json::to_value(intent).expect("queued follow-up intent");
        assert_eq!(encoded["kind"], "commit_queued_follow_up_ledger");
        assert_eq!(encoded["entries"][0]["follow_up_id"], "follow-up-1");
        assert_eq!(encoded["entries"][0]["client_user_message_id"], "message-1");
        assert_eq!(encoded["entries"][0]["pause"]["kind"], "interrupted");
        assert_eq!(encoded["entries"][0]["payload"]["schema_version"], 2);
    }
}
