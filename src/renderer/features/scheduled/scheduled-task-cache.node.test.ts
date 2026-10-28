import { describe, expect, test } from "vite-plus/test";
import type { CodexScheduledAutomation } from "@/lib/types";
import {
  applyOptimisticScheduledTaskUpdate,
  buildScheduledTaskStatusUpdate,
} from "./scheduled-task-cache";

const task: CodexScheduledAutomation = {
  id: "task",
  definitionRevision: 3,
  kind: "cron",
  status: "ACTIVE",
  projectId: "project",
  targetSessionId: null,
  notificationPolicy: null,
  launch: "ask",
  runbookPageId: "page:runbook",
  runbookTitle: null,
  heldFiring: null,
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

describe("scheduled task status updates", () => {
  test("pausing restates the whole task, so it keeps its runbook and launch", () => {
    const update = buildScheduledTaskStatusUpdate(task, "PAUSED");
    expect(update).toMatchObject({ launch: "ask", runbookPageId: "page:runbook" });
    expect(applyOptimisticScheduledTaskUpdate([task], update)?.[0]).toMatchObject({
      status: "PAUSED",
      launch: "ask",
      runbookPageId: "page:runbook",
    });
  });
});
