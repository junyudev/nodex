import { resolveCodexSubagentDisplayName } from "../../shared/codex-subagent-display";
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

const statusSummary = (status: CodexSubagentOverviewStatus): string | null => {
  switch (status) {
    case "active":
      return "Working";
    case "waiting":
      return "Waiting";
    case "done":
      return "Finished";
    case "unknown":
      return null;
  }
};

export const projectCodexSubagentOverviewRow = (
  item: CoreSubagentOverviewItemLike,
): CodexSubagentOverviewRow => {
  const { thread } = item;
  const canOpen = !thread.archived && thread.thread_id.trim().length > 0;
  return {
    threadId: thread.thread_id,
    parentThreadId: thread.parent_thread_id ?? null,
    displayName: resolveCodexSubagentDisplayName({
      threadId: thread.thread_id,
      fallbackDisplayName:
        thread.agent_nickname ?? thread.thread_name ?? thread.agent_role ?? "Subagent",
      fallbackLabel: "Subagent",
    }),
    actorName: thread.agent_path ?? null,
    agentRole: thread.agent_role ?? null,
    spawnModel: thread.model_id ?? null,
    objective: compactObjective(thread.thread_preview),
    status: item.status,
    statusSummary: statusSummary(item.status),
    startedAtMs: Math.max(thread.created_at, 0) || null,
    lastActivityAtMs: Math.max(thread.recency_at, thread.updated_at, 0) || null,
    completedAtMs:
      item.status === "done" ? Math.max(thread.recency_at, thread.updated_at, 0) || null : null,
    diffStats: null,
    canOpen,
    // Done is a Turn outcome, not a revocation of Thread writer authority. A
    // completed child can accept a follow-up and become Active again.
    canInteract: canOpen,
  };
};

const projectSection = (input: {
  readonly items: readonly CoreSubagentOverviewItemLike[];
  readonly nextCursor?: string | null;
  readonly knownCount: number;
  readonly complete: boolean;
}): CodexSubagentOverviewSection => ({
  rows: input.items.map(projectCodexSubagentOverviewRow),
  knownCount: input.knownCount,
  totalCount: input.complete ? input.knownCount : null,
  continuation: input.nextCursor ?? null,
});

export function projectCodexSubagentOverviewWindow(
  overview: CoreSubagentOverviewLike,
): CodexSubagentOverviewWindow {
  return {
    rootThreadId: overview.universe.root_thread_id,
    revision: overview.projection_revision,
    generation: overview.universe.generation,
    completeness: overview.discovery_complete ? "complete" : "incomplete",
    active: projectSection({
      items: overview.active.items,
      nextCursor: overview.active.next_cursor,
      knownCount: overview.known_active_count,
      complete: overview.discovery_complete,
    }),
    done: projectSection({
      items: overview.done.items,
      nextCursor: overview.done.next_cursor,
      knownCount: overview.known_done_count,
      complete: overview.discovery_complete,
    }),
  };
}
