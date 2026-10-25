import { useEffect, useState } from "react";
import type { FileSearchScope } from "../../shared/file-search";
import { compactFileSearchRoots } from "../../shared/file-search-paths";
import {
  isWorkspaceTextSearchQueryValid,
  parseWorkspaceTextSearchFileMask,
  type WorkspaceTextSearchErrorCode,
  type WorkspaceTextSearchMatch,
} from "../../shared/workspace-text-search";
import { createWorkspaceTextSearch } from "./workspace-text-search-operations";

const EMPTY_MATCHES: readonly WorkspaceTextSearchMatch[] = [];
const SEARCH_DEBOUNCE_MS = 50;

export interface WorkspaceTextSearchResult {
  readonly matches: readonly WorkspaceTextSearchMatch[];
  readonly matchesCurrent: boolean;
  readonly loading: boolean;
  readonly refreshing: boolean;
  readonly limited: boolean;
  readonly error: WorkspaceTextSearchErrorCode | null;
  readonly queryValid: boolean;
  readonly requestKey: string;
}

interface SearchBatch {
  readonly generation: number;
  readonly scopeKey: string;
  readonly requestKey: string;
  readonly matches: readonly WorkspaceTextSearchMatch[];
  readonly loading: boolean;
  readonly limited: boolean;
  readonly error: WorkspaceTextSearchErrorCode | null;
}

/** Retain a same-scope preview while refreshing, but never make stale matches executable. */
export function useWorkspaceTextSearch(input: {
  readonly enabled: boolean;
  readonly scope: FileSearchScope | null;
  readonly query: string;
  readonly fileMask?: string;
  readonly priorityFolders?: readonly string[];
}): WorkspaceTextSearchResult {
  const hostId = input.scope?.hostId ?? "";
  const rootsKey = JSON.stringify(compactFileSearchRoots(input.scope?.roots ?? []));
  const scopeKey = JSON.stringify([hostId, rootsKey]);
  const priorityFoldersKey = JSON.stringify([...new Set(input.priorityFolders ?? [])].slice(0, 20));
  const query = input.query;
  const fileMask = input.fileMask ?? "";
  const requestKey = JSON.stringify([scopeKey, query, fileMask, priorityFoldersKey]);
  const queryValid = query.trim().length === 0 || isWorkspaceTextSearchQueryValid(query);
  const maskValid = parseWorkspaceTextSearchFileMask(fileMask) !== null;
  const enabled = input.enabled && Boolean(hostId) && rootsKey !== "[]";
  const searchable = enabled && query.trim().length > 0 && queryValid && maskValid;
  const [batch, setBatch] = useState<SearchBatch | null>(null);
  const [identity, setIdentity] = useState({ requestKey, searchable, generation: 0 });
  if (identity.requestKey !== requestKey || identity.searchable !== searchable) {
    setIdentity({ requestKey, searchable, generation: identity.generation + 1 });
  }
  const generation = identity.generation;

  useEffect(() => {
    if (!searchable) return;
    let active = true;
    let controller: ReturnType<typeof createWorkspaceTextSearch> | null = null;
    const matches: WorkspaceTextSearchMatch[] = [];
    const timer = setTimeout(() => {
      controller = createWorkspaceTextSearch({
        hostId,
        roots: JSON.parse(rootsKey) as string[],
        query,
        fileMask,
        priorityFolders: JSON.parse(priorityFoldersKey) as string[],
        onEvent: (event) => {
          if (!active) return;
          if (event.type === "match") matches.push(event.match);
          setBatch({
            generation,
            scopeKey,
            requestKey,
            matches: [...matches],
            loading: event.type === "match",
            limited: event.type === "done" && event.limited,
            error: event.type === "error" ? event.code : null,
          });
        },
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      active = false;
      clearTimeout(timer);
      void controller?.stop().catch((error: unknown) => {
        console.warn("Could not stop workspace text search", error);
      });
    };
  }, [
    searchable,
    hostId,
    rootsKey,
    scopeKey,
    query,
    fileMask,
    priorityFoldersKey,
    requestKey,
    generation,
  ]);

  const current = batch?.requestKey === requestKey && batch.generation === generation;
  const retained = searchable && batch?.scopeKey === scopeKey;
  const matches = retained ? batch.matches : EMPTY_MATCHES;
  const loading = searchable && (!current || batch.loading);
  const error = !enabled
    ? null
    : !queryValid
      ? "invalid-query"
      : !maskValid
        ? "invalid-file-mask"
        : current && searchable
          ? batch.error
          : null;
  return {
    matches,
    matchesCurrent: searchable && current,
    loading,
    refreshing: loading && !current && matches.length > 0,
    limited: searchable && current && batch.limited,
    error,
    queryValid,
    requestKey,
  };
}
