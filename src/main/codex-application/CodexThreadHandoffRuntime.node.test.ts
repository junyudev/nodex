import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { assert, it } from "@effect/vitest";
import type { CodexSshExecutionHostConfig } from "../../shared/types";
import type {
  CodexThreadExecutionLocation,
  CodexThreadHandoffJournalEntry,
} from "../codex/codex-thread-handoff-journal";
import type { CodexThreadHandoffJournalStorage } from "../platform/CodexThreadHandoffJournalStorage";
import { CodexThreadExecution, CodexThreadExecutionError } from "./CodexThreadExecution";
import { ExecutionHostRuntime } from "./ExecutionHostRuntime";
import {
  ManagedWorktreeHandoff,
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
}) =>
  Effect.gen(function* () {
    const executionHosts = yield* makeExecutionHosts;
    const record = (name: string): Effect.Effect<void, CodexThreadExecutionError> =>
      Effect.sync(() => input.calls.push(name)).pipe(
        Effect.asVoid,
        Effect.andThen(
          input.failAt === name
            ? Effect.fail(
                new CodexThreadExecutionError({
                  operation: name,
                  threadId: "thread-1",
                  cause: new Error(`${name} failed`),
                }),
              )
            : Effect.void,
        ),
      );
    const execution = CodexThreadExecution.of({
      read: () => Effect.succeed(input.canonical ?? source),
      stop: () =>
        record("stop").pipe(
          Effect.andThen(input.stopGate ? Deferred.await(input.stopGate) : Effect.void),
        ),
      switchRuntime: (_threadId, location) =>
        record(location === source ? "runtime:source" : "runtime:destination"),
      relocate: ({ location }) =>
        record(location === source ? "runtime:source" : "runtime:destination"),
      commit: (_threadId, location) =>
        record(location === source ? "core:source" : "core:destination"),
      followUp: () => record("follow-up"),
    });
    const handoff = ManagedWorktreeHandoff.of({
      prepare: () => Effect.sync(() => input.calls.push("prepare")).pipe(Effect.as(preparation)),
      transferOwner: () => Effect.sync(() => input.calls.push("owner")),
      rollback: () => Effect.sync(() => input.calls.push("git:rollback")).pipe(Effect.as([])),
      cleanup: (_threadId, _preparation, outcome) =>
        Effect.sync(() => input.calls.push(`cleanup:${outcome}`)).pipe(Effect.as([])),
    });
    const runtimeScope = yield* Scope.make();
    return yield* make({ storage: makeStorage(input.initial) }).pipe(
      Effect.provideService(CodexThreadExecution, execution),
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
