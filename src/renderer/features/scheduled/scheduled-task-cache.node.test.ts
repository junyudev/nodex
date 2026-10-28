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
  heldFiring: null,
  name: "Bump dependency versions",
  prompt: "Bump dependency versions.",
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
  test("pausing restates the whole task, so it keeps its launch", () => {
    const update = buildScheduledTaskStatusUpdate(task, "PAUSED");
    expect(update).toMatchObject({ launch: "ask" });
    expect(applyOptimisticScheduledTaskUpdate([task], update)?.[0]).toMatchObject({
      status: "PAUSED",
      launch: "ask",
    });
  });
});
