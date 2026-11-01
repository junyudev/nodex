import {
  DEFAULT_TOKENIZE_MAX_LENGTH,
  type FileContents,
  type FileDiffMetadata,
} from "@pierre/diffs";
import { WorkerPoolContext } from "@pierre/diffs/react";
import { WorkerPoolManager } from "@pierre/diffs/worker";
import sourceHighlightWorkerUrl from "./highlight.worker.ts?worker&url";
import { useSyncExternalStore, type ReactNode } from "react";
import { NODEX_DIFF_THEME } from "./diff-presentation";
import { sourceHighlightKeysOverBudget } from "./source-highlight-cache";

/**
 * Source files highlight in workers, never on the window's main thread: grammar
 * tokenizing costs seconds per megabyte, and the window must stay responsive
 * while it runs. Viewers show plain text at once and adopt the colors when they
 * arrive.
 *
 * The pool lives as long as the renderer, independent of any viewer. Its AST cache
 * therefore survives unmounts, so reopening unchanged content (returning to a
 * Session, for example) reuses the finished highlight instead of tokenizing again.
 */
const SOURCE_HIGHLIGHT_WORKER_COUNT = 2;
const SOURCE_HIGHLIGHT_CACHE_ENTRIES = 24;
/** Restarts after a worker fails mid-session before highlighting stays on the window thread. */
const SOURCE_HIGHLIGHT_POOL_RESTARTS = 3;

let sourceHighlightPool: WorkerPoolManager | null | undefined;

export function getSourceHighlightPool(): WorkerPoolManager | null {
  if (sourceHighlightPool !== undefined) return sourceHighlightPool;
  if (typeof Worker === "undefined") {
    sourceHighlightPool = null;
    return null;
  }
  let restarts = 0;
  const pool: WorkerPoolManager = new WorkerPoolManager(
    {
      workerFactory: () =>
        new Worker(sourceHighlightWorkerUrl, { type: "module", name: "source-highlight" }),
      poolSize: SOURCE_HIGHLIGHT_WORKER_COUNT,
      totalASTLRUCacheSize: SOURCE_HIGHLIGHT_CACHE_ENTRIES,
      onWorkerError: (event) => {
        console.error("Source highlighting worker failed", event);
        // A startup failure already settles as an unavailable pool. Later, Pierre
        // leaves the failed worker's request unanswered, so restart the pool: every
        // waiting viewer settles and highlighting resumes on fresh workers.
        if (!pool.isInitialized()) return;
        pool.terminate();
        if (restarts++ < SOURCE_HIGHLIGHT_POOL_RESTARTS) void pool.initialize().catch(() => {});
      },
    },
    {
      theme: NODEX_DIFF_THEME,
      // Editing renders token metadata; matching it lets an edit session adopt a
      // worker highlight instead of tokenizing the whole file again locally.
      useTokenTransformer: true,
      // Source comparisons show changed lines, not changed words.
      lineDiffType: "none",
    },
  );
  pool.subscribeToStatChanges(() => {
    const { fileCache, diffCache } = pool.inspectCaches();
    for (const key of sourceHighlightKeysOverBudget(listKeys(fileCache))) {
      pool.evictFileFromCache(key);
    }
    for (const key of sourceHighlightKeysOverBudget(listKeys(diffCache))) {
      pool.evictDiffFromCache(key);
    }
  });
  sourceHighlightPool = pool;
  return pool;
}

/**
 * `working` highlights in workers; `starting` will once its workers are ready;
 * `unavailable` means highlighting happens on the window thread, so callers keep
 * large text plain there.
 */
export type SourceHighlightPoolState = "working" | "starting" | "unavailable";

function readSourceHighlightPoolState(): SourceHighlightPoolState {
  const pool = getSourceHighlightPool();
  if (!pool?.isWorkingPool()) return "unavailable";
  return pool.isInitialized() ? "working" : "starting";
}

function subscribeSourceHighlightPoolState(onChange: () => void): () => void {
  return getSourceHighlightPool()?.subscribeToStatChanges(onChange) ?? (() => {});
}

export function useSourceHighlightPoolState(): SourceHighlightPoolState {
  return useSyncExternalStore(subscribeSourceHighlightPoolState, readSourceHighlightPoolState);
}

/** Gives the source viewers inside it the shared highlighting pool. */
export function SourceHighlightPoolProvider({ children }: { readonly children: ReactNode }) {
  const pool = getSourceHighlightPool() ?? undefined;
  return <WorkerPoolContext.Provider value={pool}>{children}</WorkerPoolContext.Provider>;
}

function listKeys(cache: { keys(): Iterator<string> }): string[] {
  const keys: string[] = [];
  const iterator = cache.keys();
  for (let next = iterator.next(); !next.done; next = iterator.next()) keys.push(next.value);
  return keys;
}

/**
 * Resolves once the pool holds the highlight for this content, so an editor can
 * start from it. Resolves immediately when nothing will be highlighted (plain
 * text, or more lines than Pierre tokenizes) or the result is already cached, and
 * rejects when the pool cannot highlight it.
 */
export function primeSourceHighlight(
  pool: WorkerPoolManager,
  item: { readonly file: FileContents } | { readonly fileDiff: FileDiffMetadata },
): Promise<void> {
  if ("file" in item) {
    if (countLines(item.file.contents) > DEFAULT_TOKENIZE_MAX_LENGTH) return Promise.resolve();
    return pool.primeFileHighlightCache(item.file);
  }
  const { additionLines, deletionLines } = item.fileDiff;
  if (Math.max(additionLines.length, deletionLines.length) > DEFAULT_TOKENIZE_MAX_LENGTH) {
    return Promise.resolve();
  }
  return pool.primeDiffHighlightCache(item.fileDiff);
}

function countLines(contents: string): number {
  let lines = 1;
  for (
    let index = contents.indexOf("\n");
    index !== -1;
    index = contents.indexOf("\n", index + 1)
  ) {
    lines += 1;
  }
  return lines;
}
