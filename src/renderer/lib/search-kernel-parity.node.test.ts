import { describe, expect, test } from "vite-plus/test";
import type { SearchTextKind } from "@nodex/search-kernel";
import { searchKernel } from "@nodex/search-kernel/node";
import fixture from "../../../crates/nodex-search-kernel/tests/fixtures/parity.json";

describe("Search kernel WASM adapter", () => {
  const { indexText, SearchTextQuery, PageSearchPreviewIndex } = searchKernel();

  test("supports field-major ranks inside both chat tiers", () => {
    const { rankMatch } = searchKernel();
    expect(rankMatch("prefix", 0, 4)).toBeLessThan(rankMatch("exact", 2, 4));
    expect(rankMatch("stem", 3, 4)).toBeLessThan(rankMatch("typo", 0, 4));
    expect(rankMatch("infix", 0, 4)).toBeLessThan(rankMatch("typo", 1, 4));
  });

  test("satisfies the same corpus contract as native Rust", () => {
    const index = new PageSearchPreviewIndex(fixture.documents);
    for (const parityCase of fixture.cases) {
      const hits = index.search(parityCase.request) as {
        pageId: string;
        matches: { quality: string }[];
      }[];
      expect(
        hits.map((hit) => hit.pageId),
        parityCase.name,
      ).toEqual(parityCase.expectedPageIds);
      if (parityCase.expectedQualities) {
        expect(
          hits.map((hit) => hit.matches[0]?.quality),
          parityCase.name,
        ).toEqual(parityCase.expectedQualities);
      }
    }
  });

  test("returns the same indexed segments and original-text highlights as native Rust", () => {
    for (const parityCase of fixture.analysisCases) {
      expect(indexText(parityCase.text), parityCase.text).toBe(
        parityCase.expected.map(({ folded }) => folded).join(" "),
      );
    }
    for (const parityCase of fixture.textCases) {
      const query = new SearchTextQuery(parityCase.query);
      try {
        const match = query.evidence(parityCase.text, parityCase.kind as SearchTextKind, true);
        expect(match.words[0], parityCase.name).toEqual(parityCase.expected);
      } finally {
        query.free();
      }
    }
  });

  test("applies upserts and removals without retaining stale postings", () => {
    const index = new PageSearchPreviewIndex(fixture.documents);
    const replacement = {
      ...fixture.documents[0],
      title: "Replacement title",
      properties: [],
    };
    index.applyDelta([replacement], []);

    const request = {
      ...fixture.cases[0].request,
      query: "replacement",
    };
    expect((index.search(request) as { pageId: string }[]).map((hit) => hit.pageId)).toEqual([
      replacement.pageId,
    ]);

    index.applyDelta([], [replacement.pageId]);
    expect(index.search(request)).toEqual([]);
  });
});
