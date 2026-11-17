import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vite-plus/test";
import type { FindPhase, FindRequest, FindResponse } from "../../../../../shared/find";
import { findFixture, pageFindHit } from "@/test/find-fixture";
import { useComposerPageSuggestions } from "./use-composer-page-suggestions";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@/lib/renderer-command", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/renderer-command")>()),
  invokeRendererQuery: invoke,
  invokeRendererControl: vi.fn(async () => true),
}));

test("prefers the active Project across the Library and discards an older response", async () => {
  const pending = new Map<string, (response: FindResponse) => void>();
  const response = (phase: FindPhase, pageId: string) =>
    findFixture(phase, [
      pageFindHit({
        pageId,
        title: pageId,
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
      }),
    ]);
  invoke.mockImplementation((_channel, request: FindRequest, phase: FindPhase) =>
    phase === "complete"
      ? Promise.resolve(response(phase, `${request.query}-page`))
      : new Promise<FindResponse>((resolve) => pending.set(request.query, resolve)),
  );
  const subject = renderHook(({ query }) => useComposerPageSuggestions(query, "ops"), {
    initialProps: { query: "old" },
  });
  expect(invoke).toHaveBeenCalledWith(
    "find:search",
    expect.objectContaining({
      kinds: ["page"],
      place: { kind: "everywhere" },
      preferredProjectId: "ops",
      query: "old",
    }),
    "instant",
    expect.any(String),
  );
  subject.rerender({ query: "new" });
  await act(async () => {
    pending.get("new")!(response("instant", "new-page"));
  });
  await waitFor(() =>
    expect(subject.result.current.items.map((item) => item.pageId)).toEqual(["new-page"]),
  );
  await act(async () => {
    pending.get("old")!(response("instant", "old-page"));
  });
  expect(subject.result.current.items.map((item) => item.pageId)).toEqual(["new-page"]);
  await waitFor(() => expect(subject.result.current.loading).toBe(false));
});
