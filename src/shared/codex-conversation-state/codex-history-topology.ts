import type { ThreadItem, TurnItemsView } from "@nodex/codex-app-server-protocol/v2";

export const CODEX_HISTORY_GAP_ESTIMATED_HEIGHT_PX = 144;

export interface CodexHistoryBoundaryHandle {
  readonly cursor: string;
  readonly oldestLoadedTurnId: string | null;
}

export type CodexHistoryBoundary =
  | {
      readonly status: "exhausted";
      readonly boundaryId: string;
    }
  | {
      readonly status: "available";
      readonly boundaryId: string;
      readonly handle: CodexHistoryBoundaryHandle;
      readonly progressKey: string;
    };

export interface CodexHistoryTurnItemsPagination {
  readonly olderCursor: string | null;
  readonly isLoadingOlder: boolean;
  readonly hasLoadedOldest: boolean;
  readonly oldestUserInput: ThreadItem | null;
  readonly openingUserMessageId: string | null;
  readonly itemsView: TurnItemsView;
}

export interface CodexHistoryEntity<TTurn> {
  readonly key: string;
  readonly turn: TTurn;
  readonly itemCount: number;
  readonly approximateBytes: number;
  readonly itemsPagination: CodexHistoryTurnItemsPagination;
  /** Live mutations always win a stale page; revision orders equal-authority writes. */
  readonly authority: "history" | "live";
  readonly revision: number;
}

export interface CodexHistoryEntry {
  readonly key: string;
  readonly entityKey: string;
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
  readonly entitiesByKey: Readonly<Record<string, CodexHistoryEntity<TTurn>>>;
  readonly residency: CodexHistoryResidency;
}

export type CodexHistoryBoundaryEdge = "older" | "newer";

export interface CodexHistoryBoundaryRef {
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
  readonly islandId: string;
  readonly entries: readonly CodexHistoryEntry[];
  readonly entities: readonly CodexHistoryEntity<TTurn>[];
  readonly olderBoundary: CodexHistoryBoundary;
  readonly newerBoundary: CodexHistoryBoundary;
}

export interface MergeCodexHistoryBoundaryPageInput<TTurn> {
  readonly boundary: CodexHistoryBoundaryRef;
  readonly entries: readonly CodexHistoryEntry[];
  readonly entities: readonly CodexHistoryEntity<TTurn>[];
  readonly continuation: CodexHistoryBoundary;
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
): CodexHistoryBoundary {
  return {
    status: "available",
    boundaryId,
    handle,
    progressKey: codexHistoryBoundaryProgressKey(handle),
  };
}

export function exhaustedCodexHistoryBoundary(boundaryId: string): CodexHistoryBoundary {
  return { status: "exhausted", boundaryId };
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
  };
}

function chooseEntity<TTurn>(
  current: CodexHistoryEntity<TTurn> | undefined,
  incoming: CodexHistoryEntity<TTurn>,
): CodexHistoryEntity<TTurn> {
  if (!current) return incoming;
  if (current.authority === "live" && incoming.authority === "history") return current;
  if (incoming.authority === "live" && current.authority === "history") return incoming;
  return incoming.revision > current.revision ? incoming : current;
}

function installEntities<TTurn>(
  current: Readonly<Record<string, CodexHistoryEntity<TTurn>>>,
  incoming: readonly CodexHistoryEntity<TTurn>[],
): Readonly<Record<string, CodexHistoryEntity<TTurn>>> {
  if (incoming.length === 0) return current;
  const next: Record<string, CodexHistoryEntity<TTurn>> = { ...current };
  for (const entity of incoming) next[entity.key] = chooseEntity(next[entity.key], entity);
  return next;
}

function dedupeEntries(entries: readonly CodexHistoryEntry[]): readonly CodexHistoryEntry[] {
  const seenEntries = new Set<string>();
  const seenEntities = new Set<string>();
  const next: CodexHistoryEntry[] = [];
  for (const entry of entries) {
    if (seenEntries.has(entry.key) || seenEntities.has(entry.entityKey)) continue;
    seenEntries.add(entry.key);
    seenEntities.add(entry.entityKey);
    next.push(entry);
  }
  return next;
}

function islandsOverlap(left: CodexHistoryIsland, right: CodexHistoryIsland): boolean {
  const leftKeys = new Set(left.entries.map((entry) => entry.entityKey));
  if (right.entries.some((entry) => leftKeys.has(entry.entityKey))) return true;
  return left.newerBoundary.status === "exhausted" && right.olderBoundary.status === "exhausted";
}

function coalesceIslands(
  islands: readonly CodexHistoryIsland[],
  preferredIslandId: string,
): readonly CodexHistoryIsland[] {
  const next: CodexHistoryIsland[] = [];
  for (const island of islands) {
    const previous = next.at(-1);
    if (!previous || !islandsOverlap(previous, island)) {
      next.push(island);
      continue;
    }
    next[next.length - 1] = {
      id:
        previous.id === preferredIslandId || island.id !== preferredIslandId
          ? previous.id
          : island.id,
      entries: dedupeEntries([...previous.entries, ...island.entries]),
      olderBoundary: previous.olderBoundary,
      newerBoundary: island.newerBoundary,
    };
  }
  return next;
}

function calculateResidency<TTurn>(
  islands: readonly CodexHistoryIsland[],
  entitiesByKey: Readonly<Record<string, CodexHistoryEntity<TTurn>>>,
): CodexHistoryResidency {
  let itemCount = 0;
  let approximateBytes = 0;
  for (const entity of Object.values(entitiesByKey)) {
    itemCount += entity.itemCount;
    approximateBytes += entity.approximateBytes;
  }
  return {
    islandCount: islands.length,
    turnCount: Object.keys(entitiesByKey).length,
    itemCount,
    approximateBytes,
  };
}

function isTopologyComplete<TTurn>(
  islands: readonly CodexHistoryIsland[],
  entitiesByKey: Readonly<Record<string, CodexHistoryEntity<TTurn>>>,
): boolean {
  if (islands.length !== 1) return false;
  const island = islands[0];
  if (!island) return false;
  if (island.olderBoundary.status !== "exhausted") return false;
  if (island.newerBoundary.status !== "exhausted") return false;
  return island.entries.every((entry) => {
    const entity = entitiesByKey[entry.entityKey];
    return entity?.itemsPagination.itemsView === "full" && entity.itemsPagination.hasLoadedOldest;
  });
}

function finalizeTopology<TTurn>(input: {
  readonly generation: number;
  readonly islands: readonly CodexHistoryIsland[];
  readonly entitiesByKey: Readonly<Record<string, CodexHistoryEntity<TTurn>>>;
}): CodexCanonicalHistoryTopology<TTurn> {
  return {
    generation: input.generation,
    isComplete: isTopologyComplete(input.islands, input.entitiesByKey),
    islands: input.islands,
    entitiesByKey: input.entitiesByKey,
    residency: calculateResidency(input.islands, input.entitiesByKey),
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
  if (boundary.status === "exhausted") return null;
  if (!isNonEmpty(boundary.handle.cursor))
    return topologyError("malformedTopology", "Available history cursor must be non-empty");
  if (boundary.progressKey !== codexHistoryBoundaryProgressKey(boundary.handle))
    return topologyError("malformedTopology", "History boundary progress key is not canonical");
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
    if (island.entries.length === 0)
      return topologyError("malformedTopology", `History island ${island.id} is empty`);
    const olderError = validateBoundary(island.olderBoundary, boundaryIds);
    if (olderError) return olderError;
    const newerError = validateBoundary(island.newerBoundary, boundaryIds);
    if (newerError) return newerError;
    for (const entry of island.entries) {
      if (!isNonEmpty(entry.key) || entryKeys.has(entry.key))
        return topologyError("malformedTopology", `Duplicate or empty history entry ${entry.key}`);
      if (!isNonEmpty(entry.entityKey) || entityKeys.has(entry.entityKey))
        return topologyError(
          "malformedTopology",
          `Duplicate or empty history entity reference ${entry.entityKey}`,
        );
      if (!topology.entitiesByKey[entry.entityKey])
        return topologyError("malformedTopology", `Missing history entity ${entry.entityKey}`);
      entryKeys.add(entry.key);
      entityKeys.add(entry.entityKey);
    }
  }
  if (Object.keys(topology.entitiesByKey).some((key) => !entityKeys.has(key)))
    return topologyError("malformedTopology", "History topology contains an unreferenced entity");
  const expected = finalizeTopology({
    generation: topology.generation,
    islands: topology.islands,
    entitiesByKey: topology.entitiesByKey,
  });
  if (
    topology.isComplete !== expected.isComplete ||
    topology.residency.islandCount !== expected.residency.islandCount ||
    topology.residency.turnCount !== expected.residency.turnCount ||
    topology.residency.itemCount !== expected.residency.itemCount ||
    topology.residency.approximateBytes !== expected.residency.approximateBytes
  )
    return topologyError("malformedTopology", "History completeness or residency is stale");
  return null;
}

function validatePage<TTurn>(
  entries: readonly CodexHistoryEntry[],
  entities: readonly CodexHistoryEntity<TTurn>[],
): CodexHistoryTopologyError | null {
  if (entries.length === 0)
    return topologyError("malformedPage", "A history boundary page must contain an entry");
  const entityKeys = new Set(entities.map((entity) => entity.key));
  if (entityKeys.size !== entities.length)
    return topologyError("malformedPage", "A history page contains duplicate entities");
  const entryKeys = new Set<string>();
  const entryEntityKeys = new Set<string>();
  for (const entry of entries) {
    if (entryKeys.has(entry.key) || entryEntityKeys.has(entry.entityKey))
      return topologyError("malformedPage", "A history page contains duplicate entries");
    if (!entityKeys.has(entry.entityKey))
      return topologyError("malformedPage", `History page is missing entity ${entry.entityKey}`);
    entryKeys.add(entry.key);
    entryEntityKeys.add(entry.entityKey);
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
  const pageError = validatePage(input.entries, input.entities);
  if (pageError) return { ok: false, error: pageError };
  const entitiesByKey = installEntities({}, input.entities);
  const topology = finalizeTopology({
    generation: input.generation,
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
  const islandIndex = topology.islands.findIndex((island) => island.id === input.boundary.islandId);
  if (islandIndex < 0)
    return {
      ok: false,
      error: topologyError("boundaryMissing", "History boundary island no longer exists"),
    };
  const island = topology.islands[islandIndex]!;
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
  const pageError = validatePage(input.entries, input.entities);
  if (pageError) return { ok: false, error: pageError };
  if (
    input.continuation.status === "available" &&
    (input.continuation.handle.cursor === currentBoundary.handle.cursor ||
      input.continuation.progressKey === currentBoundary.progressKey)
  )
    return {
      ok: false,
      error: topologyError("cursorStalled", "History cursor did not advance"),
    };

  const changedIsland: CodexHistoryIsland = {
    ...island,
    entries:
      input.boundary.edge === "older"
        ? dedupeEntries([...input.entries, ...island.entries])
        : dedupeEntries([...island.entries, ...input.entries]),
    olderBoundary: input.boundary.edge === "older" ? input.continuation : island.olderBoundary,
    newerBoundary: input.boundary.edge === "newer" ? input.continuation : island.newerBoundary,
  };
  const islands = [...topology.islands];
  islands[islandIndex] = changedIsland;
  const coalesced = coalesceIslands(islands, island.id);
  const referencedKeys = new Set(
    coalesced.flatMap((candidate) => candidate.entries.map((entry) => entry.entityKey)),
  );
  const installed = installEntities(topology.entitiesByKey, input.entities);
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

export function insertCodexHistoryIsland<TTurn>(
  topology: CodexCanonicalHistoryTopology<TTurn>,
  input: Omit<CreateCodexHistoryIslandInput<TTurn>, "generation"> & { readonly index: number },
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
  const islands = [...topology.islands];
  islands.splice(input.index, 0, {
    id: input.islandId,
    entries: input.entries,
    olderBoundary: input.olderBoundary,
    newerBoundary: input.newerBoundary,
  });
  const coalesced = coalesceIslands(islands, input.islandId);
  const entitiesByKey = installEntities(topology.entitiesByKey, input.entities);
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

function gapRow(
  olderBoundary: CodexHistoryBoundaryRef | null,
  newerBoundary: CodexHistoryBoundaryRef | null,
): Extract<CodexHistoryRow, { kind: "gap" }> | null {
  if (!olderBoundary && !newerBoundary) return null;
  const boundaryKeys = [
    olderBoundary
      ? [
          olderBoundary.islandId,
          olderBoundary.edge,
          olderBoundary.boundaryId,
          olderBoundary.progressKey,
        ]
      : null,
    newerBoundary
      ? [
          newerBoundary.islandId,
          newerBoundary.edge,
          newerBoundary.boundaryId,
          newerBoundary.progressKey,
        ]
      : null,
  ];
  return {
    kind: "gap",
    key: `history-gap:${JSON.stringify(boundaryKeys)}`,
    olderBoundary,
    newerBoundary,
    estimatedHeightPx: CODEX_HISTORY_GAP_ESTIMATED_HEIGHT_PX,
  };
}

export function flattenCodexHistoryTopology<TTurn>(
  topology: CodexCanonicalHistoryTopology<TTurn>,
): readonly CodexHistoryRow[] {
  const rows: CodexHistoryRow[] = [];
  for (const [index, island] of topology.islands.entries()) {
    const previous = topology.islands[index - 1] ?? null;
    const gap = gapRow(
      previous ? availableBoundaryRef(topology.generation, previous, "newer") : null,
      availableBoundaryRef(topology.generation, island, "older"),
    );
    if (gap) rows.push(gap);
    for (const entry of island.entries) {
      rows.push({
        kind: "content",
        key: `history-content:${entry.key}`,
        turnKey: entry.key,
        entityKey: entry.entityKey,
      });
    }
  }
  const last = topology.islands.at(-1);
  const trailingGap = last
    ? gapRow(availableBoundaryRef(topology.generation, last, "newer"), null)
    : null;
  if (trailingGap) rows.push(trailingGap);
  return rows;
}
