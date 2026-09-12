import type { Draft } from "immer";
import type {
  CodexCanonicalConversationState,
  CodexCanonicalUnconfirmedTurnSubmission,
} from "./codex-conversation-state";

export type CodexTurnDelivery = Omit<
  CodexCanonicalUnconfirmedTurnSubmission,
  "clientUserMessageId" | "terminal"
>;

export type CodexRequestDelivery =
  | CodexTurnDelivery
  | {
      readonly requestId: CodexTurnDelivery["requestId"];
      readonly method: string;
      readonly stage: "not-sent";
    };

/** An unconfirmed mutation retains its actual request identity across process boundaries. */
export class CodexTurnDeliveryError extends Error {
  constructor(
    message: string,
    readonly delivery: CodexRequestDelivery,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CodexTurnDeliveryError";
  }
}

export function recordCodexUnconfirmedTurnSubmission(
  state: Draft<CodexCanonicalConversationState>,
  delivery: CodexTurnDelivery,
  clientUserMessageId: string,
  terminal = false,
): void {
  const submissions = (state.unconfirmedTurnSubmissions ??= []);
  const existing = submissions.find((entry) => entry.requestId === delivery.requestId);
  if (existing) {
    if (terminal) existing.terminal = true;
    return;
  }
  submissions.push({ ...delivery, clientUserMessageId, ...(terminal ? { terminal: true } : {}) });
}

export function clearCodexUnconfirmedTurnSubmission(
  state: Draft<CodexCanonicalConversationState>,
  requestId: CodexTurnDelivery["requestId"] | null,
): void {
  if (requestId === null || !state.unconfirmedTurnSubmissions) return;
  state.unconfirmedTurnSubmissions = state.unconfirmedTurnSubmissions.filter(
    (entry) => entry.requestId !== requestId,
  );
  if (state.unconfirmedTurnSubmissions.length === 0) delete state.unconfirmedTurnSubmissions;
}
