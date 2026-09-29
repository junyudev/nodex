import type { SDKMessage, SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type {
  AgentCanonicalSessionUpdate,
  AgentConversationSnapshot,
} from "../../../shared/agent-conversation";
import {
  beginAgentConversationTurn,
  reduceAgentConversationEvent,
} from "../AgentConversationProjection";

const text = (value: unknown): string =>
  typeof value === "string"
    ? value.slice(0, 64 * 1024)
    : (JSON.stringify(value)?.slice(0, 64 * 1024) ?? "");
const Content = z.object({ type: z.string() }).catchall(z.unknown());
const Message = z.object({
  id: z.string().optional(),
  content: z.union([z.string(), z.array(Content)]),
});
type ToolUpdate = Extract<AgentCanonicalSessionUpdate, { kind: "tool-call" }>;
const toolKind = (name: string): ToolUpdate["toolKind"] => {
  if (name === "Read") return "read";
  if (name === "Write" || name === "Edit" || name === "MultiEdit") return "edit";
  if (name === "Bash") return "execute";
  if (name === "Glob" || name === "Grep") return "search";
  if (name === "WebFetch" || name === "WebSearch") return "fetch";
  return "other";
};
const tool = (
  id: string,
  name: string,
  detail: string,
  status: ToolUpdate["status"],
): ToolUpdate => ({
  kind: "tool-call",
  key: `tool:${id}`,
  toolCallId: id,
  title: name,
  name,
  toolKind: toolKind(name),
  status,
  detail,
  locations: [],
});
const update = (
  snapshot: AgentConversationSnapshot,
  sequence: number | null,
  value: AgentCanonicalSessionUpdate,
  append = false,
) =>
  reduceAgentConversationEvent(snapshot, {
    kind: "session_update",
    turnSequence: sequence,
    update: value,
    append,
  });

const projectContent = (
  snapshot: AgentConversationSnapshot,
  body: unknown,
  id: string,
  sequence: number | null,
  assistant: boolean,
): AgentConversationSnapshot => {
  const parsed = Message.safeParse(body);
  if (!parsed.success || typeof parsed.data.content === "string") return snapshot;
  let next = snapshot;
  for (const [index, part] of parsed.data.content.entries()) {
    const identity = `${parsed.data.id ?? id}:${index}`;
    if (assistant && (part.type === "text" || part.type === "thinking")) {
      const role = part.type === "text" ? "agent" : "thought";
      next = update(next, sequence, {
        kind: "message",
        key: `message:${identity}`,
        role,
        messageId: identity,
        text: text(part.text ?? part.thinking),
      });
      continue;
    }
    if (part.type === "tool_use" && typeof part.id === "string" && typeof part.name === "string") {
      next = update(next, sequence, {
        ...tool(part.id, part.name, "", "in_progress"),
        input: text(part.input),
      });
      continue;
    }
    if (part.type !== "tool_result" || typeof part.tool_use_id !== "string") continue;
    const previous = next.turns
      .flatMap(({ updates }) => updates)
      .find(
        (value): value is ToolUpdate =>
          value.kind === "tool-call" && value.toolCallId === part.tool_use_id,
      );
    next = update(next, sequence, {
      ...(previous ?? tool(part.tool_use_id, "Tool", "", "in_progress")),
      status: part.is_error ? "failed" : "completed",
      detail: text(part.content),
    });
  }
  return next;
};

/** Stream block IDs and final message IDs share one key, so final snapshots never duplicate deltas. */
export const createClaudeMessageProjection = () => {
  const streamIds = new Map<string, string>();
  let contextTokens = 0;
  const projectMessage = (
    snapshot: AgentConversationSnapshot,
    message: SDKMessage,
    sequence: number | null,
  ): AgentConversationSnapshot => {
    if (message.type === "assistant" || message.type === "user") {
      if (message.type === "assistant" && message.parent_tool_use_id === null) {
        const usage = message.message.usage;
        if (usage)
          contextTokens =
            usage.input_tokens +
            (usage.cache_read_input_tokens ?? 0) +
            (usage.cache_creation_input_tokens ?? 0);
      }
      return projectContent(
        snapshot,
        message.message,
        message.uuid ?? "user",
        sequence,
        message.type === "assistant",
      );
    }
    if (message.type === "stream_event") {
      const event = message.event;
      const parent = message.parent_tool_use_id ?? "root";
      if (event.type === "message_start") {
        if (streamIds.size >= 128) streamIds.clear();
        streamIds.set(parent, event.message.id);
        return snapshot;
      }
      if (event.type === "message_stop") {
        streamIds.delete(parent);
        return snapshot;
      }
      const id = streamIds.get(parent);
      if (!id || (event.type !== "content_block_start" && event.type !== "content_block_delta"))
        return snapshot;
      const identity = `${id}:${event.index}`;
      if (event.type === "content_block_start") {
        return projectContent(
          snapshot,
          {
            id,
            content: Array.from({ length: event.index }, () => ({ type: "ignored" })).concat(
              event.content_block,
            ),
          },
          id,
          sequence,
          true,
        );
      }
      const delta = event.delta;
      if (delta.type !== "text_delta" && delta.type !== "thinking_delta") return snapshot;
      return update(
        snapshot,
        sequence,
        {
          kind: "message",
          key: `message:${identity}`,
          role: delta.type === "text_delta" ? "agent" : "thought",
          messageId: identity,
          text: delta.type === "text_delta" ? delta.text : delta.thinking,
        },
        true,
      );
    }
    if (message.type === "result") {
      const usage = Object.values(message.modelUsage);
      return update(snapshot, sequence, {
        kind: "usage",
        key: "usage",
        used: contextTokens,
        size: Math.max(0, ...usage.map((value) => value.contextWindow)),
        cost: { amount: message.total_cost_usd, currency: "USD" },
      });
    }
    if (message.type === "rate_limit_event") {
      const info = message.rate_limit_info;
      if (info.status === "allowed") return snapshot;
      return update(snapshot, sequence, {
        kind: "message",
        key: "rate-limit",
        role: "agent",
        messageId: "rate-limit",
        text: `Claude usage limit ${info.status === "rejected" ? "reached" : "approaching"}${info.resetsAt ? ` · resets ${new Date(info.resetsAt * 1000).toISOString()}` : ""}.`,
      });
    }
    if (message.type !== "system") return snapshot;
    if (message.subtype === "commands_changed") {
      return update(snapshot, null, {
        kind: "commands",
        key: "commands",
        commands: message.commands.map((command) => ({
          name: command.name,
          description: command.description,
          inputHint: command.argumentHint ?? null,
        })),
      });
    }
    if (message.subtype === "compact_boundary") {
      return update(snapshot, sequence, {
        kind: "compaction",
        key: `compact:${message.uuid}`,
        compactionId: message.uuid,
        status: "completed",
        summary: "Context compacted",
        error: null,
      });
    }
    if (
      message.subtype === "task_started" ||
      message.subtype === "task_progress" ||
      message.subtype === "task_notification"
    ) {
      const existing = snapshot.turns
        .flatMap(({ updates }) => updates)
        .find(
          (value): value is ToolUpdate =>
            value.kind === "tool-call" && value.key === `task:${message.task_id}`,
        );
      const completed = message.subtype === "task_notification";
      return update(snapshot, sequence, {
        ...(existing ??
          tool(
            message.task_id,
            message.subtype === "task_started" ? message.description : "Subtask",
            "",
            "in_progress",
          )),
        key: `task:${message.task_id}`,
        detail: completed
          ? message.summary
          : message.subtype === "task_progress"
            ? message.description
            : message.description,
        status: completed
          ? message.status === "completed"
            ? "completed"
            : "failed"
          : "in_progress",
      });
    }
    if (message.subtype === "local_command_output") {
      return update(snapshot, sequence, {
        kind: "message",
        key: `command:${message.uuid}`,
        role: "agent",
        messageId: message.uuid,
        text: message.content,
      });
    }
    return snapshot;
  };
  return (snapshot: AgentConversationSnapshot, message: SDKMessage, sequence: number | null) => {
    const next = projectMessage(snapshot, message, sequence);
    // One SDK record is one observable mutation, even when it contains several content blocks.
    return next === snapshot ? snapshot : { ...next, revision: snapshot.revision + 1 };
  };
};

export const projectClaudeHistory = (
  snapshot: AgentConversationSnapshot,
  messages: readonly SessionMessage[],
): AgentConversationSnapshot => {
  let next = snapshot;
  let sequence = 0;
  for (const message of messages) {
    const parsed = Message.safeParse(message.message);
    if (!parsed.success) continue;
    const content = parsed.data.content;
    const prompt =
      typeof content === "string"
        ? content
        : content
            .filter((part) => part.type === "text")
            .map((part) => text(part.text))
            .join("\n");
    if (message.type === "user" && message.parent_tool_use_id === null && prompt) {
      sequence += 1;
      next = beginAgentConversationTurn(next, sequence, prompt);
    }
    next = projectContent(
      next,
      message.message,
      message.uuid,
      sequence || null,
      message.type === "assistant",
    );
  }
  return { ...next, status: "idle" };
};
