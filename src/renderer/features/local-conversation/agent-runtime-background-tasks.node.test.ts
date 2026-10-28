import { describe, expect, it, vi } from "vite-plus/test";
import type { AgentRuntimeSessionActivity } from "../../../shared/agent-runtime-api";
import {
  BACKGROUND_STOP_SETTLE_MS,
  createAgentRuntimeBackgroundTasks,
  projectAgentRuntimeBackgroundTasks,
  requestAgentRuntimeBackgroundStop,
} from "./agent-runtime-background-tasks";
import { createAgentRuntimeDelegatedTaskStore } from "./agent-runtime-delegated-tasks";

type ActivityTask = AgentRuntimeSessionActivity["backgroundTasks"][number];

const activityTask = (taskId: string, overrides: Partial<ActivityTask> = {}): ActivityTask => ({
  threadId: "root",
  threadTitle: null,
  taskId,
  kind: "command",
  description: null,
  command: null,
  startedAt: null,
  ...overrides,
});

const transport = () => ({
  stopBackground: vi.fn(async (input: { taskIds: readonly string[] }) => ({
    stopping: [...input.taskIds],
  })),
  backgroundOutput: vi.fn(async () => ({ text: "ready", truncated: false, totalBytes: 5 })),
});

describe("Agent Runtime background tasks", () => {
  it("names each task by what the Agent called it, then its command, then its kind", () => {
    expect(
      projectAgentRuntimeBackgroundTasks(
        [
          activityTask("shell", {
            description: "Serve docs preview",
            command: "pnpm docs:dev --port 4321",
            startedAt: "2026-10-28T10:00:00.000Z",
          }),
          activityTask("watch", { kind: "monitor", command: "gh run watch 42" }),
          activityTask("child", {
            kind: "background_task",
            threadId: "child",
            threadTitle: "Audit auth",
          }),
        ],
        (taskId) => taskId === "watch",
      ),
    ).toEqual([
      {
        id: "shell",
        kind: "command",
        label: "Serve docs preview",
        command: "pnpm docs:dev --port 4321",
        owner: null,
        startedAtMs: Date.parse("2026-10-28T10:00:00.000Z"),
        stopping: false,
      },
      {
        id: "watch",
        kind: "monitor",
        label: "gh run watch 42",
        command: "gh run watch 42",
        owner: null,
        startedAtMs: null,
        stopping: true,
      },
      {
        id: "child",
        kind: "task",
        label: "Background task",
        command: null,
        owner: "Audit auth",
        startedAtMs: null,
        stopping: false,
      },
    ]);
  });

  it("stops and reads each task through the conversation that owns it", async () => {
    const wire = transport();
    const store = createAgentRuntimeDelegatedTaskStore();
    const activity = [
      activityTask("one"),
      activityTask("two"),
      activityTask("three", { threadId: "child", threadTitle: "Audit auth" }),
    ];
    const background = createAgentRuntimeBackgroundTasks(
      "session",
      activity,
      projectAgentRuntimeBackgroundTasks(activity, (taskId) => taskId === "two"),
      wire,
      store,
    );
    await expect(background.readOutput!("three")).resolves.toEqual({
      text: "ready",
      truncated: false,
    });
    expect(wire.backgroundOutput).toHaveBeenCalledWith({
      sessionId: "session",
      threadId: "child",
      taskId: "three",
    });
    // Stop all asks each conversation to end the tasks it shows, skipping one already stopping.
    await background.stop();
    expect(wire.stopBackground.mock.calls.map(([input]) => input)).toEqual([
      expect.objectContaining({ sessionId: "session", threadId: "root", taskIds: ["one"] }),
      expect.objectContaining({ sessionId: "session", threadId: "child", taskIds: ["three"] }),
    ]);
  });
});

describe("Stopping background tasks", () => {
  it("marks the task until the Agent ends it, then lets a lingering one be stopped again", async () => {
    vi.useFakeTimers();
    try {
      const wire = transport();
      const store = createAgentRuntimeDelegatedTaskStore();
      const task = activityTask("one", { threadId: "thread" });
      await requestAgentRuntimeBackgroundStop("session", [task], wire, store);
      expect(wire.stopBackground).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: "session", threadId: "thread", taskIds: ["one"] }),
      );
      expect(store.isStopping("session", "one")).toBe(true);
      // A second Stop while the first is unsettled sends nothing.
      await requestAgentRuntimeBackgroundStop("session", [task], wire, store);
      expect(wire.stopBackground).toHaveBeenCalledOnce();
      vi.advanceTimersByTime(BACKGROUND_STOP_SETTLE_MS);
      expect(store.isStopping("session", "one")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases every task of a request the Runtime refused", async () => {
    const wire = transport();
    wire.stopBackground.mockRejectedValueOnce(new Error("Agent execution is unavailable"));
    const store = createAgentRuntimeDelegatedTaskStore();
    await expect(
      requestAgentRuntimeBackgroundStop(
        "session",
        [activityTask("one"), activityTask("two")],
        wire,
        store,
      ),
    ).rejects.toThrow("Agent execution is unavailable");
    expect(store.isStopping("session", "one")).toBe(false);
    expect(store.isStopping("session", "two")).toBe(false);
  });
});
