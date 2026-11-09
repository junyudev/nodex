import { describe, expect, test } from "vite-plus/test";
import {
  buildPageSearchText,
  compilePageCollectionSearchQuery,
  matchesPageCollectionSearchQuery,
  matchesSearchTokens,
  tokenizeSearchQuery,
} from "./page-search";
import type { DatabasePageSummary } from "./types";
import { plainTextToPortableRichText } from "../../shared/block-documents/portable-rich-text";

function makeCard(overrides: Partial<DatabasePageSummary> = {}): DatabasePageSummary {
  const title = overrides.title ?? "Improve NFM search";
  return {
    id: "abc1234",
    status: "triage",
    archived: false,
    title,
    richTitle: overrides.richTitle ?? plainTextToPortableRichText(title),
    descriptionPreview: "Use token based matching for board search.",
    descriptionLength: "Use token based matching for board search.".length,
    hasDescription: true,
    priority: "p2-medium",
    tags: ["o_AAAAAAAA", "o_BBBBBBBB"],
    assignee: { kind: "member", member_id: "alice" },
    created: new Date("2026-02-10T00:00:00.000Z"),
    order: 0,
    ...overrides,
    pageKey: overrides.pageKey ?? null,
  };
}

describe("card search", () => {
  test("tokenizeSearchQuery splits on whitespace and normalizes case", () => {
    expect(JSON.stringify(tokenizeSearchQuery("  NFM   Search   "))).toBe(
      JSON.stringify(["nfm", "search"]),
    );
  });

  test("matchesSearchTokens requires all tokens to be present", () => {
    const text = "nfm editor search";
    expect(matchesSearchTokens(text, ["nfm", "search"])).toBe(true);
    expect(matchesSearchTokens(text, ["nfm", "missing"])).toBe(false);
  });

  test("buildPageSearchText includes ordinary searchable card fields", () => {
    const card = makeCard({ pageKey: "LAB-13" });
    const searchable = buildPageSearchText(
      card,
      ["Editor", "Search"],
      [
        {
          id: "alice",
          library_id: "library",
          display_name: "Alice",
          role: "member",
          lifecycle: "active",
          revision: 1,
        },
      ],
    );

    expect(searchable.includes("abc1234")).toBe(true);
    expect(searchable.includes("lab-13")).toBe(false);
    expect(searchable.includes("improve nfm search")).toBe(true);
    expect(searchable.includes("token based matching")).toBe(true);
    expect(searchable.includes("editor search")).toBe(true);
    expect(searchable.includes("o_aaaaaaaa")).toBe(false);
    expect(searchable.includes("alice")).toBe(true);
  });

  test.each([
    { query: "LAB-13", pageKey: "LAB-13", title: "Polish launch", expected: true },
    { query: "lab13", pageKey: "LAB-13", title: "Polish launch", expected: true },
    { query: "lab-1", pageKey: "LAB-13", title: "Polish launch", expected: true },
    { query: "b-1", pageKey: "LAB-13", title: "Polish launch", expected: false },
    { query: "#LAB-13", pageKey: "RND-9", title: "Discuss #LAB-13", expected: false },
    { query: "#", pageKey: "LAB-13", title: "Hash", expected: false },
    { query: "##LAB-13", pageKey: "LAB-13", title: "Hash", expected: false },
    { query: "LAB-13 polish", pageKey: "RND-9", title: "LAB-13 polish", expected: true },
    { query: "#LAB-13 polish", pageKey: "LAB-13", title: "Polish", expected: false },
  ])("applies one Page-key query policy to '$query'", ({ query, pageKey, title, expected }) => {
    const card = makeCard({ pageKey, title });
    const compiled = compilePageCollectionSearchQuery(query);

    expect(
      matchesPageCollectionSearchQuery(card.pageKey, buildPageSearchText(card), compiled),
    ).toBe(expected);
  });
});
