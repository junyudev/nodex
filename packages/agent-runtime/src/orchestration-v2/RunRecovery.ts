import {
  CommandId,
  isProviderNativeSubagentThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2TurnItem,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2ThreadProjection,
} from "@nodex/runtime-contracts";
import { modelSelectionsEqual } from "@nodex/runtime-shared/model";
import * as Effect from "effect/Effect";
import type * as DateTime from "effect/DateTime";
import type * as IdAllocator from "@nodex/provider-core/server/IdAllocator";
import type { EventSinkV2Shape } from "./EventSink.ts";
import * as Option from "effect/Option";
import type { EffectOutboxV2Shape } from "./EffectOutbox.ts";
import type { ProjectionStoreV2Shape } from "./ProjectionStore.ts";
import { isRunRecoveryEligible, nextRunRecovery } from "./RunRecoveryPolicy.ts";
import { isNativeMaintenanceCommand } from "./nativeMaintenanceCommand.ts";

export const recoveryEffectId = (runId: OrchestrationV2Run["id"], attemptOrdinal: number) =>
  `effect:run.recover:${runId}:${attemptOrdinal}`;
export const recoveryCommandId = (runId: OrchestrationV2Run["id"], attemptOrdinal: number) =>
  CommandId.make(`command:run.recover:${runId}:${attemptOrdinal}`);

export type RunRecoveryContext = Pick<
  OrchestrationV2ThreadProjection,
  "thread" | "runs" | "attempts" | "messages" | "turnItems" | "providerTurns"
>;

/** Read the addressed attempt and newest competing work, never the thread's historical bodies. */
export const readRunRecoveryContext = Effect.fnUntraced(function* (
  projections: Pick<ProjectionStoreV2Shape, "getThreadRecords">,
  input: {
    readonly threadId: OrchestrationV2Run["threadId"];
    readonly runId: OrchestrationV2Run["id"];
    readonly userMessageId: OrchestrationV2Run["userMessageId"];
    readonly attemptId: OrchestrationV2RunAttempt["id"];
  },
) {
  const current = yield* projections.getThreadRecords(
    input.threadId,
    ["runs", "attempts", "messages", "turnItems", "providerTurns"],
    {
      runIds: [input.runId],
      attemptIds: [input.attemptId],
      providerTurnAttemptIds: [input.attemptId],
      messageIds: [input.userMessageId],
      turnItemRunId: input.runId,
      turnItemTypes: ["error", "run_interrupt_request"],
    },
  );
  const latest = yield* projections.getThreadRecords(input.threadId, ["runs"], {
    runStatuses: [
      "preparing",
      "starting",
      "running",
      "waiting",
      "completed",
      "failed",
      "interrupted",
      "rolled_back",
    ],
    runOrder: "desc",
    runLimit: 1,
  });
  return {
    ...current,
    runs: [...current.runs, ...latest.runs.filter((run) => run.id !== input.runId)],
  } satisfies RunRecoveryContext;
});

export function eligibleRunRecovery(context: RunRecoveryContext, run: OrchestrationV2Run): boolean {
  const message = context.messages.find((message) => message.id === run.userMessageId);
  return (
    message !== undefined &&
    isRunRecoveryEligible({
      runStatus: run.status,
      isRootTurn: true,
      isNativeSubagentTurn: isProviderNativeSubagentThread(context.thread),
      isMaintenanceCommand: isNativeMaintenanceCommand(message),
      threadArchived: context.thread.archivedAt !== null,
      threadDeleted: context.thread.deletedAt !== null,
      interruptRequested: context.turnItems.some(
        (item) => item.runId === run.id && item.type === "run_interrupt_request",
      ),
      messageDelivery: message.delivery ?? "unknown",
      // An explicitly queued message waits behind this reply; it does not supersede it.
      hasNewerUserWork: context.runs.some(
        (candidate) =>
          candidate.ordinal > run.ordinal &&
          candidate.status !== "queued" &&
          candidate.status !== "cancelled",
      ),
      providerSelectionChanged: !modelSelectionsEqual(
        context.thread.modelSelection,
        run.modelSelection,
      ),
    })
  );
}

/** Settle a root failure under its thread lock, regardless of whether native turn start succeeded. */
export const settleFailedRunAttempt = Effect.fn("orchestrationV2.settleFailedRunAttempt")(
  function* <E, R>(input: {
    readonly ids: IdAllocator.IdAllocatorV2["Service"];
    readonly sink: Pick<EventSinkV2Shape, "writeIfRunCurrent">;
    readonly context: RunRecoveryContext;
    readonly run: OrchestrationV2Run;
    readonly attempt: OrchestrationV2RunAttempt;
    readonly rootNode: OrchestrationV2ExecutionNode;
    readonly failureItem: Extract<OrchestrationV2TurnItem, { type: "error" }>;
    readonly now: DateTime.Utc;
    readonly events?: ReadonlyArray<OrchestrationV2DomainEvent>;
    readonly providerThread?: OrchestrationV2ProviderThread;
    readonly providerTurn?: OrchestrationV2ProviderTurn;
    readonly finalize: Effect.Effect<void, E, R>;
  }) {
    const { context, run, attempt, rootNode, failureItem, now } = input;
    // A failed attempt with a missing timer must settle, not consume another retry budget.
    const alreadyFailed = context.attempts.some(
      (candidate) => candidate.id === attempt.id && candidate.status === "failed",
    );
    const decision =
      !alreadyFailed && eligibleRunRecovery(context, run)
        ? nextRunRecovery({
            failure: failureItem.failure,
            streak: run.recovery ?? null,
            now,
          })
        : { kind: "none" as const };
    if (decision.kind === "none" || decision.status !== "scheduled") {
      yield* input.finalize;
      return;
    }
    const { ids, sink } = input;
    const { status: _status, delayMs, ...recovery } = decision;
    const attemptOrdinal =
      Math.max(
        attempt.attemptOrdinal,
        ...context.attempts
          .filter((candidate) => candidate.runId === run.id)
          .map((candidate) => candidate.attemptOrdinal),
      ) + 1;
    const payloads = [
      {
        type: "turn-item.updated" as const,
        payload: {
          ...failureItem,
          status: "running" as const,
          completedAt: null,
          updatedAt: now,
          retry: {
            attempt: recovery.attempt,
            maxAttempts: recovery.maxAttempts,
            retryDelayMs: delayMs,
          },
        },
      },
      {
        type: "run-attempt.updated" as const,
        payload: { ...attempt, status: "failed" as const, completedAt: now },
      },
      {
        type: "node.updated" as const,
        payload: { ...rootNode, status: "failed" as const, completedAt: now },
      },
      ...(input.providerTurn === undefined
        ? []
        : [{ type: "provider-turn.updated" as const, payload: input.providerTurn }]),
      ...(input.providerThread === undefined
        ? []
        : [
            {
              type: "provider-thread.updated" as const,
              payload: { ...input.providerThread, status: "idle" as const, updatedAt: now },
            },
          ]),
      {
        type: "run.updated" as const,
        payload: {
          ...run,
          status: "running" as const,
          recovery,
          completedAt: null,
        },
      },
    ];
    const events = yield* Effect.forEach(payloads, (event) =>
      Effect.gen(function* () {
        return {
          id: yield* ids.allocate.event({ threadId: run.threadId }),
          threadId: run.threadId,
          runId: run.id,
          nodeId: rootNode.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          ...event,
        };
      }),
    );
    yield* sink.writeIfRunCurrent({
      threadId: run.threadId,
      runId: run.id,
      activeAttemptId: attempt.id,
      expectedStatus: run.status,
      events: [...(input.events ?? []), ...events],
      effects: [
        {
          id: recoveryEffectId(run.id, attemptOrdinal),
          commandId: recoveryCommandId(run.id, attemptOrdinal),
          threadId: run.threadId,
          availableAt: recovery.nextAttemptAt,
          request: { type: "run.recover", runId: run.id, attemptOrdinal },
        },
      ],
    });
  },
);

/** A streak survives an in-flight attempt. Only a failed attempt with its durable timer may wait. */
export const hasPendingRunRecovery = Effect.fnUntraced(function* (
  run: OrchestrationV2Run,
  attempts: ReadonlyArray<OrchestrationV2RunAttempt>,
  outbox: Pick<EffectOutboxV2Shape, "get">,
) {
  if (run.status !== "running" || run.recovery === undefined) return false;
  const attempt = attempts.find((candidate) => candidate.id === run.activeAttemptId);
  if (attempt?.status !== "failed") return false;
  const effect = yield* outbox.get(recoveryEffectId(run.id, attempt.attemptOrdinal + 1));
  return (
    Option.isSome(effect) &&
    effect.value.threadId === run.threadId &&
    (effect.value.status === "pending" || effect.value.status === "running") &&
    effect.value.request.type === "run.recover" &&
    effect.value.request.runId === run.id &&
    effect.value.request.attemptOrdinal === attempt.attemptOrdinal + 1
  );
});

export function withoutRunRecovery(run: OrchestrationV2Run): OrchestrationV2Run {
  const { recovery: _recovery, ...rest } = run;
  return rest;
}

export function runRecoverySummary(
  run: Pick<OrchestrationV2Run, "status" | "recovery"> | undefined,
) {
  const recovery = run?.recovery;
  if ((run?.status !== "running" && run?.status !== "starting") || recovery === undefined)
    return null;
  return {
    kind: recovery.kind,
    attempt: recovery.attempt,
    maxAttempts: recovery.maxAttempts,
    nextAttemptAt: recovery.nextAttemptAt,
  };
}
