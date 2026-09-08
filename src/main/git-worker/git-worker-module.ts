import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type { GitStatusSummaryResult } from "../../shared/git-review";
import type {
  GitActionMutationResult,
  GitBranchMetadataResult,
  GitPushInput,
  GitReviewRepositoryMetadataResult,
} from "../../shared/types";
import type {
  GitPerformanceOperationMetric,
  GitWorkerLiveQueryEvent,
  GitWorkerMethod,
  GitWorkerMethodMap,
  GitWorkerPerformanceOperationEvent,
  GitWorkerRequest,
} from "../../shared/git-worker-protocol";
import { GIT_WORKER_PROTOCOL_VERSION } from "../../shared/git-worker-protocol";
import {
  applyGitReviewPatch,
  GitReviewRuntime,
  isGitReviewStaleSnapshotError,
  readBranchDiffStats,
  readGitReviewBaseBranch,
  readGitReviewBlameFile,
  readGitReviewBranchCommits,
  readGitReviewCatFile,
  readGitReviewDiff,
  readGitReviewGeneratedPaths,
  readGitReviewPatch,
  readGitReviewSnapshot,
  readGitReviewSummary,
  resolveGitMergeBase,
  runGitReviewOperationWithSignal,
  searchGitReview,
} from "./git-review-operations";
import {
  gitPerformancePromise,
  makeGitCommandRunner,
  runGitPerformanceOperationEffect,
} from "./git-command-runner";
import type { GitCommandPlatform } from "./git-command-platform";
import { makeGitLiveQueryRegistry, type GitLiveQueryRegistry } from "./live-query-registry";
import { makeGitRepositoryRegistry, type GitRepositoryRegistry } from "./repository-registry";
import type { GitRepositoryError, WorktreeRepository } from "./worktree-repository";

function commandErrorMessage(stderr: string, fallback: string): string {
  return stderr.trim() || fallback;
}

function parseTrackedStatusCounts(status: string): {
  stagedCount: number;
  unstagedCount: number;
} {
  let stagedCount = 0;
  let unstagedCount = 0;
  for (const record of status.split("\0")) {
    if (record.length < 3) continue;
    const indexStatus = record[0];
    const worktreeStatus = record[1];
    if (indexStatus && indexStatus !== " " && indexStatus !== "?") stagedCount += 1;
    if (worktreeStatus && worktreeStatus !== " " && worktreeStatus !== "?") {
      unstagedCount += 1;
    }
  }
  return { stagedCount, unstagedCount };
}

function normalizeGitWorkerQueryParams(params: unknown): unknown {
  if (!params || typeof params !== "object" || Array.isArray(params)) return params;
  const normalized = { ...params } as Record<string, unknown>;
  delete normalized.requestId;
  delete normalized.operationSource;
  return normalized;
}

const GIT_MUTATION_METHODS = new Set<GitWorkerMethod>([
  "apply-patch",
  "checkout-branch",
  "commit",
  "create-branch",
  "git-init-repo",
  "push",
  "refresh-repository",
]);

function classifyGitWorkerOperationOutcome(
  result: unknown,
): GitPerformanceOperationMetric["outcome"] {
  if (!result || typeof result !== "object") return "success";
  if ("type" in result && result.type === "stale-snapshot") return "stale";
  if ("type" in result && result.type === "error") {
    if (
      "failureReason" in result &&
      (result.failureReason === "timed-out" || result.failureReason === "timed_out")
    ) {
      return "timed-out";
    }
    if ("failureReason" in result && result.failureReason === "canceled") return "canceled";
    return "operational-error";
  }
  if ("status" in result && result.status === "error") return "operational-error";
  return "success";
}

const isInterrupted = (cause: Cause.Cause<unknown>): boolean =>
  cause.reasons.length > 0 && cause.reasons.every(Cause.isInterruptReason);

export interface GitWorkerModule {
  readonly execute: (
    request: GitWorkerRequest["request"],
  ) => Effect.Effect<unknown, never, Scope.Scope>;
}

export interface GitWorkerModuleOptions {
  readonly environment: NodeJS.ProcessEnv;
  readonly publish?: (event: GitWorkerLiveQueryEvent | GitWorkerPerformanceOperationEvent) => void;
}

class GitWorkerModuleState implements GitWorkerModule {
  readonly #registry: GitRepositoryRegistry;
  readonly #reviewRuntime: GitReviewRuntime;
  readonly #publish: (event: GitWorkerLiveQueryEvent | GitWorkerPerformanceOperationEvent) => void;
  readonly #liveQueries: GitLiveQueryRegistry;

  constructor(options: {
    liveQueries: GitLiveQueryRegistry;
    publish: (event: GitWorkerLiveQueryEvent | GitWorkerPerformanceOperationEvent) => void;
    registry: GitRepositoryRegistry;
    reviewRuntime: GitReviewRuntime;
  }) {
    this.#reviewRuntime = options.reviewRuntime;
    this.#registry = options.registry;
    this.#publish = options.publish;
    this.#liveQueries = options.liveQueries;
  }

  readonly execute: GitWorkerModule["execute"] = Effect.fn("GitWorkerModule.execute")(function* (
    this: GitWorkerModuleState,
    request: GitWorkerRequest["request"],
  ) {
    const trigger = /:(?:tracked|complete)$/.test(request.id)
      ? "live"
      : GIT_MUTATION_METHODS.has(request.method)
        ? "mutation"
        : "direct";
    return yield* runGitPerformanceOperationEffect({
      operation: request.method,
      trigger,
      classifyOutcome: classifyGitWorkerOperationOutcome,
      publish: (metric) =>
        this.#publish({ type: "git-performance-operation", workerId: "git", metric }),
      run: this.#executeRequest(request).pipe(Effect.orDie),
    });
  });

  readonly #executeRequest = Effect.fn("GitWorkerModule.executeRequest")(function* (
    this: GitWorkerModuleState,
    request: GitWorkerRequest["request"],
  ) {
    switch (request.method) {
      case "probe":
        return { nonce: request.params.nonce, protocolVersion: GIT_WORKER_PROTOCOL_VERSION };
      case "stable-metadata":
        return yield* this.#readStableMetadata(request.params.cwd);
      case "branch-metadata":
        return yield* this.#readBranchMetadata(request.params.cwd);
      case "status-summary":
        return yield* this.#readStatusSummary(
          request.params.cwd,
          request.params.includeUntrackedFiles === true,
        );
      case "action-status":
        return yield* this.#readActionStatus(request.params.cwd);
      case "review-summary":
        return yield* this.#runReviewRequest({
          method: request.method,
          params: request.params,
          cwd: request.params.cwd,
          source: request.params.source,
          operation: (repository) =>
            Effect.gen({ self: this }, function* () {
              const includeUntracked =
                request.params.includeUntrackedFiles !== false &&
                (request.params.source === "unstaged" || request.params.source === "branch");
              const [untracked, status] = repository
                ? yield* Effect.all(
                    [
                      includeUntracked ? repository.untrackedPaths.read() : Effect.succeed(null),
                      this.#readStatusSummary(repository.identity.root, includeUntracked),
                    ] as const,
                    { concurrency: "unbounded" },
                  )
                : [null, null];
              return yield* this.#runOperation(() =>
                readGitReviewSummary({
                  ...request.params,
                  requestId: request.id,
                  ...(includeUntracked && repository
                    ? {
                        precomputedUntrackedPaths: untracked?.success ? untracked.paths : null,
                        untrackedFilesOmitted: untracked?.omittedCount ?? 0,
                      }
                    : {}),
                  ...(repository
                    ? {
                        precomputedStageCounts:
                          status?.type === "success"
                            ? {
                                stagedFileCount: status.stagedCount,
                                unstagedFileCount: status.unstagedCount,
                                untrackedFileCount: status.untrackedCount ?? 0,
                              }
                            : null,
                      }
                    : {}),
                }),
              );
            }),
        });
      case "branch-diff-stats":
        return yield* this.#runReviewRequest({
          method: request.method,
          params: request.params,
          cwd: request.params.cwd,
          source: "branch",
          operation: (repository) =>
            Effect.gen({ self: this }, function* () {
              const includeUntracked = request.params.includeUntrackedFiles === true;
              const untracked =
                includeUntracked && repository ? yield* repository.untrackedPaths.read() : null;
              return yield* this.#runOperation(() =>
                readBranchDiffStats({
                  ...request.params,
                  requestId: request.id,
                  ...(includeUntracked && repository
                    ? {
                        precomputedUntrackedPaths: untracked?.success ? untracked.paths : null,
                        untrackedFilesOmitted: untracked?.omittedCount ?? 0,
                      }
                    : {}),
                }),
              );
            }),
        });
      case "review-diff":
        return yield* this.#runReviewRequest({
          method: request.method,
          params: request.params,
          cwd: request.params.cwd,
          source: request.params.source,
          operation: () =>
            this.#runOperation(() =>
              readGitReviewDiff({ ...request.params, requestId: request.id }),
            ),
        });
      case "review-cat-file":
        yield* this.#registry.get(request.params.cwd);
        return {
          type: "success",
          value: yield* this.#runOperation(() => readGitReviewCatFile(request.params)),
        } satisfies GitWorkerMethodMap["review-cat-file"]["result"];
      case "review-generated-paths":
        yield* this.#registry.get(request.params.cwd);
        return yield* this.#runOperation(() => readGitReviewGeneratedPaths(request.params));
      case "review-search":
        return yield* this.#runReviewRequest({
          method: request.method,
          params: request.params,
          cwd: request.params.cwd,
          source: request.params.source,
          operation: () =>
            this.#runOperation(() => searchGitReview({ ...request.params, requestId: request.id })),
        });
      case "review-patch":
        return yield* this.#runReviewRequest({
          method: request.method,
          params: request.params,
          cwd: request.params.cwd,
          source: request.params.source,
          operation: () =>
            this.#runOperation(() =>
              readGitReviewPatch({ ...request.params, requestId: request.id }),
            ),
        });
      case "blame-file":
        yield* this.#registry.get(request.params.cwd);
        return yield* this.#runOperation(() => readGitReviewBlameFile(request.params));
      case "base-branch":
        return yield* this.#runReviewRequest({
          method: request.method,
          params: request.params,
          cwd: request.params.cwd,
          source: "branch",
          operation: () =>
            this.#runOperation(() =>
              readGitReviewBaseBranch({ ...request.params, requestId: request.id }),
            ),
        });
      case "branch-commits":
        return yield* this.#runReviewRequest({
          method: request.method,
          params: request.params,
          cwd: request.params.cwd,
          source: "branch",
          operation: () =>
            this.#runOperation(() =>
              readGitReviewBranchCommits({ ...request.params, requestId: request.id }),
            ),
        });
      case "merge-base":
        yield* this.#registry.get(request.params.cwd);
        return yield* this.#runOperation(() => resolveGitMergeBase(request.params));
      case "refresh-repository": {
        const repository = yield* this.#registry.get(request.params.cwd);
        if (!repository) return { type: "error", failureReason: "not-a-repository" };
        return {
          type: "success",
          generation: yield* repository.invalidateGitReadCachesForRepoChange("head"),
        };
      }
      case "git-init-repo": {
        const repository = yield* this.#registry.initialize(request.params.cwd);
        if (!repository) {
          return {
            cwd: request.params.cwd,
            source: "unstaged",
            patch: "",
            files: [],
            isGitRepository: false,
            baseRef: null,
            currentBranch: null,
            defaultBranch: null,
            errorMessage: "Could not initialize Git repository.",
            snapshotGeneration: 0,
          };
        }
        yield* repository.invalidateGitReadCachesForRepoChange("head");
        return yield* this.#runOperation(() =>
          readGitReviewSnapshot({ cwd: repository.identity.root, source: "unstaged" }),
        );
      }
      case "apply-patch": {
        const repository = yield* this.#registry.get(request.params.cwd);
        const result = yield* this.#runOperation(() => applyGitReviewPatch(request.params));
        if (result.status !== "error" && repository) {
          yield* repository.invalidateGitReadCachesForRepoChange(
            request.params.target === "staged" ? "index" : "working-tree",
          );
        }
        return result;
      }
      case "checkout-branch":
        return yield* this.#mutateBranch(request.params.cwd, request.params.branch, false);
      case "create-branch":
        return yield* this.#mutateBranch(request.params.cwd, request.params.branch, true);
      case "commit":
        return yield* this.#commit(request.params);
      case "push":
        return yield* this.#push(request.params);
      case "subscribe-live-query":
        yield* this.#liveQueries.subscribe(request.params);
        return { subscribed: true };
      case "unsubscribe-live-query":
        return {
          unsubscribed: yield* this.#liveQueries.unsubscribe(request.params.subscriptionId),
        };
      case "recover-live-query":
        return { recovered: yield* this.#liveQueries.recover(request.params.subscriptionId) };
      case "refresh-live-query":
        return { refreshed: yield* this.#liveQueries.refresh(request.params.subscriptionId) };
    }
  });

  readonly #runOperation = <Result>(operation: () => Promise<Result>): Effect.Effect<Result> =>
    gitPerformancePromise((signal) =>
      runGitReviewOperationWithSignal(this.#reviewRuntime, signal, operation),
    );

  readonly #runReviewRequest = Effect.fn("GitWorkerModule.runReviewRequest")(function* <Result>(
    this: GitWorkerModuleState,
    input: {
      method: GitWorkerMethod;
      params: unknown;
      cwd: string;
      source: import("../../shared/types").GitReviewSource;
      operation: (
        repository: WorktreeRepository | null,
      ) => Effect.Effect<Result, GitRepositoryError, Scope.Scope>;
    },
  ) {
    const repository = yield* this.#registry.get(input.cwd);
    const run = input.operation(repository).pipe(
      Effect.catchCause((cause) => {
        if (isInterrupted(cause)) return Effect.failCause(cause);
        const error = Cause.squash(cause);
        return isGitReviewStaleSnapshotError(error)
          ? Effect.succeed({ type: "stale-snapshot" as const, source: input.source })
          : Effect.failCause(cause);
      }),
    );
    if (!repository) return yield* run;
    return yield* repository.query({
      key: [
        "review-operation",
        input.method,
        normalizeGitWorkerQueryParams(input.params),
        repository.generation,
      ],
      meta: {
        gitReadDomains: ["config", "head", "index", "local-refs", "remote-refs", "working-tree"],
        gitReadGeneration: repository.generation,
      },
      staleTime: 0,
      run,
    });
  });

  readonly #readStableMetadata = Effect.fn("GitWorkerModule.readStableMetadata")(function* (
    this: GitWorkerModuleState,
    cwd: string,
  ) {
    const repository = yield* this.#registry.get(cwd);
    if (!repository) {
      return {
        cwd,
        root: null,
        gitDir: null,
        commonDir: null,
        isGitRepository: false,
        currentBranch: null,
        defaultBranch: null,
        errorMessage: null,
      } satisfies GitReviewRepositoryMetadataResult;
    }
    return yield* repository.query({
      key: ["stable-metadata", repository.identity.root],
      meta: { gitReadDomains: ["config", "head", "local-refs", "remote-refs"] },
      run: this.#loadStableMetadata(repository, cwd),
    });
  });

  readonly #loadStableMetadata = Effect.fn("GitWorkerModule.loadStableMetadata")(function* (
    this: GitWorkerModuleState,
    repository: WorktreeRepository,
    cwd: string,
  ) {
    const [currentResult, branchesResult, defaultResult] = yield* Effect.all(
      [
        repository.runGit(["branch", "--show-current"]),
        repository.runGit(["branch", "--format=%(refname:short)"]),
        repository.runGit(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], {
          allowedNonZeroExitCodes: [1, 128],
        }),
      ] as const,
      { concurrency: "unbounded" },
    );
    if (!currentResult.success || !branchesResult.success || !defaultResult.success) {
      const failure = [currentResult, branchesResult, defaultResult].find(
        (result) => !result.success,
      );
      return {
        cwd,
        root: repository.identity.root,
        gitDir: repository.identity.gitDir,
        commonDir: repository.identity.commonDir,
        isGitRepository: true,
        currentBranch: null,
        defaultBranch: null,
        errorMessage: commandErrorMessage(
          failure?.stderr ?? "",
          "Could not read Git repository metadata.",
        ),
      } satisfies GitReviewRepositoryMetadataResult;
    }
    const currentBranch = currentResult.stdout.trim() || null;
    const branches = branchesResult.stdout
      .split(/\r?\n/)
      .map((branch) => branch.trim())
      .filter(Boolean);
    const remoteDefault = defaultResult.stdout.trim();
    const defaultBranch = remoteDefault.startsWith("origin/")
      ? remoteDefault.slice("origin/".length)
      : remoteDefault ||
        (branches.includes("main")
          ? "main"
          : branches.includes("master")
            ? "master"
            : currentBranch);
    return {
      cwd,
      root: repository.identity.root,
      gitDir: repository.identity.gitDir,
      commonDir: repository.identity.commonDir,
      isGitRepository: true,
      currentBranch,
      defaultBranch,
      errorMessage: null,
    } satisfies GitReviewRepositoryMetadataResult;
  });

  readonly #readBranchMetadata: (
    cwd: string,
  ) => Effect.Effect<GitBranchMetadataResult, GitRepositoryError, Scope.Scope> = Effect.fn(
    "GitWorkerModule.readBranchMetadata",
  )(function* (this: GitWorkerModuleState, cwd: string) {
    const repository = yield* this.#registry.get(cwd);
    if (!repository) return { currentBranch: null, defaultBranch: null, branches: [] };
    return yield* repository.query({
      key: ["branch-metadata", repository.generation],
      meta: {
        gitReadDomains: ["config", "head", "local-refs", "remote-refs"],
        gitReadGeneration: repository.generation,
      },
      run: Effect.gen(function* () {
        const [current, branchList, remoteBranches, remoteDefault] = yield* Effect.all(
          [
            repository.runGit(["branch", "--show-current"]),
            repository.runGit(["branch", "--format=%(refname:short)"]),
            repository.runGit(["for-each-ref", "--format=%(refname)", "refs/remotes"]),
            repository.runGit(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], {
              allowedNonZeroExitCodes: [1, 128],
            }),
          ] as const,
          { concurrency: "unbounded" },
        );
        if (
          !current.success ||
          !branchList.success ||
          !remoteBranches.success ||
          !remoteDefault.success
        ) {
          return { currentBranch: null, defaultBranch: null, branches: [] };
        }
        const currentBranch = current.stdout.trim() || null;
        const branches = [
          ...new Set(
            branchList.stdout
              .split(/\r?\n/)
              .map((branch) => branch.trim())
              .filter(Boolean),
          ),
        ];
        const remoteBranchRefs = [
          ...new Set(
            remoteBranches.stdout
              .split(/\r?\n/)
              .map((branch) => branch.trim())
              .filter((branch) => branch.length > 0 && !branch.endsWith("/HEAD")),
          ),
        ];
        const remoteDefaultBranch = remoteDefault.stdout.trim();
        const defaultBranch = remoteDefaultBranch.startsWith("origin/")
          ? remoteDefaultBranch.slice("origin/".length)
          : remoteDefaultBranch ||
            (branches.includes("main")
              ? "main"
              : branches.includes("master")
                ? "master"
                : currentBranch);
        return { currentBranch, defaultBranch, branches, remoteBranchRefs };
      }),
    });
  });

  readonly #readStatusSummary: (
    cwd: string,
    includeUntrackedFiles: boolean,
  ) => Effect.Effect<GitStatusSummaryResult, GitRepositoryError, Scope.Scope> = Effect.fn(
    "GitWorkerModule.readStatusSummary",
  )(function* (this: GitWorkerModuleState, cwd: string, includeUntrackedFiles: boolean) {
    const repository = yield* this.#registry.get(cwd);
    if (!repository) {
      return { type: "error", failureReason: "not-a-repository", errorMessage: null };
    }
    return yield* repository.query({
      key: [
        "status-summary",
        includeUntrackedFiles ? "complete" : "tracked",
        repository.generation,
      ],
      meta: {
        gitReadDomains: ["index", "working-tree"],
        gitReadGeneration: repository.generation,
      },
      staleTime: 0,
      run: Effect.gen(function* () {
        const configOverrides = yield* repository.readSafeAttributeFilterOverrides.pipe(
          Effect.catch(() => Effect.succeed(null)),
        );
        if (!configOverrides) {
          return {
            type: "error",
            failureReason: "status-config",
            errorMessage: "Could not read Git status configuration.",
          } satisfies GitStatusSummaryResult;
        }
        const result = yield* repository.runGit(
          ["status", "--no-renames", "--porcelain=v1", "-z", "--untracked-files=no"],
          { configOverrides },
        );
        if (!result.success) {
          return {
            type: "error",
            failureReason:
              result.failureReason === "timed_out"
                ? "timed-out"
                : result.failureReason === "canceled"
                  ? "canceled"
                  : "status-command",
            errorMessage: commandErrorMessage(result.stderr, "Could not read Git status."),
          } satisfies GitStatusSummaryResult;
        }
        const counts = parseTrackedStatusCounts(result.stdout);
        if (!includeUntrackedFiles) {
          return {
            type: "success",
            ...counts,
            untrackedCount: null,
            snapshotGeneration: repository.generation,
          } satisfies GitStatusSummaryResult;
        }
        const untracked = yield* repository.untrackedPaths.read();
        if (!untracked.success) {
          return {
            type: "error",
            failureReason: "untracked-paths",
            errorMessage: "Could not read untracked Git paths.",
          } satisfies GitStatusSummaryResult;
        }
        return {
          type: "success",
          ...counts,
          untrackedCount: untracked.paths.length + untracked.omittedCount,
          snapshotGeneration: repository.generation,
        } satisfies GitStatusSummaryResult;
      }),
    });
  });

  readonly #mutateBranch = Effect.fn("GitWorkerModule.mutateBranch")(function* (
    this: GitWorkerModuleState,
    cwd: string,
    rawBranch: string,
    create: boolean,
  ) {
    const repository = yield* this.#registry.get(cwd);
    if (!repository) return { type: "error" as const, errorMessage: "Git repository is required." };
    const branch = rawBranch.trim();
    const validation = yield* repository.runGit(["check-ref-format", "--branch", branch]);
    if (!validation.success) {
      return { type: "error" as const, errorMessage: "Branch name is invalid." };
    }
    const result = yield* repository.runGit(
      create ? ["checkout", "-b", branch] : ["checkout", branch],
      { timeoutMs: null },
    );
    if (!result.success) {
      return {
        type: "error" as const,
        errorMessage: commandErrorMessage(
          result.stderr,
          create ? "Could not create branch." : "Could not switch branch.",
        ),
      };
    }
    yield* repository.invalidateGitReadCachesForRepoChange("head");
    return {
      type: "success" as const,
      value: yield* this.#readBranchMetadata(repository.identity.root),
    };
  });

  readonly #readActionStatus = Effect.fn("GitWorkerModule.readActionStatus")(function* (
    this: GitWorkerModuleState,
    cwd: string,
  ) {
    const repository = yield* this.#registry.get(cwd);
    const empty = (errorMessage: string | null = null) => ({
      cwd,
      isGitRepository: false,
      currentBranch: null,
      defaultBranch: null,
      upstreamBranch: null,
      remotes: [],
      hasHeadCommit: false,
      hasStagedChanges: false,
      hasUnstagedChanges: false,
      hasUntrackedFiles: false,
      hasUncommittedChanges: false,
      commitsAhead: 0,
      canCommit: false,
      canPush: false,
      pushNeedsUpstream: false,
      errorMessage,
    });
    if (!repository) return empty();
    return yield* repository.query({
      key: ["action-status", repository.generation],
      meta: {
        gitReadDomains: ["config", "head", "index", "local-refs", "remote-refs", "working-tree"],
        gitReadGeneration: repository.generation,
      },
      run: Effect.gen({ self: this }, function* () {
        const [branches, head, staged, unstaged, remotes, upstream, untracked] = yield* Effect.all(
          [
            this.#readBranchMetadata(repository.identity.root),
            repository.runGit(["rev-parse", "--verify", "HEAD"], {
              allowedNonZeroExitCodes: [128],
            }),
            repository.runGit(["diff", "--quiet", "--cached"], {
              allowedNonZeroExitCodes: [1],
            }),
            repository.runGit(["diff", "--quiet"], { allowedNonZeroExitCodes: [1] }),
            repository.runGit(["remote"]),
            repository.runGit(
              ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
              { allowedNonZeroExitCodes: [128] },
            ),
            repository.untrackedPaths.read(),
          ] as const,
          { concurrency: "unbounded" },
        );
        const required = [head, staged, unstaged, remotes, upstream];
        if (required.some((result) => !result.success) || !untracked.success) {
          return { ...empty("Could not read Git action status."), cwd: repository.identity.root };
        }
        const hasHeadCommit = head.code === 0;
        const hasStagedChanges = staged.code === 1;
        const hasUntrackedFiles = untracked.paths.length + untracked.omittedCount > 0;
        const hasUnstagedChanges = unstaged.code === 1 || hasUntrackedFiles;
        const upstreamBranch = upstream.code === 0 ? upstream.stdout.trim() || null : null;
        const remoteNames = remotes.stdout
          .split(/\r?\n/)
          .map((name) => name.trim())
          .filter(Boolean);
        const ahead = upstreamBranch
          ? yield* repository.runGit(["rev-list", "--count", `${upstreamBranch}..HEAD`], {
              allowedNonZeroExitCodes: [128],
            })
          : null;
        const commitsAhead = Number.parseInt(ahead?.stdout.trim() ?? "0", 10) || 0;
        const hasUncommittedChanges = hasStagedChanges || hasUnstagedChanges;
        const pushNeedsUpstream =
          hasHeadCommit && branches.currentBranch !== null && upstreamBranch === null;
        const canPush =
          hasHeadCommit &&
          branches.currentBranch !== null &&
          (upstreamBranch !== null ? commitsAhead > 0 : remoteNames.includes("origin"));
        return {
          cwd: repository.identity.root,
          isGitRepository: true,
          currentBranch: branches.currentBranch,
          defaultBranch: branches.defaultBranch,
          upstreamBranch,
          remotes: remoteNames,
          hasHeadCommit,
          hasStagedChanges,
          hasUnstagedChanges,
          hasUntrackedFiles,
          hasUncommittedChanges,
          commitsAhead,
          canCommit: hasUncommittedChanges,
          canPush,
          pushNeedsUpstream,
          errorMessage: null,
        };
      }),
    });
  });

  readonly #commit = Effect.fn("GitWorkerModule.commit")(function* (
    this: GitWorkerModuleState,
    input: import("../../shared/types").GitCommitInput,
  ) {
    const repository = yield* this.#registry.get(input.cwd);
    if (!repository) {
      return {
        cwd: input.cwd,
        status: "error",
        branch: null,
        stdout: "",
        stderr: "",
        errorMessage: "Git repository is required before committing.",
      } satisfies GitActionMutationResult;
    }
    const branches = yield* this.#readBranchMetadata(repository.identity.root);
    if (input.includeUnstaged !== false) {
      const add = yield* repository.runGit(["add", "-A"], { timeoutMs: null });
      if (!add.success) {
        return {
          cwd: repository.identity.root,
          status: "error",
          branch: branches.currentBranch,
          stdout: add.stdout,
          stderr: add.stderr,
          errorMessage: commandErrorMessage(add.stderr, "Could not stage changes."),
        } satisfies GitActionMutationResult;
      }
    }
    const staged = yield* repository.runGit(["diff", "--quiet", "--cached"], {
      allowedNonZeroExitCodes: [1],
    });
    if (!staged.success || staged.code !== 1) {
      return {
        cwd: repository.identity.root,
        status: "error",
        branch: branches.currentBranch,
        stdout: staged.stdout,
        stderr: staged.stderr,
        errorMessage: staged.success
          ? "No staged changes to commit."
          : commandErrorMessage(staged.stderr, "Could not inspect staged changes."),
      } satisfies GitActionMutationResult;
    }
    const commit = yield* repository.runGit(["commit", "-m", input.message.trim()], {
      timeoutMs: null,
    });
    if (!commit.success) {
      return {
        cwd: repository.identity.root,
        status: "error",
        branch: branches.currentBranch,
        stdout: commit.stdout,
        stderr: commit.stderr,
        errorMessage: commandErrorMessage(commit.stderr, "Could not commit changes."),
      } satisfies GitActionMutationResult;
    }
    yield* repository.invalidateGitReadCachesForRepoChange("head");
    return {
      cwd: repository.identity.root,
      status: "success",
      branch: branches.currentBranch,
      stdout: commit.stdout,
      stderr: commit.stderr,
      errorMessage: null,
    } satisfies GitActionMutationResult;
  });

  readonly #push = Effect.fn("GitWorkerModule.push")(function* (
    this: GitWorkerModuleState,
    input: GitPushInput,
  ) {
    const repository = yield* this.#registry.get(input.cwd);
    if (!repository) {
      return {
        cwd: input.cwd,
        status: "error",
        branch: null,
        stdout: "",
        stderr: "",
        errorMessage: "Git repository is required before pushing.",
      } satisfies GitActionMutationResult;
    }
    const [current, remotes, upstream] = yield* Effect.all(
      [
        repository.runGit(["branch", "--show-current"]),
        repository.runGit(["remote"]),
        repository.runGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], {
          allowedNonZeroExitCodes: [128],
        }),
      ] as const,
      { concurrency: "unbounded" },
    );
    const branch = current.success ? current.stdout.trim() || null : null;
    const failed = [current, remotes, upstream].find((result) => !result.success);
    if (failed) {
      return {
        cwd: repository.identity.root,
        status: "error",
        branch,
        stdout: failed.stdout,
        stderr: failed.stderr,
        errorMessage: commandErrorMessage(failed.stderr, "Could not inspect Git push state."),
      } satisfies GitActionMutationResult;
    }
    if (!branch) {
      return {
        cwd: repository.identity.root,
        status: "error",
        branch: null,
        stdout: "",
        stderr: "",
        errorMessage: "Current branch is required before pushing.",
      } satisfies GitActionMutationResult;
    }
    const upstreamBranch = upstream.code === 0 ? upstream.stdout.trim() || null : null;
    const remoteNames = remotes.stdout
      .split(/\r?\n/)
      .map((name) => name.trim())
      .filter(Boolean);
    if (!upstreamBranch && !remoteNames.includes("origin")) {
      return {
        cwd: repository.identity.root,
        status: "error",
        branch,
        stdout: "",
        stderr: "",
        errorMessage: "No upstream branch or origin remote is configured.",
      } satisfies GitActionMutationResult;
    }
    const result = yield* repository.runGit(
      [
        "push",
        ...(input.force ? ["--force-with-lease"] : []),
        ...(upstreamBranch ? [] : ["-u", "origin", branch]),
      ],
      { timeoutMs: 30_000 },
    );
    if (!result.success) {
      return {
        cwd: repository.identity.root,
        status: "error",
        branch,
        stdout: result.stdout,
        stderr: result.stderr,
        errorMessage: commandErrorMessage(result.stderr, "Could not push changes."),
      } satisfies GitActionMutationResult;
    }
    yield* repository.invalidateGitReadCachesForRepoChange("remote-refs");
    return {
      cwd: repository.identity.root,
      status: "success",
      branch,
      stdout: result.stdout,
      stderr: result.stderr,
      errorMessage: null,
    } satisfies GitActionMutationResult;
  });
}

export const makeGitWorkerModule = (
  options: GitWorkerModuleOptions,
): Effect.Effect<GitWorkerModule, never, GitCommandPlatform | Scope.Scope> =>
  Effect.gen(function* () {
    const runner = yield* makeGitCommandRunner({ environment: options.environment });
    const reviewRuntime = new GitReviewRuntime({ commandRunner: runner });
    const registry = yield* makeGitRepositoryRegistry(runner, reviewRuntime);
    const publish = options.publish ?? (() => undefined);
    let module!: GitWorkerModuleState;
    const liveQueries = yield* makeGitLiveQueryRegistry({
      registry,
      publish,
      execute: (input) =>
        module.execute({
          id: input.id,
          method: input.method,
          params: input.params,
          enqueuedAtMs: Date.now(),
        } as GitWorkerRequest["request"]),
    });
    module = new GitWorkerModuleState({ liveQueries, publish, registry, reviewRuntime });
    return module;
  });
