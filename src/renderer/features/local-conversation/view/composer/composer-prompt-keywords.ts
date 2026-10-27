import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { createEditorDecorationTooltip } from "@/lib/editor-decoration-tooltip";
import { readComposerSuggestionState } from "./composer-suggestion-state";

/** A word the Agent itself reacts to inside a message, shown so the user knows it counts. */
export interface ComposerPromptKeyword {
  readonly word: string;
  readonly hint: string;
}

/** Claude Code reads these words in a message and changes only that turn. */
export const CLAUDE_PROMPT_KEYWORDS: readonly ComposerPromptKeyword[] = [
  { word: "ultrathink", hint: "Claude reasons more deeply on this turn" },
  { word: "ultracode", hint: "Claude runs a multi-agent workflow for this turn" },
];

export interface ComposerPromptKeywordMatch {
  readonly from: number;
  readonly to: number;
  readonly keyword: ComposerPromptKeyword;
}

/** Whole words only and in any case, the way Claude Code matches them. */
export function findComposerPromptKeywords(
  text: string,
  keywords: readonly ComposerPromptKeyword[],
): readonly ComposerPromptKeywordMatch[] {
  if (keywords.length === 0) return [];
  const byWord = new Map(keywords.map((keyword) => [keyword.word.toLowerCase(), keyword]));
  const pattern = new RegExp(
    `\\b(${keywords.map(({ word }) => word.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("|")})\\b`,
    "giu",
  );
  return [...text.matchAll(pattern)].flatMap((match) => {
    const keyword = byWord.get(match[0].toLowerCase());
    return keyword && match.index !== undefined
      ? [{ from: match.index, to: match.index + match[0].length, keyword }]
      : [];
  });
}

const KEYWORD_ATTRIBUTE = "data-composer-prompt-keyword";
export const composerPromptKeywordsPluginKey = new PluginKey("composer-prompt-keywords");

function keywordDecorations(
  state: EditorState,
  keywords: readonly ComposerPromptKeyword[],
): DecorationSet {
  if (keywords.length === 0) return DecorationSet.empty;
  // A `/ultracode` being typed is a command, not a keyword.
  const command = readComposerSuggestionState(state).range;
  const decorations: Decoration[] = [];
  state.doc.descendants((node, position) => {
    if (!node.isText || !node.text) return;
    for (const match of findComposerPromptKeywords(node.text, keywords)) {
      const from = position + match.from;
      const to = position + match.to;
      if (command && from < command.to && to > command.from) continue;
      decorations.push(
        Decoration.inline(from, to, {
          class:
            "bg-linear-to-r from-token-charts-orange via-token-charts-purple to-token-charts-blue bg-clip-text text-transparent",
          [KEYWORD_ATTRIBUTE]: match.keyword.word,
          "data-composer-prompt-keyword-hint": match.keyword.hint,
        }),
      );
    }
  });
  return DecorationSet.create(state.doc, decorations);
}

/** Highlights the Agent's keywords and explains each on hover; the text itself never changes. */
export function createComposerPromptKeywordsPlugin(keywordsRef: {
  readonly current: readonly ComposerPromptKeyword[] | undefined;
}) {
  return new Plugin({
    key: composerPromptKeywordsPluginKey,
    props: {
      decorations: (state) => keywordDecorations(state, keywordsRef.current ?? []),
    },
    view: (view) => {
      const tooltip = createEditorDecorationTooltip({
        root: view.dom,
        selector: `[${KEYWORD_ATTRIBUTE}]`,
        read: (element) => element.dataset.composerPromptKeywordHint,
        // The same surface as every Nodex tooltip.
        surfaceClassName: "border-[0.5px] border-token-border bg-token-dropdown-background",
        dataAttribute: "data-composer-prompt-keyword-tooltip",
      });
      return { destroy: tooltip.destroy };
    },
  });
}
