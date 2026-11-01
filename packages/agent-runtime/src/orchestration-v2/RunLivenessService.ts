import {
  CommandId,
  latestProviderTurnForAttempt,
  type OrchestrationV2Run,
  type OrchestrationV2ProviderTurn,
  ProviderSessionId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as EventSink from "./EventSink.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as RunExecutionService from "./RunExecutionService.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import { forkParked } from "../serverActivation.ts";
import { retryObservation, reconcileProviderTurn } from "./ProviderObservation.ts";

/** A running reply must be bound to a live native turn. */
export function needsLivenessCheck(run: OrchestrationV2Run): boolean {
  return run.status === "running";
}

export function isOrphanedProviderTurn(
  turn: OrchestrationV2ProviderTurn,
  state: ProjectionStore.ProjectionRuntimeRecoveryState,
): boolean {
  if (turn.status !== "running" || turn.runAttemptId === null) return false;
  const attempt = state.attempts.find((attempt) => attempt.id === turn.runAttemptId);
  const run = state.runs.find((run) => run.id === attempt?.runId);
  return (
    run !== undefined &&
    (["completed", "failed", "interrupted", "cancelled", "rolled_back"].includes(run.status) ||
      run.activeAttemptId !== turn.runAttemptId)
  );
}

export class RunLivenessError extends Schema.TaggedError<RunLivenessError>()("RunLivenessError", {
  cause: Schema.Defect(),
}) {}

export class RunLivenessService extends Context.Service<
  RunLivenessService,
  {
    readonly sweep: Effect.Effect<void, RunLivenessError>;
    readonly start: Effect.Effect<void, never, import("effect/Scope").Scope>;
  }
>()("nodex/orchestration-v2/RunLivenessService") {}

export const layer = Layer.effect(
  RunLivenessService,
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const execution = yield* RunExecutionService.RunExecutionServiceV2;
    const sink = yield* EventSink.EventSinkV2;
    const ids = yield* IdAllocator.IdAllocatorV2;
    const policy = yield* RuntimePolicy.RuntimePolicyV2;
    const permit = yield* Semaphore.make(1);
    const sweep = permit.withPermit(
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const observers = new Map(
          (yield* execution.observers).map((observer) => [observer.runId, observer]),
        );
        const candidates = yield* retryObservation(projections.getRunLivenessCandidates());
        const threadIds = new Set(candidates.orphanedTurnThreadIds);
        for (const run of candidates.runs) {
          const observer = observers.get(run.runId);
          const turnId =
            (observer?.attemptId === run.activeAttemptId ? observer.providerTurnId : null) ??
            run.providerTurnId;
          const expiredUnbound =
            turnId === null &&
            run.attemptStartedAt !== null &&
            DateTime.toEpochMillis(now) - DateTime.toEpochMillis(run.attemptStartedAt) >= 120_000;
          if (expiredUnbound || (turnId !== null && observer?.attemptId !== run.activeAttemptId))
            threadIds.add(run.threadId);
        }
        for (const threadId of threadIds) {
          const state = yield* retryObservation(projections.getRuntimeRecoveryProjection(threadId));
          for (const turn of state.providerTurns.filter((turn) =>
            isOrphanedProviderTurn(turn, state),
          )) {
            yield* Effect.gen(function* () {
              const providerThread = state.providerThreads.find(
                (thread) => thread.id === turn.providerThreadId,
              );
              if (providerThread === undefined) return;
              const runtime =
                providerThread.providerSessionId === null
                  ? Option.none<ProviderAdapter.ProviderAdapterV2SessionRuntime>()
                  : yield* sessions.get(providerThread.providerSessionId);
              let status: OrchestrationV2ProviderTurn["status"] = "cancelled";
              if (Option.isSome(runtime)) {
                const reconciliation = yield* reconcileProviderTurn(runtime.value, {
                  providerThread,
                  providerTurnId: turn.id,
                }).pipe(
                  Effect.catchCause((cause) =>
                    Cause.hasInterruptsOnly(cause)
                      ? Effect.failCause(cause)
                      : Effect.succeed({ status: "unknown" as const, events: [] }),
                  ),
                );
                if (reconciliation.status === "active" || reconciliation.status === "unknown") {
                  yield* runtime.value
                    .interruptTurn({
                      providerThread,
                      providerTurnId: turn.id,
                      requireTerminalAcknowledgement: true,
                      ...(turn.runAttemptId === null
                        ? {}
                        : { expectedRunAttemptId: turn.runAttemptId }),
                    })
                    .pipe(Effect.timeout("15 seconds"));
                  status = "interrupted";
                } else if (reconciliation.status !== "process_gone") status = reconciliation.status;
              }
              const current = yield* retryObservation(
                projections.getRuntimeRecoveryProjection(threadId),
              );
              if (
                !current.providerTurns.some(
                  (row) =>
                    row.id === turn.id &&
                    row.runAttemptId === turn.runAttemptId &&
                    isOrphanedProviderTurn(row, current),
                )
              )
                return;
              yield* retryObservation(
                sink.write({
                  expectedProviderTurn: { id: turn.id, runAttemptId: turn.runAttemptId },
                  events: [
                    {
                      id: yield* ids.allocate.event({ threadId }),
                      type: "provider-turn.updated",
                      threadId,
                      nodeId: turn.nodeId,
                      providerInstanceId: providerThread.providerInstanceId,
                      occurredAt: now,
                      payload: { ...turn, status, completedAt: now },
                    },
                  ],
                }),
              );
            }).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Could not reconcile orphaned provider turn", {
                  providerTurnId: turn.id,
                  cause,
                }),
              ),
            );
          }
          for (const run of state.runs.filter(needsLivenessCheck)) {
            const attempt = state.attempts.find((attempt) => attempt.id === run.activeAttemptId);
            if (attempt === undefined) continue;
            const boundTurn = latestProviderTurnForAttempt(state.providerTurns, attempt.id);
            const observer = observers.get(run.id);
            const observedTurnId =
              observer?.attemptId === attempt.id ? observer.providerTurnId : null;
            const turnId =
              observedTurnId ??
              boundTurn?.id ??
              attempt.providerTurnId ??
              candidates.runs.find((candidate) => candidate.activeAttemptId === attempt.id)
                ?.providerTurnId ??
              null;
            const expiredUnbound =
              turnId === null &&
              attempt.startedAt !== null &&
              DateTime.toEpochMillis(now) - DateTime.toEpochMillis(attempt.startedAt) >= 120_000;
            if (!expiredUnbound && observer?.attemptId === attempt.id) continue;
            if (turnId === null && !expiredUnbound) continue;
            const root = state.nodes.find((node) => node.id === attempt.rootNodeId);
            const providerThread = state.providerThreads.find(
              (thread) => thread.id === attempt.providerThreadId,
            );
            if (root?.checkpointScopeId == null || providerThread === undefined) continue;
            const checkpoint = yield* projections.getCheckpointCaptureContext(threadId, {
              runId: run.id,
              scopeId: root.checkpointScopeId,
            });
            if (checkpoint.scope === undefined) continue;
            const runtime =
              providerThread.providerSessionId === null
                ? Option.none<ProviderAdapter.ProviderAdapterV2SessionRuntime>()
                : yield* sessions.get(providerThread.providerSessionId);
            const session = Option.isSome(runtime)
              ? runtime.value
              : ({
                  events: Stream.never,
                  reconcileTurn: () => Effect.succeed({ status: "process_gone", events: [] }),
                  interruptTurn: () => Effect.void,
                } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime);
            if (expiredUnbound && observer?.attemptId === attempt.id)
              yield* execution.stopObserving(run.id, attempt.id);
            yield* execution.startRootRun({
              observeOnly: true,
              commandId: CommandId.make(`command:liveness:${attempt.id}`),
              appThread: state.thread,
              run,
              attempt: { ...attempt, providerTurnId: turnId },
              attemptId: attempt.id,
              rootNode: root,
              providerThread,
              session,
              providerSessionId:
                providerThread.providerSessionId ??
                ProviderSessionId.make(`missing:${providerThread.id}`),
              checkpointScope: checkpoint.scope,
              providerTurnOrdinal: boundTurn?.ordinal ?? run.ordinal,
              modelSelection: run.modelSelection,
              runtimePolicy: yield* policy.resolve({
                thread: state.thread,
                modelSelection: run.modelSelection,
              }),
              message: {
                messageId: run.userMessageId,
                text: "",
                attachments: [],
                createdBy: "agent",
                creationSource: "provider",
              },
              shouldFinalizeRun: () =>
                projections
                  .getRunOutcome({ threadId, runId: run.id })
                  .pipe(Effect.map((outcome) => outcome?.status === "running")),
            });
          }
        }
      }),
    );
    const checkedSweep = sweep.pipe(Effect.mapError((cause) => new RunLivenessError({ cause })));
    const safeSweep = checkedSweep.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Run liveness reconciliation failed", { cause }),
      ),
    );
    return RunLivenessService.of({
      sweep: checkedSweep,
      start: Effect.gen(function* () {
        yield* forkParked(safeSweep.pipe(Effect.repeat(Schedule.spaced("30 seconds"))));
        yield* forkParked(execution.livenessSignals.pipe(Stream.runForEach(() => safeSweep)));
        yield* forkParked(
          sink.stream({ eventType: "provider-session.updated" }).pipe(
            Stream.filter(
              ({ event }) =>
                event.type === "provider-session.updated" &&
                (event.payload.status === "error" || event.payload.status === "stopped"),
            ),
            Stream.runForEach(() => safeSweep),
            Effect.catchCause((cause) =>
              Effect.logWarning("Run liveness signals failed", { cause }),
            ),
          ),
        );
      }),
    });
  }),
);
