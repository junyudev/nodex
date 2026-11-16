import { describe, expect, test } from "vite-plus/test";
import {
  buildBrowserAddressSuggestions,
  type BrowserAddressWorkspaceCandidate,
} from "./browser-address-suggestions";

const candidate = (
  id: string,
  kind: BrowserAddressWorkspaceCandidate["kind"],
  title: string,
): BrowserAddressWorkspaceCandidate => ({ id, kind, title });
const titlePage = (id: string, title: string, quality: "exact" | "prefix" | "typo" = "exact") => ({
  ...candidate(id, "page", title),
  pageMatches: [{ source: "title" as const, quality, parts: [] }],
});

const rowIds = (query: string, candidates: readonly BrowserAddressWorkspaceCandidate[]) =>
  buildBrowserAddressSuggestions(query, candidates).map((row) => row.id);

describe("Browser address suggestions", () => {
  test("matches tools and tabs only at word starts, with locale-aware casing and punctuation", () => {
    expect(
      rowIds("  TE  ", [
        candidate("tool", "launch-action", "Terminal"),
        candidate("tab", "switch-tab", "My—Terminal"),
        candidate("middle", "switch-tab", "Notes"),
        candidate("page", "page", "Notes"),
      ]),
    ).toEqual(["tool", "tab", "typed"]);
    expect(rowIds("ÉD", [candidate("accented", "switch-tab", "Mon Éditeur")])).toEqual([
      "accented",
      "typed",
    ]);
  });

  test("orders exact, prefix and word-substring matches, then tools before tabs, preserving source order", () => {
    expect(
      rowIds("term", [
        candidate("substring-tab", "switch-tab", "My Terminal"),
        candidate("prefix-tab", "switch-tab", "Terminal"),
        candidate("exact-tab", "switch-tab", "Term"),
        candidate("prefix-tool-1", "launch-action", "Terminal"),
        candidate("substring-tool", "launch-action", "Open Terminal"),
        candidate("prefix-tool-2", "launch-action", "Terminal tools"),
        candidate("exact-tool", "launch-action", "Term"),
      ]),
    ).toEqual([
      "exact-tool",
      "exact-tab",
      "prefix-tool-1",
      "prefix-tool-2",
      "prefix-tab",
      "substring-tool",
      "substring-tab",
      "typed",
    ]);
  });

  test("keeps body-only Page evidence and ranks strong hits ahead of typos", () => {
    const bodyOnly = {
      ...candidate("body", "page", "Storage notes"),
      pageMatches: [
        {
          source: "body" as const,
          quality: "exact" as const,
          blockId: "block:1",
          blockType: "paragraph",
          parts: [{ text: "迁移", highlighted: true }],
        },
      ],
    };
    expect(rowIds("迁移", [bodyOnly])).toEqual(["typed", "body"]);
    expect(
      rowIds("Ｍｉｇｒａｔｉｏｎ", [
        titlePage("loose", "Migartion", "typo"),
        bodyOnly,
        titlePage("title", "PageMigration"),
      ]),
    ).toEqual(["title", "typed", "body", "loose"]);
  });

  test("keeps the first five Pages in relevance order", () => {
    expect(
      rowIds(
        "plan",
        Array.from({ length: 6 }, (_, i) => titlePage(`page-${i}`, `Plan ${i}`)),
      ),
    ).toEqual(["page-0", "page-1", "page-2", "page-3", "page-4", "typed"]);
  });

  test("puts URL navigation first even when workspace titles match", () => {
    const rows = buildBrowserAddressSuggestions("example.com", [
      candidate("tab", "switch-tab", "example.com"),
      titlePage("page", "example.com docs"),
    ]);
    expect(rows.map((row) => row.id)).toEqual(["typed", "tab", "page"]);
    expect(rows[0]).toMatchObject({ kind: "url", title: "example.com" });
    expect(buildBrowserAddressSuggestions("local development", [])[0]).toMatchObject({
      kind: "search",
    });
    expect(buildBrowserAddressSuggestions("localhost:3000", [])[0]).toMatchObject({ kind: "url" });
  });

  test("classifies typed paths and schemes with the same normalization as address submission", () => {
    expect(buildBrowserAddressSuggestions("/tmp/page.html", [])[0]).toMatchObject({ kind: "url" });
    expect(buildBrowserAddressSuggestions("/tmp/page.html\n", [])[0]).toMatchObject({
      kind: "search",
    });
    expect(buildBrowserAddressSuggestions("javascript:alert(1)", [])[0]).toMatchObject({
      kind: "search",
    });
    expect(buildBrowserAddressSuggestions("github.io", [])[0]).toMatchObject({ kind: "search" });
  });

  test.each(["www.example.com", "HTTPS://example.com", "custom+scheme:page", "about:blank"])(
    "suppresses workspace suggestions for %s",
    (query) => {
      expect(
        rowIds(query, [
          candidate("tool", "launch-action", query),
          candidate("page", "page", query),
        ]),
      ).toEqual(["typed"]);
    },
  );

  test("returns no suggestions for empty input and caps the result at eight without dropping the typed row", () => {
    const tools = Array.from({ length: 12 }, (_, i) =>
      candidate(`tool-${i}`, "launch-action", `Tool ${i}`),
    );
    expect(rowIds("  ", tools)).toEqual([]);
    expect(rowIds("tool", tools)).toEqual([
      "tool-0",
      "tool-1",
      "tool-2",
      "tool-3",
      "tool-4",
      "tool-5",
      "tool-6",
      "typed",
    ]);
  });
});
