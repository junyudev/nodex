import { describe, expect, test } from "vite-plus/test";
import { readbackId, type Readback } from "../../../shared/readback";
import { readbackVisibleDuration } from "./readback-timing";
import { createReadbackStore, type ReadbackCloseReason } from "./readback-store";

function makeReadback(sessionId: string, runId = "run-1"): Readback {
  return {
    id: readbackId(sessionId, runId),
    sessionId,
    threadId: `thread-${sessionId}`,
    runId,
    itemId: `item-${runId}`,
    text: "I'll merge the migrations first, then rebuild the review site.",
    title: `Chat ${sessionId}`,
    createdAt: 0,
    navigation: {
      hostId: "local",
      conversationId: `thread-${sessionId}`,
      navigationPath: `session:${sessionId}/thread:thread-${sessionId}`,
      activateTabId: null,
    },
  };
}

function recordingStore(limit?: number) {
  const closed: [string, ReadbackCloseReason][] = [];
  const store = createReadbackStore({
    ...(limit === undefined ? {} : { limit }),
    onClose: (readback, reason) => closed.push([readback.id, reason]),
  });
  const ids = () => store.getSnapshot().map((readback) => readback.sessionId);
  return { store, closed, ids };
}

describe("Readback store", () => {
  test("shows the newest Readback first and keeps one per chat", () => {
    const { store, closed, ids } = recordingStore();
    store.apply({ type: "show", readback: makeReadback("a") });
    store.apply({ type: "show", readback: makeReadback("b") });
    expect(ids()).toEqual(["b", "a"]);

    const next = makeReadback("a", "run-2");
    store.apply({ type: "show", readback: next });
    expect(ids()).toEqual(["a", "b"]);
    expect(store.getSnapshot()[0]).toBe(next);
    expect(closed).toEqual([[readbackId("a", "run-1"), "replaced"]]);
  });

  test("ignores a repeated show of the Readback already on screen", () => {
    const { store, closed } = recordingStore();
    const readback = makeReadback("a");
    store.apply({ type: "show", readback });
    const snapshot = store.getSnapshot();
    store.apply({ type: "show", readback: { ...readback } });
    expect(store.getSnapshot()).toBe(snapshot);
    expect(closed).toEqual([]);
  });

  test("lets the oldest Readback leave when the stack is full", () => {
    const { store, closed, ids } = recordingStore(2);
    for (const session of ["a", "b", "c"])
      store.apply({ type: "show", readback: makeReadback(session) });
    expect(ids()).toEqual(["c", "b"]);
    expect(closed).toEqual([[readbackId("a", "run-1"), "overflow"]]);
  });

  test("closes once, whether Main withdraws it or the window does", () => {
    const { store, closed, ids } = recordingStore();
    store.apply({ type: "show", readback: makeReadback("a") });
    store.apply({ type: "show", readback: makeReadback("b") });
    store.apply({ type: "withdraw", id: readbackId("a", "run-1"), reason: "seen" });
    store.close(readbackId("b", "run-1"), "expired");
    store.close(readbackId("b", "run-1"), "dismissed");
    store.apply({ type: "withdraw", id: readbackId("a", "run-1"), reason: "ended" });
    expect(ids()).toEqual([]);
    expect(closed).toEqual([
      [readbackId("a", "run-1"), "withdrawn"],
      [readbackId("b", "run-1"), "expired"],
    ]);
  });

  test("notifies subscribers until they leave", () => {
    const { store } = recordingStore();
    let notified = 0;
    const leave = store.subscribe(() => (notified += 1));
    store.apply({ type: "show", readback: makeReadback("a") });
    leave();
    store.close(readbackId("a", "run-1"), "dismissed");
    expect(notified).toBe(1);
  });
});

describe("Readback time on screen", () => {
  test("gives a short statement 8 seconds and caps a long one at 20", () => {
    expect(readbackVisibleDuration("On it.")).toBe(8_000);
    expect(readbackVisibleDuration("x".repeat(150))).toBe(12_500);
    expect(readbackVisibleDuration("x".repeat(5_000))).toBe(20_000);
  });
});
