import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import type { GitWorkerMethodMap } from "../../shared/git-worker-protocol";
import type { GitActionStatusResult } from "../../shared/types";
import { CodexGitMessageGeneration } from "../codex-application/CodexGitMessageGeneration";
import { live as gitActionOperationRuntimeLive } from "../host-runtime/GitActionOperationRuntime";
import { GitWorkerRuntime } from "../host-runtime/GitWorkerRuntime";
import { GitActions, live } from "./GitActions";

const status = (cwd: string): GitActionStatusResult => ({
  cwd,
  isGitRepository: true,
  currentBranch: "main",
  defaultBranch: "main",
  upstreamBranch: null,
  remotes: [],
  hasHeadCommit: true,
  hasStagedChanges: true,
  hasUnstagedChanges: false,
  hasUntrackedFiles: false,
  hasUncommittedChanges: true,
  commitsAhead: 0,
  canCommit: true,
  canPush: true,
  pushNeedsUpstream: false,
  errorMessage: null,
});

const withTemporaryDirectory = <A, E, R>(
  use: (directory: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(path.join(tmpdir(), "nodex-git-actions-"))),
    use,
    (directory) => Effect.promise(() => rm(directory, { force: true, recursive: true })),
  );

const layer = (worker: GitWorkerRuntime["Service"]) =>
  live.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(
          CodexGitMessageGeneration,
          CodexGitMessageGeneration.of({
            generateCommitMessage: () => Effect.succeed(null),
            generatePullRequestMessage: () => Effect.succeed({ title: null, body: null }),
          }),
        ),
        gitActionOperationRuntimeLive,
        Layer.succeed(GitWorkerRuntime, worker),
      ),
    ),
  );

it.effect("commits through the canonical worker capability", () =>
  withTemporaryDirectory((cwd) => {
    const requests: string[] = [];
    const worker = GitWorkerRuntime.of({
      handleRendererMessage: () => Effect.void,
      request: ((input: { readonly method: keyof GitWorkerMethodMap }) => {
        requests.push(input.method);
        if (input.method === "action-status") return Effect.succeed(status(cwd));
        if (input.method === "commit") {
          return Effect.succeed({
            cwd,
            status: "success",
            branch: "main",
            stdout: "committed",
            stderr: "",
            errorMessage: null,
          });
        }
        return Effect.die(`Unexpected Git worker method: ${input.method}`);
      }) as GitWorkerRuntime["Service"]["request"],
    });
    return Effect.gen(function* () {
      const actions = yield* GitActions;
      const result = yield* actions.commit({
        cwd,
        message: "feat: commit through Effect",
        includeUnstaged: true,
      });
      assert.deepStrictEqual(requests, ["action-status", "commit"]);
      assert.strictEqual(result.status, "success");
      assert.strictEqual(result.branch, "main");
      // this test owns the complete GitActions application layer.
    }).pipe(Effect.provide(layer(worker)));
  }),
);

it.effect("cancels an in-flight canonical Git action by operation id", () =>
  withTemporaryDirectory((cwd) =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const worker = GitWorkerRuntime.of({
        handleRendererMessage: () => Effect.void,
        request: ((input: { readonly method: keyof GitWorkerMethodMap }) => {
          if (input.method === "action-status") return Effect.succeed(status(cwd));
          if (input.method === "commit") {
            return Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never));
          }
          return Effect.die(`Unexpected Git worker method: ${input.method}`);
        }) as GitWorkerRuntime["Service"]["request"],
      });
      const program = Effect.gen(function* () {
        const actions = yield* GitActions;
        const pending = yield* Effect.forkChild(
          actions.commit({
            cwd,
            message: "feat: interrupted",
            includeUnstaged: true,
            operationId: "cancel-me",
          }),
        );
        yield* Deferred.await(started);
        assert.deepStrictEqual(yield* actions.cancel({ operationId: "cancel-me" }), {
          canceled: true,
        });
        const result = yield* Fiber.join(pending);
        assert.strictEqual(result.status, "error");
        assert.strictEqual(result.errorMessage, "Git action was canceled.");
      });
      // this test owns the complete GitActions application layer.
      yield* program.pipe(Effect.provide(layer(worker)));
    }),
  ),
);
