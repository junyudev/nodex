import type { ThreadItem, ThreadItemEntry, UserInput } from "@nodex/codex-app-server-protocol/v2";
import {
  acpMcpToolCallInput,
  acpProjectedCommandExitCode,
  acpToolCallFileChanges,
  pathFromToolCall,
  textFromUnknown,
} from "@nodex/provider-acp/server/adapter";
import {
  type AcpToolCallState,
  acpContentBlockDisplayText,
  extractMcpToolCallIdentity,
  mergeToolCallState,
  parseSessionUpdateEvent,
} from "@nodex/provider-acp/server/runtimeModel";
import { normalizeAntigravityToolCall } from "../provider/acp/AntigravityProtocol.ts";
import type { ContentBlock, SessionNotification, ToolCallContent } from "effect-acp/compat";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { frozenNativeImportSource } from "./NativeImportSource.ts";

export class AntigravityHistoryError extends Schema.TaggedError<AntigravityHistoryError>()(
  "AntigravityHistoryError",
  { message: Schema.String },
) {}

type ReplayInput = { readonly cwd: string; readonly updates: readonly SessionNotification[] };
const messageRoles = {
  user_message_chunk: "user",
  agent_message_chunk: "agent",
  agent_thought_chunk: "thought",
  user_message: "user",
  agent_message: "agent",
  agent_thought: "thought",
} as const;
type MessageRole = (typeof messageRoles)[keyof typeof messageRoles];
type MessageUpdate = Extract<
  SessionNotification["update"],
  { sessionUpdate: keyof typeof messageRoles }
>;

type ReplayItem =
  | {
      readonly kind: "message";
      readonly role: MessageRole;
      readonly turnId: string;
      readonly id: string;
      parts: UserInput[];
    }
  | {
      readonly kind: "tool";
      readonly turnId: string;
      readonly id: string;
      state: AcpToolCallState;
      readonly chunks: ToolCallContent[];
    }
  | { readonly kind: "plan"; readonly turnId: string; readonly id: string; text: string };

type JsonValue = Extract<ThreadItem, { type: "dynamicToolCall" }>["arguments"];
const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value ?? null));
const record = (value: unknown) => (Predicate.isObject(value) ? value : undefined);

function toolItem(entry: Extract<ReplayItem, { kind: "tool" }>, cwd: string): ThreadItem {
  const { id, chunks } = entry;
  const tool = normalizeAntigravityToolCall(entry.state);
  const status =
    tool.status === "failed" ? "failed" : tool.status === "completed" ? "completed" : "inProgress";
  const input = tool.data.rawInput;
  const content = entry.state.data.content ?? (chunks.length ? chunks : undefined);
  const output = tool.data.rawOutput ?? content;
  const outputText =
    tool.data.rawOutput === undefined && content === chunks
      ? chunks
          .map((chunk) =>
            chunk.type === "content" ? acpContentBlockDisplayText(chunk.content) : "",
          )
          .join("")
      : textFromUnknown(output);
  const mcp = extractMcpToolCallIdentity(tool);
  if (mcp) {
    const envelope = record(output);
    const result = record(envelope?.result) ?? envelope;
    const mcpStatus = status === "completed" && result?.isError === true ? "failed" : status;
    const error = record(envelope?.error);
    return {
      type: "mcpToolCall",
      id,
      status: mcpStatus,
      server: mcp.server,
      environmentId: null,
      tool: mcp.tool,
      arguments: json(acpMcpToolCallInput(mcp, input)),
      appContext: null,
      mcpAppUi: null,
      pluginId: null,
      readOnlyHint: null,
      durationMs: null,
      result:
        output === undefined
          ? null
          : {
              content: Array.isArray(result?.content)
                ? result.content.map(json)
                : [{ type: "text", text: outputText ?? JSON.stringify(output) }],
              structuredContent: json(result?.structuredContent),
              _meta: json(result?._meta),
            },
      error:
        mcpStatus === "failed"
          ? {
              message:
                typeof error?.message === "string" ? error.message : (outputText ?? "Tool failed"),
            }
          : null,
    };
  }
  const changes = acpToolCallFileChanges(tool.data.content ?? content);
  if (changes.length > 0) {
    return {
      type: "fileChange",
      id,
      status,
      changes: changes.map((change) => ({
        path: change.oldPath ?? change.path,
        kind:
          change.operation === "add" || change.operation === "delete"
            ? { type: change.operation }
            : { type: "update", move_path: change.oldPath ? change.path : null },
        diff: change.diff ?? "",
      })),
    };
  }
  if (tool.kind === "execute") {
    const commandDetails = record(tool.data.item);
    const commandCwd = commandDetails?.cwd;
    return {
      type: "commandExecution",
      id,
      status,
      command: tool.command ?? tool.title ?? "Command",
      cwd: typeof commandCwd === "string" && commandCwd ? commandCwd : cwd,
      source: "agent",
      pluginId: null,
      scriptPath: null,
      processId: null,
      durationMs: null,
      commandActions: [],
      aggregatedOutput:
        typeof commandDetails?.aggregatedOutput === "string"
          ? commandDetails.aggregatedOutput
          : (outputText ?? (output === undefined ? null : JSON.stringify(output))),
      exitCode:
        typeof commandDetails?.exitCode === "number"
          ? commandDetails.exitCode
          : (acpProjectedCommandExitCode(status === "inProgress" ? "running" : status, output) ??
            null),
    };
  }
  const path = pathFromToolCall(tool);
  return {
    type: "dynamicToolCall",
    id,
    status,
    namespace: null,
    durationMs: null,
    tool: tool.kind === "read" ? "Read" : (tool.title ?? tool.kind ?? "Tool"),
    arguments: json(path && tool.kind === "read" ? { ...record(input), path } : (input ?? {})),
    contentItems:
      output === undefined
        ? null
        : [{ type: "inputText", text: outputText ?? JSON.stringify(output) }],
    success: status === "inProgress" ? null : status === "completed",
  };
}

const isMessageUpdate = (update: SessionNotification["update"]): update is MessageUpdate =>
  Object.hasOwn(messageRoles, update.sessionUpdate);

function messagePart(role: MessageRole, content: ContentBlock): UserInput[] {
  if (role === "user" && content.type === "image") {
    return [{ type: "image", url: `data:${content.mimeType};base64,${content.data}` }];
  }
  const text = acpContentBlockDisplayText(content);
  return text ? [{ type: "text", text, text_elements: [] }] : [];
}

function projectItem(entry: ReplayItem, cwd: string): ThreadItem {
  if (entry.kind === "tool") return toolItem(entry, cwd);
  if (entry.kind === "plan") return { type: "plan", id: entry.id, text: entry.text };
  if (entry.role === "user")
    return { type: "userMessage", id: entry.id, clientId: null, content: entry.parts };
  const text = entry.parts.map((part) => (part.type === "text" ? part.text : "")).join("\n");
  if (entry.role === "thought")
    return { type: "reasoning", id: entry.id, summary: [], content: [text] };
  return {
    type: "agentMessage",
    moderation: null,
    id: entry.id,
    text,
    phase: null,
    memoryCitation: null,
    delivery: null,
    questions: null,
  };
}

/** The first occurrence sets a row's position. Later chunks and tool snapshots enrich that row. */
export function foldAntigravityImportReplay(input: ReplayInput): ThreadItemEntry[] {
  const entries: ReplayItem[] = [];
  const tools = new Map<string, Extract<ReplayItem, { kind: "tool" }>>();
  const plans = new Map<string, Extract<ReplayItem, { kind: "plan" }>>();
  const identifiedMessages = new Map<string, Extract<ReplayItem, { kind: "message" }>>();
  let turn = 0;
  let consecutive: Extract<ReplayItem, { kind: "message" }> | undefined;
  const recordTool = (update: AcpToolCallState): Extract<ReplayItem, { kind: "tool" }> => {
    consecutive = undefined;
    const nativeId = update.toolCallId;
    const previous = tools.get(nativeId);
    const state = mergeToolCallState(previous?.state, update);
    if (previous) {
      previous.state = state;
      return previous;
    }
    const row = {
      kind: "tool" as const,
      turnId: String(turn),
      id: `tool:${nativeId}`,
      state,
      chunks: [],
    } satisfies Extract<ReplayItem, { kind: "tool" }>;
    tools.set(nativeId, row);
    entries.push(row);
    return row;
  };
  for (const notification of input.updates) {
    const update = notification.update;
    if (isMessageUpdate(update)) {
      const role = messageRoles[update.sessionUpdate];
      const snapshot = !update.sessionUpdate.endsWith("_chunk");
      if (update.content === undefined) continue;
      const parts = (
        Array.isArray(update.content)
          ? (update.content as readonly ContentBlock[])
          : update.content === null
            ? []
            : [update.content as ContentBlock]
      ).flatMap((content) => messagePart(role, content));
      if (!snapshot && !parts.length) continue;
      const messageId = update.messageId;
      const identity = messageId ? JSON.stringify([role, messageId]) : undefined;
      const previous = identity
        ? identifiedMessages.get(identity)
        : consecutive?.role === role && !consecutive.id.startsWith("message:native:")
          ? consecutive
          : undefined;
      const row = previous ?? {
        kind: "message",
        role,
        turnId: String(role === "user" ? ++turn : turn),
        id: identity ? `message:native:${identity}` : `message:${entries.length}`,
        parts: [],
      };
      if (!previous) {
        entries.push(row);
        if (identity) identifiedMessages.set(identity, row);
      }
      if (snapshot) row.parts = parts;
      else {
        const part = parts[0]!;
        const last = row.parts.at(-1);
        if (last?.type === "text" && part.type === "text") last.text += part.text;
        else row.parts.push(part);
      }
      consecutive = row;
      continue;
    }
    if (update.sessionUpdate === "tool_call_content_chunk") {
      recordTool({ toolCallId: update.toolCallId, data: {} }).chunks.push(update.content);
      continue;
    }
    for (const event of parseSessionUpdateEvent(notification).events) {
      if (event._tag === "UnknownUpdate")
        throw new AntigravityHistoryError({
          message:
            "Antigravity returned an unsupported conversation update, so this conversation can’t be copied.",
        });
      if (event._tag === "ToolCallUpdated") recordTool(event.toolCall);
      if (event._tag === "PlanUpdated") {
        consecutive = undefined;
        const plan = event.payload;
        const id = `plan:${turn}:${plan.nativePlanId}`;
        const text =
          plan.kind === "items"
            ? plan.plan
                .map(({ step, status }) => `- [${status === "completed" ? "x" : " "}] ${step}`)
                .join("\n")
            : plan.kind === "markdown"
              ? plan.markdown
              : null;
        if (text === null) continue;
        const previous = plans.get(id);
        if (previous) previous.text = text;
        else {
          const row = { kind: "plan" as const, turnId: String(turn), id, text };
          plans.set(id, row);
          entries.push(row);
        }
      }
    }
  }
  if (
    !entries.some(
      (entry) => entry.kind === "message" && entry.role !== "thought" && entry.parts.length > 0,
    )
  )
    throw new AntigravityHistoryError({
      message: "Antigravity didn't return this conversation's history, so it can't be copied.",
    });
  return entries
    .filter((entry) => entry.kind !== "message" || entry.parts.length > 0)
    .map((entry) => ({
      turnId: entry.turnId,
      item: projectItem(entry, input.cwd),
      startedAtMs: null,
      completedAtMs: null,
    }));
}

/** The reader connection has already closed when immutable history pages are read. */
export const openAntigravityImportSource = (input: ReplayInput) =>
  Effect.try({
    try: () =>
      frozenNativeImportSource(foldAntigravityImportReplay(input), input.cwd, "antigravity"),
    catch: (cause) =>
      cause instanceof AntigravityHistoryError
        ? cause
        : new AntigravityHistoryError({ message: "Could not read this Antigravity conversation." }),
  });
