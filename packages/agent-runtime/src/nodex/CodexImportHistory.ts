import { createHash } from "node:crypto";
import type { ThreadItemEntry } from "@nodex/codex-app-server-protocol/v2";
import {
  EventId,
  MessageId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type ThreadId,
  ProviderDriverKind,
  OrchestrationV2TurnItem,
  type ChatAttachment,
  type OrchestrationV2UnavailableImage,
  type OrchestrationV2ImportedImageLink,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

export const importIdentity = (...parts: readonly string[]): string =>
  createHash("sha256").update(JSON.stringify(parts)).digest("base64url");

/** Native history is read ancestry: it never recreates approvals, Runs or live child owners. */
export function importHistoryEvents(input: {
  readonly threadId: ThreadId;
  readonly entry: ThreadItemEntry;
  readonly ordinal: number;
  readonly fallbackAt: DateTime.Utc;
  readonly attachments?: readonly ChatAttachment[];
  readonly unavailableImages?: readonly OrchestrationV2UnavailableImage[];
  readonly importedImageLinks?: readonly OrchestrationV2ImportedImageLink[];
}): readonly OrchestrationV2DomainEvent[] {
  const { threadId, entry, ordinal } = input;
  const driver = ProviderDriverKind.make("codex");
  const item = entry.item;
  const key = importIdentity(threadId, entry.turnId, item.id);
  const at = DateTime.makeUnsafe(
    entry.completedAtMs ?? entry.startedAtMs ?? DateTime.toEpochMillis(input.fallbackAt),
  );
  const base = {
    ...(input.unavailableImages?.length ? { unavailableImages: input.unavailableImages } : {}),
    id: TurnItemId.make(`codex-import:${key}`),
    threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: {
      driver: driver,
      nativeId: item.id,
      strength: "strong" as const,
    },
    parentItemId: null,
    ordinal,
    status: "completed" as const,
    title: null,
    startedAt: DateTime.makeUnsafe(entry.startedAtMs ?? DateTime.toEpochMillis(at)),
    completedAt: at,
    updatedAt: at,
  };
  const attachments = input.attachments ?? [];
  let turnItem: OrchestrationV2TurnItem;
  const events: OrchestrationV2DomainEvent[] = [];
  if (item.type === "userMessage" || item.type === "agentMessage") {
    const messageId = MessageId.make(`codex-import:${key}`);
    const text =
      item.type === "agentMessage"
        ? item.text
        : item.content
            .flatMap((part) => {
              if (part.type === "text") return [part.text];
              if (part.type === "skill" || part.type === "mention") return [`$${part.name}`];
              if (part.type === "audio" || part.type === "localAudio") return ["[Audio]"];
              return [];
            })
            .join("\n");
    events.push({
      id: EventId.make(`codex-import:message:${key}`),
      type: "message.updated",
      threadId,
      occurredAt: at,
      payload: {
        id: messageId,
        threadId,
        runId: null,
        nodeId: null,
        createdBy: item.type === "userMessage" ? "user" : "agent",
        creationSource: "server",
        role: item.type === "userMessage" ? "user" : "assistant",
        text,
        attachments,
        streaming: false,
        createdAt: base.startedAt,
        updatedAt: at,
      },
    });
    turnItem =
      item.type === "userMessage"
        ? {
            ...base,
            type: "user_message",
            messageId,
            inputIntent: "turn_start",
            createdBy: "user",
            creationSource: "server",
            text,
            attachments,
          }
        : {
            ...base,
            type: "assistant_message",
            messageId,
            text,
            ...(attachments.length > 0 ? { attachments } : {}),
            ...(input.importedImageLinks?.length
              ? { importedImageLinks: input.importedImageLinks }
              : {}),
            streaming: false,
            ...(item.memoryCitation === null ? {} : { memoryCitation: item.memoryCitation }),
          };
  } else if (item.type === "reasoning") {
    turnItem = {
      ...base,
      type: "reasoning",
      text: [...item.summary, ...item.content].join("\n\n"),
      streaming: false,
    };
  } else if (item.type === "commandExecution") {
    turnItem = {
      ...base,
      type: "command_execution",
      input: item.command,
      ...(item.aggregatedOutput === null ? {} : { output: item.aggregatedOutput }),
      ...(item.exitCode === null ? {} : { exitCode: item.exitCode }),
      commandActions: item.commandActions,
      status: item.status === "failed" || item.status === "declined" ? "failed" : "completed",
    };
  } else if (item.type === "contextCompaction") {
    turnItem = { ...base, type: "compaction", driver: driver };
  } else if (item.type === "mcpToolCall") {
    turnItem = Schema.decodeUnknownSync(OrchestrationV2TurnItem)({
      ...base,
      type: "dynamic_tool",
      toolName: item.tool,
      input: item.arguments,
      output: item.result ?? item.error,
      mcpToolCall: item,
    });
  } else if (item.type === "dynamicToolCall") {
    turnItem = {
      ...base,
      type: "dynamic_tool",
      toolName: item.tool,
      input: item.arguments,
      output: item.contentItems,
    };
  } else if (item.type === "imageView") {
    turnItem = {
      ...base,
      type: "dynamic_tool",
      toolName: "imageView",
      input: { path: item.path },
      output: { type: "imageView", sourcePath: item.path },
      ...(attachments.length > 0 ? { attachments } : {}),
    };
  } else {
    turnItem = { ...base, type: "dynamic_tool", toolName: item.type, input: {}, output: item };
  }
  events.push({
    id: EventId.make(`codex-import:item:${key}`),
    type: "turn-item.updated",
    threadId,
    occurredAt: at,
    payload: turnItem,
  });
  return events;
}
