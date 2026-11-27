import { createExtension } from "@blocknote/core";
import type { Node as ProsemirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

/**
 * How Discussion marks look right now. Resolved Discussions keep their marks in the document but
 * are not listed in `visible`, so their text reads as ordinary text.
 */
export interface NfmDiscussionMarksPresentation {
  readonly visible: ReadonlySet<string>;
  readonly activeId: string | null;
  /** A selection being commented on before its Discussion exists. */
  readonly draft: { readonly from: number; readonly to: number } | null;
  /** Blocks with an open Suggested edit, tinted so readers know a change is proposed. */
  readonly suggestedBlockIds: ReadonlySet<string>;
  /**
   * The person is suggesting rather than editing and has not started a suggestion yet: local
   * edits are held, and the first attempt to edit asks the owner to start a suggestion session.
   */
  readonly writeLocked: boolean;
}

/** Dispatched on the editor's DOM when a person starts editing a write-locked Page. */
export const NFM_SUGGEST_START_EVENT = "nfm-suggest-start";

/** Lets an owner's own document change through while the Page is write-locked. */
export const NFM_DISCUSSION_ALLOWED_META = "nfmDiscussionAllowed";

/** Dispatched on the editor's DOM when a person clicks text that belongs to a Discussion. */
export const NFM_DISCUSSION_ACTIVATE_EVENT = "nfm-discussion-activate";

export interface NfmDiscussionActivateDetail {
  readonly discussionId: string;
}

const COMMENT_MARK = "comment";

export const EMPTY_DISCUSSION_MARKS_PRESENTATION: NfmDiscussionMarksPresentation = {
  visible: new Set(),
  activeId: null,
  draft: null,
  suggestedBlockIds: new Set(),
  writeLocked: false,
};
const EMPTY_PRESENTATION = EMPTY_DISCUSSION_MARKS_PRESENTATION;

interface DiscussionMarksState {
  readonly presentation: NfmDiscussionMarksPresentation;
  readonly decorations: DecorationSet;
}

export const nfmDiscussionMarksPluginKey = new PluginKey<DiscussionMarksState>(
  "nfm-discussion-marks",
);

/** The Discussion ids marked at one text position, innermost first. */
export function discussionIdsAt(state: EditorState, position: number): readonly string[] {
  const markType = state.schema.marks[COMMENT_MARK];
  if (!markType) return [];
  return state.doc
    .resolve(position)
    .marks()
    .filter((mark) => mark.type === markType)
    .map((mark) => String(mark.attrs.threadId ?? ""))
    .filter(Boolean)
    .reverse();
}

function buildDecorations(
  doc: ProsemirrorNode,
  presentation: NfmDiscussionMarksPresentation,
): DecorationSet {
  const markType = doc.type.schema.marks[COMMENT_MARK];
  const decorations: Decoration[] = [];
  if (markType && presentation.visible.size > 0) {
    doc.descendants((node, position) => {
      if (!node.isText) return true;
      for (const mark of node.marks) {
        if (mark.type !== markType) continue;
        const id = String(mark.attrs.threadId ?? "");
        if (!presentation.visible.has(id)) continue;
        decorations.push(
          Decoration.inline(position, position + node.nodeSize, {
            class:
              id === presentation.activeId
                ? "nfm-discussion-mark is-active"
                : "nfm-discussion-mark",
            "data-discussion-mark": id,
          }),
        );
      }
      return false;
    });
  }
  if (presentation.suggestedBlockIds.size > 0) {
    doc.descendants((node, position) => {
      if (node.type.name !== "blockContainer") return true;
      if (presentation.suggestedBlockIds.has(String(node.attrs.id ?? ""))) {
        decorations.push(
          Decoration.node(position, position + node.nodeSize, { class: "nfm-suggested-block" }),
        );
      }
      return true;
    });
  }
  const draft = presentation.draft;
  if (draft && draft.from < draft.to && draft.to <= doc.content.size) {
    decorations.push(
      Decoration.inline(draft.from, draft.to, { class: "nfm-discussion-mark is-active is-draft" }),
    );
  }
  return DecorationSet.create(doc, decorations);
}

function isWriteLocked(state: EditorState): boolean {
  return nfmDiscussionMarksPluginKey.getState(state)?.presentation.writeLocked ?? false;
}

/**
 * Asks the owner to start a suggestion session before this edit applies. The owner forks the
 * document synchronously and lifts the lock, so the keystroke lands in the fork.
 */
function requestSuggestionStart(dom: HTMLElement): void {
  dom.dispatchEvent(new CustomEvent(NFM_SUGGEST_START_EVENT, { bubbles: true }));
}

/** Replaces the mark presentation; the owner calls it when Discussions or focus change. */
export function setNfmDiscussionMarksPresentation(
  editor: { transact: <T>(callback: (transaction: Transaction) => T) => T },
  presentation: NfmDiscussionMarksPresentation,
): void {
  editor.transact((transaction) =>
    transaction.setMeta(nfmDiscussionMarksPluginKey, presentation).setMeta("addToHistory", false),
  );
}

/**
 * Highlights text that belongs to open Discussions, emphasizes the active one, and reports clicks
 * on marked text. Marks themselves are document content; this extension only decorates them.
 */
export const nfmDiscussionMarksExtension = createExtension(({ editor }) => ({
  key: "nfm-discussion-marks",
  prosemirrorPlugins: [createDiscussionMarksPlugin()],
  keyboardShortcuts: {
    // ⌥⌘M comments on the selection, where the Page has Discussions.
    "Mod-Alt-m": () => {
      const view = editor.prosemirrorView;
      if (!view || view.state.selection.empty) return false;
      view.dom.dispatchEvent(
        new CustomEvent(NFM_DISCUSSION_COMMENT_EVENT, { bubbles: true, cancelable: true }),
      );
      return true;
    },
  },
}));

/** Dispatched on the editor's DOM when a person asks to comment on the selection. */
export const NFM_DISCUSSION_COMMENT_EVENT = "nfm-discussion-comment";

function createDiscussionMarksPlugin(): Plugin<DiscussionMarksState> {
  return new Plugin<DiscussionMarksState>({
    key: nfmDiscussionMarksPluginKey,
    state: {
      init: (_config, state) => ({
        presentation: EMPTY_PRESENTATION,
        decorations: buildDecorations(state.doc, EMPTY_PRESENTATION),
      }),
      apply(transaction, previous, _oldState, newState) {
        const next = transaction.getMeta(nfmDiscussionMarksPluginKey) as
          | NfmDiscussionMarksPresentation
          | undefined;
        if (next) return { presentation: next, decorations: buildDecorations(newState.doc, next) };
        if (!transaction.docChanged) return previous;
        const draft = previous.presentation.draft;
        const presentation = draft
          ? {
              ...previous.presentation,
              draft: {
                from: transaction.mapping.map(draft.from, 1),
                to: transaction.mapping.map(draft.to, -1),
              },
            }
          : previous.presentation;
        return { presentation, decorations: buildDecorations(newState.doc, presentation) };
      },
    },
    // Remote collaborators' changes always apply; only this person's edits are held.
    filterTransaction(transaction, state) {
      if (!transaction.docChanged) return true;
      if (!nfmDiscussionMarksPluginKey.getState(state)?.presentation.writeLocked) return true;
      if (transaction.getMeta(NFM_DISCUSSION_ALLOWED_META)) return true;
      const sync = transaction.getMeta("y-sync$") as { isChangeOrigin?: boolean } | undefined;
      return Boolean(sync?.isChangeOrigin);
    },
    props: {
      handleKeyDown(view, event) {
        if (!isWriteLocked(view.state)) return false;
        if (event.metaKey || event.ctrlKey || event.altKey) return false;
        const edits =
          event.key.length === 1 || ["Backspace", "Delete", "Enter", "Tab"].includes(event.key);
        if (edits) requestSuggestionStart(view.dom);
        return false;
      },
      handlePaste(view) {
        if (isWriteLocked(view.state)) requestSuggestionStart(view.dom);
        return false;
      },
      handleDrop(view) {
        if (isWriteLocked(view.state)) requestSuggestionStart(view.dom);
        return false;
      },
      decorations(state) {
        return nfmDiscussionMarksPluginKey.getState(state)?.decorations ?? DecorationSet.empty;
      },
      handleClick(view, position) {
        const visible = nfmDiscussionMarksPluginKey.getState(view.state)?.presentation.visible;
        const discussionId = discussionIdsAt(view.state, position).find((id) => visible?.has(id));
        if (!discussionId) return false;
        view.dom.dispatchEvent(
          new CustomEvent<NfmDiscussionActivateDetail>(NFM_DISCUSSION_ACTIVATE_EVENT, {
            bubbles: true,
            detail: { discussionId },
          }),
        );
        // Placing the caret still happens; activation only opens the Discussion beside it.
        return false;
      },
    },
  });
}
