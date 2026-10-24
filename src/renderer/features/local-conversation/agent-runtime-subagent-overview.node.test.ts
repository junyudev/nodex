import { describe, expect, it } from "vite-plus/test";
import type {
  AgentSubagentOverview,
  AgentSubagentOverviewItem,
} from "@nodex/agent-runtime/contracts";
import {
  agentRuntimeOverviewSectionsToRefill,
  agentRuntimeOverviewWindow,
  appendAgentRuntimeOverviewPage,
  agentRuntimeOverviewTotalsUnknown,
  applyAgentRuntimeOverviewTask,
  projectAgentRuntimeSubagent,
  projectAgentRuntimeSubagentOverview,
  type AgentRuntimeTaskRecord,
  withAgentRuntimeOverviewTotals,
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
const page = (
  items: readonly AgentSubagentOverviewItem[],
  nextCursor: string | null = null,
  totalCount = items.length,
) => ({
  items,
  nextCursor,
  hasMore: nextCursor !== null,
  totalCount,
});

describe("Runtime subagent overview", () => {
  it("assigns identity only when a durable child exists and retains it across metadata changes", () => {
    const pending = { ...task, childThreadId: null };
    expect(projectAgentRuntimeSubagent(pending)).toMatchObject({
      threadId: "task",
      identityThreadId: null,
      canOpen: false,
    });
    const child = projectAgentRuntimeSubagent(task);
    const updated = projectAgentRuntimeSubagent({
      ...task,
      title: "Updated review",
      model: "another-model",
      status: "completed",
    });
    expect(child.identityThreadId).toBe("child");
    expect(updated.identityThreadId).toBe(child.identityThreadId);
    expect(updated).toMatchObject({
      threadId: "child",
      displayName: "Updated review",
      status: "done",
    });
  });

  it("opens native paths under their readable name and preserves explicit task titles", () => {
    const native = { ...task, origin: "provider_native" as const, title: "/root/ui_audit" };
    expect(projectAgentRuntimeSubagent(native)).toMatchObject({
      threadId: "child",
      displayName: "Ui audit",
      actorName: "Ui audit",
    });
    expect(projectAgentRuntimeSubagent({ ...native, origin: "app_owned" })).toMatchObject({
      displayName: "/root/ui_audit",
    });
    expect(native.title).toBe("/root/ui_audit");
  });

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
  it("counts every task in a partly loaded section without retaining task bodies", () => {
    const view = projectAgentRuntimeSubagentOverview("root", {
      active: page([task], "after-task", 7),
      terminal: page([]),
    });
    expect(view).toMatchObject({
      completeness: "incomplete",
      active: { knownCount: 1, totalCount: 7, continuation: "after-task" },
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
      // A page read reports both sections' totals as of the read.
      terminal: page([], null, 1),
    };
    const merged = appendAgentRuntimeOverviewPage(previous, next, "active");
    expect(merged.active.items.map((item) => item.id)).toEqual(["task", "next"]);
    expect(merged.active).toMatchObject({ nextCursor: null, hasMore: false });
    expect(merged.terminal).toEqual(previous.terminal);
    expect(previous.active.items).toEqual([task]);
  });

  it("stops any live subagent through its real owner and never a settled one", () => {
    expect(projectAgentRuntimeSubagent(task)).toMatchObject({ canOpen: true, canStop: true });
    expect(
      projectAgentRuntimeSubagent({ ...task, origin: "provider_native", childThreadId: null }),
    ).toMatchObject({ canOpen: false, canStop: true });
    expect(
      projectAgentRuntimeSubagent({
        ...task,
        origin: "provider_native",
        childThreadId: null,
        runId: null,
      }),
    ).toMatchObject({ canStop: false });
    expect(projectAgentRuntimeSubagent({ ...task, status: "interrupted" })).toMatchObject({
      canStop: false,
      statusSummary: "Stopped",
    });
  });

  it("names the Agent and model that run each subagent", () => {
    const view = projectAgentRuntimeSubagentOverview(
      "root",
      { active: page([task]), terminal: page([]) },
      (item) => `${item.providerInstanceId} · ${item.model}`,
    );
    expect(view.active.rows[0]?.agentLabel).toBe("codex · model");
  });
});

describe("Runtime subagent overview events", () => {
  const record = (overrides: Partial<AgentRuntimeTaskRecord> = {}): AgentRuntimeTaskRecord => ({
    ...task,
    createdBy: "agent",
    nativeTaskRef: null,
    prompt: "",
    result: null,
    ...overrides,
  });

  it("moves a settled subagent to Done in place, keeping metadata only events cannot report", () => {
    const loaded: AgentSubagentOverview = {
      active: page([task]),
      terminal: page([{ ...task, id: "old", childThreadId: "old-child", status: "completed" }]),
    };
    const settled = applyAgentRuntimeOverviewTask(
      loaded,
      record({ status: "interrupted", updatedAt: "2026-10-13T20:01:00Z" }),
    );
    expect(settled.active.items).toEqual([]);
    expect(settled.terminal.items.map((item) => [item.id, item.status, item.childRunId])).toEqual([
      ["task", "interrupted", "child-run"],
      ["old", "completed", "child-run"],
    ]);
    expect([settled.active.totalCount, settled.terminal.totalCount]).toEqual([0, 2]);
  });

  it("re-reads section totals for any task that is not a loaded row", () => {
    const loaded: AgentSubagentOverview = {
      active: page([task]),
      terminal: page([{ ...task, id: "done", status: "completed" }], "after-done", 30),
    };
    const unseen = record({ id: "unseen", status: "running", updatedAt: "2026-10-13T21:00:00Z" });
    expect(agentRuntimeOverviewTotalsUnknown(loaded, unseen)).toBe(true);
    // Even with every page loaded, an unseen report may not be a new task.
    expect(
      agentRuntimeOverviewTotalsUnknown({ active: page([task]), terminal: page([]) }, unseen),
    ).toBe(true);
    expect(agentRuntimeOverviewTotalsUnknown(loaded, record())).toBe(false);
    const patched = applyAgentRuntimeOverviewTask(loaded, unseen);
    expect([patched.active.totalCount, patched.terminal.totalCount]).toEqual([1, 30]);
    const read = { active: page([], null, 2), terminal: page([], null, 29) };
    const recounted = withAgentRuntimeOverviewTotals(patched, read);
    expect([recounted.active.totalCount, recounted.terminal.totalCount]).toEqual([2, 29]);
    expect(recounted.active.items).toBe(patched.active.items);
  });

  it("ignores an older report and leaves unloaded pages to explicit paging", () => {
    const loaded: AgentSubagentOverview = {
      active: page([task], "after-task"),
      terminal: page([]),
    };
    expect(
      applyAgentRuntimeOverviewTask(
        loaded,
        record({ status: "completed", updatedAt: "2026-10-13T19:00:00Z" }),
      ),
    ).toBe(loaded);
    const older = applyAgentRuntimeOverviewTask(
      loaded,
      record({ id: "older", updatedAt: "2026-10-13T19:00:00Z" }),
    );
    expect(older.active.items.map((item) => item.id)).toEqual(["task"]);
    const newer = applyAgentRuntimeOverviewTask(
      loaded,
      record({ id: "newer", childThreadId: "newer-child", updatedAt: "2026-10-13T21:00:00Z" }),
    );
    expect(newer.active.items.map((item) => item.id)).toEqual(["newer", "task"]);
    expect(newer.active.nextCursor).toBe("after-task");
  });

  it("refills a partly loaded section that settling rows left short of what was shown", () => {
    const working = (id: string) => ({ ...task, id, childThreadId: `${id}-child` });
    const loaded: AgentSubagentOverview = {
      active: page([working("a"), working("b"), working("c"), working("d")], "after-d"),
      terminal: page([]),
    };
    const shown = agentRuntimeOverviewWindow({ active: 0, terminal: 0 }, loaded);
    expect(agentRuntimeOverviewSectionsToRefill(loaded, shown)).toEqual([]);
    const settled = applyAgentRuntimeOverviewTask(
      loaded,
      record({
        id: "b",
        childThreadId: "b-child",
        status: "completed",
        updatedAt: "2026-10-13T21:00:00Z",
      }),
    );
    expect(agentRuntimeOverviewSectionsToRefill(settled, shown)).toEqual(["active"]);
    // With nothing left to read, a shorter section is simply complete.
    const exhausted = {
      ...settled,
      active: { ...settled.active, nextCursor: null, hasMore: false },
    };
    expect(agentRuntimeOverviewSectionsToRefill(exhausted, shown)).toEqual([]);
  });
});
