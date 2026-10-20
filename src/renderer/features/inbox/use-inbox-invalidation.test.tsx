import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { queryKeys } from "@/lib/query-keys";
import { useInboxInvalidation } from "./use-inbox";

const inboxChanges = vi.hoisted(() => ({ emit: () => {} }));
vi.mock("@/lib/api", () => ({
  subscribeInboxChanges: (listener: () => void) => {
    inboxChanges.emit = listener;
    return () => {
      inboxChanges.emit = () => {};
    };
  },
}));

describe("useInboxInvalidation", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("refreshes the Inbox once for a burst of changes, and again for the next", async () => {
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const hook = renderHook(() => useInboxInvalidation(), { wrapper });

    // Typing in a message's Page commits several times in quick succession.
    inboxChanges.emit();
    inboxChanges.emit();
    inboxChanges.emit();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.inbox.all() });

    inboxChanges.emit();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(invalidate).toHaveBeenCalledTimes(2);

    inboxChanges.emit();
    hook.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(invalidate).toHaveBeenCalledTimes(2);
  });
});
