import { describe, expect, test } from "vite-plus/test";
import type { CodexScheduledAutomation } from "../../shared/types";
import {
  CODEX_SCHEDULED_AUTOMATION_JITTER_MAX_SECONDS,
  DEFAULT_CODEX_SCHEDULED_AUTOMATION_RRULE,
  computeCodexScheduledAutomationIntervalMs,
  computeCodexScheduledAutomationJitterMs,
  computeCodexScheduledAutomationNextRunAt,
  listDueCodexScheduledAutomations,
  normalizeCodexScheduledAutomationRrule,
  reconcileCodexScheduledAutomationRuntimeState,
  shouldJitterCodexScheduledAutomation,
} from "./codex-scheduled-automation-schedule";

function automation(overrides: Partial<CodexScheduledAutomation> = {}): CodexScheduledAutomation {
  return {
    id: "automation-1",
    definitionRevision: 1,
    kind: "cron",
    status: "ACTIVE",
    targetThreadId: null,
    name: "Report",
    prompt: "Run the report.",
    rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=30",
    model: null,
    reasoningEffort: null,
    serviceTier: null,
    backendBinding: { kind: "codex" },
    cwds: ["/repo/project"],
    executionEnvironment: "worktree",
    localEnvironmentConfigPath: null,
    nextRunAt: null,
    lastRunAt: null,
    createdAt: 10,
    updatedAt: 10,
    ...overrides,
  };
}

describe("codex scheduled automation schedule helpers", () => {
  test("normalizes missing RRULEs to the reference default interval", () => {
    expect(normalizeCodexScheduledAutomationRrule(null)).toBe(
      DEFAULT_CODEX_SCHEDULED_AUTOMATION_RRULE,
    );
    expect(normalizeCodexScheduledAutomationRrule("  FREQ=DAILY  ")).toBe("FREQ=DAILY");
  });

  test("computes interval schedules without jitter for heartbeat intervals", () => {
    const now = Date.UTC(2026, 6, 8, 14, 36, 47);
    const next = computeCodexScheduledAutomationNextRunAt({
      automation: {
        id: "heartbeat-1",
        kind: "heartbeat",
        rrule: "FREQ=MINUTELY;INTERVAL=5",
      },
      now,
      jitterSalt: "salt",
    });

    expect(computeCodexScheduledAutomationIntervalMs("FREQ=MINUTELY;INTERVAL=5")).toBe(5 * 60_000);
    expect(next).toBe(Date.UTC(2026, 6, 8, 14, 41, 0));
  });

  test("applies deterministic jitter to cron daily schedules", () => {
    const now = new Date(2026, 6, 8, 8, 0, 0, 0).getTime();
    const base = new Date(2026, 6, 8, 9, 30, 0, 0).getTime();
    const jitter = computeCodexScheduledAutomationJitterMs({
      automationId: "cron-1",
      nextRunAt: base,
      jitterSalt: "salt",
    });
    const next = computeCodexScheduledAutomationNextRunAt({
      automation: {
        id: "cron-1",
        kind: "cron",
        rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=30",
      },
      now,
      jitterSalt: "salt",
    });

    expect(jitter >= 0).toBe(true);
    expect(jitter < CODEX_SCHEDULED_AUTOMATION_JITTER_MAX_SECONDS * 1_000).toBe(true);
    expect(next).toBe(base + jitter);
    expect(
      shouldJitterCodexScheduledAutomation({
        automation: {
          id: "cron-1",
          kind: "cron",
          rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=30",
        },
      }),
    ).toBe(true);
  });

  test("reconciles active, paused, and changed schedules against mirror state", () => {
    const now = new Date(2026, 6, 8, 8, 0, 0, 0).getTime();
    const mirror = automation({
      rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=30",
      nextRunAt: 123,
      lastRunAt: 456,
    });

    const unchanged = reconcileCodexScheduledAutomationRuntimeState({
      automation: automation(),
      mirror,
      now,
      jitterSalt: "salt",
    });
    expect(unchanged.nextRunAt).toBe(123);
    expect(unchanged.lastRunAt).toBe(456);

    const changed = reconcileCodexScheduledAutomationRuntimeState({
      automation: automation({ rrule: "FREQ=DAILY;BYHOUR=10;BYMINUTE=0" }),
      mirror,
      now,
      jitterSalt: "salt",
    });
    expect(changed.nextRunAt === 123).toBe(false);
    expect(changed.lastRunAt).toBe(456);

    const paused = reconcileCodexScheduledAutomationRuntimeState({
      automation: automation({ status: "PAUSED" }),
      mirror,
      now,
      jitterSalt: "salt",
    });
    expect(paused.nextRunAt).toBe(null);
  });

  test("selects due automations in next-run order with a limit", () => {
    const due = listDueCodexScheduledAutomations(
      [
        automation({ id: "future", nextRunAt: 300 }),
        automation({ id: "second", nextRunAt: 200 }),
        automation({ id: "paused", status: "PAUSED", nextRunAt: 100 }),
        automation({ id: "first", nextRunAt: 100 }),
      ],
      250,
      2,
    );

    expect(due.length).toBe(2);
    expect(due[0]?.id).toBe("first");
    expect(due[1]?.id).toBe("second");
  });
});
