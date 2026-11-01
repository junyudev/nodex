import {
  CommandId,
  isProviderNativeSubagentThread,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { EffectOutboxV2Shape } from "./EffectOutbox.ts";
import type { ProjectionStoreV2Shape } from "./ProjectionStore.ts";
import { isRunRecoveryEligible } from "./RunRecoveryPolicy.ts";
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
