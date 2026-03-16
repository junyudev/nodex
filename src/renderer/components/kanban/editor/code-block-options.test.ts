import { describe, expect, test } from "bun:test";
import { editorCodeBlockOptions } from "./code-block-options";

const shikiParserSymbol = Symbol.for("blocknote.shikiParser");
const shikiHighlighterPromiseSymbol = Symbol.for(
  "blocknote.shikiHighlighterPromise",
);

type GlobalThisWithBlockNoteShiki = typeof globalThis & {
  [shikiParserSymbol]?: unknown;
  [shikiHighlighterPromiseSymbol]?: unknown;
};

function clearBlockNoteShikiState(): void {
  const globalState = globalThis as GlobalThisWithBlockNoteShiki;
  delete globalState[shikiParserSymbol];
  delete globalState[shikiHighlighterPromiseSymbol];
}

describe("editorCodeBlockOptions", () => {
  test("seeds a dual-theme BlockNote parser for light and dark code blocks", async () => {
    clearBlockNoteShikiState();
    try {
      const createHighlighter = editorCodeBlockOptions.createHighlighter;
      if (!createHighlighter) {
        throw new Error("Expected editor code block options to provide a highlighter.");
      }

      const highlighter = await createHighlighter();
      await highlighter.loadLanguage("ts");

      const parser = (globalThis as GlobalThisWithBlockNoteShiki)[
        shikiParserSymbol
      ];

      expect((typeof parser === "function")).toBeTrue();
      if (typeof parser !== "function") return;

      const content = "const answer = 42";
      const decorations = parser({
        content,
        language: "ts",
        pos: 0,
        size: content.length + 2,
      });

      expect(Array.isArray(decorations)).toBeTrue();
      if (!Array.isArray(decorations)) return;

      const rootStyle = String(decorations[0]?.type?.attrs?.style ?? "");
      const tokenStyle = String(decorations[1]?.type?.attrs?.style ?? "");

      expect(rootStyle.includes("--shiki-dark")).toBeTrue();
      expect(tokenStyle.includes("--shiki-dark")).toBeTrue();
    } finally {
      clearBlockNoteShikiState();
    }
  });
});
