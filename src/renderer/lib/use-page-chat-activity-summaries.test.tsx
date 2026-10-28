import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vite-plus/test";
import { installWindowApi } from "../test/browser-globals";
import { invalidateProjectSessionScope } from "./project-session-query-cache";
import type { PageChatActivitySummary, PageChatActivitySummaryInput } from "./types";
import { usePageChatActivitySummaries } from "./use-page-chat-activity-summaries";

test("shares bounded Library Page reads and refreshes linked-chat activity after Session changes", async () => {
  let relatedCount = 1;
  let workingCount = 0;
  const invoke = vi.fn(async (_channel: string, input: PageChatActivitySummaryInput) => ({
    summaries: input.pageIds.map((pageId): PageChatActivitySummary => ({
      pageId,
      relatedCount,
      workingCount,
      waitingOnApprovalCount: 0,
      waitingOnUserInputCount: 0,
      errorCount: 0,
      unreadCount: 0,
      soleSessionId: relatedCount === 1 ? "session:one" : null,
      runtimeSessionIds: [],
    })),
    projectionRevision: relatedCount,
  }));
  installWindowApi({ invoke, on: () => () => undefined });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const pageIds = Array.from({ length: 201 }, (_, index) => `page:${index}`);
  const view = renderHook(
    ({ ids }: { readonly ids: readonly string[] }) => usePageChatActivitySummaries(ids),
    {
      initialProps: { ids: pageIds },
      wrapper: ({ children }) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      ),
    },
  );
  try {
    await waitFor(() => expect(view.result.current.size).toBe(201));
    expect(invoke.mock.calls.map(([channel, input]) => [channel, input.pageIds.length])).toEqual([
      ["page-chats:activity-summaries", 200],
      ["page-chats:activity-summaries", 1],
    ]);
    view.rerender({ ids: [...pageIds].reverse().concat("page:0") });
    expect(invoke).toHaveBeenCalledTimes(2);

    relatedCount = 2;
    workingCount = 1;
    await act(async () => {
      await invalidateProjectSessionScope(queryClient, {
        summaryScopes: [{ kind: "projectless" }],
        detailInvalidation: { kind: "sessions", sessionIds: ["session:one"] },
        changeType: "link",
      });
    });
    await waitFor(() =>
      expect(view.result.current.get("page:0")).toMatchObject({
        relatedCount: 2,
        workingCount: 1,
        soleSessionId: null,
      }),
    );
    expect(invoke).toHaveBeenCalledTimes(4);

    view.rerender({ ids: [] });
    expect(view.result.current.size).toBe(0);
    expect(invoke).toHaveBeenCalledTimes(4);
  } finally {
    view.unmount();
    queryClient.clear();
  }
});
