import type { Thread } from "@nodex/codex-app-server-protocol/v2";
import {
  projectAgentBackendBindingFromCore,
  type DesktopProjectWorkspaceThread,
} from "../core-client/project-workspace-adapter";
import type {
  ProjectWorkspaceApplyInput,
  ProjectWorkspaceReadSnapshot,
} from "../core-client/types";
import { extractCodexThreadSubagentMetadata } from "../../shared/codex-subagent-metadata";
import { normalizeCodexServiceTier } from "../../shared/codex-service-tier";
import type {
  CodexCanonicalConversationState,
  CodexConversationSnapshot,
  CodexConversationTurnPagination,
  CodexThreadSummary,
} from "../../shared/types";
import type { CodexHistoryTurnItemsPagination } from "../../shared/codex-conversation-state/codex-history-topology";
import type { CodexHistoryRow } from "../../shared/codex-conversation-state/codex-history-topology";
import { resolveCodexThreadMaterializationOwner } from "../codex/codex-thread-materialization-owner";
import { reconcileCodexThreadTimestamps } from "../codex/codex-thread-timestamps";
import { projectCodexConversationSnapshot } from "./CodexConversationSnapshotProjection";
import { parseThreadSourceValue, parseThreadStatus } from "./CodexThreadCatalogProjection";

type CoreWorkspaceThread = Extract<
  ProjectWorkspaceReadSnapshot["value"],
  { readonly kind: "thread" }
>["thread"];
type CoreWorkspaceThreadPatch = Extract<
  ProjectWorkspaceApplyInput["intent"],
  { readonly kind: "upsert_thread" }
>["patch"];

const readText = (record: Record<string, unknown>, ...keys: readonly string[]): string | null => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") return value;
  }
  return null;
};

export const projectCoreWorkspaceThread = (
  thread: CoreWorkspaceThread,
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

export interface CodexThreadDirectoryMaterialization {
  readonly threadId: string;
  readonly patch: CoreWorkspaceThreadPatch;
  readonly parentThreadId: string | null;
}

/**
 * Projects one app-server observation into the durable Core identity patch. Existing Core
 * execution ownership always wins over observational cwd spellings.
 */
export const projectCodexThreadDirectoryMaterialization = (input: {
  readonly thread: Thread | Record<string, unknown>;
  readonly existing: DesktopProjectWorkspaceThread | null;
  readonly parent: DesktopProjectWorkspaceThread | null;
  readonly explicitParentThreadId?: string | null;
  readonly explicitForkedFromId?: string | null;
  readonly executionProfile?: DesktopProjectWorkspaceThread["executionProfile"];
  readonly managedWorktreePath?: string | null;
  readonly inferredInitialProjectId?: string | null;
  readonly observedExecutionHostId?: string;
  readonly fallbackCwd?: string | null;
  readonly nowMs: number;
}): CodexThreadDirectoryMaterialization | null => {
  const candidate = input.thread as unknown as Record<string, unknown>;
  const threadId = readText(candidate, "id")?.trim() ?? "";
  if (!threadId) return null;

  const metadata = extractCodexThreadSubagentMetadata(candidate);
  const parentThreadId = input.explicitParentThreadId ?? metadata.parentThreadId;
  const existing = input.existing;
  const parent = input.parent;
  const managedWorktreePath = input.managedWorktreePath ?? existing?.managedWorktreePath ?? null;
  const durableManagedCwd = managedWorktreePath ? (existing?.cwd ?? parent?.cwd ?? null) : null;
  const candidateCwd = readText(candidate, "cwd")?.trim() || null;
  const cwd =
    durableManagedCwd ??
    candidateCwd ??
    existing?.cwd ??
    parent?.cwd ??
    input.fallbackCwd?.trim() ??
    null;
  const parsedStatus = parseThreadStatus(candidate.status);
  const timestamps = reconcileCodexThreadTimestamps({
    threadId,
    observedCreatedAt: candidate.createdAt,
    observedUpdatedAt: candidate.updatedAt,
    observedRecencyAt: candidate.recencyAt,
    existing,
    nowMs: input.nowMs,
  });
  const projectId = resolveCodexThreadMaterializationOwner({
    existingThreadFound: existing !== null,
    existingProjectId: existing?.projectId ?? null,
    explicitInitialOwnerProvided: parent !== null,
    explicitInitialProjectId: parent?.projectId ?? null,
    inferredInitialProjectId: input.inferredInitialProjectId ?? null,
  });
  const threadSource = parseThreadSourceValue(candidate.threadSource ?? candidate.thread_source);
  const serviceName = candidate.serviceName ?? candidate.service_name;
  const agentPath = metadata.agentPath;
  const configuredModel = readText(candidate, "model")?.trim();
  const executionProfile =
    input.executionProfile ??
    (configuredModel
      ? {
          modelId: configuredModel,
          reasoningEffort: readText(candidate, "reasoningEffort"),
          serviceTier: existing?.executionProfile?.serviceTier ?? null,
        }
      : (existing?.executionProfile ?? null));

  return {
    threadId,
    parentThreadId,
    patch: {
      ...(!existing ? { project_id: projectId } : {}),
      ...(input.explicitForkedFromId !== undefined
        ? { forked_from_id: input.explicitForkedFromId }
        : {}),
      ...(parentThreadId ? { parent_thread_id: parentThreadId } : {}),
      thread_source: threadSource,
      ...(serviceName === null || typeof serviceName === "string"
        ? { service_name: serviceName }
        : {}),
      ...(metadata.hasAgentNickname ? { agent_nickname: metadata.agentNickname } : {}),
      ...(metadata.hasAgentRole ? { agent_role: metadata.agentRole } : {}),
      ...(metadata.hasAgentPath ? { agent_path: agentPath } : {}),
      ...(typeof candidate.name === "string" ? { thread_name: candidate.name } : {}),
      thread_preview: typeof candidate.preview === "string" ? candidate.preview : "",
      ...(executionProfile
        ? {
            model_id: executionProfile.modelId,
            reasoning_effort: executionProfile.reasoningEffort,
            service_tier: executionProfile.serviceTier,
          }
        : {}),
      execution_host_id:
        existing?.executionHostId ??
        parent?.executionHostId ??
        (input.observedExecutionHostId?.trim() || "local"),
      ...(cwd === null ? {} : { cwd }),
      managed_worktree_path: managedWorktreePath,
      projectless_output_directory:
        readText(candidate, "projectlessOutputDirectory", "projectless_output_directory") ??
        existing?.projectlessOutputDirectory ??
        parent?.projectlessOutputDirectory ??
        null,
      projectless_workspace_browser_root:
        readText(
          candidate,
          "projectlessWorkspaceBrowserRoot",
          "projectless_workspace_browser_root",
          "projectlessWorkspaceRoot",
          "projectless_workspace_root",
        ) ??
        existing?.projectlessWorkspaceBrowserRoot ??
        parent?.projectlessWorkspaceBrowserRoot ??
        null,
      status: {
        status_type: parsedStatus.statusType,
        active_flags: parsedStatus.statusActiveFlags,
      },
      archived: existing?.archived ?? false,
      ...(!existing ? { created_at: timestamps.createdAt } : {}),
      updated_at: timestamps.updatedAt,
      recency_at: timestamps.recencyAt,
    },
  };
};

/** Builds the first application snapshot, then reuses the same pure projector as live updates. */
export const projectCodexThreadDirectorySnapshot = (input: {
  readonly summary: CodexThreadSummary;
  readonly current: CodexConversationSnapshot | null;
  readonly before: CodexCanonicalConversationState | null;
  readonly after: CodexCanonicalConversationState;
  readonly pagination: CodexConversationTurnPagination;
  readonly itemsPaginationByTurnId?: Readonly<Record<string, CodexHistoryTurnItemsPagination>>;
  readonly historyRows?: readonly CodexHistoryRow[];
  readonly historyTopologyGeneration?: number;
  readonly observedAtMs: number;
  readonly resumeState?: CodexConversationSnapshot["resumeState"];
}): CodexConversationSnapshot => {
  const resumeState = input.resumeState ?? "resumed";
  const base: CodexConversationSnapshot = input.current
    ? {
        ...input.current,
        ...input.summary,
        canonicalState: input.before,
      }
    : {
        ...input.summary,
        resumeState,
        turnPagination: input.pagination,
        turnItemsPaginationById: input.itemsPaginationByTurnId,
        historyRows: input.historyRows,
        historyTopologyGeneration: input.historyTopologyGeneration,
        turns: [],
        canonicalState: input.before,
        canonicalRequests: [...(input.before?.requests ?? [])],
        hasUnreadTurn: input.after.sidecar.hasUnreadTurn,
        requests: [],
        queuedFollowUps: {
          status: "ready",
          ledgerRevision: 0,
          projectionRevision: 0,
          entries: [],
          inFlightFollowUpId: null,
          editingFollowUpId: null,
          error: null,
        },
        pendingSteers: [],
        backgroundTerminalRows: [],
        capabilityFlags: {
          canEditLastUserTurn: false,
          canForkFromTurn: false,
          canSearch: true,
          canCollapseTurns: true,
        },
      };
  const projected = projectCodexConversationSnapshot({
    conversation: base,
    before: input.before,
    after: input.after,
    observedAtMs: input.observedAtMs,
  });
  return {
    ...projected,
    ...input.summary,
    resumeState,
    turnPagination: input.pagination,
    turnItemsPaginationById: input.itemsPaginationByTurnId,
    historyRows: input.historyRows,
    historyTopologyGeneration: input.historyTopologyGeneration,
    capabilityFlags: {
      ...projected.capabilityFlags,
      canForkFromTurn: input.after.turns.length > 0,
    },
  };
};
