import { SyntaxHighlightingExtension } from "@blocknote/core";
import { createCodeBlockHighlighter } from "@blocknote/code-block";
import { createParser } from "prosemirror-highlight/shiki";
import { CODE_BLOCK_SYNTAX_THEME, CODE_BLOCK_SYNTAX_THEME_NAME } from "./code-block-syntax-theme";

/** Shiki asks for a light and a dark theme; the shared palette resolves both from CSS. */
export const CODE_BLOCK_THEME_PAIR = [CODE_BLOCK_SYNTAX_THEME, CODE_BLOCK_SYNTAX_THEME] as const;

const shikiParserSymbol = Symbol.for("blocknote.shikiParser");
const shikiHighlighterPromiseSymbol = Symbol.for("blocknote.shikiHighlighterPromise");

type BlockNoteHighlighter = Awaited<ReturnType<typeof createCodeBlockHighlighter>>;
type BlockNoteParser = ReturnType<typeof createParser>;

type GlobalThisWithBlockNoteShiki = typeof globalThis & {
  [shikiParserSymbol]?: BlockNoteParser;
  [shikiHighlighterPromiseSymbol]?: Promise<BlockNoteHighlighter>;
};

function getGlobalThisForBlockNoteShiki(): GlobalThisWithBlockNoteShiki {
  return globalThis as GlobalThisWithBlockNoteShiki;
}

export function getSharedBlockNoteCodeHighlighter(): Promise<BlockNoteHighlighter> {
  const globalState = getGlobalThisForBlockNoteShiki();
  globalState[shikiHighlighterPromiseSymbol] ??= createCodeBlockHighlighter({
    themes: [CODE_BLOCK_SYNTAX_THEME],
    langs: [],
  });
  return globalState[shikiHighlighterPromiseSymbol];
}

// Seed BlockNote's process-wide lazy parser with explicit light/dark mappings.
export async function preloadBlockNoteDualThemeParser(): Promise<BlockNoteHighlighter> {
  const highlighter = await getSharedBlockNoteCodeHighlighter();
  const globalState = getGlobalThisForBlockNoteShiki();

  globalState[shikiParserSymbol] = createParser(
    highlighter as never,
    {
      themes: {
        light: CODE_BLOCK_SYNTAX_THEME_NAME,
        dark: CODE_BLOCK_SYNTAX_THEME_NAME,
      },
    } as never,
  );

  return highlighter;
}

export const nfmSyntaxHighlighter = SyntaxHighlightingExtension({
  createHighlighter: preloadBlockNoteDualThemeParser,
});
