import { describe, expect, test } from "vite-plus/test";
import type { PageChatActivitySummaryResult } from "./types";
import { normalizePageChatPageIds, readPageChatActivitySummaryBatches } from "./page-chat-queries";

describe("Page Chat activity queries", () => {
  test("normalizes identities and reads 201 Pages as 200 plus one bounded batch", async () => {
    const requested = Array.from({ length: 201 }, (_, index) => `page:${index.toString(10)}`);
    requested.push("page:7");
    const calls: string[][] = [];

    const result = await readPageChatActivitySummaryBatches(
      { pageIds: requested.reverse() },
      async (input): Promise<PageChatActivitySummaryResult> => {
        calls.push(input.pageIds);
        return {
          summaries: input.pageIds.map((pageId) => ({
            pageId,
            relatedCount: 0,
            workingCount: 0,
            waitingOnApprovalCount: 0,
            waitingOnUserInputCount: 0,
            errorCount: 0,
            unreadCount: 0,
            soleSessionId: null,
            runtimeSessionIds: [],
          })),
          projectionRevision: calls.length * 10,
        };
      },
    );

    expect(calls.map((batch) => batch.length)).toEqual([200, 1]);
    expect(calls.flat()).toEqual(normalizePageChatPageIds(requested));
    expect(result.summaries).toHaveLength(201);
    expect(result.projectionRevision).toBe(20);
  });

  test("returns an empty projection without issuing a Core read", async () => {
    let readCount = 0;
    const result = await readPageChatActivitySummaryBatches({ pageIds: [] }, async () => {
      readCount += 1;
      return { summaries: [], projectionRevision: 99 };
    });

    expect(result).toEqual({ summaries: [], projectionRevision: 0 });
    expect(readCount).toBe(0);
  });
});
