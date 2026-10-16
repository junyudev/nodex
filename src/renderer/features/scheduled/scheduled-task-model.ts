import type { CodexAutomationInboxItem, CodexScheduledAutomation } from "@/lib/types";
import {
  formatWorkbenchAutomationScheduleLabel,
  resolveWorkbenchAutomationScheduleConfig,
} from "@/components/workbench/workbench-automation-schedule";

/** Which task states the Scheduled sidebar lists. */
export interface ScheduledStatusFilter {
  readonly active: boolean;
  readonly paused: boolean;
}

export const ALL_SCHEDULED_STATUSES: ScheduledStatusFilter = { active: true, paused: true };

export interface ScheduledRunRowModel {
  readonly runId: string;
  readonly sessionId: string | null;
  readonly title: string;
  readonly isRunning: boolean;
  readonly isUnread: boolean;
  readonly canOpen: boolean;
}

export interface ScheduledTaskRowModel {
  readonly automation: CodexScheduledAutomation;
  readonly title: string;
  readonly subtitle: string;
  readonly scheduleLabel: string;
  readonly isPaused: boolean;
  readonly isRunning: boolean;
  readonly hasUnreadRuns: boolean;
  /** Cron tasks with runs open as a folder of their runs; Heartbeats open their chat. */
  readonly canExpand: boolean;
  /** Visible runs, newest first. */
  readonly runs: readonly ScheduledRunRowModel[];
}

export function formatScheduledTaskScheduleLabel(
  automation: Pick<CodexScheduledAutomation, "kind" | "rrule">,
): string {
  const config = resolveWorkbenchAutomationScheduleConfig({
    rrule: automation.rrule,
    intervalStyle: automation.kind === "heartbeat" ? "heartbeat" : "default",
  });
  return formatWorkbenchAutomationScheduleLabel(config);
}

function isSameLocalDate(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

/** The date part of a next run: Today, Tomorrow, or a short month and day. */
export function formatScheduledTaskNextRunDate(nextRunAt: number, now: Date): string {
  const nextRun = new Date(nextRunAt);
  if (isSameLocalDate(nextRun, now)) return "Today";
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (isSameLocalDate(nextRun, tomorrow)) return "Tomorrow";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: nextRun.getFullYear() === now.getFullYear() ? undefined : "numeric",
  }).format(nextRun);
}

export function formatScheduledTaskSubtitle(
  automation: CodexScheduledAutomation,
  now: Date,
): string {
  const scheduleLabel = formatScheduledTaskScheduleLabel(automation);
  if (automation.status === "PAUSED") return `Paused · ${scheduleLabel}`;
  if (automation.nextRunAt === null || !Number.isFinite(automation.nextRunAt)) return scheduleLabel;
  return `${formatScheduledTaskNextRunDate(automation.nextRunAt, now)} · ${scheduleLabel}`;
}

/** What the Scheduled page answers after a task's instructions. */
export function formatScheduledTaskConfirmation(
  automation: Pick<CodexScheduledAutomation, "status" | "nextRunAt">,
): string {
  if (automation.status !== "ACTIVE" || automation.nextRunAt === null) {
    return "Your task is saved. You can review its schedule and settings in task details.";
  }
  const nextRun = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(automation.nextRunAt));
  return `Your task is scheduled. Its next run is ${nextRun}.`;
}

/** A reply names the task it is about, so the Agent can read or update that task. */
export function buildScheduledTaskReplyPrompt(
  automation: Pick<CodexScheduledAutomation, "id" | "name">,
  message: string,
): string {
  return `${message.trim()}\n\n(About my scheduled task “${automation.name}”, id \`${automation.id}\`.)`;
}

const DERIVED_NAME_MAX_LENGTH = 60;

/** A task created without a name takes the opening words of its instructions. */
export function deriveScheduledTaskName(prompt: string): string {
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

export function formatScheduledRunTitle(item: CodexAutomationInboxItem): string {
  if (item.status === "IN_PROGRESS") return "Running now";
  return item.title?.trim() || "Run completed";
}

export function buildScheduledRunRows(
  items: readonly CodexAutomationInboxItem[],
  automationId: string,
): ScheduledRunRowModel[] {
  return items
    .filter((item) => item.automationId === automationId && item.status !== "ARCHIVED")
    .toSorted((left, right) => right.createdAt - left.createdAt)
    .map((item) => {
      const sessionId = item.sessionId?.trim() || null;
      return {
        runId: item.runId,
        sessionId,
        title: formatScheduledRunTitle(item),
        isRunning: item.status === "IN_PROGRESS",
        isUnread: item.readAt === null && item.status !== "IN_PROGRESS",
        canOpen: sessionId !== null,
      };
    });
}

function compareScheduledTasks(left: CodexScheduledAutomation, right: CodexScheduledAutomation) {
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
export function buildScheduledTaskRows({
  automations,
  runItems,
  unreadAutomationIds,
  filter = ALL_SCHEDULED_STATUSES,
  query = "",
  now,
}: {
  readonly automations: readonly CodexScheduledAutomation[];
  readonly runItems: readonly CodexAutomationInboxItem[];
  readonly unreadAutomationIds: ReadonlySet<string>;
  readonly filter?: ScheduledStatusFilter;
  readonly query?: string;
  readonly now: Date;
}): ScheduledTaskRowModel[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return automations
    .filter((automation) => automation.status !== "DELETED")
    .filter((automation) => (automation.status === "PAUSED" ? filter.paused : filter.active))
    .filter(
      (automation) =>
        normalizedQuery === "" || automation.name.toLocaleLowerCase().includes(normalizedQuery),
    )
    .toSorted(compareScheduledTasks)
    .map((automation) => {
      const runs = buildScheduledRunRows(runItems, automation.id);
      return {
        automation,
        title: automation.name.trim() || "Untitled task",
        subtitle: formatScheduledTaskSubtitle(automation, now),
        scheduleLabel: formatScheduledTaskScheduleLabel(automation),
        isPaused: automation.status === "PAUSED",
        isRunning: runs.some((run) => run.isRunning),
        hasUnreadRuns: unreadAutomationIds.has(automation.id),
        canExpand: automation.kind === "cron" && runs.length > 0,
        runs,
      };
    });
}
