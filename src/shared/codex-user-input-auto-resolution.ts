import type { CodexProtocolRequestId } from "./types";

export type CodexUserInputAutoResolutionPhase =
  | { type: "waitingForInactivity" }
  | { type: "scheduled"; deadlineMs: number }
  | { type: "snoozed" };

export interface CodexUserInputAutoResolutionConversation {
  hostId: string;
  conversationId: string;
}

export const codexUserInputConversationKey = ({
  hostId,
  conversationId,
}: CodexUserInputAutoResolutionConversation): string => JSON.stringify([hostId, conversationId]);

export interface CodexUserInputAutoResolutionEntry extends CodexUserInputAutoResolutionConversation {
  requestId: CodexProtocolRequestId;
  phase: CodexUserInputAutoResolutionPhase;
}

export type CodexUserInputAutoResolutionChange =
  | {
      type: "updated";
      entry: CodexUserInputAutoResolutionEntry;
    }
  | {
      type: "removed";
      hostId: string;
      conversationId: string;
      requestId: CodexProtocolRequestId;
      reason: "responded" | "resolved" | "replaced" | "disconnected" | "disposed";
    }
  | {
      type: "timedOut";
      hostId: string;
      conversationId: string;
      requestId: CodexProtocolRequestId;
    };

export interface CodexUserInputAutoResolutionTarget extends CodexUserInputAutoResolutionConversation {
  requestId: CodexProtocolRequestId;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseConversationId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const conversationId = value.trim();
  return conversationId.length > 0 ? conversationId : null;
}

function parseRequestId(value: unknown): CodexProtocolRequestId | null {
  if (typeof value === "string") return value;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

export function parseCodexUserInputAutoResolutionActivityInput(
  value: unknown,
): CodexUserInputAutoResolutionConversation | null {
  if (!isRecord(value)) return null;
  const hostId = parseConversationId(value.hostId);
  const conversationId = parseConversationId(value.conversationId);
  if (hostId === null || conversationId === null) return null;
  return { hostId, conversationId };
}

export function parseCodexUserInputAutoResolutionTarget(
  value: unknown,
): CodexUserInputAutoResolutionTarget | null {
  if (!isRecord(value)) return null;
  const conversation = parseCodexUserInputAutoResolutionActivityInput(value);
  const requestId = parseRequestId(value.requestId);
  if (conversation === null || requestId === null) return null;
  return { ...conversation, requestId };
}
