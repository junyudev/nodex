import { describe, expect, it } from "vite-plus/test";
import type {
  AgentSubagentOverview,
  AgentSubagentOverviewItem,
} from "@nodex/agent-runtime/contracts";
import {
  appendAgentRuntimeOverviewPage,
  projectAgentRuntimeSubagent,
  projectAgentRuntimeSubagentOverview,
} from "./agent-runtime-subagent-overview";

const task: AgentSubagentOverviewItem = {
  id: "task",
  threadId: "root",
  runId: "parent-run",
  parentNodeId: "node",
  origin: "app_owned",
  driver: "codex",
  providerInstanceId: "codex",
  providerThreadId: null,
  childThreadId: "child",
  childRunId: "child-run",
  title: "Review",
  model: "model",
  status: "running",
  startedAt: "2026-10-13T20:00:00Z",
  completedAt: null,
  updatedAt: "2026-10-13T20:00:05Z",
  resultAvailable: false,
};
const page = (items: readonly AgentSubagentOverviewItem[], nextCursor: string | null = null) => ({
  items,
  nextCursor,
  hasMore: nextCursor !== null,
});

describe("Runtime subagent overview", () => {
  it("opens app-owned children while native observation IDs cannot acquire Thread controls", () => {
    expect(projectAgentRuntimeSubagent(task)).toMatchObject({
      threadId: "child",
      parentThreadId: "root",
      canOpen: true,
      canInteract: true,
    });
    expect(
      projectAgentRuntimeSubagent({ ...task, origin: "provider_native", childThreadId: null }),
    ).toMatchObject({ threadId: "task", canOpen: false, canInteract: false });
    expect(projectAgentRuntimeSubagent({ ...task, origin: "provider_native" })).toMatchObject({
      threadId: "child",
      canOpen: true,
      canInteract: false,
    });
  });
  it("reports an incomplete window without inventing a total or retaining task bodies", () => {
    const view = projectAgentRuntimeSubagentOverview("root", {
      active: page([task], "after-task"),
      terminal: page([]),
    });
    expect(view).toMatchObject({
      completeness: "incomplete",
      active: { knownCount: 1, totalCount: null, continuation: "after-task" },
    });
    expect(view.active.rows[0]).toMatchObject({ objective: null, status: "active" });
  });
  it("deduplicates explicit page receipts and preserves the other section", () => {
    const previous: AgentSubagentOverview = {
      active: page([task], "after-task"),
      terminal: page([{ ...task, id: "done", childThreadId: "done-child", status: "completed" }]),
    };
    const next: AgentSubagentOverview = {
      active: page([task, { ...task, id: "next", childThreadId: "next-child" }]),
      terminal: page([]),
    };
    const merged = appendAgentRuntimeOverviewPage(previous, next, "active");
    expect(merged.active.items.map((item) => item.id)).toEqual(["task", "next"]);
    expect(merged.terminal).toBe(previous.terminal);
    expect(previous.active.items).toEqual([task]);
  });
});
