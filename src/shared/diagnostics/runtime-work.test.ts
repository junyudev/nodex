import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  classifyRuntimeFrame,
  createRuntimeWorkLedger,
  mergeRuntimeWork,
  runtimeWorkTotal,
} from "./runtime-work";

afterEach(() => {
  vi.useRealTimers();
});

describe("Runtime work ledger", () => {
  it("tallies each boundary of one work separately from other works", () => {
    const ledger = createRuntimeWorkLedger();
    ledger.record("w1-nav-1", "runtime.reply:thread.snapshot", 900, 12);
    ledger.record("w1-nav-1", "runtime.reply:thread.snapshot", 100, 3);
    ledger.record("w1-nav-1", "runtime.event:turn-item.updated:assistant_message", 40);
    ledger.record("w2-nav-1", "runtime.event:turn-item.updated:assistant_message", 40);
    expect(ledger.read("w1-nav-1")).toEqual({
      "runtime.reply:thread.snapshot": { count: 2, bytes: 1000, rows: 15 },
      "runtime.event:turn-item.updated:assistant_message": { count: 1, bytes: 40, rows: 0 },
    });
    expect(runtimeWorkTotal(ledger.read("w1-nav-1"), "runtime.")).toEqual({
      count: 3,
      bytes: 1040,
      rows: 15,
    });
    expect(
      mergeRuntimeWork([ledger.read("w1-nav-1"), ledger.read("w2-nav-1")])[
        "runtime.event:turn-item.updated:assistant_message"
      ],
    ).toEqual({ count: 2, bytes: 80, rows: 0 });
  });

  it("reports a work once after it has been quiet, so each report is one batch", () => {
    vi.useFakeTimers();
    const settled: unknown[] = [];
    const ledger = createRuntimeWorkLedger({
      settleMs: 1_000,
      onSettled: (work, reading) => settled.push({ work, reading }),
    });
    ledger.record("w1-read-1", "renderer.delivery:event", 10);
    vi.advanceTimersByTime(800);
    ledger.record("w1-read-1", "renderer.delivery:event", 10);
    vi.advanceTimersByTime(800);
    expect(settled).toEqual([]);
    vi.advanceTimersByTime(200);
    expect(settled).toEqual([
      {
        work: "w1-read-1",
        reading: { "renderer.delivery:event": { count: 2, bytes: 20, rows: 0 } },
      },
    ]);
    // The next delivery starts a new batch.
    expect(ledger.read("w1-read-1")).toEqual({});
  });

  it("reports and forgets the oldest work beyond its capacity", () => {
    const settled: string[] = [];
    const ledger = createRuntimeWorkLedger({
      capacity: 2,
      onSettled: (work) => settled.push(work),
    });
    ledger.record("a", "renderer.install");
    ledger.record("b", "renderer.install");
    ledger.record("c", "renderer.install");
    expect(settled).toEqual(["a"]);
    expect(ledger.works()).toEqual(["b", "c"]);
    ledger.flush();
    expect(settled).toEqual(["a", "b", "c"]);
  });
});

describe("Runtime frame classification", () => {
  it("reads replies, observations and events by protocol discriminators only", () => {
    expect(
      classifyRuntimeFrame({
        id: "request",
        success: true,
        output: { projection: { visibleTurnItems: [{}, {}, {}] } },
      }),
    ).toEqual({ kind: "reply", id: "request", success: true, rows: 3 });
    expect(
      classifyRuntimeFrame({
        id: "observe",
        success: true,
        output: { subscribed: true, subscriptionId: "observe", afterSequence: 4 },
      }),
    ).toEqual({ kind: "reply", id: "observe", success: true, rows: 0, subscriptionId: "observe" });
    expect(
      classifyRuntimeFrame({
        type: "event",
        subscriptionId: "observe",
        event: {
          sequence: 5,
          event: { type: "turn-item.updated", payload: { type: "reasoning" } },
        },
      }),
    ).toEqual({
      kind: "event",
      subscriptionId: "observe",
      metric: "runtime.event:turn-item.updated:reasoning",
    });
    expect(
      classifyRuntimeFrame({ type: "event.error", subscriptionId: "observe", message: "gap" }),
    ).toEqual({ kind: "event", subscriptionId: "observe", metric: "runtime.event:error" });
    expect(
      classifyRuntimeFrame({
        type: "event.item-patch",
        subscriptionId: "observe",
        sequence: 6,
        patch: { itemId: "item", append: { field: "text", offset: 4, text: "more" } },
      }),
    ).toEqual({ kind: "event", subscriptionId: "observe", metric: "runtime.event:item-patch" });
    expect(
      classifyRuntimeFrame({ type: "activity", rootThreadId: "root", sequence: 1 }),
    ).toBeNull();
  });
});
