import { describe, expect, it } from "vitest";
import { computeSuggestionHunks } from "./suggestion-hunks";

interface Block {
  readonly id: string;
  readonly text: string;
}
const b = (id: string, text: string): Block => ({ id, text });
const md = (blocks: readonly Block[]) => blocks.map((block) => block.text).join("\n\n");

describe("computeSuggestionHunks", () => {
  const base = [b("a", "Alpha"), b("b", "Beta"), b("c", "Gamma")];

  it("returns nothing when nothing changed", () => {
    expect(computeSuggestionHunks(base, base, md)).toEqual([]);
  });

  it("turns a rewritten Block into one hunk", () => {
    const draft = [b("a", "Alpha"), b("b", "Beta, revised"), b("c", "Gamma")];
    expect(computeSuggestionHunks(base, draft, md)).toEqual([
      { blockIds: ["b"], oldMarkdown: "Beta", newMarkdown: "Beta, revised" },
    ]);
  });

  it("keeps separate edits separate", () => {
    const draft = [b("a", "Alpha!"), b("b", "Beta"), b("c", "Gamma!")];
    expect(computeSuggestionHunks(base, draft, md)).toEqual([
      { blockIds: ["a"], oldMarkdown: "Alpha", newMarkdown: "Alpha!" },
      { blockIds: ["c"], oldMarkdown: "Gamma", newMarkdown: "Gamma!" },
    ]);
  });

  it("attaches an inserted Block to the Block before it", () => {
    const draft = [b("a", "Alpha"), b("n", "New"), b("b", "Beta"), b("c", "Gamma")];
    expect(computeSuggestionHunks(base, draft, md)).toEqual([
      { blockIds: ["a"], oldMarkdown: "Alpha", newMarkdown: "Alpha\n\nNew" },
    ]);
  });

  it("attaches an insertion at the top to the first Block", () => {
    const draft = [b("n", "New"), ...base];
    expect(computeSuggestionHunks(base, draft, md)).toEqual([
      { blockIds: ["a"], oldMarkdown: "Alpha", newMarkdown: "New\n\nAlpha" },
    ]);
  });

  it("merges insertions that share the first Block as their anchor", () => {
    const original = base.slice(0, 2);
    const draft = [b("x", "First"), original[0]!, b("y", "Second"), original[1]!];
    expect(computeSuggestionHunks(original, draft, md)).toEqual([
      { blockIds: ["a"], oldMarkdown: "Alpha", newMarkdown: "First\n\nAlpha\n\nSecond" },
    ]);
  });

  it("keeps insertions with adjacent but distinct anchors separate", () => {
    const original = base.slice(0, 2);
    const draft = [b("x", "First"), ...original, b("y", "Last")];
    expect(computeSuggestionHunks(original, draft, md)).toEqual([
      { blockIds: ["a"], oldMarkdown: "Alpha", newMarkdown: "First\n\nAlpha" },
      { blockIds: ["b"], oldMarkdown: "Beta", newMarkdown: "Beta\n\nLast" },
    ]);
  });

  it("replaces deleted Blocks with nothing", () => {
    const draft = [b("a", "Alpha"), b("c", "Gamma")];
    expect(computeSuggestionHunks(base, draft, md)).toEqual([
      { blockIds: ["b"], oldMarkdown: "Beta", newMarkdown: "" },
    ]);
  });

  it("groups a change and an insertion beside it into one hunk", () => {
    const draft = [b("a", "Alpha"), b("b", "Beta 2"), b("n", "New"), b("c", "Gamma")];
    expect(computeSuggestionHunks(base, draft, md)).toEqual([
      { blockIds: ["b"], oldMarkdown: "Beta", newMarkdown: "Beta 2\n\nNew" },
    ]);
  });
});
