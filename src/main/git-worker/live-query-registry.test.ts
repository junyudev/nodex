import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, test, vi } from "vite-plus/test";
import type { GitReviewSummaryResult } from "../../shared/types";
import type { GitWorkerLiveQueryEvent } from "../../shared/git-worker-protocol";
import {
  GIT_LIVE_QUERY_DEBOUNCE_MS,
  makeGitLiveQueryRegistry,
  shouldRefreshGitLiveQuery,
  type GitLiveQueryRegistryOptions,
  type LiveQueryRepository,
} from "./live-query-registry";
import type {
  GitReadQueryMeta,
  GitRepositoryError,
  GitRepositoryWatchEvent,
} from "./worktree-repository";

const makeRepository = Effect.gen(function* () {
  const changes = yield* PubSub.unbounded<GitRepositoryWatchEvent>();
  let generation = 1;
  let queryRuns = 0;
  let recoveries = 0;
  let watchReleases = 0;
  const repository: LiveQueryRepository = {
    advanceGeneration: () =>
      Effect.sync(() => {
        generation += 1;
        return generation;
      }),
    get generation() {
      return generation;
    },
    identity: {
      hostId: "local" as const,
      root: "/repo",
      gitDir: "/repo/.git",
      commonDir: "/repo/.git",
    },
    invalidateGitReadCachesForRepoChange: () => Effect.succeed(generation),
    query: <Result>(input: {
      readonly key: readonly unknown[];
      readonly meta?: GitReadQueryMeta;
      readonly run: Effect.Effect<Result, GitRepositoryError, Scope.Scope>;
      readonly staleTime?: number;
    }): Effect.Effect<Result, GitRepositoryError, Scope.Scope> =>
      Effect.sync(() => void (queryRuns += 1)).pipe(Effect.andThen(input.run)),
    readSafeAttributeFilterOverrides: Effect.succeed([]),
    recoverWatch: Effect.sync(() => void (recoveries += 1)),
    runGit: () => Effect.die("unused"),
    untrackedPaths: null as never,
    watchEvents: Stream.fromPubSub(changes).pipe(
      Stream.ensuring(Effect.sync(() => void (watchReleases += 1))),
    ),
  } satisfies LiveQueryRepository;
  return {
    repository,
    change: (event: GitRepositoryWatchEvent) =>
      Effect.sync(() => {
        if (event._tag === "Changed") generation += 1;
      }).pipe(Effect.andThen(PubSub.publish(changes, event)), Effect.asVoid),
    get queryRuns() {
      return queryRuns;
    },
    get recoveries() {
      return recoveries;
    },
    get watchReleases() {
      return watchReleases;
    },
  };
});

const settle = Effect.yieldNow.pipe(Effect.andThen(Effect.yieldNow));

const reviewQuery = {
  method: "review-summary",
  params: { cwd: "/repo", source: "unstaged", includeUntrackedFiles: true },
} as const;

const summary = (
  paths: string[],
  status: "modified" | "untracked" = "modified",
): Extract<GitReviewSummaryResult, { type: "success" }> => ({
  type: "success",
  source: "unstaged",
  files: paths.map((path) => ({
    path,
    previousPath: null,
    status,
    rawStatus: status === "untracked" ? "??" : "M",
    oldOid: null,
    newOid: null,
    revision: null,
    additions: 1,
    deletions: 0,
    safety: {
      binary: false,
      tooLarge: false,
      invalidText: false,
      renderable: true,
      sizeBytes: 1,
      mimeType: "text/plain",
      skipReason: null,
    },
  })),
  snapshotGeneration: 1,
  stageCounts: {
    stagedFileCount: 0,
    unstagedFileCount: status === "modified" ? paths.length : 0,
    untrackedFileCount: status === "untracked" ? paths.length : 0,
  },
  untrackedFilesOmitted: 0,
});

const reviewError: GitReviewSummaryResult = {
  type: "error",
  source: "unstaged",
  errorMessage: "Could not read changes.",
};

describe("GitLiveQueryRegistry", () => {
  test("defines an exhaustive semantic invalidation matrix", () => {
    expect(shouldRefreshGitLiveQuery("review-summary", "working-tree")).toBe(true);
    expect(shouldRefreshGitLiveQuery("branch-diff-stats", "index")).toBe(true);
    expect(shouldRefreshGitLiveQuery("base-branch", "working-tree")).toBe(false);
    expect(shouldRefreshGitLiveQuery("branch-commits", "remote-refs")).toBe(true);
  });

  it.effect("publishes useful tracked data before the complete result", () =>
    Effect.gen(function* () {
      const fake = yield* makeRepository;
      const complete = yield* Deferred.make<unknown>();
      const trackedSummary = summary(["tracked.ts"]);
      const completeSummary = summary(["tracked.ts", "new.ts"]);
      const execute: GitLiveQueryRegistryOptions["execute"] = vi.fn((input) => {
        const params = input.params as { includeUntrackedFiles?: boolean };
        return params.includeUntrackedFiles === false
          ? Effect.succeed(trackedSummary)
          : Deferred.await(complete);
      });
      const events: GitWorkerLiveQueryEvent["event"][] = [];
      const registry = yield* makeGitLiveQueryRegistry({
        registry: { get: () => Effect.succeed(fake.repository) },
        execute,
        publish: (event) => events.push(event.event),
      });
      yield* registry.subscribe({
        subscriptionId: "review",
        query: reviewQuery,
      });
      yield* settle;
      expect(events).toEqual([
        expect.objectContaining({ phase: "tracked", result: trackedSummary }),
      ]);

      yield* Deferred.succeed(complete, completeSummary);
      yield* settle;
      expect(events).toEqual([
        expect.objectContaining({ phase: "tracked", result: trackedSummary }),
        expect.objectContaining({ phase: "complete", result: completeSummary }),
      ]);
    }),
  );

  it.effect("waits for the complete result when all changed files are untracked", () =>
    Effect.gen(function* () {
      const fake = yield* makeRepository;
      const complete = yield* Deferred.make<GitReviewSummaryResult>();
      const events: GitWorkerLiveQueryEvent["event"][] = [];
      const completeSummary = summary(["new.ts"], "untracked");
      const registry = yield* makeGitLiveQueryRegistry({
        registry: { get: () => Effect.succeed(fake.repository) },
        execute: (input) =>
          (input.params as { includeUntrackedFiles?: boolean }).includeUntrackedFiles === false
            ? Effect.succeed(summary([]))
            : Deferred.await(complete),
        publish: (event) => events.push(event.event),
      });
      yield* registry.subscribe({ subscriptionId: "review", query: reviewQuery });
      yield* settle;
      expect(events).toEqual([]);

      yield* Deferred.succeed(complete, completeSummary);
      yield* settle;
      expect(events).toEqual([
        expect.objectContaining({ phase: "complete", result: completeSummary }),
      ]);
    }),
  );

  it.effect("stops the attempt when the tracked read returns an operational error", () =>
    Effect.gen(function* () {
      const fake = yield* makeRepository;
      const events: GitWorkerLiveQueryEvent["event"][] = [];
      const execute: GitLiveQueryRegistryOptions["execute"] = vi.fn(() =>
        Effect.succeed(reviewError),
      );
      const registry = yield* makeGitLiveQueryRegistry({
        registry: { get: () => Effect.succeed(fake.repository) },
        execute,
        publish: (event) => events.push(event.event),
      });
      yield* registry.subscribe({ subscriptionId: "review", query: reviewQuery });
      yield* settle;

      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledWith(
        expect.objectContaining({
          params: { ...reviewQuery.params, includeUntrackedFiles: false },
        }),
      );
      expect(events).toEqual([expect.objectContaining({ phase: "complete", result: reviewError })]);
    }),
  );

  it.effect("completes with the useful tracked snapshot if the untracked scan fails", () =>
    Effect.gen(function* () {
      const fake = yield* makeRepository;
      const events: GitWorkerLiveQueryEvent["event"][] = [];
      const trackedSummary = summary(["tracked.ts"]);
      const execute: GitLiveQueryRegistryOptions["execute"] = vi.fn((input) =>
        Effect.succeed(
          (input.params as { includeUntrackedFiles?: boolean }).includeUntrackedFiles === false
            ? trackedSummary
            : reviewError,
        ),
      );
      const registry = yield* makeGitLiveQueryRegistry({
        registry: { get: () => Effect.succeed(fake.repository) },
        execute,
        publish: (event) => events.push(event.event),
      });
      yield* registry.subscribe({ subscriptionId: "review", query: reviewQuery });
      yield* settle;
      expect(events).toEqual([
        expect.objectContaining({ phase: "tracked", result: trackedSummary }),
        expect.objectContaining({ phase: "complete", result: trackedSummary }),
      ]);

      yield* TestClock.adjust(5_000);
      expect(execute).toHaveBeenCalledTimes(2);
    }),
  );

  it.effect.each([[], ["tracked.ts"]])(
    "publishes a successful empty complete result with tracked paths %j",
    (trackedPaths) =>
      Effect.gen(function* () {
        const fake = yield* makeRepository;
        const events: GitWorkerLiveQueryEvent["event"][] = [];
        const trackedSummary = summary(trackedPaths);
        const emptySummary = summary([]);
        const registry = yield* makeGitLiveQueryRegistry({
          registry: { get: () => Effect.succeed(fake.repository) },
          execute: (input) =>
            Effect.succeed(
              (input.params as { includeUntrackedFiles?: boolean }).includeUntrackedFiles === false
                ? trackedSummary
                : emptySummary,
            ),
          publish: (event) => events.push(event.event),
        });
        yield* registry.subscribe({ subscriptionId: "review", query: reviewQuery });
        yield* settle;

        expect(events).toEqual([
          ...(trackedPaths.length > 0
            ? [expect.objectContaining({ phase: "tracked", result: trackedSummary })]
            : []),
          expect.objectContaining({ phase: "complete", result: emptySummary }),
        ]);
      }),
  );

  it.effect("coalesces a burst of relevant changes into one refresh", () =>
    Effect.gen(function* () {
      const fake = yield* makeRepository;
      let executions = 0;
      const registry = yield* makeGitLiveQueryRegistry({
        registry: { get: () => Effect.succeed(fake.repository) },
        execute: () => Effect.sync(() => ({ generation: ++executions })),
        publish: () => undefined,
      });
      yield* registry.subscribe({
        subscriptionId: "branch",
        query: { method: "branch-diff-stats", params: { cwd: "/repo" } },
      });
      yield* settle;
      expect(executions).toBe(1);

      yield* fake.change({ _tag: "Changed", event: { changeType: "working-tree" } });
      yield* fake.change({ _tag: "Changed", event: { changeType: "index" } });
      yield* settle;
      yield* TestClock.adjust(GIT_LIVE_QUERY_DEBOUNCE_MS);
      yield* settle;
      expect(executions).toBe(2);
    }),
  );

  it.effect("recovers the watcher and interrupts observation with its owner Scope", () =>
    Effect.gen(function* () {
      const fake = yield* makeRepository;
      const parentScope = yield* Scope.Scope;
      const owner = yield* Scope.fork(parentScope);
      const registry = yield* makeGitLiveQueryRegistry({
        registry: { get: () => Effect.succeed(fake.repository) },
        execute: () => Effect.succeed({ defaultBranch: "main" }),
        publish: () => undefined,
      }).pipe(Scope.provide(owner));
      yield* registry
        .subscribe({
          subscriptionId: "base",
          query: { method: "base-branch", params: { cwd: "/repo" } },
        })
        .pipe(Scope.provide(owner));
      yield* settle;

      expect(yield* registry.recover("base").pipe(Scope.provide(owner))).toBe(true);
      expect(fake.recoveries).toBe(1);

      yield* Scope.close(owner, Exit.void);
      yield* Effect.yieldNow;
      expect(fake.watchReleases).toBe(1);
    }),
  );
});
