import { useEffect, useState } from "react";
import { messageSearchTokens, splitSearchText } from "@nodex/agent-runtime/palette-search";
import {
  CHAT_SEARCH_MAX_LIMIT,
  type ChatMatchHint,
  type ChatMessageSearchResult,
  type ChatSearchInput,
  type ChatSearchMatch,
  type ChatSearchResult,
  type ChatTextRange,
} from "../../shared/chat-search";
import type { CommandPaletteHighlightSegment } from "./command-palette-highlight";
import { invokeRendererQuery as invoke } from "./renderer-command";

const MESSAGE_SEARCH_DEBOUNCE_MS = 250;
const MESSAGE_SEARCH_CACHE_TTL_MS = 30_000;
const MESSAGE_SEARCH_CACHE_ENTRIES = 32;
// One empty list, so pickers can depend on match identity while a search is idle or failed.
const NO_MATCHES: readonly ChatSearchMatch[] = [];

/**
 * Every chat picker finds chats here. Main owns the catalog and ranks it with the same
 * kernel the Agent session search uses, so pickers only render bounded results.
 */
export function searchChats(input: ChatSearchInput): Promise<ChatSearchResult> {
  return invoke("chats:search", { ...input, limit: clampLimit(input.limit) });
}

/** Message history needs a word of three letters, or two CJK characters. */
export function searchesChatMessages(query: string): boolean {
  return messageSearchTokens(query.trim()).long.length > 0;
}

const messageSearchCache = new Map<
  string,
  { readonly expiresAt: number; readonly result: ChatMessageSearchResult }
>();
const messageSearchInFlight = new Map<string, Promise<ChatMessageSearchResult>>();

export function searchChatMessages(input: {
  readonly query: string;
  readonly limit: number;
}): Promise<ChatMessageSearchResult> {
  const query = input.query.trim();
  const limit = clampLimit(input.limit);
  const key = `${query}\u0000${limit}`;
  const cached = messageSearchCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.result);
  const existing = messageSearchInFlight.get(key);
  if (existing) return existing;
  const request = invoke("chats:search-messages", { query, limit })
    .then((result) => {
      // Unavailable sources may recover, so only a complete answer is reused.
      if (result.sources.every((source) => source.state === "complete")) {
        messageSearchCache.delete(key);
        messageSearchCache.set(key, {
          expiresAt: Date.now() + MESSAGE_SEARCH_CACHE_TTL_MS,
          result,
        });
        if (messageSearchCache.size > MESSAGE_SEARCH_CACHE_ENTRIES) {
          messageSearchCache.delete(messageSearchCache.keys().next().value!);
        }
      }
      return result;
    })
    .finally(() => messageSearchInFlight.delete(key));
  messageSearchInFlight.set(key, request);
  return request;
}

export interface ChatSearchState {
  /** The query `matches` answer; differs from the live query while a newer search loads. */
  readonly query: string;
  readonly matches: readonly ChatSearchMatch[];
  /** Some search has answered, so `matches` can be shown while a newer one loads. */
  readonly answered: boolean;
  /** `matches` answer the live request. */
  readonly settled: boolean;
  readonly failed: boolean;
}

interface Answered<T> {
  readonly key: string;
  readonly query: string;
  readonly value: T;
}

/** Catalog matches for the live query. Rows from the previous query stay until the next lands. */
export function useChatSearch({
  enabled,
  query,
  limit,
  startedOnly = false,
  refreshKey = 0,
}: {
  enabled: boolean;
  query: string;
  limit: number;
  startedOnly?: boolean;
  /** Changing it searches again, such as each time a picker opens. */
  refreshKey?: number;
}): ChatSearchState {
  const [answered, setAnswered] = useState<Answered<ChatSearchResult | null> | null>(null);
  const liveQuery = query.trim();
  const key = JSON.stringify([liveQuery, limit, startedOnly, refreshKey]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void searchChats({ query: liveQuery, limit, startedOnly }).then(
      (result) => {
        if (!cancelled) setAnswered({ key, query: liveQuery, value: result });
      },
      () => {
        if (!cancelled) setAnswered({ key, query: liveQuery, value: null });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [enabled, key, limit, liveQuery, startedOnly]);

  if (!enabled || !answered) {
    return { query: "", matches: NO_MATCHES, answered: false, settled: false, failed: false };
  }
  const settled = answered.key === key;
  return {
    query: answered.query,
    matches: answered.value?.matches ?? NO_MATCHES,
    answered: true,
    settled,
    failed: settled && answered.value === null,
  };
}

export interface ChatMessageSearchState {
  /** The query `matches` answer. */
  readonly query: string;
  readonly matches: readonly ChatSearchMatch[];
  /** Message history for the live query is still being searched. */
  readonly pending: boolean;
  /** Some history could not be searched for the live query. */
  readonly incomplete: boolean;
}

const IDLE_MESSAGE_SEARCH: ChatMessageSearchState = {
  query: "",
  matches: NO_MATCHES,
  pending: false,
  incomplete: false,
};

/** Chats matched only by message history, searched once typing pauses. */
export function useChatMessageSearch({
  enabled,
  query,
  limit,
}: {
  enabled: boolean;
  query: string;
  limit: number;
}): ChatMessageSearchState {
  const [answered, setAnswered] = useState<Answered<ChatMessageSearchResult | null> | null>(null);
  const liveQuery = query.trim();
  const active = enabled && searchesChatMessages(liveQuery);
  const key = JSON.stringify([liveQuery, limit]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void searchChatMessages({ query: liveQuery, limit }).then(
        (result) => {
          if (!cancelled) setAnswered({ key, query: liveQuery, value: result });
        },
        () => {
          if (!cancelled) setAnswered({ key, query: liveQuery, value: null });
        },
      );
    }, MESSAGE_SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [active, key, limit, liveQuery]);

  if (!active) return IDLE_MESSAGE_SEARCH;
  if (answered?.key === key) {
    return {
      query: liveQuery,
      matches: answered.value?.matches ?? NO_MATCHES,
      pending: false,
      incomplete:
        answered.value === null ||
        answered.value.sources.some((source) => source.state !== "complete"),
    };
  }
  // A larger request for the same query keeps the matches it already has.
  return {
    query: liveQuery,
    matches: (answered?.query === liveQuery ? answered.value?.matches : null) ?? NO_MATCHES,
    pending: true,
    incomplete: false,
  };
}

/** Catalog matches, then chats matched only by their messages, at most `limit`. */
export function mergeChatSearchMatches(
  catalog: readonly ChatSearchMatch[],
  messages: readonly ChatSearchMatch[],
  limit: number,
): ChatSearchMatch[] {
  const listed = new Set(catalog.map((match) => match.chat.sessionId));
  return [...catalog, ...messages.filter((match) => !listed.has(match.chat.sessionId))].slice(
    0,
    limit,
  );
}

/** Chats in `projectId` first, keeping each group's order. */
export function preferChatProject<T extends ChatSearchMatch>(
  matches: readonly T[],
  projectId: string | null,
): T[] {
  if (!projectId) return [...matches];
  return [
    ...matches.filter((match) => match.chat.projectId === projectId),
    ...matches.filter((match) => match.chat.projectId !== projectId),
  ];
}

/** `text` cut at its matched ranges; null when nothing matched. */
export function chatHighlightSegments(
  text: string,
  ranges: readonly ChatTextRange[],
): CommandPaletteHighlightSegment[] | null {
  if (ranges.length === 0) return null;
  return splitSearchText(text, ranges).map((part) => ({
    text: part.text,
    highlight: part.highlighted,
  }));
}

/**
 * The hint's match inside `field` when the hint explains a match in that field. A branch hint
 * omits the worktree prefix, so its ranges are offset into the full branch.
 */
export function chatFieldHighlightSegments(
  field: string | null,
  hint: ChatMatchHint | null,
  label: "Branch" | "Project",
): CommandPaletteHighlightSegment[] | null {
  if (!field || hint?.label !== label || !field.endsWith(hint.text)) return null;
  const offset = field.length - hint.text.length;
  return chatHighlightSegments(
    field,
    hint.ranges.map((range) => ({ start: range.start + offset, end: range.end + offset })),
  );
}

function clampLimit(limit: number): number {
  return Math.min(CHAT_SEARCH_MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

export function clearChatSearchCacheForTests(): void {
  messageSearchCache.clear();
  messageSearchInFlight.clear();
}
