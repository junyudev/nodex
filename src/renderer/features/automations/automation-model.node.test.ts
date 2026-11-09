import { describe, expect, test } from "vite-plus/test";
import type { AutomationInboxItem, Automation } from "@/lib/types";
import {
  buildAutomationRows,
  deriveAutomationName,
  formatAutomationConfirmation,
  formatAutomationNextRunDate,
  formatAutomationSubtitle,
} from "./automation-model";

const NOW = new Date(2026, 9, 16, 12, 0);

function task(overrides: Partial<Automation> = {}): Automation {
  return {
    id: "task",
    automationRevision: 1,
    scope: { kind: "space" },
    kind: "cron",
    status: "ACTIVE",
    projectId: null,
    targetSessionId: null,
    notificationPolicy: null,
    mode: "run",
    ownerMemberId: "member:owner",
    conditionText: "Every Monday at 9",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    runbookPageId: null,
    runbookTitle: null,
    heldDecision: null,
    name: "Task",
    prompt: "Do the thing",
    rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0",
    model: null,
    reasoningEffort: null,
    serviceTier: null,
    backendBinding: { kind: "codex" } as Automation["backendBinding"],
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

function run(overrides: Partial<AutomationInboxItem> = {}): AutomationInboxItem {
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

describe("automation model", () => {
  test("Dry run describes its next dry run and keeps the Automation's saved time zone", () => {
    const automation = task({
      mode: "dry_run",
      timezone: "Asia/Tokyo",
      nextRunAt: Date.parse("2026-10-19T00:00:00Z"),
    });
    expect(formatAutomationConfirmation(automation)).toMatch(/^Next dry run: Oct 19, 9:00 AM /u);
    expect(
      formatAutomationNextRunDate(
        Date.parse("2026-10-18T23:00:00Z"),
        new Date("2026-10-18T16:00:00Z"),
        "Asia/Tokyo",
      ),
    ).toBe("Today");
  });
  test("subtitles pair the next run date with the schedule, or say Paused", () => {
    expect(formatAutomationSubtitle(task(), NOW)).toBe("Oct 19 · Mondays at 9:00 AM");
    expect(formatAutomationSubtitle(task({ status: "PAUSED" }), NOW)).toBe(
      "Paused · Mondays at 9:00 AM",
    );
    expect(formatAutomationSubtitle(task({ nextRunAt: null }), NOW)).toBe("Mondays at 9:00 AM");
    expect(formatAutomationNextRunDate(new Date(2026, 9, 16, 18).getTime(), NOW)).toBe("Today");
    expect(formatAutomationNextRunDate(new Date(2026, 9, 17, 9).getTime(), NOW)).toBe("Tomorrow");
  });

  test("a task that asks first says when a run is waiting for the user in the Inbox", () => {
    const heldDecision = {
      dispatchId: "dispatch",
      pageId: "page",
      inboxProjectId: null,
      firstScheduledFor: new Date(2026, 9, 12, 9).getTime(),
      lastScheduledFor: new Date(2026, 9, 12, 9).getTime(),
      missedCount: 0,
    };
    const waiting = task({ mode: "ask_first", heldDecision });
    expect(formatAutomationSubtitle(waiting, NOW)).toBe("Waiting in Inbox · Mondays at 9:00 AM");
    expect(formatAutomationConfirmation(waiting)).toBe(
      "A decision from this automation is waiting in the Inbox.",
    );
    expect(formatAutomationConfirmation(task({ mode: "ask_first" }))).toMatch(
      /^Next decision: .+\. It will wait in the Inbox\.$/u,
    );
    const [row] = buildAutomationRows({
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
    const rows = (input: Parameters<typeof buildAutomationRows>[0]) =>
      buildAutomationRows(input).map((row) => row.automation.id);
    const base = { automations, runItems: [], unreadAutomationIds: new Set<string>(), now: NOW };

    expect(rows(base)).toEqual(["soon", "later", "paused"]);
    expect(rows({ ...base, filter: { active: false, paused: true } })).toEqual(["paused"]);
    expect(rows({ ...base, query: "DIGEST" })).toEqual(["paused"]);
  });

  test("cron tasks with runs become folders of their newest unarchived runs", () => {
    const [row] = buildAutomationRows({
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
    const [row] = buildAutomationRows({
      automations: [task({ kind: "heartbeat", targetSessionId: "chat" })],
      runItems: [run()],
      unreadAutomationIds: new Set(),
      now: NOW,
    });
    expect(row?.canExpand).toBe(false);
  });

  test("a task created without a name is named after the first line of its instructions", () => {
    expect(deriveAutomationName("\n  Summarize   yesterday's merged PRs.\nThen post it.")).toBe(
      "Summarize yesterday's merged PRs",
    );
    expect(
      deriveAutomationName(
        "Review every open pull request in the repository and flag the ones that are stale or blocked",
      ),
    ).toBe("Review every open pull request in the repository and flag…");
    expect(deriveAutomationName("   ")).toBe("");
  });

  test("the confirmation names the next run, or points to task details without one", () => {
    expect(formatAutomationConfirmation(task())).toMatch(/^Next run: Oct 19, 9:00 AM \S+\.$/u);
    expect(formatAutomationConfirmation(task({ status: "PAUSED", nextRunAt: null }))).toBe(
      "This automation is paused.",
    );
  });
});
