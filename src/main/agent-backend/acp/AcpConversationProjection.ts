import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type {
  AgentCanonicalSessionUpdate,
  AgentConversationSnapshot,
} from "../../../shared/agent-conversation";
import type { AcpSessionRuntimeEvent } from "./AcpSessionRuntime";

import { reduceAgentConversationEvent as reduceCanonicalEvent } from "../AgentConversationProjection";
const MAX_TEXT_CHARACTERS = 64 * 1024;
const MAX_COLLECTION_ITEMS = 128;
const boundedString = (value: string, maximum = MAX_TEXT_CHARACTERS): string =>
  value.length <= maximum ? value : `${value.slice(0, maximum)}\n[output truncated]`;
const record = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};

const boundedDiagnosticText = (value: unknown): string => {
  if (typeof value === "string") return boundedString(value);
  try {
    return boundedString(JSON.stringify(value));
  } catch {
    return "[unavailable output]";
  }
};

const contentText = (value: unknown): string => {
  const content = record(value);
  if (content.type === "text" && typeof content.text === "string") return content.text;
  if (content.type === "resource_link" && typeof content.uri === "string") return content.uri;
  if (content.type === "resource") {
    const resource = record(content.resource);
    if (typeof resource.uri === "string") return resource.uri;
  }
  if (content.type === "image") return "[image]";
  if (content.type === "audio") return "[audio]";
  return "";
};

const toolDetail = (update: Readonly<Record<string, unknown>>): string => {
  const content = Array.isArray(update.content)
    ? update.content
        .slice(0, MAX_COLLECTION_ITEMS)
        .map((entry) => {
          const item = record(entry);
          if (item.type === "content") return contentText(item.content);
          if (item.type === "diff") {
            const path = typeof item.path === "string" ? item.path : "file";
            return `[diff: ${path}]`;
          }
          if (item.type === "terminal") return "[terminal output]";
          return "";
        })
        .filter(Boolean)
        .join("\n")
    : "";
  const rawOutput = update.rawOutput === undefined ? "" : boundedDiagnosticText(update.rawOutput);
  return boundedString([content, rawOutput].filter(Boolean).join("\n"));
};

const toolLocations = (update: Readonly<Record<string, unknown>>): readonly string[] =>
  Array.isArray(update.locations)
    ? update.locations
        .slice(0, MAX_COLLECTION_ITEMS)
        .map((entry) => record(entry).path)
        .filter((path): path is string => typeof path === "string")
        .map((path) => boundedString(path, 4_096))
    : [];

const messageRole = (
  sessionUpdate: string,
): Extract<AgentCanonicalSessionUpdate, { readonly kind: "message" }>["role"] => {
  if (sessionUpdate === "user_message_chunk") return "user";
  if (sessionUpdate === "agent_thought_chunk") return "thought";
  if (sessionUpdate === "compaction_summary_chunk") return "compaction";
  return "agent";
};

const messageKey = (
  updates: readonly AgentCanonicalSessionUpdate[],
  role: Extract<AgentCanonicalSessionUpdate, { readonly kind: "message" }>["role"],
  messageId: string | null,
): string => {
  if (messageId) return `message:${role}:${messageId}`;
  const previous = updates.at(-1);
  if (previous?.kind === "message" && previous.role === role && previous.messageId === null) {
    return previous.key;
  }
  return `message:${role}:anonymous-${updates.length}`;
};

const planUpdate = (
  update: Readonly<Record<string, unknown>>,
): Extract<AgentCanonicalSessionUpdate, { readonly kind: "plan" }> => {
  type PlanEntry = Extract<
    AgentCanonicalSessionUpdate,
    { readonly kind: "plan" }
  >["entries"][number];
  const sessionUpdate = String(update.sessionUpdate);
  const plan = sessionUpdate === "plan_update" ? record(update.plan) : update;
  const planId =
    typeof plan.planId === "string"
      ? boundedString(plan.planId, 512)
      : typeof update.planId === "string"
        ? boundedString(update.planId, 512)
        : null;
  const entries = Array.isArray(plan.entries)
    ? plan.entries.slice(0, MAX_COLLECTION_ITEMS).flatMap((entry): PlanEntry[] => {
        const item = record(entry);
        if (
          typeof item.content !== "string" ||
          (item.priority !== "high" && item.priority !== "medium" && item.priority !== "low") ||
          (item.status !== "pending" &&
            item.status !== "in_progress" &&
            item.status !== "completed")
        ) {
          return [];
        }
        const priority = item.priority as PlanEntry["priority"];
        const status = item.status as PlanEntry["status"];
        return [{ content: boundedString(item.content, 8_192), priority, status }];
      })
    : [];
  return {
    kind: "plan",
    key: `plan:${planId ?? "default"}`,
    planId,
    state: sessionUpdate === "plan_removed" ? "removed" : "present",
    entries,
    markdown: typeof plan.content === "string" ? boundedString(plan.content) : null,
    uri: typeof plan.uri === "string" ? boundedString(plan.uri, 4_096) : null,
  };
};

const canonicalUpdate = (
  updates: readonly AgentCanonicalSessionUpdate[],
  value: SessionUpdate,
): AgentCanonicalSessionUpdate => {
  const update = record(value);
  const sessionUpdate = value.sessionUpdate;
  if (
    sessionUpdate === "user_message_chunk" ||
    sessionUpdate === "agent_message_chunk" ||
    sessionUpdate === "agent_thought_chunk" ||
    sessionUpdate === "compaction_summary_chunk"
  ) {
    const role = messageRole(sessionUpdate);
    const messageId = typeof update.messageId === "string" ? update.messageId : null;
    return {
      kind: "message",
      key: messageKey(updates, role, messageId),
      role,
      messageId,
      text: boundedString(contentText(update.content)),
    };
  }
  if (sessionUpdate === "tool_call" || sessionUpdate === "tool_call_update") {
    const toolCallId =
      typeof update.toolCallId === "string"
        ? boundedString(update.toolCallId, 512)
        : `unknown-${updates.length}`;
    const toolKind =
      update.kind === "read" ||
      update.kind === "edit" ||
      update.kind === "delete" ||
      update.kind === "move" ||
      update.kind === "search" ||
      update.kind === "execute" ||
      update.kind === "think" ||
      update.kind === "fetch" ||
      update.kind === "switch_mode" ||
      update.kind === "other"
        ? update.kind
        : null;
    const status =
      update.status === "pending" ||
      update.status === "in_progress" ||
      update.status === "completed" ||
      update.status === "failed"
        ? update.status
        : "pending";
    return {
      kind: "tool-call",
      key: `tool:${toolCallId}`,
      toolCallId,
      title: typeof update.title === "string" ? boundedString(update.title, 8_192) : "Tool call",
      name: typeof update.name === "string" ? boundedString(update.name, 512) : null,
      toolKind,
      status,
      detail: toolDetail(update),
      locations: toolLocations(update),
    };
  }
  if (
    sessionUpdate === "plan" ||
    sessionUpdate === "plan_update" ||
    sessionUpdate === "plan_removed"
  ) {
    return planUpdate(update);
  }
  if (sessionUpdate === "current_mode_update") {
    return {
      kind: "mode",
      key: "mode",
      currentModeId:
        typeof update.currentModeId === "string" ? boundedString(update.currentModeId, 512) : "",
    };
  }
  if (sessionUpdate === "config_option_update") {
    return {
      kind: "config",
      key: "config",
      optionIds: Array.isArray(update.configOptions)
        ? update.configOptions
            .slice(0, MAX_COLLECTION_ITEMS)
            .map((option) => record(option).id)
            .filter((id): id is string => typeof id === "string")
            .map((id) => boundedString(id, 512))
        : [],
    };
  }
  if (sessionUpdate === "session_info_update") {
    return {
      kind: "session-info",
      key: "session-info",
      title: typeof update.title === "string" ? boundedString(update.title, 8_192) : null,
      updatedAt: typeof update.updatedAt === "string" ? boundedString(update.updatedAt, 256) : null,
    };
  }
  if (sessionUpdate === "usage_update") {
    const cost = record(update.cost);
    return {
      kind: "usage",
      key: "usage",
      used: typeof update.used === "number" && Number.isFinite(update.used) ? update.used : 0,
      size: typeof update.size === "number" && Number.isFinite(update.size) ? update.size : 0,
      cost:
        typeof cost.amount === "number" &&
        Number.isFinite(cost.amount) &&
        typeof cost.currency === "string"
          ? { amount: cost.amount, currency: boundedString(cost.currency, 16) }
          : null,
    };
  }
  if (sessionUpdate === "available_commands_update") {
    return {
      kind: "commands",
      key: "commands",
      commands: Array.isArray(update.availableCommands)
        ? update.availableCommands.slice(0, MAX_COLLECTION_ITEMS).flatMap((command) => {
            const item = record(command);
            if (typeof item.name !== "string" || typeof item.description !== "string") return [];
            return [
              {
                name: boundedString(item.name, 512),
                description: boundedString(item.description, 4_096),
                inputHint:
                  typeof record(item.input).hint === "string"
                    ? boundedString(String(record(item.input).hint), 2_048)
                    : null,
              },
            ];
          })
        : [],
    };
  }
  const compactionId =
    typeof update.compactionId === "string"
      ? boundedString(update.compactionId, 512)
      : `unknown-${updates.length}`;
  return {
    kind: "compaction",
    key: `compaction:${compactionId}`,
    compactionId,
    status: typeof update.status === "string" ? boundedString(update.status, 128) : "in_progress",
    summary: Array.isArray(update.summary)
      ? boundedString(update.summary.map(contentText).filter(Boolean).join("\n"))
      : "",
    error: typeof update.error === "string" ? boundedString(update.error, 8_192) : null,
  };
};

export const reduceAcpConversationEvent = (
  snapshot: AgentConversationSnapshot,
  event: AcpSessionRuntimeEvent,
): AgentConversationSnapshot =>
  reduceCanonicalEvent(
    snapshot,
    event.kind === "turn_stopped"
      ? {
          kind: "turn_stopped",
          turnSequence: event.turnSequence,
          stopReason: event.response.stopReason,
        }
      : {
          kind: "session_update",
          turnSequence: event.turnSequence,
          append: true,
          update: canonicalUpdate(
            snapshot.turns.find((turn) => turn.sequence === event.turnSequence)?.updates ?? [],
            event.update,
          ),
        },
  );
