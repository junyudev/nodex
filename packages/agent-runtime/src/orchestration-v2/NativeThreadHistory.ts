import {
  EventId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import type * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";

/** A native import is read ancestry, never a synthetic Run or a new user prompt. */
export function nativeThreadHistoryEvents(input: {
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly messages: ReadonlyArray<OrchestrationV2ConversationMessage>;
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
}): ReadonlyArray<OrchestrationV2DomainEvent> {
  const { providerThread, idAllocator } = input;
  if (providerThread.appThreadId === null) return [];
  const threadId = providerThread.appThreadId;
  return input.messages.flatMap((source, index) => {
    const message: OrchestrationV2ConversationMessage = {
      ...source,
      threadId,
      runId: null,
      nodeId: null,
      streaming: false,
    };
    const nativeItemId = `${providerThread.id}:import:${message.id}`;
    const base = {
      id: idAllocator.derive.turnItemFromProviderItem({
        driver: providerThread.driver,
        nativeItemId,
      }),
      threadId,
      runId: null,
      nodeId: null,
      providerThreadId: providerThread.id,
      providerTurnId: null,
      nativeItemRef: {
        driver: providerThread.driver,
        nativeId: nativeItemId,
        strength: "weak" as const,
      },
      parentItemId: null,
      ordinal: index + 1,
      status: "completed" as const,
      title: null,
      startedAt: message.createdAt,
      completedAt: message.updatedAt,
      updatedAt: message.updatedAt,
      messageId: message.id,
      text: message.text,
      attachments: message.attachments,
    };
    const item: OrchestrationV2TurnItem =
      message.role === "user"
        ? {
            ...base,
            type: "user_message",
            inputIntent: "turn_start",
            createdBy: message.createdBy,
            creationSource: message.creationSource,
          }
        : { ...base, type: "assistant_message", streaming: false };
    return [
      {
        id: EventId.make(`native-history:${nativeItemId}:message`),
        type: "message.updated",
        threadId,
        driver: providerThread.driver,
        providerInstanceId: providerThread.providerInstanceId,
        occurredAt: message.updatedAt,
        payload: message,
      },
      {
        id: EventId.make(`native-history:${nativeItemId}:item`),
        type: "turn-item.updated",
        threadId,
        driver: providerThread.driver,
        providerInstanceId: providerThread.providerInstanceId,
        occurredAt: message.updatedAt,
        payload: item,
      },
    ];
  });
}
