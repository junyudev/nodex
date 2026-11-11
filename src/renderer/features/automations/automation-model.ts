import type { AutomationInboxItem, Automation, AutomationMode } from "@/lib/types";
import {
  formatWorkbenchAutomationScheduleLabel,
  resolveWorkbenchAutomationScheduleConfig,
} from "@/components/workbench/workbench-automation-schedule";

/** How each mode reads wherever an Automation shows it. */
export const AUTOMATION_MODE_LABELS: Readonly<Record<AutomationMode, string>> = {
  dry_run: "Dry run",
  ask_first: "Ask first",
  run: "Run",
};

/** Which task states the Automations sidebar lists. */
export interface AutomationStatusFilter {
  readonly active: boolean;
  readonly paused: boolean;
}

export const ALL_AUTOMATION_STATUSES: AutomationStatusFilter = { active: true, paused: true };

export interface AutomationRunRowModel {
  readonly runId: string;
  readonly sessionId: string | null;
  readonly title: string;
  readonly isRunning: boolean;
  readonly isUnread: boolean;
  /** Finished without asking for attention. */
  readonly isQuiet: boolean;
  readonly canOpen: boolean;
}

export interface AutomationRowModel {
  readonly automation: Automation;
  readonly title: string;
  readonly subtitle: string;
  readonly scheduleLabel: string;
  readonly isPaused: boolean;
  readonly isRunning: boolean;
  readonly hasUnreadRuns: boolean;
  /** Each due run waits in the Inbox for the user before it starts. */
  readonly asksFirst: boolean;
  /** A due run is waiting in the Inbox now. */
  readonly waitingInInbox: boolean;
  /** Cron tasks with runs open as a folder of their runs; Heartbeats open their chat. */
  readonly canExpand: boolean;
  /** Visible runs, newest first. */
  readonly runs: readonly AutomationRunRowModel[];
}

export function formatAutomationScheduleLabel(
  automation: Pick<Automation, "kind" | "rrule" | "sourceCondition">,
): string {
  if (automation.sourceCondition) return "GitHub events";
  const config = resolveWorkbenchAutomationScheduleConfig({
    rrule: automation.rrule,
    intervalStyle: automation.kind === "heartbeat" ? "heartbeat" : "default",
  });
  return formatWorkbenchAutomationScheduleLabel(config);
}

/** The date part of a next run: Today, Tomorrow, or a short month and day. */
export function formatAutomationNextRunDate(
  nextRunAt: number,
  now: Date,
  timezone = Intl.DateTimeFormat().resolvedOptions().timeZone,
): string {
  const nextRun = new Date(nextRunAt);
  const dateFormat = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: timezone,
  });
  const today = dateFormat.format(now);
  const nextDate = dateFormat.format(nextRun);
  if (nextDate === today) return "Today";
  const tomorrow = new Date(`${today}T12:00:00.000Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const tomorrowKey = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "UTC",
  }).format(tomorrow);
  if (nextDate === tomorrowKey) return "Tomorrow";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: nextDate.slice(0, 4) === today.slice(0, 4) ? undefined : "numeric",
    timeZone: timezone,
  }).format(nextRun);
}

export function formatAutomationSubtitle(automation: Automation, now: Date): string {
  const scheduleLabel = formatAutomationScheduleLabel(automation);
  if (automation.heldDecision) return `Waiting in Inbox · ${scheduleLabel}`;
  if (automation.status === "PAUSED") return `Paused · ${scheduleLabel}`;
  if (automation.nextRunAt === null || !Number.isFinite(automation.nextRunAt)) return scheduleLabel;
  return `${formatAutomationNextRunDate(automation.nextRunAt, now, automation.timezone)} · ${scheduleLabel}`;
}

/** What the Automations page answers after a task's instructions. */
export function formatAutomationConfirmation(
  automation: Pick<Automation, "status" | "nextRunAt" | "mode" | "heldDecision" | "timezone">,
): string {
  if (automation.heldDecision) return "A decision from this automation is waiting in the Inbox.";
  if (automation.status !== "ACTIVE" || automation.nextRunAt === null) {
    return automation.status === "PAUSED"
      ? "This automation is paused."
      : "This automation is saved.";
  }
  const nextRun = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    timeZone: automation.timezone,
  }).format(new Date(automation.nextRunAt));
  if (automation.mode === "dry_run") return `Next dry run: ${nextRun}.`;
  return automation.mode === "ask_first"
    ? `Next decision: ${nextRun}. It will wait in the Inbox.`
    : `Next run: ${nextRun}.`;
}

/** A reply names the task it is about, so the Agent can read or update that task. */
export function buildAutomationReplyPrompt(
  automation: Pick<Automation, "id" | "name">,
  message: string,
): string {
  return `${message.trim()}\n\n(About my automation “${automation.name}”, id \`${automation.id}\`.)`;
}

const DERIVED_NAME_MAX_LENGTH = 60;

/** A task created without a name takes the opening words of its instructions. */
export function deriveAutomationName(prompt: string): string {
  const firstLine = prompt
    .split(/\r?\n/u)
    .map((line) => line.trim().replaceAll(/\s+/gu, " "))
    .find((line) => line.length > 0);
  if (!firstLine) return "";
  if (firstLine.length <= DERIVED_NAME_MAX_LENGTH) return firstLine.replace(/[.。]$/u, "");
  const clipped = firstLine.slice(0, DERIVED_NAME_MAX_LENGTH);
  const wordBoundary = clipped.lastIndexOf(" ");
  const words =
    wordBoundary > DERIVED_NAME_MAX_LENGTH / 2 ? clipped.slice(0, wordBoundary) : clipped;
  return `${words.replace(/[\s,;:.-]+$/u, "")}…`;
}

export function formatAutomationRunTitle(item: AutomationInboxItem): string {
  if (item.status === "IN_PROGRESS") return "Running now";
  return item.title?.trim() || "Run completed";
}

/** A finished run nobody has looked at yet; a run still in progress has nothing to read. */
function isUnreadRun(item: AutomationInboxItem): boolean {
  return item.readAt === null && (item.status === "PENDING_REVIEW" || item.status === "ACCEPTED");
}

/** The unread runs whose chat is `sessionId`: one for a cron run, every unseen beat of a heartbeat. */
export function unreadRunIdsForSession(
  items: readonly AutomationInboxItem[],
  sessionId: string,
): string[] {
  return items
    .filter((item) => item.sessionId === sessionId && isUnreadRun(item))
    .map((item) => item.runId);
}

export function buildAutomationRunRows(
  items: readonly AutomationInboxItem[],
  automationId: string,
): AutomationRunRowModel[] {
  return items
    .filter((item) => item.automationId === automationId && item.status !== "ARCHIVED")
    .toSorted((left, right) => right.createdAt - left.createdAt)
    .map((item) => {
      const sessionId = item.sessionId?.trim() || null;
      return {
        runId: item.runId,
        sessionId,
        title: formatAutomationRunTitle(item),
        isRunning: item.status === "IN_PROGRESS",
        isUnread: isUnreadRun(item),
        isQuiet: item.quiet,
        canOpen: sessionId !== null,
      };
    });
}

function compareAutomations(left: Automation, right: Automation) {
  const leftPaused = left.status === "PAUSED";
  const rightPaused = right.status === "PAUSED";
  if (leftPaused !== rightPaused) return leftPaused ? 1 : -1;
  const leftNextRun = leftPaused ? Number.POSITIVE_INFINITY : (left.nextRunAt ?? Infinity);
  const rightNextRun = rightPaused ? Number.POSITIVE_INFINITY : (right.nextRunAt ?? Infinity);
  if (leftNextRun !== rightNextRun) return leftNextRun - rightNextRun;
  return left.name.localeCompare(right.name);
}

/**
 * Sidebar rows: active tasks by next run, then paused tasks, each filtered by status and by a
 * case-insensitive name query.
 */
export function buildAutomationRows({
  automations,
  runItems,
  unreadAutomationIds,
  filter = ALL_AUTOMATION_STATUSES,
  query = "",
  now,
}: {
  readonly automations: readonly Automation[];
  readonly runItems: readonly AutomationInboxItem[];
  readonly unreadAutomationIds: ReadonlySet<string>;
  readonly filter?: AutomationStatusFilter;
  readonly query?: string;
  readonly now: Date;
}): AutomationRowModel[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return automations
    .filter((automation) => automation.status !== "DELETED")
    .filter((automation) => (automation.status === "PAUSED" ? filter.paused : filter.active))
    .filter(
      (automation) =>
        normalizedQuery === "" || automation.name.toLocaleLowerCase().includes(normalizedQuery),
    )
    .toSorted(compareAutomations)
    .map((automation) => {
      const runs = buildAutomationRunRows(runItems, automation.id);
      return {
        automation,
        title: automation.name.trim() || "Untitled automation",
        subtitle: formatAutomationSubtitle(automation, now),
        scheduleLabel: formatAutomationScheduleLabel(automation),
        isPaused: automation.status === "PAUSED",
        isRunning: runs.some((run) => run.isRunning),
        hasUnreadRuns: unreadAutomationIds.has(automation.id),
        asksFirst: automation.mode === "ask_first",
        waitingInInbox: automation.heldDecision !== null,
        canExpand:
          automation.kind === "cron" && (runs.length > 0 || automation.heldDecision !== null),
        runs,
      };
    });
}
