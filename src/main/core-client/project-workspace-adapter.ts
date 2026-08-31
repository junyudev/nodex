import type {
  CodexBackgroundProcessRecord,
  CodexPermissionMode,
  CodexThreadActiveFlag,
  CodexThreadStatusType,
  CodexThreadSummary,
  Project,
  PageChatActivitySummary,
  PageChatItem,
  ProjectCreateInput,
  ProjectSession,
  ProjectSessionSummary,
  ProjectSessionThreadSummary,
  ProjectSessionThreadLink,
} from "../../shared/types";
import type { CodexExecutionProfile } from "../../shared/codex-execution-profile";
import type { AgentBackendBinding } from "../../shared/agent-backend";
import { normalizeCodexServiceTier } from "../../shared/codex-service-tier";
import type { DynamicToolCatalogSelection } from "../codex/dynamic-tool-registry";
import type {
  SidebarSectionItem,
  SidebarSectionItemRef,
  SidebarSectionSummary,
} from "../../shared/sidebar-sections";
import type { ProjectWorkspaceReadSnapshot } from "./types";

type CoreProject = Extract<
  ProjectWorkspaceReadSnapshot["value"],
  { kind: "project_window" }
>["projects"]["items"][number];
type CoreSessionSummary = Extract<
  ProjectWorkspaceReadSnapshot["value"],
  { kind: "session" }
>["session"];
type CoreTask = Extract<
  ProjectWorkspaceReadSnapshot["value"],
  { kind: "task_window" }
>["tasks"]["items"][number];
type CoreTaskThread = NonNullable<CoreTask["thread"]>;
type CoreThread = Extract<ProjectWorkspaceReadSnapshot["value"], { kind: "thread" }>["thread"];
type CoreThreadBackendSession = Extract<
  ProjectWorkspaceReadSnapshot["value"],
  { kind: "thread_backend_session" }
>["session"];
type CoreBackgroundProcess = Extract<
  ProjectWorkspaceReadSnapshot["value"],
  { kind: "background_process_window" }
>["processes"]["items"][number];
type CorePageChatActivitySummary = Extract<
  ProjectWorkspaceReadSnapshot["value"],
  { kind: "page_chat_activity_summaries" }
>["summaries"][number];
type CorePageChatItem = Extract<
  ProjectWorkspaceReadSnapshot["value"],
  { kind: "page_chat_window" }
>["chats"]["items"][number];
type CoreSidebarSectionSummary = Extract<
  ProjectWorkspaceReadSnapshot["value"],
  { kind: "sidebar_section_window" }
>["sections"]["items"][number];
type CoreSidebarSectionItem = Extract<
  ProjectWorkspaceReadSnapshot["value"],
  { kind: "sidebar_section_item_window" }
>["items"]["items"][number];

type CoreAgentBackendBinding = CoreThread["backend_binding"];

export const projectAgentBackendBindingFromCore = (
  binding: CoreAgentBackendBinding,
): AgentBackendBinding =>
  binding.kind === "codex"
    ? { kind: "codex" }
    : {
        kind: "acp",
        agentDefinitionId: binding.agent_definition_id,
        instanceConfigId: binding.instance_config_id ?? null,
      };

export const projectAgentBackendBindingToCore = (binding: AgentBackendBinding) =>
  binding.kind === "codex"
    ? { kind: "codex" as const }
    : {
        kind: "acp" as const,
        agent_definition_id: binding.agentDefinitionId,
        instance_config_id: binding.instanceConfigId,
      };

export const projectWorkspaceSidebarSectionSummaryFromCore = (
  section: CoreSidebarSectionSummary,
): SidebarSectionSummary => ({
  sectionId: section.section_id,
  kind: section.kind,
  name: section.name ?? null,
  rankKey: section.rank_key,
  revision: section.revision,
  lifecycle: section.lifecycle,
  directItemCount: section.direct_item_count,
  effectiveSessionCount: section.effective_session_count,
  hasRunning: section.has_running,
  hasUnread: section.has_unread,
});

export const projectWorkspaceSidebarSectionItemFromCore = (
  item: CoreSidebarSectionItem,
): SidebarSectionItem =>
  item.value.kind === "project"
    ? {
        placementId: item.placement_id,
        rankKey: item.rank_key,
        revision: item.revision,
        kind: "project",
        project: {
          projectId: item.value.project.project_id,
          name: item.value.project.name,
          lifecycle: item.value.project.lifecycle,
          appearance: item.value.project.appearance,
          pinned: item.value.project.pinned,
        },
      }
    : {
        placementId: item.placement_id,
        rankKey: item.rank_key,
        revision: item.revision,
        kind: "session",
        session: projectWorkspaceTaskFromCore(item.value.task),
      };

export const projectWorkspaceSidebarSectionItemRefToCore = (item: SidebarSectionItemRef) =>
  item.kind === "project"
    ? { kind: "project" as const, project_id: item.projectId }
    : { kind: "session" as const, session_id: item.sessionId };
export interface DesktopProjectWorkspaceThread {
  readonly threadId: string;
  readonly projectId: string | null;
  readonly sessionId: string | null;
  readonly forkedFromId: string | null;
  readonly parentThreadId: string | null;
  readonly threadSource: CodexThreadSummary["threadSource"];
  readonly serviceName: string | null;
  readonly agentNickname: string | null;
  readonly agentRole: string | null;
  readonly agentPath: string | null;
  readonly threadName: string | null;
  readonly threadPreview: string;
  readonly executionProfile?: CodexExecutionProfile | null;
  readonly backendBinding: AgentBackendBinding;
  readonly executionHostId: string;
  readonly cwd: string | null;
  readonly managedWorktreePath: string | null;
  readonly projectlessOutputDirectory: string | null;
  readonly projectlessWorkspaceBrowserRoot: string | null;
  readonly statusType: ProjectSessionThreadLink["statusType"];
  readonly statusActiveFlags: ProjectSessionThreadLink["statusActiveFlags"];
  readonly archived: boolean;
  readonly pinnedOrder: number | null;
  readonly hasUnreadTurn: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly recencyAt: number;
  readonly linkedAt: string;
}

export const projectWorkspacePageChatActivitySummaryFromCore = (
  summary: CorePageChatActivitySummary,
): PageChatActivitySummary => ({
  pageId: summary.page_id,
  relatedCount: summary.related_count,
  workingCount: summary.working_count,
  waitingOnApprovalCount: summary.waiting_on_approval_count,
  waitingOnUserInputCount: summary.waiting_on_user_input_count,
  errorCount: summary.error_count,
  unreadCount: summary.unread_count,
  soleSessionId: summary.sole_session_id ?? null,
});

export const projectWorkspacePageChatItemFromCore = (item: CorePageChatItem): PageChatItem => ({
  sessionId: item.session_id,
  projectId: item.project_id ?? null,
  projectName: item.project_name ?? null,
  displayTitle: item.display_title,
  threadId: item.thread_id ?? null,
  threadPreview: item.thread_preview,
  threadStatus: item.status
    ? {
        statusType: item.status.status_type,
        activeFlags: [...item.status.active_flags],
      }
    : null,
  threadArchived: item.thread_archived,
  unread: item.unread,
  sessionArchived: item.session_archived,
  conversationRecencyAt: item.conversation_recency_at ?? null,
  linkedAt: item.linked_at,
});

export interface DesktopProjectWorkspaceThreadPatch {
  readonly projectId?: string | null;
  readonly forkedFromId?: string | null;
  readonly parentThreadId?: string | null;
  readonly threadName?: string | null;
  readonly threadSource?: CodexThreadSummary["threadSource"];
  readonly serviceName?: string | null;
  readonly agentNickname?: string | null;
  readonly agentRole?: string | null;
  readonly agentPath?: string | null;
  readonly threadPreview?: string;
  readonly executionProfile?: CodexExecutionProfile | null;
  readonly backendBinding?: AgentBackendBinding;
  readonly executionHostId?: string;
  readonly cwd?: string | null;
  readonly managedWorktreePath?: string | null;
  readonly projectlessOutputDirectory?: string | null;
  readonly projectlessWorkspaceBrowserRoot?: string | null;
  readonly status?: {
    readonly statusType: CodexThreadStatusType;
    readonly activeFlags: readonly CodexThreadActiveFlag[];
  };
  readonly archived?: boolean;
  readonly createdAt?: number;
  readonly updatedAt?: number;
  readonly recencyAt?: number;
  readonly linkedAt?: string;
}

export interface DesktopProjectWorkspaceThreadMoveInput {
  readonly threadId: string;
  readonly sourceProjectId: string | null;
  readonly targetProjectId: string | null;
  readonly beforeThreadId?: string | null;
  readonly afterThreadId?: string | null;
  readonly insertAtEnd?: boolean;
  readonly useDefaultOrder?: boolean;
  readonly runtimeWorkspaceRoots?: readonly string[];
  readonly projectAccessGrant?: {
    readonly expectedTargetBindingRevision: number;
    readonly missingProjectSources: readonly string[];
  };
  readonly metadata?: Pick<
    DesktopProjectWorkspaceThreadPatch,
    | "cwd"
    | "executionHostId"
    | "managedWorktreePath"
    | "projectlessOutputDirectory"
    | "projectlessWorkspaceBrowserRoot"
  >;
}

export interface DesktopProjectWorkspaceExecutionLocation {
  readonly executionHostId: string;
  readonly cwd: string | null;
  readonly managedWorktreePath: string | null;
  readonly runtimeWorkspaceRoots: readonly string[];
  readonly projectlessOutputDirectory: string | null;
  readonly projectlessWorkspaceBrowserRoot: string | null;
}

export interface DesktopProjectWorkspaceThreadBackendSession {
  readonly threadId: string;
  readonly backendBinding: Extract<AgentBackendBinding, { readonly kind: "acp" }>;
  readonly backendSessionId: string;
  readonly updatedAt: number;
}

export const projectWorkspaceThreadBackendSessionFromCore = (
  session: NonNullable<CoreThreadBackendSession>,
): DesktopProjectWorkspaceThreadBackendSession => {
  const backendBinding = projectAgentBackendBindingFromCore(session.backend_binding);
  if (backendBinding.kind !== "acp") {
    throw new Error("Core returned a native backend protocol session");
  }
  return {
    threadId: session.thread_id,
    backendBinding,
    backendSessionId: session.backend_session_id,
    updatedAt: session.updated_at,
  };
};

export const projectWorkspaceThreadBackendSessionRead = (threadId: string) => ({
  kind: "thread_backend_session" as const,
  thread_id: threadId,
});

export const projectWorkspaceBindThreadBackendSessionIntent = (input: {
  readonly threadId: string;
  readonly backendBinding: Extract<AgentBackendBinding, { readonly kind: "acp" }>;
  readonly backendSessionId: string;
}) => ({
  kind: "bind_thread_backend_session" as const,
  thread_id: input.threadId,
  backend_binding: projectAgentBackendBindingToCore(input.backendBinding),
  backend_session_id: input.backendSessionId,
});

export const projectWorkspaceClearThreadBackendSessionIntent = (input: {
  readonly threadId: string;
  readonly backendBinding: Extract<AgentBackendBinding, { readonly kind: "acp" }>;
}) => ({
  kind: "clear_thread_backend_session" as const,
  thread_id: input.threadId,
  backend_binding: projectAgentBackendBindingToCore(input.backendBinding),
});

export interface DesktopProjectWorkspaceSidebar {
  readonly threads: readonly DesktopProjectWorkspaceThread[];
}

export interface DesktopProjectWorkspaceExecutionContext {
  readonly threadId: string;
  readonly projectId: string | null;
  readonly permissionMode: CodexPermissionMode | null;
  readonly dynamicToolCatalogs: readonly DynamicToolCatalogSelection[];
  readonly writableRoots: readonly string[];
}

export interface DesktopManagedWorktreeSummary {
  readonly threadId: string;
  readonly projectId: string;
  readonly sessionId: string | null;
  readonly sessionTitle: string | null;
  readonly threadName: string | null;
  readonly path: string;
  readonly linkedAt: string;
}

export interface DesktopManagedWorktreeWindow {
  readonly items: readonly DesktopManagedWorktreeSummary[];
  readonly nextCursor: string | null;
  readonly projectionRevision: number;
}

export interface DesktopManagedWorktreeLifecycleConsumer {
  readonly threadId: string;
  readonly projectId: string | null;
  readonly sessionId: string | null;
  readonly executionHostId: string;
  readonly cwd: string | null;
  readonly managedWorktreePath: string;
  readonly runtimeWorkspaceRoots: readonly string[];
  readonly archived: boolean;
  readonly pinnedOrder: number | null;
  readonly statusType: CodexThreadStatusType;
  readonly statusActiveFlags: readonly CodexThreadActiveFlag[];
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly linkedAt: string;
}

export interface DesktopManagedWorktreeProjectProtection {
  readonly projectId: string;
  readonly lifecycle: Project["lifecycle"];
  readonly sourceRoots: readonly string[];
  readonly primaryWorkspaceRoot: string | null;
}

export interface DesktopManagedWorktreeLifecycleSnapshot {
  readonly projectionRevision: number;
  readonly consumers: readonly DesktopManagedWorktreeLifecycleConsumer[];
  readonly projects: readonly DesktopManagedWorktreeProjectProtection[];
}

export interface DesktopAppServerSweepReconcileResult {
  readonly threadIds: readonly string[];
  readonly projectIds: readonly string[];
}

export interface DesktopProjectBootstrap {
  readonly status: "empty" | "ready";
}

export interface DesktopInitialProjectStarterPage {
  readonly pageId: string;
  readonly documentId: string;
  readonly titleMarkdown: string;
  readonly nfm: string;
}

export interface DesktopInitialProjectCreateInput extends ProjectCreateInput {
  readonly operationId: string;
  readonly projectId: string;
  readonly starterPage: DesktopInitialProjectStarterPage;
}

export interface DesktopInitialProjectCreateResult {
  readonly project: Project;
}

export const projectWorkspaceProjectFromCore = (project: CoreProject): Project => ({
  id: project.id,
  libraryId: project.library_id,
  databaseId: project.database_id,
  defaultDatabaseViewId: project.default_database_view_id ?? null,
  lifecycle: project.lifecycle,
  bindingRevision: project.binding_revision,
  name: project.name,
  description: project.description,
  appearance: project.appearance,
  sources: project.sources.map((source) => ({
    root: source.root,
    order: source.order,
  })),
  primaryWorkspaceRoot: project.primary_workspace_root ?? null,
  pinned: project.pinned,
  pinnedOrder: project.pinned_order ?? null,
  created: new Date(project.created_at),
  updated: new Date(project.updated_at),
});

export const projectWorkspaceSessionThreadFromCore = (
  thread: CoreThread,
  sessionId: string,
  sessionProjectId: string | null,
): ProjectSessionThreadLink => ({
  sessionId,
  projectId: thread.project_id ?? sessionProjectId,
  threadId: thread.thread_id,
  forkedFromId: thread.forked_from_id ?? null,
  parentThreadId: thread.parent_thread_id ?? undefined,
  threadSource: thread.thread_source ?? null,
  serviceName: thread.service_name ?? null,
  agentNickname: thread.agent_nickname ?? null,
  agentRole: thread.agent_role ?? null,
  agentPath: thread.agent_path ?? null,
  threadName: thread.thread_name ?? undefined,
  threadPreview: thread.thread_preview,
  executionProfile: thread.model_id
    ? {
        modelId: thread.model_id,
        reasoningEffort: thread.reasoning_effort ?? null,
        serviceTier: normalizeCodexServiceTier(thread.service_tier),
      }
    : null,
  backendBinding: projectAgentBackendBindingFromCore(thread.backend_binding),
  executionHostId: thread.execution_host_id,
  cwd: thread.cwd ?? undefined,
  managedWorktreePath: thread.managed_worktree_path ?? null,
  projectlessOutputDirectory: thread.projectless_output_directory ?? null,
  projectlessWorkspaceBrowserRoot: thread.projectless_workspace_browser_root ?? null,
  statusType: thread.status.status_type,
  statusActiveFlags: [...thread.status.active_flags],
  archived: thread.archived,
  createdAt: thread.created_at,
  updatedAt: thread.updated_at,
  recencyAt: thread.recency_at,
  linkedAt: thread.linked_at,
});

const fromCoreTaskThread = (
  thread: CoreTaskThread,
  sessionId: string,
  sessionProjectId: string | null,
): ProjectSessionThreadSummary => ({
  sessionId,
  projectId: thread.project_id ?? sessionProjectId,
  threadId: thread.thread_id,
  forkedFromId: thread.forked_from_id ?? null,
  parentThreadId: thread.parent_thread_id ?? undefined,
  threadSource: thread.thread_source ?? null,
  serviceName: thread.service_name ?? null,
  agentNickname: thread.agent_nickname ?? null,
  agentRole: thread.agent_role ?? null,
  agentPath: thread.agent_path ?? null,
  threadName: thread.thread_name ?? undefined,
  threadPreview: thread.thread_preview,
  executionProfile: thread.model_id
    ? {
        modelId: thread.model_id,
        reasoningEffort: thread.reasoning_effort ?? null,
        serviceTier: normalizeCodexServiceTier(thread.service_tier),
      }
    : null,
  backendBinding: projectAgentBackendBindingFromCore(thread.backend_binding),
  executionHostId: thread.execution_host_id,
  cwd: thread.cwd ?? undefined,
  managedWorktreePath: thread.managed_worktree_path ?? null,
  projectlessOutputDirectory: thread.projectless_output_directory ?? null,
  projectlessWorkspaceBrowserRoot: thread.projectless_workspace_browser_root ?? null,
  statusType: thread.status.status_type,
  statusActiveFlags: [...thread.status.active_flags],
  archived: thread.archived,
  createdAt: thread.created_at,
  updatedAt: thread.updated_at,
  recencyAt: thread.recency_at,
  linkedAt: thread.linked_at,
});

export const projectWorkspaceBackgroundProcessFromCore = (
  process: CoreBackgroundProcess,
): CodexBackgroundProcessRecord => ({
  id: process.id,
  threadId: process.thread_id,
  threadTitle: process.thread_title ?? null,
  itemId: process.item_id,
  turnId: process.turn_id ?? null,
  command: process.command,
  cwd: process.cwd ?? null,
  processId: process.process_id ?? null,
  osPid: process.os_pid ?? null,
  terminalSessionId: process.terminal_session_id ?? null,
  source: process.source,
  startedAtMs: process.started_at_ms,
  updatedAtMs: process.updated_at_ms,
});

export const projectWorkspaceThreadFromCore = (
  thread: CoreThread,
): DesktopProjectWorkspaceThread => ({
  threadId: thread.thread_id,
  projectId: thread.project_id ?? null,
  sessionId: thread.session_id ?? null,
  forkedFromId: thread.forked_from_id ?? null,
  parentThreadId: thread.parent_thread_id ?? null,
  threadSource: thread.thread_source ?? null,
  serviceName: thread.service_name ?? null,
  agentNickname: thread.agent_nickname ?? null,
  agentRole: thread.agent_role ?? null,
  agentPath: thread.agent_path ?? null,
  threadName: thread.thread_name ?? null,
  threadPreview: thread.thread_preview,
  executionProfile: thread.model_id
    ? {
        modelId: thread.model_id,
        reasoningEffort: thread.reasoning_effort ?? null,
        serviceTier: normalizeCodexServiceTier(thread.service_tier),
      }
    : null,
  backendBinding: projectAgentBackendBindingFromCore(thread.backend_binding),
  executionHostId: thread.execution_host_id,
  cwd: thread.cwd ?? null,
  managedWorktreePath: thread.managed_worktree_path ?? null,
  projectlessOutputDirectory: thread.projectless_output_directory ?? null,
  projectlessWorkspaceBrowserRoot: thread.projectless_workspace_browser_root ?? null,
  statusType: thread.status.status_type,
  statusActiveFlags: [...thread.status.active_flags],
  archived: thread.archived,
  pinnedOrder: thread.pinned_order ?? null,
  hasUnreadTurn: thread.has_unread_turn,
  createdAt: thread.created_at,
  updatedAt: thread.updated_at,
  recencyAt: thread.recency_at,
  linkedAt: thread.linked_at,
});

export const projectWorkspaceExecutionProfilePatchToCore = (
  profile: CodexExecutionProfile | null,
) =>
  profile
    ? {
        model_id: profile.modelId,
        reasoning_effort: profile.reasoningEffort,
        service_tier: normalizeCodexServiceTier(profile.serviceTier),
      }
    : {
        model_id: null,
        reasoning_effort: null,
        service_tier: null,
      };

export const projectWorkspaceThreadPatchToCore = (patch: DesktopProjectWorkspaceThreadPatch) => ({
  ...(Object.prototype.hasOwnProperty.call(patch, "projectId")
    ? { project_id: patch.projectId ?? null }
    : {}),
  ...(Object.prototype.hasOwnProperty.call(patch, "forkedFromId")
    ? { forked_from_id: patch.forkedFromId ?? null }
    : {}),
  ...(Object.prototype.hasOwnProperty.call(patch, "parentThreadId")
    ? { parent_thread_id: patch.parentThreadId ?? null }
    : {}),
  ...(Object.prototype.hasOwnProperty.call(patch, "threadName")
    ? { thread_name: patch.threadName ?? null }
    : {}),
  ...(Object.prototype.hasOwnProperty.call(patch, "threadSource")
    ? { thread_source: patch.threadSource ?? null }
    : {}),
  ...(Object.prototype.hasOwnProperty.call(patch, "serviceName")
    ? { service_name: patch.serviceName ?? null }
    : {}),
  ...(Object.prototype.hasOwnProperty.call(patch, "agentNickname")
    ? { agent_nickname: patch.agentNickname ?? null }
    : {}),
  ...(Object.prototype.hasOwnProperty.call(patch, "agentRole")
    ? { agent_role: patch.agentRole ?? null }
    : {}),
  ...(Object.prototype.hasOwnProperty.call(patch, "agentPath")
    ? { agent_path: patch.agentPath ?? null }
    : {}),
  ...(patch.threadPreview === undefined ? {} : { thread_preview: patch.threadPreview }),
  ...(Object.prototype.hasOwnProperty.call(patch, "executionProfile")
    ? projectWorkspaceExecutionProfilePatchToCore(patch.executionProfile ?? null)
    : {}),
  ...(patch.backendBinding === undefined
    ? {}
    : { backend_binding: projectAgentBackendBindingToCore(patch.backendBinding) }),
  ...(patch.executionHostId === undefined ? {} : { execution_host_id: patch.executionHostId }),
  ...(Object.prototype.hasOwnProperty.call(patch, "cwd") ? { cwd: patch.cwd ?? null } : {}),
  ...(Object.prototype.hasOwnProperty.call(patch, "managedWorktreePath")
    ? { managed_worktree_path: patch.managedWorktreePath ?? null }
    : {}),
  ...(Object.prototype.hasOwnProperty.call(patch, "projectlessOutputDirectory")
    ? { projectless_output_directory: patch.projectlessOutputDirectory ?? null }
    : {}),
  ...(Object.prototype.hasOwnProperty.call(patch, "projectlessWorkspaceBrowserRoot")
    ? {
        projectless_workspace_browser_root: patch.projectlessWorkspaceBrowserRoot ?? null,
      }
    : {}),
  ...(patch.status === undefined
    ? {}
    : {
        status: {
          status_type: patch.status.statusType,
          active_flags: [...patch.status.activeFlags],
        },
      }),
  ...(patch.archived === undefined ? {} : { archived: patch.archived }),
  ...(patch.createdAt === undefined ? {} : { created_at: patch.createdAt }),
  ...(patch.updatedAt === undefined ? {} : { updated_at: patch.updatedAt }),
  ...(patch.recencyAt === undefined ? {} : { recency_at: patch.recencyAt }),
  ...(patch.linkedAt === undefined ? {} : { linked_at: patch.linkedAt }),
});

export const projectWorkspaceThreadLaneToCore = (projectId: string | null) =>
  projectId === null
    ? { kind: "projectless" as const }
    : { kind: "project" as const, project_id: projectId };

export const projectWorkspaceThreadMovePlacementToCore = (
  input: DesktopProjectWorkspaceThreadMoveInput,
) => {
  const movedThreadId = input.threadId.trim();
  const beforeThreadId = input.beforeThreadId?.trim() || null;
  const afterThreadId = input.afterThreadId?.trim() || null;
  const insertAtEnd = input.insertAtEnd === true;
  const useDefaultOrder = input.useDefaultOrder === true;
  const explicitPlacements = [
    beforeThreadId !== null,
    afterThreadId !== null,
    insertAtEnd,
    useDefaultOrder,
  ].filter(Boolean).length;
  if (explicitPlacements > 1) {
    throw new Error(
      "Thread placement accepts only one of beforeThreadId, afterThreadId, insertAtEnd, or useDefaultOrder",
    );
  }
  if (beforeThreadId === movedThreadId || afterThreadId === movedThreadId) {
    throw new Error("Thread placement anchor must reference another Thread");
  }
  if (useDefaultOrder) return { kind: "default" as const };
  if (beforeThreadId !== null) {
    return { kind: "before" as const, thread_id: beforeThreadId };
  }
  if (afterThreadId !== null) {
    return { kind: "after" as const, thread_id: afterThreadId };
  }
  if (insertAtEnd) return { kind: "end" as const };
  return { kind: "start" as const };
};

export const projectWorkspaceThreadMoveMetadataToCore = (
  metadata: DesktopProjectWorkspaceThreadMoveInput["metadata"],
) => ({
  ...(metadata?.executionHostId === undefined
    ? {}
    : { execution_host_id: metadata.executionHostId }),
  ...(metadata && Object.prototype.hasOwnProperty.call(metadata, "cwd")
    ? { cwd: metadata.cwd ?? null }
    : {}),
  ...(metadata && Object.prototype.hasOwnProperty.call(metadata, "managedWorktreePath")
    ? { managed_worktree_path: metadata.managedWorktreePath ?? null }
    : {}),
  ...(metadata && Object.prototype.hasOwnProperty.call(metadata, "projectlessOutputDirectory")
    ? { projectless_output_directory: metadata.projectlessOutputDirectory ?? null }
    : {}),
  ...(metadata && Object.prototype.hasOwnProperty.call(metadata, "projectlessWorkspaceBrowserRoot")
    ? {
        projectless_workspace_browser_root: metadata.projectlessWorkspaceBrowserRoot ?? null,
      }
    : {}),
});

const fromCoreSessionSummary = (
  session: CoreSessionSummary,
  thread: ProjectSessionThreadSummary | null,
): ProjectSessionSummary => ({
  id: session.id,
  projectId: session.project_id ?? null,
  noThreadFallbackTitle: session.no_thread_fallback_title,
  displayTitle: session.display_title,
  order: session.order,
  pinned: session.pinned,
  pinnedOrder: session.pinned_order ?? null,
  archived: session.archived,
  archivedAt: session.archived_at ?? null,
  unread: session.unread,
  thread,
  createdAt: session.created_at,
  updatedAt: session.updated_at,
});

export const projectWorkspaceSessionFromCore = (
  session: CoreSessionSummary,
  thread: ProjectSessionThreadLink | null,
): ProjectSession => ({
  ...fromCoreSessionSummary(session, null),
  thread,
});

export const projectWorkspaceTaskFromCore = (task: CoreTask): ProjectSessionSummary =>
  fromCoreSessionSummary(
    task.session,
    task.thread
      ? fromCoreTaskThread(task.thread, task.session.id, task.session.project_id ?? null)
      : null,
  );
