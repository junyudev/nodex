import type { PageSearchReveal } from "@/lib/page-search-reveal";
import type { BlockNoteEditor } from "@blocknote/core";
import type { ContentSearchLocalSource } from "@/features/content-search/content-search-context";
import {
  activateNfmSearchMatch,
  getNfmSearchState,
  readNfmSearchMatches,
  replaceActiveNfmSearchMatch,
  replaceAllNfmSearchMatches,
  revealActiveNfmSearchMatch,
  revealNfmSearchBlock,
  setNfmSearchQuery,
} from "./search-extension";

/** The editor owns document ranges and decorations; Workbench Find owns the query and cursor. */
export function createPageContentSearchSource(
  editor: BlockNoteEditor<any, any, any>,
  contextId: string,
  onScroll?: () => void,
): ContentSearchLocalSource {
  let consumedReveal: PageSearchReveal | undefined;
  return {
    domain: "page",
    contextId,
    isFocused: () =>
      document.activeElement?.closest(".ProseMirror") === editor.prosemirrorView?.dom,
    findHost: () =>
      editor.domElement?.closest<HTMLElement>(
        '[data-slot="codex-dialog-content"], [role="dialog"]',
      ) ?? null,
    subscribe: (listener) => editor.onChange(() => listener()),
    search: (query, _limit, options) => {
      const reveal = options?.pageReveal !== consumedReveal ? options?.pageReveal : undefined;
      consumedReveal = options?.pageReveal;
      setNfmSearchQuery(editor, query, reveal?.blockId);
      const matches = readNfmSearchMatches(editor).map((range, ordinal) => ({
        id: `${contextId}:${range.from}:${range.to}`,
        contextId,
        domain: "page" as const,
        ordinal,
      }));
      const preferred = reveal ? getNfmSearchState(editor).activeIndex : undefined;
      if (reveal && (preferred === undefined || preferred < 0))
        revealNfmSearchBlock(editor, reveal.blockId, onScroll);
      return {
        query,
        matches,
        totalMatches: matches.length,
        capped: false,
        ...(preferred !== undefined ? { preferredMatchId: matches[preferred]?.id ?? null } : {}),
      };
    },
    activate: (match, query) => {
      setNfmSearchQuery(editor, query);
      activateNfmSearchMatch(editor, match.ordinal);
      revealActiveNfmSearchMatch(editor, onScroll);
    },
    clear: () => {
      if (editor._tiptapEditor.isDestroyed || !getNfmSearchState(editor).query) return;
      setNfmSearchQuery(editor, "");
    },
    ...(editor.isEditable
      ? {
          replace: {
            current: (text: string) => {
              replaceActiveNfmSearchMatch(editor, text);
            },
            all: (text: string) => {
              replaceAllNfmSearchMatches(editor, text);
            },
          },
        }
      : {}),
  };
}
