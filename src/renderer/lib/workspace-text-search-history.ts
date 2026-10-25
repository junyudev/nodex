import { persistedAtom, usePersistedAtomValue, useSetPersistedAtom } from "./maitai";
import { isWorkspaceTextSearchQueryValid } from "../../shared/workspace-text-search";
import type { FileSearchScope } from "../../shared/file-search";

export interface WorkspaceTextSearchHistoryEntry {
  readonly key: string;
  readonly fileMask: string;
  readonly queries: readonly string[];
  readonly masks: readonly string[];
}
export type WorkspaceTextSearchHistory = readonly WorkspaceTextSearchHistoryEntry[];

const MAX_SCOPES = 20;
const MAX_QUERIES = 30;
const MAX_MASKS = 20;
const EMPTY_VALUES: readonly string[] = [];

/** Folder overrides change the search target without replacing the Project's recalled values. */
export function workspaceTextSearchHistoryScope(
  contextScope: FileSearchScope | null,
  searchScope: FileSearchScope | null,
): FileSearchScope | null {
  if (!contextScope?.roots.length || contextScope.hostId !== searchScope?.hostId)
    return searchScope;
  return contextScope;
}

export function workspaceTextSearchHistoryKey(
  hostId: string,
  projectRoots: readonly string[],
): string {
  return JSON.stringify([hostId, projectRoots]);
}

const boundedStrings = (value: unknown, limit: number): string[] =>
  Array.isArray(value)
    ? [
        ...new Set(
          value.filter(
            (item): item is string =>
              typeof item === "string" &&
              item.length <= 256 &&
              item.trim().length > 0 &&
              !/[\r\n\0]/u.test(item),
          ),
        ),
      ].slice(0, limit)
    : [];

export function decodeWorkspaceTextSearchHistory(value: unknown): WorkspaceTextSearchHistory {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value
    .flatMap((entry: unknown) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const record = entry as Record<string, unknown>;
      if (typeof record.key !== "string" || seen.has(record.key)) return [];
      seen.add(record.key);
      return [
        {
          key: record.key,
          fileMask: typeof record.fileMask === "string" ? record.fileMask.slice(0, 256) : "",
          queries: boundedStrings(record.queries, MAX_QUERIES),
          masks: boundedStrings(record.masks, MAX_MASKS),
        },
      ];
    })
    .slice(0, MAX_SCOPES);
}

/** Editing keeps the current mask; only committing adds a mask to recall history. */
export function updateWorkspaceTextSearchHistory(
  history: WorkspaceTextSearchHistory,
  input: {
    readonly key: string;
    readonly fileMask: string;
    readonly query?: string;
    readonly commit: boolean;
  },
): WorkspaceTextSearchHistory {
  const current = history.find((entry) => entry.key === input.key);
  const query = input.query && isWorkspaceTextSearchQueryValid(input.query) ? input.query : null;
  const mask = input.fileMask.trim();
  return [
    {
      key: input.key,
      fileMask: input.fileMask,
      queries: [...new Set([...(query ? [query] : []), ...(current?.queries ?? [])])].slice(
        0,
        MAX_QUERIES,
      ),
      masks: [
        ...new Set([...(input.commit && mask ? [mask] : []), ...(current?.masks ?? [])]),
      ].slice(0, MAX_MASKS),
    },
    ...history.filter((entry) => entry.key !== input.key),
  ].slice(0, MAX_SCOPES);
}

const workspaceTextSearchHistoryAtom = persistedAtom<WorkspaceTextSearchHistory>({
  debugLabel: "workspace-text-search-history",
  storageKey: "workspace-text-search-history",
  defaultValue: [],
  hydration: "eager",
  synchronization: "cross-window",
  optimistic: true,
  writeFailure: "retain-and-error",
  decode: decodeWorkspaceTextSearchHistory,
});

export function useWorkspaceTextSearchHistory(input: {
  readonly hostId: string;
  readonly projectRoots: readonly string[];
}) {
  const history = usePersistedAtomValue(workspaceTextSearchHistoryAtom);
  const write = useSetPersistedAtom(workspaceTextSearchHistoryAtom);
  const key = workspaceTextSearchHistoryKey(input.hostId, input.projectRoots);
  const entry = history.value.find((candidate) => candidate.key === key);
  const fileMask = entry?.fileMask ?? "";
  const update = (mask: string, query: string | undefined, commit: boolean) => {
    if (!input.hostId || input.projectRoots.length === 0) return;
    void write((current) =>
      updateWorkspaceTextSearchHistory(current, { key, fileMask: mask, query, commit }),
    ).catch(() => {
      // The recalled values remain available in this window; a later edit retries persistence.
    });
  };
  return {
    fileMask,
    queries: entry?.queries ?? EMPTY_VALUES,
    masks: entry?.masks ?? EMPTY_VALUES,
    setFileMask: (mask: string) => update(mask, undefined, false),
    commit: (query?: string, mask = fileMask) => update(mask, query, true),
  };
}
export type WorkspaceTextSearchHistoryController = ReturnType<typeof useWorkspaceTextSearchHistory>;
