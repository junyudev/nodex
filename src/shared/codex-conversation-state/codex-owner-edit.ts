import type { Thread, ThreadRevertResponse, ThreadRollbackResponse, TurnStartParams } from "@nodex/codex-app-server-protocol/v2";
import { mergeCodexCanonicalTurnStates, type CodexCanonicalConversationState, type CodexCanonicalTurnState } from "./codex-conversation-state";
import { residentConversationTurns } from "./codex-turn-mutation";

export interface CanonicalEditOptions {
  readonly turnId: string;
  readonly message: string;
  readonly agentMode?: unknown;
  readonly shouldSendPermissionOverrides?: boolean;
  readonly serviceTier?: TurnStartParams["serviceTier"];
  readonly additionalContext?: TurnStartParams["additionalContext"];
  readonly writingBlockContextPrepared?: boolean;
}
export interface CanonicalEditClient {
  readonly getConversation: (id: string) => CodexCanonicalConversationState | undefined;
  readonly awaitSettings: (id: string) => Promise<void>;
  readonly supportsRevert: () => boolean;
  readonly readPermissionOverrides: (id: string, state: CodexCanonicalConversationState, options: CanonicalEditOptions) => Promise<((cwd: string | undefined) => Pick<TurnStartParams, "approvalPolicy" | "approvalsReviewer" | "sandboxPolicy" | "permissions" | "runtimeWorkspaceRoots"> | null) | null>;
  readonly revert: (id: string, beforeTurnId: string) => Promise<ThreadRevertResponse>;
  readonly rollback: (id: string, numTurns: number) => Promise<ThreadRollbackResponse>;
  readonly applyRevert: (id: string, response: ThreadRevertResponse, turns: readonly CodexCanonicalTurnState[]) => void;
  readonly applyRollback: (id: string, before: CodexCanonicalConversationState, response: ThreadRollbackResponse) => void;
  readonly start: (request: TurnStartParams, original: CodexCanonicalTurnState, inheritPermissionDefaults: boolean | undefined) => Promise<unknown>;
}

export function replaceCanonicalEditedPrompt(original: string, message: string): string {
  const marker = Array.from(original.matchAll(/## My request(?: for Codex)?:/g)).at(-1);
  return marker === undefined ? message : `${original.slice(0, marker.index).trimEnd()}\n## My request:\n${message}\n`;
}

/** Runs on the owner after follower dispatch; preserves the original message's non-text inputs. */
export async function editCanonicalLastUserTurn(client: CanonicalEditClient, id: string, options: CanonicalEditOptions): Promise<void> {
  const initial = client.getConversation(id);
  const original = initial && mergeCodexCanonicalTurnStates(residentConversationTurns(initial), initial.turns).find((turn) => turn.turnId === options.turnId);
  if (!original) throw new Error("Turn not found for edit.");
  await client.awaitSettings(id);
  const state = client.getConversation(id);
  if (!state) throw new Error("Conversation state not found.");
  const textIndex = original.params.input.findIndex((item) => item.type === "text");
  const input = original.params.input.map((item, index) => item.type === "text" && index === textIndex ? { ...item, text: replaceCanonicalEditedPrompt(item.text, options.message), text_elements: [] } : item);
  const useRevert = state.historyMode === "paginated" && client.supportsRevert();
  if (!useRevert && state.historyMode === "paginated") throw new Error("Editing messages is not available for threads using paginated history yet.");
  const turns = mergeCodexCanonicalTurnStates(residentConversationTurns(state), state.turns);
  const index = turns.findIndex((turn) => turn.turnId === original.turnId);
  const removed = turns.slice(index);
  if (original.turnId === null || index === -1 || removed.slice(1).some((turn) => turn.params.input.length > 0)) throw new Error("Only the most recent message can be edited.");
  if (removed.some((turn) => turn.status === "inProgress")) throw new Error("Cannot edit a message while a turn is in progress.");
  const permissionFactory = options.shouldSendPermissionOverrides ? await client.readPermissionOverrides(id, state, options) : null;
  let thread: Thread;
  if (useRevert) {
    const response = await client.revert(id, original.turnId);
    thread = response.thread;
    client.applyRevert(id, response, removed);
  } else {
    const response = await client.rollback(id, removed.filter((turn) => turn.turnId !== null).length);
    thread = response.thread;
    client.applyRollback(id, state, response);
  }
  const cwd = thread.cwd || state.cwd || undefined;
  const permissions = permissionFactory?.(cwd) ?? null;
  await client.start({ threadId: id, turnTrigger: "edit_user_message", input, cwd, ...permissions, serviceTier: options.serviceTier, additionalContext: options.additionalContext }, original, permissions == null ? true : undefined);
}
