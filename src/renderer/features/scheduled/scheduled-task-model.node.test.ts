import { describe, expect, test } from "vite-plus/test";
import type { CodexAutomationInboxItem, CodexScheduledAutomation } from "@/lib/types";
import {
  buildScheduledTaskRows,
  deriveScheduledTaskName,
  formatScheduledTaskConfirmation,
  formatScheduledTaskNextRunDate,
  formatScheduledTaskSubtitle,
} from "./scheduled-task-model";

const NOW = new Date(2026, 9, 16, 12, 0);

function task(overrides: Partial<CodexScheduledAutomation> = {}): CodexScheduledAutomation {
  return {
    id: "task",
    definitionRevision: 1,
    kind: "cron",
    status: "ACTIVE",
    projectId: null,
    targetSessionId: null,
    notificationPolicy: null,
    launch: "automatic",
    runbookPageId: null,
    runbookTitle: null,
    heldFiring: null,
    name: "Task",
    prompt: "Do the thing",
    rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0",
    model: null,
    reasoningEffort: null,
    serviceTier: null,
    backendBinding: { kind: "codex" } as CodexScheduledAutomation["backendBinding"],
    cwds: [],
    executionEnvironment: "local",
    localEnvironmentConfigPath: null,
    nextRunAt: new Date(2026, 9, 19, 9, 0).getTime(),
    lastRunAt: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function run(overrides: Partial<CodexAutomationInboxItem> = {}): CodexAutomationInboxItem {
  return {
    id: "run",
    automationId: "task",
    automationName: "Task",
    title: null,
    description: null,
    archivedAssistantMessage: null,
    archivedUserMessage: null,
    archivedReason: null,
    sourceCwd: null,
    runId: "run",
    sessionId: "session-run",
    readAt: null,
    createdAt: 1,
    status: "PENDING_REVIEW",
    ...overrides,
  };
}

describe("scheduled task model", () => {
  test("subtitles pair the next run date with the schedule, or say Paused", () => {
    expect(formatScheduledTaskSubtitle(task(), NOW)).toBe("Oct 19 · Mondays at 9:00 AM");
    expect(formatScheduledTaskSubtitle(task({ status: "PAUSED" }), NOW)).toBe(
      "Paused · Mondays at 9:00 AM",
    );
    expect(formatScheduledTaskSubtitle(task({ nextRunAt: null }), NOW)).toBe("Mondays at 9:00 AM");
    expect(formatScheduledTaskNextRunDate(new Date(2026, 9, 16, 18).getTime(), NOW)).toBe("Today");
    expect(formatScheduledTaskNextRunDate(new Date(2026, 9, 17, 9).getTime(), NOW)).toBe(
      "Tomorrow",
    );
  });

  test("a task that asks first says when a run is waiting for the user in the Inbox", () => {
    const heldFiring = {
      dispatchId: "dispatch",
      pageId: "page",
      inboxProjectId: null,
      firstScheduledFor: new Date(2026, 9, 12, 9).getTime(),
      lastScheduledFor: new Date(2026, 9, 12, 9).getTime(),
      missedCount: 0,
    };
    const waiting = task({ launch: "ask", heldFiring });
    expect(formatScheduledTaskSubtitle(waiting, NOW)).toBe("Waiting in Inbox · Mondays at 9:00 AM");
    expect(formatScheduledTaskConfirmation(waiting)).toBe(
      "A run of this task is waiting for you in the Inbox.",
    );
    expect(formatScheduledTaskConfirmation(task({ launch: "ask" }))).toMatch(
      /^Your task is scheduled\. Its next run is .+, and it will wait for you in the Inbox\.$/u,
    );
    const [row] = buildScheduledTaskRows({
      automations: [waiting],
      runItems: [],
      unreadAutomationIds: new Set(),
      now: NOW,
    });
    // A waiting run opens the folder even before the task has run.
    expect(row).toMatchObject({ asksFirst: true, waitingInInbox: true, canExpand: true });
  });

  test("lists active tasks by next run before paused tasks, filtered by status and name", () => {
    const automations = [
      task({ id: "paused", name: "Paused digest", status: "PAUSED", nextRunAt: null }),
      task({ id: "later", name: "Later", nextRunAt: new Date(2026, 9, 20).getTime() }),
      task({ id: "soon", name: "Soon", nextRunAt: new Date(2026, 9, 17).getTime() }),
      task({ id: "gone", name: "Gone", status: "DELETED" }),
    ];
    const rows = (input: Parameters<typeof buildScheduledTaskRows>[0]) =>
      buildScheduledTaskRows(input).map((row) => row.automation.id);
    const base = { automations, runItems: [], unreadAutomationIds: new Set<string>(), now: NOW };

    expect(rows(base)).toEqual(["soon", "later", "paused"]);
    expect(rows({ ...base, filter: { active: false, paused: true } })).toEqual(["paused"]);
    expect(rows({ ...base, query: "DIGEST" })).toEqual(["paused"]);
  });

  test("cron tasks with runs become folders of their newest unarchived runs", () => {
    const [row] = buildScheduledTaskRows({
      automations: [task()],
      runItems: [
        run({ runId: "old", createdAt: 1, title: "Found two regressions", readAt: 5 }),
        run({ runId: "new", createdAt: 3, status: "IN_PROGRESS", sessionId: null }),
        run({ runId: "archived", createdAt: 2, status: "ARCHIVED" }),
        run({ runId: "other", automationId: "other-task" }),
      ],
      unreadAutomationIds: new Set(["task"]),
      now: NOW,
    });

    expect(row?.canExpand).toBe(true);
    expect(row?.isRunning).toBe(true);
    expect(row?.hasUnreadRuns).toBe(true);
    expect(row?.runs.map((entry) => [entry.runId, entry.title, entry.canOpen])).toEqual([
      ["new", "Running now", false],
      ["old", "Found two regressions", true],
    ]);
  });

  test("Heartbeats never expand because each opens its chat", () => {
    const [row] = buildScheduledTaskRows({
      automations: [task({ kind: "heartbeat", targetSessionId: "chat" })],
      runItems: [run()],
      unreadAutomationIds: new Set(),
      now: NOW,
    });
    expect(row?.canExpand).toBe(false);
  });

  test("a task created without a name is named after the first line of its instructions", () => {
    expect(deriveScheduledTaskName("\n  Summarize   yesterday's merged PRs.\nThen post it.")).toBe(
      "Summarize yesterday's merged PRs",
    );
    expect(
      deriveScheduledTaskName(
        "Review every open pull request in the repository and flag the ones that are stale or blocked",
      ),
    ).toBe("Review every open pull request in the repository and flag…");
    expect(deriveScheduledTaskName("   ")).toBe("");
  });

  test("the confirmation names the next run, or points to task details without one", () => {
    expect(formatScheduledTaskConfirmation(task())).toMatch(
      /^Your task is scheduled\. Its next run is Oct 19, 9:00 AM \S+\.$/u,
    );
    expect(formatScheduledTaskConfirmation(task({ status: "PAUSED", nextRunAt: null }))).toBe(
      "Your task is saved. You can review its schedule and settings in task details.",
    );
  });
});
