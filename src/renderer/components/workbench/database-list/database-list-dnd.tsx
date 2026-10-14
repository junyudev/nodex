import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MeasuringStrategy,
  MouseSensor,
  TouchSensor,
  closestCenter,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type DragOverEvent,
  type DragStartEvent,
  type Announcements,
  type CollisionDetection,
  type KeyboardSensorOptions,
  type MouseSensorOptions,
  type TouchSensorOptions,
} from "@dnd-kit/core";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type TouchEvent as ReactTouchEvent,
} from "react";
import { createPortal } from "react-dom";

import { StatusIcon } from "@/lib/status-presentation";
import { cn } from "@/lib/utils";
import type { DatabaseListMoveTargetV2 } from "../../../../shared/database-module-v2";
import { DatabaseListPriorityIcon } from "./database-list-icons";
import {
  databaseListDragTargetChangesPlacement,
  databaseListDropTargetIdentity,
  normalizeDatabaseListDropTarget,
  resolveDatabaseListDragSources,
  resolveDatabaseListRawEdge,
  type DatabaseListDragSources,
  type DatabaseListDragTarget,
} from "./database-list-drag-model";
import type {
  DatabaseListPageRow,
  DatabaseListProjectionRow,
  DatabaseListSelectionState,
} from "./database-list-model";
import { DATABASE_LIST_THEME_CLASS_NAME } from "./database-list-theme";

const databaseListCollisionDetection: CollisionDetection = (input) =>
  input.pointerCoordinates ? pointerWithin(input) : closestCenter(input);

export const DATABASE_LIST_DND_INTERACTIVE_SELECTOR = [
  "button",
  "a",
  "input",
  "textarea",
  "select",
  "[role=checkbox]",
  "[role=combobox]",
  "[role=menu]",
  "[contenteditable=true]",
].join(",");

const activatorIsAllowed = (event: { readonly nativeEvent?: Event }): boolean => {
  const target = event.nativeEvent?.target;
  return !(target instanceof Element && target.closest(DATABASE_LIST_DND_INTERACTIVE_SELECTOR));
};

class DatabaseListMouseSensor extends MouseSensor {
  static activators: typeof MouseSensor.activators = [
    {
      eventName: "onMouseDown",
      handler: (event: ReactMouseEvent, options: MouseSensorOptions) =>
        activatorIsAllowed(event) && MouseSensor.activators[0]!.handler(event, options),
    },
  ];
}

class DatabaseListTouchSensor extends TouchSensor {
  static activators: typeof TouchSensor.activators = [
    {
      eventName: "onTouchStart",
      handler: (event: ReactTouchEvent, options: TouchSensorOptions) =>
        activatorIsAllowed(event) && TouchSensor.activators[0]!.handler(event, options),
    },
  ];
}

class DatabaseListKeyboardSensor extends KeyboardSensor {
  static activators: typeof KeyboardSensor.activators = KeyboardSensor.activators.map(
    (activator) => ({
      ...activator,
      handler: (event, options, context) =>
        activatorIsAllowed(event) &&
        activator.handler(event, options as KeyboardSensorOptions, context),
    }),
  );
}

interface DatabaseListDndContextValue {
  readonly disabled: boolean;
  readonly activeOccurrenceKey: string | null;
  readonly target: DatabaseListDragTarget | null;
  readonly suppressesNextClick: () => boolean;
}

const DatabaseListDndContext = createContext<DatabaseListDndContextValue | null>(null);

const eventClientY = (event: Event): number | null => {
  if ("clientY" in event && typeof event.clientY === "number") return event.clientY;
  if ("touches" in event) {
    const touches = event.touches;
    if (
      typeof touches === "object" &&
      touches !== null &&
      "item" in touches &&
      typeof touches.item === "function"
    )
      return touches.item(0)?.clientY ?? null;
  }
  return null;
};

const eventAltKey = (event: Event): boolean => "altKey" in event && event.altKey === true;

export interface DatabaseListDndCommit {
  readonly initiatorOccurrenceKey: string;
  readonly sources: DatabaseListDragSources;
  readonly target: DatabaseListMoveTargetV2;
  readonly previewTarget: DatabaseListDragTarget;
}

export interface DatabaseListDragOverlayColumns {
  readonly priority: boolean;
  readonly identifier: boolean;
  readonly status: boolean;
}

const DEFAULT_DRAG_OVERLAY_COLUMNS: DatabaseListDragOverlayColumns = {
  priority: true,
  identifier: true,
  status: true,
};

const DatabaseListDragOverlay = ({
  sources,
  row,
  columns,
  width,
  scrollerRef,
}: {
  readonly sources: DatabaseListDragSources;
  readonly row: DatabaseListPageRow;
  readonly columns: DatabaseListDragOverlayColumns;
  readonly width: number;
  readonly scrollerRef: MutableRefObject<HTMLDivElement | null>;
}) => {
  const stackCount = Math.min(3, Math.max(0, sources.concretePageCount - 1));
  return (
    <div
      aria-hidden="true"
      data-database-list-drag-overlay="true"
      className={cn("relative", DATABASE_LIST_THEME_CLASS_NAME)}
      style={{ width }}
      onWheel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        scrollerRef.current?.scrollBy({ top: event.deltaY, left: event.deltaX });
      }}
    >
      {Array.from({ length: stackCount }, (_, index) => {
        const level = stackCount - index;
        return (
          <span
            key={level}
            aria-hidden="true"
            className="absolute inset-y-0 rounded-[10px] bg-[var(--database-list-surface)] shadow-sm ring-[0.5px] ring-inset ring-[var(--database-list-chip-border)]"
            style={{
              left: level * 4,
              right: level * 4,
              transform: `translateY(${level * 4 + 2}px)`,
            }}
          />
        );
      })}
      <div className="relative z-[1] flex h-11 min-w-0 items-center gap-[10px] rounded-[10px] bg-[var(--database-list-surface)] px-3 text-sm font-medium text-[var(--database-list-text-primary)] shadow-[0_8px_24px_rgba(0,0,0,0.18)] ring-[0.5px] ring-inset ring-[var(--database-list-chip-border)]">
        {columns.priority ? (
          <span
            data-list-drag-overlay-column="priority"
            className="grid size-4 shrink-0 place-items-center text-[var(--database-list-text-muted)]"
          >
            <DatabaseListPriorityIcon priority={row.row.priority ?? null} />
          </span>
        ) : null}
        {columns.identifier && row.row.pageKey ? (
          <span
            data-list-drag-overlay-column="identifier"
            className="shrink-0 whitespace-nowrap text-sm font-[450] leading-[normal] tracking-[-0.02em] tabular-nums text-[var(--database-list-text-muted)]"
          >
            {row.row.pageKey}
          </span>
        ) : null}
        {columns.status ? (
          <span
            data-list-drag-overlay-column="status"
            className="grid size-4 shrink-0 place-items-center text-[var(--database-list-text-muted)]"
          >
            {row.row.status ? (
              <StatusIcon statusId={row.row.status} className="size-4" />
            ) : (
              <span className="size-2 rounded-full ring-[1px] ring-[var(--database-list-icon-muted)]" />
            )}
          </span>
        ) : null}
        <span className="min-w-0 flex-1 truncate">{row.row.title || "Untitled Page"}</span>
        {sources.concretePageCount > 1 ? (
          <span className="grid min-w-5 shrink-0 place-items-center rounded-full bg-[var(--database-list-focus)] px-1.5 text-[11px] font-semibold leading-5 text-white">
            {sources.concretePageCount}
          </span>
        ) : null}
      </div>
    </div>
  );
};

const dragRowLabel = (row: DatabaseListProjectionRow | undefined): string => {
  if (!row) return "the current List position";
  if (row.kind === "page") return row.row.title || "Untitled Page";
  return row.label || "the current group";
};

export function DatabaseListDndProvider({
  rows,
  selection,
  scrollerRef,
  disabled,
  overlayColumns = DEFAULT_DRAG_OVERLAY_COLUMNS,
  onActiveChange,
  onCommit,
  children,
}: {
  readonly rows: readonly DatabaseListProjectionRow[];
  readonly selection: DatabaseListSelectionState;
  readonly scrollerRef: MutableRefObject<HTMLDivElement | null>;
  readonly disabled: boolean;
  readonly overlayColumns?: DatabaseListDragOverlayColumns;
  readonly onActiveChange?: (active: boolean) => void;
  readonly onCommit: (commit: DatabaseListDndCommit) => void;
  readonly children: ReactNode;
}) {
  const sensors = useSensors(
    useSensor(DatabaseListMouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(DatabaseListTouchSensor, {
      activationConstraint: { delay: 200, tolerance: 5 },
    }),
    useSensor(DatabaseListKeyboardSensor),
  );
  const rowsRef = useRef(rows);
  const selectionRef = useRef(selection);
  const sourcesRef = useRef<DatabaseListDragSources | null>(null);
  const targetRef = useRef<DatabaseListDragTarget | null>(null);
  const completedTargetRef = useRef<DatabaseListDragTarget | null>(null);
  const completedNoOpRef = useRef(false);
  const pointerYRef = useRef<number | null>(null);
  const keyboardDragRef = useRef(false);
  const overKeyRef = useRef<string | null>(null);
  const overRectRef = useRef<{ readonly top: number; readonly height: number } | null>(null);
  const altKeyRef = useRef(false);
  const suppressClickRef = useRef(false);
  const releaseClickTimerRef = useRef<number | null>(null);
  const autoScrollFrameRef = useRef<number | null>(null);
  const [sources, setSources] = useState<DatabaseListDragSources | null>(null);
  const [target, setTarget] = useState<DatabaseListDragTarget | null>(null);
  const [overlayWidth, setOverlayWidth] = useState(320);
  rowsRef.current = rows;
  selectionRef.current = selection;

  const publishTarget = (next: DatabaseListDragTarget | null): void => {
    const unchanged =
      databaseListDropTargetIdentity(targetRef.current) === databaseListDropTargetIdentity(next);
    // Preserve the latest physical droppable even when both row halves resolve
    // to the same canonical slot. React only needs the semantic visual change.
    targetRef.current = next;
    if (unchanged) return;
    setTarget(next);
  };

  const announcements: Announcements = {
    onDragStart: ({ active }) => {
      const activeSources = sourcesRef.current;
      const title =
        activeSources?.initiator.row.title ??
        dragRowLabel(rowsRef.current.find((row) => row.key === String(active.id)));
      const count = activeSources?.concretePageCount ?? 1;
      return count > 1
        ? `Picked up ${title}. Moving a subtree of ${count} Pages.`
        : `Picked up ${title}.`;
    },
    onDragOver: ({ over }) => {
      const currentTarget = targetRef.current;
      if (!over || !currentTarget) return undefined;
      const label = dragRowLabel(
        rowsRef.current.find((row) => row.key === currentTarget.occurrenceKey),
      );
      if (currentTarget.kind === "group") return `Moving inside ${label}.`;
      return `Moving ${currentTarget.indicatorEdge} ${label}.`;
    },
    onDragEnd: () => {
      if (completedNoOpRef.current) return "The Page stayed in its current List position.";
      const acceptedTarget = completedTargetRef.current;
      if (!acceptedTarget) return "The List move was not applied.";
      const label = dragRowLabel(
        rowsRef.current.find((row) => row.key === acceptedTarget.occurrenceKey),
      );
      if (acceptedTarget.kind === "group") return `Moved inside ${label}.`;
      return `Moved ${acceptedTarget.indicatorEdge} ${label}.`;
    },
    onDragCancel: () => "List movement cancelled.",
  };

  const resolveTarget = (): void => {
    const activeSources = sourcesRef.current;
    const overKey = overKeyRef.current;
    if (!activeSources || !overKey) {
      publishTarget(null);
      return;
    }
    const row = rowsRef.current.find((candidate) => candidate.key === overKey);
    if (!row) {
      publishTarget(null);
      return;
    }
    if (row.kind !== "page") {
      publishTarget(
        normalizeDatabaseListDropTarget({
          rows: rowsRef.current,
          row,
          sources: activeSources,
        }),
      );
      return;
    }
    const rect = overRectRef.current;
    const pointerY = pointerYRef.current;
    if (!rect || pointerY === null) {
      publishTarget(null);
      return;
    }
    publishTarget(
      normalizeDatabaseListDropTarget({
        rows: rowsRef.current,
        row,
        sources: activeSources,
        rawEdge: resolveDatabaseListRawEdge({
          pointerY,
          top: rect.top,
          height: rect.height,
          explicitInside: altKeyRef.current,
        }),
      }),
    );
  };

  const stopAutoScroll = (): void => {
    if (autoScrollFrameRef.current !== null) {
      cancelAnimationFrame(autoScrollFrameRef.current);
      autoScrollFrameRef.current = null;
    }
  };

  const runAutoScroll = (): void => {
    const scroller = scrollerRef.current;
    const pointerY = pointerYRef.current;
    if (!scroller || pointerY === null || !sourcesRef.current) {
      stopAutoScroll();
      return;
    }
    const rect = scroller.getBoundingClientRect();
    const edgeSize = Math.min(64, rect.height * 0.18);
    const topDistance = pointerY - rect.top;
    const bottomDistance = rect.bottom - pointerY;
    let delta = 0;
    if (topDistance >= 0 && topDistance < edgeSize) {
      delta = -Math.max(3, Math.round(20 * (1 - topDistance / edgeSize)));
    } else if (bottomDistance >= 0 && bottomDistance < edgeSize) {
      delta = Math.max(3, Math.round(20 * (1 - bottomDistance / edgeSize)));
    }
    if (delta !== 0) scroller.scrollBy({ top: delta });
    autoScrollFrameRef.current = requestAnimationFrame(runAutoScroll);
  };

  const beginAutoScroll = (): void => {
    stopAutoScroll();
    autoScrollFrameRef.current = requestAnimationFrame(runAutoScroll);
  };

  const finish = (): void => {
    suppressClickRef.current = true;
    if (releaseClickTimerRef.current !== null) {
      window.clearTimeout(releaseClickTimerRef.current);
    }
    releaseClickTimerRef.current = window.setTimeout(() => {
      suppressClickRef.current = false;
      releaseClickTimerRef.current = null;
    }, 0);
    stopAutoScroll();
    sourcesRef.current = null;
    targetRef.current = null;
    overKeyRef.current = null;
    overRectRef.current = null;
    pointerYRef.current = null;
    keyboardDragRef.current = false;
    altKeyRef.current = false;
    setSources(null);
    setTarget(null);
    onActiveChange?.(false);
  };

  const updateOver = (event: DragMoveEvent | DragOverEvent): void => {
    overKeyRef.current = event.over ? String(event.over.id) : null;
    overRectRef.current = event.over
      ? { top: event.over.rect.top, height: event.over.rect.height }
      : null;
    if (keyboardDragRef.current) {
      pointerYRef.current = event.over
        ? event.over.rect.top + event.over.rect.height * (event.delta.y < 0 ? 0.25 : 0.75)
        : null;
    }
    resolveTarget();
  };

  const handleDragStart = (event: DragStartEvent): void => {
    if (disabled) return;
    const activeSources = resolveDatabaseListDragSources({
      rows: rowsRef.current,
      selection: selectionRef.current,
      initiatorOccurrenceKey: String(event.active.id),
    });
    if (!activeSources) return;
    const activeRect = event.active.rect.current.initial;
    const preferredWidth =
      activeRect && activeRect.width < 400
        ? activeRect.width + 16
        : Math.min(500, Math.max(300, Math.round((activeRect?.width ?? 800) * 0.4)));
    sourcesRef.current = activeSources;
    completedTargetRef.current = null;
    completedNoOpRef.current = false;
    keyboardDragRef.current = event.activatorEvent.type === "keydown";
    pointerYRef.current = eventClientY(event.activatorEvent);
    altKeyRef.current = eventAltKey(event.activatorEvent);
    setOverlayWidth(preferredWidth);
    setSources(activeSources);
    onActiveChange?.(true);
    window.getSelection()?.removeAllRanges();
    beginAutoScroll();
  };

  const handleDragMove = (event: DragMoveEvent): void => {
    const initialY = eventClientY(event.activatorEvent);
    if (initialY !== null) pointerYRef.current = initialY + event.delta.y;
    updateOver(event);
  };

  const handleDragEnd = (event: DragEndEvent): void => {
    const activeSources = sourcesRef.current;
    const acceptedTarget =
      event.over && targetRef.current?.overOccurrenceKey === String(event.over.id)
        ? targetRef.current
        : null;
    completedTargetRef.current = acceptedTarget;
    const noOp =
      activeSources && acceptedTarget
        ? !databaseListDragTargetChangesPlacement({
            rows: rowsRef.current,
            sources: activeSources,
            target: acceptedTarget,
          })
        : false;
    completedNoOpRef.current = noOp;
    if (activeSources && acceptedTarget && !noOp) {
      onCommit({
        initiatorOccurrenceKey: activeSources.initiator.key,
        sources: activeSources,
        target: acceptedTarget.target,
        previewTarget: acceptedTarget,
      });
    }
    finish();
  };

  const handleDragCancel = (): void => finish();

  useEffect(() => {
    if (!sources) return;
    const updateModifier = (event: KeyboardEvent): void => {
      if (event.key !== "Alt") return;
      altKeyRef.current = event.type === "keydown";
      resolveTarget();
    };
    // dnd-kit pointer sensors cancel on Escape, pointer cancellation, resize,
    // and visibility changes, but Electron can blur a still-visible window.
    // Route that boundary through the same sensor cancellation path so the
    // internal drag state and this controller always settle together.
    const cancelForWindowBlur = (): void => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          code: "Escape",
          key: "Escape",
        }),
      );
    };
    window.addEventListener("keydown", updateModifier, true);
    window.addEventListener("keyup", updateModifier, true);
    window.addEventListener("blur", cancelForWindowBlur);
    return () => {
      window.removeEventListener("keydown", updateModifier, true);
      window.removeEventListener("keyup", updateModifier, true);
      window.removeEventListener("blur", cancelForWindowBlur);
    };
  });

  useEffect(
    () => () => {
      stopAutoScroll();
      if (releaseClickTimerRef.current !== null) {
        window.clearTimeout(releaseClickTimerRef.current);
      }
    },
    [],
  );

  const context = useMemo<DatabaseListDndContextValue>(
    () => ({
      disabled,
      activeOccurrenceKey: sources?.initiator.key ?? null,
      target,
      suppressesNextClick: () => suppressClickRef.current,
    }),
    [disabled, sources?.initiator.key, target],
  );
  const overlayRow = sources
    ? (rows.find(
        (row): row is DatabaseListPageRow =>
          row.kind === "page" && row.key === sources.initiator.key,
      ) ?? sources.initiator)
    : null;

  return (
    <DatabaseListDndContext.Provider value={context}>
      <DndContext
        accessibility={{
          announcements,
          restoreFocus: true,
          screenReaderInstructions: {
            draggable:
              "Press Space to pick up a Page. Use arrow keys to choose a destination, Space to move it, or Escape to cancel.",
          },
        }}
        sensors={sensors}
        collisionDetection={databaseListCollisionDetection}
        autoScroll={false}
        measuring={{ droppable: { strategy: MeasuringStrategy.WhileDragging } }}
        onDragStart={handleDragStart}
        onDragMove={handleDragMove}
        onDragOver={updateOver}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        {children}
        {typeof document !== "undefined"
          ? createPortal(
              <DragOverlay adjustScale={false} dropAnimation={null} zIndex={1000}>
                {sources && overlayRow ? (
                  <DatabaseListDragOverlay
                    sources={sources}
                    row={overlayRow}
                    columns={overlayColumns}
                    width={overlayWidth}
                    scrollerRef={scrollerRef}
                  />
                ) : null}
              </DragOverlay>,
              document.body,
            )
          : null}
      </DndContext>
    </DatabaseListDndContext.Provider>
  );
}

export const useDatabaseListPageDnd = (item: DatabaseListPageRow) => {
  const context = useContext(DatabaseListDndContext);
  const disabled = context?.disabled === true || item.transientKind !== "none";
  const draggable = useDraggable({
    id: item.key,
    disabled,
    data: { kind: "page", occurrenceKey: item.key },
    attributes: { role: "row", roleDescription: "sortable Page" },
  });
  const droppable = useDroppable({
    id: item.key,
    disabled: context === null,
    data: { kind: "page", occurrenceKey: item.key },
  });
  const setDraggableNodeRef = draggable.setNodeRef;
  const setDroppableNodeRef = droppable.setNodeRef;
  const setNodeRef = useCallback(
    (node: HTMLElement | null): void => {
      setDraggableNodeRef(node);
      setDroppableNodeRef(node);
    },
    [setDraggableNodeRef, setDroppableNodeRef],
  );
  return {
    setNodeRef,
    listeners: draggable.listeners,
    attributes: draggable.attributes,
    active: context?.activeOccurrenceKey === item.key,
    target: context?.target?.occurrenceKey === item.key ? context.target : null,
    suppressesNextClick: context?.suppressesNextClick ?? (() => false),
  };
};

export const useDatabaseListGroupDnd = (item: DatabaseListProjectionRow) => {
  const context = useContext(DatabaseListDndContext);
  const droppable = useDroppable({
    id: item.key,
    disabled: context === null || (item.kind !== "group" && item.kind !== "subgroup"),
    data: { kind: "group", occurrenceKey: item.key },
  });
  return {
    setNodeRef: droppable.setNodeRef,
    active: context?.target?.occurrenceKey === item.key,
  };
};

export const DatabaseListGroupDropTarget = ({
  item,
  className,
  children,
  ...props
}: {
  readonly item: DatabaseListProjectionRow;
  readonly className?: string;
  readonly children: ReactNode;
} & Omit<React.HTMLAttributes<HTMLDivElement>, "children">) => {
  const dnd = useDatabaseListGroupDnd(item);
  return (
    <div
      {...props}
      ref={dnd.setNodeRef}
      data-database-list-drop-inside={dnd.active || undefined}
      className={cn(
        className,
        dnd.active && "ring-1 ring-inset ring-[var(--database-list-drop-indicator)]",
      )}
    >
      {children}
    </div>
  );
};
