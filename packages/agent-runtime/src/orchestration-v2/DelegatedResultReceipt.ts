import { TASK_RESULT_DELIVERY_META, TaskResultDelivery } from "../mcp/TaskResultDelivery.ts";
import {
  ContextTransferId,
  NodeId,
  type MessageId,
  type RunId,
  type ProviderTurnId,
  type ThreadId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import type * as ProjectionStore from "./ProjectionStore.ts";

const decodeDelivery = Schema.decodeUnknownOption(
  Schema.Struct({
    _meta: Schema.Struct({ [TASK_RESULT_DELIVERY_META]: TaskResultDelivery }),
  }),
);

export function observedTaskResults(item: OrchestrationV2TurnItem): TaskResultDelivery | undefined {
  if (item.type !== "dynamic_tool" || item.status !== "completed") return undefined;
  const decoded = decodeDelivery(item.mcpToolCall?.result ?? item.output);
  return Option.isSome(decoded) ? decoded.value._meta[TASK_RESULT_DELIVERY_META] : undefined;
}

/** The handoff receipt is the single native-delivery truth, shared by SQL and turn preparation. */
export const delegatedResultReceipts = Effect.fn("delegatedResultReceipts")(function* (input: {
  readonly store: ProjectionStore.ProjectionStoreV2["Service"];
  readonly threadId: ThreadId;
  readonly observedByRunId: RunId;
  readonly taskIds: readonly NodeId[];
  readonly transferIds?: readonly ContextTransferId[];
  readonly messageId?: MessageId;
  readonly messageText?: string;
  readonly providerTurnId?: ProviderTurnId | null;
  readonly observation?: TaskResultDelivery;
}) {
  if (input.taskIds.length === 0) return [];
  const records = yield* input.store.getThreadRecords(input.threadId, ["runs", "subagents"], {
    runIds: [input.observedByRunId],
    subagentIds: input.taskIds,
  });
  const run = records.runs[0];
  if (run?.activeAttemptId == null || run.providerThreadId === null) return [];
  const attempts = yield* input.store.getThreadRecords(
    input.threadId,
    ["attempts", "providerThreads"],
    {
      attemptIds: [run.activeAttemptId],
      providerThreadIds: [run.providerThreadId],
    },
  );
  const attempt = attempts.attempts[0];
  if (
    attempt?.nativeThreadId === undefined ||
    attempt.providerThreadId !== run.providerThreadId ||
    attempts.providerThreads[0]?.nativeThreadRef?.nativeId !== attempt.nativeThreadId
  )
    return [];
  if (
    input.observation !== undefined &&
    (input.observation.threadId !== input.threadId ||
      input.observation.runId !== run.id ||
      input.observation.attemptId !== attempt.id ||
      input.observation.providerThreadId !== run.providerThreadId ||
      input.observation.nativeThreadId !== attempt.nativeThreadId ||
      input.providerTurnId == null)
  )
    return [];
  if (input.providerTurnId != null) {
    const turns = yield* input.store.getThreadRecords(input.threadId, ["providerTurns"], {
      providerTurnAttemptIds: [attempt.id],
    });
    if (!turns.providerTurns.some((turn) => turn.id === input.providerTurnId)) return [];
  }
  const transfers = yield* input.store.getThreadRecords(input.threadId, ["contextTransfers"], {
    contextTransferThreadIds: records.subagents
      .filter(
        (task) =>
          input.messageId === undefined ||
          (task.result !== null &&
            task.result.length > 0 &&
            input.messageText?.includes(task.result)),
      )
      .flatMap((task) => (task.childThreadId === null ? [] : [task.childThreadId])),
    contextTransferTargetThreadId: input.threadId,
    contextTransferTypes: ["subagent_result"],
  });
  const handoffs = yield* input.store.getThreadRecords(input.threadId, ["contextHandoffs"], {
    contextHandoffTransferIds: transfers.contextTransfers
      .filter(
        (transfer) => input.transferIds === undefined || input.transferIds.includes(transfer.id),
      )
      .map((transfer) => transfer.id),
  });
  const now = yield* DateTime.now;
  return handoffs.contextHandoffs
    .filter(
      (handoff) =>
        records.subagents.some((task) => task.result === handoff.summaryText) &&
        handoff.toProviderThreadId === run.providerThreadId &&
        !(
          handoff.delivery?.nativeThreadId === attempt.nativeThreadId &&
          handoff.delivery?.status !== "pending"
        ),
    )
    .map((handoff) => ({
      ...handoff,
      updatedAt: now,
      delivery: {
        nativeThreadId: attempt.nativeThreadId!,
        status: "observed" as const,
        itemIds: [],
        acceptedByRunId: run.id,
        ...(input.messageId === undefined ? {} : { acceptedMessageId: input.messageId }),
      },
    }));
});
