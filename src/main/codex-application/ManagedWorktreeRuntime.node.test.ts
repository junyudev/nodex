import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { assert, it } from "@effect/vitest";
import type { CodexSshExecutionHostConfig } from "../../shared/types";
import { snapshotPolicyForManagedWorktreeRemoval } from "../codex/codex-managed-worktree-lifecycle";
import type {
  CodexWorktreeWorkerInspectResult,
  CodexWorktreeWorkerRequest,
} from "../codex/codex-worktree-worker-protocol";
import {
  type ExecutionHost,
  ExecutionHostRuntime,
  ExecutionHostRuntimeError,
} from "./ExecutionHostRuntime";
import {
  ManagedWorktreeRuntime,
  live as managedWorktreeRuntimeLive,
} from "./ManagedWorktreeRuntime";

const makeExecutionHosts = (
  request: ExecutionHost["request"],
): Effect.Effect<ExecutionHostRuntime["Service"]> =>
  Effect.gen(function* () {
    const activeSshHosts = yield* SubscriptionRef.make<
      ReadonlyMap<string, CodexSshExecutionHostConfig>
    >(new Map());
    const descriptor = {
      hostId: "local",
      displayName: "Local",
      kind: "local",
      nodexHome: "/nodex",
      codexHome: "/codex",
      managedRoot: "/managed",
      handoffStagingRoot: "/codex/handoffs",
      repositoryRoots: [],
      capabilities: ["remove", "inspect", "list", "restore", "set-owner"],
      supportsFileTransfer: true,
    } as const;
    const host: ExecutionHost = {
      descriptor,
      transfer: null,
      request,
    };
    return ExecutionHostRuntime.of({
      activeSshHosts,
      hosts: () => Effect.succeed([descriptor]),
      get: (hostId) => Effect.succeed(hostId === "local" ? host : null),
      resolve: (hostId) =>
        hostId === "local"
          ? Effect.succeed(host)
          : Effect.fail(
              new ExecutionHostRuntimeError({
                operation: "resolve-host",
                hostId,
                cause: new Error("unknown host"),
              }),
            ),
      updateLocalManagedRoot: () => Effect.void,
      settings: Effect.succeed({ sshHosts: [] }),
      reconcile: () => Effect.void,
      updateSettings: () => Effect.succeed({ sshHosts: [] }),
    });
  });

const worktreeRequest = (
  run: (request: CodexWorktreeWorkerRequest) => Effect.Effect<unknown>,
): ExecutionHost["request"] => run as ExecutionHost["request"];

const acquire = (request: ExecutionHost["request"]) =>
  Effect.gen(function* () {
    const executionHosts = yield* makeExecutionHosts(request);
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(
      managedWorktreeRuntimeLive.pipe(
        Layer.provide(Layer.succeed(ExecutionHostRuntime, executionHosts)),
      ),
      scope,
    );
    return { managed: Context.get(context, ManagedWorktreeRuntime), scope };
  });

const waitUntil = (label: string, predicate: () => boolean): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (predicate()) return;
      yield* Effect.yieldNow;
    }
    return yield* Effect.die(new Error(`Managed Worktree test did not settle: ${label}`));
  });

it.effect("maps every removal reason to a closed snapshot policy", () =>
  Effect.sync(() => {
    assert.strictEqual(snapshotPolicyForManagedWorktreeRemoval("archive"), "required");
    assert.strictEqual(snapshotPolicyForManagedWorktreeRemoval("automatic-retention"), "required");
    assert.strictEqual(snapshotPolicyForManagedWorktreeRemoval("automation-archive"), "required");
    assert.strictEqual(snapshotPolicyForManagedWorktreeRemoval("settings-delete"), "best-effort");
    assert.strictEqual(snapshotPolicyForManagedWorktreeRemoval("failed-create"), "ephemeral");
    assert.strictEqual(snapshotPolicyForManagedWorktreeRemoval("retry"), "ephemeral");
    assert.strictEqual(snapshotPolicyForManagedWorktreeRemoval("cancel"), "ephemeral");
  }),
);

it.effect("sends one inventory request for the host current root", () =>
  Effect.gen(function* () {
    const requests: CodexWorktreeWorkerRequest[] = [];
    const { managed, scope } = yield* acquire(
      worktreeRequest((request) => {
        requests.push(request);
        return request.operation === "list"
          ? Effect.succeed({ entries: [] })
          : Effect.die("unexpected operation");
      }),
    );

    assert.deepEqual(yield* managed.list("local"), { entries: [] });
    assert.strictEqual(requests.length, 1);
    assert.strictEqual(requests[0]?.operation, "list");
    if (requests[0]?.operation === "list") {
      assert.strictEqual(requests[0].input.managedRoot, "/managed");
    }
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("owns one physical removal per host/path and clears newborn protection", () =>
  Effect.gen(function* () {
    let removeCalls = 0;
    const releaseRemoval = yield* Deferred.make<void>();
    const { managed, scope } = yield* acquire(
      worktreeRequest((request) => {
        if (request.operation !== "remove") return Effect.die("unexpected operation");
        removeCalls += 1;
        return Deferred.await(releaseRemoval).pipe(
          Effect.as({ removed: true, alreadyMissing: false, snapshot: null, warnings: [] }),
        );
      }),
    );
    yield* managed.registerNewborn({
      hostId: "local",
      worktreeGitRoot: "/managed/abcd/repo",
    });

    const first = yield* Effect.forkChild(
      managed.remove({
        hostId: "local",
        worktreeGitRoot: "/managed/abcd/repo",
        reason: "archive",
      }),
      { startImmediately: true },
    );
    const second = yield* Effect.forkChild(
      managed.remove({
        hostId: "local",
        worktreeGitRoot: "/managed/abcd/./repo",
        reason: "archive",
      }),
      { startImmediately: true },
    );
    yield* waitUntil("physical removal start", () => removeCalls === 1);
    yield* Deferred.succeed(releaseRemoval, undefined);
    const [firstResult, secondResult] = yield* Effect.all([Fiber.join(first), Fiber.join(second)]);
    assert.isTrue(firstResult.removed);
    assert.deepEqual(secondResult, firstResult);
    assert.isFalse(
      yield* managed.isNewborn({
        hostId: "local",
        worktreeGitRoot: "/managed/abcd/repo",
      }),
    );

    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("keeps coalesced inspection alive after caller cancellation and evicts completion", () =>
  Effect.gen(function* () {
    let inspectCalls = 0;
    const releaseInspection = yield* Deferred.make<void>();
    const result = {
      availability: {
        state: "restorable",
        repositoryPath: "/repositories/repository",
        snapshotRef: "refs/nodex/snapshots/one",
      },
    } satisfies CodexWorktreeWorkerInspectResult;
    const { managed, scope } = yield* acquire(
      worktreeRequest((request) => {
        if (request.operation !== "inspect") return Effect.die("unexpected operation");
        inspectCalls += 1;
        if (inspectCalls > 1) return Effect.succeed(result);
        return Deferred.await(releaseInspection).pipe(Effect.as(result));
      }),
    );
    const first = yield* Effect.forkChild(
      managed.inspect({
        hostId: "local",
        worktreeGitRoot: "/managed/abcd/repository",
        cwd: "/managed/abcd/repository/packages/app",
        candidateRepositoryPaths: ["/repositories/secondary", "/repositories/repository"],
      }),
      { startImmediately: true },
    );
    const second = yield* Effect.forkChild(
      managed.inspect({
        hostId: "local",
        worktreeGitRoot: "/managed/abcd/./repository",
        cwd: "/managed/abcd/repository/packages/./app",
        candidateRepositoryPaths: ["/repositories/repository", "/repositories/secondary"],
      }),
      { startImmediately: true },
    );
    yield* waitUntil("physical inspection start", () => inspectCalls === 1);
    yield* Fiber.interrupt(first);
    assert.strictEqual(inspectCalls, 1);
    yield* Deferred.succeed(releaseInspection, undefined);
    assert.deepEqual(yield* Fiber.join(second), result);

    assert.deepEqual(
      yield* managed.inspect({
        hostId: "local",
        worktreeGitRoot: "/managed/abcd/repository",
        cwd: "/managed/abcd/repository/packages/app",
        candidateRepositoryPaths: ["/repositories/repository", "/repositories/secondary"],
      }),
      result,
    );
    assert.strictEqual(inspectCalls, 2);

    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("interrupts an in-flight worker removal when its owning Scope closes", () =>
  Effect.gen(function* () {
    let interrupted = false;
    const { managed, scope } = yield* acquire(
      worktreeRequest((request) =>
        request.operation === "remove"
          ? Effect.never.pipe(
              Effect.onInterrupt(() =>
                Effect.sync(() => {
                  interrupted = true;
                }),
              ),
            )
          : Effect.die("unexpected operation"),
      ),
    );
    const removal = yield* Effect.forkChild(
      managed.remove({
        hostId: "local",
        worktreeGitRoot: "/managed/abcd/repo",
        reason: "archive",
      }),
      { startImmediately: true },
    );
    yield* Effect.yieldNow;

    yield* Scope.close(scope, Exit.void);
    const result = yield* Fiber.await(removal);
    assert.strictEqual(result._tag, "Failure");
    assert.isTrue(interrupted);
  }),
);
