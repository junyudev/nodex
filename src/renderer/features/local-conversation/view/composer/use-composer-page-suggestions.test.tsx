import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vite-plus/test";
import { readLibraryModule } from "@/lib/api";
import { useComposerPageSuggestions } from "./use-composer-page-suggestions";

vi.mock("@/lib/api", () => ({ readLibraryModule: vi.fn() }));
vi.mock("@/lib/interactive-page-search", () => ({
  useInteractivePageSearch: () => ({ rows: [], enrichment: "idle", queryRevision: "test" }),
}));

test("Pages search the Library without a Project filter and discard an older query response", async () => {
  const pending = new Map<string, (response: unknown) => void>();
  vi.mocked(readLibraryModule).mockImplementation(
    (_routing, request) =>
      new Promise((resolve) => {
        if (request.read.mode !== "page_reference_candidates") throw new Error("Unexpected read");
        pending.set(request.read.query, resolve as (response: unknown) => void);
      }),
  );
  const response = (pageId: string) => ({
    ok: true,
    value: {
      value: {
        kind: "page_reference_candidates",
        items: [
          {
            pageId,
            title: pageId,
            pageKey: null,
            status: null,
            locationLabel: "Library",
            matchExcerpt: null,
            matchSource: "title",
            titleParts: [],
            matchExcerptParts: [],
            matches: [],
          },
        ],
      },
    },
  });
  const subject = renderHook(({ query }) => useComposerPageSuggestions(query), {
    initialProps: { query: "old" },
  });
  expect(readLibraryModule).toHaveBeenCalledWith(
    { kind: "library" },
    { read: { mode: "page_reference_candidates", query: "old", limit: 8 } },
  );
  subject.rerender({ query: "new" });
  await act(async () => {
    pending.get("new")!(response("new-page"));
  });
  await waitFor(() =>
    expect(subject.result.current.items.map((item) => item.pageId)).toEqual(["new-page"]),
  );
  await act(async () => {
    pending.get("old")!(response("old-page"));
  });
  expect(subject.result.current.items.map((item) => item.pageId)).toEqual(["new-page"]);
  expect(subject.result.current.loading).toBe(false);
});
