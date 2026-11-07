import type {
  NativeConversationImportInput,
  NativeConversationImportPreview,
  NativeSessionBackendKind,
  NativeSessionCatalogEntry,
  NativeSessionCatalogPage,
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

/**
 * Interleaves sources by recency. A source with unread pages bounds the list at its oldest loaded
 * conversation, so rows only ever append while history is still being read. A source whose loaded
 * pages had no importable rows yet says nothing about order. Profiles that resolve to the same
 * history home are one source; the first profile represents it.
 */
export function mergeNativeConversationCatalogs(
  catalogs: readonly NativeConversationSourceCatalog[],
): readonly NativeConversationCandidate[] {
  const homes = new Set<string>();
  const distinct = catalogs.filter((catalog) => {
    const home = `${catalog.source.backendKind}\n${catalog.nativeHome}`;
    if (homes.has(home)) return false;
    homes.add(home);
    return true;
  });
  let frontier = Number.NEGATIVE_INFINITY;
  for (const catalog of distinct) {
    const oldest = catalog.candidates.at(-1)?.updatedAt;
    if (catalog.nextCursor !== null && oldest !== undefined) frontier = Math.max(frontier, oldest);
  }
  const seen = new Set<string>();
  return distinct
    .flatMap((catalog) => catalog.candidates)
    .filter((candidate) => {
      if (candidate.updatedAt < frontier || seen.has(candidate.key)) return false;
      seen.add(candidate.key);
      return true;
    })
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

/**
 * Reads one source to its end, continuing after `resume` when given. A source that stops advancing
 * its cursor has ended. Every unfinished step goes to `onProgress`; the result is the whole catalog,
 * or null once `isCurrent` says nobody wants it any more.
 */
export async function readNativeConversationCatalog(input: {
  readonly source: NativeConversationSource;
  readonly resume: NativeConversationSourceCatalog | null;
  readonly list: (cursor: string | null) => Promise<NativeSessionCatalogPage>;
  /** Import-ledger time, stamped before each read is sent. */
  readonly now: () => number;
  readonly isCurrent: () => boolean;
  readonly onProgress: (catalog: NativeConversationSourceCatalog) => void;
}): Promise<NativeConversationSourceCatalog | null> {
  let catalog = input.resume;
  for (;;) {
    const cursor = catalog?.nextCursor ?? null;
    const observedAt = input.now();
    const page = await input.list(cursor);
    if (!input.isCurrent()) return null;
    const candidates = page.entries.map((entry) =>
      nativeConversationCandidate(input.source, page.nativeHome, entry, observedAt),
    );
    catalog = {
      source: input.source,
      nativeHome: page.nativeHome,
      nextCursor: page.nextCursor !== cursor ? page.nextCursor : null,
      candidates:
        catalog?.nativeHome === page.nativeHome
          ? [...catalog.candidates, ...candidates]
          : candidates,
    };
    if (catalog.nextCursor === null) return catalog;
    input.onProgress(catalog);
  }
}

export type NativeConversationStatusFilter = "all" | "not_imported" | "imported" | "selected";

/** What narrows the list. Every dimension is optional; together they intersect. */
export interface NativeConversationFilters {
  readonly query: string;
  readonly sourceKey: string | null;
  readonly cwd: string | null;
  readonly status: NativeConversationStatusFilter;
}

export const NO_NATIVE_CONVERSATION_FILTERS: NativeConversationFilters = {
  query: "",
  sourceKey: null,
  cwd: null,
  status: "all",
};

const searchText = (value: string) => value.normalize("NFKC").toLocaleLowerCase();

export const nativeConversationFiltersActive = (filters: NativeConversationFilters) =>
  filters.query.trim() !== "" ||
  filters.sourceKey !== null ||
  filters.cwd !== null ||
  filters.status !== "all";

/** Every word of the query must appear in the title or the folder, in any order and case. */
export function filterNativeConversations(
  candidates: readonly NativeConversationCandidate[],
  filters: NativeConversationFilters,
  isSelected: (key: string) => boolean,
): readonly NativeConversationCandidate[] {
  const terms = searchText(filters.query).split(/\s+/u).filter(Boolean);
  return candidates.filter((candidate) => {
    if (filters.cwd !== null && candidate.cwd !== filters.cwd) return false;
    if (
      filters.sourceKey !== null &&
      nativeConversationSourceKey(candidate.source) !== filters.sourceKey
    )
      return false;
    if (filters.status === "imported" && !candidate.imported) return false;
    if (filters.status === "not_imported" && candidate.imported) return false;
    if (filters.status === "selected" && !isSelected(candidate.key)) return false;
    if (terms.length === 0) return true;
    const text = searchText(`${candidate.title}\n${candidate.cwd}`);
    return terms.every((term) => text.includes(term));
  });
}

/** How many conversations each folder holds, largest first; ties keep the list's recency order. */
export function nativeConversationFolderCounts(
  candidates: readonly NativeConversationCandidate[],
): readonly { readonly cwd: string; readonly count: number }[] {
  const counts = new Map<string, number>();
  for (const { cwd } of candidates) counts.set(cwd, (counts.get(cwd) ?? 0) + 1);
  return [...counts]
    .map(([cwd, count]) => ({ cwd, count }))
    .sort((left, right) => right.count - left.count);
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
