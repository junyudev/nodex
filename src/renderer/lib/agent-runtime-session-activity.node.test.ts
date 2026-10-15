import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentRuntimeConnectionState,
  AgentRuntimeSessionActivity,
  AgentRuntimeSessionActivityChange,
  AgentRuntimeSessionActivitySnapshot,
} from "../../shared/agent-runtime-api";
import { createAgentRuntimeActivityStore } from "./agent-runtime-session-activity";

const activity = (
  sessionId: string,
  status: AgentRuntimeSessionActivity["status"] = "running",
): AgentRuntimeSessionActivity => ({
  sessionId,
  threadId: `thread:${sessionId}`,
  status,
  activeRunId: status === "running" ? `run:${sessionId}` : null,
  pendingRequestCount: status === "waiting" ? 1 : 0,
  activeTaskCount: status === "background" ? 1 : 0,
  resumesAutomatically: status === "background",
  providerInstanceId: "codex",
  model: "gpt-5.5",
  updatedAt: "2026-10-15T00:00:00.000Z",
});

function fakeSource() {
  const reads: Array<(snapshot: AgentRuntimeSessionActivitySnapshot) => void> = [];
  const changeListeners = new Set<(change: AgentRuntimeSessionActivityChange) => void>();
  const connectionListeners = new Set<(state: AgentRuntimeConnectionState) => void>();
  return {
    reads,
    changeListeners,
    push: (change: AgentRuntimeSessionActivityChange) => {
      for (const listener of changeListeners) listener(change);
    },
    pushConnection: (state: AgentRuntimeConnectionState) => {
      for (const listener of connectionListeners) listener(state);
    },
    source: {
      read: () =>
        new Promise<AgentRuntimeSessionActivitySnapshot>((resolve) => {
          reads.push(resolve);
        }),
      subscribe: (listener: (change: AgentRuntimeSessionActivityChange) => void) => {
        changeListeners.add(listener);
        return () => changeListeners.delete(listener);
      },
      readConnection: async (): Promise<AgentRuntimeConnectionState> => ({ status: "idle" }),
      subscribeConnection: (listener: (state: AgentRuntimeConnectionState) => void) => {
        connectionListeners.add(listener);
        return () => connectionListeners.delete(listener);
      },
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.useRealTimers();
});

describe("Agent Runtime Session activity store", () => {
  it("applies changes that race the initial snapshot in sequence order", async () => {
    const fake = fakeSource();
    const store = createAgentRuntimeActivityStore(fake.source);
    const release = store.subscribeAll(() => {});
    // Pushed before the snapshot answers: one is already covered by it, one is newer.
    fake.push({ type: "upsert", sequence: 4, activity: activity("a", "waiting") });
    fake.push({ type: "remove", sequence: 6, sessionId: "b" });
    fake.reads[0]!({
      sequence: 5,
      items: [activity("a"), activity("b")],
      complete: true,
    });
    await settle();
    expect(store.read("a")?.status).toBe("running");
    expect(store.read("b")).toBeNull();
    release();
  });

  it("notifies only the Session whose activity changed", async () => {
    const fake = fakeSource();
    const store = createAgentRuntimeActivityStore(fake.source);
    const a = vi.fn();
    const b = vi.fn();
    const releaseA = store.subscribeSession("a", a);
    const releaseB = store.subscribeSession("b", b);
    fake.reads[0]!({ sequence: 1, items: [activity("a")], complete: true });
    await settle();
    a.mockClear();
    b.mockClear();
    fake.push({ type: "upsert", sequence: 2, activity: activity("a", "background") });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
    expect(store.read("a")?.status).toBe("background");
    releaseA();
    releaseB();
  });

  it("re-reads after a reset and after the Runtime becomes ready again", async () => {
    const fake = fakeSource();
    const store = createAgentRuntimeActivityStore(fake.source);
    const release = store.subscribeAll(() => {});
    fake.reads[0]!({ sequence: 1, items: [activity("a")], complete: true });
    await settle();
    fake.push({ type: "reset", sequence: 2 });
    expect(fake.reads).toHaveLength(2);
    fake.reads[1]!({ sequence: 3, items: [], complete: true });
    await settle();
    expect(store.read("a")).toBeNull();
    fake.pushConnection({ status: "restarting", attempt: 1 });
    fake.pushConnection({ status: "ready", generation: "g2" });
    expect(fake.reads).toHaveLength(3);
    expect(store.readConnection()).toEqual({ status: "ready", generation: "g2" });
    release();
  });

  it("detaches from Main shortly after the last observer leaves", async () => {
    vi.useFakeTimers();
    const fake = fakeSource();
    const store = createAgentRuntimeActivityStore(fake.source);
    const release = store.subscribeSession("a", () => {});
    expect(fake.changeListeners.size).toBe(1);
    release();
    // A quick remount keeps the same attachment.
    const again = store.subscribeSession("a", () => {});
    vi.advanceTimersByTime(5_000);
    expect(fake.changeListeners.size).toBe(1);
    again();
    vi.advanceTimersByTime(5_000);
    expect(fake.changeListeners.size).toBe(0);
    expect(fake.reads).toHaveLength(1);
  });
});
