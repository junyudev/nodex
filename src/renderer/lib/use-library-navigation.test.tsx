import { QueryClient } from "@tanstack/react-query";
import { act, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";

import type { ProjectionStreamMessage } from "../../shared/projection-stream";
import { render } from "../test/dom";
import { TestQueryProvider } from "../test/query";
import { ProjectionInvalidationRegistry } from "./projection-invalidation-registry";
import {
  libraryMetadataQueryOptions,
  useLibraryNavigationInvalidation,
} from "./use-library-navigation";

const mocks = vi.hoisted(() => ({
  readLibraryModule: vi.fn(),
  subscribeLibraryChanges: vi.fn(() => () => undefined),
}));

vi.mock("./api", () => ({
  readLibraryModule: mocks.readLibraryModule,
  subscribeLibraryChanges: mocks.subscribeLibraryChanges,
}));

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

const metadata = (commitSeq: number) => ({
  ok: true as const,
  value: {
    libraryId: "library-1",
    storeEpoch: "epoch-1",
    commitSeq,
    value: { kind: "metadata" as const },
  },
});

function LibraryInvalidationHarness() {
  useLibraryNavigationInvalidation();
  return null;
}

describe("Library navigation invalidation", () => {
  beforeEach(() => {
    mocks.readLibraryModule.mockReset();
    mocks.subscribeLibraryChanges.mockClear();
  });

  test("retains the Library audience while authority reset refetches metadata", async () => {
    const secondRead = deferred<ReturnType<typeof metadata>>();
    mocks.readLibraryModule
      .mockResolvedValueOnce(metadata(1))
      .mockImplementationOnce(() => secondRead.promise);
    const listeners = new Set<(message: ProjectionStreamMessage) => void>();
    const subscribeProjection = vi.fn(
      (_scope, listener: (message: ProjectionStreamMessage) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    );
    const registry = new ProjectionInvalidationRegistry({
      subscribeProjection,
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    render(
      <TestQueryProvider client={queryClient} projectionRegistry={registry}>
        <LibraryInvalidationHarness />
      </TestQueryProvider>,
    );
    await waitFor(() => {
      expect(subscribeProjection).toHaveBeenCalledOnce();
      expect(listeners.size).toBe(1);
    });

    let reset!: Promise<void>;
    await act(async () => {
      reset = queryClient.resetQueries({
        queryKey: libraryMetadataQueryOptions().queryKey,
        exact: true,
      });
      await Promise.resolve();
    });
    await waitFor(() => expect(mocks.readLibraryModule).toHaveBeenCalledTimes(2));

    expect(listeners.size).toBe(1);
    expect(subscribeProjection).toHaveBeenCalledOnce();

    secondRead.resolve(metadata(2));
    await act(async () => {
      await reset;
    });
    expect(subscribeProjection).toHaveBeenCalledOnce();
  });
});
