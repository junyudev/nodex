import type { OrchestrationV2Run, OrchestrationV2ThreadProjection } from "@nodex/runtime-contracts";

import { isRuntimeDeliveryMessage, queuedMessageKind } from "./QueuedRunKind.ts";

export function isRuntimeDeliveryRun(
  projection: Pick<OrchestrationV2ThreadProjection, "messages">,
  run: OrchestrationV2Run,
): boolean {
  return projection.messages.some(
    (message) => message.id === run.userMessageId && isRuntimeDeliveryMessage(message),
  );
}

export function queuedRunsInDeliveryOrder(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "messages">,
): ReadonlyArray<OrchestrationV2Run> {
  const automaticMessageIds = new Set(
    projection.messages
      .filter((message) => message.createdBy !== "user" || queuedMessageKind(message) !== "message")
      .map((message) => message.id),
  );
  return projection.runs
    .filter((run) => run.status === "queued")
    .toSorted((left, right) => {
      const deliveryPriority =
        Number(automaticMessageIds.has(left.userMessageId)) -
        Number(automaticMessageIds.has(right.userMessageId));
      return (
        deliveryPriority ||
        (left.queuePosition ?? left.ordinal) - (right.queuePosition ?? right.ordinal) ||
        left.ordinal - right.ordinal
      );
    });
}
