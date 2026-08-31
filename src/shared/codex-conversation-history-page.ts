import type {
  CodexCanonicalItem,
  CodexCanonicalConversationState,
  CodexCanonicalTurnState,
} from "./codex-conversation-state/codex-conversation-state";
import type {
  CodexHistoryBoundaryRef,
  CodexHistoryRow,
  CodexHistoryTurnItemsPagination,
} from "./codex-conversation-state/codex-history-topology";
import type {
  CodexConversationSnapshot,
  CodexConversationItem,
  CodexConversationTurn,
  CodexConversationTurnPagination,
} from "./types";
import { cappedApproximateValueBytes } from "./codex-bounded-value-size";
import {
  applyCodexHistoryItemWindowMutation,
  createCodexHistoryItemWindow,
  DEFAULT_CODEX_HISTORY_ITEM_WINDOW_LIMITS,
  materializeCodexHistoryItemWindow,
  type CodexHistoryItemNewerBoundary,
  type CodexHistoryItemOlderBoundary,
  type CodexHistoryItemSegment,
  type CodexHistoryItemWindow,
  type CodexHistoryItemWindowLimits,
  type CodexHistoryItemWindowMutation,
} from "./codex-conversation-state/codex-history-item-window";

const CODEX_HISTORY_ITEM_SEED_SEGMENT_SIZE = 100;

export interface CodexConversationHistoryItemWindowSnapshot {
  readonly turnId: string;
  readonly limits: CodexHistoryItemWindowLimits;
  readonly olderBoundary: CodexHistoryItemOlderBoundary;
  readonly newerBoundary: CodexHistoryItemNewerBoundary;
  /** Bounded chronological segments; item values are shared with the visible Turn projection. */
  readonly segments: readonly CodexHistoryItemSegment<CodexCanonicalItem, CodexConversationItem>[];
}

export interface CodexConversationHistoryTurnItemsRef {
  readonly turnId: string;
  readonly expectedTopologyGeneration: number;
  readonly edge: "older" | "newer";
  readonly progressKey: string;
}

export type CodexConversationHistoryPageTarget =
  | {
      readonly kind: "turnBoundary";
      readonly boundary: CodexHistoryBoundaryRef;
    }
  | {
      readonly kind: "turnItems";
      readonly items: CodexConversationHistoryTurnItemsRef;
    };

/** The only ordinary resident-history read command. It always addresses one physical page. */
export interface CodexConversationHistoryPageRequest {
  readonly threadId: string;
  readonly expectedConversationGeneration: number;
  readonly expectedHistoryMutationRevision: number;
  readonly target: CodexConversationHistoryPageTarget;
}

export interface CodexConversationHistoryTurnItemsMutation {
  readonly turnId: string;
  readonly itemsView: CodexCanonicalTurnState["protocol"]["itemsView"];
  /** One page-local segment plus exact released segment identities. */
  readonly windowMutation: CodexHistoryItemWindowMutation<
    CodexCanonicalItem,
    CodexConversationItem
  >;
}

export interface CodexConversationHistoryRowSplice {
  /** Stable anchors make a mutation fail closed if another topology change overtook it. */
  readonly beforeKey: string | null;
  readonly afterKey: string | null;
  readonly removeKeys: readonly string[];
  readonly rows: readonly CodexHistoryRow[];
}

export type CodexConversationHistoryMutationOrigin =
  | {
      readonly kind: "page";
      readonly request: CodexConversationHistoryPageRequest;
    }
  | {
      readonly kind: "residency";
      readonly threadId: string;
      readonly expectedConversationGeneration: number;
      readonly expectedTopologyGeneration: number;
      readonly expectedHistoryMutationRevision: number;
    }
  | {
      readonly kind: "island";
      readonly threadId: string;
      readonly mutationId: string;
      readonly expectedConversationGeneration: number;
      readonly expectedTopologyGeneration: number;
    };

/**
 * A bounded semantic change to resident history. Unchanged Turns stay in the receiver and are
 * never serialized across IPC or owner/follower publication.
 */
export interface CodexConversationHistoryMutation {
  readonly origin: CodexConversationHistoryMutationOrigin;
  readonly threadId: string;
  readonly conversationGeneration: number;
  readonly topologyGeneration: number;
  readonly baseHistoryMutationRevision: number;
  readonly historyMutationRevision: number;
  readonly upsertTurns: readonly CodexConversationTurn[];
  readonly upsertCanonicalTurns: readonly CodexCanonicalTurnState[];
  readonly removeTurnIds: readonly string[];
  readonly turnItems: readonly CodexConversationHistoryTurnItemsMutation[];
  readonly rowSplices: readonly CodexConversationHistoryRowSplice[];
  readonly turnPagination: CodexConversationTurnPagination;
  readonly turnItemsPaginationUpserts: Readonly<Record<string, CodexHistoryTurnItemsPagination>>;
  readonly removeTurnItemsPaginationIds: readonly string[];
}

export interface CodexConversationHistoryPageResult {
  readonly status: "applied";
  readonly mutation: CodexConversationHistoryMutation;
}

export type ApplyCodexConversationHistoryMutationResult =
  | {
      readonly ok: true;
      readonly conversation: CodexConversationSnapshot;
    }
  | {
      readonly ok: false;
      readonly reason:
        | "foreign-thread"
        | "stale-conversation-generation"
        | "stale-topology-generation"
        | "stale-history-mutation-revision"
        | "stale-target-progress"
        | "stale-row-splice"
        | "malformed-mutation";
    };

const historyTopologyGeneration = (snapshot: CodexConversationSnapshot): number =>
  snapshot.historyTopologyGeneration ?? -1;

const historyConversationGeneration = (snapshot: CodexConversationSnapshot): number =>
  snapshot.conversationEntityGeneration ?? -1;

const historyMutationRevision = (snapshot: CodexConversationSnapshot): number =>
  snapshot.historyMutationRevision ?? 0;

const runtimeHistoryItemWindows = new WeakMap<
  CodexConversationSnapshot,
  ReadonlyMap<string, CodexHistoryItemWindow<CodexCanonicalItem, CodexConversationItem>>
>();

export function advanceCodexConversationHistoryItemWindowSnapshot(input: {
  readonly before: CodexConversationHistoryItemWindowSnapshot;
  readonly mutation: CodexHistoryItemWindowMutation<CodexCanonicalItem, CodexConversationItem>;
  readonly after: CodexHistoryItemWindow<CodexCanonicalItem, CodexConversationItem>;
}): CodexConversationHistoryItemWindowSnapshot {
  const released = new Set(input.mutation.releasedSegmentIds);
  const retained = input.before.segments.filter((segment) => !released.has(segment.segmentId));
  const wire = input.mutation.wireSegment;
  const segment: CodexHistoryItemSegment<CodexCanonicalItem, CodexConversationItem> = {
    segmentId: wire.segmentId,
    turnId: wire.turnId,
    ...(wire.olderCursor !== undefined ? { olderCursor: wire.olderCursor } : {}),
    ...(wire.newerCursor !== undefined ? { newerCursor: wire.newerCursor } : {}),
    items: wire.items,
    approximateBytes: wire.approximateBytes,
  };
  const segments =
    wire.items.itemIds.length === 0
      ? retained
      : wire.direction === "older"
        ? [segment, ...retained]
        : [...retained, segment];
  return {
    turnId: input.after.turnId,
    limits: input.after.limits,
    olderBoundary: input.after.olderBoundary,
    newerBoundary: input.after.newerBoundary,
    segments,
  };
}

export function codexConversationHistoryTurnItemsProgressKey(
  pagination: Pick<
    CodexHistoryTurnItemsPagination,
    "olderCursor" | "hasLoadedOldest" | "itemsView"
  >,
  edge: "older" | "newer" = "older",
  window?: CodexConversationHistoryItemWindowSnapshot | null,
): string {
  return JSON.stringify([
    edge,
    pagination.olderCursor,
    pagination.hasLoadedOldest,
    pagination.itemsView,
    window?.olderBoundary ?? null,
    window?.newerBoundary ?? null,
  ]);
}

const approximateHistoryItemSegmentBytes = (value: unknown): number =>
  cappedApproximateValueBytes(value, DEFAULT_CODEX_HISTORY_ITEM_WINDOW_LIMITS.maxApproximateBytes);

const historyTranscriptEntryKey = (item: CodexConversationItem): string =>
  JSON.stringify([item.entryId ?? null, item.itemId, item.kind, item.type, item.sequence ?? null]);

export function snapshotCodexConversationHistoryItemWindow(
  window: CodexHistoryItemWindow<CodexCanonicalItem, CodexConversationItem>,
): CodexConversationHistoryItemWindowSnapshot {
  const materialized = materializeCodexHistoryItemWindow(window);
  return {
    turnId: window.turnId,
    limits: window.limits,
    olderBoundary: window.olderBoundary,
    newerBoundary: window.newerBoundary,
    segments: materialized.segments,
  };
}

export function restoreCodexConversationHistoryItemWindow(
  snapshot: CodexConversationHistoryItemWindowSnapshot,
): CodexHistoryItemWindow<CodexCanonicalItem, CodexConversationItem> | null {
  const restored = createCodexHistoryItemWindow({
    turnId: snapshot.turnId,
    limits: snapshot.limits,
    olderBoundary: snapshot.olderBoundary,
    newerBoundary: snapshot.newerBoundary,
    seedSegments: snapshot.segments,
  });
  return restored.ok ? restored.window : null;
}

/** Deterministically segments a legacy/current bounded Turn before its first page mutation. */
export function seedCodexConversationHistoryItemWindow(input: {
  readonly turnId: string;
  readonly canonicalItems: readonly CodexCanonicalItem[];
  readonly rendererItems: readonly CodexConversationItem[];
  readonly pagination: CodexHistoryTurnItemsPagination;
}): CodexHistoryItemWindow<CodexCanonicalItem, CodexConversationItem> | null {
  const segments: CodexHistoryItemSegment<CodexCanonicalItem, CodexConversationItem>[] = [];
  const matchedRendererKeys = new Set<string>();
  for (
    let start = 0, segmentIndex = 0;
    start < input.canonicalItems.length;
    start += CODEX_HISTORY_ITEM_SEED_SEGMENT_SIZE, segmentIndex += 1
  ) {
    const canonicalItems = input.canonicalItems.slice(
      start,
      start + CODEX_HISTORY_ITEM_SEED_SEGMENT_SIZE,
    );
    const itemIds = canonicalItems.map((item) => item.id);
    const ids = new Set(itemIds);
    const rendererItems = input.rendererItems.filter((item) => {
      if (!ids.has(item.itemId)) return false;
      matchedRendererKeys.add(historyTranscriptEntryKey(item));
      return true;
    });
    segments.push({
      segmentId: `seed:${input.turnId}:${segmentIndex}:${itemIds[0] ?? "empty"}:${itemIds.at(-1) ?? "empty"}`,
      turnId: input.turnId,
      items: { itemIds, canonicalItems, rendererItems },
      approximateBytes: approximateHistoryItemSegmentBytes({ canonicalItems, rendererItems }),
    });
  }
  if (segments.length > 0) {
    const unmatched = input.rendererItems.filter(
      (item) => !matchedRendererKeys.has(historyTranscriptEntryKey(item)),
    );
    if (unmatched.length > 0) {
      const lastIndex = segments.length - 1;
      const last = segments[lastIndex]!;
      const rendererItems = [...last.items.rendererItems, ...unmatched];
      segments[lastIndex] = {
        ...last,
        items: { ...last.items, rendererItems },
        approximateBytes: approximateHistoryItemSegmentBytes({
          canonicalItems: last.items.canonicalItems,
          rendererItems,
        }),
      };
    }
  }
  const created = createCodexHistoryItemWindow({
    turnId: input.turnId,
    olderBoundary: input.pagination.hasLoadedOldest
      ? { status: "exhausted" }
      : { status: "available", cursor: input.pagination.olderCursor },
    newerBoundary: { status: "exhausted" },
    seedSegments: segments,
  });
  return created.ok ? created.window : null;
}

export function createCodexConversationHistoryTurnItemsRef(input: {
  readonly turnId: string;
  readonly expectedTopologyGeneration: number;
  readonly pagination: CodexHistoryTurnItemsPagination;
  readonly edge?: "older" | "newer";
  readonly window?: CodexConversationHistoryItemWindowSnapshot | null;
}): CodexConversationHistoryTurnItemsRef | null {
  const edge = input.edge ?? "older";
  if (
    !input.turnId ||
    !Number.isSafeInteger(input.expectedTopologyGeneration) ||
    input.expectedTopologyGeneration < 0
  ) {
    return null;
  }
  if (edge === "older") {
    if (input.window?.olderBoundary.status !== undefined) {
      if (input.window.olderBoundary.status !== "available") return null;
    } else if (input.pagination.hasLoadedOldest || input.pagination.itemsView === "full") {
      return null;
    }
  } else if (input.window?.newerBoundary.status !== "available") {
    return null;
  }
  return {
    turnId: input.turnId,
    expectedTopologyGeneration: input.expectedTopologyGeneration,
    edge,
    progressKey: codexConversationHistoryTurnItemsProgressKey(input.pagination, edge, input.window),
  };
}

export function codexConversationHistoryPageRequestKey(
  request: CodexConversationHistoryPageRequest,
): string {
  const target = request.target;
  return target.kind === "turnBoundary"
    ? JSON.stringify([
        request.threadId,
        request.expectedConversationGeneration,
        target.kind,
        target.boundary.generation,
        target.boundary.islandId,
        target.boundary.edge,
        target.boundary.boundaryId,
        target.boundary.progressKey,
      ])
    : JSON.stringify([
        request.threadId,
        request.expectedConversationGeneration,
        target.kind,
        target.items.expectedTopologyGeneration,
        target.items.turnId,
        target.items.edge,
        target.items.progressKey,
      ]);
}

function uniqueRowKeys(rows: readonly CodexHistoryRow[]): boolean {
  return new Set(rows.map((row) => row.key)).size === rows.length;
}

/** Produces anchor-addressed local splices; unchanged rows do not enter the wire payload. */
export function diffCodexConversationHistoryRows(
  before: readonly CodexHistoryRow[],
  after: readonly CodexHistoryRow[],
): readonly CodexConversationHistoryRowSplice[] {
  if (!uniqueRowKeys(before) || !uniqueRowKeys(after)) {
    throw new TypeError("Conversation history rows must have unique keys");
  }
  const afterKeys = new Set(after.map((row) => row.key));
  const beforeKeys = new Set(before.map((row) => row.key));
  const commonBefore = before.filter((row) => afterKeys.has(row.key));
  const commonAfter = after.filter((row) => beforeKeys.has(row.key));
  if (
    commonBefore.length !== commonAfter.length ||
    commonBefore.some((row, index) => row.key !== commonAfter[index]?.key)
  ) {
    throw new TypeError("Conversation history mutation cannot reorder established rows");
  }

  const splices: CodexConversationHistoryRowSplice[] = [];
  let beforeIndex = 0;
  let afterIndex = 0;
  let beforeKey: string | null = null;
  for (const anchor of commonBefore) {
    const nextBeforeIndex = before.findIndex(
      (row, index) => index >= beforeIndex && row.key === anchor.key,
    );
    const nextAfterIndex = after.findIndex(
      (row, index) => index >= afterIndex && row.key === anchor.key,
    );
    const removed = before.slice(beforeIndex, nextBeforeIndex);
    const inserted = after.slice(afterIndex, nextAfterIndex);
    if (removed.length > 0 || inserted.length > 0) {
      splices.push({
        beforeKey,
        afterKey: anchor.key,
        removeKeys: removed.map((row) => row.key),
        rows: inserted,
      });
    }
    beforeIndex = nextBeforeIndex + 1;
    afterIndex = nextAfterIndex + 1;
    beforeKey = anchor.key;
  }
  const removed = before.slice(beforeIndex);
  const inserted = after.slice(afterIndex);
  if (removed.length > 0 || inserted.length > 0) {
    splices.push({
      beforeKey,
      afterKey: null,
      removeKeys: removed.map((row) => row.key),
      rows: inserted,
    });
  }
  return splices;
}

function sameTurnItemsPagination(
  left: CodexHistoryTurnItemsPagination | undefined,
  right: CodexHistoryTurnItemsPagination,
): boolean {
  return (
    left?.olderCursor === right.olderCursor &&
    left.isLoadingOlder === right.isLoadingOlder &&
    left.hasLoadedOldest === right.hasLoadedOldest &&
    left.openingUserMessageId === right.openingUserMessageId &&
    left.itemsView === right.itemsView &&
    sameProtocolValue(left.oldestUserInput, right.oldestUserInput)
  );
}

/** JSON protocol equality without allocating payload-sized serialized strings. */
function sameProtocolValue(left: unknown, right: unknown, depth = 0): boolean {
  if (Object.is(left, right)) return true;
  if (depth > 128 || left === null || right === null) return false;
  if (typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (!sameProtocolValue(left[index], right[index], depth + 1)) return false;
    }
    return true;
  }

  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  let leftKeys = 0;
  let rightKeys = 0;
  for (const key in leftRecord) {
    if (!Object.hasOwn(leftRecord, key)) continue;
    leftKeys += 1;
    if (
      !Object.hasOwn(rightRecord, key) ||
      !sameProtocolValue(leftRecord[key], rightRecord[key], depth + 1)
    ) {
      return false;
    }
  }
  for (const key in rightRecord) {
    if (Object.hasOwn(rightRecord, key)) rightKeys += 1;
  }
  return leftKeys === rightKeys;
}

function persistedCanonicalTurns(
  state: CodexCanonicalConversationState | null | undefined,
): readonly CodexCanonicalTurnState[] {
  return (
    state?.turns.filter(
      (turn): turn is CodexCanonicalTurnState & { readonly protocol: { readonly id: string } } =>
        turn.protocol.id !== null,
    ) ?? []
  );
}

/** Main-side builder for a page or eviction mutation. */
export function buildCodexConversationHistoryMutation(input: {
  readonly before: CodexConversationSnapshot;
  readonly after: CodexConversationSnapshot;
  readonly origin: CodexConversationHistoryMutationOrigin;
  readonly turnItems?: readonly CodexConversationHistoryTurnItemsMutation[];
}): CodexConversationHistoryMutation {
  if (input.before.threadId !== input.after.threadId) {
    throw new TypeError("Conversation history mutation cannot cross threads");
  }
  const canonicalAfter = input.after.canonicalState;
  const turnPagination = input.after.turnPagination;
  const conversationGeneration = input.after.conversationEntityGeneration;
  const topologyGeneration = input.after.historyTopologyGeneration;
  const nextHistoryMutationRevision = input.after.historyMutationRevision;
  const baseHistoryMutationRevision = input.before.historyMutationRevision ?? 0;
  if (
    !canonicalAfter ||
    !turnPagination ||
    conversationGeneration === undefined ||
    topologyGeneration === undefined ||
    nextHistoryMutationRevision === undefined
  ) {
    throw new TypeError("Conversation history mutation requires a canonical bounded snapshot");
  }

  const beforeCanonicalById = new Map<string, CodexCanonicalTurnState>(
    persistedCanonicalTurns(input.before.canonicalState).map(
      (turn) => [turn.protocol.id!, turn] as const,
    ),
  );
  const afterCanonicalById = new Map<string, CodexCanonicalTurnState>(
    persistedCanonicalTurns(canonicalAfter).map((turn) => [turn.protocol.id!, turn] as const),
  );
  const beforeTurnsById = new Map(
    input.before.turns.flatMap((turn) =>
      turn.turnId === null ? [] : [[turn.turnId, turn] as const],
    ),
  );
  const afterTurnsById = new Map(
    input.after.turns.flatMap((turn) =>
      turn.turnId === null ? [] : [[turn.turnId, turn] as const],
    ),
  );
  const removeTurnIds = [...beforeCanonicalById.keys()].filter(
    (turnId) => !afterCanonicalById.has(turnId),
  );
  const upsertIds = new Set<string>();
  const itemTarget =
    input.origin.kind === "page" && input.origin.request.target.kind === "turnItems"
      ? input.origin.request.target.items.turnId
      : null;
  for (const [turnId, turn] of afterCanonicalById) {
    if (turnId !== itemTarget && beforeCanonicalById.get(turnId) !== turn) upsertIds.add(turnId);
  }
  for (const [turnId, turn] of afterTurnsById) {
    if (turnId !== itemTarget && beforeTurnsById.get(turnId) !== turn) upsertIds.add(turnId);
  }
  const turnItems = input.turnItems ?? [];
  if (itemTarget && (turnItems.length !== 1 || turnItems[0]?.turnId !== itemTarget)) {
    throw new TypeError("Turn-item history mutation requires one exact item-window segment");
  }
  if (!itemTarget && turnItems.length > 0) {
    throw new TypeError("Only a Turn-item page may carry item-window segments");
  }

  const beforeItemsPagination = input.before.turnItemsPaginationById ?? {};
  const afterItemsPagination = input.after.turnItemsPaginationById ?? {};
  const turnItemsPaginationUpserts: Record<string, CodexHistoryTurnItemsPagination> = {};
  for (const [turnId, pagination] of Object.entries(afterItemsPagination)) {
    if (!sameTurnItemsPagination(beforeItemsPagination[turnId], pagination)) {
      turnItemsPaginationUpserts[turnId] = pagination;
    }
  }
  const removeTurnItemsPaginationIds = Object.keys(beforeItemsPagination).filter(
    (turnId) => afterItemsPagination[turnId] === undefined,
  );

  return {
    origin: input.origin,
    threadId: input.after.threadId,
    conversationGeneration,
    topologyGeneration,
    baseHistoryMutationRevision,
    historyMutationRevision: nextHistoryMutationRevision,
    upsertTurns: [...upsertIds].flatMap((turnId) => {
      const turn = afterTurnsById.get(turnId);
      return turn ? [turn] : [];
    }),
    upsertCanonicalTurns: [...upsertIds].flatMap((turnId) => {
      const turn = afterCanonicalById.get(turnId);
      return turn ? [turn] : [];
    }),
    removeTurnIds,
    turnItems,
    rowSplices: diffCodexConversationHistoryRows(
      input.before.historyRows ?? [],
      input.after.historyRows ?? [],
    ),
    turnPagination,
    turnItemsPaginationUpserts,
    removeTurnItemsPaginationIds,
  };
}

function expectedGeneration(origin: CodexConversationHistoryMutationOrigin): {
  readonly conversation: number;
  readonly topology: number;
} {
  if (origin.kind === "residency") {
    return {
      conversation: origin.expectedConversationGeneration,
      topology: origin.expectedTopologyGeneration,
    };
  }
  if (origin.kind === "island") {
    return {
      conversation: origin.expectedConversationGeneration,
      topology: origin.expectedTopologyGeneration,
    };
  }
  const target = origin.request.target;
  return {
    conversation: origin.request.expectedConversationGeneration,
    topology:
      target.kind === "turnBoundary"
        ? target.boundary.generation
        : target.items.expectedTopologyGeneration,
  };
}

function matchesBoundaryRef(
  rows: readonly CodexHistoryRow[],
  expected: CodexHistoryBoundaryRef,
): boolean {
  return rows.some((row) => {
    if (row.kind !== "gap") return false;
    const candidates = [row.olderBoundary, row.newerBoundary];
    return candidates.some(
      (candidate) =>
        candidate?.generation === expected.generation &&
        candidate.islandId === expected.islandId &&
        candidate.edge === expected.edge &&
        candidate.boundaryId === expected.boundaryId &&
        candidate.progressKey === expected.progressKey,
    );
  });
}

function applyRowSplices(
  current: readonly CodexHistoryRow[],
  splices: readonly CodexConversationHistoryRowSplice[],
): readonly CodexHistoryRow[] | null {
  const rows = [...current];
  for (const splice of splices) {
    const beforeIndex =
      splice.beforeKey === null ? -1 : rows.findIndex((row) => row.key === splice.beforeKey);
    const afterIndex =
      splice.afterKey === null ? rows.length : rows.findIndex((row) => row.key === splice.afterKey);
    if (splice.beforeKey !== null && beforeIndex < 0) return null;
    if (splice.afterKey !== null && afterIndex < 0) return null;
    const start = beforeIndex + 1;
    const end = afterIndex;
    if (start < 0 || end < start) return null;
    const currentKeys = rows.slice(start, end).map((row) => row.key);
    if (
      currentKeys.length !== splice.removeKeys.length ||
      currentKeys.some((key, index) => key !== splice.removeKeys[index])
    ) {
      return null;
    }
    rows.splice(start, splice.removeKeys.length, ...splice.rows);
  }
  return uniqueRowKeys(rows) ? rows : null;
}

/** Renderer/owner pure reducer. It preserves every unchanged Turn object by identity. */
export function applyCodexConversationHistoryMutation(
  conversation: CodexConversationSnapshot,
  mutation: CodexConversationHistoryMutation,
): ApplyCodexConversationHistoryMutationResult {
  if (conversation.threadId !== mutation.threadId) {
    return { ok: false, reason: "foreign-thread" };
  }
  if (
    (mutation.origin.kind === "page" && mutation.origin.request.threadId !== mutation.threadId) ||
    ((mutation.origin.kind === "residency" || mutation.origin.kind === "island") &&
      mutation.origin.threadId !== mutation.threadId)
  ) {
    return { ok: false, reason: "malformed-mutation" };
  }
  const upsertTurnIds = mutation.upsertTurns.flatMap((turn) =>
    turn.turnId === null ? [] : [turn.turnId],
  );
  const upsertCanonicalIds = mutation.upsertCanonicalTurns.flatMap((turn) =>
    turn.protocol.id === null ? [] : [turn.protocol.id],
  );
  const removeTurnIds = new Set(mutation.removeTurnIds);
  if (
    new Set(upsertTurnIds).size !== upsertTurnIds.length ||
    new Set(upsertCanonicalIds).size !== upsertCanonicalIds.length ||
    new Set(mutation.removeTurnIds).size !== mutation.removeTurnIds.length ||
    new Set(mutation.turnItems.map((entry) => entry.turnId)).size !== mutation.turnItems.length ||
    upsertTurnIds.some((turnId) => removeTurnIds.has(turnId)) ||
    upsertCanonicalIds.some((turnId) => removeTurnIds.has(turnId)) ||
    mutation.turnPagination.loadedTurnCount < 0
  ) {
    return { ok: false, reason: "malformed-mutation" };
  }
  const expected = expectedGeneration(mutation.origin);
  if (historyConversationGeneration(conversation) !== expected.conversation) {
    return { ok: false, reason: "stale-conversation-generation" };
  }
  if (historyTopologyGeneration(conversation) !== expected.topology) {
    return { ok: false, reason: "stale-topology-generation" };
  }
  if (historyMutationRevision(conversation) !== mutation.baseHistoryMutationRevision) {
    return { ok: false, reason: "stale-history-mutation-revision" };
  }
  if (
    mutation.conversationGeneration !== expected.conversation ||
    mutation.topologyGeneration !== expected.topology ||
    mutation.historyMutationRevision !== mutation.baseHistoryMutationRevision + 1
  ) {
    return { ok: false, reason: "malformed-mutation" };
  }
  if (mutation.origin.kind === "page") {
    const target = mutation.origin.request.target;
    if (
      target.kind === "turnBoundary" &&
      !matchesBoundaryRef(conversation.historyRows ?? [], target.boundary)
    ) {
      return { ok: false, reason: "stale-target-progress" };
    }
    if (target.kind === "turnItems") {
      const current = conversation.turnItemsPaginationById?.[target.items.turnId];
      const currentWindow = conversation.historyItemWindowsByTurnId?.[target.items.turnId];
      if (
        !current ||
        codexConversationHistoryTurnItemsProgressKey(current, target.items.edge, currentWindow) !==
          target.items.progressKey
      ) {
        return { ok: false, reason: "stale-target-progress" };
      }
    }
  }

  const rows = applyRowSplices(conversation.historyRows ?? [], mutation.rowSplices);
  if (!rows) return { ok: false, reason: "stale-row-splice" };
  const canonical = conversation.canonicalState;
  if (!canonical) return { ok: false, reason: "malformed-mutation" };

  const removed = removeTurnIds;
  const turnById = new Map(
    conversation.turns.flatMap((turn) =>
      turn.turnId === null ? [] : [[turn.turnId, turn] as const],
    ),
  );
  for (const turnId of removed) turnById.delete(turnId);
  const boundaryPage =
    mutation.origin.kind === "page" && mutation.origin.request.target.kind === "turnBoundary";
  for (const turn of mutation.upsertTurns) {
    if (turn.turnId !== null && (!boundaryPage || !turnById.has(turn.turnId))) {
      turnById.set(turn.turnId, turn);
    }
  }
  const canonicalById = new Map(
    persistedCanonicalTurns(canonical).map((turn) => [turn.protocol.id, turn]),
  );
  for (const turnId of removed) canonicalById.delete(turnId);
  for (const turn of mutation.upsertCanonicalTurns) {
    if (turn.protocol.id !== null && (!boundaryPage || !canonicalById.has(turn.protocol.id))) {
      canonicalById.set(turn.protocol.id, turn);
    }
  }
  const historyItemWindowsByTurnId: Record<string, CodexConversationHistoryItemWindowSnapshot> = {
    ...(conversation.historyItemWindowsByTurnId ?? {}),
  };
  const nextRuntimeWindows = new Map(runtimeHistoryItemWindows.get(conversation) ?? []);
  for (const turnId of removed) delete historyItemWindowsByTurnId[turnId];
  for (const turnId of removed) nextRuntimeWindows.delete(turnId);
  for (const itemMutation of mutation.turnItems) {
    const turn = turnById.get(itemMutation.turnId);
    const canonicalTurn = canonicalById.get(itemMutation.turnId);
    if (!turn || !canonicalTurn) {
      return { ok: false, reason: "malformed-mutation" };
    }
    if (itemMutation.windowMutation.wireSegment.turnId !== itemMutation.turnId) {
      return { ok: false, reason: "malformed-mutation" };
    }
    const pagination = conversation.turnItemsPaginationById?.[itemMutation.turnId];
    if (!pagination) return { ok: false, reason: "malformed-mutation" };
    const windowSnapshot = conversation.historyItemWindowsByTurnId?.[itemMutation.turnId];
    const window =
      nextRuntimeWindows.get(itemMutation.turnId) ??
      (windowSnapshot
        ? restoreCodexConversationHistoryItemWindow(windowSnapshot)
        : seedCodexConversationHistoryItemWindow({
            turnId: itemMutation.turnId,
            canonicalItems: canonicalTurn.items,
            rendererItems: turn.items,
            pagination,
          }));
    if (!window) return { ok: false, reason: "malformed-mutation" };
    if (window.residency.itemCount !== canonicalTurn.items.length) {
      return { ok: false, reason: "stale-target-progress" };
    }
    const appliedWindow = applyCodexHistoryItemWindowMutation(window, itemMutation.windowMutation);
    if (!appliedWindow.ok) return { ok: false, reason: "stale-target-progress" };
    const wire = itemMutation.windowMutation.wireSegment;
    const releasedCanonicalCount = appliedWindow.releasedSegments.reduce(
      (count, segment) => count + segment.items.canonicalItems.length,
      0,
    );
    const releasedRendererCount = appliedWindow.releasedSegments.reduce(
      (count, segment) => count + segment.items.rendererItems.length,
      0,
    );
    const retainedCanonicalItems =
      wire.direction === "older"
        ? canonicalTurn.items.slice(0, canonicalTurn.items.length - releasedCanonicalCount)
        : canonicalTurn.items.slice(releasedCanonicalCount);
    const retainedRendererItems =
      wire.direction === "older"
        ? turn.items.slice(0, turn.items.length - releasedRendererCount)
        : turn.items.slice(releasedRendererCount);
    const canonicalItems =
      wire.direction === "older"
        ? [...wire.items.canonicalItems, ...retainedCanonicalItems]
        : [...retainedCanonicalItems, ...wire.items.canonicalItems];
    const rendererItems =
      wire.direction === "older"
        ? [...wire.items.rendererItems, ...retainedRendererItems]
        : [...retainedRendererItems, ...wire.items.rendererItems];
    turnById.set(itemMutation.turnId, {
      ...turn,
      itemIds: canonicalItems.map((item) => item.id),
      items: rendererItems,
    });
    canonicalById.set(itemMutation.turnId, {
      ...canonicalTurn,
      protocol: {
        ...canonicalTurn.protocol,
        itemsView: itemMutation.itemsView,
      },
      items: canonicalItems,
    });
    historyItemWindowsByTurnId[itemMutation.turnId] =
      advanceCodexConversationHistoryItemWindowSnapshot({
        before: windowSnapshot ?? snapshotCodexConversationHistoryItemWindow(window),
        mutation: itemMutation.windowMutation,
        after: appliedWindow.window,
      });
    nextRuntimeWindows.set(itemMutation.turnId, appliedWindow.window);
  }

  const orderedTurnIds = rows.flatMap((row) => (row.kind === "content" ? [row.entityKey] : []));
  const ordered = new Set(orderedTurnIds);
  const extraTurnIds = conversation.turns.flatMap((turn) => {
    const turnId = turn.turnId;
    return turnId !== null && !removed.has(turnId) && !ordered.has(turnId) ? [turnId] : [];
  });
  const persistedOrder = [...orderedTurnIds, ...extraTurnIds];
  if (
    persistedOrder.some((turnId) => !turnById.has(turnId) || !canonicalById.has(turnId)) ||
    mutation.upsertTurns.some((turn) => turn.turnId !== null && !canonicalById.has(turn.turnId))
  ) {
    return { ok: false, reason: "malformed-mutation" };
  }

  const turnItemsPaginationById: Record<string, CodexHistoryTurnItemsPagination> = {
    ...(conversation.turnItemsPaginationById ?? {}),
    ...mutation.turnItemsPaginationUpserts,
  };
  for (const turnId of mutation.removeTurnItemsPaginationIds) {
    delete turnItemsPaginationById[turnId];
  }
  for (const turnId of removed) delete turnItemsPaginationById[turnId];

  const nextConversation: CodexConversationSnapshot = {
    ...conversation,
    conversationEntityGeneration: mutation.conversationGeneration,
    historyTopologyGeneration: mutation.topologyGeneration,
    historyMutationRevision: mutation.historyMutationRevision,
    historyRows: rows,
    turnPagination: mutation.turnPagination,
    turnItemsPaginationById,
    historyItemWindowsByTurnId,
    turns: [
      ...persistedOrder.map((turnId) => turnById.get(turnId)!),
      ...conversation.turns.filter((turn) => turn.turnId === null),
    ],
    canonicalState: {
      ...canonical,
      turns: [
        ...persistedOrder.map((turnId) => canonicalById.get(turnId)!),
        ...canonical.turns.filter((turn) => turn.protocol.id === null),
      ],
    },
  };
  runtimeHistoryItemWindows.set(nextConversation, nextRuntimeWindows);
  return { ok: true, conversation: nextConversation };
}
