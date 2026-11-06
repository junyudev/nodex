import * as RuntimeRecovery from "./ProviderRuntimeRecoveryService.ts";
import { RuntimeModelPolicy, make as makeModelPolicy } from "../nodex/ModelPolicy.ts";
import { DEFAULT_MODEL_POLICY, setModelOn } from "../../../../src/shared/model-policy.ts";
import { assert, it, vi } from "@effect/vitest";
import {
  ChatAttachmentId,
  ChatFileAttachment,
  EnvironmentId,
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Threads from "./ThreadManagementService.ts";
import * as Tasks from "../mcp/OrchestratorMcpService.ts";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import { taskView } from "../mcp/toolkits/task/handlers.ts";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { SqlError, UnknownError } from "effect/sql/SqlError";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderRuntimeRecovery from "./ProviderRuntimeRecoveryService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { recoveryEffectId, hasPendingRunRecovery } from "./RunRecovery.ts";
import { endsTaskWait } from "./DelegatedTaskState.ts";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-model" };
type Turn = ProviderAdapter.ProviderAdapterV2TurnInput;
type Services =
  | Orchestrator.OrchestratorV2
  | EffectWorker.OrchestrationEffectWorkerV2
  | EffectOutbox.EffectOutboxV2
  | EventSink.EventSinkV2
  | ProjectionStore.ProjectionStoreV2
  | Tasks.OrchestratorMcpService;

const withRecovery = <A, E>(
  test: (input: {
    readonly started: Turn[];
    readonly interruptCalls: () => number;
    readonly emit: (event: ProviderAdapter.ProviderAdapterV2Event) => Effect.Effect<boolean>;
    readonly threadId: ThreadId;
  }) => Effect.Effect<A, E, Services | Scope.Scope>,
  options: {
    readonly empty?: boolean;
    readonly interrupt?: boolean;
    readonly restartSession?: boolean;
  } = {},
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("run-recovery");
      const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
      const started: Turn[] = [];
      let interrupts = 0;
      const capabilities = {
        ...CodexProviderCapabilitiesV2,
        turns: {
          ...CodexProviderCapabilitiesV2.turns,
          supportsEmptyContinuation: options.empty ?? true,
          supportsInterrupt: options.interrupt ?? true,
          supportsSteeringByInterruptRestart: options.interrupt ?? true,
        },
      };
      const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
        instanceId,
        driver,
        getCapabilities: () => Effect.succeed(capabilities),
        planSelectionTransition: () =>
          Effect.succeed(
            options.restartSession ? { type: "restart_session" } : { type: "apply_on_next_turn" },
          ),
        openSession: (input) =>
          Effect.gen(function* () {
            const now = yield* DateTime.now;
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
                model: modelSelection.model,
                capabilities,
                createdAt: now,
                updatedAt: now,
                lastError: null,
              },
              events: Stream.fromQueue(events),
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
              resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
              startTurn: (turn) =>
                Effect.gen(function* () {
                  started.push(turn);
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
              steerTurn: () => Effect.die("Recovery must not steer a failed native turn"),
              interruptTurn: () =>
                Effect.sync(() => {
                  interrupts++;
                }),
              respondToRuntimeRequest: () => Effect.void,
              readThreadSnapshot: () => Effect.die("unused"),
              rollbackThread: () => Effect.die("unused"),
              forkThread: () => Effect.die("unused"),
            };
          }),
      };
      const database = Sqlite.layerMemory;
      const registry = ProviderAdapterRegistry.layerFromAdapters([adapter]);
      const runtime = ProviderReplayHarness.layerWithRegistry(
        { name: "run-recovery", runtimePolicyOverride: { cwd } },
        registry,
        { runEffectWorker: false, runContinuationWorker: true, databaseLayer: database },
      );
      const threads = Layer.unwrap(
        Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          return Layer.mock(Threads.ThreadManagementService)({
            dispatch: orchestrator.dispatch,
            getTaskOwner: orchestrator.getTaskOwner,
            getThreadRecords: orchestrator.getThreadRecords,
            delegatedTaskResultPending: orchestrator.delegatedTaskResultPending,
          });
        }),
      ).pipe(Layer.provide(runtime));
      const tasks = Tasks.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            threads,
            registry,
            database,
            ProviderRegistryMock.layer(),
            ServerSettings.layerTest(),
            NodeServices.layer,
          ),
        ),
      );
      const layer = Layer.merge(runtime, tasks);
      return yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = ThreadId.make("thread:recovery");
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create"),
          threadId,
          projectId: ProjectId.make("project:recovery"),
          title: "Recovery",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("first"),
          threadId,
          messageId: MessageId.make("message:first"),
          text: "Original request",
          attachments: [
            ChatFileAttachment.make({
              type: "file",
              id: ChatAttachmentId.make("recovery-file-12345678-1234-1234-1234-123456789abc"),
              name: "notes.txt",
              mimeType: "text/plain",
              sizeBytes: 1,
            }),
          ],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();
        yield* waitEvent(
          (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
        );
        return yield* test({
          started,
          interruptCalls: () => interrupts,
          emit: (event) => Queue.offer(events, event),
          threadId,
        });
      }).pipe(Effect.provide(layer));
    }),
  );

const waitEvent = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
  EventSink.EventSinkV2.use((sink) =>
    sink.stream({ afterSequence: 0 }).pipe(
      Stream.filter(({ event }) => predicate(event)),
      Stream.take(1),
      Stream.runDrain,
    ),
  );

const failTurn = (
  emit: (event: ProviderAdapter.ProviderAdapterV2Event) => Effect.Effect<boolean>,
  turn: Turn,
  code = "serverOverloaded",
) =>
  Effect.gen(function* () {
    yield* waitEvent(
      (event) =>
        event.type === "provider-turn.updated" &&
        event.payload.runAttemptId === turn.attemptId &&
        event.payload.status === "running",
    );
    const projection = yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(
      turn.threadId,
    );
    const providerTurn = projection.providerTurns.find(
      (candidate) => candidate.runAttemptId === turn.attemptId,
    )!;
    yield* emit({
      type: "provider_turn.updated",
      driver,
      providerTurn: { ...providerTurn, status: "failed", completedAt: yield* DateTime.now },
    });
    yield* emit({
      type: "turn.terminal",
      driver,
      providerThreadId: turn.providerThread.id,
      providerTurnId: providerTurn.id,
      runOrdinal: turn.runOrdinal,
      failureItemOrdinal: turn.providerTurnOrdinal * 100 + 99,
      status: "failed",
      failure: { class: "provider_error", message: "Service busy", code, retryable: true },
      threadDisposition: "reusable",
    });
  });
const waitRecovery = (turn: Turn) =>
  EventSink.EventSinkV2.use((sink) =>
    sink.stream({ afterSequence: 0, eventType: "run.updated" }).pipe(
      Stream.filter(
        ({ event }) =>
          event.type === "run.updated" &&
          event.payload.id === turn.runId &&
          event.payload.activeAttemptId === turn.attemptId &&
          event.payload.recovery !== undefined,
      ),
      Stream.filterEffect(() =>
        ProjectionStore.ProjectionStoreV2.use((store) =>
          store
            .getThreadRecords(turn.threadId, ["runs", "attempts"])
            .pipe(
              Effect.map(
                (projection) =>
                  projection.runs.some(
                    (run) => run.id === turn.runId && run.recovery !== undefined,
                  ) &&
                  projection.attempts.some(
                    (attempt) => attempt.id === turn.attemptId && attempt.status === "failed",
                  ),
              ),
            ),
        ),
      ),
      Stream.take(1),
      Stream.runDrain,
    ),
  );
const recover = (turn: Turn) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projection = yield* orchestrator.getThreadProjection(turn.threadId);
    const run = projection.runs.find((run) => run.id === turn.runId)!;
    assert.isDefined(run.recovery);
    yield* TestClock.adjust(
      DateTime.toEpochMillis(run.recovery!.nextAttemptAt) -
        DateTime.toEpochMillis(yield* DateTime.now),
    );
    yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
  });
const output = (
  emit: (event: ProviderAdapter.ProviderAdapterV2Event) => Effect.Effect<boolean>,
  turn: Turn,
) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const messageId = MessageId.make(`message:answer:${turn.runId}`);
    yield* emit({
      type: "message.updated",
      driver,
      message: {
        id: messageId,
        threadId: turn.threadId,
        runId: turn.runId,
        nodeId: turn.rootNodeId,
        role: "assistant",
        text: "Recovered answer",
        attachments: [],
        streaming: false,
        createdBy: "agent",
        creationSource: "provider",
        createdAt: now,
        updatedAt: now,
      },
    });
    yield* emit({
      type: "turn_item.updated",
      driver,
      turnItem: {
        id: TurnItemId.make(`item:answer:${turn.attemptId}`),
        threadId: turn.threadId,
        runId: turn.runId,
        nodeId: turn.rootNodeId,
        providerThreadId: turn.providerThread.id,
        providerTurnId: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
        nativeItemRef: null,
        parentItemId: null,
        ordinal: turn.providerTurnOrdinal * 100 + 1,
        status: "completed",
        title: null,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "assistant_message",
        streaming: false,
        messageId,
        text: "Recovered answer",
      },
    });
  });
const complete = (
  emit: (event: ProviderAdapter.ProviderAdapterV2Event) => Effect.Effect<boolean>,
  turn: Turn,
) =>
  Effect.gen(function* () {
    yield* output(emit, turn);
    yield* emit({
      type: "turn.terminal",
      driver,
      providerThreadId: turn.providerThread.id,
      providerTurnId: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
      runOrdinal: turn.runOrdinal,
      status: "completed",
      failure: null,
      threadDisposition: "reusable",
    });
    yield* waitEvent(
      (event) =>
        event.type === "run.updated" &&
        event.payload.id === turn.runId &&
        event.payload.status === "waiting",
    );
    yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
  });

it.effect("recovers an overloaded root inside one reply with an empty native continuation", () =>
  withRecovery(({ started, emit, threadId }) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const first = started[0]!;
      const original = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
      yield* failTurn(emit, first);
      yield* waitRecovery(first);
      const waiting = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(waiting.runs[0]!.status, "running");
      const retry = waiting.turnItems.find((item) => item.type === "error");
      assert.equal(retry?.status, "running");
      assert.ok(retry?.type === "error");
      assert.deepEqual(retry.retry, { attempt: 1, maxAttempts: 7, retryDelayMs: 10_000 });
      assert.equal(waiting.attempts[0]!.status, "failed");
      yield* recover(first);
      assert.equal(started.length, 2);
      const next = started[1]!;
      assert.equal(next.runId, first.runId);
      assert.equal(next.continuation, "empty");
      assert.equal(next.message.text, "");
      assert.deepEqual(next.message.attachments, []);
      assert.equal(next.restartContinuationOfRunId, undefined);
      yield* complete(emit, next);
      const finished = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(finished.runs.length, 1);
      assert.equal(finished.runs[0]!.status, "completed");
      assert.deepEqual(finished.runs[0]!.startedAt, original.startedAt);
      assert.equal(finished.runs[0]!.recovery, undefined);
      assert.equal(finished.turnItems.find((item) => item.id === retry.id)?.status, "completed");
      assert.equal(finished.turnItems.filter((item) => item.type === "user_message").length, 1);
      assert.equal(finished.messages.filter((message) => message.role === "assistant").length, 1);
    }),
  ),
);

it.effect("Stop interrupts a recovery wait synchronously and cancels its timer", () =>
  withRecovery(({ started, emit, interruptCalls, threadId }) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const first = started[0]!;
      yield* failTurn(emit, first);
      yield* waitRecovery(first);
      yield* orchestrator.dispatch({
        type: "run.interrupt",
        commandId: CommandId.make("stop"),
        threadId,
        runId: first.runId,
      });
      const stopped = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(stopped.runs[0]!.status, "interrupted");
      assert.equal(stopped.attempts[0]!.status, "failed");
      assert.equal(stopped.turnItems.find((item) => item.type === "error")?.status, "cancelled");
      const effect = yield* (yield* EffectOutbox.EffectOutboxV2).get(
        recoveryEffectId(first.runId, 2),
      );
      assert.ok(Option.isSome(effect));
      assert.equal(effect.value.status, "cancelled");
      yield* TestClock.adjust("1 hour");
      yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
      assert.equal(started.length, 1);
      assert.equal(interruptCalls(), 0);
    }),
  ),
);

it.effect("user work wins immediately over a future recovery deadline", () =>
  withRecovery(
    ({ started, emit, interruptCalls, threadId }) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const first = started[0]!;
        yield* failTurn(emit, first);
        yield* waitRecovery(first);
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("replacement"),
          threadId,
          messageId: MessageId.make("message:replacement"),
          text: "Do this instead",
          attachments: [],
          deliveryIntent: "auto",
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
        assert.equal(started.length, 2);
        assert.equal(started[1]!.message.text, "Do this instead");
        assert.equal(started[1]!.message.messageId, "message:replacement");
        assert.equal(started[1]!.continuation, undefined);
        assert.equal(interruptCalls(), 0);
        assert.equal(
          (yield* orchestrator.getThreadProjection(threadId)).attempts[0]!.status,
          "failed",
        );
      }),
    { interrupt: false },
  ),
);

it.effect.each(["pending", "unknown"] as const)(
  "handles %s delivery without inventing acceptance",
  (delivery) =>
    withRecovery(({ started, emit, threadId }) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        const first = started[0]!;
        const projection = yield* orchestrator.getThreadProjection(threadId);
        const message = projection.messages.find(
          (message) => message.id === first.message.messageId,
        )!;
        // Seed the boundary state before an unconfirmed start; accepted receipts otherwise cannot regress.
        yield* sink.write({
          events: [
            {
              id: EventId.make(`delivery:${delivery}`),
              type: "message.updated",
              threadId,
              occurredAt: yield* DateTime.now,
              payload: { ...message, delivery },
            },
          ],
        });
        yield* failTurn(emit, first);
        if (delivery === "unknown") {
          yield* waitEvent(
            (event) => event.type === "run.updated" && event.payload.status === "failed",
          );
          assert.isTrue(
            Option.isNone(
              yield* (yield* EffectOutbox.EffectOutboxV2).get(recoveryEffectId(first.runId, 2)),
            ),
          );
          return;
        }
        yield* waitRecovery(first);
        yield* recover(first);
        assert.equal(started[1]!.continuation, "resend");
        assert.equal(started[1]!.message.text, first.message.text);
        assert.equal(started[1]!.message.messageId, first.message.messageId);
        assert.deepEqual(started[1]!.message.attachments, first.message.attachments);
      }),
    ),
);

it.effect("uses the continuation prompt when empty turns are unsupported", () =>
  withRecovery(
    ({ started, emit }) =>
      Effect.gen(function* () {
        yield* failTurn(emit, started[0]!);
        yield* waitRecovery(started[0]!);
        yield* recover(started[0]!);
        assert.equal(started[1]!.continuation, "prompt");
        assert.equal(started[1]!.message.text, "Continue where you left off.");
      }),
    { empty: false },
  ),
);

it.effect(
  "resets the streak on current model output and gives later streaks distinct effect ids",
  () =>
    withRecovery(({ started, emit, threadId }) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        yield* failTurn(emit, started[0]!);
        yield* waitRecovery(started[0]!);
        yield* recover(started[0]!);
        const second = started[1]!;
        yield* output(emit, second);
        yield* waitEvent(
          (event) =>
            event.type === "run.updated" &&
            event.payload.activeAttemptId === second.attemptId &&
            event.payload.status === "running" &&
            event.payload.recovery === undefined,
        );
        yield* failTurn(emit, second);
        yield* waitRecovery(second);
        const run = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
        assert.equal(run.recovery!.attempt, 1);
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        assert.isTrue(Option.isSome(yield* outbox.get(recoveryEffectId(run.id, 2))));
        assert.isTrue(Option.isSome(yield* outbox.get(recoveryEffectId(run.id, 3))));
        yield* recover(second);
        assert.equal(started.length, 3);
      }),
    ),
);

it.effect("retries a transient recovery-clear write without losing the model output", () =>
  withRecovery(({ started, emit, threadId }) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* failTurn(emit, started[0]!);
      yield* waitRecovery(started[0]!);
      yield* recover(started[0]!);
      const second = started[1]!;
      const sink = yield* EventSink.EventSinkV2;
      const write = sink.writeIfRunCurrent;
      const failed = yield* Deferred.make<void>();
      let clearingWrites = 0;
      const spy = vi.spyOn(sink, "writeIfRunCurrent").mockImplementation((input) => {
        const clearsRetry = input.events.some(
          (event) =>
            event.type === "turn-item.updated" &&
            event.payload.type === "error" &&
            event.payload.retry !== undefined &&
            event.payload.status === "completed",
        );
        if (!clearsRetry || ++clearingWrites > 1) return write(input);
        return Deferred.succeed(failed, undefined).pipe(
          Effect.andThen(
            Effect.fail(
              new EventSink.EventSinkWriteError({
                eventCount: input.events.length,
                cause: new SqlError({
                  reason: new UnknownError({ cause: { code: "SQLITE_BUSY" } }),
                }),
              }),
            ),
          ),
        );
      });
      try {
        yield* output(emit, second);
        yield* Deferred.await(failed);
        yield* TestClock.adjust("100 millis");
        yield* waitEvent(
          (event) =>
            event.type === "run.updated" &&
            event.payload.activeAttemptId === second.attemptId &&
            event.payload.status === "running" &&
            event.payload.recovery === undefined,
        );
        const state = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(clearingWrites, 2);
        assert.equal(state.runs[0]!.recovery, undefined);
        assert.equal(state.turnItems.find((item) => item.type === "error")?.status, "completed");
        assert.equal(state.attempts.at(-1)!.status, "running");
      } finally {
        spy.mockRestore();
      }
    }),
  ),
);

it.effect.each([false, true])(
  "preserves scheduled recovery through startup with restart continuations %s",
  (enabled) =>
    withRecovery(({ started, emit, threadId }) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const sink = yield* EventSink.EventSinkV2;
        const first = started[0]!;
        yield* failTurn(emit, first);
        yield* waitRecovery(first);
        const recoveryLayer = ProviderRuntimeRecovery.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(ProjectionStore.ProjectionStoreV2, projections),
              Layer.succeed(EffectOutbox.EffectOutboxV2, outbox),
              Layer.succeed(EventSink.EventSinkV2, sink),
              IdAllocator.layer,
              ServerSettings.layerTest({ continueThreadsAfterServerUpdate: enabled }),
            ),
          ),
        );
        yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService.use((service) =>
          service.prepareForShutdown.pipe(Effect.andThen(service.recover)),
        ).pipe(Effect.provide(recoveryLayer));
        const state = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(state.runs[0]!.status, "running");
        assert.equal(state.attempts[0]!.status, "failed");
        assert.equal(state.turnItems.find((item) => item.type === "error")?.status, "running");
        assert.isTrue(yield* hasPendingRunRecovery(state.runs[0]!, state.attempts, outbox));
        assert.equal((yield* projections.getRunLivenessCandidates()).runs.length, 0);
        assert.isTrue(
          Option.isNone(yield* outbox.get(`effect:restart-continuation:${first.runId}`)),
        );
        yield* recover(first);
        assert.equal(started.length, 2);
        assert.equal(started[1]!.continuation, "empty");
        const inFlight = yield* orchestrator.getThreadProjection(threadId);
        assert.isFalse(yield* hasPendingRunRecovery(inFlight.runs[0]!, inFlight.attempts, outbox));
        assert.equal((yield* projections.getRunLivenessCandidates()).runs.length, 1);
      }),
    ),
);

it.effect(
  "exhausts one delegated recovery budget, reporting recovery and waking its parent only once",
  () =>
    withRecovery(({ started, emit, threadId }) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const parent = started[0]!;
        yield* orchestrator.dispatch({
          type: "delegated_task.request",
          commandId: CommandId.make("delegate"),
          parentThreadId: threadId,
          parentRunId: parent.runId,
          parentNodeId: parent.rootNodeId,
          task: "Finish the child work",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          completionWake: "always",
          createdBy: "agent",
          creationSource: "mcp",
        });
        yield* worker.drain();
        const child = started[1]!;
        const task = (yield* orchestrator.getThreadProjection(threadId)).subagents[0]!;
        yield* failTurn(emit, child);
        yield* waitRecovery(child);
        yield* waitEvent(
          (event) =>
            event.type === "subagent.updated" &&
            event.payload.id === task.id &&
            event.payload.recovery != null,
        );
        const tasks = yield* Tasks.OrchestratorMcpService;
        const status = yield* tasks.taskStatus(
          {
            environmentId: EnvironmentId.make("environment:recovery"),
            requestNamespace: "recovery",
            issuedAt: 0,
            capabilities: new Set(["orchestration"]),
            client: undefined,
            thread: {
              threadId,
              providerInstanceId: instanceId,
              providerSessionId: "session:parent",
            },
          },
          task.id,
        );
        assert.equal(status.status, "running");
        assert.equal(status.workState, "recovering");
        assert.equal(status.recovery?.kind, "overloaded");
        assert.equal(status.recovery?.failureMessage, "Service busy");
        assert.isFalse(endsTaskWait(status));
        assert.equal(taskView(status).workState, "recovering");
        const before = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(before.subagents[0]!.status, "running");
        assert.isNull(before.subagents[0]!.result);
        const card = before.turnItems.find(
          (item) => item.type === "subagent" && item.subagentId === task.id,
        );
        assert.ok(card?.type === "subagent");
        assert.equal(card.status, "running");
        assert.equal(card.recovery?.attempt, 1);
        const overview =
          yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadSubagentOverview({ threadId });
        assert.equal(overview.active.items[0]!.recovery?.attempt, 1);
        const maxAttempts = card.recovery!.maxAttempts!;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          const current = started.at(-1)!;
          const parentState = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(
            parentState.messages.filter((message) => message.delegatedCompletion !== undefined)
              .length,
            0,
          );
          yield* recover(current);
          const next = started.at(-1)!;
          assert.equal(next.runId, child.runId);
          yield* failTurn(emit, next);
          if (attempt < maxAttempts) yield* waitRecovery(next);
        }
        yield* waitEvent(
          (event) =>
            event.type === "subagent.updated" &&
            event.payload.id === task.id &&
            event.payload.status === "failed",
        );
        const exhausted = yield* orchestrator.getThreadProjection(child.threadId);
        assert.equal(exhausted.runs.length, 1);
        assert.equal(exhausted.runs[0]!.status, "failed");
        assert.equal(exhausted.attempts.length, maxAttempts + 1);
        assert.isTrue(exhausted.attempts.every((attempt) => attempt.status === "failed"));
        assert.isFalse(
          exhausted.turnItems.some((item) => item.type === "error" && item.status === "running"),
        );
        const settled = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(settled.subagents[0]!.status, "failed");
        assert.isNull(settled.subagents[0]!.recovery);
        assert.equal(
          settled.contextTransfers.filter((transfer) => transfer.type === "subagent_result").length,
          1,
        );
        yield* waitEvent(
          (event) =>
            event.type === "message.updated" &&
            event.threadId === threadId &&
            event.payload.delegatedCompletion !== undefined,
        );
        yield* orchestrator.recoverDelegatedTasks;
        const final = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(
          final.messages.filter((message) => message.delegatedCompletion !== undefined).length,
          1,
        );
        assert.equal(
          final.contextTransfers.filter((transfer) => transfer.type === "subagent_result").length,
          1,
        );
      }),
    ),
);

it.effect.each(["thread.model-selection.set", "provider.switch"] as const)(
  "applies %s during a wait without interrupting dead native work",
  (type) =>
    withRecovery(({ started, emit, interruptCalls, threadId }) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        yield* failTurn(emit, started[0]!);
        yield* waitRecovery(started[0]!);
        yield* orchestrator.dispatch({
          type,
          commandId: CommandId.make("selection"),
          threadId,
          modelSelection: { instanceId, model: "new-model" },
        });
        yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
        assert.equal(started.length, 2);
        assert.equal(started[1]!.modelSelection.model, "new-model");
        assert.equal(started[1]!.continuation, "empty");
        assert.equal(interruptCalls(), 0);
        assert.equal(
          (yield* orchestrator.getThreadProjection(threadId)).turnItems.filter(
            (item) => item.type === "user_message",
          ).length,
          1,
        );
      }),
    ),
);

it.effect.each(["thread.archive", "thread.delete"] as const)(
  "cancels recovery on %s without rewriting the failed attempt",
  (type) =>
    withRecovery(({ started, emit, threadId }) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const first = started[0]!;
        yield* failTurn(emit, first);
        yield* waitRecovery(first);
        yield* orchestrator.dispatch({ type, commandId: CommandId.make("close"), threadId });
        const state = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(state.runs[0]!.status, "cancelled");
        assert.equal(state.attempts[0]!.status, "failed");
        assert.equal(state.runs[0]!.recovery, undefined);
        assert.equal(state.turnItems.find((item) => item.type === "error")?.status, "cancelled");
        const effect = yield* (yield* EffectOutbox.EffectOutboxV2).get(
          recoveryEffectId(first.runId, 2),
        );
        assert.ok(Option.isSome(effect));
        assert.equal(effect.value.status, "cancelled");
        yield* orchestrator.dispatch({
          type: "run.recover",
          commandId: CommandId.make("stale"),
          threadId,
          runId: first.runId,
          attemptOrdinal: 2,
        });
        assert.equal(started.length, 1);
      }),
    ),
);

it.effect("does not exempt a recovery whose timer succeeded without creating an attempt", () =>
  withRecovery(({ started, emit, threadId }) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const first = started[0]!;
      yield* failTurn(emit, first);
      yield* waitRecovery(first);
      const state = yield* orchestrator.getThreadProjection(threadId);
      yield* TestClock.adjust("10 seconds");
      const claim = yield* outbox.claimNext({ workerId: "lost-worker", leaseDurationMs: 30_000 });
      assert.ok(Option.isSome(claim));
      assert.equal(claim.value.request.type, "run.recover");
      assert.isTrue(yield* outbox.succeed({ effectId: claim.value.id, workerId: "lost-worker" }));
      assert.isFalse(yield* hasPendingRunRecovery(state.runs[0]!, state.attempts, outbox));
      assert.equal((yield* projections.getRunLivenessCandidates()).runs.length, 1);
      yield* orchestrator.dispatch({
        type: "run.recover",
        commandId: CommandId.make("stale-timer"),
        threadId,
        runId: first.runId,
        attemptOrdinal: 2,
      });
      assert.equal(started.length, 1);
    }),
  ),
);

it.effect("replaces a required provider session during recovery without an interrupt", () =>
  withRecovery(
    ({ started, emit, interruptCalls, threadId }) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        yield* failTurn(emit, started[0]!);
        yield* waitRecovery(started[0]!);
        yield* orchestrator.dispatch({
          type: "thread.model-selection.set",
          commandId: CommandId.make("session-replacement"),
          threadId,
          modelSelection: { instanceId, model: "replacement-model" },
        });
        yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
        assert.equal(started.length, 2);
        assert.equal(interruptCalls(), 0);
        assert.equal(started[1]!.modelSelection.model, "replacement-model");
        assert.equal(
          started[1]!.providerThread.nativeThreadRef?.nativeId,
          started[0]!.providerThread.nativeThreadRef?.nativeId,
        );
        const effects = yield* (yield* EffectOutbox.EffectOutboxV2).listByCommandId(
          CommandId.make("session-replacement"),
        );
        assert.isTrue(
          effects.some(
            (effect) =>
              effect.request.type === "provider-session.detach" && effect.status === "succeeded",
          ),
        );
      }),
    { restartSession: true, interrupt: false },
  ),
);

it.effect(
  "rechecks live model policy before a retained retry starts another provider request",
  () =>
    Effect.gen(function* () {
      const owner = yield* makeModelPolicy(DEFAULT_MODEL_POLICY, {});
      return yield* withRecovery(({ started, emit, threadId }) =>
        Effect.gen(function* () {
          const first = started[0]!;
          yield* failTurn(emit, first);
          yield* waitRecovery(first);
          yield* owner.replace({
            policy: setModelOn(
              DEFAULT_MODEL_POLICY,
              { instanceId, driver },
              modelSelection.model,
              false,
            ),
            providers: {},
          });
          yield* recover(first);
          const projection = yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(
            threadId,
          );
          assert.equal(started.length, 1);
          assert.equal(projection.runs[0]?.status, "failed");
          assert.equal(projection.runs[0]?.recovery, undefined);
        }),
      ).pipe(Effect.provideService(RuntimeModelPolicy, owner));
    }),
);

it.effect(
  "queue promotion rechecks an admitted selection after it is disabled without interrupting the active native turn",
  () =>
    Effect.gen(function* () {
      const owner = yield* makeModelPolicy(DEFAULT_MODEL_POLICY, {});
      return yield* withRecovery(({ started, emit, threadId }) =>
        Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("queue-policy"),
            threadId,
            messageId: MessageId.make("queue-policy"),
            text: "Must not start after disabling",
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
            createdBy: "user",
            creationSource: "web",
          });
          yield* owner.replace({
            policy: setModelOn(
              DEFAULT_MODEL_POLICY,
              { instanceId, driver },
              modelSelection.model,
              false,
            ),
            providers: {},
          });
          assert.equal(started.length, 1);
          yield* complete(emit, started[0]!);
          yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
          yield* waitEvent(
            (event) =>
              event.type === "run.updated" &&
              event.payload.userMessageId === "queue-policy" &&
              event.payload.status === "failed",
          );
          const projection = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(started.length, 1);
          assert.equal(
            projection.runs.find((run) => run.userMessageId === "queue-policy")?.status,
            "failed",
          );
        }),
      ).pipe(Effect.provideService(RuntimeModelPolicy, owner));
    }),
);

it.effect("restart reconciliation does not create a continuation on an off model", () =>
  Effect.gen(function* () {
    const owner = yield* makeModelPolicy(DEFAULT_MODEL_POLICY, {});
    return yield* withRecovery(({ started }) =>
      Effect.gen(function* () {
        const first = started[0]!;
        yield* owner.replace({
          policy: setModelOn(
            DEFAULT_MODEL_POLICY,
            { instanceId, driver },
            modelSelection.model,
            false,
          ),
          providers: {},
        });
        const recovery = yield* RuntimeRecovery.make.pipe(
          Effect.provide(
            Layer.mergeAll(
              IdAllocator.layer,
              ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
            ),
          ),
        );
        yield* recovery.reconcile("startup");
        const continuation = yield* (yield* EffectOutbox.EffectOutboxV2).get(
          `effect:restart-continuation:${first.runId}`,
        );
        assert.isTrue(Option.isNone(continuation));
        assert.equal(started.length, 1);
      }),
    ).pipe(Effect.provideService(RuntimeModelPolicy, owner));
  }),
);

it.effect(
  "revoking Agent credit permission refuses an outside Agent's queued choice using its captured origin",
  () =>
    Effect.gen(function* () {
      const providers = { [instanceId]: { driver, source: "nodex" as const, config: {} } };
      const owner = yield* makeModelPolicy(
        { ...DEFAULT_MODEL_POLICY, agentsMayChooseCredit: true },
        providers,
      );
      return yield* withRecovery(({ started, emit, threadId }) =>
        Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const sender = ThreadId.make("outside-credit-sender");
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("outside-credit-sender"),
            threadId: sender,
            projectId: ProjectId.make("project:recovery"),
            title: "Outside Agent",
            modelSelection: {
              instanceId: ProviderInstanceId.make("outside"),
              model: "native-model",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdBy: "user",
            creationSource: "web",
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("outside-credit-choice"),
            threadId,
            messageId: MessageId.make("outside-credit-choice"),
            senderThreadId: sender,
            text: "Must not start after credit choice permission is revoked",
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
            createdBy: "agent",
            creationSource: "mcp",
          });
          const queued = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
            (run) => run.userMessageId === "outside-credit-choice",
          );
          assert.equal(queued?.modelPolicyOrigin, "agent");
          yield* owner.replace({ policy: DEFAULT_MODEL_POLICY, providers });
          yield* complete(emit, started[0]!);
          yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
          yield* waitEvent(
            (event) =>
              event.type === "run.updated" &&
              event.payload.userMessageId === "outside-credit-choice" &&
              event.payload.status === "failed",
          );
          assert.equal(started.length, 1);
        }),
      ).pipe(Effect.provideService(RuntimeModelPolicy, owner));
    }),
);
