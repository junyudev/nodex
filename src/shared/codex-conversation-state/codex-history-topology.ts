import type { TurnItemsView, UserInput } from "@nodex/codex-app-server-protocol/v2";

export const CODEX_HISTORY_GAP_ESTIMATED_HEIGHT_PX = 144;

export interface CodexHistoryBoundaryHandle {
  readonly source?: "ordinary" | "compact";
  readonly cursor: string;
  readonly oldestLoadedTurnId: string | null;
}

export type CodexHistoryBoundary =
  | {
      readonly status: "exhausted";
      readonly boundaryId: string;
    }
  | {
      /**
       * A known discontinuity without a server-stable cursor. Retention may create one when it
       * releases already-loaded entities from the middle of an island. It must remain visible as
       * an inert gap: pretending that either neighboring cursor addresses the cut would let a
       * later page silently bridge over missing history.
       */
      readonly status: "opaque";
      readonly boundaryId: string;
    }
  | {
      readonly status: "available";
      readonly boundaryId: string;
      readonly handle: CodexHistoryBoundaryHandle;
      readonly progressKey: string;
    };

export interface CodexHistoryTurnItemsPagination {
  readonly newestSnapshotItemId?: string;
  readonly summaryItemIds?: readonly string[];
  readonly reconnect?: {
    readonly beforeItemId: string | null;
    readonly stopItemId: string | null | undefined;
    readonly olderCursorAfterReconnect?: string | null;
  };
  readonly olderCursor: string | null;
  readonly isLoadingOlder: boolean;
  readonly hasLoadedOldest: boolean;
  readonly oldestUserInput?: readonly UserInput[] | null;
  /** Absent is unknown; null means history proves that there is no opening user message. */
  readonly openingUserMessageId?: string | null;
  readonly openingUserMessageClientId?: string | null;
  readonly itemsView: TurnItemsView;
}

/** An installation entry; the canonical map stores the Turn itself. */
export interface CodexHistoryEntity<TTurn> {
  readonly key: string;
  readonly turn: TTurn;
}

export type CodexHistoryTurnMerge<TTurn> = (current: TTurn, incoming: TTurn) => TTurn;

export interface CodexHistoryEntry {
  readonly key: string;
  readonly value: string;
}

export interface CodexHistoryIsland {
  readonly id: string;
  readonly entries: readonly CodexHistoryEntry[];
  readonly olderBoundary: CodexHistoryBoundary;
  readonly newerBoundary: CodexHistoryBoundary;
}

export interface CodexHistoryResidency {
  readonly islandCount: number;
  readonly turnCount: number;
  readonly itemCount: number;
  readonly approximateBytes: number;
}

export interface CodexCanonicalHistoryTopology<TTurn> {
  readonly generation: number;
  readonly isComplete: boolean;
  readonly islands: readonly CodexHistoryIsland[];
  readonly entitiesByKey: Readonly<Record<string, TTurn>>;
}

export type CodexHistoryBoundaryEdge = "older" | "newer";

export interface CodexHistoryBoundaryRef {
  readonly handle: CodexHistoryBoundaryHandle;
  readonly generation: number;
  readonly islandId: string;
  readonly edge: CodexHistoryBoundaryEdge;
  readonly boundaryId: string;
  readonly progressKey: string;
}

export type CodexHistoryRow =
  | {
      readonly kind: "content";
      readonly key: string;
      readonly turnKey: string;
      readonly entityKey: string;
    }
  | {
      readonly kind: "gap";
      readonly key: string;
      readonly olderBoundary: CodexHistoryBoundaryRef | null;
      readonly newerBoundary: CodexHistoryBoundaryRef | null;
      readonly estimatedHeightPx: typeof CODEX_HISTORY_GAP_ESTIMATED_HEIGHT_PX;
    };

export type CodexHistoryTopologyErrorCode =
  | "malformedTopology"
  | "staleGeneration"
  | "boundaryMissing"
  | "staleBoundary"
  | "cursorStalled"
  | "malformedPage";

export interface CodexHistoryTopologyError {
  readonly _tag: "CodexHistoryTopologyError";
  readonly code: CodexHistoryTopologyErrorCode;
  readonly message: string;
}

export type CodexHistoryTopologyResult<TTurn> =
  | { readonly ok: true; readonly topology: CodexCanonicalHistoryTopology<TTurn> }
  | { readonly ok: false; readonly error: CodexHistoryTopologyError };

export interface CreateCodexHistoryIslandInput<TTurn> {
  readonly generation: number;
  /** A fetched or invalidated history can remain incomplete without an available cursor. */
  readonly isComplete?: boolean;
  readonly islandId: string;
  readonly entries: readonly CodexHistoryEntry[];
  readonly entities: readonly CodexHistoryEntity<TTurn>[];
  readonly mergeTurns?: CodexHistoryTurnMerge<TTurn>;
  readonly olderBoundary: CodexHistoryBoundary;
  readonly newerBoundary: CodexHistoryBoundary;
}

export interface MergeCodexHistoryBoundaryPageInput<TTurn> {
  readonly boundary: CodexHistoryBoundaryRef;
  readonly entries: readonly CodexHistoryEntry[];
  readonly entities: readonly CodexHistoryEntity<TTurn>[];
  readonly mergeTurns?: CodexHistoryTurnMerge<TTurn>;
  readonly continuation: CodexHistoryBoundary;
}

export interface ReplaceCodexHistoryEntityInput<TTurn> {
  readonly expectedGeneration: number;
  readonly entity: CodexHistoryEntity<TTurn>;
}

function topologyError(
  code: CodexHistoryTopologyErrorCode,
  message: string,
): CodexHistoryTopologyError {
  return { _tag: "CodexHistoryTopologyError", code, message };
}

function isNonEmpty(value: string): boolean {
  return value.trim().length > 0;
}

export function codexHistoryBoundaryProgressKey(handle: CodexHistoryBoundaryHandle): string {
  return JSON.stringify([handle.cursor, handle.oldestLoadedTurnId]);
}

export function availableCodexHistoryBoundary(
  boundaryId: string,
  handle: CodexHistoryBoundaryHandle,
  progressKey = codexHistoryBoundaryProgressKey(handle),
): CodexHistoryBoundary {
  return {
    status: "available",
    boundaryId,
    handle,
    progressKey,
  };
}

export function exhaustedCodexHistoryBoundary(boundaryId: string): CodexHistoryBoundary {
  return { status: "exhausted", boundaryId };
}

export function opaqueCodexHistoryBoundary(boundaryId: string): CodexHistoryBoundary {
  return { status: "opaque", boundaryId };
}

export function createCodexHistoryBoundaryRef(
  generation: number,
  islandId: string,
  edge: CodexHistoryBoundaryEdge,
  boundary: Extract<CodexHistoryBoundary, { status: "available" }>,
): CodexHistoryBoundaryRef {
  return {
    generation,
    islandId,
    edge,
    boundaryId: boundary.boundaryId,
    progressKey: boundary.progressKey,
    handle: boundary.handle,
  };
}

function installEntities<TTurn>(
  current: Readonly<Record<string, TTurn>>,
  incoming: readonly CodexHistoryEntity<TTurn>[],
  mergeTurns?: CodexHistoryTurnMerge<TTurn>,
): Readonly<Record<string, TTurn>> {
  if (incoming.length === 0) return current;
  const next: Record<string, TTurn> = { ...current };
  for (const {key, turn} of incoming) {
    const resident = next[key];
    next[key] = resident !== undefined && mergeTurns ? mergeTurns(resident, turn) : turn;
  }
  return next;
}

function dedupeEntries(entries: readonly CodexHistoryEntry[]): readonly CodexHistoryEntry[] {
  const seenEntries = new Set<string>();
  const seenEntities = new Set<string>();
  const next: CodexHistoryEntry[] = [];
  for (const entry of entries) {
    if (seenEntries.has(entry.key) || seenEntities.has(entry.value)) continue;
    seenEntries.add(entry.key);
    seenEntities.add(entry.value);
    next.push(entry);
  }
  return next;
}

function islandsOverlap(left: CodexHistoryIsland, right: CodexHistoryIsland): boolean {
  const leftKeys = new Set(left.entries.map((entry) => entry.value));
  if (right.entries.some((entry) => leftKeys.has(entry.value))) return true;
  return left.newerBoundary.status === "exhausted" && right.olderBoundary.status === "exhausted";
}

function coalesceIslands(
  islands: readonly CodexHistoryIsland[],
  preferredIslandId: string,
  positionsByEntityKey?: Readonly<Record<string, number>>,
): readonly CodexHistoryIsland[] {
  const next: CodexHistoryIsland[] = [];
  for (const island of islands) {
    const previous = next.at(-1);
    if (!previous || !islandsOverlap(previous, island)) {
      next.push(island);
      continue;
    }
    const entries = dedupeEntries([...previous.entries, ...island.entries]);
    next[next.length - 1] = {
      id:
        previous.id === preferredIslandId || island.id !== preferredIslandId
          ? previous.id
          : island.id,
      entries:
        positionsByEntityKey === undefined
          ? entries
          : entries.slice().sort((left, right) => {
              const leftPosition = positionsByEntityKey[left.value];
              const rightPosition = positionsByEntityKey[right.value];
              if (leftPosition === undefined || rightPosition === undefined) return 0;
              return leftPosition - rightPosition;
            }),
      olderBoundary: previous.olderBoundary,
      newerBoundary: island.newerBoundary,
    };
  }
  return next;
}

export function measureCodexHistoryResidency<TTurn extends {readonly items: readonly unknown[]}>(
  topology: CodexCanonicalHistoryTopology<TTurn>,
): CodexHistoryResidency {
  const { islands, entitiesByKey } = topology;
  let itemCount = 0;
  let approximateBytes = 0;
  for (const entity of Object.values(entitiesByKey)) {
    itemCount += entity.items.length;
    approximateBytes += new TextEncoder().encode(JSON.stringify(entity)).byteLength;
  }
  return {
    islandCount: islands.length,
    turnCount: Object.keys(entitiesByKey).length,
    itemCount,
    approximateBytes,
  };
}

function hasExhaustedHistoryBoundaries(islands: readonly CodexHistoryIsland[]): boolean {
  if (islands.length !== 1) return false;
  const island = islands[0];
  if (!island) return false;
  if (island.olderBoundary.status !== "exhausted") return false;
  if (island.newerBoundary.status !== "exhausted") return false;
  return true;
}

function finalizeTopology<TTurn>(input: {
  readonly generation: number;
  readonly isComplete?: boolean;
  readonly islands: readonly CodexHistoryIsland[];
  readonly entitiesByKey: Readonly<Record<string, TTurn>>;
}): CodexCanonicalHistoryTopology<TTurn> {
  return {
    generation: input.generation,
    isComplete: input.isComplete ?? hasExhaustedHistoryBoundaries(input.islands),
    islands: input.islands,
    entitiesByKey: input.entitiesByKey,
  };
}

function validateBoundary(
  boundary: CodexHistoryBoundary,
  boundaryIds: Set<string>,
): CodexHistoryTopologyError | null {
  if (!isNonEmpty(boundary.boundaryId))
    return topologyError("malformedTopology", "History boundary id must be non-empty");
  if (boundaryIds.has(boundary.boundaryId))
    return topologyError("malformedTopology", `Duplicate history boundary ${boundary.boundaryId}`);
  boundaryIds.add(boundary.boundaryId);
  if (boundary.status !== "available") return null;
  if (!isNonEmpty(boundary.handle.cursor))
    return topologyError("malformedTopology", "Available history cursor must be non-empty");

  return null;
}

export function validateCodexHistoryTopology<TTurn>(
  topology: CodexCanonicalHistoryTopology<TTurn>,
): CodexHistoryTopologyError | null {
  if (!Number.isSafeInteger(topology.generation) || topology.generation < 0)
    return topologyError("malformedTopology", "History generation must be a non-negative integer");
  const islandIds = new Set<string>();
  const boundaryIds = new Set<string>();
  const entryKeys = new Set<string>();
  const entityKeys = new Set<string>();
  for (const island of topology.islands) {
    if (!isNonEmpty(island.id) || islandIds.has(island.id))
      return topologyError("malformedTopology", `Duplicate or empty history island ${island.id}`);
    islandIds.add(island.id);
    const olderError = validateBoundary(island.olderBoundary, boundaryIds);
    if (olderError) return olderError;
    const newerError = validateBoundary(island.newerBoundary, boundaryIds);
    if (newerError) return newerError;
    for (const entry of island.entries) {
      if (!isNonEmpty(entry.key) || entryKeys.has(entry.key))
        return topologyError("malformedTopology", `Duplicate or empty history entry ${entry.key}`);
      if (!isNonEmpty(entry.value) || entityKeys.has(entry.value))
        return topologyError(
          "malformedTopology",
          `Duplicate or empty history entity reference ${entry.value}`,
        );
      if (!topology.entitiesByKey[entry.value])
        return topologyError("malformedTopology", `Missing history entity ${entry.value}`);
      entryKeys.add(entry.key);
      entityKeys.add(entry.value);
    }
  }
  if (Object.keys(topology.entitiesByKey).some((key) => !entityKeys.has(key)))
    return topologyError("malformedTopology", "History topology contains an unreferenced entity");
  if (topology.isComplete && !hasExhaustedHistoryBoundaries(topology.islands))
    return topologyError("malformedTopology", "History completeness has unresolved boundaries");
  return null;
}

function validatePage<TTurn>(
  entries: readonly CodexHistoryEntry[],
  entities: readonly CodexHistoryEntity<TTurn>[],
  allowEmpty = false,
): CodexHistoryTopologyError | null {
  if (entries.length === 0 && (!allowEmpty || entities.length !== 0))
    return topologyError("malformedPage", "A history boundary page must contain an entry");
  const entityKeys = new Set(entities.map((entity) => entity.key));
  if (entityKeys.size !== entities.length)
    return topologyError("malformedPage", "A history page contains duplicate entities");
  const entryKeys = new Set<string>();
  const entryEntityKeys = new Set<string>();
  for (const entry of entries) {
    if (entryKeys.has(entry.key) || entryEntityKeys.has(entry.value))
      return topologyError("malformedPage", "A history page contains duplicate entries");
    if (!entityKeys.has(entry.value))
      return topologyError("malformedPage", `History page is missing entity ${entry.value}`);
    entryKeys.add(entry.key);
    entryEntityKeys.add(entry.value);
  }
  return null;
}

export function createEmptyCodexHistoryTopology<TTurn>(
  generation: number,
): CodexCanonicalHistoryTopology<TTurn> {
  return finalizeTopology({ generation, islands: [], entitiesByKey: {} });
}

export function createCodexHistoryIslandTopology<TTurn>(
  input: CreateCodexHistoryIslandInput<TTurn>,
): CodexHistoryTopologyResult<TTurn> {
  const pageError = validatePage(input.entries, input.entities, true);
  if (pageError) return { ok: false, error: pageError };
  const entitiesByKey = installEntities({}, input.entities, input.mergeTurns);
  const topology = finalizeTopology({
    generation: input.generation,
    isComplete: input.isComplete,
    islands: [
      {
        id: input.islandId,
        entries: input.entries,
        olderBoundary: input.olderBoundary,
        newerBoundary: input.newerBoundary,
      },
    ],
    entitiesByKey,
  });
  const topologyError = validateCodexHistoryTopology(topology);
  return topologyError ? { ok: false, error: topologyError } : { ok: true, topology };
}

/** Physical page admission is stricter than topology merging and is rechecked after I/O. */
export function readCurrentCodexHistoryBoundary<TTurn>(
  topology: CodexCanonicalHistoryTopology<TTurn>,
  reference: CodexHistoryBoundaryRef,
): Extract<CodexHistoryBoundary, { status: "available" }> | null {
  if (reference.generation !== topology.generation) return null;
  const island = topology.islands.find((candidate) => candidate.id === reference.islandId);
  const boundary = reference.edge === "older" ? island?.olderBoundary : island?.newerBoundary;
  if (
    boundary?.status !== "available" ||
    boundary.boundaryId !== reference.boundaryId ||
    boundary.progressKey !== reference.progressKey ||
    boundary.handle.cursor !== reference.handle.cursor ||
    boundary.handle.source !== reference.handle.source
  )
    return null;
  return boundary;
}

/** A merged island may retain a boundary after the original island ID disappears. */
export function findCodexHistoryBoundaryIsland<TTurn>(
  topology: CodexCanonicalHistoryTopology<TTurn>,
  reference: CodexHistoryBoundaryRef,
): CodexHistoryIsland | null {
  if (reference.generation !== topology.generation) return null;
  const matches = (island: CodexHistoryIsland): boolean => {
    const boundary = reference.edge === "older" ? island.olderBoundary : island.newerBoundary;
    return (
      boundary.status === "available" &&
      boundary.boundaryId === reference.boundaryId &&
      boundary.progressKey === reference.progressKey
    );
  };
  const named = topology.islands.find((island) => island.id === reference.islandId);
  if (named) return matches(named) ? named : null;
  let found: CodexHistoryIsland | null = null;
  for (const island of topology.islands) {
    if (!matches(island)) continue;
    if (found) return null;
    found = island;
  }
  return found;
}

export function mergeCodexHistoryBoundaryPage<TTurn>(
  topology: CodexCanonicalHistoryTopology<TTurn>,
  input: MergeCodexHistoryBoundaryPageInput<TTurn>,
): CodexHistoryTopologyResult<TTurn> {
  const currentError = validateCodexHistoryTopology(topology);
  if (currentError) return { ok: false, error: currentError };
  if (input.boundary.generation !== topology.generation)
    return {
      ok: false,
      error: topologyError("staleGeneration", "History page belongs to a stale generation"),
    };
  const island = findCodexHistoryBoundaryIsland(topology, input.boundary);
  if (!island)
    return {
      ok: false,
      error: topologyError("boundaryMissing", "History boundary no longer exists"),
    };
  const islandIndex = topology.islands.indexOf(island);
  const currentBoundary =
    input.boundary.edge === "older" ? island.olderBoundary : island.newerBoundary;
  if (currentBoundary.status !== "available")
    return {
      ok: false,
      error: topologyError("boundaryMissing", "History boundary is already exhausted"),
    };
  if (
    currentBoundary.boundaryId !== input.boundary.boundaryId ||
    currentBoundary.progressKey !== input.boundary.progressKey
  )
    return {
      ok: false,
      error: topologyError("staleBoundary", "History boundary advanced before this page committed"),
    };
  const pageError = validatePage(
    input.entries,
    input.entities,
    input.continuation.status === "exhausted",
  );
  if (pageError) return { ok: false, error: pageError };
  if (
    input.continuation.status === "available" &&
    input.continuation.progressKey === currentBoundary.progressKey
  )
    return {
      ok: false,
      error: topologyError("cursorStalled", "History cursor did not advance"),
    };

  const continuation = { ...input.continuation, boundaryId: input.boundary.boundaryId };
  const changedIsland: CodexHistoryIsland = {
    ...island,
    entries:
      input.boundary.edge === "older"
        ? dedupeEntries([...input.entries, ...island.entries])
        : dedupeEntries([...island.entries, ...input.entries]),
    olderBoundary: input.boundary.edge === "older" ? continuation : island.olderBoundary,
    newerBoundary: input.boundary.edge === "newer" ? continuation : island.newerBoundary,
  };
  const islands = [...topology.islands];
  islands[islandIndex] = changedIsland;
  const coalesced = coalesceIslands(islands, island.id);
  const referencedKeys = new Set(
    coalesced.flatMap((candidate) => candidate.entries.map((entry) => entry.value)),
  );
  const installed = installEntities(topology.entitiesByKey, input.entities, input.mergeTurns);
  const entitiesByKey = Object.fromEntries(
    Object.entries(installed).filter(([key]) => referencedKeys.has(key)),
  );
  const next = finalizeTopology({
    generation: topology.generation,
    islands: coalesced,
    entitiesByKey,
  });
  const nextError = validateCodexHistoryTopology(next);
  return nextError ? { ok: false, error: nextError } : { ok: true, topology: next };
}

/** Replaces one resident Turn without rebuilding its island. */
export function replaceCodexHistoryEntity<TTurn>(
  topology: CodexCanonicalHistoryTopology<TTurn>,
  input: ReplaceCodexHistoryEntityInput<TTurn>,
): CodexHistoryTopologyResult<TTurn> {
  const currentError = validateCodexHistoryTopology(topology);
  if (currentError) return { ok: false, error: currentError };
  if (input.expectedGeneration !== topology.generation) {
    return {
      ok: false,
      error: topologyError("staleGeneration", "History entity belongs to a stale generation"),
    };
  }
  if (!topology.entitiesByKey[input.entity.key]) {
    return {
      ok: false,
      error: topologyError("boundaryMissing", "History entity is no longer resident"),
    };
  }
  const next = finalizeTopology({
    generation: topology.generation,
    islands: topology.islands,
    isComplete: topology.isComplete,
    entitiesByKey: installEntities(topology.entitiesByKey, [input.entity]),
  });
  const nextError = validateCodexHistoryTopology(next);
  return nextError ? { ok: false, error: nextError } : { ok: true, topology: next };
}

export function insertCodexHistoryIsland<TTurn>(
  topology: CodexCanonicalHistoryTopology<TTurn>,
  input: Omit<CreateCodexHistoryIslandInput<TTurn>, "generation"> & {
    readonly index: number;
    /** Optional global positions align an overlapping search window around its resident anchor. */
    readonly positionsByEntityKey?: Readonly<Record<string, number>>;
  },
): CodexHistoryTopologyResult<TTurn> {
  const currentError = validateCodexHistoryTopology(topology);
  if (currentError) return { ok: false, error: currentError };
  if (
    !Number.isSafeInteger(input.index) ||
    input.index < 0 ||
    input.index > topology.islands.length
  )
    return { ok: false, error: topologyError("malformedPage", "History island index is invalid") };
  const pageError = validatePage(input.entries, input.entities);
  if (pageError) return { ok: false, error: pageError };
  if (input.positionsByEntityKey) {
    const keys = [
      ...topology.islands.flatMap((island) => island.entries.map((entry) => entry.value)),
      ...input.entries.map((entry) => entry.value),
    ];
    if (
      keys.some((key) => {
        const position = input.positionsByEntityKey?.[key];
        return position === undefined || !Number.isSafeInteger(position);
      })
    ) {
      return {
        ok: false,
        error: topologyError("malformedPage", "History island position map is incomplete"),
      };
    }
  }
  const islands = [...topology.islands];
  islands.splice(input.index, 0, {
    id: input.islandId,
    entries: input.entries,
    olderBoundary: input.olderBoundary,
    newerBoundary: input.newerBoundary,
  });
  const coalesced = coalesceIslands(islands, input.islandId, input.positionsByEntityKey);
  const entitiesByKey = installEntities(topology.entitiesByKey, input.entities, input.mergeTurns);
  const next = finalizeTopology({
    generation: topology.generation,
    islands: coalesced,
    entitiesByKey,
  });
  const nextError = validateCodexHistoryTopology(next);
  return nextError ? { ok: false, error: nextError } : { ok: true, topology: next };
}

function availableBoundaryRef(
  generation: number,
  island: CodexHistoryIsland,
  edge: CodexHistoryBoundaryEdge,
): CodexHistoryBoundaryRef | null {
  const boundary = edge === "older" ? island.olderBoundary : island.newerBoundary;
  return boundary.status === "available"
    ? createCodexHistoryBoundaryRef(generation, island.id, edge, boundary)
    : null;
}

function gapRow(input: {
  readonly olderBoundary: CodexHistoryBoundary | null;
  readonly olderBoundaryRef: CodexHistoryBoundaryRef | null;
  readonly newerBoundary: CodexHistoryBoundary | null;
  readonly newerBoundaryRef: CodexHistoryBoundaryRef | null;
}): Extract<CodexHistoryRow, { kind: "gap" }> | null {
  const hasGap =
    (input.olderBoundary !== null && input.olderBoundary.status !== "exhausted") ||
    (input.newerBoundary !== null && input.newerBoundary.status !== "exhausted");
  if (!hasGap) return null;
  const boundaryKeys = [
    input.olderBoundary
      ? [
          input.olderBoundary.status,
          input.olderBoundary.boundaryId,
          input.olderBoundary.status === "available" ? input.olderBoundary.progressKey : null,
        ]
      : null,
    input.newerBoundary
      ? [
          input.newerBoundary.status,
          input.newerBoundary.boundaryId,
          input.newerBoundary.status === "available" ? input.newerBoundary.progressKey : null,
        ]
      : null,
  ];
  return {
    kind: "gap",
    key: `history-gap:${JSON.stringify(boundaryKeys)}`,
    olderBoundary: input.olderBoundaryRef,
    newerBoundary: input.newerBoundaryRef,
    estimatedHeightPx: CODEX_HISTORY_GAP_ESTIMATED_HEIGHT_PX,
  };
}

export function flattenCodexHistoryTopology<TTurn>(
  topology: CodexCanonicalHistoryTopology<TTurn>,
): readonly CodexHistoryRow[] {
  const rows: CodexHistoryRow[] = [];
  for (const [index, island] of topology.islands.entries()) {
    const previous = topology.islands[index - 1] ?? null;
    const gap = gapRow({
      olderBoundary: previous?.newerBoundary ?? null,
      olderBoundaryRef: previous
        ? availableBoundaryRef(topology.generation, previous, "newer")
        : null,
      newerBoundary: island.olderBoundary,
      newerBoundaryRef: availableBoundaryRef(topology.generation, island, "older"),
    });
    if (gap) rows.push(gap);
    for (const entry of island.entries) {
      rows.push({
        kind: "content",
        key: `history-content:${entry.key}`,
        turnKey: entry.key,
        entityKey: entry.value,
      });
    }
  }
  const last = topology.islands.at(-1);
  const trailingGap = last
    ? gapRow({
        olderBoundary: last.newerBoundary,
        olderBoundaryRef: availableBoundaryRef(topology.generation, last, "newer"),
        newerBoundary: null,
        newerBoundaryRef: null,
      })
    : null;
  if (trailingGap) rows.push(trailingGap);
  return rows;
}
