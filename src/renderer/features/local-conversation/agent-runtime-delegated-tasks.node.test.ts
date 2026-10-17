import { describe, expect, it, vi } from "vite-plus/test";
import type { AgentSubagentOverviewItem } from "@nodex/agent-runtime/contracts";
import {
  createAgentRuntimeDelegatedTaskStore,
  requestAgentRuntimeTaskStop,
  stopAgentRuntimeBackgroundTasks,
} from "./agent-runtime-delegated-tasks";
import {
  agentRuntimeBackgroundStatus,
  agentRuntimeConnectionStatus,
} from "./agent-runtime-composer-status";

const item = (id: string, childThreadId: string | null): AgentSubagentOverviewItem => ({
  id,
  threadId: "root",
  runId: "parent-run",
  parentNodeId: "node",
  origin: childThreadId ? "app_owned" : "provider_native",
  driver: "codex",
  providerInstanceId: "codex",
  providerThreadId: null,
  childThreadId,
  childRunId: null,
  title: id,
  model: "model",
  status: "running",
  startedAt: null,
  completedAt: null,
  updatedAt: "2026-10-15T00:00:00Z",
  resultAvailable: false,
});

function transport() {
  return {
    overview: vi
      .fn()
      .mockResolvedValueOnce({
        active: {
          items: [item("one", "child-one")],
          nextCursor: "after-one",
          hasMore: true,
          totalCount: 2,
        },
        terminal: { items: [], nextCursor: null, hasMore: false, totalCount: 0 },
      })
      .mockResolvedValueOnce({
        active: { items: [item("native", null)], nextCursor: null, hasMore: false, totalCount: 1 },
        terminal: { items: [], nextCursor: null, hasMore: false, totalCount: 0 },
      }),
    inspect: vi.fn(async () => ({
      sessionId: "session",
      projectId: null,
      runtimeId: "runtime",
      rootThreadId: "root",
      threadId: "child-one",
      thread: { activeRunId: "child-run" } as never,
    })),
    stop: vi.fn(async () => ({ stopped: true })),
    stopTask: vi.fn(async () => ({ sequence: 1 })),
  };
}

describe("Stopping background subagents", () => {
  it("stops every live subagent through its own owner, reading metadata pages only", async () => {
    const wire = transport();
    const store = createAgentRuntimeDelegatedTaskStore();
    await stopAgentRuntimeBackgroundTasks("session", "root", wire, store);
    expect(wire.overview.mock.calls.map(([input]) => input)).toEqual([
      { sessionId: "session", threadId: "root" },
      { sessionId: "session", threadId: "root", activeCursor: "after-one" },
    ]);
    expect(wire.stop).toHaveBeenCalledWith({
      sessionId: "session",
      threadId: "child-one",
      runId: "child-run",
    });
    expect(wire.stopTask).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "root", runId: "parent-run", taskId: "native" }),
    );
    // Both stay marked until their own status reports how they ended.
    expect(store.isStopping("session", "one")).toBe(true);
    expect(store.isStopping("session", "native")).toBe(true);
  });

  it("reports the subagents it could not stop and releases their marks", async () => {
    const wire = transport();
    wire.inspect.mockResolvedValueOnce({
      ...(await wire.inspect()),
      thread: { activeRunId: null } as never,
    });
    const store = createAgentRuntimeDelegatedTaskStore();
    await expect(stopAgentRuntimeBackgroundTasks("session", "root", wire, store)).rejects.toThrow(
      "Could not stop 1 of 2 background tasks: This subagent has no running turn to stop",
    );
    expect(store.isStopping("session", "one")).toBe(false);
    expect(store.isStopping("session", "native")).toBe(true);
  });

  it("a repeated Stop does not issue a second request while the first is unsettled", async () => {
    const wire = transport();
    const store = createAgentRuntimeDelegatedTaskStore();
    const task = {
      taskId: "native",
      parentThreadId: "root",
      ownerRunId: "run",
      childThreadId: null,
    };
    await requestAgentRuntimeTaskStop("session", task, wire, store);
    await requestAgentRuntimeTaskStop("session", task, wire, store);
    expect(wire.stopTask).toHaveBeenCalledOnce();
    store.settle("session", "native");
    await requestAgentRuntimeTaskStop("session", task, wire, store);
    expect(wire.stopTask).toHaveBeenCalledTimes(2);
  });
});

describe("Runtime composer status", () => {
  it("explains a chat waiting on background work and whether it resumes on its own", () => {
    expect(
      agentRuntimeBackgroundStatus({
        status: "background",
        activeTaskCount: 2,
        resumesAutomatically: true,
      }),
    ).toBe("Waiting for 2 background tasks · resumes automatically");
    expect(
      agentRuntimeBackgroundStatus({
        status: "background",
        activeTaskCount: 1,
        resumesAutomatically: false,
      }),
    ).toBe("Waiting for 1 background task");
    expect(
      agentRuntimeBackgroundStatus({
        status: "background",
        activeTaskCount: 0,
        resumesAutomatically: true,
      }),
    ).toBe("Resumes automatically when background results arrive");
    expect(
      agentRuntimeBackgroundStatus({
        status: "running",
        activeTaskCount: 2,
        resumesAutomatically: true,
      }),
    ).toBeNull();
    expect(agentRuntimeBackgroundStatus(null)).toBeNull();
  });

  it("shows execution availability only while it is not ready", () => {
    expect(agentRuntimeConnectionStatus({ status: "ready", generation: "g" })).toBeNull();
    expect(agentRuntimeConnectionStatus({ status: "idle" })).toBeNull();
    expect(agentRuntimeConnectionStatus({ status: "restarting", attempt: 1 })).toMatchObject({
      tone: "neutral",
    });
    expect(agentRuntimeConnectionStatus({ status: "failed", message: "Crashed" })).toEqual({
      message: "Agent execution is unavailable: Crashed",
      tone: "danger",
    });
  });
});
