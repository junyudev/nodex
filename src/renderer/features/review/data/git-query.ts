import { hashKey, type QueryClient, type QueryKey, type QueryMeta } from "@tanstack/react-query";
import type {
  GitReviewLiveEvent,
  GitReviewLiveQuery,
  GitReviewLiveQueryMethod,
  GitReviewLiveQueryResult,
} from "@/lib/types";
import type { GitWorkerMethod, GitWorkerMethodMap } from "../../../../shared/git-worker-protocol";
import { getGitWorkerClient } from "@/lib/api";
import type { GitWorkerClient } from "@/lib/git-worker-client";

const GIT_QUERY_GC_MS = 30 * 60 * 1_000;
const GIT_LIVE_RELEASE_DELAY_MS = 250;
const GIT_LIVE_RECOVERY_DELAY_MS = 1_000;

export interface GitQueryRepositoryIdentity {
  hostId: "local";
  commonDir: string;
  root: string;
}

export interface GitLiveQueryMeta extends QueryMeta {
  gitLiveQuery?: {
    method: GitReviewLiveQueryMethod;
    params: GitReviewLiveQuery["params"];
  };
}

export type GitWorkerQueryClient = Pick<GitWorkerClient, "request" | "subscribe">;

/** Calls the listener whenever the user returns to the window. */
export type WindowFocusSource = (listener: () => void) => () => void;

const subscribeToWindowFocus: WindowFocusSource = (listener) => {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("focus", listener);
  return () => window.removeEventListener("focus", listener);
};

export function buildGitWorkerQueryKey<Method extends GitWorkerMethod>(input: {
  method: Method;
  params: GitWorkerMethodMap[Method]["params"];
  repository?: GitQueryRepositoryIdentity | null;
}): QueryKey {
  const params = { ...input.params } as Record<string, unknown>;
  delete params.operationSource;
  delete params.requestId;
  const cwd = typeof params.cwd === "string" ? params.cwd : "";
  return [
    "git-worker",
    input.repository?.hostId ?? "local",
    input.repository?.commonDir ?? cwd,
    input.repository?.root ?? cwd,
    input.method,
    params,
  ] as const;
}

export function createGitWorkerQuery<Method extends GitWorkerMethod>(
  input: {
    method: Method;
    params: GitWorkerMethodMap[Method]["params"];
    repository?: GitQueryRepositoryIdentity | null;
  },
  client: Pick<GitWorkerClient, "request"> = getGitWorkerClient(),
) {
  // The transport client does not change repository data identity; including
  // its object identity would split otherwise shareable worker queries.
  // eslint-disable-next-line @tanstack/query/exhaustive-deps
  return {
    queryKey: buildGitWorkerQueryKey(input),
    queryFn: async ({ signal }: { signal: AbortSignal }) =>
      await client.request({
        method: input.method,
        params: input.params,
        signal,
      }),
    gcTime: GIT_QUERY_GC_MS,
    networkMode: "always" as const,
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: Infinity,
  };
}

export function createGitLiveWorkerQuery<Method extends GitReviewLiveQueryMethod>(
  input: {
    method: Method;
    params: Extract<GitReviewLiveQuery, { method: Method }>["params"];
    repository?: GitQueryRepositoryIdentity | null;
  },
  client: Pick<GitWorkerClient, "request"> = getGitWorkerClient(),
) {
  return {
    ...createGitWorkerQuery(input, client),
    meta: {
      gitLiveQuery: {
        method: input.method,
        params: input.params,
      },
    } satisfies GitLiveQueryMeta,
  };
}

type GitLiveUpdatePhase = Extract<GitReviewLiveEvent, { phase: unknown }>["phase"];

/**
 * The last live update written to a query. A null generation means the next
 * worker generation is unknown (a new or re-established subscription).
 */
export interface AcceptedGitLiveUpdate {
  readonly generation: number | null;
  readonly phase: GitLiveUpdatePhase;
}

/**
 * Whether a live update may replace what the query shows. Results only grow
 * more complete: a later generation's tracked-only phase never replaces a
 * complete result, so a list keeps showing until the next complete one arrives.
 */
export function acceptsGitLiveUpdate(
  accepted: AcceptedGitLiveUpdate | null,
  update: { readonly generation: number; readonly phase: GitLiveUpdatePhase },
): boolean {
  if (accepted === null) return true;
  if (accepted.generation !== null) {
    if (update.generation < accepted.generation) return false;
    if (update.generation === accepted.generation) {
      return accepted.phase === "tracked" && update.phase === "complete";
    }
  }
  return accepted.phase !== "complete" || update.phase === "complete";
}

interface LiveEntry {
  consumers: number;
  method: GitReviewLiveQueryMethod;
  params: GitReviewLiveQuery["params"];
  queryKey: QueryKey;
  releaseTimer: ReturnType<typeof setTimeout> | null;
  recoveryTimer: ReturnType<typeof setTimeout> | null;
  subscriptionId: string;
  observed: boolean;
  accepted: AcceptedGitLiveUpdate | null;
  /** The worker cannot watch the whole repository; refresh when the window regains focus. */
  requiresRecovery: boolean;
}

export class GitLiveQueryCoordinator {
  readonly #queryClient: QueryClient;
  readonly #entriesByHash = new Map<string, LiveEntry>();
  readonly #entriesBySubscriptionId = new Map<string, LiveEntry>();
  readonly #client: GitWorkerQueryClient;
  readonly #unsubscribeCache: () => void;
  readonly #unsubscribe: () => void;
  readonly #unsubscribeFocus: () => void;

  constructor(
    queryClient: QueryClient,
    client: GitWorkerQueryClient = getGitWorkerClient(),
    onWindowFocus: WindowFocusSource = subscribeToWindowFocus,
  ) {
    this.#queryClient = queryClient;
    this.#client = client;
    this.#unsubscribe = client.subscribe((message) => {
      if (message.type === "worker-restarted") {
        for (const entry of this.#entriesByHash.values()) {
          if (this.#isActive(entry)) this.#subscribe(entry);
        }
        return;
      }
      if (message.type !== "git-live-query-event") return;
      const entry = this.#entriesBySubscriptionId.get(message.event.subscriptionId);
      if (!entry || message.event.method !== entry.method) return;
      entry.requiresRecovery = message.event.requiresRecovery;
      if (message.event.type === "git-live-query-failed") {
        this.#scheduleRecovery(entry);
        return;
      }
      const { generation, phase } = message.event;
      if (!acceptsGitLiveUpdate(entry.accepted, { generation, phase })) return;
      entry.accepted = { generation, phase };
      this.#queryClient.setQueryData(
        entry.queryKey,
        message.event.result as GitReviewLiveQueryResult["result"],
      );
    });
    // A degraded repository watch can miss changes; catch up when the user returns,
    // rather than recomputing on a timer while nothing is looking.
    this.#unsubscribeFocus = onWindowFocus(() => {
      for (const entry of this.#entriesByHash.values()) {
        if (entry.requiresRecovery && this.#isActive(entry)) this.#recover(entry);
      }
    });
    this.#unsubscribeCache = queryClient.getQueryCache().subscribe(() => {
      this.#syncObservedQueries();
    });
    this.#syncObservedQueries();
  }

  acquire(input: {
    method: GitReviewLiveQueryMethod;
    params: GitReviewLiveQuery["params"];
    queryKey: QueryKey;
  }): () => void {
    const queryHash = hashKey(input.queryKey);
    const entry = this.#ensureEntry(queryHash, input);
    if (entry.releaseTimer) {
      clearTimeout(entry.releaseTimer);
      entry.releaseTimer = null;
    }
    entry.consumers += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      entry.consumers -= 1;
      this.#scheduleRelease(queryHash, entry);
    };
  }

  dispose(): void {
    this.#unsubscribe();
    this.#unsubscribeCache();
    this.#unsubscribeFocus();
    for (const entry of this.#entriesByHash.values()) {
      if (entry.releaseTimer) clearTimeout(entry.releaseTimer);
      if (entry.recoveryTimer) clearTimeout(entry.recoveryTimer);
      void this.#client
        .request({
          method: "unsubscribe-live-query",
          params: { subscriptionId: entry.subscriptionId },
        })
        .catch(() => undefined);
    }
    this.#entriesByHash.clear();
    this.#entriesBySubscriptionId.clear();
  }

  async refresh(queryKey: QueryKey): Promise<boolean> {
    const entry = this.#entriesByHash.get(hashKey(queryKey));
    if (!entry) return false;
    const result = await this.#client.request({
      method: "refresh-live-query",
      params: { subscriptionId: entry.subscriptionId },
    });
    return result.refreshed;
  }

  #subscribe(entry: LiveEntry): void {
    // A new worker subscription numbers its generations afresh; what is shown stays.
    if (entry.accepted) entry.accepted = { generation: null, phase: entry.accepted.phase };
    void this.#client
      .request({
        method: "subscribe-live-query",
        params: {
          subscriptionId: entry.subscriptionId,
          query: {
            method: entry.method,
            params: entry.params,
          } as GitReviewLiveQuery,
        },
      })
      .catch(() => this.#scheduleRecovery(entry));
  }

  #scheduleRecovery(entry: LiveEntry): void {
    if (entry.recoveryTimer || !this.#isActive(entry)) return;
    entry.recoveryTimer = setTimeout(() => {
      entry.recoveryTimer = null;
      if (this.#isActive(entry)) this.#recover(entry);
    }, GIT_LIVE_RECOVERY_DELAY_MS);
  }

  #recover(entry: LiveEntry): void {
    void this.#client
      .request({
        method: "recover-live-query",
        params: { subscriptionId: entry.subscriptionId },
      })
      .then((result) => {
        if (!result.recovered) this.#subscribe(entry);
      })
      .catch(() => this.#scheduleRecovery(entry));
  }

  #ensureEntry(
    queryHash: string,
    input: {
      method: GitReviewLiveQueryMethod;
      params: GitReviewLiveQuery["params"];
      queryKey: QueryKey;
    },
  ): LiveEntry {
    const existing = this.#entriesByHash.get(queryHash);
    if (existing) return existing;
    const entry: LiveEntry = {
      consumers: 0,
      method: input.method,
      params: input.params,
      queryKey: input.queryKey,
      releaseTimer: null,
      recoveryTimer: null,
      subscriptionId: crypto.randomUUID(),
      observed: false,
      // Data already cached came from a full read; live partial phases must not replace it.
      accepted:
        this.#queryClient.getQueryData(input.queryKey) === undefined
          ? null
          : { generation: null, phase: "complete" },
      requiresRecovery: false,
    };
    this.#entriesByHash.set(queryHash, entry);
    this.#entriesBySubscriptionId.set(entry.subscriptionId, entry);
    this.#subscribe(entry);
    return entry;
  }

  #isActive(entry: LiveEntry): boolean {
    return entry.observed || entry.consumers > 0;
  }

  #scheduleRelease(queryHash: string, entry: LiveEntry): void {
    if (this.#isActive(entry) || entry.releaseTimer) return;
    entry.releaseTimer = setTimeout(() => {
      entry.releaseTimer = null;
      if (this.#isActive(entry)) return;
      this.#entriesByHash.delete(queryHash);
      this.#entriesBySubscriptionId.delete(entry.subscriptionId);
      if (entry.recoveryTimer) clearTimeout(entry.recoveryTimer);
      void this.#client
        .request({
          method: "unsubscribe-live-query",
          params: { subscriptionId: entry.subscriptionId },
        })
        .catch(() => undefined);
    }, GIT_LIVE_RELEASE_DELAY_MS);
  }

  #syncObservedQueries(): void {
    const observedHashes = new Set<string>();
    for (const query of this.#queryClient.getQueryCache().getAll()) {
      const meta = query.meta as GitLiveQueryMeta | undefined;
      const descriptor = meta?.gitLiveQuery;
      if (!descriptor || !query.isActive()) continue;
      observedHashes.add(query.queryHash);
      const entry = this.#ensureEntry(query.queryHash, {
        ...descriptor,
        queryKey: query.queryKey,
      });
      entry.observed = true;
      if (entry.releaseTimer) {
        clearTimeout(entry.releaseTimer);
        entry.releaseTimer = null;
      }
    }
    for (const [queryHash, entry] of this.#entriesByHash) {
      if (observedHashes.has(queryHash)) continue;
      entry.observed = false;
      this.#scheduleRelease(queryHash, entry);
    }
  }
}

const coordinators = new WeakMap<QueryClient, GitLiveQueryCoordinator>();

export function getGitLiveQueryCoordinator(
  queryClient: QueryClient,
  client?: GitWorkerQueryClient,
): GitLiveQueryCoordinator {
  const existing = coordinators.get(queryClient);
  if (existing) return existing;
  const coordinator = new GitLiveQueryCoordinator(queryClient, client);
  coordinators.set(queryClient, coordinator);
  return coordinator;
}
