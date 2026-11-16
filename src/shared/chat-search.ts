import type { MessageSearchRank } from "@nodex/agent-runtime/palette-search";

/**
 * Chat search contract shared by every chat picker (command palette, composer context,
 * Page chat mentions, send-to-chat) and the Main owner that answers it.
 *
 * Main owns the chat catalog: every non-archived root chat in the Profile, across all
 * Providers. Both phases rank with the shared search kernel. Pickers display strong metadata
 * from `chats:search` immediately, then merge in history, opening prompts and loose catalog
 * matches from `chats:search-messages`. The history phase also reports source coverage.
 */

export const CHAT_SEARCH_MAX_LIMIT = 60;
export const CHAT_SEARCH_QUERY_MAX_CHARS = 200;

/** What a chat is doing now, normalized across Providers for list presentation. */
export type ChatActivity =
  | "idle"
  | "running"
  | "waitingOnApproval"
  | "waitingOnUserInput"
  | "error";

export interface ChatPullRequest {
  readonly number: number;
  readonly title: string | null;
  readonly url: string;
  readonly repository: string;
}

/** One chat as every picker sees it. A chat is a Nodex Session; its Thread is optional. */
export interface ChatCatalogEntry {
  readonly sessionId: string;
  /** The native Thread or Runtime root Thread; null for a chat that has not started yet. */
  readonly threadId: string | null;
  readonly title: string;
  readonly projectId: string | null;
  readonly projectName: string | null;
  readonly cwd: string | null;
  readonly branch: string | null;
  readonly pullRequests: readonly ChatPullRequest[];
  readonly pinned: boolean;
  readonly pinnedOrder: number | null;
  readonly unread: boolean;
  readonly activity: ChatActivity;
  /** Epoch milliseconds. */
  readonly createdAt: number;
  /** Conversation recency in epoch milliseconds; the order of the sidebar and recent chats. */
  readonly recencyAt: number;
}

/** UTF-16 offsets into the text they accompany. */
export interface ChatTextRange {
  readonly start: number;
  readonly end: number;
}

/** Why a chat matched when its title shows no match, such as its branch or Project. */
export interface ChatMatchHint {
  readonly label: string;
  readonly text: string;
  readonly ranges: readonly ChatTextRange[];
}

/** A single-line excerpt of the opening prompt or a matching message. */
export interface ChatMatchExcerpt {
  readonly text: string;
  readonly ranges: readonly ChatTextRange[];
  readonly role: "user" | "assistant" | null;
}

/** Coordinate shared with the Agent search tool for a canonically addressable history item. */
export interface ChatHistoryMatch {
  readonly sessionId: string;
  readonly sourceThreadId: string;
  readonly itemId: string;
  readonly matchedText: string;
  readonly runId: string | null;
}

export interface ChatSearchMatch {
  readonly chat: ChatCatalogEntry;
  readonly titleRanges: readonly ChatTextRange[];
  readonly hint: ChatMatchHint | null;
  readonly excerpt: ChatMatchExcerpt | null;
  readonly historyMatch?: ChatHistoryMatch;
  /** Common rank across catalog and history responses. Empty queries use catalog order. */
  readonly rank?: MessageSearchRank;
}

export interface ChatSearchInput {
  /** An empty query lists pinned chats first, then the most recent chats. */
  readonly query: string;
  readonly limit: number;
  /** Only chats that have started a Thread, such as mention and send-to-chat targets. */
  readonly startedOnly?: boolean;
}

export interface ChatSearchResult {
  /**
   * Ranked metadata and opening-prompt matches.
   * At most `limit` matches.
   */
  readonly matches: readonly ChatSearchMatch[];
  /** False when the Profile holds more chats than the catalog can hold. */
  readonly complete: boolean;
}

/** A history source: Runtime-normalized history for every Provider, or native Codex history. */
export type ChatMessageSource = "runtime" | "codex";

export interface ChatMessageSourceState {
  readonly source: ChatMessageSource;
  readonly state: "complete" | "partial" | "unavailable" | "timed_out";
}

export interface ChatMessageSearchResult {
  /**
   * Ranked history, opening prompts and loose catalog matches. Strong metadata rows
   * are already available from the catalog phase.
   */
  readonly matches: readonly ChatSearchMatch[];
  readonly sources: readonly ChatMessageSourceState[];
  /** Some available matches were omitted or at least one source exhausted its search budget. */
  readonly truncated: boolean;
}
