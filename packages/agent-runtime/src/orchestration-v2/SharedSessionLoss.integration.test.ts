import { assert, it, vi } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderFailure,
} from "@nodex/runtime-contracts";
import * as ProviderAdapter from "@nodex/provider-core/server/ProviderAdapter";
import { checkpointWorkspace } from "@nodex/provider-testing/replayWorkspace";
import * as DateTime from "effect/DateTime";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { SqlError, UnknownError } from "effect/sql/SqlError";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { delegatedTaskExecutionState } from "./DelegatedTaskState.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { recoveryEffectId } from "./RunRecovery.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const parentThreadId = ThreadId.make("thread:shared-session-loss:parent");
const childInstanceId = ProviderInstanceId.make("codex");
const parentInstanceId = ProviderInstanceId.make("claude-code");
const childSelection = { instanceId: childInstanceId, model: "gpt-6.1-sol" };
type Turn = ProviderAdapter.ProviderAdapterV2TurnInput;
type Services =
  | Orchestrator.OrchestratorV2
  | EffectWorker.OrchestrationEffectWorkerV2
  | EffectOutbox.EffectOutboxV2
  | EventSink.EventSinkV2
  | ProjectionStore.ProjectionStoreV2;

const waitEvent = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
  EventSink.EventSinkV2.use((sink) =>
    sink.stream({ afterSequence: 0 }).pipe(
      Stream.filter(({ event }) => predicate(event)),
      Stream.take(1),
      Stream.runDrain,
    ),
  );

// The real session manager owns fan-out, release, and re-open. Only the native
// provider boundary is fake: one failed stream stands for one dead process.
const withSharedSession = <A, E>(
  test: (fixture: {
    readonly children: Turn[];
    readonly starts: Turn[];
    readonly crash: () => Effect.Effect<boolean>;
    readonly rejectReopen: (permanent?: boolean) => void;
    readonly emit: (event: ProviderAdapter.ProviderAdapterV2Event) => Effect.Effect<boolean>;
  }) => Effect.Effect<A, E, Services>,
  options: {
    readonly unconfirmedStarts?: boolean;
    readonly reopenFailure?: "open" | "resume";
    readonly reopenProcessExit?: boolean;
  } = {},
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("shared-session-loss");
      const starts: Turn[] = [];
      const entered = yield* Queue.unbounded<Turn>();
      let crash = () => Effect.succeed(false);
      let rejectReopen = false;
      let permanentReopenFailure = false;
      let childOpens = 0;
      let emit = (_event: ProviderAdapter.ProviderAdapterV2Event) => Effect.succeed(false);
      const adapter = (
        instanceId: ProviderInstanceId,
      ): ProviderAdapter.ProviderAdapterV2["Service"] => {
        const child = instanceId === childInstanceId;
        const driver = ProviderDriverKind.make(child ? "codex" : "claude-code");
        const capabilities = {
          ...CodexProviderCapabilitiesV2,
          turns: {
            ...CodexProviderCapabilitiesV2.turns,
            supportsActiveSteering: child,
            supportsSteeringByInterruptRestart: child,
            supportsInterrupt: child,
          },
        };
        return {
          instanceId,
          driver,
          getCapabilities: () => Effect.succeed(capabilities),
          planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
          openSession: (input) =>
            Effect.gen(function* () {
              if (child && rejectReopen && options.reopenFailure !== "resume")
                return yield* new ProviderAdapter.ProviderAdapterOpenSessionError({
                  driver,
                  providerSessionId: input.providerSessionId,
                  cause: options.reopenProcessExit
                    ? new CodexErrors.CodexAppServerProcessExitedError({ code: 1 })
                    : new Error("Replacement app-server failed to spawn"),
                  ...(permanentReopenFailure ? { retryable: false } : {}),
                });
              if (child) childOpens++;
              const now = yield* DateTime.now;
              const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
              if (child) emit = (event) => Queue.offer(events, event);
              const died = yield* Deferred.make<
                void,
                ProviderAdapter.ProviderAdapterEventStreamError
              >();
              if (child)
                crash = () =>
                  Deferred.fail(
                    died,
                    new ProviderAdapter.ProviderAdapterEventStreamError({
                      driver,
                      providerSessionId: input.providerSessionId,
                      cause: "Shared app-server exited during active turns",
                    }),
                  );
              return {
                instanceId,
                driver,
                providerSessionId: input.providerSessionId,
                providerSession: {
                  id: input.providerSessionId,
                  driver,
                  providerInstanceId: instanceId,
                  status: "ready",
                  cwd,
                  model: input.modelSelection.model,
                  capabilities,
                  createdAt: now,
                  updatedAt: now,
                  lastError: null,
                },
                events: Stream.merge(
                  Stream.fromQueue(events),
                  Stream.fromEffect(Deferred.await(died)).pipe(Stream.drain),
                ),
                ensureThread: ({ threadId }) =>
                  Effect.succeed({
                    id: ProviderThreadId.make(`provider-thread:${threadId}`),
                    driver,
                    providerInstanceId: instanceId,
                    providerSessionId: input.providerSessionId,
                    appThreadId: threadId,
                    ownerNodeId: null,
                    nativeThreadRef: { driver, nativeId: `native:${threadId}`, strength: "strong" },
                    nativeConversationHeadRef: null,
                    status: "idle",
                    firstRunOrdinal: null,
                    lastRunOrdinal: null,
                    handoffIds: [],
                    forkedFrom: null,
                    createdAt: now,
                    updatedAt: now,
                  }),
                resumeThread: ({ providerThread }) =>
                  child && rejectReopen && options.reopenFailure === "resume"
                    ? Effect.fail(
                        new ProviderAdapter.ProviderAdapterResumeThreadError({
                          driver,
                          providerSessionId: input.providerSessionId,
                          providerThreadId: providerThread.id,
                          cause: options.reopenProcessExit
                            ? new CodexErrors.CodexAppServerProcessExitedError({ code: 1 })
                            : new Error("The Agent could not resume the conversation"),
                          ...(permanentReopenFailure ? { retryable: false } : {}),
                        }),
                      )
                    : Effect.succeed(providerThread),
                startTurn: (turn) =>
                  Effect.gen(function* () {
                    starts.push(turn);
                    yield* Queue.offer(entered, turn);
                    if (child && options.unconfirmedStarts)
                      return yield* Deferred.await(died).pipe(
                        Effect.mapError(
                          () =>
                            new ProviderAdapter.ProviderAdapterTurnStartError({
                              driver,
                              threadId: turn.threadId,
                              providerThreadId: turn.providerThread.id,
                              runId: turn.runId,
                              cause: new CodexErrors.CodexAppServerProcessExitedError({ code: 0 }),
                            }),
                        ),
                      );
                    yield* Queue.offer(events, {
                      type: "provider_turn.updated",
                      driver,
                      providerTurn: {
                        id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
                        providerThreadId: turn.providerThread.id,
                        nodeId: turn.rootNodeId,
                        runAttemptId: turn.attemptId,
                        nativeTurnRef: {
                          driver,
                          nativeId: `native:${turn.attemptId}`,
                          strength: "strong",
                        },
                        ordinal: turn.providerTurnOrdinal,
                        status: "running",
                        startedAt: yield* DateTime.now,
                        completedAt: null,
                      },
                    });
                  }),
                reconcileTurn: () =>
                  Effect.succeed({
                    status: "process_gone",
                    events: [],
                  }),
                interruptTurn: () => Effect.void,
                steerTurn: () => Effect.die("Parent completion must be queued"),
                respondToRuntimeRequest: () => Effect.die("unused"),
                readThreadSnapshot: () => Effect.die("unused"),
                rollbackThread: () => Effect.die("unused"),
                forkThread: () => Effect.die("unused"),
              };
            }),
        };
      };
      const registry = ProviderAdapterRegistry.layerFromAdapters([
        adapter(parentInstanceId),
        adapter(childInstanceId),
      ]);
      const layer = ProviderReplayHarness.layerWithRegistry(
        { name: "shared-session-loss", runtimePolicyOverride: { cwd } },
        registry,
        { runEffectWorker: false, runContinuationWorker: true },
      );
      return yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create:parent"),
          threadId: parentThreadId,
          projectId: ProjectId.make("project:shared-session-loss"),
          title: "Parent",
          modelSelection: { instanceId: parentInstanceId, model: "claude-test" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("message:parent"),
          threadId: parentThreadId,
          messageId: MessageId.make("message:parent"),
          text: "Delegate parallel research",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();
        const parent = yield* Queue.take(entered);
        yield* waitEvent(
          (event) =>
            event.type === "provider-turn.updated" &&
            event.payload.runAttemptId === parent.attemptId,
        );
        for (let index = 0; index < 2; index++)
          yield* orchestrator.dispatch({
            type: "delegated_task.request",
            commandId: CommandId.make(`delegate:${index}`),
            parentThreadId,
            parentRunId: parent.runId,
            parentNodeId: parent.rootNodeId,
            task: `Research task ${index}`,
            modelSelection: childSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            completionWake: "always",
            createdBy: "agent",
            creationSource: "mcp",
          });
        const draining = yield* Effect.all([worker.drain(), worker.drain()], {
          concurrency: 2,
        }).pipe(Effect.forkChild);
        const children = [yield* Queue.take(entered), yield* Queue.take(entered)];
        if (!options.unconfirmedStarts) {
          yield* Fiber.join(draining);
          for (const child of children)
            yield* waitEvent(
              (event) =>
                event.type === "provider-turn.updated" &&
                event.payload.runAttemptId === child.attemptId &&
                event.payload.status === "running",
            );
        }
        assert.equal(childOpens, 1, "both tasks must share one app-server incarnation");
        assert.equal(
          children[0]!.providerThread.providerSessionId,
          children[1]!.providerThread.providerSessionId,
        );
        assert.equal(
          children[0]!.providerThread.providerSessionId,
          "provider-session:provider-instance:codex:shared",
        );
        return yield* test({
          children,
          starts,
          emit: (event) => emit(event),
          crash: () => crash(),
          rejectReopen: (permanent = false) => {
            rejectReopen = true;
            permanentReopenFailure = permanent;
          },
        });
      }).pipe(Effect.provide(layer));
    }),
  );

const assertRecovering = (children: Turn[]) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    for (const child of children) {
      yield* waitEvent(
        (event) =>
          event.type === "run.updated" &&
          event.payload.id === child.runId &&
          event.payload.recovery !== undefined,
      );
      const projection = yield* orchestrator.getThreadProjection(child.threadId);
      const run = projection.runs.find((candidate) => candidate.id === child.runId)!;
      assert.equal(run.status, "running");
      assert.equal(run.recovery?.kind, "process_lost");
      assert.equal(run.recovery?.failure.code, "provider_process_exited");
      const attempt = projection.attempts.find(
        (candidate) => candidate.id === run.activeAttemptId,
      )!;
      assert.equal(attempt.status, "failed");
      const timer = yield* outbox.get(recoveryEffectId(run.id, attempt.attemptOrdinal + 1));
      assert.ok(Option.isSome(timer));
      assert.equal(timer.value.status, "pending");
      const taskId = (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.find(
        (task) => task.childThreadId === child.threadId,
      )!.id;
      yield* waitEvent(
        (event) =>
          event.type === "subagent.updated" &&
          event.payload.id === taskId &&
          event.payload.recovery?.attempt === run.recovery?.attempt,
      );
      const parent = yield* orchestrator.getThreadProjection(parentThreadId);
      const task = parent.subagents.find((candidate) => candidate.id === taskId)!;
      assert.equal(task.origin, "app_owned");
      assert.equal(task.status, "running");
      assert.isNull(task.result);
      assert.equal(task.recovery?.kind, "process_lost");
      // This is the same state owner used by MCP task_status; workState is derived,
      // rather than persisted on the parent subagent row.
      assert.equal(
        delegatedTaskExecutionState({ task, childRun: run, latestRun: run, resultPending: true })
          .workState,
        "recovering",
      );
      assert.equal(
        parent.messages.filter((message) => message.delegatedCompletion !== undefined).length,
        0,
      );
    }
  });

const assertParentWoken = (children: Turn[]) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    for (const child of children) {
      const taskId = (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.find(
        (task) => task.childThreadId === child.threadId,
      )!.id;
      yield* waitEvent(
        (event) =>
          event.type === "subagent.updated" &&
          event.payload.id === taskId &&
          event.payload.status === "failed",
      );
      yield* waitEvent(
        (event) =>
          event.type === "message.updated" &&
          event.threadId === parentThreadId &&
          event.payload.delegatedCompletion?.taskIds.includes(taskId) === true,
      );
    }
    const parent = yield* orchestrator.getThreadProjection(parentThreadId);
    assert.isTrue(
      parent.subagents.every(
        (task) => task.status === "failed" && task.result !== null && task.recovery == null,
      ),
    );
    const wakeMessages = parent.messages.filter(
      (message) => message.delegatedCompletion !== undefined,
    );
    assert.equal(wakeMessages.length, 1, "parallel failures coalesce into one parent wake");
    const wake = parent.runs.find((run) => run.userMessageId === wakeMessages[0]!.id)!;
    assert.equal(wake.status, "queued");
  });

it.effect(
  "recovers both shared-session tasks and wakes the parent after process-loss exhaustion",
  () =>
    withSharedSession(({ children, starts, crash }) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        yield* crash();
        yield* assertRecovering(children);
        const first = (yield* orchestrator.getThreadProjection(children[0]!.threadId)).runs[0]!;
        const maxAttempts = first.recovery!.maxAttempts!;
        for (let failure = 1; failure <= maxAttempts; failure++) {
          const current = children.map((child) =>
            starts.findLast((turn) => turn.runId === child.runId)!,
          );
          if (failure > 1) yield* assertRecovering(current);
          const run = (yield* orchestrator.getThreadProjection(children[0]!.threadId)).runs[0]!;
          assert.equal(run.recovery!.attempt, failure);
          yield* TestClock.adjust(
            DateTime.toEpochMillis(run.recovery!.nextAttemptAt) -
              DateTime.toEpochMillis(yield* DateTime.now),
          );
          yield* worker.drain();
          for (const child of children) {
            const turn = starts.findLast((turn) => turn.runId === child.runId)!;
            assert.notEqual(
              turn.attemptId,
              current.find((candidate) => candidate.runId === turn.runId)!.attemptId,
            );
            yield* waitEvent(
              (event) =>
                event.type === "provider-turn.updated" &&
                event.payload.runAttemptId === turn.attemptId &&
                event.payload.status === "running",
            );
          }
          yield* crash();
        }
        for (const child of children) {
          yield* waitEvent(
            (event) =>
              event.type === "run.updated" &&
              event.payload.id === child.runId &&
              event.payload.status === "failed",
          );
          const projection = yield* orchestrator.getThreadProjection(child.threadId);
          assert.equal(projection.runs.length, 1);
          assert.equal(projection.attempts.length, maxAttempts + 1);
        }
        yield* assertParentWoken(children);
      }),
    ),
);

const drainNextEffect = Effect.gen(function* () {
  const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
  const next = yield* worker.nextClaimableAt;
  assert.ok(Option.isSome(next), "unfinished work must own a durable continuation");
  yield* TestClock.adjust(
    Math.max(0, DateTime.toEpochMillis(next.value) - DateTime.toEpochMillis(yield* DateTime.now)),
  );
  yield* worker.drain();
});

it.effect.each(["open", "resume"] as const)(
  "recovers pre-start %s process exits until the process-loss budget is exhausted",
  (reopenFailure) =>
    withSharedSession(
      ({ children, crash, rejectReopen }) =>
        Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          yield* crash();
          yield* assertRecovering(children);
          const first = (yield* orchestrator.getThreadProjection(children[0]!.threadId)).runs[0]!;
          const maxAttempts = first.recovery!.maxAttempts!;
          rejectReopen();
          let observedPreStartRecovery = false;
          for (let retry = 0; retry < 40; retry++) {
            const runs = yield* Effect.forEach(children, (child) =>
              orchestrator
                .getThreadProjection(child.threadId)
                .pipe(Effect.map((projection) => projection.runs[0]!)),
            );
            if (runs.every((run) => run.status === "failed")) break;
            if (
              runs.some(
                (run) =>
                  run.recovery !== undefined &&
                  run.activeAttemptId !== first.activeAttemptId &&
                  run.recovery.attempt > 1,
              )
            ) {
              observedPreStartRecovery = true;
              assert.isTrue(runs.every((run) => run.recovery?.kind === "process_lost"));
              const parent = yield* orchestrator.getThreadProjection(parentThreadId);
              assert.isTrue(parent.subagents.every((task) => task.result === null));
              assert.equal(
                parent.messages.filter((message) => message.delegatedCompletion !== undefined)
                  .length,
                0,
              );
            }
            yield* drainNextEffect;
          }
          assert.isTrue(observedPreStartRecovery);
          for (const child of children) {
            const projection = yield* orchestrator.getThreadProjection(child.threadId);
            assert.equal(projection.runs[0]!.status, "failed");
            assert.equal(projection.attempts.length, maxAttempts + 1);
            assert.isTrue(projection.attempts.every((attempt) => attempt.status === "failed"));
            const failure = projection.turnItems.findLast((item) => item.type === "error");
            assert.ok(failure?.type === "error");
            assert.equal(failure.failure.code, "provider_process_exited");
          }
          yield* assertParentWoken(children);
        }),
      { reopenFailure, reopenProcessExit: true },
    ),
);

it.effect.each(["open", "resume"] as const)(
  "ends a delegated task immediately after an unexplained pre-start %s failure",
  (reopenFailure) =>
    withSharedSession(
      ({ children, crash, rejectReopen }) =>
        Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          yield* crash();
          yield* assertRecovering(children);
          rejectReopen();
          for (let retry = 0; retry < 6; retry++) {
            const runs = yield* Effect.forEach(children, (child) =>
              orchestrator
                .getThreadProjection(child.threadId)
                .pipe(Effect.map((projection) => projection.runs[0]!)),
            );
            if (runs.every((run) => run.status === "failed")) break;
            yield* drainNextEffect;
          }
          for (const child of children) {
            const projection = yield* orchestrator.getThreadProjection(child.threadId);
            assert.equal(projection.runs[0]!.status, "failed");
            assert.equal(projection.runs[0]!.recovery, undefined);
            assert.equal(projection.attempts.length, 2);
            const failure = projection.turnItems.findLast((item) => item.type === "error");
            assert.ok(failure?.type === "error");
            assert.isNull(failure.failure.code);
          }
          yield* assertParentWoken(children);
        }),
      { reopenFailure },
    ),
);

it.effect.each(["open", "resume"] as const)(
  "ends a delegated task when pre-start %s is explicitly unrecoverable",
  (reopenFailure) =>
    withSharedSession(
      ({ children, crash, rejectReopen }) =>
        Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          yield* crash();
          yield* assertRecovering(children);
          rejectReopen(true);
          yield* drainNextEffect;
          for (const child of children) {
            const projection = yield* orchestrator.getThreadProjection(child.threadId);
            assert.equal(projection.runs[0]!.status, "failed");
            assert.equal(projection.runs[0]!.recovery, undefined);
            const failure = projection.turnItems.findLast((item) => item.type === "error");
            assert.ok(failure?.type === "error");
            assert.equal(failure.failure.code, "native_session_unrecoverable");
            assert.isFalse(failure.failure.retryable);
          }
          yield* assertParentWoken(children);
        }),
      { reopenFailure },
    ),
);

it.effect(
  "also recovers both tasks when the shared process dies before turn-start acknowledgement",
  () =>
    withSharedSession(
      ({ children, crash }) =>
        Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          yield* crash();
          const observed = [];
          for (const child of children) {
            yield* waitEvent(
              (event) =>
                event.type === "run.updated" &&
                event.payload.id === child.runId &&
                (event.payload.status === "failed" || event.payload.recovery !== undefined),
            );
            const projection = yield* orchestrator.getThreadProjection(child.threadId);
            const run = projection.runs[0]!;
            const failure = projection.turnItems.findLast((item) => item.type === "error");
            observed.push({
              status: run.status,
              recovery: run.recovery?.kind ?? null,
              code: failure?.type === "error" ? failure.failure.code : null,
            });
          }
          // Desired contract: a process exit during start should not bypass Run recovery.
          assert.deepEqual(
            observed,
            children.map(() => ({
              status: "running",
              recovery: "process_lost",
              code: "provider_process_exited",
            })),
          );
        }),
      { unconfirmedStarts: true },
    ),
);

it.effect.each([1, 4])(
  "still delivers failed children after a transient terminal-reactor read failure (%s failures)",
  (failureCount) =>
    withSharedSession(({ children, emit }) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const read = projections.getRunMessage;
        const attempted = yield* Queue.unbounded<ThreadId>();
        const failures = new Map<ThreadId, number>();
        const spy = vi.spyOn(projections, "getRunMessage").mockImplementation((threadId, runId) => {
          const count = failures.get(threadId) ?? 0;
          if (!children.some((child) => child.threadId === threadId) || count >= failureCount)
            return read(threadId, runId);
          failures.set(threadId, count + 1);
          return Queue.offer(attempted, threadId).pipe(
            Effect.andThen(
              Effect.fail(
                new ProjectionStore.ProjectionStoreReadError({
                  threadId,
                  cause: new SqlError({
                    reason: new UnknownError({ cause: { code: "SQLITE_BUSY" } }),
                  }),
                }),
              ),
            ),
          );
        });
        try {
          yield* failChildren(children, emit);
          for (const _child of children) {
            for (let failure = 0; failure < failureCount; failure++) {
              yield* Queue.take(attempted);
              if (failure < 3) yield* TestClock.adjust(100 * 2 ** failure);
            }
          }
        } finally {
          spy.mockRestore();
        }
        const outcomes = yield* Effect.forEach(children, (child) =>
          orchestrator
            .getThreadProjection(child.threadId)
            .pipe(Effect.map((projection) => projection.runs[0]!.status)),
        );
        assert.deepEqual(outcomes, ["failed", "failed"]);
        yield* assertParentWoken(children);
      }),
    ),
);

const failChildren = (
  children: Turn[],
  emit: (event: ProviderAdapter.ProviderAdapterV2Event) => Effect.Effect<boolean>,
  failure: OrchestrationV2ProviderFailure = {
    class: "provider_error",
    code: "invalid_request",
    retryable: false,
    message: "The Agent rejected this request.",
  },
) =>
  Effect.forEach(
    children,
    (child) =>
      emit({
        type: "turn.terminal",
        driver: ProviderDriverKind.make("codex"),
        providerThreadId: child.providerThread.id,
        providerTurnId: ProviderTurnId.make(`provider-turn:${child.attemptId}`),
        runOrdinal: child.runOrdinal,
        failureItemOrdinal: child.providerTurnOrdinal * 100 + 99,
        status: "failed",
        threadDisposition: "reusable",
        failure,
      }),
    { discard: true },
  );

it.effect.each(["periodic", "error", "stopped"] as const)(
  "repairs missed parent finalization on the %s sweep without restarting",
  (trigger) =>
    withSharedSession(({ children, emit }) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const attempted = yield* Queue.unbounded<ThreadId>();
        const read = projections.getThread;
        const spy = vi.spyOn(projections, "getThread").mockImplementation((threadId) =>
          !children.some((child) => child.threadId === threadId)
            ? read(threadId)
            : Queue.offer(attempted, threadId).pipe(
                Effect.andThen(
                  Effect.fail(
                    new ProjectionStore.ProjectionStoreReadError({
                      threadId,
                      cause: "Injected terminal-reaction failure",
                    }),
                  ),
                ),
              ),
        );
        try {
          yield* failChildren(children, emit);
          for (const _child of children) yield* Queue.take(attempted);
          const stranded = yield* orchestrator.getThreadProjection(parentThreadId);
          assert.deepEqual(
            stranded.subagents.map((task) => task.status),
            ["running", "running"],
          );
        } finally {
          spy.mockRestore();
        }
        if (trigger === "periodic") {
          yield* TestClock.adjust("1 minute");
        } else {
          const child = yield* orchestrator.getThreadProjection(children[0]!.threadId);
          const session = child.providerSessions.find(
            (session) => session.id === children[0]!.providerThread.providerSessionId,
          )!;
          yield* (yield* EventSink.EventSinkV2).write({
            events: [
              {
                id: EventId.make(`session-recovery-signal:${trigger}`),
                type: "provider-session.updated",
                threadId: children[0]!.threadId,
                occurredAt: yield* DateTime.now,
                payload: { ...session, status: trigger, updatedAt: yield* DateTime.now },
              },
            ],
          });
        }
        yield* assertParentWoken(children);
        yield* TestClock.adjust("1 minute");
        yield* assertParentWoken(children);
      }),
    ),
);
