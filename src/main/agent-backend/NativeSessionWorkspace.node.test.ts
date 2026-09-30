// @effect-diagnostics strictEffectProvide:off
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { NativeSessionWorkspaceInput } from "./NativeSessionWorkspace";
import { testLayer as configLayer } from "../app/MainConfig";
import { CodexGitProbe } from "../codex-application/CodexGitProbe";
import { ExecutionHostRuntime } from "../codex-application/ExecutionHostRuntime";
import { ManagedWorktreeRuntime } from "../codex-application/ManagedWorktreeRuntime";
import type { CodexWorktreeWorkerRequest } from "../codex/codex-worktree-worker-protocol";
import type { WorktreeWorkerRequestOptions } from "../host-runtime/WorktreeWorkerRuntime";
import { make, NativeSessionWorkspaceError } from "./NativeSessionWorkspace";
import type { CodexStoredShellEnvironment } from "../codex/codex-worktree-shell-environment";

const input: NativeSessionWorkspaceInput = {
  targetId: "session",
  projectId: "project",
  runInTarget: "newWorktree",
  title: "Review source",
  prompt: "Review source",
  localEnvironmentConfigPath: null,
  sourceCwd: "/source",
  operationId: "run:create",
};

const fixture = (
  options: {
    homeDirectory?: string;
    setupError?: string;
    ownerFailure?: boolean;
    environmentPath?: string;
    shellEnvironment?: CodexStoredShellEnvironment;
  } = {},
) => {
  const events: string[] = [];
  const requests: CodexWorktreeWorkerRequest[] = [];
  const owner = make.pipe(
    Effect.provideService(CodexGitProbe, {
      readPath: (_cwd, args) =>
        Effect.succeed(
          args[0] === "branch"
            ? "main"
            : args[1] === "--git-path"
              ? (options.environmentPath ?? null)
              : "../source/.git",
        ),
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
            return yield* new NativeSessionWorkspaceError({
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
                shellEnvironment: options.shellEnvironment ?? null,
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
  "native session records and owns the managed workspace before releasing its newborn protection",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      const owner = yield* f.owner;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const lease = yield* owner.prepare(input);
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
        const prepared = Effect.scoped(owner.prepare(input));
        if (setupError) assert.equal((yield* Effect.flip(prepared)).operation, "worktree.setup");
        else yield* prepared;
        assert.deepEqual(f.events, ["register", "remove", "release"]);
      }
    }),
);

it.effect("selected worktree state and Environment reach the worker and survive attachment", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(path.join(tmpdir(), "nodex-native-worktree-environment-"))),
        (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
      );
      const environmentPath = path.join(directory, "codex-shell-environment.json");
      const shellEnvironment: CodexStoredShellEnvironment = {
        version: 1,
        set: { PROJECT_ENV: "worktree", PATH: "/worktree/bin" },
        exclude: ["OLD_PROJECT_ENV"],
      };
      const f = fixture({ environmentPath, shellEnvironment });
      const owner = yield* f.owner;
      const startingState = { type: "working-tree" } as const;
      const lease = yield* owner.prepare({
        ...input,
        sourceRoots: ["/source", "/additional"],
        worktreeStartingState: startingState,
        localEnvironmentConfigPath: ".codex/environments/setup.toml",
      });
      assert.include(lease.location.workspaceRoots, "/additional");
      assert.notInclude(lease.location.workspaceRoots, "/source");
      const request = f.requests[0];
      if (request?.operation !== "create") return yield* Effect.die("Expected create request");
      assert.deepEqual(request.input.startingState, startingState);
      assert.equal(request.input.localEnvironmentConfigPath, ".codex/environments/setup.toml");
      assert.deepEqual(
        JSON.parse(yield* Effect.promise(() => readFile(environmentPath, "utf8"))),
        shellEnvironment,
      );
      yield* lease.attach("native-thread");
      assert.notInclude(f.events, "remove");
    }),
  ),
);

it.effect("environment persistence failure cleans an unowned worktree before Agent launch", () =>
  Effect.gen(function* () {
    const f = fixture({ shellEnvironment: { version: 1, set: { READY: "yes" }, exclude: [] } });
    const owner = yield* f.owner;
    const failure = yield* Effect.scoped(owner.prepare(input)).pipe(Effect.flip);
    assert.equal(failure.operation, "worktree.environment");
    assert.deepEqual(f.events, ["register", "remove", "release"]);
  }),
);

it.effect(
  "local execution retains every selected Project source without allocating a worktree",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = fixture();
        const owner = yield* f.owner;
        const lease = yield* owner.prepare({
          ...input,
          runInTarget: "localProject",
          sourceRoots: ["/source", "/additional"],
        });
        assert.equal(lease.location.cwd, "/source");
        assert.equal(lease.location.managedWorktreePath, null);
        assert.deepEqual(lease.location.workspaceRoots, ["/source", "/additional"]);
        assert.lengthOf(f.requests, 0);
        assert.deepEqual(f.events, []);
      }),
    ),
);

it.effect("a local Environment cannot silently apply to the source checkout", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = fixture();
      const owner = yield* f.owner;
      const failure = yield* owner
        .prepare({
          ...input,
          runInTarget: "localProject",
          localEnvironmentConfigPath: ".codex/environments/setup.toml",
        })
        .pipe(Effect.flip);
      assert.equal(failure.operation, "workspace.environment");
      assert.lengthOf(f.requests, 0);
    }),
  ),
);

it.effect("a Core-owned native worktree survives a later owner metadata repair failure", () =>
  Effect.gen(function* () {
    const f = fixture({ ownerFailure: true });
    const owner = yield* f.owner;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const lease = yield* owner.prepare(input);
        yield* lease.attach("durable-thread");
      }),
    );
    assert.notInclude(f.events, "remove");
    assert.deepEqual(f.events, ["register", "owner:durable-thread", "release"]);
  }),
);

it.effect("uncertain Core ownership retains the workspace and its newborn protection", () =>
  Effect.gen(function* () {
    const f = fixture();
    const owner = yield* f.owner;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const lease = yield* owner.prepare(input);
        yield* lease.retain;
      }),
    );
    assert.deepEqual(f.events, ["register"]);
  }),
);

it.effect(
  "projectless native session uses a disposable dedicated workspace and output directory",
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
          ...input,
          projectId: null,
          runInTarget: "localProject",
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
              ...input,
              projectId: null,
              runInTarget: "localProject",
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
