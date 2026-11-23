import { findLiteralRanges } from "@/lib/page-chat-search";
import { createExtension } from "@blocknote/core";
import type { Node as ProsemirrorNode } from "@tiptap/pm/model";
import {
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
  type Transaction,
} from "@tiptap/pm/state";
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
  | { type: "set-query"; query: string; blockId?: string }
  | { type: "activate"; index: number };

interface BlockRef {
  id: string;
}

interface EditorWithSearchNavigation {
  domElement?: ParentNode;
  prosemirrorView?: EditorView;
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
        index === activeIndex ? "nfm-search-match nfm-search-match-active" : "nfm-search-match",
    }),
  );
  return DecorationSet.create(doc, decorations);
}

export function findNfmSearchMatches(doc: ProsemirrorNode, query: string): SearchMatch[] {
  const needle = normalizeQuery(query);
  if (!needle) return [];

  const matches: SearchMatch[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return;

    let text = "";
    let start = pos + 1;
    const flush = () => {
      for (const range of findLiteralRanges(needle, text)) {
        matches.push({ from: start + range.start, to: start + range.end });
      }
      text = "";
    };
    node.forEach((child, offset) => {
      if (child.isText) {
        if (!text) start = pos + 1 + offset;
        text += child.text ?? "";
      } else {
        // Inline atoms and hard breaks separate text runs, as do textblock boundaries.
        flush();
      }
    });
    flush();
    return false;
  });
  return matches;
}

function getBlockIdAtPosition(doc: ProsemirrorNode, position: number): string | null {
  const resolved = doc.resolve(position);
  for (let depth = resolved.depth; depth > 0; depth -= 1) {
    const node = resolved.node(depth);
    if (node.type.name === "blockContainer" && typeof node.attrs.id === "string") {
      return node.attrs.id;
    }
  }
  return null;
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
          action?.type === "set-query" ? normalizeQuery(action.query) : previousState.query;
        const queryChanged = query !== previousState.query;
        const shouldRecomputeMatches = tr.docChanged || queryChanged;

        const matches = shouldRecomputeMatches
          ? findNfmSearchMatches(tr.doc, query)
          : previousState.matches;

        let activeIndex = previousState.activeIndex;
        const previousActive = previousState.matches[previousState.activeIndex];

        if (matches.length === 0) {
          activeIndex = -1;
        } else if (action?.type === "set-query" && action.blockId) {
          const blockId = action.blockId;
          activeIndex = matches.findIndex(
            (match) => getBlockIdAtPosition(tr.doc, match.from) === blockId,
          );
        } else if (action?.type === "activate") {
          activeIndex = wrapIndex(action.index, matches.length);
        } else if (queryChanged) {
          activeIndex = -1;
        } else if (tr.docChanged && previousActive) {
          // Edits keep the same occurrence active instead of whichever one now holds its index.
          const anchor = tr.mapping.map(previousActive.from);
          const following = matches.findIndex((match) => match.to > anchor);
          activeIndex = following >= 0 ? following : matches.length - 1;
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

export function setNfmSearchQuery(
  editor: EditorWithSearchCommands,
  query: string,
  blockId?: string,
): void {
  editor.transact((tr) => {
    tr.setMeta(nfmSearchPluginKey, { type: "set-query", query, blockId } satisfies NfmSearchAction);
  });
}

export function activateNfmSearchMatch(editor: EditorWithSearchCommands, index: number): void {
  editor.transact((tr) => {
    tr.setMeta(nfmSearchPluginKey, { type: "activate", index } satisfies NfmSearchAction);
  });
}

export function readNfmSearchMatches(editor: Pick<EditorWithSearchCommands, "prosemirrorState">) {
  return nfmSearchPluginKey.getState(editor.prosemirrorState)?.matches ?? [];
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
    tr.setMeta(nfmSearchPluginKey, {
      type: "set-query",
      query: state.query,
    } satisfies NfmSearchAction);
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
    tr.setMeta(nfmSearchPluginKey, {
      type: "set-query",
      query: state.query,
    } satisfies NfmSearchAction);
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

export function expandNfmSearchAncestors(
  editor: EditorWithSearchNavigation,
  blockId: string,
): void {
  const collapsedAncestors = getCollapsedToggleAncestorIds(editor.domElement, blockId, (id) =>
    editor.getParentBlock(id),
  );
  for (const ancestorId of collapsedAncestors) {
    expandCollapsedToggle(editor.domElement, ancestorId);
  }
}

/** An edited or non-text hit can still land on its original Block. */
export function revealNfmSearchBlock(
  editor: EditorWithSearchNavigation,
  blockId: string,
  onScroll?: () => void,
): void {
  expandNfmSearchAncestors(editor, blockId);
  requestAnimationFrame(() => {
    const block = findBlockElement(editor.domElement, blockId);
    if (!block?.isConnected) return;
    block.scrollIntoView({ block: "center", behavior: "instant" });
    onScroll?.();
  });
}

/** Leaving Find hands the active match to the editor as its selection. */
export function selectActiveNfmSearchMatch(
  editor: EditorWithSearchCommands & { focus: () => void },
): void {
  const { activeMatch } = getNfmSearchState(editor);
  if (activeMatch) {
    editor.transact((tr) => {
      tr.setSelection(TextSelection.create(tr.doc, activeMatch.from, activeMatch.to));
    });
  }
  editor.focus();
}

export function revealActiveNfmSearchMatch(
  editor: EditorWithSearchNavigation,
  onScroll?: () => void,
): boolean {
  const { activeMatch } = getNfmSearchState(editor);
  if (!activeMatch) return false;
  if (!editor.prosemirrorView) return false;

  const blockId = getBlockIdAtPosition(editor.prosemirrorState.doc, activeMatch.from);
  if (blockId) expandNfmSearchAncestors(editor, blockId);

  // Find only highlights and scrolls; the caret stays wherever the person left it.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const currentMatch = getNfmSearchState(editor).activeMatch;
      if (currentMatch?.from !== activeMatch.from || currentMatch.to !== activeMatch.to) return;
      const activeEl = editor.prosemirrorView?.dom.querySelector<HTMLElement>(
        ".nfm-search-match-active",
      );
      if (!activeEl?.isConnected) return;
      activeEl.scrollIntoView({
        block: "center",
        inline: "nearest",
        behavior: onScroll ? "instant" : "smooth",
      });
      onScroll?.();
    });
  });

  return true;
}
