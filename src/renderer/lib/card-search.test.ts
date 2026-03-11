import { describe, expect, test } from "bun:test";
import {
  buildCardSearchText,
  matchesSearchTokens,
  tokenizeSearchQuery,
} from "./card-search";
import type { Card } from "./types";

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: "abc1234",
    status: "draft",
    archived: false,
    title: "Improve NFM search",
    description: "Use token based matching for board search.",
    priority: "p2-medium",
    tags: ["editor", "search"],
    assignee: "alice",
    agentBlocked: false,
    agentStatus: "Implementing",
    created: new Date("2026-02-10T00:00:00.000Z"),
    order: 0,
    ...overrides,
  };
}

describe("card search", () => {
  test("tokenizeSearchQuery splits on whitespace and normalizes case", () => {
    expect(JSON.stringify(tokenizeSearchQuery("  NFM   Search   "))).toBe(
      JSON.stringify(["nfm", "search"])
    );
  });

  test("matchesSearchTokens requires all tokens to be present", () => {
    const text = "nfm editor search";
    expect(matchesSearchTokens(text, ["nfm", "search"])).toBeTrue();
    expect(matchesSearchTokens(text, ["nfm", "missing"])).toBeFalse();
  });

  test("buildCardSearchText includes searchable card fields", () => {
    const card = makeCard();
    const searchable = buildCardSearchText(card);

    expect(searchable.includes("abc1234")).toBeTrue();
    expect(searchable.includes("improve nfm search")).toBeTrue();
    expect(searchable.includes("token based matching")).toBeTrue();
    expect(searchable.includes("editor search")).toBeTrue();
    expect(searchable.includes("alice")).toBeTrue();
    expect(searchable.includes("implementing")).toBeTrue();
  });
});
