import type { Draft } from "immer";
import {
  mergeCodexCanonicalTurnStates,
  type CodexCanonicalConversationState,
} from "./codex-conversation-state";
import {
  conversationTurnDraft,
  residentConversationTurnEntries,
  residentConversationTurns,
} from "./codex-turn-mutation";

export interface CanonicalInterruptClient {
  readonly getConversation: (id: string) => CodexCanonicalConversationState | undefined;
  readonly updateConversation: (
    id: string,
    recipe: (draft: Draft<CodexCanonicalConversationState>) => void,
  ) => void;
  readonly sendInterrupt: (threadId: string, turnId: string) => Promise<unknown>;
  readonly cleanBackgroundTerminals: (id: string) => Promise<unknown>;
  /** Runtime owns the bounded, best-effort REPL cleanup and reports failures itself. */
  readonly killNodeReplExecutions: (sessionId: string, turnId: string) => Promise<void>;
  readonly onInterruptStarted: (id: string) => void;
  readonly errorMessage: (error: unknown) => string;
  readonly warn: (error: unknown) => void;
}

export function mutateCanonicalInterruptedTurn(
  state: Draft<CodexCanonicalConversationState>,
  id: string,
): void {
  const overlay = state.turns.findLast(
    (turn) => turn.turnId === id && turn.status === "inProgress",
  );
  if (overlay) {
    overlay.status = "interrupted";
    return;
  }
  const entry = residentConversationTurnEntries(state).findLast(
    ({ turn }) => turn.turnId === id && turn.status === "inProgress",
  );
  if (!entry) return;
  const turn = conversationTurnDraft(state, entry.address);
  if (turn) turn.status = "interrupted";
}

/** Interrupts exactly the observed active turn, respecting expected-turn races and cleanup order. */
export async function interruptCanonicalConversationTurn(
  client: CanonicalInterruptClient,
  id: string,
  expectedTurnId?: string,
  backgroundCleanup = false,
): Promise<string | null> {
  const state = client.getConversation(id);
  const turns = state
    ? mergeCodexCanonicalTurnStates(residentConversationTurns(state), state.turns)
    : [];
  const turn = turns.findLast((candidate) => candidate.turnId != null);
  const turnId = turn?.turnId;
  if (expectedTurnId != null && (expectedTurnId !== turnId || turn?.status !== "inProgress"))
    return null;
  if (!turnId || turn?.status !== "inProgress") {
    try {
      await client.cleanBackgroundTerminals(id);
    } catch (error) {
      client.warn(error);
    }
    return null;
  }
  const threadId = state?.id ?? id;
  const sessionId = state?.sessionId ?? threadId;
  const cleanup: Promise<void>[] = [];
  const kill = (value: string) => {
    if (cleanup.length === 0) client.onInterruptStarted(id);
    cleanup.push(
      (async () => {
        try {
          await client.killNodeReplExecutions(sessionId, value);
        } catch (error) {
          client.warn(error);
        }
      })(),
    );
  };
  const mark = (value: string) =>
    client.updateConversation(id, (draft) => mutateCanonicalInterruptedTurn(draft, value));
  if (expectedTurnId == null) kill(turnId);
  let interruptedTurnId: string | null = turnId;
  try {
    await client.sendInterrupt(threadId, turnId);
    mark(turnId);
  } catch (error) {
    const message = client.errorMessage(error);
    const actual =
      message.match(/expected active turn id `?[^`\s]+`? but found `?([^`\s]+)`?/)?.[1] ??
      message.match(/ExpectedTurnMismatch\s*\{[^}]*actual:\s*"([^"]+)"/)?.[1];
    if (actual != null) {
      if (expectedTurnId != null && actual !== expectedTurnId) {
        interruptedTurnId = null;
        return null;
      }
      interruptedTurnId = actual;
      if (expectedTurnId == null) kill(actual);
      try {
        await client.sendInterrupt(threadId, actual);
      } catch (retryError) {
        if (client.errorMessage(retryError) !== "no active turn to interrupt") throw retryError;
        mark(actual);
      }
      mark(turnId);
    } else if (message === "no active turn to interrupt") {
      if (expectedTurnId != null) {
        interruptedTurnId = null;
        return null;
      }
      mark(turnId);
    } else throw error;
  } finally {
    if (expectedTurnId != null && interruptedTurnId != null) {
      kill(turnId);
      if (interruptedTurnId !== turnId) kill(interruptedTurnId);
    }
    if (backgroundCleanup) void Promise.all(cleanup);
    else await Promise.all(cleanup);
  }
  return interruptedTurnId;
}
