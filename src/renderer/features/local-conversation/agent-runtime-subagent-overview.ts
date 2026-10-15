import type {
  AgentSubagentOverview,
  AgentSubagentOverviewItem,
} from "@nodex/agent-runtime/contracts";
import type { CodexSubagentOverviewRow, CodexSubagentOverviewWindow } from "../../../shared/types";
import { agentRuntimeTime } from "./agent-runtime-transcript-projection";

/** Execution metadata is enough for the overview; task bodies stay behind explicit detail reads. */
export const projectAgentRuntimeSubagent = (
  task: AgentSubagentOverviewItem,
): CodexSubagentOverviewRow => ({
  threadId: task.childThreadId ?? task.id,
  parentThreadId: task.threadId,
  parentTurnKey: task.runId,
  displayName: task.title ?? "Subagent",
  actorName: task.title,
  agentRole: null,
  spawnModel: task.modelSelection?.model ?? task.model,
  objective: null,
  status:
    task.status === "waiting"
      ? "waiting"
      : ["pending", "running"].includes(task.status)
        ? "active"
        : "done",
  statusSummary:
    task.status === "failed"
      ? "Failed"
      : task.status === "interrupted"
        ? "Stopped"
        : task.status === "cancelled"
          ? "Cancelled"
          : null,
  startedAtMs: agentRuntimeTime(task.startedAt),
  lastActivityAtMs: agentRuntimeTime(task.updatedAt),
  completedAtMs: agentRuntimeTime(task.completedAt),
  recencyAtMs: agentRuntimeTime(task.updatedAt) ?? 0,
  diffStats: null,
  canOpen: task.childThreadId !== null,
  canStop: task.origin === "provider_native" && task.runId !== null,
  canInteract: task.origin === "app_owned" && task.childThreadId !== null,
  showInlineActivity: task.childThreadId !== null,
});

export function projectAgentRuntimeSubagentOverview(
  rootThreadId: string,
  source: AgentSubagentOverview,
): CodexSubagentOverviewWindow {
  const rows = [...source.active.items, ...source.terminal.items].map(projectAgentRuntimeSubagent);
  const section = (page: AgentSubagentOverview["active"]) => ({
    rows: page.items.map(projectAgentRuntimeSubagent),
    knownCount: page.items.length,
    totalCount: page.hasMore ? null : page.items.length,
    continuation: page.nextCursor,
  });
  return {
    rootThreadId,
    revision: rows.reduce((latest, row) => Math.max(latest, row.recencyAtMs ?? 0), 0),
    generation: 0,
    completeness: source.active.hasMore || source.terminal.hasMore ? "incomplete" : "complete",
    rows,
    active: section(source.active),
    done: section(source.terminal),
  };
}

export function appendAgentRuntimeOverviewPage(
  previous: AgentSubagentOverview,
  next: AgentSubagentOverview,
  section: "active" | "terminal",
): AgentSubagentOverview {
  const items = new Map(previous[section].items.map((item) => [item.id, item]));
  for (const item of next[section].items) items.set(item.id, item);
  return { ...previous, [section]: { ...next[section], items: [...items.values()] } };
}
