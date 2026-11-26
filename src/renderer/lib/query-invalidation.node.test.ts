import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, test, vi } from "vite-plus/test";

import { invalidateExactQuery, queryFamilyProjectionCursor } from "./query-invalidation";
import { queryKeys } from "./query-keys";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

describe("exact query invalidation", () => {
  test("coalesces events during an initial fetch into one trailing canonical read", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const responses = [first, second];
    let readCount = 0;
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const queryKey = ["database-view", "view-1"] as const;
    const observer = new QueryObserver(queryClient, {
      queryKey,
      queryFn: () => {
        const response = responses[readCount];
        readCount += 1;
        if (!response) throw new Error("unexpected extra read");
        return response.promise;
      },
    });
    const unsubscribe = observer.subscribe(() => undefined);

    try {
      expect(readCount).toBe(1);
      const refresh = invalidateExactQuery(queryClient, queryKey);
      const coalesced = invalidateExactQuery(queryClient, queryKey);
      expect(coalesced).toBe(refresh);

      first.resolve("stale initial projection");
      await first.promise;
      await vi.waitFor(() => expect(readCount).toBe(2));
      second.resolve("fresh committed projection");
      await refresh;

      expect(queryClient.getQueryData(queryKey)).toBe("fresh committed projection");
      expect(readCount).toBe(2);
    } finally {
      unsubscribe();
      queryClient.clear();
    }
  });

  test("uses the oldest cursor satisfied by every materialized family member", () => {
    const queryClient = new QueryClient();
    const familyKey = queryKeys.library.all();
    queryClient.setQueryData(queryKeys.library.metadata(), {
      storeEpoch: "epoch-1",
      commitSeq: 8,
    });
    queryClient.setQueryData(queryKeys.library.children("library", {}), {
      storeEpoch: "epoch-1",
      commitSeq: 5,
    });
    queryClient.setQueryData(queryKeys.blockDocuments.owned({ kind: "library" }, "page-1"), {
      storeEpoch: "epoch-1",
      headSeq: 12,
    });

    expect(queryFamilyProjectionCursor(queryClient, familyKey)).toEqual({
      storeEpoch: "epoch-1",
      commitSeq: 5,
    });
    queryClient.clear();
  });

  test("ignores a disabled family member that has never owned canonical data", () => {
    const queryClient = new QueryClient();
    const familyKey = queryKeys.library.all();
    queryClient.setQueryData(queryKeys.library.metadata(), {
      storeEpoch: "epoch-1",
      commitSeq: 8,
    });
    const observer = new QueryObserver(queryClient, {
      queryKey: queryKeys.library.children("library", {}),
      queryFn: () => Promise.resolve({}),
      enabled: false,
    });
    const unsubscribe = observer.subscribe(() => undefined);

    try {
      expect(queryFamilyProjectionCursor(queryClient, familyKey)).toEqual({
        storeEpoch: "epoch-1",
        commitSeq: 8,
      });
    } finally {
      unsubscribe();
      queryClient.clear();
    }
  });

  test("does not claim a family cursor while an active member is initially loading", () => {
    const queryClient = new QueryClient();
    const familyKey = queryKeys.library.all();
    const read = deferred<{ storeEpoch: string; commitSeq: number }>();
    queryClient.setQueryData(queryKeys.library.metadata(), {
      storeEpoch: "epoch-1",
      commitSeq: 8,
    });
    const observer = new QueryObserver(queryClient, {
      queryKey: queryKeys.library.children("library", {}),
      queryFn: () => read.promise,
    });
    const unsubscribe = observer.subscribe(() => undefined);

    try {
      expect(queryFamilyProjectionCursor(queryClient, familyKey)).toBeNull();
    } finally {
      unsubscribe();
      queryClient.clear();
    }
  });
});
