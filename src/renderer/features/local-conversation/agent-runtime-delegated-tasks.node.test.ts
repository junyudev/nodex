import { describe, expect, it, vi } from "vite-plus/test";
import {
  createAgentRuntimeDelegatedTaskStore,
  isAgentRuntimeTaskStopping,
  requestAgentRuntimeTaskStop,
} from "./agent-runtime-delegated-tasks";

function transport() {
  return {
    cancelTask: vi.fn(async (input: { taskId: string }) => ({
      taskId: input.taskId,
      status: "cancelled",
    })),
    stopTask: vi.fn(async () => ({ sequence: 1 })),
  };
}

describe("Stopping delegated tasks", () => {
  it("cancels an application-owned task through its parent, the way its Agent would", async () => {
    const wire = transport();
    const store = createAgentRuntimeDelegatedTaskStore();
    await requestAgentRuntimeTaskStop(
      "session",
      { taskId: "task", parentThreadId: "root", ownerRunId: "run", childThreadId: "child" },
      wire,
      store,
    );
    expect(wire.cancelTask).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session", threadId: "root", taskId: "task" }),
    );
    expect(wire.stopTask).not.toHaveBeenCalled();
    // The mark stays until the task's own status reports how it ended.
    expect(isAgentRuntimeTaskStopping(store.readStopping(), "session", "task")).toBe(true);
  });

  it("stops a provider-native task through the Run that owns it", async () => {
    const wire = transport();
    await requestAgentRuntimeTaskStop(
      "session",
      { taskId: "native", parentThreadId: "root", ownerRunId: "run", childThreadId: null },
      wire,
      createAgentRuntimeDelegatedTaskStore(),
    );
    expect(wire.stopTask).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "root", runId: "run", taskId: "native" }),
    );
  });

  it("releases the mark when the request fails", async () => {
    const wire = transport();
    wire.cancelTask.mockRejectedValueOnce(new Error("Delegated task has no interruptible run"));
    const store = createAgentRuntimeDelegatedTaskStore();
    await expect(
      requestAgentRuntimeTaskStop(
        "session",
        { taskId: "task", parentThreadId: "root", ownerRunId: null, childThreadId: "child" },
        wire,
        store,
      ),
    ).rejects.toThrow("Delegated task has no interruptible run");
    expect(store.isStopping("session", "task")).toBe(false);
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
