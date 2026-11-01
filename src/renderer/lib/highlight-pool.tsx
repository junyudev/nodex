import { WorkerPoolContext } from "@pierre/diffs/react";
import { WorkerPoolManager } from "@pierre/diffs/worker";
import highlightWorkerUrl from "./highlight.worker.ts?worker&url";
import { useSyncExternalStore, type ReactNode } from "react";
import { NODEX_DIFF_THEME } from "./diff-presentation";
import { sourceHighlightKeysOverBudget } from "./source-highlight-cache";

export type HighlightPoolState = "working" | "starting" | "unavailable";
const HIGHLIGHT_WORKER_COUNT = 2;
const HIGHLIGHT_CACHE_ENTRIES = 24;
const HIGHLIGHT_POOL_RESTARTS = 3;

/**
 * Each render profile owns one lazy, renderer-lifetime pool. Pierre takes its
 * syntax options from the pool, so changing a viewer's options cannot select a
 * different word-diff policy. Finished highlights survive viewer unmounts.
 */
export function createHighlightPool(profile: {
  readonly name: string;
  readonly lineDiffType: "none" | "word-alt";
}) {
  let manager: WorkerPoolManager | null | undefined;
  function getPool(): WorkerPoolManager | null {
    if (manager !== undefined) return manager;
    if (typeof Worker === "undefined") {
      manager = null;
      return null;
    }
    let restarts = 0;
    const pool: WorkerPoolManager = new WorkerPoolManager(
      {
        workerFactory: () => new Worker(highlightWorkerUrl, { type: "module", name: profile.name }),
        poolSize: HIGHLIGHT_WORKER_COUNT,
        totalASTLRUCacheSize: HIGHLIGHT_CACHE_ENTRIES,
        onWorkerError: (event) => {
          console.error("Syntax highlighting worker failed", event);
          // Startup failure settles as unavailable. A later failure leaves a
          // request unanswered, so restart and settle every waiting viewer.
          if (!pool.isInitialized()) return;
          pool.terminate();
          if (restarts++ < HIGHLIGHT_POOL_RESTARTS) void pool.initialize().catch(() => {});
        },
      },
      {
        theme: NODEX_DIFF_THEME,
        // Files editors can adopt a finished source/comparison highlight.
        useTokenTransformer: true,
        lineDiffType: profile.lineDiffType,
      },
    );
    pool.subscribeToStatChanges(() => {
      const { fileCache, diffCache } = pool.inspectCaches();
      for (const key of sourceHighlightKeysOverBudget(listKeys(fileCache)))
        pool.evictFileFromCache(key);
      for (const key of sourceHighlightKeysOverBudget(listKeys(diffCache)))
        pool.evictDiffFromCache(key);
    });
    manager = pool;
    return pool;
  }
  function readState(): HighlightPoolState {
    const pool = getPool();
    if (!pool?.isWorkingPool()) return "unavailable";
    return pool.isInitialized() ? "working" : "starting";
  }
  function subscribe(onChange: () => void): () => void {
    return getPool()?.subscribeToStatChanges(onChange) ?? (() => {});
  }
  function usePoolState(): HighlightPoolState {
    return useSyncExternalStore(subscribe, readState);
  }
  function Provider({ children }: { readonly children: ReactNode }) {
    const pool = getPool() ?? undefined;
    return <WorkerPoolContext.Provider value={pool}>{children}</WorkerPoolContext.Provider>;
  }
  return { getPool, usePoolState, Provider };
}

function listKeys(cache: { keys(): Iterator<string> }): string[] {
  const keys: string[] = [];
  const iterator = cache.keys();
  for (let next = iterator.next(); !next.done; next = iterator.next()) keys.push(next.value);
  return keys;
}
