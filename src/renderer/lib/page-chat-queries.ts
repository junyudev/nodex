import type { PageChatActivitySummaryInput, PageChatActivitySummaryResult } from "./types";

export const PAGE_CHAT_ACTIVITY_BATCH_SIZE = 200;

export function normalizePageChatPageIds(pageIds: readonly string[]): string[] {
  return [...new Set(pageIds)].sort((left, right) => left.localeCompare(right));
}

export function chunkPageChatPageIds(pageIds: readonly string[]): string[][] {
  const chunks: string[][] = [];
  for (let start = 0; start < pageIds.length; start += PAGE_CHAT_ACTIVITY_BATCH_SIZE) {
    chunks.push(pageIds.slice(start, start + PAGE_CHAT_ACTIVITY_BATCH_SIZE));
  }
  return chunks;
}

export async function readPageChatActivitySummaryBatches(
  input: PageChatActivitySummaryInput,
  read: (input: PageChatActivitySummaryInput) => Promise<PageChatActivitySummaryResult>,
): Promise<PageChatActivitySummaryResult> {
  const pageIds = normalizePageChatPageIds(input.pageIds);
  if (pageIds.length === 0) return { summaries: [], projectionRevision: 0 };

  const batches = await Promise.all(
    chunkPageChatPageIds(pageIds).map((batch) => read({ pageIds: batch })),
  );
  return {
    summaries: batches.flatMap((batch) => batch.summaries),
    projectionRevision: Math.max(...batches.map((batch) => batch.projectionRevision)),
  };
}
