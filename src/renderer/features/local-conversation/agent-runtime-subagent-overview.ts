import type {
  AgentEvent,
  AgentSubagentOverview,
  AgentSubagentOverviewItem,
} from "@nodex/agent-runtime/contracts";
import type { CodexSubagentOverviewRow, CodexSubagentOverviewWindow } from "../../../shared/types";
import { agentRuntimeTime } from "./agent-runtime-transcript-projection";

/** A task record as its metadata event reports it. */
export type AgentRuntimeTaskRecord = Extract<
  AgentEvent["event"],
  { readonly type: "subagent.updated" }
>["payload"];
type Section = "active" | "terminal";

const isTerminal = (status: AgentSubagentOverviewItem["status"]) =>
  status === "completed" ||
  status === "failed" ||
  status === "cancelled" ||
  status === "interrupted";
const isLive = (status: AgentSubagentOverviewItem["status"]) =>
  status === "pending" || status === "running" || status === "waiting";
/** Newest first, matching the Runtime's page order and cursors. */
const newerFirst = (left: AgentSubagentOverviewItem, right: AgentSubagentOverviewItem) =>
  right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id);

/** Execution metadata is enough for the overview; task bodies stay behind explicit detail reads. */
export const projectAgentRuntimeSubagent = (
  task: AgentSubagentOverviewItem,
  agentLabel: string | null = null,
): CodexSubagentOverviewRow => ({
  threadId: task.childThreadId ?? task.id,
  parentThreadId: task.threadId,
  parentTurnKey: task.runId,
  displayName: task.title ?? "Subagent",
  actorName: task.title,
  agentRole: null,
  agentLabel,
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
  // An application-owned child stops through its own conversation; a native one through its Run.
  canStop: isLive(task.status) && (task.childThreadId !== null || task.runId !== null),
  canInteract: task.origin === "app_owned" && task.childThreadId !== null,
  showInlineActivity: task.childThreadId !== null,
});

export function projectAgentRuntimeSubagentOverview(
  rootThreadId: string,
  source: AgentSubagentOverview,
  agentLabel: (task: AgentSubagentOverviewItem) => string | null = () => null,
): CodexSubagentOverviewWindow {
  const project = (task: AgentSubagentOverviewItem) =>
    projectAgentRuntimeSubagent(task, agentLabel(task));
  const rows = [...source.active.items, ...source.terminal.items].map(project);
  const section = (page: AgentSubagentOverview["active"]) => ({
    rows: page.items.map(project),
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

function find(overview: AgentSubagentOverview, id: string) {
  return (
    overview.active.items.find((item) => item.id === id) ??
    overview.terminal.items.find((item) => item.id === id)
  );
}

/** Places one item by recency; an older or equal report never replaces a newer one. */
function upsert(
  overview: AgentSubagentOverview,
  item: AgentSubagentOverviewItem,
  withinLoadedWindow: boolean,
): AgentSubagentOverview {
  const existing = find(overview, item.id);
  if (existing && existing.updatedAt.localeCompare(item.updatedAt) > 0) return overview;
  const target: Section = isTerminal(item.status) ? "terminal" : "active";
  const without = (section: Section) => ({
    ...overview[section],
    items: overview[section].items.filter((candidate) => candidate.id !== item.id),
  });
  const next = { active: without("active"), terminal: without("terminal") };
  const page = next[target];
  const last = page.items.at(-1);
  // Beyond a partly loaded section the item belongs to a page the user has not loaded.
  const outside =
    withinLoadedWindow && page.hasMore && last !== undefined && newerFirst(last, item) < 0;
  if (!outside) next[target] = { ...page, items: [...page.items, item].sort(newerFirst) };
  return next;
}

/** Applies one task metadata event to the loaded window without re-reading any page. */
export function applyAgentRuntimeOverviewTask(
  overview: AgentSubagentOverview,
  task: AgentRuntimeTaskRecord,
): AgentSubagentOverview {
  const existing = find(overview, task.id);
  return upsert(
    overview,
    {
      id: task.id,
      threadId: task.threadId,
      runId: task.runId,
      parentNodeId: task.parentNodeId,
      origin: task.origin,
      driver: task.driver,
      providerInstanceId: task.providerInstanceId,
      providerThreadId: task.providerThreadId,
      childThreadId: task.childThreadId,
      title: task.title,
      model: task.model,
      ...(task.modelSelection ? { modelSelection: task.modelSelection } : {}),
      status: task.status,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
      updatedAt: task.updatedAt,
      childRunId: existing?.childRunId ?? null,
      resultAvailable: existing?.resultAvailable ?? false,
    },
    true,
  );
}

/** Merges an explicitly loaded page into the current window, keeping newer task reports. */
export function appendAgentRuntimeOverviewPage(
  current: AgentSubagentOverview,
  page: AgentSubagentOverview,
  section: Section,
): AgentSubagentOverview {
  let merged = current;
  for (const item of page[section].items) merged = upsert(merged, item, false);
  return {
    ...merged,
    [section]: {
      ...merged[section],
      nextCursor: page[section].nextCursor,
      hasMore: page[section].hasMore,
    },
  };
}
