import { createExtension, getBlockInfo, getNodeById } from "@blocknote/core";
import type { Node as ProsemirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export interface NfmPendingRemoval {
  readonly operationId: string;
  readonly rootBlockIds: readonly string[];
  readonly action: "cut" | "move";
}

export interface NfmIncomingPageTransfer {
  readonly operationId: string;
  readonly pages: readonly {
    readonly pageId: string;
    readonly title: string;
  }[];
  readonly target: {
    readonly parentBlockId: string | null;
    readonly beforeBlockId: string | null;
  };
}

interface PendingPasteState {
  readonly removals: readonly NfmPendingRemoval[];
  readonly incomingPages: readonly NfmIncomingPageTransfer[];
  readonly listeners: ReadonlySet<() => void>;
  readonly blockIds: ReadonlySet<string>;
  readonly decorations: DecorationSet;
}

interface PendingPasteAction {
  readonly kind: "paste";
  readonly blockId: string;
  readonly pending: boolean;
}

type PendingPresentationAction =
  | PendingPasteAction
  | { readonly kind: "removals"; readonly removals: readonly NfmPendingRemoval[] }
  | {
      readonly kind: "incoming_pages";
      readonly incomingPages: readonly NfmIncomingPageTransfer[];
    }
  | { readonly kind: "subscribe"; readonly listener: () => void; readonly add: boolean };

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

const incomingPagePosition = (
  document: ProsemirrorNode,
  target: NfmIncomingPageTransfer["target"],
): number => {
  if (target.beforeBlockId) {
    const before = getNodeById(target.beforeBlockId, document);
    if (before) return getBlockInfo(before).bnBlock.beforePos;
  }
  if (target.parentBlockId) {
    const parent = getNodeById(target.parentBlockId, document);
    if (parent) return Math.max(getBlockInfo(parent).bnBlock.afterPos - 1, 0);
  }
  return document.content.size;
};

const createIncomingPages = (transfer: NfmIncomingPageTransfer): HTMLElement => {
  const host = document.createElement("div");
  host.dataset.nfmPredictedPageTransfer = transfer.operationId;
  host.setAttribute("contenteditable", "false");
  host.className = "w-full min-w-0";
  for (const page of transfer.pages) {
    const row = document.createElement("section");
    row.dataset.pageOutlinerTarget = page.pageId;
    row.dataset.nfmPredictedPage = page.pageId;
    row.className = "relative w-full min-w-0 self-stretch";

    const disclosure = document.createElement("div");
    disclosure.className =
      "bn-toggle-wrapper group/page-outliner grid min-h-8 w-full min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-y-1 pt-1";
    const caret = document.createElement("span");
    caret.setAttribute("aria-hidden", "true");
    caret.className = "bn-toggle-button ms-0.5 shrink-0 cursor-default opacity-35";
    const title = document.createElement("div");
    title.className =
      "col-start-2 row-start-1 flex min-h-6 min-w-0 items-start gap-1 pe-0.5 text-[1em] leading-6 text-token-text-primary";
    const text = document.createElement("div");
    text.className = "min-w-0 flex-1 truncate";
    text.textContent = page.title || "Untitled";
    title.append(text);
    disclosure.append(caret, title);
    row.append(disclosure);
    host.append(row);
  }
  return host;
};

const buildDecorations = (
  document: ProsemirrorNode,
  blockIds: ReadonlySet<string>,
  removals: readonly NfmPendingRemoval[],
  incomingPages: readonly NfmIncomingPageTransfer[],
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
          removal.action === "move"
            ? {
                class: "hidden",
                "data-nfm-predicted-removal": removal.operationId,
                "aria-hidden": "true",
              }
            : {
                class: "bg-token-background-secondary/60 opacity-60",
                "data-nfm-pending-removal": removal.operationId,
                "aria-description": "Cutting",
              },
          { operationId: removal.operationId },
        ),
      );
    }
  }
  for (const transfer of incomingPages) {
    decorations.push(
      Decoration.widget(
        incomingPagePosition(document, transfer.target),
        () => createIncomingPages(transfer),
        {
          key: `incoming-pages:${transfer.operationId}`,
          side: -1,
        },
      ),
    );
  }
  return {
    blockIds: retained,
    removals,
    incomingPages,
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
        incomingPages: [],
        listeners: new Set(),
        decorations: DecorationSet.empty,
      }),
      apply: (transaction, previous) => {
        const action = transaction.getMeta(nfmClipboardPastePendingPluginKey) as
          | PendingPresentationAction
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
          action?.kind === "incoming_pages" ? action.incomingPages : previous.incomingPages,
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

export const setNfmIncomingPageTransfers = (
  editor: PendingPasteEditor,
  incomingPages: readonly NfmIncomingPageTransfer[],
): void => {
  const previous = nfmClipboardPastePendingPluginKey.getState(editor.prosemirrorState);
  if (
    !previous ||
    (previous.incomingPages.length === incomingPages.length &&
      previous.incomingPages.every((entry, index) => entry === incomingPages[index]))
  )
    return;
  editor.transact((transaction) => {
    transaction.setMeta(nfmClipboardPastePendingPluginKey, {
      kind: "incoming_pages",
      incomingPages,
    } satisfies PendingPresentationAction);
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
