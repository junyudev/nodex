import { describe, expect, test } from "vite-plus/test";
import {
  buildBrowserAddressSuggestions,
  type BrowserAddressWorkspaceCandidate,
} from "./browser-address-suggestions";

const candidate = (
  id: string,
  kind: BrowserAddressWorkspaceCandidate["kind"],
  title: string,
  updatedAt?: number,
): BrowserAddressWorkspaceCandidate => ({ id, kind, title, updatedAt });
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
    ).toEqual(["tool", "tab", "typed", "page"]);
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

  test("places exact and prefix Pages before web search and substring Pages after it, newest first", () => {
    expect(
      rowIds("plan", [
        candidate("old-prefix", "page", "Planning", 10),
        candidate("substring", "page", "Sprint planning", 30),
        candidate("new-exact", "page", "Plan", 20),
        candidate("miss", "page", "Other", 40),
      ]),
    ).toEqual(["new-exact", "old-prefix", "typed", "substring"]);
  });

  test("keeps only the five newest matching Pages before arranging them around web search", () => {
    expect(
      rowIds(
        "plan",
        Array.from({ length: 6 }, (_, i) => candidate(`page-${i}`, "page", `Plan ${i}`, i)),
      ),
    ).toEqual(["page-5", "page-4", "page-3", "page-2", "page-1", "typed"]);
  });

  test("puts URL navigation first even when workspace titles match", () => {
    const rows = buildBrowserAddressSuggestions("example.com", [
      candidate("tab", "switch-tab", "example.com"),
      candidate("page", "page", "example.com docs"),
    ]);
    expect(rows.map((row) => row.id)).toEqual(["typed", "tab", "page"]);
    expect(rows[0]).toMatchObject({ kind: "url", title: "example.com" });
    expect(buildBrowserAddressSuggestions("local development", [])[0]).toMatchObject({
      kind: "search",
    });
    expect(buildBrowserAddressSuggestions("localhost:3000", [])[0]).toMatchObject({ kind: "url" });
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
