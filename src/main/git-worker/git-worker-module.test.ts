import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import { afterEach, describe, expect } from "vite-plus/test";
import type {
  GitWorkerMethod,
  GitWorkerMethodMap,
  GitWorkerRequest,
} from "../../shared/git-worker-protocol";
import * as GitCommandPlatformNode from "../platform/node/GitCommandPlatformNode";
import { makeGitWorkerModule, type GitWorkerModule } from "./git-worker-module";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, {
        force: true,
        maxRetries: 10,
        recursive: true,
        retryDelay: 100,
      }),
    ),
  );
});

function request<Method extends GitWorkerMethod>(
  method: Method,
  params: GitWorkerMethodMap[Method]["params"],
): GitWorkerRequest["request"] {
  return {
    id: `${method}-request`,
    method,
    params,
    enqueuedAtMs: Date.now(),
  } as GitWorkerRequest["request"];
}

const withGitWorkerModule = <A>(
  run: (module: GitWorkerModule) => Effect.Effect<A, never, Scope.Scope>,
) =>
  makeGitWorkerModule({ environment: process.env }).pipe(
    Effect.flatMap(run),
    // oxlint-disable-next-line effecttsgo/strict-effect-provide -- the helper owns a fresh test application Scope.
    Effect.provide(GitCommandPlatformNode.nodeLive),
  );

describe("GitWorkerModule", () => {
  it.effect("reads metadata and tracked-first status from one repository owner", () =>
    withGitWorkerModule((module) =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(async () => {
          const directory = await mkdtemp(path.join(tmpdir(), "nodex-git-module-"));
          temporaryDirectories.push(directory);
          await execFileAsync("git", ["init", "-q", "-b", "main", directory]);
          await execFileAsync("git", ["-C", directory, "config", "user.email", "test@example.com"]);
          await execFileAsync("git", ["-C", directory, "config", "user.name", "Nodex Test"]);
          await writeFile(path.join(directory, "tracked.txt"), "initial\n", "utf8");
          await execFileAsync("git", ["-C", directory, "add", "tracked.txt"]);
          await execFileAsync("git", ["-C", directory, "commit", "-q", "-m", "initial"]);
          await writeFile(path.join(directory, "tracked.txt"), "changed\n", "utf8");
          await writeFile(path.join(directory, "staged.txt"), "staged\n", "utf8");
          await execFileAsync("git", ["-C", directory, "add", "staged.txt"]);
          await writeFile(path.join(directory, "untracked.txt"), "untracked\n", "utf8");
          return directory;
        });

        expect(yield* module.execute(request("stable-metadata", { cwd: root }))).toMatchObject({
          isGitRepository: true,
          currentBranch: "main",
          defaultBranch: "main",
        });
        expect(yield* module.execute(request("status-summary", { cwd: root }))).toEqual({
          type: "success",
          stagedCount: 1,
          unstagedCount: 1,
          untrackedCount: null,
          snapshotGeneration: 1,
        });
        expect(
          yield* module.execute(
            request("status-summary", { cwd: root, includeUntrackedFiles: true }),
          ),
        ).toEqual({
          type: "success",
          stagedCount: 1,
          unstagedCount: 1,
          untrackedCount: 1,
          snapshotGeneration: 1,
        });
      }),
    ),
  );

  it.effect("returns typed non-repository results", () =>
    withGitWorkerModule((module) =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(() =>
          mkdtemp(path.join(tmpdir(), "nodex-git-module-empty-")),
        );
        temporaryDirectories.push(root);
        expect(yield* module.execute(request("stable-metadata", { cwd: root }))).toMatchObject({
          isGitRepository: false,
          errorMessage: null,
        });
        expect(yield* module.execute(request("status-summary", { cwd: root }))).toEqual({
          type: "error",
          failureReason: "not-a-repository",
          errorMessage: null,
        });
      }),
    ),
  );

  it.effect("serializes mutations through the repository owner and advances generation", () =>
    withGitWorkerModule((module) =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(() =>
          mkdtemp(path.join(tmpdir(), "nodex-git-module-mutate-")),
        );
        temporaryDirectories.push(root);
        const initialized = (yield* module.execute(
          request("git-init-repo", { cwd: root }),
        )) as GitWorkerMethodMap["git-init-repo"]["result"];
        expect(initialized.isGitRepository).toBe(true);
        const initialGeneration = initialized.snapshotGeneration;
        yield* Effect.promise(async () => {
          await execFileAsync("git", ["-C", root, "config", "user.email", "test@example.com"]);
          await execFileAsync("git", ["-C", root, "config", "user.name", "Nodex Test"]);
          await writeFile(path.join(root, "note.txt"), "initial\n", "utf8");
        });
        const committed = (yield* module.execute(
          request("commit", {
            cwd: root,
            message: "initial",
            includeUnstaged: true,
            nextStep: "commit",
          }),
        )) as GitWorkerMethodMap["commit"]["result"];
        expect(committed).toMatchObject({ status: "success", branch: "main" });
        const created = (yield* module.execute(
          request("create-branch", { cwd: root, branch: "feature/worker" }),
        )) as GitWorkerMethodMap["create-branch"]["result"];
        expect(created).toMatchObject({
          type: "success",
          value: { currentBranch: "feature/worker", defaultBranch: "main" },
        });
        const refreshed = (yield* module.execute(
          request("refresh-repository", { cwd: root }),
        )) as GitWorkerMethodMap["refresh-repository"]["result"];
        expect(refreshed.type).toBe("success");
        if (refreshed.type === "success") {
          expect(refreshed.generation).toBeGreaterThan(initialGeneration);
        }
      }),
    ),
  );
});
