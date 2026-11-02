import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberMap from "effect/FiberMap";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type {
  GitReviewLiveEvent,
  GitReviewLiveQuery,
  GitReviewLiveQueryMethod,
  GitReviewLiveQueryResult,
  GitReviewSummaryResult,
} from "../../shared/types";
import type { GitWorkerLiveQueryEvent } from "../../shared/git-worker-protocol";
import type { GitReviewRepositoryChange } from "./repository-watcher";
import type {
  GitReadQueryMeta,
  GitRepositoryError,
  WorktreeRepository,
} from "./worktree-repository";

export const GIT_LIVE_QUERY_DEBOUNCE_MS = 100;
export const GIT_LIVE_QUERY_RETRY_MS = 1_000;
export const GIT_LIVE_QUERY_MAX_RETRIES = 3;

export interface LiveQueryRepository extends WorktreeRepository {}

interface LiveQueryState {
  dirty: boolean;
  errorRetryCount: number;
  generation: number;
  query: GitReviewLiveQuery;
  refreshScheduled: boolean;
  repository: LiveQueryRepository | null;
  requiresRecovery: boolean;
  settledGeneration: number;
  subscriptionId: string;
  waiters: Map<number, Set<Deferred.Deferred<void>>>;
}

export interface GitLiveQueryRegistryOptions {
  readonly execute: (input: {
    readonly id: string;
    readonly method: GitReviewLiveQueryMethod;
    readonly params: GitReviewLiveQuery["params"];
  }) => Effect.Effect<unknown, never, Scope.Scope>;
  readonly publish: (event: GitWorkerLiveQueryEvent) => void;
  readonly registry: {
    readonly get: (cwd: string) => Effect.Effect<LiveQueryRepository | null, never, Scope.Scope>;
  };
}

export interface GitLiveQueryRegistry {
  readonly recover: (subscriptionId: string) => Effect.Effect<boolean, never, Scope.Scope>;
  readonly refresh: (subscriptionId: string) => Effect.Effect<boolean, never, Scope.Scope>;
  readonly subscribe: (input: {
    readonly subscriptionId: string;
    readonly query: GitReviewLiveQuery;
  }) => Effect.Effect<void, never, Scope.Scope>;
  readonly unsubscribe: (subscriptionId: string) => Effect.Effect<boolean>;
}

function normalizeQueryParams(params: GitReviewLiveQuery["params"]): object {
  const normalized = { ...params } as Record<string, unknown>;
  delete normalized.requestId;
  delete normalized.operationSource;
  return normalized;
}

function isStaleResult(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "stale-snapshot"
  );
}

function isRetryableOperationalError(value: unknown): boolean {
  if (typeof value !== "object" || value === null || !("type" in value) || value.type !== "error")
    return false;
  return !("failureReason" in value && value.failureReason === "canceled");
}

const interruptedOnly = (cause: Cause.Cause<unknown>): boolean =>
  cause.reasons.length > 0 && cause.reasons.every(Cause.isInterruptReason);

const refreshFiberKey = (subscriptionId: string): string => `refresh:${subscriptionId}`;
const watchFiberKey = (subscriptionId: string): string => `watch:${subscriptionId}`;

export function shouldRefreshGitLiveQuery(
  method: GitReviewLiveQueryMethod,
  change: GitReviewRepositoryChange,
): boolean {
  if (
    method === "status-summary" ||
    method === "review-summary" ||
    method === "branch-diff-stats"
  ) {
    return (
      change === "config" ||
      change === "head" ||
      change === "index" ||
      change === "remote-refs" ||
      change === "working-tree"
    );
  }
  return (
    change === "config" ||
    change === "head" ||
    change === "remote-refs" ||
    change === "worktree-topology"
  );
}

class GitLiveQueryRegistryState implements GitLiveQueryRegistry {
  readonly #fibers: FiberMap.FiberMap<string, unknown, never>;
  readonly #options: GitLiveQueryRegistryOptions;
  readonly #subscriptions = new Map<string, LiveQueryState>();

  constructor(
    options: GitLiveQueryRegistryOptions,
    fibers: FiberMap.FiberMap<string, unknown, never>,
  ) {
    this.#options = options;
    this.#fibers = fibers;
  }

  readonly subscribe: GitLiveQueryRegistry["subscribe"] = Effect.fn(
    "GitLiveQueryRegistry.subscribe",
  )(function* (
    this: GitLiveQueryRegistryState,
    input: { readonly subscriptionId: string; readonly query: GitReviewLiveQuery },
  ) {
    yield* this.unsubscribe(input.subscriptionId);
    const state: LiveQueryState = {
      dirty: true,
      errorRetryCount: 0,
      generation: 1,
      query: input.query,
      refreshScheduled: false,
      repository: null,
      requiresRecovery: false,
      settledGeneration: 0,
      subscriptionId: input.subscriptionId,
      waiters: new Map(),
    };
    this.#subscriptions.set(input.subscriptionId, state);
    yield* this.#attachRepository(state);
    yield* this.#schedule(state, 0);
  });

  readonly unsubscribe: GitLiveQueryRegistry["unsubscribe"] = Effect.fn(
    "GitLiveQueryRegistry.unsubscribe",
  )(function* (this: GitLiveQueryRegistryState, subscriptionId: string) {
    const state = this.#subscriptions.get(subscriptionId);
    if (!state) return false;
    this.#subscriptions.delete(subscriptionId);
    yield* FiberMap.remove(this.#fibers, refreshFiberKey(subscriptionId));
    yield* FiberMap.remove(this.#fibers, watchFiberKey(subscriptionId));
    yield* Effect.forEach(state.waiters.values(), (waiters) =>
      Effect.forEach(waiters, (waiter) => Deferred.succeed(waiter, undefined), {
        discard: true,
      }),
    );
    state.waiters.clear();
    return true;
  });

  readonly recover: GitLiveQueryRegistry["recover"] = Effect.fn("GitLiveQueryRegistry.recover")(
    function* (this: GitLiveQueryRegistryState, subscriptionId: string) {
      const state = this.#subscriptions.get(subscriptionId);
      if (!state) return false;
      if (!state.repository) yield* this.#attachRepository(state);
      if (state.repository) yield* state.repository.recoverWatch;
      yield* this.#requestRefresh(state, true, true);
      return true;
    },
  );

  readonly refresh: GitLiveQueryRegistry["refresh"] = Effect.fn("GitLiveQueryRegistry.refresh")(
    function* (this: GitLiveQueryRegistryState, subscriptionId: string) {
      const state = this.#subscriptions.get(subscriptionId);
      if (!state) return false;
      if (state.repository) {
        yield* state.repository.advanceGeneration();
      } else {
        yield* this.#attachRepository(state);
      }
      yield* this.#requestRefresh(state, true, true);
      return true;
    },
  );

  readonly #attachRepository: (state: LiveQueryState) => Effect.Effect<void, never, Scope.Scope> =
    Effect.fn("GitLiveQueryRegistry.attachRepository")(function* (
      this: GitLiveQueryRegistryState,
      state: LiveQueryState,
    ) {
      if (!this.#isCurrent(state) || state.repository) return;
      const repository = yield* this.#options.registry.get(state.query.params.cwd);
      if (!this.#isCurrent(state) || !repository) return;
      state.repository = repository;
      const observe = Stream.runForEach(repository.watchEvents, (event) => {
        if (!this.#isCurrent(state)) return Effect.void;
        if (event._tag === "Changed") {
          if (!shouldRefreshGitLiveQuery(state.query.method, event.event.changeType)) {
            return Effect.void;
          }
          return this.#requestRefresh(state, false, false);
        }
        if (state.requiresRecovery === event.requiresRecovery) return Effect.void;
        state.requiresRecovery = event.requiresRecovery;
        return this.#requestRefresh(state, false, false);
      }).pipe(
        Effect.catchCause((cause) => {
          if (interruptedOnly(cause) || !this.#isCurrent(state)) return Effect.void;
          state.requiresRecovery = true;
          return this.#requestRefresh(state, false, false);
        }),
      );
      yield* FiberMap.run(this.#fibers, watchFiberKey(state.subscriptionId), observe, {
        onlyIfMissing: true,
        startImmediately: true,
      });
    });

  readonly #requestRefresh: (
    state: LiveQueryState,
    immediate: boolean,
    wait: boolean,
  ) => Effect.Effect<void, never, Scope.Scope> = Effect.fn("GitLiveQueryRegistry.requestRefresh")(
    function* (
      this: GitLiveQueryRegistryState,
      state: LiveQueryState,
      immediate: boolean,
      wait: boolean,
    ) {
      if (!this.#isCurrent(state)) return;
      state.generation += 1;
      state.dirty = true;
      state.errorRetryCount = 0;
      const generation = state.generation;
      const waiter = wait ? yield* Deferred.make<void>() : null;
      if (waiter) {
        const waiters = state.waiters.get(generation) ?? new Set();
        waiters.add(waiter);
        state.waiters.set(generation, waiters);
      }
      yield* this.#schedule(state, immediate ? 0 : GIT_LIVE_QUERY_DEBOUNCE_MS);
      if (waiter) yield* Deferred.await(waiter);
    },
  );

  readonly #schedule: (
    state: LiveQueryState,
    delay: number,
  ) => Effect.Effect<void, never, Scope.Scope> = Effect.fn("GitLiveQueryRegistry.schedule")(
    function* (this: GitLiveQueryRegistryState, state: LiveQueryState, delay: number) {
      if (!this.#isCurrent(state) || state.refreshScheduled) return;
      state.refreshScheduled = true;
      yield* FiberMap.run(
        this.#fibers,
        refreshFiberKey(state.subscriptionId),
        Effect.sleep(Duration.millis(delay)).pipe(
          Effect.andThen(this.#run(state)),
          Effect.ensuring(
            Effect.sync(() => {
              state.refreshScheduled = false;
            }),
          ),
        ),
        { onlyIfMissing: true, startImmediately: true },
      );
    },
  );

  readonly #run: (state: LiveQueryState) => Effect.Effect<void, never, Scope.Scope> = Effect.fn(
    "GitLiveQueryRegistry.run",
  )(function* (this: GitLiveQueryRegistryState, state: LiveQueryState) {
    if (!this.#isCurrent(state) || !state.dirty) return;
    state.dirty = false;
    const generation = state.generation;
    let retryDelay: number | null = null;
    const attempt = Effect.gen({ self: this }, function* () {
      const trackedParams = this.#trackedPhaseParams(state.query);
      let trackedSummary: GitReviewSummaryResult | null = null;
      let trackedSuccess: Extract<GitReviewSummaryResult, { type: "success" }> | null = null;
      if (trackedParams) {
        const tracked = yield* this.#read(state, generation, "tracked", trackedParams);
        if (!this.#isCurrent(state, generation) || isStaleResult(tracked)) return;
        trackedSummary =
          state.query.method === "review-summary" ? (tracked as GitReviewSummaryResult) : null;
        trackedSuccess =
          trackedSummary?.type === "success" && trackedSummary.files.length > 0
            ? trackedSummary
            : null;
        if (state.query.method !== "review-summary" || trackedSuccess) {
          this.#publishResult(state, generation, "tracked", tracked);
        }
      }
      const complete =
        trackedSummary && trackedSummary.type !== "success"
          ? trackedSummary
          : yield* this.#read(state, generation, "complete", state.query.params);
      if (!this.#isCurrent(state, generation) || isStaleResult(complete)) return;
      // Keep a useful tracked snapshot when the untracked scan cannot complete.
      const result =
        trackedSuccess && (complete as GitReviewSummaryResult).type === "error"
          ? trackedSuccess
          : complete;
      this.#publishResult(state, generation, "complete", result);
      if (
        isRetryableOperationalError(result) &&
        state.errorRetryCount < GIT_LIVE_QUERY_MAX_RETRIES
      ) {
        state.errorRetryCount += 1;
        state.dirty = true;
        retryDelay = GIT_LIVE_QUERY_RETRY_MS;
      } else {
        state.errorRetryCount = 0;
      }
    });
    const exit = yield* Effect.exit(attempt);
    if (Exit.isFailure(exit) && this.#isCurrent(state, generation)) {
      if (!interruptedOnly(exit.cause)) {
        this.#publishFailure(state, generation, Cause.squash(exit.cause));
        if (state.errorRetryCount < GIT_LIVE_QUERY_MAX_RETRIES) {
          state.errorRetryCount += 1;
          state.dirty = true;
          retryDelay = GIT_LIVE_QUERY_RETRY_MS;
        }
      }
    }
    yield* this.#settleGeneration(state, generation);
    if (!this.#isCurrent(state) || !state.dirty) return;
    if (retryDelay !== null && generation === state.generation) state.generation += 1;
    yield* Effect.sleep(Duration.millis(retryDelay ?? GIT_LIVE_QUERY_DEBOUNCE_MS));
    yield* this.#run(state);
  });

  readonly #read: (
    state: LiveQueryState,
    generation: number,
    phase: "tracked" | "complete",
    params: GitReviewLiveQuery["params"],
  ) => Effect.Effect<unknown, GitRepositoryError, Scope.Scope> = Effect.fn(
    "GitLiveQueryRegistry.read",
  )(function* (
    this: GitLiveQueryRegistryState,
    state: LiveQueryState,
    generation: number,
    phase: "tracked" | "complete",
    params: GitReviewLiveQuery["params"],
  ) {
    const operation = this.#options.execute({
      id: `${state.subscriptionId}:${generation}:${phase}`,
      method: state.query.method,
      params,
    });
    const repository = state.repository;
    if (!repository) return yield* operation;
    return yield* repository.query({
      key: [
        "live-query",
        state.query.method,
        normalizeQueryParams(params),
        phase,
        repository.generation,
      ],
      meta: {
        gitReadDomains:
          state.query.method === "status-summary" ||
          state.query.method === "review-summary" ||
          state.query.method === "branch-diff-stats"
            ? ["config", "head", "index", "local-refs", "remote-refs", "working-tree"]
            : ["config", "head", "local-refs", "remote-refs"],
        gitReadGeneration: repository.generation,
      } satisfies GitReadQueryMeta,
      run: operation,
      staleTime: 0,
    });
  });

  #trackedPhaseParams(query: GitReviewLiveQuery): GitReviewLiveQuery["params"] | null {
    if (query.method === "status-summary" && query.params.includeUntrackedFiles === true) {
      return { ...query.params, includeUntrackedFiles: false };
    }
    if (
      query.method === "review-summary" &&
      (query.params.source === "unstaged" || query.params.source === "branch") &&
      query.params.includeUntrackedFiles !== false
    ) {
      return { ...query.params, includeUntrackedFiles: false };
    }
    if (query.method === "branch-diff-stats" && query.params.includeUntrackedFiles === true) {
      return { ...query.params, includeUntrackedFiles: false };
    }
    return null;
  }

  #publishResult(
    state: LiveQueryState,
    generation: number,
    phase: "tracked" | "complete",
    result: unknown,
  ): void {
    const output = { method: state.query.method, result } as GitReviewLiveQueryResult;
    const event: GitReviewLiveEvent = {
      type: "git-live-query-updated",
      subscriptionId: state.subscriptionId,
      generation,
      phase,
      requiresRecovery: state.requiresRecovery,
      ...output,
    };
    this.#options.publish({ type: "git-live-query-event", workerId: "git", event });
  }

  #publishFailure(state: LiveQueryState, generation: number, error: unknown): void {
    const event: GitReviewLiveEvent = {
      type: "git-live-query-failed",
      subscriptionId: state.subscriptionId,
      generation,
      requiresRecovery: state.requiresRecovery,
      method: state.query.method,
      errorMessage:
        error instanceof Error ? error.message : "Could not refresh the Git live query.",
    };
    this.#options.publish({ type: "git-live-query-event", workerId: "git", event });
  }

  #isCurrent(state: LiveQueryState, generation?: number): boolean {
    return (
      this.#subscriptions.get(state.subscriptionId) === state &&
      (generation === undefined || state.generation === generation)
    );
  }

  readonly #settleGeneration: (state: LiveQueryState, generation: number) => Effect.Effect<void> =
    Effect.fn("GitLiveQueryRegistry.settleGeneration")(function* (
      this: GitLiveQueryRegistryState,
      state: LiveQueryState,
      generation: number,
    ) {
      state.settledGeneration = Math.max(state.settledGeneration, generation);
      for (const [target, waiters] of state.waiters) {
        if (target > state.settledGeneration) continue;
        state.waiters.delete(target);
        yield* Effect.forEach(waiters, (waiter) => Deferred.succeed(waiter, undefined), {
          discard: true,
        });
      }
    });
}

export const makeGitLiveQueryRegistry = (
  options: GitLiveQueryRegistryOptions,
): Effect.Effect<GitLiveQueryRegistry, never, Scope.Scope> =>
  Effect.gen(function* () {
    const fibers = yield* FiberMap.make<string, unknown, never>();
    return new GitLiveQueryRegistryState(options, fibers);
  });
