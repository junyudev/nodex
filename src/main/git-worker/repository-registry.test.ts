import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { afterEach, describe, expect } from "vite-plus/test";
import * as GitCommandPlatformNode from "../platform/node/GitCommandPlatformNode";
import { makeGitCommandRunner } from "./git-command-runner";
import { GitReviewRuntime } from "./git-review-operations";
import { makeGitRepositoryRegistry } from "./repository-registry";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

const makeRegistry = makeGitCommandRunner({ environment: process.env }).pipe(
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
          const root = yield* Effect.promise(() => mkdtemp(path.join(tmpdir(), "nodex-not-git-")));
          temporaryDirectories.push(root);

          expect(yield* registry.get(root)).toBeNull();
        }),
      ),
    ),
  );
});
