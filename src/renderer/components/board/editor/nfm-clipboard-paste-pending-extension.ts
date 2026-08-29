import { createExtension, getBlockInfo, getNodeById } from "@blocknote/core";
import type { Node as ProsemirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

interface PendingPasteState {
  readonly blockIds: ReadonlySet<string>;
  readonly decorations: DecorationSet;
}

interface PendingPasteAction {
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
  return { blockIds: retained, decorations: DecorationSet.create(document, decorations) };
};

const createPendingPastePlugin = (): Plugin<PendingPasteState> =>
  new Plugin<PendingPasteState>({
    key: nfmClipboardPastePendingPluginKey,
    state: {
      init: () => ({ blockIds: new Set(), decorations: DecorationSet.empty }),
      apply: (transaction, previous) => {
        const action = transaction.getMeta(nfmClipboardPastePendingPluginKey) as
          | PendingPasteAction
          | undefined;
        if (!action && !transaction.docChanged) return previous;
        const blockIds = new Set(previous.blockIds);
        if (action?.pending) blockIds.add(action.blockId);
        else if (action) blockIds.delete(action.blockId);
        return buildDecorations(transaction.doc, blockIds);
      },
    },
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
      blockId,
      pending,
    } satisfies PendingPasteAction);
  });
};
