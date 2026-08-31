import { createHash } from "node:crypto";
import { assert, it } from "@effect/vitest";
import {
  applyCodexHistoryItemWindowMutation,
  createCodexHistoryItemWindow,
  DEFAULT_CODEX_HISTORY_ITEM_WINDOW_LIMITS,
  materializeCodexHistoryItemWindow,
  prependCodexHistoryItemPage,
  type CodexHistoryItemSegment,
  type CodexHistoryItemWindow,
  type CodexHistoryItemWindowWork,
} from "../../shared/codex-conversation-state/codex-history-item-window";

const TURN_ID = "turn-giant-item-window-performance";
const PAGE_ITEMS = 100;
const ITEM_APPROXIMATE_BYTES = 2 * 1024;
const PAGE_APPROXIMATE_BYTES = PAGE_ITEMS * ITEM_APPROXIMATE_BYTES;
const WIRE_MAX_BYTES = 384 * 1024;

interface CanonicalItem {
  readonly id: string;
  readonly text: string;
}

interface RendererItem {
  readonly entryId: string;
  readonly text: string;
}

interface ScaleMeasurement {
  readonly baseResidentItems: number;
  readonly mutationBytes: number;
  readonly mutationHash: string;
  readonly unchangedPayloadReads: number;
  readonly sourceWork: CodexHistoryItemWindowWork;
  readonly receiverWork: CodexHistoryItemWindowWork;
  readonly elapsedMs: number;
  readonly residentItemsAfter: number;
  readonly residentBytesAfter: number;
  readonly olderCursorAfter: string | null;
}

const available = (cursor: string | null) => ({ status: "available" as const, cursor });

const itemId = (prefix: string, index: number): string =>
  `${prefix}:${index.toString().padStart(5, "0")}`;

const segment = (input: {
  readonly segmentId: string;
  readonly prefix: string;
  readonly itemCount: number;
  readonly approximateBytes?: number;
  readonly onPayloadRead?: () => void;
}): CodexHistoryItemSegment<CanonicalItem, RendererItem> => {
  const itemIds = Array.from({ length: input.itemCount }, (_, index) =>
    itemId(input.prefix, index),
  );
  return {
    segmentId: input.segmentId,
    turnId: TURN_ID,
    items: {
      itemIds,
      canonicalItems: itemIds.map((id) => {
        const value = { id } as CanonicalItem;
        Object.defineProperty(value, "text", {
          enumerable: true,
          get: () => {
            input.onPayloadRead?.();
            return `canonical:${id}:${"c".repeat(1_024)}`;
          },
        });
        return value;
      }),
      rendererItems: itemIds.map((id) => {
        const value = { entryId: `entry:${id}` } as RendererItem;
        Object.defineProperty(value, "text", {
          enumerable: true,
          get: () => {
            input.onPayloadRead?.();
            return `renderer:${id}:${"r".repeat(1_024)}`;
          },
        });
        return value;
      }),
    },
    approximateBytes: input.approximateBytes ?? input.itemCount * ITEM_APPROXIMATE_BYTES,
  };
};

const createWindow = (input: {
  readonly maxItems: number;
  readonly maxApproximateBytes: number;
  readonly seedSegments: readonly CodexHistoryItemSegment<CanonicalItem, RendererItem>[];
}): CodexHistoryItemWindow<CanonicalItem, RendererItem> => {
  const created = createCodexHistoryItemWindow<CanonicalItem, RendererItem>({
    turnId: TURN_ID,
    limits: {
      maxItems: input.maxItems,
      maxApproximateBytes: input.maxApproximateBytes,
    },
    olderBoundary: available("items:before-page"),
    seedSegments: input.seedSegments,
  });
  if (!created.ok) throw new Error(created.error.message);
  return created.window;
};

const pageSegment = (): CodexHistoryItemSegment<CanonicalItem, RendererItem> =>
  segment({
    segmentId: "older-page",
    prefix: "older-page",
    itemCount: PAGE_ITEMS,
  });

const workUnits = (work: CodexHistoryItemWindowWork): number =>
  work.pageItemsVisited +
  work.pageRendererItemsVisited +
  work.releasedSegmentsVisited +
  work.releasedItemsVisited +
  work.itemIndexNodeVisits +
  work.segmentIndexNodeVisits +
  work.segmentTreeNodeVisits +
  work.wireValues;

const measureScale = (baseResidentItems: number): ScaleMeasurement => {
  let unchangedPayloadReads = 0;
  const resident = segment({
    segmentId: "resident-base",
    prefix: `resident-${baseResidentItems}`,
    itemCount: baseResidentItems,
    onPayloadRead: () => {
      unchangedPayloadReads += 1;
    },
  });
  const limits = {
    maxItems: baseResidentItems + PAGE_ITEMS,
    maxApproximateBytes: (baseResidentItems + PAGE_ITEMS) * ITEM_APPROXIMATE_BYTES,
  };
  const source = createWindow({ ...limits, seedSegments: [resident] });
  const receiver = createWindow({ ...limits, seedSegments: [resident] });
  unchangedPayloadReads = 0;

  const startedAt = process.hrtime.bigint();
  const transition = prependCodexHistoryItemPage(source, {
    ...pageSegment(),
    olderCursorAfter: "items:after-one-page",
  });
  if (!transition.ok) throw new Error(transition.error.message);
  const mutation = {
    wireSegment: transition.wireSegment,
    releasedSegmentIds: transition.releasedSegmentIds,
  };
  const encoded = JSON.stringify(mutation);
  const mutationHash = createHash("sha256").update(encoded).digest("hex");
  const applied = applyCodexHistoryItemWindowMutation(receiver, mutation);
  if (!applied.ok) throw new Error(applied.error.message);
  const elapsed = Number(process.hrtime.bigint() - startedAt) / 1_000_000;

  const olderBoundaryBefore = transition.wireSegment.olderBoundaryBefore;
  assert.strictEqual(olderBoundaryBefore.status, "available");
  if (olderBoundaryBefore.status !== "available") {
    throw new Error("Older page mutation lost its available input boundary");
  }
  assert.strictEqual(olderBoundaryBefore.cursor, "items:before-page");
  assert.deepEqual(transition.wireSegment.olderBoundaryAfter, available("items:after-one-page"));
  assert.deepEqual(transition.window.olderBoundary, available("items:after-one-page"));
  assert.deepEqual(applied.window.olderBoundary, transition.window.olderBoundary);
  assert.deepEqual(applied.window.residency, transition.window.residency);
  assert.strictEqual(transition.releasedSegmentIds.length, 0);
  assert.strictEqual(transition.work.pageItemsVisited, PAGE_ITEMS);
  assert.strictEqual(transition.work.pageRendererItemsVisited, PAGE_ITEMS);
  assert.strictEqual(transition.work.residentItemsMaterialized, 0);
  assert.strictEqual(applied.work.residentItemsMaterialized, 0);
  assert.strictEqual(unchangedPayloadReads, 0);
  assert.isAtMost(encoded.length, WIRE_MAX_BYTES);

  return {
    baseResidentItems,
    mutationBytes: encoded.length,
    mutationHash,
    unchangedPayloadReads,
    sourceWork: transition.work,
    receiverWork: applied.work,
    elapsedMs: elapsed,
    residentItemsAfter: transition.window.residency.itemCount,
    residentBytesAfter: transition.window.residency.approximateBytes,
    olderCursorAfter:
      transition.window.olderBoundary.status === "available"
        ? transition.window.olderBoundary.cursor
        : null,
  };
};

it("keeps prepend mutation and hash page-local over 100 versus 10k resident items", () => {
  const measurements = [100, 10_000].map(measureScale);
  const small = measurements[0];
  const large = measurements[1];
  if (!small || !large) throw new Error("Missing item-window scale measurement");

  assert.strictEqual(small.mutationBytes, large.mutationBytes);
  assert.strictEqual(small.mutationHash, large.mutationHash);
  assert.strictEqual(small.unchangedPayloadReads, 0);
  assert.strictEqual(large.unchangedPayloadReads, 0);
  assert.isAtMost(workUnits(large.sourceWork), workUnits(small.sourceWork) * 2.5);
  assert.isAtMost(workUnits(large.receiverWork), workUnits(small.receiverWork) * 2.5);
  assert.strictEqual(small.residentItemsAfter, 200);
  assert.strictEqual(large.residentItemsAfter, 10_100);
  assert.strictEqual(small.olderCursorAfter, "items:after-one-page");
  assert.strictEqual(large.olderCursorAfter, "items:after-one-page");

  process.stdout.write(
    `\nNODEX_LAZY_HISTORY_ACCEPTANCE ${JSON.stringify({
      kind: "giant-turn-page-local-mutation",
      pageItems: PAGE_ITEMS,
      wireMaxBytes: WIRE_MAX_BYTES,
      measurements: measurements.map((measurement) => ({
        ...measurement,
        sourceWorkUnits: workUnits(measurement.sourceWork),
        receiverWorkUnits: workUnits(measurement.receiverWork),
      })),
    })}\n`,
  );
});

it("bounds a giant Turn independently by resident item count and bytes", () => {
  const countSeed = Array.from({ length: 5 }, (_, index) =>
    segment({
      segmentId: `count-seed-${index}`,
      prefix: `count-seed-${index}`,
      itemCount: 100,
      approximateBytes: 100 * 32,
    }),
  );
  const countSource = createWindow({
    maxItems: 500,
    maxApproximateBytes: 1 * 1024 * 1024,
    seedSegments: countSeed,
  });
  const countReceiver = createWindow({
    maxItems: 500,
    maxApproximateBytes: 1 * 1024 * 1024,
    seedSegments: countSeed,
  });
  const countTransition = prependCodexHistoryItemPage(countSource, {
    ...pageSegment(),
    approximateBytes: PAGE_ITEMS * 32,
    olderCursorAfter: "items:count-next",
  });
  if (!countTransition.ok) throw new Error(countTransition.error.message);
  const countApplied = applyCodexHistoryItemWindowMutation(countReceiver, {
    wireSegment: countTransition.wireSegment,
    releasedSegmentIds: countTransition.releasedSegmentIds,
  });
  if (!countApplied.ok) throw new Error(countApplied.error.message);

  const byteSeed = Array.from({ length: 4 }, (_, index) =>
    segment({
      segmentId: `byte-seed-${index}`,
      prefix: `byte-seed-${index}`,
      itemCount: 100,
      approximateBytes: PAGE_APPROXIMATE_BYTES,
    }),
  );
  const byteLimit = 4 * PAGE_APPROXIMATE_BYTES;
  const byteSource = createWindow({
    maxItems: 1_000,
    maxApproximateBytes: byteLimit,
    seedSegments: byteSeed,
  });
  const byteReceiver = createWindow({
    maxItems: 1_000,
    maxApproximateBytes: byteLimit,
    seedSegments: byteSeed,
  });
  const byteTransition = prependCodexHistoryItemPage(byteSource, {
    ...pageSegment(),
    olderCursorAfter: "items:byte-next",
  });
  if (!byteTransition.ok) throw new Error(byteTransition.error.message);
  const byteApplied = applyCodexHistoryItemWindowMutation(byteReceiver, {
    wireSegment: byteTransition.wireSegment,
    releasedSegmentIds: byteTransition.releasedSegmentIds,
  });
  if (!byteApplied.ok) throw new Error(byteApplied.error.message);

  const defaultPageBytes = 1_600_000;
  const defaultSeed = Array.from({ length: 5 }, (_, index) =>
    segment({
      segmentId: `default-seed-${index}`,
      prefix: `default-seed-${index}`,
      itemCount: 100,
      approximateBytes:
        index === 4
          ? defaultPageBytes
          : (DEFAULT_CODEX_HISTORY_ITEM_WINDOW_LIMITS.maxApproximateBytes - defaultPageBytes) / 4,
    }),
  );
  const defaultCreated = createCodexHistoryItemWindow<CanonicalItem, RendererItem>({
    turnId: TURN_ID,
    olderBoundary: available("items:before-page"),
    seedSegments: defaultSeed,
  });
  if (!defaultCreated.ok) throw new Error(defaultCreated.error.message);
  const defaultTransition = prependCodexHistoryItemPage(defaultCreated.window, {
    ...pageSegment(),
    approximateBytes: defaultPageBytes,
    olderCursorAfter: "items:default-next",
  });
  if (!defaultTransition.ok) throw new Error(defaultTransition.error.message);

  assert.deepEqual(countTransition.releasedSegmentIds, ["count-seed-4"]);
  assert.deepEqual(countTransition.window.residency, {
    segmentCount: 5,
    itemCount: 500,
    approximateBytes: 16_000,
    limitsSatisfied: true,
    protectedOverage: false,
  });
  assert.deepEqual(countTransition.window.olderBoundary, available("items:count-next"));
  assert.deepEqual(countTransition.window.newerBoundary, { status: "opaque" });
  assert.deepEqual(countApplied.window.residency, countTransition.window.residency);
  assert.deepEqual(countApplied.window.olderBoundary, countTransition.window.olderBoundary);
  assert.deepEqual(countApplied.window.newerBoundary, countTransition.window.newerBoundary);

  assert.deepEqual(byteTransition.releasedSegmentIds, ["byte-seed-3"]);
  assert.deepEqual(byteTransition.window.residency, {
    segmentCount: 4,
    itemCount: 400,
    approximateBytes: byteLimit,
    limitsSatisfied: true,
    protectedOverage: false,
  });
  assert.deepEqual(byteTransition.window.olderBoundary, available("items:byte-next"));
  assert.deepEqual(byteTransition.window.newerBoundary, { status: "opaque" });
  assert.deepEqual(byteApplied.window.residency, byteTransition.window.residency);
  assert.deepEqual(byteApplied.window.olderBoundary, byteTransition.window.olderBoundary);
  assert.deepEqual(byteApplied.window.newerBoundary, byteTransition.window.newerBoundary);
  assert.strictEqual(countTransition.work.residentItemsMaterialized, 0);
  assert.strictEqual(byteTransition.work.residentItemsMaterialized, 0);

  assert.deepEqual(defaultCreated.window.limits, DEFAULT_CODEX_HISTORY_ITEM_WINDOW_LIMITS);
  assert.deepEqual(defaultTransition.releasedSegmentIds, ["default-seed-4"]);
  assert.deepEqual(defaultTransition.window.residency, {
    segmentCount: 5,
    itemCount: DEFAULT_CODEX_HISTORY_ITEM_WINDOW_LIMITS.maxItems,
    approximateBytes: DEFAULT_CODEX_HISTORY_ITEM_WINDOW_LIMITS.maxApproximateBytes,
    limitsSatisfied: true,
    protectedOverage: false,
  });
  assert.deepEqual(defaultTransition.window.olderBoundary, available("items:default-next"));
  assert.deepEqual(defaultTransition.window.newerBoundary, { status: "opaque" });
  assert.strictEqual(defaultTransition.work.residentItemsMaterialized, 0);

  const countMaterialized = materializeCodexHistoryItemWindow(countTransition.window);
  const byteMaterialized = materializeCodexHistoryItemWindow(byteTransition.window);
  assert.strictEqual(countMaterialized.itemIds.length, 500);
  assert.strictEqual(byteMaterialized.itemIds.length, 400);
  assert.isTrue(countMaterialized.itemIds[0]?.startsWith("older-page:"));
  assert.isTrue(byteMaterialized.itemIds[0]?.startsWith("older-page:"));

  process.stdout.write(
    `\nNODEX_LAZY_HISTORY_ACCEPTANCE ${JSON.stringify({
      kind: "giant-turn-residency",
      countPressure: {
        limits: countSource.limits,
        residency: countTransition.window.residency,
        releasedSegmentIds: countTransition.releasedSegmentIds,
        olderBoundary: countTransition.window.olderBoundary,
        newerBoundary: countTransition.window.newerBoundary,
      },
      bytePressure: {
        limits: byteSource.limits,
        residency: byteTransition.window.residency,
        releasedSegmentIds: byteTransition.releasedSegmentIds,
        olderBoundary: byteTransition.window.olderBoundary,
        newerBoundary: byteTransition.window.newerBoundary,
      },
      defaultSimultaneousPressure: {
        limits: defaultCreated.window.limits,
        residency: defaultTransition.window.residency,
        releasedSegmentIds: defaultTransition.releasedSegmentIds,
        olderBoundary: defaultTransition.window.olderBoundary,
        newerBoundary: defaultTransition.window.newerBoundary,
      },
    })}\n`,
  );
});
