import { defineMessages, getIntl, type IntlShape } from "@/lib/i18n";
import type {
  AgentSubagentOverview,
  AgentSubagentOverviewItem,
} from "@nodex/agent-runtime/contracts";
import type { CodexSubagentOverviewRow, CodexSubagentOverviewWindow } from "../../../shared/types";
import {
  agentRuntimeSubagentAgent,
  projectAgentRuntimeSubagentDisplay,
} from "../../../shared/agent-runtime-subagent-display";
import { agentRuntimeTime } from "./agent-runtime-transcript-projection";
import { recoveryStatusLabel } from "./projection/conversation-recovery-presentation";

export type SubagentAttentionKind = NonNullable<AgentSubagentOverviewItem["attention"]>;

export interface SubagentOverviewRow extends CodexSubagentOverviewRow {
  readonly attentionKind?: SubagentAttentionKind;
}

const ATTENTION_MESSAGES = defineMessages({
  approval: {
    id: "conversation.agentRuntimeSubagentOverview.needsApproval",
    defaultMessage: "Needs approval",
  },
  question_person: {
    id: "conversation.agentRuntimeSubagentOverview.needsYourAnswer",
    defaultMessage: "Needs your answer",
  },
  question_agent: {
    id: "conversation.agentRuntimeSubagentOverview.askedQuestion",
    defaultMessage: "Asked a question",
  },
});

export function subagentAttentionLabel(kind: SubagentAttentionKind, intl: IntlShape): string {
  return intl.formatMessage(ATTENTION_MESSAGES[kind]);
}

type Section = "active" | "terminal";

const isTerminal = (status: AgentSubagentOverviewItem["status"]) =>
  status === "idle" ||
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
  /** Whether this reader may stop work of the Run that started the subagent. */
  canStopRun: (runId: string | null) => boolean = () => true,
  rootThreadId = task.threadId,
): SubagentOverviewRow => {
  const { displayName } = projectAgentRuntimeSubagentDisplay(task);
  return {
    threadId: task.childThreadId ?? task.id,
    identityThreadId: task.childThreadId,
    parentThreadId:
      task.parentTaskId === null
        ? rootThreadId
        : (task.parentTaskChildThreadId ?? task.parentTaskId),
    parentTurnKey: task.runId,
    displayName:
      displayName ??
      getIntl().formatMessage({
        id: "conversation.agentRuntimeSubagentOverview.subagent",
        defaultMessage: "Subagent",
      }),
    actorName: displayName,
    agentRole: null,
    agent: agentRuntimeSubagentAgent(task),
    spawnModel: task.modelSelection?.model ?? task.model,
    objective: null,
    status:
      task.status === "waiting"
        ? "waiting"
        : ["pending", "running"].includes(task.status)
          ? "active"
          : "done",
    ...(task.attention !== null ? { attentionKind: task.attention } : {}),
    statusSummary:
      task.attention !== null
        ? subagentAttentionLabel(task.attention, getIntl())
        : isLive(task.status) && task.recovery
          ? recoveryStatusLabel({
              state: "retrying",
              reason: task.recovery.kind,
              attempt: task.recovery.attempt,
              maxAttempts: task.recovery.maxAttempts,
              retryAt: null,
              updatedAt: null,
            })
          : task.status === "failed"
            ? getIntl().formatMessage({
                id: "conversation.agentRuntimeSubagentOverview.failed",
                defaultMessage: "Failed",
              })
            : task.status === "interrupted"
              ? getIntl().formatMessage({
                  id: "conversation.agentRuntimeSubagentOverview.stopped",
                  defaultMessage: "Stopped",
                })
              : task.status === "cancelled"
                ? getIntl().formatMessage({
                    id: "conversation.agentRuntimeSubagentOverview.cancelled",
                    defaultMessage: "Cancelled",
                  })
                : task.driver === "antigravity" &&
                    task.origin === "provider_native" &&
                    task.status === "idle"
                  ? getIntl().formatMessage({
                      id: "conversation.delegatedTaskPresentation.idle",
                      defaultMessage: "Idle",
                    })
                  : null,
    startedAtMs: agentRuntimeTime(task.startedAt),
    lastActivityAtMs: agentRuntimeTime(task.updatedAt),
    completedAtMs: agentRuntimeTime(task.completedAt),
    recencyAtMs: agentRuntimeTime(task.updatedAt) ?? 0,
    diffStats: null,
    canOpen: task.childThreadId !== null,
    // An application-owned child stops through its own conversation; a native one through its Run.
    // Either answers for the Run that started it.
    canStop:
      isLive(task.status) &&
      (task.childThreadId !== null || task.runId !== null) &&
      canStopRun(task.runId),
    canInteract: task.origin === "app_owned" && task.childThreadId !== null,
    showInlineActivity:
      task.childThreadId !== null &&
      !(task.driver === "antigravity" && task.origin === "provider_native"),
  };
};

export function projectAgentRuntimeSubagentOverview(
  rootThreadId: string,
  source: AgentSubagentOverview,
  canStopRun: (runId: string | null) => boolean = () => true,
): CodexSubagentOverviewWindow {
  const project = (task: AgentSubagentOverviewItem) =>
    projectAgentRuntimeSubagent(task, canStopRun, rootThreadId);
  const rows = [...source.active.items, ...source.terminal.items].map(project);
  const section = (page: AgentSubagentOverview["active"]) => ({
    rows: page.items.map(project),
    knownCount: page.items.length,
    totalCount: page.totalCount,
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
const sectionOf = (item: AgentSubagentOverviewItem): Section =>
  isTerminal(item.status) ? "terminal" : "active";

/** Places one item by recency; an older or equal report never replaces a newer one. */
function upsert(
  overview: AgentSubagentOverview,
  item: AgentSubagentOverviewItem,
  withinLoadedWindow: boolean,
): AgentSubagentOverview {
  const existing = find(overview, item.id);
  if (existing && existing.updatedAt.localeCompare(item.updatedAt) > 0) return overview;
  const target = sectionOf(item);
  const origin = existing ? sectionOf(existing) : null;
  // A live report for a loaded row moves it between section totals; the totals of anything
  // else wait for a re-read.
  const counted = withinLoadedWindow && origin !== null && origin !== target;
  const without = (section: Section) => ({
    ...overview[section],
    items: overview[section].items.filter((candidate) => candidate.id !== item.id),
  });
  const next = { active: without("active"), terminal: without("terminal") };
  if (counted) {
    if (origin) next[origin] = { ...next[origin], totalCount: next[origin].totalCount - 1 };
    next[target] = { ...next[target], totalCount: next[target].totalCount + 1 };
  }
  const page = next[target];
  const last = page.items.at(-1);
  // New arrivals beyond a partly loaded section stay on their unloaded page. A row the
  // user already loaded stays resident when its own metadata changes.
  const outside =
    origin !== target &&
    withinLoadedWindow &&
    page.hasMore &&
    last !== undefined &&
    newerFirst(last, item) < 0;
  if (!outside) next[target] = { ...page, items: [...page.items, item].sort(newerFirst) };
  return next;
}

/** Applies one task metadata event to the loaded window without re-reading any page. */
export function applyAgentRuntimeOverviewTask(
  overview: AgentSubagentOverview,
  task: AgentSubagentOverviewItem,
): AgentSubagentOverview {
  return upsert(overview, task, true);
}

export type AgentRuntimeOverviewWindow = Readonly<Record<Section, number>>;

/**
 * How many rows each section has shown. A row that settles leaves Working and a row that
 * reopens leaves Done; the section keeps the size the user saw by loading its next page.
 */
export function agentRuntimeOverviewWindow(
  previous: AgentRuntimeOverviewWindow,
  overview: AgentSubagentOverview,
): AgentRuntimeOverviewWindow {
  return {
    active: Math.max(previous.active, overview.active.items.length),
    terminal: Math.max(previous.terminal, overview.terminal.items.length),
  };
}

export function agentRuntimeOverviewSectionsToRefill(
  overview: AgentSubagentOverview,
  window: AgentRuntimeOverviewWindow,
): readonly Section[] {
  return (["active", "terminal"] as const).filter(
    (section) =>
      overview[section].hasMore &&
      overview[section].nextCursor !== null &&
      overview[section].items.length < window[section],
  );
}

/**
 * Takes a fresh read into the window. Its totals describe its rows, so the rows come with them: a
 * report still on its way for a move the read already counted finds that row already moved.
 */
export function reconcileAgentRuntimeOverview(
  overview: AgentSubagentOverview,
  read: AgentSubagentOverview,
): AgentSubagentOverview {
  let merged = overview;
  for (const item of [...read.active.items, ...read.terminal.items])
    merged = upsert(merged, item, false);
  return {
    active: { ...merged.active, totalCount: read.active.totalCount },
    terminal: { ...merged.terminal, totalCount: read.terminal.totalCount },
  };
}

/** Merges an explicitly loaded page into the current window, keeping newer task reports. */
export function appendAgentRuntimeOverviewPage(
  current: AgentSubagentOverview,
  page: AgentSubagentOverview,
  section: Section,
): AgentSubagentOverview {
  const merged = reconcileAgentRuntimeOverview(current, page);
  return {
    ...merged,
    [section]: {
      ...merged[section],
      nextCursor: page[section].nextCursor,
      hasMore: page[section].hasMore,
    },
  };
}
