import { describe, expect, test, vi } from "vite-plus/test";
import type {
  CodexTranscriptEvent,
  CodexTranscriptSnapshot,
  CodexTranscriptUpdate,
} from "./codex-transcript-projection";
import {
  chunkCodexTranscriptReset,
  CODEX_TRANSCRIPT_PENDING_CODE_UNITS,
  createCodexTranscriptSubscription,
} from "./codex-transcript-subscription";

function snapshot(count = 0): CodexTranscriptSnapshot {
  return {
    resumeState: "resumed",
    historyComplete: true,
    itemTimeline: null,
    timeline: null,
    turnEntityKeys: [],
    turnsByKey: {},
    realtimeItems: {},
    itemsByKey: Object.fromEntries(
      Array.from({ length: count }, (_, index) => [
        String(index),
        { type: "plan", id: String(index), text: "hello" },
      ]),
    ),
  };
}
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function change(insert: string): CodexTranscriptUpdate {
  return {
    type: "changes",
    changes: [
      {
        type: "text",
        key: { hostId: "local", threadId: "thread", entityKey: "turn", itemId: "item" },
        target: { field: "text" },
        edits: [{ at: 0, deleteCount: 0, insert }],
      },
    ],
  };
}
function source(initial: CodexTranscriptSnapshot | null) {
  let listener: ((update: CodexTranscriptUpdate) => void) | undefined;
  let current = initial;
  const unsubscribe = vi.fn(() => {
    listener = undefined;
  });
  return {
    getSnapshot: () => current,
    subscribe: (next: (update: CodexTranscriptUpdate) => void) => {
      listener = next;
      next({ type: "reset", value: current });
      return unsubscribe;
    },
    emit: (update: CodexTranscriptUpdate) => listener?.(update),
    setSnapshot: (next: CodexTranscriptSnapshot | null) => {
      current = next;
    },
    unsubscribe,
  };
}

describe("normalized transcript async delivery", () => {
  test.each([255, 256, 257])("reset %i map entries respects exact chunk threshold", (count) => {
    const original = snapshot(count);
    const events = [...chunkCodexTranscriptReset(original)];
    if (count < 256) {
      expect(events).toEqual([{ type: "reset", value: original }]);
      return;
    }
    expect(events.map((event) => event.type)).toEqual(
      count === 256
        ? ["reset-start", "reset-part", "reset-commit"]
        : ["reset-start", "reset-part", "reset-part", "reset-commit"],
    );
    const parts = events.filter((event) => event.type === "reset-part");
    expect(parts.map((part) => Object.keys(part.itemsByKey).length)).toEqual(
      count === 256 ? [256] : [256, 1],
    );
    expect(Object.assign({}, ...parts.map((part) => part.itemsByKey))).toEqual(original.itemsByKey);
  });

  test("counts combined maps and emits items before realtime entries", () => {
    const value = {
      ...snapshot(255),
      realtimeItems: {
        rt: {
          item: { type: "realtimeSessionStarted" as const, id: "rt", realtimeSessionId: "session" },
          completed: true,
        },
        rt2: {
          item: {
            type: "realtimeSessionStarted" as const,
            id: "rt2",
            realtimeSessionId: "session",
          },
          completed: true,
        },
      },
    };
    const events = [...chunkCodexTranscriptReset(value)];
    const parts = events.filter((event) => event.type === "reset-part");
    expect(parts).toHaveLength(2);
    expect(Object.keys(parts[0]!.itemsByKey)).toHaveLength(255);
    expect(Object.keys(parts[0]!.realtimeItems)).toEqual(["rt"]);
    expect(Object.keys(parts[1]!.realtimeItems)).toEqual(["rt2"]);
  });

  test("awaits each callback and merges adjacent pending changes", async () => {
    const input = source(snapshot());
    const held = deferred();
    const seen: CodexTranscriptEvent[] = [];
    const subscription = createCodexTranscriptSubscription({
      ...input,
      listener: (event) => {
        seen.push(event);
        return seen.length === 1 ? held.promise : undefined;
      },
    });
    input.emit(change("a"));
    input.emit(change("b"));
    expect(seen).toHaveLength(1);
    held.resolve();
    await vi.waitFor(() => expect(seen).toHaveLength(2));
    expect(seen[1]).toEqual({
      type: "changes",
      changes: [
        ...(change("a") as Extract<CodexTranscriptUpdate, { type: "changes" }>).changes,
        ...(change("b") as Extract<CodexTranscriptUpdate, { type: "changes" }>).changes,
      ],
    });
    subscription.dispose();
    await subscription.completion;
    expect(input.unsubscribe).toHaveBeenCalledTimes(1);
  });

  test.each([0, 1])(
    "backlog threshold +%i uses JSON code units, not UTF-8 bytes",
    async (overflow) => {
      const input = source(snapshot());
      const held = deferred();
      const seen: CodexTranscriptEvent[] = [];
      const subscription = createCodexTranscriptSubscription({
        ...input,
        listener: (event) => {
          seen.push(event);
          return seen.length === 1 ? held.promise : undefined;
        },
      });
      const overhead = JSON.stringify(change("")).length;
      const update = change("世".repeat(CODEX_TRANSCRIPT_PENDING_CODE_UNITS - overhead + overflow));
      expect(JSON.stringify(update).length).toBe(CODEX_TRANSCRIPT_PENDING_CODE_UNITS + overflow);
      expect(new TextEncoder().encode(JSON.stringify(update)).length).toBeGreaterThan(
        CODEX_TRANSCRIPT_PENDING_CODE_UNITS,
      );
      input.emit(update);
      input.setSnapshot({ ...snapshot(), historyComplete: false });
      held.resolve();
      await vi.waitFor(() => expect(seen).toHaveLength(2));
      expect(seen[1]!.type).toBe(overflow === 0 ? "changes" : "reset");
      if (overflow === 1) expect(seen[1]).toEqual({ type: "reset", value: input.getSnapshot() });
      subscription.dispose();
    },
  );

  test("new reset drops queued increments and rereads current snapshot after callback", async () => {
    const input = source(snapshot());
    const held = deferred();
    const seen: CodexTranscriptEvent[] = [];
    const subscription = createCodexTranscriptSubscription({
      ...input,
      listener: (event) => {
        seen.push(event);
        return seen.length === 1 ? held.promise : undefined;
      },
    });
    input.emit(change("discarded"));
    input.emit({ type: "reset", value: snapshot(2) });
    input.emit(change("also discarded"));
    input.setSnapshot(snapshot(3));
    held.resolve();
    await vi.waitFor(() => expect(seen).toHaveLength(2));
    expect(seen[1]).toEqual({ type: "reset", value: input.getSnapshot() });
    subscription.dispose();
  });

  test("chunked reset completes atomically before a newer fresh reset", async () => {
    const input = source(snapshot(256));
    const held = deferred();
    const seen: CodexTranscriptEvent[] = [];
    const subscription = createCodexTranscriptSubscription({
      ...input,
      listener: (event) => {
        seen.push(event);
        return seen.length === 1 ? held.promise : undefined;
      },
    });
    input.setSnapshot(snapshot(1));
    input.emit({ type: "reset", value: snapshot(1) });
    expect(seen.map((event) => event.type)).toEqual(["reset-start"]);
    held.resolve();
    await vi.waitFor(() => expect(seen).toHaveLength(4));
    expect(seen.map((event) => event.type)).toEqual([
      "reset-start",
      "reset-part",
      "reset-commit",
      "reset",
    ]);
    subscription.dispose();
  });

  test("failed increment converges via fresh reset; failed reset ends subscription", async () => {
    const input = source(snapshot());
    const seen: CodexTranscriptEvent[] = [];
    const subscription = createCodexTranscriptSubscription({
      ...input,
      listener: async (event) => {
        seen.push(event);
        if (event.type === "changes") throw new Error("increment failed");
        if (seen.length > 2) throw new Error("reset failed");
      },
    });
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    input.emit(change("a"));
    await subscription.completion;
    expect(seen.map((event) => event.type)).toEqual(["reset", "changes", "reset"]);
    expect(input.unsubscribe).toHaveBeenCalledTimes(1);
  });

  test("dispose releases pending callback and viewport exactly once", async () => {
    const input = source(null);
    const held = deferred();
    const releaseCallback = vi.fn();
    const callback = Object.assign(held.promise, { [Symbol.dispose]: releaseCallback });
    const onDispose = vi.fn();
    const listener = vi.fn(() => callback);
    const subscription = createCodexTranscriptSubscription({ ...input, listener, onDispose });
    input.emit(change("pending"));
    subscription.dispose();
    subscription[Symbol.dispose]();
    await subscription.completion;
    held.resolve();
    await Promise.resolve();
    expect(releaseCallback).toHaveBeenCalledTimes(1);
    expect(onDispose).toHaveBeenCalledTimes(1);
    expect(input.unsubscribe).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
