import { expect, test, vi } from "vite-plus/test";
import type { ThreadStatus, Turn } from "@nodex/codex-app-server-protocol/v2";
import { ThreadPollCache } from "./codex-thread-poll";
import { waitForThreads, type ThreadWaitClient, type ThreadWaitManager } from "./codex-thread-wait";
const turn: Turn = { id: "turn", status: "completed", error: null, itemsView: "full", items: [], startedAt: 1, completedAt: 2, durationMs: 1000 };
function fixture() {
  const listeners = new Map<string, Parameters<ThreadWaitManager["subscribe"]>[1]>();
  const status = new Map<string, ThreadStatus>();
  const manager: ThreadWaitManager = { hostId: "local", read: async (id) => { if (id === "missing") throw new Error("missing thread"); return { status: status.get(id) ?? { type: "active", activeFlags: [] }, latestTurn: turn }; }, subscribe: (id, callback) => { listeners.set(id, callback); return () => { listeners.delete(id); }; } };
  const client: ThreadWaitClient = { cache: new ThreadPollCache(), resolve: async () => manager, watchManager: () => () => {}, now: Date.now, schedule: (callback, delay) => { const timer = setTimeout(callback, delay); return () => clearTimeout(timer); }, interval: (callback, delay) => { const timer = setInterval(callback, delay); return () => clearInterval(timer); } };
  return { client, listeners, status };
}
test("completion wakes group, reports earlier errors and releases other subscriptions", async () => {
  const { client, listeners } = fixture();
  const waiting = waitForThreads(client, ["missing", "a", "b"].map((threadId) => ({ threadId, hostId: "local" })), 120000, new AbortController().signal);
  await vi.waitFor(() => expect(listeners.size).toBe(2));
  listeners.get("b")!({ type: "completed", turn });
  const result = await waiting;
  expect(result.wake).toEqual({ reason: "turnCompleted", turnId: "turn", threadId: "b", hostId: "local" });
  expect(result.errors).toEqual([{ threadId: "missing", hostId: "local", message: "missing thread" }]);
  await vi.waitFor(() => expect(listeners.size).toBe(0));
});
test("unchanged completed target returns without wake and does not repeat text", async () => {
  const { client, status } = fixture(); status.set("a", { type: "idle" });
  const target = { threadId: "a", hostId: "local" };
  const first = await waitForThreads(client, [target], 0, new AbortController().signal);
  const repeated = await waitForThreads(client, [{ ...target, afterCursor: first.polls[0]!.cursor }], 120000, new AbortController().signal);
  expect(repeated.wake).toBeNull(); expect(repeated.timedOut).toBe(false); expect(repeated.polls[0]?.changed).toBe(false);
});
test("caller cancellation releases listeners without waiting for timeout", async () => {
  const { client, listeners } = fixture(); const controller = new AbortController();
  const waiting = waitForThreads(client, [{ threadId: "a", hostId: "local" }], 120000, controller.signal);
  const rejected = expect(waiting).rejects.toThrow();
  await vi.waitFor(() => expect(listeners.size).toBe(1)); controller.abort(); await rejected;
  await vi.waitFor(() => expect(listeners.size).toBe(0));
});
