import path from "node:path";
import type { QueryKey, QueryMeta } from "@tanstack/query-core";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Hash from "effect/Hash";
import * as Layer from "effect/Layer";
import * as LayerMap from "effect/LayerMap";
import * as PubSub from "effect/PubSub";
import * as RcMap from "effect/RcMap";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { FileWatchHost } from "../file-watch-host";
import { localFileWatchHost } from "../file-watch-host";
import type { GitReviewRepositoryPaths } from "./git-review-operations";
import {
  makeGitReviewRepositoryWatcher,
  type GitReviewRepositoryChangedEvent,
  type GitReviewRepositoryChange,
  type GitReviewRepositoryWatcher,
} from "./repository-watcher";
import {
  gitPerformancePromise,
  recordGitQueryCacheOutcomeEffect,
  type GitCommandOptions,
  type GitCommandResult,
  type GitCommandRunner,
} from "./git-command-runner";
import { UntrackedPathCache } from "./untracked-cache";
import { MAIN_OBSERVATION_EVENT_CAPACITY } from "../runtime-limits";

export interface GitReadQueryMeta extends QueryMeta {
  gitReadDomains?: readonly (
    | "config"
    | "head"
    | "index"
    | "local-refs"
    | "remote-refs"
    | "working-tree"
  )[];
  gitReadPaths?: readonly string[];
  gitReadGeneration?: number;
}

export type GitRepositoryWatchEvent =
  | { readonly _tag: "Changed"; readonly event: GitReviewRepositoryChangedEvent }
  | { readonly _tag: "RecoveryChanged"; readonly requiresRecovery: boolean };

export class GitRepositoryError extends Schema.TaggedError<GitRepositoryError>()(
  "GitRepositoryError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

export interface WorktreeRepository {
  readonly advanceGeneration: (options?: {
    readonly invalidateUntracked?: boolean;
  }) => Effect.Effect<number>;
  readonly generation: number;
  readonly identity: GitReviewRepositoryPaths & { readonly hostId: "local" };
  readonly invalidateGitReadCachesForRepoChange: (
    change: GitReviewRepositoryChange,
    changedPaths?: readonly string[],
  ) => Effect.Effect<number, GitRepositoryError, Scope.Scope>;
  readonly query: <Result>(input: {
    readonly key: QueryKey;
    readonly meta?: GitReadQueryMeta;
    readonly run: Effect.Effect<Result, GitRepositoryError, Scope.Scope>;
    readonly staleTime?: number;
  }) => Effect.Effect<Result, GitRepositoryError, Scope.Scope>;
  readonly readSafeAttributeFilterOverrides: Effect.Effect<
    readonly string[],
    GitRepositoryError,
    Scope.Scope
  >;
  readonly recoverWatch: Effect.Effect<void, never, Scope.Scope>;
  readonly runGit: (
    args: readonly string[],
    options?: GitCommandOptions,
  ) => Effect.Effect<GitCommandResult>;
  readonly untrackedPaths: UntrackedPathCache;
  readonly watchEvents: Stream.Stream<GitRepositoryWatchEvent>;
}

class RepositoryWatcher extends Context.Service<RepositoryWatcher, GitReviewRepositoryWatcher>()(
  "nodex/main/git-worker/RepositoryWatcher",
) {}

class GitQueryRequest<Result> implements Equal.Equal {
  readonly cacheKey: string;

  constructor(
    readonly key: QueryKey,
    readonly meta: GitReadQueryMeta | undefined,
    readonly staleTime: number,
    readonly run: Effect.Effect<Result, GitRepositoryError, Scope.Scope>,
  ) {
    this.cacheKey = JSON.stringify(key);
  }

  [Equal.symbol](that: Equal.Equal): boolean {
    return that instanceof GitQueryRequest && this.cacheKey === that.cacheKey;
  }

  [Hash.symbol](): number {
    return Hash.string(this.cacheKey);
  }
}

export interface WorktreeRepositoryOptions {
  readonly registerSnapshotGenerationProvider?: (provider: {
    readonly advance: () => number;
    readonly current: () => number;
  }) => () => void;
  readonly watchHost?: FileWatchHost;
}

/** Creates one repository owner; native watchers exist only while a watch Stream is consumed. */
export const makeWorktreeRepository = (
  identity: GitReviewRepositoryPaths & { hostId: "local" },
  runner: GitCommandRunner,
  options: WorktreeRepositoryOptions = {},
): Effect.Effect<WorktreeRepository, never, Scope.Scope> =>
  Effect.gen(function* () {
    let generation = 1;
    const recovery = yield* Ref.make(false);
    const watchEvents = yield* PubSub.sliding<GitRepositoryWatchEvent>(
      MAIN_OBSERVATION_EVENT_CAPACITY,
    );
    const activeQueries = new Set<string>();
    const queryCache = yield* RcMap.make<
      GitQueryRequest<unknown>,
      unknown,
      GitRepositoryError,
      Scope.Scope
    >({
      lookup: (request) =>
        Effect.sync(() => activeQueries.add(request.cacheKey)).pipe(
          Effect.andThen(request.run),
          Effect.ensuring(Effect.sync(() => activeQueries.delete(request.cacheKey))),
        ),
      idleTimeToLive: (request) =>
        request.staleTime === Infinity ? Duration.infinity : Duration.zero,
    });

    const runGit = Effect.fn("WorktreeRepository.runGit")(function* (
      args: readonly string[],
      commandOptions: GitCommandOptions = {},
    ) {
      return yield* gitPerformancePromise((signal) =>
        runner.run(identity, args, { ...commandOptions, signal }),
      );
    });

    const query = <Result>(input: {
      readonly key: QueryKey;
      readonly meta?: GitReadQueryMeta;
      readonly run: Effect.Effect<Result, GitRepositoryError, Scope.Scope>;
      readonly staleTime?: number;
    }): Effect.Effect<Result, GitRepositoryError, Scope.Scope> =>
      Effect.gen(function* () {
        const request = new GitQueryRequest(
          input.key,
          {
            ...input.meta,
            gitReadGeneration: input.meta?.gitReadGeneration ?? generation,
          },
          input.staleTime ?? Infinity,
          input.run,
        );
        const cached = yield* RcMap.has(queryCache, request);
        yield* recordGitQueryCacheOutcomeEffect(
          cached ? (activeQueries.has(request.cacheKey) ? "coalesced" : "hit") : "miss",
        );
        return (yield* RcMap.get(queryCache, request)) as Result;
      });

    const readSafeAttributeFilterOverrides = query({
      key: ["safe-attribute-filter-overrides"],
      meta: { gitReadDomains: ["config"] },
      run: Effect.gen(function* () {
        const result = yield* runGit(
          [
            "config",
            "--name-only",
            "--get-regexp",
            "^filter\\..*\\.(clean|smudge|process|required)$",
          ],
          { allowedNonZeroExitCodes: [1] },
        );
        if (!result.success) {
          return yield* new GitRepositoryError({
            operation: "read-safe-attribute-filter-overrides",
            cause: new Error("Could not discover Git attribute filters"),
          });
        }
        const filterNames = new Set<string>();
        for (const line of result.stdout.split(/\r?\n/)) {
          const match = /^filter\.(.+)\.(?:clean|smudge|process|required)$/.exec(line.trim());
          if (match?.[1]) filterNames.add(match[1]);
        }
        return [
          "attr.tree=",
          "core.attributesFile=",
          ...[...filterNames].flatMap((name) => [
            `filter.${name}.clean=`,
            `filter.${name}.smudge=`,
            `filter.${name}.process=`,
            `filter.${name}.required=false`,
          ]),
        ];
      }),
    });

    let untrackedPaths!: UntrackedPathCache;
    const invalidateQueries = Effect.fn("WorktreeRepository.invalidateQueries")(function* (
      predicate: (request: GitQueryRequest<unknown>) => boolean,
    ) {
      const requests = yield* RcMap.keys(queryCache);
      yield* Effect.forEach(requests, (request) =>
        predicate(request) ? RcMap.invalidate(queryCache, request) : Effect.void,
      );
    });
    const advanceGenerationState = (
      generationOptions: { readonly invalidateUntracked?: boolean } = {},
    ): number => {
      generation += 1;
      if (generationOptions.invalidateUntracked !== false) untrackedPaths.invalidateFull();
      return generation;
    };
    const advanceGeneration = Effect.fn("WorktreeRepository.advanceGeneration")(function* (
      generationOptions: { readonly invalidateUntracked?: boolean } = {},
    ) {
      const nextGeneration = advanceGenerationState(generationOptions);
      yield* invalidateQueries(
        (request) => (request.meta?.gitReadGeneration ?? nextGeneration) < nextGeneration,
      );
      return nextGeneration;
    });
    const invalidateGitReadCachesForRepoChange = Effect.fn(
      "WorktreeRepository.invalidateGitReadCachesForRepoChange",
    )(function* (change: GitReviewRepositoryChange, changedPaths?: readonly string[]) {
      const domains: NonNullable<GitReadQueryMeta["gitReadDomains"]> =
        change === "config"
          ? ["config"]
          : change === "head" || change === "worktree-topology"
            ? ["head", "index", "local-refs", "working-tree"]
            : change === "index"
              ? ["index"]
              : change === "remote-refs" || change === "synced-branch"
                ? ["remote-refs"]
                : ["working-tree"];
      if (change === "working-tree" && changedPaths && changedPaths.length > 0) {
        yield* untrackedPaths.invalidatePaths(changedPaths).pipe(
          Effect.catch(() =>
            Effect.sync(() => {
              untrackedPaths.invalidateFull();
            }),
          ),
        );
      } else {
        untrackedPaths.invalidateFull();
      }
      const changed = new Set(domains);
      yield* invalidateQueries(
        (request) => request.meta?.gitReadDomains?.some((domain) => changed.has(domain)) ?? false,
      );
      const nextGeneration = yield* advanceGeneration({ invalidateUntracked: false });
      yield* PubSub.publish(watchEvents, {
        _tag: "Changed",
        event: { changeType: change, ...(changedPaths ? { changedPaths } : {}) },
      });
      return nextGeneration;
    });

    untrackedPaths = new UntrackedPathCache({
      identity,
      query,
      readSafeAttributeFilterOverrides,
      runGit,
    });
    if (options.registerSnapshotGenerationProvider) {
      const unregister = options.registerSnapshotGenerationProvider({
        advance: advanceGenerationState,
        current: () => generation,
      });
      yield* Effect.addFinalizer(() => Effect.sync(unregister));
    }

    const watcherMap = yield* LayerMap.make(
      (_key: "watcher") =>
        Layer.effect(
          RepositoryWatcher,
          makeGitReviewRepositoryWatcher({
            roots: {
              root: identity.root,
              gitDir: identity.gitDir,
              commonDir: identity.commonDir,
              headPath: path.join(identity.gitDir, "HEAD"),
              indexPath: path.join(identity.gitDir, "index"),
              syncedBranchPath: path.join(identity.gitDir, "codex-synced-branch.json"),
            },
            host: options.watchHost ?? localFileWatchHost,
            onChange: (event) =>
              invalidateGitReadCachesForRepoChange(event.changeType, event.changedPaths).pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("Could not invalidate Git repository caches").pipe(
                    Effect.annotateLogs({ cause }),
                  ),
                ),
                Effect.asVoid,
              ),
            onRequiresRecoveryChanged: (requiresRecovery) =>
              Ref.set(recovery, requiresRecovery).pipe(
                Effect.andThen(
                  PubSub.publish(watchEvents, {
                    _tag: "RecoveryChanged",
                    requiresRecovery,
                  }),
                ),
                Effect.asVoid,
              ),
          }).pipe(
            // Changes made while the lazy watcher was released cannot produce events.
            Effect.tap(() => advanceGeneration()),
          ),
        ),
      { idleTimeToLive: Duration.zero },
    );

    const repositoryWatchEvents = Stream.unwrap(
      Effect.gen(function* () {
        yield* watcherMap.contextEffect("watcher");
        const subscription = yield* PubSub.subscribe(watchEvents);
        const requiresRecovery = yield* Ref.get(recovery);
        return Stream.concat(
          // Repeat reads that may have started before watcher acquisition settled.
          Stream.fromArray<GitRepositoryWatchEvent>([
            { _tag: "Changed", event: { changeType: "head" } },
            { _tag: "RecoveryChanged", requiresRecovery },
          ]),
          Stream.fromSubscription(subscription),
        );
      }),
    );
    const recoverWatch = Effect.gen(function* () {
      const context = yield* watcherMap.contextEffect("watcher");
      yield* Context.get(context, RepositoryWatcher).recover;
    });

    return {
      advanceGeneration,
      get generation() {
        return generation;
      },
      identity,
      invalidateGitReadCachesForRepoChange,
      query,
      readSafeAttributeFilterOverrides,
      recoverWatch,
      runGit,
      untrackedPaths,
      watchEvents: repositoryWatchEvents,
    } satisfies WorktreeRepository;
  });
