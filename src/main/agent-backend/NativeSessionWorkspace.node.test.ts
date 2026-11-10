import { SessionFolders } from "./SessionFolders";
// @effect-diagnostics strictEffectProvide:off
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { NativeSessionWorkspaceInput } from "./NativeSessionWorkspace";
import { testLayer as configLayer, type MainConfigValue } from "../app/MainConfig";
import { CodexGitProbe, make as makeGitProbe } from "../codex-application/CodexGitProbe";
import { ExecutionHostRuntime } from "../codex-application/ExecutionHostRuntime";
import { ManagedWorktreeRuntime } from "../codex-application/ManagedWorktreeRuntime";
import type { CodexWorktreeWorkerRequest } from "../codex/codex-worktree-worker-protocol";
import type { WorktreeWorkerRequestOptions } from "../host-runtime/WorktreeWorkerRuntime";
import { make, NativeSessionWorkspaceError } from "./NativeSessionWorkspace";
import type { CodexStoredShellEnvironment } from "../codex/codex-worktree-shell-environment";
import { setManagedWorktreeOwnerThread } from "../codex/git-worktree-service";

const input: NativeSessionWorkspaceInput = {
  targetId: "session",
  projectId: "project",
  runInTarget: "newWorktree",
  title: "Review source",
  prompt: "Review source",
  localEnvironmentConfigPath: null,
  sourceCwd: path.resolve("/source"),
  operationId: "run:create",
};

const fixture = (
  options: {
    config?: Partial<MainConfigValue>;
    folders?: SessionFolders["Service"];
    setupError?: string;
    ownerFailure?: boolean;
    environmentPath?: string;
    shellEnvironment?: CodexStoredShellEnvironment;
    git?: CodexGitProbe["Service"];
    managedRoot?: string;
  } = {},
) => {
  const events: string[] = [];
  const requests: CodexWorktreeWorkerRequest[] = [];
  const owner = make.pipe(
    Effect.provideService(
      CodexGitProbe,
      options.git ?? {
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
      },
    ),
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
          descriptor: { managedRoot: options.managedRoot ?? path.resolve("/worktrees") },
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
                  worktreeGitRoot: path.resolve("/worktrees/review"),
                  worktreeWorkspaceRoot: path.resolve("/worktrees/review/packages/app"),
                }) ?? Effect.void
              );
              return {
                worktreeGitRoot: path.resolve("/worktrees/review"),
                worktreeWorkspaceRoot: path.resolve("/worktrees/review/packages/app"),
                setupError: options.setupError ?? null,
                shellEnvironment: options.shellEnvironment ?? null,
              };
            }),
        }),
    } as never),
    Effect.provideService(
      SessionFolders,
      options.folders ?? {
        existing: () => Effect.die("unused"),
        reset: () => Effect.die("unused"),
        ensure: () => Effect.die("unused"),
        choose: () => Effect.die("unused"),
        cleanDeleted: () => Effect.void,
      },
    ),
    Effect.provide(configLayer(options.config)),
  );
  return { owner, events, requests };
};

it.effect(
  "retained worktree reconciliation proves Git identity and refuses another execution owner",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(path.join(tmpdir(), "nodex-workspace-reconcile-"))),
          (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
        );
        const source = path.join(directory, "source");
        const managedRoot = path.join(directory, "managed");
        const worktree = path.join(managedRoot, "261014-0101-aabbccdd");
        const cwd = path.join(worktree, "packages", "app");
        const run = promisify(execFile);
        yield* Effect.promise(async () => {
          await mkdir(source, { recursive: true });
          await run("git", ["init", source]);
          await run("git", [
            "-C",
            source,
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "--allow-empty",
            "-m",
            "Initial",
          ]);
          await run("git", ["-C", source, "worktree", "add", "--detach", worktree]);
          await mkdir(cwd, { recursive: true });
        });
        const f = fixture({ managedRoot, git: makeGitProbe({ environment: process.env }) });
        const owner = yield* f.owner;
        yield* owner.reconcile({ cwd: source, threadId: "unrelated" });
        assert.deepEqual(f.events, []);
        yield* owner.reconcile({ cwd, threadId: "durable-thread" });
        assert.deepEqual(f.events, ["owner:durable-thread", "release"]);
        assert.equal(f.requests.length, 0, "Reconciliation cannot allocate another workspace");
        yield* Effect.promise(() => setManagedWorktreeOwnerThread(worktree, "another-thread"));
        assert.equal(
          (yield* owner.reconcile({ cwd, threadId: "durable-thread" }).pipe(Effect.result))._tag,
          "Failure",
        );
        assert.deepEqual(f.events, ["owner:durable-thread", "release"]);
        yield* Effect.promise(() => setManagedWorktreeOwnerThread(worktree, "durable-thread"));
        yield* owner.reconcile({ cwd, threadId: "durable-thread" });
        assert.deepEqual(f.events, [
          "owner:durable-thread",
          "release",
          "owner:durable-thread",
          "release",
        ]);
      }),
    ),
);

it.effect(
  "native session records and owns the managed workspace before releasing its newborn protection",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      const owner = yield* f.owner;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const lease = yield* owner.prepare(input);
          assert.equal(lease.location.cwd, path.resolve("/worktrees/review/packages/app"));
          assert.equal(lease.location.managedWorktreePath, path.resolve("/worktrees/review"));
          assert.include(
            lease.location.workspaceRoots,
            path.resolve("/worktrees/review/packages/source/.git"),
          );
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
        repositoryPath: path.resolve("/source"),
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
        sourceRoots: [path.resolve("/source"), "/additional"],
        worktreeStartingState: startingState,
        localEnvironmentConfigPath: ".codex/environments/setup.toml",
      });
      assert.include(lease.location.workspaceRoots, "/additional");
      assert.notInclude(lease.location.workspaceRoots, path.resolve("/source"));
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
          sourceRoots: [path.resolve("/source"), "/additional"],
        });
        assert.equal(lease.location.cwd, path.resolve("/source"));
        assert.equal(lease.location.managedWorktreePath, null);
        assert.deepEqual(lease.location.workspaceRoots, [path.resolve("/source"), "/additional"]);
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

it.effect("first send uses the chosen Chat folder as its entire workspace", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = path.resolve("/chosen");
      const f = fixture({
        folders: {
          existing: () => Effect.die("unused"),
          reset: () => Effect.die("unused"),
          ensure: (sessionId) =>
            Effect.sync(() => {
              assert.equal(sessionId, input.targetId);
              return {
                path: cwd,
                output_directory: cwd,
                execution_host_id: "local",
                origin: "chosen",
              };
            }),
          choose: () => Effect.die("unused"),
          cleanDeleted: () => Effect.void,
        },
      });
      const owner = yield* f.owner;
      const lease = yield* owner.prepare({
        ...input,
        projectId: null,
        runInTarget: "localProject",
        sourceCwd: null,
        sourceRoots: [path.resolve("/outside")],
      });
      assert.deepEqual(lease.location, {
        cwd,
        workspaceRoots: [cwd],
        managedWorktreePath: null,
        projectlessOutputDirectory: cwd,
        projectlessWorkspaceBrowserRoot: cwd,
      });
      assert.lengthOf(f.requests, 0);
    }),
  ),
);

it.effect("reuses a Page checkout in the Project primary source subdirectory", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = fixture({
        git: {
          readPath: () => Effect.succeed("apps/web/"),
          isNonGitWorkspace: () => Effect.succeed(false),
          isNonGitWorkspaceOnHost: () => Effect.succeed(false),
        },
      });
      const workspace = yield* f.owner;
      const lease = yield* workspace.prepare({
        ...input,
        sourceCwd: path.resolve("/repo/apps/web"),
        sourceRoots: [path.resolve("/repo/apps/web"), path.resolve("/reference")],
        runInTarget: "localProject",
        reusePageWorkspace: {
          worktreeGitRoot: path.resolve("/managed/abcd/repo"),
          branchName: "nodex-12-web",
        },
      });
      assert.equal(lease.location.cwd, path.resolve("/managed/abcd/repo/apps/web"));
      assert.equal(lease.location.managedWorktreePath, path.resolve("/managed/abcd/repo"));
      assert.deepEqual(lease.location.workspaceRoots, [
        path.resolve("/managed/abcd/repo/apps/web"),
        path.resolve("/managed/abcd/repo"),
        path.resolve("/reference"),
      ]);
      assert.equal(f.requests.length, 0);
    }),
  ),
);
