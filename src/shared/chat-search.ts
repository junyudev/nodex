/**
 * Chat search contract shared by every chat picker (command palette, composer context,
 * Page chat mentions, send-to-chat) and the Main owner that answers it.
 *
 * Main owns the chat catalog: every non-archived root chat in the Profile, across all
 * Providers. It ranks the catalog with the shared palette search kernel, the same matcher the
 * Agent `search_sessions` tool uses, and returns bounded results. Chat search has two
 * independent phases:
 * - `chats:search` matches catalog metadata and opening prompts; it is fast and complete;
 * - `chats:search-messages` is a bounded, best-effort lookup of chats whose message history
 *   matches. It never gates catalog matches and reports each history source's availability.
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

export interface ChatSearchMatch {
  readonly chat: ChatCatalogEntry;
  readonly titleRanges: readonly ChatTextRange[];
  readonly hint: ChatMatchHint | null;
  readonly excerpt: ChatMatchExcerpt | null;
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
   * Metadata matches first, best first, then chats matched only by their opening prompt.
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
  readonly state: "complete" | "unavailable" | "timed_out";
}

export interface ChatMessageSearchResult {
  /**
   * Chats matched only by message history, best first, each with an excerpt. Chats that
   * `chats:search` already matches for the same query are left out.
   */
  readonly matches: readonly ChatSearchMatch[];
  readonly sources: readonly ChatMessageSourceState[];
}
