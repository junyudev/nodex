import type { ChatHistoryMatch, ChatSearchMatch } from "../../shared/chat-search";

export type ChatSearchItem = Pick<ChatHistoryMatch, "sourceThreadId" | "itemId" | "runId">;

export interface ChatSearchReveal {
  readonly kind: "chat-search";
  readonly threadId: string;
  readonly text: string;
  readonly item: ChatSearchItem;
}

/** The caller supplies a history result, whose excerpt ranges refer to the original text. */
export function chatSearchReveal(match: ChatSearchMatch): ChatSearchReveal | undefined {
  const threadId = match.chat.threadId;
  if (!threadId) return undefined;

  const item = match.historyMatch;
  if (item?.sessionId === match.chat.sessionId && item.matchedText.trim()) {
    return {
      kind: "chat-search",
      threadId,
      text: item.matchedText.trim(),
      item: { sourceThreadId: item.sourceThreadId, itemId: item.itemId, runId: item.runId },
    };
  }

  return undefined;
}
