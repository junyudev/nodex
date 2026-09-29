// @effect-diagnostics strictEffectProvide:off
import { access, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { CodexScheduledAutomation } from "../../shared/types";
import { testLayer as configLayer } from "../app/MainConfig";
import { CodexGitProbe } from "../codex-application/CodexGitProbe";
import { ExecutionHostRuntime } from "../codex-application/ExecutionHostRuntime";
import { ManagedWorktreeRuntime } from "../codex-application/ManagedWorktreeRuntime";
import type { CodexWorktreeWorkerRequest } from "../codex/codex-worktree-worker-protocol";
import type { WorktreeWorkerRequestOptions } from "../host-runtime/WorktreeWorkerRuntime";
import { make, NativeAutomationWorkspaceError } from "./NativeAutomationWorkspace";

const definition = {
  id: "definition",
  projectId: "project",
  backendBinding: { kind: "claude", instanceConfigId: "work" },
  executionEnvironment: "worktree",
  name: "Review source",
  prompt: "Review source",
  localEnvironmentConfigPath: null,
} as CodexScheduledAutomation;

const fixture = (
  options: { homeDirectory?: string; setupError?: string; ownerFailure?: boolean } = {},
) => {
  const events: string[] = [];
  const requests: CodexWorktreeWorkerRequest[] = [];
  const owner = make.pipe(
    Effect.provideService(CodexGitProbe, {
      readPath: (_cwd, args) => Effect.succeed(args[0] === "branch" ? "main" : "../source/.git"),
      isNonGitWorkspace: () => Effect.succeed(false),
      isNonGitWorkspaceOnHost: () => Effect.succeed(false),
    }),
    Effect.provideService(ManagedWorktreeRuntime, {
      registerNewborn: () =>
        Effect.sync(() => {
          events.push("register");
        }),
      releaseNewborn: () =>
        Effect.sync(() => {
          events.push("release");
        }),
      remove: () =>
        Effect.sync(() => {
          events.push("remove");
          return {};
        }),
      setOwner: (input: { ownerThreadId: string }) =>
        Effect.gen(function* () {
          events.push(`owner:${input.ownerThreadId}`);
          if (options.ownerFailure)
            return yield* new NativeAutomationWorkspaceError({
              operation: "owner",
              cause: new Error("metadata failed"),
            });
        }),
    } as never),
    Effect.provideService(ExecutionHostRuntime, {
      resolve: () =>
        Effect.succeed({
          descriptor: { managedRoot: "/worktrees" },
          request: (
            request: CodexWorktreeWorkerRequest,
            callbacks?: WorktreeWorkerRequestOptions,
          ) =>
            Effect.gen(function* () {
              requests.push(request);
              yield* (
                callbacks?.onEvent?.({
                  operation: "create",
                  type: "path-allocated",
                  worktreeGitRoot: "/worktrees/review",
                  worktreeWorkspaceRoot: "/worktrees/review/packages/app",
                }) ?? Effect.void
              );
              return {
                worktreeGitRoot: "/worktrees/review",
                worktreeWorkspaceRoot: "/worktrees/review/packages/app",
                setupError: options.setupError ?? null,
                shellEnvironment: null,
              };
            }),
        }),
    } as never),
    Effect.provide(
      configLayer({ ...(options.homeDirectory ? { homeDirectory: options.homeDirectory } : {}) }),
    ),
  );
  return { owner, events, requests };
};

it.effect(
  "native automation records and owns the managed workspace before releasing its newborn protection",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      const owner = yield* f.owner;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const lease = yield* owner.prepare({
            definition,
            sourceCwd: "/source",
            operationId: "run:create",
          });
          assert.equal(lease.location.cwd, "/worktrees/review/packages/app");
          assert.equal(lease.location.managedWorktreePath, "/worktrees/review");
          assert.include(lease.location.workspaceRoots, "/worktrees/review/packages/source/.git");
          assert.deepEqual(f.events, ["register"]);
          yield* lease.attach("native-thread");
        }),
      );
      assert.deepEqual(f.events, ["register", "owner:native-thread", "release"]);
      assert.deepInclude(f.requests[0], { operation: "create" });
      if (f.requests[0]?.operation !== "create")
        return yield* Effect.die("Expected create request");
      assert.deepInclude(f.requests[0].input, {
        requestId: "run:create",
        repositoryPath: "/source",
        localEnvironmentConfigPath: null,
      });
    }),
);

it.effect(
  "unattached native worktrees and setup failures are cleaned through the shared lifecycle",
  () =>
    Effect.gen(function* () {
      for (const setupError of [undefined, "setup failed"]) {
        const f = fixture({ setupError });
        const owner = yield* f.owner;
        const prepared = Effect.scoped(
          owner.prepare({ definition, sourceCwd: "/source", operationId: "run:create" }),
        );
        if (setupError) assert.equal((yield* Effect.flip(prepared)).operation, "worktree.setup");
        else yield* prepared;
        assert.deepEqual(f.events, ["register", "remove", "release"]);
      }
    }),
);

it.effect("a Core-owned native worktree survives a later owner metadata repair failure", () =>
  Effect.gen(function* () {
    const f = fixture({ ownerFailure: true });
    const owner = yield* f.owner;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const lease = yield* owner.prepare({
          definition,
          sourceCwd: "/source",
          operationId: "run:create",
        });
        yield* lease.attach("durable-thread");
      }),
    );
    assert.notInclude(f.events, "remove");
    assert.deepEqual(f.events, ["register", "owner:durable-thread", "release"]);
  }),
);

it.effect(
  "projectless native automation uses a disposable dedicated workspace and output directory",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const homeDirectory = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(path.join(tmpdir(), "nodex-native-automation-"))),
          (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
        );
        const f = fixture({ homeDirectory });
        const owner = yield* f.owner;
        const lease = yield* owner.prepare({
          definition: { ...definition, projectId: null },
          sourceCwd: null,
          operationId: "run:create",
        });
        assert.isTrue(
          lease.location.cwd.startsWith(path.join(homeDirectory, "Documents", "Nodex")),
        );
        assert.equal(
          lease.location.projectlessOutputDirectory,
          path.join(lease.location.cwd, "outputs"),
        );
        assert.deepEqual((yield* Effect.promise(() => readdir(lease.location.cwd))).sort(), [
          "outputs",
          "work",
        ]);
        assert.lengthOf(f.requests, 0);
      }),
    ),
);

it.effect("projectless workspace ownership removes only a failed unlinked allocation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const homeDirectory = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(path.join(tmpdir(), "nodex-native-automation-"))),
        (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
      );
      const owner = yield* fixture({ homeDirectory }).owner;
      for (const attach of [false, true]) {
        const directory = yield* Effect.scoped(
          Effect.gen(function* () {
            const lease = yield* owner.prepare({
              definition: { ...definition, projectId: null },
              sourceCwd: null,
              operationId: "run:create",
            });
            if (attach) yield* lease.attach("durable-thread");
            return lease.location.cwd;
          }),
        );
        const exists = yield* Effect.tryPromise(() => access(directory)).pipe(
          Effect.match({ onFailure: () => false, onSuccess: () => true }),
        );
        assert.equal(exists, attach);
      }
    }),
  ),
);
