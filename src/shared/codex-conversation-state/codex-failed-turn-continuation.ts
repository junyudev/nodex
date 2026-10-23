import type { CodexCanonicalConversationState } from "./codex-conversation-state";
import { residentConversationTurns } from "./codex-turn-mutation";

/** Continue is a new user message admitted only against the exact latest failed turn. */
export function assertCodexFailedTurnContinuation(
  state: CodexCanonicalConversationState | null | undefined,
  expectedTurnId: string,
): void {
  if (!state) throw new Error("Canonical conversation state unavailable");
  if (state.threadGoal) throw new Error("Use the goal controls to continue this conversation");
  const turns = residentConversationTurns(state);
  const latest = turns.at(-1);
  if (!expectedTurnId || latest?.turnId !== expectedTurnId || latest.status !== "failed")
    throw new Error("Only the latest failed turn can be continued");
  if (
    state.threadRuntimeStatus.type === "active" ||
    turns.some((turn) => turn.status === "inProgress")
  )
    throw new Error("Nodex is already running");
  if (
    state.requests.length > 0 ||
    (state.unconfirmedTurnSubmissions?.length ?? 0) > 0 ||
    (state.unconfirmedServerQueueMessages?.length ?? 0) > 0 ||
    turns.some((turn) =>
      turn.items.some((item) => item.type === "steeringUserMessage" && item.status === "pending"),
    )
  )
    throw new Error("Resolve the pending thread action before continuing Nodex");
}
