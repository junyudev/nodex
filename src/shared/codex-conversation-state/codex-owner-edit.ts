import type { ThreadRevertResponse, TurnStartParams } from "@nodex/codex-app-server-protocol/v2";
import {
  mergeCodexCanonicalTurnStates,
  type CodexCanonicalConversationState,
  type CodexCanonicalTurnState,
} from "./codex-conversation-state";
import { residentConversationTurns } from "./codex-turn-mutation";

export interface CanonicalEditOptions {
  readonly turnId: string;
  readonly message: string;

  readonly serviceTier?: TurnStartParams["serviceTier"];
  readonly additionalContext?: TurnStartParams["additionalContext"];
  readonly writingBlockContextPrepared?: boolean;
}
export interface CanonicalEditClient {
  readonly getConversation: (id: string) => CodexCanonicalConversationState | undefined;
  readonly awaitSettings: (id: string) => Promise<void>;
  readonly supportsRevert: () => boolean;
  readonly revert: (id: string, beforeTurnId: string) => Promise<ThreadRevertResponse>;
  readonly applyRevert: (
    id: string,
    response: ThreadRevertResponse,
    turns: readonly CodexCanonicalTurnState[],
  ) => void;
  readonly start: (request: TurnStartParams, original: CodexCanonicalTurnState) => Promise<unknown>;
}

export function replaceCanonicalEditedPrompt(original: string, message: string): string {
  const marker = Array.from(original.matchAll(/## My request(?: for Codex)?:/g)).at(-1);
  return marker === undefined
    ? message
    : `${original.slice(0, marker.index).trimEnd()}\n## My request:\n${message}\n`;
}

/**
 * Rewrites any settled user Turn: the conversation reverts to just before it, so that Turn and
 * every later Turn leave history, then the rewritten message starts a new Turn. Runs on the owner
 * after follower dispatch and preserves the original message's non-text inputs.
 */
export async function editCanonicalUserTurn(
  client: CanonicalEditClient,
  id: string,
  options: CanonicalEditOptions,
): Promise<void> {
  const initial = client.getConversation(id);
  const original =
    initial &&
    mergeCodexCanonicalTurnStates(residentConversationTurns(initial), initial.turns).find(
      (turn) => turn.turnId === options.turnId,
    );
  if (!original) throw new Error("Turn not found for edit.");
  await client.awaitSettings(id);
  const state = client.getConversation(id);
  if (!state) throw new Error("Conversation state not found.");
  const textIndex = original.params.input.findIndex((item) => item.type === "text");
  const input =
    textIndex < 0
      ? [
          { type: "text" as const, text: options.message, text_elements: [] },
          ...original.params.input,
        ]
      : original.params.input.map((item, index) =>
          item.type === "text" && index === textIndex
            ? {
                ...item,
                text: replaceCanonicalEditedPrompt(item.text, options.message),
                text_elements: [],
              }
            : item,
        );
  if (state.ephemeral || state.historyMode !== "paginated" || !client.supportsRevert())
    throw new Error("Editing messages requires a host with paginated history and message revert.");
  const turns = mergeCodexCanonicalTurnStates(residentConversationTurns(state), state.turns);
  const index = turns.findIndex((turn) => turn.turnId === original.turnId);
  if (original.turnId === null || index === -1) throw new Error("Turn not found for edit.");
  const removed = turns.slice(index);
  if (removed.some((turn) => turn.status === "inProgress"))
    throw new Error("Cannot edit a message while a turn is in progress.");
  const response = await client.revert(id, original.turnId);
  const { thread } = response;
  client.applyRevert(id, response, removed);
  const cwd = thread.cwd || state.cwd || undefined;
  await client.start(
    {
      threadId: id,
      turnTrigger: "edit_user_message",
      input,
      cwd,
      serviceTier: options.serviceTier,
      additionalContext: options.additionalContext,
    },
    original,
  );
}
