import { describe, expect, it } from "@effect/vitest";
import {
  applyCodexHistoryItemWindowMutation,
  appendCodexHistoryItemPage,
  createCodexHistoryItemWindow,
  materializeCodexHistoryItemWindow,
  prependCodexHistoryItemPage,
  type CodexHistoryItemSegment,
  type CodexHistoryItemWindow,
} from "./codex-history-item-window";

interface CanonicalItem {
  readonly id: string;
  readonly text: string;
}

interface RendererItem {
  readonly entryId: string;
  readonly text: string;
}

const available = (cursor: string | null) => ({ status: "available" as const, cursor });

function segment(
  segmentId: string,
  itemIds: readonly string[],
  approximateBytes = itemIds.length * 32,
  turnId = "turn-a",
): CodexHistoryItemSegment<CanonicalItem, RendererItem> {
  return {
    segmentId,
    turnId,
    items: {
      itemIds,
      canonicalItems: itemIds.map((id) => ({ id, text: `canonical:${id}` })),
      rendererItems: itemIds.map((id) => ({ entryId: `entry:${id}`, text: `renderer:${id}` })),
    },
    approximateBytes,
  };
}

function createWindow(input?: {
  readonly maxItems?: number;
  readonly maxApproximateBytes?: number;
  readonly olderCursor?: string | null;
  readonly seedSegments?: readonly CodexHistoryItemSegment<CanonicalItem, RendererItem>[];
}): CodexHistoryItemWindow<CanonicalItem, RendererItem> {
  const created = createCodexHistoryItemWindow<CanonicalItem, RendererItem>({
    turnId: "turn-a",
    limits: {
      maxItems: input?.maxItems ?? 8,
      maxApproximateBytes: input?.maxApproximateBytes ?? 1_024,
    },
    olderBoundary: available(input?.olderCursor ?? "cursor:before"),
    seedSegments: input?.seedSegments,
  });
  if (!created.ok) throw new Error(created.error.message);
  return created.window;
}

describe("Codex history item window", () => {
  it("materializes seeded canonical and renderer segments only at the explicit view seam", () => {
    const window = createWindow({
      seedSegments: [segment("older", ["a", "b"]), segment("newer", ["c"])],
    });

    expect(window.residency).toEqual({
      segmentCount: 2,
      itemCount: 3,
      approximateBytes: 96,
      limitsSatisfied: true,
      protectedOverage: false,
    });
    const materialized = materializeCodexHistoryItemWindow(window);
    expect(materialized.segments.map(({ segmentId }) => segmentId)).toEqual(["older", "newer"]);
    expect(materialized.itemIds).toEqual(["a", "b", "c"]);
    expect(materialized.canonicalItems.map(({ id }) => id)).toEqual(["a", "b", "c"]);
    expect(materialized.rendererItems.map(({ entryId }) => entryId)).toEqual([
      "entry:a",
      "entry:b",
      "entry:c",
    ]);
    expect(materialized.work).toEqual({
      segmentsVisited: 2,
      itemIdsVisited: 3,
      canonicalItemsVisited: 3,
      rendererItemsVisited: 3,
    });
  });

  it("keeps the revealed older page, releases remote newer segments, and leaves an honest cut", () => {
    const before = createWindow({
      maxItems: 4,
      seedSegments: [segment("resident-older", ["c", "d"]), segment("resident-tail", ["e", "f"])],
    });
    const transition = prependCodexHistoryItemPage(before, {
      ...segment("revealed", ["a", "b"]),
      olderCursorAfter: "cursor:after",
    });
    if (!transition.ok) throw new Error(transition.error.message);

    expect(transition.releasedSegmentIds).toEqual(["resident-tail"]);
    expect(transition.window.residency).toEqual({
      segmentCount: 2,
      itemCount: 4,
      approximateBytes: 128,
      limitsSatisfied: true,
      protectedOverage: false,
    });
    expect(transition.window.olderBoundary).toEqual(available("cursor:after"));
    expect(transition.window.newerBoundary).toEqual({ status: "opaque" });
    expect(transition.wireSegment.olderBoundaryBefore).toEqual(available("cursor:before"));
    expect(transition.wireSegment.olderBoundaryAfter).toEqual(available("cursor:after"));
    expect(transition.wireSegment.items.itemIds).toEqual(["a", "b"]);
    expect(materializeCodexHistoryItemWindow(transition.window).itemIds).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
    expect(transition.work.residentItemsMaterialized).toBe(0);
    expect(transition.work.pageItemsVisited).toBe(2);
  });

  it("applies the same page-local segment and verifies exact receiver releases", () => {
    const source = createWindow({
      maxItems: 2,
      seedSegments: [segment("seed-a", ["a"]), segment("seed-b", ["b"])],
    });
    const receiver = createWindow({
      maxItems: 2,
      seedSegments: [segment("seed-a", ["a"]), segment("seed-b", ["b"])],
    });
    const transition = prependCodexHistoryItemPage(source, {
      ...segment("page", ["older"]),
      olderCursorAfter: null,
    });
    if (!transition.ok) throw new Error(transition.error.message);

    const applied = applyCodexHistoryItemWindowMutation(receiver, {
      wireSegment: transition.wireSegment,
      releasedSegmentIds: transition.releasedSegmentIds,
    });
    if (!applied.ok) throw new Error(applied.error.message);
    expect(materializeCodexHistoryItemWindow(applied.window).itemIds).toEqual(["older", "a"]);
    expect(applied.window.olderBoundary).toEqual({ status: "exhausted" });
    expect(applied.window.newerBoundary).toEqual({ status: "opaque" });
    expect(applied.work.residentItemsMaterialized).toBe(0);

    const forged = applyCodexHistoryItemWindowMutation(receiver, {
      wireSegment: transition.wireSegment,
      releasedSegmentIds: [],
    });
    expect(forged).toMatchObject({ ok: false, error: { code: "releaseMismatch" } });
    expect(materializeCodexHistoryItemWindow(receiver).itemIds).toEqual(["a", "b"]);
  });

  it("uses the server reverse cursor to restore a released newer segment without skipping", () => {
    const initial = createWindow({
      maxItems: 4,
      seedSegments: [
        {
          ...segment("middle", ["c", "d"]),
          olderCursor: "cursor:toward-older",
          newerCursor: "cursor:toward-newer",
        },
        segment("tail", ["e", "f"]),
      ],
    });
    const older = prependCodexHistoryItemPage(initial, {
      ...segment("older", ["a", "b"]),
      olderCursorAfter: null,
      newerCursor: "cursor:only-adjacent-to-new-page",
    });
    if (!older.ok) throw new Error(older.error.message);
    expect(older.window.newerBoundary).toEqual(available("cursor:toward-newer"));
    expect(materializeCodexHistoryItemWindow(older.window).itemIds).toEqual(["a", "b", "c", "d"]);

    const newer = appendCodexHistoryItemPage(older.window, {
      ...segment("tail-restored", ["e", "f"]),
      newerCursorAfter: null,
      olderCursor: "cursor:only-adjacent-to-new-page",
    });
    if (!newer.ok) throw new Error(newer.error.message);
    expect(newer.releasedSegmentIds).toEqual(["older"]);
    expect(newer.window.olderBoundary).toEqual(available("cursor:toward-older"));
    expect(newer.window.newerBoundary).toEqual({ status: "exhausted" });
    expect(materializeCodexHistoryItemWindow(newer.window).itemIds).toEqual(["c", "d", "e", "f"]);

    const receiver = createWindow({
      maxItems: 4,
      seedSegments: [
        {
          ...segment("middle", ["c", "d"]),
          olderCursor: "cursor:toward-older",
          newerCursor: "cursor:toward-newer",
        },
        segment("tail", ["e", "f"]),
      ],
    });
    const appliedOlder = applyCodexHistoryItemWindowMutation(receiver, {
      wireSegment: older.wireSegment,
      releasedSegmentIds: older.releasedSegmentIds,
    });
    if (!appliedOlder.ok) throw new Error(appliedOlder.error.message);
    const appliedNewer = applyCodexHistoryItemWindowMutation(appliedOlder.window, {
      wireSegment: newer.wireSegment,
      releasedSegmentIds: newer.releasedSegmentIds,
    });
    if (!appliedNewer.ok) throw new Error(appliedNewer.error.message);
    expect(materializeCodexHistoryItemWindow(appliedNewer.window).itemIds).toEqual([
      "c",
      "d",
      "e",
      "f",
    ]);
  });

  it("bounds bytes independently and protects one indivisible oversized physical page", () => {
    const before = createWindow({
      maxItems: 10,
      maxApproximateBytes: 100,
      seedSegments: [segment("old", ["a"], 40), segment("tail", ["b"], 40)],
    });
    const admitted = prependCodexHistoryItemPage(before, {
      ...segment("page", ["older"], 70),
      olderCursorAfter: "cursor:next",
    });
    if (!admitted.ok) throw new Error(admitted.error.message);
    expect(admitted.releasedSegmentIds).toEqual(["tail", "old"]);
    expect(admitted.window.residency).toEqual({
      segmentCount: 1,
      itemCount: 1,
      approximateBytes: 70,
      limitsSatisfied: true,
      protectedOverage: false,
    });

    const overage = prependCodexHistoryItemPage(before, {
      ...segment("oversized", ["large"], 101),
      olderCursorAfter: "cursor:next",
    });
    if (!overage.ok) throw new Error(overage.error.message);
    expect(overage.releasedSegmentIds).toEqual(["tail", "old"]);
    expect(overage.window.residency).toEqual({
      segmentCount: 1,
      itemCount: 1,
      approximateBytes: 101,
      limitsSatisfied: false,
      protectedOverage: true,
    });
    expect(overage.window.olderBoundary).toEqual(available("cursor:next"));
    expect(materializeCodexHistoryItemWindow(before).itemIds).toEqual(["a", "b"]);
  });

  it("fails closed on foreign, duplicate, mismatched, stalled, and empty advancing pages", () => {
    const before = createWindow({ seedSegments: [segment("seed", ["resident"])] });
    const cases = [
      prependCodexHistoryItemPage(before, {
        ...segment("foreign", ["foreign"], 32, "turn-other"),
        olderCursorAfter: "cursor:next",
      }),
      prependCodexHistoryItemPage(before, {
        ...segment("seed", ["new"]),
        olderCursorAfter: "cursor:next",
      }),
      prependCodexHistoryItemPage(before, {
        ...segment("duplicate-resident", ["resident"]),
        olderCursorAfter: "cursor:next",
      }),
      prependCodexHistoryItemPage(before, {
        ...segment("duplicate-page", ["same", "same"]),
        olderCursorAfter: "cursor:next",
      }),
      prependCodexHistoryItemPage(before, {
        turnId: "turn-a",
        segmentId: "mismatch",
        items: {
          itemIds: ["declared"],
          canonicalItems: [{ id: "actual", text: "mismatch" }],
          rendererItems: [],
        },
        approximateBytes: 1,
        olderCursorAfter: "cursor:next",
      }),
      prependCodexHistoryItemPage(before, {
        ...segment("stalled", ["new"]),
        olderCursorAfter: "cursor:before",
      }),
      prependCodexHistoryItemPage(before, {
        ...segment("empty", []),
        olderCursorAfter: "cursor:next",
      }),
    ];

    expect(cases.map((result) => (result.ok ? "ok" : result.error.code))).toEqual([
      "foreignTurn",
      "duplicateSegment",
      "duplicateItem",
      "duplicateItem",
      "malformedIdentity",
      "cursorStalled",
      "emptyPageContinuation",
    ]);
    expect(materializeCodexHistoryItemWindow(before).itemIds).toEqual(["resident"]);
    expect(before.olderBoundary).toEqual(available("cursor:before"));
  });

  it("serializes only the admitted page without reading unchanged resident item payloads", () => {
    let unchangedPayloadReads = 0;
    const unchangedCanonical = {
      id: "resident",
      get text() {
        unchangedPayloadReads += 1;
        return "resident payload";
      },
    };
    const created = createCodexHistoryItemWindow<typeof unchangedCanonical, RendererItem>({
      turnId: "turn-a",
      limits: { maxItems: 2, maxApproximateBytes: 1_024 },
      olderBoundary: available("cursor:before"),
      seedSegments: [
        {
          segmentId: "seed",
          turnId: "turn-a",
          items: {
            itemIds: ["resident"],
            canonicalItems: [unchangedCanonical],
            rendererItems: [{ entryId: "entry:resident", text: "resident" }],
          },
          approximateBytes: 32,
        },
      ],
    });
    if (!created.ok) throw new Error(created.error.message);
    unchangedPayloadReads = 0;

    const transition = prependCodexHistoryItemPage(created.window, {
      turnId: "turn-a",
      segmentId: "page",
      items: {
        itemIds: ["older"],
        canonicalItems: [{ id: "older", text: "older payload" }],
        rendererItems: [{ entryId: "entry:older", text: "older" }],
      },
      approximateBytes: 32,
      olderCursorAfter: "cursor:next",
    });
    if (!transition.ok) throw new Error(transition.error.message);
    const encoded = JSON.stringify({
      wireSegment: transition.wireSegment,
      releasedSegmentIds: transition.releasedSegmentIds,
    });

    expect(encoded).toContain("older payload");
    expect(encoded).not.toContain("resident payload");
    expect(JSON.stringify(transition.window)).not.toContain("resident payload");
    expect(unchangedPayloadReads).toBe(0);
    expect(transition.work.residentItemsMaterialized).toBe(0);
  });

  it("keeps 10k repeated page merge, wire serialization, and receiver apply page-bounded", () => {
    const createStressWindow = () => {
      const created = createCodexHistoryItemWindow<CanonicalItem, RendererItem>({
        turnId: "turn-stress",
        limits: { maxItems: 64, maxApproximateBytes: 2_048 },
        olderBoundary: available(null),
      });
      if (!created.ok) throw new Error(created.error.message);
      return created.window;
    };
    let source = createStressWindow();
    let receiver = createStressWindow();
    let maxWireBytes = 0;
    let maxIndexNodeVisits = 0;

    for (let pageIndex = 0; pageIndex < 10_000; pageIndex += 1) {
      const itemId = `item-${pageIndex}`;
      const transition = prependCodexHistoryItemPage(source, {
        turnId: "turn-stress",
        segmentId: `segment-${pageIndex}`,
        items: {
          itemIds: [itemId],
          canonicalItems: [{ id: itemId, text: "canonical" }],
          rendererItems: [{ entryId: `entry-${pageIndex}`, text: "renderer" }],
        },
        approximateBytes: 32,
        olderCursorAfter: pageIndex === 9_999 ? null : `cursor-${pageIndex + 1}`,
      });
      if (!transition.ok) throw new Error(transition.error.message);
      source = transition.window;

      const encoded = JSON.stringify({
        wireSegment: transition.wireSegment,
        releasedSegmentIds: transition.releasedSegmentIds,
      });
      maxWireBytes = Math.max(maxWireBytes, encoded.length);
      maxIndexNodeVisits = Math.max(
        maxIndexNodeVisits,
        transition.work.itemIndexNodeVisits + transition.work.segmentIndexNodeVisits,
      );
      expect(transition.work.pageItemsVisited).toBe(1);
      expect(transition.work.pageRendererItemsVisited).toBe(1);
      expect(transition.work.releasedItemsVisited).toBeLessThanOrEqual(1);
      expect(transition.work.residentItemsMaterialized).toBe(0);
      expect(transition.work.wireValues).toBe(3);
      expect(transition.releasedSegmentIds.length).toBeLessThanOrEqual(1);
      expect(source.residency.itemCount).toBeLessThanOrEqual(64);
      expect(source.residency.approximateBytes).toBeLessThanOrEqual(2_048);

      const applied = applyCodexHistoryItemWindowMutation(receiver, {
        wireSegment: transition.wireSegment,
        releasedSegmentIds: transition.releasedSegmentIds,
      });
      if (!applied.ok) throw new Error(applied.error.message);
      receiver = applied.window;
      expect(applied.work.residentItemsMaterialized).toBe(0);
      expect(receiver.residency).toEqual(source.residency);
    }

    expect(maxWireBytes).toBeLessThan(600);
    expect(maxIndexNodeVisits).toBeLessThan(80);
    expect(source.residency).toEqual({
      segmentCount: 64,
      itemCount: 64,
      approximateBytes: 2_048,
      limitsSatisfied: true,
      protectedOverage: false,
    });
    expect(source.olderBoundary).toEqual({ status: "exhausted" });
    expect(source.newerBoundary).toEqual({ status: "opaque" });
    expect(receiver.olderBoundary).toEqual(source.olderBoundary);
    expect(receiver.newerBoundary).toEqual(source.newerBoundary);
    const materialized = materializeCodexHistoryItemWindow(source);
    expect(materialized.itemIds).toHaveLength(64);
    expect(materialized.itemIds[0]).toBe("item-9999");
    expect(materialized.itemIds.at(-1)).toBe("item-9936");
    expect(materialized.work.itemIdsVisited).toBe(64);
  });
});
