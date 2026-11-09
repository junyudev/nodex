import { describe, expect, test } from "vite-plus/test";
import type { Automation } from "@/lib/types";
import { applyOptimisticAutomationUpdate, buildAutomationStatusUpdate } from "./automation-cache";

const task: Automation = {
  id: "task",
  automationRevision: 3,
  scope: { kind: "space" },
  ownerMemberId: "member-owner",
  conditionText: "Every day",
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
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
  rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0",
  model: "gpt-6.1-sol",
  reasoningEffort: "high",
  serviceTier: null,
  backendBinding: { kind: "codex" },
  cwds: ["/repo"],
  executionEnvironment: "worktree",
  localEnvironmentConfigPath: null,
  nextRunAt: 1,
  lastRunAt: null,
  createdAt: 0,
  updatedAt: 0,
};

describe("automation status updates", () => {
  test("pausing restates the whole task, so it keeps its runbook and mode", () => {
    const update = buildAutomationStatusUpdate(task, "PAUSED");
    expect(update).toMatchObject({ mode: "ask_first", runbookPageId: "page:runbook" });
    expect(applyOptimisticAutomationUpdate([task], update)?.[0]).toMatchObject({
      status: "PAUSED",
      mode: "ask_first",
      runbookPageId: "page:runbook",
    });
  });
});
