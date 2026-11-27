import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { expect, test, vi } from "vite-plus/test";
import { libraryContentRoute } from "../../../shared/content-routing-context";
import type { DiscussionDetail, DiscussionRead } from "../../../shared/discussions";
import { usePageDiscussionsController } from "./use-page-discussions-controller";

const readDiscussions = vi.hoisted(() => vi.fn());
vi.mock("@/lib/page-discussions-adapter", () => ({ readDiscussions, applyDiscussion: vi.fn() }));
vi.mock("@/lib/use-library-navigation", () => ({ useLibraryMetadata: () => ({}) }));
vi.mock("@/lib/use-page-block-writers", () => ({ usePageBlockWriters: () => ({}) }));
vi.mock("@/lib/members-runtime", () => ({ useMemberDirectory: () => ({}) }));
vi.mock("@/lib/projection-invalidation-context", () => ({ useProjectionRegistration: vi.fn() }));

test("includes Discussions from every window in the Page views", async () => {
  const pageId = "page:review";
  const timestamp = "2026-11-19T09:00:00.000Z";
  const items = Array.from({ length: 61 }, (_, i): DiscussionDetail => ({
    id: `discussion:${i + 1}`,
    pageId,
    anchor: { kind: "page" },
    quote: "",
    anchorState: "live",
    status: "open",
    createdBy: { type: "member", member_id: "member:reviewer" },
    createdAt: timestamp,
    lastActivityAt: timestamp,
    comments: [],
  }));
  const requested: (string | null)[] = [];
  readDiscussions.mockImplementation(async (_context, read: DiscussionRead) => {
    if (read.mode !== "discussions") throw new Error("Expected a Page Discussion read");
    const cursor = read.cursor?.id ?? null;
    requested.push(cursor);
    const start = cursor === null ? 0 : items.findIndex(({ id }) => id === cursor) + 1;
    const end = start + 30;
    return {
      storeEpoch: "review-epoch",
      commitSeq: 1,
      libraryId: "library:review",
      value: {
        kind: "discussions",
        value: {
          items: items.slice(start, end),
          next: end < items.length ? { id: items[end - 1]!.id, lastActivityAt: timestamp } : null,
        },
      },
    };
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { result } = renderHook(
    () =>
      usePageDiscussionsController({
        contentRoutingContext: libraryContentRoute,
        pageId,
        besideSessionId: null,
        flushDocument: async () => undefined,
      }),
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  );

  await waitFor(() => expect(result.current.views).toHaveLength(61));
  expect(result.current.views.map(({ id }) => id)).toEqual(items.map(({ id }) => id));
  expect(requested).toEqual([null, "discussion:30", "discussion:60"]);
});
