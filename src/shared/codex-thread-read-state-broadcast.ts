import type { ContextualThreadReadStateChange } from "./codex-thread-read-state";

/** Reject foreign or malformed peer messages before identity-scoped membership is consulted. */
export function readThreadReadStateBroadcast(
  value: unknown,
): ContextualThreadReadStateChange | null {
  if (
    !record(value) ||
    typeof value.hostId !== "string" ||
    typeof value.conversationId !== "string" ||
    typeof value.hasUnreadTurn !== "boolean" ||
    !record(value.context)
  )
    return null;
  const context = value.context;
  if (typeof context.executionHostKey !== "string" || !record(context.identity)) return null;
  const identity = context.identity;
  if (
    identity.kind === "chatgpt" &&
    typeof identity.accountId === "string" &&
    typeof identity.userId === "string"
  )
    return {
      hostId: value.hostId,
      threadId: value.conversationId,
      hasUnreadTurn: value.hasUnreadTurn,
      context: {
        executionHostKey: context.executionHostKey,
        identity: { kind: "chatgpt", accountId: identity.accountId, userId: identity.userId },
      },
    };
  if (identity.kind === "execution-storage" && typeof identity.authMode === "string")
    return {
      hostId: value.hostId,
      threadId: value.conversationId,
      hasUnreadTurn: value.hasUnreadTurn,
      context: {
        executionHostKey: context.executionHostKey,
        identity: { kind: "execution-storage", authMode: identity.authMode },
      },
    };
  return null;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
