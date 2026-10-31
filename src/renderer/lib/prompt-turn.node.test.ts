import { describe, expect, it, vi } from "vite-plus/test";
import type { AgentRuntimeSessionEvent } from "../../shared/agent-runtime-api";
import type { PromptTurnEntry } from "../../shared/prompt-turn";
import { createPromptTurnStore } from "./prompt-turn";

const settle = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};
function harness() {
  let listener: (event: AgentRuntimeSessionEvent) => void = () => {};
  let entries: readonly PromptTurnEntry[] = [];
  const release = vi.fn();
  const source = {
    read: vi.fn(
      async ({
        messageIds,
      }: {
        messageIds: readonly string[];
      }): Promise<readonly PromptTurnEntry[]> =>
        entries.filter((entry) => messageIds.includes(entry.messageId)),
    ),
    subscribe: vi.fn(async (_session: string, next: typeof listener) => {
      listener = next;
      return release;
    }),
  };
  return {
    source,
    release,
    store: createPromptTurnStore(source),
    set: (next: typeof entries) => {
      entries = next;
    },
    reset: () =>
      listener({
        type: "reset-required",
        sessionId: "chat",
        threadId: "root",
        reason: "runtime-restarted",
      }),
  };
}
describe("Prompt Turn store", () => {
  it("shares a chat subscription, batches reads, and releases the last observer", async () => {
    const h = harness();
    h.set([
      { messageId: "first", phase: "done", reply: "Answer", runId: "old" },
      { messageId: "second", phase: "working", reply: null, runId: "new" },
    ]);
    const first = { sessionId: "chat", messageId: "first" };
    const second = { sessionId: "chat", messageId: "second" };
    const stopA = h.store.subscribe(first, vi.fn());
    const stopB = h.store.subscribe(first, vi.fn());
    const stopC = h.store.subscribe(second, vi.fn());
    await settle();
    expect(h.source.subscribe).toHaveBeenCalledTimes(1);
    expect(h.source.read.mock.calls[0]?.[0].messageIds).toEqual(["first", "second"]);
    expect(h.store.read(first)).toMatchObject({ phase: "done", reply: "Answer" });
    expect(h.store.read(second).phase).toBe("working");
    stopA();
    stopB();
    expect(h.release).not.toHaveBeenCalled();
    stopC();
    expect(h.release).toHaveBeenCalledOnce();
  });
  it("bounds batches and acquires nothing for a missing message anchor", async () => {
    const h = harness();
    const stops = Array.from({ length: 205 }, (_, index) =>
      h.store.subscribe({ sessionId: "chat", messageId: `m${index}` }, () => {}),
    );
    h.store.subscribe({ sessionId: "legacy", messageId: "" }, () => {})();
    await settle();
    expect(h.source.read.mock.calls.map(([input]) => input.messageIds.length)).toEqual([
      100, 100, 5,
    ]);
    expect(h.source.subscribe).toHaveBeenCalledTimes(1);
    stops.forEach((stop) => stop());
  });
  it("discards stale responses after release and repairs reset events", async () => {
    const h = harness();
    let resolve!: (entries: readonly PromptTurnEntry[]) => void;
    h.source.read.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const target = { sessionId: "chat", messageId: "first" };
    const stop = h.store.subscribe(target, () => {});
    await settle();
    h.reset();
    h.set([{ messageId: "first", phase: "waiting", reply: null, runId: "run" }]);
    resolve([{ messageId: "first", phase: "working", reply: null, runId: "run" }]);
    await settle();
    expect(h.store.read(target).phase).toBe("waiting");
    stop();
    expect(h.store.read(target).phase).toBe("unknown");
  });
});
