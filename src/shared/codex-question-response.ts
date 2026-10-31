import type { RequestId } from "@nodex/codex-app-server-protocol";
import type { CodexCanonicalConversationState } from "./codex-conversation-state/codex-conversation-state";
import { residentConversationTurns } from "./codex-conversation-state/codex-turn-mutation";
import { areStructurallyEqual } from "./structural-equality";

/**
 * The Agent conversation that answered a question; absent means the person did. Nodex keeps it
 * beside conversation data, outside provider payloads.
 */
export interface CodexQuestionResponder {
  readonly kind: "agent";
  readonly senderThreadId: string;
  readonly senderSessionId?: string | null;
}

export interface CodexQuestionResponseMetadata {
  readonly respondedBy: CodexQuestionResponder;
  readonly operationId: string;
}

/** Owner receipts also cover a lost follower acknowledgement before its patches arrive. */
export function isCodexUserInputResponseRetry(
  state: CodexCanonicalConversationState,
  requestId: RequestId,
  answers: Readonly<Record<string, readonly string[]>>,
  response: CodexQuestionResponseMetadata | undefined,
): boolean {
  if (!response) return false;
  return residentConversationTurns(state).some((turn) =>
    turn.items.some(
      (item) =>
        item.type === "userInputResponse" &&
        item.completed &&
        item.requestId === requestId &&
        item.responseOperationId === response.operationId &&
        areStructurallyEqual(item.respondedBy, response.respondedBy) &&
        areStructurallyEqual(item.answers, answers),
    ),
  );
}
