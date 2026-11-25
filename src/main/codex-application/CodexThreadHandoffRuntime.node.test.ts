import { describe } from "vite-plus/test";
import { CoreApplicationAgent } from "../core-runtime/CoreApplicationAgent";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { assert, it } from "@effect/vitest";
import { parseCodexThreadHandoffJournal } from "../codex/codex-thread-handoff-journal";
import type { CodexSshExecutionHostConfig } from "../../shared/types";
import type {
  CodexThreadExecutionLocation,
  CodexThreadHandoffJournalEntry,
} from "../codex/codex-thread-handoff-journal";
import type { CodexThreadHandoffJournalStorage } from "../platform/CodexThreadHandoffJournalStorage";
import { ThreadExecution, ThreadExecutionError } from "../host-runtime/ThreadExecution";
import {
  ExecutionHostRuntime,
  type ExecutionHost,
  ExecutionHostRuntimeError,
} from "./ExecutionHostRuntime";
import {
  ManagedWorktreeHandoff,
  ManagedWorktreeHandoffError,
  type ManagedWorktreeHandoffPreparation,
} from "./ManagedWorktreeHandoff";
import { make, type CodexThreadHandoffRuntime } from "./CodexThreadHandoffRuntime";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import { NodeFileSystem } from "@effect/platform-node";
import { CodexLocalExecutionHostFileTransfer } from "../codex/codex-execution-host-file-transfer";
import { executeCodexWorktreeWorkerOperation } from "../codex/codex-worktree-worker-operation";
import type {
  CodexWorktreeWorkerEvent,
  CodexWorktreeWorkerRequest,
} from "../codex/codex-worktree-worker-protocol";
import {
  CrossHostThreadHandoff,
  live as crossHostThreadHandoffLive,
} from "./CrossHostThreadHandoff";
import { ManagedWorktreeRuntime } from "./ManagedWorktreeRuntime";

describe("CodexThreadHandoffRuntime", () => {
  const source: CodexThreadExecutionLocation = {
    hostId: "local",
    cwd: "/repo/source",
    workspaceRoots: ["/repo/source"],
    managedWorktreePath: null,
    projectId: "project-1",
    projectlessOutputDirectory: null,
    projectlessWorkspaceBrowserRoot: null,
  };

  const destination: CodexThreadExecutionLocation = {
    ...source,
    cwd: "/managed/task",
    workspaceRoots: ["/managed/task"],
    managedWorktreePath: "/managed/task",
  };

  const preparation: ManagedWorktreeHandoffPreparation = {
    destination,
    prepared: {
      direction: "to-worktree",
      sourceBranch: "main",
      localCheckoutBranch: "main",
      destinationBranch: "codex/task",
      sourceWorkspaceRoot: source.cwd,
      destinationWorkspaceRoot: destination.cwd,
      destinationGitRoot: destination.cwd,
      managedWorktreePath: destination.cwd,
      createdWorktree: true,
      warnings: [],
    },
  };

  const relocation: ManagedWorktreeHandoffPreparation = {
    destination: source,
    prepared: {
      direction: "relocate",
      sourceWorkspaceRoot: destination.cwd,
      destinationWorkspaceRoot: source.cwd,
    },
  };

  const makeEntry = (): CodexThreadHandoffJournalEntry => ({
    schemaVersion: 1,
    operationId: "operation-recover",
    threadId: "thread-1",
    phase: "committing-location",
    source,
    requestedDestinationHostId: null,
    destination,
    prepared: preparation.prepared,
    runtimeSwitched: true,
    coreCommitted: true,
    followUpPrompt: "continue",
    followUpDispatchStarted: false,
    warnings: [],
    lastError: null,
    failedPhase: null,
    createdAt: 1,
    updatedAt: 2,
    completedAt: null,
  });

  const makeStorage = (initial: readonly CodexThreadHandoffJournalEntry[] = []) => {
    let entries = initial;
    return {
      load: Effect.sync(() => entries),
      persist: (next) =>
        Effect.sync(() => {
          entries = next;
        }),
    } satisfies CodexThreadHandoffJournalStorage;
  };

  const makeExecutionHosts = Effect.gen(function* () {
    const activeSshHosts = yield* SubscriptionRef.make<
      ReadonlyMap<string, CodexSshExecutionHostConfig>
    >(new Map());
    const descriptor = {
      hostId: "local",
      displayName: "This Mac",
      kind: "local" as const,
      nodexHome: "/nodex",
      codexHome: "/codex",
      managedRoot: "/managed",
      handoffStagingRoot: "/handoffs",
      repositoryRoots: ["/repo"],
      capabilities: ["create"] as const,
      supportsFileTransfer: true,
    };
    const host = {
      descriptor,
      transfer: null,
      request: () => Effect.die("unused"),
    };
    return ExecutionHostRuntime.of({
      activeSshHosts,
      hosts: () => Effect.succeed([descriptor]),
      get: () => Effect.succeed(host),
      resolve: () => Effect.succeed(host),
      updateLocalManagedRoot: () => Effect.void,
      settings: Effect.die("unused"),
      updateSettings: () => Effect.die("unused"),
      reconcile: () => Effect.void,
    });
  });

  const makeHarness = (input: {
    readonly calls: string[];
    readonly operationIds?: string[];
    readonly modeLimits?: unknown[];
    readonly followUpSenders?: unknown[];
    readonly reconciliations?: Array<
      readonly { readonly threadId: string; readonly operationId: string }[]
    >;
    readonly reconcileStarted?: Deferred.Deferred<void>;
    readonly reconcileGate?: Deferred.Deferred<void>;
    readonly canonical?: CodexThreadExecutionLocation;
    readonly failAt?: string;
    readonly initial?: readonly CodexThreadHandoffJournalEntry[];
    readonly stopGate?: Deferred.Deferred<void>;
    readonly prepareGate?: Deferred.Deferred<void>;
    readonly loseCommitReply?: boolean;
    readonly readFailureAfterCommit?: "unavailable" | "ambiguous";
    readonly rollbackWarnings?: readonly string[];
    readonly cleanupWarnings?: readonly string[];
    readonly safety?: { required: boolean; readonly changes: boolean[] };
    readonly relocating?: boolean;
    readonly selectStrategy?: ManagedWorktreeHandoff["Service"]["selectStrategy"];
    readonly preparationFailure?: "restored" | "uncertain";
    readonly onRead?: () => void;
  }) =>
    Effect.gen(function* () {
      const executionHosts = yield* makeExecutionHosts;
      let canonical = input.canonical ?? source;
      let destinationCommitAttempted = false;
      let handoffActive = false;
      const safety = input.safety ?? { required: false, changes: [] };
      const isSource = (location: CodexThreadExecutionLocation) =>
        location.cwd === (input.relocating ? destination.cwd : source.cwd);
      const record = (name: string): Effect.Effect<void, ThreadExecutionError> =>
        Effect.sync(() => input.calls.push(name)).pipe(
          Effect.asVoid,
          Effect.andThen(
            input.failAt === name
              ? Effect.fail(
                  new ThreadExecutionError({
                    operation: name,
                    threadId: "thread-1",
                    cause: new Error(`${name} failed`),
                  }),
                )
              : Effect.void,
          ),
        );
      const execution = ThreadExecution.of({
        assertFollowUp: () =>
          input.failAt === "follow-up-admission"
            ? Effect.fail(
                new ThreadExecutionError({
                  operation: "follow-up-admission",
                  threadId: "thread-1",
                  cause: Object.assign(
                    new Error("Only the person can start Nodex models. Choose another provider."),
                    { code: "credit_requires_person", retryable: false },
                  ),
                }),
              )
            : Effect.void,
        reconcileRecovery: (operations) =>
          Effect.gen(function* () {
            input.reconciliations?.push(operations);
            if (input.reconcileStarted) yield* Deferred.succeed(input.reconcileStarted, undefined);
            if (input.reconcileGate) yield* Deferred.await(input.reconcileGate);
          }),
        setRecoveryRequired: (_threadId, required, operationId) =>
          Effect.sync(() => {
            input.operationIds?.push(operationId ?? "missing");
            safety.required = required;
            safety.changes.push(required);
            if (!required)
              assert.isTrue(handoffActive, "Safety releases only within the handoff lease");
          }),
        read: () =>
          Effect.suspend(() => {
            input.onRead?.();
            if (!destinationCommitAttempted || !input.readFailureAfterCommit)
              return Effect.succeed(canonical);
            if (input.readFailureAfterCommit === "ambiguous")
              return Effect.succeed({ ...canonical, cwd: "/elsewhere" });
            return Effect.fail(
              new ThreadExecutionError({
                operation: "read",
                threadId: "thread-1",
                cause: new Error("Core unavailable"),
              }),
            );
          }),
        withHandoff: (_threadId, use, operationId) =>
          Effect.acquireUseRelease(
            Effect.sync(() => {
              input.operationIds?.push(operationId ?? "missing");
              handoffActive = true;
            }),
            () => use,
            () =>
              Effect.sync(() => {
                handoffActive = false;
              }),
          ),
        stop: () =>
          record("stop").pipe(
            Effect.andThen(input.stopGate ? Deferred.await(input.stopGate) : Effect.void),
          ),
        withRuntimeLocation: (_threadId, location, _preparation, use) =>
          record(isSource(location) ? "runtime:source" : "runtime:destination").pipe(
            Effect.andThen(use),
          ),
        commit: (_threadId, location) =>
          Effect.gen(function* () {
            if (!isSource(location)) destinationCommitAttempted = true;
            if (input.loseCommitReply && !isSource(location)) canonical = location;
            yield* record(isSource(location) ? "core:source" : "core:destination");
            canonical = location;
            if (input.loseCommitReply && !isSource(location))
              return yield* new ThreadExecutionError({
                operation: "commit",
                threadId: "thread-1",
                cause: new Error("Commit reply lost"),
              });
          }),
        followUp: (_threadId, _prompt, operationId, modeLimit, sender) =>
          Effect.suspend(() => {
            input.operationIds?.push(operationId ?? "missing");
            input.modeLimits?.push(modeLimit);
            input.followUpSenders?.push(sender);
            assert.isFalse(
              handoffActive,
              "Follow-up must be admitted after the handoff guard releases",
            );
            assert.isFalse(safety.required, "Follow-up requires verified recovery");
            return record("follow-up");
          }),
      });
      const handoff = ManagedWorktreeHandoff.of({
        isMissingLocalSource: () => Effect.succeed(input.relocating === true),
        selectStrategy: (entry) =>
          input.selectStrategy?.(entry) ??
          Effect.succeed(input.relocating ? "relocate" : "transfer"),
        prepare: (_entry, strategy, onProgress) =>
          Effect.gen(function* () {
            input.calls.push("prepare");
            if (strategy === "relocate") {
              yield* (
                onProgress?.({ phase: "confirm-source-missing", status: "running" }) ?? Effect.void
              );
              yield* (
                onProgress?.({ phase: "confirm-source-missing", status: "success" }) ?? Effect.void
              );
              return relocation;
            }
            yield* (
              onProgress?.({
                phase: "create-new-worktree",
                status: "running",
                allocatedDestination: {
                  hostId: destination.hostId,
                  worktreeGitRoot: destination.cwd,
                },
              }) ?? Effect.void
            );
            yield* (
              onProgress?.({
                phase: "create-new-worktree",
                status: "running",
                branchContext: {
                  sourceBranch: "main",
                  localBranch: "main",
                  worktreeBranch: "codex/task",
                },
              }) ?? Effect.void
            );
            yield* input.prepareGate ? Deferred.await(input.prepareGate) : Effect.void;
            if (input.preparationFailure)
              return yield* new ManagedWorktreeHandoffError({
                operation: "prepare",
                threadId: "thread-1",
                cause: new Error("Preparation did not complete"),
                preparationRestored: input.preparationFailure === "restored" ? true : undefined,
              });
            yield* onProgress?.({ phase: "create-new-worktree", status: "success" }) ?? Effect.void;
            return preparation;
          }).pipe(
            Effect.mapError((cause) =>
              cause instanceof ManagedWorktreeHandoffError
                ? cause
                : new ManagedWorktreeHandoffError({
                    operation: "progress",
                    threadId: "thread-1",
                    cause,
                    preparationRestored: true,
                  }),
            ),
          ),
        transferOwner: () => Effect.sync(() => input.calls.push("owner")),
        rollback: () =>
          Effect.sync(() => input.calls.push("git:rollback")).pipe(
            Effect.andThen(
              input.failAt === "git:rollback"
                ? Effect.fail(
                    new ManagedWorktreeHandoffError({
                      operation: "rollback",
                      threadId: "thread-1",
                      cause: new Error("Git restore failed"),
                    }),
                  )
                : Effect.succeed(input.rollbackWarnings ?? []),
            ),
          ),
        cleanup: (_threadId, _preparation, outcome) =>
          Effect.sync(() => input.calls.push(`cleanup:${outcome}`)).pipe(
            Effect.as(input.cleanupWarnings ?? []),
          ),
      });
      const runtimeScope = yield* Scope.make();
      return yield* make({ storage: makeStorage(input.initial) }).pipe(
        Effect.provideService(ThreadExecution, execution),
        Effect.provideService(ExecutionHostRuntime, executionHosts),
        Effect.provideService(ManagedWorktreeHandoff, handoff),
        Effect.provideService(Scope.Scope, runtimeScope),
      );
    });

  const start = (runtime: CodexThreadHandoffRuntime["Service"], operationId = "operation-1") =>
    runtime.start({
      operationId,
      threadId: "thread-1",
      destinationHostId: null,
      followUpPrompt: "continue",
    });

  it.effect("reads retained handoff outcomes after restart without repeating execution", () =>
    Effect.gen(function* () {
      for (const phase of ["completed", "completed-with-warning", "failed"] as const) {
        const calls: string[] = [];
        const entry: CodexThreadHandoffJournalEntry = {
          ...makeEntry(),
          phase,
          completedAt: 3,
          updatedAt: 3,
          followUpDispatchStarted: true,
          warnings: phase === "completed-with-warning" ? ["Cleanup needs attention"] : [],
          lastError: phase === "failed" ? "Destination unavailable" : null,
          failedPhase: phase === "failed" ? "preparing-destination" : null,
        };
        const runtime = yield* makeHarness({ calls, initial: [entry] });
        const before = yield* runtime.snapshot;
        const result = yield* runtime.get(entry.operationId);
        const after = yield* runtime.snapshot;
        assert.isAbove(after.revision, before.revision);
        assert.deepEqual(after.operations, result ? [result] : []);
        assert.strictEqual(
          result?.status,
          phase === "completed" ? "success" : phase === "failed" ? "error" : "warning",
        );
        assert.strictEqual(result?.completedAt, 3);
        assert.strictEqual(result?.sourceThreadId, entry.threadId);
        assert.deepEqual(yield* runtime.waitForRevision(entry.operationId, 999, 60_000), result);
        assert.deepEqual(yield* runtime.recover(), []);
        assert.isNull(yield* runtime.get("unknown-operation"));
        assert.deepEqual(calls, []);
      }
    }),
  );

  it.effect("commits one handoff in semantic order", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const operationIds: string[] = [];
      const runtime = yield* makeHarness({ calls, operationIds });
      const result = yield* start(runtime);
      assert.strictEqual(result.phase, "completed");
      assert.deepEqual(calls, [
        "stop",
        "prepare",
        "runtime:destination",
        "core:destination",
        "owner",
        "cleanup:committed",
        "follow-up",
      ]);
      assert.isAtLeast(operationIds.length, 3);
      assert.deepEqual([...new Set(operationIds)], ["operation-1"]);
    }),
  );

  it.effect("rolls runtime and worktree preparation back when durable commit fails", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const runtime = yield* makeHarness({ calls, failAt: "core:destination" });
      const result = yield* start(runtime);
      assert.strictEqual(result.phase, "failed");
      const operation = yield* runtime.get(result.operationId);
      assert.isFalse(operation?.steps.some((step) => step.id === "transfer-owner"));
      assert.strictEqual(
        operation?.steps.find((step) => step.id === "switching-thread")?.status,
        "error",
      );
      assert.deepEqual(calls, [
        "stop",
        "prepare",
        "runtime:destination",
        "core:destination",
        "runtime:source",
        "git:rollback",
        "cleanup:rolled-back",
      ]);
    }),
  );

  it.effect("streams the originating handoff through completion and restores its result", () =>
    Effect.gen(function* () {
      const stopGate = yield* Deferred.make<void>();
      const prepareGate = yield* Deferred.make<void>();
      const runtime = yield* makeHarness({ calls: [], stopGate, prepareGate });
      const initial = yield* runtime.snapshot;
      const input = {
        operationId: "live-operation",
        threadId: "thread-1",
        requestThreadId: "caller",
        threadTitle: "Review changes",
        destinationHostId: null,
        followUpPrompt: null,
      };
      const admitted = yield* runtime.launch(input);
      assert.strictEqual(admitted.status, "running");
      assert.strictEqual(admitted.destinationHostDisplayName, "This Mac");
      assert.strictEqual(admitted.threadTitle, "Review changes");
      assert.strictEqual(admitted.projectId, "project-1");
      assert.deepEqual(admitted.steps, []);
      assert.strictEqual((yield* runtime.launch(input)).operationId, admitted.operationId);
      const terminal = yield* runtime.changes.pipe(
        Stream.filter((snapshot) =>
          snapshot.operations.some(
            (operation) =>
              operation.operationId === admitted.operationId && operation.status === "success",
          ),
        ),
        Stream.runHead,
        Effect.forkChild,
      );
      const preparing = yield* runtime.changes.pipe(
        Stream.filter((snapshot) =>
          snapshot.operations.some((operation) =>
            operation.steps.some(
              (step) => step.id === "create-new-worktree" && step.status === "running",
            ),
          ),
        ),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* Deferred.succeed(stopGate, undefined);
      yield* Fiber.join(preparing);
      const live = (yield* runtime.snapshot).operations[0]!;
      assert.strictEqual(live.worktreeBranch, "codex/task");
      assert.strictEqual(live.steps[0]?.label, "Creating a new worktree");
      yield* Deferred.succeed(prepareGate, undefined);
      yield* Fiber.join(terminal);
      const snapshot = yield* runtime.snapshot;
      assert.isAbove(snapshot.revision, initial.revision);
      assert.lengthOf(snapshot.operations, 1);
      const operation = snapshot.operations[0]!;
      assert.strictEqual(operation.requestThreadId, "caller");
      assert.strictEqual(operation.projectId, "project-1");
      assert.strictEqual(operation.threadTitle, "Review changes");
      assert.strictEqual(operation.direction, "local-to-worktree");
      assert.strictEqual(operation.localBranch, "main");
      assert.strictEqual(operation.worktreeBranch, "codex/task");
      assert.deepEqual(
        operation.steps.map(({ id, status }) => ({ id, status })),
        [
          { id: "create-new-worktree", status: "success" },
          { id: "switching-thread", status: "success" },
        ],
      );
      const journal = yield* runtime.start(input);
      const recovered = yield* makeHarness({ calls: [], initial: [journal] });
      yield* recovered.recover();
      const restored = yield* recovered.get(admitted.operationId);
      assert.strictEqual(restored?.status, "success");
      assert.strictEqual(restored?.requestThreadId, "caller");
      assert.strictEqual(restored?.threadTitle, "Review changes");
      assert.deepEqual(restored?.steps, operation.steps);
    }),
  );

  it.effect("recovers committed state once and enforces per-thread single-flight", () =>
    Effect.gen(function* () {
      const recoveredCalls: string[] = [];
      const recovered = yield* makeHarness({
        calls: recoveredCalls,
        canonical: destination,
        initial: [makeEntry()],
      });
      assert.strictEqual((yield* recovered.recover())[0]?.phase, "completed");
      assert.deepEqual(yield* recovered.recover(), []);
      assert.strictEqual(recoveredCalls.filter((call) => call === "follow-up").length, 1);

      const stopGate = yield* Deferred.make<void>();
      const runtime = yield* makeHarness({ calls: [], stopGate });
      const running = yield* Effect.forkChild(start(runtime), { startImmediately: true });
      yield* Effect.yieldNow;
      const conflict = yield* Effect.flip(start(runtime, "operation-2"));
      assert.include(conflict.message, "already has a handoff");
      yield* Deferred.succeed(stopGate, undefined);
      assert.strictEqual((yield* Fiber.join(running)).phase, "completed");
    }),
  );

  it.effect("rejects a stale location selection before stopping execution or preparing Git", () =>
    Effect.gen(function* () {
      for (const [canonical, expectedDestination] of [
        [source, "local"],
        [destination, "worktree"],
      ] as const) {
        const calls: string[] = [];
        const runtime = yield* makeHarness({ calls, canonical });
        const failure = yield* Effect.flip(
          runtime.start({
            operationId: "stale-operation",
            threadId: "thread-1",
            destinationHostId: null,
            expectedDestination,
            followUpPrompt: null,
          }),
        );
        assert.include(failure.message, "execution location changed");
        assert.deepEqual(calls, []);
        assert.isNull(yield* runtime.get("stale-operation"));
      }
    }),
  );

  it.effect("reconciles a lost destination commit reply before deleting prepared files", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const runtime = yield* makeHarness({ calls, loseCommitReply: true });
      const entry = yield* start(runtime);
      assert.strictEqual(entry.phase, "failed");
      assert.isFalse(entry.coreCommitted);
      assert.isFalse((yield* runtime.get(entry.operationId))?.recoveryRequired);
      assert.isBelow(calls.indexOf("core:source"), calls.indexOf("git:rollback"));
      assert.isBelow(calls.indexOf("git:rollback"), calls.indexOf("cleanup:rolled-back"));
      assert.notInclude(calls, "follow-up");
    }),
  );

  it.effect("retains prepared files when canonical location is unavailable or ambiguous", () =>
    Effect.gen(function* () {
      for (const readFailureAfterCommit of ["unavailable", "ambiguous"] as const) {
        const calls: string[] = [];
        const runtime = yield* makeHarness({
          calls,
          loseCommitReply: true,
          readFailureAfterCommit,
        });
        const entry = yield* start(runtime);
        assert.strictEqual(entry.phase, "recovery-required");
        assert.isNull(entry.completedAt);
        assert.notInclude(calls, "runtime:source");
        assert.notInclude(calls, "git:rollback");
        assert.notInclude(calls, "cleanup:rolled-back");
        const operation = yield* runtime.get(entry.operationId);
        assert.strictEqual(operation?.status, "error");
        assert.isTrue(operation?.recoveryRequired);
        assert.isNull(operation?.completedAt);
        assert.include(operation?.message ?? "", "Prepared files are retained");
        assert.isTrue(Exit.isFailure(yield* Effect.exit(start(runtime, "another-operation"))));
        const restartCalls: string[] = [];
        const restarted = yield* makeHarness({
          calls: restartCalls,
          canonical: source,
          initial: [entry],
        });
        assert.strictEqual((yield* restarted.recover())[0]?.phase, "failed");
        assert.include(restartCalls, "git:rollback");
        assert.include(restartCalls, "cleanup:rolled-back");
        assert.isFalse((yield* restarted.get(entry.operationId))?.recoveryRequired);
      }
    }),
  );

  it.effect(
    "recovers a verified durable destination forward without rolling back its worktree",
    () =>
      Effect.gen(function* () {
        const initial = yield* makeHarness({
          calls: [],
          loseCommitReply: true,
          readFailureAfterCommit: "unavailable",
        });
        const retained = yield* start(initial);
        const calls: string[] = [];
        const restarted = yield* makeHarness({
          calls,
          canonical: destination,
          initial: [retained],
        });
        const entry = (yield* restarted.recover())[0]!;
        assert.strictEqual(entry.phase, "completed-with-warning");
        assert.notInclude(calls, "core:source");
        assert.notInclude(calls, "git:rollback");
        assert.notInclude(calls, "cleanup:rolled-back");
        assert.include(calls, "cleanup:committed");
        assert.include(calls, "follow-up");
        assert.isFalse((yield* restarted.get(entry.operationId))?.recoveryRequired);
      }),
  );

  it.effect("retains artifacts after runtime, Core, or Git rollback fails", () =>
    Effect.gen(function* () {
      for (const failAt of ["runtime:source", "core:source", "git:rollback"]) {
        const calls: string[] = [];
        const runtime = yield* makeHarness({ calls, failAt, loseCommitReply: true });
        const entry = yield* start(runtime);
        assert.strictEqual(entry.phase, "recovery-required", failAt);
        assert.isNull(entry.completedAt);
        assert.notInclude(calls, "cleanup:rolled-back");
        if (failAt !== "git:rollback") assert.notInclude(calls, "git:rollback");
        assert.isTrue((yield* runtime.get(entry.operationId))?.recoveryRequired);
      }
    }),
  );

  it.effect("treats incomplete Git restoration as recovery, not permission to clean files", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const runtime = yield* makeHarness({
        calls,
        failAt: "core:destination",
        rollbackWarnings: ["Source patch could not be restored"],
      });
      const entry = yield* start(runtime);
      assert.strictEqual(entry.phase, "recovery-required");
      assert.include(calls, "git:rollback");
      assert.notInclude(calls, "cleanup:rolled-back");
    }),
  );

  it.effect("checkpoints successful Git rollback so recovery retries only pending cleanup", () =>
    Effect.gen(function* () {
      const runtime = yield* makeHarness({
        calls: [],
        failAt: "core:destination",
        cleanupWarnings: ["Staging directory is busy"],
      });
      const entry = yield* start(runtime);
      assert.strictEqual(entry.phase, "recovery-required");
      assert.strictEqual(entry.failedPhase, "cleaning-rolled-back");
      const calls: string[] = [];
      const restarted = yield* makeHarness({ calls, canonical: source, initial: [entry] });
      const recovered = (yield* restarted.recover())[0]!;
      assert.strictEqual(recovered.phase, "failed");
      assert.notInclude(calls, "git:rollback");
      assert.include(calls, "cleanup:rolled-back");
      assert.isFalse((yield* restarted.get(entry.operationId))?.recoveryRequired);
    }),
  );

  it.effect(
    "a retained operation cannot be claimed by another chat, caller, host, or selection",
    () =>
      Effect.gen(function* () {
        const calls: string[] = [];
        const runtime = yield* makeHarness({ calls });
        const input = {
          operationId: "owned-operation",
          threadId: "thread-1",
          requestThreadId: "caller",
          destinationHostId: null,
          expectedDestination: "worktree" as const,
          followUpPrompt: null,
        };
        const recorded = yield* runtime.start(input);
        calls.length = 0;
        for (const changed of [
          { ...input, threadId: "other-thread" },
          { ...input, requestThreadId: "other-caller" },
          { ...input, requestThreadId: undefined },
          { ...input, destinationHostId: "remote" },
          { ...input, expectedDestination: "local" as const },
        ]) {
          assert.isTrue(Exit.isFailure(yield* Effect.exit(runtime.start(changed))));
          assert.isTrue(Exit.isFailure(yield* Effect.exit(runtime.launch(changed))));
        }
        assert.deepEqual(yield* runtime.start({ ...input, destinationHostId: "local" }), recorded);
        assert.strictEqual((yield* runtime.launch(input)).threadId, "thread-1");
        assert.deepEqual(calls, []);
        const restarted = yield* makeHarness({ calls, initial: [recorded] });
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(restarted.start({ ...input, threadId: "other-thread" })),
          ),
        );
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(restarted.launch({ ...input, requestThreadId: "other-caller" })),
          ),
        );
        assert.deepEqual(calls, []);
      }),
  );

  it.effect("reserves operation ownership while execution admission is still pending", () =>
    Effect.gen(function* () {
      const stopGate = yield* Deferred.make<void>();
      const calls: string[] = [];
      const runtime = yield* makeHarness({ calls, stopGate });
      const input = {
        operationId: "in-flight-operation",
        threadId: "thread-1",
        requestThreadId: "caller",
        destinationHostId: null,
        followUpPrompt: null,
      };
      const running = yield* Effect.forkChild(runtime.start(input), { startImmediately: true });
      yield* Effect.yieldNow;
      for (const changed of [
        { ...input, threadId: "other-thread" },
        { ...input, requestThreadId: "other-caller" },
      ]) {
        assert.isTrue(Exit.isFailure(yield* Effect.exit(runtime.start(changed))));
        assert.isTrue(Exit.isFailure(yield* Effect.exit(runtime.launch(changed))));
      }
      assert.deepEqual(calls, ["stop"]);
      yield* Deferred.succeed(stopGate, undefined);
      assert.strictEqual((yield* Fiber.join(running)).phase, "completed");
      assert.lengthOf(
        calls.filter((call) => call === "prepare"),
        1,
      );
    }),
  );

  it.effect("keeps execution sealed through incomplete rollback until verified recovery", () =>
    Effect.gen(function* () {
      const safety = { required: false, changes: [] as boolean[] };
      const runtime = yield* makeHarness({
        calls: [],
        failAt: "git:rollback",
        loseCommitReply: true,
        safety,
      });
      const entry = yield* start(runtime);
      assert.strictEqual(entry.phase, "recovery-required");
      assert.isTrue(safety.required);
      assert.notInclude(safety.changes, false);
      const restarted = yield* makeHarness({
        calls: [],
        initial: [entry],
        canonical: source,
        safety,
        onRead: () =>
          assert.isTrue(safety.required, "Recovery seals execution before reading Core"),
      });
      assert.strictEqual((yield* restarted.recover())[0]?.phase, "failed");
      assert.isFalse(safety.required);
      assert.strictEqual(safety.changes.at(-1), false);
    }),
  );

  it.effect(
    "an uncertain preparation remains recoverable even when Core still points to source",
    () =>
      Effect.gen(function* () {
        const safety = { required: false, changes: [] as boolean[] };
        const calls: string[] = [];
        const runtime = yield* makeHarness({ calls, preparationFailure: "uncertain", safety });
        const entry = yield* start(runtime);
        assert.strictEqual(entry.phase, "recovery-required");
        assert.strictEqual(entry.failedPhase, "preparing-destination");
        assert.deepEqual(entry.allocatedDestination, {
          hostId: "local",
          worktreeGitRoot: "/managed/task",
        });
        assert.isNull(entry.prepared);
        assert.isTrue(safety.required);
        assert.notInclude(calls, "git:rollback");
        assert.notInclude(calls, "cleanup:rolled-back");
        const restarted = yield* makeHarness({
          calls,
          initial: [entry],
          canonical: source,
          safety,
        });
        assert.strictEqual((yield* restarted.recover())[0]?.phase, "recovery-required");
        assert.isTrue(safety.required);
        assert.notInclude(safety.changes, false);
      }),
  );

  it.effect("a preparation owner may prove a preflight failure restored source safety", () =>
    Effect.gen(function* () {
      const safety = { required: false, changes: [] as boolean[] };
      const calls: string[] = [];
      const runtime = yield* makeHarness({ calls, preparationFailure: "restored", safety });
      const entry = yield* start(runtime);
      assert.strictEqual(entry.phase, "failed");
      assert.isFalse(safety.required);
      assert.notInclude(calls, "runtime:destination");
      assert.notInclude(calls, "git:rollback");
    }),
  );

  it.effect(
    "startup seals durable unfinished execution before restoring or reading its location",
    () =>
      Effect.gen(function* () {
        const safety = { required: false, changes: [] as boolean[] };
        const calls: string[] = [];
        let reads = 0;
        const runtime = yield* makeHarness({
          calls,
          safety,
          initial: [makeEntry()],
          onRead: () => {
            reads++;
            assert.isTrue(safety.required);
          },
        });
        yield* runtime.prepareRecovery;
        assert.isTrue(safety.required);
        assert.strictEqual(reads, 0);
        assert.deepEqual(calls, []);
        assert.notInclude(safety.changes, false);
      }),
  );

  it.effect(
    "reconciles nonterminal journal ownership once after synchronous recovery protection",
    () =>
      Effect.gen(function* () {
        const unfinished = makeEntry();
        const terminal: CodexThreadHandoffJournalEntry = {
          ...makeEntry(),
          operationId: "done",
          phase: "completed",
          completedAt: 3,
        };
        const reconciliations: Array<
          readonly { readonly threadId: string; readonly operationId: string }[]
        > = [];
        const runtime = yield* makeHarness({
          calls: [],
          initial: [unfinished, terminal],
          reconciliations,
        });
        yield* runtime.prepareRecovery;
        yield* runtime.prepareRecovery;
        assert.deepEqual(reconciliations, []);
        yield* runtime.recover();
        assert.deepEqual(reconciliations, [
          [{ threadId: unfinished.threadId, operationId: unfinished.operationId }],
        ]);
      }),
  );

  it.effect("an empty startup journal does not wait for background execution recovery", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const ready = yield* Deferred.make<void>();
      const reconciliations: Array<
        readonly { readonly threadId: string; readonly operationId: string }[]
      > = [];
      const runtime = yield* makeHarness({
        calls: [],
        reconciliations,
        reconcileStarted: started,
        reconcileGate: ready,
      });
      yield* runtime.prepareRecovery;
      assert.deepEqual(reconciliations, []);
      const first = yield* runtime.recover().pipe(Effect.forkChild);
      yield* Deferred.await(started);
      assert.deepEqual(reconciliations, [[]]);
      const second = yield* runtime.recover().pipe(Effect.forkChild);
      yield* Deferred.succeed(ready, undefined);
      assert.deepEqual(yield* Fiber.join(first), []);
      assert.deepEqual(yield* Fiber.join(second), []);
      assert.deepEqual(reconciliations, [[]]);
    }),
  );

  it.effect("persists and forwards the handoff admission ceiling", () =>
    Effect.gen(function* () {
      const modeLimits: unknown[] = [];
      const runtime = yield* makeHarness({ calls: [], modeLimits });
      const modeLimit = {
        runtimeMode: "approval-required" as const,
        interactionMode: "plan" as const,
      };
      const entry = yield* runtime.start({
        operationId: "limited-handoff",
        threadId: "thread-1",
        destinationHostId: null,
        followUpPrompt: "continue",
        modeLimit,
      });
      assert.deepEqual(entry.modeLimit, modeLimit);
      assert.deepEqual(modeLimits, [modeLimit]);
    }),
  );

  it.effect("refuses a follow-up before status, journal or physical handoff mutation", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const runtime = yield* makeHarness({ calls, failAt: "follow-up-admission" });
      const result = yield* runtime
        .launch({
          operationId: "forbidden-credit",
          threadId: "thread-1",
          destinationHostId: null,
          followUpPrompt: "Continue",
          followUpSender: { threadId: "outside", runId: "outside-run" },
        })
        .pipe(Effect.flip);
      assert.include(result.message, "Only the person");
      assert.deepEqual(calls, []);
      assert.isNull(yield* runtime.get("forbidden-credit"));
    }),
  );

  it.effect(
    "retains the requesting Thread and Run when a journaled handoff delivers its follow-up",
    () =>
      Effect.gen(function* () {
        const sender = { threadId: "outside", runId: "outside-run" };
        const followUpSenders: unknown[] = [];
        const runtime = yield* makeHarness({
          calls: [],
          followUpSenders,
          canonical: destination,
          initial: [
            {
              ...makeEntry(),
              phase: "cleaning-source",
              destination,
              runtimeSwitched: true,
              coreCommitted: true,
              followUpSender: sender,
            },
          ],
        });
        yield* runtime.recover();
        assert.deepEqual(followUpSenders, [sender]);
      }),
  );

  it.effect("captures the authenticated handoff caller before background execution", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const followUpSenders: unknown[] = [];
      const runtime = yield* makeHarness({ calls, followUpSenders });
      const result = yield* runtime
        .start({
          operationId: "authenticated-handoff",
          destinationHostId: null,
          threadId: "thread-1",
          requestThreadId: "status-correlation",
          followUpPrompt: "continue",
        })
        .pipe(
          Effect.provideService(CoreApplicationAgent, {
            authority: { thread_id: "actual-caller", turn_id: "actual-run" },
          } as never),
        );
      assert.deepEqual(result.followUpSender, { threadId: "actual-caller", runId: "actual-run" });
      assert.deepEqual(followUpSenders, [{ threadId: "actual-caller", runId: "actual-run" }]);
    }),
  );

  it.effect("does not infer an old handoff caller from its Thread's current model", () =>
    Effect.gen(function* () {
      const followUpSenders: unknown[] = [];
      const runtime = yield* makeHarness({
        calls: [],
        followUpSenders,
        canonical: destination,
        initial: [
          {
            ...makeEntry(),
            requestThreadId: "caller-without-original-run",
            phase: "cleaning-source",
            destination,
            runtimeSwitched: true,
            coreCommitted: true,
          },
        ],
      });
      const entries = yield* runtime.recover();
      assert.deepEqual(followUpSenders, []);
      assert.equal(entries[0]?.phase, "completed-with-warning");
      assert.include(entries[0]?.warnings.join(" "), "original caller is unavailable");
    }),
  );

  it.effect.each([destination.managedWorktreePath, null])(
    "commits a move from a missing working directory (%s) and reports only the relocation steps",
    (managedWorktreePath) =>
      Effect.gen(function* () {
        const calls: string[] = [];
        const canonical = { ...destination, managedWorktreePath };
        const runtime = yield* makeHarness({ calls, canonical, relocating: true });
        const input = {
          operationId: "move-local",
          threadId: "thread-1",
          destinationHostId: null,
          expectedDestination: "local" as const,
          expectedSource: "missing" as const,
          followUpPrompt: null,
        };
        const result = yield* runtime.start(input);
        assert.strictEqual(result.phase, "completed");
        assert.deepEqual(result.destination, source);
        const operation = yield* runtime.get(result.operationId);
        assert.strictEqual(operation?.strategy, "relocate");
        assert.deepEqual(
          operation?.steps.map(({ id }) => id),
          ["confirm-source-missing", "switching-thread"],
        );
        assert.deepEqual(yield* runtime.start(input), result);
        assert.deepEqual(calls, ["stop", "prepare", "runtime:destination", "core:destination"]);
      }),
  );

  it.effect("rolls back only execution metadata when a relocation's commit reply is lost", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const runtime = yield* makeHarness({
        calls,
        canonical: destination,
        relocating: true,
        loseCommitReply: true,
      });
      const result = yield* start(runtime);
      assert.strictEqual(result.phase, "failed");
      assert.isFalse(result.coreCommitted);
      assert.deepEqual(calls, [
        "stop",
        "prepare",
        "runtime:destination",
        "core:destination",
        "runtime:source",
        "core:source",
      ]);
    }),
  );

  it.effect("recovers relocations from the durable location without Git compensation", () =>
    Effect.gen(function* () {
      const journal: CodexThreadHandoffJournalEntry = {
        ...makeEntry(),
        source: destination,
        destination: source,
        prepared: relocation.prepared,
        requestedDestination: "local",
        strategy: "relocate",
        preparationSteps: [{ id: "confirm-source-missing", status: "success", updatedAt: 2 }],
        followUpPrompt: null,
      };
      const persisted = parseCodexThreadHandoffJournal(
        JSON.stringify({ schemaVersion: 1, entries: [journal] }),
      );
      assert.deepEqual(persisted, [journal]);
      for (const [canonical, phase, call] of [
        [source, "completed", "runtime:destination"],
        [destination, "failed", "runtime:source"],
      ] as const) {
        const calls: string[] = [];
        const runtime = yield* makeHarness({
          calls,
          canonical,
          relocating: true,
          initial: persisted!,
        });
        assert.strictEqual((yield* runtime.recover())[0]?.phase, phase);
        assert.deepEqual(calls, [call]);
        assert.deepEqual(yield* runtime.recover(), []);
      }
    }),
  );

  it.effect("releases an interrupted inspection or relocation even if the source reappeared", () =>
    Effect.gen(function* () {
      for (const [phase, strategy, sourceMissing] of [
        ["inspecting-source", undefined, false],
        ["preparing-destination", "relocate", true],
        ["preparing-destination", "relocate", false],
        ["preparing-destination", "transfer", false],
      ] as const) {
        const calls: string[] = [];
        const safety = { required: false, changes: [] as boolean[] };
        const journal: CodexThreadHandoffJournalEntry = {
          ...makeEntry(),
          source: destination,
          destination: null,
          phase,
          ...(strategy ? { strategy } : {}),
          prepared: null,
          runtimeSwitched: false,
          coreCommitted: false,
        };
        const runtime = yield* makeHarness({
          calls,
          safety,
          initial: [journal],
          canonical: destination,
          relocating: sourceMissing,
        });
        const recovered = (yield* runtime.recover())[0];
        const unverifiedGit = strategy === "transfer";
        assert.equal(recovered?.phase, unverifiedGit ? "recovery-required" : "failed");
        assert.equal(safety.required, unverifiedGit);
        assert.isEmpty(calls);
      }
    }),
  );

  it.effect(
    "checks source intent under the hold before stopping execution and compares replays",
    () =>
      Effect.gen(function* () {
        const safety = { required: false, changes: [] as boolean[] };
        const calls: string[] = [];
        const runtime = yield* makeHarness({
          calls,
          safety,
          canonical: destination,
          relocating: true,
          selectStrategy: (entry) =>
            Effect.suspend(() => {
              assert.isTrue(safety.required);
              assert.equal(entry.expectedSource, "missing");
              return Effect.fail(
                new ManagedWorktreeHandoffError({
                  operation: "inspect-source",
                  threadId: entry.threadId,
                  cause: new Error("Chat execution location changed. Reopen the location menu."),
                }),
              );
            }),
        });
        const request = {
          operationId: "stale-source",
          threadId: "thread-1",
          destinationHostId: null,
          followUpPrompt: null,
          expectedDestination: "local",
          expectedSource: "missing",
        } as const;
        const entry = yield* runtime.start(request);
        assert.equal(entry.phase, "failed");
        assert.include(entry.lastError ?? "", "Chat execution location changed.");
        assert.isFalse(safety.required);
        assert.isEmpty(calls);
        assert.equal((yield* runtime.start(request)).operationId, entry.operationId);
        assert.include(
          (yield* Effect.flip(runtime.start({ ...request, expectedSource: "present" }))).message,
          "destination intent",
        );
      }),
  );
});

describe("CrossHostThreadHandoff", () => {
  const run = promisify(execFile);

  const git = (cwd: string, ...args: string[]): Effect.Effect<string> =>
    Effect.tryPromise(async () =>
      (await run("git", args, { cwd, env: process.env })).stdout.trim(),
    ).pipe(Effect.orDie);

  const workerRequest = (hostId: string): ExecutionHost["request"] =>
    ((request: CodexWorktreeWorkerRequest, options) =>
      Effect.gen(function* () {
        const events: CodexWorktreeWorkerEvent[] = [];
        const success = yield* Effect.tryPromise({
          try: (signal) =>
            executeCodexWorktreeWorkerOperation(request, {
              signal,
              onEvent: (event) => events.push(event),
            }),
          catch: (cause) =>
            new ExecutionHostRuntimeError({
              operation: `worktree-${request.operation}`,
              hostId,
              cause,
            }),
        });
        yield* Effect.forEach(events, (event) => options?.onEvent?.(event) ?? Effect.void, {
          discard: true,
        });
        if (success.operation !== request.operation) {
          return yield* Effect.die(new Error("Worktree worker result mismatch"));
        }
        return success.value;
      })) as ExecutionHost["request"];

  const makeHost = (input: {
    readonly id: string;
    readonly codexHome: string;
    readonly repository: string;
    readonly root: string;
    readonly relayBaseRoot: string;
  }): ExecutionHost => {
    const stagingRoot = path.join(input.codexHome, "nodex-handoffs");
    const port = new CodexLocalExecutionHostFileTransfer({
      hostId: input.id,
      stagingRoot,
      allowedReadRoots: [input.codexHome, input.relayBaseRoot],
    });
    const transferError = (operation: string, cause: unknown) =>
      new ExecutionHostRuntimeError({ operation, hostId: input.id, cause });
    return {
      descriptor: {
        hostId: input.id,
        displayName: input.id,
        kind: "local",
        nodexHome: path.join(input.root, "nodex-home"),
        codexHome: input.codexHome,
        managedRoot: path.join(input.root, "worktrees"),
        handoffStagingRoot: stagingRoot,
        repositoryRoots: [input.repository],
        capabilities: [
          "export-handoff",
          "resolve-handoff-repository",
          "import-handoff",
          "cleanup-transfer-handoff",
        ],
        supportsFileTransfer: true,
      },
      request: workerRequest(input.id),
      transfer: {
        describe: (sourcePath) =>
          Effect.tryPromise({
            try: (signal) => port.describe(sourcePath, signal),
            catch: (cause) => transferError("describe", cause),
          }),
        download: (download) =>
          Effect.tryPromise({
            try: (signal) => port.download({ ...download, signal }),
            catch: (cause) => transferError("download", cause),
          }),
        upload: (upload) =>
          Effect.tryPromise({
            try: (signal) => port.upload({ ...upload, signal }),
            catch: (cause) => transferError("upload", cause),
          }),
        cleanup: (operationId) =>
          Effect.tryPromise({
            try: () => port.cleanup(operationId),
            catch: (cause) => transferError("cleanup", cause),
          }),
      },
    };
  };

  const relaySelectedRollout = (selection: "shared-home" | "account-home") =>
    Effect.gen(function* () {
      const root = yield* Effect.tryPromise(() =>
        mkdtemp(path.join(tmpdir(), "nodex-cross-host-capability-")),
      );
      yield* Effect.addFinalizer(() =>
        Effect.tryPromise(() => rm(root, { recursive: true, force: true })).pipe(Effect.ignore),
      );
      const bare = path.join(root, "origin.git");
      const source = path.join(root, "source", "repository");
      const destination = path.join(root, "destination", "renamed-repository");
      yield* Effect.tryPromise(() =>
        Promise.all([
          mkdir(path.dirname(source), { recursive: true }),
          mkdir(path.dirname(destination), { recursive: true }),
        ]),
      );
      yield* git(root, "init", "--bare", bare);
      yield* git(root, "clone", bare, source);
      yield* git(source, "config", "user.name", "Nodex Test");
      yield* git(source, "config", "user.email", "nodex@example.test");
      yield* Effect.tryPromise(() => writeFile(path.join(source, "tracked.txt"), "base\n"));
      yield* git(source, "add", ".");
      yield* git(source, "commit", "-m", "base");
      yield* git(source, "push", "origin", "HEAD:main");
      yield* git(root, "clone", "--branch", "main", bare, destination);
      yield* Effect.tryPromise(() => writeFile(path.join(source, "tracked.txt"), "moved\n"));
      yield* Effect.tryPromise(() => writeFile(path.join(source, "untracked.txt"), "untracked\n"));

      const relayBaseRoot = path.join(root, "main-private", "handoffs");
      const sourceCodexHome = path.join(root, "source", "codex-home");
      const destinationCodexHome = path.join(root, "destination", "codex-home");
      const sourceRolloutPath = path.join(
        sourceCodexHome,
        "sessions",
        "2026",
        "08",
        "14",
        "thread.jsonl",
      );
      yield* Effect.tryPromise(() => mkdir(path.dirname(sourceRolloutPath), { recursive: true }));
      yield* Effect.tryPromise(() =>
        writeFile(sourceRolloutPath, '{"type":"session_meta","id":"thread"}\n'),
      );
      const accountHome = path.join(root, "source", "account-home");
      yield* Effect.tryPromise(() => mkdir(accountHome, { recursive: true }));
      yield* Effect.tryPromise(() =>
        symlink(path.join(sourceCodexHome, "sessions"), path.join(accountHome, "sessions"), "dir"),
      );
      const selectedRolloutPath =
        selection === "shared-home"
          ? sourceRolloutPath
          : path.join(accountHome, path.relative(sourceCodexHome, sourceRolloutPath));

      const hosts = [
        makeHost({
          id: "source",
          codexHome: sourceCodexHome,
          repository: source,
          root: path.join(root, "source"),
          relayBaseRoot,
        }),
        makeHost({
          id: "destination",
          codexHome: destinationCodexHome,
          repository: destination,
          root: path.join(root, "destination"),
          relayBaseRoot,
        }),
      ];
      const hostById = new Map(hosts.map((host) => [host.descriptor.hostId, host]));
      const activeSshHosts = yield* SubscriptionRef.make<
        ReadonlyMap<string, CodexSshExecutionHostConfig>
      >(new Map());
      const executionHosts = ExecutionHostRuntime.of({
        activeSshHosts,
        hosts: () => Effect.succeed(hosts.map((host) => host.descriptor)),
        get: (hostId) => Effect.succeed(hostById.get(hostId) ?? null),
        resolve: (hostId) => {
          const host = hostById.get(hostId);
          return host
            ? Effect.succeed(host)
            : Effect.fail(
                new ExecutionHostRuntimeError({
                  operation: "resolve-host",
                  hostId,
                  cause: new Error("unknown host"),
                }),
              );
        },
        updateLocalManagedRoot: () => Effect.void,
        settings: Effect.succeed({ sshHosts: [] }),
        updateSettings: () => Effect.succeed({ sshHosts: [] }),
        reconcile: () => Effect.void,
      });
      const newborns = new Set<string>();
      const managed = ManagedWorktreeRuntime.of({
        list: () => Effect.die("unused"),
        inspect: () => Effect.die("unused"),
        remove: () => Effect.die("unused"),
        restore: () => Effect.die("unused"),
        setOwner: () => Effect.die("unused"),
        registerNewborn: (input) =>
          Effect.sync(() => newborns.add(`${input.hostId}\0${input.worktreeGitRoot}`)).pipe(
            Effect.asVoid,
          ),
        releaseNewborn: (input) =>
          Effect.sync(() => newborns.delete(`${input.hostId}\0${input.worktreeGitRoot}`)).pipe(
            Effect.asVoid,
          ),
        isNewborn: (input) =>
          Effect.sync(() => newborns.has(`${input.hostId}\0${input.worktreeGitRoot}`)),
        newborns: Effect.sync(() =>
          [...newborns].map((entry) => {
            const [hostId, worktreeGitRoot] = entry.split("\0");
            return { hostId: hostId!, worktreeGitRoot: worktreeGitRoot! };
          }),
        ),
      });
      const scope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(
        crossHostThreadHandoffLive({ relayBaseRoot }).pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(ExecutionHostRuntime, executionHosts),
              Layer.succeed(ManagedWorktreeRuntime, managed),
              NodeFileSystem.layer,
            ),
          ),
        ),
        scope,
      );
      const handoff = Context.get(context, CrossHostThreadHandoff);
      const input = {
        operationId: "transfer-1",
        threadId: "thread",
        threadTitle: "Cross host",
        projectId: "project",
        sourceHostId: "source",
        destinationHostId: "destination",
        sourceCwd: source,
        sourceWorkspaceRoot: source,
        sourceManagedWorktreePath: null,
        sourceRolloutPath: selectedRolloutPath,
        destinationRepositoryPaths: [destination],
      };
      if (selection === "account-home") {
        const outside = path.join(root, "outside");
        yield* Effect.tryPromise(() => mkdir(outside));
        yield* Effect.tryPromise(() => writeFile(path.join(outside, "escape.jsonl"), "outside\n"));
        yield* Effect.tryPromise(() => symlink(outside, path.join(accountHome, "escaped"), "dir"));
        const escaped = yield* Effect.flip(
          handoff.prepare({
            ...input,
            operationId: "transfer-directory-escape",
            sourceRolloutPath: path.join(accountHome, "escaped", "escape.jsonl"),
          }),
        );
        assert.strictEqual(escaped.operation, "resolve-rollout");
        const traversed = yield* Effect.flip(
          handoff.prepare({
            ...input,
            operationId: "transfer-parent-traversal",
            sourceRolloutPath: `${sourceCodexHome}/../../outside/escape.jsonl`,
          }),
        );
        assert.strictEqual(traversed.operation, "resolve-rollout");

        const leafLink = path.join(path.dirname(selectedRolloutPath), "leaf-link.jsonl");
        yield* Effect.tryPromise(() => symlink(sourceRolloutPath, leafLink));
        const linked = yield* Effect.flip(
          handoff.prepare({
            ...input,
            operationId: "transfer-file-symlink",
            sourceRolloutPath: leafLink,
          }),
        );
        assert.strictEqual(linked.operation, "describe-rollout");
        assert.isFalse(newborns.size > 0);
      }
      const prepared = yield* handoff.prepare(input);

      const [allocation, name, ...nested] = path
        .relative(path.join(root, "destination", "worktrees"), prepared.managedWorktreePath)
        .split(path.sep);
      assert.match(allocation!, /^[0-9a-f]{12}$/u);
      assert.strictEqual(name, "renamed-repository");
      assert.deepEqual(nested, []);
      assert.strictEqual(prepared.sourceRollout.path, sourceRolloutPath);
      assert.strictEqual(
        prepared.destinationRollout.path,
        path.join(destinationCodexHome, path.relative(sourceCodexHome, sourceRolloutPath)),
      );

      assert.isTrue(newborns.has(`destination\0${prepared.managedWorktreePath}`));
      assert.strictEqual(
        yield* Effect.tryPromise(() =>
          readFile(path.join(prepared.destinationWorkspaceRoot, "tracked.txt"), "utf8"),
        ),
        "moved\n",
      );
      assert.strictEqual(
        yield* Effect.tryPromise(() => readFile(prepared.destinationRollout.path, "utf8")),
        '{"type":"session_meta","id":"thread"}\n',
      );

      assert.deepEqual(yield* handoff.cleanup(prepared, "committed"), []);
      assert.isFalse(newborns.has(`destination\0${prepared.managedWorktreePath}`));
      assert.strictEqual(
        yield* Effect.tryPromise(() =>
          readFile(path.join(prepared.destinationWorkspaceRoot, "untracked.txt"), "utf8"),
        ),
        "untracked\n",
      );
      assert.isTrue(
        Exit.isFailure(yield* Effect.exit(git(source, "rev-parse", prepared.sourceTemporaryRef))),
      );
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(git(destination, "rev-parse", prepared.destinationTemporaryRef)),
        ),
      );
      yield* Scope.close(scope, Exit.void);
    });

  it.effect.each(["shared-home", "account-home"] as const)(
    "atomically relays %s rollout state and releases newborn protection",
    relaySelectedRollout,
  );
});
