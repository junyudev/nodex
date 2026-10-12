import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { afterEach, describe, expect } from "vite-plus/test";
import * as GitCommandPlatformNode from "../platform/node/GitCommandPlatformNode";
import {
  makeGitCommandRunner,
  type GitCommandOptions,
  type GitCommandResult,
  type GitCommandRunner,
  type GitRepositoryExecutionIdentity,
} from "./git-command-runner";
import { GitReviewRuntime } from "./git-review-operations";
import { makeGitRepositoryRegistry } from "./repository-registry";
import { GIT_UNTRACKED_MATERIALIZED_PATH_LIMIT } from "./untracked-cache";

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
    return makeGitCommandRunner({ environment: process.env }).pipe(
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
    return makeGitCommandRunner({ environment: process.env }).pipe(
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
    makeGitCommandRunner({ environment: process.env }).pipe(
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
