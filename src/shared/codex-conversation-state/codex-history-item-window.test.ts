import { describe, expect, it } from "vite-plus/test";
import {
  applyCodexHistoryItemWindowMutation,
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

  it("fails closed on foreign, duplicate, mismatched, and stalled pages", () => {
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
    ];

    expect(cases.map((result) => (result.ok ? "ok" : result.error.code))).toEqual([
      "foreignTurn",
      "duplicateSegment",
      "duplicateItem",
      "duplicateItem",
      "malformedIdentity",
      "cursorStalled",
    ]);
    expect(materializeCodexHistoryItemWindow(before).itemIds).toEqual(["resident"]);
    expect(before.olderBoundary).toEqual(available("cursor:before"));
  });

  it("advances an empty page cursor without adding a resident segment", () => {
    const before = createWindow({ seedSegments: [segment("seed", ["resident"])] });
    const result = prependCodexHistoryItemPage(before, {
      ...segment("empty", []),
      olderCursorAfter: "cursor:next",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.window.olderBoundary).toEqual(available("cursor:next"));
    expect(result.window.residency).toEqual(before.residency);
    expect(materializeCodexHistoryItemWindow(result.window).itemIds).toEqual(["resident"]);
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
      });
      maxWireBytes = Math.max(maxWireBytes, encoded.length);
      maxIndexNodeVisits = Math.max(
        maxIndexNodeVisits,
        transition.work.itemIndexNodeVisits + transition.work.segmentIndexNodeVisits,
      );
      expect(transition.work.pageItemsVisited).toBe(1);
      expect(transition.work.pageRendererItemsVisited).toBe(1);
      expect(transition.work.residentItemsMaterialized).toBe(0);
      expect(transition.work.wireValues).toBe(3);
      expect(source.residency.itemCount).toBe(pageIndex + 1);
      expect(source.residency.approximateBytes).toBe((pageIndex + 1) * 32);

      const applied = applyCodexHistoryItemWindowMutation(receiver, {
        wireSegment: transition.wireSegment,
      });
      if (!applied.ok) throw new Error(applied.error.message);
      receiver = applied.window;
      expect(applied.work.residentItemsMaterialized).toBe(0);
      expect(receiver.residency).toEqual(source.residency);
    }

    expect(maxWireBytes).toBeLessThan(600);
    expect(maxIndexNodeVisits).toBeLessThan(80);
    expect(source.residency).toEqual({
      segmentCount: 10_000,
      itemCount: 10_000,
      approximateBytes: 320_000,
    });
    expect(source.olderBoundary).toEqual({ status: "exhausted" });
    expect(source.newerBoundary).toEqual({ status: "exhausted" });
    expect(receiver.olderBoundary).toEqual(source.olderBoundary);
    expect(receiver.newerBoundary).toEqual(source.newerBoundary);
    const materialized = materializeCodexHistoryItemWindow(source);
    expect(materialized.itemIds).toHaveLength(10_000);
    expect(materialized.itemIds[0]).toBe("item-9999");
    expect(materialized.itemIds.at(-1)).toBe("item-0");
    expect(materialized.work.itemIdsVisited).toBe(10_000);
  });
});
