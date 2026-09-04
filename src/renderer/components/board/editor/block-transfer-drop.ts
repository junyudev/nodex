import { dropTargetForElements } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { DropCursorExtension } from "@blocknote/core/extensions";
import type { NfmReceivingPageTransferIntent } from "./nfm-history-command";
import type { DocumentHeadFence } from "../../../lib/block-document-surface-runtime";
import {
  blockTransferDropLabel,
  claimLocalBlockDragDropTarget,
  type CrossSurfaceBlockTransferPayload,
  endLocalBlockDragSession,
  registerLocalBlockDragDropTarget,
  releaseLocalBlockDragDropTarget,
  resolveLocalBlockDragDropSession,
  resolveLocalBlockDragOverSession,
  resolveCrossSurfaceTransferMode,
} from "../../workbench/block-transfer/cross-surface-drag";
import {
  buildBoardCardEditorTransferTargetData,
  isBoardCardDragData,
} from "../pragmatic-drag-data";
import { hasClosest, resolveBlockId } from "./drag-source-resolver";
import {
  createToggleDropCueController,
  isToggleDropTargetBlock,
  resolveCollapsedToggleDropTarget,
  type CollapsedToggleDropTarget,
} from "./toggle-drop";

import {
  DOCUMENT_STRUCTURAL_WAIT_TIMEOUT_MS,
  waitForDocumentOperation,
  type DocumentWaitOptions,
} from "@/lib/document-wait";

interface EditorBlock {
  readonly id: string;
  readonly type?: string;
  readonly props?: Readonly<Record<string, unknown>>;
  readonly children?: readonly EditorBlock[];
}

export interface BlockTransferDropEditor {
  readonly document: readonly EditorBlock[];
  readonly getExtension?: (extension: unknown) => unknown;
}

export interface BlockTransferDropBoundary {
  readonly surfaceId: string;
  readonly projectId: string;
  readonly documentId: string;
  readonly storeEpoch: string;
  readonly hostPageId?: string;
  readonly ancestorPageIds: readonly string[];
  /** Settles the destination editor and flushes its durable causal head. */
  readonly prepareAndFence: (options?: DocumentWaitOptions) => Promise<DocumentHeadFence>;
  /** Settles and flushes the actual drag source mounted in this renderer. */
  readonly prepareSourceAndFence: (
    sourceSurfaceId: string,
    options?: DocumentWaitOptions,
  ) => Promise<DocumentHeadFence>;
  readonly receivePages: (intent: NfmReceivingPageTransferIntent) => Promise<void>;
  /** Admits the gesture synchronously; prepares heads only inside its history queue. */
  readonly structuralTransfer: (input: {
    readonly mode: "move" | "copy";
    readonly rootBlockIds: readonly string[];
    readonly prepareHeads: () => Promise<{
      readonly sourceHead: DocumentHeadFence;
      readonly targetHead: DocumentHeadFence;
    }>;
    readonly target: {
      readonly parentBlockId: string | null;
      readonly beforeBlockId: string | null;
    };
    readonly preferredSelectionBlockId?: string;
  }) => Promise<void>;
  readonly reportError: (message: string) => void;
}

interface DropAnchor {
  readonly blockId: string;
  readonly placement: "before" | "after";
  readonly element: HTMLElement;
}

const resolveAnchor = (
  container: HTMLElement,
  clientX: number,
  clientY: number,
): DropAnchor | null => {
  const elements =
    typeof container.ownerDocument.elementsFromPoint === "function"
      ? container.ownerDocument.elementsFromPoint(clientX, clientY)
      : [];
  for (const element of elements) {
    if (!hasClosest(element) || !container.contains(element)) continue;
    const blockElement = element.closest<HTMLElement>(".bn-block[data-id]");
    if (!blockElement) continue;
    const blockId = resolveBlockId(blockElement);
    if (!blockId) continue;
    const rect = blockElement.getBoundingClientRect();
    return {
      blockId,
      placement: clientY <= rect.top + rect.height / 2 ? "before" : "after",
      element: blockElement,
    };
  }
  const blocks = Array.from(container.querySelectorAll<HTMLElement>(".bn-block[data-id]"));
  for (const blockElement of blocks) {
    const blockId = resolveBlockId(blockElement);
    if (!blockId) continue;
    const rect = blockElement.getBoundingClientRect();
    if (clientY <= rect.top + rect.height / 2) {
      return { blockId, placement: "before", element: blockElement };
    }
  }
  const last = blocks.at(-1);
  const lastId = last ? resolveBlockId(last) : null;
  return last && lastId ? { blockId: lastId, placement: "after", element: last } : null;
};

interface LocatedBlock {
  readonly parentBlockId?: string;
  readonly siblings: readonly EditorBlock[];
  readonly index: number;
}

const isSameDocumentSource = (
  payload: Pick<CrossSurfaceBlockTransferPayload, "source">,
  boundary: Pick<BlockTransferDropBoundary, "documentId" | "hostPageId">,
): boolean =>
  (payload.source.kind === "page" && payload.source.pageId === boundary.hostPageId) ||
  (payload.source.kind === "document" && payload.source.documentId === boundary.documentId);

const locateBlock = (
  blocks: readonly EditorBlock[],
  blockId: string,
  parentBlockId?: string,
): LocatedBlock | null => {
  const index = blocks.findIndex((block) => block.id === blockId);
  if (index >= 0) return { parentBlockId, siblings: blocks, index };
  for (const block of blocks) {
    const nested = locateBlock(block.children ?? [], blockId, block.id);
    if (nested) return nested;
  }
  return null;
};

const collectBlockIds = (block: EditorBlock, ids: Set<string>): void => {
  ids.add(block.id);
  for (const child of block.children ?? []) collectBlockIds(child, ids);
};

const resolveDraggedClosureIds = (
  editor: BlockTransferDropEditor,
  rootBlockIds: readonly string[],
): ReadonlySet<string> => {
  const closure = new Set<string>();
  for (const rootBlockId of rootBlockIds) {
    const root = locateBlock(editor.document, rootBlockId);
    const block = root?.siblings[root.index];
    if (block) collectBlockIds(block, closure);
  }
  return closure;
};

export const isSameDocumentBlockTargetInsideSelection = (
  editor: BlockTransferDropEditor,
  rootBlockIds: readonly string[],
  target: {
    readonly parentBlockId?: string;
    readonly beforeBlockId?: string;
  },
): boolean => {
  const selectedClosure = resolveDraggedClosureIds(editor, rootBlockIds);
  return Boolean(
    (target.parentBlockId && selectedClosure.has(target.parentBlockId)) ||
    (target.beforeBlockId && selectedClosure.has(target.beforeBlockId)),
  );
};

/**
 * A structural move owns placement at subtree granularity. Ignore destinations
 * inside that subtree and moves that preserve the current sibling order before
 * asking Core to create history for them.
 */
export const isSameDocumentBlockMoveNoOp = (
  editor: BlockTransferDropEditor,
  rootBlockIds: readonly string[],
  target: {
    readonly parentBlockId?: string;
    readonly beforeBlockId?: string;
  },
): boolean => {
  if (isSameDocumentBlockTargetInsideSelection(editor, rootBlockIds, target)) return true;

  const requestedRoots = new Set(rootBlockIds);
  const locatedRoots = rootBlockIds.flatMap((blockId) => {
    const located = locateBlock(editor.document, blockId);
    return located ? [located] : [];
  });
  if (locatedRoots.length !== requestedRoots.size) return false;

  const targetParentBlockId = target.parentBlockId;
  if (locatedRoots.some((located) => located.parentBlockId !== targetParentBlockId)) return false;
  const siblings = locatedRoots[0]?.siblings;
  if (!siblings || locatedRoots.some((located) => located.siblings !== siblings)) return false;

  const currentIds = siblings.map((block) => block.id);
  const orderedRootIds = currentIds.filter((blockId) => requestedRoots.has(blockId));
  const remainingIds = currentIds.filter((blockId) => !requestedRoots.has(blockId));
  const insertionIndex = target.beforeBlockId
    ? remainingIds.indexOf(target.beforeBlockId)
    : remainingIds.length;
  if (insertionIndex < 0) return false;
  const nextIds = remainingIds.toSpliced(insertionIndex, 0, ...orderedRootIds);
  return currentIds.every((blockId, index) => nextIds[index] === blockId);
};

export const resolveBlockTransferDocumentTarget = (
  editor: BlockTransferDropEditor,
  anchor: Pick<DropAnchor, "blockId" | "placement"> | null,
): {
  readonly parentBlockId?: string;
  readonly beforeBlockId?: string;
} => {
  if (!anchor) return {};
  const located = locateBlock(editor.document, anchor.blockId);
  if (!located) return {};
  const beforeBlockId =
    anchor.placement === "before" ? anchor.blockId : located.siblings[located.index + 1]?.id;
  return {
    ...(located.parentBlockId ? { parentBlockId: located.parentBlockId } : {}),
    ...(beforeBlockId ? { beforeBlockId } : {}),
  };
};

export type BlockTransferDocumentDropPlan =
  | {
      readonly kind: "append_children";
      readonly target: {
        readonly parentBlockId: string;
        readonly beforeBlockId?: undefined;
      };
      readonly toggle: CollapsedToggleDropTarget;
    }
  | {
      readonly kind: "between";
      readonly target: {
        readonly parentBlockId?: string;
        readonly beforeBlockId?: string;
      };
      readonly anchor: DropAnchor | null;
    };

/**
 * Pointer semantics are resolved once for both feedback and commit. A
 * collapsed toggle's center appends children; its edge bands remain ordinary
 * before/after insertion positions.
 */
export const resolveBlockTransferDocumentDropPlan = (
  editor: BlockTransferDropEditor,
  container: HTMLElement,
  clientX: number,
  clientY: number,
): BlockTransferDocumentDropPlan => {
  const toggle = resolveCollapsedToggleDropTarget(container, clientX, clientY);
  if (toggle) {
    const located = locateBlock(editor.document, toggle.blockId);
    const block = located?.siblings[located.index];
    if (block?.type && isToggleDropTargetBlock({ type: block.type, props: block.props })) {
      return {
        kind: "append_children",
        target: { parentBlockId: toggle.blockId },
        toggle,
      };
    }
  }

  const anchor = resolveAnchor(container, clientX, clientY);
  return {
    kind: "between",
    target: resolveBlockTransferDocumentTarget(editor, anchor),
    anchor,
  };
};

const createIndicator = (container: HTMLElement): HTMLDivElement => {
  const indicator = container.ownerDocument.createElement("div");
  indicator.setAttribute("data-block-transfer-drop-indicator", "");
  indicator.setAttribute("aria-hidden", "true");
  indicator.className =
    "prosemirror-dropcursor-block prosemirror-dropcursor-block-horizontal pointer-events-none absolute z-50";
  return indicator;
};

const positionIndicator = (
  indicator: HTMLDivElement,
  container: HTMLElement,
  anchor: DropAnchor | null,
): void => {
  const containerRect = container.getBoundingClientRect();
  if (!anchor) {
    indicator.style.left = "12px";
    indicator.style.right = "12px";
    indicator.style.top = "10px";
    return;
  }
  const rect = anchor.element.getBoundingClientRect();
  indicator.style.left = `${Math.max(rect.left - containerRect.left, 0)}px`;
  indicator.style.width = `${Math.max(rect.width, 32)}px`;
  indicator.style.top = `${(anchor.placement === "before" ? rect.top : rect.bottom) - containerRect.top}px`;
};

interface PragmaticDropTargetLocation {
  readonly current: {
    readonly dropTargets: readonly { readonly element: Element }[];
  };
}

const isInnermostPragmaticDropTarget = (
  location: PragmaticDropTargetLocation,
  element: Element,
): boolean => location.current.dropTargets[0]?.element === element;

export const setupBlockTransferDocumentDrop = (
  container: HTMLElement,
  editor: BlockTransferDropEditor,
  readBoundary: () => BlockTransferDropBoundary,
): (() => void) => {
  const lifetime = new AbortController();
  let indicator: HTMLDivElement | null = null;
  const toggleCue = createToggleDropCueController(container);
  const dropCursor = editor.getExtension?.(DropCursorExtension) as
    | { readonly clearDropCursor?: () => void }
    | undefined;
  const clear = () => {
    indicator?.remove();
    indicator = null;
    toggleCue.clear();
    container.removeAttribute("data-block-transfer-drop-hover");
    container.removeAttribute("data-block-transfer-drop-label");
    dropCursor?.clearDropCursor?.();
  };
  const canTransfer = (source: unknown): boolean => {
    const boundary = readBoundary();
    if (!isBoardCardDragData(source)) return false;
    if (source.projectId !== boundary.projectId || source.storeEpoch !== boundary.storeEpoch) {
      return false;
    }
    const forbidden = new Set(boundary.ancestorPageIds);
    if (boundary.hostPageId) forbidden.add(boundary.hostPageId);
    return source.dragItems.every((item) => !forbidden.has(item.card.id));
  };
  const updateIndicator = (plan: BlockTransferDocumentDropPlan, altKey: boolean) => {
    // Nodex owns every side-menu Block placement gesture. Its cursor must be
    // the only insertion line once the local transfer session is accepted.
    dropCursor?.clearDropCursor?.();
    container.setAttribute("data-block-transfer-drop-hover", "");
    container.setAttribute(
      "data-block-transfer-drop-label",
      blockTransferDropLabel(resolveCrossSurfaceTransferMode({ altKey }), "page"),
    );
    if (plan.kind === "append_children") {
      indicator?.remove();
      indicator = null;
      toggleCue.show(plan.toggle);
      return;
    }

    toggleCue.clear();
    indicator ??= createIndicator(container);
    if (!indicator.isConnected) container.append(indicator);
    positionIndicator(indicator, container, plan.anchor);
  };

  const prepareStructuralMutation = async (
    boundary: BlockTransferDropBoundary,
    sourceSurfaceId?: string,
  ): Promise<readonly DocumentHeadFence[]> => {
    const options = {
      signal: lifetime.signal,
      deadlineAt: Date.now() + DOCUMENT_STRUCTURAL_WAIT_TIMEOUT_MS,
    };
    const tokens = await waitForDocumentOperation(
      () =>
        Promise.all([
          boundary.prepareAndFence(options),
          sourceSurfaceId === undefined || sourceSurfaceId === boundary.surfaceId
            ? undefined
            : boundary.prepareSourceAndFence(sourceSurfaceId, options),
        ]),
      options,
    );
    return tokens.filter((token): token is DocumentHeadFence => token !== undefined);
  };

  const reportFailure = (error: unknown, fallback: string): void => {
    readBoundary().reportError(error instanceof Error ? error.message : fallback);
  };

  const pragmaticCleanup = dropTargetForElements({
    element: container,
    getData: buildBoardCardEditorTransferTargetData,
    canDrop: ({ source }) => canTransfer(source.data),
    getDropEffect: ({ input }) => resolveCrossSurfaceTransferMode(input),
    onDragEnter: ({ location, self }) => {
      if (!isInnermostPragmaticDropTarget(location, self.element)) {
        clear();
        return;
      }
      updateIndicator(
        resolveBlockTransferDocumentDropPlan(
          editor,
          container,
          location.current.input.clientX,
          location.current.input.clientY,
        ),
        location.current.input.altKey,
      );
    },
    onDrag: ({ location, self }) => {
      if (!isInnermostPragmaticDropTarget(location, self.element)) {
        clear();
        return;
      }
      updateIndicator(
        resolveBlockTransferDocumentDropPlan(
          editor,
          container,
          location.current.input.clientX,
          location.current.input.clientY,
        ),
        location.current.input.altKey,
      );
    },
    onDragLeave: clear,
    onDrop: ({ source, location, self }) => {
      const boundary = readBoundary();
      if (!isInnermostPragmaticDropTarget(location, self.element)) {
        clear();
        return;
      }
      if (!isBoardCardDragData(source.data)) {
        clear();
        return;
      }
      const sourceData = source.data;
      const plan = resolveBlockTransferDocumentDropPlan(
        editor,
        container,
        location.current.input.clientX,
        location.current.input.clientY,
      );
      const target = plan.target;
      clear();
      void boundary
        .receivePages({
          projectId: boundary.projectId,
          storeEpoch: boundary.storeEpoch,
          mode: resolveCrossSurfaceTransferMode(location.current.input),
          rootBlockIds: sourceData.dragItems.map((item) => item.card.id),
          dataSourceId: sourceData.dataSourceId,
          target: boundary.hostPageId
            ? { kind: "page", pageId: boundary.hostPageId, ...target }
            : {
                kind: "document",
                documentId: boundary.documentId,
                ...target,
              },
        })
        .catch((error: unknown) => reportFailure(error, "Block transfer failed"));
    },
  });

  const unregisterManagedDropTarget = registerLocalBlockDragDropTarget({
    surfaceId: readBoundary().surfaceId,
    element: container,
    deactivate: clear,
  });

  const resolveManagedSession = (event: DragEvent) => {
    const session = resolveLocalBlockDragOverSession(event.dataTransfer);
    if (!session) return null;
    if (
      !claimLocalBlockDragDropTarget({
        surfaceId: readBoundary().surfaceId,
        event,
      })
    ) {
      return null;
    }
    return session;
  };
  const canTransferPayload = (payload: CrossSurfaceBlockTransferPayload): boolean => {
    const boundary = readBoundary();
    if (payload.projectId !== boundary.projectId || payload.storeEpoch !== boundary.storeEpoch) {
      return false;
    }
    const forbidden = new Set(boundary.ancestorPageIds);
    if (boundary.hostPageId) forbidden.add(boundary.hostPageId);
    return payload.rootBlockIds.every((blockId) => !forbidden.has(blockId));
  };
  const claimManagedEvent = (event: DragEvent): void => {
    event.preventDefault();
    event.stopPropagation();
  };
  const onNativeDragOver = (event: DragEvent) => {
    const boundary = readBoundary();
    const session = resolveManagedSession(event);
    if (!session) return;
    claimManagedEvent(event);

    if (!canTransferPayload(session.payload)) {
      event.dataTransfer!.dropEffect = "none";
      clear();
      return;
    }
    const mode = resolveCrossSurfaceTransferMode(event);
    const plan = resolveBlockTransferDocumentDropPlan(
      editor,
      container,
      event.clientX,
      event.clientY,
    );
    if (isSameDocumentSource(session.payload, boundary)) {
      if (
        isSameDocumentBlockTargetInsideSelection(
          editor,
          session.payload.rootBlockIds,
          plan.target,
        ) ||
        (mode === "move" &&
          isSameDocumentBlockMoveNoOp(editor, session.payload.rootBlockIds, plan.target))
      ) {
        event.dataTransfer!.dropEffect = "none";
        clear();
        return;
      }
    }
    event.dataTransfer!.dropEffect = mode;
    updateIndicator(plan, event.altKey);
  };
  const onNativeDragLeave = (event: DragEvent) => {
    if (!resolveLocalBlockDragOverSession(event.dataTransfer)) return;
    const next = event.relatedTarget;
    if (next instanceof Node && container.contains(next)) return;
    releaseLocalBlockDragDropTarget(readBoundary().surfaceId);
    clear();
  };
  const onNativeDrop = (event: DragEvent) => {
    const boundary = readBoundary();
    const managedSession = resolveManagedSession(event);
    if (!managedSession) return;
    claimManagedEvent(event);
    clear();
    const session = resolveLocalBlockDragDropSession(event.dataTransfer);
    if (!session || session.sessionId !== managedSession.sessionId) return;
    endLocalBlockDragSession({ sessionId: session.sessionId });

    if (!canTransferPayload(session.payload)) {
      boundary.reportError(
        "Block transfer belongs to another Project, store generation, or recursive Page boundary.",
      );
      return;
    }

    const plan = resolveBlockTransferDocumentDropPlan(
      editor,
      container,
      event.clientX,
      event.clientY,
    );
    const mode = resolveCrossSurfaceTransferMode(event);
    if (
      isSameDocumentSource(session.payload, boundary) &&
      (isSameDocumentBlockTargetInsideSelection(
        editor,
        session.payload.rootBlockIds,
        plan.target,
      ) ||
        (mode === "move" &&
          isSameDocumentBlockMoveNoOp(editor, session.payload.rootBlockIds, plan.target)))
    ) {
      return;
    }
    void boundary
      .structuralTransfer({
        mode,
        rootBlockIds: session.payload.rootBlockIds,
        prepareHeads: async () => {
          const [targetHead, sourceHead = targetHead] = await prepareStructuralMutation(
            boundary,
            session.sourceSurfaceId,
          );
          if (!targetHead || !sourceHead)
            throw new Error("The structural transfer has no durable document head.");
          return { targetHead, sourceHead };
        },
        target: {
          parentBlockId: plan.target.parentBlockId ?? null,
          beforeBlockId: plan.target.beforeBlockId ?? null,
        },
        ...(plan.kind === "append_children"
          ? { preferredSelectionBlockId: plan.target.parentBlockId }
          : {}),
      })
      .catch((error: unknown) => reportFailure(error, "Structural transfer failed"));
  };

  container.addEventListener("dragenter", onNativeDragOver, true);
  container.addEventListener("dragover", onNativeDragOver, true);
  container.addEventListener("dragleave", onNativeDragLeave, true);
  container.addEventListener("drop", onNativeDrop, true);

  return () => {
    lifetime.abort();
    clear();
    pragmaticCleanup();
    container.removeEventListener("dragenter", onNativeDragOver, true);
    container.removeEventListener("dragover", onNativeDragOver, true);
    container.removeEventListener("dragleave", onNativeDragLeave, true);
    container.removeEventListener("drop", onNativeDrop, true);
    unregisterManagedDropTarget();
  };
};
