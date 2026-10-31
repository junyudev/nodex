import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";

export type PromptTurnPhase =
  | "queued"
  | "working"
  | "waiting"
  | "done"
  | "failed"
  | "interrupted"
  | "unknown";

export interface PromptTurn {
  readonly phase: PromptTurnPhase;
  /** The final assistant Markdown of this Run's current attempt; never a streaming preview. */
  readonly reply: string | null;
  readonly runId: string | null;
}

export interface PromptTurnTarget {
  readonly sessionId: string;
  readonly messageId: string;
}

export const UNKNOWN_PROMPT_TURN: PromptTurn = { phase: "unknown", reply: null, runId: null };

export const PROMPT_TURN_READ_LIMIT = 100;

export interface PromptTurnsInput {
  readonly sessionId: string;
  readonly messageIds: readonly string[];
}

export interface PromptTurnEntry extends PromptTurn {
  readonly messageId: string;
}

/** A delivered message follows its receiving Run, independently of newer work in the chat. */
export function projectPromptTurn(
  outcome: AgentRuntimeOperations["thread.message-turn"]["output"],
  finalReply: string | null = null,
): PromptTurn {
  if (!outcome) return UNKNOWN_PROMPT_TURN;
  const phase = promptTurnPhase(outcome.status);
  const settled = phase === "done";
  return { phase, runId: outcome.runId, reply: settled ? finalReply : null };
}

function promptTurnPhase(
  status: NonNullable<AgentRuntimeOperations["thread.message-turn"]["output"]>["status"],
): PromptTurnPhase {
  switch (status) {
    case "queued":
      return "queued";
    case "preparing":
    case "starting":
    case "running":
      return "working";
    case "waiting":
      return "waiting";
    case "completed":
      return "done";
    case "failed":
      return "failed";
    case "cancelled":
    case "interrupted":
      return "interrupted";
    case "rolled_back":
      return "unknown";
  }
}
