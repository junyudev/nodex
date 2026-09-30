import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { CodexSshExecutionHostConfig } from "../../shared/types";
import { CodexThreadHandoffJournalStorageError } from "../platform/CodexThreadHandoffJournalStorage";
import { WorktreeWorkerError } from "../host-runtime/WorktreeWorkerRuntime";
import type { CodexThreadHandoffJournalEntry } from "../codex/codex-thread-handoff-journal";
import type { CodexWorktreeWorkerRequest } from "../codex/codex-worktree-worker-protocol";
import { CodexAppServerCapabilities } from "../codex-runtime/CodexAppServerCapabilities";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { CoreModules } from "../core-runtime/CoreModules";
import { CrossHostThreadHandoff } from "./CrossHostThreadHandoff";
import {
  ExecutionHostRuntime,
  ExecutionHostRuntimeError,
  type ExecutionHost,
} from "./ExecutionHostRuntime";
import {
  ManagedWorktreeHandoff,
  live,
  type ManagedWorktreeHandoffPreparation,
} from "./ManagedWorktreeHandoff";
import { ManagedWorktreeRetentionRuntime } from "./ManagedWorktreeRetentionRuntime";
import { ManagedWorktreeRuntime } from "./ManagedWorktreeRuntime";

const entry: CodexThreadHandoffJournalEntry = {
  schemaVersion: 1,
  operationId: "move",
  threadId: "thread",
  phase: "preparing-destination",
  source: {
    hostId: "local",
    cwd: "/repo",
    workspaceRoots: ["/repo"],
    managedWorktreePath: null,
    projectId: "project",
    projectlessOutputDirectory: null,
    projectlessWorkspaceBrowserRoot: null,
  },
  requestedDestinationHostId: null,
  destination: null,
  prepared: null,
  runtimeSwitched: false,
  coreCommitted: false,
  followUpPrompt: null,
  followUpDispatchStarted: false,
  warnings: [],
  lastError: null,
  failedPhase: null,
  createdAt: 1,
  updatedAt: 1,
  completedAt: null,
};

const makeFixture = (
  options: {
    failWorker?: boolean;
    preparationRestored?: boolean;
    rollbackWarnings?: readonly string[];
  } = {},
) =>
  Effect.gen(function* () {
    const newborns = new Set<string>();
    const requests: CodexWorktreeWorkerRequest[] = [];
    const descriptor = {
      hostId: "local",
      displayName: "Local",
      kind: "local" as const,
      nodexHome: "/nodex",
      codexHome: "/codex",
      managedRoot: "/managed",
      handoffStagingRoot: "/handoffs",
      repositoryRoots: ["/repo"],
      capabilities: ["prepare-handoff", "rollback-handoff"] as const,
      supportsFileTransfer: true,
    };
    const host: ExecutionHost = {
      descriptor,
      transfer: null,
      request: ((request: CodexWorktreeWorkerRequest) =>
        Effect.gen(function* () {
          requests.push(request);
          if (options.failWorker)
            return yield* new ExecutionHostRuntimeError({
              operation: request.operation,
              hostId: "local",
              cause:
                options.preparationRestored !== undefined
                  ? new WorktreeWorkerError({
                      operation: "worker-result",
                      message: "Source restored",
                      cause: new Error("Destination dirty"),
                      preparationRestored: options.preparationRestored,
                    })
                  : new Error("Worker reply lost"),
            });
          if (request.operation === "rollback-handoff")
            return { rolledBack: true, warnings: options.rollbackWarnings ?? [] };
          if (request.operation !== "prepare-handoff" || !request.input.allocatedWorktreePath)
            return yield* Effect.die("Unexpected worker request");
          const destination = request.input.allocatedWorktreePath;
          return {
            direction: "to-worktree",
            sourceBranch: "task",
            localCheckoutBranch: "main",
            destinationBranch: "task",
            sourceWorkspaceRoot: "/repo",
            destinationWorkspaceRoot: destination,
            destinationGitRoot: destination,
            managedWorktreePath: destination,
            createdWorktree: true,
            warnings: [],
          };
        })) as ExecutionHost["request"],
    };
    const activeSshHosts = yield* SubscriptionRef.make<
      ReadonlyMap<string, CodexSshExecutionHostConfig>
    >(new Map());
    const scope = yield* Scope.Scope;
    const context = yield* Layer.buildWithScope(
      live.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(CodexGateway, {} as CodexGateway["Service"]),
            Layer.succeed(CodexAppServerCapabilities, {} as CodexAppServerCapabilities["Service"]),
            Layer.succeed(CoreModules, {
              workspace: {
                read: (input: { kind: string }) =>
                  Effect.succeed({
                    value:
                      input.kind === "project"
                        ? { kind: "project", project: { sources: [{ root: "/repo" }] } }
                        : { kind: "thread", thread: { thread_name: "Task", thread_preview: "" } },
                  }),
              },
            } as unknown as CoreModules["Service"]),
            Layer.succeed(CrossHostThreadHandoff, {
              prepare: () => Effect.die("Unexpected cross-host move"),
              cleanup: () => Effect.succeed([]),
            }),
            Layer.succeed(ExecutionHostRuntime, {
              activeSshHosts,
              hosts: () => Effect.succeed([descriptor]),
              get: () => Effect.succeed(host),
              resolve: () => Effect.succeed(host),
              updateLocalManagedRoot: () => Effect.void,
              settings: Effect.die("Unused settings"),
              updateSettings: () => Effect.die("Unused settings"),
              reconcile: () => Effect.void,
            }),
            Layer.succeed(ManagedWorktreeRetentionRuntime, {
              request: Effect.void,
              run: Effect.die("Unused retention"),
            }),
            Layer.succeed(ManagedWorktreeRuntime, {
              registerNewborn: ({ worktreeGitRoot }) =>
                Effect.sync(() => {
                  newborns.add(worktreeGitRoot);
                }),
              releaseNewborn: ({ worktreeGitRoot }) =>
                Effect.sync(() => {
                  newborns.delete(worktreeGitRoot);
                }),
              newborns: Effect.succeed([]),
              isNewborn: ({ worktreeGitRoot }) => Effect.sync(() => newborns.has(worktreeGitRoot)),
              list: () => Effect.die("Unused inventory"),
              remove: () => Effect.die("Unused removal"),
              inspect: () => Effect.die("Unused inspection"),
              restore: () => Effect.die("Unused restore"),
              setOwner: () => Effect.void,
            }),
          ),
        ),
      ),
      scope,
    );
    return { handoff: Context.get(context, ManagedWorktreeHandoff), newborns, requests };
  });

it.effect("waits for the durable allocation checkpoint before the worker can move files", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const checkpoint = yield* Deferred.make<string>();
      const persisted = yield* Deferred.make<void>();
      const preparing = yield* fixture.handoff
        .prepare(entry, (progress) =>
          progress.allocatedDestination
            ? Deferred.succeed(checkpoint, progress.allocatedDestination.worktreeGitRoot).pipe(
                Effect.andThen(Deferred.await(persisted)),
                Effect.asVoid,
              )
            : Effect.void,
        )
        .pipe(Effect.forkChild);
      const allocated = yield* Deferred.await(checkpoint);
      assert.deepEqual(fixture.requests, []);
      assert.strictEqual(fixture.newborns.size, 0);
      yield* Deferred.succeed(persisted, undefined);
      const prepared = yield* Fiber.join(preparing);
      assert.strictEqual(prepared.destination.managedWorktreePath, allocated);
      assert.isTrue(fixture.newborns.has(allocated));
      assert.strictEqual(fixture.requests[0]?.operation, "prepare-handoff");
    }),
  ),
);

it.effect("a failed allocation checkpoint never dispatches a mutating worker", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const result = yield* fixture.handoff
        .prepare(entry, () =>
          Effect.fail(
            new CodexThreadHandoffJournalStorageError({
              operation: "persist",
              cause: new Error("Journal is read-only"),
            }),
          ),
        )
        .pipe(Effect.result);
      assert.strictEqual(result._tag, "Failure");
      if (result._tag === "Failure") assert.isTrue(result.failure.preparationRestored);
      assert.deepEqual(fixture.requests, []);
      assert.strictEqual(fixture.newborns.size, 0);
    }),
  ),
);

it.effect("a lost worker reply retains its allocation and never claims source restoration", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* makeFixture({ failWorker: true });
      const result = yield* fixture.handoff.prepare(entry).pipe(Effect.result);
      assert.strictEqual(result._tag, "Failure");
      if (result._tag === "Failure") assert.isUndefined(result.failure.preparationRestored);
      assert.strictEqual(fixture.newborns.size, 1);
    }),
  ),
);

it.effect("accepts only the worker's explicit verified restoration proof", () =>
  Effect.scoped(
    Effect.gen(function* () {
      for (const preparationRestored of [true, false]) {
        const fixture = yield* makeFixture({ failWorker: true, preparationRestored });
        const result = yield* fixture.handoff.prepare(entry).pipe(Effect.result);
        assert.strictEqual(result._tag, "Failure");
        if (result._tag === "Failure")
          assert.strictEqual(
            result.failure.preparationRestored,
            preparationRestored ? true : undefined,
          );
      }
    }),
  ),
);

it.effect("failed or incomplete Git rollback retains newborn protection", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const created = yield* makeFixture();
      const preparation: ManagedWorktreeHandoffPreparation = yield* created.handoff.prepare(entry);
      for (const options of [
        { failWorker: true },
        { rollbackWarnings: ["Source restoration incomplete"] },
      ]) {
        const fixture = yield* makeFixture(options);
        fixture.newborns.add(preparation.prepared.managedWorktreePath);
        yield* fixture.handoff.rollback(entry.threadId, preparation).pipe(Effect.result);
        assert.isTrue(fixture.newborns.has(preparation.prepared.managedWorktreePath));
      }
    }),
  ),
);
