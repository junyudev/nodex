import { AsyncLocalStorage } from "node:async_hooks";
import { devNull } from "node:os";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberSet from "effect/FiberSet";
import * as RcMap from "effect/RcMap";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import type {
  GitPerformanceOperationMetric,
  GitPerformanceOperationOutcome,
  GitPerformanceOperationTrigger,
} from "../../shared/git-worker-protocol";
import { GitCommandPlatform, type GitCommandStdoutStream } from "./git-command-platform";
import { mergeProcessEnvironments } from "../platform/node/child-process-environment";

export const GIT_READ_TIMEOUT_MS = 60_000;
export const GIT_CAT_FILE_TIMEOUT_MS = 30_000;
export const GIT_DEFAULT_OUTPUT_BYTES_CAP = 32 * 1024 * 1024;

export interface GitRepositoryExecutionIdentity {
  hostId: "local";
  root: string;
  commonDir: string;
}

export type GitCommandFailureReason =
  | "canceled"
  | "timed_out"
  | "nonzero_exit"
  | "output_limit"
  | "spawn_failed"
  | "wait_failed";

export interface GitCommandResult {
  success: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  failureReason: GitCommandFailureReason | null;
  aborted: boolean;
  timedOut: boolean;
  outputLimitExceeded: boolean;
}

export interface GitCommandOptions {
  allowedNonZeroExitCodes?: readonly number[];
  configOverrides?: readonly string[];
  env?: NodeJS.ProcessEnv;
  literalPathspecs?: boolean;
  outputBytesCap?: number;
  serialize?: boolean;
  signal?: AbortSignal;
  stdin?: string | Uint8Array;
  stdoutStream?: GitCommandStdoutStream;
  timeoutMs?: number | null;
}

export interface GitCommandRunner {
  run(
    repository: GitRepositoryExecutionIdentity,
    args: readonly string[],
    options?: GitCommandOptions,
  ): Promise<GitCommandResult>;
}

interface GitPerformanceOperationRuntime {
  cacheHits: number;
  cacheMisses: number;
  canceled: boolean;
  coalescedQueries: number;
  commandCount: number;
  fullUntrackedScanCount: number;
  unscopedAllStatusCount: number;
  outputLimitExceeded: boolean;
  peakConcurrency: number;
  queueDurationMs: number;
  statusCommandCount: number;
  timedOut: boolean;
}

const gitPerformanceOperationContext = new AsyncLocalStorage<GitPerformanceOperationRuntime>();
const CurrentGitPerformanceOperation = Context.Reference<GitPerformanceOperationRuntime | null>(
  "nodex/main/git-worker/CurrentGitPerformanceOperation",
  { defaultValue: () => null },
);

export const recordGitQueryCacheOutcomeEffect = (
  outcome: "hit" | "miss" | "coalesced",
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const runtime = yield* CurrentGitPerformanceOperation;
    if (!runtime) return;
    if (outcome === "hit") runtime.cacheHits += 1;
    if (outcome === "miss") runtime.cacheMisses += 1;
    if (outcome === "coalesced") runtime.coalescedQueries += 1;
  });

export const gitPerformancePromise = <Result>(
  run: (signal: AbortSignal) => Promise<Result>,
): Effect.Effect<Result> =>
  Effect.gen(function* () {
    const runtime = yield* CurrentGitPerformanceOperation;
    return yield* Effect.promise((signal) =>
      runtime ? gitPerformanceOperationContext.run(runtime, () => run(signal)) : run(signal),
    );
  });

export const runGitPerformanceOperationEffect = <Result, Error, Requirements>(input: {
  operation: string;
  trigger: GitPerformanceOperationTrigger;
  classifyOutcome(result: Result): GitPerformanceOperationOutcome;
  publish(metric: GitPerformanceOperationMetric): void;
  run: Effect.Effect<Result, Error, Requirements>;
}): Effect.Effect<Result, Error, Requirements> =>
  Effect.gen(function* () {
    const startedAt = performance.now();
    const runtime: GitPerformanceOperationRuntime = {
      cacheHits: 0,
      cacheMisses: 0,
      canceled: false,
      coalescedQueries: 0,
      commandCount: 0,
      fullUntrackedScanCount: 0,
      unscopedAllStatusCount: 0,
      outputLimitExceeded: false,
      peakConcurrency: 0,
      queueDurationMs: 0,
      statusCommandCount: 0,
      timedOut: false,
    };
    let outcome: GitPerformanceOperationOutcome = "infrastructure-error";
    const exit = yield* Effect.exit(
      input.run.pipe(
        Effect.tap((result) => Effect.sync(() => void (outcome = input.classifyOutcome(result)))),
        Effect.provideService(CurrentGitPerformanceOperation, runtime),
      ),
    );
    if (
      Exit.isFailure(exit) &&
      exit.cause.reasons.length > 0 &&
      exit.cause.reasons.every(Cause.isInterruptReason)
    ) {
      outcome = "canceled";
      runtime.canceled = true;
    }
    const durationMs = Math.max(0, performance.now() - startedAt);
    input.publish({
      operation: input.operation,
      trigger: input.trigger,
      outcome,
      durationMs,
      firstResultMs: durationMs,
      queueDurationMs: runtime.queueDurationMs,
      commandCount: runtime.commandCount,
      peakConcurrency: runtime.peakConcurrency,
      statusCommandCount: runtime.statusCommandCount,
      fullUntrackedScanCount: runtime.fullUntrackedScanCount,
      unscopedAllStatusCount: runtime.unscopedAllStatusCount,
      cacheHits: runtime.cacheHits,
      cacheMisses: runtime.cacheMisses,
      coalescedQueries: runtime.coalescedQueries,
      timedOut: runtime.timedOut,
      canceled: runtime.canceled,
      outputLimitExceeded: runtime.outputLimitExceeded,
      repoIndexSizeBucket: "unknown",
    });
    if (Exit.isSuccess(exit)) return exit.value;
    return yield* Effect.failCause(exit.cause);
  });

const GIT_CONFIG_OVERRIDES = [
  "-c",
  "diff.mnemonicPrefix=false",
  "-c",
  "diff.noprefix=false",
  "-c",
  "core.quotePath=false",
  "-c",
  `core.hooksPath=${devNull}`,
] as const;

interface SafeFsmonitorCacheEntry {
  expiresAt: number;
  value: "" | "true";
}

function createEmptyFailure(
  failureReason: GitCommandFailureReason,
  options: {
    aborted?: boolean;
    timedOut?: boolean;
    outputLimitExceeded?: boolean;
  } = {},
): GitCommandResult {
  return {
    success: false,
    code: null,
    signal: null,
    stdout: "",
    stderr: "",
    stdoutBytes: 0,
    stderrBytes: 0,
    failureReason,
    aborted: options.aborted ?? false,
    timedOut: options.timedOut ?? false,
    outputLimitExceeded: options.outputLimitExceeded ?? false,
  };
}

class GitCommandRunnerState implements GitCommandRunner {
  readonly #environment: NodeJS.ProcessEnv;
  readonly #hostPlatform: string;
  readonly #lanes: RcMap.RcMap<string, Semaphore.Semaphore>;
  readonly #platform: GitCommandPlatform["Service"];
  readonly #runPromise: (
    effect: Effect.Effect<GitCommandResult>,
    options?: Effect.RunOptions,
  ) => Promise<GitCommandResult>;
  readonly #safeFsmonitorCache = new Map<string, SafeFsmonitorCacheEntry>();
  readonly #activeByCommonDir = new Map<string, number>();

  constructor(options: {
    environment: NodeJS.ProcessEnv;
    hostPlatform: string;
    lanes: RcMap.RcMap<string, Semaphore.Semaphore>;
    platform: GitCommandPlatform["Service"];
    runPromise: (
      effect: Effect.Effect<GitCommandResult>,
      options?: Effect.RunOptions,
    ) => Promise<GitCommandResult>;
  }) {
    this.#environment = options.environment;
    this.#hostPlatform = options.hostPlatform;
    this.#lanes = options.lanes;
    this.#platform = options.platform;
    this.#runPromise = options.runPromise;
  }

  async run(
    repository: GitRepositoryExecutionIdentity,
    args: readonly string[],
    options: GitCommandOptions = {},
  ): Promise<GitCommandResult> {
    if (repository.hostId !== "local") {
      throw new Error(`Unsupported Git host: ${repository.hostId}`);
    }
    if (args.length === 0 || args.some((arg) => typeof arg !== "string")) {
      throw new Error("Git command requires a non-empty argument list");
    }
    if (args[0]?.startsWith("-")) {
      throw new Error("Git command arguments must begin with a subcommand");
    }
    if (options.signal?.aborted) {
      return createEmptyFailure("canceled", { aborted: true });
    }
    const outputBytesCap = options.outputBytesCap ?? GIT_DEFAULT_OUTPUT_BYTES_CAP;
    const timeoutMs =
      options.timeoutMs === undefined
        ? isGitReadCommand(args)
          ? GIT_READ_TIMEOUT_MS
          : null
        : options.timeoutMs;
    if (!Number.isSafeInteger(outputBytesCap) || outputBytesCap <= 0) {
      throw new Error("Git command output cap must be a positive safe integer");
    }
    if (timeoutMs !== null && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)) {
      throw new Error("Git command timeout must be a positive safe integer");
    }
    if (
      options.stdoutStream !== undefined &&
      options.stdoutStream.maxBytes !== null &&
      (!Number.isSafeInteger(options.stdoutStream.maxBytes) || options.stdoutStream.maxBytes <= 0)
    ) {
      throw new Error("Git command stdout stream cap must be null or a positive safe integer");
    }
    const callerConfigOverrides = options.configOverrides ?? [];
    if (callerConfigOverrides.some((entry) => entry.includes("\0"))) {
      throw new Error("Git config overrides cannot contain NUL bytes");
    }
    const enqueuedAt = performance.now();
    const activeByCommonDir = this.#activeByCommonDir;
    const executeCommand = this.#execute.bind(this);
    const lanes = this.#lanes;
    const execute = Effect.gen(function* () {
      const runtime = gitPerformanceOperationContext.getStore();
      const active = (activeByCommonDir.get(repository.commonDir) ?? 0) + 1;
      activeByCommonDir.set(repository.commonDir, active);
      if (runtime) {
        runtime.queueDurationMs += Math.max(0, performance.now() - enqueuedAt);
        runtime.peakConcurrency = Math.max(runtime.peakConcurrency, active);
      }
      try {
        const result = yield* executeCommand(repository, args, {
          ...options,
          outputBytesCap,
          timeoutMs,
        });
        if (runtime) {
          runtime.commandCount += 1;
          runtime.statusCommandCount += args[0] === "status" ? 1 : 0;
          runtime.fullUntrackedScanCount +=
            args[0] === "status" && args.includes("--untracked-files=normal") ? 1 : 0;
          runtime.unscopedAllStatusCount +=
            args[0] === "status" && args.includes("--untracked-files=all") && !args.includes("--")
              ? 1
              : 0;
          runtime.timedOut ||= result.timedOut;
          runtime.canceled ||= result.aborted;
          runtime.outputLimitExceeded ||= result.outputLimitExceeded;
        }
        return result;
      } finally {
        if (active === 1) activeByCommonDir.delete(repository.commonDir);
        else activeByCommonDir.set(repository.commonDir, active - 1);
      }
    });
    const operation =
      options.serialize === false
        ? execute
        : Effect.scoped(
            Effect.gen(function* () {
              const lane = yield* RcMap.get(lanes, repository.commonDir);
              return yield* lane.withPermit(execute);
            }),
          );
    try {
      return await this.#runPromise(
        operation,
        options.signal ? { signal: options.signal } : undefined,
      );
    } catch (error) {
      if (options.signal?.aborted) return createEmptyFailure("canceled", { aborted: true });
      throw error;
    }
  }

  #execute(
    repository: GitRepositoryExecutionIdentity,
    args: readonly string[],
    options: GitCommandOptions & { outputBytesCap: number; timeoutMs: number | null },
    skipFsmonitorResolution = false,
  ): Effect.Effect<GitCommandResult> {
    const allowedExitCodes = new Set([0, ...(options.allowedNonZeroExitCodes ?? [])]);
    const callerConfigOverrides = options.configOverrides ?? [];
    const configArgs = callerConfigOverrides.flatMap((entry) => ["-c", entry]);
    const environment = this.#environment;
    const hostPlatform = this.#hostPlatform;
    const platform = this.#platform;
    const resolveSafeFsmonitorOverride = this.#resolveSafeFsmonitorOverride.bind(this);
    return Effect.gen(function* () {
      const fsmonitorOverride = skipFsmonitorResolution
        ? null
        : yield* resolveSafeFsmonitorOverride(repository, options);
      const result = yield* platform.run({
        args: [
          ...GIT_CONFIG_OVERRIDES,
          ...configArgs,
          ...(fsmonitorOverride === null ? [] : ["-c", `core.fsmonitor=${fsmonitorOverride}`]),
          ...(options.literalPathspecs ? ["--literal-pathspecs"] : []),
          ...args,
        ],
        cwd: repository.root,
        environment: mergeProcessEnvironments(hostPlatform, environment, options.env ?? {}, {
          GIT_OPTIONAL_LOCKS: "0",
          GIT_TERMINAL_PROMPT: "0",
          LANGUAGE: "C",
          LC_MESSAGES: "C",
        }),
        outputBytesCap: options.outputBytesCap,
        stdin: options.stdin,
        stdoutStream: options.stdoutStream,
        timeoutMs: options.timeoutMs,
      });
      const failureReason: GitCommandFailureReason | null =
        result.failureReason ??
        (result.code !== null && allowedExitCodes.has(result.code) ? null : "nonzero_exit");
      return {
        ...result,
        success: failureReason === null,
        failureReason,
        aborted: false,
        timedOut: failureReason === "timed_out",
        outputLimitExceeded: failureReason === "output_limit",
      };
    });
  }

  #resolveSafeFsmonitorOverride(
    repository: GitRepositoryExecutionIdentity,
    options: GitCommandOptions & { outputBytesCap: number; timeoutMs: number | null },
  ): Effect.Effect<"" | "true"> {
    if (process.platform !== "darwin" && process.platform !== "win32") {
      return Effect.succeed("");
    }
    const cacheKey = JSON.stringify([
      repository.commonDir,
      Object.entries(options.env ?? {}).sort(([left], [right]) => left.localeCompare(right)),
    ]);
    const cache = this.#safeFsmonitorCache;
    const readSafeFsmonitorOverride = this.#readSafeFsmonitorOverride.bind(this);
    return Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const cached = cache.get(cacheKey);
      if (cached && cached.expiresAt > now) return cached.value;
      if (cached) cache.delete(cacheKey);
      const deadline = now + 1_000;
      const value = yield* readSafeFsmonitorOverride(repository, options);
      const completedAt = yield* Clock.currentTimeMillis;
      if (completedAt < deadline) {
        cache.set(cacheKey, { expiresAt: deadline, value });
      }
      return value;
    });
  }

  #readSafeFsmonitorOverride(
    repository: GitRepositoryExecutionIdentity,
    options: GitCommandOptions & { outputBytesCap: number; timeoutMs: number | null },
  ): Effect.Effect<"" | "true"> {
    const executeCommand = this.#execute.bind(this);
    return Effect.gen(function* () {
      const config = yield* executeCommand(
        repository,
        ["config", "--null", "--get", "core.fsmonitor"],
        {
          allowedNonZeroExitCodes: [1],
          env: options.env,
          outputBytesCap: options.outputBytesCap,
          timeoutMs: options.timeoutMs ?? GIT_READ_TIMEOUT_MS,
        },
        true,
      );
      if (config.code !== 0 || !config.stdout.endsWith("\0")) return "";
      const configuredValue = config.stdout.slice(0, -1);
      if (!configuredValue || configuredValue.includes("\0")) return "";
      const normalized = configuredValue.toLowerCase();
      let enabled = ["true", "yes", "on"].includes(normalized);
      if (!["true", "yes", "on", "false", "no", "off"].includes(normalized)) {
        const parsed = yield* executeCommand(
          repository,
          [
            "config",
            "--null",
            "--type=bool",
            "--fixed-value",
            "--get",
            "core.fsmonitor",
            configuredValue,
          ],
          {
            allowedNonZeroExitCodes: [1],
            env: options.env,
            outputBytesCap: options.outputBytesCap,
            timeoutMs: options.timeoutMs ?? GIT_READ_TIMEOUT_MS,
          },
          true,
        );
        enabled = parsed.code === 0 && parsed.stdout === "true\0";
      }
      if (!enabled) return "";
      const buildOptions = yield* executeCommand(
        repository,
        ["version", "--build-options"],
        {
          env: options.env,
          outputBytesCap: options.outputBytesCap,
          timeoutMs: options.timeoutMs ?? GIT_READ_TIMEOUT_MS,
        },
        true,
      );
      if (buildOptions.code !== 0) return "";
      return buildOptions.stdout
        .split(/\r?\n/)
        .some((line) => line.trim() === "feature: fsmonitor--daemon")
        ? "true"
        : "";
    });
  }
}

export interface GitCommandRunnerOptions {
  readonly platform: string;
  readonly environment: NodeJS.ProcessEnv;
}

/** Owns all one-shot Git command fibers and per-repository FIFO lanes in the worker Scope. */
export const makeGitCommandRunner = (
  options: GitCommandRunnerOptions,
): Effect.Effect<GitCommandRunner, never, GitCommandPlatform | Scope.Scope> =>
  Effect.gen(function* () {
    const platform = yield* GitCommandPlatform;
    const lanes = yield* RcMap.make({
      lookup: (_commonDir: string) => Semaphore.make(1),
      idleTimeToLive: Duration.zero,
    });
    const runPromise = yield* FiberSet.makeRuntimePromise<never, GitCommandResult, never>();
    return new GitCommandRunnerState({
      environment: { ...options.environment },
      hostPlatform: options.platform,
      lanes,
      platform,
      runPromise,
    });
  });

export function isGitReadCommand(args: readonly string[]): boolean {
  switch (args[0]) {
    case "check-ignore":
    case "for-each-ref":
    case "merge-base":
    case "rev-list":
    case "rev-parse":
    case "show-ref":
    case "status":
      return true;
    case "cat-file":
      return args.includes("-e");
    case "ls-files":
      return args.includes("--others") && !args.includes("--cached") && !args.includes("--ignored");
    case "config":
      return args.some(
        (arg) =>
          arg === "--get" || arg === "--get-all" || arg === "--get-regexp" || arg === "--list",
      );
    case "worktree":
      return args[1] === "list";
    default:
      return false;
  }
}
