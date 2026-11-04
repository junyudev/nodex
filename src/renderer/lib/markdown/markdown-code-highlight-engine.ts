import { createCodePlugin, type HighlightOptions, type HighlightResult } from "@streamdown/code";
import { CODE_BLOCK_THEME_PAIR } from "../code-block-syntax-theme";
import type { CodeHighlightRequest, CodeHighlightTokens } from "./markdown-code-highlight-queue";

const themes: HighlightOptions["themes"] = [...CODE_BLOCK_THEME_PAIR];
const plugin = createCodePlugin({ themes });

/** Keep incremental grammar state inside the engine; only token paint crosses the worker port. */
export function highlightCode(request: CodeHighlightRequest): Promise<CodeHighlightTokens | null> {
  return new Promise<CodeHighlightTokens | null>((resolve) => {
    const complete = ({ grammarState: _grammarState, ...paint }: HighlightResult) => resolve(paint);
    const immediate = plugin.highlight(
      {
        code: request.code,
        language: request.language as HighlightOptions["language"],
        isIncomplete: request.incomplete,
        themes,
      },
      complete,
      () => resolve(null),
    );
    if (immediate) complete(immediate);
  });
}
