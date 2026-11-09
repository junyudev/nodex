import { describe, expect, test } from "vite-plus/test";
import type { Automation } from "@/lib/types";
import { buildThreadSummaryPanelAutomationRow } from "./thread-summary-panel-automation-model";

function automation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: "automation-1",
    automationRevision: 1,
    scope: { kind: "space" },
    ownerMemberId: "member-owner",
    conditionText: "Every day",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    projectId: null,
    notificationPolicy: null,
    mode: "run",
    runbookPageId: null,
    runbookTitle: null,
    heldDecision: null,
    kind: "heartbeat",
    status: "ACTIVE",
    targetSessionId: "thread-1",
    name: "Daily standup",
    prompt: "Check the daily standup thread.",
    rrule: "FREQ=DAILY",
    model: null,
    reasoningEffort: null,
    serviceTier: null,
    backendBinding: { kind: "codex" },
    cwds: [],
    executionEnvironment: "worktree",
    localEnvironmentConfigPath: null,
    nextRunAt: new Date(2026, 6, 8, 9, 30).getTime(),
    lastRunAt: null,
    createdAt: 10,
    updatedAt: 10,
    ...overrides,
  };
}

describe("thread summary clock Automation projection", () => {
  test("selects the first active heartbeat automation for the current thread", () => {
    const row = buildThreadSummaryPanelAutomationRow({
      automations: [
        automation({ id: "paused", status: "PAUSED" }),
        automation({ id: "cron", kind: "cron" }),
        automation({ id: "wrong-thread", targetSessionId: "thread-2" }),
        automation({ id: "first-match", name: "First match" }),
        automation({ id: "second-match", name: "Second match" }),
      ],
      sessionId: "thread-1",
      now: new Date(2026, 6, 8, 8, 0),
    });

    expect(row?.id).toBe("first-match");
    expect(row?.name).toBe("First match");
    expect(row?.scheduleSummary).toBe("Daily");
    expect(row?.nextRunLabel).toBe("today at 9:30 AM");
  });

  test("returns null when the current thread has no active heartbeat automation", () => {
    const row = buildThreadSummaryPanelAutomationRow({
      automations: [
        automation({ id: "paused", status: "PAUSED" }),
        automation({ id: "cron", kind: "cron" }),
        automation({ id: "wrong-thread", targetSessionId: "thread-2" }),
      ],
      sessionId: "thread-1",
      now: new Date(2026, 6, 8, 8, 0),
    });

    expect(row).toBe(null);
  });

  test("summarizes common heartbeat schedules and falls back for custom rules", () => {
    const weekday = buildThreadSummaryPanelAutomationRow({
      automations: [automation({ rrule: "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR" })],
      sessionId: "thread-1",
      now: new Date(2026, 6, 7, 8, 0),
    });
    const custom = buildThreadSummaryPanelAutomationRow({
      automations: [automation({ id: "custom", rrule: "FREQ=HOURLY", nextRunAt: null })],
      sessionId: "thread-1",
      now: new Date(2026, 6, 7, 8, 0),
    });

    expect(weekday?.scheduleSummary).toBe("Every weekday");
    expect(weekday?.nextRunLabel).toBe("tomorrow at 9:30 AM");
    expect(custom?.scheduleSummary).toBe("Custom schedule");
    expect(custom?.nextRunLabel).toBe("No upcoming run");
  });
});
