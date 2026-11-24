import { defineMessages, getIntl, type IntlShape } from "@/lib/i18n";
import type {
  AgentSubagentOverview,
  AgentSubagentOverviewItem,
} from "@nodex/agent-runtime/contracts";
import { currentSubagentTurn } from "@nodex/agent-runtime/subagent-turns";
import type { CodexSubagentOverviewRow, CodexSubagentOverviewWindow } from "../../../shared/types";
import {
  agentRuntimeSubagentAgent,
  projectAgentRuntimeSubagentDisplay,
} from "../../../shared/agent-runtime-subagent-display";
import { agentRuntimeTime } from "./agent-runtime-transcript-projection";
import { recoveryStatusLabel } from "./projection/conversation-recovery-presentation";

export type SubagentAttentionKind = NonNullable<AgentSubagentOverviewItem["attention"]>;

/**
 * How a settled subagent ended, when its execution owner says. Idle is a provider's own batch
 * that handed control back without reporting how its children ended.
 */
export type SubagentOutcome = "completed" | "failed" | "stopped" | "cancelled" | "idle";

export interface SubagentOverviewRow extends CodexSubagentOverviewRow {
  readonly attentionKind?: SubagentAttentionKind;
  readonly outcome?: SubagentOutcome;
  /**
   * When the subagent was first delegated. A follow-up turn starts later and moves `startedAtMs`,
   * but never the subagent's place among its siblings.
   */
  readonly delegatedAtMs?: number | null;
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

/**
 * A subagent's key among its delegator's rows: its child conversation, or the provider-native
 * task that has none. Every turn of one child conversation shares it.
 */
export const agentRuntimeSubagentKey = (task: {
  readonly id: string;
  readonly childThreadId: string | null;
}): string => task.childThreadId ?? task.id;

interface SubagentTurnTask {
  readonly id: string;
  readonly childThreadId: string | null;
  readonly status: AgentSubagentOverviewItem["status"];
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

/** One subagent's turns, as a conversation's resident delegated tasks hold them. */
export interface AgentRuntimeSubagentTurns<T extends SubagentTurnTask> {
  readonly key: string;
  /** The task that delegated the subagent; it names the subagent and dates it. */
  readonly first: T;
  /** The turn the subagent shows now, chosen as the Runtime overview chooses it. */
  readonly current: T;
  /** Every resident turn, in the order the tasks arrived. */
  readonly turns: readonly T[];
}

/**
 * Groups delegated tasks into subagents, in the order each subagent first appears. Resident
 * tasks carry no queue holds, so a queued follow-up counts as queued.
 */
export function groupAgentRuntimeSubagentTurns<T extends SubagentTurnTask>(
  tasks: readonly T[],
): readonly AgentRuntimeSubagentTurns<T>[] {
  const groups = new Map<string, T[]>();
  for (const task of tasks) {
    const key = agentRuntimeSubagentKey(task);
    groups.set(key, [...(groups.get(key) ?? []), task]);
  }
  return [...groups].map(([key, turns]) => {
    const first = turns.reduce((earliest, task) =>
      (task.startedAt ?? "") < (earliest.startedAt ?? "") ? task : earliest,
    );
    const current = currentSubagentTurn(turns.map((task) => ({ ...task, held: false })))?.turn.id;
    return { key, first, current: turns.find((task) => task.id === current) ?? first, turns };
  });
}

const outcomeOf = (status: AgentSubagentOverviewItem["status"]): SubagentOutcome | null =>
  status === "completed"
    ? "completed"
    : status === "failed"
      ? "failed"
      : status === "interrupted"
        ? "stopped"
        : status === "cancelled"
          ? "cancelled"
          : status === "idle"
            ? "idle"
            : null;
const isLive = (status: AgentSubagentOverviewItem["status"]) =>
  status === "pending" || status === "running" || status === "waiting";
/** Newest first, matching the Runtime's page order and cursors. */
const newerFirst = (left: AgentSubagentOverviewItem, right: AgentSubagentOverviewItem) =>
  right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id);

/**
 * One row per subagent, presenting its current turn. Execution metadata is enough for the
 * overview; task bodies stay behind explicit detail reads.
 */
export const projectAgentRuntimeSubagent = (
  subagent: AgentSubagentOverviewItem,
  /** Whether this reader may stop work of the Run that owns the subagent's current turn. */
  canStopRun: (runId: string | null) => boolean = () => true,
  rootThreadId = subagent.threadId,
): SubagentOverviewRow => {
  const { displayName } = projectAgentRuntimeSubagentDisplay(subagent);
  const outcome = outcomeOf(subagent.status);
  return {
    threadId: agentRuntimeSubagentKey(subagent),
    identityThreadId: subagent.childThreadId,
    parentThreadId:
      subagent.parentTaskId === null
        ? rootThreadId
        : (subagent.parentTaskChildThreadId ?? subagent.parentTaskId),
    parentTurnKey: subagent.runId,
    displayName:
      displayName ??
      getIntl().formatMessage({
        id: "conversation.agentRuntimeSubagentOverview.subagent",
        defaultMessage: "Subagent",
      }),
    actorName: displayName,
    agentRole: null,
    agent: agentRuntimeSubagentAgent(subagent),
    spawnModel: subagent.modelSelection?.model ?? subagent.model,
    objective: null,
    status:
      subagent.status === "waiting"
        ? "waiting"
        : ["pending", "running"].includes(subagent.status)
          ? "active"
          : "done",
    ...(subagent.attention !== null ? { attentionKind: subagent.attention } : {}),
    ...(outcome !== null ? { outcome } : {}),
    statusSummary:
      subagent.attention !== null
        ? subagentAttentionLabel(subagent.attention, getIntl())
        : isLive(subagent.status) && subagent.recovery
          ? recoveryStatusLabel({
              state: "retrying",
              reason: subagent.recovery.kind,
              attempt: subagent.recovery.attempt,
              maxAttempts: subagent.recovery.maxAttempts,
              retryAt: null,
              updatedAt: null,
            })
          : subagent.status === "failed"
            ? getIntl().formatMessage({
                id: "conversation.agentRuntimeSubagentOverview.failed",
                defaultMessage: "Failed",
              })
            : subagent.status === "interrupted"
              ? getIntl().formatMessage({
                  id: "conversation.agentRuntimeSubagentOverview.stopped",
                  defaultMessage: "Stopped",
                })
              : subagent.status === "cancelled"
                ? getIntl().formatMessage({
                    id: "conversation.agentRuntimeSubagentOverview.cancelled",
                    defaultMessage: "Cancelled",
                  })
                : subagent.driver === "antigravity" &&
                    subagent.origin === "provider_native" &&
                    subagent.status === "idle"
                  ? getIntl().formatMessage({
                      id: "conversation.delegatedTaskPresentation.idle",
                      defaultMessage: "Idle",
                    })
                  : null,
    startedAtMs: agentRuntimeTime(subagent.startedAt),
    delegatedAtMs: agentRuntimeTime(subagent.delegatedAt),
    lastActivityAtMs: agentRuntimeTime(subagent.updatedAt),
    completedAtMs: agentRuntimeTime(subagent.completedAt),
    recencyAtMs: agentRuntimeTime(subagent.updatedAt) ?? 0,
    diffStats: null,
    canOpen: subagent.childThreadId !== null,
    // An application-owned child stops through its own conversation; a native one through its Run.
    // Either answers for the Run that owns its current turn.
    canStop:
      isLive(subagent.status) &&
      (subagent.childThreadId !== null || subagent.runId !== null) &&
      canStopRun(subagent.runId),
    canInteract: subagent.origin === "app_owned" && subagent.childThreadId !== null,
    showInlineActivity:
      subagent.childThreadId !== null &&
      !(subagent.driver === "antigravity" && subagent.origin === "provider_native"),
  };
};

export function projectAgentRuntimeSubagentOverview(
  rootThreadId: string,
  source: AgentSubagentOverview,
  canStopRun: (runId: string | null) => boolean = () => true,
): CodexSubagentOverviewWindow {
  const project = (subagent: AgentSubagentOverviewItem) =>
    projectAgentRuntimeSubagent(subagent, canStopRun, rootThreadId);
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
  isLive(item.status) ? "active" : "terminal";

/** Places one subagent by recency, keeping a newer report of the same subagent. */
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

/** Applies one subagent report to the loaded window without re-reading any page. */
export function applyAgentRuntimeOverviewReport(
  overview: AgentSubagentOverview,
  subagent: AgentSubagentOverviewItem,
): AgentSubagentOverview {
  return upsert(overview, subagent, true);
}

/** The loaded subagent a row presents, by the row's own key. */
export function findAgentRuntimeOverviewSubagent(
  overview: AgentSubagentOverview,
  row: Pick<CodexSubagentOverviewRow, "threadId">,
): AgentSubagentOverviewItem | undefined {
  return [...overview.active.items, ...overview.terminal.items].find(
    (subagent) => agentRuntimeSubagentKey(subagent) === row.threadId,
  );
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
 * report still on its way for a move the read already counted finds that row already moved. If
 * the window already has a newer report of a returned row, count the row in its newer section.
 */
export function reconcileAgentRuntimeOverview(
  overview: AgentSubagentOverview,
  read: AgentSubagentOverview,
): AgentSubagentOverview {
  let merged = overview;
  const totals = {
    active: read.active.totalCount,
    terminal: read.terminal.totalCount,
  };
  for (const item of [...read.active.items, ...read.terminal.items]) {
    const current = find(overview, item.id);
    if (current && current.updatedAt.localeCompare(item.updatedAt) > 0) {
      totals[sectionOf(item)] -= 1;
      totals[sectionOf(current)] += 1;
      continue;
    }
    merged = upsert(merged, item, false);
  }
  return {
    active: { ...merged.active, totalCount: totals.active },
    terminal: { ...merged.terminal, totalCount: totals.terminal },
  };
}

/** Merges an explicitly loaded page into the current window, keeping newer subagent reports. */
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
