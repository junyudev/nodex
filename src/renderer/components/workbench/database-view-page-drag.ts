import { draggable as registerDraggable } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { disableNativeDragPreview } from "@atlaskit/pragmatic-drag-and-drop/element/disable-native-drag-preview";
import { preserveOffsetOnSource } from "@atlaskit/pragmatic-drag-and-drop/element/preserve-offset-on-source";
import { setCustomNativeDragPreview } from "@atlaskit/pragmatic-drag-and-drop/element/set-custom-native-drag-preview";
import { useCallback, useEffect, useRef, useState } from "react";

import type { BoardCardDragData } from "@/components/board/pragmatic-drag-data";
import type {
  DatabaseViewRenderModel,
  DatabaseViewRenderRow,
} from "@/lib/database-view-render-model";
import type { DatabasePageSummary, WorkflowStatus } from "@/lib/types";
import { DEFAULT_WORKFLOW_STATUS } from "../../../shared/workflow-status";

export interface DatabaseViewPageDragPreviewPortal {
  readonly container: HTMLElement;
  readonly rect: DOMRect;
  readonly itemCount: number;
}

export interface DatabaseViewPageDragSourceRegistration {
  readonly setElementRef: (element: HTMLElement | null) => void;
  readonly previewPortal: DatabaseViewPageDragPreviewPortal | null;
}

/**
 * Builds an inert source-shaped native drag image for List rows. Board Cards
 * use a React portal so their preview can reuse the semantic Card surface.
 */
export const createDatabaseListPageDragPreviewElement = ({
  element,
  itemCount,
}: {
  readonly element: HTMLElement;
  readonly itemCount: number;
}): HTMLElement => {
  const rect = element.getBoundingClientRect();
  const preview = element.ownerDocument.createElement("div");
  preview.dataset.databaseViewPageDragPreview = "true";
  preview.style.position = "relative";
  preview.style.boxSizing = "border-box";
  preview.style.width = `${rect.width}px`;
  preview.style.height = `${rect.height}px`;

  const clone = element.cloneNode(true) as HTMLElement;
  clone.removeAttribute("draggable");
  clone.removeAttribute("data-database-view-page-drag-active");
  clone.setAttribute("aria-hidden", "true");
  clone.inert = true;
  clone.style.boxSizing = "border-box";
  clone.style.width = `${rect.width}px`;
  clone.style.height = `${rect.height}px`;
  clone.style.opacity = "0.9";
  clone.style.pointerEvents = "none";
  preview.append(clone);

  if (itemCount > 1) {
    const badge = element.ownerDocument.createElement("div");
    badge.className =
      "absolute -top-1.5 -right-1.5 rounded-full bg-(--foreground) px-1.75 py-0.75 text-sm font-medium text-(--background) shadow-lg";
    badge.textContent = String(itemCount);
    preview.append(badge);
  }
  return preview;
};

const projectDatabasePageSummary = ({
  model,
  row,
}: {
  readonly model: DatabaseViewRenderModel;
  readonly row: DatabaseViewRenderRow;
}): DatabasePageSummary | null => {
  const authority = model.query.rows.find((candidate) => candidate.page.pageId === row.pageId);
  if (!authority) return null;

  return {
    id: row.pageId,
    pageKey: row.pageKey,
    status: row.status ?? DEFAULT_WORKFLOW_STATUS,
    archived: authority.page.lifecycle === "archived",
    title: row.title,
    richTitle: authority.page.richTitle,
    descriptionPreview: row.preview,
    descriptionLength: row.plainText.length,
    hasDescription: row.plainText.trim().length > 0,
    ...(row.priority ? { priority: row.priority } : {}),
    ...(row.estimate ? { estimate: row.estimate } : {}),
    tags: [...row.tags],
    ...(row.dueDate ? { dueDate: row.dueDate } : {}),
    ...(row.scheduledStart ? { scheduledStart: row.scheduledStart } : {}),
    ...(row.scheduledEnd ? { scheduledEnd: row.scheduledEnd } : {}),
    ...(row.assignee ? { assignee: row.assignee } : {}),
    created: row.createdAt,
    order:
      authority.position?.order ??
      model.query.rows.findIndex((candidate) => candidate.page.pageId === row.pageId),
  };
};

/**
 * Projects a generic Database View row into the live Page-transfer protocol
 * consumed by NFM. Board/List layout and grouping stay presentation-only.
 */
export const buildDatabaseViewPageDragData = ({
  model,
  row,
  allRows,
  selectedPageIds,
  instanceId,
}: {
  readonly model: DatabaseViewRenderModel;
  readonly row: DatabaseViewRenderRow;
  readonly allRows: readonly DatabaseViewRenderRow[];
  readonly selectedPageIds: ReadonlySet<string>;
  readonly instanceId: symbol;
}): BoardCardDragData | null => {
  if (model.accessContext.kind !== "project") return null;

  const draggedRows = selectedPageIds.has(row.pageId)
    ? allRows.filter(
        (candidate, index) =>
          selectedPageIds.has(candidate.pageId) &&
          allRows.findIndex((entry) => entry.pageId === candidate.pageId) === index,
      )
    : [row];
  const dragItems = draggedRows.flatMap((candidate) => {
    const card = projectDatabasePageSummary({ model, row: candidate });
    if (!card) return [];
    const columnId: WorkflowStatus = candidate.status ?? DEFAULT_WORKFLOW_STATUS;
    return [
      {
        card,
        columnId,
        columnName: candidate.groupKey ?? "Unassigned",
      },
    ];
  });
  const sourcePage = projectDatabasePageSummary({ model, row });
  if (!sourcePage || dragItems.length === 0) return null;

  return {
    type: "board-card",
    instanceId,
    projectId: model.accessContext.projectId,
    databaseBlockId: model.databaseId,
    dataSourceId: model.dataSourceId,
    storeEpoch: model.storeEpoch,
    sourcePageId: row.pageId,
    sourceColumnId: row.status ?? DEFAULT_WORKFLOW_STATUS,
    sourcePage,
    dragItems,
  };
};

/** Registers the same native Page source on Board cards and List rows. */
export const useDatabaseViewPageDragSource = (
  dragData: BoardCardDragData | null,
  options: {
    readonly dragHandle?: Element | null;
    readonly nativePreview?: "portal" | "source" | "disabled";
    readonly onDragFinished?: () => void;
  } = {},
): DatabaseViewPageDragSourceRegistration => {
  const dragDataRef = useRef(dragData);
  const activeDragDataRef = useRef<BoardCardDragData | null>(null);
  const onDragFinishedRef = useRef(options.onDragFinished);
  dragDataRef.current = dragData;
  onDragFinishedRef.current = options.onDragFinished;
  const enabled = dragData !== null;
  const dragHandle = options.dragHandle ?? null;
  const nativePreview = options.nativePreview ?? "disabled";
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [previewPortal, setPreviewPortal] = useState<DatabaseViewPageDragPreviewPortal | null>(
    null,
  );
  const setElementRef = useCallback((next: HTMLElement | null) => {
    setElement((current) => (current === next ? current : next));
  }, []);

  useEffect(() => {
    if (!element || !enabled) return;
    const finish = (): void => {
      const wasActive = activeDragDataRef.current !== null;
      element.removeAttribute("data-database-view-page-drag-active");
      dragHandle?.removeAttribute("data-database-view-page-drag-active");
      activeDragDataRef.current = null;
      if (wasActive) onDragFinishedRef.current?.();
    };
    const setCopyMove = (event: DragEvent): void => {
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "copyMove";
    };
    element.addEventListener("dragstart", setCopyMove);
    const cleanup = registerDraggable({
      element,
      ...(dragHandle ? { dragHandle } : {}),
      getInitialData: () => {
        const activeDragData = activeDragDataRef.current ?? dragDataRef.current;
        if (!activeDragData) {
          throw new Error("Database Page drag data is unavailable");
        }
        activeDragDataRef.current = activeDragData;
        return activeDragData;
      },
      onGenerateDragPreview: ({ location, nativeSetDragImage }) => {
        if (nativePreview === "disabled") {
          disableNativeDragPreview({ nativeSetDragImage });
          return;
        }
        setCustomNativeDragPreview({
          nativeSetDragImage,
          getOffset: preserveOffsetOnSource({
            element,
            input: location.current.input,
          }),
          render: ({ container }) => {
            const itemCount = activeDragDataRef.current?.dragItems.length ?? 1;
            if (nativePreview === "portal") {
              setPreviewPortal({
                container,
                rect: element.getBoundingClientRect(),
                itemCount,
              });
              return () => setPreviewPortal(null);
            }
            const preview = createDatabaseListPageDragPreviewElement({
              element,
              itemCount,
            });
            container.append(preview);
            return () => preview.remove();
          },
        });
      },
      onDragStart: () => {
        element.setAttribute("data-database-view-page-drag-active", "true");
        dragHandle?.setAttribute("data-database-view-page-drag-active", "true");
      },
      onDrop: finish,
    });
    return () => {
      element.removeEventListener("dragstart", setCopyMove);
      finish();
      cleanup();
    };
  }, [dragHandle, element, enabled, nativePreview]);

  return { setElementRef, previewPortal };
};
