import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vite-plus/test";
import { findFixture, pageFindHit } from "../test/find-fixture";
import type { FindPhase, FindRequest, FindResponse } from "../../shared/find";
import type { PageSearchResult } from "../../shared/types";
import { useInteractivePageSearch } from "./interactive-page-search";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("./renderer-command", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./renderer-command")>()),
  invokeRendererQuery: invoke,
  invokeRendererControl: vi.fn(async () => true),
}));

function page(title: string): PageSearchResult {
  return {
    pageId: title,
    title,
    projectId: null,
    pageKey: null,
    status: null,
    priority: null,
    tags: [],
    assignee: null,
    locationLabel: "Library",
    titleParts: [],
    excerpt: null,
    excerptParts: [],
    matches: [],
    updatedAt: "2026-11-18",
  };
}

function deferred() {
  let resolve!: (value: FindResponse) => void;
  const promise = new Promise<FindResponse>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

test("ignores enrichment from an earlier query while keeping live instant matches", async () => {
  const previous = deferred();
  const current = deferred();
  invoke.mockImplementation((_channel, input: FindRequest, phase: FindPhase) =>
    phase === "instant"
      ? Promise.resolve(findFixture(phase, [pageFindHit(page(input.query))]))
      : input.query === "old"
        ? previous.promise
        : current.promise,
  );
  const hook = renderHook(({ query }) => useInteractivePageSearch({ query }), {
    initialProps: { query: "old" },
  });
  await waitFor(() => expect(hook.result.current.rows[0]?.title).toBe("old"));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith(
      "find:search",
      expect.objectContaining({ query: "old" }),
      "complete",
      expect.any(String),
    ),
  );
  hook.rerender({ query: "new" });
  await waitFor(() => expect(hook.result.current.rows[0]?.title).toBe("new"));
  await act(async () => previous.resolve(findFixture("complete", [pageFindHit(page("stale"))])));
  expect(hook.result.current.rows[0]?.title).toBe("new");
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith(
      "find:search",
      expect.objectContaining({ query: "new" }),
      "complete",
      expect.any(String),
    ),
  );
  await act(async () => current.resolve(findFixture("complete", [pageFindHit(page("enriched"))])));
  expect(hook.result.current.enrichment).toBe("settled");
  expect(hook.result.current.rows[0]?.title).toBe("enriched");
});
