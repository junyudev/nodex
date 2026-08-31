import { describe, expect, test } from "vite-plus/test";
import {
  buildCodexFrameTextDeltaKey,
  CodexFrameTextDeltaQueue,
  type CodexFrameTextDeltaScheduler,
  type CodexFrameTextDeltaUpdate,
} from "./codex-frame-text-delta-queue";

class ManualFrameTextDeltaScheduler implements CodexFrameTextDeltaScheduler {
  canAnimate = true;
  private nextHandle = 1;
  private readonly frames = new Map<number, () => void>();
  private readonly timeouts = new Map<number, () => void>();

  readonly canUseAnimationFrame = (): boolean => this.canAnimate;

  readonly scheduleAnimationFrame = (callback: () => void): (() => void) => {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.frames.set(handle, callback);
    return () => {
      this.frames.delete(handle);
    };
  };

  readonly scheduleTimeout = (callback: () => void): (() => void) => {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.timeouts.set(handle, callback);
    return () => {
      this.timeouts.delete(handle);
    };
  };

  runNextFrame(): void {
    const entry = this.frames.entries().next().value as [number, () => void] | undefined;
    if (!entry) throw new Error("No animation frame is scheduled");
    this.frames.delete(entry[0]);
    entry[1]();
  }

  runNextTimeout(): void {
    const entry = this.timeouts.entries().next().value as [number, () => void] | undefined;
    if (!entry) throw new Error("No timeout is scheduled");
    this.timeouts.delete(entry[0]);
    entry[1]();
  }

  get frameCount(): number {
    return this.frames.size;
  }

  get timeoutCount(): number {
    return this.timeouts.size;
  }
}

interface SequencedDelta extends CodexFrameTextDeltaUpdate {
  readonly sequence: number;
}

function delta(deltaText: string, overrides: Partial<SequencedDelta> = {}): SequencedDelta {
  return {
    conversationId: "conversation-a",
    turnId: "turn-a",
    itemId: "item-a",
    target: { type: "agentMessage" },
    delta: deltaText,
    sequence: 1,
    ...overrides,
  };
}

describe("CodexFrameTextDeltaQueue", () => {
  test("builds the exact raw colon-joined buffer key", () => {
    expect(buildCodexFrameTextDeltaKey(delta("x"))).toBe(
      "conversation-a:turn-a:item-a:agentMessage",
    );
    expect(
      buildCodexFrameTextDeltaKey(
        delta("x", {
          turnId: null,
          target: { type: "reasoningContent", contentIndex: 2 },
        }),
      ),
    ).toBe("conversation-a:null:item-a:reasoningContent:2");
  });

  test("coalesces exact keys without moving Map order and retains newest metadata", () => {
    const scheduler = new ManualFrameTextDeltaScheduler();
    const flushes: SequencedDelta[][] = [];
    const queue = new CodexFrameTextDeltaQueue<SequencedDelta>({
      scheduler,
      onFlush: (updates) => flushes.push([...updates]),
    });

    queue.enqueue(delta("A1", { sequence: 1 }));
    queue.enqueue(
      delta("B1", {
        conversationId: "conversation-b",
        itemId: "item-b",
        sequence: 2,
      }),
    );
    queue.enqueue(delta("A2", { sequence: 3 }));
    scheduler.runNextFrame();

    expect(flushes.length).toBe(1);
    expect(flushes[0]?.map((update) => update.conversationId).join(",")).toBe(
      "conversation-a,conversation-b",
    );
    expect(flushes[0]?.[0]?.delta).toBe("A1A2");
    expect(flushes[0]?.[0]?.sequence).toBe(3);
    expect(flushes[0]?.[1]?.delta).toBe("B1");
  });

  test("isolates targets and reasoning indexes in the exact key", () => {
    const scheduler = new ManualFrameTextDeltaScheduler();
    const flushed: SequencedDelta[] = [];
    const queue = new CodexFrameTextDeltaQueue<SequencedDelta>({
      scheduler,
      onFlush: (updates) => flushed.push(...updates),
    });

    queue.enqueue(delta("agent"));
    queue.enqueue(delta("plan", { target: { type: "plan" } }));
    queue.enqueue(
      delta("summary-0", {
        target: { type: "reasoningSummary", summaryIndex: 0 },
      }),
    );
    queue.enqueue(
      delta("summary-1", {
        target: { type: "reasoningSummary", summaryIndex: 1 },
      }),
    );
    queue.enqueue(
      delta("content-0", {
        target: { type: "reasoningContent", contentIndex: 0 },
      }),
    );
    scheduler.runNextFrame();

    expect(flushed.length).toBe(5);
    expect(flushed.map((update) => update.delta).join("|")).toBe(
      "agent|plan|summary-0|summary-1|content-0",
    );
  });

  test("slices every visible key by 24 JavaScript UTF-16 code units", () => {
    const scheduler = new ManualFrameTextDeltaScheduler();
    const chunks: string[] = [];
    const queue = new CodexFrameTextDeltaQueue<SequencedDelta>({
      scheduler,
      onFlush: (updates) => chunks.push(updates[0]?.delta ?? ""),
    });
    const text = `${"a".repeat(23)}😀z`;

    queue.enqueue(delta(text));
    scheduler.runNextFrame();
    scheduler.runNextFrame();

    expect(chunks.length).toBe(2);
    expect(chunks[0]?.length).toBe(24);
    expect(chunks[0]?.charCodeAt(23)).toBe(0xd83d);
    expect(chunks[1]?.charCodeAt(0)).toBe(0xde00);
    expect(chunks.join("")).toBe(text);
  });

  test("uses one delayed full flush when animation frames are unavailable", () => {
    const scheduler = new ManualFrameTextDeltaScheduler();
    scheduler.canAnimate = false;
    const chunks: string[] = [];
    const queue = new CodexFrameTextDeltaQueue<SequencedDelta>({
      scheduler,
      onFlush: (updates) => chunks.push(updates[0]?.delta ?? ""),
    });

    queue.enqueue(delta("x".repeat(100)));
    expect(scheduler.frameCount).toBe(0);
    expect(scheduler.timeoutCount).toBe(1);
    scheduler.runNextTimeout();

    expect(chunks.length).toBe(1);
    expect(chunks[0]?.length).toBe(100);
    expect(scheduler.timeoutCount).toBe(0);
  });

  test("treats an empty delta as queued work that flushes before completion", () => {
    const scheduler = new ManualFrameTextDeltaScheduler();
    const flushed: string[] = [];
    let callbackCalls = 0;
    const queue = new CodexFrameTextDeltaQueue<SequencedDelta>({
      scheduler,
      onFlush: (updates) => flushed.push(updates[0]?.delta ?? "missing"),
    });

    queue.enqueue(delta(""));
    const deferred = queue.drainBefore(() => {
      callbackCalls += 1;
    });

    expect(deferred).toBe(false);
    expect(flushed.length).toBe(1);
    expect(flushed[0]).toBe("");
    expect(callbackCalls).toBe(0);
    expect(scheduler.frameCount).toBe(0);
  });

  test("uses the global buffered length for cross-conversation drain", () => {
    const scheduler = new ManualFrameTextDeltaScheduler();
    const order: string[] = [];
    const terminalFlags: boolean[] = [];
    const queue = new CodexFrameTextDeltaQueue<SequencedDelta>({
      scheduler,
      onFlush: (updates, context) => {
        order.push(updates.map((update) => update.conversationId).join(","));
        terminalFlags.push(context.terminalDrainCommit);
      },
    });

    queue.enqueue(delta("a".repeat(13)));
    queue.enqueue(
      delta("b".repeat(13), {
        conversationId: "conversation-b",
        itemId: "item-b",
      }),
    );
    const deferred = queue.drainBefore(() => order.push("completed"));

    expect(deferred).toBe(true);
    expect(order.length).toBe(0);
    scheduler.runNextFrame();
    expect(order.join("|")).toBe("conversation-a,conversation-b|completed");
    expect(terminalFlags.join(",")).toBe("true");
  });

  test("shares one eight-frame drain budget across FIFO callbacks", () => {
    const scheduler = new ManualFrameTextDeltaScheduler();
    const chunks: number[] = [];
    const callbacks: string[] = [];
    const queue = new CodexFrameTextDeltaQueue<SequencedDelta>({
      scheduler,
      onFlush: (updates) => chunks.push(updates[0]?.delta.length ?? 0),
    });

    queue.enqueue(delta("x".repeat(193)));
    expect(queue.drainBefore(() => callbacks.push("first"))).toBe(true);
    scheduler.runNextFrame();
    expect(queue.drainBefore(() => callbacks.push("second"))).toBe(true);
    while (scheduler.frameCount > 0) {
      scheduler.runNextFrame();
    }

    expect(chunks.length).toBe(8);
    expect(chunks.reduce((total, chunk) => total + chunk, 0)).toBe(193);
    expect(callbacks.join(",")).toBe("first,second");
  });

  test("pressure flushes a bounded terminal callback batch before admitting more", () => {
    const scheduler = new ManualFrameTextDeltaScheduler();
    const order: string[] = [];
    const queue = new CodexFrameTextDeltaQueue<SequencedDelta>({
      scheduler,
      maxDrainCallbacks: 2,
      onFlush: () => order.push("text"),
    });

    queue.enqueue(delta("x".repeat(100)));
    expect(queue.drainBefore(() => order.push("first"), "conversation-a")).toBe(true);
    expect(queue.drainBefore(() => order.push("second"), "conversation-a")).toBe(true);
    expect(queue.drainBefore(() => order.push("third"), "conversation-a")).toBe(false);

    expect(order).toEqual(["text", "first", "second"]);
    order.push("third");
    expect(order).toEqual(["text", "first", "second", "third"]);
    expect(scheduler.frameCount).toBe(0);
  });

  test("disposal drops pending buffers and terminal callbacks", () => {
    const scheduler = new ManualFrameTextDeltaScheduler();
    let callbackCalls = 0;
    let flushCalls = 0;
    const queue = new CodexFrameTextDeltaQueue<SequencedDelta>({
      scheduler,
      onFlush: () => {
        flushCalls += 1;
      },
    });

    queue.enqueue(delta("x".repeat(25)));
    queue.drainBefore(() => {
      callbackCalls += 1;
    });
    queue.dispose();

    expect(scheduler.frameCount).toBe(0);
    expect(flushCalls).toBe(0);
    expect(callbackCalls).toBe(0);
  });

  test("rejects per-key and aggregate pressure before concatenating another delta", () => {
    const scheduler = new ManualFrameTextDeltaScheduler();
    const flushed: string[] = [];
    const queue = new CodexFrameTextDeltaQueue<SequencedDelta>({
      scheduler,
      maxBufferedKeys: 2,
      maxBufferedCodeUnitsPerKey: 4,
      maxBufferedCodeUnits: 5,
      onFlush: (updates) => flushed.push(...updates.map((update) => update.delta)),
    });

    expect(queue.enqueue(delta("1234"))).toEqual({ accepted: true });
    expect(queue.enqueue(delta("5"))).toMatchObject({
      accepted: false,
      reason: "per-key-code-units",
      bufferedCodeUnits: 4,
      incomingCodeUnits: 1,
    });
    expect(
      queue.enqueue(delta("x", { conversationId: "conversation-b", itemId: "item-b" })),
    ).toEqual({ accepted: true });
    expect(
      queue.enqueue(delta("y", { conversationId: "conversation-b", itemId: "item-b" })),
    ).toMatchObject({
      accepted: false,
      reason: "total-code-units",
      bufferedCodeUnits: 5,
      incomingCodeUnits: 1,
    });

    scheduler.runNextFrame();
    expect(flushed).toEqual(["1234", "x"]);
  });

  test("bounds distinct keys and releases admission as frames or conversations drain", () => {
    const scheduler = new ManualFrameTextDeltaScheduler();
    const flushed: string[] = [];
    const queue = new CodexFrameTextDeltaQueue<SequencedDelta>({
      scheduler,
      targetCharsPerFrame: 2,
      maxBufferedKeys: 2,
      maxBufferedCodeUnitsPerKey: 8,
      maxBufferedCodeUnits: 6,
      onFlush: (updates) => flushed.push(...updates.map((update) => update.delta)),
    });

    expect(queue.enqueue(delta("1234"))).toEqual({ accepted: true });
    expect(
      queue.enqueue(delta("b", { conversationId: "conversation-b", itemId: "item-b" })),
    ).toEqual({ accepted: true });
    expect(
      queue.enqueue(delta("c", { conversationId: "conversation-c", itemId: "item-c" })),
    ).toMatchObject({ accepted: false, reason: "key-count" });

    scheduler.runNextFrame();
    expect(flushed).toEqual(["12", "b"]);
    expect(
      queue.enqueue(delta("cd", { conversationId: "conversation-c", itemId: "item-c" })),
    ).toEqual({ accepted: true });
    queue.discardConversation("conversation-a");
    expect(
      queue.enqueue(delta("ef", { conversationId: "conversation-d", itemId: "item-d" })),
    ).toEqual({ accepted: true });
  });

  test("scoped teardown drops only that conversation without flushing or stranding others", () => {
    const scheduler = new ManualFrameTextDeltaScheduler();
    const flushed: string[] = [];
    const callbacks: string[] = [];
    const queue = new CodexFrameTextDeltaQueue<SequencedDelta>({
      scheduler,
      onFlush: (updates) => {
        flushed.push(updates.map((update) => update.conversationId).join(","));
      },
    });

    queue.enqueue(delta("a".repeat(30)));
    queue.enqueue(
      delta("b".repeat(30), {
        conversationId: "conversation-b",
        itemId: "item-b",
      }),
    );
    expect(queue.drainBefore(() => callbacks.push("a-completed"), "conversation-a")).toBe(true);
    expect(queue.drainBefore(() => callbacks.push("b-completed"), "conversation-b")).toBe(true);

    queue.discardConversation("conversation-a");
    expect(flushed.length).toBe(0);
    expect(callbacks.length).toBe(0);
    while (scheduler.frameCount > 0) {
      scheduler.runNextFrame();
    }

    expect(flushed.join("|")).toBe("conversation-b|conversation-b");
    expect(callbacks.join(",")).toBe("b-completed");
  });

  test("terminal flush publishes only the addressed conversation and preserves the global timer", () => {
    const scheduler = new ManualFrameTextDeltaScheduler();
    const flushed: string[] = [];
    const terminal: boolean[] = [];
    const queue = new CodexFrameTextDeltaQueue<SequencedDelta>({
      scheduler,
      onFlush: (updates, context) => {
        flushed.push(updates.map((update) => `${update.conversationId}:${update.delta}`).join(","));
        terminal.push(context.terminalDrainCommit);
      },
    });

    queue.enqueue(delta("a"));
    queue.enqueue(
      delta("b", {
        conversationId: "conversation-b",
        itemId: "item-b",
      }),
    );

    queue.flushConversationNow("conversation-a");
    expect(flushed).toEqual(["conversation-a:a"]);
    expect(terminal).toEqual([true]);
    expect(scheduler.frameCount).toBe(1);

    scheduler.runNextFrame();
    expect(flushed).toEqual(["conversation-a:a", "conversation-b:b"]);
    expect(terminal).toEqual([true, false]);
  });

  test("scoped teardown completes surviving drains when it removes the last buffer", () => {
    const scheduler = new ManualFrameTextDeltaScheduler();
    const callbacks: string[] = [];
    const queue = new CodexFrameTextDeltaQueue<SequencedDelta>({
      scheduler,
      onFlush: () => {
        throw new Error("discarded text must not flush");
      },
    });

    queue.enqueue(delta("a".repeat(30)));
    expect(queue.drainBefore(() => callbacks.push("discarded"), "conversation-a")).toBe(true);
    expect(queue.drainBefore(() => callbacks.push("survivor"), "conversation-b")).toBe(true);

    queue.discardConversation("conversation-a");

    expect(scheduler.frameCount).toBe(0);
    expect(callbacks.join(",")).toBe("survivor");
  });
});
