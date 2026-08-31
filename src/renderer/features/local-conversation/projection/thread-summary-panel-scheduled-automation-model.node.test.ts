import { describe, expect, test } from "vite-plus/test";
import type { CodexScheduledAutomation } from "@/lib/types";
import { buildThreadSummaryPanelScheduledAutomationRow } from "./thread-summary-panel-scheduled-automation-model";

function automation(overrides: Partial<CodexScheduledAutomation> = {}): CodexScheduledAutomation {
  return {
    id: "automation-1",
    definitionRevision: 1,
    kind: "heartbeat",
    status: "ACTIVE",
    targetThreadId: "thread-1",
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

describe("thread summary scheduled automation projection", () => {
  test("selects the first active heartbeat automation for the current thread", () => {
    const row = buildThreadSummaryPanelScheduledAutomationRow({
      automations: [
        automation({ id: "paused", status: "PAUSED" }),
        automation({ id: "cron", kind: "cron" }),
        automation({ id: "wrong-thread", targetThreadId: "thread-2" }),
        automation({ id: "first-match", name: "First match" }),
        automation({ id: "second-match", name: "Second match" }),
      ],
      conversationId: "thread-1",
      now: new Date(2026, 6, 8, 8, 0),
    });

    expect(row?.id).toBe("first-match");
    expect(row?.name).toBe("First match");
    expect(row?.scheduleSummary).toBe("Daily");
    expect(row?.nextRunLabel).toBe("today at 9:30 AM");
  });

  test("returns null when the current thread has no active heartbeat automation", () => {
    const row = buildThreadSummaryPanelScheduledAutomationRow({
      automations: [
        automation({ id: "paused", status: "PAUSED" }),
        automation({ id: "cron", kind: "cron" }),
        automation({ id: "wrong-thread", targetThreadId: "thread-2" }),
      ],
      conversationId: "thread-1",
      now: new Date(2026, 6, 8, 8, 0),
    });

    expect(row).toBe(null);
  });

  test("summarizes common heartbeat schedules and falls back for custom rules", () => {
    const weekday = buildThreadSummaryPanelScheduledAutomationRow({
      automations: [automation({ rrule: "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR" })],
      conversationId: "thread-1",
      now: new Date(2026, 6, 7, 8, 0),
    });
    const custom = buildThreadSummaryPanelScheduledAutomationRow({
      automations: [automation({ id: "custom", rrule: "FREQ=HOURLY", nextRunAt: null })],
      conversationId: "thread-1",
      now: new Date(2026, 6, 7, 8, 0),
    });

    expect(weekday?.scheduleSummary).toBe("Every weekday");
    expect(weekday?.nextRunLabel).toBe("tomorrow at 9:30 AM");
    expect(custom?.scheduleSummary).toBe("Custom schedule");
    expect(custom?.nextRunLabel).toBe("No upcoming run");
  });
});
