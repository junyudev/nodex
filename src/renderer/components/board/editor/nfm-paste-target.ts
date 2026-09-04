import { createExtension, getNodeById } from "@blocknote/core";
import {
  Plugin,
  PluginKey,
  type EditorState,
  type SelectionBookmark,
  type Transaction,
} from "@tiptap/pm/state";

export interface NfmPasteTarget {
  /** Consume and restore the mapped original selection, or refuse stale/duplicate work. */
  restore(): boolean;
  release(): void;
}

interface PasteTargetView {
  readonly editable?: boolean;
  readonly state: EditorState;
  readonly isDestroyed: boolean;
  dispatch(transaction: Transaction): void;
}
interface Entry {
  readonly bookmark: SelectionBookmark;
  readonly blockIds: readonly string[];
}
type Action =
  | { readonly kind: "capture"; readonly token: object; readonly entry: Entry }
  | { readonly kind: "release"; readonly token: object }
  | { readonly kind: "clear" };
const key = new PluginKey<ReadonlyMap<object, Entry>>("nfm-paste-target");

export const createNfmPasteTargetPlugin = () =>
  new Plugin<ReadonlyMap<object, Entry>>({
    key,
    state: {
      init: () => new Map(),
      apply: (transaction, previous) => {
        const action = transaction.getMeta(key) as Action | undefined;
        if (action?.kind === "clear") return new Map();
        if (!action && !transaction.docChanged) return previous;
        const next = new Map<object, Entry>();
        for (const [token, entry] of previous) {
          if (action?.kind === "release" && action.token === token) continue;
          if (entry.blockIds.some((id) => !getNodeById(id, transaction.doc))) continue;
          next.set(token, { ...entry, bookmark: entry.bookmark.map(transaction.mapping) });
        }
        if (action?.kind === "capture") next.set(action.token, action.entry);
        return next;
      },
    },
  });

export const nfmPasteTargetExtension = createExtension(() => ({
  key: "nfm-paste-target",
  prosemirrorPlugins: [createNfmPasteTargetPlugin()],
}));

const dispatch = (view: PasteTargetView, action: Action) => {
  if (view.isDestroyed) return;
  view.dispatch(view.state.tr.setMeta(key, action).setMeta("addToHistory", false));
};

/** Bookmarks live only in this editor view, never in clipboard data or document history. */
export const captureNfmPasteTarget = (view: PasteTargetView | undefined): NfmPasteTarget => {
  if (!view || view.isDestroyed) return { restore: () => false, release: () => undefined };
  const token = {};
  const { selection, doc } = view.state;
  const blockIds = new Set<string>();
  doc.nodesBetween(selection.from, selection.to, (node) => {
    if (node.type.name === "blockContainer" && typeof node.attrs.id === "string") {
      blockIds.add(node.attrs.id);
    }
  });
  dispatch(view, {
    kind: "capture",
    token,
    entry: { bookmark: selection.getBookmark(), blockIds: [...blockIds] },
  });
  return {
    restore: () => {
      if (view.isDestroyed || view.editable === false) return false;
      const entry = key.getState(view.state)?.get(token);
      if (!entry) return false;
      view.dispatch(
        view.state.tr
          .setSelection(entry.bookmark.resolve(view.state.doc))
          .setMeta(key, { kind: "release", token } satisfies Action)
          .setMeta("addToHistory", false),
      );
      return true;
    },
    release: () => dispatch(view, { kind: "release", token }),
  };
};

/** Retained editors also invalidate pending work when their visible Page/view closes. */
export const clearNfmPasteTargets = (view: PasteTargetView | undefined): void => {
  if (view) dispatch(view, { kind: "clear" });
};
