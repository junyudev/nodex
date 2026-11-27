import { createHash } from "node:crypto";
import type { ThreadItemEntry } from "@nodex/codex-app-server-protocol/v2";
import {
  EventId,
  PlanId,
  MessageId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type ThreadId,
  ProviderDriverKind,
  OrchestrationV2TurnItem,
  type ChatAttachment,
  type OrchestrationV2UnavailableImage,
  type OrchestrationV2ImportedImageLink,
} from "@nodex/runtime-contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { codexWebSearchFields } from "../orchestration-v2/Adapters/CodexWebSearch.ts";
import {
  codexFileChangeDetail,
  projectCodexPictureItem,
} from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { fileChangeItemFields } from "@nodex/runtime-shared/fileChanges";
import { mcpToolPresentation } from "@nodex/provider-core/server/mcpToolPresentation";
import { formatReadToolLabel } from "@nodex/runtime-shared/toolActivity";
import { toolReadImagePath } from "@nodex/runtime-shared/filePreview";
import { boundedToolOutputImage } from "@nodex/runtime-shared/toolOutput";
import { parseBase64DataUrl } from "../imageMime.ts";
import { nativeReadPath } from "./NativeImportSource.ts";

export const importIdentity = (...parts: readonly string[]): string =>
  createHash("sha256").update(JSON.stringify(parts)).digest("base64url");

/** Native history is read ancestry: it never recreates approvals, Runs or live child owners. */
export function importHistoryEvents(input: {
  readonly threadId: ThreadId;
  readonly entry: ThreadItemEntry;
  readonly ordinal: number;
  readonly driver?: ProviderDriverKind;
  readonly fallbackAt: DateTime.Utc;
  readonly attachments?: readonly ChatAttachment[];
  readonly unavailableImages?: readonly OrchestrationV2UnavailableImage[];
  readonly importedImageLinks?: readonly OrchestrationV2ImportedImageLink[];
}): readonly OrchestrationV2DomainEvent[] {
  const { threadId, entry, ordinal } = input;
  const driver = ProviderDriverKind.make(input.driver ?? "codex");
  const item = entry.item;
  const key = importIdentity(threadId, entry.turnId, item.id);
  const at = DateTime.makeUnsafe(
    entry.completedAtMs ?? entry.startedAtMs ?? DateTime.toEpochMillis(input.fallbackAt),
  );
  const base = {
    ...(input.unavailableImages?.length ? { unavailableImages: input.unavailableImages } : {}),
    id: TurnItemId.make(`native-import:${key}`),
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
    const messageId = MessageId.make(`native-import:${key}`);
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
      id: EventId.make(`native-import:message:${key}`),
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
  } else if (item.type === "fileChange") {
    turnItem = {
      ...base,
      type: "file_change",
      ...(fileChangeItemFields(item.changes.flatMap(codexFileChangeDetail)) ?? {
        fileName: "File change",
      }),
      status: item.status === "failed" || item.status === "declined" ? "failed" : "completed",
    };
  } else if (item.type === "webSearch") {
    turnItem = { ...base, type: "web_search", ...codexWebSearchFields(item) };
  } else if (item.type === "plan" && driver === "antigravity") {
    const planId = PlanId.make(`native-import:${key}`);
    turnItem = {
      ...base,
      type: "proposed_plan",
      planId,
      markdown: item.text,
      streaming: false,
    };
  } else if (item.type === "contextCompaction") {
    turnItem = { ...base, type: "compaction", driver: driver };
  } else if (item.type === "mcpToolCall") {
    turnItem = Schema.decodeUnknownSync(OrchestrationV2TurnItem)({
      ...base,
      type: "dynamic_tool",
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(driver === "antigravity"
        ? mcpToolPresentation({ serverName: item.server, toolName: item.tool })
        : {}),
      toolName:
        driver === "antigravity"
          ? `${item.server}.${item.tool}`
          : driver === "claudeAgent"
            ? `mcp__${item.server}__${item.tool}`
            : item.tool,
      input: item.arguments,
      output:
        driver === "antigravity"
          ? (item.error ?? item.result?.structuredContent ?? item.result?.content)
          : (item.result ?? item.error),
      status: item.status === "inProgress" ? "interrupted" : item.status,
      mcpToolCall: item,
    });
  } else if (item.type === "dynamicToolCall") {
    const readPath =
      driver === "antigravity" || driver === "claudeAgent" ? nativeReadPath(item) : undefined;
    const viewedImagePath = toolReadImagePath(readPath);
    turnItem = {
      ...base,
      ...(typeof readPath === "string" ? { title: formatReadToolLabel(readPath) } : {}),
      type: "dynamic_tool",
      ...(attachments.length > 0 ? { attachments } : {}),
      toolName: item.tool,
      input: item.arguments,
      ...(viewedImagePath === undefined ? {} : { viewedImagePath }),
      output: item.contentItems,
      status: item.status === "inProgress" ? "interrupted" : item.status,
    };
  } else if (item.type === "imageView" || item.type === "imageGeneration") {
    const { projection } = projectCodexPictureItem(item);
    turnItem = {
      ...base,
      type: "dynamic_tool",
      ...projection,
      status: projection.status === "running" ? "interrupted" : projection.status,
    };
  } else if (item.type === "functionCallOutput") {
    turnItem = {
      ...base,
      type: "dynamic_tool",
      ...(attachments.length > 0 ? { attachments } : {}),
      toolName: item.name,
      input: item.namespace === null ? {} : { namespace: item.namespace },
      output: Array.isArray(item.output)
        ? item.output.map((block) => {
            if (block.type === "input_text") return { type: "inputText", text: block.text };
            if (block.type !== "input_image" || !("image_url" in block)) return block;
            const inline = parseBase64DataUrl(block.image_url);
            if (!inline) return block;
            const image = { type: "image", mimeType: inline.mimeType, data: inline.base64 };
            return boundedToolOutputImage(image) ? image : block;
          })
        : item.output,
    };
  } else {
    turnItem = {
      ...base,
      type: "dynamic_tool",
      toolName: item.type,
      input: {},
      output: item,
      ...(attachments.length > 0 ? { attachments } : {}),
    };
  }
  events.push({
    id: EventId.make(`native-import:item:${key}`),
    type: "turn-item.updated",
    threadId,
    occurredAt: at,
    payload: turnItem,
  });
  return events;
}
