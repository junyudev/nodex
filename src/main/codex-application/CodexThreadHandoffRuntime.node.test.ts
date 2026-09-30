import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { assert, it } from "@effect/vitest";
import type { CodexSshExecutionHostConfig } from "../../shared/types";
import type {
  CodexThreadExecutionLocation,
  CodexThreadHandoffJournalEntry,
} from "../codex/codex-thread-handoff-journal";
import type { CodexThreadHandoffJournalStorage } from "../platform/CodexThreadHandoffJournalStorage";
import { ThreadExecution, ThreadExecutionError } from "../host-runtime/ThreadExecution";
import { ExecutionHostRuntime } from "./ExecutionHostRuntime";
import {
  ManagedWorktreeHandoff,
  ManagedWorktreeHandoffError,
  type ManagedWorktreeHandoffPreparation,
} from "./ManagedWorktreeHandoff";
import { make, type CodexThreadHandoffRuntime } from "./CodexThreadHandoffRuntime";

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
  readonly preparationFailure?: "restored" | "uncertain";
  readonly onRead?: () => void;
}) =>
  Effect.gen(function* () {
    const executionHosts = yield* makeExecutionHosts;
    let canonical = input.canonical ?? source;
    let destinationCommitAttempted = false;
    let handoffActive = false;
    const safety = input.safety ?? { required: false, changes: [] };
    const isSource = (location: CodexThreadExecutionLocation) => location.cwd === source.cwd;
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
      setRecoveryRequired: (_threadId, required) =>
        Effect.sync(() => {
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
      withHandoff: (_threadId, use) =>
        Effect.acquireUseRelease(
          Effect.sync(() => {
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
      followUp: () =>
        Effect.suspend(() => {
          assert.isFalse(
            handoffActive,
            "Follow-up must be admitted after the handoff guard releases",
          );
          assert.isFalse(safety.required, "Follow-up requires verified recovery");
          return record("follow-up");
        }),
    });
    const handoff = ManagedWorktreeHandoff.of({
      prepare: (_entry, onProgress) =>
        Effect.gen(function* () {
          input.calls.push("prepare");
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
    const runtime = yield* makeHarness({ calls });
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
      const runtime = yield* makeHarness({ calls, loseCommitReply: true, readFailureAfterCommit });
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

it.effect("recovers a verified durable destination forward without rolling back its worktree", () =>
  Effect.gen(function* () {
    const initial = yield* makeHarness({
      calls: [],
      loseCommitReply: true,
      readFailureAfterCommit: "unavailable",
    });
    const retained = yield* start(initial);
    const calls: string[] = [];
    const restarted = yield* makeHarness({ calls, canonical: destination, initial: [retained] });
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
        Exit.isFailure(yield* Effect.exit(restarted.start({ ...input, threadId: "other-thread" }))),
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
      onRead: () => assert.isTrue(safety.required, "Recovery seals execution before reading Core"),
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
      const restarted = yield* makeHarness({ calls, initial: [entry], canonical: source, safety });
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
