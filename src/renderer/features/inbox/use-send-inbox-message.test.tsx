import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, expect, test, vi } from "vite-plus/test";
import { LIBRARY_INBOX, type InboxSendInput } from "../../../shared/inbox";
import { createBoundedOperationId } from "../../../shared/operation-identity";
import { sendInboxMessage } from "@/lib/inbox-runtime";
import { queryKeys } from "@/lib/query-keys";
import { useSendInboxMessage } from "./use-send-inbox-message";

vi.mock("@/lib/inbox-runtime", () => ({ sendInboxMessage: vi.fn() }));
beforeEach(() => vi.resetAllMocks());

test.each(["saved", "failed"] as const)(
  "refreshes Inbox queries after a %s send without an Inbox route",
  async (outcome) => {
    const queryClient = new QueryClient();
    const key = queryKeys.inbox.summary("library");
    queryClient.setQueryData(key, { entryCount: 0 });
    const input: InboxSendInput = {
      operationId: createBoundedOperationId("inbox.capture"),
      pageId: "page:a",
      documentId: "document:a",
      issuedAt: Date.now(),
      storeEpoch: "epoch:1",
      scope: LIBRARY_INBOX,
      title: "*Literal* [title]",
      body: "The captured message",
    };
    const value = { pageId: input.pageId, state: "saved" as const };
    const error = new Error("Response lost");
    if (outcome === "failed") vi.mocked(sendInboxMessage).mockRejectedValueOnce(error);
    else
      vi.mocked(sendInboxMessage).mockResolvedValueOnce({
        value,
        acknowledgement: {
          status: "no_op",
          observed: { store_epoch: "epoch:1", commit_head: 1 },
        },
      });

    const hook = renderHook(() => useSendInboxMessage(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      ),
    });
    try {
      await act(async () => {
        if (outcome === "failed") await expect(hook.result.current(input)).rejects.toBe(error);
        else expect(await hook.result.current(input)).toBe(value);
      });
      expect(sendInboxMessage).toHaveBeenCalledExactlyOnceWith(input);
      expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
    } finally {
      hook.unmount();
      queryClient.clear();
    }
  },
);
