import { useQuery } from "@tanstack/react-query";
import { pageChatActivitySummariesQueryOptions } from "./query-options";
import type { PageChatActivitySummary, PageChatActivitySummaryResult } from "./types";

const EMPTY_SUMMARIES: ReadonlyMap<string, PageChatActivitySummary> = new Map();

const summariesByPageId = (
  result: PageChatActivitySummaryResult,
): ReadonlyMap<string, PageChatActivitySummary> =>
  new Map(result.summaries.map((summary) => [summary.pageId, summary]));

/**
 * Bounded Page-chat reads share Session-event invalidation across Library and Project surfaces.
 * Controls add linked Runtime Sessions' live activity through usePageChatActivity.
 */
export function usePageChatActivitySummaries(
  pageIds: readonly string[],
): ReadonlyMap<string, PageChatActivitySummary> {
  const activity = useQuery({
    ...pageChatActivitySummariesQueryOptions(pageIds),
    select: summariesByPageId,
  });
  return activity.data ?? EMPTY_SUMMARIES;
}
