import { getIntl, type MessageDescriptor, defineMessage, type IntlShape } from "@/lib/i18n";
import type { AutomationInboxItem, Automation, AutomationMode } from "@/lib/types";
import {
  formatWorkbenchAutomationScheduleLabel,
  resolveWorkbenchAutomationScheduleConfig,
} from "@/components/workbench/workbench-automation-schedule";

/** How each mode reads wherever an Automation shows it. */
export const AUTOMATION_MODE_LABELS: Readonly<Record<AutomationMode, MessageDescriptor>> = {
  dry_run: defineMessage({ id: "automations.automationModel.dryRun", defaultMessage: "Dry run" }),
  ask_first: defineMessage({
    id: "automations.automationModel.askFirst",
    defaultMessage: "Ask first",
  }),
  run: defineMessage({ id: "automations.automationModel.run", defaultMessage: "Run" }),
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
  automation: Pick<Automation, "kind" | "trigger">,
  intl = getIntl(),
): string {
  if (automation.trigger.kind === "event")
    return intl.formatMessage({
      id: "automations.automationModel.gitHubEvents",
      defaultMessage: "GitHub events",
    });
  const config = resolveWorkbenchAutomationScheduleConfig({
    rrule: automation.trigger.rrule,
    intervalStyle: automation.kind === "heartbeat" ? "heartbeat" : "default",
  });
  return formatWorkbenchAutomationScheduleLabel(config, intl);
}

/** When a clock Automation next falls due; event Automations have no next run. */
function automationNextRunAt(automation: Pick<Automation, "trigger">): number {
  return automation.trigger.kind === "clock"
    ? (automation.trigger.nextRunAt ?? Number.POSITIVE_INFINITY)
    : Number.POSITIVE_INFINITY;
}

/** The date part of a next run: Today, Tomorrow, or a short month and day. */
export function formatAutomationNextRunDate(
  nextRunAt: number,
  now: Date,
  timezone = Intl.DateTimeFormat().resolvedOptions().timeZone,
  intl = getIntl(),
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
  if (nextDate === today)
    return intl.formatMessage({
      id: "automations.automationModel.today",
      defaultMessage: "Today",
    });
  const tomorrow = new Date(`${today}T12:00:00.000Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const tomorrowKey = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "UTC",
  }).format(tomorrow);
  if (nextDate === tomorrowKey)
    return intl.formatMessage({
      id: "automations.automationModel.tomorrow",
      defaultMessage: "Tomorrow",
    });
  return new Intl.DateTimeFormat(intl.locale, {
    month: "short",
    day: "numeric",
    year: nextDate.slice(0, 4) === today.slice(0, 4) ? undefined : "numeric",
    timeZone: timezone,
  }).format(nextRun);
}

export function formatAutomationSubtitle(
  automation: Automation,
  now: Date,
  intl = getIntl(),
): string {
  const scheduleLabel = formatAutomationScheduleLabel(automation, intl);
  if (automation.heldDecision)
    return intl.formatMessage(
      {
        id: "automations.automationModel.waitingInInboxValue",
        defaultMessage: "Waiting in Inbox · {value1}",
      },
      { value1: scheduleLabel },
    );
  if (automation.status === "PAUSED")
    return intl.formatMessage(
      { id: "automations.automationModel.pausedValue", defaultMessage: "Paused · {value1}" },
      { value1: scheduleLabel },
    );
  const { trigger } = automation;
  if (trigger.kind === "event" || trigger.nextRunAt === null || !Number.isFinite(trigger.nextRunAt))
    return scheduleLabel;
  return `${formatAutomationNextRunDate(trigger.nextRunAt, now, trigger.timezone, intl)} · ${scheduleLabel}`;
}

/** What the Automations page answers after a task's instructions. */
export function formatAutomationConfirmation(
  automation: Pick<Automation, "status" | "trigger" | "mode" | "heldDecision">,
  intl = getIntl(),
): string {
  const { trigger } = automation;
  if (automation.heldDecision)
    return intl.formatMessage({
      id: "automations.automationModel.aDecisionFromThisAutomation",
      defaultMessage: "A decision from this automation is waiting in the Inbox.",
    });
  if (automation.status !== "ACTIVE" || trigger.kind === "event" || trigger.nextRunAt === null) {
    return automation.status === "PAUSED"
      ? intl.formatMessage({
          id: "automations.automationModel.thisAutomationIsPaused",
          defaultMessage: "This automation is paused.",
        })
      : intl.formatMessage({
          id: "automations.automationModel.thisAutomationIsSaved",
          defaultMessage: "This automation is saved.",
        });
  }
  const nextRun = new Intl.DateTimeFormat(intl.locale, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    timeZone: trigger.timezone,
  }).format(new Date(trigger.nextRunAt));
  if (automation.mode === "dry_run")
    return intl.formatMessage(
      {
        id: "automations.automationModel.nextDryRunValue",
        defaultMessage: "Next dry run: {value1}.",
      },
      { value1: nextRun },
    );
  return automation.mode === "ask_first"
    ? intl.formatMessage(
        {
          id: "automations.automationModel.nextDecisionValueItWill",
          defaultMessage: "Next decision: {value1}. It will wait in the Inbox.",
        },
        { value1: nextRun },
      )
    : intl.formatMessage(
        { id: "automations.automationModel.nextRunValue", defaultMessage: "Next run: {value1}." },
        { value1: nextRun },
      );
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

export function formatAutomationRunTitle(item: AutomationInboxItem, intl = getIntl()): string {
  if (item.status === "IN_PROGRESS")
    return intl.formatMessage({
      id: "automations.automationModel.runningNow",
      defaultMessage: "Running now",
    });
  return (
    item.title?.trim() ||
    intl.formatMessage({
      id: "automations.automationModel.runCompleted",
      defaultMessage: "Run completed",
    })
  );
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
  intl = getIntl(),
): AutomationRunRowModel[] {
  return items
    .filter((item) => item.automationId === automationId && item.status !== "ARCHIVED")
    .toSorted((left, right) => right.createdAt - left.createdAt)
    .map((item) => {
      const sessionId = item.sessionId?.trim() || null;
      return {
        runId: item.runId,
        sessionId,
        title: formatAutomationRunTitle(item, intl),
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
  const leftNextRun = leftPaused ? Number.POSITIVE_INFINITY : automationNextRunAt(left);
  const rightNextRun = rightPaused ? Number.POSITIVE_INFINITY : automationNextRunAt(right);
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
  intl = getIntl(),
}: {
  readonly automations: readonly Automation[];
  readonly runItems: readonly AutomationInboxItem[];
  readonly unreadAutomationIds: ReadonlySet<string>;
  readonly filter?: AutomationStatusFilter;
  readonly query?: string;
  readonly now: Date;
  readonly intl?: IntlShape;
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
      const runs = buildAutomationRunRows(runItems, automation.id, intl);
      return {
        automation,
        title:
          automation.name.trim() ||
          intl.formatMessage({
            id: "automations.automationModel.untitledAutomation",
            defaultMessage: "Untitled automation",
          }),
        subtitle: formatAutomationSubtitle(automation, now, intl),
        scheduleLabel: formatAutomationScheduleLabel(automation, intl),
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
