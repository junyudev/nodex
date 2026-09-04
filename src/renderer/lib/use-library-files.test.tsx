import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { TestQueryProvider } from "@/test/query";

const api = vi.hoisted(() => ({ readLibraryModule: vi.fn() }));
vi.mock("./api", () => ({
  readLibraryModule: api.readLibraryModule,
  subscribeLibraryChanges: () => () => undefined,
}));

import { useLibraryFileCatalog, usePageFiles } from "./use-library-files";

const envelope = (value: unknown) => ({
  ok: true,
  value: {
    libraryId: "library-1",
    storeEpoch: "epoch-1",
    commitSeq: 4,
    authorization: null,
    value,
  },
});

beforeEach(() => {
  api.readLibraryModule.mockReset();
  api.readLibraryModule.mockImplementation((_access, request) => {
    if (request.read.mode === "metadata") {
      return Promise.resolve(envelope({ kind: "metadata" }));
    }
    if (request.read.mode === "page_file_inventory") {
      return Promise.resolve(
        envelope({
          kind: "page_file_inventory",
          value: {
            page_id: request.read.page_id,
            revision: 3,
            body_usage_revision: 2,
            can_write: true,
            files: [],
            next_cursor: null,
            has_more: false,
            total: 0,
            unplaced_total: 0,
            placed_total: 0,
          },
        }),
      );
    }
    return Promise.resolve(
      envelope({
        kind: "files",
        value: { items: [], next_cursor: null, has_more: false, total: 0 },
      }),
    );
  });
});

describe("Library File queries", () => {
  test("reads a Page relationship inventory without the legacy owner manifest flags", async () => {
    const access = { kind: "project", projectId: "project-1" } as const;
    const { result } = renderHook(() => usePageFiles(access, "page-1"), {
      wrapper: TestQueryProvider,
    });

    await waitFor(() => expect(result.current.inventory?.revision).toBe(3));
    expect(api.readLibraryModule).toHaveBeenCalledWith(access, {
      read: {
        mode: "page_file_inventory",
        page_id: "page-1",
        limit: 50,
      },
    });
  });

  test("passes the unused filter to the paginated Core catalog", async () => {
    const access = { kind: "library" } as const;
    const { result } = renderHook(
      () =>
        useLibraryFileCatalog(access, {
          lifecycle: "live",
          usage: "unused",
          query: "diagram",
        }),
      { wrapper: TestQueryProvider },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(api.readLibraryModule).toHaveBeenCalledWith(access, {
      read: {
        mode: "files",
        lifecycle: "live",
        usage: "unused",
        query: "diagram",
        limit: 50,
      },
    });
  });
});

test("reads a selected File directly without loading its catalog page", async () => {
  api.readLibraryModule.mockImplementation(async (_access, request) =>
    request.read.mode === "file"
      ? envelope({ kind: "file", value: { file_id: request.read.file_id } })
      : envelope({ kind: "metadata" }),
  );
  const { useLibraryFile } = await import("./use-library-files");
  const { result } = renderHook(() => useLibraryFile({ kind: "library" }, "beyond-first-page"), {
    wrapper: TestQueryProvider,
  });
  await waitFor(() => expect(result.current.file?.file_id).toBe("beyond-first-page"));
  expect(
    api.readLibraryModule.mock.calls.some(([, request]) => request.read.mode === "files"),
  ).toBe(false);
});

test("a denied File identity stays unavailable instead of falling back to another File", async () => {
  api.readLibraryModule.mockResolvedValue({
    ok: false,
    error: { message: "Direct access required" },
  });
  const { useLibraryFile } = await import("./use-library-files");
  const { result } = renderHook(
    () => useLibraryFile({ kind: "project", projectId: "p" }, "page-only"),
    {
      wrapper: TestQueryProvider,
    },
  );
  await waitFor(() => expect(result.current.error?.message).toBe("Direct access required"));
  expect(result.current.file).toBeNull();
});
