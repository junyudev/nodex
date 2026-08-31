import { describe, expect, test } from "vite-plus/test";
import {
  appendCodexCommandOutputTail,
  buildCodexCommandOutputKey,
  CodexCommandOutputQueue,
  type CodexCommandOutputScheduler,
  type CodexCommandOutputUpdate,
} from "./codex-command-output-queue";

class ManualCommandOutputScheduler implements CodexCommandOutputScheduler {
  private nextHandle = 1;
  private readonly timeouts = new Map<number, { callback: () => void; delayMs: number }>();

  readonly scheduleTimeout = (callback: () => void, delayMs: number): (() => void) => {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.timeouts.set(handle, { callback, delayMs });
    return () => {
      this.timeouts.delete(handle);
    };
  };

  runNextTimeout(): void {
    const entry = this.timeouts.entries().next().value as
      | [number, { callback: () => void; delayMs: number }]
      | undefined;
    if (!entry) throw new Error("No command-output timeout is scheduled");
    this.timeouts.delete(entry[0]);
    entry[1].callback();
  }

  get timeoutCount(): number {
    return this.timeouts.size;
  }

  get nextDelayMs(): number | null {
    const entry = this.timeouts.values().next().value as
      | { callback: () => void; delayMs: number }
      | undefined;
    return entry?.delayMs ?? null;
  }
}

interface SequencedOutput extends CodexCommandOutputUpdate {
  readonly sequence: number;
  readonly sequences?: readonly number[];
}

function output(delta: string, overrides: Partial<SequencedOutput> = {}): SequencedOutput {
  return {
    conversationId: "conversation-a",
    turnId: "turn-a",
    itemId: "item-a",
    delta,
    sequence: 1,
    ...overrides,
  };
}

describe("appendCodexCommandOutputTail", () => {
  test("matches every exact maximum and empty-delta boundary", () => {
    const zeroEmpty = appendCodexCommandOutputTail({
      current: "",
      delta: "",
      maxChars: 0,
    });
    const zeroContent = appendCodexCommandOutputTail({
      current: "x",
      delta: "",
      maxChars: 0,
    });
    const emptyAtLimit = appendCodexCommandOutputTail({
      current: "12345",
      delta: "",
      maxChars: 5,
    });
    const emptyOverLimit = appendCodexCommandOutputTail({
      current: "123456",
      delta: "",
      maxChars: 5,
    });
    const exactDelta = appendCodexCommandOutputTail({
      current: "old",
      delta: "12345",
      maxChars: 5,
    });
    const exactCombined = appendCodexCommandOutputTail({
      current: "12",
      delta: "345",
      maxChars: 5,
    });
    const overflowing = appendCodexCommandOutputTail({
      current: "1234",
      delta: "567",
      maxChars: 5,
    });

    expect(`${zeroEmpty.next}:${zeroEmpty.didTruncate}`).toBe(":false");
    expect(`${zeroContent.next}:${zeroContent.didTruncate}`).toBe(":true");
    expect(`${emptyAtLimit.next}:${emptyAtLimit.didTruncate}`).toBe("12345:false");
    expect(`${emptyOverLimit.next}:${emptyOverLimit.didTruncate}`).toBe("123456:true");
    expect(`${exactDelta.next}:${exactDelta.didTruncate}`).toBe("12345:true");
    expect(`${exactCombined.next}:${exactCombined.didTruncate}`).toBe("12345:false");
    expect(`${overflowing.next}:${overflowing.didTruncate}`).toBe("34567:true");
  });

  test("counts and slices JavaScript UTF-16 code units", () => {
    const result = appendCodexCommandOutputTail({
      current: "😀",
      delta: "abc",
      maxChars: 4,
    });

    expect(result.next.length).toBe(4);
    expect(result.next.charCodeAt(0)).toBe(0xde00);
    expect(result.next.slice(1)).toBe("abc");
    expect(result.didTruncate).toBe(true);
  });
});

describe("CodexCommandOutputQueue", () => {
  test("builds the exact raw colon key including nullable turns", () => {
    expect(buildCodexCommandOutputKey(output("x"))).toBe("conversation-a:turn-a:item-a");
    expect(buildCodexCommandOutputKey(output("x", { turnId: null }))).toBe(
      "conversation-a:null:item-a",
    );
  });

  test("keeps A/B/A Map order and permits adapter metadata aggregation", () => {
    const scheduler = new ManualCommandOutputScheduler();
    const flushes: SequencedOutput[][] = [];
    const queue = new CodexCommandOutputQueue<SequencedOutput>({
      scheduler,
      mergeUpdate: (existing, incoming, mergedDelta) => ({
        ...incoming,
        delta: mergedDelta,
        sequences: [
          ...(existing?.sequences ??
            [existing?.sequence].filter(
              (sequence): sequence is number => typeof sequence === "number",
            )),
          ...(incoming.sequences ?? [incoming.sequence]),
        ],
      }),
      onFlush: (updates) => flushes.push([...updates]),
    });

    queue.enqueue(output("A1", { sequence: 1 }));
    queue.enqueue(
      output("B1", {
        conversationId: "conversation-b",
        itemId: "item-b",
        sequence: 2,
      }),
    );
    queue.enqueue(output("A2", { sequence: 3 }));
    scheduler.runNextTimeout();

    expect(flushes.length).toBe(1);
    expect(flushes[0]?.map((update) => update.conversationId).join(",")).toBe(
      "conversation-a,conversation-b",
    );
    expect(flushes[0]?.[0]?.delta).toBe("A1A2");
    expect(flushes[0]?.[0]?.sequences?.join(",")).toBe("1,3");
    expect(flushes[0]?.[1]?.delta).toBe("B1");
  });

  test("uses one non-resetting 50ms timeout and exact bounded coalescing", () => {
    const scheduler = new ManualCommandOutputScheduler();
    const flushed: string[] = [];
    const queue = new CodexCommandOutputQueue<SequencedOutput>({
      scheduler,
      maxBufferedChars: 5,
      onFlush: (updates) => flushed.push(updates[0]?.delta ?? "missing"),
    });

    queue.enqueue(output("1234"));
    queue.enqueue(output("567"));

    expect(scheduler.timeoutCount).toBe(1);
    expect(scheduler.nextDelayMs).toBe(50);
    scheduler.runNextTimeout();
    expect(flushed.join(",")).toBe("34567");
  });

  test("cuts a batch before a new key can exceed the manager-global key budget", () => {
    const scheduler = new ManualCommandOutputScheduler();
    const flushes: string[][] = [];
    const queue = new CodexCommandOutputQueue<SequencedOutput>({
      scheduler,
      maxBufferedKeys: 2,
      onFlush: (updates) => flushes.push(updates.map((update) => update.itemId)),
    });

    expect(queue.enqueue(output("a", { itemId: "item-a" }))).toEqual({
      forcedFlush: false,
      deliveredInline: false,
    });
    queue.enqueue(output("b", { itemId: "item-b" }));
    expect(queue.enqueue(output("c", { itemId: "item-c" }))).toEqual({
      forcedFlush: true,
      deliveredInline: false,
    });

    expect(flushes).toEqual([["item-a", "item-b"]]);
    expect(scheduler.timeoutCount).toBe(1);
    scheduler.runNextTimeout();
    expect(flushes).toEqual([["item-a", "item-b"], ["item-c"]]);
  });

  test("cuts a coalesced batch before sequence metadata can exceed the update budget", () => {
    const scheduler = new ManualCommandOutputScheduler();
    const flushes: SequencedOutput[][] = [];
    const queue = new CodexCommandOutputQueue<SequencedOutput>({
      scheduler,
      maxBufferedUpdates: 2,
      mergeUpdate: (existing, incoming, mergedDelta) => ({
        ...incoming,
        delta: mergedDelta,
        sequences: [...(existing?.sequences ?? []), incoming.sequence],
      }),
      onFlush: (updates) => flushes.push([...updates]),
    });

    queue.enqueue(output("a", { sequence: 1 }));
    queue.enqueue(output("b", { sequence: 2 }));
    const result = queue.enqueue(output("c", { sequence: 3 }));

    expect(result.forcedFlush).toBe(true);
    expect(flushes[0]?.[0]?.delta).toBe("ab");
    expect(flushes[0]?.[0]?.sequences).toEqual([1, 2]);
    scheduler.runNextTimeout();
    expect(flushes[1]?.[0]?.delta).toBe("c");
    expect(flushes[1]?.[0]?.sequences).toEqual([3]);
  });

  test("accounts UTF-8 bytes and never retains an individually over-budget update", () => {
    const scheduler = new ManualCommandOutputScheduler();
    const flushes: string[][] = [];
    const queue = new CodexCommandOutputQueue<SequencedOutput>({
      scheduler,
      maxBufferedUtf8Bytes: 4,
      onFlush: (updates) => flushes.push(updates.map((update) => update.delta)),
    });

    queue.enqueue(output("é"));
    expect(queue.enqueue(output("é"))).toEqual({
      forcedFlush: false,
      deliveredInline: false,
    });
    expect(queue.enqueue(output("x"))).toEqual({
      forcedFlush: true,
      deliveredInline: false,
    });
    expect(flushes).toEqual([["éé"]]);

    const inline = queue.enqueue(
      output("😀😀", { conversationId: "conversation-b", itemId: "item-b" }),
    );
    expect(inline).toEqual({ forcedFlush: true, deliveredInline: true });
    expect(flushes).toEqual([["éé"], ["x"], ["😀😀"]]);
  });

  test("treats an empty delta as queued work", () => {
    const scheduler = new ManualCommandOutputScheduler();
    const flushed: string[] = [];
    const queue = new CodexCommandOutputQueue<SequencedOutput>({
      scheduler,
      onFlush: (updates) => flushed.push(updates[0]?.delta ?? "missing"),
    });

    queue.enqueue(output(""));
    expect(scheduler.timeoutCount).toBe(1);
    scheduler.runNextTimeout();

    expect(flushed.length).toBe(1);
    expect(flushed[0]).toBe("");
  });

  test("manual flush leaves the scheduled timeout available for its original batch", () => {
    const scheduler = new ManualCommandOutputScheduler();
    const flushed: string[] = [];
    const queue = new CodexCommandOutputQueue<SequencedOutput>({
      scheduler,
      onFlush: (updates) => flushed.push(updates[0]?.delta ?? "missing"),
    });

    queue.enqueue(output("first"));
    queue.flushNow();
    expect(scheduler.timeoutCount).toBe(1);
    queue.enqueue(output("second"));
    expect(scheduler.timeoutCount).toBe(1);
    scheduler.runNextTimeout();

    expect(flushed.join(",")).toBe("first,second");
  });

  test("scoped teardown preserves unrelated work and cancels only the last removal", () => {
    const scheduler = new ManualCommandOutputScheduler();
    const flushed: string[] = [];
    const queue = new CodexCommandOutputQueue<SequencedOutput>({
      scheduler,
      onFlush: (updates) => {
        flushed.push(updates.map((update) => update.conversationId).join(","));
      },
    });

    queue.enqueue(output("a"));
    queue.enqueue(
      output("b", {
        conversationId: "conversation-b",
        itemId: "item-b",
      }),
    );
    queue.discardConversation("conversation-a");
    expect(scheduler.timeoutCount).toBe(1);
    scheduler.runNextTimeout();
    expect(flushed.join(",")).toBe("conversation-b");

    queue.enqueue(output("a2"));
    queue.discardConversation("conversation-a");
    expect(scheduler.timeoutCount).toBe(0);
  });

  test("dispose cancels the timeout and drops all buffered output", () => {
    const scheduler = new ManualCommandOutputScheduler();
    let flushCalls = 0;
    const queue = new CodexCommandOutputQueue<SequencedOutput>({
      scheduler,
      onFlush: () => {
        flushCalls += 1;
      },
    });

    queue.enqueue(output("pending"));
    queue.dispose();

    expect(scheduler.timeoutCount).toBe(0);
    expect(flushCalls).toBe(0);
  });

  test("clears the batch before callback so reentrant enqueue schedules a new timeout", () => {
    const scheduler = new ManualCommandOutputScheduler();
    const flushed: string[] = [];
    const queue = new CodexCommandOutputQueue<SequencedOutput>({
      scheduler,
      onFlush: (updates) => {
        const delta = updates[0]?.delta ?? "missing";
        flushed.push(delta);
        if (delta === "first") queue.enqueue(output("second"));
      },
    });

    queue.enqueue(output("first"));
    scheduler.runNextTimeout();
    expect(scheduler.timeoutCount).toBe(1);
    scheduler.runNextTimeout();

    expect(flushed.join(",")).toBe("first,second");
  });
});
