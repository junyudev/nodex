import { useEffect, useMemo, useState } from "react";
import { invokeRendererQuery as invoke } from "./renderer-command";
import {
  filterCommandPaletteItems,
  prioritizeActiveProjectItems,
  type CommandMenuMode,
  type CommandPaletteThread,
} from "./command-palette";
import {
  buildCommandPaletteCharacterHighlightSegments,
  buildCommandPaletteQueryHighlightPreview,
} from "./command-palette-highlight";
import { normalizeSearchText as normalizeCommandPaletteSearchText } from "./search-text";
import type { CommandPaletteThreadSearchResult, CommandPaletteThreadSummary } from "./types";
import {
  createCommandPaletteThreadSearchIndex,
  type CommandPaletteThreadSearchHit,
  type CommandPaletteThreadSearchIndex,
} from "./command-palette-thread-search";

const DEFAULT_THREAD_LIMIT = 9;
const CONTENT_SEARCH_LIMIT = 60;
const THREAD_SEARCH_DEBOUNCE_MS = 200;
const THREAD_SEARCH_CACHE_TTL_MS = 30_000;

interface ThreadSearchCacheEntry {
  readonly expiresAt: number;
  readonly results: readonly CommandPaletteThreadSearchResult[];
}

const commandPaletteThreadItemsCache = new Map<string | null, CommandPaletteThread[]>();
const threadSearchCache = new Map<string, ThreadSearchCacheEntry>();
const threadSearchInFlight = new Map<
  string,
  Promise<readonly CommandPaletteThreadSearchResult[]>
>();

export interface CommandPaletteThreadItemsState {
  threads: readonly CommandPaletteThread[];
  loading: boolean;
}

export interface CommandPaletteThreadSearchBatch {
  query: string;
  results: readonly CommandPaletteThreadSearchResult[];
  loading: boolean;
  error: string | null;
}

export interface CommandPaletteThreadSearchPlan {
  includeContentResults: boolean;
  maxResults: number;
}

export function getCommandPaletteThreadSearchPlan(
  mode: CommandMenuMode,
  query: string,
): CommandPaletteThreadSearchPlan | null {
  const length = query.trim().length;
  if (mode === "root") {
    if (length < 2) return null;
    return { includeContentResults: length >= 3, maxResults: DEFAULT_THREAD_LIMIT };
  }
  if (mode === "chats") {
    return { includeContentResults: length > 0, maxResults: DEFAULT_THREAD_LIMIT };
  }
  return null;
}

export function buildCommandPaletteThreadItem(
  summary: CommandPaletteThreadSummary,
  activeProjectId: string | null,
): CommandPaletteThread {
  return {
    kind: "thread",
    id: `thread:${summary.threadId}`,
    threadId: summary.threadId,
    sessionId: summary.sessionId,
    projectId: summary.projectId,
    projectName: summary.projectName,
    title: summary.title,
    preview: summary.preview,
    cwd: summary.cwd,
    gitBranch: summary.gitBranch,
    projectless: summary.projectless,
    pinned: summary.pinned,
    pinnedOrder: summary.pinnedOrder,
    statusType: summary.statusType,
    statusActiveFlags: summary.statusActiveFlags,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    inActiveProject: summary.projectId !== null && summary.projectId === activeProjectId,
  };
}

export async function listCommandPaletteThreadItems({
  activeProjectId,
}: {
  activeProjectId: string | null;
}): Promise<CommandPaletteThread[]> {
  try {
    const summaries = await invoke("codex:threads:palette:list", { scope: "sidebar" });
    return summaries.map((summary) => buildCommandPaletteThreadItem(summary, activeProjectId));
  } catch {
    return [];
  }
}

export function useCommandPaletteThreadItems({
  enabled,
  activeProjectId,
  refreshKey,
}: {
  enabled: boolean;
  activeProjectId: string | null;
  refreshKey: number;
}): CommandPaletteThreadItemsState {
  const [state, setState] = useState<CommandPaletteThreadItemsState>(() => ({
    threads: commandPaletteThreadItemsCache.get(activeProjectId) ?? [],
    loading: false,
  }));

  useEffect(() => {
    if (!enabled) {
      setState((current) =>
        current.threads.length === 0 && !current.loading
          ? current
          : { threads: [], loading: false },
      );
      return;
    }

    let cancelled = false;
    const cachedThreads = commandPaletteThreadItemsCache.get(activeProjectId);
    setState((current) => ({ threads: cachedThreads ?? current.threads, loading: true }));
    void listCommandPaletteThreadItems({ activeProjectId }).then((threads) => {
      if (cancelled) return;
      commandPaletteThreadItemsCache.set(activeProjectId, threads);
      setState({ threads, loading: false });
    });

    return () => {
      cancelled = true;
    };
  }, [activeProjectId, enabled, refreshKey]);

  return state;
}

export function buildThreadSearchPreview(
  excerpt: string,
  query: string,
): CommandPaletteThread["searchPreview"] {
  const preview = buildCommandPaletteQueryHighlightPreview(excerpt, query);
  if (!preview) return null;
  return { ...preview, source: "content" };
}

function buildThreadSearchCacheKey(query: string, limit: number): string {
  return `${normalizeCommandPaletteSearchText(query)}\u0000${limit}`;
}

function readCachedThreadSearch(
  key: string,
  now = Date.now(),
): readonly CommandPaletteThreadSearchResult[] | null {
  const cached = threadSearchCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt > now) return cached.results;
  threadSearchCache.delete(key);
  return null;
}

export async function searchCommandPaletteThreads({
  query,
  limit = CONTENT_SEARCH_LIMIT,
}: {
  query: string;
  limit?: number;
}): Promise<readonly CommandPaletteThreadSearchResult[]> {
  const queryText = query.trim();
  if (!queryText) return [];

  const normalizedLimit = Math.min(CONTENT_SEARCH_LIMIT, Math.max(1, Math.floor(limit)));
  const key = buildThreadSearchCacheKey(queryText, normalizedLimit);
  const cached = readCachedThreadSearch(key);
  if (cached) return cached;
  const existing = threadSearchInFlight.get(key);
  if (existing) return await existing;

  const request = invoke("codex:threads:palette:search", {
    query: queryText,
    limit: normalizedLimit,
  })
    .then((results) => {
      const normalized = Array.isArray(results) ? results : [];
      threadSearchCache.set(key, {
        expiresAt: Date.now() + THREAD_SEARCH_CACHE_TTL_MS,
        results: normalized,
      });
      return normalized;
    })
    .finally(() => {
      threadSearchInFlight.delete(key);
    });
  threadSearchInFlight.set(key, request);
  return await request;
}

export function useCommandPaletteThreadSearch({
  enabled,
  query,
  limit = CONTENT_SEARCH_LIMIT,
  minQueryLength = 1,
}: {
  enabled: boolean;
  query: string;
  limit?: number;
  minQueryLength?: number;
}): CommandPaletteThreadSearchBatch {
  const [batch, setBatch] = useState<CommandPaletteThreadSearchBatch>({
    query: "",
    results: [],
    loading: false,
    error: null,
  });

  useEffect(() => {
    const queryText = query.trim();
    const normalizedQuery = normalizeCommandPaletteSearchText(queryText);
    if (!enabled || normalizedQuery.length < minQueryLength) {
      setBatch((current) =>
        current.query === "" && current.results.length === 0 && !current.loading && !current.error
          ? current
          : { query: "", results: [], loading: false, error: null },
      );
      return;
    }

    const normalizedLimit = Math.min(CONTENT_SEARCH_LIMIT, Math.max(1, Math.floor(limit)));
    const cacheKey = buildThreadSearchCacheKey(queryText, normalizedLimit);
    const cached = readCachedThreadSearch(cacheKey);
    if (cached) {
      setBatch({ query: normalizedQuery, results: cached, loading: false, error: null });
      return;
    }

    let cancelled = false;
    setBatch({ query: normalizedQuery, results: [], loading: true, error: null });
    const timer = setTimeout(() => {
      void searchCommandPaletteThreads({ query: queryText, limit: normalizedLimit })
        .then((results) => {
          if (cancelled) return;
          setBatch({ query: normalizedQuery, results, loading: false, error: null });
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          setBatch({
            query: normalizedQuery,
            results: [],
            loading: false,
            error: error instanceof Error ? error.message : "Chat content search is unavailable",
          });
        });
    }, THREAD_SEARCH_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [enabled, limit, minQueryLength, query]);

  return batch;
}

interface RankedThread {
  readonly item: CommandPaletteThread;
  readonly fieldPriority: number;
  readonly score: number;
}

function compareRankedThreads(left: RankedThread, right: RankedThread): number {
  if (left.fieldPriority !== right.fieldPriority) return left.fieldPriority - right.fieldPriority;
  if (right.score !== left.score) return right.score - left.score;
  if (right.item.updatedAt !== left.item.updatedAt)
    return right.item.updatedAt - left.item.updatedAt;
  return left.item.threadId.localeCompare(right.item.threadId);
}

function mergeThreadItems(
  local: CommandPaletteThread,
  server: CommandPaletteThread,
): CommandPaletteThread {
  return {
    ...server,
    sessionId: local.sessionId,
    projectId: local.projectId ?? server.projectId,
    projectName: local.projectName ?? server.projectName,
    projectless: local.projectId === null && server.projectId === null,
    pinned: local.pinned,
    pinnedOrder: local.pinnedOrder,
    statusType: local.statusType,
    statusActiveFlags: local.statusActiveFlags,
    inActiveProject: local.inActiveProject,
    searchDecorations: local.searchDecorations,
    searchPreview: local.searchPreview ?? server.searchPreview,
  };
}

function localHitsForQuery(
  query: string,
  threads: readonly CommandPaletteThread[],
  index: CommandPaletteThreadSearchIndex | null | undefined,
): CommandPaletteThreadSearchHit[] {
  const searchIndex =
    index === undefined ? createCommandPaletteThreadSearchIndex([...threads]) : index;
  return searchIndex?.search(query) ?? [];
}

export function selectCommandPaletteChatResults({
  query,
  threads,
  threadSearchIndex,
  threadSearchBatch,
  threadLimit = DEFAULT_THREAD_LIMIT,
  preferActiveProject = false,
  activeProjectId,
}: {
  query: string;
  threads: readonly CommandPaletteThread[];
  threadSearchIndex?: CommandPaletteThreadSearchIndex | null;
  threadSearchBatch?: CommandPaletteThreadSearchBatch | null;
  threadLimit?: number;
  preferActiveProject?: boolean;
  activeProjectId?: string | null;
}): CommandPaletteThread[] {
  const normalizedQuery = normalizeCommandPaletteSearchText(query.trimStart());
  if (!normalizedQuery) {
    return filterCommandPaletteItems({
      query: "",
      mode: "chats",
      commands: [],
      pages: [],
      threads,
      threadLimit,
      preferActiveProject,
    }).threads;
  }

  const rankedById = new Map<string, RankedThread>();
  localHitsForQuery(normalizedQuery, threads, threadSearchIndex).forEach((hit) => {
    rankedById.set(hit.item.threadId, {
      item: hit.item,
      fieldPriority: hit.fieldPriority,
      score: hit.score,
    });
  });

  const serverResults =
    threadSearchBatch &&
    normalizeCommandPaletteSearchText(threadSearchBatch.query) === normalizedQuery
      ? threadSearchBatch.results
      : [];
  const resolvedActiveProjectId =
    activeProjectId ?? threads.find((thread) => thread.inActiveProject)?.projectId ?? "";
  serverResults.forEach((result, index) => {
    const serverItem = buildCommandPaletteThreadItem(result.thread, resolvedActiveProjectId);
    serverItem.searchPreview = buildThreadSearchPreview(result.snippet, normalizedQuery);
    const titleMatches = normalizeCommandPaletteSearchText(serverItem.title).includes(
      normalizedQuery,
    );
    if (titleMatches) {
      serverItem.searchDecorations = {
        titleSegments: buildCommandPaletteCharacterHighlightSegments(
          serverItem.title,
          normalizedQuery,
        ),
      };
    }
    const serverRank: RankedThread = {
      item: serverItem,
      fieldPriority: titleMatches ? 0 : 1,
      score: titleMatches ? 1_000 : 500 - index,
    };
    const local = rankedById.get(serverItem.threadId);
    if (!local) {
      rankedById.set(serverItem.threadId, serverRank);
      return;
    }
    rankedById.set(serverItem.threadId, {
      item: mergeThreadItems(local.item, serverItem),
      fieldPriority: Math.min(local.fieldPriority, serverRank.fieldPriority),
      score: Math.max(local.score, serverRank.score),
    });
  });

  const sorted = Array.from(rankedById.values())
    .sort(compareRankedThreads)
    .map(({ item }) => item);
  return (preferActiveProject ? prioritizeActiveProjectItems(sorted) : sorted).slice(
    0,
    threadLimit,
  );
}

export function useSelectedCommandPaletteChatResults({
  query,
  threads,
  threadSearchIndex,
  threadSearchBatch,
  threadLimit,
  preferActiveProject,
  activeProjectId,
}: {
  query: string;
  threads: readonly CommandPaletteThread[];
  threadSearchIndex?: CommandPaletteThreadSearchIndex | null;
  threadSearchBatch?: CommandPaletteThreadSearchBatch | null;
  threadLimit?: number;
  preferActiveProject?: boolean;
  activeProjectId?: string;
}): CommandPaletteThread[] {
  return useMemo(
    () =>
      selectCommandPaletteChatResults({
        query,
        threads,
        threadSearchIndex,
        threadSearchBatch,
        threadLimit,
        preferActiveProject,
        activeProjectId,
      }),
    [
      activeProjectId,
      preferActiveProject,
      query,
      threadSearchBatch,
      threadLimit,
      threadSearchIndex,
      threads,
    ],
  );
}

export function clearCommandPaletteThreadSearchCacheForTests(): void {
  threadSearchCache.clear();
  threadSearchInFlight.clear();
}
