import { expect, test, vi } from "vite-plus/test";
import { createHostSessionObservation } from "./host-session-observation";

test("hosted observation bounds targets and stops repair ticks after the final reader leaves", () => {
  vi.useFakeTimers();
  const observe = createHostSessionObservation();
  const releases: (() => void)[] = [];
  const notified = vi.fn();
  try {
    for (let i = 0; i < 8; i++)
      releases.push(observe({ sessionId: `session-${i}`, threadId: `thread-${i}` }, notified));
    expect(() => observe({ sessionId: "extra", threadId: "extra" }, notified)).toThrow(/eight/u);
    const sameTarget = vi.fn();
    releases.push(observe({ sessionId: "session-0", threadId: "thread-0" }, sameTarget));
    vi.advanceTimersByTime(15_000);
    expect(notified).toHaveBeenCalledTimes(8);
    expect(sameTarget).toHaveBeenCalledWith({
      type: "reset-required",
      sessionId: "session-0",
      threadId: "thread-0",
      reason: "host-refresh",
    });
    for (const release of releases) release();
    vi.advanceTimersByTime(10_000);
    expect(notified).toHaveBeenCalledTimes(8);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    for (const release of releases) release();
    vi.useRealTimers();
  }
});

test("coalesces targeted session invalidations before the next sparse repair", () => {
  vi.useFakeTimers();
  let invalidate:
    | ((event: import("../../shared/ipc-api").ProjectSessionsChangeEvent) => void)
    | undefined;
  const stop = vi.fn();
  const observe = createHostSessionObservation((listener) => {
    invalidate = listener;
    return stop;
  });
  const alice = vi.fn();
  const bob = vi.fn();
  const releaseAlice = observe({ sessionId: "alice", threadId: "a" }, alice);
  const releaseBob = observe({ sessionId: "bob", threadId: "b" }, bob);
  try {
    for (let i = 0; i < 20; i++)
      invalidate?.({
        changeType: "update",
        summaryScopes: [],
        detailInvalidation: { kind: "sessions", sessionIds: ["alice"] },
      });
    vi.advanceTimersByTime(1_000);
    expect(alice).toHaveBeenCalledOnce();
    expect(bob).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5_000);
    expect(alice).toHaveBeenCalledOnce();
    expect(bob).not.toHaveBeenCalled();
  } finally {
    releaseAlice();
    releaseBob();
    vi.useRealTimers();
  }
  expect(stop).toHaveBeenCalledOnce();
});
