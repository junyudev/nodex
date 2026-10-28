import { describe, expect, test } from "vite-plus/test";
import { act } from "react";
import type { AgentRuntimeSessionActivity } from "../../shared/agent-runtime-api";
import { render } from "@/test/dom";
import type { AgentRuntimeActivityStore } from "./agent-runtime-session-activity";
import { useSessionRowStatus } from "./use-session-execution";

function makeActivityStore() {
  let status: AgentRuntimeSessionActivity["status"] | null = null;
  const listeners = new Set<() => void>();
  const store: AgentRuntimeActivityStore = {
    read: (sessionId) =>
      status
        ? {
            sessionId,
            threadId: "root-1",
            status,
            activeRunId: null,
            pendingRequestCount: 0,
            backgroundTasks: [],
            providerInstanceId: "claude",
            model: "claude-sonnet",
            updatedAt: "2026-10-28T00:00:00.000Z",
          }
        : null,
    readAll: () => new Map(),
    readConnection: () => ({ status: "idle" }),
    subscribeSession: (_sessionId, listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeAll: () => () => {},
    subscribeConnection: () => () => {},
  };
  const setStatus = async (next: AgentRuntimeSessionActivity["status"] | null) => {
    status = next;
    await act(async () => {
      for (const listener of listeners) listener();
      await Promise.resolve();
    });
  };
  return { store, setStatus };
}

type StatusSession = Parameters<typeof useSessionRowStatus>[0];

function renderStatus(session: StatusSession, store: AgentRuntimeActivityStore) {
  function Probe({ value }: { value: StatusSession }) {
    return <output>{useSessionRowStatus(value, store) ?? "none"}</output>;
  }
  const view = render(<Probe value={session} />);
  return {
    status: () => view.container.querySelector("output")?.textContent,
    rerender: (next: StatusSession) => view.rerender(<Probe value={next} />),
  };
}

const runtimeSession = {
  id: "session-1",
  executionRef: { runtimeId: "claude", threadId: "root-1" },
  thread: null,
  unread: false,
};

describe("useSessionRowStatus", () => {
  test("a Runtime Session shows its activity, then unread news once it settles", async () => {
    const { store, setStatus } = makeActivityStore();
    const { status, rerender } = renderStatus(runtimeSession, store);
    expect(status()).toBe("none");

    await setStatus("running");
    expect(status()).toBe("running");
    await setStatus("waiting");
    expect(status()).toBe("attention");
    await setStatus("background");
    expect(status()).toBe("background");

    await setStatus(null);
    rerender({ ...runtimeSession, unread: true });
    expect(status()).toBe("unread");
  });

  test("a native Session runs while its thread is active, and none is shown without one", () => {
    const { store } = makeActivityStore();
    const native = {
      id: "session-2",
      executionRef: null,
      thread: { statusType: "active" },
      unread: false,
    } as unknown as StatusSession;
    const { status, rerender } = renderStatus(native, store);
    expect(status()).toBe("running");
    rerender(null);
    expect(status()).toBe("none");
  });
});
