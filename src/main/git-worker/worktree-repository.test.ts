import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { describe, expect, vi } from "vite-plus/test";
import type {
  FileWatchError,
  FileWatchEvent,
  FileWatchHost,
  FileWatchInput,
} from "../file-watch-host";
import type { GitCommandResult, GitCommandRunner } from "./git-command-runner";
import { makeWorktreeRepository } from "./worktree-repository";

const identity = {
  hostId: "local" as const,
  root: "/repo/worktree",
  gitDir: "/repo/worktree/.git",
  commonDir: "/repo/common",
};

const commandResult = (stdout: string): GitCommandResult => ({
  success: true,
  code: 0,
  signal: null,
  stdout,
  stderr: "",
  stdoutBytes: Buffer.byteLength(stdout),
  stderrBytes: 0,
  failureReason: null,
  aborted: false,
  timedOut: false,
  outputLimitExceeded: false,
});

const unusedRunner: GitCommandRunner = { run: vi.fn() };

class CountingWatchHost implements FileWatchHost {
  starts = 0;
  disposals = 0;

  readonly watch = (input: FileWatchInput): Stream.Stream<FileWatchEvent, FileWatchError> =>
    Stream.callback<FileWatchEvent, FileWatchError>((events) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          this.starts += 1;
          Queue.offerUnsafe(events, {
            _tag: "Ready",
            coverage: { recursive: input.recursive, typedPathChanges: false },
            path: input.path,
          });
        }),
        () => Effect.sync(() => void (this.disposals += 1)),
      ),
    );
}

describe("WorktreeRepository", () => {
  it.effect("shares one keyed read while consumers retain independent interruption", () =>
    Effect.gen(function* () {
      const repository = yield* makeWorktreeRepository(identity, unusedRunner);
      const completed = yield* Deferred.make<string>();
      let runs = 0;
      const read = () =>
        repository.query({
          key: ["status"],
          run: Effect.sync(() => void (runs += 1)).pipe(Effect.andThen(Deferred.await(completed))),
        });
      const first = yield* Effect.forkChild(read());
      const second = yield* Effect.forkChild(read());
      yield* Effect.yieldNow;
      expect(runs).toBe(1);

      yield* Fiber.interrupt(first);
      yield* Deferred.succeed(completed, "done");
      expect(yield* Fiber.join(second)).toBe("done");
      expect(runs).toBe(1);
    }),
  );

  it.effect("retires generation-bound cache entries", () =>
    Effect.gen(function* () {
      const repository = yield* makeWorktreeRepository(identity, unusedRunner);
      let runs = 0;
      const read = () =>
        repository.query({
          key: ["review-summary", 1],
          meta: { gitReadDomains: ["working-tree"] },
          run: Effect.sync(() => ++runs),
        });
      expect(yield* read()).toBe(1);

      expect(yield* repository.advanceGeneration()).toBe(2);
      expect(yield* read()).toBe(2);
    }),
  );

  it.effect("discovers attribute filters once and neutralizes every execution hook", () => {
    const runner: GitCommandRunner = {
      run: vi.fn(async () =>
        commandResult(
          ["filter.lfs.process", "filter.lfs.required", "filter.custom.clean", ""].join("\n"),
        ),
      ),
    };
    return Effect.gen(function* () {
      const repository = yield* makeWorktreeRepository(identity, runner);
      const [first, second] = yield* Effect.all(
        [
          repository.readSafeAttributeFilterOverrides,
          repository.readSafeAttributeFilterOverrides,
        ] as const,
        { concurrency: "unbounded" },
      );
      expect(runner.run).toHaveBeenCalledTimes(1);
      expect(first).toEqual(second);
      expect(first).toEqual([
        "attr.tree=",
        "core.attributesFile=",
        "filter.lfs.clean=",
        "filter.lfs.smudge=",
        "filter.lfs.process=",
        "filter.lfs.required=false",
        "filter.custom.clean=",
        "filter.custom.smudge=",
        "filter.custom.process=",
        "filter.custom.required=false",
      ]);
    });
  });

  it.effect("shares a lazy watcher and releases it after the final Stream consumer", () =>
    Effect.gen(function* () {
      const host = new CountingWatchHost();
      const repository = yield* makeWorktreeRepository(identity, unusedRunner, { watchHost: host });
      const first = yield* Effect.forkChild(Stream.runDrain(repository.watchEvents));
      while (host.starts === 0) yield* Effect.yieldNow;
      const started = host.starts;
      expect(started).toBeGreaterThan(0);
      const second = yield* Effect.forkChild(Stream.runDrain(repository.watchEvents));
      yield* Effect.yieldNow;
      expect(host.starts).toBe(started);

      yield* Fiber.interrupt(first);
      yield* Effect.yieldNow;
      expect(host.disposals).toBe(0);
      yield* Fiber.interrupt(second);
      yield* Effect.yieldNow;
      expect(host.disposals).toBe(started);
    }),
  );

  it.effect("refreshes retained reads when observation resumes after an unobserved change", () =>
    Effect.gen(function* () {
      const host = new CountingWatchHost();
      const repository = yield* makeWorktreeRepository(identity, unusedRunner, { watchHost: host });
      let currentBranch = "main";
      let reads = 0;
      const read = () =>
        repository.query({
          key: ["current-branch"],
          meta: { gitReadDomains: ["head"] },
          run: Effect.sync(() => {
            reads += 1;
            return currentBranch;
          }),
        });
      const observe = (ready: Deferred.Deferred<string>) =>
        Stream.runForEach(repository.watchEvents, (event) =>
          event._tag === "RecoveryChanged"
            ? read().pipe(Effect.flatMap((branch) => Deferred.succeed(ready, branch)))
            : Effect.void,
        );
      expect(yield* read()).toBe("main");
      const firstReady = yield* Deferred.make<string>();
      const first = yield* Effect.forkChild(observe(firstReady));
      expect(yield* Deferred.await(firstReady)).toBe("main");
      const observedReads = reads;
      const concurrentReady = yield* Deferred.make<string>();
      const concurrent = yield* Effect.forkChild(observe(concurrentReady));
      expect(yield* Deferred.await(concurrentReady)).toBe("main");
      expect(reads).toBe(observedReads);
      yield* Fiber.interrupt(first);
      yield* Fiber.interrupt(concurrent);
      const oldGeneration = repository.generation;

      currentBranch = "task-work";
      const resumedReady = yield* Deferred.make<string>();
      const resumed = yield* Effect.forkChild(observe(resumedReady));
      expect(yield* Deferred.await(resumedReady)).toBe("task-work");
      expect(repository.generation).toBeGreaterThan(oldGeneration);
      expect(reads).toBe(observedReads + 1);
      yield* Fiber.interrupt(resumed);
    }),
  );
});
