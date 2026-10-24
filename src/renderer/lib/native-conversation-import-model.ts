import type {
  NativeConversationImportInput,
  NativeConversationImportPreview,
  NativeSessionBackendKind,
  NativeSessionCatalogEntry,
} from "../../shared/native-session-catalog";

/** A configured history the user can import from: the active Codex home or one Claude profile. */
export interface NativeConversationSource {
  readonly backendKind: NativeSessionBackendKind;
  readonly instanceConfigId?: string;
  /** Present only when several sources of the same Agent need telling apart. */
  readonly profileName?: string;
}

export interface NativeConversationCopy {
  readonly threadId: string;
  readonly sessionId: string;
}

/** One source conversation, identified by Agent, canonical history home and native ID. */
export interface NativeConversationCandidate {
  readonly key: string;
  readonly source: NativeConversationSource;
  readonly nativeSessionId: string;
  readonly nativeHome: string;
  readonly title: string;
  readonly cwd: string;
  readonly cwdAvailable: boolean;
  readonly updatedAt: number;
  /** The existing independent copy; opening it is preferred over importing again. */
  readonly imported: NativeConversationCopy | null;
  /** Import-ledger time at which the read that produced this candidate was sent. */
  readonly observedAt: number;
}

export const nativeConversationSourceKey = (source: NativeConversationSource) =>
  source.backendKind === "claude" ? `claude:${source.instanceConfigId ?? ""}` : "codex";

export function nativeConversationCandidate(
  source: NativeConversationSource,
  nativeHome: string,
  entry: NativeSessionCatalogEntry | NativeConversationImportPreview,
  observedAt: number,
): NativeConversationCandidate {
  return {
    key: `${source.backendKind}\n${nativeHome}\n${entry.nativeSessionId}`,
    source,
    nativeSessionId: entry.nativeSessionId,
    nativeHome,
    title: entry.title,
    cwd: entry.cwd,
    cwdAvailable: entry.cwdAvailable !== false,
    updatedAt: entry.updatedAt,
    imported:
      entry.importedThreadId && entry.importedSessionId
        ? { threadId: entry.importedThreadId, sessionId: entry.importedSessionId }
        : null,
    observedAt,
  };
}

/**
 * One candidate per source, in first-seen order, each carrying its newest observation: a later read
 * decides whether a copy or the original folder still exists, wherever the row was first placed.
 */
export function latestNativeConversationCandidates(
  candidates: readonly NativeConversationCandidate[],
): NativeConversationCandidate[] {
  const newest = new Map<string, NativeConversationCandidate>();
  for (const candidate of candidates) {
    const known = newest.get(candidate.key);
    if (!known || candidate.observedAt > known.observedAt) newest.set(candidate.key, candidate);
  }
  const placed = new Set<string>();
  return candidates.flatMap((candidate) => {
    if (placed.has(candidate.key)) return [];
    placed.add(candidate.key);
    return [newest.get(candidate.key)!];
  });
}

/** Pages read from one source so far, in the source's newest-first order. */
export interface NativeConversationSourceCatalog {
  readonly source: NativeConversationSource;
  readonly nativeHome: string;
  readonly candidates: readonly NativeConversationCandidate[];
  readonly nextCursor: string | null;
}

export interface MergedNativeConversations {
  readonly candidates: readonly NativeConversationCandidate[];
  /** The source whose next page extends the list; null once every source is exhausted. */
  readonly next: NativeConversationSourceCatalog | null;
}

/**
 * Interleaves sources by recency. A source with unread pages bounds the list at its oldest loaded
 * conversation, so loading more appends older rows. A source whose loaded pages had no importable
 * rows cannot bound anything; it is read next, and the catalog reader drains such pages so this
 * stays a transient state. Profiles that resolve to the same history home are one source; the first
 * profile represents it.
 */
export function mergeNativeConversationCatalogs(
  catalogs: readonly NativeConversationSourceCatalog[],
): MergedNativeConversations {
  const homes = new Set<string>();
  const distinct = catalogs.filter((catalog) => {
    const home = `${catalog.source.backendKind}\n${catalog.nativeHome}`;
    if (homes.has(home)) return false;
    homes.add(home);
    return true;
  });
  let frontier = Number.NEGATIVE_INFINITY;
  let next: NativeConversationSourceCatalog | null = null;
  let nextOldest = Number.NEGATIVE_INFINITY;
  for (const catalog of distinct) {
    if (catalog.nextCursor === null) continue;
    const oldest = catalog.candidates.at(-1)?.updatedAt;
    // A source with a cursor but no readable rows yet says nothing about order; read it first.
    if (oldest === undefined) {
      if (nextOldest !== Number.POSITIVE_INFINITY) next = catalog;
      nextOldest = Number.POSITIVE_INFINITY;
      continue;
    }
    frontier = Math.max(frontier, oldest);
    if (oldest > nextOldest) {
      next = catalog;
      nextOldest = oldest;
    }
  }
  const seen = new Set<string>();
  const candidates = distinct
    .flatMap((catalog) => catalog.candidates)
    .filter((candidate) => {
      if (candidate.updatedAt < frontier || seen.has(candidate.key)) return false;
      seen.add(candidate.key);
      return true;
    })
    .sort((left, right) => right.updatedAt - left.updatedAt);
  return { candidates, next };
}

export type NativeConversationImportSelection = Omit<
  NativeConversationImportInput,
  "requestId" | "acceptedAt"
>;

export function nativeConversationImportSelection(
  candidate: NativeConversationCandidate,
  projectId: string | null,
  cwd: string,
): NativeConversationImportSelection {
  const { backendKind, instanceConfigId } = candidate.source;
  return {
    backendKind,
    ...(backendKind === "claude" && instanceConfigId ? { instanceConfigId } : {}),
    nativeSessionId: candidate.nativeSessionId,
    expectedHome: candidate.nativeHome,
    projectId,
    cwd,
  };
}

/** A new import request. Retrying an unsettled attempt reuses its request instead. */
export function acceptNativeConversationImport(
  selection: NativeConversationImportSelection,
): NativeConversationImportInput {
  return { ...selection, requestId: crypto.randomUUID(), acceptedAt: Date.now() };
}

/**
 * The directory an import will run in. A missing original needs an explicit replacement; the user's
 * choice for that original applies to every conversation that came from it.
 */
export function nativeConversationImportCwd(
  candidate: NativeConversationCandidate,
  replacements: ReadonlyMap<string, string>,
): string | null {
  return candidate.cwdAvailable ? candidate.cwd : (replacements.get(candidate.cwd) ?? null);
}
