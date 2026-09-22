import { projectCodexSubagentPathDisplayName } from "../../shared/codex-subagent-display";
import {
  buildBackgroundSubagentRows,
  type CodexSubagentRow,
  type SubagentConversation,
} from "../../shared/codex-subagent-row-model";
import type {
  CodexConversationChildMembership,
  CodexConversationTurn,
  CodexThreadStatusType,
} from "../../shared/types";
import type {
  CodexSubagentOverviewRow,
  CodexSubagentOverviewSection,
  CodexSubagentOverviewStatus,
  CodexSubagentOverviewWindow,
} from "../../shared/types";

const OBJECTIVE_MAX_CHARACTERS = 60;

export interface CoreSubagentOverviewThreadLike {
  readonly thread_id: string;
  readonly parent_thread_id?: string | null;
  readonly thread_name?: string | null;
  readonly thread_preview: string;
  readonly model_id?: string | null;
  readonly agent_nickname?: string | null;
  readonly agent_role?: string | null;
  readonly agent_path?: string | null;
  readonly status?: { readonly status_type: CodexThreadStatusType };
  readonly archived: boolean;
  readonly created_at: number;
  readonly updated_at: number;
  readonly recency_at: number;
}

export interface CoreSubagentOverviewItemLike {
  readonly thread: CoreSubagentOverviewThreadLike;
  readonly status: CodexSubagentOverviewStatus;
}

export interface CoreSubagentOverviewLike {
  readonly universe: {
    readonly generation: number;
    readonly host_id?: string;
    readonly root_thread_id: string;
  };
  readonly active: {
    readonly items: readonly CoreSubagentOverviewItemLike[];
    readonly next_cursor?: string | null;
  };
  readonly done: {
    readonly items: readonly CoreSubagentOverviewItemLike[];
    readonly next_cursor?: string | null;
  };
  readonly known_active_count: number;
  readonly known_done_count: number;
  readonly discovery_complete: boolean;
  readonly discovery_continuation?: string | null;
  readonly projection_revision: number;
}

const compactObjective = (value: string): string | null => {
  const normalized = value.replaceAll(/\s+/gu, " ").trim();
  if (!normalized) return null;
  if (normalized.length <= OBJECTIVE_MAX_CHARACTERS) return normalized;
  return `${normalized.slice(0, OBJECTIVE_MAX_CHARACTERS - 1).trimEnd()}…`;
};

export interface SubagentOverviewProjectionContext {
  parentTurns: readonly CodexConversationTurn[];
  cachedConversationIds?: readonly string[];
  sourceLinkedThreadIds?: readonly string[];
  knownConversationsById: Record<string, SubagentConversation>;
}

function membershipFor(
  thread: CoreSubagentOverviewThreadLike,
  rootThreadId: string,
): CodexConversationChildMembership {
  return {
    threadId: thread.thread_id,
    parentThreadId: thread.parent_thread_id ?? rootThreadId,
    role: "backgroundChild",
    displayName: thread.agent_path ? projectCodexSubagentPathDisplayName(thread.agent_path) : null,
    agentPath: thread.agent_path,
    agentRole: thread.agent_role,
    createdAtMs: thread.created_at,
    updatedAtMs: thread.recency_at || thread.updated_at,
    statusType: thread.status?.status_type,
    thread: {
      nickname: thread.agent_nickname,
      agentRole: thread.agent_role,
    },
  };
}

export function projectSubagentRowToOverview(row: CodexSubagentRow): CodexSubagentOverviewRow {
  return {
    conversationId: row.conversationId,
    parentConversationId: row.parentConversationId,
    parentTurnKey: row.parentTurnKey,
    displayName: row.displayName,
    actorName: row.actorName,
    agentRole: row.agentRole,
    spawnModel: row.spawnModel,
    status: row.status,
    statusSummary: row.statusSummary,
    showInlineActivity: row.showInlineActivity,
    lastAssistantMessageAtMs: row.lastAssistantMessageAtMs,
    recencyAtMs: row.recencyAtMs,
    isCurrentParentTurn: row.isCurrentParentTurn,
    diffStats: row.diffStats,
    canInteract: row.canInteract,
    threadId: row.conversationId,
    parentThreadId: row.parentConversationId,
    objective: compactObjective(row.objective ?? ""),
    startedAtMs: row.startedAtMs ?? null,
    lastActivityAtMs: row.recencyAtMs || null,
    completedAtMs: row.status === "done" ? (row.lastAssistantMessageAtMs ?? row.recencyAtMs) : null,
    canOpen: true,
  };
}

/** Adapts stored identity and resident history into the same rows used by the transcript. */
export function projectCodexSubagentOverviewWindow(
  overview: CoreSubagentOverviewLike,
  canInteract: (thread: CoreSubagentOverviewThreadLike) => boolean = () => false,
  context?: SubagentOverviewProjectionContext,
): CodexSubagentOverviewWindow {
  const allItems = [...overview.active.items, ...overview.done.items];
  const byId = new Map(allItems.map((item) => [item.thread.thread_id, item]));
  const cached =
    context?.cachedConversationIds ?? Object.keys(context?.knownConversationsById ?? {});
  const source = context?.sourceLinkedThreadIds ?? allItems.map((item) => item.thread.thread_id);
  const sources = new Set(source);
  const ids = new Set([
    ...cached,
    ...allItems
      .filter(
        (item) =>
          !sources.has(item.thread.thread_id) && item.thread.status?.status_type === "active",
      )
      .map((item) => item.thread.thread_id),
    ...source,
    ...allItems.map((item) => item.thread.thread_id),
  ]);
  const items = [...ids].flatMap((id) => {
    const item = byId.get(id);
    return item ? [item] : [];
  });
  const memberships = items
    .filter((item) => !item.thread.archived)
    .map((item) => membershipFor(item.thread, overview.universe.root_thread_id));
  const projected = buildBackgroundSubagentRows({
    parentConversationId: overview.universe.root_thread_id,
    childMemberships: memberships,
    parentTurns: context?.parentTurns ?? [],
    knownConversationsById: context?.knownConversationsById ?? {},
    discoveryComplete: overview.discovery_complete,
  });
  const threads = new Map(items.map((item) => [item.thread.thread_id, item.thread]));
  const rows = projected.map((row) => {
    const thread = threads.get(row.conversationId)!;
    return projectSubagentRowToOverview({
      ...row,
      canInteract: row.canInteract || canInteract(thread),
    });
  });
  const section = (done: boolean): CodexSubagentOverviewSection => {
    const matching = rows
      .filter((row) => row.displayName.trim().length > 0 && (row.status === "done") === done)
      .sort((a, b) => (b.recencyAtMs ?? 0) - (a.recencyAtMs ?? 0));
    return {
      rows: matching,
      knownCount: matching.length,
      totalCount: overview.discovery_complete ? matching.length : null,
      continuation: null,
    };
  };
  return {
    rootThreadId: overview.universe.root_thread_id,
    revision: overview.projection_revision,
    generation: overview.universe.generation,
    completeness: overview.discovery_complete ? "complete" : "incomplete",
    rows,
    active: section(false),
    done: section(true),
  };
}
