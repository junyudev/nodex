/**
 * One Turn's loaded item history as independently transferable page segments.
 *
 * The window is an in-process value rather than a snapshot shape. Ordinary page admission never
 * materializes the accumulated Turn: it indexes the incoming page and prepends one segment, then
 * retains every loaded segment. Callers cross the explicit materialization seam
 * only when rebuilding a canonical/renderer view.
 */

export interface CodexHistoryItemIdentity {
  readonly id: string;
}

export type CodexHistoryItemOlderBoundary =
  | {
      /** `null` is the app-server's valid initial cursor, not exhaustion. */
      readonly status: "available";
      readonly cursor: string | null;
    }
  | {
      readonly status: "exhausted";
    }
  | {
      /** The older boundary has no proven server cursor. */
      readonly status: "opaque";
    };

export type CodexHistoryItemNewerBoundary =
  | {
      /** Cursor to pass to `thread/items/list` while walking toward newer items. */
      readonly status: "available";
      readonly cursor: string;
    }
  | {
      /** The resident suffix is still contiguous with the Turn's newest item. */
      readonly status: "exhausted";
    }
  | {
      /** The newer boundary has no proven server cursor. */
      readonly status: "opaque";
    };

export interface CodexHistoryItemSegmentItems<
  TCanonicalItem extends CodexHistoryItemIdentity,
  TRendererItem,
> {
  /** Stable protocol identities in the same order as `canonicalItems`. */
  readonly itemIds: readonly string[];
  readonly canonicalItems: readonly TCanonicalItem[];
  /** A canonical item may project to zero, one, or several renderer rows. */
  readonly rendererItems: readonly TRendererItem[];
}

export interface CodexHistoryItemSegment<
  TCanonicalItem extends CodexHistoryItemIdentity,
  TRendererItem,
> {
  readonly segmentId: string;
  readonly turnId: string;
  /**
   * Exact app-server cursors adjacent to this physical page. A string reloads the next page in
   * that direction, `null` means the server reported that edge exhausted, and `undefined` means
   * a legacy seed has no trustworthy cursor for that edge.
   */
  readonly olderCursor?: string | null;
  readonly newerCursor?: string | null;
  readonly items: CodexHistoryItemSegmentItems<TCanonicalItem, TRendererItem>;
  /** Encoded bytes for both canonical and renderer projections, charged once at admission. */
  readonly approximateBytes: number;
}

/** The complete page-local payload. It never contains previously resident items. */
export interface CodexHistoryItemWireSegment<
  TCanonicalItem extends CodexHistoryItemIdentity,
  TRendererItem,
> extends CodexHistoryItemSegment<TCanonicalItem, TRendererItem> {
  readonly direction: "older" | "newer";
  readonly olderBoundaryBefore: CodexHistoryItemOlderBoundary;
  readonly olderBoundaryAfter: CodexHistoryItemOlderBoundary;
  readonly newerBoundaryBefore: CodexHistoryItemNewerBoundary;
  readonly newerBoundaryAfter: CodexHistoryItemNewerBoundary;
}

export interface CodexHistoryItemWindowResidency {
  readonly segmentCount: number;
  readonly itemCount: number;
  readonly approximateBytes: number;
  /** False only when one indivisible physical page is the minimum progress unit. */
}

/** Deterministic evidence that ordinary admission/apply did not flatten accumulated history. */
export interface CodexHistoryItemWindowWork {
  readonly pageItemsVisited: number;
  readonly pageRendererItemsVisited: number;
  readonly itemIndexNodeVisits: number;
  readonly segmentIndexNodeVisits: number;
  readonly segmentTreeNodeVisits: number;
  readonly residentItemsMaterialized: 0;
  /** Values reachable from the page-local wire segment, excluding scalar metadata. */
  readonly wireValues: number;
}

export interface CodexHistoryItemWindowMaterialization<
  TCanonicalItem extends CodexHistoryItemIdentity,
  TRendererItem,
> {
  /** Chronological order: oldest resident segment first. */
  readonly segments: readonly CodexHistoryItemSegment<TCanonicalItem, TRendererItem>[];
  readonly itemIds: readonly string[];
  readonly canonicalItems: readonly TCanonicalItem[];
  readonly rendererItems: readonly TRendererItem[];
  readonly work: {
    readonly segmentsVisited: number;
    readonly itemIdsVisited: number;
    readonly canonicalItemsVisited: number;
    readonly rendererItemsVisited: number;
  };
}

export type CodexHistoryItemWindowErrorCode =
  | "malformedLimits"
  | "malformedBoundary"
  | "malformedIdentity"
  | "malformedSegment"
  | "foreignTurn"
  | "duplicateSegment"
  | "duplicateItem"
  | "pageLimitExceeded"
  | "historyExhausted"
  | "cursorStalled"
  | "staleBoundary";

export interface CodexHistoryItemWindowError {
  readonly _tag: "CodexHistoryItemWindowError";
  readonly code: CodexHistoryItemWindowErrorCode;
  readonly message: string;
}

export interface CreateCodexHistoryItemWindowInput<
  TCanonicalItem extends CodexHistoryItemIdentity,
  TRendererItem,
> {
  readonly turnId: string;
  readonly olderBoundary: CodexHistoryItemOlderBoundary;
  readonly newerBoundary?: CodexHistoryItemNewerBoundary;
  /** Already-bounded segments in chronological order. */
  readonly seedSegments?: readonly CodexHistoryItemSegment<TCanonicalItem, TRendererItem>[];
}

export interface PrependCodexHistoryItemPageInput<
  TCanonicalItem extends CodexHistoryItemIdentity,
  TRendererItem,
> {
  readonly turnId: string;
  readonly segmentId: string;
  readonly items: CodexHistoryItemSegmentItems<TCanonicalItem, TRendererItem>;
  readonly approximateBytes: number;
  /** The exact `nextCursor` returned for this physical older-page request. */
  readonly olderCursorAfter: string | null;
  /** Exact reverse cursor returned for this physical page (inclusive-anchor semantics). */
  readonly newerCursor?: string | null;
}

export interface AppendCodexHistoryItemPageInput<
  TCanonicalItem extends CodexHistoryItemIdentity,
  TRendererItem,
> {
  readonly turnId: string;
  readonly segmentId: string;
  readonly items: CodexHistoryItemSegmentItems<TCanonicalItem, TRendererItem>;
  readonly approximateBytes: number;
  /** The exact `nextCursor` returned for this physical newer-page request. */
  readonly newerCursorAfter: string | null;
  /** Exact reverse cursor returned for this physical page (inclusive-anchor semantics). */
  readonly olderCursor?: string | null;
}

export interface CodexHistoryItemWindowMutation<
  TCanonicalItem extends CodexHistoryItemIdentity,
  TRendererItem,
> {
  readonly wireSegment: CodexHistoryItemWireSegment<TCanonicalItem, TRendererItem>;
}

export type CodexHistoryItemWindowTransitionResult<
  TCanonicalItem extends CodexHistoryItemIdentity,
  TRendererItem,
> =
  | {
      readonly ok: true;
      readonly window: CodexHistoryItemWindow<TCanonicalItem, TRendererItem>;
      readonly wireSegment: CodexHistoryItemWireSegment<TCanonicalItem, TRendererItem>;
      readonly work: CodexHistoryItemWindowWork;
    }
  | {
      readonly ok: false;
      readonly error: CodexHistoryItemWindowError;
    };

export type ApplyCodexHistoryItemWindowMutationResult<
  TCanonicalItem extends CodexHistoryItemIdentity,
  TRendererItem,
> =
  | {
      readonly ok: true;
      readonly window: CodexHistoryItemWindow<TCanonicalItem, TRendererItem>;
      readonly work: CodexHistoryItemWindowWork;
    }
  | {
      readonly ok: false;
      readonly error: CodexHistoryItemWindowError;
    };

export type CreateCodexHistoryItemWindowResult<
  TCanonicalItem extends CodexHistoryItemIdentity,
  TRendererItem,
> =
  | {
      readonly ok: true;
      readonly window: CodexHistoryItemWindow<TCanonicalItem, TRendererItem>;
    }
  | {
      readonly ok: false;
      readonly error: CodexHistoryItemWindowError;
    };

interface StringSetNode {
  readonly key: string;
  readonly left: StringSetNode | null;
  readonly right: StringSetNode | null;
  readonly height: number;
}

interface SegmentTreeNode<TCanonicalItem extends CodexHistoryItemIdentity, TRendererItem> {
  readonly order: number;
  readonly segment: CodexHistoryItemSegment<TCanonicalItem, TRendererItem>;
  readonly left: SegmentTreeNode<TCanonicalItem, TRendererItem> | null;
  readonly right: SegmentTreeNode<TCanonicalItem, TRendererItem> | null;
  readonly height: number;
  readonly segmentCount: number;
  readonly itemCount: number;
  readonly approximateBytes: number;
}

interface CodexHistoryItemWindowState<
  TCanonicalItem extends CodexHistoryItemIdentity,
  TRendererItem,
> {
  readonly segments: SegmentTreeNode<TCanonicalItem, TRendererItem> | null;
  readonly itemIds: StringSetNode | null;
  readonly segmentIds: StringSetNode | null;
  readonly nextOlderOrder: number;
  readonly nextNewerOrder: number;
}

const codexHistoryItemWindowState = Symbol("CodexHistoryItemWindowState");

export interface CodexHistoryItemWindow<
  TCanonicalItem extends CodexHistoryItemIdentity,
  TRendererItem,
> {
  readonly turnId: string;
  readonly olderBoundary: CodexHistoryItemOlderBoundary;
  readonly newerBoundary: CodexHistoryItemNewerBoundary;
  readonly residency: CodexHistoryItemWindowResidency;
  readonly [codexHistoryItemWindowState]: CodexHistoryItemWindowState<
    TCanonicalItem,
    TRendererItem
  >;
}

interface MutableWork {
  pageItemsVisited: number;
  pageRendererItemsVisited: number;
  itemIndexNodeVisits: number;
  segmentIndexNodeVisits: number;
  segmentTreeNodeVisits: number;
  wireValues: number;
}

function itemWindowError(
  code: CodexHistoryItemWindowErrorCode,
  message: string,
): CodexHistoryItemWindowError {
  return { _tag: "CodexHistoryItemWindowError", code, message };
}

function mutableWork(): MutableWork {
  return {
    pageItemsVisited: 0,
    pageRendererItemsVisited: 0,
    itemIndexNodeVisits: 0,
    segmentIndexNodeVisits: 0,
    segmentTreeNodeVisits: 0,
    wireValues: 0,
  };
}

function freezeWork(work: MutableWork): CodexHistoryItemWindowWork {
  return Object.freeze({
    ...work,
    residentItemsMaterialized: 0 as const,
  });
}

function isNonEmptyIdentity(value: string): boolean {
  return value.trim().length > 0;
}

function validateOlderBoundary(
  boundary: CodexHistoryItemOlderBoundary,
): CodexHistoryItemWindowError | null {
  if (boundary.status !== "available") return null;
  if (boundary.cursor === null || isNonEmptyIdentity(boundary.cursor)) return null;
  return itemWindowError("malformedBoundary", "Available item cursor must be null or non-empty");
}

function sameOlderBoundary(
  left: CodexHistoryItemOlderBoundary,
  right: CodexHistoryItemOlderBoundary,
): boolean {
  if (left.status !== right.status) return false;
  if (left.status !== "available" || right.status !== "available") return true;
  return left.cursor === right.cursor;
}

function sameNewerBoundary(
  left: CodexHistoryItemNewerBoundary,
  right: CodexHistoryItemNewerBoundary,
): boolean {
  if (left.status !== right.status) return false;
  if (left.status !== "available" || right.status !== "available") return true;
  return left.cursor === right.cursor;
}

function availableOlderBoundary(
  cursor: string | null,
): Extract<CodexHistoryItemOlderBoundary, { status: "available" }> {
  return Object.freeze({ status: "available", cursor });
}

function boundaryAfter(olderCursorAfter: string | null): CodexHistoryItemOlderBoundary {
  return olderCursorAfter === null
    ? Object.freeze({ status: "exhausted" as const })
    : availableOlderBoundary(olderCursorAfter);
}

function newerBoundaryAfter(newerCursorAfter: string | null): CodexHistoryItemNewerBoundary {
  return newerCursorAfter === null
    ? Object.freeze({ status: "exhausted" as const })
    : Object.freeze({ status: "available" as const, cursor: newerCursorAfter });
}

function stringSetHeight(node: StringSetNode | null): number {
  return node?.height ?? 0;
}

function makeStringSetNode(
  key: string,
  left: StringSetNode | null,
  right: StringSetNode | null,
): StringSetNode {
  return {
    key,
    left,
    right,
    height: Math.max(stringSetHeight(left), stringSetHeight(right)) + 1,
  };
}

function rotateStringSetLeft(node: StringSetNode): StringSetNode {
  const right = node.right;
  if (!right) return node;
  return makeStringSetNode(
    right.key,
    makeStringSetNode(node.key, node.left, right.left),
    right.right,
  );
}

function rotateStringSetRight(node: StringSetNode): StringSetNode {
  const left = node.left;
  if (!left) return node;
  return makeStringSetNode(
    left.key,
    left.left,
    makeStringSetNode(node.key, left.right, node.right),
  );
}

function balanceStringSet(node: StringSetNode): StringSetNode {
  const balance = stringSetHeight(node.left) - stringSetHeight(node.right);
  if (balance > 1) {
    const left = node.left;
    if (!left) return node;
    const nextLeft =
      stringSetHeight(left.left) < stringSetHeight(left.right) ? rotateStringSetLeft(left) : left;
    return rotateStringSetRight(makeStringSetNode(node.key, nextLeft, node.right));
  }
  if (balance < -1) {
    const right = node.right;
    if (!right) return node;
    const nextRight =
      stringSetHeight(right.right) < stringSetHeight(right.left)
        ? rotateStringSetRight(right)
        : right;
    return rotateStringSetLeft(makeStringSetNode(node.key, node.left, nextRight));
  }
  return node;
}

function stringSetHas(node: StringSetNode | null, key: string, visit: () => void): boolean {
  let current = node;
  while (current) {
    visit();
    if (key === current.key) return true;
    current = key < current.key ? current.left : current.right;
  }
  return false;
}

function stringSetInsert(
  node: StringSetNode | null,
  key: string,
  visit: () => void,
): StringSetNode {
  if (!node) return makeStringSetNode(key, null, null);
  visit();
  if (key < node.key) {
    return balanceStringSet(
      makeStringSetNode(node.key, stringSetInsert(node.left, key, visit), node.right),
    );
  }
  return balanceStringSet(
    makeStringSetNode(node.key, node.left, stringSetInsert(node.right, key, visit)),
  );
}

function segmentTreeHeight<TCanonicalItem extends CodexHistoryItemIdentity, TRendererItem>(
  node: SegmentTreeNode<TCanonicalItem, TRendererItem> | null,
): number {
  return node?.height ?? 0;
}

function makeSegmentTreeNode<TCanonicalItem extends CodexHistoryItemIdentity, TRendererItem>(
  order: number,
  segment: CodexHistoryItemSegment<TCanonicalItem, TRendererItem>,
  left: SegmentTreeNode<TCanonicalItem, TRendererItem> | null,
  right: SegmentTreeNode<TCanonicalItem, TRendererItem> | null,
): SegmentTreeNode<TCanonicalItem, TRendererItem> {
  return {
    order,
    segment,
    left,
    right,
    height: Math.max(segmentTreeHeight(left), segmentTreeHeight(right)) + 1,
    segmentCount: (left?.segmentCount ?? 0) + (right?.segmentCount ?? 0) + 1,
    itemCount: (left?.itemCount ?? 0) + (right?.itemCount ?? 0) + segment.items.itemIds.length,
    approximateBytes:
      (left?.approximateBytes ?? 0) + (right?.approximateBytes ?? 0) + segment.approximateBytes,
  };
}

function rotateSegmentTreeLeft<TCanonicalItem extends CodexHistoryItemIdentity, TRendererItem>(
  node: SegmentTreeNode<TCanonicalItem, TRendererItem>,
): SegmentTreeNode<TCanonicalItem, TRendererItem> {
  const right = node.right;
  if (!right) return node;
  return makeSegmentTreeNode(
    right.order,
    right.segment,
    makeSegmentTreeNode(node.order, node.segment, node.left, right.left),
    right.right,
  );
}

function rotateSegmentTreeRight<TCanonicalItem extends CodexHistoryItemIdentity, TRendererItem>(
  node: SegmentTreeNode<TCanonicalItem, TRendererItem>,
): SegmentTreeNode<TCanonicalItem, TRendererItem> {
  const left = node.left;
  if (!left) return node;
  return makeSegmentTreeNode(
    left.order,
    left.segment,
    left.left,
    makeSegmentTreeNode(node.order, node.segment, left.right, node.right),
  );
}

function balanceSegmentTree<TCanonicalItem extends CodexHistoryItemIdentity, TRendererItem>(
  node: SegmentTreeNode<TCanonicalItem, TRendererItem>,
): SegmentTreeNode<TCanonicalItem, TRendererItem> {
  const balance = segmentTreeHeight(node.left) - segmentTreeHeight(node.right);
  if (balance > 1) {
    const left = node.left;
    if (!left) return node;
    const nextLeft =
      segmentTreeHeight(left.left) < segmentTreeHeight(left.right)
        ? rotateSegmentTreeLeft(left)
        : left;
    return rotateSegmentTreeRight(
      makeSegmentTreeNode(node.order, node.segment, nextLeft, node.right),
    );
  }
  if (balance < -1) {
    const right = node.right;
    if (!right) return node;
    const nextRight =
      segmentTreeHeight(right.right) < segmentTreeHeight(right.left)
        ? rotateSegmentTreeRight(right)
        : right;
    return rotateSegmentTreeLeft(
      makeSegmentTreeNode(node.order, node.segment, node.left, nextRight),
    );
  }
  return node;
}

function segmentTreeInsert<TCanonicalItem extends CodexHistoryItemIdentity, TRendererItem>(
  node: SegmentTreeNode<TCanonicalItem, TRendererItem> | null,
  order: number,
  segment: CodexHistoryItemSegment<TCanonicalItem, TRendererItem>,
  visit: () => void,
): SegmentTreeNode<TCanonicalItem, TRendererItem> {
  if (!node) return makeSegmentTreeNode(order, segment, null, null);
  visit();
  if (order < node.order) {
    return balanceSegmentTree(
      makeSegmentTreeNode(
        node.order,
        node.segment,
        segmentTreeInsert(node.left, order, segment, visit),
        node.right,
      ),
    );
  }
  return balanceSegmentTree(
    makeSegmentTreeNode(
      node.order,
      node.segment,
      node.left,
      segmentTreeInsert(node.right, order, segment, visit),
    ),
  );
}

function buildSegmentTree<TCanonicalItem extends CodexHistoryItemIdentity, TRendererItem>(
  segments: readonly CodexHistoryItemSegment<TCanonicalItem, TRendererItem>[],
  start: number,
  end: number,
): SegmentTreeNode<TCanonicalItem, TRendererItem> | null {
  if (start >= end) return null;
  const middle = start + Math.floor((end - start) / 2);
  const segment = segments[middle];
  if (!segment) return null;
  return makeSegmentTreeNode(
    middle,
    segment,
    buildSegmentTree(segments, start, middle),
    buildSegmentTree(segments, middle + 1, end),
  );
}

function copySegmentItems<TCanonicalItem extends CodexHistoryItemIdentity, TRendererItem>(
  items: CodexHistoryItemSegmentItems<TCanonicalItem, TRendererItem>,
): CodexHistoryItemSegmentItems<TCanonicalItem, TRendererItem> {
  return Object.freeze({
    itemIds: Object.freeze([...items.itemIds]),
    canonicalItems: Object.freeze([...items.canonicalItems]),
    rendererItems: Object.freeze([...items.rendererItems]),
  });
}

function copySegment<TCanonicalItem extends CodexHistoryItemIdentity, TRendererItem>(
  segment: CodexHistoryItemSegment<TCanonicalItem, TRendererItem>,
): CodexHistoryItemSegment<TCanonicalItem, TRendererItem> {
  return Object.freeze({
    segmentId: segment.segmentId,
    turnId: segment.turnId,
    ...(segment.olderCursor !== undefined ? { olderCursor: segment.olderCursor } : {}),
    ...(segment.newerCursor !== undefined ? { newerCursor: segment.newerCursor } : {}),
    items: copySegmentItems(segment.items),
    approximateBytes: segment.approximateBytes,
  });
}

function validateSegmentShape<TCanonicalItem extends CodexHistoryItemIdentity, TRendererItem>(
  segment: CodexHistoryItemSegment<TCanonicalItem, TRendererItem>,
): CodexHistoryItemWindowError | null {
  if (!isNonEmptyIdentity(segment.segmentId) || !isNonEmptyIdentity(segment.turnId)) {
    return itemWindowError("malformedIdentity", "Segment and Turn identities must be non-empty");
  }
  if (!Number.isSafeInteger(segment.approximateBytes) || segment.approximateBytes < 0) {
    return itemWindowError(
      "malformedSegment",
      `Segment '${segment.segmentId}' has invalid approximate bytes`,
    );
  }
  if (
    (typeof segment.olderCursor === "string" && !isNonEmptyIdentity(segment.olderCursor)) ||
    (typeof segment.newerCursor === "string" && !isNonEmptyIdentity(segment.newerCursor))
  ) {
    return itemWindowError(
      "malformedBoundary",
      `Segment '${segment.segmentId}' has an empty physical-page cursor`,
    );
  }
  if (segment.items.itemIds.length !== segment.items.canonicalItems.length) {
    return itemWindowError(
      "malformedSegment",
      `Segment '${segment.segmentId}' must pair every item id with one canonical item`,
    );
  }
  for (let index = 0; index < segment.items.itemIds.length; index += 1) {
    const itemId = segment.items.itemIds[index];
    const canonicalItem = segment.items.canonicalItems[index];
    if (!itemId || !isNonEmptyIdentity(itemId) || canonicalItem?.id !== itemId) {
      return itemWindowError(
        "malformedIdentity",
        `Segment '${segment.segmentId}' has a mismatched canonical item identity`,
      );
    }
  }
  return null;
}

function residency<TCanonicalItem extends CodexHistoryItemIdentity, TRendererItem>(
  root: SegmentTreeNode<TCanonicalItem, TRendererItem> | null,
): CodexHistoryItemWindowResidency {
  const itemCount = root?.itemCount ?? 0;
  const approximateBytes = root?.approximateBytes ?? 0;
  return Object.freeze({
    segmentCount: root?.segmentCount ?? 0,
    itemCount,
    approximateBytes,
  });
}

function createWindowValue<TCanonicalItem extends CodexHistoryItemIdentity, TRendererItem>(input: {
  readonly turnId: string;
  readonly olderBoundary: CodexHistoryItemOlderBoundary;
  readonly newerBoundary: CodexHistoryItemNewerBoundary;
  readonly state: CodexHistoryItemWindowState<TCanonicalItem, TRendererItem>;
}): CodexHistoryItemWindow<TCanonicalItem, TRendererItem> {
  const window = {
    turnId: input.turnId,
    olderBoundary: input.olderBoundary,
    newerBoundary: input.newerBoundary,
    residency: residency(input.state.segments),
  } as CodexHistoryItemWindow<TCanonicalItem, TRendererItem>;
  Object.defineProperty(window, codexHistoryItemWindowState, {
    value: input.state,
    enumerable: false,
  });
  return Object.freeze(window);
}

export function createCodexHistoryItemWindow<
  TCanonicalItem extends CodexHistoryItemIdentity,
  TRendererItem,
>(
  input: CreateCodexHistoryItemWindowInput<TCanonicalItem, TRendererItem>,
): CreateCodexHistoryItemWindowResult<TCanonicalItem, TRendererItem> {
  if (!isNonEmptyIdentity(input.turnId)) {
    return {
      ok: false,
      error: itemWindowError("malformedIdentity", "Item-window Turn identity must be non-empty"),
    };
  }
  const boundaryError = validateOlderBoundary(input.olderBoundary);
  if (boundaryError) return { ok: false, error: boundaryError };

  const seedSegments: CodexHistoryItemSegment<TCanonicalItem, TRendererItem>[] = [];
  let itemIds: StringSetNode | null = null;
  let segmentIds: StringSetNode | null = null;
  for (const candidate of input.seedSegments ?? []) {
    const segment = copySegment(candidate);
    const segmentError = validateSegmentShape(segment);
    if (segmentError) return { ok: false, error: segmentError };
    if (segment.items.itemIds.length === 0) {
      return {
        ok: false,
        error: itemWindowError(
          "malformedSegment",
          `Seed segment '${segment.segmentId}' must contain an item`,
        ),
      };
    }
    if (segment.turnId !== input.turnId) {
      return {
        ok: false,
        error: itemWindowError(
          "foreignTurn",
          `Segment '${segment.segmentId}' belongs to Turn '${segment.turnId}'`,
        ),
      };
    }
    if (stringSetHas(segmentIds, segment.segmentId, () => undefined)) {
      return {
        ok: false,
        error: itemWindowError(
          "duplicateSegment",
          `Duplicate item-window segment '${segment.segmentId}'`,
        ),
      };
    }
    const pageIds = new Set<string>();
    for (const itemId of segment.items.itemIds) {
      if (pageIds.has(itemId) || stringSetHas(itemIds, itemId, () => undefined)) {
        return {
          ok: false,
          error: itemWindowError("duplicateItem", `Duplicate resident item '${itemId}'`),
        };
      }
      pageIds.add(itemId);
    }
    segmentIds = stringSetInsert(segmentIds, segment.segmentId, () => undefined);
    for (const itemId of segment.items.itemIds) {
      itemIds = stringSetInsert(itemIds, itemId, () => undefined);
    }
    seedSegments.push(segment);
  }

  const segments = buildSegmentTree(seedSegments, 0, seedSegments.length);
  return {
    ok: true,
    window: createWindowValue({
      turnId: input.turnId,
      olderBoundary: Object.freeze({ ...input.olderBoundary }),
      newerBoundary: Object.freeze({
        ...(input.newerBoundary ?? { status: "exhausted" }),
      }),
      state: Object.freeze({
        segments,
        itemIds,
        segmentIds,
        nextOlderOrder: seedSegments.length === 0 ? 0 : -1,
        nextNewerOrder: seedSegments.length,
      }),
    }),
  };
}

function prependTransition<TCanonicalItem extends CodexHistoryItemIdentity, TRendererItem>(
  window: CodexHistoryItemWindow<TCanonicalItem, TRendererItem>,
  input: PrependCodexHistoryItemPageInput<TCanonicalItem, TRendererItem>,
): CodexHistoryItemWindowTransitionResult<TCanonicalItem, TRendererItem> {
  const work = mutableWork();
  if (input.turnId !== window.turnId) {
    return {
      ok: false,
      error: itemWindowError(
        "foreignTurn",
        `Item page for Turn '${input.turnId}' cannot enter '${window.turnId}'`,
      ),
    };
  }
  if (window.olderBoundary.status !== "available") {
    return {
      ok: false,
      error: itemWindowError("historyExhausted", "Turn item history is already exhausted"),
    };
  }
  if (input.olderCursorAfter !== null && !isNonEmptyIdentity(input.olderCursorAfter)) {
    return {
      ok: false,
      error: itemWindowError("malformedBoundary", "Next older item cursor must be non-empty"),
    };
  }
  if (input.olderCursorAfter !== null && input.olderCursorAfter === window.olderBoundary.cursor) {
    return {
      ok: false,
      error: itemWindowError("cursorStalled", "Older item cursor did not advance"),
    };
  }

  const copiedSegment = copySegment({
    turnId: input.turnId,
    segmentId: input.segmentId,
    olderCursor: input.olderCursorAfter,
    ...(input.newerCursor !== undefined ? { newerCursor: input.newerCursor } : {}),
    items: input.items,
    approximateBytes: input.approximateBytes,
  });
  const segmentError = validateSegmentShape(copiedSegment);
  if (segmentError) return { ok: false, error: segmentError };
  work.pageItemsVisited = copiedSegment.items.itemIds.length;
  work.pageRendererItemsVisited = copiedSegment.items.rendererItems.length;
  work.wireValues =
    copiedSegment.items.itemIds.length +
    copiedSegment.items.canonicalItems.length +
    copiedSegment.items.rendererItems.length;
  const state = window[codexHistoryItemWindowState];
  if (
    copiedSegment.items.itemIds.length > 0 &&
    stringSetHas(state.segmentIds, copiedSegment.segmentId, () => {
      work.segmentIndexNodeVisits += 1;
    })
  ) {
    return {
      ok: false,
      error: itemWindowError(
        "duplicateSegment",
        `Item segment '${copiedSegment.segmentId}' is already resident`,
      ),
    };
  }

  const pageIds = new Set<string>();
  for (const itemId of copiedSegment.items.itemIds) {
    if (
      pageIds.has(itemId) ||
      stringSetHas(state.itemIds, itemId, () => {
        work.itemIndexNodeVisits += 1;
      })
    ) {
      return {
        ok: false,
        error: itemWindowError("duplicateItem", `Item '${itemId}' is already resident`),
      };
    }
    pageIds.add(itemId);
  }

  const olderBoundaryAfter = boundaryAfter(input.olderCursorAfter);
  const wireSegment = Object.freeze({
    ...copiedSegment,
    direction: "older" as const,
    olderBoundaryBefore: window.olderBoundary,
    olderBoundaryAfter,
    newerBoundaryBefore: window.newerBoundary,
    newerBoundaryAfter: window.newerBoundary,
  });

  let segments = state.segments;
  let itemIds = state.itemIds;
  let segmentIds = state.segmentIds;
  let nextOlderOrder = state.nextOlderOrder;
  const nextNewerOrder = state.nextNewerOrder;
  if (copiedSegment.items.itemIds.length > 0) {
    if (!Number.isSafeInteger(nextOlderOrder)) {
      return {
        ok: false,
        error: itemWindowError("malformedSegment", "Item segment order exhausted safe integers"),
      };
    }
    segments = segmentTreeInsert(segments, nextOlderOrder, copiedSegment, () => {
      work.segmentTreeNodeVisits += 1;
    });
    nextOlderOrder -= 1;
    segmentIds = stringSetInsert(segmentIds, copiedSegment.segmentId, () => {
      work.segmentIndexNodeVisits += 1;
    });
    for (const itemId of copiedSegment.items.itemIds) {
      itemIds = stringSetInsert(itemIds, itemId, () => {
        work.itemIndexNodeVisits += 1;
      });
    }
  }

  const nextNewerBoundary = window.newerBoundary;
  const nextWindow = createWindowValue({
    turnId: window.turnId,
    olderBoundary: olderBoundaryAfter,
    newerBoundary: nextNewerBoundary,
    state: Object.freeze({
      segments,
      itemIds,
      segmentIds,
      nextOlderOrder,
      nextNewerOrder,
    }),
  });
  return {
    ok: true,
    window: nextWindow,
    wireSegment: Object.freeze({ ...wireSegment, newerBoundaryAfter: nextNewerBoundary }),
    work: freezeWork(work),
  };
}

export function prependCodexHistoryItemPage<
  TCanonicalItem extends CodexHistoryItemIdentity,
  TRendererItem,
>(
  window: CodexHistoryItemWindow<TCanonicalItem, TRendererItem>,
  input: PrependCodexHistoryItemPageInput<TCanonicalItem, TRendererItem>,
): CodexHistoryItemWindowTransitionResult<TCanonicalItem, TRendererItem> {
  return prependTransition(window, input);
}

function appendTransition<TCanonicalItem extends CodexHistoryItemIdentity, TRendererItem>(
  window: CodexHistoryItemWindow<TCanonicalItem, TRendererItem>,
  input: AppendCodexHistoryItemPageInput<TCanonicalItem, TRendererItem>,
): CodexHistoryItemWindowTransitionResult<TCanonicalItem, TRendererItem> {
  const work = mutableWork();
  if (input.turnId !== window.turnId) {
    return {
      ok: false,
      error: itemWindowError(
        "foreignTurn",
        `Item page for Turn '${input.turnId}' cannot enter '${window.turnId}'`,
      ),
    };
  }
  if (window.newerBoundary.status !== "available") {
    return {
      ok: false,
      error: itemWindowError("historyExhausted", "Turn item newer history is unavailable"),
    };
  }
  if (input.newerCursorAfter !== null && !isNonEmptyIdentity(input.newerCursorAfter)) {
    return {
      ok: false,
      error: itemWindowError("malformedBoundary", "Next newer item cursor must be non-empty"),
    };
  }
  if (input.newerCursorAfter !== null && input.newerCursorAfter === window.newerBoundary.cursor) {
    return {
      ok: false,
      error: itemWindowError("cursorStalled", "Newer item cursor did not advance"),
    };
  }

  const copiedSegment = copySegment({
    turnId: input.turnId,
    segmentId: input.segmentId,
    ...(input.olderCursor !== undefined ? { olderCursor: input.olderCursor } : {}),
    newerCursor: input.newerCursorAfter,
    items: input.items,
    approximateBytes: input.approximateBytes,
  });
  const segmentError = validateSegmentShape(copiedSegment);
  if (segmentError) return { ok: false, error: segmentError };
  work.pageItemsVisited = copiedSegment.items.itemIds.length;
  work.pageRendererItemsVisited = copiedSegment.items.rendererItems.length;
  work.wireValues =
    copiedSegment.items.itemIds.length +
    copiedSegment.items.canonicalItems.length +
    copiedSegment.items.rendererItems.length;
  const state = window[codexHistoryItemWindowState];
  if (
    copiedSegment.items.itemIds.length > 0 &&
    stringSetHas(state.segmentIds, copiedSegment.segmentId, () => {
      work.segmentIndexNodeVisits += 1;
    })
  ) {
    return {
      ok: false,
      error: itemWindowError(
        "duplicateSegment",
        `Item segment '${copiedSegment.segmentId}' is already resident`,
      ),
    };
  }
  const pageIds = new Set<string>();
  for (const itemId of copiedSegment.items.itemIds) {
    if (
      pageIds.has(itemId) ||
      stringSetHas(state.itemIds, itemId, () => {
        work.itemIndexNodeVisits += 1;
      })
    ) {
      return {
        ok: false,
        error: itemWindowError("duplicateItem", `Item '${itemId}' is already resident`),
      };
    }
    pageIds.add(itemId);
  }

  const nextNewerBoundary = newerBoundaryAfter(input.newerCursorAfter);
  let segments = state.segments;
  let itemIds = state.itemIds;
  let segmentIds = state.segmentIds;
  const nextOlderOrder = state.nextOlderOrder;
  let nextNewerOrder = state.nextNewerOrder;
  if (copiedSegment.items.itemIds.length > 0) {
    if (!Number.isSafeInteger(nextNewerOrder)) {
      return {
        ok: false,
        error: itemWindowError("malformedSegment", "Item segment order exhausted safe integers"),
      };
    }
    segments = segmentTreeInsert(segments, nextNewerOrder, copiedSegment, () => {
      work.segmentTreeNodeVisits += 1;
    });
    nextNewerOrder += 1;
    segmentIds = stringSetInsert(segmentIds, copiedSegment.segmentId, () => {
      work.segmentIndexNodeVisits += 1;
    });
    for (const itemId of copiedSegment.items.itemIds) {
      itemIds = stringSetInsert(itemIds, itemId, () => {
        work.itemIndexNodeVisits += 1;
      });
    }
  }

  const nextOlderBoundary = window.olderBoundary;
  const nextWindow = createWindowValue({
    turnId: window.turnId,
    olderBoundary: nextOlderBoundary,
    newerBoundary: nextNewerBoundary,
    state: Object.freeze({
      segments,
      itemIds,
      segmentIds,
      nextOlderOrder,
      nextNewerOrder,
    }),
  });
  return {
    ok: true,
    window: nextWindow,
    wireSegment: Object.freeze({
      ...copiedSegment,
      direction: "newer" as const,
      olderBoundaryBefore: window.olderBoundary,
      olderBoundaryAfter: nextOlderBoundary,
      newerBoundaryBefore: window.newerBoundary,
      newerBoundaryAfter: nextNewerBoundary,
    }),
    work: freezeWork(work),
  };
}

export function appendCodexHistoryItemPage<
  TCanonicalItem extends CodexHistoryItemIdentity,
  TRendererItem,
>(
  window: CodexHistoryItemWindow<TCanonicalItem, TRendererItem>,
  input: AppendCodexHistoryItemPageInput<TCanonicalItem, TRendererItem>,
): CodexHistoryItemWindowTransitionResult<TCanonicalItem, TRendererItem> {
  return appendTransition(window, input);
}

export function applyCodexHistoryItemWindowMutation<
  TCanonicalItem extends CodexHistoryItemIdentity,
  TRendererItem,
>(
  window: CodexHistoryItemWindow<TCanonicalItem, TRendererItem>,
  mutation: CodexHistoryItemWindowMutation<TCanonicalItem, TRendererItem>,
): ApplyCodexHistoryItemWindowMutationResult<TCanonicalItem, TRendererItem> {
  if (
    !sameOlderBoundary(window.olderBoundary, mutation.wireSegment.olderBoundaryBefore) ||
    !sameNewerBoundary(window.newerBoundary, mutation.wireSegment.newerBoundaryBefore)
  ) {
    return {
      ok: false,
      error: itemWindowError(
        "staleBoundary",
        "Item segment was produced from different resident boundaries",
      ),
    };
  }
  const result =
    mutation.wireSegment.direction === "older"
      ? prependTransition(window, {
          turnId: mutation.wireSegment.turnId,
          segmentId: mutation.wireSegment.segmentId,
          items: mutation.wireSegment.items,
          approximateBytes: mutation.wireSegment.approximateBytes,
          olderCursorAfter:
            mutation.wireSegment.olderCursor === undefined
              ? null
              : mutation.wireSegment.olderCursor,
          newerCursor:
            mutation.wireSegment.newerCursor === undefined
              ? null
              : mutation.wireSegment.newerCursor,
        })
      : appendTransition(window, {
          turnId: mutation.wireSegment.turnId,
          segmentId: mutation.wireSegment.segmentId,
          items: mutation.wireSegment.items,
          approximateBytes: mutation.wireSegment.approximateBytes,
          newerCursorAfter:
            mutation.wireSegment.newerCursor === undefined
              ? null
              : mutation.wireSegment.newerCursor,
          olderCursor:
            mutation.wireSegment.olderCursor === undefined
              ? null
              : mutation.wireSegment.olderCursor,
        });
  if (!result.ok) return result;
  if (
    !sameOlderBoundary(result.window.olderBoundary, mutation.wireSegment.olderBoundaryAfter) ||
    !sameNewerBoundary(result.window.newerBoundary, mutation.wireSegment.newerBoundaryAfter)
  ) {
    return {
      ok: false,
      error: itemWindowError("staleBoundary", "Item segment has malformed continuations"),
    };
  }
  return {
    ok: true,
    window: result.window,
    work: result.work,
  };
}

function appendMaterializedSegment<TCanonicalItem extends CodexHistoryItemIdentity, TRendererItem>(
  node: SegmentTreeNode<TCanonicalItem, TRendererItem> | null,
  segments: CodexHistoryItemSegment<TCanonicalItem, TRendererItem>[],
): void {
  if (!node) return;
  appendMaterializedSegment(node.left, segments);
  segments.push(node.segment);
  appendMaterializedSegment(node.right, segments);
}

/**
 * Explicit O(resident items) view boundary. Page admission, mutation serialization, and receiver
 * apply must not call this function.
 */
export function materializeCodexHistoryItemWindow<
  TCanonicalItem extends CodexHistoryItemIdentity,
  TRendererItem,
>(
  window: CodexHistoryItemWindow<TCanonicalItem, TRendererItem>,
): CodexHistoryItemWindowMaterialization<TCanonicalItem, TRendererItem> {
  const segments: CodexHistoryItemSegment<TCanonicalItem, TRendererItem>[] = [];
  appendMaterializedSegment(window[codexHistoryItemWindowState].segments, segments);
  const itemIds: string[] = [];
  const canonicalItems: TCanonicalItem[] = [];
  const rendererItems: TRendererItem[] = [];
  for (const segment of segments) {
    itemIds.push(...segment.items.itemIds);
    canonicalItems.push(...segment.items.canonicalItems);
    rendererItems.push(...segment.items.rendererItems);
  }
  return {
    segments: Object.freeze(segments),
    itemIds: Object.freeze(itemIds),
    canonicalItems: Object.freeze(canonicalItems),
    rendererItems: Object.freeze(rendererItems),
    work: Object.freeze({
      segmentsVisited: segments.length,
      itemIdsVisited: itemIds.length,
      canonicalItemsVisited: canonicalItems.length,
      rendererItemsVisited: rendererItems.length,
    }),
  };
}
