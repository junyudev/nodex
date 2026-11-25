import { describe, expect, vi, afterEach, test } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import type {
  FileWatchError,
  FileWatchEvent,
  FileWatchHost,
  FileWatchInput,
} from "../file-watch-host";
import {
  type GitCommandResult,
  type GitCommandRunner,
  makeGitCommandRunner,
  type GitCommandOptions,
  type GitRepositoryExecutionIdentity,
} from "./git-command-runner";
import { makeWorktreeRepository } from "./worktree-repository";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import * as GitCommandPlatformNode from "../platform/node/GitCommandPlatformNode";
import { GitReviewRuntime } from "./git-review-operations";
import { makeGitRepositoryRegistry } from "./repository-registry";
import { GIT_UNTRACKED_MATERIALIZED_PATH_LIMIT } from "./untracked-cache";

describe("worktree-repository", () => {
  describe("worktree-repository", () => {
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
              run: Effect.sync(() => void (runs += 1)).pipe(
                Effect.andThen(Deferred.await(completed)),
              ),
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
          const repository = yield* makeWorktreeRepository(identity, unusedRunner, {
            watchHost: host,
          });
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

      it.effect(
        "refreshes retained reads when observation resumes after an unobserved change",
        () =>
          Effect.gen(function* () {
            const host = new CountingWatchHost();
            const repository = yield* makeWorktreeRepository(identity, unusedRunner, {
              watchHost: host,
            });
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
  });

  describe("repository-registry", () => {
    const execFileAsync = promisify(execFile);
    const temporaryDirectories: string[] = [];

    afterEach(async () => {
      await Promise.all(
        temporaryDirectories.splice(0).map(async (directory) => {
          await rm(directory, { force: true, recursive: true });
        }),
      );
    });

    const makeRegistry = makeGitCommandRunner({
      platform: process.platform,
      environment: process.env,
    }).pipe(
      Effect.flatMap((runner) =>
        makeGitRepositoryRegistry(runner, new GitReviewRuntime({ commandRunner: runner })),
      ),
      // this is the test application composition root.
      Effect.provide(GitCommandPlatformNode.nodeLive),
    );

    describe("GitRepositoryRegistry", () => {
      it.effect("canonicalizes cwd aliases to one worktree owner", () =>
        makeRegistry.pipe(
          Effect.flatMap((registry) =>
            Effect.gen(function* () {
              const root = yield* Effect.promise(() =>
                mkdtemp(path.join(tmpdir(), "nodex-git-registry-")),
              );
              temporaryDirectories.push(root);
              const nested = path.join(root, "nested", "directory");
              yield* Effect.promise(() => mkdir(nested, { recursive: true }));
              yield* Effect.promise(() => execFileAsync("git", ["init", "-q", root]));

              const fromRoot = yield* registry.get(root);
              const fromNested = yield* registry.get(nested);

              expect(fromRoot).not.toBeNull();
              expect(fromNested).toBe(fromRoot);
              expect(fromRoot?.identity.root).toBe(yield* Effect.promise(() => realpath(root)));
            }),
          ),
        ),
      );

      it.effect("returns null for an ordinary directory", () =>
        makeRegistry.pipe(
          Effect.flatMap((registry) =>
            Effect.gen(function* () {
              const root = yield* Effect.promise(() =>
                mkdtemp(path.join(tmpdir(), "nodex-not-git-")),
              );
              temporaryDirectories.push(root);

              expect(yield* registry.get(root)).toBeNull();
            }),
          ),
        ),
      );
    });
  });

  describe("git-review-runtime", () => {
    const unusedRunner: GitCommandRunner = {
      run: async () => {
        throw new Error("Unexpected Git command");
      },
    };

    describe("GitReviewRuntime", () => {
      test("isolates repository generations between runtime instances", () => {
        const identity = {
          hostId: "local",
          commonDir: "/tmp/nodex-git-review-runtime/.git",
          root: "/tmp/nodex-git-review-runtime",
        };
        const first = new GitReviewRuntime({ commandRunner: unusedRunner });
        first.registerRepositoryIdentity(identity.root, identity);

        expect(first.readSnapshotGeneration(identity)).toBe(1);
        first.invalidateSnapshot(identity.root);
        expect(first.readSnapshotGeneration(identity)).toBe(2);

        const second = new GitReviewRuntime({ commandRunner: unusedRunner });
        second.registerRepositoryIdentity(identity.root, identity);
        expect(second.readSnapshotGeneration(identity)).toBe(1);
      });
    });
  });
});

describe("untracked-cache", () => {
  const execFileAsync = promisify(execFile);
  const temporaryDirectories: string[] = [];

  class RecordingRunner implements GitCommandRunner {
    readonly commands: string[][] = [];
    readonly results: Array<{ args: string[]; result: GitCommandResult }> = [];
    readonly #delegate: GitCommandRunner;

    constructor(delegate: GitCommandRunner) {
      this.#delegate = delegate;
    }

    async run(
      repository: GitRepositoryExecutionIdentity,
      args: readonly string[],
      options?: GitCommandOptions,
    ): Promise<GitCommandResult> {
      const recordedArgs = [...args];
      this.commands.push(recordedArgs);
      const result = await this.#delegate.run(repository, args, options);
      this.results.push({ args: recordedArgs, result });
      return result;
    }
  }

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map(async (directory) => {
        await rm(directory, { force: true, recursive: true });
      }),
    );
  });

  async function createRepository(): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), "nodex-untracked-cache-"));
    temporaryDirectories.push(root);
    await execFileAsync("git", ["init", "-q", root]);
    await writeFile(path.join(root, ".gitignore"), "ignored.txt\n", "utf8");
    await execFileAsync("git", ["-C", root, "add", ".gitignore"]);
    return root;
  }

  const registryFor = (runner: GitCommandRunner) =>
    makeGitRepositoryRegistry(runner, new GitReviewRuntime({ commandRunner: runner }));

  describe("UntrackedPathCache", () => {
    it.effect("expands normal-mode directories and excludes ignored files", () => {
      return makeGitCommandRunner({ platform: process.platform, environment: process.env }).pipe(
        Effect.flatMap((delegate) => {
          const runner = new RecordingRunner(delegate);
          return registryFor(runner).pipe(
            Effect.flatMap((registry) =>
              Effect.gen(function* () {
                const root = yield* Effect.promise(async () => {
                  const created = await createRepository();
                  await mkdir(path.join(created, "nested"));
                  await writeFile(path.join(created, "nested", "first.txt"), "first\n", "utf8");
                  await writeFile(path.join(created, "nested", "second.txt"), "second\n", "utf8");
                  await writeFile(path.join(created, "ignored.txt"), "ignored\n", "utf8");
                  return created;
                });
                const repository = yield* registry.get(root);
                if (!repository) throw new Error("Expected Git repository");

                const result = yield* repository.untrackedPaths.read();

                expect(result).toEqual({
                  success: true,
                  paths: ["nested/first.txt", "nested/second.txt"],
                  omittedCount: 0,
                });
                const unscopedStatus = runner.commands.filter(
                  (args) => args[0] === "status" && !args.includes("--"),
                );
                expect(unscopedStatus).toHaveLength(1);
                expect(unscopedStatus[0]).toContain("--untracked-files=normal");
                expect(unscopedStatus[0]).not.toContain("--untracked-files=all");
              }),
            ),
          );
        }),
        // this is the test application composition root.
        Effect.provide(GitCommandPlatformNode.nodeLive),
      );
    });

    it.effect("uses all mode only for a bounded path-scoped repair", () => {
      return makeGitCommandRunner({ platform: process.platform, environment: process.env }).pipe(
        Effect.flatMap((delegate) => {
          const runner = new RecordingRunner(delegate);
          return registryFor(runner).pipe(
            Effect.flatMap((registry) =>
              Effect.gen(function* () {
                const root = yield* Effect.promise(async () => {
                  const created = await createRepository();
                  await writeFile(path.join(created, "first.txt"), "first\n", "utf8");
                  return created;
                });
                const repository = yield* registry.get(root);
                if (!repository) throw new Error("Expected Git repository");
                yield* repository.untrackedPaths.read();
                const secondPath = path.join(repository.identity.root, "second.txt");
                yield* Effect.promise(() => writeFile(secondPath, "second\n", "utf8"));

                const invalidation = yield* repository.untrackedPaths.invalidatePaths([secondPath]);
                const scopedStatus = runner.results.find(
                  ({ args }) => args[0] === "status" && args.includes("--untracked-files=all"),
                );
                expect(scopedStatus?.result).toMatchObject({ success: true, code: 0 });
                expect(invalidation).toBe("filtered");
                const result = yield* repository.untrackedPaths.read();

                expect(result.paths).toEqual(["first.txt", "second.txt"]);
                const allStatus = runner.commands.filter(
                  (args) => args[0] === "status" && args.includes("--untracked-files=all"),
                );
                expect(allStatus).toHaveLength(1);
                expect(allStatus[0]).toContain("--");
              }),
            ),
          );
        }),
        // this is the test application composition root.
        Effect.provide(GitCommandPlatformNode.nodeLive),
      );
    });

    it.effect("caps materialized files while preserving the omitted count", () =>
      makeGitCommandRunner({ platform: process.platform, environment: process.env }).pipe(
        Effect.flatMap((runner) =>
          registryFor(runner).pipe(
            Effect.flatMap((registry) =>
              Effect.gen(function* () {
                const root = yield* Effect.promise(async () => {
                  const created = await createRepository();
                  await mkdir(path.join(created, "large"));
                  await Promise.all(
                    Array.from({ length: 260 }, async (_, index) => {
                      await writeFile(
                        path.join(created, "large", `${String(index).padStart(3, "0")}.txt`),
                        `${String(index)}\n`,
                        "utf8",
                      );
                    }),
                  );
                  return created;
                });
                const repository = yield* registry.get(root);
                if (!repository) throw new Error("Expected Git repository");

                const result = yield* repository.untrackedPaths.read();

                expect(result.success).toBe(true);
                expect(result.paths).toHaveLength(GIT_UNTRACKED_MATERIALIZED_PATH_LIMIT);
                expect(result.omittedCount).toBe(4);
              }),
            ),
          ),
        ),
        // this is the test application composition root.
        Effect.provide(GitCommandPlatformNode.nodeLive),
      ),
    );
  });
});
