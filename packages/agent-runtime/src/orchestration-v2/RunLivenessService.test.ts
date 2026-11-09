import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import { assert, it } from "@effect/vitest";
import {
  CheckpointScopeId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2CheckpointScope,
  type OrchestrationV2DomainEvent,
} from "@nodex/runtime-contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as ProviderAdapter from "@nodex/provider-core/server/ProviderAdapter";
import * as IdAllocator from "@nodex/provider-core/server/IdAllocator";
import * as McpAppModelContext from "../mcpApps/McpAppModelContext.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as EventSink from "./EventSink.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as RunExecutionService from "./RunExecutionService.ts";
import * as RunLivenessService from "./RunLivenessService.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";

const fixture = (now: DateTime.Utc) => {
  const threadId = ThreadId.make("thread:liveness");
  const runId = RunId.make("run:liveness");
  const instanceId = ProviderInstanceId.make("codex");
  const driver = ProviderDriverKind.make("codex");
  const attemptId = RunAttemptId.make("attempt:liveness");
  const providerThreadId = ProviderThreadId.make("provider-thread:liveness");
  const providerTurnId = ProviderTurnId.make("provider-turn:liveness");
  const nodeId = NodeId.make("node:liveness");
  const scopeId = CheckpointScopeId.make("scope:liveness");
  const thread = {
    id: threadId,
    projectId: ProjectId.make("project:liveness"),
    runtimeMode: "full-access",
    interactionMode: "default",
    worktreePath: null,
  } as OrchestrationV2AppThread;
  const run = {
    id: runId,
    threadId,
    ordinal: 1,
    status: "running",
    activeAttemptId: attemptId,
    rootNodeId: nodeId,
    userMessageId: MessageId.make("message:liveness"),
    providerInstanceId: instanceId,
    providerThreadId,
    modelSelection: { instanceId, model: "gpt-5.4" },
    startedAt: now,
    requestedAt: now,
    completedAt: null,
  } as OrchestrationV2Run;
  const attempt: OrchestrationV2RunAttempt = {
    id: attemptId,
    runId,
    attemptOrdinal: 1,
    rootNodeId: nodeId,
    providerInstanceId: instanceId,
    providerThreadId,
    providerTurnId,
    reason: "initial",
    status: "running",
    startedAt: now,
    completedAt: null,
  };
  const node = {
    id: nodeId,
    threadId,
    runId,
    kind: "root_turn",
    status: "running",
    checkpointScopeId: scopeId,
    providerThreadId,
    providerTurnId,
    rootNodeId: nodeId,
  } as OrchestrationV2ExecutionNode;
  const providerThread = {
    id: providerThreadId,
    appThreadId: threadId,
    driver,
    providerInstanceId: instanceId,
    providerSessionId: ProviderSessionId.make("session:liveness"),
    nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
    status: "active",
    updatedAt: now,
  } as OrchestrationV2ProviderThread;
  const turn: OrchestrationV2ProviderTurn = {
    id: providerTurnId,
    providerThreadId,
    nodeId,
    runAttemptId: attemptId,
    nativeTurnRef: { driver, nativeId: "native-turn", strength: "strong" },
    ordinal: 1,
    status: "running",
    startedAt: now,
    completedAt: null,
  };
  const scope = { id: scopeId } as OrchestrationV2CheckpointScope;
  return { thread, run, attempt, node, providerThread, turn, scope };
};

const withLiveness = <A>(input: {
  readonly outcome: "active" | "completed";
  readonly terminalOwner?: boolean;
  readonly supersededAttempt?: boolean;
  readonly processGone?: boolean;
  readonly unbound?: boolean;
  readonly attemptAgeMs?: number;
  readonly test: (context: {
    readonly execution: RunExecutionService.RunExecutionServiceV2["Service"];
    readonly liveness: RunLivenessService.RunLivenessService["Service"];
    readonly fixture: ReturnType<typeof fixture>;
    readonly written: OrchestrationV2DomainEvent[];
    readonly interrupted: ProviderTurnId[];
    readonly reconciled: ProviderTurnId[];
    readonly projectionLoads: () => number;
  }) => Effect.Effect<A, unknown>;
}) =>
  Effect.gen(function* () {
    const f = fixture(
      DateTime.makeUnsafe(
        DateTime.toEpochMillis(yield* DateTime.now) - (input.attemptAgeMs ?? 180_000),
      ),
    );
    const run = input.terminalOwner
      ? { ...f.run, status: "failed" as const }
      : input.supersededAttempt
        ? { ...f.run, activeAttemptId: RunAttemptId.make("attempt:newer") }
        : f.run;
    const state: ProjectionStore.ProjectionRuntimeRecoveryState = {
      thread: f.thread,
      runs: [run],
      attempts: [input.unbound ? { ...f.attempt, providerTurnId: null } : f.attempt],
      nodes: [f.node],
      providerThreads: [f.providerThread],
      providerTurns: input.unbound ? [] : [f.turn],
      providerSessions: [],
      subagents: [],
      runtimeRequests: [],
      messages: [],
      turnItems: [],
    };
    const written: OrchestrationV2DomainEvent[] = [];
    const interrupted: ProviderTurnId[] = [];
    const reconciled: ProviderTurnId[] = [];
    const write = (events: readonly OrchestrationV2DomainEvent[]) =>
      Effect.sync(() => {
        written.push(...events);
        return [];
      });
    const sink = Layer.mock(EventSink.EventSinkV2)({
      write: ({ events }) => write(events),
      writeWithEffects: ({ events }) => write(events),
      writeIfRunCurrent: ({ events }) =>
        write(events).pipe(Effect.map(() => ({ committed: true, storedEvents: [] }))),
      stream: () => Stream.never,
    });
    const runtime = {
      events: Stream.never,
      subscribeEvents: Effect.succeed({ events: Stream.never, close: Effect.void }),
      startTurn: () => Effect.die("Liveness must not start another native turn"),
      reconcileTurn: ({ providerTurnId }: { providerTurnId: ProviderTurnId }) =>
        Effect.sync(() => {
          reconciled.push(providerTurnId);
          return { status: input.outcome, events: [] };
        }),
      interruptTurn: ({ providerTurnId }: { providerTurnId: ProviderTurnId }) =>
        Effect.sync(() => {
          interrupted.push(providerTurnId);
        }),
    } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime;
    let projectionLoads = 0;
    const projections = Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getRecoveryThreadIds: () => Effect.succeed([f.thread.id]),
      getRunLivenessCandidates: () =>
        Effect.succeed({
          runs:
            input.terminalOwner || input.supersededAttempt
              ? []
              : [
                  {
                    threadId: f.thread.id,
                    runId: run.id,
                    activeAttemptId: f.attempt.id,
                    attemptStartedAt: f.attempt.startedAt,
                    providerTurnId: input.unbound ? null : f.turn.id,
                  },
                ],
          orphanedTurnThreadIds:
            input.terminalOwner || input.supersededAttempt ? [f.thread.id] : [],
        }),
      getThreadRecords: () =>
        Effect.succeed<import("@nodex/runtime-contracts").OrchestrationV2ThreadProjection>({
          ...state,
          checkpointScopes: [f.scope],
          checkpoints: [],
          contextTransfers: [],
          contextHandoffs: [],
          plans: [],
          visibleTurnItems: [],
          updatedAt: f.run.requestedAt,
        }),
      getRuntimeRecoveryProjection: () =>
        Effect.sync(() => {
          projectionLoads++;
          return state;
        }),
      getCheckpointCaptureContext: () =>
        Effect.succeed({
          run,
          rootNode: f.node,
          scope: f.scope,
          providerThread: f.providerThread,
          baselineCheckpoints: [],
        }),
      getRunOutcome: () =>
        Effect.succeed({
          runId: run.id,
          startedAt: null,
          status: run.status,
          completedAt: null,
          finalAssistantItemId: null,
        }),
    });
    const execution = RunExecutionService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          sink,
          IdAllocator.layer,
          McpAppModelContext.layerEmpty,
          ServerSettings.layerTest(),
          Layer.mock(CheckpointService.CheckpointServiceV2)({ captureBaseline: () => Effect.void }),
          Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({
            ingestNormalized: () => Effect.succeed([]),
            normalize: () => Effect.succeed([]),
          }),
        ),
      ),
    );
    const liveness = RunLivenessService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          execution,
          projections,
          ThreadCommandExecutor.layer,
          Layer.mock(EffectOutbox.EffectOutboxV2)({ get: () => Effect.succeed(Option.none()) }),
          sink,
          IdAllocator.layer,
          RuntimePolicy.layer,
          Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
            get: () => Effect.succeed(input.processGone ? Option.none() : Option.some(runtime)),
          }),
        ),
      ),
    );
    return yield* Effect.gen(function* () {
      const execution = yield* RunExecutionService.RunExecutionServiceV2;
      const liveness = yield* RunLivenessService.RunLivenessService;
      try {
        return yield* input.test({
          execution,
          liveness,
          fixture: f,
          written,
          interrupted,
          reconciled,
          projectionLoads: () => projectionLoads,
        });
      } finally {
        yield* execution.stopObserving(f.run.id, f.attempt.id);
      }
    }).pipe(Effect.provide(Layer.merge(execution, liveness)));
  });

const waitUntil = (predicate: () => boolean) =>
  Effect.gen(function* () {
    for (let count = 0; count < 10_000; count++) {
      if (predicate()) return;
      yield* Effect.yieldNow;
    }
    return yield* Effect.die("Liveness did not settle");
  });

it.effect.each(["active", "completed"] as const)(
  "reconciles an unobserved Run whose native turn is %s",
  (outcome) =>
    withLiveness({
      outcome,
      test: ({ liveness, execution, written, reconciled, interrupted }) =>
        Effect.gen(function* () {
          yield* liveness.sweep;
          yield* waitUntil(() => reconciled.length > 0);
          if (outcome === "completed") {
            yield* waitUntil(() => written.some((event) => event.type === "run.updated"));
            assert.isTrue(
              written.some(
                (event) => event.type === "run.updated" && event.payload.status === "waiting",
              ),
            );
          } else {
            assert.lengthOf(yield* execution.observers, 1);
            assert.isFalse(written.some((event) => event.type === "run.updated"));
          }
          assert.deepEqual(interrupted, []);
        }),
    }),
);

it.effect.each([false, true])(
  "interrupts and terminalizes an orphaned turn, superseded attempt=%s",
  (supersededAttempt) =>
    withLiveness({
      outcome: "active",
      terminalOwner: !supersededAttempt,
      supersededAttempt,
      test: ({ liveness, written, interrupted, fixture }) =>
        Effect.gen(function* () {
          yield* liveness.sweep;
          assert.deepEqual(interrupted, [fixture.turn.id]);
          assert.isTrue(
            written.some(
              (event) =>
                event.type === "provider-turn.updated" && event.payload.status === "interrupted",
            ),
          );
          assert.isFalse(written.some((event) => event.type === "run.updated"));
        }),
    }),
);

it.effect("records process loss with the bound native turn id", () =>
  withLiveness({
    outcome: "active",
    processGone: true,
    test: ({ liveness, written, fixture }) =>
      Effect.gen(function* () {
        yield* liveness.sweep;
        yield* waitUntil(() => written.some((event) => event.type === "run.updated"));
        const failure = written.find(
          (event) => event.type === "turn-item.updated" && event.payload.type === "error",
        );
        assert.isTrue(
          failure?.type === "turn-item.updated" &&
            failure.payload.type === "error" &&
            failure.payload.failure.code === "provider_process_exited" &&
            failure.payload.providerTurnId === fixture.turn.id,
        );
      }),
  }),
);

it.effect.each([119_999, 120_000])("checks the unbound start deadline at %s ms", (attemptAgeMs) =>
  withLiveness({
    outcome: "active",
    unbound: true,
    attemptAgeMs,
    test: ({ liveness, written, reconciled }) =>
      Effect.gen(function* () {
        yield* liveness.sweep;
        if (attemptAgeMs < 120_000) {
          assert.deepEqual(written, []);
          assert.deepEqual(reconciled, []);
          return;
        }
        yield* waitUntil(() => written.some((event) => event.type === "run.updated"));
        assert.isTrue(
          written.some(
            (event) =>
              event.type === "turn-item.updated" &&
              event.payload.type === "error" &&
              event.payload.failure.code === "turn_start_unconfirmed",
          ),
        );
      }),
  }),
);

it.effect(
  "does not load full projections when every Run is observed and no turns are orphaned",
  () =>
    withLiveness({
      outcome: "active",
      test: ({ liveness, execution, reconciled, projectionLoads }) =>
        Effect.gen(function* () {
          yield* liveness.sweep;
          yield* waitUntil(() => reconciled.length > 0);
          assert.lengthOf(yield* execution.observers, 1);
          const initialLoads = projectionLoads();
          assert.equal(initialLoads, 1);
          yield* liveness.sweep;
          assert.equal(projectionLoads(), initialLoads);
          assert.lengthOf(reconciled, 1);
        }),
    }),
);
