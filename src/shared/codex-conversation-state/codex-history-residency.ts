import {
  createCodexHistoryIslandTopology,
  createEmptyCodexHistoryTopology,
  insertCodexHistoryIsland,
  opaqueCodexHistoryBoundary,
  type CodexCanonicalHistoryTopology,
  type CodexHistoryBoundary,
  type CodexHistoryEntity,
  type CodexHistoryEntry,
} from "./codex-history-topology";

export const DEFAULT_CODEX_ACTIVE_HISTORY_MAX_TURNS = 100;
export const DEFAULT_CODEX_ACTIVE_HISTORY_MAX_APPROXIMATE_BYTES = 16 * 1024 * 1024;
export const DEFAULT_CODEX_ACTIVE_HISTORY_TAIL_TURNS = 5;

export interface CodexHistoryResidencyLimits {
  readonly maxTurns: number;
  readonly maxApproximateBytes: number;
}

export interface RetainCodexHistoryResidencyInput {
  readonly limits?: Partial<CodexHistoryResidencyLimits>;
  /** The latest bounded tail survives even when configured limits are smaller than it. */
  readonly tailTurnCount?: number;
  /** Visible/search islands are protected as one coherent resident unit. */
  readonly protectedIslandIds?: ReadonlySet<string> | readonly string[];
  /** Exact visible or operation-pinned Turns that may not be released. */
  readonly protectedEntityKeys?: ReadonlySet<string> | readonly string[];
}

export interface CodexHistoryResidencyRetention<TTurn> {
  readonly topology: CodexCanonicalHistoryTopology<TTurn>;
  readonly limits: CodexHistoryResidencyLimits;
  readonly retainedEntityKeys: readonly string[];
  readonly evictedEntityKeys: readonly string[];
  readonly protectedEntityKeys: readonly string[];
  readonly limitsSatisfied: boolean;
  /** True only when non-negotiable tail/visible state alone exceeds a configured limit. */
  readonly protectedResidencyExceedsLimits: boolean;
}

interface OrderedEntity<TTurn> {
  readonly islandId: string;
  readonly entry: CodexHistoryEntry;
  readonly entity: CodexHistoryEntity<TTurn>;
}

interface RetainedSegment<TTurn> {
  readonly islandId: string;
  readonly entries: readonly CodexHistoryEntry[];
  readonly entities: readonly CodexHistoryEntity<TTurn>[];
  readonly olderBoundary: CodexHistoryBoundary;
  readonly newerBoundary: CodexHistoryBoundary;
}

function finiteNonNegativeInteger(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function entityBytes<TTurn>(entity: CodexHistoryEntity<TTurn>): number {
  return finiteNonNegativeInteger(entity.approximateBytes, Number.MAX_SAFE_INTEGER);
}

function asSet(values: ReadonlySet<string> | readonly string[] | undefined): ReadonlySet<string> {
  if (!values) return new Set();
  return new Set(values);
}

function orderedEntities<TTurn>(
  topology: CodexCanonicalHistoryTopology<TTurn>,
): readonly OrderedEntity<TTurn>[] {
  return topology.islands.flatMap((island) =>
    island.entries.map((entry) => {
      const entity = topology.entitiesByKey[entry.entityKey];
      if (!entity) throw new Error(`History topology is missing entity ${entry.entityKey}`);
      return { islandId: island.id, entry, entity };
    }),
  );
}

function latestWritableIslandIndex<TTurn>(topology: CodexCanonicalHistoryTopology<TTurn>): number {
  for (let index = topology.islands.length - 1; index >= 0; index -= 1) {
    if (topology.islands[index]?.newerBoundary.status === "exhausted") return index;
  }
  return topology.islands.length - 1;
}

function opaqueBoundaryId(input: {
  readonly generation: number;
  readonly islandId: string;
  readonly segmentStart: number;
  readonly segmentEnd: number;
  readonly edge: "older" | "newer";
}): string {
  return `retention:${JSON.stringify([
    input.generation,
    input.islandId,
    input.segmentStart,
    input.segmentEnd,
    input.edge,
  ])}`;
}

function retainedSegments<TTurn>(
  topology: CodexCanonicalHistoryTopology<TTurn>,
  retainedKeys: ReadonlySet<string>,
): readonly RetainedSegment<TTurn>[] {
  const segments: RetainedSegment<TTurn>[] = [];
  for (const island of topology.islands) {
    let segmentStart = -1;
    for (let index = 0; index <= island.entries.length; index += 1) {
      const entry = island.entries[index];
      const retained = entry ? retainedKeys.has(entry.entityKey) : false;
      if (retained && segmentStart < 0) {
        segmentStart = index;
        continue;
      }
      if (retained || segmentStart < 0) continue;

      const segmentEnd = index - 1;
      const entries = island.entries.slice(segmentStart, index);
      const entities = entries.map((segmentEntry) => {
        const entity = topology.entitiesByKey[segmentEntry.entityKey];
        if (!entity)
          throw new Error(`History topology is missing entity ${segmentEntry.entityKey}`);
        return entity;
      });
      const spansIsland = segmentStart === 0 && segmentEnd === island.entries.length - 1;
      segments.push({
        islandId: spansIsland ? island.id : `${island.id}:resident:${segmentStart}-${segmentEnd}`,
        entries,
        entities,
        olderBoundary:
          segmentStart === 0
            ? island.olderBoundary
            : opaqueCodexHistoryBoundary(
                opaqueBoundaryId({
                  generation: topology.generation,
                  islandId: island.id,
                  segmentStart,
                  segmentEnd,
                  edge: "older",
                }),
              ),
        newerBoundary:
          segmentEnd === island.entries.length - 1
            ? island.newerBoundary
            : opaqueCodexHistoryBoundary(
                opaqueBoundaryId({
                  generation: topology.generation,
                  islandId: island.id,
                  segmentStart,
                  segmentEnd,
                  edge: "newer",
                }),
              ),
      });
      segmentStart = -1;
    }
  }
  return segments;
}

function topologyFromSegments<TTurn>(input: {
  readonly generation: number;
  readonly segments: readonly RetainedSegment<TTurn>[];
}): CodexCanonicalHistoryTopology<TTurn> {
  const first = input.segments[0];
  if (!first) return createEmptyCodexHistoryTopology(input.generation);
  const created = createCodexHistoryIslandTopology({
    generation: input.generation,
    ...first,
  });
  if (!created.ok) throw new Error(created.error.message);
  let topology = created.topology;
  for (const segment of input.segments.slice(1)) {
    const inserted = insertCodexHistoryIsland(topology, {
      index: topology.islands.length,
      ...segment,
    });
    if (!inserted.ok) throw new Error(inserted.error.message);
    topology = inserted.topology;
  }
  return topology;
}

/**
 * Applies a two-dimensional active-history budget without weakening sparse-history truth.
 *
 * The newest writable tail and caller-protected visible/search state are non-negotiable. Remaining
 * capacity is filled newest-first. A cut through a loaded island becomes an inert opaque boundary;
 * only boundaries that already carried a real server cursor remain loadable.
 */
export function retainCodexHistoryResidency<TTurn>(
  topology: CodexCanonicalHistoryTopology<TTurn>,
  input: RetainCodexHistoryResidencyInput = {},
): CodexHistoryResidencyRetention<TTurn> {
  const limits: CodexHistoryResidencyLimits = {
    maxTurns: finiteNonNegativeInteger(
      input.limits?.maxTurns ?? DEFAULT_CODEX_ACTIVE_HISTORY_MAX_TURNS,
      DEFAULT_CODEX_ACTIVE_HISTORY_MAX_TURNS,
    ),
    maxApproximateBytes: finiteNonNegativeInteger(
      input.limits?.maxApproximateBytes ?? DEFAULT_CODEX_ACTIVE_HISTORY_MAX_APPROXIMATE_BYTES,
      DEFAULT_CODEX_ACTIVE_HISTORY_MAX_APPROXIMATE_BYTES,
    ),
  };
  const ordered = orderedEntities(topology);
  if (ordered.length === 0) {
    return {
      topology,
      limits,
      retainedEntityKeys: [],
      evictedEntityKeys: [],
      protectedEntityKeys: [],
      limitsSatisfied: true,
      protectedResidencyExceedsLimits: false,
    };
  }

  const protectedIslandIds = asSet(input.protectedIslandIds);
  const protectedKeys = new Set(asSet(input.protectedEntityKeys));
  for (const value of ordered) {
    if (protectedIslandIds.has(value.islandId)) protectedKeys.add(value.entity.key);
  }

  const tailIslandIndex = latestWritableIslandIndex(topology);
  const tailEntries = topology.islands[tailIslandIndex]?.entries ?? [];
  const tailTurnCount = Math.max(
    1,
    finiteNonNegativeInteger(
      input.tailTurnCount ?? DEFAULT_CODEX_ACTIVE_HISTORY_TAIL_TURNS,
      DEFAULT_CODEX_ACTIVE_HISTORY_TAIL_TURNS,
    ),
  );
  for (const entry of tailEntries.slice(-tailTurnCount)) protectedKeys.add(entry.entityKey);

  let retainedBytes = 0;
  const retainedKeys = new Set<string>();
  for (const value of ordered) {
    if (!protectedKeys.has(value.entity.key)) continue;
    retainedKeys.add(value.entity.key);
    retainedBytes += entityBytes(value.entity);
  }
  const protectedResidencyExceedsLimits =
    retainedKeys.size > limits.maxTurns || retainedBytes > limits.maxApproximateBytes;

  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const value = ordered[index];
    if (!value || retainedKeys.has(value.entity.key)) continue;
    const nextBytes = retainedBytes + entityBytes(value.entity);
    if (retainedKeys.size + 1 > limits.maxTurns) break;
    if (nextBytes > limits.maxApproximateBytes) break;
    retainedKeys.add(value.entity.key);
    retainedBytes = nextBytes;
  }

  const retainedEntityKeys = ordered
    .filter((value) => retainedKeys.has(value.entity.key))
    .map((value) => value.entity.key);
  const evictedEntityKeys = ordered
    .filter((value) => !retainedKeys.has(value.entity.key))
    .map((value) => value.entity.key);
  const nextTopology =
    evictedEntityKeys.length === 0
      ? topology
      : topologyFromSegments({
          generation: topology.generation,
          segments: retainedSegments(topology, retainedKeys),
        });

  return {
    topology: nextTopology,
    limits,
    retainedEntityKeys,
    evictedEntityKeys,
    protectedEntityKeys: ordered
      .filter((value) => protectedKeys.has(value.entity.key))
      .map((value) => value.entity.key),
    limitsSatisfied:
      nextTopology.residency.turnCount <= limits.maxTurns &&
      nextTopology.residency.approximateBytes <= limits.maxApproximateBytes,
    protectedResidencyExceedsLimits,
  };
}
