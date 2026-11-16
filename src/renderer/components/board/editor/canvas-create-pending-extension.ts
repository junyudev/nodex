import { getIntl } from "@/lib/i18n";
import { createExtension, getBlockInfo, getNodeById } from "@blocknote/core";
import type { Node as ProsemirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

interface CanvasCreatePendingState {
  readonly blockIds: ReadonlySet<string>;
  readonly decorations: DecorationSet;
}

interface CanvasCreatePendingAction {
  readonly blockId: string;
  readonly pending: boolean;
}

interface EditorWithCanvasCreatePending {
  readonly prosemirrorState: EditorState;
  transact: <T>(callback: (transaction: Transaction) => T) => T;
}

export const canvasCreatePendingPluginKey = new PluginKey<CanvasCreatePendingState>(
  "canvas-create-pending",
);

function pendingParagraphPosition(document: ProsemirrorNode, blockId: string): number | null {
  const position = getNodeById(blockId, document);
  if (!position) return null;
  const block = getBlockInfo(position);
  if (!block.isBlockContainer) return null;
  if (block.blockContent.node.type.name !== "paragraph") return null;
  return block.blockContent.afterPos - 1;
}

function createPendingIndicator(blockId: string): HTMLElement {
  const indicator = document.createElement("span");
  indicator.dataset.canvasCreatePending = blockId;
  indicator.setAttribute("contenteditable", "false");
  indicator.setAttribute("role", "status");
  indicator.setAttribute(
    "aria-label",
    getIntl().formatMessage({
      id: "editor.canvasCreatePendingExtension.creating",
      defaultMessage: "Creating Canvas",
    }),
  );
  indicator.className = [
    "inline-flex",
    "min-h-6",
    "items-center",
    "gap-2",
    "rounded-md",
    "border",
    "border-token-border-default",
    "bg-token-foreground/3",
    "px-2.5",
    "text-sm",
    "text-token-text-secondary",
  ].join(" ");

  const activity = document.createElement("span");
  activity.className = "size-1.5 rounded-full bg-token-text-secondary";
  activity.setAttribute("aria-hidden", "true");
  indicator.append(
    activity,
    getIntl().formatMessage({
      id: "editor.canvasCreatePendingExtension.creatingText",
      defaultMessage: "Creating Canvas…",
    }),
  );
  return indicator;
}

function buildPendingDecorations(
  document: ProsemirrorNode,
  blockIds: ReadonlySet<string>,
): {
  readonly blockIds: ReadonlySet<string>;
  readonly decorations: DecorationSet;
} {
  const retainedBlockIds = new Set<string>();
  const decorations: Decoration[] = [];
  for (const blockId of blockIds) {
    const position = pendingParagraphPosition(document, blockId);
    if (position === null) continue;
    retainedBlockIds.add(blockId);
    decorations.push(
      Decoration.widget(position, () => createPendingIndicator(blockId), {
        key: `canvas-create:${blockId}`,
        side: -1,
      }),
    );
  }
  return {
    blockIds: retainedBlockIds,
    decorations: DecorationSet.create(document, decorations),
  };
}

function createCanvasCreatePendingPlugin(): Plugin<CanvasCreatePendingState> {
  return new Plugin<CanvasCreatePendingState>({
    key: canvasCreatePendingPluginKey,
    state: {
      init: () => ({
        blockIds: new Set(),
        decorations: DecorationSet.empty,
      }),
      apply: (transaction, previousState) => {
        const action = transaction.getMeta(canvasCreatePendingPluginKey) as
          | CanvasCreatePendingAction
          | undefined;
        if (!action && !transaction.docChanged) return previousState;

        const blockIds = new Set(previousState.blockIds);
        if (action?.pending) {
          blockIds.add(action.blockId);
        } else if (action) {
          blockIds.delete(action.blockId);
        }
        return buildPendingDecorations(transaction.doc, blockIds);
      },
    },
    props: {
      decorations: (state) =>
        canvasCreatePendingPluginKey.getState(state)?.decorations ?? DecorationSet.empty,
    },
  });
}

export const canvasCreatePendingExtension = createExtension(() => ({
  key: "canvas-create-pending",
  prosemirrorPlugins: [createCanvasCreatePendingPlugin()],
}));

export function setCanvasCreatePending(
  editor: EditorWithCanvasCreatePending,
  blockId: string,
  pending: boolean,
): void {
  editor.transact((transaction) => {
    transaction.setMeta(canvasCreatePendingPluginKey, {
      blockId,
      pending,
    } satisfies CanvasCreatePendingAction);
  });
}
