import { describe, expect, test } from "vite-plus/test";
import type { Automation, AutomationInboxItem } from "@/lib/types";
import {
  applyOptimisticAutomationUpdate,
  applyOptimisticRunsRead,
  buildAutomationStatusUpdate,
} from "./automation-cache";

const task: Automation = {
  id: "task",
  automationRevision: 3,
  scope: { kind: "space" },
  ownerMemberId: "member-owner",
  conditionText: "Every day",
  trigger: {
    kind: "clock",
    rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    nextRunAt: 1,
  },
  kind: "cron",
  status: "ACTIVE",
  projectId: "project",
  targetSessionId: null,
  notificationPolicy: null,
  mode: "ask_first",
  runbookPageId: "page:runbook",
  runbookTitle: null,
  heldDecision: null,
  name: "Bump dependency versions",
  prompt: "Follow the runbook.",
  model: "gpt-6.1-sol",
  reasoningEffort: "high",
  serviceTier: null,
  backendBinding: { driver: "codex", instanceId: "codex" },
  cwds: ["/repo"],
  executionEnvironment: "worktree",
  localEnvironmentConfigPath: null,
  lastRunAt: null,
  createdAt: 0,
  updatedAt: 0,
};

describe("automation status updates", () => {
  test("pausing a clock task preserves its schedule and clears the optimistic next run", () => {
    const update = buildAutomationStatusUpdate(task, "PAUSED");
    expect(update).toMatchObject({ mode: "ask_first", runbookPageId: "page:runbook" });
    expect(update.trigger).toStrictEqual({
      kind: "clock",
      rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0",
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    expect(applyOptimisticAutomationUpdate([task], update)?.[0]).toMatchObject({
      status: "PAUSED",
      trigger: { kind: "clock", nextRunAt: null },
      mode: "ask_first",
      runbookPageId: "page:runbook",
    });
  });

  test("pausing an event task sends and retains its event filter", () => {
    const trigger = {
      kind: "event",
      filter: {
        sourceId: "source:github",
        repositories: ["team/repo"],
        events: ["check_failed"],
        labels: ["ci"],
        actorClass: "any",
      },
    } satisfies Automation["trigger"];
    const eventTask: Automation = { ...task, trigger };

    const update = buildAutomationStatusUpdate(eventTask, "PAUSED");

    expect(update.trigger).toEqual(trigger);
    expect(applyOptimisticAutomationUpdate([eventTask], update)?.[0]).toMatchObject({
      status: "PAUSED",
      trigger,
    });
  });
});

test("marking runs read clears them from the unread counts and leaves other runs unread", () => {
  const item = (runId: string, automationId: string): AutomationInboxItem => ({
    id: runId,
    automationId,
    automationName: null,
    title: null,
    description: null,
    archivedAssistantMessage: null,
    archivedUserMessage: null,
    archivedReason: null,
    sourceCwd: null,
    runId,
    sessionId: "chat",
    quiet: false,
    readAt: null,
    createdAt: 1,
    status: "PENDING_REVIEW",
  });
  const items = [item("beat-1", "heartbeat"), item("beat-2", "heartbeat"), item("run", "cron")];
  const unreadRuns = items.map(({ automationId, runId }) => ({ automationId, runId }));

  const next = applyOptimisticRunsRead(
    { items, unreadRunCounts: { total: 3, automationIds: ["heartbeat", "cron"], unreadRuns } },
    ["beat-1", "beat-2"],
    42,
  );

  expect(next?.items.map((entry) => entry.readAt)).toEqual([42, 42, null]);
  expect(next?.unreadRunCounts).toEqual({
    total: 1,
    automationIds: ["cron"],
    unreadRuns: [{ automationId: "cron", runId: "run" }],
  });
});
