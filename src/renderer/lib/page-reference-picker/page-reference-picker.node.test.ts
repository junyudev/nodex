import { describe, expect, test, it } from "vite-plus/test";
import {
  deduplicatePageReferenceCandidates,
  presentPageReferenceCandidates,
  resolvePageReferenceDisabledReason,
  selectPageReferenceCandidate,
} from "./candidate-model";
import type { PageReferenceCandidate, PageReferencePickerRequest } from "./types";
import {
  createPageReferenceSearchController,
  resolvePageReferenceSourcePageId,
} from "./search-controller";

describe("candidate model", () => {
  const candidate = (pageId: string): PageReferenceCandidate => ({
    pageId,
    title: pageId,
    pageKey: null,
    status: null,
    locationLabel: "Library",
    lifecycle: "active",
    matchExcerpt: null,
    matchSource: "recent",
    titleParts: [{ text: pageId, highlighted: false }],
    matchExcerptParts: [],
    matches: [],
    disabledReason: null,
  });

  describe("Page reference candidate model", () => {
    test("blocks recursive embeds without blocking mentions or links", () => {
      const context = {
        pageId: "host",
        hostPageId: "host",
        ancestorPageIds: ["ancestor"],
      } as const;
      expect(resolvePageReferenceDisabledReason({ ...context, intent: "reference_block" })).toBe(
        "self",
      );
      expect(
        resolvePageReferenceDisabledReason({
          ...context,
          pageId: "ancestor",
          intent: "reference_block",
        }),
      ).toBe("ancestor_cycle");
      expect(resolvePageReferenceDisabledReason({ ...context, intent: "mention" })).toBeNull();
    });

    test("uses Page identity for deduplication and selection", () => {
      expect(
        deduplicatePageReferenceCandidates(
          [candidate("one"), candidate("one"), candidate("two")],
          2,
        ).map((item) => item.pageId),
      ).toEqual(["one", "two"]);
      expect(selectPageReferenceCandidate(candidate("active"))).toEqual({
        pageId: "active",
        titleSnapshot: "active",
      });
    });

    test("preserves Core order and renders Core-provided evidence", () => {
      const items = presentPageReferenceCandidates([
        {
          ...candidate("body-first"),
          title: "Architecture",
          matchSource: "content",
          matchExcerpt: "The projection stays bounded.",
          matchExcerptParts: [
            { text: "The ", highlighted: false },
            { text: "projection", highlighted: true },
            { text: " stays bounded.", highlighted: false },
          ],
          matches: [
            {
              source: "body",
              quality: "exact",
              blockId: "block:one",
              blockType: "paragraph",
              parts: [
                { text: "The ", highlighted: false },
                { text: "projection", highlighted: true },
                { text: " stays bounded.", highlighted: false },
              ],
            },
          ],
        },
        {
          ...candidate("title-second"),
          title: "Projection notes",
          matchSource: "title",
          titleParts: [
            { text: "Projection", highlighted: true },
            { text: " notes", highlighted: false },
          ],
          matches: [
            {
              source: "title",
              quality: "prefix",
              parts: [
                { text: "Projection", highlighted: true },
                { text: " notes", highlighted: false },
              ],
            },
          ],
        },
      ]);

      expect(items.map((item) => item.candidate.pageId)).toEqual(["body-first", "title-second"]);
      expect(items[0]).toMatchObject({ match: "content", detail: "The projection stays bounded." });
      expect(items[1]).toMatchObject({ match: "prefix_title", detail: null });
      expect(items[1]?.titleSegments?.[0]).toEqual({ text: "Projection", highlight: true });
    });
  });
});

describe("search controller", () => {
  const request = (query: string): PageReferencePickerRequest => ({
    routingContext: { kind: "library" },
    hostPageId: "page:host",
    ancestorPageIds: [],
    intent: "mention",
    query,
    limit: 20,
  });

  describe("Page reference search controller", () => {
    it("fails closed when an older response settles after a newer request", async () => {
      const resolvers = new Map<string, (items: PageReferenceCandidate[]) => void>();
      const controller = createPageReferenceSearchController(
        (input) => new Promise((resolve) => resolvers.set(input.query, resolve)),
      );
      const oldSearch = controller.search(request("old"));
      const currentSearch = controller.search(request("current"));
      resolvers.get("current")?.([]);
      expect(await currentSearch).toEqual({ status: "current", items: [] });
      resolvers.get("old")?.([]);
      expect(await oldSearch).toEqual({ status: "stale", items: [] });
    });

    it("passes source context only for inline mention and link searches", () => {
      expect(resolvePageReferenceSourcePageId(request("query"))).toBe("page:host");
      expect(
        resolvePageReferenceSourcePageId({
          ...request("query"),
          intent: "link",
        }),
      ).toBe("page:host");
      expect(
        resolvePageReferenceSourcePageId({
          ...request("query"),
          intent: "reference_block",
        }),
      ).toBeUndefined();
    });
  });
});
