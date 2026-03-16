import { codeBlockOptions } from "@blocknote/code-block";
import { createParser } from "prosemirror-highlight/shiki";

export const NFM_CODE_THEMES = {
  light: "github-light",
  dark: "github-dark",
} as const;

export const NFM_CODE_THEME_PAIR = [
  NFM_CODE_THEMES.light,
  NFM_CODE_THEMES.dark,
] as const;

const shikiParserSymbol = Symbol.for("blocknote.shikiParser");
const shikiHighlighterPromiseSymbol = Symbol.for(
  "blocknote.shikiHighlighterPromise",
);

type BlockNoteCreateHighlighter = NonNullable<
  typeof codeBlockOptions.createHighlighter
>;
type BlockNoteHighlighter = Awaited<ReturnType<BlockNoteCreateHighlighter>>;
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
  const createHighlighter = codeBlockOptions.createHighlighter;

  if (!createHighlighter) {
    throw new Error("BlockNote code blocks require a createHighlighter implementation.");
  }

  globalState[shikiHighlighterPromiseSymbol] ??= createHighlighter();
  return globalState[shikiHighlighterPromiseSymbol];
}

// BlockNote's lazy Shiki plugin falls back to the first loaded theme unless we
// seed its shared parser with explicit light/dark mappings.
export async function preloadBlockNoteDualThemeParser(): Promise<BlockNoteHighlighter> {
  const highlighter = await getSharedBlockNoteCodeHighlighter();
  const globalState = getGlobalThisForBlockNoteShiki();

  globalState[shikiParserSymbol] = createParser(highlighter as never, {
    themes: {
      light: NFM_CODE_THEMES.light,
      dark: NFM_CODE_THEMES.dark,
    },
  } as never);

  return highlighter;
}
