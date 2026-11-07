import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@nodex/runtime-contracts";
import * as ProviderAdapter from "@nodex/provider-core/server/ProviderAdapter";
import { checkpointWorkspace } from "@nodex/provider-testing/replayWorkspace";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { makeProviderEventBuffer } from "./ProviderEventBuffer.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

type Turn = ProviderAdapter.ProviderAdapterV2TurnInput;
const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-test" };
const waitEvent = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
  EventSink.EventSinkV2.use((sink) =>
    sink.stream({ afterSequence: 0 }).pipe(
      Stream.filter(({ event }) => predicate(event)),
      Stream.take(1),
      Stream.runDrain,
    ),
  );

it.effect(
  "a canonical thread overflow reconciles only its Run and both Runs keep observing the same process",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("shared-session-containment");
        const started = yield* Queue.unbounded<Turn>();
        const reconciled = yield* Queue.unbounded<ProviderThreadId>();
        let opens = 0,
          closes = 0;
        let buffer: Effect.Success<ReturnType<typeof makeProviderEventBuffer>>;
        const adapter = ProviderAdapter.ProviderAdapterV2.of({
          instanceId,
          driver,
          getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
          planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
          openSession: (input) =>
            Effect.gen(function* () {
              opens++;
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  closes++;
                }),
              );
              buffer = yield* makeProviderEventBuffer({
                maxItems: 2,
                mapOverflow: (cause) =>
                  new ProviderAdapter.ProviderAdapterEventStreamError({
                    driver,
                    providerSessionId: input.providerSessionId,
                    cause,
                  }),
              });
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
                  capabilities: CodexProviderCapabilitiesV2,
                  createdAt: now,
                  updatedAt: now,
                  lastError: null,
                },
                events: buffer.events,
                observations: buffer.observations,
                termination: Effect.never,
                ensureThread: ({ threadId }) =>
                  Effect.gen(function* () {
                    const providerThread = {
                      id: ProviderThreadId.make(`provider:${threadId}`),
                      driver,
                      providerInstanceId: instanceId,
                      providerSessionId: input.providerSessionId,
                      appThreadId: threadId,
                      ownerNodeId: null,
                      nativeThreadRef: {
                        driver,
                        nativeId: `native:${threadId}`,
                        strength: "strong" as const,
                      },
                      nativeConversationHeadRef: null,
                      status: "idle" as const,
                      firstRunOrdinal: null,
                      lastRunOrdinal: null,
                      handoffIds: [],
                      forkedFrom: null,
                      createdAt: now,
                      updatedAt: now,
                    };
                    yield* buffer.offer({
                      type: "provider_thread.updated",
                      driver,
                      providerThread,
                    });
                    return providerThread;
                  }),
                resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
                startTurn: (turn) =>
                  Effect.gen(function* () {
                    yield* buffer.offer({
                      type: "provider_turn.updated",
                      driver,
                      threadId: turn.threadId,
                      providerTurn: {
                        id: ProviderTurnId.make(`turn:${turn.attemptId}`),
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
                        startedAt: now,
                        completedAt: null,
                      },
                    });
                    yield* Queue.offer(started, turn);
                  }),
                reconcileTurn: ({ providerThread }) =>
                  Queue.offer(reconciled, providerThread.id).pipe(
                    Effect.as({ status: "active" as const, events: [] }),
                  ),
                interruptTurn: () =>
                  Effect.die("Active observation recovery must not interrupt a turn"),
                steerTurn: () => Effect.void,
                respondToRuntimeRequest: () => Effect.void,
                readThreadSnapshot: () => Effect.die("unused"),
                rollbackThread: () => Effect.die("unused"),
                forkThread: () => Effect.die("unused"),
              };
            }),
        });
        const layer = ProviderReplayHarness.layerWithRegistry(
          { name: "shared-session-containment", runtimePolicyOverride: { cwd } },
          ProviderAdapterRegistry.layerSingle(adapter),
          { runEffectWorker: false, runContinuationWorker: false },
        );
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const turns: Turn[] = [];
          for (let i = 0; i < 2; i++) {
            const threadId = ThreadId.make(`containment:${i}`);
            yield* orchestrator.dispatch({
              type: "thread.create",
              commandId: CommandId.make(`create:${i}`),
              threadId,
              projectId: ProjectId.make("project:shared-session-containment"),
              title: `Task ${i}`,
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
              commandId: CommandId.make(`message:${i}`),
              threadId,
              messageId: MessageId.make(`message:${i}`),
              text: "Work",
              attachments: [],
              dispatchMode: { type: "start_immediately" },
              createdBy: "user",
              creationSource: "web",
            });
            yield* worker.drain();
            const turn = yield* Queue.take(started);
            turns.push(turn);
            yield* waitEvent(
              (event) =>
                event.type === "provider-turn.updated" &&
                event.payload.runAttemptId === turn.attemptId &&
                event.payload.status === "running",
            );
          }
          const hot = turns[0]!,
            sibling = turns[1]!;
          yield* Effect.all(
            Array.from({ length: 3 }, () =>
              buffer.offer({
                type: "provider_thread.updated",
                driver,
                providerThread: hot.providerThread,
              }),
            ),
          );
          assert.equal(yield* Queue.take(reconciled), hot.providerThread.id);
          assert.equal(yield* Queue.size(reconciled), 0);
          assert.equal(opens, 1);
          assert.equal(closes, 0);
          for (const turn of [sibling, hot]) {
            const projection = yield* orchestrator.getThreadProjection(turn.threadId);
            const providerTurn = projection.providerTurns.find(
              (candidate) => candidate.runAttemptId === turn.attemptId,
            )!;
            yield* buffer.offer({
              type: "provider_turn.updated",
              driver,
              threadId: turn.threadId,
              providerTurn: {
                ...providerTurn,
                status: "completed",
                completedAt: yield* DateTime.now,
              },
            });
            yield* waitEvent(
              (event) =>
                event.type === "provider-turn.updated" &&
                event.payload.id === providerTurn.id &&
                event.payload.status === "completed",
            );
            assert.equal(
              (yield* orchestrator.getThreadProjection(turn.threadId)).attempts.length,
              1,
              "Reattachment must not start another turn",
            );
          }
          assert.equal(opens, 1);
          assert.equal(closes, 0);
        }).pipe(Effect.provide(layer));
      }),
    ),
);
