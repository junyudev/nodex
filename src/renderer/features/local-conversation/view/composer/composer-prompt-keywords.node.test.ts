import { describe, expect, it } from "vite-plus/test";
import { CLAUDE_PROMPT_KEYWORDS, findComposerPromptKeywords } from "./composer-prompt-keywords";

const words = (text: string) =>
  findComposerPromptKeywords(text, CLAUDE_PROMPT_KEYWORDS).map(({ from, to, keyword }) => [
    text.slice(from, to),
    keyword.word,
  ]);

describe("findComposerPromptKeywords", () => {
  it("finds Claude Code's keywords as whole words in any case", () => {
    expect(words("Ultrathink about this, then ULTRACODE it.")).toEqual([
      ["Ultrathink", "ultrathink"],
      ["ULTRACODE", "ultracode"],
    ]);
  });

  it("ignores the words inside longer words", () => {
    expect(words("ultrathinking ultracoded preultrathink")).toEqual([]);
  });

  it("finds nothing for an Agent without keywords", () => {
    expect(findComposerPromptKeywords("ultrathink", [])).toEqual([]);
  });
});
