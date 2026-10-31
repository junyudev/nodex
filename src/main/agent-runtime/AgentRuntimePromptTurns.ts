import * as Effect from "effect/Effect";
import type { AgentRuntimeMethod, AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import { projectPromptTurn, type PromptTurnEntry } from "../../shared/prompt-turn";

interface PromptTurnReader {
  readonly request: <M extends AgentRuntimeMethod>(
    method: M,
    input: AgentRuntimeOperations[M]["input"],
  ) => Effect.Effect<AgentRuntimeOperations[M]["output"], unknown>;
}

/** Addressed metadata and, only after settlement, one complete final answer. No history hydration. */
export const readPromptTurns = Effect.fn("AgentRuntimePromptTurns.read")(function* (
  reader: PromptTurnReader,
  threadId: string,
  messageIds: readonly string[],
) {
  const replies = new Map<string, string | null>();
  return yield* Effect.forEach(messageIds, (messageId) =>
    Effect.gen(function* () {
      const outcome = yield* reader.request("thread.message-turn", { threadId, messageId });
      const turn = projectPromptTurn(outcome);
      if (!outcome?.finalAssistantItemId || turn.phase !== "done")
        return { messageId, ...turn } satisfies PromptTurnEntry;
      const itemId = outcome.finalAssistantItemId;
      if (!replies.has(itemId)) {
        const item = yield* reader.request("thread.item.full", { threadId, itemId });
        replies.set(
          itemId,
          item?.type === "assistant_message" &&
            !item.streaming &&
            item.status === "completed" &&
            item.responseKind !== "commentary"
            ? item.text
            : null,
        );
      }
      return {
        messageId,
        ...projectPromptTurn(outcome, replies.get(itemId) ?? null),
      } satisfies PromptTurnEntry;
    }),
  );
});
