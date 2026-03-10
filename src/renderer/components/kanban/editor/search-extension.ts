import { createExtension } from "@blocknote/core";
import type { Node as ProsemirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { escapeAttributeValue, findBlockElementById } from "./block-dom-selectors";

interface SearchMatch {
  from: number;
  to: number;
}

interface NfmSearchPluginState {
  query: string;
  matches: SearchMatch[];
  activeIndex: number;
  decorations: DecorationSet;
}

type NfmSearchAction =
  | { type: "set-query"; query: string }
  | { type: "next" }
  | { type: "prev" };

interface BlockRef {
  id: string;
}

interface EditorWithSearchNavigation {
  domElement?: ParentNode;
  prosemirrorView: EditorView;
  prosemirrorState: EditorState;
  getParentBlock: (id: string) => BlockRef | undefined;
  transact: <T>(callback: (tr: Transaction) => T) => T;
}

interface EditorWithSearchCommands {
  prosemirrorState: EditorState;
  transact: <T>(callback: (tr: Transaction) => T) => T;
}

export const nfmSearchPluginKey = new PluginKey<NfmSearchPluginState>("nfm-search");

function normalizeQuery(query: string): string {
  return query.trim();
}

function wrapIndex(index: number, total: number): number {
  if (total <= 0) return -1;
  return ((index % total) + total) % total;
}

function buildDecorations(
  doc: ProsemirrorNode,
  matches: SearchMatch[],
  activeIndex: number,
): DecorationSet {
  if (matches.length === 0) return DecorationSet.empty;
  const decorations = matches.map((match, index) =>
    Decoration.inline(match.from, match.to, {
      class:
        index === activeIndex
          ? "nfm-search-match nfm-search-match-active"
          : "nfm-search-match",
    }),
  );
  return DecorationSet.create(doc, decorations);
}

function findMatches(doc: ProsemirrorNode, query: string): SearchMatch[] {
  const normalizedQuery = normalizeQuery(query);
  if (!normalizedQuery) return [];

  const needle = normalizedQuery.toLowerCase();
  const matches: SearchMatch[] = [];

  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;

    const haystack = node.text.toLowerCase();
    let searchFrom = 0;

    while (searchFrom < haystack.length) {
      const index = haystack.indexOf(needle, searchFrom);
      if (index === -1) break;

      const from = pos + index;
      const to = from + needle.length;
      matches.push({ from, to });
      searchFrom = index + Math.max(needle.length, 1);
    }
  });

  return matches;
}

function createSearchPlugin(): Plugin<NfmSearchPluginState> {
  return new Plugin<NfmSearchPluginState>({
    key: nfmSearchPluginKey,
    state: {
      init() {
        return {
          query: "",
          matches: [],
          activeIndex: -1,
          decorations: DecorationSet.empty,
        };
      },
      apply(tr, previousState) {
        const action = tr.getMeta(nfmSearchPluginKey) as NfmSearchAction | undefined;
        const hasAction = !!action;

        if (!tr.docChanged && !hasAction) {
          return previousState;
        }

        const query =
          action?.type === "set-query"
            ? normalizeQuery(action.query)
            : previousState.query;
        const queryChanged = query !== previousState.query;
        const shouldRecomputeMatches = tr.docChanged || queryChanged;

        const matches = shouldRecomputeMatches
          ? findMatches(tr.doc, query)
          : previousState.matches;

        let activeIndex = previousState.activeIndex;

        if (matches.length === 0) {
          activeIndex = -1;
        } else if (queryChanged) {
          activeIndex = -1;
        } else if (action?.type === "next") {
          activeIndex = wrapIndex(activeIndex + 1, matches.length);
        } else if (action?.type === "prev") {
          activeIndex = wrapIndex(activeIndex - 1, matches.length);
        } else {
          activeIndex = Math.min(Math.max(activeIndex, 0), matches.length - 1);
        }

        return {
          query,
          matches,
          activeIndex,
          decorations: buildDecorations(tr.doc, matches, activeIndex),
        };
      },
    },
    props: {
      decorations(state) {
        return nfmSearchPluginKey.getState(state)?.decorations ?? DecorationSet.empty;
      },
    },
  });
}

export const nfmSearchExtension = createExtension(() => ({
  key: "nfm-search",
  prosemirrorPlugins: [createSearchPlugin()],
}));

export function setNfmSearchQuery(editor: EditorWithSearchCommands, query: string): void {
  editor.transact((tr) => {
    tr.setMeta(nfmSearchPluginKey, { type: "set-query", query } satisfies NfmSearchAction);
  });
}

export function goToNextNfmSearchMatch(editor: EditorWithSearchCommands): void {
  editor.transact((tr) => {
    tr.setMeta(nfmSearchPluginKey, { type: "next" } satisfies NfmSearchAction);
  });
}

export function goToPreviousNfmSearchMatch(editor: EditorWithSearchCommands): void {
  editor.transact((tr) => {
    tr.setMeta(nfmSearchPluginKey, { type: "prev" } satisfies NfmSearchAction);
  });
}

export function getNfmSearchState(editor: Pick<EditorWithSearchCommands, "prosemirrorState">): {
  query: string;
  totalMatches: number;
  activeIndex: number;
  activeMatch: SearchMatch | null;
} {
  const state = nfmSearchPluginKey.getState(editor.prosemirrorState);
  if (!state) {
    return {
      query: "",
      totalMatches: 0,
      activeIndex: -1,
      activeMatch: null,
    };
  }

  const activeMatch =
    state.activeIndex >= 0 && state.activeIndex < state.matches.length
      ? state.matches[state.activeIndex]
      : null;

  return {
    query: state.query,
    totalMatches: state.matches.length,
    activeIndex: state.activeIndex,
    activeMatch,
  };
}

function getSearchPluginState(editor: Pick<EditorWithSearchCommands, "prosemirrorState">) {
  return nfmSearchPluginKey.getState(editor.prosemirrorState) ?? null;
}

export function replaceActiveNfmSearchMatch(
  editor: EditorWithSearchCommands,
  replacement: string,
): boolean {
  const state = getSearchPluginState(editor);
  if (!state) return false;
  if (state.activeIndex < 0 || state.activeIndex >= state.matches.length) return false;

  const active = state.matches[state.activeIndex];
  editor.transact((tr) => {
    tr.insertText(replacement, active.from, active.to);
    tr.setMeta(
      nfmSearchPluginKey,
      { type: "set-query", query: state.query } satisfies NfmSearchAction,
    );
  });
  return true;
}

export function replaceAllNfmSearchMatches(
  editor: EditorWithSearchCommands,
  replacement: string,
): number {
  const state = getSearchPluginState(editor);
  if (!state) return 0;
  if (!state.query || state.matches.length === 0) return 0;

  editor.transact((tr) => {
    for (let i = state.matches.length - 1; i >= 0; i -= 1) {
      const match = state.matches[i];
      tr.insertText(replacement, match.from, match.to);
    }
    tr.setMeta(
      nfmSearchPluginKey,
      { type: "set-query", query: state.query } satisfies NfmSearchAction,
    );
  });

  return state.matches.length;
}

export { escapeAttributeValue };

function findBlockElement(editorDom: ParentNode | undefined, blockId: string): HTMLElement | null {
  return findBlockElementById(editorDom, blockId);
}

function isCollapsedToggleBlock(blockEl: HTMLElement | null): boolean {
  if (!blockEl) return false;
  const outer = blockEl.closest<HTMLElement>(".bn-block-outer");
  if (!outer) return false;
  const wrapper = outer.querySelector<HTMLElement>(".bn-toggle-wrapper");
  return wrapper?.getAttribute("data-show-children") === "false";
}

export function getCollapsedToggleAncestorIds(
  editorDom: ParentNode | undefined,
  blockId: string,
  getParentBlock: (id: string) => BlockRef | undefined,
): string[] {
  const collapsedAncestorIds: string[] = [];
  let currentParent = getParentBlock(blockId);

  while (currentParent) {
    const parentEl = findBlockElement(editorDom, currentParent.id);
    if (isCollapsedToggleBlock(parentEl)) {
      collapsedAncestorIds.push(currentParent.id);
    }
    currentParent = getParentBlock(currentParent.id);
  }

  return collapsedAncestorIds.reverse();
}

function expandCollapsedToggle(editorDom: ParentNode | undefined, blockId: string): void {
  const blockEl = findBlockElement(editorDom, blockId);
  if (!isCollapsedToggleBlock(blockEl)) return;
  const toggleButton = blockEl?.querySelector<HTMLButtonElement>(".bn-toggle-button");
  toggleButton?.click();
}

function getBlockIdAtPosition(
  editor: EditorWithSearchNavigation,
  position: number,
): string | null {
  try {
    const { node } = editor.prosemirrorView.domAtPos(Math.max(position, 0));
    const el = node instanceof Element ? node : node.parentElement;
    return el?.closest<HTMLElement>(".bn-block[data-id]")?.getAttribute("data-id") ?? null;
  } catch {
    return null;
  }
}

export function revealActiveNfmSearchMatch(editor: EditorWithSearchNavigation): boolean {
  const { activeMatch } = getNfmSearchState(editor);
  if (!activeMatch) return false;

  const blockId = getBlockIdAtPosition(editor, activeMatch.from);
  if (blockId) {
    const collapsedAncestors = getCollapsedToggleAncestorIds(
      editor.domElement,
      blockId,
      (id) => editor.getParentBlock(id),
    );
    for (const ancestorId of collapsedAncestors) {
      expandCollapsedToggle(editor.domElement, ancestorId);
    }
  }

  editor.transact((tr) => {
    tr.setSelection(TextSelection.create(tr.doc, activeMatch.from, activeMatch.to));
    tr.scrollIntoView();
  });

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const activeEl = editor.prosemirrorView.dom.querySelector<HTMLElement>(
        ".nfm-search-match-active",
      );
      activeEl?.scrollIntoView({
        block: "center",
        inline: "nearest",
        behavior: "smooth",
      });
    });
  });

  return true;
}
