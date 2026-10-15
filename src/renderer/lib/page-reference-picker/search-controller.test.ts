import { describe, expect, it } from "vite-plus/test";
import {
  createPageReferenceSearchController,
  resolvePageReferenceSourcePageId,
} from "./search-controller";
import type { PageReferenceCandidate, PageReferencePickerRequest } from "./types";

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
