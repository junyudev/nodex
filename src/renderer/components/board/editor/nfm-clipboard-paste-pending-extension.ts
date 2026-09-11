import { createExtension, getBlockInfo, getNodeById } from "@blocknote/core";
import type { Node as ProsemirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export interface NfmPendingRemoval {
  readonly operationId: string;
  readonly rootBlockIds: readonly string[];
  readonly action: "cut" | "move";
}

interface PendingPasteState {
  readonly removals: readonly NfmPendingRemoval[];
  readonly listeners: ReadonlySet<() => void>;
  readonly blockIds: ReadonlySet<string>;
  readonly decorations: DecorationSet;
}

interface PendingPasteAction {
  readonly kind: "paste";
  readonly blockId: string;
  readonly pending: boolean;
}

interface PendingPasteEditor {
  readonly prosemirrorState: EditorState;
  transact<T>(callback: (transaction: Transaction) => T): T;
}

export const nfmClipboardPastePendingPluginKey = new PluginKey<PendingPasteState>(
  "nfm-clipboard-paste-pending",
);

const indicatorPosition = (document: ProsemirrorNode, blockId: string): number | null => {
  const position = getNodeById(blockId, document);
  if (!position) return null;
  const block = getBlockInfo(position);
  return block.isBlockContainer ? block.blockContent.afterPos - 1 : null;
};

const createIndicator = (blockId: string): HTMLElement => {
  const indicator = document.createElement("span");
  indicator.dataset.nfmClipboardPastePending = blockId;
  indicator.setAttribute("contenteditable", "false");
  indicator.setAttribute("role", "status");
  indicator.setAttribute("aria-label", "Pasting");
  indicator.className = [
    "inline-flex",
    "h-6",
    "items-center",
    "gap-1.5",
    "rounded-md",
    "ring-[0.5px]",
    "ring-inset",
    "ring-token-border-default",
    "bg-token-background-primary",
    "px-2",
    "text-xs",
    "text-token-text-secondary",
  ].join(" ");

  const activity = document.createElement("span");
  activity.className = "size-1.5 animate-pulse rounded-full bg-token-text-secondary";
  activity.setAttribute("aria-hidden", "true");
  indicator.append(activity, "Pasting…");
  return indicator;
};

const buildDecorations = (
  document: ProsemirrorNode,
  blockIds: ReadonlySet<string>,
  removals: readonly NfmPendingRemoval[],
  listeners: ReadonlySet<() => void>,
): PendingPasteState => {
  const retained = new Set<string>();
  const decorations: Decoration[] = [];
  for (const blockId of blockIds) {
    const position = indicatorPosition(document, blockId);
    if (position === null) continue;
    retained.add(blockId);
    decorations.push(
      Decoration.widget(position, () => createIndicator(blockId), {
        key: `clipboard-paste:${blockId}`,
        side: -1,
      }),
    );
  }
  for (const removal of removals) {
    for (const blockId of removal.rootBlockIds) {
      const position = getNodeById(blockId, document);
      if (!position) continue;
      const { bnBlock } = getBlockInfo(position);
      decorations.push(
        Decoration.node(
          bnBlock.beforePos,
          bnBlock.afterPos,
          {
            class: "bg-token-background-secondary/60 opacity-60",
            "data-nfm-pending-removal": removal.operationId,
            "aria-description": removal.action === "cut" ? "Cutting" : "Moving",
          },
          { operationId: removal.operationId },
        ),
      );
    }
  }
  return {
    blockIds: retained,
    removals,
    listeners,
    decorations: DecorationSet.create(document, decorations),
  };
};

const createPendingPastePlugin = (): Plugin<PendingPasteState> =>
  new Plugin<PendingPasteState>({
    key: nfmClipboardPastePendingPluginKey,
    state: {
      init: () => ({
        blockIds: new Set(),
        removals: [],
        listeners: new Set(),
        decorations: DecorationSet.empty,
      }),
      apply: (transaction, previous) => {
        const action = transaction.getMeta(nfmClipboardPastePendingPluginKey) as
          | PendingPasteAction
          | { readonly kind: "removals"; readonly removals: readonly NfmPendingRemoval[] }
          | { readonly kind: "subscribe"; readonly listener: () => void; readonly add: boolean }
          | undefined;
        if (!action && !transaction.docChanged) return previous;
        const blockIds = new Set(previous.blockIds);
        if (action?.kind === "paste") {
          if (action.pending) blockIds.add(action.blockId);
          else blockIds.delete(action.blockId);
        }
        const listeners = new Set(previous.listeners);
        if (action?.kind === "subscribe") {
          if (action.add) listeners.add(action.listener);
          else listeners.delete(action.listener);
        }
        return buildDecorations(
          transaction.doc,
          blockIds,
          action?.kind === "removals" ? action.removals : previous.removals,
          listeners,
        );
      },
    },
    view: () => ({
      update: (view) => {
        for (const listener of nfmClipboardPastePendingPluginKey.getState(view.state)?.listeners ??
          [])
          listener();
      },
    }),
    props: {
      decorations: (state) =>
        nfmClipboardPastePendingPluginKey.getState(state)?.decorations ?? DecorationSet.empty,
    },
  });

export const nfmClipboardPastePendingExtension = createExtension(() => ({
  key: "nfm-clipboard-paste-pending",
  prosemirrorPlugins: [createPendingPastePlugin()],
}));

export const setNfmClipboardPastePending = (
  editor: PendingPasteEditor,
  blockId: string,
  pending: boolean,
): void => {
  editor.transact((transaction) => {
    transaction.setMeta(nfmClipboardPastePendingPluginKey, {
      kind: "paste",
      blockId,
      pending,
    } satisfies PendingPasteAction);
  });
};

/** Metadata-only state: these marks never enter the collaborative Document. */
export const setNfmPendingRemovals = (
  editor: PendingPasteEditor,
  removals: readonly NfmPendingRemoval[],
): void => {
  const previous = nfmClipboardPastePendingPluginKey.getState(editor.prosemirrorState);
  if (
    !previous ||
    (previous.removals.length === removals.length &&
      previous.removals.every((entry, index) => entry === removals[index]))
  )
    return;
  editor.transact((transaction) => {
    transaction.setMeta(nfmClipboardPastePendingPluginKey, { kind: "removals", removals });
  });
};

export const subscribeNfmStructuralView = (
  editor: PendingPasteEditor,
  listener: () => void,
): (() => void) => {
  const set = (add: boolean) =>
    editor.transact((transaction) => {
      transaction.setMeta(nfmClipboardPastePendingPluginKey, { kind: "subscribe", listener, add });
    });
  set(true);
  return () => set(false);
};
